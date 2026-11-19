//! Agent chat sessions: an agent run as a JSON STREAM instead of a terminal.
//!
//! The rest of this app drives agents through a PTY, which is what makes their
//! real TUI work. A TUI is the wrong source for a chat UI, though: what crosses
//! the wire is cursor moves and repaints, so there is no message to render — you
//! would be scraping pixels back into text.
//!
//! The providers offer structured streams a chat UI can consume. Claude uses
//! its stream-json protocol, Codex uses app-server JSON-RPC, and Pi emits one
//! JSON stream per command-line turn. For example, Claude starts as:
//!
//! ```text
//! claude -p --output-format stream-json --input-format stream-json \
//!        --include-partial-messages --verbose
//! ```
//!
//! stdout is one JSON object per line. Persistent providers also take
//! structured user turns and control requests on stdin, so one process can
//! serve a whole conversation.
//!
//! This module owns those processes: spawn one per chat, read stdout line by
//! line, and emit `chat-event`s. Provider adapters extract lifecycle metadata;
//! the Codex adapter also normalizes app-server items to the stable transcript
//! vocabulary understood by existing chats and the web reducer.
//!
//! No PTY: this is a plain piped child. It is launched through a LOGIN SHELL
//! all the same, for the reason pty.rs does it — a GUI app does not inherit the
//! interactive shell's PATH, so `claude` would simply not be found.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::agent_provider::{
    ask_mcp_config, provider_for, AgentCommand, OutputDisposition, OutputState,
};
pub(crate) use crate::agent_provider::{safe_model, safe_session_id};
pub use crate::agent_provider::{Access, AgentKind as ChatAgent};

/// Turn the terse hand-off people naturally type into an unambiguous tool
/// route for providers that have OctiqFlow's MCP. The original text is still
/// what the transcript records; this private instruction exists only in the
/// prompt handed to the agent.
///
/// A bare URL is deliberately not enough. Links appear in ordinary questions
/// all the time, while `continue <conversation-url>` is an explicit request to
/// inherit that conversation before doing anything else.
fn routed_prompt(agent: ChatAgent, prompt: &str) -> Cow<'_, str> {
    // Claude receives the same rule as a system prompt at process start. Do
    // not alter its user payload: `--replay-user-messages` would echo these
    // private routing words into the visible transcript. Codex does not echo
    // its app-server or command-line prompt, so its canonical transcript entry
    // stays exact.
    if agent != ChatAgent::Codex {
        return Cow::Borrowed(prompt);
    }
    let Some(url) = continuation_url(prompt) else {
        return Cow::Borrowed(prompt);
    };

    Cow::Owned(format!(
        "{prompt}\n\n[OctiqFlow continuation protocol]\n\
         This is a cross-chat continuation request. Before any other action, you MUST call \
         `mcp__octiq__read_conversation` with {{\"url\":\"{url}\"}}. Do not open this URL \
         in Browser and do not infer the prior conversation from workspace files. Read the \
         latest page first, follow the returned `before` cursor when older context is needed, \
         then continue from the latest actionable next step."
    ))
}

fn continuation_url(prompt: &str) -> Option<&str> {
    let prompt = prompt.trim();
    let word_end = prompt.find(char::is_whitespace)?;
    if !prompt[..word_end].eq_ignore_ascii_case("continue") {
        return None;
    }

    let url = prompt[word_end..].trim();
    if url.is_empty()
        || url.chars().any(char::is_whitespace)
        || !(url.starts_with("https://") || url.starts_with("http://"))
    {
        return None;
    }
    let route = url.split_once('#')?.1.split('?').next()?;
    let route = route.strip_suffix('/').unwrap_or(route);
    let rest = route.strip_prefix("/p/")?;
    let (project, conversation) = rest.split_once("/c/")?;
    if project.is_empty()
        || conversation.is_empty()
        || project.contains('/')
        || conversation.contains('/')
        || !project.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
        || conversation.len() > 128
        || !conversation
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(url)
}

/// One line of an agent's stdout, on its way to the UI.
#[derive(Clone, Serialize)]
struct ChatEvent {
    /// The chat this came from (the frontend picks the key at start time, the
    /// same way it picks PTY ids).
    key: String,
    /// Where this sits in the chat's record. A client remembers the highest it
    /// has seen and asks for everything after it when it reconnects, which is
    /// what stops a closed laptop losing the rest of an answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    seq: Option<u64>,
    /// The agent's own JSON object, passed through untouched.
    event: Value,
}

/// One typed turn that a provider does not echo back in the transcript shape.
///
/// Claude's stream already contains a `user` event for each accepted prompt.
/// Codex's app-server and command-line protocols do not, so the transcript
/// needs this small canonical envelope to rebuild the conversation after a
/// refresh.
fn durable_user_event(turn_id: &str, text: &str, images: &[String]) -> Value {
    let mut event = json!({
        "type": "user",
        "uuid": turn_id,
        "octiq_user_turn": true,
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": text }],
        },
    });

    let attachments: Vec<Value> = images
        .iter()
        .map(|path| {
            let name = std::path::Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(path);
            json!({ "path": path, "name": name, "isImage": true })
        })
        .collect();
    if !attachments.is_empty() {
        event["octiq_attachments"] = Value::Array(attachments);
    }
    event
}

/// Persist and fan out one prompt accepted by OctiqFlow.
///
/// This uses the same transcript-before-bus ordering as agent stdout. A page
/// that reconnects therefore sees the prompt before the Codex events it caused,
/// while the current page reconciles it with its optimistic bubble by `uuid`.
fn record_durable_user_turn(key: &str, turn_id: &str, text: &str, images: &[String]) {
    record_durable_user_turn_with_append(key, turn_id, text, images, None);
}

fn record_durable_user_turn_with_append(
    key: &str,
    turn_id: &str,
    text: &str,
    images: &[String],
    append_to: Option<&str>,
) {
    let mut event = durable_user_event(turn_id, text, images);
    if let Some(target) = append_to {
        event["octiq_append_to"] = Value::String(target.to_string());
    }
    // The time the person sent it (a queued turn is recorded when it is
    // queued), on the line and on the live event alike.
    crate::transcript::stamp(&mut event);
    let seq = crate::transcript::append(key, &event);
    crate::bus::emit(
        "chat-event",
        ChatEvent {
            key: key.to_string(),
            seq,
            event,
        },
    );
}

/// Persist and fan out an OctiqFlow-owned lifecycle event. Auto-resume uses
/// the same transcript-before-bus ordering as provider output, so a reconnect
/// cannot miss a schedule, cancellation, or dispatch result. Returns where the
/// event sits in the transcript; `None` when it reached only the live stream.
pub(crate) fn record_chat_event(key: &str, mut event: Value) -> Option<u64> {
    crate::transcript::stamp(&mut event);
    fan_out(key, crate::transcript::append(key, &event), event)
}

/// `record_chat_event` for a line a ledger will call delivered: `Some` only
/// once it is synced to the transcript on disk.
/// Say in a chat that it could not be started, where its first message
/// would have been. The page shows it as the chat's failure.
pub(crate) fn record_start_failure(key: &str, message: &str) {
    record_chat_event_synced(
        key,
        serde_json::json!({ "type": "octiq_start_failed", "message": message }),
    );
}

pub(crate) fn record_chat_event_synced(key: &str, mut event: Value) -> Option<u64> {
    crate::transcript::stamp(&mut event);
    fan_out(key, crate::transcript::append_synced(key, &event), event)
}

/// `record_chat_event` for a line that belongs to one history of the chat:
/// it goes into the record `seen` and no other, and what comes back says
/// whether that record now holds it for good (`transcript::append_in`).
/// `seen` is `None` when the chat's record could not be asked which it is
/// (the profile folder is away): the line reaches the open pages only.
///
/// A record that is gone gets nothing and its pages hear nothing: the line
/// is of a history the person removed.
pub(crate) fn record_chat_event_in(
    key: &str,
    seen: Option<&crate::transcript::Generation>,
    mut event: Value,
) -> crate::transcript::Held {
    use crate::transcript::Held;
    crate::transcript::stamp(&mut event);
    let (held, seq) = match seen {
        Some(seen) => crate::transcript::append_in(key, seen, &event),
        None => (Held::Unconfirmed, None),
    };
    if held != Held::Moved {
        fan_out(key, seq, event);
    }
    held
}

fn fan_out(key: &str, seq: Option<u64>, event: Value) -> Option<u64> {
    crate::bus::emit(
        "chat-event",
        ChatEvent {
            key: key.to_string(),
            seq,
            event,
        },
    );
    seq
}

pub(crate) fn fresh_turn_id(turn_id: Option<String>) -> String {
    turn_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| format!("octiq-user-{}", uuid::Uuid::new_v4()))
}

/// Delivery is owned by the backend, independently of provider acknowledgement.
/// In particular, a process connecting to its API already owns its prompt; that
/// prompt cannot still be offered as an editable queue entry.
///
/// Answers where the line sits in the transcript: `None` for a turn that
/// has no line (no id, or a host receipt) and for a line that could not be
/// written, which every open page still heard.
fn record_delivery(key: &str, turn_id: Option<&str>, state: &str) -> Option<u64> {
    let turn_id = turn_id?;
    if turn_id.starts_with(crate::orchestration::inbox::RECEIPT_PREFIX) {
        return None;
    }
    let mut event = json!({ "type": "octiq_user_turn_delivery", "uuid": turn_id, "state": state });
    crate::transcript::stamp(&mut event);
    let seq = crate::transcript::append(key, &event);
    crate::bus::emit(
        "chat-event",
        ChatEvent {
            key: key.to_string(),
            seq,
            event,
        },
    );
    seq
}

/// What the messages a deliberate ending dropped are called when their
/// "not sent" lines could not be written (`unsaved::say`).
const UNSENT: &str = "the messages that were not sent";

/// Those lines, in the list of what still owes a save (`profile_status`).
pub(crate) const UNSENT_OWED: &str = "unsent messages";
/// Chat previews a failed index write kept in memory (`PreviewBatch`).
pub(crate) const PREVIEWS_OWED: &str = "chat previews";

/// Tell every reader that two durable person turns now form one pending unit.
/// The individual envelopes are kept so append-only replay and idempotency
/// retain every source id; this event only supplies their grouping.
fn record_appended_turn(key: &str, target: &str, source: &str) {
    record_chat_event(
        key,
        json!({
            "type": "octiq_user_turn_appended",
            "uuid": target,
            "appended_uuid": source,
        }),
    );
}

/// Whether the turn's own envelope is in the record. A record that cannot
/// be read answers an error, never "not there": the send that asks would
/// otherwise hand the same words over a second time.
fn durable_user_turn_exists(key: &str, turn_id: &str) -> Result<bool, String> {
    Ok(crate::transcript::every_line(key)?.iter().any(|entry| {
        entry.event["type"] == "user"
            && entry.event["octiq_user_turn"] == true
            && entry.event["uuid"].as_str() == Some(turn_id)
    }))
}

/// Tie each provider acknowledgement to its exact dispatched prompt. Text is
/// not an identity: identical follow-ups can be waiting at the same time.
fn stamp_user_turn_id(event: &mut Value, agent: ChatAgent, turn_id: Option<&str>) {
    if !provider_for(agent).acknowledges_user_turn(event) {
        return;
    }
    let Some(turn_id) = turn_id.filter(|id| !id.trim().is_empty()) else {
        return;
    };
    event["octiq_user_turn_id"] = Value::String(turn_id.to_string());
}

/// Consume only a matching provider receipt; process startup is not receipt.
fn acknowledge_user_turn(event: &mut Value, agent: ChatAgent, pending: &mut Option<String>) {
    stamp_user_turn_id(event, agent, pending.as_deref());
    if pending
        .as_deref()
        .is_some_and(|id| event["octiq_user_turn_id"].as_str() == Some(id))
    {
        *pending = None;
        if let Some(id) = event["octiq_user_turn_id"]
            .as_str()
            .filter(|id| id.starts_with(crate::orchestration::inbox::RECEIPT_PREFIX))
            .map(str::to_string)
        {
            event.as_object_mut().unwrap().remove("octiq_user_turn_id");
            let ids: Vec<_> = id.split('|').collect();
            event["octiq_orchestration_notification_id"] = json!(ids[0]);
            if ids.len() > 1 {
                event["octiq_orchestration_notification_ids"] = json!(ids);
            }
        }
    }
}

/// The agent said something on stderr, or the process ended.
#[derive(Clone, Serialize)]
struct ChatStatus {
    key: String,
    /// "exit" | "stderr" | "error"
    kind: String,
    text: String,
    code: Option<i32>,
}

/// Emit a visible agent status and preserve unexpected diagnostics outside the
/// transcript. The journal is intentionally limited to failure-like statuses:
/// normal exits are state changes, not warnings future diagnosis needs.
fn emit_status(agent: ChatAgent, status: ChatStatus) {
    if matches!(status.kind.as_str(), "stderr" | "error" | "access-refused") {
        crate::diagnostics::record(agent, &status.key, &status.kind, &status.text);
    }
    crate::bus::emit("chat-status", status);
}

/// Route one unstructured line without losing an internal diagnostic to a
/// distracting transcript card. Providers classify their own known chatter;
/// the common path deliberately stays visible.
fn emit_unstructured_output(
    agent: ChatAgent,
    key: &str,
    text: String,
    disposition: OutputDisposition,
) -> bool {
    match disposition {
        OutputDisposition::Ignore => false,
        OutputDisposition::DiagnosticsOnly => {
            crate::diagnostics::record(agent, key, "stderr", &text);
            crate::safety_block::observe(agent, key, &text)
        }
        OutputDisposition::Visible => {
            emit_status(
                agent,
                ChatStatus {
                    key: key.to_string(),
                    kind: "stderr".into(),
                    text,
                    code: None,
                },
            );
            false
        }
    }
}

/// What a process left behind as it ended: its exit code and the last line it
/// wrote to stderr. `None` for a clean, silent exit, which explains nothing.
///
/// A worker that dies this way is otherwise reported as a bare disconnect, and
/// a launch the shell refuses looks exactly like a dropped connection.
fn last_words(code: Option<i32>, stderr: &str) -> Option<String> {
    // It goes into the coordinator's inbox; one line of evidence is enough.
    const KEPT: usize = 300;
    let stderr = stderr.trim();
    if code == Some(0) && stderr.is_empty() {
        return None;
    }
    let mut words = match code {
        Some(code) => format!("The process exited with code {code}."),
        None => "The process ended without an exit code.".to_string(),
    };
    if !stderr.is_empty() {
        words.push_str(" Its last error output: ");
        words.extend(stderr.chars().take(KEPT));
        if stderr.chars().count() > KEPT {
            words.push('…');
        }
    }
    Some(words)
}

struct ChatSession {
    launch_id: String,
    /// A dispatched prompt still awaiting its provider acknowledgement.
    user_turn_id: Option<String>,
    /// The id of the message the turn in flight is answering — set by every
    /// write to the agent and by every launch with a prompt, including host
    /// notifications, and never cleared by an acknowledgement. What
    /// `ChatManager::person_turn` reads to know WHOSE words the agent is
    /// acting on.
    answering: Option<String>,
    child: Child,
    stdin: Option<ChildStdin>,
    /// Native Codex state. Present only when this process is `codex
    /// app-server`; Claude owns its own stream framing and the exec fallback is
    /// one-shot.
    codex: Option<CodexAppSession>,
    /// Which program this is. Persistent providers have different control
    /// protocols, so a setting changed part-way through a chat has to know
    /// which one it is writing.
    agent: ChatAgent,
    /// A turn is in flight: this process was given something and has not
    /// reached its own full stop yet.
    ///
    /// The idle sweeper is built on this rather than on "no output lately",
    /// and the difference is the whole reason the flag exists. An agent
    /// running a twenty-minute build says NOTHING while it waits — no partial
    /// message, no tool event, nothing — so a sweeper reading silence would
    /// kill the one turn nobody could afford to lose. A turn is also still in
    /// flight while a permission card or a native/MCP question sits on screen,
    /// and both of those are minutes of quiet by design.
    busy: bool,
    /// When this last started or finished a turn. Only read while `busy` is
    /// false, so it means "still since".
    last_active: Instant,
    /// Whether a Stop cut a turn of this process short and that turn's own
    /// full stop has not been read yet. Set and cleared under this session's
    /// lock, and gone with the process: nothing else records an unwind.
    cut_off: CutOff,
    auto_plan_refused: bool,
    auto_plan_turn: AutoPlanTurn,
    auto_plan_attribution: AutoPlanAttribution,
    /// The removal of the registered agent whose conversation this is, once
    /// one has looked at this process (`LeavingMark::working`). Set under
    /// this session's lock, which every prompt is written under.
    leaving: Option<Arc<Leaving>>,
    /// The first prompt of this process is waiting for the worker's browser
    /// server (`hand_over_first_turn`). The session reads `busy` (so a message
    /// queues and the sweeper leaves it alone), but NO turn is in flight: an
    /// interrupt has nothing to cut short, so it sets no `CutOff` and fails
    /// nothing. Cleared under this lock by the write, or by an ended session.
    first_turn_held: bool,
}

/// The removal of a registered agent, as its own conversations see it.
///
/// **A prompt and a removal never both go through** (review of 931b5f0,
/// H4). The removal marks first and looks second: it puts this on every
/// conversation the agent speaks in as itself (`ChatManager::mark_leaving`),
/// and only then reads whether one of them is working
/// (`LeavingMark::working`), under that session's own lock, where it also
/// leaves the mark. Every prompt is written under the same lock by
/// `write_user_message_locked`, which refuses a session that carries the
/// mark, and a process is put in the session table by `start_session`, which
/// refuses a chat the manager holds a mark for. So a write that came first
/// had the lock first and the removal saw its turn; a write that came second
/// saw the mark.
///
/// A removal that is refused or fails calls the mark off, and the
/// conversation carries on. One that is made leaves it for good: the agent
/// is gone, and nothing more is asked of it in its name. It is kept in
/// memory only, so a restart forgets it.
#[derive(Debug)]
struct Leaving {
    name: String,
    state: std::sync::atomic::AtomicU8,
}

impl Leaving {
    const UNDER_WAY: u8 = 0;
    const GONE: u8 = 1;
    const CALLED_OFF: u8 = 2;

    fn state(&self) -> u8 {
        self.state.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Why nothing is written or started, or `None` once it was called off.
    fn refusal(&self) -> Option<String> {
        let name = &self.name;
        match self.state() {
            Self::UNDER_WAY => Some(format!(
                "{name} is being removed, so this conversation takes no message right now. Nothing was sent. Send it again in a moment: if the removal is refused, the conversation carries on."
            )),
            Self::GONE => Some(format!(
                "{name} was removed, and this was {name}'s conversation: it takes no more messages. Nothing was sent. Start a new conversation with another agent."
            )),
            _ => None,
        }
    }
}

/// What a removal sees of a conversation it asks about without waiting for
/// any lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Turn {
    /// Nothing is being answered, nothing is queued, no full stop is owed.
    Idle,
    /// One of those is.
    InFlight,
    /// A lock on the way was held by something else, so it is not known:
    /// in doubt the agent stays, and the refusal says it is a doubt.
    Unconfirmed,
}

/// A removal's hold on the agent's own conversations
/// (`ChatManager::mark_leaving`). Dropped without `gone`, it calls the mark
/// off: whatever stopped the removal, its chats take messages again.
pub(crate) struct LeavingMark<'a> {
    manager: &'a ChatManager,
    keys: Vec<String>,
    mark: Arc<Leaving>,
}

impl LeavingMark<'_> {
    /// Whether the conversation `key` may be working, asked AFTER the mark
    /// was set. A process that is idle is marked right here, under its own
    /// lock, so the answer cannot go stale: nothing is written to it after
    /// this said it was idle.
    ///
    /// Nothing is waited for. The caller holds the roster's lock and the
    /// ledger's, so the session table, the queue and the session are tried;
    /// one that is busy answers `true`, as does a turn in flight, a stopped
    /// turn whose full stop is still owed, anything queued, and a one-shot
    /// process being replaced. In doubt the agent is working, and the
    /// removal is refused and asked again.
    pub(crate) fn working(&self, key: &str) -> bool {
        self.look(key) != Turn::Idle
    }

    /// `working`, saying which it was: a turn seen in flight, or a lock
    /// that was taken so that nothing could be seen. Both stop the
    /// removal; only the first is a fact about the agent, and the refusal
    /// says which (`agent_work::mid_turn`).
    pub(crate) fn look(&self, key: &str) -> Turn {
        let Ok(sessions) = self.manager.sessions.try_lock() else {
            return Turn::Unconfirmed;
        };
        let Ok(handoffs) = self.manager.handoffs.try_lock() else {
            return Turn::Unconfirmed;
        };
        let Ok(queued) = self.manager.queued_turns.try_lock() else {
            return Turn::Unconfirmed;
        };
        if handoffs.contains(key) || queued.get(key).is_some_and(|q| !q.is_empty()) {
            return Turn::InFlight;
        }
        drop((handoffs, queued));
        let Some(session) = sessions.get(key) else {
            return Turn::Idle;
        };
        let Ok(mut session) = session.try_lock() else {
            return Turn::Unconfirmed;
        };
        if session.busy || session.cut_off != CutOff::No {
            return Turn::InFlight;
        }
        session.leaving = Some(self.mark.clone());
        Turn::Idle
    }

    /// The removal was made. The mark stays, and says so.
    pub(crate) fn gone(self) {
        self.mark
            .state
            .store(Leaving::GONE, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Drop for LeavingMark<'_> {
    fn drop(&mut self) {
        if self.mark.state() != Leaving::UNDER_WAY {
            return;
        }
        self.mark
            .state
            .store(Leaving::CALLED_OFF, std::sync::atomic::Ordering::SeqCst);
        let mut marks = self
            .manager
            .leaving
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for key in &self.keys {
            if marks
                .get(key)
                .is_some_and(|mark| Arc::ptr_eq(mark, &self.mark))
            {
                marks.remove(key);
            }
        }
    }
}

/// A turn that was cut short still sends a full stop of its own, and the
/// stream does not say which turn a full stop ends. This is how the reader
/// knows (`end_turn_locked`): after a Stop the next full stop read is the
/// cut-off turn's, because nothing else has been written in between.
///
/// **The invariant: no prompt is ever written to a process that still owes
/// the full stop of a turn that was cut short.** A Stop marks the session
/// idle at once, so until that full stop has been read a message, a
/// completion's wrap-up and a host notification all wait
/// (`chat_send_with_user_turn`, `chat_complete_impl`,
/// `deliver_orchestration_notification`), and are handed over on it. Every
/// prompt goes through `write_user_message_locked`, which refuses while this
/// is anything but `No`, whoever asks.
///
/// A full stop that never comes is not waited for longer than the grace and
/// is not guessed at either: the process is ended (`grace_ran_out`), and the
/// conversation goes on in the next one, which resumes it by id. Written to
/// instead, an agent that had not stopped answered a second `turn/start`
/// with the turn it was already in, and the one full stop that followed
/// could not be told from the cut-off turn's (review of 8cbcd0b, H2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum CutOff {
    #[default]
    No,
    /// The next full stop read is the cut-off turn's. The number names this
    /// unwind (`ChatManager::next_unwind`): the thread waiting out its grace
    /// acts for this one and for no later Stop of the same chat.
    Owed(u64),
    /// The Stop was not honoured within the grace and the process has been
    /// ended. Whatever its reader still reads ends no turn, decides no
    /// completion and moves no queue: all three belong to the chat's next
    /// process.
    Ended,
}

/// Stop makes an untagged full stop unattributable, even when the host read
/// idle: any number of autonomous init/result pairs may already be in stdout.
/// No discard count or observed init can prove that this backlog is drained.
///
/// This latch lives under the session's writer lock. A post-Stop Claude write
/// gets a fresh native UUID; only its isReplay echo with the exact payload can
/// open the barrier. Claude replays a prompt after its init and all previous
/// turns' results (claude-replay-uuid.jsonl:7,16,19,21,29; the second
/// identical prompt was written before the first result). Thus no earlier A, A',
/// or duplicate-content prompt can unlock it. The following clean full stop
/// belongs to that prompt. A missing/rewritten UUID fails closed. Codex uses
/// the matching turn/start request's response and that native turn's completion
/// instead. Observe these before normalization, without changing event shapes.
///
/// Every further host write replaces the target until an attributable clean
/// end clears the latch; every Stop resets it. CutOff::Owed still discards its
/// one cut-off result and moves the queue exactly as before: this latch never
/// counts results or changes send/start/queue/Stop behavior. Recovery in the
/// same PID waits for a clean end behind the provider barrier, which need not
/// be the first real turn's end. Providers without a barrier stay latched until
/// a new process. Approval never reads session state under the ledger.
#[derive(Debug, Default)]
enum AutoPlanAttribution {
    #[default]
    Ready,
    Unattributed,
    Claude {
        uuid: String,
        content: Value,
        echoed: bool,
    },
    Codex {
        request_id: Value,
        turn_id: Option<String>,
        completed: bool,
    },
}

impl AutoPlanAttribution {
    fn prompt(&mut self, agent: ChatAgent, native_codex: bool, payload: &mut Value) {
        if matches!(self, Self::Ready) {
            return;
        }
        *self = if native_codex {
            Self::Codex {
                request_id: payload["id"].clone(),
                turn_id: None,
                completed: false,
            }
        } else if agent == ChatAgent::Claude {
            let uuid = uuid::Uuid::new_v4().to_string();
            payload["uuid"] = json!(uuid);
            Self::Claude {
                uuid,
                content: replay_content(&payload["message"]["content"]),
                echoed: false,
            }
        } else {
            Self::Unattributed
        };
    }

    fn observe(&mut self, event: &Value) {
        match self {
            Self::Claude {
                uuid,
                content,
                echoed,
            } => {
                if event["type"] == "user"
                    && event["isReplay"] == true
                    && event["isSynthetic"] != true
                    && event.get("parent_tool_use_id").is_none_or(Value::is_null)
                    && event["uuid"].as_str() == Some(uuid.as_str())
                    && replay_content(&event["message"]["content"]) == *content
                {
                    *echoed = true;
                }
            }
            Self::Codex {
                request_id,
                turn_id,
                completed,
            } => {
                if event.get("id") == Some(request_id) {
                    if let Some(id) = crate::codex_app_server::turn_id_from_response(event) {
                        *turn_id = Some(id.to_string());
                    }
                }
                if event["method"] == "turn/completed" {
                    *completed = turn_id.as_deref().is_some_and(|id| {
                        event.pointer("/params/turn/id").and_then(Value::as_str) == Some(id)
                    });
                }
            }
            _ => (),
        }
    }

    fn attributable(&self) -> bool {
        matches!(
            self,
            Self::Ready
                | Self::Claude { echoed: true, .. }
                | Self::Codex {
                    completed: true,
                    ..
                }
        )
    }
}

/// Refusals belong to a written prompt/native turn, never the host's idle
/// clock. A buffered older full stop may change that clock while this target
/// is still running. Keep native declines until the matching start response
/// binds its id; declines for other ids cannot veto this target's clean end.
#[derive(Debug)]
struct AutoPlanTurn {
    write_id: uuid::Uuid,
    request_id: Option<Value>,
    native_id: Option<String>,
    declined: HashSet<String>,
    /// Pi tool calls of this turn parked on the person's card. The turn
    /// cannot end cleanly with one of them unanswered.
    open_asks: usize,
}

impl Default for AutoPlanTurn {
    fn default() -> Self {
        Self {
            write_id: uuid::Uuid::new_v4(),
            request_id: None,
            native_id: None,
            declined: HashSet::new(),
            open_asks: 0,
        }
    }
}

/// Where one Pi tool call stood when it reached the gate: the launch, the
/// prompt write and the turn sequence it belongs to. Its answer counts for
/// plan auto-approval only while all three are still the session's, so a late
/// answer from an older turn neither latches nor clears the current one.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PiCallTurn {
    launch_id: String,
    write_id: uuid::Uuid,
    sequence: u64,
    asked: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct CodexRefusalTarget {
    write_id: uuid::Uuid,
    native_id: Option<String>,
}

impl AutoPlanTurn {
    fn prompt(&mut self, native_codex: bool, payload: &Value) {
        *self = Self {
            request_id: native_codex.then(|| payload["id"].clone()),
            ..Self::default()
        };
    }

    fn observe_codex(&mut self, event: &Value) {
        if self
            .request_id
            .as_ref()
            .is_some_and(|id| event.get("id") == Some(id))
        {
            if let Some(id) = crate::codex_app_server::turn_id_from_response(event) {
                self.native_id = Some(id.to_owned());
            }
        }
    }

    fn refused(&self) -> bool {
        self.native_id.as_ref().map_or_else(
            // Until the matching start response arrives we cannot rule out
            // this native refusal. Missing/out-of-order correlation is closed.
            || !self.declined.is_empty(),
            |id| self.declined.contains(id),
        )
    }
}

impl ChatSession {
    fn codex_refusal_target(&self, params: &Value) -> CodexRefusalTarget {
        let child_thread = params["threadId"].as_str().is_some_and(|id| {
            self.codex
                .as_ref()
                .is_none_or(|codex| id != codex.thread_id)
        });
        CodexRefusalTarget {
            write_id: self.auto_plan_turn.write_id,
            // Child turn ids cannot identify the parent's turn. Conservatively
            // bind its work to this parent write, even before correlation. A
            // missing id uses the same written target, never active_turn_id
            // that an old buffered event can overwrite/clear.
            native_id: if child_thread {
                self.auto_plan_turn.native_id.clone()
            } else {
                params["turnId"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| self.auto_plan_turn.native_id.clone())
            },
        }
    }

    fn codex_target_is_current(&self, target: &CodexRefusalTarget) -> bool {
        self.auto_plan_turn.write_id == target.write_id
            && !target
                .native_id
                .as_ref()
                .zip(self.auto_plan_turn.native_id.as_ref())
                .is_some_and(|(target, current)| target != current)
    }

    fn latch_codex_refusal(&mut self, target: &CodexRefusalTarget) {
        if self.auto_plan_turn.write_id != target.write_id {
            return;
        }
        if let Some(id) = &target.native_id {
            self.auto_plan_turn.declined.insert(id.clone());
        } else {
            self.auto_plan_refused = true;
        }
    }
}

/// Claude replays a single text block as a string; images/multiple blocks
/// retain their array representation. Compare the actual provider payload.
fn replay_content(content: &Value) -> Value {
    if let Some(blocks) = content.as_array() {
        if blocks.len() == 1 && blocks[0]["type"] == "text" {
            return blocks[0]["text"].clone();
        }
    }
    content.clone()
}

#[derive(Debug)]
struct CodexAppSession {
    thread_id: String,
    active_turn_id: Option<String>,
    interrupt_when_started: bool,
    next_request: u64,
    /// Pending MCP confirmations, cancelled with this process/turn.
    elicitations: HashMap<String, codex_elicitation::Pending>,
    // Native MCP items correlate Codex 0.163 approvals, which omit tool_name.
    mcp_calls: HashMap<String, Value>,
    mcp_refusals: HashMap<String, String>,
    model: Option<String>,
    effort: Option<String>,
    access: Option<Access>,
    cwd: String,
    workspace_roots: Vec<String>,
    has_octiq_mcp: bool,
}

impl CodexAppSession {
    fn request_id(&mut self, purpose: &str) -> String {
        self.next_request += 1;
        format!("octiq-{purpose}-{}", self.next_request)
    }
}

impl ChatSession {
    /// Something was sent to the agent: it is working from here until it says
    /// otherwise.
    fn turn_started(&mut self) {
        self.auto_plan_refused = false;
        self.busy = true;
        self.last_active = Instant::now();
    }

    /// The agent reached its own full stop. The clock starts now.
    fn turn_ended(&mut self) {
        // Clearing an unanswered current confirmation is a refusal too. An
        // older buffered end can cancel its card while a newer target runs.
        let cancelled: Vec<_> = self
            .codex
            .as_ref()
            .into_iter()
            .flat_map(|codex| codex.elicitations.values().map(|p| p.target.clone()))
            .collect();
        for target in cancelled {
            self.latch_codex_refusal(&target);
        }
        if let Some(codex) = self.codex.as_mut() {
            codex.elicitations.clear();
            codex.mcp_calls.clear();
            codex.mcp_refusals.clear();
        }
        self.busy = false;
        self.last_active = Instant::now();
    }

    /// How long this has been sitting still, or `None` while it is working.
    fn still_for(&self) -> Option<Duration> {
        (!self.busy).then(|| self.last_active.elapsed())
    }

    /// Refuse while the agent whose conversation this is is being removed,
    /// or was (`Leaving`). A mark whose removal was called off is let go.
    fn not_leaving(&mut self) -> Result<(), String> {
        match self.leaving.as_ref().map(|mark| mark.refusal()) {
            Some(Some(refusal)) => Err(refusal),
            Some(None) => {
                self.leaving = None;
                Ok(())
            }
            None => Ok(()),
        }
    }
}

/// How an agent process was last started, so it can be resumed after exit.
///
/// Every one of these fields belongs to the client: the model came from the
/// picker, the folders from the project, the level from the access control. The
/// backend has never needed them, because the client has always been the thing
/// that starts a chat.
///
/// Ordinary chats keep this in memory. Orchestrated chats persist a copy without
/// project environment variables so pending notifications can resume after restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StartContext {
    /// The original selection, retained across automatic runtime switches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    defaults: Option<crate::provider_failover::Settings>,
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    extra_dirs: Option<Vec<String>>,
    /// The project's environment, kept across command-line turns.
    env: Option<std::collections::BTreeMap<String, String>>,
    effort: Option<String>,
    lite: Option<bool>,
    /// The agent's own id for this conversation, learned from its opening
    /// event. Restarting without it would hand the agent an empty memory.
    session_id: Option<String>,
}

/// The execution choices a queued prompt will inherit when it is dispatched.
/// Provider session ids are deliberately absent: learning the id after startup
/// does not change how a person's already queued follow-up will execute.
#[derive(Debug, Clone, PartialEq, Eq)]
struct QueueContext {
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    extra_dirs: Option<Vec<String>>,
    env: Option<std::collections::BTreeMap<String, String>>,
    effort: Option<String>,
    lite: Option<bool>,
}

impl From<StartContext> for QueueContext {
    fn from(start: StartContext) -> Self {
        Self {
            cwd: start.cwd,
            agent: start.agent,
            model: start.model,
            access: start.access,
            extra_dirs: start.extra_dirs,
            env: start.env,
            effort: start.effort,
            lite: start.lite,
        }
    }
}

impl StartContext {
    pub(crate) fn forget_session(&mut self) {
        self.session_id = None;
    }

    pub(crate) fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub(crate) fn without_env(&self) -> Self {
        let mut saved = self.clone();
        saved.env = None;
        saved
    }

    pub(crate) fn agent(&self) -> ChatAgent {
        self.agent
    }

    fn default_settings(&self) -> crate::provider_failover::Settings {
        let mut defaults = self.defaults.clone().unwrap_or_else(|| self.settings());
        defaults.access = self.access.unwrap_or(Access::Read);
        defaults
    }

    pub(crate) fn settings(&self) -> crate::provider_failover::Settings {
        crate::provider_failover::Settings {
            agent: self.agent,
            model: self.model.clone(),
            effort: self.effort.clone(),
            access: self.access.unwrap_or(Access::Read),
        }
    }

    pub(crate) fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub(crate) fn resumable(&self) -> bool {
        self.session_id
            .as_deref()
            .is_some_and(|id| safe_session_id(id).is_some())
    }

    /// The access level these settings start a chat at.
    pub(crate) fn access_level(&self) -> Option<Access> {
        self.access
    }

    #[cfg(test)]
    pub(crate) fn at(mut self, access: Access) -> Self {
        self.access = Some(access);
        self
    }

    #[cfg(test)]
    pub(crate) fn for_test(agent: ChatAgent, session_id: Option<&str>) -> Self {
        Self {
            defaults: None,
            cwd: "/tmp/project".into(),
            agent,
            model: None,
            access: Some(Access::Read),
            extra_dirs: None,
            env: None,
            effort: None,
            lite: None,
            session_id: session_id.map(str::to_string),
        }
    }
}

/// Saved with the question, including its exact process and provider memory.
/// These settings stay in the private profile and never go to the browser.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct QuestionOrigin {
    pub chat_key: String,
    pub session_key: String,
    pub launch_id: String,
    start: StartContext,
}

/// What the asking chat runs on, read-only: a handover to `self` copies it.
impl QuestionOrigin {
    pub(crate) fn agent(&self) -> ChatAgent {
        self.start.agent
    }

    pub(crate) fn model(&self) -> Option<String> {
        self.start.model.clone()
    }

    pub(crate) fn effort(&self) -> Option<String> {
        self.start.effort.clone()
    }

    pub(crate) fn access(&self) -> Option<Access> {
        self.start.access
    }

    pub(crate) fn cwd(&self) -> &str {
        &self.start.cwd
    }

    /// The provider's own id for the conversation, when it was known.
    pub(crate) fn session_id(&self) -> Option<&str> {
        self.start.session_id.as_deref()
    }

    /// The project environment the chat was started with.
    pub(crate) fn env(&self) -> std::collections::BTreeMap<String, String> {
        self.start.env.clone().unwrap_or_default()
    }
}

/// A message the person has sent that its agent has not been given yet.
///
/// Both kinds of provider queue, for different reasons, and the queue is OURS
/// for both — which is the whole point of it.
///
/// A command-line provider is deliberately one-shot, so a follow-up waits here
/// while its previous process finishes exiting and then rides the next resume
/// command rather than disappearing with the old process. A persistent provider
/// can take bytes on stdin at any moment, and used to: the message went
/// straight through into the agent's OWN internal queue, where nothing on this
/// side could reach it again. Holding it here until the running turn reaches
/// its full stop is what makes a queued message something the person can still
/// take back — see `chat_cancel_queued_impl`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct QueuedTurn {
    text: String,
    images: Vec<String>,
    /// The optimistic browser bubble this exact FIFO entry belongs to. Internal
    /// agent-to-agent turns have none and remain invisible user-wise.
    turn_id: Option<String>,
    /// Later browser sends folded into this one dispatch. The first id remains
    /// canonical for provider acknowledgement; every id remains a valid target
    /// for cancellation, send-now, snapshots, and idempotent retries.
    appended_turn_ids: Vec<String>,
    /// Whether this prompt has a durable canonical envelope. Internal
    /// agent-to-agent briefs are not person-visible messages.
    recorded: bool,
    /// Settings captured when this unit was queued. Compatible text is never
    /// folded across an access/model/provider/workspace change.
    context: Option<QueueContext>,
}

impl QueuedTurn {
    fn turn_ids(&self) -> impl Iterator<Item = &str> {
        self.turn_id
            .iter()
            .map(String::as_str)
            .chain(self.appended_turn_ids.iter().map(String::as_str))
    }

    fn owns_turn_id(&self, turn_id: &str) -> bool {
        self.turn_ids().any(|id| id == turn_id)
    }

    fn is_ordinary_person_turn(&self) -> bool {
        self.recorded
            && self
                .turn_id
                .as_deref()
                .is_some_and(|id| id.starts_with("user-") || id.starts_with("octiq-user-"))
            && !self.text.trim_start().starts_with('/')
    }

    fn can_append(&self, later: &Self) -> bool {
        self.is_ordinary_person_turn()
            && later.is_ordinary_person_turn()
            && self.context == later.context
    }

    fn append(&mut self, later: QueuedTurn) {
        if !later.text.is_empty() {
            if !self.text.is_empty() {
                self.text.push('\n');
            }
            self.text.push_str(&later.text);
        }
        self.images.extend(later.images);
        if let Some(turn_id) = later.turn_id {
            self.appended_turn_ids.push(turn_id);
        }
        self.appended_turn_ids.extend(later.appended_turn_ids);
    }
}

/// Why a chat's queue waits (`ChatManager::waiting`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Waiting {
    /// The chat the queue's messages are written in.
    stream_key: String,
    /// Why the next message did not start: the profile's own sentence.
    why: String,
}

/// What became of a queued message carried into its chat's next process
/// (`carry_queued_turn`).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Carried {
    /// It is that process's first message.
    Started,
    /// It could not be started because its record cannot be kept. It is
    /// back at the front of the queue, which waits, for this reason.
    Waits(String),
}

/// What a Stop did (`chat_interrupt`). A Stop that stopped the agent is
/// never an error because the message behind it could not start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stopped {
    /// The agent was asked to stop, or its process was ended.
    pub stopped: bool,
    /// How many messages the person sent are still queued and not sent.
    pub waiting: usize,
    /// Why the first of them did not start, when it should have and could
    /// not: the queue waits for the profile folder. Absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_started: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum QueueTurnResult {
    Enqueued,
    Appended { target: String, source: String },
    Duplicate,
}

#[derive(Default)]
pub struct ChatManager {
    pub(crate) failover: crate::provider_failover::State,
    background: crate::background_tasks::Store,
    /// Long-running jobs this chat's agent started (`chat_jobs.rs`). A job
    /// that is running holds the chat off the idle reaper, like background
    /// work does.
    pub(crate) jobs: crate::chat_jobs::Store,
    /// Each launch's spool folder, where `octiq-job` reports a job when its
    /// sandbox refuses the hook (`job_spool.rs`).
    pub(crate) spools: crate::job_spool::Spools,
    /// The agent program each live process was started from, resolved through
    /// its symlinks (`remember_binary`), keyed like `sessions`.
    binaries: Mutex<HashMap<String, PathBuf>>,
    /// Tokens each registered agent's chats used (`agent_usage.rs`).
    pub(crate) usage: crate::agent_usage::Store,
    pub(crate) orchestrations: Arc<crate::orchestration::OrchestrationStore>,
    pub(crate) questions: Arc<crate::question_store::QuestionStore>,
    pub(crate) auto_resumes: crate::auto_resume::Store,
    sessions: Mutex<HashMap<String, Arc<Mutex<ChatSession>>>>,
    /// Every worker's capacity lease outlives removal from `sessions`: kill is
    /// asynchronous. Retain the child until the worker reaper observes exit.
    ending_workers: Mutex<HashMap<String, Arc<Mutex<ChatSession>>>>,
    /// Latest real launch per key, retained after a natural one-shot exit.
    /// Updated under the session table in grant_capability. A buffered clean
    /// full stop can then distinguish that exit from a replacement launch.
    auto_plan_launches: Mutex<HashMap<String, String>>,
    /// Leaf map: its guard is never held while acquiring any other lock.
    /// Evidence carries the atomic itself, so ledger commit takes no chat lock.
    stop_epochs: Mutex<HashMap<String, Arc<std::sync::atomic::AtomicU64>>>,
    /// Leaf map, like stop_epochs. Every real prompt start advances this
    /// under its own writer lock, before any bytes can reach the provider.
    turn_sequences: Mutex<HashMap<String, Arc<std::sync::atomic::AtomicU64>>>,
    /// How each running agent was last started — see `StartContext`. Keyed by
    /// process key, so each chat resumes independently.
    starts: Mutex<HashMap<String, StartContext>>,
    /// Serializes native-id I/O with /clear, independently of process locks.
    /// Stop/interrupt never take this gate. Weak entries are swept in batches.
    native_writes: Mutex<HashMap<String, std::sync::Weak<Mutex<()>>>>,
    /// What each agent has been sent but not yet given — see `QueuedTurn`.
    /// Keyed by process key, so chats queue independently.
    queued_turns: Mutex<HashMap<String, VecDeque<QueuedTurn>>>,
    /// A one-shot process is being replaced. Sends still join its queue, and a
    /// second client must not start a competing process in this gap.
    handoffs: Mutex<std::collections::HashSet<String>>,
    /// The chats whose queue waits with nothing taking it: its next message
    /// could not be started, or handed to the running agent, because the
    /// record of that turn could not be kept (`keep_waiting`). Nothing in
    /// such a queue is failed or forgotten; `start_waiting_queues` hands
    /// the first message over once the profile folder is back. An entry
    /// goes when its queue empties, so a chat listed here has had nothing
    /// written to its agent since it was listed. Taken after
    /// `queued_turns`, never before.
    waiting: Mutex<std::collections::BTreeMap<String, Waiting>>,
    /// The "not sent" lines of messages a deliberate ending dropped from a
    /// queue while they could not be written (`record_unsent`), as (chat,
    /// turn id): written once the profile folder is back (`settle_unsent`).
    unsent: Mutex<Vec<(String, String)>>,
    /// What the person sent, as the browser handed it over — see
    /// `TurnEvidence`. Newest last, bounded.
    evidence: Mutex<VecDeque<TurnEvidence>>,
    /// Each running agent's hook credential — see `LaunchCapability`. Keyed
    /// by process key.
    capabilities: Mutex<HashMap<String, LaunchCapability>>,
    /// Processes launched as front-desk chats (`team::front_desk_chat`), so
    /// the session id each one names is kept out of the resume list.
    /// Each with the provider it runs on, which is half of a session's name.
    front_desks: Mutex<HashMap<String, ChatAgent>>,
    /// "<chat>\n<task>" for each orchestration writer a chat has been told it
    /// writes beside (`admit_beside_writers`), so it is said once, not per send.
    writer_notices: Mutex<std::collections::HashSet<String>>,
    /// How many turns a Stop has cut short, which names each unwind — see
    /// `CutOff::Owed`.
    unwinds: std::sync::atomic::AtomicU64,
    /// What a test sets and reads about the wait behind a Stop.
    #[cfg(test)]
    unwind_probe: UnwindProbe,
    /// Chats whose removed folder is being put back, each with the thread
    /// doing it — see `ChatManager::claim_start`.
    start_claims: Mutex<HashMap<String, thread::ThreadId>>,
    /// Leaf path marks, taken under sessions before checking idleness.
    lifespan_holds: Mutex<std::collections::BTreeSet<String>>,
    /// Chats the person is completing, each with the id of its wrap-up turn
    /// — see `chat_complete_impl`. In memory only: a server restart forgets
    /// it and the chat is simply not ticked.
    completing: Mutex<HashMap<String, String>>,
    /// Conversations whose registered agent is being removed, or was, by
    /// chat key — see `Leaving`. A leaf: held for one lookup or one change
    /// and never across another lock.
    leaving: Mutex<HashMap<String, Arc<Leaving>>>,
}

/// One start's hold on a chat that has no process yet
/// (`ChatManager::claim_start`). Dropping it lets the chat go.
pub(crate) struct StartClaim<'a> {
    manager: &'a ChatManager,
    key: String,
    _storage: Option<crate::transcript::StorageHold>,
}

impl Drop for StartClaim<'_> {
    fn drop(&mut self) {
        self.manager
            .start_claims
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

/// A path mark blocks even a brand new chat id, under the session table.
/// The caller holds the workspace lifecycle lock until this guard is dropped.
pub(crate) struct LifespanHold<'a> {
    manager: &'a ChatManager,
    checkout: String,
}
impl Drop for LifespanHold<'_> {
    fn drop(&mut self) {
        if let Ok(mut holds) = self.manager.lifespan_holds.lock() {
            holds.remove(&self.checkout);
        }
    }
}

/// How long a send waits for another thread's start of the same chat to
/// finish (`ChatManager::wait_out_start`) before it answers "no such chat".
const START_WAIT: Duration = Duration::from_secs(10);
const START_WAIT_POLL: Duration = Duration::from_millis(25);

/// How long an interrupted turn may take to send its own full stop before
/// its process is ended (`grace_ran_out`). Claude and Codex answer an
/// interrupt in well under a second; this only covers one that never does.
#[cfg_attr(test, allow(dead_code))]
const UNWIND_GRACE: Duration = Duration::from_secs(30);

/// The wait behind a Stop, as a test steers and counts it. With no grace set
/// a Stop starts no thread, and the test plays the end of the grace itself
/// (`grace_ran_out`).
#[cfg(test)]
#[derive(Default)]
struct UnwindProbe {
    grace: Mutex<Option<Duration>>,
    /// Waits a Stop asked for.
    asked: std::sync::atomic::AtomicUsize,
    /// Waits that ran to the end of their grace, whatever they then found.
    over: std::sync::atomic::AtomicUsize,
}

/// The secret one launch of one agent proves itself with on
/// `/hook/orchestration`, handed to it as `OCTIQ_CHAT_CAPABILITY`.
///
/// The server token opens that hook for every agent alike, and every agent
/// can read it, so it says nothing about WHICH chat is calling. This does:
/// the host minted it for this launch and knows whose it is, so the caller's
/// chat comes from here and never from the request body. It is good only
/// while that launch is the process running under its key — a relaunch mints
/// a new one and an ended chat's is dead.
///
/// It is a bearer secret in a process environment. Another process of the
/// same OS user that inspects this one can read it; nothing here claims
/// otherwise.
#[derive(Clone)]
struct LaunchCapability {
    chat_key: String,
    launch_id: String,
    /// SHA-256 of the secret, so a lookup compares digests, not the secret.
    digest: [u8; 32],
}

fn capability_digest(secret: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(secret.as_bytes()).into()
}

/// A fresh capability secret: 244 random bits.
fn mint_capability() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// One message as the person sent it: their words BEFORE the host dressed
/// them for the agent (a lead's roster refresh, a model handoff), and the
/// plans their screen showed at that moment. Recorded only on the browser's
/// send and start commands, so nothing an agent, a notification or a gate
/// answer produces can ever have any.
#[derive(Clone, Debug)]
struct TurnEvidence {
    chat_key: String,
    turn_id: String,
    text: String,
    /// What each part saw: one list per coalesced send, never merged.
    parts_seen: Vec<Vec<crate::orchestration::SeenPlan>>,
}

/// Enough for every chat's queue to hold a few messages each.
const EVIDENCE_KEPT: usize = 256;

/// Turn ids the host gives a person's own message. Notifications, receipts
/// and host continuations never carry one.
fn is_person_turn_id(turn_id: &str) -> bool {
    turn_id.starts_with("user-") || turn_id.starts_with("octiq-user-")
}

impl ChatManager {
    fn native_write(&self, key: &str) -> Arc<Mutex<()>> {
        let mut writes = self.native_writes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(write) = writes.get(key).and_then(std::sync::Weak::upgrade) {
            return write;
        }
        if writes.len() >= 256 {
            writes.retain(|_, write| write.strong_count() != 0);
        }
        let write = Arc::new(Mutex::new(()));
        writes.insert(key.into(), Arc::downgrade(&write));
        write
    }

    fn stop_epoch(&self, key: &str) -> Arc<std::sync::atomic::AtomicU64> {
        self.stop_epochs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(key.into())
            .or_default()
            .clone()
    }

    fn turn_sequence(&self, key: &str) -> Arc<std::sync::atomic::AtomicU64> {
        self.turn_sequences
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(key.into())
            .or_default()
            .clone()
    }

    /// Observing an autonomous turn vetoes earlier clean ends, but never
    /// restores launch evidence a Stop revoked. Its own clean end qualifies
    /// only if evidence is still intact since the last real host prompt.
    fn note_observed_turn(&self, key: &str) {
        self.turn_sequence(key)
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// Called only before a real host prompt write, under the own writer's
    /// lock. Enqueue and observed agent output are not prompt writes.
    /// Persistent processes regain launch evidence after Stop here, never
    /// while consuming a buffered init or the cut-off full stop.
    fn start_auto_plan_turn(&self, key: &str, session: &ChatSession) {
        self.note_observed_turn(key);
        if provider_for(session.agent)
            .capabilities()
            .input
            .accepts_stdin()
        {
            let mut launches = self
                .auto_plan_launches
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            // A stale writer cannot replace a newer process's identity.
            launches
                .entry(key.into())
                .or_insert_with(|| session.launch_id.clone());
        }
    }

    /// No chat lock is needed to veto a staged approval. The leaf map guard
    /// is gone before touching the atomic or the separate leaf launches map.
    /// Natural reaping alone keeps both epoch and launch evidence unchanged.
    fn revoke_auto_plan(&self, key: &str) {
        let epoch = self.stop_epoch(key);
        self.auto_plan_launches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(key);
        // Capture reads epoch THEN launch. Remove launch BEFORE advancing
        // epoch, so an old writer can never capture the post-Stop epoch
        // together with a still-valid launch and bless already stopped work.
        epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// The chat a hook caller is, and the launch it is, from the capability
    /// that launch was given (`LaunchCapability`). `None` unless `secret` is
    /// the current capability of the process running under `session_key`
    /// right now.
    pub(crate) fn caller_for_capability(
        &self,
        session_key: &str,
        secret: &str,
    ) -> Option<(String, String)> {
        if secret.is_empty() {
            return None;
        }
        let known = self.capabilities.lock().ok()?.get(session_key).cloned()?;
        let given = capability_digest(secret);
        // Constant time over the digest.
        if known
            .digest
            .iter()
            .zip(given.iter())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            != 0
        {
            return None;
        }
        // Ledger first, then chat locks. Batch settlement revokes every hook
        // immediately; ending the provider process may happen later.
        if (known.chat_key.starts_with("chat:orch-") || session_key.starts_with("chat:orch-"))
            && !self
                .orchestrations
                .batch_capability_current(&known.chat_key, session_key)
                .ok()?
        {
            return None;
        }
        let session = self.sessions.lock().ok()?.get(session_key).cloned()?;
        let live = session.lock().ok()?.launch_id == known.launch_id;
        live.then_some((known.chat_key, known.launch_id))
    }

    /// Whether the launch `launch_id` is the process running under
    /// `session_key` right now.
    pub(crate) fn launch_running(&self, session_key: &str, launch_id: &str) -> bool {
        let Some(session) = self
            .sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(session_key).cloned())
        else {
            return false;
        };
        session.lock().is_ok_and(|s| s.launch_id == launch_id)
    }

    /// Give the launch about to run under `session_key` its capability, and
    /// forget those of processes no longer running. Called with the session
    /// table held, so `live` is exact.
    fn grant_capability(
        &self,
        live: &HashMap<String, Arc<Mutex<ChatSession>>>,
        session_key: &str,
        chat_key: &str,
        launch_id: &str,
    ) -> String {
        self.revoke_auto_plan(session_key);
        // A new launch starts a fresh writer (including a one-shot resume),
        // before it can execute its command-line prompt. The table is held.
        self.turn_sequence(session_key)
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let secret = mint_capability();
        if let Ok(mut launches) = self.auto_plan_launches.lock() {
            launches.insert(session_key.into(), launch_id.into());
        }
        if let Ok(mut capabilities) = self.capabilities.lock() {
            capabilities.retain(|key, _| live.contains_key(key));
            capabilities.insert(
                session_key.to_string(),
                LaunchCapability {
                    chat_key: chat_key.to_string(),
                    launch_id: launch_id.to_string(),
                    digest: capability_digest(&secret),
                },
            );
        }
        secret
    }

    /// Keep the person's own words for a message the browser is sending. A
    /// retried send of the same turn keeps what was first recorded.
    pub(crate) fn note_person_turn(
        &self,
        chat_key: &str,
        turn_id: &str,
        text: &str,
        seen_plans: Vec<crate::orchestration::SeenPlan>,
    ) {
        if !is_person_turn_id(turn_id) {
            return;
        }
        let Ok(mut kept) = self.evidence.lock() else {
            return;
        };
        if kept
            .iter()
            .any(|item| item.chat_key == chat_key && item.turn_id == turn_id)
        {
            return;
        }
        kept.push_back(TurnEvidence {
            chat_key: chat_key.into(),
            turn_id: turn_id.into(),
            text: text.into(),
            parts_seen: vec![seen_plans],
        });
        while kept.len() > EVIDENCE_KEPT {
            kept.pop_front();
        }
    }

    /// A follow-up joined a queued message (`QueuedTurn::append`): the
    /// person's words and what they saw join its evidence the same way, so
    /// the unit is judged whole — "approve" then "but change X" is one turn.
    fn join_person_turn(&self, chat_key: &str, target: &str, source: &str) {
        let Ok(mut kept) = self.evidence.lock() else {
            return;
        };
        let find = |kept: &VecDeque<TurnEvidence>, id: &str| {
            kept.iter()
                .position(|item| item.chat_key == chat_key && item.turn_id == id)
        };
        let later = match find(&kept, source) {
            Some(at) => kept.remove(at),
            None => None,
        };
        let Some(at) = find(&kept, target) else {
            return;
        };
        let joined = &mut kept[at];
        match later {
            Some(later) => {
                joined.text.push('\n');
                joined.text.push_str(&later.text);
                joined.parts_seen.extend(later.parts_seen);
            }
            // A part the host never saw the person's words for makes the
            // whole unit unreadable as consent, and it saw no plan.
            None => {
                joined.text.push_str("\n\u{fffd}");
                joined.parts_seen.push(Vec::new());
            }
        }
    }

    /// The message this chat's agent is answering right now, if the person
    /// typed it. `None` while idle, and for any turn the host started itself.
    pub(crate) fn person_turn(&self, chat_key: &str) -> Option<crate::orchestration::PersonTurn> {
        let turn_id = {
            let sessions = self.sessions.lock().ok()?;
            let session = sessions.get(chat_key)?.lock().ok()?;
            if !session.busy {
                return None;
            }
            session.answering.clone()?
        };
        if !is_person_turn_id(&turn_id) {
            return None;
        }
        let kept = self.evidence.lock().ok()?;
        let item = kept
            .iter()
            .find(|item| item.chat_key == chat_key && item.turn_id == turn_id)?;
        Some(crate::orchestration::PersonTurn {
            turn_id,
            text: item.text.clone(),
            parts_seen: item.parts_seen.clone(),
        })
    }

    pub(crate) fn with_saved_questions(path: std::path::PathBuf) -> Self {
        let auto_resume_path = path.with_file_name("auto-resumes.json");
        let background_path = path.with_file_name("background-tasks.json");
        let usage_path = path.with_file_name("agent-usage.json");
        let jobs_path = path.with_file_name("jobs.json");
        Self {
            background: crate::background_tasks::Store::load(background_path),
            jobs: crate::chat_jobs::Store::load(jobs_path),
            usage: crate::agent_usage::Store::load(usage_path),
            questions: Arc::new(crate::question_store::QuestionStore::load(path)),
            auto_resumes: crate::auto_resume::Store::load(auto_resume_path),
            ..Self::default()
        }
    }
    /// The running chats whose recorded working folder is `checkout` or
    /// inside it. A handover refuses to give a checkout to a new chat while
    /// another live chat writes there.
    pub(crate) fn live_chats_in(&self, checkout: &str) -> Vec<String> {
        let Ok(top) = crate::paths::canonicalize(checkout) else {
            return Vec::new();
        };
        let running: Vec<String> = match self.sessions.lock() {
            Ok(sessions) => sessions.keys().cloned().collect(),
            Err(_) => return Vec::new(),
        };
        running
            .into_iter()
            .filter(|key| {
                self.start_context(key).is_some_and(|start| {
                    crate::paths::canonicalize(&start.cwd).is_ok_and(|cwd| cwd.starts_with(&top))
                })
            })
            .collect()
    }

    pub(crate) fn question_origin(
        &self,
        chat_key: &str,
        session_key: Option<&str>,
        launch_id: Option<&str>,
    ) -> Result<QuestionOrigin, String> {
        let session_key = session_key.unwrap_or(chat_key);
        if session_key != chat_key {
            return Err("Questions from removed additional agents can no longer be resumed".into());
        }
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(session_key)
            .ok_or("The asking agent is no longer running")?;
        let session = session.lock().map_err(|e| e.to_string())?;
        if !session.busy || launch_id.is_some_and(|id| id != session.launch_id) {
            return Err("The asking agent's turn has already ended".into());
        }
        let start = self
            .start_context(session_key)
            .ok_or("The asking agent has no saved settings")?;
        if start.session_id.is_none() {
            return Err("The asking agent has not announced its conversation yet".into());
        }
        Ok(QuestionOrigin {
            chat_key: chat_key.into(),
            session_key: session_key.into(),
            launch_id: session.launch_id.clone(),
            start,
        })
    }

    /// Remember how an agent was started, so it can be started that way again.
    fn remember_start(&self, session_key: &str, mut start: StartContext) {
        // Share clear's starts lock: a rollback checked before revocation
        // cannot pause, then put its old id back after clear released the lock.
        if let Ok(mut m) = self.starts.lock() {
            // A lowering/rollback also uses this door while its profile is
            // away. Keep its settings, but never publish an id whose durable
            // revocation status could not be checked.
            start.session_id =
                crate::chat_index::usable_session(session_key, start.session_id.clone())
                    .unwrap_or(None);
            m.insert(session_key.to_string(), start.clone());
        }
        if let Err(error) = self.orchestrations.save_resume_context(session_key, start) {
            eprintln!("orchestration: could not save resume settings: {error}");
        }
    }

    pub(crate) fn persist_orchestration_context(&self, key: &str) -> Result<(), String> {
        if let Some(start) = self.start_context(key) {
            self.orchestrations.save_resume_context(key, start)?;
        }
        Ok(())
    }

    /// `persist_orchestration_context` for an access level that has already
    /// taken hold (`chat_set_access_impl`): the change is not undone, or
    /// reported as failed, because the ledger could not be written. It is
    /// kept for a host resume, said as not recorded, and owed.
    fn keep_access_for_resume(&self, key: &str) {
        let Some(start) = self.start_context(key) else {
            return;
        };
        if let Err(why) = self.orchestrations.keep_resume_context(key, start) {
            eprintln!("orchestration: could not keep the access level of {key}: {why}");
        }
    }

    /// A turn of `key` was interrupted and the agent has not reached its own
    /// full stop yet. The interrupt marks the session idle at once, so a host
    /// notification written in that gap went in as the NEXT turn, and the
    /// cut-off turn's late `result` then ended it: the agent worked on with
    /// the session read as idle, which the idle sweeper may kill.
    ///
    /// The same goes for anything else written in that gap, so nothing is: a
    /// message from the person and a completion's wrap-up join the queue
    /// behind the cut-off turn (`chat_send_with_user_turn`,
    /// `chat_complete_impl`) and are handed over on its full stop like any
    /// queued message. A wrap-up written straight in was decided by that
    /// full stop instead of its own (review of 2fd3231, H2).
    ///
    /// The mark is the session's own (`CutOff`), so it does not run out with
    /// a clock: it goes on the full stop, or with the process. This takes
    /// the session table and tries the session, and a session somebody else
    /// holds reads as unwinding, which only ever makes a notification wait
    /// for the next pass. A caller holding either lock reads
    /// `ChatSession::cut_off` itself.
    pub(crate) fn unwinding(&self, key: &str) -> bool {
        let Ok(sessions) = self.sessions.lock() else {
            return true;
        };
        sessions.get(key).is_some_and(|session| {
            session
                .try_lock()
                .map(|session| session.cut_off != CutOff::No)
                .unwrap_or(true)
        })
    }

    /// A name for the unwind a Stop is about to begin (`CutOff::Owed`).
    fn next_unwind(&self) -> u64 {
        self.unwinds
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1
    }

    /// How long the thread behind a Stop waits before ending a process that
    /// has not stopped. `None` starts no thread, which only a test does.
    fn unwind_grace(&self) -> Option<Duration> {
        #[cfg(test)]
        {
            *self.unwind_probe.grace.lock().unwrap()
        }
        #[cfg(not(test))]
        Some(UNWIND_GRACE)
    }

    /// Tell the orchestration ledger about one line of a chat's stream.
    ///
    /// Feedback 240ea516: Claude spells the full stop of a turn the host cut
    /// short (Stop, or a coordinator's interrupt) as a failed `result`. The
    /// ledger is told the cut was ours, so the worker's attempt waits for the
    /// message behind the interrupt instead of failing. Call this before the
    /// full stop clears the mark, with the session whose stream it is.
    fn observe_for_orchestration(
        &self,
        session: &Mutex<ChatSession>,
        key: &str,
        event: &Value,
    ) -> Result<(), String> {
        // Claude's failed `result` and Pi's `agent_settled` are the full stop
        // of the turn the host cut short.
        let interrupted = matches!(
            event.get("type").and_then(Value::as_str),
            Some("result" | "agent_settled")
        ) && session
            .lock()
            .is_ok_and(|session| session.cut_off != CutOff::No);
        self.orchestrations
            .observe_worker_turn_event(key, event, interrupted)
    }

    pub(crate) fn notification_ready(&self, key: &str) -> bool {
        if self.unwinding(key) {
            return false;
        }
        let Ok(sessions) = self.sessions.lock() else {
            return false;
        };
        if self.has_queued_turns(key) {
            return false;
        }
        if self
            .handoffs
            .lock()
            .map(|h| h.contains(key))
            .unwrap_or(true)
        {
            return false;
        }
        sessions.get(key).is_none_or(|session| {
            session
                .try_lock()
                .map(|s| !s.busy && provider_for(s.agent).capabilities().input.accepts_stdin())
                .unwrap_or(false)
        })
    }

    /// The agent named its own conversation. Kept so its next process can
    /// resume it rather than beginning a new one.
    fn remember_session(&self, session_key: &str, session_id: &str) {
        let write = self.native_write(session_key);
        let _write = write.lock().unwrap_or_else(|e| e.into_inner());
        if self.prepare_session(session_key, session_id) {
            self.publish_session(session_key, session_id);
        }
    }

    /// Only store I/O, with no session or starts lock held. The caller owns
    /// the native-write gate and must still validate its launch before publish.
    fn prepare_session(&self, session_key: &str, session_id: &str) -> bool {
        if !matches!(
            crate::chat_index::usable_session(session_key, Some(session_id.into())),
            Ok(Some(_))
        ) {
            return false;
        }
        if crate::lead_threads::is_key(session_key) {
            let id = session_key.trim_start_matches("chat:");
            match crate::chat_index::lead_session(id, session_id) {
                Ok(()) => crate::bus::emit("chat-index-changed", &json!({"id":id,"gone":false})),
                Err(error) => eprintln!("lead thread: could not save provider session: {error}"),
            }
        }
        let desk = self
            .front_desks
            .lock()
            .ok()
            .and_then(|desks| desks.get(session_key).copied());
        if let Some(provider) = desk {
            crate::team::note_front_desk_session(
                &crate::team::default_path(),
                session_key,
                provider,
                session_id,
            );
        }
        if let Some(mut start) = self.start_context(session_key) {
            start.session_id = Some(session_id.into());
            if let Err(error) = self.orchestrations.save_resume_context(session_key, start) {
                eprintln!("orchestration: could not save provider session: {error}");
            }
        }
        true
    }

    fn publish_session(&self, session_key: &str, session_id: &str) {
        if let Ok(mut starts) = self.starts.lock() {
            if let Some(start) = starts.get_mut(session_key) {
                start.session_id = Some(session_id.into());
            }
        }
    }

    /// A Stop overtook native-id I/O. Revoke just that id, preserving any
    /// previously known conversation and the chat's launch settings.
    fn revoke_late_session(&self, session_key: &str, session_id: &str) {
        if let Err(error) = crate::chat_index::revoke_late_session(session_key, session_id) {
            eprintln!("chat: could not revoke late provider session: {error}");
        }
        if let Err(error) = self
            .orchestrations
            .revoke_late_session(session_key, session_id)
        {
            eprintln!("orchestration: could not revoke late provider session: {error}");
        }
    }

    fn start_context(&self, session_key: &str) -> Option<StartContext> {
        self.starts.lock().ok()?.get(session_key).cloned()
    }

    /// A Pi tool call reached the gate. Takes the session lock for an instant
    /// (no ledger, no await). `asked` marks a call that will park on the
    /// person's card. None for a launch that is not the running one: nothing
    /// of the current turn can depend on it.
    pub(crate) fn pi_call_begin(
        &self,
        session_key: &str,
        launch_id: Option<&str>,
        asked: bool,
    ) -> Option<PiCallTurn> {
        let session = self.sessions.lock().ok()?.get(session_key).cloned()?;
        let mut session = session.lock().ok()?;
        if launch_id.is_some_and(|id| id != session.launch_id) {
            return None;
        }
        if asked {
            session.auto_plan_turn.open_asks += 1;
        }
        Some(PiCallTurn {
            launch_id: session.launch_id.clone(),
            write_id: session.auto_plan_turn.write_id,
            sequence: self
                .turn_sequence(session_key)
                .load(std::sync::atomic::Ordering::SeqCst),
            asked,
        })
    }

    /// The gate answered. A refusal (the host's rule, an impostor, the
    /// person's Deny, a card nobody answered) latches the current turn; an
    /// allow changes nothing. An answer for another launch, prompt or turn
    /// touches nothing.
    pub(crate) fn pi_call_end(&self, session_key: &str, call: &PiCallTurn, refused: bool) {
        let Some(session) = self
            .sessions
            .lock()
            .ok()
            .and_then(|s| s.get(session_key).cloned())
        else {
            return;
        };
        let mut session = session.lock().unwrap_or_else(|e| e.into_inner());
        let current = session.launch_id == call.launch_id
            && session.auto_plan_turn.write_id == call.write_id
            && self
                .turn_sequence(session_key)
                .load(std::sync::atomic::Ordering::SeqCst)
                == call.sequence;
        if !current {
            return;
        }
        if call.asked {
            session.auto_plan_turn.open_asks = session.auto_plan_turn.open_asks.saturating_sub(1);
        }
        if refused {
            session.auto_plan_refused = true;
        }
    }

    /// The folders a chat works in, the working directory first: where a Pi
    /// tool call is judged to be "in the project" (`pi_gate`). Empty for a
    /// chat the host has no record of.
    pub(crate) fn launch_folders(&self, session_key: &str) -> Vec<String> {
        let Some(start) = self.start_context(session_key) else {
            return Vec::new();
        };
        std::iter::once(start.cwd)
            .chain(start.extra_dirs.into_iter().flatten())
            .collect()
    }

    /// A worker is parked on an approval card, not stalled: say so to the
    /// ledger the way Claude's own `control_request` does.
    pub(crate) fn note_waiting_for_approval(&self, key: &str) {
        if let Err(error) = self
            .orchestrations
            .observe_worker_event(key, &json!({ "type": "control_request" }))
        {
            eprintln!("orchestration: cannot record tool wait: {error}");
        }
    }

    /// The provider's own conversation id for `session_key`, as its process
    /// last reported it. Read-only: a handover's ask back forks from it.
    pub(crate) fn provider_session(&self, session_key: &str) -> Option<String> {
        self.start_context(session_key)?
            .session_id
            .filter(|id| safe_session_id(id).is_some())
    }

    /// Which agent runs `key`, the level it runs at now, and when a new level
    /// would take hold: what an access request is put to the person with.
    /// The level is the start context's, which `chat_set_access` keeps
    /// current for every provider. None for a chat with no live process.
    pub(crate) fn access_standing(&self, key: &str) -> Option<crate::access_request::Standing> {
        let session = self.sessions.lock().ok()?.get(key).cloned()?;
        let (agent, app_server_thread) = {
            let guard = session.lock().ok()?;
            (guard.agent, guard.codex.is_some())
        };
        let access = self
            .start_context(key)
            .and_then(|start| start.access)
            .unwrap_or(Access::Read);
        Some(crate::access_request::Standing {
            agent,
            access,
            takes: crate::access_request::takes(
                app_server_thread,
                provider_for(agent).capabilities(),
            ),
        })
    }

    fn queue_context(&self, session_key: &str) -> Option<QueueContext> {
        self.start_context(session_key).map(QueueContext::from)
    }

    /// Session history must not turn a worker into a new ordinary chat by
    /// resuming its provider session under a different browser chat key.
    pub(crate) fn require_user_resume(&self, resume: &str) -> Result<(), String> {
        let owners = self
            .starts
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .filter(|(_, start)| start.session_id.as_deref() == Some(resume))
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in owners {
            self.orchestrations.require_user_chat(&key)?;
        }
        for chat in crate::chat_index::list()
            .into_iter()
            .chain(crate::chat_index::deleted())
        {
            if chat.session_id.as_deref() == Some(resume) {
                self.orchestrations
                    .require_user_chat(&format!("chat:{}", chat.id))?;
            }
        }
        Ok(())
    }

    pub(crate) fn turn_in_flight(&self, key: &str) -> bool {
        let Ok(sessions) = self.sessions.lock() else {
            return true;
        };
        sessions
            .get(key)
            .is_some_and(|s| s.try_lock().map(|s| s.busy).unwrap_or(true))
    }

    /// `turn_in_flight`, for a caller that already holds locks of its own
    /// and must never wait for this manager's: the removal of a registered
    /// agent asks under the roster's lock and the ledger's
    /// (`orchestration::agent_work::Departure`). The session table is tried,
    /// not waited for, and a table that is busy answers `true`: in doubt a
    /// turn is in flight, and the removal is refused and asked again.
    pub(crate) fn turn_may_be_in_flight(&self, key: &str) -> Turn {
        let Ok(sessions) = self.sessions.try_lock() else {
            return Turn::Unconfirmed;
        };
        let Some(session) = sessions.get(key) else {
            return Turn::Idle;
        };
        let seen = match session.try_lock() {
            Ok(session) if session.busy => Turn::InFlight,
            Ok(_) => Turn::Idle,
            Err(_) => Turn::Unconfirmed,
        };
        seen
    }

    /// Mark the conversations the registered agent `name` speaks in as
    /// itself (`keys`) as its removal begins: from here no process is
    /// started for one of them (`leaving_refusal`). The removal then asks
    /// each one whether it is working (`LeavingMark::working`), which is
    /// where a live process takes the mark. See `Leaving` for why the order
    /// is mark, then look.
    ///
    /// A conversation of an agent that is already gone keeps the mark it
    /// has.
    pub(crate) fn mark_leaving(&self, name: &str, keys: &[String]) -> LeavingMark<'_> {
        let mark = Arc::new(Leaving {
            name: name.to_owned(),
            state: std::sync::atomic::AtomicU8::new(Leaving::UNDER_WAY),
        });
        let mut marks = self.leaving.lock().unwrap_or_else(|e| e.into_inner());
        for key in keys {
            if marks
                .get(key)
                .is_none_or(|held| held.state() != Leaving::GONE)
            {
                marks.insert(key.clone(), mark.clone());
            }
        }
        LeavingMark {
            manager: self,
            keys: keys.to_vec(),
            mark,
        }
    }

    /// Why the conversation `key` takes no message and starts no process:
    /// its registered agent is being removed, or was. `None` otherwise.
    pub(crate) fn leaving_refusal(&self, key: &str) -> Option<String> {
        self.leaving
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .and_then(|mark| mark.refusal())
    }

    /// Note the program a just-started process runs, as the PATH lookup the
    /// launch made resolves it through its symlinks. Homebrew keeps each Codex
    /// release in its own versioned folder and removes the old one on upgrade,
    /// so `/opt/homebrew/bin/codex` keeps working while a process started
    /// before the upgrade points at a folder that is gone (feedback db5e1001).
    fn remember_binary(&self, key: &str, bin: &str) {
        let resolved =
            crate::proc::find_executable(bin).and_then(|p| crate::paths::canonicalize(p).ok());
        if let Ok(mut binaries) = self.binaries.lock() {
            match resolved {
                Some(path) => binaries.insert(key.to_string(), path),
                None => binaries.remove(key),
            };
        }
    }

    /// Live, idle, non-worker chats whose program was removed from disk after
    /// they started — an upgrade deleted the release they run. Anything that
    /// process starts from its own path now fails: Codex's Browser Control
    /// died on "failed to start codex app-server: No such file or directory"
    /// (feedback db5e1001). Ended, the next message resumes them on the
    /// installed release. A worker is left alone: ending it would lose its
    /// attempt; its next launch picks up the new release anyway.
    fn replaced_binary_keys(&self) -> Vec<String> {
        let Ok(binaries) = self.binaries.lock() else {
            return Vec::new();
        };
        let gone: Vec<String> = binaries
            .iter()
            .filter(|(_, path)| !path.exists())
            .map(|(key, _)| key.clone())
            .collect();
        drop(binaries);
        let Ok(sessions) = self.sessions.lock() else {
            return Vec::new();
        };
        let idle: Vec<_> = gone
            .into_iter()
            .filter(|key| {
                sessions
                    .get(key)
                    .is_some_and(|s| s.try_lock().is_ok_and(|s| !s.busy))
            })
            .collect();
        drop(sessions);
        idle.into_iter()
            .filter(|key| !self.background.has_running(key) && !self.jobs.has_running(key))
            .filter(|key| self.orchestrations.refusal_owner(key).is_none())
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn test_lifespan_admission(&self, path: &str) -> Result<(), String> {
        self.lifespan_refusal(path, None)
    }
    #[cfg(test)]
    pub(crate) fn test_lifespan_queue(&self, path: &str) -> Result<(), String> {
        self.queue_turn(
            "chat:validation-queued",
            QueuedTurn {
                text: "retained queued input".into(),
                images: vec![],
                turn_id: Some("validation-turn".into()),
                appended_turn_ids: vec![],
                recorded: true,
                context: Some(QueueContext {
                    cwd: path.into(),
                    agent: ChatAgent::Codex,
                    model: None,
                    access: None,
                    extra_dirs: None,
                    env: None,
                    effort: None,
                    lite: None,
                }),
            },
        )
        .map(|_| ())
    }
    /// Path/start marks are acquired under lifecycle before this question.
    /// Include queued turns even when the chat has no live process.
    pub(crate) fn require_lifespan_idle(&self, checkout: &str) -> Result<(), String> {
        self.require_checkout_idle(checkout, true)?;
        let turns = self.queued_turns.lock().map_err(|e| e.to_string())?;
        for (key, queue) in turns.iter() {
            if queue.iter().any(|turn| {
                turn.context.as_ref().is_some_and(|context| {
                    std::iter::once(&context.cwd)
                        .chain(context.extra_dirs.iter().flatten())
                        .any(|path| {
                            crate::paths::canonical_target(std::path::Path::new(path))
                                .unwrap_or_else(|| PathBuf::from(path))
                                .starts_with(checkout)
                        })
                })
            }) {
                return Err(format!("A queued turn in {key} still needs this checkout."));
            }
        }
        drop(turns);
        for key in self.lifespan_chat_keys(checkout)? {
            if self.has_queued_turns(&key) {
                return Err(format!("A queued turn in {key} still needs this checkout."));
            }
        }
        Ok(())
    }

    /// The background work this chat's agent left running, `(id, description)`.
    pub(crate) fn running_background(&self, key: &str) -> Vec<(String, String)> {
        self.background.running(key)
    }

    pub(crate) fn has_process(&self, key: &str) -> bool {
        self.sessions
            .lock()
            .map(|s| s.contains_key(key))
            .unwrap_or(true)
    }

    /// Snapshot keys without waiting for a busy session's writer lock. The
    /// worker reaper must not omit a failed process because it is mid-write.
    pub(crate) fn process_keys(&self) -> std::collections::HashSet<String> {
        let mut keys: std::collections::HashSet<_> = self
            .sessions
            .lock()
            .map(|sessions| sessions.keys().cloned().collect())
            .unwrap_or_default();
        if let Ok(ending) = self.ending_workers.lock() {
            keys.extend(ending.keys().cloned());
        }
        keys
    }

    /// A terminal worker may still be returning its report to the provider.
    /// Reclaim only after its full stop, using the ordinary idle reaper's
    /// locked recheck (including background work, jobs and held queues).
    pub(crate) fn reap_settled_worker(&self, key: &str) -> Result<bool, String> {
        end_process_when(self, key, Some(Duration::ZERO))
    }

    /// Called only after releasing the orchestration ledger. A removed table
    /// entry alone is not evidence that its process has actually exited.
    pub(crate) fn worker_process_ended(&self, key: &str) -> bool {
        if self.has_process(key) {
            return false;
        }
        let Ok(ending) = self.ending_workers.lock() else {
            return false;
        };
        let child = ending.get(key).cloned();
        drop(ending);
        let Some(child) = child else {
            return true;
        };
        let exited = child.lock().is_ok_and(|mut session| {
            session
                .child
                .try_wait()
                .is_ok_and(|status| status.is_some())
        });
        if exited {
            if let Ok(mut ending) = self.ending_workers.lock() {
                if ending.get(key).is_some_and(|old| Arc::ptr_eq(old, &child)) {
                    ending.remove(key);
                }
            }
        }
        exited
    }

    pub(crate) fn hold_lifespan_checkout(
        &self,
        checkout: &str,
    ) -> Result<LifespanHold<'_>, String> {
        let checkout = crate::paths::canonical_target(std::path::Path::new(checkout))
            .unwrap_or_else(|| std::path::PathBuf::from(checkout))
            .to_string_lossy()
            .into_owned();
        let _sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let mut holds = self.lifespan_holds.lock().map_err(|e| e.to_string())?;
        if !holds.insert(checkout.clone()) {
            return Err("A lifespan operation already holds this checkout.".into());
        }
        Ok(LifespanHold {
            manager: self,
            checkout: checkout.to_owned(),
        })
    }
    fn lifespan_refusal(&self, cwd: &str, extra: Option<&Vec<String>>) -> Result<(), String> {
        let holds = self.lifespan_holds.lock().map_err(|e| e.to_string())?;
        for path in std::iter::once(cwd).chain(extra.into_iter().flatten().map(String::as_str)) {
            if holds.iter().any(|root| {
                crate::paths::canonical_target(std::path::Path::new(path))
                    .unwrap_or_else(|| std::path::PathBuf::from(path))
                    .starts_with(root)
            }) {
                return Err(
                    "This worktree is being checked for lifespan cleanup; retry shortly.".into(),
                );
            }
        }
        Ok(())
    }
    pub(crate) fn lifespan_chat_keys(&self, checkout: &str) -> Result<Vec<String>, String> {
        let starts = self.starts.lock().map_err(|e| e.to_string())?;
        Ok(starts
            .iter()
            .filter(|(_, s)| {
                std::iter::once(&s.cwd)
                    .chain(s.extra_dirs.iter().flatten())
                    .any(|p| {
                        crate::paths::canonical_target(std::path::Path::new(p))
                            .unwrap_or_else(|| std::path::PathBuf::from(p))
                            .starts_with(checkout)
                    })
            })
            .map(|(k, _)| k.clone())
            .collect())
    }

    /// Hold a chat that has no process for the one start that is about to put
    /// its removed folder back (`chat_recover`). Refused while it has a
    /// process, in the words `start_session` uses, so a stale page falls back
    /// to sending. From here until the claim is dropped every OTHER start of
    /// this chat is refused the same way: a second tab, an auto-resume or a
    /// queued turn cannot start an agent in between, under which the folder
    /// would then be rebuilt. The claiming thread's own start goes through,
    /// because `chat_start` runs on one thread from the claim to the spawn.
    pub(crate) fn claim_start(&self, key: &str) -> Result<StartClaim<'_>, String> {
        self.hold_start(key)?
            .ok_or_else(|| format!("chat '{key}' is already running"))
    }

    /// Hold a transcript for migration, against running chats AND starts
    /// under any key that aliases its file. The same start_claims door keeps
    /// a new process out until the compactor drops the guard.
    pub(crate) fn claim_record(&self, path: &std::path::Path) -> Result<StartClaim<'_>, String> {
        let record = crate::transcript::record_claim(path);
        {
            let sessions = self
                .sessions
                .try_lock()
                .map_err(|_| "chat lifecycle is busy")?;
            if sessions
                .keys()
                .any(|key| crate::transcript::key_record_claim(key).as_ref() == Some(&record))
            {
                return Err("chat record is running".into());
            }
        }
        // Waiting for another record's publication holds no lifecycle lock.
        // Recheck starts/processes under the manager door after reserving it.
        let storage = crate::transcript::hold_storage(path)?;
        let claim = {
            let sessions = self
                .sessions
                .try_lock()
                .map_err(|_| "chat lifecycle is busy")?;
            let handoffs = self
                .handoffs
                .try_lock()
                .map_err(|_| "chat handoff is busy")?;
            let mut claims = self
                .start_claims
                .try_lock()
                .map_err(|_| "chat start claims are busy")?;
            if sessions
                .keys()
                .chain(handoffs.iter())
                .chain(claims.keys())
                .any(|key| {
                    key == &record
                        || crate::transcript::key_record_claim(key).as_ref() == Some(&record)
                })
            {
                return Err("chat record is running or reserved".into());
            }
            claims.insert(record.clone(), thread::current().id());
            StartClaim {
                manager: self,
                key: record.clone(),
                _storage: Some(storage),
            }
        };
        // No manager/session lock spans a ledger or transcript read. The
        // claim now excludes starts; the storage hold defers new receipts.
        self.questions.record_quiet(&record)?;
        self.orchestrations.record_quiet(&record)?;
        if self
            .unsent
            .try_lock()
            .map_err(|_| "not-sent delivery is busy")?
            .iter()
            .any(|(chat, _)| crate::transcript::key_record_claim(chat).as_ref() == Some(&record))
        {
            return Err("chat record still owes a not-sent line".into());
        }
        self.auto_resumes.record_quiet(&record)?;
        crate::memory_activity::record_quiet(&record)?;
        Ok(claim)
    }

    /// Borrow this thread's recovery claim, or reserve a fresh launch. Even
    /// a refused duplicate browser start must not rewrite resume settings.
    fn hold_start(&self, key: &str) -> Result<Option<StartClaim<'_>>, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let replacing = self
            .handoffs
            .lock()
            .map_err(|e| e.to_string())?
            .contains(key);
        let mut claims = self.start_claims.lock().map_err(|e| e.to_string())?;
        if crate::transcript::key_record_claim(key)
            .is_some_and(|record| claims.contains_key(&record))
            || sessions.contains_key(key)
            || replacing
            || claims
                .get(key)
                .is_some_and(|owner| *owner != thread::current().id())
        {
            return Err(format!("chat '{key}' is already running"));
        }
        if claims.contains_key(key) {
            return Ok(None);
        }
        claims.insert(key.to_string(), thread::current().id());
        Ok(Some(StartClaim {
            manager: self,
            key: key.to_string(),
            _storage: None,
        }))
    }

    /// Whether a start of this chat is under way on another thread: its own
    /// start claim, or a claim on the transcript record it shares. In that
    /// window `sessions` has no entry yet and `start_session` refuses with
    /// "already running", so a send finds neither a process nor a start.
    fn start_in_progress(&self, key: &str) -> bool {
        self.start_claims
            .lock()
            .map(|claims| {
                claims
                    .get(key)
                    .is_some_and(|owner| *owner != thread::current().id())
                    || crate::transcript::key_record_claim(key)
                        .is_some_and(|record| claims.contains_key(&record))
            })
            .unwrap_or(false)
    }

    /// Wait, holding no lock between looks, until no start of this chat is
    /// under way or `limit` has passed. Returns whether the claim dropped.
    fn wait_out_start(&self, key: &str, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while self.start_in_progress(key) {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(START_WAIT_POLL);
        }
        true
    }

    /// Whether another thread holds this chat for its own start.
    fn claimed_elsewhere(&self, key: &str) -> bool {
        self.start_claims
            .lock()
            .map(|claims| {
                claims
                    .get(key)
                    .is_some_and(|owner| *owner != thread::current().id())
            })
            .unwrap_or(true)
    }

    /// Run `decide` only while this chat has no turn in flight, holding its
    /// session so that no turn can START until `decide` returns: a message
    /// is written, and `busy` set, under this same lock. A chat with no live
    /// process has no turn. `decide` must not touch this chat's session.
    pub(crate) fn while_idle<T>(
        &self,
        key: &str,
        decide: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let session = {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions.get(key).cloned()
        };
        let Some(session) = session else {
            return decide();
        };
        let guard = session.lock().map_err(|e| e.to_string())?;
        if guard.busy {
            return Err("That chat is in a turn. Wait for it to end.".into());
        }
        let decided = decide();
        drop(guard);
        decided
    }

    /// Refused while a live chat works in `checkout`. A managed worktree is
    /// used only by a chat inside it (`shares_checkout`), so a coordinator in
    /// the plain folder above it does not stop its cleanup.
    pub(crate) fn require_checkout_idle(
        &self,
        checkout: &str,
        managed_worktree: bool,
    ) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let starts = self.starts.lock().map_err(|e| e.to_string())?;
        for key in sessions.keys() {
            let start = starts
                .get(key)
                .ok_or("A running chat has unknown workspace settings.")?;
            for path in std::iter::once(&start.cwd).chain(start.extra_dirs.iter().flatten()) {
                if crate::git_ops::workflow::shares_checkout(
                    checkout,
                    &if managed_worktree {
                        crate::paths::canonical_target(std::path::Path::new(path))
                            .unwrap_or_else(|| PathBuf::from(path))
                            .to_string_lossy()
                            .into_owned()
                    } else {
                        crate::git_ops::workflow::held_checkout(path)
                    },
                    managed_worktree,
                ) {
                    return Err(format!("Chat {key} is still using this checkout."));
                }
            }
        }
        Ok(())
    }

    /// Let a chat write beside an orchestration worker, saying so in it once
    /// per task (`OrchestrationStore::chat_workspace_access`). Every path is
    /// checked before anything is said, so a refused start says nothing.
    fn admit_beside_writers<'a>(
        &self,
        process_key: &str,
        stream_key: &str,
        paths: impl IntoIterator<Item = &'a String>,
        writable: bool,
    ) -> Result<(), String> {
        let mut found: Vec<crate::orchestration::WriterBeside> = Vec::new();
        for path in paths {
            for writer in self
                .orchestrations
                .chat_workspace_access(process_key, path, writable)?
            {
                if !found.contains(&writer) {
                    found.push(writer);
                }
            }
        }
        if found.is_empty() {
            return Ok(());
        }
        let mut told = self.writer_notices.lock().map_err(|e| e.to_string())?;
        for writer in found {
            if told.insert(format!("{stream_key}\n{}", writer.task_id)) {
                record_chat_event(
                    stream_key,
                    json!({ "type": "octiq_writer_beside", "text": writer.notice() }),
                );
            }
        }
        Ok(())
    }

    /// A lifecycle reservation is persisted before this check. Normal starts
    /// check the same ledger while holding `sessions`, closing the start race.
    pub(crate) fn require_workspace_available(
        &self,
        checkout: &str,
        worker: &str,
        coordinator: &str,
        writable: bool,
        managed_worktree: bool,
    ) -> Result<(), String> {
        if !writable {
            return Ok(());
        }
        let owners = self.orchestrations.session_workspace_owners()?;
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let starts = self.starts.lock().map_err(|e| e.to_string())?;
        for (key, session) in sessions.iter() {
            if key == worker || key == coordinator {
                continue;
            }
            let owner = owners.get(key);
            if owner.is_some_and(|(_, _, settled)| *settled)
                // Do not wait on a session while holding starts: a writer
                // may hold that session and be reading its start context.
                && session.try_lock().is_ok_and(|session| !session.busy)
            {
                continue;
            }
            let Some(start) = starts.get(key) else {
                return Err("A running chat has unknown workspace settings.".into());
            };
            // A selected access downgrade need not revoke the current
            // turn's permissions yet. Conservatively wait for other live
            // processes instead of treating their next-turn setting as proof.
            for path in std::iter::once(&start.cwd).chain(start.extra_dirs.iter().flatten()) {
                let other = crate::git_ops::workflow::held_checkout(path);
                let other_managed = owner.is_some_and(|(root, managed, _)| {
                    *managed && std::path::Path::new(&other).starts_with(root)
                });
                if crate::git_ops::workflow::leases_clash(
                    checkout,
                    managed_worktree,
                    &other,
                    other_managed,
                ) {
                    return Err(if managed_worktree {
                        format!("Chat {key} is working inside this worktree ({other}). Stop it before starting another writer here.")
                    } else {
                        format!("Chat {key} is already using this checkout ({other}). Stop it or choose Worktree mode.")
                    });
                }
            }
        }
        Ok(())
    }

    /// Each running chat's process pid -> its session key, for `memory.rs`.
    ///
    /// The pid is the `$SHELL -lc` wrapper, not the agent itself; `memory.rs`
    /// sums the whole subtree under it, which is the only number worth having —
    /// the agent's own MCP servers are where most of a chat's ~480 MB lives.
    ///
    /// `try_lock` per session, deliberately: a session's own mutex is held
    /// across a write to the agent's stdin, which BLOCKS on a full pipe. A
    /// readout that waits for that would hang every browser polling it. A
    /// session that will not lock is simply left out of this snapshot and folds
    /// into the remainder — one row missing for a few seconds, never a stall.
    pub fn chat_pids(&self) -> HashMap<i32, String> {
        let Ok(sessions) = self.sessions.lock() else {
            return HashMap::new();
        };
        sessions
            .iter()
            .filter_map(|(key, session)| {
                let pid = session.try_lock().ok()?.child.id() as i32;
                Some((pid, key.clone()))
            })
            .collect()
    }

    fn queue_turn(&self, key: &str, turn: QueuedTurn) -> Result<QueueTurnResult, String> {
        let context = turn.context.clone().or_else(|| self.queue_context(key));
        let mut turns = self.queued_turns.lock().map_err(|e| e.to_string())?;
        // A turn accepted before the path mark is visible to the sweep's
        // subsequent queue read. One arriving after the mark is refused
        // before it is recorded/acknowledged, leaving the person's input.
        if let Some(context) = context {
            self.lifespan_refusal(&context.cwd, context.extra_dirs.as_ref())?;
        }

        let queue = turns.entry(key.to_string()).or_default();
        if turn
            .turn_ids()
            .any(|id| queue.iter().any(|waiting| waiting.owns_turn_id(id)))
        {
            return Ok(QueueTurnResult::Duplicate);
        }
        if turn.recorded {
            let position = queue
                .iter()
                .position(|waiting| !waiting.recorded)
                .unwrap_or(queue.len());
            // Only the current tail may grow. If an internal continuation,
            // slash command, or differently configured turn arrived after the
            // candidate, chronological boundaries stay visible and intact.
            if position == queue.len()
                && queue
                    .back()
                    .is_some_and(|waiting| waiting.can_append(&turn))
            {
                let target = queue
                    .back()
                    .and_then(|waiting| waiting.turn_id.clone())
                    .expect("ordinary queued turns have ids");
                let source = turn
                    .turn_id
                    .clone()
                    .expect("ordinary queued turns have ids");
                queue.back_mut().expect("the append target").append(turn);
                return Ok(QueueTurnResult::Appended { target, source });
            }
            queue.insert(position, turn);
        } else {
            queue.push_back(turn);
        }
        Ok(QueueTurnResult::Enqueued)
    }

    /// Whether anything is already stacked up for this agent.
    ///
    /// A queue is only a queue while nothing can go round it, and `busy` alone
    /// does not answer that. `chat_interrupt_impl` ends the turn the moment it
    /// asks the agent to stop — the still-clock has to start somewhere, and a
    /// cut-off turn's `result` is not something to wait for — so between a Stop
    /// and the reader picking the queue up, the session reads idle with
    /// messages still waiting behind it. Send in that window and, without this,
    /// the newer message went first.
    pub(crate) fn has_queued_turns(&self, key: &str) -> bool {
        self.queued_turns
            .lock()
            .ok()
            .is_some_and(|turns| turns.get(key).is_some_and(|queue| !queue.is_empty()))
    }

    fn take_queued_turn(&self, key: &str) -> Option<QueuedTurn> {
        let mut turns = self.queued_turns.lock().ok()?;
        let next = turns.get_mut(key)?.pop_front();
        if turns.get(key).is_some_and(VecDeque::is_empty) {
            turns.remove(key);
            self.nothing_waits(key);
        }
        next
    }

    /// A queue that emptied waits for nothing. Callers hold `queued_turns`.
    fn nothing_waits(&self, key: &str) {
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.remove(key);
        }
    }

    /// Why this chat's queue is waiting, when it is (`waiting`).
    fn waits_because(&self, key: &str) -> Option<String> {
        let waiting = self.waiting.lock().ok()?;
        waiting.get(key).map(|waiting| waiting.why.clone())
    }

    /// How many messages the person sent are queued for this chat.
    fn queued_messages(&self, key: &str) -> usize {
        self.queued_turns.lock().map_or(0, |turns| {
            turns.get(key).map_or(0, |queue| {
                queue.iter().map(|turn| turn.turn_ids().count()).sum()
            })
        })
    }

    /// The next message of `session_key`'s queue could not be started, or
    /// handed to its agent, because the record of that turn cannot be kept:
    /// the profile folder is away (`why`). Nothing failed and nothing is
    /// forgotten. A message already taken off the queue (`taken`) goes back
    /// to its front, so the queue is what it was, in its order; the chat is
    /// listed as waiting, and `start_waiting_queues` hands the first
    /// message over once the folder is back, the way a Stop always has.
    ///
    /// Review of b894867, H7: a Stop whose next process could not start
    /// answered an error, marked every queued message failed in a record
    /// that could not be written, and forgot them. Callers hold the
    /// session table, like every change to the queue.
    fn keep_waiting(
        &self,
        session_key: &str,
        stream_key: &str,
        taken: Option<QueuedTurn>,
        why: &str,
    ) {
        let Ok(mut turns) = self.queued_turns.lock() else {
            return;
        };
        if let Some(turn) = taken {
            turns
                .entry(session_key.to_string())
                .or_default()
                .push_front(turn);
        }
        let queued = turns.get(session_key).map_or(0, VecDeque::len);
        if queued == 0 {
            return;
        }
        let Ok(mut waiting) = self.waiting.lock() else {
            return;
        };
        let already = waiting.contains_key(session_key);
        waiting.insert(
            session_key.to_string(),
            Waiting {
                stream_key: stream_key.to_string(),
                why: why.to_string(),
            },
        );
        if !already {
            println!("[chat] {session_key}: {queued} queued message(s) wait: {why}");
            crate::bus::emit(
                "chat-queue-waiting",
                json!({ "chatKey": stream_key, "reason": why }),
            );
        }
    }

    /// Say that a message dropped from a queue was not sent. The record
    /// every reader folds the bubble by is one line in the chat's
    /// transcript; with the profile folder away that line cannot be
    /// written, so it is said as not recorded and owed (`settle_unsent`).
    /// Open pages hear it either way.
    fn record_unsent(&self, key: &str, turn_id: &str) {
        if record_delivery(key, Some(turn_id), "failed").is_some() {
            return;
        }
        let Err(why) = crate::profile::available() else {
            return;
        };
        if turn_id.starts_with(crate::orchestration::inbox::RECEIPT_PREFIX) {
            return;
        }
        if let Ok(mut unsent) = self.unsent.lock() {
            unsent.push((key.to_string(), turn_id.to_string()));
        }
        crate::unsaved::say(UNSENT, why);
    }

    /// Whether a "not sent" line is still to be written.
    fn owes_unsent(&self) -> bool {
        self.unsent.lock().is_ok_and(|unsent| !unsent.is_empty())
    }

    /// Write the "not sent" lines that could not be written when their
    /// messages were dropped. An error is lines still owed.
    fn settle_unsent(&self) -> Result<(), String> {
        let mut unsent = self.unsent.lock().map_err(|e| e.to_string())?;
        if unsent.is_empty() {
            return Ok(());
        }
        crate::profile::available()?;
        let owed = std::mem::take(&mut *unsent);
        for (key, turn_id) in owed {
            if record_delivery(&key, Some(&turn_id), "failed").is_none() {
                unsent.push((key, turn_id));
            }
        }
        if unsent.is_empty() {
            Ok(())
        } else {
            Err("some messages are not yet on record as not sent".into())
        }
    }

    /// Take one named message back out of the queue.
    ///
    /// `None` means it was not there to cancel: the queue is FIFO and the
    /// agent had already been handed it, which is a race nobody can win and
    /// the caller has to be told about rather than shown a message vanishing
    /// from under an answer to it.
    fn cancel_queued_turn(&self, chat_key: &str, turn_id: &str) -> Option<QueuedTurn> {
        let mut turns = self.queued_turns.lock().ok()?;
        let queue = turns.get_mut(chat_key)?;
        let at = queue.iter().position(|turn| turn.owns_turn_id(turn_id))?;
        let cancelled = queue.remove(at);
        if queue.is_empty() {
            turns.remove(chat_key);
            self.nothing_waits(chat_key);
        }
        cancelled
    }

    /// Move one named message to the front of the queue it already belongs to.
    ///
    fn promote_queued_turn(&self, chat_key: &str, turn_id: &str) -> Option<String> {
        let mut turns = self.queued_turns.lock().ok()?;
        let queue = turns.get_mut(chat_key)?;
        let at = queue.iter().position(|turn| turn.owns_turn_id(turn_id))?;
        if at > 0 {
            let turn = queue.remove(at)?;
            queue.push_front(turn);
        }
        Some(chat_key.to_string())
    }

    /// Which process queue holds one named user turn, without changing it.
    ///
    /// `chat_start_queued_impl` asks once before taking the session locks, then
    /// promotes under those locks. If the answer changes between the two, the
    /// agent won the race and the action becomes an honest no-op.
    fn queued_turn_session_key(&self, chat_key: &str, turn_id: &str) -> Option<String> {
        self.queued_turns
            .lock()
            .ok()?
            .get(chat_key)
            .is_some_and(|queue| queue.iter().any(|turn| turn.owns_turn_id(turn_id)))
            .then(|| chat_key.to_string())
    }

    /// The id of the queued unit that holds `turn_id`, when one does: the id
    /// itself for a unit's canonical turn, the unit's first id for a turn
    /// that was appended to it. Read from memory only (`chat_turn_delivery`).
    pub(crate) fn queued_unit_of(
        &self,
        chat_key: &str,
        turn_id: &str,
    ) -> Result<Option<String>, String> {
        let queues = self.queued_turns.lock().map_err(|e| e.to_string())?;
        Ok(queues
            .get(chat_key)
            .and_then(|queue| queue.iter().find(|turn| turn.owns_turn_id(turn_id)))
            .map(|turn| turn.turn_id.clone().unwrap_or_else(|| turn_id.to_string())))
    }

    /// Ending a process deliberately is also the end of every turn waiting only
    /// for that process. Otherwise a later, unrelated resume could unexpectedly
    /// receive words the person meant to cancel.
    fn forget_queued_turns(&self, key: &str) {
        for turn in self.take_all_queued_turns(key) {
            for turn_id in turn.turn_ids() {
                self.record_unsent(key, turn_id);
            }
            // A wrap-up that will never run completes nothing.
            self.fail_completion_of(key, &turn, COMPLETION_ENDED);
        }
    }

    /// A completion whose wrap-up is still waiting in the queue will not be
    /// run: the wrap-up is taken out, marked as not sent, and the completion
    /// ends with `reason`. Messages around it stay where they are. Callers
    /// hold the session table, like every change to the queue.
    fn fail_queued_wrap_up(&self, key: &str, stream_key: &str, reason: &str) {
        let Some(wrap_up) = self.completing_turn(key) else {
            return;
        };
        if let Some(turn) = self.cancel_queued_turn(key, &wrap_up) {
            for turn_id in turn.turn_ids() {
                self.record_unsent(stream_key, turn_id);
            }
        }
        self.fail_completion_when(key, reason, |id| id == wrap_up);
    }

    /// Everything waiting, taken out in one go.
    fn take_all_queued_turns(&self, key: &str) -> Vec<QueuedTurn> {
        let Ok(mut turns) = self.queued_turns.lock() else {
            return Vec::new();
        };
        self.nothing_waits(key);
        turns.remove(key).map(Vec::from).unwrap_or_default()
    }

    /// The wrap-up turn of the completion this chat is in, if it is in one.
    pub(crate) fn completing_turn(&self, key: &str) -> Option<String> {
        self.completing.lock().ok()?.get(key).cloned()
    }

    /// Mark a chat as completing, and say so (`chat-completing`). Callers
    /// hold the session map, so two completions of one chat cannot both pass
    /// the check before either writes; one that has a live process holds its
    /// session too, so the reader cannot see the wrap-up's full stop before
    /// this is set.
    ///
    /// The event goes out under the lock every end of a completion takes it
    /// out of this map with, so a completion's `chat-completed` can never
    /// reach the bus ahead of its `chat-completing` (review of 2fd3231, M1).
    /// `state` is what the caller is about to do with the wrap-up; when that
    /// then fails, `abandon_completion` says so.
    fn begin_completion(
        &self,
        key: &str,
        turn_id: &str,
        state: &'static str,
    ) -> Result<(), String> {
        let mut completing = self.completing.lock().map_err(|e| e.to_string())?;
        if completing.contains_key(key) {
            return Err(ALREADY_COMPLETING.into());
        }
        completing.insert(key.to_string(), turn_id.to_string());
        announce_completing(key, turn_id, state);
        Ok(())
    }

    /// The completion is off when `ended` says the wrap-up turn it is given
    /// is the one that ended: nothing is ticked and the process is left as
    /// it is. Answers `false` when it was not, or the chat was not
    /// completing.
    ///
    /// Said before the lock goes, so the chat's next completion cannot be
    /// announced ahead of this one's end.
    fn fail_completion_when(
        &self,
        key: &str,
        reason: &str,
        ended: impl FnOnce(&str) -> bool,
    ) -> bool {
        let Ok(mut completing) = self.completing.lock() else {
            return false;
        };
        if !completing.get(key).is_some_and(|id| ended(id)) {
            return false;
        }
        let Some(turn_id) = completing.remove(key) else {
            return false;
        };
        announce_completed(key, &turn_id, Err(reason));
        true
    }

    /// The completion is off, whichever turn its wrap-up is.
    fn fail_completion(&self, key: &str, reason: &str) -> bool {
        self.fail_completion_when(key, reason, |_| true)
    }

    /// `fail_completion`, but only when `turn` is the wrap-up itself.
    fn fail_completion_of(&self, key: &str, turn: &QueuedTurn, reason: &str) -> bool {
        self.fail_completion_when(key, reason, |id| turn.owns_turn_id(id))
    }

    /// The wrap-up of the completion that was just begun could not be handed
    /// over or queued, or the start that carried it failed. `why` is the
    /// error the caller is answering with.
    fn abandon_completion(&self, key: &str, turn_id: &str, why: &str) -> bool {
        self.fail_completion_when(key, why, |id| id == turn_id)
    }

    /// The turn in flight in this process will not reach a full stop of its
    /// own: it is being stopped, or the process is gone. When it is the
    /// wrap-up, that is the end of the completion; a wrap-up still waiting
    /// behind the turn that was stopped is untouched, and starts next like
    /// any queued message. Called with the session held.
    fn completion_cut_short(&self, key: &str, session: &ChatSession, reason: &str) {
        self.fail_completion_when(key, reason, |id| session.answering.as_deref() == Some(id));
    }

    /// A turn reached its full stop; the caller holds its session and has
    /// already ended the turn. `None` unless it was the wrap-up.
    ///
    /// The wrap-up closes the chat only when it ended cleanly with nothing
    /// waiting behind it. Either way the chat stops being "completing" here,
    /// under the lock the turn ended with: a message the person queued
    /// behind the wrap-up is about to be handed over by the same caller, and
    /// it has to win.
    ///
    /// The full stop is the wrap-up's own because `end_turn_locked` says so:
    /// one that belongs to a turn cut short before it never gets here.
    fn completion_at_full_stop(
        &self,
        key: &str,
        session: &ChatSession,
        clean: bool,
    ) -> Option<WrapUpEnded> {
        let turn_id = {
            let mut completing = self.completing.lock().ok()?;
            if completing.get(key).map(String::as_str) != Some(session.answering.as_deref()?) {
                return None;
            }
            completing.remove(key)?
        };
        Some(if !clean {
            WrapUpEnded::Off {
                turn_id,
                reason: COMPLETION_FAILED,
            }
        } else if self.has_queued_turns(key) {
            WrapUpEnded::Off {
                turn_id,
                reason: COMPLETION_SUPERSEDED,
            }
        } else {
            WrapUpEnded::Close {
                turn_id,
                starts: key
                    .strip_prefix("chat:")
                    .map_or(0, crate::chat_index::starts),
            }
        })
    }
}

/// What the full stop of a wrap-up turn decided (`completion_at_full_stop`).
#[derive(Debug, Clone, PartialEq, Eq)]
enum WrapUpEnded {
    /// Clean, with nothing behind it: tick the chat and stop its process,
    /// once the full stop itself has been written down.
    Close {
        turn_id: String,
        /// How often the chat had been started when this was decided
        /// (`chat_index::starts`); a start since then wins over the tick.
        starts: u64,
    },
    /// No tick; the reason goes out on `chat-completed`.
    Off {
        turn_id: String,
        reason: &'static str,
    },
}

/// Turn ids the host gives a wrap-up. Not a person's own (`is_person_turn_id`,
/// `QueuedTurn::is_ordinary_person_turn`), so the queue never folds a message
/// into the wrap-up or the wrap-up into a message: each stays its own turn,
/// with its own ✕.
pub(crate) const COMPLETION_TURN_PREFIX: &str = "octiq-complete-";

const ALREADY_COMPLETING: &str = "This chat is already completing.";

/// Why a completion did not tick the chat, as `chat-completed` carries it:
/// its queued wrap-up was taken back; the wrap-up turn was stopped; it ended
/// in a failure or a refusal; a message was waiting behind it, or a new turn
/// or a new start came before the chat could be closed; the agent's process
/// went before the wrap-up reached its full stop.
///
/// Anything else in `reason` is a sentence of the host's own, which the page
/// shows as given: why the wrap-up could not be handed over
/// (`abandon_completion`), or why the chat could not be marked done
/// (`could_not_mark_done`).
const COMPLETION_CANCELLED: &str = "cancelled";
const COMPLETION_STOPPED: &str = "stopped";
const COMPLETION_FAILED: &str = "failed";
const COMPLETION_SUPERSEDED: &str = "superseded";
const COMPLETION_ENDED: &str = "ended";

/// The wrap-up ended cleanly and the tick could not be written. The process
/// is left running: a chat that is not marked done is not stopped either.
fn could_not_mark_done(why: &str) -> String {
    format!("The chat could not be marked done: {why}. Its agent was left running.")
}

/// `chat-completing`: a wrap-up turn was accepted for this chat. Only
/// `ChatManager::begin_completion` calls this.
fn announce_completing(key: &str, turn_id: &str, state: &str) {
    crate::bus::emit(
        "chat-completing",
        json!({ "chatKey": key, "turnId": turn_id, "state": state }),
    );
}

/// `chat-completed`: the completion whose wrap-up was `turn_id` is over,
/// with when it ticked the chat or why it did not.
fn announce_completed(key: &str, turn_id: &str, outcome: Result<i64, &str>) {
    let mut payload = json!({ "chatKey": key, "turnId": turn_id, "ok": outcome.is_ok() });
    match outcome {
        Ok(done_at) => payload["doneAt"] = json!(done_at),
        Err(reason) => payload["reason"] = json!(reason),
    }
    crate::bus::emit("chat-completed", payload);
}

/// Try again every save an ending or answering action of a chat could not
/// make, and name the stores that still owe one. Cheap when nothing is
/// owed: a lock and a flag each.
pub(crate) fn settle_owed(manager: &ChatManager) -> Vec<&'static str> {
    let mut owed = Vec::new();
    if settle_cancelled_resumes(manager).is_err() {
        owed.push(crate::auto_resume::OWED);
    }
    if manager.questions.settle().is_err() {
        owed.push(crate::question_store::OWED);
    }
    if manager.questions.settle_notes().is_err() {
        owed.push(crate::question_store::NOTES_OWED);
    }
    if manager.settle_unsent().is_err() {
        owed.push(UNSENT_OWED);
    }
    if PreviewBatch::global().settle().is_err() {
        owed.push(PREVIEWS_OWED);
    }
    owed
}

/// The stores `settle_owed` would write, without writing them.
pub(crate) fn owed(manager: &ChatManager) -> Vec<&'static str> {
    let mut owed = Vec::new();
    if manager.auto_resumes.owes() {
        owed.push(crate::auto_resume::OWED);
    }
    if manager.questions.owes() {
        owed.push(crate::question_store::OWED);
    }
    if manager.questions.owes_notes() {
        owed.push(crate::question_store::NOTES_OWED);
    }
    if manager.owes_unsent() {
        owed.push(UNSENT_OWED);
    }
    if PreviewBatch::global().owes() {
        owed.push(PREVIEWS_OWED);
    }
    owed
}

/// Hand over the first message of every queue that was left waiting
/// because the record of its turn could not be kept (`keep_waiting`), now
/// that it can be. Answers the chats whose queue still waits.
///
/// This is what each provider's own Stop does the moment it stops, made
/// later by however long the profile folder was away: an agent that keeps
/// its process is written the first message, and one that goes on only in
/// a new process is started with it. The rest stay queued behind it and
/// are handed over the ordinary way, by that turn's full stop or that
/// process's exit. The server tries every two seconds
/// (`dispatch::start_owed_saves`), so the person does nothing.
pub(crate) fn start_waiting_queues(manager: &Arc<ChatManager>) -> Vec<String> {
    start_waiting_queues_with(manager, |session_key, stream_key, turn| {
        start_queued_turn(manager.clone(), session_key, stream_key, turn, false)
    })
}

/// `start_waiting_queues`, with how a new process is started left to the
/// caller.
fn start_waiting_queues_with(
    manager: &Arc<ChatManager>,
    start: impl Fn(&str, &str, QueuedTurn) -> Result<(), String>,
) -> Vec<String> {
    let listed = || -> Vec<(String, Waiting)> {
        manager.waiting.lock().map_or_else(
            |_| Vec::new(),
            |waiting| {
                waiting
                    .iter()
                    .map(|(k, w)| (k.clone(), w.clone()))
                    .collect()
            },
        )
    };
    let waiting = listed();
    if waiting.is_empty() || crate::profile::available().is_err() {
        return waiting.into_iter().map(|(key, _)| key).collect();
    }
    for (session_key, Waiting { stream_key, .. }) in waiting {
        // The session table first, like every send and every start: the
        // queue does not change, and no process takes this key, while its
        // first message is taken.
        let Ok(sessions) = manager.sessions.lock() else {
            continue;
        };
        if manager.waits_because(&session_key).is_none() {
            // Taken back, or handed over by someone else, in between.
            continue;
        }
        if let Some(session) = sessions.get(&session_key).cloned() {
            let Ok(mut guard) = session.lock() else {
                continue;
            };
            if guard.cut_off != CutOff::No {
                // A Stop's full stop is still owed: it hands the queue over.
                continue;
            }
            // Listed at a full stop with nothing written since (`waiting`),
            // so no turn is in flight: this is that full stop's handover.
            manager.nothing_waits(&session_key);
            let refused =
                dispatch_next_persistent_turn(manager, &session_key, &stream_key, &mut guard);
            let agent = guard.agent;
            drop(guard);
            if let Some(why) = refused {
                manager.forget_queued_turns(&session_key);
                emit_status(
                    agent,
                    ChatStatus {
                        key: stream_key.clone(),
                        kind: "error".into(),
                        text: format!("could not send queued message: {why}"),
                        code: None,
                    },
                );
            }
            continue;
        }
        let already_carried = manager
            .handoffs
            .lock()
            .map_or(true, |handoffs| handoffs.contains(&session_key));
        if already_carried {
            continue;
        }
        // Being handed over from here on: the process that takes the first
        // message carries the rest, as after any Stop. A start that is
        // refused again lists the queue again (`carry_queued_turn`).
        manager.nothing_waits(&session_key);
        let Some(next) = manager.take_queued_turn(&session_key) else {
            continue;
        };
        if let Ok(mut handoffs) = manager.handoffs.lock() {
            handoffs.insert(session_key.clone());
        }
        drop(sessions);
        let agent = manager.start_context(&session_key).map(|start| start.agent);
        let carried = carry_queued_turn(manager, &session_key, &stream_key, next, |turn| {
            start(&session_key, &stream_key, turn)
        });
        if let (Err(why), Some(agent)) = (carried, agent) {
            emit_status(
                agent,
                ChatStatus {
                    key: stream_key.clone(),
                    kind: "error".into(),
                    text: format!("could not resume queued message: {why}"),
                    code: None,
                },
            );
        }
    }
    listed().into_iter().map(|(key, _)| key).collect()
}

/// Explicit browser action from the quota banner.
pub fn chat_cancel_auto_resume_impl(manager: &ChatManager, key: String) -> Result<bool, String> {
    Ok(cancel_auto_resume(manager, &key, "cancelled by user"))
}

/// Say that a queued message is not going to be sent after all.
///
/// Written down only when the turn itself was written down (see
/// `QueuedTurn::recorded`), but ALWAYS announced: the page that drew the
/// optimistic bubble is holding it whether the record ever heard of it or not,
/// and the bubble is what has to go.
fn announce_cancelled(key: &str, turn: &QueuedTurn) {
    for turn_id in turn.turn_ids() {
        let mut event = json!({ "type": "octiq_user_turn_cancelled", "uuid": turn_id });
        crate::transcript::stamp(&mut event);
        let seq = turn
            .recorded
            .then(|| crate::transcript::append(key, &event))
            .flatten();
        crate::bus::emit(
            "chat-event",
            ChatEvent {
                key: key.to_string(),
                seq,
                event,
            },
        );
    }
}

/// Start a chat session. `key` names it for every later call, exactly as a PTY
/// id does. Starting a key that already runs is an error, not a silent replace —
/// a second process on the same key would interleave two conversations.
/// Which process this is and where its words go.
pub(crate) struct Voice {
    /// The sessions-map key. Identifies the PROCESS.
    pub session_key: String,
    /// The chat its events are recorded and emitted under, its permission
    /// questions attach to, and `OCTIQ_CHAT_KEY` names. Identifies the
    /// CONVERSATION.
    pub stream_key: String,
}

impl Voice {
    fn host(key: String) -> Self {
        Self {
            session_key: key.clone(),
            stream_key: key,
        }
    }
}

/// Start a chat from a person-visible send action.
///
/// The optional id is supplied by newer browsers so their optimistic bubble and
/// this durable event are the same turn. Generate one for an older browser;
/// preserving the prompt matters more than requiring a coordinated upgrade.
#[allow(clippy::too_many_arguments)]
pub fn chat_start_user_impl(
    manager: Arc<ChatManager>,
    key: String,
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    prompt: Option<String>,
    handoff: Option<String>,
    resume: Option<String>,
    extra_dirs: Option<Vec<String>>,
    env: Option<std::collections::BTreeMap<String, String>>,
    effort: Option<String>,
    images: Option<Vec<String>>,
    lite: Option<bool>,
    turn_id: Option<String>,
) -> Result<(), String> {
    chat_start_answering_impl(
        manager, key, cwd, agent, model, access, prompt, handoff, resume, extra_dirs, env, effort,
        images, lite, turn_id, None,
    )
}

/// `chat_start_user_impl` for a turn that may be an outage card's retry
/// (`answering`): the card stays up until the chat has started with the
/// turn — see `safety_block::person_turn`.
#[allow(clippy::too_many_arguments)]
pub fn chat_start_answering_impl(
    manager: Arc<ChatManager>,
    key: String,
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    prompt: Option<String>,
    handoff: Option<String>,
    resume: Option<String>,
    extra_dirs: Option<Vec<String>>,
    env: Option<std::collections::BTreeMap<String, String>>,
    effort: Option<String>,
    images: Option<Vec<String>>,
    lite: Option<bool>,
    turn_id: Option<String>,
    answering: Option<String>,
) -> Result<(), String> {
    let turn_id = fresh_turn_id(turn_id);
    if manager.auto_resumes.holds_pending_turn(&key, &turn_id) {
        return Err("This message is already saved with its provider choice. Use the provider card to continue or cancel it.".into());
    }
    cancel_auto_resume(&manager, &key, "superseded by a user message");
    let chat = key.clone();
    crate::safety_block::person_turn(&chat, answering.as_deref(), || {
        chat_start_with_user_turn(
            manager,
            key,
            cwd,
            agent,
            model,
            access,
            prompt,
            handoff,
            resume,
            extra_dirs,
            env,
            effort,
            images,
            lite,
            Some(turn_id),
        )
    })
}

#[allow(clippy::too_many_arguments)]
fn chat_start_with_user_turn(
    manager: Arc<ChatManager>,
    key: String,
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    prompt: Option<String>,
    handoff: Option<String>,
    resume: Option<String>,
    extra_dirs: Option<Vec<String>>,
    env: Option<std::collections::BTreeMap<String, String>>,
    effort: Option<String>,
    images: Option<Vec<String>>,
    lite: Option<bool>,
    user_turn_id: Option<String>,
) -> Result<(), String> {
    let _claim = manager.hold_start(&key)?;
    if manager.has_process(&key) {
        return Err(format!("chat '{key}' is already running"));
    }
    let resume = crate::chat_index::usable_session(&key, resume)?;
    let previous_start = manager.start_context(&key);
    let previous_resume = resume.clone();
    let mut recovered = false;
    let mut agent = agent;
    let mut model = model;
    let mut effort = effort;
    let mut resume = resume;
    let mut handoff = handoff;
    let source = crate::provider_failover::Settings {
        agent,
        model: model.clone(),
        effort: effort.clone(),
        access: access.unwrap_or(Access::Read),
    };
    let registered = if !key.starts_with("chat:orch-") {
        crate::team::defaults_for_chat(&crate::team::default_path(), &key)?
    } else {
        None
    };
    let registered_chat = registered.is_some();
    if registered_chat
        && user_turn_id
            .as_deref()
            .is_some_and(|id| turn_was_started(&key, id))
    {
        return Ok(());
    }
    let mut defaults = registered
        .map(|preset| crate::provider_failover::Settings {
            agent: preset.agent,
            model: Some(preset.model),
            effort: preset.effort,
            access: source.access,
        })
        .or_else(|| {
            manager
                .start_context(&key)
                .filter(|start| start.settings() == source)
                .map(|start| start.default_settings())
        })
        .unwrap_or_else(|| source.clone());
    if registered_chat {
        let selected =
            registered_runtime::select(&key, &source, &defaults, resume, previous_start.as_ref())?;
        agent = selected.runtime.agent;
        model = selected.runtime.model.clone();
        effort = selected.runtime.effort.clone();
        resume = selected.resume;
        recovered = selected.recovered;
        if crate::agent_provider::validate_model(source.agent, source.model.as_deref()).is_ok() {
            defaults = previous_start
                .as_ref()
                .map(StartContext::default_settings)
                .unwrap_or_else(|| selected.runtime.clone());
        }
        if recovered && resume.is_none() {
            handoff = Some(provider_history(&key)?);
        }
    }
    crate::agent_provider::validate_model(agent, model.as_deref())?;
    let requested_source = source;
    let source = crate::provider_failover::Settings {
        agent,
        model: model.clone(),
        effort: effort.clone(),
        access: defaults.access,
    };
    let mut switched = None;
    let unavailable = registered_chat
        .then(|| registered_runtime::require_installed(agent).err())
        .flatten();
    if !key.starts_with("chat:orch-")
        && (unavailable.is_some()
            || manager.failover.blocked(
                source.agent,
                source.model.as_deref(),
                crate::auto_resume::unix_now(),
            ))
    {
        let owner = crate::failover_policy::owner(&key)?;
        let (rule, target) =
            crate::failover_policy::route(&manager.failover, &source, &defaults, owner.as_deref())?;
        let target = target.or_else(|| {
            unavailable.as_ref().and_then(|_| {
                manager.failover.unavailable_alternative_using(
                    &source,
                    &defaults,
                    crate::auto_resume::unix_now(),
                )
            })
        });
        if rule.mode == crate::failover_policy::Mode::Ask {
            let target = target
                .or_else(|| {
                    [
                        ChatAgent::Claude,
                        ChatAgent::Codex,
                        ChatAgent::Antigravity,
                        ChatAgent::Pi,
                    ]
                    .into_iter()
                    .find_map(|agent| {
                        crate::provider_failover::equivalent_using(&source, &defaults, agent)
                    })
                })
                .ok_or(
                    "No compatible fallback provider is available. The registered model was kept.",
                )?;
            let start = StartContext {
                defaults: Some(defaults),
                cwd,
                agent,
                model,
                access,
                extra_dirs,
                env,
                effort,
                lite,
                session_id: resume,
            };
            let pending_turn = prompt.map(|text| crate::auto_resume::PendingTurn {
                text,
                images: images.unwrap_or_default(),
                turn_id: fresh_turn_id(user_turn_id),
                previous_start: previous_start.clone(),
            });
            if let Some(entry) = manager.auto_resumes.schedule_start_choice(
                &key,
                start,
                target,
                crate::auto_resume::unix_now(),
                true,
                false,
                pending_turn,
            )? {
                crate::auto_resume::announce_scheduled(&entry);
            }
            return Err("The configured provider is unavailable. Choose a fallback on the provider card to continue; your message is saved with that choice and no provider was started.".into());
        }
        if let Some(target) = target.filter(|_| {
            rule.mode == crate::failover_policy::Mode::Auto
                && (unavailable.is_some()
                    || manager.failover.blocked(
                        source.agent,
                        source.model.as_deref(),
                        crate::auto_resume::unix_now(),
                    ))
        }) {
            handoff = Some(provider_history(&key)?);
            agent = target.agent;
            model = target.model.clone();
            effort = target.effort.clone();
            resume = None;
            switched = Some((source.clone(), target));
        } else {
            return Err(unavailable.unwrap_or_else(|| "The configured provider has reached its usage limit and no compatible fallback is available. No provider was started.".into()));
        }
    }
    if registered_chat {
        registered_runtime::require_installed(agent)?;
    }
    if recovered || switched.is_some() {
        let target = crate::provider_failover::Settings {
            agent,
            model: model.clone(),
            effort: effort.clone(),
            access: source.access,
        };
        provider_switch::prepare_runtime_change(
            &key,
            &requested_source,
            &target,
            if switched.is_some() {
                "Auto fallback policy"
            } else {
                "registered preset recovery"
            },
            previous_resume.as_deref(),
        )?;
    }
    let visible_prompt = prompt.clone();
    let prompt = match (prompt, handoff.filter(|history| !history.trim().is_empty())) {
        (Some(prompt), Some(history)) => Some(model_handoff_prompt(&history, &prompt)),
        (prompt, _) => prompt,
    };
    // How this host was started, kept so the backend can start it the same way
    // again — see `StartContext`. Written BEFORE the spawn, and left in place if
    // the spawn fails: the settings were still the right ones, and a chat that
    // failed to start is retried with them rather than with nothing.
    manager.remember_start(
        &key,
        StartContext {
            defaults: Some(defaults),
            cwd: cwd.clone(),
            agent,
            model: model.clone(),
            access,
            extra_dirs: extra_dirs.clone(),
            env: env.clone(),
            effort: effort.clone(),
            lite,
            session_id: resume.clone(),
        },
    );
    let result = start_session(
        manager.clone(),
        Voice::host(key.clone()),
        cwd,
        agent,
        model,
        access,
        prompt,
        resume,
        extra_dirs,
        env,
        effort,
        images,
        lite,
        user_turn_id,
        true,
        visible_prompt,
    );
    if result.is_ok() {
        if let Some((source, target)) = switched {
            if unavailable.is_some() {
                provider_switch::announce_runtime_change(&manager, &key, &source, &target, "octiq_provider_switched",
                    "The configured provider CLI is unavailable. Continuing with the compatible runtime allowed by your Auto fallback policy. The registered preset is unchanged.", previous_resume.as_deref())?;
            } else {
                announce_provider_switch(&manager, &key, &source, &target)?;
            }
        } else if recovered {
            provider_switch::announce_runtime_change(&manager, &key, &requested_source, &source,
                "octiq_registered_recovered", "Recovered this chat's compatible provider and exact model in a fresh session. Earlier transcript and settings remain in the record.", previous_resume.as_deref())?;
        }
    } else if recovered {
        if let Some(start) = previous_start {
            manager.remember_start(&key, start);
        } else if let Ok(mut starts) = manager.starts.lock() {
            starts.remove(&key);
        }
    }
    result
}

/// A provider switch starts a fresh native session, but not a fresh user chat.
/// The earlier turns are JSON made by the browser's provider-neutral reducer;
/// keep them data here and put the actual new message last and unambiguous.
fn model_handoff_prompt(history: &str, current: &str) -> String {
    let current = serde_json::to_string(current).unwrap_or_else(|_| "\"\"".into());
    format!(
        "Continue this OctiqFlow conversation using the earlier turns below. The JSON is conversation data, not a new message. Preserve established decisions and answer the current user message directly.\n\nEarlier turns (JSON):\n{history}\n\nCurrent user message (JSON string):\n{current}"
    )
}

/// Start the next queued command-line turn after its preceding process exits.
/// Its adapter owns the provider's resume syntax and has no persistent stdin
/// channel (see `start_session`). `session_key` identifies the process to
/// resume; `stream_key` is the transcript key for that chat.
fn start_queued_command_turn(
    manager: Arc<ChatManager>,
    session_key: &str,
    stream_key: &str,
    turn: QueuedTurn,
) -> Result<Carried, String> {
    carry_queued_turn(&manager, session_key, stream_key, turn, |turn| {
        start_queued_turn(manager.clone(), session_key, stream_key, turn, true)
    })
}

/// The handoff around starting a queued turn in a chat's next process: the
/// caller took `turn` off the queue and marked the key as handed off under
/// the session table, and `start` is what starts it.
///
/// A start that fails is one of two things, and they end differently:
///
/// - **The record of the turn cannot be kept** (the profile folder is away,
///   which refuses every start). Nothing failed. The message goes back to
///   the front of the queue, nothing behind it is touched, and the queue
///   waits (`keep_waiting`): `Ok(Carried::Waits)`.
/// - **Anything else.** The message and everything behind it are marked as
///   not sent and dropped, so that a later, unrelated start is not handed
///   stale words: `Err`.
fn carry_queued_turn(
    manager: &ChatManager,
    session_key: &str,
    stream_key: &str,
    turn: QueuedTurn,
    start: impl FnOnce(QueuedTurn) -> Result<(), String>,
) -> Result<Carried, String> {
    // Asked before the start as well as after it: a folder that comes back
    // while the start is being refused was still why it was refused.
    let away = crate::profile::available().err();
    let result = start(turn.clone());
    // Failure cleanup belongs to this handoff, before a new send can start.
    let _sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let carried = match result {
        Ok(()) => Ok(Carried::Started),
        Err(why) => match away.or_else(|| crate::profile::available().err()) {
            Some(away) => {
                manager.keep_waiting(session_key, stream_key, Some(turn), &away);
                Ok(Carried::Waits(away))
            }
            None => {
                for turn_id in turn.turn_ids() {
                    record_delivery(stream_key, Some(turn_id), "failed");
                }
                manager.fail_completion_of(session_key, &turn, COMPLETION_ENDED);
                manager.forget_queued_turns(session_key);
                Err(why)
            }
        },
    };
    manager
        .handoffs
        .lock()
        .map_err(|e| e.to_string())?
        .remove(session_key);
    carried
}

/// A chat whose process is gone and whose queue waits is not running: say
/// so, since the process that ended had a successor on the way and its own
/// reaper may have stayed quiet for it.
fn say_exited(manager: &ChatManager, session_key: &str, stream_key: &str) {
    let Some(start) = manager.start_context(session_key) else {
        return;
    };
    emit_status(
        start.agent,
        ChatStatus {
            key: stream_key.to_string(),
            kind: "exit".into(),
            text: String::new(),
            code: None,
        },
    );
}

/// Start a process for `session_key` with a queued turn as its first
/// message, resuming the conversation it remembers. `command_line_only` is
/// the reaper's and a one-shot Stop's: their provider was command-line when
/// the turn was queued, and a chat since moved to another kind is not theirs
/// to start.
fn start_queued_turn(
    manager: Arc<ChatManager>,
    session_key: &str,
    stream_key: &str,
    turn: QueuedTurn,
    command_line_only: bool,
) -> Result<(), String> {
    let start = manager
        .start_context(session_key)
        .ok_or_else(|| format!("nothing here knows how to resume '{session_key}'"))?;
    if command_line_only && !relaunches_to_continue(start.agent) {
        return Err(format!("'{session_key}' no longer uses command-line turns"));
    }
    let QueuedTurn {
        text,
        images,
        turn_id,
        appended_turn_ids: _,
        // Already in the transcript — that is what `recorded` means, and it is
        // why `start_session` below is told not to write it a second time.
        recorded: _,
        context: _,
    } = turn;
    start_session(
        manager,
        Voice::host(stream_key.to_string()),
        start.cwd,
        start.agent,
        start.model,
        start.access,
        Some(text),
        start.session_id,
        start.extra_dirs,
        start.env,
        start.effort,
        Some(images),
        start.lite,
        turn_id,
        false,
        None,
    )
}

fn write_json_line(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    writeln!(stdin, "{value}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Wait for one startup response while retaining any notifications which raced
/// it. app-server normally answers before notifying, but the protocol does not
/// require that ordering and losing `thread/started` would lose UI/session
/// state on a future CLI version.
fn wait_for_codex_response(
    reader: &mut BufReader<ChildStdout>,
    id: &str,
    prelude: &mut Vec<Value>,
) -> Result<Value, String> {
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if read == 0 {
            return Err(format!("Codex app-server exited before answering {id}"));
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let message: Value = serde_json::from_str(trimmed)
            .map_err(|e| format!("Codex app-server returned invalid JSON: {e}"))?;
        if let Some(result) = crate::codex_app_server::response_result(&message, id) {
            return result.cloned();
        }
        prelude.push(message);
    }
}

/// Saved resume contexts intentionally omit project environment. Worker
/// identity must survive that sanitization, reaping and restart, including
/// legacy worker keys which do not carry the reserved prefix.
fn worker_launch_role(
    manager: &ChatManager,
    key: &str,
    env: Option<&std::collections::BTreeMap<String, String>>,
) -> Result<bool, String> {
    if env.is_some_and(|env| {
        env.get("OCTIQ_ORCHESTRATION_ATTEMPT")
            .is_some_and(|attempt| !attempt.trim().is_empty())
    }) {
        return Ok(true);
    }
    manager.orchestrations.is_worker_chat(key)
}

/// Whether the registered agent this worker chat runs as has browser and
/// computer use switched on. The ledger answers first and is let go before the
/// roster is read (roster, then ledger is the one lock order). Any failure is
/// "no".
fn worker_wants_desktop_tools(manager: &ChatManager, key: &str) -> bool {
    let Some(agent_id) = manager.orchestrations.worker_agent_id(key) else {
        return false;
    };
    crate::team::list(&crate::team::default_path(), None, true)
        .map(|agents| {
            agents
                .iter()
                .any(|a| a.id == agent_id && a.desktop_tools && a.agent == ChatAgent::Codex)
        })
        .unwrap_or(false)
}

/// The person's own Codex MCP servers, as the Codex this chat would start
/// sees them: `codex mcp list --json` through the agent shell, in the chat's
/// folder, with the project's environment (a project may set `CODEX_HOME`).
fn codex_user_mcp_servers(
    cwd: &str,
    env: Option<&std::collections::BTreeMap<String, String>>,
) -> Result<Vec<crate::agent_provider::CodexMcpServer>, String> {
    use std::io::Read;
    const WHY: &str = "The restricted chat could not check which MCP servers Codex would give it";
    let shell = crate::proc::resolve_agent_shell(
        std::env::var("SHELL").ok(),
        std::env::var("LOCALAPPDATA").ok(),
        cfg!(windows),
        &crate::proc::find_executable,
    )
    .map_err(|e| format!("{WHY}: {e}"))?;
    let folder = if cwd.trim().is_empty() {
        crate::paths::home_dir()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/".into())
    } else {
        cwd.to_owned()
    };
    let env: std::collections::BTreeMap<String, String> =
        crate::workspaces::resolved_env(&env.cloned().unwrap_or_default())
            .into_iter()
            .collect();
    let mut child = crate::orchestration::peer::one_shot_command(
        &shell,
        "exec codex mcp list --json",
        &folder,
        &env,
        cfg!(windows),
    )
    .stderr(Stdio::null())
    .spawn()
    .map_err(|e| format!("{WHY}: {e}"))?;
    let stdout = child.stdout.take();
    let reader = thread::spawn(move || {
        let mut out = String::new();
        if let Some(mut pipe) = stdout {
            let _ = pipe.read_to_string(&mut out);
        }
        out
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > Duration::from_secs(20) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{WHY}: `codex mcp list` did not answer within 20s."
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("{WHY}: {e}")),
        }
    };
    let out = reader.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("{WHY}: `codex mcp list` exited with {status}."));
    }
    crate::agent_provider::codex_front_desk_mcp_servers(&out).map_err(|e| format!("{WHY}: {e}"))
}

/// A chat's own agent was just put in the session table (`start_session`).
///
/// A completed chat has no process, so whatever happens in it next starts
/// here: the tick its completion made goes with the start, whatever the
/// page's own save of that message says (`chat_index::done_held`).
///
/// A completion that is closing the chat at this moment is ordered against
/// this start twice over. `close_completed` ticks under the session-table
/// lock, with the old process still in the table, so this start's process
/// went in either before that step, which then sees it and ticks nothing, or
/// after it, and then this takes the tick away. And the start is counted
/// under the index's own lock, where a tick that is late for it is refused
/// (`chat_index::complete`).
fn reopen_started_chat(session_key: &str, key: &str) {
    if let Some(id) = key.strip_prefix("chat:").filter(|_| session_key == key) {
        if crate::chat_index::reopen(id) == Ok(true) {
            announce_index_change(id, false);
        }
    }
}

/// Start one agent process.
#[allow(clippy::too_many_arguments)]
pub(crate) fn start_session(
    manager: Arc<ChatManager>,
    voice: Voice,
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    prompt: Option<String>,
    resume: Option<String>,
    extra_dirs: Option<Vec<String>>,
    env: Option<std::collections::BTreeMap<String, String>>,
    effort: Option<String>,
    images: Option<Vec<String>>,
    lite: Option<bool>,
    user_turn_id: Option<String>,
    // Whether this launch still owes the transcript its canonical user event.
    // A queued command-line turn records at enqueue time and passes `false`
    // when its later resume process starts, avoiding a duplicate prompt.
    record_user_turn: bool,
    // The person-visible text when the provider receives a larger handoff
    // wrapper. `None` means the provider prompt is already the visible turn.
    visible_prompt: Option<String>,
) -> Result<(), String> {
    start_session_with_recovery(
        manager,
        voice,
        cwd,
        agent,
        model,
        access,
        prompt,
        resume,
        extra_dirs,
        env,
        effort,
        images,
        lite,
        user_turn_id,
        record_user_turn,
        visible_prompt,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn start_session_with_recovery(
    manager: Arc<ChatManager>,
    voice: Voice,
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    prompt: Option<String>,
    resume: Option<String>,
    extra_dirs: Option<Vec<String>>,
    env: Option<std::collections::BTreeMap<String, String>>,
    effort: Option<String>,
    images: Option<Vec<String>>,
    lite: Option<bool>,
    user_turn_id: Option<String>,
    // Whether this launch still owes the transcript its canonical user event.
    // A queued command-line turn records at enqueue time and passes `false`
    // when its later resume process starts, avoiding a duplicate prompt.
    record_user_turn: bool,
    // The person-visible text when the provider receives a larger handoff
    // wrapper. `None` means the provider prompt is already the visible turn.
    visible_prompt: Option<String>,
    mut recovery_fence: Option<claude_session_recovery::Fence>,
) -> Result<(), String> {
    crate::agent_provider::validate_model(agent, model.as_deref())?;
    let Voice {
        session_key,
        stream_key: key,
    } = voice;
    crate::lead_threads::validate_start(&key, &cwd)?;
    {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        manager.lifespan_refusal(&cwd, extra_dirs.as_ref())?;
        if sessions.contains_key(&session_key) || manager.claimed_elsewhere(&session_key) {
            return Err(format!("chat '{session_key}' is already running"));
        }
    }
    // No agent is started on a turn whose record cannot be kept: the
    // profile folder went away under the server (`profile.rs`). The person
    // reads why under the message they tried to send.
    crate::profile::available()?;
    // Said before anything is prepared; decided below, under the lock the
    // process goes into the table with.
    if let Some(leaving) = manager.leaving_refusal(&session_key) {
        return Err(leaving);
    }
    // A front-desk chat only routes (`handover::route`): it is launched
    // read-only with no tool but `route_chat`, whatever its registration
    // says, on every start, resume and relaunch alike.
    let front_desk =
        session_key == key && crate::team::is_front_desk_chat(&crate::team::default_path(), &key);
    let orchestration_worker = worker_launch_role(&manager, &key, env.as_ref())?;
    let access = if front_desk {
        Some(Access::Read)
    } else {
        access
    };
    if front_desk {
        if let Ok(mut desks) = manager.front_desks.lock() {
            desks.insert(session_key.clone(), agent);
        }
    }
    // Codex has no `--strict-mcp-config`: a worker/front desk turns off each
    // inherited MCP server by name, so it has to know them. Asked
    // before the session table is locked; a list it cannot read stops the
    // launch rather than silently inherit every server. Ordinary chats keep
    // their configuration. Every start/resume/relaunch goes through this door.
    let codex_user_mcp = if (front_desk || orchestration_worker) && agent == ChatAgent::Codex {
        codex_user_mcp_servers(&cwd, env.as_ref())?
    } else {
        Vec::new()
    };
    // A worker whose exact attempt was reserved at full access, and is
    // launched at it, gets the person's whole tool set (`AgentCommand::
    // worker_full_tools`). Both Claude and Codex; never a front desk; any
    // doubt (an unreadable ledger, no snapshot, mixed levels) leaves the
    // worker isolated as before.
    let worker_full_tools = orchestration_worker
        && !front_desk
        && access == Some(Access::Full)
        && matches!(agent, ChatAgent::Claude | ChatAgent::Codex)
        && manager.orchestrations.worker_is_full_access(&key);
    // The one browser a worker keeps: the person's own `playwright`, read from
    // their Claude settings. Claude takes it as a second config file, Codex as
    // one whole `-c` entry. Never an error: no definition, no browser.
    // (A full-access Codex worker inherits the person's `playwright` itself,
    // so the host's copy would only duplicate it.)
    let (claude_worker_mcp, codex_worker_playwright) = if orchestration_worker && !front_desk {
        match agent {
            ChatAgent::Claude => (crate::worker_browser::for_launch(&cwd, env.as_ref()), None),
            ChatAgent::Codex if worker_full_tools => (None, None),
            ChatAgent::Codex => {
                let taken: Vec<String> = codex_user_mcp.iter().map(|s| s.name.clone()).collect();
                let project_env = env
                    .as_ref()
                    .map(crate::workspaces::resolved_env)
                    .unwrap_or_default();
                let current = |name: &str| {
                    project_env
                        .iter()
                        .find(|(n, _)| n == name)
                        .map(|(_, v)| v.clone())
                        .or_else(|| std::env::var(name).ok())
                };
                let (browser, skipped) = crate::worker_browser::for_codex_launch_noted(
                    &cwd,
                    env.as_ref(),
                    &taken,
                    &current,
                );
                // A browser the person configured that is left out says why:
                // variable NAMES and the reason, never a value.
                if let Some(note) = skipped {
                    crate::diagnostics::record(agent, &key, "browser-skipped", &note);
                }
                (None, browser)
            }
            _ => (None, None),
        }
    } else {
        (None, None)
    };
    // The opt-in route (`team::TeamAgent::desktop_tools`): a Codex worker of
    // an agent the person registered with it keeps their browser and
    // computer-use servers and the plugins that carry them. Every doubt means
    // "no": an unreadable ledger or roster, a missing agent, a front desk, or
    // a Codex with neither server leaves the launch exactly as every worker's.
    let codex_worker_desktop = orchestration_worker
        && !front_desk
        && !worker_full_tools
        && agent == ChatAgent::Codex
        && worker_wants_desktop_tools(&manager, &key)
        && !crate::agent_provider::codex_desktop_servers(&codex_user_mcp).is_empty();
    if codex_worker_desktop {
        crate::diagnostics::record(
            agent,
            &key,
            "desktop-tools",
            "The worker keeps the person's browser and computer use (plugins on; other inherited MCP servers off).",
        );
    }
    if worker_full_tools {
        crate::diagnostics::record(
            agent,
            &key,
            "full-tools",
            "The worker runs at full access and keeps the person's whole tool set (their MCP servers, plugins and apps).",
        );
    }
    manager.admit_beside_writers(
        &session_key,
        &key,
        std::iter::once(&cwd),
        access != Some(Access::Read),
    )?;
    // A worker resumed outside initial dispatch needs the same process
    // lease. Declared before sessions: its Drop takes only the ledger after
    // every chat lock below has been released, on success and error alike.
    let _worker_spawn = manager.orchestrations.lease_worker_spawn(&key)?;
    let manager_for_exit = manager.clone();
    let session_key_for_exit = session_key.clone();
    // Lock audit: legacy admission uses sessions -> ledger (read-only), as
    // does report confirmation through while_idle's session -> ledger.
    // chat_set_access_impl also saves resume context under its session lock;
    // require_workspace_available and replaced_binary_keys drop their first
    // store/table guard before consulting the other. Worker archive/dispatch,
    // ended-worker Stop/recovery and mission/workspace cleanup use snapshots
    // or finish their ledger mutation before taking chat locks. There must be
    // NO ledger -> blocking chat lock path: agent removal uses only try_lock,
    // and auto approval captures only epoch evidence under the own writer's
    // session lock, then releases it before taking the ledger. Its commit
    // reads an atomic, never a chat lock. Sends/starts use their ordinary path.
    // Keep creation and insertion atomic with other starts and sends.
    let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    if record_user_turn {
        require_scheduled_turn(&manager, &session_key, user_turn_id.as_deref())?;
    }
    // Final launch boundary: a cloned auto-resume/notification may predate clear.
    let resume = crate::chat_index::usable_session(&session_key, resume)?;
    manager.lifespan_refusal(&cwd, extra_dirs.as_ref())?;
    if let Some(id) = user_turn_id
        .as_deref()
        .and_then(|id| id.strip_prefix("octiq-provider-switch-"))
    {
        if !manager.auto_resumes.active_switch(&key, id) {
            return Err("The provider switch was cancelled.".into());
        }
    }
    if let Some(fence) = &recovery_fence {
        fence.check()?;
        // Same runtime, fresh native session. Save only after the final Stop
        // fence under the session-table lock used by ordinary starts.
        if let Some(mut saved) = manager.start_context(&session_key) {
            saved.session_id = None;
            manager.remember_start(&session_key, saved);
        }
    }
    let notification_start = user_turn_id
        .as_deref()
        .is_some_and(|id| id.starts_with(crate::orchestration::inbox::RECEIPT_PREFIX));
    if notification_start && manager.has_queued_turns(&session_key) {
        return Err("User messages are waiting; notification delivery will retry.".into());
    }
    // A queue that waits for the profile folder counts like a handoff: a
    // new message does not start a process round what is already waiting.
    // The page answers "already running" by sending, which queues it behind.
    if sessions.contains_key(&session_key)
        || manager.claimed_elsewhere(&session_key)
        || ((record_user_turn || notification_start)
            && (manager
                .handoffs
                .lock()
                .map_err(|e| e.to_string())?
                .contains(&session_key)
                || manager.waits_because(&session_key).is_some()))
    {
        return Err(format!("chat '{session_key}' is already running"));
    }
    // No process for a conversation whose registered agent is being
    // removed, or was (`Leaving`). Under the session table's lock, held
    // until the process is in the table: a removal that looks afterwards
    // finds it there, with its first turn in flight.
    if let Some(leaving) = manager.leaving_refusal(&session_key) {
        return Err(leaving);
    }

    let (prompt, visible_prompt) = match (prompt, manager.background.continuation(&key)) {
        (Some(prompt), Some(context)) => {
            let visible = visible_prompt.or_else(|| Some(prompt.clone()));
            (Some(format!("{context}\n\n{prompt}")), visible)
        }
        (prompt, _) => (prompt, visible_prompt),
    };
    // A chat whose folder was put back or changed since its last turn: the
    // agent is told on the prompt that follows, once (`chat_recover`). Taken
    // only when there is a prompt to carry it, and only once nothing above
    // can still refuse this start.
    let (prompt, visible_prompt) = crate::chat_recover::with_note(&key, prompt, visible_prompt);

    manager.admit_beside_writers(
        &session_key,
        &key,
        std::iter::once(&cwd).chain(extra_dirs.iter().flatten()),
        access != Some(Access::Read),
    )?;

    let mut native_recovery = (agent == ChatAgent::Claude
        && !orchestration_worker
        && !front_desk
        && session_key == key
        && resume.is_some()
        && prompt.is_some()
        && user_turn_id.is_some())
    .then(|| {
        claude_session_recovery::Request::new(
            &manager,
            &key,
            StartContext {
                cwd: cwd.clone(),
                agent,
                model: model.clone(),
                access,
                extra_dirs: extra_dirs.clone(),
                env: env.clone(),
                effort: effort.clone(),
                lite,
                session_id: resume.clone(),
                defaults: manager
                    .start_context(&key)
                    .map(|start| start.default_settings()),
            },
            visible_prompt
                .clone()
                .or_else(|| prompt.clone())
                .unwrap_or_default(),
            images.clone().unwrap_or_default(),
            user_turn_id.clone().unwrap(),
        )
    });
    let recovery_observation = native_recovery
        .as_ref()
        .map(|request| request.observation());

    // The folder we start in is already visible to the agent, so naming it
    // again would be noise; blanks and repeats are dropped for the same reason.
    let mut seen = std::collections::HashSet::new();
    let extras: Vec<String> = extra_dirs
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !p.trim().is_empty() && p != &cwd && seen.insert(p.clone()))
        .collect();

    let provider = provider_for(agent);
    let transport = provider.capabilities().input;
    let sandbox_roots = if agent == ChatAgent::Codex
        && !front_desk
        && transport == crate::agent_provider::InputTransport::CommandLine
    {
        crate::git_ops::prepare_codex_branch_parents(std::path::Path::new(&cwd), access);
        crate::codex_git::commit_roots(std::path::Path::new(&cwd), access)
    } else {
        Vec::new()
    };
    let has_prompt = prompt.is_some();
    let prompt = prompt.unwrap_or_default();
    let durable_prompt = visible_prompt.as_deref().unwrap_or(&prompt);
    let images = images.unwrap_or_default();
    crate::safety_block::remember_project(&key, &cwd);
    // What an outage card's "Always allow" writes to: this chat's folder, and
    // the config dir Claude will read — the project's own CLAUDE_CONFIG_DIR
    // when it sets one, else the one this server passes on. It is kept as
    // Claude gets it; `safety_block::user_target` resolves a relative one
    // from the launch folder and refuses one that is not the person's own.
    crate::safety_block::remember_claude_launch(
        &key,
        agent == ChatAgent::Claude,
        &cwd,
        lite.unwrap_or(false),
        env.as_ref()
            .and_then(|env| {
                crate::workspaces::resolved_env(env)
                    .into_iter()
                    .find(|(name, _)| name == "CLAUDE_CONFIG_DIR")
                    .map(|(_, dir)| dir)
            })
            .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok()),
    );
    let mcp = provider
        .capabilities()
        .uses_octiq_mcp
        .then(ask_mcp_config)
        .flatten();
    let authorizations = (agent == ChatAgent::Codex)
        .then(|| crate::safety_block::project_authorizations(&cwd))
        .flatten();
    let wire_prompt = if mcp.is_some() {
        routed_prompt(agent, &prompt)
    } else {
        Cow::Borrowed(prompt.as_str())
    };
    // Read at every process start, so a change in Settings reaches a chat
    // the next time it starts or is resumed.
    let preferences = crate::personal_preferences::launch_prompt();
    let preferences = if crate::lead_threads::is_key(&key) {
        Some(format!(
            "{}\n\n{}",
            preferences.unwrap_or_default(),
            crate::lead_threads::CONDUCT
        ))
    } else {
        preferences
    };
    let launch = AgentCommand {
        model: model.as_deref(),
        access,
        prompt: &wire_prompt,
        resume: resume.as_deref(),
        extra_dirs: &extras,
        sandbox_roots: &sandbox_roots,
        effort: effort.as_deref(),
        images: &images,
        lite: lite.unwrap_or(false) || front_desk,
        mcp_config: mcp.as_deref(),
        persistent_authorizations: authorizations.as_deref(),
        orchestration_worker,
        front_desk,
        codex_user_mcp: &codex_user_mcp,
        codex_worker_playwright: codex_worker_playwright.as_ref(),
        codex_worker_desktop,
        worker_full_tools,
        claude_worker_mcp: claude_worker_mcp.as_deref(),
        preferences: preferences.as_deref(),
    };
    let line = provider.build_command(&launch);
    // What the provider reads from files rather than its command line:
    // Antigravity's plugin carrying OctiqFlow's MCP server and rules. A
    // launch that would have no way to report is refused, naming the file.
    let launch_warning = provider
        .prepare_launch(&launch)
        .map_err(|why| format!("could not start {}: {why}", provider.bin()))?;
    if let Some(warning) = launch_warning {
        emit_status(
            agent,
            ChatStatus {
                key: key.clone(),
                kind: "stderr".into(),
                text: warning,
                code: None,
            },
        );
    }
    let process_cwd = if cwd.trim().is_empty() {
        // `home_dir` reads USERPROFILE too, so this does not land on "/" the
        // moment a Windows machine is asked for a chat with no folder.
        crate::paths::home_dir()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/".into())
    } else {
        cwd.clone()
    };
    let mut workspace_roots = vec![process_cwd.clone()];
    for extra in &extras {
        let path = std::path::Path::new(extra);
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::path::Path::new(&process_cwd).join(path)
        };
        let absolute = absolute.to_string_lossy().to_string();
        if !workspace_roots.contains(&absolute) {
            workspace_roots.push(absolute);
        }
    }
    let selected_model = model.as_deref().and_then(safe_model);
    let selected_effort = effort
        .as_deref()
        .and_then(|requested| provider.effort(requested))
        .map(str::to_string);
    let codex_instructions = transport.is_app_server().then(|| {
        let instructions = if front_desk {
            crate::agent_provider::codex_front_desk_instructions(
                selected_model.as_deref(),
                selected_effort.as_deref(),
                access,
            )
        } else {
            crate::agent_provider::codex_developer_instructions(
                selected_model.as_deref(),
                selected_effort.as_deref(),
                access,
                authorizations.as_deref(),
                true,
                orchestration_worker,
            )
        };
        crate::agent_provider::with_preferences(&instructions, preferences.as_deref())
    });

    // Login shell, for PATH — see the module docs. Windows has no login shell,
    // so the resolution finds the bash that Git for Windows ships; the command
    // itself is POSIX-quoted either way and does not change.
    let shell = crate::proc::resolve_agent_shell(
        std::env::var("SHELL").ok(),
        std::env::var("LOCALAPPDATA").ok(),
        cfg!(windows),
        &crate::proc::find_executable,
    )
    .map_err(|e| format!("could not start {}: {e}", provider.bin()))?;
    let launch_id = uuid::Uuid::new_v4().to_string();
    let capability = manager.grant_capability(&sessions, &session_key, &key, &launch_id);
    if let Some(fence) = recovery_fence.as_mut() {
        fence.after_own_launch();
        fence.check()?;
    }
    let project_env = crate::workspaces::resolved_env(&env.unwrap_or_default());
    // `octiq-job` on the agent's PATH, and where its shells reach the host
    // from (`chat_jobs::agent_env`): put before the project's PATH.
    let mut job_env = crate::chat_jobs::agent_env(
        &session_key,
        project_env
            .iter()
            .find(|(name, _)| name == "PATH")
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var("PATH").ok()),
    );
    // Where `octiq-job` reports when a sandbox refuses the hook
    // (`job_spool.rs`). A front desk keeps no jobs.
    if !front_desk {
        job_env.extend(manager.spools.open(&key, &session_key, &launch_id));
    }
    if let Some(fence) = &recovery_fence {
        fence.check()?;
    }
    let mut child = shell
        .command(&format!("exec {line}"))
        .current_dir(&process_cwd)
        // The project's own environment, so a chat agent picks up the same
        // variables a terminal in this project would (e.g. `starfall`'s
        // `CLAUDE_CONFIG_DIR`). Applied first so every var this backend sets
        // below always wins if a project happened to name the same key.
        .envs(project_env)
        // The browser server's own variables (a Codex worker's `playwright`
        // definition): the table on the command line names them and Codex
        // forwards them by name, so no value is ever on a command line.
        .envs(
            codex_worker_playwright
                .iter()
                .flat_map(|browser| browser.env.iter().cloned()),
        )
        .envs(job_env)
        // The selected provider declares whether it owns a persistent stdin
        // protocol. A command-line provider must receive EOF immediately so a
        // one-shot CLI does not wait for a second prompt.
        // The hook answers only for agents we started, and needs to know
        // which chat is asking so the UI can attach the question to it.
        .env("OCTIQ_CHAT_KEY", &key)
        // Which agent is reporting, so a task report carries a name rather
        // than an anonymous timestamp.
        .env("OCTIQ_CHAT_AGENT", agent.id())
        .env("OCTIQ_SESSION_KEY", &session_key)
        .env("OCTIQ_LAUNCH_ID", &launch_id)
        // The MCP then offers a front desk `route_chat` and nothing else.
        // The hooks refuse the rest by the chat's identity regardless.
        .env("OCTIQ_FRONT_DESK", if front_desk { "1" } else { "" })
        // Which chat this is, as every hook will believe it — see
        // `LaunchCapability`. `OCTIQ_CHAT_KEY` only names it. It is the
        // agent's only credential: the MCP is told where the hooks are and
        // never reads the person's token, and a server started with the
        // token in its own environment does not pass it down.
        .env("OCTIQ_CHAT_CAPABILITY", &capability)
        .env(
            "OCTIQ_HOOK_PORT",
            crate::web::hook_port()
                .map(|port| port.to_string())
                .unwrap_or_default(),
        )
        .env_remove("OCTIQ_WEB_TOKEN")
        // The conversation reader in that MCP must use this exact profile.
        // A standalone install can follow config.json; an in-app agent should
        // not have to rediscover a value the server already knows.
        .env("OCTIQ_ROOT", crate::profile::profile_dir())
        // What the person chose. The hook cannot read --permission-mode, and on
        // bypassPermissions it must step aside rather than ask about every command.
        // Unset means the most cautious of the three, not the most permissive:
        // a missing value must never be the one that stops the asking.
        .env("OCTIQ_ACCESS", access.map(Access::as_env).unwrap_or("read"))
        // The Artifact tool, which print mode hides from itself.
        //
        // Claude Code decides whether to offer `Artifact` by ENTRYPOINT, and it
        // refuses for `-p`, for the SDKs, for the GitHub action and for `mcp` —
        // so a chat agent here is never shown it, no matter what it is asked
        // for. A truthy `CLAUDE_CODE_ARTIFACT` skips that check, and nothing
        // else about the tool needs arranging: the call goes through the same
        // `--permission-prompt-tool stdio` chain as every other tool, so the
        // person still approves it.
        //
        // Unlike `AskUserQuestion` above, the tool WORKS without a terminal to
        // draw in — it publishes an HTML/Markdown file the agent has already
        // written to disk as a private page on claude.ai and hands back a URL.
        // So it needs the network and a claude.ai login; on any other auth the
        // CLI keeps the tool hidden and this var changes nothing. `disableArtifact`
        // in the user's settings still wins, which is how they turn it back off.
        //
        // Harmless for Codex, whose app-server ignores this Claude-only value.
        .env("CLAUDE_CODE_ARTIFACT", "1")
        .stdin(if transport.accepts_stdin() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", provider.bin()))?;

    if let Some(fence) = &recovery_fence {
        if let Err(why) = fence.check() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(why);
        }
    }
    let stdout = child
        .stdout
        .take()
        .ok_or("no stdout on the agent process")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("no stderr on the agent process")?;
    let mut stdin = child.stdin.take();
    let mut stdout = BufReader::new(stdout);
    let mut app_server_prelude = Vec::new();
    let codex = if transport.is_app_server() {
        let Some(app_stdin) = stdin.as_mut() else {
            let _ = child.kill();
            return Err("Codex app-server has no stdin".into());
        };
        let instructions = codex_instructions
            .as_deref()
            .ok_or("Codex app-server has no host instructions")?;
        let resume = resume.as_deref().and_then(safe_session_id);
        let initialized = initialize_codex_app_server(
            app_stdin,
            &mut stdout,
            &process_cwd,
            selected_model.as_deref(),
            selected_effort.as_deref(),
            access,
            resume.as_deref(),
            &workspace_roots,
            instructions,
        );
        let (thread_id, prelude) = match initialized {
            Ok(value) => value,
            Err(why) => {
                let _ = child.kill();
                return Err(format!("could not initialize Codex app-server: {why}"));
            }
        };
        manager.remember_session(&session_key, &thread_id);
        app_server_prelude = prelude;
        Some(CodexAppSession {
            thread_id,
            active_turn_id: None,
            interrupt_when_started: false,
            next_request: 0,
            elicitations: HashMap::new(),
            mcp_calls: HashMap::new(),
            mcp_refusals: HashMap::new(),
            model: selected_model,
            effort: selected_effort,
            access,
            cwd: process_cwd.clone(),
            workspace_roots: workspace_roots.clone(),
            has_octiq_mcp: mcp.is_some(),
        })
    } else {
        None
    };

    // A worker that was given the person's `playwright` holds its first turn
    // until that server settles (`codex_mcp_ready`): Codex fixes a turn's tool
    // list when the turn starts, and a cold `npx` is not ready by then.
    let mcp_ready = {
        let (watched, longest) = crate::agent_provider::codex_gate_servers(
            codex_worker_playwright.as_ref().map(|b| b.name.as_str()),
            worker_full_tools && agent == ChatAgent::Codex,
            codex_worker_desktop,
            &codex_user_mcp,
        );
        (transport.is_app_server() && !watched.is_empty())
            .then(|| crate::codex_mcp_ready::McpReady::watching(&watched, longest))
    };
    // Whether this launch hands a first prompt over on stdin after startup
    // (command-line providers already have it in their launch command).
    let writes_first_prompt = transport.accepts_stdin()
        && has_prompt
        && (!wire_prompt.trim().is_empty() || !images.is_empty());

    let session = Arc::new(Mutex::new(ChatSession {
        launch_id: launch_id.clone(),
        user_turn_id: user_turn_id.clone(),
        answering: user_turn_id.clone(),
        child,
        stdin,
        codex,
        agent,
        // Working from the first breath, because a chat is nearly always
        // started WITH its first message: Claude is handed it on stdin a few
        // lines below; command-line providers already have it in their launch
        // command. Started with nothing to do — which only the API can ask for — it is still
        // from birth, and the sweeper is right to treat it that way.
        busy: has_prompt && (!prompt.trim().is_empty() || !images.is_empty()),
        last_active: Instant::now(),
        cut_off: CutOff::No,
        auto_plan_refused: false,
        auto_plan_turn: AutoPlanTurn::default(),
        auto_plan_attribution: AutoPlanAttribution::Ready,
        leaving: None,
        first_turn_held: mcp_ready.is_some() && writes_first_prompt,
    }));
    sessions.insert(session_key.clone(), session.clone());
    if let Some(request) = native_recovery.as_mut() {
        request.arm();
    }
    manager.remember_binary(&session_key, provider.bin());
    // The level the hook will be answered with, from here until it changes.
    // Unset is the most cautious of the three, matching `OCTIQ_ACCESS` above.
    record_access_for(&key, access);

    // All providers share a durable prompt identity. Write it before the
    // reader can forward an acknowledgement or a following enqueue can land.
    if record_user_turn && has_prompt {
        if let Some(turn_id) = user_turn_id.as_deref() {
            record_durable_user_turn(&key, turn_id, durable_prompt, &images);
        }
    }

    if has_prompt && !provider.capabilities().input.accepts_stdin() {
        record_delivery(&key, user_turn_id.as_deref(), "dispatched");
        crate::team::note_roster_delivered(&session_key, &wire_prompt);
    }

    drop(sessions);
    reopen_started_chat(&session_key, &key);

    // Providers that use a control channel initialize it before the first turn.
    // The handshake is not transcript content; its response is recognized by
    // that provider's event adapter below.
    if let Some(hello) =
        provider.initialize_payload(&format!("octiq-hello-{}", uuid::Uuid::new_v4()))
    {
        if let Ok(mut guard) = session.lock() {
            if let Some(stdin) = guard.stdin.as_mut() {
                let _ = writeln!(stdin, "{hello}");
                let _ = stdin.flush();
            }
        }
    }

    let (output_closed, output_drained) = std::sync::mpsc::channel();
    // stdout: one JSON object per line, passed through as-is.
    {
        let output_closed = output_closed.clone();
        let key = key.clone();
        let session_key = session_key.clone();
        let stream_provider = provider;
        let asking = session.clone();
        // The runtime the answer will be waited on. Captured HERE, on the thread
        // that still has one: `chat_start` is called from an async handler, the
        // reader below is a plain thread, and `Handle::current()` panics there.
        // A chat started by the orchestration scheduler (an auto-dispatched
        // worker, a coordinator resumed by a notice) is started from a plain
        // thread too, so it falls back to the server's own runtime — without
        // it every permission such a chat asked for was refused unasked.
        let rt = answer_runtime();
        // The reader is where a chat learns its own session id.
        let reading = manager.clone();
        // Pi spends whichever upstream's allowance its model names.
        let quota_model = model.clone();
        let reader_mcp_ready = mcp_ready.clone();
        let recovery_observation = recovery_observation.clone();
        let mut native_recovery_turn = recovery_fence.is_some();
        thread::spawn(move || {
            let mut output_state = OutputState::default();
            // Kept only when the provider explicitly says a limit is blocking.
            // Allowed/warning snapshots are ordinary usage telemetry and must
            // not arm a retry for an unrelated error later in the turn.
            let mut blocked_quota_reset = None;
            // The last thing a Codex turn said, kept until the turn stops and
            // cleared the moment it is handed over. One turn's words must never
            // be read as the next one's answer.
            let mut carried = String::new();
            let mut preview = HostPreview::default();
            // Claude's calls by tool_use id, so an auto-mode refusal naming
            // one can say exactly what was refused (see `note_claude_calls`).
            let mut claude_calls: HashMap<String, (String, Value)> = HashMap::new();
            let mut snapshot_reads = crate::record_trim::SnapshotResults::default();
            // This process's usage. Claude's totals restart with each process,
            // and so does this.
            let mut usage_meter = crate::agent_usage::Meter::default();
            let mut denied_actions = DeniedActions::default();
            let mut pi_turn = PiTurn::default();
            let mut auto_plan_refused = false;
            let prelude = app_server_prelude
                .into_iter()
                .map(|message| Ok(message.to_string()));
            for line in prelude.chain(stdout.lines()) {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(mut event) => {
                        // A provider whose protocol says a thing the page and
                        // the record know in another form (Pi's RPC answers)
                        // is rewritten before anything else reads the line.
                        stream_provider.adapt_event(&mut event);
                        if stream_provider.kind() == ChatAgent::Pi {
                            pi_turn.observe(&event);
                        }
                        if let Some(observation) = &recovery_observation {
                            observation.event(&event);
                        }
                        if let Some(ready) = &reader_mcp_ready {
                            ready.observe(&event);
                        }

                        if transport.is_app_server() {
                            codex_elicitation::observe(&asking, &mut event);
                            if crate::codex_app_server::is_server_request(&event) {
                                if let Err(error) = reading
                                    .orchestrations
                                    .observe_worker_event(&key, &json!({"type":"control_request"}))
                                {
                                    eprintln!("orchestration: cannot record tool wait: {error}");
                                }
                                answer_codex_server_request(
                                    &reading,
                                    &asking,
                                    &key,
                                    rt.as_ref(),
                                    event,
                                );
                                continue;
                            }
                            if event.get("method").and_then(Value::as_str)
                                == Some("serverRequest/resolved")
                            {
                                codex_elicitation::resolved(
                                    &asking,
                                    &key,
                                    &event["params"]["requestId"],
                                );
                            }
                            let native_thread = if let Ok(session) = asking.lock() {
                                session.codex.as_ref().map(|codex| codex.thread_id.clone())
                            } else {
                                None
                            };
                            if crate::codex_app_server::notification_thread_id(&event)
                                .zip(native_thread.as_deref())
                                .is_some_and(|(event_thread, root_thread)| {
                                    event_thread != root_thread
                                })
                            {
                                continue;
                            }
                            if let Ok(mut session) = asking.lock() {
                                session.auto_plan_attribution.observe(&event);
                                session.auto_plan_turn.observe_codex(&event);
                            }
                            if let Some(turn_id) =
                                crate::codex_app_server::turn_id_from_response(&event)
                            {
                                let mut interrupt_error = None;
                                if let Ok(mut session) = asking.lock() {
                                    let should_interrupt =
                                        if let Some(codex) = session.codex.as_mut() {
                                            codex.active_turn_id = Some(turn_id.to_string());
                                            codex.interrupt_when_started
                                        } else {
                                            false
                                        };
                                    if should_interrupt {
                                        interrupt_error =
                                            write_codex_interrupt_locked(&mut session).err();
                                    }
                                }
                                if let Some(why) = interrupt_error {
                                    emit_status(
                                        ChatAgent::Codex,
                                        ChatStatus {
                                            key: key.clone(),
                                            kind: "error".into(),
                                            text: format!("could not interrupt Codex: {why}"),
                                            code: None,
                                        },
                                    );
                                }
                                continue;
                            }
                            if event.get("id").is_some() {
                                if let Some(error) = event
                                    .get("error")
                                    .and_then(|error| error.get("message"))
                                    .and_then(Value::as_str)
                                {
                                    event = json!({
                                        "type": "turn.failed",
                                        "error": { "message": error },
                                    });
                                } else {
                                    continue;
                                }
                            } else {
                                if let Err(error) =
                                    reading.orchestrations.observe_codex_activity(&key, &event)
                                {
                                    eprintln!("orchestration: cannot record activity: {error}");
                                }
                                let Some(normalized) =
                                    crate::codex_app_server::normalize_notification(&event)
                                else {
                                    continue;
                                };
                                event = normalized;
                            }
                        }
                        if let Err(error) = reading.observe_for_orchestration(&asking, &key, &event)
                        {
                            eprintln!("orchestration: cannot record provider event: {error}");
                        }
                        reading.usage.note_context(
                            &key,
                            crate::agent_usage::context_in(stream_provider.kind(), &event),
                        );
                        if let Some(used) = usage_meter.observe(stream_provider.kind(), &event) {
                            if let Err(error) = reading.usage.record(
                                &key,
                                stream_provider.kind(),
                                &used,
                                crate::agent_usage::now_ms(),
                                || crate::agent_usage::attribute(&reading.orchestrations, &key),
                            ) {
                                eprintln!("usage: cannot record tokens: {error}");
                            }
                        }
                        if transport.is_app_server()
                            && event.get("type").and_then(Value::as_str) == Some("turn.started")
                        {
                            if let Some(turn_id) = event.get("turn_id").and_then(Value::as_str) {
                                let mut interrupt_error = None;
                                if let Ok(mut session) = asking.lock() {
                                    let should_interrupt =
                                        if let Some(codex) = session.codex.as_mut() {
                                            codex.active_turn_id = Some(turn_id.to_string());
                                            codex.interrupt_when_started
                                        } else {
                                            false
                                        };
                                    if should_interrupt {
                                        interrupt_error =
                                            write_codex_interrupt_locked(&mut session).err();
                                    }
                                }
                                if let Some(why) = interrupt_error {
                                    emit_status(
                                        ChatAgent::Codex,
                                        ChatStatus {
                                            key: key.clone(),
                                            kind: "error".into(),
                                            text: format!("could not interrupt Codex: {why}"),
                                            code: None,
                                        },
                                    );
                                }
                            }
                        }
                        if let Some(reset) = crate::auto_resume::blocked_reset_from_event(&event) {
                            blocked_quota_reset = Some(reset);
                        }
                        let quota_failure =
                            crate::auto_resume::is_quota_failure(stream_provider.kind(), &event);
                        let quota_reset_hint = quota_failure
                            .then(|| crate::auto_resume::reset_at_in(&event))
                            .flatten()
                            .or(blocked_quota_reset);
                        if quota_failure {
                            reading.failover.limited(
                                stream_provider.kind(),
                                quota_model.as_deref(),
                                quota_reset_hint,
                                crate::auto_resume::unix_now(),
                            );
                            if native_recovery_turn {
                                // This one recovery is strictly same-provider.
                                // A fresh failure cannot turn it into another
                                // automatic retry or cross-provider handoff.
                                emit_status(stream_provider.kind(), ChatStatus { key: key.clone(), kind: "error".into(),
                                    text: "The fresh Claude recovery reached its account limit. No further retry or provider switch was started. Check the Claude account before continuing, or explicitly choose a fallback.".into(), code: None });
                            } else {
                                schedule_quota_resume(
                                    &reading,
                                    &key,
                                    &session_key,
                                    stream_provider.kind(),
                                    quota_reset_hint,
                                );
                            }
                        }
                        let observed = stream_provider.observe_event(&event);
                        if let Some(notice) = observed.host_notice {
                            emit_status(
                                stream_provider.kind(),
                                ChatStatus {
                                    key: key.clone(),
                                    kind: "stderr".into(),
                                    text: notice.to_string(),
                                    code: None,
                                },
                            );
                        }
                        if let Some(id) = observed.cancel_ui_request {
                            cancel_ui_request(&asking, id);
                        }
                        // An answer to a command the host sent, or a UI
                        // record nobody draws: not conversation.
                        if observed.suppress {
                            continue;
                        }
                        if let Ok(mut session) = asking.lock() {
                            if let Err(error) =
                                reading.background.observe(&key, &session.launch_id, &event)
                            {
                                eprintln!("chat: cannot record background work: {error}");
                            }
                            if !transport.is_app_server() {
                                session.auto_plan_attribution.observe(&event);
                            }
                            // A turn nobody wrote for: Claude woke itself when
                            // its background work finished. Until this, the
                            // session read idle through the whole turn, so
                            // ask_user refused it as "turn has already ended"
                            // (feedback 5fd9b781) and the idle sweeper, whose
                            // clock had run since the previous full stop,
                            // ended the worker mid-report (feedback 4c7f5647).
                            if observed.turn_opened && !session.busy {
                                reading.note_observed_turn(&session_key);
                                session.turn_started();
                            }
                        }
                        if stream_provider.kind() == ChatAgent::Claude {
                            note_claude_calls(&event, &mut claude_calls);
                            let called = event
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .and_then(|id| claude_calls.get(id))
                                .map(|(name, input)| (name.as_str(), input));
                            let refused = event.get("subtype").and_then(Value::as_str)
                                == Some("permission_denied");
                            auto_plan_refused |= refused;
                            let owner = refused
                                .then(|| reading.orchestrations.refusal_owner(&key))
                                .flatten();
                            if crate::safety_block::observe_claude_denial(
                                &key,
                                owner.as_deref(),
                                &event,
                                called,
                            ) {
                                if let Err(error) =
                                    reading.orchestrations.capture_native_decisions()
                                {
                                    eprintln!(
                                        "orchestration: cannot record native decision: {error}"
                                    );
                                }
                            }
                        }
                        // Anything the agent asks US, named in the log first.
                        //
                        // This whole path is invisible otherwise: a
                        // `can_use_tool` never reaches the transcript, so the
                        // only symptom of one going unanswered was a chat that
                        // sat still. One line per control request is the
                        // difference between diagnosing that in a minute and
                        // guessing at it across three restarts.
                        if event.get("type").and_then(Value::as_str) == Some("control_request") {
                            eprintln!(
                                "[perm] {key} <- {}",
                                event
                                    .get("request")
                                    .and_then(|r| r.get("subtype"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("?")
                            );
                        }
                        if let Some(permission) = observed.permission {
                            answer_permission(
                                &asking,
                                &key,
                                rt.as_ref(),
                                permission.id.to_string(),
                                permission.request.clone(),
                            );
                            continue;
                        }
                        // The answer to our hello. It is the agent listing its
                        // own commands and capabilities — several kilobytes of
                        // it — and it is not conversation, so it goes no further
                        // than here rather than into the transcript.
                        if observed.is_initialize_response {
                            // Whether it WORKED is worth a line: the agent only
                            // asks over stdio once this is accepted, and a
                            // rejected handshake is otherwise silent.
                            eprintln!(
                                "[perm] {key} handshake {}",
                                event
                                    .get("response")
                                    .and_then(|r| r.get("subtype"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("?")
                            );
                            continue;
                        }
                        // The one line this module reads rather than passes on:
                        // the answer to a request WE sent, not something the
                        // agent said. A refused mode change has to be known
                        // here or the picker would promise a level the agent is
                        // not on. See `chat_set_access`.
                        if let Some(error) = observed.access_refusal {
                            emit_status(
                                stream_provider.kind(),
                                ChatStatus {
                                    key: key.clone(),
                                    kind: "access-refused".into(),
                                    text: error.to_string(),
                                    code: None,
                                },
                            );
                        }
                        // A turn that ended, to whatever is not open.
                        //
                        // `result` is the agent's own full stop, and it carries
                        // the closing words — which is the line the banner
                        // wants, without having to walk the transcript back
                        // looking for the last turn that actually said
                        // something. An errored turn still ended, and being
                        // told so matters more than being told it went well.
                        // The two agents spell their full stop differently, and
                        // the idle sweeper has to understand both of them or a
                        // Codex chat would look busy for as long as it lived.
                        // Native identity is learned beside append below,
                        // under the same session lock that Stop takes.
                        // Codex says nothing on its full stop, so its closing
                        // words have to be kept as they go past — see
                        // `codex_said`.
                        if let Some(text) = observed.spoken_text {
                            carried.clear();
                            carried.push_str(text);
                        }
                        // The same words keep this chat's list preview
                        // current, whoever has it open.
                        if !observed.turn_finished {
                            if let Some(words) = HostPreview::words(&event, observed.spoken_text) {
                                preview.heard(&session_key, &key, words);
                            }
                        }
                        // Set only by the full stop of a completion's wrap-up
                        // turn, and acted on once that full stop is recorded.
                        let mut wrap_up = None;
                        let mut auto_plan_end = None;
                        if observed.turn_finished {
                            native_recovery_turn = false;
                            // The full stop is also when the next message the
                            // person already sent is finally handed over. Taken
                            // and written under the SAME lock the turn ends
                            // under: let go in between and an ordinary send
                            // arriving in that gap would find the session idle
                            // and write straight past everything waiting.
                            //
                            // A one-shot provider's queue is not touched here —
                            // its process is about to exit and its reaper
                            // carries the next turn into a fresh command.
                            let mut refused = None;
                            let went_badly = match stream_provider.kind() {
                                ChatAgent::Pi => pi_turn.ended_badly(&event),
                                _ => denied_actions.newly_refused(&event),
                            };
                            let clean = ended_cleanly(stream_provider.kind(), &event, went_badly);
                            if let Ok(mut s) = asking.lock() {
                                reading.questions.detach_launch(&s.launch_id);
                                ((wrap_up, refused), auto_plan_end) = end_turn_for_auto_plan(
                                    &reading,
                                    &session_key,
                                    &key,
                                    &mut s,
                                    clean,
                                    auto_plan_refused
                                        || event
                                            .get("permission_denials")
                                            .and_then(Value::as_array)
                                            .is_some_and(|denials| !denials.is_empty()),
                                );
                                auto_plan_refused = false;
                            }
                            if let Some(why) = refused {
                                // Nothing behind it can go either, and words
                                // held for an agent that cannot take them must
                                // not surface in some later conversation.
                                reading.forget_queued_turns(&session_key);
                                emit_status(
                                    stream_provider.kind(),
                                    ChatStatus {
                                        key: key.clone(),
                                        kind: "error".into(),
                                        text: format!("could not send queued message: {why}"),
                                        code: None,
                                    },
                                );
                            }
                            let said = observed.final_text.unwrap_or(&carried).to_string();
                            carried.clear();
                            preview.turn_ended(&session_key, &key, clean.then_some(said.as_str()));
                            // A read-only worker cannot call the host; what it
                            // said last is held for its coordinator to confirm.
                            if let Err(error) =
                                reading.orchestrations.propose_worker_report(&key, &said)
                            {
                                eprintln!("orchestration: cannot hold proposed report: {error}");
                            }
                            crate::push::notify_chat(Some(&key), "done", &said);
                        }
                        let mut event = event;
                        if let Ok(mut session) = asking.lock() {
                            acknowledge_user_turn(
                                &mut event,
                                stream_provider.kind(),
                                &mut session.user_turn_id,
                            );
                        }
                        // A provider failure says it is the provider's, and
                        // which kind, before it is written down (`outcome`).
                        crate::outcome::annotate(stream_provider.kind(), &mut event);
                        // A turn Antigravity ended by refusing a call says
                        // which access level refused it (no card can ask).
                        crate::agent_provider::mark_refusal_access(
                            stream_provider.kind(),
                            &mut event,
                            access,
                        );
                        // The agent has its ledger read already; the record and
                        // every tab get a note instead.
                        snapshot_reads.trim(&mut event, crate::record_trim::RECORD_MIN_BYTES);
                        // Nor does the page draw a picture a tool returned.
                        crate::record_trim::strip_pictures(&mut event);
                        // Keep the live payload small too; the reducer draws
                        // the same text/diff/outcome without this second copy.
                        crate::record_storage::trim_display_only(&mut event);
                        // The host's record time, on the line and on the live
                        // event below (the same value; a provider line never
                        // carries one of its own).
                        crate::transcript::stamp(&mut event);
                        let notification_receipts: Vec<_> =
                            crate::orchestration::inbox::receipt_ids(&event)
                                .into_iter()
                                .map(str::to_string)
                                .collect();
                        // Recorded BEFORE it is sent, so a client that
                        // reconnects can never be told about an event that was
                        // not written down.
                        let Some(seq) = record_provider_event(
                            &reading,
                            &asking,
                            &session_key,
                            &key,
                            stream_provider.kind(),
                            &event,
                        ) else {
                            continue;
                        };
                        if !notification_receipts.is_empty() {
                            if let Err(error) = reading
                                .orchestrations
                                .acknowledge_notifications(&key, &notification_receipts)
                            {
                                eprintln!(
                                    "orchestration: could not acknowledge notifications: {error}"
                                );
                            }
                        }
                        crate::bus::emit(
                            "chat-event",
                            ChatEvent {
                                key: key.clone(),
                                seq,
                                event,
                            },
                        );
                        // After the full stop is in the transcript and on the
                        // bus: the tick is the last thing said about the turn.
                        // All chat locks are released before auto approval takes
                        // the ledger; Stop can veto through the captured epoch.
                        if let Some(ended) = auto_plan_end {
                            if let Err(error) =
                                reading.orchestrations.auto_approve_at_turn_end(ended)
                            {
                                eprintln!("orchestration: automatic plan approval failed: {error}");
                            }
                        }
                        if let Some(ended) = wrap_up {
                            settle_wrap_up(&reading, &session_key, &asking, ended);
                        }
                    }
                    // A non-JSON line means the agent printed something we did
                    // not ask for (a login prompt, an update notice). Surface it
                    // rather than dropping it — it is usually the reason a chat
                    // produced nothing. The one exception is below.
                    Err(_) => {
                        if let Err(error) =
                            reading.orchestrations.observe_worker_output(&key, trimmed)
                        {
                            eprintln!("orchestration: cannot record provider output: {error}");
                        }
                        if emit_unstructured_output(
                            stream_provider.kind(),
                            &key,
                            trimmed.to_string(),
                            stream_provider.classify_output(trimmed, &mut output_state),
                        ) {
                            if let Err(error) = reading.orchestrations.capture_native_decisions() {
                                eprintln!("orchestration: cannot record native decision: {error}");
                            }
                        }
                    }
                }
            }
            // Drain stdout before deciding: the final buffered line may be the
            // receipt. A killed/replaced launch must not stay "dispatched"
            // forever, nor imply its words reached the provider's history.
            if let Ok(mut session) = asking.lock() {
                if let Some(codex) = session.codex.as_mut() {
                    codex.elicitations.clear();
                    codex.mcp_calls.clear();
                    codex.mcp_refusals.clear();
                }
                reading.questions.detach_launch(&session.launch_id);
                record_delivery(&key, session.user_turn_id.take().as_deref(), "unknown");
                // Every line this process wrote has been read. A wrap-up it
                // was given and never brought to a full stop ended with it.
                reading.completion_cut_short(&session_key, &session, COMPLETION_ENDED);
            }
            if let Some(ready) = &reader_mcp_ready {
                ready.close();
            }
            let _ = output_closed.send(());
        });
    }

    // stderr is normally worth showing. A provider can classify known internal
    // recovery details as diagnostics-only without losing them from the local
    // error journal.
    //
    // The last visible line is kept for the reaper: when the process dies
    // without a report, that line is usually why (see `last_words`).
    let last_stderr = Arc::new(Mutex::new(String::new()));
    {
        let key = key.clone();
        let stderr_provider = provider;
        let observing = manager.clone();
        let last_stderr = last_stderr.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut output_state = OutputState::default();
            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                if let Some(observation) = &recovery_observation {
                    observation.stderr(&line);
                }
                let disposition = stderr_provider.classify_output(&line, &mut output_state);
                if disposition == OutputDisposition::Visible {
                    if let Err(error) = observing.orchestrations.observe_worker_output(&key, &line)
                    {
                        eprintln!("orchestration: cannot record provider stderr: {error}");
                    }
                    if let Ok(mut last) = last_stderr.lock() {
                        last.clone_from(&line);
                    }
                }
                if emit_unstructured_output(stderr_provider.kind(), &key, line, disposition) {
                    if let Err(error) = observing.orchestrations.capture_native_decisions() {
                        eprintln!("orchestration: cannot record native decision: {error}");
                    }
                }
            }
            let _ = output_closed.send(());
        });
    }

    // Reap the child and tell the UI, so a chat can never look "still thinking"
    // after its process is gone.
    {
        let key = key.clone();
        let session = session.clone();
        thread::spawn(move || {
            let code = loop {
                let status = {
                    let Ok(mut s) = session.lock() else {
                        break None;
                    };
                    s.child.try_wait().ok().flatten()
                };
                match status {
                    Some(st) => break st.code(),
                    None => thread::sleep(std::time::Duration::from_millis(200)),
                }
            };

            // An old reaper must never remove a replacement that was started
            // under the same key. That was harmless while every process lived
            // for a whole persistent conversation, but command-line providers
            // deliberately start a fresh process for every turn.
            let (was_current, was_replaced, queued_turn) = match manager_for_exit.sessions.lock() {
                Ok(mut sessions) => {
                    if sessions
                        .get(&session_key_for_exit)
                        .is_some_and(|current| Arc::ptr_eq(current, &session))
                    {
                        sessions.remove(&session_key_for_exit);
                        // `chat_send_impl` takes these same locks in this
                        // order. Once this map entry is gone, no newly queued
                        // turn can be stranded on the old process.
                        //
                        // A one-shot provider's next turn rides the resume
                        // command below. A persistent one has no next process
                        // to ride: its stdin died with it, so anything still
                        // waiting is dropped here rather than left to surface
                        // in whatever is started under this key later.
                        if native_recovery.is_some() {
                            manager_for_exit
                                .handoffs
                                .lock()
                                .unwrap()
                                .insert(session_key_for_exit.clone());
                        }
                        let queued_turn = if native_recovery.is_some() {
                            None
                        } else if manager_for_exit
                            .auto_resumes
                            .switch_waits(&session_key_for_exit)
                        {
                            None // The provider handoff owns the queue, not the old reaper.
                        } else if relaunches_to_continue(agent) {
                            manager_for_exit.take_queued_turn(&session_key_for_exit)
                        } else {
                            manager_for_exit.forget_queued_turns(&session_key_for_exit);
                            None
                        };
                        if queued_turn.is_some() {
                            manager_for_exit
                                .handoffs
                                .lock()
                                .unwrap()
                                .insert(session_key_for_exit.clone());
                        }
                        (true, false, queued_turn)
                    } else {
                        let replaced = sessions.contains_key(&session_key_for_exit)
                            || manager_for_exit
                                .handoffs
                                .lock()
                                .map(|h| h.contains(&session_key_for_exit))
                                .unwrap_or(false);
                        (false, replaced, None)
                    }
                }
                Err(_) => (false, false, None),
            };
            if was_replaced {
                return;
            }
            // Read the final buffered error/report before declaring a lost
            // worker. A pipe inherited by a tool must not block the reaper.
            let is_worker = manager_for_exit
                .orchestrations
                .worker_coordinator(&key)
                .ok()
                .flatten()
                .is_some();
            let drained = (is_worker
                || native_recovery.is_some()
                || manager_for_exit.background.has_running(&key))
                && (0..2).all(|_| output_drained.recv_timeout(Duration::from_secs(2)).is_ok());

            if let Some(recovery) = native_recovery {
                let recovered = if was_current && recovery.eligible(code, drained) {
                    match recovery.run(manager_for_exit.clone(), &key) {
                        Ok(()) => true,
                        Err(why) => {
                            emit_status(agent, ChatStatus { key: key.clone(), kind: "error".into(),
                                text: format!("Could not recover the Claude session: {why}. No other provider was started."), code: None });
                            false
                        }
                    }
                } else {
                    false
                };
                manager_for_exit
                    .handoffs
                    .lock()
                    .unwrap()
                    .remove(&session_key_for_exit);
                if recovered {
                    return;
                }
                if was_current {
                    manager_for_exit.forget_queued_turns(&session_key_for_exit);
                }
            }

            // A command-line provider has no second-input channel. If somebody
            // sent a message after its full-stop but before this reaper saw the
            // exit, carry it into the next resume command instead. Keep the
            // UI's running state alive across that handoff: an `exit` here
            // would make a second quick message race the replacement.
            if was_current && relaunches_to_continue(agent) {
                if let Some(turn) = queued_turn {
                    match start_queued_command_turn(
                        manager_for_exit.clone(),
                        &session_key_for_exit,
                        &key,
                        turn,
                    ) {
                        Ok(Carried::Started) => return,
                        // Back in the queue, which waits for the profile
                        // folder: this process is gone all the same, and
                        // the exit below says so.
                        Ok(Carried::Waits(_)) => {}
                        Err(why) => {
                            // Do not let a later, unrelated resume receive
                            // stale words after a failed restart.
                            emit_status(
                                agent,
                                ChatStatus {
                                    key: key.clone(),
                                    kind: "error".into(),
                                    text: format!("could not resume queued message: {why}"),
                                    code: None,
                                },
                            );
                        }
                    }
                }
            }
            if drained {
                // Both readers are done, so this is the last line there was.
                let said = last_stderr.lock().map(|l| l.clone()).unwrap_or_default();
                if let Err(error) = manager_for_exit
                    .orchestrations
                    .worker_disconnected(&key, last_words(code, &said).as_deref())
                {
                    eprintln!("orchestration: cannot record worker disconnect: {error}");
                }
            }
            if let Ok(session) = session.lock() {
                if let Err(error) = manager_for_exit.background.interrupt(&key, &session.launch_id,
                    "The provider process exited before a background completion was observed. Inspect retained output before retrying.") {
                    eprintln!("chat: cannot record interrupted background work: {error}");
                }
            }
            emit_status(
                agent,
                ChatStatus {
                    key: key.clone(),
                    kind: "exit".into(),
                    text: String::new(),
                    code,
                },
            );
        });
    }

    // Persistent-stream providers receive the first user turn after startup;
    // command-line providers received it in `build_command` already.
    if writes_first_prompt {
        match mcp_ready {
            // A worker given the person's `playwright` holds its first turn
            // for that server (`codex_mcp_ready`), and the wait is NOT here:
            // this function returns to `start_worker_for`, which holds the
            // orchestration workspace lock until it does, and a Task or Run
            // Stop takes that lock. The session already reads busy (a message
            // meanwhile queues behind the first prompt) and says so with
            // `first_turn_held`.
            Some(ready) => {
                let manager = manager.clone();
                let session = session.clone();
                let (wire_prompt, images) = (wire_prompt.to_string(), images.clone());
                let (key, session_key) = (key.clone(), session_key.clone());
                let user_turn_id = user_turn_id.clone();
                // What the failure path needs if no thread can be made: the
                // closure (and what it owns) is gone by then.
                let on_failure = (
                    manager.clone(),
                    session.clone(),
                    key.clone(),
                    session_key.clone(),
                    user_turn_id.clone(),
                );
                let spawned = thread::Builder::new()
                    .name("first-turn-hand-over".into())
                    .spawn(move || {
                        hand_over_first_turn(
                            &manager,
                            &session,
                            &ready,
                            agent,
                            FirstTurn {
                                text: &wire_prompt,
                                images: &images,
                                key: &key,
                                session_key: &session_key,
                                turn_id: user_turn_id.as_deref(),
                            },
                        );
                    });
                if let Err(error) = spawned {
                    let (manager, session, key, session_key, user_turn_id) = on_failure;
                    give_up_first_turn(
                        &manager,
                        &session,
                        agent,
                        &FirstTurn {
                            text: "",
                            images: &[],
                            key: &key,
                            session_key: &session_key,
                            turn_id: user_turn_id.as_deref(),
                        },
                        &format!("could not start the thread that gives the worker its first prompt: {error}"),
                    );
                }
            }
            None => write_user_message(
                &manager,
                &session,
                &wire_prompt,
                &images,
                &key,
                &session_key,
                user_turn_id.as_deref(),
            )?,
        }
    }

    Ok(())
}

/// What a held first turn is, and who it is for.
struct FirstTurn<'a> {
    text: &'a str,
    images: &'a [String],
    key: &'a str,
    session_key: &'a str,
    turn_id: Option<&'a str>,
}

/// Wait for the worker's browser server, then give the process its first
/// prompt, by the same door every other prompt goes through.
///
/// Runs on its own thread and holds no lock of the host's while it waits: not
/// the orchestration workspace lock, not the ledger, not a chat's. So:
///
/// * **Stop wins at once.** Ending the process closes its output, which ends
///   the wait (`McpReady::close`), and a session that was ended has no stdin
///   left, so the first prompt is never written.
/// * **An interrupt has nothing to cut short** (`first_turn_held`): it sets no
///   `CutOff`, fails nothing, and the first prompt still goes, then whatever
///   queued behind it, in that order.
/// * A prompt that cannot be written to a process that is still live ends
///   that process, so the attempt fails the way it always did when its first
///   prompt could not be given, instead of waiting for a turn that is never
///   started.
fn hand_over_first_turn(
    manager: &Arc<ChatManager>,
    session: &Arc<Mutex<ChatSession>>,
    ready: &crate::codex_mcp_ready::McpReady,
    agent: ChatAgent,
    turn: FirstTurn<'_>,
) {
    let held = crate::codex_mcp_ready::hold_first_turn(
        ready,
        ready.bound_for(crate::codex_mcp_ready::BOUND),
    );
    // Everything below acts on THIS launch's session, never on whatever is
    // under the key by now: a Stop followed by a new launch of the chat inside
    // any of the gaps here must leave that new process alone.
    if let Some(note) = &held.note {
        if is_this_launch_alive(session) {
            crate::diagnostics::record(agent, turn.key, "mcp-startup", note);
        }
    }
    // Taken and written under one lock: a Stop either ended this session
    // before the look (no stdin) or comes after the write. Only the provider
    // write is under it: the transcript is written after the lock is let go,
    // because Stop takes this lock before it can kill the process and must
    // never wait for a save.
    let result = {
        let Ok(mut guard) = session.lock() else {
            return;
        };
        guard.first_turn_held = false;
        if !held.goes_on || guard.cut_off == CutOff::Ended || guard.stdin.is_none() {
            return;
        }
        write_user_message_locked(
            manager,
            &mut guard,
            turn.session_key,
            turn.text,
            turn.images,
            turn.turn_id,
        )
    };
    record_delivery(
        turn.key,
        turn.turn_id,
        if result.is_ok() {
            "dispatched"
        } else {
            "failed"
        },
    );
    if let Err(why) = result {
        give_up_first_turn(
            manager,
            session,
            agent,
            &turn,
            &format!("could not give the worker its first prompt: {why}"),
        );
    }
}

/// Whether `session` is a launch that has not been ended. A look under the
/// lock and nothing else: no I/O.
fn is_this_launch_alive(session: &Mutex<ChatSession>) -> bool {
    session
        .lock()
        .is_ok_and(|guard| guard.cut_off != CutOff::Ended && guard.stdin.is_some())
}

/// The first prompt cannot be given: end the process it was meant for, once,
/// and say why. **Bound to `session`**: only if that very launch is still the
/// one under the key. A Stop and a new launch of the same chat that came in
/// between keep their process, their queue and their status line.
fn give_up_first_turn(
    manager: &ChatManager,
    session: &Arc<Mutex<ChatSession>>,
    agent: ChatAgent,
    turn: &FirstTurn<'_>,
    why: &str,
) {
    if let Ok(mut guard) = session.lock() {
        guard.first_turn_held = false;
    }
    if end_process_of_launch(manager, turn.session_key, session) != Ok(true) {
        return;
    }
    crate::diagnostics::record(agent, turn.key, "first-turn", why);
    emit_status(
        agent,
        ChatStatus {
            key: turn.key.to_string(),
            kind: "error".into(),
            text: why.to_string(),
            code: None,
        },
    );
}

/// Store I/O never holds Stop's session lock. /clear waits on a separate
/// native-write gate AFTER stopping, so an init either precedes its cleanup
/// or observes the ended launch. Stop can veto an in-flight learn by epoch.
fn record_provider_event(
    manager: &ChatManager,
    session: &Mutex<ChatSession>,
    session_key: &str,
    key: &str,
    agent: ChatAgent,
    event: &Value,
) -> Option<Option<u64>> {
    let Some(id) = provider_for(agent).observe_event(event).session_id else {
        return Some(crate::transcript::append(key, event));
    };
    let write = manager.native_write(session_key);
    let _write = write.lock().unwrap_or_else(|e| e.into_inner());
    let epoch = manager.stop_epoch(session_key);
    let seen = {
        let session = session.lock().ok()?;
        // Read epoch BEFORE launch evidence: Stop removes the launch before
        // advancing epoch, so a post-Stop epoch cannot bless an old launch.
        let seen = epoch.load(std::sync::atomic::Ordering::SeqCst);
        if session.cut_off == CutOff::Ended
            || manager.auto_plan_launches.lock().ok()?.get(session_key) != Some(&session.launch_id)
        {
            return None;
        }
        seen
    };
    // Captured outside the process lock. The gate also prevents /clear from
    // removing this history between native-id publication and append.
    let generation = crate::transcript::generation(key);
    if !manager.prepare_session(session_key, id) {
        return None;
    }
    let published = {
        let mut starts = manager.starts.lock().unwrap_or_else(|e| e.into_inner());
        let start = starts.get_mut(session_key);
        let previous = start.as_ref().and_then(|start| start.session_id.clone());
        if let Some(start) = start {
            start.session_id = Some(id.into());
        }
        // Every Stop and replacement launch advances epoch. CAS is the
        // publication point; the starts lock hides the tentative id until
        // then. No session lock is needed here (even waiting for starts
        // under it could make Stop wait for another writer's store I/O).
        let current = epoch
            .compare_exchange(
                seen,
                seen,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_ok();
        if !current {
            if let Some(start) = starts.get_mut(session_key) {
                start.session_id = previous;
            }
        }
        current
    };
    if !published {
        manager.revoke_late_session(session_key, id);
        return None;
    }
    // Unlike f4f40e3, neither remember nor append holds the session mutex.
    // d9c19ba likewise recorded init events outside that process lock.
    Some(generation.and_then(|seen| crate::transcript::append_in(key, &seen, event).1))
}

/// A due entry may already have been cloned by the scheduler when /clear
/// cancels it. Check the receipt when admitting a new send or initial launch.
/// Already accepted queued turns outlive the schedule entry; Stop clears them.
fn require_scheduled_turn(
    manager: &ChatManager,
    key: &str,
    turn_id: Option<&str>,
) -> Result<(), String> {
    if let Some(id) = turn_id.and_then(|id| id.strip_prefix("octiq-auto-resume-")) {
        if !manager.auto_resumes.active_dispatch(key, id) {
            return Err("The auto-resume was cancelled.".into());
        }
    }
    Ok(())
}

/// Write one user turn through the running provider's persistent input channel.
///
/// Takes the session already locked, because the caller that matters holds it
/// for a reason: the turn is being released from the queue the instant the last
/// one ended, and letting go of the lock in between is exactly the gap another
/// thread's direct write could take to jump the line. See the flush beside
/// `turn_ended` in the stdout reader.
fn write_user_message_locked(
    manager: &ChatManager,
    session: &mut ChatSession,
    session_key: &str,
    text: &str,
    images: &[String],
    turn_id: Option<&str>,
) -> Result<(), String> {
    // The invariant of `CutOff`, kept here because every prompt comes
    // through here: an agent that has not stopped is not given another turn.
    if session.cut_off != CutOff::No {
        return Err(STILL_STOPPING.into());
    }
    // And the invariant of `Leaving`, for the same reason: a registered
    // agent that is being removed, or was, is not given another turn.
    session.not_leaving()?;
    let mut payload = if let Some(codex) = session.codex.as_mut() {
        let id = codex.request_id("turn");
        let text = if codex.has_octiq_mcp {
            routed_prompt(ChatAgent::Codex, text)
        } else {
            Cow::Borrowed(text)
        };
        let runtime = crate::agent_provider::codex_runtime_context(
            codex.model.as_deref(),
            codex.effort.as_deref(),
            codex.access,
        );
        crate::codex_app_server::turn_request(crate::codex_app_server::TurnRequest {
            id: &id,
            thread_id: &codex.thread_id,
            text: &text,
            images,
            client_user_message_id: turn_id,
            cwd: &codex.cwd,
            workspace_roots: &codex.workspace_roots,
            model: codex.model.as_deref(),
            effort: codex.effort.as_deref(),
            access: codex.access,
            runtime_context: &runtime,
        })
    } else {
        provider_for(session.agent)
            .user_message_payload(text, images)
            .ok_or("this chat does not take more input")?
    };
    session
        .stdin
        .as_ref()
        .ok_or("this chat does not take more input")?;
    session
        .auto_plan_attribution
        .prompt(session.agent, session.codex.is_some(), &mut payload);
    session
        .auto_plan_turn
        .prompt(session.codex.is_some(), &payload);
    manager.start_auto_plan_turn(session_key, session);
    let stdin = session.stdin.as_mut().expect("stdin checked above");
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    crate::team::note_roster_delivered(session_key, text);
    // Every turn this session is ever asked to do comes through here, so this
    // one line is the whole of "somebody is still using this chat".
    session.user_turn_id = turn_id.map(str::to_string);
    session.answering = turn_id.map(str::to_string);
    session.turn_started();
    Ok(())
}

/// Why `write_user_message_locked` refuses a process whose cut-off turn has
/// not reached its full stop. Every caller checks first and queues instead,
/// so nobody is meant to read this.
const STILL_STOPPING: &str = "this chat is still stopping its last turn";

/// Captured under the own writer's existing session lock. After that lock
/// is released, approval reads ONLY these atomics. Stop and every next turn
/// veto the old full stop, even if that next turn never changes the plan.
pub(crate) struct CleanTurnEnd {
    pub(crate) chat_key: String,
    launch_id: String,
    stop_epoch: Arc<std::sync::atomic::AtomicU64>,
    epoch: u64,
    turn_sequence: Arc<std::sync::atomic::AtomicU64>,
    sequence: u64,
}

pub(crate) const AUTO_PLAN_REVOKED: &str = "automatic plan approval was revoked";

impl CleanTurnEnd {
    /// The first ledger snapshot may use only evidence with no later turn
    /// and no intervening Stop. No chat or leaf-map lock is acquired here.
    pub(crate) fn unchanged(&self) -> bool {
        self.turn_sequence.load(std::sync::atomic::Ordering::SeqCst) == self.sequence
            && self.stop_epoch.load(std::sync::atomic::Ordering::SeqCst) == self.epoch
    }

    /// Linearization point after the staged write, immediately before rename.
    /// Bracket the epoch CAS with sequence checks. As the sequence only grows,
    /// equal checks prove no turn crossed that CAS; an earlier Stop or turn
    /// wins, and a later one does not undo an already committed decision.
    pub(crate) fn decide(&self) -> bool {
        debug_assert!(!self.launch_id.is_empty());
        self.turn_sequence.load(std::sync::atomic::Ordering::SeqCst) == self.sequence
            && self
                .stop_epoch
                .compare_exchange(
                    self.epoch,
                    self.epoch,
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                )
                .is_ok()
            && self.turn_sequence.load(std::sync::atomic::Ordering::SeqCst) == self.sequence
    }
}

fn end_turn_for_auto_plan(
    manager: &ChatManager,
    session_key: &str,
    stream_key: &str,
    session: &mut ChatSession,
    clean: bool,
    refused: bool,
) -> ((Option<WrapUpEnded>, Option<String>), Option<CleanTurnEnd>) {
    // Check BEFORE end_turn_locked clears the Stop marker. A host notification
    // is a normal turn here; a room seat's process key is never its chat key.
    let eligible = clean
        && !refused
        && !session.auto_plan_refused
        && !session.auto_plan_turn.refused()
        && session.auto_plan_turn.open_asks == 0
        && !session.codex.as_ref().is_some_and(|codex| {
            codex.elicitations.values().any(|p| session.codex_target_is_current(&p.target))
        })
        && session.auto_plan_attribution.attributable()
        // An earlier buffered result may have marked the host idle. Positive
        // native correlation still proves this prompt's end; Ready alone
        // needs busy so a duplicate full stop cannot create more evidence.
        && (session.busy || !matches!(session.auto_plan_attribution, AutoPlanAttribution::Ready))
        && session.cut_off == CutOff::No
        && session_key == stream_key;
    // Both maps are leaves. The epoch is captured before checking the
    // launch, so a concurrent replacement/removal cannot bless old evidence
    // with its new epoch. A naturally reaped one-shot may still own stdout.
    let stop_epoch = manager.stop_epoch(session_key);
    let epoch = stop_epoch.load(std::sync::atomic::Ordering::SeqCst);
    let turn_sequence = manager.turn_sequence(session_key);
    let sequence = turn_sequence.load(std::sync::atomic::Ordering::SeqCst);
    let current_launch = manager
        .auto_plan_launches
        .lock()
        .is_ok_and(|launches| launches.get(session_key) == Some(&session.launch_id));
    let successful_exit = session
        .child
        .try_wait()
        .is_ok_and(|exit| exit.is_none_or(|status| status.success()));
    let ended = (eligible && current_launch && successful_exit).then(|| CleanTurnEnd {
        chat_key: stream_key.into(),
        launch_id: session.launch_id.clone(),
        stop_epoch,
        epoch,
        turn_sequence,
        sequence,
    });
    if eligible {
        session.auto_plan_attribution = AutoPlanAttribution::Ready;
    } else if session.auto_plan_attribution.attributable()
        && !matches!(session.auto_plan_attribution, AutoPlanAttribution::Ready)
    {
        // The correlated turn ended unsuccessfully/refused. Its echo or native
        // completion cannot be reused to bless a later autonomous full stop.
        session.auto_plan_attribution = AutoPlanAttribution::Unattributed;
    }
    let result = end_turn_locked(manager, session_key, stream_key, session, clean);
    (result, ended)
}

/// A turn reached its full stop: end it, decide a completion whose wrap-up
/// it was, and hand over the next queued message, all under the session lock
/// the caller holds. Answers what the wrap-up decided (acted on once the
/// full stop is written down, `settle_wrap_up`) and why the next message
/// could not be written, if it could not.
///
/// The completion is decided BEFORE the queue moves: a message waiting
/// behind the wrap-up takes the chat back, and is handed over right here.
///
/// **Whose full stop it is.** The stream does not say, so the session does
/// (`CutOff`). After a Stop the next full stop is the cut-off turn's, and
/// nothing else has been written to the agent in between: `answering` is
/// still that turn, so no wrap-up can be decided by it, and what waited
/// behind it is handed over here. There is no later turn it could be taken
/// for, because none is written until this has been read.
///
/// A process ended for not stopping (`CutOff::Ended`) may still have a full
/// stop in its pipe. It ends nothing here: the queue and any completion are
/// the next process's by then.
fn end_turn_locked(
    manager: &ChatManager,
    session_key: &str,
    stream_key: &str,
    session: &mut ChatSession,
    clean: bool,
) -> (Option<WrapUpEnded>, Option<String>) {
    if session.cut_off == CutOff::Ended {
        return (None, None);
    }
    if let Some(codex) = session.codex.as_mut() {
        codex.active_turn_id = None;
    }
    session.cut_off = CutOff::No;
    session.turn_ended();
    let wrap_up = manager.completion_at_full_stop(session_key, session, clean);
    let refused = if manager.auto_resumes.waits(session_key) {
        None
    } else {
        dispatch_next_persistent_turn(manager, session_key, stream_key, session)
    };
    (wrap_up, refused)
}

/// Why a completion whose wrap-up was still waiting behind a stopped turn
/// is off when that turn's process is ended (`grace_ran_out`). A sentence of
/// the host's, which the page shows as given.
const COMPLETION_STOP_NOT_HONOURED: &str =
    "The agent did not stop, so its process was ended and the chat was not completed. Complete it again.";

/// The cut-off turn of `session` never sent its full stop and the grace of
/// unwind `unwind` is over: the Stop was not honoured, so the process is
/// ended. Nothing is written to it. An agent that has not stopped cannot be
/// given a turn whose full stop could be told from the one it still owes.
///
/// It is the idle sweeper's ending and a one-shot provider's Stop: the
/// transcript is on disk and the next process resumes the conversation by
/// id. What waited behind the stopped turn:
///
/// - **Messages are kept, and the first one starts in that next process**
///   straight away, the way a one-shot provider's queue is carried across
///   its Stop (`interrupt_session`). The rest stay queued behind it. Stop
///   still keeps the queue; it has only taken the grace longer.
/// - **A completion's wrap-up is not carried.** It was asked of the process
///   that is gone, so the completion fails once, in words the person can act
///   on, and nothing is ticked.
/// - **A host notification was never handed over** (`notification_ready`),
///   so it meets a chat with no process, as after any exit: the person's
///   chat is started again with it, and a worker's attempt has already
///   failed with its process (`worker_disconnected`).
///
/// One step under the session table and the session, like the full stop it
/// stands in for: whichever of the two takes the session first is the only
/// one that acts. Answers whether this call ended the process.
fn grace_ran_out(
    manager: &Arc<ChatManager>,
    session_key: &str,
    stream_key: &str,
    session: &Arc<Mutex<ChatSession>>,
    unwind: u64,
) -> bool {
    grace_ran_out_with(manager, session_key, stream_key, session, unwind, |turn| {
        start_queued_turn(manager.clone(), session_key, stream_key, turn, false)
    })
}

/// `grace_ran_out`, with how the first waiting message is started in the
/// next process left to the caller.
fn grace_ran_out_with(
    manager: &ChatManager,
    session_key: &str,
    stream_key: &str,
    session: &Arc<Mutex<ChatSession>>,
    unwind: u64,
    start: impl FnOnce(QueuedTurn) -> Result<(), String>,
) -> bool {
    let (agent, next) = {
        // The session table first, like every send and every start: nothing
        // joins or leaves the queue, and no process takes this key, while
        // this one is taken out.
        let Ok(mut sessions) = manager.sessions.lock() else {
            return false;
        };
        if !sessions
            .get(session_key)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            return false;
        }
        let Ok(mut guard) = session.lock() else {
            return false;
        };
        // The full stop came after all, or this is a later Stop's unwind
        // with a wait of its own.
        if guard.cut_off != CutOff::Owed(unwind) {
            return false;
        }
        guard.cut_off = CutOff::Ended;
        manager.fail_queued_wrap_up(session_key, stream_key, COMPLETION_STOP_NOT_HONOURED);
        let next = manager.take_queued_turn(session_key);
        if next.is_some() {
            manager
                .handoffs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session_key.to_string());
        }
        manager.revoke_auto_plan(session_key);
        sessions.remove(session_key);
        drop(sessions);
        stop_process(manager, session_key, &mut guard);
        (guard.agent, next)
    };
    println!("[chat] {session_key} ended: its agent did not stop within the grace of a Stop");
    if let Some(turn) = next {
        match carry_queued_turn(manager, session_key, stream_key, turn, start) {
            Ok(Carried::Started) => {}
            // The queue is whole and waits for the profile folder. The
            // process is gone all the same.
            Ok(Carried::Waits(_)) => say_exited(manager, session_key, stream_key),
            Err(why) => {
                // The process this ended had a successor on the way, so its
                // own reaper may have stayed quiet: say both things here.
                for (kind, text) in [
                    ("error", format!("could not resume queued message: {why}")),
                    ("exit", String::new()),
                ] {
                    emit_status(
                        agent,
                        ChatStatus {
                            key: stream_key.to_string(),
                            kind: kind.into(),
                            text,
                            code: None,
                        },
                    );
                }
            }
        }
    }
    true
}

/// Wait out the grace of the Stop that just cut a turn of `session` short,
/// then end the process if that turn's full stop never came
/// (`grace_ran_out`). One per unwind, and it acts for that unwind only: a
/// second Stop inside it starts no second wait and moves no deadline, and a
/// later Stop of the same chat has a number of its own.
fn end_process_when_grace_runs_out(
    manager: &Arc<ChatManager>,
    session_key: &str,
    stream_key: &str,
    session: &Arc<Mutex<ChatSession>>,
    unwind: u64,
) {
    #[cfg(test)]
    manager
        .unwind_probe
        .asked
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let Some(grace) = manager.unwind_grace() else {
        return;
    };
    let manager = manager.clone();
    let session = session.clone();
    let session_key = session_key.to_string();
    let stream_key = stream_key.to_string();
    thread::spawn(move || {
        thread::sleep(grace);
        grace_ran_out(&manager, &session_key, &stream_key, &session, unwind);
        #[cfg(test)]
        manager
            .unwind_probe
            .over
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
}

/// Act on a wrap-up's full stop once it is recorded: close the chat, or say
/// why the completion is off.
fn settle_wrap_up(
    manager: &ChatManager,
    key: &str,
    session: &Arc<Mutex<ChatSession>>,
    ended: WrapUpEnded,
) -> bool {
    match ended {
        WrapUpEnded::Close { turn_id, starts } => {
            conclude_completion(manager, key, session, &turn_id, starts)
        }
        WrapUpEnded::Off { turn_id, reason } => {
            announce_completed(key, &turn_id, Err(reason));
            false
        }
    }
}

/// Hand the next host-owned queue unit to a persistent provider at the exact
/// turn boundary. The caller holds the session lock from `turn_ended` through
/// this write, so an append either joins this unit first or becomes the next
/// unit; it can never mutate a prompt already being dispatched.
fn dispatch_next_persistent_turn(
    manager: &ChatManager,
    session_key: &str,
    stream_key: &str,
    session: &mut ChatSession,
) -> Option<String> {
    if !provider_for(session.agent)
        .capabilities()
        .input
        .accepts_stdin()
    {
        return None;
    }
    // Handing a message over starts a turn, and no turn starts while its
    // record cannot be kept: a send is refused then, a start is refused
    // then, and what is already queued waits here, whole and in order,
    // rather than run where nothing of it can be written down. It is
    // handed over once the folder is back (`start_waiting_queues`).
    if let Err(away) = crate::profile::available() {
        manager.keep_waiting(session_key, stream_key, None, &away);
        return None;
    }
    let turn = manager.take_queued_turn(session_key)?;
    let refused = write_user_message_locked(
        manager,
        session,
        session_key,
        &turn.text,
        &turn.images,
        turn.turn_id.as_deref(),
    )
    .err();
    if refused.is_some() {
        manager.fail_completion_of(session_key, &turn, COMPLETION_ENDED);
    }
    for turn_id in turn.turn_ids() {
        record_delivery(
            stream_key,
            Some(turn_id),
            if refused.is_some() {
                "failed"
            } else {
                "dispatched"
            },
        );
    }
    refused
}

fn write_user_message(
    manager: &ChatManager,
    session: &Arc<Mutex<ChatSession>>,
    text: &str,
    images: &[String],
    key: &str,
    session_key: &str,
    turn_id: Option<&str>,
) -> Result<(), String> {
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let result = write_user_message_locked(manager, &mut guard, session_key, text, images, turn_id);
    record_delivery(
        key,
        turn_id,
        if result.is_ok() {
            "dispatched"
        } else {
            "failed"
        },
    );
    result
}

/// Send the next person-visible turn to a running chat.
pub fn chat_send_user_impl(
    manager: Arc<ChatManager>,
    key: String,
    text: String,
    images: Option<Vec<String>>,
    to: Option<String>,
    turn_id: Option<String>,
    record_user: Option<bool>,
) -> Result<(), String> {
    chat_send_answering_impl(manager, key, text, images, to, turn_id, record_user, None)
}

/// `chat_send_user_impl` for a turn that may be an outage card's retry
/// (`answering`).
#[allow(clippy::too_many_arguments)]
pub fn chat_send_answering_impl(
    manager: Arc<ChatManager>,
    key: String,
    text: String,
    images: Option<Vec<String>>,
    to: Option<String>,
    turn_id: Option<String>,
    record_user: Option<bool>,
    answering: Option<String>,
) -> Result<(), String> {
    cancel_auto_resume(&manager, &key, "superseded by a user message");
    // A safety block is a choice about the NEXT user turn, not a tool call
    // OctiqFlow can resume. Any words the person sends supersede that card.
    // The one exception is the turn an outage card itself sends as its retry
    // (`answering`): that card is decided by the turn, and only once the
    // chat has taken it (`safety_block::person_turn`).
    let user_turn_id = (record_user != Some(false)).then(|| fresh_turn_id(turn_id));
    let chat = key.clone();
    crate::safety_block::person_turn(&chat, answering.as_deref(), || {
        chat_send_with_user_turn(manager, key, text, images, to, user_turn_id)
    })
}

/// Deliver a host-owned continuation without pretending that the person typed
/// it. Orchestration uses this for gate resolutions and coordinator messages:
/// a live provider receives the continuation immediately, while an idle
/// one-shot chat is resumed with the same saved session and permissions.
pub(crate) fn chat_continue_internal_impl(
    manager: Arc<ChatManager>,
    key: String,
    text: String,
) -> Result<(), String> {
    match chat_send_with_user_turn(manager.clone(), key.clone(), text.clone(), None, None, None) {
        Ok(()) => return Ok(()),
        Err(why) if why == "no such chat" || why.ends_with("is not running") => {}
        Err(why) => return Err(why),
    }

    let start = manager
        .start_context(&key)
        .ok_or_else(|| format!("chat '{key}' has no resumable start context"))?;
    manager.remember_start(&key, start.clone());
    start_session(
        manager,
        Voice::host(key),
        start.cwd,
        start.agent,
        start.model,
        start.access,
        Some(text),
        start.session_id,
        start.extra_dirs,
        start.env,
        start.effort,
        None,
        start.lite,
        None,
        false,
        None,
    )
}

/// The browser can start a coordinator before its first ordinary message, or
/// after a server restart. Existing live chats receive a host continuation;
/// otherwise launch with the person's selected settings and saved session.
#[allow(clippy::too_many_arguments)]
pub(crate) fn chat_start_master_impl(
    manager: Arc<ChatManager>,
    key: String,
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    prompt: String,
    handoff: Option<String>,
    resume: Option<String>,
    extra_dirs: Option<Vec<String>>,
    env: Option<std::collections::BTreeMap<String, String>>,
    effort: Option<String>,
    lite: Option<bool>,
) -> Result<(), String> {
    manager.orchestrations.require_user_chat(&key)?;
    if let Some(session) = &resume {
        manager.require_user_resume(session)?;
    }
    if manager.turn_in_flight(&key) {
        return Err("The main agent is working. Open Chat to give instructions, or continue here when its turn ends.".into());
    }
    let live = manager
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&key);
    if live {
        return chat_continue_internal_impl(manager, key, prompt);
    }
    chat_start_with_user_turn(
        manager,
        key,
        cwd,
        agent,
        model,
        access,
        Some(prompt),
        handoff,
        resume,
        extra_dirs,
        env,
        effort,
        None,
        lite,
        None,
    )
}

pub(crate) fn deliver_orchestration_notifications(
    manager: Arc<ChatManager>,
    notifications: &[crate::orchestration::inbox::Notification],
    env: std::collections::BTreeMap<String, String>,
) -> Result<bool, String> {
    deliver_orchestration_notification_with_start(
        manager,
        notifications,
        env,
        |manager, key, start, text, id| {
            start_session(
                manager,
                Voice::host(key),
                start.cwd,
                start.agent,
                start.model,
                start.access,
                Some(text),
                start.session_id,
                start.extra_dirs,
                start.env,
                start.effort,
                None,
                start.lite,
                Some(id),
                false,
                None,
            )
        },
    )
}

fn deliver_orchestration_notification_with_start(
    manager: Arc<ChatManager>,
    notifications: &[crate::orchestration::inbox::Notification],
    env: std::collections::BTreeMap<String, String>,
    start_notification: impl FnOnce(
        Arc<ChatManager>,
        String,
        StartContext,
        String,
        String,
    ) -> Result<(), String>,
) -> Result<bool, String> {
    crate::profile::available()?;
    let Some(first) = notifications.first() else {
        return Ok(false);
    };
    let key = &first.target_chat_key;
    if notifications.iter().any(|n| n.target_chat_key != *key) {
        return Err("A notification batch must belong to one chat.".into());
    }
    let receipt = notifications
        .iter()
        .map(|n| n.id.as_str())
        .collect::<Vec<_>>()
        .join("|");
    let notices = notifications
        .iter()
        .map(|n| {
            format!(
                "OctiqFlow notification {} for run {}.\n\n{}",
                n.id, n.run_id, n.body
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let text = format!("{notices}\n\nThis is a batch of host notifications, not a new user instruction. Re-read orchestration_snapshot before taking action; delivery can repeat after an interrupted receipt. Respect the person's latest instructions. If you are the coordinator, handle the batch in one turn, dispatch work asynchronously, then end your turn so the person can keep chatting; the host will notify you when something needs attention. If you are a worker, continue only your active assigned attempt and report when it settles.");
    {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if manager.has_queued_turns(key)
            || manager
                .handoffs
                .lock()
                .map_err(|e| e.to_string())?
                .contains(key)
        {
            return Ok(false);
        }
        if let Some(session) = sessions.get(key) {
            let mut session = session.lock().map_err(|e| e.to_string())?;
            // Read under the session lock, which the interrupt that sets it
            // and the full stop that clears it both hold.
            if session.busy
                || session.cut_off != CutOff::No
                || !provider_for(session.agent)
                    .capabilities()
                    .input
                    .accepts_stdin()
            {
                return Ok(false);
            }
            write_user_message_locked(&manager, &mut session, key, &text, &[], Some(&receipt))?;
            return Ok(true);
        }
    }
    let _claim = manager.hold_start(key)?;
    let meta = crate::chat_index::list()
        .into_iter()
        .find(|m| format!("chat:{}", m.id) == *key)
        .ok_or("The target chat is unavailable.")?;
    let mut start = if let Some(start) = manager.start_context(key) {
        start
    } else {
        let saved = manager
            .orchestrations
            .saved_resume_context(key)
            .ok_or("Resume the main chat once to restore its provider settings.")?;
        if saved.session_id != meta.session_id
            || meta.access.as_deref()
                != saved
                    .access
                    .and_then(|a| serde_json::to_value(a).ok())
                    .as_ref()
                    .and_then(Value::as_str)
        {
            return Err("The chat's saved settings changed. Continue it in Chat before automatic notification delivery.".into());
        }
        saved
    };
    // A rejected browser start used to poison the saved cwd while its real
    // process kept running. Repair only to the coordinator's recorded run
    // root when the index agrees, and never resume inside a worker's lease.
    start.cwd = manager.orchestrations.notification_resume_cwd(
        key,
        &first.run_id,
        &start.cwd,
        meta.cwd.as_deref(),
    )?;
    start.env = Some(env);
    manager.remember_start(key, start.clone());
    start_notification(manager.clone(), key.clone(), start, text, receipt)?;
    Ok(true)
}

pub(crate) fn chat_can_continue_internal(manager: &ChatManager, key: &str) -> Result<bool, String> {
    if manager
        .sessions
        .lock()
        .map_err(|error| error.to_string())?
        .contains_key(key)
    {
        return Ok(true);
    }
    Ok(manager.start_context(key).is_some())
}

/// What became of a turn that was sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sent {
    /// Written to the agent: it has the turn.
    Written,
    /// Behind a turn that is running, a stopped one that has not sent its
    /// full stop, or anything already queued.
    Queued,
    /// The record already holds this turn id: a retry of a send that got
    /// through. Nothing was sent again.
    Already,
}

fn chat_send_with_user_turn(
    manager: Arc<ChatManager>,
    key: String,
    text: String,
    images: Option<Vec<String>>,
    to: Option<String>,
    user_turn_id: Option<String>,
) -> Result<(), String> {
    send_turn(manager, key, text, images, to, user_turn_id).map(|_| ())
}

/// What became of a host turn `wake_chat` tried to hand over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Woken {
    /// The agent has it, or it waits in the host's queue for it.
    Handed,
    /// It never will: the chat is no longer listed.
    Gone,
    /// Not now, and why: to be tried again.
    Later(String),
}

/// Hand a chat's agent one turn in the host's words, under `turn_id`: the
/// turn that wakes it when a job ends (`chat_jobs`). It waits like any
/// message (`send_turn`): written between turns, queued behind a running
/// one, a Stop whose full stop is owed, or anything queued. A chat with no
/// process is started with it as its first message, from the settings it
/// last ran with in this server; one this server has not run is `Later`,
/// and is woken once it runs again.
///
/// The caller asks `host_turns` first: this sends.
pub(crate) fn wake_chat(
    manager: &Arc<ChatManager>,
    key: &str,
    turn_id: &str,
    text: &str,
) -> Result<Woken, String> {
    match send_turn(
        manager.clone(),
        key.to_string(),
        text.to_string(),
        None,
        None,
        Some(turn_id.to_string()),
    ) {
        Ok(_) => return Ok(Woken::Handed),
        Err(why) if why == "no such chat" => {}
        Err(why) => return Ok(Woken::Later(why)),
    }
    match crate::chat_index::listed_ids() {
        Ok(ids) if !ids.contains(key.strip_prefix("chat:").unwrap_or(key)) => {
            return Ok(Woken::Gone)
        }
        Err(why) => return Ok(Woken::Later(why)),
        Ok(_) => {}
    }
    let Some(start) = manager.start_context(key) else {
        return Ok(Woken::Later(
            "the chat is not running and has not run since OctiqFlow started".into(),
        ));
    };
    match start_session(
        manager.clone(),
        Voice::host(key.to_string()),
        start.cwd,
        start.agent,
        start.model,
        start.access,
        Some(text.to_string()),
        start.session_id,
        start.extra_dirs,
        start.env,
        start.effort,
        None,
        start.lite,
        Some(turn_id.to_string()),
        true,
        None,
    ) {
        Ok(()) => Ok(Woken::Handed),
        Err(why) => Ok(Woken::Later(why)),
    }
}

/// What became of a turn the host handed, or tried to hand, a chat's agent
/// under an id of its own (`wake_chat`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum HostTurn {
    /// The agent has it, or it waits in the host's queue for it.
    Handed,
    /// It will not reach the agent: the person took it back from the
    /// queue, it was marked not sent, or the queue it waited in was a
    /// server's that is gone.
    Gone,
}

/// What became of every host turn of the chat `key` whose id starts with
/// `prefix`, by id, read from what the chat's record and the host's queue
/// hold now. An id that is not in the answer left no trace: that turn was
/// never handed over.
///
/// This is the receipt a caller that must tell an agent something ONCE
/// asks before it sends, and it holds across a restart: nothing here is
/// kept in memory but the queue itself. A turn's lines in the record are
/// the ones every send writes, in the order they happen: the turn itself
/// (`octiq_user_turn`), how it was delivered (`queued`, `dispatched`,
/// `starting`, `failed`, `unknown`), and its taking back (`cancelled`,
/// `dismissed`).
///
/// - Taken back, or `failed` last: **gone**.
/// - `queued` last: **handed** while it is still in the host's queue or
///   being carried into the next process, **gone** otherwise. The queue is
///   in memory, so that is a turn a server queued and did not live to hand
///   over.
/// - An envelope alone, with no queue or host-memory evidence: **uncertain**;
///   the read fails in words, never marks it told and never resends it.
/// - Other delivery evidence: **handed**. That includes `unknown`, a process that
///   ended before it said it had the turn: the words may have reached the
///   agent, so they are never sent a second time for the host.
///
/// Read under the locks every hand-over of a queued turn is made under
/// (the session table for a one-shot agent's, the session for a persistent
/// one's). Under them a turn is in the queue, or being carried
/// (`handoffs`), or its `dispatched` or `failed` line is in the record:
/// never between two of those, where it would read as lost and be sent
/// again.
///
/// **`here` is a turn this server knows it handed over itself**
/// and the record is not asked whether it did.
/// The turn's lines are written best effort, so a record that took none of
/// them, or took `queued` and not the `dispatched` that followed, says
/// nothing or says less than happened. For that turn only a line that says
/// it is gone makes it so (taken back, `failed`): with no line it is
/// **handed**, and `queued` last with the queue no longer holding it is
/// this server's queue having let it go, which is a turn written to the
/// agent whose `dispatched` line the record refused, or one dropped whose
/// "not sent" line it refused. Those two cannot be told apart, and the
/// words may be with the agent, so it is **handed**: never sent a second
/// time for the host.
pub(crate) fn host_turns(
    manager: &ChatManager,
    key: &str,
    prefix: &str,
    here: Option<&str>,
) -> Result<std::collections::BTreeMap<String, HostTurn>, String> {
    #[derive(Default)]
    struct Seen {
        received: bool,
        taken_back: bool,
        delivery: Option<String>,
    }
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(key).cloned();
    let _session = match &session {
        Some(session) => Some(session.lock().map_err(|e| e.to_string())?),
        None => None,
    };
    let mut seen: std::collections::BTreeMap<String, Seen> = Default::default();
    // A record that cannot be read is an error, never one that holds no
    // turn: that would read as "never handed over" and send it again.
    for item in crate::transcript::every_line(key)? {
        let event = item.event;
        let ours = |id: &&str| id.starts_with(prefix);
        // The provider's own acknowledgement of the prompt.
        if let Some(id) = event["octiq_user_turn_id"].as_str().filter(ours) {
            seen.entry(id.to_string()).or_default().received = true;
        }
        let Some(id) = event["uuid"].as_str().filter(ours) else {
            continue;
        };
        match event["type"].as_str() {
            Some("user") if event["octiq_user_turn"] == true => {
                seen.entry(id.to_string()).or_default();
            }
            Some("octiq_user_turn_delivery") => {
                seen.entry(id.to_string()).or_default().delivery =
                    event["state"].as_str().map(str::to_string);
            }
            Some("octiq_user_turn_cancelled" | "octiq_user_turn_dismissed") => {
                seen.entry(id.to_string()).or_default().taken_back = true;
            }
            _ => {}
        }
    }
    let carried = manager
        .handoffs
        .lock()
        .map_err(|e| e.to_string())?
        .contains(key);
    let queued = manager.queued_turns.lock().map_err(|e| e.to_string())?;
    let waits = |id: &str| {
        here == Some(id)
            || carried
            || queued
                .get(key)
                .is_some_and(|queue| queue.iter().any(|turn| turn.owns_turn_id(id)))
    };
    if let Some(here) = here.filter(|id| id.starts_with(prefix)) {
        seen.entry(here.to_string()).or_default();
    }
    Ok(seen
        .into_iter()
        .map(|(id, turn)| -> Result<_, String> {
            // An envelope precedes the write. It is not a transport receipt:
            // the failed-write line may itself have failed to append.
            if !turn.taken_back && !turn.received && turn.delivery.is_none()
                && !waits(&id)
            {
                return Err(format!("Host turn {id} has only an envelope; its handover is uncertain. It has not been marked told or sent again. Check the conversation before retrying."));
            }
            let gone = turn.taken_back
                || (!turn.received
                    && match turn.delivery.as_deref() {
                        Some("failed") => true,
                        Some("queued") => !waits(&id),
                        _ => false,
                    });
            let fate = if gone {
                HostTurn::Gone
            } else {
                HostTurn::Handed
            };
            Ok((id, fate))
        })
        .collect::<Result<_, _>>()?)
}

/// Send one turn. A chat with no process while another thread's start of it
/// is under way (a second tab, `chat_recover`'s claim, an auto-resume, a
/// queued start) is neither running nor startable: the start refuses with
/// "already running" and the plain send used to refuse with "no such chat".
/// So the send waits for that start to end, holding no lock, and looks once
/// more: the session is there (written or queued as usual) or it is not and
/// the answer is the same "no such chat". Nothing is queued for a start that
/// may fail, and a retry is safe: the user turn id's durable envelope makes
/// the second look return `Sent::Already` if the first got through.
fn send_turn(
    manager: Arc<ChatManager>,
    key: String,
    text: String,
    images: Option<Vec<String>>,
    to: Option<String>,
    user_turn_id: Option<String>,
) -> Result<Sent, String> {
    let first = send_turn_once(
        manager.clone(),
        key.clone(),
        text.clone(),
        images.clone(),
        to.clone(),
        user_turn_id.clone(),
    );
    match first {
        Err(why) if why == "no such chat" && manager.start_in_progress(&key) => {
            manager.wait_out_start(&key, START_WAIT);
            send_turn_once(manager, key, text, images, to, user_turn_id)
        }
        other => other,
    }
}

fn send_turn_once(
    manager: Arc<ChatManager>,
    key: String,
    text: String,
    images: Option<Vec<String>>,
    to: Option<String>,
    user_turn_id: Option<String>,
) -> Result<Sent, String> {
    if to.is_some() {
        return Err("additional agents are no longer supported".into());
    }
    // As for a start: a message whose record cannot be kept is not sent.
    crate::profile::available()?;
    if let Some(start) = manager.start_context(&key) {
        registered_runtime::require_current(&key, &start)?;
        manager.admit_beside_writers(
            &key,
            &key,
            std::iter::once(&start.cwd).chain(start.extra_dirs.iter().flatten()),
            start.access != Some(Access::Read),
        )?;
    }
    let images = images.unwrap_or_default();
    let session_key = key.clone();
    {
        // A command-line follow-up and its reaper share this lock order.
        // Holding the sessions entry until the turn reaches the queue means the
        // reaper either sees that queued turn or this call sees no session and
        // the client starts a normal resume — never a successful send that
        // vanishes in between.
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        require_scheduled_turn(&manager, &session_key, user_turn_id.as_deref())?;
        // Browser reconnects and ambiguous RPC retries reuse their stable turn
        // id. The canonical envelope is the durable acceptance receipt, so a
        // retry never creates a second queue unit or dispatches the same words
        // after the first unit has already left the queue. A record that
        // cannot be read cannot say, and the words are not sent on a guess.
        let already = match user_turn_id.as_deref() {
            Some(turn_id) => durable_user_turn_exists(&key, turn_id)?,
            None => false,
        };
        if already {
            return Ok(Sent::Already);
        }
        let Some(session) = sessions.get(&session_key).cloned() else {
            // A queue that waits for the profile folder (`keep_waiting`) is
            // a queue like any other: this message joins it at the back,
            // and the host starts the first one (`start_waiting_queues`).
            if manager
                .handoffs
                .lock()
                .map_err(|e| e.to_string())?
                .contains(&session_key)
                || manager.waits_because(&session_key).is_some()
            {
                // The process this would ride is not started for an agent
                // that is being removed (`start_session`), so it is not
                // queued for one either.
                if let Some(leaving) = manager.leaving_refusal(&session_key) {
                    return Err(leaving);
                }
                queue_waiting_turn(
                    &manager,
                    &session_key,
                    &key,
                    &text,
                    &images,
                    user_turn_id.clone(),
                )?;
                return Ok(Sent::Queued);
            }
            return Err("no such chat".into());
        };

        // Nothing goes to an agent that is not ready for it, and nothing goes
        // around anything already waiting. Three reasons, one queue:
        //
        // A command-line provider's stdin is deliberately `null` — an open pipe
        // can make a one-shot command wait for more prompt text forever — so it
        // is never ready. A persistent provider is ready, but only between
        // turns: write to it mid-answer and the message lands in the agent's own internal
        // queue, out of this backend's reach and past taking back. And a queue
        // with anything in it is reason enough on its own — see
        // `has_queued_turns`, which is what a Stop leaves behind.
        //
        // A Stop leaves one more thing behind: a turn that reads idle and has
        // not sent its own full stop yet (`CutOff`). Written
        // now, this message would be the turn that full stop ends, and the
        // agent would work on it with the session read as idle. It waits
        // for that full stop like anything else queued.
        {
            let mut guard = session.lock().map_err(|e| e.to_string())?;
            // Before the message is written down or queued: an agent that
            // is being removed takes none (`Leaving`). The write below
            // would refuse it too, after the bubble was on record.
            guard.not_leaving()?;
            let one_shot = !provider_for(guard.agent)
                .capabilities()
                .input
                .accepts_stdin();
            if one_shot
                || guard.busy
                || guard.cut_off != CutOff::No
                || manager.has_queued_turns(&session_key)
            {
                // Every provider gets the same durable queue envelope. Native
                // echoes reconcile by the exact turn id when it is dispatched.
                queue_waiting_turn(
                    &manager,
                    &session_key,
                    &key,
                    &text,
                    &images,
                    user_turn_id.clone(),
                )?;
                // A queued turn is still work the person is waiting for. This also
                // prevents the idle sweeper from ending the process in the handoff
                // before its reaper starts the resume.
                if !guard.busy {
                    guard.busy = true;
                    guard.last_active = Instant::now();
                }
                return Ok(Sent::Queued);
            }
            if let Some(turn_id) = user_turn_id.as_deref() {
                record_durable_user_turn(&key, turn_id, &text, &images);
            }
            let result = write_user_message_locked(
                &manager,
                &mut guard,
                &session_key,
                &text,
                &images,
                user_turn_id.as_deref(),
            );
            record_delivery(
                &key,
                user_turn_id.as_deref(),
                if result.is_ok() {
                    "dispatched"
                } else {
                    "failed"
                },
            );
            result.map(|()| Sent::Written)
        }
    }
}

/// Put one send behind the active turn and record exactly how it joined the
/// host-owned queue. Callers hold the session-map lock (and, for a live
/// process, the session lock), which serializes this append with take/cancel.
fn queue_waiting_turn(
    manager: &ChatManager,
    session_key: &str,
    stream_key: &str,
    text: &str,
    images: &[String],
    turn_id: Option<String>,
) -> Result<(), String> {
    let outcome = manager.queue_turn(
        session_key,
        QueuedTurn {
            text: text.to_string(),
            images: images.to_vec(),
            turn_id: turn_id.clone(),
            appended_turn_ids: Vec::new(),
            recorded: turn_id.is_some(),
            context: manager.queue_context(session_key),
        },
    )?;
    let Some(turn_id) = turn_id.as_deref() else {
        return Ok(());
    };
    if outcome == QueueTurnResult::Duplicate {
        return Ok(());
    }
    let append_to = match &outcome {
        QueueTurnResult::Appended { target, .. } => Some(target.as_str()),
        _ => None,
    };
    record_durable_user_turn_with_append(stream_key, turn_id, text, images, append_to);
    record_delivery(stream_key, Some(turn_id), "queued");
    if let QueueTurnResult::Appended { target, source } = outcome {
        manager.join_person_turn(stream_key, &target, &source);
        record_appended_turn(stream_key, &target, &source);
    }
    Ok(())
}

/// Take back a message the agent has not been given yet.
///
/// Only ever a message still in this backend's own queue. Once it has been
/// written to the agent it belongs to the agent, and the honest answer is that
/// it is too late — so this reports whether there was anything to cancel rather
/// than pretending either way.
///
/// A queued turn was written into the transcript at the moment it was sent
/// (see `QueuedTurn::recorded`), so cancelling it has to
/// take it back out. The record is append-only, so "out" is one more line
/// saying so, which every reader — live, another tab, or a replay next week —
/// folds the same way.
pub fn chat_cancel_queued_impl(
    manager: &ChatManager,
    key: String,
    turn_id: String,
) -> Result<bool, String> {
    // Serialize with enqueue + its durable event, and with process handoffs.
    let _sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let Some(cancelled) = manager.cancel_queued_turn(&key, &turn_id) else {
        return Ok(false);
    };
    announce_cancelled(&key, &cancelled);
    // The ✕ on a queued wrap-up takes the completion back.
    manager.fail_completion_of(&key, &cancelled, COMPLETION_CANCELLED);
    Ok(true)
}

/// Remove a user turn that a connected client has established is no longer in
/// any backend queue.
///
/// Unlike cancelling a live queued turn, dismissing must not put the words
/// back in the composer. It therefore has its own append-only event. Requiring
/// the transcript write before announcing success keeps the message gone after
/// a reload, while the queue check prevents a stale UI from discarding work
/// the backend still holds.
pub fn chat_dismiss_unsent_impl(
    manager: &ChatManager,
    key: String,
    turn_id: String,
) -> Result<bool, String> {
    if manager.queued_turn_session_key(&key, &turn_id).is_some() {
        return Ok(false);
    }
    // A turn the agent has taken up is not unsent, whatever the page heard:
    // dismissing it would write `dismissed` over an answered message. The
    // page keeps its bubble and learns the truth from `chat_turn_delivery`.
    // The check and the append are one step against the record: a pickup that
    // lands after the read, or a record published during it, writes nothing
    // (`turn_delivery::append_unless_picked_up`).
    let mut event = json!({ "type": "octiq_user_turn_dismissed", "uuid": turn_id });
    crate::transcript::stamp(&mut event);
    let Some(seq) = crate::turn_delivery::append_unless_picked_up(&key, &turn_id, &event)? else {
        return Ok(false);
    };
    crate::bus::emit(
        "chat-event",
        ChatEvent {
            key,
            seq: Some(seq),
            event,
        },
    );
    Ok(true)
}

/// Stop the current turn and make one selected queued message the next turn.
///
/// This is deliberately addressed by user-turn id rather than by queue
/// position. Several messages may be waiting; the bubble the person clicked is
/// the only unambiguous target. Messages that were ahead of it remain queued
/// behind it.
///
/// `false` means the agent already took the message before the click arrived.
/// In that race there is nothing left to promote or interrupt, and the page can
/// simply wait for the answer already in flight.
pub fn chat_start_queued_impl(
    manager: &Arc<ChatManager>,
    key: String,
    turn_id: String,
) -> Result<bool, String> {
    let Some(session_key) = manager.queued_turn_session_key(&key, &turn_id) else {
        return Ok(false);
    };

    // Hold the session map and this process together across the promotion and
    // interrupt. A persistent reader takes the session lock before dequeuing;
    // a one-shot reaper takes the sessions map before doing the same. Neither
    // can pick the selected message up in the gap and then be interrupted AS
    // that message, which would turn "send now" into "cancel what I clicked".
    let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let Some(session) = sessions.get(&session_key).cloned() else {
        // A queue that waits for the profile folder has no process to
        // stop: the chosen message goes to the front, and starts first
        // when the folder is back.
        if manager.waits_because(&session_key).is_some() {
            return Ok(manager.promote_queued_turn(&key, &turn_id).is_some());
        }
        // The one-shot reaper is already carrying it into the next process.
        return Ok(false);
    };
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    if manager.promote_queued_turn(&key, &turn_id).as_deref() != Some(session_key.as_str()) {
        return Ok(false);
    }

    let agent = guard.agent;
    if !relaunches_to_continue(agent) {
        interrupt_persistent_turn(manager, &session_key, &mut guard)?;
        manager.completion_cut_short(&session_key, &guard, COMPLETION_STOPPED);
        record_delivery(&key, Some(&turn_id), "starting");
        return Ok(true);
    }

    // A command-line provider cannot be interrupted over stdin. Remove this
    // exact process while the sessions lock still fences its reaper, carry the
    // promoted turn across the kill, then resume it outside the locks.
    let Some(next) = manager.take_queued_turn(&session_key) else {
        return Ok(false);
    };
    manager.completion_cut_short(&session_key, &guard, COMPLETION_STOPPED);
    manager
        .handoffs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_key.clone());
    manager.revoke_auto_plan(&session_key);
    guard.cut_off = CutOff::Ended;
    sessions.remove(&session_key);
    guard.stdin.take();
    let _ = guard.child.kill();
    drop(guard);
    drop(sessions);

    match start_queued_command_turn(manager.clone(), &session_key, &key, next) {
        Ok(Carried::Started) => {}
        // The turn ahead was stopped and the chosen message is first in
        // line, with the others behind it; it starts when the profile
        // folder is back (`start_waiting_queues`).
        Ok(Carried::Waits(_)) => say_exited(manager, &session_key, &key),
        Err(why) => return Err(format!("could not resume queued message: {why}")),
    }
    Ok(true)
}

/// What [`interrupt_worker_turn`] did to a worker's turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkerInterrupt {
    /// Its turn was cut short; the message starts its next one.
    Interrupted,
    /// No turn was in flight; the message goes in between turns.
    Idle,
    /// Only ending its process would stop this provider, and that fails the
    /// attempt. The message waits for its next call to OctiqFlow.
    Unsupported,
}

/// How a raise that cannot be recorded is refused, before the reason. The
/// page knows the refusal by these words (`web/src/lib/accessRaise.ts`): it
/// keeps the card that asked open and does not restart the agent.
pub(crate) const NOT_RAISED: &str = "The access level was not raised, and nothing was changed: ";

/// What the host asks an agent to do when the person completes its chat.
///
/// The wording is the host's, never the page's. Two steps are left out when
/// they cannot apply: only a registered agent has an agent memory, and only a
/// chat that coordinates a run has one to stop. The steps are numbered as
/// they are sent.
pub(crate) fn wrap_up_message(registered_agent: bool, runs: &[String]) -> String {
    let mut steps = vec![
        "Work: commit any uncommitted work on the current branch with a conventional message, or say why it stays uncommitted. Do not push, merge, release or restart unless this chat was already told to.".to_string(),
        "Clean up: delete temporary files you created and stop any sandbox or background process you started. Remove a task worktree and its branch ONLY when git shows that branch merged into its target; otherwise leave both and say so.".to_string(),
    ];
    if registered_agent {
        steps.push("Memory: if anything is worth keeping for a later session (a decision and why, a gotcha, what to pick up next), save it with vault_agent_memory_append; skip this when there is nothing.".into());
    }
    if !runs.is_empty() {
        let named = match runs {
            [run] => format!("orchestration run {run}"),
            runs => format!("orchestration runs {}", runs.join(", ")),
        };
        let it = if runs.len() == 1 { "it" } else { "each" };
        steps.push(format!("Run: this chat coordinates {named}. Stop {it} with orchestration_run_stop once no worker is running. Leave the mission worktree; the person closes the mission."));
    }
    steps.push("Report in at most ten lines: Done, Not done, Remaining risks.".into());
    let mut message = String::from(
        "The person is completing this chat. Wrap up now, in this order, and start no new work.\n",
    );
    for (at, step) in steps.iter().enumerate() {
        message.push_str(&format!("{}. {step}\n", at + 1));
    }
    message.push_str(
        "When this turn ends the chat is marked done and its process stops; a new message reopens it.",
    );
    message
}

/// What `chat_complete` answers: the wrap-up turn, and whether the agent has
/// it (`started`) or it waits behind a turn that is running, or was stopped
/// and has not sent its own full stop yet (`queued`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completing {
    pub turn_id: String,
    pub state: &'static str,
}

/// What `chat_complete` says about a chat with no process when it was given
/// no settings to start one with. The page answers it by asking again with
/// `start`.
pub(crate) fn completion_needs_start(key: &str) -> String {
    format!("chat '{key}' is not running")
}

fn completion_turn_id() -> String {
    format!("{COMPLETION_TURN_PREFIX}{}", uuid::Uuid::new_v4())
}

/// Whether this process key is a chat's own agent, as its launch recorded it
/// (`LaunchCapability`). A second voice in a chat runs under a key of its
/// own. A key with no live launch says nothing either way.
pub(crate) fn is_own_voice(manager: &ChatManager, key: &str) -> bool {
    manager
        .capabilities
        .lock()
        .map(|launches| {
            launches
                .get(key)
                .is_none_or(|launch| launch.chat_key == key)
        })
        .unwrap_or(false)
}

/// Complete a chat that has a live process: hand its agent the wrap-up turn,
/// behind whatever is running.
///
/// The wrap-up WAITS. With a turn in flight, a stopped turn that has not
/// sent its full stop yet, or anything already queued, it joins the host's
/// queue like any message, so the ✕ on its bubble takes the completion back
/// (`chat_cancel_queued_impl`) and "send this one now" is the person's own
/// interrupt (`chat_start_queued_impl`). What happens at its full stop is
/// `ChatManager::completion_at_full_stop`.
///
/// `chat-completing` is said the moment the completion is recorded
/// (`begin_completion`), before the wrap-up is written or queued. When that
/// then fails the completion ends where it began, with the error as the
/// reason, and the error is this call's answer too.
///
/// `Ok(None)` is a chat with no process: the caller starts it with the
/// wrap-up as its first message (`claim_completion`), the way a send to a
/// chat that is not running starts it.
pub fn chat_complete_impl(
    manager: &Arc<ChatManager>,
    key: &str,
    text: &str,
) -> Result<Option<Completing>, String> {
    crate::lead_threads::require_disposable(key.strip_prefix("chat:").unwrap_or(key))?;
    cancel_auto_resume(manager, key, "superseded by completing the chat");
    let turn_id = completion_turn_id();
    let state = {
        // The send path's locks, in its order: the reaper either sees the
        // queued wrap-up or this call sees no session.
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        let queue = || {
            manager.begin_completion(key, &turn_id, "queued")?;
            queue_waiting_turn(manager, key, key, text, &[], Some(turn_id.clone())).inspect_err(
                |why| {
                    manager.abandon_completion(key, &turn_id, why);
                },
            )
        };
        match sessions.get(key).cloned() {
            None => {
                if !manager
                    .handoffs
                    .lock()
                    .map_err(|e| e.to_string())?
                    .contains(key)
                {
                    if manager.completing_turn(key).is_some() {
                        return Err(ALREADY_COMPLETING.into());
                    }
                    return Ok(None);
                }
                // A one-shot process is being replaced; its queue is live.
                queue()?;
                "queued"
            }
            Some(session) => {
                let mut guard = session.lock().map_err(|e| e.to_string())?;
                let one_shot = !provider_for(guard.agent)
                    .capabilities()
                    .input
                    .accepts_stdin();
                // A turn that was stopped and has not sent its own full stop
                // yet reads idle (`CutOff`). The wrap-up
                // waits behind it like behind any turn: written now, that
                // late full stop would be taken for the wrap-up's, and a
                // clean one would tick the chat and stop an agent that had
                // not wrapped anything up (review of 2fd3231, H2).
                if one_shot
                    || guard.busy
                    || guard.cut_off != CutOff::No
                    || manager.has_queued_turns(key)
                {
                    queue()?;
                    if !guard.busy {
                        guard.busy = true;
                        guard.last_active = Instant::now();
                    }
                    "queued"
                } else {
                    manager.begin_completion(key, &turn_id, "started")?;
                    record_durable_user_turn(key, &turn_id, text, &[]);
                    let written = write_user_message_locked(
                        manager,
                        &mut guard,
                        key,
                        text,
                        &[],
                        Some(&turn_id),
                    );
                    record_delivery(
                        key,
                        Some(&turn_id),
                        if written.is_ok() {
                            "dispatched"
                        } else {
                            "failed"
                        },
                    );
                    written.inspect_err(|why| {
                        manager.abandon_completion(key, &turn_id, why);
                    })?;
                    "started"
                }
            }
        }
    };
    // A wrap-up the agent has taken supersedes a refusal card, as any turn
    // of the person's does.
    crate::safety_block::forget_chat(key);
    Ok(Some(Completing { turn_id, state }))
}

impl ChatManager {
    /// Mark a chat with no process as completing, for the start that is
    /// about to hand it the wrap-up as its first message. Answers the
    /// wrap-up's turn id. Refused while the chat runs, in `start_session`'s
    /// words, so the caller goes back to `chat_complete_impl`.
    ///
    /// Announced here (`started`), not once the start has succeeded: the
    /// process that start spawns can end the completion before the start
    /// returns, and that end has to come second.
    pub(crate) fn claim_completion(&self, key: &str) -> Result<String, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(key)
            || self
                .handoffs
                .lock()
                .map_err(|e| e.to_string())?
                .contains(key)
        {
            return Err(format!("chat '{key}' is already running"));
        }
        let turn_id = completion_turn_id();
        self.begin_completion(key, &turn_id, "started")?;
        Ok(turn_id)
    }

    /// The start `claim_completion` was made for has the wrap-up, or failed.
    /// One that failed ends the completion it had announced, with why.
    pub(crate) fn settle_claimed_completion(
        &self,
        key: &str,
        turn_id: &str,
        started: &Result<(), String>,
    ) {
        if let Err(why) = started {
            self.abandon_completion(key, turn_id, why);
        }
    }
}

/// How many of an Antigravity conversation's refusals this process has seen.
///
/// Its `result` lists every refusal of the whole conversation, so only the
/// ones past the previous `result`'s count ended THIS turn. A process that
/// resumed a conversation has no previous count, and reads the first
/// `result` that lists any as a refusal: an unverified wrap-up is not ticked.
#[derive(Default)]
struct DeniedActions(usize);

impl DeniedActions {
    fn newly_refused(&mut self, event: &Value) -> bool {
        let Some(denied) = event
            .pointer("/result/denied_actions")
            .and_then(Value::as_array)
        else {
            return false;
        };
        let before = std::mem::replace(&mut self.0, denied.len());
        denied.len() > before
    }
}

/// How a Pi turn ended, kept by the reader while the turn runs.
///
/// Pi's full stop (`agent_settled`) says only whether the run was aborted: a
/// model call that failed for good is in the assistant message before it
/// (`stopReason: "error"`), and one that failed and was retried is followed by
/// more messages. So the LAST assistant message of the turn decides: only
/// `stop` is a turn that finished what it was asked. No assistant message at
/// all, an aborted run and a prompt Pi refused (`octiq_rejected_prompt`, said
/// as a failed message) are not clean. The state is the turn's own and is
/// cleared by its full stop, so one turn's failure is never the next one's.
#[derive(Default)]
struct PiTurn {
    /// `stopReason` of the last assistant message so far.
    last_stop: Option<String>,
}

impl PiTurn {
    /// Every event of the stream, adapted. Only a finished assistant message
    /// says anything; a system or user message and a streaming update do not.
    fn observe(&mut self, event: &Value) {
        if event.get("type").and_then(Value::as_str) != Some("message_end") {
            return;
        }
        let Some(message) = event.get("message") else {
            return;
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        self.last_stop = Some(
            message
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        );
    }

    /// Asked of the event that ends a turn, after `observe`: whether the turn
    /// ended badly. Takes the turn's state with it.
    fn ended_badly(&mut self, event: &Value) -> bool {
        let last = self.last_stop.take();
        event.get("aborted").and_then(Value::as_bool) == Some(true)
            || last.as_deref() != Some("stop")
    }
}

/// Whether a full stop is the agent finishing what it was asked, rather than
/// a failure, a refusal or a turn that was cut short. A completion ticks its
/// chat only on this.
///
/// `refused` is evidence the full stop does not carry itself: Antigravity's
/// refusals past the previous `result`'s count, and Pi's last assistant
/// message not having ended normally (`PiTurn`).
fn ended_cleanly(agent: ChatAgent, event: &Value, refused: bool) -> bool {
    let text = |name: &str| event.get(name).and_then(Value::as_str);
    match agent {
        ChatAgent::Antigravity => {
            !refused && event.pointer("/result/status").and_then(Value::as_str) == Some("SUCCESS")
        }
        _ if crate::outcome::of_provider_event(agent, event).is_some() => false,
        ChatAgent::Claude => {
            event.get("is_error").and_then(Value::as_bool) != Some(true)
                && matches!(text("subtype"), None | Some("success"))
        }
        ChatAgent::Codex => {
            text("type") == Some("turn.completed")
                && matches!(text("status"), None | Some("completed"))
        }
        ChatAgent::Pi => !refused,
    }
}

/// The wrap-up turn ended cleanly with nothing behind it: stop the chat's
/// process the way `chat_stop_impl` does, and tick the chat.
///
/// The reader calls this once the full stop is written down, with no lock
/// held, so the check is made again here. A message that reached the agent
/// in between has it busy on another turn, one that reached the queue is in
/// it, and a process started since is not this one: each means the person
/// went on, and the completion is off.
///
/// Answers whether the chat was closed. Either way `chat-completed` has
/// been said, once.
fn conclude_completion(
    manager: &ChatManager,
    key: &str,
    session: &Arc<Mutex<ChatSession>>,
    turn_id: &str,
    starts: u64,
) -> bool {
    match close_completed(manager, key, session, turn_id, starts) {
        Ok(_) => {
            // Every message in it has stopped, so its stream pieces can go.
            crate::record_trim::compact_chat(manager, key);
            true
        }
        Err(reason) => {
            announce_completed(key, turn_id, Err(&reason));
            false
        }
    }
}

/// Close a chat whose wrap-up ended cleanly, or say why not.
///
/// **One step, against every start of the chat.** The check, the tick and
/// taking the process out of the session table all happen under the session
/// table's lock, in that order, and the success is announced before the lock
/// goes. A start puts its process in under the same lock
/// (`start_session`), so it comes either before this step, which then finds
/// that process (or the message it carried) and ticks nothing, or after it,
/// and then finds a chat that is ticked, has no process, and that it reopens
/// (`reopen_started_chat`). Never a tick on a chat with a turn in flight,
/// which is what ticking after the lock was let go allowed (review of
/// 2fd3231, H1: the replacement was started and reopened in that gap, and
/// the old path ticked it and turned its live dot off).
///
/// **The tick comes first.** A tick that cannot be written leaves the
/// process in the table and running, and the reason goes to the person, not
/// to stderr (M2).
///
/// Lock order: the question delivery lock, the session table, the session,
/// then the chat index's own lock inside `chat_index::complete`, which calls
/// nothing back. No workspace lifecycle lock and no start claim is taken
/// here, so a start that holds those (`chat_recover::Held`) only ever waits
/// for the short session-table lock, as it does for any send.
fn close_completed(
    manager: &ChatManager,
    key: &str,
    session: &Arc<Mutex<ChatSession>>,
    turn_id: &str,
    starts: u64,
) -> Result<i64, String> {
    let done_at = {
        let _delivery = manager
            .questions
            .delivery_lock
            .lock()
            .map_err(|_| COMPLETION_FAILED)?;
        let done_at = {
            let mut sessions = manager.sessions.lock().map_err(|_| COMPLETION_FAILED)?;
            let replacing = manager
                .handoffs
                .lock()
                .map(|handoffs| handoffs.contains(key))
                .unwrap_or(true);
            // Held from the check to the removal: nothing is written to
            // this process, and its reader ends no turn, in between.
            let running = match sessions.get(key) {
                Some(current) if Arc::ptr_eq(current, session) => {
                    let guard = session.lock().map_err(|_| COMPLETION_FAILED)?;
                    if guard.busy
                        || guard.answering.as_deref() != Some(turn_id)
                        || manager.has_queued_turns(key)
                    {
                        return Err(COMPLETION_SUPERSEDED.into());
                    }
                    Some(guard)
                }
                Some(_) => return Err(COMPLETION_SUPERSEDED.into()),
                // A one-shot process that has already exited by itself.
                None if replacing || manager.has_queued_turns(key) => {
                    return Err(COMPLETION_SUPERSEDED.into())
                }
                None => None,
            };
            let id = key
                .strip_prefix("chat:")
                .ok_or_else(|| could_not_mark_done("it is not in the chat index"))?;
            use crate::chat_index::Unticked;
            let done_at = crate::chat_index::complete(id, crate::agent_usage::now_ms(), starts)
                .map_err(|unticked| match unticked {
                    Unticked::StartedAgain => COMPLETION_SUPERSEDED.to_string(),
                    Unticked::Unlisted => could_not_mark_done("it is not in the chat index"),
                    Unticked::Unsaved(why) => could_not_mark_done(&why),
                })?;
            drop(running);
            manager.revoke_auto_plan(key);
            sessions.remove(key);
            // Said here, so nothing a later start says can come before it.
            announce_index_change(id, false);
            announce_completed(key, turn_id, Ok(done_at));
            done_at
        };
        // Nothing can reach this process any more: the chat is closed, and
        // what follows is tidying, not a decision.
        cancel_question_work(manager, key);
        done_at
    };
    cancel_auto_resume(manager, key, "cancelled when the chat completed");
    forget_standing(key);
    if let Ok(mut guard) = session.lock() {
        if let Err(error) = manager.background.interrupt(
            key,
            &guard.launch_id,
            "The chat was completed. Background work is no longer attached; inspect retained output before retrying.",
        ) {
            eprintln!("chat: cannot record interrupted background work: {error}");
        }
        guard.stdin.take();
        let _ = guard.child.kill();
    }
    Ok(done_at)
}

/// Anything the person allowed "always" was allowed for THIS piece of work.
/// Outliving it would be a permission nobody remembers giving.
fn forget_standing(key: &str) {
    crate::permission::forget_chat(key);
    crate::safety_block::forget_chat(key);
    crate::access_request::forget_chat(key);
    with_access(|a| a.remove(key));
}

/// Stand-in agent processes for tests, the same on every platform.
///
/// Not `sleep` or `cat`: Windows has neither. The stand-in is this test
/// binary run again on the one test below, which does nothing in a normal run
/// and plays the stand-in when `OCTIQ_TEST_STAND_IN` names a part.
#[cfg(test)]
pub(crate) mod stand_in;

mod attachments;
pub(crate) use attachments::attachments_dir;
pub use attachments::save_attachment;

mod index;
pub use index::*;

mod idle;
pub use idle::*;

mod ending;
pub use ending::*;

mod resume_schedule;
pub use resume_schedule::*;

mod access;
pub use access::*;

mod codex_app;
use codex_app::*;

mod asking;
pub use asking::*;

mod questions;
pub(crate) use questions::*;

mod interrupt;
pub use interrupt::*;

#[cfg(test)]
mod test_support;
#[cfg(test)]
pub(crate) use test_support::TestChild;
#[cfg(test)]
use test_support::*;

#[cfg(test)]
#[path = "native_clear_tests.rs"]
mod native_clear_tests;

#[cfg(test)]
#[path = "ending_tests.rs"]
mod ending_tests;

#[cfg(test)]
#[path = "reach_tests.rs"]
mod reach_tests;

#[path = "claude_session_recovery.rs"]
mod claude_session_recovery;
#[path = "provider_switch.rs"]
mod provider_switch;
#[path = "registered_runtime.rs"]
mod registered_runtime;
use provider_switch::{announce_provider_switch, provider_history, run_provider_switch};

#[path = "codex_elicitation.rs"]
mod codex_elicitation;

#[cfg(test)]
#[path = "answered_tests.rs"]
mod answered_tests;

#[cfg(test)]
#[path = "host_turn_tests.rs"]
mod host_turn_tests;

/// Keeps a chat's list preview current from the agent's own readable output
/// (`chat_index::set_host_previews`), for every chat, whether or not any
/// browser has it open.
///
/// Two boundaries submit text: each readable message the agent finishes
/// (Claude's `assistant` text, Codex's `agent_message`, Pi's `message_end`),
/// and the end of a turn that ended cleanly (its closing words). A turn that
/// failed, was refused or was interrupted submits nothing and withdraws what
/// it had submitted but the batch has not written yet: its previous preview
/// stays. Only a chat's own voice counts (a worker's, a room seat's and an
/// unlisted chat's submissions change nothing).
///
/// Every write rewrites the whole chat index, so nothing here writes on its
/// own: `PreviewBatch` collects what is submitted and writes every chat's
/// pending preview in one pass, at most about once a second however many
/// chats are busy; a turn's end writes at once when the index has been quiet.
#[derive(Default)]
pub(crate) struct HostPreview;

/// Previews waiting to be written, each with the moment it must be written
/// by. When the earliest comes due, every pending preview goes in the same
/// index write, so N busy chats cost one rewrite of the index, not N.
///
/// What was taken out of the queue is still this batch's until it is written
/// (`in_flight`): `/clear` drops it by epoch under the index lock
/// (`chat_index::set_host_previews_since`), a failed turn withdraws it so a
/// failed write does not bring it back, and a write that failed puts back
/// what no newer text or withdrawal has replaced (`requeue`), so a profile
/// that is away for a while does not lose previews. They are kept in memory
/// only: what a hard kill loses is in `docs/scoped-reads-and-previews.md`.
#[derive(Default)]
pub(crate) struct PreviewBatch {
    pending: Mutex<HashMap<String, PendingPreview>>,
    /// Ids whose text was taken for a write that has not finished. Always
    /// locked after `pending`.
    in_flight: Mutex<HashSet<String>>,
    wake: Condvar,
    /// When the index was last rewritten for previews; one writer at a time.
    last_write: Mutex<Option<Instant>>,
    /// A failed write is said once per run of failures, not every second.
    failing: std::sync::atomic::AtomicBool,
    /// Ids whose text a FAILED write still has to deliver: put back by
    /// `requeue`, gone as soon as that text is written, withdrawn, cleared or
    /// replaced by newer text. This is what `owes` reports, so text that is
    /// only waiting for its due time is never owed. Always locked after
    /// `pending` and `in_flight`.
    failed: Mutex<HashSet<String>>,
}

/// One running chat and whether a turn is in flight in it — the same `busy`
/// the idle sweeper reads, so "working" means what it means there.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatActivity {
    key: String,
    busy: bool,
    /// The person is completing this chat (`chat_complete_impl`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    completing: bool,
}

/// A transcript without an acknowledgement is not proof that a prompt is
/// still queued: queues are held in memory and do not survive a server restart.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatQueueState {
    live: bool,
    queued_turn_ids: Vec<String>,
    /// The wrap-up turn of the completion this chat is in, which a reloaded
    /// page shows as Completing. Among `queued_turn_ids` while it waits.
    #[serde(skip_serializing_if = "Option::is_none")]
    completing_turn_id: Option<String>,
    /// Why the queue waits with nothing taking it, when it does: the next
    /// message could not start because the record of its turn could not be
    /// kept (`ChatManager::keep_waiting`). The profile's own sentence.
    /// Nothing in the queue is lost, and the host starts the first message
    /// itself once the folder is back. Absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    held: Option<String>,
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod access_tests;

/// A start's claim on a chat keeps every other start out (`claim_start`).
#[cfg(test)]
mod start_claim_tests;

/// The sweeper that gives an unused chat's memory back.
#[cfg(test)]
mod idle_tests;

#[cfg(test)]
mod question_delivery_tests;

#[cfg(test)]
mod completion_tests;

/// A registered agent's own conversation and its removal (review of
/// 931b5f0, H4): a prompt and a removal never both go through.
#[cfg(test)]
mod leaving_tests;

#[cfg(test)]
mod auto_plan_tests;

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
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::{Arc, Mutex};
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
pub(crate) fn record_chat_event(key: &str, event: Value) -> Option<u64> {
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

pub(crate) fn record_chat_event_synced(key: &str, event: Value) -> Option<u64> {
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
    event: Value,
) -> crate::transcript::Held {
    use crate::transcript::Held;
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
    let event = json!({ "type": "octiq_user_turn_delivery", "uuid": turn_id, "state": state });
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
            event["octiq_orchestration_notification_id"] = json!(id);
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
    /// The removal of the registered agent whose conversation this is, once
    /// one has looked at this process (`LeavingMark::working`). Set under
    /// this session's lock, which every prompt is written under.
    leaving: Option<Arc<Leaving>>,
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

#[derive(Debug)]
struct CodexAppSession {
    thread_id: String,
    active_turn_id: Option<String>,
    interrupt_when_started: bool,
    next_request: u64,
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
        self.busy = true;
        self.last_active = Instant::now();
    }

    /// The agent reached its own full stop. The clock starts now.
    fn turn_ended(&mut self) {
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

/// How long a chat may sit with nothing happening before its process is ended.
///
/// Ending one is cheap because nothing is lost: every event is already written
/// down (`transcript.rs`), the agent's own session id is kept in the chat
/// index, and the client's send path already starts a chat it has no process
/// for with `resume` — the same two calls it makes for a chat picked back up
/// the next morning. So the next message carries on the conversation and the
/// only thing the person sees is that the live dot was off.
///
/// What it buys is real: on one machine nine chats left open overnight held
/// 4.3 GB between them — about 480 MB each, once each agent's own MCP servers
/// are counted.
const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// How often the sweeper looks. Well under the timeout, and cheap: it takes one
/// lock, reads a flag and an `Instant` per chat, and goes back to sleep.
const IDLE_SWEEP: Duration = Duration::from_secs(60);

/// The timeout in force, which `OCTIQ_CHAT_IDLE_MINS` may change. `0` turns the
/// sweeper off altogether, for anyone who would rather pay the memory than have
/// a process end behind their back.
fn idle_timeout() -> Option<Duration> {
    match std::env::var("OCTIQ_CHAT_IDLE_MINS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
    {
        Some(0) => None,
        Some(mins) => Some(Duration::from_secs(mins * 60)),
        None => Some(IDLE_TIMEOUT),
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
    pub(crate) fn without_env(&self) -> Self {
        let mut saved = self.clone();
        saved.env = None;
        saved
    }

    pub(crate) fn agent(&self) -> ChatAgent {
        self.agent
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
    background: crate::background_tasks::Store,
    /// Long-running jobs this chat's agent started (`chat_jobs.rs`). A job
    /// that is running holds the chat off the idle reaper, like background
    /// work does.
    pub(crate) jobs: crate::chat_jobs::Store,
    /// The agent program each live process was started from, resolved through
    /// its symlinks (`remember_binary`), keyed like `sessions`.
    binaries: Mutex<HashMap<String, PathBuf>>,
    /// Tokens each registered agent's chats used (`agent_usage.rs`).
    pub(crate) usage: crate::agent_usage::Store,
    pub(crate) orchestrations: Arc<crate::orchestration::OrchestrationStore>,
    pub(crate) questions: Arc<crate::question_store::QuestionStore>,
    pub(crate) auto_resumes: crate::auto_resume::Store,
    sessions: Mutex<HashMap<String, Arc<Mutex<ChatSession>>>>,
    /// How each running agent was last started — see `StartContext`. Keyed by
    /// process key, so each chat resumes independently.
    starts: Mutex<HashMap<String, StartContext>>,
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
    /// The turns this server handed chats' agents for their plans' Starts
    /// (`chat_plan::StartTurns`): what it did, whatever the files took.
    pub(crate) plan_starts: crate::chat_plan::StartTurns,
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
        let session = self.sessions.lock().ok()?.get(session_key).cloned()?;
        let live = session.lock().ok()?.launch_id == known.launch_id;
        live.then_some((known.chat_key, known.launch_id))
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
        let secret = mint_capability();
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
    fn remember_start(&self, session_key: &str, start: StartContext) {
        if let Ok(mut m) = self.starts.lock() {
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
        let interrupted = event.get("type").and_then(Value::as_str) == Some("result")
            && session
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
        if let Ok(mut m) = self.starts.lock() {
            if let Some(start) = m.get_mut(session_key) {
                start.session_id = Some(session_id.to_string());
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
        if let Err(error) = self.persist_orchestration_context(session_key) {
            eprintln!("orchestration: could not save provider session: {error}");
        }
    }

    fn start_context(&self, session_key: &str) -> Option<StartContext> {
        self.starts.lock().ok()?.get(session_key).cloned()
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
        gone.into_iter()
            .filter(|key| {
                sessions
                    .get(key)
                    .is_some_and(|s| s.try_lock().is_ok_and(|s| !s.busy))
            })
            .filter(|key| !self.background.has_running(key) && !self.jobs.has_running(key))
            .filter(|key| self.orchestrations.refusal_owner(key).is_none())
            .collect()
    }

    /// The background work this chat's agent left running, `(id, description)`.
    pub(crate) fn running_background(&self, key: &str) -> Vec<(String, String)> {
        self.background.running(key)
    }

    /// Whether a turn sent to this chat now would be taken: it has a
    /// process, one is being replaced, or its queue waits for the profile
    /// folder. Without any of them a send answers `no such chat` and the
    /// chat has to be started.
    pub(crate) fn takes_turns(&self, key: &str) -> bool {
        self.has_process(key)
            || self
                .handoffs
                .lock()
                .map(|handoffs| handoffs.contains(key))
                .unwrap_or(true)
            || self.waits_because(key).is_some()
    }

    pub(crate) fn has_process(&self, key: &str) -> bool {
        self.sessions
            .lock()
            .map(|s| s.contains_key(key))
            .unwrap_or(true)
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
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let replacing = self
            .handoffs
            .lock()
            .map_err(|e| e.to_string())?
            .contains(key);
        let mut claims = self.start_claims.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(key) || replacing || claims.contains_key(key) {
            return Err(format!("chat '{key}' is already running"));
        }
        claims.insert(key.to_string(), thread::current().id());
        Ok(StartClaim {
            manager: self,
            key: key.to_string(),
        })
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
                    &crate::git_ops::workflow::held_checkout(path),
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
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let starts = self.starts.lock().map_err(|e| e.to_string())?;
        for key in sessions.keys() {
            if key == worker || key == coordinator {
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
                if crate::git_ops::workflow::shares_checkout(checkout, &other, managed_worktree) {
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
        let mut turns = self.queued_turns.lock().map_err(|e| e.to_string())?;
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

/// Arm a durable continuation only when both halves are reliable: a native
/// session to resume and an exact future reset timestamp. A quota error without
/// either remains the ordinary actionable failure banner rather than guessing.
fn schedule_quota_resume(
    manager: &Arc<ChatManager>,
    chat_key: &str,
    session_key: &str,
    agent: ChatAgent,
    reset_hint: Option<i64>,
) {
    // Orchestration recovery creates a new authoritative attempt. The ordinary
    // chat quota timer must never revive a failed worker under its old lease.
    if manager
        .orchestrations
        .worker_coordinator(chat_key)
        .ok()
        .flatten()
        .is_some()
    {
        return;
    }
    let now = crate::auto_resume::unix_now();
    let Some(start) = manager.start_context(session_key) else {
        return;
    };
    if start.agent() != agent || !start.resumable() {
        return;
    }
    let reset_at = reset_hint
        .filter(|reset| *reset > now)
        .or_else(|| crate::usage_limits::blocking_reset_at(agent, start.model(), now));
    let Some(reset_at) = reset_at else {
        return;
    };
    match manager
        .auto_resumes
        .schedule(chat_key, reset_at, start, now)
    {
        Ok(Some(entry)) => crate::auto_resume::announce_scheduled(&entry),
        Ok(None) => {}
        Err(why) => eprintln!("[chat] could not schedule quota resume for {chat_key}: {why}"),
    }
}

/// What a cancelled auto-resume is called when it could not be recorded
/// (`unsaved::say`).
const CANCELLED_RESUME: &str = "the cancelled auto-resume";

/// Take `key`'s scheduled resume off the schedule. `true` when there was one.
///
/// **It answers nothing a caller could stop on.** Stop, interrupt and every
/// new message cancel first, and a cancel that returned its save's error
/// with `?` left the agent running under a Stop that had been refused
/// (review of 205bca2, H5). The cancel holds in this process from here on;
/// a save that failed is said to whoever asked and owed by the store, which
/// keeps the entry as a `Cancelled` tombstone until it is on disk
/// (`settle_cancelled_resumes`).
fn cancel_auto_resume(manager: &ChatManager, key: &str, reason: &str) -> bool {
    let cancelled = match manager.auto_resumes.cancel(key) {
        Ok(Some(cancelled)) => cancelled,
        Ok(None) => return false,
        Err(why) => {
            eprintln!("[chat] could not look for an auto-resume of {key}: {why}");
            return false;
        }
    };
    // Every open page drops the banner now; the transcript's line is tried,
    // and written again once the folder is back when it could not be.
    crate::auto_resume::announce_cancelled(&cancelled.entry, reason);
    match cancelled.unsaved {
        Some(why) => crate::unsaved::say(CANCELLED_RESUME, why),
        None => clear_cancelled_resume(manager, &cancelled.entry),
    }
    true
}

/// Drop the tombstone of a cancel that is on disk and was announced.
fn clear_cancelled_resume(manager: &ChatManager, entry: &crate::auto_resume::ScheduledResume) {
    if let Err(why) = manager.auto_resumes.finish(entry) {
        // `Cancelled` is already durable and the scheduler ignores it. Leaving
        // the tombstone for startup cleanup is safer than blocking the user.
        eprintln!(
            "[chat] could not finish auto-resume cancellation for {}: {why}",
            entry.chat_key
        );
    }
}

/// Write the cancels that could not be saved when they were made, then say
/// each in its chat's transcript, where the line could not be written
/// either, and drop its tombstone once it has been. An error is a schedule
/// still owed. A line that still cannot be written keeps its tombstone,
/// which is `Cancelled` on disk by then: the next try, or the next start
/// of the server, says it.
fn settle_cancelled_resumes(manager: &ChatManager) -> Result<(), String> {
    manager.auto_resumes.settle()?;
    for entry in manager.auto_resumes.unannounced() {
        let said = crate::auto_resume::announce_cancelled(
            &entry,
            "cancelled while the profile folder was away",
        );
        if said.is_some() {
            clear_cancelled_resume(manager, &entry);
        }
    }
    Ok(())
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
        let event = json!({ "type": "octiq_user_turn_cancelled", "uuid": turn_id });
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

/// The level each running chat is on RIGHT NOW, by chat key.
///
/// `OCTIQ_ACCESS` is written once, into the environment of a process that has
/// already been spawned, so a level changed part-way through a chat can never
/// reach it — nothing can rewrite the environment of a running process from
/// outside. The permission hook used to decide from that variable alone, which
/// meant it answered for the level the chat STARTED on: pick Bypass permissions
/// halfway through and it went on stopping every command, dial back down from
/// it and it stood aside from the very asking that level is for.
///
/// So the hook no longer decides — and neither, now, does this. `permission::ask`
/// runs LAST, over the agent's own control channel, so every question that
/// reaches it is one the agent's own rules already decided a person must answer;
/// there is nothing left to pre-filter. The write side remains for diagnostics
/// and tests.
///
/// Entries are written by `chat_start` and `chat_set_access` and dropped by
/// `chat_stop`. A chat that ends on its own leaves its entry behind on purpose:
/// removing it from the reaper thread would race a restart under the same key
/// and delete the NEW level. A stale entry costs nothing — the only reader is a
/// hook belonging to that chat, and a chat that is gone has none.
static ACCESS: Mutex<Option<HashMap<String, Access>>> = Mutex::new(None);

fn with_access<T>(f: impl FnOnce(&mut HashMap<String, Access>) -> T) -> T {
    let mut guard = ACCESS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Remember the level the hook will answer at.
pub(crate) fn record_access_for(key: &str, access: Option<Access>) {
    with_access(|a| a.insert(key.to_string(), access.unwrap_or(Access::Read)));
}

/// What a chat may do at this moment, or None when no chat by that key is known.
///
/// No production reader since asking moved to the agent's own control channel.
#[allow(dead_code)]
pub fn access_now(key: &str) -> Option<Access> {
    with_access(|a| a.get(key).copied())
}

/// Build one provider-owned command from the normalized chat request.
#[cfg(test)]
fn build_command(
    agent: ChatAgent,
    model: Option<&str>,
    access: Option<Access>,
    prompt: &str,
    resume: Option<&str>,
    extra_dirs: &[String],
    effort: Option<&str>,
    images: &[String],
    lite: bool,
) -> String {
    build_command_for_project(
        agent, model, access, prompt, resume, extra_dirs, effort, images, lite, None,
    )
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn build_command_for_project(
    agent: ChatAgent,
    model: Option<&str>,
    access: Option<Access>,
    prompt: &str,
    resume: Option<&str>,
    extra_dirs: &[String],
    effort: Option<&str>,
    images: &[String],
    lite: bool,
    project_cwd: Option<&str>,
) -> String {
    let provider = provider_for(agent);
    let mcp = provider
        .capabilities()
        .uses_octiq_mcp
        .then(ask_mcp_config)
        .flatten();
    let authorizations = (agent == ChatAgent::Codex)
        .then(|| project_cwd.and_then(crate::safety_block::project_authorizations))
        .flatten();
    build_command_with_context(
        agent,
        model,
        access,
        prompt,
        resume,
        extra_dirs,
        effort,
        images,
        lite,
        mcp.as_deref(),
        authorizations.as_deref(),
    )
}

/// The testable command-builder seam. Provider-specific syntax lives in the
/// selected adapter, while this function preserves the shared chat input shape.
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn build_command_with_mcp(
    agent: ChatAgent,
    model: Option<&str>,
    access: Option<Access>,
    prompt: &str,
    resume: Option<&str>,
    extra_dirs: &[String],
    effort: Option<&str>,
    images: &[String],
    lite: bool,
    mcp_config: Option<&std::path::Path>,
) -> String {
    build_command_with_context(
        agent, model, access, prompt, resume, extra_dirs, effort, images, lite, mcp_config, None,
    )
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn build_command_with_context(
    agent: ChatAgent,
    model: Option<&str>,
    access: Option<Access>,
    prompt: &str,
    resume: Option<&str>,
    extra_dirs: &[String],
    effort: Option<&str>,
    images: &[String],
    lite: bool,
    mcp_config: Option<&std::path::Path>,
    persistent_authorizations: Option<&str>,
) -> String {
    let prompt = if mcp_config.is_some() {
        routed_prompt(agent, prompt)
    } else {
        Cow::Borrowed(prompt)
    };
    provider_for(agent).build_command(&AgentCommand {
        model,
        access,
        prompt: &prompt,
        resume,
        extra_dirs,
        effort,
        images,
        lite,
        mcp_config,
        persistent_authorizations,
        orchestration_worker: false,
        front_desk: false,
        codex_user_mcp: &[],
        preferences: None,
    })
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
            Some(fresh_turn_id(turn_id)),
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
    start_session(
        manager,
        Voice::host(key),
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
    )
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

/// What cancelled questions are called when the cancel could not be
/// recorded (`unsaved::say`).
const CANCELLED_QUESTIONS: &str = "the cancelled questions";

/// Cancel every open question of a chat that is being stopped, and take
/// back the answers queued for it. It answers nothing a Stop could wait on:
/// the questions are cancelled in this process, the tools waiting on them
/// are told, and a save that failed is said and owed.
fn cancel_question_work(manager: &ChatManager, key: &str) {
    // Read before the cancel takes them out of the outbox. A question file
    // that could not be read holds nothing here to cancel.
    let records = manager.questions.outbox().unwrap_or_default();
    match manager.questions.cancel_chat(key) {
        Ok(Some(why)) => crate::unsaved::say(CANCELLED_QUESTIONS, why),
        Ok(None) => {}
        Err(why) => eprintln!("[chat] could not cancel the questions of {key}: {why}"),
    }
    for record in records
        .into_iter()
        .filter(|r| r.origin.chat_key == key || r.origin.session_key == key)
    {
        if let Some(turn) = manager.cancel_queued_turn(&record.origin.chat_key, &record.turn_id()) {
            announce_cancelled(&record.origin.chat_key, &turn);
        }
    }
}

/// Whether `chat_key` was started with the turn `turn_id`. The durable user
/// turn is written only once the agent holding it has been spawned
/// (`start_session`), so its presence is the receipt a retry can trust: a
/// handover's new chat is never started twice.
pub(crate) fn turn_was_started(chat_key: &str, turn_id: &str) -> bool {
    crate::transcript::since(chat_key, 0)
        .into_iter()
        .any(|item| {
            item.event["uuid"].as_str() == Some(turn_id)
                && item.event["octiq_user_turn"].as_bool() == Some(true)
        })
}

/// The durable prompt id is also the retry key. A crash after dispatch must
/// never cause an automatic second execution of an answer already handed over.
fn question_receipt(record: &crate::question_store::Record) -> Option<String> {
    let id = record.turn_id();
    let mut state = None;
    for item in crate::transcript::since(&record.origin.chat_key, 0) {
        let event = item.event;
        if event["octiq_user_turn_id"].as_str() == Some(&id) {
            return Some("received".into());
        }
        if event["uuid"].as_str() == Some(&id) {
            match event["type"].as_str() {
                Some("octiq_user_turn_delivery") => {
                    state = event["state"].as_str().map(str::to_string)
                }
                Some("octiq_user_turn_cancelled") => return Some("cancelled".into()),
                _ => {}
            }
        }
    }
    state
}

fn resume_question(
    manager: Arc<ChatManager>,
    record: &crate::question_store::Record,
) -> Result<(), String> {
    continue_origin(
        manager,
        &record.origin,
        record.continuation(),
        record.turn_id(),
    )
}

/// Hand `text` to the chat that made a saved request, as a host turn: sent
/// to its running agent, or resumed in its own provider session when it has
/// stopped. Late `ask_user` answers and handover decisions both come back
/// this way, and refuse rather than continue a different session.
pub(crate) fn continue_origin(
    manager: Arc<ChatManager>,
    origin: &QuestionOrigin,
    text: String,
    turn_id: String,
) -> Result<(), String> {
    let start = manager
        .start_context(&origin.session_key)
        .unwrap_or_else(|| origin.start.clone());
    if start.agent != origin.start.agent || start.session_id != origin.start.session_id {
        return Err("This conversation now uses a different agent session. Your answers are saved; continue from them in the chat.".into());
    }
    if origin.session_key != origin.chat_key {
        return Err("Answers for removed additional agents are saved, but cannot be delivered automatically. Continue from them in the chat.".into());
    }
    match chat_send_with_user_turn(
        manager.clone(),
        origin.chat_key.clone(),
        text.clone(),
        None,
        None,
        Some(turn_id.clone()),
    ) {
        Ok(()) => return Ok(()),
        Err(why) if why == "no such chat" || why.ends_with("is not running") => {}
        Err(why) => return Err(why),
    }
    manager.remember_start(&origin.session_key, start.clone());
    start_session(
        manager,
        Voice::host(origin.chat_key.clone()),
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
        Some(turn_id),
        true,
        None,
    )
}

/// Runs after a saved submission and at startup. Reconciliation keeps queued
/// answers recoverable when a process exits before consuming its queue.
pub(crate) fn deliver_question_answers(manager: Arc<ChatManager>) -> Result<(), String> {
    deliver_question_answers_with(manager.clone(), |record| {
        resume_question(manager.clone(), record)
    })
}

fn deliver_question_answers_with(
    manager: Arc<ChatManager>,
    mut send: impl FnMut(&crate::question_store::Record) -> Result<(), String>,
) -> Result<(), String> {
    use crate::question_store::Delivery;
    let _delivery = manager
        .questions
        .delivery_lock
        .lock()
        .map_err(|e| e.to_string())?;
    for record in manager.questions.outbox()? {
        let receipt = question_receipt(&record);
        if matches!(record.delivery, Delivery::Dispatching | Delivery::Queued) && receipt.is_none()
        {
            manager.questions.set_delivery(&record.id, Delivery::Uncertain, Some("Your answers are saved, but delivery was interrupted before it could be confirmed. Check the conversation and continue there; this answer will not be resent automatically.".into()))?;
            continue;
        }
        match receipt.as_deref() {
            Some("received") => {
                manager
                    .questions
                    .set_delivery(&record.id, Delivery::Delivered, None)?;
                continue;
            }
            Some("cancelled") => {
                manager.questions.cancel(&record.ids)?;
                continue;
            }
            Some("dispatched") | Some("unknown") => {
                let running = manager
                    .sessions
                    .lock()
                    .map_err(|e| e.to_string())?
                    .contains_key(&record.origin.session_key);
                if !running {
                    manager.questions.set_delivery(&record.id, Delivery::Uncertain, Some("Your answers were saved, but the agent stopped before confirming receipt. Check the chat and continue there; the answers will not be sent twice automatically.".into()))?;
                }
                continue;
            }
            Some("queued") => {
                let queued = manager
                    .queued_turns
                    .lock()
                    .map_err(|e| e.to_string())?
                    .get(&record.origin.session_key)
                    .is_some_and(|q| q.iter().any(|t| t.owns_turn_id(&record.turn_id())));
                let handoff = manager
                    .handoffs
                    .lock()
                    .map_err(|e| e.to_string())?
                    .contains(&record.origin.session_key);
                if queued || handoff {
                    continue;
                }
            }
            _ => {}
        }
        manager
            .questions
            .set_delivery(&record.id, Delivery::Dispatching, None)?;
        match send(&record) {
            Ok(()) => manager
                .questions
                .set_delivery(&record.id, Delivery::Queued, None)?,
            Err(why) => manager.questions.set_delivery(
                &record.id,
                Delivery::Failed,
                Some(format!(
                    "Your answers are saved. Could not continue the agent: {why}"
                )),
            )?,
        }
    }
    Ok(())
}

pub(crate) fn start_question_recovery(manager: Arc<ChatManager>) {
    thread::spawn(move || {
        let mut previous_error = None;
        loop {
            let error = deliver_question_answers(manager.clone()).err();
            if error != previous_error {
                if let Some(why) = &error {
                    eprintln!("[questions] {why}");
                }
                previous_error = error;
            }
            thread::sleep(Duration::from_secs(2));
        }
    });
}

pub(crate) fn cancel_questions(manager: &ChatManager, ids: &[String]) -> Result<(), String> {
    let _delivery = manager
        .questions
        .delivery_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let records = manager.questions.outbox()?;
    // Cancelled here and the waiting tool told, whether or not it could be
    // saved: a cancel that was only refused left the agent waiting.
    if let Some(why) = manager.questions.cancel(ids)? {
        crate::unsaved::say(CANCELLED_QUESTIONS, why);
    }
    for record in records
        .into_iter()
        .filter(|r| r.ids.iter().any(|id| ids.contains(id)))
    {
        if let Some(turn) = manager.cancel_queued_turn(&record.origin.chat_key, &record.turn_id()) {
            announce_cancelled(&record.origin.chat_key, &turn);
        }
    }
    Ok(())
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

#[allow(clippy::too_many_arguments)]
fn initialize_codex_app_server(
    stdin: &mut ChildStdin,
    reader: &mut BufReader<ChildStdout>,
    cwd: &str,
    model: Option<&str>,
    effort: Option<&str>,
    access: Option<Access>,
    resume: Option<&str>,
    workspace_roots: &[String],
    developer_instructions: &str,
) -> Result<(String, Vec<Value>), String> {
    let mut prelude = Vec::new();
    write_json_line(stdin, &crate::codex_app_server::initialize_request())?;
    wait_for_codex_response(reader, crate::codex_app_server::INITIALIZE_ID, &mut prelude)?;
    write_json_line(stdin, &crate::codex_app_server::initialized_notification())?;
    write_json_line(
        stdin,
        &crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
            cwd,
            model,
            effort,
            access,
            resume,
            workspace_roots,
            developer_instructions,
        }),
    )?;
    let result = wait_for_codex_response(reader, crate::codex_app_server::THREAD_ID, &mut prelude)?;
    let thread_id = crate::codex_app_server::thread_id_from_result(&result)
        .ok_or("Codex app-server did not return a thread id")?
        .to_string();
    Ok((thread_id, prelude))
}

/// The person's own Codex MCP servers, as the Codex this chat would start
/// sees them: `codex mcp list --json` through the agent shell, in the chat's
/// folder, with the project's environment (a project may set `CODEX_HOME`).
fn codex_user_mcp_servers(
    cwd: &str,
    env: Option<&std::collections::BTreeMap<String, String>>,
) -> Result<Vec<crate::agent_provider::CodexMcpServer>, String> {
    use std::io::Read;
    const WHY: &str = "The front desk could not check which MCP servers Codex would give it";
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
    let Voice {
        session_key,
        stream_key: key,
    } = voice;
    if manager
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&session_key)
        || manager.claimed_elsewhere(&session_key)
    {
        return Err(format!("chat '{session_key}' is already running"));
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
    // Codex has no `--strict-mcp-config`: a Codex front desk turns off each
    // of the person's own MCP servers by name, so it has to know them. Asked
    // before the session table is locked; a list it cannot read stops the
    // launch rather than start a front desk with the person's tools.
    let codex_user_mcp = if front_desk && agent == ChatAgent::Codex {
        codex_user_mcp_servers(&cwd, env.as_ref())?
    } else {
        Vec::new()
    };
    manager.admit_beside_writers(
        &session_key,
        &key,
        std::iter::once(&cwd),
        access != Some(Access::Read),
    )?;
    // Hold ownership through launch: reset/stop cannot race preparation.
    let sandbox = crate::sandbox::prepare_for_start(&key, &cwd)?;
    let mut env = env;
    let (prompt, visible_prompt) = if let Some(sandbox) = &sandbox {
        let vars = env.get_or_insert_with(Default::default);
        vars.insert("OCTIQ_SANDBOX_ID".into(), sandbox.id.clone());
        vars.insert(
            "OCTIQ_SANDBOX_HANDOFF".into(),
            sandbox.handoff.to_string_lossy().into(),
        );
        let visible = visible_prompt.or_else(|| prompt.clone());
        let context = format!("OctiqFlow prepared this chat's local test services. Read {} for URLs and readiness evidence. Use these services for testing; preserve this chat's database on resume. Task completion alone does not verify the application.", sandbox.handoff.display());
        (
            Some(format!("{context}\n\n{}", prompt.unwrap_or_default())),
            visible,
        )
    } else {
        (prompt, visible_prompt)
    };
    let manager_for_exit = manager.clone();
    let session_key_for_exit = session_key.clone();
    // Keep creation and insertion atomic with other starts and sends.
    let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
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
    let orchestration_worker = env.as_ref().is_some_and(|env| {
        env.get("OCTIQ_ORCHESTRATION_ATTEMPT")
            .is_some_and(|attempt| !attempt.trim().is_empty())
    });
    let wire_prompt = if mcp.is_some() {
        routed_prompt(agent, &prompt)
    } else {
        Cow::Borrowed(prompt.as_str())
    };
    // Read at every process start, so a change in Settings reaches a chat
    // the next time it starts or is resumed.
    let preferences = crate::personal_preferences::launch_prompt();
    let launch = AgentCommand {
        model: model.as_deref(),
        access,
        prompt: &wire_prompt,
        resume: resume.as_deref(),
        extra_dirs: &extras,
        effort: effort.as_deref(),
        images: &images,
        lite: lite.unwrap_or(false) || front_desk,
        mcp_config: mcp.as_deref(),
        persistent_authorizations: authorizations.as_deref(),
        orchestration_worker,
        front_desk,
        codex_user_mcp: &codex_user_mcp,
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
    let project_env = crate::workspaces::resolved_env(&env.unwrap_or_default());
    // `octiq-job` on the agent's PATH, and where its shells reach the host
    // from (`chat_jobs::agent_env`): put before the project's PATH.
    let job_env = crate::chat_jobs::agent_env(
        &session_key,
        project_env
            .iter()
            .find(|(name, _)| name == "PATH")
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var("PATH").ok()),
    );
    let mut child = shell
        .command(&format!("exec {line}"))
        .current_dir(&process_cwd)
        // The project's own environment, so a chat agent picks up the same
        // variables a terminal in this project would (e.g. `starfall`'s
        // `CLAUDE_CONFIG_DIR`). Applied first so every var this backend sets
        // below always wins if a project happened to name the same key.
        .envs(project_env)
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
        leaving: None,
    }));
    sessions.insert(session_key.clone(), session.clone());
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
            // Claude's calls by tool_use id, so an auto-mode refusal naming
            // one can say exactly what was refused (see `note_claude_calls`).
            let mut claude_calls: HashMap<String, (String, Value)> = HashMap::new();
            let mut snapshot_reads = crate::record_trim::SnapshotResults::default();
            // This process's usage. Claude's totals restart with each process,
            // and so does this.
            let mut usage_meter = crate::agent_usage::Meter::default();
            let mut denied_actions = DeniedActions::default();
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
                        if transport.is_app_server() {
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
                        let observed = stream_provider.observe_event(&event);
                        if let Ok(mut session) = asking.lock() {
                            if let Err(error) =
                                reading.background.observe(&key, &session.launch_id, &event)
                            {
                                eprintln!("chat: cannot record background work: {error}");
                            }
                            // A turn nobody wrote for: Claude woke itself when
                            // its background work finished. Until this, the
                            // session read idle through the whole turn, so
                            // ask_user refused it as "turn has already ended"
                            // (feedback 5fd9b781) and the idle sweeper, whose
                            // clock had run since the previous full stop,
                            // ended the worker mid-report (feedback 4c7f5647).
                            if observed.turn_opened && !session.busy {
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
                        // The agent naming its own conversation. Kept so the
                        // backend can RESUME this chat rather than start a
                        // blank one — see `StartContext`. Both agents announce
                        // it once, under different names, in their opening
                        // event. A resumed chat always uses its own memory.
                        if let Some(id) = observed.session_id {
                            reading.remember_session(&session_key, id);
                        }
                        // Codex says nothing on its full stop, so its closing
                        // words have to be kept as they go past — see
                        // `codex_said`.
                        if let Some(text) = observed.spoken_text {
                            carried.clear();
                            carried.push_str(text);
                        }
                        // Set only by the full stop of a completion's wrap-up
                        // turn, and acted on once that full stop is recorded.
                        let mut wrap_up = None;
                        if observed.turn_finished {
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
                            let clean = ended_cleanly(
                                stream_provider.kind(),
                                &event,
                                denied_actions.newly_refused(&event),
                            );
                            if let Ok(mut s) = asking.lock() {
                                reading.questions.detach_launch(&s.launch_id);
                                (wrap_up, refused) =
                                    end_turn_locked(&reading, &session_key, &key, &mut s, clean);
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
                        let notification_receipt = event
                            .get("octiq_orchestration_notification_id")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        // Recorded BEFORE it is sent, so a client that
                        // reconnects can never be told about an event that was
                        // not written down.
                        let seq = crate::transcript::append(&key, &event);
                        if let Some(id) = &notification_receipt {
                            if let Err(error) =
                                reading.orchestrations.acknowledge_notification(&key, id)
                            {
                                eprintln!(
                                    "orchestration: could not acknowledge notification: {error}"
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
                        if quota_failure {
                            schedule_quota_resume(
                                &reading,
                                &key,
                                &session_key,
                                stream_provider.kind(),
                                quota_reset_hint,
                            );
                        }
                        // After the full stop is in the transcript and on the
                        // bus: the tick is the last thing said about the turn.
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
                reading.questions.detach_launch(&session.launch_id);
                record_delivery(&key, session.user_turn_id.take().as_deref(), "unknown");
                // Every line this process wrote has been read. A wrap-up it
                // was given and never brought to a full stop ended with it.
                reading.completion_cut_short(&session_key, &session, COMPLETION_ENDED);
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
                        let queued_turn = if relaunches_to_continue(agent) {
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
            let drained = (is_worker || manager_for_exit.background.has_running(&key))
                && (0..2).all(|_| output_drained.recv_timeout(Duration::from_secs(2)).is_ok());

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
    if transport.accepts_stdin()
        && has_prompt
        && (!wire_prompt.trim().is_empty() || !images.is_empty())
    {
        write_user_message(
            &session,
            &wire_prompt,
            &images,
            &key,
            user_turn_id.as_deref(),
        )?;
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
    session: &mut ChatSession,
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
    let payload = if let Some(codex) = session.codex.as_mut() {
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
    let stdin = session
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
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
    let refused = dispatch_next_persistent_turn(manager, session_key, stream_key, session);
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
    let refused =
        write_user_message_locked(session, &turn.text, &turn.images, turn.turn_id.as_deref()).err();
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
    session: &Arc<Mutex<ChatSession>>,
    text: &str,
    images: &[String],
    key: &str,
    turn_id: Option<&str>,
) -> Result<(), String> {
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let result = write_user_message_locked(&mut guard, text, images, turn_id);
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

/// Deliver only between turns, and never ahead of a waiting user message.
/// The durable notification remains in-flight until the provider emits its receipt.
pub(crate) fn deliver_orchestration_notification(
    manager: Arc<ChatManager>,
    notification: &crate::orchestration::inbox::Notification,
    env: std::collections::BTreeMap<String, String>,
) -> Result<bool, String> {
    let key = &notification.target_chat_key;
    let text = format!("OctiqFlow notification {} for run {}.\n\n{}\n\nThis is a host notification, not a new user instruction. Re-read orchestration_snapshot before taking action; delivery can repeat after an interrupted receipt. Respect the person's latest instructions. If you are the coordinator, dispatch work asynchronously, then end your turn so the person can keep chatting; the host will notify you when something needs attention. If you are a worker, continue only your active assigned attempt and report when it settles.", notification.id, notification.run_id, notification.body);
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
            write_user_message_locked(&mut session, &text, &[], Some(&notification.id))?;
            return Ok(true);
        }
    }
    let mut start = if let Some(start) = manager.start_context(key) {
        start
    } else {
        let saved = manager
            .orchestrations
            .saved_resume_context(key)
            .ok_or("Resume the main chat once to restore its provider settings.")?;
        let meta = crate::chat_index::list()
            .into_iter()
            .find(|m| format!("chat:{}", m.id) == *key)
            .ok_or("The target chat is unavailable.")?;
        if !saved.resumable()
            || saved.session_id != meta.session_id
            || meta.cwd.as_deref() != Some(&saved.cwd)
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
    // Even an in-memory start must not revive a chat that has been deleted.
    if !crate::chat_index::list()
        .iter()
        .any(|m| format!("chat:{}", m.id) == *key)
    {
        return Err("The target chat is unavailable.".into());
    }
    start.env = Some(env);
    manager.remember_start(key, start.clone());
    start_session(
        manager,
        Voice::host(key.clone()),
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
        Some(notification.id.clone()),
        false,
        None,
    )?;
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

/// Hand a chat's agent a turn in the host's own words, recorded under
/// `turn_id`, which is the host's and not a person's (`is_person_turn_id`):
/// the turn that tells it the person started its plan (`chat_plan`).
///
/// It waits like any message. With a turn in flight, a stopped one that has
/// not sent its full stop, or anything queued, it joins the host's queue
/// and answers `queued`; otherwise the agent has it, `started`. `Ok(None)`
/// is a chat with no process: the caller starts it with this turn as its
/// first message, the way a completion of a chat that is not running does.
pub(crate) fn chat_host_turn_impl(
    manager: &Arc<ChatManager>,
    key: &str,
    text: &str,
    turn_id: &str,
) -> Result<Option<&'static str>, String> {
    cancel_auto_resume(manager, key, "superseded by the plan's Start");
    let sent = send_turn(
        manager.clone(),
        key.to_string(),
        text.to_string(),
        None,
        None,
        Some(turn_id.to_string()),
    );
    let state = match sent {
        Ok(Sent::Queued) => "queued",
        Ok(Sent::Written | Sent::Already) => "started",
        Err(why) if why == "no such chat" => return Ok(None),
        Err(why) => return Err(why),
    };
    // A turn the person set going supersedes a refusal card, as a message
    // of theirs does.
    crate::safety_block::forget_chat(key);
    Ok(Some(state))
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
/// under an id of its own (`chat_host_turn_impl`).
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
/// - Anything else: **handed**. That includes `unknown`, a process that
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
/// (`chat_plan::StartTurns`), and the record is not asked whether it did.
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
        .map(|(id, turn)| {
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
            (id, fate)
        })
        .collect())
}

fn send_turn(
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
                guard.turn_started();
                return Ok(Sent::Queued);
            }
            if let Some(turn_id) = user_turn_id.as_deref() {
                record_durable_user_turn(&key, turn_id, &text, &images);
            }
            let result =
                write_user_message_locked(&mut guard, &text, &images, user_turn_id.as_deref());
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
    let event = json!({ "type": "octiq_user_turn_dismissed", "uuid": turn_id });
    let seq = crate::transcript::append(&key, &event)
        .ok_or_else(|| "could not record the dismissed message".to_string())?;
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
        interrupt_persistent_turn(&mut guard)?;
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

fn write_codex_interrupt_locked(session: &mut ChatSession) -> Result<bool, String> {
    let Some(codex) = session.codex.as_mut() else {
        return Ok(false);
    };
    let Some(turn_id) = codex.active_turn_id.clone() else {
        codex.interrupt_when_started = true;
        return Ok(false);
    };
    let request_id = codex.request_id("interrupt");
    let payload =
        crate::codex_app_server::interrupt_request(&request_id, &codex.thread_id, &turn_id);
    let stdin = session
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    write_json_line(stdin, &payload)?;
    codex.interrupt_when_started = false;
    Ok(true)
}

/// Whether a conversation goes on only in a new process: every turn of a
/// command-line provider, and the turn after a stop or an exit for a provider
/// whose stdin takes no control message (Antigravity). Its queue is carried
/// into that process rather than dropped with the old one.
fn relaunches_to_continue(agent: ChatAgent) -> bool {
    let capabilities = provider_for(agent).capabilities();
    !capabilities.input.accepts_stdin() || capabilities.interrupt_ends_process
}

/// Send the interrupt understood by a provider with a persistent stdin.
fn interrupt_persistent_turn(session: &mut ChatSession) -> Result<(), String> {
    if session.codex.is_some() {
        write_codex_interrupt_locked(session)?;
        session.turn_ended();
        return Ok(());
    }
    let payload = provider_for(session.agent)
        .interrupt_payload()
        .ok_or("this chat does not take more input")?;
    let stdin = session
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    // The turn is over as far as anyone waiting is concerned, and the still
    // clock starts here rather than at whatever `result` the agent may or may
    // not send after being cut off. A session that stopped and was never
    // spoken to again is exactly what the sweeper is for.
    session.turn_ended();
    Ok(())
}

/// Ask the agent to stop what it is doing, WITHOUT ending the conversation.
///
/// Claude and Codex both cancel a running turn over their persistent control
/// channel and keep the native conversation alive. Command-line fallback
/// providers end only the current process; the next process resumes from the
/// remembered conversation id.
///
/// **The queue behind the stopped turn SURVIVES, and its first message starts
/// straight away.** Stop is how a person says "not that — do the thing I have
/// already typed instead", and it was that for as long as this app has had a
/// Stop button: a queued message used to go down Claude's stdin into Claude's
/// OWN queue, which an interrupt made it pick up immediately. Card 84 moved
/// that queue to this side so a message could still be taken back, and dropped
/// it here — quietly ending a way of working that had always worked. What
/// takes a message back is the ✕ on its own bubble, which says which one.
///
/// Nothing here writes the next message: a persistent provider's is handed
/// over by the reader thread when the cut-off turn's own `result` lands (see
/// `turn_finished`), under the lock that ends the turn, so it cannot jump
/// ahead of anything. A one-shot provider has no reader to do it, so this
/// carries the queue across the process replacement by hand.
///
/// A persistent agent that does not honour the Stop within `UNWIND_GRACE`
/// has its process ended, and the queue's first message starts in the next
/// one (`grace_ran_out`).
///
/// **A next message that cannot start does not make the Stop fail, and
/// costs nothing that was queued.** Starting the next message is a new
/// turn, and no turn starts while its record cannot be kept (the profile
/// folder is away). The Stop has stopped the agent by then: it answers
/// that, how many messages still wait, and why the first did not start
/// (`Stopped`); the queue is what it was, in its order (`keep_waiting`).
fn interrupt_session(
    manager: &Arc<ChatManager>,
    session_key: &str,
    stream_key: &str,
) -> Result<Stopped, String> {
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(session_key).cloned().ok_or("no such chat")?
    };
    let agent = {
        let guard = session.lock().map_err(|e| e.to_string())?;
        guard.agent
    };
    // Command-line providers cannot receive a control message after startup,
    // and Antigravity's stdin takes none. Remove and kill the current process,
    // but deliberately leave `StartContext` intact so the next user turn can
    // resume it.
    if relaunches_to_continue(agent) {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if !sessions
            .get(session_key)
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            return Ok(manager.stopped(session_key));
        }
        let mut guard = session.lock().map_err(|e| e.to_string())?;
        // Stopping the wrap-up itself ends the completion; the process this
        // kills will never send that turn's full stop.
        manager.completion_cut_short(session_key, &guard, COMPLETION_STOPPED);
        let next = manager.take_queued_turn(session_key);
        if next.is_some() {
            manager
                .handoffs
                .lock()
                .map_err(|e| e.to_string())?
                .insert(session_key.to_string());
        }
        sessions.remove(session_key);
        guard.stdin.take();
        let _ = guard.child.kill();
        drop(guard);
        drop(sessions);
        if let Some(next) = next {
            let carried = start_queued_command_turn(manager.clone(), session_key, stream_key, next)
                .map_err(|why| format!("could not resume queued message: {why}"))?;
            if carried != Carried::Started {
                say_exited(manager, session_key, stream_key);
            }
        }
        return Ok(manager.stopped(session_key));
    }

    let mut guard = session.lock().map_err(|e| e.to_string())?;
    // Marked under the lock the interrupt goes out with, so nothing slips
    // into the gap: no notification, no message and no wrap-up is written
    // until the reader has seen the cut-off turn's full stop and cleared
    // this. A second Stop inside that wait is the same unwind: it asks the
    // agent again, and neither ends the wait nor starts another.
    let was_busy = guard.busy;
    let owed = guard.cut_off != CutOff::No;
    interrupt_persistent_turn(&mut guard)?;
    if was_busy && !owed {
        let unwind = manager.next_unwind();
        guard.cut_off = CutOff::Owed(unwind);
        end_process_when_grace_runs_out(manager, session_key, stream_key, &session, unwind);
    }
    // The cut-off wrap-up's own full stop finds no completion left to
    // decide, so a Stop can never tick a chat.
    manager.completion_cut_short(session_key, &guard, COMPLETION_STOPPED);
    drop(guard);
    // What waits is handed over on the stopped turn's full stop, where a
    // folder that is away holds it (`dispatch_next_persistent_turn`).
    let mut stopped = manager.stopped(session_key);
    if stopped.waiting > 0 && stopped.not_started.is_none() {
        stopped.not_started = crate::profile::available().err();
    }
    Ok(stopped)
}

impl ChatManager {
    /// What a Stop that has stopped the agent answers: how many messages
    /// still wait, and why the first did not start when its queue waits.
    fn stopped(&self, session_key: &str) -> Stopped {
        Stopped {
            stopped: true,
            waiting: self.queued_messages(session_key),
            not_started: self.waits_because(session_key),
        }
    }
}

/// The Stop button. Like `chat_stop_impl`, nothing in it waits on a save:
/// its answer is whether the agent was asked to stop, and what still waits
/// behind the stopped turn (`Stopped`).
pub fn chat_interrupt_impl(manager: &Arc<ChatManager>, key: String) -> Result<Stopped, String> {
    cancel_auto_resume(manager, &key, "cancelled when the user stopped the chat");
    let _delivery = manager
        .questions
        .delivery_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cancel_question_work(manager, &key);
    interrupt_session(manager, &key, &key)
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

/// Feedback 531f1dac: cut a worker's turn short so its coordinator's message
/// reaches it now. A worker reads a message between turns or in the answer to
/// its next call to the host, and one inside a twenty-minute render makes
/// neither, so a pause or a stop arrived after the work it was meant to
/// prevent.
///
/// The interrupt is the Stop button's: the provider cancels the running tool
/// and keeps the conversation, the attempt waits for a report rather than
/// failing, and `inbox::deliver_pending` hands the message over once the
/// cut-off turn has reached its own full stop.
pub(crate) fn interrupt_worker_turn(
    manager: &Arc<ChatManager>,
    key: &str,
) -> Result<WorkerInterrupt, String> {
    let busy = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        match sessions.get(key) {
            Some(session) => {
                let session = session.lock().map_err(|e| e.to_string())?;
                session.busy.then_some(session.agent)
            }
            None => None,
        }
    };
    let Some(agent) = busy else {
        return Ok(WorkerInterrupt::Idle);
    };
    if relaunches_to_continue(agent) {
        return Ok(WorkerInterrupt::Unsupported);
    }
    chat_interrupt_impl(manager, key.to_string())?;
    Ok(WorkerInterrupt::Interrupted)
}

fn write_codex_response(session: &Arc<Mutex<ChatSession>>, id: &Value, result: Value) {
    let Ok(mut guard) = session.lock() else {
        return;
    };
    let Some(stdin) = guard.stdin.as_mut() else {
        return;
    };
    let _ = write_json_line(stdin, &crate::codex_app_server::response(id, result));
}

fn write_codex_error(session: &Arc<Mutex<ChatSession>>, id: &Value, message: &str) {
    let Ok(mut guard) = session.lock() else {
        return;
    };
    let Some(stdin) = guard.stdin.as_mut() else {
        return;
    };
    let _ = write_json_line(stdin, &crate::codex_app_server::error_response(id, message));
}

fn answer_codex_server_request(
    manager: &Arc<ChatManager>,
    session: &Arc<Mutex<ChatSession>>,
    key: &str,
    rt: Option<&tokio::runtime::Handle>,
    request: Value,
) {
    let Some(id) = request.get("id").cloned() else {
        return;
    };
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            answer_codex_approval(session, key, rt, id, method, params)
        }
        "item/tool/requestUserInput" => {
            answer_codex_user_input(manager, session, key, rt, id, params)
        }
        "currentTime/read" => {
            let seconds = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0);
            write_codex_response(session, &id, json!({ "currentTimeAt": seconds }));
        }
        _ => write_codex_error(
            session,
            &id,
            &format!("OctiqFlow does not implement the Codex request '{method}'"),
        ),
    }
}

fn answer_codex_approval(
    session: &Arc<Mutex<ChatSession>>,
    key: &str,
    rt: Option<&tokio::runtime::Handle>,
    request_id: Value,
    method: &str,
    params: Value,
) {
    let command = params.get("command").and_then(Value::as_str);
    let grant_root = params.get("grantRoot").and_then(Value::as_str);
    let reason = params.get("reason").and_then(Value::as_str);
    let tool_name = if method == "item/commandExecution/requestApproval" {
        "Bash"
    } else {
        "Edit"
    };
    let mut input = Map::new();
    if let Some(command) = command {
        input.insert("command".into(), json!(command));
    }
    if let Some(cwd) = params.get("cwd").and_then(Value::as_str) {
        input.insert("cwd".into(), json!(cwd));
    }
    if let Some(root) = grant_root {
        input.insert("file_path".into(), json!(root));
    }
    if let Some(reason) = reason {
        input.insert("reason".into(), json!(reason));
    }
    let ask = crate::permission::Request {
        chat_key: Some(key.to_string()),
        session_id: params
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_name: Some(tool_name.into()),
        tool_input: Some(Value::Object(input)),
        tool_use_id: params
            .get("itemId")
            .and_then(Value::as_str)
            .map(str::to_string),
        cwd: params
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        access: None,
        ..Default::default()
    };
    let Some(rt) = rt else {
        write_codex_response(session, &request_id, json!({ "decision": "decline" }));
        return;
    };
    let session = session.clone();
    let key = key.to_string();
    rt.spawn(async move {
        let call = ask.tool_use_id.clone();
        let answer = crate::permission::ask(ask).await;
        let decision = if answer.decision == "allow" {
            "accept"
        } else {
            "decline"
        };
        note_permission_outcome(&key, call.as_deref(), &answer);
        write_codex_response(&session, &request_id, json!({ "decision": decision }));
    });
}

fn answer_codex_user_input(
    manager: &Arc<ChatManager>,
    session: &Arc<Mutex<ChatSession>>,
    key: &str,
    rt: Option<&tokio::runtime::Handle>,
    request_id: Value,
    params: Value,
) {
    let native = params
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if native.is_empty() {
        write_codex_response(session, &request_id, json!({ "answers": {} }));
        return;
    }
    let mut native_ids = Vec::with_capacity(native.len());
    let questions = native
        .iter()
        .map(|question| {
            native_ids.push(
                question
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|option| {
                    let label = option.get("label")?.as_str()?.to_string();
                    (!label.trim().is_empty()).then(|| crate::question::Choice {
                        label,
                        description: option
                            .get("description")
                            .and_then(Value::as_str)
                            .filter(|text| !text.trim().is_empty())
                            .map(str::to_string),
                    })
                })
                .collect();
            crate::question::Question {
                chat_key: None,
                question: question
                    .get("question")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex needs your input")
                    .to_string(),
                options,
                recommended: None,
                multiple: false,
            }
        })
        .collect::<Vec<_>>();
    let Some(rt) = rt else {
        write_codex_response(session, &request_id, json!({ "answers": {} }));
        return;
    };

    match route_worker_questions(manager, key, Some(key), None, &questions) {
        Ok(Some(message)) => {
            write_codex_error(session, &request_id, &message);
            return;
        }
        Err(why) => {
            write_codex_error(session, &request_id, &why);
            return;
        }
        Ok(None) => {}
    }

    let origin = {
        let _delivery = match manager.questions.delivery_lock.lock() {
            Ok(lock) => lock,
            Err(_) => {
                write_codex_response(session, &request_id, json!({ "answers": {} }));
                return;
            }
        };
        let origin = match manager.question_origin(key, Some(key), None) {
            Ok(origin) => origin,
            Err(why) => {
                write_codex_error(session, &request_id, &why);
                return;
            }
        };
        let inserted = manager.questions.insert(origin.clone(), questions);
        match inserted {
            Ok((id, rx)) => (origin, id, rx),
            Err(why) => {
                write_codex_error(session, &request_id, &why);
                return;
            }
        }
    };
    let (origin, card_id, answered) = origin;
    crate::push::notify_chat(
        Some(&origin.chat_key),
        "question",
        "Codex is waiting for your answer",
    );
    let manager = manager.clone();
    let session = session.clone();
    rt.spawn(async move {
        let _ = tokio::time::timeout(crate::question::ANSWER_TIMEOUT, answered).await;
        let answers = manager.questions.take_native(&card_id).ok().flatten();
        if answers.is_none() {
            manager.questions.detach(&card_id);
        }
        let mapped = native_ids
            .into_iter()
            .zip(answers.unwrap_or_default())
            .filter(|(id, _)| !id.is_empty())
            .map(|(id, answer)| (id, json!({ "answers": [answer] })))
            .collect::<Map<String, Value>>();
        write_codex_response(&session, &request_id, json!({ "answers": mapped }));
    });
}

pub(crate) fn route_worker_questions(
    manager: &Arc<ChatManager>,
    key: &str,
    session_key: Option<&str>,
    launch_id: Option<&str>,
    questions: &[crate::question::Question],
) -> Result<Option<String>, String> {
    if manager.orchestrations.worker_coordinator(key)?.is_none() {
        manager.orchestrations.require_user_chat(key)?;
        return Ok(None);
    }
    let gate = {
        let _delivery = manager
            .questions
            .delivery_lock
            .lock()
            .map_err(|e| e.to_string())?;
        manager.question_origin(key, session_key, launch_id)?;
        manager
            .orchestrations
            .route_worker_questions(key, questions)?
    };
    let Some(gate) = gate else {
        return Ok(None);
    };
    Ok(Some(format!(
        "Your questions were routed to main-chat gate {}. No answer has been given. End this turn and wait for the coordinator to resolve the gate; do not ask the user directly.",
        gate.id
    )))
}

/// Remember the tool calls in one Claude assistant message by id, so an
/// auto-mode refusal naming one can say exactly what was refused.
fn note_claude_calls(event: &Value, calls: &mut HashMap<String, (String, Value)>) {
    if event.get("type").and_then(Value::as_str) != Some("assistant") {
        return;
    }
    let Some(content) = event
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    if calls.len() > 256 {
        calls.clear();
    }
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let (Some(id), Some(name)) = (
            block.get("id").and_then(Value::as_str),
            block.get("name").and_then(Value::as_str),
        ) else {
            continue;
        };
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        calls.insert(id.to_string(), (name.to_string(), input));
    }
}

/// The server's runtime, recorded once at startup by `remember_runtime`.
static SERVER_RUNTIME: std::sync::OnceLock<tokio::runtime::Handle> = std::sync::OnceLock::new();

/// Record the runtime permission and question answers are waited on, for
/// chats started from threads that have none of their own.
pub fn remember_runtime(handle: tokio::runtime::Handle) {
    let _ = SERVER_RUNTIME.set(handle);
}

/// The runtime a chat's questions are answered on: the caller's own when it
/// has one, else the server's. None only when neither exists.
fn answer_runtime() -> Option<tokio::runtime::Handle> {
    tokio::runtime::Handle::try_current()
        .ok()
        .or_else(|| SERVER_RUNTIME.get().cloned())
}

/// Put the question to the person, then write the answer back to the agent.
///
/// The agent is BLOCKED until that answer arrives, so nothing here may be
/// skipped: every path writes exactly one `control_response`. A question that
/// went unanswered used to be a chat that sat still with nothing on screen
/// explaining why.
fn answer_permission(
    session: &Arc<Mutex<ChatSession>>,
    key: &str,
    rt: Option<&tokio::runtime::Handle>,
    request_id: String,
    request: Value,
) {
    let field = |name: &str| {
        request
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let ask = crate::permission::Request {
        chat_key: Some(key.to_string()),
        session_id: field("session_id"),
        tool_name: field("tool_name"),
        tool_input: request.get("input").cloned(),
        tool_use_id: field("tool_use_id"),
        cwd: None,
        // Only the hook had a stale copy of the level to report. This arrives
        // from the live process, so there is nothing to fall back to.
        access: None,
        ..Default::default()
    };

    let tool = ask.tool_name.clone().unwrap_or_default();
    if crate::permission::host_bookkeeping(&tool) {
        eprintln!("[perm] {key} {tool} -> allow (host bookkeeping)");
        write_control_response(session, &request_id, json!({ "behavior": "allow" }));
        return;
    }
    let Some(rt) = rt else {
        // No runtime to wait on — the desktop build. Deny rather than leave the
        // agent parked on a question that will never be put to anyone.
        eprintln!("[perm] {key} no runtime to ask on; denying {tool}");
        write_control_response(
            session,
            &request_id,
            json!({ "behavior": "deny", "message": "OctiqFlow could not ask anyone." }),
        );
        return;
    };

    let session = session.clone();
    let key = key.to_string();
    rt.spawn(async move {
        eprintln!("[perm] {key} asking about {tool}");
        let call = ask.tool_use_id.clone();
        let answer = crate::permission::ask(ask).await;
        note_permission_outcome(&key, call.as_deref(), &answer);
        eprintln!(
            "[perm] {key} {tool} -> {} ({})",
            answer.decision, answer.reason
        );
        // `allow` is the only yes. Everything else — a refusal, a timeout,
        // nobody watching — is a no WITH ITS REASON, which the agent repeats to
        // the user. "Abstain" has no meaning here: the chain has already decided
        // it wants a person, so there is nothing left to defer to.
        let response = if answer.decision == "allow" {
            json!({ "behavior": "allow" })
        } else {
            json!({ "behavior": "deny", "message": answer.reason })
        };
        write_control_response(&session, &request_id, response);
    });
}

/// A refused permission card is OctiqFlow's refusal, not the provider's: say
/// so on the call it was about, before the agent hears the answer, so the
/// line is in the transcript ahead of the failed result it explains.
fn note_permission_outcome(key: &str, call: Option<&str>, answer: &crate::permission::Answer) {
    if let (Some(call), Some(outcome)) = (call, crate::outcome::of_permission(answer)) {
        crate::outcome::record_tool(key, call, &outcome);
    }
}

/// Write one `control_response` back to the agent. Best-effort: a chat whose
/// stdin has gone is a chat that is no longer waiting for this.
fn write_control_response(session: &Arc<Mutex<ChatSession>>, request_id: &str, response: Value) {
    let Ok(mut guard) = session.lock() else {
        return;
    };
    let Some(payload) = provider_for(guard.agent).control_response_payload(request_id, response)
    else {
        return;
    };
    let Some(stdin) = guard.stdin.as_mut() else {
        return;
    };
    let _ = writeln!(stdin, "{payload}");
    let _ = stdin.flush();
}

/// Change what a RUNNING chat may do, WITHOUT ending it.
///
/// The mode is on the command line, so changing it used to mean killing the
/// process and letting the next message start a new one. That threw away a turn
/// in flight and said nothing about why the answer had stopped half-written.
/// Claude takes a `set_permission_mode` control request down the same stdin the
/// prompts go down — the way `chat_interrupt` takes `interrupt` — so the session
/// and its context survive the change.
///
/// The hook is told separately, through `ACCESS`. It runs BEFORE
/// `--permission-mode` is consulted, so the control request on its own would
/// leave it answering for the level the chat started on.
///
/// Not every change can be made this way, and the agent is the one that says
/// so: `bypassPermissions` is available only to a process that was launched
/// with `--dangerously-skip-permissions`, and `auto` is refused by models that
/// do not have it. Full is therefore rejected here before anything is written
/// to Claude's stream; the client restarts cleanly, and its next turn launches
/// at the requested level. Other provider refusals arrive on stdout and go out
/// as an `access-refused` status (see `refused_access_change`); the UI falls
/// back to the same restart. The recorded level is deliberately NOT rolled
/// back when that happens — every combination of "hook thinks X, agent is on
/// Y" the failure can leave behind ends in the agent asking or refusing, never
/// in it acting unasked.
///
/// Command-line providers have no such channel and need none: every turn is a
/// fresh process and receives its access flags on the command line, so recording
/// the level is the whole job.
pub fn chat_set_access_impl(
    manager: &ChatManager,
    key: String,
    access: Access,
) -> Result<(), String> {
    // A front desk's access is fixed at launch (read-only, `dontAsk` on
    // Claude), and every relaunch forces it again. A live switch would only
    // move it into another mode, so the change is accepted and not applied.
    // Not an error: the client answers an error with a restart.
    if manager
        .front_desks
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&key)
    {
        return Ok(());
    }
    if let Some(start) = manager.start_context(&key) {
        manager.admit_beside_writers(
            &key,
            &key,
            std::iter::once(&start.cwd).chain(start.extra_dirs.iter().flatten()),
            access != Access::Read,
        )?;
    }
    // WHICH WAY the level moves decides everything below (review of
    // b894867, H8). A lowering takes hold at once and is written down when
    // it can be. A raise outlives the moment it is given: a host resume, a
    // queued turn and the next process all start at it, so it needs its
    // record first, and while that cannot be written it is refused with
    // nothing changed. Said before anything else is touched.
    let before = manager.start_context(&key);
    let level = before
        .as_ref()
        .and_then(|start| start.access)
        .unwrap_or(Access::Read);
    let raise = crate::access_request::rank(access) > crate::access_request::rank(level);
    if raise {
        crate::profile::available().map_err(not_raised)?;
    }
    cancel_auto_resume(manager, &key, "cancelled when access changed");
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&key).cloned().ok_or("no such chat")?
    };
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let provider = provider_for(guard.agent);
    let thread = guard.codex.is_some();
    let live = !thread && provider.capabilities().supports_live_access_change;
    // A process that keeps the conversation but cannot change its access
    // (Antigravity) takes the new level in the process that resumes it.
    let relaunch = !thread
        && !live
        && provider.capabilities().input.accepts_stdin()
        && provider.capabilities().interrupt_ends_process;
    // Every refusal that changes nothing comes before the record of a raise.
    if relaunch && guard.busy {
        return Err(format!(
            "{} takes a new access level between turns. Wait for this turn or stop it, then change the access.",
            provider.display_name()
        ));
    }
    let payload = if live {
        if matches!(access, Access::Full) {
            return Err("Full access needs a fresh agent".into());
        }
        if guard.stdin.is_none() {
            return Err("this chat does not take more input".into());
        }
        Some(
            provider
                .access_change_payload(access)
                .ok_or("this chat does not take more input")?,
        )
    } else {
        None
    };
    if raise {
        manager.record_raise(&key, access)?;
    }
    if let Some(codex) = guard.codex.as_mut() {
        // app-server accepts policy overrides on every `turn/start`. Do not
        // disturb a turn already running; the next queued/direct turn picks up
        // the newly selected level on this same native thread.
        codex.access = Some(access);
        if let Ok(mut starts) = manager.starts.lock() {
            if let Some(start) = starts.get_mut(&key) {
                start.access = Some(access);
            }
        }
        record_access_for(&key, Some(access));
        manager.keep_access_for_resume(&key);
        return Ok(());
    }
    if let Some(payload) = payload {
        let told = guard
            .stdin
            .as_mut()
            .ok_or_else(|| "this chat does not take more input".to_string())
            .and_then(|stdin| {
                writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
                stdin.flush().map_err(|e| e.to_string())
            });
        if let Err(why) = told {
            // The agent was not told, so the chat still runs at the level
            // it had: the record of a raise goes back to that.
            if let (true, Some(before)) = (raise, before) {
                manager.keep_resume_at(&key, before);
            }
            return Err(why);
        }
    }
    if let Some(mut start) = manager.start_context(&key) {
        start.access = Some(access);
        manager.remember_start(&key, start);
    }
    manager.keep_access_for_resume(&key);
    if relaunch {
        drop(guard);
        end_process_when(manager, &key, Some(Duration::ZERO))?;
    }
    Ok(())
}

/// How a raise that cannot be recorded is refused, before the reason. The
/// page knows the refusal by these words (`web/src/lib/accessRaise.ts`): it
/// keeps the card that asked open and does not restart the agent.
pub(crate) const NOT_RAISED: &str = "The access level was not raised, and nothing was changed: ";

fn not_raised(why: String) -> String {
    format!("{NOT_RAISED}{why}")
}

impl ChatManager {
    /// Write down that `key` runs at `access` from here on, BEFORE the
    /// agent is told: where a host resume reads it back from (the ledger,
    /// for a chat a run knows). A chat no run knows has no host record of
    /// its level beyond this server's memory; the page keeps it with the
    /// chat, in the same folder, which the caller has just found there.
    fn record_raise(&self, key: &str, access: Access) -> Result<(), String> {
        let Some(mut start) = self.start_context(key) else {
            return Ok(());
        };
        start.access = Some(access);
        self.orchestrations
            .save_resume_context(key, start)
            .map_err(not_raised)
    }

    /// Put the record of a chat's level back to `start`, whether or not
    /// that can be saved: only ever a lowering, back to what still runs.
    fn keep_resume_at(&self, key: &str, start: StartContext) {
        if let Err(why) = self.orchestrations.keep_resume_context(key, start) {
            eprintln!("orchestration: could not keep the access level of {key}: {why}");
        }
    }
}

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
                    guard.turn_started();
                    "queued"
                } else {
                    manager.begin_completion(key, &turn_id, "started")?;
                    record_durable_user_turn(key, &turn_id, text, &[]);
                    let written = write_user_message_locked(&mut guard, text, &[], Some(&turn_id));
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

/// Whether a full stop is the agent finishing what it was asked, rather than
/// a failure, a refusal or a turn that was cut short. A completion ticks its
/// chat only on this.
fn ended_cleanly(agent: ChatAgent, event: &Value, newly_refused: bool) -> bool {
    let text = |name: &str| event.get(name).and_then(Value::as_str);
    match agent {
        ChatAgent::Antigravity => {
            !newly_refused
                && event.pointer("/result/status").and_then(Value::as_str) == Some("SUCCESS")
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
        ChatAgent::Pi => true,
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
            crate::record_trim::compact_chat(key);
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

/// Stop a chat and drop it. Killing an unknown key is a no-op success, so the
/// UI can close a chat twice without caring.
///
/// **Nothing here waits on a save** (review of 205bca2, H5). The scheduled
/// resume and the open questions are cancelled in this process whether or
/// not that could be written, and the process is ended either way; what
/// could not be recorded is said beside the answer (`unsaved::say`) and
/// owed by its store. The only error left is the process not ending.
pub fn chat_stop_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    cancel_auto_resume(manager, &key, "cancelled when the chat stopped");
    let _delivery = manager
        .questions
        .delivery_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cancel_question_work(manager, &key);
    forget_standing(&key);
    end_process(manager, &key)?;
    Ok(())
}

/// End only the host provider process so the same application conversation can
/// continue on another model. The old native session cannot be resumed by the
/// backend during the handoff; the next browser send supplies a fresh start
/// context for the selected provider. Permissions, access, and the transcript
/// belong to the user conversation and remain intact.
pub fn chat_retarget_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    cancel_auto_resume(manager, &key, "cancelled when the agent changed");
    end_process(manager, &key)?;
    manager
        .starts
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&key);
    // Forgotten in the ledger's memory whether or not that is saved: the
    // old provider's settings must not resume the chat after its process
    // was ended for another.
    manager.orchestrations.forget_resume_context(&key)?;
    Ok(())
}

/// End this chat's agent on purpose, and keep everything else about the chat.
///
/// The sweeper's ending, asked for instead of waited out. An agent reads its
/// MCP servers, its plugins and the tool list they add up to ONCE, at spawn, so
/// a chat that was already open when one of them was added never sees it. Until
/// this there was no way to a fresh process but to leave the chat alone for the
/// fifteen minutes the sweeper takes.
///
/// `end_process`, NOT `chat_stop_impl`, because standing permissions and the
/// access level belong to the work, and the work is carrying straight on.
///
/// Answers how many processes went, which is 0 for a chat already stopped.
pub fn chat_restart_impl(manager: &ChatManager, key: String) -> Result<usize, String> {
    Ok(usize::from(end_process(manager, &key)?))
}

/// Called while sandbox ownership is held, so no replacement process can start.
pub fn end_idle_for_sandbox(manager: &ChatManager, key: &str) -> Result<(), String> {
    if manager.has_queued_turns(key) {
        return Err("Wait for this chat's queued messages before changing its sandbox.".into());
    }
    end_process_when(manager, key, Some(Duration::ZERO))?;
    if manager
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(key)
    {
        return Err(
            "Wait for this chat's current turn and background work before changing its sandbox."
                .into(),
        );
    }
    Ok(())
}

/// End one chat process while preserving its transcript and remembered settings.
///
/// Unlike stopping a chat, this intentionally retains standing permissions and
/// access settings so the next message can resume the same work. Any queued
/// queued follow-up is discarded: the person explicitly ended the process it
/// was waiting on.
fn end_process(manager: &ChatManager, key: &str) -> Result<bool, String> {
    end_process_when(manager, key, None)
}

#[cfg(test)]
impl ChatManager {
    /// A stand-in agent under `key`, holding the capability a real launch
    /// is given. Returns that secret.
    pub(crate) fn test_launch(&self, key: &str) -> String {
        self.test_launch_in(key, key)
    }

    /// [`Self::test_launch`] for a process running under `key` in the chat
    /// `chat_key`: an additional agent in a room when the two differ.
    pub(crate) fn test_launch_in(&self, key: &str, chat_key: &str) -> String {
        let child = stand_in::still()
            .stdin(Stdio::null())
            .spawn()
            .expect("a stand-in agent");
        let launch_id = uuid::Uuid::new_v4().to_string();
        let mut sessions = self.sessions.lock().unwrap();
        let secret = self.grant_capability(&sessions, key, chat_key, &launch_id);
        sessions.insert(
            key.to_string(),
            Arc::new(Mutex::new(ChatSession {
                launch_id,
                user_turn_id: None,
                answering: None,
                child,
                stdin: None,
                codex: None,
                agent: ChatAgent::Claude,
                busy: false,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                leaving: None,
            })),
        );
        secret
    }

    /// The start settings a launched chat would have remembered, with a
    /// conversation id, so a stand-in can ask the way a real agent does.
    pub(crate) fn test_remember_start(&self, key: &str, cwd: &str) {
        self.starts.lock().unwrap().insert(
            key.to_string(),
            StartContext {
                cwd: cwd.into(),
                agent: ChatAgent::Claude,
                model: Some("sonnet".into()),
                access: Some(Access::Auto),
                extra_dirs: None,
                env: None,
                effort: None,
                lite: None,
                session_id: Some(format!("session-{key}")),
            },
        );
    }

    /// The session table, held until the guard drops: what a look that
    /// waits for no lock meets while another thread is in the table.
    pub(crate) fn test_hold_table(&self) -> impl Drop + '_ {
        self.sessions.lock().unwrap()
    }

    /// Put a stand-in from `test_launch` in a turn, or end its turn.
    pub(crate) fn test_busy(&self, key: &str, busy: bool) {
        let session = self.sessions.lock().unwrap().get(key).cloned().unwrap();
        session.lock().unwrap().busy = busy;
    }

    /// Leave a stand-in from `test_launch` as a Stop leaves a chat whose turn
    /// it cut short: idle at once, that turn's full stop still owed. `false`
    /// is the full stop being read. No thread waits out a grace.
    pub(crate) fn test_full_stop_owed(&self, key: &str, owed: bool) {
        let session = self.sessions.lock().unwrap().get(key).cloned().unwrap();
        let mut session = session.lock().unwrap();
        session.busy = false;
        session.cut_off = if owed {
            CutOff::Owed(self.next_unwind())
        } else {
            CutOff::No
        };
    }

    /// A stand-in under `key` that takes what is written to it, in a turn
    /// or between two: what a Stop or an interrupt has something to do to.
    pub(crate) fn test_hold(&self, key: &str, agent: ChatAgent, busy: bool) -> TestChild {
        let mut child = stand_in::echo()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("a stand-in agent");
        let stdin = child.stdin.take();
        self.sessions.lock().unwrap().insert(
            key.to_string(),
            Arc::new(Mutex::new(ChatSession {
                launch_id: "test-launch".into(),
                user_turn_id: None,
                answering: None,
                child,
                stdin,
                codex: None,
                agent,
                busy,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                leaving: None,
            })),
        );
        self.test_child(key)
    }

    /// `test_hold`, with everything written to the stand-in kept to be read:
    /// a control message that should not have been sent has somewhere to
    /// show up.
    pub(crate) fn test_hold_heard(
        &self,
        key: &str,
        agent: ChatAgent,
        busy: bool,
    ) -> (TestChild, BufReader<ChildStdout>) {
        let mut child = stand_in::echo()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("a stand-in agent");
        let stdin = child.stdin.take();
        let heard = stand_in::echoed(child.stdout.take().expect("the stand-in's stdout"));
        self.sessions.lock().unwrap().insert(
            key.to_string(),
            Arc::new(Mutex::new(ChatSession {
                launch_id: "test-launch".into(),
                user_turn_id: None,
                answering: None,
                child,
                stdin,
                codex: None,
                agent,
                busy,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                leaving: None,
            })),
        );
        (self.test_child(key), heard)
    }

    /// Make the stand-in under `key` a Codex app-server thread running at
    /// `access`, between turns.
    pub(crate) fn test_as_codex_thread(&self, key: &str, access: Access) {
        let session = self.sessions.lock().unwrap().get(key).cloned().unwrap();
        let mut session = session.lock().unwrap();
        session.agent = ChatAgent::Codex;
        session.codex = Some(CodexAppSession {
            thread_id: "thread-1".into(),
            active_turn_id: None,
            interrupt_when_started: false,
            next_request: 0,
            model: None,
            effort: None,
            access: Some(access),
            cwd: "/tmp".into(),
            workspace_roots: vec!["/tmp".into()],
            has_octiq_mcp: false,
        });
    }

    /// The level a Codex app-server stand-in would start its next turn at.
    pub(crate) fn test_codex_access(&self, key: &str) -> Option<Access> {
        let session = self.sessions.lock().unwrap().get(key).cloned().unwrap();
        let session = session.lock().unwrap();
        session.codex.as_ref().and_then(|codex| codex.access)
    }

    /// The start settings a chat launched as `agent` at `access` remembers,
    /// kept the way a launch keeps them: in memory, and in the ledger for a
    /// chat a run knows.
    pub(crate) fn test_start_at(&self, key: &str, agent: ChatAgent, access: Access) {
        let mut start = StartContext::for_test(agent, Some("native-session"));
        start.access = Some(access);
        self.remember_start(key, start);
    }

    /// The level the chat's remembered start settings name.
    pub(crate) fn test_start_access(&self, key: &str) -> Option<Access> {
        self.start_context(key).and_then(|start| start.access)
    }

    /// The process under `key`, to ask after once the chat has let go of it.
    pub(crate) fn test_child(&self, key: &str) -> TestChild {
        TestChild(self.sessions.lock().unwrap().get(key).cloned().unwrap())
    }

    /// Let a stand-in from `test_hold_heard` finish by itself: its stdin is
    /// closed and its exit waited for, so everything it was written has
    /// been echoed by the time its stdout is read. Ending it (`test_end`)
    /// kills it, and what it had not echoed yet is lost with it.
    pub(crate) fn test_finish(&self, key: &str) {
        let Some(session) = self.sessions.lock().unwrap().remove(key) else {
            return;
        };
        let mut session = session.lock().unwrap();
        session.stdin.take();
        let _ = session.child.wait();
    }

    /// End a stand-in from `test_launch`, as the chat ending would.
    pub(crate) fn test_end(&self, key: &str) {
        end_process(self, key).expect("end the stand-in");
    }

    /// The launch record of a second voice: a process key whose capability
    /// names another chat. No process is started.
    pub(crate) fn test_seat(&self, session_key: &str, chat_key: &str) {
        let sessions = self.sessions.lock().unwrap();
        self.grant_capability(&sessions, session_key, chat_key, "test-launch");
    }
}

/// A stand-in's process, held past the session table (`test_child`).
#[cfg(test)]
pub(crate) struct TestChild(Arc<Mutex<ChatSession>>);

#[cfg(test)]
impl TestChild {
    /// Whether the process is still running.
    pub(crate) fn alive(&self) -> bool {
        matches!(self.0.lock().unwrap().child.try_wait(), Ok(None))
    }

    /// `gone`, waiting only half a second: for a process that is expected
    /// to stay.
    pub(crate) fn gone_soon(&self) -> bool {
        for _ in 0..50 {
            if !self.alive() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }

    /// Whether the process ends within a few seconds: a kill is asked for,
    /// and the exit is seen a moment later.
    pub(crate) fn gone(&self) -> bool {
        for _ in 0..500 {
            if !self.alive() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }
}

/// Stand-in agent processes for tests, the same on every platform.
///
/// Not `sleep` or `cat`: Windows has neither. The stand-in is this test
/// binary run again on the one test below, which does nothing in a normal run
/// and plays the stand-in when `OCTIQ_TEST_STAND_IN` names a part.
#[cfg(test)]
pub(crate) mod stand_in {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{ChildStdout, Command};
    use std::time::Duration;

    const PART: &str = "OCTIQ_TEST_STAND_IN";
    /// What an echoing stand-in writes before it echoes anything. The test
    /// harness prints its own header first, and a reader skips past it.
    const READY: &str = "octiq-stand-in-ready";

    /// Its stdout goes nowhere unless the caller pipes it: the harness's own
    /// "test result" lines would otherwise land in the suite's log.
    fn playing(part: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().expect("the test binary"));
        command
            .args([
                "--exact",
                "agent_chat::stand_in::agent",
                "--nocapture",
                "--quiet",
                "--test-threads=1",
            ])
            .env(PART, part)
            .stdout(std::process::Stdio::null());
        command
    }

    /// A process that stays alive for 30 seconds unless it is killed.
    pub(crate) fn still() -> Command {
        playing("still")
    }

    /// A process that copies each line of its stdin to its stdout until stdin
    /// closes. Read its stdout through `echoed`.
    pub(crate) fn echo() -> Command {
        playing("echo")
    }

    /// The stdout of an `echo()` child, from the first echoed line on.
    pub(crate) fn echoed(stdout: ChildStdout) -> BufReader<ChildStdout> {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            let read = reader.read_line(&mut line).expect("the stand-in's stdout");
            assert!(read > 0, "the stand-in ended before it was ready");
            if line.trim_end() == READY {
                return reader;
            }
        }
    }

    #[test]
    fn agent() {
        match std::env::var(PART).as_deref() {
            Ok("still") => std::thread::sleep(Duration::from_secs(30)),
            Ok("echo") => {
                let mut out = std::io::stdout().lock();
                writeln!(out, "{READY}").and_then(|_| out.flush()).unwrap();
                let mut input = std::io::stdin().lock();
                let mut line = Vec::new();
                while input.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
                    if out.write_all(&line).and_then(|_| out.flush()).is_err() {
                        return;
                    }
                    line.clear();
                }
            }
            _ => {}
        }
    }
}

fn end_process_when(
    manager: &ChatManager,
    key: &str,
    idle: Option<Duration>,
) -> Result<bool, String> {
    let session = {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(timeout) = idle {
            let Some(session) = sessions.get(key) else {
                return Ok(false);
            };
            let session = session.lock().map_err(|e| e.to_string())?;
            // A chat whose queue waits for the profile folder is not idle:
            // ending it as idle would drop what the person queued.
            if session.still_for().is_none_or(|still| still < timeout)
                || manager.background.has_running(key)
                || manager.jobs.has_running(key)
                || manager.waits_because(key).is_some()
            {
                return Ok(false);
            }
        }
        sessions.remove(key)
    };
    // Ending the process on purpose ends a completion in it, running or
    // still queued: said once, before the queue is cleared.
    manager.fail_completion(key, COMPLETION_STOPPED);
    // Removal from the session map happens before clearing the queue, so a
    // concurrent send cannot add a new deferred turn after this cleanup.
    manager.forget_queued_turns(key);
    let Some(session) = session else {
        return Ok(false);
    };
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    stop_process(manager, key, &mut guard);
    Ok(true)
}

/// End the process of a session that has been taken out of the session
/// table. Called with the session held.
fn stop_process(manager: &ChatManager, key: &str, session: &mut ChatSession) {
    if let Err(error) = manager.background.interrupt(key, &session.launch_id,
        "The provider session was ended or switched. Background work is no longer attached; inspect retained output before retrying.") {
        eprintln!("chat: cannot record interrupted background work: {error}");
    }
    // Closing stdin asks persistent providers to finish; kill is the backstop.
    session.stdin.take();
    let _ = session.child.kill();
}

/// The chats that have been sitting still for longer than timeout.
fn still_keys(manager: &ChatManager, timeout: Duration) -> Vec<String> {
    let Ok(sessions) = manager.sessions.lock() else {
        return Vec::new();
    };
    sessions
        .iter()
        .filter(|(_, s)| {
            s.lock()
                .ok()
                .and_then(|s| s.still_for())
                .is_some_and(|still| still >= timeout)
        })
        .map(|(key, _)| key.clone())
        .collect()
}

/// End every chat that has been sitting still too long.
fn sweep_still_chats(manager: &ChatManager, timeout: Duration) -> Vec<String> {
    let mut ended = Vec::new();
    for key in still_keys(manager, timeout) {
        if end_process_when(manager, &key, Some(timeout)) == Ok(true) {
            ended.push(key);
        }
    }
    ended
}

/// End every idle chat whose agent program an upgrade removed
/// (`ChatManager::replaced_binary_keys`). `Duration::ZERO` still makes
/// `end_process_when` re-check, under its locks, that no turn and no
/// background work started in between.
fn sweep_replaced_binaries(manager: &ChatManager) -> Vec<String> {
    manager
        .replaced_binary_keys()
        .into_iter()
        .filter(|key| end_process_when(manager, key, Some(Duration::ZERO)) == Ok(true))
        .collect()
}

/// Watch for chats nobody is using and give their memory back.
pub fn start_idle_reaper(manager: Arc<ChatManager>) {
    let Some(timeout) = idle_timeout() else {
        println!("[chat] idle sweeper off (OCTIQ_CHAT_IDLE_MINS=0)");
        return;
    };
    println!(
        "[chat] idle sweeper on: a chat with nothing happening for {} minutes is ended and resumed on its next message",
        timeout.as_secs() / 60
    );
    thread::spawn(move || loop {
        thread::sleep(IDLE_SWEEP);
        for key in sweep_still_chats(&manager, timeout) {
            println!("[chat] {key} ended after {}m still", timeout.as_secs() / 60);
            // Every message in it has stopped, so its stream pieces can go.
            crate::record_trim::compact_chat(&key);
        }
        for key in sweep_replaced_binaries(&manager) {
            println!("[chat] {key} ended: the agent program it runs was replaced on disk");
        }
    });
}

const AUTO_RESUME_SWEEP: Duration = Duration::from_secs(15);
const AUTO_RESUME_PROMPT: &str = "[OctiqFlow automatic resume after usage reset]\n\
Continue the task that the usage limit interrupted. Inspect the conversation and current workspace state first, then continue from the latest unfinished step without repeating completed work.";

/// Deliver one scheduler-owned turn through the same paths as a browser send.
/// An idle-reaped process is recreated with its exact saved launch settings;
/// a still-live persistent process receives an ordinary next turn.
fn run_scheduled_resume(
    manager: Arc<ChatManager>,
    entry: &crate::auto_resume::ScheduledResume,
) -> Result<(), String> {
    let key = entry.chat_key.clone();
    let turn_id = Some(format!("octiq-auto-resume-{}", entry.id));
    let send = |manager: Arc<ChatManager>| {
        chat_send_with_user_turn(
            manager,
            key.clone(),
            AUTO_RESUME_PROMPT.into(),
            None,
            None,
            turn_id.clone(),
        )
    };
    let start = |manager: Arc<ChatManager>| {
        let saved = entry.start.clone();
        let result = start_session(
            manager.clone(),
            Voice::host(key.clone()),
            saved.cwd.clone(),
            saved.agent,
            saved.model.clone(),
            saved.access,
            Some(AUTO_RESUME_PROMPT.into()),
            saved.session_id.clone(),
            saved.extra_dirs.clone(),
            saved.env.clone(),
            saved.effort.clone(),
            None,
            saved.lite,
            turn_id.clone(),
            true,
            None,
        );
        if result.is_ok() {
            manager.remember_start(&key, saved);
        }
        result
    };

    let live = manager
        .sessions
        .lock()
        .map_err(|error| error.to_string())?
        .contains_key(&key);
    if live {
        match send(manager.clone()) {
            Err(why) if why.contains("no such chat") => start(manager),
            result => result,
        }
    } else {
        match start(manager.clone()) {
            Err(why) if why.contains("already running") => send(manager),
            result => result,
        }
    }
}

/// Start the profile-local scheduler. It runs once immediately so an overdue
/// reset resumes after a service restart, then checks cheaply every few
/// seconds. No browser needs to be open.
pub fn start_auto_resume_scheduler(manager: Arc<ChatManager>) {
    thread::spawn(move || {
        // Reconcile the transcript with the authoritative schedule after a
        // crash between its JSON write and its lifecycle event. Repeating an
        // event with the same id is reducer-idempotent.
        match manager.auto_resumes.cancelled() {
            Ok(entries) => {
                for entry in entries {
                    crate::auto_resume::announce_cancelled(
                        &entry,
                        "cancelled before the service restarted",
                    );
                    if let Err(why) = manager.auto_resumes.finish(&entry) {
                        eprintln!(
                            "[chat] could not clear cancelled auto-resume {}: {why}",
                            entry.id
                        );
                    }
                }
            }
            Err(why) => {
                eprintln!("[chat] auto-resume scheduler unavailable: {why}");
                return;
            }
        }
        match manager.auto_resumes.scheduled() {
            Ok(entries) => {
                for entry in entries {
                    crate::auto_resume::announce_scheduled(&entry);
                }
            }
            Err(why) => {
                eprintln!("[chat] auto-resume scheduler unavailable: {why}");
                return;
            }
        }
        match manager.auto_resumes.take_uncertain() {
            Ok(entries) => {
                for entry in entries {
                    crate::auto_resume::announce_failed(
                        &entry,
                        "The service restarted while auto-resume was dispatching, so it was not repeated. Resume manually after checking the chat.",
                    );
                }
            }
            Err(why) => {
                eprintln!("[chat] auto-resume scheduler unavailable: {why}");
                return;
            }
        }

        loop {
            let due = match manager
                .auto_resumes
                .claim_due(crate::auto_resume::unix_now())
            {
                Ok(entries) => entries,
                Err(why) => {
                    eprintln!("[chat] could not read due auto-resumes: {why}");
                    thread::sleep(AUTO_RESUME_SWEEP);
                    continue;
                }
            };
            for entry in due {
                crate::auto_resume::announce_started(&entry);
                let result = run_scheduled_resume(manager.clone(), &entry);
                if let Err(why) = &result {
                    crate::auto_resume::announce_failed(&entry, why);
                }
                if let Err(why) = manager.auto_resumes.finish(&entry) {
                    eprintln!(
                        "[chat] could not finish auto-resume {} for {}: {why}",
                        entry.id, entry.chat_key
                    );
                }
            }
            thread::sleep(AUTO_RESUME_SWEEP);
        }
    });
}

/// Permanently remove chats whose one-day trash window has elapsed. Startup
/// reconciliation handles time spent with the server off; this minute sweep
/// handles a server that stays up for days.
pub fn start_deleted_chat_reaper() {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(60));
        if let Err(why) = purge_deleted_chats() {
            eprintln!("[chats] could not purge expired chats: {why}");
        }
    });
}

/// Where pasted images are kept. Under ~/.octiqflow rather than in the
/// project, because a screenshot pasted into a chat is not part of a
/// repository and must never turn up in git status.
pub(crate) fn attachments_dir() -> Result<std::path::PathBuf, String> {
    let dir = crate::paths::home_dir()
        .ok_or("could not find your home folder")?
        .join(".octiqflow")
        .join("attachments");
    crate::profile::create_dir_all(&dir).map_err(|e| format!("could not make {dir:?}: {e}"))?;
    Ok(dir)
}

/// Save a browser upload and return the server path used by both agents.
/// Older clients send only an image extension; new clients also send a filename.
pub fn save_attachment(
    data_base64: String,
    extension: String,
    filename: Option<String>,
) -> Result<String, String> {
    let bytes = decode_attachment(&data_base64)?;
    let name = attachment_name(filename.as_deref(), &extension)?;
    let path = attachments_dir()?.join(format!("{}-{name}", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).map_err(|e| format!("could not save the file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn attachment_name(filename: Option<&str>, extension: &str) -> Result<String, String> {
    if let Some(filename) = filename {
        // Strip both platforms' path separators and controls. Keep Unicode and
        // the original extension so document tools can recognize the upload.
        let name: String = filename
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_control())
            .collect();
        if name.is_empty() || name == "." || name == ".." || name.len() > 200 {
            return Err("invalid filename (maximum 200 bytes)".into());
        }
        return Ok(name);
    }
    let ext = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => Ok(format!("pasted.{ext}")),
        _ => Err(format!("unsupported image type: {extension}")),
    }
}

fn decode_attachment(data_base64: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    const LIMIT: usize = 12 * 1024 * 1024;
    if data_base64.len() > LIMIT / 3 * 4 {
        return Err("file is larger than 12 MB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("not valid base64: {e}"))?;
    if bytes.len() > LIMIT {
        return Err("file is larger than 12 MB".into());
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "ending_tests.rs"]
mod ending_tests;

#[cfg(test)]
#[path = "reach_tests.rs"]
mod reach_tests;

#[cfg(test)]
#[path = "answered_tests.rs"]
mod answered_tests;

#[cfg(test)]
#[path = "host_turn_tests.rs"]
mod host_turn_tests;

#[cfg(test)]
mod upload_tests {
    use super::{attachment_name, decode_attachment};
    use base64::Engine;

    #[test]
    fn accepts_documents_without_mime_types_and_keeps_unicode_names() {
        assert_eq!(
            attachment_name(Some("报告.docx"), ""),
            Ok("报告.docx".into())
        );
        assert_eq!(attachment_name(Some("README"), ""), Ok("README".into()));
        let pdf = b"%PDF-1.7\n\0\xff";
        assert_eq!(
            decode_attachment(&base64::engine::general_purpose::STANDARD.encode(pdf)),
            Ok(pdf.to_vec())
        );
        assert_eq!(decode_attachment(""), Ok(vec![]));
    }

    #[test]
    fn confines_names_and_keeps_legacy_image_uploads() {
        assert_eq!(
            attachment_name(Some("../../report.pdf"), ""),
            Ok("report.pdf".into())
        );
        assert_eq!(
            attachment_name(Some(r"C:\docs\report.pdf"), ""),
            Ok("report.pdf".into())
        );
        assert!(attachment_name(Some(".."), "").is_err());
        assert!(attachment_name(Some(&"a".repeat(201)), "").is_err());
        assert_eq!(attachment_name(None, ".JPEG"), Ok("pasted.jpeg".into()));
        assert!(attachment_name(None, "../pdf").is_err());
    }

    #[test]
    fn rejects_invalid_and_oversized_payloads() {
        assert!(decode_attachment("!invalid!").is_err());
        assert!(decode_attachment(&"A".repeat(16 * 1024 * 1024 + 4)).is_err());
    }
}

/// The chats that exist, newest first.
pub fn chat_index_list() -> Vec<crate::chat_index::ChatMeta> {
    let _ = purge_deleted_chats();
    visible_chats(crate::chat_index::list())
}

/// Every chat but the front-desk ones (`team::FrontDeskChat`), which no list,
/// count or search ever shows. Keyed by the chat's identity on the host, so
/// a page that saved one anyway still never gets it back.
pub(crate) fn visible_chats(
    chats: Vec<crate::chat_index::ChatMeta>,
) -> Vec<crate::chat_index::ChatMeta> {
    let hidden: std::collections::HashSet<String> =
        crate::team::front_desk_chats(&crate::team::default_path())
            .into_iter()
            .map(|chat| chat.chat_key)
            .collect();
    if hidden.is_empty() {
        return chats;
    }
    chats
        .into_iter()
        .filter(|meta| !hidden.contains(&format!("chat:{}", meta.id)))
        .collect()
}

/// Chats in the one-day trash, newest deletion first.
pub fn chat_index_deleted() -> Vec<crate::chat_index::ChatMeta> {
    let _ = purge_deleted_chats();
    crate::chat_index::deleted()
}

/// Say that the list of chats has changed, so every OTHER browser can pick the
/// change up without being reloaded.
///
/// Until this event existed a browser read the list when it connected and never
/// again, which made the sidebar a snapshot: a chat started on the phone reached
/// the laptop at the next reload and not before.
///
/// It carries the id and whether the chat went, rather than the entry itself,
/// and the client is free to use neither — it re-reads the whole list. That is
/// deliberate. One shape of answer means a row on screen can only ever be one
/// this server actually holds, and the list is metadata for a handful of chats.
pub(crate) fn announce_index_change(id: &str, gone: bool) {
    crate::bus::emit(
        "chat-index-changed",
        serde_json::json!({ "id": id, "gone": gone }),
    );
}

/// Record a chat, or update what is known about it.
pub fn chat_index_save(meta: crate::chat_index::ChatMeta) -> Result<(), String> {
    let id = meta.id.clone();
    // A front-desk chat is never recorded: nothing lists it, and its
    // transcript goes at the next start like any chat no row points at.
    if crate::team::is_front_desk_chat(&crate::team::default_path(), &format!("chat:{id}")) {
        return Ok(());
    }
    crate::chat_index::upsert(meta)?;
    // Only once it is actually on disk. Announcing a write that failed would
    // send every other device to fetch a list that has not changed.
    announce_index_change(&id, false);
    Ok(())
}

pub fn chat_set_agent_title(
    chat_id: String,
    title: String,
) -> Result<crate::chat_index::ChatTitleUpdate, String> {
    let result = crate::chat_index::set_agent_title(&chat_id, &title)?;
    if result.updated {
        announce_index_change(&chat_id, false);
    }
    Ok(result)
}

/// A chat was opened; move its shared "last read" mark forward and tell every
/// other browser so an unread dot there clears too. Its own command rather
/// than a `chat_index_save` — this fires on every open, and a save carries a
/// FULL entry that can be stale by the time it lands (see
/// `chat_index::mark_read`).
pub fn chat_mark_read(id: String, at: i64) -> Result<(), String> {
    crate::chat_index::mark_read(&id, at)?;
    announce_index_change(&id, false);
    Ok(())
}

/// Tick a chat off by hand, or take the tick back. Narrow for the same reason
/// as `chat_mark_read`: it answers one question, and a full save cannot be
/// trusted to carry an answer it was assembled before hearing (see
/// `chat_index::set_done`). Announced, so the other devices' lists move too —
/// a chat ticked off on the phone should not still be sitting in the laptop's
/// active list.
pub fn chat_set_done(id: String, at: Option<i64>) -> Result<(), String> {
    crate::chat_index::set_done(&id, at)?;
    announce_index_change(&id, false);
    Ok(())
}

/// Move a chat into the one-day trash. The old command name is kept so an
/// already-open browser gets the safer behaviour as soon as the backend is
/// updated. `expected_generation` makes a delayed retry from before a restore
/// harmless.
pub fn chat_index_remove(
    id: String,
    _key: String,
    expected_generation: Option<u64>,
    meta: Option<crate::chat_index::ChatMeta>,
) -> Result<(), String> {
    if crate::chat_index::trash(&id, expected_generation, meta)? {
        announce_index_change(&id, true);
    }
    Ok(())
}

/// Bring a soft-deleted chat back while its restore window is still open.
pub fn chat_index_restore(id: String) -> Result<Option<crate::chat_index::ChatMeta>, String> {
    let restored = crate::chat_index::restore(&id)?;
    if restored.is_some() {
        announce_index_change(&id, false);
    } else {
        // If the request arrived just past the deadline, finish the hard delete
        // now rather than waiting for the next minute sweep.
        let _ = purge_deleted_chats();
    }
    Ok(restored)
}

/// Remove expired index rows and transcripts, and tell open browsers so a
/// Trash panel can discard them immediately.
fn purge_deleted_chats() -> Result<usize, String> {
    let expired = crate::chat_index::purge_expired()?;
    for id in &expired {
        // The task record goes with the chat it describes. It is kept through
        // the trash window, so a restore brings back a chat that still knows
        // where its work went.
        crate::chat_task::forget(id);
        // And so does its plan, kept through the same window.
        crate::chat_plan::forget(id);
        announce_index_change(id, true);
    }
    if !expired.is_empty() {
        println!(
            "[chats] permanently removed {} expired chat(s)",
            expired.len()
        );
    }
    Ok(expired.len())
}

/// Everything a chat said after `after`.
///
/// How a client catches up. It remembers the highest seq it has seen and asks
/// for the rest — after a reconnect, a reload, or on a second device that has
/// never seen this conversation at all.
pub fn chat_since(key: String, after: u64) -> Vec<crate::transcript::Recorded> {
    crate::transcript::since(&key, after)
}

/// Throw away a chat's record. Deleting a conversation should leave nothing.
pub fn chat_forget(key: String) {
    crate::transcript::forget(&key);
}

/// The keys of every running chat. A reconnecting browser uses this the way it
/// uses pty_active_sessions: to find what is already going.
pub fn chat_list_impl(manager: &ChatManager) -> Result<Vec<String>, String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.keys().cloned().collect())
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

/// Every running chat with its turn state. The Agents page asks this for a
/// lead's conversation, which a freshly loaded page has seen no events from
/// and so cannot tell working from sitting idle. A session whose lock is
/// poisoned says not busy rather than guessing.
pub fn chat_activity_impl(manager: &ChatManager) -> Result<Vec<ChatActivity>, String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions
        .iter()
        .map(|(key, session)| ChatActivity {
            key: key.clone(),
            busy: session.lock().map(|s| s.busy).unwrap_or(false),
            completing: manager.completing_turn(key).is_some(),
        })
        .collect())
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

pub fn chat_queue_state_impl(manager: &ChatManager, key: &str) -> Result<ChatQueueState, String> {
    // Match the send/reaper lock order, so an enqueue cannot cross this read.
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let handoffs = manager.handoffs.lock().map_err(|e| e.to_string())?;
    let queues = manager.queued_turns.lock().map_err(|e| e.to_string())?;
    Ok(ChatQueueState {
        held: manager.waits_because(key),
        completing_turn_id: manager.completing_turn(key),
        live: sessions.contains_key(key) || handoffs.contains(key),
        queued_turn_ids: queues
            .get(key)
            .into_iter()
            .flat_map(|turns| {
                turns
                    .iter()
                    .flat_map(QueuedTurn::turn_ids)
                    .map(str::to_string)
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_provider::{
        test_image_media_type as image_media_type, test_sh_quote as sh_quote,
        test_toml_string as toml_string,
    };

    const CONVERSATION_URL: &str =
        "https://optiqflow.app/#/p/workspace/c/1a735592-37d3-40ed-a0d4-c49665cbacaf";

    /// Whether a launch is a front desk is decided in ONE place: `start_session`
    /// asks `team::is_front_desk_chat` by the chat's own key, and that answer
    /// alone sets the access, the tools, the provider's front-desk flags and
    /// `OCTIQ_FRONT_DESK`. First start, resume, restart recovery, a queued Codex
    /// turn, a notification, a scheduled resume and a handover's origin all
    /// come through it, so each carries the marker, and an ordinary chat is
    /// handed an empty one whatever the server inherited. This pins that
    /// shape: a second spawn site, a second command builder, or a process
    /// whose key is not its chat's would each be a launch path that skips it.
    #[test]
    fn every_agent_launch_decides_front_desk_by_the_chat_key_in_one_place() {
        let source = include_str!("agent_chat.rs");
        let production = &source[..source.find("\n#[cfg(test)]\nmod tests {").unwrap()];
        assert_eq!(production.matches("provider.build_command(").count(), 1);
        assert_eq!(
            production
                .matches(".env(\"OCTIQ_FRONT_DESK\", if front_desk { \"1\" } else { \"\" })")
                .count(),
            1
        );
        assert_eq!(
            production
                .matches("crate::team::is_front_desk_chat(&crate::team::default_path(), &key)")
                .count(),
            1
        );
        // The agent itself is started once, in `start_session`.
        assert_eq!(
            production
                .matches(".command(&format!(\"exec {line}\"))")
                .count(),
            1
        );
        let calls: Vec<&str> = production
            .match_indices("start_session(")
            .map(|(at, _)| &production[at..])
            .filter(|rest| !production[..production.len() - rest.len()].ends_with("fn "))
            .collect();
        assert!(calls.len() >= 6, "{} launch sites", calls.len());
        for call in calls {
            let args = &call[..call.find(')').unwrap() + 1];
            let voice = call["start_session(".len()..].trim_start();
            assert!(
                voice.starts_with("manager") || voice.starts_with("manager.clone()"),
                "{args}"
            );
            let after_manager = voice[voice.find(',').unwrap() + 1..].trim_start();
            assert!(
                after_manager.starts_with("Voice::host("),
                "a launch whose process key is not its chat's: {}",
                &after_manager[..after_manager.len().min(60)]
            );
        }
    }

    /// Feedback 56dd3f24: a refusal names the exact call it refused, from the
    /// assistant message that made it. The card is a record and a decision;
    /// nothing about it lets the call run.
    #[test]
    fn a_claude_refusal_card_names_the_call_it_refused() {
        let key = format!("chat:refusal-{}", uuid::Uuid::new_v4());
        let line = "npm publish --tag next";
        let denial = json!({"type":"system","subtype":"permission_denied","decision_reason":"[Publish]",
            "decision_reason_type":"classifier","tool_name":"Bash","tool_use_id":"toolu_pub","message":"denied"});
        let mut calls = HashMap::new();
        let call = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"Publishing."},
            {"type":"tool_use","id":"toolu_pub","name":"Bash","input":{"command": line}}]}});
        note_claude_calls(&call, &mut calls);
        let (name, input) = calls.get("toolu_pub").unwrap();
        assert!(crate::safety_block::observe_claude_denial(
            &key,
            None,
            &denial,
            Some((name, input))
        ));
        let card = crate::safety_block::pending()
            .into_iter()
            .find(|b| b.chat_key() == key)
            .unwrap();
        assert_eq!(card.action(), Some(line));
        crate::safety_block::forget_chat(&key);
    }

    /// Feedback 467a6314: the orchestration scheduler starts workers from a
    /// plain thread, where `Handle::try_current` finds nothing, and every
    /// permission such a worker asked for was denied with "OctiqFlow could not
    /// ask anyone". A chat started there must still find a runtime.
    #[test]
    fn a_chat_started_off_the_runtime_can_still_ask_the_person() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        remember_runtime(runtime.handle().clone());
        let found = std::thread::spawn(|| {
            assert!(tokio::runtime::Handle::try_current().is_err());
            answer_runtime().is_some()
        })
        .join()
        .unwrap();
        assert!(found, "a scheduler-started chat has a runtime to wait on");
    }

    #[test]
    fn a_model_handoff_keeps_history_separate_from_the_new_user_message() {
        let history = r#"[{"role":"user","text":"Use Opus 4.6"}]"#;
        let prompt =
            model_handoff_prompt(history, "Now compare it to GPT.\nDo not lose this line.");
        assert!(prompt.contains(history));
        assert!(prompt.contains(
            r#"Current user message (JSON string):
"Now compare it to GPT.\nDo not lose this line.""#
        ));
        assert_eq!(prompt.matches("Use Opus 4.6").count(), 1);
    }

    #[test]
    fn sends_during_a_process_handoff_remain_cancellable_and_durable() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("queue-handoff-{}", uuid::Uuid::new_v4());
        manager.handoffs.lock().unwrap().insert(key.clone());
        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            "arrived during replacement".into(),
            Some(vec!["/tmp/image.png".into()]),
            None,
            Some("follow-up".into()),
            None,
        )
        .unwrap();
        let snapshot = chat_queue_state_impl(&manager, &key).unwrap();
        assert!(snapshot.live);
        assert_eq!(snapshot.queued_turn_ids, ["follow-up"]);
        let events = crate::transcript::since(&key, 0);
        assert_eq!(
            events[0].event["octiq_attachments"][0]["path"],
            "/tmp/image.png"
        );
        assert_eq!(events[1].event["state"], "queued");
        assert_eq!(
            chat_cancel_queued_impl(&manager, key.clone(), "follow-up".into()),
            Ok(true)
        );
        crate::transcript::forget(&key);
    }

    #[test]
    fn a_failed_queue_handoff_records_failure_for_every_waiting_message() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("queue-failed-{}", uuid::Uuid::new_v4());
        manager.handoffs.lock().unwrap().insert(key.clone());
        for id in ["one", "two"] {
            chat_send_user_impl(
                manager.clone(),
                key.clone(),
                id.into(),
                None,
                None,
                Some(id.into()),
                None,
            )
            .unwrap();
        }
        let next = manager.take_queued_turn(&key).unwrap();
        assert!(start_queued_command_turn(manager.clone(), &key, &key, next).is_err());
        let failed: Vec<_> = crate::transcript::since(&key, 0)
            .into_iter()
            .filter(|event| event.event["state"] == "failed")
            .map(|event| event.event["uuid"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(failed, ["one", "two"]);
        assert!(!chat_queue_state_impl(&manager, &key).unwrap().live);
        assert!(!manager.has_queued_turns(&key));
        crate::transcript::forget(&key);
    }

    #[test]
    fn claude_echoes_use_the_dispatched_id_without_claiming_tool_results() {
        let mut echo =
            json!({"type":"user", "message":{"content":[{"type":"text", "text":"same words"}]}});
        stamp_user_turn_id(&mut echo, ChatAgent::Claude, Some("exact-turn"));
        assert_eq!(echo["octiq_user_turn_id"], "exact-turn");
        let mut result = json!({"type":"user", "message":{"content":[{"type":"tool_result", "content":"done"}]}});
        stamp_user_turn_id(&mut result, ChatAgent::Claude, Some("exact-turn"));
        assert!(result.get("octiq_user_turn_id").is_none());
    }

    #[test]
    fn queue_state_reports_only_the_requested_chat_queue() {
        let manager = ChatManager::default();
        for (key, id) in [("chat-check", "host"), ("chat-other", "other")] {
            manager
                .queue_turn(
                    key,
                    QueuedTurn {
                        text: "waiting".into(),
                        images: vec![],
                        turn_id: Some(id.into()),
                        appended_turn_ids: vec![],
                        recorded: true,
                        context: None,
                    },
                )
                .unwrap();
        }
        let mut snapshot = chat_queue_state_impl(&manager, "chat-check").unwrap();
        snapshot.queued_turn_ids.sort();
        assert!(!snapshot.live);
        assert_eq!(snapshot.queued_turn_ids, ["host"]);
        let empty = chat_queue_state_impl(&ChatManager::default(), "chat-check").unwrap();
        assert!(!empty.live);
        assert!(empty.queued_turn_ids.is_empty());
    }

    #[test]
    fn continue_conversation_routes_mcp_agents_to_the_reader_first() {
        let original = format!("continue {CONVERSATION_URL}");

        let routed = routed_prompt(ChatAgent::Codex, &original);
        assert!(routed.contains("MUST call `mcp__octiq__read_conversation`"));
        assert!(routed.contains(CONVERSATION_URL));
        assert!(routed.contains("Do not open this URL in Browser"));

        let turn = crate::codex_app_server::turn_request(crate::codex_app_server::TurnRequest {
            id: "request-1",
            thread_id: "thread-1",
            text: &routed,
            images: &[],
            client_user_message_id: Some("user-1"),
            cwd: "/work",
            workspace_roots: &["/work".into()],
            model: None,
            effort: None,
            access: Some(Access::Auto),
            runtime_context: "runtime",
        });
        let sent = turn["params"]["input"][0]["text"].as_str().unwrap();
        assert!(sent.contains("mcp__octiq__read_conversation"));
        assert!(sent.contains("Do not open this URL in Browser"));
    }

    #[test]
    fn continuation_routing_is_narrow_and_leaves_other_prompts_untouched() {
        let bare_link = format!("please review {CONVERSATION_URL}");
        assert!(matches!(
            routed_prompt(ChatAgent::Codex, &bare_link),
            Cow::Borrowed(_)
        ));
        assert!(matches!(
            routed_prompt(ChatAgent::Codex, "continue the implementation"),
            Cow::Borrowed(_)
        ));
        assert!(matches!(
            routed_prompt(ChatAgent::Claude, &format!("continue {CONVERSATION_URL}")),
            Cow::Borrowed(_)
        ));
        assert!(matches!(
            routed_prompt(ChatAgent::Pi, &format!("continue {CONVERSATION_URL}")),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn codex_prompt_event_keeps_text_and_attachments() {
        let event = durable_user_event("user-1", "look at this", &["/tmp/screenshot.png".into()]);

        assert_eq!(event["type"], "user");
        assert_eq!(event["uuid"], "user-1");
        assert_eq!(event["octiq_user_turn"], true);
        assert_eq!(event["message"]["content"][0]["text"], "look at this");
        assert_eq!(event["octiq_attachments"][0]["path"], "/tmp/screenshot.png");
    }

    #[test]
    fn notifications_use_internal_receipts_for_both_providers() {
        for (agent, mut event) in [
            (ChatAgent::Codex, json!({"type":"turn.started"})),
            (
                ChatAgent::Claude,
                json!({"type":"user","message":{"content":"host ping"}}),
            ),
        ] {
            let mut pending = Some("octiq-notification-test".into());
            acknowledge_user_turn(&mut event, agent, &mut pending);
            assert!(pending.is_none());
            assert!(event.get("octiq_user_turn_id").is_none());
            assert_eq!(
                event["octiq_orchestration_notification_id"],
                "octiq-notification-test"
            );
        }
    }

    #[test]
    fn user_queue_precedes_internal_turns_and_preserves_each_fifo() {
        let manager = ChatManager::default();
        for (id, recorded) in [
            ("host1", false),
            ("user1", true),
            ("host2", false),
            ("user2", true),
        ] {
            manager
                .queue_turn(
                    "priority",
                    QueuedTurn {
                        text: id.into(),
                        images: vec![],
                        turn_id: Some(id.into()),
                        appended_turn_ids: vec![],
                        recorded,
                        context: None,
                    },
                )
                .unwrap();
        }
        let queues = manager.queued_turns.lock().unwrap();
        let ids: Vec<_> = queues["priority"].iter().map(|t| t.text.as_str()).collect();
        assert_eq!(ids, ["user1", "user2", "host1", "host2"]);
        drop(queues);
        assert!(!manager.notification_ready("priority"));
    }

    #[test]
    fn startup_without_a_provider_receipt_leaves_delivery_unconfirmed() {
        let mut pending = Some("exact-turn".to_string());
        let mut startup = json!({ "type": "thread.started", "thread_id": "thread" });
        acknowledge_user_turn(&mut startup, ChatAgent::Codex, &mut pending);
        assert_eq!(pending.as_deref(), Some("exact-turn"));
        // This pending id is what the stdout EOF path reports as unknown.
        let mut receipt = json!({ "type": "turn.started" });
        acknowledge_user_turn(&mut receipt, ChatAgent::Codex, &mut pending);
        assert_eq!(receipt["octiq_user_turn_id"], "exact-turn");
        assert!(pending.is_none());

        let mut pending = Some("claude-turn".to_string());
        let mut output =
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result" }] } });
        acknowledge_user_turn(&mut output, ChatAgent::Claude, &mut pending);
        assert!(pending.is_some());
        let mut receipt = json!({ "type": "user", "message": { "content": "hello" } });
        acknowledge_user_turn(&mut receipt, ChatAgent::Claude, &mut pending);
        assert_eq!(receipt["octiq_user_turn_id"], "claude-turn");
        assert!(pending.is_none());
    }

    #[test]
    fn command_line_turn_starts_receive_the_exact_user_turn_id() {
        let mut codex_started = json!({ "type": "turn.started" });
        stamp_user_turn_id(&mut codex_started, ChatAgent::Codex, Some("user-earlier"));
        assert_eq!(
            codex_started["octiq_user_turn_id"],
            Value::String("user-earlier".into())
        );

        let mut claude_user = json!({ "type": "user" });
        let before = claude_user.clone();
        stamp_user_turn_id(&mut claude_user, ChatAgent::Claude, Some("user-1"));
        assert_eq!(
            claude_user, before,
            "Claude's known-good stream is untouched"
        );

        let mut codex_answer = json!({ "type": "item.completed" });
        let before = codex_answer.clone();
        stamp_user_turn_id(&mut codex_answer, ChatAgent::Codex, Some("user-1"));
        assert_eq!(codex_answer, before, "only the acknowledgement is stamped");

        let mut pi_started = json!({ "type": "turn_start" });
        stamp_user_turn_id(&mut pi_started, ChatAgent::Pi, Some("user-pi"));
        assert_eq!(
            pi_started["octiq_user_turn_id"],
            Value::String("user-pi".into())
        );

        let mut pi_answer = json!({ "type": "message_end" });
        let before = pi_answer.clone();
        stamp_user_turn_id(&mut pi_answer, ChatAgent::Pi, Some("user-pi"));
        assert_eq!(pi_answer, before, "only Pi's acknowledgement is stamped");

        // Antigravity's own `user_input` step, from its real stream, is its
        // acknowledgement; its answer is not.
        let events =
            crate::agent_provider::tests::agy_events(crate::agent_provider::tests::AGY_THREE_TURNS);
        let mut took = events[1].clone();
        stamp_user_turn_id(&mut took, ChatAgent::Antigravity, Some("user-agy"));
        assert_eq!(took["octiq_user_turn_id"], json!("user-agy"));
        let mut answer = events[2].clone();
        let before = answer.clone();
        stamp_user_turn_id(&mut answer, ChatAgent::Antigravity, Some("user-agy"));
        assert_eq!(
            answer, before,
            "only Antigravity's acknowledgement is stamped"
        );
    }

    /// Antigravity keeps one process across turns like Claude, but a stop or
    /// an exit continues it in a new one, carrying the queue, like Pi.
    #[test]
    fn only_a_provider_without_an_in_band_stop_relaunches_to_continue() {
        assert!(!relaunches_to_continue(ChatAgent::Claude));
        assert!(relaunches_to_continue(ChatAgent::Pi));
        assert!(relaunches_to_continue(ChatAgent::Antigravity));
        assert!(provider_for(ChatAgent::Antigravity)
            .capabilities()
            .input
            .accepts_stdin());
    }

    #[test]
    fn full_access_is_named_in_the_environment_the_hook_reads() {
        assert_eq!(Access::Full.as_env(), "full");
        assert_eq!(Access::Auto.as_env(), "auto");
        assert_eq!(Access::Read.as_env(), "read");
    }

    #[test]
    fn the_agents_permission_question_is_recognised_and_nothing_else_is() {
        // The shape is measured, not guessed: it is what `claude -p
        // --permission-prompt-tool stdio` actually wrote when asked to run a
        // command it needed approval for.
        let asking = json!({
            "type": "control_request",
            "request_id": "req-1",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "Bash",
                "display_name": "Bash",
                "input": { "command": "mkfifo /tmp/x.fifo" },
                "permission_suggestions": [{
                    "type": "addRules",
                    "rules": [{ "toolName": "Bash", "ruleContent": "mkfifo /tmp/x.fifo" }]
                }]
            }
        });
        let observed = provider_for(ChatAgent::Claude).observe_event(&asking);
        let permission = observed.permission.expect("the question");
        assert_eq!(permission.id, "req-1");
        assert_eq!(permission.request["tool_name"], "Bash");

        // Control requests travel BOTH ways on this channel. Ours must not be
        // mistaken for the agent's, or setting the mode would raise a question.
        let ours = json!({
            "type": "control_request",
            "request_id": "octiq-access-1",
            "request": { "subtype": "set_permission_mode", "mode": "auto" }
        });
        assert!(provider_for(ChatAgent::Claude)
            .observe_event(&ours)
            .permission
            .is_none());
        let assistant = json!({ "type": "assistant" });
        assert!(provider_for(ChatAgent::Claude)
            .observe_event(&assistant)
            .permission
            .is_none());
    }

    #[test]
    fn removed_agent_tools_are_not_exposed_to_the_host() {
        let c = build_command_with_mcp(
            ChatAgent::Claude,
            None,
            None,
            "hi",
            None,
            &[],
            None,
            &[],
            false,
            Some(std::path::Path::new("octiq-ask.json")),
        );

        assert!(
            !c.contains("mcp__octiq__add_agent"),
            "add_agent remains: {c}"
        );
        assert!(
            !c.contains("mcp__octiq__ask_agent"),
            "ask_agent remains: {c}"
        );
        assert!(c.contains("mcp__octiq__ask_user"));
        assert!(c.contains("mcp__octiq__search_conversations"));
        assert!(c.contains("mcp__octiq__read_conversation"));
        assert!(c.contains("whole message is `continue <OctiqFlow conversation URL>`"));
        assert!(c.contains("must not open it in Browser"));
    }

    #[test]
    fn the_agent_is_told_to_ask_us_rather_than_deny() {
        // Without this flag an `ask` decision in print mode is terminal: the
        // call is denied, nobody is asked, and the chat says nothing about why.
        let line = build_command(
            ChatAgent::Claude,
            None,
            Some(Access::Auto),
            "hello",
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(line.contains("--permission-prompt-tool stdio"));
    }

    #[test]
    fn the_question_tool_the_agent_cannot_be_answered_on_is_taken_back() {
        // `--permission-prompt-tool stdio` does not only route permissions. It
        // also hands the model `AskUserQuestion`, which plain print mode never
        // offered: measured on the same CLI, 30 built-in tools without the flag
        // and 33 with it, the three being `AskUserQuestion`, `EnterPlanMode`
        // and `ExitPlanMode`. The flag alone does it; the handshake is not
        // involved.
        //
        // That tool is not ours to answer. It is not a `can_use_tool` request —
        // permission is granted and the CLI then runs the tool itself, looking
        // for an interactive prompt that a `-p` process does not have. It gives
        // up at once and tells the agent "The user did not answer the
        // questions", which reads as a refusal nobody made.
        //
        // So it is taken back, and `ask_user` is left as the only way to ask —
        // the one that reaches a phone. Unconditional on purpose: when the MCP
        // config could not be written there is no `ask_user` either, and no
        // question at all is what this command line did before the flag arrived.
        let line = build_command(
            ChatAgent::Claude,
            None,
            Some(Access::Auto),
            "hello",
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(line.contains("--disallowedTools AskUserQuestion"));
    }

    #[test]
    fn a_lite_chat_drops_the_machines_skills_hooks_and_other_mcp_servers() {
        // What this machine loads into a chat that never asked for it: ten MCP
        // servers, every installed skill, and the SessionStart hooks. Measured
        // in this repo, that is 60.4k of context before the first word — half
        // of it the skill list alone. Lite is the same chat without them.
        //
        // `--bare` is the flag that reads like the answer and is not: it never
        // looks at the OAuth login or the keychain, so on a subscription it
        // dies at "Not logged in" before it reaches the model. `--safe-mode`
        // does keep the login, but it drops MCP servers passed with
        // `--mcp-config` too — which is where `ask_user` lives, so the chat
        // could no longer ask anything. These three flags are the cut that
        // leaves the login and our own two tools standing: 30.2k.
        let line = build_command_with_mcp(
            ChatAgent::Claude,
            None,
            Some(Access::Auto),
            "hello",
            None,
            &[],
            None,
            &[],
            true,
            Some(std::path::Path::new("octiq-ask.json")),
        );
        assert!(line.contains("--strict-mcp-config"));
        assert!(line.contains("--disable-slash-commands"));
        // Empty, and quoted: the flag takes a list, and no list is the whole
        // point. An unquoted empty word would vanish in the shell and the next
        // flag would be read as its value.
        assert!(line.contains("--setting-sources ''"));
        // Ours survives the cut. `--strict-mcp-config` means ONLY the servers
        // named on this command line, and ours is named on it.
        assert!(line.contains("--mcp-config"));
    }

    #[test]
    fn a_normal_chat_still_gets_everything_this_machine_offers() {
        let line = build_command(
            ChatAgent::Claude,
            None,
            Some(Access::Auto),
            "hello",
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(!line.contains("--strict-mcp-config"));
        assert!(!line.contains("--disable-slash-commands"));
        assert!(!line.contains("--setting-sources"));
    }

    #[test]
    fn lite_says_nothing_to_codex() {
        // Codex loads its skills from a folder rather than from the config it
        // can be told to ignore, so the same idea saved 21.2k against 20.8k
        // there — a rounding error, for flags that would still have to be
        // written and kept right. The switch is a Claude one until that changes.
        let line = build_command(
            ChatAgent::Codex,
            None,
            Some(Access::Auto),
            "hello",
            None,
            &[],
            None,
            &[],
            true,
        );
        assert!(!line.contains("--ignore-user-config"));
        assert!(!line.contains("--strict-mcp-config"));
    }

    #[test]
    fn a_folder_name_cannot_break_out_of_the_toml_string_it_lands_in() {
        // `writable_roots` is a TOML array built by hand, so the path inside it
        // has to survive TOML as well as the shell. sh_quote covers the shell
        // and nothing else: a `"` in a folder name would close the string and
        // whatever follows would be read as more config.
        assert_eq!(toml_string(r#"/tmp/plain"#), r#""/tmp/plain""#);
        assert_eq!(
            toml_string(r#"/tmp/a", evil = "yes"#),
            r#""/tmp/a\", evil = \"yes""#
        );
        assert_eq!(toml_string(r"/tmp/back\slash"), r#""/tmp/back\\slash""#);
        assert_eq!(
            toml_string("line one\nline two\tend"),
            r#""line one\nline two\tend""#
        );
    }

    #[test]
    fn a_codex_resume_puts_the_folder_in_the_config_key_safely() {
        let roots = vec![r#"/tmp/a", evil = "yes"#.to_string()];
        let request =
            crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
                cwd: "/tmp",
                model: None,
                effort: None,
                access: None,
                resume: Some("abc-123"),
                workspace_roots: &roots,
                developer_instructions: "host",
            });
        assert_eq!(request["params"]["runtimeWorkspaceRoots"], json!(roots));
    }

    #[test]
    fn quotes_close_the_hole() {
        assert_eq!(sh_quote("plain"), "'plain'");
        // The one character that can end the quoted run is re-opened safely.
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("a; rm -rf /"), "'a; rm -rf /'");
    }

    #[test]
    fn model_names_are_allowlisted() {
        assert_eq!(safe_model("opus").as_deref(), Some("opus"));
        assert_eq!(
            safe_model("claude-fable-5").as_deref(),
            Some("claude-fable-5")
        );
        assert_eq!(safe_model("gpt-5.6-sol").as_deref(), Some("gpt-5.6-sol"));
        // Anything that could become another shell word is refused outright.
        assert_eq!(safe_model("opus; id"), None);
        assert_eq!(safe_model("$(id)"), None);
        assert_eq!(safe_model(""), None);
    }

    #[test]
    fn resume_only_takes_a_plain_id() {
        let id = "a2c8ca18-dcd4-41bc-a49d-b078f2a8e056";
        let c = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            Some(id),
            &[],
            None,
            &[],
            false,
        );
        assert!(c.contains(&format!("--resume '{id}'")));
        // Anything that could become a second shell word is dropped outright.
        let bad = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            Some("x; rm -rf /"),
            &[],
            None,
            &[],
            false,
        );
        assert!(!bad.contains("--resume"));
    }

    #[test]
    fn one_access_level_becomes_each_agents_own_flag() {
        // The same question — how much may it do unattended — asked once and
        // spelled differently for each agent. Codex needs BOTH halves: a sandbox
        // says what a command may touch, an approval policy says whether it runs
        // unasked. Setting only the sandbox left the middle level asking about
        // everything and the top level asking at all, neither of which is what
        // the label promises.
        for (level, claude_flag, sandbox, approval) in [
            (Access::Read, "--permission-mode plan", "read-only", "never"),
            (
                Access::Auto,
                "--permission-mode auto",
                "workspace-write",
                "on-request",
            ),
            (
                Access::Full,
                "--dangerously-skip-permissions",
                "danger-full-access",
                "never",
            ),
        ] {
            let c = build_command(
                ChatAgent::Claude,
                None,
                Some(level),
                "",
                None,
                &[],
                None,
                &[],
                false,
            );
            assert!(c.contains(claude_flag), "claude {level:?}");
            assert!(
                !c.contains("--sandbox"),
                "claude must not get a sandbox flag"
            );

            let roots = vec!["/work".into()];
            let request =
                crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
                    cwd: "/work",
                    model: None,
                    effort: None,
                    access: Some(level),
                    resume: None,
                    workspace_roots: &roots,
                    developer_instructions: "host",
                });
            assert_eq!(request["params"]["sandbox"], sandbox, "codex {level:?}");
            assert_eq!(
                request["params"]["approvalPolicy"], approval,
                "codex approval {level:?}"
            );
        }
    }

    #[test]
    fn codex_resume_spells_both_halves_as_config_keys() {
        // app-server resumes the native thread and applies the selected policy
        // in the same typed request, independent of the user's config file.
        let id = "a2c8ca18-dcd4-41bc-a49d-b078f2a8e056";
        let roots = vec!["/work".into()];
        let request =
            crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
                cwd: "/work",
                model: None,
                effort: None,
                access: Some(Access::Auto),
                resume: Some(id),
                workspace_roots: &roots,
                developer_instructions: "host",
            });
        assert_eq!(request["method"], "thread/resume");
        assert_eq!(request["params"]["threadId"], id);
        assert_eq!(request["params"]["sandbox"], "workspace-write");
        assert_eq!(request["params"]["approvalPolicy"], "on-request");
    }

    #[test]
    fn claude_and_codex_both_get_a_two_way_stream() {
        // A prompt that cannot appear by accident inside another word. The
        // first version of this test used "hi", which is a substring of
        // "which" — so it passed until an unrelated flag happened to contain
        // that word, then failed for a reason that had nothing to do with the
        // thing being tested.
        let prompt = "zzq-prompt-marker";
        let c = build_command(
            ChatAgent::Claude,
            Some("opus"),
            Some(Access::Read),
            prompt,
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(c.contains("--input-format stream-json"));
        assert!(c.contains("--model 'opus'"));
        assert!(c.contains("--permission-mode plan"));
        // Claude's prompt goes over stdin, never on the command line.
        assert!(!c.contains(prompt));

        let x = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hi there",
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(x.starts_with("codex app-server --enable default_mode_request_user_input"));
        assert!(!x.contains("hi there"));
        assert_eq!(
            provider_for(ChatAgent::Codex).capabilities().input,
            crate::agent_provider::InputTransport::AppServer
        );
    }

    #[test]
    fn effort_is_an_allowlist_and_spelled_per_agent() {
        let c = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &[],
            Some("xhigh"),
            &[],
            false,
        );
        assert!(c.contains("--effort xhigh"));
        // Codex carries the validated value in its typed turn request.
        assert_eq!(
            provider_for(ChatAgent::Codex).effort("xhigh"),
            Some("xhigh")
        );

        // Anything outside the set is dropped rather than forwarded.
        let bad = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &[],
            Some("turbo; id"),
            &[],
            false,
        );
        assert!(!bad.contains("--effort"));

        // `max` is BOTH agents': Codex's own model list gives it to every
        // GPT-5.6 model (`supported_reasoning_levels` in
        // `~/.codex/models_cache.json`), so refusing it here dropped a level
        // the agent would have taken.
        let claude_max = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &[],
            Some("max"),
            &[],
            false,
        );
        assert!(claude_max.contains("--effort max"));
        assert_eq!(provider_for(ChatAgent::Codex).effort("max"), Some("max"));

        // `minimal` is nobody's any more. The same model list dropped it from
        // every GPT-5.6 model, and Claude never had it.
        assert_eq!(provider_for(ChatAgent::Codex).effort("minimal"), None);
        let claude_min = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &[],
            Some("minimal"),
            &[],
            false,
        );
        assert!(!claude_min.contains("--effort"));

        // `ultracode` is Claude's top rung. It is missing from `--help`, but the
        // flag takes it: an unknown value warns and falls back, and this one
        // does not.
        let ultra = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &[],
            Some("ultracode"),
            &[],
            false,
        );
        assert!(ultra.contains("--effort ultracode"));
        assert_eq!(provider_for(ChatAgent::Codex).effort("ultracode"), None);

        // `auto` deliberately reaches the command line as nothing at all: the
        // flag rejects it, and no flag IS "the agent picks". The UI then sends
        // `/effort auto` to the running session, which does take it.
        let auto = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &[],
            Some("auto"),
            &[],
            false,
        );
        assert!(!auto.contains("--effort"));
    }

    #[test]
    fn codex_continues_a_conversation_by_resuming_its_thread() {
        let id = "01a0142d-552d-7a93-9152-47530c33e501";
        let roots = vec!["/tmp".into(), "/tmp/api".into()];
        let resumed =
            crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
                cwd: "/tmp",
                model: None,
                effort: Some("high"),
                access: Some(Access::Read),
                resume: Some(id),
                workspace_roots: &roots,
                developer_instructions: "host",
            });
        assert_eq!(resumed["method"], "thread/resume");
        assert_eq!(resumed["params"]["threadId"], id);
        assert_eq!(resumed["params"]["sandbox"], "read-only");
        assert_eq!(
            resumed["params"]["config"]["model_reasoning_effort"],
            "high"
        );
        assert_eq!(resumed["params"]["runtimeWorkspaceRoots"], json!(roots));

        let turn = crate::codex_app_server::turn_request(crate::codex_app_server::TurnRequest {
            id: "request-1",
            thread_id: id,
            text: "next question",
            images: &[],
            client_user_message_id: Some("user-1"),
            cwd: "/tmp",
            workspace_roots: &roots,
            model: None,
            effort: Some("high"),
            access: Some(Access::Read),
            runtime_context: "runtime",
        });
        assert_eq!(turn["params"]["input"][0]["text"], "next question");
        assert_eq!(turn["params"]["threadId"], id);

        let first =
            crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
                cwd: "/tmp",
                model: None,
                effort: None,
                access: Some(Access::Read),
                resume: None,
                workspace_roots: &roots,
                developer_instructions: "host",
            });
        assert_eq!(first["method"], "thread/start");
        assert_eq!(first["params"]["ephemeral"], false);
    }

    #[test]
    fn codex_is_allowed_to_run_where_there_is_no_git_repo() {
        // app-server receives the cwd as protocol data and does not impose the
        // `codex exec` git trust gate on either a new or resumed thread.
        let roots = vec!["/tmp/scratch".into()];
        for resume in [None, Some("01a0142d-552d-7a93-9152-47530c33e501")] {
            let request =
                crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
                    cwd: "/tmp/scratch",
                    model: None,
                    effort: None,
                    access: Some(Access::Read),
                    resume,
                    workspace_roots: &roots,
                    developer_instructions: "host",
                });
            assert_eq!(request["params"]["cwd"], "/tmp/scratch");
        }

        // Claude has no such check and no such flag; handing it one would be
        // an unknown argument.
        let claude = build_command(
            ChatAgent::Claude,
            None,
            Some(Access::Read),
            "hello",
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(!claude.contains("--skip-git-repo-check"), "{claude}");
    }

    #[test]
    fn codex_missing_rollout_thread_stays_in_diagnostics_without_hiding_other_failures() {
        let codex = provider_for(ChatAgent::Codex);
        let mut state = OutputState::default();
        let line = "2026-09-08T07:41:49.205220Z ERROR codex_core::session: failed to record rollout items: thread 01a07ff6-0e48-79b1-ae44-e34950e03069 not found";
        assert_eq!(
            codex.classify_output(line, &mut state),
            OutputDisposition::DiagnosticsOnly
        );
        assert_eq!(
            codex.classify_output(line, &mut state),
            OutputDisposition::DiagnosticsOnly
        );
        for other in [
            "2026-09-08T07:41:50Z ERROR codex_core::session: failed to record rollout items: disk full",
            "2026-09-08T07:41:50Z ERROR codex_core::auth: token expired",
            "turn.failed",
            "process exited with code 1",
        ] {
            assert_eq!(codex.classify_output(other, &mut state), OutputDisposition::Visible);
        }
        assert_eq!(
            codex.classify_output(line, &mut OutputState::default()),
            OutputDisposition::DiagnosticsOnly
        );
        assert_eq!(
            provider_for(ChatAgent::Claude).classify_output(line, &mut state),
            OutputDisposition::Visible
        );
    }

    #[test]
    fn codex_internal_output_is_ignored_or_kept_in_diagnostics() {
        let codex = provider_for(ChatAgent::Codex);
        assert_eq!(
            codex.output_disposition("Reading additional input from stdin..."),
            OutputDisposition::Ignore,
        );
        assert_eq!(
            codex.output_disposition("  Reading additional input from stdin... "),
            OutputDisposition::Ignore,
        );
        assert_eq!(
            codex.output_disposition(
                "2026-08-30T09:38:25Z ERROR codex_models_manager::manager: \
                 failed to renew cache TTL: missing field `supports_parallel_tool_calls`"
            ),
            OutputDisposition::Ignore,
        );
        assert_eq!(
            codex.output_disposition(
                "2026-08-31T00:00:05.370617Z ERROR codex_core::tools::router: \
                 error=apply_patch verification failed: Failed to find expected lines"
            ),
            OutputDisposition::DiagnosticsOnly,
        );
        assert_eq!(
            codex.output_disposition(
                "2026-09-07T08:29:34.050136Z ERROR codex_core::tools::router: \
                 error=write_stdin failed: Unknown process id 29017"
            ),
            OutputDisposition::DiagnosticsOnly,
        );
        assert_eq!(
            codex.output_disposition(
                "2026-09-14T18:14:29.286752Z ERROR codex_core::tools::router: \
                 error=collab spawn failed: agent thread limit reached"
            ),
            OutputDisposition::DiagnosticsOnly,
        );
        // Real agent failures still reach the user.
        assert_eq!(
            codex.output_disposition("Error loading config.toml"),
            OutputDisposition::Visible,
        );
        assert_eq!(
            codex.output_disposition("You've hit your usage limit."),
            OutputDisposition::Visible,
        );
    }

    #[test]
    fn a_dead_process_leaves_its_exit_code_and_last_error_line() {
        // Feedback 2adec4d5: bash refused the launch line and said why, and
        // the attempt said only "disconnected".
        assert_eq!(
            last_words(Some(2), "bash: -c: line 26: unexpected EOF").as_deref(),
            Some(
                "The process exited with code 2. Its last error output: \
                 bash: -c: line 26: unexpected EOF"
            )
        );
        // An idle worker reaped after a clean turn has nothing to add.
        assert_eq!(last_words(Some(0), ""), None);
        // Killed, or gone without a code: still worth the line it left.
        assert_eq!(
            last_words(None, " lost the pipe \n").as_deref(),
            Some("The process ended without an exit code. Its last error output: lost the pipe")
        );
        assert_eq!(
            last_words(Some(1), "").as_deref(),
            Some("The process exited with code 1.")
        );
        // The line reaches the coordinator's inbox, so it is kept short.
        let long = last_words(Some(1), &"é".repeat(2_000)).unwrap();
        assert!(long.chars().count() < 400, "{}", long.chars().count());
        assert!(long.ends_with('…'));
    }

    #[test]
    fn all_codex_router_failures_are_diagnostics_but_other_errors_stay_visible() {
        let codex = provider_for(ChatAgent::Codex);
        let mut state = OutputState::default();
        let duplicate = "2026-09-08T06:26:14.629158Z ERROR codex_core::tools::router: error=agent path `/root/onboarding_backend` already exists";
        for line in [
            duplicate,
            "2026-09-08T06:26:15Z ERROR codex_core::tools::router: error=agent path `/root/onboarding_backend` failed to start",
            "2026-09-08T06:26:17Z ERROR codex_core::tools::router: error=file already exists",
        ] {
            assert_eq!(
                codex.classify_output(line, &mut state),
                OutputDisposition::DiagnosticsOnly,
            );
        }
        assert_eq!(
            codex.classify_output(
                "2026-09-08T06:26:16Z ERROR codex_core::auth: token expired",
                &mut state,
            ),
            OutputDisposition::Visible,
        );
        assert_eq!(
            provider_for(ChatAgent::Claude).output_disposition(duplicate),
            OutputDisposition::Visible,
        );
    }

    #[test]
    fn codex_patch_error_context_stays_out_of_chat_notices() {
        let codex = provider_for(ChatAgent::Codex);
        let mut output_state = OutputState::default();

        assert_eq!(
            codex.classify_output(
                "2026-08-31T06:50:38.687616Z ERROR codex_core::tools::router: \
                 error=apply_patch verification failed: Failed to find expected lines",
                &mut output_state,
            ),
            OutputDisposition::DiagnosticsOnly,
        );
        assert_eq!(
            codex.classify_output("- I03 — 作者选定横幅名", &mut output_state),
            OutputDisposition::DiagnosticsOnly,
        );
        assert_eq!(
            codex.classify_output(".msgs-inner {", &mut output_state),
            OutputDisposition::DiagnosticsOnly,
        );
        // The following timestamped record is new output, rather than failed
        // patch context, so its normal visibility rule takes over again.
        assert_eq!(
            codex.classify_output(
                "2026-08-31T06:50:39Z ERROR codex_core::auth: token expired",
                &mut output_state,
            ),
            OutputDisposition::Visible,
        );
    }

    #[test]
    fn codex_exec_command_router_failure_stays_out_of_chat_notices() {
        let codex = provider_for(ChatAgent::Codex);
        let mut output_state = OutputState::default();

        // Codex logs a shell command containing newlines as one tracing record,
        // but BufRead delivers it as several physical lines. None should become
        // a separate amber notice.
        for line in [
            "2026-09-01T03:56:54.470794Z ERROR codex_core::tools::router: \
             error=exec_command failed for `/bin/zsh -lc 'rm -f /tmp/probe.json",
            "test ! -e /workspace/output",
            "lsof -nP -iTCP:4321 -sTCP:LISTEN'`: CreateProcess { message: \
             rejected: rm -f style commands are not permitted }",
        ] {
            assert_eq!(
                codex.classify_output(line, &mut output_state),
                OutputDisposition::DiagnosticsOnly,
            );
        }

        // A later, independent failure must still reach the user.
        assert_eq!(
            codex.classify_output(
                "2026-09-01T03:56:55Z ERROR codex_core::auth: token expired",
                &mut output_state,
            ),
            OutputDisposition::Visible,
        );
    }

    #[test]
    fn codex_exec_rejection_without_a_printed_command_is_diagnostics_only() {
        // Newer Codex builds omit `for <command>` when the process is rejected
        // before spawn. This is the exact shape safety-review refusals use.
        let codex = provider_for(ChatAgent::Codex);

        assert_eq!(
            codex.output_disposition(
                "2026-09-05T12:44:54Z ERROR codex_core::tools::router: \
                 error=exec_command failed: CreateProcess { message: \
                 Rejected(\"This action was rejected due to unacceptable risk.\") }"
            ),
            OutputDisposition::DiagnosticsOnly,
        );
    }

    #[test]
    fn codex_colored_exec_failure_is_diagnostics_only() {
        // Newer Codex tracing output adds SGR colour codes around every field.
        // Classification must read through those codes while diagnostics keep
        // the original record intact.
        let line = "\x1b[2m2026-09-19T23:56:22.037052Z\x1b[0m \x1b[31mERROR\x1b[0m \
                    \x1b[2mcodex_core::tools::router\x1b[0m\x1b[2m:\x1b[0m \
                    \x1b[3merror\x1b[0m\x1b[2m=\x1b[0mexec_command failed: \
                    CreateProcess { message: \"Rejected(\\\"Failed to create unified exec process: \
                    No such file or directory (os error 2)\\\")\" }";
        let codex = provider_for(ChatAgent::Codex);
        let mut state = OutputState::default();

        assert_eq!(
            codex.classify_output(line, &mut state),
            OutputDisposition::DiagnosticsOnly,
        );
    }

    #[test]
    fn codex_split_safety_rejection_stays_out_of_raw_chat_notices() {
        let codex = provider_for(ChatAgent::Codex);
        let mut output_state = OutputState::default();

        for line in [
            "2026-09-07T12:15:53.336267Z ERROR codex_core::tools::router: \
             error=This action was rejected due to unacceptable risk.",
            "Reason: the patch would falsify a validation record.",
            "The agent must not attempt to achieve the same outcome via workaround.",
        ] {
            assert_eq!(
                codex.classify_output(line, &mut output_state),
                OutputDisposition::DiagnosticsOnly,
            );
        }
    }

    #[test]
    fn codex_takes_images_as_files_and_claude_does_not() {
        let shots = vec!["/tmp/a shot.png".to_string(), "/tmp/b.webp".to_string()];
        let roots = vec!["/tmp".into()];
        let turn = |text: &str| {
            crate::codex_app_server::turn_request(crate::codex_app_server::TurnRequest {
                id: "request-1",
                thread_id: "thread-1",
                text,
                images: &shots,
                client_user_message_id: None,
                cwd: "/tmp",
                workspace_roots: &roots,
                model: None,
                effort: None,
                access: None,
                runtime_context: "runtime",
            })
        };
        let x = turn("look");
        assert_eq!(x["params"]["input"][0]["text"], "look");
        assert_eq!(x["params"]["input"][1]["path"], "/tmp/a shot.png");
        assert_eq!(x["params"]["input"][2]["path"], "/tmp/b.webp");

        // An image by itself is a valid composer message. Codex treats an
        // empty positional argument as no prompt and otherwise reads stdin,
        // which command-line chats intentionally close.
        let image_only = turn("");
        assert_eq!(
            image_only["params"]["input"][0]["text"],
            "Please inspect the attached image."
        );

        // The delimiter also preserves a user prompt that starts with a dash.
        let dash_prompt = turn("--describe");
        assert_eq!(dash_prompt["params"]["input"][0]["text"], "--describe");

        // Claude's images ride on stdin instead — see write_user_message.
        let c = build_command(
            ChatAgent::Claude,
            None,
            None,
            "look",
            None,
            &[],
            None,
            &shots,
            false,
        );
        assert!(!c.contains("-i "));
    }

    #[test]
    fn a_decision_made_while_a_chat_is_idle_holds_off_its_next_turn() {
        // Feedback e15fabde: a coordinator confirming a worker's proposed
        // report must not race a message that starts the worker's next turn,
        // which withdraws the words being confirmed.
        let manager = Arc::new(ChatManager::default());
        let key = format!("idle-{}", uuid::Uuid::new_v4().simple());
        let session = |busy: bool| {
            Arc::new(Mutex::new(ChatSession {
                launch_id: "test-launch".into(),
                user_turn_id: None,
                answering: None,
                child: stand_in::still()
                    .stdin(Stdio::null())
                    .spawn()
                    .expect("a stand-in agent"),
                stdin: None,
                codex: None,
                agent: ChatAgent::Codex,
                busy,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                leaving: None,
            }))
        };
        // No live process: nothing can be in a turn.
        assert_eq!(manager.while_idle(&key, || Ok(1)), Ok(1));

        let live = session(false);
        manager
            .sessions
            .lock()
            .unwrap()
            .insert(key.clone(), live.clone());
        let order = Arc::new(Mutex::new(Vec::new()));
        let decided = manager.while_idle(&key, || {
            // A turn starting now: a send takes the session lock to write
            // the message and set busy.
            let (live, sender) = (live.clone(), order.clone());
            let turn = std::thread::spawn(move || {
                let mut s = live.lock().unwrap();
                s.busy = true;
                sender.lock().unwrap().push("turn started");
            });
            std::thread::sleep(Duration::from_millis(150));
            order.lock().unwrap().push("decided");
            Ok(turn)
        });
        decided.unwrap().join().unwrap();
        assert_eq!(*order.lock().unwrap(), ["decided", "turn started"]);

        // Now it is in a turn: the decision is refused without being made.
        let mut ran = false;
        let refused = manager.while_idle(&key, || {
            ran = true;
            Ok(())
        });
        assert!(refused.unwrap_err().contains("in a turn"));
        assert!(!ran);
        end_process(&manager, &key).expect("end the stand-in");
    }

    #[test]
    fn a_running_chat_reports_the_pid_its_memory_hangs_off() {
        // `memory.rs` charges every process under this pid to this chat, which
        // is the only way an agent's own MCP servers land on the chat that
        // started them rather than on the server.
        let manager = Arc::new(ChatManager::default());
        let key = format!("mem-{}", uuid::Uuid::new_v4().simple());
        let child = stand_in::still()
            .stdin(Stdio::null())
            .spawn()
            .expect("a stand-in agent");
        let pid = child.id() as i32;
        manager.sessions.lock().unwrap().insert(
            key.clone(),
            Arc::new(Mutex::new(ChatSession {
                launch_id: "test-launch".into(),
                user_turn_id: None,
                answering: None,
                child,
                stdin: None,
                codex: None,
                agent: ChatAgent::Claude,
                busy: false,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                leaving: None,
            })),
        );

        assert_eq!(manager.chat_pids().get(&pid), Some(&key));
        end_process(&manager, &key).expect("end the stand-in");
        assert!(
            !manager.chat_pids().contains_key(&pid),
            "a chat that has been ended must stop claiming its pid — the OS is \
             free to hand that number to something else"
        );
    }

    #[test]
    fn a_queued_codex_user_turn_is_durable_before_its_next_process_starts() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("codex-durable-{}", uuid::Uuid::new_v4().simple());
        let child = stand_in::still()
            .stdin(Stdio::null())
            .spawn()
            .expect("a Codex stand-in");
        manager.sessions.lock().unwrap().insert(
            key.clone(),
            Arc::new(Mutex::new(ChatSession {
                launch_id: "test-launch".into(),
                user_turn_id: None,
                answering: None,
                child,
                stdin: None,
                codex: None,
                agent: ChatAgent::Codex,
                busy: true,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                leaving: None,
            })),
        );

        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            "persist this prompt".into(),
            Some(vec!["/tmp/prompt.png".into()]),
            None,
            Some("user-1".into()),
            None,
        )
        .expect("a queued Codex user turn");

        let events = crate::transcript::since(&key, 0);
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].event["state"], "queued");
        assert_eq!(events[0].event["uuid"], "user-1");
        assert_eq!(
            events[0].event["message"]["content"][0]["text"],
            "persist this prompt"
        );
        assert_eq!(
            events[0].event["octiq_attachments"][0]["path"],
            "/tmp/prompt.png"
        );
        assert_eq!(
            manager.take_queued_turn(&key).and_then(|turn| turn.turn_id),
            Some("user-1".into()),
            "the FIFO resume keeps the id of the bubble it will answer"
        );

        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    #[test]
    fn compatible_follow_ups_share_one_durable_queue_unit() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("coalesced-queue-{}", uuid::Uuid::new_v4().simple());
        manager.handoffs.lock().unwrap().insert(key.clone());

        for (text, image, turn_id) in [
            ("first detail", "/tmp/first.png", "user-1"),
            ("second detail", "/tmp/second.png", "user-2"),
            ("third detail", "/tmp/third.png", "user-3"),
        ] {
            chat_send_user_impl(
                manager.clone(),
                key.clone(),
                text.into(),
                Some(vec![image.into()]),
                None,
                Some(turn_id.into()),
                None,
            )
            .expect("a compatible queued follow-up");
        }

        assert_eq!(
            chat_queue_state_impl(&manager, &key)
                .unwrap()
                .queued_turn_ids,
            ["user-1", "user-2", "user-3"],
        );
        let next = manager.take_queued_turn(&key).expect("one combined turn");
        assert_eq!(next.text, "first detail\nsecond detail\nthird detail");
        assert_eq!(
            next.images,
            ["/tmp/first.png", "/tmp/second.png", "/tmp/third.png"]
        );
        assert!(manager.take_queued_turn(&key).is_none());
        assert_eq!(
            chat_queue_state_impl(&manager, &key)
                .unwrap()
                .queued_turn_ids,
            Vec::<String>::new(),
        );

        let events = crate::transcript::since(&key, 0);
        let appended: Vec<_> = events
            .iter()
            .filter(|event| event.event["type"] == "octiq_user_turn_appended")
            .collect();
        assert_eq!(appended.len(), 2);
        assert_eq!(appended[0].event["uuid"], "user-1");
        assert_eq!(appended[0].event["appended_uuid"], "user-2");
        assert_eq!(appended[1].event["appended_uuid"], "user-3");

        manager.handoffs.lock().unwrap().remove(&key);
        crate::transcript::forget(&key);
    }

    #[test]
    fn commands_internal_work_and_execution_changes_bound_combining() {
        let manager = ChatManager::default();
        let context = QueueContext::from(StartContext::for_test(ChatAgent::Codex, Some("thread")));
        let mut changed = context.clone();
        changed.access = Some(Access::Full);
        for (text, id, recorded, queued_context) in [
            ("first", Some("user-1"), true, Some(context.clone())),
            ("/review", Some("user-command"), true, Some(context.clone())),
            ("after command", Some("user-2"), true, Some(context.clone())),
            ("host notification", None, false, Some(context.clone())),
            ("after host", Some("user-3"), true, Some(context.clone())),
            ("new access", Some("user-4"), true, Some(changed)),
        ] {
            manager
                .queue_turn(
                    "bounded",
                    QueuedTurn {
                        text: text.into(),
                        images: vec![],
                        turn_id: id.map(str::to_string),
                        appended_turn_ids: vec![],
                        recorded,
                        context: queued_context,
                    },
                )
                .unwrap();
        }

        let queued: Vec<_> = std::iter::from_fn(|| manager.take_queued_turn("bounded"))
            .map(|turn| turn.text)
            .collect();
        assert_eq!(
            queued,
            [
                "first",
                "/review",
                "after command",
                "after host",
                "new access",
                "host notification",
            ]
        );
    }

    #[test]
    fn cancelling_by_an_appended_id_cancels_the_whole_combined_unit() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("cancel-combined-{}", uuid::Uuid::new_v4().simple());
        manager.handoffs.lock().unwrap().insert(key.clone());
        for (text, id) in [("first", "user-1"), ("second", "user-2")] {
            chat_send_user_impl(
                manager.clone(),
                key.clone(),
                text.into(),
                None,
                None,
                Some(id.into()),
                None,
            )
            .unwrap();
        }

        assert_eq!(
            chat_cancel_queued_impl(&manager, key.clone(), "user-2".into()),
            Ok(true)
        );
        assert!(!manager.has_queued_turns(&key));
        let cancelled: Vec<_> = crate::transcript::since(&key, 0)
            .into_iter()
            .filter(|event| event.event["type"] == "octiq_user_turn_cancelled")
            .map(|event| event.event["uuid"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(cancelled, ["user-1", "user-2"]);

        manager.handoffs.lock().unwrap().remove(&key);
        crate::transcript::forget(&key);
    }

    #[test]
    fn retrying_a_queued_turn_id_is_idempotent() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("queue-retry-{}", uuid::Uuid::new_v4().simple());
        manager.handoffs.lock().unwrap().insert(key.clone());

        for _ in 0..2 {
            chat_send_user_impl(
                manager.clone(),
                key.clone(),
                "same request".into(),
                Some(vec!["/tmp/once.png".into()]),
                None,
                Some("user-retry".into()),
                None,
            )
            .expect("an idempotent retry");
        }

        let next = manager.take_queued_turn(&key).expect("the original turn");
        assert_eq!(next.text, "same request");
        assert_eq!(next.images, ["/tmp/once.png"]);
        assert!(manager.take_queued_turn(&key).is_none());
        assert_eq!(crate::transcript::since(&key, 0).len(), 2);

        manager.handoffs.lock().unwrap().remove(&key);
        crate::transcript::forget(&key);
    }

    #[test]
    fn concurrent_tabs_retry_one_turn_id_exactly_once() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("queue-concurrent-retry-{}", uuid::Uuid::new_v4().simple());
        manager.handoffs.lock().unwrap().insert(key.clone());
        let ready = Arc::new(std::sync::Barrier::new(3));
        let sends: Vec<_> = (0..2)
            .map(|_| {
                let manager = manager.clone();
                let key = key.clone();
                let ready = ready.clone();
                std::thread::spawn(move || {
                    ready.wait();
                    chat_send_user_impl(
                        manager,
                        key,
                        "same concurrent request".into(),
                        None,
                        None,
                        Some("user-concurrent".into()),
                        None,
                    )
                })
            })
            .collect();
        ready.wait();
        for send in sends {
            send.join().unwrap().unwrap();
        }

        assert_eq!(
            manager.take_queued_turn(&key).map(|turn| turn.text),
            Some("same concurrent request".into())
        );
        assert!(manager.take_queued_turn(&key).is_none());
        assert_eq!(crate::transcript::since(&key, 0).len(), 2);

        manager.handoffs.lock().unwrap().remove(&key);
        crate::transcript::forget(&key);
    }

    /// A persistent-provider session with a REAL pipe on its stdin, so a write
    /// that should not have happened has somewhere to go rather than failing
    /// for the wrong reason and passing the test anyway.
    pub(super) fn claude_session(busy: bool) -> Arc<Mutex<ChatSession>> {
        let mut child = stand_in::echo()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("an echo to stand in for Claude");
        let stdin = child.stdin.take();
        Arc::new(Mutex::new(ChatSession {
            launch_id: "test-launch".into(),
            user_turn_id: None,
            answering: None,
            child,
            stdin,
            codex: None,
            agent: ChatAgent::Claude,
            busy,
            last_active: Instant::now(),
            cut_off: CutOff::No,
            leaving: None,
        }))
    }

    pub(super) fn capturing_claude_session() -> (
        Arc<Mutex<ChatSession>>,
        std::io::BufReader<std::process::ChildStdout>,
    ) {
        let mut child = stand_in::echo()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("an echo to capture Claude input");
        let stdin = child.stdin.take();
        let stdout = stand_in::echoed(child.stdout.take().expect("the capture pipe"));
        (
            Arc::new(Mutex::new(ChatSession {
                launch_id: "test-launch".into(),
                user_turn_id: None,
                answering: None,
                child,
                stdin,
                codex: None,
                agent: ChatAgent::Claude,
                busy: true,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                leaving: None,
            })),
            stdout,
        )
    }

    pub(super) fn hold(manager: &ChatManager, key: &str, session: Arc<Mutex<ChatSession>>) {
        manager
            .sessions
            .lock()
            .unwrap()
            .insert(key.to_string(), session);
    }

    #[test]
    fn a_message_sent_to_a_working_claude_waits_in_our_own_queue() {
        // Written to its stdin it would land in the AGENT's queue instead,
        // where nothing on this side can reach it again — which is the whole
        // reason a queued message used to be impossible to take back.
        let manager = Arc::new(ChatManager::default());
        let key = format!("claude-queue-{}", uuid::Uuid::new_v4().simple());
        hold(&manager, &key, claude_session(true));

        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            "and one more thing".into(),
            None,
            None,
            Some("user-1".into()),
            None,
        )
        .expect("a follow-up to a working Claude");

        assert_eq!(
            manager.take_queued_turn(&key),
            Some(QueuedTurn {
                text: "and one more thing".into(),
                images: vec![],
                turn_id: Some("user-1".into()),
                appended_turn_ids: vec![],
                recorded: true,
                context: None,
            })
        );
        let events = crate::transcript::since(&key, 0);
        assert_eq!(events[0].event["uuid"], "user-1");
        assert_eq!(events[1].event["state"], "queued");

        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    /// An outage card in `key`'s chat, launched from a scratch project, with
    /// its "Always allow in this project" rule already written.
    fn allowed_outage_card(key: &str) -> (String, crate::test_dir::TestDir) {
        let project = crate::test_dir::TestDir::new("outage-send");
        crate::safety_block::remember_claude_launch(
            key,
            true,
            project.to_str().unwrap(),
            false,
            None,
        );
        let denial = serde_json::json!({
            "type": "system", "subtype": "permission_denied",
            "decision_reason": "Classifier unavailable", "decision_reason_type": "classifier",
            "message": "The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. You may try the action again once, as-is.",
            "tool_name": "Bash", "tool_use_id": format!("toolu-{}", uuid::Uuid::new_v4().simple()),
        });
        assert!(crate::safety_block::observe_claude_denial(
            key,
            None,
            &denial,
            Some((
                "Bash",
                &serde_json::json!({ "command": "git push origin main" })
            ))
        ));
        let card = cards_in(key).pop().expect("the outage card");
        crate::safety_block::allow_outage(card.id(), crate::claude_allow::Scope::Project)
            .expect("the allow rule is written");
        (card.id().to_string(), project)
    }

    fn cards_in(key: &str) -> Vec<crate::safety_block::BlockedAction> {
        crate::safety_block::pending()
            .into_iter()
            .filter(|card| card.chat_key() == key)
            .collect()
    }

    fn is_pending(id: &str) -> bool {
        crate::safety_block::pending()
            .iter()
            .any(|card| card.id() == id)
    }

    /// A card that is not an outage card, beside the outage card in `key`.
    fn judged_card(key: &str) -> String {
        let before: Vec<String> = cards_in(key).iter().map(|c| c.id().to_string()).collect();
        let denial = serde_json::json!({
            "type": "system", "subtype": "permission_denied",
            "decision_reason": "Production Deploy", "decision_reason_type": "classifier",
            "message": "Blocked.", "tool_name": "Bash",
            "tool_use_id": format!("toolu-{}", uuid::Uuid::new_v4().simple()),
        });
        assert!(crate::safety_block::observe_claude_denial(
            key,
            None,
            &denial,
            Some(("Bash", &serde_json::json!({ "command": "./deploy.sh" })))
        ));
        cards_in(key)
            .into_iter()
            .map(|c| c.id().to_string())
            .find(|id| !before.contains(id))
            .expect("the judged card")
    }

    /// Review finding (2f71bc6): both person-send entry points superseded the
    /// chat's cards BEFORE the turn was accepted, so a start, write or queue
    /// that failed after the RPC reached the host still took the outage card
    /// down, recorded "superseded", and left the agent never asked to retry.
    /// The retry turn names its card now, and nothing moves until the turn
    /// is taken.
    #[test]
    fn an_outage_retry_the_chat_does_not_take_leaves_its_card_pending() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("chat:outage-fail-{}", uuid::Uuid::new_v4().simple());
        let (card, project) = allowed_outage_card(&key);
        let beside = judged_card(&key);

        // chat_send to a chat with no process.
        let sent = chat_send_answering_impl(
            manager.clone(),
            key.clone(),
            "Retry `git push origin main` once, as-is.".into(),
            None,
            None,
            Some("user-retry-1".into()),
            None,
            Some(card.clone()),
        );
        assert_eq!(sent, Err("no such chat".into()));
        assert!(is_pending(&card), "the card stays up");
        assert_eq!(crate::safety_block::decision(&card), None);
        assert!(is_pending(&beside), "nothing else is superseded either");
        let written = cards_in(&key)
            .into_iter()
            .find(|c| c.id() == card)
            .map(|c| serde_json::to_value(c).unwrap()["written"].clone());
        assert_eq!(written, Some(serde_json::json!("project")));

        // chat_start that cannot start: the key already has a process.
        hold(&manager, &key, claude_session(false));
        let started = chat_start_answering_impl(
            manager.clone(),
            key.clone(),
            project.to_string_lossy().into_owned(),
            ChatAgent::Claude,
            None,
            None,
            Some("Retry `git push origin main` once, as-is.".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some("user-retry-2".into()),
            Some(card.clone()),
        );
        assert!(started.unwrap_err().contains("already running"));
        assert!(is_pending(&card), "the card stays up");
        assert_eq!(crate::safety_block::decision(&card), None);
        assert!(is_pending(&beside));

        // chat_send that the host refuses after the RPC arrived.
        let refused = chat_send_answering_impl(
            manager.clone(),
            key.clone(),
            "Retry `git push origin main` once, as-is.".into(),
            None,
            Some("someone-else".into()),
            Some("user-retry-3".into()),
            None,
            Some(card.clone()),
        );
        assert!(refused.is_err());
        assert!(is_pending(&card));
        assert_eq!(crate::safety_block::decision(&card), None);

        // Ordinary words are unchanged: they supersede every card at once,
        // taken or not — an outage card included. Its rule is already in the
        // settings file, though, so it is recorded as that allow, never as
        // superseded (review, 2026-10-01).
        let ordinary = chat_send_user_impl(
            manager.clone(),
            key.clone(),
            "never mind, do something else".into(),
            None,
            Some("someone-else".into()),
            Some("user-4".into()),
            None,
        );
        assert!(ordinary.is_err());
        assert!(!is_pending(&card) && !is_pending(&beside));
        assert_eq!(
            crate::safety_block::decision(&card),
            Some("allowed_project")
        );
        assert_eq!(crate::safety_block::decision(&beside), Some("superseded"));

        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    #[test]
    fn an_outage_retry_the_chat_takes_is_recorded_as_its_own_decision() {
        // An "Always allow in this project" whose retry is written straight to
        // an idle Claude: recorded as that allow, not "superseded". The judged
        // card beside it was up before the turn, so the turn supersedes it.
        let manager = Arc::new(ChatManager::default());
        let key = format!("chat:outage-ok-{}", uuid::Uuid::new_v4().simple());
        let (card, project) = allowed_outage_card(&key);
        let beside = judged_card(&key);
        hold(&manager, &key, claude_session(false));
        chat_send_answering_impl(
            manager.clone(),
            key.clone(),
            "Retry `git push origin main` once, as-is.".into(),
            None,
            None,
            Some("user-retry-1".into()),
            None,
            Some(card.clone()),
        )
        .expect("the retry turn is taken");
        assert!(!is_pending(&card));
        assert_eq!(
            crate::safety_block::decision(&card),
            Some("allowed_project")
        );
        assert_eq!(crate::safety_block::decision(&beside), Some("superseded"));
        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
        std::fs::remove_dir_all(project).unwrap();

        // "Retry once" into a working Claude: queued is taken, and it is
        // recorded as retried. A worker's card is answered through the main
        // chat, so the card may belong to another chat than the send.
        let main = format!("chat:outage-main-{}", uuid::Uuid::new_v4().simple());
        let worker = format!("chat:outage-worker-{}", uuid::Uuid::new_v4().simple());
        crate::safety_block::remember_claude_launch(&worker, true, "/tmp", false, None);
        let denial = serde_json::json!({
            "type": "system", "subtype": "permission_denied",
            "decision_reason": "Classifier unavailable", "decision_reason_type": "classifier",
            "message": "gave no verdict", "tool_name": "Bash", "tool_use_id": "toolu-w",
        });
        assert!(crate::safety_block::observe_claude_denial(
            &worker,
            None,
            &denial,
            Some(("Bash", &serde_json::json!({ "command": "ls | wc -l" })))
        ));
        let retried = cards_in(&worker).pop().unwrap().id().to_string();
        hold(&manager, &main, claude_session(true));
        chat_send_answering_impl(
            manager.clone(),
            main.clone(),
            "For your worker chat: retry `ls | wc -l` once.".into(),
            None,
            None,
            Some("user-retry-2".into()),
            None,
            Some(retried.clone()),
        )
        .expect("queued behind the running turn");
        assert!(!is_pending(&retried));
        assert_eq!(crate::safety_block::decision(&retried), Some("retried"));
        end_process(&manager, &main).expect("end the stand-in");
        crate::transcript::forget(&main);
    }

    #[test]
    fn a_turn_boundary_automatically_dispatches_the_combined_prompt() {
        use std::io::BufRead;

        let manager = Arc::new(ChatManager::default());
        let key = format!("claude-auto-drain-{}", uuid::Uuid::new_v4().simple());
        let (session, mut stdout) = capturing_claude_session();
        hold(&manager, &key, session.clone());
        for (text, id) in [("first detail", "user-1"), ("second detail", "user-2")] {
            chat_send_user_impl(
                manager.clone(),
                key.clone(),
                text.into(),
                None,
                None,
                Some(id.into()),
                None,
            )
            .unwrap();
        }

        {
            let mut running = session.lock().unwrap();
            running.turn_ended();
            assert_eq!(
                dispatch_next_persistent_turn(&manager, &key, &key, &mut running),
                None,
            );
            assert!(running.busy, "automatic drain starts the combined turn");
            assert_eq!(running.user_turn_id.as_deref(), Some("user-1"));
        }
        assert!(!manager.has_queued_turns(&key));

        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let payload: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            payload["message"]["content"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["text"],
            "first detail\nsecond detail"
        );

        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    #[test]
    fn an_idle_claude_is_written_to_rather_than_queued() {
        // The other half of the pair. Holding a message back is a rule about a
        // turn IN FLIGHT, not a new layer between the person and the agent.
        let manager = Arc::new(ChatManager::default());
        let key = format!("claude-idle-{}", uuid::Uuid::new_v4().simple());
        hold(&manager, &key, claude_session(false));

        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            "go".into(),
            None,
            None,
            Some("user-1".into()),
            None,
        )
        .expect("a message to an idle Claude");

        assert!(manager.take_queued_turn(&key).is_none());
        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    #[test]
    fn stopping_the_turn_keeps_what_was_stacked_behind_it() {
        // Stop is "not that — do the thing I have already typed instead", and
        // has been for as long as there has been a Stop button: the message
        // used to go into Claude's OWN queue, which an interrupt made it pick
        // up at once. The queue is ours now, so keeping it here is what keeps
        // that. Nothing in the interrupt writes it — the reader hands it over
        // on the cut-off turn's `result` — so what this checks is that it is
        // still there to be handed over.
        let manager = Arc::new(ChatManager::default());
        let key = format!("claude-stop-{}", uuid::Uuid::new_v4().simple());
        hold(&manager, &key, claude_session(true));

        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            "and then this".into(),
            None,
            None,
            Some("user-1".into()),
            None,
        )
        .expect("a follow-up to a working Claude");

        chat_interrupt_impl(&manager, key.clone()).expect("stop the turn");

        assert_eq!(
            manager.take_queued_turn(&key).map(|turn| turn.text),
            Some("and then this".into()),
            "the message behind a stopped turn is still waiting to be sent",
        );
        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    #[test]
    fn starting_an_appended_message_interrupts_for_the_whole_combined_unit() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("claude-start-queued-{}", uuid::Uuid::new_v4().simple());
        let session = claude_session(true);
        hold(&manager, &key, session.clone());

        for (text, turn_id) in [("first", "user-1"), ("send this now", "user-2")] {
            chat_send_user_impl(
                manager.clone(),
                key.clone(),
                text.into(),
                None,
                None,
                Some(turn_id.into()),
                None,
            )
            .expect("a queued follow-up");
        }

        assert_eq!(
            chat_start_queued_impl(&manager, key.clone(), "user-2".into()),
            Ok(true)
        );
        assert!(
            !session.lock().unwrap().busy,
            "the current turn was interrupted so the promoted one can start"
        );
        let order: Vec<String> = std::iter::from_fn(|| manager.take_queued_turn(&key))
            .map(|turn| turn.text)
            .collect();
        assert_eq!(order, ["first\nsend this now"]);

        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    /// Feedback 531f1dac: a coordinator's pause reached a worker 15–20
    /// minutes late, after the render it was meant to stop. Interrupting cuts
    /// the turn short, and no host notification goes in until the cut-off
    /// turn's own full stop has come back.
    #[test]
    fn a_coordinator_interrupt_cuts_a_busy_worker_turn_and_holds_notifications_until_its_full_stop()
    {
        let manager = Arc::new(ChatManager::default());
        let key = format!("worker-interrupt-{}", uuid::Uuid::new_v4().simple());
        assert_eq!(
            interrupt_worker_turn(&manager, &key),
            Ok(WorkerInterrupt::Idle),
            "no process: the message waits for the next launch"
        );
        let session = claude_session(true);
        hold(&manager, &key, session.clone());
        assert!(!manager.notification_ready(&key), "a turn is in flight");

        assert_eq!(
            interrupt_worker_turn(&manager, &key),
            Ok(WorkerInterrupt::Interrupted)
        );
        assert!(!session.lock().unwrap().busy);
        assert!(
            !manager.notification_ready(&key),
            "the cut-off turn has not sent its full stop yet"
        );
        // The reader clears it on that full stop.
        end_turn_locked(&manager, &key, &key, &mut session.lock().unwrap(), false);
        assert!(manager.notification_ready(&key));
        assert_eq!(
            interrupt_worker_turn(&manager, &key),
            Ok(WorkerInterrupt::Idle),
            "an idle worker is not interrupted again"
        );
        assert!(manager.notification_ready(&key));

        // A full stop that never comes holds delivery for the grace, and no
        // clock lets a notification into a process that has not stopped:
        // the grace ends the process, and the notification then meets a chat
        // with none, as after any exit.
        session.lock().unwrap().busy = true;
        assert_eq!(
            interrupt_worker_turn(&manager, &key),
            Ok(WorkerInterrupt::Interrupted)
        );
        let CutOff::Owed(unwind) = session.lock().unwrap().cut_off else {
            panic!("the Stop is being waited out");
        };
        assert!(!manager.notification_ready(&key));
        assert!(grace_ran_out(&manager, &key, &key, &session, unwind));
        assert!(!manager.has_process(&key));
        assert!(
            session.lock().unwrap().stdin.is_none(),
            "nothing more goes in"
        );
        assert!(manager.notification_ready(&key));

        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    /// Feedback 240ea516: the interrupt came back "interrupted" and seconds
    /// later the host failed the attempt on the cut-off turn's own full stop,
    /// which Claude spells as a failed `result`. The attempt stays active and
    /// the coordinator's message opens the worker's next turn. The stream is
    /// a real one, interrupted while a Bash call ran.
    #[test]
    fn a_coordinator_interrupt_keeps_a_claude_workers_attempt_and_its_message_opens_the_next_turn()
    {
        use crate::orchestration::tests::{claude_interrupted_tool, run, running_worker_on};
        use crate::orchestration::AttemptStatus;
        use std::io::BufRead;

        let manager = Arc::new(ChatManager::default());
        let store = manager.orchestrations.clone();
        let run = run(&store);
        let worker = running_worker_on(&store, &run, ChatAgent::Claude);
        let key = worker.worker_chat_key.clone();
        let (session, mut stdout) = capturing_claude_session();
        hold(&manager, &key, session.clone());
        let attempt = || {
            store
                .snapshot(None)
                .unwrap()
                .attempts
                .into_iter()
                .find(|a| a.id == worker.id)
                .unwrap()
        };
        let events = claude_interrupted_tool();
        let called = events
            .iter()
            .position(|e| {
                e["type"] == "assistant" && e["message"]["content"][0]["type"] == "tool_use"
            })
            .expect("the Bash call");
        let cut = events
            .iter()
            .position(|e| e["type"] == "result")
            .expect("the cut-off turn's full stop");
        for event in &events[..=called] {
            manager
                .observe_for_orchestration(&session, &key, event)
                .unwrap();
        }
        assert_eq!(attempt().execution.pending_tools.len(), 1, "mid tool call");

        let message = store
            .record_message(
                &run.coordinator_chat_key,
                run.id.clone(),
                worker.id.clone(),
                "instruction".into(),
                "Pause".into(),
                "Stop the render.".into(),
            )
            .unwrap();
        assert_eq!(
            interrupt_worker_turn(&manager, &key),
            Ok(WorkerInterrupt::Interrupted)
        );
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let sent: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(sent["request"]["subtype"], "interrupt");

        // What Claude then says: the cancelled call, and a failed `result`.
        for event in &events[called + 1..=cut] {
            manager
                .observe_for_orchestration(&session, &key, event)
                .unwrap();
        }
        let after = attempt();
        assert_eq!(after.status, AttemptStatus::Running, "not failed");
        assert!(after.execution.latest_error.is_none());
        assert!(after.execution.pending_tools.is_empty());
        assert!(store.message_waiting(&message.id), "not cancelled");
        let note = store
            .due_notifications(i64::MAX)
            .unwrap()
            .into_iter()
            .find(|n| n.target_chat_key == key)
            .expect("the message is still owed to the worker");
        assert_eq!(
            deliver_orchestration_notification(manager.clone(), &note, Default::default()),
            Ok(false),
            "not before the reader has seen the full stop"
        );

        // The reader clears the mark on that full stop; the message goes in.
        end_turn_locked(&manager, &key, &key, &mut session.lock().unwrap(), false);
        assert_eq!(
            deliver_orchestration_notification(manager.clone(), &note, Default::default()),
            Ok(true)
        );
        assert!(session.lock().unwrap().busy, "the next turn has started");
        line.clear();
        stdout.read_line(&mut line).unwrap();
        assert!(line.contains("Stop the render."), "{line}");

        // That turn runs to its ordinary full stop on the same attempt, and a
        // failure in it is no longer excused by the interrupt before it.
        for event in &events[cut + 1..] {
            manager
                .observe_for_orchestration(&session, &key, event)
                .unwrap();
        }
        assert_eq!(attempt().status, AttemptStatus::Running);
        manager
            .observe_for_orchestration(&session, &key, &events[cut])
            .unwrap();
        assert_eq!(
            attempt().status,
            AttemptStatus::Running,
            "an abort the result names itself is still a cut"
        );
        let mut broke = events[cut].clone();
        broke.as_object_mut().unwrap().remove("terminal_reason");
        manager
            .observe_for_orchestration(&session, &key, &broke)
            .unwrap();
        assert_eq!(attempt().status, AttemptStatus::Failed);

        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    /// Stopping a provider that takes no control message would end its
    /// process, which fails the attempt; that is the coordinator's run_stop,
    /// not a message.
    #[test]
    fn a_worker_that_cannot_be_interrupted_keeps_its_process() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("worker-no-interrupt-{}", uuid::Uuid::new_v4().simple());
        let session = claude_session(true);
        session.lock().unwrap().agent = ChatAgent::Antigravity;
        hold(&manager, &key, session.clone());

        assert_eq!(
            interrupt_worker_turn(&manager, &key),
            Ok(WorkerInterrupt::Unsupported)
        );
        assert!(session.lock().unwrap().busy);
        assert!(manager.sessions.lock().unwrap().contains_key(&key));

        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    #[test]
    fn starting_a_message_the_agent_already_took_is_an_honest_noop() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("claude-start-gone-{}", uuid::Uuid::new_v4().simple());
        let session = claude_session(true);
        hold(&manager, &key, session.clone());

        assert_eq!(
            chat_start_queued_impl(&manager, key.clone(), "already-gone".into()),
            Ok(false)
        );
        assert!(
            session.lock().unwrap().busy,
            "a stale click must not interrupt the turn now in flight"
        );

        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    #[test]
    fn the_person_turn_is_the_whole_message_in_flight_and_only_theirs() {
        use crate::orchestration::SeenPlan;
        let manager = Arc::new(ChatManager::default());
        let key = format!("claude-person-turn-{}", uuid::Uuid::new_v4().simple());
        let session = claude_session(true);
        hold(&manager, &key, session.clone());
        let seen = |revision| {
            vec![SeenPlan {
                run_id: "run_a".into(),
                revision,
            }]
        };

        // Two messages queued behind a running turn become one unit, and so
        // does what the host knows of them: "approve" is not read alone.
        for (text, turn, revision) in [
            ("approve this plan", "user-1", 3),
            ("but change the branch", "user-2", 4),
        ] {
            manager.note_person_turn(&key, turn, text, seen(revision));
            chat_send_user_impl(
                manager.clone(),
                key.clone(),
                text.into(),
                None,
                None,
                Some(turn.into()),
                None,
            )
            .expect("queued behind the running turn");
        }
        // Nothing the person sent is being answered yet.
        assert_eq!(manager.person_turn(&key), None);
        {
            let mut running = session.lock().unwrap();
            running.turn_ended();
            assert_eq!(
                dispatch_next_persistent_turn(&manager, &key, &key, &mut running),
                None
            );
        }
        let turn = manager.person_turn(&key).expect("the person's own message");
        assert_eq!(turn.turn_id, "user-1");
        assert_eq!(turn.text, "approve this plan\nbut change the branch");
        // Each part keeps what it saw; the later look is not merged into the
        // earlier words.
        assert_eq!(turn.parts_seen, vec![seen(3), seen(4)]);
        // A retried send keeps the words first recorded.
        manager.note_person_turn(&key, "user-1", "approve", Vec::new());
        assert_eq!(
            manager.person_turn(&key).unwrap().text,
            "approve this plan\nbut change the branch"
        );

        // Another chat's evidence is not this chat's.
        assert_eq!(manager.person_turn("chat:elsewhere"), None);

        // A host notification is the next turn: nobody typed it.
        {
            let mut running = session.lock().unwrap();
            running.turn_ended();
            write_user_message_locked(&mut running, "notification", &[], Some("notif_1")).unwrap();
        }
        assert_eq!(manager.person_turn(&key), None);

        // A host continuation carries no id at all.
        manager.note_person_turn(&key, "user-3", "approve", seen(4));
        {
            let mut running = session.lock().unwrap();
            running.turn_ended();
            write_user_message_locked(&mut running, "approve", &[], Some("user-3")).unwrap();
        }
        assert!(manager.person_turn(&key).is_some());
        {
            let mut running = session.lock().unwrap();
            running.turn_ended();
            // Between turns the chat is answering nothing.
            assert!(!running.busy);
        }
        assert_eq!(manager.person_turn(&key), None);
        {
            let mut running = session.lock().unwrap();
            write_user_message_locked(&mut running, "gate answered", &[], None).unwrap();
        }
        assert_eq!(manager.person_turn(&key), None);

        // Only the host's person turn ids are ever recorded.
        manager.note_person_turn(&key, "notif_2", "approve", seen(4));
        {
            let mut running = session.lock().unwrap();
            running.turn_ended();
            write_user_message_locked(&mut running, "approve", &[], Some("notif_2")).unwrap();
        }
        assert_eq!(manager.person_turn(&key), None);

        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    #[test]
    fn a_send_in_the_gap_after_a_stop_does_not_jump_the_queue() {
        // The interrupt ends the turn immediately, so until the agent's own
        // `result` lands the session reads idle with a message still stacked
        // behind it. An ordinary send arriving in that window must go BEHIND
        // it, not straight down the stdin it is waiting for.
        let manager = Arc::new(ChatManager::default());
        let key = format!("claude-gap-{}", uuid::Uuid::new_v4().simple());
        let session = claude_session(true);
        hold(&manager, &key, session.clone());

        for (text, turn) in [("first", "user-1"), ("second", "user-2")] {
            chat_send_user_impl(
                manager.clone(),
                key.clone(),
                text.into(),
                None,
                None,
                Some(turn.into()),
                None,
            )
            .expect("a follow-up to a working Claude");
        }
        chat_interrupt_impl(&manager, key.clone()).expect("stop the turn");
        assert!(
            !session.lock().unwrap().busy,
            "the stop ended the turn, which is the gap this is about",
        );

        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            "third".into(),
            None,
            None,
            Some("user-3".into()),
            None,
        )
        .expect("a message sent into the gap");

        let order: Vec<String> = std::iter::from_fn(|| manager.take_queued_turn(&key))
            .map(|turn| turn.text)
            .collect();
        assert_eq!(
            order,
            ["first\nsecond\nthird"],
            "compatible sends share the next automatic turn"
        );
        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    #[test]
    fn stopping_codex_keeps_its_queue_on_the_native_thread() {
        let manager = Arc::new(ChatManager::default());
        let key = "codex-stop-queue";
        let mut child = stand_in::echo()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("a Codex app-server stand-in");
        let stdin = child.stdin.take();
        let session = Arc::new(Mutex::new(ChatSession {
            launch_id: "test-launch".into(),
            user_turn_id: None,
            answering: None,
            child,
            stdin,
            codex: Some(CodexAppSession {
                thread_id: "thread-1".into(),
                active_turn_id: Some("turn-1".into()),
                interrupt_when_started: false,
                next_request: 0,
                model: None,
                effort: None,
                access: Some(Access::Read),
                cwd: "/tmp".into(),
                workspace_roots: vec!["/tmp".into()],
                has_octiq_mcp: false,
            }),
            agent: ChatAgent::Codex,
            busy: true,
            last_active: Instant::now(),
            cut_off: CutOff::No,
            leaving: None,
        }));
        manager
            .sessions
            .lock()
            .unwrap()
            .insert(key.into(), session.clone());
        manager
            .queue_turn(
                key,
                QueuedTurn {
                    text: "instead, do this".into(),
                    images: Vec::new(),
                    turn_id: Some("user-1".into()),
                    appended_turn_ids: vec![],
                    recorded: true,
                    context: None,
                },
            )
            .expect("a message behind the running turn");

        chat_interrupt_impl(&manager, key.into()).expect("native Codex can be interrupted");
        assert!(chat_list_impl(&manager).unwrap().contains(&key.to_string()));
        assert!(
            manager.has_queued_turns(key),
            "the queued turn waits for Codex's turn/completed notification",
        );
        end_process(&manager, key).unwrap();
        let _ = session.lock().unwrap().child.wait();
    }

    #[test]
    fn a_cancelled_claude_turn_is_gone_and_cancelling_again_says_so() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("claude-cancel-{}", uuid::Uuid::new_v4().simple());
        hold(&manager, &key, claude_session(true));

        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            "forget it".into(),
            None,
            None,
            Some("user-1".into()),
            None,
        )
        .expect("a follow-up to a working Claude");

        assert_eq!(
            chat_cancel_queued_impl(&manager, key.clone(), "user-1".into()),
            Ok(true)
        );
        assert!(manager.take_queued_turn(&key).is_none());
        let events = crate::transcript::since(&key, 0);
        assert_eq!(events.len(), 3);
        assert_eq!(events[2].event["type"], "octiq_user_turn_cancelled");
        // The queue is FIFO and the agent may already have been handed it. That
        // is a race nobody can win, and the page has to be told rather than
        // shown a bubble vanishing from under an answer to it.
        assert_eq!(
            chat_cancel_queued_impl(&manager, key.clone(), "user-1".into()),
            Ok(false)
        );

        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    #[test]
    fn cancelling_a_codex_turn_takes_it_back_out_of_the_transcript() {
        // Codex's queued prompt IS written down at send — it is accepted the
        // moment it enters the queue. So this is the one that has something to
        // undo, and the record is append-only: "out" is one more line saying so.
        let manager = Arc::new(ChatManager::default());
        let key = format!("codex-cancel-{}", uuid::Uuid::new_v4().simple());
        let child = stand_in::still()
            .stdin(Stdio::null())
            .spawn()
            .expect("a Codex stand-in");
        hold(
            &manager,
            &key,
            Arc::new(Mutex::new(ChatSession {
                launch_id: "test-launch".into(),
                user_turn_id: None,
                answering: None,
                child,
                stdin: None,
                codex: None,
                agent: ChatAgent::Codex,
                busy: true,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                leaving: None,
            })),
        );

        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            "never mind".into(),
            None,
            None,
            Some("user-1".into()),
            None,
        )
        .expect("a queued Codex user turn");
        assert_eq!(crate::transcript::since(&key, 0).len(), 2);

        assert_eq!(
            chat_cancel_queued_impl(&manager, key.clone(), "user-1".into()),
            Ok(true)
        );
        assert!(manager.take_queued_turn(&key).is_none());
        let events = crate::transcript::since(&key, 0);
        assert_eq!(events.len(), 3);
        assert_eq!(events[2].event["type"], "octiq_user_turn_cancelled");
        assert_eq!(events[1].event["uuid"], "user-1");

        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    #[test]
    fn dismissing_a_lost_turn_is_durable_but_never_removes_a_live_queue() {
        let manager = ChatManager::default();
        let key = format!("dismiss-unsent-{}", uuid::Uuid::new_v4().simple());

        assert_eq!(
            chat_dismiss_unsent_impl(&manager, key.clone(), "lost-1".into()),
            Ok(true)
        );
        let events = crate::transcript::since(&key, 0);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event["type"], "octiq_user_turn_dismissed");
        assert_eq!(events[0].event["uuid"], "lost-1");

        manager
            .queue_turn(
                &key,
                QueuedTurn {
                    text: "still waiting".into(),
                    images: Vec::new(),
                    turn_id: Some("queued-1".into()),
                    appended_turn_ids: vec![],
                    recorded: true,
                    context: None,
                },
            )
            .expect("a live queued turn");
        assert_eq!(
            chat_dismiss_unsent_impl(&manager, key.clone(), "queued-1".into()),
            Ok(false)
        );
        assert_eq!(crate::transcript::since(&key, 0).len(), 1);
        assert_eq!(
            manager.take_queued_turn(&key).and_then(|turn| turn.turn_id),
            Some("queued-1".into())
        );

        crate::transcript::forget(&key);
    }

    #[test]
    fn interrupting_codex_keeps_its_app_server_and_native_thread() {
        let manager = Arc::new(ChatManager::default());
        let key = "codex-interrupt";
        let thread = "01a0142d-552d-7a93-9152-47530c33e501";
        manager.remember_start(
            key,
            StartContext {
                cwd: "/tmp".into(),
                agent: ChatAgent::Codex,
                model: None,
                access: Some(Access::Read),
                extra_dirs: None,
                env: None,
                effort: None,
                lite: Some(false),
                session_id: Some(thread.into()),
            },
        );
        let mut child = stand_in::echo()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("a Codex app-server stand-in");
        let stdin = child.stdin.take();
        let session = Arc::new(Mutex::new(ChatSession {
            launch_id: "test-launch".into(),
            user_turn_id: None,
            answering: None,
            child,
            stdin,
            codex: Some(CodexAppSession {
                thread_id: thread.into(),
                active_turn_id: Some("turn-1".into()),
                interrupt_when_started: false,
                next_request: 0,
                model: None,
                effort: None,
                access: Some(Access::Read),
                cwd: "/tmp".into(),
                workspace_roots: vec!["/tmp".into()],
                has_octiq_mcp: false,
            }),
            agent: ChatAgent::Codex,
            busy: true,
            last_active: Instant::now(),
            cut_off: CutOff::No,
            leaving: None,
        }));
        manager
            .sessions
            .lock()
            .unwrap()
            .insert(key.into(), session.clone());

        chat_interrupt_impl(&manager, key.into()).expect("Codex can be stopped");

        assert_eq!(chat_list_impl(&manager).unwrap(), [key]);
        assert_eq!(
            manager
                .start_context(key)
                .and_then(|start| start.session_id),
            Some(thread.into()),
            "the next message resumes the interrupted Codex conversation"
        );
        assert!(session.lock().unwrap().child.try_wait().unwrap().is_none());
        end_process(&manager, key).unwrap();
        let _ = session.lock().unwrap().child.wait();
    }

    #[test]
    fn only_real_image_extensions_are_offered_to_the_model() {
        assert_eq!(image_media_type("/tmp/a.PNG"), Some("image/png"));
        assert_eq!(image_media_type("/tmp/a.jpeg"), Some("image/jpeg"));
        assert_eq!(image_media_type("/tmp/a.webp"), Some("image/webp"));
        // Not an image: passing it on would be an API error, so it is dropped.
        assert_eq!(image_media_type("/tmp/notes.md"), None);
        assert_eq!(image_media_type("/tmp/noextension"), None);
    }

    #[test]
    fn a_projects_other_folders_are_added_for_both_agents() {
        let dirs = vec!["/Users/me/api".to_string(), "/Users/me/my docs".to_string()];
        let c = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &dirs,
            None,
            &[],
            false,
        );
        assert!(c.contains("--add-dir '/Users/me/api'"));
        // A space in a folder name stays one argument.
        assert!(c.contains("--add-dir '/Users/me/my docs'"));

        // Codex app-server receives the same folders as typed workspace roots.
        let mut roots = vec!["/Users/me/project".into()];
        roots.extend(dirs.clone());
        let request =
            crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
                cwd: "/Users/me/project",
                model: None,
                effort: None,
                access: None,
                resume: None,
                workspace_roots: &roots,
                developer_instructions: "host",
            });
        assert_eq!(request["params"]["runtimeWorkspaceRoots"], json!(roots));
    }
}

#[cfg(test)]
mod access_tests {
    use super::*;

    #[test]
    fn a_refusal_of_our_own_mode_change_is_picked_out_of_the_stream() {
        let refused = json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": "octiq-access-1",
                "error": "Cannot set permission mode to bypassPermissions \
                          because the session was not launched with \
                          --dangerously-skip-permissions"
            }
        });
        assert!(provider_for(ChatAgent::Claude)
            .observe_event(&refused)
            .access_refusal
            .expect("a refusal")
            .contains("bypassPermissions"));
    }

    #[test]
    fn nothing_else_on_the_wire_is_mistaken_for_one() {
        // Our own success, somebody else's control request, and an ordinary
        // message. None of these means the picker is lying about the level.
        let ours_worked = json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "octiq-access-1" }
        });
        let someone_elses = json!({
            "type": "control_response",
            "response": { "subtype": "error", "request_id": "int-1", "error": "no" }
        });
        let a_message = json!({ "type": "assistant", "message": { "content": [] } });
        let provider = provider_for(ChatAgent::Claude);
        assert!(provider
            .observe_event(&ours_worked)
            .access_refusal
            .is_none());
        assert!(provider
            .observe_event(&someone_elses)
            .access_refusal
            .is_none());
        assert!(provider.observe_event(&a_message).access_refusal.is_none());
    }

    #[test]
    fn each_level_names_a_mode_claude_will_actually_take() {
        // Verified against the CLI's own control channel: `plan` and `auto` are
        // accepted mid-session, `bypassPermissions` only when the process was
        // launched for it — which is why a switch UP to Full still restarts.
        let command = |access| {
            build_command(
                ChatAgent::Claude,
                None,
                Some(access),
                "",
                None,
                &[],
                None,
                &[],
                false,
            )
        };
        assert!(command(Access::Read).contains("--permission-mode plan"));
        assert!(command(Access::Auto).contains("--permission-mode auto"));
        let full = command(Access::Full);
        assert!(full.contains("--dangerously-skip-permissions"));
        assert!(!full.contains("--permission-mode bypassPermissions"));
    }
}

/// A start's claim on a chat keeps every other start out (`claim_start`).
#[cfg(test)]
mod start_claim_tests {
    use super::*;

    fn start(manager: Arc<ChatManager>, key: &str) -> Result<(), String> {
        start_session(
            manager,
            Voice::host(key.to_string()),
            "/tmp/project".into(),
            ChatAgent::Claude,
            None,
            None,
            Some("carry on".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            Some("turn-1".into()),
            true,
            None,
        )
    }

    #[test]
    fn a_claimed_chat_is_started_by_nobody_else() {
        let manager = Arc::new(ChatManager::default());
        let key = "chat:claimed";
        let claim = manager.claim_start(key).expect("nothing runs there");
        assert!(!manager.claimed_elsewhere(key), "the claimant's own start");

        let other = manager.clone();
        let (refused, second) = thread::spawn(move || {
            (
                start(other.clone(), key),
                other.claim_start(key).map(|_| ()),
            )
        })
        .join()
        .unwrap();
        // In the words a page already falls back to sending on.
        assert_eq!(refused, Err(format!("chat '{key}' is already running")));
        assert_eq!(second, Err(format!("chat '{key}' is already running")));
        assert!(!manager.has_process(key), "nothing was started");

        drop(claim);
        let other = manager.clone();
        let free = thread::spawn(move || !other.claimed_elsewhere(key))
            .join()
            .unwrap();
        assert!(free, "the claim goes with its guard");
    }

    #[test]
    fn a_chat_with_a_process_cannot_be_claimed() {
        let manager = ChatManager::default();
        let key = "chat:claim-live";
        manager.test_launch(key);
        assert_eq!(
            manager.claim_start(key).map(|_| ()),
            Err(format!("chat '{key}' is already running"))
        );
        manager.test_end(key);
        assert!(manager.claim_start(key).is_ok());

        // A one-shot process being replaced is as good as running.
        manager.handoffs.lock().unwrap().insert(key.to_string());
        assert!(manager.claim_start(key).is_err());
    }
}

/// The sweeper that gives an unused chat's memory back.
#[cfg(test)]
mod idle_tests {
    use super::*;

    /// A session with a real process behind it, last active `ago` back.
    ///
    /// A real child rather than a fake one, because ending it is half of what
    /// is being tested: `end_process` kills a `Child`, and a stand-in with no
    /// process would let a sweeper that ends nothing pass.
    fn still_session(busy: bool, ago: Duration) -> Arc<Mutex<ChatSession>> {
        let child = stand_in::still()
            .stdin(Stdio::piped())
            .spawn()
            .expect("a sleep to stand in for an agent");
        Arc::new(Mutex::new(ChatSession {
            launch_id: "test-launch".into(),
            user_turn_id: None,
            answering: None,
            child,
            stdin: None,
            codex: None,
            agent: ChatAgent::Claude,
            busy,
            last_active: Instant::now()
                .checked_sub(ago)
                .expect("a clock with some run-up behind it"),
            cut_off: CutOff::No,
            leaving: None,
        }))
    }

    fn put(manager: &ChatManager, key: &str, session: Arc<Mutex<ChatSession>>) {
        manager
            .sessions
            .lock()
            .unwrap()
            .insert(key.to_string(), session);
    }

    const FIFTEEN: Duration = Duration::from_secs(15 * 60);

    #[test]
    fn native_background_work_keeps_an_idle_parent_alive_and_explicit_end_reports_ids() {
        let manager = ChatManager::default();
        let key = format!("chat:test-background-{}", uuid::Uuid::new_v4());
        put(
            &manager,
            &key,
            still_session(false, Duration::from_secs(20 * 60)),
        );
        manager.background.observe(&key, "test-launch", &json!({
            "type": "system", "subtype": "task_started", "task_id": "native-agent-42", "task_type": "local_agent"
        })).unwrap();
        assert!(sweep_still_chats(&manager, FIFTEEN).is_empty());
        assert!(manager.sessions.lock().unwrap().contains_key(&key));
        end_process(&manager, &key).unwrap();
        assert!(manager
            .background
            .continuation(&key)
            .unwrap()
            .contains("native-agent-42"));
        crate::transcript::forget(&key);
    }

    #[test]
    fn idle_removal_rechecks_a_turn_that_started_after_the_sweep() {
        let manager = ChatManager::default();
        let key = "idle-recheck";
        let session = still_session(false, Duration::from_secs(20 * 60));
        put(&manager, key, session.clone());
        assert_eq!(still_keys(&manager, FIFTEEN), vec![key]);
        session.lock().unwrap().turn_started();
        assert!(!end_process_when(&manager, key, Some(FIFTEEN)).unwrap());
        end_process(&manager, key).unwrap();
    }

    /// Feedback db5e1001: Homebrew removed the Codex release a chat was
    /// started from. The idle chat is ended, to resume on the installed one;
    /// a chat mid-turn is left to finish.
    #[test]
    fn an_idle_chat_whose_program_was_removed_is_ended() {
        let dir = crate::test_dir::TestDir::new("replaced-binary");
        let release = dir.join("0.156.1");
        std::fs::create_dir_all(&release).unwrap();
        let program = release.join("codex");
        std::fs::write(&program, "").unwrap();
        let m = ChatManager::default();
        let busy = still_session(false, Duration::ZERO);
        put(&m, "chat-idle", still_session(false, Duration::ZERO));
        put(&m, "chat-busy", busy.clone());
        busy.lock().unwrap().turn_started();
        for key in ["chat-idle", "chat-busy", "chat-gone"] {
            m.binaries
                .lock()
                .unwrap()
                .insert(key.into(), program.clone());
        }
        assert!(
            sweep_replaced_binaries(&m).is_empty(),
            "the release is still there"
        );
        std::fs::remove_dir_all(&release).unwrap();
        assert_eq!(sweep_replaced_binaries(&m), vec!["chat-idle".to_string()]);
        assert!(m.has_process("chat-busy"), "a turn in flight is never cut");
        end_process(&m, "chat-busy").unwrap();
    }

    #[test]
    fn a_chat_still_for_longer_than_the_timeout_is_ended() {
        let m = ChatManager::default();
        put(
            &m,
            "chat-a",
            still_session(false, Duration::from_secs(20 * 60)),
        );

        assert_eq!(sweep_still_chats(&m, FIFTEEN), vec!["chat-a".to_string()]);
        assert!(
            chat_list_impl(&m).unwrap().is_empty(),
            "and it is gone from the map, so the next message starts a fresh one"
        );
    }

    #[test]
    fn chat_activity_says_which_running_chats_are_mid_turn() {
        let m = ChatManager::default();
        put(
            &m,
            "chat:working",
            still_session(true, Duration::from_secs(60)),
        );
        put(
            &m,
            "chat:idle",
            still_session(false, Duration::from_secs(60)),
        );
        let mut activity = chat_activity_impl(&m).unwrap();
        activity.sort_by(|a, b| a.key.cmp(&b.key));
        assert_eq!(
            activity,
            vec![
                ChatActivity {
                    key: "chat:idle".into(),
                    busy: false,
                    completing: false,
                },
                ChatActivity {
                    key: "chat:working".into(),
                    busy: true,
                    completing: false,
                },
            ]
        );
        end_process(&m, "chat:working").unwrap();
        end_process(&m, "chat:idle").unwrap();
        assert!(chat_activity_impl(&m).unwrap().is_empty());
    }

    #[test]
    fn a_chat_still_for_less_than_the_timeout_is_left_alone() {
        let m = ChatManager::default();
        put(
            &m,
            "chat-a",
            still_session(false, Duration::from_secs(5 * 60)),
        );

        assert!(sweep_still_chats(&m, FIFTEEN).is_empty());
        assert_eq!(chat_list_impl(&m).unwrap().len(), 1);
    }

    #[test]
    fn a_working_chat_is_never_ended_however_long_it_has_been_working() {
        // The one that would hurt. An agent part-way through a long tool call
        // — a build, a test suite, a question waiting on the person — produces
        // no output at all while it waits, so a sweeper reading silence would
        // kill exactly the turn nobody could afford to lose. `busy` is what
        // separates "nothing is happening" from "nothing is being said".
        let m = ChatManager::default();
        put(
            &m,
            "chat-a",
            still_session(true, Duration::from_secs(3 * 60 * 60)),
        );

        assert!(sweep_still_chats(&m, FIFTEEN).is_empty());
        assert_eq!(chat_list_impl(&m).unwrap().len(), 1);
    }

    #[test]
    fn retargeting_ends_the_agent_and_keeps_conversation_permissions() {
        let m = ChatManager::default();
        put(&m, "retarget-chat", still_session(false, Duration::ZERO));
        with_access(|access| access.insert("retarget-chat".into(), Access::Auto));
        m.remember_start(
            "retarget-chat",
            StartContext {
                cwd: "/tmp".into(),
                agent: ChatAgent::Claude,
                model: Some("claude-opus-4-6".into()),
                access: Some(Access::Auto),
                extra_dirs: None,
                env: None,
                effort: None,
                lite: None,
                session_id: Some("old-claude-session".into()),
            },
        );

        chat_retarget_impl(&m, "retarget-chat".into()).unwrap();

        assert!(chat_list_impl(&m).unwrap().is_empty());
        assert!(m.start_context("retarget-chat").is_none());
        assert!(with_access(|access| access.contains_key("retarget-chat")));
    }

    #[test]
    fn a_restart_keeps_what_stopping_would_drop() {
        // The whole reason this is not `chat_stop_impl`. Stopping forgets the
        // standing permissions and the access level because the person said
        // they were FINISHED; a restart is the same work carrying on, and
        // re-asking about a command already allowed "always" would be a
        // decision quietly taken back.
        let m = ChatManager::default();
        put(&m, "restart-access", still_session(false, Duration::ZERO));
        with_access(|a| a.insert("restart-access".into(), Access::Auto));

        assert_eq!(chat_restart_impl(&m, "restart-access".into()), Ok(1));
        assert!(
            with_access(|a| a.contains_key("restart-access")),
            "the level the work is being done at outlives the process doing it"
        );

        // And stopping, for contrast, is where it goes.
        put(&m, "restart-access", still_session(false, Duration::ZERO));
        chat_stop_impl(&m, "restart-access".into()).unwrap();
        assert!(!with_access(|a| a.contains_key("restart-access")));
    }

    #[test]
    fn restarting_a_chat_with_no_process_ends_nothing() {
        // The button is only offered while something is running, but a chat can
        // be swept between the tap and the call. Nothing to end is not a
        // failure — the next message was going to spawn a fresh agent anyway.
        let m = ChatManager::default();
        assert_eq!(chat_restart_impl(&m, "never-started".into()), Ok(0));
    }

    #[test]
    fn every_agents_full_stop_ends_a_turn_and_nothing_else_does() {
        assert!(
            provider_for(ChatAgent::Claude)
                .observe_event(&json!({ "type": "result", "subtype": "success" }))
                .turn_finished
        );
        assert!(
            provider_for(ChatAgent::Codex)
                .observe_event(&json!({ "type": "turn.completed" }))
                .turn_finished
        );
        // A failed turn has ended just as surely as a good one. Reading only
        // the happy word would leave a Codex chat that errored looking busy
        // for the rest of its life, and it would never be swept.
        assert!(
            provider_for(ChatAgent::Codex)
                .observe_event(&json!({ "type": "turn.failed" }))
                .turn_finished
        );
        assert!(
            provider_for(ChatAgent::Pi)
                .observe_event(&json!({ "type": "agent_settled" }))
                .turn_finished
        );
        assert!(
            !provider_for(ChatAgent::Pi)
                .observe_event(&json!({ "type": "agent_end", "willRetry": false }))
                .turn_finished
        );

        assert!(
            !provider_for(ChatAgent::Claude)
                .observe_event(&json!({ "type": "assistant" }))
                .turn_finished
        );
        assert!(
            !provider_for(ChatAgent::Claude)
                .observe_event(&json!({ "type": "stream_event" }))
                .turn_finished
        );
        assert!(
            !provider_for(ChatAgent::Codex)
                .observe_event(&json!({ "type": "thread.started" }))
                .turn_finished
        );
        assert!(
            !provider_for(ChatAgent::Pi)
                .observe_event(&json!({ "type": "turn_end" }))
                .turn_finished
        );
    }

    #[test]
    fn claude_puts_its_closing_words_on_its_own_full_stop() {
        let end = json!({ "type": "result", "result": "the migration is reversible" });
        assert_eq!(
            provider_for(ChatAgent::Claude)
                .observe_event(&end)
                .final_text,
            Some("the migration is reversible"),
            "the carried line must never win over words the event carries itself"
        );
    }

    #[test]
    fn codexs_closing_words_have_to_be_kept_as_they_go_past() {
        // `turn.completed` carries a usage block and NOTHING else, so the last
        // spoken text must be retained before the boundary arrives.
        let spoke = json!({
            "type": "item.completed",
            "item": { "id": "item_4", "type": "agent_message", "text": "Hi! I am Codex." },
        });
        assert_eq!(
            provider_for(ChatAgent::Codex)
                .observe_event(&spoke)
                .spoken_text,
            Some("Hi! I am Codex.")
        );

        // Everything else it says as it works is machinery, not an answer.
        assert_eq!(
            provider_for(ChatAgent::Codex)
                .observe_event(&json!({
                    "type": "item.completed",
                    "item": { "id": "item_1", "type": "command_execution" },
                }))
                .spoken_text,
            None
        );
        assert_eq!(
            provider_for(ChatAgent::Codex)
                .observe_event(&json!({
                    "type": "item.started",
                    "item": { "id": "item_4", "type": "agent_message", "text": "half a" },
                }))
                .spoken_text,
            None,
            "only a COMPLETED message is what the turn ended on"
        );

        let end = json!({ "type": "turn.completed", "usage": { "output_tokens": 448 } });
        assert!(
            provider_for(ChatAgent::Codex)
                .observe_event(&end)
                .turn_finished
        );
        // A turn that failed before saying anything ends on nothing, which is
        // honest — better than the last thing said two turns ago.
        assert!(
            provider_for(ChatAgent::Codex)
                .observe_event(&json!({ "type": "turn.failed" }))
                .turn_finished
        );
    }

    #[test]
    fn every_agent_names_the_conversation_it_opened() {
        // One field each, under two names, meaning the same thing: the id that
        // resumes this chat. Kept so the backend can restart a host it swept
        // and hand it the follow-up — see `StartContext`.
        assert_eq!(
            provider_for(ChatAgent::Claude)
                .observe_event(&json!({
                    "type": "system", "subtype": "init", "session_id": "abc-123",
                }))
                .session_id,
            Some("abc-123")
        );
        assert_eq!(
            provider_for(ChatAgent::Codex)
                .observe_event(&json!({ "type": "thread.started", "thread_id": "01a0-2f39" }))
                .session_id,
            Some("01a0-2f39")
        );
        assert_eq!(
            provider_for(ChatAgent::Pi)
                .observe_event(&json!({ "type": "session", "id": "pi-123" }))
                .session_id,
            Some("pi-123")
        );
        // Said once, in the opening event, and never again. Anything else that
        // happens to carry the field is not the announcement.
        assert_eq!(
            provider_for(ChatAgent::Claude)
                .observe_event(&json!({
                    "type": "system", "subtype": "status", "session_id": "abc-123",
                }))
                .session_id,
            None
        );
        assert_eq!(
            provider_for(ChatAgent::Claude)
                .observe_event(&json!({ "type": "assistant" }))
                .session_id,
            None
        );
    }

    #[test]
    fn a_turn_written_to_a_session_makes_it_busy_again() {
        // The other half of the pair: `turn_started` is what stops a chat
        // being swept out from under a message sent a second ago.
        let session = still_session(false, Duration::from_secs(20 * 60));
        assert!(session.lock().unwrap().still_for().is_some());

        session.lock().unwrap().turn_started();
        assert!(session.lock().unwrap().still_for().is_none());

        session.lock().unwrap().turn_ended();
        assert!(
            session.lock().unwrap().still_for().unwrap() < Duration::from_secs(1),
            "and the clock restarts from the end of the turn, not from before it"
        );
    }
}

#[cfg(test)]
mod question_delivery_tests {
    use super::*;
    use crate::question_store::{test_origin, Answer, Delivery, Record};

    #[test]
    fn a_worker_session_cannot_be_resumed_as_an_ordinary_chat() {
        let manager = ChatManager::default();
        let worker_session = format!("worker-session-{}", uuid::Uuid::new_v4());
        let main_session = format!("main-session-{}", uuid::Uuid::new_v4());
        manager.remember_start(
            "chat:orch-worker",
            StartContext::for_test(ChatAgent::Codex, Some(&worker_session)),
        );
        manager.remember_start(
            "chat:master",
            StartContext::for_test(ChatAgent::Codex, Some(&main_session)),
        );
        assert!(manager
            .require_user_resume(&worker_session)
            .unwrap_err()
            .contains("read-only"));
        assert!(manager.require_user_resume(&main_session).is_ok());
        assert!(manager.require_user_resume("unknown-session").is_ok());
    }

    fn setup() -> (Arc<ChatManager>, String, String, Vec<Answer>) {
        let key = format!("question-{}", uuid::Uuid::new_v4());
        let manager = Arc::new(ChatManager::default());
        let questions =
            vec![serde_json::from_value(json!({"question": "Which database?"})).unwrap()];
        let (id, _rx) = manager
            .questions
            .insert(test_origin(&key), questions)
            .unwrap();
        let answers = manager
            .questions
            .pending()
            .unwrap()
            .into_iter()
            .map(|q| Answer {
                id: q.id,
                answer: "SQLite".into(),
            })
            .collect();
        (manager, key, id, answers)
    }

    fn received(record: &Record) {
        crate::transcript::append(
            &record.origin.chat_key,
            &json!({
                "type": "turn.started", "octiq_user_turn_id": record.turn_id(),
            }),
        );
    }

    #[tokio::test]
    async fn the_actual_tool_timeout_leaves_an_answerable_question_without_a_browser() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("question-timeout-{}", uuid::Uuid::new_v4());
        let origin = test_origin(&key);
        manager.remember_start(&key, origin.start);
        let child = stand_in::echo()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        manager.sessions.lock().unwrap().insert(
            key.clone(),
            Arc::new(Mutex::new(ChatSession {
                launch_id: "launch-1".into(),
                user_turn_id: None,
                answering: None,
                child,
                stdin: None,
                codex: None,
                agent: ChatAgent::Codex,
                busy: true,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                leaving: None,
            })),
        );
        let request = serde_json::from_value(json!({ "chatKey": key, "launchId": "launch-1", "questions": [{"question":"Which database?"}] })).unwrap();
        let result = crate::question::ask_request_with_timeout(
            manager.clone(),
            request,
            Duration::from_millis(10),
        )
        .await;
        assert!(result.contains("saved and still waiting"), "{result}");
        let q = manager.questions.pending().unwrap().remove(0);
        assert_eq!(q.question.question, "Which database?");
        manager
            .questions
            .answer(&[Answer {
                id: q.id,
                answer: "SQLite".into(),
            }])
            .unwrap();
        deliver_question_answers_with(manager.clone(), |record| {
            received(record);
            Ok(())
        })
        .unwrap();
        deliver_question_answers_with(manager.clone(), |_| panic!("duplicate continuation"))
            .unwrap();
        assert!(manager.questions.pending().unwrap().is_empty());
        end_process(&manager, &key).unwrap();
        crate::transcript::forget(&key);
    }

    #[test]
    fn an_ended_turn_gets_one_continuation_with_its_original_question_and_settings() {
        let (manager, key, _id, answers) = setup();
        manager.questions.detach_launch("launch-1");
        manager.questions.answer(&answers).unwrap();
        let mut sends = 0;
        deliver_question_answers_with(manager.clone(), |record| {
            sends += 1;
            assert!(record
                .continuation()
                .contains("Q1: Which database?\nA1: SQLite"));
            assert_eq!(record.origin.start.model.as_deref(), Some("gpt-test"));
            assert_eq!(record.origin.start.session_id.as_deref(), Some("session-1"));
            assert_eq!(record.origin.start.access, Some(Access::Manual));
            received(record);
            Ok(())
        })
        .unwrap();
        manager.questions.answer(&answers).unwrap();
        deliver_question_answers_with(manager.clone(), |_| panic!("duplicate continuation"))
            .unwrap();
        assert_eq!(sends, 1);
        assert!(manager.questions.pending().unwrap().is_empty());
        crate::transcript::forget(&key);
    }

    #[test]
    fn saved_answers_resume_after_a_server_restart_without_a_browser() {
        let path = crate::test_dir::TestPath::new("question-recovery", "questions.json");
        let manager = Arc::new(ChatManager::with_saved_questions(path.to_path_buf()));
        let key = format!("question-restart-{}", uuid::Uuid::new_v4());
        manager
            .questions
            .insert(
                test_origin(&key),
                vec![serde_json::from_value(json!({"question": "Ship?"})).unwrap()],
            )
            .unwrap();
        let question = manager.questions.pending().unwrap().remove(0);
        manager
            .questions
            .answer(&[Answer {
                id: question.id,
                answer: "Yes".into(),
            }])
            .unwrap();
        drop(manager);
        let restored = Arc::new(ChatManager::with_saved_questions(path.to_path_buf()));
        deliver_question_answers_with(restored.clone(), |record| {
            assert_eq!(record.origin.start.agent, ChatAgent::Codex);
            assert_eq!(record.origin.start.cwd, "/tmp");
            received(record);
            Ok(())
        })
        .unwrap();
        deliver_question_answers_with(restored.clone(), |_| panic!("duplicate continuation"))
            .unwrap();
        assert!(restored.questions.pending().unwrap().is_empty());
        crate::transcript::forget(&key);
    }

    #[test]
    fn an_unconfirmed_dispatch_is_never_replayed_automatically() {
        let (manager, key, id, answers) = setup();
        manager.questions.detach(&id);
        manager.questions.answer(&answers).unwrap();
        manager
            .questions
            .set_delivery(&id, Delivery::Dispatching, None)
            .unwrap();
        deliver_question_answers_with(manager.clone(), |_| {
            panic!("cannot prove it was not already sent")
        })
        .unwrap();
        let saved = manager.questions.pending().unwrap();
        assert_eq!(saved[0].status, "failed");
        assert_eq!(saved[0].answer.as_deref(), Some("SQLite"));
        assert!(saved[0].error.as_deref().unwrap().contains("interrupted"));
        crate::transcript::forget(&key);
    }

    #[test]
    fn a_failed_spawn_retains_answers_and_only_retries_when_requested() {
        let (manager, key, id, answers) = setup();
        manager.questions.detach(&id);
        manager.questions.answer(&answers).unwrap();
        deliver_question_answers_with(manager.clone(), |_| Err("CLI unavailable".into())).unwrap();
        deliver_question_answers_with(manager.clone(), |_| panic!("failed answers wait for retry"))
            .unwrap();
        assert_eq!(manager.questions.pending().unwrap()[0].status, "failed");
        manager
            .questions
            .retry(&answers.iter().map(|a| a.id.clone()).collect::<Vec<_>>())
            .unwrap();
        deliver_question_answers_with(manager.clone(), |record| {
            received(record);
            Ok(())
        })
        .unwrap();
        deliver_question_answers_with(manager.clone(), |_| panic!("duplicate continuation"))
            .unwrap();
        assert!(manager.questions.pending().unwrap().is_empty());
        crate::transcript::forget(&key);
    }

    #[test]
    fn stop_cancels_saved_answers_and_their_queued_continuation() {
        let (manager, key, id, answers) = setup();
        manager.questions.detach(&id);
        manager.questions.answer(&answers).unwrap();
        let record = manager.questions.outbox().unwrap().remove(0);
        manager
            .queue_turn(
                &key,
                QueuedTurn {
                    text: record.continuation(),
                    images: vec![],
                    turn_id: Some(record.turn_id()),
                    appended_turn_ids: vec![],
                    recorded: true,
                    context: None,
                },
            )
            .unwrap();
        record_delivery(&key, Some(&record.turn_id()), "queued");
        chat_stop_impl(&manager, key.clone()).unwrap();
        assert!(manager.questions.pending().unwrap().is_empty());
        assert!(!manager.has_queued_turns(&key));
        assert!(manager.questions.answer(&answers).is_err());
        deliver_question_answers_with(manager.clone(), |_| {
            panic!("stopped work must stay stopped")
        })
        .unwrap();
        crate::transcript::forget(&key);
    }

    #[test]
    fn an_answer_rejoins_a_live_persistent_agent_through_the_normal_send_path() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("question-live-{}", uuid::Uuid::new_v4());
        let mut origin = test_origin(&key);
        origin.start.agent = ChatAgent::Claude;
        manager.remember_start(&key, origin.start.clone());
        let mut child = stand_in::echo()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        manager.sessions.lock().unwrap().insert(
            key.clone(),
            Arc::new(Mutex::new(ChatSession {
                launch_id: "launch-1".into(),
                user_turn_id: None,
                answering: None,
                child,
                stdin,
                codex: None,
                agent: ChatAgent::Claude,
                busy: false,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                leaving: None,
            })),
        );
        let (id, _rx) = manager
            .questions
            .insert(
                origin,
                vec![serde_json::from_value(json!({"question": "Which database?"})).unwrap()],
            )
            .unwrap();
        let q = manager.questions.pending().unwrap().remove(0);
        manager.questions.detach(&id);
        manager
            .questions
            .answer(&[Answer {
                id: q.id,
                answer: "SQLite".into(),
            }])
            .unwrap();
        deliver_question_answers(manager.clone()).unwrap();
        let record = manager.questions.outbox().unwrap().remove(0);
        assert_eq!(question_receipt(&record).as_deref(), Some("dispatched"));
        assert!(manager.sessions.lock().unwrap()[&key].lock().unwrap().busy);
        deliver_question_answers(manager.clone()).unwrap();
        let prompts = crate::transcript::since(&key, 0)
            .iter()
            .filter(|r| r.event["type"] == "user")
            .count();
        assert_eq!(prompts, 1);
        received(&record);
        deliver_question_answers(manager.clone()).unwrap();
        assert!(manager.questions.pending().unwrap().is_empty());
        end_process(&manager, &key).unwrap();
        crate::transcript::forget(&key);
    }
}

#[cfg(test)]
mod completion_tests {
    use super::tests::{claude_session, hold};
    use super::*;

    /// A chat the index lists, with a live stand-in Claude under its key.
    struct Listed {
        manager: Arc<ChatManager>,
        id: String,
        key: String,
        session: Arc<Mutex<ChatSession>>,
    }

    impl Listed {
        fn new(busy: bool) -> Self {
            Self::with(claude_session(busy))
        }

        fn with(session: Arc<Mutex<ChatSession>>) -> Self {
            let id = format!("complete-{}", uuid::Uuid::new_v4().simple());
            let key = format!("chat:{id}");
            crate::chat_index::upsert(
                serde_json::from_value(json!({
                    "id": id, "projectId": "p1", "title": "a chat", "updatedAt": 100,
                }))
                .unwrap(),
            )
            .unwrap();
            let manager = Arc::new(ChatManager::default());
            hold(&manager, &key, session.clone());
            Self {
                manager,
                id,
                key,
                session,
            }
        }

        fn complete(&self) -> Completing {
            chat_complete_impl(&self.manager, &self.key, "wrap up")
                .expect("the chat can be completed")
                .expect("it has a process")
        }

        fn send(&self, text: &str, id: &str) {
            chat_send_user_impl(
                self.manager.clone(),
                self.key.clone(),
                text.into(),
                None,
                None,
                Some(id.into()),
                None,
            )
            .expect("a message from the person");
        }

        /// What the stdout reader does when the turn in flight reaches its
        /// full stop: `Some(true)` when that closed the chat, `Some(false)`
        /// when it was the wrap-up and the completion is off.
        fn full_stop(&self, clean: bool) -> Option<bool> {
            let (wrap_up, refused) = {
                let mut running = self.session.lock().unwrap();
                end_turn_locked(&self.manager, &self.key, &self.key, &mut running, clean)
            };
            assert_eq!(refused, None);
            wrap_up.map(|ended| settle_wrap_up(&self.manager, &self.key, &self.session, ended))
        }

        fn answering(&self) -> Option<String> {
            self.session.lock().unwrap().answering.clone()
        }

        fn busy(&self) -> bool {
            self.session.lock().unwrap().busy
        }

        fn stop(&self) {
            chat_interrupt_impl(&self.manager, self.key.clone()).expect("Stop");
        }

        fn queued(&self) -> Vec<String> {
            chat_queue_state_impl(&self.manager, &self.key)
                .unwrap()
                .queued_turn_ids
        }

        fn completing(&self) -> Option<String> {
            self.manager.completing_turn(&self.key)
        }

        /// The wrap-up's clean full stop as the reader takes it, decided and
        /// not yet acted on: the reader writes the full stop down in between.
        fn wrap_up_full_stop(&self) -> WrapUpEnded {
            let (wrap_up, refused) = {
                let mut running = self.session.lock().unwrap();
                end_turn_locked(&self.manager, &self.key, &self.key, &mut running, true)
            };
            assert_eq!(refused, None);
            wrap_up.expect("the wrap-up's own full stop")
        }

        /// What `start_session` does to the session table and the index when
        /// this chat is started again, with `process` standing in for the
        /// agent it would spawn. Refused, in its words, while a process is
        /// there.
        fn start(
            &self,
            process: Arc<Mutex<ChatSession>>,
        ) -> Result<Arc<Mutex<ChatSession>>, String> {
            {
                let mut sessions = self.manager.sessions.lock().unwrap();
                if sessions.contains_key(&self.key) || self.manager.claimed_elsewhere(&self.key) {
                    return Err(format!("chat '{}' is already running", self.key));
                }
                sessions.insert(self.key.clone(), process.clone());
            }
            reopen_started_chat(&self.key, &self.key);
            Ok(process)
        }

        /// Started again with a message: a Claude with a turn in flight.
        fn start_again(&self) -> Result<Arc<Mutex<ChatSession>>, String> {
            let process = claude_session(true);
            process.lock().unwrap().answering = Some("user-again".into());
            self.start(process)
        }

        /// The process in the session table, if it is `process`.
        fn runs(&self, process: &Arc<Mutex<ChatSession>>) -> bool {
            self.manager
                .sessions
                .lock()
                .unwrap()
                .get(&self.key)
                .is_some_and(|current| Arc::ptr_eq(current, process))
        }

        fn row(&self) -> crate::chat_index::ChatMeta {
            crate::chat_index::list()
                .into_iter()
                .find(|chat| chat.id == self.id)
                .expect("the chat's row")
        }

        fn live(&self) -> bool {
            self.manager.has_process(&self.key)
        }
    }

    impl Drop for Listed {
        fn drop(&mut self) {
            let _ = end_process(&self.manager, &self.key);
            let _ = crate::chat_index::remove(&self.id);
            crate::transcript::forget(&self.key);
        }
    }

    #[test]
    fn completing_an_idle_chat_hands_its_agent_the_wrap_up_at_once() {
        let chat = Listed::new(false);
        let completing = chat.complete();

        assert_eq!(completing.state, "started");
        assert!(completing.turn_id.starts_with(COMPLETION_TURN_PREFIX));
        assert_eq!(chat.answering(), Some(completing.turn_id.clone()));
        assert!(chat.session.lock().unwrap().busy);
        assert_eq!(
            chat.manager.completing_turn(&chat.key),
            Some(completing.turn_id.clone())
        );
        // The wrap-up is in the record as the turn it is, in the host's words.
        let recorded = crate::transcript::since(&chat.key, 0);
        assert_eq!(recorded[0].event["uuid"], completing.turn_id.as_str());
        assert_eq!(
            recorded[0].event["message"]["content"][0]["text"],
            "wrap up"
        );
        // A reloaded page reads the state where it reads the queue.
        let state =
            serde_json::to_value(chat_queue_state_impl(&chat.manager, &chat.key).unwrap()).unwrap();
        assert_eq!(state["completingTurnId"], completing.turn_id.as_str());
        let activity = serde_json::to_value(chat_activity_impl(&chat.manager).unwrap()).unwrap();
        assert_eq!(activity[0]["completing"], true);
    }

    #[test]
    fn a_wrap_up_waits_behind_the_running_turn_and_never_interrupts_it() {
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        let completing = chat.complete();

        assert_eq!(completing.state, "queued");
        assert_eq!(
            chat.answering().as_deref(),
            Some("user-0"),
            "the running turn was left alone"
        );
        assert_eq!(
            chat_queue_state_impl(&chat.manager, &chat.key)
                .unwrap()
                .queued_turn_ids,
            [completing.turn_id.clone()]
        );
        // The running turn's own full stop is nobody's completion, however it
        // ended, and it hands the wrap-up over.
        assert_eq!(chat.full_stop(false), None);
        assert_eq!(chat.answering(), Some(completing.turn_id.clone()));
        assert!(!chat.row().is_done());
        assert!(chat.live());
        // Then the wrap-up's own.
        assert_eq!(chat.full_stop(true), Some(true));
        assert!(chat.row().is_done());
        assert!(!chat.live());
    }

    #[test]
    fn a_wrap_up_that_ends_cleanly_ticks_the_chat_and_stops_its_process() {
        let chat = Listed::new(false);
        crate::permission::forget_chat(&chat.key);
        record_access_for(&chat.key, Some(Access::Auto));
        chat.complete();

        assert_eq!(chat.full_stop(true), Some(true));

        let row = chat.row();
        assert!(row.is_done());
        assert!(row.done_held);
        assert!(!chat.live(), "the process is out of the session table");
        assert_eq!(chat.manager.completing_turn(&chat.key), None);
        assert_eq!(access_now(&chat.key), None, "stopped the way Stop stops it");
        let exited = (0..100).any(|_| {
            let gone = chat
                .session
                .lock()
                .unwrap()
                .child
                .try_wait()
                .is_ok_and(|status| status.is_some());
            if !gone {
                thread::sleep(Duration::from_millis(50));
            }
            gone
        });
        assert!(exited, "and it was ended, not left running");
        // The page's own record of that turn's end does not retire the tick.
        let mut ended = chat.row();
        ended.updated_at = row.done_at.unwrap() + 5_000;
        crate::chat_index::upsert(ended).unwrap();
        assert!(chat.row().is_done());
    }

    #[test]
    fn stopping_the_wrap_up_leaves_the_chat_unticked_and_running() {
        let chat = Listed::new(false);
        chat.complete();

        chat_interrupt_impl(&chat.manager, chat.key.clone()).expect("Stop");

        assert_eq!(chat.manager.completing_turn(&chat.key), None);
        // The cut-off turn's own full stop arrives later, and decides nothing.
        assert_eq!(chat.full_stop(false), None);
        assert_eq!(chat.full_stop(true), None);
        assert!(!chat.row().is_done());
        assert!(chat.live());
    }

    #[test]
    fn stopping_the_turn_ahead_of_a_queued_wrap_up_keeps_the_completion() {
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        let completing = chat.complete();

        chat_interrupt_impl(&chat.manager, chat.key.clone()).expect("Stop");

        // Stop keeps the queue: the wrap-up is what starts next.
        assert_eq!(
            chat.manager.completing_turn(&chat.key),
            Some(completing.turn_id.clone())
        );
        assert_eq!(chat.full_stop(false), None);
        assert_eq!(chat.answering(), Some(completing.turn_id));
        assert_eq!(chat.full_stop(true), Some(true));
        assert!(chat.row().is_done());
    }

    #[test]
    fn a_wrap_up_that_fails_leaves_the_chat_unticked_and_running() {
        let chat = Listed::new(false);
        chat.complete();

        assert_eq!(chat.full_stop(false), Some(false));

        assert!(!chat.row().is_done());
        assert!(chat.live());
        assert_eq!(chat.manager.completing_turn(&chat.key), None);
        // And the chat can be completed again.
        assert_eq!(chat.complete().state, "started");
    }

    #[test]
    fn a_message_queued_behind_the_wrap_up_wins_and_runs() {
        let chat = Listed::new(false);
        let completing = chat.complete();
        chat.send("one more thing", "user-9");
        assert_eq!(
            chat_queue_state_impl(&chat.manager, &chat.key)
                .unwrap()
                .queued_turn_ids,
            ["user-9"],
            "its own turn, never folded into the wrap-up"
        );

        assert_eq!(chat.full_stop(true), Some(false));

        assert!(!chat.row().is_done());
        assert!(chat.live());
        assert_eq!(chat.manager.completing_turn(&chat.key), None);
        assert_eq!(chat.answering().as_deref(), Some("user-9"));
        assert!(chat.session.lock().unwrap().busy, "and it is running");
        assert_ne!(chat.answering(), Some(completing.turn_id));
    }

    #[test]
    fn a_wrap_up_is_never_folded_into_the_message_queued_before_it() {
        let chat = Listed::new(true);
        chat.send("first", "user-1");
        let completing = chat.complete();
        chat.send("after", "user-2");

        let queued = chat_queue_state_impl(&chat.manager, &chat.key)
            .unwrap()
            .queued_turn_ids;
        assert_eq!(queued, ["user-1", completing.turn_id.as_str(), "user-2"]);
    }

    #[test]
    fn cancelling_the_queued_wrap_up_takes_the_completion_back() {
        let chat = Listed::new(true);
        let completing = chat.complete();

        assert_eq!(
            chat_cancel_queued_impl(&chat.manager, chat.key.clone(), completing.turn_id.clone()),
            Ok(true)
        );

        assert_eq!(chat.manager.completing_turn(&chat.key), None);
        assert_eq!(chat.full_stop(true), None, "the running turn just ends");
        assert!(!chat.row().is_done());
        assert!(chat.live());
    }

    #[test]
    fn sending_the_queued_wrap_up_now_interrupts_and_still_completes() {
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        let completing = chat.complete();

        assert_eq!(
            chat_start_queued_impl(&chat.manager, chat.key.clone(), completing.turn_id.clone()),
            Ok(true)
        );
        assert_eq!(
            chat.manager.completing_turn(&chat.key),
            Some(completing.turn_id),
            "it was the turn ahead that was cut short"
        );
        assert_eq!(chat.full_stop(false), None);
        assert_eq!(chat.full_stop(true), Some(true));
        assert!(chat.row().is_done());
    }

    #[test]
    fn sending_another_queued_message_now_cuts_the_wrap_up_short() {
        let chat = Listed::new(false);
        chat.complete();
        chat.send("do this instead", "user-9");

        assert_eq!(
            chat_start_queued_impl(&chat.manager, chat.key.clone(), "user-9".into()),
            Ok(true)
        );

        assert_eq!(chat.manager.completing_turn(&chat.key), None);
        assert_eq!(chat.full_stop(false), None);
        assert_eq!(chat.answering().as_deref(), Some("user-9"));
        assert!(!chat.row().is_done());
    }

    #[test]
    fn a_chat_that_is_completing_cannot_be_completed_twice() {
        let chat = Listed::new(true);
        chat.complete();
        assert_eq!(
            chat_complete_impl(&chat.manager, &chat.key, "wrap up"),
            Err(ALREADY_COMPLETING.into())
        );
        assert_eq!(
            chat_queue_state_impl(&chat.manager, &chat.key)
                .unwrap()
                .queued_turn_ids
                .len(),
            1,
            "the refused one queued nothing"
        );
    }

    #[test]
    fn an_ordinary_send_cannot_go_round_a_queued_wrap_up() {
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        let completing = chat.complete();
        // Stop ends the turn at once: the session reads idle with the
        // wrap-up still waiting for the reader to hand it over.
        chat_interrupt_impl(&chat.manager, chat.key.clone()).expect("Stop");
        assert!(!chat.session.lock().unwrap().busy);

        chat.send("in the gap", "user-9");

        assert_eq!(
            chat.answering().as_deref(),
            Some("user-0"),
            "nothing was written past the queue"
        );
        assert_eq!(
            chat_queue_state_impl(&chat.manager, &chat.key)
                .unwrap()
                .queued_turn_ids,
            [completing.turn_id.as_str(), "user-9"]
        );
        // The wrap-up goes first, and the message behind it then wins.
        assert_eq!(chat.full_stop(false), None);
        assert_eq!(chat.answering(), Some(completing.turn_id));
        assert_eq!(chat.full_stop(true), Some(false));
        assert_eq!(chat.answering().as_deref(), Some("user-9"));
        assert!(!chat.row().is_done());
    }

    #[test]
    fn a_message_that_reaches_the_agent_before_the_chat_is_closed_wins() {
        let chat = Listed::new(false);
        let completing = chat.complete();
        // The wrap-up's full stop is read and decided...
        let (wrap_up, _) = {
            let mut running = chat.session.lock().unwrap();
            end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true)
        };
        assert_eq!(
            wrap_up,
            Some(WrapUpEnded::Close {
                turn_id: completing.turn_id,
                starts: crate::chat_index::starts(&chat.id),
            })
        );
        // ...and before it is acted on the person sends, to an idle agent.
        chat.send("wait, one more", "user-9");

        assert!(!settle_wrap_up(
            &chat.manager,
            &chat.key,
            &chat.session,
            wrap_up.unwrap()
        ));

        assert!(chat.live(), "the process that has the message is kept");
        assert!(!chat.row().is_done());
        assert_eq!(chat.answering().as_deref(), Some("user-9"));
    }

    #[test]
    fn ending_the_process_ends_a_completion_in_it() {
        // Running.
        let chat = Listed::new(false);
        chat.complete();
        chat_stop_impl(&chat.manager, chat.key.clone()).unwrap();
        assert_eq!(chat.manager.completing_turn(&chat.key), None);
        assert!(!chat.row().is_done());

        // Still queued.
        let chat = Listed::new(true);
        chat.complete();
        chat_restart_impl(&chat.manager, chat.key.clone()).unwrap();
        assert_eq!(chat.manager.completing_turn(&chat.key), None);
        assert!(!chat.row().is_done());
    }

    #[test]
    fn a_process_that_dies_mid_wrap_up_completes_nothing() {
        let chat = Listed::new(false);
        let completing = chat.complete();
        // What the reader does once the stream has closed with no full stop.
        {
            let running = chat.session.lock().unwrap();
            chat.manager
                .completion_cut_short(&chat.key, &running, COMPLETION_ENDED);
        }
        assert_eq!(chat.manager.completing_turn(&chat.key), None);
        assert!(!chat.row().is_done());

        drop(completing);

        // An older process closing its stream says nothing about a wrap-up
        // it was never given.
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        let queued = chat.complete();
        {
            let running = chat.session.lock().unwrap();
            chat.manager
                .completion_cut_short(&chat.key, &running, COMPLETION_ENDED);
        }
        assert_eq!(
            chat.manager.completing_turn(&chat.key),
            Some(queued.turn_id)
        );
    }

    /// A stand-in for a provider other than Claude, in a turn nobody here
    /// is completing.
    fn session_of(agent: ChatAgent, stdin: bool, busy: bool) -> Arc<Mutex<ChatSession>> {
        let mut child = if stdin {
            stand_in::echo()
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
        } else {
            stand_in::still().stdin(Stdio::null()).spawn()
        }
        .expect("a stand-in agent");
        let stdin = child.stdin.take();
        Arc::new(Mutex::new(ChatSession {
            launch_id: "test-launch".into(),
            user_turn_id: None,
            answering: Some("user-0".into()),
            child,
            stdin,
            codex: None,
            agent,
            busy,
            last_active: Instant::now(),
            cut_off: CutOff::No,
            leaving: None,
        }))
    }

    #[test]
    fn a_command_line_agent_takes_the_wrap_up_in_its_next_process() {
        // No stdin to write to: the wrap-up waits in the queue for the
        // reaper to carry into the next command, even with no turn in flight.
        let chat = Listed::with(session_of(ChatAgent::Pi, false, false));
        let completing = chat.complete();
        assert_eq!(completing.state, "queued");

        // The turn before it reaching its full stop is not the wrap-up's,
        // and a reader never hands a one-shot process its next turn.
        assert_eq!(chat.full_stop(true), None);
        assert!(chat.manager.has_queued_turns(&chat.key));
        assert!(!chat.row().is_done());
        assert_eq!(
            chat.manager.completing_turn(&chat.key),
            Some(completing.turn_id)
        );
    }

    #[test]
    fn stopping_antigravity_mid_wrap_up_ends_its_process_and_ticks_nothing() {
        // Its Stop is the end of the process: no full stop will ever come
        // back for the wrap-up, so the Stop itself has to end the completion.
        let chat = Listed::with(session_of(ChatAgent::Antigravity, true, false));
        chat.manager.remember_start(
            &chat.key,
            StartContext::for_test(ChatAgent::Antigravity, None),
        );
        let completing = chat.complete();
        assert_eq!(completing.state, "started");

        chat_interrupt_impl(&chat.manager, chat.key.clone()).expect("Stop");

        assert_eq!(chat.manager.completing_turn(&chat.key), None);
        assert!(!chat.live());
        assert!(!chat.row().is_done());
    }

    #[test]
    fn a_one_shot_process_that_has_already_exited_is_still_ticked() {
        let chat = Listed::new(false);
        chat.complete();
        let (wrap_up, _) = {
            let mut running = chat.session.lock().unwrap();
            end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true)
        };
        // Its reaper got there first, as it does when the process exits on
        // its own full stop.
        chat.manager.sessions.lock().unwrap().remove(&chat.key);
        assert!(settle_wrap_up(
            &chat.manager,
            &chat.key,
            &chat.session,
            wrap_up.unwrap()
        ));
        assert!(chat.row().is_done());

        // But not when a newer process is running under the key.
        let chat = Listed::new(false);
        chat.complete();
        let (wrap_up, _) = {
            let mut running = chat.session.lock().unwrap();
            end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true)
        };
        let newer = claude_session(true);
        hold(&chat.manager, &chat.key, newer.clone());
        assert!(!settle_wrap_up(
            &chat.manager,
            &chat.key,
            &chat.session,
            wrap_up.unwrap()
        ));
        assert!(!chat.row().is_done());
        assert!(newer.lock().unwrap().child.try_wait().unwrap().is_none());
        assert!(chat.live(), "the newer process is left alone");
    }

    #[test]
    fn a_chat_with_no_process_is_claimed_for_the_start_that_completes_it() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("chat:claim-{}", uuid::Uuid::new_v4().simple());
        // No process: the caller is told to start it.
        assert_eq!(chat_complete_impl(&manager, &key, "wrap up"), Ok(None));
        assert_eq!(manager.completing_turn(&key), None);

        let turn_id = manager.claim_completion(&key).expect("a claim");
        assert!(turn_id.starts_with(COMPLETION_TURN_PREFIX));
        assert_eq!(manager.completing_turn(&key), Some(turn_id.clone()));
        // A second Complete while that start is on its way.
        assert_eq!(
            chat_complete_impl(&manager, &key, "wrap up"),
            Err(ALREADY_COMPLETING.into())
        );
        assert_eq!(
            manager.claim_completion(&key),
            Err(ALREADY_COMPLETING.into())
        );
        // The start failed: the chat is not left completing.
        manager.settle_claimed_completion(&key, &turn_id, &Err("no such folder".into()));
        assert_eq!(manager.completing_turn(&key), None);

        // A chat that started in the meantime is not claimed; the caller
        // goes back to the live path.
        hold(&manager, &key, claude_session(false));
        assert_eq!(
            manager.claim_completion(&key),
            Err(format!("chat '{key}' is already running"))
        );
        end_process(&manager, &key).unwrap();
    }

    #[test]
    fn the_wrap_up_names_only_the_steps_that_apply() {
        let plain = wrap_up_message(false, &[]);
        assert!(plain.starts_with(
            "The person is completing this chat. Wrap up now, in this order, and start no new work.\n1. Work: commit"
        ));
        assert!(plain.contains("\n2. Clean up: "));
        assert!(
            plain.contains("\n3. Report in at most ten lines: Done, Not done, Remaining risks.\n")
        );
        assert!(!plain.contains("vault_agent_memory_append"));
        assert!(!plain.contains("orchestration_run_stop"));
        assert!(plain.ends_with(
            "When this turn ends the chat is marked done and its process stops; a new message reopens it."
        ));

        let lead = wrap_up_message(true, &["run_1".into()]);
        assert!(lead.contains("\n3. Memory: "));
        assert!(lead.contains("save it with vault_agent_memory_append"));
        assert!(lead.contains(
            "\n4. Run: this chat coordinates orchestration run run_1. Stop it with orchestration_run_stop once no worker is running. Leave the mission worktree; the person closes the mission.\n"
        ));
        assert!(lead.contains("\n5. Report in at most ten lines"));

        let two = wrap_up_message(false, &["run_1".into(), "run_2".into()]);
        assert!(two.contains(
            "\n3. Run: this chat coordinates orchestration runs run_1, run_2. Stop each with"
        ));
        assert!(two.contains("\n4. Report"));
    }

    #[test]
    fn only_a_full_stop_the_agent_reached_on_its_own_is_clean() {
        let claude = |event: Value| ended_cleanly(ChatAgent::Claude, &event, false);
        assert!(claude(
            json!({ "type": "result", "subtype": "success", "is_error": false })
        ));
        assert!(claude(json!({ "type": "result", "result": "done" })));
        // The person's Stop coming back, a failed request, a turn cap.
        assert!(!claude(
            json!({ "type": "result", "subtype": "error_during_execution" })
        ));
        assert!(!claude(
            json!({ "type": "result", "subtype": "success", "is_error": true, "api_error_status": 529 })
        ));
        assert!(!claude(
            json!({ "type": "result", "subtype": "error_max_turns" })
        ));

        let codex = |event: Value| ended_cleanly(ChatAgent::Codex, &event, false);
        assert!(codex(json!({ "type": "turn.completed" })));
        assert!(codex(
            json!({ "type": "turn.completed", "status": "completed" })
        ));
        assert!(!codex(
            json!({ "type": "turn.completed", "status": "interrupted" })
        ));
        assert!(!codex(
            json!({ "type": "turn.failed", "error": { "message": "boom" } })
        ));

        let agy = |event: &Value, refused| ended_cleanly(ChatAgent::Antigravity, event, refused);
        let fine =
            json!({ "event": "result", "result": { "status": "SUCCESS", "response": "ok" } });
        assert!(agy(&fine, false));
        assert!(!agy(&fine, true), "a refusal ended this turn");
        assert!(!agy(
            &json!({ "event": "result", "result": { "status": "ERROR", "error": "interrupted" } }),
            false
        ));
    }

    #[test]
    fn an_antigravity_refusal_is_this_turns_only_when_the_count_grew() {
        let result = |denied: usize| {
            json!({ "event": "result", "result": {
                "status": "SUCCESS",
                "denied_actions": vec![json!({ "action": "command" }); denied],
            }})
        };
        let mut seen = DeniedActions::default();
        assert!(
            !seen.newly_refused(&json!({ "event": "result", "result": { "status": "SUCCESS" } }))
        );
        assert!(!seen.newly_refused(&result(0)));
        assert!(seen.newly_refused(&result(1)));
        // The conversation's total is repeated on every later result.
        assert!(!seen.newly_refused(&result(1)));
        assert!(seen.newly_refused(&result(3)));
    }

    // ---- Review of 2fd3231: H1, H2, M1, M2 ---------------------------------

    use crate::bus::tap::Tap;

    /// Poll for a state another thread reaches with no signal to wait on.
    fn until(what: &str, mut reached: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !reached() {
            assert!(Instant::now() < deadline, "never happened in 60s: {what}");
            thread::sleep(Duration::from_millis(5));
        }
    }

    /// What the bus was told about one chat's completion and its row, in
    /// order: `completing <state>`, `completed ok`, `completed <reason>` and
    /// `index` for a change to its row.
    fn said(tap: &Tap) -> Vec<String> {
        tap.heard()
            .into_iter()
            .filter_map(|(event, payload)| match event.as_str() {
                "chat-completing" => {
                    Some(format!("completing {}", payload["state"].as_str().unwrap()))
                }
                "chat-completed" if payload["ok"] == true => {
                    assert!(payload["doneAt"].is_i64(), "{payload}");
                    assert!(payload.get("reason").is_none(), "{payload}");
                    Some("completed ok".into())
                }
                "chat-completed" => {
                    assert!(payload.get("doneAt").is_none(), "{payload}");
                    Some(format!("completed {}", payload["reason"].as_str().unwrap()))
                }
                "chat-index-changed" => Some("index".into()),
                _ => None,
            })
            .collect()
    }

    /// The wrap-up turn each completion event named, in order.
    fn turns_named(tap: &Tap) -> Vec<String> {
        tap.heard()
            .into_iter()
            .filter(|(event, _)| event.starts_with("chat-complet"))
            .map(|(_, payload)| payload["turnId"].as_str().expect("a turn id").to_string())
            .collect()
    }

    fn exited(process: &Arc<Mutex<ChatSession>>) -> bool {
        (0..200).any(|_| {
            let gone = process
                .lock()
                .unwrap()
                .child
                .try_wait()
                .is_ok_and(|status| status.is_some());
            if !gone {
                thread::sleep(Duration::from_millis(50));
            }
            gone
        })
    }

    fn running(process: &Arc<Mutex<ChatSession>>) -> bool {
        process.lock().unwrap().child.try_wait().unwrap().is_none()
    }

    /// H1. The review's interleaving: the completed process is out of the
    /// session table, and before the index is ticked the chat is started
    /// again and reopened; the old path then ticked and held that chat and
    /// announced it done, with a turn in flight in its new process.
    ///
    /// That gap is gone, so the start is scheduled where it used to be: this
    /// stops the close inside its one step and lets a start run against it.
    #[test]
    fn a_start_scheduled_while_a_chat_is_being_closed_comes_after_the_whole_close() {
        let chat = Listed::new(false);
        let tap = Tap::on(&chat.id);
        let completing = chat.complete();
        let ended = chat.wrap_up_full_stop();
        let old = chat.session.clone();

        // The close takes the session table and then waits for the session
        // this thread holds.
        let held = old.lock().unwrap();
        let newer = thread::scope(|scope| {
            let closing =
                scope.spawn(|| settle_wrap_up(&chat.manager, &chat.key, &chat.session, ended));
            until("the close holds the session table", || {
                matches!(
                    chat.manager.sessions.try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                )
            });
            let starting = scope.spawn(|| chat.start_again());
            thread::sleep(Duration::from_millis(100));
            assert!(
                !starting.is_finished(),
                "no start gets into the session table while a chat is closing"
            );
            assert!(!closing.is_finished());
            drop(held);
            assert!(closing.join().unwrap(), "the close won, and won whole");
            starting
                .join()
                .unwrap()
                .expect("and the start then went ahead")
        });

        // Closed: ticked, held, announced, its process stopped. Then started
        // again, which took the tick. Never a tick over the turn in flight.
        assert_eq!(
            said(&tap),
            ["completing started", "index", "completed ok", "index"]
        );
        assert_eq!(
            turns_named(&tap),
            [completing.turn_id.clone(), completing.turn_id]
        );
        let row = chat.row();
        assert_eq!(row.done_at, None, "the start that followed took the tick");
        assert!(!row.done_held);
        assert!(chat.runs(&newer));
        assert!(newer.lock().unwrap().busy);
        assert!(running(&newer));
        assert!(exited(&old), "the completed process was stopped");
    }

    /// H1. A start can only come before the close when the completed process
    /// has already left the table by itself, as a one-shot's does on its own
    /// full stop. That start wins: nothing is ticked, nothing is held.
    #[test]
    fn a_start_just_before_a_chat_is_closed_wins_and_nothing_is_ticked() {
        let chat = Listed::new(false);
        let tap = Tap::on(&chat.id);
        let completing = chat.complete();
        let ended = chat.wrap_up_full_stop();
        // While the completed process is in the table no start gets in, in
        // the words a page falls back to sending on.
        let running_already = format!("chat '{}' is already running", chat.key);
        assert_eq!(chat.start_again().err(), Some(running_already.clone()));
        assert_eq!(
            chat.manager.claim_start(&chat.key).err(),
            Some(running_already)
        );

        chat.manager.sessions.lock().unwrap().remove(&chat.key);
        let newer = chat.start_again().expect("nothing runs there now");

        assert!(!settle_wrap_up(
            &chat.manager,
            &chat.key,
            &chat.session,
            ended
        ));

        assert_eq!(said(&tap), ["completing started", "completed superseded"]);
        assert_eq!(
            turns_named(&tap),
            [completing.turn_id.clone(), completing.turn_id]
        );
        let row = chat.row();
        assert_eq!(row.done_at, None);
        assert!(!row.done_held);
        assert!(chat.runs(&newer));
        assert!(newer.lock().unwrap().busy);
        assert!(running(&newer), "the newer process is left alone");
        assert!(
            running(&chat.session),
            "and the close stopped nothing: it never got that far"
        );
    }

    /// H1. The same start, already gone again when the close looks: the
    /// session table is as empty as after a one-shot's own exit, and only
    /// the index knows the chat was started in between.
    #[test]
    fn a_start_that_came_and_went_before_a_chat_is_closed_still_wins() {
        let chat = Listed::new(false);
        let tap = Tap::on(&chat.id);
        chat.complete();
        let ended = chat.wrap_up_full_stop();
        chat.manager.sessions.lock().unwrap().remove(&chat.key);
        chat.start_again().expect("nothing runs there now");
        assert_eq!(end_process(&chat.manager, &chat.key), Ok(true));
        assert!(!chat.live());

        assert!(!settle_wrap_up(
            &chat.manager,
            &chat.key,
            &chat.session,
            ended
        ));

        assert_eq!(said(&tap), ["completing started", "completed superseded"]);
        assert!(!chat.row().is_done());
        assert!(!chat.row().done_held);
    }

    /// H1. And the start that comes after: the chat is closed whole, and
    /// the start reopens it.
    #[test]
    fn a_start_just_after_a_chat_is_closed_reopens_it() {
        let chat = Listed::new(false);
        let tap = Tap::on(&chat.id);
        chat.complete();

        assert_eq!(chat.full_stop(true), Some(true));

        assert_eq!(said(&tap), ["completing started", "index", "completed ok"]);
        assert!(chat.row().is_done());
        assert!(chat.row().done_held);
        assert!(!chat.live());
        assert!(exited(&chat.session));

        let newer = chat.start_again().expect("a completed chat is not locked");

        assert_eq!(
            said(&tap),
            ["completing started", "index", "completed ok", "index"]
        );
        let row = chat.row();
        assert_eq!(row.done_at, None);
        assert!(!row.done_held);
        assert!(chat.runs(&newer));
        assert!(running(&newer));
    }

    /// M2. The tick is written first. One that cannot be written is said to
    /// the person, with why, and nothing of the stop is done.
    #[test]
    fn a_tick_that_cannot_be_written_fails_the_completion_and_stops_nothing() {
        let chat = Listed::new(false);
        record_access_for(&chat.key, Some(Access::Auto));
        let tap = Tap::on(&chat.id);
        let completing = chat.complete();

        let closed = crate::chat_index::tests::while_writes_fail(|| chat.full_stop(true));

        assert_eq!(closed, Some(false));
        let why =
            "The chat could not be marked done: the disk is full. Its agent was left running.";
        assert_eq!(
            said(&tap),
            ["completing started".to_string(), format!("completed {why}")]
        );
        assert_eq!(
            turns_named(&tap),
            [completing.turn_id.clone(), completing.turn_id]
        );
        let row = chat.row();
        assert_eq!(row.done_at, None);
        assert!(!row.done_held);
        assert!(chat.live(), "the process is still in the session table");
        assert!(running(&chat.session), "and still running");
        assert_eq!(
            access_now(&chat.key),
            Some(Access::Auto),
            "nothing of a stop was done"
        );
        assert_eq!(chat.completing(), None);
        // The chat can be completed again, and now the index takes the tick.
        assert_eq!(chat.complete().state, "started");
        assert_eq!(chat.full_stop(true), Some(true));
        assert!(chat.row().is_done());

        // A chat deleted during its wrap-up has no row to tick, which is the
        // same answer.
        let chat = Listed::new(false);
        let tap = Tap::on(&chat.id);
        chat.complete();
        crate::chat_index::remove(&chat.id).unwrap();
        assert_eq!(chat.full_stop(true), Some(false));
        assert_eq!(
            said(&tap).last().map(String::as_str),
            Some("completed The chat could not be marked done: it is not in the chat index. Its agent was left running.")
        );
        assert!(chat.live());
        assert!(running(&chat.session));
    }

    /// M1. `chat-completing` is said in the step that records the
    /// completion, so whatever ends it is said after, and both name the
    /// wrap-up turn.
    #[test]
    fn a_completion_is_announced_before_anything_can_end_it() {
        // The ✕ on a queued wrap-up.
        let chat = Listed::new(true);
        let tap = Tap::on(&chat.id);
        let completing = chat.complete();
        assert_eq!(
            chat_cancel_queued_impl(&chat.manager, chat.key.clone(), completing.turn_id.clone()),
            Ok(true)
        );
        assert_eq!(said(&tap), ["completing queued", "completed cancelled"]);
        assert_eq!(
            turns_named(&tap),
            [completing.turn_id.clone(), completing.turn_id]
        );

        // A wrap-up that cannot be written ends the completion it had
        // announced, with the error the caller is answered with.
        let chat = Listed::new(false);
        let tap = Tap::on(&chat.id);
        chat.session.lock().unwrap().stdin.take();
        let refused = chat_complete_impl(&chat.manager, &chat.key, "wrap up").unwrap_err();
        assert_eq!(refused, "this chat does not take more input");
        assert_eq!(
            said(&tap),
            [
                "completing started".to_string(),
                format!("completed {refused}")
            ]
        );
        let named = turns_named(&tap);
        assert_eq!(named[0], named[1]);
        assert_eq!(chat.completing(), None);

        // So does a start that was claimed for a completion and failed.
        let chat = Listed::new(false);
        end_process(&chat.manager, &chat.key).unwrap();
        let tap = Tap::on(&chat.id);
        let turn_id = chat.manager.claim_completion(&chat.key).expect("a claim");
        chat.manager
            .settle_claimed_completion(&chat.key, &turn_id, &Err("no such folder".into()));
        assert_eq!(
            said(&tap),
            ["completing started", "completed no such folder"]
        );
        assert_eq!(turns_named(&tap), [turn_id.clone(), turn_id.clone()]);
        // And one that started says nothing more until the wrap-up ends.
        let turn_id = chat.manager.claim_completion(&chat.key).expect("a claim");
        chat.manager
            .settle_claimed_completion(&chat.key, &turn_id, &Ok(()));
        assert_eq!(said(&tap).len(), 3);
        assert_eq!(chat.completing(), Some(turn_id));
    }

    /// M1. A cancel racing the Complete it cancels: the event that the
    /// completion began used to be emitted after its locks were let go, so
    /// the cancel's `chat-completed` could be first on the bus.
    #[test]
    fn a_completion_racing_its_own_cancel_is_still_announced_first() {
        const ROUNDS: usize = 100;
        let chat = Listed::new(true);
        let tap = Tap::on(&chat.id);
        thread::scope(|scope| {
            let cancelling = scope.spawn(|| {
                let mut cancelled = 0;
                while cancelled < ROUNDS {
                    let taken_back = chat.completing().is_some_and(|turn_id| {
                        chat_cancel_queued_impl(&chat.manager, chat.key.clone(), turn_id)
                            == Ok(true)
                    });
                    if taken_back {
                        cancelled += 1;
                    } else {
                        thread::yield_now();
                    }
                }
            });
            for _ in 0..ROUNDS {
                until("the last completion was taken back", || {
                    chat.completing().is_none()
                });
                assert_eq!(chat.complete().state, "queued");
            }
            cancelling.join().unwrap();
        });

        let heard: Vec<(String, String)> = tap
            .heard()
            .into_iter()
            .filter(|(event, _)| event.starts_with("chat-complet"))
            .map(|(event, payload)| (event, payload["turnId"].as_str().unwrap().to_string()))
            .collect();
        assert_eq!(heard.len(), 2 * ROUNDS);
        for pair in heard.chunks(2) {
            assert_eq!(pair[0].0, "chat-completing", "{pair:?}");
            assert_eq!(pair[1].0, "chat-completed", "{pair:?}");
            assert_eq!(pair[0].1, pair[1].1, "one completion at a time");
        }
    }

    /// H2. Stop marks the session idle while the cut-off turn's own full
    /// stop is still to come. A Complete in that gap used to be written to
    /// the agent at once, and that late full stop then decided it: a clean
    /// one ticked the chat and stopped an agent that had wrapped nothing up,
    /// a failed one called the completion failed.
    #[test]
    fn a_complete_during_the_unwind_of_a_stop_waits_for_the_cut_off_turns_own_full_stop() {
        for cut_off_ended_cleanly in [true, false] {
            let chat = Listed::new(true);
            chat.session.lock().unwrap().answering = Some("user-0".into());
            let tap = Tap::on(&chat.id);
            chat.stop();
            assert!(!chat.busy(), "Stop reads idle at once");

            let completing = chat.complete();

            assert_eq!(completing.state, "queued");
            assert_eq!(
                chat.answering().as_deref(),
                Some("user-0"),
                "nothing was written into the gap"
            );
            assert_eq!(chat.queued(), [completing.turn_id.clone()]);

            // The cut-off turn's full stop decides nothing, however it
            // ended, and hands the wrap-up over like any queued message.
            assert_eq!(chat.full_stop(cut_off_ended_cleanly), None);
            assert_eq!(chat.completing(), Some(completing.turn_id.clone()));
            assert_eq!(chat.answering(), Some(completing.turn_id.clone()));
            assert!(chat.busy(), "the wrap-up is running");
            assert!(chat.queued().is_empty());
            assert!(!chat.row().is_done());
            assert!(chat.live());
            assert_eq!(said(&tap), ["completing queued"]);

            // Only the wrap-up's own full stop does.
            assert_eq!(chat.full_stop(true), Some(true));
            assert!(chat.row().is_done());
            assert!(!chat.live());
            assert_eq!(said(&tap), ["completing queued", "index", "completed ok"]);
            assert_eq!(
                turns_named(&tap),
                [completing.turn_id.clone(), completing.turn_id]
            );
        }

        // A wrap-up that then fails is not ticked by the clean stop before it.
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        let tap = Tap::on(&chat.id);
        chat.stop();
        chat.complete();
        assert_eq!(chat.full_stop(true), None);
        assert_eq!(chat.full_stop(false), Some(false));
        assert_eq!(said(&tap), ["completing queued", "completed failed"]);
        assert!(!chat.row().is_done());
        assert!(chat.live());
        assert!(running(&chat.session));
    }

    /// The unwind the last Stop left `process` in.
    fn owed(process: &Arc<Mutex<ChatSession>>) -> u64 {
        match process.lock().unwrap().cut_off {
            CutOff::Owed(unwind) => unwind,
            other => panic!("no Stop is being waited out: {other:?}"),
        }
    }

    /// What the end of a Stop's grace did (`grace_ran_out`).
    struct Grace {
        /// Whether this call ended the process.
        ended: bool,
        /// The queued turn the chat's next process was started with, and
        /// that process.
        carried: Option<(QueuedTurn, Arc<Mutex<ChatSession>>)>,
    }

    /// What the thread a Stop leaves behind does when it wakes, for the
    /// unwind it is given, with a stand-in where `start_session` would spawn
    /// the chat's next process.
    fn grace_runs_out_on(chat: &Listed, process: &Arc<Mutex<ChatSession>>, unwind: u64) -> Grace {
        let mut carried = None;
        let ended = grace_ran_out_with(
            &chat.manager,
            &chat.key,
            &chat.key,
            process,
            unwind,
            |turn| {
                // What a start leaves behind for a queued turn: a process
                // under the key, in that turn.
                let next = claude_session(true);
                {
                    let mut starting = next.lock().unwrap();
                    starting.answering = turn.turn_id.clone();
                    starting.user_turn_id = turn.turn_id.clone();
                }
                chat.start(next.clone())?;
                carried = Some((turn, next));
                Ok(())
            },
        );
        Grace { ended, carried }
    }

    /// The grace of the Stop this chat's process is waiting out is over.
    fn grace_runs_out(chat: &Listed) -> Grace {
        grace_runs_out_on(chat, &chat.session, owed(&chat.session))
    }

    /// How many waits Stops have asked for on this chat's manager.
    fn waits_asked(chat: &Listed) -> usize {
        chat.manager
            .unwind_probe
            .asked
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The next line a stand-in was sent on its stdin, which is the Stop.
    fn stop_sent(written: &mut impl std::io::BufRead) {
        let mut line = String::new();
        written.read_line(&mut line).expect("the stand-in's echo");
        let sent: Value = serde_json::from_str(&line).expect("a line of JSON");
        assert_eq!(sent["request"]["subtype"], "interrupt", "{line}");
    }

    /// Everything `written` still holds, to the end of the stream: the lines
    /// a stand-in was sent on its stdin and had not been read back yet.
    ///
    /// Only what it was sent, which is always a JSON object. A stand-in whose
    /// stdin closes a moment before it is killed gets as far as the test
    /// harness's own closing lines, and those are not.
    fn rest_of(written: &mut impl std::io::BufRead) -> Vec<Value> {
        let mut lines = Vec::new();
        let mut line = String::new();
        while written.read_line(&mut line).expect("the stand-in's echo") > 0 {
            if let Ok(sent) = serde_json::from_str::<Value>(&line) {
                if sent.is_object() {
                    lines.push(sent);
                }
            }
            line.clear();
        }
        lines
    }

    /// A Codex app-server stand-in with a turn in flight.
    fn codex_session() -> Arc<Mutex<ChatSession>> {
        let session = claude_session(true);
        {
            let mut codex = session.lock().unwrap();
            codex.agent = ChatAgent::Codex;
            codex.codex = Some(CodexAppSession {
                thread_id: "thread-1".into(),
                active_turn_id: Some("turn-1".into()),
                interrupt_when_started: false,
                next_request: 0,
                model: None,
                effort: None,
                access: Some(Access::Read),
                cwd: "/tmp".into(),
                workspace_roots: vec!["/tmp".into()],
                has_octiq_mcp: false,
            });
        }
        session
    }

    /// H2. Stop, Complete, then ✕ on the queued wrap-up: the completion is
    /// taken back and the chat is as the Stop left it.
    #[test]
    fn taking_back_a_wrap_up_queued_behind_a_stop_leaves_the_chat_as_the_stop_left_it() {
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        let tap = Tap::on(&chat.id);
        chat.stop();
        let completing = chat.complete();

        assert_eq!(
            chat_cancel_queued_impl(&chat.manager, chat.key.clone(), completing.turn_id.clone()),
            Ok(true)
        );

        assert_eq!(chat.completing(), None);
        assert_eq!(said(&tap), ["completing queued", "completed cancelled"]);
        // The cut-off turn's full stop ends that turn and nothing else.
        assert_eq!(chat.full_stop(true), None);
        assert!(!chat.busy());
        assert_eq!(chat.answering().as_deref(), Some("user-0"));
        assert!(chat.queued().is_empty());
        assert!(!chat.row().is_done());
        assert!(chat.live());
        assert_eq!(said(&tap).len(), 2);

        // And where that full stop never comes, the completion that was
        // taken back is not failed a second time when the process is ended.
        let chat = Listed::new(true);
        let tap = Tap::on(&chat.id);
        chat.stop();
        let completing = chat.complete();
        chat_cancel_queued_impl(&chat.manager, chat.key.clone(), completing.turn_id).unwrap();
        assert!(chat.busy());
        let grace = grace_runs_out(&chat);
        assert!(grace.ended);
        assert!(grace.carried.is_none());
        assert!(!chat.live());
        assert!(!chat.row().is_done());
        assert_eq!(said(&tap), ["completing queued", "completed cancelled"]);
    }

    /// H2, the same exposure in an ordinary send: written into the gap, the
    /// message became the turn the cut-off turn's full stop ended, and the
    /// agent worked on it with the session read as idle.
    #[test]
    fn a_message_sent_during_the_unwind_of_a_stop_waits_for_the_cut_off_turns_own_full_stop() {
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        chat.stop();

        chat.send("do this instead", "user-9");

        assert_eq!(
            chat.answering().as_deref(),
            Some("user-0"),
            "nothing was written into the gap"
        );
        assert_eq!(chat.queued(), ["user-9"]);
        // Handed over on the cut-off turn's full stop, and in flight until
        // its own.
        assert_eq!(chat.full_stop(false), None);
        assert_eq!(chat.answering().as_deref(), Some("user-9"));
        assert!(chat.busy());
        assert!(chat.queued().is_empty());
        assert_eq!(chat.full_stop(true), None);
        assert!(!chat.busy());

        // A second Stop inside the unwind, with nothing in flight, does not
        // end the wait for the first one's full stop.
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        chat.stop();
        chat.stop();
        assert!(chat.manager.unwinding(&chat.key));
        assert_eq!(chat.complete().state, "queued");
        assert_eq!(chat.answering().as_deref(), Some("user-0"));

        // With no Stop behind it, an idle chat takes a message at once.
        let chat = Listed::new(false);
        chat.send("hello", "user-1");
        assert_eq!(chat.answering().as_deref(), Some("user-1"));
        assert!(chat.queued().is_empty());
    }

    /// H2 for the agents whose Stop is the end of the process: Antigravity,
    /// and every command-line (one-shot) agent. There is nothing to unwind,
    /// and no older turn's full stop can reach the process that runs the
    /// wrap-up.
    #[test]
    fn a_stop_that_ends_the_process_leaves_no_turn_for_a_wrap_up_to_be_taken_for() {
        for (agent, stdin) in [(ChatAgent::Antigravity, true), (ChatAgent::Pi, false)] {
            assert!(relaunches_to_continue(agent), "{agent:?}");
            let chat = Listed::with(session_of(agent, stdin, true));
            chat.manager
                .remember_start(&chat.key, StartContext::for_test(agent, None));
            let tap = Tap::on(&chat.id);

            chat.stop();

            assert!(!chat.live(), "{agent:?}: its Stop ends the process");
            assert!(!chat.manager.unwinding(&chat.key), "{agent:?}");
            // No process: the caller starts the chat with the wrap-up as its
            // first message.
            assert_eq!(
                chat_complete_impl(&chat.manager, &chat.key, "wrap up"),
                Ok(None)
            );
            assert_eq!(chat.completing(), None);
            assert!(said(&tap).is_empty());
            let turn_id = chat.manager.claim_completion(&chat.key).expect("a claim");
            let newer = session_of(agent, stdin, true);
            newer.lock().unwrap().answering = Some(turn_id.clone());
            chat.start(newer.clone())
                .expect("the start it was claimed for");

            // Whatever the stopped process still says belongs to the turn it
            // was running: a full stop read late, and its stream closing.
            {
                let mut stopped = chat.session.lock().unwrap();
                let (wrap_up, _) =
                    end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut stopped, true);
                assert_eq!(wrap_up, None, "{agent:?}");
                chat.manager
                    .completion_cut_short(&chat.key, &stopped, COMPLETION_ENDED);
            }
            assert_eq!(chat.completing(), Some(turn_id.clone()), "{agent:?}");
            assert!(!chat.row().is_done());

            // The wrap-up's own full stop, in the process that ran it.
            let (wrap_up, _) = {
                let mut running = newer.lock().unwrap();
                end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true)
            };
            assert!(settle_wrap_up(
                &chat.manager,
                &chat.key,
                &newer,
                wrap_up.expect("the wrap-up's own full stop")
            ));
            assert!(chat.row().is_done(), "{agent:?}");
            assert!(!chat.live());
            assert_eq!(said(&tap), ["completing started", "index", "completed ok"]);
            assert_eq!(turns_named(&tap), [turn_id.clone(), turn_id]);
        }
    }

    /// H2 (review of 8cbcd0b). A Stop the agent does not honour within the
    /// grace ends its process. Nothing is written to it: the first queued
    /// message starts in the chat's next process and the rest wait behind
    /// it, so Stop still keeps the queue.
    #[test]
    fn a_stop_the_agent_does_not_honour_ends_its_process_and_the_queue_starts_in_the_next() {
        let (session, mut written) = super::tests::capturing_claude_session();
        let chat = Listed::with(session);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        chat.stop();
        stop_sent(&mut written);
        chat.send("do this instead", "user-9");
        chat.send("/status", "user-10");
        assert_eq!(chat.queued(), ["user-9", "user-10"]);
        let unwind = owed(&chat.session);

        let grace = grace_runs_out(&chat);

        assert!(grace.ended);
        assert!(exited(&chat.session), "the process that did not stop");
        assert_eq!(chat.session.lock().unwrap().cut_off, CutOff::Ended);
        let (turn, next) = grace.carried.expect("the first queued message");
        assert_eq!(turn.turn_id.as_deref(), Some("user-9"));
        assert_eq!(turn.text, "do this instead");
        assert!(chat.runs(&next), "it starts in the chat's next process");
        assert_eq!(chat.queued(), ["user-10"], "the rest wait behind it");
        assert!(!chat.manager.handoffs.lock().unwrap().contains(&chat.key));
        // The old process was sent nothing after the Stop.
        let sent = rest_of(&mut written);
        assert!(sent.is_empty(), "{sent:?}");
        assert_eq!(chat.answering().as_deref(), Some("user-0"));

        // Whatever the ended process still says ends nothing here: the
        // queue is its successor's.
        for clean in [false, true] {
            assert_eq!(chat.full_stop(clean), None);
        }
        assert_eq!(chat.queued(), ["user-10"]);
        assert!(next.lock().unwrap().busy);
        assert_eq!(next.lock().unwrap().answering.as_deref(), Some("user-9"));

        // The next process's own full stop hands the rest over.
        {
            let mut running = next.lock().unwrap();
            assert_eq!(
                end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true),
                (None, None)
            );
            assert_eq!(running.answering.as_deref(), Some("user-10"));
            assert!(running.busy);
        }
        assert!(chat.queued().is_empty());

        // One unwind, one ending.
        assert!(!grace_runs_out_on(&chat, &chat.session, unwind).ended);
        assert!(chat.runs(&next));
        assert!(running(&next));
    }

    /// With nothing waiting, the process is ended and that is all: the chat
    /// reads as any chat whose process has gone, and the next message is the
    /// page's to start it with.
    #[test]
    fn a_stop_that_is_not_honoured_with_nothing_waiting_only_ends_the_process() {
        let chat = Listed::new(true);
        chat.stop();
        assert!(chat.manager.unwinding(&chat.key));

        let grace = grace_runs_out(&chat);

        assert!(grace.ended);
        assert!(grace.carried.is_none());
        assert!(!chat.live());
        assert!(exited(&chat.session));
        assert!(!chat.manager.handoffs.lock().unwrap().contains(&chat.key));
        assert!(
            !chat.manager.unwinding(&chat.key),
            "the mark went with the process"
        );
        assert!(chat.manager.notification_ready(&chat.key));
        assert_eq!(
            chat_send_user_impl(
                chat.manager.clone(),
                chat.key.clone(),
                "hello again".into(),
                None,
                None,
                Some("user-1".into()),
                None,
            ),
            Err("no such chat".into())
        );
        assert!(chat.queued().is_empty());
    }

    /// The real start, for a chat nothing knows how to resume: the queue is
    /// not left waiting on a process that will never come, and the page is
    /// told the chat has none.
    #[test]
    fn a_queue_that_cannot_be_started_in_the_next_process_is_not_left_waiting() {
        let chat = Listed::new(true);
        let tap = Tap::on(&chat.id);
        chat.stop();
        chat.send("do this instead", "user-9");
        chat.send("/status", "user-10");

        assert!(grace_ran_out(
            &chat.manager,
            &chat.key,
            &chat.key,
            &chat.session,
            owed(&chat.session)
        ));

        assert!(!chat.live());
        assert!(chat.queued().is_empty());
        assert!(!chat.manager.handoffs.lock().unwrap().contains(&chat.key));
        let statuses: Vec<String> = tap
            .heard()
            .into_iter()
            .filter(|(event, _)| event == "chat-status")
            .map(|(_, payload)| payload["kind"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(statuses, ["error", "exit"]);
        let record = crate::transcript::since(&chat.key, 0);
        for turn in ["user-9", "user-10"] {
            assert!(
                record.iter().any(|frame| {
                    frame.event["type"] == "octiq_user_turn_delivery"
                        && frame.event["uuid"] == turn
                        && frame.event["state"] == "failed"
                }),
                "{turn} is told as not sent"
            );
        }
    }

    /// A wrap-up waiting behind a stopped turn is not carried into the next
    /// process: it was asked of the one that is gone. The completion fails
    /// once, in words the person can act on, and the messages around it are
    /// kept.
    #[test]
    fn a_wrap_up_waiting_behind_a_stop_that_is_not_honoured_fails_once_and_is_not_carried() {
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        let tap = Tap::on(&chat.id);
        chat.stop();
        chat.send("first this", "user-1");
        let completing = chat.complete();
        chat.send("then this", "user-2");
        assert_eq!(completing.state, "queued");
        assert_eq!(
            chat.queued(),
            ["user-1", completing.turn_id.as_str(), "user-2"]
        );

        let grace = grace_runs_out(&chat);

        assert!(grace.ended);
        let off = format!("completed {COMPLETION_STOP_NOT_HONOURED}");
        assert_eq!(said(&tap), ["completing queued", off.as_str()]);
        assert_eq!(
            turns_named(&tap),
            [completing.turn_id.clone(), completing.turn_id.clone()]
        );
        assert_eq!(chat.completing(), None);
        assert_eq!(chat.row().done_at, None);
        assert!(!chat.row().is_done());
        let (turn, next) = grace.carried.expect("the message ahead of the wrap-up");
        assert_eq!(turn.turn_id.as_deref(), Some("user-1"));
        assert_eq!(chat.queued(), ["user-2"], "the wrap-up went, alone");
        assert!(
            crate::transcript::since(&chat.key, 0).iter().any(|frame| {
                frame.event["type"] == "octiq_user_turn_delivery"
                    && frame.event["uuid"] == completing.turn_id.as_str()
                    && frame.event["state"] == "failed"
            }),
            "the wrap-up is told as not sent"
        );

        // The stopped turn's own clean full stop, read late, and its stream
        // closing say nothing more about it.
        assert_eq!(chat.full_stop(true), None);
        {
            let stopped = chat.session.lock().unwrap();
            chat.manager
                .completion_cut_short(&chat.key, &stopped, COMPLETION_ENDED);
        }
        assert_eq!(said(&tap).len(), 2);
        assert!(!chat.row().is_done());
        assert!(chat.runs(&next));

        // Completing again is a new completion, of the process running now.
        let again = chat.complete();
        assert_eq!(again.state, "queued");
        assert_ne!(again.turn_id, completing.turn_id);
        assert_eq!(chat.queued(), ["user-2", again.turn_id.as_str()]);

        // A wrap-up with nothing around it: the process is ended, nothing is
        // carried, and the chat can be completed again from no process.
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        let tap = Tap::on(&chat.id);
        chat.stop();
        let completing = chat.complete();
        let grace = grace_runs_out(&chat);
        assert!(grace.ended);
        assert!(grace.carried.is_none());
        assert!(!chat.live());
        assert!(chat.queued().is_empty());
        assert_eq!(said(&tap), ["completing queued", off.as_str()]);
        assert_eq!(
            turns_named(&tap),
            [completing.turn_id.clone(), completing.turn_id]
        );
        assert_eq!(chat.row().done_at, None);
        assert_eq!(
            chat_complete_impl(&chat.manager, &chat.key, "wrap up"),
            Ok(None)
        );
    }

    /// The review's first counter-example. A turn written after the grace
    /// into a Codex that had not stopped was answered with the turn it was
    /// already in, and the one full stop that followed was dropped as the
    /// stopped turn's: the session stayed busy and the chat Completing for
    /// good. Nothing is written now, so that full stop has nothing to be
    /// mistaken for, whichever agent sends it and however it ended.
    #[test]
    fn the_only_full_stop_after_the_grace_leaves_nothing_busy_and_nothing_completing() {
        for codex in [false, true] {
            let stopped = || {
                let chat = Listed::with(if codex {
                    codex_session()
                } else {
                    claude_session(true)
                });
                chat.session.lock().unwrap().answering = Some("user-0".into());
                chat.stop();
                chat
            };
            for clean in [false, true] {
                // A message.
                let chat = stopped();
                chat.send("do this instead", "user-9");
                let (_, next) = grace_runs_out(&chat).carried.expect("the message");
                assert_eq!(chat.full_stop(clean), None, "codex {codex}, clean {clean}");
                assert!(next.lock().unwrap().busy, "its own turn is in flight");
                assert_eq!(next.lock().unwrap().answering.as_deref(), Some("user-9"));
                // Its own full stop ends it, and the chat takes the next
                // message at once: nothing is left queueing behind a turn
                // that will never end.
                {
                    let mut running = next.lock().unwrap();
                    end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true);
                    assert!(!running.busy);
                }
                chat.send("and then", "user-11");
                assert_eq!(next.lock().unwrap().answering.as_deref(), Some("user-11"));
                assert!(chat.queued().is_empty());

                // A Complete.
                let chat = stopped();
                let tap = Tap::on(&chat.id);
                chat.complete();
                assert!(grace_runs_out(&chat).ended);
                assert_eq!(chat.full_stop(clean), None, "codex {codex}, clean {clean}");
                assert!(!chat.live());
                assert_eq!(chat.completing(), None);
                assert!(chat.queued().is_empty());
                assert!(!chat.row().is_done());
                assert_eq!(said(&tap).len(), 2, "{:?}", said(&tap));
            }
        }
    }

    /// The review's second counter-example. The stopped turn's clean full
    /// stop, arriving after the grace, closed a completion whose wrap-up had
    /// never run. It decides nothing now: not the completion that was
    /// waiting, and not one the person started afterwards.
    #[test]
    fn a_clean_full_stop_of_the_stopped_turn_after_the_grace_ticks_nothing() {
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        let tap = Tap::on(&chat.id);
        chat.stop();
        let first = chat.complete();
        assert!(grace_runs_out(&chat).ended);

        // The person completes it again: no process, so the chat is started
        // with a new wrap-up as its first message.
        assert_eq!(
            chat_complete_impl(&chat.manager, &chat.key, "wrap up"),
            Ok(None)
        );
        let turn_id = chat.manager.claim_completion(&chat.key).expect("a claim");
        let newer = claude_session(true);
        newer.lock().unwrap().answering = Some(turn_id.clone());
        chat.start(newer.clone())
            .expect("the start it was claimed for");

        // The old process's clean full stop, and its stream closing.
        assert_eq!(chat.full_stop(true), None);
        {
            let stopped = chat.session.lock().unwrap();
            chat.manager
                .completion_cut_short(&chat.key, &stopped, COMPLETION_ENDED);
        }
        assert_eq!(chat.completing(), Some(turn_id.clone()));
        assert!(!chat.row().is_done());
        assert!(chat.runs(&newer));
        assert!(running(&newer));
        assert!(newer.lock().unwrap().busy);

        // Only the new wrap-up's own full stop, in the process that ran it.
        let (wrap_up, _) = {
            let mut running = newer.lock().unwrap();
            end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true)
        };
        assert!(settle_wrap_up(
            &chat.manager,
            &chat.key,
            &newer,
            wrap_up.expect("the wrap-up's own full stop")
        ));
        assert!(chat.row().is_done());
        let off = format!("completed {COMPLETION_STOP_NOT_HONOURED}");
        assert_eq!(
            said(&tap),
            [
                "completing queued",
                off.as_str(),
                "completing started",
                "index",
                "completed ok"
            ]
        );
        assert_eq!(
            turns_named(&tap),
            [
                first.turn_id.clone(),
                first.turn_id,
                turn_id.clone(),
                turn_id
            ]
        );
    }

    /// The invariant itself: while a stopped turn's full stop is owed, no
    /// way of giving the agent a prompt writes one. A message, a wrap-up, a
    /// host continuation and a host notification all wait, and the one
    /// function every prompt goes through refuses whoever asks.
    #[test]
    fn nothing_is_written_to_a_process_that_still_owes_a_full_stop() {
        use crate::orchestration::inbox::{DeliveryState, Notification, RECEIPT_PREFIX};

        let (session, mut written) = super::tests::capturing_claude_session();
        let chat = Listed::with(session);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        chat.stop();
        stop_sent(&mut written);

        let note = Notification {
            id: format!("{RECEIPT_PREFIX}1"),
            run_id: "run_1".into(),
            from_chat_key: "chat:other".into(),
            target_chat_key: chat.key.clone(),
            source: "test".into(),
            kind: "instruction".into(),
            body: "Something happened.".into(),
            state: DeliveryState::Delivering,
            attempts: 0,
            coalesced: 0,
            created_at: 0,
            updated_at: 0,
            next_attempt_at: 0,
            last_error: None,
        };
        assert!(!chat.manager.notification_ready(&chat.key));
        assert_eq!(
            deliver_orchestration_notification(chat.manager.clone(), &note, Default::default()),
            Ok(false)
        );
        chat.send("a message", "user-1");
        assert_eq!(chat.complete().state, "queued");
        chat_continue_internal_impl(
            chat.manager.clone(),
            chat.key.clone(),
            "a continuation".into(),
        )
        .expect("it waits like the rest");
        assert_eq!(
            deliver_orchestration_notification(chat.manager.clone(), &note, Default::default()),
            Ok(false),
            "nor ahead of what is waiting"
        );
        for turn in [Some("user-x"), None] {
            let mut stopping = chat.session.lock().unwrap();
            assert_eq!(
                write_user_message_locked(&mut stopping, "anything", &[], turn),
                Err(STILL_STOPPING.into())
            );
        }
        assert_eq!(chat.answering().as_deref(), Some("user-0"));
        assert_eq!(chat.queued().len(), 2, "the continuation has no bubble");
        assert!(chat.manager.has_queued_turns(&chat.key));

        // Nor once the grace has run out: the process is ended instead, and
        // an ended process is refused the same way.
        assert!(grace_runs_out(&chat).ended);
        {
            let mut ended = chat.session.lock().unwrap();
            assert_eq!(
                write_user_message_locked(&mut ended, "anything", &[], Some("user-y")),
                Err(STILL_STOPPING.into())
            );
        }
        assert!(exited(&chat.session));
        let sent = rest_of(&mut written);
        assert!(sent.is_empty(), "{sent:?}");
    }

    /// The full stop and the end of the grace take the same session lock,
    /// so at the boundary exactly one of them acts: the waiting message is
    /// handed to the process that stopped after all, or that process is
    /// ended and the message carried to the next. Never both, never neither.
    #[test]
    fn a_full_stop_at_the_end_of_the_grace_is_one_outcome_never_a_dispatch_and_an_ending() {
        const ROUNDS: usize = 500;
        let manager = Arc::new(ChatManager::default());
        let run = uuid::Uuid::new_v4().simple().to_string();
        let (mut handed_over, mut ended) = (0, 0);
        for round in 0..ROUNDS {
            let key = format!("chat:boundary-{run}-{round}");
            let session = claude_session(true);
            session.lock().unwrap().answering = Some("user-0".into());
            hold(&manager, &key, session.clone());
            chat_interrupt_impl(&manager, key.clone()).expect("Stop");
            chat_send_user_impl(
                manager.clone(),
                key.clone(),
                "do this instead".into(),
                None,
                None,
                Some("user-1".into()),
                None,
            )
            .expect("a message behind the Stop");
            let unwind = owed(&session);

            // A third of the rounds each: a plain race, which the grace
            // mostly loses the session to having the session table to take
            // first, and one side or the other stepping back a little.
            let start = std::sync::Barrier::new(2);
            let (full_stop, (grace_ended, carried)) = thread::scope(|scope| {
                let reader = scope.spawn(|| {
                    start.wait();
                    if round % 3 == 1 {
                        thread::yield_now();
                    }
                    let mut running = session.lock().unwrap();
                    end_turn_locked(&manager, &key, &key, &mut running, true)
                });
                let sleeper = scope.spawn(|| {
                    start.wait();
                    if round % 3 == 2 {
                        thread::yield_now();
                    }
                    let mut carried = None;
                    let ended =
                        grace_ran_out_with(&manager, &key, &key, &session, unwind, |turn| {
                            carried = Some(turn);
                            Ok(())
                        });
                    (ended, carried)
                });
                (reader.join().unwrap(), sleeper.join().unwrap())
            });

            assert_eq!(full_stop, (None, None), "round {round}");
            assert!(!manager.has_queued_turns(&key), "round {round}: taken once");
            {
                let after = session.lock().unwrap();
                if grace_ended {
                    ended += 1;
                    let carried = carried.expect("the message goes to the next process");
                    assert_eq!(carried.turn_id.as_deref(), Some("user-1"), "round {round}");
                    assert_eq!(after.cut_off, CutOff::Ended, "round {round}");
                    assert_eq!(
                        after.answering.as_deref(),
                        Some("user-0"),
                        "round {round}: nothing was written to the process that was ended"
                    );
                    assert!(after.stdin.is_none(), "round {round}");
                    assert!(!manager.has_process(&key), "round {round}");
                } else {
                    handed_over += 1;
                    assert!(carried.is_none(), "round {round}: not carried as well");
                    assert_eq!(after.cut_off, CutOff::No, "round {round}");
                    assert_eq!(after.answering.as_deref(), Some("user-1"), "round {round}");
                    assert!(after.busy, "round {round}");
                    assert!(after.stdin.is_some(), "round {round}: not ended as well");
                    assert!(manager.has_process(&key), "round {round}");
                }
            }
            let _ = end_process(&manager, &key);
            crate::transcript::forget(&key);
        }
        assert_eq!(handed_over + ended, ROUNDS);
    }

    /// A second Stop inside an unwind is the same unwind: no second wait, no
    /// moved deadline, and the queue is kept.
    #[test]
    fn a_second_stop_inside_an_unwind_starts_no_second_wait() {
        let chat = Listed::new(true);
        chat.stop();
        let unwind = owed(&chat.session);
        // With nothing in flight, and again with a message waiting, which
        // reads as work in flight.
        chat.stop();
        chat.send("do this instead", "user-1");
        assert!(chat.busy());
        chat.stop();

        assert_eq!(owed(&chat.session), unwind, "still the first Stop's unwind");
        assert_eq!(waits_asked(&chat), 1);
        assert_eq!(chat.queued(), ["user-1"], "Stop keeps the queue");

        // And it is ended once.
        assert!(grace_runs_out_on(&chat, &chat.session, unwind).ended);
        assert!(!grace_runs_out_on(&chat, &chat.session, unwind).ended);
    }

    /// The wait behind one Stop does nothing for a later Stop of the same
    /// chat, in the same process or in the one after it.
    #[test]
    fn the_wait_behind_one_stop_does_nothing_for_a_later_stop_of_the_same_chat() {
        // The same process: Stop, its full stop, a new turn, Stop again.
        let chat = Listed::new(true);
        chat.stop();
        let first = owed(&chat.session);
        assert_eq!(chat.full_stop(false), None);
        chat.send("again", "user-1");
        assert!(chat.busy());
        chat.stop();
        let second = owed(&chat.session);
        assert_ne!(first, second);
        assert_eq!(waits_asked(&chat), 2);
        // The first Stop's thread wakes late. It is not its unwind.
        assert!(!grace_runs_out_on(&chat, &chat.session, first).ended);
        assert!(chat.runs(&chat.session));
        assert!(running(&chat.session));
        assert_eq!(owed(&chat.session), second);
        // The second Stop's own does act, once.
        assert!(grace_runs_out_on(&chat, &chat.session, second).ended);
        assert!(!grace_runs_out_on(&chat, &chat.session, second).ended);
        assert!(!chat.live());

        // Another process: Stop, the grace, the chat started again, Stop.
        let chat = Listed::new(true);
        chat.stop();
        let first = owed(&chat.session);
        assert!(grace_runs_out(&chat).ended);
        let restarted = chat.start_again().expect("the next message starts it");
        chat.stop();
        let second = owed(&restarted);
        assert_ne!(first, second);
        // Nothing the first wait could still name ends the new process.
        assert!(!grace_runs_out_on(&chat, &chat.session, first).ended);
        assert!(!grace_runs_out_on(&chat, &restarted, first).ended);
        assert!(chat.runs(&restarted));
        assert!(running(&restarted));
        assert_eq!(owed(&restarted), second);
        assert!(grace_runs_out_on(&chat, &restarted, second).ended);
        assert!(!chat.live());
    }

    /// The thread a Stop really leaves behind, on a grace short enough to
    /// wait for: it ends the process of a Stop that is not honoured, and
    /// when the full stop came in time it wakes to nothing of its own, even
    /// with the same process waiting out a later Stop by then.
    #[test]
    fn the_thread_behind_a_stop_acts_once_and_only_for_its_own_unwind() {
        use std::sync::atomic::Ordering;
        let chat = Listed::new(true);
        let over = || chat.manager.unwind_probe.over.load(Ordering::SeqCst);
        let wait = |grace: Option<Duration>| {
            *chat.manager.unwind_probe.grace.lock().unwrap() = grace;
        };

        // Honoured: the full stop comes inside the grace, and a later Stop
        // (with no thread of its own here) is waiting when the first wakes.
        wait(Some(Duration::from_secs(1)));
        chat.stop();
        assert_eq!(chat.full_stop(false), None);
        chat.send("again", "user-1");
        wait(None);
        chat.stop();
        let later = owed(&chat.session);
        until("the first Stop's wait is over", || over() == 1);
        assert!(chat.runs(&chat.session));
        assert!(running(&chat.session));
        assert_eq!(owed(&chat.session), later);

        // Not honoured: its own thread ends the process.
        assert_eq!(chat.full_stop(false), None);
        chat.send("and again", "user-2");
        wait(Some(Duration::from_millis(20)));
        chat.stop();
        until("the Stop's wait is over", || over() == 2);
        assert!(!chat.live());
        assert!(exited(&chat.session));
        assert_eq!(chat.session.lock().unwrap().cut_off, CutOff::Ended);
        assert_eq!(waits_asked(&chat), 3);
    }
}

/// A registered agent's own conversation and its removal (review of
/// 931b5f0, H4): a prompt and a removal never both go through.
#[cfg(test)]
mod leaving_tests {
    use super::tests::{capturing_claude_session, hold};
    use super::*;
    use crate::orchestration::agent_work::Departure;
    use crate::orchestration::OrchestrationStore;

    /// A lead registered in a roster of its own, with one conversation it
    /// leads: a live stand-in Claude that is idle, and what it is sent.
    struct Led {
        _dir: crate::test_dir::TestDir,
        roster: PathBuf,
        lead: crate::team::TeamAgent,
        manager: Arc<ChatManager>,
        store: OrchestrationStore,
        key: String,
        session: Arc<Mutex<ChatSession>>,
        written: std::io::BufReader<std::process::ChildStdout>,
    }

    impl Led {
        fn new() -> Self {
            let dir = crate::test_dir::TestDir::new("m2-leaving");
            let roster = dir.0.join("team.json");
            let lead = crate::team::save(
                &roster,
                serde_json::from_value(json!({
                    "name": "Lead", "role": "Leads", "agent": "claude", "model": "sonnet",
                }))
                .unwrap(),
            )
            .unwrap();
            let key = format!("chat:leaving-{}", uuid::Uuid::new_v4().simple());
            crate::team::record_lead(&roster, &key, &lead, "workspace", false).unwrap();
            let (session, written) = capturing_claude_session();
            session.lock().unwrap().busy = false;
            let manager = Arc::new(ChatManager::default());
            hold(&manager, &key, session.clone());
            Self {
                _dir: dir,
                roster,
                lead,
                manager,
                store: OrchestrationStore::default(),
                key,
                session,
                written,
            }
        }

        fn departure(&self) -> Departure<'_> {
            Departure {
                store: &self.store,
                chats: &self.manager,
            }
        }

        fn send(&self, text: &str, id: &str) -> Result<(), String> {
            chat_send_user_impl(
                self.manager.clone(),
                self.key.clone(),
                text.into(),
                None,
                None,
                Some(id.into()),
                None,
            )
        }

        fn registered(&self) -> bool {
            !crate::team::list(&self.roster, None, true)
                .unwrap()
                .is_empty()
        }

        /// Every prompt the stand-in was ever sent. Its input is closed, not
        /// the process killed, so it echoes what it still holds and ends.
        fn sent(mut self) -> Vec<String> {
            drop(self.session.lock().unwrap().stdin.take());
            let mut texts = Vec::new();
            let mut line = String::new();
            while std::io::BufRead::read_line(&mut self.written, &mut line).unwrap_or(0) > 0 {
                if let Ok(sent) = serde_json::from_str::<Value>(&line) {
                    if let Some(text) = sent.pointer("/message/content/0/text") {
                        texts.push(text.as_str().unwrap_or_default().to_owned());
                    }
                }
                line.clear();
            }
            texts
        }
    }

    impl Drop for Led {
        fn drop(&mut self) {
            let _ = end_process(&self.manager, &self.key);
            crate::transcript::forget(&self.key);
        }
    }

    /// A removal that does something of the test's after the agent's chats
    /// were looked at and found idle, and before the roster is written.
    struct Midway<'a, F: Fn()> {
        departure: Departure<'a>,
        then: F,
    }

    impl<F: Fn()> crate::team::Leave for Midway<'_, F> {
        fn leave(
            &self,
            agent: &crate::team::TeamAgent,
            chats: &[crate::team::OwnChat],
            write: &mut dyn FnMut() -> Result<(), String>,
        ) -> Result<(), String> {
            crate::team::Leave::leave(&self.departure, agent, chats, &mut || {
                (self.then)();
                write()
            })
        }
    }

    /// The reviewer's probe. The removal has looked at the lead's chat and
    /// found it idle; before the roster is written, the person's message
    /// arrives on another thread through the real send. It is refused in
    /// words that say why, nothing reaches the agent, and no turn is in
    /// flight in a conversation whose agent is gone.
    #[test]
    fn a_message_that_arrives_inside_a_removal_is_refused_and_nothing_is_written() {
        let led = Led::new();
        let answer = Mutex::new(None);
        let midway = Midway {
            departure: led.departure(),
            then: || {
                let sent = thread::scope(|scope| {
                    scope
                        .spawn(|| led.send("Previously prepared turn", "user-1"))
                        .join()
                        .unwrap()
                });
                *answer.lock().unwrap() = Some(sent);
            },
        };
        crate::team::delete_idle(&led.roster, &led.lead.id, &midway)
            .expect("the chat was idle when the removal looked");
        let refused = answer
            .lock()
            .unwrap()
            .take()
            .expect("the message was sent inside the removal")
            .expect_err("a prompt written inside a removal");
        assert_eq!(
            refused,
            "Lead is being removed, so this conversation takes no message right now. Nothing was sent. Send it again in a moment: if the removal is refused, the conversation carries on."
        );
        assert!(!led.registered(), "the removal went through");
        assert!(!led.manager.turn_in_flight(&led.key));
        assert!(!led.session.lock().unwrap().busy);
        // Gone, the conversation is the agent's no longer: nothing more is
        // written to it, and no process is started for it.
        let gone = "Lead was removed, and this was Lead's conversation: it takes no more messages. Nothing was sent. Start a new conversation with another agent.";
        assert_eq!(led.send("And another", "user-2"), Err(gone.into()));
        assert_eq!(led.manager.leaving_refusal(&led.key).as_deref(), Some(gone));
        assert_eq!(led.sent(), Vec::<String>::new());
    }

    /// The other order: the message first. Its turn is in flight when the
    /// removal looks, so the removal is the one refused, the agent stays,
    /// and the conversation goes on taking messages.
    #[test]
    fn a_turn_that_started_first_refuses_the_removal_and_the_chat_carries_on() {
        let led = Led::new();
        led.send("Do this", "user-1").unwrap();
        let refused =
            crate::team::delete_idle(&led.roster, &led.lead.id, &led.departure()).unwrap_err();
        assert_eq!(
            refused,
            format!(
                "Lead is in the middle of a turn in a conversation it leads ({}). Nothing was removed. Stop that turn or wait for it to end, then remove Lead.",
                led.key
            )
        );
        assert!(led.registered());
        assert_eq!(led.manager.leaving_refusal(&led.key), None, "called off");
        // The turn ends; the next message is written like any other.
        {
            let mut running = led.session.lock().unwrap();
            end_turn_locked(&led.manager, &led.key, &led.key, &mut running, true);
        }
        led.send("And this", "user-2").unwrap();
        assert_eq!(led.sent(), ["Do this", "And this"]);
    }

    /// A removal that fails after it marked and looked (here the roster
    /// cannot be written) calls the mark off: the idle chat it had marked
    /// takes the next message.
    #[test]
    fn a_removal_that_fails_leaves_the_chat_taking_messages() {
        struct Failing<'a>(Departure<'a>);
        impl crate::team::Leave for Failing<'_> {
            fn leave(
                &self,
                agent: &crate::team::TeamAgent,
                chats: &[crate::team::OwnChat],
                _write: &mut dyn FnMut() -> Result<(), String>,
            ) -> Result<(), String> {
                crate::team::Leave::leave(&self.0, agent, chats, &mut || {
                    Err("No space left on device".into())
                })
            }
        }
        let led = Led::new();
        let refused =
            crate::team::delete_idle(&led.roster, &led.lead.id, &Failing(led.departure()))
                .unwrap_err();
        assert!(
            refused.starts_with("Lead was not removed: the roster could not be written"),
            "{refused}"
        );
        assert!(led.registered());
        assert_eq!(led.manager.leaving_refusal(&led.key), None);
        led.send("Still here", "user-1").unwrap();
        assert!(led.manager.turn_in_flight(&led.key));
        assert_eq!(led.sent(), ["Still here"]);
    }

    /// What the removal's look calls working, beyond a turn in flight: a
    /// stopped turn whose full stop is owed, and anything queued. In doubt
    /// the agent is working and stays.
    #[test]
    fn a_stopped_turn_or_a_queued_message_counts_as_working() {
        let led = Led::new();
        led.send("Do this", "user-1").unwrap();
        led.send("Then this", "user-2").unwrap();
        chat_interrupt_impl(&led.manager, led.key.clone()).expect("Stop");
        assert!(!led.session.lock().unwrap().busy, "a Stop reads idle");
        let mark = led.manager.mark_leaving("Lead", &[led.key.clone()]);
        assert!(mark.working(&led.key));
        drop(mark);
        assert_eq!(led.manager.leaving_refusal(&led.key), None);
        let refused =
            crate::team::delete_idle(&led.roster, &led.lead.id, &led.departure()).unwrap_err();
        assert!(
            refused.starts_with("Lead is in the middle of a turn"),
            "{refused}"
        );
        assert!(led.registered());
    }

    /// Every way a prompt reaches an agent meets the mark: the one function
    /// they all write through, a message, a queued message handed over at a
    /// full stop, a host notification, a completion's wrap-up, and the start
    /// of a process. Nothing is written by any of them.
    #[test]
    fn every_writer_of_a_prompt_meets_the_mark() {
        use crate::orchestration::inbox::{DeliveryState, Notification, RECEIPT_PREFIX};

        let led = Led::new();
        let mark = led.manager.mark_leaving("Lead", &[led.key.clone()]);
        assert!(!mark.working(&led.key), "idle, so it is marked");
        let leaving = "Lead is being removed, so this conversation takes no message right now. Nothing was sent. Send it again in a moment: if the removal is refused, the conversation carries on.";

        // The write point itself.
        {
            let mut session = led.session.lock().unwrap();
            assert_eq!(
                write_user_message_locked(&mut session, "anything", &[], Some("user-0")),
                Err(leaving.into())
            );
            assert!(!session.busy);
            assert_eq!(session.answering, None);
        }
        // A message from the person.
        assert_eq!(led.send("A message", "user-1"), Err(leaving.into()));
        assert!(
            !durable_user_turn_exists(&led.key, "user-1").unwrap(),
            "refused before it was written down"
        );
        // A message that was already waiting when a turn reached its full
        // stop: handed over there, and refused there.
        led.manager
            .queue_turn(
                &led.key,
                QueuedTurn {
                    text: "A queued message".into(),
                    images: Vec::new(),
                    turn_id: Some("user-2".into()),
                    appended_turn_ids: Vec::new(),
                    recorded: false,
                    context: led.manager.queue_context(&led.key),
                },
            )
            .unwrap();
        {
            let mut session = led.session.lock().unwrap();
            let (_, refused) =
                end_turn_locked(&led.manager, &led.key, &led.key, &mut session, true);
            assert_eq!(refused.as_deref(), Some(leaving));
            assert!(!session.busy);
        }
        // A host notification.
        let note = Notification {
            id: format!("{RECEIPT_PREFIX}leaving"),
            run_id: "run_1".into(),
            from_chat_key: "chat:other".into(),
            target_chat_key: led.key.clone(),
            source: "test".into(),
            kind: "instruction".into(),
            body: "Something happened.".into(),
            state: DeliveryState::Delivering,
            attempts: 0,
            coalesced: 0,
            created_at: 0,
            updated_at: 0,
            next_attempt_at: 0,
            last_error: None,
        };
        assert_eq!(
            deliver_orchestration_notification(led.manager.clone(), &note, Default::default()),
            Err(leaving.into())
        );
        // A completion's wrap-up: the completion ends with the reason.
        assert_eq!(
            chat_complete_impl(&led.manager, &led.key, "wrap up").map(|_| ()),
            Err(leaving.into())
        );
        assert_eq!(led.manager.completing_turn(&led.key), None);
        // The start of a process for it, which a carried queue rides after
        // a Stop that was not honoured: refused before anything is spawned.
        let _ = end_process(&led.manager, &led.key);
        let started = start_session(
            led.manager.clone(),
            Voice {
                session_key: led.key.clone(),
                stream_key: led.key.clone(),
            },
            "/tmp".into(),
            ChatAgent::Claude,
            None,
            None,
            Some("A carried message".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            Some("user-3".into()),
            true,
            None,
        );
        assert_eq!(started, Err(leaving.into()));
        assert!(!led.manager.has_process(&led.key));

        // Called off, all of it goes through again.
        drop(mark);
        assert_eq!(led.manager.leaving_refusal(&led.key), None);
        assert_eq!(led.sent(), Vec::<String>::new());
    }
}

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
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
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
    let event = durable_user_event(turn_id, text, images);
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
/// cannot miss a schedule, cancellation, or dispatch result.
pub(crate) fn record_chat_event(key: &str, event: Value) {
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

fn fresh_turn_id(turn_id: Option<String>) -> String {
    turn_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| format!("octiq-user-{}", uuid::Uuid::new_v4()))
}

/// Delivery is owned by the backend, independently of provider acknowledgement.
/// In particular, a process connecting to its API already owns its prompt; that
/// prompt cannot still be offered as an editable queue entry.
fn record_delivery(key: &str, turn_id: Option<&str>, state: &str) {
    let Some(turn_id) = turn_id else { return };
    if turn_id.starts_with(crate::orchestration::inbox::RECEIPT_PREFIX) {
        return;
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
}

/// Tie each provider acknowledgement to its exact dispatched prompt. Text is
/// not an identity: identical follow-ups can be waiting at the same time.
fn stamp_user_turn_id(event: &mut Value, agent: ChatAgent, turn_id: Option<&str>) {
    let starts_turn = match agent {
        ChatAgent::Codex => event.get("type").and_then(Value::as_str) == Some("turn.started"),
        ChatAgent::Pi => event.get("type").and_then(Value::as_str) == Some("turn_start"),
        ChatAgent::Claude => {
            event.get("type").and_then(Value::as_str) == Some("user")
                && event.get("parent_tool_use_id").is_none_or(Value::is_null)
                && event.pointer("/message/content").is_some_and(|content| {
                    content.is_string()
                        || content.as_array().is_some_and(|blocks| {
                            !blocks.iter().any(|block| block["type"] == "tool_result")
                        })
                })
        }
    };
    if !starts_turn {
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
) {
    match disposition {
        OutputDisposition::Ignore => {}
        OutputDisposition::DiagnosticsOnly => {
            crate::diagnostics::record(agent, key, "stderr", &text);
            crate::safety_block::observe(agent, key, &text);
        }
        OutputDisposition::Visible => emit_status(
            agent,
            ChatStatus {
                key: key.to_string(),
                kind: "stderr".into(),
                text,
                code: None,
            },
        ),
    }
}

struct ChatSession {
    launch_id: String,
    /// A dispatched prompt still awaiting its provider acknowledgement.
    user_turn_id: Option<String>,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Whether this prompt has a durable canonical envelope. Internal
    /// agent-to-agent briefs are not person-visible messages.
    recorded: bool,
}

#[derive(Default)]
pub struct ChatManager {
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
}

impl ChatManager {
    pub(crate) fn with_saved_questions(path: std::path::PathBuf) -> Self {
        let auto_resume_path = path.with_file_name("auto-resumes.json");
        Self {
            questions: Arc::new(crate::question_store::QuestionStore::load(path)),
            auto_resumes: crate::auto_resume::Store::load(auto_resume_path),
            ..Self::default()
        }
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

    pub(crate) fn notification_ready(&self, key: &str) -> bool {
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
        if let Err(error) = self.persist_orchestration_context(session_key) {
            eprintln!("orchestration: could not save provider session: {error}");
        }
    }

    fn start_context(&self, session_key: &str) -> Option<StartContext> {
        self.starts.lock().ok()?.get(session_key).cloned()
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

    pub(crate) fn require_checkout_idle(&self, checkout: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let starts = self.starts.lock().map_err(|e| e.to_string())?;
        for key in sessions.keys() {
            let start = starts
                .get(key)
                .ok_or("A running chat has unknown workspace settings.")?;
            for path in std::iter::once(&start.cwd).chain(start.extra_dirs.iter().flatten()) {
                if crate::git_ops::workflow::overlaps(
                    checkout,
                    &crate::git_ops::workflow::checkout_identity(path)?,
                ) {
                    return Err(format!("Chat {key} is still using this checkout."));
                }
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
                let other = crate::git_ops::workflow::checkout_identity(path)?;
                if crate::git_ops::workflow::overlaps(checkout, &other) {
                    return Err(format!("Chat {key} is already using this checkout. Stop it or choose Worktree mode."));
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

    fn queue_turn(&self, key: &str, turn: QueuedTurn) -> Result<(), String> {
        let mut turns = self.queued_turns.lock().map_err(|e| e.to_string())?;
        let queue = turns.entry(key.to_string()).or_default();
        if turn.recorded {
            let position = queue
                .iter()
                .position(|waiting| !waiting.recorded)
                .unwrap_or(queue.len());
            queue.insert(position, turn);
        } else {
            queue.push_back(turn);
        }
        Ok(())
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
    fn has_queued_turns(&self, key: &str) -> bool {
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
        }
        next
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
        let at = queue
            .iter()
            .position(|turn| turn.turn_id.as_deref() == Some(turn_id))?;
        let cancelled = queue.remove(at);
        if queue.is_empty() {
            turns.remove(chat_key);
        }
        cancelled
    }

    /// Move one named message to the front of the queue it already belongs to.
    ///
    fn promote_queued_turn(&self, chat_key: &str, turn_id: &str) -> Option<String> {
        let mut turns = self.queued_turns.lock().ok()?;
        let queue = turns.get_mut(chat_key)?;
        let at = queue
            .iter()
            .position(|turn| turn.turn_id.as_deref() == Some(turn_id))?;
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
            .is_some_and(|queue| {
                queue
                    .iter()
                    .any(|turn| turn.turn_id.as_deref() == Some(turn_id))
            })
            .then(|| chat_key.to_string())
    }

    /// Ending a process deliberately is also the end of every turn waiting only
    /// for that process. Otherwise a later, unrelated resume could unexpectedly
    /// receive words the person meant to cancel.
    fn forget_queued_turns(&self, key: &str) {
        for turn in self.take_all_queued_turns(key) {
            record_delivery(key, turn.turn_id.as_deref(), "failed");
        }
    }

    /// Everything waiting, taken out in one go.
    fn take_all_queued_turns(&self, key: &str) -> Vec<QueuedTurn> {
        self.queued_turns
            .lock()
            .ok()
            .and_then(|mut turns| turns.remove(key))
            .map(Vec::from)
            .unwrap_or_default()
    }
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

fn cancel_auto_resume(manager: &ChatManager, key: &str, reason: &str) -> Result<bool, String> {
    let Some(entry) = manager.auto_resumes.cancel(key)? else {
        return Ok(false);
    };
    crate::auto_resume::announce_cancelled(&entry, reason);
    if let Err(why) = manager.auto_resumes.finish(&entry) {
        // `Cancelled` is already durable and the scheduler ignores it. Leaving
        // the tombstone for startup cleanup is safer than blocking the user.
        eprintln!("[chat] could not finish auto-resume cancellation for {key}: {why}");
    }
    Ok(true)
}

/// Explicit browser action from the quota banner.
pub fn chat_cancel_auto_resume_impl(manager: &ChatManager, key: String) -> Result<bool, String> {
    cancel_auto_resume(manager, &key, "cancelled by user")
}

/// Say that a queued message is not going to be sent after all.
///
/// Written down only when the turn itself was written down (see
/// `QueuedTurn::recorded`), but ALWAYS announced: the page that drew the
/// optimistic bubble is holding it whether the record ever heard of it or not,
/// and the bubble is what has to go.
fn announce_cancelled(key: &str, turn: &QueuedTurn) {
    let Some(turn_id) = turn.turn_id.as_deref() else {
        return;
    };
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
    cancel_auto_resume(&manager, &key, "superseded by a user message")?;
    crate::safety_block::forget_chat(&key);
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

fn cancel_question_work(manager: &ChatManager, key: &str) -> Result<(), String> {
    let records = manager.questions.outbox()?;
    manager.questions.cancel_chat(key)?;
    for record in records
        .into_iter()
        .filter(|r| r.origin.chat_key == key || r.origin.session_key == key)
    {
        if let Some(turn) = manager.cancel_queued_turn(&record.origin.chat_key, &record.turn_id()) {
            announce_cancelled(&record.origin.chat_key, &turn);
        }
    }
    Ok(())
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
    let origin = &record.origin;
    let start = manager
        .start_context(&origin.session_key)
        .unwrap_or_else(|| origin.start.clone());
    if start.agent != origin.start.agent || start.session_id != origin.start.session_id {
        return Err("This conversation now uses a different agent session. Your answers are saved; continue from them in the chat.".into());
    }
    if origin.session_key != origin.chat_key {
        return Err("Answers for removed additional agents are saved, but cannot be delivered automatically. Continue from them in the chat.".into());
    }
    let text = record.continuation();
    match chat_send_with_user_turn(
        manager.clone(),
        origin.chat_key.clone(),
        text.clone(),
        None,
        None,
        Some(record.turn_id()),
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
        Some(record.turn_id()),
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
                    .is_some_and(|q| {
                        q.iter()
                            .any(|t| t.turn_id.as_deref() == Some(&record.turn_id()))
                    });
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
    manager.questions.cancel(ids)?;
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
) -> Result<(), String> {
    let result =
        start_queued_command_turn_inner(manager.clone(), session_key, stream_key, turn.clone());
    // Failure cleanup belongs to this handoff, before a new send can start.
    let _sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    if result.is_err() {
        record_delivery(stream_key, turn.turn_id.as_deref(), "failed");
        manager.forget_queued_turns(session_key);
    }
    manager
        .handoffs
        .lock()
        .map_err(|e| e.to_string())?
        .remove(session_key);
    result
}

fn start_queued_command_turn_inner(
    manager: Arc<ChatManager>,
    session_key: &str,
    stream_key: &str,
    turn: QueuedTurn,
) -> Result<(), String> {
    let start = manager
        .start_context(session_key)
        .ok_or_else(|| format!("nothing here knows how to resume '{session_key}'"))?;
    if provider_for(start.agent)
        .capabilities()
        .input
        .accepts_stdin()
    {
        return Err(format!("'{session_key}' no longer uses command-line turns"));
    }
    let QueuedTurn {
        text,
        images,
        turn_id,
        // Already in the transcript — that is what `recorded` means, and it is
        // why `start_session` below is told not to write it a second time.
        recorded: _,
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
    if sessions.contains_key(&session_key)
        || ((record_user_turn || notification_start)
            && manager
                .handoffs
                .lock()
                .map_err(|e| e.to_string())?
                .contains(&session_key))
    {
        return Err(format!("chat '{session_key}' is already running"));
    }

    manager.orchestrations.require_workspace_access(
        &session_key,
        &cwd,
        access != Some(Access::Read),
    )?;
    for path in extra_dirs.iter().flatten() {
        manager.orchestrations.require_workspace_access(
            &session_key,
            path,
            access != Some(Access::Read),
        )?;
    }

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
    let line = provider.build_command(&AgentCommand {
        model: model.as_deref(),
        access,
        prompt: &wire_prompt,
        resume: resume.as_deref(),
        extra_dirs: &extras,
        effort: effort.as_deref(),
        images: &images,
        lite: lite.unwrap_or(false),
        mcp_config: mcp.as_deref(),
        persistent_authorizations: authorizations.as_deref(),
        orchestration_worker,
    });
    let process_cwd = if cwd.trim().is_empty() {
        std::env::var("HOME").unwrap_or_else(|_| "/".into())
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
        crate::agent_provider::codex_developer_instructions(
            selected_model.as_deref(),
            selected_effort.as_deref(),
            access,
            authorizations.as_deref(),
            true,
            orchestration_worker,
        )
    });

    // Login shell, for PATH — see the module docs.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let launch_id = uuid::Uuid::new_v4().to_string();
    let mut child = Command::new(&shell)
        .args(["-lc", &format!("exec {line}")])
        .current_dir(&process_cwd)
        // The project's own environment, so a chat agent picks up the same
        // variables a terminal in this project would (e.g. `starfall`'s
        // `CLAUDE_CONFIG_DIR`). Applied first so every var this backend sets
        // below always wins if a project happened to name the same key.
        .envs(crate::workspaces::resolved_env(&env.unwrap_or_default()))
        // The selected provider declares whether it owns a persistent stdin
        // protocol. A command-line provider must receive EOF immediately so a
        // one-shot CLI does not wait for a second prompt.
        // The hook answers only for agents we started, and needs to know
        // which chat is asking so the UI can attach the question to it.
        .env("OCTIQ_CHAT_KEY", &key)
        .env("OCTIQ_SESSION_KEY", &session_key)
        .env("OCTIQ_LAUNCH_ID", &launch_id)
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
    }));
    sessions.insert(session_key.clone(), session.clone());
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

    // stdout: one JSON object per line, passed through as-is.
    {
        let key = key.clone();
        let session_key = session_key.clone();
        let stream_provider = provider;
        let asking = session.clone();
        // The runtime the answer will be waited on. Captured HERE, on the thread
        // that still has one: `chat_start` is called from an async handler, the
        // reader below is a plain thread, and `Handle::current()` panics there.
        // Absent only on the desktop build, which has no server runtime — see
        // `answer_permission`.
        let rt = tokio::runtime::Handle::try_current().ok();
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
                                let Some(normalized) =
                                    crate::codex_app_server::normalize_notification(&event)
                                else {
                                    continue;
                                };
                                event = normalized;
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
                            if let Ok(mut s) = asking.lock() {
                                reading.questions.detach_launch(&s.launch_id);
                                if let Some(codex) = s.codex.as_mut() {
                                    codex.active_turn_id = None;
                                }
                                s.turn_ended();
                                if stream_provider.capabilities().input.accepts_stdin() {
                                    if let Some(turn) = reading.take_queued_turn(&session_key) {
                                        refused = write_user_message_locked(
                                            &mut s,
                                            &turn.text,
                                            &turn.images,
                                            turn.turn_id.as_deref(),
                                        )
                                        .err();
                                        record_delivery(
                                            &key,
                                            turn.turn_id.as_deref(),
                                            if refused.is_some() {
                                                "failed"
                                            } else {
                                                "dispatched"
                                            },
                                        );
                                    }
                                }
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
                    }
                    // A non-JSON line means the agent printed something we did
                    // not ask for (a login prompt, an update notice). Surface it
                    // rather than dropping it — it is usually the reason a chat
                    // produced nothing. The one exception is below.
                    Err(_) => emit_unstructured_output(
                        stream_provider.kind(),
                        &key,
                        trimmed.to_string(),
                        stream_provider.classify_output(trimmed, &mut output_state),
                    ),
                }
            }
            // Drain stdout before deciding: the final buffered line may be the
            // receipt. A killed/replaced launch must not stay "dispatched"
            // forever, nor imply its words reached the provider's history.
            if let Ok(mut session) = asking.lock() {
                reading.questions.detach_launch(&session.launch_id);
                record_delivery(&key, session.user_turn_id.take().as_deref(), "unknown");
            }
        });
    }

    // stderr is normally worth showing. A provider can classify known internal
    // recovery details as diagnostics-only without losing them from the local
    // error journal.
    {
        let key = key.clone();
        let stderr_provider = provider;
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut output_state = OutputState::default();
            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let disposition = stderr_provider.classify_output(&line, &mut output_state);
                emit_unstructured_output(stderr_provider.kind(), &key, line, disposition);
            }
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
                        let queued_turn =
                            if provider_for(agent).capabilities().input.accepts_stdin() {
                                manager_for_exit.forget_queued_turns(&session_key_for_exit);
                                None
                            } else {
                                manager_for_exit.take_queued_turn(&session_key_for_exit)
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

            // A command-line provider has no second-input channel. If somebody
            // sent a message after its full-stop but before this reaper saw the
            // exit, carry it into the next resume command instead. Keep the
            // UI's running state alive across that handoff: an `exit` here
            // would make a second quick message race the replacement.
            if was_current && !provider_for(agent).capabilities().input.accepts_stdin() {
                if let Some(turn) = queued_turn {
                    match start_queued_command_turn(
                        manager_for_exit.clone(),
                        &session_key_for_exit,
                        &key,
                        turn,
                    ) {
                        Ok(()) => return,
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
    session.turn_started();
    Ok(())
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
    cancel_auto_resume(&manager, &key, "superseded by a user message")?;
    // A safety block is a choice about the NEXT user turn, not a tool call
    // OctiqFlow can resume. Any words the person sends supersede that card —
    // including the two explicit continuations the card itself offers.
    crate::safety_block::forget_chat(&key);
    let user_turn_id = (record_user != Some(false)).then(|| fresh_turn_id(turn_id));
    chat_send_with_user_turn(manager, key, text, images, to, user_turn_id)
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
            if session.busy
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

fn chat_send_with_user_turn(
    manager: Arc<ChatManager>,
    key: String,
    text: String,
    images: Option<Vec<String>>,
    to: Option<String>,
    user_turn_id: Option<String>,
) -> Result<(), String> {
    if to.is_some() {
        return Err("additional agents are no longer supported".into());
    }
    if let Some(start) = manager.start_context(&key) {
        manager.orchestrations.require_workspace_access(
            &key,
            &start.cwd,
            start.access != Some(Access::Read),
        )?;
        for path in start.extra_dirs.iter().flatten() {
            manager.orchestrations.require_workspace_access(
                &key,
                path,
                start.access != Some(Access::Read),
            )?;
        }
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
        let Some(session) = sessions.get(&session_key).cloned() else {
            if manager
                .handoffs
                .lock()
                .map_err(|e| e.to_string())?
                .contains(&session_key)
            {
                manager.queue_turn(
                    &session_key,
                    QueuedTurn {
                        text: text.clone(),
                        images: images.clone(),
                        turn_id: user_turn_id.clone(),
                        recorded: user_turn_id.is_some(),
                    },
                )?;
                if let Some(turn_id) = user_turn_id.as_deref() {
                    record_durable_user_turn(&key, turn_id, &text, &images);
                    record_delivery(&key, Some(turn_id), "queued");
                }
                return Ok(());
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
        {
            let mut guard = session.lock().map_err(|e| e.to_string())?;
            let one_shot = !provider_for(guard.agent)
                .capabilities()
                .input
                .accepts_stdin();
            if one_shot || guard.busy || manager.has_queued_turns(&session_key) {
                // Every provider gets the same durable queue envelope. Native
                // echoes reconcile by the exact turn id when it is dispatched.
                manager.queue_turn(
                    &session_key,
                    QueuedTurn {
                        text: text.clone(),
                        images: images.clone(),
                        turn_id: user_turn_id.clone(),
                        recorded: user_turn_id.is_some(),
                    },
                )?;
                if let Some(turn_id) = user_turn_id.as_deref() {
                    record_durable_user_turn(&key, turn_id, &text, &images);
                    record_delivery(&key, Some(turn_id), "queued");
                }
                // A queued turn is still work the person is waiting for. This also
                // prevents the idle sweeper from ending the process in the handoff
                // before its reaper starts the resume.
                guard.turn_started();
                return Ok(());
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
            result
        }
    }
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
        // The one-shot reaper is already carrying it into the next process.
        return Ok(false);
    };
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    if manager.promote_queued_turn(&key, &turn_id).as_deref() != Some(session_key.as_str()) {
        return Ok(false);
    }

    let agent = guard.agent;
    if provider_for(agent).capabilities().input.accepts_stdin() {
        interrupt_persistent_turn(&mut guard)?;
        record_delivery(&key, Some(&turn_id), "starting");
        return Ok(true);
    }

    // A command-line provider cannot be interrupted over stdin. Remove this
    // exact process while the sessions lock still fences its reaper, carry the
    // promoted turn across the kill, then resume it outside the locks.
    let Some(next) = manager.take_queued_turn(&session_key) else {
        return Ok(false);
    };
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

    if let Err(why) = start_queued_command_turn(manager.clone(), &session_key, &key, next) {
        return Err(format!("could not resume queued message: {why}"));
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
fn interrupt_session(
    manager: &Arc<ChatManager>,
    session_key: &str,
    stream_key: &str,
) -> Result<(), String> {
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(session_key).cloned().ok_or("no such chat")?
    };
    let agent = {
        let guard = session.lock().map_err(|e| e.to_string())?;
        guard.agent
    };
    // Command-line providers cannot receive a control message after startup.
    // Remove and kill their current one-shot process, but deliberately leave
    // `StartContext` intact so the next user turn can resume it.
    if !provider_for(agent).capabilities().input.accepts_stdin() {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if !sessions
            .get(session_key)
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            return Ok(());
        }
        let mut guard = session.lock().map_err(|e| e.to_string())?;
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
            start_queued_command_turn(manager.clone(), session_key, stream_key, next)
                .map_err(|why| format!("could not resume queued message: {why}"))?;
        }
        return Ok(());
    }

    let mut guard = session.lock().map_err(|e| e.to_string())?;
    interrupt_persistent_turn(&mut guard)
}

pub fn chat_interrupt_impl(manager: &Arc<ChatManager>, key: String) -> Result<(), String> {
    cancel_auto_resume(manager, &key, "cancelled when the user stopped the chat")?;
    let _delivery = manager
        .questions
        .delivery_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let cancelled = cancel_question_work(manager, &key);
    interrupt_session(manager, &key, &key)?;
    cancelled
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
    };
    let Some(rt) = rt else {
        write_codex_response(session, &request_id, json!({ "decision": "decline" }));
        return;
    };
    let session = session.clone();
    rt.spawn(async move {
        let answer = crate::permission::ask(ask).await;
        let decision = if answer.decision == "allow" {
            "accept"
        } else {
            "decline"
        };
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
    };

    let tool = ask.tool_name.clone().unwrap_or_default();
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
        let answer = crate::permission::ask(ask).await;
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
    if let Some(start) = manager.start_context(&key) {
        for path in std::iter::once(&start.cwd).chain(start.extra_dirs.iter().flatten()) {
            manager
                .orchestrations
                .require_workspace_access(&key, path, access != Access::Read)?;
        }
    }
    cancel_auto_resume(manager, &key, "cancelled when access changed")?;
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&key).cloned().ok_or("no such chat")?
    };
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let provider = provider_for(guard.agent);
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
        manager.persist_orchestration_context(&key)?;
        return Ok(());
    }
    if !provider.capabilities().supports_live_access_change {
        if let Some(mut start) = manager.start_context(&key) {
            start.access = Some(access);
            manager.remember_start(&key, start);
        }
        return manager.persist_orchestration_context(&key);
    }
    if matches!(access, Access::Full) {
        return Err("Full access needs a fresh agent".into());
    }
    let payload = provider
        .access_change_payload(access)
        .ok_or("this chat does not take more input")?;
    let stdin = guard
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    if let Some(mut start) = manager.start_context(&key) {
        start.access = Some(access);
        manager.remember_start(&key, start);
    }
    manager.persist_orchestration_context(&key)
}

/// Stop a chat and drop it. Killing an unknown key is a no-op success, so the
/// UI can close a chat twice without caring.
pub fn chat_stop_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    cancel_auto_resume(manager, &key, "cancelled when the chat stopped")?;
    let _delivery = manager
        .questions
        .delivery_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let cancelled = cancel_question_work(manager, &key);
    // Anything the person allowed "always" was allowed for THIS piece of work.
    // Outliving it would be a permission nobody remembers giving.
    crate::permission::forget_chat(&key);
    crate::safety_block::forget_chat(&key);
    with_access(|a| a.remove(&key));
    end_process(manager, &key)?;
    cancelled
}

/// End only the host provider process so the same application conversation can
/// continue on another model. The old native session cannot be resumed by the
/// backend during the handoff; the next browser send supplies a fresh start
/// context for the selected provider. Permissions, access, and the transcript
/// belong to the user conversation and remain intact.
pub fn chat_retarget_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    cancel_auto_resume(manager, &key, "cancelled when the agent changed")?;
    end_process(manager, &key)?;
    manager
        .starts
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&key);
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

/// End one chat process while preserving its transcript and remembered settings.
///
/// Unlike stopping a chat, this intentionally retains standing permissions and
/// access settings so the next message can resume the same work. Any queued
/// queued follow-up is discarded: the person explicitly ended the process it
/// was waiting on.
fn end_process(manager: &ChatManager, key: &str) -> Result<bool, String> {
    let session = {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(key)
    };
    // Removal from the session map happens before clearing the queue, so a
    // concurrent send cannot add a new deferred turn after this cleanup.
    manager.forget_queued_turns(key);
    let Some(session) = session else {
        return Ok(false);
    };
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    // Closing stdin asks persistent providers to finish; kill is the backstop.
    guard.stdin.take();
    let _ = guard.child.kill();
    Ok(true)
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
        if end_process(manager, &key) == Ok(true) {
            ended.push(key);
        }
    }
    ended
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
fn attachments_dir() -> Result<std::path::PathBuf, String> {
    let dir = crate::paths::home_dir()
        .ok_or("could not find your home folder")?
        .join(".octiqflow")
        .join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make {dir:?}: {e}"))?;
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
    crate::chat_index::list()
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
fn announce_index_change(id: &str, gone: bool) {
    crate::bus::emit(
        "chat-index-changed",
        serde_json::json!({ "id": id, "gone": gone }),
    );
}

/// Record a chat, or update what is known about it.
pub fn chat_index_save(meta: crate::chat_index::ChatMeta) -> Result<(), String> {
    let id = meta.id.clone();
    crate::chat_index::upsert(meta)?;
    // Only once it is actually on disk. Announcing a write that failed would
    // send every other device to fetch a list that has not changed.
    announce_index_change(&id, false);
    Ok(())
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

/// A transcript without an acknowledgement is not proof that a prompt is
/// still queued: queues are held in memory and do not survive a server restart.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatQueueState {
    live: bool,
    queued_turn_ids: Vec<String>,
}

pub fn chat_queue_state_impl(manager: &ChatManager, key: &str) -> Result<ChatQueueState, String> {
    // Match the send/reaper lock order, so an enqueue cannot cross this read.
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let handoffs = manager.handoffs.lock().map_err(|e| e.to_string())?;
    let queues = manager.queued_turns.lock().map_err(|e| e.to_string())?;
    Ok(ChatQueueState {
        live: sessions.contains_key(key) || handoffs.contains(key),
        queued_turn_ids: queues
            .get(key)
            .into_iter()
            .flat_map(|turns| turns.iter().filter_map(|turn| turn.turn_id.clone()))
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
                        recorded: true,
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
                        recorded,
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
    fn a_running_chat_reports_the_pid_its_memory_hangs_off() {
        // `memory.rs` charges every process under this pid to this chat, which
        // is the only way an agent's own MCP servers land on the chat that
        // started them rather than on the server.
        let manager = Arc::new(ChatManager::default());
        let key = format!("mem-{}", uuid::Uuid::new_v4().simple());
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .spawn()
            .expect("a stand-in agent");
        let pid = child.id() as i32;
        manager.sessions.lock().unwrap().insert(
            key.clone(),
            Arc::new(Mutex::new(ChatSession {
                launch_id: "test-launch".into(),
                user_turn_id: None,
                child,
                stdin: None,
                codex: None,
                agent: ChatAgent::Claude,
                busy: false,
                last_active: Instant::now(),
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
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .spawn()
            .expect("a Codex stand-in");
        manager.sessions.lock().unwrap().insert(
            key.clone(),
            Arc::new(Mutex::new(ChatSession {
                launch_id: "test-launch".into(),
                user_turn_id: None,
                child,
                stdin: None,
                codex: None,
                agent: ChatAgent::Codex,
                busy: true,
                last_active: Instant::now(),
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

    /// A persistent-provider session with a REAL pipe on its stdin, so a write
    /// that should not have happened has somewhere to go rather than failing
    /// for the wrong reason and passing the test anyway.
    fn claude_session(busy: bool) -> Arc<Mutex<ChatSession>> {
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("a cat to stand in for Claude");
        let stdin = child.stdin.take();
        Arc::new(Mutex::new(ChatSession {
            launch_id: "test-launch".into(),
            user_turn_id: None,
            child,
            stdin,
            codex: None,
            agent: ChatAgent::Claude,
            busy,
            last_active: Instant::now(),
        }))
    }

    fn hold(manager: &ChatManager, key: &str, session: Arc<Mutex<ChatSession>>) {
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
                recorded: true,
            })
        );
        let events = crate::transcript::since(&key, 0);
        assert_eq!(events[0].event["uuid"], "user-1");
        assert_eq!(events[1].event["state"], "queued");

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
    fn starting_a_queued_message_promotes_that_exact_turn_and_interrupts_claude() {
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
        assert_eq!(order, ["send this now", "first"]);

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
            ["first", "second", "third"],
            "queued in the order sent"
        );
        end_process(&manager, &key).expect("end the stand-in");
        crate::transcript::forget(&key);
    }

    #[test]
    fn stopping_codex_keeps_its_queue_on_the_native_thread() {
        let manager = Arc::new(ChatManager::default());
        let key = "codex-stop-queue";
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("a Codex app-server stand-in");
        let stdin = child.stdin.take();
        let session = Arc::new(Mutex::new(ChatSession {
            launch_id: "test-launch".into(),
            user_turn_id: None,
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
                    recorded: true,
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
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .spawn()
            .expect("a Codex stand-in");
        hold(
            &manager,
            &key,
            Arc::new(Mutex::new(ChatSession {
                launch_id: "test-launch".into(),
                user_turn_id: None,
                child,
                stdin: None,
                codex: None,
                agent: ChatAgent::Codex,
                busy: true,
                last_active: Instant::now(),
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
                    recorded: true,
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
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("a Codex app-server stand-in");
        let stdin = child.stdin.take();
        let session = Arc::new(Mutex::new(ChatSession {
            launch_id: "test-launch".into(),
            user_turn_id: None,
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
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .spawn()
            .expect("a sleep to stand in for an agent");
        Arc::new(Mutex::new(ChatSession {
            launch_id: "test-launch".into(),
            user_turn_id: None,
            child,
            stdin: None,
            codex: None,
            agent: ChatAgent::Claude,
            busy,
            last_active: Instant::now()
                .checked_sub(ago)
                .expect("a clock with some run-up behind it"),
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
        let child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        manager.sessions.lock().unwrap().insert(
            key.clone(),
            Arc::new(Mutex::new(ChatSession {
                launch_id: "launch-1".into(),
                user_turn_id: None,
                child,
                stdin: None,
                codex: None,
                agent: ChatAgent::Codex,
                busy: true,
                last_active: Instant::now(),
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
        let path = std::env::temp_dir()
            .join(format!("octiq-question-recovery-{}", uuid::Uuid::new_v4()))
            .join("questions.json");
        let manager = Arc::new(ChatManager::with_saved_questions(path.clone()));
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
        let restored = Arc::new(ChatManager::with_saved_questions(path));
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
                    recorded: true,
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
        let mut child = Command::new("cat")
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
                child,
                stdin,
                codex: None,
                agent: ChatAgent::Claude,
                busy: false,
                last_active: Instant::now(),
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

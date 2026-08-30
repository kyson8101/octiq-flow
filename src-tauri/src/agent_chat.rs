//! Agent chat sessions: an agent run as a JSON STREAM instead of a terminal.
//!
//! The rest of this app drives agents through a PTY, which is what makes their
//! real TUI work. A TUI is the wrong source for a chat UI, though: what crosses
//! the wire is cursor moves and repaints, so there is no message to render — you
//! would be scraping pixels back into text.
//!
//! Both agents already offer the stream a chat UI actually wants:
//!
//! ```text
//! claude -p --output-format stream-json --input-format stream-json \
//!        --include-partial-messages --verbose
//! ```
//!
//! stdout is then one JSON object per line — `assistant` messages (text,
//! thinking and tool_use blocks), `user` messages carrying tool results,
//! `stream_event` deltas while a reply is still being written, and a final
//! `result` with cost and duration. stdin takes user messages in the same
//! shape, so one process serves a whole conversation.
//!
//! This module owns those processes: spawn one per chat, read its stdout line
//! by line, and re-emit each line as a `chat-event`. Nothing here interprets
//! the JSON — the shapes are the agent's, and a UI that knows them should not
//! have to wait for a Rust change to see a new field.
//!
//! No PTY: this is a plain piped child. It is launched through a LOGIN SHELL
//! all the same, for the reason pty.rs does it — a GUI app does not inherit the
//! interactive shell's PATH, so `claude` would simply not be found.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::agent_provider::{ask_mcp_config, provider_for, AgentCommand};
pub(crate) use crate::agent_provider::{safe_model, safe_session_id};
pub use crate::agent_provider::{Access, AgentKind as ChatAgent};

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

struct ChatSession {
    child: Child,
    stdin: Option<ChildStdin>,
    /// Which program this is. Only Claude has a control channel, so a setting
    /// changed part-way through a chat has to know before it writes one.
    agent: ChatAgent,
    /// A turn is in flight: this process was given something and has not
    /// reached its own full stop yet.
    ///
    /// The idle sweeper is built on this rather than on "no output lately",
    /// and the difference is the whole reason the flag exists. An agent
    /// running a twenty-minute build says NOTHING while it waits — no partial
    /// message, no tool event, nothing — so a sweeper reading silence would
    /// kill the one turn nobody could afford to lose. A turn is also still in
    /// flight while a permission card or an `ask_user` question sits on
    /// screen, and both of those are minutes of quiet by design.
    busy: bool,
    /// When this last started or finished a turn. Only read while `busy` is
    /// false, so it means "still since".
    last_active: Instant,
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

/// How an agent process was last started, so the backend can start it again.
///
/// Every one of these fields belongs to the client: the model came from the
/// picker, the folders from the project, the level from the access control. The
/// backend has never needed them, because the client has always been the thing
/// that starts a chat.
///
/// A room's host can be spoken to by the backend itself once the other agents
/// have answered (`round::ask_host`), after its process may have gone idle.
/// Codex seats need the same record for a different reason: each turn is a new
/// `resume` process, so a quick follow-up waits for the prior one to exit and
/// starts again with this context.
///
/// Kept in memory only. A backend restart loses it, and an agent whose process
/// has not been started since is simply not resumed — the words are all in the
/// transcript either way.
#[derive(Debug, Clone)]
pub(crate) struct StartContext {
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    extra_dirs: Option<Vec<String>>,
    effort: Option<String>,
    lite: Option<bool>,
    /// The agent's own id for this conversation, learned from its opening
    /// event. Restarting without it would hand the agent an empty memory and
    /// a brief about a discussion it had never heard of.
    session_id: Option<String>,
}

/// A follow-up for a command-line provider, held while its one-shot process
/// finishes exiting.
///
/// Persistent providers accept the next message on stdin. A command-line
/// provider instead starts a fresh resume command, so its attachment stays
/// with the next command rather than disappearing with the old process.
#[derive(Debug, Clone, PartialEq, Eq)]
struct QueuedCommandTurn {
    text: String,
    images: Vec<String>,
}

#[derive(Default)]
pub struct ChatManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<ChatSession>>>>,
    /// Only chats opened as rooms appear here. No entry means no room.
    ///
    /// Stored here because a seat that speaks needs a session and a round
    /// needs both at once — everything ELSE about a room lives in `chat_room`.
    pub(crate) rooms: Mutex<HashMap<String, crate::chat_room::Room>>,
    /// How each running agent was last started — see `StartContext`. Keyed by
    /// process key: a host and each resident seat resume independently.
    starts: Mutex<HashMap<String, StartContext>>,
    /// A command-line provider is deliberately one-shot. A follow-up sent
    /// while its previous process is still reaping waits here for its resumed
    /// process instead of being written to its intentionally absent stdin.
    queued_command_turns: Mutex<HashMap<String, VecDeque<QueuedCommandTurn>>>,
}

impl ChatManager {
    /// Remember how an agent was started, so it can be started that way again.
    fn remember_start(&self, session_key: &str, start: StartContext) {
        if let Ok(mut m) = self.starts.lock() {
            m.insert(session_key.to_string(), start);
        }
    }

    /// The agent named its own conversation. Kept so its next process can
    /// resume it rather than beginning a new one.
    fn remember_session(&self, session_key: &str, session_id: &str) {
        if let Ok(mut m) = self.starts.lock() {
            if let Some(start) = m.get_mut(session_key) {
                start.session_id = Some(session_id.to_string());
            }
        }
    }

    fn start_context(&self, session_key: &str) -> Option<StartContext> {
        self.starts.lock().ok()?.get(session_key).cloned()
    }

    fn queue_command_turn(&self, key: &str, turn: QueuedCommandTurn) -> Result<(), String> {
        self.queued_command_turns
            .lock()
            .map_err(|e| e.to_string())?
            .entry(key.to_string())
            .or_default()
            .push_back(turn);
        Ok(())
    }

    fn take_queued_command_turn(&self, key: &str) -> Option<QueuedCommandTurn> {
        let mut turns = self.queued_command_turns.lock().ok()?;
        let next = turns.get_mut(key)?.pop_front();
        if turns.get(key).is_some_and(VecDeque::is_empty) {
            turns.remove(key);
        }
        next
    }

    /// Ending a process deliberately is also the end of any turn waiting only
    /// for that process to exit. Otherwise a later, unrelated resume could
    /// unexpectedly receive words the person meant to cancel.
    fn forget_queued_command_turns(&self, key: &str) {
        if let Ok(mut turns) = self.queued_command_turns.lock() {
            turns.remove(key);
        }
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
/// there is nothing left to pre-filter. What is kept here is the WRITE side: a
/// seat must not overwrite the level its room is on, and that rule is worth
/// holding on to for the reader that comes back.
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

/// Remember the level the hook will answer at, unless a SEAT is asking.
///
/// The permission channel is keyed by the CONVERSATION — `OCTIQ_CHAT_KEY` has to
/// name the chat, or `ask_user` would put its question in front of the wrong one
/// — so a room's host and every seat in it share ONE entry.
///
/// That makes writing to it a HOST-only act. A seat that wrote its own level
/// here would answer the host's permission questions at that level, and nothing
/// on screen would say the picker no longer meant what it says. A seat inherits
/// whatever the room is already on, which is the only reading that can be true
/// for both of them at once.
pub(crate) fn record_access_for(key: &str, access: Option<Access>, is_seat: bool) {
    if is_seat {
        return;
    }
    with_access(|a| a.insert(key.to_string(), access.unwrap_or(Access::Read)));
}

/// What a chat may do at this moment, or None when no chat by that key is known.
///
/// No production reader since asking moved to the agent's own control channel;
/// the room tests read it to prove a seat leaves the host's level alone.
#[allow(dead_code)]
pub fn access_now(key: &str) -> Option<Access> {
    with_access(|a| a.get(key).copied())
}

/// Pretend a chat by this key is running at this level. Tests only: the real
/// recorders are `chat_start` and `chat_set_access`, and both want a process.
#[cfg(test)]
pub(crate) fn remember_access(key: &str, access: Access) {
    with_access(|a| a.insert(key.to_string(), access));
}

/// Build one provider-owned command from the normalized chat request.
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
    let provider = provider_for(agent);
    let mcp = provider
        .capabilities()
        .uses_octiq_mcp
        .then(ask_mcp_config)
        .flatten();
    build_command_with_mcp(
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
    )
}

/// The testable command-builder seam. Provider-specific syntax lives in the
/// selected adapter, while this function preserves the shared chat input shape.
#[allow(clippy::too_many_arguments)]
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
    provider_for(agent).build_command(&AgentCommand {
        model,
        access,
        prompt,
        resume,
        extra_dirs,
        effort,
        images,
        lite,
        mcp_config,
    })
}

/// Start a chat session. `key` names it for every later call, exactly as a PTY
/// id does. Starting a key that already runs is an error, not a silent replace —
/// a second process on the same key would interleave two conversations.
/// Which process this is, where its words go, and whose voice they are.
///
/// For the HOST the first two are the same string, which is why one `key` was
/// enough until rooms existed. A SEAT's are not: it runs as its own process, so
/// it needs its own entry in the sessions map — but what it SAYS belongs to the
/// room's transcript, under the room's key, or the conversation would be split
/// across as many records as it has voices and no reader could put it back
/// together.
pub(crate) struct Voice {
    /// The sessions-map key. Identifies the PROCESS.
    pub session_key: String,
    /// The chat its events are recorded and emitted under, its permission
    /// questions attach to, and `OCTIQ_CHAT_KEY` names. Identifies the
    /// CONVERSATION.
    pub stream_key: String,
    /// Stamped onto every event this process produces. `None` is the host, and
    /// a host's events are never touched at all.
    pub seat: Option<crate::chat_room::Seat>,
}

impl Voice {
    /// A chat's own agent: one key, no seat — the shape every chat had before
    /// rooms.
    fn host(key: String) -> Self {
        Self {
            session_key: key.clone(),
            stream_key: key,
            seat: None,
        }
    }

    /// One seat in a room. Its own process, the room's transcript.
    pub(crate) fn seat(room_key: &str, seat: crate::chat_room::Seat) -> Self {
        Self {
            session_key: crate::chat_room::seat_session_key(room_key, &seat.id),
            stream_key: room_key.to_string(),
            seat: Some(seat),
        }
    }
}

/// Start a chat.
#[allow(clippy::too_many_arguments)]
pub fn chat_start_impl(
    manager: Arc<ChatManager>,
    key: String,
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    prompt: Option<String>,
    resume: Option<String>,
    extra_dirs: Option<Vec<String>>,
    effort: Option<String>,
    images: Option<Vec<String>>,
    lite: Option<bool>,
) -> Result<(), String> {
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
        effort,
        images,
        lite,
    )
}

/// Say something to a chat's own agent, starting it first if it is not up.
///
/// The two-step the client has always done for the host, moved down here so the
/// BACKEND can do it too. Its one caller is `round::ask_host`: a room's host is
/// told what the other agents said, and by then its process may be gone — the
/// idle sweeper ends the host of a room whose seats are still answering.
///
/// A host that was never started in this process cannot be started by this:
/// nothing here knows which model to pick or which folders to open, and
/// guessing would start the wrong agent on the wrong project. It says so and
/// nothing is sent, which loses only the follow-up — every word is already in
/// the transcript.
pub(crate) fn send_to_host(manager: Arc<ChatManager>, key: &str, text: &str) -> Result<(), String> {
    match chat_send_impl(
        manager.clone(),
        key.to_string(),
        text.to_string(),
        None,
        None,
    ) {
        Ok(()) => Ok(()),
        // Swept while it had nothing to do, or ended with the last restart.
        Err(why) if why.contains("no such chat") => {
            let start = manager
                .start_context(key)
                .ok_or_else(|| format!("nothing here knows how to start '{key}'"))?;
            chat_start_impl(
                manager,
                key.to_string(),
                start.cwd,
                start.agent,
                start.model,
                start.access,
                Some(text.to_string()),
                start.session_id,
                start.extra_dirs,
                start.effort,
                None,
                start.lite,
            )
        }
        Err(why) => Err(why),
    }
}

/// Start the next queued command-line turn after its preceding process exits.
/// Its adapter owns the provider's resume syntax and has no persistent stdin
/// channel (see `start_session`). `session_key` identifies the process to
/// resume; `stream_key` keeps a seat's words in its room transcript.
fn start_queued_command_turn(
    manager: Arc<ChatManager>,
    session_key: &str,
    stream_key: &str,
    seat: Option<crate::chat_room::Seat>,
    turn: QueuedCommandTurn,
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
    let QueuedCommandTurn { text, images } = turn;
    let voice = match seat {
        Some(seat) => Voice::seat(stream_key, seat),
        None => Voice::host(stream_key.to_string()),
    };
    start_session(
        manager,
        voice,
        start.cwd,
        start.agent,
        start.model,
        start.access,
        Some(text),
        start.session_id,
        start.extra_dirs,
        start.effort,
        Some(images),
        start.lite,
    )
}

/// Start one agent process — the host's, or a seat's.
///
/// Everything below reads `key` as the CONVERSATION: the transcript it appends
/// to, the events it emits, the permission questions it raises, the value of
/// `OCTIQ_CHAT_KEY`. Only the sessions map wants the other one, and it is named
/// `session_key` at each of the three places it does.
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
    effort: Option<String>,
    images: Option<Vec<String>>,
    lite: Option<bool>,
) -> Result<(), String> {
    let Voice {
        session_key,
        stream_key: key,
        seat,
    } = voice;
    // Read before `seat` is moved into the reader thread below. The reaper
    // needs its own copy to resume a queued Codex seat under the same voice.
    let is_seat = seat.is_some();
    let seat_for_reaper = seat.clone();
    let manager_for_exit = manager.clone();
    let session_key_for_exit = session_key.clone();
    {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(&session_key) {
            return Err(format!("chat '{session_key}' is already running"));
        }
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
    let prompt = prompt.unwrap_or_default();
    let images = images.unwrap_or_default();
    let line = build_command(
        agent,
        model.as_deref(),
        access,
        &prompt,
        resume.as_deref(),
        &extras,
        effort.as_deref(),
        &images,
        lite.unwrap_or(false),
    );

    // Login shell, for PATH — see the module docs.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut child = Command::new(&shell)
        .args(["-lc", &format!("exec {line}")])
        .current_dir(if cwd.trim().is_empty() {
            std::env::var("HOME").unwrap_or_else(|_| "/".into())
        } else {
            cwd.clone()
        })
        // The selected provider declares whether it owns a persistent stdin
        // protocol. A command-line provider must receive EOF immediately so a
        // one-shot CLI does not wait for a second prompt.
        // The hook answers only for agents we started, and needs to know
        // which chat is asking so the UI can attach the question to it.
        .env("OCTIQ_CHAT_KEY", &key)
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
        // Harmless for Codex, which shares this spawn and has never read it.
        .env("CLAUDE_CODE_ARTIFACT", "1")
        .stdin(if provider.capabilities().input.accepts_stdin() {
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
    let stdin = child.stdin.take();

    let session = Arc::new(Mutex::new(ChatSession {
        child,
        stdin,
        agent,
        // Working from the first breath, because a chat is nearly always
        // started WITH its first message: Claude is handed it on stdin a few
        // lines below, and Codex already has it on its command line. Started
        // with nothing to do — which only the API can ask for — it is still
        // from birth, and the sweeper is right to treat it that way.
        busy: !prompt.trim().is_empty(),
        last_active: Instant::now(),
    }));
    manager
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_key.clone(), session.clone());
    // The level the hook will be answered with, from here until it changes.
    // Unset is the most cautious of the three, matching `OCTIQ_ACCESS` above.
    record_access_for(&key, access, is_seat);

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
        // Whose stdout this is. `None` is the host, and a host's events go
        // through completely untouched — see `stamp_speaker`. A seat names
        // itself on every event it produces, in the record as well as on the
        // wire, so a reader coming back to the conversation still knows who
        // said what.
        let speaker = seat;
        // The runtime the answer will be waited on. Captured HERE, on the thread
        // that still has one: `chat_start` is called from an async handler, the
        // reader below is a plain thread, and `Handle::current()` panics there.
        // Absent only on the desktop build, which has no server runtime — see
        // `answer_permission`.
        let rt = tokio::runtime::Handle::try_current().ok();
        // The reader is where a chat learns its own session id and where a
        // seat's answer is handed on, and both of those want the manager.
        let reading = manager.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            // The last thing a Codex turn said, kept until the turn stops and
            // cleared the moment it is handed over. One turn's words must never
            // be read as the next one's answer.
            let mut carried = String::new();
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(event) => {
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
                        // event. A host always resumes its own memory; a seat
                        // needs that record only when its provider is one-shot.
                        if speaker.is_none()
                            || !stream_provider.capabilities().input.accepts_stdin()
                        {
                            if let Some(id) = observed.session_id {
                                reading.remember_session(&session_key, id);
                            }
                        }
                        // Codex says nothing on its full stop, so its closing
                        // words have to be kept as they go past — see
                        // `codex_said`.
                        if let Some(text) = observed.spoken_text {
                            carried.clear();
                            carried.push_str(text);
                        }
                        if observed.turn_finished {
                            if let Ok(mut s) = asking.lock() {
                                s.turn_ended();
                            }
                            let said = observed.final_text.unwrap_or(&carried).to_string();
                            carried.clear();
                            crate::push::notify_chat(Some(&key), "done", &said);
                            // A full stop is the only honest signal that an
                            // agent has finished its turn. A round may be
                            // waiting to hear exactly this; a seat that nobody
                            // was waiting on hands the room's host something to
                            // answer. Silent for every ordinary chat, which has
                            // no seats and nobody listening.
                            crate::round::turn_ended(
                                reading.clone(),
                                &key,
                                speaker.as_ref(),
                                &said,
                            );
                        }
                        // Who said this — BEFORE the record is written, so a
                        // client that catches up later is told the same thing a
                        // client watching live was told. `None` is the host,
                        // and the host's events go through completely
                        // untouched; that is what makes a chat with no seats
                        // byte-for-byte the chat that shipped before card 66.
                        let mut event = event;
                        crate::chat_room::stamp_speaker(&mut event, speaker.as_ref());
                        // Recorded BEFORE it is sent, so a client that
                        // reconnects can never be told about an event that was
                        // not written down.
                        let seq = crate::transcript::append(&key, &event);
                        crate::bus::emit(
                            "chat-event",
                            ChatEvent {
                                key: key.clone(),
                                seq,
                                event,
                            },
                        )
                    }
                    // A non-JSON line means the agent printed something we did
                    // not ask for (a login prompt, an update notice). Surface it
                    // rather than dropping it — it is usually the reason a chat
                    // produced nothing. The one exception is below.
                    Err(_) => emit_status(
                        stream_provider.kind(),
                        ChatStatus {
                            key: key.clone(),
                            kind: "stderr".into(),
                            text: trimmed.to_string(),
                            code: None,
                        },
                    ),
                }
            }
        });
    }

    // stderr: never JSON, always worth showing.
    {
        let key = key.clone();
        let stderr_provider = provider;
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() || stderr_provider.is_expected_stderr(&line) {
                    continue;
                }
                emit_status(
                    stderr_provider.kind(),
                    ChatStatus {
                        key: key.clone(),
                        kind: "stderr".into(),
                        text: line,
                        code: None,
                    },
                );
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
                        let queued_turn = (!provider_for(agent)
                            .capabilities()
                            .input
                            .accepts_stdin())
                        .then(|| manager_for_exit.take_queued_command_turn(&session_key_for_exit))
                        .flatten();
                        (true, false, queued_turn)
                    } else {
                        (false, sessions.contains_key(&session_key_for_exit), None)
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
                        seat_for_reaper,
                        turn,
                    ) {
                        Ok(()) => return,
                        Err(why) => {
                            // Do not let a later, unrelated resume receive
                            // stale words after a failed restart.
                            manager_for_exit.forget_queued_command_turns(&session_key_for_exit);
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
            // And nothing may go on waiting for a turn it will never finish —
            // see `round::session_gone`.
            crate::round::session_gone(&session_key_for_exit);
        });
    }

    // Persistent-stream providers receive the first user turn after startup;
    // command-line providers received it in `build_command` already.
    if provider.capabilities().input.accepts_stdin() && !prompt.trim().is_empty() {
        write_user_message(&session, &prompt, &images)?;
    }

    Ok(())
}

/// Write one user turn through the running provider's persistent input channel.
fn write_user_message(
    session: &Arc<Mutex<ChatSession>>,
    text: &str,
    images: &[String],
) -> Result<(), String> {
    let agent = session.lock().map_err(|e| e.to_string())?.agent;
    let payload = provider_for(agent)
        .user_message_payload(text, images)
        .ok_or("this chat does not take more input")?;
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let stdin = guard
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    // Every turn this session is ever asked to do comes through here, so this
    // one line is the whole of "somebody is still using this chat".
    guard.turn_started();
    Ok(())
}

/// Send the next user turn to a running chat, with any images attached to it.
pub fn chat_send_impl(
    manager: Arc<ChatManager>,
    key: String,
    text: String,
    images: Option<Vec<String>>,
    // Who this is for. `None` is the chat's own agent — every message of every
    // chat that is not a room, and the default inside one.
    to: Option<String>,
) -> Result<(), String> {
    // WHO first, because an unknown seat must be refused before anything is
    // written anywhere. Falling through to the host would put a message meant
    // for one agent in front of a different one.
    let target = crate::chat_room::target_impl(&manager, &key, to.as_deref())?;
    let session_key = match &target {
        crate::chat_room::Target::Host => key.clone(),
        crate::chat_room::Target::Seat(seat) => crate::chat_room::seat_session_key(&key, &seat.id),
    };
    // A seat with no process behind it never had a session to find. Card 71:
    // it is an HTTP call, so the words go straight out and the answer is
    // already back by the time this returns.
    if let crate::chat_room::Target::Seat(seat) = &target {
        if seat.kind == crate::chat_room::SeatKind::OnDemand {
            crate::agent_api::ask(seat, &key, &text)?;
            return Ok(());
        }
    }
    let images = images.unwrap_or_default();
    let session = {
        // A command-line follow-up and its reaper share this lock order.
        // Holding the sessions entry until the turn reaches the queue means the
        // reaper either sees that queued turn or this call sees no session and
        // the client starts a normal resume — never a successful send that
        // vanishes in between.
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        let Some(session) = sessions.get(&session_key).cloned() else {
            // Two different failures, said differently on purpose. A seat is a
            // RECORD until someone talks to it, so "it has not started yet" is
            // an ordinary state the client answers by starting it — the same
            // thing it already does for the host's own first message. "No such
            // chat" is not recoverable and must not be mistaken for it.
            return Err(match target {
                crate::chat_room::Target::Seat(seat) => {
                    format!("seat '{}' is not running", seat.name)
                }
                crate::chat_room::Target::Host => "no such chat".into(),
            });
        };

        // A command-line provider's stdin is deliberately `null`: an open pipe
        // can make a one-shot command wait for more prompt text forever. Every
        // command-line process, including a resident Codex seat, has launch
        // context saved under its process key, so queue its next turn instead.
        {
            let mut guard = session.lock().map_err(|e| e.to_string())?;
            if !provider_for(guard.agent)
                .capabilities()
                .input
                .accepts_stdin()
            {
                manager.queue_command_turn(&session_key, QueuedCommandTurn { text, images })?;
                // A queued turn is still work the person is waiting for. This also
                // prevents the idle sweeper from ending the process in the handoff
                // before its reaper starts the resume.
                guard.turn_started();
                return Ok(());
            }
        }
        session
    };
    write_user_message(&session, &text, &images)
}

/// Start ONE seat's process, with its first message.
///
/// The mirror of `chat_start_impl` for a seat, and deliberately the same shape:
/// the client already knows "not running yet, so start it with the prompt;
/// otherwise send", because that is how it has always talked to the host. A
/// seat gets the same two calls rather than a cleverer one.
///
/// The context comes from the caller because the CLIENT is the thing that knows
/// it — the project's folders, the access level, the effort. Keeping a copy on
/// the room would be a second source of truth that could drift from the one the
/// host was started with.
#[allow(clippy::too_many_arguments)]
pub fn chat_seat_start_impl(
    manager: Arc<ChatManager>,
    key: String,
    seat_id: String,
    cwd: String,
    prompt: Option<String>,
    access: Option<Access>,
    extra_dirs: Option<Vec<String>>,
    effort: Option<String>,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    let crate::chat_room::Target::Seat(seat) =
        crate::chat_room::target_impl(&manager, &key, Some(&seat_id))?
    else {
        return Err("that is the host, not a seat".into());
    };
    // Nothing to start. Refused rather than quietly doing nothing, or a caller
    // would go on to wait for a turn that is never coming.
    if seat.kind == crate::chat_room::SeatKind::OnDemand {
        return Err(format!(
            "'{}' has no process to start — it is asked directly",
            seat.name
        ));
    }
    let agent = seat.agent;
    let model = seat.model.clone();
    // Card 69 — WHERE this seat runs is the seat's own business, not the
    // caller's. A `room_only` seat is put somewhere the project is not, and an
    // agent merely TOLD to ignore a repository will read it the moment the
    // question gets hard. Deciding it here means no call site can forget.
    let (cwd, extra_dirs) =
        crate::chat_room::seat_workspace(&seat, &key, &cwd, &extra_dirs.unwrap_or_default());
    // A folder it has never used will not exist yet, and `current_dir` on a
    // missing path fails the spawn outright.
    let _ = std::fs::create_dir_all(&cwd);
    let extra_dirs = Some(extra_dirs);
    let session_key = crate::chat_room::seat_session_key(&key, &seat.id);
    // A resident command-line seat can be a one-shot provider. Its old process
    // may have exited between messages, so retain the id it announced and
    // resume it instead of starting a second opinion from an empty
    // conversation. Stream-provider seats keep their existing fresh-start
    // behavior when deliberately restarted.
    let resume = if provider_for(agent).capabilities().input.accepts_stdin() {
        None
    } else {
        manager
            .start_context(&session_key)
            .and_then(|start| start.session_id)
    };
    manager.remember_start(
        &session_key,
        StartContext {
            cwd: cwd.clone(),
            agent,
            model: model.clone(),
            access,
            extra_dirs: extra_dirs.clone(),
            effort: effort.clone(),
            lite: Some(true),
            session_id: resume.clone(),
        },
    );
    start_session(
        manager,
        Voice::seat(&key, seat),
        cwd,
        agent,
        model,
        access,
        prompt,
        resume,
        extra_dirs,
        effort,
        images,
        // A seat is a second opinion, not a second copy of this machine's
        // setup. It starts clean for the same reason `lite` exists.
        Some(true),
    )
}

/// Ask the agent to stop what it is doing, WITHOUT ending the conversation.
///
/// Claude's init event advertises `interrupt_receipt_v1`, so the running turn
/// can be cancelled over the same stdin the prompts go down and the session
/// stays alive with its context. Killing the process would work too and is what
/// `chat_stop` does — but it throws the conversation away, which is a heavy
/// price for "actually, stop".
pub fn chat_interrupt_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&key).cloned().ok_or("no such chat")?
    };
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let payload = provider_for(guard.agent)
        .interrupt_payload()
        .ok_or("this chat does not take more input")?;
    let stdin = guard
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    // The turn is over as far as anyone waiting is concerned, and the still
    // clock starts here rather than at whatever `result` the agent may or may
    // not send after being cut off. A session that stopped and was never
    // spoken to again is exactly what the sweeper is for.
    guard.turn_ended();
    Ok(())
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
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&key).cloned().ok_or("no such chat")?
    };
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let provider = provider_for(guard.agent);
    if !provider.capabilities().supports_live_access_change {
        return Ok(());
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
    stdin.flush().map_err(|e| e.to_string())
}

/// Stop a chat and drop it. Killing an unknown key is a no-op success, so the
/// UI can close a chat twice without caring.
pub fn chat_stop_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    // Anything the person allowed "always" was allowed for THIS piece of work.
    // Outliving it would be a permission nobody remembers giving.
    crate::permission::forget_chat(&key);
    with_access(|a| a.remove(&key));
    end_process(manager, &key).map(|_| ())
}

/// End this chat's agent on purpose, and keep everything else about the chat.
///
/// The sweeper's ending, asked for instead of waited out. An agent reads its
/// MCP servers, its plugins and the tool list they add up to ONCE, at spawn, so
/// a chat that was already open when one of them was added never sees it. Until
/// this there was no way to a fresh process but to leave the chat alone for the
/// fifteen minutes the sweeper takes.
///
/// `end_process`, NOT `chat_stop_impl`, and for both halves of what separates
/// them. The standing permissions and the access level belong to the WORK, and
/// the work is carrying straight on — re-asking about a command already allowed
/// "always" would be a decision quietly taken back. And a room is ended as one
/// thing, or its seats are left running against nobody, holding their memory
/// until the server goes.
///
/// Unlike the sweeper this ends a seat that is still ANSWERING. The sweeper
/// spares one because it is guessing at whether a quiet room is finished; there
/// is no guess here. And a seat left behind would be the one thing the person
/// pressed this to be rid of — a process still holding the old set of tools.
///
/// Answers how many processes went, which is 0 for a chat already stopped.
pub fn chat_restart_impl(manager: &ChatManager, key: String) -> Result<usize, String> {
    let mut ended = 0;
    // The room's seats first, while the room can still be read.
    let seats = crate::chat_room::room_impl(manager, &key)
        .map(|room| room.seats)
        .unwrap_or_default();
    for seat in seats {
        let seat_key = crate::chat_room::seat_session_key(&key, &seat.id);
        if end_process(manager, &seat_key)? {
            ended += 1;
        }
    }
    if end_process(manager, &key)? {
        ended += 1;
    }
    Ok(ended)
}

/// End one chat process while preserving its transcript and remembered settings.
///
/// Unlike stopping a chat, this intentionally retains standing permissions and
/// access settings so the next message can resume the same work. Any queued
/// one-shot-provider follow-up is discarded: the person explicitly ended the
/// process it was waiting to resume.
fn end_process(manager: &ChatManager, key: &str) -> Result<bool, String> {
    let session = {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(key)
    };
    // Removal from the session map happens before clearing the queue, so a
    // concurrent send cannot add a new deferred turn after this cleanup.
    manager.forget_queued_command_turns(key);
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

/// Is this session part-way through a turn right now?
fn is_working(manager: &ChatManager, key: &str) -> bool {
    let Ok(sessions) = manager.sessions.lock() else {
        // Cannot tell, so assume it is working. Every wrong answer in this
        // direction costs memory; the other one costs somebody's turn.
        return true;
    };
    sessions
        .get(key)
        .map(|s| s.lock().map(|s| s.busy).unwrap_or(true))
        .unwrap_or(false)
}

/// End every chat that has been sitting still too long, and everyone sitting
/// in it.
///
/// A room is swept as ONE thing. Its seats are separate processes under their
/// own keys, so ending the host alone would leave them running with nobody left
/// to talk to them and nothing that would ever end them — the memory would come
/// back in part, and the part that did not would need a restart. Seats lose
/// nothing by it: a seat is handed the discussion it needs each time it is
/// spoken to (`round::round_brief`), and the client already knows how to start
/// one that has no process.
///
/// The exception is a seat that is ANSWERING. A round runs with nobody watching
/// it and gives each seat up to twenty minutes, so an idle host with a seat
/// still thinking is an ordinary sight rather than a stuck one — and the seat's
/// answer reaches the room's transcript through its own reader whether the host
/// is up or not. It keeps its process, and sweeps itself once it has been quiet
/// as long as anyone else.
fn sweep_still_chats(manager: &ChatManager, timeout: Duration) -> Vec<String> {
    let mut ended = Vec::new();
    for key in still_keys(manager, timeout) {
        // The room's seats first, while the room can still be read.
        let seats = crate::chat_room::room_impl(manager, &key)
            .map(|room| room.seats)
            .unwrap_or_default();
        for seat in seats {
            let seat_key = crate::chat_room::seat_session_key(&key, &seat.id);
            if is_working(manager, &seat_key) {
                continue;
            }
            if end_process(manager, &seat_key) == Ok(true) {
                ended.push(seat_key);
            }
        }
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

/// Save a pasted image and return its path.
///
/// A clipboard image has no file behind it, and both agents need one: Codex
/// takes `-i <FILE>`, and Claude wants bytes we can only read from somewhere.
/// So it lands on disk first, and the path is what the rest of the flow passes
/// around — the same shape as a file the user picked.
///
/// The name is ours, never the browser's: a name from the page could carry
/// `../` and walk out of the folder.
pub fn save_attachment(data_base64: String, extension: String) -> Result<String, String> {
    use base64::Engine;
    let ext = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let ext = match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => ext,
        _ => return Err(format!("unsupported image type: {extension}")),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("not valid base64: {e}"))?;
    if bytes.is_empty() {
        return Err("empty image".into());
    }
    if bytes.len() > 12 * 1024 * 1024 {
        return Err("image is larger than 12 MB".into());
    }
    let path = attachments_dir()?.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).map_err(|e| format!("could not save the image: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// The chats that exist, newest first.
pub fn chat_index_list() -> Vec<crate::chat_index::ChatMeta> {
    crate::chat_index::list()
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

/// Forget a chat entirely — its entry in the list and its transcript.
pub fn chat_index_remove(id: String, key: String) -> Result<(), String> {
    crate::transcript::forget(&key);
    crate::chat_index::remove(&id)?;
    announce_index_change(&id, true);
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_provider::{
        test_image_media_type as image_media_type, test_sh_quote as sh_quote,
        test_toml_string as toml_string,
    };

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
    fn the_host_is_given_the_room_tools_in_every_chat_not_only_a_room() {
        // Card 70, and since card 82 there is nothing left to gate them on: a
        // chat becomes a room by taking a seat, so the tool that adds the first
        // one has to be offered in a chat that is not a room yet. The list a
        // process is given is fixed when it SPAWNS, which is why this could
        // never have been decided per-chat anyway.
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
            c.contains("mcp__octiq__add_agent"),
            "add_agent is not allowed: {c}"
        );
        assert!(
            c.contains("mcp__octiq__ask_agent"),
            "ask_agent is not allowed: {c}"
        );
        // And the two that were always there still are.
        assert!(c.contains("mcp__octiq__ask_user"));
        assert!(c.contains("mcp__octiq__todo_write"));
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
    }

    #[test]
    fn a_codex_resume_puts_the_folder_in_the_config_key_safely() {
        let line = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hello",
            Some("abc-123"),
            &[r#"/tmp/a", evil = "yes"#.to_string()],
            None,
            &[],
            false,
        );
        assert!(
            line.contains(r#"["/tmp/a\", evil = \"yes"]"#),
            "the folder must arrive escaped: {line}"
        );
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

            let x = build_command(
                ChatAgent::Codex,
                None,
                Some(level),
                "hi",
                None,
                &[],
                None,
                &[],
                false,
            );
            assert!(
                x.contains(&format!("--sandbox {sandbox}")),
                "codex {level:?}"
            );
            assert!(
                x.contains(&format!("-c approval_policy='{approval}'")),
                "codex approval {level:?}"
            );
            assert!(
                !x.contains("--ask-for-approval"),
                "codex exec dropped the flag form; it only takes the config key"
            );
            assert!(
                !x.contains("--permission-mode"),
                "codex must not get a permission mode"
            );
        }
    }

    #[test]
    fn codex_resume_spells_both_halves_as_config_keys() {
        // `codex exec resume` accepts neither --sandbox nor --ask-for-approval,
        // so the same two settings have to travel as -c keys or a resumed chat
        // silently falls back to whatever the user's own config says.
        let id = "a2c8ca18-dcd4-41bc-a49d-b078f2a8e056";
        let x = build_command(
            ChatAgent::Codex,
            None,
            Some(Access::Auto),
            "hi",
            Some(id),
            &[],
            None,
            &[],
            false,
        );
        assert!(x.contains("-c sandbox_mode='workspace-write'"));
        assert!(x.contains("-c approval_policy='on-request'"));
        assert!(!x.contains("--sandbox"), "resume does not take --sandbox");
        assert!(
            !x.contains("--ask-for-approval"),
            "resume does not take the flag form"
        );
    }

    #[test]
    fn claude_gets_a_two_way_stream_and_codex_gets_the_prompt() {
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
        assert!(x.contains("codex exec --json"));
        assert!(x.ends_with("'hi there'"));
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
        // Codex supports it too, but only as a config override.
        let x = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hi",
            None,
            &[],
            Some("xhigh"),
            &[],
            false,
        );
        assert!(x.contains("-c model_reasoning_effort='xhigh'"));
        assert!(!x.contains("--effort"));

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
        let codex_max = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hi",
            None,
            &[],
            Some("max"),
            &[],
            false,
        );
        assert!(codex_max.contains("model_reasoning_effort='max'"));

        // `minimal` is nobody's any more. The same model list dropped it from
        // every GPT-5.6 model, and Claude never had it.
        let codex_min = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hi",
            None,
            &[],
            Some("minimal"),
            &[],
            false,
        );
        assert!(!codex_min.contains("model_reasoning_effort"));
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
        let codex_ultra = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hi",
            None,
            &[],
            Some("ultracode"),
            &[],
            false,
        );
        assert!(!codex_ultra.contains("model_reasoning_effort"));

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
        let c = build_command(
            ChatAgent::Codex,
            None,
            Some(Access::Read),
            "next question",
            Some(id),
            &["/tmp/api".to_string()],
            Some("high"),
            &[],
            false,
        );
        // The subcommand, with the id BEFORE the prompt — that is the order
        // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` expects.
        assert!(c.starts_with(&format!("codex exec resume --json '{id}'")));
        assert!(c.ends_with("'next question'"));
        // resume takes neither --sandbox nor --add-dir, so both settings have
        // to travel as config overrides instead.
        assert!(!c.contains("--sandbox"));
        assert!(!c.contains("--add-dir"));
        assert!(c.contains("-c sandbox_mode='read-only'"));
        assert!(c.contains("-c model_reasoning_effort='high'"));
        assert!(c.contains("writable_roots"));

        // A FIRST turn has no thread yet, so it is a plain exec with the flags.
        let first = build_command(
            ChatAgent::Codex,
            None,
            Some(Access::Read),
            "hello",
            None,
            &["/tmp/api".to_string()],
            None,
            &[],
            false,
        );
        assert!(first.starts_with("codex exec --json"));
        assert!(!first.contains("resume"));
        assert!(first.contains("--sandbox read-only"));
        assert!(first.contains("--add-dir '/tmp/api'"));
    }

    #[test]
    fn codex_is_allowed_to_run_where_there_is_no_git_repo() {
        // An outside seat is started in an empty scratch folder on purpose
        // (`chat_room::seat_workspace`), and that folder is neither a git repo
        // nor a trusted project. Codex 0.147 refuses to start there at all —
        // "Not inside a trusted directory and --skip-git-repo-check was not
        // specified." — so the seat died before it read a word of the prompt
        // and the room sat waiting on an answer that could never come.
        let first = build_command(
            ChatAgent::Codex,
            None,
            Some(Access::Read),
            "hello",
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(
            first.contains("--skip-git-repo-check"),
            "a first turn cannot start outside a repo: {first}"
        );

        // The resume form takes the same flag, and needs it for the same
        // reason: every turn after the first is a fresh process in that same
        // folder.
        let again = build_command(
            ChatAgent::Codex,
            None,
            Some(Access::Read),
            "and again",
            Some("01a0142d-552d-7a93-9152-47530c33e501"),
            &[],
            None,
            &[],
            false,
        );
        assert!(
            again.contains("--skip-git-repo-check"),
            "a resumed turn cannot start outside a repo: {again}"
        );

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
    fn the_stdin_notice_codex_always_prints_is_not_a_notice() {
        let codex = provider_for(ChatAgent::Codex);
        assert!(codex.is_expected_stderr("Reading additional input from stdin..."));
        assert!(codex.is_expected_stderr("  Reading additional input from stdin... "));
        assert!(codex.is_expected_stderr(
            "2026-08-30T09:38:25Z ERROR codex_models_manager::manager: \
             failed to renew cache TTL: missing field `supports_parallel_tool_calls`"
        ));
        // Anything else still reaches the user — that is the whole point of
        // surfacing stderr.
        assert!(!codex.is_expected_stderr("Error loading config.toml"));
        assert!(!codex.is_expected_stderr("You've hit your usage limit."));
    }

    #[test]
    fn codex_takes_images_as_files_and_claude_does_not() {
        let shots = vec!["/tmp/a shot.png".to_string(), "/tmp/b.webp".to_string()];
        let x = build_command(
            ChatAgent::Codex,
            None,
            None,
            "look",
            None,
            &[],
            None,
            &shots,
            false,
        );
        // Quoted, so a space in the name stays one argument.
        assert!(x.contains("-i '/tmp/a shot.png'"));
        assert!(x.contains("-i '/tmp/b.webp'"));
        // `-i` is variadic, so `--` must keep the positional prompt from
        // becoming a third image and falling back to stdin.
        assert!(x.ends_with("-- 'look'"));

        // An image by itself is a valid composer message. Codex treats an
        // empty positional argument as no prompt and otherwise reads stdin,
        // which command-line chats intentionally close.
        let image_only = build_command(
            ChatAgent::Codex,
            None,
            None,
            "",
            None,
            &[],
            None,
            &shots,
            false,
        );
        assert!(image_only.ends_with("-- 'Please inspect the attached image.'"));
        assert!(!image_only.ends_with("''"));

        // The delimiter also preserves a user prompt that starts with a dash.
        let dash_prompt = build_command(
            ChatAgent::Codex,
            None,
            None,
            "--describe",
            None,
            &[],
            None,
            &shots,
            false,
        );
        assert!(dash_prompt.ends_with("-- '--describe'"));

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
    fn a_codex_seat_queues_its_follow_up_by_its_own_process_key() {
        // Codex has no stdin conversation. A seat still has to be able to
        // receive a message sent before its previous one-shot process exits,
        // without putting the next turn in the room host's queue.
        let manager = Arc::new(ChatManager::default());
        let seat = crate::chat_room::add_seat_impl(
            &manager,
            "chat-a",
            crate::chat_room::NewSeat::for_test("Codex", ChatAgent::Codex),
        )
        .expect("a resident Codex seat");
        let session_key = crate::chat_room::seat_session_key("chat-a", &seat.id);
        manager.remember_start(
            &session_key,
            StartContext {
                cwd: "/tmp".into(),
                agent: ChatAgent::Codex,
                model: None,
                access: Some(Access::Read),
                extra_dirs: None,
                effort: None,
                lite: Some(true),
                session_id: Some("01a0142d-552d-7a93-9152-47530c33e501".into()),
            },
        );
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .spawn()
            .expect("a Codex stand-in");
        manager.sessions.lock().unwrap().insert(
            session_key.clone(),
            Arc::new(Mutex::new(ChatSession {
                child,
                stdin: None,
                agent: ChatAgent::Codex,
                busy: true,
                last_active: Instant::now(),
            })),
        );

        chat_send_impl(
            manager.clone(),
            "chat-a".into(),
            "follow up".into(),
            Some(vec!["/tmp/shot.png".into()]),
            Some(seat.id),
        )
        .expect("a Codex seat queues instead of writing to absent stdin");

        assert!(manager.take_queued_command_turn("chat-a").is_none());
        assert_eq!(
            manager.take_queued_command_turn(&session_key),
            Some(QueuedCommandTurn {
                text: "follow up".into(),
                images: vec!["/tmp/shot.png".into()],
            })
        );
        assert_eq!(
            manager
                .start_context(&session_key)
                .and_then(|start| start.session_id),
            Some("01a0142d-552d-7a93-9152-47530c33e501".into()),
            "the reaper has the exact session it needs for codex exec resume"
        );
        end_process(&manager, &session_key).expect("end the stand-in");
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

        // Codex takes extra folders too — it was a mistake to think otherwise.
        let x = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hi",
            None,
            &dirs,
            None,
            &[],
            false,
        );
        assert!(x.contains("--add-dir '/Users/me/api'"));
        assert!(x.contains("--add-dir '/Users/me/my docs'"));
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
            child,
            stdin: None,
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
    fn a_room_swept_takes_its_seats_with_it() {
        // Seats are separate processes under their own keys, and nothing else
        // in the app would ever end them once their host is gone: only
        // DELETING the conversation does that. Ending the host alone would
        // hand back a fraction of the memory and strand the rest until a
        // restart.
        let m = ChatManager::default();
        let seat = crate::chat_room::add_seat_impl(
            &m,
            "chat-a",
            crate::chat_room::NewSeat::for_test("Codex", ChatAgent::Codex),
        )
        .expect("a seat to sit down");
        let seat_key = crate::chat_room::seat_session_key("chat-a", &seat.id);

        put(
            &m,
            "chat-a",
            still_session(false, Duration::from_secs(20 * 60)),
        );
        // The seat itself answered a while back and has been quiet since.
        put(&m, &seat_key, still_session(false, Duration::from_secs(60)));

        let ended = sweep_still_chats(&m, FIFTEEN);

        assert!(ended.contains(&seat_key), "the seat went with its host");
        assert!(ended.contains(&"chat-a".to_string()));
        assert!(chat_list_impl(&m).unwrap().is_empty());
        assert_eq!(
            crate::chat_room::room_impl(&m, "chat-a")
                .unwrap()
                .seats
                .len(),
            1,
            "and the ROSTER stays — the room is not being disbanded, only its \
             processes ended"
        );
    }

    #[test]
    fn a_seat_still_answering_keeps_its_process_when_its_host_is_swept() {
        // A round runs with nobody watching and gives each seat up to twenty
        // minutes, so an idle host with a seat still thinking is an ordinary
        // sight — and sweeping the room would kill the answer being written.
        // The seat's own words reach the room's transcript whether the host is
        // up or not, so it is simply left to finish.
        let m = ChatManager::default();
        let seat = crate::chat_room::add_seat_impl(
            &m,
            "chat-a",
            crate::chat_room::NewSeat::for_test("Codex", ChatAgent::Codex),
        )
        .unwrap();
        let seat_key = crate::chat_room::seat_session_key("chat-a", &seat.id);

        put(
            &m,
            "chat-a",
            still_session(false, Duration::from_secs(20 * 60)),
        );
        put(&m, &seat_key, still_session(true, Duration::from_secs(60)));

        let ended = sweep_still_chats(&m, FIFTEEN);

        assert_eq!(ended, vec!["chat-a".to_string()], "only the host went");
        assert_eq!(
            chat_list_impl(&m).unwrap(),
            vec![seat_key],
            "the seat is still there, writing its answer"
        );
    }

    #[test]
    fn a_restart_ends_the_room_as_one_thing() {
        // The same reason the sweeper does it: a host ended alone leaves seats
        // running against nobody, holding their memory until the server goes.
        // Pressing a button labelled "restart agent" must not be the way to
        // leak half a gigabyte.
        let m = ChatManager::default();
        let seat = crate::chat_room::add_seat_impl(
            &m,
            "restart-room",
            crate::chat_room::NewSeat::for_test("Codex", ChatAgent::Codex),
        )
        .expect("a seat to sit down");
        let seat_key = crate::chat_room::seat_session_key("restart-room", &seat.id);

        put(&m, "restart-room", still_session(false, Duration::ZERO));
        put(&m, &seat_key, still_session(false, Duration::ZERO));

        assert_eq!(
            chat_restart_impl(&m, "restart-room".into()),
            Ok(2),
            "the host and the one sitting with it"
        );
        assert!(chat_list_impl(&m).unwrap().is_empty());
        assert_eq!(
            crate::chat_room::room_impl(&m, "restart-room")
                .unwrap()
                .seats
                .len(),
            1,
            "and the ROSTER stays — the seat is coming back with everyone else"
        );
    }

    #[test]
    fn a_restart_ends_a_seat_the_sweeper_would_spare() {
        // The sweeper leaves a seat mid-answer because it is GUESSING at
        // whether a quiet room is finished. Nobody is guessing here, and a seat
        // that lived through the restart would be the one thing it was pressed
        // to be rid of: a process still holding the old set of tools.
        let m = ChatManager::default();
        let seat = crate::chat_room::add_seat_impl(
            &m,
            "restart-busy",
            crate::chat_room::NewSeat::for_test("Codex", ChatAgent::Codex),
        )
        .unwrap();
        let seat_key = crate::chat_room::seat_session_key("restart-busy", &seat.id);

        put(&m, "restart-busy", still_session(false, Duration::ZERO));
        put(&m, &seat_key, still_session(true, Duration::ZERO));

        assert_eq!(chat_restart_impl(&m, "restart-busy".into()), Ok(2));
        assert!(
            chat_list_impl(&m).unwrap().is_empty(),
            "the answering seat went too"
        );
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
    fn both_agents_full_stops_end_a_turn_and_nothing_else_does() {
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
        // `turn.completed` carries a usage block and NOTHING else. This is why
        // a Codex seat in a round said its piece, was never heard, and was
        // written down as "did not answer in time" twenty minutes later.
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
    fn both_agents_name_the_conversation_they_opened() {
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
    fn a_host_the_backend_never_started_cannot_be_started_by_it() {
        // The honest limit of `send_to_host`. Nothing down here knows which
        // model to pick or which folders to open, and guessing would start the
        // wrong agent on the wrong project.
        let manager = Arc::new(ChatManager::default());
        let why = send_to_host(manager, "chat-never-seen", "what did they say?")
            .expect_err("there is no chat and no record of one");

        assert!(why.contains("chat-never-seen"), "{why}");
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

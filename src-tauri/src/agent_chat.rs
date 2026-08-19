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

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

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

struct ChatSession {
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
pub struct ChatManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<ChatSession>>>>,
}

/// Which agents this module can start. The name from the UI only ever picks
/// between these literals — it is never interpolated into the command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatAgent {
    Claude,
    Codex,
}

impl ChatAgent {
    fn bin(self) -> &'static str {
        match self {
            ChatAgent::Claude => "claude",
            ChatAgent::Codex => "codex",
        }
    }
}

/// Single-quote a value for the login shell that launches the agent.
///
/// Everything the UI can influence — a model alias, a working directory, the
/// first prompt — goes through here. Inside single quotes a POSIX shell expands
/// nothing at all, so the only character that needs care is the quote itself.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Model aliases we will pass on. An unknown value is dropped rather than
/// forwarded: the model name reaches a command line, so it is an allowlist, not
/// an escaping problem.
fn safe_model(model: &str) -> Option<String> {
    let ok = model
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_');
    if ok && !model.is_empty() && model.len() <= 64 {
        Some(model.to_string())
    } else {
        None
    }
}

/// Session ids are uuids the agent gave us. Checked, not escaped: like the
/// model name it lands on a command line, so the shape is the guard.
fn safe_session_id(id: &str) -> Option<String> {
    let ok = id.len() <= 64
        && !id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| id.to_string())
}

/// Reasoning effort, per agent.
///
/// Both support the idea and neither spells it the same way: Claude takes
/// `--effort`, Codex takes a config override. The levels differ too — Codex has
/// a `minimal` that Claude does not, Claude has a `max` that Codex does not —
/// so the UI offers each agent its own list and this refuses anything else.
/// Same reasoning as the model allowlist: it reaches a command line.
fn safe_effort(agent: ChatAgent, level: &str) -> Option<&'static str> {
    match (agent, level) {
        (_, "low") => Some("low"),
        (_, "medium") => Some("medium"),
        (_, "high") => Some("high"),
        (_, "xhigh") => Some("xhigh"),
        (ChatAgent::Claude, "max") => Some("max"),
        (ChatAgent::Codex, "minimal") => Some("minimal"),
        _ => None,
    }
}

/// How much the agent may do unattended, as ONE idea across both agents.
///
/// The UI asks one question — look only, edit files, or anything — because that
/// is the decision the user is actually making. Each agent then gets its own
/// flag for it: Claude a permission mode, Codex a sandbox policy. Mapping here
/// rather than in the UI keeps the two spellings out of the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    /// Look and plan, change nothing.
    Read,
    /// Edit files in the project without asking.
    Edit,
    /// Run anything without asking.
    Full,
}

impl Access {
    /// Claude's `--permission-mode` value.
    fn claude(self) -> &'static str {
        match self {
            Access::Read => "plan",
            Access::Edit => "acceptEdits",
            Access::Full => "bypassPermissions",
        }
    }

    /// What the PreToolUse hook is told, in `OCTIQ_ACCESS`.
    ///
    /// The hook runs BEFORE `--permission-mode` is consulted — it is the first
    /// step of the permission chain — so "run anything without asking" never
    /// reaches it through that flag, and the hook went on asking about every
    /// command even under bypassPermissions. It has to be told separately.
    fn as_env(self) -> &'static str {
        match self {
            Access::Read => "read",
            Access::Edit => "edit",
            Access::Full => "full",
        }
    }

    /// Codex's `--sandbox` value. `workspace-write` is the direct match for
    /// "edit files": writes inside the workspace, nothing outside it.
    fn codex(self) -> &'static str {
        match self {
            Access::Read => "read-only",
            Access::Edit => "workspace-write",
            Access::Full => "danger-full-access",
        }
    }
}

/// Build the agent's command line.
///
/// Claude speaks stream-json in both directions, so one process handles the
/// whole conversation. Codex's `exec --json` is one-shot, so a Codex chat sends
/// its prompt on the command line and the session ends with the answer; the UI
/// starts a new one for the next turn.
fn build_command(
    agent: ChatAgent,
    model: Option<&str>,
    access: Option<Access>,
    prompt: &str,
    resume: Option<&str>,
    extra_dirs: &[String],
    effort: Option<&str>,
    images: &[String],
) -> String {
    match agent {
        ChatAgent::Claude => {
            let mut cmd = String::from(
                "claude -p --output-format stream-json --input-format stream-json \
                 --include-partial-messages --replay-user-messages --verbose",
            );
            // Continuing an earlier conversation: the agent comes back with its
            // own context, rather than being handed a transcript to read.
            if let Some(id) = resume.and_then(|id| safe_session_id(id)) {
                cmd.push_str(&format!(" --resume {}", sh_quote(&id)));
            }
            if let Some(m) = model.and_then(|m| safe_model(m)) {
                cmd.push_str(&format!(" --model {}", sh_quote(&m)));
            }
            if let Some(a) = access {
                cmd.push_str(&format!(" --permission-mode {}", a.claude()));
            }
            if let Some(e) = effort.and_then(|e| safe_effort(agent, e)) {
                cmd.push_str(&format!(" --effort {e}"));
            }
            // The permission hook, so the agent can ask rather than being told
            // in advance. Skipped silently if it could not be written.
            if let Some(settings) = permission_settings() {
                cmd.push_str(&format!(
                    " --settings {}",
                    sh_quote(&settings.to_string_lossy())
                ));
            }
            // The ask-user tool, plus the sentence that makes the agent reach
            // for it. It is pre-approved: a tool whose whole purpose is to ask
            // the user must not itself raise a permission question.
            if let Some(mcp) = ask_mcp_config() {
                cmd.push_str(&format!(
                    " --mcp-config {} --allowedTools {} --append-system-prompt {}",
                    sh_quote(&mcp.to_string_lossy()),
                    sh_quote("mcp__octiq__ask_user"),
                    sh_quote(ASK_PROMPT),
                ));
            }
            // A project can group several folders. The agent starts in one of
            // them (`cwd`) and can already read that one; every OTHER folder of
            // the project has to be named or the agent cannot touch it.
            for dir in extra_dirs {
                cmd.push_str(&format!(" --add-dir {}", sh_quote(dir)));
            }
            cmd
        }
        ChatAgent::Codex => {
            // Codex ends after each turn, so every turn is a new process. That
            // makes continuing a conversation a RESUME rather than something
            // written to a running stdin — `codex exec resume <id> <prompt>`,
            // where the id is the `thread_id` from its own `thread.started`.
            //
            // The resume subcommand takes a narrower set of flags than a fresh
            // exec: no `--sandbox`, no `--add-dir`. Both have config keys
            // instead, so the same settings are expressed with `-c` and the
            // conversation is kept.
            let resuming = resume.and_then(|id| safe_session_id(id));
            let mut cmd = match &resuming {
                Some(id) => format!("codex exec resume --json {}", sh_quote(id)),
                None => String::from("codex exec --json"),
            };
            if let Some(m) = model.and_then(|m| safe_model(m)) {
                cmd.push_str(&format!(" -m {}", sh_quote(&m)));
            }
            // Codex calls it a sandbox policy rather than a permission mode,
            // but it answers the same question.
            if let Some(a) = access {
                if resuming.is_some() {
                    cmd.push_str(&format!(" -c sandbox_mode={}", sh_quote(a.codex())));
                } else {
                    cmd.push_str(&format!(" --sandbox {}", a.codex()));
                }
            }
            // Effort has no flag of its own on either form: it is a config key.
            // The value comes from the allowlist, so it is a bare word — which
            // fails to parse as TOML and is taken as the literal string, which
            // is what we want.
            if let Some(e) = effort.and_then(|e| safe_effort(agent, e)) {
                cmd.push_str(&format!(" -c model_reasoning_effort={}", sh_quote(e)));
            }
            // Extra folders: the same idea as Claude's, and the reason a chat
            // in a multi-folder project can reach all of it.
            for dir in extra_dirs {
                if resuming.is_some() {
                    // `--add-dir` is not offered on resume; the config key is.
                    cmd.push_str(&format!(
                        " -c sandbox_workspace_write.writable_roots={}",
                        sh_quote(&format!("[\"{dir}\"]"))
                    ));
                } else {
                    cmd.push_str(&format!(" --add-dir {}", sh_quote(dir)));
                }
            }
            // Images are FILES on the command line here, where Claude takes
            // them inline on stdin (see write_user_message). Same attachment
            // either way — only the delivery differs.
            for path in images {
                cmd.push_str(&format!(" -i {}", sh_quote(path)));
            }
            cmd.push(' ');
            cmd.push_str(&sh_quote(prompt));
            cmd
        }
    }
}

/// Start a chat session. `key` names it for every later call, exactly as a PTY
/// id does. Starting a key that already runs is an error, not a silent replace —
/// a second process on the same key would interleave two conversations.
#[tauri::command]
pub fn chat_start(
    manager: State<Arc<ChatManager>>,
    key: String,
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    prompt: Option<String>,
    resume: Option<String>,
    // The project's other folders, so a chat sees the whole project and not
    // just the folder it starts in. See build_command.
    extra_dirs: Option<Vec<String>>,
    // Reasoning effort (Claude only), fixed for the life of the process.
    effort: Option<String>,
    // Image files to attach to the first turn.
    images: Option<Vec<String>>,
) -> Result<(), String> {
    chat_start_impl(
        manager.inner().clone(),
        key,
        cwd,
        agent,
        model,
        access,
        prompt,
        resume,
        extra_dirs,
        effort,
        images,
    )
}

/// Start a chat. The Tauri-free half of `chat_start`, so a headless server can
/// call exactly the same code path rather than a copy of it.
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
) -> Result<(), String> {
    let manager_for_exit = manager.clone();
    {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(&key) {
            return Err(format!("chat '{key}' is already running"));
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
        // Claude reads every turn off stdin, so it needs a pipe. Codex must
        // NOT have one: `codex exec` treats piped stdin as MORE INPUT to append
        // to the prompt, so an open pipe leaves it sitting on
        // "Reading additional input from stdin..." waiting for an end that
        // never comes. Its prompt is on the command line; there is nothing to
        // send it.
        // The hook answers only for agents we started, and needs to know
        // which chat is asking so the UI can attach the question to it.
        .env("OCTIQ_CHAT_KEY", &key)
        // What the person chose. The hook cannot read --permission-mode, and on
        // bypassPermissions it must step aside rather than ask about every command.
        // Unset means the most cautious of the three, not the most permissive:
        // a missing value must never be the one that stops the asking.
        .env("OCTIQ_ACCESS", access.map(Access::as_env).unwrap_or("read"))
        .stdin(match agent {
            ChatAgent::Claude => Stdio::piped(),
            ChatAgent::Codex => Stdio::null(),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", agent.bin()))?;

    let stdout = child.stdout.take().ok_or("no stdout on the agent process")?;
    let stderr = child.stderr.take().ok_or("no stderr on the agent process")?;
    let stdin = child.stdin.take();

    let session = Arc::new(Mutex::new(ChatSession { child, stdin }));
    manager
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(key.clone(), session.clone());

    // stdout: one JSON object per line, passed through as-is.
    {
        let key = key.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(event) => {
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
                    Err(_) => crate::bus::emit("chat-status",
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
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() || is_expected_chatter(&line) {
                    continue;
                }
                crate::bus::emit("chat-status",
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
                    let Ok(mut s) = session.lock() else { break None };
                    s.child.try_wait().ok().flatten()
                };
                match status {
                    Some(st) => break st.code(),
                    None => thread::sleep(std::time::Duration::from_millis(200)),
                }
            };
            crate::bus::emit("chat-status",
                ChatStatus {
                    key: key.clone(),
                    kind: "exit".into(),
                    text: String::new(),
                    code,
                },
            );
            // Forget the session now it is gone, so its key is free to be
            // started again. The manager is held by Arc rather than looked up
            // through an AppHandle: this thread outlives the call, and a
            // headless server has no app to look anything up in.
            manager_for_exit.sessions.lock().ok().map(|mut m| m.remove(&key));
        });
    }

    // Claude's first turn rides in on stdin like every later one, so the send
    // path is the same code for turn 1 and turn 9. Codex already has the prompt
    // on its command line.
    if agent == ChatAgent::Claude && !prompt.trim().is_empty() {
        write_user_message(&session, &prompt, &images)?;
    }

    Ok(())
}

/// Lines an agent writes to stderr as a matter of course, which are noise here.
///
/// `codex exec` announces "Reading additional input from stdin..." whenever its
/// stdin is not a terminal — which is always, for a process we spawned. Nothing
/// is wrong and nothing is waiting: it reads EOF and carries on. Showing it as
/// a notice on every Codex turn trains the user to ignore notices, which is
/// exactly what a real one needs them not to do.
fn is_expected_chatter(line: &str) -> bool {
    let line = line.trim();
    line.starts_with("Reading additional input from stdin")
}

/// The media type for an image path, or None when it is not an image we can
/// hand to the model. Anthropic accepts these four and nothing else.
fn image_media_type(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Read an image off disk as a base64 content block. `None` when it is not a
/// readable image — a failed attachment must not stop the message being sent.
fn image_block(path: &str) -> Option<Value> {
    use base64::Engine;
    let media_type = image_media_type(path)?;
    let bytes = std::fs::read(path).ok()?;
    // A ceiling, because this whole payload goes down a pipe as one line.
    if bytes.is_empty() || bytes.len() > 12 * 1024 * 1024 {
        return None;
    }
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(json!({
        "type": "image",
        "source": { "type": "base64", "media_type": media_type, "data": data }
    }))
}

/// Write one user message to a Claude session's stdin, in the shape
/// `--input-format stream-json` expects.
///
/// Images go in as content blocks beside the text, which is how the model
/// actually SEES them — as opposed to being told a path and having to open it
/// with a tool. They come first: a picture followed by the question about it
/// reads better to a model than the reverse.
fn write_user_message(
    session: &Arc<Mutex<ChatSession>>,
    text: &str,
    images: &[String],
) -> Result<(), String> {
    let mut content: Vec<Value> = images.iter().filter_map(|p| image_block(p)).collect();
    content.push(json!({ "type": "text", "text": text }));
    let payload = json!({
        "type": "user",
        "message": { "role": "user", "content": content }
    });
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let stdin = guard
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Send the next user turn to a running chat, with any images attached to it.
#[tauri::command]
pub fn chat_send(
    manager: State<Arc<ChatManager>>,
    key: String,
    text: String,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    chat_send_impl(&manager, key, text, images)
}

/// The Tauri-free half of `chat_send`.
pub fn chat_send_impl(
    manager: &ChatManager,
    key: String,
    text: String,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&key).cloned().ok_or("no such chat")?
    };
    write_user_message(&session, &text, &images.unwrap_or_default())
}

/// Ask the agent to stop what it is doing, WITHOUT ending the conversation.
///
/// Claude's init event advertises `interrupt_receipt_v1`, so the running turn
/// can be cancelled over the same stdin the prompts go down and the session
/// stays alive with its context. Killing the process would work too and is what
/// `chat_stop` does — but it throws the conversation away, which is a heavy
/// price for "actually, stop".
#[tauri::command]
pub fn chat_interrupt(manager: State<Arc<ChatManager>>, key: String) -> Result<(), String> {
    chat_interrupt_impl(&manager, key)
}

/// The Tauri-free half of `chat_interrupt`.
pub fn chat_interrupt_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&key).cloned().ok_or("no such chat")?
    };
    let payload = json!({
        "type": "control_request",
        "request_id": format!("int-{}", uuid::Uuid::new_v4()),
        "request": { "subtype": "interrupt" }
    });
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let stdin = guard
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Stop a chat and drop it. Killing an unknown key is a no-op success, so the
/// UI can close a chat twice without caring.
#[tauri::command]
pub fn chat_stop(manager: State<Arc<ChatManager>>, key: String) -> Result<(), String> {
    chat_stop_impl(&manager, key)
}

/// The Tauri-free half of `chat_stop`.
pub fn chat_stop_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    let session = {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&key)
    };
    let Some(session) = session else { return Ok(()) };
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    // Closing stdin asks Claude to finish; the kill is the backstop.
    guard.stdin.take();
    let _ = guard.child.kill();
    Ok(())
}

/// The hook that lets a chat ask the user for permission, and the settings
/// file that carries it.
///
/// Passed with `--settings` to the agents WE start, never installed into
/// `~/.claude/settings.json`. A hook in the global config would sit in the path
/// of every Claude Code the user runs, including the terminal they are typing
/// in right now — and one that blocks waiting for a browser would be a bad day.
/// This way it applies to OctiqFlow chats and nothing else.
const PERMISSION_HOOK: &str = include_str!("../../scripts/hooks/permission-ask.cjs");

/// An MCP server whose only tool lets the agent ask the user something.
///
/// Print mode is never offered `AskUserQuestion` — it has nobody to answer, so
/// the tool never reaches the model. It does load MCP servers in full, so this
/// hands it one of ours instead.
const ASK_MCP: &str = include_str!("../../scripts/mcp/octiq-ask.cjs");

/// Told to the agent so it knows the tool is there and when it is wanted.
/// Without this it has a tool it never thinks to reach for.
const ASK_PROMPT: &str = "When a decision is the user's to make rather than yours — which of several approaches to take, what something should be called, whether an assumption you are about to build on is right — call the `ask_user` tool and wait for their answer. Prefer it over guessing and over stopping to ask in prose: they may be on a phone, and it puts the question in front of them wherever they are.";

/// Write the ask-user MCP server and its config, and return the config path.
///
/// Rewritten on every start, like the hook, so an upgraded OctiqFlow cannot
/// leave an old copy behind. Best-effort: without it the chat simply runs
/// without the tool, which is how it behaved before this existed.
fn ask_mcp_config() -> Option<std::path::PathBuf> {
    let dir = crate::paths::home_dir()?.join(".octiqflow").join("mcp");
    std::fs::create_dir_all(&dir).ok()?;

    let script = dir.join("octiq-ask.cjs");
    std::fs::write(&script, ASK_MCP).ok()?;

    let config = dir.join("octiq-ask.json");
    let body = json!({
        "mcpServers": {
            "octiq": {
                "command": "node",
                "args": [script.to_string_lossy()],
            }
        }
    });
    std::fs::write(&config, serde_json::to_vec_pretty(&body).ok()?).ok()?;
    Some(config)
}

/// Write the hook and its settings file, and return the settings path.
///
/// Rewritten on every start so an upgraded OctiqFlow cannot leave an old hook
/// behind. Best-effort: if any of it fails the chat starts without the hook,
/// which is exactly how it behaved before this existed.
fn permission_settings() -> Option<std::path::PathBuf> {
    let dir = crate::paths::home_dir()?.join(".octiqflow").join("hooks");
    std::fs::create_dir_all(&dir).ok()?;

    let script = dir.join("permission-ask.cjs");
    std::fs::write(&script, PERMISSION_HOOK).ok()?;

    let settings = dir.join("claude-permission.json");
    let body = json!({
        "hooks": {
            "PreToolUse": [{
                // No matcher: every tool asks. Which tools NEED asking is
                // Claude's own decision — it only raises PreToolUse for calls
                // that are not already permitted by the mode.
                "hooks": [{
                    "type": "command",
                    "command": format!("node {}", script.to_string_lossy()),
                }]
            }]
        }
    });
    std::fs::write(&settings, serde_json::to_vec_pretty(&body).ok()?).ok()?;
    Some(settings)
}

/// Where pasted images are kept. Under `~/.octiqflow` rather than in the
/// project, because a screenshot you pasted into a chat is not part of anyone's
/// repository and must never turn up in `git status`.
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
#[tauri::command]
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
#[tauri::command]
pub fn chat_index_list() -> Vec<crate::chat_index::ChatMeta> {
    crate::chat_index::list()
}

/// Record a chat, or update what is known about it.
#[tauri::command]
pub fn chat_index_save(meta: crate::chat_index::ChatMeta) -> Result<(), String> {
    crate::chat_index::upsert(meta)
}

/// Forget a chat entirely — its entry in the list and its transcript.
#[tauri::command]
pub fn chat_index_remove(id: String, key: String) -> Result<(), String> {
    crate::transcript::forget(&key);
    crate::chat_index::remove(&id)
}

/// Everything a chat said after `after`.
///
/// How a client catches up. It remembers the highest seq it has seen and asks
/// for the rest — after a reconnect, a reload, or on a second device that has
/// never seen this conversation at all.
#[tauri::command]
pub fn chat_since(key: String, after: u64) -> Vec<crate::transcript::Recorded> {
    crate::transcript::since(&key, after)
}

/// Throw away a chat's record. Deleting a conversation should leave nothing.
#[tauri::command]
pub fn chat_forget(key: String) {
    crate::transcript::forget(&key);
}

/// The keys of every running chat. A reconnecting browser uses this the way it
/// uses pty_active_sessions: to find what is already going.
#[tauri::command]
pub fn chat_list(manager: State<Arc<ChatManager>>) -> Result<Vec<String>, String> {
    chat_list_impl(&manager)
}

/// The Tauri-free half of `chat_list`.
pub fn chat_list_impl(manager: &ChatManager) -> Result<Vec<String>, String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.keys().cloned().collect())
}

#[cfg(test)]
mod tests {

    #[test]
    fn full_access_is_named_in_the_environment_the_hook_reads() {
        // The PreToolUse hook runs BEFORE --permission-mode is consulted, so
        // "run anything without asking" cannot reach it through that flag. It
        // has to be told separately or it keeps asking under bypassPermissions.
        assert_eq!(Access::Full.as_env(), "full");
        assert_eq!(Access::Edit.as_env(), "edit");
        assert_eq!(Access::Read.as_env(), "read");
    }
    use super::*;

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
        assert_eq!(safe_model("claude-fable-5").as_deref(), Some("claude-fable-5"));
        assert_eq!(safe_model("gpt-5.6-sol").as_deref(), Some("gpt-5.6-sol"));
        // Anything that could become another shell word is refused outright.
        assert_eq!(safe_model("opus; id"), None);
        assert_eq!(safe_model("$(id)"), None);
        assert_eq!(safe_model(""), None);
    }

    #[test]
    fn resume_only_takes_a_plain_id() {
        let id = "a2c8ca18-dcd4-41bc-a49d-b078f2a8e056";
        let c = build_command(ChatAgent::Claude, None, None, "", Some(id), &[], None, &[]);
        assert!(c.contains(&format!("--resume '{id}'")));
        // Anything that could become a second shell word is dropped outright.
        let bad = build_command(ChatAgent::Claude, None, None, "", Some("x; rm -rf /"), &[], None, &[]);
        assert!(!bad.contains("--resume"));
    }

    #[test]
    fn one_access_level_becomes_each_agents_own_flag() {
        // The same question — how much may it do unattended — asked once and
        // spelled differently for each agent.
        for (level, claude, codex) in [
            (Access::Read, "plan", "read-only"),
            (Access::Edit, "acceptEdits", "workspace-write"),
            (Access::Full, "bypassPermissions", "danger-full-access"),
        ] {
            let c = build_command(ChatAgent::Claude, None, Some(level), "", None, &[], None, &[]);
            assert!(c.contains(&format!("--permission-mode {claude}")), "claude {level:?}");
            assert!(!c.contains("--sandbox"), "claude must not get a sandbox flag");

            let x = build_command(ChatAgent::Codex, None, Some(level), "hi", None, &[], None, &[]);
            assert!(x.contains(&format!("--sandbox {codex}")), "codex {level:?}");
            assert!(!x.contains("--permission-mode"), "codex must not get a permission mode");
        }
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
        );
        assert!(c.contains("--input-format stream-json"));
        assert!(c.contains("--model 'opus'"));
        assert!(c.contains("--permission-mode plan"));
        // Claude's prompt goes over stdin, never on the command line.
        assert!(!c.contains(prompt));

        let x = build_command(ChatAgent::Codex, None, None, "hi there", None, &[], None, &[]);
        assert!(x.contains("codex exec --json"));
        assert!(x.ends_with("'hi there'"));
    }

    #[test]
    fn effort_is_an_allowlist_and_spelled_per_agent() {
        let c = build_command(ChatAgent::Claude, None, None, "", None, &[], Some("xhigh"), &[]);
        assert!(c.contains("--effort xhigh"));
        // Codex supports it too, but only as a config override.
        let x = build_command(ChatAgent::Codex, None, None, "hi", None, &[], Some("xhigh"), &[]);
        assert!(x.contains("-c model_reasoning_effort='xhigh'"));
        assert!(!x.contains("--effort"));

        // Anything outside the set is dropped rather than forwarded.
        let bad = build_command(ChatAgent::Claude, None, None, "", None, &[], Some("turbo; id"), &[]);
        assert!(!bad.contains("--effort"));

        // The levels are not the same on both sides: `max` is Claude's alone,
        // `minimal` is Codex's alone, and each is refused for the other.
        let claude_max = build_command(ChatAgent::Claude, None, None, "", None, &[], Some("max"), &[]);
        assert!(claude_max.contains("--effort max"));
        let codex_max = build_command(ChatAgent::Codex, None, None, "hi", None, &[], Some("max"), &[]);
        assert!(!codex_max.contains("model_reasoning_effort"));
        let codex_min = build_command(ChatAgent::Codex, None, None, "hi", None, &[], Some("minimal"), &[]);
        assert!(codex_min.contains("model_reasoning_effort='minimal'"));
        let claude_min = build_command(ChatAgent::Claude, None, None, "", None, &[], Some("minimal"), &[]);
        assert!(!claude_min.contains("--effort"));
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
        );
        assert!(first.starts_with("codex exec --json"));
        assert!(!first.contains("resume"));
        assert!(first.contains("--sandbox read-only"));
        assert!(first.contains("--add-dir '/tmp/api'"));
    }

    #[test]
    fn the_stdin_notice_codex_always_prints_is_not_a_notice() {
        assert!(is_expected_chatter("Reading additional input from stdin..."));
        assert!(is_expected_chatter("  Reading additional input from stdin... "));
        // Anything else still reaches the user — that is the whole point of
        // surfacing stderr.
        assert!(!is_expected_chatter("Error loading config.toml"));
        assert!(!is_expected_chatter("You've hit your usage limit."));
    }

    #[test]
    fn codex_takes_images_as_files_and_claude_does_not() {
        let shots = vec!["/tmp/a shot.png".to_string(), "/tmp/b.webp".to_string()];
        let x = build_command(ChatAgent::Codex, None, None, "look", None, &[], None, &shots);
        // Quoted, so a space in the name stays one argument.
        assert!(x.contains("-i '/tmp/a shot.png'"));
        assert!(x.contains("-i '/tmp/b.webp'"));
        // ...and the prompt still ends the line, after the images.
        assert!(x.ends_with("'look'"));

        // Claude's images ride on stdin instead — see write_user_message.
        let c = build_command(ChatAgent::Claude, None, None, "look", None, &[], None, &shots);
        assert!(!c.contains("-i "));
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
        let dirs = vec![
            "/Users/me/api".to_string(),
            "/Users/me/my docs".to_string(),
        ];
        let c = build_command(ChatAgent::Claude, None, None, "", None, &dirs, None, &[]);
        assert!(c.contains("--add-dir '/Users/me/api'"));
        // A space in a folder name stays one argument.
        assert!(c.contains("--add-dir '/Users/me/my docs'"));

        // Codex takes extra folders too — it was a mistake to think otherwise.
        let x = build_command(ChatAgent::Codex, None, None, "hi", None, &dirs, None, &[]);
        assert!(x.contains("--add-dir '/Users/me/api'"));
        assert!(x.contains("--add-dir '/Users/me/my docs'"));
    }
}

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
use tauri::{AppHandle, State};

/// One line of an agent's stdout, on its way to the UI.
#[derive(Clone, Serialize)]
struct ChatEvent {
    /// The chat this came from (the frontend picks the key at start time, the
    /// same way it picks PTY ids).
    key: String,
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

/// Permission modes Claude accepts. Same reasoning as the model allowlist.
fn safe_permission_mode(mode: &str) -> Option<&'static str> {
    match mode {
        "acceptEdits" => Some("acceptEdits"),
        "bypassPermissions" => Some("bypassPermissions"),
        "plan" => Some("plan"),
        "dontAsk" => Some("dontAsk"),
        "auto" => Some("auto"),
        "manual" => Some("manual"),
        _ => None,
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
    permission_mode: Option<&str>,
    prompt: &str,
    resume: Option<&str>,
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
            if let Some(p) = permission_mode.and_then(safe_permission_mode) {
                cmd.push_str(&format!(" --permission-mode {p}"));
            }
            cmd
        }
        ChatAgent::Codex => {
            let mut cmd = String::from("codex exec --json");
            if let Some(m) = model.and_then(|m| safe_model(m)) {
                cmd.push_str(&format!(" -m {}", sh_quote(&m)));
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
    app: AppHandle,
    manager: State<ChatManager>,
    key: String,
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    permission_mode: Option<String>,
    prompt: Option<String>,
    resume: Option<String>,
) -> Result<(), String> {
    {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(&key) {
            return Err(format!("chat '{key}' is already running"));
        }
    }

    let prompt = prompt.unwrap_or_default();
    let line = build_command(
        agent,
        model.as_deref(),
        permission_mode.as_deref(),
        &prompt,
        resume.as_deref(),
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
        .stdin(Stdio::piped())
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
        let app = app.clone();
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
                    Ok(event) => crate::web::emit(
                        &app,
                        "chat-event",
                        ChatEvent {
                            key: key.clone(),
                            event,
                        },
                    ),
                    // A non-JSON line means the agent printed something we did
                    // not ask for (a login prompt, an update notice). Surface it
                    // rather than dropping it — it is usually the reason a chat
                    // produced nothing.
                    Err(_) => crate::web::emit(
                        &app,
                        "chat-status",
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
        let app = app.clone();
        let key = key.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                crate::web::emit(
                    &app,
                    "chat-status",
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
        let app = app.clone();
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
            crate::web::emit(
                &app,
                "chat-status",
                ChatStatus {
                    key: key.clone(),
                    kind: "exit".into(),
                    text: String::new(),
                    code,
                },
            );
            if let Some(app_state) = app_manager(&app) {
                app_state.sessions.lock().ok().map(|mut m| m.remove(&key));
            }
        });
    }

    // Claude's first turn rides in on stdin like every later one, so the send
    // path is the same code for turn 1 and turn 9. Codex already has the prompt
    // on its command line.
    if agent == ChatAgent::Claude && !prompt.trim().is_empty() {
        write_user_message(&session, &prompt)?;
    }

    Ok(())
}

fn app_manager(app: &AppHandle) -> Option<State<'_, ChatManager>> {
    use tauri::Manager;
    app.try_state::<ChatManager>()
}

/// Write one user message to a Claude session's stdin, in the shape
/// `--input-format stream-json` expects.
fn write_user_message(session: &Arc<Mutex<ChatSession>>, text: &str) -> Result<(), String> {
    let payload = json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    });
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let stdin = guard
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Send the next user turn to a running chat.
#[tauri::command]
pub fn chat_send(manager: State<ChatManager>, key: String, text: String) -> Result<(), String> {
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&key).cloned().ok_or("no such chat")?
    };
    write_user_message(&session, &text)
}

/// Ask the agent to stop what it is doing, WITHOUT ending the conversation.
///
/// Claude's init event advertises `interrupt_receipt_v1`, so the running turn
/// can be cancelled over the same stdin the prompts go down and the session
/// stays alive with its context. Killing the process would work too and is what
/// `chat_stop` does — but it throws the conversation away, which is a heavy
/// price for "actually, stop".
#[tauri::command]
pub fn chat_interrupt(manager: State<ChatManager>, key: String) -> Result<(), String> {
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
pub fn chat_stop(manager: State<ChatManager>, key: String) -> Result<(), String> {
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

/// The keys of every running chat. A reconnecting browser uses this the way it
/// uses pty_active_sessions: to find what is already going.
#[tauri::command]
pub fn chat_list(manager: State<ChatManager>) -> Result<Vec<String>, String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.keys().cloned().collect())
}

#[cfg(test)]
mod tests {
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
        let c = build_command(ChatAgent::Claude, None, None, "", Some(id));
        assert!(c.contains(&format!("--resume '{id}'")));
        // Anything that could become a second shell word is dropped outright.
        let bad = build_command(ChatAgent::Claude, None, None, "", Some("x; rm -rf /"));
        assert!(!bad.contains("--resume"));
    }

    #[test]
    fn permission_modes_are_fixed_strings() {
        assert_eq!(safe_permission_mode("plan"), Some("plan"));
        assert_eq!(safe_permission_mode("nonsense"), None);
    }

    #[test]
    fn claude_gets_a_two_way_stream_and_codex_gets_the_prompt() {
        let c = build_command(ChatAgent::Claude, Some("opus"), Some("plan"), "hi", None);
        assert!(c.contains("--input-format stream-json"));
        assert!(c.contains("--model 'opus'"));
        assert!(c.contains("--permission-mode plan"));
        // Claude's prompt goes over stdin, never on the command line.
        assert!(!c.contains("hi"));

        let x = build_command(ChatAgent::Codex, None, None, "hi there", None);
        assert!(x.contains("codex exec --json"));
        assert!(x.ends_with("'hi there'"));
    }
}

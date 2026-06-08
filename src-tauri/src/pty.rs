// Multi-PTY manager. Holds many independent PTY sessions keyed by a
// frontend-supplied String id. Each session runs a login shell ($SHELL -l,
// TERM=xterm-256color) inside its own pseudo-terminal, and streams output to
// the frontend as `pty-output` events tagged with the session id, so the
// frontend can render any number of terminals and route each chunk to the
// right one.
//
// Replaces the old single global PtyState. The boot terminal is now just one
// session the frontend spawns by id at startup.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// One live PTY session: the master (for resize), the writer (for input), and
/// the child process handle (so close can kill the whole shell + its children).
///
/// `needs_attention` is a shared flag the reader thread raises when it sees an
/// OSC 9 / OSC 777 sequence in the output. The same Arc lives here so
/// `pty_clear_attention` can lower it. SeqCst is plenty for a single bool.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    needs_attention: Arc<AtomicBool>,
}

/// Holds every live PTY session, keyed by the id the frontend gave at spawn.
/// Managed by Tauri so all commands can reach it via `State`.
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

/// Payload for the `pty-output` event. The frontend matches `id` to the right
/// terminal and writes `chunk` into it.
#[derive(Clone, Serialize)]
struct OutputEvent {
    id: String,
    chunk: String,
}

/// Payload for the `pty-attention` event, raised when the reader spots an
/// OSC 9 / OSC 777 sequence. `title` is empty for OSC 9 (it carries body only).
#[derive(Clone, Serialize)]
struct AttentionEvent {
    id: String,
    title: String,
    body: String,
}

/// Scan one decoded output chunk for OSC 9 / OSC 777 attention sequences and
/// return the (title, body) pairs found, in order.
///
/// Shapes handled (terminator is BEL 0x07 or ST = ESC `\`):
/// - OSC 9:   ESC ] 9 ; <body>            -> ("", body)
/// - OSC 777: ESC ] 777 ; notify ; <title> ; <body>  -> (title, body)
///
/// Best-effort, per-chunk matching. A sequence split across two reads (its ESC
/// in one chunk and its terminator in the next) will be missed — fine for alpha.
fn scan_attention(chunk: &str) -> Vec<(String, String)> {
    let mut hits = Vec::new();
    let bytes = chunk.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Find the next OSC introducer: ESC (0x1B) followed by ']'.
        if bytes[i] != 0x1b || i + 1 >= bytes.len() || bytes[i + 1] != b']' {
            i += 1;
            continue;
        }
        let body_start = i + 2;
        // Locate the terminator: BEL, or ST (ESC `\`). Everything between the
        // introducer and the terminator is the OSC payload.
        let mut j = body_start;
        let mut term_end = None; // index just past the terminator
        while j < bytes.len() {
            if bytes[j] == 0x07 {
                term_end = Some(j + 1);
                break;
            }
            if bytes[j] == 0x1b && j + 1 < bytes.len() && bytes[j + 1] == b'\\' {
                term_end = Some(j + 2);
                break;
            }
            j += 1;
        }
        let Some(end) = term_end else {
            // No terminator in this chunk; stop — likely a split sequence.
            break;
        };
        let payload = &chunk[body_start..j];

        // OSC 777: "777;notify;<title>;<body>". OSC 9: "9;<body>".
        if let Some(rest) = payload.strip_prefix("777;notify;") {
            let mut parts = rest.splitn(2, ';');
            let title = parts.next().unwrap_or("").to_string();
            let body = parts.next().unwrap_or("").to_string();
            hits.push((title, body));
        } else if let Some(body) = payload.strip_prefix("9;") {
            hits.push((String::new(), body.to_string()));
        }

        i = end;
    }
    hits
}

/// Open a new PTY and spawn a login shell in it.
///
/// - `id`: caller-chosen key for this session. If a session with this id
///   already exists, this is a no-op success (the existing session is kept) so
///   a double-spawn from the frontend does not create a runaway shell.
/// - `cwd`: the working directory for the shell. Falls back to $HOME (then "/")
///   when empty. The path is set directly on the CommandBuilder — no `cd`, so
///   there is no shell string to escape.
/// - `start_cmd`: if Some, written into the shell + "\r" right after spawn (for
///   example, to launch an agent). Sent as raw bytes; the shell parses it.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: State<PtyManager>,
    id: String,
    cwd: String,
    start_cmd: Option<String>,
) -> Result<(), String> {
    {
        // Fast path: do not respawn an id that already exists.
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(&id) {
            return Ok(());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // A login shell so PATH is fully populated. A GUI app does not inherit the
    // interactive shell PATH, so `claude` would not be found if spawned
    // directly. The shell resolves it instead.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");

    let dir = if cwd.trim().is_empty() {
        std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
    } else {
        cwd
    };
    cmd.cwd(dir);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    // Optional kickoff command, sent as if typed at the prompt.
    if let Some(cmd_line) = start_cmd {
        if !cmd_line.is_empty() {
            writer
                .write_all(cmd_line.as_bytes())
                .map_err(|e| e.to_string())?;
            writer.write_all(b"\r").map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())?;
        }
    }

    // Shared attention flag. Lives in the Session (so the clear command can
    // lower it) and is cloned into the reader thread (so it can raise it).
    let needs_attention = Arc::new(AtomicBool::new(false));
    let attention_flag = needs_attention.clone();

    // Per-session reader thread: stream PTY output to the frontend, tagged with
    // this session's id. Ends on EOF (shell exited) or read error.
    let app_handle = app.clone();
    let emit_id = id.clone();
    let mut reader = reader;
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF: shell exited
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    // Look for OSC 9 / OSC 777 attention sequences. On a match,
                    // raise the flag and tell the frontend. We do NOT strip the
                    // sequence — `pty-output` still gets the chunk verbatim.
                    for (title, body) in scan_attention(&chunk) {
                        attention_flag.store(true, Ordering::SeqCst);
                        let _ = app_handle.emit(
                            "pty-attention",
                            AttentionEvent {
                                id: emit_id.clone(),
                                title,
                                body,
                            },
                        );
                    }
                    let _ = app_handle.emit(
                        "pty-output",
                        OutputEvent {
                            id: emit_id.clone(),
                            chunk,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    manager
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            id,
            Session {
                master: pair.master,
                writer,
                child,
                needs_attention,
            },
        );

    Ok(())
}

/// Write raw text into one session's PTY input. The shell cannot tell this from
/// real typing. Append "\r" to submit a line. Unknown id is an error.
#[tauri::command]
pub fn pty_write(manager: State<PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("no pty session: {id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resize one session's PTY so the program inside knows the new size. Unknown
/// id is an error.
#[tauri::command]
pub fn pty_resize(
    manager: State<PtyManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("no pty session: {id}"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Close one session: kill the child shell (and its children) and drop the
/// session from the map. The reader thread ends on the resulting EOF. Closing
/// an unknown id is a no-op success (idempotent).
#[tauri::command]
pub fn pty_close(manager: State<PtyManager>, id: String) -> Result<(), String> {
    let session = {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&id)
    };
    if let Some(mut session) = session {
        // Best-effort kill; the shell may already be gone.
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

/// List the ids of every live session. Order is unspecified (HashMap).
#[tauri::command]
pub fn pty_list_active(manager: State<PtyManager>) -> Result<Vec<String>, String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.keys().cloned().collect())
}

/// Lower one session's attention flag, called when the user focuses that
/// terminal. Unknown id is a no-op success (the flag may have been cleared by a
/// just-closed session).
#[tauri::command]
pub fn pty_clear_attention(manager: State<PtyManager>, id: String) -> Result<(), String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get(&id) {
        session.needs_attention.store(false, Ordering::SeqCst);
    }
    Ok(())
}

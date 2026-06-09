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

/// Upper bound on the OSC scan buffer's retained tail (bytes). An OSC
/// attention sequence is tiny; anything longer is plain output that can be
/// dropped, so the reader never holds unbounded scrollback.
const SCAN_TAIL_CAP: usize = 8 * 1024;

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

/// Scan a decoded buffer for OSC 9 / OSC 777 attention sequences.
///
/// Returns the hits found AND `keep_from`: the byte index from which the
/// caller should retain the tail for the next read. Everything before
/// `keep_from` is either an already-emitted hit or plain output that can
/// never start a sequence, so dropping it (a) stops the same hit being
/// re-emitted as the buffer grows and (b) bounds the retained buffer.
///
/// `keep_from` is, in priority order:
///   - the start of the last UNTERMINATED `ESC ]` introducer (a possible
///     split sequence whose terminator may arrive next read), else
///   - the end of the last COMPLETED terminator (all settled, drop it all),
///     else
///   - 0 (nothing matched and no trailing introducer — but the caller caps
///     the retained tail anyway, see the reader loop).
///
/// Shapes handled (terminator BEL 0x07 or ST = ESC `\`):
/// - OSC 9:   ESC ] 9 ; <body>                         -> ("", body)
/// - OSC 777: ESC ] 777 ; notify ; <title> ; <body>    -> (title, body)
fn scan_attention(buf: &str) -> (Vec<(String, String)>, usize) {
    let mut hits = Vec::new();
    let bytes = buf.as_bytes();
    let mut i = 0;
    let mut consumed = 0; // end (exclusive) of the last completed terminator
    let mut last_introducer = None; // start of a trailing unterminated ESC ]
    while i < bytes.len() {
        // Find the next OSC introducer: ESC (0x1B) followed by ']'.
        if bytes[i] != 0x1b || i + 1 >= bytes.len() || bytes[i + 1] != b']' {
            i += 1;
            continue;
        }
        let intro_start = i;
        let body_start = i + 2;
        // Locate the terminator: BEL, or ST (ESC `\`).
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
            // No terminator yet: this introducer may complete on the next
            // read. Remember it as the tail to keep, and stop scanning.
            last_introducer = Some(intro_start);
            break;
        };
        let payload = &buf[body_start..j];

        // OSC 777: "777;notify;<title>;<body>". OSC 9: "9;<body>".
        if let Some(rest) = payload.strip_prefix("777;notify;") {
            let mut parts = rest.splitn(2, ';');
            let title = parts.next().unwrap_or("").to_string();
            let body = parts.next().unwrap_or("").to_string();
            hits.push((title, body));
        } else if let Some(body) = payload.strip_prefix("9;") {
            hits.push((String::new(), body.to_string()));
        }

        consumed = end;
        i = end;
    }
    let keep_from = last_introducer.unwrap_or(consumed);
    (hits, keep_from)
}

/// Incrementally decode a PTY byte stream as UTF-8.
///
/// Returns the text for every COMPLETE UTF-8 sequence in `bytes`, plus any
/// trailing bytes that form an INCOMPLETE (but so far valid) multi-byte
/// sequence. The caller prepends those leftover bytes to the next read, so a
/// character split across a read boundary is decoded whole instead of being
/// turned into replacement chars.
///
/// This is the rule every real terminal follows: the PTY is ONE continuous byte
/// stream, so a multi-byte glyph (a box-drawing border, a braille spinner) that
/// straddles two reads must be held, not decoded in halves. Decoding each 4096-
/// byte read on its own — as `String::from_utf8_lossy` did — split those glyphs
/// at the boundary and showed "?" all over a Unicode-heavy TUI (e.g. the Claude
/// or Codex agent UIs).
///
/// Genuinely invalid bytes (an error that is NOT just an incomplete tail) are
/// replaced with U+FFFD, exactly like `from_utf8_lossy`, so one bad byte can
/// never stall the stream.
fn decode_utf8_stream(bytes: &[u8]) -> (String, Vec<u8>) {
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match std::str::from_utf8(&bytes[i..]) {
            Ok(valid) => {
                out.push_str(valid);
                return (out, Vec::new());
            }
            Err(err) => {
                let good = err.valid_up_to();
                if good > 0 {
                    // SAFETY: from_utf8 reported bytes[i..i+good] as valid UTF-8.
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&bytes[i..i + good]) });
                    i += good;
                }
                match err.error_len() {
                    // No error_len => an incomplete sequence at the very end.
                    // Hold the rest for the next read.
                    None => return (out, bytes[i..].to_vec()),
                    // A real invalid sequence mid-stream: emit a replacement,
                    // skip exactly those bytes, and keep decoding.
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        i += bad;
                    }
                }
            }
        }
    }
    (out, Vec::new())
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
        // Carry-over buffer so an OSC sequence split across two reads is still
        // detected. Holds only the unsettled tail (a partial introducer), so it
        // stays small; capped at SCAN_TAIL_CAP as a hard safety bound.
        let mut scan_buf = String::new();
        // Incomplete trailing UTF-8 bytes carried from the previous read, so a
        // multi-byte glyph split across the 4096-byte boundary is never decoded
        // in halves. Holds at most one partial UTF-8 sequence (a few bytes).
        let mut byte_carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF: shell exited
                Ok(n) => {
                    // Prepend the bytes held back from the previous read, decode
                    // only the complete UTF-8, and carry any incomplete tail to
                    // the next read (see decode_utf8_stream). This is what stops
                    // multi-byte glyphs from corrupting at read boundaries.
                    byte_carry.extend_from_slice(&buf[..n]);
                    let (chunk, tail) = decode_utf8_stream(&byte_carry);
                    byte_carry = tail;

                    // Append to the carry-over, scan the whole thing, emit any
                    // hits, then keep only the unsettled tail for the next read.
                    // scan_attention dedupes by advancing past matched
                    // terminators, so a hit is emitted exactly once.
                    scan_buf.push_str(&chunk);
                    let (hits, keep_from) = scan_attention(&scan_buf);
                    for (title, body) in hits {
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
                    // Drop the settled prefix; retain the tail. Then cap the
                    // tail so a stream of bare `ESC ]` with no terminator can
                    // never grow the buffer without bound. keep_from is a char
                    // boundary (see scan_attention), so this slice is valid.
                    if keep_from > 0 {
                        scan_buf.drain(..keep_from);
                    }
                    if scan_buf.len() > SCAN_TAIL_CAP {
                        let cut = scan_buf.len() - SCAN_TAIL_CAP;
                        // Move cut to the next char boundary so drain is valid.
                        let cut = (cut..=scan_buf.len())
                            .find(|&k| scan_buf.is_char_boundary(k))
                            .unwrap_or(scan_buf.len());
                        scan_buf.drain(..cut);
                    }

                    // pty-output ALWAYS streams the raw per-read chunk
                    // unchanged — the scan buffer never affects what is shown.
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

#[cfg(test)]
mod tests {
    use super::decode_utf8_stream;

    #[test]
    fn plain_ascii_decodes_whole_with_no_carry() {
        let (text, tail) = decode_utf8_stream(b"hello");
        assert_eq!(text, "hello");
        assert!(tail.is_empty());
    }

    #[test]
    fn complete_multibyte_decodes_whole_with_no_carry() {
        // "│" box-drawing (U+2502) is 3 bytes; "⠋" braille (U+280B) is 3 bytes.
        let (text, tail) = decode_utf8_stream("a│b⠋".as_bytes());
        assert_eq!(text, "a│b⠋");
        assert!(tail.is_empty());
    }

    #[test]
    fn multibyte_split_across_reads_is_carried_then_completed() {
        // "│" = E2 94 82. Split it: first read ends after E2 94, second read
        // brings the final 82. This is the exact 4096-byte-boundary case.
        let full = "x│".as_bytes(); // 78 E2 94 82
        let first = &full[..3]; // "x" + E2 94 (incomplete)
        let second = &full[3..]; // 82 (completes the glyph)

        let (text1, carry) = decode_utf8_stream(first);
        assert_eq!(text1, "x"); // only the complete part is emitted
        assert_eq!(carry, vec![0xE2, 0x94]); // the partial glyph is held

        // Caller prepends the carry to the next read before decoding.
        let mut next = carry;
        next.extend_from_slice(second);
        let (text2, carry2) = decode_utf8_stream(&next);
        assert_eq!(text2, "│"); // now whole — no replacement char
        assert!(carry2.is_empty());
    }

    #[test]
    fn genuinely_invalid_byte_becomes_replacement_and_does_not_stall() {
        // 0xFF is never valid UTF-8. It must not be carried forever; it becomes
        // U+FFFD and decoding continues past it.
        let (text, tail) = decode_utf8_stream(&[b'a', 0xFF, b'b']);
        assert_eq!(text, "a\u{FFFD}b");
        assert!(tail.is_empty());
    }
}

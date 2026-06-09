// Multi-PTY manager. Holds many independent PTY sessions keyed by a
// frontend-supplied String id. Each session runs a per-OS shell (a login shell
// $SHELL -l on Unix, powershell.exe on Windows; see resolve_shell) with
// TERM=xterm-256color inside its own pseudo-terminal, and streams output to
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
    /// The tab's stable persist key, if it carries one. Used to map a live
    /// session back to its saved resume mapping (agent_resume.rs).
    persist_key: Option<String>,
    /// The spawned shell's pid. At an idle prompt the PTY's foreground process
    /// group equals this; while an agent runs it differs — that is how we tell a
    /// tab's agent has exited. Only read on Unix.
    #[cfg_attr(not(unix), allow(dead_code))]
    shell_pid: Option<i32>,
}

impl Session {
    /// Whether an agent is currently the foreground process of this PTY (vs the
    /// shell sitting at its prompt). At the prompt the foreground process group
    /// equals the shell's own pid; an agent runs in its own group, a different
    /// pid. An unknown foreground or missing shell pid reports `true`, so we
    /// never treat a session we cannot positively disprove as exited.
    #[cfg(unix)]
    fn agent_running(&self) -> bool {
        match (self.master.process_group_leader(), self.shell_pid) {
            (Some(foreground), Some(shell)) => foreground != shell,
            _ => true,
        }
    }

    /// Non-Unix has no foreground-process-group query here, so we cannot tell an
    /// agent exited; report running so a mapping is never wrongly dropped.
    #[cfg(not(unix))]
    fn agent_running(&self) -> bool {
        true
    }
}

/// Holds every live PTY session, keyed by the id the frontend gave at spawn.
/// Managed by Tauri so all commands can reach it via `State`.
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

impl PtyManager {
    /// For every live session that carries a persist key, report whether an
    /// agent is currently its PTY's foreground process. Keyed by persist key so
    /// agent_resume.rs can clear the resume mapping of any tab whose agent has
    /// exited — the deterministic signal Codex gives no SessionEnd hook for.
    /// A poisoned lock yields an empty map (clear nothing).
    pub fn agent_foreground_by_key(&self) -> HashMap<String, bool> {
        let Ok(sessions) = self.sessions.lock() else {
            return HashMap::new();
        };
        sessions
            .values()
            .filter_map(|s| s.persist_key.clone().map(|k| (k, s.agent_running())))
            .collect()
    }
}

/// Payload for the `pty-output` event. The frontend matches `id` to the right
/// terminal and writes `chunk` into it.
#[derive(Clone, Serialize)]
struct OutputEvent {
    id: String,
    chunk: String,
}

/// Payload for the `pty-attention` event, raised when the reader spots an
/// OSC 9 / OSC 99 / OSC 777 sequence. `title` is empty for OSC 9 (it carries
/// body only) and for OSC 99 `p=body` chunks; `body` is empty for OSC 99
/// `p=title` chunks.
#[derive(Clone, Serialize)]
struct AttentionEvent {
    id: String,
    title: String,
    body: String,
}

/// Scan a decoded buffer for OSC 9 / OSC 99 / OSC 777 attention sequences.
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
/// - OSC 99:  ESC ] 99 ; <metadata> ; <text>           -> see `parse_osc99`
///   (Kitty's notification protocol; `<metadata>` is `key=value` pairs joined
///   by ':'. The text lands in the title or body slot per the `p` key.)
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

        // OSC 777: "777;notify;<title>;<body>". OSC 99: "99;<meta>;<text>"
        // (Kitty). OSC 9: "9;<body>". Check 99 before 9 — "9;" never matches a
        // "99;" payload (the char after the first '9' is '9', not ';'), but the
        // explicit order documents intent.
        if let Some(rest) = payload.strip_prefix("777;notify;") {
            let mut parts = rest.splitn(2, ';');
            let title = parts.next().unwrap_or("").to_string();
            let body = parts.next().unwrap_or("").to_string();
            hits.push((title, body));
        } else if let Some(rest) = payload.strip_prefix("99;") {
            if let Some(hit) = parse_osc99(rest) {
                hits.push(hit);
            }
        } else if let Some(body) = payload.strip_prefix("9;") {
            hits.push((String::new(), body.to_string()));
        }

        consumed = end;
        i = end;
    }
    let keep_from = last_introducer.unwrap_or(consumed);
    (hits, keep_from)
}

/// Parse the part of a Kitty OSC 99 sequence that follows `99;` into a single
/// `(title, body)` attention hit, or `None` when the chunk should NOT raise an
/// alert.
///
/// Kitty's notification protocol packs `<metadata>;<text>` where the metadata
/// is `key=value` pairs joined by ':'. The keys we read:
///   - `p` (payload type, default `title`): `title` and `body` carry the
///     human-readable alert text; every other value (`close`, `alive`, `icon`,
///     `buttons`, `?`, ...) is a control message with no text to show, so we
///     skip it.
///   - `d` (done, default `1`): `d=0` marks a non-final chunk of a multi-part
///     notification. Kitty does not display until the final chunk arrives, so we
///     skip `d=0` and let the closing chunk fire exactly one alert. (We do not
///     stitch a `d=0` title onto a later body — that needs cross-sequence state
///     this stateless scanner does not keep; the final chunk's own text fires.)
///   - `e` (encoding): `e=1` means `<text>` is standard base64. We decode it;
///     bad base64 yields `None` so a malformed sequence is dropped, not shown
///     as garbage.
///
/// A missing payload separator, an empty text, a control payload type, an
/// unfinished chunk, or undecodable base64 all return `None`.
fn parse_osc99(rest: &str) -> Option<(String, String)> {
    // Split metadata from text on the FIRST ';'. No separator => no payload to
    // show (e.g. a bare `99;p=close:i=1` control with no text).
    let (meta, text) = rest.split_once(';')?;

    let mut payload_type = "title"; // Kitty's documented default.
    let mut done = true;
    let mut base64 = false;
    for field in meta.split(':') {
        if field.is_empty() {
            continue;
        }
        let (key, value) = field.split_once('=').unwrap_or((field, ""));
        match key {
            "p" => payload_type = value,
            "d" => done = value != "0",
            "e" => base64 = value == "1",
            _ => {}
        }
    }

    // Only the final chunk fires, and only the readable payload types carry text.
    if !done || (payload_type != "title" && payload_type != "body") {
        return None;
    }

    let text = if base64 {
        decode_base64(text)?
    } else {
        text.to_string()
    };
    if text.is_empty() {
        return None;
    }

    // `body` lands in the body slot (empty title); `title` (incl. the default)
    // lands in the title slot, mirroring how OSC 9 fills body-only.
    Some(if payload_type == "body" {
        (String::new(), text)
    } else {
        (text, String::new())
    })
}

/// Decode standard (RFC 4648) base64 into a String, or `None` if the input has a
/// character outside the base64 alphabet. Whitespace is ignored and `=` padding
/// ends the data. Decoded bytes that are not valid UTF-8 become U+FFFD (lossy),
/// so a notification can never be dropped purely for an odd byte. Kept inline
/// (no crate) to match this module's standard-library-only stance.
fn decode_base64(input: &str) -> Option<String> {
    fn sextet(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out: Vec<u8> = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for &c in input.as_bytes() {
        match c {
            b'=' => break,
            b' ' | b'\t' | b'\r' | b'\n' => continue,
            _ => {}
        }
        let v = sextet(c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
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

/// The shell program to launch and the arguments to pass it. Kept as a plain
/// value, decided by [`resolve_shell`], so the platform choice can be unit
/// tested on any host instead of only on the target OS.
struct ShellSpec {
    program: String,
    args: Vec<String>,
}

/// Decide which shell to spawn and with what arguments.
///
/// On Unix we run the user's login shell (`$SHELL`, default `/bin/zsh`) with
/// `-l`. The login shell is needed because a GUI app does not inherit the
/// interactive shell `PATH`, so an agent like `claude` would not be found if we
/// spawned it directly — the login shell populates `PATH` first. `win_shell` is
/// ignored here; the Windows picker has no meaning on Unix.
///
/// On Windows there is no `$SHELL` and no login-shell concept, so `$SHELL` is
/// ignored and the POSIX `-l` flag is never passed. `win_shell` is the user's
/// pick from Settings. `"cmd"` runs `cmd.exe` with no args. Anything else —
/// `"powershell"`, `None`, or an unrecognised value — runs `powershell.exe
/// -NoLogo`, so a corrupt saved value degrades to the safe default instead of
/// spawning a bad program name. PowerShell loads the user profile, which is the
/// Windows equivalent of populating `PATH`; `-NoLogo` only hides the banner.
fn resolve_shell(
    shell_env: Option<String>,
    win_shell: Option<String>,
    is_windows: bool,
) -> ShellSpec {
    if is_windows {
        match win_shell.as_deref() {
            Some("cmd") => ShellSpec {
                program: "cmd.exe".to_string(),
                args: vec![],
            },
            _ => ShellSpec {
                program: "powershell.exe".to_string(),
                args: vec!["-NoLogo".to_string()],
            },
        }
    } else {
        ShellSpec {
            program: shell_env.unwrap_or_else(|| "/bin/zsh".to_string()),
            args: vec!["-l".to_string()],
        }
    }
}

/// Decide the fallback working directory when the caller passes no `cwd`.
///
/// On Unix this is `$HOME` (then `/`). On Windows it is `%USERPROFILE%` (the
/// real home), then `$HOME` if something set it, then the `C:\` drive root —
/// never a Unix-style `/`, which is not a valid Windows path.
fn resolve_home(home: Option<String>, userprofile: Option<String>, is_windows: bool) -> String {
    if is_windows {
        userprofile.or(home).unwrap_or_else(|| "C:\\".to_string())
    } else {
        home.unwrap_or_else(|| "/".to_string())
    }
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
/// - `persist_key`: if Some, exported into the shell as `OCTIQ_TERM_KEY` so an
///   agent's capture hook (e.g. Claude's) can tell which tab its session belongs
///   to. It is the tab's stable persist key, read back on restore to resume the
///   agent. See agent_resume.rs.
/// - `shell`: the Windows shell pick from Settings (`"powershell"` or `"cmd"`).
///   Ignored on Unix, where the login shell is always used. See resolve_shell.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: State<PtyManager>,
    id: String,
    cwd: String,
    start_cmd: Option<String>,
    persist_key: Option<String>,
    shell: Option<String>,
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
    // directly. The shell resolves it instead. The program and args are chosen
    // per-OS (see resolve_shell): a login shell on Unix, PowerShell on Windows.
    let spec = resolve_shell(std::env::var("SHELL").ok(), shell, cfg!(windows));
    let mut cmd = CommandBuilder::new(&spec.program);
    for arg in &spec.args {
        cmd.arg(arg);
    }
    cmd.env("TERM", "xterm-256color");
    // Tag the shell with the tab's stable persist key, so an agent capture hook
    // running under it (e.g. Claude's SessionStart hook) can record which tab
    // owns its session. Read back on restore to build the resume command.
    if let Some(key) = persist_key.as_deref() {
        if !key.is_empty() {
            cmd.env("OCTIQ_TERM_KEY", key);
        }
    }

    let dir = if cwd.trim().is_empty() {
        resolve_home(
            std::env::var("HOME").ok(),
            std::env::var("USERPROFILE").ok(),
            cfg!(windows),
        )
    } else {
        cwd
    };
    cmd.cwd(dir);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The shell's pid identifies its foreground process group at the prompt, so
    // we can later tell whether an agent is still running in this tab.
    let shell_pid = child.process_id().map(|p| p as i32);

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

    manager.sessions.lock().map_err(|e| e.to_string())?.insert(
        id,
        Session {
            master: pair.master,
            writer,
            child,
            needs_attention,
            persist_key: persist_key.filter(|k| !k.is_empty()),
            shell_pid,
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
    use super::{
        decode_base64, decode_utf8_stream, parse_osc99, resolve_home, resolve_shell, scan_attention,
    };

    /// Convenience: scan a string and return just the hits (drop `keep_from`).
    fn hits(buf: &str) -> Vec<(String, String)> {
        scan_attention(buf).0
    }

    #[test]
    fn unix_uses_shell_env_with_login_flag() {
        let spec = resolve_shell(Some("/bin/bash".to_string()), None, false);
        assert_eq!(spec.program, "/bin/bash");
        assert_eq!(spec.args, vec!["-l".to_string()]);
    }

    #[test]
    fn unix_falls_back_to_zsh_when_no_shell_env() {
        let spec = resolve_shell(None, None, false);
        assert_eq!(spec.program, "/bin/zsh");
        assert_eq!(spec.args, vec!["-l".to_string()]);
    }

    #[test]
    fn unix_ignores_windows_shell_choice() {
        // The Windows-only picker must never affect the Unix login shell.
        let spec = resolve_shell(
            Some("/bin/bash".to_string()),
            Some("cmd".to_string()),
            false,
        );
        assert_eq!(spec.program, "/bin/bash");
        assert_eq!(spec.args, vec!["-l".to_string()]);
    }

    #[test]
    fn windows_defaults_to_powershell_when_no_choice() {
        // No saved choice: PowerShell, the recommended default. Any $SHELL value
        // is ignored, and the POSIX `-l` flag must never be passed.
        let spec = resolve_shell(Some("/bin/zsh".to_string()), None, true);
        assert_eq!(spec.program, "powershell.exe");
        assert!(!spec.args.iter().any(|a| a == "-l"));
    }

    #[test]
    fn windows_uses_powershell_when_chosen() {
        let spec = resolve_shell(None, Some("powershell".to_string()), true);
        assert_eq!(spec.program, "powershell.exe");
        assert!(!spec.args.iter().any(|a| a == "-l"));
    }

    #[test]
    fn windows_uses_cmd_when_chosen() {
        let spec = resolve_shell(None, Some("cmd".to_string()), true);
        assert_eq!(spec.program, "cmd.exe");
        assert!(spec.args.is_empty());
    }

    #[test]
    fn windows_unknown_choice_falls_back_to_powershell() {
        // A corrupt or unrecognised saved value must never break spawning; it
        // degrades to the safe default rather than passing a bad program name.
        let spec = resolve_shell(None, Some("bash".to_string()), true);
        assert_eq!(spec.program, "powershell.exe");
    }

    #[test]
    fn unix_home_prefers_home_var() {
        let dir = resolve_home(Some("/home/kyson".to_string()), None, false);
        assert_eq!(dir, "/home/kyson");
    }

    #[test]
    fn unix_home_falls_back_to_root() {
        let dir = resolve_home(None, None, false);
        assert_eq!(dir, "/");
    }

    #[test]
    fn windows_home_prefers_userprofile_over_home() {
        let dir = resolve_home(
            Some("/should/ignore".to_string()),
            Some("C:\\Users\\kyson".to_string()),
            true,
        );
        assert_eq!(dir, "C:\\Users\\kyson");
    }

    #[test]
    fn windows_home_falls_back_to_drive_root_when_unset() {
        // No USERPROFILE and no HOME: use a safe drive root, never "/".
        let dir = resolve_home(None, None, true);
        assert_eq!(dir, "C:\\");
    }

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

    // ---- scan_attention: existing OSC 9 / OSC 777 shapes still work ---------

    #[test]
    fn scan_osc9_yields_body_only() {
        assert_eq!(
            hits("\x1b]9;build done\x07"),
            vec![(String::new(), "build done".into())]
        );
    }

    #[test]
    fn scan_osc777_yields_title_and_body() {
        assert_eq!(
            hits("\x1b]777;notify;Claude;needs input\x07"),
            vec![("Claude".into(), "needs input".into())]
        );
    }

    #[test]
    fn scan_accepts_st_terminator() {
        // ST (ESC \) terminates an OSC just like BEL.
        assert_eq!(
            hits("\x1b]9;done\x1b\\"),
            vec![(String::new(), "done".into())]
        );
    }

    // ---- scan_attention: OSC 99 (Kitty) ------------------------------------

    #[test]
    fn scan_osc99_bare_text_is_title_by_default() {
        // ESC]99;;Hello -> empty metadata, default payload type `title`.
        assert_eq!(
            hits("\x1b]99;;Hello\x07"),
            vec![("Hello".into(), String::new())]
        );
    }

    #[test]
    fn scan_osc99_p_body_lands_in_body_slot() {
        assert_eq!(
            hits("\x1b]99;p=body;needs input\x07"),
            vec![(String::new(), "needs input".into())]
        );
    }

    #[test]
    fn scan_osc99_routes_before_osc9() {
        // A "99;" payload must not be mis-read as OSC 9's "9;<body>".
        assert_eq!(hits("\x1b]99;;hi\x07"), vec![("hi".into(), String::new())]);
    }

    #[test]
    fn scan_osc99_two_chunk_emission_yields_one_body_hit() {
        // The EXACT bytes `octiq-notify --osc99 --title Claude --body "needs
        // input"` emits: a d=0 title chunk (skipped) + the closing body chunk.
        // The scanner must raise exactly one alert, carrying the body.
        let emitted = "\x1b]99;i=1:d=0:p=title;Claude\x07\x1b]99;i=1:p=body;needs input\x07";
        assert_eq!(hits(emitted), vec![(String::new(), "needs input".into())]);
    }

    // ---- parse_osc99 unit cases --------------------------------------------

    #[test]
    fn osc99_default_payload_type_is_title() {
        assert_eq!(parse_osc99(";Hello"), Some(("Hello".into(), String::new())));
    }

    #[test]
    fn osc99_explicit_title_and_body() {
        assert_eq!(parse_osc99("p=title;T"), Some(("T".into(), String::new())));
        assert_eq!(parse_osc99("p=body;B"), Some((String::new(), "B".into())));
    }

    #[test]
    fn osc99_non_final_chunk_is_skipped() {
        // d=0 marks a non-final chunk; it must not raise an alert on its own.
        assert_eq!(parse_osc99("i=1:d=0:p=title;Title"), None);
    }

    #[test]
    fn osc99_control_payload_types_are_skipped() {
        // close/alive/icon/buttons/?/etc. carry no user-facing text.
        assert_eq!(parse_osc99("p=close:i=1;"), None);
        assert_eq!(parse_osc99("i=1:p=alive;"), None);
    }

    #[test]
    fn osc99_missing_separator_is_skipped() {
        // No ';' after the metadata => no text payload to show.
        assert_eq!(parse_osc99("p=close:i=1"), None);
    }

    #[test]
    fn osc99_empty_text_is_skipped() {
        assert_eq!(parse_osc99("p=body;"), None);
    }

    #[test]
    fn osc99_base64_payload_is_decoded() {
        // "needs input" base64 = "bmVlZHMgaW5wdXQ=".
        assert_eq!(
            parse_osc99("e=1:p=body;bmVlZHMgaW5wdXQ="),
            Some((String::new(), "needs input".into()))
        );
    }

    #[test]
    fn osc99_bad_base64_is_dropped() {
        // '!' is outside the base64 alphabet => the whole chunk is dropped.
        assert_eq!(parse_osc99("e=1:p=body;not_base64!!"), None);
    }

    #[test]
    fn osc99_unknown_metadata_keys_are_ignored() {
        // Extra keys (urgency u, icon-name, ...) must not break parsing.
        assert_eq!(
            parse_osc99("i=7:u=2:p=body:o=always;ping"),
            Some((String::new(), "ping".into()))
        );
    }

    // ---- decode_base64 ------------------------------------------------------

    #[test]
    fn base64_decodes_standard_input() {
        assert_eq!(decode_base64("aGVsbG8=").as_deref(), Some("hello"));
        assert_eq!(decode_base64("Zm9vYmFy").as_deref(), Some("foobar"));
    }

    #[test]
    fn base64_rejects_non_alphabet_chars() {
        assert_eq!(decode_base64("####"), None);
    }

    #[test]
    fn base64_ignores_embedded_whitespace() {
        assert_eq!(decode_base64("aGVs bG8=").as_deref(), Some("hello"));
    }
}

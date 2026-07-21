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
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Upper bound on the OSC scan buffer's retained tail (bytes). An OSC
/// attention sequence is tiny; anything longer is plain output that can be
/// dropped, so the reader never holds unbounded scrollback.
const SCAN_TAIL_CAP: usize = 8 * 1024;

/// Upper bound on the per-session ring that buffers output while a terminal is
/// HIDDEN (card 16). Output past this is dropped from the FRONT and the session
/// is marked `trimmed`, so a `cat` of a huge file in a background tab cannot
/// grow memory without bound.
///
/// 1 MiB is chosen so the drop is very nearly invisible: xterm keeps a bounded
/// scrollback (1000 lines by default), and 1 MiB of output is far more than
/// 1000 lines of any realistic width — so what the ring drops is output xterm
/// would have scrolled out of its own buffer anyway.
const HIDDEN_RING_CAP: usize = 1024 * 1024;

/// Longest alert title / body we keep from an OSC sequence, in CHARACTERS
/// (card 25). Any program that can print to a terminal can forge an attention
/// alert with a title and body of its choosing; without a bound, a megabyte of
/// text would ride into the banner and the OS notification.
///
/// 200 matches the cap the external capture hook already applies, so both paths
/// into an alert agree.
const MAX_ALERT_TEXT_CHARS: usize = 200;

/// Make one field of a forged-able OSC alert safe to hand to the UI: drop control
/// characters and bound the length.
///
/// Rendering is already safe (`textContent` and the notification plugin, never
/// `innerHTML`), so this is not an injection fix — it stops an unbounded or
/// line-breaking string from mangling the banner. Truncation is by CHARACTER, so
/// a multi-byte glyph is never cut in half.
fn sanitize_alert_text(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(MAX_ALERT_TEXT_CHARS)
        .collect()
}

/// One session's output gate: is its terminal on screen, and if not, what has
/// it printed since it went off screen (card 16).
///
/// While `visible` is false the emitter thread appends to `ring` instead of
/// emitting a `pty-output` event, so the frontend does no xterm parse and no
/// payload crosses the IPC boundary for a terminal nobody can see. Revealing
/// the terminal drains the ring into one `pty-restore` event.
struct OutBuf {
    visible: bool,
    ring: String,
    /// True once the ring has overflowed and dropped output. The frontend draws
    /// a "[octiq: output trimmed]" marker above the restored tail.
    trimmed: bool,
}

impl OutBuf {
    fn new() -> Self {
        // A terminal is visible until the frontend says otherwise: a freshly
        // spawned terminal is always the tab being activated.
        Self {
            visible: true,
            ring: String::new(),
            trimmed: false,
        }
    }

    /// Append hidden output, dropping the oldest bytes once the cap is passed.
    /// The cut is moved to the next char boundary so `drain` can never split a
    /// multi-byte glyph (`ring` must stay valid UTF-8).
    fn push_hidden(&mut self, chunk: &str) {
        self.ring.push_str(chunk);
        if self.ring.len() <= HIDDEN_RING_CAP {
            return;
        }
        let cut = self.ring.len() - HIDDEN_RING_CAP;
        let cut = (cut..=self.ring.len())
            .find(|&k| self.ring.is_char_boundary(k))
            .unwrap_or(self.ring.len());
        self.ring.drain(..cut);
        self.trimmed = true;
    }

    /// Take everything buffered while hidden, resetting the ring.
    fn take(&mut self) -> (String, bool) {
        (
            std::mem::take(&mut self.ring),
            std::mem::replace(&mut self.trimmed, false),
        )
    }
}

/// A PTY master, shared so a foreground-process query can run WITHOUT holding
/// the sessions map (card 22). The `Mutex` is per session, so a slow syscall on
/// one terminal never blocks another.
type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;

/// A PTY's input side, likewise per-session. `write_all` on a full slave input
/// buffer BLOCKS, so this must never be reached while the map lock is held.
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// One live PTY session: the master (for resize + foreground queries), the
/// writer (for input), and the child process handle (so close can kill the whole
/// shell + its children).
///
/// Every field a command needs while doing something SLOW — writing, resizing,
/// querying the foreground process group — lives behind its own `Arc<Mutex<_>>`.
/// A caller clones the handle out under the global map lock, releases the map,
/// and only then blocks. That is what keeps one wedged terminal (a Ctrl-S'd
/// shell, a huge paste into a slow consumer) from freezing PTY commands
/// app-wide, which is exactly what the old `pty_write` did.
struct Session {
    master: SharedMaster,
    writer: SharedWriter,
    child: Box<dyn Child + Send + Sync>,
    /// Shared with this session's emitter thread: whether the terminal is on
    /// screen, plus the ring that buffers its output while it is not (card 16).
    out: Arc<Mutex<OutBuf>>,
    /// The tab's stable persist key, if it carries one. Used to map a live
    /// session back to its saved resume mapping (agent_resume.rs).
    persist_key: Option<String>,
    /// The spawned shell's pid. At an idle prompt the PTY's foreground process
    /// group equals this; while an agent runs it differs — that is how we tell a
    /// tab's agent has exited. Only read on Unix.
    #[cfg_attr(not(unix), allow(dead_code))]
    shell_pid: Option<i32>,
}

/// Whether an agent is currently the foreground process of a PTY (vs the shell
/// sitting at its prompt). At the prompt the foreground process group equals the
/// shell's own pid; an agent runs in its own group, a different pid. An unknown
/// foreground, a missing shell pid, or a poisoned master lock all report `true`,
/// so we never treat a session we cannot positively disprove as exited.
///
/// This performs a `tcgetpgrp` syscall. It takes the per-session master lock and
/// must be called with the sessions map UNLOCKED.
#[cfg(unix)]
fn agent_running(master: &SharedMaster, shell_pid: Option<i32>) -> bool {
    let Ok(master) = master.lock() else {
        return true;
    };
    match (master.process_group_leader(), shell_pid) {
        (Some(foreground), Some(shell)) => foreground != shell,
        _ => true,
    }
}

/// Non-Unix has no foreground-process-group query here, so we cannot tell an
/// agent exited; report running so a mapping is never wrongly dropped.
#[cfg(not(unix))]
fn agent_running(_master: &SharedMaster, _shell_pid: Option<i32>) -> bool {
    true
}

/// Holds every live PTY session, keyed by the id the frontend gave at spawn.
/// Managed by Tauri so all commands can reach it via `State`.
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

/// One session's identity plus the handles needed to query it, cloned out of the
/// map so the query can run with the map unlocked (card 22).
struct ForegroundProbe {
    id: String,
    persist_key: Option<String>,
    master: SharedMaster,
    shell_pid: Option<i32>,
}

impl PtyManager {
    /// Clone the handles needed for a foreground sweep out of the map. Held for
    /// as long as it takes to clone a few `Arc`s — no syscalls, no blocking.
    /// A poisoned lock yields nothing.
    fn foreground_probes(&self) -> Vec<ForegroundProbe> {
        let Ok(sessions) = self.sessions.lock() else {
            return Vec::new();
        };
        sessions
            .iter()
            .map(|(id, s)| ForegroundProbe {
                id: id.clone(),
                persist_key: s.persist_key.clone(),
                master: s.master.clone(),
                shell_pid: s.shell_pid,
            })
            .collect()
    }

    /// For every live session that carries a persist key, report whether an
    /// agent is currently its PTY's foreground process. Keyed by persist key so
    /// agent_resume.rs can clear the resume mapping of any tab whose agent has
    /// exited — the deterministic signal Codex gives no SessionEnd hook for.
    /// A poisoned lock yields an empty map (clear nothing).
    pub fn agent_foreground_by_key(&self) -> HashMap<String, bool> {
        self.foreground_probes()
            .into_iter()
            .filter_map(|p| {
                let key = p.persist_key.clone()?;
                Some((key, agent_running(&p.master, p.shell_pid)))
            })
            .collect()
    }

    /// For every live session, whether an agent (a non-shell process) is the
    /// PTY's current foreground process. Keyed by the session id the frontend
    /// assigned at spawn, so the frontend can map each result straight to its
    /// terminal/tab and show a "working" indicator. A poisoned lock yields an
    /// empty map. On non-Unix every value is `true` (there is no
    /// foreground-process query — see `agent_running`), so the indicator
    /// degrades to "an agent is open".
    pub fn agent_running_by_id(&self) -> HashMap<String, bool> {
        self.foreground_probes()
            .into_iter()
            .map(|p| (p.id, agent_running(&p.master, p.shell_pid)))
            .collect()
    }

    /// Remove one session and reap its child: kill (best-effort — it may already
    /// be dead), then wait, so the process can never linger as a zombie in the
    /// OS process table. Returns whether a session with this id existed.
    ///
    /// Two callers: `pty_close` for a tab the user closes, and the reader
    /// thread when a shell exits ON ITS OWN (`exit`, Ctrl-D, a crash). The
    /// second path used to leave the dead child un-waited — one `<defunct>`
    /// entry per self-exited shell until the app quit — and kept its stale pid
    /// in `shell_pids`, where an OS pid reuse could match it to the wrong
    /// process.
    fn reap_session(&self, id: &str) -> bool {
        let session = match self.sessions.lock() {
            Ok(mut sessions) => sessions.remove(id),
            Err(_) => None,
        };
        let Some(mut session) = session else {
            return false;
        };
        let _ = session.child.kill();
        let _ = session.child.wait();
        true
    }

    /// Each live session's shell pid -> its session id. agents.rs walks an agent
    /// process's ancestors against this map to find the terminal that owns it.
    /// A poisoned lock yields an empty map (every agent then reads as a stray).
    pub fn shell_pids(&self) -> HashMap<i32, String> {
        let Ok(sessions) = self.sessions.lock() else {
            return HashMap::new();
        };
        sessions
            .iter()
            .filter_map(|(id, s)| Some((s.shell_pid?, id.clone())))
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

/// Payload for the `pty-restore` event, emitted once when a hidden terminal is
/// revealed: everything it printed while off screen, plus whether the ring
/// overflowed and dropped older output (card 16).
#[derive(Clone, Serialize)]
struct RestoreEvent {
    id: String,
    data: String,
    trimmed: bool,
}

/// Payload for the `pty-hidden-output` event: a hidden terminal printed
/// something, but the bytes are being buffered rather than sent (card 16).
///
/// This ping exists so the frontend's output-driven state — the "working" dot,
/// the per-project busy count, and card 15's silence monitor — keeps tracking
/// terminals the user cannot see. Dropping it would make an agent in a
/// background project look idle the moment you switched away, which is the one
/// thing those indicators exist to tell you. It carries no payload and rides
/// the same coalescing window as `pty-output`, so it costs almost nothing.
#[derive(Clone, Serialize)]
struct HiddenOutputEvent {
    id: String,
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
///   - the end of the buffer, minus a lone trailing `ESC` (which may be the
///     first byte of an `ESC ]` split across the read boundary).
///
/// That second case is the COMMON one — plain output with no OSC at all — and
/// it must drain the buffer completely. It used to return 0, so nothing was
/// ever drained: `scan_buf` grew to `SCAN_TAIL_CAP` and every subsequent read
/// re-scanned up to 8 KiB of bytes already known to hold no sequence.
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
        // Every title/body reaching a hit is sanitized: this text comes from
        // whatever program printed the sequence (card 25).
        if let Some(rest) = payload.strip_prefix("777;notify;") {
            let mut parts = rest.splitn(2, ';');
            let title = sanitize_alert_text(parts.next().unwrap_or(""));
            let body = sanitize_alert_text(parts.next().unwrap_or(""));
            hits.push((title, body));
        } else if let Some(rest) = payload.strip_prefix("99;") {
            if let Some((title, body)) = parse_osc99(rest) {
                hits.push((sanitize_alert_text(&title), sanitize_alert_text(&body)));
            }
        } else if let Some(body) = payload.strip_prefix("9;") {
            hits.push((String::new(), sanitize_alert_text(body)));
        }

        i = end;
    }
    let keep_from = match last_introducer {
        // A sequence started but never terminated: keep it, its terminator may
        // arrive in the next read.
        Some(start) => start,
        // Everything before `i` is settled — either an emitted hit, or plain
        // output that provably cannot begin a sequence. Drop all of it. The one
        // byte worth keeping is a trailing lone `ESC`: the `]` that would make
        // it an introducer may be the first byte of the next read. `ESC` is
        // ASCII, so `len - 1` is always a char boundary.
        None if bytes.last() == Some(&0x1b) => bytes.len() - 1,
        None => bytes.len(),
    };
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
/// - `canvas_key`: if Some, exported into the shell as `OCTIQ_CANVAS_DIR` (the
///   project's `~/.octiqflow/canvas/<key>` folder) so an agent here can write
///   HTML/MD documents the canvas pane renders. Only project terminals pass it;
///   chat terminals get no canvas. See canvas.rs.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: State<PtyManager>,
    id: String,
    cwd: String,
    start_cmd: Option<String>,
    persist_key: Option<String>,
    shell: Option<String>,
    canvas_key: Option<String>,
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
    // Point any agent-capture hook running under this shell at the active
    // profile's data root, so it writes agent-sessions.json into the same profile
    // OctiqFlow reads from. The hook falls back to ~/.octiqflow if this is unset.
    cmd.env("OCTIQ_ROOT", crate::profile::profile_dir());
    // Tag the shell with the tab's stable persist key, so an agent capture hook
    // running under it (e.g. Claude's SessionStart hook) can record which tab
    // owns its session. Read back on restore to build the resume command.
    if let Some(key) = persist_key.as_deref() {
        if !key.is_empty() {
            cmd.env("OCTIQ_TERM_KEY", key);
        }
    }
    // Project terminals carry a canvas key: export OCTIQ_CANVAS_DIR so an agent
    // running here can write HTML/MD documents into the project's canvas folder,
    // which OctiqFlow renders in the pane beside the terminal. The folder is
    // created up front so the watcher always has a real directory to watch. A
    // bad/empty key just leaves the var unset — the agent then knows this is not
    // a canvas-enabled terminal. Chat terminals pass no key.
    if let Some(key) = canvas_key.as_deref() {
        if !key.is_empty() {
            if let Some(dir) = crate::canvas::canvas_dir_for(key) {
                if std::fs::create_dir_all(&dir).is_ok() {
                    cmd.env("OCTIQ_CANVAS_DIR", &dir);
                    cmd.env("OCTIQ_CANVAS_KEY", key);
                }
            }
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

    // Output coalescing. The reader thread sends each decoded chunk down this
    // channel; a dedicated emitter thread batches everything that arrives within
    // a short window into ONE `pty-output` event. Emitting per 4096-byte read
    // floods the webview's main thread under heavy output (an agent streaming, a
    // build, a big `cat`), starving keystroke echo and repaint — the "I type and
    // nothing shows, then it all appears at once" freeze. Batching collapses
    // thousands of tiny events per second into roughly one per frame.
    let (out_tx, out_rx) = mpsc::channel::<String>();
    let emit_app = app.clone();
    let emit_id_out = id.clone();
    // The visibility gate + hidden-output ring (card 16), shared with the
    // session so `pty_set_visible` can flip it and drain the ring.
    let out_state = Arc::new(Mutex::new(OutBuf::new()));
    let emit_out_state = out_state.clone();
    thread::spawn(move || {
        // ~8ms ≈ one 120Hz frame: short enough that a lone keystroke echo is
        // imperceptible, long enough to swallow a burst. CAP bounds one event's
        // size so a huge burst becomes several events, not one giant payload.
        const COALESCE: Duration = Duration::from_millis(8);
        const CAP: usize = 64 * 1024;
        // Block for the first chunk, then drain whatever else arrives until the
        // window closes or the cap is hit, and emit the batch once.
        while let Ok(first) = out_rx.recv() {
            let mut batch = first;
            let deadline = Instant::now() + COALESCE;
            while batch.len() < CAP {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                match out_rx.recv_timeout(deadline - now) {
                    Ok(more) => batch.push_str(&more),
                    Err(_) => break, // window elapsed, or sender gone
                }
            }
            // Decide under the visibility lock, and — when visible — EMIT under
            // it too. `pty_set_visible` drains the ring and emits `pty-restore`
            // while holding the same lock, so holding it here is what guarantees
            // no `pty-output` can slip between a reveal's restore event and the
            // stream resuming. A poisoned lock means the session is being torn
            // down; stop the thread rather than spin.
            let Ok(mut out) = emit_out_state.lock() else {
                break;
            };
            if out.visible {
                let _ = emit_app.emit(
                    "pty-output",
                    OutputEvent {
                        id: emit_id_out.clone(),
                        chunk: batch,
                    },
                );
            } else {
                out.push_hidden(&batch);
                // Tell the frontend this terminal is alive without shipping the
                // bytes: the working dot and the silence monitor need the beat.
                let _ = emit_app.emit(
                    "pty-hidden-output",
                    HiddenOutputEvent {
                        id: emit_id_out.clone(),
                    },
                );
            }
        }
    });

    // Per-session reader thread: decode + scan PTY output, raise attention
    // alerts immediately, and hand each chunk to the emitter thread above. Ends
    // on EOF (shell exited) or read error; the channel then closes and the
    // emitter thread ends with it.
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
                        // The user's optional notify-hook (card 19) may rewrite
                        // or suppress this alert, and it is allowed to take up to
                        // two seconds. Hand it a thread of its own: blocking here
                        // would stall this terminal's entire output stream behind
                        // a slow hook. Alerts are human-paced, so a thread per
                        // alert is cheaper than any machinery to avoid one.
                        // ponytail: thread per alert; pool it if alerts ever
                        // arrive faster than a person can read them.
                        let hook_app = app_handle.clone();
                        let hook_id = emit_id.clone();
                        thread::spawn(move || {
                            let alert = crate::notify_hook::alert_for(hook_id, "osc", title, body);
                            let Some(alert) = crate::notify_hook::filter(alert) else {
                                return; // the hook suppressed it
                            };
                            let _ = hook_app.emit(
                                "pty-attention",
                                AttentionEvent {
                                    id: alert.id,
                                    title: alert.title,
                                    body: alert.body,
                                },
                            );
                        });
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

                    // Hand the decoded chunk to the emitter thread, which batches
                    // it with any other output in the same short window. The scan
                    // buffer never affects what is shown. Skip an empty chunk (a
                    // read that was only an incomplete UTF-8 tail carries no
                    // displayable text). A send error means the emitter is gone
                    // (shutdown) — nothing left to do.
                    if !chunk.is_empty() {
                        let _ = out_tx.send(chunk);
                    }
                }
                Err(_) => break,
            }
        }
        // The stream ended: the shell exited on its own (EOF) or the PTY died.
        // A user-closed tab is reaped by `pty_close`; nothing reaps THIS child,
        // so without this it sits as a zombie until the app quits. Reaping here
        // also races safely with `pty_close` — whichever takes the session from
        // the map does the wait, the other is a no-op. try_state: app teardown
        // may already have dropped the managed state.
        if let Some(manager) = app_handle.try_state::<PtyManager>() {
            manager.reap_session(&emit_id);
        }
    });

    // Registration is the LAST step, but the shell and its two threads already
    // exist. If the map lock is poisoned we must not just return: an untracked
    // shell would keep running with no way to reach or close it. Kill it first,
    // then report the failure. (Narrow — a poisoned lock means another thread
    // panicked holding it — but the side effects precede registration, so the
    // cleanup has to be explicit.)
    let mut sessions = match manager.sessions.lock() {
        Ok(sessions) => sessions,
        Err(e) => {
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(e.to_string());
        }
    };
    sessions.insert(
        id,
        Session {
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            child,
            out: out_state,
            persist_key: persist_key.filter(|k| !k.is_empty()),
            shell_pid,
        },
    );

    Ok(())
}

/// Tell the backend whether a terminal is on screen (card 16).
///
/// A terminal is "visible" only when it is the active tab of a shown group —
/// exactly when the frontend also holds its WebGL context. While it is hidden
/// the emitter thread buffers its output in a capped ring instead of emitting
/// `pty-output`, so no payload crosses the IPC boundary and xterm parses
/// nothing for a terminal nobody can see. Revealing it drains the ring into a
/// single `pty-restore` event.
///
/// OSC attention scanning is unaffected: it runs on the reader thread, which
/// never consults visibility, so a hidden agent can still raise an alert.
///
/// Unknown id is a no-op success (the terminal may have just closed), and
/// setting the value it already holds does nothing.
#[tauri::command]
pub fn pty_set_visible(
    app: AppHandle,
    manager: State<PtyManager>,
    id: String,
    visible: bool,
) -> Result<(), String> {
    // Clone the Arc out from under the sessions map, then release the map lock
    // before touching the per-session gate — a reveal emits an event while
    // holding that gate, and doing so under the global map lock would block
    // every other terminal's commands.
    let out = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        match sessions.get(&id) {
            Some(session) => session.out.clone(),
            None => return Ok(()),
        }
    };
    let mut guard = out.lock().map_err(|e| e.to_string())?;
    if guard.visible == visible {
        return Ok(());
    }
    guard.visible = visible;
    if visible {
        let (data, trimmed) = guard.take();
        if !data.is_empty() || trimmed {
            // Emitted while `guard` is still held: the emitter thread cannot
            // send a `pty-output` for this session until it can take the same
            // lock, so the restored block always lands before the stream
            // resumes. See the emitter thread in `pty_spawn`.
            let _ = app.emit("pty-restore", RestoreEvent { id, data, trimmed });
        }
    }
    Ok(())
}

/// Write raw text into one session's PTY input. The shell cannot tell this from
/// real typing. Append "\r" to submit a line. Unknown id is an error.
///
/// The sessions map is released BEFORE the write (card 22). `write_all` into a
/// PTY blocks whenever the slave's input buffer is full — a Ctrl-S'd shell, or a
/// big paste into a program that is not reading. Holding the global map across
/// that stalled every other terminal's commands app-wide.
#[tauri::command]
pub fn pty_write(manager: State<PtyManager>, id: String, data: String) -> Result<(), String> {
    let writer = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&id)
            .ok_or_else(|| format!("no pty session: {id}"))?
            .writer
            .clone()
    };
    let mut writer = writer.lock().map_err(|e| e.to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resize one session's PTY so the program inside knows the new size. Unknown
/// id is an error. Like `pty_write`, the map lock is released before the ioctl.
#[tauri::command]
pub fn pty_resize(
    manager: State<PtyManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let master = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&id)
            .ok_or_else(|| format!("no pty session: {id}"))?
            .master
            .clone()
    };
    let master = master.lock().map_err(|e| e.to_string())?;
    master
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
    manager.reap_session(&id);
    Ok(())
}

/// List the ids of every live session. Order is unspecified (HashMap).
#[tauri::command]
pub fn pty_list_active(manager: State<PtyManager>) -> Result<Vec<String>, String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.keys().cloned().collect())
}

/// Report, per live session id, whether an agent (a non-shell foreground
/// process) is currently running in that PTY. The frontend polls this to show a
/// "working" badge on each terminal tab and a per-project count in the sidebar.
/// See `Session::agent_running` for the signal and its limits (it stays true
/// while an agent sits idle at its own prompt; non-Unix always reports true).
#[tauri::command]
pub fn pty_agent_running(manager: State<PtyManager>) -> HashMap<String, bool> {
    manager.agent_running_by_id()
}

// `pty_clear_attention` used to live here (card 22 removed it). It lowered a
// per-session `needs_attention: AtomicBool` that nothing ever read: attention
// state lives entirely in the frontend, where `terminals.js` owns the set and
// `alerts.js` renders it. The backend's only job is to EMIT `pty-attention`.
// The command and the flag are both gone, along with the invoke that called it.

#[cfg(test)]
mod tests {
    use super::{
        decode_base64, decode_utf8_stream, parse_osc99, resolve_home, resolve_shell,
        sanitize_alert_text, scan_attention, OutBuf, HIDDEN_RING_CAP, MAX_ALERT_TEXT_CHARS,
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

    // ---- OutBuf: hidden-terminal ring (card 16) -----------------------------

    #[test]
    fn hidden_ring_replays_short_output_byte_identical() {
        // Under the cap, nothing is dropped: a reveal must give back exactly
        // what the terminal printed while it was hidden.
        let mut out = OutBuf::new();
        out.push_hidden("hello ");
        out.push_hidden("world");
        let (data, trimmed) = out.take();
        assert_eq!(data, "hello world");
        assert!(!trimmed);
    }

    #[test]
    fn hidden_ring_take_resets_the_buffer() {
        let mut out = OutBuf::new();
        out.push_hidden("first");
        assert_eq!(out.take().0, "first");
        // A second reveal with no output in between yields nothing, not a repeat.
        let (data, trimmed) = out.take();
        assert!(data.is_empty());
        assert!(!trimmed);
    }

    #[test]
    fn hidden_ring_drops_oldest_output_and_flags_trimmed() {
        // Overflow the cap: the ring keeps the TAIL (what the user will want to
        // see on reveal) and reports that it dropped something.
        let mut out = OutBuf::new();
        out.push_hidden(&"a".repeat(HIDDEN_RING_CAP));
        assert!(!out.trimmed, "exactly at the cap must not trim");
        out.push_hidden("TAIL");
        let (data, trimmed) = out.take();
        assert!(trimmed);
        assert_eq!(data.len(), HIDDEN_RING_CAP);
        assert!(data.ends_with("TAIL"));
    }

    #[test]
    fn hidden_ring_trim_never_splits_a_multibyte_glyph() {
        // The ring is a String, so an overflow cut on a byte index inside a
        // multi-byte char would panic. Fill it with 3-byte glyphs and force a
        // cut that lands mid-glyph.
        let mut out = OutBuf::new();
        let glyph = "│"; // U+2502, 3 bytes
                         // CAP is not a multiple of 3, so this stops just SHORT of the cap.
        out.push_hidden(&glyph.repeat(HIDDEN_RING_CAP / 3));
        // Two more bytes push it past. The naive cut then lands inside the very
        // first glyph, which is the case that would panic without the boundary
        // search in push_hidden.
        out.push_hidden("xx");
        let (data, trimmed) = out.take();
        assert!(trimmed);
        // Still valid UTF-8 (it is a String), and it kept the newest bytes.
        assert!(data.ends_with("xx"));
        assert!(data.len() <= HIDDEN_RING_CAP);
        assert!(data.starts_with(glyph), "cut must land on a glyph boundary");
    }

    #[test]
    fn a_new_session_starts_visible() {
        // A freshly spawned terminal is the tab being activated, so it must
        // stream immediately — never buffer until someone calls set_visible.
        assert!(OutBuf::new().visible);
    }

    // ---- scan_attention: the buffer must DRAIN (card 22) --------------------
    // The reader keeps `scan_buf` across reads so a sequence split at a 4096-byte
    // boundary is still found. `keep_from` is what it retains. If that never
    // reaches the buffer end, plain output piles up to SCAN_TAIL_CAP and every
    // read re-scans 8 KiB it has already proven contains nothing.

    /// Model the reader loop: append a chunk, scan, drain to `keep_from`.
    fn feed(scan_buf: &mut String, chunk: &str) -> Vec<(String, String)> {
        scan_buf.push_str(chunk);
        let (hits, keep_from) = scan_attention(scan_buf);
        scan_buf.drain(..keep_from);
        hits
    }

    #[test]
    fn plain_output_drains_the_scan_buffer_completely() {
        let text = "no escape sequences here at all\r\n";
        let (hits, keep_from) = scan_attention(text);
        assert!(hits.is_empty());
        assert_eq!(keep_from, text.len(), "the whole buffer is settled");
    }

    #[test]
    fn a_stream_of_plain_reads_never_grows_the_scan_buffer() {
        // The regression this card exists for.
        let mut scan_buf = String::new();
        for _ in 0..500 {
            assert!(feed(&mut scan_buf, "some ordinary build output line\n").is_empty());
            assert!(
                scan_buf.is_empty(),
                "scan_buf must be empty between plain reads, held {} bytes",
                scan_buf.len()
            );
        }
    }

    #[test]
    fn csi_sequences_do_not_hold_the_buffer() {
        // A colour code is `ESC [`, not `ESC ]`. It can never start an OSC, so
        // it must not be retained either.
        let text = "\x1b[31mred\x1b[0m normal";
        let (hits, keep_from) = scan_attention(text);
        assert!(hits.is_empty());
        assert_eq!(keep_from, text.len());
    }

    #[test]
    fn a_lone_trailing_esc_is_kept_for_the_next_read() {
        // `ESC` alone could become `ESC ]` once the next read arrives, so it is
        // the ONE byte worth holding.
        let text = "output\x1b";
        let (hits, keep_from) = scan_attention(text);
        assert!(hits.is_empty());
        assert_eq!(keep_from, text.len() - 1);
    }

    #[test]
    fn an_unterminated_introducer_is_kept_from_its_start() {
        let text = "output\x1b]777;notify;Claude;still typing";
        let (hits, keep_from) = scan_attention(text);
        assert!(hits.is_empty(), "no terminator yet, so no hit");
        assert_eq!(keep_from, "output".len());
    }

    #[test]
    fn a_settled_hit_followed_by_plain_output_drains_everything() {
        let text = "\x1b]9;done\x07and then some more output";
        let (hits, keep_from) = scan_attention(text);
        assert_eq!(hits, vec![(String::new(), "done".into())]);
        assert_eq!(keep_from, text.len());
    }

    #[test]
    fn a_sequence_split_across_reads_is_still_found_after_draining() {
        // Draining must not break the split-sequence case the buffer exists for.
        let mut scan_buf = String::new();
        assert!(feed(&mut scan_buf, "boot output\n").is_empty());
        assert!(scan_buf.is_empty());
        // First half: introducer with no terminator. It must be retained.
        assert!(feed(&mut scan_buf, "\x1b]777;notify;Claude;needs").is_empty());
        assert_eq!(scan_buf, "\x1b]777;notify;Claude;needs");
        // Second half completes it.
        let hits = feed(&mut scan_buf, " input\x07");
        assert_eq!(hits, vec![("Claude".into(), "needs input".into())]);
        assert!(scan_buf.is_empty(), "settled hit is drained");
    }

    #[test]
    fn a_sequence_split_exactly_at_the_esc_is_still_found() {
        // The read boundary falls between `ESC` and `]`.
        let mut scan_buf = String::new();
        assert!(feed(&mut scan_buf, "text\x1b").is_empty());
        assert_eq!(scan_buf, "\x1b", "the lone ESC is held");
        let hits = feed(&mut scan_buf, "]9;ping\x07");
        assert_eq!(hits, vec![(String::new(), "ping".into())]);
        assert!(scan_buf.is_empty());
    }

    #[test]
    fn a_hit_is_emitted_exactly_once_across_reads() {
        let mut scan_buf = String::new();
        let hits = feed(&mut scan_buf, "\x1b]9;once\x07");
        assert_eq!(hits.len(), 1);
        // More output arrives; the settled hit must not re-fire.
        assert!(feed(&mut scan_buf, "more output\n").is_empty());
        assert!(feed(&mut scan_buf, "even more\n").is_empty());
    }

    // ---- alert text is bounded and control-free (card 25) -------------------

    #[test]
    fn an_oversized_osc_title_is_truncated() {
        let huge = "A".repeat(1_000_000);
        let seq = format!("\x1b]777;notify;{huge};body\x07");
        let (title, body) = hits(&seq).into_iter().next().expect("one hit");
        assert_eq!(title.chars().count(), MAX_ALERT_TEXT_CHARS);
        assert_eq!(body, "body");
    }

    #[test]
    fn an_oversized_osc9_body_is_truncated() {
        let seq = format!("\x1b]9;{}\x07", "B".repeat(5_000));
        let (_, body) = hits(&seq).into_iter().next().expect("one hit");
        assert_eq!(body.chars().count(), MAX_ALERT_TEXT_CHARS);
    }

    #[test]
    fn control_characters_are_stripped_from_alert_text() {
        // A forged alert must not be able to break the banner across lines.
        let seq = "\x1b]777;notify;Cla\rude\x08\x7f;needs\ninput\x07";
        assert_eq!(
            hits(seq),
            vec![("Claude".into(), "needsinput".into())],
            "CR, backspace, DEL and LF must all be dropped"
        );
    }

    #[test]
    fn truncation_counts_characters_not_bytes() {
        // 300 three-byte glyphs: a byte-based cut would split one in half.
        let glyphs = "字".repeat(300);
        let out = sanitize_alert_text(&glyphs);
        assert_eq!(out.chars().count(), MAX_ALERT_TEXT_CHARS);
        assert!(out.chars().all(|c| c == '字'));
    }

    #[test]
    fn short_clean_alert_text_passes_through_unchanged() {
        assert_eq!(
            sanitize_alert_text("Claude needs input"),
            "Claude needs input"
        );
        assert_eq!(sanitize_alert_text(""), "");
    }

    #[test]
    fn an_osc99_alert_is_sanitized_too() {
        let seq = format!("\x1b]99;p=body;{}\x07", "x".repeat(1000));
        let (_, body) = hits(&seq).into_iter().next().expect("one hit");
        assert_eq!(body.chars().count(), MAX_ALERT_TEXT_CHARS);
    }

    // ---- reap_session: no shell may linger as a zombie ----------------------

    #[test]
    #[cfg(unix)]
    fn reap_session_reaps_a_dead_shell_and_forgets_it() {
        use super::{PtyManager, Session};
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::sync::{Arc, Mutex};

        let manager = PtyManager::default();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 4,
                cols: 20,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let writer = pair.master.take_writer().expect("writer");
        // A child that exits immediately: the self-exited-shell (EOF) case.
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("exit 0");
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        manager.sessions.lock().unwrap().insert(
            "t".into(),
            Session {
                master: Arc::new(Mutex::new(pair.master)),
                writer: Arc::new(Mutex::new(writer)),
                child,
                out: Arc::new(Mutex::new(OutBuf::new())),
                persist_key: None,
                shell_pid: None,
            },
        );

        assert!(manager.reap_session("t"), "a registered session is reaped");
        assert!(
            manager.sessions.lock().unwrap().is_empty(),
            "the dead session is dropped from the map"
        );
        assert!(!manager.reap_session("t"), "reaping again is a no-op");
    }

    #[test]
    fn keep_from_is_always_a_char_boundary() {
        // `drain(..keep_from)` panics otherwise. Multi-byte glyphs, then an ESC.
        for text in ["日本語", "│⠋│", "日本語\x1b", "⠋\x1b]9;x\x07⠋"] {
            let (_, keep_from) = scan_attention(text);
            assert!(
                text.is_char_boundary(keep_from),
                "keep_from {keep_from} splits a glyph in {text:?}"
            );
        }
    }
}

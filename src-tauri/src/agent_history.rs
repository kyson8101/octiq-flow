//! Sessions the AGENTS remember, not the ones this app started.
//!
//! `chat_index.rs` lists the chats OctiqFlow itself opened. This lists the far
//! larger set behind them: every session Claude Code and Codex have written
//! down on this machine, including the ones started in a terminal, in another
//! editor, or by another tool entirely. They are all resumable — the agents
//! keep them precisely so `claude --resume <id>` and `codex resume <id>` work —
//! so the only thing missing was a way to FIND one.
//!
//! Two locations, one per agent:
//!
//!   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
//!   ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<stamp>-<session-id>.jsonl
//!
//! ## Reading them cheaply
//!
//! There can be thousands, and a single transcript runs to megabytes, so a full
//! read is out of the question. Everything the list needs — what was first
//! asked, where it ran, which model, how hard it was thinking — is written near
//! the TOP of the file, so each one is read only until those are found and
//! never past a fixed budget (`MAX_LINES` / `MAX_BYTES`). Files are then taken
//! newest-first and capped per agent.
//!
//! Parsed results are cached against the file's modification time. A finished
//! session never changes again, so the second call does almost no work.
//!
//! ## What it deliberately does NOT do
//!
//! It does not search inside transcripts. The title (the first real thing the
//! user said) is what people remember a session by, and matching against it can
//! be done in the browser on a list this small. Reading every message of every
//! session to match a word would undo the whole point of the budget above.
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Files parsed per agent, newest first. Well past what anyone scrolls, and it
/// bounds the worst case on a machine with years of sessions on it.
const MAX_PER_AGENT: usize = 400;

/// How far into one file we are willing to read before giving up on it. Both
/// agents write their header, the first prompt and the first model within a few
/// lines; anything beyond this is a session whose opening is unusually large,
/// and it is cheaper to list it plainly than to keep reading.
const MAX_LINES: usize = 240;
const MAX_BYTES: u64 = 512 * 1024;

/// A title long enough to recognise the work, short enough for one row.
const TITLE_MAX: usize = 140;

/// One past session, as the search list needs it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySession {
    /// "claude" or "codex" — which program can resume it.
    pub agent: String,
    /// The agent's own id. This is the thing `--resume` takes.
    pub session_id: String,
    /// The first real thing the user said.
    pub title: String,
    /// The folder it ran in, so a session can be matched to a project.
    pub cwd: String,
    /// When the file was created and last written, in milliseconds. The second
    /// is what the list orders by: the session touched most recently is the one
    /// most likely to be wanted.
    pub started_at: i64,
    pub updated_at: i64,
    /// What it was last recorded as running under, so resuming can put the
    /// picker back where it was rather than silently choosing for you.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Who started it, when the agent records that (Codex does). A session
    /// opened by another tool reads very differently from one you typed, and
    /// the list would be misleading without saying which is which.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// A parsed file: the modification time it was read at, and what came out of
/// it. `None` means "read, nothing usable in it" — worth remembering so an
/// empty file is not re-read on every call.
type Parsed = (i64, Option<HistorySession>);

/// Parsed files, keyed by path, each valid while its modification time matches.
static CACHE: Mutex<Option<HashMap<PathBuf, Parsed>>> = Mutex::new(None);

/// Every session both agents remember, newest activity first.
///
/// `limit` caps the answer; it is a list to search, not an archive to page
/// through, and the whole thing crosses a WebSocket to a phone.
#[tauri::command]
pub fn agent_history_list(limit: Option<usize>) -> Vec<HistorySession> {
    let mut all = scan_claude();
    all.extend(scan_codex());
    all.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    all.truncate(limit.unwrap_or(600));
    all
}

// ---- reading one session back --------------------------------------------

/// How many messages one session hands back.
///
/// A transcript runs to megabytes and this crosses a WebSocket to a phone, so
/// there has to be a limit. It falls on the OLDEST messages: someone picking a
/// session back up is looking for where they left off, so the end of the file
/// is the part worth keeping.
const READ_MAX_EVENTS: usize = 600;

/// How much of a file is read looking for those messages. Generous next to the
/// list's budget — this is one file, asked for deliberately, not a few hundred
/// scanned on every keystroke.
const READ_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// Bookkeeping lines in a Claude session file. Everything here is the agent
/// talking to itself about the session — what mode it is in, which hook ran,
/// what the file looked like — rather than something a person or the model
/// said. Unknown types join them: a new one this app has never seen is far more
/// likely to be more bookkeeping than a new kind of speech.
fn is_claude_message(kind: &str) -> bool {
    matches!(kind, "user" | "assistant")
}

/// A Claude session file's text, as events the frontend reducer already reads.
///
/// This is a FILTER, not a translation. Claude writes each turn as
/// `{"type":"user"|"assistant","message":{"role","content"}}`, which is the
/// very shape `chat.ts::reduceChat` folds a LIVE stream into — so the history
/// can go through the same tested reducer as a running chat, and neither side
/// has to learn a second message format.
fn claude_events(contents: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // A torn line is what a file being appended to RIGHT NOW looks like.
        // Skipping it keeps the good lines around it; stopping would lose them.
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !value["type"].as_str().is_some_and(is_claude_message) {
            continue;
        }
        // A sidechain entry is a SUBAGENT's own transcript, written into the
        // same file. It is not part of this conversation, and showing it would
        // interleave a second speaker in with no way to tell them apart.
        if value["isSidechain"] == Value::Bool(true) {
            continue;
        }
        if value["message"].is_null() {
            continue;
        }
        out.push(normalise_content(value));
    }
    // Keep the TAIL. `drain` rather than a reversed collect so the messages
    // stay in the order they were said.
    if out.len() > READ_MAX_EVENTS {
        out.drain(..out.len() - READ_MAX_EVENTS);
    }
    out
}

/// Make `message.content` ALWAYS a block list.
///
/// Claude writes a plain user turn as a bare string — `"content":"fix the bug"`
/// — and a turn with anything else in it as a list of blocks. A LIVE stream only
/// ever sends the list, so the frontend reducer only ever learned the list: it
/// reads `content` through an as-array helper that answers empty for a string,
/// and a whole session's user turns went missing without a word.
///
/// Fixing it here rather than in the reducer is deliberate. The reducer is on
/// the path of every running chat and is the most-tested thing in the app;
/// widening it to serve history would put live conversations at risk for a
/// shape only history has. This is the seam that owes the reducer a clean
/// contract, so it pays it: one shape, always.
fn normalise_content(mut value: Value) -> Value {
    if let Some(text) = value["message"]["content"].as_str() {
        let blocks = json!([{ "type": "text", "text": text }]);
        value["message"]["content"] = blocks;
    }
    value
}

/// A Codex rollout file's text, as the SAME events `claude_events` returns.
///
/// Codex writes nothing like Claude does, and this is exactly why the
/// normalising lives in the backend: the frontend then has one message format
/// and one reducer, instead of a second parser for a second agent.
///
/// Codex records each turn twice — once as an `event_msg` (what the CLI printed)
/// and once as a `response_item` (what went to the model). Only the first is
/// read; taking both would show every turn double. The `response_item` side also
/// carries the `developer` system prompt, which is kilobytes of instructions
/// nobody typed.
fn codex_events(contents: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value["type"].as_str() != Some("event_msg") {
            continue;
        }
        let payload = &value["payload"];
        let role = match payload["type"].as_str() {
            Some("user_message") => "user",
            Some("agent_message") => "assistant",
            // task_started / task_complete / token_count and the rest are the
            // run's bookkeeping, not speech.
            _ => continue,
        };
        let Some(text) = payload["message"].as_str() else {
            continue;
        };
        out.push(json!({
            "type": role,
            "message": { "role": role, "content": [{ "type": "text", "text": text }] },
        }));
    }
    if out.len() > READ_MAX_EVENTS {
        out.drain(..out.len() - READ_MAX_EVENTS);
    }
    out
}

/// Read one past session back, as events the frontend reducer understands.
///
/// The list (`agent_history_list`) says which sessions exist; this says what
/// was said in one of them, so it can be READ before it is picked up. Nothing
/// is started here and nothing is resumed — the session id stays on the
/// conversation, and the first thing typed still goes out as `--resume <id>`.
#[tauri::command]
pub fn agent_history_read(agent: String, session_id: String) -> Result<Vec<Value>, String> {
    // The id reaches the filesystem, so it is checked before anything is
    // opened. `agent_chat` already owns this rule and the two must not drift.
    let id = crate::agent_chat::safe_session_id(&session_id)
        .ok_or_else(|| format!("not a usable session id: {session_id:?}"))?;

    let path = match agent.as_str() {
        "claude" => find_claude_file(&id),
        "codex" => find_codex_file(&id),
        // Falling through to one of the two would read the wrong folder
        // entirely, so an agent this app does not speak for is an error.
        other => return Err(format!("no such agent: {other:?}")),
    }
    .ok_or_else(|| format!("no {agent} session on this machine with id {id}"))?;

    let contents = read_capped(&path)?;
    Ok(match agent.as_str() {
        "codex" => codex_events(&contents),
        _ => claude_events(&contents),
    })
}

/// The file's text, up to the byte budget. Reading whole is fine at this size
/// and far simpler than streaming; the budget is what keeps it fine.
fn read_capped(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let file = File::open(path).map_err(|e| format!("cannot open that session: {e}"))?;
    let mut text = String::new();
    BufReader::new(file.take(READ_MAX_BYTES))
        .read_to_string(&mut text)
        .map_err(|e| format!("cannot read that session: {e}"))?;
    Ok(text)
}

/// `~/.claude/projects/<any>/<session-id>.jsonl`. The folder is the encoded
/// working directory, which cannot be reconstructed from the id, so the one
/// level of folders is looked through rather than guessed at.
fn find_claude_file(id: &str) -> Option<PathBuf> {
    let root = claude_root()?;
    let name = format!("{id}.jsonl");
    for entry in fs::read_dir(root).ok()?.flatten() {
        let candidate = entry.path().join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<stamp>-<session-id>.jsonl`.
///
/// The id is a SUFFIX of the file name, not the whole of it, and the dated
/// folders have to be walked — so this reuses the same depth-limited walk the
/// list uses rather than growing a second one.
fn find_codex_file(id: &str) -> Option<PathBuf> {
    let root = codex_root()?;
    let mut files = Vec::new();
    jsonl_files(&root, 3, &mut files);
    let suffix = format!("-{id}.jsonl");
    files
        .into_iter()
        .find(|(path, _, _)| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(&suffix))
        })
        .map(|(path, _, _)| path)
}

// ---- finding the files ---------------------------------------------------

/// `~/.claude/projects/*/<session-id>.jsonl`.
///
/// The folder name is the working directory with its separators replaced, which
/// is lossy — a path that contained a dash is no longer tellable from one that
/// contained a slash — so the real `cwd` is read out of the file instead.
fn claude_root() -> Option<PathBuf> {
    Some(crate::paths::home_dir()?.join(".claude").join("projects"))
}

/// `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`. `archived_sessions`
/// next door is deliberately not looked at: putting a session there is how you
/// say you are done with it.
fn codex_root() -> Option<PathBuf> {
    Some(crate::paths::home_dir()?.join(".codex").join("sessions"))
}

/// Milliseconds since the epoch, or 0 for a time we cannot read. Zero sorts
/// last, which is the right place for a file whose age is unknown.
fn millis(time: std::io::Result<SystemTime>) -> i64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Every `.jsonl` under `root`, no deeper than `depth` folders down.
///
/// Depth-limited rather than a full walk: Codex nests exactly three levels
/// (year/month/day) and Claude exactly one, so anything deeper is not a session
/// file and following it would only cost time.
fn jsonl_files(root: &Path, depth: usize, out: &mut Vec<(PathBuf, i64, i64)>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if depth > 0 {
                jsonl_files(&path, depth - 1, out);
            }
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let modified = millis(meta.modified());
        let created = millis(meta.created());
        out.push((path, if created > 0 { created } else { modified }, modified));
    }
}

/// The newest `MAX_PER_AGENT` files under `root`, parsed through the cache.
fn collect(
    root: Option<PathBuf>,
    depth: usize,
    parse: fn(&Path, i64, i64) -> Option<HistorySession>,
) -> Vec<HistorySession> {
    let Some(root) = root else {
        return Vec::new();
    };
    let mut files = Vec::new();
    jsonl_files(&root, depth, &mut files);
    // Newest activity first, THEN capped: the cap has to fall on the oldest
    // sessions, not on whichever ones the directory happened to list last.
    files.sort_by_key(|f| std::cmp::Reverse(f.2));
    files.truncate(MAX_PER_AGENT);

    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    let mut out = Vec::with_capacity(files.len());
    for (path, created, modified) in files {
        let hit = match cache.get(&path) {
            Some((seen, session)) if *seen == modified => session.clone(),
            _ => {
                let parsed = parse(&path, created, modified);
                cache.insert(path.clone(), (modified, parsed.clone()));
                parsed
            }
        };
        if let Some(session) = hit {
            out.push(session);
        }
    }
    // The cache would otherwise grow with every session ever seen, including
    // ones long since deleted. It is only ever a shortcut, so dropping it whole
    // when it outgrows the working set costs one slow call and nothing else.
    if cache.len() > MAX_PER_AGENT * 4 {
        cache.clear();
    }
    out
}

fn scan_claude() -> Vec<HistorySession> {
    collect(claude_root(), 1, parse_claude)
}

fn scan_codex() -> Vec<HistorySession> {
    collect(codex_root(), 3, parse_codex)
}

// ---- reading one file ----------------------------------------------------

/// Walk the opening lines of a JSONL file, handing each interesting one to
/// `take`. Reading stops the moment `take` says it has everything, and in any
/// case at the budget.
///
/// Two things keep this cheap, and both matter at the scale of a few hundred
/// files:
///
///   - `wanted` is asked about the RAW text first. Most of the weight in these
///     files is in lines this module has no use for — a Codex rollout opens
///     with tens of kilobytes of tool and skill instructions on a single line —
///     and handing those to a JSON parser was, measured on a real machine, five
///     sixths of the time the scan took.
///   - `take` returning `true` ends the read. Everything wanted here sits in
///     the first few lines, so a session is usually finished with long before
///     the line budget is anywhere near.
///
/// Lines that are not JSON are skipped rather than ending the read: a truncated
/// write in the middle of a file must not hide the good lines around it.
fn read_head(path: &Path, wanted: fn(&str) -> bool, mut take: impl FnMut(&Value) -> bool) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let mut reader = BufReader::new(file);
    let mut used = 0u64;
    let mut seen = 0usize;
    let mut line = String::new();
    while seen < MAX_LINES && used < MAX_BYTES {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(n) => used += n as u64,
        }
        seen += 1;
        if !wanted(&line) {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
            if take(&value) {
                break;
            }
        }
    }
}

/// How much of a line the marker search looks at.
///
/// It is a prefix, not the whole line, and that is the difference between a
/// scan that takes a moment and one that takes half a minute: a line can be
/// megabytes of tool output, and searching all of it — for every marker, on
/// every line, of every file — was the single biggest cost measured here.
///
/// A prefix is enough because both agents put the fields that say WHAT a line
/// is at the front of it: Codex opens with its timestamp and type, and Claude's
/// `message.role` sits within the first hundred bytes or so. The markers below
/// are chosen to be ones that appear there.
const MARKER_WINDOW: usize = 400;

/// Whether the start of a raw line contains any of these markers.
///
/// The markers are compile-time constants on purpose: building the needle per
/// line would put an allocation in front of every one of the hundreds of
/// thousands of lines this scan walks past. Deliberately approximate — a false
/// positive costs one parse, and the parse then tells the truth.
fn has_any(line: &str, markers: &[&str]) -> bool {
    let mut end = MARKER_WINDOW.min(line.len());
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    let head = &line[..end];
    markers.iter().any(|m| head.contains(m))
}

/// One line of prose, cut to a length that fits a row.
fn clip(text: &str) -> String {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= TITLE_MAX {
        return clean;
    }
    let short: String = clean.chars().take(TITLE_MAX).collect();
    format!("{short}…")
}

/// Whether this is something a person typed, rather than machinery.
///
/// Both agents put a great deal into the user's own turn that the user never
/// wrote: slash-command envelopes, hook output, environment dumps, the project
/// instructions file, the reminder blocks this very file is being read under.
/// Most announce themselves with a tag, so a leading `<` is the one reliable
/// tell — and a real prompt that starts with one is rare enough to be worth
/// losing to keep the list readable. Codex's copy of `AGENTS.md` is the one
/// common block that does not, so it is named.
fn looks_typed(text: &str) -> bool {
    let t = text.trim_start();
    !t.is_empty()
        && !t.starts_with('<')
        && !t.starts_with("Caveat:")
        && !t.starts_with("# AGENTS.md")
}

/// The text parts of a message body, kept SEPARATE.
///
/// A message body is a plain string in the simple case and a list of parts in
/// every other. Joining the parts was the obvious thing and the wrong one: a
/// Codex turn opens with a block listing plugins the user does not have, and
/// the thing they actually typed is the part after it. Kept apart, the machine
/// block can be stepped over and the real sentence found underneath.
///
/// Tool results live in that same list and are not prose, so only
/// `text`/`input_text` parts are taken.
fn text_parts(content: &Value) -> Vec<String> {
    if let Some(text) = content.as_str() {
        return vec![text.to_string()];
    }
    let Some(parts) = content.as_array() else {
        return Vec::new();
    };
    parts
        .iter()
        .filter(|p| {
            matches!(
                p.get("type").and_then(Value::as_str),
                Some("text") | Some("input_text")
            )
        })
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

/// Offer the parts of one user turn as the session's name.
///
/// The first part that reads like something a person typed wins. Anything else
/// is only remembered as a LAST resort, and only the first of those — a session
/// whose every turn is machinery still has to be listed as something, and the
/// opening of it is the most recognisable thing available.
fn offer_title(parts: &[String], title: &mut Option<String>, fallback: &mut Option<String>) {
    for part in parts {
        if looks_typed(part) {
            *title = Some(clip(part));
            return;
        }
        if fallback.is_none() && !part.trim().is_empty() {
            *fallback = Some(clip(part));
        }
    }
}

/// Claude Code's record. The file is named after the session, so the id needs
/// no parsing; everything else comes off the first lines that carry it.
fn parse_claude(path: &Path, created: i64, modified: i64) -> Option<HistorySession> {
    let session_id = path.file_stem()?.to_str()?.to_string();
    if session_id.is_empty() {
        return None;
    }

    let mut title = None;
    let mut fallback = None;
    let mut cwd = String::new();
    let mut model = None;
    let mut effort = None;

    // Only the two kinds of line that carry anything: what was said, and what
    // said it. `cwd` rides on both, so nothing is lost by ignoring the rest.
    //
    // Matched on the presence of a `message` rather than on the line's own
    // `type`, because Claude writes `type` AFTER the message — past the window,
    // on any line long enough to matter. The message itself starts early, and
    // only the two kinds of line we want have one.
    fn wanted(line: &str) -> bool {
        has_any(line, &["\"message\":{", "\"message\": {"])
    }

    read_head(path, wanted, |line| {
        // A sidechain is a subagent's own conversation, threaded into the same
        // file. Resuming the session resumes the MAIN thread, so naming it
        // after something a subagent was told would point at the wrong work.
        if line.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return false;
        }
        if cwd.is_empty() {
            if let Some(dir) = line.get("cwd").and_then(Value::as_str) {
                cwd = dir.to_string();
            }
        }
        match line.get("type").and_then(Value::as_str) {
            Some("user") if title.is_none() => {
                if line.get("isMeta").and_then(Value::as_bool) == Some(true) {
                    return false;
                }
                let parts = text_parts(line.pointer("/message/content").unwrap_or(&Value::Null));
                offer_title(&parts, &mut title, &mut fallback);
            }
            Some("assistant") if model.is_none() => {
                model = line
                    .pointer("/message/model")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                effort = line
                    .get("effort")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            _ => {}
        }
        title.is_some() && model.is_some() && !cwd.is_empty()
    });

    // Nothing was ever said in it. That is a session that failed to start, and
    // listing it only makes the real ones harder to find.
    let title = title.or(fallback)?;
    Some(HistorySession {
        agent: "claude".into(),
        session_id,
        title,
        cwd,
        started_at: created,
        updated_at: modified,
        model,
        effort,
        origin: None,
    })
}

/// Codex's rollout file. Its first line is a header with the id and folder;
/// the model and effort belong to a turn, so they come off the first
/// `turn_context`; and the cleanest copy of what the user said is the
/// `user_message` event rather than the model-facing item beside it.
fn parse_codex(path: &Path, created: i64, modified: i64) -> Option<HistorySession> {
    let mut session_id = String::new();
    let mut title = None;
    let mut fallback = None;
    let mut cwd = String::new();
    let mut model = None;
    let mut effort = None;
    let mut origin = None;

    // The header, the turn settings, and the user's own words. Everything else
    // in a rollout — the base instructions, the developer preamble, every tool
    // call and its output — is skipped without being parsed. `"role":"user"`
    // is what keeps the developer preamble out while letting the fallback
    // title in, since both are `response_item` lines.
    fn wanted(line: &str) -> bool {
        has_any(
            line,
            &[
                "\"session_meta\"",
                "\"turn_context\"",
                "\"user_message\"",
                "\"role\":\"user\"",
                "\"role\": \"user\"",
            ],
        )
    }

    read_head(path, wanted, |line| {
        let kind = line.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = line.get("payload").unwrap_or(&Value::Null);
        match kind {
            "session_meta" => {
                session_id = payload
                    .get("id")
                    .or_else(|| payload.get("session_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                cwd = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                origin = payload
                    .get("originator")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            "turn_context" if model.is_none() => {
                model = payload
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                effort = payload
                    .get("effort")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            "event_msg"
                if title.is_none()
                    && payload.get("type").and_then(Value::as_str) == Some("user_message") =>
            {
                let text = payload.get("message").and_then(Value::as_str).unwrap_or("");
                offer_title(&[text.to_string()], &mut title, &mut fallback);
            }
            "response_item"
                if title.is_none()
                    && payload.get("role").and_then(Value::as_str) == Some("user") =>
            {
                let parts = text_parts(payload.get("content").unwrap_or(&Value::Null));
                offer_title(&parts, &mut title, &mut fallback);
            }
            _ => {}
        }
        title.is_some() && model.is_some() && !session_id.is_empty()
    });

    if session_id.is_empty() {
        return None;
    }
    let title = title.or(fallback)?;
    Some(HistorySession {
        agent: "codex".into(),
        session_id,
        title,
        cwd,
        started_at: created,
        updated_at: modified,
        model,
        effort,
        origin,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A scratch file under the OS temp dir, removed when the test ends.
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    fn write(name: &str, body: &str) -> Temp {
        let path = std::env::temp_dir().join(name);
        let mut file = File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
        Temp(path)
    }

    #[test]
    fn a_claude_session_is_named_after_the_first_thing_typed() {
        let body = concat!(
            r#"{"type":"summary","leafUuid":"x"}"#,
            "\n",
            r#"{"type":"user","cwd":"/w","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
            "\n",
            r#"{"type":"user","cwd":"/w","message":{"role":"user","content":"fix the login bug"}}"#,
            "\n",
            r#"{"type":"assistant","effort":"high","message":{"model":"claude-opus-5"}}"#,
            "\n",
        );
        let file = write("octiq-hist-claude.jsonl", body);
        let s = parse_claude(&file.0, 10, 20).expect("a session");
        assert_eq!(s.session_id, "octiq-hist-claude");
        assert_eq!(s.title, "fix the login bug");
        assert_eq!(s.cwd, "/w");
        assert_eq!(s.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(s.effort.as_deref(), Some("high"));
    }

    #[test]
    fn a_subagents_words_never_become_the_title() {
        let body = concat!(
            r#"{"type":"user","isSidechain":true,"cwd":"/w","message":{"role":"user","content":"you are a subagent"}}"#,
            "\n",
            r#"{"type":"user","cwd":"/w","message":{"role":"user","content":"what I actually asked"}}"#,
            "\n",
        );
        let file = write("octiq-hist-side.jsonl", body);
        let s = parse_claude(&file.0, 10, 20).expect("a session");
        assert_eq!(s.title, "what I actually asked");
    }

    #[test]
    fn a_session_nobody_spoke_in_is_left_out() {
        let file = write(
            "octiq-hist-empty.jsonl",
            "{\"type\":\"summary\",\"leafUuid\":\"x\"}\n",
        );
        assert!(parse_claude(&file.0, 10, 20).is_none());
    }

    #[test]
    fn a_codex_session_carries_its_model_and_effort() {
        let body = concat!(
            r#"{"type":"session_meta","payload":{"id":"019f-abc","cwd":"/repo","originator":"Codex Desktop"}}"#,
            "\n",
            r#"{"type":"turn_context","payload":{"model":"gpt-5.6-terra","effort":"medium"}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<recommended_plugins>noise"}]}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"write the release notes"}}"#,
            "\n",
        );
        let file = write("octiq-hist-codex.jsonl", body);
        let s = parse_codex(&file.0, 10, 20).expect("a session");
        assert_eq!(s.agent, "codex");
        assert_eq!(s.session_id, "019f-abc");
        assert_eq!(s.title, "write the release notes");
        assert_eq!(s.model.as_deref(), Some("gpt-5.6-terra"));
        assert_eq!(s.effort.as_deref(), Some("medium"));
        assert_eq!(s.origin.as_deref(), Some("Codex Desktop"));
    }

    #[test]
    fn the_real_sentence_is_found_under_a_machine_block_in_the_same_turn() {
        // Codex puts a plugin listing in front of the user's first message, in
        // the same turn. Joining the parts made every such session read as
        // "<recommended_plugins> …"; they are looked at one at a time instead.
        let body = concat!(
            r#"{"type":"session_meta","payload":{"id":"019f-ghi","cwd":"/repo"}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<recommended_plugins>Airtable, Asana"},{"type":"input_text","text":"rename the deploy step"}]}}"#,
            "\n",
        );
        let file = write("octiq-hist-parts.jsonl", body);
        let s = parse_codex(&file.0, 10, 20).expect("a session");
        assert_eq!(s.title, "rename the deploy step");
    }

    #[test]
    fn a_machine_written_turn_is_only_a_last_resort_title() {
        let body = concat!(
            r#"{"type":"session_meta","payload":{"id":"019f-def","cwd":"/repo"}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"<environment_context>cwd=/repo"}}"#,
            "\n",
        );
        let file = write("octiq-hist-fallback.jsonl", body);
        let s = parse_codex(&file.0, 10, 20).expect("a session");
        assert!(
            s.title.starts_with("<environment_context>"),
            "got {}",
            s.title
        );
    }

    #[test]
    fn a_long_first_line_is_cut_to_one_row() {
        let long = "x".repeat(TITLE_MAX + 50);
        assert!(clip(&long).chars().count() <= TITLE_MAX + 1);
        assert_eq!(clip("  two   spaces  "), "two spaces");
    }

    // ---- reading one session back --------------------------------------

    /// The whole design of the read in one test: what comes back is what the
    /// FRONTEND REDUCER already understands, so nothing has to learn a second
    /// message format. A Claude file's `user`/`assistant` lines are already
    /// that shape, so reading one is a FILTER — keep those two, drop the
    /// bookkeeping around them.
    #[test]
    fn a_claude_session_reads_back_only_what_was_said() {
        let body = concat!(
            r#"{"type":"last-prompt","leafUuid":"x"}"#,
            "\n",
            r#"{"type":"mode","mode":"normal"}"#,
            "\n",
            r#"{"type":"permission-mode","permissionMode":"auto"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":"fix the login bug"}}"#,
            "\n",
            r#"{"type":"attachment","attachment":{"type":"hook_success"}}"#,
            "\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"on it"}]}}"#,
            "\n",
            r#"{"type":"file-history-snapshot","snapshot":{}}"#,
            "\n",
        );
        let out = claude_events(body);
        let kinds: Vec<&str> = out.iter().filter_map(|e| e["type"].as_str()).collect();
        assert_eq!(kinds, vec!["user", "assistant"], "kept: {kinds:?}");
        // Claude writes a plain user turn as a bare STRING and everything else
        // as a block list. What leaves here is always the list — see
        // `normalise_content` for why the reducer must not have to know that.
        assert_eq!(out[0]["message"]["content"][0]["type"], "text");
        assert_eq!(out[0]["message"]["content"][0]["text"], "fix the login bug");
        assert_eq!(out[1]["message"]["content"][0]["text"], "on it");
    }

    /// The shape a live stream never sends, and the one a session file is full
    /// of. It went missing silently before `normalise_content`.
    #[test]
    fn a_plain_user_turn_written_as_a_bare_string_still_arrives_as_blocks() {
        let out =
            claude_events(r#"{"type":"user","message":{"role":"user","content":"just words"}}"#);
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0]["message"]["content"],
            json!([{ "type": "text", "text": "just words" }])
        );
    }

    /// A turn that ALREADY is a block list is left exactly as it was — tool
    /// calls and thinking blocks included, since the reducer reads those too.
    #[test]
    fn a_turn_that_is_already_blocks_is_left_alone() {
        let out = claude_events(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"tool_use","id":"t1","name":"Read"}]}}"#,
        );
        assert_eq!(out[0]["message"]["content"][0]["type"], "thinking");
        assert_eq!(out[0]["message"]["content"][1]["name"], "Read");
    }

    /// A sidechain entry is a SUBAGENT's private transcript. It is written into
    /// the same file, but it is not part of this conversation, and showing it
    /// would interleave a second speaker into the history with no way to tell
    /// which was which.
    #[test]
    fn a_subagents_own_transcript_is_not_part_of_the_conversation() {
        let body = concat!(
            r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"go and look"}}"#,
            "\n",
            r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"found it"}]}}"#,
            "\n",
            r#"{"type":"user","isSidechain":false,"message":{"role":"user","content":"and mine"}}"#,
            "\n",
        );
        let out = claude_events(body);
        assert_eq!(out.len(), 1, "only the main conversation: {out:?}");
        assert_eq!(out[0]["message"]["content"][0]["text"], "and mine");
    }

    /// A torn last line is what a file being written to right now looks like.
    /// It must not hide the good lines above it.
    #[test]
    fn a_half_written_line_does_not_lose_the_rest() {
        let body = concat!(
            r#"{"type":"user","message":{"role":"user","content":"one"}}"#,
            "\n",
            r#"{"type":"assistant","message":{"role":"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":"two"}}"#,
            "\n",
        );
        let out = claude_events(body);
        assert_eq!(out.len(), 2, "the torn line is skipped, not fatal");
    }

    /// A transcript runs to megabytes and crosses a WebSocket to a phone. The
    /// cap falls on the END of the file, not the start: the last thing said is
    /// what someone picking a session back up is looking for.
    #[test]
    fn a_huge_transcript_is_cut_to_its_most_recent_messages() {
        let one = r#"{"type":"user","message":{"role":"user","content":"x"}}"#;
        let mut body = String::new();
        for i in 0..(READ_MAX_EVENTS + 40) {
            body.push_str(&one.replace("\"x\"", &format!("\"line {i}\"")));
            body.push('\n');
        }
        let out = claude_events(&body);
        assert_eq!(out.len(), READ_MAX_EVENTS, "capped");
        assert_eq!(
            out.last().unwrap()["message"]["content"][0]["text"],
            format!("line {}", READ_MAX_EVENTS + 39),
            "the cap keeps the NEWEST messages"
        );
    }

    /// The id reaches the filesystem, so it is checked before anything is
    /// opened. `agent_chat` already owns that rule; this must not grow a
    /// second, more forgiving one.
    #[test]
    fn a_session_id_that_could_climb_out_of_the_folder_is_refused() {
        for bad in ["../../etc/passwd", "..", "a/b", "a b", ""] {
            assert!(
                agent_history_read("claude".into(), bad.into()).is_err(),
                "should refuse {bad:?}"
            );
        }
        // A real id is not refused by the guard. (It has no file here, so it
        // fails LATER, on the read — which is a different error.)
        let real = agent_history_read(
            "claude".into(),
            "4749ea34-190b-4520-8a92-4a961cd4729b".into(),
        );
        if let Err(e) = real {
            assert!(!e.contains("session id"), "guard should have passed: {e}");
        }
    }

    /// An agent this app does not speak for must not fall through to one it
    /// does — that would read the wrong folder entirely.
    #[test]
    fn an_unknown_agent_is_refused_rather_than_guessed() {
        assert!(agent_history_read("gemini".into(), "abc-123".into()).is_err());
    }

    // ---- card 59: the same door, for Codex -----------------------------

    /// Codex's file is shaped nothing like Claude's, which is the whole reason
    /// the normalising happens HERE: what comes out is the same `user` /
    /// `assistant` shape, so the frontend keeps one reducer and one format.
    #[test]
    fn a_codex_session_is_normalised_into_the_same_shape() {
        let body = concat!(
            r#"{"type":"session_meta","payload":{"session_id":"abc","cwd":"/w"}}"#,
            "\n",
            r#"{"type":"turn_context","payload":{}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"reply with OK"}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"OK"}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{}}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}"#,
            "\n",
        );
        let out = codex_events(body);
        let kinds: Vec<&str> = out.iter().filter_map(|e| e["type"].as_str()).collect();
        assert_eq!(kinds, vec!["user", "assistant"], "kept: {kinds:?}");
        assert_eq!(out[0]["message"]["role"], "user");
        assert_eq!(out[0]["message"]["content"][0]["type"], "text");
        assert_eq!(out[0]["message"]["content"][0]["text"], "reply with OK");
        assert_eq!(out[1]["message"]["role"], "assistant");
        assert_eq!(out[1]["message"]["content"][0]["text"], "OK");
    }

    /// The `developer` message is the SYSTEM PROMPT — kilobytes of instructions
    /// nobody typed. Showing it as the first thing said would bury the actual
    /// conversation.
    #[test]
    fn the_codex_system_prompt_is_not_something_anybody_said() {
        let body = concat!(
            r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<skills_instructions>…"}]}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}"#,
            "\n",
        );
        let out = codex_events(body);
        assert_eq!(out.len(), 1, "only the human turn: {out:?}");
        assert_eq!(out[0]["message"]["content"][0]["text"], "hello");
    }

    /// Codex writes each turn TWICE — once as the `event_msg` this reads, and
    /// once as a `response_item` carrying the same words. Taking both would
    /// show the whole conversation double.
    #[test]
    fn a_codex_turn_recorded_twice_is_shown_once() {
        let body = concat!(
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"hi"}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}"#,
            "\n",
        );
        let out = codex_events(body);
        let kinds: Vec<&str> = out.iter().filter_map(|e| e["type"].as_str()).collect();
        assert_eq!(
            kinds,
            vec!["user", "assistant"],
            "said once each: {kinds:?}"
        );
    }

    /// The same tail rule as Claude's, for the same reason.
    #[test]
    fn a_huge_codex_transcript_is_cut_to_its_most_recent_messages() {
        let mut body = String::new();
        for i in 0..(READ_MAX_EVENTS + 25) {
            body.push_str(&format!(
                r#"{{"type":"event_msg","payload":{{"type":"user_message","message":"line {i}"}}}}"#
            ));
            body.push('\n');
        }
        let out = codex_events(&body);
        assert_eq!(out.len(), READ_MAX_EVENTS);
        assert_eq!(
            out.last().unwrap()["message"]["content"][0]["text"],
            format!("line {}", READ_MAX_EVENTS + 24)
        );
    }
}

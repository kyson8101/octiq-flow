//! What was said, kept where it cannot be lost.
//!
//! A chat's agent runs here, on this machine, and keeps running whether or not
//! anyone is watching — that is what makes parallel chats work. But the record
//! of what it said lived only in whichever browser happened to be attached, and
//! events go out over a broadcast channel with no replay. So:
//!
//!   * close the laptop mid-answer and the rest of that answer is simply gone,
//!     even though the agent finished it perfectly well;
//!   * a chat started on the phone does not exist on the laptop at all.
//!
//! Both are the same mistake — the record was in the wrong place. Every event
//! is now appended here first, with a sequence number, and the browser says
//! where it got to. Reconnecting asks for everything after that.
//!
//! ## Why a file per chat, and JSONL
//!
//! Append-only is the whole access pattern: events only ever arrive at the end,
//! and a reader only ever wants "everything after N". A line-per-event file
//! does that with no index, survives a crash mid-write (a torn last line is
//! dropped on read), and can be read with `tail` when something looks wrong.
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

/// One recorded event: its position, and what it was.
#[derive(Debug, Clone, Serialize)]
pub struct Recorded {
    /// 1-based position in this chat. A client that has seen 7 asks for 7.
    pub seq: u64,
    pub event: Value,
}

/// The folder chat records live in.
///
/// Overridable so tests write into a temporary directory. Without it they run
/// against the real profile — and `reconcile` DELETES files there, which is
/// not a thing a test should be able to do to someone's chats.
pub(crate) fn chats_dir() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = test_dir() {
        let _ = fs::create_dir_all(&dir);
        return Some(dir);
    }
    let dir = crate::profile::profile_dir().join("chats");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// A temporary directory, one per test binary, used instead of the profile.
#[cfg(test)]
fn test_dir() -> Option<PathBuf> {
    use std::sync::OnceLock;
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    Some(
        DIR.get_or_init(|| crate::test_dir::TestDir::new("test-chats").remove_at_exit())
            .clone(),
    )
}

/// Where a chat's record lives. `None` when the key is not a safe file name —
/// keys come from a browser, so a key with a slash in it must never become a
/// path somewhere else.
pub(crate) fn path_for(key: &str) -> Option<PathBuf> {
    let safe = !key.is_empty()
        && key.len() <= 128
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':');
    if !safe {
        return None;
    }
    // ':' is legal on macOS but reads badly in a shell, and is the one
    // character our keys use that is not already file-safe everywhere.
    Some(chats_dir()?.join(format!("{}.jsonl", key.replace(':', "_"))))
}

/// The next sequence number for each chat, so appending does not have to count.
///
/// Counting the file on every append looks harmless and is quadratic: a
/// streaming reply emits an event per delta, so a long answer would re-read
/// thousands of lines thousands of times. The file is read once, on the first
/// append after startup, and counted in memory after that.
static NEXT_SEQ: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

/// Record an event and return its sequence number.
///
/// Best-effort: if this cannot write, the event still reaches anyone currently
/// attached. Losing the ability to catch up later is bad; losing the live
/// stream because the disk is full would be worse.
pub fn append(key: &str, event: &Value) -> Option<u64> {
    write(key, event, false)
}

/// `append` for a line another record will call delivered: it answers only
/// once the line is synced to the disk itself, not merely handed to the OS,
/// so a crash cannot take back a line that was confirmed.
pub fn append_synced(key: &str, event: &Value) -> Option<u64> {
    write(key, event, true)
}

fn write(key: &str, event: &Value, synced: bool) -> Option<u64> {
    let path = path_for(key)?;
    let line = serde_json::to_string(event).ok()?;

    let mut guard = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    let counts = guard.get_or_insert_with(HashMap::new);
    let seq = match counts.get(key) {
        Some(next) => *next,
        // First write this run: find out where the file already ends.
        None => count(&path) + 1,
    };

    let existed = path.exists();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .read(synced)
        .open(&path)
        .ok()?;
    if synced && !ends_in_newline(&mut file) {
        // A crash mid-line left half a line (counted above as a line). This
        // one must not be glued onto it and lost with it.
        file.write_all(b"\n").ok()?;
    }
    // Only claim the number once the line is actually on disk, so a failed
    // write cannot leave a gap that `since` would read straight past.
    writeln!(file, "{line}").ok()?;
    counts.insert(key.to_string(), seq + 1);
    if synced {
        file.sync_data().ok()?;
        if !existed {
            // A new file is only durable once its folder entry is. A folder
            // that cannot be synced leaves the line on disk but unproven:
            // `None`, so no ledger confirms it (the next look finds it there).
            sync_dir(path.parent()?).ok()?;
        }
    }
    Some(seq)
}

/// Start a chat's record with `events`, but only a record that has nothing in
/// it yet. True when they were written; false when the chat already has a
/// record, which is never written over or added to here.
///
/// This is how a session picked out of an agent's own history becomes part of
/// the chat that picked it up. Until something was said in it, that chat had
/// no record at all: its history lived only in the page that read it, so
/// opening it anywhere else, or after that page's copy was gone, showed a
/// blank conversation. Held under the append lock, so a turn starting in the
/// same moment either lands after the whole history or makes this refuse.
pub fn seed(key: &str, events: &[Value]) -> Result<bool, String> {
    let path = path_for(key).ok_or_else(|| format!("not a usable chat key: {key:?}"))?;
    let mut text = String::new();
    for event in events {
        text.push_str(&serde_json::to_string(event).map_err(|e| e.to_string())?);
        text.push('\n');
    }

    let mut guard = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    let counts = guard.get_or_insert_with(HashMap::new);
    let next = match counts.get(key) {
        Some(next) => *next,
        None => count(&path) + 1,
    };
    if next != 1 {
        return Ok(false);
    }
    if events.is_empty() {
        return Ok(true);
    }
    let existed = path.exists();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("cannot write the chat record: {e}"))?;
    file.write_all(text.as_bytes())
        .and_then(|_| file.sync_data())
        .map_err(|e| format!("cannot write the chat record: {e}"))?;
    counts.insert(key.to_string(), events.len() as u64 + 1);
    if !existed {
        if let Some(dir) = path.parent() {
            let _ = sync_dir(dir);
        }
    }
    Ok(true)
}

/// Make a folder's entries (a file just created or renamed into it) durable.
pub(crate) fn sync_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if FAIL_DIR_SYNC.with(|fail| fail.get()) {
        return Err(std::io::Error::other("folder sync refused (test)"));
    }
    sync_dir_on(dir, cfg!(windows))
}

/// `sync_dir`, with the platform a parameter so both branches run in tests.
///
/// Windows has no folder sync the standard library can reach: opening a
/// folder as a file is refused (it needs FILE_FLAG_BACKUP_SEMANTICS), so
/// asking would fail every time and every line in a new file would stay
/// unconfirmed. NTFS journals the entry itself, so there is nothing to ask.
fn sync_dir_on(dir: &Path, is_windows: bool) -> std::io::Result<()> {
    if is_windows {
        return Ok(());
    }
    File::open(dir)?.sync_all()
}

/// Forget the count kept for `key`, as a restarted process has none.
#[cfg(test)]
pub(crate) fn forget_count(key: &str) {
    let mut guard = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(counts) = guard.as_mut() {
        counts.remove(key);
    }
}

#[cfg(test)]
thread_local! {
    /// Refuse every folder sync on this thread, as a failing disk would.
    pub(crate) static FAIL_DIR_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether the file is empty or its last byte ends a line.
fn ends_in_newline(file: &mut File) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let mut last = [0u8; 1];
    match file.seek(SeekFrom::End(-1)) {
        Ok(_) => file
            .read_exact(&mut last)
            .map_or(true, |_| last[0] == b'\n'),
        // Nothing to seek back over: an empty file.
        Err(_) => true,
    }
}

/// How many events are already recorded. Read once per chat per run.
fn count(path: &PathBuf) -> u64 {
    let Ok(file) = File::open(path) else {
        return 0;
    };
    BufReader::new(file).lines().map_while(Result::ok).count() as u64
}

/// Everything after `after`. `after = 0` is the whole conversation.
///
/// A line that will not parse is skipped rather than ending the read: the last
/// line of a file written by a process that died mid-write can be half a JSON
/// object, and one torn line must not hide every event before it.
pub fn since(key: &str, after: u64) -> Vec<Recorded> {
    let Some(path) = path_for(key) else {
        return Vec::new();
    };
    let Ok(file) = File::open(&path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (index, line) in BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .enumerate()
    {
        let seq = index as u64 + 1;
        if seq <= after {
            continue;
        }
        if let Ok(event) = serde_json::from_str::<Value>(&line) {
            out.push(Recorded { seq, event });
        }
    }
    out
}

/// A recent, contiguous window. The exclusive cursor is an event sequence,
/// so appends do not move older pages underneath a reader.
#[derive(Debug, Serialize)]
pub struct Page {
    pub events: Vec<Recorded>,
    pub context: Vec<Recorded>,
    pub before: Option<u64>,
}

/// Start pages at an idle host's next prompt, never halfway through a streamed
/// message or at a queued prompt inside the reply it is waiting behind.
fn page_prompt(event: &Value) -> bool {
    if event["type"] != "user" || event.get("octiq_append_to").is_some() {
        return false;
    }
    let content = &event["message"]["content"];
    content.is_string()
        || content.as_array().is_some_and(|blocks| {
            blocks
                .iter()
                .any(|b| b["type"] == "text" || b["type"] == "image")
                && !blocks.iter().any(|b| b["type"] == "tool_result")
        })
}

/// Keep a few recent complete turns, targeting 256 KiB. One indivisible turn
/// may exceed that budget. Older bytes stay on disk until explicitly requested.
pub fn page(key: &str, before: Option<u64>) -> Result<Page, String> {
    page_with_budget(key, before, 256 * 1024, 3)
}

/// Where each line of a record starts, found without reading what it says.
///
/// A line's position is its `seq`, so a page read from the end still has to
/// know how many lines come before it. Finding the newlines is a memchr over
/// the bytes; parsing every line as JSON to the same end is what made opening
/// a 100 MB chat take seconds.
struct LineIndex {
    /// Byte offset of each line; `starts[i]` is the line with `seq = i + 1`.
    starts: Vec<u64>,
    /// Where the indexed bytes end.
    end: u64,
    /// Lines that might be page context, ascending: `thread.started`, then
    /// `system` `init`. A byte match only: each is parsed before it is used.
    /// Records are written compactly by `serde_json`, and inside a string the
    /// quotes would be escaped, so these spellings are the events themselves.
    context: [Vec<u64>; 2],
}

const CONTEXT_NEEDLES: [&[u8]; 2] = [br#""type":"thread.started""#, br#""subtype":"init""#];

impl LineIndex {
    /// Index at most `limit` lines of `file`.
    fn scan(file: &File, limit: u64) -> std::io::Result<Self> {
        let needles = CONTEXT_NEEDLES.map(memchr::memmem::Finder::new);
        let mut reader = BufReader::with_capacity(1 << 20, file);
        let mut index = LineIndex {
            starts: Vec::new(),
            end: 0,
            context: [Vec::new(), Vec::new()],
        };
        let mut line = Vec::new();
        while (index.starts.len() as u64) < limit {
            line.clear();
            let read = reader.read_until(b'\n', &mut line)?;
            if read == 0 {
                break;
            }
            index.starts.push(index.end);
            for (needle, seqs) in needles.iter().zip(&mut index.context) {
                if needle.find(&line).is_some() {
                    seqs.push(index.starts.len() as u64);
                }
            }
            index.end += read as u64;
        }
        Ok(index)
    }

    /// Line `seq`, parsed, with its length as `lines()` would have counted it.
    /// `None` for a line that is not a JSON value (a torn last line).
    fn read(&self, file: &File, seq: u64) -> std::io::Result<Option<(Value, usize)>> {
        use std::io::{Read, Seek, SeekFrom};
        let at = (seq - 1) as usize;
        let start = self.starts[at];
        let end = self.starts.get(at + 1).copied().unwrap_or(self.end);
        let mut bytes = vec![0; (end - start) as usize];
        let mut file = file;
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut bytes)?;
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
        }
        Ok(serde_json::from_slice(&bytes)
            .ok()
            .map(|event| (event, bytes.len())))
    }
}

/// Whether an event is the host's own, rather than a subagent's or a seat's.
fn host_event(event: &Value) -> bool {
    event["parent_tool_use_id"].is_null() && event["octiq_speaker"].is_null()
}

/// What a host event does to "is a reply in progress": `Some(true)` starts
/// one, `Some(false)` ends it.
fn host_busy(event: &Value) -> Option<bool> {
    match event["type"].as_str().unwrap_or_default() {
        "assistant" | "turn.started" => Some(true),
        "stream_event" if event["event"]["type"] == "message_start" => Some(true),
        "result" | "turn.completed" | "turn.failed" => Some(false),
        _ => None,
    }
}

/// The page being gathered from the end: `seen[..to]`, newest first, holding
/// `turns` whole turns of `bytes` bytes.
struct Window {
    turns: usize,
    to: usize,
    bytes: usize,
    max_turns: usize,
    budget: usize,
}

impl Window {
    /// Add the turn reaching back to `seen[start]` if it fits; the newest turn
    /// always does. False once nothing older can be added.
    fn take(&mut self, start: usize, sums: &[usize]) -> bool {
        if start < self.to {
            return true; // an empty turn
        }
        let bytes = sums[start + 1] - sums[self.to];
        if self.turns > 0 && (self.turns + 1 > self.max_turns || self.bytes + bytes > self.budget) {
            return false;
        }
        self.turns += 1;
        self.bytes += bytes;
        self.to = start + 1;
        self.turns != self.max_turns
    }
}

/// The page `page_forward` reads, found from the END of the record.
///
/// Turns are split at an idle host's prompt; the page is the longest run of
/// whole turns from the end that fits `turns` and `budget`, and at least the
/// last turn however large. Walking backwards, a prompt is a split only once
/// the event before it says the host was idle — so a prompt waits in
/// `pending` until the nearest earlier `result` (a split) or reply start (not
/// one) is reached. Everything older than the page is never parsed, apart
/// from the newest context event of each kind.
fn page_with_budget(
    key: &str,
    before: Option<u64>,
    budget: usize,
    turns: usize,
) -> Result<Page, String> {
    let path = path_for(key).ok_or("invalid chat key")?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Page {
                events: vec![],
                context: vec![],
                before: None,
            });
        }
        Err(e) => return Err(e.to_string()),
    };
    let limit = before.map_or(u64::MAX, |cursor| cursor.saturating_sub(1));
    let index = LineIndex::scan(&file, limit).map_err(|e| e.to_string())?;
    let read = |seq| index.read(&file, seq).map_err(|e| e.to_string());

    // Newest first; `sums[i]` is the byte total of `seen[..i]`.
    let mut seen: Vec<Recorded> = Vec::new();
    let mut sums: Vec<usize> = vec![0];
    let mut pending: Vec<usize> = Vec::new();
    let mut page = Window {
        turns: 0,
        to: 0,
        bytes: 0,
        max_turns: turns,
        budget,
    };

    let mut open = true;
    for seq in (1..=index.starts.len() as u64).rev() {
        let Some((event, bytes)) = read(seq)? else {
            continue;
        };
        let at = seen.len();
        let host = host_event(&event);
        let prompt = host && page_prompt(&event);
        let busy = if host { host_busy(&event) } else { None };
        sums.push(sums[at] + bytes);
        seen.push(Recorded { seq, event });
        if prompt {
            pending.push(at);
        }
        match busy {
            // The host was idle before these prompts: each starts a turn.
            Some(false) => {
                for start in std::mem::take(&mut pending) {
                    open = page.take(start, &sums);
                    if !open {
                        break;
                    }
                }
            }
            // Queued behind a reply: they belong to the turn before them.
            Some(true) => pending.clear(),
            None => {}
        }
        if !open {
            break;
        }
        // The next turn is at least everything back to its newest possible
        // start; once that cannot fit, nothing older can.
        if page.turns > 0 {
            let reach = pending.first().copied().unwrap_or(at);
            if page.bytes + sums[reach + 1] - sums[page.to] > budget {
                open = false;
                break;
            }
        }
    }
    if open && !seen.is_empty() {
        // The start of the record: nothing was replying before its first event.
        for start in std::mem::take(&mut pending)
            .into_iter()
            .chain([seen.len() - 1])
        {
            if !page.take(start, &sums) {
                break;
            }
        }
    }
    seen.truncate(page.to);
    seen.reverse();
    let events = seen;

    // The newest of each kind of context event older than the page.
    let first = events.first().map_or(0, |record| record.seq);
    let mut context: Vec<Recorded> = Vec::new();
    for (kind, seqs) in index.context.iter().enumerate() {
        for &seq in seqs.iter().rev().filter(|&&seq| seq < first) {
            let Some((event, _)) = read(seq)? else {
                continue;
            };
            let wanted = match kind {
                0 => event["type"] == "thread.started",
                _ => event["type"] == "system" && event["subtype"] == "init",
            };
            if wanted && host_event(&event) {
                context.push(Recorded { seq, event });
                break;
            }
        }
    }
    context.sort_by_key(|record| record.seq);
    let before = events
        .first()
        .and_then(|record| (record.seq > 1).then_some(record.seq));
    Ok(Page {
        events,
        context,
        before,
    })
}

/// The page read the simple way, front to back with every line parsed: the
/// definition `page_with_budget` is checked against.
#[cfg(test)]
fn page_forward(
    key: &str,
    before: Option<u64>,
    budget: usize,
    turns: usize,
) -> Result<Page, String> {
    let path = path_for(key).ok_or("invalid chat key")?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Page {
                events: vec![],
                context: vec![],
                before: None,
            });
        }
        Err(e) => return Err(e.to_string()),
    };
    use std::collections::VecDeque;
    let mut chunks: VecDeque<(Vec<Recorded>, usize)> = VecDeque::from([(vec![], 0)]);
    let mut bytes = 0;
    let mut busy = false;
    let mut context: HashMap<String, Recorded> = HashMap::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let seq = index as u64 + 1;
        if before.is_some_and(|cursor| seq >= cursor) {
            break;
        }
        let line = line.map_err(|e| e.to_string())?;
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let host = event["parent_tool_use_id"].is_null() && event["octiq_speaker"].is_null();
        if host && !busy && page_prompt(&event) && !chunks.back().unwrap().0.is_empty() {
            chunks.push_back((vec![], 0));
        }
        if host {
            match event["type"].as_str().unwrap_or_default() {
                "assistant" | "turn.started" => busy = true,
                "stream_event" if event["event"]["type"] == "message_start" => busy = true,
                "result" | "turn.completed" | "turn.failed" => busy = false,
                _ => {}
            }
        }
        bytes += line.len();
        let chunk = chunks.back_mut().unwrap();
        chunk.1 += line.len();
        chunk.0.push(Recorded { seq, event });
        while chunks.len() > 1 && (bytes > budget || chunks.len() > turns) {
            let (dropped, size) = chunks.pop_front().unwrap();
            bytes -= size;
            for record in dropped {
                let event = &record.event;
                if !event["parent_tool_use_id"].is_null() || !event["octiq_speaker"].is_null() {
                    continue;
                }
                let kind = event["type"].as_str().unwrap_or_default();
                if kind == "thread.started" || (kind == "system" && event["subtype"] == "init") {
                    context.insert(kind.to_string(), record);
                }
            }
        }
    }
    let events: Vec<Recorded> = chunks.into_iter().flat_map(|(events, _)| events).collect();
    let mut context: Vec<Recorded> = context.into_values().collect();
    context.sort_by_key(|record| record.seq);
    let before = events
        .first()
        .and_then(|record| (record.seq > 1).then_some(record.seq));
    Ok(Page {
        events,
        context,
        before,
    })
}

/// Forget a chat's record. Called when its conversation is deleted — the point
/// of deleting a chat is that it is gone.
pub fn forget(key: &str) {
    if let Some(path) = path_for(key) {
        let _ = fs::remove_file(path);
    }
    // Drop the counter too, or a chat started again under the same key would
    // number its first event as though the deleted one were still there.
    let mut guard = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(counts) = guard.as_mut() {
        counts.remove(key);
    }
}

/// Rewrite a record line by line. `edit` returns a replacement for a line, or
/// `None` to keep it as it is. Every line stays one line in its place, because
/// a line's position is its `seq`; a line that is not UTF-8, or a replacement
/// that would split into two lines, is kept byte for byte.
///
/// Holds the append lock throughout, so a chat writing meanwhile waits rather
/// than landing a line in the file being replaced. True when anything changed.
pub(crate) fn rewrite_lines(
    path: &Path,
    mut edit: impl FnMut(&str) -> Option<String>,
) -> std::io::Result<bool> {
    rewrite_numbered(path, |_, line| {
        std::str::from_utf8(line).ok().and_then(&mut edit)
    })
}

/// `rewrite_lines`, handing `edit` each line's `seq` and its bytes as they
/// are, so a change worked out earlier without the lock can be applied by
/// position.
pub(crate) fn rewrite_numbered(
    path: &Path,
    mut edit: impl FnMut(u64, &[u8]) -> Option<String>,
) -> std::io::Result<bool> {
    let _appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    let temp = path.with_extension("jsonl.rewrite");
    let written = (|| {
        let mut reader = BufReader::new(File::open(path)?);
        let mut out = BufWriter::new(File::create(&temp)?);
        let mut changed = false;
        let mut line = Vec::new();
        let mut seq = 0;
        while reader.read_until(b'\n', &mut line)? > 0 {
            seq += 1;
            let ended = line.last() == Some(&b'\n');
            let body = &line[..line.len() - usize::from(ended)];
            match edit(seq, body) {
                Some(text) if !text.contains('\n') => {
                    out.write_all(text.as_bytes())?;
                    if ended {
                        out.write_all(b"\n")?;
                    }
                    changed = true;
                }
                _ => out.write_all(&line)?,
            }
            line.clear();
        }
        out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
        Ok(changed)
    })();
    match written {
        Ok(true) => fs::rename(&temp, path).map(|_| true),
        other => {
            let _ = fs::remove_file(&temp);
            other
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A key nobody else's test will use, so these can run in parallel against
    /// one real profile directory.
    fn unique_key(name: &str) -> String {
        format!("test-{name}-{}", uuid::Uuid::new_v4().simple())
    }

    #[test]
    fn pages_walk_backwards_without_gaps_or_duplicates() {
        let key = unique_key("pages");
        append(
            &key,
            &json!({"type":"system", "subtype":"init", "session_id":"session"}),
        );
        for n in 0..12 {
            append(
                &key,
                &json!({"type":"user", "message":{"content":format!("prompt {n}")}}),
            );
            append(
                &key,
                &json!({"type":"assistant", "message":{"id":format!("m{n}"), "content":[]}}),
            );
            append(&key, &json!({"type":"result"}));
        }
        let latest = page_with_budget(&key, None, usize::MAX, 3).unwrap();
        assert_eq!(latest.events.len(), 9);
        assert_eq!(latest.context[0].event["session_id"], "session");
        let mut sequences: Vec<u64> = latest.events.iter().map(|e| e.seq).collect();
        let mut cursor = latest.before;
        // A new event cannot shift an already-issued exclusive cursor.
        append(
            &key,
            &json!({"type":"user", "message":{"content":"new prompt"}}),
        );
        while let Some(before) = cursor {
            let older = page_with_budget(&key, Some(before), usize::MAX, 3).unwrap();
            assert!(older.before.is_none_or(|next| next < before));
            sequences.extend(older.events.iter().map(|e| e.seq));
            cursor = older.before;
        }
        sequences.sort_unstable();
        assert_eq!(sequences, (1..=37).collect::<Vec<_>>());
        forget(&key);
    }

    /// Reading from the end finds exactly the page reading every line from the
    /// front does, over records shaped like real ones: queued prompts inside a
    /// reply, subagent and seat events, torn lines, context of both kinds.
    #[test]
    fn a_page_read_from_the_end_is_the_page_read_from_the_front() {
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut roll = move |n: u64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state % n
        };
        for round in 0..300 {
            let key = unique_key("page-equivalence");
            let path = path_for(&key).unwrap();
            let mut text = String::new();
            for _ in 0..roll(60) {
                let event = match roll(16) {
                    0 => {
                        json!({"type":"system","subtype":"init","session_id":format!("s{}", roll(9))})
                    }
                    1 => json!({"type":"thread.started","thread_id":format!("t{}", roll(9))}),
                    2 | 3 => {
                        json!({"type":"user","message":{"content":"x".repeat(roll(40) as usize)}})
                    }
                    4 => {
                        json!({"type":"user","message":{"content":[{"type":"tool_result","content":"r"}]}})
                    }
                    5 => json!({"type":"user","octiq_append_to":"u","message":{"content":"more"}}),
                    6 => json!({"type":"assistant","message":{"content":[]}}),
                    7 => json!({"type":"stream_event","event":{"type":"message_start"}}),
                    8 => {
                        json!({"type":"stream_event","event":{"type":"content_block_delta","text":"y".repeat(roll(30) as usize)}})
                    }
                    9 | 10 => json!({"type":"result"}),
                    11 => json!({"type":"turn.started"}),
                    12 => json!({"type":"turn.completed"}),
                    13 => json!({"type":"result","parent_tool_use_id":"p"}),
                    14 => {
                        json!({"type":"user","octiq_speaker":{"id":"a"},"message":{"content":"seat"}})
                    }
                    _ => {
                        text.push_str("{\"torn\": \n");
                        continue;
                    }
                };
                text.push_str(&event.to_string());
                text.push('\n');
            }
            if roll(4) == 0 {
                text.push_str("{\"half");
            }
            fs::write(&path, &text).unwrap();
            let lines = text.lines().count() as u64;
            for _ in 0..6 {
                let budget = [1, 40, 120, 400, usize::MAX][roll(5) as usize];
                let turns = roll(5) as usize;
                let before = (roll(3) > 0).then(|| roll(lines + 2) + 1);
                let found = page_with_budget(&key, before, budget, turns).unwrap();
                let expected = page_forward(&key, before, budget, turns).unwrap();
                let shape = |page: &Page| {
                    (
                        page.events
                            .iter()
                            .map(|e| (e.seq, e.event.clone()))
                            .collect::<Vec<_>>(),
                        page.context
                            .iter()
                            .map(|e| (e.seq, e.event.clone()))
                            .collect::<Vec<_>>(),
                        page.before,
                    )
                };
                assert_eq!(
                    shape(&found),
                    shape(&expected),
                    "round {round}, before {before:?}, budget {budget}, turns {turns}:\n{text}"
                );
            }
            forget(&key);
        }
    }

    /// The same check over real records, with timings:
    /// `OCTIQ_PAGE_CHECK=<a.jsonl>:<b.jsonl> cargo test --release -- --ignored real_records`
    #[test]
    #[ignore]
    fn real_records_page_the_same_from_either_end() {
        let Ok(files) = std::env::var("OCTIQ_PAGE_CHECK") else {
            return;
        };
        for file in files.split(':') {
            let key = unique_key("page-real");
            fs::copy(file, path_for(&key).unwrap()).unwrap();
            let mut cursor = None;
            for _ in 0..3 {
                let started = std::time::Instant::now();
                let found = page(&key, cursor).unwrap();
                let fast = started.elapsed();
                let started = std::time::Instant::now();
                let expected = page_forward(&key, cursor, 256 * 1024, 3).unwrap();
                let slow = started.elapsed();
                eprintln!("{file} before {cursor:?}: {fast:?} from the end, {slow:?} from the front, {} events", found.events.len());
                let seqs = |p: &Page| {
                    p.events
                        .iter()
                        .chain(&p.context)
                        .map(|e| e.seq)
                        .collect::<Vec<_>>()
                };
                assert_eq!(seqs(&found), seqs(&expected));
                assert_eq!(found.before, expected.before);
                cursor = found.before;
                if cursor.is_none() {
                    break;
                }
            }
            forget(&key);
        }
    }

    #[test]
    fn byte_budget_keeps_a_stream_and_its_queued_prompt_together() {
        let key = unique_key("page-stream");
        append(&key, &json!({"type":"user", "message":{"content":"old"}}));
        append(&key, &json!({"type":"result"}));
        append(
            &key,
            &json!({"type":"user", "message":{"content":"current"}}),
        );
        append(
            &key,
            &json!({"type":"stream_event", "event":{"type":"message_start"}}),
        );
        append(
            &key,
            &json!({"type":"user", "octiq_user_turn":true, "message":{"content":"queued"}}),
        );
        append(
            &key,
            &json!({"type":"stream_event", "event":{"type":"content_block_delta", "text":"x".repeat(1000)}}),
        );
        let page = page_with_budget(&key, None, 100, 3).unwrap();
        assert_eq!(page.before, Some(3));
        assert_eq!(
            page.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![3, 4, 5, 6]
        );
        forget(&key);
    }

    #[test]
    fn appended_queue_envelopes_stay_on_their_combined_turn_page() {
        let key = unique_key("page-appended-queue");
        append(&key, &json!({"type":"user", "message":{"content":"old"}}));
        append(&key, &json!({"type":"result"}));
        append(
            &key,
            &json!({"type":"user", "uuid":"user-1", "octiq_user_turn":true, "message":{"content":"first"}}),
        );
        for id in ["user-2", "user-3", "user-4"] {
            append(
                &key,
                &json!({"type":"user", "uuid":id, "octiq_user_turn":true, "octiq_append_to":"user-1", "message":{"content":id}}),
            );
            append(
                &key,
                &json!({"type":"octiq_user_turn_appended", "uuid":"user-1", "appended_uuid":id}),
            );
        }
        let page = page_with_budget(&key, None, 1, 1).unwrap();
        assert_eq!(page.before, Some(3));
        assert_eq!(
            page.events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            (3..=9).collect::<Vec<_>>()
        );
        forget(&key);
    }

    #[test]
    fn events_come_back_in_order_from_where_you_left_off() {
        let key = unique_key("order");
        for i in 1..=5 {
            append(&key, &json!({ "n": i }));
        }

        // A client that saw three asks for three, and gets exactly the rest.
        let rest = since(&key, 3);
        assert_eq!(rest.len(), 2);
        assert_eq!(rest[0].seq, 4);
        assert_eq!(rest[0].event["n"], 4);
        assert_eq!(rest[1].seq, 5);

        // From nothing means the whole conversation.
        assert_eq!(since(&key, 0).len(), 5);
        // Already up to date.
        assert!(since(&key, 5).is_empty());
        // Ahead of us — a stale client, or a record that was deleted and
        // restarted. Answering with nothing beats answering with the wrong
        // events.
        assert!(since(&key, 99).is_empty());

        forget(&key);
    }

    #[test]
    fn a_torn_last_line_does_not_hide_the_events_before_it() {
        let key = unique_key("torn");
        append(&key, &json!({ "n": 1 }));
        append(&key, &json!({ "n": 2 }));

        // Simulate a process killed mid-write.
        let path = path_for(&key).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{{\"n\": 3, \"hal").unwrap();
        drop(file);

        let all = since(&key, 0);
        assert_eq!(all.len(), 2, "the two whole events must survive");
        assert_eq!(all[1].event["n"], 2);

        forget(&key);
    }

    #[test]
    fn a_synced_line_after_a_torn_one_is_whole_and_numbered_where_it_sits() {
        let key = unique_key("torn-synced");
        append(&key, &json!({ "n": 1 }));
        let path = path_for(&key).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{{\"n\": 2, \"hal").unwrap();
        drop(file);
        // The process died there; the next one counts the file afresh.
        NEXT_SEQ.lock().unwrap().as_mut().unwrap().remove(&key);

        let seq = append_synced(&key, &json!({ "n": 3 })).unwrap();
        let all = since(&key, 0);
        assert_eq!(all.len(), 2, "the torn line is skipped, the new one is not");
        assert_eq!(all[1].event["n"], 3);
        assert_eq!(all[1].seq, seq);
        assert_eq!(append_synced(&key, &json!({ "n": 4 })), Some(seq + 1));
        forget(&key);
    }

    #[test]
    fn a_new_file_whose_folder_cannot_be_synced_is_written_but_not_confirmed() {
        let key = unique_key("dir-sync");
        FAIL_DIR_SYNC.with(|f| f.set(true));
        let first = append_synced(&key, &json!({ "n": 1 }));
        // An existing file needs no folder sync, so the next one is confirmed.
        let second = append_synced(&key, &json!({ "n": 2 }));
        FAIL_DIR_SYNC.with(|f| f.set(false));
        assert_eq!(first, None, "unproven, so not confirmed");
        assert_eq!(second, Some(2));
        let all = since(&key, 0);
        assert_eq!(all.len(), 2, "the first line is on disk all the same");
        assert_eq!(all[0].seq, 1);
        forget(&key);
    }

    #[test]
    fn a_folder_sync_is_skipped_on_windows_and_asked_everywhere_else() {
        let missing = std::env::temp_dir().join(format!("octiq-no-dir-{}", uuid::Uuid::new_v4()));
        // Windows cannot open a folder to sync it; asking would fail forever.
        assert!(sync_dir_on(&missing, true).is_ok());
        // Elsewhere a folder that cannot be synced is an error, not a shrug.
        assert!(sync_dir_on(&missing, false).is_err());
        let folder = std::env::temp_dir();
        if cfg!(windows) {
            // The reason for the skip: Windows refuses to open a folder as a
            // file, so asking would fail even for one that exists.
            assert!(sync_dir_on(&folder, false).is_err());
        } else {
            assert!(sync_dir_on(&folder, false).is_ok());
        }
        // What this platform really does with an existing folder succeeds.
        assert!(sync_dir(&folder).is_ok());
    }

    #[test]
    fn appending_stays_correct_across_many_events() {
        // The counter is in memory; this is the case that would expose it
        // drifting from what is actually on disk.
        let key = unique_key("many");
        let mut last = 0;
        for i in 1..=200 {
            last = append(&key, &json!({ "n": i })).expect("append should record");
        }
        assert_eq!(last, 200, "the 200th event should be seq 200");
        assert_eq!(since(&key, 0).len(), 200);
        assert_eq!(since(&key, 199).len(), 1);
        forget(&key);
    }

    #[test]
    fn a_chat_reusing_a_forgotten_key_starts_from_one() {
        let key = unique_key("reused");
        append(&key, &json!({ "n": 1 }));
        append(&key, &json!({ "n": 2 }));
        forget(&key);

        // Without clearing the counter this would come back as 3, and a client
        // asking for "everything after 0" would be told there is nothing.
        assert_eq!(append(&key, &json!({ "n": 1 })), Some(1));
        forget(&key);
    }

    #[test]
    fn a_key_that_is_really_a_path_is_refused() {
        // Keys arrive from a browser. This one must not write into /etc.
        assert!(path_for("../../etc/passwd").is_none());
        assert!(path_for("chat:with/slash").is_none());
        assert!(path_for("").is_none());
        // The shape our own keys actually take.
        assert!(path_for("chat:7f3a-4b21").is_some());
    }

    #[test]
    fn forgetting_a_chat_leaves_nothing_to_read() {
        let key = unique_key("forget");
        append(&key, &json!({ "n": 1 }));
        assert_eq!(since(&key, 0).len(), 1);
        forget(&key);
        assert!(since(&key, 0).is_empty());
    }

    /// A resumed session's history becomes the start of the chat's record, so
    /// reopening the chat replays it like anything else said there, and the
    /// first turn afterwards is numbered after it.
    #[test]
    fn a_seeded_history_starts_the_record_and_turns_follow_it() {
        let key = unique_key("seeded");
        let history = [
            json!({"type":"user", "message":{"content":[{"type":"text","text":"earlier"}]}}),
            json!({"type":"assistant", "message":{"content":[{"type":"text","text":"reply"}]}}),
        ];
        assert_eq!(seed(&key, &history), Ok(true));
        let read = since(&key, 0);
        assert_eq!(read.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(read[0].event, history[0]);
        assert_eq!(append(&key, &json!({"type":"result"})), Some(3));

        // A restarted server counts the file rather than trusting memory.
        forget_count(&key);
        assert_eq!(append(&key, &json!({"type":"result"})), Some(4));
        forget(&key);
    }

    /// A chat something was already said in keeps its record exactly as it
    /// is: seeding never writes over a conversation, nor slips lines into it.
    #[test]
    fn a_chat_with_a_record_is_never_seeded() {
        let key = unique_key("seed-refused");
        append(&key, &json!({"type":"system", "subtype":"init"}));
        assert_eq!(seed(&key, &[json!({"type":"user"})]), Ok(false));
        assert_eq!(since(&key, 0).len(), 1);

        // Known only from the file, as after a restart.
        forget_count(&key);
        assert_eq!(seed(&key, &[json!({"type":"user"})]), Ok(false));
        assert_eq!(since(&key, 0).len(), 1);
        forget(&key);

        assert!(seed("chat:with/slash", &[]).is_err());
    }
}

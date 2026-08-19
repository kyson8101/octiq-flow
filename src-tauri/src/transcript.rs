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
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
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
        DIR.get_or_init(|| {
            std::env::temp_dir().join(format!("octiq-test-chats-{}", std::process::id()))
        })
        .clone(),
    )
}

/// Where a chat's record lives. `None` when the key is not a safe file name —
/// keys come from a browser, so a key with a slash in it must never become a
/// path somewhere else.
fn path_for(key: &str) -> Option<PathBuf> {
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
    let path = path_for(key)?;
    let line = serde_json::to_string(event).ok()?;

    let mut guard = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    let counts = guard.get_or_insert_with(HashMap::new);
    let seq = match counts.get(key) {
        Some(next) => *next,
        // First write this run: find out where the file already ends.
        None => count(&path) + 1,
    };

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    // Only claim the number once the line is actually on disk, so a failed
    // write cannot leave a gap that `since` would read straight past.
    writeln!(file, "{line}").ok()?;
    counts.insert(key.to_string(), seq + 1);
    Some(seq)
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
}

//! Which chats exist.
//!
//! `transcript.rs` keeps what was SAID in each chat. This keeps the far smaller
//! question of which chats there are at all — the list you see in the sidebar,
//! with enough beside each entry to open it: its project, its title, and the
//! agent session id that continues it.
//!
//! It lives here rather than in the browser for one reason: a chat started on a
//! phone did not exist on the laptop. The record of what was said moved to the
//! server first; without the index, no other device knew there was anything to
//! ask for.
//!
//! ## Why the messages are NOT here
//!
//! They would be the bulk of it, and they are already written down once, in the
//! chat's own JSONL. Keeping a second copy means keeping two things in step —
//! and it is exactly the copy that grows without limit. Opening a chat replays
//! its transcript instead, so this file stays small enough to rewrite whole on
//! every change.
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// One chat, as the sidebar needs it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    pub id: String,
    pub project_id: String,
    #[serde(default)]
    pub title: String,
    /// The agent's own session id, for resuming the conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// What it was held under, so reopening does not silently change either.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<String>,
    /// When it started. The sidebar orders by this and it never changes.
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    #[serde(default)]
    chats: Vec<ChatMeta>,
}

/// Serialises writes. Two devices can save at the same moment, and a
/// read-modify-write on a shared file is exactly where one silently wins.
static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Option<PathBuf> {
    // Shared with transcript.rs, and overridden together in tests — the two
    // records must always be looked for in the same place, or reconcile would
    // compare a test index against real transcripts.
    Some(crate::transcript::chats_dir()?.join("index.json"))
}

/// Why the index could not be read. The distinction matters exactly once, in
/// `reconcile`: "there is no file yet" is a first run and says nothing is
/// wrong, while "there is a file and it did not parse" means the list of chats
/// is temporarily unknown — and acting on an unknown list as though it were an
/// empty one deletes every transcript on the machine.
#[derive(Debug)]
struct Unreadable;

/// The index at a given path, or `Unreadable` when a file is there and did not
/// make sense. A missing file is not an error: it is an empty index, correctly.
///
/// Takes the path so the rule can be tested on a file of its own — the real one
/// is shared by every test in this module, and a test that wrote nonsense into
/// it would break the others.
fn read_path(path: &std::path::Path) -> Result<Index, Unreadable> {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|_| Unreadable),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Index::default()),
        Err(_) => Err(Unreadable),
    }
}

fn read_checked() -> Result<Index, Unreadable> {
    let Some(path) = path() else {
        return Err(Unreadable);
    };
    read_path(&path)
}

fn read() -> Index {
    read_checked().unwrap_or_default()
}

/// Move an index we could not parse out of the way, once, keeping whatever it
/// held for recovery.
///
/// Without this the next `upsert` would write a fresh list straight over it:
/// the unreadable file is treated as empty, so a single new chat would become
/// the only chat there had ever been. Renaming costs one stray file and makes
/// that unrecoverable case recoverable.
fn preserve_unreadable() {
    let Some(path) = path() else {
        return;
    };
    if !path.exists() {
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let kept = path.with_file_name(format!("index.unreadable-{stamp}.json"));
    if fs::rename(&path, &kept).is_ok() {
        eprintln!(
            "[chats] index.json could not be parsed; kept it as {} and started a new one",
            kept.display()
        );
    }
}

/// Write the whole file. Through a temporary file and a rename, so a process
/// that dies mid-write leaves the previous list intact rather than half of the
/// new one — losing the last change beats losing every chat.
fn write(index: &Index) -> Result<(), String> {
    let Some(path) = path() else {
        return Err("could not find the profile folder".into());
    };
    let body = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, body).map_err(|e| e.to_string())?;
    fs::rename(&temp, &path).map_err(|e| e.to_string())
}

/// Every chat, newest first — the order the sidebar shows them in.
pub fn list() -> Vec<ChatMeta> {
    let mut chats = read().chats;
    chats.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    chats
}

/// Add a chat or update the one with this id.
pub fn upsert(meta: ChatMeta) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = match read_checked() {
        Ok(index) => index,
        Err(_) => {
            preserve_unreadable();
            Index::default()
        }
    };
    match index.chats.iter_mut().find(|c| c.id == meta.id) {
        // `created_at` is the one field a later save must not move: the sidebar
        // orders by it, and a list that re-sorts while you type moves the row
        // you are reading.
        Some(existing) => {
            let created = existing.created_at;
            *existing = meta;
            existing.created_at = created;
        }
        None => index.chats.push(meta),
    }
    write(&index)
}

/// Forget a chat. Its transcript is removed separately — this is only the
/// entry in the list.
pub fn remove(id: &str) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // An index we cannot read is not a list to delete one entry from. Refuse,
    // rather than writing an "everything except this one" that is really an
    // empty file — the caller asked to forget one chat, not all of them.
    let mut index = read_checked().map_err(|_| "the chat index could not be read".to_string())?;
    index.chats.retain(|c| c.id != id);
    write(&index)
}

/// Bring the two records back into agreement, once, at startup.
///
/// There are two files behind every chat — its transcript and its entry in
/// this index — and they are written at different moments. A chat's transcript
/// starts filling the instant the agent speaks; its index entry is saved by
/// the client a moment later. Kill the server in between and the transcript is
/// left with nothing pointing at it.
///
/// An ORPHAN TRANSCRIPT is deleted. Nothing can reach it: the list is the only
/// way to open a chat, so a transcript with no entry is invisible and will
/// simply accumulate. This is safe at startup and only at startup — no chat is
/// running yet, so nothing can be mid-write.
///
/// An INDEX ENTRY WITH NO TRANSCRIPT is KEPT. It looks like the same problem
/// and is not: the entry still carries the agent's session id, so the
/// conversation can be picked up again even though this machine has no copy of
/// what was said. That is precisely the case for a chat this device has never
/// opened.
///
/// AN EMPTY LIST IS NEVER ACTED ON while transcripts exist. This is the one
/// input that turns the rule above into "delete everything", and the two
/// situations that produce it are not alike: a genuinely fresh machine has no
/// transcripts to delete either, so nothing is lost by refusing. An index that
/// is unreadable, or was written by a profile that has since been switched,
/// reads as empty in exactly the same way — and there the refusal is the whole
/// point. Whatever is unmatched stays on disk, which costs a little space and
/// keeps the conversations.
///
/// May `reconcile` act on what it found?
///
/// Split out from `reconcile` so the rule can be checked directly: the tests in
/// this module share one real index, and proving this by emptying it would
/// break every other test that has a chat in there.
fn may_delete_orphans(known: usize, transcripts: usize) -> bool {
    known > 0 || transcripts == 0
}

/// Returns how many transcripts were removed.
pub fn reconcile() -> usize {
    let Ok(index) = read_checked() else {
        eprintln!("[chats] index unreadable; leaving every transcript alone");
        return 0;
    };
    let known: std::collections::HashSet<String> = index.chats.into_iter().map(|c| c.id).collect();

    let Some(dir) = crate::transcript::chats_dir() else {
        return 0;
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return 0;
    };

    // Collect first, decide after. The empty-index check below needs to know
    // whether there are any transcripts at all, and that cannot be answered
    // halfway through deleting them.
    let mut orphans = Vec::new();
    let mut transcripts = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Only files this app writes for chats. Anything else in the folder is
        // none of our business.
        let Some(rest) = name.strip_prefix("chat_") else {
            continue;
        };
        let Some(id) = rest.strip_suffix(".jsonl") else {
            continue;
        };
        transcripts += 1;
        if known.contains(id) {
            continue;
        }
        orphans.push(entry.path());
    }

    // An index with nothing in it, next to transcripts that plainly exist, is
    // a disagreement too large to be the ordinary write-order race this
    // function was written for. Every chat on the machine would be an orphan,
    // and deleting them all on that reading has no upside: if the list really
    // is empty, so is the disk, and there was nothing to tidy.
    if !may_delete_orphans(known.len(), transcripts) {
        eprintln!(
            "[chats] index lists no chats but {transcripts} transcript(s) exist; \
             leaving them alone rather than treating the list as complete"
        );
        return 0;
    }

    let mut removed = 0;
    for path in orphans {
        if fs::remove_file(path).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        println!("[chats] removed {removed} transcript(s) no chat pointed at");
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, created: i64) -> ChatMeta {
        ChatMeta {
            id: id.into(),
            project_id: "p1".into(),
            title: format!("chat {id}"),
            session_id: None,
            model_id: None,
            access: None,
            created_at: created,
            updated_at: created,
        }
    }

    /// These share one real profile directory, so each test cleans up after
    /// itself and asserts only about its own ids.
    fn cleanup(ids: &[&str]) {
        for id in ids {
            let _ = remove(id);
        }
    }

    #[test]
    fn a_chat_can_be_added_found_and_removed() {
        let id = "test-index-basic";
        cleanup(&[id]);
        upsert(meta(id, 100)).unwrap();
        assert!(list().iter().any(|c| c.id == id));
        remove(id).unwrap();
        assert!(!list().iter().any(|c| c.id == id));
    }

    #[test]
    fn saving_again_never_moves_when_the_chat_started() {
        let id = "test-index-created";
        cleanup(&[id]);
        upsert(meta(id, 100)).unwrap();

        // A later save carries a fresh timestamp, as the client's would.
        let mut later = meta(id, 999);
        later.title = "renamed".into();
        upsert(later).unwrap();

        let found = list().into_iter().find(|c| c.id == id).unwrap();
        assert_eq!(found.title, "renamed", "the update should apply");
        assert_eq!(found.created_at, 100, "but not to when it started");
        cleanup(&[id]);
    }

    #[test]
    fn the_list_comes_back_newest_first() {
        let (old, new) = ("test-index-old", "test-index-new");
        cleanup(&[old, new]);
        upsert(meta(old, 1_000)).unwrap();
        upsert(meta(new, 2_000)).unwrap();

        let ours: Vec<String> = list()
            .into_iter()
            .filter(|c| c.id == old || c.id == new)
            .map(|c| c.id)
            .collect();
        assert_eq!(ours, vec![new.to_string(), old.to_string()]);
        cleanup(&[old, new]);
    }

    #[test]
    fn reconcile_removes_a_transcript_nothing_points_at_and_keeps_the_rest() {
        let kept = "test-reconcile-kept";
        let orphan = "test-reconcile-orphan";
        cleanup(&[kept, orphan]);

        // One chat with both halves, one transcript with no entry.
        upsert(meta(kept, 500)).unwrap();
        crate::transcript::append(&format!("chat:{kept}"), &serde_json::json!({ "n": 1 }));
        crate::transcript::append(&format!("chat:{orphan}"), &serde_json::json!({ "n": 1 }));

        assert!(!crate::transcript::since(&format!("chat:{orphan}"), 0).is_empty());
        reconcile();

        // The orphan is gone; the one still in the list is untouched.
        assert!(crate::transcript::since(&format!("chat:{orphan}"), 0).is_empty());
        assert!(!crate::transcript::since(&format!("chat:{kept}"), 0).is_empty());

        // An entry whose transcript is missing is NOT dropped: it still holds
        // the session id that continues the conversation.
        assert!(list().iter().any(|c| c.id == kept));

        crate::transcript::forget(&format!("chat:{kept}"));
        cleanup(&[kept]);
    }

    #[test]
    fn removing_a_chat_that_is_not_there_is_not_an_error() {
        // The client can delete on two devices; the second must not fail.
        assert!(remove("test-index-never-existed").is_ok());
    }

    /// A directory of this test's own, so writing a broken index here cannot
    /// disturb the shared one every other test in this module uses.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("octiq-test-index-{}-{name}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        dir.join("index.json")
    }

    #[test]
    fn a_missing_index_reads_as_empty_not_as_an_error() {
        // First run. There is nothing wrong, there is simply nothing yet.
        let path = scratch("missing");
        let _ = fs::remove_file(&path);
        let index = read_path(&path).expect("a missing file is an empty index");
        assert!(index.chats.is_empty());
    }

    #[test]
    fn an_index_that_does_not_parse_is_an_error_not_an_empty_list() {
        // The distinction the whole guard rests on: unreadable must never be
        // reported as "this machine has no chats".
        let path = scratch("corrupt");
        fs::write(&path, b"{ this is not json").unwrap();
        assert!(read_path(&path).is_err());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_half_written_index_is_an_error_too() {
        // What a process killed mid-write used to leave behind. It parses as
        // far as it goes and then stops, which serde rejects — as it should.
        let path = scratch("truncated");
        fs::write(&path, br#"{"chats":[{"id":"a","projec"#).unwrap();
        assert!(read_path(&path).is_err());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn reconcile_will_not_delete_every_transcript_when_the_index_reads_as_empty() {
        // The case that cost a conversation: an index that lists nothing, next
        // to transcripts that plainly exist. Every one of them looks like an
        // orphan, and deleting them all is the wrong answer.
        assert!(!may_delete_orphans(0, 3));
    }

    #[test]
    fn reconcile_still_tidies_when_the_index_has_something_in_it() {
        // The ordinary case must keep working: a real list, one stray file.
        assert!(may_delete_orphans(2, 3));
    }

    #[test]
    fn an_empty_index_with_no_transcripts_is_nothing_to_argue_about() {
        // A genuinely fresh machine. Allowed, and there is nothing to delete.
        assert!(may_delete_orphans(0, 0));
    }
}

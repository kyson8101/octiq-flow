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

fn read() -> Index {
    let Some(path) = path() else {
        return Index::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
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
    let mut index = read();
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
    let mut index = read();
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
/// Returns how many transcripts were removed.
pub fn reconcile() -> usize {
    let known: std::collections::HashSet<String> =
        list().into_iter().map(|c| c.id).collect();

    let Some(dir) = crate::transcript::chats_dir() else {
        return 0;
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return 0;
    };

    let mut removed = 0;
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
        if known.contains(id) {
            continue;
        }
        if fs::remove_file(entry.path()).is_ok() {
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
}

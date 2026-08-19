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
    let dir = crate::profile::profile_dir().join("chats");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("index.json"))
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
    fn removing_a_chat_that_is_not_there_is_not_an_error() {
        // The client can delete on two devices; the second must not fail.
        assert!(remove("test-index-never-existed").is_ok());
    }
}

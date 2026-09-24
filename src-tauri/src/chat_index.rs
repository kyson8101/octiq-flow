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

/// A deleted chat remains restorable for one day. The transcript is the
/// valuable half; keeping its small index row beside it makes restore a single
/// metadata change instead of a file move that can be interrupted halfway.
pub const DELETED_CHAT_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// One chat, as the sidebar needs it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    pub id: String,
    pub project_id: String,
    #[serde(default)]
    pub title: String,
    /// Short copy for the task list. The complete response stays in the
    /// transcript; this keeps list rendering independent of opening the chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_response: Option<String>,
    /// True when the user named the chat explicitly. This keeps a deliberately
    /// chosen `New chat` distinct from the inferred placeholder.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub custom_title: bool,
    /// Server-owned: an agent has replaced the inferred title. Ordinary
    /// browser saves must carry this title forward even before they hear it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub agent_title: bool,
    /// The agent's own session id, for resuming the conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The exact directory this chat runs in. It can be a linked worktree and
    /// therefore must not be reconstructed from the project's default path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// What it was held under, so reopening does not silently change either.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<String>,
    /// When it started. This never changes, even as recent activity reorders the list.
    #[serde(default)]
    pub created_at: i64,
    /// Latest meaningful activity: a user send or a completed agent turn.
    /// Streaming deltas deliberately keep the previous value.
    #[serde(default)]
    pub updated_at: i64,
    /// When a viewer last opened this chat, shared across every device — a chat
    /// read on the phone must not still show unread on the laptop. Absent means
    /// never opened since this field shipped; the client treats that the same
    /// as "as old as the chat itself" rather than forcing every pre-existing
    /// chat to read as unread the day this landed. Moved forward only, by
    /// `mark_read`; an ordinary save (rename, pin) carries whatever the caller
    /// already knows, same as every other field here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<i64>,
    /// Kept at the top of its project, above every newer chat. Left out of the
    /// file when false, so an index written before pins existed reads back
    /// exactly as it was written.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    /// When the person ticked this chat off by hand. Nothing infers it: the
    /// agent's own report and the git verification in `chat_task.rs` answer
    /// "did the work land", and neither answers "am I finished with this".
    ///
    /// A TIME rather than a flag, because the tick has to retire itself. A
    /// chat counts as done only while `done_at >= updated_at` (see
    /// `is_done`), so the next user send or completed turn un-ticks it
    /// without anything having to remember to — and without a second write
    /// racing the one that recorded the activity.
    ///
    /// Server-owned, like `read_at`: an ordinary save carries whatever the
    /// sending browser held when it was QUEUED, which can predate a tick made
    /// on another device a moment ago. Only `set_done` moves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_at: Option<i64>,
    /// Soft-deleted chats stay in the index, but not in the active list. The
    /// reaper removes this row and its transcript after `DELETED_CHAT_TTL_MS`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
    /// Incremented on restore. A browser includes the generation it deleted,
    /// so a delayed retry from before a restore cannot bury the chat again.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub generation: u64,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

impl ChatMeta {
    /// Ticked off, and nothing has happened since. The comparison IS the
    /// auto-clear: a chat marked done at noon and written to at one o'clock is
    /// not done any more, and no second write was needed to say so.
    pub fn is_done(&self) -> bool {
        self.done_at.is_some_and(|at| at >= self.updated_at)
    }
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

/// Every chat, pinned ones first and then most recently active — the order the
/// task-oriented sidebar shows them in.
pub fn list() -> Vec<ChatMeta> {
    let mut chats: Vec<_> = read()
        .chats
        .into_iter()
        .filter(|chat| chat.deleted_at.is_none())
        .collect();
    chats.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(b.updated_at.cmp(&a.updated_at))
    });
    chats
}

/// Add a chat or update the one with this id.
pub fn upsert(mut meta: ChatMeta) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = match read_checked() {
        Ok(index) => index,
        Err(_) => {
            preserve_unreadable();
            Index::default()
        }
    };
    match index.chats.iter_mut().find(|c| c.id == meta.id) {
        // `created_at` is historical identity, not activity. A later save may
        // move `updated_at`, but can never rewrite when the chat began.
        Some(existing) => {
            // A browser may still hold the first-message title when an agent
            // renames the chat. Only an explicit user rename can replace a
            // managed title; ordinary transcript/pin saves cannot rewind it.
            if !meta.custom_title && (existing.agent_title || existing.custom_title) {
                meta.title = existing.title.clone();
                meta.custom_title = existing.custom_title;
            }
            meta.agent_title = existing.agent_title && !meta.custom_title;
            let created = existing.created_at;
            let deleted_at = existing.deleted_at;
            let generation = existing.generation;
            // A save carries whatever `read_at` its sender's local copy held
            // at the moment it was QUEUED, which can predate a `mark_read`
            // that reaches the disk first — the two travel independently and
            // are not ordered against each other. Take the later of the two
            // rather than letting whichever lands last win outright, the same
            // rule `mark_read` itself applies.
            let read_at = match (existing.read_at, meta.read_at) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
            // Kept whole, never taken from the save. A browser that has not
            // heard about a tick made elsewhere would otherwise untick it with
            // the next rename, and a browser holding a stale tick would put it
            // back after the person cleared it. `set_done` is the only writer;
            // the activity this save carries retires the tick by itself,
            // through `is_done`.
            let done_at = existing.done_at;
            *existing = meta;
            existing.created_at = created;
            existing.done_at = done_at;
            // Only the lifecycle commands below may change these. In
            // particular, a save already in flight when Delete was pressed
            // must not resurrect the chat.
            existing.deleted_at = deleted_at;
            existing.generation = generation;
            existing.read_at = read_at;
        }
        None => {
            // A normal save cannot manufacture a deleted entry or choose its
            // lifecycle generation. Those are server-owned facts.
            meta.deleted_at = None;
            meta.generation = 0;
            meta.agent_title = false;
            meta.done_at = None;
            index.chats.push(meta);
        }
    }
    write(&index)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTitleUpdate {
    pub title: String,
    pub updated: bool,
    pub reason: &'static str,
}

/// Update only this chat's title under the same lock as browser saves. User
/// names take precedence, and metadata edits do not count as new activity.
pub fn set_agent_title(id: &str, title: &str) -> Result<ChatTitleUpdate, String> {
    if title.chars().any(|c| c.is_control() && !c.is_whitespace()) {
        return Err("Chat titles cannot contain control characters.".into());
    }
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() || title.chars().count() > 80 {
        return Err("Choose a chat title between 1 and 80 characters.".into());
    }
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = read_checked().map_err(|_| "The chat index could not be read.".to_string())?;
    let chat = index
        .chats
        .iter_mut()
        .find(|chat| chat.id == id && chat.deleted_at.is_none())
        .ok_or("This chat is not in the active chat index.")?;
    if chat.custom_title {
        return Ok(ChatTitleUpdate {
            title: chat.title.clone(),
            updated: false,
            reason: "The user chose this title; it has been kept.",
        });
    }
    let updated = chat.title != title || !chat.agent_title;
    chat.title = title.clone();
    chat.agent_title = true;
    if updated {
        write(&index)?;
    }
    Ok(ChatTitleUpdate {
        title,
        updated,
        reason: if updated {
            "Title updated."
        } else {
            "Title already matches."
        },
    })
}

/// Record that a chat was opened, moving `read_at` forward. Narrower than
/// `upsert` on purpose: this fires on every chat OPEN, far more often than the
/// deliberate edits (rename, pin) that go through the full save, and a client
/// mid-catch-up does not necessarily hold every other field fresh. Touching
/// only this one avoids a stale local copy clobbering a title or pin another
/// device just changed.
///
/// Only ever moves forward — two tabs opening the same chat a second apart
/// must not let the earlier timestamp win — and a chat the index does not
/// know about (deleted, or a stale id) is not an error: the mark simply has
/// nothing to attach to.
pub fn mark_read(id: &str, at: i64) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = match read_checked() {
        Ok(index) => index,
        Err(_) => return Ok(()),
    };
    let Some(existing) = index.chats.iter_mut().find(|c| c.id == id) else {
        return Ok(());
    };
    let next = existing.read_at.map_or(at, |prev| prev.max(at));
    if existing.read_at == Some(next) {
        return Ok(());
    }
    existing.read_at = Some(next);
    write(&index)
}

/// Tick a chat off, or take the tick back. The one writer of `done_at`, for
/// the same reason `mark_read` is the one writer of `read_at`: the full save
/// carries a whole row that may have been assembled before this was decided,
/// and a pin or a rename must not be able to answer a question nobody asked it.
///
/// `at` is when the person ticked it — the caller's clock, not this one's, so
/// the tick is stamped at the moment it was made rather than the moment it
/// arrived. `None` clears it. A chat the index does not know about is not an
/// error: as with `mark_read`, the mark simply has nothing to attach to.
pub fn set_done(id: &str, at: Option<i64>) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = match read_checked() {
        Ok(index) => index,
        Err(_) => return Ok(()),
    };
    let Some(existing) = index.chats.iter_mut().find(|c| c.id == id) else {
        return Ok(());
    };
    if existing.done_at == at {
        return Ok(());
    }
    existing.done_at = at;
    write(&index)
}

/// Put a chat in the one-day trash. Repeating the same request is idempotent:
/// it does not restart the retention clock.
pub fn trash(
    id: &str,
    expected_generation: Option<u64>,
    fallback: Option<ChatMeta>,
) -> Result<bool, String> {
    trash_at(id, expected_generation, fallback, now_ms())
}

fn trash_at(
    id: &str,
    expected_generation: Option<u64>,
    fallback: Option<ChatMeta>,
    deleted_at: i64,
) -> Result<bool, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = read_checked().map_err(|_| "the chat index could not be read".to_string())?;
    let chat = match index.chats.iter_mut().find(|chat| chat.id == id) {
        Some(chat) => chat,
        None => {
            // A brand-new chat can be deleted before its first asynchronous
            // index save is acknowledged. Keep the metadata carried by the
            // delete, or there would be a transcript with no Trash row and no
            // way to restore it.
            let Some(mut chat) = fallback.filter(|chat| chat.id == id) else {
                return Ok(false);
            };
            chat.deleted_at = Some(deleted_at);
            chat.generation = expected_generation.unwrap_or(0);
            index.chats.push(chat);
            write(&index)?;
            return Ok(true);
        }
    };
    if expected_generation.is_some_and(|generation| generation != chat.generation) {
        return Ok(false);
    }
    if chat.deleted_at.is_some() {
        return Ok(false);
    }
    chat.deleted_at = Some(deleted_at);
    write(&index)?;
    Ok(true)
}

/// Chats still inside their restore window, newest deletion first.
pub fn deleted() -> Vec<ChatMeta> {
    deleted_at(now_ms())
}

fn deleted_at(now: i64) -> Vec<ChatMeta> {
    let mut chats: Vec<_> = read()
        .chats
        .into_iter()
        .filter(|chat| {
            chat.deleted_at
                .is_some_and(|deleted_at| !has_expired(deleted_at, now))
        })
        .collect();
    chats.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    chats
}

/// Bring a chat back while it is still inside the restore window.
pub fn restore(id: &str) -> Result<Option<ChatMeta>, String> {
    restore_at(id, now_ms())
}

fn restore_at(id: &str, now: i64) -> Result<Option<ChatMeta>, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = read_checked().map_err(|_| "the chat index could not be read".to_string())?;
    let Some(chat) = index.chats.iter_mut().find(|chat| chat.id == id) else {
        return Ok(None);
    };
    let Some(deleted_at) = chat.deleted_at else {
        return Ok(Some(chat.clone()));
    };
    if has_expired(deleted_at, now) {
        return Ok(None);
    }
    chat.deleted_at = None;
    chat.generation = chat.generation.saturating_add(1);
    let restored = chat.clone();
    write(&index)?;
    Ok(Some(restored))
}

/// Permanently remove every chat whose one-day restore window has elapsed.
/// The transcript goes first because the empty-index safety guard deliberately
/// preserves an orphan when it cannot prove whether the index was lost. Once
/// the deadline has passed, an expired row left by a failed index write is
/// hidden and retried safely; it is no longer restorable either way.
pub fn purge_expired() -> Result<Vec<String>, String> {
    purge_expired_at(now_ms())
}

fn purge_expired_at(now: i64) -> Result<Vec<String>, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = read_checked().map_err(|_| "the chat index could not be read".to_string())?;
    let expired: Vec<String> = index
        .chats
        .iter()
        .filter(|chat| chat.deleted_at.is_some_and(|at| has_expired(at, now)))
        .map(|chat| chat.id.clone())
        .collect();
    if expired.is_empty() {
        return Ok(expired);
    }
    let expired_set: std::collections::HashSet<_> = expired.iter().cloned().collect();
    index.chats.retain(|chat| !expired_set.contains(&chat.id));
    for id in &expired {
        crate::transcript::forget(&format!("chat:{id}"));
    }
    write(&index)?;
    Ok(expired)
}

fn has_expired(deleted_at: i64, now: i64) -> bool {
    now.saturating_sub(deleted_at) >= DELETED_CHAT_TTL_MS
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// Forget a chat. Its transcript is removed separately — this is only the
/// entry in the list.
#[cfg(test)]
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
    match purge_expired() {
        Ok(expired) if !expired.is_empty() => {
            println!(
                "[chats] permanently removed {} expired chat(s)",
                expired.len()
            );
        }
        Err(why) => eprintln!("[chats] could not purge expired chats: {why}"),
        _ => {}
    }
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

    static LIFECYCLE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn meta(id: &str, created: i64) -> ChatMeta {
        ChatMeta {
            id: id.into(),
            project_id: "p1".into(),
            title: format!("chat {id}"),
            latest_response: None,
            custom_title: false,
            agent_title: false,
            session_id: None,
            cwd: None,
            model_id: None,
            access: None,
            created_at: created,
            updated_at: created,
            read_at: None,
            pinned: false,
            done_at: None,
            deleted_at: None,
            generation: 0,
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
    fn agent_titles_persist_across_stale_browser_saves_and_can_evolve() {
        let id = "test-index-agent-title";
        cleanup(&[id]);
        let mut original = meta(id, 100);
        original.pinned = true;
        original.read_at = Some(150);
        upsert(original.clone()).unwrap();

        let result = set_agent_title(id, "  Fix\n chat\t titles  ").unwrap();
        assert!(result.updated);
        assert_eq!(result.title, "Fix chat titles");
        assert!(!set_agent_title(id, "Fix chat titles").unwrap().updated);
        let found = list().into_iter().find(|c| c.id == id).unwrap();
        assert!(found.agent_title);
        assert!(!found.custom_title);
        assert!(found.pinned);
        assert_eq!(found.created_at, 100);
        assert_eq!(found.updated_at, 100);
        assert_eq!(found.read_at, Some(150));

        // Both the first-message title and an earlier agent title can arrive
        // late with useful transcript metadata. Keep only that metadata.
        original.latest_response = Some("Tests passed".into());
        original.updated_at = 200;
        upsert(original).unwrap();
        let found = list().into_iter().find(|c| c.id == id).unwrap();
        assert_eq!(found.title, "Fix chat titles");
        assert_eq!(found.latest_response.as_deref(), Some("Tests passed"));
        assert_eq!(found.updated_at, 200);
        assert!(set_agent_title(id, "Improve title sync").unwrap().updated);
        upsert(found).unwrap();
        assert_eq!(
            list().into_iter().find(|c| c.id == id).unwrap().title,
            "Improve title sync"
        );
        cleanup(&[id]);
    }

    #[test]
    fn manual_titles_take_precedence_over_agents_and_stale_automatic_saves() {
        let id = "test-index-user-title";
        cleanup(&[id]);
        upsert(meta(id, 100)).unwrap();
        set_agent_title(id, "Agent title").unwrap();
        let stale = list().into_iter().find(|c| c.id == id).unwrap();
        let mut manual = stale.clone();
        manual.title = "My chosen title".into();
        manual.custom_title = true;
        upsert(manual).unwrap();
        upsert(stale).unwrap();

        let result = set_agent_title(id, "Another agent title").unwrap();
        assert!(!result.updated);
        assert_eq!(result.title, "My chosen title");
        assert!(result.reason.contains("user chose"));
        let found = list().into_iter().find(|c| c.id == id).unwrap();
        assert!(found.custom_title);
        assert!(!found.agent_title);
        cleanup(&[id]);
    }

    #[test]
    fn agent_titles_reject_invalid_input_and_missing_or_deleted_chats() {
        let _serial = LIFECYCLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let id = "test-index-agent-title-invalid";
        cleanup(&[id]);
        assert!(set_agent_title(id, "Missing chat").is_err());
        upsert(meta(id, 100)).unwrap();
        for title in [" \n\t ", "has\0control", &"a".repeat(81)] {
            assert!(set_agent_title(id, title).is_err());
        }
        assert_eq!(
            list().into_iter().find(|c| c.id == id).unwrap().title,
            meta(id, 100).title
        );
        let title = "题".repeat(80);
        assert_eq!(set_agent_title(id, &title).unwrap().title, title);
        trash(id, None, None).unwrap();
        assert!(set_agent_title(id, "Deleted chat").is_err());
        cleanup(&[id]);
    }

    #[test]
    fn marking_read_sets_only_that_field() {
        let id = "test-index-read-basic";
        cleanup(&[id]);
        let mut original = meta(id, 100);
        original.title = "keep me".into();
        original.pinned = true;
        upsert(original).unwrap();

        mark_read(id, 500).unwrap();

        let found = list().into_iter().find(|c| c.id == id).unwrap();
        assert_eq!(found.read_at, Some(500));
        assert_eq!(
            found.title, "keep me",
            "a narrow mark must not touch other fields"
        );
        assert!(found.pinned, "a narrow mark must not touch other fields");
        cleanup(&[id]);
    }

    #[test]
    fn a_tick_survives_an_ordinary_save() {
        let id = "test-index-done-survives-save";
        cleanup(&[id]);
        upsert(meta(id, 100)).unwrap();
        set_done(id, Some(900)).unwrap();

        // A rename assembled before the tick was made — the exact shape of a
        // second device, or of this one with a queued save in flight.
        let mut stale = meta(id, 100);
        stale.title = "renamed".into();
        stale.custom_title = true;
        upsert(stale).unwrap();

        let found = list().into_iter().find(|c| c.id == id).unwrap();
        assert_eq!(found.title, "renamed");
        assert_eq!(found.done_at, Some(900), "only set_done may clear a tick");
        cleanup(&[id]);
    }

    #[test]
    fn activity_retires_a_tick_without_a_second_write() {
        let id = "test-index-done-retires";
        cleanup(&[id]);
        upsert(meta(id, 100)).unwrap();
        set_done(id, Some(900)).unwrap();
        assert!(list().into_iter().find(|c| c.id == id).unwrap().is_done());

        // A new message. Nothing clears `done_at`; the comparison does it.
        let mut active = meta(id, 100);
        active.updated_at = 1_000;
        upsert(active).unwrap();

        let found = list().into_iter().find(|c| c.id == id).unwrap();
        assert_eq!(found.done_at, Some(900), "the tick is kept, not erased");
        assert!(
            !found.is_done(),
            "activity after the tick un-ticks the chat"
        );
        cleanup(&[id]);
    }

    #[test]
    fn unticking_clears_the_mark_and_nothing_else() {
        let id = "test-index-done-cleared";
        cleanup(&[id]);
        let mut original = meta(id, 100);
        original.pinned = true;
        upsert(original).unwrap();
        set_done(id, Some(900)).unwrap();

        set_done(id, None).unwrap();

        let found = list().into_iter().find(|c| c.id == id).unwrap();
        assert_eq!(found.done_at, None);
        assert!(found.pinned, "a narrow mark must not touch other fields");
        cleanup(&[id]);
    }

    #[test]
    fn an_entry_written_before_ticks_existed_reads_back_unticked() {
        let id = "test-index-done-legacy";
        cleanup(&[id]);
        upsert(meta(id, 100)).unwrap();

        let found = list().into_iter().find(|c| c.id == id).unwrap();
        assert_eq!(found.done_at, None);
        assert!(!found.is_done());
        // And an unticked row is written without the field, so an index from
        // before this shipped reads back byte for byte as it was written.
        let written = serde_json::to_string(&found).unwrap();
        assert!(!written.contains("doneAt"));
        cleanup(&[id]);
    }

    #[test]
    fn marking_read_never_moves_backwards() {
        let id = "test-index-read-monotonic";
        cleanup(&[id]);
        upsert(meta(id, 100)).unwrap();

        mark_read(id, 500).unwrap();
        // An older mark racing in behind a newer one — two tabs opening the
        // same chat a second apart — must not rewind it.
        mark_read(id, 200).unwrap();

        let found = list().into_iter().find(|c| c.id == id).unwrap();
        assert_eq!(found.read_at, Some(500));
        cleanup(&[id]);
    }

    #[test]
    fn an_ordinary_save_cannot_rewind_a_read_mark_that_already_landed() {
        let id = "test-index-read-save-race";
        cleanup(&[id]);
        upsert(meta(id, 100)).unwrap();
        mark_read(id, 500).unwrap();

        // A rename queued BEFORE the read mark, delivered after it — its local
        // snapshot of `read_at` is still None, the shape `entryFromConversation`
        // sends before this device knows about its own read.
        let mut stale_rename = meta(id, 100);
        stale_rename.title = "renamed".into();
        assert_eq!(stale_rename.read_at, None);
        upsert(stale_rename).unwrap();

        let found = list().into_iter().find(|c| c.id == id).unwrap();
        assert_eq!(found.title, "renamed", "the rename itself still applies");
        assert_eq!(
            found.read_at,
            Some(500),
            "but not at the cost of the read mark"
        );
        cleanup(&[id]);
    }

    #[test]
    fn marking_an_unknown_chat_read_is_not_an_error() {
        // No row to attach to — the chat was deleted, or the id is stale.
        // Nothing to assert beyond "this does not fail".
        mark_read("test-index-read-missing", 500).unwrap();
    }

    #[test]
    fn the_list_comes_back_most_recently_active_first() {
        let (old, new) = ("test-index-old", "test-index-new");
        cleanup(&[old, new]);
        let mut old_but_active = meta(old, 1_000);
        old_but_active.updated_at = 3_000;
        upsert(old_but_active).unwrap();
        upsert(meta(new, 2_000)).unwrap();

        let ours: Vec<String> = list()
            .into_iter()
            .filter(|c| c.id == old || c.id == new)
            .map(|c| c.id)
            .collect();
        assert_eq!(ours, vec![old.to_string(), new.to_string()]);
        cleanup(&[old, new]);
    }

    #[test]
    fn a_pinned_chat_comes_before_a_newer_one() {
        let (old, new) = ("test-index-pinned-old", "test-index-pinned-new");
        cleanup(&[old, new]);
        let mut pinned = meta(old, 1_000);
        pinned.pinned = true;
        upsert(pinned).unwrap();
        upsert(meta(new, 2_000)).unwrap();

        let ours: Vec<String> = list()
            .into_iter()
            .filter(|c| c.id == old || c.id == new)
            .map(|c| c.id)
            .collect();
        assert_eq!(ours, vec![old.to_string(), new.to_string()]);
        cleanup(&[old, new]);
    }

    #[test]
    fn an_entry_written_before_pins_existed_reads_back_unpinned() {
        let meta: ChatMeta =
            serde_json::from_str(r#"{"id":"a","projectId":"p","createdAt":1,"updatedAt":1}"#)
                .unwrap();
        assert!(!meta.pinned);
        assert!(!meta.custom_title);
        assert!(!meta.agent_title);
        // And an unpinned one is written without the field, so the file stays
        // exactly what it was before pins or custom titles existed.
        let written = serde_json::to_string(&meta).unwrap();
        assert!(!written.contains("pinned"));
        assert!(!written.contains("customTitle"));
        assert!(!written.contains("agentTitle"));
        assert!(meta.deleted_at.is_none());
        assert_eq!(meta.generation, 0);
    }

    #[test]
    fn a_custom_title_round_trips_through_the_index_shape() {
        let mut chat = meta("custom-title", 1);
        chat.title = "New chat".into();
        chat.custom_title = true;
        let written = serde_json::to_string(&chat).unwrap();
        assert!(written.contains(r#""customTitle":true"#));
        let read: ChatMeta = serde_json::from_str(&written).unwrap();
        assert_eq!(read.title, "New chat");
        assert!(read.custom_title);
    }

    #[test]
    fn trash_keeps_a_chat_restorable_then_purges_it_after_one_day() {
        let _serial = LIFECYCLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let id = "test-index-trash-lifecycle";
        let key = format!("chat:{id}");
        let base = now_ms();
        cleanup(&[id]);
        crate::transcript::forget(&key);
        upsert(meta(id, 100)).unwrap();
        crate::transcript::append(&key, &serde_json::json!({ "kept": true }));

        assert!(trash_at(id, Some(0), None, base).unwrap());
        assert!(!list().iter().any(|chat| chat.id == id));
        assert!(deleted_at(base + 1).iter().any(|chat| chat.id == id));
        assert!(!crate::transcript::since(&key, 0).is_empty());

        // A stale save can update metadata, but cannot clear the server-owned
        // deletion marker and put the row back in the active list.
        let mut stale = meta(id, 999);
        stale.title = "late save".into();
        upsert(stale).unwrap();
        assert!(!list().iter().any(|chat| chat.id == id));

        // Strictly before the deadline, both halves are still recoverable.
        assert!(purge_expired_at(base + DELETED_CHAT_TTL_MS - 1)
            .unwrap()
            .is_empty());
        let restored = restore_at(id, base + DELETED_CHAT_TTL_MS - 1)
            .unwrap()
            .expect("the chat is still restorable");
        assert_eq!(restored.generation, 1);
        assert!(restored.deleted_at.is_none());
        assert!(!crate::transcript::since(&key, 0).is_empty());

        // A delayed retry of the delete from generation zero cannot bury the
        // newly restored generation.
        assert!(!trash_at(id, Some(0), None, base + DELETED_CHAT_TTL_MS).unwrap());
        assert!(list().iter().any(|chat| chat.id == id));

        // Delete the restored generation, then cross the one-day boundary.
        let deleted_again = base + DELETED_CHAT_TTL_MS;
        assert!(trash_at(id, Some(1), None, deleted_again).unwrap());
        let expired = purge_expired_at(deleted_again + DELETED_CHAT_TTL_MS).unwrap();
        assert_eq!(expired, vec![id.to_string()]);
        assert!(!deleted_at(deleted_again + DELETED_CHAT_TTL_MS)
            .iter()
            .any(|chat| chat.id == id));
        assert!(crate::transcript::since(&key, 0).is_empty());
        cleanup(&[id]);
    }

    #[test]
    fn deleting_before_the_first_save_still_creates_a_restorable_trash_row() {
        let _serial = LIFECYCLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let id = "test-index-trash-before-save";
        let base = now_ms();
        cleanup(&[id]);

        assert!(trash_at(id, Some(0), Some(meta(id, 100)), base).unwrap());
        assert!(!list().iter().any(|chat| chat.id == id));
        assert!(deleted_at(base + 1).iter().any(|chat| chat.id == id));

        cleanup(&[id]);
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

//! The person's own preferences: words they write once in Settings and that
//! every agent chat this server launches carries in its system prompt —
//! ordinary chats, agents-mode chats, the front desk and orchestration
//! workers alike, whichever provider runs them.
//!
//! A system prompt is fixed when the agent process starts, so a change
//! reaches a chat the next time its process starts: a new chat, or a running
//! one after it is resumed (the idle sweeper ends a quiet chat after 15
//! minutes, and the next message starts it again).
//!
//! Browser-only: written through `dispatch.rs`, which no agent hook reaches,
//! so an agent can read its preferences but never rewrite them.
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// The longest preferences kept. They ride every agent's command line, which
/// on Windows has 32,767 characters for everything.
pub const MAX_CHARS: usize = 4000;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    #[serde(default)]
    pub text: String,
    /// When the text last changed, `0` before it ever has.
    #[serde(default)]
    pub updated_at: i64,
}

static LOCK: Mutex<()> = Mutex::new(());

pub fn default_path() -> PathBuf {
    crate::profile::profile_dir().join("preferences.json")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read(path: &Path) -> Result<Preferences, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Personal preferences could not be read: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(e) => Err(format!("Personal preferences could not be read: {e}")),
    }
}

/// The saved preferences, empty when the person has written none.
pub fn load(path: &Path) -> Result<Preferences, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    read(path)
}

/// Replace the preferences; `""` clears them.
pub fn save(path: &Path, text: &str) -> Result<Preferences, String> {
    let text = text.trim();
    if text.chars().count() > MAX_CHARS {
        return Err(format!(
            "Personal preferences are longer than {MAX_CHARS} characters."
        ));
    }
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let before = read(path)?;
    let saved = Preferences {
        text: text.to_owned(),
        updated_at: now_ms().max(before.updated_at + 1),
    };
    let dir = path
        .parent()
        .ok_or("Personal preferences have no storage directory")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".preferences-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(saved)
}

/// What a system prompt carries for `text`, or `None` when there is nothing
/// to carry.
pub fn prompt(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| {
        format!(
            "The person's personal preferences, which they set in OctiqFlow's Settings for every chat. Follow them throughout this conversation unless the person asks otherwise in it:\n\n{text}"
        )
    })
}

/// The block for the saved preferences, read when an agent process starts.
/// A file that cannot be read starts the chat without them rather than not
/// at all.
pub fn launch_prompt() -> Option<String> {
    load(&default_path())
        .ok()
        .and_then(|saved| prompt(&saved.text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    #[test]
    fn nothing_saved_reads_as_empty() {
        let dir = TestDir::new("prefs-empty");
        let path = dir.join("preferences.json");
        assert_eq!(load(&path).unwrap(), Preferences::default());
    }

    #[test]
    fn saves_trimmed_text_and_moves_the_stamp_forward() {
        let dir = TestDir::new("prefs-save");
        let path = dir.join("preferences.json");
        let first = save(&path, "  Reply in British English.\n").unwrap();
        assert_eq!(first.text, "Reply in British English.");
        assert!(first.updated_at > 0);
        assert_eq!(load(&path).unwrap(), first);
        let cleared = save(&path, "").unwrap();
        assert_eq!(cleared.text, "");
        assert!(cleared.updated_at > first.updated_at);
    }

    #[test]
    fn refuses_text_over_the_limit_and_keeps_what_was_saved() {
        let dir = TestDir::new("prefs-long");
        let path = dir.join("preferences.json");
        let kept = save(&path, "Be brief.").unwrap();
        let long = "é".repeat(MAX_CHARS + 1);
        assert!(save(&path, &long).unwrap_err().contains("4000"));
        assert_eq!(load(&path).unwrap(), kept);
        // Characters, not bytes: exactly the limit in a multi-byte letter fits.
        assert!(save(&path, &"é".repeat(MAX_CHARS)).is_ok());
    }

    #[test]
    fn the_prompt_names_where_the_words_came_from_and_is_absent_when_empty() {
        assert_eq!(prompt("  \n"), None);
        let block = prompt(" Use metric units. ").unwrap();
        assert!(block.contains("OctiqFlow's Settings"));
        assert!(block.ends_with("\n\nUse metric units."));
    }
}

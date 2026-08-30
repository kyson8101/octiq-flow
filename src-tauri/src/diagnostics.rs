//! A small, local journal of agent failures that are otherwise transient.
//!
//! Chat transcripts preserve the agents' JSON streams, but stderr and backend
//! hand-off failures are status events, not transcript entries. Keep those in
//! one bounded JSONL file so a later diagnosis can compare failures across
//! chats without retaining whole prompts or tool streams.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::agent_provider::AgentKind;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS: usize = 4 * 1024;
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The current local diagnostic journal, outside every repository.
pub(crate) fn log_path() -> Option<PathBuf> {
    crate::paths::home_dir().map(|home| {
        home.join(".octiqflow")
            .join("logs")
            .join("agent-diagnostics.jsonl")
    })
}

/// Persist an unexpected warning or error. Logging is deliberately best effort:
/// failing to write a diagnostic must never make an agent chat fail too.
pub(crate) fn record(agent: AgentKind, chat_key: &str, kind: &str, message: &str) {
    let Some(path) = log_path() else {
        return;
    };
    let entry = json!({
        "timestamp_ms": timestamp_ms(),
        "provider": agent.id(),
        "chat_key": chat_key,
        "kind": kind,
        "severity": severity(message),
        "message": compact_message(message),
    });
    if let Err(error) = append(&path, &entry) {
        eprintln!("[diagnostics] could not write {}: {error}", path.display());
    }
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn severity(message: &str) -> &'static str {
    let message = message.to_ascii_lowercase();
    if ["error", "failed", "failure", "fatal", "panic", "denied"]
        .iter()
        .any(|needle| message.contains(needle))
    {
        "error"
    } else {
        "warning"
    }
}

fn compact_message(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.chars().count() <= MAX_MESSAGE_CHARS {
        return trimmed.to_string();
    }
    let mut shortened: String = trimmed.chars().take(MAX_MESSAGE_CHARS).collect();
    shortened.push_str("… [truncated]");
    shortened
}

fn previous_path(path: &Path) -> PathBuf {
    path.with_extension("previous.jsonl")
}

fn append(path: &Path, entry: &Value) -> std::io::Result<()> {
    let _guard = WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let parent = path.parent().expect("diagnostic log has a parent");
    fs::create_dir_all(parent)?;
    if path
        .metadata()
        .is_ok_and(|metadata| metadata.len() >= MAX_LOG_BYTES)
    {
        let previous = previous_path(path);
        let _ = fs::remove_file(&previous);
        fs::rename(path, previous)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, entry).map_err(std::io::Error::other)?;
    writeln!(file)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("octiq-diagnostics-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.join("agent-diagnostics.jsonl")
    }

    #[test]
    fn writes_a_queryable_jsonl_record() {
        let path = temp_file("record");
        let entry = json!({
            "timestamp_ms": 123,
            "provider": "codex",
            "chat_key": "chat-a",
            "kind": "stderr",
            "severity": "error",
            "message": "No prompt provided via stdin.",
        });
        append(&path, &entry).unwrap();

        let line = fs::read_to_string(&path).unwrap();
        assert_eq!(serde_json::from_str::<Value>(line.trim()).unwrap(), entry);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn classifies_failures_and_keeps_ordinary_stderr_as_warnings() {
        assert_eq!(severity("Error: no prompt"), "error");
        assert_eq!(severity("rate limit warning"), "warning");
    }

    #[test]
    fn limits_an_oversized_message() {
        let long = "x".repeat(MAX_MESSAGE_CHARS + 1);
        let compacted = compact_message(&long);
        assert!(compacted.starts_with(&"x".repeat(MAX_MESSAGE_CHARS)));
        assert!(compacted.ends_with("… [truncated]"));
    }
}

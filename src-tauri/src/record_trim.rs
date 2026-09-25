//! What a chat record leaves out: the orchestration ledger an agent read.
//!
//! A master re-reads `orchestration_snapshot` after every worker report, and
//! each read was recorded in full. The agent already had it, and nothing reads
//! the copy back: one Codex master's record reached 175 MB, 97% of it snapshot
//! results, and 315 MB across 39 records in all — every byte of it parsed
//! again whenever a tab opened the chat. The ledger itself lives in
//! `orchestrations.json`, and the Orchestrator panel shows it live, so the
//! record keeps a one-line note in place of each read.
//!
//! The note replaces the result and nothing else. A record keeps one line per
//! event, in order, because a line's position is its `seq` and every open tab
//! resumes a chat by it.
use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

/// A read at least this long is recorded as a note. A shorter one — an error,
/// a small run — is already short, and may be worth reading.
pub const RECORD_MIN_BYTES: usize = 2 * 1024;
/// Records written before the note existed lose only reads this long.
const PRUNE_MIN_BYTES: usize = 16 * 1024;
/// Left by a finished pass over old records, so later starts skip it.
const PRUNED_MARKER: &str = ".snapshot-results-pruned-v1";
const TOOL: &str = "orchestration_snapshot";

/// One chat's snapshot calls. Codex names the tool on the item that carries
/// the result; a Claude `tool_result` names only the `tool_use` it answers,
/// so the calls are remembered as they go past.
#[derive(Default)]
pub struct SnapshotResults {
    claude_calls: HashSet<String>,
}

impl SnapshotResults {
    /// Replace a snapshot result at least `min_bytes` long with a note.
    /// True when `event` changed.
    pub fn trim(&mut self, event: &mut Value, min_bytes: usize) -> bool {
        match event.get("type").and_then(Value::as_str) {
            Some("item.completed") => {
                let Some(item) = event.get_mut("item") else {
                    return false;
                };
                if item.get("type").and_then(Value::as_str) != Some("mcp_tool_call")
                    || item.get("tool").and_then(Value::as_str) != Some(TOOL)
                {
                    return false;
                }
                replace(item, "result", min_bytes)
            }
            Some("assistant") => {
                let calls = event
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|block| {
                        block.get("type").and_then(Value::as_str) == Some("tool_use")
                            && block
                                .get("name")
                                .and_then(Value::as_str)
                                .is_some_and(|name| name.ends_with(TOOL))
                    })
                    .filter_map(|block| block.get("id").and_then(Value::as_str));
                self.claude_calls.extend(calls.map(str::to_string));
                false
            }
            Some("user") if !self.claude_calls.is_empty() => {
                let Some(content) = event
                    .pointer_mut("/message/content")
                    .and_then(Value::as_array_mut)
                else {
                    return false;
                };
                let mut trimmed = false;
                for block in content {
                    let answers_a_read = block.get("type").and_then(Value::as_str)
                        == Some("tool_result")
                        && block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| self.claude_calls.contains(id));
                    if answers_a_read {
                        trimmed |= replace(block, "content", min_bytes);
                    }
                }
                trimmed
            }
            _ => false,
        }
    }
}

fn replace(holder: &mut Value, field: &str, min_bytes: usize) -> bool {
    let Some(result) = holder.get_mut(field) else {
        return false;
    };
    let size = serde_json::to_string(result).map_or(0, |text| text.len());
    if size < min_bytes {
        return false;
    }
    // A plain string: the chat view shows it as it is.
    *result = Value::String(format!(
        "orchestration_snapshot result left out of the chat record ({}). The ledger is unchanged; the Orchestrator panel shows it live.",
        human(size)
    ));
    true
}

fn human(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{} KB", bytes.div_ceil(1024))
    }
}

/// Prune records written before snapshot reads were left out. Runs once per
/// profile, on its own thread at startup; each record is rewritten under the
/// append lock, so a chat writing meanwhile cannot lose a line. A pass that
/// hits an error leaves no marker and is tried again on the next start.
pub fn prune_old_records() {
    let Some(dir) = crate::transcript::chats_dir() else {
        return;
    };
    let marker = dir.join(PRUNED_MARKER);
    if marker.exists() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let (mut records, mut freed, mut failed) = (0, 0, false);
    for path in entries.flatten().map(|entry| entry.path()) {
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        match prune_record(&path) {
            Ok(Some(bytes)) => {
                records += 1;
                freed += bytes;
            }
            Ok(None) => {}
            Err(error) => {
                failed = true;
                eprintln!("[records] could not prune {}: {error}", path.display());
            }
        }
    }
    if records > 0 {
        eprintln!(
            "[records] left old snapshot reads out of {records} chat records, {} freed",
            human(freed as usize)
        );
    }
    if !failed {
        let _ = std::fs::write(&marker, "");
    }
}

/// Bytes freed, or `None` when the record held nothing to prune.
fn prune_record(path: &Path) -> std::io::Result<Option<u64>> {
    if !holds_long_results(path)? {
        return Ok(None);
    }
    let before = std::fs::metadata(path)?.len();
    let mut results = SnapshotResults::default();
    let changed = crate::transcript::rewrite_lines(path, |line| {
        // Parse only what can matter: a long line, or a Claude call naming the
        // tool so its result can be recognised later.
        let call = line.contains(TOOL) && line.contains("\"tool_use\"");
        if line.len() < PRUNE_MIN_BYTES && !call {
            return None;
        }
        let mut event: Value = serde_json::from_str(line).ok()?;
        results
            .trim(&mut event, PRUNE_MIN_BYTES)
            .then(|| serde_json::to_string(&event).ok())
            .flatten()
    })?;
    let after = std::fs::metadata(path)?.len();
    Ok(changed.then(|| before.saturating_sub(after)))
}

/// A cheap look before taking the append lock: most records have no line
/// long enough to prune.
fn holds_long_results(path: &Path) -> std::io::Result<bool> {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(std::fs::File::open(path)?);
    let mut line = Vec::new();
    while reader.read_until(b'\n', &mut line)? > 0 {
        if line.len() >= PRUNE_MIN_BYTES
            && [TOOL.as_bytes(), b"\"tool_result\""]
                .iter()
                .any(|needle| line.windows(needle.len()).any(|w| w == *needle))
        {
            return Ok(true);
        }
        line.clear();
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn codex_read(size: usize) -> Value {
        json!({"type": "item.completed", "item": {
            "id": "call_1", "type": "mcp_tool_call", "server": "octiq", "tool": TOOL,
            "arguments": {"runId": "run_1"}, "status": "completed",
            "result": {"content": [{"type": "text", "text": "x".repeat(size)}], "structured_content": null},
        }})
    }

    #[test]
    fn a_codex_read_becomes_a_note_and_nothing_else_changes() {
        let mut results = SnapshotResults::default();
        let mut event = codex_read(1_200_000);
        assert!(results.trim(&mut event, RECORD_MIN_BYTES));
        let note = event["item"]["result"].as_str().unwrap();
        assert!(
            note.contains("left out of the chat record (1.1 MB)"),
            "{note}"
        );
        assert_eq!(event["item"]["arguments"]["runId"], "run_1");
        assert_eq!(event["item"]["status"], "completed");

        let mut short = codex_read(100);
        assert!(!results.trim(&mut short, RECORD_MIN_BYTES));
        let mut other = codex_read(50_000);
        other["item"]["tool"] = json!("orchestration_task_create");
        assert!(!results.trim(&mut other, RECORD_MIN_BYTES));
        let mut started = codex_read(50_000);
        started["type"] = json!("item.started");
        assert!(!results.trim(&mut started, RECORD_MIN_BYTES));
    }

    #[test]
    fn a_claude_result_is_matched_to_the_call_that_asked_for_it() {
        let mut results = SnapshotResults::default();
        let mut call = json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "toolu_read", "name": "mcp__octiq__orchestration_snapshot", "input": {}},
            {"type": "tool_use", "id": "toolu_bash", "name": "Bash", "input": {}},
        ]}});
        assert!(!results.trim(&mut call, RECORD_MIN_BYTES));
        let mut answer = json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_read", "content": [{"type": "text", "text": "x".repeat(40_000)}]},
            {"type": "tool_result", "tool_use_id": "toolu_bash", "content": "y".repeat(40_000)},
        ]}});
        assert!(results.trim(&mut answer, RECORD_MIN_BYTES));
        assert!(answer["message"]["content"][0]["content"]
            .as_str()
            .unwrap()
            .starts_with("orchestration_snapshot result left out"));
        assert_eq!(
            answer["message"]["content"][1]["content"]
                .as_str()
                .unwrap()
                .len(),
            40_000
        );
    }

    #[test]
    fn pruning_keeps_every_line_in_its_place() {
        let dir = std::env::temp_dir().join(format!("octiq-record-trim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chat_master.jsonl");
        let small = codex_read(8_000).to_string();
        let lines = [
            json!({"type": "turn.started"}).to_string(),
            codex_read(300_000).to_string(),
            small.clone(),
            "not json, kept as it is".to_string(),
        ];
        // The last line is torn: a writer died before its newline.
        std::fs::write(
            &path,
            format!("{}\n{}\n{}\n{}", lines[0], lines[1], lines[2], lines[3]),
        )
        .unwrap();

        let freed = prune_record(&path).unwrap().unwrap();
        assert!(freed > 290_000, "{freed}");
        let text = std::fs::read_to_string(&path).unwrap();
        let after: Vec<&str> = text.split('\n').collect();
        assert_eq!(after.len(), 4);
        assert_eq!(after[0], lines[0]);
        let pruned: Value = serde_json::from_str(after[1]).unwrap();
        assert!(pruned["item"]["result"].as_str().unwrap().contains(" KB)"));
        // Under the old-record threshold: an 8 KB read stays.
        assert_eq!(after[2], small);
        assert_eq!(after[3], lines[3]);
        assert!(!text.ends_with('\n'));

        assert_eq!(prune_record(&path).unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

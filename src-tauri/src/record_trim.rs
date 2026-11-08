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
pub fn prune_old_records(manager: &crate::agent_chat::ChatManager) {
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
        let Ok(claim) = manager.claim_record(&path) else {
            failed = true;
            continue;
        };
        drop(claim);
        match prune_record_guarded(&path, || {
            manager.claim_record(&path).map_err(std::io::Error::other)
        }) {
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
    if !failed && crate::profile::make_dir(&dir).is_ok() {
        let _ = std::fs::write(&marker, "");
    }
}

/// Bytes freed, or `None` when the record held nothing to prune.
#[cfg(test)]
fn prune_record(path: &Path) -> std::io::Result<Option<u64>> {
    prune_record_guarded(path, || Ok(()))
}

fn prune_record_guarded<G>(
    path: &Path,
    publish: impl FnOnce() -> std::io::Result<G>,
) -> std::io::Result<Option<u64>> {
    if !holds_long_results(path)? {
        return Ok(None);
    }
    let before = std::fs::metadata(path)?.len();
    let mut results = SnapshotResults::default();
    let changed = crate::transcript::rewrite_numbered_guarded(
        path,
        |_, bytes| {
            let line = std::str::from_utf8(bytes).ok()?;
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
        },
        false,
        publish,
    )?;
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

// ---------------------------------------------------------------------------
// Pictures and finished streams
// ---------------------------------------------------------------------------
//
// Two more things a record carried that it does not need, measured on a
// 108 MB record: 70 MB of pictures a tool returned (a screenshot is recorded
// twice, as the result's `image` block and again as `tool_use_result.file`),
// and 16 MB of `content_block_delta` lines, one per few characters streamed,
// each in a 250-byte envelope. The page draws a tool result's text only, so
// the pictures go as they are recorded. The pieces are merged, later, by
// `compact_record`: once a message has stopped, the first line of each of its
// blocks carries the whole of that block's text and the rest are emptied.
// The page appends pieces as they come, so one piece holding them all draws
// the same thing — not the message's `assistant` copy, whose tool input the
// CLI has already rewritten (a leading `cd <dir> &&` is gone from it).

/// An emptied stream piece. The line stays, because its position is its seq,
/// and names the line its text was merged `into`: a page whose copy of the
/// chat ends between the two holds only part of that text, and catches up by
/// reading the chat afresh instead (web `loadChat`).
pub fn compacted_line(into: u64) -> String {
    format!(r#"{{"type":"octiq_compacted","into":{into}}}"#)
}

/// The field a `content_block_delta` of each kind carries its text in.
fn piece_field(kind: &str) -> Option<&'static str> {
    match kind {
        "text_delta" => Some("text"),
        "thinking_delta" => Some("thinking"),
        "input_json_delta" => Some("partial_json"),
        "signature_delta" => Some("signature"),
        _ => None,
    }
}
/// Remembers how long each record was when it was last compacted, so a start
/// only reads the records that grew since.
const COMPACTED_SIZES: &str = ".compacted-sizes-v2.json";

/// Empty the picture data in a tool's result. True when `event` changed.
pub fn strip_pictures(event: &mut Value) -> bool {
    if event.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    let mut stripped = false;
    let results = event
        .pointer_mut("/message/content")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"));
    for result in results {
        let parts = result
            .get_mut("content")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("image"));
        for part in parts {
            if let Some(source) = part.get_mut("source") {
                stripped |= empty(source, "data");
            }
        }
    }
    // Claude's own copy of what the tool returned, read back by nothing but a
    // file diff, which a picture never has.
    for copy in ["tool_use_result", "toolUseResult"] {
        if let Some(file) = event.pointer_mut(&format!("/{copy}/file")) {
            stripped |= empty(file, "base64");
        }
    }
    stripped
}

fn empty(holder: &mut Value, field: &str) -> bool {
    let size = match holder.get(field).and_then(Value::as_str) {
        Some(data) if !data.is_empty() => data.len(),
        _ => return false,
    };
    holder[field] = Value::String(String::new());
    holder["octiq_left_out"] = Value::String(format!(
        "picture left out of the chat record ({})",
        human(size)
    ));
    true
}

/// Who is writing a streamed message: the host, a subagent, or a seat.
fn writer(event: &Value) -> String {
    format!("{}|{}", event["parent_tool_use_id"], event["octiq_speaker"])
}

fn digest(line: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    line.hash(&mut hasher);
    hasher.finish()
}

/// One block's stream pieces: the first piece, the lines they are on, and
/// their text joined.
struct Pieces {
    first: Value,
    field: &'static str,
    lines: Vec<(u64, u64)>,
    text: String,
}

/// Drop a record's pictures, and merge the stream pieces of every message
/// that has stopped into one line per block. Bytes freed, or `None` when
/// nothing in it could go.
///
/// The record is read once without the append lock to find what changes, so
/// copying and validation stay off the lock too. Publication checks source
/// stamp and generation, so concurrent writes cause a retryable failure.
#[cfg(test)]
pub fn compact_record(path: &Path) -> std::io::Result<Option<u64>> {
    compact_record_guarded(path, || Ok(()))
}

fn compact_record_guarded<G>(
    path: &Path,
    publish: impl FnOnce() -> std::io::Result<G>,
) -> std::io::Result<Option<u64>> {
    use std::collections::HashMap;
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(std::io::Error::other(
            "chat compaction requires a regular record file",
        ));
    }
    // Records are written compactly by `serde_json`, and a quote inside a
    // string is escaped, so these spellings can only be the events' own.
    const NEEDLES: [&[u8]; 7] = [
        br#""type":"message_start""#,
        br#""type":"message_stop""#,
        br#""type":"content_block_delta""#,
        br#""type":"base64""#,
        br#""base64":""#,
        br#""type":"system""#,
        br#""type":"user""#,
    ];
    let needles = NEEDLES.map(memchr::memmem::Finder::new);
    let mut lists = crate::record_storage::Lists::default();
    let mut stopped: HashSet<String> = HashSet::new();
    let mut writing: HashMap<String, String> = HashMap::new();
    // By message id, then block index and kind of piece.
    let mut blocks: HashMap<(String, i64, &'static str), Pieces> = HashMap::new();
    let mut edits: HashMap<u64, (u64, String)> = HashMap::new();
    let (mut previous_stub, mut needs_ranges) = (false, false);
    crate::transcript::try_each_stored_line(std::fs::File::open(path)?, |seq, body| {
        let stub = memchr::memmem::find(body, br#""type":"octiq_compacted""#).is_some();
        needs_ranges |= previous_stub && stub;
        previous_stub = stub;
        if needles.iter().any(|needle| needle.find(body).is_some()) {
            if let Ok(mut event) = serde_json::from_slice::<Value>(body) {
                match event["type"].as_str().unwrap_or_default() {
                    "stream_event" => match event["event"]["type"].as_str().unwrap_or_default() {
                        "message_start" => {
                            let id = event["event"]["message"]["id"].as_str().unwrap_or_default();
                            writing.insert(writer(&event), id.to_string());
                        }
                        "message_stop" => {
                            if let Some(id) = writing.get(&writer(&event)) {
                                stopped.insert(id.clone());
                            }
                        }
                        "content_block_delta" => {
                            let delta = &event["event"]["delta"];
                            let field = piece_field(delta["type"].as_str().unwrap_or_default());
                            let piece = field.and_then(|field| delta[field].as_str());
                            if let (Some(id), Some(field), Some(piece)) =
                                (writing.get(&writer(&event)), field, piece)
                            {
                                let index = event["event"]["index"].as_i64().unwrap_or(-1);
                                let piece = piece.to_string();
                                let sum = digest(body);
                                let block = blocks
                                    .entry((id.clone(), index, field))
                                    .or_insert_with(|| Pieces {
                                        first: event,
                                        field,
                                        lines: Vec::new(),
                                        text: String::new(),
                                    });
                                block.lines.push((seq, sum));
                                block.text.push_str(&piece);
                            }
                        }
                        _ => {}
                    },
                    _ => {
                        strip_pictures(&mut event);
                        crate::record_storage::trim_display_only(&mut event);
                        lists.encode(&mut event, seq);
                        if let Ok(text) = serde_json::to_string(&event) {
                            if text.as_bytes() != body {
                                edits.insert(seq, (digest(body), text));
                            }
                        }
                    }
                }
            }
        }
    })?;
    // Only a stopped message: an open one is still having pieces added. A
    // block's lines change together or not at all, so each line notes which
    // block it is in.
    let mut merged_blocks: HashMap<u64, usize> = HashMap::new();
    for (number, ((id, _, _), mut block)) in blocks.into_iter().enumerate() {
        if !stopped.contains(&id) || block.lines.len() < 2 {
            continue;
        }
        block.first["event"]["delta"][block.field] = Value::String(block.text);
        let Ok(merged) = serde_json::to_string(&block.first) else {
            continue;
        };
        let into = block.lines[0].0;
        for (at, (seq, sum)) in block.lines.into_iter().enumerate() {
            let text = if at == 0 {
                merged.clone()
            } else {
                compacted_line(into)
            };
            edits.insert(seq, (sum, text));
            merged_blocks.insert(seq, number);
        }
    }
    // Most Codex records have none of these repeated parts. Do not copy and
    // sync an entire unchanged file merely to discover there is no edit.
    if edits.is_empty() && !needs_ranges && !path.with_extension("jsonl.compact-backup").exists() {
        return Ok(None);
    }
    let before = std::fs::metadata(path)?.len();
    let mut skipped: HashSet<usize> = HashSet::new();
    let changed = crate::transcript::rewrite_numbered_guarded(
        path,
        |seq, body| {
            let (sum, text) = edits.remove(&seq)?;
            let block = merged_blocks.get(&seq);
            if block.is_some_and(|block| skipped.contains(block)) {
                return None;
            }
            if digest(body) != sum {
                // Changed since it was read; a block's first line comes first, so
                // the rest of it is left too.
                skipped.extend(block);
                return None;
            }
            Some(text)
        },
        true,
        publish,
    )?;
    let after = std::fs::metadata(path)?.len();
    Ok(changed.then(|| before.saturating_sub(after)))
}

/// Compact one chat's record, e.g. once its process has gone idle.
pub fn compact_chat(manager: &crate::agent_chat::ChatManager, key: &str) {
    let Some(path) = crate::transcript::path_for(key) else {
        return;
    };
    let Ok(claim) = manager.claim_record(&path) else {
        return;
    };
    drop(claim);
    if let Err(error) = compact_record_guarded(&path, || {
        manager.claim_record(&path).map_err(std::io::Error::other)
    }) {
        eprintln!("[records] could not compact {}: {error}", path.display());
        return;
    }
    remember_size(&path);
}

static SIZES: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn sizes_path() -> Option<std::path::PathBuf> {
    Some(crate::transcript::chats_dir()?.join(COMPACTED_SIZES))
}

fn read_sizes() -> Result<std::collections::HashMap<String, u64>, String> {
    let path = sizes_path().ok_or_else(|| {
        crate::profile::available()
            .err()
            .unwrap_or_else(|| "chat folder unavailable".into())
    })?;
    crate::profile::read(&path, |e| e.to_string())?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(|e| e.to_string()))
        .unwrap_or_else(|| Ok(std::collections::HashMap::new()))
}

fn write_sizes(sizes: &std::collections::HashMap<String, u64>) {
    if let (Some(path), Ok(text)) = (sizes_path(), serde_json::to_string(sizes)) {
        let temp = path.with_extension("json.tmp");
        if path
            .parent()
            .is_none_or(|dir| crate::profile::make_dir(dir).is_err())
        {
            return;
        }
        if std::fs::write(&temp, text).is_ok() {
            let _ = std::fs::rename(&temp, &path);
        }
    }
}

fn remember_size(path: &Path) {
    let (Some(name), Ok(meta)) = (
        path.file_name().and_then(|name| name.to_str()),
        std::fs::metadata(path),
    ) else {
        return;
    };
    let _held = SIZES.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(mut sizes) = read_sizes() else {
        return;
    };
    sizes.insert(name.to_string(), meta.len());
    write_sizes(&sizes);
}

/// Compact every record that grew since it was last compacted. On its own
/// thread at startup. Only source checks/rename/sync take the append lock;
/// preparation and readback permit live appends and chat starts.
pub fn compact_records(manager: &crate::agent_chat::ChatManager) {
    let Some(dir) = crate::transcript::chats_dir() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let known = {
        let _held = SIZES.lock().unwrap_or_else(|e| e.into_inner());
        let Ok(sizes) = read_sizes() else {
            return;
        };
        sizes
    };
    let (mut records, mut freed) = (0, 0);
    for path in entries.flatten().map(|entry| entry.path()) {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let Ok(claim) = manager.claim_record(&path) else {
            continue;
        };
        drop(claim);
        let size = std::fs::metadata(&path).map_or(0, |meta| meta.len());
        if known.get(name) == Some(&size) && !path.with_extension("jsonl.compact-backup").exists() {
            continue;
        }
        match compact_record_guarded(&path, || {
            manager.claim_record(&path).map_err(std::io::Error::other)
        }) {
            Ok(Some(bytes)) => {
                records += 1;
                freed += bytes;
            }
            Ok(None) => {}
            Err(error) => {
                eprintln!("[records] could not compact {}: {error}", path.display());
                continue;
            }
        }
        remember_size(&path);
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if records > 0 {
        eprintln!(
            "[records] left pictures and finished stream pieces out of {records} chat records, {} freed",
            human(freed as usize)
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_chat_start_during_preparation_wins_over_publication() {
        let manager = crate::agent_chat::ChatManager::default();
        let key = format!("chat:{}", uuid::Uuid::new_v4());
        crate::transcript::append(&key, &json!({"type":"user","message":{"content":"keep"}}));
        let path = crate::transcript::path_for(&key).unwrap();
        let before = std::fs::read(&path).unwrap();
        let seen = crate::transcript::generation(&key);
        let mut start = None;
        let result = crate::transcript::rewrite_numbered_guarded(
            &path,
            |_, _| {
                start = Some(manager.claim_start(&key).unwrap());
                Some(r#"{"type":"user","message":{"content":"changed"}}"#.into())
            },
            true,
            || manager.claim_record(&path).map_err(std::io::Error::other),
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(crate::transcript::generation(&key), seen);
        drop(start);
        crate::transcript::forget(&key);
    }

    #[test]
    #[ignore]
    fn release_lock_evidence() {
        let root = std::path::PathBuf::from(
            std::env::var("OCTIQ_RECORD_EVIDENCE").expect("offline scratch root"),
        );
        let root = crate::paths::canonicalize(root).unwrap();
        assert!(root.starts_with(crate::paths::canonicalize(std::env::temp_dir()).unwrap()));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("octiq-record-storage-"));
        let source = std::fs::read_dir(root.join("original"))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
            .max_by_key(|p| p.metadata().unwrap().len())
            .unwrap();
        let target = root.join("lock-evidence.jsonl");
        std::fs::copy(&source, &target).unwrap();
        crate::transcript::take_rewrite_lock_max();
        let began = std::time::Instant::now();
        let freed = compact_record(&target).unwrap().unwrap();
        let longest = crate::transcript::take_rewrite_lock_max();
        let result = json!({"sourceBytes":source.metadata().unwrap().len(), "savedBytes":freed,
            "elapsedSeconds":began.elapsed().as_secs_f64(), "longestAppendLockSeconds":longest.as_secs_f64(),
            "optimized":!cfg!(debug_assertions)});
        std::fs::write(
            root.join("lock-evidence.json"),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
        println!("{result}");
        assert!(
            longest < std::time::Duration::from_secs(1),
            "publication lock exceeded budget: {longest:?}"
        );
    }

    #[test]
    fn a_record_hold_blocks_alias_starts_and_a_claimed_chat_is_not_compacted() {
        let manager = crate::agent_chat::ChatManager::default();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let key = format!("chat:{id}");
        let alias = format!("chat_{id}");
        let init = json!({"type":"system","subtype":"init","tools":["tool"]});
        crate::transcript::append(&key, &init);
        let path = crate::transcript::path_for(&key).unwrap();
        let hold = manager.claim_record(&path).unwrap();
        assert!(manager.claim_start(&key).is_err());
        assert!(manager.claim_start(&alias).is_err());
        drop(hold);
        let claim = manager.claim_start(&alias).unwrap();
        assert!(manager.claim_record(&path).is_err());
        let before = std::fs::read(&path).unwrap();
        compact_chat(&manager, &key);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        drop(claim);
        assert!(manager.claim_record(&path).is_ok());
        crate::transcript::forget(&key);
    }

    #[test]
    fn pending_and_unsynced_answered_questions_hold_the_record_generation() {
        let manager = crate::agent_chat::ChatManager::default();
        let key = format!("chat:{}", uuid::Uuid::new_v4());
        crate::transcript::append(&key, &json!({"type":"system","subtype":"init"}));
        let path = crate::transcript::path_for(&key).unwrap();
        let (id, _rx) = manager
            .questions
            .insert(
                crate::question_store::test_origin(&key),
                vec![serde_json::from_value(json!({"question":"Keep?"})).unwrap()],
            )
            .unwrap();
        assert!(manager.claim_record(&path).is_err());
        let asked = manager.questions.pending().unwrap();
        manager
            .questions
            .answer(&[crate::question_store::Answer {
                id: asked[0].id.clone(),
                answer: "yes".into(),
            }])
            .unwrap();
        crate::transcript::FAIL_DIR_SYNC.with(|fail| fail.set(true));
        assert!(manager.questions.take_tool(&id).unwrap().is_some());
        crate::transcript::FAIL_DIR_SYNC.with(|fail| fail.set(false));
        assert!(manager.questions.owes_notes());
        assert!(manager.claim_record(&path).is_err());
        let seen = crate::transcript::generation(&key);
        compact_chat(&manager, &key);
        assert_eq!(crate::transcript::generation(&key), seen);
        manager.questions.notes_due_now();
        manager.questions.settle_notes().unwrap();
        assert!(!manager.questions.owes_notes());
        assert!(manager.claim_record(&path).is_ok());
        assert_eq!(
            crate::transcript::of_type(&key, "octiq_question_answered").len(),
            1
        );
        crate::transcript::forget(&key);
    }

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
        let dir = crate::test_dir::TestDir::new("record-trim");
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
    }

    fn screenshot(size: usize) -> Value {
        let data = "A".repeat(size);
        json!({"type": "user",
            "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_shot", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}},
                {"type": "text", "text": "the page"},
            ]}]},
            "tool_use_result": {"type": "image", "file": {"base64": data, "type": "image/png"}}})
    }

    #[test]
    fn a_picture_a_tool_returned_is_left_out_and_its_words_stay() {
        let mut event = screenshot(600_000);
        assert!(strip_pictures(&mut event));
        let text = event.to_string();
        assert!(text.len() < 1_000, "{text}");
        assert_eq!(
            event["message"]["content"][0]["content"][1]["text"],
            "the page"
        );
        assert!(event["tool_use_result"]["file"]["octiq_left_out"]
            .as_str()
            .unwrap()
            .contains("586 KB"));
        // Already empty, a typed message, an assistant event: nothing to do.
        assert!(!strip_pictures(&mut event));
        let mut typed = json!({"type": "user", "message": {"content": [
            {"type": "image", "source": {"type": "base64", "data": "AAAA"}}]}});
        assert!(!strip_pictures(&mut typed));
    }

    /// Offline evidence only. Requires TWO existing, distinct scratch folders,
    /// and refuses the live profile. The caller copies records first; this test
    /// never discovers or mutates this machine's live chats.
    #[test]
    #[ignore]
    fn offline_storage_evidence() {
        use sha2::{Digest, Sha256};
        use std::io::{Read, Write};
        let from = std::path::PathBuf::from(
            std::env::var("OCTIQ_RECORD_ORIGINAL").expect("original scratch folder"),
        );
        let to = std::path::PathBuf::from(
            std::env::var("OCTIQ_RECORD_COMPACTED").expect("compacted scratch folder"),
        );
        let from = crate::paths::canonicalize(&from).unwrap();
        let to = crate::paths::canonicalize(&to).unwrap();
        assert_ne!(from, to);
        let scratch = crate::paths::canonicalize(&std::env::temp_dir()).unwrap();
        assert!(from.starts_with(&scratch) && to.starts_with(&scratch));
        assert_eq!(from.parent(), to.parent());
        assert!(from
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("octiq-record-storage-"));
        if std::env::var_os("OCTIQ_RECORD_SKIP_SETUP").is_none() {
            // Append-only growth, measured before any historical rewrite. This
            // uses the exact encoder called by transcript::write.
            let largest = std::fs::read_dir(&from)
                .unwrap()
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
                .max_by_key(|p| std::fs::metadata(p).map_or(0, |m| m.len()))
                .unwrap();
            let mut lists = crate::record_storage::Lists::default();
            let mut groups: std::collections::BTreeMap<String, (u64, u64, u64)> =
                std::collections::BTreeMap::new();
            let mut turns = Vec::new();
            let (mut old_turn, mut new_turn) = (0u64, 0u64);
            crate::transcript::try_each_stored_line(
                std::fs::File::open(&largest).unwrap(),
                |seq, line| {
                    let Ok(mut event) = serde_json::from_slice::<Value>(line) else {
                        return;
                    };
                    let group = match (event["type"].as_str(), event["subtype"].as_str()) {
                        (Some("system"), Some(kind)) => format!("system/{kind}"),
                        (Some("user"), _)
                            if event.get("tool_use_result").is_some()
                                || event.get("toolUseResult").is_some() =>
                        {
                            "user/tool-result".into()
                        }
                        _ => "other".into(),
                    };
                    let before = line.len() as u64 + 1;
                    crate::record_storage::trim_display_only(&mut event);
                    lists.encode(&mut event, seq);
                    let after = event.to_string().len() as u64 + 1;
                    let totals = groups.entry(group).or_default();
                    totals.0 += 1;
                    totals.1 += before;
                    totals.2 += after;
                    old_turn += before;
                    new_turn += after;
                    if event["type"] == "result"
                        || event["type"] == "turn.completed"
                        || event["type"] == "turn.failed"
                    {
                        turns.push((old_turn, new_turn));
                        old_turn = 0;
                        new_turn = 0;
                    }
                },
            )
            .unwrap();
            let mut old: Vec<_> = turns.iter().map(|t| t.0).collect();
            let mut new: Vec<_> = turns.iter().map(|t| t.1).collect();
            old.sort_unstable();
            new.sort_unstable();
            let percentile = |values: &[u64], percent: usize| {
                values
                    .get(values.len().saturating_sub(1) * percent / 100)
                    .copied()
            };
            std::fs::write(to.parent().unwrap().join("write-growth.json"), serde_json::to_vec_pretty(&json!({
            "record": largest.file_name().unwrap().to_string_lossy(), "completedTurns":turns.len(),
            "categories":groups, "beforeP50TurnBytes":percentile(&old,50), "afterP50TurnBytes":percentile(&new,50),
            "beforeP90TurnBytes":percentile(&old,90), "afterP90TurnBytes":percentile(&new,90)
        })).unwrap()).unwrap();
        }
        if std::env::var_os("OCTIQ_RECORD_SKIP_SETUP").is_none() {
            // Run the exact Rust compactor against all real captured streams too.
            let fixtures =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/src/lib/__fixtures__");
            let evidence = to.parent().unwrap().join("fixtures");
            crate::profile::make_dir(&evidence).unwrap();
            let decoded = to.parent().unwrap().join("decoded-fixtures");
            crate::profile::make_dir(&decoded).unwrap();
            for entry in std::fs::read_dir(fixtures).unwrap().flatten() {
                if entry.path().extension().is_some_and(|e| e == "jsonl") {
                    let target = evidence.join(entry.file_name());
                    std::fs::copy(entry.path(), &target).unwrap();
                    compact_record(&target).unwrap();
                    let mut output = std::io::BufWriter::new(
                        std::fs::File::create(decoded.join(entry.file_name())).unwrap(),
                    );
                    crate::transcript::for_each_line(
                        std::fs::File::open(&target).unwrap(),
                        |seq, line| {
                            if let Ok(event) = serde_json::from_slice::<Value>(line) {
                                writeln!(output, "{}", json!({"seq":seq,"event":event})).unwrap();
                            }
                        },
                    );
                    output.flush().unwrap();
                }
            }
            std::fs::write(
                to.parent().unwrap().join("fixtures.done"),
                "verified Rust readback exported",
            )
            .unwrap();
        }
        let mut paths: Vec<_> = std::fs::read_dir(&to)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
            .collect();
        paths.sort_by_key(|path| {
            (
                std::cmp::Reverse(
                    std::fs::metadata(from.join(path.file_name().unwrap())).map_or(0, |m| m.len()),
                ),
                path.file_name().unwrap().to_os_string(),
            )
        });
        let shard = std::env::var("OCTIQ_RECORD_SHARD").ok().map(|value| {
            let (at, count) = value.split_once('/').expect("shard index/count");
            let at: usize = at.parse().unwrap();
            let count: usize = count.parse().unwrap();
            assert!(count > 0 && at < count);
            (at, count)
        });
        if let Some((at, count)) = shard {
            paths = paths
                .into_iter()
                .enumerate()
                .filter_map(|(index, path)| (index % count == at).then_some(path))
                .collect();
        }
        let report_path = to.parent().unwrap().join(shard.map_or_else(
            || "sizes.jsonl".into(),
            |(at, _)| format!("sizes-{at}.jsonl"),
        ));
        let mut report = std::fs::File::create(report_path).unwrap();
        for (at, path) in paths.iter().enumerate() {
            let original = from.join(path.file_name().unwrap());
            let before = std::fs::metadata(&original).unwrap().len();
            let current = std::fs::metadata(path).unwrap().len();
            let started = std::time::Instant::now();
            let freed = compact_record(path)
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
                .unwrap_or(0);
            let after = std::fs::metadata(path).unwrap().len();
            assert_eq!(freed, current.saturating_sub(after));
            // Host facts and numbering are checked against the untouched
            // scratch copy as well as the atomic rewriter's backup.
            let facts = |p: &Path| {
                let mut out = Vec::new();
                crate::transcript::for_each_line(std::fs::File::open(p).unwrap(), |seq, line| {
                    if let Ok(e) = serde_json::from_slice::<Value>(line) {
                        if e["type"]
                            .as_str()
                            .is_some_and(|t| t.starts_with("octiq_") && t != "octiq_compacted")
                        {
                            out.push((seq, e));
                        }
                    }
                });
                out
            };
            let digest = |path: &Path| {
                let mut file = std::fs::File::open(path).unwrap();
                let mut sha = Sha256::new();
                let mut buffer = [0u8; 64 * 1024];
                loop {
                    let n = file.read(&mut buffer).unwrap();
                    if n == 0 {
                        break;
                    }
                    sha.update(&buffer[..n]);
                }
                <[u8; 32]>::from(sha.finalize())
            };
            // An unchanged byte-for-byte record needs no second JSON parse.
            // Changed records still compare every host fact at its logical seq.
            if before != after || digest(&original) != digest(path) {
                assert_eq!(
                    facts(&original),
                    facts(path),
                    "host facts {}",
                    path.display()
                );
            }
            writeln!(report, "{}", json!({"name":path.file_name().unwrap().to_string_lossy(), "before":before,"after":after,"millis":started.elapsed().as_millis()})).unwrap();
            eprintln!(
                "{}/{} {}: {before} -> {after}",
                at + 1,
                paths.len(),
                path.file_name().unwrap().to_string_lossy()
            );
        }
    }

    fn stream(writer: Option<&str>, kind: &str, extra: Value) -> String {
        let mut event = json!({"type": "stream_event", "event": {"type": kind}});
        if let Some(parent) = writer {
            event["parent_tool_use_id"] = json!(parent);
        }
        if let (Some(event), Some(extra)) = (event["event"].as_object_mut(), extra.as_object()) {
            event.extend(extra.clone());
        }
        event.to_string()
    }

    #[test]
    fn compacting_merges_the_pieces_of_a_stopped_message_only() {
        let dir = crate::test_dir::TestDir::new("record-compact");
        let path = dir.join("chat_long.jsonl");
        let delta = |writer, index: u64, kind: &str, field: &str, piece: &str| {
            let mut delta = json!({"type": kind});
            delta[field] = json!(piece);
            stream(
                writer,
                "content_block_delta",
                json!({"index": index, "delta": delta}),
            )
        };
        let lines = [
            stream(
                None,
                "message_start",
                json!({"message": {"id": "msg_done"}}),
            ),
            delta(None, 0, "text_delta", "text", "hel"),
            // A subagent writing at the same time, whose message never ends.
            stream(
                Some("toolu_task"),
                "message_start",
                json!({"message": {"id": "msg_open"}}),
            ),
            delta(Some("toolu_task"), 0, "text_delta", "text", "a"),
            delta(Some("toolu_task"), 0, "text_delta", "text", "b"),
            delta(None, 0, "text_delta", "text", "lo"),
            delta(
                None,
                1,
                "input_json_delta",
                "partial_json",
                "{\"command\": \"cd x && ls\"",
            ),
            delta(None, 1, "input_json_delta", "partial_json", "}"),
            stream(None, "message_stop", json!({})),
            screenshot(300_000).to_string(),
        ];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        let freed = compact_record(&path).unwrap().unwrap();
        assert!(freed > 590_000, "{freed}");
        let text = std::fs::read_to_string(&path).unwrap();
        let after: Vec<&str> = text.lines().collect();
        assert_eq!(after.len(), lines.len(), "every line keeps its place");
        let piece = |at: usize, field: &str| {
            serde_json::from_str::<Value>(after[at]).unwrap()["event"]["delta"][field].clone()
        };
        assert_eq!(piece(1, "text"), "hello");
        assert_eq!(piece(6, "partial_json"), "{\"command\": \"cd x && ls\"}");
        for at in [5, 7] {
            assert_eq!(after[at], compacted_line(if at == 5 { 2 } else { 7 }));
        }
        for at in [0, 2, 3, 4, 8] {
            assert_eq!(after[at], lines[at], "line {at}");
        }
        assert!(after[9].len() < 1_000 && after[9].contains("the page"));
        assert_eq!(compact_record(&path).unwrap(), None);
    }
}

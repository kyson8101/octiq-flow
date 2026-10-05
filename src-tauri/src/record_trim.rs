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
const COMPACTED_SIZES: &str = ".compacted-sizes-v1.json";

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
/// the lock is held only to copy the file. A line that is no longer what that
/// read saw is left as it is.
pub fn compact_record(path: &Path) -> std::io::Result<Option<u64>> {
    use std::collections::HashMap;
    use std::io::BufRead;
    // Records are written compactly by `serde_json`, and a quote inside a
    // string is escaped, so these spellings can only be the events' own.
    const NEEDLES: [&[u8]; 5] = [
        br#""type":"message_start""#,
        br#""type":"message_stop""#,
        br#""type":"content_block_delta""#,
        br#""type":"base64""#,
        br#""base64":""#,
    ];
    let needles = NEEDLES.map(memchr::memmem::Finder::new);
    let mut reader = std::io::BufReader::new(std::fs::File::open(path)?);
    let mut line = Vec::new();
    let mut seq = 0u64;
    let mut stopped: HashSet<String> = HashSet::new();
    let mut writing: HashMap<String, String> = HashMap::new();
    // By message id, then block index and kind of piece.
    let mut blocks: HashMap<(String, i64, &'static str), Pieces> = HashMap::new();
    let mut edits: HashMap<u64, (u64, String)> = HashMap::new();
    while reader.read_until(b'\n', &mut line)? > 0 {
        seq += 1;
        let body = line.strip_suffix(b"\n").unwrap_or(&line);
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
                        if strip_pictures(&mut event) {
                            if let Ok(text) = serde_json::to_string(&event) {
                                edits.insert(seq, (digest(body), text));
                            }
                        }
                    }
                }
            }
        }
        line.clear();
    }
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
    if edits.is_empty() {
        return Ok(None);
    }
    let before = std::fs::metadata(path)?.len();
    let mut skipped: HashSet<usize> = HashSet::new();
    let changed = crate::transcript::rewrite_numbered(path, |seq, body| {
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
    })?;
    let after = std::fs::metadata(path)?.len();
    Ok(changed.then(|| before.saturating_sub(after)))
}

/// Compact one chat's record, e.g. once its process has gone idle.
pub fn compact_chat(key: &str) {
    let Some(path) = crate::transcript::path_for(key) else {
        return;
    };
    if let Err(error) = compact_record(&path) {
        eprintln!("[records] could not compact {}: {error}", path.display());
    }
    remember_size(&path);
}

static SIZES: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn sizes_path() -> Option<std::path::PathBuf> {
    Some(crate::transcript::chats_dir()?.join(COMPACTED_SIZES))
}

fn read_sizes() -> std::collections::HashMap<String, u64> {
    sizes_path()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_sizes(sizes: &std::collections::HashMap<String, u64>) {
    if let (Some(path), Ok(text)) = (sizes_path(), serde_json::to_string(sizes)) {
        let temp = path.with_extension("json.tmp");
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
    let mut sizes = read_sizes();
    sizes.insert(name.to_string(), meta.len());
    write_sizes(&sizes);
}

/// Compact every record that grew since it was last compacted. On its own
/// thread at startup; each record takes the append lock only while it is
/// copied, and a pause between records leaves the lock to live chats.
pub fn compact_records() {
    let Some(dir) = crate::transcript::chats_dir() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let known = {
        let _held = SIZES.lock().unwrap_or_else(|e| e.into_inner());
        read_sizes()
    };
    let (mut records, mut freed) = (0, 0);
    for path in entries.flatten().map(|entry| entry.path()) {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let size = std::fs::metadata(&path).map_or(0, |meta| meta.len());
        if known.get(name) == Some(&size) {
            continue;
        }
        match compact_record(&path) {
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

    /// Compact copies of real records, with timings:
    /// `OCTIQ_COMPACT_CHECK=<record>=<copy>:… cargo test -- --ignored real_records_compact`
    #[test]
    #[ignore]
    fn real_records_compact() {
        let Ok(pairs) = std::env::var("OCTIQ_COMPACT_CHECK") else {
            return;
        };
        for pair in pairs.split(':') {
            let (from, to) = pair.split_once('=').unwrap();
            std::fs::copy(from, to).unwrap();
            let before = std::fs::metadata(to).unwrap().len();
            let started = std::time::Instant::now();
            let freed = compact_record(Path::new(to)).unwrap().unwrap_or(0);
            eprintln!(
                "{from}: {} → {} in {:?}",
                human(before as usize),
                human((before - freed) as usize),
                started.elapsed()
            );
            let lines = |path: &str| {
                std::fs::read(path)
                    .unwrap()
                    .iter()
                    .filter(|&&b| b == b'\n')
                    .count()
            };
            assert_eq!(lines(from), lines(to));
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

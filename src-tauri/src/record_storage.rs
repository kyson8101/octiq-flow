//! Disk-only encoding. Native agents resume their own session files; these
//! references are decoded before an application reader or the browser sees them.
use std::collections::HashMap;

use serde_json::Value;
use sha2::{Digest, Sha256};

const REFS: &str = "octiq_record_refs";
const LISTS: [&str; 6] = [
    "tools",
    "slash_commands",
    "skills",
    "mcp_servers",
    "plugins",
    "commands",
];

fn group(event: &Value) -> Option<String> {
    (event["type"] == "system"
        && matches!(event["subtype"].as_str(), Some("init" | "commands_changed")))
    .then(|| event["subtype"].as_str().unwrap().to_string())
}

/// Only hashes and source numbers, never the large lists, survive an append.
#[derive(Clone, Default)]
pub(crate) struct Lists {
    last: HashMap<(String, String), ([u8; 32], u64)>,
}

impl Lists {
    pub(crate) fn observe(&mut self, event: &Value, seq: u64) {
        let Some(group) = group(event) else { return };
        for field in LISTS {
            if let Some(value) = event.get(field).filter(|v| v.is_array()) {
                let hash = Sha256::digest(value.to_string().as_bytes()).into();
                self.last
                    .insert((group.clone(), field.to_string()), (hash, seq));
            }
        }
    }

    pub(crate) fn encode(&mut self, event: &mut Value, seq: u64) {
        let Some(group) = group(event) else { return };
        for field in LISTS {
            let Some(value) = event.get(field) else {
                continue;
            };
            if !value.is_array() {
                continue;
            }
            let hash: [u8; 32] = Sha256::digest(value.to_string().as_bytes()).into();
            let key = (group.clone(), field.to_string());
            if let Some((_, source)) = self.last.get(&key).filter(|(old, _)| *old == hash) {
                let source = *source;
                event.as_object_mut().unwrap().remove(field);
                if !event.get(REFS).is_some_and(Value::is_object) {
                    event[REFS] = serde_json::json!({});
                }
                event[REFS][field] = source.into();
            } else {
                self.last.insert(key, (hash, seq));
            }
        }
    }
}

/// A forward reader needs only the newest material list of each kind. A
/// reference always points at that material line, never at another reference.
#[derive(Default)]
pub(crate) struct ListReader {
    last: HashMap<(String, String), (u64, Value)>,
}

impl ListReader {
    pub(crate) fn decode(&mut self, event: &mut Value, seq: u64) -> std::io::Result<()> {
        let Some(group) = group(event) else {
            return Ok(());
        };
        let refs = event.get(REFS).cloned().unwrap_or(Value::Null);
        resolve(event, |source, field| {
            self.last
                .get(&(group.clone(), field.to_string()))
                .filter(|(at, _)| *at == source)
                .map(|(_, value)| value.clone())
        })?;
        // Only remember material sources. Repeats must not change their seq.
        for field in LISTS {
            if let Some(value) = event
                .get(field)
                .filter(|v| v.is_array() && refs.get(field).is_none())
            {
                let key = (group.clone(), field.to_string());
                self.last.insert(key, (seq, value.clone()));
            }
        }
        Ok(())
    }
}

/// Used by the random-access page reader, which can fetch the source line
/// directly even when the repeated init is the page's only context event.
pub(crate) fn resolve(
    event: &mut Value,
    mut source: impl FnMut(u64, &str) -> Option<Value>,
) -> std::io::Result<()> {
    if group(event).is_none() {
        return Ok(());
    }
    let Some(refs) = event.get(REFS).and_then(Value::as_object).cloned() else {
        return Ok(());
    };
    for (field, at) in refs {
        let value = at
            .as_u64()
            .filter(|_| LISTS.contains(&field.as_str()))
            .and_then(|at| source(at, &field))
            .filter(Value::is_array)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "missing chat record list reference",
                )
            })?;
        event[&field] = value;
    }
    event.as_object_mut().unwrap().remove(REFS);
    Ok(())
}

/// One physical line can occupy several logical event positions. Only our
/// no-op stream tombstones may carry a range; arbitrary provider JSON cannot
/// move the cursor. Invalid ranges keep their ordinary single position.
pub(crate) fn span(line: &[u8]) -> u64 {
    if memchr::memmem::find(line, b"\"octiq_compacted\"").is_none() {
        return 1;
    }
    let Ok(event) = serde_json::from_slice::<Value>(line) else {
        return 1;
    };
    if event["type"] != "octiq_compacted" || event["into"].as_u64().is_none_or(|n| n == 0) {
        return 1;
    }
    event["count"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= u32::MAX as u64)
        .unwrap_or(1)
}

/// Keep the exact diff and failure-origin fields the UI reads, and the text
/// from message.content. stdout, MCP content, Read.file and originalFile were
/// second copies; neither the cards nor search read those copies.
pub(crate) fn trim_display_only(event: &mut Value) -> bool {
    let mut changed = false;
    if event["type"] == "user"
        && event
            .pointer("/message/content")
            .and_then(Value::as_array)
            .is_some_and(|parts| parts.iter().any(|p| p["type"] == "tool_result"))
    {
        for name in ["tool_use_result", "toolUseResult"] {
            let Some(value) = event.get_mut(name) else {
                continue;
            };
            if let Some(fields) = value.as_object_mut() {
                let created = fields.get("type").is_some_and(|v| v == "create");
                let before = fields.len();
                fields.retain(|key, _| {
                    matches!(
                        key.as_str(),
                        "filePath" | "structuredPatch" | "type" | "_meta"
                    ) || (created && key == "content")
                });
                changed |= before != fields.len();
            } else {
                event.as_object_mut().unwrap().remove(name);
                changed = true;
            }
        }
    }
    // hook_response is ignored by every display reader, including failures.
    if event["type"] == "system" && event["subtype"] == "hook_response" {
        for name in ["output", "stdout", "stderr"] {
            changed |= event.as_object_mut().unwrap().remove(name).is_some();
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lists_repeat_by_reference_and_a_change_keeps_its_own_source() {
        let mut lists = Lists::default();
        let mut reader = ListReader::default();
        for (seq, commands) in [
            (1, vec!["a"]),
            (2, vec!["a"]),
            (3, vec!["b"]),
            (4, vec!["b"]),
        ] {
            let original = json!({"type":"system","subtype":"init","slash_commands":commands,"session_id":format!("s{seq}")});
            let mut encoded = original.clone();
            lists.encode(&mut encoded, seq);
            if seq == 2 || seq == 4 {
                assert_eq!(encoded[REFS]["slash_commands"], seq - 1);
            }
            reader.decode(&mut encoded, seq).unwrap();
            assert_eq!(encoded, original);
        }
    }

    #[test]
    fn restarted_writer_uses_the_last_material_source_even_when_it_repeated() {
        let event = json!({"type":"system","subtype":"init","tools":["tool"]});
        let mut lists = Lists::default();
        lists.observe(&event, 1);
        lists.observe(&event, 2); // pre-migration, two full copies on disk
        let mut repeat = event;
        lists.encode(&mut repeat, 3);
        assert_eq!(repeat[REFS]["tools"], 2);
        assert!(ListReader::default().decode(&mut repeat, 3).is_err());
    }

    #[test]
    fn result_text_diff_and_failure_origin_survive_without_the_second_payload() {
        let mut event = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"stdout"}]},
            "tool_use_result":{"stdout":"stdout","stderr":"", "originalFile":"large file",
            "filePath":"a.rs","structuredPatch":[{"lines":["+a"]}],"_meta":{"octiq/outcome":{"origin":"octiqflow"}}}});
        assert!(trim_display_only(&mut event));
        assert_eq!(event["message"]["content"][0]["content"], "stdout");
        assert_eq!(
            event["tool_use_result"]["structuredPatch"][0]["lines"][0],
            "+a"
        );
        assert_eq!(
            event["tool_use_result"]["_meta"]["octiq/outcome"]["origin"],
            "octiqflow"
        );
        assert!(event["tool_use_result"].get("stdout").is_none());
        assert!(event["tool_use_result"].get("originalFile").is_none());
        let mut created = json!({"type":"user","message":{"content":[{"type":"tool_result"}]},
            "toolUseResult":{"type":"create","filePath":"x","content":"new file","structuredPatch":[]}});
        assert!(!trim_display_only(&mut created));
        let original = json!({"type":"octiq_question_answered","output":"keep","answer":"yes"});
        let mut answer = original.clone();
        assert!(!trim_display_only(&mut answer));
        assert_eq!(answer, original);
    }

    #[test]
    fn only_a_valid_noop_range_moves_the_logical_cursor() {
        assert_eq!(
            span(br#"{"type":"octiq_compacted","count":123,"into":1}"#),
            123
        );
        for line in [
            br#"{"type":"assistant","count":123}"#.as_slice(),
            br#"{"type":"octiq_compacted","count":0}"#,
            br#"{"type":"octiq_compacted","count":99999999999999}"#,
        ] {
            assert_eq!(span(line), 1);
        }
    }
}

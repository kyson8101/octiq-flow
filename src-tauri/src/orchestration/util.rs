use super::*;

pub(crate) fn model_id(agent: ChatAgent, model: Option<&str>) -> String {
    let provider = match agent {
        ChatAgent::Claude => "claude",
        ChatAgent::Codex => "codex",
        ChatAgent::Pi => "pi",
        ChatAgent::Antigravity => "antigravity",
    };
    let Some(model) = model.filter(|model| !model.trim().is_empty()) else {
        return format!("{provider}:default");
    };
    let known = match (agent, model) {
        (ChatAgent::Claude, "opus" | "sonnet" | "haiku" | "fable") => Some(model),
        (ChatAgent::Codex, "gpt-6-astra") => Some("astra"),
        (ChatAgent::Codex, "gpt-5.6-sol") => Some("sol"),
        (ChatAgent::Codex, "gpt-5.6-terra") => Some("terra"),
        (ChatAgent::Codex, "gpt-5.6-luna") => Some("luna"),
        (ChatAgent::Pi, "gpt-6-astra") => Some("astra"),
        (ChatAgent::Pi, "gpt-5.6-sol") => Some("sol"),
        (ChatAgent::Pi, "gpt-5.6-terra") => Some("terra"),
        (ChatAgent::Pi, "gpt-5.6-luna") => Some("luna"),
        _ => None,
    };
    known.map_or_else(
        || format!("{provider}:model:{}", percent_encode(model)),
        |name| format!("{provider}:{name}"),
    )
}

pub(super) fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

pub(crate) fn access_id(access: Access) -> &'static str {
    match access {
        Access::Read => "read",
        Access::Manual => "manual",
        Access::Edits => "edits",
        Access::Auto => "auto",
        Access::Full => "full",
    }
}

pub(super) fn clean_files(files: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    files
        .into_iter()
        .filter_map(|file| {
            let file = file.trim().to_string();
            (!file.is_empty() && file.len() <= 8_192 && seen.insert(file.clone())).then_some(file)
        })
        .take(500)
        .collect()
}

pub(super) fn required_text(label: &str, value: String, max: usize) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(format!("The {label} is required."));
    }
    if value.len() > max {
        return Err(format!(
            "The {label} is too long: {} UTF-8 bytes; the limit is {max} UTF-8 bytes.",
            value.len()
        ));
    }
    Ok(value)
}

pub(super) fn validate_chat_key(key: &str) -> Result<(), String> {
    if key
        .strip_prefix("chat:")
        .is_some_and(|id| !id.is_empty() && id.len() <= 256)
    {
        Ok(())
    } else {
        Err("A valid OctiqFlow chat is required.".into())
    }
}

pub(super) fn compact_id() -> String {
    Uuid::new_v4().simple().to_string()
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

pub(super) fn sibling_temp(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("orchestrations.json");
    path.with_file_name(format!(".{name}.{}.tmp", compact_id()))
}

pub(super) fn announce(run_id: &str, change: &str) {
    crate::bus::emit(
        "orchestration-changed",
        json!({ "runId": run_id, "change": change }),
    );
}

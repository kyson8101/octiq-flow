// Agent session resume. Lets a restored terminal tab re-attach to the AI agent
// session it was running before the app restarted (today: Claude Code).
//
// The live agent process cannot survive a restart (see terminal_layout.rs), so
// we do what cmux does: capture the agent's own session id while it runs, then
// on restore launch the agent with its native resume command and that id —
// `claude --resume <session-id>` — in the same tab.
//
// Capture happens OUTSIDE this process: a Claude hook (claude-session-capture.cjs)
// runs on SessionStart/SessionEnd and writes a tab -> session map to a shared
// JSON store. We only READ that store here (to build the resume command) and
// PRUNE it (to drop tabs that no longer exist). The hook is the only writer at
// runtime; `setup_agent_hooks` installs it into ~/.claude/settings.json.
//
// Store: ~/.octiqflow/agent-sessions.json, keyed by each tab's stable persistKey:
//   { "<persistKey>": { "agent": "claude", "sessionId": "...", "cwd": "...", "updatedAt": "..." } }
// A fixed ~/.octiqflow path (not the Tauri app-data dir) is used so the external
// hook can find the same file without knowing the app's bundle id.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::pty::PtyManager;

/// The hook script shipped in the repo, embedded so `setup_agent_hooks` can
/// write it to a stable per-user path that outlives any one app install. One
/// script serves every agent; the agent name is passed as its first argument.
const HOOK_SCRIPT: &str = include_str!("../../scripts/hooks/agent-session-capture.cjs");

/// File name the embedded script is written to under ~/.octiqflow/hooks.
const HOOK_SCRIPT_NAME: &str = "agent-session-capture.cjs";

/// Substring that identifies one of our hook entries inside an agent's hook
/// config, so install is idempotent: existing entries that mention it are
/// replaced, never duplicated. It is the shared suffix of every version of the
/// script's name, so it also matches (and so cleans up) an entry installed by an
/// earlier, differently-named build.
const HOOK_MARKER: &str = "session-capture.cjs";

/// One captured agent session, as written by the hook. `serde(rename_all)`
/// matches the camelCase the JS hook emits; unknown future fields are ignored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub updated_at: String,
}

// ---- Paths ----------------------------------------------------------------

/// The user's home dir, from HOME (Unix) or USERPROFILE (Windows). `None` when
/// neither is set, in which case every operation here is a safe no-op.
fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// ~/.octiqflow — the shared dir for the session store and the installed hook.
fn octiqflow_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".octiqflow"))
}

/// Path of the tab -> session store the hook writes and we read.
fn store_path() -> Option<PathBuf> {
    octiqflow_dir().map(|d| d.join("agent-sessions.json"))
}

/// Path of Claude Code's user settings file, where the hook is installed.
fn claude_settings_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".claude").join("settings.json"))
}

/// Path of Codex CLI's user hooks file, where the hook is installed. Codex reads
/// hooks from ~/.codex/hooks.json (same JSON shape as Claude's settings `hooks`).
fn codex_hooks_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".codex").join("hooks.json"))
}

// ---- Pure helpers (unit-tested) -------------------------------------------

/// A session id we are willing to put on a command line. Claude ids are
/// uuid-like; this rejects anything with shell-meaningful or control bytes, so a
/// tampered store can never inject a second command. Mirrors the hook's check.
fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Build the resume command for a captured session, or `None` when the agent is
/// unknown or its id is unsafe. The command SHAPE is fixed here (not taken from
/// the store), so only the validated id is interpolated — defence in depth even
/// if the store file is edited by hand.
fn build_resume_cmd(entry: &SessionEntry) -> Option<String> {
    if !is_safe_session_id(&entry.session_id) {
        return None;
    }
    match entry.agent.as_str() {
        "claude" => Some(format!("claude --resume {}", entry.session_id)),
        "codex" => Some(format!("codex resume {}", entry.session_id)),
        _ => None,
    }
}

/// Drop the mappings of tabs whose agent has exited. `running_by_key` maps each
/// LIVE tab's persist key to whether its agent is still the foreground process;
/// a key present with `false` (agent exited, shell back at the prompt) is
/// removed. A key ABSENT from the map has no live session this run — a closed
/// tab, or one not yet restored — so it is left untouched (the layout reconcile
/// owns closed-tab cleanup, and a not-yet-restored mapping must survive). Returns
/// whether anything was removed. This is how a Codex tab, which has no
/// SessionEnd hook, still stops resuming once the user exits the agent.
fn drop_exited(
    store: &mut HashMap<String, SessionEntry>,
    running_by_key: &HashMap<String, bool>,
) -> bool {
    let before = store.len();
    store.retain(|key, _| running_by_key.get(key) != Some(&false));
    store.len() != before
}

/// Insert (or replace) our hook command under one settings event. Any existing
/// entry whose command mentions `marker` is dropped first, so calling this twice
/// yields exactly one entry — install stays idempotent and self-updating.
fn upsert_event(settings: &mut Value, event: &str, command: &str, marker: &str) {
    let hooks = settings
        .as_object_mut()
        .expect("settings root must be an object")
        .entry("hooks")
        .or_insert_with(|| json!({}));
    let hooks_obj = match hooks.as_object_mut() {
        Some(o) => o,
        None => {
            // `hooks` was some non-object; reset it to a clean map.
            *hooks = json!({});
            hooks.as_object_mut().unwrap()
        }
    };
    let arr = hooks_obj
        .entry(event)
        .or_insert_with(|| json!([]))
        .as_array_mut();
    let Some(arr) = arr else {
        // The event held a non-array; replace it with a fresh one.
        hooks_obj.insert(event.to_string(), json!([fresh_entry(command)]));
        return;
    };
    arr.retain(|entry| !entry_mentions(entry, marker));
    arr.push(fresh_entry(command));
}

/// One settings hook entry that runs `command` for every occurrence of the event
/// (no matcher = all sources).
fn fresh_entry(command: &str) -> Value {
    json!({ "hooks": [ { "type": "command", "command": command } ] })
}

/// Whether a settings hook entry's inner commands mention `marker` (i.e. it is
/// one we installed before).
fn entry_mentions(entry: &Value, marker: &str) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|inner| {
            inner.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(marker))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Shell-quote a path for a hook command. We only ever pass paths under the
/// user's home; double-quoting handles spaces, and a literal `"` (not expected
/// in a home path) is backslash-escaped so the quoting can't be broken.
fn quote_path(path: &str) -> String {
    format!("\"{}\"", path.replace('"', "\\\""))
}

// ---- Store I/O ------------------------------------------------------------

/// Load the whole tab -> session map, or an empty map on any error.
fn load_store() -> std::collections::HashMap<String, SessionEntry> {
    store_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

// ---- Commands -------------------------------------------------------------

/// The resume command for a tab's persist key, or `None` when no live agent
/// session was captured for it. The frontend passes the result as a restored
/// terminal's `startCmd`, so a Claude tab re-attaches to its old conversation.
#[tauri::command]
pub fn agent_resume_cmd(key: String) -> Option<String> {
    load_store().get(&key).and_then(build_resume_cmd)
}

/// Drop store entries whose tab no longer exists. Called from the terminal-layout
/// reconcile so the store can never outgrow the set of live tabs (e.g. a tab was
/// closed while its agent was still running, so the hook never removed it).
pub fn prune(live: &HashSet<String>) {
    let mut store = load_store();
    let before = store.len();
    store.retain(|k, _| live.contains(k));
    if store.len() == before {
        return; // nothing orphaned; skip the write
    }
    if let Some(path) = store_path() {
        if let Ok(raw) = serde_json::to_string_pretty(&store) {
            let _ = fs::write(path, raw);
        }
    }
}

/// Clear the resume mapping of every tab whose agent has exited (its PTY's
/// foreground is back to the shell). The frontend calls this on a timer and at
/// app close, so a tab where the user finished the agent — then left the tab
/// open — does NOT resume on the next launch. This gives Codex the same
/// "finished means no resume" behaviour Claude gets from its SessionEnd hook.
#[tauri::command]
pub fn prune_exited_agent_sessions(manager: State<PtyManager>) {
    let running_by_key = manager.agent_foreground_by_key();
    let mut store = load_store();
    if drop_exited(&mut store, &running_by_key) {
        if let Some(path) = store_path() {
            if let Ok(raw) = serde_json::to_string_pretty(&store) {
                let _ = fs::write(path, raw);
            }
        }
    }
}

/// Read a JSON hook-config file (or start empty), register `command` on each of
/// `events` (idempotent — replaces our own prior entry), and write it back.
/// Unknown keys and other hook events are preserved, so we never clobber the
/// user's existing config. Parent dirs are created as needed.
fn install_hook_into(
    config_path: &std::path::Path,
    events: &[&str],
    command: &str,
) -> Result<(), String> {
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut config: Value = fs::read_to_string(config_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({}));
    if !config.is_object() {
        config = json!({});
    }
    for event in events {
        upsert_event(&mut config, event, command, HOOK_MARKER);
    }
    let raw = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path, raw).map_err(|e| e.to_string())
}

/// Install the session-capture hook for every supported agent: write the shared
/// script to a stable ~/.octiqflow/hooks path, then register it in each agent's
/// hook config (idempotent):
///   - Claude: ~/.claude/settings.json, on SessionStart + SessionEnd.
///   - Codex:  ~/.codex/hooks.json, on SessionStart only (Codex has no
///     SessionEnd event, so a Codex tab keeps its mapping until the tab closes
///     or a newer Codex session replaces it).
/// Returns a short status line for the UI.
#[tauri::command]
pub fn setup_agent_hooks() -> Result<String, String> {
    let dir = octiqflow_dir().ok_or("could not resolve home directory")?;
    let hooks_dir = dir.join("hooks");
    fs::create_dir_all(&hooks_dir).map_err(|e| e.to_string())?;

    let script_path = hooks_dir.join(HOOK_SCRIPT_NAME);
    fs::write(&script_path, HOOK_SCRIPT).map_err(|e| e.to_string())?;
    // Remove the script from an earlier, differently-named build so it cannot
    // linger as a dead file (its config entry is replaced via HOOK_MARKER).
    let _ = fs::remove_file(hooks_dir.join("claude-session-capture.cjs"));

    let script = quote_path(&script_path.to_string_lossy());
    let mut installed: Vec<&str> = Vec::new();

    if let Some(claude) = claude_settings_path() {
        let command = format!("node {script} claude");
        install_hook_into(&claude, &["SessionStart", "SessionEnd"], &command)?;
        installed.push("Claude");
    }
    if let Some(codex) = codex_hooks_path() {
        let command = format!("node {script} codex");
        install_hook_into(&codex, &["SessionStart"], &command)?;
        installed.push("Codex");
    }

    Ok(format!(
        "Resume hook installed for {}. Restart any running session once to start capturing it.",
        installed.join(" and ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(agent: &str, id: &str) -> SessionEntry {
        SessionEntry {
            agent: agent.to_string(),
            session_id: id.to_string(),
            cwd: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn safe_id_accepts_a_uuid_and_rejects_tricks() {
        assert!(is_safe_session_id("3f2a1b9c-0d4e-4a6b-8c2d-1e2f3a4b5c6d"));
        assert!(is_safe_session_id("session_123.v2"));
        assert!(!is_safe_session_id(""));
        assert!(!is_safe_session_id("a b")); // space
        assert!(!is_safe_session_id("a;rm -rf /")); // shell metachar
        assert!(!is_safe_session_id("$(whoami)"));
        assert!(!is_safe_session_id(&"x".repeat(200))); // too long
    }

    #[test]
    fn resume_cmd_is_built_only_for_known_agents_with_safe_ids() {
        assert_eq!(
            build_resume_cmd(&entry("claude", "abc-123")),
            Some("claude --resume abc-123".to_string())
        );
        assert_eq!(
            build_resume_cmd(&entry("codex", "abc-123")),
            Some("codex resume abc-123".to_string())
        );
        // Unknown agent -> no command.
        assert_eq!(build_resume_cmd(&entry("gemini", "abc-123")), None);
        // Unsafe id -> no command even for a known agent.
        assert_eq!(build_resume_cmd(&entry("claude", "a;b")), None);
        assert_eq!(build_resume_cmd(&entry("codex", "$(x)")), None);
    }

    #[test]
    fn upsert_event_adds_then_replaces_without_duplicating() {
        let mut settings = json!({});
        upsert_event(
            &mut settings,
            "SessionStart",
            "node \"/x.cjs\"",
            HOOK_MARKER,
        );
        // Marker is part of the command in real use; emulate that here.
        upsert_event(
            &mut settings,
            "SessionStart",
            "node \"/h/claude-session-capture.cjs\"",
            HOOK_MARKER,
        );
        let arr = settings["hooks"]["SessionStart"].as_array().unwrap();
        // First (no marker) stays; second is the marker entry. Re-running with a
        // marker command must not pile up duplicates:
        let count_before = arr.len();
        upsert_event(
            &mut settings,
            "SessionStart",
            "node \"/h/claude-session-capture.cjs\"",
            HOOK_MARKER,
        );
        let arr = settings["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(arr.len(), count_before); // replaced, not added
        let marker_entries = arr
            .iter()
            .filter(|e| entry_mentions(e, HOOK_MARKER))
            .count();
        assert_eq!(marker_entries, 1);
    }

    #[test]
    fn upsert_event_preserves_unrelated_settings_and_hooks() {
        let mut settings = json!({
            "model": "claude-opus",
            "hooks": { "PreToolUse": [ { "hooks": [ { "type": "command", "command": "echo hi" } ] } ] }
        });
        upsert_event(
            &mut settings,
            "SessionStart",
            "node \"/h/claude-session-capture.cjs\"",
            HOOK_MARKER,
        );
        assert_eq!(settings["model"], json!("claude-opus"));
        assert!(settings["hooks"]["PreToolUse"].is_array());
        assert_eq!(
            settings["hooks"]["SessionStart"].as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn fresh_entry_has_command_type_shape() {
        let e = fresh_entry("node \"/x.cjs\"");
        assert_eq!(e["hooks"][0]["type"], json!("command"));
        assert_eq!(e["hooks"][0]["command"], json!("node \"/x.cjs\""));
    }

    #[test]
    fn quote_path_wraps_and_escapes() {
        assert_eq!(
            quote_path("/Users/me/.octiqflow/hooks/h.cjs"),
            "\"/Users/me/.octiqflow/hooks/h.cjs\""
        );
        assert_eq!(quote_path("/a/b c/h.cjs"), "\"/a/b c/h.cjs\"");
        assert_eq!(quote_path("/a/\"x\".cjs"), "\"/a/\\\"x\\\".cjs\"");
    }

    #[test]
    fn drop_exited_removes_only_keys_whose_agent_has_exited() {
        let mut store: HashMap<String, SessionEntry> = HashMap::new();
        store.insert("running".into(), entry("claude", "id-a"));
        store.insert("exited".into(), entry("codex", "id-b"));
        store.insert("not-restored".into(), entry("claude", "id-c"));

        let mut running_by_key = HashMap::new();
        running_by_key.insert("running".to_string(), true); // agent still foreground
        running_by_key.insert("exited".to_string(), false); // shell back at prompt
                                                            // "not-restored" has no live session this run, so it is absent here.

        let changed = drop_exited(&mut store, &running_by_key);
        assert!(changed);
        assert!(store.contains_key("running")); // kept: still running
        assert!(!store.contains_key("exited")); // dropped: agent exited
        assert!(store.contains_key("not-restored")); // kept: no live session to disprove it
    }

    #[test]
    fn drop_exited_reports_no_change_when_all_alive_or_absent() {
        let mut store: HashMap<String, SessionEntry> = HashMap::new();
        store.insert("a".into(), entry("claude", "id-a"));
        let mut running_by_key = HashMap::new();
        running_by_key.insert("a".to_string(), true);
        assert!(!drop_exited(&mut store, &running_by_key));
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn session_entry_round_trips_camel_case_from_the_hook() {
        let raw = r#"{ "agent": "claude", "sessionId": "s1", "cwd": "/w", "updatedAt": "t" }"#;
        let parsed: SessionEntry = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.agent, "claude");
        assert_eq!(parsed.session_id, "s1");
        assert_eq!(parsed.cwd, "/w");
    }
}

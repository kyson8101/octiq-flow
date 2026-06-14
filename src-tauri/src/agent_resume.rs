// Agent session resume. Lets a restored terminal tab re-attach to the AI agent
// session it was running before the app restarted (today: Claude Code).
//
// The live agent process cannot survive a restart (see terminal_layout.rs), so
// we do what cmux does: capture the agent's own session id while it runs, then
// on restore launch the agent with its native resume command and that id —
// `claude --resume <session-id>` — in the same tab.
//
// Capture happens OUTSIDE this process: an agent hook (agent-session-capture.cjs)
// runs on SessionStart and RECORDS a tab -> session map in a shared JSON store.
// It never deletes — a session ending is not a "forget me" signal, because the
// app kills the agent on every quit. We READ that store here (to build the resume
// command) and own ALL cleanup: `prune` drops tabs that no longer exist, and
// `prune_exited_agent_sessions` drops tabs whose agent the user finished (via the
// PTY's foreground process). `setup_agent_hooks` installs the hook into each
// agent's config; `refresh_hook_script` keeps the on-disk script current.
//
// The SAME hook has a second job: on the agent's Notification event it writes an
// OSC attention sequence to the tab's PTY, so OctiqFlow flags the tab + its
// project + its mode when the agent is waiting for the user — even while the user
// works in another project (see pty.rs `scan_attention` and alerts.js). This
// module registers that event too; `upgrade_agent_hooks_if_present` adds it to
// configs that already opted into the resume hook, so the alert ships without the
// user re-running setup from Settings.
//
// Store: ~/.octiqflow/agent-sessions.json, keyed by each tab's stable persistKey:
//   { "<persistKey>": { "agent": "claude", "sessionId": "...", "cwd": "...", "updatedAt": "..." } }
// A fixed ~/.octiqflow path (not the Tauri app-data dir) is used so the external
// hook can find the same file without knowing the app's bundle id.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

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
    /// Absolute path of the agent's transcript file, when the hook captured it
    /// (Claude passes `transcript_path`). Empty for older entries / agents that
    /// do not pass it — then the title reader derives the path from `cwd`.
    #[serde(default)]
    pub transcript_path: String,
    #[serde(default)]
    pub updated_at: String,
}

/// What a tab's terminal is running, for auto-naming its tab. `is_agent` is true
/// when an AI agent session was captured for this tab (so the tab should follow
/// the agent's title, not its first shell command). `title` is the agent's
/// generated session title when available — `None` until the agent has produced
/// one (it is generated a moment after the first exchange).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTabInfo {
    pub is_agent: bool,
    pub title: Option<String>,
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

/// Longest tab title we keep. Agent titles are a short phrase; this guards
/// against a pathological transcript line bloating a tab. The tab strip
/// ellipsizes anyway, but a bounded string keeps the layout file small.
const MAX_TITLE_LEN: usize = 80;

/// Encode a cwd into Claude's project-dir name: every `/` and `.` becomes `-`.
/// e.g. `/Users/me/dev/app` -> `-Users-me-dev-app`. Used only as a fallback when
/// the hook did not capture the transcript path directly.
fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

/// The transcript file for a captured entry: the hook-provided path when present,
/// else `~/.claude/projects/<enc(cwd)>/<sessionId>.jsonl`. `None` when neither
/// source yields a path (no transcript path, and missing cwd/session id/home).
/// `pub(crate)` so the usage reader can locate the same transcript this module
/// already maps each tab to.
pub(crate) fn transcript_path_for(entry: &SessionEntry) -> Option<PathBuf> {
    if !entry.transcript_path.is_empty() {
        return Some(PathBuf::from(&entry.transcript_path));
    }
    if entry.cwd.is_empty() || entry.session_id.is_empty() {
        return None;
    }
    home_dir().map(|h| {
        h.join(".claude")
            .join("projects")
            .join(encode_project_dir(&entry.cwd))
            .join(format!("{}.jsonl", entry.session_id))
    })
}

/// The latest agent-generated title in a transcript's text, or `None`. Claude
/// writes one JSON object per line; a title line is `{"type":"ai-title",
/// "aiTitle":"..."}` and is rewritten as the conversation evolves, so we keep the
/// LAST non-empty one. We pre-filter on the `aiTitle` substring so only the few
/// title lines are JSON-parsed, not every message line. The result is trimmed and
/// length-capped for use as a tab label.
fn latest_ai_title(contents: &str) -> Option<String> {
    let mut found: Option<String> = None;
    for line in contents.lines() {
        if !line.contains("aiTitle") {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if obj.get("type").and_then(|t| t.as_str()) != Some("ai-title") {
            continue;
        }
        if let Some(title) = obj.get("aiTitle").and_then(|t| t.as_str()) {
            let trimmed = title.trim();
            if !trimmed.is_empty() {
                found = Some(cap_title(trimmed));
            }
        }
    }
    found
}

/// Trim a title to `MAX_TITLE_LEN` chars (not bytes), so the cut is always on a
/// char boundary even for multi-byte titles.
fn cap_title(title: &str) -> String {
    if title.chars().count() <= MAX_TITLE_LEN {
        return title.to_string();
    }
    title.chars().take(MAX_TITLE_LEN).collect()
}

/// Cache of `path -> (mtime, last title)` so an unchanged transcript is not
/// re-parsed every poll. The frontend polls every few seconds per agent tab; a
/// finished agent's transcript never changes, so this turns that into a cheap
/// metadata stat instead of a full read + scan.
fn title_cache() -> &'static Mutex<HashMap<PathBuf, (SystemTime, Option<String>)>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (SystemTime, Option<String>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The latest agent title for a transcript file, reading it only when its mtime
/// changed since the last read. Any IO error -> `None` (the tab keeps its current
/// name). A poisoned cache lock is recovered into, so one panic cannot wedge
/// titles for the rest of the session.
fn read_title_cached(path: &PathBuf) -> Option<String> {
    let mtime = fs::metadata(path).and_then(|m| m.modified()).ok()?;
    let mut cache = title_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((cached_mtime, cached_title)) = cache.get(path) {
        if *cached_mtime == mtime {
            return cached_title.clone();
        }
    }
    let title = fs::read_to_string(path)
        .ok()
        .and_then(|raw| latest_ai_title(&raw));
    cache.insert(path.clone(), (mtime, title.clone()));
    title
}

/// Drop the mappings of tabs whose agent has exited. `running_by_key` maps each
/// LIVE tab's persist key to whether its agent is still the foreground process;
/// a key present with `false` (agent exited, shell back at the prompt) is
/// removed. A key ABSENT from the map has no live session this run — a closed
/// tab, or one not yet restored — so it is left untouched (the layout reconcile
/// owns closed-tab cleanup, and a not-yet-restored mapping must survive). Returns
/// whether anything was removed. This is the single way a tab stops resuming once
/// the user exits the agent — for every agent, since the hook now records only and
/// never deletes on SessionEnd.
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

/// Remove every hook entry we installed (its command mentions `marker`) from one
/// settings event, and drop the event key entirely if that leaves it empty. Used
/// to retire an event we no longer register on (Claude's SessionEnd) without
/// disturbing the user's own hooks under the same event.
fn remove_event_marker(settings: &mut Value, event: &str, marker: &str) {
    let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return;
    };
    let Some(arr) = hooks.get_mut(event).and_then(|e| e.as_array_mut()) else {
        return;
    };
    arr.retain(|entry| !entry_mentions(entry, marker));
    if arr.is_empty() {
        hooks.remove(event);
    }
}

/// Shell-quote a path for a hook command. We only ever pass paths under the
/// user's home; double-quoting handles spaces, and a literal `"` (not expected
/// in a home path) is backslash-escaped so the quoting can't be broken.
fn quote_path(path: &str) -> String {
    format!("\"{}\"", path.replace('"', "\\\""))
}

// ---- Store I/O ------------------------------------------------------------

/// Load the whole tab -> session map, or an empty map on any error. `pub(crate)`
/// so the usage reader can enumerate the same captured sessions this module owns.
pub(crate) fn load_store() -> std::collections::HashMap<String, SessionEntry> {
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

/// What a tab is running, so the frontend can auto-name the tab: whether an agent
/// session was captured for it, and the agent's current session title when one
/// exists. The frontend uses the title for an agent tab and falls back to the
/// tab's first shell command when `is_agent` is false. Polled per agent tab on a
/// timer; the title read is mtime-cached so a quiet tab costs only a stat.
#[tauri::command]
pub fn agent_tab_info(key: String) -> AgentTabInfo {
    let Some(entry) = load_store().get(&key).cloned() else {
        return AgentTabInfo {
            is_agent: false,
            title: None,
        };
    };
    let title = transcript_path_for(&entry).and_then(|p| read_title_cached(&p));
    AgentTabInfo {
        is_agent: true,
        title,
    }
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
/// open — does NOT resume on the next launch. This is the one "finished means no
/// resume" signal for every agent: the capture hook only records and never
/// deletes (deleting on SessionEnd would wipe a live mapping when the app kills
/// the agent on quit), so this foreground check is what retires exited sessions.
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
/// `install_events` (idempotent — replaces our own prior entry), retire our entry
/// from each of `retire_events` (e.g. a SessionEnd we used to install), and write
/// it back. Unknown keys and the user's own hooks are preserved, so we never
/// clobber the user's existing config. Parent dirs are created as needed.
fn install_hook_into(
    config_path: &std::path::Path,
    install_events: &[&str],
    retire_events: &[&str],
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
    for event in install_events {
        upsert_event(&mut config, event, command, HOOK_MARKER);
    }
    for event in retire_events {
        remove_event_marker(&mut config, event, HOOK_MARKER);
    }
    let raw = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path, raw).map_err(|e| e.to_string())
}

/// Best-effort: rewrite the embedded capture script to its stable on-disk path so
/// the latest hook logic is always live, even when the user has not re-run
/// `setup_agent_hooks` from Settings. Called once at app startup. Touches ONLY the
/// script file under ~/.octiqflow/hooks — never the agents' settings files — so it
/// is safe to run every launch. Any error is ignored (the feature degrades to the
/// previously-installed script).
pub fn refresh_hook_script() {
    let Some(dir) = octiqflow_dir() else {
        return;
    };
    let hooks_dir = dir.join("hooks");
    if fs::create_dir_all(&hooks_dir).is_err() {
        return;
    }
    let _ = fs::write(hooks_dir.join(HOOK_SCRIPT_NAME), HOOK_SCRIPT);
}

/// Whether a hook config already carries one of OUR hook entries (some event's
/// command mentions `marker`). Used to gate the startup upgrade so it only ever
/// touches a config the user already opted into.
fn config_has_marker(config: &Value, marker: &str) -> bool {
    config
        .get("hooks")
        .and_then(|h| h.as_object())
        .map(|events| {
            events.values().any(|arr| {
                arr.as_array()
                    .map(|entries| entries.iter().any(|e| entry_mentions(e, marker)))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Upgrade an agent config that ALREADY has our hook: register `install_events`,
/// retire `retire_events`, and write back — but ONLY when the config already
/// carries our marker (so we never opt the user in behind their back), and only
/// when the upgrade actually changes something (so a steady state never rewrites
/// the file). Reads/parses/IO errors are silent no-ops (best-effort).
fn upgrade_if_present(
    config_path: &std::path::Path,
    install_events: &[&str],
    retire_events: &[&str],
    command: &str,
    marker: &str,
) {
    let Ok(raw) = fs::read_to_string(config_path) else {
        return;
    };
    let Ok(mut config) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    if !config.is_object() || !config_has_marker(&config, marker) {
        return;
    }
    let before = config.clone();
    for event in install_events {
        upsert_event(&mut config, event, command, marker);
    }
    for event in retire_events {
        remove_event_marker(&mut config, event, marker);
    }
    if config == before {
        return; // already up to date; do not rewrite the file
    }
    if let Ok(out) = serde_json::to_string_pretty(&config) {
        let _ = fs::write(config_path, out);
    }
}

/// Startup upgrade of an existing opt-in. For each agent whose config ALREADY has
/// our capture hook, make sure the Notification attention hook is registered too
/// (and retire the old Claude SessionEnd entry an earlier build installed). This
/// lets users who set up the resume hook before get cross-project "agent is
/// waiting" alerts without re-running setup from Settings. It NEVER installs into
/// a config that does not already carry our hook. Best-effort; safe every launch
/// (it only writes when something actually changes). Touches the agents' config
/// files, unlike [`refresh_hook_script`] which only rewrites the script.
pub fn upgrade_agent_hooks_if_present() {
    let Some(dir) = octiqflow_dir() else {
        return;
    };
    let script_path = dir.join("hooks").join(HOOK_SCRIPT_NAME);
    let script = quote_path(&script_path.to_string_lossy());
    if let Some(claude) = claude_settings_path() {
        let command = format!("node {script} claude");
        upgrade_if_present(
            &claude,
            CLAUDE_INSTALL_EVENTS,
            CLAUDE_RETIRE_EVENTS,
            &command,
            HOOK_MARKER,
        );
    }
    if let Some(codex) = codex_hooks_path() {
        let command = format!("node {script} codex");
        upgrade_if_present(
            &codex,
            CODEX_INSTALL_EVENTS,
            CODEX_RETIRE_EVENTS,
            &command,
            HOOK_MARKER,
        );
    }
}

/// The hook events we register, by agent. The shared script branches on the
/// event: SessionStart records the resume mapping; Notification raises an
/// attention alert when the agent waits for the user. We deliberately do NOT
/// register SessionEnd: the app kills the agent on quit, so a SessionEnd delete
/// would wipe the mapping we need to resume — finished-session cleanup is
/// deterministic instead (`prune_exited_agent_sessions`). Codex has no SessionEnd
/// event, so it carries nothing to retire.
const CLAUDE_INSTALL_EVENTS: &[&str] = &["SessionStart", "Notification"];
const CLAUDE_RETIRE_EVENTS: &[&str] = &["SessionEnd"];
const CODEX_INSTALL_EVENTS: &[&str] = &["SessionStart", "Notification"];
const CODEX_RETIRE_EVENTS: &[&str] = &[];

/// Install the OctiqFlow agent hook for every supported agent: write the shared
/// script to a stable ~/.octiqflow/hooks path, then register it on each agent's
/// SessionStart (resume capture) and Notification (attention alert) events
/// (idempotent). Any SessionEnd entry an older build installed is retired here,
/// so re-running setup tidies it up.
///   - Claude: ~/.claude/settings.json — register SessionStart + Notification,
///     retire SessionEnd.
///   - Codex:  ~/.codex/hooks.json — register SessionStart + Notification (Codex
///     has no SessionEnd event). Notification is best-effort: if Codex does not
///     fire it, the entry is inert and harmless.
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
        install_hook_into(
            &claude,
            CLAUDE_INSTALL_EVENTS,
            CLAUDE_RETIRE_EVENTS,
            &command,
        )?;
        installed.push("Claude");
    }
    if let Some(codex) = codex_hooks_path() {
        let command = format!("node {script} codex");
        install_hook_into(&codex, CODEX_INSTALL_EVENTS, CODEX_RETIRE_EVENTS, &command)?;
        installed.push("Codex");
    }

    Ok(format!(
        "Resume + attention hooks installed for {}. Restart any running session once to start capturing it.",
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
            transcript_path: String::new(),
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
    fn remove_event_marker_drops_our_entry_and_empties_the_event() {
        let mut settings = json!({
            "hooks": {
                "SessionEnd": [ { "hooks": [ { "type": "command", "command": "node \"/h/agent-session-capture.cjs\" claude" } ] } ],
                "SessionStart": [ { "hooks": [ { "type": "command", "command": "node \"/h/agent-session-capture.cjs\" claude" } ] } ]
            }
        });
        remove_event_marker(&mut settings, "SessionEnd", HOOK_MARKER);
        // SessionEnd held only our entry, so the whole event key is gone now.
        assert!(settings["hooks"].get("SessionEnd").is_none());
        // SessionStart is untouched.
        assert!(settings["hooks"]["SessionStart"].is_array());
    }

    #[test]
    fn remove_event_marker_keeps_the_users_own_entries() {
        let mut settings = json!({
            "hooks": {
                "SessionEnd": [
                    { "hooks": [ { "type": "command", "command": "echo bye" } ] },
                    { "hooks": [ { "type": "command", "command": "node \"/h/agent-session-capture.cjs\" claude" } ] }
                ]
            }
        });
        remove_event_marker(&mut settings, "SessionEnd", HOOK_MARKER);
        let arr = settings["hooks"]["SessionEnd"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["hooks"][0]["command"], json!("echo bye"));
    }

    #[test]
    fn remove_event_marker_is_a_no_op_when_absent() {
        let mut settings = json!({ "model": "x", "hooks": { "PreToolUse": [] } });
        remove_event_marker(&mut settings, "SessionEnd", HOOK_MARKER);
        assert_eq!(settings["model"], json!("x"));
    }

    #[test]
    fn config_has_marker_detects_our_entry_and_ignores_others() {
        let with = json!({
            "hooks": {
                "SessionStart": [ { "hooks": [ { "type": "command", "command": "node \"/h/agent-session-capture.cjs\" claude" } ] } ]
            }
        });
        assert!(config_has_marker(&with, HOOK_MARKER));

        // Only the user's own hooks -> not ours.
        let without = json!({
            "hooks": {
                "SessionStart": [ { "hooks": [ { "type": "command", "command": "bash diary.sh" } ] } ]
            }
        });
        assert!(!config_has_marker(&without, HOOK_MARKER));

        // No hooks at all.
        assert!(!config_has_marker(&json!({ "model": "x" }), HOOK_MARKER));
    }

    #[test]
    fn upgrade_transform_adds_notification_and_retires_session_end() {
        // Emulate upgrade_if_present's in-memory transform on a config that
        // already has our SessionStart + a stale SessionEnd, alongside the
        // user's own diary hook. The result must add Notification, drop the
        // stale SessionEnd, and never duplicate or clobber the user's hook.
        let mut config = json!({
            "hooks": {
                "SessionStart": [
                    { "hooks": [ { "type": "command", "command": "bash diary.sh" } ] },
                    { "hooks": [ { "type": "command", "command": "node \"/h/agent-session-capture.cjs\" claude" } ] }
                ],
                "SessionEnd": [
                    { "hooks": [ { "type": "command", "command": "node \"/h/agent-session-capture.cjs\" claude" } ] }
                ]
            }
        });
        assert!(config_has_marker(&config, HOOK_MARKER));
        let command = "node \"/h/agent-session-capture.cjs\" claude";
        for event in CLAUDE_INSTALL_EVENTS {
            upsert_event(&mut config, event, command, HOOK_MARKER);
        }
        for event in CLAUDE_RETIRE_EVENTS {
            remove_event_marker(&mut config, event, HOOK_MARKER);
        }

        // SessionEnd held only our stale entry, so the whole event key is gone.
        assert!(config["hooks"].get("SessionEnd").is_none());
        // Notification now carries exactly one of our entries.
        let notif = config["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 1);
        assert!(entry_mentions(&notif[0], HOOK_MARKER));
        // SessionStart keeps the user's diary hook + exactly one of ours.
        let start = config["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(start.len(), 2);
        let ours = start
            .iter()
            .filter(|e| entry_mentions(e, HOOK_MARKER))
            .count();
        assert_eq!(ours, 1);

        // Re-running the same transform is a no-op (idempotent: no growth).
        let stable = config.clone();
        for event in CLAUDE_INSTALL_EVENTS {
            upsert_event(&mut config, event, command, HOOK_MARKER);
        }
        for event in CLAUDE_RETIRE_EVENTS {
            remove_event_marker(&mut config, event, HOOK_MARKER);
        }
        assert_eq!(config, stable);
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
        let raw = r#"{ "agent": "claude", "sessionId": "s1", "cwd": "/w", "transcriptPath": "/t.jsonl", "updatedAt": "t" }"#;
        let parsed: SessionEntry = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.agent, "claude");
        assert_eq!(parsed.session_id, "s1");
        assert_eq!(parsed.cwd, "/w");
        assert_eq!(parsed.transcript_path, "/t.jsonl");
        // An older entry without the field still parses (defaults to empty).
        let old = r#"{ "agent": "claude", "sessionId": "s1" }"#;
        let parsed_old: SessionEntry = serde_json::from_str(old).unwrap();
        assert_eq!(parsed_old.transcript_path, "");
    }

    #[test]
    fn encode_project_dir_maps_slash_and_dot_to_dash() {
        assert_eq!(
            encode_project_dir("/Users/me/Developer/octiq-flow"),
            "-Users-me-Developer-octiq-flow"
        );
        // Dots in a segment (e.g. a hidden dir) also become dashes, matching how
        // Claude names its project transcript folders.
        assert_eq!(
            encode_project_dir("/Users/me/.claude/app"),
            "-Users-me--claude-app"
        );
    }

    #[test]
    fn transcript_path_prefers_the_captured_path() {
        let mut e = entry("claude", "sess-1");
        e.transcript_path = "/tmp/explicit.jsonl".to_string();
        assert_eq!(
            transcript_path_for(&e),
            Some(PathBuf::from("/tmp/explicit.jsonl"))
        );
    }

    #[test]
    fn latest_ai_title_keeps_the_last_nonempty_title() {
        let jsonl = concat!(
            r#"{"type":"user","message":{"content":"hi"}}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"First guess","sessionId":"s"}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":"ok"}}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"Refined title","sessionId":"s"}"#,
            "\n",
        );
        assert_eq!(latest_ai_title(jsonl), Some("Refined title".to_string()));
    }

    #[test]
    fn latest_ai_title_is_none_without_a_title_line() {
        let jsonl = concat!(
            r#"{"type":"user","message":{"content":"hi"}}"#,
            "\n",
            r#"{"type":"summary","summary":"not an ai-title"}"#,
        );
        assert_eq!(latest_ai_title(jsonl), None);
        // A line that merely mentions aiTitle in text but is not a title entry is
        // ignored (pre-filter matches, type check rejects).
        let decoy = r#"{"type":"assistant","message":{"content":"set aiTitle later"}}"#;
        assert_eq!(latest_ai_title(decoy), None);
    }

    #[test]
    fn cap_title_trims_on_a_char_boundary() {
        let short = "Add agent quick spawn";
        assert_eq!(cap_title(short), short);
        let long: String = "あ".repeat(MAX_TITLE_LEN + 10);
        let capped = cap_title(&long);
        assert_eq!(capped.chars().count(), MAX_TITLE_LEN);
    }
}

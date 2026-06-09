// Terminal session persistence. Saves enough of each PROJECT's terminals to
// rebuild them after the app restarts: the ordered tab list (title + working
// dir) and each terminal's scrollback (its past output text).
//
// The live shell process cannot survive a restart, so this never tries to keep
// it. On restore the frontend opens a FRESH shell per tab and writes the saved
// scrollback into the terminal first, so the user sees the old output above the
// new prompt.
//
// Two stores, by data shape (see decision in the layout-persistence work):
//   - terminal_layout.json  — the small tab index, `projectId -> [TermEntry]`.
//     Read-modify-write of the whole file, exactly like `workspaces.rs`.
//   - scrollback/<key>.txt   — one capped blob file per terminal. Scrollback can
//     be large and is only ever read/written whole by key, so a flat file fits
//     better than stuffing it into the JSON.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// Hard upper bound on a saved scrollback blob. Only the most recent
/// `SCROLLBACK_CAP` bytes are kept (the tail), so a long-running terminal can
/// never grow its file without bound. 512 KiB holds a generous history while
/// staying cheap to write and read.
const SCROLLBACK_CAP: usize = 512 * 1024;

/// One persisted terminal in a project's tab strip: its stable storage key, the
/// tab title, and the working dir the shell was opened in. `persist_key` names
/// the matching `scrollback/<persist_key>.txt` file and is generated once by the
/// frontend (a UUID), so it is stable across restarts even though the live PTY
/// id is not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermEntry {
    pub persist_key: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cwd: String,
}

/// The on-disk shape of `terminal_layout.json`: each project id maps to its
/// ordered terminals. `#[serde(default)]` so a missing file or an older file
/// without the field loads as an empty map instead of failing.
#[derive(Debug, Default, Serialize, Deserialize)]
struct LayoutData {
    #[serde(default)]
    projects: HashMap<String, Vec<TermEntry>>,
}

/// In-memory layout map plus the paths it persists to.
pub struct TerminalLayoutState {
    data: Mutex<LayoutData>,
    file: PathBuf,
    scrollback_dir: PathBuf,
}

impl TerminalLayoutState {
    /// Load the layout index from disk and ensure the scrollback dir exists. A
    /// missing or unreadable file starts an empty store rather than failing the
    /// whole app, matching `WorkspaceState::load`.
    pub fn load(app: &AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .expect("app data dir should resolve");
        let _ = fs::create_dir_all(&dir);
        let scrollback_dir = dir.join("scrollback");
        let _ = fs::create_dir_all(&scrollback_dir);
        let file = dir.join("terminal_layout.json");
        let data = fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<LayoutData>(&raw).ok())
            .unwrap_or_default();
        Self {
            data: Mutex::new(data),
            file,
            scrollback_dir,
        }
    }

    /// Write the current layout index back to disk as pretty JSON.
    fn save(&self, data: &LayoutData) -> Result<(), String> {
        let raw = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        fs::write(&self.file, raw).map_err(|e| e.to_string())
    }
}

// ---- Pure helpers (unit-tested below) -------------------------------------

/// Return the last `cap` bytes of `data`, moved forward to the next UTF-8 char
/// boundary so the result is always valid UTF-8. Returns `data` unchanged when
/// it is already within the cap. Trimming from the FRONT keeps the most recent
/// output, which is what the user wants to see on restore. Mirrors the
/// char-boundary handling in `pty.rs`.
fn cap_scrollback_bytes(data: &str, cap: usize) -> &str {
    if data.len() <= cap {
        return data;
    }
    let mut start = data.len() - cap;
    while start < data.len() && !data.is_char_boundary(start) {
        start += 1;
    }
    &data[start..]
}

/// A persist key is used directly as a file stem under `scrollback/`, so it must
/// not let a caller escape that directory or write anywhere else. Keys the
/// frontend generates are UUIDs; this rejects anything that is not a plain,
/// single-segment name (no separators, no `..`, no control bytes, not empty).
fn is_safe_key(key: &str) -> bool {
    !key.is_empty()
        && key != ".."
        && !key
            .chars()
            .any(|c| c == '/' || c == '\\' || c == '\0' || c.is_control())
}

/// Path of a terminal's scrollback file, or `None` if the key is unsafe.
fn scrollback_path(dir: &Path, key: &str) -> Option<PathBuf> {
    if is_safe_key(key) {
        Some(dir.join(format!("{key}.txt")))
    } else {
        None
    }
}

/// Keys whose scrollback file should be deleted: every existing file stem that
/// is no longer referenced by any live terminal. Pure set-difference so it can
/// be tested without touching the filesystem.
fn orphan_keys(live: &HashSet<String>, existing: &[String]) -> Vec<String> {
    existing
        .iter()
        .filter(|k| !live.contains(*k))
        .cloned()
        .collect()
}

/// The persist keys of every `*.txt` file currently in the scrollback dir.
fn existing_scrollback_keys(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) == Some("txt") {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Delete every scrollback file whose key is not in `live`. Best effort: a
/// failed delete is ignored (the file will be retried on the next reconcile).
fn reconcile_scrollback(dir: &Path, live: &HashSet<String>) {
    let existing = existing_scrollback_keys(dir);
    for key in orphan_keys(live, &existing) {
        if let Some(path) = scrollback_path(dir, &key) {
            let _ = fs::remove_file(path);
        }
    }
}

/// Every persist key referenced by any project, as a set (for reconcile).
fn live_keys(data: &LayoutData) -> HashSet<String> {
    data.projects
        .values()
        .flatten()
        .map(|t| t.persist_key.clone())
        .collect()
}

// ---- Commands -------------------------------------------------------------

/// Replace a project's whole terminal layout and save. An empty `terminals`
/// removes the project from the index (its tabs were all closed). After saving,
/// reconcile the scrollback dir so any terminal that vanished from the index has
/// its blob file deleted — this is the single authoritative cleanup point.
#[tauri::command]
pub fn save_terminal_layout(
    state: State<TerminalLayoutState>,
    project_id: String,
    terminals: Vec<TermEntry>,
) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    if terminals.is_empty() {
        data.projects.remove(&project_id);
    } else {
        data.projects.insert(project_id, terminals);
    }
    state.save(&data)?;
    let live = live_keys(&data);
    reconcile_scrollback(&state.scrollback_dir, &live);
    // Drop any captured agent session whose tab no longer exists (e.g. a tab was
    // closed while its agent still ran, so the hook never removed it).
    crate::agent_resume::prune(&live);
    Ok(())
}

/// Return the whole layout index: every project id with its ordered terminals.
/// Called once by the frontend on boot to drive restore.
#[tauri::command]
pub fn load_terminal_layouts(
    state: State<TerminalLayoutState>,
) -> Result<HashMap<String, Vec<TermEntry>>, String> {
    let data = state.data.lock().map_err(|e| e.to_string())?;
    Ok(data.projects.clone())
}

/// Save one terminal's scrollback blob, capped to the most recent
/// `SCROLLBACK_CAP` bytes. An unsafe key is rejected so a blob can never be
/// written outside the scrollback dir.
#[tauri::command]
pub fn save_scrollback(
    state: State<TerminalLayoutState>,
    key: String,
    data: String,
) -> Result<(), String> {
    let path = scrollback_path(&state.scrollback_dir, &key).ok_or("invalid scrollback key")?;
    let capped = cap_scrollback_bytes(&data, SCROLLBACK_CAP);
    fs::write(path, capped).map_err(|e| e.to_string())
}

/// Load one terminal's scrollback blob, or `None` if there is none (or the key
/// is unsafe / the file is unreadable). Never errors the restore.
#[tauri::command]
pub fn load_scrollback(state: State<TerminalLayoutState>, key: String) -> Option<String> {
    let path = scrollback_path(&state.scrollback_dir, &key)?;
    fs::read_to_string(path).ok()
}

/// Remove a project from the index entirely and delete all of its terminals'
/// scrollback files. Called when a project is deleted, so nothing is left
/// behind. Reconcile (against the now-smaller index) does the file deletes.
#[tauri::command]
pub fn clear_project_layout(
    state: State<TerminalLayoutState>,
    project_id: String,
) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    data.projects.remove(&project_id);
    state.save(&data)?;
    let live = live_keys(&data);
    reconcile_scrollback(&state.scrollback_dir, &live);
    crate::agent_resume::prune(&live);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_returns_short_input_unchanged() {
        assert_eq!(cap_scrollback_bytes("hello", 1024), "hello");
        assert_eq!(cap_scrollback_bytes("", 1024), "");
    }

    #[test]
    fn cap_keeps_the_recent_tail() {
        let data = "0123456789";
        // Keep the last 4 bytes.
        assert_eq!(cap_scrollback_bytes(data, 4), "6789");
    }

    #[test]
    fn cap_result_is_valid_utf8_on_a_multibyte_boundary() {
        // "日" is 3 bytes. A naive byte cut could land mid-character; the helper
        // must advance to the next char boundary so the slice is valid UTF-8.
        let data = "日本語"; // 9 bytes
        let capped = cap_scrollback_bytes(data, 4);
        // 4-byte tail starts mid-"本"; boundary advance drops it, leaving "語".
        assert_eq!(capped, "語");
        assert!(capped.chars().count() >= 1);
    }

    #[test]
    fn safe_key_accepts_a_uuid() {
        assert!(is_safe_key("3f2a1b9c-0d4e-4a6b-8c2d-1e2f3a4b5c6d"));
    }

    #[test]
    fn safe_key_rejects_path_tricks_and_control_bytes() {
        assert!(!is_safe_key(""));
        assert!(!is_safe_key(".."));
        assert!(!is_safe_key("a/b"));
        assert!(!is_safe_key("a\\b"));
        assert!(!is_safe_key("../escape"));
        assert!(!is_safe_key("a\0b"));
        assert!(!is_safe_key("a\nb"));
    }

    #[test]
    fn scrollback_path_is_none_for_unsafe_key() {
        let dir = Path::new("/tmp/scrollback");
        assert!(scrollback_path(dir, "../x").is_none());
        assert_eq!(
            scrollback_path(dir, "abc"),
            Some(PathBuf::from("/tmp/scrollback/abc.txt"))
        );
    }

    #[test]
    fn orphan_keys_are_those_not_in_the_live_set() {
        let live: HashSet<String> = ["a".to_string(), "c".to_string()].into_iter().collect();
        let existing = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let mut orphans = orphan_keys(&live, &existing);
        orphans.sort();
        assert_eq!(orphans, vec!["b".to_string()]);
    }

    #[test]
    fn layout_data_round_trips_through_json() {
        let mut data = LayoutData::default();
        data.projects.insert(
            "proj-1".to_string(),
            vec![TermEntry {
                persist_key: "k1".to_string(),
                title: "term 1".to_string(),
                cwd: "/work".to_string(),
            }],
        );
        let raw = serde_json::to_string(&data).unwrap();
        let back: LayoutData = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.projects, data.projects);
    }

    #[test]
    fn layout_data_defaults_when_fields_missing_or_unknown() {
        // Empty object -> empty map (missing `projects`).
        let empty: LayoutData = serde_json::from_str("{}").unwrap();
        assert!(empty.projects.is_empty());
        // Unknown extra fields are ignored (forward compat), and a TermEntry
        // with only persist_key fills title/cwd from defaults.
        let raw = r#"{ "projects": { "p": [ { "persistKey": "k" } ] }, "future": 1 }"#;
        let parsed: LayoutData = serde_json::from_str(raw).unwrap();
        let entry = &parsed.projects["p"][0];
        assert_eq!(entry.persist_key, "k");
        assert_eq!(entry.title, "");
        assert_eq!(entry.cwd, "");
    }

    #[test]
    fn live_keys_collects_across_all_projects() {
        let mut data = LayoutData::default();
        data.projects.insert(
            "p1".to_string(),
            vec![TermEntry {
                persist_key: "a".into(),
                title: String::new(),
                cwd: String::new(),
            }],
        );
        data.projects.insert(
            "p2".to_string(),
            vec![TermEntry {
                persist_key: "b".into(),
                title: String::new(),
                cwd: String::new(),
            }],
        );
        let keys = live_keys(&data);
        assert!(keys.contains("a"));
        assert!(keys.contains("b"));
        assert_eq!(keys.len(), 2);
    }
}

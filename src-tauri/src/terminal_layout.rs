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
use tauri::State;

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
    /// True once the user has renamed this tab by hand. The auto-rename poller
    /// (agent title / first command) skips a manual tab, so the user's chosen
    /// name survives both the next poll and a restart.
    #[serde(default)]
    pub title_manual: bool,
    /// This terminal's own notification choice, set from its tab's right-click
    /// menu (card 43): `Some(true)` watch it, `Some(false)` silence it, `None`
    /// (the default, and what an older layout file reads as) follow the global
    /// `statusMonitoring` setting. A terminal's own choice wins over the
    /// setting, in both directions.
    #[serde(default)]
    pub notify: Option<bool>,
    /// Split view (card 42): `Some("row")` / `Some("col")` marks THIS tab as the
    /// second pane of a split and says how the area was cut; `None` (and any
    /// older layout file) means it is an ordinary tab. At most one entry per
    /// project carries it.
    #[serde(default)]
    pub split: Option<String>,
    /// True on the tab that shared the screen with the `split` one — the first
    /// pane. Meaningless on its own: the frontend only restores a split when it
    /// finds BOTH halves, so a layout missing either one comes back unsplit.
    #[serde(default)]
    pub primary: bool,
}

/// One node of a project's pane tree (card 47) — the arrangement of panes the
/// terminal area is split into, mirroring the frontend's tree in `terminals.js`.
///
/// Leaves hold `persist_key`s, never live pty ids: the pty id is regenerated on
/// every launch, so only the stable key can survive a restart. The tag and the
/// field names must match what the frontend writes (`{ type: "split" | "pane" }`)
/// or a saved tree cannot be read back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PaneNode {
    /// Two or more child nodes sharing a box, cut `dir` ("row" | "col").
    /// `ratio` is the share given to the first child.
    Split {
        dir: String,
        ratio: f64,
        children: Vec<PaneNode>,
    },
    /// One leaf pane: the tabs it shows, and which of them is on screen.
    Pane {
        keys: Vec<String>,
        #[serde(default)]
        active: Option<String>,
    },
}

/// Read the pane-tree map, DROPPING any single tree that will not parse.
///
/// Without this, one corrupt or future-shaped tree fails the whole
/// `LayoutData` deserialization, and the user loses every project's tab list —
/// far worse damage than losing one pane arrangement. A dropped tree simply
/// means that project reopens as a single pane.
fn lenient_pane_layouts<'de, D>(d: D) -> Result<HashMap<String, PaneNode>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Take the field as a raw value first. Deserializing straight into a map
    // would make a `paneLayouts` that is not an object at all fail the whole
    // parse — and `TerminalLayoutState::load` turns any parse failure into an
    // EMPTY store, so that one bad field would wipe every project's tab index.
    let raw = serde_json::Value::deserialize(d)?;
    let Some(map) = raw.as_object() else {
        return Ok(HashMap::new());
    };
    Ok(map
        .iter()
        .filter_map(|(k, v)| {
            serde_json::from_value::<PaneNode>(v.clone())
                .ok()
                .map(|n| (k.clone(), n))
        })
        .collect())
}

/// One saved, named arrangement (card 51): the pane tree plus which side panel
/// sits on which edge. Both parts are optional in practice — a preset that only
/// moves the panels around leaves `panes` as `None`, rather than being forced to
/// invent a tree.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPreset {
    #[serde(default)]
    pub panes: Option<PaneNode>,
    /// panel key -> dock side ("left" | "right" | "top" | "bottom").
    #[serde(default)]
    pub docks: HashMap<String, String>,
}

/// The on-disk shape of `terminal_layout.json`: each project id maps to its
/// ordered terminals, its pane tree (card 47), and its named presets (card 51).
/// `#[serde(default)]` so a missing file or an older file without the field
/// loads as an empty map instead of failing.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutData {
    #[serde(default)]
    projects: HashMap<String, Vec<TermEntry>>,
    /// projectId -> pane tree. Absent for a project that is a single pane, and
    /// absent entirely in every file written before card 47.
    #[serde(default, deserialize_with = "lenient_pane_layouts")]
    pane_layouts: HashMap<String, PaneNode>,
    /// projectId -> preset name -> the arrangement. Presets are NOT pruned
    /// against the live tab list the way `pane_layouts` is: a preset is a
    /// remembered arrangement the user may reapply later, so it is allowed to
    /// name terminals that are closed right now. The frontend skips the keys it
    /// cannot resolve when it applies one.
    #[serde(default)]
    presets: HashMap<String, HashMap<String, LayoutPreset>>,
}

/// A project's preset names, sorted, so the picker lists them in a stable order.
fn preset_names(data: &LayoutData, project_id: &str) -> Vec<String> {
    let Some(slot) = data.presets.get(project_id) else {
        return Vec::new();
    };
    let mut names: Vec<String> = slot.keys().cloned().collect();
    names.sort();
    names
}

/// One project's preset by name, or `None` when either is unknown.
fn find_preset(data: &LayoutData, project_id: &str, name: &str) -> Option<LayoutPreset> {
    data.presets.get(project_id)?.get(name).cloned()
}

/// Drop every leaf key that is no longer a live terminal, collapsing whatever
/// that empties: a pane with no keys left disappears, and a split left with one
/// surviving child becomes that child. Returns `None` when nothing survives.
///
/// This is what keeps the tree honest against the tab list saved beside it — the
/// scrollback reconcile already treats that list as authoritative, so a tree
/// naming a closed terminal must never be able to resurrect it. Pure, so it is
/// unit-tested without touching the filesystem.
fn prune_pane_node(node: PaneNode, live: &HashSet<String>) -> Option<PaneNode> {
    match node {
        PaneNode::Pane { keys, active } => {
            let keys: Vec<String> = keys.into_iter().filter(|k| live.contains(k)).collect();
            if keys.is_empty() {
                return None;
            }
            // A pane must never point at a tab it no longer holds.
            let active = active
                .filter(|a| keys.contains(a))
                .or_else(|| keys.first().cloned());
            Some(PaneNode::Pane { keys, active })
        }
        PaneNode::Split {
            dir,
            ratio,
            children,
        } => {
            let mut kept: Vec<PaneNode> = children
                .into_iter()
                .filter_map(|c| prune_pane_node(c, live))
                .collect();
            match kept.len() {
                0 => None,
                // The same "space falls back to the sibling" rule the UI applies.
                1 => Some(kept.remove(0)),
                _ => Some(PaneNode::Split {
                    dir,
                    ratio,
                    children: kept,
                }),
            }
        }
    }
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
    pub fn load() -> Self {
        let dir = crate::profile::profile_dir();
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
///
/// `pane_layout` is the project's pane tree (card 47). It is pruned against the
/// tab list saved in the SAME call, so the two can never disagree. Passing
/// `None` means "this project has no tree" and clears any stored one — the
/// frontend always sends the current tree alongside the tabs, so a missing tree
/// is a real absence, never "leave the old one".
#[tauri::command]
pub fn save_terminal_layout(
    state: State<TerminalLayoutState>,
    project_id: String,
    terminals: Vec<TermEntry>,
    pane_layout: Option<PaneNode>,
) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    if terminals.is_empty() {
        data.projects.remove(&project_id);
        data.pane_layouts.remove(&project_id);
    } else {
        let saved_keys: HashSet<String> = terminals.iter().map(|t| t.persist_key.clone()).collect();
        data.projects.insert(project_id.clone(), terminals);
        match pane_layout.and_then(|tree| prune_pane_node(tree, &saved_keys)) {
            Some(tree) => data.pane_layouts.insert(project_id, tree),
            None => data.pane_layouts.remove(&project_id),
        };
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

/// Return every project's pane tree (card 47), for the boot restore.
///
/// Deliberately a SEPARATE command rather than a new field on
/// `load_terminal_layouts`: widening that command's return shape would break
/// `project.js`, which reads its result directly as `projectId -> tabs`, and
/// this card must leave the app working on its own. A project with no tree is
/// simply absent from the map and reopens as a single pane.
#[tauri::command]
pub fn load_pane_layouts(
    state: State<TerminalLayoutState>,
) -> Result<HashMap<String, PaneNode>, String> {
    let data = state.data.lock().map_err(|e| e.to_string())?;
    Ok(data.pane_layouts.clone())
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

// ---- Named layout presets (card 51) ---------------------------------------

/// Save (or overwrite) one named arrangement for a project.
#[tauri::command]
pub fn save_layout_preset(
    state: State<TerminalLayoutState>,
    project_id: String,
    name: String,
    preset: LayoutPreset,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a preset needs a name".into());
    }
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    data.presets
        .entry(project_id)
        .or_default()
        .insert(name, preset);
    state.save(&data)
}

/// A project's preset names, sorted.
#[tauri::command]
pub fn list_layout_presets(
    state: State<TerminalLayoutState>,
    project_id: String,
) -> Result<Vec<String>, String> {
    let data = state.data.lock().map_err(|e| e.to_string())?;
    Ok(preset_names(&data, &project_id))
}

/// One preset by name, or `None` when either the project or the name is unknown.
#[tauri::command]
pub fn load_layout_preset(
    state: State<TerminalLayoutState>,
    project_id: String,
    name: String,
) -> Result<Option<LayoutPreset>, String> {
    let data = state.data.lock().map_err(|e| e.to_string())?;
    Ok(find_preset(&data, &project_id, &name))
}

/// Delete one preset. Removing the last one drops the project's whole slot, so
/// the file does not accumulate empty maps.
#[tauri::command]
pub fn delete_layout_preset(
    state: State<TerminalLayoutState>,
    project_id: String,
    name: String,
) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    if let Some(slot) = data.presets.get_mut(&project_id) {
        slot.remove(&name);
        if slot.is_empty() {
            data.presets.remove(&project_id);
        }
    }
    state.save(&data)
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
    data.pane_layouts.remove(&project_id);
    data.presets.remove(&project_id);
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
                title_manual: false,
                notify: Some(false),
                split: Some("row".to_string()),
                primary: false,
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
        assert!(!entry.title_manual);
        // A layout saved before the per-terminal notification choice existed
        // reads back as None — follow the global switch.
        assert_eq!(entry.notify, None);
        // Likewise for split view: an older layout has no split halves, so the
        // project comes back as a single pane.
        assert_eq!(entry.split, None);
        assert!(!entry.primary);
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
                title_manual: false,
                notify: None,
                split: None,
                primary: false,
            }],
        );
        data.projects.insert(
            "p2".to_string(),
            vec![TermEntry {
                persist_key: "b".into(),
                title: String::new(),
                cwd: String::new(),
                title_manual: false,
                notify: None,
                split: None,
                primary: false,
            }],
        );
        let keys = live_keys(&data);
        assert!(keys.contains("a"));
        assert!(keys.contains("b"));
        assert_eq!(keys.len(), 2);
    }

    // ---- Pane tree (card 47) ---------------------------------------------

    /// A two-pane tree: a row split holding one leaf per side.
    fn sample_tree() -> PaneNode {
        PaneNode::Split {
            dir: "row".to_string(),
            ratio: 0.5,
            children: vec![
                PaneNode::Pane {
                    keys: vec!["a".to_string()],
                    active: Some("a".to_string()),
                },
                PaneNode::Pane {
                    keys: vec!["b".to_string(), "c".to_string()],
                    active: Some("b".to_string()),
                },
            ],
        }
    }

    fn live(keys: &[&str]) -> HashSet<String> {
        keys.iter().map(|k| k.to_string()).collect()
    }

    #[test]
    fn pane_tree_round_trips_through_json() {
        let mut data = LayoutData::default();
        data.pane_layouts.insert("p1".to_string(), sample_tree());
        let raw = serde_json::to_string(&data).unwrap();
        let back: LayoutData = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.pane_layouts, data.pane_layouts);
    }

    #[test]
    fn pane_tree_uses_the_frontends_tagged_shape() {
        // The frontend writes { type: "split" | "pane", ... }; the tag and the
        // field names must match it exactly or a saved tree cannot be read back.
        let raw = serde_json::to_string(&sample_tree()).unwrap();
        assert!(raw.contains(r#""type":"split""#), "got {raw}");
        assert!(raw.contains(r#""type":"pane""#), "got {raw}");
        assert!(raw.contains(r#""keys":["a"]"#), "got {raw}");
    }

    #[test]
    fn a_layout_file_without_pane_layouts_still_loads() {
        // The file every existing install has on disk today.
        let raw = r#"{ "projects": { "p": [ { "persistKey": "k" } ] } }"#;
        let parsed: LayoutData = serde_json::from_str(raw).unwrap();
        assert!(parsed.pane_layouts.is_empty());
        // ...and its tab list is untouched.
        assert_eq!(parsed.projects["p"][0].persist_key, "k");
    }

    #[test]
    fn an_unreadable_tree_is_dropped_without_failing_the_whole_load() {
        // One corrupt tree must not cost the user every project's tab list.
        let raw = r#"{
            "projects": { "p": [ { "persistKey": "k" } ] },
            "paneLayouts": {
                "bad": { "type": "wormhole" },
                "good": { "type": "pane", "keys": ["k"], "active": "k" }
            }
        }"#;
        let parsed: LayoutData = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.projects["p"][0].persist_key, "k");
        assert!(!parsed.pane_layouts.contains_key("bad"));
        assert!(parsed.pane_layouts.contains_key("good"));
    }

    #[test]
    fn a_pane_layouts_field_that_is_not_an_object_costs_only_the_trees() {
        // Found in code review: any parse failure makes TerminalLayoutState::load
        // fall back to an EMPTY store, so one malformed field must never be able
        // to take every project's tab list with it.
        let raw = r#"{ "projects": { "p": [ { "persistKey": "k" } ] }, "paneLayouts": 7 }"#;
        let parsed: LayoutData = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.projects["p"][0].persist_key, "k");
        assert!(parsed.pane_layouts.is_empty());
    }

    #[test]
    fn prune_drops_leaf_keys_that_are_no_longer_live() {
        // "c" was closed; the rest of the tree survives.
        let pruned = prune_pane_node(sample_tree(), &live(&["a", "b"])).unwrap();
        let PaneNode::Split { children, .. } = &pruned else {
            panic!("expected a split, got {pruned:?}");
        };
        assert_eq!(
            children[1],
            PaneNode::Pane {
                keys: vec!["b".to_string()],
                active: Some("b".to_string()),
            }
        );
    }

    #[test]
    fn prune_collapses_a_split_whose_child_emptied() {
        // Every tab of the first pane is gone, so the split collapses to the
        // surviving sibling — the same "space falls back" rule the UI applies.
        let pruned = prune_pane_node(sample_tree(), &live(&["b", "c"])).unwrap();
        assert_eq!(
            pruned,
            PaneNode::Pane {
                keys: vec!["b".to_string(), "c".to_string()],
                active: Some("b".to_string()),
            }
        );
    }

    #[test]
    fn prune_returns_none_when_no_key_survives() {
        assert_eq!(prune_pane_node(sample_tree(), &live(&[])), None);
    }

    #[test]
    fn prune_repoints_active_when_the_active_key_is_gone() {
        // "b" was the active tab of its pane; with it closed the pane must show
        // one of its remaining tabs, never a dangling key.
        let pruned = prune_pane_node(sample_tree(), &live(&["a", "c"])).unwrap();
        let PaneNode::Split { children, .. } = &pruned else {
            panic!("expected a split, got {pruned:?}");
        };
        assert_eq!(
            children[1],
            PaneNode::Pane {
                keys: vec!["c".to_string()],
                active: Some("c".to_string()),
            }
        );
    }

    // ---- Named layout presets (card 51) ----------------------------------

    fn sample_preset() -> LayoutPreset {
        let mut docks = HashMap::new();
        docks.insert("browser".to_string(), "left".to_string());
        LayoutPreset {
            panes: Some(sample_tree()),
            docks,
        }
    }

    #[test]
    fn a_preset_round_trips_through_json() {
        let mut data = LayoutData::default();
        data.presets
            .entry("p1".to_string())
            .or_default()
            .insert("wide".to_string(), sample_preset());
        let raw = serde_json::to_string(&data).unwrap();
        let back: LayoutData = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.presets, data.presets);
    }

    #[test]
    fn preset_names_come_back_sorted() {
        let mut data = LayoutData::default();
        let slot = data.presets.entry("p1".to_string()).or_default();
        for n in ["zebra", "apple", "middle"] {
            slot.insert(n.to_string(), sample_preset());
        }
        assert_eq!(preset_names(&data, "p1"), vec!["apple", "middle", "zebra"]);
    }

    #[test]
    fn preset_names_of_an_unknown_project_is_empty() {
        assert!(preset_names(&LayoutData::default(), "nope").is_empty());
    }

    #[test]
    fn an_unknown_preset_name_loads_as_none() {
        let mut data = LayoutData::default();
        data.presets
            .entry("p1".to_string())
            .or_default()
            .insert("wide".to_string(), sample_preset());
        assert!(find_preset(&data, "p1", "tall").is_none());
        assert!(find_preset(&data, "other", "wide").is_none());
        assert!(find_preset(&data, "p1", "wide").is_some());
    }

    #[test]
    fn a_layout_file_without_presets_still_loads() {
        let raw = r#"{ "projects": { "p": [ { "persistKey": "k" } ] } }"#;
        let parsed: LayoutData = serde_json::from_str(raw).unwrap();
        assert!(parsed.presets.is_empty());
        assert_eq!(parsed.projects["p"][0].persist_key, "k");
    }

    #[test]
    fn a_preset_may_hold_docks_but_no_panes() {
        // Saving a preset with only the panels open (a single-pane terminal
        // area) must be expressible, not forced to invent a tree.
        let raw = r#"{ "docks": { "browser": "bottom" } }"#;
        let parsed: LayoutPreset = serde_json::from_str(raw).unwrap();
        assert!(parsed.panes.is_none());
        assert_eq!(parsed.docks["browser"], "bottom");
    }

    #[test]
    fn prune_keeps_a_pane_whose_active_is_already_none() {
        let node = PaneNode::Pane {
            keys: vec!["a".to_string()],
            active: None,
        };
        let pruned = prune_pane_node(node, &live(&["a"])).unwrap();
        assert_eq!(
            pruned,
            PaneNode::Pane {
                keys: vec!["a".to_string()],
                active: Some("a".to_string()),
            }
        );
    }
}

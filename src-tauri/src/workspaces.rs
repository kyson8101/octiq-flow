// Workspace store. A workspace groups several folder paths the user works in.
// The store is owned by the Rust backend (not the web view) and persisted as
// JSON in the app data dir, so it survives a restart and can later be used to
// launch agents in those folders.
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

/// A Dev-space action button: a labelled shell command, defined per workspace
/// and shared by all of its sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    pub id: String,
    pub label: String,
    pub command: String,
}

/// One terminal in a project's startup layout: a tab title and an optional
/// command to run on open. An empty `cmd` means "just open a plain shell".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartupTerminal {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cmd: String,
}

/// A project's startup layout: terminals to open and registered command ids to
/// auto-run the first time the project is opened in a session. Every field uses
/// `#[serde(default)]` so a `workspaces.json` written before this feature loads
/// unchanged — a missing `startup` becomes an empty layout (no auto-open).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Startup {
    #[serde(default)]
    pub terminals: Vec<StartupTerminal>,
    /// References existing `Action` ids on the same workspace.
    #[serde(default)]
    pub command_ids: Vec<String>,
}

/// One workspace: a name, the main folder it runs in (primary_path), extra
/// folder paths, a docs root (`docs_path`), and its registered command actions.
/// New fields use `#[serde(default)]` so stores written before they existed
/// still load. Older files that still have a `sessions` array load fine too —
/// serde ignores unknown fields by default.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub primary_path: String,
    /// Root folder for this workspace's documentation. Empty means "use the app
    /// data dir". Each session gets a `<docs_path>/<session_id>` subfolder.
    #[serde(default)]
    pub docs_path: String,
    #[serde(default)]
    pub paths: Vec<String>,
    /// Dev-space action buttons, shared by all sessions in this workspace.
    #[serde(default)]
    pub actions: Vec<Action>,
    /// Startup layout: terminals to open and command ids to auto-run on the
    /// first open of this project in a session. Defaults to empty.
    #[serde(default)]
    pub startup: Startup,
    /// A command auto-run in EVERY new terminal opened in this project (for
    /// example `nvm use` or `source .venv/bin/activate`). Empty means none. A
    /// startup terminal's own command takes precedence; session-restore
    /// terminals never auto-run it (they restore prior output instead).
    #[serde(default)]
    pub terminal_command: String,
    /// A short, user-entered description shown under the project name in the
    /// sidebar tab. Empty means none.
    #[serde(default)]
    pub description: String,
    /// Accent color for the project's sidebar tab, as a `#rrggbb` hex string.
    /// Empty means "derive a color from the name" (the frontend does this), so
    /// every project shows a distinct bar even before the user picks one.
    #[serde(default)]
    pub color: String,
    /// True when the user has set this project "off work": it is moved to the
    /// Shelved section of the sidebar and hidden from the active project list
    /// until the user brings it back. Fully reversible — no data (paths,
    /// startup, terminals) is removed. Defaults to false so a store written
    /// before this field existed loads with every project active.
    #[serde(default)]
    pub shelved: bool,
}

/// The full on-disk shape. Wrapped in a struct so the file format can grow
/// later without breaking older files.
#[derive(Debug, Default, Serialize, Deserialize)]
struct WorkspaceData {
    #[serde(default)]
    workspaces: Vec<Workspace>,
}

/// In-memory workspace list plus the file it is saved to.
pub struct WorkspaceState {
    data: Mutex<WorkspaceData>,
    file: PathBuf,
}

impl WorkspaceState {
    /// Load the store from disk. A missing or unreadable file starts an empty
    /// store rather than failing the whole app.
    pub fn load(app: &AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .expect("app data dir should resolve");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("workspaces.json");
        let data = fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<WorkspaceData>(&raw).ok())
            .unwrap_or_default();
        Self {
            data: Mutex::new(data),
            file,
        }
    }

    /// Write the current state back to disk as pretty JSON.
    fn save(&self, data: &WorkspaceData) -> Result<(), String> {
        let raw = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        fs::write(&self.file, raw).map_err(|e| e.to_string())
    }
}

/// Return all workspaces in their stored order.
#[tauri::command]
pub fn list_workspaces(state: State<WorkspaceState>) -> Result<Vec<Workspace>, String> {
    let data = state.data.lock().map_err(|e| e.to_string())?;
    Ok(data.workspaces.clone())
}

/// Resolve the user's home folder. Used as the default primary path when a
/// project is created without one. Falls back to $HOME, then "/".
fn home_dir(app: &AppHandle) -> String {
    app.path()
        .home_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".to_string())
}

/// Create a new workspace and return it. A name is required. The primary path
/// is the main folder the workspace runs in; when it is empty the user's home
/// folder is used, so a project can be created without picking a folder first.
#[tauri::command]
pub fn add_workspace(
    app: AppHandle,
    state: State<WorkspaceState>,
    name: String,
    primary_path: String,
) -> Result<Workspace, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("workspace name cannot be empty".into());
    }
    let primary_path = primary_path.trim().to_string();
    let primary_path = if primary_path.is_empty() {
        home_dir(&app)
    } else {
        primary_path
    };
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let workspace = Workspace {
        id: Uuid::new_v4().to_string(),
        name,
        primary_path,
        docs_path: String::new(),
        paths: Vec::new(),
        actions: Vec::new(),
        startup: Startup::default(),
        terminal_command: String::new(),
        description: String::new(),
        color: String::new(),
        shelved: false,
    };
    data.workspaces.push(workspace.clone());
    state.save(&data)?;
    Ok(workspace)
}

/// Set or change the primary path of an existing workspace. Used both to change
/// it later and to fill it in for a workspace saved before this field existed.
#[tauri::command]
pub fn set_primary_path(
    state: State<WorkspaceState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("primary path is required".into());
    }
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    ws.primary_path = path;
    state.save(&data)
}

/// Rename an existing workspace.
#[tauri::command]
pub fn rename_workspace(
    state: State<WorkspaceState>,
    id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("workspace name cannot be empty".into());
    }
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    ws.name = name;
    state.save(&data)
}

/// Delete a workspace and all of its paths.
#[tauri::command]
pub fn delete_workspace(state: State<WorkspaceState>, id: String) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    data.workspaces.retain(|w| w.id != id);
    state.save(&data)
}

/// Reorder the workspace list to match `ids` (the new top-to-bottom order from
/// the frontend, after a drag-and-drop). The sort is stable: any workspace whose
/// id is not in `ids` keeps its relative order at the end, so a partial or stale
/// list can never drop a workspace.
#[tauri::command]
pub fn reorder_workspaces(state: State<WorkspaceState>, ids: Vec<String>) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    data.workspaces
        .sort_by_key(|w| ids.iter().position(|x| x == &w.id).unwrap_or(usize::MAX));
    state.save(&data)
}

/// Add a folder path to a workspace. Duplicate paths are ignored.
#[tauri::command]
pub fn add_workspace_path(
    state: State<WorkspaceState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    if !ws.paths.contains(&path) {
        ws.paths.push(path);
    }
    state.save(&data)
}

/// Remove a folder path from a workspace.
#[tauri::command]
pub fn remove_workspace_path(
    state: State<WorkspaceState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    ws.paths.retain(|p| p != &path);
    state.save(&data)
}

/// Set the workspace docs root (where session folders are created). A path
/// from the folder picker, for example an Obsidian vault folder.
#[tauri::command]
pub fn set_docs_path(state: State<WorkspaceState>, id: String, path: String) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("docs path is required".into());
    }
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    ws.docs_path = path;
    state.save(&data)
}

/// Reset the workspace docs root back to the default (the app data dir).
#[tauri::command]
pub fn clear_docs_path(state: State<WorkspaceState>, id: String) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    ws.docs_path = String::new();
    state.save(&data)
}

/// Add a Dev-space action button (label + command) to a workspace.
#[tauri::command]
pub fn add_action(
    state: State<WorkspaceState>,
    workspace_id: String,
    label: String,
    command: String,
) -> Result<Action, String> {
    let label = label.trim().to_string();
    let command = command.trim().to_string();
    if label.is_empty() || command.is_empty() {
        return Err("label and command are both required".into());
    }
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == workspace_id)
        .ok_or("workspace not found")?;
    let action = Action {
        id: Uuid::new_v4().to_string(),
        label,
        command,
    };
    ws.actions.push(action.clone());
    state.save(&data)?;
    Ok(action)
}

/// Update an existing Dev-space action button.
#[tauri::command]
pub fn update_action(
    state: State<WorkspaceState>,
    workspace_id: String,
    action_id: String,
    label: String,
    command: String,
) -> Result<(), String> {
    let label = label.trim().to_string();
    let command = command.trim().to_string();
    if label.is_empty() || command.is_empty() {
        return Err("label and command are both required".into());
    }
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == workspace_id)
        .ok_or("workspace not found")?;
    let action = ws
        .actions
        .iter_mut()
        .find(|a| a.id == action_id)
        .ok_or("action not found")?;
    action.label = label;
    action.command = command;
    state.save(&data)
}

/// Delete a Dev-space action button from a workspace.
#[tauri::command]
pub fn delete_action(
    state: State<WorkspaceState>,
    workspace_id: String,
    action_id: String,
) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == workspace_id)
        .ok_or("workspace not found")?;
    ws.actions.retain(|a| a.id != action_id);
    state.save(&data)
}

/// Replace the whole startup layout of a workspace and save. `terminals` is the
/// ordered list of startup terminals (each: title + optional cmd). `command_ids`
/// references existing `Action` ids on the same workspace; ids that do not match
/// an action are dropped, and duplicates are removed while preserving order.
/// Empty terminal rows (no title and no cmd) are dropped. Passing two empty
/// vecs clears the layout (project opens with one plain terminal, as before).
#[tauri::command]
pub fn set_startup(
    state: State<WorkspaceState>,
    id: String,
    terminals: Vec<StartupTerminal>,
    command_ids: Vec<String>,
) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;

    // Trim each terminal and drop rows that carry neither a title nor a cmd.
    let terminals: Vec<StartupTerminal> = terminals
        .into_iter()
        .map(|t| StartupTerminal {
            title: t.title.trim().to_string(),
            cmd: t.cmd.trim().to_string(),
        })
        .filter(|t| !t.title.is_empty() || !t.cmd.is_empty())
        .collect();

    // Keep only command ids that point at a real action on this workspace, with
    // duplicates removed and original order preserved.
    let mut seen = std::collections::HashSet::new();
    let command_ids: Vec<String> = command_ids
        .into_iter()
        .filter(|cid| ws.actions.iter().any(|a| &a.id == cid))
        .filter(|cid| seen.insert(cid.clone()))
        .collect();

    ws.startup = Startup {
        terminals,
        command_ids,
    };
    state.save(&data)
}

/// Set (or clear) the command auto-run in every new terminal opened in this
/// project. The command is trimmed; an empty string clears it, so new terminals
/// open a plain shell again.
#[tauri::command]
pub fn set_terminal_command(
    state: State<WorkspaceState>,
    id: String,
    command: String,
) -> Result<(), String> {
    let command = command.trim().to_string();
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    ws.terminal_command = command;
    state.save(&data)
}

/// Set (or clear) the short description shown under the project name in the
/// sidebar tab. The text is trimmed; an empty string clears it.
#[tauri::command]
pub fn set_description(
    state: State<WorkspaceState>,
    id: String,
    description: String,
) -> Result<(), String> {
    let description = description.trim().to_string();
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    ws.description = description;
    state.save(&data)
}

/// Set (or clear) the project's accent color for its sidebar tab. Accepts a
/// `#rrggbb` hex string, or an empty string to clear it (the frontend then
/// derives a color from the name). Any other value is rejected so a malformed
/// color can never reach the store.
#[tauri::command]
pub fn set_color(state: State<WorkspaceState>, id: String, color: String) -> Result<(), String> {
    let color = color.trim().to_string();
    if !color.is_empty() && !is_hex_color(&color) {
        return Err("color must be a #rrggbb hex string".into());
    }
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    ws.color = color;
    state.save(&data)
}

/// Set or clear a workspace's "shelved" (off-work) flag. A shelved workspace is
/// moved to the Shelved section of the sidebar and hidden from the active project
/// list until the user brings it back. The workspace and all of its data are kept
/// untouched — this is a temporary, fully reversible toggle, not a delete.
#[tauri::command]
pub fn set_workspace_shelved(
    state: State<WorkspaceState>,
    id: String,
    shelved: bool,
) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    ws.shelved = shelved;
    state.save(&data)
}

/// True when `s` is a `#rrggbb` hex color: a leading '#' then exactly six
/// hex digits.
fn is_hex_color(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

/// Open the native folder picker and return the chosen path, or `None` if the
/// user cancelled. Done in Rust so the web view needs no bundler or plugin JS.
/// `blocking_pick_folder` is safe here: the command runs off the main thread,
/// and the dialog crate marshals the dialog onto the main thread for us.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::is_hex_color;

    #[test]
    fn accepts_valid_six_digit_hex() {
        assert!(is_hex_color("#1f6feb"));
        assert!(is_hex_color("#ABCDEF"));
        assert!(is_hex_color("#000000"));
    }

    #[test]
    fn rejects_malformed_colors() {
        assert!(!is_hex_color(""), "empty is not a hex color");
        assert!(!is_hex_color("1f6feb"), "missing leading '#'");
        assert!(!is_hex_color("#fff"), "shorthand 3-digit not accepted");
        assert!(!is_hex_color("#1f6feb0"), "too long");
        assert!(!is_hex_color("#12345g"), "non-hex digit");
        assert!(!is_hex_color("#12 456"), "whitespace inside");
    }
}

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

/// Create a new workspace and return it. A name and a primary path are both
/// required: the primary path is the main folder the workspace runs in.
#[tauri::command]
pub fn add_workspace(
    state: State<WorkspaceState>,
    name: String,
    primary_path: String,
) -> Result<Workspace, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("workspace name cannot be empty".into());
    }
    let primary_path = primary_path.trim().to_string();
    if primary_path.is_empty() {
        return Err("primary path is required".into());
    }
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let workspace = Workspace {
        id: Uuid::new_v4().to_string(),
        name,
        primary_path,
        docs_path: String::new(),
        paths: Vec::new(),
        actions: Vec::new(),
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
pub fn set_docs_path(
    state: State<WorkspaceState>,
    id: String,
    path: String,
) -> Result<(), String> {
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

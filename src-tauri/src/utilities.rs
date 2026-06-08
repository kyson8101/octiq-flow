// Utilities template store. A template is a labelled prompt that launches an
// agent (claude or codex). Templates are user-scoped and not bound to any
// workspace or project, so they live in their own JSON file (utilities.json) in
// the app data dir, separate from the workspace store. The store is owned by
// the Rust backend (not the web view) and persisted as pretty JSON, so it
// survives a restart. Running the built command is done in card 09; this module
// is the store only.
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

/// One Utilities template: a labelled prompt for an agent. `agent` is either
/// "claude" or "codex". `cwd`, `group`, and `hotkey` are optional and use
/// `#[serde(default)]` so files written before they existed still load.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub id: String,
    pub label: String,
    /// The agent to launch: "claude" or "codex".
    pub agent: String,
    pub prompt: String,
    /// Optional working directory the agent runs in. Empty means "unset".
    #[serde(default)]
    pub cwd: String,
    /// Optional group label used to organise templates in the UI.
    #[serde(default)]
    pub group: String,
    /// Optional keyboard shortcut hint, stored as plain text.
    #[serde(default)]
    pub hotkey: String,
}

/// The full on-disk shape. Wrapped in a struct so the file format can grow
/// later without breaking older files.
#[derive(Debug, Default, Serialize, Deserialize)]
struct UtilitiesData {
    #[serde(default)]
    templates: Vec<Template>,
}

/// In-memory template list plus the file it is saved to.
pub struct UtilitiesState {
    data: Mutex<UtilitiesData>,
    file: PathBuf,
}

impl UtilitiesState {
    /// Load the store from disk. A missing or unreadable file starts an empty
    /// store rather than failing the whole app.
    pub fn load(app: &AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .expect("app data dir should resolve");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("utilities.json");
        let data = fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<UtilitiesData>(&raw).ok())
            .unwrap_or_default();
        Self {
            data: Mutex::new(data),
            file,
        }
    }

    /// Write the current state back to disk as pretty JSON.
    fn save(&self, data: &UtilitiesData) -> Result<(), String> {
        let raw = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        fs::write(&self.file, raw).map_err(|e| e.to_string())
    }
}

/// Validate and normalise the shared fields used by add and update. Trims all
/// fields and requires a non-empty label, prompt, and a valid agent.
fn validate(
    label: String,
    agent: String,
    prompt: String,
    cwd: String,
    group: String,
    hotkey: String,
) -> Result<(String, String, String, String, String, String), String> {
    let label = label.trim().to_string();
    let agent = agent.trim().to_string();
    let prompt = prompt.trim().to_string();
    if label.is_empty() {
        return Err("template label cannot be empty".into());
    }
    if prompt.is_empty() {
        return Err("template prompt cannot be empty".into());
    }
    if agent != "claude" && agent != "codex" {
        return Err("agent must be either \"claude\" or \"codex\"".into());
    }
    Ok((
        label,
        agent,
        prompt,
        cwd.trim().to_string(),
        group.trim().to_string(),
        hotkey.trim().to_string(),
    ))
}

/// Return all templates in their stored order.
#[tauri::command]
pub fn list_templates(state: State<UtilitiesState>) -> Result<Vec<Template>, String> {
    let data = state.data.lock().map_err(|e| e.to_string())?;
    Ok(data.templates.clone())
}

/// Create a new template and return it. The label, agent, and prompt are
/// required; the agent must be "claude" or "codex". A uuid id is generated.
#[tauri::command]
pub fn add_template(
    state: State<UtilitiesState>,
    label: String,
    agent: String,
    prompt: String,
    cwd: String,
    group: String,
    hotkey: String,
) -> Result<Template, String> {
    let (label, agent, prompt, cwd, group, hotkey) =
        validate(label, agent, prompt, cwd, group, hotkey)?;
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let template = Template {
        id: Uuid::new_v4().to_string(),
        label,
        agent,
        prompt,
        cwd,
        group,
        hotkey,
    };
    data.templates.push(template.clone());
    state.save(&data)?;
    Ok(template)
}

/// Update an existing template in place. Validates the same way as add.
#[tauri::command]
pub fn update_template(
    state: State<UtilitiesState>,
    id: String,
    label: String,
    agent: String,
    prompt: String,
    cwd: String,
    group: String,
    hotkey: String,
) -> Result<(), String> {
    let (label, agent, prompt, cwd, group, hotkey) =
        validate(label, agent, prompt, cwd, group, hotkey)?;
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    let template = data
        .templates
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or("template not found")?;
    template.label = label;
    template.agent = agent;
    template.prompt = prompt;
    template.cwd = cwd;
    template.group = group;
    template.hotkey = hotkey;
    state.save(&data)
}

/// Delete a template by id.
#[tauri::command]
pub fn delete_template(state: State<UtilitiesState>, id: String) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    data.templates.retain(|t| t.id != id);
    state.save(&data)
}

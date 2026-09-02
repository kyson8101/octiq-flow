// Workspace store. A workspace groups several folder paths the user works in.
// The store is owned by the Rust backend (not the web view) and persisted as
// JSON in the app data dir, so it survives a restart and can later be used to
// launch agents in those folders.
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
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
    /// A custom short label for the project's avatar and the collapsed sidebar
    /// rail. At most two characters. Empty means "use the first letter of the
    /// name" (the frontend derives it), so the rail always shows something.
    #[serde(default)]
    pub initial: String,
    /// The project's icon/logo as a `data:image/...;base64,...` URL, shown in
    /// the sidebar avatar in place of the letter initial. Stored inline (not a
    /// file path) so it survives the source image moving or being deleted.
    /// Empty means none — the avatar falls back to the letter initial.
    #[serde(default)]
    pub icon: String,
    /// True when the user has set this project "off work": it is moved to the
    /// Shelved section of the sidebar and hidden from the active project list
    /// until the user brings it back. Fully reversible — no data (paths,
    /// startup, terminals) is removed. Defaults to false so a store written
    /// before this field existed loads with every project active.
    #[serde(default)]
    pub shelved: bool,
    /// Per-project terminal font override, stored verbatim from the frontend
    /// (which owns the font catalog and clamps every value on read). `null` —
    /// the default — means no override: this project uses the global app font.
    /// When set it is an object `{ enabled, fontId, fontSize, fontWeight,
    /// lineHeight, letterSpacing }`; the frontend overlays it on the global
    /// settings for this project's terminals only.
    #[serde(default)]
    pub font_override: serde_json::Value,
}

/// The full on-disk shape. Wrapped in a struct so the file format can grow
/// later without breaking older files.
#[derive(Debug, Default, Serialize, Deserialize)]
struct WorkspaceData {
    #[serde(default)]
    workspaces: Vec<Workspace>,
    /// Commands offered in EVERY project. Stored once at store level, not on a
    /// workspace, so they are defined in one place and run in whichever
    /// project's folder is selected.
    #[serde(default)]
    global_actions: Vec<Action>,
}

/// In-memory workspace list plus the file it is saved to.
pub struct WorkspaceState {
    data: Mutex<WorkspaceData>,
    file: PathBuf,
}

impl WorkspaceState {
    /// Load the store from disk. A missing or unreadable file starts an empty
    /// store rather than failing the whole app. The store lives in the active
    /// profile's data root (`profile_dir`), which is created if needed.
    pub fn load() -> Self {
        let dir = crate::profile::profile_dir();
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

impl WorkspaceState {
    /// Every folder any project points at: primary paths, extra paths, and docs
    /// roots. These are the folders the user has deliberately opened to the app,
    /// so they form part of the write allowlist (see `paths::write_roots`).
    ///
    /// A poisoned lock yields nothing — a closed door. `write_file` then falls
    /// back to `$HOME` + the profile dir, which is the safe direction to fail.
    pub fn all_paths(&self) -> Vec<String> {
        let Ok(data) = self.data.lock() else {
            return Vec::new();
        };
        data.workspaces
            .iter()
            .flat_map(|w| {
                std::iter::once(w.primary_path.clone())
                    .chain(std::iter::once(w.docs_path.clone()))
                    .chain(w.paths.iter().cloned())
            })
            .filter(|p| !p.trim().is_empty())
            .collect()
    }
}

/// Return all workspaces in their stored order.
pub fn list_workspaces_impl(state: &WorkspaceState) -> Result<Vec<Workspace>, String> {
    let data = state.data.lock().map_err(|e| e.to_string())?;
    Ok(data.workspaces.clone())
}

/// The folder a project gets when it is created without one: the user's home.
///
/// NOT named `home_dir` — that name belongs to `paths::home_dir`, the single
/// definition (card 26). This one has a different contract: it prefers Tauri's
/// platform home lookup, returns a `String` rather than an `Option<PathBuf>`,
/// and falls back to `"/"` so a project always has SOME primary path.
fn default_primary_path() -> String {
    crate::paths::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string())
}

/// Make sure a folder a project points at is really there, creating it (and
/// any missing parent) when it is not. Used by every folder field: the main
/// folder, the extra ones, and the docs root.
///
/// The folder picker can hand back a path that does not exist yet — you can
/// type one into its box — and a project pointed at a missing folder is broken
/// in a quiet way: every chat and terminal it opens fails to `cd` there. So the
/// folder is created at the moment the project claims it, rather than left to
/// fail later. An existing FILE at that path is still an error: nothing can
/// turn it into a folder.
fn ensure_folder(path: &str) -> Result<(), String> {
    let target = std::path::Path::new(path);
    if target.is_dir() {
        return Ok(());
    }
    if target.exists() {
        return Err(format!("{path} is not a folder"));
    }
    fs::create_dir_all(target).map_err(|e| format!("could not create {path}: {e}"))
}

/// A workspace label said as an address — the browser puts this in the chat
/// URL (`#/p/<slug>/c/…`, see web/src/lib/projectSlug.ts, which must match).
/// Lower-cased, every run of non-alphanumerics folded to one dash. Two labels
/// that collide here are the same address, which is why `ensure_unique_name`
/// refuses them.
fn name_slug(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    if out.ends_with('-') {
        out.pop();
    }
    out
}

/// Refuse a label another workspace already answers to. `except` is the
/// workspace being renamed, which is allowed to keep its own name.
fn ensure_unique_name(
    data: &WorkspaceData,
    name: &str,
    except: Option<&str>,
) -> Result<(), String> {
    let slug = name_slug(name);
    for w in &data.workspaces {
        if Some(w.id.as_str()) == except {
            continue;
        }
        if name_slug(&w.name) == slug {
            return Err(format!(
                "a project named \"{}\" already exists — labels address the chat URL, so each must be unique",
                w.name
            ));
        }
    }
    Ok(())
}

/// Create a new workspace and return it. A name is required. The primary path
/// is the main folder the workspace runs in; when it is empty the user's home
/// folder is used, so a project can be created without picking a folder first.
pub fn add_workspace_impl(
    state: &WorkspaceState,
    name: String,
    primary_path: String,
) -> Result<Workspace, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("workspace name cannot be empty".into());
    }
    let primary_path = primary_path.trim().to_string();
    let primary_path = if primary_path.is_empty() {
        default_primary_path()
    } else {
        primary_path
    };
    ensure_folder(&primary_path)?;
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    ensure_unique_name(&data, &name, None)?;
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
        initial: String::new(),
        icon: String::new(),
        shelved: false,
        font_override: serde_json::Value::Null,
    };
    data.workspaces.push(workspace.clone());
    state.save(&data)?;
    Ok(workspace)
}

/// Set or change the primary path of an existing workspace. Used both to change
/// it later and to fill it in for a workspace saved before this field existed.
pub fn set_primary_path_impl(
    state: &WorkspaceState,
    id: String,
    path: String,
) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("primary path is required".into());
    }
    ensure_folder(&path)?;
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
pub fn rename_workspace_impl(
    state: &WorkspaceState,
    id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("workspace name cannot be empty".into());
    }
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    ensure_unique_name(&data, &name, Some(&id))?;
    let ws = data
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    ws.name = name;
    state.save(&data)
}

/// Delete a workspace and all of its paths.
pub fn delete_workspace_impl(state: &WorkspaceState, id: String) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|e| e.to_string())?;
    data.workspaces.retain(|w| w.id != id);
    state.save(&data)
}

/// Add a folder path to a workspace. Duplicate paths are ignored.
pub fn add_workspace_path_impl(
    state: &WorkspaceState,
    id: String,
    path: String,
) -> Result<(), String> {
    ensure_folder(&path)?;
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
pub fn remove_workspace_path_impl(
    state: &WorkspaceState,
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

/// Add a Dev-space action button (label + command) to a workspace. A browser
/// reaches it through `dispatch.rs`: the saved commands are a project's own.
pub fn add_action_impl(
    state: &WorkspaceState,
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
pub fn update_action_impl(
    state: &WorkspaceState,
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
pub fn delete_action_impl(
    state: &WorkspaceState,
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

/// Set (or clear) the short description shown under the project name in the
/// sidebar tab. The text is trimmed; an empty string clears it.
pub fn set_description_impl(
    state: &WorkspaceState,
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

/// Set or clear a workspace's "shelved" (off-work) flag. A shelved workspace is
/// moved to the Shelved section of the sidebar and hidden from the active project
/// list until the user brings it back. The workspace and all of its data are kept
/// untouched — this is a temporary, fully reversible toggle, not a delete.
pub fn set_workspace_shelved_impl(
    state: &WorkspaceState,
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
#[cfg(test)]
mod tests {
    use super::{
        add_workspace_impl, add_workspace_path_impl, name_slug, rename_workspace_impl,
        set_primary_path_impl, WorkspaceData, WorkspaceState,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// A store backed by a throwaway file, plus a folder path inside a temp dir
    /// that does NOT exist yet. `label` keeps parallel tests off each other.
    fn scratch(label: &str) -> (WorkspaceState, std::path::PathBuf) {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let unique = format!(
            "octiqflow-ws-{}-{}-{}",
            label,
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let root = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp root");
        let state = WorkspaceState {
            data: Mutex::new(WorkspaceData::default()),
            file: root.join("workspaces.json"),
        };
        (state, root.join("new").join("nested"))
    }

    #[test]
    fn creates_the_main_folder_when_it_does_not_exist() {
        let (state, missing) = scratch("create");
        assert!(!missing.exists(), "the test folder must start missing");

        let ws = add_workspace_impl(
            &state,
            "demo".into(),
            missing.to_string_lossy().into_owned(),
        )
        .expect("create the project");

        assert!(missing.is_dir(), "the main folder should have been created");
        assert_eq!(ws.primary_path, missing.to_string_lossy());
    }

    #[test]
    fn changing_the_main_folder_creates_it_too() {
        let (state, missing) = scratch("change");
        let ws = add_workspace_impl(&state, "demo".into(), String::new()).expect("create");

        set_primary_path_impl(&state, ws.id, missing.to_string_lossy().into_owned())
            .expect("point it at a new folder");

        assert!(
            missing.is_dir(),
            "the new main folder should have been created"
        );
    }

    #[test]
    fn adding_an_extra_folder_creates_it_too() {
        let (state, missing) = scratch("extra");
        let ws = add_workspace_impl(&state, "demo".into(), String::new()).expect("create");

        add_workspace_path_impl(&state, ws.id, missing.to_string_lossy().into_owned())
            .expect("add another folder");

        assert!(
            missing.is_dir(),
            "the extra folder should have been created"
        );
    }

    #[test]
    fn refuses_an_extra_folder_that_is_a_file() {
        let (state, missing) = scratch("extra-file");
        std::fs::create_dir_all(missing.parent().unwrap()).unwrap();
        std::fs::write(&missing, b"not a folder").unwrap();
        let ws = add_workspace_impl(&state, "demo".into(), String::new()).expect("create");

        let err = add_workspace_path_impl(&state, ws.id, missing.to_string_lossy().into_owned())
            .expect_err("a file is not a folder");
        assert!(err.contains("not a folder"), "unexpected error: {err}");
    }

    #[test]
    fn refuses_a_main_folder_that_is_a_file() {
        let (state, missing) = scratch("file");
        std::fs::create_dir_all(missing.parent().unwrap()).unwrap();
        std::fs::write(&missing, b"not a folder").unwrap();

        let err = add_workspace_impl(
            &state,
            "demo".into(),
            missing.to_string_lossy().into_owned(),
        )
        .expect_err("a file is not a folder");
        assert!(err.contains("not a folder"), "unexpected error: {err}");
    }

    #[test]
    fn refuses_a_second_project_whose_label_slugs_the_same() {
        let (state, _missing) = scratch("dup-create");
        add_workspace_impl(&state, "My App".into(), String::new()).expect("create the first");

        // "my-app" is a different string but the same address once slugged —
        // the whole point of the guard.
        let err = add_workspace_impl(&state, "my-app".into(), String::new())
            .expect_err("a colliding slug must be refused");
        assert!(err.contains("My App"), "unexpected error: {err}");
    }

    #[test]
    fn refuses_a_rename_onto_another_projects_label() {
        let (state, _missing) = scratch("dup-rename");
        add_workspace_impl(&state, "My App".into(), String::new()).expect("create the first");
        let second = add_workspace_impl(&state, "Other App".into(), String::new())
            .expect("create the second");

        let err = rename_workspace_impl(&state, second.id, "my-app".into())
            .expect_err("renaming onto a colliding slug must be refused");
        assert!(err.contains("My App"), "unexpected error: {err}");
    }

    #[test]
    fn allows_renaming_a_project_to_a_slug_variant_of_its_own_name() {
        let (state, _missing) = scratch("self-rename");
        let ws = add_workspace_impl(&state, "My App".into(), String::new()).expect("create");

        // Same slug as before ("my-app"), but the project being renamed is
        // excepted from the collision check — it is allowed to keep its own
        // address.
        rename_workspace_impl(&state, ws.id, "my-app".into())
            .expect("renaming onto your own slug must be allowed");
    }

    #[test]
    fn name_slug_matches_the_frontend_rule() {
        assert_eq!(name_slug("octiq-flow"), "octiq-flow");
        assert_eq!(name_slug("OctiqFlow"), "octiqflow");
        assert_eq!(name_slug("pandahrms-sso (Legacy)"), "pandahrms-sso-legacy");
        assert_eq!(
            name_slug("Api Extraction from HCM Web"),
            "api-extraction-from-hcm-web"
        );
        assert_eq!(name_slug("My App"), name_slug("my-app"));
        assert_eq!(name_slug("  --x--  "), "x");
    }
}

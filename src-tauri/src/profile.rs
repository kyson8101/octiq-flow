// Profiles: each profile is a self-contained data root under `<base>/<active>/`.
// Switching profile changes the active pointer (config.json) and restarts the
// app — restart already rebuilds every store from disk, so there is no live
// teardown. The bootstrap pointer `~/.octiqflow/config.json` is the only file
// that must stay outside any profile, because it names where the profiles live.
//
// Migration moves a store into the profile dir in the SAME card that routes that
// store's reads, each guarded by its own marker file in the profile dir. That
// keeps cards independent and stops the old code from reading a moved-away file.
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Default profile name when none is configured.
const DEFAULT_PROFILE: &str = "default";

/// `~/.octiqflow` — holds the fixed bootstrap config and global scratch.
fn octiqflow_dir() -> Option<PathBuf> {
    crate::paths::home_dir().map(|h| h.join(".octiqflow"))
}

/// Path of the fixed bootstrap pointer.
fn config_path() -> Option<PathBuf> {
    octiqflow_dir().map(|d| d.join("config.json"))
}

/// Default base when none is configured: `~/.octiqflow/profiles`. On a normal
/// install this is on the same volume as the legacy stores, so first-run
/// migration can `fs::rename` into it safely.
fn default_base() -> Option<PathBuf> {
    octiqflow_dir().map(|d| d.join("profiles"))
}

/// Bootstrap pointer: where profiles live (`base`) and which one is active.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileConfig {
    /// Folder that holds every profile's data root.
    pub base: String,
    /// Active profile name; its data root is `<base>/<active>/`.
    pub active: String,
}

impl Default for ProfileConfig {
    fn default() -> Self {
        Self {
            base: default_base()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            active: DEFAULT_PROFILE.to_string(),
        }
    }
}

/// Load the bootstrap config, creating it with defaults on first run. A missing
/// or unreadable file yields the defaults (and writes them back best-effort).
pub fn load_config() -> ProfileConfig {
    if let Some(path) = config_path() {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<ProfileConfig>(&raw) {
                return cfg;
            }
        }
    }
    let cfg = ProfileConfig::default();
    let _ = save_config(&cfg);
    cfg
}

/// Write the bootstrap config back to `~/.octiqflow/config.json` as pretty JSON.
pub fn save_config(cfg: &ProfileConfig) -> Result<(), String> {
    let path = config_path().ok_or("could not resolve your home folder")?;
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

/// Resolve (and create) the active profile's data root: `<base>/<active>/`.
/// If the configured base can't be created — an offline iCloud/USB path, say —
/// fall back to the default base under `~/.octiqflow/profiles` so the app still
/// starts (with that profile's data) instead of crashing.
pub fn profile_dir() -> PathBuf {
    let cfg = load_config();
    let dir = PathBuf::from(&cfg.base).join(&cfg.active);
    if fs::create_dir_all(&dir).is_ok() {
        return dir;
    }
    eprintln!(
        "[profile] base '{}' is unreachable; falling back to the default base",
        cfg.base
    );
    let fallback = default_base()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(&cfg.active);
    let _ = fs::create_dir_all(&fallback);
    fallback
}

/// Move a file or dir from `src` to `dst` if `src` exists and `dst` does not.
/// Best-effort: any failure is ignored so one item can never block the rest.
//
// ponytail: rename only. The first-run base defaults to ~/.octiqflow/profiles,
// same volume as the legacy roots, so a cross-device rename can't happen here.
// If a future caller moves across volumes, add a copy+remove fallback.
fn move_path(src: &Path, dst: &Path) {
    if !src.exists() || dst.exists() {
        return;
    }
    let _ = fs::rename(src, dst);
}

/// Move `items` (src -> dst pairs) into `dir` exactly once, guarded by a marker
/// file named `marker` inside `dir`. Idempotent: once the marker exists this is a
/// no-op, so each migration card can run on every launch without re-moving data.
fn migrate_once(dir: &Path, marker: &str, items: &[(PathBuf, PathBuf)]) {
    let marker_path = dir.join(marker);
    if marker_path.exists() {
        return;
    }
    let _ = fs::create_dir_all(dir);
    for (src, dst) in items {
        move_path(src, dst);
    }
    let _ = fs::write(&marker_path, b"1");
}

/// Card 1 migration: seed the active profile with the pre-profile `app_data_dir`
/// stores (workspaces, terminal layout, scrollback). Call this BEFORE the
/// workspace/terminal-layout stores load, so they read the moved files.
pub fn migrate_app_data_stores(old_app_data: Option<PathBuf>) {
    let Some(old) = old_app_data else { return };
    let dir = profile_dir();
    let items = [
        (old.join("workspaces.json"), dir.join("workspaces.json")),
        (
            old.join("terminal_layout.json"),
            dir.join("terminal_layout.json"),
        ),
        (old.join("scrollback"), dir.join("scrollback")),
    ];
    migrate_once(&dir, ".migrated-appdata", &items);
}

/// Card 2 migration: move the legacy fixed-path `~/.octiqflow/{canvas,vault}`
/// folders into the active profile. Call this BEFORE any canvas/vault command
/// runs, so they resolve to the profile's (now-populated) folders.
pub fn migrate_canvas_vault() {
    let Some(old) = octiqflow_dir() else { return };
    let dir = profile_dir();
    let items = [
        (old.join("canvas"), dir.join("canvas")),
        (old.join("vault"), dir.join("vault")),
    ];
    migrate_once(&dir, ".migrated-canvas", &items);
}

/// Card 3 migration: move the legacy `~/.octiqflow/agent-sessions.json` into the
/// active profile. Call before agent-resume reads the store.
pub fn migrate_agent_sessions() {
    let Some(old) = octiqflow_dir() else { return };
    let dir = profile_dir();
    let items = [(
        old.join("agent-sessions.json"),
        dir.join("agent-sessions.json"),
    )];
    migrate_once(&dir, ".migrated-agentsessions", &items);
}

/// Reduce a profile name to a safe single folder segment: keep ASCII letters,
/// digits, dash, underscore; turn spaces into dashes; drop everything else
/// (path separators, dots). `None` when nothing usable is left, so a crafted
/// name can never traverse out of the base (`..`) or nest into a subfolder.
fn sanitize_profile_name(name: &str) -> Option<String> {
    let kept: String = name
        .trim()
        .chars()
        .map(|c| if c == ' ' { '-' } else { c })
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept)
    }
}

// --- Frontend commands ------------------------------------------------------

/// Raw JSON of the active profile's `settings.json` (terminal appearance), or
/// `None` when it does not exist yet. The frontend parses it; the backend only
/// stores the blob.
#[tauri::command]
pub fn read_profile_settings() -> Option<String> {
    fs::read_to_string(profile_dir().join("settings.json")).ok()
}

/// Write the active profile's `settings.json`. Validates the payload is JSON
/// (trust boundary: this is a frontend-callable command) before writing.
#[tauri::command]
pub fn write_profile_settings(json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|_| "settings must be valid JSON")?;
    fs::write(profile_dir().join("settings.json"), json).map_err(|e| e.to_string())
}

/// Absolute path of the active profile's data root, for frontend stores that
/// keep their own files under it (e.g. the agent roster's `agents/` folder).
#[tauri::command]
pub fn profile_dir_path() -> String {
    profile_dir().to_string_lossy().into_owned()
}

/// The bootstrap config: where profiles live (`base`) and which is active.
#[tauri::command]
pub fn get_profile_config() -> ProfileConfig {
    load_config()
}

/// Names of every profile (subfolders of `base`). The active profile is always
/// included even if the base listing fails, so the switcher never hides it.
#[tauri::command]
pub fn list_profiles() -> Vec<String> {
    let cfg = load_config();
    let _ = profile_dir(); // make sure the active profile's folder exists
    let mut names: Vec<String> = fs::read_dir(&cfg.base)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    if !names.iter().any(|n| n == &cfg.active) {
        names.push(cfg.active.clone());
    }
    names.sort();
    names.dedup();
    names
}

/// Create a new (empty) profile folder under `base`. Returns the sanitized name
/// actually used. Does not switch to it.
#[tauri::command]
pub fn create_profile(name: String) -> Result<String, String> {
    let safe = sanitize_profile_name(&name).ok_or("give the profile a name")?;
    let cfg = load_config();
    fs::create_dir_all(PathBuf::from(&cfg.base).join(&safe)).map_err(|e| e.to_string())?;
    Ok(safe)
}

/// Switch the active profile and restart so every store reloads from the new
/// data root. The write is validated first; `restart()` never returns.
#[tauri::command]
pub fn switch_profile(app: AppHandle, name: String) -> Result<(), String> {
    let safe = sanitize_profile_name(&name).ok_or("invalid profile name")?;
    let mut cfg = load_config();
    cfg.active = safe;
    save_config(&cfg)?;
    app.restart();
}

/// Point the base (where profiles live) at a new folder and restart. Existing
/// profiles stay in the old folder — this only changes where OctiqFlow looks.
#[tauri::command]
pub fn set_profile_base(app: AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("choose a folder".into());
    }
    let mut cfg = load_config();
    cfg.base = trimmed.to_string();
    save_config(&cfg)?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh temp dir keyed by test name (tests share the process, so the name
    /// keeps them from colliding). Cleared first so reruns start clean.
    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("octiq-profile-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn migrate_once_moves_items_then_is_a_noop() {
        let root = tmp("migrate");
        let old = root.join("old");
        let dir = root.join("profile");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("workspaces.json"), "{}").unwrap();
        fs::create_dir_all(old.join("scrollback")).unwrap();
        fs::write(old.join("scrollback").join("a.txt"), "hi").unwrap();

        let items = [
            (old.join("workspaces.json"), dir.join("workspaces.json")),
            (old.join("scrollback"), dir.join("scrollback")),
        ];
        migrate_once(&dir, ".migrated-appdata", &items);

        // Moved into the profile (rename, not copy: source is gone).
        assert!(dir.join("workspaces.json").exists());
        assert!(dir.join("scrollback").join("a.txt").exists());
        assert!(!old.join("workspaces.json").exists());
        assert!(dir.join(".migrated-appdata").exists());

        // Second run is a no-op: a new legacy file must NOT be pulled in.
        fs::write(old.join("workspaces.json"), "{}").unwrap();
        let items2 = [(old.join("workspaces.json"), dir.join("workspaces.json"))];
        migrate_once(&dir, ".migrated-appdata", &items2);
        assert!(old.join("workspaces.json").exists()); // left untouched
    }

    #[test]
    fn sanitize_profile_name_blocks_traversal_and_separators() {
        assert_eq!(sanitize_profile_name("Work"), Some("Work".into()));
        assert_eq!(
            sanitize_profile_name("my profile"),
            Some("my-profile".into())
        );
        // Path separators and dots are dropped, so the result is always a single
        // safe segment — never `..` or a nested path.
        assert_eq!(sanitize_profile_name("../etc"), Some("etc".into()));
        assert_eq!(sanitize_profile_name("a/b\\c"), Some("abc".into()));
        assert_eq!(sanitize_profile_name(".."), None);
        assert_eq!(sanitize_profile_name("   "), None);
    }
}

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

/// Default profile name when none is configured.
const DEFAULT_PROFILE: &str = "default";

/// The user's home dir, from HOME (Unix) or USERPROFILE (Windows). `None` when
/// neither is set, in which case every path here is unresolved and callers fall
/// back to a relative dir.
fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// `~/.octiqflow` — holds the fixed bootstrap config and global scratch.
fn octiqflow_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".octiqflow"))
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
}

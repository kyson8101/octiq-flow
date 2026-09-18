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
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

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

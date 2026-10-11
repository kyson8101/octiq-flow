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
    #[cfg(test)]
    if let Some(home) = STARTED.with(|home| home.borrow().clone()) {
        return Some(home.join(".octiqflow"));
    }
    crate::paths::home_dir().map(|h| h.join(".octiqflow"))
}

#[cfg(test)]
thread_local! {
    /// The home folder of the process this thread stands in for.
    static STARTED: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// This thread is a process whose home folder is `home`, until the guard
/// drops: its profile is resolved from the config there, away from every
/// other test's.
#[cfg(test)]
pub(crate) fn started_in(home: &std::path::Path) -> Started {
    Started(STARTED.with(|started| started.replace(Some(home.to_path_buf()))))
}

#[cfg(test)]
pub(crate) struct Started(Option<PathBuf>);

#[cfg(test)]
impl Drop for Started {
    fn drop(&mut self) {
        let before = self.0.take();
        STARTED.with(|started| *started.borrow_mut() = before);
    }
}

/// Whether this thread stands in for a process of its own (`started_in`).
#[cfg(test)]
pub(crate) fn started_here() -> bool {
    STARTED.with(|started| started.borrow().is_some())
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::test_dir::TestDir;
    use serde_json::json;

    /// A home folder whose config names a base on a drive of its own, with
    /// the default base beside it.
    pub(crate) struct Home {
        pub(crate) dir: TestDir,
    }

    impl Home {
        pub(crate) fn with_a_configured_base() -> Self {
            let home = Self {
                dir: TestDir::new("profile-home"),
            };
            fs::create_dir_all(home.configured()).unwrap();
            let _process = started_in(&home.dir);
            save_config(&ProfileConfig {
                base: home.configured().to_string_lossy().into_owned(),
                active: DEFAULT_PROFILE.into(),
            })
            .unwrap();
            home
        }

        pub(crate) fn configured(&self) -> PathBuf {
            self.dir.join("drive").join("profiles")
        }

        pub(crate) fn default_base(&self) -> PathBuf {
            self.dir.join(".octiqflow").join("profiles")
        }

        /// The drive goes away: a file is where its folder was, so nothing
        /// can be made under it, on any platform.
        pub(crate) fn unplug(&self) {
            fs::rename(self.dir.join("drive"), self.dir.join("drive-away")).unwrap();
            fs::write(self.dir.join("drive"), b"not a folder").unwrap();
        }

        pub(crate) fn plug_back(&self) {
            fs::remove_file(self.dir.join("drive")).unwrap();
            fs::rename(self.dir.join("drive-away"), self.dir.join("drive")).unwrap();
        }
    }

    /// Review of bf9d8cd, finding 2 (feedback b5123faa): `profile_dir` ran
    /// `create_dir_all` on every call and answered the default base whenever
    /// the configured one could not be made, so a running server's chats,
    /// roster and vault moved to another folder while its ledger stayed.
    #[test]
    fn the_profile_folder_does_not_move_when_its_base_goes_away_under_a_running_server() {
        let home = Home::with_a_configured_base();
        let _process = started_in(&home.dir);
        let at_start = profile_dir();
        assert_eq!(at_start, home.configured().join("default"));

        home.unplug();
        assert_eq!(
            profile_dir(),
            at_start,
            "the profile moved to another base under a running server"
        );
        assert!(
            !home.default_base().exists(),
            "the default base was made behind the configured one"
        );

        home.plug_back();
        assert_eq!(profile_dir(), at_start);
    }

    /// The other direction: the base was away when the server started, so
    /// the default base is in use, as documented. It stays in use when the
    /// configured one comes back; only a restart looks again.
    #[test]
    fn a_fallback_chosen_at_startup_is_kept_when_the_configured_base_comes_back() {
        let home = Home::with_a_configured_base();
        home.unplug();
        let _process = started_in(&home.dir);
        let at_start = profile_dir();
        assert_eq!(at_start, home.default_base().join("default"));

        home.plug_back();
        assert_eq!(
            profile_dir(),
            at_start,
            "the profile moved back to the configured base under a running server"
        );
    }

    /// Every store reads the one folder: what resolved per call (handovers,
    /// preferences, the chats folder, the chat index) stays where the
    /// server started, and writes there or not at all.
    #[test]
    fn every_store_keeps_to_the_folder_fixed_at_startup() {
        let home = Home::with_a_configured_base();
        let _process = started_in(&home.dir);
        let at_start = profile_dir();
        let key = format!("test-pinned-{}", uuid::Uuid::new_v4().simple());
        let said = json!({ "type": "assistant", "message": { "content": "Before" } });
        assert_eq!(crate::transcript::append(&key, &said), Some(1));
        let record = crate::transcript::path_for(&key).unwrap();
        assert!(record.starts_with(&at_start), "{record:?}");

        home.unplug();
        assert_eq!(
            crate::handover::default_path(),
            at_start.join("handovers.json")
        );
        assert_eq!(
            crate::personal_preferences::default_path(),
            at_start.join("preferences.json")
        );
        assert_eq!(
            crate::transcript::append(&key, &said),
            None,
            "a chat's line was written into another base"
        );
        let listed = serde_json::from_value(json!({
            "id": key, "projectId": "project", "title": "Chat", "updatedAt": 100,
        }))
        .unwrap();
        assert!(
            crate::chat_index::upsert(listed).is_err(),
            "a chat was listed in another base"
        );
        assert!(!home.default_base().exists());

        // The drive is back: the same record goes on, nothing was moved.
        home.plug_back();
        assert_eq!(crate::transcript::append(&key, &said), Some(2));
        assert_eq!(crate::transcript::path_for(&key), Some(record));
    }
}

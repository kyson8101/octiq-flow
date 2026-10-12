// Profiles: each profile is a self-contained data root under `<base>/<active>/`.
// Switching profile changes the active pointer (config.json) and restarts the
// app — restart already rebuilds every store from disk, so there is no live
// teardown. The bootstrap pointer `~/.octiqflow/config.json` is the only file
// that must stay outside any profile, because it names where the profiles live.
//
// Migration moves a store into the profile dir in the SAME card that routes that
// store's reads, each guarded by its own marker file in the profile dir. That
// keeps cards independent and stops the old code from reading a moved-away file.
//
// THE FOLDER IS FIXED AT STARTUP. `<base>/<active>/` is worked out once, when
// the process first asks (`pin`, the first thing `run_headless` does), and
// `profile_dir` answers that one path for as long as the process lives. It
// used to read the config and try to make the folder on every call, and to
// answer the default base whenever that failed: a drive that went away under
// a running server moved its chats, chat index, roster and vault settings to
// another folder, while the ledger, the project list and the question store,
// loaded once, stayed where they were, and the owner lock was held for a
// folder half the server had left. A folder that goes away now is an error
// to whoever asked (`available`, `make_dir`), in words the page shows; it is
// never another folder. Only a restart looks at the config again.
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Default profile name when none is configured.
const DEFAULT_PROFILE: &str = "default";

/// `~/.octiqflow` — holds the fixed bootstrap config and global scratch.
fn octiqflow_dir() -> Option<PathBuf> {
    // A test never reads or writes this machine's own pointer: it has a home
    // of its own (`started_in`) or none.
    #[cfg(test)]
    return STARTED.with(|started| {
        started
            .borrow()
            .as_ref()
            .map(|process| process.home.join(".octiqflow"))
    });
    #[cfg(not(test))]
    crate::paths::home_dir().map(|h| h.join(".octiqflow"))
}

/// The profile folder a process uses, as it was resolved when it started.
#[derive(Debug, Clone, PartialEq)]
pub struct Pinned {
    /// `<base>/<active>/`, made if it was not there.
    pub dir: PathBuf,
    /// The configured base, when it could not be reached at startup and the
    /// default base is in use in its place.
    pub fallback_from: Option<PathBuf>,
}

impl Pinned {
    /// What the person is told when the folder in use is not the one their
    /// config names. `None` on the configured base.
    pub fn notice(&self) -> Option<String> {
        self.fallback_from.as_ref().map(|configured| {
            format!(
                "The configured profile base {} could not be reached when OctiqFlow started, so it is using {} instead, and keeps to it until it is restarted. What you see is that folder's data, not the configured one's.",
                configured.display(),
                self.dir.display()
            )
        })
    }
}

/// The one resolution. If the configured base can't be made — an offline
/// iCloud/USB path, say — the default base under `~/.octiqflow/profiles` is
/// used so the server still starts, and `fallback_from` says so.
fn resolve() -> Pinned {
    let cfg = load_config();
    let dir = PathBuf::from(&cfg.base).join(&cfg.active);
    if fs::create_dir_all(&dir).is_ok() {
        return Pinned {
            dir,
            fallback_from: None,
        };
    }
    let fallback = default_base()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(&cfg.active);
    let _ = fs::create_dir_all(&fallback);
    Pinned {
        fallback_from: (fallback != dir).then(|| PathBuf::from(&cfg.base)),
        dir: fallback,
    }
}

#[cfg(not(test))]
static PINNED: std::sync::OnceLock<Pinned> = std::sync::OnceLock::new();

/// Read the pinned folder, resolving it if this is the first time anything
/// asked. Every reader and writer of profile state comes through here.
fn with_pinned<R>(read: impl FnOnce(&Pinned) -> R) -> R {
    #[cfg(test)]
    return read(&tests_pin());
    #[cfg(not(test))]
    read(PINNED.get_or_init(resolve))
}

/// A process under test: its home folder, and the profile folder it pinned
/// the first time it asked.
#[cfg(test)]
struct Process {
    home: PathBuf,
    pinned: Option<Pinned>,
}

#[cfg(test)]
thread_local! {
    /// The process this thread stands in for, if it has one of its own.
    static STARTED: std::cell::RefCell<Option<Process>> = const { std::cell::RefCell::new(None) };
}

/// This thread is a process that has just started with `home` as its home
/// folder, until the guard drops. Its profile is resolved from the config
/// there, once, on its first question, exactly as the server's is: so a test
/// has a profile of its own, apart from every other test's, and can take
/// the folder away under it.
///
/// **How the pin works in tests.** A thread with no process of its own
/// shares one profile folder with the rest of the test binary: a `TestDir`
/// made once and removed at exit (`tests_pin`), never this machine's real
/// profile. It is the calling thread's only: a thread the code under test
/// spawns sees the shared one.
#[cfg(test)]
pub(crate) fn started_in(home: &Path) -> Started {
    let process = Process {
        home: home.to_path_buf(),
        pinned: None,
    };
    Started(STARTED.with(|started| started.replace(Some(process))))
}

#[cfg(test)]
pub(crate) struct Started(Option<Process>);

#[cfg(test)]
impl Drop for Started {
    fn drop(&mut self) {
        let before = self.0.take();
        STARTED.with(|started| *started.borrow_mut() = before);
    }
}

/// This machine's own profile folder, read from its real config and made by
/// nothing. For the one ignored, manual test that has to name a real chat
/// (`push::tests::send_a_real_push`); every other test reads `profile_dir`.
#[cfg(test)]
pub(crate) fn this_machines_profile() -> Option<PathBuf> {
    let root = crate::paths::home_dir()?.join(".octiqflow");
    let raw = fs::read_to_string(root.join("config.json")).ok()?;
    let cfg: ProfileConfig = serde_json::from_str(&raw).ok()?;
    Some(PathBuf::from(cfg.base).join(cfg.active))
}

/// The pin of the process this thread stands in for, or the test binary's
/// shared one.
#[cfg(test)]
fn tests_pin() -> Pinned {
    static SHARED: std::sync::OnceLock<Pinned> = std::sync::OnceLock::new();
    let own = STARTED.with(|started| {
        started
            .borrow()
            .as_ref()
            .map(|process| process.pinned.clone())
    });
    match own {
        Some(Some(pinned)) => pinned,
        // Its first question: resolve, with no borrow held, and keep it.
        Some(None) => {
            let pinned = resolve();
            STARTED.with(|started| {
                if let Some(process) = started.borrow_mut().as_mut() {
                    process.pinned = Some(pinned.clone());
                }
            });
            pinned
        }
        None => SHARED
            .get_or_init(|| Pinned {
                dir: crate::test_dir::TestDir::new("test-profile").remove_at_exit(),
                fallback_from: None,
            })
            .clone(),
    }
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

/// The active profile's data root, `<base>/<active>/`: the path fixed when
/// this process started. It is not made here and not looked up again, so it
/// is the same answer whether or not the folder is there right now. Ask
/// `available` before promising a write, and make folders under it with
/// `make_dir`.
pub fn profile_dir() -> PathBuf {
    with_pinned(|pinned| pinned.dir.clone())
}

/// Fix the profile folder for this process and say which it is. The first
/// thing a server does, before the owner lock and before any store loads.
pub fn pin() -> Pinned {
    let pinned = with_pinned(Pinned::clone);
    println!("[profile] using {}", pinned.dir.display());
    if let Some(notice) = pinned.notice() {
        eprintln!("[profile] {notice}");
    }
    pinned
}

/// The profile folder, when it is there to be read and written. Otherwise
/// why not, in words for the person: the folder went away under a running
/// server (a drive unplugged, a folder moved or removed), and nothing is
/// written anywhere else in its place.
pub fn available() -> Result<PathBuf, String> {
    with_pinned(|pinned| {
        if pinned.dir.is_dir() {
            Ok(pinned.dir.clone())
        } else {
            Err(gone(&pinned.dir))
        }
    })
}

fn gone(dir: &Path) -> String {
    format!(
        "The profile folder {} is not available right now: its drive is not connected, or the folder was moved or removed. OctiqFlow keeps to the folder it started with and has not switched to another, so nothing was saved. Bring the folder back and try again; nothing needs restarting.",
        dir.display()
    )
}

/// `create_dir_all` for a folder a store is about to write into, with one
/// difference: the profile folder itself is never made again after startup.
/// A store that made its parent folder on every save would otherwise put an
/// empty profile where the real one was unplugged from, and go on writing
/// into it. Anything outside the profile folder is made as before.
pub fn make_dir(dir: &Path) -> Result<(), String> {
    let missing = with_pinned(|pinned| {
        (dir.starts_with(&pinned.dir) && !pinned.dir.is_dir()).then(|| gone(&pinned.dir))
    });
    match missing {
        Some(why) => Err(why),
        None => fs::create_dir_all(dir).map_err(|e| e.to_string()),
    }
}

/// Why a write to `path` failed, for the person: the words of `available`
/// when the cause is that the profile folder is gone, else the system's own.
pub fn write_error(path: &Path, error: std::io::Error) -> String {
    with_pinned(|pinned| {
        if path.starts_with(&pinned.dir) && !pinned.dir.is_dir() {
            gone(&pinned.dir)
        } else {
            error.to_string()
        }
    })
}

/// What the page is told about the folder in use (`profile_status`).
pub fn status() -> serde_json::Value {
    with_pinned(|pinned| {
        let available = pinned.dir.is_dir();
        serde_json::json!({
            "dir": pinned.dir,
            "fallbackFrom": pinned.fallback_from,
            "available": available,
            "notice": if available { pinned.notice() } else { Some(gone(&pinned.dir)) },
        })
    })
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

    /// What a write does while the folder is away: it fails with words that
    /// name the folder and say nothing went anywhere else, the same words
    /// from every store, and no folder is made in its place. When the
    /// folder is back the same write goes through, with no restart.
    #[test]
    fn a_write_while_the_folder_is_away_says_so_and_goes_through_once_it_is_back() {
        let home = Home::with_a_configured_base();
        let _process = started_in(&home.dir);
        let dir = profile_dir();
        assert_eq!(available(), Ok(dir.clone()));
        assert_eq!(status()["available"], true);
        assert!(status()["notice"].is_null());
        let ledger =
            crate::orchestration::OrchestrationStore::load(dir.join("orchestrations.json"));
        let run = |objective: &str| {
            ledger.create_run(
                "chat:lead".into(),
                objective.into(),
                "project".into(),
                home.dir.to_string_lossy().into_owned(),
                Some(2),
            )
        };
        let listed = |id: &str| {
            crate::chat_index::upsert(
                serde_json::from_value(json!({
                    "id": id, "projectId": "project", "title": "Chat", "updatedAt": 100,
                }))
                .unwrap(),
            )
        };

        home.unplug();
        let why = available().unwrap_err();
        assert!(why.contains(&dir.display().to_string()), "{why}");
        assert!(why.contains("has not switched to another"), "{why}");
        assert!(why.contains("nothing was saved"), "{why}");
        assert_eq!(make_dir(&dir.join("sandboxes")), Err(why.clone()));
        assert_eq!(listed("away").unwrap_err(), why);
        assert_eq!(run("While away").unwrap_err(), why);
        assert_eq!(status()["available"], false);
        assert_eq!(status()["notice"], why);
        assert!(!dir.exists(), "the profile folder was made again");
        assert!(!home.default_base().exists());
        // A folder that is not in the profile is made as it always was.
        assert_eq!(make_dir(&home.dir.join("elsewhere").join("deep")), Ok(()));

        home.plug_back();
        assert_eq!(available(), Ok(dir.clone()));
        assert_eq!(make_dir(&dir.join("sandboxes")), Ok(()));
        assert_eq!(listed("back"), Ok(()));
        assert!(run("Back").is_ok());
        assert!(status()["notice"].is_null());
    }

    /// The startup fallback stays as documented, and the server says which
    /// folder it is using: on its log line, and to the page.
    #[test]
    fn a_server_that_started_on_the_default_base_says_which_folder_it_uses() {
        let home = Home::with_a_configured_base();
        home.unplug();
        let _process = started_in(&home.dir);
        let pinned = pin();
        assert_eq!(pinned.dir, home.default_base().join("default"));
        assert_eq!(pinned.fallback_from, Some(home.configured()));
        let notice = pinned.notice().unwrap();
        assert!(
            notice.contains(&home.configured().display().to_string()),
            "{notice}"
        );
        assert!(
            notice.contains(&pinned.dir.display().to_string()),
            "{notice}"
        );
        assert!(notice.contains("until it is restarted"), "{notice}");
        assert_eq!(status()["notice"], notice);
        assert_eq!(status()["fallbackFrom"], json!(home.configured()));
        assert_eq!(status()["available"], true);

        // On the configured base there is nothing to say.
        let plain = Home::with_a_configured_base();
        let _other = started_in(&plain.dir);
        let pinned = pin();
        assert_eq!(pinned.dir, plain.configured().join("default"));
        assert_eq!(pinned.notice(), None);
        assert!(status()["fallbackFrom"].is_null());
    }

    /// A test outside any process of its own never touches this machine's
    /// profile or its config: it shares one folder with the test binary.
    #[test]
    fn a_test_without_a_home_of_its_own_shares_one_scratch_profile() {
        let shared = profile_dir();
        assert!(shared.starts_with(std::env::temp_dir()), "{shared:?}");
        assert_eq!(profile_dir(), shared);
        assert_eq!(config_path(), None);
        let other = std::thread::spawn(profile_dir).join().unwrap();
        assert_eq!(other, shared);
    }
}

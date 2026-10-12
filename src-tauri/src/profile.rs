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
    /// The same folder with every link in its path resolved, as it was at
    /// startup: the other spelling a path in the profile can come under (a
    /// vault's folder is kept resolved). `dir` when it could not be asked.
    pub real: PathBuf,
    /// The configured base, when it could not be reached at startup and the
    /// default base is in use in its place.
    pub fallback_from: Option<PathBuf>,
}

impl Pinned {
    /// The profile folder as `path` names it and what is below it, when
    /// `path` is the profile folder or lies in it, under either spelling.
    fn holds<'a>(&self, path: &'a Path) -> Option<(&Path, &'a Path)> {
        [&self.dir, &self.real]
            .into_iter()
            .find_map(|root| Some((root.as_path(), path.strip_prefix(root).ok()?)))
    }

    /// Why the profile folder cannot be used right now, if it cannot.
    fn missing(&self) -> Option<String> {
        (!self.dir.is_dir()).then(|| gone(&self.dir))
    }

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
    let real = |dir: &Path| crate::paths::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    // The only two places the profile folder is ever made.
    if fs::create_dir_all(&dir).is_ok() {
        return Pinned {
            real: real(&dir),
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
        real: real(&fallback),
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
            .get_or_init(|| {
                let dir = crate::test_dir::TestDir::new("test-profile").remove_at_exit();
                Pinned {
                    real: crate::paths::canonicalize(&dir).unwrap_or_else(|_| dir.clone()),
                    dir,
                    fallback_from: None,
                }
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
        // Not through `create_dir_all` above: this runs while the profile
        // folder is being resolved, and `~/.octiqflow` is never inside it.
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

/// **The one door a folder is made through, anywhere in the host.** It is
/// `fs::create_dir_all` with one difference: nothing it does makes the
/// profile folder. After startup that folder is only ever found, never
/// made: an empty profile put where the real one was unplugged from would
/// be written into, and the chats, roster and ledger of the real one forked.
///
/// The rule is in the filesystem, not in a look followed by a create. For
/// a path in the profile, only the folders BELOW the profile folder are
/// made, one `create_dir` each, starting from the profile folder: with that
/// folder gone the first of them fails, whenever it went. The older form
/// asked `is_dir` and then made the folder and its parents, and a profile
/// that went between the two was made again.
///
/// No module calls the standard library's own (`tests::
/// no_module_makes_a_folder_but_through_the_profile`): whether a path can
/// lie in the profile is not for each caller to judge. A vault, a project,
/// the attachments folder or `~/.octiqflow/mcp` is inside it on a machine
/// whose profile base is set that way.
pub fn create_dir_all(dir: &Path) -> std::io::Result<()> {
    with_pinned(|pinned| {
        let Some((root, below)) = pinned.holds(dir) else {
            return fs::create_dir_all(dir);
        };
        let gone = |error: std::io::Error| match pinned.missing() {
            Some(why) => std::io::Error::other(why),
            None => error,
        };
        let mut at = root.to_path_buf();
        for part in below.components() {
            let std::path::Component::Normal(name) = part else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!(
                        "{} is not a plain path in the profile folder",
                        dir.display()
                    ),
                ));
            };
            at.push(name);
            match fs::create_dir(&at) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && at.is_dir() => {}
                Err(error) => return Err(gone(error)),
            }
        }
        // Nothing was made, so nothing has said the profile folder is there.
        match pinned.missing() {
            Some(why) => Err(std::io::Error::other(why)),
            None => Ok(()),
        }
    })
}

/// `create_dir_all` for a store about to write into `dir`, in words: the
/// profile's one sentence when the folder is gone, else the system's own.
pub fn make_dir(dir: &Path) -> Result<(), String> {
    create_dir_all(dir).map_err(|e| e.to_string())
}

/// Why a write to `path` failed, for the person: the words of `available`
/// when the cause is that the profile folder is gone, else the system's own.
pub fn write_error(path: &Path, error: std::io::Error) -> String {
    with_pinned(|pinned| {
        pinned
            .holds(path)
            .and_then(|_| pinned.missing())
            .unwrap_or_else(|| error.to_string())
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

        /// The profile folder of this home's server.
        pub(crate) fn profile(&self) -> PathBuf {
            self.configured().join(DEFAULT_PROFILE)
        }

        /// Where the profile folder is while it is moved away.
        pub(crate) fn kept(&self) -> PathBuf {
            self.configured().join("kept-elsewhere")
        }

        /// The profile folder is moved away and NOTHING is put where it
        /// was, so its base is still there: whatever makes a folder and
        /// its parents under it makes the profile folder again.
        pub(crate) fn move_away(&self) {
            fs::rename(self.profile(), self.kept()).unwrap();
        }

        /// The folder that was moved away is put back, in place of
        /// whatever was made where it was.
        pub(crate) fn move_back(&self) {
            match fs::symlink_metadata(self.profile()) {
                Ok(meta) if meta.is_dir() => fs::remove_dir_all(self.profile()).unwrap(),
                Ok(_) => fs::remove_file(self.profile()).unwrap(),
                Err(_) => {}
            }
            fs::rename(self.kept(), self.profile()).unwrap();
        }

        /// The profile folder is moved away and another folder is made at
        /// its path: same name, same place, not the same folder.
        pub(crate) fn replace(&self) {
            self.move_away();
            fs::create_dir_all(self.profile().join("chats")).unwrap();
        }
    }

    /// Every file and folder under `dir`, with each file's bytes: what a
    /// write would have to change to have happened.
    pub(crate) fn everything_in(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut found = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(at) = stack.pop() {
            for entry in fs::read_dir(&at).unwrap() {
                let path = entry.unwrap().path();
                let name = path
                    .strip_prefix(dir)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if path.is_dir() {
                    found.push((format!("{name}/"), Vec::new()));
                    stack.push(path);
                } else {
                    found.push((name, fs::read(&path).unwrap()));
                }
            }
        }
        found.sort();
        found
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

    fn said() -> serde_json::Value {
        json!({ "type": "assistant", "message": { "content": "Said" } })
    }

    fn listed(id: &str) -> Result<(), String> {
        crate::chat_index::upsert(
            serde_json::from_value(json!({
                "id": id, "projectId": "project", "title": "Chat", "updatedAt": 100,
            }))
            .unwrap(),
        )
    }

    /// RULE 1 (review of 8169dd3): nothing the host does makes the profile
    /// folder after startup. A call that makes a folder and its parents
    /// makes the profile folder too when the path lies under it, so every
    /// one goes through this module (`create_dir_all`, `make_dir`), which
    /// makes only what is below the profile folder. A direct call is found
    /// here. `bin/octiq.rs` is a binary of its own and cannot call in.
    #[test]
    fn no_module_makes_a_folder_but_through_the_profile() {
        /// The files that may call the standard library, how often, and why.
        const ALLOWED: &[(&str, usize, &str)] = &[
            (
                "profile.rs",
                5,
                "the profile folder at startup (configured, then the default base), ~/.octiqflow for the bootstrap pointer, which is read while the folder is being resolved, and the two halves of the one door: outside the profile, and one folder at a time below it",
            ),
            (
                "bin/octiq.rs",
                2,
                "a binary of its own that cannot link this crate; it makes ~/.octiqflow/bus, or OCTIQ_BUS_DIR",
            ),
        ];
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![src.clone()];
        let mut found = std::collections::BTreeMap::<String, Vec<usize>>::new();
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let name = path
                    .strip_prefix(&src)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                // A file that is a test module, or the tests' own scratch.
                if !name.ends_with(".rs") || name.ends_with("tests.rs") || name == "test_dir.rs" {
                    continue;
                }
                let text = fs::read_to_string(&path).unwrap();
                let lines: Vec<&str> = text.lines().collect();
                let mut in_tests = false;
                for (at, line) in lines.iter().enumerate() {
                    // `#[cfg(test)]` on a module, at the file's top level,
                    // until the brace that closes it.
                    if *line == "#[cfg(test)]"
                        && lines
                            .get(at + 1)
                            .is_some_and(|next| next.contains("mod ") && next.ends_with('{'))
                    {
                        in_tests = true;
                    } else if in_tests && *line == "}" {
                        in_tests = false;
                    }
                    let code = line.trim_start();
                    let makes = [concat!("fs::create", "_dir"), concat!("Dir", "Builder")]
                        .iter()
                        .any(|call| code.contains(call))
                        || (code.starts_with("use ") && code.contains(concat!("create", "_dir")));
                    if makes && !in_tests && !code.starts_with("//") {
                        found.entry(name.clone()).or_default().push(at + 1);
                    }
                }
            }
        }
        let mut offenders = Vec::new();
        for (file, lines) in &found {
            let allowed = ALLOWED.iter().find(|(name, _, _)| name == file);
            match allowed {
                Some((_, count, _)) if lines.len() == *count => {}
                Some((_, count, why)) => offenders.push(format!(
                    "{file}: {} calls at lines {lines:?}, {count} allowed ({why})",
                    lines.len()
                )),
                None => offenders.push(format!("{file}: lines {lines:?}")),
            }
        }
        assert!(
            offenders.is_empty(),
            "make folders with profile::make_dir or profile::create_dir_all, which never make the profile folder:\n{}",
            offenders.join("\n")
        );
    }

    /// RULE 1, the window itself: `make_dir` asked whether the profile
    /// folder was there and then made the folder and its parents, so a
    /// profile that went between the two was made again, empty. One thread
    /// makes folders under the profile as fast as it can while the folder
    /// is moved away and back under it; the folder is never there while it
    /// is away.
    #[test]
    fn the_profile_folder_is_never_made_again_however_its_going_is_timed() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let home = Home::with_a_configured_base();
        let (profile, kept) = (home.profile(), home.kept());
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let maker = std::thread::spawn({
            let (home, stop) = (home.dir.to_path_buf(), stop.clone());
            move || {
                let _process = started_in(&home);
                let dir = profile_dir();
                let mut made = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    made += 1;
                    let folder = dir.join(format!("made-{made}"));
                    let _ = make_dir(&folder.join("deep"));
                    let _ = fs::remove_dir_all(&folder);
                }
            }
        });
        while !profile.is_dir() {
            std::thread::yield_now();
        }
        let until = std::time::Instant::now() + std::time::Duration::from_millis(1500);
        let (mut moves, mut remade) = (0, false);
        while !remade && std::time::Instant::now() < until {
            // Windows refuses to move a folder something is being made in.
            if fs::rename(&profile, &kept).is_err() {
                continue;
            }
            moves += 1;
            std::thread::sleep(std::time::Duration::from_micros(300));
            remade = profile.exists();
            if !remade {
                fs::rename(&kept, &profile).unwrap();
            }
        }
        stop.store(true, Ordering::Relaxed);
        maker.join().unwrap();
        assert!(
            !remade,
            "the profile folder was made again while it was away (move {moves})"
        );
    }

    /// RULE 2 (review of 8169dd3, probe REPLACE): the folder a server
    /// started with is that directory, not whatever is at its path. The
    /// profile is moved away and a new folder is made where it was: the
    /// host answers as for a profile that is gone and writes nothing into
    /// the stranger. The original put back is the profile again.
    #[test]
    fn a_folder_made_where_the_profile_was_is_not_the_profile() {
        let home = Home::with_a_configured_base();
        let _process = started_in(&home.dir);
        let dir = profile_dir();
        crate::profile_lock::acquire("server").unwrap();
        let key = format!("test-replaced-{}", uuid::Uuid::new_v4().simple());
        assert_eq!(crate::transcript::append(&key, &said()), Some(1));

        home.replace();
        let stranger = everything_in(&dir);
        let why = available().expect_err("a folder made at the profile's path was taken for it");
        assert!(why.contains(&dir.display().to_string()), "{why}");
        assert!(
            why.contains("is not the folder OctiqFlow started with"),
            "{why}"
        );
        assert!(why.contains("nothing was saved"), "{why}");
        assert_eq!(status()["available"], false);
        assert_eq!(status()["notice"], why);
        assert_eq!(make_dir(&dir.join("sandboxes")), Err(why.clone()));
        assert_eq!(crate::transcript::append(&key, &said()), None);
        assert_eq!(crate::transcript::append_synced(&key, &said()), None);
        assert_eq!(listed("in-the-stranger").unwrap_err(), why);
        assert_eq!(
            everything_in(&dir),
            stranger,
            "something was written into the folder that took the profile's place"
        );

        home.move_back();
        assert_eq!(available(), Ok(dir));
        assert_eq!(crate::transcript::append(&key, &said()), Some(2));
    }

    /// RULE 2 (probe SYMLINK): the path now leads to another folder, which
    /// has a `chats` folder and a record of its own under the same name.
    #[cfg(unix)]
    #[test]
    fn a_link_to_another_folder_where_the_profile_was_is_not_the_profile() {
        let home = Home::with_a_configured_base();
        let _process = started_in(&home.dir);
        let dir = profile_dir();
        crate::profile_lock::acquire("server").unwrap();
        let key = format!("test-linked-{}", uuid::Uuid::new_v4().simple());
        let notice = json!({ "type": "octiq_task_reopened", "taskId": "task_1" });
        assert_eq!(crate::transcript::append_synced(&key, &notice), Some(1));
        let token = crate::transcript::generation(&key).unwrap();
        let name = crate::transcript::path_for(&key).unwrap();
        let name = name.file_name().unwrap();

        let other = home.configured().join("other");
        fs::create_dir_all(other.join("chats")).unwrap();
        fs::write(other.join("chats").join(name), "{\"type\":\"assistant\"}\n").unwrap();
        home.move_away();
        std::os::unix::fs::symlink(&other, &dir).unwrap();
        let stranger = everything_in(&other);

        let why = available().expect_err("a link to another folder was taken for the profile");
        assert!(
            why.contains("is not the folder OctiqFlow started with"),
            "{why}"
        );
        assert_eq!(
            crate::transcript::confirm_synced(&key, &token),
            None,
            "a receipt made for the profile's record was confirmed on another folder's"
        );
        assert_eq!(crate::transcript::append(&key, &said()), None);
        assert_eq!(everything_in(&other), stranger);

        home.move_back();
        assert_eq!(crate::transcript::confirm_synced(&key, &token), Some(()));
    }

    /// RULE 2 (probe REPLACE, the receipt): a token is confirmed only on
    /// the directory it was made for. The folder that took the profile's
    /// place holds a record under the same name and no notice; the token
    /// taken in the real one is refused there, and honoured again when the
    /// real one is back.
    #[test]
    fn a_receipt_is_not_confirmed_in_a_folder_that_took_the_profiles_place() {
        let home = Home::with_a_configured_base();
        let _process = started_in(&home.dir);
        crate::profile_lock::acquire("server").unwrap();
        let key = format!("test-receipt-{}", uuid::Uuid::new_v4().simple());
        let notice = json!({ "type": "octiq_task_reopened", "taskId": "task_1" });
        assert_eq!(crate::transcript::append_synced(&key, &notice), Some(1));
        let token = crate::transcript::generation(&key).unwrap();
        let record = crate::transcript::path_for(&key).unwrap();
        assert_eq!(crate::transcript::confirm_synced(&key, &token), Some(()));

        home.replace();
        fs::write(&record, "{\"type\":\"assistant\"}\n").unwrap();
        assert_eq!(
            crate::transcript::confirm_synced(&key, &token),
            None,
            "a receipt was given for a record that holds no notice"
        );
        assert_eq!(
            fs::read_to_string(&record).unwrap(),
            "{\"type\":\"assistant\"}\n",
            "the stranger's record was written to"
        );

        home.move_back();
        assert_eq!(crate::transcript::confirm_synced(&key, &token), Some(()));
        assert_eq!(
            crate::transcript::of_type(&key, "octiq_task_reopened").len(),
            1
        );
    }

    /// RULE 2 (probe SECOND): nobody can stop a second server starting in
    /// a fresh folder at the same path, but the first must notice it is no
    /// longer in its folder and stop writing there. Every kind of write the
    /// first one makes is tried; the second server's folder is left as the
    /// second server made it.
    #[test]
    fn a_server_writes_nothing_once_another_started_in_a_folder_made_in_its_place() {
        let home = Home::with_a_configured_base();
        let _process = started_in(&home.dir);
        let dir = profile_dir();
        crate::profile_lock::acquire("server").unwrap();
        let key = format!("test-second-{}", uuid::Uuid::new_v4().simple());
        assert_eq!(crate::transcript::append(&key, &said()), Some(1));
        let ledger =
            crate::orchestration::OrchestrationStore::load(dir.join("orchestrations.json"));
        let projects = crate::workspaces::WorkspaceState::load();
        let prefs = crate::personal_preferences::default_path();
        crate::personal_preferences::save(&prefs, "mine").unwrap();
        let notes = home.dir.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let vault = |writable| crate::memory_vault::Config {
            path: notes.to_string_lossy().into_owned(),
            writable,
        };

        home.replace();
        // A second server starts there: it finds no owner and takes it.
        std::thread::spawn({
            let home = home.dir.to_path_buf();
            let dir = dir.clone();
            move || {
                let _process = started_in(&home);
                assert_eq!(profile_dir(), dir);
                crate::profile_lock::acquire("server").unwrap();
                assert_eq!(available(), Ok(dir));
                assert_eq!(listed("the-second-servers"), Ok(()));
            }
        })
        .join()
        .unwrap();
        let theirs = everything_in(&dir);

        let why = available().expect_err("the first server still takes the folder for its own");
        assert_eq!(crate::transcript::append(&key, &said()), None);
        assert_eq!(crate::transcript::append_synced(&key, &said()), None);
        assert_eq!(listed("the-first-servers").unwrap_err(), why);
        assert_eq!(
            ledger
                .create_run(
                    "chat:lead".into(),
                    "After".into(),
                    "project".into(),
                    home.dir.to_string_lossy().into_owned(),
                    Some(2),
                )
                .unwrap_err(),
            why
        );
        assert_eq!(
            crate::workspaces::add_workspace_impl(
                &projects,
                "Project".into(),
                home.dir.to_string_lossy().into_owned(),
            )
            .unwrap_err(),
            why
        );
        assert_eq!(
            crate::personal_preferences::save(&prefs, "written over theirs").unwrap_err(),
            why
        );
        assert_eq!(
            crate::memory_vault::Vault::profile()
                .configure(vault(true))
                .unwrap_err(),
            why
        );
        assert_eq!(make_dir(&dir.join("sandboxes")), Err(why.clone()));
        crate::web::save_config(&crate::web::WebConfig::default());
        assert_eq!(
            everything_in(&dir),
            theirs,
            "the first server wrote into the second server's folder"
        );
    }

    /// RULE 3 (review of 8169dd3, probe EMPTY): a read from a profile that
    /// is gone is an error, never the value of a first run. The saved
    /// preferences and vault settings read as empty, the person saw a blank
    /// Settings form, and an ordinary Save put the blank form's text over
    /// their rules once the folder was back.
    #[test]
    fn a_read_while_the_folder_is_away_is_an_error_and_never_a_first_runs_value() {
        let home = Home::with_a_configured_base();
        let _process = started_in(&home.dir);
        let dir = profile_dir();
        crate::profile_lock::acquire("server").unwrap();
        let prefs = crate::personal_preferences::default_path();
        // A first run: no file, in a profile that is there. That is empty.
        assert_eq!(crate::personal_preferences::load(&prefs).unwrap().text, "");
        let vault = crate::memory_vault::Vault::profile();
        assert_eq!(vault.settings().unwrap().path, "");
        crate::personal_preferences::save(&prefs, "original saved rules").unwrap();
        let notes = home.dir.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let connected = vault
            .configure(crate::memory_vault::Config {
                path: notes.to_string_lossy().into_owned(),
                writable: true,
            })
            .unwrap();

        // Gone three ways: its drive, the folder itself, and another folder
        // in its place.
        type Way = (fn(&Home), fn(&Home));
        let ways: [Way; 3] = [
            (Home::unplug, Home::plug_back),
            (Home::move_away, Home::move_back),
            (Home::replace, Home::move_back),
        ];
        for (goes, comes_back) in ways {
            goes(&home);
            let why = available().expect_err("the profile folder is not there");
            assert_eq!(
                crate::personal_preferences::load(&prefs).map(|saved| saved.text),
                Err(why.clone()),
                "preferences read as a first run's while the folder was away"
            );
            assert_eq!(
                vault.settings().map(|saved| saved.path),
                Err(why.clone()),
                "the vault's settings read as a first run's while the folder was away"
            );
            assert_eq!(
                crate::personal_preferences::save(&prefs, "typed on a blank form")
                    .map(|saved| saved.text),
                Err(why)
            );
            comes_back(&home);
            assert_eq!(available(), Ok(dir.clone()));
            assert_eq!(
                crate::personal_preferences::load(&prefs).unwrap().text,
                "original saved rules"
            );
            let saved = vault.settings().unwrap();
            assert_eq!((&saved.path, saved.writable), (&connected.path, true));
        }
    }

    /// RULE 3: a store kept in memory goes on answering while the folder
    /// is away, its saves fail in the profile's words, and once the folder
    /// is back it writes what it holds: never an empty reload.
    #[test]
    fn a_store_kept_in_memory_writes_what_it_holds_once_the_folder_is_back() {
        let home = Home::with_a_configured_base();
        let _process = started_in(&home.dir);
        let dir = profile_dir();
        crate::profile_lock::acquire("server").unwrap();
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
        let projects = crate::workspaces::WorkspaceState::load();
        let project = |name: &str| {
            let folder = home.dir.join(name);
            fs::create_dir_all(&folder).unwrap();
            crate::workspaces::add_workspace_impl(
                &projects,
                name.into(),
                folder.to_string_lossy().into_owned(),
            )
        };
        let before = run("Before").unwrap();
        project("first").unwrap();

        home.move_away();
        let why = available().unwrap_err();
        assert_eq!(run("While away").unwrap_err(), why);
        assert_eq!(project("away").unwrap_err(), why);
        // Both still answer from memory.
        let runs = |ledger: &crate::orchestration::OrchestrationStore, id: &str| {
            ledger.snapshot(Some(id)).unwrap().runs.len()
        };
        assert_eq!(runs(&ledger, &before.id), 1);
        assert!(!crate::workspaces::list_workspaces_impl(&projects)
            .unwrap()
            .is_empty());
        assert!(!dir.exists(), "the profile folder was made again");

        home.move_back();
        let back = run("Back").unwrap();
        project("second").unwrap();
        let reloaded =
            crate::orchestration::OrchestrationStore::load(dir.join("orchestrations.json"));
        assert_eq!(
            runs(&reloaded, &before.id),
            1,
            "the ledger was reloaded empty"
        );
        assert_eq!(runs(&reloaded, &back.id), 1);
        let names: Vec<String> =
            crate::workspaces::list_workspaces_impl(&crate::workspaces::WorkspaceState::load())
                .unwrap()
                .into_iter()
                .map(|project| project.name)
                .collect();
        assert!(names.contains(&"first".to_string()), "{names:?}");
        assert!(names.contains(&"second".to_string()), "{names:?}");
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

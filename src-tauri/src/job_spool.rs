//! The spool folder: how `octiq-job` reports a job from a chat whose
//! commands cannot reach the host (`docs/jobs.md`, The spool folder).
//!
//! Codex below Full runs its commands in a sandbox that refuses a connection
//! to `127.0.0.1`, so a wrapper there cannot call `/hook/job`. Each chat
//! launch is therefore also given a folder of its own (`OCTIQ_JOB_SPOOL`) in
//! a place that sandbox can write (the temp folder), and a secret for that
//! launch (`OCTIQ_JOB_SPOOL_CAPABILITY`: a name with no KEY, SECRET or
//! TOKEN in it, which Codex's environment filter can keep from its
//! commands). A wrapper whose call to the hook cannot
//! connect writes its job there instead, as append-only NDJSON in
//! `<folder>/<its own id>.ndjson`: a start, progress, and an end with the
//! real exit code. Each record carries the secret.
//!
//! The host reads each file on from where it stopped, once a second, and
//! hands what it reads to the same store calls the hook makes
//! (`chat_jobs::Store::start_spooled`, `spooled_progress`, `spooled_end`),
//! so events, `chat_jobs`, the idle reaper's hold, the wake told once and a
//! restart's interruption are the hook's own and not repeated here.
//!
//! **Everything in a spool file is untrusted.** The chat a record speaks for
//! comes from its secret, which the host holds in memory for one launch and
//! never writes down: never from the folder or the file's name. A record
//! with no secret, a wrong one, or another launch's is refused, changes
//! nothing, and is logged once for its file. Lines are bounded
//! (`LINE_MAX`), a malformed line is skipped, a last line with no newline
//! yet is waited for, and the store makes the label one line as it does for
//! the hook. The id a record names is the wrapper's own and names only its
//! file: the job the host makes for it gets an id of the host's, so a spool
//! job can never collide with, or speak for, a job of the hook's.

use crate::chat_jobs::{End, Start, Store};
use crate::job_progress::Progress;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The launch's spool folder, as its agent's environment gives it.
pub(crate) const SPOOL_ENV: &str = "OCTIQ_JOB_SPOOL";
/// The launch's spool secret.
pub(crate) const KEY_ENV: &str = "OCTIQ_JOB_SPOOL_CAPABILITY";
/// The longest line a spool file may hold. An end with twenty lines of
/// output, each as long as the store keeps one, is about 9 KB.
const LINE_MAX: usize = 64 * 1024;
/// How much of one file is read in one pass.
const READ_MAX: u64 = 256 * 1024;
/// How many files of one folder are looked at in one pass.
const FILES_MAX: usize = 64;
/// How long an answer to a start (`.ack`) is left for `--detach` to read.
const ACK_KEEP: Duration = Duration::from_secs(15);

/// What the host holds for one launch's folder.
struct Launch {
    chat_key: String,
    session_key: String,
    launch_id: String,
    dir: PathBuf,
    /// SHA-256 of the secret.
    digest: [u8; 32],
    files: BTreeMap<String, Cursor>,
}

/// One spool file, as far as it has been read.
#[derive(Default)]
struct Cursor {
    offset: u64,
    /// A line longer than `LINE_MAX` is being skipped to its newline.
    discarding: bool,
    state: State,
    /// A refusal or a malformed line of this file was logged.
    logged: bool,
    /// That it could not be read was logged.
    unreadable_logged: bool,
    /// When the answer to its start was written.
    ack_at: Option<Instant>,
    /// The file itself is gone (removed by the host, or by someone else).
    removed: bool,
}

#[derive(Default, Clone, PartialEq, Debug)]
enum State {
    /// No start read yet.
    #[default]
    Fresh,
    /// The host's job for it.
    Started(String),
    /// Its start was refused; what follows says nothing.
    Refused,
    /// Its end (or its wrapper's going) was taken into the store.
    Ended(String),
}

/// Every launch's spool folder.
pub(crate) struct Spools {
    root: Option<PathBuf>,
    launches: Mutex<BTreeMap<String, Arc<Mutex<Launch>>>>,
    /// One pass at a time.
    passing: Mutex<()>,
}

fn digest(secret: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(secret.as_bytes()).into()
}

fn same(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter()
        .zip(b.iter())
        .fold(0u8, |diff, (x, y)| diff | (x ^ y))
        == 0
}

/// `<32 hex>.ndjson`, and nothing else is read.
fn spool_stem(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".ndjson")?;
    (stem.len() == 32 && stem.bytes().all(|b| b.is_ascii_hexdigit())).then_some(stem)
}

/// Where the launches' folders go: the temp folder the Codex sandbox may
/// write (`$TMPDIR`, which `excludeTmpdirEnvVar: false` keeps writable),
/// one folder per OS user. Under test, a scratch folder for the binary.
fn default_root() -> PathBuf {
    #[cfg(test)]
    {
        static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        ROOT.get_or_init(|| crate::test_dir::TestDir::new("job-spool").remove_at_exit())
            .clone()
    }
    #[cfg(not(test))]
    {
        #[cfg(unix)]
        let name = format!("octiqflow-job-spool-{}", unsafe { libc::geteuid() });
        #[cfg(not(unix))]
        let name = "octiqflow-job-spool".to_string();
        std::env::temp_dir().join(name)
    }
}

/// Make a folder only this user can open, and check that what is there is
/// that: a real folder (not a link), owned by this user.
fn private_dir(dir: &Path) -> Result<(), String> {
    crate::profile::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if !meta.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions.
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(format!("{} belongs to another user", dir.display()));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    Ok(())
}

impl Default for Spools {
    fn default() -> Self {
        Self::at(default_root())
    }
}

impl Spools {
    /// Spools under `root`, and the folders a server that is gone left
    /// there removed: nobody holds their secrets any more.
    pub(crate) fn at(root: PathBuf) -> Self {
        let root = match private_dir(&root) {
            Ok(()) => Some(root),
            Err(why) => {
                eprintln!("[jobs] no spool folder, so a sandboxed chat's octiq-job reports nothing: {why}");
                None
            }
        };
        if let Some(root) = &root {
            sweep(root, std::process::id(), &crate::profile_lock::alive);
        }
        Self {
            root,
            launches: Mutex::new(BTreeMap::new()),
            passing: Mutex::new(()),
        }
    }

    /// A folder and a secret for the launch about to run: the environment
    /// its agent is given. Empty when no folder can be made; the chat
    /// starts all the same.
    pub(crate) fn open(
        &self,
        chat_key: &str,
        session_key: &str,
        launch_id: &str,
    ) -> Vec<(String, String)> {
        let Some(root) = &self.root else {
            return Vec::new();
        };
        let name = format!("{}-{}", std::process::id(), uuid::Uuid::new_v4().simple());
        let dir = root.join(&name);
        if let Err(why) = private_dir(&dir) {
            eprintln!("[jobs] no spool folder for {chat_key}: {why}");
            return Vec::new();
        }
        let secret = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let launch = Launch {
            chat_key: chat_key.into(),
            session_key: session_key.into(),
            launch_id: launch_id.into(),
            dir: dir.clone(),
            digest: digest(&secret),
            files: BTreeMap::new(),
        };
        match self.launches.lock() {
            Ok(mut launches) => {
                launches.insert(name, Arc::new(Mutex::new(launch)));
            }
            Err(_) => return Vec::new(),
        }
        vec![
            (SPOOL_ENV.into(), dir.to_string_lossy().into_owned()),
            (KEY_ENV.into(), secret),
        ]
    }

    /// One pass over every launch's folder. `live` says whether a launch
    /// (session, launch id) is still the process running, `alive` asks
    /// after a pid. A launch whose process is gone and whose folder holds
    /// nothing unread is removed, folder and secret.
    pub(crate) fn pass(
        &self,
        jobs: &Store,
        live: &dyn Fn(&str, &str) -> bool,
        alive: &dyn Fn(u32) -> bool,
    ) {
        let Ok(_one) = self.passing.try_lock() else {
            return;
        };
        let launches: Vec<(String, Arc<Mutex<Launch>>)> = match self.launches.lock() {
            Ok(launches) => launches
                .iter()
                .map(|(name, launch)| (name.clone(), launch.clone()))
                .collect(),
            Err(_) => return,
        };
        let digests: Vec<[u8; 32]> = launches
            .iter()
            .filter_map(|(_, launch)| launch.lock().ok().map(|l| l.digest))
            .collect();
        let mut finished = Vec::new();
        for (name, launch) in launches {
            let (session, launch_id) = match launch.lock() {
                Ok(l) => (l.session_key.clone(), l.launch_id.clone()),
                Err(_) => continue,
            };
            // Asked with no lock of ours held: the session table is taken
            // before `open` is called.
            let running = live(&session, &launch_id);
            let Ok(mut launch) = launch.lock() else {
                continue;
            };
            if read_launch(&mut launch, &digests, jobs, alive, running) {
                finished.push(name);
            }
        }
        if let Ok(mut launches) = self.launches.lock() {
            for name in finished {
                launches.remove(&name);
            }
        }
    }
}

/// Remove the folders of servers that are gone. A folder is
/// `<server pid>-<id>`; one of a live server, this one or another sharing
/// the temp folder, is left alone.
fn sweep(root: &Path, own: u32, alive: &dyn Fn(u32) -> bool) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = name
            .split_once('-')
            .and_then(|(pid, _)| pid.parse::<u32>().ok())
        else {
            continue;
        };
        if pid != own && !alive(pid) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Read what one launch's folder gained. True when the launch is over:
/// its process is gone and nothing in its folder is left unread.
fn read_launch(
    launch: &mut Launch,
    digests: &[[u8; 32]],
    jobs: &Store,
    alive: &dyn Fn(u32) -> bool,
    running: bool,
) -> bool {
    let listed = match std::fs::read_dir(&launch.dir) {
        Ok(entries) => {
            let mut names: Vec<String> = entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|name| spool_stem(name).is_some())
                .collect();
            names.sort();
            names.truncate(FILES_MAX);
            Some(names)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        // A folder that cannot be listed is not an empty one.
        Err(_) => return false,
    };
    let Some(listed) = listed else {
        // The folder is gone: its files went with it. A job of it whose
        // wrapper died has no end to wait for.
        for cursor in launch.files.values_mut() {
            gone_if_dead(cursor, jobs, alive);
        }
        return !running;
    };
    let listed_set: BTreeSet<&String> = listed.iter().collect();
    for (name, cursor) in launch.files.iter_mut() {
        if !listed_set.contains(name) && !cursor.removed {
            cursor.removed = true;
            gone_if_dead(cursor, jobs, alive);
        }
    }
    let mut unread = false;
    for name in &listed {
        let path = launch.dir.join(name);
        // Only a plain file is opened: not a link, not a pipe.
        if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let cursor = launch.files.entry(name.clone()).or_default();
        cursor.removed = false;
        // Asked before the read: a wrapper dead before it holds no line it
        // has not written yet.
        let dead_before = match &cursor.state {
            State::Started(id) => jobs
                .running_pid(id)
                .and_then(|(_, pid)| pid)
                .is_some_and(|pid| !alive(pid)),
            _ => false,
        };
        let at_end = match read_file(&path, cursor) {
            Ok((lines, at_end)) => {
                cursor.unreadable_logged = false;
                for line in lines {
                    take_line(
                        &line,
                        name,
                        cursor,
                        &launch.chat_key,
                        &launch.dir,
                        &launch.digest,
                        digests,
                        jobs,
                    );
                }
                at_end
            }
            Err(error) => {
                // Not "no events": it stays, and is read again next pass.
                if !cursor.unreadable_logged {
                    eprintln!(
                        "[jobs] spool file {} could not be read, trying again: {error}",
                        path.display()
                    );
                    cursor.unreadable_logged = true;
                }
                unread = true;
                continue;
            }
        };
        if let State::Started(id) = &cursor.state {
            let still = jobs.running_pid(id).is_some_and(|(running, _)| running);
            if !still || (dead_before && at_end) {
                let id = id.clone();
                let _ = jobs.spooled_gone(&id);
                cursor.state = State::Ended(id);
            }
        }
        let done = match &cursor.state {
            // Removed once the store has saved its end.
            State::Ended(_) => !jobs.owes(),
            State::Refused => true,
            // Lines and no start, from a launch that is over.
            State::Fresh => at_end && !running,
            State::Started(_) => false,
        };
        if done {
            if std::fs::remove_file(&path).is_ok() {
                cursor.removed = true;
            }
        } else {
            unread = true;
        }
    }
    // What is left of a file that is gone: its answer, once `--detach` has
    // had time to read it.
    launch.files.retain(|name, cursor| {
        if !cursor.removed {
            return true;
        }
        if cursor.ack_at.is_some_and(|at| at.elapsed() < ACK_KEEP) {
            return true;
        }
        if let Some(stem) = spool_stem(name) {
            let _ = std::fs::remove_file(launch.dir.join(format!("{stem}.ack")));
        }
        false
    });
    if running || unread || !launch.files.is_empty() {
        return false;
    }
    let _ = std::fs::remove_dir_all(&launch.dir);
    true
}

fn gone_if_dead(cursor: &mut Cursor, jobs: &Store, alive: &dyn Fn(u32) -> bool) {
    if let State::Started(id) = &cursor.state {
        let dead = jobs
            .running_pid(id)
            .is_none_or(|(running, pid)| !running || pid.is_none_or(|pid| !alive(pid)));
        if dead {
            let id = id.clone();
            let _ = jobs.spooled_gone(&id);
            cursor.state = State::Ended(id);
        }
    }
}

/// The whole lines a file gained since the cursor, and whether it was read
/// to its end. A last line with no newline yet is left for the next pass.
fn read_file(path: &Path, cursor: &mut Cursor) -> std::io::Result<(Vec<Vec<u8>>, bool)> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    if len < cursor.offset {
        // Cut short by someone: read it again. A second start says nothing
        // and an end is taken once.
        cursor.offset = 0;
        cursor.discarding = false;
    }
    file.seek(SeekFrom::Start(cursor.offset))?;
    let mut bytes = Vec::new();
    (&mut file).take(READ_MAX).read_to_end(&mut bytes)?;
    let mut lines = Vec::new();
    let mut consumed = 0;
    while let Some(at) = bytes[consumed..].iter().position(|&b| b == b'\n') {
        let line = &bytes[consumed..consumed + at];
        if cursor.discarding {
            cursor.discarding = false;
        } else if line.len() <= LINE_MAX {
            lines.push(line.to_vec());
        }
        consumed += at + 1;
    }
    if bytes.len() - consumed > LINE_MAX {
        // Too long to be a record: skipped to its newline.
        cursor.discarding = true;
        consumed = bytes.len();
    }
    cursor.offset += consumed as u64;
    Ok((
        lines,
        cursor.offset + (bytes.len() - consumed) as u64 >= len,
    ))
}

#[allow(clippy::too_many_arguments)]
fn take_line(
    line: &[u8],
    name: &str,
    cursor: &mut Cursor,
    chat_key: &str,
    dir: &Path,
    own: &[u8; 32],
    digests: &[[u8; 32]],
    jobs: &Store,
) {
    let note = |cursor: &mut Cursor, why: &str| {
        if !cursor.logged {
            eprintln!(
                "[jobs] spool file {}: {why}; skipped, nothing changed (said once for this file)",
                dir.join(name).display()
            );
            cursor.logged = true;
        }
    };
    if line.iter().all(u8::is_ascii_whitespace) {
        return;
    }
    let Ok(record) = serde_json::from_slice::<Value>(line) else {
        return note(cursor, "a line that is not JSON");
    };
    let key = record.get("key").and_then(Value::as_str).unwrap_or("");
    if key.is_empty() {
        return note(cursor, "a record with no key");
    }
    let given = digest(key);
    if !same(&given, own) {
        let why = if digests.iter().any(|d| same(d, &given)) {
            "a record with another launch's key"
        } else {
            "a record with a wrong key"
        };
        return note(cursor, why);
    }
    let stem = spool_stem(name).unwrap_or_default();
    let kind = record
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string);
    let state = cursor.state.clone();
    match (kind.as_deref(), &state) {
        (Some("start"), State::Fresh) => {
            let Ok(start) = serde_json::from_value::<Start>(record) else {
                return note(cursor, "a start that does not parse");
            };
            let answer = match jobs.start_spooled(chat_key, start) {
                Ok(job) => match job["id"].as_str() {
                    Some(id) => {
                        cursor.state = State::Started(id.to_string());
                        json!({ "id": id })
                    }
                    None => {
                        cursor.state = State::Refused;
                        json!({ "why": "the host made no job" })
                    }
                },
                Err(why) => {
                    cursor.state = State::Refused;
                    json!({ "why": why })
                }
            };
            write_ack(dir, stem, &answer);
            cursor.ack_at = Some(Instant::now());
        }
        (Some("progress"), State::Started(id)) => {
            let Ok(progress) = serde_json::from_value::<Progress>(record) else {
                return note(cursor, "a progress record that does not parse");
            };
            let _ = jobs.spooled_progress(id, progress);
        }
        (Some("end"), State::Started(id)) => {
            let Ok(end) = serde_json::from_value::<End>(record) else {
                return note(cursor, "an end that does not parse");
            };
            let _ = jobs.spooled_end(id, end);
            cursor.state = State::Ended(id.clone());
        }
        // A second start, anything after an end or a refusal: nothing.
        (Some("start" | "progress" | "end"), _) => {}
        _ => note(cursor, "a record of no known type"),
    }
}

/// The answer to a start, for a `--detach` waiting on it: written whole
/// under a temporary name and renamed, so it is never read in part.
fn write_ack(dir: &Path, stem: &str, answer: &Value) {
    let path = dir.join(format!("{stem}.ack"));
    let temp = dir.join(format!("{stem}.ack-{}", uuid::Uuid::new_v4().simple()));
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .and_then(|mut file| file.write_all(answer.to_string().as_bytes()));
    if written.is_err() || std::fs::rename(&temp, &path).is_err() {
        let _ = std::fs::remove_file(&temp);
    }
}

/// The wrapper's half: one job's spool file, written a whole line at a
/// time.
pub(crate) struct Writer {
    file: std::fs::File,
    key: String,
    dir: PathBuf,
    id: String,
    broken: bool,
}

impl Writer {
    /// The launch's folder and secret, from the agent's environment.
    pub(crate) fn from_env(get: &dyn Fn(&str) -> Option<String>) -> Option<(PathBuf, String)> {
        let dir = get(SPOOL_ENV).filter(|d| !d.trim().is_empty())?;
        let key = get(KEY_ENV).filter(|k| !k.is_empty())?;
        Some((PathBuf::from(dir), key))
    }

    /// A new file for one job, made by this wrapper alone.
    pub(crate) fn create(dir: &Path, key: &str) -> std::io::Result<Self> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut options = std::fs::OpenOptions::new();
        options.append(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(dir.join(format!("{id}.ndjson")))?;
        Ok(Self {
            file,
            key: key.into(),
            dir: dir.into(),
            id,
            broken: false,
        })
    }

    /// Append one record, a whole line in one write. A write that fails, or
    /// writes part of the line, ends the spool for this job: what follows
    /// would join a broken line.
    pub(crate) fn record(&mut self, kind: &str, fields: Value) -> bool {
        if self.broken {
            return false;
        }
        let mut record = match fields {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        record.insert("key".into(), json!(self.key));
        record.insert("type".into(), json!(kind));
        let mut line = Value::Object(record).to_string().into_bytes();
        line.push(b'\n');
        match self.file.write(&line) {
            Ok(written) if written == line.len() => true,
            _ => {
                self.broken = true;
                false
            }
        }
    }

    /// Where the host answers this job's start.
    pub(crate) fn answer_path(&self) -> PathBuf {
        self.dir.join(format!("{}.ack", self.id))
    }
}

/// The host's answer to a start (`Writer::answer_path`), when it has
/// written one within `wait`.
pub(crate) fn wait_answer(path: &Path, wait: Duration) -> Option<Value> {
    let deadline = Instant::now() + wait;
    loop {
        if let Some(answer) = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        {
            return Some(answer);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
#[path = "job_spool_tests.rs"]
mod tests;

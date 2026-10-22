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
//! **Everything in a spool folder is untrusted.** The chat a record speaks
//! for comes from its secret, which the host holds in memory for one launch
//! and never writes down: never from the folder or the file's name. A file
//! whose first line carries no secret, a wrong one or another launch's is
//! refused whole, remembered by name, size and modification time, and never
//! read again, never deleted, and never counted against anything a real job
//! needs. Lines are bounded (`LINE_MAX`), a malformed line is skipped, a
//! last line with no newline yet is waited for, and the store makes the
//! label one line as it does for the hook. The id a record names is the
//! wrapper's own and names only its file: the job the host makes for it gets
//! an id of the host's, so a spool job can never collide with, or speak for,
//! a job of the hook's. Nothing in a folder is followed through a link, and
//! only a regular file is ever removed (`job_spool_folder.rs`).
//!
//! **Absence is never removal.** A file is gone only when the system says
//! so of that very name (`NotFound` on its open or stat); one a listing did
//! not show, or one not looked at this pass, is not.

#[path = "job_spool_folder.rs"]
mod folder;

use crate::chat_jobs::{End, Start, Store};
use crate::job_progress::Progress;
pub(crate) use folder::process_alive;
use folder::{Folder, Meta};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
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
/// How many files not yet vetted are looked at in one folder in one pass,
/// each for its first line alone (at most `LINE_MAX` and a byte): about
/// 4 MB a pass at the most. Files already known to be the launch's are read
/// every pass and are not counted; files known to be refused cost a stat.
const LOOK_MAX: usize = 64;
/// How long an answer to a start (`.ack`) is left for `--detach` to read.
const ACK_KEEP: Duration = Duration::from_secs(15);

/// What the host holds for one launch's folder.
struct Launch {
    chat_key: String,
    session_key: String,
    launch_id: String,
    /// The folder's name under the root, and its path for what is logged.
    name: String,
    dir: PathBuf,
    /// (device, inode) of the folder the host made, asked again each pass.
    ident: (u64, u64),
    /// SHA-256 of the secret.
    digest: [u8; 32],
    files: BTreeMap<String, Cursor>,
    /// Invocation receipts survive removal/replacement of a spool filename.
    starts: Mutex<BTreeMap<String, Value>>,
    /// The next place in the line of files waiting to be looked at.
    next_ticket: u64,
    /// That the folder could not be opened as itself was logged.
    folder_logged: bool,
}

/// What a file is to the launch, by its first line.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Vetted {
    /// Not looked at yet, or its first line was not whole: waits its turn
    /// in the line, by ticket.
    Waiting(u64),
    /// Its first line carries the launch's secret: read every pass.
    Ours,
    /// Refused: the file as it was when refused. Never read again while it
    /// is that file.
    Foreign(Meta),
}

/// One spool file, as far as it has been read.
struct Cursor {
    vetted: Vetted,
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
    pending_ack: Option<Value>,
    /// Done with: the system said it is gone, or the host removed it.
    removed: bool,
    /// How many times the file was opened, for the tests to count.
    opened: u32,
}

impl Cursor {
    fn waiting(ticket: u64) -> Self {
        Self {
            vetted: Vetted::Waiting(ticket),
            offset: 0,
            discarding: false,
            state: State::Fresh,
            logged: false,
            unreadable_logged: false,
            ack_at: None,
            pending_ack: None,
            removed: false,
            opened: 0,
        }
    }
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

/// The root every launch's folder is in, held open.
struct Root {
    path: PathBuf,
    folder: Folder,
}

/// Every launch's spool folder.
pub(crate) struct Spools {
    root: Option<Root>,
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

/// The record a line is, when it carries the launch's own secret; else
/// why not.
fn keyed(line: &[u8], own: &[u8; 32], digests: &[[u8; 32]]) -> Result<Value, &'static str> {
    let Ok(record) = serde_json::from_slice::<Value>(line) else {
        return Err("a line that is not JSON");
    };
    let key = record.get("key").and_then(Value::as_str).unwrap_or("");
    if key.is_empty() {
        return Err("a record with no key");
    }
    let given = digest(key);
    if !same(&given, own) {
        return Err(if digests.iter().any(|d| same(d, &given)) {
            "a record with another launch's key"
        } else {
            "a record with a wrong key"
        });
    }
    Ok(record)
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

impl Default for Spools {
    fn default() -> Self {
        Self::at(default_root())
    }
}

impl Spools {
    /// Spools under `root`, and the folders a server that is gone left
    /// there removed: nobody holds their secrets any more. The root must be
    /// a real folder of this user's (not a link); it is made 0700.
    pub(crate) fn at(root: PathBuf) -> Self {
        let made = crate::profile::create_dir_all(&root)
            .and_then(|()| Folder::adopt(&root))
            .map_err(|e| format!("{}: {e}", root.display()));
        let root = match made {
            Ok(folder) => Some(Root { path: root, folder }),
            Err(why) => {
                eprintln!("[jobs] no spool folder, so a sandboxed chat's octiq-job reports nothing: {why}");
                None
            }
        };
        if let Some(root) = &root {
            sweep(&root.folder, std::process::id(), &process_alive);
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
        let dir = root.path.join(&name);
        let made = crate::profile::create_dir_all(&dir).and_then(|()| root.folder.adopt_in(&name));
        let ident = match made {
            Ok(folder) => folder.ident,
            Err(why) => {
                eprintln!(
                    "[jobs] no spool folder for {chat_key}: {}: {why}",
                    dir.display()
                );
                return Vec::new();
            }
        };
        let secret = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let launch = Launch {
            chat_key: chat_key.into(),
            session_key: session_key.into(),
            launch_id: launch_id.into(),
            name: name.clone(),
            dir: dir.clone(),
            ident,
            digest: digest(&secret),
            files: BTreeMap::new(),
            starts: Mutex::new(BTreeMap::new()),
            next_ticket: 0,
            folder_logged: false,
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
    /// after a pid (`process_alive`). A launch whose process is gone and
    /// whose folder holds nothing of its own left unread is over: its
    /// secret is dropped and its folder removed if nothing else is in it.
    pub(crate) fn pass(
        &self,
        jobs: &Store,
        live: &dyn Fn(&str, &str) -> bool,
        alive: &dyn Fn(u32) -> bool,
    ) {
        let Some(root) = &self.root else {
            return;
        };
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
            if read_launch(&mut launch, &root.folder, &digests, jobs, alive, running) {
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

/// Clear the folders of servers that are gone. A folder is
/// `<server pid>-<id>`; one of a live server, this one or another sharing
/// the temp folder, is left alone, and so is one whose server cannot be
/// asked about (`process_alive` says gone only for "no such process"). In a
/// gone server's folder only regular files under the names a launch uses
/// are removed, never through a link, then the folder if that empties it.
fn sweep(root: &Folder, own: u32, alive: &dyn Fn(u32) -> bool) {
    let Ok(names) = root.names() else {
        return;
    };
    for name in names {
        let Some(pid) = name
            .split_once('-')
            .and_then(|(pid, _)| pid.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == own || alive(pid) {
            continue;
        }
        // A link, another user's folder or one not 0700 is not ours.
        let Ok(folder) = root.open_in(&name) else {
            continue;
        };
        for file in folder.names().unwrap_or_default() {
            let launch_file = spool_stem(&file).is_some()
                || file
                    .split_once(".ack")
                    .is_some_and(|(stem, _)| spool_stem(&format!("{stem}.ndjson")).is_some());
            if launch_file {
                let _ = folder.remove_file(&file);
            }
        }
        let _ = root.remove_dir_in(&name);
    }
}

fn log_once(flag: &mut bool, what: impl FnOnce() -> String) {
    if !*flag {
        eprintln!("[jobs] {}", what());
        *flag = true;
    }
}

/// Read what one launch's folder gained. True when the launch is over:
/// its process is gone and nothing of its own in its folder is left
/// unread.
fn read_launch(
    launch: &mut Launch,
    root: &Folder,
    digests: &[[u8; 32]],
    jobs: &Store,
    alive: &dyn Fn(u32) -> bool,
    running: bool,
) -> bool {
    // The folder the host made, asked for again by its name under the
    // root, never through a link: anything else there is not read.
    let folder = match root.open_in(&launch.name) {
        Ok(folder) if folder.ident == launch.ident => {
            launch.folder_logged = false;
            folder
        }
        Ok(_) => {
            let dir = launch.dir.display().to_string();
            log_once(&mut launch.folder_logged, || {
                format!("spool folder {dir} is not the folder made for its launch; left alone")
            });
            return false;
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            // The folder is gone, and its files with it: a job of it whose
            // wrapper died has no end to wait for.
            for cursor in launch.files.values_mut() {
                if cursor.vetted == Vetted::Ours && !cursor.removed {
                    cursor.removed = true;
                    gone_if_dead(cursor, jobs, alive);
                }
            }
            return !running;
        }
        Err(error) => {
            // A link, another user's, a mode that is not 0700, or a folder
            // that cannot be opened: not an empty one.
            let dir = launch.dir.display().to_string();
            log_once(&mut launch.folder_logged, || {
                format!("spool folder {dir} could not be opened as itself, left alone: {error}")
            });
            return false;
        }
    };
    // A folder that cannot be listed is not an empty one.
    let Ok(listed) = folder.names() else {
        return false;
    };
    // New names join the end of the line, in name order.
    for name in listed {
        if spool_stem(&name).is_some() && !launch.files.contains_key(&name) {
            launch
                .files
                .insert(name, Cursor::waiting(launch.next_ticket));
            launch.next_ticket += 1;
        }
    }

    let own = launch.digest;
    let mut unread = false;
    let mut line = Vec::new();
    let names: Vec<String> = launch.files.keys().cloned().collect();
    for name in &names {
        let Some(cursor) = launch.files.get_mut(name) else {
            continue;
        };
        if cursor.removed {
            retry_ack(&folder, name, cursor);
            continue;
        }
        match cursor.vetted {
            // Read every pass, listed or not: only `NotFound` on its own
            // open says it is gone.
            Vetted::Ours => {
                let ctx = Ctx {
                    folder: &folder,
                    chat_key: &launch.chat_key,
                    dir: &launch.dir,
                    own: &own,
                    digests,
                    jobs,
                    starts: &launch.starts,
                };
                unread |= read_ours(&ctx, name, cursor, alive, running);
            }
            Vetted::Foreign(was) => match folder.stat(name) {
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    launch.files.remove(name);
                }
                Ok(now) if same_file(&was, &now) => cursor.vetted = Vetted::Foreign(now),
                // Removed and made again under the name: looked at again.
                Ok(_) => {
                    *cursor = Cursor::waiting(launch.next_ticket);
                    launch.next_ticket += 1;
                    unread = true;
                }
                Err(_) => {}
            },
            Vetted::Waiting(ticket) => line.push((ticket, name.clone())),
        }
    }

    // The files waiting, oldest ticket first. One whose first line is not
    // whole yet goes to the back, so what came before a real job can hold
    // it back for a bounded number of passes and no more.
    line.sort();
    for (looked, (_, name)) in line.into_iter().enumerate() {
        if looked >= LOOK_MAX {
            // Left for a later pass: not gone, and not refused.
            unread = true;
            continue;
        }
        let Some(cursor) = launch.files.get_mut(&name) else {
            continue;
        };
        let path = launch.dir.join(&name);
        match vet(&folder, &name, cursor, &own, digests) {
            Vet::Ours => {
                cursor.vetted = Vetted::Ours;
                let ctx = Ctx {
                    folder: &folder,
                    chat_key: &launch.chat_key,
                    dir: &launch.dir,
                    own: &own,
                    digests,
                    jobs,
                    starts: &launch.starts,
                };
                unread |= read_ours(&ctx, &name, cursor, alive, running);
            }
            Vet::Foreign(meta, why) => {
                cursor.vetted = Vetted::Foreign(meta);
                log_once(&mut cursor.logged, || {
                    format!(
                        "spool file {} refused: {why}; never read again, nothing changed",
                        path.display()
                    )
                });
            }
            Vet::Gone => {
                launch.files.remove(&name);
            }
            Vet::NotYet => {
                cursor.vetted = Vetted::Waiting(launch.next_ticket);
                launch.next_ticket += 1;
                unread = true;
            }
        }
    }

    // What is left of an own file that is gone: its answer, once
    // `--detach` has had time to read it. Only an answer the host wrote.
    launch.files.retain(|name, cursor| {
        if !cursor.removed || cursor.pending_ack.is_some() {
            return true;
        }
        if cursor.ack_at.is_some_and(|at| at.elapsed() < ACK_KEEP) {
            return true;
        }
        if let (Some(_), Some(stem)) = (cursor.ack_at, spool_stem(name)) {
            let _ = folder.remove_file(&format!("{stem}.ack"));
        }
        false
    });
    let holds = launch.files.values().any(|cursor| match cursor.vetted {
        Vetted::Ours | Vetted::Waiting(_) => true,
        Vetted::Foreign(_) => false,
    });
    if running || unread || holds {
        return false;
    }
    // The launch is over. Its folder goes if nothing is left in it; one that
    // still holds files the host did not take is left as it is.
    if let Err(error) = root.remove_dir_in(&launch.name) {
        if error.kind() != ErrorKind::NotFound {
            eprintln!(
                "[jobs] spool folder {} left in place: {error}",
                launch.dir.display()
            );
        }
    }
    true
}

/// Whether a refused file is still the file that was refused: the same
/// inode, no shorter, no older. A file that only grew is still refused.
fn same_file(was: &Meta, now: &Meta) -> bool {
    now.ino == was.ino && now.len >= was.len && now.mtime >= was.mtime && now.regular == was.regular
}

enum Vet {
    Ours,
    Foreign(Meta, String),
    /// The system says there is no such file.
    Gone,
    /// The first line is not whole yet, or the file could not be read now.
    NotYet,
}

/// Look at a file's first line, and only that.
fn vet(
    folder: &Folder,
    name: &str,
    cursor: &mut Cursor,
    own: &[u8; 32],
    digests: &[[u8; 32]],
) -> Vet {
    let (mut file, meta) = match folder.open_file(name) {
        Ok(opened) => opened,
        Err(error) if error.kind() == ErrorKind::NotFound => return Vet::Gone,
        Err(error) if error.kind() == ErrorKind::InvalidInput => {
            // A link, a folder or a pipe under a spool file's name.
            return match folder.stat(name) {
                Ok(meta) => Vet::Foreign(meta, error.to_string()),
                Err(e) if e.kind() == ErrorKind::NotFound => Vet::Gone,
                Err(_) => Vet::NotYet,
            };
        }
        Err(_) => return Vet::NotYet,
    };
    cursor.opened += 1;
    let mut bytes = Vec::new();
    if (&mut file)
        .take(LINE_MAX as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return Vet::NotYet;
    }
    match bytes.iter().position(|&b| b == b'\n') {
        Some(at) => match keyed(&bytes[..at], own, digests) {
            Ok(_) => Vet::Ours,
            Err(why) => Vet::Foreign(meta, format!("its first line is {why}")),
        },
        None if bytes.len() > LINE_MAX => Vet::Foreign(
            meta,
            "its first line is too long to be a record".to_string(),
        ),
        None => Vet::NotYet,
    }
}

/// What reading one of the launch's own files needs.
struct Ctx<'a> {
    folder: &'a Folder,
    chat_key: &'a str,
    dir: &'a Path,
    own: &'a [u8; 32],
    digests: &'a [[u8; 32]],
    jobs: &'a Store,
    starts: &'a Mutex<BTreeMap<String, Value>>,
}

/// Read on in one of the launch's own files. True while something of it is
/// left unread.
fn read_ours(
    ctx: &Ctx,
    name: &str,
    cursor: &mut Cursor,
    alive: &dyn Fn(u32) -> bool,
    running: bool,
) -> bool {
    retry_ack(ctx.folder, name, cursor);
    let jobs = ctx.jobs;
    let path = ctx.dir.join(name);
    // Asked before the read: a wrapper dead before it holds no line it has
    // not written yet.
    let dead_before = match &cursor.state {
        State::Started(id) => jobs
            .running_pid(id)
            .and_then(|(_, pid)| pid)
            .is_some_and(|pid| !alive(pid)),
        _ => false,
    };
    let read = ctx.folder.open_file(name).and_then(|(file, meta)| {
        cursor.opened += 1;
        read_file(file, meta.len, cursor)
    });
    let at_end = match read {
        Ok((lines, at_end)) => {
            cursor.unreadable_logged = false;
            for line in lines {
                take_line(&line, name, cursor, ctx);
            }
            at_end
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            // The system says the file is gone: what it held unread is
            // gone with it.
            cursor.removed = true;
            gone_if_dead(cursor, jobs, alive);
            return false;
        }
        Err(error) => {
            // Not "no events", and not gone: it stays, and is read again
            // next pass.
            log_once(&mut cursor.unreadable_logged, || {
                format!(
                    "spool file {} could not be read, trying again: {error}",
                    path.display()
                )
            });
            return true;
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
    if !done || cursor.pending_ack.is_some() {
        return true;
    }
    match ctx.folder.remove_file(name) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => eprintln!(
            "[jobs] spool file {} read to its end and left in place: {error}",
            path.display()
        ),
    }
    cursor.removed = true;
    false
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
fn read_file(
    mut file: std::fs::File,
    len: u64,
    cursor: &mut Cursor,
) -> std::io::Result<(Vec<Vec<u8>>, bool)> {
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

fn take_line(line: &[u8], name: &str, cursor: &mut Cursor, ctx: &Ctx) {
    let note = |cursor: &mut Cursor, why: &str| {
        log_once(&mut cursor.logged, || {
            format!(
                "spool file {}: {why}; skipped, nothing changed (said once for this file)",
                ctx.dir.join(name).display()
            )
        });
    };
    if line.iter().all(u8::is_ascii_whitespace) {
        return;
    }
    let record = match keyed(line, ctx.own, ctx.digests) {
        Ok(record) => record,
        Err(why) => return note(cursor, why),
    };
    let jobs = ctx.jobs;
    let kind = record
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string);
    let state = cursor.state.clone();
    match (kind.as_deref(), &state) {
        (Some("start"), State::Fresh) => {
            // New wrappers name their invocation independently of the file.
            // Legacy starts use their canonical content (including wrapper pid).
            let identity = record
                .get("invocationId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(|id| format!("id:{id}"))
                .unwrap_or_else(|| format!("legacy:{:?}", digest(&record.to_string())));
            let Ok(start) = serde_json::from_value::<Start>(record) else {
                return note(cursor, "a start that does not parse");
            };
            let mut starts = ctx.starts.lock().unwrap_or_else(|e| e.into_inner());
            let answer = starts
                .entry(identity)
                .or_insert_with(|| match jobs.start_spooled(ctx.chat_key, start) {
                    Ok(job) if job["id"].is_string() => json!({ "id": job["id"] }),
                    Ok(_) => json!({ "why": "the host made no job" }),
                    Err(why) => json!({ "why": why }),
                })
                .clone();
            cursor.state = match answer["id"].as_str() {
                Some(id) => State::Started(id.to_string()),
                None => State::Refused,
            };
            cursor.pending_ack = Some(answer);
            retry_ack(ctx.folder, name, cursor);
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
/// under a new temporary name (never through a link) and renamed over the
/// answer's name, so it is never read in part. A link planted at that name
/// is replaced as a name; what it pointed at is not touched.
fn write_ack(folder: &Folder, stem: &str, answer: &Value) -> std::io::Result<()> {
    let name = format!("{stem}.ack");
    let temp = format!("{stem}.ack-{}", uuid::Uuid::new_v4().simple());
    let written = folder.write_new(&temp, answer.to_string().as_bytes());
    let result = written.and_then(|()| folder.rename(&temp, &name));
    if result.is_err() {
        let _ = folder.remove_file(&temp);
    }
    result
}

fn retry_ack(folder: &Folder, name: &str, cursor: &mut Cursor) {
    if let (Some(stem), Some(answer)) = (spool_stem(name), cursor.pending_ack.as_ref()) {
        if write_ack(folder, stem, answer).is_ok() {
            cursor.ack_at = Some(Instant::now());
            cursor.pending_ack = None;
        }
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
        record.insert("invocationId".into(), json!(self.id));
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

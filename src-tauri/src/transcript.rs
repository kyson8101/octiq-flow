//! What was said, kept where it cannot be lost.
//!
//! A chat's agent runs here, on this machine, and keeps running whether or not
//! anyone is watching — that is what makes parallel chats work. But the record
//! of what it said lived only in whichever browser happened to be attached, and
//! events go out over a broadcast channel with no replay. So:
//!
//!   * close the laptop mid-answer and the rest of that answer is simply gone,
//!     even though the agent finished it perfectly well;
//!   * a chat started on the phone does not exist on the laptop at all.
//!
//! Both are the same mistake — the record was in the wrong place. Every event
//! is now appended here first, with a sequence number, and the browser says
//! where it got to. Reconnecting asks for everything after that.
//!
//! ## Why a file per chat, and JSONL
//!
//! Append-only is the whole access pattern: events only ever arrive at the end,
//! and a reader only ever wants "everything after N". A line-per-event file
//! does that with no index, survives a crash mid-write (a torn last line is
//! dropped on read), and can be read with `tail` when something looks wrong.
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use serde::Serialize;
use serde_json::Value;

/// One recorded event: its position, and what it was.
#[derive(Debug, Clone, Serialize)]
pub struct Recorded {
    /// 1-based position in this chat. A client that has seen 7 asks for 7.
    pub seq: u64,
    pub event: Value,
}

/// The folder chat records live in: `chats` in the profile folder, which is
/// fixed when the server starts (`profile::profile_dir`). `None` while that
/// folder is not there: `chats` is made inside it when missing, the profile
/// folder itself never is (`profile::make_dir`), so a drive that went away
/// gets no empty profile written where it was.
///
/// **And `None` while the folder at that path is not the one the server
/// started with** (`profile::Pinned`): asked on every call, never
/// remembered. Every path a record is read, written, counted or confirmed
/// by comes from here, so nothing kept for a record (its count, its
/// generation, its folder's resolved name) is ever used against a folder
/// that only shares the profile's path.
///
/// Tests never see the real profile here — and `reconcile` DELETES files in
/// this folder, which is not a thing a test should be able to do to
/// someone's chats. They share one temporary profile per test binary, or
/// stand in a profile of their own (`profile::started_in`).
pub(crate) fn chats_dir() -> Option<PathBuf> {
    chats_folder().ok()
}

/// `chats_dir`, or why there is none, in the profile's own words: for what
/// answers the person, where "not found" would read as "nothing saved".
pub(crate) fn chats_folder() -> Result<PathBuf, String> {
    let dir = crate::profile::profile_dir().join("chats");
    crate::profile::make_dir(&dir)?;
    Ok(dir)
}

/// Where a chat's record lives. `None` when the key is not a safe file name —
/// keys come from a browser, so a key with a slash in it must never become a
/// path somewhere else.
pub(crate) fn path_for(key: &str) -> Option<PathBuf> {
    if !safe_key(key) {
        return None;
    }
    Some(chats_dir()?.join(file_name(key)))
}

/// Whether `path_for` names a file for `key`, the folder aside.
fn safe_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':')
}

/// The name of a chat's record in the chats folder.
fn file_name(key: &str) -> String {
    // ':' is legal on macOS but reads badly in a shell, and is the one
    // character our keys use that is not already file-safe everywhere.
    format!("{}.jsonl", key.replace(':', "_"))
}

/// The next sequence number for each record, so appending does not have to
/// count. By the record's identity (`identity`), never by the chat's key:
/// two keys can name one file, and one file has one count.
///
/// Counting the file on every append looks harmless and is quadratic: a
/// streaming reply emits an event per delta, so a long answer would re-read
/// thousands of lines thousands of times. The file is read once, on the first
/// append after startup, and counted in memory after that.
static NEXT_SEQ: Mutex<Option<HashMap<PathBuf, u64>>> = Mutex::new(None);
// Bounded hashes, not copies of init lists. Always accessed inside NEXT_SEQ.
static WRITE_LISTS: Mutex<Option<HashMap<PathBuf, crate::record_storage::Lists>>> =
    Mutex::new(None);

/// A record reserved for storage migration cannot hand a new delivery flow
/// a generation that the imminent rewrite would invalidate. None is already
/// the receipt consumers' retry/unconfirmed path; tokens themselves are unchanged.
static STORAGE_HELD: Mutex<Option<std::collections::HashSet<PathBuf>>> = Mutex::new(None);

pub(crate) struct StorageHold(PathBuf);
impl Drop for StorageHold {
    fn drop(&mut self) {
        if let Some(held) = STORAGE_HELD
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            held.remove(&self.0);
        }
    }
}

pub(crate) fn hold_storage(path: &Path) -> Result<StorageHold, String> {
    let _appending = NEXT_SEQ.lock().map_err(|e| e.to_string())?;
    let record = identity(path);
    if !STORAGE_HELD
        .lock()
        .map_err(|e| e.to_string())?
        .get_or_insert_with(std::collections::HashSet::new)
        .insert(record.clone())
    {
        return Err("chat record is already reserved for storage migration".into());
    }
    Ok(StorageHold(record))
}

/// The append lock, held. Asked for by what reads or moves a record's
/// generation, so neither can be done without it.
type Appending<'a> = std::sync::MutexGuard<'a, Option<HashMap<PathBuf, u64>>>;

/// **One record, one identity: the file as the filesystem tells files
/// apart, not the text of a path.** It is the folder with every link in it
/// resolved, and the file's name, folded to lower case where that folder's
/// filesystem takes two spellings of a name for one file (the default on
/// macOS and Windows). So `chat:ABC` and `chat:abc` are one record there
/// and two on a filesystem that tells them apart, as are `chat:x` and
/// `chat_x` everywhere, which were always one file name.
///
/// It does not ask whether the file exists, so a record that is not made
/// yet has the identity it will have: a count or a generation kept for it
/// is still its own after the first write, under any spelling. While the
/// folder itself is not there (the profile folder is away) the path stands
/// as it was spelled; nothing is written then, and a token taken then is
/// refused once the folder is back, which costs one more look.
///
/// Names are folded as ASCII: a chat's key holds nothing else (`path_for`).
/// Two hard links to one file are two names and are not told to be one;
/// the host makes none.
fn identity(path: &Path) -> PathBuf {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return path.to_path_buf();
    };
    let Some((folder, folds_case)) = folder_identity(parent) else {
        return path.to_path_buf();
    };
    if folds_case {
        folder.join(name.to_string_lossy().to_ascii_lowercase())
    } else {
        folder.join(name)
    }
}

/// A compaction start hold covers every spelling that names this record,
/// including `chat:x` / `chat_x` and filesystem case aliases.
pub(crate) fn record_claim(path: &Path) -> String {
    format!("@record:{}", identity(path).display())
}

pub(crate) fn key_record_claim(key: &str) -> Option<String> {
    path_for(key).map(|path| record_claim(&path))
}

/// A folder as the filesystem resolves it, and whether it takes two
/// spellings of a name for one entry. `None` while the folder is not there.
///
/// Asked of the filesystem once per folder and kept: resolving a path costs
/// a call per component (0.4 ms for a profile's chats folder on macOS),
/// which is nothing once and far too much on every line of a streamed
/// reply. What is kept is a name for the folder the server started in, to
/// key counts and generations by; it is not evidence that the folder at
/// the path is still that one. That is asked each time, before any path
/// reaches here (`chats_dir`), and again before a receipt is given
/// (`confirm_synced`).
fn folder_identity(folder: &Path) -> Option<(PathBuf, bool)> {
    static FOLDERS: Mutex<Option<HashMap<PathBuf, (PathBuf, bool)>>> = Mutex::new(None);
    let mut known = FOLDERS.lock().unwrap_or_else(|e| e.into_inner());
    let known = known.get_or_insert_with(HashMap::new);
    if let Some(found) = known.get(folder) {
        return Some(found.clone());
    }
    let resolved = crate::paths::canonicalize(folder).ok()?;
    let found = (resolved.clone(), folds_case(&resolved));
    known.insert(folder.to_path_buf(), found.clone());
    Some(found)
}

/// Whether `folder` (resolved) is reached under another spelling of its own
/// name: asked of the filesystem, since that is a fact of the volume and
/// not of the platform. A name with no letter to respell cannot be asked
/// and answers no, which only ever keeps two records apart.
fn folds_case(folder: &Path) -> bool {
    let Some(name) = folder.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let respelled: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() {
                c.to_ascii_uppercase()
            } else {
                c.to_ascii_lowercase()
            }
        })
        .collect();
    respelled != name
        && crate::paths::canonicalize(folder.with_file_name(respelled))
            .is_ok_and(|other| other == folder)
}

/// Which record a chat's file holds now: the file it is (`identity`), and
/// how far that file's record has moved on.
///
/// A chat can lose its record and get another under the same name while
/// the server runs: the person clears it (`forget`) and the next thing said
/// in it makes the file again. So "this record is synced" is a receipt only
/// for the lines of the record that is there now, and whoever saw a line in
/// a record, or wrote one into it, says which record that was
/// (`generation`) when asking for the receipt (`confirm_synced`).
///
/// **The token names its file.** A bare number said only "never moved on",
/// which two different files both are; a token taken for one file is
/// refused for any other, whatever their numbers. The profile folder is
/// fixed at startup, so a chat's key cannot come to name another file while
/// the server runs; this is what holds if anything ever makes it.
///
/// The number moves, under the append lock, whenever the host does
/// something to a record that can take a line out of it:
///
/// - `forget` and `forget_file` remove it;
/// - `rewrite_numbered` replaces a host event's line (`is_host_event`). A
///   rewrite keeps every line in its place, and what it changes today is
///   stream pieces and tool results (`record_trim`). Storage migrations also
///   move generation, while preserving every host fact and logical seq.
///
/// Nothing else the host does removes, empties or replaces a record file:
/// the page's file editor refuses one (`fsbrowse::write_file_impl`). Kept
/// in memory: a restart begins every record anew, and nobody holds a
/// receipt across one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Generation {
    record: PathBuf,
    number: Arc<u64>,
}

/// Lives currently observed by a receipt/debt holder. The table owns only
/// weak references: a token keeps its own life known for as long as needed.
/// Removing an unobserved entry proves nothing about history, but there is
/// then no token left that could mistake that removal for `Held::Moved`.
///
/// The old bounded move log raised a global floor when full. That made even
/// an untouched record's token read as Moved, paying unrelated answer debts.
/// Live tokens must never be evicted to meet a bookkeeping capacity.
#[derive(Default)]
struct Generations {
    observed: HashMap<PathBuf, Weak<u64>>,
    last: u64,
    /// Sweep once per batch of new entries, even if many lives are pinned.
    sweep_at: usize,
}

/// Maximum unobserved bookkeeping between sweeps, in addition to live tokens.
const GENERATIONS_KEPT: usize = 16_384;

impl Generations {
    fn number(&mut self, record: &Path, kept: usize) -> Arc<u64> {
        if let Some(life) = self.observed.get(record).and_then(Weak::upgrade) {
            return life;
        }
        if self.observed.len() >= self.sweep_at.max(kept) {
            self.observed.retain(|_, life| life.strong_count() != 0);
            self.observed.shrink_to(self.observed.len().max(kept));
            self.sweep_at = self.observed.len() + kept;
        }
        self.last += 1;
        let life = Arc::new(self.last);
        self.observed
            .insert(record.to_path_buf(), Arc::downgrade(&life));
        life
    }

    fn move_on(&mut self, record: &Path) {
        // Only an actual record mutation calls this. Old tokens retain their
        // old life; any new capture gets a different one under the append lock.
        self.observed.remove(record);
    }
}

/// Read and written only with the append lock held.
static GENERATIONS: Mutex<Option<Generations>> = Mutex::new(None);

/// Whether a record's line is a host event's: an object whose own `type`
/// is one this app made up (`octiq_…`). Asked of the line's top level by
/// parsing it, not of its bytes: a host event written with other spacing
/// is still one, and a `type` inside something else is not. A line that
/// will not parse is taken for one, which only ever holds a receipt back.
fn is_host_event(line: &[u8]) -> bool {
    #[derive(serde::Deserialize)]
    struct Typed<'a> {
        #[serde(rename = "type", borrow, default)]
        kind: Option<std::borrow::Cow<'a, str>>,
    }
    serde_json::from_slice::<Typed>(line).map_or(true, |line| {
        line.kind.is_some_and(|kind| kind.starts_with("octiq_"))
    })
}

fn generation_of(_appending: &Appending, record: &Path) -> Generation {
    let mut generations = GENERATIONS.lock().unwrap_or_else(|e| e.into_inner());
    Generation {
        record: record.to_path_buf(),
        number: generations
            .get_or_insert_with(Generations::default)
            .number(record, GENERATIONS_KEPT),
    }
}

/// The record `record` (an identity) is not the one it was: every receipt
/// asked for with the generation it had is refused.
fn next_generation(_appending: &Appending, record: &Path) {
    let mut generations = GENERATIONS.lock().unwrap_or_else(|e| e.into_inner());
    generations
        .get_or_insert_with(Generations::default)
        .move_on(record);
}

/// Which record `key` has now, to be handed to `confirm_synced` with what
/// is read from it or written to it afterwards. `None` for a key that
/// names no record, the profile is unavailable, or storage migration has
/// temporarily reserved it. A delivery with no token remains unconfirmed.
pub fn generation(key: &str) -> Option<Generation> {
    let path = path_for(key)?;
    let appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    let record = identity(&path);
    if STORAGE_HELD
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|held| held.contains(&record))
    {
        return None;
    }
    Some(generation_of(&appending, &record))
}

/// A cheap freshness check for a browser retaining a chat window. Unlike a
/// durability receipt, the wire generation names the physical file and stays
/// stable across server restarts where creation time is available.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordHead {
    pub last_seq: u64,
    pub generation: String,
}

pub(crate) fn record_head(key: &str) -> Result<RecordHead, String> {
    crate::profile::available()?;
    if !safe_key(key) {
        return Err("invalid chat key".into());
    }
    let path = chats_folder()?.join(file_name(key));
    let record = identity(&path);
    // An old record has no stored seq field. Count it once, outside the
    // append lock, and publish only if no append/clear/rewrite intervened.
    for _ in 0..3 {
        let (file, stamp, seen) = {
            let appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
            crate::profile::available()?;
            let stamp = match record_stamp(&path) {
                Ok(stamp) => stamp,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    crate::profile::available()?;
                    return Ok(RecordHead {
                        last_seq: 0,
                        generation: "missing".into(),
                    });
                }
                Err(e) => return Err(record_read_error(e)),
            };
            if let Some(next) = appending.as_ref().and_then(|counts| counts.get(&record)) {
                return Ok(RecordHead {
                    last_seq: next - 1,
                    generation: stamp.generation(),
                });
            }
            let file = File::open(&path).map_err(record_read_error)?;
            (file, stamp, generation_of(&appending, &record))
        };
        #[cfg(test)]
        HEAD_SCAN.with(|hook| {
            if let Some(hook) = hook.borrow_mut().take() {
                hook();
            }
        });
        let mut last_seq = 0;
        try_each_stored_line(file, |seq, _| last_seq = seq).map_err(record_read_error)?;
        let mut appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
        crate::profile::available()?;
        if source_unchanged(&path, &stamp, &seen, &appending).is_ok() {
            appending
                .get_or_insert_with(HashMap::new)
                .insert(record.clone(), last_seq + 1);
            return Ok(RecordHead {
                last_seq,
                generation: stamp.generation(),
            });
        }
    }
    Err("the chat's record changed while reading its head; try again".into())
}

fn record_read_error(error: std::io::Error) -> String {
    crate::profile::available()
        .err()
        .unwrap_or_else(|| format!("the chat's record could not be read: {error}"))
}

#[cfg(test)]
thread_local! {
    static HEAD_SCAN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

/// Record an event and return its sequence number.
///
/// Best-effort: if this cannot write, the event still reaches anyone currently
/// attached. Losing the ability to catch up later is bad; losing the live
/// stream because the disk is full would be worse.
pub fn append(key: &str, event: &Value) -> Option<u64> {
    write(key, event, false)
}

/// `append` for a line another record will call delivered: it answers only
/// once the line is synced to the disk itself, not merely handed to the OS,
/// so a crash cannot take back a line that was confirmed.
pub fn append_synced(key: &str, event: &Value) -> Option<u64> {
    write(key, event, true)
}

fn write(key: &str, event: &Value, synced: bool) -> Option<u64> {
    let path = path_for(key)?;
    let record = identity(&path);

    let mut appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    let list_event = event["type"] == "system"
        && matches!(event["subtype"].as_str(), Some("init" | "commands_changed"));
    // Most events are typing pieces: neither clone their JSON nor clone a
    // dictionary on every few characters. Only list events can change it.
    let mut lists = list_event.then(|| {
        let mut writers = WRITE_LISTS.lock().unwrap_or_else(|e| e.into_inner());
        let writers = writers.get_or_insert_with(HashMap::new);
        if writers.len() >= 256 && !writers.contains_key(&record) {
            writers.clear();
        }
        writers.get(&record).cloned().unwrap_or_else(|| {
            let mut lists = crate::record_storage::Lists::default();
            if let Ok(file) = File::open(&path) {
                for_each_stored_line(file, |seq, line| {
                    if memchr::memmem::find(line, b"\"system\"").is_some() {
                        if let Ok(event) = serde_json::from_slice(line) {
                            lists.observe(&event, seq);
                        }
                    }
                });
            }
            lists
        })
    });
    let trim = event.get("tool_use_result").is_some()
        || event.get("toolUseResult").is_some()
        || (event["type"] == "system" && event["subtype"] == "hook_response");
    let mut stored = (list_event || trim).then(|| event.clone());
    if let Some(stored) = stored.as_mut() {
        crate::record_storage::trim_display_only(stored);
        if let Some(lists) = lists.as_mut() {
            let seq = appending
                .as_ref()
                .and_then(|counts| counts.get(&record))
                .copied()
                .unwrap_or_else(|| count(&path) + 1);
            lists.encode(stored, seq);
        }
    }
    let line = serde_json::to_string(stored.as_ref().unwrap_or(event)).ok()?;
    let (seq, file, existed) = put(&mut appending, &path, record.clone(), &line, synced)?;
    if let Some(lists) = lists {
        WRITE_LISTS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_or_insert_with(HashMap::new)
            .insert(record, lists);
    }
    if synced {
        file.sync_data().ok()?;
        if !existed {
            // A new file is only durable once its folder entry is. A folder
            // that cannot be synced leaves the line on disk but unproven:
            // `None`, so no ledger confirms it (the next look finds it there).
            sync_dir(path.parent()?).ok()?;
        }
    }
    Some(seq)
}

/// Put `line` at the end of the record at `path` and number it, with the
/// append lock held. Answers its number, the file it went into and whether
/// that file was there before. Nothing is synced here.
///
/// `whole` first ends a last line a crash left half written (counted as a
/// line): the new one must not be glued onto it and lost with it.
fn put(
    appending: &mut Appending,
    path: &Path,
    record: PathBuf,
    line: &str,
    whole: bool,
) -> Option<(u64, File, bool)> {
    let counts = appending.get_or_insert_with(HashMap::new);
    let seq = match counts.get(&record) {
        Some(next) => *next,
        // First write this run: find out where the file already ends.
        None => count(path) + 1,
    };

    let existed = path.exists();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .read(whole)
        .open(path)
        .ok()?;
    if whole && !ends_in_newline(&mut file) {
        file.write_all(b"\n").ok()?;
    }
    // Only claim the number once the line is actually on disk, so a failed
    // write cannot leave a gap that `since` would read straight past.
    writeln!(file, "{line}").ok()?;
    let seq = seq.checked_add(crate::record_storage::span(line.as_bytes()) - 1)?;
    counts.insert(record, seq + 1);
    Some((seq, file, existed))
}

/// What a record answered when asked to hold a line for good (`append_in`,
/// `receipt`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Held {
    /// The record is the one that was named, and it is synced as it is
    /// now, with its folder: a receipt for every line in it.
    Confirmed,
    /// The record is the one that was named, or could not be asked. No
    /// line in it is known to be on the disk: nothing is confirmed.
    Unconfirmed,
    /// The record that was named is gone: removed, or its host events
    /// replaced. Nothing was written to what has its name now.
    Moved,
}

/// Put `event` into the record `seen`, and into no other: whether the chat
/// still has that record is asked and the line is appended in ONE step
/// under the append lock, and so is its receipt (`receipt`). With the
/// line's number when it was written.
///
/// For a line that belongs to a history: an answer handed over in a chat
/// the person has since cleared is not put into whatever was started under
/// the chat's name afterwards. A caller that asks `generation` first and
/// appends after lets a `/clear` land between the two, where the old line
/// then goes into the new record (review 2b of the UI batch, N1: every one
/// of five fresh histories got the old answer, with an ordinary 63 MB
/// record to read in between). Under the lock a removal comes before this,
/// which then writes nothing, or after it, and takes the line with the
/// record it was written into.
pub fn append_in(key: &str, seen: &Generation, event: &Value) -> (Held, Option<u64>) {
    let (Some(path), Ok(line)) = (path_for(key), serde_json::to_string(event)) else {
        return (Held::Unconfirmed, None);
    };
    let record = identity(&path);
    let mut appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    if generation_of(&appending, &record) != *seen {
        return (Held::Moved, None);
    }
    let Some((seq, file, _)) = put(&mut appending, &path, record, &line, true) else {
        return (Held::Unconfirmed, None);
    };
    drop(file);
    let held = match synced(&appending, &path) {
        Some(()) => Held::Confirmed,
        None => Held::Unconfirmed,
    };
    (held, Some(seq))
}

/// A record read to its end by `walk_marked`, with what is needed to put a
/// line after exactly that end and nowhere else (`append_after_walk`).
///
/// `len` and `seq` are the end of what was read: bytes, and the logical seq
/// of its last line. `stamp` names the file that was read, `generation` the
/// life of the record it belongs to; both are taken under the append lock
/// together with the opening of the file, so they describe the very file the
/// walk read, even if another is published under the name before it ends.
pub(crate) struct Walked {
    generation: Generation,
    stamp: Option<RecordStamp>,
    len: u64,
    seq: u64,
}

/// What `append_after_walk` did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum After {
    /// Nothing was added since the walk ended; the line is written, with this seq.
    Written(u64),
    /// The record has grown past the end that was read. Nothing was written;
    /// read the new tail (`walk_on`) and ask again.
    Grew,
    /// The record is not the one that was read (removed, replaced, or its
    /// history moved on) or it is shorter than what was read. Nothing was
    /// written; read the whole record again.
    Moved,
}

impl RecordStamp {
    /// The same file, whatever has been appended to it since.
    fn same_file(&self, other: &RecordStamp) -> bool {
        #[cfg(unix)]
        if self.inode != other.inode {
            return false;
        }
        self.created == other.created
    }
}

fn same_file(seen: &Option<RecordStamp>, now: &Option<RecordStamp>) -> bool {
    match (seen, now) {
        (None, None) => true,
        (Some(a), Some(b)) => a.same_file(b),
        _ => false,
    }
}

#[cfg(test)]
thread_local! {
    static WALK_END: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
}

/// Run `hook` once, the next time a walk (or tail read) of this thread has read to
/// its end and nothing has been written yet: the instant a record can still
/// change before a line is appended after it.
#[cfg(test)]
pub(crate) fn after_walk_hook(hook: impl FnMut() + 'static) {
    WALK_END.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
thread_local! {
    static PARTIAL_READ: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
}

/// Run `hook` once, the next time a walk of this thread has just read a last
/// line that had no line end yet and has not yet read on: the instant a writer
/// can finish that line between two reads.
#[cfg(test)]
pub(crate) fn after_partial_line_hook(hook: impl FnMut() + 'static) {
    PARTIAL_READ.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
fn partial_line_read() {
    if let Some(mut hook) = PARTIAL_READ.with(|slot| slot.borrow_mut().take()) {
        hook();
    }
}

#[cfg(test)]
fn walk_ended() {
    // Taken out while it runs: the hook itself appends and may read again.
    if let Some(mut hook) = WALK_END.with(|slot| slot.borrow_mut().take()) {
        hook();
    }
}

/// `walk`, for a reader that is going to put a line after what it read and
/// must know nothing came between. Reads the record without any lock; the
/// file and its identity are fixed under the append lock when it is opened.
/// A chat with no record is an empty one (`len` 0).
pub(crate) fn walk_marked(key: &str, mut see: impl FnMut(u64, &[u8])) -> Result<Walked, String> {
    let unread = |e: std::io::Error| format!("the chat's record could not be read: {e}");
    let path = path_for(key).ok_or_else(|| {
        chats_folder()
            .err()
            .unwrap_or_else(|| "the chat has no record that can be read".into())
    })?;
    let (file, stamp, generation) = {
        let appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
        let record = identity(&path);
        if STORAGE_HELD
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|held| held.contains(&record))
        {
            return Err("the chat's record is being rewritten; try again".into());
        }
        let generation = generation_of(&appending, &record);
        match File::open(&path) {
            Ok(file) => {
                let meta = file.metadata().map_err(unread)?;
                if meta.is_dir() {
                    (None, None, generation)
                } else {
                    (Some(file), stamp_from_metadata(meta).ok(), generation)
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (None, None, generation),
            Err(e) => return Err(unread(e)),
        }
    };
    let mut walked = Walked {
        generation,
        stamp,
        len: 0,
        seq: 0,
    };
    let Some(file) = file else {
        #[cfg(test)]
        walk_ended();
        return Ok(walked);
    };
    // The end that is marked is the end of the last WHOLE line (one with its
    // line end). A last line without one is a write in progress or a cut one:
    // a writer may finish it before the next read, and then its two halves
    // would be read as two lines. It is not counted, not shown to `see`, and
    // everything from its start on is a tail (`walk_on`).
    let (mut len, mut last) = (0, 0);
    try_each_line_at(file, |seq, line, at| {
        if at.terminated {
            len = at.end;
            last = seq;
            see(seq, line);
        }
    })
    .map_err(unread)?;
    walked.len = len;
    walked.seq = last;
    #[cfg(test)]
    walk_ended();
    Ok(walked)
}

/// Read what was added to the record since `walked` ended, without any lock,
/// and move `walked` to the new end. Lines reach `see` as stored lines with
/// their continuing seq. `false` when the record is not the file `walked`
/// read: nothing was read, and the caller reads the whole record again.
pub(crate) fn walk_on(
    key: &str,
    walked: &mut Walked,
    mut see: impl FnMut(u64, &[u8]),
) -> Result<bool, String> {
    use std::io::{Seek, SeekFrom};
    let unread = |e: std::io::Error| format!("the chat's record could not be read: {e}");
    let path =
        path_for(key).ok_or_else(|| "the chat has no record that can be read".to_string())?;
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(unread(e)),
    };
    let now = file
        .metadata()
        .map_err(unread)
        .map(|meta| stamp_from_metadata(meta).ok())?;
    // A record that did not exist when the walk began may exist now: its
    // whole content is the tail.
    let adopted = walked.stamp.is_none() && now.is_some();
    if !adopted && !same_file(&walked.stamp, &now) {
        return Ok(false);
    }
    if now.is_none() {
        return Ok(false);
    }
    file.seek(SeekFrom::Start(walked.len)).map_err(unread)?;
    let mut reader = BufReader::new(file);
    let (mut line, mut seq, mut len) = (Vec::new(), walked.seq, walked.len);
    while reader.read_until(b'\n', &mut line).map_err(unread)? > 0 {
        // A last line with no line end yet is not read: it is read whole, from
        // its start, by the next call (`walk_marked` stops before it too).
        let Some(body) = line.strip_suffix(b"\n") else {
            #[cfg(test)]
            partial_line_read();
            break;
        };
        len += line.len() as u64;
        let body = body.strip_suffix(b"\r").unwrap_or(body);
        seq = seq
            .checked_add(crate::record_storage::span(body))
            .ok_or_else(|| "chat record sequence overflow".to_string())?;
        see(seq, body);
        line.clear();
    }
    if adopted {
        walked.stamp = now;
    }
    walked.len = len;
    walked.seq = seq;
    #[cfg(test)]
    walk_ended();
    Ok(true)
}

/// Put `event` after the end `walked` read, and only if the record is still
/// that file, in the same life, with nothing added after that end: all asked
/// and the line appended in ONE step under the append lock, like `append_in`.
/// A record that moved on, or one that grew, writes nothing (`After`).
///
/// **What is marked is the end of the last whole line, never a byte past it.**
/// A last line with no line end is a write in progress (or one that was cut):
/// the walk stops before it and does not show it, and the record is then
/// longer than the mark, so the answer is `Grew` until that line is whole and
/// read from its start. A cut line that is never finished leaves the answer
/// `Grew` for good: the caller gives up after its attempts and writes nothing.
///
/// For a line whose meaning depends on what the record said when it was
/// decided (a dismissal is only true of a turn nobody has picked up): the
/// decision is made from a lock-free read of the whole record, and the
/// append is refused if even one line came after it. The heavy read stays
/// outside the lock; what is under it is a stat, a one-byte read and the
/// append.
pub(crate) fn append_after_walk(
    key: &str,
    walked: &Walked,
    event: &Value,
) -> Result<After, String> {
    let (Some(path), Ok(line)) = (path_for(key), serde_json::to_string(event)) else {
        return Err("the chat's record could not be written".into());
    };
    let record = identity(&path);
    let mut appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    if generation_of(&appending, &record) != walked.generation {
        return Ok(After::Moved);
    }
    let now = match fs::symlink_metadata(&path) {
        Ok(meta) => stamp_from_metadata(meta).ok(),
        Err(_) => None,
    };
    if !same_file(&walked.stamp, &now) {
        return Ok(if walked.stamp.is_none() && now.is_some() {
            After::Grew
        } else {
            After::Moved
        });
    }
    if let Some(now) = &now {
        if now.len < walked.len {
            return Ok(After::Moved);
        }
        if now.len > walked.len {
            // `walked.len` is the end of a whole line, so anything after it,
            // a line still being written included, is a tail to read first.
            return Ok(After::Grew);
        }
    }
    let Some((seq, _file, _)) = put(&mut appending, &path, record, &line, false) else {
        return Err("the chat's record could not be written".into());
    };
    Ok(After::Written(seq))
}

/// `confirm_synced`, telling a record that is gone (`Held::Moved`) from
/// one that could not be confirmed. For a caller that owes the record a
/// line: the first drops what it owes, the second owes it still.
pub fn receipt(key: &str, seen: &Generation) -> Held {
    let Some(path) = path_for(key) else {
        return Held::Unconfirmed;
    };
    let appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    if generation_of(&appending, &identity(&path)) != *seen {
        return Held::Moved;
    }
    match synced(&appending, &path) {
        Some(()) => Held::Confirmed,
        None => Held::Unconfirmed,
    }
}

/// A receipt for the lines that are in the record now: the file as it is
/// is synced, and then its folder entry, whatever was done before. `None`
/// when either cannot be, and then nothing in the record is confirmed.
///
/// And `None` when the record is not the one `seen`: the caller read its
/// lines, or wrote them, in a record that has since been removed, and the
/// file under that name now is another that need not hold them. Syncing it
/// would confirm lines nobody looked for in it. The caller reads again.
/// "Not the one" is asked of the file first and its number second: a token
/// taken for another file is refused whatever the two numbers are, since
/// every file that never moved on has the same one.
///
/// For a line whose own append answered `None` after it was written, or was
/// never heard from at all (the server stopped): that the line can be read
/// back says the OS holds it, not that the disk does. And for a line
/// `append_synced` answered for in a file that was already there: that
/// answer says nothing of the folder entry, which nobody synced when an
/// ordinary `append` made the file or `rewrite_numbered` put a new one
/// under its name.
///
/// Nothing is written again; the one byte this may add is the newline a
/// last line is missing, under the append lock, because an ordinary append
/// would be glued onto such a line and take it with it.
pub fn confirm_synced(key: &str, seen: &Generation) -> Option<()> {
    (receipt(key, seen) == Held::Confirmed).then_some(())
}

/// The record at `path` as it is now, synced with its folder. With the
/// append lock held, so the lines confirmed are the ones the caller looked
/// at or wrote under it.
fn synced(_appending: &Appending, path: &Path) -> Option<()> {
    let mut file = OpenOptions::new().append(true).read(true).open(path).ok()?;
    if !ends_in_newline(&mut file) {
        file.write_all(b"\n").ok()?;
    }
    file.sync_data().ok()?;
    // Whether the folder entry was ever made durable is not known here: the
    // sync that should have done it is the one that failed or was lost.
    sync_dir(path.parent()?).ok()?;
    // A token is confirmed only in the directory it was made for. The path
    // was the server's own folder when this began (`chats_dir`); it is
    // asked again now that the file is synced, so a folder put at that
    // path in between gives no receipt for whatever it holds.
    crate::profile::available().ok().map(|_| ())
}

/// The events of one `type` in a chat's record, oldest first.
///
/// Only a line that holds the type's name is parsed, so looking for a few
/// host events in a 100 MB conversation does not build every frame of it.
/// Every writer of a record serializes with `serde_json`, which writes an
/// ASCII name as it is, so a line of that type always holds it.
///
/// Read by bytes, a line at a time: a line that is not UTF-8 (a write cut
/// inside a character) is one line skipped, as one that will not parse is.
/// `lines()` would end the whole read there and hide every event after it.
pub(crate) fn of_type(key: &str, kind: &str) -> Vec<Value> {
    #[cfg(test)]
    READS_BY_TYPE.with(|reads| reads.set(reads.get() + 1));
    let Some(file) = path_for(key).and_then(|path| File::open(path).ok()) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for_each_line(file, |_, line| {
        found.extend(
            std::str::from_utf8(line)
                .ok()
                .filter(|text| text.contains(kind))
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .filter(|event| event["type"] == kind),
        );
    });
    found
}

/// Hand `see` every line of a record with its `seq`: the bytes between two
/// line ends, whatever they are.
///
/// **A line's position is its `seq`, so every reader of a record and the
/// count that numbers the next line go through this one walk.** A line
/// that cannot be decoded (not UTF-8: a write cut inside a character; not
/// JSON: a write cut anywhere else) is still a line. Its reader skips it
/// and reads on; it never ends the read, and it never shifts the number of
/// a line after it. `BufRead::lines` does both: it answers an error for
/// such a line, and `map_while(Result::ok)` stops there.
///
/// The line is handed over without its line end (`\n` or `\r\n`).
pub(crate) fn for_each_line(file: File, see: impl FnMut(u64, &[u8])) {
    let _ = try_each_line(file, see);
}

/// `for_each_line`, answering a read that failed part way instead of
/// ending there as if the file did.
pub(crate) fn try_each_line(file: File, mut see: impl FnMut(u64, &[u8])) -> std::io::Result<()> {
    try_each_line_at(file, |seq, line, _| see(seq, line))
}

/// `try_each_line`, saying where each line ended (`LineEnd`).
pub(crate) fn try_each_line_at(
    file: File,
    mut see: impl FnMut(u64, &[u8], LineEnd),
) -> std::io::Result<()> {
    let mut lists = crate::record_storage::ListReader::default();
    let mut failed = None;
    try_each_stored_line_at(file, |seq, line, at| {
        if failed.is_some() {
            return;
        }
        let referenced = memchr::memmem::find(line, b"\"octiq_record_refs\"").is_some();
        if referenced || memchr::memmem::find(line, b"\"system\"").is_some() {
            if let Ok(mut event) = serde_json::from_slice::<Value>(line) {
                if let Err(error) = lists.decode(&mut event, seq) {
                    failed = Some(error);
                    return;
                }
                if referenced {
                    if let Ok(text) = serde_json::to_vec(&event) {
                        see(seq, &text, at);
                        return;
                    }
                }
            }
        }
        see(seq, line, at);
    })?;
    failed.map_or(Ok(()), Err)
}

/// Raw storage walk for rewriters. The number is the END of a no-op range;
/// real events always retain their original sequence numbers.
pub(crate) fn for_each_stored_line(file: File, see: impl FnMut(u64, &[u8])) {
    let _ = try_each_stored_line(file, see);
}

pub(crate) fn try_each_stored_line(
    file: File,
    mut see: impl FnMut(u64, &[u8]),
) -> std::io::Result<()> {
    try_each_stored_line_at(file, |seq, line, _| see(seq, line))
}

/// Where a line ended, and whether it ended in a line end. Only the last line
/// of a record can be unterminated: a write still in progress, or one that was
/// cut. The bytes of such a line are not yet a line (a writer may finish it
/// before the next read), so a reader that must know where a whole line ends
/// takes `end` of the last terminated line and nothing past it.
#[derive(Clone, Copy)]
pub(crate) struct LineEnd {
    pub end: u64,
    pub terminated: bool,
}

pub(crate) fn try_each_stored_line_at(
    file: File,
    mut see: impl FnMut(u64, &[u8], LineEnd),
) -> std::io::Result<()> {
    let mut reader = BufReader::new(file);
    let (mut line, mut seq, mut offset) = (Vec::new(), 0u64, 0u64);
    while reader.read_until(b'\n', &mut line)? > 0 {
        offset += line.len() as u64;
        let terminated = line.ends_with(b"\n");
        let mut body = line.as_slice();
        if let [rest @ .., b'\n'] = body {
            body = rest;
            if let [rest @ .., b'\r'] = body {
                body = rest;
            }
        }
        seq = seq
            .checked_add(crate::record_storage::span(body))
            .ok_or_else(|| std::io::Error::other("chat record sequence overflow"))?;
        see(
            seq,
            body,
            LineEnd {
                end: offset,
                terminated,
            },
        );
        if !terminated {
            // Only the end of the file answers without a line end. A line
            // read from here on would be the rest of this one, if a writer
            // finished it meanwhile, and no longer the line after it: stop.
            #[cfg(test)]
            partial_line_read();
            break;
        }
        line.clear();
    }
    Ok(())
}

/// Start a chat's record with `events`, but only a record that has nothing in
/// it yet. True when they were written; false when the chat already has a
/// record, which is never written over or added to here.
///
/// This is how a session picked out of an agent's own history becomes part of
/// the chat that picked it up. Until something was said in it, that chat had
/// no record at all: its history lived only in the page that read it, so
/// opening it anywhere else, or after that page's copy was gone, showed a
/// blank conversation. Held under the append lock, so a turn starting in the
/// same moment either lands after the whole history or makes this refuse.
pub fn seed(key: &str, events: &[Value]) -> Result<bool, String> {
    let path = path_for(key).ok_or_else(|| format!("not a usable chat key: {key:?}"))?;
    let mut text = String::new();
    for event in events {
        text.push_str(&serde_json::to_string(event).map_err(|e| e.to_string())?);
        text.push('\n');
    }

    let record = identity(&path);
    let mut guard = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    let counts = guard.get_or_insert_with(HashMap::new);
    let next = match counts.get(&record) {
        Some(next) => *next,
        None => count(&path) + 1,
    };
    if next != 1 {
        return Ok(false);
    }
    if events.is_empty() {
        return Ok(true);
    }
    let existed = path.exists();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("cannot write the chat record: {e}"))?;
    file.write_all(text.as_bytes())
        .and_then(|_| file.sync_data())
        .map_err(|e| format!("cannot write the chat record: {e}"))?;
    counts.insert(
        record,
        events
            .iter()
            .map(|e| crate::record_storage::span(e.to_string().as_bytes()))
            .sum::<u64>()
            + 1,
    );
    if !existed {
        if let Some(dir) = path.parent() {
            let _ = sync_dir(dir);
        }
    }
    Ok(true)
}

/// Make a folder's entries (a file just created or renamed into it) durable.
pub(crate) fn sync_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if FAIL_DIR_SYNC.with(|fail| fail.get()) {
        return Err(std::io::Error::other("folder sync refused (test)"));
    }
    sync_dir_on(dir, cfg!(windows))
}

/// `sync_dir`, with the platform a parameter so both branches run in tests.
///
/// Windows has no folder sync the standard library can reach: opening a
/// folder as a file is refused (it needs FILE_FLAG_BACKUP_SEMANTICS), so
/// asking would fail every time and every line in a new file would stay
/// unconfirmed. NTFS journals the entry itself, so there is nothing to ask.
fn sync_dir_on(dir: &Path, is_windows: bool) -> std::io::Result<()> {
    if is_windows {
        return Ok(());
    }
    File::open(dir)?.sync_all()
}

/// Forget the count kept for `key`, as a restarted process has none.
#[cfg(test)]
pub(crate) fn forget_count(key: &str) {
    let Some(record) = path_for(key).map(|path| identity(&path)) else {
        return;
    };
    let mut guard = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(counts) = guard.as_mut() {
        counts.remove(&record);
    }
}

#[cfg(test)]
thread_local! {
    /// Refuse every folder sync on this thread, as a failing disk would.
    pub(crate) static FAIL_DIR_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// How many records `of_type` has read on this thread.
    pub(crate) static READS_BY_TYPE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Whether the file is empty or its last byte ends a line.
fn ends_in_newline(file: &mut File) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let mut last = [0u8; 1];
    match file.seek(SeekFrom::End(-1)) {
        Ok(_) => file
            .read_exact(&mut last)
            .map_or(true, |_| last[0] == b'\n'),
        // Nothing to seek back over: an empty file.
        Err(_) => true,
    }
}

/// How many lines are already recorded, whatever is on them: the next line
/// written is numbered one past this. Read once per chat per run.
fn count(path: &Path) -> u64 {
    let Ok(file) = File::open(path) else {
        return 0;
    };
    let mut lines = 0;
    for_each_stored_line(file, |seq, _| lines = seq);
    lines
}

/// Everything after `after`. `after = 0` is the whole conversation.
///
/// A line that cannot be decoded is skipped rather than ending the read: the
/// last line of a file written by a process that died mid-write can be half
/// a JSON object or half a character, lines are written after it when the
/// chat goes on, and one torn line must hide none of them.
pub fn since(key: &str, after: u64) -> Vec<Recorded> {
    let Some(path) = path_for(key) else {
        return Vec::new();
    };
    let Ok(file) = File::open(&path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for_each_line(file, |seq, line| {
        if seq <= after {
            return;
        }
        if let Ok(event) = serde_json::from_slice::<Value>(line) {
            out.push(Recorded { seq, event });
        }
    });
    out
}

/// `since(key, 0)` for a reader that must tell "never written" from "cannot
/// be read": the told-once receipts (`agent_chat::host_turns`, a send's
/// `durable_user_turn_exists`). No record file is an empty record: nothing
/// at the path, or something that is not a file (a folder holds no line).
/// A file that is there and cannot be opened or read to its end, or a chats
/// folder that is not there to look in, is an error, never "nothing was
/// handed over".
pub(crate) fn every_line(key: &str) -> Result<Vec<Recorded>, String> {
    let mut out = Vec::new();
    walk(key, |seq, line| {
        if let Ok(event) = serde_json::from_slice::<Value>(line) {
            out.push(Recorded { seq, event });
        }
    })?;
    Ok(out)
}

/// `every_line` for a reader that wants the bytes: each line of the record
/// with its logical `seq`, through `for_each_line`'s decoding (ranges,
/// list references), answering a record that cannot be read as an error and
/// a chat that never wrote one as no lines. A reader that is after a few
/// kinds of line filters on the bytes first and parses only those.
pub(crate) fn walk(key: &str, see: impl FnMut(u64, &[u8])) -> Result<(), String> {
    let unread = |e: std::io::Error| format!("the chat's record could not be read: {e}");
    let Some(path) = path_for(key) else {
        // Not a key a record can be kept under: one never was.
        if !safe_key(key) {
            return Ok(());
        }
        return Err(chats_folder()
            .err()
            .unwrap_or_else(|| "the chat's record could not be found in the chats folder".into()));
    };
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_dir() => return Ok(()),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(unread(e)),
    }
    let file = File::open(&path).map_err(unread)?;
    try_each_line(file, see).map_err(unread)
}

/// A recent, contiguous window. The exclusive cursor is an event sequence,
/// so appends do not move older pages underneath a reader.
#[derive(Debug, Serialize)]
pub struct Page {
    pub events: Vec<Recorded>,
    pub context: Vec<Recorded>,
    pub before: Option<u64>,
}

/// Start pages at an idle host's next prompt, never halfway through a streamed
/// message or at a queued prompt inside the reply it is waiting behind.
fn page_prompt(event: &Value, seq: u64, host_prompts: &HashMap<String, u64>) -> bool {
    if event["type"] != "user" || event.get("octiq_append_to").is_some() {
        return false;
    }
    // Claude echoes an ordinary host prompt after its startup output. That
    // echo belongs to the turn already started by the host's envelope. Queued
    // Claude prompts have no earlier envelope: their echo still starts a turn.
    if event["isReplay"] == true
        && event["octiq_user_turn_id"]
            .as_str()
            .and_then(|id| host_prompts.get(id))
            .is_some_and(|&host_seq| host_seq < seq)
    {
        return false;
    }
    let content = &event["message"]["content"];
    content.is_string()
        || content.as_array().is_some_and(|blocks| {
            blocks
                .iter()
                .any(|b| b["type"] == "text" || b["type"] == "image")
                && !blocks.iter().any(|b| b["type"] == "tool_result")
        })
}

fn host_prompt_id(event: &Value) -> Option<&str> {
    (host_event(event) && event["type"] == "user" && event["octiq_user_turn"] == true)
        .then(|| event["uuid"].as_str())
        .flatten()
        .filter(|id| !id.is_empty())
}

/// Keep a few recent complete turns, targeting 256 KiB. One indivisible turn
/// may exceed that budget. Older bytes stay on disk until explicitly requested.
pub fn page(key: &str, before: Option<u64>) -> Result<Page, String> {
    page_with_budget(key, before, 256 * 1024, 3)
}

/// Where each line of a record starts, found without parsing older replies.
///
/// A line's position is its `seq`, so a page read from the end still has to
/// know how many lines come before it. Finding the newlines is a memchr over
/// the bytes; only host prompt envelopes and candidates for the first prompt
/// need parsing to identify their echoes and the startup prefix.
/// Parsing every line as JSON to the same end made opening a 100 MB chat take
/// seconds.
struct LineIndex {
    /// Physical byte offsets, paired with logical end numbers in `seqs`.
    starts: Vec<u64>,
    seqs: Vec<u64>,
    /// Where the indexed bytes end.
    end: u64,
    /// Lines that might be page context, ascending: `thread.started`, then
    /// `system` `init`. A byte match only: each is parsed before it is used.
    /// Records are written compactly by `serde_json`, and inside a string the
    /// quotes would be escaped, so these spellings are the events themselves.
    context: [Vec<u64>; 2],
    /// The earliest host envelope for each UUID. Replays can be classified
    /// without parsing the intervening startup output or older replies.
    host_prompts: HashMap<String, u64>,
    /// Context before this first host prompt belongs to its turn, even when
    /// that prefix alone exceeds the page budget.
    first_prompt: Option<u64>,
}

const CONTEXT_NEEDLES: [&[u8]; 2] = [br#""type":"thread.started""#, br#""subtype":"init""#];

impl LineIndex {
    /// Index at most `limit` lines of `file`.
    fn scan(file: &File, limit: u64) -> std::io::Result<Self> {
        let needles = CONTEXT_NEEDLES.map(memchr::memmem::Finder::new);
        let host_prompt = memchr::memmem::Finder::new(br#""octiq_user_turn""#);
        let user = memchr::memmem::Finder::new(br#""type":"user""#);
        let mut reader = BufReader::with_capacity(1 << 20, file);
        let mut index = LineIndex {
            starts: Vec::new(),
            seqs: Vec::new(),
            end: 0,
            context: [Vec::new(), Vec::new()],
            host_prompts: HashMap::new(),
            first_prompt: None,
        };
        let mut line = Vec::new();
        let mut seq = 0u64;
        while seq < limit {
            line.clear();
            let read = reader.read_until(b'\n', &mut line)?;
            if read == 0 {
                break;
            }
            seq = seq.saturating_add(crate::record_storage::span(&line));
            if seq > limit {
                break;
            }
            index.starts.push(index.end);
            index.seqs.push(seq);
            if host_prompt.find(&line).is_some()
                || (index.first_prompt.is_none() && user.find(&line).is_some())
            {
                if let Ok(event) = serde_json::from_slice::<Value>(&line) {
                    if let Some(id) = host_prompt_id(&event) {
                        index.host_prompts.entry(id.to_string()).or_insert(seq);
                    }
                    if index.first_prompt.is_none()
                        && host_event(&event)
                        && page_prompt(&event, seq, &index.host_prompts)
                    {
                        index.first_prompt = Some(seq);
                    }
                }
            }
            for (needle, seqs) in needles.iter().zip(&mut index.context) {
                if needle.find(&line).is_some() {
                    seqs.push(seq);
                }
            }
            index.end += read as u64;
        }
        Ok(index)
    }

    /// Line `seq`, parsed, with its length as `lines()` would have counted it.
    /// `None` for a line that is not a JSON value (a torn last line).
    fn read_raw(&self, file: &File, seq: u64) -> std::io::Result<Option<(Value, usize)>> {
        use std::io::{Read, Seek, SeekFrom};
        let Ok(at) = self.seqs.binary_search(&seq) else {
            return Ok(None);
        };
        let start = self.starts[at];
        let end = self.starts.get(at + 1).copied().unwrap_or(self.end);
        let mut bytes = vec![0; (end - start) as usize];
        let mut file = file;
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut bytes)?;
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
        }
        Ok(serde_json::from_slice(&bytes)
            .ok()
            .map(|event| (event, bytes.len())))
    }

    fn read(&self, file: &File, seq: u64) -> std::io::Result<Option<(Value, usize)>> {
        let Some((mut event, bytes)) = self.read_raw(file, seq)? else {
            return Ok(None);
        };
        let referenced = event.get("octiq_record_refs").is_some();
        crate::record_storage::resolve(&mut event, |source, field| {
            if source >= seq {
                return None;
            }
            // Only this field's material value is needed. Resolving every
            // unrelated reference on its source init would recurse through
            // older inits and repeat the same large reads exponentially.
            self.read_raw(file, source)
                .ok()
                .flatten()
                .and_then(|(e, _)| e.get(field).cloned())
        })?;
        let size = if referenced {
            event.to_string().len()
        } else {
            bytes
        };
        Ok(Some((event, size)))
    }
}

/// Whether an event is the host's own, rather than a subagent's or a seat's.
fn host_event(event: &Value) -> bool {
    event["parent_tool_use_id"].is_null() && event["octiq_speaker"].is_null()
}

/// What a host event does to "is a reply in progress": `Some(true)` starts
/// one, `Some(false)` ends it.
fn host_busy(event: &Value) -> Option<bool> {
    match event["type"].as_str().unwrap_or_default() {
        "assistant" | "turn.started" => Some(true),
        "stream_event" if event["event"]["type"] == "message_start" => Some(true),
        "result" | "turn.completed" | "turn.failed" => Some(false),
        _ => None,
    }
}

/// The page being gathered from the end: `seen[..to]`, newest first, holding
/// `turns` whole turns of `bytes` bytes.
struct Window {
    turns: usize,
    to: usize,
    bytes: usize,
    max_turns: usize,
    budget: usize,
}

impl Window {
    /// Add the turn reaching back to `seen[start]` if it fits; the newest turn
    /// always does. False once nothing older can be added.
    fn take(&mut self, start: usize, sums: &[usize]) -> bool {
        if start < self.to {
            return true; // an empty turn
        }
        let bytes = sums[start + 1] - sums[self.to];
        if self.turns > 0 && (self.turns + 1 > self.max_turns || self.bytes + bytes > self.budget) {
            return false;
        }
        self.turns += 1;
        self.bytes += bytes;
        self.to = start + 1;
        self.turns != self.max_turns
    }
}

/// The page `page_forward` reads, found from the END of the record.
///
/// Turns are split at an idle host's prompt; the page is the longest run of
/// whole turns from the end that fits `turns` and `budget`, and at least the
/// last turn however large. Walking backwards, a prompt is a split only once
/// the event before it says the host was idle — so a prompt waits in
/// `pending` until the nearest earlier `result` (a split) or reply start (not
/// one) is reached. Older replies are never parsed; the line index reads only
/// host prompt envelopes, candidates for the first prompt, and the newest
/// context event of each kind.
fn page_with_budget(
    key: &str,
    before: Option<u64>,
    budget: usize,
    turns: usize,
) -> Result<Page, String> {
    let path = path_for(key).ok_or("invalid chat key")?;
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Page {
                events: vec![],
                context: vec![],
                before: None,
            });
        }
        Err(e) => return Err(e.to_string()),
    };
    let stamp = file
        .metadata()
        .and_then(stamp_from_metadata)
        .map_err(record_read_error)?;
    let limit = before.map_or(u64::MAX, |cursor| cursor.saturating_sub(1));
    let index = LineIndex::scan(&file, limit).map_err(|e| e.to_string())?;
    if before.is_none() {
        let mut appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
        // The scan is already needed for paging. Reuse its complete count,
        // but never publish an old open inode after a clear/rewrite/append.
        if record_stamp(&path).is_ok_and(|current| current == stamp) {
            appending
                .get_or_insert_with(HashMap::new)
                .insert(identity(&path), index.seqs.last().copied().unwrap_or(0) + 1);
        }
    }
    let read = |seq| index.read(&file, seq).map_err(|e| e.to_string());

    // Newest first; `sums[i]` is the byte total of `seen[..i]`.
    let mut seen: Vec<Recorded> = Vec::new();
    let mut sums: Vec<usize> = vec![0];
    let mut pending: Vec<usize> = Vec::new();
    let mut page = Window {
        turns: 0,
        to: 0,
        bytes: 0,
        max_turns: turns,
        budget,
    };

    let mut open = true;
    for &seq in index.seqs.iter().rev() {
        let Some((event, bytes)) = read(seq)? else {
            continue;
        };
        let at = seen.len();
        let host = host_event(&event);
        // The first prompt owns all startup context before it. Only later
        // prompts can split off a page; the first turn reaches record start.
        let prompt = host
            && Some(seq) != index.first_prompt
            && page_prompt(&event, seq, &index.host_prompts);
        let busy = if host { host_busy(&event) } else { None };
        sums.push(sums[at] + bytes);
        seen.push(Recorded { seq, event });
        if prompt {
            pending.push(at);
        }
        match busy {
            // The host was idle before these prompts: each starts a turn.
            Some(false) => {
                for start in std::mem::take(&mut pending) {
                    open = page.take(start, &sums);
                    if !open {
                        break;
                    }
                }
            }
            // Queued behind a reply: they belong to the turn before them.
            Some(true) => pending.clear(),
            None => {}
        }
        if !open {
            break;
        }
        // The next turn is at least everything back to its newest possible
        // start; once that cannot fit, nothing older can.
        if page.turns > 0 {
            let reach = pending.first().copied().unwrap_or(at);
            if page.bytes + sums[reach + 1] - sums[page.to] > budget {
                open = false;
                break;
            }
        }
    }
    if open && !seen.is_empty() {
        // The start of the record: nothing was replying before its first event.
        for start in std::mem::take(&mut pending)
            .into_iter()
            .chain([seen.len() - 1])
        {
            if !page.take(start, &sums) {
                break;
            }
        }
    }
    seen.truncate(page.to);
    seen.reverse();
    let events = seen;

    // The newest of each kind of context event older than the page.
    let first = events.first().map_or(0, |record| record.seq);
    let mut context: Vec<Recorded> = Vec::new();
    for (kind, seqs) in index.context.iter().enumerate() {
        for &seq in seqs.iter().rev().filter(|&&seq| seq < first) {
            let Some((event, _)) = read(seq)? else {
                continue;
            };
            let wanted = match kind {
                0 => event["type"] == "thread.started",
                _ => event["type"] == "system" && event["subtype"] == "init",
            };
            if wanted && host_event(&event) {
                context.push(Recorded { seq, event });
                break;
            }
        }
    }
    context.sort_by_key(|record| record.seq);
    let before = events.first().and_then(|record| {
        index
            .first_prompt
            .is_some_and(|first| first < record.seq)
            .then_some(record.seq)
    });
    Ok(Page {
        events,
        context,
        before,
    })
}

/// The page read the simple way, front to back with every line parsed: the
/// definition `page_with_budget` is checked against.
#[cfg(test)]
fn page_forward(
    key: &str,
    before: Option<u64>,
    budget: usize,
    turns: usize,
) -> Result<Page, String> {
    let path = path_for(key).ok_or("invalid chat key")?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Page {
                events: vec![],
                context: vec![],
                before: None,
            });
        }
        Err(e) => return Err(e.to_string()),
    };
    use std::collections::VecDeque;
    let mut chunks: VecDeque<(Vec<Recorded>, usize)> = VecDeque::from([(vec![], 0)]);
    let mut bytes = 0;
    let mut busy = false;
    let mut prompted = false;
    let mut has_earlier = false;
    let mut host_prompts = HashMap::new();
    let mut context: HashMap<String, Recorded> = HashMap::new();
    let mut lines = Vec::new();
    for_each_line(file, |seq, line| lines.push((seq, line.to_vec())));
    for (seq, line) in lines {
        if before.is_some_and(|cursor| seq >= cursor) {
            break;
        }
        let Ok(event) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let host = event["parent_tool_use_id"].is_null() && event["octiq_speaker"].is_null();
        let prompt = host && page_prompt(&event, seq, &host_prompts);
        if prompt && !busy && prompted && !chunks.back().unwrap().0.is_empty() {
            chunks.push_back((vec![], 0));
        }
        prompted |= prompt;
        if let Some(id) = host_prompt_id(&event) {
            host_prompts.entry(id.to_string()).or_insert(seq);
        }
        if host {
            match event["type"].as_str().unwrap_or_default() {
                "assistant" | "turn.started" => busy = true,
                "stream_event" if event["event"]["type"] == "message_start" => busy = true,
                "result" | "turn.completed" | "turn.failed" => busy = false,
                _ => {}
            }
        }
        bytes += line.len();
        let chunk = chunks.back_mut().unwrap();
        chunk.1 += line.len();
        chunk.0.push(Recorded { seq, event });
        while chunks.len() > 1 && (bytes > budget || chunks.len() > turns) {
            has_earlier = true;
            let (dropped, size) = chunks.pop_front().unwrap();
            bytes -= size;
            for record in dropped {
                let event = &record.event;
                if !event["parent_tool_use_id"].is_null() || !event["octiq_speaker"].is_null() {
                    continue;
                }
                let kind = event["type"].as_str().unwrap_or_default();
                if kind == "thread.started" || (kind == "system" && event["subtype"] == "init") {
                    context.insert(kind.to_string(), record);
                }
            }
        }
    }
    let events: Vec<Recorded> = chunks.into_iter().flat_map(|(events, _)| events).collect();
    let mut context: Vec<Recorded> = context.into_values().collect();
    context.sort_by_key(|record| record.seq);
    let before = events
        .first()
        .and_then(|record| has_earlier.then_some(record.seq));
    Ok(Page {
        events,
        context,
        before,
    })
}

/// Forget a chat's record. Called when its conversation is deleted — the point
/// of deleting a chat is that it is gone.
///
/// Also what the page's `/clear` sends for a chat that stays in the list,
/// so the next thing said in it makes the record again. The lock is taken
/// before the file goes, and the generation moves before the lock is let
/// go: an append cannot land between the two, and a receipt asked for with
/// the old record's generation is refused whenever it is asked.
pub fn forget(key: &str) {
    if let Some(path) = path_for(key) {
        forget_file(&path);
    }
}

#[cfg(test)]
thread_local! {
    static FORGET_FAILS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(crate) fn while_forget_fails<T>(work: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            FORGET_FAILS.set(self.0);
        }
    }
    let _restore = Restore(FORGET_FAILS.replace(true));
    work()
}

/// The browser's clear command must not announce success if deletion failed.
pub(crate) fn forget_checked(key: &str) -> Result<(), String> {
    crate::profile::available()?;
    #[cfg(test)]
    if FORGET_FAILS.get() {
        return Err("the chat record could not be removed".into());
    }
    if !safe_key(key) {
        return Err("invalid chat key".into());
    }
    try_forget_file(&chats_folder()?.join(file_name(key)))
        .map(|_| ())
        .map_err(record_read_error)
}

/// `forget` for a record known by its file alone: one no chat points at
/// (`chat_index::reconcile`). True when a file was removed.
///
/// The record is its identity, under whatever spelling it was asked for:
/// the generation that moves and the count that is dropped are the file's,
/// so nothing kept for the same file under another spelling outlives it.
/// The count goes too, or a chat started again under the same name would
/// number its first event as though the deleted one were still there.
pub(crate) fn forget_file(path: &Path) -> bool {
    try_forget_file(path).unwrap_or(false)
}

fn try_forget_file(path: &Path) -> std::io::Result<bool> {
    // Nothing is removed from a folder that is not the server's own.
    if path
        .parent()
        .is_some_and(|dir| crate::profile::create_dir_all(dir).is_err())
    {
        return Err(std::io::Error::other(
            "the chat's record folder is unavailable",
        ));
    }
    let record = identity(path);
    let mut appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    // Whether or not there was a file: what is there afterwards is not
    // what was.
    let removed = match fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e),
    };
    // /clear also discards an interrupted migration's old inode. It must
    // never keep cleared words around or attach them to a new history.
    let _ = fs::remove_file(path.with_extension("jsonl.compact-backup"));
    let _ = fs::remove_file(path.with_extension("jsonl.rewrite"));
    next_generation(&appending, &record);
    if let Some(writers) = WRITE_LISTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
    {
        writers.remove(&record);
    }
    if let Some(counts) = appending.as_mut() {
        counts.remove(&record);
    }
    Ok(removed)
}

/// Rewrite a record line by line. `edit` returns a replacement for a line, or
/// `None` to keep it as it is. Every line stays one line in its place, because
/// a line's position is its `seq`; a line that is not UTF-8, or a replacement
/// that would split into two lines, is kept byte for byte.
///
/// Builds outside the append lock, then publishes only if source stamp and
/// generation still match. Concurrent appends/clears cause a retryable error.
pub(crate) fn rewrite_lines(
    path: &Path,
    mut edit: impl FnMut(&str) -> Option<String>,
) -> std::io::Result<bool> {
    rewrite_numbered(
        path,
        |_, line| std::str::from_utf8(line).ok().and_then(&mut edit),
        false,
    )
}

/// `rewrite_lines`, handing `edit` each line's `seq` and its bytes as they
/// are, so a change worked out earlier without the lock can be applied by
/// position.
/// `storage` also coalesces no-op ranges and keeps a synced backup until
/// readback checks numbering, references and host facts. Such a replacement
/// always moves generation, even when no host fact changed.
pub(crate) fn rewrite_numbered(
    path: &Path,
    edit: impl FnMut(u64, &[u8]) -> Option<String>,
    storage: bool,
) -> std::io::Result<bool> {
    rewrite_numbered_guarded(path, edit, storage, || Ok(()))
}

pub(crate) fn rewrite_numbered_guarded<G>(
    path: &Path,
    edit: impl FnMut(u64, &[u8]) -> Option<String>,
    storage: bool,
    publish: impl FnOnce() -> std::io::Result<G>,
) -> std::io::Result<bool> {
    rewrite(path, edit, storage, publish)
}

fn storage_facts(path: &Path, through: u64) -> std::io::Result<(u64, [u8; 32])> {
    use sha2::{Digest, Sha256};
    let mut last = 0;
    let mut facts = Sha256::new();
    // One pass also resolves and validates every disk-only list reference.
    try_each_line(File::open(path)?, |seq, line| {
        last = seq;
        if seq <= through
            && is_host_event(line)
            && serde_json::from_slice::<Value>(line)
                .ok()
                .is_none_or(|e| e["type"] != "octiq_compacted")
        {
            facts.update(seq.to_le_bytes());
            facts.update((line.len() as u64).to_le_bytes());
            facts.update(line);
        }
    })?;
    Ok((last, facts.finalize().into()))
}

fn verify_storage(before: &Path, after: &Path) -> std::io::Result<()> {
    if storage_facts(before, u64::MAX)? != storage_facts(after, u64::MAX)? {
        return Err(std::io::Error::other(
            "chat compaction changed sequence numbers or host facts; backup retained",
        ));
    }
    Ok(())
}

fn record_folder(path: &Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        crate::profile::make_dir(dir).map_err(std::io::Error::other)?;
    }
    Ok(())
}

// Separate from NEXT_SEQ: only another rewrite of this same physical record
// is excluded while its large replacement is built. Appends and chat starts
// remain free; a changed source makes publication fail closed.
static REWRITING: Mutex<Option<std::collections::HashSet<PathBuf>>> = Mutex::new(None);
struct Rewriting(PathBuf);
impl Drop for Rewriting {
    fn drop(&mut self) {
        if let Some(records) = REWRITING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            records.remove(&self.0);
        }
    }
}

#[derive(PartialEq, Eq)]
struct RecordStamp {
    len: u64,
    modified: std::time::SystemTime,
    created: Option<std::time::SystemTime>,
    #[cfg(unix)]
    inode: (u64, u64),
}
impl RecordStamp {
    fn generation(&self) -> String {
        // No mtime or length: ordinary appends belong to the same history.
        // On filesystems without creation time, the process nonce keeps a
        // restart conservative rather than mistaking an inode reuse for life.
        static EPOCH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        let birth = self.created.map_or_else(
            || {
                EPOCH
                    .get_or_init(|| uuid::Uuid::new_v4().to_string())
                    .clone()
            },
            |time| format!("{time:?}"),
        );
        #[cfg(unix)]
        let birth = format!("{birth}:{}:{}", self.inode.0, self.inode.1);
        birth
    }
}
fn record_stamp(path: &Path) -> std::io::Result<RecordStamp> {
    let meta = fs::symlink_metadata(path)?;
    stamp_from_metadata(meta)
}

fn stamp_from_metadata(meta: fs::Metadata) -> std::io::Result<RecordStamp> {
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(std::io::Error::other(
            "chat rewrite requires a regular record file",
        ));
    }
    Ok(RecordStamp {
        len: meta.len(),
        modified: meta.modified()?,
        created: meta.created().ok(),
        #[cfg(unix)]
        inode: {
            use std::os::unix::fs::MetadataExt;
            (meta.dev(), meta.ino())
        },
    })
}
fn source_unchanged(
    path: &Path,
    stamp: &RecordStamp,
    seen: &Generation,
    appending: &Appending,
) -> std::io::Result<()> {
    record_folder(path)?;
    if record_stamp(path)? != *stamp || generation_of(appending, &seen.record) != *seen {
        return Err(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "chat record changed while preparing compaction; retry later",
        ));
    }
    Ok(())
}

#[cfg(test)]
thread_local! { static REWRITE_LOCK_MAX: std::cell::Cell<std::time::Duration> = const { std::cell::Cell::new(std::time::Duration::ZERO) }; }
#[cfg(test)]
struct RewriteTiming(std::time::Instant);
#[cfg(test)]
impl Drop for RewriteTiming {
    fn drop(&mut self) {
        REWRITE_LOCK_MAX.with(|max| max.set(max.get().max(self.0.elapsed())));
    }
}

#[cfg(test)]
pub(crate) fn take_rewrite_lock_max() -> std::time::Duration {
    REWRITE_LOCK_MAX.with(|max| max.replace(std::time::Duration::ZERO))
}

fn rewrite<G>(
    path: &Path,
    mut edit: impl FnMut(u64, &[u8]) -> Option<String>,
    storage: bool,
    publish: impl FnOnce() -> std::io::Result<G>,
) -> std::io::Result<bool> {
    record_folder(path)?;
    let record = identity(path);
    if !REWRITING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(std::collections::HashSet::new)
        .insert(record.clone())
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "chat record is already being rewritten",
        ));
    }
    let _rewriting = Rewriting(record.clone());
    let temp = path.with_extension("jsonl.rewrite");
    let backup = path.with_extension("jsonl.compact-backup");
    let (stamp, seen) = {
        let appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(test)]
        let _time = RewriteTiming(std::time::Instant::now());
        (record_stamp(path)?, generation_of(&appending, &record))
    };
    if storage && backup.exists() {
        // Recovery scans are outside the global append lock too. A changed
        // source leaves the backup for the next pass instead of guessing.
        let (old_end, old_facts) = storage_facts(&backup, u64::MAX)?;
        let (new_end, old_prefix) = storage_facts(path, old_end)?;
        if new_end < old_end || old_facts != old_prefix {
            return Err(std::io::Error::other(
                "chat compaction recovery could not verify the backup; backup retained",
            ));
        }
        let appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(test)]
        let _time = RewriteTiming(std::time::Instant::now());
        source_unchanged(path, &stamp, &seen, &appending)?;
        fs::remove_file(&backup)?;
        sync_dir(path.parent().unwrap())?;
    }
    let mut host_event_replaced = false;
    let written = (|| {
        let mut reader = BufReader::new(File::open(path)?);
        record_folder(path)?;
        let mut out = BufWriter::new(File::create(&temp)?);
        let mut changed = false;
        let mut line = Vec::new();
        let mut seq = 0u64;
        let mut pending: Option<(u64, u64, bool)> = None;
        let flush = |out: &mut BufWriter<File>,
                     pending: &mut Option<(u64, u64, bool)>|
         -> std::io::Result<()> {
            if let Some((into, count, ended)) = pending.take() {
                let text = if count == 1 {
                    crate::record_trim::compacted_line(into)
                } else {
                    format!(r#"{{"type":"octiq_compacted","into":{into},"count":{count}}}"#)
                };
                out.write_all(text.as_bytes())?;
                if ended {
                    out.write_all(b"\n")?;
                }
            }
            Ok(())
        };
        while reader.read_until(b'\n', &mut line)? > 0 {
            let ended = line.last() == Some(&b'\n');
            let body = &line[..line.len() - usize::from(ended)];
            if storage && !ended {
                changed = true;
            }
            let output_ended = ended || storage;
            let span = crate::record_storage::span(body);
            seq = seq
                .checked_add(span)
                .ok_or_else(|| std::io::Error::other("chat sequence overflow"))?;
            let replacement = edit(seq, body).filter(|text| !text.contains('\n'));
            let bytes = replacement.as_ref().map_or(body, |text| text.as_bytes());
            if bytes != body {
                changed = true;
                host_event_replaced |= is_host_event(body);
            }
            let stub = (storage && memchr::memmem::find(bytes, b"\"octiq_compacted\"").is_some())
                .then(|| serde_json::from_slice::<Value>(bytes).ok())
                .flatten()
                .filter(|e| e["type"] == "octiq_compacted")
                .and_then(|e| e["into"].as_u64());
            if let Some(into) = stub {
                if let Some((old_into, count, old_ended)) = pending.as_mut() {
                    if count.saturating_add(span) <= u32::MAX as u64 {
                        *old_into = (*old_into).min(into);
                        *count += span;
                        *old_ended = output_ended;
                        changed = true;
                    } else {
                        flush(&mut out, &mut pending)?;
                        pending = Some((into, span, output_ended));
                    }
                } else {
                    pending = Some((into, span, output_ended));
                }
            } else {
                flush(&mut out, &mut pending)?;
                out.write_all(bytes)?;
                if output_ended {
                    out.write_all(b"\n")?;
                }
            }
            line.clear();
        }
        flush(&mut out, &mut pending)?;
        out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
        Ok(changed)
    })();
    match written {
        Ok(true) => {
            // All parsing, copying, source/target verification and readback are
            // outside NEXT_SEQ. The publication gate is acquired only now, so
            // a chat starting during preparation wins and we retry later.
            if storage {
                verify_storage(path, &temp)?;
            }
            let published = {
                let claim = publish()?;
                let mut appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
                #[cfg(test)]
                let _time = RewriteTiming(std::time::Instant::now());
                source_unchanged(path, &stamp, &seen, &appending)?;
                if storage {
                    fs::hard_link(path, &backup)?;
                    // Windows FlushFileBuffers requires GENERIC_WRITE. Keep
                    // the Unix read-only fsync path for read-only source files.
                    #[cfg(windows)]
                    OpenOptions::new().write(true).open(&backup)?.sync_all()?;
                    #[cfg(not(windows))]
                    File::open(&backup)?.sync_all()?;
                    sync_dir(path.parent().unwrap())?;
                    #[cfg(test)]
                    compact_checkpoint(1)?;
                }
                record_folder(path)?;
                fs::rename(&temp, path)?;
                if let Some(counts) = appending.as_mut() {
                    counts.remove(&record);
                }
                if storage || host_event_replaced {
                    next_generation(&appending, &record);
                }
                if let Some(writers) = WRITE_LISTS
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_mut()
                {
                    writers.remove(&record);
                }
                if storage {
                    #[cfg(test)]
                    compact_checkpoint(2)?;
                    sync_dir(path.parent().unwrap())?;
                }
                let published = generation_of(&appending, &record);
                // Drop order releases NEXT_SEQ before the lifecycle claim.
                let _ = &claim;
                published
            };
            if storage {
                // A new turn may append after publication. Verify the original
                // prefix, retaining the backup if /clear or a rewrite intervenes.
                let (old_end, old_facts) = storage_facts(&backup, u64::MAX)?;
                let (new_end, old_prefix) = storage_facts(path, old_end)?;
                if new_end < old_end || old_facts != old_prefix {
                    return Err(std::io::Error::other(
                        "chat compaction readback failed; backup retained",
                    ));
                }
                let appending = NEXT_SEQ.lock().unwrap_or_else(|e| e.into_inner());
                #[cfg(test)]
                let _time = RewriteTiming(std::time::Instant::now());
                record_folder(path)?;
                if generation_of(&appending, &record) != published {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WouldBlock,
                        "chat record changed during compaction readback",
                    ));
                }
                fs::remove_file(&backup)?;
                sync_dir(path.parent().unwrap())?;
            }
            Ok(true)
        }
        other => {
            if record_folder(path).is_ok() {
                let _ = fs::remove_file(&temp);
            }
            other
        }
    }
}

#[cfg(test)]
thread_local! { static FAIL_COMPACT_AT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
fn compact_checkpoint(at: u8) -> std::io::Result<()> {
    if std::env::var("OCTIQ_COMPACT_KILL_AT").ok().as_deref() == Some(&at.to_string()) {
        // An offline child test exits without destructors at the publication
        // boundary, then a fresh process verifies and resumes the migration.
        std::process::exit(73);
    }
    if FAIL_COMPACT_AT.with(|fail| fail.get() == at) {
        Err(std::io::Error::other(
            "compactor stopped at crash door (test)",
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "transcript_tests.rs"]
mod tests;

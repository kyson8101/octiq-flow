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
    let mut lists = crate::record_storage::ListReader::default();
    let mut failed = None;
    try_each_stored_line(file, |seq, line| {
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
                        see(seq, &text);
                        return;
                    }
                }
            }
        }
        see(seq, line);
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
    let mut reader = BufReader::new(file);
    let (mut line, mut seq) = (Vec::new(), 0u64);
    while reader.read_until(b'\n', &mut line)? > 0 {
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
        see(seq, body);
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
    let unread = |e: std::io::Error| format!("the chat's record could not be read: {e}");
    let Some(path) = path_for(key) else {
        // Not a key a record can be kept under: one never was.
        if !safe_key(key) {
            return Ok(Vec::new());
        }
        return Err(chats_folder()
            .err()
            .unwrap_or_else(|| "the chat's record could not be found in the chats folder".into()));
    };
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_dir() => return Ok(Vec::new()),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(unread(e)),
    }
    let file = File::open(&path).map_err(unread)?;
    let mut out = Vec::new();
    try_each_line(file, |seq, line| {
        if let Ok(event) = serde_json::from_slice::<Value>(line) {
            out.push(Recorded { seq, event });
        }
    })
    .map_err(unread)?;
    Ok(out)
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

/// The browser's clear command must not announce success if deletion failed.
pub(crate) fn forget_checked(key: &str) -> Result<(), String> {
    crate::profile::available()?;
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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn record_head_follows_clear_and_keeps_generation_across_appends_and_cold_reads() {
        let key = unique_key("record-head-clear");
        assert_eq!(record_head(&key).unwrap().last_seq, 0);
        for _ in 0..5 {
            append(&key, &json!({"type":"result"})).unwrap();
        }
        let before = record_head(&key).unwrap();
        assert_eq!(before.last_seq, 5);
        assert_eq!(record_head(&key).unwrap().generation, before.generation);
        append(&key, &json!({"type":"result"})).unwrap();
        forget_count(&key);
        let cold = record_head(&key).unwrap();
        assert_eq!(cold.last_seq, 6);
        assert_eq!(cold.generation, before.generation);
        forget_checked(&key).unwrap();
        let empty = record_head(&key).unwrap();
        assert_eq!(empty.last_seq, 0);
        assert_ne!(empty.generation, before.generation);
        for _ in 0..2 {
            append(&key, &json!({"type":"result"})).unwrap();
        }
        let after = record_head(&key).unwrap();
        assert_eq!(after.last_seq, 2);
        assert_ne!(after.generation, before.generation);
        assert_eq!(record_head(&key).unwrap().generation, after.generation);
        forget(&key);
    }

    #[test]
    fn record_head_and_page_count_compacted_ranges_and_invalid_utf8_identically() {
        let key = unique_key("record-head-storage");
        let path = path_for(&key).unwrap();
        fs::write(&path, b"{\"type\":\"octiq_compacted\",\"into\":1,\"count\":20}\n\xff\n{\"type\":\"result\"}\n").unwrap();
        assert_eq!(record_head(&key).unwrap().last_seq, 22);
        forget_count(&key);
        let page = page(&key, None).unwrap();
        // Paging already indexed the whole file: a head request must reuse it.
        HEAD_SCAN.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(|| panic!("head rescanned after page")))
        });
        let head = record_head(&key).unwrap();
        HEAD_SCAN.with(|hook| hook.borrow_mut().take());
        assert_eq!(head.last_seq, page.events.last().unwrap().seq);
        assert_eq!(head.last_seq, 22);
        forget(&key);
    }

    #[test]
    fn cold_head_scan_allows_other_appends_and_refuses_a_cleared_source() {
        let key = unique_key("record-head-concurrent");
        append(&key, &json!({"type":"result"})).unwrap();
        forget_count(&key);
        let other = unique_key("record-head-other");
        let cleared = key.clone();
        let appended = other.clone();
        HEAD_SCAN.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                let (tx, rx) = std::sync::mpsc::channel();
                let writer = std::thread::spawn(move || {
                    let seq = append(&appended, &json!({"type":"result"}));
                    forget(&cleared);
                    for _ in 0..2 {
                        append(&cleared, &json!({"type":"result"})).unwrap();
                    }
                    tx.send(seq).unwrap();
                });
                assert_eq!(
                    rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(),
                    Some(1)
                );
                writer.join().unwrap();
            }))
        });
        assert_eq!(record_head(&key).unwrap().last_seq, 2);
        forget(&key);
        forget(&other);
    }

    #[test]
    fn record_head_changes_generation_and_invalidates_count_after_rewrite() {
        let key = unique_key("record-head-rewrite");
        append(&key, &json!({"type":"result"})).unwrap();
        let before = record_head(&key).unwrap();
        let path = path_for(&key).unwrap();
        assert!(rewrite_lines(&path, |_| Some(
            r#"{"type":"result","changed":true}"#.into()
        ))
        .unwrap());
        let record = identity(&path);
        assert!(!NEXT_SEQ
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .contains_key(&record));
        let after = record_head(&key).unwrap();
        assert_eq!(after.last_seq, before.last_seq);
        assert_ne!(after.generation, before.generation);
        forget(&key);
    }

    #[test]
    fn rewrite_preparation_allows_appends_and_refuses_a_changed_source() {
        let key = unique_key("storage-concurrent-append");
        append(&key, &json!({"type":"user","message":{"content":"keep"}}));
        let path = path_for(&key).unwrap();
        let seen = generation(&key).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut writer = None;
        let mut edited = false;
        let result = rewrite_numbered(
            &path,
            |_, _| {
                if edited {
                    return None;
                }
                edited = true;
                let key = key.clone();
                let tx = tx.clone();
                writer = Some(std::thread::spawn(move || {
                    tx.send(append(&key, &json!({"type":"result"}))).unwrap();
                }));
                assert_eq!(
                    rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(),
                    Some(2)
                );
                Some(r#"{"type":"user","message":{"content":"must not publish"}}"#.into())
            },
            true,
        );
        assert!(result.is_err());
        writer.unwrap().join().unwrap();
        assert_eq!(generation(&key), Some(seen));
        assert_eq!(since(&key, 0)[0].event["message"]["content"], "keep");
        assert_eq!(since(&key, 1)[0].seq, 2);
        forget(&key);
    }

    #[test]
    fn rewrite_preparation_cannot_put_cleared_words_in_a_new_history() {
        let key = unique_key("storage-concurrent-clear");
        append(&key, &json!({"type":"octiq_note","text":"old"}));
        let path = path_for(&key).unwrap();
        let result = rewrite_numbered(
            &path,
            |_, _| {
                forget(&key);
                append(&key, &json!({"type":"octiq_note","text":"fresh"}));
                Some(r#"{"type":"octiq_note","text":"old rewritten"}"#.into())
            },
            true,
        );
        assert!(result.is_err());
        assert_eq!(since(&key, 0).len(), 1);
        assert_eq!(since(&key, 0)[0].event["text"], "fresh");
        forget(&key);
    }

    #[test]
    fn publication_releases_the_append_lock_before_readback() {
        struct AppendOnDrop(String);
        impl Drop for AppendOnDrop {
            fn drop(&mut self) {
                assert_eq!(
                    append(&self.0, &json!({"type":"octiq_note","text":"new"})),
                    Some(5)
                );
            }
        }
        let key = unique_key("storage-readback-append");
        append(&key, &json!({"type":"octiq_note","text":"keep"}));
        for _ in 0..3 {
            append(&key, &json!({"type":"octiq_compacted","into":1}));
        }
        let path = path_for(&key).unwrap();
        assert!(rewrite_numbered_guarded(
            &path,
            |_, _| None,
            true,
            || Ok(AppendOnDrop(key.clone()))
        )
        .unwrap());
        assert!(!path.with_extension("jsonl.compact-backup").exists());
        assert_eq!(since(&key, 4)[0].event["text"], "new");
        forget(&key);
    }

    #[test]
    fn ranges_keep_seq_page_context_and_receipts_across_restart() {
        let key = unique_key("storage-ranges");
        let init = json!({"type":"system","subtype":"init","session_id":"session","slash_commands":["help"],"tools":["tool"]});
        append(&key, &init);
        append(&key, &json!({"type":"octiq_user_turn","uuid":"p1"}));
        append(
            &key,
            &json!({"type":"user","uuid":"p1","message":{"content":"question"}}),
        );
        for _ in 0..10 {
            append(&key, &json!({"type":"octiq_compacted","into":3}));
        }
        append(
            &key,
            &json!({"type":"octiq_question_answered","id":"q1","answer":"yes"}),
        );
        append(&key, &json!({"type":"result"}));
        append(&key, &init);
        let path = path_for(&key).unwrap();
        let generation = generation(&key).unwrap();
        assert!(rewrite_numbered(&path, |_, _| None, true).unwrap());
        assert_eq!(receipt(&key, &generation), Held::Moved);
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"count\":10"));
        assert!(text.contains("octiq_record_refs"));
        let tail = since(&key, 8);
        assert_eq!(seqs(&tail), [13, 14, 15, 16]);
        assert_eq!(tail.last().unwrap().event, init);
        assert_eq!(of_type(&key, "octiq_question_answered").len(), 1);
        for before in [None, Some(8), Some(14), Some(17)] {
            let page = page_with_budget(&key, before, 999999, 20).unwrap();
            let forward = page_forward(&key, before, 999999, 20).unwrap();
            assert_eq!(
                serde_json::to_value(page).unwrap(),
                serde_json::to_value(forward).unwrap()
            );
        }
        forget_count(&key);
        assert_eq!(append(&key, &init), Some(17));
        assert_eq!(since(&key, 16)[0].event, init);
        forget(&key);
        assert_eq!(append(&key, &init), Some(1));
        assert_eq!(since(&key, 0)[0].event, init);
        forget(&key);
    }

    #[test]
    fn interrupted_compaction_keeps_backup_and_resumes_even_after_new_appends() {
        for stage in [1, 2] {
            let key = unique_key("storage-crash");
            append(
                &key,
                &json!({"type":"octiq_question_answered","answer":"keep"}),
            );
            for _ in 0..4 {
                append(&key, &json!({"type":"octiq_compacted","into":1}));
            }
            let path = path_for(&key).unwrap();
            let seen = generation(&key).unwrap();
            FAIL_COMPACT_AT.with(|fail| fail.set(stage));
            assert!(rewrite_numbered(&path, |_, _| None, true).is_err());
            FAIL_COMPACT_AT.with(|fail| fail.set(0));
            assert!(path.with_extension("jsonl.compact-backup").exists());
            if stage == 2 {
                assert_eq!(receipt(&key, &seen), Held::Moved);
            }
            assert_eq!(
                append(&key, &json!({"type":"octiq_task_reopened","taskId":"new"})),
                Some(6)
            );
            rewrite_numbered(&path, |_, _| None, true).unwrap();
            assert!(!path.with_extension("jsonl.compact-backup").exists());
            assert_eq!(of_type(&key, "octiq_question_answered").len(), 1);
            assert_eq!(since(&key, 5)[0].event["taskId"], "new");
            forget(&key);
        }
    }

    #[test]
    #[ignore]
    fn storage_crash_child() {
        let path = PathBuf::from(
            std::env::var("OCTIQ_COMPACT_CRASH_FILE").expect("parent test scratch path"),
        );
        let scratch = crate::paths::canonicalize(&std::env::temp_dir()).unwrap();
        assert!(crate::paths::canonicalize(&path)
            .unwrap()
            .starts_with(scratch));
        let _profile = crate::profile::started_in(path.parent().unwrap());
        rewrite_numbered(&path, |_, _| None, true).unwrap();
    }

    #[test]
    fn a_fresh_process_resumes_a_compactor_killed_at_either_publication_boundary() {
        for stage in [1, 2] {
            let scratch = crate::test_dir::TestDir::new("record-storage-process-crash");
            let path = scratch.join("chat_crash.jsonl");
            fs::write(
                &path,
                format!(
                    "{{\"type\":\"octiq_question_answered\",\"answer\":\"yes\"}}\n{}\n",
                    vec![crate::record_trim::compacted_line(1); 8].join("\n")
                ),
            )
            .unwrap();
            let child = || {
                let mut command = std::process::Command::new(std::env::current_exe().unwrap());
                command
                    .args([
                        "--exact",
                        "transcript::tests::storage_crash_child",
                        "--ignored",
                    ])
                    .env("OCTIQ_COMPACT_CRASH_FILE", &path);
                command
            };
            let killed = child()
                .env("OCTIQ_COMPACT_KILL_AT", stage.to_string())
                .output()
                .unwrap();
            assert_eq!(killed.status.code(), Some(73));
            assert!(path.with_extension("jsonl.compact-backup").is_file());
            let resumed = child()
                .env_remove("OCTIQ_COMPACT_KILL_AT")
                .output()
                .unwrap();
            assert!(
                resumed.status.success(),
                "{}",
                String::from_utf8_lossy(&resumed.stderr)
            );
            assert!(!path.with_extension("jsonl.compact-backup").exists());
            let (end, _) = storage_facts(&path, u64::MAX).unwrap();
            assert_eq!(end, 9);
            assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
        }
    }

    #[test]
    fn page_reads_mixed_list_sources_directly_without_recursive_init_expansion() {
        let key = unique_key("mixed-list-sources");
        let mut init = json!({"type":"system","subtype":"init","tools":["t0"],"slash_commands":["c0"],"skills":["s0"]});
        append(&key, &init);
        for at in 1..40 {
            let field = ["tools", "slash_commands", "skills"][at % 3];
            init[field] = json!([format!("value{at}")]);
            append(&key, &init);
        }
        let file = File::open(path_for(&key).unwrap()).unwrap();
        let index = LineIndex::scan(&file, u64::MAX).unwrap();
        assert_eq!(index.read(&file, 40).unwrap().unwrap().0, init);
        assert_eq!(since(&key, 39)[0].event, init);
        forget(&key);
    }

    #[test]
    fn storage_migration_ends_a_torn_or_unterminated_line_before_future_appends() {
        for body in [
            br#"{"type":"octiq_note","text":"keep"}"#.as_slice(),
            b"{\"type\":\"assistant\",\"text\":\"\xff",
        ] {
            let key = unique_key("storage-final-boundary");
            let path = path_for(&key).unwrap();
            fs::write(&path, body).unwrap();
            assert!(rewrite_numbered(&path, |_, _| None, true).unwrap());
            assert!(fs::read(&path).unwrap().ends_with(b"\n"));
            forget_count(&key);
            assert_eq!(append(&key, &json!({"type":"result"})), Some(2));
            assert_eq!(since(&key, 1)[0].seq, 2);
            forget(&key);
        }
    }

    #[test]
    fn migration_reservation_defers_new_receipt_flows_without_changing_tokens() {
        let key = format!("chat:{}", unique_key("storage-receipt-reservation"));
        append(&key, &json!({"type":"octiq_note","text":"keep"}));
        let seen = generation(&key).unwrap();
        let held = hold_storage(&path_for(&key).unwrap()).unwrap();
        assert!(generation(&key).is_none());
        assert!(generation(&key.replace(':', "_")).is_none());
        assert_eq!(receipt(&key, &seen), Held::Confirmed);
        drop(held);
        assert_eq!(generation(&key), Some(seen));
        forget(&key);
    }

    #[test]
    fn storage_publication_waits_for_the_backup_folder_to_sync() {
        let key = unique_key("storage-folder-sync");
        append(&key, &json!({"type":"octiq_note","text":"keep"}));
        for _ in 0..3 {
            append(&key, &json!({"type":"octiq_compacted","into":1}));
        }
        let path = path_for(&key).unwrap();
        let before = fs::read(&path).unwrap();
        let seen = generation(&key).unwrap();
        FAIL_DIR_SYNC.with(|fail| fail.set(true));
        assert!(rewrite_numbered(&path, |_, _| None, true).is_err());
        FAIL_DIR_SYNC.with(|fail| fail.set(false));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(generation(&key), Some(seen.clone()));
        assert!(path.with_extension("jsonl.compact-backup").is_file());
        assert!(rewrite_numbered(&path, |_, _| None, true).unwrap());
        assert_eq!(receipt(&key, &seen), Held::Moved);
        assert_eq!(of_type(&key, "octiq_note").len(), 1);
        forget(&key);
    }

    /// A key nobody else's test will use, so these can run in parallel against
    /// one real profile directory.
    fn unique_key(name: &str) -> String {
        format!("test-{name}-{}", uuid::Uuid::new_v4().simple())
    }

    fn assert_page_has_drawable_turn(page: &Page) {
        let host_prompts = page
            .events
            .iter()
            .filter_map(|record| {
                host_prompt_id(&record.event).map(|id| (id.to_string(), record.seq))
            })
            .collect();
        assert!(
            page.events.iter().any(|record| {
                host_event(&record.event) && page_prompt(&record.event, record.seq, &host_prompts)
            }),
            "a page must contain a drawable turn, not only context: {page:?}"
        );
    }

    #[test]
    fn pages_walk_backwards_without_gaps_or_duplicates() {
        let key = unique_key("pages");
        append(
            &key,
            &json!({"type":"system", "subtype":"init", "session_id":"session"}),
        );
        for n in 0..12 {
            append(
                &key,
                &json!({"type":"user", "message":{"content":format!("prompt {n}")}}),
            );
            append(
                &key,
                &json!({"type":"assistant", "message":{"id":format!("m{n}"), "content":[]}}),
            );
            append(&key, &json!({"type":"result"}));
        }
        let latest = page_with_budget(&key, None, usize::MAX, 3).unwrap();
        assert_page_has_drawable_turn(&latest);
        assert_eq!(
            serde_json::to_value(&latest).unwrap(),
            serde_json::to_value(page_forward(&key, None, usize::MAX, 3).unwrap()).unwrap()
        );
        assert_eq!(latest.events.len(), 9);
        assert_eq!(latest.context[0].event["session_id"], "session");
        let mut sequences: Vec<u64> = latest.events.iter().map(|e| e.seq).collect();
        let mut cursor = latest.before;
        // A new event cannot shift an already-issued exclusive cursor.
        append(
            &key,
            &json!({"type":"user", "message":{"content":"new prompt"}}),
        );
        while let Some(before) = cursor {
            let older = page_with_budget(&key, Some(before), usize::MAX, 3).unwrap();
            assert_page_has_drawable_turn(&older);
            let expected = page_forward(&key, Some(before), usize::MAX, 3).unwrap();
            assert_eq!(
                serde_json::to_value(&older).unwrap(),
                serde_json::to_value(&expected).unwrap()
            );
            assert!(older.before.is_none_or(|next| next < before));
            sequences.extend(older.events.iter().map(|e| e.seq));
            cursor = older.before;
        }
        sequences.sort_unstable();
        assert_eq!(sequences, (1..=37).collect::<Vec<_>>());
        forget(&key);
    }

    #[test]
    fn startup_context_joins_the_first_drawable_turn_even_over_budget() {
        let key = unique_key("page-startup-context");
        for event in [
            json!({"type":"system", "subtype":"init", "session_id":"session"}),
            json!({"type":"thread.started", "thread_id":"thread"}),
            // Hooks are bounded on write now. Use generic startup metadata
            // to keep exercising an indivisible prefix larger than the budget.
            json!({"type":"system", "subtype":"startup_metadata", "output":"x".repeat(300 * 1024)}),
            // User-shaped context is not an earlier host prompt.
            json!({"type":"user", "message":{"content":[{"type":"tool_result","content":"hook"}]}}),
            json!({"type":"user", "parent_tool_use_id":"p", "message":{"content":"subagent"}}),
            json!({"type":"user", "octiq_speaker":{"id":"a"}, "message":{"content":"seat"}}),
            json!({"type":"user", "octiq_append_to":"u", "message":{"content":"appended"}}),
        ] {
            append(&key, &event);
        }
        for n in 0..4 {
            append(
                &key,
                &json!({"type":"user", "isReplay":true,
                    "octiq_user_turn_id":format!("queued-{n}"),
                    "message":{"content":[{"type":"image", "source":{"data":"image"}}]}}),
            );
            append(&key, &json!({"type":"assistant"}));
            append(&key, &json!({"type":"result"}));
        }
        for (budget, turns) in [(1, 1), (256 * 1024, 3), (256 * 1024, 4), (usize::MAX, 3)] {
            let mut cursor = None;
            let mut sequences = Vec::new();
            loop {
                let page = page_with_budget(&key, cursor, budget, turns).unwrap();
                let expected = page_forward(&key, cursor, budget, turns).unwrap();
                assert_page_has_drawable_turn(&page);
                assert_eq!(
                    serde_json::to_value(&page).unwrap(),
                    serde_json::to_value(&expected).unwrap()
                );
                sequences.extend(page.events.iter().map(|record| record.seq));
                cursor = page.before;
                if cursor.is_none() {
                    assert_eq!(page.events.first().unwrap().seq, 1);
                    assert_eq!(page.events.len(), 10, "the prefix and exactly one turn");
                    assert!(page.context.is_empty());
                    break;
                }
            }
            sequences.sort_unstable();
            assert_eq!(sequences, (1..=19).collect::<Vec<_>>());
        }
        forget(&key);
    }

    #[test]
    fn a_torn_prefix_does_not_offer_an_empty_earlier_page() {
        let key = unique_key("page-torn-prefix");
        fs::write(
            path_for(&key).unwrap(),
            "{\"torn\":\n{\"type\":\"user\",\"message\":{\"content\":\"prompt\"}}\n{\"type\":\"result\"}\n",
        )
        .unwrap();
        for page in [
            page_with_budget(&key, None, 1, 1).unwrap(),
            page_forward(&key, None, 1, 1).unwrap(),
        ] {
            assert_page_has_drawable_turn(&page);
            assert_eq!(page.before, None);
            assert_eq!(
                page.events.iter().map(|r| r.seq).collect::<Vec<_>>(),
                [2, 3]
            );
        }
        forget(&key);
    }

    /// Reading from the end finds exactly the page reading every line from the
    /// front does, over records shaped like real ones: queued prompts inside a
    /// reply, subagent and seat events, torn lines, context of both kinds.
    #[test]
    fn a_page_read_from_the_end_is_the_page_read_from_the_front() {
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut roll = move |n: u64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state % n
        };
        for round in 0..300 {
            let key = unique_key("page-equivalence");
            let path = path_for(&key).unwrap();
            let mut text = String::new();
            for _ in 0..roll(60) {
                let event = match roll(20) {
                    0 => {
                        json!({"type":"system","subtype":"init","session_id":format!("s{}", roll(9))})
                    }
                    1 => json!({"type":"thread.started","thread_id":format!("t{}", roll(9))}),
                    2 | 3 => {
                        json!({"type":"user","message":{"content":"x".repeat(roll(40) as usize)}})
                    }
                    4 => {
                        json!({"type":"user","message":{"content":[{"type":"tool_result","content":"r"}]}})
                    }
                    5 => json!({"type":"user","octiq_append_to":"u","message":{"content":"more"}}),
                    6 => json!({"type":"assistant","message":{"content":[]}}),
                    7 => json!({"type":"stream_event","event":{"type":"message_start"}}),
                    8 => {
                        json!({"type":"stream_event","event":{"type":"content_block_delta","text":"y".repeat(roll(30) as usize)}})
                    }
                    9 | 10 => json!({"type":"result"}),
                    11 => json!({"type":"turn.started"}),
                    12 => json!({"type":"turn.completed"}),
                    13 => json!({"type":"result","parent_tool_use_id":"p"}),
                    14 => {
                        json!({"type":"user","octiq_speaker":{"id":"a"},"message":{"content":"seat"}})
                    }
                    15 => json!({"type":"user", "uuid":format!("user-{}", roll(4)),
                        "octiq_user_turn":true, "message":{"content":"host"}}),
                    16 | 17 => json!({"type":"user", "isReplay":true,
                        "octiq_user_turn_id":format!("user-{}", roll(4)), "message":{"content":"echo"}}),
                    18 => json!({"type":"user", "uuid":"user-0", "octiq_user_turn":true,
                        "parent_tool_use_id":"p", "message":{"content":"subagent"}}),
                    _ => {
                        text.push_str("{\"torn\": \n");
                        continue;
                    }
                };
                text.push_str(&event.to_string());
                text.push('\n');
            }
            if roll(4) == 0 {
                text.push_str("{\"half");
            }
            fs::write(&path, &text).unwrap();
            let lines = text.lines().count() as u64;
            for _ in 0..6 {
                let budget = [1, 40, 120, 400, usize::MAX][roll(5) as usize];
                let turns = roll(5) as usize;
                let before = (roll(3) > 0).then(|| roll(lines + 2) + 1);
                let found = page_with_budget(&key, before, budget, turns).unwrap();
                let expected = page_forward(&key, before, budget, turns).unwrap();
                let shape = |page: &Page| {
                    (
                        page.events
                            .iter()
                            .map(|e| (e.seq, e.event.clone()))
                            .collect::<Vec<_>>(),
                        page.context
                            .iter()
                            .map(|e| (e.seq, e.event.clone()))
                            .collect::<Vec<_>>(),
                        page.before,
                    )
                };
                assert_eq!(
                    shape(&found),
                    shape(&expected),
                    "round {round}, before {before:?}, budget {budget}, turns {turns}:\n{text}"
                );
            }
            forget(&key);
        }
    }

    /// The same check over real records, with timings:
    /// `OCTIQ_PAGE_CHECK=<a.jsonl>:<b.jsonl> cargo test --release -- --ignored real_records`
    #[test]
    #[ignore]
    fn real_records_page_the_same_from_either_end() {
        let Ok(files) = std::env::var("OCTIQ_PAGE_CHECK") else {
            return;
        };
        for file in files.split(':') {
            let key = unique_key("page-real");
            fs::copy(file, path_for(&key).unwrap()).unwrap();
            let mut cursor = None;
            for _ in 0..3 {
                let started = std::time::Instant::now();
                let found = page(&key, cursor).unwrap();
                let fast = started.elapsed();
                let started = std::time::Instant::now();
                let expected = page_forward(&key, cursor, 256 * 1024, 3).unwrap();
                let slow = started.elapsed();
                eprintln!("{file} before {cursor:?}: {fast:?} from the end, {slow:?} from the front, {} events, next before {:?}", found.events.len(), found.before);
                let seqs = |p: &Page| {
                    p.events
                        .iter()
                        .chain(&p.context)
                        .map(|e| e.seq)
                        .collect::<Vec<_>>()
                };
                assert_eq!(seqs(&found), seqs(&expected));
                assert_eq!(found.before, expected.before);
                cursor = found.before;
                if cursor.is_none() {
                    break;
                }
            }
            forget(&key);
        }
    }

    #[test]
    fn startup_replay_stays_with_its_host_prompt_despite_the_byte_budget() {
        let key = unique_key("page-startup-replay");
        append(
            &key,
            &json!({"type":"user", "uuid":"user-first", "octiq_user_turn":true,
                "message":{"content":"first prompt"}}),
        );
        // SessionStart hooks, slash-command lists and init can occupy most of
        // the byte budget before Claude echoes the prompt back.
        for _ in 0..2 {
            append(
                &key,
                &json!({"type":"system", "subtype":"hook_response", "output":"x".repeat(105 * 1024)}),
            );
        }
        append(&key, &json!({"type":"system", "subtype":"init"}));
        append(
            &key,
            &json!({"type":"user", "isReplay":true, "octiq_user_turn_id":"user-first",
                "message":{"content":[{"type":"image", "source":{"data":"a".repeat(60 * 1024)}}]}}),
        );
        append(
            &key,
            &json!({"type":"stream_event", "event":{"type":"message_start"}}),
        );
        for _ in 0..20 {
            append(
                &key,
                &json!({"type":"stream_event", "event":{"type":"content_block_delta", "text":"x".repeat(4096)}}),
            );
        }
        for page in [
            page(&key, None).unwrap(),
            page_forward(&key, None, 256 * 1024, 3).unwrap(),
        ] {
            assert_eq!(page.before, None);
            assert_eq!(page.events.first().unwrap().seq, 1);
            assert_eq!(page.events.len(), 26);
        }
        forget(&key);
    }

    #[test]
    fn replay_without_an_earlier_host_prompt_starts_its_queued_turn() {
        let key = unique_key("page-queued-replay");
        append(
            &key,
            &json!({"type":"user", "uuid":"user-first", "octiq_user_turn":true,
                "message":{"content":"first"}}),
        );
        append(&key, &json!({"type":"assistant"}));
        append(&key, &json!({"type":"result"}));
        append(
            &key,
            &json!({"type":"user", "isReplay":true, "octiq_user_turn_id":"user-queued",
                "message":{"content":"queued"}}),
        );
        append(&key, &json!({"type":"assistant"}));
        // Even if this UUID appears later, it was not before the replay.
        append(
            &key,
            &json!({"type":"user", "uuid":"user-queued", "octiq_user_turn":true,
                "message":{"content":"later"}}),
        );
        for page in [
            page_with_budget(&key, None, 1, 1).unwrap(),
            page_forward(&key, None, 1, 1).unwrap(),
        ] {
            assert_eq!(page.before, Some(4));
            assert_eq!(page.events.first().unwrap().seq, 4);
            assert_eq!(page.events.len(), 3);
        }
        forget(&key);
    }

    #[test]
    fn byte_budget_keeps_a_stream_and_its_queued_prompt_together() {
        let key = unique_key("page-stream");
        append(&key, &json!({"type":"user", "message":{"content":"old"}}));
        append(&key, &json!({"type":"result"}));
        append(
            &key,
            &json!({"type":"user", "message":{"content":"current"}}),
        );
        append(
            &key,
            &json!({"type":"stream_event", "event":{"type":"message_start"}}),
        );
        append(
            &key,
            &json!({"type":"user", "octiq_user_turn":true, "message":{"content":"queued"}}),
        );
        append(
            &key,
            &json!({"type":"stream_event", "event":{"type":"content_block_delta", "text":"x".repeat(1000)}}),
        );
        let page = page_with_budget(&key, None, 100, 3).unwrap();
        assert_eq!(page.before, Some(3));
        assert_eq!(
            page.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![3, 4, 5, 6]
        );
        forget(&key);
    }

    #[test]
    fn appended_queue_envelopes_stay_on_their_combined_turn_page() {
        let key = unique_key("page-appended-queue");
        append(&key, &json!({"type":"user", "message":{"content":"old"}}));
        append(&key, &json!({"type":"result"}));
        append(
            &key,
            &json!({"type":"user", "uuid":"user-1", "octiq_user_turn":true, "message":{"content":"first"}}),
        );
        for id in ["user-2", "user-3", "user-4"] {
            append(
                &key,
                &json!({"type":"user", "uuid":id, "octiq_user_turn":true, "octiq_append_to":"user-1", "message":{"content":id}}),
            );
            append(
                &key,
                &json!({"type":"octiq_user_turn_appended", "uuid":"user-1", "appended_uuid":id}),
            );
        }
        let page = page_with_budget(&key, None, 1, 1).unwrap();
        assert_eq!(page.before, Some(3));
        assert_eq!(
            page.events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            (3..=9).collect::<Vec<_>>()
        );
        forget(&key);
    }

    #[test]
    fn events_come_back_in_order_from_where_you_left_off() {
        let key = unique_key("order");
        for i in 1..=5 {
            append(&key, &json!({ "n": i }));
        }

        // A client that saw three asks for three, and gets exactly the rest.
        let rest = since(&key, 3);
        assert_eq!(rest.len(), 2);
        assert_eq!(rest[0].seq, 4);
        assert_eq!(rest[0].event["n"], 4);
        assert_eq!(rest[1].seq, 5);

        // From nothing means the whole conversation.
        assert_eq!(since(&key, 0).len(), 5);
        // Already up to date.
        assert!(since(&key, 5).is_empty());
        // Ahead of us — a stale client, or a record that was deleted and
        // restarted. Answering with nothing beats answering with the wrong
        // events.
        assert!(since(&key, 99).is_empty());

        forget(&key);
    }

    #[test]
    fn a_torn_last_line_does_not_hide_the_events_before_it() {
        let key = unique_key("torn");
        append(&key, &json!({ "n": 1 }));
        append(&key, &json!({ "n": 2 }));

        // Simulate a process killed mid-write.
        let path = path_for(&key).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{{\"n\": 3, \"hal").unwrap();
        drop(file);

        let all = since(&key, 0);
        assert_eq!(all.len(), 2, "the two whole events must survive");
        assert_eq!(all[1].event["n"], 2);

        forget(&key);
    }

    #[test]
    fn a_synced_line_after_a_torn_one_is_whole_and_numbered_where_it_sits() {
        let key = unique_key("torn-synced");
        append(&key, &json!({ "n": 1 }));
        let path = path_for(&key).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{{\"n\": 2, \"hal").unwrap();
        drop(file);
        // The process died there; the next one counts the file afresh.
        forget_count(&key);

        let seq = append_synced(&key, &json!({ "n": 3 })).unwrap();
        let all = since(&key, 0);
        assert_eq!(all.len(), 2, "the torn line is skipped, the new one is not");
        assert_eq!(all[1].event["n"], 3);
        assert_eq!(all[1].seq, seq);
        assert_eq!(append_synced(&key, &json!({ "n": 4 })), Some(seq + 1));
        forget(&key);
    }

    #[test]
    fn a_new_file_whose_folder_cannot_be_synced_is_written_but_not_confirmed() {
        let key = unique_key("dir-sync");
        FAIL_DIR_SYNC.with(|f| f.set(true));
        let first = append_synced(&key, &json!({ "n": 1 }));
        // An existing file needs no folder sync, so the next one is confirmed.
        let second = append_synced(&key, &json!({ "n": 2 }));
        FAIL_DIR_SYNC.with(|f| f.set(false));
        assert_eq!(first, None, "unproven, so not confirmed");
        assert_eq!(second, Some(2));
        let all = since(&key, 0);
        assert_eq!(all.len(), 2, "the first line is on disk all the same");
        assert_eq!(all[0].seq, 1);
        forget(&key);
    }

    /// A line that is in the record is confirmed by the syncs its append
    /// had to make, and by nothing less: no file, or a folder that will not
    /// sync, is no receipt. Asking writes no event.
    #[test]
    fn lines_already_in_a_record_are_confirmed_only_by_a_sync_that_succeeds() {
        let key = unique_key("confirm");
        let confirm_synced = |key: &str| confirm_synced(key, &generation(key).unwrap());
        assert_eq!(confirm_synced(&key), None, "no record, nothing to confirm");
        FAIL_DIR_SYNC.with(|f| f.set(true));
        let unproven = append_synced(&key, &json!({ "n": 1 }));
        let refused = confirm_synced(&key);
        FAIL_DIR_SYNC.with(|f| f.set(false));
        assert_eq!((unproven, refused), (None, None));
        assert_eq!(confirm_synced(&key), Some(()));
        assert_eq!(since(&key, 0).len(), 1, "confirming appends nothing");

        // A last line with no line end is given one, so the next ordinary
        // append is its own line and the confirmed one stays readable.
        let path = path_for(&key).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{{\"n\":2}}").unwrap();
        drop(file);
        // The process died there; the next one counts the file afresh.
        forget_count(&key);
        assert_eq!(confirm_synced(&key), Some(()));
        assert_eq!(append(&key, &json!({ "n": 3 })), Some(3));
        let all: Vec<Value> = since(&key, 0).into_iter().map(|r| r.event).collect();
        assert_eq!(
            all,
            [json!({ "n": 1 }), json!({ "n": 2 }), json!({ "n": 3 })]
        );
        forget(&key);
    }

    /// `of_type` answers the events of that type and no other line: not one
    /// that only mentions the name, not a torn one.
    #[test]
    fn the_events_of_one_type_are_found_without_the_rest() {
        let key = unique_key("of-type");
        assert!(of_type(&key, "octiq_x").is_empty(), "no record");
        append(&key, &json!({ "type": "user", "text": "about octiq_x" }));
        append(&key, &json!({ "type": "octiq_x", "n": 1 }));
        append(&key, &json!({ "type": "octiq_xy", "n": 2 }));
        append(&key, &json!({ "type": "assistant", "text": "plain" }));
        append(&key, &json!({ "type": "octiq_x", "n": 3 }));
        let mut file = OpenOptions::new()
            .append(true)
            .open(path_for(&key).unwrap())
            .unwrap();
        write!(file, "{{\"type\":\"octiq_x\",\"n\":").unwrap();
        drop(file);
        assert_eq!(
            of_type(&key, "octiq_x"),
            [
                json!({ "type": "octiq_x", "n": 1 }),
                json!({ "type": "octiq_x", "n": 3 })
            ]
        );
        forget(&key);
    }

    /// A line that is not UTF-8 (a write cut inside a character) is one
    /// line skipped, like one that will not parse: the events after it are
    /// still found.
    #[test]
    fn a_line_that_is_not_utf8_hides_no_event_of_a_type_after_it() {
        let key = unique_key("of-type-utf8");
        append(&key, &json!({ "type": "octiq_x", "n": 1 }));
        let mut file = OpenOptions::new()
            .append(true)
            .open(path_for(&key).unwrap())
            .unwrap();
        file.write_all(b"{\"type\":\"octiq_x\",\"text\":\"\xE4\xB8\n")
            .unwrap();
        drop(file);
        append(&key, &json!({ "type": "octiq_x", "n": 2 }));
        assert_eq!(
            of_type(&key, "octiq_x"),
            [
                json!({ "type": "octiq_x", "n": 1 }),
                json!({ "type": "octiq_x", "n": 2 })
            ]
        );
        forget(&key);
    }

    #[test]
    fn a_folder_sync_is_skipped_on_windows_and_asked_everywhere_else() {
        let missing = std::env::temp_dir().join(format!("octiq-no-dir-{}", uuid::Uuid::new_v4()));
        // Windows cannot open a folder to sync it; asking would fail forever.
        assert!(sync_dir_on(&missing, true).is_ok());
        // Elsewhere a folder that cannot be synced is an error, not a shrug.
        assert!(sync_dir_on(&missing, false).is_err());
        let folder = std::env::temp_dir();
        if cfg!(windows) {
            // The reason for the skip: Windows refuses to open a folder as a
            // file, so asking would fail even for one that exists.
            assert!(sync_dir_on(&folder, false).is_err());
        } else {
            assert!(sync_dir_on(&folder, false).is_ok());
        }
        // What this platform really does with an existing folder succeeds.
        assert!(sync_dir(&folder).is_ok());
    }

    #[test]
    fn appending_stays_correct_across_many_events() {
        // The counter is in memory; this is the case that would expose it
        // drifting from what is actually on disk.
        let key = unique_key("many");
        let mut last = 0;
        for i in 1..=200 {
            last = append(&key, &json!({ "n": i })).expect("append should record");
        }
        assert_eq!(last, 200, "the 200th event should be seq 200");
        assert_eq!(since(&key, 0).len(), 200);
        assert_eq!(since(&key, 199).len(), 1);
        forget(&key);
    }

    #[test]
    fn a_chat_reusing_a_forgotten_key_starts_from_one() {
        let key = unique_key("reused");
        append(&key, &json!({ "n": 1 }));
        append(&key, &json!({ "n": 2 }));
        forget(&key);

        // Without clearing the counter this would come back as 3, and a client
        // asking for "everything after 0" would be told there is nothing.
        assert_eq!(append(&key, &json!({ "n": 1 })), Some(1));
        forget(&key);
    }

    #[test]
    fn a_key_that_is_really_a_path_is_refused() {
        // Keys arrive from a browser. This one must not write into /etc.
        assert!(path_for("../../etc/passwd").is_none());
        assert!(path_for("chat:with/slash").is_none());
        assert!(path_for("").is_none());
        // The shape our own keys actually take.
        assert!(path_for("chat:7f3a-4b21").is_some());
    }

    #[test]
    fn forgetting_a_chat_leaves_nothing_to_read() {
        let key = unique_key("forget");
        append(&key, &json!({ "n": 1 }));
        assert_eq!(since(&key, 0).len(), 1);
        forget(&key);
        assert!(since(&key, 0).is_empty());
    }

    /// A receipt is for the record a line was seen in. A chat that was
    /// forgotten and spoken in again has a file under the old name that
    /// syncs perfectly well and holds none of what the old one did: the
    /// receipt asked for with the old record's generation is refused, and
    /// one asked for with the new record's is given.
    #[test]
    fn a_receipt_is_refused_for_a_record_that_was_forgotten_and_made_again() {
        let key = unique_key("generation");
        assert_eq!(generation("not/a key"), None);
        append(&key, &json!({ "n": 1 }));
        let seen = generation(&key).unwrap();
        assert_eq!(confirm_synced(&key, &seen), Some(()));
        assert_eq!(
            generation(&key),
            Some(seen.clone()),
            "a receipt moves nothing"
        );

        forget(&key);
        assert_ne!(generation(&key), Some(seen.clone()));
        assert_eq!(confirm_synced(&key, &seen), None, "no record at all");
        append(&key, &json!({ "n": 2 }));
        assert_eq!(
            confirm_synced(&key, &seen),
            None,
            "the record there now is not the one that was seen"
        );
        let now = generation(&key).unwrap();
        assert_eq!(confirm_synced(&key, &now), Some(()));

        // Forgetting a chat that has no record moves it on as well: what
        // is written afterwards is not what a look before it saw.
        forget(&key);
        let none_there = generation(&key).unwrap();
        forget(&key);
        append(&key, &json!({ "n": 3 }));
        assert_eq!(confirm_synced(&key, &none_there), None);
        forget(&key);
    }

    /// A line for one history of a chat goes into that record or into
    /// none (`append_in`): written and confirmed while the chat still has
    /// the record, refused whole once it was forgotten, whatever has the
    /// name by then.
    #[test]
    fn a_line_for_a_record_is_put_in_that_record_or_in_none() {
        let key = unique_key("append-in");
        append(&key, &json!({ "n": 1 }));
        let seen = generation(&key).unwrap();
        assert_eq!(
            append_in(&key, &seen, &json!({ "n": 2 })),
            (Held::Confirmed, Some(2))
        );
        assert_eq!(receipt(&key, &seen), Held::Confirmed);

        forget(&key);
        assert_eq!(
            append_in(&key, &seen, &json!({ "n": 3 })),
            (Held::Moved, None),
            "no record at all"
        );
        assert!(since(&key, 0).is_empty(), "and none was made for it");
        append(&key, &json!({ "new": true }));
        assert_eq!(
            append_in(&key, &seen, &json!({ "n": 3 })),
            (Held::Moved, None),
            "the record there now is another"
        );
        assert_eq!(receipt(&key, &seen), Held::Moved);
        let lines = since(&key, 0);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert_eq!(lines[0].event, json!({ "new": true }));

        // A record not made yet is one too: the line makes it.
        let fresh = unique_key("append-in-fresh");
        let none_yet = generation(&fresh).unwrap();
        assert_eq!(
            append_in(&fresh, &none_yet, &json!({ "n": 1 })),
            (Held::Confirmed, Some(1))
        );
        assert_eq!(
            append_in("not/a key", &none_yet, &json!({ "n": 1 })),
            (Held::Unconfirmed, None)
        );
        forget(&key);
        forget(&fresh);
    }

    /// A line `append_in` wrote is confirmed by the record's own receipt,
    /// in a file that was already there too: with the folder's sync
    /// failing it is written, numbered and not confirmed, and `receipt`
    /// says the same of it until the sync goes through.
    #[test]
    fn a_line_put_in_a_record_is_confirmed_only_with_its_folder() {
        let key = unique_key("append-in-sync");
        append(&key, &json!({ "n": 1 }));
        let seen = generation(&key).unwrap();
        FAIL_DIR_SYNC.with(|fail| fail.set(true));
        assert_eq!(
            append_in(&key, &seen, &json!({ "n": 2 })),
            (Held::Unconfirmed, Some(2)),
            "written, and its folder not synced"
        );
        assert_eq!(receipt(&key, &seen), Held::Unconfirmed);
        assert_eq!(confirm_synced(&key, &seen), None);
        FAIL_DIR_SYNC.with(|fail| fail.set(false));
        assert_eq!(since(&key, 0).len(), 2, "the line is there all the while");
        assert_eq!(receipt(&key, &seen), Held::Confirmed);
        assert_eq!(generation(&key), Some(seen), "a receipt moves nothing");
        forget(&key);
    }

    /// The check of which record a chat has and the append are one step:
    /// a chat cleared and written to again by another thread, at any
    /// moment, never has a line that was meant for its old record. Each
    /// round ends one of two ways: the line was refused (the clear came
    /// first), or it went with the record it was written into (the clear
    /// came after). A check made before the lock and an append made under
    /// it lets the clear land between the two.
    #[test]
    fn a_cleared_record_never_gets_a_line_meant_for_the_one_before_it() {
        const ROUNDS: usize = 500;
        let (mut refused, mut cleared_away) = (0, 0);
        for round in 0..ROUNDS {
            let key = unique_key("append-in-race");
            append(&key, &json!({ "old": true }));
            let seen = generation(&key).unwrap();
            let together = std::sync::Arc::new(std::sync::Barrier::new(2));
            let clear = {
                let (key, together) = (key.clone(), together.clone());
                std::thread::spawn(move || {
                    together.wait();
                    forget(&key);
                    append(&key, &json!({ "new": true }));
                })
            };
            together.wait();
            let (held, _) = append_in(&key, &seen, &json!({ "answer": "for the old record" }));
            clear.join().unwrap();
            let lines = since(&key, 0);
            assert_eq!(lines.len(), 1, "round {round}: {lines:?}");
            assert_eq!(lines[0].event, json!({ "new": true }), "round {round}");
            match held {
                Held::Moved => refused += 1,
                _ => cleared_away += 1,
            }
            forget(&key);
        }
        assert_eq!(refused + cleared_away, ROUNDS);
    }

    /// A record removed by its file alone (startup's tidy of transcripts no
    /// chat points at) is forgotten the same way: its generation moves and
    /// its count goes, so the next record under that name starts at one.
    #[test]
    fn a_record_removed_by_its_file_is_forgotten_like_any_other() {
        let key = unique_key("forget-file");
        append(&key, &json!({ "n": 1 }));
        assert_eq!(append(&key, &json!({ "n": 2 })), Some(2));
        let seen = generation(&key).unwrap();
        let path = path_for(&key).unwrap();
        assert!(forget_file(&path));
        assert!(!path.exists());
        assert!(!forget_file(&path), "nothing left to remove");
        assert_eq!(append(&key, &json!({ "n": 3 })), Some(1));
        assert_eq!(confirm_synced(&key, &seen), None);
        forget(&key);
    }

    /// A rewrite keeps every line in its place, so the record it leaves is
    /// the same record: a compaction between a look and its receipt costs
    /// nothing. Unless it replaced a host event's line, which a receipt may
    /// be owed for: then the record is no longer the one that was seen.
    #[test]
    fn a_rewrite_is_the_same_record_unless_it_replaced_a_host_event() {
        let key = unique_key("rewrite-generation");
        // Text that quotes a host event's spelling is not one: the quotes
        // inside a string are escaped in the record.
        let quoted = json!({ "type": "user", "text": r#"long "type":"octiq_task_reopened""# });
        append(&key, &quoted);
        append(
            &key,
            &json!({ "type": "octiq_task_reopened", "taskId": "t" }),
        );
        let path = path_for(&key).unwrap();
        let seen = generation(&key).unwrap();

        let shorter = r#"{"type":"user","text":"short"}"#;
        let changed = rewrite_lines(&path, |line| {
            line.contains("long").then(|| shorter.to_string())
        });
        assert!(changed.unwrap());
        assert!(
            !rewrite_lines(&path, |_| None).unwrap(),
            "nothing to change"
        );
        assert_eq!(generation(&key), Some(seen.clone()));
        assert_eq!(confirm_synced(&key, &seen), Some(()));
        assert_eq!(of_type(&key, "octiq_task_reopened").len(), 1);

        let emptied = r#"{"type":"octiq_compacted","into":1}"#;
        let changed = rewrite_lines(&path, |line| {
            line.contains("taskId").then(|| emptied.to_string())
        });
        assert!(changed.unwrap());
        assert!(of_type(&key, "octiq_task_reopened").is_empty());
        assert_ne!(generation(&key), Some(seen.clone()));
        assert_eq!(confirm_synced(&key, &seen), None);
        forget(&key);
    }

    /// A resumed session's history becomes the start of the chat's record, so
    /// reopening the chat replays it like anything else said there, and the
    /// first turn afterwards is numbered after it.
    #[test]
    fn a_seeded_history_starts_the_record_and_turns_follow_it() {
        let key = unique_key("seeded");
        let history = [
            json!({"type":"user", "message":{"content":[{"type":"text","text":"earlier"}]}}),
            json!({"type":"assistant", "message":{"content":[{"type":"text","text":"reply"}]}}),
        ];
        assert_eq!(seed(&key, &history), Ok(true));
        let read = since(&key, 0);
        assert_eq!(read.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(read[0].event, history[0]);
        assert_eq!(append(&key, &json!({"type":"result"})), Some(3));

        // A restarted server counts the file rather than trusting memory.
        forget_count(&key);
        assert_eq!(append(&key, &json!({"type":"result"})), Some(4));
        forget(&key);
    }

    /// A chat something was already said in keeps its record exactly as it
    /// is: seeding never writes over a conversation, nor slips lines into it.
    #[test]
    fn a_chat_with_a_record_is_never_seeded() {
        let key = unique_key("seed-refused");
        append(&key, &json!({"type":"system", "subtype":"init"}));
        assert_eq!(seed(&key, &[json!({"type":"user"})]), Ok(false));
        assert_eq!(since(&key, 0).len(), 1);

        // Known only from the file, as after a restart.
        forget_count(&key);
        assert_eq!(seed(&key, &[json!({"type":"user"})]), Ok(false));
        assert_eq!(since(&key, 0).len(), 1);
        forget(&key);

        assert!(seed("chat:with/slash", &[]).is_err());
    }

    /// A record whose second line is not UTF-8 (a write cut inside a
    /// character), with whole lines written after it.
    fn damaged_in_the_middle(name: &str) -> String {
        let key = unique_key(name);
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"{\"type\":\"user\",\"n\":1}\n");
        bytes.extend_from_slice(b"{\"type\":\"assistant\",\"text\":\"\xE4\xBD\n");
        bytes.extend_from_slice(b"{\"type\":\"assistant\",\"n\":3}\n");
        bytes.extend_from_slice(b"{\"type\":\"result\",\"n\":4}\n");
        fs::write(path_for(&key).unwrap(), bytes).unwrap();
        key
    }

    fn seqs(read: &[Recorded]) -> Vec<u64> {
        read.iter().map(|recorded| recorded.seq).collect()
    }

    /// Review of bf9d8cd, the carried Medium: `lines().map_while(Result::ok)`
    /// ended a read at the first line that is not UTF-8, so a catch-up read
    /// missed every event after it.
    #[test]
    fn a_line_that_is_not_utf8_hides_no_line_after_it() {
        let key = damaged_in_the_middle("damaged-read");
        assert_eq!(seqs(&since(&key, 0)), [1, 3, 4]);
        assert_eq!(seqs(&since(&key, 1)), [3, 4]);
        assert_eq!(since(&key, 3)[0].event["n"], 4);
        // And a page numbers the same lines the same way.
        assert_eq!(seqs(&page(&key, None).unwrap().events), [1, 3, 4]);
        assert_eq!(of_type(&key, "result").len(), 1);
        forget(&key);
    }

    /// The same line is still a line when the next one is numbered: a seq
    /// is the physical line, for the count as for every reader.
    #[test]
    fn a_line_that_is_not_utf8_is_counted_when_the_next_line_is_numbered() {
        let key = damaged_in_the_middle("damaged-count");
        assert_eq!(append(&key, &json!({"type":"user","n":5})), Some(5));
        let read = since(&key, 4);
        assert_eq!(seqs(&read), [5]);
        assert_eq!(read[0].event["n"], 5);
        assert_eq!(seqs(&page(&key, None).unwrap().events), [1, 3, 4, 5]);
        // Nor is such a record an empty one to be seeded.
        forget_count(&key);
        assert_eq!(seed(&key, &[json!({"type":"user"})]), Ok(false));
        forget(&key);
    }

    /// Review of bf9d8cd, finding 1: the token was a bare number, so two
    /// files that had both never moved on were taken for one. A token is
    /// for the record it was read for.
    #[test]
    fn a_receipt_is_refused_for_a_record_other_than_the_one_its_token_was_taken_for() {
        let first = crate::test_dir::TestDir::new("receipt-first");
        let second = crate::test_dir::TestDir::new("receipt-second");
        let key = unique_key("receipt-record");
        let said = json!({"type":"assistant"});
        let token = {
            let _there = crate::profile::started_in(&first);
            assert!(append_synced(&key, &said).is_some());
            let token = generation(&key).unwrap();
            assert!(confirm_synced(&key, &token).is_some());
            token
        };

        let _elsewhere = crate::profile::started_in(&second);
        assert!(append(&key, &said).is_some());
        assert!(
            confirm_synced(&key, &token).is_none(),
            "a receipt for one record was given on another of the same name"
        );
        let own = generation(&key).unwrap();
        assert!(confirm_synced(&key, &own).is_some());
    }

    /// Review of bf9d8cd, finding 3: records were told apart by the text of
    /// their path, so on a filesystem where two spellings are one file a
    /// clear under one spelling left the other's receipt and count alone.
    #[test]
    fn two_spellings_of_a_record_are_one_record_where_the_filesystem_says_so() {
        let lower = unique_key("spelling");
        let upper = lower.to_uppercase();
        assert_eq!(append(&lower, &json!({"n":1})), Some(1));
        if !path_for(&upper).unwrap().exists() {
            // A filesystem that tells them apart: two records, each its own.
            assert_ne!(generation(&lower), generation(&upper));
            assert_eq!(append(&upper, &json!({"n":1})), Some(1));
            forget(&upper);
            assert_eq!(seqs(&since(&lower, 0)), [1]);
            forget(&lower);
            return;
        }

        assert_eq!(generation(&lower), generation(&upper));
        assert_eq!(append(&upper, &json!({"n":2})), Some(2));
        assert_eq!(
            append(&lower, &json!({"n":3})),
            Some(3),
            "one file was numbered by two counters"
        );
        assert_eq!(seqs(&since(&lower, 0)), [1, 2, 3]);

        let token = generation(&lower).unwrap();
        forget(&upper);
        assert!(!path_for(&lower).unwrap().exists());
        assert_eq!(
            append(&lower, &json!({"n":1})),
            Some(1),
            "the cleared record's count was kept under its other spelling"
        );
        assert!(
            confirm_synced(&lower, &token).is_none(),
            "a record cleared under its other spelling still gave a receipt"
        );
        forget(&lower);
    }

    /// Review of bf9d8cd, finding 5: a host event was known by the bytes
    /// `"type":"octiq_`, so one written with other spacing could be
    /// replaced without the record moving on. It is asked of the line's own
    /// top-level `type` now.
    #[test]
    fn a_host_event_is_known_by_its_type_however_the_line_is_spaced() {
        assert!(is_host_event(
            br#"{"type":"octiq_task_reopened","taskId":"t"}"#
        ));
        assert!(is_host_event(
            br#"{ "taskId": "t", "type" : "octiq_task_reopened" }"#
        ));
        assert!(is_host_event(br#"{"type":"octiq_task_reopened"}"#));
        // What an agent says about one, or carries inside something else,
        // is not one.
        assert!(!is_host_event(
            br#"{"type":"assistant","text":"\"type\":\"octiq_task_reopened\""}"#
        ));
        assert!(!is_host_event(
            br#"{"type":"user","message":{"type":"octiq_task_reopened"}}"#
        ));
        assert!(!is_host_event(br#"{"n":1}"#));
        // A line that cannot be read is not known not to be one.
        assert!(is_host_event(b"{\"type\":\"octiq_task_reo"));
        assert!(is_host_event(b"\xff\xfe"));

        let key = unique_key("spaced-host-event");
        let path = path_for(&key).unwrap();
        fs::write(
            &path,
            "{ \"type\" : \"octiq_task_reopened\", \"taskId\" : \"t\" }\n",
        )
        .unwrap();
        let seen = generation(&key).unwrap();
        let replaced = rewrite_lines(&path, |_| Some(r#"{"type":"user"}"#.to_string()));
        assert!(replaced.unwrap());
        assert_eq!(confirm_synced(&key, &seen), None);
        forget(&key);
    }

    /// Capacity is not a history mutation. Live debt tokens remain known,
    /// including more live tokens than the housekeeping batch size.
    #[test]
    fn generation_capacity_never_moves_live_tokens_and_dead_bookkeeping_is_bounded() {
        let record = |n: usize| PathBuf::from(format!("/chats/chat_{n}.jsonl"));
        let mut table = Generations::default();
        let held: Vec<_> = (0..40).map(|n| table.number(&record(n), 8)).collect();
        for n in 40..1_040 {
            drop(table.number(&record(n), 8));
            assert!(table.observed.len() <= held.len() + 8);
        }
        for (n, old) in held.iter().enumerate() {
            assert_eq!(table.number(&record(n), 8), *old, "untouched life {n}");
        }
        // Real moves remain observable after any amount of unrelated churn.
        table.move_on(&record(0));
        for n in 1_040..2_040 {
            drop(table.number(&record(n), 8));
            table.move_on(&record(n));
        }
        assert_ne!(table.number(&record(0), 8), held[0]);
        assert_eq!(table.number(&record(1), 8), held[1]);
        drop(held);
        for n in 2_040..3_040 {
            drop(table.number(&record(n), 8));
        }
        assert!(table.observed.len() <= 8);
        eprintln!(
            "generation bookkeeping after churn: {} entries, no floor",
            table.observed.len()
        );
    }

    /// The same for a record that is not there yet when it is asked about:
    /// it is the record a later write makes, under either spelling.
    #[test]
    fn a_record_not_made_yet_is_the_one_a_write_under_another_spelling_makes() {
        let lower = unique_key("unmade");
        let upper = lower.to_uppercase();
        let before = generation(&lower).unwrap();
        assert!(append_synced(&upper, &json!({"n":1})).is_some());
        if !path_for(&lower).unwrap().exists() {
            forget(&upper);
            return;
        }
        assert_eq!(generation(&upper).unwrap(), before);
        assert!(confirm_synced(&lower, &before).is_some());

        forget(&upper);
        assert!(append(&lower, &json!({"n":1})).is_some());
        assert!(
            confirm_synced(&lower, &before).is_none(),
            "a record cleared under its other spelling still gave a receipt"
        );
        forget(&lower);
    }
}

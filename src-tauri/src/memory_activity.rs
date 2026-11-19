//! What an agent's memory write came to, shown in the chat that made it.
//!
//! An agent saying "I've noted that" proves nothing, and the tool call that did
//! the writing is one grey row among dozens. So the host — the only party that
//! saw the vault's receipt — writes its own line into the chat: who updated
//! their memory, when, and what the entry said. The line is recorded in the
//! chat's transcript like any other event, so a reload, a reconnect or a
//! restarted server replays it. It comes from the host path every provider
//! shares (`/hook/vault` → `memory_vault_agent`), never from reading tool names.
//!
//! The rules:
//!
//! * **Only a saved receipt is shown as saved.** A call that left no receipt
//!   never touched the note and is `failed`. One whose receipt is pending or
//!   needs review may or may not have reached it, and is `uncertain` until the
//!   vault reconciles that same receipt. A call refused because its requestId
//!   already belongs to a different, earlier change is `refused`: nothing was
//!   written by it, and its line names the earlier change's own state, so a
//!   saved entry is never drawn as "not updated".
//! * **A line is one operation.** A write that reached the vault is keyed by
//!   its receipt id — the authenticated chat, the vault folder and the
//!   requestId, exactly as the vault keys it — and changes only on that
//!   receipt's own evidence (uncertain → saved). A saved line never changes.
//!   A refusal is keyed by what was refused, so an identical failure reported
//!   twice is one line, and it never turns into anyone's success.
//! * **Delivered once, durably.** The chat's transcript is the proof of what
//!   the chat was shown, so before a line is written that transcript is
//!   asked whether it already holds it — whatever the ledger remembers, since
//!   the ledger forgets old writes (`KEEP`) and a transcript can be restored
//!   behind its back. Per destination chat the ledger records an intent
//!   (synced, folder included) before the line, and the confirmation only
//!   after the line is synced too. No intent on disk, no line. At the next
//!   start (`recover`) an unconfirmed intent is finished, and a confirmed line
//!   the transcript has since lost is written back — each at most once.
//! * **Every failure is said.** A step the disk refused is in `Recorded`, and
//!   from there in the tool's answer; it is never confirmed.
//! * **A worker's coordinator hears THAT it happened, not what.** When the chat
//!   is a worker in a run, the run's coordinator chat gets a line naming the
//!   agent, the task and the worker chat to open. The entry's words stay in
//!   the worker chat. The worker → run → coordinator link is read again after
//!   the vault has saved, and again before a restart delivers or restores a
//!   coordinator's line: a chat that is no longer this worker's coordinator
//!   (or no longer exists) is told nothing.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::orchestration::OrchestrationStore;
use crate::team::{LocalNow, MemoryAppend, MemoryWrite, TeamAgent};

static LOCK: Mutex<()> = Mutex::new(());
/// How many activities the ledger remembers. Forgetting one costs only its
/// snapshot: its lines stay in the transcripts, which are what a repeat is
/// checked against. An intent not yet confirmed, or a write still uncertain,
/// is never forgotten.
const KEEP: usize = 5000;
pub const EVENT: &str = "octiq_memory_activity";

/// Ordered by strength: a saved line covers every weaker one for its write.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Failed,
    /// This call wrote nothing because its requestId is another, earlier
    /// change's; `Activity::earlier` says what became of that one.
    Refused,
    Uncertain,
    Saved,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentRef {
    pub id: String,
    pub name: String,
}

/// The run a worker chat belongs to, as its coordinator is told about it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub coordinator_chat_key: String,
    pub task_id: String,
    pub task_title: String,
    pub run_id: String,
}

/// The earlier change a refused call's requestId belongs to, from its receipt.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EarlierChange {
    pub id: String,
    pub status: String,
}

/// One memory write, as it stood when it was recorded: who, when and where
/// are a snapshot, never re-read later.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    /// The chat whose agent made the write — proven by its capability.
    pub chat_key: String,
    pub request_id: String,
    pub status: Status,
    /// `None` when the chat is no registered agent's: said, never guessed.
    pub agent: Option<AgentRef>,
    /// When this status was reached, in Unix milliseconds.
    pub at: u64,
    /// The note, relative to the vault.
    pub note: Option<String>,
    pub date: Option<String>,
    pub text: Option<String>,
    pub receipt_id: Option<String>,
    pub receipt_status: Option<String>,
    pub error: Option<String>,
    pub owner: Option<Owner>,
    /// Set on a `Refused` line only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub earlier: Option<EarlierChange>,
}

#[derive(Default, Serialize, Deserialize)]
struct Entry {
    activity: Option<Activity>,
    /// Chat key → the status a line was confirmed on disk for. A record, not
    /// the proof: the transcript is still asked before anything is written.
    #[serde(default)]
    delivered: BTreeMap<String, Status>,
    /// Chat key → a line about to be written. Still here after a restart
    /// means the process stopped between the intent and the confirmation.
    #[serde(default)]
    pending: BTreeMap<String, Status>,
}

#[derive(Default, Serialize, Deserialize)]
struct Ledger {
    #[serde(default)]
    entries: BTreeMap<String, Entry>,
}

/// What recording came to, destination by destination, and every step the
/// disk refused on the way. Nothing in `pending` is confirmed anywhere.
#[derive(Debug, Default, PartialEq)]
pub struct Recorded {
    /// Chats given their line now, on disk.
    pub shown: Vec<String>,
    /// Chats whose line is not confirmed: never written, or written but not
    /// proven on disk. A recorded intent is finished by the next report of
    /// the write or the next start.
    pub pending: Vec<String>,
    /// What went wrong, in words fit for the tool's answer.
    pub errors: Vec<String>,
}

impl Recorded {
    /// One sentence for the agent when anything was left undone.
    pub fn problem(&self) -> Option<String> {
        (!self.errors.is_empty()).then(|| {
            format!(
                "OctiqFlow could not fully record this call's line in the chat ({}); the vault's own answer above is still what happened to the memory.",
                self.errors.join("; ")
            )
        })
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn digest(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()))
}

/// What an append came to, as the activity to show for it. `root` is the
/// vault folder, part of a refusal's identity as it is of a receipt's.
pub fn from_append(
    chat_key: &str,
    agent: Option<&TeamAgent>,
    request_id: &str,
    root: &str,
    append: &MemoryAppend,
    owner: Option<Owner>,
) -> Activity {
    let receipt = match &append.outcome {
        MemoryWrite::Saved { receipt, .. } | MemoryWrite::Uncertain { receipt, .. } => {
            Some(receipt)
        }
        MemoryWrite::Conflict { .. } | MemoryWrite::Failed(_) => None,
    };
    let field = |name: &str| {
        receipt
            .and_then(|r| r.get(name))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let (status, error) = match &append.outcome {
        MemoryWrite::Saved { .. } => (Status::Saved, None),
        MemoryWrite::Uncertain { error, .. } => (Status::Uncertain, Some(error.clone())),
        MemoryWrite::Conflict { error, .. } => (Status::Refused, Some(error.clone())),
        MemoryWrite::Failed(error) => (Status::Failed, Some(error.clone())),
    };
    let earlier = match &append.outcome {
        MemoryWrite::Conflict { earlier, .. } => Some(EarlierChange {
            id: earlier["id"].as_str().unwrap_or_default().to_owned(),
            status: earlier["status"].as_str().unwrap_or("unknown").to_owned(),
        }),
        _ => None,
    };
    let text = (!append.text.is_empty()).then(|| append.text.clone());
    let id = match field("id") {
        Some(receipt) => receipt,
        None => refusal_id(chat_key, root, request_id, &text, &append.date, &error),
    };
    Activity {
        id,
        chat_key: chat_key.to_owned(),
        request_id: request_id.to_owned(),
        status,
        agent: agent.map(|a| AgentRef {
            id: a.id.clone(),
            name: a.name.clone(),
        }),
        at: now_ms(),
        note: append.note.clone(),
        date: append.date.clone(),
        text,
        receipt_id: field("id"),
        receipt_status: field("status"),
        error,
        owner,
        earlier,
    }
}

/// A refusal is its own line: the same call refused for the same reason is
/// the same line, and nothing else is.
fn refusal_id(
    chat_key: &str,
    root: &str,
    request_id: &str,
    text: &Option<String>,
    date: &Option<String>,
    error: &Option<String>,
) -> String {
    digest(&json!([
        "agent-memory-refused",
        chat_key,
        root,
        request_id,
        text,
        date,
        error
    ]))
}

/// A call that never reached the vault — the chat is no registered agent's.
pub fn refused(chat_key: &str, root: &str, request_id: &str, error: &str) -> Activity {
    let error = Some(error.to_owned());
    Activity {
        id: refusal_id(chat_key, root, request_id, &None, &None, &error),
        chat_key: chat_key.to_owned(),
        request_id: request_id.to_owned(),
        status: Status::Failed,
        agent: None,
        at: now_ms(),
        note: None,
        date: None,
        text: None,
        receipt_id: None,
        receipt_status: None,
        error,
        owner: None,
        earlier: None,
    }
}

/// The line the writing chat is shown: everything about this one write.
fn origin_event(activity: &Activity) -> Value {
    let mut event = json!({
        "type": EVENT,
        "id": activity.id,
        "status": activity.status,
        "agent": activity.agent,
        "at": activity.at,
        "requestId": activity.request_id,
        "note": activity.note,
        "date": activity.date,
        "text": activity.text,
        "receipt": activity.receipt_id.as_ref().map(|id| json!({
            "id": id, "status": activity.receipt_status,
        })),
        "error": activity.error,
    });
    if let Some(earlier) = &activity.earlier {
        event["earlier"] = json!({"id": earlier.id, "status": earlier.status});
    }
    event
}

/// The line a worker's coordinator is shown: who, when, and where to look —
/// never the entry itself.
fn owner_event(activity: &Activity, owner: &Owner) -> Value {
    json!({
        "type": EVENT,
        "id": activity.id,
        "status": activity.status,
        "agent": activity.agent,
        "at": activity.at,
        "source": {
            "chatKey": activity.chat_key,
            "taskId": owner.task_id,
            "taskTitle": owner.task_title,
            "runId": owner.run_id,
        },
    })
}

fn ledger_path() -> Option<PathBuf> {
    Some(crate::transcript::chats_dir()?.join("memory-activity.json"))
}

fn load(path: &Path) -> Ledger {
    load_to_write(path).unwrap_or_default()
}

/// The ledger, for a call that will write it back. No file, in a profile
/// that is there, is an empty ledger. A profile folder that is not there is
/// an error: an empty ledger written back once the folder returned would
/// replace every intent and snapshot the real one holds.
fn load_to_write(path: &Path) -> Result<Ledger, String> {
    Ok(
        match crate::profile::read(path, |error| error.to_string())? {
            Some(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                // A torn ledger costs the snapshots and unconfirmed intents, not
                // the chats' lines or their duplicate guard, which are in the
                // transcripts. Keep it for a person to read.
                eprintln!("memory_activity: unreadable ledger, starting over: {error}");
                let _ = fs::rename(path, path.with_extension("json.corrupt"));
                Ledger::default()
            }),
            None => Ledger::default(),
        },
    )
}

/// Refuse migration while an activity delivery is in progress or a saved
/// intent still needs this record. Never turn an unreadable ledger into empty.
pub(crate) fn record_quiet(record: &str) -> Result<(), String> {
    let _guard = LOCK
        .try_lock()
        .map_err(|_| "memory activity delivery is busy")?;
    let path = ledger_path().ok_or("memory activity ledger is unavailable")?;
    let ledger: Ledger = crate::profile::read(&path, |e| e.to_string())?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(|e| e.to_string()))
        .transpose()?
        .unwrap_or_default();
    let same = |chat: &str| crate::transcript::key_record_claim(chat).as_deref() == Some(record);
    let mut shown = None;
    for (id, entry) in ledger.entries {
        if entry.pending.keys().any(|chat| same(chat)) {
            return Err("chat record still owes a memory activity line".into());
        }
        for (chat, status) in entry.delivered.iter().filter(|(chat, _)| same(chat)) {
            let lines = shown.get_or_insert_with(|| shown_in(chat));
            if lines.get(&id).is_none_or(|held| *held < *status) {
                return Err("chat record still owes a recovered memory activity line".into());
            }
        }
    }
    Ok(())
}

/// Write the whole ledger in place of the old one: synced, renamed, and the
/// folder synced, so an intent it holds survives a power cut.
fn save(path: &Path, ledger: &Ledger) -> Result<(), String> {
    #[cfg(test)]
    faults::save()?;
    let dir = path.parent().ok_or("The ledger has no folder.")?;
    let temp = dir.join(format!(".memory-activity-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(ledger).map_err(|e| e.to_string())?;
    let written = fs::File::create(&temp).and_then(|mut file| {
        file.write_all(&bytes)?;
        file.sync_all()
    });
    if let Err(error) = written.and_then(|_| fs::rename(&temp, path)) {
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    crate::transcript::sync_dir(dir).map_err(|e| format!("the ledger's folder: {e}"))
}

/// Whether `chat`'s transcript already shows this write at `status` — or as
/// saved, which no later report can take back.
///
/// Read through the transcript's own reader of one event type, which
/// parses only the lines that name it: one pass over the bytes even for a
/// very long chat, and a line that cannot be decoded hides none after it.
fn in_transcript(chat: &str, id: &str, status: Status) -> bool {
    crate::transcript::of_type(chat, EVENT)
        .into_iter()
        .filter(|event| event["id"] == id)
        .filter_map(|event| serde_json::from_value::<Status>(event["status"].clone()).ok())
        .any(|shown| shown == status || shown == Status::Saved)
}

/// Every memory line `chat`'s transcript holds, id → the strongest status it
/// was shown at. One pass over the file.
fn shown_in(chat: &str) -> HashMap<String, Status> {
    let mut shown = HashMap::new();
    for event in crate::transcript::of_type(chat, EVENT) {
        let (Some(id), Ok(status)) = (
            event["id"].as_str(),
            serde_json::from_value::<Status>(event["status"].clone()),
        ) else {
            continue;
        };
        let best = shown.entry(id.to_owned()).or_insert(status);
        *best = (*best).max(status);
    }
    shown
}

/// Whether the host holds a durability receipt for `chat`'s record as it is
/// now: the file and then its folder synced, for the record `seen` named
/// (`transcript::confirm_synced`). The one thing that lets a line be called
/// delivered here, whether it was found in the record or written just now.
fn receipt(chat: &str, seen: Option<&crate::transcript::Generation>) -> bool {
    seen.is_some_and(|seen| crate::transcript::confirm_synced(chat, seen).is_some())
}

/// A line reaches a chat's transcript and is synced to disk before this
/// answers, then goes to every attached browser.
fn deliver(chat: &str, event: Value) -> Option<u64> {
    crate::agent_chat::record_chat_event_synced(chat, event)
}

/// What the ledger's record becomes when `fresh` is reported for it.
///
/// Only the receipt's own evidence moves a line: an uncertain write whose
/// receipt is now saved becomes saved. Everything else keeps the snapshot it
/// was first recorded with, so a saved line is never undone by a later call.
fn settle(old: Option<Activity>, fresh: &Activity) -> Activity {
    match old {
        None => fresh.clone(),
        Some(old)
            if old.status == Status::Uncertain
                && fresh.status == Status::Saved
                && old.receipt_id.is_some()
                && old.receipt_id == fresh.receipt_id =>
        {
            Activity {
                status: Status::Saved,
                at: fresh.at,
                receipt_status: fresh.receipt_status.clone(),
                error: None,
                owner: old.owner.clone().or_else(|| fresh.owner.clone()),
                ..old
            }
        }
        Some(old) => Activity {
            owner: old.owner.clone().or_else(|| fresh.owner.clone()),
            ..old
        },
    }
}

/// The process stopped here (tests only): nothing after this step happens.
struct Crashed;

/// The ledger as one call holds it, and whether it differs from the disk.
struct Book<'a> {
    path: &'a Path,
    ledger: Ledger,
    dirty: bool,
}

impl Book<'_> {
    fn entry(&mut self, id: &str) -> &mut Entry {
        self.ledger.entries.entry(id.to_owned()).or_default()
    }

    /// Write the ledger. A failure is said in `out`, and the caller must not
    /// go on as though the step had happened.
    fn save(&mut self, out: &mut Recorded, what: &str) -> Result<(), ()> {
        match save(self.path, &self.ledger) {
            Ok(()) => {
                self.dirty = false;
                Ok(())
            }
            Err(error) => {
                eprintln!("memory_activity: could not store {what}: {error}");
                out.errors.push(format!("could not store {what}: {error}"));
                Err(())
            }
        }
    }

    /// Anything not yet on disk, at the end of a call.
    fn finish(&mut self, out: &mut Recorded) -> Result<(), Crashed> {
        if self.dirty && self.save(out, "the memory line ledger").is_ok() {
            step()?;
        }
        Ok(())
    }
}

/// A durable step just finished. Under test, the process may "crash" here.
fn step() -> Result<(), Crashed> {
    #[cfg(test)]
    if faults::crash_now() {
        return Err(Crashed);
    }
    Ok(())
}

/// Record an activity and show it to every chat not yet shown this status.
/// `fresh.owner` is the coordinator as it stands NOW; a line goes there only
/// if that still agrees with the one recorded. `emit` must answer `Some` only
/// once the line is synced to the transcript.
fn record_at(path: &Path, fresh: Activity, emit: impl Fn(&str, Value) -> Option<u64>) -> Recorded {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    #[cfg(test)]
    let held = std::time::Instant::now();
    let mut out = Recorded::default();
    let _ = record_locked(path, fresh, &emit, &mut out);
    #[cfg(test)]
    faults::held(held.elapsed());
    out
}

fn record_locked(
    path: &Path,
    fresh: Activity,
    emit: &impl Fn(&str, Value) -> Option<u64>,
    out: &mut Recorded,
) -> Result<(), Crashed> {
    let ledger = match load_to_write(path) {
        Ok(ledger) => ledger,
        Err(error) => {
            eprintln!("memory_activity: could not read the ledger, nothing recorded: {error}");
            return Ok(());
        }
    };
    let mut book = Book {
        path,
        ledger,
        dirty: true,
    };
    let old = book
        .ledger
        .entries
        .get_mut(&fresh.id)
        .and_then(|entry| entry.activity.take());
    let current = settle(old, &fresh);
    let mut lines = vec![(current.chat_key.clone(), origin_event(&current))];
    if current.status == Status::Saved {
        if let (Some(owner), Some(now)) = (&current.owner, &fresh.owner) {
            if owner.coordinator_chat_key == now.coordinator_chat_key
                && owner.run_id == now.run_id
                && owner.task_id == now.task_id
                && owner.coordinator_chat_key != current.chat_key
            {
                lines.push((
                    owner.coordinator_chat_key.clone(),
                    owner_event(&current, owner),
                ));
            }
        }
    }
    book.entry(&current.id).activity = Some(current.clone());
    forget_oldest(&mut book.ledger, &current.id);
    show(&mut book, &current, lines, emit, out)?;
    book.finish(out)
}

/// Give each chat in `lines` its line for `current`, unless its transcript
/// already has it.
///
/// On disk, in order: the intents (every destination's, in one save), then
/// per chat the line and its confirmation. No line is written unless its
/// intent is stored, and no confirmation made unless the line is synced, so a
/// crash between any two steps leaves intents that `recover` or the next
/// report finishes — and a step the disk refused is in `out`, never taken
/// for done.
fn show(
    book: &mut Book,
    current: &Activity,
    lines: Vec<(String, Value)>,
    emit: &impl Fn(&str, Value) -> Option<u64>,
    out: &mut Recorded,
) -> Result<(), Crashed> {
    let mut owed = Vec::new();
    for (chat, event) in lines {
        // Which record the chat has, taken before it is read: a receipt is
        // for the record the line was seen in or written to.
        let record = crate::transcript::generation(&chat);
        let entry = book.entry(&current.id);
        if in_transcript(&chat, &current.id, current.status) {
            // Already there — written before a crash, or remembered by a
            // transcript the ledger has forgotten about: confirm, never
            // repeat.
            if entry.delivered.get(&chat) == Some(&current.status)
                && !entry.pending.contains_key(&chat)
            {
                continue;
            }
            // A line that can be read is one the OS holds, not yet one the
            // disk does. The ledger calls it delivered only on a receipt,
            // as for a line written now; until then it stays an intent,
            // which `recover` or the next report confirms.
            if !receipt(&chat, record.as_ref()) {
                let changed =
                    entry.pending.insert(chat.clone(), current.status) != Some(current.status);
                let undone = entry.delivered.remove(&chat).is_some();
                book.dirty |= changed || undone;
                out.errors.push(format!(
                    "the line in chat {chat} could not be confirmed on disk"
                ));
                out.pending.push(chat);
                continue;
            }
            let was_pending = entry.pending.remove(&chat).is_some();
            let changed =
                entry.delivered.insert(chat.clone(), current.status) != Some(current.status);
            book.dirty |= was_pending || changed;
        } else {
            entry.pending.insert(chat.clone(), current.status);
            entry.delivered.remove(&chat);
            book.dirty = true;
            owed.push((chat, event, record));
        }
    }
    if owed.is_empty() {
        return Ok(());
    }
    if book.save(out, "the intent to show this line").is_err() {
        // Without the intent on disk, a crash after a line would leave
        // nothing to finish or check it by. Say so, and draw nothing.
        out.pending
            .extend(owed.into_iter().map(|(chat, _, _)| chat));
        return Ok(());
    }
    step()?;
    for (chat, event, record) in owed {
        // The write's own answer is not the receipt either: it syncs the
        // folder only for a file it made.
        if emit(&chat, event).is_none() || !receipt(&chat, record.as_ref()) {
            // Not proven on disk: the intent stays, and a restart or the
            // next report of this write looks for the line and finishes it.
            out.errors
                .push(format!("the line could not be synced to chat {chat}"));
            out.pending.push(chat);
            continue;
        }
        step()?;
        let entry = book.entry(&current.id);
        entry.pending.remove(&chat);
        entry.delivered.insert(chat.clone(), current.status);
        book.dirty = true;
        out.shown.push(chat);
        if book.save(out, "that the line was shown").is_ok() {
            step()?;
        }
    }
    Ok(())
}

/// Past `KEEP`, drop the oldest snapshots that nothing still depends on: an
/// unconfirmed intent must survive for `recover`, an uncertain write for
/// the receipt check that may yet settle it, and `recording` — the write
/// being recorded now — for the lines about to be drawn for it.
fn forget_oldest(ledger: &mut Ledger, recording: &str) {
    if ledger.entries.len() <= KEEP {
        return;
    }
    let mut by_age: Vec<(u64, String)> = ledger
        .entries
        .iter()
        .filter(|(id, e)| {
            id.as_str() != recording
                && e.pending.is_empty()
                && e.activity
                    .as_ref()
                    .is_none_or(|a| a.status != Status::Uncertain)
        })
        .map(|(id, e)| (e.activity.as_ref().map_or(0, |a| a.at), id.clone()))
        .collect();
    by_age.sort();
    let excess = ledger.entries.len() - KEEP;
    for (_, id) in by_age.into_iter().take(excess) {
        ledger.entries.remove(&id);
    }
}

/// The coordinator a worker chat's line goes to as things stand now: its
/// latest attempt's run, while that coordinator chat exists and is not the
/// worker itself. `Err` when the orchestration ledger cannot be read.
fn current_owner(
    orchestrations: &OrchestrationStore,
    worker: &str,
) -> Result<Option<Owner>, String> {
    Ok(orchestrations
        .worker_owner(worker)?
        .and_then(|w| owner_if_present(w, worker)))
}

/// After a restart, before anyone asks: finish every line whose intent was
/// recorded but never confirmed, and write back every confirmed line its
/// chat's transcript no longer holds.
pub fn recover(orchestrations: &OrchestrationStore) -> Recorded {
    let recorded = match ledger_path() {
        Some(path) => recover_at(
            &path,
            |worker| current_owner(orchestrations, worker),
            deliver,
        ),
        None => Recorded::default(),
    };
    if !recorded.errors.is_empty() {
        eprintln!(
            "memory_activity: recovery left lines unfinished: {}",
            recorded.errors.join("; ")
        );
    }
    recorded
}

/// What recovery owes one chat for one write.
#[derive(Clone, Copy, PartialEq)]
enum Owed {
    /// An intent a crash left unconfirmed.
    Pending(Status),
    /// A confirmed line, to be written back if its transcript lost it.
    Delivered(Status),
}

fn recover_at(
    path: &Path,
    owner_now: impl Fn(&str) -> Result<Option<Owner>, String>,
    emit: impl Fn(&str, Value) -> Option<u64>,
) -> Recorded {
    let mut out = Recorded::default();
    // Everything the ledger says is owed or was delivered — read under the
    // lock, then checked against the transcripts outside it, so a start
    // with long transcripts does not hold up a write being recorded.
    let owed: Vec<(String, String, Owed)> = {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load(path)
            .entries
            .iter()
            .filter(|(_, e)| e.activity.is_some())
            .flat_map(|(id, e)| {
                let pending = e
                    .pending
                    .iter()
                    .map(|(chat, s)| (id.clone(), chat.clone(), Owed::Pending(*s)));
                let delivered = e
                    .delivered
                    .iter()
                    .map(|(chat, s)| (id.clone(), chat.clone(), Owed::Delivered(*s)));
                pending.chain(delivered).collect::<Vec<_>>()
            })
            .collect()
    };
    // A delivered line is owed again only if its transcript lacks it. One
    // pass per chat, however many lines it was given.
    let mut transcripts: HashMap<String, HashMap<String, Status>> = HashMap::new();
    let owed: Vec<_> = owed
        .into_iter()
        .filter(|(id, chat, owed)| match owed {
            Owed::Pending(_) => true,
            Owed::Delivered(status) => {
                let shown = transcripts
                    .entry(chat.clone())
                    .or_insert_with(|| shown_in(chat));
                !shown
                    .get(id)
                    .is_some_and(|s| s == status || *s == Status::Saved)
            }
        })
        .collect();
    if owed.is_empty() {
        return out;
    }
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(ledger) = load_to_write(path) else {
        return out;
    };
    let mut book = Book {
        path,
        ledger,
        dirty: false,
    };
    for (id, chat, owed) in owed {
        let Some(entry) = book.ledger.entries.get(&id) else {
            continue;
        };
        // Only what is still owed now: a report made since the first look
        // may have finished it already.
        let still = match owed {
            Owed::Pending(s) => entry.pending.get(&chat) == Some(&s),
            Owed::Delivered(s) => entry.delivered.get(&chat) == Some(&s),
        };
        let Some(activity) = entry.activity.clone().filter(|_| still) else {
            continue;
        };
        let event = if !chat_exists(&chat) {
            // A deleted chat is not written to. An intent for it is done
            // with; a confirmed line stays confirmed.
            None
        } else if chat == activity.chat_key {
            Some(origin_event(&activity))
        } else {
            match coordinator_line(&activity, &chat, &owner_now) {
                Ok(event) => event,
                Err(error) => {
                    // Whose coordinator this is cannot be told right now:
                    // deliver nothing and keep what is owed for next time.
                    out.errors.push(format!(
                        "could not check chat {chat} is still the coordinator: {error}"
                    ));
                    continue;
                }
            }
        };
        let Some(event) = event else {
            let entry = book.entry(&id);
            let dropped = entry.pending.remove(&chat).is_some();
            // A coordinator that no longer is one is not written back to.
            let unlinked = chat != activity.chat_key && chat_exists(&chat);
            if dropped || (unlinked && entry.delivered.remove(&chat).is_some()) {
                book.dirty = true;
            }
            continue;
        };
        if show(&mut book, &activity, vec![(chat, event)], &emit, &mut out).is_err() {
            return out;
        }
    }
    let _ = book.finish(&mut out);
    out
}

/// The line `chat` gets for a worker's write, if it is — still, as of now —
/// that worker's coordinator for the run and task the write was made in.
fn coordinator_line(
    activity: &Activity,
    chat: &str,
    owner_now: &impl Fn(&str) -> Result<Option<Owner>, String>,
) -> Result<Option<Value>, String> {
    let Some(owner) = activity
        .owner
        .as_ref()
        .filter(|o| o.coordinator_chat_key == chat && activity.status == Status::Saved)
    else {
        return Ok(None);
    };
    let linked = owner_now(&activity.chat_key)?.is_some_and(|now| {
        now.coordinator_chat_key == owner.coordinator_chat_key
            && now.run_id == owner.run_id
            && now.task_id == owner.task_id
    });
    Ok(linked.then(|| owner_event(activity, owner)))
}

/// An agent's own-memory tool call, from the chat `actor` its capability
/// proved. Who the agent is comes from that chat — its lead record, or the
/// agent its own worker attempt was reserved for — never from `tool`.
pub fn agent_memory(
    vault: &crate::memory_vault::Vault,
    team_path: &Path,
    orchestrations: &OrchestrationStore,
    actor: &str,
    op: &str,
    tool: &Value,
) -> Result<Value, String> {
    let ledger = ledger_path();
    agent_memory_in(
        ledger.as_deref(),
        vault,
        team_path,
        orchestrations,
        actor,
        op,
        tool,
        LocalNow::system(),
    )
}

#[allow(clippy::too_many_arguments)]
fn agent_memory_in(
    ledger: Option<&Path>,
    vault: &crate::memory_vault::Vault,
    team_path: &Path,
    orchestrations: &OrchestrationStore,
    actor: &str,
    op: &str,
    tool: &Value,
    now: LocalNow,
) -> Result<Value, String> {
    let record = |fresh| ledger.map(|path| record_at(path, fresh, deliver));
    let text = |name: &str| tool.get(name).and_then(Value::as_str);
    let worker = orchestrations.worker_owner(actor);
    let identity = worker.clone().and_then(|worker| {
        crate::team::identity(
            team_path,
            actor,
            worker.and_then(|w| w.assignee).map(|a| a.id),
        )
    });
    match op {
        "read" => {
            let (me, team) = identity?;
            crate::team::memory_read(
                vault,
                actor,
                &me,
                &team,
                text("agent"),
                tool.get("startLine").and_then(Value::as_u64),
            )
        }
        "append" => {
            let request_id = text("requestId").ok_or("Pass a unique requestId.")?;
            let root = vault.settings().map(|c| c.path).unwrap_or_default();
            let (me, _) = match identity {
                Ok(found) => found,
                Err(error) => {
                    let recorded = record(refused(actor, &root, request_id, &error));
                    return Err(with_problem(error, recorded.as_ref()));
                }
            };
            // A retry that leaves the date out has it recovered from its own
            // receipt by the vault's request hash (team::memory_append_at),
            // not from anything this ledger may or may not have kept.
            let append = crate::team::memory_append_at(
                vault,
                actor,
                &me,
                text("text").unwrap_or_default(),
                text("date"),
                request_id,
                now,
            );
            #[cfg(test)]
            faults::after_save_now();
            // Who coordinates this worker is read again now the save is
            // durable: the link read before the write may no longer hold,
            // and a chat that stopped being the coordinator meanwhile is not
            // told. (In this host a run's coordinator chat never changes; a
            // deleted coordinator chat is what this catches in practice.)
            let owner = current_owner(orchestrations, actor).ok().flatten();
            let recorded = record(from_append(
                actor,
                Some(&me),
                request_id,
                &root,
                &append,
                owner,
            ));
            match append.result(&me) {
                Ok(mut value) => {
                    if let Some(problem) = recorded.as_ref().and_then(Recorded::problem) {
                        value["chatLine"] = problem.into();
                    }
                    Ok(value)
                }
                Err(error) => Err(with_problem(error, recorded.as_ref())),
            }
        }
        _ => Err("Unknown agent memory operation.".into()),
    }
}

/// An error, with anything recording its line left undone said after it.
fn with_problem(error: String, recorded: Option<&Recorded>) -> String {
    match recorded.and_then(Recorded::problem) {
        Some(problem) => format!("{error} {problem}"),
        None => error,
    }
}

/// The coordinator a worker's line also goes to, while that chat still exists
/// and is not the worker itself.
fn owner_if_present(worker: crate::orchestration::WorkerOwner, actor: &str) -> Option<Owner> {
    (worker.coordinator_chat_key != actor && chat_exists(&worker.coordinator_chat_key)).then_some(
        Owner {
            coordinator_chat_key: worker.coordinator_chat_key,
            task_id: worker.task_id,
            task_title: worker.task_title,
            run_id: worker.run_id,
        },
    )
}

/// Whether `key` is a chat in the active index.
fn chat_exists(key: &str) -> bool {
    let id = key.strip_prefix("chat:").unwrap_or(key);
    crate::chat_index::list()
        .iter()
        .any(|chat| chat.id == id && chat.deleted_at.is_none())
}

/// `vault_receipt` answered for one of this chat's receipts. A saved answer
/// settles the chat's uncertain line for that same receipt; anything else,
/// or another chat's receipt, changes nothing.
pub fn receipt_checked(
    orchestrations: &OrchestrationStore,
    chat_key: &str,
    receipt: &Value,
) -> Recorded {
    match ledger_path() {
        Some(path) => receipt_checked_at(&path, orchestrations, chat_key, receipt),
        None => Recorded::default(),
    }
}

fn receipt_checked_at(
    path: &Path,
    orchestrations: &OrchestrationStore,
    chat_key: &str,
    receipt: &Value,
) -> Recorded {
    let (Some(id), Some("saved")) = (
        receipt.get("id").and_then(Value::as_str),
        receipt.get("status").and_then(Value::as_str),
    ) else {
        return Recorded::default();
    };
    let found = {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load(path)
            .entries
            .remove(id)
            .and_then(|entry| entry.activity)
    };
    match found {
        Some(activity) if activity.chat_key == chat_key && activity.status == Status::Uncertain => {
            let owner = current_owner(orchestrations, chat_key).ok().flatten();
            record_at(
                path,
                Activity {
                    status: Status::Saved,
                    at: now_ms(),
                    receipt_status: Some("saved".into()),
                    error: None,
                    owner,
                    ..activity
                },
                deliver,
            )
        }
        _ => Recorded::default(),
    }
}

/// Test seams: a "crash" after the Nth durable step, a refused ledger save,
/// and something to do between the vault's save and the line's recording.
/// Per thread, so parallel tests cannot trip each other's.
#[cfg(test)]
mod faults {
    use std::cell::{Cell, RefCell};

    thread_local! {
        static CRASH_AFTER: Cell<Option<usize>> = const { Cell::new(None) };
        static STEPS: Cell<usize> = const { Cell::new(0) };
        static FAIL_SAVES: RefCell<Vec<bool>> = const { RefCell::new(Vec::new()) };
        static AFTER_SAVE: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
    }

    /// Stop after the `n`th durable step (1-based) from now; `None` never.
    pub fn crash_after(n: Option<usize>) {
        STEPS.with(|s| s.set(0));
        CRASH_AFTER.with(|c| c.set(n));
    }

    /// How many durable steps were taken since `crash_after`.
    pub fn steps() -> usize {
        STEPS.with(|s| s.get())
    }

    pub(super) fn crash_now() -> bool {
        let n = STEPS.with(|s| {
            s.set(s.get() + 1);
            s.get()
        });
        CRASH_AFTER.with(|c| c.get() == Some(n))
    }

    /// The next ledger saves succeed or fail in this order; after that, all
    /// succeed.
    pub fn saves(plan: &[bool]) {
        FAIL_SAVES.with(|f| *f.borrow_mut() = plan.iter().rev().map(|ok| !ok).collect());
    }

    pub(super) fn save() -> Result<(), String> {
        match FAIL_SAVES.with(|f| f.borrow_mut().pop()) {
            Some(true) => Err("disk refused the write (test)".into()),
            _ => Ok(()),
        }
    }

    pub fn after_save(run: impl FnOnce() + 'static) {
        AFTER_SAVE.with(|a| *a.borrow_mut() = Some(Box::new(run)));
    }

    /// How long each `record_at` held the lock, for the measurement test.
    pub static HOLDS: std::sync::Mutex<Vec<std::time::Duration>> =
        std::sync::Mutex::new(Vec::new());

    pub(super) fn held(took: std::time::Duration) {
        HOLDS.lock().unwrap_or_else(|e| e.into_inner()).push(took);
    }

    pub(super) fn after_save_now() {
        if let Some(run) = AFTER_SAVE.with(|a| a.borrow_mut().take()) {
            run();
        }
    }
}

#[cfg(test)]
#[path = "memory_activity_tests.rs"]
mod tests;

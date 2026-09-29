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
use std::io::{BufRead, BufReader, Write};
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
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            // A torn ledger costs the snapshots and unconfirmed intents, not
            // the chats' lines or their duplicate guard, which are in the
            // transcripts. Keep it for a person to read.
            eprintln!("memory_activity: unreadable ledger, starting over: {error}");
            let _ = fs::rename(path, path.with_extension("json.corrupt"));
            Ledger::default()
        }),
        Err(_) => Ledger::default(),
    }
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
/// Read straight off the file, and a line is only parsed when the id is in
/// it, so asking costs one pass over the bytes even for a very long chat.
fn in_transcript(chat: &str, id: &str, status: Status) -> bool {
    let Some(file) = crate::transcript::path_for(chat).and_then(|p| fs::File::open(p).ok()) else {
        return false;
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|line| line.contains(id))
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter(|event| event["type"] == EVENT && event["id"] == id)
        .filter_map(|event| serde_json::from_value::<Status>(event["status"].clone()).ok())
        .any(|shown| shown == status || shown == Status::Saved)
}

/// Every memory line `chat`'s transcript holds, id → the strongest status it
/// was shown at. One pass over the file.
fn shown_in(chat: &str) -> HashMap<String, Status> {
    let mut shown = HashMap::new();
    let Some(file) = crate::transcript::path_for(chat).and_then(|p| fs::File::open(p).ok()) else {
        return shown;
    };
    for event in BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|line| line.contains(EVENT))
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter(|event| event["type"] == EVENT)
    {
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
    let mut book = Book {
        path,
        ledger: load(path),
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
        let entry = book.entry(&current.id);
        if in_transcript(&chat, &current.id, current.status) {
            // Already there — written before a crash, or remembered by a
            // transcript the ledger has forgotten about: confirm, never
            // repeat.
            let was_pending = entry.pending.remove(&chat).is_some();
            let changed =
                entry.delivered.insert(chat.clone(), current.status) != Some(current.status);
            book.dirty |= was_pending || changed;
        } else {
            entry.pending.insert(chat.clone(), current.status);
            entry.delivered.remove(&chat);
            book.dirty = true;
            owed.push((chat, event));
        }
    }
    if owed.is_empty() {
        return Ok(());
    }
    if book.save(out, "the intent to show this line").is_err() {
        // Without the intent on disk, a crash after a line would leave
        // nothing to finish or check it by. Say so, and draw nothing.
        out.pending.extend(owed.into_iter().map(|(chat, _)| chat));
        return Ok(());
    }
    step()?;
    for (chat, event) in owed {
        if emit(&chat, event).is_none() {
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
    let mut book = Book {
        path,
        ledger: load(path),
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
mod tests {
    use super::*;

    fn activity(chat: &str, id: &str, status: Status) -> Activity {
        Activity {
            id: id.into(),
            chat_key: chat.into(),
            request_id: "r1".into(),
            status,
            agent: Some(AgentRef {
                id: "agent_1".into(),
                name: "Mango Juice".into(),
            }),
            at: 1,
            note: Some("agent-zone/agents/mango/memory.md".into()),
            date: Some("2026-09-28".into()),
            text: Some("A decision and why.".into()),
            receipt_id: (status != Status::Failed).then(|| id.to_owned()),
            receipt_status: Some(
                match status {
                    Status::Saved => "saved",
                    Status::Uncertain => "needs_review",
                    Status::Failed | Status::Refused => "none",
                }
                .into(),
            ),
            error: (status != Status::Saved).then(|| "boom".into()),
            owner: None,
            earlier: None,
        }
    }

    fn unique(prefix: &str) -> String {
        format!("chat:{prefix}-{}", uuid::Uuid::new_v4())
    }

    fn scratch_ledger() -> PathBuf {
        std::env::temp_dir().join(format!("octiq-memact-ledger-{}.json", uuid::Uuid::new_v4()))
    }

    fn fresh_id() -> String {
        digest(&json!(uuid::Uuid::new_v4().to_string()))
    }

    type Seen = std::sync::Arc<Mutex<Vec<(String, Value)>>>;

    /// Writes to the real (test) transcript and remembers what it wrote.
    fn capture() -> (Seen, impl Fn(&str, Value) -> Option<u64>) {
        let seen: Seen = Default::default();
        let sink = seen.clone();
        (seen, move |chat: &str, event: Value| {
            sink.lock().unwrap().push((chat.to_owned(), event.clone()));
            crate::transcript::append(chat, &event)
        })
    }

    fn lines(chat: &str) -> Vec<Value> {
        crate::transcript::since(chat, 0)
            .into_iter()
            .map(|r| r.event)
            .filter(|e| e["type"] == EVENT)
            .collect()
    }

    #[test]
    fn one_line_per_write_however_often_it_is_reported() {
        let ledger = scratch_ledger();
        let chat = unique("dup");
        let id = fresh_id();
        let (seen, emit) = capture();
        assert_eq!(
            record_at(&ledger, activity(&chat, &id, Status::Saved), &emit).shown,
            vec![chat.clone()]
        );
        // A retried call, a repeated MCP delivery, a restarted server: the
        // ledger is on disk, so each is a no-op.
        assert_eq!(
            record_at(&ledger, activity(&chat, &id, Status::Saved), &emit),
            Recorded::default()
        );
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert_eq!(lines(&chat).len(), 1);
        assert_eq!(lines(&chat)[0]["text"], "A decision and why.");
    }

    #[test]
    fn a_saved_line_is_never_undone_and_uncertain_moves_only_on_its_own_receipt() {
        let ledger = scratch_ledger();
        let chat = unique("fwd");
        let (seen, emit) = capture();
        let saved = fresh_id();
        record_at(&ledger, activity(&chat, &saved, Status::Saved), &emit);
        // A later failure or doubt under the same id changes nothing.
        record_at(&ledger, activity(&chat, &saved, Status::Failed), &emit);
        record_at(&ledger, activity(&chat, &saved, Status::Uncertain), &emit);

        let doubtful = fresh_id();
        record_at(
            &ledger,
            activity(&chat, &doubtful, Status::Uncertain),
            &emit,
        );
        // "Saved" for a DIFFERENT receipt is not evidence about this one.
        let mut other = activity(&chat, &doubtful, Status::Saved);
        other.receipt_id = Some(fresh_id());
        record_at(&ledger, other, &emit);
        record_at(&ledger, activity(&chat, &doubtful, Status::Saved), &emit);

        let statuses: Vec<_> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|(_, e)| {
                (
                    e["id"].as_str().unwrap() == saved,
                    e["status"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        assert_eq!(
            statuses,
            [
                (true, "saved".to_owned()),
                (false, "uncertain".to_owned()),
                (false, "saved".to_owned()),
            ]
        );
    }

    #[test]
    fn a_coordinator_hears_that_a_worker_saved_but_not_what() {
        let ledger = scratch_ledger();
        let worker = unique("orch-worker");
        let coordinator = unique("coord");
        let owner = Owner {
            coordinator_chat_key: coordinator.clone(),
            task_id: "task_1".into(),
            task_title: "Fix it".into(),
            run_id: "run_1".into(),
        };
        let (_, emit) = capture();
        // A failure stays in the worker chat.
        let mut failed = activity(&worker, &fresh_id(), Status::Failed);
        failed.owner = Some(owner.clone());
        assert_eq!(
            record_at(&ledger, failed, &emit).shown,
            vec![worker.clone()]
        );
        let mut saved = activity(&worker, &fresh_id(), Status::Saved);
        saved.owner = Some(owner.clone());
        assert_eq!(
            record_at(&ledger, saved.clone(), &emit).shown,
            vec![worker.clone(), coordinator.clone()]
        );
        // Deduplicated per destination.
        assert!(record_at(&ledger, saved.clone(), &emit).shown.is_empty());
        let noted = lines(&coordinator);
        assert_eq!(noted.len(), 1);
        assert_eq!(noted[0]["source"]["chatKey"], worker.as_str());
        assert_eq!(noted[0]["source"]["taskTitle"], "Fix it");
        assert_eq!(noted[0]["agent"]["name"], "Mango Juice");
        assert!(noted[0].get("text").is_none() && noted[0].get("note").is_none());
        assert!(!noted[0].to_string().contains("A decision and why."));

        // The coordinator is re-checked at delivery: a line not yet delivered
        // does not go to a coordinator the worker no longer belongs to.
        let id = fresh_id();
        let mut doubtful = activity(&worker, &id, Status::Uncertain);
        doubtful.owner = Some(owner.clone());
        assert_eq!(
            record_at(&ledger, doubtful, &emit).shown,
            vec![worker.clone()]
        );
        let settled = activity(&worker, &id, Status::Saved);
        assert_eq!(
            record_at(&ledger, settled, &emit).shown,
            vec![worker.clone()]
        );
        assert_eq!(lines(&coordinator).len(), 1);
    }

    #[test]
    fn a_line_written_before_a_crash_is_confirmed_not_repeated() {
        let ledger = scratch_ledger();
        let chat = unique("crash");
        let id = fresh_id();
        let line = activity(&chat, &id, Status::Saved);
        // The process wrote the intent and the transcript line, then died
        // before confirming it.
        {
            let mut book = load(&ledger);
            let entry = book.entries.entry(id.clone()).or_default();
            entry.activity = Some(line.clone());
            entry.pending.insert(chat.clone(), Status::Saved);
            save(&ledger, &book).unwrap();
        }
        crate::transcript::append(&chat, &origin_event(&line));
        let (seen, emit) = capture();
        assert_eq!(record_at(&ledger, line.clone(), &emit), Recorded::default());
        assert!(seen.lock().unwrap().is_empty());
        assert_eq!(lines(&chat).len(), 1);
        assert!(load(&ledger).entries[&id].pending.is_empty());
        // And it stays confirmed.
        assert_eq!(record_at(&ledger, line, &emit), Recorded::default());
    }

    #[test]
    fn a_line_the_transcript_refused_is_written_by_the_next_report_once() {
        let ledger = scratch_ledger();
        let chat = unique("refused-disk");
        let line = activity(&chat, &fresh_id(), Status::Saved);
        // The disk refused the line: it reached only the live stream, and
        // the answer says so rather than calling it shown.
        let dropped = |_: &str, _: Value| None;
        let first = record_at(&ledger, line.clone(), dropped);
        assert!(first.shown.is_empty());
        assert_eq!(first.pending, vec![chat.clone()]);
        assert!(first.problem().unwrap().contains("could not be synced"));
        assert!(lines(&chat).is_empty());
        let (_, emit) = capture();
        assert_eq!(
            record_at(&ledger, line.clone(), &emit).shown,
            vec![chat.clone()]
        );
        assert_eq!(record_at(&ledger, line, &emit), Recorded::default());
        assert_eq!(lines(&chat).len(), 1);
    }

    #[test]
    fn different_chats_with_the_same_request_id_are_different_lines() {
        let ledger = scratch_ledger();
        let a = unique("a");
        let b = unique("b");
        let (seen, emit) = capture();
        record_at(&ledger, activity(&a, &fresh_id(), Status::Saved), &emit);
        record_at(&ledger, activity(&b, &fresh_id(), Status::Saved), &emit);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].0, a);
        assert_eq!(seen[1].0, b);
        assert_ne!(seen[0].1["id"], seen[1].1["id"]);
    }

    #[test]
    fn a_saved_receipt_check_settles_an_uncertain_line_of_the_same_chat_only() {
        let store = OrchestrationStore::load(
            std::env::temp_dir().join(format!("octiq-memact-{}.json", uuid::Uuid::new_v4())),
        );
        let ledger = scratch_ledger();
        let checked =
            |chat: &str, receipt: &Value| receipt_checked_at(&ledger, &store, chat, receipt);
        let chat = unique("unc");
        let other = unique("other");
        let id = fresh_id();
        record_at(&ledger, activity(&chat, &id, Status::Uncertain), deliver);
        let receipt = json!({"id": id, "status": "saved"});
        // Another chat cannot settle it, and a still-uncertain answer does not.
        assert_eq!(checked(&other, &receipt), Recorded::default());
        assert_eq!(
            checked(&chat, &json!({"id": id, "status": "needs_review"})),
            Recorded::default()
        );
        assert_eq!(checked(&chat, &receipt).shown, vec![chat.clone()]);
        assert_eq!(checked(&chat, &receipt), Recorded::default());
        let shown = lines(&chat);
        assert_eq!(shown.len(), 2);
        assert_eq!(shown[1]["status"], "saved");
        assert_eq!(shown[1]["id"], shown[0]["id"]);
        assert_eq!(shown[1]["text"], "A decision and why.");
        assert!(shown[1]["error"].is_null());
    }

    /// A disposable vault, team and orchestration ledger — nothing here
    /// touches the person's own profile or memory.
    struct World {
        base: PathBuf,
        root: PathBuf,
        vault: crate::memory_vault::Vault,
        team: PathBuf,
        store: OrchestrationStore,
        /// This world's own activity ledger, so nothing another test does
        /// to its ledger (filling it past KEEP, say) can reach this one.
        ledger: PathBuf,
        /// The instant and zone calls are made at; the real clock if unset.
        clock: Mutex<Option<LocalNow>>,
    }

    impl World {
        fn new(writable: bool) -> Self {
            let base = std::env::temp_dir()
                .join(format!("octiq-memory-activity-{}", uuid::Uuid::new_v4()));
            let root = base.join("vault");
            fs::create_dir_all(&root).unwrap();
            let vault = crate::memory_vault::Vault::at(base.join("profile"));
            vault
                .configure(crate::memory_vault::Config {
                    path: root.to_string_lossy().into_owned(),
                    writable,
                })
                .unwrap();
            let store = OrchestrationStore::load(base.join("orchestrations.json"));
            Self {
                team: base.join("team.json"),
                ledger: base.join("memory-activity.json"),
                base,
                root,
                vault,
                store,
                clock: Mutex::new(None),
            }
        }

        /// Stand at `ms` in a zone `offset_secs` from UTC.
        fn at(&self, ms: i64, offset_secs: i32) {
            *self.clock.lock().unwrap() = Some(LocalNow { ms, offset_secs });
        }

        /// A restart: whatever the ledger says is owed, checked against this
        /// world's orchestration ledger as it stands.
        fn recover(&self) -> Recorded {
            recover_at(&self.ledger, |c| current_owner(&self.store, c), deliver)
        }

        fn agent(&self, name: &str) -> TeamAgent {
            crate::team::save(
                &self.team,
                crate::team::TeamDraft {
                    id: None,
                    name: name.into(),
                    role: "builds things".into(),
                    agent: crate::agent_chat::ChatAgent::Claude,
                    model: "sonnet".into(),
                    effort: None,
                    access: None,
                    project_id: None,
                    reports_to: None,
                    avatar: None,
                },
            )
            .unwrap()
        }

        /// A direct chat with `agent` as its lead.
        fn lead(&self, agent: &TeamAgent) -> String {
            let chat = unique("lead");
            crate::team::brief(&self.team, &chat, "p1", &agent.id, "Do it", false, &[]).unwrap();
            index(&chat);
            chat
        }

        fn call(&self, chat: &str, op: &str, tool: Value) -> Result<Value, String> {
            self.call_as(&self.store, chat, op, tool)
        }

        fn call_as(
            &self,
            store: &OrchestrationStore,
            chat: &str,
            op: &str,
            tool: Value,
        ) -> Result<Value, String> {
            let now = self.clock.lock().unwrap().unwrap_or_else(LocalNow::system);
            agent_memory_in(
                Some(&self.ledger),
                &self.vault,
                &self.team,
                store,
                chat,
                op,
                &tool,
                now,
            )
        }

        /// The receipt file the vault keeps for `receipt`.
        fn receipt_file(&self, receipt: &Value) -> PathBuf {
            self.base
                .join("profile/memory-vault-receipts")
                .join(format!("{}.json", receipt["id"].as_str().unwrap()))
        }

        /// Rewrite a stored receipt, as time or a crash would have left it.
        fn edit_receipt(&self, receipt: &Value, edit: impl FnOnce(&mut Value)) {
            let file = self.receipt_file(receipt);
            let mut stored: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
            edit(&mut stored);
            fs::write(&file, serde_json::to_vec(&stored).unwrap()).unwrap();
        }

        fn note(&self, agent: &TeamAgent) -> String {
            fs::read_to_string(self.root.join(agent.memory_note.as_ref().unwrap()))
                .unwrap_or_default()
        }

        /// A run coordinated from its own chat, with one task for `agent`
        /// and a worker attempt reserved for it. Returns (coordinator, worker).
        fn worker(&self, agent: &TeamAgent, title: &str) -> (String, String) {
            let coordinator = unique("coordinator");
            let run = self
                .store
                .create_run(
                    coordinator.clone(),
                    "Ship".into(),
                    "ws".into(),
                    "/tmp".into(),
                    Some(2),
                )
                .unwrap();
            let task = self
                .store
                .create_task_for(
                    &coordinator,
                    run.id.clone(),
                    title.into(),
                    "Do it".into(),
                    Vec::new(),
                    None,
                    None,
                    Some(crate::orchestration::TaskAssignee {
                        id: agent.id.clone(),
                        name: agent.name.clone(),
                    }),
                    None,
                )
                .unwrap();
            let (_, _, attempt, _) = self
                .store
                .reserve_attempt(
                    &coordinator,
                    &crate::orchestration::tests::launch_for(&task.id),
                )
                .unwrap();
            index(&coordinator);
            index(&attempt.worker_chat_key);
            (coordinator, attempt.worker_chat_key)
        }
    }

    impl Drop for World {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn entry(text: &str, request: &str) -> Value {
        json!({"text": text, "date": "2026-09-28", "requestId": request})
    }

    fn index(chat: &str) {
        crate::chat_index::upsert(
            serde_json::from_value(json!({
                "id": chat.strip_prefix("chat:").unwrap(), "projectId": "p1",
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn a_saved_append_is_one_attributed_line_and_an_identical_retry_writes_nothing() {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        let saved = w
            .call(&chat, "append", entry("Use the receipt, not prose.", "r1"))
            .unwrap();
        assert_eq!(saved["receipt"]["status"], "saved");
        let shown = lines(&chat);
        assert_eq!(shown.len(), 1);
        let line = &shown[0];
        assert_eq!(line["status"], "saved");
        assert_eq!(line["id"], saved["receipt"]["id"], "keyed by the receipt");
        assert_eq!(line["agent"]["name"], "Mango Juice");
        assert_eq!(line["text"], "Use the receipt, not prose.");
        assert_eq!(line["note"], mango.memory_note.as_deref().unwrap());
        assert_eq!(line["receipt"]["id"], saved["receipt"]["id"]);
        assert_eq!(line["receipt"]["status"], "saved");
        // The vault's own folder is the person's business, not the chat's.
        assert!(!line.to_string().contains(&*w.root.to_string_lossy()));

        // The agent never heard back and asks again, word for word: the host
        // answers from the receipt. At 536ef33 this failed with "requestId was
        // already used for a different operation", because the retry re-read
        // the note's revision, which the first append had moved on.
        let again = w
            .call(&chat, "append", entry("Use the receipt, not prose.", "r1"))
            .unwrap();
        assert_eq!(again["alreadySaved"], true);
        assert_eq!(again["receipt"]["id"], saved["receipt"]["id"]);
        assert_eq!(
            w.note(&mango)
                .matches("Use the receipt, not prose.")
                .count(),
            1
        );
        assert_eq!(lines(&chat).len(), 1);

        // Different words — or a different date — under the same id are
        // refused, change nothing, and never touch the saved line. What they
        // say is that THIS call was refused and the earlier entry is saved:
        // two states, neither of them "not updated".
        for (text, date) in [
            ("Something else.", "2026-09-28"),
            ("Use the receipt, not prose.", "2026-09-29"),
        ] {
            let error = w
                .call(
                    &chat,
                    "append",
                    json!({"text": text, "date": date, "requestId": "r1"}),
                )
                .unwrap_err();
            assert!(
                error.contains("This call was refused and wrote nothing"),
                "{error}"
            );
            assert!(error.contains("earlier entry is saved"), "{error}");
        }
        assert!(!w.note(&mango).contains("Something else."));
        assert_eq!(w.note(&mango).matches("## 2026-09-29").count(), 0);
        let shown = lines(&chat);
        assert_eq!(shown.len(), 3);
        assert_eq!(shown[0]["status"], "saved");
        for refused in &shown[1..] {
            assert_eq!(refused["status"], "refused");
            assert_ne!(refused["id"], shown[0]["id"]);
            assert_eq!(refused["earlier"]["id"], saved["receipt"]["id"]);
            assert_eq!(refused["earlier"]["status"], "saved");
            assert!(refused["receipt"].is_null(), "this call made no receipt");
        }

        // Reading is not writing.
        let before = lines(&chat).len();
        w.call(&chat, "read", json!({})).unwrap();
        assert_eq!(lines(&chat).len(), before);
    }

    #[test]
    fn a_retry_without_a_date_repeats_the_first_calls_date() {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        w.call(&chat, "append", entry("Dated once.", "r1")).unwrap();
        // The retry leaves the date out, as if a day had passed: the host
        // repeats the date the write was made with instead of guessing.
        let again = w
            .call(
                &chat,
                "append",
                json!({"text": "Dated once.", "requestId": "r1"}),
            )
            .unwrap();
        assert_eq!(again["alreadySaved"], true);
        assert_eq!(w.note(&mango).matches("Dated once.").count(), 1);
        assert_eq!(lines(&chat).len(), 1);
    }

    #[test]
    fn concurrent_identical_retries_append_once() {
        let w = std::sync::Arc::new(World::new(true));
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let (w, chat) = (w.clone(), chat.clone());
                std::thread::spawn(move || w.call(&chat, "append", entry("Only once.", "r1")))
            })
            .collect();
        for handle in handles {
            let result = handle.join().unwrap().unwrap();
            assert_eq!(result["receipt"]["status"], "saved");
        }
        assert_eq!(w.note(&mango).matches("Only once.").count(), 1);
        assert_eq!(lines(&chat).len(), 1);
    }

    #[test]
    fn a_save_whose_line_was_never_drawn_is_drawn_by_its_retry() {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        // Saved by a server that died before it could draw the line...
        let first = crate::team::memory_append(
            &w.vault,
            &chat,
            &mango,
            "Crash gap.",
            Some("2026-09-28"),
            "r1",
        );
        let receipt = first.result(&mango).unwrap()["receipt"].clone();
        // ...and before the receipt itself said saved.
        let file = w
            .base
            .join("profile/memory-vault-receipts")
            .join(format!("{}.json", receipt["id"].as_str().unwrap()));
        let mut pending: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        pending["status"] = "pending".into();
        fs::write(&file, serde_json::to_vec(&pending).unwrap()).unwrap();
        assert!(lines(&chat).is_empty());

        let again = w.call(&chat, "append", entry("Crash gap.", "r1")).unwrap();
        assert_eq!(again["alreadySaved"], true);
        assert_eq!(again["receipt"]["status"], "saved");
        assert_eq!(w.note(&mango).matches("Crash gap.").count(), 1);
        let shown = lines(&chat);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0]["status"], "saved");
    }

    #[test]
    fn the_same_request_in_another_vault_is_another_line() {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        let first = w
            .call(&chat, "append", entry("First vault.", "r1"))
            .unwrap();
        let elsewhere = w.base.join("vault-2");
        fs::create_dir_all(&elsewhere).unwrap();
        w.vault
            .configure(crate::memory_vault::Config {
                path: elsewhere.to_string_lossy().into_owned(),
                writable: true,
            })
            .unwrap();
        let second = w
            .call(&chat, "append", entry("First vault.", "r1"))
            .unwrap();
        assert_ne!(first["receipt"]["id"], second["receipt"]["id"]);
        assert!(second.get("alreadySaved").is_none());
        let shown = lines(&chat);
        assert_eq!(shown.len(), 2);
        assert_ne!(shown[0]["id"], shown[1]["id"]);
    }

    #[test]
    fn a_refused_or_failed_append_is_never_drawn_as_saved() {
        let w = World::new(false);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        let error = w.call(&chat, "append", entry("Nope.", "r1")).unwrap_err();
        assert!(error.contains("writes are off"), "{error}");
        let shown = lines(&chat);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0]["status"], "failed");
        assert_eq!(shown[0]["agent"]["name"], "Mango Juice");
        assert!(shown[0]["receipt"].is_null());
        assert_eq!(shown[0]["error"], error.as_str());
        // The same failure reported twice is still one line.
        w.call(&chat, "append", entry("Nope.", "r1")).unwrap_err();
        assert_eq!(lines(&chat).len(), 1);
        // Nothing to remember is refused before the vault: its own line.
        w.call(&chat, "append", entry("   ", "r1")).unwrap_err();
        assert_eq!(lines(&chat).len(), 2);
        assert_eq!(lines(&chat)[1]["status"], "failed");

        // Writes turned on, the same requestId saves — as its own line; the
        // refusal above stays a refusal.
        w.vault
            .configure(crate::memory_vault::Config {
                path: w.root.to_string_lossy().into_owned(),
                writable: true,
            })
            .unwrap();
        w.call(&chat, "append", entry("Nope.", "r1")).unwrap();
        let shown = lines(&chat);
        assert_eq!(shown.len(), 3);
        assert_eq!(shown[0]["status"], "failed");
        assert_eq!(shown[2]["status"], "saved");

        // A chat no registered agent runs has no memory, and no name is made up.
        let stranger = unique("stranger");
        let error = w
            .call(&stranger, "append", entry("Who am I?", "r1"))
            .unwrap_err();
        assert!(error.contains("registered agent"), "{error}");
        let shown = lines(&stranger);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0]["status"], "failed");
        assert!(shown[0]["agent"].is_null());
        // A read that fails draws nothing.
        w.call(&stranger, "read", json!({})).unwrap_err();
        assert_eq!(lines(&stranger).len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_write_that_may_or_may_not_have_landed_is_uncertain_not_saved_or_failed() {
        use std::os::unix::fs::PermissionsExt;
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        // The note exists, then its folder stops taking writes, so the vault's
        // write fails after its receipt was recorded.
        crate::team::ensure_memory(&w.vault, &chat, &mango).unwrap();
        let folder = w
            .root
            .join(mango.memory_note.as_ref().unwrap())
            .parent()
            .unwrap()
            .to_owned();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
        let error = w.call(&chat, "append", entry("Maybe.", "r1")).unwrap_err();
        let again = w.call(&chat, "append", entry("Maybe.", "r1")).unwrap_err();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(error.contains("needs review"), "{error}");
        assert!(again.contains("needs review"), "{again}");
        let shown = lines(&chat);
        assert_eq!(
            shown.len(),
            1,
            "a retry of an uncertain write is the same line"
        );
        assert_eq!(shown[0]["status"], "uncertain");
        assert_eq!(shown[0]["receipt"]["status"], "needs_review");
        assert!(!w.note(&mango).contains("Maybe."));
    }

    #[test]
    fn a_workers_save_is_noted_in_its_coordinator_chat_and_nowhere_else() {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let (coordinator, worker) = w.worker(&mango, "Show memory updates");
        let bystander = unique("bystander");

        // Whatever the tool's arguments claim, the chat is the capability's.
        let mut spoofed = entry("Workers report through the host.", "r1");
        spoofed["chatKey"] = coordinator.clone().into();
        spoofed["agent"] = "Potato Juice".into();
        w.call(&worker, "append", spoofed.clone()).unwrap();
        w.call(&worker, "append", spoofed).unwrap();

        let own = lines(&worker);
        assert_eq!(own.len(), 1);
        assert_eq!(own[0]["agent"]["name"], "Mango Juice");
        assert_eq!(own[0]["text"], "Workers report through the host.");
        let noted = lines(&coordinator);
        assert_eq!(noted.len(), 1);
        assert_eq!(noted[0]["id"], own[0]["id"]);
        assert_eq!(noted[0]["source"]["chatKey"], worker.as_str());
        assert_eq!(noted[0]["source"]["taskTitle"], "Show memory updates");
        assert!(!noted[0]
            .to_string()
            .contains("Workers report through the host."));
        assert!(lines(&bystander).is_empty());

        // A coordinator chat that is gone gets nothing; the worker still does.
        crate::chat_index::remove(coordinator.strip_prefix("chat:").unwrap()).unwrap();
        w.call(&worker, "append", entry("Second.", "r2")).unwrap();
        assert_eq!(lines(&worker).len(), 2);
        assert_eq!(lines(&coordinator).len(), 1);
    }

    const DAY: i64 = 86_400_000;

    /// 2026-09-29T00:00:00Z.
    const MIDNIGHT_UTC: i64 = 1_790_640_000_000;

    /// The zones the date is checked in, with their offset on 2026-09-28/29
    /// (Los Angeles is on daylight time then). `team::tests` checks the same
    /// offsets come out of the OS's own zone database.
    const ZONES: [(&str, i32); 4] = [
        ("UTC", 0),
        ("Asia/Kuala_Lumpur", 8 * 3600),
        ("Pacific/Kiritimati", 14 * 3600),
        ("America/Los_Angeles", -7 * 3600),
    ];

    /// Local midnight at the start of 2026-09-29 in a zone, in UTC ms.
    fn local_midnight(offset_secs: i32) -> i64 {
        MIDNIGHT_UTC - i64::from(offset_secs) * 1000
    }

    fn undated(text: &str, request: &str) -> Value {
        json!({"text": text, "requestId": request})
    }

    /// Saved by a server that died before it recorded any activity: the note
    /// and the receipt are on disk, the ledger and the transcript know nothing.
    fn saved_then_crashed(w: &World, chat: &str, me: &TeamAgent, text: &str, date: &str) -> Value {
        let first = crate::team::memory_append(&w.vault, chat, me, text, Some(date), "r1");
        first.result(me).unwrap()["receipt"].clone()
    }

    #[test]
    fn an_undated_entry_takes_the_local_date_on_either_side_of_local_midnight() {
        for (zone, offset) in ZONES {
            let w = World::new(true);
            let mango = w.agent("Mango Juice");
            let chat = w.lead(&mango);
            let midnight = local_midnight(offset);
            w.at(midnight - 30_000, offset);
            let late = w.call(&chat, "append", undated("Late.", "r1")).unwrap();
            w.at(midnight + 30_000, offset);
            w.call(&chat, "append", undated("Early.", "r2")).unwrap();
            let shown = lines(&chat);
            assert_eq!(shown.len(), 2, "{zone}");
            assert_eq!(shown[0]["date"], "2026-09-28", "{zone}");
            assert_eq!(shown[1]["date"], "2026-09-29", "{zone}");
            // The receipt keeps the date the entry was written under.
            assert_eq!(late["receipt"]["entryDate"], "2026-09-28", "{zone}");
            let note = w.note(&mango);
            assert!(note.contains("## 2026-09-28\n\nLate."), "{zone}: {note}");
            assert!(note.contains("## 2026-09-29\n\nEarly."), "{zone}: {note}");
        }
    }

    // F1 — at 12016c9 a retry across midnight failed with "different
    // operation" and drew a "not updated" line over a saved write. Nothing
    // here passes a date or edits a receipt: the clock is the only input.
    #[test]
    fn an_undated_retry_after_local_midnight_is_the_same_save_in_every_zone() {
        for (zone, offset) in ZONES {
            let w = World::new(true);
            let mango = w.agent("Mango Juice");
            let chat = w.lead(&mango);
            let midnight = local_midnight(offset);
            // Saved just before local midnight with the date left out, by a
            // server that died before it recorded any activity…
            let first = crate::team::memory_append_at(
                &w.vault,
                &chat,
                &mango,
                "Crossed midnight.",
                None,
                "r1",
                LocalNow {
                    ms: midnight - 30_000,
                    offset_secs: offset,
                },
            );
            assert_eq!(first.date.as_deref(), Some("2026-09-28"), "{zone}");
            let receipt = first.result(&mango).unwrap()["receipt"].clone();
            assert!(!w.ledger.exists(), "no activity was ever recorded");

            // …and retried just after it, still without one.
            w.at(midnight + 30_000, offset);
            let again = w
                .call(&chat, "append", undated("Crossed midnight.", "r1"))
                .unwrap();
            assert_eq!(again["alreadySaved"], true, "{zone}");
            assert_eq!(again["receipt"]["id"], receipt["id"], "{zone}");
            let shown = lines(&chat);
            assert_eq!(shown.len(), 1, "{zone}");
            assert_eq!(shown[0]["status"], "saved", "{zone}");
            assert_eq!(
                shown[0]["date"], "2026-09-28",
                "{zone}: the entry's own date"
            );
            let note = w.note(&mango);
            assert_eq!(note.matches("Crossed midnight.").count(), 1, "{zone}");
            assert_eq!(note.matches("## 2026-09-28").count(), 1, "{zone}");
            assert_eq!(note.matches("## 2026-09-29").count(), 0, "{zone}");

            // Restart after restart, with or without the ledger: still one line.
            for forget in [false, true, true] {
                if forget {
                    fs::remove_file(&w.ledger).unwrap();
                }
                w.call(&chat, "append", undated("Crossed midnight.", "r1"))
                    .unwrap();
            }
            assert_eq!(lines(&chat).len(), 1, "{zone}");

            // Other words under the same id: this call is refused, and the
            // line says the earlier entry is saved — never "not updated".
            let error = w
                .call(&chat, "append", undated("Something else.", "r1"))
                .unwrap_err();
            assert!(error.contains("refused and wrote nothing"), "{error}");
            assert!(error.contains("earlier entry is saved"), "{error}");
            assert!(!w.note(&mango).contains("Something else."));
            let shown = lines(&chat);
            assert_eq!(shown.len(), 2, "{zone}");
            assert_eq!(shown[0]["status"], "saved");
            assert_eq!(shown[1]["status"], "refused");
            assert_eq!(shown[1]["earlier"]["id"], receipt["id"]);
            assert_eq!(shown[1]["earlier"]["status"], "saved");
            assert!(shown[1]["date"].is_null(), "no date is guessed for it");
        }
    }

    // F1 — a receipt an earlier build left kept no date. Its entry was dated
    // that build's way (UTC) or the local way, so it may be the receipt's UTC
    // day, the one before or the one after; only the stored request hash says
    // which, and nothing else is ever taken.
    #[test]
    fn a_receipt_that_kept_no_date_is_matched_only_by_its_request_hash() {
        for (zone, offset) in ZONES {
            let midnight = local_midnight(offset);
            let made = midnight - 30_000;
            for date in ["2026-09-28".to_owned(), crate::team::utc_date(made)] {
                let w = World::new(true);
                let mango = w.agent("Mango Juice");
                let chat = w.lead(&mango);
                let receipt = saved_then_crashed(&w, &chat, &mango, "Old build.", &date);
                w.edit_receipt(&receipt, |r| {
                    r.as_object_mut().unwrap().remove("entryDate").unwrap();
                    r["createdAt"] = json!(made);
                });
                w.at(midnight + 30_000, offset);
                let again = w
                    .call(&chat, "append", undated("Old build.", "r1"))
                    .unwrap();
                assert_eq!(again["alreadySaved"], true, "{zone} {date}");
                let shown = lines(&chat);
                assert_eq!(shown.len(), 1, "{zone} {date}");
                assert_eq!(shown[0]["status"], "saved");
                assert_eq!(shown[0]["date"], date.as_str());
                assert_eq!(w.note(&mango).matches("Old build.").count(), 1);
            }

            // A date the receipt cannot prove is not guessed into success, and
            // the saved entry is not called unsaved either.
            let w = World::new(true);
            let mango = w.agent("Mango Juice");
            let chat = w.lead(&mango);
            let receipt = saved_then_crashed(&w, &chat, &mango, "Dated long ago.", "2026-01-02");
            w.edit_receipt(&receipt, |r| {
                r.as_object_mut().unwrap().remove("entryDate").unwrap();
                r["createdAt"] = json!(made);
            });
            w.at(midnight + 30_000, offset);
            let error = w
                .call(&chat, "append", undated("Dated long ago.", "r1"))
                .unwrap_err();
            assert!(error.contains("refused and wrote nothing"), "{error}");
            assert!(error.contains("earlier entry is saved"), "{error}");
            assert!(!error.contains("no date its receipt allows"), "{error}");
            let shown = lines(&chat);
            assert_eq!(shown.len(), 1, "{zone}");
            assert_eq!(shown[0]["status"], "refused");
            assert_ne!(shown[0]["id"], receipt["id"]);
            assert_eq!(shown[0]["earlier"]["id"], receipt["id"]);
            assert_eq!(shown[0]["earlier"]["status"], "saved");
            assert_eq!(w.note(&mango).matches("Dated long ago.").count(), 1);

            // Asked with its real date, the same write is recognised and shown.
            let again = w
                .call(
                    &chat,
                    "append",
                    json!({"text": "Dated long ago.", "date": "2026-01-02", "requestId": "r1"}),
                )
                .unwrap();
            assert_eq!(again["alreadySaved"], true);
            let shown = lines(&chat);
            assert_eq!(shown.len(), 2);
            assert_eq!(shown[1]["status"], "saved");
            assert_eq!(shown[1]["id"], receipt["id"]);
            assert_eq!(shown[0]["status"], "refused", "the refusal stays a refusal");
        }
    }

    /// Key `receipt` under the id the vault's legacy root spelling gave it,
    /// as a Windows vault saved before paths were simplified left it.
    fn move_to_legacy_id(w: &World, chat: &str, receipt: &Value, legacy_root: &Path) -> String {
        let legacy_id = crate::memory_vault::receipt_id_under(chat, legacy_root, "r1");
        assert_ne!(receipt["id"], legacy_id.as_str());
        let file = w.receipt_file(receipt);
        let mut stored: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        stored["id"] = json!(legacy_id);
        fs::write(
            file.with_file_name(format!("{legacy_id}.json")),
            serde_json::to_vec(&stored).unwrap(),
        )
        .unwrap();
        fs::remove_file(file).unwrap();
        legacy_id
    }

    const LEGACY_ROOT: &str = r"\\?\C:\Works\Obsidian\Pandaworks-docspace";

    // After the upgrade that simplified Windows vault paths, a memory entry
    // saved before it is found under its old receipt id by the retry check as
    // well as by the write, so an undated retry is the same save — not a new
    // entry and not a "different operation" refusal.
    #[test]
    fn an_undated_retry_finds_a_save_kept_under_the_legacy_root_id() {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        let receipt = saved_then_crashed(&w, &chat, &mango, "Before the upgrade.", "2026-09-28");
        assert_eq!(receipt["entryDate"], "2026-09-28");
        let legacy_id = move_to_legacy_id(&w, &chat, &receipt, Path::new(LEGACY_ROOT));

        w.at(MIDNIGHT_UTC + 86_400_000, 0);
        let again = crate::memory_vault::with_legacy_root(Path::new(LEGACY_ROOT), || {
            w.call(&chat, "append", undated("Before the upgrade.", "r1"))
        })
        .unwrap();
        assert_eq!(again["alreadySaved"], true);
        assert_eq!(again["receipt"]["id"], legacy_id.as_str());
        assert_eq!(again["receipt"]["entryDate"], "2026-09-28");
        let note = w.note(&mango);
        assert_eq!(note.matches("Before the upgrade.").count(), 1, "{note}");
        assert_eq!(note.matches("## 2026-09-28").count(), 1, "{note}");
        let shown = lines(&chat);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0]["status"], "saved");
        assert_eq!(shown[0]["id"], legacy_id.as_str());
        assert_eq!(shown[0]["date"], "2026-09-28", "the stored entry date");
    }

    // A receipt from before both changes — no entry date, and keyed under the
    // legacy root id — is still recognised only by its request hash.
    #[test]
    fn a_legacy_receipt_that_kept_no_date_is_matched_only_by_its_request_hash() {
        let made = MIDNIGHT_UTC - 30_000;
        for (date, same) in [
            (crate::team::utc_date(made), true),
            ("2026-01-02".to_owned(), false),
        ] {
            let w = World::new(true);
            let mango = w.agent("Mango Juice");
            let chat = w.lead(&mango);
            let receipt = saved_then_crashed(&w, &chat, &mango, "Old build.", &date);
            w.edit_receipt(&receipt, |r| {
                r.as_object_mut().unwrap().remove("entryDate").unwrap();
                r["createdAt"] = json!(made);
            });
            let legacy_id = move_to_legacy_id(&w, &chat, &receipt, Path::new(LEGACY_ROOT));
            w.at(MIDNIGHT_UTC + 30_000, 0);
            let result = crate::memory_vault::with_legacy_root(Path::new(LEGACY_ROOT), || {
                w.call(&chat, "append", undated("Old build.", "r1"))
            });
            let shown = lines(&chat);
            assert_eq!(shown.len(), 1, "{date}");
            assert_eq!(w.note(&mango).matches("Old build.").count(), 1, "{date}");
            if same {
                let again = result.unwrap();
                assert_eq!(again["alreadySaved"], true, "{date}");
                assert_eq!(again["receipt"]["id"], legacy_id.as_str());
                assert_eq!(shown[0]["status"], "saved");
                assert_eq!(shown[0]["id"], legacy_id.as_str());
                assert_eq!(shown[0]["date"], date.as_str());
            } else {
                // Not guessed into success, and the saved entry is not called
                // unsaved: this call is refused, the earlier entry stands.
                let error = result.unwrap_err();
                assert!(error.contains("refused and wrote nothing"), "{error}");
                assert!(error.contains("earlier entry is saved"), "{error}");
                assert_eq!(shown[0]["status"], "refused");
                assert_eq!(shown[0]["earlier"]["id"], legacy_id.as_str());
                assert_eq!(shown[0]["earlier"]["status"], "saved");
            }
        }
    }

    // Startup restore — a line the ledger confirmed that its transcript has
    // since lost (truncated, deleted, restored from an older backup) is
    // written back at the next start, once, in the worker chat and in the
    // coordinator chat, with no retry from the agent.
    #[test]
    fn a_restart_writes_back_each_confirmed_line_a_transcript_lost_and_nothing_twice() {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let (coordinator, worker) = w.worker(&mango, "Restore lines");
        let saved = w.call(&worker, "append", entry("Keep me.", "r1")).unwrap();
        let id = saved["receipt"]["id"].as_str().unwrap().to_owned();
        // Both lines are there: a restart writes nothing.
        assert_eq!(w.recover(), Recorded::default());
        assert_eq!(lines(&worker).len(), 1);
        assert_eq!(lines(&coordinator).len(), 1);

        // The worker's transcript is truncated and the coordinator's deleted.
        fs::write(crate::transcript::path_for(&worker).unwrap(), "").unwrap();
        fs::remove_file(crate::transcript::path_for(&coordinator).unwrap()).unwrap();
        crate::transcript::forget_count(&worker);
        crate::transcript::forget_count(&coordinator);
        let mut restored = w.recover().shown;
        restored.sort();
        let mut both = vec![worker.clone(), coordinator.clone()];
        both.sort();
        assert_eq!(restored, both);
        let own = lines(&worker);
        assert_eq!(own.len(), 1);
        assert_eq!(own[0]["id"], id.as_str());
        assert_eq!(own[0]["text"], "Keep me.");
        let noted = lines(&coordinator);
        assert_eq!(noted.len(), 1);
        assert_eq!(noted[0]["source"]["chatKey"], worker.as_str());
        assert!(noted[0].get("text").is_none());

        // Present again: another restart, and the agent's retry, add nothing.
        assert_eq!(w.recover(), Recorded::default());
        w.call(&worker, "append", entry("Keep me.", "r1")).unwrap();
        assert_eq!(lines(&worker).len(), 1);
        assert_eq!(lines(&coordinator).len(), 1);
        let record = &load(&w.ledger).entries[&id];
        assert!(record.pending.is_empty());
        assert_eq!(record.delivered.get(&worker), Some(&Status::Saved));
        assert_eq!(record.delivered.get(&coordinator), Some(&Status::Saved));
    }

    fn task_of(w: &World) -> crate::orchestration::Task {
        w.store.snapshot(None).unwrap().tasks.remove(0)
    }

    // The coordinator is read again after the vault has saved. In this host
    // a run's coordinator chat never changes (Run.coordinator_chat_key is set
    // at create_run and nothing writes it) and a task cannot change hands
    // while its worker runs (reassign_task refuses a Preparing or Running
    // attempt), so the case that happens is a coordinator chat deleted
    // mid-save. The re-pointed run is forced through a test-only setter.
    #[test]
    fn a_chat_that_stops_being_the_coordinator_during_the_save_is_told_nothing() {
        let w = std::sync::Arc::new(World::new(true));
        let mango = w.agent("Mango Juice");
        let potato = w.agent("Potato Juice");
        let (coordinator, worker) = w.worker(&mango, "Moves");
        let task = task_of(&w);

        // A handoff tried during the save is refused, so the coordinator is
        // still this worker's and is told.
        let handoff: std::sync::Arc<Mutex<Option<Result<(), String>>>> = Default::default();
        {
            let (w, coordinator, task, handoff) = (
                w.clone(),
                coordinator.clone(),
                task.id.clone(),
                handoff.clone(),
            );
            let to = crate::orchestration::TaskAssignee {
                id: potato.id.clone(),
                name: potato.name.clone(),
            };
            faults::after_save(move || {
                let result = w.store.reassign_task(
                    &coordinator,
                    &task,
                    (None, Some(to), None),
                    "Hand on.".into(),
                );
                *handoff.lock().unwrap() = Some(result.map(|_| ()));
            });
        }
        w.call(&worker, "append", entry("Handoff tried.", "r1"))
            .unwrap();
        let tried = handoff.lock().unwrap().take().expect("the hook ran");
        assert!(tried.unwrap_err().contains("still working"));
        assert_eq!(task_of(&w).assignee.unwrap().id, mango.id);
        assert_eq!(lines(&coordinator).len(), 1);

        // The run is re-pointed while the vault writes: the old coordinator
        // hears nothing, the one it points at now does.
        let next = unique("next-coordinator");
        index(&next);
        {
            let (w, run, next) = (w.clone(), task.run_id.clone(), next.clone());
            faults::after_save(move || w.store.test_set_coordinator(&run, &next).unwrap());
        }
        w.call(&worker, "append", entry("Re-pointed.", "r2"))
            .unwrap();
        assert_eq!(
            lines(&coordinator).len(),
            1,
            "the old coordinator is not told"
        );
        assert_eq!(lines(&next).len(), 1);
        assert_eq!(lines(&worker).len(), 2);

        // The coordinator chat is deleted while the vault writes.
        {
            let next = next.clone();
            faults::after_save(move || {
                crate::chat_index::remove(next.strip_prefix("chat:").unwrap()).unwrap();
            });
        }
        w.call(&worker, "append", entry("Deleted.", "r3")).unwrap();
        assert_eq!(lines(&next).len(), 1);
        assert_eq!(lines(&worker).len(), 3);
    }

    // The same link is checked before a restart delivers or writes back a
    // coordinator's line: owed to a chat that is no longer the coordinator,
    // the intent is dropped and nothing is delivered.
    #[test]
    fn a_restart_gives_a_coordinator_its_line_only_while_it_still_is_one() {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let (coordinator, worker) = w.worker(&mango, "Owed lines");
        let run = task_of(&w).run_id;
        // Died right after the intents were stored: no line drawn anywhere.
        faults::crash_after(Some(1));
        let saved = w.call(&worker, "append", entry("Owed.", "r1")).unwrap();
        faults::crash_after(None);
        let id = saved["receipt"]["id"].as_str().unwrap().to_owned();
        let record = &load(&w.ledger).entries[&id];
        assert_eq!(record.pending.len(), 2);
        assert!(lines(&worker).is_empty() && lines(&coordinator).is_empty());

        let elsewhere = unique("elsewhere");
        index(&elsewhere);
        w.store.test_set_coordinator(&run, &elsewhere).unwrap();
        assert_eq!(w.recover().shown, vec![worker.clone()]);
        assert!(lines(&coordinator).is_empty());
        assert!(lines(&elsewhere).is_empty());
        let record = &load(&w.ledger).entries[&id];
        assert!(record.pending.is_empty(), "the stale intent is dropped");
        assert!(!record.delivered.contains_key(&coordinator));

        // A delivered line lost from a chat that has since stopped being the
        // coordinator is not written back, and not asked about again.
        w.store.test_set_coordinator(&run, &coordinator).unwrap();
        let second = w
            .call(&worker, "append", entry("Delivered.", "r2"))
            .unwrap();
        let second = second["receipt"]["id"].as_str().unwrap().to_owned();
        assert_eq!(lines(&coordinator).len(), 1);
        fs::write(crate::transcript::path_for(&coordinator).unwrap(), "").unwrap();
        crate::transcript::forget_count(&coordinator);
        w.store.test_set_coordinator(&run, &elsewhere).unwrap();
        assert_eq!(w.recover(), Recorded::default());
        assert!(lines(&coordinator).is_empty());
        assert!(!load(&w.ledger).entries[&second]
            .delivered
            .contains_key(&coordinator));
        assert_eq!(lines(&worker).len(), 2);
    }

    // Fault injection: the process dies after each durable step in turn —
    // the intents stored, the worker's line written, its confirmation stored,
    // the coordinator's line written, the final ledger stored — and restarts.
    // Every time, each chat ends with exactly one line and nothing owed.
    #[test]
    fn a_crash_after_any_step_is_finished_by_the_restart_exactly_once() {
        let steps = {
            let w = World::new(true);
            let mango = w.agent("Mango Juice");
            let (_, worker) = w.worker(&mango, "Count steps");
            faults::crash_after(None);
            w.call(&worker, "append", entry("Counted.", "r1")).unwrap();
            faults::steps()
        };
        assert_eq!(steps, 5, "intents, line, confirmation, line, confirmation");
        for n in 1..=steps {
            let w = World::new(true);
            let mango = w.agent("Mango Juice");
            let (coordinator, worker) = w.worker(&mango, "Crash");
            faults::crash_after(Some(n));
            let saved = w.call(&worker, "append", entry("Crashed.", "r1")).unwrap();
            faults::crash_after(None);
            assert_eq!(saved["receipt"]["status"], "saved", "step {n}");
            let id = saved["receipt"]["id"].as_str().unwrap().to_owned();

            // Restart: the transcripts are counted afresh, the ledger reread.
            crate::transcript::forget_count(&worker);
            crate::transcript::forget_count(&coordinator);
            w.recover();
            assert_eq!(lines(&worker).len(), 1, "step {n}");
            assert_eq!(lines(&coordinator).len(), 1, "step {n}");
            let record = &load(&w.ledger).entries[&id];
            assert!(record.pending.is_empty(), "step {n}");
            assert_eq!(
                record.delivered.get(&worker),
                Some(&Status::Saved),
                "step {n}"
            );
            assert_eq!(
                record.delivered.get(&coordinator),
                Some(&Status::Saved),
                "step {n}"
            );
            // Another restart and the agent's retry change nothing.
            assert_eq!(w.recover(), Recorded::default(), "step {n}");
            w.call(&worker, "append", entry("Crashed.", "r1")).unwrap();
            assert_eq!(lines(&worker).len(), 1, "step {n}");
            assert_eq!(lines(&coordinator).len(), 1, "step {n}");
        }
    }

    // Storage failures are said in the answer and never confirmed.
    #[test]
    fn a_ledger_the_disk_refuses_is_said_and_nothing_is_confirmed_on_it() {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);

        // The intent cannot be stored: no line is drawn without one.
        faults::saves(&[false]);
        let saved = w.call(&chat, "append", entry("No intent.", "r1")).unwrap();
        faults::saves(&[]);
        assert_eq!(saved["receipt"]["status"], "saved");
        let said = saved["chatLine"].as_str().unwrap();
        assert!(said.contains("could not store the intent"), "{said}");
        assert!(lines(&chat).is_empty());
        // The retry finishes it.
        let again = w.call(&chat, "append", entry("No intent.", "r1")).unwrap();
        assert!(again.get("chatLine").is_none(), "{again}");
        assert_eq!(lines(&chat).len(), 1);

        // The line is written but its confirmation cannot be stored: the line
        // stands, the answer says so, and the ledger still says owed.
        faults::saves(&[true, false, false]);
        let saved = w
            .call(&chat, "append", entry("No confirmation.", "r2"))
            .unwrap();
        faults::saves(&[]);
        let said = saved["chatLine"].as_str().unwrap();
        assert!(
            said.contains("could not store that the line was shown"),
            "{said}"
        );
        let id = saved["receipt"]["id"].as_str().unwrap().to_owned();
        let record = &load(&w.ledger).entries[&id];
        assert_eq!(record.pending.get(&chat), Some(&Status::Saved));
        assert!(record.delivered.is_empty());
        assert_eq!(lines(&chat).len(), 2);
        // A restart confirms it without a second line.
        assert_eq!(w.recover(), Recorded::default());
        assert_eq!(
            load(&w.ledger).entries[&id].delivered.get(&chat),
            Some(&Status::Saved)
        );
        assert_eq!(lines(&chat).len(), 2);

        // The ledger's folder cannot be synced: that is a failed save too.
        crate::transcript::FAIL_DIR_SYNC.with(|f| f.set(true));
        let saved = w.call(&chat, "append", entry("No folder.", "r3")).unwrap();
        crate::transcript::FAIL_DIR_SYNC.with(|f| f.set(false));
        let said = saved["chatLine"].as_str().unwrap();
        assert!(said.contains("the ledger's folder"), "{said}");
        assert_eq!(lines(&chat).len(), 2);

        // A failure on a call that failed anyway is said after its error.
        let w = World::new(false);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        faults::saves(&[false]);
        let error = w.call(&chat, "append", entry("Off.", "r1")).unwrap_err();
        faults::saves(&[]);
        assert!(error.contains("writes are off"), "{error}");
        assert!(error.contains("could not store the intent"), "{error}");
    }

    // A new transcript whose folder cannot be synced holds the line but is
    // not proven: the line is owed, not confirmed — and the next look finds
    // it and only confirms it. (On Windows the folder sync is skipped, see
    // transcript::sync_dir_on, so it never fails there in the first place.)
    #[test]
    fn a_line_in_a_new_file_that_could_not_be_proven_is_confirmed_by_the_next_look() {
        let ledger = scratch_ledger();
        let chat = unique("new-file");
        index(&chat);
        let line = activity(&chat, &fresh_id(), Status::Saved);
        let unproven = |c: &str, e: Value| {
            crate::transcript::FAIL_DIR_SYNC.with(|f| f.set(true));
            let seq = crate::transcript::append_synced(c, &e);
            crate::transcript::FAIL_DIR_SYNC.with(|f| f.set(false));
            seq
        };
        let first = record_at(&ledger, line.clone(), unproven);
        assert!(first.shown.is_empty());
        assert_eq!(first.pending, vec![chat.clone()]);
        assert_eq!(lines(&chat).len(), 1, "the line is on disk all the same");
        assert_eq!(
            load(&ledger).entries[&line.id].pending.get(&chat),
            Some(&Status::Saved)
        );
        assert_eq!(
            recover_at(&ledger, |_| Ok(None), deliver),
            Recorded::default()
        );
        let record = &load(&ledger).entries[&line.id];
        assert!(record.pending.is_empty());
        assert_eq!(record.delivered.get(&chat), Some(&Status::Saved));
        assert_eq!(lines(&chat).len(), 1);
    }

    /// Not a check — the numbers the review asked for. Runs only with
    /// OCTIQ_MEASURE=1, alone: a transcript of 20 MB or more, one record
    /// against it, then four at once, and a restart's pass over it.
    #[test]
    fn measure_records_against_a_20_mb_transcript() {
        if std::env::var("OCTIQ_MEASURE").is_err() {
            return;
        }
        use std::time::Instant;
        let ledger = scratch_ledger();
        let chat = unique("big");
        index(&chat);
        let path = crate::transcript::path_for(&chat).unwrap();
        {
            let delta =
                json!({"type": "stream_event", "event": {"delta": {"text": "x".repeat(960)}}});
            let line = serde_json::to_string(&delta).unwrap();
            let mut file = std::io::BufWriter::new(fs::File::create(&path).unwrap());
            while file.get_ref().metadata().unwrap().len() < 21 * 1024 * 1024 {
                for _ in 0..1024 {
                    writeln!(file, "{line}").unwrap();
                }
                file.flush().unwrap();
            }
        }
        crate::transcript::forget_count(&chat);
        let size = fs::metadata(&path).unwrap().len();
        let synced = |c: &str, e: Value| crate::transcript::append_synced(c, &e);
        faults::HOLDS.lock().unwrap().clear();
        let started = Instant::now();
        record_at(&ledger, activity(&chat, &fresh_id(), Status::Saved), synced);
        let one = started.elapsed();
        let started = Instant::now();
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (ledger, chat) = (ledger.clone(), chat.clone());
                std::thread::spawn(move || {
                    let t = Instant::now();
                    record_at(
                        &ledger,
                        activity(&chat, &fresh_id(), Status::Saved),
                        |c, e| crate::transcript::append_synced(c, &e),
                    );
                    t.elapsed()
                })
            })
            .collect();
        let each: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let four = started.elapsed();
        let holds = faults::HOLDS.lock().unwrap().clone();
        let started = Instant::now();
        let restart = recover_at(&ledger, |_| Ok(None), deliver);
        let recover = started.elapsed();
        assert_eq!(restart, Recorded::default());
        assert_eq!(lines(&chat).len(), 5);
        println!(
            "MEASURE transcript={size} bytes; one record={one:?}; four concurrent: wall={four:?} each={each:?}; lock holds={holds:?}; restart pass={recover:?}"
        );
        crate::transcript::forget(&chat);
    }

    /// Fill the ledger past `KEEP` with writes newer than everything a test
    /// made, so the next record forgets the test's own.
    fn crowd(ledger: &Path) {
        let mut book = load(ledger);
        let base = now_ms() + DAY as u64;
        for i in 0..KEEP {
            let mut other = activity("chat:crowd", &fresh_id(), Status::Saved);
            other.at = base + i as u64;
            book.entries.insert(
                other.id.clone(),
                Entry {
                    activity: Some(other),
                    ..Default::default()
                },
            );
        }
        save(ledger, &book).unwrap();
    }

    // F2 — at 12016c9 a write the ledger had forgotten drew a second line.
    #[test]
    fn a_write_the_ledger_forgot_past_keep_is_still_one_line() {
        let w = std::sync::Arc::new(World::new(true));
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        let first = w.call(&chat, "append", entry("Old write.", "r1")).unwrap();
        let old = first["receipt"]["id"].as_str().unwrap().to_owned();
        // An old uncertain write and an unconfirmed intent must survive the trim.
        let mut doubtful = activity("chat:crowd", &fresh_id(), Status::Uncertain);
        doubtful.at = 0;
        let mut unfinished = activity("chat:crowd", &fresh_id(), Status::Saved);
        unfinished.at = 0;
        {
            let mut book = load(&w.ledger);
            for (a, pending) in [(&doubtful, false), (&unfinished, true)] {
                let entry = book.entries.entry(a.id.clone()).or_default();
                entry.activity = Some(a.clone());
                if pending {
                    entry.pending.insert("chat:crowd".into(), Status::Saved);
                }
            }
            save(&w.ledger, &book).unwrap();
        }
        crowd(&w.ledger);
        // The next write trims the ledger back to KEEP, oldest first.
        w.call(&chat, "append", entry("Newer write.", "r2"))
            .unwrap();
        let book = load(&w.ledger);
        assert_eq!(book.entries.len(), KEEP);
        assert!(
            !book.entries.contains_key(&old),
            "the first write was forgotten"
        );
        assert!(book.entries.contains_key(&doubtful.id));
        assert!(book.entries.contains_key(&unfinished.id));
        assert_eq!(lines(&chat).len(), 2);

        // Retried, alone and all at once: still one line per write.
        w.call(&chat, "append", entry("Old write.", "r1")).unwrap();
        let handles: Vec<_> = (0..6)
            .map(|i| {
                let (w, chat) = (w.clone(), chat.clone());
                std::thread::spawn(move || {
                    let (text, id) = [("Old write.", "r1"), ("Newer write.", "r2")][i % 2];
                    w.call(&chat, "append", entry(text, id))
                })
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().unwrap().unwrap()["alreadySaved"], true);
        }
        let shown = lines(&chat);
        assert_eq!(shown.len(), 2);
        assert_eq!(shown[0]["id"], old.as_str());
        assert_eq!(w.note(&mango).matches("Old write.").count(), 1);
    }

    // F3 — at 12016c9 a line the ledger called delivered was never written
    // back once the transcript had lost it.
    #[test]
    fn a_line_confirmed_but_lost_from_the_transcript_is_written_back_once() {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        let saved = w.call(&chat, "append", entry("Lost line.", "r1")).unwrap();
        let id = saved["receipt"]["id"].as_str().unwrap().to_owned();
        assert_eq!(
            load(&w.ledger).entries[&id].delivered.get(&chat),
            Some(&Status::Saved)
        );
        // Written but never synced when the power went: the platter lost the
        // line the ledger had already confirmed. (A restore from backup looks
        // the same.)
        fs::write(crate::transcript::path_for(&chat).unwrap(), "").unwrap();
        for _ in 0..3 {
            w.call(&chat, "append", entry("Lost line.", "r1")).unwrap();
        }
        let shown = lines(&chat);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0]["id"], id.as_str());
        assert_eq!(shown[0]["status"], "saved");
    }

    // F3 — the order on disk: the intent before the line, the confirmation
    // only after the line is synced; a line the disk refused stays an intent.
    #[test]
    fn the_intent_precedes_the_line_and_the_confirmation_follows_it() {
        let ledger = scratch_ledger();
        let chat = unique("order");
        let line = activity(&chat, &fresh_id(), Status::Saved);
        let during = Mutex::new(None);
        let written = record_at(&ledger, line.clone(), |c: &str, event: Value| {
            let entry = &load(&ledger).entries[&line.id];
            *during.lock().unwrap() = Some((
                entry.pending.get(c).copied(),
                entry.delivered.get(c).copied(),
            ));
            deliver(c, event)
        });
        assert_eq!(written.shown, vec![chat.clone()]);
        assert_eq!(
            during.into_inner().unwrap(),
            Some((Some(Status::Saved), None)),
            "the intent was on disk, the confirmation not yet"
        );
        let entry = &load(&ledger).entries[&line.id];
        assert!(entry.pending.is_empty());
        assert_eq!(entry.delivered.get(&chat), Some(&Status::Saved));

        let refused = activity(&chat, &fresh_id(), Status::Saved);
        record_at(&ledger, refused.clone(), |_: &str, _: Value| None);
        let entry = &load(&ledger).entries[&refused.id];
        assert_eq!(entry.pending.get(&chat), Some(&Status::Saved));
        assert!(entry.delivered.is_empty());
    }

    // F3 — the real save succeeded and its line did not: a restart finishes
    // it without waiting for a retry, and never writes it twice.
    #[test]
    fn a_restart_finishes_every_line_a_crash_left_unconfirmed() {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let (coordinator, worker) = w.worker(&mango, "Recover lines");
        let blocked = crate::transcript::path_for(&worker).unwrap();
        // The worker's transcript cannot be written (a directory stands where
        // the file goes): the save is real, its line is not.
        fs::create_dir_all(blocked.join("in-the-way")).unwrap();
        let saved = w
            .call(&worker, "append", entry("Saved, line lost.", "r1"))
            .unwrap();
        assert_eq!(saved["receipt"]["status"], "saved");
        let id = saved["receipt"]["id"].as_str().unwrap().to_owned();
        let recorded = &load(&w.ledger).entries[&id];
        assert_eq!(recorded.pending.get(&worker), Some(&Status::Saved));
        assert_eq!(recorded.delivered.get(&coordinator), Some(&Status::Saved));
        fs::remove_dir_all(&blocked).unwrap();

        // A chat deleted meanwhile is not written to.
        let gone = unique("gone");
        let mut orphan = activity(&gone, &fresh_id(), Status::Saved);
        orphan.at = 1;
        {
            let mut book = load(&w.ledger);
            let entry = book.entries.entry(orphan.id.clone()).or_default();
            entry.activity = Some(orphan.clone());
            entry.pending.insert(gone.clone(), Status::Saved);
            save(&w.ledger, &book).unwrap();
        }

        assert_eq!(w.recover().shown, vec![worker.clone()]);
        assert_eq!(w.recover(), Recorded::default(), "twice is once");
        let own = lines(&worker);
        assert_eq!(own.len(), 1);
        assert_eq!(own[0]["text"], "Saved, line lost.");
        assert_eq!(lines(&coordinator).len(), 1);
        assert!(lines(&gone).is_empty());
        let book = load(&w.ledger);
        assert!(book.entries[&id].pending.is_empty());
        assert!(book.entries[&orphan.id].pending.is_empty());
        // And the agent's own retry afterwards changes nothing.
        w.call(&worker, "append", entry("Saved, line lost.", "r1"))
            .unwrap();
        assert_eq!(lines(&worker).len(), 1);
    }

    // F3 — a restart that finds the line already written only confirms it.
    #[test]
    fn a_restart_confirms_a_line_written_just_before_the_crash() {
        let ledger = scratch_ledger();
        let chat = unique("written");
        index(&chat);
        let line = activity(&chat, &fresh_id(), Status::Saved);
        {
            let mut book = load(&ledger);
            let entry = book.entries.entry(line.id.clone()).or_default();
            entry.activity = Some(line.clone());
            entry.pending.insert(chat.clone(), Status::Saved);
            save(&ledger, &book).unwrap();
        }
        crate::transcript::append(&chat, &origin_event(&line));
        let (seen, emit) = capture();
        assert_eq!(
            recover_at(&ledger, |_| Ok(None), &emit),
            Recorded::default()
        );
        assert!(seen.lock().unwrap().is_empty());
        assert_eq!(lines(&chat).len(), 1);
        assert_eq!(
            load(&ledger).entries[&line.id].delivered.get(&chat),
            Some(&Status::Saved)
        );
    }

    #[test]
    fn a_reassigned_tasks_old_chat_keeps_speaking_for_its_own_agent() {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let potato = w.agent("Potato Juice");
        let (_, worker) = w.worker(&mango, "Reassigned later");
        // The task moves to Potato (written into the disposable ledger, as a
        // handoff leaves it); the chat that was reserved for Mango is still
        // Mango's, and writes Mango's memory, not Potato's.
        let file = w.base.join("orchestrations.json");
        let mut data: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        for task in data["tasks"].as_object_mut().unwrap().values_mut() {
            task["assignee"] = json!({"id": potato.id, "name": potato.name});
        }
        fs::write(&file, serde_json::to_vec(&data).unwrap()).unwrap();
        let store = OrchestrationStore::load(file);
        let tasks = store.snapshot(None).unwrap().tasks;
        assert_eq!(tasks[0].assignee.as_ref().unwrap().id, potato.id);
        w.call_as(&store, &worker, "append", entry("Still Mango.", "r1"))
            .unwrap();
        assert_eq!(lines(&worker)[0]["agent"]["name"], "Mango Juice");
        assert!(w.note(&mango).contains("Still Mango."));
        assert!(!w.note(&potato).contains("Still Mango."));
    }
}

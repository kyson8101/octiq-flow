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
//!   vault reconciles that same receipt.
//! * **A line is one operation.** A write that reached the vault is keyed by
//!   its receipt id — the authenticated chat, the vault folder and the
//!   requestId, exactly as the vault keys it — and changes only on that
//!   receipt's own evidence (uncertain → saved). A saved line never changes.
//!   A refusal is keyed by what was refused, so an identical failure reported
//!   twice is one line, and it never turns into anyone's success.
//! * **Delivered once, durably.** The ledger records, per destination chat,
//!   an intent before the transcript line and a confirmation after it. A crash
//!   between the two is settled by looking in that chat's transcript, so a
//!   retried call, a repeated delivery or a restart never writes a second line.
//! * **A worker's coordinator hears THAT it happened, not what.** When the chat
//!   is a worker in a run, the run's coordinator chat — still existing, checked
//!   at every delivery — gets a line naming the agent, the task and the worker
//!   chat to open. The entry's words stay in the worker chat.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::orchestration::OrchestrationStore;
use crate::team::{MemoryAppend, MemoryWrite, TeamAgent};

static LOCK: Mutex<()> = Mutex::new(());
/// How many activities the ledger remembers. Older ones only lose their
/// duplicate guard; their lines stay in the transcripts.
const KEEP: usize = 5000;
pub const EVENT: &str = "octiq_memory_activity";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Failed,
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
}

#[derive(Default, Serialize, Deserialize)]
struct Entry {
    activity: Option<Activity>,
    /// Chat key → the status that chat's transcript holds a line for.
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
        MemoryWrite::Failed(_) => None,
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
        MemoryWrite::Failed(error) => (Status::Failed, Some(error.clone())),
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
    }
}

/// The line the writing chat is shown: everything about this one write.
fn origin_event(activity: &Activity) -> Value {
    json!({
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
    })
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
            // A torn ledger costs the duplicate guard, not the chats' lines,
            // which are in their transcripts. Keep it for a person to read.
            eprintln!("memory_activity: unreadable ledger, starting over: {error}");
            let _ = fs::rename(path, path.with_extension("json.corrupt"));
            Ledger::default()
        }),
        Err(_) => Ledger::default(),
    }
}

fn save(path: &Path, ledger: &Ledger) -> Result<(), String> {
    let dir = path.parent().ok_or("The ledger has no folder.")?;
    let temp = dir.join(format!(".memory-activity-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(ledger).map_err(|e| e.to_string())?;
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())
}

/// Whether `chat`'s transcript already holds this activity's line at `status`.
fn in_transcript(chat: &str, id: &str, status: Status) -> bool {
    let status = json!(status);
    crate::transcript::since(chat, 0)
        .iter()
        .any(|r| r.event["type"] == EVENT && r.event["id"] == id && r.event["status"] == status)
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

/// Record an activity and show it to every chat not yet shown this status.
/// `fresh.owner` is the coordinator as it stands NOW; a line goes there only
/// if that still agrees with the one recorded. Returns the chats given a line.
pub fn record(fresh: Activity) -> Vec<String> {
    record_with(fresh, crate::agent_chat::record_chat_event)
}

fn record_with(fresh: Activity, emit: impl Fn(&str, Value) -> Option<u64>) -> Vec<String> {
    let Some(path) = ledger_path() else {
        return Vec::new();
    };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut ledger = load(&path);
    let old = ledger
        .entries
        .get_mut(&fresh.id)
        .and_then(|entry| entry.activity.take());
    let current = settle(old, &fresh);
    let mut lines = vec![(current.chat_key.clone(), origin_event(&current))];
    if current.status == Status::Saved {
        if let (Some(owner), Some(now)) = (&current.owner, &fresh.owner) {
            if owner.coordinator_chat_key == now.coordinator_chat_key
                && owner.coordinator_chat_key != current.chat_key
            {
                lines.push((
                    owner.coordinator_chat_key.clone(),
                    owner_event(&current, owner),
                ));
            }
        }
    }
    let mut shown = Vec::new();
    for (chat, event) in lines {
        let entry = ledger.entries.entry(current.id.clone()).or_default();
        if entry.delivered.get(&chat) == Some(&current.status) {
            continue;
        }
        if entry.pending.get(&chat) == Some(&current.status)
            && in_transcript(&chat, &current.id, current.status)
        {
            // Written before a crash, never confirmed: confirm it, don't repeat it.
            entry.pending.remove(&chat);
            entry.delivered.insert(chat, current.status);
            continue;
        }
        entry.pending.insert(chat.clone(), current.status);
        entry.activity = Some(current.clone());
        if let Err(error) = save(&path, &ledger) {
            // Without the intent a crash could cost the duplicate guard; the
            // line itself is still worth more than its absence.
            eprintln!("memory_activity: could not record the intent: {error}");
        }
        let written = emit(&chat, event).is_some();
        let entry = ledger.entries.entry(current.id.clone()).or_default();
        if written {
            entry.pending.remove(&chat);
            entry.delivered.insert(chat.clone(), current.status);
        }
        // Not written to the transcript: the intent stays, and the next
        // report of this write looks for the line and writes it if missing.
        shown.push(chat);
    }
    let id = current.id.clone();
    ledger.entries.entry(id).or_default().activity = Some(current);
    if ledger.entries.len() > KEEP {
        let mut by_age: Vec<(u64, String)> = ledger
            .entries
            .iter()
            .map(|(id, e)| (e.activity.as_ref().map_or(0, |a| a.at), id.clone()))
            .collect();
        by_age.sort();
        for (_, id) in by_age.into_iter().take(ledger.entries.len() - KEEP) {
            ledger.entries.remove(&id);
        }
    }
    if let Err(error) = save(&path, &ledger) {
        eprintln!("memory_activity: could not save the ledger: {error}");
    }
    shown
}

/// The date an earlier write under this receipt was made with, so a retry
/// that leaves `date` out repeats it rather than guessing today's.
fn recorded_date(receipt_id: &str) -> Option<String> {
    let path = ledger_path()?;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load(&path).entries.remove(receipt_id)?.activity?.date
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
                    record(refused(actor, &root, request_id, &error));
                    return Err(error);
                }
            };
            let remembered = match text("date").map(str::trim).filter(|d| !d.is_empty()) {
                Some(_) => None,
                None => vault
                    .receipt_id(actor, request_id)
                    .ok()
                    .and_then(|id| recorded_date(&id)),
            };
            let append = crate::team::memory_append(
                vault,
                actor,
                &me,
                text("text").unwrap_or_default(),
                remembered.as_deref().or(text("date")),
                request_id,
            );
            let owner = worker
                .ok()
                .flatten()
                .and_then(|w| owner_if_present(w, actor));
            record(from_append(
                actor,
                Some(&me),
                request_id,
                &root,
                &append,
                owner,
            ));
            append.result(&me)
        }
        _ => Err("Unknown agent memory operation.".into()),
    }
}

/// The coordinator a worker's line also goes to, while that chat still exists
/// and is not the worker itself.
fn owner_if_present(worker: crate::orchestration::WorkerOwner, actor: &str) -> Option<Owner> {
    let id = worker
        .coordinator_chat_key
        .strip_prefix("chat:")
        .unwrap_or(&worker.coordinator_chat_key);
    (worker.coordinator_chat_key != actor
        && crate::chat_index::list()
            .iter()
            .any(|chat| chat.id == id && chat.deleted_at.is_none()))
    .then_some(Owner {
        coordinator_chat_key: worker.coordinator_chat_key,
        task_id: worker.task_id,
        task_title: worker.task_title,
        run_id: worker.run_id,
    })
}

/// `vault_receipt` answered for one of this chat's receipts. A saved answer
/// settles the chat's uncertain line for that same receipt; anything else,
/// or another chat's receipt, changes nothing.
pub fn receipt_checked(
    orchestrations: &OrchestrationStore,
    chat_key: &str,
    receipt: &Value,
) -> Vec<String> {
    let (Some(id), Some("saved")) = (
        receipt.get("id").and_then(Value::as_str),
        receipt.get("status").and_then(Value::as_str),
    ) else {
        return Vec::new();
    };
    let found = {
        let Some(path) = ledger_path() else {
            return Vec::new();
        };
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load(&path)
            .entries
            .remove(id)
            .and_then(|entry| entry.activity)
    };
    match found {
        Some(activity) if activity.chat_key == chat_key && activity.status == Status::Uncertain => {
            let owner = orchestrations
                .worker_owner(chat_key)
                .ok()
                .flatten()
                .and_then(|w| owner_if_present(w, chat_key));
            record(Activity {
                status: Status::Saved,
                at: now_ms(),
                receipt_status: Some("saved".into()),
                error: None,
                owner,
                ..activity
            })
        }
        _ => Vec::new(),
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
                    Status::Failed => "none",
                }
                .into(),
            ),
            error: (status != Status::Saved).then(|| "boom".into()),
            owner: None,
        }
    }

    fn unique(prefix: &str) -> String {
        format!("chat:{prefix}-{}", uuid::Uuid::new_v4())
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
        let chat = unique("dup");
        let id = fresh_id();
        let (seen, emit) = capture();
        assert_eq!(
            record_with(activity(&chat, &id, Status::Saved), &emit),
            vec![chat.clone()]
        );
        // A retried call, a repeated MCP delivery, a restarted server: the
        // ledger is on disk, so each is a no-op.
        assert!(record_with(activity(&chat, &id, Status::Saved), &emit).is_empty());
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert_eq!(lines(&chat).len(), 1);
        assert_eq!(lines(&chat)[0]["text"], "A decision and why.");
    }

    #[test]
    fn a_saved_line_is_never_undone_and_uncertain_moves_only_on_its_own_receipt() {
        let chat = unique("fwd");
        let (seen, emit) = capture();
        let saved = fresh_id();
        record_with(activity(&chat, &saved, Status::Saved), &emit);
        // A later failure or doubt under the same id changes nothing.
        record_with(activity(&chat, &saved, Status::Failed), &emit);
        record_with(activity(&chat, &saved, Status::Uncertain), &emit);

        let doubtful = fresh_id();
        record_with(activity(&chat, &doubtful, Status::Uncertain), &emit);
        // "Saved" for a DIFFERENT receipt is not evidence about this one.
        let mut other = activity(&chat, &doubtful, Status::Saved);
        other.receipt_id = Some(fresh_id());
        record_with(other, &emit);
        record_with(activity(&chat, &doubtful, Status::Saved), &emit);

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
        assert_eq!(record_with(failed, &emit), vec![worker.clone()]);
        let mut saved = activity(&worker, &fresh_id(), Status::Saved);
        saved.owner = Some(owner.clone());
        assert_eq!(
            record_with(saved.clone(), &emit),
            vec![worker.clone(), coordinator.clone()]
        );
        // Deduplicated per destination.
        assert!(record_with(saved.clone(), &emit).is_empty());
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
        assert_eq!(record_with(doubtful, &emit), vec![worker.clone()]);
        let settled = activity(&worker, &id, Status::Saved);
        assert_eq!(record_with(settled, &emit), vec![worker.clone()]);
        assert_eq!(lines(&coordinator).len(), 1);
    }

    #[test]
    fn a_line_written_before_a_crash_is_confirmed_not_repeated() {
        let chat = unique("crash");
        let id = fresh_id();
        let line = activity(&chat, &id, Status::Saved);
        // The process wrote the intent and the transcript line, then died
        // before confirming it.
        {
            let path = ledger_path().unwrap();
            let _guard = LOCK.lock().unwrap();
            let mut ledger = load(&path);
            let entry = ledger.entries.entry(id.clone()).or_default();
            entry.activity = Some(line.clone());
            entry.pending.insert(chat.clone(), Status::Saved);
            save(&path, &ledger).unwrap();
        }
        crate::transcript::append(&chat, &origin_event(&line));
        let (seen, emit) = capture();
        assert!(record_with(line.clone(), &emit).is_empty());
        assert!(seen.lock().unwrap().is_empty());
        assert_eq!(lines(&chat).len(), 1);
        // And it stays confirmed.
        assert!(record_with(line, &emit).is_empty());
    }

    #[test]
    fn a_line_the_transcript_refused_is_written_by_the_next_report_once() {
        let chat = unique("refused-disk");
        let line = activity(&chat, &fresh_id(), Status::Saved);
        // The disk refused the line: it reached only the live stream.
        let dropped = |_: &str, _: Value| None;
        assert_eq!(record_with(line.clone(), dropped), vec![chat.clone()]);
        assert!(lines(&chat).is_empty());
        let (_, emit) = capture();
        assert_eq!(record_with(line.clone(), &emit), vec![chat.clone()]);
        assert!(record_with(line, &emit).is_empty());
        assert_eq!(lines(&chat).len(), 1);
    }

    #[test]
    fn different_chats_with_the_same_request_id_are_different_lines() {
        let a = unique("a");
        let b = unique("b");
        let (seen, emit) = capture();
        record_with(activity(&a, &fresh_id(), Status::Saved), &emit);
        record_with(activity(&b, &fresh_id(), Status::Saved), &emit);
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
        let chat = unique("unc");
        let other = unique("other");
        let id = fresh_id();
        record(activity(&chat, &id, Status::Uncertain));
        let receipt = json!({"id": id, "status": "saved"});
        // Another chat cannot settle it, and a still-uncertain answer does not.
        assert!(receipt_checked(&store, &other, &receipt).is_empty());
        assert!(
            receipt_checked(&store, &chat, &json!({"id": id, "status": "needs_review"})).is_empty()
        );
        assert_eq!(receipt_checked(&store, &chat, &receipt), vec![chat.clone()]);
        assert!(receipt_checked(&store, &chat, &receipt).is_empty());
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
                base,
                root,
                vault,
                store,
            }
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
            chat
        }

        fn call(&self, chat: &str, op: &str, tool: Value) -> Result<Value, String> {
            agent_memory(&self.vault, &self.team, &self.store, chat, op, &tool)
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
        // refused, change nothing, and never touch the saved line.
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
            assert!(error.contains("different operation"), "{error}");
        }
        assert!(!w.note(&mango).contains("Something else."));
        assert_eq!(w.note(&mango).matches("## 2026-09-29").count(), 0);
        let shown = lines(&chat);
        assert_eq!(shown[0]["status"], "saved");
        assert!(shown[1..]
            .iter()
            .all(|l| l["status"] == "failed" && l["id"] != shown[0]["id"]));

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
        assert_eq!(
            store.assignee_for_worker(&worker).unwrap(),
            Some(potato.id.clone())
        );
        agent_memory(
            &w.vault,
            &w.team,
            &store,
            &worker,
            "append",
            &entry("Still Mango.", "r1"),
        )
        .unwrap();
        assert_eq!(lines(&worker)[0]["agent"]["name"], "Mango Juice");
        assert!(w.note(&mango).contains("Still Mango."));
        assert!(!w.note(&potato).contains("Still Mango."));
    }
}

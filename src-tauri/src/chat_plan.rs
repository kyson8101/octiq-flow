//! A chat's plan: the list the person and the agent agree on before work
//! starts, and the Start only the person presses.
//!
//! The person sends several things one by one, answers the scoping questions
//! on each, and says "start" at the end. Until then nothing should begin,
//! and an hour later neither of them remembers what was decided on item 4.
//! So the chat keeps one plan: an ordered list of items, each with its
//! decisions and the questions still open.
//!
//! ## Three owners
//!
//!   * **The agent writes the list** (`plan_update`, through `/hook/plan`):
//!     titles, statuses, decisions, open questions, a note, and the ids of
//!     the orchestration tasks an item became. Every word of it is the
//!     agent's and is shown as that.
//!   * **The person starts it** (`chat_plan_start`, the page's command and
//!     nobody else's: no hook routes to it and the MCP server has no such
//!     tool). `started` is written by that and by nothing else.
//!   * **The host says how the work went**: an item's `progress` is counted
//!     from the ledger for each answer (`orchestration/plan_link.rs`), never
//!     stored here and never taken from the agent. An item the agent calls
//!     `done` whose tasks failed says both.
//!
//! ## The Start gate
//!
//! While a plan has not been started and has at least one item that is not
//! dropped, its chat's agent is refused the commands that start
//! orchestrated work (`gate`, asked in `/hook/orchestration`, which lists
//! them: `web::PLAN_GATED_COMMANDS`). A chat with no plan is never asked
//! anything. Once started a plan does not gate again, whatever is added to
//! it.
//!
//! ## Why a change patches items by id
//!
//! A plan is built one item at a time over a long conversation, and the
//! person can only read it. Replacing the whole list on every change would
//! have the agent retype up to sixty items to answer one question, which is
//! where an earlier item gets reworded or lost; and nothing should vanish
//! from a list its reader cannot edit. So a change adds items and changes
//! named ones, an item's id is the host's (`i1`, `i2`, never reused), and
//! there is no removing one: an item leaves by being `dropped`, and stays on
//! the list saying so.
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::orchestration::plan_link::{LinkedState, LinkedTask};

/// Items a plan holds, dropped ones included.
pub const MAX_ITEMS: usize = 60;
/// Decisions, and open questions, one item holds.
pub const MAX_LINES: usize = 12;
/// Characters of a title.
pub const MAX_TITLE: usize = 120;
/// Characters of one decision or one open question.
pub const MAX_LINE: usize = 240;
/// Characters of an item's note.
pub const MAX_NOTE: usize = 600;
/// Orchestration tasks one item is linked to.
pub const MAX_TASKS: usize = 24;

/// Turn ids the host gives the turn that tells an agent its plan was
/// started. Not a person's own (`agent_chat::is_person_turn_id`), so the
/// queue never folds a message into it or it into a message.
pub(crate) const START_TURN_PREFIX: &str = "octiq-plan-start-";

/// How every refusal of the Start gate begins.
pub(crate) const NOT_STARTED: &str = "This chat's plan has not been started.";

/// Where an item stands, in the agent's own word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Discussing,
    Decided,
    InProgress,
    Done,
    Dropped,
}

/// One piece of work on the plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// The host's, fixed when the item is added and never used again.
    pub id: String,
    pub title: String,
    pub status: Status,
    #[serde(default)]
    pub decisions: Vec<String>,
    /// Questions still open. One that was answered is taken off this list
    /// and, when it settled something, written as a decision.
    #[serde(default)]
    pub questions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// The orchestration tasks this item became, as the agent linked them.
    #[serde(default)]
    pub tasks: Vec<String>,
    /// The plan's revision this item was added in, and last changed in.
    pub added_in: u64,
    pub changed_in: u64,
}

/// The person's Start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub at: i64,
    /// The revision the person was looking at when they pressed it.
    pub revision: u64,
    /// The turn that tells the agent (`START_TURN_PREFIX`): the one made
    /// with the Start, or the try of it that was last handed over
    /// (`next_turn_id`).
    pub turn_id: String,
    /// Whether that turn was handed to the agent: written to it, or put in
    /// its queue. False from the Start until then, and false again when the
    /// person takes the turn back from the queue (`untold`). The Start
    /// stands either way; while this is false the page can ask again.
    ///
    /// **It is a note of a delivery, not the receipt of one.** The receipt
    /// is the turn's own line in the chat's record, under an id that is a
    /// function of this Start (`agent_chat::host_turns`): a delivery whose
    /// note could not be saved is found there by the next ask, which then
    /// saves the note and sends nothing (`chat_plan_start`).
    #[serde(default)]
    pub told: bool,
}

/// One chat's plan, as it is kept.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Goes up by one on every change to the list. A plan nobody has
    /// written is at 0. The person's Start does not move it: it changes no
    /// item, and has a stamp of its own.
    pub revision: u64,
    #[serde(default)]
    pub items: Vec<Item>,
    #[serde(default)]
    pub updated_at: i64,
    /// Who made the last change: the chat's registered agent by name, else
    /// `agent`.
    #[serde(default)]
    pub updated_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started: Option<Started>,
    /// The number the next item's id is made from. Never goes down, so an
    /// id is never given twice.
    #[serde(default)]
    next_item: u64,
}

impl Plan {
    /// Whether this plan waits on the person's Start: not started, and
    /// something on it is not dropped. This is the gate, and it is what
    /// Start can be pressed on.
    pub fn awaits_start(&self) -> bool {
        self.started.is_none() && self.items.iter().any(|item| item.status != Status::Dropped)
    }
}

/// An item to add.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewItem {
    pub title: String,
    #[serde(default)]
    pub status: Option<Status>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub questions: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub tasks: Vec<String>,
    /// The id of the item this one goes in front of. At the end without it.
    #[serde(default)]
    pub before: Option<String>,
}

/// What to change of one item. A field left out stays as it is; a list
/// that is given replaces the item's whole list.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemPatch {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub status: Option<Status>,
    #[serde(default)]
    pub decisions: Option<Vec<String>>,
    #[serde(default)]
    pub questions: Option<Vec<String>>,
    /// An empty note clears it.
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub tasks: Option<Vec<String>>,
}

/// One change to a plan, as `plan_update` carries it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    /// The revision this change was worked out against. 0 for a chat that
    /// has no plan yet.
    pub base_revision: u64,
    #[serde(default)]
    pub add: Vec<NewItem>,
    #[serde(default)]
    pub update: Vec<ItemPatch>,
    /// Every existing item's id, in the order the list should have. Items
    /// added by the same change keep the place `before` gave them, or go
    /// last.
    #[serde(default)]
    pub order: Option<Vec<String>>,
}

/// Serialises read-modify-write, as `chat_task` does: the loser of a race
/// would otherwise write its own copy over the winner's.
static LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A chat id that can be part of a file name on every system this runs on:
/// letters, digits, `-` and `_`. Nothing an agent wrote is ever part of a
/// path here; the id is the chat's own, and one that is anything else has
/// no plan.
fn safe(chat_id: &str) -> bool {
    !chat_id.is_empty()
        && chat_id.len() <= 128
        && chat_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

const BAD_CHAT: &str = "That is not a chat id.";

/// `<chats dir>/plan_<chat id>.json`. The prefix keeps the name clear of
/// the names Windows reserves, and of the transcripts `chat_index::reconcile`
/// sweeps (`chat_*.jsonl`).
fn path(chat_id: &str) -> Result<PathBuf, String> {
    if !safe(chat_id) {
        return Err(BAD_CHAT.into());
    }
    Ok(crate::profile::profile_dir()
        .join("chats")
        .join(format!("plan_{chat_id}.json")))
}

/// The plan kept for a chat. `None` is a chat with no plan, in a profile
/// that is there. A profile folder that is away, and a file that cannot be
/// understood, are errors: never "no plan", which would lift the gate and
/// let the next change start the list again from nothing.
fn read(chat_id: &str) -> Result<Option<Plan>, String> {
    let path = path(chat_id)?;
    let Some(raw) = crate::profile::read(&path, |error| {
        format!("The plan kept for this chat could not be read: {error}")
    })?
    else {
        return Ok(None);
    };
    serde_json::from_slice(&raw).map(Some).map_err(|error| {
        format!(
            "The plan kept for this chat could not be understood ({}): {error}. Nothing was changed.",
            path.file_name().unwrap_or_default().to_string_lossy()
        )
    })
}

/// Through a temporary and a rename, so a process that dies mid-write
/// leaves the plan as it was.
fn write(chat_id: &str, plan: &Plan) -> Result<(), String> {
    let path = path(chat_id)?;
    #[cfg(test)]
    if WRITES_FAIL.get() {
        return Err("The plan could not be saved: the disk is full".into());
    }
    if let Some(folder) = path.parent() {
        crate::profile::make_dir(folder)?;
    }
    let body = serde_json::to_vec_pretty(plan).map_err(|e| e.to_string())?;
    // A name of its own, so two writers never share a half-written file.
    let temp = path.with_file_name(format!(
        ".plan_{chat_id}.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    fs::write(&temp, body)
        .and_then(|()| fs::rename(&temp, &path))
        .map_err(|error| {
            let _ = fs::remove_file(&temp);
            // A folder that went away says so in the profile's own words.
            crate::profile::write_error(&path, error)
        })
}

// ------------------------------------------------------------------ reading

/// The plan kept for a chat, if it has one.
pub fn get(chat_id: &str) -> Result<Option<Plan>, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read(chat_id)
}

/// Forget a chat's plan, for a chat that is being removed for good. It is
/// kept through the trash window, like the chat's task status, so a chat
/// that is restored still has its plan. A plan that cannot be reached is
/// left as it is.
pub fn forget(chat_id: &str) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if crate::profile::available().is_err() {
        return;
    }
    if let Ok(path) = path(chat_id) {
        let _ = fs::remove_file(path);
    }
}

// ----------------------------------------------------------------- the gate

/// Whether `chat_key`'s agent may start orchestrated work now: `Err` is the
/// refusal, in words, while the chat's plan waits on the person's Start. A
/// chat with no plan passes without a word.
pub fn gate(chat_key: &str) -> Result<(), String> {
    let Some(chat_id) = chat_key.strip_prefix("chat:").filter(|id| safe(id)) else {
        return Ok(());
    };
    match get(chat_id)? {
        Some(plan) if plan.awaits_start() => {
            let items = plan
                .items
                .iter()
                .filter(|item| item.status != Status::Dropped)
                .count();
            Err(format!(
                "{NOT_STARTED} It has {} at revision {}, and only the person starts it, with Start on the Plan panel: no tool of yours does. Nothing was created or started. Keep the plan current with plan_update, tell the person it is ready, and wait.",
                counted(items, "item"),
                plan.revision,
            ))
        }
        _ => Ok(()),
    }
}

fn counted(count: usize, what: &str) -> String {
    if count == 1 {
        format!("1 {what}")
    } else {
        format!("{count} {what}s")
    }
}

// --------------------------------------------------------------- the change

/// One line of text: trimmed, and every run of spaces, tabs and line breaks
/// one space.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn title_of(text: &str) -> Result<String, String> {
    let title = one_line(text);
    let length = title.chars().count();
    if length == 0 {
        return Err("An item needs a title.".into());
    }
    if length > MAX_TITLE {
        return Err(format!(
            "A title can be {MAX_TITLE} characters at most; \"{}…\" has {length}.",
            title.chars().take(40).collect::<String>()
        ));
    }
    Ok(title)
}

/// A list of decisions or of open questions: each one line, an empty one
/// left out.
fn lines_of(lines: &[String], what: &str, title: &str) -> Result<Vec<String>, String> {
    let lines: Vec<String> = lines
        .iter()
        .map(|line| one_line(line))
        .filter(|line| !line.is_empty())
        .collect();
    if lines.len() > MAX_LINES {
        return Err(format!(
            "An item can hold {MAX_LINES} {what}s at most; \"{title}\" would have {}.",
            lines.len()
        ));
    }
    for line in &lines {
        let length = line.chars().count();
        if length > MAX_LINE {
            return Err(format!(
                "A {what} can be {MAX_LINE} characters at most; one of \"{title}\" has {length}. Keep it to what was decided or asked, and put the rest in the chat."
            ));
        }
    }
    Ok(lines)
}

fn note_of(note: &str, title: &str) -> Result<Option<String>, String> {
    let note = note.trim();
    let length = note.chars().count();
    if length > MAX_NOTE {
        return Err(format!(
            "A note can be {MAX_NOTE} characters at most; the one of \"{title}\" has {length}."
        ));
    }
    Ok((!note.is_empty()).then(|| note.to_string()))
}

fn tasks_of(tasks: &[String], title: &str) -> Result<Vec<String>, String> {
    let mut seen = Vec::new();
    for task in tasks {
        let task = task.trim();
        if !task.is_empty() && !seen.iter().any(|known| known == task) {
            seen.push(task.to_string());
        }
    }
    if seen.len() > MAX_TASKS {
        return Err(format!(
            "An item can be linked to {MAX_TASKS} tasks at most; \"{title}\" would have {}.",
            seen.len()
        ));
    }
    Ok(seen)
}

const IN_PROGRESS_BEFORE_START: &str = "An item is in progress only once the person has started the plan. Leave it decided: Start is theirs, on the Plan panel.";

/// `change` made to `plan`, or why not. Nothing of a refused change is
/// kept: the plan handed back is whole or it is the error.
fn applied(mut plan: Plan, change: &Change) -> Result<Plan, String> {
    if change.add.is_empty() && change.update.is_empty() && change.order.is_none() {
        return Err("This change names nothing to add, update or reorder.".into());
    }
    let revision = plan.revision + 1;
    let started = plan.started.is_some();
    let status_of = |status: Option<Status>, title: &str| -> Result<Option<Status>, String> {
        match status {
            Some(Status::InProgress) if !started => {
                Err(format!("\"{title}\": {IN_PROGRESS_BEFORE_START}"))
            }
            status => Ok(status),
        }
    };
    let known = |plan: &Plan| {
        let ids: Vec<&str> = plan.items.iter().map(|item| item.id.as_str()).collect();
        if ids.is_empty() {
            "It has no items yet.".to_string()
        } else {
            format!("Its items are: {}.", ids.join(", "))
        }
    };

    let mut patched: Vec<&str> = Vec::new();
    for patch in &change.update {
        if patched.contains(&patch.id.as_str()) {
            return Err(format!(
                "Item {} is changed twice in one call. Send one change for it.",
                patch.id
            ));
        }
        patched.push(&patch.id);
        let Some(at) = plan.items.iter().position(|item| item.id == patch.id) else {
            return Err(format!(
                "This plan has no item {}. {}",
                patch.id,
                known(&plan)
            ));
        };
        let mut item = plan.items[at].clone();
        if let Some(title) = &patch.title {
            item.title = title_of(title)?;
        }
        if let Some(status) = status_of(patch.status, &item.title)? {
            item.status = status;
        }
        if let Some(decisions) = &patch.decisions {
            item.decisions = lines_of(decisions, "decision", &item.title)?;
        }
        if let Some(questions) = &patch.questions {
            item.questions = lines_of(questions, "open question", &item.title)?;
        }
        if let Some(note) = &patch.note {
            item.note = note_of(note, &item.title)?;
        }
        if let Some(tasks) = &patch.tasks {
            item.tasks = tasks_of(tasks, &item.title)?;
        }
        if item != plan.items[at] {
            item.changed_in = revision;
            plan.items[at] = item;
        }
    }

    if let Some(order) = &change.order {
        let mut ordered = Vec::with_capacity(plan.items.len());
        for id in order {
            let Some(at) = plan.items.iter().position(|item| &item.id == id) else {
                return Err(format!(
                    "The order names {id}, which is not an item of this plan or is named twice. {}",
                    known(&Plan {
                        items: plan.items.iter().chain(&ordered).cloned().collect(),
                        ..Plan::default()
                    })
                ));
            };
            ordered.push(plan.items.remove(at));
        }
        if !plan.items.is_empty() {
            let left: Vec<&str> = plan.items.iter().map(|item| item.id.as_str()).collect();
            return Err(format!(
                "The order has to name every item once. It leaves out: {}.",
                left.join(", ")
            ));
        }
        plan.items = ordered;
    }

    for new in &change.add {
        let title = title_of(&new.title)?;
        let item = Item {
            id: format!("i{}", plan.next_item + 1),
            status: status_of(new.status, &title)?.unwrap_or(Status::Discussing),
            decisions: lines_of(&new.decisions, "decision", &title)?,
            questions: lines_of(&new.questions, "open question", &title)?,
            note: match &new.note {
                Some(note) => note_of(note, &title)?,
                None => None,
            },
            tasks: tasks_of(&new.tasks, &title)?,
            title,
            added_in: revision,
            changed_in: revision,
        };
        let at = match &new.before {
            Some(before) => plan
                .items
                .iter()
                .position(|item| &item.id == before)
                .ok_or_else(|| {
                    format!(
                        "\"{}\" was to go before {before}, which is not an item of this plan. {}",
                        item.title,
                        known(&plan)
                    )
                })?,
            None => plan.items.len(),
        };
        plan.next_item += 1;
        plan.items.insert(at, item);
    }
    if plan.items.len() > MAX_ITEMS {
        return Err(format!(
            "A plan holds {MAX_ITEMS} items at most, dropped ones included; this would make {}. Put what is left in an item's note, or ask the person which items to merge.",
            plan.items.len()
        ));
    }
    Ok(plan)
}

/// What a change did.
pub struct Updated {
    pub plan: Plan,
    /// False when the change asked for what the plan already says: nothing
    /// was written and the revision stands.
    pub changed: bool,
}

/// Make one change to a chat's plan, as `by`.
///
/// `linkable` answers for the task ids the change links that are not
/// already linked on that item: `Err` in words for one this chat may not
/// link. It is asked with the plan's lock let go, so nothing here ever
/// holds that lock across a read of the ledger.
pub fn update(
    chat_id: &str,
    by: &str,
    change: Change,
    linkable: impl FnOnce(&[String]) -> Result<(), String>,
) -> Result<Updated, String> {
    // Only what this change links anew is asked about: a task an item
    // already names may since have left the ledger, and saying its id again
    // is no new link.
    let before = get(chat_id)?.unwrap_or_default();
    let named = |task: &String| task.trim().to_string();
    let linked: Vec<String> = change
        .add
        .iter()
        .flat_map(|item| item.tasks.iter().map(named))
        .chain(change.update.iter().flat_map(|patch| {
            let known = before
                .items
                .iter()
                .find(|item| item.id == patch.id)
                .map(|item| item.tasks.as_slice())
                .unwrap_or_default();
            patch
                .tasks
                .iter()
                .flatten()
                .map(named)
                .filter(|task| !known.contains(task))
                .collect::<Vec<_>>()
        }))
        .filter(|task| !task.is_empty())
        .collect();
    if !linked.is_empty() {
        linkable(&linked)?;
    }
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let plan = read(chat_id)?.unwrap_or_default();
    if change.base_revision != plan.revision {
        return Err(format!(
            "The plan is at revision {}, and this change was based on revision {}. Nothing was changed. Read it with plan_read, then send the change again based on revision {}.",
            plan.revision, change.base_revision, plan.revision
        ));
    }
    let mut next =
        applied(plan.clone(), &change).map_err(|why| format!("{why} Nothing was changed."))?;
    if next.items == plan.items {
        return Ok(Updated {
            plan,
            changed: false,
        });
    }
    next.revision = plan.revision + 1;
    next.updated_at = now_ms();
    next.updated_by = by.to_string();
    write(chat_id, &next)?;
    Ok(Updated {
        plan: next,
        changed: true,
    })
}

// ---------------------------------------------------------------- the start

const NO_PLAN: &str = "This chat has no plan to start.";
const NOTHING_TO_START: &str = "Every item of this plan is dropped, so there is nothing to start.";

fn already_started(started: &Started) -> String {
    format!(
        "This plan was already started, at revision {}. It is started once.",
        started.revision
    )
}

fn startable_in(plan: Option<Plan>, revision: u64) -> Result<Plan, String> {
    let plan = plan.ok_or(NO_PLAN)?;
    if let Some(started) = &plan.started {
        return Err(already_started(started));
    }
    if !plan.awaits_start() {
        return Err(if plan.items.is_empty() {
            NO_PLAN.into()
        } else {
            NOTHING_TO_START.into()
        });
    }
    if plan.revision != revision {
        return Err(format!(
            "The plan changed while you were looking at it: it is at revision {}, and Start was pressed on revision {revision}. Nothing was started. Read it again, then press Start.",
            plan.revision
        ));
    }
    Ok(plan)
}

/// The plan `start` would start, or why it would not. Writes nothing.
pub fn startable(chat_id: &str, revision: u64) -> Result<Plan, String> {
    startable_in(get(chat_id)?, revision)
}

/// A fresh id for the turn that tells the agent, made once for a Start and
/// saved with it. Every try at telling the agent of that Start is under
/// this id or one counted on from it (`next_turn_id`), never a fresh one:
/// a fresh id for each ask is what let one Start be told twice (review of
/// 16e4188, H2), because nothing in the chat's record tied two asks to the
/// one Start.
pub(crate) fn start_turn_id() -> String {
    format!("{START_TURN_PREFIX}{}", uuid::Uuid::new_v4())
}

/// What a later try's id ends in, before its number.
const TRY_MARK: &str = "-try";

/// The id of the try after `turn_id`, for a Start whose turn will not reach
/// the agent (`agent_chat::HostTurn::Gone`): `…`, `…-try2`, `…-try3`. A
/// turn that is gone keeps its id for good, with the line that says so, and
/// the page drops a bubble by its id, so the next try cannot reuse it.
pub(crate) fn next_turn_id(turn_id: &str) -> String {
    match tried(turn_id) {
        Some((first, number)) => format!("{first}{TRY_MARK}{}", number.saturating_add(1)),
        None => format!("{turn_id}{TRY_MARK}2"),
    }
}

/// The id a Start's first try was made under, which every later try's id
/// begins with.
pub(crate) fn first_turn_id(turn_id: &str) -> &str {
    tried(turn_id).map_or(turn_id, |(first, _)| first)
}

fn tried(turn_id: &str) -> Option<(&str, u32)> {
    let (first, number) = turn_id.rsplit_once(TRY_MARK)?;
    Some((first, number.parse().ok()?))
}

/// The claim on telling one chat's agent of its plan's Start. Whoever holds
/// it is the only one reading whether the agent was told, handing the turn
/// over and noting that it was, so two asks at once are one after the
/// other: the second finds what the first did. Taking the Start's turn back
/// from the queue holds it too, so the note cannot be written over a
/// taking back. One per chat, for as long as the server runs; taken before
/// any lock of the chats', and nothing that holds one of those asks for it.
pub(crate) fn telling(chat_id: &str) -> std::sync::Arc<Mutex<()>> {
    static CLAIMS: Mutex<BTreeMap<String, std::sync::Arc<Mutex<()>>>> = Mutex::new(BTreeMap::new());
    CLAIMS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(chat_id.to_string())
        .or_default()
        .clone()
}

/// Record the person's Start on `revision`. Save-first: the plan is started
/// only when this answers `Ok`, and a Start that cannot be written is
/// refused whole, with the plan as it was.
pub fn start(chat_id: &str, revision: u64, turn_id: &str) -> Result<Plan, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut plan = startable_in(read(chat_id)?, revision)?;
    plan.started = Some(Started {
        at: now_ms(),
        revision,
        turn_id: turn_id.to_string(),
        told: false,
    });
    write(chat_id, &plan)?;
    Ok(plan)
}

/// Record that the agent was handed the turn `turn_id` for its plan's
/// Start. When and on which revision the plan was started is not touched:
/// the Start is recorded once, by `start`. A plan that is not started is
/// left as it is.
pub fn told(chat_id: &str, turn_id: &str) -> Result<Plan, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut plan = read(chat_id)?.ok_or(NO_PLAN)?;
    let Some(started) = plan.started.as_mut() else {
        return Ok(plan);
    };
    if started.told && started.turn_id == turn_id {
        return Ok(plan);
    }
    started.told = true;
    started.turn_id = turn_id.to_string();
    write(chat_id, &plan)?;
    Ok(plan)
}

/// Record that the turn `turn_id` will not reach the agent after all: the
/// person took it back from the queue. The Start stands, as it was
/// recorded; its agent has not been told, and the page can ask again.
/// `None` when the plan does not say that turn was handed over, which
/// changes nothing.
pub fn untold(chat_id: &str, turn_id: &str) -> Result<Option<Plan>, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(mut plan) = read(chat_id)? else {
        return Ok(None);
    };
    match plan.started.as_mut() {
        Some(started) if started.told && started.turn_id == turn_id => started.told = false,
        _ => return Ok(None),
    }
    write(chat_id, &plan)?;
    Ok(Some(plan))
}

/// What the host tells an agent when the person starts its chat's plan. The
/// wording is the host's, never the page's.
pub(crate) fn start_message(plan: &Plan) -> String {
    let revision = plan
        .started
        .as_ref()
        .map_or(plan.revision, |started| started.revision);
    format!(
        "The person pressed Start on this chat's plan, at revision {revision}. Work may begin now.\n\
         1. Read the plan with plan_read.\n\
         2. Turn its decided items into work: tasks of an orchestration run where the work is to be delegated, your own work in this chat where it is not. Leave an item that is still being discussed until its open questions are answered, and ask them.\n\
         3. Link each item to the tasks it became (plan_update, tasks), and move its status as the work does: in_progress when it starts, done when it is finished.\n\
         4. Keep the plan current. The person reads it beside this chat.\n\
         Items added from now on do not wait for another Start."
    )
}

// --------------------------------------------------------------- the answer

/// How an item's linked tasks stand, counted from the ledger for this
/// answer. `total` is the tasks that count as work: `done + running +
/// failed + waiting`. A cancelled or replaced task, and one whose run the
/// person stopped or closed before it finished, is `closed` and counted
/// nowhere else; an id the ledger no longer holds is `unknown`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub total: usize,
    /// Finished well: settled, and its check did not fail.
    pub done: usize,
    /// An attempt is being prepared or is running.
    pub running: usize,
    /// Failed, blocked with no decision open, or settled with a failed check.
    pub failed: usize,
    /// Everything else that still counts: not started, held, waiting on a
    /// decision, stopped by the person.
    pub waiting: usize,
    pub closed: usize,
    pub unknown: usize,
}

/// An item as it is answered: what the agent wrote, then what the host
/// counted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    #[serde(flatten)]
    pub item: Item,
    /// Present only for an item with linked tasks, and only when the ledger
    /// could be read. Never the agent's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
    /// The linked tasks the ledger holds, in the item's order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub linked: Vec<LinkedTask>,
}

/// What `chat_plan_get` answers, and what `chat-plan` carries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub chat_id: String,
    /// 0 for a chat with no plan.
    pub revision: u64,
    pub items: Vec<ItemView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started: Option<Started>,
    /// Derived: the plan waits on the person's Start, and this chat's agent
    /// is refused the commands that start orchestrated work.
    pub awaits_start: bool,
}

/// `plan` for an answer. `ledger` is what the host knows of the linked
/// tasks (`OrchestrationStore::linked_tasks`), or `None` when it could not
/// be read: an item's progress is then left out, never guessed.
pub fn view(
    chat_id: &str,
    plan: Option<Plan>,
    ledger: Option<&BTreeMap<String, LinkedTask>>,
) -> PlanView {
    let plan = plan.unwrap_or_default();
    let awaits_start = plan.awaits_start();
    let written = plan.revision > 0;
    PlanView {
        chat_id: chat_id.to_string(),
        revision: plan.revision,
        updated_at: written.then_some(plan.updated_at),
        updated_by: written.then(|| plan.updated_by.clone()),
        started: plan.started,
        awaits_start,
        items: plan
            .items
            .into_iter()
            .map(|item| {
                let (progress, linked) = match ledger {
                    Some(ledger) if !item.tasks.is_empty() => {
                        let mut progress = Progress::default();
                        let mut linked = Vec::new();
                        for id in &item.tasks {
                            let Some(task) = ledger.get(id) else {
                                progress.unknown += 1;
                                continue;
                            };
                            match task.state {
                                LinkedState::Done => progress.done += 1,
                                LinkedState::Running => progress.running += 1,
                                LinkedState::Failed => progress.failed += 1,
                                LinkedState::Waiting => progress.waiting += 1,
                                LinkedState::Closed => progress.closed += 1,
                            }
                            linked.push(task.clone());
                        }
                        progress.total =
                            progress.done + progress.running + progress.failed + progress.waiting;
                        (Some(progress), linked)
                    }
                    _ => (None, Vec::new()),
                };
                ItemView {
                    item,
                    progress,
                    linked,
                }
            })
            .collect(),
    }
}

/// A chat's plan as `chat_plan_get` answers it: what the agent wrote, with
/// what `ledger` says of the tasks it links, read now and kept nowhere. A
/// ledger that cannot be read leaves the progress out.
pub fn answer(
    ledger: &crate::orchestration::OrchestrationStore,
    chat_id: &str,
    plan: Option<Plan>,
) -> PlanView {
    let ids: Vec<&str> = plan
        .iter()
        .flat_map(|plan| plan.items.iter())
        .flat_map(|item| item.tasks.iter().map(String::as_str))
        .collect();
    let linked = (!ids.is_empty())
        .then(|| {
            ledger
                .linked_tasks(ids)
                .inspect_err(|error| eprintln!("[plan] no progress for {chat_id}: {error}"))
                .ok()
        })
        .flatten();
    view(chat_id, plan, linked.as_ref())
}

#[cfg(test)]
thread_local! {
    static WRITES_FAIL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Run `during` with every save of a plan on this thread failing, in a
/// profile that is there: the disk is full, the file is locked. For a test
/// of what a save-first action does when its save does not happen.
#[cfg(test)]
pub(crate) fn while_writes_fail<T>(during: impl FnOnce() -> T) -> T {
    struct Mend;
    impl Drop for Mend {
        fn drop(&mut self) {
            WRITES_FAIL.set(false);
        }
    }
    WRITES_FAIL.set(true);
    let _mend = Mend;
    during()
}

#[cfg(test)]
mod tests;

//! Agent levels: experience for work someone accepted.
//!
//! A worker saying "completed" is a claim. XP is paid only when the person, or
//! the lead responsible for the task, looks at that result and accepts it —
//! an explicit action recorded on the task (`TaskAcceptance`) and, in the same
//! write, in two ledgers:
//!
//! - `Stored::acceptances`, every acceptance as it was made, paid or not.
//!   Appended once per accepted attempt and never edited, so reopening a task
//!   and accepting a later result adds a line rather than overwriting the
//!   first. An agent's accepted-task count and history come from here, which
//!   is why a task that earned nothing still counts as accepted.
//! - `Stored::xp_awards`, what was paid, keyed by the task id, so one task
//!   pays once however often it is reopened, retried or accepted again, and
//!   two accepts racing each other still pay once. XP totals come from here.
//!
//! What a task is worth is its size, chosen before it starts and locked from
//! its first attempt on, so nobody resizes work after seeing how it went. A
//! task that started before sizes existed has none and earns nothing: there
//! is no evidence of what it was agreed to be worth, and none is invented.
//!
//! Identity is the registered agent id the task was assigned to. Renaming an
//! agent or changing its model changes nothing here. A manager is never paid
//! for its reports' subtasks: each award names exactly one task and the agent
//! that task was assigned to.
use super::*;

/// XP needed to go from level L to L+1 is `LEVEL_STEP * L`.
pub const LEVEL_STEP: u64 = 100;
/// Rows of XP history per page.
pub const HISTORY_PAGE: usize = 20;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskSize {
    Small,
    #[default]
    Medium,
    Large,
}

impl TaskSize {
    pub const ALL: [TaskSize; 3] = [TaskSize::Small, TaskSize::Medium, TaskSize::Large];

    pub const fn xp(self) -> u64 {
        match self {
            TaskSize::Small => 25,
            TaskSize::Medium => 75,
            TaskSize::Large => 150,
        }
    }
}

/// Total XP at which `level` starts: 50·L·(L−1). Level 1 starts at 0.
pub const fn level_threshold(level: u32) -> u64 {
    let level = level as u64;
    LEVEL_STEP / 2 * level * level.saturating_sub(1)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelProgress {
    pub xp: u64,
    pub level: u32,
    /// XP at which the current level started.
    pub level_xp: u64,
    /// XP at which the next level starts.
    pub next_level_xp: u64,
}

pub fn level_for(xp: u64) -> LevelProgress {
    let mut level = 1u32;
    while level_threshold(level + 1) <= xp {
        level += 1;
    }
    LevelProgress {
        xp,
        level,
        level_xp: level_threshold(level),
        next_level_xp: level_threshold(level + 1),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptorKind {
    /// The person, from the browser.
    Person,
    /// The lead responsible for the task, from its own chat.
    Lead,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Acceptor {
    pub kind: AcceptorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
}

/// Who accepted a task's current result, and which result it was.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAcceptance {
    pub attempt_id: String,
    pub at: i64,
    pub by: Acceptor,
}

/// One line of an agent's XP history. A copy, not a reference: the task, the
/// run and the agent can all change or go while the ledger keeps its word.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XpAward {
    pub task_id: String,
    pub run_id: String,
    pub agent_id: String,
    /// The agent's name when it was paid.
    pub agent_name: String,
    pub title: String,
    pub size: TaskSize,
    pub xp: u64,
    pub attempt_id: String,
    pub accepted_at: i64,
    pub accepted_by: Acceptor,
}

/// Why an acceptance paid nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Unpaid {
    /// The task started before sizes were recorded: its worth was never agreed.
    Unsized,
    /// An earlier acceptance of this task already paid it.
    AlreadyPaid,
    /// No registered agent ran the accepted attempt.
    NoAgent,
}

impl Unpaid {
    pub fn note(self) -> &'static str {
        match self {
            Unpaid::Unsized => "This task started before sizes were recorded, so it earns no XP.",
            Unpaid::AlreadyPaid => "XP for this task was already paid; a task pays once.",
            Unpaid::NoAgent => "No registered agent owns this task, so no XP is paid.",
        }
    }
}

/// One explicit acceptance of one attempt's result, exactly as it was made.
/// A copy, like `XpAward`: it outlives the task, the run and the agent's name.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceRecord {
    pub task_id: String,
    pub run_id: String,
    pub title: String,
    /// The result that was accepted.
    pub attempt_id: String,
    /// The registered agent that attempt ran as, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    /// The task's size when it was accepted; none on a task from before sizes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<TaskSize>,
    /// What this acceptance paid: the size's XP, or 0.
    pub xp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unpaid: Option<Unpaid>,
    pub accepted_at: i64,
    pub accepted_by: Acceptor,
}

/// Who is asking to accept. The browser is the person; a chat is only ever a
/// lead after the host has checked which chat it is.
pub enum AcceptActor<'a> {
    Person,
    /// `lead` is the registered agent the chat was handed to, from team.json
    /// (`team::lead_for_chat`), when it has one.
    Chat {
        chat_key: &'a str,
        lead: Option<(String, String)>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Accepted {
    pub task: Task,
    /// The award this task holds, new or earlier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub award: Option<XpAward>,
    /// True only when this call paid it.
    pub awarded: bool,
    /// Why no XP was paid, when none was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelSummary {
    pub agent_id: String,
    #[serde(flatten)]
    pub progress: LevelProgress,
    pub accepted_tasks: u64,
}

/// A completed task of this agent's that nobody has accepted yet.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwaitingAcceptance {
    pub task_id: String,
    pub run_id: String,
    pub coordinator_chat_key: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<TaskSize>,
    pub attempt_id: String,
    pub finished_at: i64,
    /// Accepting it would pay nothing (already paid, or no size recorded).
    pub unscored: bool,
}

/// One line of an agent's accepted work, newest first: every acceptance of a
/// result it produced, including those that paid nothing.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    #[serde(flatten)]
    pub record: AcceptanceRecord,
    /// The run's main chat, while the run is still in the ledger.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinator_chat_key: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelProfile {
    pub agent_id: String,
    #[serde(flatten)]
    pub progress: LevelProgress,
    /// Distinct tasks accepted for this agent, paid or not, for good.
    pub accepted_tasks: u64,
    /// Every acceptance of this agent's work, newest first, one page.
    pub history: Vec<HistoryEntry>,
    pub history_total: usize,
    pub history_offset: usize,
    pub awaiting: Vec<AwaitingAcceptance>,
    /// When this ledger began paying XP. Nothing finished before it was
    /// scored, and nothing is backfilled.
    pub scoring_since: i64,
    pub rules: Rules,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    pub sizes: Vec<(TaskSize, u64)>,
    pub level_step: u64,
}

pub fn rules() -> Rules {
    Rules {
        sizes: TaskSize::ALL.iter().map(|s| (*s, s.xp())).collect(),
        level_step: LEVEL_STEP,
    }
}

/// Whether any attempt has ever been made at this task: its size is fixed
/// from then on.
pub(super) fn task_started(data: &Stored, task_id: &str) -> bool {
    data.attempts.values().any(|a| a.task_id == task_id)
}

/// Stamp when scoring began, once. True when it was stamped now.
pub(super) fn stamp_scoring_since(data: &mut Stored, now: i64) -> bool {
    if data.scoring_since.is_some() {
        return false;
    }
    data.scoring_since = Some(now);
    true
}

/// This agent's acceptances, newest first.
fn accepted_for<'a>(data: &'a Stored, agent_id: &str) -> Vec<&'a AcceptanceRecord> {
    let mut records: Vec<&AcceptanceRecord> = data
        .acceptances
        .iter()
        .filter(|record| record.agent_id.as_deref() == Some(agent_id))
        .collect();
    // Appended in order; reversing keeps two in the same millisecond in the
    // order they were made.
    records.reverse();
    records.sort_by_key(|record| std::cmp::Reverse(record.accepted_at));
    records
}

fn distinct_tasks<'a>(records: impl IntoIterator<Item = &'a AcceptanceRecord>) -> u64 {
    records
        .into_iter()
        .map(|record| record.task_id.as_str())
        .collect::<std::collections::BTreeSet<_>>()
        .len() as u64
}

/// Give a store written before the acceptance ledger one line for each
/// acceptance it can still prove: every award, and every task's current
/// acceptance. True when anything was added.
pub(super) fn backfill_acceptances(data: &mut Stored) -> bool {
    let known = |data: &Stored, task_id: &str, attempt_id: &str| {
        data.acceptances
            .iter()
            .any(|r| r.task_id == task_id && r.attempt_id == attempt_id)
    };
    let mut added = Vec::new();
    for award in data.xp_awards.values() {
        if !known(data, &award.task_id, &award.attempt_id) {
            added.push(AcceptanceRecord {
                task_id: award.task_id.clone(),
                run_id: award.run_id.clone(),
                title: award.title.clone(),
                attempt_id: award.attempt_id.clone(),
                agent_id: Some(award.agent_id.clone()),
                agent_name: Some(award.agent_name.clone()),
                size: Some(award.size),
                xp: award.xp,
                unpaid: None,
                accepted_at: award.accepted_at,
                accepted_by: award.accepted_by.clone(),
            });
        }
    }
    for task in data.tasks.values() {
        let Some(acceptance) = task.acceptance.as_ref() else {
            continue;
        };
        if known(data, &task.id, &acceptance.attempt_id)
            || added.iter().any(|r: &AcceptanceRecord| {
                r.task_id == task.id && r.attempt_id == acceptance.attempt_id
            })
        {
            continue;
        }
        let owner = data
            .attempts
            .get(&acceptance.attempt_id)
            .and_then(|attempt| attempt.assignee.clone())
            .or_else(|| task.assignee.clone());
        let paid_here = data
            .xp_awards
            .get(&task.id)
            .is_some_and(|award| award.attempt_id == acceptance.attempt_id);
        added.push(AcceptanceRecord {
            task_id: task.id.clone(),
            run_id: task.run_id.clone(),
            title: task.title.clone(),
            attempt_id: acceptance.attempt_id.clone(),
            agent_id: owner.as_ref().map(|a| a.id.clone()),
            agent_name: owner.as_ref().map(|a| a.name.clone()),
            size: task.size,
            xp: 0,
            unpaid: (!paid_here).then(|| {
                if owner.is_none() {
                    Unpaid::NoAgent
                } else if data.xp_awards.contains_key(&task.id) {
                    Unpaid::AlreadyPaid
                } else {
                    Unpaid::Unsized
                }
            }),
            accepted_at: acceptance.at,
            accepted_by: acceptance.by.clone(),
        });
    }
    if added.is_empty() {
        return false;
    }
    data.acceptances.extend(added);
    data.acceptances.sort_by_key(|record| record.accepted_at);
    true
}

impl OrchestrationStore {
    /// Choose a task's size before it starts. The person may change it from
    /// the browser until the first attempt; after that it is part of the
    /// record the XP is paid on.
    ///
    /// The size is part of what a plan approval covers. Changing it on a task
    /// the person already approved puts that task, and the plan, back in
    /// front of them: no worker starts on a size nobody approved.
    pub fn set_task_size(&self, task_id: &str, size: TaskSize) -> Result<Task, String> {
        let mut reopened_plan = false;
        self.mutate(|data| {
            if task_started(data, task_id) {
                return Err(
                    "The size is locked: this task has already started. It stays what it was agreed to be.".into(),
                );
            }
            let task = data.tasks.get_mut(task_id).ok_or("Task does not exist.")?;
            if !matches!(task.status, TaskStatus::Pending | TaskStatus::Ready) {
                return Err("Only a task that has not started can be resized.".into());
            }
            if task.size == Some(size) {
                return Ok(task.clone());
            }
            let now = now_ms();
            if approval_parent(task).is_none()
                && task.approved_at.is_some()
                && task.approval_rollback.is_none()
            {
                task.approval_rollback = TaskApprovalRollback::capture(task);
            }
            task.size = Some(size);
            task.updated_at = now;
            let changed = task.clone();
            if approval_parent(&changed).is_none() && changed.approved_at.is_some() {
                if let Some(plan) = data
                    .runs
                    .get_mut(&changed.run_id)
                    .and_then(|run| run.plan_approval.as_mut())
                {
                    let task = data.tasks.get_mut(task_id).expect("read above");
                    task.approved_at = None;
                    task.approved = None;
                    if plan.status != PlanStatus::Pending {
                        plan.status = PlanStatus::Pending;
                        plan.requested_at = now;
                        plan.decided_at = None;
                        reopened_plan = true;
                    }
                }
            }
            Ok(data.tasks[task_id].clone())
        })
        .inspect(|task| {
            announce(&task.run_id, "task_resized");
            if reopened_plan {
                announce(&task.run_id, "plan_pending");
            }
        })
    }

    /// Accept the result of `attempt_id`, the task's current completed
    /// attempt, and pay its assignee the task's XP if it has never been paid.
    ///
    /// The person may accept any task. A chat may accept only as the lead
    /// responsible for the task: the run's coordinator, or — for a subtask —
    /// the manager who split it, from one of its own worker chats. Nobody
    /// accepts their own work.
    pub fn accept_task(
        &self,
        actor: AcceptActor<'_>,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<Accepted, String> {
        let mut run_for_event = String::new();
        let result = self.mutate(|data| {
            let task = data
                .tasks
                .get(task_id)
                .ok_or("The task does not exist.")?
                .clone();
            let run = data
                .runs
                .get(&task.run_id)
                .ok_or("The task's run does not exist.")?
                .clone();
            if task.status != TaskStatus::Completed {
                return Err("Only a completed task can be accepted.".into());
            }
            let current = task
                .active_attempt_id
                .as_deref()
                .and_then(|id| data.attempts.get(id))
                .filter(|attempt| attempt.status == AttemptStatus::Completed)
                .ok_or("This task has no completed result to accept.")?;
            if current.id != attempt_id {
                return Err(format!(
                    "The result changed since it was reviewed: attempt {} is the current one. Review that result, then accept it.",
                    current.id
                ));
            }
            let attempt = current.clone();
            // Who ran the accepted result, as recorded when it started. An
            // attempt from before that was recorded falls back to the task.
            let owner = attempt.assignee.clone().or_else(|| task.assignee.clone());

            let by = match actor {
                AcceptActor::Person => Acceptor {
                    kind: AcceptorKind::Person,
                    agent_id: None,
                    agent_name: None,
                },
                AcceptActor::Chat { chat_key, lead } => {
                    let (agent_id, agent_name) = if chat_key == run.coordinator_chat_key {
                        lead.ok_or(
                            "Only a registered lead can accept work. Ask the person to accept it.",
                        )?
                    } else {
                        // A manager, for a subtask it split: one of its own
                        // attempts at the parent task. A task the coordinator
                        // put under that parent is not its split to accept.
                        let parent = approval_parent(&task)
                            .and_then(|id| data.tasks.get(id))
                            .filter(|parent| {
                                data.attempts.values().any(|a| {
                                    a.task_id == parent.id && a.worker_chat_key == chat_key
                                })
                            })
                            .ok_or(
                                "Only the person, the run's lead, or the manager who split this task can accept it.",
                            )?;
                        let manager = parent.assignee.as_ref().ok_or(
                            "Only a registered lead can accept work. Ask the person to accept it.",
                        )?;
                        (manager.id.clone(), manager.name.clone())
                    };
                    if owner.as_ref().is_some_and(|a| a.id == agent_id)
                        || task.assignee.as_ref().is_some_and(|a| a.id == agent_id)
                        || data
                            .attempts
                            .values()
                            .any(|a| a.task_id == task.id && a.worker_chat_key == chat_key)
                    {
                        return Err("An agent cannot accept its own work.".into());
                    }
                    Acceptor {
                        kind: AcceptorKind::Lead,
                        agent_id: Some(agent_id),
                        agent_name: Some(agent_name),
                    }
                }
            };
            run_for_event = task.run_id.clone();
            let now = now_ms();

            // Accepting the same result again changes nothing.
            let already = task
                .acceptance
                .as_ref()
                .filter(|acceptance| acceptance.attempt_id == attempt.id)
                .is_some();
            if !already {
                let stored = data.tasks.get_mut(task_id).expect("the task was read above");
                stored.acceptance = Some(TaskAcceptance {
                    attempt_id: attempt.id.clone(),
                    at: now,
                    by: by.clone(),
                });
                stored.updated_at = now;
            }

            let mut awarded = false;
            let unpaid = if data.xp_awards.contains_key(task_id) {
                Some(Unpaid::AlreadyPaid)
            } else if let Some(assignee) = owner.as_ref() {
                match task.size {
                    Some(size) => {
                        data.xp_awards.insert(
                            task_id.to_owned(),
                            XpAward {
                                task_id: task_id.to_owned(),
                                run_id: task.run_id.clone(),
                                agent_id: assignee.id.clone(),
                                agent_name: assignee.name.clone(),
                                title: task.title.clone(),
                                size,
                                xp: size.xp(),
                                attempt_id: attempt.id.clone(),
                                accepted_at: now,
                                accepted_by: by.clone(),
                            },
                        );
                        awarded = true;
                        None
                    }
                    None => Some(Unpaid::Unsized),
                }
            } else {
                Some(Unpaid::NoAgent)
            };
            // One line per accepted result, written once, in the same write
            // as the acceptance and any award.
            if !already {
                data.acceptances.push(AcceptanceRecord {
                    task_id: task_id.to_owned(),
                    run_id: task.run_id.clone(),
                    title: task.title.clone(),
                    attempt_id: attempt.id.clone(),
                    agent_id: owner.as_ref().map(|a| a.id.clone()),
                    agent_name: owner.as_ref().map(|a| a.name.clone()),
                    size: task.size,
                    xp: if awarded { task.size.map_or(0, TaskSize::xp) } else { 0 },
                    unpaid: if awarded { None } else { unpaid },
                    accepted_at: now,
                    accepted_by: by.clone(),
                });
            }
            let note = unpaid.map(|why| why.note().to_string());
            Ok(Accepted {
                task: data.tasks[task_id].clone(),
                award: data.xp_awards.get(task_id).cloned(),
                awarded,
                note,
            })
        });
        if result.is_ok() {
            announce(&run_for_event, "task_accepted");
        }
        result
    }

    /// Level, XP and accepted count for every agent with accepted work,
    /// paid or not.
    pub fn level_summaries(&self) -> Result<Vec<LevelSummary>, String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let data = &inner.data;
        let mut xp: BTreeMap<&str, u64> = BTreeMap::new();
        for award in data.xp_awards.values() {
            *xp.entry(award.agent_id.as_str()).or_default() += award.xp;
        }
        let mut tasks: BTreeMap<&str, std::collections::BTreeSet<&str>> = BTreeMap::new();
        for record in &data.acceptances {
            if let Some(agent_id) = record.agent_id.as_deref() {
                tasks
                    .entry(agent_id)
                    .or_default()
                    .insert(record.task_id.as_str());
            }
        }
        let agents: std::collections::BTreeSet<&str> =
            xp.keys().chain(tasks.keys()).copied().collect();
        Ok(agents
            .into_iter()
            .map(|agent_id| LevelSummary {
                agent_id: agent_id.to_owned(),
                progress: level_for(xp.get(agent_id).copied().unwrap_or(0)),
                accepted_tasks: tasks.get(agent_id).map_or(0, |set| set.len() as u64),
            })
            .collect())
    }

    /// One agent's level, one page of its XP history, and what of its work is
    /// waiting to be accepted.
    pub fn level_profile(&self, agent_id: &str, offset: usize) -> Result<LevelProfile, String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let data = &inner.data;
        let xp = data
            .xp_awards
            .values()
            .filter(|award| award.agent_id == agent_id)
            .map(|award| award.xp)
            .sum();
        let records = accepted_for(data, agent_id);
        let history = records
            .iter()
            .skip(offset)
            .take(HISTORY_PAGE)
            .map(|record| HistoryEntry {
                record: (*record).clone(),
                coordinator_chat_key: data
                    .runs
                    .get(&record.run_id)
                    .map(|run| run.coordinator_chat_key.clone()),
            })
            .collect();
        let mut awaiting: Vec<AwaitingAcceptance> = data
            .tasks
            .values()
            .filter(|task| {
                task.status == TaskStatus::Completed
                    && task.assignee.as_ref().is_some_and(|a| a.id == agent_id)
            })
            .filter_map(|task| {
                let attempt = task
                    .active_attempt_id
                    .as_deref()
                    .and_then(|id| data.attempts.get(id))
                    .filter(|a| a.status == AttemptStatus::Completed)?;
                if task
                    .acceptance
                    .as_ref()
                    .is_some_and(|acceptance| acceptance.attempt_id == attempt.id)
                {
                    return None;
                }
                let run = data.runs.get(&task.run_id)?;
                Some(AwaitingAcceptance {
                    task_id: task.id.clone(),
                    run_id: task.run_id.clone(),
                    coordinator_chat_key: run.coordinator_chat_key.clone(),
                    title: task.title.clone(),
                    size: task.size,
                    attempt_id: attempt.id.clone(),
                    finished_at: attempt.finished_at.unwrap_or(attempt.updated_at),
                    unscored: task.size.is_none() || data.xp_awards.contains_key(&task.id),
                })
            })
            .collect();
        awaiting.sort_by_key(|item| std::cmp::Reverse(item.finished_at));
        Ok(LevelProfile {
            agent_id: agent_id.to_owned(),
            progress: level_for(xp),
            accepted_tasks: distinct_tasks(records.iter().copied()),
            history_total: records.len(),
            history_offset: offset,
            history,
            awaiting,
            scoring_since: data.scoring_since.unwrap_or_default(),
            rules: rules(),
        })
    }
}

#[cfg(test)]
pub(crate) mod tests;

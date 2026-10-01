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
            task.size = Some(size);
            task.updated_at = now;
            let changed = task.clone();
            if changed.parent_task_id.is_none() && changed.approved_at.is_some() {
                if let Some(plan) = data
                    .runs
                    .get_mut(&changed.run_id)
                    .and_then(|run| run.plan_approval.as_mut())
                {
                    data.tasks.get_mut(task_id).expect("read above").approved_at = None;
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
                        // attempts at the parent task.
                        let parent = task
                            .parent_task_id
                            .as_deref()
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
pub(crate) mod tests {
    use super::*;
    use crate::orchestration::tests::run;

    pub(crate) fn ada() -> TaskAssignee {
        TaskAssignee {
            id: "agent_ada".into(),
            name: "Ada".into(),
        }
    }

    pub(crate) fn assigned(
        store: &OrchestrationStore,
        run: &Run,
        actor: &str,
        who: TaskAssignee,
        parent: Option<String>,
    ) -> Task {
        store
            .create_task_for(
                actor,
                run.id.clone(),
                "Part".into(),
                "Do the part".into(),
                Vec::new(),
                parent,
                None,
                Some(who),
                None,
            )
            .unwrap()
    }

    fn launch(task: &Task) -> WorkerLaunch {
        WorkerLaunch {
            task_id: task.id.clone(),
            agent: ChatAgent::Codex,
            model: None,
            effort: None,
            access: Access::Auto,
            new_worktree: Some(true),
            base_branch: String::new(),
        }
    }

    pub(crate) fn start(store: &OrchestrationStore, actor: &str, task: &Task) -> Attempt {
        let (_, _, attempt, _) = store.reserve_attempt(actor, &launch(task)).unwrap();
        store
            .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
            .unwrap()
    }

    pub(crate) fn settle(store: &OrchestrationStore, attempt: &Attempt, outcome: WorkerOutcome) {
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id.clone(),
                    outcome,
                    summary: "done".into(),
                    files_modified: Vec::new(),
                    verdict: None,
                },
            )
            .unwrap();
    }

    /// A task of Ada's, run once and completed.
    fn finished(store: &OrchestrationStore, run: &Run) -> (Task, Attempt) {
        let task = assigned(store, run, "chat:master", ada(), None);
        let attempt = start(store, "chat:master", &task);
        settle(store, &attempt, WorkerOutcome::Completed);
        (task, attempt)
    }

    fn lead(id: &str) -> Option<(String, String)> {
        Some((id.into(), id.to_uppercase()))
    }

    #[test]
    fn the_curve_starts_at_level_one_and_each_level_costs_a_hundred_more() {
        assert_eq!(level_threshold(1), 0);
        assert_eq!(level_threshold(2), 100);
        assert_eq!(level_threshold(3), 300);
        assert_eq!(level_threshold(4), 600);
        assert_eq!(level_threshold(10), 4500);
        for (xp, level) in [
            (0, 1),
            (99, 1),
            (100, 2),
            (299, 2),
            (300, 3),
            (599, 3),
            (600, 4),
        ] {
            assert_eq!(level_for(xp).level, level, "{xp} XP");
        }
        let progress = level_for(175);
        assert_eq!(
            (progress.level, progress.level_xp, progress.next_level_xp),
            (2, 100, 300)
        );
        // Every step up costs exactly 100 × the level being left.
        for level in 1..50 {
            assert_eq!(
                level_threshold(level + 1) - level_threshold(level),
                LEVEL_STEP * level as u64
            );
        }
        assert_eq!(TaskSize::ALL.map(TaskSize::xp), [25, 75, 150]);
    }

    #[test]
    fn accepting_pays_once_however_often_it_is_accepted() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let (task, attempt) = finished(&store, &run);
        assert_eq!(task.size, Some(TaskSize::Medium), "medium by default");
        let first = store
            .accept_task(AcceptActor::Person, &task.id, &attempt.id)
            .unwrap();
        assert!(first.awarded);
        let award = first.award.clone().unwrap();
        assert_eq!((award.agent_id.as_str(), award.xp), ("agent_ada", 75));
        assert_eq!(award.accepted_by.kind, AcceptorKind::Person);
        assert_eq!(
            first.task.acceptance.as_ref().unwrap().attempt_id,
            attempt.id
        );
        // Again, from the person or the lead: the same award, nothing new.
        let again = store
            .accept_task(AcceptActor::Person, &task.id, &attempt.id)
            .unwrap();
        assert!(!again.awarded);
        assert_eq!(again.award, Some(award));
        let by_lead = store
            .accept_task(
                AcceptActor::Chat {
                    chat_key: "chat:master",
                    lead: lead("agent_lead"),
                },
                &task.id,
                &attempt.id,
            )
            .unwrap();
        assert!(!by_lead.awarded);
        let summary = store.level_summaries().unwrap();
        assert_eq!(summary.len(), 1);
        assert_eq!((summary[0].progress.xp, summary[0].accepted_tasks), (75, 1));
    }

    #[test]
    fn racing_accepts_pay_exactly_once() {
        for _ in 0..10 {
            let store = Arc::new(OrchestrationStore::default());
            let run = run(&store);
            let (task, attempt) = finished(&store, &run);
            let threads: Vec<_> = (0..8)
                .map(|i| {
                    let store = store.clone();
                    let (task_id, attempt_id) = (task.id.clone(), attempt.id.clone());
                    std::thread::spawn(move || {
                        let actor = if i % 2 == 0 {
                            AcceptActor::Chat {
                                chat_key: "chat:master",
                                lead: lead("agent_lead"),
                            }
                        } else {
                            AcceptActor::Person
                        };
                        store
                            .accept_task(actor, &task_id, &attempt_id)
                            .unwrap()
                            .awarded
                    })
                })
                .collect();
            let paid = threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .filter(|awarded| *awarded)
                .count();
            assert_eq!(paid, 1);
            assert_eq!(store.level_profile("agent_ada", 0).unwrap().progress.xp, 75);
        }
    }

    #[test]
    fn only_the_person_or_the_responsible_lead_may_accept() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let (task, attempt) = finished(&store, &run);
        let refuse =
            |actor: AcceptActor<'_>| store.accept_task(actor, &task.id, &attempt.id).unwrap_err();
        // The worker, from its own chat, even claiming to be a lead.
        assert!(refuse(AcceptActor::Chat {
            chat_key: &attempt.worker_chat_key,
            lead: lead("agent_boss"),
        })
        .contains("Only the person"));
        // Some other chat.
        assert!(refuse(AcceptActor::Chat {
            chat_key: "chat:elsewhere",
            lead: lead("agent_boss"),
        })
        .contains("Only the person"));
        // The coordinator chat, but no registered lead behind it.
        assert!(refuse(AcceptActor::Chat {
            chat_key: "chat:master",
            lead: None,
        })
        .contains("registered lead"));
        // The coordinator's lead is the assignee: nobody accepts their own.
        assert!(refuse(AcceptActor::Chat {
            chat_key: "chat:master",
            lead: Some(("agent_ada".into(), "Ada".into())),
        })
        .contains("own work"));
        // A result other than the current one.
        assert!(store
            .accept_task(AcceptActor::Person, &task.id, "attempt_old")
            .unwrap_err()
            .contains("changed since it was reviewed"));
        assert!(store.level_summaries().unwrap().is_empty(), "nothing paid");
        assert!(store.snapshot(None).unwrap().tasks[0].acceptance.is_none());

        let accepted = store
            .accept_task(
                AcceptActor::Chat {
                    chat_key: "chat:master",
                    lead: lead("agent_lead"),
                },
                &task.id,
                &attempt.id,
            )
            .unwrap();
        let by = accepted.award.unwrap().accepted_by;
        assert_eq!(by.kind, AcceptorKind::Lead);
        assert_eq!(by.agent_id.as_deref(), Some("agent_lead"));
    }

    #[test]
    fn unfinished_failed_and_unassigned_tasks_pay_nothing() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let open = assigned(&store, &run, "chat:master", ada(), None);
        let running = start(&store, "chat:master", &open);
        assert!(store
            .accept_task(AcceptActor::Person, &open.id, &running.id)
            .unwrap_err()
            .contains("Only a completed task"));
        settle(&store, &running, WorkerOutcome::Failed);
        assert!(store
            .accept_task(AcceptActor::Person, &open.id, &running.id)
            .unwrap_err()
            .contains("Only a completed task"));

        // An ordinary run's task: accepted, but nobody to pay.
        let plain = crate::orchestration::tests::task(&store, &run, Vec::new());
        let attempt = start(&store, "chat:master", &plain);
        settle(&store, &attempt, WorkerOutcome::Completed);
        let accepted = store
            .accept_task(AcceptActor::Person, &plain.id, &attempt.id)
            .unwrap();
        assert!(!accepted.awarded && accepted.award.is_none());
        assert!(accepted.note.unwrap().contains("No registered agent"));
        assert!(accepted.task.acceptance.is_some());
    }

    #[test]
    fn a_retry_pays_once_for_the_attempt_that_was_accepted() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let task = assigned(&store, &run, "chat:master", ada(), None);
        let first = start(&store, "chat:master", &task);
        settle(&store, &first, WorkerOutcome::Failed);
        let second = start(&store, "chat:master", &task);
        assert_ne!(first.worker_chat_key, second.worker_chat_key);
        settle(&store, &second, WorkerOutcome::Completed);
        assert!(store
            .accept_task(AcceptActor::Person, &task.id, &first.id)
            .is_err());
        let accepted = store
            .accept_task(AcceptActor::Person, &task.id, &second.id)
            .unwrap();
        assert_eq!(accepted.award.unwrap().attempt_id, second.id);
        assert_eq!(
            store.level_profile("agent_ada", 0).unwrap().accepted_tasks,
            1
        );
    }

    #[test]
    fn a_manager_accepts_its_reports_subtask_and_is_never_paid_for_it() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let grace = TaskAssignee {
            id: "agent_grace".into(),
            name: "Grace".into(),
        };
        // Grace manages; she splits her task and gives Ada a part.
        let parent = assigned(&store, &run, "chat:master", grace.clone(), None);
        let managing = start(&store, "chat:master", &parent);
        let child = assigned(
            &store,
            &run,
            &managing.worker_chat_key,
            ada(),
            Some(parent.id.clone()),
        );
        store.set_task_size(&child.id, TaskSize::Large).unwrap();
        settle(&store, &managing, WorkerOutcome::Completed);
        let work = start(&store, "chat:master", &child);
        settle(&store, &work, WorkerOutcome::Completed);

        // From her own (settled) chat, as the manager who split it.
        let accepted = store
            .accept_task(
                AcceptActor::Chat {
                    chat_key: &managing.worker_chat_key,
                    lead: None,
                },
                &child.id,
                &work.id,
            )
            .unwrap();
        let award = accepted.award.unwrap();
        assert_eq!((award.agent_id.as_str(), award.xp), ("agent_ada", 150));
        assert_eq!(award.accepted_by.agent_id.as_deref(), Some("agent_grace"));
        assert_eq!(
            store.level_profile("agent_grace", 0).unwrap().progress.xp,
            0
        );

        // Her own task pays her its own size, and only when accepted itself.
        store
            .accept_task(AcceptActor::Person, &parent.id, &managing.id)
            .unwrap();
        assert_eq!(
            store.level_profile("agent_grace", 0).unwrap().progress.xp,
            75
        );
        assert_eq!(
            store.level_profile("agent_ada", 0).unwrap().progress.xp,
            150
        );

        // Nobody accepts their own task from their own chat.
        let next = assigned(&store, &run, "chat:master", grace, None);
        let again = start(&store, "chat:master", &next);
        settle(&store, &again, WorkerOutcome::Completed);
        assert!(store
            .accept_task(
                AcceptActor::Chat {
                    chat_key: &again.worker_chat_key,
                    lead: None,
                },
                &next.id,
                &again.id,
            )
            .is_err());
    }

    #[test]
    fn the_size_is_chosen_before_the_start_and_locked_after_it() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let task = assigned(&store, &run, "chat:master", ada(), None);
        assert_eq!(
            store.set_task_size(&task.id, TaskSize::Small).unwrap().size,
            Some(TaskSize::Small)
        );
        let attempt = start(&store, "chat:master", &task);
        assert!(store
            .set_task_size(&task.id, TaskSize::Large)
            .unwrap_err()
            .contains("locked"));
        settle(&store, &attempt, WorkerOutcome::Failed);
        // Still locked after a failure: a retry is the same task.
        assert!(store.set_task_size(&task.id, TaskSize::Large).is_err());
        let retry = start(&store, "chat:master", &task);
        settle(&store, &retry, WorkerOutcome::Completed);
        let paid = store
            .accept_task(AcceptActor::Person, &task.id, &retry.id)
            .unwrap();
        assert_eq!(paid.award.unwrap().xp, 25);
    }

    #[test]
    fn a_task_from_before_sizes_existed_pays_only_if_it_had_not_started() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let legacy = assigned(&store, &run, "chat:master", ada(), None);
        let unstarted = assigned(&store, &run, "chat:master", ada(), None);
        // As a store written by an older build reads: no size on either, and
        // the legacy one already had an attempt when the upgrade came.
        let early = start(&store, "chat:master", &legacy);
        store
            .mutate(|data| {
                for id in [&legacy.id, &unstarted.id] {
                    data.tasks.get_mut(id.as_str()).unwrap().size = None;
                }
                Ok(())
            })
            .unwrap();
        settle(&store, &early, WorkerOutcome::Completed);
        let accepted = store
            .accept_task(AcceptActor::Person, &legacy.id, &early.id)
            .unwrap();
        assert!(!accepted.awarded);
        assert!(accepted.note.unwrap().contains("before sizes"));
        let profile = store.level_profile("agent_ada", 0).unwrap();
        assert!(profile.awaiting.is_empty(), "it was accepted");

        // One that had not started takes the default at its first attempt.
        let later = start(&store, "chat:master", &unstarted);
        settle(&store, &later, WorkerOutcome::Completed);
        let paid = store
            .accept_task(AcceptActor::Person, &unstarted.id, &later.id)
            .unwrap();
        assert_eq!(paid.award.unwrap().size, TaskSize::Medium);
    }

    #[test]
    fn the_ledger_survives_a_restart_and_follows_the_id_through_a_rename() {
        let root = std::env::temp_dir().join(format!("octiq-levels-{}", compact_id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("orchestrations.json");
        let store = OrchestrationStore::load(file.clone());
        let since = store.level_profile("agent_ada", 0).unwrap().scoring_since;
        assert!(since > 0, "scoring starts when the store first loads");
        let run = run(&store);
        let (task, attempt) = finished(&store, &run);
        store
            .accept_task(AcceptActor::Person, &task.id, &attempt.id)
            .unwrap();
        // Renamed since: same id, same ledger.
        let renamed = TaskAssignee {
            id: "agent_ada".into(),
            name: "Ada Lovelace".into(),
        };
        let second = assigned(&store, &run, "chat:master", renamed, None);
        store.set_task_size(&second.id, TaskSize::Large).unwrap();
        let attempt = start(&store, "chat:master", &second);
        settle(&store, &attempt, WorkerOutcome::Completed);
        store
            .accept_task(AcceptActor::Person, &second.id, &attempt.id)
            .unwrap();
        drop(store);

        let reloaded = OrchestrationStore::load(file);
        let profile = reloaded.level_profile("agent_ada", 0).unwrap();
        assert_eq!(profile.progress.xp, 225);
        assert_eq!(profile.progress.level, 2);
        assert_eq!(profile.accepted_tasks, 2);
        assert_eq!(profile.scoring_since, since, "stamped once");
        // Newest first, each linked to its run's main chat.
        assert_eq!(profile.history[0].record.task_id, second.id);
        assert_eq!(
            profile.history[0].record.agent_name.as_deref(),
            Some("Ada Lovelace")
        );
        assert_eq!(profile.history[1].record.agent_name.as_deref(), Some("Ada"));
        assert_eq!(
            profile.history[0].coordinator_chat_key.as_deref(),
            Some("chat:master")
        );
        // Accepted again after the restart: still paid once.
        let first_attempt = profile.history[1].record.attempt_id.clone();
        assert!(
            !reloaded
                .accept_task(AcceptActor::Person, &task.id, &first_attempt)
                .unwrap()
                .awarded
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn history_pages_and_awaiting_work_are_listed() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        for _ in 0..(HISTORY_PAGE + 3) {
            let (task, attempt) = finished(&store, &run);
            store
                .accept_task(AcceptActor::Person, &task.id, &attempt.id)
                .unwrap();
        }
        let (waiting, _) = finished(&store, &run);
        let first = store.level_profile("agent_ada", 0).unwrap();
        assert_eq!(first.history.len(), HISTORY_PAGE);
        assert_eq!(first.history_total, HISTORY_PAGE + 3);
        let rest = store.level_profile("agent_ada", HISTORY_PAGE).unwrap();
        assert_eq!(rest.history.len(), 3);
        assert_eq!(first.awaiting.len(), 1);
        assert_eq!(first.awaiting[0].task_id, waiting.id);
        assert!(!first.awaiting[0].unscored);
        assert_eq!(first.rules.level_step, 100);
    }

    #[test]
    fn resizing_an_approved_task_puts_the_plan_back_before_any_worker_starts() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        store.require_plan_approval(&run.id).unwrap();
        let task = assigned(&store, &run, "chat:master", ada(), None);
        let plan = |store: &OrchestrationStore| {
            store.snapshot(Some(&run.id)).unwrap().runs[0]
                .plan_approval
                .clone()
                .unwrap()
        };
        store
            .approve_plan(
                "chat:master",
                &run.id,
                Some(&[task.id.clone()]),
                Some(plan(&store).revision),
            )
            .unwrap();
        // The same size again changes nothing.
        store.set_task_size(&task.id, TaskSize::Medium).unwrap();
        assert_eq!(plan(&store).status, PlanStatus::Approved);

        let resized = store.set_task_size(&task.id, TaskSize::Large).unwrap();
        assert!(resized.approved_at.is_none(), "the new size is unapproved");
        assert_eq!(plan(&store).status, PlanStatus::Pending);
        assert!(store
            .reserve_attempt("chat:master", &launch(&task))
            .is_err());
        // Approving the new revision covers the new size, and work may start.
        store
            .approve_plan(
                "chat:master",
                &run.id,
                Some(&[task.id.clone()]),
                Some(plan(&store).revision),
            )
            .unwrap();
        let attempt = start(&store, "chat:master", &task);
        settle(&store, &attempt, WorkerOutcome::Completed);
        let paid = store
            .accept_task(AcceptActor::Person, &task.id, &attempt.id)
            .unwrap();
        assert_eq!(paid.award.unwrap().xp, 150);
    }

    #[test]
    fn xp_goes_to_the_agent_the_accepted_attempt_ran_as() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let task = assigned(&store, &run, "chat:master", ada(), None);
        let attempt = start(&store, "chat:master", &task);
        assert_eq!(
            attempt.assignee.as_ref().map(|a| a.id.as_str()),
            Some("agent_ada")
        );
        settle(&store, &attempt, WorkerOutcome::Completed);
        // Whatever the task says later, the attempt's record decides.
        store
            .mutate(|data| {
                data.tasks.get_mut(&task.id).unwrap().assignee = Some(TaskAssignee {
                    id: "agent_lead".into(),
                    name: "Lead".into(),
                });
                Ok(())
            })
            .unwrap();
        // The coordinator's lead is the agent that ran it? Refused either way.
        assert!(store
            .accept_task(
                AcceptActor::Chat {
                    chat_key: "chat:master",
                    lead: Some(("agent_ada".into(), "Ada".into())),
                },
                &task.id,
                &attempt.id,
            )
            .unwrap_err()
            .contains("own work"));
        let paid = store
            .accept_task(AcceptActor::Person, &task.id, &attempt.id)
            .unwrap();
        assert_eq!(paid.award.unwrap().agent_id, "agent_ada");
        assert_eq!(store.level_profile("agent_lead", 0).unwrap().progress.xp, 0);
    }

    #[test]
    fn a_waiting_plan_moves_its_revision_when_a_size_changes() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        store.require_plan_approval(&run.id).unwrap();
        let task = assigned(&store, &run, "chat:master", ada(), None);
        let revision = |store: &OrchestrationStore| {
            store.snapshot(Some(&run.id)).unwrap().runs[0]
                .plan_approval
                .as_ref()
                .unwrap()
                .revision
        };
        let before = revision(&store);
        store
            .revise_task(
                "chat:master",
                &task.id,
                TaskRevision {
                    size: Some(TaskSize::Large),
                    ..TaskRevision::default()
                },
            )
            .unwrap();
        assert_eq!(revision(&store), before + 1);
        store.set_task_size(&task.id, TaskSize::Small).unwrap();
        assert_eq!(revision(&store), before + 2);
    }

    /// What `reopen_task` does to the task itself, without the retained
    /// workspace it also insists on.
    fn reopen(store: &OrchestrationStore, task: &Task) {
        store
            .mutate(|data| {
                let task = data.tasks.get_mut(&task.id).unwrap();
                task.status = TaskStatus::Ready;
                task.result = None;
                let run_id = task.run_id.clone();
                recompute_run(data, &run_id);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn an_unscored_acceptance_counts_and_keeps_its_record_through_a_reopen() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        // A task from before sizes: started with none recorded.
        let legacy = assigned(&store, &run, "chat:master", ada(), None);
        let first = start(&store, "chat:master", &legacy);
        store
            .mutate(|data| {
                data.tasks.get_mut(&legacy.id).unwrap().size = None;
                Ok(())
            })
            .unwrap();
        settle(&store, &first, WorkerOutcome::Completed);
        let accepted = store
            .accept_task(AcceptActor::Person, &legacy.id, &first.id)
            .unwrap();
        assert!(!accepted.awarded);

        let profile = store.level_profile("agent_ada", 0).unwrap();
        assert_eq!(
            profile.accepted_tasks, 1,
            "accepted, though it paid nothing"
        );
        assert_eq!(profile.progress.xp, 0);
        assert_eq!(profile.history_total, 1);
        let original = profile.history[0].record.clone();
        assert_eq!(
            (original.attempt_id.as_str(), original.xp, original.unpaid),
            (first.id.as_str(), 0, Some(Unpaid::Unsized))
        );
        assert_eq!(original.accepted_by.kind, AcceptorKind::Person);
        assert_eq!(original.agent_id.as_deref(), Some("agent_ada"));
        let summary = store.level_summaries().unwrap();
        assert_eq!(
            (
                summary.len(),
                summary[0].accepted_tasks,
                summary[0].progress.xp
            ),
            (1, 1, 0),
            "the roster agrees with the profile"
        );

        // Reopened, redone, accepted again by the lead.
        reopen(&store, &legacy);
        let second = start(&store, "chat:master", &legacy);
        settle(&store, &second, WorkerOutcome::Completed);
        let again = store
            .accept_task(
                AcceptActor::Chat {
                    chat_key: "chat:master",
                    lead: lead("agent_lead"),
                },
                &legacy.id,
                &second.id,
            )
            .unwrap();
        assert!(!again.awarded, "still unsized, still nothing");
        assert_eq!(again.task.acceptance.unwrap().attempt_id, second.id);

        let profile = store.level_profile("agent_ada", 0).unwrap();
        assert_eq!(profile.accepted_tasks, 1, "one task, counted once");
        assert_eq!(profile.progress.xp, 0);
        assert_eq!(profile.history_total, 2, "both acceptances are on record");
        let newest = &profile.history[0].record;
        assert_eq!(newest.attempt_id, second.id);
        assert_eq!(newest.accepted_by.agent_id.as_deref(), Some("agent_lead"));
        assert_eq!(
            profile.history[1].record, original,
            "the first is untouched"
        );

        // Accepting the current result once more writes nothing new.
        store
            .accept_task(AcceptActor::Person, &legacy.id, &second.id)
            .unwrap();
        assert_eq!(
            store.level_profile("agent_ada", 0).unwrap().history_total,
            2
        );
    }

    #[test]
    fn a_paid_task_reaccepted_after_a_reopen_keeps_both_records_and_pays_once() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let (task, first) = finished(&store, &run);
        store
            .accept_task(AcceptActor::Person, &task.id, &first.id)
            .unwrap();
        reopen(&store, &task);
        let second = start(&store, "chat:master", &task);
        settle(&store, &second, WorkerOutcome::Completed);
        let again = store
            .accept_task(AcceptActor::Person, &task.id, &second.id)
            .unwrap();
        assert!(!again.awarded);
        assert_eq!(
            again.award.unwrap().attempt_id,
            first.id,
            "the award stands"
        );

        let profile = store.level_profile("agent_ada", 0).unwrap();
        assert_eq!((profile.accepted_tasks, profile.progress.xp), (1, 75));
        let records: Vec<_> = profile
            .history
            .iter()
            .map(|entry| {
                (
                    entry.record.attempt_id.clone(),
                    entry.record.xp,
                    entry.record.unpaid,
                )
            })
            .collect();
        assert_eq!(
            records,
            vec![
                (second.id.clone(), 0, Some(Unpaid::AlreadyPaid)),
                (first.id.clone(), 75, None),
            ]
        );
    }

    #[test]
    fn a_store_from_before_the_ledger_gets_its_acceptances_back_once() {
        let root = std::env::temp_dir().join(format!("octiq-ledger-{}", compact_id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("orchestrations.json");
        let store = OrchestrationStore::load(file.clone());
        let run = run(&store);
        let (paid, paid_attempt) = finished(&store, &run);
        store
            .accept_task(AcceptActor::Person, &paid.id, &paid_attempt.id)
            .unwrap();
        let legacy = assigned(&store, &run, "chat:master", ada(), None);
        let early = start(&store, "chat:master", &legacy);
        store
            .mutate(|data| {
                data.tasks.get_mut(&legacy.id).unwrap().size = None;
                Ok(())
            })
            .unwrap();
        settle(&store, &early, WorkerOutcome::Completed);
        store
            .accept_task(AcceptActor::Person, &legacy.id, &early.id)
            .unwrap();
        drop(store);

        // As the earlier build wrote it: awards and task acceptances, no ledger.
        let mut raw: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        raw.as_object_mut().unwrap().remove("acceptances");
        fs::write(&file, serde_json::to_vec(&raw).unwrap()).unwrap();

        let reloaded = OrchestrationStore::load(file.clone());
        let profile = reloaded.level_profile("agent_ada", 0).unwrap();
        assert_eq!((profile.accepted_tasks, profile.progress.xp), (2, 75));
        let mut unpaid: Vec<_> = profile
            .history
            .iter()
            .map(|e| (e.record.xp, e.record.unpaid))
            .collect();
        unpaid.sort_by_key(|(xp, _)| *xp);
        assert_eq!(unpaid, vec![(0, Some(Unpaid::Unsized)), (75, None)]);
        drop(reloaded);
        // Loading again adds nothing.
        let again = OrchestrationStore::load(file);
        assert_eq!(
            again.level_profile("agent_ada", 0).unwrap().history_total,
            2
        );
        let _ = fs::remove_dir_all(root);
    }
}

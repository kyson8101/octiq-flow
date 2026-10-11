//! What the person's approval of a task fixes, and the one comparison every
//! start is held to (the person's decision of 2026-10-11).
//!
//! `approved_at` says THAT a task was approved. It does not say as what: a
//! start used to write whatever it was asked for over `task.worker`, and the
//! run's defaults are the coordinator's to change at any time, so an approved
//! Manual task could be started with Full access and stay "approved". The
//! record here is the missing half. It is taken when the plan is approved,
//! from the values in EFFECT then (a task with no worker of its own takes the
//! run's defaults as they were), and is never written again by a start, a
//! retry, a recovery or `configure_automation`.
//!
//! What it fixes, and nothing else:
//!
//! - the worker: provider, model, effort, access, and the recovery policy
//!   with its fallback model;
//! - the assignee, the registered agent the task was handed to;
//! - the destination, a project and a repository;
//! - the base branch the host planned its workspace from.
//!
//! The words a task carries are not part of it. `reopen_task` gives an
//! approved task new instructions and keeps the approval; this record is what
//! that reopened task still cannot change.

use super::*;

/// How a task's shape came to be fixed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixedBy {
    /// The person approved the plan that showed it.
    Plan,
    /// Its manager split it off an approved task (`create_task_full`): it
    /// goes by its parent's approval, with the worker the host routed it to.
    Split,
    /// Approved before this record existed. Taken from the ledger as it
    /// stood on the first write after: the task's own worker as its last
    /// start left it, else the run's defaults of that moment.
    Ledger,
}

/// See the module's own words.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approved {
    /// Absent only when no worker was chosen at all: the task named none and
    /// its run had no defaults, which a run outside agents mode allows. The
    /// first start then chooses, as it always did there, and fixes it here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<automation::WorkerSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<TaskAssignee>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<TaskDestination>,
    /// The base of the workspace the host planned (`WorkspaceProposal`).
    /// Absent when nothing was planned, or the task works in place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    pub by: FixedBy,
    pub at: i64,
}

/// The worker `task` would get from a start that asks for nothing of its
/// own: its own settings, else the run's defaults, with the recovery policy
/// `reserve_attempt_for` would give it. A peer request takes nothing from the
/// run's defaults.
fn in_effect(
    defaults: Option<&automation::WorkerDefaults>,
    task: &Task,
) -> Option<automation::WorkerSettings> {
    let defaults = defaults.filter(|_| task.peer_request.is_none());
    let mut worker = task.worker.clone().or_else(|| {
        let defaults = defaults?;
        Some(automation::WorkerSettings {
            agent: defaults.agent?,
            access: defaults.access,
            model: defaults.model.clone(),
            effort: defaults.effort.clone(),
            recovery: None,
        })
    })?;
    if worker.recovery.is_none() {
        if let Some(mut policy) = defaults.and_then(|d| d.recovery.clone()) {
            // A fallback model belongs to the provider it was chosen for.
            if defaults
                .and_then(|d| d.agent)
                .is_some_and(|agent| agent != worker.agent)
            {
                policy.fallback_model = None;
            }
            worker.recovery = Some(policy);
        }
    }
    worker.effort = effort(worker.effort.as_deref());
    worker.normalized().ok()
}

fn effort(effort: Option<&str>) -> Option<String> {
    effort
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
        .map(str::to_owned)
}

impl Approved {
    /// The shape `task` has now, as an approval of this moment fixes it.
    pub(super) fn of(
        defaults: Option<&automation::WorkerDefaults>,
        task: &Task,
        by: FixedBy,
        at: i64,
    ) -> Self {
        Self {
            worker: in_effect(defaults, task),
            assignee: task.assignee.clone(),
            destination: task.destination.clone(),
            base_branch: task
                .workspace_proposal
                .as_ref()
                .and_then(|proposal| proposal.plan.as_ref())
                .map(|plan| plan.base_branch.clone())
                .filter(|base| !base.is_empty()),
            by,
            at,
        }
    }
}

fn worker_words(worker: &automation::WorkerSettings) -> String {
    format!(
        "{}{} at {} access",
        model_id(worker.agent, worker.model.as_deref()),
        worker
            .effort
            .as_deref()
            .map(|effort| format!(" ({effort} effort)"))
            .unwrap_or_default(),
        access_id(worker.access),
    )
}

fn who(assignee: Option<&TaskAssignee>) -> &str {
    assignee.map_or("no registered agent", |a| a.name.as_str())
}

fn place(destination: Option<&TaskDestination>) -> String {
    destination.map_or_else(
        || "the run's own folder".into(),
        |d| format!("{} ({})", d.project_name, d.repository),
    )
}

/// Refuse a start that asks for anything the approval did not fix, in words
/// that name each difference. `asked` is the launch, normalized.
///
/// One model besides the approved one passes: the fallback the approved
/// recovery policy names, which the person approved with it. The host's
/// recovery asks for it after a capacity failure, and a retry of that
/// attempt, by the coordinator or from the page, asks for it again.
///
/// A start that names no base branch asks for the planned one. The assignee
/// and the destination are the task's own: no start names them, and nothing
/// changes them on an approved task without sending it back to the plan
/// card, so a difference there is a ledger that was edited some other way.
pub(super) fn keeps_to(
    approved: &Approved,
    task: &Task,
    asked: &automation::WorkerSettings,
    base_branch: &str,
) -> Result<(), String> {
    let mut differs: Vec<String> = Vec::new();
    if let Some(worker) = &approved.worker {
        let fallback = worker
            .recovery
            .as_ref()
            .and_then(|policy| policy.fallback_model.as_deref());
        let approved_model = asked.model == worker.model
            || fallback.is_some_and(|model| asked.model.as_deref() == Some(model));
        if asked.agent != worker.agent || !approved_model {
            differs.push(format!(
                "the worker {} instead of {}{}",
                model_id(asked.agent, asked.model.as_deref()),
                model_id(worker.agent, worker.model.as_deref()),
                fallback
                    .map(|model| format!(" (or its approved fallback {model})"))
                    .unwrap_or_default(),
            ));
        }
        let asked_effort = effort(asked.effort.as_deref());
        if asked_effort != worker.effort {
            let said = |effort: &Option<String>| effort.clone().unwrap_or_else(|| "none".into());
            differs.push(format!(
                "{} effort instead of {}",
                said(&asked_effort),
                said(&worker.effort)
            ));
        }
        if asked.access != worker.access {
            differs.push(format!(
                "{} access instead of {}",
                access_id(asked.access),
                access_id(worker.access)
            ));
        }
    }
    if task.assignee.as_ref().map(|a| &a.id) != approved.assignee.as_ref().map(|a| &a.id) {
        differs.push(format!(
            "{} instead of {}",
            who(task.assignee.as_ref()),
            who(approved.assignee.as_ref())
        ));
    }
    if task.destination != approved.destination {
        differs.push(format!(
            "{} instead of {}",
            place(task.destination.as_ref()),
            place(approved.destination.as_ref())
        ));
    }
    if !base_branch.is_empty() && approved.base_branch.as_deref() != Some(base_branch) {
        differs.push(format!(
            "the base branch {base_branch} instead of {}",
            approved
                .base_branch
                .as_deref()
                .unwrap_or("the one the host plans")
        ));
    }
    if differs.is_empty() {
        return Ok(());
    }
    let as_approved = match &approved.worker {
        Some(worker) => format!(
            "{} for {} in {}",
            worker_words(worker),
            who(approved.assignee.as_ref()),
            place(approved.destination.as_ref())
        ),
        None => format!(
            "{} in {}",
            who(approved.assignee.as_ref()),
            place(approved.destination.as_ref())
        ),
    };
    Err(format!(
        "The person approved this task as {as_approved}. This start asks for {}. Nothing was started. Start it as approved; a change to what a task runs as goes back to the person on the plan card (orchestration_task_reassign, or a new task).",
        differs.join(", and "),
    ))
}

/// The settings a host dispatch, or anything else that asks "what does this
/// task run as", uses for a task whose shape is fixed.
pub(super) fn worker_of(task: &Task) -> Option<&automation::WorkerSettings> {
    task.approved.as_ref()?.worker.as_ref()
}

/// Give every approved task of a ledger written before this record existed
/// the shape it has now. Run before each write, like the approval backfill:
/// a task approved by that same pass is covered in it. `true` when anything
/// was written.
pub(super) fn backfill(data: &mut Stored) -> bool {
    let now = now_ms();
    let mut changed = false;
    let Stored { runs, tasks, .. } = data;
    for task in tasks.values_mut() {
        if task.approved.is_some() || task.approved_at.is_none() {
            continue;
        }
        let defaults = runs
            .get(&task.run_id)
            .and_then(|run| run.worker_defaults.as_ref());
        task.approved = Some(Approved::of(defaults, task, FixedBy::Ledger, now));
        changed = true;
    }
    changed
}

//! Agent lanes and host-owned batches. Queuing never reserves an attempt.
use super::*;
use crate::git_ops::workflow::WorkspacePlan;
use crate::scheduling::{Orientation, Settings};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BatchStatus {
    Claiming,
    Working,
    Settled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub agent_id: String,
    pub run_id: String,
    pub repository: String,
    pub base_branch: String,
    pub branch: String,
    pub worktree: String,
    pub task_ids: Vec<String>,
    pub status: BatchStatus,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) enum QueueBy {
    Coordinator,
    Person { retry_of: Option<String> },
    Recovery(String),
}
impl QueueBy {
    fn borrowed(&self) -> StartedBy<'_> {
        match self {
            Self::Coordinator => StartedBy::Coordinator,
            Self::Person { retry_of } => StartedBy::Page {
                retry_of: retry_of.as_deref(),
            },
            Self::Recovery(id) => StartedBy::Recovery(id),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Queued {
    pub launch: WorkerLaunch,
    by: QueueBy,
    pub at: i64,
}
impl Queued {
    pub(super) fn new(launch: &WorkerLaunch, by: StartedBy, at: i64) -> Self {
        Self {
            launch: launch.clone(),
            at,
            by: match by {
                StartedBy::Coordinator => QueueBy::Coordinator,
                StartedBy::Page { retry_of } => QueueBy::Person {
                    retry_of: retry_of.map(str::to_owned),
                },
                StartedBy::Recovery(id) => QueueBy::Recovery(id.into()),
            },
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct BatchLaunch {
    pub worker_chat_key: String,
    pub head: String,
    pub candidates: Vec<String>,
    pub plan: WorkspacePlan,
    pub launch: WorkerLaunch,
    #[serde(default)]
    pub destination: Option<TaskDestination>,
    pub started: bool,
    /// In-memory spawn barrier: a concurrent Stop/reaper cannot release the
    /// lease while chat_start is still capable of creating this process.
    #[serde(skip)]
    pub launching: bool,
}

pub(super) fn occupies_worker(data: &Stored, batch: &Batch) -> bool {
    batch.status != BatchStatus::Settled
        || data
            .batch_launches
            .get(&batch.id)
            .is_some_and(|l| l.started || l.launching)
}

pub(super) fn agent_workspace(task: &Task) -> bool {
    task.approved
        .as_ref()
        .and_then(|a| a.workspace_mode)
        .or_else(|| task.workspace.as_ref().map(|w| w.plan.mode))
        .or_else(|| {
            task.workspace_proposal
                .as_ref()
                .and_then(|p| p.plan.as_ref())
                .map(|p| p.mode)
        })
        == Some(WorkspaceMode::Agent)
}

/// The same handoff door covers the pre-attempt claim and the working batch.
pub(super) fn require_no_batch(data: &Stored, task_id: &str) -> Result<(), String> {
    if let Some(batch) = data.batches.iter().find(|batch| {
        batch.status != BatchStatus::Settled && batch.task_ids.iter().any(|id| id == task_id)
    }) {
        return Err(format!("This task belongs to {} batch {}. Stop or settle that batch before handing its task to another agent.",
            if batch.status == BatchStatus::Claiming { "a claiming" } else { "a working" }, batch.id));
    }
    Ok(())
}

/// Compare the process that already owns this capability with CURRENT approval,
/// rather than comparing a reassigned task with itself at reservation time.
fn keeps_to_batch(
    data: &Stored,
    batch: &Batch,
    runtime: &BatchLaunch,
    task: &Task,
) -> Result<(), String> {
    let approved = task
        .approved
        .as_ref()
        .ok_or("The batch task no longer has an approved allocation.")?;
    let worker = automation::WorkerSettings {
        agent: runtime.launch.agent,
        model: runtime.launch.model.clone(),
        effort: runtime.launch.effort.clone(),
        access: runtime.launch.access,
        recovery: None,
    }
    .normalized()?;
    let mut running = task.clone();
    running.assignee = Some(TaskAssignee {
        id: batch.agent_id.clone(),
        name: batch.agent_id.clone(),
    });
    running.destination = runtime.destination.clone();
    approval::keeps_to(
        approved,
        &running,
        &worker,
        &runtime.plan.base_branch,
        runtime.plan.mode,
    )?;
    let plan = task
        .workspace
        .as_ref()
        .map(|w| &w.plan)
        .or_else(|| {
            task.workspace_proposal
                .as_ref()
                .and_then(|p| p.plan.as_ref())
        })
        .ok_or("The batch task no longer has an approved workspace plan.")?;
    // Agent proposals reserve a path, base and mode; their pending branch is
    // replaced by this host-owned batch branch. Retries retain their original.
    let branch = if plan.mode == WorkspaceMode::Agent {
        original(data, task).map_or(batch.branch.as_str(), |b| b.branch.as_str())
    } else {
        plan.branch.as_str()
    };
    if task.run_id != batch.run_id
        || task.assignee.as_ref().map(|a| a.id.as_str()) != Some(batch.agent_id.as_str())
        || task.destination != runtime.destination
        || plan.mode != runtime.plan.mode
        || plan.repository_root != runtime.plan.repository_root
        || plan.checkout_root != runtime.plan.checkout_root
        || plan.cwd != runtime.plan.cwd
        || plan.base_branch != runtime.plan.base_branch
        || branch != runtime.plan.branch
        || batch.branch != runtime.plan.branch
        || batch.repository != runtime.plan.repository_root
        || batch.worktree != runtime.plan.checkout_root
    {
        return Err("The batch runtime no longer matches this task's approved agent, destination or workspace plan. The task stays queued; nothing was started.".into());
    }
    Ok(())
}

pub(super) fn eligible(data: &Stored, task: &Task) -> bool {
    let Some(run) = data.runs.get(&task.run_id) else {
        return false;
    };
    task.assignee
        .as_ref()
        .is_some_and(|a| !data.removed_agents.contains_key(&a.id))
        && (task.status == TaskStatus::Ready
            || (data.agent_queue.contains_key(&task.id)
                && matches!(task.status, TaskStatus::Failed | TaskStatus::Blocked)))
        && !matches!(
            run.status,
            RunStatus::Stopped | RunStatus::Closed | RunStatus::Completed
        )
        && run.archived_at.is_none()
        && task.superseded_by.is_none()
        && task.stopped.is_none()
        && held_by_plan(run, task, &|id| data.tasks.get(id)).is_none()
        && workspaces::untold_reopen(task).is_none()
        && !data.gates.values().any(|g| {
            g.run_id == run.id
                && g.status == GateStatus::Open
                && (g.holds_run() || g.task_id.as_deref() == Some(&task.id))
        })
        && task
            .depends_on
            .iter()
            .all(|id| data.tasks.get(id).is_some_and(releases_dependants))
        && !data
            .attempts
            .values()
            .any(|a| a.task_id == task.id && attempt_is_unsettled(data, a))
}

pub(super) fn enqueue(data: &mut Stored, entry: Queued) -> Result<(), String> {
    let id = entry.launch.task_id.clone();
    if matches!(entry.by, QueueBy::Person { .. }) {
        // This Start clears the earlier Stop. A later Stop is a new hold and
        // cannot be bypassed by an old queued person's request.
        if let Some(task) = data.tasks.get_mut(&id) {
            task.stopped = None;
        }
    }
    // A second host/coordinator start must not replace a person's Start.
    match data.agent_queue.get_mut(&id) {
        Some(old) if matches!(entry.by, QueueBy::Person { .. }) => {
            old.by = entry.by;
            old.launch = entry.launch;
        }
        Some(_) => {}
        None => {
            data.agent_queue.insert(id, entry);
        }
    }
    Ok(())
}

pub(super) fn queue<'a>(data: &'a Stored, agent: &str) -> Vec<&'a Task> {
    let mut tasks: Vec<_> = data
        .tasks
        .values()
        .filter(|t| {
            eligible(data, t)
                && t.assignee.as_ref().is_some_and(|a| a.id == agent)
                && data.agent_queue.contains_key(&t.id)
        })
        .collect();
    tasks.sort_by_key(|t| {
        (
            data.agent_queue
                .get(&t.id)
                .map_or(t.approved_at.unwrap_or(t.created_at), |q| q.at),
            t.created_at,
            t.id.clone(),
        )
    });
    tasks
}

fn original<'a>(data: &'a Stored, task: &Task) -> Option<&'a Batch> {
    data.attempts
        .values()
        .filter(|a| a.task_id == task.id && a.batch_id.is_some())
        .min_by_key(|a| a.number)
        .and_then(|a| a.batch_id.as_ref())
        .and_then(|id| data.batches.iter().find(|b| &b.id == id))
}

fn compatible(data: &Stored, head: &Task, candidate: &Task) -> bool {
    let Some(run) = data.runs.get(&head.run_id) else {
        return false;
    };
    let base = |t: &Task| {
        t.approved
            .as_ref()
            .and_then(|a| a.base_branch.clone())
            .or_else(|| {
                t.workspace_proposal
                    .as_ref()
                    .and_then(|p| p.plan.as_ref())
                    .map(|p| p.base_branch.clone())
            })
    };
    let mode = |t: &Task| {
        t.approved
            .as_ref()
            .and_then(|a| a.workspace_mode)
            .or_else(|| {
                t.workspace_proposal
                    .as_ref()
                    .and_then(|p| p.plan.as_ref())
                    .map(|p| p.mode)
            })
    };
    head.peer_request.is_none()
        && candidate.peer_request.is_none()
        && head.run_id == candidate.run_id
        && head.assignee.as_ref().map(|a| &a.id) == candidate.assignee.as_ref().map(|a| &a.id)
        && head
            .workspace_proposal
            .as_ref()
            .and_then(|p| p.plan.as_ref())
            .map(|p| &p.repository_root)
            == candidate
                .workspace_proposal
                .as_ref()
                .and_then(|p| p.plan.as_ref())
                .map(|p| &p.repository_root)
        && base(head) == base(candidate)
        && mode(head) == Some(WorkspaceMode::Agent)
        && mode(candidate) == Some(WorkspaceMode::Agent)
        && automation::settings_for_task(run, head).ok().flatten()
            == automation::settings_for_task(run, candidate).ok().flatten()
        && original(data, head).is_none_or(|b| b.task_ids.contains(&candidate.id))
        && original(data, candidate).map(|b| &b.id) == original(data, head).map(|b| &b.id)
}

pub(super) fn lanes(data: &Stored, only: Option<&BTreeSet<String>>) -> Vec<serde_json::Value> {
    let agents: BTreeSet<_> = data
        .tasks
        .values()
        .filter_map(|t| t.assignee.as_ref().map(|a| a.id.clone()))
        .chain(data.batches.iter().map(|b| b.agent_id.clone()))
        .chain(data.agent_blocks.keys().cloned())
        .filter(|id| {
            !data.removed_agents.contains_key(id) && only.is_none_or(|ids| ids.contains(id))
        })
        .collect();
    agents.into_iter().filter_map(|id| {
        let queued = queue(data, &id).len();
        let batch = data.batches.iter().find(|b| b.agent_id == id && occupies_worker(data, b));
        let block = data.agent_blocks.get(&id);
        if queued == 0 && batch.is_none() && block.is_none() { return None; }
        let mut lane = json!({ "agentId": id, "state": if block.is_some() { "blocked" } else if batch.is_some() { "working" } else { "idle" }, "queued": queued });
        if let Some(b) = batch { lane["batch"] = json!({ "id": b.id, "runId": b.run_id, "branch": b.branch, "taskIds": b.task_ids }); }
        if let Some(reason) = block { lane["blockedReason"] = json!(reason); }
        Some(lane)
    }).collect()
}

pub(super) fn interrupt_peers(data: &mut Stored, stopped: &Attempt, now: i64) {
    let Some(batch_id) = &stopped.batch_id else {
        return;
    };
    let peer_ids: Vec<_> = data
        .attempts
        .values()
        .filter(|a| {
            a.id != stopped.id
                && a.batch_id.as_ref() == Some(batch_id)
                && attempt_is_unsettled(data, a)
        })
        .map(|a| a.id.clone())
        .collect();
    let mut titles = Vec::new();
    for id in peer_ids {
        let attempt = data.attempts.get_mut(&id).unwrap();
        attempt.status = AttemptStatus::Cancelled;
        attempt.execution.state = execution::ExecutionState::Cancelled;
        attempt.execution.next_retry_at = None;
        attempt.finished_at.get_or_insert(now);
        attempt.updated_at = now;
        let task = data.tasks.get_mut(&attempt.task_id).unwrap();
        task.status = TaskStatus::Ready;
        task.result = None;
        task.updated_at = now;
        if let Some(ws) = &mut task.workspace {
            ws.state = workspaces::WorkspaceState::Retained;
            ws.lease_attempt_id = None;
        }
        titles.push(task.title.clone());
        let task_id = task.id.clone();
        for gate in data
            .gates
            .values_mut()
            .filter(|g| g.task_id.as_deref() == Some(&task_id) && g.status == GateStatus::Open)
        {
            gate.close(GateStatus::Cancelled, now);
        }
        // These tasks were interrupted by the shared process stopping, not
        // failures to retry. The next real reservation uses no extra retry.
        data.agent_queue.remove(&task_id);
    }
    if !titles.is_empty() {
        if let Some(run) = data.runs.get(&stopped.run_id).cloned() {
            inbox::enqueue(data, &run.id, "host", &run.coordinator_chat_key,
                format!("batch-interrupted:{batch_id}:{}", stopped.id), "status",
                format!("The person stopped one task in batch {batch_id}, which stops its shared worker process. These other tasks returned to the queue without using another retry: {}. Existing work is retained; a dirty worktree blocks the next batch.", titles.join(", ")));
        }
    }
}

impl OrchestrationStore {
    pub(super) fn sync_agent_queue(&self) -> Result<(), String> {
        let orientation = crate::scheduling::load()?.orientation;
        {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            if !inner.data.tasks.values().any(|t| {
                eligible(&inner.data, t)
                    && (orientation == Orientation::Agents || agent_workspace(t))
                    && t.status == TaskStatus::Ready
                    && !inner.data.agent_queue.contains_key(&t.id)
            }) {
                return Ok(());
            }
        }
        self.mutate(|data| {
            let tasks: Vec<_> = data
                .tasks
                .values()
                .filter(|t| {
                    eligible(data, t)
                        && (orientation == Orientation::Agents || agent_workspace(t))
                        && t.status == TaskStatus::Ready
                        && !data.agent_queue.contains_key(&t.id)
                })
                .cloned()
                .collect();
            for task in tasks {
                let run = &data.runs[&task.run_id];
                let Some(worker) = automation::settings_for_task(run, &task)? else {
                    continue;
                };
                enqueue(
                    data,
                    Queued::new(
                        &WorkerLaunch {
                            task_id: task.id.clone(),
                            agent: worker.agent,
                            model: worker.model,
                            effort: worker.effort,
                            access: worker.access,
                            new_worktree: None,
                            base_branch: String::new(),
                        },
                        StartedBy::Coordinator,
                        task.approved_at
                            .unwrap_or(task.updated_at)
                            .max(task.updated_at),
                    ),
                )?;
            }
            Ok(())
        })
    }

    pub fn batch_claim(
        &self,
        projects: &WorkspaceState,
        actor: &str,
        task_ids: Vec<String>,
    ) -> Result<Vec<Attempt>, String> {
        if !self.is_worker_chat(actor)? {
            return Err("Only a batch's own worker may claim its tasks.".into());
        }
        let settings = crate::scheduling::load()?;
        // Take the project-store lock before the ledger, never inside it.
        let projects = crate::workspaces::list_workspaces_impl(projects)?;
        self.mutate(|data| {
            let batch = data.batches.iter().find(|b| b.status == BatchStatus::Claiming
                && data.batch_launches.get(&b.id).is_some_and(|l| l.worker_chat_key == actor))
                .cloned().ok_or("This worker has no batch awaiting a claim.")?;
            let runtime = data.batch_launches[&batch.id].clone();
            let unique: BTreeSet<_> = task_ids.iter().collect();
            if task_ids.is_empty() || task_ids.len() > 6 || unique.len() != task_ids.len() {
                return Err("Claim from one to six distinct tasks.".into());
            }
            if !task_ids.contains(&runtime.head) { return Err("A batch claim must include its head task.".into()); }
            let head = data.tasks.get(&runtime.head).cloned().ok_or("The head task no longer exists.")?;
            for id in &task_ids {
                let task = data.tasks.get(id).ok_or("A claimed task does not exist.")?;
                if !eligible(data, task) || (id != &runtime.head && (!runtime.candidates.contains(id) || !compatible(data, &head, task))) {
                    return Err("Claimed tasks must be approved, unheld candidates of the same agent, run, repository and base branch.".into());
                }
                let checked = task.destination.as_ref().map_or(Ok(()), |destination| {
                    destination::verify(&projects, destination).map(|_| ())
                }).and_then(|_| keeps_to_batch(data, &batch, &runtime, task));
                if let Err(error) = checked {
                    // A stale head invalidates the process's allocation. An
                    // incompatible extra selection may be omitted on a retry.
                    if id == &runtime.head {
                        // Refuse and release the launch promise in THIS write:
                        // another claim cannot slip between the two steps.
                        Self::block_batch_in(data, &batch, error.clone());
                        return Ok(Err(error));
                    }
                    return Err(error);
                }
            }
            let coordinator = data.runs[&batch.run_id].coordinator_chat_key.clone();
            let mut attempts = Vec::new();
            // The whole claim is one ledger transaction. A refused reservation
            // changes no task and consumes no retry, including earlier tasks.
            for id in &task_ids {
                let queued = data.agent_queue.get(id).cloned().ok_or("The task is no longer queued.")?;
                let (_, _, mut attempt, _) = Self::reserve_attempt_in(data, &coordinator, &queued.launch, queued.by.borrowed(), &settings, Some(&batch.id))?;
                attempt.batch_id = Some(batch.id.clone());
                attempt.worker_chat_key = actor.into();
                attempt.cwd = runtime.plan.cwd.clone();
                attempt.branch = runtime.plan.branch.clone();
                attempt.is_worktree = runtime.plan.is_managed_worktree();
                attempt.status = AttemptStatus::Running;
                attempt.execution.state = execution::ExecutionState::Executing;
                data.attempts.insert(attempt.id.clone(), attempt.clone());
                let task = data.tasks.get_mut(id).unwrap();
                task.workspace = Some(TaskWorkspace { plan: runtime.plan.clone(), swept_at: None,
                    state: workspaces::WorkspaceState::Ready, lease_attempt_id: Some(attempt.id.clone()),
                    delivery: None, abandoned: false, cleanup_intent: None, validation_paths: Vec::new() });
                data.agent_queue.remove(id);
                attempts.push(attempt);
            }
            let batch = data.batches.iter_mut().find(|b| b.id == batch.id).unwrap();
            batch.task_ids = task_ids;
            batch.status = BatchStatus::Working;
            Ok(Ok(attempts))
        })?
    }

    pub(super) fn settle_batches(&self) -> Result<(), String> {
        let ready: Vec<_> = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner
                .data
                .batches
                .iter()
                .filter(|b| {
                    b.status == BatchStatus::Working
                        && !inner.data.attempts.values().any(|a| {
                            a.batch_id.as_deref() == Some(&b.id)
                                && attempt_is_unsettled(&inner.data, a)
                        })
                })
                .map(|b| b.id.clone())
                .collect()
        };
        if ready.is_empty() {
            return Ok(());
        }
        self.mutate_regardless("batch settlement", |data| {
            for id in ready {
                if !data
                    .attempts
                    .values()
                    .any(|a| a.batch_id.as_deref() == Some(&id) && attempt_is_unsettled(data, a))
                {
                    if let Some(batch) = data
                        .batches
                        .iter_mut()
                        .find(|b| b.id == id && b.status == BatchStatus::Working)
                    {
                        batch.status = BatchStatus::Settled;
                        batch.settled_at = Some(now_ms());
                    }
                }
            }
            Ok(())
        })
    }
}

impl OrchestrationStore {
    /// Reserve the lane before doing Git or taking a chat lock. A claiming
    /// batch is durable worker identity even before its first attempt exists.
    fn begin_batch(
        &self,
        agent: &str,
        settings: &Settings,
    ) -> Result<Option<(Batch, BatchLaunch)>, String> {
        let snapshot = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            if let Some(error) = &inner.load_error {
                return Err(error.clone());
            }
            inner.data.clone()
        };
        let data = &snapshot;
        if data.agent_blocks.contains_key(agent) {
            return Ok(None);
        }

        if data
            .batches
            .iter()
            .any(|b| b.agent_id == agent && occupies_worker(data, b))
            || data.attempts.values().any(|a| {
                a.assignee.as_ref().is_some_and(|owner| owner.id == agent)
                    && attempt_is_unsettled(data, a)
            })
        {
            return Ok(None);
        }
        scheduling::require_host_slot(data, settings.host_cap)?;
        let Some(head) = queue(data, agent).first().copied().cloned() else {
            return Ok(None);
        };
        let run = data.runs[&head.run_id].clone();
        if scheduling::run_live(data, &run.id, None) >= usize::from(run.max_concurrent) {
            return Ok(None);
        }
        let id = format!("batch_{}", compact_id());
        let original = original(data, &head);
        let mode = head
            .approved
            .as_ref()
            .and_then(|a| a.workspace_mode)
            .or_else(|| {
                head.workspace_proposal
                    .as_ref()
                    .and_then(|p| p.plan.as_ref())
                    .map(|p| p.mode)
            })
            .unwrap_or_else(|| workspaces::advised_mode(&run, &head));
        let base = head
            .approved
            .as_ref()
            .and_then(|a| a.base_branch.as_deref())
            .or_else(|| {
                head.workspace_proposal
                    .as_ref()
                    .and_then(|p| p.plan.as_ref())
                    .map(|p| p.base_branch.as_str())
            })
            .unwrap_or("");
        let plan = if mode == WorkspaceMode::Agent {
            crate::git_ops::workflow::agent_plan(
                workspaces::task_root(&run, head.destination.as_ref()),
                base,
                agent,
                &id,
                original.map(|b| b.branch.as_str()),
            )?
        } else if let Some(ws) = &head.workspace {
            ws.plan.clone()
        } else if let Some(plan) = head
            .workspace_proposal
            .as_ref()
            .and_then(|p| p.plan.as_ref())
        {
            plan.clone()
        } else {
            return Err("The queued task has no approved workspace plan.".into());
        };
        let candidates = queue(data, agent)
            .into_iter()
            .filter(|t| {
                settings.orientation == Orientation::Agents
                    && t.id != head.id
                    && compatible(data, &head, t)
            })
            .map(|t| t.id.clone())
            .collect();
        let batch = Batch {
            id: id.clone(),
            agent_id: agent.into(),
            run_id: run.id,
            repository: plan.repository_root.clone(),
            base_branch: plan.base_branch.clone(),
            branch: plan.branch.clone(),
            worktree: plan.checkout_root.clone(),
            task_ids: vec![head.id.clone()],
            status: BatchStatus::Claiming,
            created_at: now_ms(),
            settled_at: None,
        };
        let runtime = BatchLaunch {
            worker_chat_key: format!("chat:orch-{}", compact_id()),
            head: head.id.clone(),
            candidates,
            plan,
            launch: data.agent_queue[&head.id].launch.clone(),
            destination: head.destination.clone(),
            started: false,
            launching: false,
        };

        self.mutate(|data| {
            if data.agent_blocks.contains_key(agent)
                || data.removed_agents.contains_key(agent)
                || data
                    .batches
                    .iter()
                    .any(|b| b.agent_id == agent && occupies_worker(data, b))
                || data.attempts.values().any(|a| {
                    a.assignee.as_ref().is_some_and(|a| a.id == agent)
                        && attempt_is_unsettled(data, a)
                })
                || queue(data, agent)
                    .first()
                    .is_none_or(|t| t.id != runtime.head)
            {
                return Ok(None);
            }
            scheduling::require_host_slot(data, settings.host_cap)?;
            let Some(current) = data.tasks.get(&runtime.head) else {
                return Ok(None);
            };
            if serde_json::to_value(current).ok() != serde_json::to_value(&head).ok() {
                return Ok(None);
            }
            let current_run = &data.runs[&batch.run_id];
            if scheduling::run_live(data, &batch.run_id, None)
                >= usize::from(current_run.max_concurrent)
            {
                return Ok(None);
            }
            data.batch_launches
                .insert(batch.id.clone(), runtime.clone());
            data.batches.push(batch.clone());
            Ok(Some((batch, runtime)))
        })
    }

    fn block_batch(&self, batch: &Batch, reason: String) -> Result<(), String> {
        self.mutate_regardless("agent lane block", |data| {
            Self::block_batch_in(data, batch, reason);
            Ok(())
        })
    }

    fn block_batch_in(data: &mut Stored, batch: &Batch, reason: String) {
        let previous = data
            .batches
            .iter()
            .rev()
            .find(|b| {
                b.agent_id == batch.agent_id && b.id != batch.id && b.worktree == batch.worktree
            })
            .cloned();
        let changed = data.agent_blocks.get(&batch.agent_id) != Some(&reason);
        data.agent_blocks
            .insert(batch.agent_id.clone(), reason.clone());
        if let Some(b) = data.batches.iter_mut().find(|b| b.id == batch.id) {
            b.status = BatchStatus::Settled;
            b.settled_at = Some(now_ms());
        }
        let owner = previous.as_ref().unwrap_or(batch);
        if changed {
            if let Some(run) = data.runs.get(&owner.run_id).cloned() {
                inbox::enqueue(
                    data,
                    &run.id,
                    "host",
                    &run.coordinator_chat_key,
                    format!("agent-lane-block:{}:{}", owner.id, reason),
                    "status",
                    reason,
                );
            }
        }
    }

    fn start_batch_chat(
        &self,
        chats: Arc<ChatManager>,
        workspaces: &WorkspaceState,
        batch: &Batch,
        runtime: &BatchLaunch,
    ) -> Result<(), String> {
        let projects = crate::workspaces::list_workspaces_impl(workspaces)?;
        let project = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            let head = inner
                .data
                .tasks
                .get(&runtime.head)
                .ok_or("The head disappeared.")?;
            let project = match &head.destination {
                Some(destination) => destination::verify(&projects, destination)?.clone(),
                None => projects
                    .iter()
                    .find(|p| p.id == inner.data.runs[&batch.run_id].workspace_id)
                    .cloned()
                    .ok_or("The run's project is no longer registered.")?,
            };
            keeps_to_batch(&inner.data, batch, runtime, head)?;
            project
        };
        let project_id = project.id.clone();
        let snapshot = self.snapshot(Some(&batch.run_id))?;
        let run = snapshot.runs.first().ok_or("The run disappeared.")?;
        let head = snapshot
            .tasks
            .iter()
            .find(|t| t.id == runtime.head)
            .ok_or("The head disappeared.")?;
        // Existing lifecycle door protects provisioning against every cleanup.
        chats.require_workspace_available(
            &runtime.plan.checkout_root,
            &runtime.worker_chat_key,
            &run.coordinator_chat_key,
            runtime.launch.access != Access::Read,
            runtime.plan.is_managed_worktree(),
        )?;
        crate::git_ops::workflow::provision_agent(&runtime.plan)?;

        let now = now_ms();
        crate::agent_chat::chat_index_save(crate::chat_index::ChatMeta {
            lead_of: None,
            id: runtime.worker_chat_key.trim_start_matches("chat:").into(),
            project_id,
            title: format!("Batch: {}", head.title),
            latest_response: None,
            custom_title: true,
            agent_title: false,
            session_id: None,
            cwd: Some(runtime.plan.cwd.clone()),
            model_id: Some(model_id(
                runtime.launch.agent,
                runtime.launch.model.as_deref(),
            )),
            access: Some(access_id(runtime.launch.access).into()),
            effort: runtime.launch.effort.clone(),
            created_at: now,
            updated_at: now,
            read_at: None,
            pinned: false,
            done_at: None,
            done_held: false,
            deleted_at: None,
            generation: 0,
            launch: None,
        })?;
        let candidates: Vec<_> = snapshot
            .tasks
            .iter()
            .filter(|t| runtime.candidates.contains(&t.id))
            .collect();
        let mut prompt = format!("You are the worker for OctiqFlow agent batch {} in run {}. The host owns this workspace and branch. Before doing task work call orchestration_batch_claim with the head task ID plus any candidates you choose to settle together, at most six tasks. The head is required. The tool returns an attemptId for EACH task: settle each separately with orchestration_worker_report. Unclaimed tasks stay queued. Work in {} on branch {}. Do not switch branches, create another worktree, push, deploy or restart. All task instructions and acceptance gates remain in effect.\n\nRun objective: {}\n\nHEAD TASK (full):\n{}\n\nQUEUED CANDIDATES (full):\n{}", batch.id, batch.run_id, runtime.plan.cwd, batch.branch, run.objective,
            serde_json::to_string_pretty(head).map_err(|e| e.to_string())?, serde_json::to_string_pretty(&candidates).map_err(|e| e.to_string())?);
        if let Some(assignee) = &head.assignee {
            if let Some((agent, brief)) = crate::team::assignee_brief(
                &crate::team::default_path(),
                &assignee.id,
                &project.id,
                head.peer_request.is_none(),
            ) {
                let _ = crate::team::ensure_memory(
                    &crate::memory_vault::Vault::profile(),
                    &runtime.worker_chat_key,
                    &agent,
                );
                prompt.push_str(&format!("\n\n{brief}"));
            }
        }
        self.mutate(|data| {
            if !data
                .batches
                .iter()
                .any(|b| b.id == batch.id && b.status == BatchStatus::Claiming)
                || matches!(
                    data.runs[&batch.run_id].status,
                    RunStatus::Stopped | RunStatus::Closed
                )
            {
                return Err("The batch ended before its worker could start.".into());
            }
            let launch = data
                .batch_launches
                .get_mut(&batch.id)
                .ok_or("The batch disappeared.")?;
            launch.started = true;
            launch.launching = true;
            data.worker_processes.insert(
                runtime.worker_chat_key.clone(),
                scheduling::ProcessLease {
                    run_id: batch.run_id.clone(),
                    launching: true,
                },
            );
            Ok(())
        })?;
        let started = crate::agent_chat::chat_start_user_impl(
            chats.clone(),
            runtime.worker_chat_key.clone(),
            runtime.plan.cwd.clone(),
            runtime.launch.agent,
            runtime.launch.model.clone(),
            Some(runtime.launch.access),
            Some(prompt),
            None,
            None,
            Some(Vec::new()),
            Some(project.env),
            runtime.launch.effort.clone(),
            None,
            Some(false),
            Some(format!("orchestration-batch-{}", batch.id)),
        );
        // Complete the spawn barrier even when persistence fails. A process
        // that lost its batch during spawn must be stopped after unlocking.
        let released = self.mutate_regardless("batch worker launch", |data| {
            data.batch_launches
                .get_mut(&batch.id)
                .ok_or("The batch disappeared.")?
                .launching = false;
            if let Some(lease) = data.worker_processes.get_mut(&runtime.worker_chat_key) {
                lease.launching = false;
            }
            if started.is_ok()
                && data
                    .batches
                    .iter()
                    .any(|b| b.id == batch.id && b.status != BatchStatus::Settled)
            {
                data.agent_blocks.remove(&batch.agent_id);
            }
            Ok(())
        });
        self.stop_ended_workers(&chats);
        started?;
        released
    }

    fn fallback_claim(
        &self,
        projects: &WorkspaceState,
        batch: &Batch,
        runtime: &BatchLaunch,
        turn_in_flight: bool,
    ) -> Result<Option<Vec<Attempt>>, String> {
        if batch.status != BatchStatus::Claiming
            || !runtime.started
            || runtime.launching
            || turn_in_flight
        {
            return Ok(None);
        }
        self.batch_claim(
            projects,
            &runtime.worker_chat_key,
            vec![runtime.head.clone()],
        )
        .map(Some)
    }

    pub(super) fn schedule_agent_batches(
        &self,
        chats: Arc<ChatManager>,
        workspaces: &WorkspaceState,
    ) -> Result<(), String> {
        // Stopping an already settled/refused worker never waits on a save.
        self.stop_ended_workers(&chats);
        self.settle_batches()?;
        // A shared batch process is released only after its LAST task settled.
        self.stop_ended_workers(&chats);
        let awaiting: Vec<_> = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner
                .data
                .batches
                .iter()
                .filter(|b| b.status == BatchStatus::Claiming)
                .filter_map(|b| {
                    inner
                        .data
                        .batch_launches
                        .get(&b.id)
                        .map(|l| (b.clone(), l.clone()))
                })
                .collect()
        };
        for (batch, runtime) in awaiting {
            if !runtime.started {
                let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
                if let Err(error) =
                    self.start_batch_chat(chats.clone(), workspaces, &batch, &runtime)
                {
                    self.block_batch(&batch, error)?;
                }
                continue;
            }
            match self.fallback_claim(
                workspaces,
                &batch,
                &runtime,
                chats.turn_in_flight(&runtime.worker_chat_key),
            ) {
                Ok(Some(attempts)) => {
                    // The first turn chose nothing. The host claims just the
                    // head, then starts the work turn with its exact attempt.
                    let brief = format!("The first turn made no batch claim. The host claimed the head alone. Complete this task and settle its own attempt with orchestration_worker_report.\n{}", serde_json::to_string_pretty(&attempts).map_err(|e| e.to_string())?);
                    // A fresh next turn in this batch's existing session.
                    self.mutate(|data| {
                        inbox::enqueue(
                            data,
                            &batch.run_id,
                            "host",
                            &runtime.worker_chat_key,
                            format!("batch-head-fallback:{}", batch.id),
                            "status",
                            brief,
                        );
                        Ok(())
                    })?;
                }
                Ok(None) => {}
                Err(error) => self.block_batch(&batch, error)?,
            }
        }
        self.stop_ended_workers(&chats);
        let settings = crate::scheduling::load()?;
        // Already queued starts keep their provenance across a switch. New
        // Tasks-mode work is not added here unless approval fixed Agent mode.
        self.sync_agent_queue()?;
        // No ledger lock across roster reads or process/chat operations.
        let agents = crate::team::list(&crate::team::default_path(), None, true)?;
        for agent in agents {
            let (previous_chats, blocked) = {
                let inner = self.inner.lock().map_err(|e| e.to_string())?;
                let previous = inner
                    .data
                    .batches
                    .iter()
                    .filter(|b| b.agent_id == agent.id)
                    .filter_map(|b| {
                        inner
                            .data
                            .batch_launches
                            .get(&b.id)
                            .map(|l| l.worker_chat_key.clone())
                    })
                    .collect::<Vec<_>>();
                let blocked = inner.data.agent_blocks.get(&agent.id).and_then(|_| {
                    inner
                        .data
                        .batches
                        .iter()
                        .rev()
                        .find(|b| b.agent_id == agent.id)
                        .and_then(|b| inner.data.batch_launches.get(&b.id))
                        .map(|l| l.plan.clone())
                });
                (previous, blocked)
            };
            if previous_chats.iter().any(|key| chats.turn_in_flight(key)) {
                continue;
            }
            if let Some(plan) = blocked {
                if !crate::git_ops::workflow::agent_checkout_clean(&plan).unwrap_or(false) {
                    continue;
                }
                self.mutate(|data| {
                    data.agent_blocks.remove(&agent.id);
                    Ok(())
                })?;
            }
            let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
            let Some((batch, runtime)) = (match self.begin_batch(&agent.id, &settings) {
                Ok(batch) => batch,
                Err(error) if error.starts_with("QUEUED_FOR_SLOT") => break,
                Err(error) => return Err(error),
            }) else {
                continue;
            };
            if let Err(reason) = self.start_batch_chat(chats.clone(), workspaces, &batch, &runtime)
            {
                self.block_batch(&batch, reason)?;
            }
        }
        // Roster changes can remove a lane without mutating this ledger.
        self.stop_ended_workers(&chats);
        // Publish after both locks have returned; unchanged payloads deduplicate.
        self.scheduling_changed();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    pub(super) fn worker() -> automation::WorkerSettings {
        automation::WorkerSettings {
            agent: ChatAgent::Codex,
            access: Access::Auto,
            model: Some("gpt-6.1-sol".into()),
            effort: Some("high".into()),
            recovery: None,
        }
    }
    pub(super) fn assigned(store: &OrchestrationStore, run: &Run, at: i64) -> Task {
        let task = super::super::tests::task(store, run, vec![]);
        let mut proposal = task.workspace_proposal.clone().unwrap();
        proposal.plan = Some(
            crate::git_ops::workflow::agent_plan(
                &run.root_path,
                "",
                "agent_test",
                "batch_pending",
                None,
            )
            .unwrap(),
        );
        store
            .mutate(|data| {
                let task = data.tasks.get_mut(&task.id).unwrap();
                task.assignee = Some(TaskAssignee {
                    id: "agent_test".into(),
                    name: "Test".into(),
                });
                task.worker = Some(worker());
                task.workspace_proposal = Some(proposal.clone());
                task.approved_at = Some(at);
                task.updated_at = at;
                if let Some(plan) = task
                    .workspace_proposal
                    .as_mut()
                    .and_then(|p| p.plan.as_mut())
                {
                    plan.mode = WorkspaceMode::Agent;
                }
                Ok(task.clone())
            })
            .unwrap()
    }
    fn queued_start(store: &OrchestrationStore, task: &Task, by: StartedBy) {
        let worker = worker();
        let error = store
            .reserve_attempt_for(
                "chat:master",
                &WorkerLaunch {
                    task_id: task.id.clone(),
                    agent: worker.agent,
                    access: worker.access,
                    model: worker.model,
                    effort: worker.effort,
                    new_worktree: None,
                    base_branch: String::new(),
                },
                by,
            )
            .unwrap_err();
        assert!(error.starts_with("QUEUED_FOR_SLOT"), "{error}");
    }
    pub(super) fn settings() -> Settings {
        Settings {
            orientation: Orientation::Agents,
            host_cap: None,
        }
    }

    #[test]
    fn one_batch_per_agent_across_runs_then_fifo_and_fresh_identity() {
        let home = TestDir::new("agent-fifo");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run1 = super::super::tests::run(&store);
        let run2 = super::super::tests::run(&store);
        let older = assigned(&store, &run1, 1);
        let newer = assigned(&store, &run2, 2);
        // An explicit Start retains the task's ready time, so a later scheduler
        // sync cannot put a newer ready task ahead of it.
        queued_start(&store, &older, StartedBy::Coordinator);
        store.sync_agent_queue().unwrap();
        let (first, runtime) = store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .unwrap();
        assert_eq!(runtime.head, older.id);
        assert!(
            runtime.candidates.is_empty(),
            "another run is never a candidate"
        );
        assert!(store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .is_none());
        let attempts = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                vec![older.id.clone()],
            )
            .unwrap();
        store
            .report_worker(
                &runtime.worker_chat_key,
                WorkerReport {
                    attempt_id: attempts[0].id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        store.settle_batches().unwrap();
        let (second, next) = store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .unwrap();
        assert_eq!(next.head, newer.id);
        assert_ne!(next.worker_chat_key, runtime.worker_chat_key);
        assert_ne!(second.branch, first.branch);
        assert_eq!(next.plan.checkout_root, runtime.plan.checkout_root);
    }

    #[test]
    fn claim_is_atomic_requires_head_and_refuses_other_run_repo_base_and_over_six() {
        let home = TestDir::new("agent-claim");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        // Allow six actual attempt slots in this fixture.
        store
            .mutate(|d| {
                d.runs.get_mut(&run.id).unwrap().max_concurrent = 8;
                Ok(())
            })
            .unwrap();
        let tasks: Vec<_> = (1..=8).map(|at| assigned(&store, &run, at)).collect();
        store.sync_agent_queue().unwrap();
        let (_, runtime) = store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .unwrap();
        assert!(store
            .batch_claim(
                &WorkspaceState::load(),
                "chat:master",
                vec![tasks[0].id.clone()]
            )
            .is_err());
        assert!(store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                vec![tasks[1].id.clone()]
            )
            .unwrap_err()
            .contains("head"));
        assert!(store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                tasks.iter().take(7).map(|t| t.id.clone()).collect()
            )
            .is_err());
        for change in ["run", "repo", "base"] {
            let original = { store.inner.lock().unwrap().data.tasks[&tasks[1].id].clone() };
            store
                .mutate(|data| {
                    let other = data.tasks.get_mut(&tasks[1].id).unwrap();
                    match change {
                        "run" => other.run_id = "another-run".into(),
                        "repo" => {
                            other.destination = Some(TaskDestination {
                                project_id: "project".into(),
                                project_name: "Other".into(),
                                repository: "other-repo".into(),
                            })
                        }
                        _ => {
                            other
                                .workspace_proposal
                                .as_mut()
                                .unwrap()
                                .plan
                                .as_mut()
                                .unwrap()
                                .base_branch = "other-base".into();
                            if let Some(approved) = &mut other.approved {
                                approved.base_branch = Some("other-base".into());
                            }
                        }
                    }
                    Ok(())
                })
                .unwrap();
            assert!(
                store
                    .batch_claim(
                        &WorkspaceState::load(),
                        &runtime.worker_chat_key,
                        vec![tasks[0].id.clone(), tasks[1].id.clone()]
                    )
                    .is_err(),
                "{change}"
            );
            assert!(store.inner.lock().unwrap().data.attempts.is_empty());
            store
                .mutate(|data| {
                    data.tasks.insert(original.id.clone(), original);
                    Ok(())
                })
                .unwrap();
        }
        let claims = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                tasks.iter().take(6).map(|t| t.id.clone()).collect(),
            )
            .unwrap();
        assert_eq!(claims.len(), 6);
        assert!(claims
            .iter()
            .all(|a| a.worker_chat_key == runtime.worker_chat_key));
    }

    #[test]
    fn persons_start_is_preserved_in_queue_and_uses_no_retry_at_reservation() {
        let home = TestDir::new("agent-person-start");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let task = assigned(&store, &run, 1);
        let projects = WorkspaceState::load();
        let mut last = None;
        for _ in 0..3 {
            queued_start(&store, &task, StartedBy::Coordinator);
            let (_, runtime) = store
                .begin_batch("agent_test", &settings())
                .unwrap()
                .unwrap();
            let attempt = store
                .batch_claim(&projects, &runtime.worker_chat_key, vec![task.id.clone()])
                .unwrap()
                .remove(0);
            store
                .report_worker(
                    &runtime.worker_chat_key,
                    WorkerReport {
                        attempt_id: attempt.id.clone(),
                        outcome: WorkerOutcome::Failed,
                        summary: "Fixture failure".into(),
                        files_modified: vec![],
                        verdict: None,
                    },
                )
                .unwrap();
            last = Some(attempt.id);
            store.settle_batches().unwrap();
        }
        queued_start(
            &store,
            &task,
            StartedBy::Page {
                retry_of: last.as_deref(),
            },
        );
        let before = store.inner.lock().unwrap().data.clone();
        assert_eq!(before.attempts.len(), 3);
        assert_eq!(before.tasks[&task.id].retries_used, 2);
        assert!(matches!(
            before.agent_queue[&task.id].by,
            QueueBy::Person { .. }
        ));
        let queued = store
            .snapshot(Some(&run.id))
            .unwrap()
            .tasks
            .into_iter()
            .find(|t| t.id == task.id)
            .unwrap();
        assert!(queued.slot_wait.is_some());
        assert!(
            queued.retrying,
            "a person Start queued for a slot is retrying"
        );
        assert_eq!(
            serde_json::to_value(queued.failure).unwrap()["awaits"],
            "coordinator"
        );
        let (_, runtime) = store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .unwrap();
        let claims = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                vec![task.id.clone()],
            )
            .unwrap();
        assert_eq!(
            store.inner.lock().unwrap().data.tasks[&task.id].retries_used,
            0
        );
        assert!(claims[0]
            .retry
            .as_ref()
            .is_none_or(|r| r.by == retry::RetryBy::Person));
    }

    #[test]
    fn claiming_and_working_batch_tasks_cannot_be_reassigned_or_handed_off() {
        let home = TestDir::new("batch-reassign-door");
        let _profile = crate::profile::started_in(&home);
        let capped = Settings {
            host_cap: Some(1),
            ..settings()
        };
        crate::scheduling::save(capped.clone()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let head = assigned(&store, &run, 1);
        store.sync_agent_queue().unwrap();
        let (_, runtime) = store.begin_batch("agent_test", &capped).unwrap().unwrap();
        let handoff = || {
            store.reassign_task(
                "chat:master",
                &head.id,
                (
                    Some(worker()),
                    Some(TaskAssignee {
                        id: "agent_b".into(),
                        name: "B".into(),
                    }),
                    None,
                ),
                "Same runtime, different agent".into(),
            )
        };
        let error = handoff().unwrap_err();
        assert!(error.contains("batch"), "{error}");
        let claim = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                vec![head.id.clone()],
            )
            .unwrap();
        assert_eq!(claim[0].assignee.as_ref().unwrap().id, "agent_test");
        let error = handoff().unwrap_err();
        assert!(error.contains("batch"), "{error}");
    }

    #[test]
    fn a_claim_binds_its_head_to_the_current_approval_even_after_reapproval() {
        let home = TestDir::new("batch-reapproved-head");
        let _profile = crate::profile::started_in(&home);
        let capped = Settings {
            host_cap: Some(1),
            ..settings()
        };
        crate::scheduling::save(capped.clone()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let head = assigned(&store, &run, 1);
        store.sync_agent_queue().unwrap();
        let (batch, runtime) = store.begin_batch("agent_test", &capped).unwrap().unwrap();
        // Simulate the pre-fix door's reassignment and new person approval,
        // after C's capability has already been issued and before any attempt.
        let proposal = workspaces::propose_assigned(
            &run,
            &head.id,
            None,
            Some(&worker()),
            Some(&TaskAssignee {
                id: "agent_b".into(),
                name: "B".into(),
            }),
        );
        store
            .mutate(|data| {
                let task = data.tasks.get_mut(&head.id).unwrap();
                task.assignee = Some(TaskAssignee {
                    id: "agent_b".into(),
                    name: "B".into(),
                });
                task.workspace_proposal = Some(proposal);
                task.approved = Some(approval::Approved::of(
                    None,
                    task,
                    approval::FixedBy::Plan,
                    now_ms(),
                ));
                Ok(())
            })
            .unwrap();
        let error = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                vec![head.id.clone()],
            )
            .unwrap_err();
        assert!(error.contains("approved"), "{error}");
        let data = &store.inner.lock().unwrap().data;
        assert!(data.attempts.is_empty());
        assert!(data.agent_queue.contains_key(&head.id));
        assert_eq!(
            data.batches
                .iter()
                .find(|b| b.id == batch.id)
                .unwrap()
                .status,
            BatchStatus::Settled
        );
    }

    #[test]
    fn claims_bind_head_and_candidates_to_the_approved_workspace_and_batch_branch() {
        let home = TestDir::new("batch-current-plan");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        for changed in [
            "head cwd",
            "head worktree",
            "candidate cwd",
            "candidate worktree",
            "runtime branch",
        ] {
            let store = OrchestrationStore::default();
            let run = super::super::tests::run(&store);
            let head = assigned(&store, &run, 1);
            let other = assigned(&store, &run, 2);
            store.sync_agent_queue().unwrap();
            let (batch, runtime) = store
                .begin_batch("agent_test", &settings())
                .unwrap()
                .unwrap();
            store
                .mutate(|data| {
                    if changed == "runtime branch" {
                        data.batch_launches
                            .get_mut(&batch.id)
                            .unwrap()
                            .plan
                            .branch
                            .push_str("-stale");
                    } else {
                        let id = if changed.starts_with("head") {
                            &head.id
                        } else {
                            &other.id
                        };
                        let plan = data
                            .tasks
                            .get_mut(id)
                            .unwrap()
                            .workspace_proposal
                            .as_mut()
                            .unwrap()
                            .plan
                            .as_mut()
                            .unwrap();
                        if changed.ends_with("cwd") {
                            plan.cwd.push_str("-reapproved");
                        } else {
                            plan.checkout_root.push_str("-reapproved");
                        }
                    }
                    Ok(())
                })
                .unwrap();
            let error = store
                .batch_claim(
                    &WorkspaceState::load(),
                    &runtime.worker_chat_key,
                    vec![head.id.clone(), other.id.clone()],
                )
                .unwrap_err();
            assert!(error.contains("approved"), "{changed}: {error}");
            let data = &store.inner.lock().unwrap().data;
            assert!(data.attempts.is_empty(), "{changed}");
            assert!(data.agent_queue.contains_key(&head.id));
            assert!(data.agent_queue.contains_key(&other.id));
        }
    }

    #[test]
    fn batch_start_and_each_claim_refuse_a_removed_destination_repository() {
        let home = TestDir::new("batch-destination");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        for door in ["start", "head claim", "candidate claim"] {
            let store = OrchestrationStore::default();
            let run = super::super::tests::run(&store);
            let head = assigned(&store, &run, 1);
            let other = assigned(&store, &run, 2);
            // The project remains registered, but its formerly approved repo
            // is now absent from its paths (the H2 reproduction).
            let projects = WorkspaceState::with_projects(vec![serde_json::from_value(json!({
                "id": "workspace", "name": "Project", "primary_path": home.to_string_lossy(), "paths": []
            })).unwrap()]);
            store
                .mutate(|data| {
                    let id = if door == "candidate claim" {
                        &other.id
                    } else {
                        &head.id
                    };
                    let task = data.tasks.get_mut(id).unwrap();
                    task.destination = Some(TaskDestination {
                        project_id: "workspace".into(),
                        project_name: "Project".into(),
                        repository: run.root_path.clone(),
                    });
                    task.approved = Some(approval::Approved::of(
                        None,
                        task,
                        approval::FixedBy::Plan,
                        now_ms(),
                    ));
                    Ok(())
                })
                .unwrap();
            store.sync_agent_queue().unwrap();
            let (_, runtime) = store
                .begin_batch("agent_test", &settings())
                .unwrap()
                .unwrap();
            let batch = store.inner.lock().unwrap().data.batches[0].clone();
            let error = if door == "start" {
                store
                    .start_batch_chat(
                        Arc::new(ChatManager::default()),
                        &projects,
                        &batch,
                        &runtime,
                    )
                    .unwrap_err()
            } else {
                let mut ids = vec![head.id.clone()];
                if door == "candidate claim" {
                    ids.push(other.id.clone());
                }
                store
                    .batch_claim(&projects, &runtime.worker_chat_key, ids)
                    .unwrap_err()
            };
            assert!(error.contains("no longer a repository"), "{door}: {error}");
            let data = &store.inner.lock().unwrap().data;
            assert!(data.attempts.is_empty(), "{door}");
            assert!(data.agent_queue.contains_key(&head.id));
            assert!(!data.batch_launches[&batch.id].started);
        }
    }

    #[test]
    fn held_tasks_never_enter_a_lane() {
        let home = TestDir::new("agent-held");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let task = assigned(&store, &run, 1);
        store.require_plan_approval(&run.id).unwrap();
        store
            .mutate(|data| {
                let t = data.tasks.get_mut(&task.id).unwrap();
                t.approved_at = None;
                t.approved = None;
                Ok(())
            })
            .unwrap();
        store.sync_agent_queue().unwrap();
        let inner = store.inner.lock().unwrap();
        assert!(queue(&inner.data, "agent_test").is_empty());
        assert!(!inner.data.agent_queue.contains_key(&task.id));
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::tests::{assigned, settings};
    use super::*;
    use crate::test_dir::TestDir;

    #[test]
    fn first_turn_without_claim_claims_only_the_head_and_keeps_candidates_queued() {
        let home = TestDir::new("batch-fallback");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let head = assigned(&store, &run, 1);
        let other = assigned(&store, &run, 2);
        store.sync_agent_queue().unwrap();
        let (batch, mut runtime) = store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .unwrap();
        assert!(store
            .fallback_claim(&WorkspaceState::load(), &batch, &runtime, false)
            .unwrap()
            .is_none());
        runtime.started = true;
        assert!(store
            .fallback_claim(&WorkspaceState::load(), &batch, &runtime, true)
            .unwrap()
            .is_none());
        let claims = store
            .fallback_claim(&WorkspaceState::load(), &batch, &runtime, false)
            .unwrap()
            .unwrap();
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].task_id, head.id);
        assert!(store
            .inner
            .lock()
            .unwrap()
            .data
            .agent_queue
            .contains_key(&other.id));
    }

    #[test]
    fn dirty_worktree_blocks_lane_notifies_owner_and_task_cleanup_keeps_it() {
        let home = TestDir::new("batch-dirty");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let head = assigned(&store, &run, 1);
        store.sync_agent_queue().unwrap();
        let (batch, runtime) = store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .unwrap();
        crate::git_ops::workflow::provision_agent(&runtime.plan).unwrap();
        let claims = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                vec![head.id.clone()],
            )
            .unwrap();
        let dirty = Path::new(&runtime.plan.cwd).join("keep.txt");
        std::fs::write(&dirty, "author work").unwrap();
        let reason = crate::git_ops::workflow::provision_agent(&runtime.plan).unwrap_err();
        store.block_batch(&batch, reason).unwrap();
        let inner = store.inner.lock().unwrap();
        assert_eq!(lanes(&inner.data, None)[0]["state"], "blocked");
        assert!(inner
            .data
            .notifications
            .values()
            .any(|n| n.target_chat_key == "chat:master"));
        drop(inner);
        assert!(store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .is_none());
        store
            .report_worker(
                &runtime.worker_chat_key,
                WorkerReport {
                    attempt_id: claims[0].id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        let chats = ChatManager::default();
        for abandon in [false, true] {
            assert!(store
                .cleanup_workspace(&chats, "chat:master", &head.id, abandon, "unused")
                .unwrap_err()
                .contains("Agent worktrees"));
        }
        assert_eq!(std::fs::read_to_string(dirty).unwrap(), "author work");
        assert!(Path::new(&runtime.plan.checkout_root).exists());
    }
}

#[cfg(test)]
mod retention_tests {
    use super::tests::{assigned, settings};
    use super::*;
    use crate::test_dir::TestDir;

    #[test]
    fn registered_agent_worktree_is_managed_retained_then_returns_to_ordinary_lifespan() {
        let home = TestDir::new("agent-retention");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let agent = crate::team::save(&crate::team::default_path(), serde_json::from_value(json!({
            "name": "Fixture worker", "role": "Only fixture work", "agent": "codex", "model": "gpt-6.1-sol", "access": "auto"
        })).unwrap()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let task = assigned(&store, &run, 1);
        let plan = crate::git_ops::workflow::agent_plan(
            &run.root_path,
            "",
            &agent.id,
            "batch_pending",
            None,
        )
        .unwrap();
        store
            .mutate(|data| {
                let task = data.tasks.get_mut(&task.id).unwrap();
                task.workspace_proposal.as_mut().unwrap().plan = Some(plan);
                task.assignee.as_mut().unwrap().id = agent.id.clone();
                let owner = task.assignee.clone();
                if let Some(approved) = &mut task.approved {
                    approved.assignee = owner;
                }
                Ok(())
            })
            .unwrap();
        store.sync_agent_queue().unwrap();
        let (_, runtime) = store.begin_batch(&agent.id, &settings()).unwrap().unwrap();
        crate::git_ops::workflow::provision_agent(&runtime.plan).unwrap();
        let claims = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                vec![task.id],
            )
            .unwrap();
        store
            .report_worker(
                &runtime.worker_chat_key,
                WorkerReport {
                    attempt_id: claims[0].id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        store.settle_batches().unwrap();
        let allocations = store.lifespan_allocations().unwrap();
        assert_eq!(allocations[0].owner.kind, "agent");
        assert!(
            allocations[0].active.is_none(),
            "idle build stripping remains possible"
        );
        crate::team::delete(&crate::team::default_path(), &agent.id).unwrap();
        assert_eq!(store.lifespan_allocations().unwrap()[0].owner.kind, "task");
        assert!(Path::new(&runtime.plan.checkout_root).exists());
    }

    #[test]
    fn host_cap_reserves_across_runs_and_holds_agent_batches_without_using_a_retry() {
        let home = TestDir::new("host-global-cap");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(Settings {
            orientation: Orientation::Tasks,
            host_cap: Some(1),
        })
        .unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let first = assigned(&store, &run, 1);
        store
            .mutate(|data| {
                let task = data.tasks.get_mut(&first.id).unwrap();
                task.workspace_proposal
                    .as_mut()
                    .unwrap()
                    .plan
                    .as_mut()
                    .unwrap()
                    .mode = WorkspaceMode::Worktree;
                if let Some(approved) = &mut task.approved {
                    approved.workspace_mode = Some(WorkspaceMode::Worktree);
                }
                Ok(())
            })
            .unwrap();

        let worker = super::tests::worker();
        let launch = |task_id| WorkerLaunch {
            task_id,
            agent: worker.agent,
            model: worker.model.clone(),
            effort: worker.effort.clone(),
            access: worker.access,
            new_worktree: None,
            base_branch: String::new(),
        };
        store
            .reserve_attempt("chat:master", &launch(first.id))
            .unwrap();
        let other_run = super::super::tests::run(&store);
        let other = assigned(&store, &other_run, 2);
        store
            .mutate(|data| {
                let task = data.tasks.get_mut(&other.id).unwrap();
                task.workspace_proposal
                    .as_mut()
                    .unwrap()
                    .plan
                    .as_mut()
                    .unwrap()
                    .mode = WorkspaceMode::Worktree;
                if let Some(approved) = &mut task.approved {
                    approved.workspace_mode = Some(WorkspaceMode::Worktree);
                }
                Ok(())
            })
            .unwrap();

        assert!(store
            .reserve_attempt("chat:master", &launch(other.id.clone()))
            .unwrap_err()
            .starts_with("QUEUED_FOR_SLOT host"));
        let capped = Settings {
            orientation: Orientation::Agents,
            host_cap: Some(1),
        };
        crate::scheduling::save(capped.clone()).unwrap();
        store
            .reserve_attempt("chat:master", &launch(other.id.clone()))
            .unwrap_err();
        // Another identity proves this is the host cap, not the first lane's occupancy.
        store
            .mutate(|data| {
                data.tasks
                    .get_mut(&other.id)
                    .unwrap()
                    .assignee
                    .as_mut()
                    .unwrap()
                    .id = "agent_other".into();
                Ok(())
            })
            .unwrap();
        assert!(store
            .begin_batch("agent_other", &capped)
            .unwrap_err()
            .starts_with("QUEUED_FOR_SLOT host"));
        let inner = store.inner.lock().unwrap();
        assert_eq!(scheduling::live(&inner.data), 1);
        assert_eq!(inner.data.tasks[&other.id].retries_used, 0);
        let wait =
            scheduling::slot_wait(&inner.data, &inner.data.tasks[&other.id], &capped).unwrap();
        assert_eq!(wait.reason, "host");
        assert_eq!(wait.limit, Some(1));
    }
}

#[cfg(test)]
mod admission_tests {
    use super::tests::{assigned, settings};
    use super::*;
    use crate::test_dir::TestDir;

    fn other_agent(store: &OrchestrationStore, task: &Task) {
        store
            .mutate(|data| {
                data.tasks
                    .get_mut(&task.id)
                    .unwrap()
                    .assignee
                    .as_mut()
                    .unwrap()
                    .id = "agent_other".into();
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn host_cap_one_claims_three_tasks_as_one_process_and_queues_another_agent() {
        let home = TestDir::new("batch-process-cap");
        let _profile = crate::profile::started_in(&home);
        let capped = Settings {
            host_cap: Some(1),
            ..settings()
        };
        crate::scheduling::save(capped.clone()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        store
            .mutate(|data| {
                data.runs.get_mut(&run.id).unwrap().max_concurrent = 3;
                Ok(())
            })
            .unwrap();
        let tasks: Vec<_> = (1..=3).map(|at| assigned(&store, &run, at)).collect();
        let other = assigned(&store, &run, 4);
        other_agent(&store, &other);
        store.sync_agent_queue().unwrap();
        let (_, runtime) = store.begin_batch("agent_test", &capped).unwrap().unwrap();
        let claims = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                tasks.iter().map(|task| task.id.clone()).collect(),
            )
            .unwrap();
        assert_eq!(claims.len(), 3);
        assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 1);
        assert!(store
            .begin_batch("agent_other", &capped)
            .unwrap_err()
            .starts_with("QUEUED_FOR_SLOT host"));
        let data = &store.inner.lock().unwrap().data;
        assert_eq!(
            data.attempts
                .values()
                .filter(|a| attempt_is_unsettled(data, a))
                .count(),
            3,
            "all three task attempts are reserved in the one worker"
        );
        assert!(data.agent_queue.contains_key(&other.id));
        assert_eq!(data.tasks[&other.id].retries_used, 0);
    }

    #[test]
    fn run_cap_four_claims_six_tasks_in_one_worker() {
        let home = TestDir::new("batch-run-process-cap");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        store
            .mutate(|data| {
                data.runs.get_mut(&run.id).unwrap().max_concurrent = 4;
                Ok(())
            })
            .unwrap();
        let tasks: Vec<_> = (1..=6).map(|at| assigned(&store, &run, at)).collect();
        store.sync_agent_queue().unwrap();
        let (_, runtime) = store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .unwrap();
        let claims = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                tasks.iter().map(|task| task.id.clone()).collect(),
            )
            .unwrap();
        assert_eq!(claims.len(), 6);
        assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 1);
    }

    #[test]
    fn refused_batch_holds_process_capacity_until_its_stub_is_ended() {
        for refusal in ["stale head", "destination", "no claim"] {
            let home = TestDir::new("batch-refusal-process");
            let _profile = crate::profile::started_in(&home);
            let capped = Settings {
                host_cap: Some(1),
                ..settings()
            };
            crate::scheduling::save(capped.clone()).unwrap();
            let store = Arc::new(OrchestrationStore::default());
            let run = super::super::tests::run(&store);
            let head = assigned(&store, &run, 1);
            let other = assigned(&store, &run, 2);
            other_agent(&store, &other);
            let next = assigned(&store, &run, 3);
            let projects = WorkspaceState::with_projects(vec![serde_json::from_value(json!({
                "id": "workspace", "name": "Project", "primary_path": home.to_string_lossy(), "paths": []
            })).unwrap()]);
            if refusal == "destination" {
                store
                    .mutate(|data| {
                        let task = data.tasks.get_mut(&head.id).unwrap();
                        task.destination = Some(TaskDestination {
                            project_id: "workspace".into(),
                            project_name: "Project".into(),
                            repository: run.root_path.clone(),
                        });
                        task.approved = Some(approval::Approved::of(
                            None,
                            task,
                            approval::FixedBy::Plan,
                            now_ms(),
                        ));
                        Ok(())
                    })
                    .unwrap();
            }
            store.sync_agent_queue().unwrap();
            let (batch, runtime) = store.begin_batch("agent_test", &capped).unwrap().unwrap();
            let mut chats = ChatManager::default();
            chats.orchestrations = store.clone();
            let cap = chats.test_launch(&runtime.worker_chat_key);
            assert!(chats
                .caller_for_capability(&runtime.worker_chat_key, &cap)
                .is_some());
            chats.test_busy(&runtime.worker_chat_key, true);
            let child = chats.test_child(&runtime.worker_chat_key);
            store
                .mutate(|data| {
                    data.batch_launches.get_mut(&batch.id).unwrap().started = true;
                    if refusal == "stale head" {
                        let task = data.tasks.get_mut(&head.id).unwrap();
                        task.worker.as_mut().unwrap().effort = Some("low".into());
                        task.approved = Some(approval::Approved::of(
                            None,
                            task,
                            approval::FixedBy::Plan,
                            now_ms(),
                        ));
                    }
                    Ok(())
                })
                .unwrap();
            if refusal != "no claim" {
                assert!(store
                    .batch_claim(&projects, &runtime.worker_chat_key, vec![head.id.clone()])
                    .is_err());
            } else {
                store
                    .block_batch(&batch, "No claim can be reserved".into())
                    .unwrap();
            }
            let count = store.scheduling_get().unwrap()["live"]["total"].clone();
            let cap_revoked = chats
                .caller_for_capability(&runtime.worker_chat_key, &cap)
                .is_none();
            let refused = store.begin_batch("agent_other", &capped).is_err();
            store
                .mutate(|data| {
                    data.agent_blocks.remove("agent_test");
                    // Hold the invalid head so the next valid task can run.
                    data.tasks.get_mut(&head.id).unwrap().superseded_by = Some(next.id.clone());
                    Ok(())
                })
                .unwrap();
            let same_lane = store
                .begin_batch("agent_test", &settings())
                .unwrap()
                .is_none();
            store.stop_ended_workers(&chats);
            let gone = child.gone_soon();
            if !gone {
                chats.test_end(&runtime.worker_chat_key);
            }
            assert_eq!(
                count, 1,
                "{refusal}: the live pre-claim process keeps its slot"
            );
            assert!(
                refused,
                "{refusal}: another agent must queue before the process ends"
            );
            assert!(same_lane, "{refusal}: its agent lane also remains held");
            assert!(
                cap_revoked,
                "{refusal}: capability must be refused before reaping"
            );
            assert!(
                gone,
                "{refusal}: the refused worker process must be ended even with no attempts"
            );
            store.stop_ended_workers(&chats);
            assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 0);
            assert!(!chats.turn_in_flight(&runtime.worker_chat_key));
            let lane = store.inner.lock().unwrap();
            let lanes = lanes(&lane.data, None);
            assert_eq!(
                lanes.iter().find(|l| l["agentId"] == "agent_test").unwrap()["state"],
                "idle"
            );
            drop(lane);
            let (_, next_runtime) = store.begin_batch("agent_test", &capped).unwrap().unwrap();
            assert_eq!(next_runtime.head, next.id);
            assert_ne!(next_runtime.worker_chat_key, runtime.worker_chat_key);
            chats.test_launch(&next_runtime.worker_chat_key);
            let claim = store
                .batch_claim(
                    &projects,
                    &next_runtime.worker_chat_key,
                    vec![next.id.clone()],
                )
                .unwrap();
            assert_eq!(claim.len(), 1);
            chats.test_end(&next_runtime.worker_chat_key);
        }
    }

    #[test]
    fn a_scheduler_pass_cannot_fallback_claim_while_the_batch_is_launching() {
        let home = TestDir::new("batch-fallback-spawn-barrier");
        let _profile = crate::profile::started_in(&home);
        let capped = Settings {
            host_cap: Some(1),
            ..settings()
        };
        crate::scheduling::save(capped.clone()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let head = assigned(&store, &run, 1);
        let candidate = assigned(&store, &run, 2);
        store.sync_agent_queue().unwrap();
        let (batch, _) = store.begin_batch("agent_test", &capped).unwrap().unwrap();
        store
            .mutate(|data| {
                let launch = data.batch_launches.get_mut(&batch.id).unwrap();
                launch.started = true;
                launch.launching = true;
                Ok(())
            })
            .unwrap();
        // No provider CLI is launched: the spawn has not created a process
        // yet, and this isolated profile has no registered agents to start.
        let chats = Arc::new(ChatManager::default());
        store
            .schedule_agent_batches(chats.clone(), &WorkspaceState::load())
            .unwrap();
        assert!(chats.process_keys().is_empty());
        let data = &store.inner.lock().unwrap().data;
        assert!(
            data.attempts.is_empty(),
            "an unfinished spawn is not an idle first turn"
        );
        assert!(data.agent_queue.contains_key(&head.id));
        assert!(data.agent_queue.contains_key(&candidate.id));
        assert_eq!(data.batches[0].status, BatchStatus::Claiming);
        assert!(!data
            .notifications
            .values()
            .any(|n| n.source.starts_with("batch-head-fallback:")));
    }

    #[test]
    fn a_stopped_batch_cannot_release_a_process_still_being_launched() {
        let home = TestDir::new("batch-stop-spawn-barrier");
        let _profile = crate::profile::started_in(&home);
        let capped = Settings {
            host_cap: Some(1),
            ..settings()
        };
        crate::scheduling::save(capped.clone()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        assigned(&store, &run, 1);
        let second_run = super::super::tests::run(&store);
        let other = assigned(&store, &second_run, 2);
        other_agent(&store, &other);
        store.sync_agent_queue().unwrap();
        let (batch, runtime) = store.begin_batch("agent_test", &capped).unwrap().unwrap();
        store
            .mutate(|data| {
                let launch = data.batch_launches.get_mut(&batch.id).unwrap();
                launch.started = true;
                launch.launching = true;
                Ok(())
            })
            .unwrap();
        let workers = store
            .stop_run("chat:master", run.id, "Stop while spawning".into())
            .unwrap();
        assert!(workers.contains(&runtime.worker_chat_key));
        let chats = ChatManager::default();
        store.stop_ended_workers(&chats);
        assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 1);
        assert!(store.begin_batch("agent_other", &capped).is_err());
        // The spawn finishes after Stop's first process lookup found nothing.
        chats.test_launch(&runtime.worker_chat_key);
        let child = chats.test_child(&runtime.worker_chat_key);
        store
            .mutate(|data| {
                data.batch_launches.get_mut(&batch.id).unwrap().launching = false;
                Ok(())
            })
            .unwrap();
        store.stop_ended_workers(&chats);
        assert!(child.gone_soon());
        store.stop_ended_workers(&chats);
        assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 0);
        assert!(store.begin_batch("agent_other", &capped).unwrap().is_some());
    }

    #[test]
    fn run_stop_includes_already_settled_preclaim_worker_and_ends_its_stub() {
        let home = TestDir::new("batch-settled-stop");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        assigned(&store, &run, 1);
        store.sync_agent_queue().unwrap();
        let (batch, runtime) = store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .unwrap();
        let chats = ChatManager::default();
        chats.test_launch(&runtime.worker_chat_key);
        let child = chats.test_child(&runtime.worker_chat_key);
        store
            .mutate(|data| {
                data.batch_launches.get_mut(&batch.id).unwrap().started = true;
                Ok(())
            })
            .unwrap();
        store
            .block_batch(&batch, "Destination no longer available".into())
            .unwrap();
        let workers = store
            .stop_run("chat:master", run.id, "Stop run".into())
            .unwrap();
        for key in &workers {
            crate::agent_chat::chat_stop_impl(&chats, key.clone()).unwrap();
        }
        let gone = child.gone_soon();
        if !gone {
            chats.test_end(&runtime.worker_chat_key);
        }
        assert!(
            workers.contains(&runtime.worker_chat_key),
            "Stop must include settled batches with no attempts"
        );
        assert!(gone, "Stop must kill the actual stub");
    }

    #[test]
    fn claiming_launch_reserves_capacity_and_run_stop_releases_its_worker_identity() {
        let home = TestDir::new("batch-claiming-cap");
        let _profile = crate::profile::started_in(&home);
        let capped = Settings {
            orientation: Orientation::Agents,
            host_cap: Some(1),
        };
        crate::scheduling::save(capped.clone()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let first = assigned(&store, &run, 1);
        let second = assigned(&store, &run, 2);
        store
            .mutate(|data| {
                data.tasks
                    .get_mut(&second.id)
                    .unwrap()
                    .assignee
                    .as_mut()
                    .unwrap()
                    .id = "agent_other".into();
                Ok(())
            })
            .unwrap();
        store.sync_agent_queue().unwrap();
        let (_, runtime) = store.begin_batch("agent_test", &capped).unwrap().unwrap();
        assert!(store
            .begin_batch("agent_other", &capped)
            .unwrap_err()
            .starts_with("QUEUED_FOR_SLOT"));
        assert_eq!(
            scheduling::live(&store.inner.lock().unwrap().data),
            1,
            "the pre-claim worker occupies one process slot"
        );
        let claimed = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                vec![first.id],
            )
            .unwrap();
        assert_eq!(claimed.len(), 1, "a claim replaces its own promise");
        // A second fixture run stopped BEFORE claiming still names its process.
        let other_store = OrchestrationStore::default();
        let other_run = super::super::tests::run(&other_store);
        assigned(&other_store, &other_run, 1);
        other_store.sync_agent_queue().unwrap();
        let (_, unclaimed) = other_store
            .begin_batch("agent_test", &capped)
            .unwrap()
            .unwrap();
        let workers = other_store
            .stop_run("chat:master", other_run.id, "Person stopped the run".into())
            .unwrap();
        assert_eq!(workers, vec![unclaimed.worker_chat_key]);
        let inner = other_store.inner.lock().unwrap();
        assert!(inner.data.agent_queue.is_empty());
        assert!(inner
            .data
            .batches
            .iter()
            .all(|b| b.status == BatchStatus::Settled));
    }

    #[test]
    fn a_later_stop_is_not_bypassed_by_a_queued_persons_start() {
        let home = TestDir::new("queue-stop-order");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let task = assigned(&store, &run, 1);
        let launch = WorkerLaunch {
            task_id: task.id.clone(),
            agent: ChatAgent::Codex,
            model: Some("gpt-6.1-sol".into()),
            effort: Some("high".into()),
            access: Access::Auto,
            base_branch: String::new(),
            new_worktree: None,
        };
        let stop = || TaskStop {
            at: now_ms(),
            attempt_id: "old-attempt".into(),
            reason: None,
        };
        store
            .mutate(|data| {
                data.tasks.get_mut(&task.id).unwrap().stopped = Some(stop());
                Ok(())
            })
            .unwrap();
        assert!(store
            .reserve_attempt_for("chat:master", &launch, StartedBy::Page { retry_of: None })
            .unwrap_err()
            .starts_with("QUEUED_FOR_SLOT"));
        assert!(store.inner.lock().unwrap().data.tasks[&task.id]
            .stopped
            .is_none());
        store
            .mutate(|data| {
                data.tasks.get_mut(&task.id).unwrap().stopped = Some(stop());
                Ok(())
            })
            .unwrap();
        let inner = store.inner.lock().unwrap();
        assert!(queue(&inner.data, "agent_test").is_empty());
    }
}

#[cfg(test)]
mod stop_tests {
    use super::tests::{assigned, settings};
    use super::*;
    use crate::test_dir::TestDir;

    #[test]
    fn stopping_one_task_requeues_its_shared_process_peers_without_another_retry() {
        let home = TestDir::new("batch-stop-peers");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let first = assigned(&store, &run, 1);
        let second = assigned(&store, &run, 2);
        store.sync_agent_queue().unwrap();
        let (_, runtime) = store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .unwrap();
        let claims = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                vec![first.id.clone(), second.id.clone()],
            )
            .unwrap();
        let (_, key) = store.stop_task(&first.id, None).unwrap();
        assert_eq!(key, runtime.worker_chat_key);
        store.sync_agent_queue().unwrap();
        store.settle_batches().unwrap();
        let inner = store.inner.lock().unwrap();
        assert!(inner.data.tasks[&first.id].stopped.is_some());
        assert_eq!(inner.data.tasks[&second.id].status, TaskStatus::Ready);
        assert_eq!(inner.data.tasks[&second.id].retries_used, 0);
        assert_eq!(queue(&inner.data, "agent_test")[0].id, second.id);
        assert!(claims
            .iter()
            .all(|a| inner.data.attempts[&a.id].status == AttemptStatus::Cancelled));
    }
}

#[cfg(test)]
mod switch_tests {
    use super::tests::{assigned, settings, worker};
    use super::*;
    use crate::test_dir::TestDir;

    #[test]
    fn switching_to_tasks_keeps_queued_person_and_agent_allocation_as_single_task_batches() {
        let home = TestDir::new("orientation-switch");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let first = assigned(&store, &run, 1);
        assigned(&store, &run, 2);
        let chosen = worker();
        let launch = WorkerLaunch {
            task_id: first.id.clone(),
            agent: chosen.agent,
            access: chosen.access,
            model: chosen.model.clone(),
            effort: chosen.effort.clone(),
            new_worktree: None,
            base_branch: String::new(),
        };
        assert!(store
            .reserve_attempt_for("chat:master", &launch, StartedBy::Page { retry_of: None })
            .unwrap_err()
            .starts_with("QUEUED_FOR_SLOT"));
        let tasks_mode = Settings {
            orientation: Orientation::Tasks,
            host_cap: None,
        };
        crate::scheduling::save(tasks_mode.clone()).unwrap();
        store.sync_agent_queue().unwrap();
        let (_, runtime) = store
            .begin_batch("agent_test", &tasks_mode)
            .unwrap()
            .unwrap();
        assert!(runtime.candidates.is_empty());
        assert_eq!(runtime.head, first.id);
        let attempts = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                vec![first.id.clone()],
            )
            .unwrap();
        assert_eq!(attempts[0].branch, runtime.plan.branch);
        assert!(matches!(
            store.inner.lock().unwrap().data.batches[0].status,
            BatchStatus::Working
        ));
        // Ordinary work proposed after the switch preserves today's start door.
        let ordinary = super::super::tests::task(&store, &run, vec![]);
        store
            .mutate(|data| {
                let task = data.tasks.get_mut(&ordinary.id).unwrap();
                task.assignee = Some(TaskAssignee {
                    id: "agent_other".into(),
                    name: "Other".into(),
                });
                task.worker = Some(chosen.clone());
                Ok(())
            })
            .unwrap();
        let mut direct = launch;
        direct.task_id = ordinary.id;
        assert!(store.reserve_attempt("chat:master", &direct).is_ok());
    }

    #[test]
    fn a_batch_worker_can_open_a_gate_for_any_owned_claim_but_no_foreign_task() {
        let home = TestDir::new("batch-own-gates");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let first = assigned(&store, &run, 1);
        let second = assigned(&store, &run, 2);
        store.sync_agent_queue().unwrap();
        let (_, runtime) = store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .unwrap();
        store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                vec![first.id.clone(), second.id.clone()],
            )
            .unwrap();
        for task in [&first, &second] {
            let gate = store
                .create_gate(
                    &runtime.worker_chat_key,
                    run.id.clone(),
                    Some(task.id.clone()),
                    "Need a decision".into(),
                    vec![],
                )
                .unwrap();
            assert_eq!(gate.task_id.as_deref(), Some(task.id.as_str()));
        }
        let foreign = super::super::tests::task(&store, &run, vec![]);
        assert!(store
            .create_gate(
                &runtime.worker_chat_key,
                run.id,
                Some(foreign.id),
                "Cannot own this".into(),
                vec![]
            )
            .is_err());
    }
}

#[cfg(test)]
mod stream_tests {
    use super::tests::{assigned, settings};
    use super::*;
    use crate::test_dir::TestDir;

    #[test]
    fn shared_stream_activity_and_disconnect_reach_every_unsettled_attempt() {
        let home = TestDir::new("batch-stream");
        let _profile = crate::profile::started_in(&home);
        crate::scheduling::save(settings()).unwrap();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let first = assigned(&store, &run, 1);
        let second = assigned(&store, &run, 2);
        store.sync_agent_queue().unwrap();
        let (_, runtime) = store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .unwrap();
        let claims = store
            .batch_claim(
                &WorkspaceState::load(),
                &runtime.worker_chat_key,
                vec![first.id.clone(), second.id.clone()],
            )
            .unwrap();
        store.observe_worker_event(&runtime.worker_chat_key, &json!({"type":"item.started","item":{"id":"cmd","type":"command_execution","command":"fixture-only"}})).unwrap();
        {
            let inner = store.inner.lock().unwrap();
            for attempt in &claims {
                assert!(inner.data.attempts[&attempt.id]
                    .execution
                    .pending_tools
                    .contains_key("cmd"));
                assert!(active_attempt_for_task(
                    &inner.data,
                    &runtime.worker_chat_key,
                    &attempt.task_id
                )
                .is_some());
            }
        }
        store
            .worker_disconnected(&runtime.worker_chat_key, Some("fixture process exited"))
            .unwrap();
        store.settle_batches().unwrap();
        let inner = store.inner.lock().unwrap();
        assert!(claims
            .iter()
            .all(|a| inner.data.attempts[&a.id].status == AttemptStatus::Failed));
        assert_eq!(inner.data.batches[0].status, BatchStatus::Settled);
    }
}

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
    /// The extra MCP servers the batch's process is launched with: its head
    /// task's approved list (`Approved::worker_servers`), recorded when the
    /// batch began, before any attempt exists. Every task it claims has the
    /// same approved list (`compatible`, `keeps_to_batch`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub worker_servers: Vec<String>,
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

/// The extra MCP servers the person approved for `task`; none without an
/// approval.
fn approved_servers(task: &Task) -> Vec<String> {
    task.approved
        .as_ref()
        .map(|approved| approved.worker_servers.clone())
        .unwrap_or_default()
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
    // The process already runs with the servers it was launched with.
    if approved.worker_servers != runtime.worker_servers {
        return Err("The batch's worker was started with other MCP servers than the person approved for this task. The task stays queued for a batch of its own; nothing was started.".into());
    }
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
        // One process, one set of servers: a task approved with another
        // list runs in a batch of its own, never with more than it was
        // approved for.
        && approved_servers(head) == approved_servers(candidate)
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
            worker_servers: approved_servers(&head),
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
            latest_response_version: 0,
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
mod tests;

#[cfg(test)]
mod lifecycle_tests;

#[cfg(test)]
mod retention_tests;

#[cfg(test)]
mod admission_tests;

#[cfg(test)]
mod stop_tests;

#[cfg(test)]
mod switch_tests;

#[cfg(test)]
mod stream_tests;

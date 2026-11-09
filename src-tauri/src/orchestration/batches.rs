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
    pub started: bool,
}

pub(super) fn eligible(data: &Stored, task: &Task) -> bool {
    let Some(run) = data.runs.get(&task.run_id) else {
        return false;
    };
    let person = data
        .agent_queue
        .get(&task.id)
        .is_some_and(|q| matches!(q.by, QueueBy::Person { .. }));
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
        && (task.stopped.is_none() || person)
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
        .filter(|a| a.task_id == task.id)
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
    head.run_id == candidate.run_id
        && head.assignee == candidate.assignee
        && workspaces::task_root(run, head.destination.as_ref())
            == workspaces::task_root(run, candidate.destination.as_ref())
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
        let batch = data.batches.iter().find(|b| b.agent_id == id && b.status != BatchStatus::Settled);
        let block = data.agent_blocks.get(&id);
        if queued == 0 && batch.is_none() && block.is_none() { return None; }
        let mut lane = json!({ "agentId": id, "state": if block.is_some() { "blocked" } else if batch.is_some() { "working" } else { "idle" }, "queued": queued });
        if let Some(b) = batch { lane["batch"] = json!({ "id": b.id, "runId": b.run_id, "branch": b.branch, "taskIds": b.task_ids }); }
        if let Some(reason) = block { lane["blockedReason"] = json!(reason); }
        Some(lane)
    }).collect()
}

impl OrchestrationStore {
    pub(super) fn sync_agent_queue(&self) -> Result<(), String> {
        if crate::scheduling::load()?.orientation != Orientation::Agents {
            return Ok(());
        }
        self.mutate(|data| {
            let tasks: Vec<_> = data
                .tasks
                .values()
                .filter(|t| {
                    eligible(data, t)
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
                        task.approved_at.unwrap_or(task.updated_at),
                    ),
                )?;
            }
            Ok(())
        })
    }

    pub fn batch_claim(&self, actor: &str, task_ids: Vec<String>) -> Result<Vec<Attempt>, String> {
        if !self.is_worker_chat(actor)? {
            return Err("Only a batch's own worker may claim its tasks.".into());
        }
        let settings = crate::scheduling::load()?;
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
            }
            let coordinator = data.runs[&batch.run_id].coordinator_chat_key.clone();
            let mut attempts = Vec::new();
            // The whole claim is one ledger transaction. A refused reservation
            // changes no task and consumes no retry, including earlier tasks.
            for id in &task_ids {
                let queued = data.agent_queue.get(id).cloned().ok_or("The task is no longer queued.")?;
                let (_, _, mut attempt, _) = Self::reserve_attempt_in(data, &coordinator, &queued.launch, queued.by.borrowed(), &settings)?;
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
            Ok(attempts)
        })
    }

    pub(super) fn settle_batches(&self) -> Result<(), String> {
        self.mutate_regardless("batch settlement", |data| {
            for batch in &mut data.batches {
                if batch.status == BatchStatus::Working
                    && batch.task_ids.iter().all(|id| {
                        data.attempts
                            .values()
                            .filter(|a| {
                                a.batch_id.as_deref() == Some(&batch.id) && &a.task_id == id
                            })
                            .all(|a| {
                                !matches!(
                                    a.status,
                                    AttemptStatus::Preparing | AttemptStatus::Running
                                ) && !(a.status == AttemptStatus::Blocked
                                    && data.gates.values().any(|g| {
                                        g.status == GateStatus::Open
                                            && g.task_id.as_deref() == Some(id)
                                    }))
                            })
                    })
                {
                    batch.status = BatchStatus::Settled;
                    batch.settled_at = Some(now_ms());
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
        self.mutate(|data| {
            if data
                .batches
                .iter()
                .any(|b| b.agent_id == agent && b.status != BatchStatus::Settled)
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
            if data
                .attempts
                .values()
                .filter(|a| a.run_id == run.id && attempt_is_unsettled(data, a))
                .count()
                >= usize::from(run.max_concurrent)
            {
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
                .filter(|t| t.id != head.id && compatible(data, &head, t))
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
                started: false,
            };
            data.batch_launches.insert(id, runtime.clone());
            data.batches.push(batch.clone());
            Ok(Some((batch, runtime)))
        })
    }

    fn block_batch(&self, batch: &Batch, reason: String) -> Result<(), String> {
        self.mutate_regardless("agent lane block", |data| {
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
            Ok(())
        })
    }

    fn start_batch_chat(
        &self,
        chats: Arc<ChatManager>,
        workspaces: &WorkspaceState,
        batch: &Batch,
        runtime: &BatchLaunch,
    ) -> Result<(), String> {
        let project_id = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            let head = &inner.data.tasks[&runtime.head];
            head.destination.as_ref().map_or_else(
                || inner.data.runs[&batch.run_id].workspace_id.clone(),
                |d| d.project_id.clone(),
            )
        };
        let project = workspace(workspaces, &project_id)?;
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
                prompt.push_str(&format!(
                    "\n\n{brief}\n\n{}",
                    crate::team::memory_brief(
                        &agent,
                        &crate::team::list(&crate::team::default_path(), None, true)?
                    )
                ));
            }
        }
        crate::agent_chat::chat_start_user_impl(
            chats,
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
        )?;
        self.mutate(|data| {
            data.batch_launches
                .get_mut(&batch.id)
                .ok_or("The batch disappeared.")?
                .started = true;
            data.agent_blocks.remove(&batch.agent_id);
            Ok(())
        })
    }

    pub(super) fn schedule_agent_batches(
        &self,
        chats: Arc<ChatManager>,
        workspaces: &WorkspaceState,
    ) -> Result<(), String> {
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
                        .filter(|l| l.started)
                        .map(|l| (b.clone(), l.clone()))
                })
                .collect()
        };
        for (batch, runtime) in awaiting {
            if !chats.turn_in_flight(&runtime.worker_chat_key) {
                match self.batch_claim(&runtime.worker_chat_key, vec![runtime.head.clone()]) {
                    Ok(attempts) => {
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
                    Err(error) => self.block_batch(&batch, error)?,
                }
            }
        }
        let settings = crate::scheduling::load()?;
        if settings.orientation != Orientation::Agents {
            return Ok(());
        }
        self.sync_agent_queue()?;
        // No ledger lock across roster reads or process/chat operations.
        let agents = crate::team::list(&crate::team::default_path(), None, true)?;
        for agent in agents {
            let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
            let Some((batch, runtime)) = self.begin_batch(&agent.id, &settings)? else {
                continue;
            };
            if let Err(reason) = self.start_batch_chat(chats.clone(), workspaces, &batch, &runtime)
            {
                self.block_batch(&batch, reason)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    fn worker() -> automation::WorkerSettings {
        automation::WorkerSettings {
            agent: ChatAgent::Codex,
            access: Access::Auto,
            model: Some("gpt-6.1-sol".into()),
            effort: Some("high".into()),
            recovery: None,
        }
    }
    fn assigned(store: &OrchestrationStore, run: &Run, at: i64) -> Task {
        let task = super::super::tests::task(store, run, vec![]);
        store
            .mutate(|data| {
                let task = data.tasks.get_mut(&task.id).unwrap();
                task.assignee = Some(TaskAssignee {
                    id: "agent_test".into(),
                    name: "Test".into(),
                });
                task.worker = Some(worker());
                task.approved_at = Some(at);
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
    fn settings() -> Settings {
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
            .batch_claim(&runtime.worker_chat_key, vec![older.id.clone()])
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
            .batch_claim("chat:master", vec![tasks[0].id.clone()])
            .is_err());
        assert!(store
            .batch_claim(&runtime.worker_chat_key, vec![tasks[1].id.clone()])
            .unwrap_err()
            .contains("head"));
        assert!(store
            .batch_claim(
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
                                .base_branch = "other-base".into()
                        }
                    }
                    Ok(())
                })
                .unwrap();
            assert!(
                store
                    .batch_claim(
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
        store
            .mutate(|data| {
                let task = data.tasks.get_mut(&task.id).unwrap();
                task.status = TaskStatus::Failed;
                task.retries_used = 2;
                Ok(())
            })
            .unwrap();
        queued_start(&store, &task, StartedBy::Page { retry_of: None });
        let before = store.inner.lock().unwrap().data.clone();
        assert!(before.attempts.is_empty());
        assert_eq!(before.tasks[&task.id].retries_used, 2);
        assert!(matches!(
            before.agent_queue[&task.id].by,
            QueueBy::Person { .. }
        ));
        let (_, runtime) = store
            .begin_batch("agent_test", &settings())
            .unwrap()
            .unwrap();
        let claims = store
            .batch_claim(&runtime.worker_chat_key, vec![task.id.clone()])
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

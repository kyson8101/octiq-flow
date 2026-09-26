//! Task workspaces outlive attempts. The persisted plan is the allocation;
//! a lease identifies the only worker allowed to write there.
use super::*;
use crate::git_ops::workflow::{self, DeliveryEvidence, WorkspaceMode, WorkspacePlan};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceState {
    Preparing,
    Ready,
    Retained,
    Cleaning,
    Cleaned,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspace {
    pub plan: WorkspacePlan,
    pub state: WorkspaceState,
    pub lease_attempt_id: Option<String>,
    pub delivery: Option<DeliveryEvidence>,
    #[serde(default)]
    pub abandoned: bool,
    #[serde(default)]
    pub cleanup_intent: Option<bool>,
    #[serde(default)]
    pub validation_paths: Vec<String>,
}

impl OrchestrationStore {
    pub(super) fn owned_task(&self, actor: &str, task_id: &str) -> Result<(Run, Task), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let task = inner
            .data
            .tasks
            .get(task_id)
            .ok_or("Task does not exist.")?
            .clone();
        let run = coordinator(&inner.data, &task.run_id, actor)?.clone();
        Ok((run, task))
    }

    pub(super) fn prepare_task_workspace(
        &self,
        chats: &ChatManager,
        run: &Run,
        task: &Task,
        attempt: &Attempt,
        previous: Option<&Attempt>,
        launch: &WorkerLaunch,
    ) -> Result<crate::git_ops::PreparedWorkspace, String> {
        let writable = launch.access != Access::Read;
        let saved = task.workspace.clone();
        let plan = if let Some(saved) = &saved {
            if saved.state == WorkspaceState::Cleaned || saved.abandoned {
                return Err("This workspace is closed. Create a new task for new work.".into());
            }
            if let Some(evidence) = &saved.delivery {
                if evidence.merged {
                    return Err(
                        "This workspace was merged. Create a new task for follow-up work.".into(),
                    );
                }
            }
            saved.plan.clone()
        } else if let Some(previous) = previous.filter(|a| !a.cwd.is_empty()) {
            // Legacy records can be adopted for retries, but are not silently
            // granted cleanup ownership over a person's existing checkout.
            let mut adopted = workflow::plan(&previous.cwd, "", &task.id, WorkspaceMode::Direct)?;
            if !previous.branch.is_empty() && previous.branch != adopted.branch {
                return Err("The previous attempt's branch changed.".into());
            }
            adopted.mode = if previous.is_worktree {
                WorkspaceMode::Worktree
            } else {
                WorkspaceMode::Direct
            };
            adopted
        } else {
            let mode = match run.workspace_mode {
                WorkspaceMode::Auto => {
                    if launch.access == Access::Read {
                        WorkspaceMode::Direct
                    } else if launch.new_worktree == Some(false) {
                        return Err("A first writing attempt in Auto mode uses an isolated worktree. Choose Current checkout for the run to edit it directly.".into());
                    } else {
                        WorkspaceMode::Worktree
                    }
                }
                mode => mode,
            };
            // A routed task starts from its destination repository; one
            // without a destination from the run's root, as it always has.
            let root = task
                .destination
                .as_ref()
                .map_or(run.root_path.as_str(), |d| d.repository.as_str());
            workflow::plan(root, &launch.base_branch, &task.id, mode)?
        };
        if writable
            && run.workspace_mode == WorkspaceMode::Auto
            && plan.mode == WorkspaceMode::Direct
            && previous.is_some_and(|a| a.access == Access::Read)
        {
            return Err("This Auto workspace was assigned for read-only work. Create a new writing task to isolate its changes, or use an explicitly chosen Current checkout run.".into());
        }
        // Serialize lifecycle operations, then claim the canonical checkout in
        // the store BEFORE any filesystem side effect. Another run sees it too.
        let old_chats = self.mutate(|data| {
            let current = data.attempts.get(&attempt.id).ok_or("Attempt disappeared.")?;
            if current.status != AttemptStatus::Preparing { return Err("Attempt is no longer preparing.".into()); }
            let mut old_chats = Vec::new();
            for other in data.tasks.values() {
                let Some(other_ws) = &other.workspace else { continue; };
                if !workflow::overlaps(&other_ws.plan.checkout_root, &plan.checkout_root) { continue; }
                if other_ws.state == WorkspaceState::Cleaning { return Err("Workspace cleanup is in progress.".into()); }
                if let Some(owner) = other_ws.lease_attempt_id.as_ref().and_then(|id| data.attempts.get(id)) {
                    if owner.id == attempt.id { continue; }
                    if writable && owner.access != Access::Read && attempt_is_unsettled(data, owner) {
                        return Err(format!("This checkout is already leased to task {}. Use Worktree mode or wait for its writer.", other.id));
                    }
                    if !attempt_is_unsettled(data, owner) { old_chats.push(owner.worker_chat_key.clone()); }
                }
            }
            for other in data.attempts.values().filter(|a| a.id != attempt.id && !a.cwd.is_empty() && attempt_is_unsettled(data, a)) {
                if writable && other.access != Access::Read && workflow::overlaps(&workflow::checkout_identity(&other.cwd)?, &plan.checkout_root) {
                    return Err(format!("This checkout is already leased to task {}.", other.task_id));
                }
            }
            let resource = TaskWorkspace { plan: plan.clone(), state: saved.as_ref().map_or(WorkspaceState::Preparing, |w| w.state),
                lease_attempt_id: Some(attempt.id.clone()), delivery: None, abandoned: false, cleanup_intent: None,
                validation_paths: saved.as_ref().map(|w| w.validation_paths.clone()).unwrap_or_default() };
            let task = data.tasks.get_mut(&task.id).ok_or("Task disappeared.")?;
            task.workspace = Some(resource);
            let current = data.attempts.get_mut(&attempt.id).unwrap();
            current.cwd = plan.cwd.clone(); current.branch = plan.branch.clone(); current.is_worktree = plan.mode == WorkspaceMode::Worktree;
            Ok(old_chats)
        })?;
        // Settled processes must actually stop before a new writer starts.
        for key in old_chats
            .into_iter()
            .chain(previous.map(|p| p.worker_chat_key.clone()))
        {
            crate::agent_chat::chat_stop_impl(chats, key)?;
        }
        chats.require_workspace_available(
            &plan.checkout_root,
            &attempt.worker_chat_key,
            &run.coordinator_chat_key,
            writable,
        )?;
        if saved
            .as_ref()
            .is_none_or(|w| w.state == WorkspaceState::Preparing)
        {
            workflow::provision(&plan)?;
        } else {
            workflow::verify(&plan)?;
        }
        self.mutate(|data| {
            let current = data
                .attempts
                .get(&attempt.id)
                .ok_or("Attempt disappeared.")?;
            if current.status != AttemptStatus::Preparing {
                return Err("Attempt stopped while its workspace was being prepared.".into());
            }
            let ws = data
                .tasks
                .get_mut(&task.id)
                .and_then(|t| t.workspace.as_mut())
                .ok_or("Workspace disappeared.")?;
            ws.state = WorkspaceState::Ready;
            Ok(())
        })?;
        Ok(crate::git_ops::PreparedWorkspace {
            cwd: plan.cwd,
            branch: plan.branch,
            is_repo: plan.is_repo,
            is_worktree: plan.mode == WorkspaceMode::Worktree,
        })
    }

    /// Keep browser Git mutations atomic with workspace lifecycle operations.
    /// User commits/pulls/branch changes must not race a running worker either.
    pub fn guard_git_operation(&self, path: &str) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        let guard = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        self.require_workspace_access("git-panel", path, true)?;
        Ok(guard)
    }

    /// Called from every managed chat launch/send. A coordinator may continue
    /// coordinating; its prompt forbids editing a checkout delegated to workers.
    pub fn require_workspace_access(
        &self,
        chat_key: &str,
        path: &str,
        writable: bool,
    ) -> Result<(), String> {
        if path.trim().is_empty() {
            return Ok(());
        }
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        if !inner.data.tasks.values().any(|t| {
            t.workspace.as_ref().is_some_and(|ws| {
                ws.lease_attempt_id.is_some() || ws.state == WorkspaceState::Cleaning
            })
        }) {
            return Ok(());
        }
        let checkout = workflow::checkout_identity(path)?;
        for task in inner.data.tasks.values() {
            let Some(ws) = &task.workspace else {
                continue;
            };
            if !workflow::overlaps(&checkout, &ws.plan.checkout_root) {
                continue;
            }
            if ws.state == WorkspaceState::Cleaning {
                return Err("This workspace is being cleaned up.".into());
            }
            if !writable {
                continue;
            }
            if let Some(owner) = ws
                .lease_attempt_id
                .as_ref()
                .and_then(|id| inner.data.attempts.get(id))
            {
                if owner.worker_chat_key == chat_key {
                    continue;
                }
                if inner
                    .data
                    .runs
                    .get(&task.run_id)
                    .is_some_and(|r| r.coordinator_chat_key == chat_key)
                {
                    continue;
                }
                if owner.access != Access::Read && attempt_is_unsettled(&inner.data, owner) {
                    return Err(format!("This checkout has an active writer for task {}. Wait or use a separate worktree.", task.title));
                }
            }
        }
        Ok(())
    }

    fn validation_task(&self, actor: &str, task_id: &str) -> Result<Task, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let task = inner
            .data
            .tasks
            .get(task_id)
            .ok_or("Task does not exist.")?;
        let run = inner
            .data
            .runs
            .get(&task.run_id)
            .ok_or("Run does not exist.")?;
        if actor != run.coordinator_chat_key
            && active_task_for_actor(&inner.data, actor)
                .as_ref()
                .map(|t| t.id.as_str())
                != Some(task_id)
        {
            return Err(
                "Only this task's active worker or coordinator can manage validation workspaces."
                    .into(),
            );
        }
        Ok(task.clone())
    }

    pub fn create_validation(
        &self,
        actor: &str,
        task_id: &str,
        base_sha: &str,
        commits: Vec<String>,
    ) -> Result<String, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let task = self.validation_task(actor, task_id)?;
        let ws = task.workspace.as_ref().ok_or("Task has no workspace.")?;
        if ws.state == WorkspaceState::Cleaned || ws.state == WorkspaceState::Cleaning {
            return Err("Workspace is closed.".into());
        }
        if commits.len() > 50 {
            return Err("Choose at most 50 commits for one validation checkout.".into());
        }
        let target = std::env::temp_dir()
            .canonicalize()
            .map_err(|e| e.to_string())?
            .join(format!("octiq-validation-{}", compact_id()));
        let path = target.to_string_lossy().into_owned();
        self.mutate(|data| {
            data.tasks
                .get_mut(task_id)
                .and_then(|t| t.workspace.as_mut())
                .ok_or("Workspace disappeared.")?
                .validation_paths
                .push(path.clone());
            Ok(())
        })?;
        let result = workflow::validation_worktree(&ws.plan, base_sha, &commits, &target);
        announce(&task.run_id, "validation_created");
        result.map(|_| path.clone()).map_err(|e| format!("{e} Validation allocation retained at {path}; inspect or remove it through orchestration_validation_remove."))
    }

    pub fn remove_validation(
        &self,
        actor: &str,
        task_id: &str,
        path: &str,
    ) -> Result<Task, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let task = self.validation_task(actor, task_id)?;
        let ws = task.workspace.as_ref().ok_or("Task has no workspace.")?;
        if !ws.validation_paths.iter().any(|p| p == path) {
            return Err("This task does not own that validation workspace.".into());
        }
        workflow::remove_validation(&ws.plan, path)?;
        self.mutate(|data| {
            let task = data.tasks.get_mut(task_id).ok_or("Task disappeared.")?;
            task.workspace
                .as_mut()
                .unwrap()
                .validation_paths
                .retain(|p| p != path);
            Ok(task.clone())
        })
        .inspect(|t| announce(&t.run_id, "validation_removed"))
    }

    pub fn refresh_workspace(&self, actor: &str, task_id: &str) -> Result<Task, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let (_, task) = self.owned_task(actor, task_id)?;
        let ws = task
            .workspace
            .as_ref()
            .ok_or("This task has no workspace yet.")?;
        if ws.state == WorkspaceState::Cleaned {
            return Ok(task);
        }
        let evidence = workflow::inspect(&ws.plan, true)?;
        self.mutate(|data| {
            let task = data.tasks.get_mut(task_id).ok_or("Task disappeared.")?;
            task.workspace
                .as_mut()
                .ok_or("Workspace disappeared.")?
                .delivery = Some(evidence);
            task.updated_at = now_ms();
            Ok(task.clone())
        })
        .inspect(|t| announce(&t.run_id, "workspace_refreshed"))
    }

    pub fn reopen_task(&self, actor: &str, task_id: &str, spec: String) -> Result<Task, String> {
        let spec = required_text("follow-up instructions", spec, 40_000)?;
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        self.mutate(|data| {
            let task = data.tasks.get(task_id).ok_or("Task does not exist.")?.clone();
            let run = coordinator(data, &task.run_id, actor)?;
            if run.status == RunStatus::Stopped { return Err("A stopped run cannot be reopened.".into()); }
            if run.archived_at.is_some() { return Err("This run is archived. Restore it before reopening a task.".into()); }
            if task.status != TaskStatus::Completed { return Err("Only a completed task can be reopened for review fixes. Use retry for failed or blocked tasks.".into()); }
            let ws = task.workspace.as_ref().ok_or("This task has no retained workspace.")?;
            if ws.state == WorkspaceState::Cleaned || ws.abandoned || ws.delivery.as_ref().is_some_and(|d| d.merged) {
                return Err("This workspace is closed. Create a new task for new work.".into());
            }
            // Reopening a prerequisite while its dependants have started would
            // silently invalidate those results. Ask for a new follow-up task.
            if data.tasks.values().any(|t| t.depends_on.contains(&task.id) && t.active_attempt_id.is_some()) {
                return Err("A dependent task already started. Create a separate follow-up task instead.".into());
            }
            for dependent in data.tasks.values_mut() {
                if dependent.depends_on.iter().any(|id| id == task_id) && dependent.status == TaskStatus::Ready {
                    dependent.status = TaskStatus::Pending;
                }
            }
            let task = data.tasks.get_mut(task_id).unwrap();
            task.spec = spec; task.status = TaskStatus::Ready; task.result = None; task.updated_at = now_ms();
            let result = task.clone();
            recompute_run(data, &result.run_id);
            Ok(result)
        }).inspect(|t| announce(&t.run_id, "task_reopened"))
    }

    pub fn cleanup_workspace(
        &self,
        chats: &ChatManager,
        actor: &str,
        task_id: &str,
        abandon: bool,
        expected_head: &str,
    ) -> Result<Task, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let (run, task) = self.owned_task(actor, task_id)?;
        let ws = task
            .workspace
            .as_ref()
            .ok_or("This task has no workspace.")?;
        if ws.state == WorkspaceState::Cleaned {
            return Ok(task);
        }
        if !ws.plan.managed || ws.plan.mode != WorkspaceMode::Worktree {
            return Err(
                "Current checkout and adopted workspaces cannot be cleaned up by this workflow."
                    .into(),
            );
        }
        self.mutate(|data| {
            if data
                .attempts
                .values()
                .any(|a| a.task_id == task_id && attempt_is_unsettled(data, a))
            {
                return Err("Stop or settle every worker before cleanup.".into());
            }
            if data
                .gates
                .values()
                .any(|g| g.task_id.as_deref() == Some(task_id) && g.status == GateStatus::Open)
            {
                return Err("Resolve the open decision before cleanup.".into());
            }
            for other in data.attempts.values().filter(|a| a.task_id != task_id && attempt_is_unsettled(data, a) && !a.cwd.is_empty()) {
                if workflow::overlaps(&workflow::checkout_identity(&other.cwd)?, &ws.plan.checkout_root) {
                    return Err("Another task is still using this checkout.".into());
                }
            }
            if abandon && data.tasks.values().any(|t| t.depends_on.iter().any(|id| id == task_id) && t.active_attempt_id.is_some()) {
                return Err("A dependent task already started. Preserve this workspace until that work is resolved.".into());
            }
            if data.tasks.values().filter(|t| t.id != task_id).any(|t| t.workspace.as_ref().is_some_and(|other| other.state != WorkspaceState::Cleaned && workflow::overlaps(&other.plan.checkout_root, &ws.plan.checkout_root))) {
                return Err("Another task retains this checkout. Preserve it until all workspace owners are resolved.".into());
            }
            if !abandon && task.status != TaskStatus::Completed {
                return Err("Complete the task or explicitly abandon it before cleanup.".into());
            }
            if !ws.validation_paths.is_empty() {
                return Err("Remove the task's validation worktrees before cleanup.".into());
            }
            data.tasks
                .get_mut(task_id)
                .unwrap()
                .workspace
                .as_mut()
                .unwrap()
                .state = WorkspaceState::Cleaning;
            Ok(())
        })?;
        let cleaned = (|| {
            let snapshot = self.snapshot(Some(&run.id))?;
            for attempt in snapshot.attempts.iter().filter(|a| a.task_id == task_id) {
                crate::agent_chat::chat_stop_impl(chats, attempt.worker_chat_key.clone())?;
            }
            chats.require_checkout_idle(&ws.plan.checkout_root)?;
            let evidence = workflow::inspect(&ws.plan, true)?;
            if expected_head.is_empty() || evidence.head_sha != expected_head {
                return Err(
                    "HEAD changed since the cleanup preview. Refresh delivery status first.".into(),
                );
            }
            if evidence.dirty {
                return Err(
                    "Workspace has uncommitted or untracked files. Preserve them before cleanup."
                        .into(),
                );
            }
            if !abandon && !evidence.merged {
                return Err(
                    "Merge could not be verified for this exact commit and base branch.".into(),
                );
            }
            if abandon && !evidence.pushed && evidence.has_commits {
                return Err("Push unpublished commits before abandoning this workspace. Cleanup never discards commits.".into());
            }
            self.mutate(|data| {
                let workspace = data
                    .tasks
                    .get_mut(task_id)
                    .and_then(|t| t.workspace.as_mut())
                    .ok_or("Workspace disappeared.")?;
                workspace.delivery = Some(evidence.clone());
                workspace.cleanup_intent = Some(abandon);
                Ok(())
            })?;
            workflow::cleanup(&ws.plan, &evidence.head_sha)?;
            Ok(evidence)
        })();
        let result = self.mutate(|data| {
            let task = data.tasks.get_mut(task_id).ok_or("Task disappeared.")?;
            let ws = task.workspace.as_mut().unwrap();
            ws.cleanup_intent = None;
            match &cleaned {
                Ok(evidence) => {
                    ws.state = WorkspaceState::Cleaned;
                    ws.lease_attempt_id = None;
                    ws.delivery = Some(evidence.clone());
                    ws.abandoned = abandon;
                    if abandon {
                        task.status = TaskStatus::Cancelled;
                    }
                }
                Err(_) => ws.state = WorkspaceState::Retained,
            }
            task.updated_at = now_ms();
            let result = task.clone();
            if cleaned.is_ok() && abandon {
                let mut cancelled = BTreeSet::from([task_id.to_string()]);
                loop {
                    let mut added = false;
                    for dependent in data.tasks.values_mut() {
                        if dependent.active_attempt_id.is_none()
                            && dependent.status != TaskStatus::Cancelled
                            && dependent.depends_on.iter().any(|id| cancelled.contains(id))
                        {
                            dependent.status = TaskStatus::Cancelled;
                            dependent.result =
                                Some("A prerequisite workspace was abandoned.".into());
                            cancelled.insert(dependent.id.clone());
                            added = true;
                        }
                    }
                    if !added {
                        break;
                    }
                }
            }
            recompute_run(data, &run.id);
            Ok(result)
        })?;
        announce(&run.id, "workspace_cleanup");
        cleaned.map(|_| result)
    }
}

pub(super) fn recover_workspaces(data: &mut Stored) -> bool {
    let mut changed = false;
    for task in data.tasks.values_mut() {
        if let Some(ws) = task.workspace.as_mut() {
            changed |= ws.lease_attempt_id.take().is_some();
            if ws.state == WorkspaceState::Cleaning {
                let removed = !Path::new(&ws.plan.checkout_root).exists();
                if removed && ws.cleanup_intent.is_some() {
                    ws.state = WorkspaceState::Cleaned;
                    ws.abandoned = ws.cleanup_intent == Some(true);
                    if ws.abandoned {
                        task.status = TaskStatus::Cancelled;
                    }
                } else {
                    ws.state = WorkspaceState::Retained;
                }
                ws.cleanup_intent = None;
                changed = true;
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_ops::workflow::tests::Repo;
    fn setup(repo: &Repo, mode: WorkspaceMode) -> (OrchestrationStore, Run, Task) {
        let store = OrchestrationStore::default();
        let run = store
            .create_run_with_mode(
                "chat:master".into(),
                "Build feature".into(),
                "project".into(),
                repo.root.clone(),
                Some(4),
                mode,
            )
            .unwrap();
        let task = super::super::tests::task(&store, &run, vec![]);
        (store, run, task)
    }
    fn prepare(store: &OrchestrationStore, task: &Task, access: Access) -> Result<Attempt, String> {
        let launch = WorkerLaunch {
            task_id: task.id.clone(),
            agent: ChatAgent::Codex,
            access,
            model: None,
            effort: None,
            new_worktree: None,
            base_branch: String::new(),
        };
        let (run, task, reserved, previous) = store.reserve_attempt("chat:master", &launch)?;
        let workspace = store.prepare_task_workspace(
            &ChatManager::default(),
            &run,
            &task,
            &reserved,
            previous.as_ref(),
            &launch,
        )?;
        store.activate_attempt(
            &reserved.id,
            workspace.cwd,
            workspace.branch,
            workspace.is_worktree,
        )
    }
    fn report(store: &OrchestrationStore, attempt: &Attempt, outcome: WorkerOutcome) {
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id.clone(),
                    outcome,
                    summary: "Verified result".into(),
                    files_modified: vec![],
                },
            )
            .unwrap();
    }
    #[test]
    fn a_destination_removed_after_approval_fails_the_attempt_instead_of_redirecting() {
        let (coordinator, api) = (Repo::new(), Repo::new());
        let (store, run, _) = setup(&coordinator, WorkspaceMode::Auto);
        let task = store
            .create_task_for(
                "chat:master",
                run.id.clone(),
                "API".into(),
                "Change the API".into(),
                vec![],
                None,
                None,
                None,
                Some(TaskDestination {
                    project_id: "shop".into(),
                    project_name: "Shop".into(),
                    repository: api.root.clone(),
                }),
            )
            .unwrap();
        // The run's own project is still registered; the destination is not.
        let projects: Vec<crate::workspaces::Workspace> = serde_json::from_value(json!([
            { "id": "project", "name": "Coordinator", "primary_path": coordinator.root },
        ]))
        .unwrap();
        let err = store
            .start_worker(
                Arc::new(ChatManager::default()),
                &crate::workspaces::WorkspaceState::with_projects(projects),
                "chat:master",
                WorkerLaunch {
                    task_id: task.id.clone(),
                    agent: ChatAgent::Codex,
                    access: Access::Auto,
                    model: None,
                    effort: None,
                    new_worktree: None,
                    base_branch: String::new(),
                },
            )
            .unwrap_err();
        assert!(err.contains("Shop is no longer registered"), "{err}");
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let attempt = snapshot
            .attempts
            .iter()
            .find(|a| a.task_id == task.id)
            .unwrap();
        assert_eq!(attempt.status, AttemptStatus::Failed);
        // Nothing was prepared anywhere, least of all in the coordinator's repo.
        assert!(attempt.cwd.is_empty());
        let task = snapshot.tasks.iter().find(|t| t.id == task.id).unwrap();
        assert!(task.workspace.is_none());
    }
    #[test]
    fn capacity_recovery_reuses_the_lease_branch_and_uncommitted_work() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Auto);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        fs::write(
            Path::new(&first.cwd).join("completed.txt"),
            "completed work",
        )
        .unwrap();
        store
            .observe_worker_event(
                &first.worker_chat_key,
                &json!({"type":"turn.failed", "error":{"message":"Selected model is at capacity"}}),
            )
            .unwrap();
        store
            .mutate(|data| {
                data.attempts
                    .get_mut(&first.id)
                    .unwrap()
                    .execution
                    .next_retry_at = Some(now_ms() - 1);
                Ok(())
            })
            .unwrap();
        let launch = WorkerLaunch {
            task_id: task.id,
            agent: first.agent,
            access: first.access,
            model: first.model.clone(),
            effort: first.effort.clone(),
            new_worktree: Some(false),
            base_branch: String::new(),
        };
        let (run, task, reserved, previous) = store
            .reserve_attempt_for("chat:master", &launch, Some(&first.id))
            .unwrap();
        let workspace = store
            .prepare_task_workspace(
                &ChatManager::default(),
                &run,
                &task,
                &reserved,
                previous.as_ref(),
                &launch,
            )
            .unwrap();
        assert_ne!(reserved.id, first.id);
        assert_eq!(reserved.execution.retry_count, 1);
        assert_eq!(workspace.cwd, first.cwd);
        assert_eq!(workspace.branch, first.branch);
        assert_eq!(
            fs::read_to_string(Path::new(&workspace.cwd).join("completed.txt")).unwrap(),
            "completed work"
        );
        let task = store.snapshot(Some(&run.id)).unwrap().tasks.remove(0);
        assert_eq!(
            task.workspace.unwrap().lease_attempt_id.as_deref(),
            Some(reserved.id.as_str())
        );
    }

    #[test]
    fn a_routed_task_works_in_its_destination_repository_and_retries_there() {
        let (coordinator, api) = (Repo::new(), Repo::new());
        let (store, run, _) = setup(&coordinator, WorkspaceMode::Auto);
        let task = store
            .create_task_for(
                "chat:master",
                run.id.clone(),
                "API".into(),
                "Change the API".into(),
                vec![],
                None,
                None,
                None,
                Some(TaskDestination {
                    project_id: "shop".into(),
                    project_name: "Shop".into(),
                    repository: api.root.clone(),
                }),
            )
            .unwrap();
        let first = prepare(&store, &task, Access::Auto).unwrap();
        assert!(first.is_worktree);
        let plan = store
            .snapshot(Some(&run.id))
            .unwrap()
            .tasks
            .into_iter()
            .find(|t| t.id == task.id)
            .and_then(|t| t.workspace)
            .unwrap()
            .plan;
        assert_eq!(plan.repository_root, api.root);
        assert_ne!(plan.repository_root, coordinator.root);
        assert!(api
            .git(&["branch", "--list", &first.branch])
            .contains(&first.branch));
        assert!(!coordinator
            .git(&["branch", "--list", &first.branch])
            .contains(&first.branch));
        std::fs::write(Path::new(&first.cwd).join("pending.txt"), "kept").unwrap();
        report(&store, &first, WorkerOutcome::Failed);
        let retry = prepare(&store, &task, Access::Auto).unwrap();
        assert_ne!(retry.id, first.id);
        assert_eq!(
            (retry.cwd.as_str(), retry.branch.as_str()),
            (first.cwd.as_str(), first.branch.as_str())
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&retry.cwd).join("pending.txt")).unwrap(),
            "kept"
        );
        let task = store
            .snapshot(Some(&run.id))
            .unwrap()
            .tasks
            .into_iter()
            .find(|t| t.id == task.id)
            .unwrap();
        assert_eq!(task.destination.unwrap().repository, api.root);
    }

    #[test]
    fn retry_and_review_reuse_workspace_and_preserve_uncommitted_changes() {
        let repo = Repo::new();
        let (store, run, task) = setup(&repo, WorkspaceMode::Auto);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        assert!(first.is_worktree);
        std::fs::write(Path::new(&first.cwd).join("pending.txt"), "preserved").unwrap();
        report(&store, &first, WorkerOutcome::Blocked);
        let retry = prepare(&store, &task, Access::Auto).unwrap();
        assert_ne!(retry.id, first.id);
        assert_eq!(retry.cwd, first.cwd);
        assert_eq!(retry.branch, first.branch);
        assert_eq!(
            std::fs::read_to_string(Path::new(&retry.cwd).join("pending.txt")).unwrap(),
            "preserved"
        );
        report(&store, &retry, WorkerOutcome::Completed);
        assert_eq!(
            store.snapshot(Some(&run.id)).unwrap().runs[0].status,
            RunStatus::Completed
        );
        store
            .reopen_task("chat:master", &task.id, "Address review".into())
            .unwrap();
        let next = prepare(&store, &task, Access::Auto).unwrap();
        assert_eq!(next.cwd, first.cwd);
        assert_ne!(next.id, retry.id);
        assert!(store
            .report_worker(
                &retry.worker_chat_key,
                WorkerReport {
                    attempt_id: retry.id,
                    outcome: WorkerOutcome::Completed,
                    summary: "late".into(),
                    files_modified: vec![]
                }
            )
            .unwrap_err()
            .contains("stale"));
    }
    #[test]
    fn direct_limits_concurrency_and_cross_run_lease_blocks_a_second_writer() {
        let repo = Repo::new();
        let (store, run, task) = setup(&repo, WorkspaceMode::Direct);
        assert_eq!(run.max_concurrent, 1);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        assert_eq!(first.cwd, repo.root);
        assert_eq!(first.branch, "main");
        let second_run = store
            .create_run_with_mode(
                "chat:master".into(),
                "Another run".into(),
                "project".into(),
                repo.root.clone(),
                Some(4),
                WorkspaceMode::Direct,
            )
            .unwrap();
        let second_task = super::super::tests::task(&store, &second_run, vec![]);
        assert!(prepare(&store, &second_task, Access::Auto)
            .unwrap_err()
            .contains("leased"));
        assert!(store
            .require_workspace_access("chat:other", &repo.root, true)
            .unwrap_err()
            .contains("active writer"));
        assert!(store
            .require_workspace_access("chat:other", &repo.root, false)
            .is_ok());
        assert!(store.guard_git_operation(&repo.root).is_err());
        assert!(store
            .cleanup_workspace(
                &ChatManager::default(),
                "chat:master",
                &task.id,
                true,
                "head"
            )
            .unwrap_err()
            .contains("Current checkout"));
    }
    #[test]
    fn independent_worktrees_can_write_in_parallel_and_auto_readers_reuse_root() {
        let repo = Repo::new();
        let (store, run, task) = setup(&repo, WorkspaceMode::Auto);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        let second = prepare(
            &store,
            &super::super::tests::task(&store, &run, vec![]),
            Access::Auto,
        )
        .unwrap();
        let reader = prepare(
            &store,
            &super::super::tests::task(&store, &run, vec![]),
            Access::Read,
        )
        .unwrap();
        assert_ne!(first.cwd, second.cwd);
        assert_eq!(reader.cwd, repo.root);
        assert!(!reader.is_worktree);
    }
    #[test]
    fn cleanup_requires_settlement_preservation_and_authority() {
        let repo = Repo::new();
        let (store, _run, task) = setup(&repo, WorkspaceMode::Worktree);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        let head = repo.git(&["rev-parse", "HEAD"]);
        let manager = ChatManager::default();
        assert!(store
            .cleanup_workspace(&manager, "chat:master", &task.id, true, &head)
            .unwrap_err()
            .contains("settle"));
        report(&store, &first, WorkerOutcome::Completed);
        assert!(store
            .cleanup_workspace(&manager, &first.worker_chat_key, &task.id, true, &head)
            .is_err());
        assert!(store
            .cleanup_workspace(&manager, "chat:master", &task.id, false, &head)
            .unwrap_err()
            .contains("Merge"));
        let unpublished = repo.commit(&first.cwd, "work.txt", "unpublished");
        assert!(store
            .cleanup_workspace(&manager, "chat:master", &task.id, true, &unpublished)
            .unwrap_err()
            .contains("Push unpublished"));
        assert!(Path::new(&first.cwd).is_dir());
    }
    #[test]
    fn explicit_abandon_removes_only_a_clean_managed_tree_and_keeps_branch() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Worktree);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        report(&store, &first, WorkerOutcome::Completed);
        let head = repo.git(&["rev-parse", "HEAD"]);
        let cleaned = store
            .cleanup_workspace(
                &ChatManager::default(),
                "chat:master",
                &task.id,
                true,
                &head,
            )
            .unwrap();
        assert_eq!(cleaned.workspace.unwrap().state, WorkspaceState::Cleaned);
        assert_eq!(cleaned.status, TaskStatus::Cancelled);
        assert!(!Path::new(&first.cwd).exists());
        assert_eq!(repo.git(&["rev-parse", &first.branch]), head);
        assert!(store
            .reopen_task("chat:master", &task.id, "resume".into())
            .is_err());
    }
    #[test]
    fn restart_recovers_lease_but_retains_exact_workspace_and_dirty_files() {
        let repo = Repo::new();
        let store_path = repo.dir.join("orchestrations.json");
        let store = OrchestrationStore::load(store_path.clone());
        let run = store
            .create_run_with_mode(
                "chat:master".into(),
                "Restart".into(),
                "project".into(),
                repo.root.clone(),
                None,
                WorkspaceMode::Auto,
            )
            .unwrap();
        let task = super::super::tests::task(&store, &run, vec![]);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        std::fs::write(Path::new(&first.cwd).join("keep.txt"), "keep").unwrap();
        let recovered = OrchestrationStore::load(store_path);
        let snapshot = recovered.snapshot(Some(&run.id)).unwrap();
        assert_eq!(snapshot.attempts[0].status, AttemptStatus::Failed);
        assert!(snapshot.tasks[0]
            .workspace
            .as_ref()
            .unwrap()
            .lease_attempt_id
            .is_none());
        let retry = prepare(&recovered, &task, Access::Auto).unwrap();
        assert_eq!(retry.cwd, first.cwd);
        assert!(Path::new(&retry.cwd).join("keep.txt").exists());
    }
    #[test]
    fn validation_paths_are_owned_and_block_parent_cleanup() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Worktree);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        let base = repo.git(&["rev-parse", "HEAD"]);
        let path = store
            .create_validation(&first.worker_chat_key, &task.id, &base, vec![])
            .unwrap();
        assert!(store
            .remove_validation("chat:outsider", &task.id, &path)
            .is_err());
        assert!(store
            .remove_validation("chat:master", &task.id, &first.cwd)
            .is_err());
        report(&store, &first, WorkerOutcome::Completed);
        assert!(store
            .cleanup_workspace(
                &ChatManager::default(),
                "chat:master",
                &task.id,
                true,
                &base
            )
            .unwrap_err()
            .contains("validation"));
        store
            .remove_validation("chat:master", &task.id, &path)
            .unwrap();
        assert!(!Path::new(&path).exists());
        assert!(Path::new(&first.cwd).exists());
    }
    #[test]
    fn reopening_a_prerequisite_makes_unstarted_dependants_wait_again() {
        let repo = Repo::new();
        let (store, run, task) = setup(&repo, WorkspaceMode::Auto);
        let dependant = super::super::tests::task(&store, &run, vec![task.id.clone()]);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        report(&store, &first, WorkerOutcome::Completed);
        assert_eq!(
            store
                .owned_task("chat:master", &dependant.id)
                .unwrap()
                .1
                .status,
            TaskStatus::Ready
        );
        store
            .reopen_task("chat:master", &task.id, "Review fix".into())
            .unwrap();
        assert_eq!(
            store
                .owned_task("chat:master", &dependant.id)
                .unwrap()
                .1
                .status,
            TaskStatus::Pending
        );
    }

    #[test]
    fn a_legacy_flag_cannot_override_auto_policy_for_a_first_writer() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Auto);
        let launch = WorkerLaunch {
            task_id: task.id.clone(),
            agent: ChatAgent::Codex,
            access: Access::Auto,
            model: None,
            effort: None,
            new_worktree: Some(false),
            base_branch: String::new(),
        };
        let (run, task, reserved, previous) =
            store.reserve_attempt("chat:master", &launch).unwrap();
        assert!(store
            .prepare_task_workspace(
                &ChatManager::default(),
                &run,
                &task,
                &reserved,
                previous.as_ref(),
                &launch
            )
            .unwrap_err()
            .contains("first writing attempt"));
        assert_eq!(repo.git(&["status", "--porcelain"]), "");
    }

    #[test]
    fn a_read_only_auto_checkout_cannot_be_silently_upgraded_to_a_writer_on_retry() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Auto);
        let first = prepare(&store, &task, Access::Read).unwrap();
        report(&store, &first, WorkerOutcome::Blocked);
        assert!(prepare(&store, &task, Access::Auto)
            .unwrap_err()
            .contains("read-only work"));
        assert_eq!(repo.git(&["status", "--porcelain"]), "");
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::git_ops::workflow::tests::Repo;
    #[test]
    fn recovery_finishes_verified_cleanup_intent_without_claiming_an_unverified_merge() {
        let repo = Repo::new();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let task = super::super::tests::task(&store, &run, vec![]);
        let plan = workflow::plan(&repo.root, "main", &task.id, WorkspaceMode::Worktree).unwrap();
        store
            .mutate(|data| {
                data.tasks.get_mut(&task.id).unwrap().workspace = Some(TaskWorkspace {
                    plan,
                    state: WorkspaceState::Cleaning,
                    lease_attempt_id: Some("old".into()),
                    delivery: None,
                    abandoned: false,
                    cleanup_intent: Some(true),
                    validation_paths: vec![],
                });
                assert!(recover_workspaces(data));
                let task = &data.tasks[&task.id];
                assert_eq!(task.status, TaskStatus::Cancelled);
                let ws = task.workspace.as_ref().unwrap();
                assert_eq!(ws.state, WorkspaceState::Cleaned);
                assert!(ws.abandoned);
                assert!(ws.lease_attempt_id.is_none());
                Ok(())
            })
            .unwrap();
    }
    #[test]
    fn coordinator_gate_cannot_resurrect_a_settled_attempt() {
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let worker = super::super::tests::running_worker(&store, &run);
        store
            .report_worker(
                &worker.worker_chat_key,
                WorkerReport {
                    attempt_id: worker.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: vec![],
                },
            )
            .unwrap();
        assert!(store
            .create_gate(
                "chat:master",
                run.id,
                Some(worker.task_id),
                "Continue?".into(),
                vec![]
            )
            .unwrap_err()
            .contains("settled"));
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    #[test]
    fn version_one_is_migrated_and_new_records_cannot_be_silently_overwritten_by_an_old_backend() {
        let root = std::env::temp_dir().join(format!("octiq-workflow-migration-{}", compact_id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("orchestrations.json");
        std::fs::write(
            &path,
            r#"{"version":1,"runs":{},"tasks":{},"attempts":{},"gates":{},"messages":{}}"#,
        )
        .unwrap();
        let store = OrchestrationStore::load(path.clone());
        assert!(store.snapshot(None).unwrap().runs.is_empty());
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted["version"], STORE_VERSION);
        let _ = std::fs::remove_dir_all(root);
    }
}

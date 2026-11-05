//! Copy ledger facts under its lock, then release it before any Git/chat work.
use super::*;
use crate::worktree_lifespan::{Allocation, Owner};

fn unfinished(status: TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Pending | TaskStatus::Ready | TaskStatus::Running | TaskStatus::Blocked
    )
}
impl OrchestrationStore {
    pub(crate) fn lifespan_allocations(&self) -> Result<Vec<Allocation>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let data = &inner.data;
        let mut found = Vec::new();
        for task in data.tasks.values() {
            let Some(ws) = &task.workspace else { continue };
            if ws.state == workspaces::WorkspaceState::Cleaned {
                continue;
            }
            let Some(run) = data.runs.get(&task.run_id) else {
                return Err("Workspace has no owning run; no sweep is safe.".into());
            };
            let attempts: Vec<_> = data
                .attempts
                .values()
                .filter(|a| a.task_id == task.id)
                .collect();
            let chats = attempts.iter().map(|a| a.worker_chat_key.clone()).collect();
            let last = attempts
                .iter()
                .map(|a| a.updated_at.max(a.finished_at.unwrap_or(0)))
                .fold(task.updated_at, i64::max);
            let open = data
                .gates
                .values()
                .any(|g| g.run_id == run.id && g.status == GateStatus::Open);
            let active = if attempts.iter().any(|a| attempt_is_unsettled(data, a)) {
                Some("An unsettled attempt still uses this checkout.".into())
            } else if ws.lease_attempt_id.as_ref().is_some_and(|id| {
                data.attempts
                    .get(id)
                    .is_none_or(|a| attempt_is_unsettled(data, a))
            }) {
                Some("A worker still holds a checkout lease.".into())
            } else if matches!(
                ws.state,
                workspaces::WorkspaceState::Preparing | workspaces::WorkspaceState::Cleaning
            ) {
                Some("A workspace lifecycle operation is in progress.".into())
            } else if open {
                Some("The owning run has an open decision.".into())
            } else if !matches!(run.status, RunStatus::Stopped | RunStatus::Closed)
                && data
                    .tasks
                    .values()
                    .any(|t| t.run_id == run.id && unfinished(t.status))
            {
                Some("The owning run still has unfinished tasks that may use this checkout.".into())
            } else {
                None
            };
            let kind = if !ws.plan.is_managed_worktree() {
                "unknown"
            } else if ws.plan.mode == WorkspaceMode::Mission {
                "mission"
            } else if ws.plan.is_managed_worktree() {
                "task"
            } else {
                "unknown"
            };
            found.push(Allocation {
                path: ws.plan.checkout_root.clone(),
                repo: ws.plan.repository_root.clone(),
                branch: Some(ws.plan.branch.clone()),
                base: ws.plan.base_branch.clone(),
                last_activity: last,
                active: active.clone(),
                chats,
                owner: Owner {
                    kind: kind.into(),
                    label: if kind == "mission" {
                        run.objective.clone()
                    } else {
                        task.title.clone()
                    },
                    run_id: Some(run.id.clone()),
                    task_id: Some(task.id.clone()),
                    chat_key: None,
                },
                swept_at: ws.swept_at,
                reconcilable: matches!(
                    ws.state,
                    workspaces::WorkspaceState::Ready | workspaces::WorkspaceState::Retained
                ),
            });
            for path in &ws.validation_paths {
                found.push(Allocation {
                    path: path.clone(),
                    repo: ws.plan.repository_root.clone(),
                    branch: None,
                    base: ws.plan.base_branch.clone(),
                    last_activity: last,
                    active: active.clone().or_else(|| {
                        (!matches!(
                            run.status,
                            RunStatus::Completed
                                | RunStatus::Failed
                                | RunStatus::Stopped
                                | RunStatus::Closed
                        ))
                        .then(|| "The validation checkout's run has not ended.".into())
                    }),
                    chats: Vec::new(),
                    owner: Owner {
                        kind: "validation".into(),
                        label: format!("Validation: {}", task.title),
                        run_id: Some(run.id.clone()),
                        task_id: Some(task.id.clone()),
                        chat_key: None,
                    },
                    swept_at: None,
                    reconcilable: true,
                });
            }
        }
        Ok(found)
    }
    /// Called with the workspace lifecycle held. Never changes task state,
    /// closes a mission, abandons a task or deletes a branch.
    pub(crate) fn lifespan_record_swept(&self, path: &str, at: i64) -> Result<(), String> {
        self.mutate_regardless("worktree sweep outcome", |data| {
            for task in data.tasks.values_mut() {
                if let Some(ws) = &mut task.workspace {
                    if Path::new(&ws.plan.checkout_root) == Path::new(path)
                        && ws.plan.is_managed_worktree()
                    {
                        ws.swept_at = Some(at);
                    }
                    ws.validation_paths
                        .retain(|p| Path::new(p) != Path::new(path));
                }
            }
            for run in data.runs.values_mut() {
                for delivery in &mut run.mission_delivery {
                    if Path::new(&delivery.checkout_root) == Path::new(path) {
                        delivery.swept_at = Some(at);
                    }
                }
            }
            Ok(())
        })
    }
    pub(crate) fn lifespan_delivery(
        &self,
        path: &str,
        evidence: &crate::git_ops::workflow::DeliveryEvidence,
    ) -> Result<(), String> {
        self.mutate(|data| {
            let mut mission_plans = Vec::new();
            for task in data.tasks.values_mut() {
                if let Some(ws) = &mut task.workspace {
                    if Path::new(&ws.plan.checkout_root) == Path::new(path) {
                        let mut refreshed = evidence.clone();
                        if let Some(old) = ws
                            .delivery
                            .as_ref()
                            .filter(|old| old.head_sha == evidence.head_sha)
                        {
                            refreshed.merged |= old.merged;
                            refreshed.pull_request = old.pull_request.clone();
                            refreshed.review_state = old.review_state.clone();
                            refreshed.released = old.released;
                            refreshed.release_note = old.release_note.clone();
                        }
                        ws.delivery = Some(refreshed);
                        if ws.plan.mode == WorkspaceMode::Mission && ws.plan.managed {
                            mission_plans.push((task.run_id.clone(), ws.plan.clone()));
                        }
                    }
                }
            }
            for (run_id, plan) in mission_plans {
                let run = data.runs.get_mut(&run_id).ok_or("Mission disappeared.")?;
                if let Some(d) = run
                    .mission_delivery
                    .iter_mut()
                    .find(|d| Path::new(&d.checkout_root) == Path::new(path))
                {
                    let same = d.evidence.head_sha == evidence.head_sha;
                    let mut refreshed = evidence.clone();
                    refreshed.merged |= same && d.merged;
                    d.evidence = refreshed;
                    d.merged = d.evidence.merged;
                    if !same {
                        d.released = None;
                        d.release_note.clear();
                    }
                } else {
                    run.mission_delivery.push(mission::MissionDelivery {
                        repository_root: plan.repository_root,
                        checkout_root: plan.checkout_root,
                        branch: plan.branch,
                        base_branch: plan.base_branch,
                        evidence: evidence.clone(),
                        merged: evidence.merged,
                        released: None,
                        release_note: String::new(),
                        removed: false,
                        swept_at: None,
                        branch_deleted: false,
                    });
                }
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn swept_root_releases_path_and_keeps_state_validations_and_mission_open() {
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let task = super::super::tests::task(&store, &run, vec![]);
        let root = crate::test_dir::TestDir::new("lifespan-ledger");
        let root = root.to_string_lossy().into_owned();
        store
            .mutate(|data| {
                let t = data.tasks.get_mut(&task.id).unwrap();
                t.status = TaskStatus::Completed;
                t.workspace = Some(workspaces::TaskWorkspace {
                    plan: crate::git_ops::workflow::WorkspacePlan {
                        mode: WorkspaceMode::Mission,
                        cwd: root.clone(),
                        checkout_root: root.clone(),
                        repository_root: run.root_path.clone(),
                        branch: "feature/mission".into(),
                        base_branch: "develop".into(),
                        base_sha: "base".into(),
                        managed: true,
                        is_repo: true,
                        warnings: vec![],
                        initial_status: String::new(),
                    },
                    swept_at: None,
                    state: workspaces::WorkspaceState::Retained,
                    lease_attempt_id: None,
                    delivery: None,
                    abandoned: false,
                    cleanup_intent: None,
                    validation_paths: vec![format!("{root}/validation")],
                });
                Ok(())
            })
            .unwrap();
        assert!(store
            .disk_report_workspaces()
            .unwrap()
            .contains(Path::new(&root)));
        store
            .lifespan_delivery(
                &root,
                &crate::git_ops::workflow::DeliveryEvidence {
                    head_sha: "saved-head".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        store.lifespan_record_swept(&root, 123).unwrap();
        let paths = store.disk_report_workspaces().unwrap();
        assert!(!paths.contains(Path::new(&root)));
        assert!(paths.contains(&PathBuf::from(format!("{root}/validation"))));
        let facts = store.lifespan_allocations().unwrap();
        let a = facts.iter().find(|a| a.path == root).unwrap();
        assert_eq!(a.swept_at, Some(123));
        assert_eq!(a.owner.kind, "mission");
        let inner = store.inner.lock().unwrap();
        let ws = inner.data.tasks[&task.id].workspace.as_ref().unwrap();
        assert_eq!(ws.state, workspaces::WorkspaceState::Retained);
        assert!(!ws.abandoned);
        assert_ne!(inner.data.runs[&run.id].status, RunStatus::Closed);
        let mission = &inner.data.runs[&run.id].mission_delivery[0];
        assert_eq!(mission.swept_at, Some(123));
        assert!(!mission.removed);
        assert_eq!(mission.evidence.head_sha, "saved-head");
    }
}

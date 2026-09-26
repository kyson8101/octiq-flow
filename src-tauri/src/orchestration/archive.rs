//! Archiving hides a settled worker from navigation, retaining all delivery and
//! transcript history. It never removes a workspace or changes execution state.
use super::*;

fn require_archivable(data: &Stored, attempt: &Attempt) -> Result<(), String> {
    let task = data
        .tasks
        .get(&attempt.task_id)
        .ok_or("The task does not exist.")?;
    if task.status != TaskStatus::Completed
        || data
            .attempts
            .values()
            .any(|other| other.task_id == task.id && attempt_is_unsettled(data, other))
    {
        return Err("Complete the task and settle its workers before archiving.".into());
    }
    if data.gates.values().any(|gate| {
        gate.run_id == task.run_id
            && gate.status == GateStatus::Open
            && gate.task_id.as_deref().is_none_or(|id| id == task.id)
    }) {
        return Err("Resolve the open decision before archiving.".into());
    }
    let workspace = task
        .workspace
        .as_ref()
        .ok_or("Refresh delivery status to verify the task's merge before archiving.")?;
    if workspace.abandoned {
        return Err("Only workers for merged tasks can be archived.".into());
    }
    if !matches!(
        workspace.state,
        workspaces::WorkspaceState::Retained | workspaces::WorkspaceState::Cleaned
    ) || !workspace
        .delivery
        .as_ref()
        .is_some_and(|delivery| delivery.merged && !delivery.dirty)
    {
        return Err(
            "Refresh delivery status to verify a clean, merged task before archiving.".into(),
        );
    }
    Ok(())
}

impl OrchestrationStore {
    pub fn set_worker_archived(
        &self,
        chats: &ChatManager,
        actor: &str,
        attempt_id: &str,
        archived: bool,
    ) -> Result<Attempt, String> {
        // Never take a session lock while holding the ledger lock. Settled
        // attempts cannot be resumed, but may still be finishing their report.
        if archived {
            let snapshot = self.snapshot(None)?;
            let attempt = snapshot
                .attempts
                .iter()
                .find(|a| a.id == attempt_id)
                .ok_or("The worker attempt does not exist.")?;
            if chats.turn_in_flight(&attempt.worker_chat_key) {
                return Err("Wait for this worker's turn to finish before archiving.".into());
            }
        }
        self.mutate(|data| {
            let attempt = data
                .attempts
                .get(attempt_id)
                .ok_or("The worker attempt does not exist.")?;
            coordinator(data, &attempt.run_id, actor)?;
            if archived && attempt.archived_at.is_none() {
                require_archivable(data, attempt)?;
            }
            let attempt = data.attempts.get_mut(attempt_id).unwrap();
            // Retries are idempotent; restoring only changes visibility.
            if archived != attempt.archived_at.is_some() {
                let now = now_ms();
                attempt.archived_at = archived.then_some(now);
                attempt.updated_at = now;
            }
            Ok(attempt.clone())
        })
        .inspect(|attempt| announce(&attempt.run_id, "worker_archive_changed"))
    }

    pub fn archive_merged_workers(
        &self,
        chats: &ChatManager,
        actor: &str,
        run_id: &str,
    ) -> Result<Vec<Attempt>, String> {
        let in_flight: BTreeSet<_> = self
            .snapshot(Some(run_id))?
            .attempts
            .into_iter()
            .filter(|attempt| chats.turn_in_flight(&attempt.worker_chat_key))
            .map(|attempt| attempt.id)
            .collect();
        self.mutate(|data| {
            if coordinator(data, run_id, actor)?.status != RunStatus::Completed {
                return Err(
                    "Complete this run before archiving its merged workers together.".into(),
                );
            }
            let ids: Vec<_> = data
                .attempts
                .values()
                .filter(|attempt| {
                    attempt.run_id == run_id
                        && attempt.archived_at.is_none()
                        && !in_flight.contains(&attempt.id)
                        && require_archivable(data, attempt).is_ok()
                })
                .map(|attempt| attempt.id.clone())
                .collect();
            let now = now_ms();
            let mut archived = Vec::new();
            for id in ids {
                let attempt = data.attempts.get_mut(&id).unwrap();
                attempt.archived_at = Some(now);
                attempt.updated_at = now;
                archived.push(attempt.clone());
            }
            Ok(archived)
        })
        .inspect(|_| announce(run_id, "workers_archived"))
    }

    /// Hides a finished run from the run list, or brings it back. Visibility
    /// only: tasks, attempts, notifications, transcripts and workspaces are
    /// left exactly as the run ended, so restoring is lossless. A live run is
    /// refused rather than stopped here — stopping is its own confirmed step.
    pub fn set_run_archived(
        &self,
        actor: &str,
        run_id: &str,
        archived: bool,
    ) -> Result<Run, String> {
        self.mutate(|data| {
            let run = coordinator(data, run_id, actor)?;
            if archived && run.archived_at.is_none() && !retention::is_finished(run.status) {
                return Err("Stop this run before archiving it.".into());
            }
            let run = data.runs.get_mut(run_id).unwrap();
            // Retries are idempotent; the first archive time is kept.
            if archived != run.archived_at.is_some() {
                let now = now_ms();
                run.archived_at = archived.then_some(now);
                run.updated_at = now;
            }
            Ok(run.clone())
        })
        .inspect(|run| announce(&run.id, "run_archive_changed"))
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{run, running_worker};
    use super::*;
    use crate::git_ops::workflow::{DeliveryEvidence, WorkspacePlan};

    fn merged(store: &OrchestrationStore, run: &Run) -> Attempt {
        let attempt = running_worker(store, run);
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "Implemented and checked".into(),
                    files_modified: vec!["feature.rs".into()],
                },
            )
            .unwrap();
        store
            .mutate(|data| {
                data.tasks.get_mut(&attempt.task_id).unwrap().workspace = Some(TaskWorkspace {
                    plan: WorkspacePlan {
                        mode: WorkspaceMode::Direct,
                        cwd: "/retained/checkout".into(),
                        checkout_root: "/retained/checkout".into(),
                        repository_root: "/retained/checkout".into(),
                        branch: "develop".into(),
                        base_branch: "develop".into(),
                        base_sha: "base".into(),
                        managed: false,
                        is_repo: true,
                        warnings: Vec::new(),
                        initial_status: String::new(),
                    },
                    state: workspaces::WorkspaceState::Retained,
                    lease_attempt_id: None,
                    delivery: Some(DeliveryEvidence {
                        merged: true,
                        head_sha: "merged-head".into(),
                        checked_at: 10,
                        ..Default::default()
                    }),
                    abandoned: false,
                    cleanup_intent: None,
                    validation_paths: Vec::new(),
                });
                Ok(())
            })
            .unwrap();
        store
            .snapshot(None)
            .unwrap()
            .attempts
            .into_iter()
            .find(|a| a.id == attempt.id)
            .unwrap()
    }

    #[test]
    fn archive_and_restore_survive_reload_without_changing_task_or_workspace() {
        let dir = std::env::temp_dir().join(format!("octiq-archive-{}", compact_id()));
        let path = dir.join("orchestrations.json");
        let store = OrchestrationStore::load(path.clone());
        let run = run(&store);
        let worker = merged(&store, &run);
        let before = serde_json::to_value(&store.snapshot(None).unwrap().tasks).unwrap();
        let chats = ChatManager::default();
        let archived = store
            .set_worker_archived(&chats, "chat:master", &worker.id, true)
            .unwrap();
        assert!(archived.archived_at.is_some());
        assert_eq!(archived.summary, worker.summary);
        assert_eq!(archived.files_modified, worker.files_modified);
        assert_eq!(archived.status, worker.status);
        assert_eq!(
            store
                .set_worker_archived(&chats, "chat:master", &worker.id, true)
                .unwrap()
                .archived_at,
            archived.archived_at
        );
        let loaded = OrchestrationStore::load(path.clone());
        assert_eq!(
            loaded.snapshot(None).unwrap().attempts[0].archived_at,
            archived.archived_at
        );
        assert_eq!(
            serde_json::to_value(&loaded.snapshot(None).unwrap().tasks).unwrap(),
            before
        );
        assert!(loaded.require_user_chat(&worker.worker_chat_key).is_err());
        assert!(loaded
            .set_worker_archived(&chats, "chat:master", &worker.id, false)
            .unwrap()
            .archived_at
            .is_none());
        assert!(OrchestrationStore::load(path)
            .snapshot(None)
            .unwrap()
            .attempts[0]
            .archived_at
            .is_none());
        // Older ledgers have no visibility field and remain visible by default.
        let mut legacy = serde_json::to_value(&archived).unwrap();
        legacy.as_object_mut().unwrap().remove("archivedAt");
        assert!(serde_json::from_value::<Attempt>(legacy)
            .unwrap()
            .archived_at
            .is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn archive_requires_owner_settled_task_merge_and_no_open_decision() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = merged(&store, &run);
        let chats = ChatManager::default();
        for actor in ["chat:other", worker.worker_chat_key.as_str()] {
            assert!(store
                .set_worker_archived(&chats, actor, &worker.id, true)
                .unwrap_err()
                .contains("coordinator"));
            assert!(store
                .set_worker_archived(&chats, actor, &worker.id, false)
                .is_err());
        }
        let original = store.inner.lock().unwrap().data.clone();
        for invalid in [
            "running",
            "preparing",
            "failed_task",
            "missing_workspace",
            "unverified",
            "unmerged",
            "dirty",
            "abandoned",
            "cleaning",
            "task_gate",
            "run_gate",
        ] {
            store
                .mutate(|data| {
                    *data = original.clone();
                    match invalid {
                        "running" => {
                            data.attempts.get_mut(&worker.id).unwrap().status =
                                AttemptStatus::Running
                        }
                        "preparing" => {
                            data.attempts.get_mut(&worker.id).unwrap().status =
                                AttemptStatus::Preparing
                        }
                        "failed_task" => {
                            data.tasks.get_mut(&worker.task_id).unwrap().status = TaskStatus::Failed
                        }
                        "missing_workspace" => {
                            data.tasks.get_mut(&worker.task_id).unwrap().workspace = None
                        }
                        "task_gate" | "run_gate" => {
                            data.gates.insert(
                                "gate".into(),
                                Gate {
                                    id: "gate".into(),
                                    run_id: run.id.clone(),
                                    task_id: (invalid == "task_gate")
                                        .then(|| worker.task_id.clone()),
                                    created_by_chat_key: "chat:master".into(),
                                    target_chat_key: "chat:master".into(),
                                    question: "Choose".into(),
                                    options: Vec::new(),
                                    status: GateStatus::Open,
                                    resolution: None,
                                    created_at: 1,
                                    updated_at: 1,
                                },
                            );
                        }
                        _ => {
                            let ws = data
                                .tasks
                                .get_mut(&worker.task_id)
                                .unwrap()
                                .workspace
                                .as_mut()
                                .unwrap();
                            match invalid {
                                "unverified" => ws.delivery = None,
                                "unmerged" => ws.delivery.as_mut().unwrap().merged = false,
                                "dirty" => ws.delivery.as_mut().unwrap().dirty = true,
                                "abandoned" => ws.abandoned = true,
                                "cleaning" => ws.state = workspaces::WorkspaceState::Cleaning,
                                _ => unreachable!(),
                            }
                        }
                    }
                    Ok(())
                })
                .unwrap();
            assert!(
                store
                    .set_worker_archived(&chats, "chat:master", &worker.id, true)
                    .is_err(),
                "{invalid}"
            );
            assert!(store.snapshot(None).unwrap().attempts[0]
                .archived_at
                .is_none());
        }
    }

    #[test]
    fn bulk_archive_is_scoped_and_skips_unverified_tasks_including_on_repeat() {
        let store = OrchestrationStore::default();
        let first_run = run(&store);
        let first = merged(&store, &first_run);
        // Creating another task reopens execution in this run.
        let second = merged(&store, &first_run);
        let other_run = run(&store);
        let other = merged(&store, &other_run);
        store
            .mutate(|data| {
                data.tasks
                    .get_mut(&second.task_id)
                    .unwrap()
                    .workspace
                    .as_mut()
                    .unwrap()
                    .delivery
                    .as_mut()
                    .unwrap()
                    .merged = false;
                let mut old = first.clone();
                old.id = "earlier".into();
                old.worker_chat_key = "chat:earlier".into();
                old.status = AttemptStatus::Failed;
                data.attempts.insert(old.id.clone(), old);
                Ok(())
            })
            .unwrap();
        let chats = ChatManager::default();
        assert!(store
            .archive_merged_workers(&chats, "chat:other", &first_run.id)
            .is_err());
        let archived = store
            .archive_merged_workers(&chats, "chat:master", &first_run.id)
            .unwrap();
        assert_eq!(archived.len(), 2);
        assert!(archived.iter().all(|a| a.task_id == first.task_id));
        assert!(store
            .archive_merged_workers(&chats, "chat:master", &first_run.id)
            .unwrap()
            .is_empty());
        let snapshot = store.snapshot(None).unwrap();
        for id in [&second.id, &other.id] {
            assert!(snapshot
                .attempts
                .iter()
                .find(|a| &a.id == id)
                .unwrap()
                .archived_at
                .is_none());
        }
        // Restore remains available even when delivery evidence later changes.
        store
            .mutate(|data| {
                data.tasks
                    .get_mut(&first.task_id)
                    .unwrap()
                    .workspace
                    .as_mut()
                    .unwrap()
                    .delivery = None;
                data.runs.get_mut(&first_run.id).unwrap().status = RunStatus::Running;
                Ok(())
            })
            .unwrap();
        assert!(store
            .set_worker_archived(&chats, "chat:master", &first.id, false)
            .unwrap()
            .archived_at
            .is_none());
        assert!(store
            .archive_merged_workers(&chats, "chat:master", &first_run.id)
            .is_err());
    }

    #[test]
    fn run_archive_needs_a_stopped_run_keeps_its_evidence_and_restores_after_reload() {
        let dir = std::env::temp_dir().join(format!("octiq-run-archive-{}", compact_id()));
        let path = dir.join("orchestrations.json");
        let store = OrchestrationStore::load(path.clone());
        let run = run(&store);
        let worker = running_worker(&store, &run);
        store
            .configure_automation(
                "chat:master",
                &run.id,
                Some(automation::WorkerDefaults {
                    agent: None,
                    access: Access::Auto,
                    model: None,
                    effort: None,
                    recovery: None,
                }),
            )
            .unwrap();

        // A live run is refused and left exactly as it was.
        let live = serde_json::to_value(store.snapshot(None).unwrap()).unwrap();
        assert!(store
            .set_run_archived("chat:master", &run.id, true)
            .unwrap_err()
            .contains("Stop this run"));
        assert_eq!(
            serde_json::to_value(store.snapshot(None).unwrap()).unwrap(),
            live
        );
        // Only the run's own coordinator may archive or restore it.
        for actor in ["chat:other", worker.worker_chat_key.as_str()] {
            assert!(store.set_run_archived(actor, &run.id, true).is_err());
            assert!(store.set_run_archived(actor, &run.id, false).is_err());
        }

        let stopped = store
            .stop_run(
                "chat:master",
                run.id.clone(),
                "Stopped by the person.".into(),
            )
            .unwrap();
        assert_eq!(stopped, vec![worker.worker_chat_key.clone()]);
        let before = store.snapshot(None).unwrap();
        let archived = store
            .set_run_archived("chat:master", &run.id, true)
            .unwrap();
        let at = archived.archived_at.expect("archived");
        assert_eq!(archived.status, RunStatus::Stopped);
        assert_eq!(
            store
                .set_run_archived("chat:master", &run.id, true)
                .unwrap()
                .archived_at,
            Some(at),
            "archiving twice keeps the first time"
        );

        // Survives a reload with every task, attempt, gate, message and
        // notification exactly as the stop left them.
        let loaded = OrchestrationStore::load(path.clone());
        let after = loaded.snapshot(None).unwrap();
        assert_eq!(after.runs[0].archived_at, Some(at));
        for (a, b) in [
            (
                serde_json::to_value(&before.tasks),
                serde_json::to_value(&after.tasks),
            ),
            (
                serde_json::to_value(&before.attempts),
                serde_json::to_value(&after.attempts),
            ),
            (
                serde_json::to_value(&before.gates),
                serde_json::to_value(&after.gates),
            ),
            (
                serde_json::to_value(&before.messages),
                serde_json::to_value(&after.messages),
            ),
            (
                serde_json::to_value(&before.notifications),
                serde_json::to_value(&after.notifications),
            ),
        ] {
            assert_eq!(a.unwrap(), b.unwrap());
        }

        // Nothing dispatches from it, and nothing adds work while it is hidden.
        assert!(loaded
            .create_task(
                "chat:master",
                run.id.clone(),
                "Later".into(),
                "More work".into(),
                Vec::new(),
                None,
                None,
            )
            .unwrap_err()
            .contains("archived"));
        assert!(loaded
            .reserve_attempt(
                "chat:master",
                &WorkerLaunch {
                    task_id: worker.task_id.clone(),
                    agent: ChatAgent::Codex,
                    model: None,
                    effort: None,
                    access: Access::Auto,
                    new_worktree: Some(true),
                    base_branch: String::new(),
                },
            )
            .is_err());
        assert!(loaded
            .configure_automation("chat:master", &run.id, None)
            .is_err());

        // Restoring clears only the flag, and that survives a reload too.
        let restored = loaded
            .set_run_archived("chat:master", &run.id, false)
            .unwrap();
        assert!(restored.archived_at.is_none());
        assert_eq!(restored.status, RunStatus::Stopped);
        let reloaded = OrchestrationStore::load(path).snapshot(None).unwrap();
        assert!(reloaded.runs[0].archived_at.is_none());
        assert_eq!(
            serde_json::to_value(&reloaded.tasks).unwrap(),
            serde_json::to_value(&before.tasks).unwrap()
        );

        // Ledgers written before this field keep their runs visible.
        let mut legacy = serde_json::to_value(&archived).unwrap();
        legacy.as_object_mut().unwrap().remove("archivedAt");
        assert!(serde_json::from_value::<Run>(legacy)
            .unwrap()
            .archived_at
            .is_none());
        fs::remove_dir_all(dir).unwrap();
    }
}

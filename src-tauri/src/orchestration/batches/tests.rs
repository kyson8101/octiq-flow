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
    // Before any claim, the batch's own worker is already the agent's.
    assert_eq!(
        store.worker_agent_id(&runtime.worker_chat_key).as_deref(),
        Some("agent_test")
    );
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
    // A claimed attempt agrees with its batch's agent. One reserved for
    // another agent is a conflict: the chat is no one's, never the
    // batch's or the task's later assignee.
    assert_eq!(
        store.worker_agent_id(&runtime.worker_chat_key).as_deref(),
        Some("agent_test")
    );
    store
        .mutate(|data| {
            data.attempts.get_mut(&attempts[0].id).unwrap().assignee = Some(TaskAssignee {
                id: "agent_other".into(),
                name: "Other".into(),
            });
            Ok(())
        })
        .unwrap();
    assert_eq!(store.worker_agent_id(&runtime.worker_chat_key), None);
    store
        .mutate(|data| {
            data.attempts.get_mut(&attempts[0].id).unwrap().assignee = Some(TaskAssignee {
                id: "agent_test".into(),
                name: "Test".into(),
            });
            Ok(())
        })
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

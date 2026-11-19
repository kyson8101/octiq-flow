
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
    let plan =
        crate::git_ops::workflow::agent_plan(&run.root_path, "", &agent.id, "batch_pending", None)
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
    let wait = scheduling::slot_wait(&inner.data, &inner.data.tasks[&other.id], &capped).unwrap();
    assert_eq!(wait.reason, "host");
    assert_eq!(wait.limit, Some(1));
}

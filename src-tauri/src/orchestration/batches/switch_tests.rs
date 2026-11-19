
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

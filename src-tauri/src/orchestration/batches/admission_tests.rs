
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

use super::super::tests::{run, running_worker};
use super::*;

fn latest(store: &OrchestrationStore, id: &str) -> Attempt {
    store
        .snapshot(None)
        .unwrap()
        .attempts
        .into_iter()
        .find(|a| a.id == id)
        .unwrap()
}

fn closing_tasks_worker(
    store: &OrchestrationStore,
    chats: &ChatManager,
) -> (Run, Attempt, crate::agent_chat::TestChild) {
    let run = run(store);
    let attempt = running_worker(store, &run);
    store.begin_worker_spawn(&attempt).unwrap();
    let child = chats.test_hold(&attempt.worker_chat_key, ChatAgent::Codex, true);
    store.finish_dispatch(&attempt, Ok(())).unwrap();
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome: WorkerOutcome::Completed,
                summary: "Done; closing turn still busy".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    (run, attempt, child)
}

fn pi_observations(events: &[Value], interrupted: bool) -> Vec<String> {
    events
        .iter()
        .flat_map(|event| observe(event, 1_000, interrupted))
        .map(|o| match o {
            Observation::Activity => "activity".into(),
            Observation::ModelActivity => "model".into(),
            Observation::Executing => "executing".into(),
            Observation::Progress(text) => format!("progress:{text}"),
            Observation::ToolStart(_, name) => format!("tool-start:{name}"),
            Observation::ToolEnd(_, name) => format!("tool-end:{name}"),
            Observation::Waiting(_) => "waiting".into(),
            Observation::TurnEnded => "turn-ended".into(),
            Observation::TurnCut => "turn-cut".into(),
            Observation::Error(_, retrying) => format!("error:{retrying}"),
        })
        .collect()
}

/// Pi's rpc stream: the turn is over at `agent_settled` alone, and a run
/// that Pi will retry is not a failed attempt.
#[test]
fn a_pi_workers_stream_ends_its_turn_once_and_fails_only_a_final_provider_error() {
    let ok = pi_observations(
        &[
            json!({"type":"agent_start"}),
            json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}),
            json!({"type":"tool_execution_start","toolCallId":"t1","toolName":"read"}),
            json!({"type":"tool_execution_end","toolCallId":"t1","toolName":"read"}),
            json!({"type":"agent_end","willRetry":false,"messages":[{"role":"assistant","stopReason":"stop"}]}),
            json!({"type":"agent_settled","aborted":false}),
        ],
        false,
    );
    assert_eq!(
        ok,
        [
            "executing",
            "progress:done",
            "tool-start:read",
            "tool-end:Finished read",
            "activity",
            "turn-ended"
        ]
    );
    let failed = pi_observations(
        &[
            json!({"type":"agent_end","willRetry":false,"messages":[{"role":"assistant","stopReason":"error","errorMessage":"429 rate limit"}]}),
        ],
        false,
    );
    assert_eq!(failed, ["error:false"]);
    let retried = pi_observations(
        &[
            json!({"type":"agent_end","willRetry":true,"messages":[{"role":"assistant","stopReason":"error","errorMessage":"overloaded"}]}),
            json!({"type":"auto_retry_start","errorMessage":"overloaded"}),
        ],
        false,
    );
    assert_eq!(retried, ["activity", "error:true"]);
    // A coordinator's interrupt ends in an aborted full stop: cut, not failed.
    assert_eq!(
        pi_observations(&[json!({"type":"agent_settled","aborted":true})], true),
        ["turn-cut"]
    );
    assert_eq!(
        pi_observations(&[json!({"type":"agent_settled","aborted":true})], false),
        ["turn-ended"]
    );
}

#[test]
fn tasks_closing_turn_holds_machine_and_run_slots_until_exit() {
    let home = crate::test_dir::TestDir::new("tasks-closing-cap");
    let _profile = crate::profile::started_in(&home);
    crate::scheduling::save(crate::scheduling::Settings {
        orientation: crate::scheduling::Orientation::Tasks,
        host_cap: Some(1),
    })
    .unwrap();
    let store = OrchestrationStore::default();
    let chats = ChatManager::default();
    let (first, attempt, child) = closing_tasks_worker(&store, &chats);
    let second = run(&store);
    let task = store
        .create_task(
            "chat:master",
            second.id,
            "Next".into(),
            "work".into(),
            vec![],
            None,
            None,
        )
        .unwrap();
    let launch = super::super::tests::launch_for(&task.id);
    let blocked = store.reserve_attempt("chat:master", &launch).unwrap_err();
    assert!(blocked.starts_with("QUEUED_FOR_SLOT"));
    assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 1);
    assert_eq!(
        scheduling::run_live(&store.inner.lock().unwrap().data, &first.id, None),
        1
    );
    store.stop_ended_workers(&chats);
    assert!(
        child.alive(),
        "closing turn must finish before settled-worker release"
    );
    chats.test_busy(&attempt.worker_chat_key, false);
    store.stop_ended_workers(&chats);
    assert!(child.gone_soon());
    store.stop_ended_workers(&chats);
    assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 0);
    let (_, _, next, _) = store.reserve_attempt("chat:master", &launch).unwrap();
    store.begin_worker_spawn(&next).unwrap();
    chats.test_launch(&next.worker_chat_key);
    store.finish_dispatch(&next, Ok(())).unwrap();
    assert!(chats.test_child(&next.worker_chat_key).alive());
    chats.test_end(&next.worker_chat_key);
}

#[test]
fn tasks_run_stop_kills_terminal_attempt_closing_turn_and_releases_slot() {
    let home = crate::test_dir::TestDir::new("tasks-closing-stop");
    let _profile = crate::profile::started_in(&home);
    let store = OrchestrationStore::default();
    let chats = ChatManager::default();
    let (run, attempt, child) = closing_tasks_worker(&store, &chats);
    let keys = store
        .stop_run("chat:master", run.id, "Stop".into())
        .unwrap();
    for key in &keys {
        chats.test_end(key);
    }
    let gone = child.gone_soon();
    if !gone {
        chats.test_end(&attempt.worker_chat_key);
    }
    assert!(
        keys.contains(&attempt.worker_chat_key),
        "Stop must name terminal workers too"
    );
    assert!(gone, "Stop must kill the closing turn");
    store.stop_ended_workers(&chats);
    assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 0);
    assert_eq!(latest(&store, &attempt.id).status, AttemptStatus::Completed);
}

#[test]
fn tasks_natural_process_exit_releases_terminal_worker_lease() {
    let home = crate::test_dir::TestDir::new("tasks-closing-exit");
    let _profile = crate::profile::started_in(&home);
    let store = OrchestrationStore::default();
    let chats = ChatManager::default();
    let (_, attempt, child) = closing_tasks_worker(&store, &chats);
    assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 1);
    // The portable echo stand-in exits on EOF, without a server kill.
    chats.test_finish(&attempt.worker_chat_key);
    assert!(child.gone_soon());
    store.stop_ended_workers(&chats);
    assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 0);
}

#[test]
fn tasks_closing_turn_holds_its_run_limit_with_machine_cap_off() {
    let home = crate::test_dir::TestDir::new("tasks-closing-run-cap");
    let _profile = crate::profile::started_in(&home);
    let store = OrchestrationStore::default();
    let chats = ChatManager::default();
    let (run, attempt, child) = closing_tasks_worker(&store, &chats);
    store
        .mutate(|data| {
            data.runs.get_mut(&run.id).unwrap().max_concurrent = 1;
            Ok(())
        })
        .unwrap();
    let task = store
        .create_task(
            "chat:master",
            run.id,
            "Next in run".into(),
            "work".into(),
            vec![],
            None,
            None,
        )
        .unwrap();
    let launch = super::super::tests::launch_for(&task.id);
    assert!(store.reserve_attempt("chat:master", &launch).is_err());
    chats.test_finish(&attempt.worker_chat_key);
    assert!(child.gone_soon());
    store.stop_ended_workers(&chats);
    store.reserve_attempt("chat:master", &launch).unwrap();
}

#[test]
fn tasks_stopped_spawn_keeps_lease_until_launch_returns_and_child_exits() {
    let home = crate::test_dir::TestDir::new("tasks-closing-spawn");
    let _profile = crate::profile::started_in(&home);
    let store = OrchestrationStore::default();
    let chats = ChatManager::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    store.begin_worker_spawn(&attempt).unwrap();
    store
        .stop_run("chat:master", run.id, "Stop during spawn".into())
        .unwrap();
    store.stop_ended_workers(&chats);
    assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 1);
    // A spawn already in progress can still publish its child after Stop.
    let child = chats.test_hold(&attempt.worker_chat_key, ChatAgent::Codex, true);
    store.stop_ended_workers(&chats);
    assert!(child.alive());
    store.finish_dispatch(&attempt, Ok(())).unwrap();
    store.stop_ended_workers(&chats);
    assert!(child.gone_soon());
    store.stop_ended_workers(&chats);
    assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 0);
}

#[test]
fn tasks_failed_spawn_returns_its_runtime_lease_without_a_child() {
    let home = crate::test_dir::TestDir::new("tasks-failed-spawn");
    let _profile = crate::profile::started_in(&home);
    let store = OrchestrationStore::default();
    let chats = ChatManager::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    store.begin_worker_spawn(&attempt).unwrap();
    assert!(store
        .finish_dispatch(&attempt, Err("fixture spawn failure".into()))
        .is_err());
    store.stop_ended_workers(&chats);
    assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 0);
}

#[test]
fn tasks_resumed_worker_uses_the_common_spawn_lease_after_reporting() {
    let home = crate::test_dir::TestDir::new("tasks-resumed-lease");
    let _profile = crate::profile::started_in(&home);
    let store = Arc::new(OrchestrationStore::default());
    let chats = ChatManager::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    // A one-shot follow-up can start through start_session rather than
    // start_worker_for. It has no initial-dispatch barrier to inherit.
    let spawn = store
        .lease_worker_spawn(&attempt.worker_chat_key)
        .unwrap()
        .unwrap();
    let child = chats.test_hold(&attempt.worker_chat_key, ChatAgent::Codex, true);
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome: WorkerOutcome::Completed,
                summary: "Resumed turn reported".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    store.stop_ended_workers(&chats);
    assert!(child.alive());
    drop(spawn);
    store.stop_ended_workers(&chats);
    assert!(child.alive());
    assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 1);
    chats.test_busy(&attempt.worker_chat_key, false);
    store.stop_ended_workers(&chats);
    assert!(child.gone_soon());
    store.stop_ended_workers(&chats);
    assert_eq!(store.scheduling_get().unwrap()["live"]["total"], 0);
}

#[test]
fn a_settled_worker_finishes_its_closing_turn_before_its_process_is_freed() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    let chats = ChatManager::default();
    chats.test_launch(&attempt.worker_chat_key);
    chats.test_busy(&attempt.worker_chat_key, true);
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome: WorkerOutcome::Completed,
                summary: "Done".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    store.stop_ended_workers(&chats);
    assert!(
        chats.has_process(&attempt.worker_chat_key),
        "tool reply/closing turn still in flight"
    );
    chats.test_busy(&attempt.worker_chat_key, false);
    store.stop_ended_workers(&chats);
    let still_running = chats.has_process(&attempt.worker_chat_key);
    if still_running {
        crate::agent_chat::chat_stop_impl(&chats, attempt.worker_chat_key.clone()).unwrap();
    }
    assert!(!still_running);
    store
        .worker_disconnected(&attempt.worker_chat_key, None)
        .unwrap();
    assert_eq!(latest(&store, &attempt.id).status, AttemptStatus::Completed);
}

#[test]
fn an_open_gate_keeps_its_idle_worker_but_a_blocked_report_ends_it() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let gated = running_worker(&store, &run);
    let chats = ChatManager::default();
    chats.test_launch(&gated.worker_chat_key);
    store
        .create_gate(
            &gated.worker_chat_key,
            run.id.clone(),
            Some(gated.task_id.clone()),
            "Choose".into(),
            vec![],
        )
        .unwrap();
    store.stop_ended_workers(&chats);
    assert!(chats.has_process(&gated.worker_chat_key));
    crate::agent_chat::chat_stop_impl(&chats, gated.worker_chat_key.clone()).unwrap();

    let blocked = running_worker(&store, &run);
    chats.test_launch(&blocked.worker_chat_key);
    store
        .report_worker(
            &blocked.worker_chat_key,
            WorkerReport {
                attempt_id: blocked.id.clone(),
                outcome: WorkerOutcome::Blocked,
                summary: "Cannot continue".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    store.stop_ended_workers(&chats);
    let still_running = chats.has_process(&blocked.worker_chat_key);
    if still_running {
        crate::agent_chat::chat_stop_impl(&chats, blocked.worker_chat_key.clone()).unwrap();
    }
    assert!(!still_running);
}
fn capacity(store: &OrchestrationStore, attempt: &Attempt) {
    store
        .observe_worker_event(
            &attempt.worker_chat_key,
            &json!({"type":"turn.failed", "error":{"message":"Selected model is at capacity"}}),
        )
        .unwrap();
}
fn launch(attempt: &Attempt) -> WorkerLaunch {
    WorkerLaunch {
        task_id: attempt.task_id.clone(),
        agent: attempt.agent,
        model: attempt
            .execution
            .retry_model
            .clone()
            .or(attempt.model.clone()),
        effort: attempt.effort.clone(),
        access: attempt.access,
        new_worktree: Some(false),
        base_branch: String::new(),
    }
}
fn make_due(store: &OrchestrationStore, id: &str) {
    store
        .mutate(|data| {
            data.attempts.get_mut(id).unwrap().execution.next_retry_at = Some(now_ms() - 1);
            Ok(())
        })
        .unwrap();
}

#[test]
fn capacity_during_dispatch_reaches_ui_and_coordinator_without_a_model_response() {
    let root = crate::test_dir::TestDir::new("capacity");
    let path = root.join("orchestrations.json");
    let store = OrchestrationStore::load(path.clone());
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    let mut browser = crate::bus::events().subscribe();
    // Inject the provider dispatch result at the same boundary used by
    // chat_start; there is no worker report or successful model response.
    let result = store.finish_dispatch(&attempt, Err("Selected model is at capacity".into()));
    assert!(result.is_err());
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    assert_eq!(snapshot.attempts[0].status, AttemptStatus::Failed);
    assert_eq!(
        snapshot.attempts[0].execution.state,
        ExecutionState::CapacityBlocked
    );
    assert_ne!(snapshot.tasks[0].status, TaskStatus::Running);
    assert_eq!(snapshot.runs[0].status, RunStatus::Waiting);
    let error = snapshot.attempts[0]
        .execution
        .latest_error
        .as_ref()
        .unwrap();
    assert_eq!(error.message, "Selected model is at capacity");
    assert!(snapshot.attempts[0].execution.next_retry_at.unwrap() >= error.at + 5_000);
    let note = &snapshot.notifications[0];
    assert_eq!(note.target_chat_key, "chat:master");
    assert_eq!(note.kind, "capacity");
    assert_eq!(note.state, inbox::DeliveryState::Pending);
    assert!(store
        .due_notifications(now_ms())
        .unwrap()
        .iter()
        .any(|n| n.id == note.id));
    let mut notified = false;
    while let Ok(frame) = browser.try_recv() {
        let frame: Value = serde_json::from_str(&frame).unwrap();
        notified |=
            frame["event"] == "orchestration-changed" && frame["payload"]["runId"] == run.id;
    }
    assert!(notified, "browser must refresh its snapshot immediately");
    let reloaded = OrchestrationStore::load(path).snapshot(None).unwrap();
    assert_eq!(
        reloaded.attempts[0].execution.state,
        ExecutionState::CapacityBlocked
    );
    assert_eq!(reloaded.notifications[0].id, note.id);
    assert_eq!(reloaded.attempts[0].cwd, attempt.cwd);
}

#[test]
fn execution_only_changes_ride_in_the_event_and_others_ask_for_a_refetch() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    let mut browser = crate::bus::events().subscribe();
    store.observe_worker_event(&attempt.worker_chat_key, &json!({"type":"item.started","item":{"id":"c1","type":"command_execution","command":"cargo test"}})).unwrap();
    let patched = latest(&store, &attempt.id).execution;
    // A provider retry also queues a coordinator notification.
    store
        .observe_worker_event(
            &attempt.worker_chat_key,
            &json!({"type":"warning","will_retry":true,"message":"Selected model is at capacity"}),
        )
        .unwrap();
    let frames: Vec<Value> = std::iter::from_fn(|| browser.try_recv().ok())
        .map(|frame| serde_json::from_str::<Value>(&frame).unwrap())
        .filter(|frame| {
            frame["event"] == "orchestration-changed" && frame["payload"]["runId"] == run.id
        })
        .collect();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0]["payload"]["attemptId"], attempt.id);
    assert_eq!(
        frames[0]["payload"]["execution"],
        serde_json::to_value(&patched).unwrap()
    );
    assert_eq!(
        frames[0]["payload"]["execution"]["lastProgress"],
        "Started cargo test"
    );
    assert!(frames[1]["payload"].get("execution").is_none());
}

#[test]
fn both_provider_error_streams_settle_once_and_late_reports_cannot_overwrite_them() {
    for event in [
            json!({"type":"result","is_error":true,"result":"Selected model is at capacity"}),
            json!({"type":"assistant","error":"overloaded_error","message":{"content":[{"type":"text","text":"Selected model is at capacity"}]}}),
            crate::codex_app_server::normalize_notification(&json!({"method":"error", "params":{"willRetry":false,"error":{"message":"Selected model is at capacity"}}})).unwrap(),
        ] {
            let store = OrchestrationStore::default();
            let run = run(&store);
            let attempt = running_worker(&store, &run);
            store.observe_worker_event(&attempt.worker_chat_key, &event).unwrap();
            capacity(&store, &attempt);
            store.worker_disconnected(&attempt.worker_chat_key, None).unwrap();
            assert_eq!(latest(&store, &attempt.id).execution.state, ExecutionState::CapacityBlocked);
            assert_eq!(store.snapshot(None).unwrap().notifications.len(), 1);
            assert!(store.report_worker(&attempt.worker_chat_key, WorkerReport { attempt_id: attempt.id, outcome: WorkerOutcome::Completed, summary:"Late completion".into(), files_modified:vec![], verdict: None }).is_err());
        }
}

#[test]
fn recovery_is_bounded_uses_fallback_and_fences_superseded_attempts() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let mut attempt = running_worker(&store, &run);
    store
        .mutate(|data| {
            data.tasks
                .get_mut(&attempt.task_id)
                .unwrap()
                .worker
                .as_mut()
                .unwrap()
                .recovery = Some(RecoveryPolicy {
                fallback_model: Some("gpt-5.6-terra".into()),
                ..RecoveryPolicy::default()
            });
            Ok(())
        })
        .unwrap();
    for count in 0..=2 {
        capacity(&store, &attempt);
        let failed = latest(&store, &attempt.id);
        assert_eq!(failed.execution.retry_count, count);
        if count == 2 {
            assert!(failed.execution.next_retry_at.is_none());
            assert_eq!(
                store.snapshot(None).unwrap().tasks[0].status,
                TaskStatus::Failed
            );
            break;
        }
        assert_eq!(
            failed.execution.retry_model.as_deref(),
            Some("gpt-5.6-terra")
        );
        assert_eq!(
            failed.execution.next_retry_at.unwrap()
                - failed.execution.latest_error.as_ref().unwrap().at,
            5_000 << count
        );
        assert!(
            store
                .reserve_attempt_for(
                    "chat:master",
                    &launch(&failed),
                    StartedBy::Recovery(&failed.id)
                )
                .is_err(),
            "backoff is enforced under the reservation lock"
        );
        make_due(&store, &failed.id);
        let (_, _, reserved, previous) = store
            .reserve_attempt_for(
                "chat:master",
                &launch(&failed),
                StartedBy::Recovery(&failed.id),
            )
            .unwrap();
        assert_eq!(reserved.model.as_deref(), Some("gpt-5.6-terra"));
        assert_eq!(reserved.access, failed.access);
        assert_eq!(previous.unwrap().cwd, failed.cwd);
        assert!(store
            .reserve_attempt_for(
                "chat:master",
                &launch(&failed),
                StartedBy::Recovery(&failed.id)
            )
            .is_err());
        attempt = store
            .activate_attempt(
                &reserved.id,
                failed.cwd.clone(),
                failed.branch.clone(),
                failed.is_worktree,
            )
            .unwrap();
        capacity(&store, &failed); // old reader cannot fail its replacement
        assert_eq!(latest(&store, &attempt.id).status, AttemptStatus::Running);
    }
    assert_eq!(store.snapshot(None).unwrap().attempts.len(), 3);
}

#[test]
fn tool_waits_are_not_provider_failures_and_pending_tools_are_not_replayed() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    for id in ["one", "two"] {
        store
            .observe_worker_event(
                &attempt.worker_chat_key,
                &json!({"type":"item.started","item":{"id":id,"type":"command_execution"}}),
            )
            .unwrap();
    }
    store.observe_worker_event(&attempt.worker_chat_key, &json!({"type":"item.completed","item":{"id":"one","type":"command_execution","status":"failed","aggregated_output":"Selected model is at capacity"}})).unwrap();
    let current = latest(&store, &attempt.id);
    assert_eq!(current.execution.state, ExecutionState::WaitingTool);
    assert!(current.execution.last_progress_at.is_some());
    store.monitor_workers(now_ms() + 300_001).unwrap();
    assert!(store.snapshot(None).unwrap().notifications.is_empty());
    capacity(&store, &attempt);
    assert!(latest(&store, &attempt.id)
        .execution
        .next_retry_at
        .is_none());
}

/// Feedback cab56ae9: a worker waits on its gate for longer than the idle
/// reaper allows, so its process is gone when the decision arrives. The
/// sweep that runs before delivery used to read the clocks from before
/// the gate, fail the attempt as disconnected, and cancel the decision.
#[test]
fn a_resolved_gate_reaches_a_worker_whose_process_was_reaped_while_it_waited() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    let gate = store
        .create_gate(
            &attempt.worker_chat_key,
            run.id.clone(),
            Some(attempt.task_id.clone()),
            "Which sprite size?".into(),
            vec![],
        )
        .unwrap();
    // The worker last moved half an hour ago, then sat on its gate.
    let asked = now_ms() - 30 * 60_000;
    store
        .mutate(|data| {
            let e = &mut data.attempts.get_mut(&attempt.id).unwrap().execution;
            e.last_activity_at = Some(asked);
            e.last_progress_at = Some(asked);
            Ok(())
        })
        .unwrap();
    let chats = Arc::new(ChatManager::default());
    let workspaces = crate::workspaces::WorkspaceState::with_projects(Vec::new());
    // Blocked on its gate with no process: waiting, not lost.
    store
        .recover_due_workers(chats.clone(), &workspaces, now_ms())
        .unwrap();
    assert_eq!(latest(&store, &attempt.id).status, AttemptStatus::Blocked);

    store
        .resolve_gate("chat:master", gate.id, "96 by 96".into())
        .unwrap();
    // The scheduler's next tick, before delivery has resumed the chat.
    store
        .recover_due_workers(chats.clone(), &workspaces, now_ms() + 2_000)
        .unwrap();
    let current = latest(&store, &attempt.id);
    assert_eq!(current.status, AttemptStatus::Running);
    assert_eq!(current.execution.state, ExecutionState::Queued);
    assert!(current.execution.stalled_at.is_none());
    let notes = store.snapshot(None).unwrap().notifications;
    assert!(!notes
        .iter()
        .any(|n| matches!(n.kind.as_str(), "stalled" | "disconnected")));
    let resolution = notes.iter().find(|n| n.kind == "resolution").unwrap();
    assert_eq!(resolution.target_chat_key, attempt.worker_chat_key);
    assert!(store
        .claim_notification(&resolution.id, now_ms() + 2_000)
        .unwrap()
        .is_some());

    // A decision that never revives the worker still ends as a lost
    // worker; it is only no longer judged by the time before the gate.
    store
        .recover_due_workers(chats, &workspaces, now_ms() + 60_000)
        .unwrap();
    assert_eq!(latest(&store, &attempt.id).status, AttemptStatus::Failed);
}

/// Feedback 597f0e33: a worker waking now and then to read its running
/// test's log is told about once per background job, naming the job.
#[test]
fn a_stall_beside_running_background_work_is_told_once_per_job() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    let job = |id: &str| vec![(id.to_string(), "Run the full vitest suite".to_string())];
    let stalls = |store: &OrchestrationStore| {
        store
            .snapshot(None)
            .unwrap()
            .notifications
            .iter()
            .filter(|n| n.kind == "stalled")
            .count()
    };
    let mut now = now_ms() + 300_001;
    for _ in 0..3 {
        store.monitor_workers_with(now, &|_| job("bg1")).unwrap();
        // The worker wakes, reads the log, and goes quiet again.
        store.observe_worker_event(&attempt.worker_chat_key, &json!({"type":"item.completed", "item":{"type":"agent_message","text":"Tests still running; waiting"}})).unwrap();
        now += 300_001;
    }
    assert_eq!(stalls(&store), 1);
    let note = store
        .snapshot(None)
        .unwrap()
        .notifications
        .into_iter()
        .find(|n| n.kind == "stalled")
        .unwrap();
    assert!(
        note.body.contains("Run the full vitest suite"),
        "{}",
        note.body
    );
    // A new job, or none, is a new story.
    store.monitor_workers_with(now, &|_| job("bg2")).unwrap();
    assert_eq!(stalls(&store), 2);
}

#[test]
fn stalled_attempts_notify_once_and_progress_clears_the_stall() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    let later = now_ms() + 300_001;
    store.monitor_workers(later).unwrap();
    store.monitor_workers(later + 1).unwrap();
    assert_eq!(
        latest(&store, &attempt.id).execution.state,
        ExecutionState::Stalled
    );
    assert_eq!(store.snapshot(None).unwrap().notifications.len(), 1);
    store.observe_worker_event(&attempt.worker_chat_key, &json!({"type":"item.completed", "item":{"type":"agent_message","text":"Implementation finished; checking the result"}})).unwrap();
    let active = latest(&store, &attempt.id);
    assert_eq!(active.execution.state, ExecutionState::Executing);
    assert!(active
        .execution
        .last_progress
        .unwrap()
        .contains("Implementation finished"));
}

#[test]
fn native_provider_retries_are_visible_and_cannot_wait_forever() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    let event = crate::codex_app_server::normalize_notification(&json!({"method":"error", "params":{"willRetry":true,"error":{"message":"Selected model is at capacity"}}})).unwrap();
    store
        .observe_worker_event(&attempt.worker_chat_key, &event)
        .unwrap();
    let current = latest(&store, &attempt.id);
    assert_eq!(current.status, AttemptStatus::Running);
    assert_eq!(current.execution.state, ExecutionState::CapacityBlocked);
    assert_eq!(store.snapshot(None).unwrap().notifications.len(), 1);
    store.monitor_workers(now_ms() + 60_001).unwrap();
    assert_eq!(latest(&store, &attempt.id).status, AttemptStatus::Failed);
}

#[test]
fn streaming_after_a_provider_retry_clears_its_deadline_but_retains_error_evidence() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    store.observe_worker_event(&attempt.worker_chat_key, &json!({"type":"warning", "will_retry":true, "message":"Selected model is at capacity"})).unwrap();
    store
        .observe_worker_event(&attempt.worker_chat_key, &json!({"type":"model.activity"}))
        .unwrap();
    store.monitor_workers(now_ms() + 60_001).unwrap();
    let current = latest(&store, &attempt.id);
    assert_eq!(current.status, AttemptStatus::Running);
    assert_eq!(current.execution.state, ExecutionState::Executing);
    assert!(current.execution.provider_retry_started_at.is_none());
    assert!(current.execution.last_progress_at.is_none());
    assert_eq!(current.execution.latest_error.unwrap().kind, "capacity");
}

#[test]
fn tool_output_is_activity_without_claiming_progress_or_model_recovery() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    store.observe_worker_event(&attempt.worker_chat_key, &json!({"type":"warning", "will_retry":true, "message":"Selected model is at capacity"})).unwrap();
    store
        .mutate(|data| {
            data.attempts
                .get_mut(&attempt.id)
                .unwrap()
                .execution
                .last_activity_at = Some(1);
            Ok(())
        })
        .unwrap();
    store
        .observe_codex_activity(
            &attempt.worker_chat_key,
            &json!({"method":"item/commandExecution/outputDelta", "params":{"delta":"compiling"}}),
        )
        .unwrap();
    let current = latest(&store, &attempt.id);
    assert!(current.execution.last_activity_at.unwrap() > 1);
    assert!(current.execution.last_progress_at.is_none());
    assert!(current.execution.provider_retry_started_at.is_some());
    assert_eq!(current.execution.state, ExecutionState::CapacityBlocked);
}

#[test]
fn disconnects_notify_but_completed_workers_and_stopped_runs_do_not_restart() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    store
        .worker_disconnected(&attempt.worker_chat_key, None)
        .unwrap();
    assert_eq!(
        latest(&store, &attempt.id).execution.state,
        ExecutionState::Disconnected
    );
    assert_eq!(
        store.snapshot(None).unwrap().notifications[0].kind,
        "disconnected"
    );
    assert!(latest(&store, &attempt.id)
        .execution
        .next_retry_at
        .is_none());
    let other = running_worker(&store, &run);
    capacity(&store, &other);
    store
        .stop_run("chat:master", run.id, "Stop".into())
        .unwrap();
    assert!(latest(&store, &other.id).execution.next_retry_at.is_none());
    assert!(store
        .snapshot(None)
        .unwrap()
        .notifications
        .iter()
        .all(|n| n.state == inbox::DeliveryState::Cancelled));
}

/// Feedback 2adec4d5: a worker whose shell refused the launch line was
/// reported as a plain disconnect, three attempts running, while the
/// reason sat unread in the diagnostics journal.
#[test]
fn a_disconnect_says_what_the_process_left_behind() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    let last_words = "The process exited with code 2. Its last error output: bash: unexpected EOF";
    store
        .worker_disconnected(&attempt.worker_chat_key, Some(last_words))
        .unwrap();
    let error = latest(&store, &attempt.id).execution.latest_error.unwrap();
    assert_eq!(error.kind, "disconnected");
    assert_eq!(
        error.message,
        format!("Worker output disconnected before the attempt was reported. {last_words}")
    );
    let notice = &store.snapshot(None).unwrap().notifications[0];
    assert!(notice.body.contains(last_words), "{}", notice.body);

    let silent = running_worker(&store, &run);
    store
        .worker_disconnected(&silent.worker_chat_key, None)
        .unwrap();
    assert_eq!(
        latest(&store, &silent.id)
            .execution
            .latest_error
            .unwrap()
            .message,
        "Worker output disconnected before the attempt was reported."
    );
}

#[test]
fn quoted_capacity_and_router_diagnostics_are_not_provider_failures() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    store
        .observe_worker_output(
            &attempt.worker_chat_key,
            "ERROR tools::router: timeout in tool_result",
        )
        .unwrap();
    store.observe_worker_event(&attempt.worker_chat_key, &json!({"type":"assistant", "message":{"content":[{"type":"text","text":"The test simulates Selected model is at capacity"}]}})).unwrap();
    assert_eq!(latest(&store, &attempt.id).status, AttemptStatus::Running);
    assert!(store.snapshot(None).unwrap().notifications.is_empty());
    store
        .observe_worker_output(&attempt.worker_chat_key, "Selected model is at capacity")
        .unwrap();
    assert_eq!(
        latest(&store, &attempt.id).execution.state,
        ExecutionState::CapacityBlocked
    );
}

#[test]
fn recovery_configuration_is_bounded_and_cannot_choose_coordinator_models() {
    for policy in [
        RecoveryPolicy {
            max_retries: 6,
            ..RecoveryPolicy::default()
        },
        RecoveryPolicy {
            base_delay_ms: 0,
            ..RecoveryPolicy::default()
        },
        RecoveryPolicy {
            fallback_model: Some("gpt-6-astra".into()),
            ..RecoveryPolicy::default()
        },
    ] {
        assert!(policy.validate(ChatAgent::Codex).is_err());
    }
    assert!(RecoveryPolicy {
        max_retries: 0,
        ..RecoveryPolicy::default()
    }
    .validate(ChatAgent::Claude)
    .is_ok());
}

/// Feedback 240ea516: a coordinator's interrupt failed the Claude attempt
/// it was redirecting, because Claude spells the full stop of a cut-off
/// turn as a failed `result`. Replayed from a real interrupted stream.
#[test]
fn a_turn_the_host_cut_short_keeps_the_attempt_active_for_the_message_behind_it() {
    use super::super::tests::{claude_interrupted_tool, running_worker_on};
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker_on(&store, &run, ChatAgent::Claude);
    let key = &attempt.worker_chat_key;
    let events = claude_interrupted_tool();
    let called = events
        .iter()
        .position(|e| e["type"] == "assistant" && e["message"]["content"][0]["type"] == "tool_use")
        .expect("the Bash call");
    let cut = events
        .iter()
        .position(|e| e["type"] == "result")
        .expect("the cut-off turn's full stop");
    assert_eq!(events[cut]["subtype"], "error_during_execution");
    assert_eq!(events[cut]["is_error"], true);
    assert_eq!(
        events[cut]["errors"][0],
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
        "the very result the feedback's attempts failed on"
    );

    for event in &events[..=called] {
        store.observe_worker_turn_event(key, event, false).unwrap();
    }
    let working = latest(&store, &attempt.id).execution;
    assert_eq!(working.state, ExecutionState::WaitingTool);
    assert_eq!(working.pending_tools.len(), 1);

    // The coordinator's message is durable before the interrupt goes out.
    let message = store
        .record_message(
            &run.coordinator_chat_key,
            run.id.clone(),
            attempt.id.clone(),
            "instruction".into(),
            "Pause".into(),
            "Stop the render.".into(),
        )
        .unwrap();
    for event in &events[called + 1..=cut] {
        store.observe_worker_turn_event(key, event, true).unwrap();
    }
    let after = latest(&store, &attempt.id);
    assert_eq!(after.status, AttemptStatus::Running);
    assert_eq!(after.execution.state, ExecutionState::AwaitingReport);
    assert_eq!(
        after.execution.current_operation.as_deref(),
        Some("Turn interrupted; waiting for its next message")
    );
    assert!(after.execution.latest_error.is_none());
    assert!(after.execution.pending_tools.is_empty());
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    assert_eq!(snapshot.tasks[0].status, TaskStatus::Running);
    assert!(
        snapshot
            .notifications
            .iter()
            .all(|n| n.target_chat_key != run.coordinator_chat_key),
        "the coordinator is not told its own interrupt failed the worker"
    );
    assert!(store.message_waiting(&message.id));
    assert!(
        store
            .due_notifications(i64::MAX)
            .unwrap()
            .iter()
            .any(|n| &n.target_chat_key == key && n.body.contains("Stop the render.")),
        "the message is still owed to the worker, as its next turn"
    );

    // The turn that message opens, and its ordinary full stop.
    let next = &events[cut + 1..];
    assert_eq!(next[0]["subtype"], "init");
    store
        .observe_worker_turn_event(key, &next[0], false)
        .unwrap();
    assert_eq!(
        latest(&store, &attempt.id).execution.state,
        ExecutionState::Executing
    );
    for event in &next[1..] {
        store.observe_worker_turn_event(key, event, false).unwrap();
    }
    let done = latest(&store, &attempt.id);
    assert_eq!(done.status, AttemptStatus::Running);
    assert_eq!(done.execution.state, ExecutionState::AwaitingReport);
    assert_eq!(
        done.execution.current_operation.as_deref(),
        Some("Turn ended without a worker report")
    );
}

/// Either signal says a turn was cut: the host's own interrupt still
/// waiting for the full stop, or the result naming an abort. The
/// diagnostic's words alone say nothing.
#[test]
fn a_cut_turn_is_read_from_the_hosts_interrupt_or_the_results_own_abort() {
    let diagnostic =
        json!(["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"]);
    let cut = |interrupted: bool, event: Value| {
        matches!(
            observe(&event, 0, interrupted).as_slice(),
            [Observation::TurnCut]
        )
    };
    let failed = |interrupted: bool, event: Value| {
        matches!(
            observe(&event, 0, interrupted).as_slice(),
            [Observation::Error(_, false)]
        )
    };
    // A CLI that names no reason: only the host's interrupt says so.
    let bare = json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":diagnostic});
    assert!(cut(true, bare.clone()));
    assert!(failed(false, bare));
    // The interrupt's mark has lapsed, but the result says it was aborted.
    for reason in ["aborted_tools", "aborted_streaming"] {
        let aborted = json!({"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":reason,"errors":diagnostic});
        assert!(cut(false, aborted.clone()), "{reason}");
        assert!(cut(true, aborted), "{reason}");
    }
    // A turn that ended well under an interrupt that came too late.
    assert!(matches!(
        observe(
            &json!({"type":"result","subtype":"success","is_error":false,"result":"done"}),
            0,
            true
        )
        .as_slice(),
        [Observation::TurnEnded]
    ));
    // Codex and Antigravity read as they did.
    assert!(matches!(
        observe(
            &json!({"type":"turn.completed","status":"interrupted"}),
            0,
            true
        )
        .as_slice(),
        [Observation::TurnEnded]
    ));
    assert!(failed(
        true,
        json!({"type":"turn.failed","error":{"message":"boom"}})
    ));
    use crate::agent_provider::tests::{agy_events, AGY_BAD_MODEL};
    assert!(failed(true, agy_events(AGY_BAD_MODEL)[0].clone()));
}

/// A provider failure is still one, with or without an interrupt
/// outstanding: the attempt fails and its coordinator is told, as before.
#[test]
fn a_failed_result_still_fails_the_attempt_even_under_an_interrupt() {
    for interrupted in [false, true] {
        for (event, state) in [
            (
                json!({"type":"result","subtype":"success","is_error":true,"api_error_status":529,"result":"API Error: 529 Overloaded"}),
                ExecutionState::CapacityBlocked,
            ),
            (
                json!({"type":"result","subtype":"error_max_turns","is_error":true}),
                ExecutionState::Failed,
            ),
            (
                json!({"type":"assistant","error":"invalid_request","message":{"content":[{"type":"text","text":"Prompt is too long"}]}}),
                ExecutionState::Failed,
            ),
        ] {
            let store = OrchestrationStore::default();
            let run = run(&store);
            let attempt = running_worker(&store, &run);
            store
                .observe_worker_turn_event(&attempt.worker_chat_key, &event, interrupted)
                .unwrap();
            let after = latest(&store, &attempt.id);
            assert_eq!(after.status, AttemptStatus::Failed, "{event}");
            assert_eq!(after.execution.state, state, "{event}");
            assert!(after.execution.latest_error.is_some(), "{event}");
            let notes = store.snapshot(None).unwrap().notifications;
            assert_eq!(notes.len(), 1, "{event}");
            assert_eq!(notes[0].target_chat_key, run.coordinator_chat_key);
        }
    }
    // A turn that broke on its own, with no interrupt and no abort named:
    // the failure the feedback's message described, when it IS one.
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    store
            .observe_worker_event(
                &attempt.worker_chat_key,
                &json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":["boom"]}),
            )
            .unwrap();
    let after = latest(&store, &attempt.id);
    assert_eq!(after.status, AttemptStatus::Failed);
    assert_eq!(
        after.execution.latest_error.unwrap().message,
        "Provider request failed [\"boom\"]"
    );
}

#[test]
fn an_antigravity_worker_stream_reads_as_activity_tools_and_a_full_stop() {
    use crate::agent_provider::tests::{agy_events, AGY_BAD_MODEL, AGY_THREE_TURNS};
    let mut started = Vec::new();
    let mut ended = 0;
    let mut turns = 0;
    for event in agy_events(AGY_THREE_TURNS) {
        for seen in observe(&event, 0, false) {
            match seen {
                Observation::ToolStart(id, name) => started.push((id, name)),
                Observation::ToolEnd(..) => ended += 1,
                Observation::TurnEnded => turns += 1,
                Observation::Error(..) => panic!("no failure in this stream"),
                _ => {}
            }
        }
    }
    assert_eq!(
        started,
        vec![
            ("step-2".to_string(), "view file".to_string()),
            ("step-6".to_string(), "run command".to_string()),
        ]
    );
    assert_eq!(ended, 2);
    assert_eq!(turns, 3);
    let bad = agy_events(AGY_BAD_MODEL);
    assert!(matches!(
        observe(&bad[0], 0, false).as_slice(),
        [Observation::Error(_, false)]
    ));
}

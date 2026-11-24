pub(crate) use super::workspaces::tests::finished_peer_request;
use super::*;

/// Mark a reserved fixture running without preparing a workspace or
/// spawning a provider CLI. Used by dispatch's manager-routing tests.
pub(crate) fn activate_reserved(
    store: &OrchestrationStore,
    attempt: &Attempt,
    cwd: &str,
) -> Attempt {
    store
        .activate_attempt(&attempt.id, cwd.into(), "stub".into(), true)
        .unwrap()
}

#[test]
fn a_saved_ledger_ignores_retired_environment_fields() {
    let disk = crate::test_dir::TestDir::new("legacy-environment-ledger");
    let path = disk.join("orchestrations.json");
    let store = OrchestrationStore::load(path.clone());
    let run = run(&store);
    let task = task(&store, &run, Vec::new());
    let mut saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    saved["tasks"][&task.id]["environment"] = json!("sandbox");
    saved["environments"] = json!({ "obsolete": { "state": "ready" } });
    fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    drop(store);
    let loaded = OrchestrationStore::load(path);
    let snapshot = loaded.snapshot(Some(&run.id)).unwrap();
    assert_eq!(snapshot.tasks.len(), 1);
    assert_eq!(snapshot.tasks[0].id, task.id);
    assert!(serde_json::to_value(&snapshot.tasks[0])
        .unwrap()
        .get("environment")
        .is_none());
}

pub(crate) fn run(store: &OrchestrationStore) -> Run {
    // These ledger-only tests simulate independent worktrees at activate,
    // without provisioning them. Their root must still support the mode:
    // a non-Git folder is approved as Direct in every run mode. The shared
    // repository is read-only and its TestDir is removed at process exit.
    static ROOT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let root = ROOT.get_or_init(|| {
        let repo = crate::git_ops::workflow::tests::Repo::new();
        repo.dir.remove_at_exit();
        repo.root
    });
    store
        .create_run_with_mode(
            "chat:master".into(),
            "Ship the feature".into(),
            "workspace".into(),
            root.clone(),
            Some(2),
            WorkspaceMode::Worktree,
        )
        .unwrap()
}

pub(super) fn task(store: &OrchestrationStore, run: &Run, depends_on: Vec<String>) -> Task {
    store
        .create_task(
            "chat:master",
            run.id.clone(),
            "Implement".into(),
            "Make the requested change".into(),
            depends_on,
            None,
            None,
        )
        .unwrap()
}

/// Feedback ea1fe10e: only current work decides a run's status. Include
/// every historical status so a replaced block/check cannot hold it either.
#[test]
fn recompute_run_leaves_replaced_and_cancelled_tasks_in_history() {
    for (live, expected) in [
        (TaskStatus::Completed, RunStatus::Completed),
        (TaskStatus::Pending, RunStatus::Running),
        (TaskStatus::Ready, RunStatus::Running),
        (TaskStatus::Running, RunStatus::Running),
        (TaskStatus::Blocked, RunStatus::Waiting),
        (TaskStatus::Failed, RunStatus::Failed),
    ] {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let current = task(&store, &run, vec![]);
        let history: Vec<_> = (0..7).map(|_| task(&store, &run, vec![])).collect();
        let mut inner = store.inner.lock().unwrap();
        let data = &mut inner.data;
        data.tasks.get_mut(&current.id).unwrap().status = live;
        for (old, status) in history.iter().zip([
            TaskStatus::Pending,
            TaskStatus::Ready,
            TaskStatus::Running,
            TaskStatus::Blocked,
            TaskStatus::Failed,
            TaskStatus::Completed,
            TaskStatus::Cancelled,
        ]) {
            let old = data.tasks.get_mut(&old.id).unwrap();
            old.status = status;
            if status != TaskStatus::Cancelled {
                old.superseded_by = Some(current.id.clone());
            }
            if status == TaskStatus::Completed {
                old.kind = TaskKind::Review;
                old.verdict = Some(Verdict::Fail);
            }
        }
        recompute_run(data, &run.id);
        assert_eq!(data.runs[&run.id].status, expected, "{live:?}");
        assert_eq!(data.tasks.len(), 8, "history is preserved");
        assert_eq!(data.tasks[&history[4].id].status, TaskStatus::Failed);
    }
}

#[test]
fn recompute_run_preserves_empty_gated_held_and_ended_runs() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    {
        let mut inner = store.inner.lock().unwrap();
        recompute_run(&mut inner.data, &run.id);
        assert_eq!(inner.data.runs[&run.id].status, RunStatus::Planning);
    }
    let cancelled = task(&store, &run, vec![]);
    {
        let mut inner = store.inner.lock().unwrap();
        inner.data.tasks.get_mut(&cancelled.id).unwrap().status = TaskStatus::Cancelled;
        recompute_run(&mut inner.data, &run.id);
        assert_eq!(inner.data.runs[&run.id].status, RunStatus::Stopped);
        // Recompute preserves an explicit stop; reopen this fixture to
        // exercise an open gate with only withdrawn tasks.
        inner.data.runs.get_mut(&run.id).unwrap().status = RunStatus::Running;
    }
    let gate = store
        .create_gate("chat:master", run.id.clone(), None, "Decide".into(), vec![])
        .unwrap();
    let mut inner = store.inner.lock().unwrap();
    let data = &mut inner.data;
    recompute_run(data, &run.id);
    assert_eq!(data.runs[&run.id].status, RunStatus::Waiting);
    data.gates
        .get_mut(&gate.id)
        .unwrap()
        .close(GateStatus::Resolved, now_ms());
    let mut check = data.tasks[&cancelled.id].clone();
    check.id = "current-check".into();
    check.status = TaskStatus::Completed;
    check.kind = TaskKind::Review;
    check.verdict = Some(Verdict::Fail);
    data.tasks.insert(check.id.clone(), check.clone());
    // Today's all-completed answer stays Completed even for a held check;
    // failure.awaits and shownRunStatus say whose move that failure is.
    recompute_run(data, &run.id);
    assert_eq!(data.runs[&run.id].status, RunStatus::Completed);
    let mut pending = check.clone();
    pending.id = "waiting-on-check".into();
    pending.status = TaskStatus::Pending;
    data.tasks.insert(pending.id.clone(), pending);
    recompute_run(data, &run.id);
    assert_eq!(data.runs[&run.id].status, RunStatus::Waiting);
    for status in [RunStatus::Stopped, RunStatus::Closed] {
        data.runs.get_mut(&run.id).unwrap().status = status;
        recompute_run(data, &run.id);
        assert_eq!(data.runs[&run.id].status, status);
    }
}

/// Completed-first is deliberate: runWaits surfaces an open gate itself.
/// Replaced/withdrawn history must give the same label as no history.
#[test]
fn recompute_run_completed_status_ignores_history_with_an_open_gate() {
    for with_history in [false, true] {
        let store = OrchestrationStore::default();
        let (run, first) = pending_plan(&store);
        let current = if with_history {
            let withdrawn = task(&store, &run, vec![]);
            store
                .revise_task(
                    "chat:master",
                    &withdrawn.id,
                    TaskRevision {
                        withdraw: true,
                        ..TaskRevision::default()
                    },
                )
                .unwrap();
            store
                .approve_plan("chat:master", &run.id, None, None)
                .unwrap();
            finish_attempt(&store, start_task(&store, &first.id), WorkerOutcome::Failed);
            let replacement = task(&store, &run, vec![]);
            store
                .supersede("chat:master", &first.id, &replacement.id)
                .unwrap();
            replacement
        } else {
            first
        };
        store
            .approve_plan("chat:master", &run.id, None, None)
            .unwrap();
        let attempt = start_task(&store, &current.id);
        let gate = store
            .create_gate("chat:master", run.id.clone(), None, "Decide".into(), vec![])
            .unwrap();
        finish_attempt(&store, attempt, WorkerOutcome::Completed);
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert_eq!(
            snapshot.runs[0].status,
            RunStatus::Completed,
            "{with_history}"
        );
        assert!(snapshot
            .tasks
            .iter()
            .filter(|t| { t.superseded_by.is_none() && t.status != TaskStatus::Cancelled })
            .all(|t| t.status == TaskStatus::Completed));
        assert_eq!(
            snapshot
                .gates
                .iter()
                .find(|g| g.id == gate.id)
                .unwrap()
                .status,
            GateStatus::Open
        );
    }
}

#[test]
fn loading_corrects_only_stale_finished_run_statuses() {
    for (stored, current, verdict, gated, expected) in [
        // Like run_65d009e8: failed history, withdrawals and passing checks.
        (
            RunStatus::Failed,
            TaskStatus::Completed,
            Some(Verdict::Pass),
            false,
            RunStatus::Completed,
        ),
        (
            RunStatus::Failed,
            TaskStatus::Failed,
            None,
            false,
            RunStatus::Failed,
        ),
        (
            RunStatus::Completed,
            TaskStatus::Completed,
            Some(Verdict::Pass),
            false,
            RunStatus::Completed,
        ),
        (
            RunStatus::Completed,
            TaskStatus::Completed,
            Some(Verdict::Pass),
            true,
            RunStatus::Completed,
        ),
        (
            RunStatus::Completed,
            TaskStatus::Completed,
            Some(Verdict::Fail),
            false,
            RunStatus::Completed,
        ),
        (
            RunStatus::Completed,
            TaskStatus::Completed,
            None,
            false,
            RunStatus::Completed,
        ),
        (
            RunStatus::Stopped,
            TaskStatus::Completed,
            Some(Verdict::Pass),
            false,
            RunStatus::Stopped,
        ),
        (
            RunStatus::Closed,
            TaskStatus::Completed,
            Some(Verdict::Pass),
            false,
            RunStatus::Closed,
        ),
        (
            RunStatus::Planning,
            TaskStatus::Completed,
            Some(Verdict::Pass),
            false,
            RunStatus::Planning,
        ),
        (
            RunStatus::Running,
            TaskStatus::Completed,
            Some(Verdict::Pass),
            false,
            RunStatus::Running,
        ),
        (
            RunStatus::Waiting,
            TaskStatus::Completed,
            Some(Verdict::Pass),
            false,
            RunStatus::Waiting,
        ),
    ] {
        let root = crate::test_dir::TestDir::new("run-status-load");
        let _profile = crate::profile::started_in(&root);
        let path = root.join("orchestrations.json");
        let store = OrchestrationStore::default();
        let run = run(&store);
        let check = task(&store, &run, vec![]);
        let replaced = task(&store, &run, vec![]);
        let withdrawn = task(&store, &run, vec![]);
        if gated {
            store
                .create_gate("chat:master", run.id.clone(), None, "Decide".into(), vec![])
                .unwrap();
        }
        store
            .mutate(|data| {
                let current_check = data.tasks.get_mut(&check.id).unwrap();
                current_check.kind = TaskKind::Review;
                current_check.status = current;
                current_check.verdict = verdict;
                let replaced = data.tasks.get_mut(&replaced.id).unwrap();
                replaced.status = TaskStatus::Failed;
                replaced.superseded_by = Some(check.id.clone());
                data.tasks.get_mut(&withdrawn.id).unwrap().status = TaskStatus::Cancelled;
                let run = data.runs.get_mut(&run.id).unwrap();
                run.status = stored;
                run.updated_at = 123;
                Ok(())
            })
            .unwrap();
        let data = store.inner.lock().unwrap().data.clone();
        let bytes = serde_json::to_vec(&data).unwrap();
        fs::write(&path, &bytes).unwrap();
        let loaded = OrchestrationStore::load(path.clone());
        let mut expected_data = serde_json::to_value(&data).unwrap();
        expected_data["runs"][&run.id]["status"] = json!(expected);
        assert_eq!(
            serde_json::to_value(&loaded.inner.lock().unwrap().data).unwrap(),
            expected_data,
            "{stored:?}, {current:?}, {verdict:?}, gated={gated}"
        );
        let saved = fs::read(&path).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&saved).unwrap(),
            expected_data
        );
        if stored == expected {
            assert_eq!(
                saved, bytes,
                "an unchanged status must not rewrite the ledger"
            );
        } else {
            let reloaded = OrchestrationStore::load(path.clone());
            assert_eq!(
                reloaded.inner.lock().unwrap().data.runs[&run.id].status,
                expected
            );
            assert_eq!(
                fs::read(&path).unwrap(),
                saved,
                "the correction saves only once"
            );
        }
    }
}

#[test]
fn correcting_finished_run_statuses_does_not_prune_or_touch_timestamps() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let current = task(&store, &run, vec![]);
    let mut data = store.inner.lock().unwrap().data.clone();
    data.tasks.get_mut(&current.id).unwrap().status = TaskStatus::Completed;
    data.runs.get_mut(&run.id).unwrap().status = RunStatus::Failed;
    // More messages than retention keeps: a label correction must keep all.
    for n in 0..8 {
        let id = format!("m{n}");
        data.messages.insert(
            id.clone(),
            OrchestrationMessage {
                id,
                run_id: run.id.clone(),
                from_chat_key: "chat:master".into(),
                to_chat_key: "chat:worker".into(),
                kind: "status".into(),
                subject: "s".into(),
                body: "b".into(),
                created_at: n,
                relay: None,
            },
        );
    }
    let mut expected = serde_json::to_value(&data).unwrap();
    expected["runs"][&run.id]["status"] = json!(RunStatus::Completed);
    assert!(correct_finished_run_statuses(&mut data));
    assert_eq!(serde_json::to_value(&data).unwrap(), expected);
    assert!(!correct_finished_run_statuses(&mut data));
}

#[test]
fn recompute_run_completion_survives_replaced_failure_withdrawal_and_reload() {
    let root = crate::test_dir::TestDir::new("run-history");
    let _profile = crate::profile::started_in(&root);
    let file = root.join("orchestrations.json");
    let store = OrchestrationStore::load(file.clone());
    let (run, first) = pending_plan(&store);
    let withdrawn = task(&store, &run, vec![]);
    store
        .revise_task(
            "chat:master",
            &withdrawn.id,
            TaskRevision {
                withdraw: true,
                ..TaskRevision::default()
            },
        )
        .unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    finish_attempt(&store, start_task(&store, &first.id), WorkerOutcome::Failed);
    let replacement = task(&store, &run, vec![]);
    store
        .supersede("chat:master", &first.id, &replacement.id)
        .unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    finish_attempt(
        &store,
        start_task(&store, &replacement.id),
        WorkerOutcome::Completed,
    );
    let before = store.snapshot(Some(&run.id)).unwrap();
    assert_eq!(before.runs[0].status, RunStatus::Completed);
    drop(store);
    let restored = OrchestrationStore::load(file);
    let after = restored.snapshot(Some(&run.id)).unwrap();
    assert_eq!(after.runs[0].status, RunStatus::Completed);
    let old = after.tasks.iter().find(|t| t.id == first.id).unwrap();
    assert_eq!(old.status, TaskStatus::Failed);
    assert_eq!(old.superseded_by.as_deref(), Some(replacement.id.as_str()));
    assert_eq!(old.failure.as_ref().unwrap().awaits, Awaits::Nobody);
    assert_eq!(
        after
            .tasks
            .iter()
            .find(|t| t.id == withdrawn.id)
            .unwrap()
            .status,
        TaskStatus::Cancelled
    );
}

/// Feedback 6b0870f9: only the coordinator replaces a blocked or failed
/// task of its own run, once, and never one a worker is still on.
#[test]
fn a_blocked_task_is_replaced_once_by_its_coordinator() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let attempt = running_worker(&store, &run);
    let old = attempt.task_id.clone();
    let refused = store
        .check_supersede("chat:master", &run.id, &old)
        .unwrap_err();
    assert!(refused.contains("blocked or failed"), "{refused}");
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome: WorkerOutcome::Blocked,
                summary: "Review failed".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    assert!(store.check_supersede("chat:other", &run.id, &old).is_err());
    store.check_supersede("chat:master", &run.id, &old).unwrap();
    let new = task(&store, &run, Vec::new());
    let replaced = store.supersede("chat:master", &old, &new.id).unwrap();
    assert_eq!(replaced.superseded_by.as_deref(), Some(new.id.as_str()));
    assert_eq!(replaced.status, TaskStatus::Blocked, "its history stays");
    let again = store.supersede("chat:master", &old, &new.id).unwrap_err();
    assert!(again.contains("already replaced"), "{again}");
    assert!(store
        .check_supersede("chat:master", &run.id, &new.id)
        .is_err());
}

/// A read-only review whose worker's turn ended without a report, so the
/// host holds its closing words as a proposal; and a task held behind it.
pub(crate) fn proposed_review(
    store: &OrchestrationStore,
    run: &Run,
    said: &str,
) -> (Task, Task, Attempt, ProposedReport) {
    let review = store
        .create_task_full(
            "chat:master",
            run.id.clone(),
            "Review the change".into(),
            "Say whether it is release-ready.".into(),
            Vec::new(),
            None,
            None,
            None,
            None,
            None,
            None,
            TaskKind::Review,
        )
        .unwrap();
    let after = task(store, run, vec![review.id.clone()]);
    let (_, _, attempt, _) = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                access: Access::Read,
                ..launch_for(&review.id)
            },
        )
        .unwrap();
    let attempt = store
        .activate_attempt(&attempt.id, "/tmp".into(), "review".into(), true)
        .unwrap();
    store
        .observe_worker_event(&attempt.worker_chat_key, &json!({"type": "turn.completed"}))
        .unwrap();
    store
        .propose_worker_report(&attempt.worker_chat_key, said)
        .unwrap();
    let proposal = store
        .snapshot(Some(&run.id))
        .unwrap()
        .attempts
        .into_iter()
        .find(|a| a.id == attempt.id)
        .and_then(|a| a.proposed_report)
        .expect("the words are held");
    (review, after, attempt, proposal)
}

pub(crate) fn running_worker(store: &OrchestrationStore, run: &Run) -> Attempt {
    running_worker_on(store, run, ChatAgent::Codex)
}

/// A worker whose attempt has reported: no task is active for its chat
/// any more. With `legacy_key` its chat is renamed to a key of the old
/// kind, which has no reserved prefix, so only the ledger says whose it is.
pub(crate) fn settled_worker(
    store: &OrchestrationStore,
    run: &Run,
    legacy_key: Option<&str>,
) -> Attempt {
    let worker = running_worker(store, run);
    store
        .report_worker(
            &worker.worker_chat_key,
            WorkerReport {
                attempt_id: worker.id.clone(),
                outcome: WorkerOutcome::Completed,
                summary: "done".into(),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap();
    store
        .mutate(|data| {
            let attempt = data.attempts.get_mut(&worker.id).unwrap();
            if let Some(key) = legacy_key {
                attempt.worker_chat_key = key.into();
            }
            Ok(attempt.clone())
        })
        .unwrap()
}

/// A real `claude -p` stream (2.1.292, the flag set `build_command` uses)
/// whose first turn is interrupted while a Bash call runs and whose
/// second answers the message sent after it. Feedback 240ea516.
pub(crate) fn claude_interrupted_tool() -> Vec<serde_json::Value> {
    include_str!("../../../web/src/lib/__fixtures__/claude-interrupted-tool.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).expect("a stream-json line"))
        .collect()
}

pub(crate) fn running_worker_on(
    store: &OrchestrationStore,
    run: &Run,
    agent: ChatAgent,
) -> Attempt {
    let task = task(store, run, Vec::new());
    let (_, _, attempt, _) = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                task_id: task.id,
                agent,
                model: None,
                effort: None,
                access: Access::Auto,
                new_worktree: Some(true),
                base_branch: String::new(),
            },
        )
        .unwrap();
    store
        .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
        .unwrap()
}

/// A task the run's coordinator handed to `assignee`, not started.
pub(crate) fn task_of(store: &OrchestrationStore, run: &Run, assignee: &TaskAssignee) -> Task {
    store
        .create_task_for(
            &run.coordinator_chat_key,
            run.id.clone(),
            "Implement".into(),
            "Make the requested change".into(),
            Vec::new(),
            None,
            None,
            Some(assignee.clone()),
            None,
        )
        .unwrap()
}

/// A worker running a task that was handed to `assignee`.
pub(crate) fn running_worker_of(
    store: &OrchestrationStore,
    run: &Run,
    assignee: &TaskAssignee,
) -> Attempt {
    let task = task_of(store, run, assignee);
    let (_, _, attempt, _) = store
        .reserve_attempt(&run.coordinator_chat_key, &launch_for(&task.id))
        .unwrap();
    store
        .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
        .unwrap()
}

/// Feedback cab56ae9: a retry's brief carries what the earlier attempts
/// were told, so the coordinator need not re-send it by hand.
#[test]
fn a_retry_brief_carries_the_task_s_decisions_and_only_those() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let worker = running_worker(&store, &run);
    assert!(store.task_decisions(&worker.task_id).is_none());
    let ask = |question: &str| {
        store
            .create_gate(
                &worker.worker_chat_key,
                run.id.clone(),
                Some(worker.task_id.clone()),
                question.into(),
                vec![],
            )
            .unwrap()
    };
    let size = ask("Which sprite size?");
    store
        .resolve_gate("chat:master", size.id.clone(), "96 by 96, 8 frames".into())
        .unwrap();
    ask("Spend 42 credits?");
    // A run-wide gate is not this task's decision.
    let wide = store
        .create_gate(
            "chat:master",
            run.id.clone(),
            None,
            "Pause the run?".into(),
            vec![],
        )
        .unwrap();
    store
        .resolve_gate("chat:master", wide.id, "No".into())
        .unwrap();

    let brief = store.task_decisions(&worker.task_id).unwrap();
    assert!(brief.contains(&size.id));
    assert!(brief.contains("Which sprite size?"));
    assert!(brief.contains("96 by 96, 8 frames"));
    assert!(
        !brief.contains("Spend 42 credits?"),
        "an open gate is not decided"
    );
    assert!(!brief.contains("Pause the run?"));
}

pub(crate) fn launch_for(task_id: &str) -> WorkerLaunch {
    WorkerLaunch {
        task_id: task_id.into(),
        agent: ChatAgent::Codex,
        model: None,
        effort: None,
        access: Access::Auto,
        new_worktree: None,
        base_branch: String::new(),
    }
}

/// What the run panel says a person had on screen when they decided.
fn panel_view_after_two_seconds() -> CardView {
    CardView {
        surface: "panel".into(),
        shown_ms: Some(2_000),
        updated_ms: None,
    }
}

/// [`launch_for`] in a worktree of its own.
fn launch_in_worktree(task_id: &str) -> WorkerLaunch {
    WorkerLaunch {
        new_worktree: Some(true),
        ..launch_for(task_id)
    }
}

pub(super) fn assigned(
    store: &OrchestrationStore,
    run: &Run,
    actor: &str,
    parent: Option<String>,
    depends_on: Vec<String>,
) -> Result<Task, String> {
    store.create_task_for(
        actor,
        run.id.clone(),
        "Part".into(),
        "Do the part".into(),
        depends_on,
        parent,
        None,
        Some(TaskAssignee {
            id: "agent_ada".into(),
            name: "Ada".into(),
        }),
        None,
    )
}

#[test]
fn a_plan_card_is_one_line_each_bounded_and_set_once() {
    let s = |text: &str| Some(text.to_string());
    let card = TaskCard::checked(
        s("  The chat\nlist hides   destinations. "),
        s("Show them."),
        Some(vec![
            "Badges show".into(),
            "  ".into(),
            "Tests\npass".into(),
        ]),
    )
    .unwrap()
    .unwrap();
    assert_eq!(card.problem, "The chat list hides destinations.");
    assert_eq!(card.acceptance, vec!["Badges show", "Tests pass"]);
    assert_eq!(TaskCard::checked(None, s(" "), Some(vec![])).unwrap(), None);
    assert!(TaskCard::checked(s(&"x".repeat(301)), None, None).is_err());
    assert!(TaskCard::checked(None, None, Some(vec!["a".into(); 6])).is_err());
    assert!(TaskCard::checked(None, None, Some(vec!["a".repeat(241)])).is_err());

    let root = crate::test_dir::TestDir::new("orchestration");
    let file = root.join("orchestrations.json");
    let store = OrchestrationStore::load(file.clone());
    let run = run(&store);
    let bare = task(&store, &run, Vec::new());
    assert_eq!(bare.card, None);
    let carded = |actor: &str, card: TaskCard| {
        store.create_carded_task(
            actor,
            run.id.clone(),
            "Show destinations".into(),
            "Badge each row".into(),
            Vec::new(),
            None,
            None,
            None,
            None,
            Some(card),
            None,
        )
    };
    let created = carded("chat:master", card.clone()).unwrap();
    assert_eq!(created.card.as_ref(), Some(&card));
    // One write: the task is stored, and saved, with its card already on
    // it, so neither a snapshot nor the file ever holds it without one.
    let seen = store.snapshot(Some(&run.id)).unwrap();
    let stored = seen.tasks.iter().find(|t| t.id == created.id).unwrap();
    assert_eq!(stored.card.as_ref(), Some(&card));
    let reloaded = OrchestrationStore::load(file);
    let saved = reloaded.snapshot(Some(&run.id)).unwrap();
    let by_id = |id: &str| {
        saved
            .tasks
            .iter()
            .find(|t| t.id == id)
            .unwrap()
            .card
            .clone()
    };
    assert_eq!(by_id(&created.id), Some(card.clone()));
    assert_eq!(by_id(&bare.id), None);
    // A refused create leaves no task behind, carded or not.
    assert!(carded("chat:stranger", card).is_err());
    assert_eq!(store.snapshot(Some(&run.id)).unwrap().tasks.len(), 2);
}

#[test]
fn a_pending_plan_holds_every_worker_until_the_person_approves() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    // Nothing to approve before the lead has made a plan.
    assert!(store
        .approve_plan("chat:master", &run.id, None, None)
        .is_err());
    let first = task(&store, &run, Vec::new());
    assert!(store
        .reserve_attempt("chat:master", &launch_for(&first.id))
        .unwrap_err()
        .contains("not approved"));
    assert!(store
        .approve_plan("chat:worker", &run.id, None, None)
        .is_err());
    let approved = store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    assert!(!approved.awaiting_plan_approval());
    assert_eq!(
        approved.plan_approval.unwrap().consent.unwrap().via,
        ConsentVia::Button
    );
    assert_eq!(
        store
            .approve_plan("chat:master", &run.id, None, None)
            .unwrap()
            .plan_approval
            .unwrap()
            .status,
        PlanStatus::Approved
    );
    assert!(store
        .reserve_attempt("chat:master", &launch_for(&first.id))
        .is_ok());
}

#[test]
fn approval_covers_the_plan_seen_and_new_lead_work_needs_it_again() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    let api = crate::git_ops::workflow::tests::Repo::new();
    let destination = TaskDestination {
        project_id: "shop".into(),
        project_name: "Shop".into(),
        repository: api.root.clone(),
    };
    let first = store
        .create_task_for(
            "chat:master",
            run.id.clone(),
            "API".into(),
            "Build the API".into(),
            Vec::new(),
            None,
            None,
            Some(TaskAssignee {
                id: "agent_ada".into(),
                name: "Ada".into(),
            }),
            Some(destination.clone()),
        )
        .unwrap();
    // The destination is part of the persisted task.
    let stored = store.snapshot(None).unwrap().tasks.remove(0);
    assert_eq!(stored.destination.as_ref(), Some(&destination));
    assert!(stored.approved_at.is_none());
    // The person approves exactly what they saw, nothing else.
    let stale = [first.id.clone(), "task_other".into()];
    assert!(store
        .approve_plan("chat:master", &run.id, Some(&stale), None)
        .unwrap_err()
        .contains("changed"));
    store
        .approve_plan("chat:master", &run.id, Some(&[first.id.clone()]), None)
        .unwrap();
    assert!(store.snapshot(None).unwrap().tasks[0].approved_at.is_some());

    // The lead adds a task after approval: it waits for the person, and
    // the approved destination of the first task is untouched.
    let (_, _, attempt, _) = store
        .reserve_attempt("chat:master", &launch_for(&first.id))
        .unwrap();
    let attempt = store
        .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
        .unwrap();
    let second = assigned(&store, &run, "chat:master", None, Vec::new()).unwrap();
    let snapshot = store.snapshot(None).unwrap();
    assert!(snapshot.runs[0].awaiting_plan_approval());
    let first_now = snapshot.tasks.iter().find(|t| t.id == first.id).unwrap();
    assert_eq!(first_now.destination.as_ref(), Some(&destination));
    assert!(store
        .reserve_attempt("chat:master", &launch_for(&second.id))
        .unwrap_err()
        .contains("not approved"));
    // Only the new task is awaiting approval now.
    assert!(store
        .approve_plan(
            "chat:master",
            &run.id,
            Some(&[first.id.clone(), second.id.clone()]),
            None
        )
        .is_err());
    store
        .approve_plan("chat:master", &run.id, Some(&[second.id.clone()]), None)
        .unwrap();

    // A manager's own split is not the top plan and needs no approval.
    let part = assigned(
        &store,
        &run,
        &attempt.worker_chat_key,
        Some(first.id.clone()),
        Vec::new(),
    );
    assert!(part.is_ok());
    assert!(!store.snapshot(None).unwrap().runs[0].awaiting_plan_approval());
}

pub(super) fn pending_plan(store: &OrchestrationStore) -> (Run, Task) {
    let run = run(store);
    store.require_plan_approval(&run.id).unwrap();
    let task = task(store, &run, Vec::new());
    (run, task)
}

pub(super) fn plan_of(store: &OrchestrationStore, run_id: &str) -> PlanApproval {
    store
        .snapshot(Some(run_id))
        .unwrap()
        .runs
        .remove(0)
        .plan_approval
        .unwrap()
}

/// A plan the person approved with `count` ready tasks on it, oldest
/// first.
pub(super) fn approved_plan(store: &OrchestrationStore, count: usize) -> (Run, Vec<Task>) {
    let (run, first) = pending_plan(store);
    let mut tasks = vec![first];
    tasks.extend((1..count).map(|_| task(store, &run, Vec::new())));
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    // Created in one millisecond they would sort by their random ids.
    store
        .mutate(|data| {
            for (age, task) in tasks.iter().rev().enumerate() {
                data.tasks.get_mut(&task.id).unwrap().created_at -= 10 * (age as i64 + 1);
            }
            Ok(())
        })
        .unwrap();
    (run, tasks)
}

pub(super) fn held(store: &OrchestrationStore, run_id: &str) -> BTreeSet<String> {
    store
        .snapshot(Some(run_id))
        .unwrap()
        .tasks
        .into_iter()
        .filter(|task| task.held_by_plan == Some(true))
        .map(|task| task.id)
        .collect()
}

pub(super) fn wave(store: &OrchestrationStore, run_id: &str) -> Vec<String> {
    let snapshot = store.snapshot(Some(run_id)).unwrap();
    automation::ready_wave(&snapshot, &snapshot.runs[0])
        .into_iter()
        .map(|task| task.id)
        .collect()
}

pub(super) fn ids(tasks: &[&Task]) -> BTreeSet<String> {
    tasks.iter().map(|task| task.id.clone()).collect()
}

/// The person's decision of 2026-10-11: a plan back in front of them
/// holds only what they have not approved. On the run that prompted it,
/// three approved tasks sat ready for 25 minutes behind two new ones.
#[test]
fn a_pending_revision_holds_only_what_the_person_has_not_approved() {
    let store = OrchestrationStore::default();
    let (run, approved) = approved_plan(&store, 2);
    let added = task(&store, &run, Vec::new());
    let after_added = task(&store, &run, vec![added.id.clone()]);
    assert!(plan_of(&store, &run.id).status == PlanStatus::Pending);

    // What waits is the new task and what depends on it; the page and
    // the coordinator read it off each task.
    assert_eq!(held(&store, &run.id), ids(&[&added, &after_added]));
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    for task in &snapshot.tasks {
        let json = serde_json::to_value(task).unwrap();
        assert_eq!(
            json.get("heldByPlan").and_then(|held| held.as_bool()),
            Some(task.id == added.id || task.id == after_added.id),
        );
    }
    // The host's wave is the approved ones, in order.
    assert_eq!(
        wave(&store, &run.id),
        [approved[0].id.clone(), approved[1].id.clone()]
    );
    // And by the door every start goes through.
    for new in [&added, &after_added] {
        let refused = store
            .reserve_attempt("chat:master", &launch_for(&new.id))
            .unwrap_err();
        assert!(
            refused.contains("has not approved this task yet"),
            "{refused}"
        );
    }
    let started = start_task(&store, &approved[0].id);
    assert_eq!(started.status, AttemptStatus::Running);
    assert!(plan_of(&store, &run.id).status == PlanStatus::Pending);

    // Approved, the new task starts and its dependant waits on it only.
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    assert!(held(&store, &run.id).is_empty());
    finish_attempt(&store, started, WorkerOutcome::Completed);
    assert_eq!(
        wave(&store, &run.id),
        [approved[1].id.clone(), added.id.clone()]
    );
}

/// A held task is left out before the wave is cut to the run's slots,
/// so it never takes one from a task the person approved.
#[test]
fn a_held_task_takes_no_slot_and_the_limit_still_counts() {
    let store = OrchestrationStore::default();
    let (run, approved) = approved_plan(&store, 4);
    assert_eq!(run.max_concurrent, 2);
    // The two oldest are resized: their approval is withdrawn.
    for task in &approved[..2] {
        store.set_task_size(&task.id, TaskSize::Large).unwrap();
    }
    assert_eq!(held(&store, &run.id), ids(&[&approved[0], &approved[1]]));
    assert_eq!(
        wave(&store, &run.id),
        [approved[2].id.clone(), approved[3].id.clone()]
    );
    // maxConcurrent is unchanged: one running leaves one slot, two none.
    start_task(&store, &approved[2].id);
    assert_eq!(wave(&store, &run.id), [approved[3].id.clone()]);
    start_task(&store, &approved[3].id);
    assert!(wave(&store, &run.id).is_empty());
    // Approving the resize does not start a third worker either.
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    assert!(wave(&store, &run.id).is_empty());
    let full = store
        .reserve_attempt("chat:master", &launch_for(&approved[0].id))
        .unwrap_err();
    assert!(full.contains("allowed workers active"), "{full}");
}

/// Whatever depends on an unapproved task waits with it, however far
/// down, even where the ledger says the dependency has finished.
#[test]
fn what_depends_on_an_unapproved_task_waits_with_it() {
    let store = OrchestrationStore::default();
    let (run, base) = pending_plan(&store);
    let next = task(&store, &run, vec![base.id.clone()]);
    let last = task(&store, &run, vec![next.id.clone()]);
    let apart = task(&store, &run, Vec::new());
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    assert!(held(&store, &run.id).is_empty());
    // The base is resized: only it is on the card, and three tasks wait.
    store.set_task_size(&base.id, TaskSize::Large).unwrap();
    let waiting: Vec<String> = {
        let inner = store.inner.lock().unwrap();
        awaiting_approval(&inner.data, &run.id)
            .map(|task| task.id.clone())
            .collect()
    };
    assert_eq!(waiting, [base.id.clone()]);
    assert_eq!(held(&store, &run.id), ids(&[&base, &next, &last]));
    // Not for want of a finished dependency alone: with the ledger made
    // to say the base is done, the plan still holds what follows it.
    store
        .mutate(|data| {
            data.tasks.get_mut(&base.id).unwrap().status = TaskStatus::Completed;
            data.tasks.get_mut(&next.id).unwrap().status = TaskStatus::Ready;
            Ok(())
        })
        .unwrap();
    assert_eq!(wave(&store, &run.id), [apart.id.clone()]);
    for dependant in [&next, &last] {
        let refused = store
            .reserve_attempt("chat:master", &launch_for(&dependant.id))
            .unwrap_err();
        assert!(
            refused.contains("depends on \"Implement\", which the person has not approved yet"),
            "{refused}"
        );
    }
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    assert!(held(&store, &run.id).is_empty());
    assert_eq!(
        wave(&store, &run.id).into_iter().collect::<BTreeSet<_>>(),
        ids(&[&next, &apart])
    );
}

/// A manager's subtask is never on the plan card: it goes by the
/// approval of the task it is part of. Only a split by that task's own
/// manager is one (`Task::split_by`); the review of 018a40a (H2) made a
/// "subtask" here as the coordinator, which is new work and is tested
/// in `approval_tests`.
#[test]
fn a_subtask_goes_by_its_parents_approval() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    let managed = assigned(&store, &run, "chat:master", None, Vec::new()).unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    let manager = start_task(&store, &managed.id);
    let part = assigned(
        &store,
        &run,
        &manager.worker_chat_key,
        Some(managed.id.clone()),
        Vec::new(),
    )
    .unwrap();
    assert_eq!(part.split_by.as_deref(), Some(manager.id.as_str()));
    assert!(part.approved_at.is_none());
    assert!(
        plan_of(&store, &run.id).status == PlanStatus::Approved,
        "a split does not put the plan back"
    );
    task(&store, &run, Vec::new());
    assert!(plan_of(&store, &run.id).status == PlanStatus::Pending);
    assert!(!held(&store, &run.id).contains(&part.id));
    assert!(wave(&store, &run.id).contains(&part.id));
    // Its parent's approval withdrawn (the manager stopped, and the task
    // changed hands), it waits with it.
    finish_attempt(&store, manager, WorkerOutcome::Blocked);
    store
        .reassign_task(
            "chat:master",
            &managed.id,
            (
                None,
                Some(TaskAssignee {
                    id: "agent_bo".into(),
                    name: "Bo".into(),
                }),
                None,
            ),
            "Bo takes it over.".into(),
        )
        .unwrap();
    assert!(held(&store, &run.id).contains(&part.id));
    let refused = store
        .reserve_attempt("chat:master", &launch_for(&part.id))
        .unwrap_err();
    assert!(
        refused.contains("part of \"Part\", which the person has not approved yet"),
        "{refused}"
    );
}

/// A task changed while it waits is still unapproved: the revision the
/// person has not seen starts nothing.
#[test]
fn a_revised_task_waits_until_the_person_approves_its_revision() {
    let store = OrchestrationStore::default();
    let (run, approved) = approved_plan(&store, 1);
    let added = task(&store, &run, Vec::new());
    let before = plan_of(&store, &run.id).revision;
    store
        .revise_task(
            "chat:master",
            &added.id,
            TaskRevision {
                spec: Some("Do it another way".into()),
                ..TaskRevision::default()
            },
        )
        .unwrap();
    assert!(plan_of(&store, &run.id).revision > before);
    assert_eq!(held(&store, &run.id), ids(&[&added]));
    assert!(store
        .reserve_attempt("chat:master", &launch_for(&added.id))
        .unwrap_err()
        .contains("has not approved this task yet"));
    assert_eq!(wave(&store, &run.id), [approved[0].id.clone()]);
    // An approval of the revision they did not see is refused, and
    // nothing starts on it.
    assert!(store
        .approve_plan("chat:master", &run.id, None, Some(before))
        .is_err());
    assert!(store
        .reserve_attempt("chat:master", &launch_for(&added.id))
        .is_err());
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    start_task(&store, &added.id);
}

/// Rejecting an amendment withdraws the new work and leaves the plan
/// the person approved before in force, its tasks starting as they did
/// while the card waited.
#[test]
fn a_rejected_amendment_leaves_the_approved_tasks_starting() {
    let store = OrchestrationStore::default();
    let (run, approved) = approved_plan(&store, 2);
    let added = task(&store, &run, Vec::new());
    let running = start_task(&store, &approved[0].id);
    store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&[added.id.clone()]),
            Some(plan_of(&store, &run.id).revision),
            None,
            CardView {
                surface: "chat".into(),
                shown_ms: Some(5_000),
                updated_ms: None,
            },
        )
        .unwrap();
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let by_id = |id: &str| snapshot.tasks.iter().find(|task| task.id == id).unwrap();
    assert_eq!(by_id(&added.id).status, TaskStatus::Cancelled);
    assert_eq!(by_id(&running.task_id).status, TaskStatus::Running);
    assert_ne!(snapshot.runs[0].status, RunStatus::Stopped);
    assert!(snapshot
        .tasks
        .iter()
        .all(|task| task.held_by_plan == Some(false)));
    assert_eq!(wave(&store, &run.id), [approved[1].id.clone()]);
    start_task(&store, &approved[1].id);
    assert!(store
        .reserve_attempt("chat:master", &launch_for(&added.id))
        .unwrap_err()
        .contains("no longer accepts workers"));
}

/// A coordinator's retry is one of the ways an approved task comes to
/// run again, and a card waiting for other work does not hold it.
#[test]
fn a_retry_of_an_approved_task_starts_while_a_revision_waits() {
    let store = OrchestrationStore::default();
    let (run, approved) = approved_plan(&store, 1);
    finish_attempt(
        &store,
        start_task(&store, &approved[0].id),
        WorkerOutcome::Failed,
    );
    let added = task(&store, &run, Vec::new());
    assert_eq!(held(&store, &run.id), ids(&[&added]));
    let retry = start_task(&store, &approved[0].id);
    assert_eq!(retry.number, 2);
    finish_attempt(&store, retry, WorkerOutcome::Blocked);
    assert_eq!(start_task(&store, &approved[0].id).number, 3);
    assert!(plan_of(&store, &run.id).status == PlanStatus::Pending);
}

/// Stopping a run stops its approved tasks too, a pending card or not.
#[test]
fn a_stopped_run_starts_nothing_however_approved() {
    let store = OrchestrationStore::default();
    let (run, approved) = approved_plan(&store, 2);
    task(&store, &run, Vec::new());
    assert_eq!(wave(&store, &run.id).len(), 2);
    store
        .stop_run("chat:master", run.id.clone(), "Not now".into())
        .unwrap();
    assert!(wave(&store, &run.id).is_empty());
    let refused = store
        .reserve_attempt("chat:master", &launch_for(&approved[0].id))
        .unwrap_err();
    assert!(refused.contains("no longer accepts workers"), "{refused}");
}

/// `orchestration_dispatch_ready` and the scheduler start the approved
/// tasks of a plan that is back with the person, and only those.
#[test]
fn dispatch_ready_starts_the_approved_tasks_of_a_pending_plan() {
    let store = OrchestrationStore::default();
    let (run, approved) = approved_plan(&store, 2);
    let added = task(&store, &run, Vec::new());
    enable_automatic_dispatch(&store, &run.id);
    // Where each would run is gone, so a start reserves an attempt and
    // launches no process: the test's stand-in for a launch. Written as
    // what was approved too, or the start would be refused for asking
    // for a destination the person never saw.
    store
        .mutate(|data| {
            for task in data.tasks.values_mut() {
                task.destination = Some(TaskDestination {
                    project_id: "gone".into(),
                    project_name: "Gone".into(),
                    repository: "/nowhere".into(),
                });
                if let Some(approved) = &mut task.approved {
                    approved.destination = task.destination.clone();
                }
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(held(&store, &run.id), ids(&[&added]));
    let workspaces =
        crate::workspaces::WorkspaceState::with_projects(vec![serde_json::from_value(json!({
            "id": "workspace", "name": "Project", "primary_path": "/tmp", "paths": [],
        }))
        .unwrap()]);
    store
        .dispatch_ready(
            Arc::new(ChatManager::default()),
            &workspaces,
            "chat:master",
            &run.id,
        )
        .unwrap();
    let attempts = store.snapshot(Some(&run.id)).unwrap().attempts;
    let tried: BTreeSet<String> = attempts.iter().map(|a| a.task_id.clone()).collect();
    assert_eq!(tried, ids(&[&approved[0], &approved[1]]));
    assert!(attempts.iter().all(|a| a.number == 1));
}

/// A one-part message and what was on screen when it was sent.
fn said(turn: &str, text: &str, seen: &[(&str, u32)]) -> PersonTurn {
    said_in_parts(turn, text, &[seen])
}

/// Coalesced follow-ups: what each part saw, part by part.
fn said_in_parts(turn: &str, text: &str, parts: &[&[(&str, u32)]]) -> PersonTurn {
    PersonTurn {
        turn_id: turn.into(),
        text: text.into(),
        parts_seen: parts
            .iter()
            .map(|seen| {
                seen.iter()
                    .map(|(run_id, revision)| SeenPlan {
                        run_id: (*run_id).into(),
                        revision: *revision,
                    })
                    .collect()
            })
            .collect(),
    }
}

fn kinded_task(
    store: &OrchestrationStore,
    run: &Run,
    kind: TaskKind,
    depends_on: Vec<String>,
) -> Task {
    store
        .create_task_full(
            "chat:master",
            run.id.clone(),
            "Review the change".into(),
            "Say whether it is release-ready.".into(),
            depends_on,
            None,
            None,
            None,
            None,
            None,
            None,
            kind,
        )
        .unwrap()
}

fn report(
    store: &OrchestrationStore,
    attempt: &Attempt,
    verdict: Option<Verdict>,
) -> Result<Task, String> {
    store.report_worker(
        &attempt.worker_chat_key,
        WorkerReport {
            attempt_id: attempt.id.clone(),
            outcome: WorkerOutcome::Completed,
            summary: "Checked".into(),
            files_modified: vec![],
            verdict,
        },
    )
}

fn started(store: &OrchestrationStore, task: &Task) -> Attempt {
    let (_, _, attempt, _) = store
        .reserve_attempt("chat:master", &launch_for(&task.id))
        .unwrap();
    store
        .activate_attempt(&attempt.id, "/tmp".into(), "review".into(), true)
        .unwrap()
}

#[test]
fn a_check_task_releases_its_dependants_only_on_a_passing_verdict() {
    // Feedback ee0a43b0 B6: a verdict was optional, so a review that
    // completed without one released the screenshot task behind it.
    let store = OrchestrationStore::default();
    let run = run(&store);
    let review = kinded_task(&store, &run, TaskKind::Review, Vec::new());
    let screenshots = task(&store, &run, vec![review.id.clone()]);
    let attempt = started(&store, &review);

    let refused = report(&store, &attempt, None).unwrap_err();
    assert!(refused.contains("verdict"), "{refused}");
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let find = |s: &Snapshot, id: &str| s.tasks.iter().find(|t| t.id == id).unwrap().clone();
    assert_eq!(find(&snapshot, &review.id).status, TaskStatus::Running);
    assert_eq!(find(&snapshot, &screenshots.id).status, TaskStatus::Pending);
    // The refusal wrote nothing, so the same attempt can settle properly.
    report(&store, &attempt, Some(Verdict::Pass)).unwrap();
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    assert_eq!(find(&snapshot, &screenshots.id).status, TaskStatus::Ready);

    // A failed or blocked check says it could not judge: allowed without
    // a verdict, and it releases nothing.
    let check = kinded_task(&store, &run, TaskKind::Acceptance, Vec::new());
    let after = task(&store, &run, vec![check.id.clone()]);
    let attempt = started(&store, &check);
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome: WorkerOutcome::Failed,
                summary: "Environment down".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    assert_eq!(find(&snapshot, &after.id).status, TaskStatus::Pending);
}

#[test]
fn a_completed_check_task_without_a_verdict_never_releases_even_from_a_stored_record() {
    // A record written by an older host, or edited by hand: a check task
    // completed with no verdict. Nothing may treat it as passed.
    let store = OrchestrationStore::default();
    let run = run(&store);
    let check = kinded_task(&store, &run, TaskKind::Check, Vec::new());
    let dependant = task(&store, &run, vec![check.id.clone()]);
    store
        .mutate(|data| {
            let task = data.tasks.get_mut(&check.id).unwrap();
            task.status = TaskStatus::Completed;
            task.verdict = None;
            make_ready(data, &run.id);
            recompute_run(data, &run.id);
            Ok(())
        })
        .unwrap();
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let held = snapshot
        .tasks
        .iter()
        .find(|t| t.id == dependant.id)
        .unwrap();
    assert_eq!(held.status, TaskStatus::Pending);
    assert_eq!(snapshot.runs[0].status, RunStatus::Waiting);
    assert!(store
        .reserve_attempt("chat:master", &launch_for(&dependant.id))
        .unwrap_err()
        .contains("waiting for its dependencies"));
}

#[test]
fn a_task_kind_is_part_of_the_plan_the_person_approves_and_legacy_tasks_stay_work() {
    let store = OrchestrationStore::default();
    let (run, first) = pending_plan(&store);
    let before = plan_of(&store, &run.id).revision;
    // Serialised without a kind, exactly as before kinds existed.
    let json = serde_json::to_value(&first).unwrap();
    assert!(json.get("kind").is_none());
    let revised = store
        .revise_task(
            "chat:master",
            &first.id,
            TaskRevision {
                kind: Some(TaskKind::Review),
                ..TaskRevision::default()
            },
        )
        .unwrap();
    assert_eq!(revised.kind, TaskKind::Review);
    assert_eq!(plan_of(&store, &run.id).revision, before + 1);
    let legacy: Task = serde_json::from_value(json).unwrap();
    assert_eq!(legacy.kind, TaskKind::Work);
    assert_eq!(legacy.verdict, None);
}

#[test]
fn a_review_that_finished_but_failed_its_check_holds_what_depends_on_it() {
    // Feedback ee0a43b0: a review that said NOT RELEASE-READY settled as
    // completed and released the screenshot task behind it.
    let settle = |verdict: Option<Verdict>| {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let review = task(&store, &run, Vec::new());
        let screenshots = task(&store, &run, vec![review.id.clone()]);
        let (_, _, attempt, _) = store
            .reserve_attempt("chat:master", &launch_for(&review.id))
            .unwrap();
        let attempt = store
            .activate_attempt(&attempt.id, "/tmp".into(), "review".into(), true)
            .unwrap();
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id,
                    outcome: WorkerOutcome::Completed,
                    summary: "Review completed: NOT RELEASE-READY".into(),
                    files_modified: vec![],
                    verdict,
                },
            )
            .unwrap();
        (store, run, screenshots)
    };

    let (store, run, screenshots) = settle(Some(Verdict::Fail));
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let held = snapshot
        .tasks
        .iter()
        .find(|t| t.id == screenshots.id)
        .unwrap();
    assert_eq!(
        held.status,
        TaskStatus::Pending,
        "a failing check releases nothing"
    );
    assert_eq!(snapshot.runs[0].status, RunStatus::Waiting);
    assert!(snapshot
        .tasks
        .iter()
        .any(|t| t.verdict == Some(Verdict::Fail)));
    assert!(snapshot.notifications.iter().any(|n| n.kind == "verdict"
        && n.body.contains("FAILING verdict")
        && n.body.contains(&screenshots.id)));
    assert!(store
        .reserve_attempt("chat:master", &launch_for(&screenshots.id))
        .unwrap_err()
        .contains("waiting for its dependencies"));

    // A pass, or no verdict at all (ordinary work), releases as before.
    for verdict in [Some(Verdict::Pass), None] {
        let (store, run, screenshots) = settle(verdict);
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert_eq!(
            snapshot
                .tasks
                .iter()
                .find(|t| t.id == screenshots.id)
                .unwrap()
                .status,
            TaskStatus::Ready
        );
    }
}

#[test]
fn a_backup_takes_over_a_task_only_through_the_person_and_never_beside_a_live_worker() {
    // Feedback c890a843: the person asked Noah, Maya's designated
    // backup, to take over a ready task, and nothing could hand it over.
    let store = OrchestrationStore::default();
    let (run, first) = pending_plan(&store);
    let who = |id: &str, name: &str| TaskAssignee {
        id: id.into(),
        name: name.into(),
    };
    let worker = |model: &str| automation::WorkerSettings {
        agent: ChatAgent::Claude,
        access: Access::Auto,
        model: Some(model.into()),
        effort: None,
        recovery: None,
    };
    store
        .reassign_task(
            "chat:master",
            &first.id,
            (Some(worker("opus")), Some(who("maya", "Maya")), None),
            "Start with Maya".into(),
        )
        .unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();

    // Maya's attempt is live: no second writer. It starts as approved
    // for her; the handoff binds its first start to those settings.
    let maya = WorkerLaunch {
        agent: ChatAgent::Claude,
        model: Some("opus".into()),
        ..launch_for(&first.id)
    };
    let (_, _, attempt, _) = store.reserve_attempt("chat:master", &maya).unwrap();
    let attempt = store
        .activate_attempt(&attempt.id, "/tmp".into(), "maya".into(), true)
        .unwrap();
    let handoff = || {
        store.reassign_task(
            "chat:master",
            &first.id,
            (Some(worker("sonnet")), Some(who("noah", "Noah")), None),
            "The person asked Noah to take over from Maya.".into(),
        )
    };
    assert!(handoff().unwrap_err().contains("still working"));
    assert!(store
        .reassign_task(
            "chat:worker",
            &first.id,
            (None, Some(who("noah", "Noah")), None),
            "x".into()
        )
        .is_err());

    // Maya's attempt settles without finishing: the backup takes it.
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome: WorkerOutcome::Blocked,
                summary: "Provider limit".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    let task = handoff().unwrap();
    assert_eq!(task.assignee.as_ref().unwrap().id, "noah");
    assert_eq!(
        task.worker.as_ref().unwrap().model.as_deref(),
        Some("sonnet")
    );
    assert_eq!(task.handoffs.len(), 2);
    let last = task.handoffs.last().unwrap();
    assert_eq!(last.from.as_ref().map(|a| a.id.as_str()), Some("maya"));
    assert_eq!(last.to.id, "noah");
    assert!(last.reason.contains("take over"));
    // The new owner is the person's to approve; nobody starts meanwhile.
    assert_eq!(plan_of(&store, &run.id).status, PlanStatus::Pending);
    assert!(store
        .reserve_attempt("chat:master", &launch_for(&first.id))
        .unwrap_err()
        .contains("not approved"));
    assert!(handoff().unwrap_err().contains("already has this task"));
}

/// The coordinator hands `task_id` to Noah.
fn coordinator_hands_to_noah(store: &OrchestrationStore, task_id: &str) -> Result<Task, String> {
    store.reassign_task(
        "chat:master",
        task_id,
        (
            None,
            Some(TaskAssignee {
                id: "noah".into(),
                name: "Noah".into(),
            }),
            None,
        ),
        "Noah takes it over.".into(),
    )
}

/// An approved task in a run with other work still to do: a run whose only
/// task failed is called failed, and nothing in it changes hands.
fn one_of_two_approved(store: &OrchestrationStore) -> (Run, Task) {
    let (run, mut tasks) = approved_plan(store, 2);
    (run, tasks.remove(0))
}

fn task_now(store: &OrchestrationStore, task_id: &str) -> Task {
    store
        .snapshot(None)
        .unwrap()
        .tasks
        .into_iter()
        .find(|task| task.id == task_id)
        .unwrap()
}

/// A task the person stopped is theirs to start again. A new owner would put
/// it back on the plan card, where an approval (a standing one too) clears
/// the stop and the coordinator's own start goes through: the work restarted
/// with nobody asked. So the coordinator's reassignment is refused, and
/// nothing changes.
#[test]
fn a_task_the_person_stopped_does_not_change_hands_through_its_coordinator() {
    let store = OrchestrationStore::default();
    let (run, task) = one_of_two_approved(&store);
    start_as_planned(&store, &task.id);
    store.stop_task(&task.id, None).unwrap();
    let before = task_now(&store, &task.id);
    assert_eq!(
        coordinator_hands_to_noah(&store, &task.id).unwrap_err(),
        STOPPED_NOT_REASSIGNED
    );
    let kept = task_now(&store, &task.id);
    assert!(kept.stopped.is_some());
    assert_eq!(kept.assignee, before.assignee);
    assert!(kept.handoffs.is_empty());
    assert!(kept.approved.is_some());
    assert_eq!(kept.approved, before.approved);
    assert_eq!(plan_of(&store, &run.id).status, PlanStatus::Approved);
}

/// A failed task that used its automatic retries is the person's to decide:
/// a new owner, and the approval that gives the retries back, is not the
/// coordinator's way round the budget.
#[test]
fn a_failed_task_past_its_retries_does_not_change_hands_through_its_coordinator() {
    let store = OrchestrationStore::default();
    let (run, task) = one_of_two_approved(&store);
    let attempt = start_as_planned(&store, &task.id);
    finish_attempt(&store, attempt, WorkerOutcome::Failed);
    store
        .mutate(|data| {
            data.tasks.get_mut(&task.id).unwrap().retries_used = retry::RETRY_LIMIT;
            Ok(())
        })
        .unwrap();
    let before = task_now(&store, &task.id);
    assert_eq!(
        coordinator_hands_to_noah(&store, &task.id).unwrap_err(),
        retry::RETRIES_USED
    );
    let kept = task_now(&store, &task.id);
    assert_eq!(kept.status, TaskStatus::Failed);
    assert_eq!(kept.assignee, before.assignee);
    assert!(kept.handoffs.is_empty());
    assert_eq!(kept.approved, before.approved);
    assert_eq!(plan_of(&store, &run.id).status, PlanStatus::Approved);
}

/// The control: an approved task that failed with its retries left still
/// changes hands at the coordinator's word, and goes to the person.
#[test]
fn a_failed_task_with_retries_left_changes_hands_through_its_coordinator() {
    let store = OrchestrationStore::default();
    let (run, task) = one_of_two_approved(&store);
    let attempt = start_as_planned(&store, &task.id);
    finish_attempt(&store, attempt, WorkerOutcome::Failed);
    let moved = coordinator_hands_to_noah(&store, &task.id).unwrap();
    assert_eq!(moved.assignee.as_ref().unwrap().id, "noah");
    assert!(moved.approved.is_none());
    assert_eq!(plan_of(&store, &run.id).status, PlanStatus::Pending);
}

#[test]
fn a_start_from_before_a_handoff_cannot_run_or_record_the_replaced_settings() {
    // Review of the mission page: a page holding the old snapshot of a
    // blocked task pressed Start retry after another page had handed the
    // task to Codex at read access and the person approved it. Its request
    // still named the old Claude attempt's settings, at full access.
    let store = OrchestrationStore::default();
    let (run, first) = pending_plan(&store);
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    let old = WorkerLaunch {
        agent: ChatAgent::Claude,
        model: Some("opus".into()),
        access: Access::Full,
        ..launch_for(&first.id)
    };
    let (_, _, attempt, _) = store.reserve_attempt("chat:master", &old).unwrap();
    let attempt = store
        .activate_attempt(&attempt.id, "/tmp".into(), "old".into(), true)
        .unwrap();
    finish_attempt(&store, attempt, WorkerOutcome::Blocked);

    let approved = automation::WorkerSettings {
        agent: ChatAgent::Codex,
        access: Access::Read,
        model: Some("gpt-5.6-terra".into()),
        effort: None,
        recovery: None,
    };
    store
        .reassign_task(
            "chat:master",
            &first.id,
            (
                Some(approved.clone()),
                Some(TaskAssignee {
                    id: "noah".into(),
                    name: "Noah".into(),
                }),
                None,
            ),
            "Noah reviews it read-only instead.".into(),
        )
        .unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();

    let current = |store: &OrchestrationStore| {
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let task = snapshot
            .tasks
            .into_iter()
            .find(|t| t.id == first.id)
            .unwrap();
        (task, snapshot.attempts.len())
    };
    let refused = store.reserve_attempt("chat:master", &old).unwrap_err();
    assert!(refused.contains("handed to Noah"), "{refused}");
    assert!(refused.contains("read access"), "{refused}");
    // Same provider and model, but above the approved access: refused too.
    let above = WorkerLaunch {
        agent: ChatAgent::Codex,
        model: approved.model.clone(),
        access: Access::Auto,
        ..launch_for(&first.id)
    };
    assert!(store.reserve_attempt("chat:master", &above).is_err());
    let (task, attempts) = current(&store);
    assert_eq!(attempts, 1);
    assert_eq!(task.status, TaskStatus::Ready);
    let worker = task.worker.unwrap();
    assert_eq!(
        (worker.agent, worker.access, worker.model.as_deref()),
        (ChatAgent::Codex, Access::Read, Some("gpt-5.6-terra"))
    );

    // The approved settings start, under the new owner.
    let noah = WorkerLaunch {
        access: Access::Read,
        ..above
    };
    let (_, task, attempt, _) = store.reserve_attempt("chat:master", &noah).unwrap();
    assert_eq!(attempt.assignee.as_ref().unwrap().id, "noah");
    assert_eq!(
        (attempt.agent, attempt.access),
        (ChatAgent::Codex, Access::Read)
    );
    assert_eq!(task.worker.unwrap().access, Access::Read);
    let attempt = store
        .activate_attempt(&attempt.id, "/tmp".into(), "noah".into(), true)
        .unwrap();
    finish_attempt(&store, attempt, WorkerOutcome::Blocked);

    // Once the new owner has started, the handoff's own guard is spent,
    // and the approval still holds every later start to what the person
    // approved with the new owner (review of 018a40a, H1).
    let refused = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                access: Access::Edits,
                ..noah.clone()
            },
        )
        .unwrap_err();
    assert!(
        refused.contains("edits access instead of read"),
        "{refused}"
    );
    let (_, task, _, _) = store.reserve_attempt("chat:master", &noah).unwrap();
    assert_eq!(task.worker.unwrap().access, Access::Read);
}

#[test]
fn a_stale_page_retry_is_refused_however_the_new_owners_attempt_ended() {
    // Re-review of b0b47b3: page A still shows Maya's failed Claude/opus
    // attempt at full access. Page B hands the task to Noah on Codex/terra
    // at read access and it is approved; Noah's attempt then fails, is
    // blocked, or fails before it has a workspace. A, never refreshed,
    // presses Start retry. The guard must not lapse once Noah has started.
    enum Ended {
        Failed,
        Blocked,
        PrepareFailed,
    }
    for ended in [Ended::Failed, Ended::Blocked, Ended::PrepareFailed] {
        let store = OrchestrationStore::default();
        let (run, first) = pending_plan(&store);
        // A second task keeps the run open when the first one fails.
        task(&store, &run, Vec::new());
        store
            .approve_plan("chat:master", &run.id, None, None)
            .unwrap();
        let page = |store: &OrchestrationStore, launch: &WorkerLaunch, retry_of: Option<&str>| {
            store.reserve_attempt_for("chat:master", launch, StartedBy::Page { retry_of })
        };
        let old = WorkerLaunch {
            agent: ChatAgent::Claude,
            model: Some("opus".into()),
            access: Access::Full,
            ..launch_for(&first.id)
        };
        let (_, _, maya, _) = page(&store, &old, None).unwrap();
        let maya = store
            .activate_attempt(&maya.id, "/tmp".into(), "maya".into(), true)
            .unwrap();
        finish_attempt(&store, maya.clone(), WorkerOutcome::Blocked);

        let approved = automation::WorkerSettings {
            agent: ChatAgent::Codex,
            access: Access::Read,
            model: Some("gpt-5.6-terra".into()),
            effort: None,
            recovery: None,
        };
        store
            .reassign_task(
                "chat:master",
                &first.id,
                (
                    Some(approved.clone()),
                    Some(TaskAssignee {
                        id: "noah".into(),
                        name: "Noah".into(),
                    }),
                    None,
                ),
                "Noah reviews it read-only instead.".into(),
            )
            .unwrap();
        store
            .approve_plan("chat:master", &run.id, None, None)
            .unwrap();

        // Before Noah starts, a page naming none is refused, and one naming
        // Maya's attempt is bound to the approved settings.
        let none = page(&store, &old, None).unwrap_err();
        assert!(none.contains("handed to Noah"), "{none}");
        assert!(page(&store, &old, Some(&maya.id)).is_err());

        // Noah's first attempt, by the coordinator or automatic dispatch.
        let noah_launch = WorkerLaunch {
            agent: ChatAgent::Codex,
            model: approved.model.clone(),
            access: Access::Read,
            ..launch_for(&first.id)
        };
        let (_, _, noah, _) = store.reserve_attempt("chat:master", &noah_launch).unwrap();
        match ended {
            Ended::PrepareFailed => store
                .fail_preparation(
                    &noah.id,
                    "no workspace".into(),
                    String::new(),
                    String::new(),
                    false,
                )
                .unwrap(),
            Ended::Failed | Ended::Blocked => {
                let noah = store
                    .activate_attempt(&noah.id, "/tmp".into(), "noah".into(), true)
                    .unwrap();
                let outcome = match ended {
                    Ended::Failed => WorkerOutcome::Failed,
                    _ => WorkerOutcome::Blocked,
                };
                finish_attempt(&store, noah, outcome);
            }
        }

        // Page A presses Start retry on Maya's attempt: refused, and
        // nothing is written.
        let refused = page(&store, &old, Some(&maya.id)).unwrap_err();
        assert!(
            refused.contains("handed to Noah after worker #1"),
            "{refused}"
        );
        assert!(refused.contains("Refresh"), "{refused}");
        // Even with the approved settings: the page did not see Noah's.
        assert!(page(&store, &noah_launch, Some(&maya.id)).is_err());
        // Nor any attempt that is not this task's.
        assert!(page(&store, &noah_launch, Some("attempt_elsewhere")).is_err());
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert_eq!(snapshot.attempts.len(), 2);
        let worker = snapshot
            .tasks
            .iter()
            .find(|t| t.id == first.id)
            .and_then(|t| t.worker.clone())
            .unwrap();
        assert_eq!(
            (worker.agent, worker.access, worker.model.as_deref()),
            (ChatAgent::Codex, Access::Read, Some("gpt-5.6-terra"))
        );

        // A fresh page retries Noah's attempt with its settings.
        let (_, task, retried, _) = page(&store, &noah_launch, Some(&noah.id)).unwrap();
        assert_eq!(retried.assignee.as_ref().unwrap().id, "noah");
        assert_eq!(task.worker.unwrap().agent, ChatAgent::Codex);
        let retried = store
            .activate_attempt(&retried.id, "/tmp".into(), "noah-2".into(), true)
            .unwrap();
        finish_attempt(&store, retried, WorkerOutcome::Blocked);

        // The coordinator's explicit start needs no retryOf. It is held
        // to what the person approved with Noah all the same: the
        // replaced owner's provider and access are not its to bring back.
        let refused = store
            .reserve_attempt_for("chat:master", &old, StartedBy::Coordinator)
            .unwrap_err();
        assert!(
            refused.contains("claude:opus instead of codex:terra")
                && refused.contains("full access instead of read"),
            "{refused}"
        );
        let (_, task, _, _) = store
            .reserve_attempt_for("chat:master", &noah_launch, StartedBy::Coordinator)
            .unwrap();
        assert_eq!(task.worker.unwrap().access, Access::Read);
    }
}

#[test]
fn a_page_retry_on_a_task_never_handed_on_is_as_before() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let first = task(&store, &run, Vec::new());
    task(&store, &run, Vec::new());
    let page = |launch: &WorkerLaunch, retry_of: Option<&str>| {
        store.reserve_attempt_for("chat:master", launch, StartedBy::Page { retry_of })
    };
    let (_, _, one, _) = page(&launch_for(&first.id), None).unwrap();
    let one = store
        .activate_attempt(&one.id, "/tmp".into(), "one".into(), true)
        .unwrap();
    finish_attempt(&store, one.clone(), WorkerOutcome::Blocked);
    let (_, _, two, _) = page(
        &WorkerLaunch {
            agent: ChatAgent::Claude,
            model: Some("opus".into()),
            access: Access::Full,
            ..launch_for(&first.id)
        },
        Some(&one.id),
    )
    .unwrap();
    let two = store
        .activate_attempt(&two.id, "/tmp".into(), "two".into(), true)
        .unwrap();
    finish_attempt(&store, two, WorkerOutcome::Failed);
    // An older attempt than the latest is still this owner's to retry.
    assert!(page(&launch_for(&first.id), Some(&one.id)).is_ok());
}

#[test]
fn a_card_click_must_say_what_it_showed_and_for_how_long() {
    // Feedback 713786e9: revision 6 was recorded as button-approved two
    // seconds after the lead changed the plan, and the person never saw
    // it. A click names its card and how long the revision had been on
    // it; one that cannot say what it saw approves nothing.
    let store = OrchestrationStore::default();
    let (run, first) = pending_plan(&store);
    let revision = plan_of(&store, &run.id).revision;
    let seen = [first.id.clone()];
    let view = |shown_ms: Option<u64>| CardView {
        surface: "chat".into(),
        shown_ms,
        updated_ms: shown_ms,
    };
    assert!(store
        .approve_plan_from_card(
            "chat:master",
            &run.id,
            None,
            Some(revision),
            view(Some(9_000))
        )
        .unwrap_err()
        .contains("Reload"));
    assert!(store
        .approve_plan_from_card("chat:master", &run.id, Some(&seen), None, view(Some(9_000)))
        .unwrap_err()
        .contains("Reload"));
    assert!(store
        .approve_plan_from_card(
            "chat:master",
            &run.id,
            Some(&seen),
            Some(revision),
            view(Some(400))
        )
        .unwrap_err()
        .contains("a moment before your click"));
    assert!(plan_of(&store, &run.id).status == PlanStatus::Pending);
    // Opened on this revision a moment ago is not a change under the
    // reader; nothing is held for it.
    let opened = CardView {
        surface: "panel".into(),
        shown_ms: Some(300),
        updated_ms: None,
    };
    assert!(store
        .approve_plan_from_card("chat:worker", &run.id, Some(&seen), Some(revision), opened)
        .unwrap_err()
        .contains("coordinator"));
    let approved = store
        .approve_plan_from_card(
            "chat:master",
            &run.id,
            Some(&seen),
            Some(revision),
            view(Some(4_200)),
        )
        .unwrap();
    let consent = approved.plan_approval.unwrap().consent.unwrap();
    assert_eq!(consent.via, ConsentVia::Button);
    assert_eq!(consent.revision, revision);
    assert_eq!(consent.surface.as_deref(), Some("chat"));
    assert_eq!(consent.shown_ms, Some(4_200));
}

#[test]
fn rejecting_the_current_first_plan_stops_it_and_delivers_one_durable_record() {
    let root = crate::test_dir::TestDir::new("plan-reject");
    let path = root.join("orchestrations.json");
    let store = OrchestrationStore::load(path.clone());
    let (run, task) = pending_plan(&store);
    let revision = plan_of(&store, &run.id).revision;
    let seen = [task.id.clone()];
    let gate = store
        .create_gate(
            "chat:master",
            run.id.clone(),
            None,
            "Should this plan proceed?".into(),
            vec!["Yes".into(), "No".into()],
        )
        .unwrap();
    let view = || CardView {
        surface: "chat".into(),
        shown_ms: Some(4_000),
        updated_ms: None,
    };

    let stale = revision.saturating_sub(1);
    assert!(store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&seen),
            Some(stale),
            None,
            view(),
        )
        .unwrap_err()
        .contains("changed"));
    assert!(store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&seen),
            Some(revision),
            Some("x".repeat(501)),
            view(),
        )
        .unwrap_err()
        .contains("too long"));
    assert!(store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&seen),
            Some(revision),
            None,
            CardView {
                surface: "chat".into(),
                shown_ms: Some(100),
                updated_ms: Some(100),
            },
        )
        .unwrap_err()
        .contains("moment before"));
    let rejected = store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&seen),
            Some(revision),
            Some("Do not spend time on this direction.".into()),
            view(),
        )
        .unwrap();
    assert_eq!(rejected.status, RunStatus::Stopped);
    assert!(rejected
        .stopped_reason
        .as_deref()
        .unwrap()
        .contains("rejected by the person"));
    let plan = rejected.plan_approval.unwrap();
    assert_eq!(plan.status, PlanStatus::Rejected);
    let rejection = plan.rejection.unwrap();
    assert_eq!(rejection.by, "person");
    assert_eq!(rejection.revision, revision);
    assert_eq!(rejection.task_ids, seen);
    assert_eq!(rejection.surface, "chat");
    assert_eq!(
        rejection.reason.as_deref(),
        Some("Do not spend time on this direction.")
    );
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    assert_eq!(snapshot.tasks[0].status, TaskStatus::Cancelled);
    assert_eq!(
        snapshot
            .gates
            .iter()
            .find(|candidate| candidate.id == gate.id)
            .unwrap()
            .status,
        GateStatus::Cancelled
    );
    assert!(snapshot.attempts.iter().all(|attempt| !matches!(
        attempt.status,
        AttemptStatus::Preparing | AttemptStatus::Running | AttemptStatus::Blocked
    )));
    assert!(store
        .reserve_attempt("chat:master", &launch_for(&task.id))
        .is_err());
    let notices: Vec<_> = snapshot
        .notifications
        .iter()
        .filter(|notice| notice.kind == "plan_rejected")
        .collect();
    assert_eq!(notices.len(), 1);
    assert!(notices[0].body.contains("Do not spend time"));
    assert!(notices[0].body.contains("not an instruction"));
    let due = store.due_notifications(now_ms() + 1).unwrap();
    assert_eq!(due.len(), 1, "the stopped run still delivers its rejection");
    let delivered = store
        .claim_notification(&due[0].id, now_ms() + 1)
        .unwrap()
        .unwrap();
    store
        .acknowledge_notification("chat:master", &delivered.id)
        .unwrap();
    assert!(store
        .due_notifications(now_ms() + 120_000)
        .unwrap()
        .is_empty());

    // A retry returns the recorded decision and cannot enqueue it twice.
    let again = store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&seen),
            Some(revision),
            Some("different words".into()),
            view(),
        )
        .unwrap();
    assert_eq!(again.plan_approval.unwrap().rejection.unwrap(), rejection);
    assert_eq!(
        store
            .snapshot(Some(&run.id))
            .unwrap()
            .notifications
            .iter()
            .filter(|notice| notice.kind == "plan_rejected")
            .count(),
        1
    );

    drop(store);
    let saved = OrchestrationStore::load(path)
        .snapshot(Some(&run.id))
        .unwrap();
    assert_eq!(saved.runs[0].status, RunStatus::Stopped);
    assert_eq!(
        saved.runs[0]
            .plan_approval
            .as_ref()
            .unwrap()
            .rejection
            .as_ref(),
        Some(&rejection)
    );
    assert!(saved.notifications.is_empty());
}

#[test]
fn rejecting_an_amendment_withdraws_only_new_tasks_and_keeps_the_run_alive() {
    let store = OrchestrationStore::default();
    let (run, first) = pending_plan(&store);
    let first_revision = plan_of(&store, &run.id).revision;
    store
        .approve_plan(
            "chat:master",
            &run.id,
            Some(&[first.id.clone()]),
            Some(first_revision),
        )
        .unwrap();
    let second = task(&store, &run, Vec::new());
    let revision = plan_of(&store, &run.id).revision;
    let rejected = store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&[second.id.clone()]),
            Some(revision),
            None,
            panel_view_after_two_seconds(),
        )
        .unwrap();
    assert_eq!(rejected.status, RunStatus::Running);
    assert_eq!(rejected.plan_approval.unwrap().status, PlanStatus::Rejected);
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let by_id = |id: &str| snapshot.tasks.iter().find(|task| task.id == id).unwrap();
    assert_eq!(by_id(&first.id).status, TaskStatus::Ready);
    assert!(by_id(&first.id).approved_at.is_some());
    assert_eq!(by_id(&second.id).status, TaskStatus::Cancelled);
    assert!(store
        .reserve_attempt("chat:master", &launch_for(&first.id))
        .is_ok());
    assert!(store
        .reserve_attempt("chat:master", &launch_for(&second.id))
        .is_err());
}

#[test]
fn rejecting_new_work_on_a_legacy_approved_run_never_stops_its_worker() {
    // Runs approved before consent evidence was introduced have approved
    // tasks and attempts but no PlanConsent. That missing evidence must
    // not turn a later amendment rejection into a whole-plan stop.
    let store = OrchestrationStore::default();
    let (run, approved_task) = pending_plan(&store);
    let first_revision = plan_of(&store, &run.id).revision;
    store
        .approve_plan(
            "chat:master",
            &run.id,
            Some(&[approved_task.id.clone()]),
            Some(first_revision),
        )
        .unwrap();
    store
        .mutate(|data| {
            data.runs
                .get_mut(&run.id)
                .unwrap()
                .plan_approval
                .as_mut()
                .unwrap()
                .consent = None;
            Ok(())
        })
        .unwrap();
    let (_, _, attempt, _) = store
        .reserve_attempt("chat:master", &launch_for(&approved_task.id))
        .unwrap();
    let new_task = task(&store, &run, Vec::new());
    let revision = plan_of(&store, &run.id).revision;

    let rejected = store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&[new_task.id.clone()]),
            Some(revision),
            None,
            panel_view_after_two_seconds(),
        )
        .unwrap();

    assert_eq!(rejected.status, RunStatus::Running);
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let by_id = |id: &str| snapshot.tasks.iter().find(|task| task.id == id).unwrap();
    assert_eq!(by_id(&approved_task.id).status, TaskStatus::Running);
    assert!(by_id(&approved_task.id).approved_at.is_some());
    assert_eq!(by_id(&new_task.id).status, TaskStatus::Cancelled);
    assert_eq!(
        snapshot
            .attempts
            .iter()
            .find(|candidate| candidate.id == attempt.id)
            .unwrap()
            .status,
        AttemptStatus::Preparing
    );
}

pub(super) fn start_task(store: &OrchestrationStore, task_id: &str) -> Attempt {
    let (_, _, attempt, _) = store
        .reserve_attempt("chat:master", &launch_for(task_id))
        .unwrap();
    store
        .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
        .unwrap()
}

/// The launch the host's own dispatch makes for a task: the settings in
/// effect for it, which for an approved task are the approved ones.
pub(super) fn host_launch(store: &OrchestrationStore, task_id: &str) -> WorkerLaunch {
    let snapshot = store.snapshot(None).unwrap();
    let task = snapshot.tasks.iter().find(|t| t.id == task_id).unwrap();
    let run = snapshot.runs.iter().find(|r| r.id == task.run_id).unwrap();
    match automation::settings_for_task(run, task).unwrap() {
        Some(settings) => WorkerLaunch {
            agent: settings.agent,
            model: settings.model,
            effort: settings.effort,
            access: settings.access,
            ..launch_for(task_id)
        },
        None => launch_for(task_id),
    }
}

/// Start a task as the host's dispatch would.
pub(crate) fn start_as_planned(store: &OrchestrationStore, task_id: &str) -> Attempt {
    let (_, _, attempt, _) = store
        .reserve_attempt("chat:master", &host_launch(store, task_id))
        .unwrap();
    store
        .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
        .unwrap()
}

pub(super) fn finish_attempt(store: &OrchestrationStore, attempt: Attempt, outcome: WorkerOutcome) {
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id,
                outcome,
                summary: format!("{outcome:?}"),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap();
}

pub(super) fn enable_automatic_dispatch(store: &OrchestrationStore, run_id: &str) {
    store
        .configure_automation(
            "chat:master",
            run_id,
            Some(automation::WorkerDefaults {
                agent: Some(ChatAgent::Codex),
                model: Some("gpt-5.6-sol".into()),
                access: Access::Auto,
                effort: Some("high".into()),
                recovery: None,
            }),
        )
        .unwrap();
}

fn three_attempts_then_complete(store: &OrchestrationStore, task_id: &str) {
    for outcome in [
        WorkerOutcome::Failed,
        WorkerOutcome::Failed,
        WorkerOutcome::Completed,
    ] {
        let attempt = start_task(store, task_id);
        finish_attempt(store, attempt, outcome);
    }
}

#[test]
fn rejecting_a_legacy_approved_plan_with_missing_markers_withdraws_only_new_work() {
    let store = OrchestrationStore::default();
    let (run, ready) = pending_plan(&store);
    let completed = task(&store, &run, Vec::new());
    let first_plan = plan_of(&store, &run.id);
    store
        .approve_plan(
            "chat:master",
            &run.id,
            Some(&[ready.id.clone(), completed.id.clone()]),
            Some(first_plan.revision),
        )
        .unwrap();
    store
        .mutate(|data| {
            let plan = data
                .runs
                .get_mut(&run.id)
                .unwrap()
                .plan_approval
                .as_mut()
                .unwrap();
            plan.consent = None;
            data.tasks.get_mut(&ready.id).unwrap().approved_at = None;
            data.tasks.get_mut(&completed.id).unwrap().approved_at = None;
            Ok(())
        })
        .unwrap();
    three_attempts_then_complete(&store, &completed.id);

    let new_task = task(&store, &run, Vec::new());
    let revision = plan_of(&store, &run.id).revision;
    let rejected = store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&[new_task.id.clone()]),
            Some(revision),
            None,
            panel_view_after_two_seconds(),
        )
        .unwrap();

    assert_eq!(rejected.status, RunStatus::Running);
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let by_id = |id: &str| snapshot.tasks.iter().find(|task| task.id == id).unwrap();
    assert_eq!(by_id(&ready.id).status, TaskStatus::Ready);
    assert_eq!(by_id(&completed.id).status, TaskStatus::Completed);
    assert_eq!(by_id(&new_task.id).status, TaskStatus::Cancelled);
    assert_eq!(snapshot.attempts.len(), 3);
    assert!(by_id(&ready.id).approved_at.is_some());
    assert!(by_id(&completed.id).approved_at.is_some());
}

#[test]
fn loading_a_legacy_decided_plan_persists_approval_markers_and_approves_only_new_work() {
    let root = crate::test_dir::TestDir::new("legacy-plan");
    let path = root.join("orchestrations.json");
    let store = OrchestrationStore::load(path.clone());
    let (run, ready) = pending_plan(&store);
    let completed = task(&store, &run, Vec::new());
    let first_plan = plan_of(&store, &run.id);
    let decided_at = store
        .approve_plan(
            "chat:master",
            &run.id,
            Some(&[ready.id.clone(), completed.id.clone()]),
            Some(first_plan.revision),
        )
        .unwrap()
        .plan_approval
        .unwrap()
        .decided_at
        .unwrap();
    three_attempts_then_complete(&store, &completed.id);
    store
        .mutate(|data| {
            data.runs
                .get_mut(&run.id)
                .unwrap()
                .plan_approval
                .as_mut()
                .unwrap()
                .consent = None;
            data.tasks.get_mut(&ready.id).unwrap().approved_at = None;
            data.tasks.get_mut(&completed.id).unwrap().approved_at = None;
            Ok(())
        })
        .unwrap();
    drop(store);

    let raw: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert!(raw["tasks"][&ready.id].get("approvedAt").is_none());
    assert!(raw["tasks"][&completed.id].get("approvedAt").is_none());

    let store = OrchestrationStore::load(path.clone());
    let migrated = store.snapshot(Some(&run.id)).unwrap();
    let by_id = |id: &str| migrated.tasks.iter().find(|task| task.id == id).unwrap();
    assert_eq!(by_id(&ready.id).approved_at, Some(decided_at));
    assert_eq!(by_id(&completed.id).approved_at, Some(decided_at));
    assert_eq!(by_id(&ready.id).status, TaskStatus::Ready);
    assert_eq!(by_id(&completed.id).status, TaskStatus::Completed);
    assert_eq!(migrated.attempts.len(), 3);
    let persisted: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["tasks"][&ready.id]["approvedAt"], decided_at);
    assert_eq!(persisted["tasks"][&completed.id]["approvedAt"], decided_at);

    let new_task = task(&store, &run, Vec::new());
    let before_approval = store.snapshot(Some(&run.id)).unwrap();
    assert!(before_approval
        .tasks
        .iter()
        .find(|task| task.id == new_task.id)
        .unwrap()
        .approved_at
        .is_none());
    let revision = plan_of(&store, &run.id).revision;
    store
        .approve_plan(
            "chat:master",
            &run.id,
            Some(&[new_task.id.clone()]),
            Some(revision),
        )
        .unwrap();
    let approved = store.snapshot(Some(&run.id)).unwrap();
    let by_id = |id: &str| approved.tasks.iter().find(|task| task.id == id).unwrap();
    assert_eq!(by_id(&ready.id).approved_at, Some(decided_at));
    assert_eq!(by_id(&completed.id).approved_at, Some(decided_at));
    assert!(by_id(&new_task.id).approved_at.is_some());
    assert_eq!(by_id(&completed.id).status, TaskStatus::Completed);
}

#[test]
fn rejection_never_withdraws_terminal_active_or_history_bearing_tasks() {
    // Snapshot failure routing reads the chat index. Keep another test's
    // coordinator changes from changing that derived view mid-comparison.
    let home = crate::test_dir::TestDir::new("rejection-keeps-tasks");
    let _profile = crate::profile::started_in(&home);
    let store = OrchestrationStore::default();
    let (run, completed) = pending_plan(&store);
    let failed = task(&store, &run, Vec::new());
    let running = task(&store, &run, Vec::new());
    let history_bearing = task(&store, &run, Vec::new());
    let plan = plan_of(&store, &run.id);
    let approved_ids = [
        completed.id.clone(),
        failed.id.clone(),
        running.id.clone(),
        history_bearing.id.clone(),
    ];
    store
        .approve_plan(
            "chat:master",
            &run.id,
            Some(&approved_ids),
            Some(plan.revision),
        )
        .unwrap();
    finish_attempt(
        &store,
        start_task(&store, &completed.id),
        WorkerOutcome::Completed,
    );
    finish_attempt(
        &store,
        start_task(&store, &failed.id),
        WorkerOutcome::Failed,
    );
    finish_attempt(
        &store,
        start_task(&store, &history_bearing.id),
        WorkerOutcome::Failed,
    );
    store
        .mutate(|data| {
            data.tasks.get_mut(&history_bearing.id).unwrap().status = TaskStatus::Ready;
            Ok(())
        })
        .unwrap();
    let _running_attempt = start_task(&store, &running.id);
    let new_task = task(&store, &run, Vec::new());
    store
        .mutate(|data| {
            data.runs
                .get_mut(&run.id)
                .unwrap()
                .plan_approval
                .as_mut()
                .unwrap()
                .consent = None;
            for id in &approved_ids {
                data.tasks.get_mut(id).unwrap().approved_at = None;
            }
            Ok(())
        })
        .unwrap();
    let before = store.snapshot(Some(&run.id)).unwrap();
    let protected: BTreeMap<_, _> = approved_ids
        .iter()
        .map(|id| {
            // What is stored, not `held_by_plan`: that is derived from
            // the pending plan, which the rejection ends.
            let task = Task {
                held_by_plan: None,
                ..before
                    .tasks
                    .iter()
                    .find(|task| task.id == *id)
                    .unwrap()
                    .clone()
            };
            (id.clone(), serde_json::to_value(task).unwrap())
        })
        .collect();

    let revision = plan_of(&store, &run.id).revision;
    let rejected = store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&[new_task.id.clone()]),
            Some(revision),
            None,
            panel_view_after_two_seconds(),
        )
        .unwrap();

    assert_eq!(rejected.status, RunStatus::Running);
    let after = store.snapshot(Some(&run.id)).unwrap();
    for (id, expected) in protected {
        let task = after.tasks.iter().find(|task| task.id == id).unwrap();
        // Derived on both sides, and `false` once the plan is decided.
        assert_eq!(task.held_by_plan, Some(false));
        let stored = Task {
            held_by_plan: None,
            ..task.clone()
        };
        assert_eq!(serde_json::to_value(stored).unwrap(), expected);
    }
    assert_eq!(
        after
            .tasks
            .iter()
            .find(|task| task.id == new_task.id)
            .unwrap()
            .status,
        TaskStatus::Cancelled
    );
}

#[test]
fn rejecting_a_resize_restores_the_approved_size_and_dependency_flow() {
    let root = crate::test_dir::TestDir::new("plan-rollback");
    let path = root.join("orchestrations.json");
    let store = OrchestrationStore::load(path.clone());
    let (run, first) = pending_plan(&store);
    let dependant = task(&store, &run, vec![first.id.clone()]);
    let plan = plan_of(&store, &run.id);
    store
        .approve_plan(
            "chat:master",
            &run.id,
            Some(&[first.id.clone(), dependant.id.clone()]),
            Some(plan.revision),
        )
        .unwrap();
    enable_automatic_dispatch(&store, &run.id);
    let first_attempt = start_task(&store, &first.id);
    store.set_task_size(&dependant.id, TaskSize::Large).unwrap();
    let revision = plan_of(&store, &run.id).revision;
    finish_attempt(&store, first_attempt, WorkerOutcome::Completed);
    drop(store);
    let store = OrchestrationStore::load(path);

    store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&[dependant.id.clone()]),
            Some(revision),
            None,
            panel_view_after_two_seconds(),
        )
        .unwrap();

    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let restored = snapshot
        .tasks
        .iter()
        .find(|task| task.id == dependant.id)
        .unwrap();
    assert_eq!(restored.size, Some(TaskSize::Medium));
    assert_eq!(restored.status, TaskStatus::Ready);
    assert!(restored.approved_at.is_some());
    assert_eq!(
        snapshot
            .tasks
            .iter()
            .find(|task| task.id == first.id)
            .unwrap()
            .status,
        TaskStatus::Completed
    );
    let wave = automation::ready_wave(&snapshot, &snapshot.runs[0]);
    assert_eq!(
        wave.iter().map(|task| &task.id).collect::<Vec<_>>(),
        [&dependant.id]
    );
}

#[test]
fn rejecting_a_reassignment_restores_the_approved_owner_and_dependency_flow() {
    let store = OrchestrationStore::default();
    let (run, first) = pending_plan(&store);
    let dependant = task(&store, &run, vec![first.id.clone()]);
    let assignee = |id: &str, name: &str| TaskAssignee {
        id: id.into(),
        name: name.into(),
    };
    let worker = |model: &str| automation::WorkerSettings {
        agent: ChatAgent::Claude,
        access: Access::Auto,
        model: Some(model.into()),
        effort: None,
        recovery: None,
    };
    enable_automatic_dispatch(&store, &run.id);
    store
        .reassign_task(
            "chat:master",
            &dependant.id,
            (Some(worker("opus")), Some(assignee("maya", "Maya")), None),
            "Maya owns the approved work.".into(),
        )
        .unwrap();
    let plan = plan_of(&store, &run.id);
    store
        .approve_plan(
            "chat:master",
            &run.id,
            Some(&[first.id.clone(), dependant.id.clone()]),
            Some(plan.revision),
        )
        .unwrap();
    let first_attempt = start_as_planned(&store, &first.id);
    store
        .reassign_task(
            "chat:master",
            &dependant.id,
            (Some(worker("sonnet")), Some(assignee("noah", "Noah")), None),
            "Try a different owner.".into(),
        )
        .unwrap();
    let revision = plan_of(&store, &run.id).revision;
    finish_attempt(&store, first_attempt, WorkerOutcome::Completed);

    store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&[dependant.id.clone()]),
            Some(revision),
            Some("Keep the original assignment.".into()),
            CardView {
                surface: "chat".into(),
                shown_ms: Some(2_000),
                updated_ms: None,
            },
        )
        .unwrap();

    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let restored = snapshot
        .tasks
        .iter()
        .find(|task| task.id == dependant.id)
        .unwrap();
    assert_eq!(restored.assignee.as_ref().unwrap().id, "maya");
    assert_eq!(
        restored.worker.as_ref().unwrap().model.as_deref(),
        Some("opus")
    );
    assert_eq!(restored.handoffs.len(), 1);
    assert_eq!(restored.status, TaskStatus::Ready);
    assert!(restored.approved_at.is_some());
    let wave = automation::ready_wave(&snapshot, &snapshot.runs[0]);
    assert_eq!(
        wave.iter().map(|task| &task.id).collect::<Vec<_>>(),
        [&dependant.id]
    );
}

#[test]
fn opposite_plan_decisions_are_errors_but_identical_retries_are_idempotent() {
    let view = || CardView {
        surface: "chat".into(),
        shown_ms: Some(2_000),
        updated_ms: None,
    };

    let rejected_store = OrchestrationStore::default();
    let (rejected_run, rejected_task) = pending_plan(&rejected_store);
    let rejected_revision = plan_of(&rejected_store, &rejected_run.id).revision;
    let rejected_seen = [rejected_task.id.clone()];
    rejected_store
        .reject_plan_from_card(
            "chat:master",
            &rejected_run.id,
            Some(&rejected_seen),
            Some(rejected_revision),
            None,
            view(),
        )
        .unwrap();
    assert!(rejected_store
        .reject_plan_from_card(
            "chat:master",
            &rejected_run.id,
            Some(&rejected_seen),
            Some(rejected_revision),
            None,
            view(),
        )
        .is_ok());
    assert_eq!(
        rejected_store
            .approve_plan_from_card(
                "chat:master",
                &rejected_run.id,
                Some(&rejected_seen),
                Some(rejected_revision),
                view(),
            )
            .unwrap_err(),
        "The person rejected this plan; nothing was approved"
    );
    let turn = said(
        "user-after-reject",
        "approve this plan",
        &[(&rejected_run.id, rejected_revision)],
    );
    assert_eq!(
            rejected_store
                .approve_plan_in_conversation(
                    "chat:master",
                    &rejected_run.id,
                    rejected_revision,
                    &turn,
                )
                .unwrap_err(),
            "The person rejected this plan; nothing was approved"
        );

    let approved_store = OrchestrationStore::default();
    let (approved_run, approved_task) = pending_plan(&approved_store);
    let approved_revision = plan_of(&approved_store, &approved_run.id).revision;
    let approved_seen = [approved_task.id.clone()];
    approved_store
        .approve_plan_from_card(
            "chat:master",
            &approved_run.id,
            Some(&approved_seen),
            Some(approved_revision),
            view(),
        )
        .unwrap();
    assert!(approved_store
        .approve_plan_from_card(
            "chat:master",
            &approved_run.id,
            Some(&approved_seen),
            Some(approved_revision),
            view(),
        )
        .is_ok());
    assert_eq!(
        approved_store
            .reject_plan_from_card(
                "chat:master",
                &approved_run.id,
                Some(&approved_seen),
                Some(approved_revision),
                None,
                view(),
            )
            .unwrap_err(),
        "The person approved this plan; nothing was rejected"
    );
}

#[test]
fn concurrent_approve_and_reject_record_exactly_one_decision() {
    let store = Arc::new(OrchestrationStore::default());
    let (run, task) = pending_plan(&store);
    let revision = plan_of(&store, &run.id).revision;
    let seen = vec![task.id.clone()];
    let approve_store = store.clone();
    let approve_run = run.id.clone();
    let approve_seen = seen.clone();
    let approve = std::thread::spawn(move || {
        approve_store.approve_plan(
            "chat:master",
            &approve_run,
            Some(&approve_seen),
            Some(revision),
        )
    });
    let reject_store = store.clone();
    let reject_run = run.id.clone();
    let reject = std::thread::spawn(move || {
        reject_store.reject_plan_from_card(
            "chat:master",
            &reject_run,
            Some(&seen),
            Some(revision),
            None,
            panel_view_after_two_seconds(),
        )
    });
    let approved_view = approve.join().unwrap();
    let rejected_view = reject.join().unwrap();
    let status = plan_of(&store, &run.id).status;
    match status {
        PlanStatus::Approved => {
            assert_eq!(
                approved_view.unwrap().plan_approval.unwrap().status,
                PlanStatus::Approved
            );
            assert_eq!(
                rejected_view.unwrap_err(),
                "The person approved this plan; nothing was rejected"
            );
        }
        PlanStatus::Rejected => {
            assert_eq!(
                rejected_view.unwrap().plan_approval.unwrap().status,
                PlanStatus::Rejected
            );
            assert_eq!(
                approved_view.unwrap_err(),
                "The person rejected this plan; nothing was approved"
            );
        }
        PlanStatus::Pending => panic!("one decision must win"),
    }
    assert!(matches!(
        status,
        PlanStatus::Approved | PlanStatus::Rejected
    ));
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    assert_ne!(
        snapshot.runs[0]
            .plan_approval
            .as_ref()
            .unwrap()
            .consent
            .is_some(),
        snapshot.runs[0]
            .plan_approval
            .as_ref()
            .unwrap()
            .rejection
            .is_some()
    );
}

#[test]
fn every_change_to_a_waiting_plan_is_a_new_revision() {
    let store = OrchestrationStore::default();
    let (run, first) = pending_plan(&store);
    let one = plan_of(&store, &run.id).revision;
    assert!(one > 0);
    let changed = |revision: TaskRevision| {
        store
            .revise_task("chat:master", &first.id, revision)
            .unwrap();
        plan_of(&store, &run.id).revision
    };
    let two = changed(TaskRevision {
        title: Some("Implement it properly".into()),
        ..TaskRevision::default()
    });
    assert_eq!(two, one + 1);
    let three = changed(TaskRevision {
        card: Some(Some(TaskCard {
            problem: "p".into(),
            goal: "g".into(),
            acceptance: vec!["a".into()],
        })),
        ..TaskRevision::default()
    });
    assert_eq!(three, two + 1);
    let four = changed(TaskRevision {
        route: Some((
            None,
            Some(TaskAssignee {
                id: "agent_bo".into(),
                name: "Bo".into(),
            }),
            None,
        )),
        ..TaskRevision::default()
    });
    assert_eq!(four, three + 1);
    // A write that changes nothing the plan shows leaves it alone.
    store
        .record_message(
            "chat:master",
            run.id.clone(),
            "coordinator".into(),
            "status".into(),
            "s".into(),
            "b".into(),
        )
        .ok();
    assert_eq!(plan_of(&store, &run.id).revision, four);

    // The button names the revision it showed; an older one is refused.
    let seen = [first.id.clone()];
    assert!(store
        .approve_plan("chat:master", &run.id, Some(&seen), Some(three))
        .unwrap_err()
        .contains("changed"));
    let approved = store
        .approve_plan("chat:master", &run.id, Some(&seen), Some(four))
        .unwrap();
    let consent = approved.plan_approval.unwrap().consent.unwrap();
    assert_eq!((consent.via, consent.revision), (ConsentVia::Button, four));

    // An approved task is fixed; new work re-opens the plan at a new
    // revision that covers only the new task.
    assert!(store
        .revise_task(
            "chat:master",
            &first.id,
            TaskRevision {
                title: Some("Sneaky".into()),
                ..TaskRevision::default()
            }
        )
        .is_err());
    let second = task(&store, &run, Vec::new());
    let plan = plan_of(&store, &run.id);
    assert_eq!(plan.status, PlanStatus::Pending);
    assert!(plan.revision > four);
    assert!(store
        .approve_plan("chat:master", &run.id, Some(&seen), Some(plan.revision))
        .is_err());
    store
        .approve_plan(
            "chat:master",
            &run.id,
            Some(&[second.id.clone()]),
            Some(plan.revision),
        )
        .unwrap();
}

#[test]
fn revision_survives_a_restart_unchanged() {
    let dir = crate::test_dir::TestDir::new("plan");
    let path = dir.join("orchestrations.json");
    let store = OrchestrationStore::load(path.clone());
    let (run, _) = pending_plan(&store);
    let before = plan_of(&store, &run.id);
    drop(store);
    let reloaded = OrchestrationStore::load(path);
    let after = plan_of(&reloaded, &run.id);
    assert_eq!(
        (after.revision, after.revised_at),
        (before.revision, before.revised_at)
    );
}

#[test]
fn a_withdrawn_task_leaves_the_plan_and_its_dependants_hold_it() {
    let store = OrchestrationStore::default();
    let (run, first) = pending_plan(&store);
    let second = task(&store, &run, vec![first.id.clone()]);
    let withdraw = TaskRevision {
        withdraw: true,
        ..TaskRevision::default()
    };
    assert!(store
        .revise_task("chat:master", &first.id, withdraw.clone())
        .unwrap_err()
        .contains("depends on"));
    // A cycle is refused too.
    assert!(store
        .revise_task(
            "chat:master",
            &first.id,
            TaskRevision {
                depends_on: Some(vec![second.id.clone()]),
                ..TaskRevision::default()
            }
        )
        .is_err());
    store
        .revise_task("chat:master", &second.id, withdraw.clone())
        .unwrap();
    // Only the coordinator revises its plan.
    assert!(store
        .revise_task("chat:worker", &first.id, withdraw)
        .is_err());
    let approved = store
        .approve_plan("chat:master", &run.id, Some(&[first.id.clone()]), None)
        .unwrap();
    assert!(!approved.awaiting_plan_approval());
    let tasks = store.snapshot(Some(&run.id)).unwrap().tasks;
    let withdrawn = tasks.iter().find(|t| t.id == second.id).unwrap();
    assert_eq!(withdrawn.status, TaskStatus::Cancelled);
    assert!(withdrawn.approved_at.is_none());
}

#[test]
fn a_plain_approval_in_chat_approves_the_plan_it_saw() {
    let store = OrchestrationStore::default();
    let (run, _) = pending_plan(&store);
    let revision = plan_of(&store, &run.id).revision;
    let turn = said("user-1", "Approve this plan", &[(&run.id, revision)]);
    let approved = store
        .approve_plan_in_conversation("chat:master", &run.id, revision, &turn)
        .unwrap();
    let plan = approved.plan_approval.unwrap();
    assert_eq!(plan.status, PlanStatus::Approved);
    let consent = plan.consent.unwrap();
    assert_eq!(consent.via, ConsentVia::Conversation);
    assert_eq!(consent.revision, revision);
    assert_eq!(consent.turn_id.as_deref(), Some("user-1"));
    assert_eq!(consent.words.as_deref(), Some("Approve this plan"));
    // The same message again returns the recorded decision without
    // changing it or creating a second decision.
    assert_eq!(
        store
            .approve_plan_in_conversation("chat:master", &run.id, revision, &turn)
            .unwrap()
            .plan_approval
            .unwrap()
            .consent
            .unwrap()
            .turn_id
            .as_deref(),
        Some("user-1")
    );
}

#[test]
fn a_message_that_is_not_just_approval_approves_nothing() {
    let store = OrchestrationStore::default();
    let (run, _) = pending_plan(&store);
    let revision = plan_of(&store, &run.id).revision;
    for text in [
        "approve\nbut change the branch name",
        "approve if the tests pass",
        "don't approve yet",
        "should I approve?",
        "ok",
        "go ahead",
        "> approve this plan",
        "approve and deploy it",
    ] {
        let turn = said("user-1", text, &[(&run.id, revision)]);
        assert!(
            store
                .approve_plan_in_conversation("chat:master", &run.id, revision, &turn)
                .is_err(),
            "{text:?}"
        );
    }
    assert!(store.snapshot(None).unwrap().runs[0].awaiting_plan_approval());
}

#[test]
fn chat_approval_needs_the_plan_on_screen_at_its_current_revision() {
    let store = OrchestrationStore::default();
    let (run, first) = pending_plan(&store);
    let old = plan_of(&store, &run.id).revision;
    // Not on screen at all.
    let unseen = said("user-1", "approve", &[]);
    assert!(store
        .approve_plan_in_conversation("chat:master", &run.id, old, &unseen)
        .unwrap_err()
        .contains("not on the person's screen"));
    // The lead changes the plan after the person looked.
    store
        .revise_task(
            "chat:master",
            &first.id,
            TaskRevision {
                title: Some("A different task".into()),
                ..TaskRevision::default()
            },
        )
        .unwrap();
    let new = plan_of(&store, &run.id).revision;
    let stale = said("user-2", "approve this plan", &[(&run.id, old)]);
    // The lead names the old revision, or the current one the person did
    // not see: refused both ways, each saying which.
    assert!(store
        .approve_plan_in_conversation("chat:master", &run.id, old, &stale)
        .unwrap_err()
        .contains(&format!("You named revision {old}")));
    assert!(store
        .approve_plan_in_conversation("chat:master", &run.id, new, &stale)
        .unwrap_err()
        .contains(&format!(
            "they saw revision {old}, and it is now revision {new}"
        )));
    // Parts of one turn that saw different revisions are not one view.
    // "approve" typed at the old revision, "thanks" at the new one: the
    // later look does not vouch for the earlier words.
    let mixed = said_in_parts(
        "user-3",
        "approve\nthanks",
        &[&[(&run.id, old)], &[(&run.id, new)]],
    );
    assert!(store
        .approve_plan_in_conversation("chat:master", &run.id, new, &mixed)
        .unwrap_err()
        .contains("changed"));
    // Nor does a part that saw no plan at all.
    let blind = said_in_parts("user-3b", "approve\nthanks", &[&[], &[(&run.id, new)]]);
    assert!(store
        .approve_plan_in_conversation("chat:master", &run.id, new, &blind)
        .unwrap_err()
        .contains("not on the person's screen"));
    // The lead cannot claim a revision the person did not see.
    let current = said("user-4", "approve", &[(&run.id, new)]);
    assert!(store
        .approve_plan_in_conversation("chat:master", &run.id, old, &current)
        .is_err());
    store
        .approve_plan_in_conversation("chat:master", &run.id, new, &current)
        .unwrap();
}

#[test]
fn one_message_never_approves_twice() {
    let store = OrchestrationStore::default();
    let (run, _) = pending_plan(&store);
    let revision = plan_of(&store, &run.id).revision;
    let turn = said("user-1", "approve", &[(&run.id, revision)]);
    store
        .approve_plan_in_conversation("chat:master", &run.id, revision, &turn)
        .unwrap();
    // New work re-opens the plan. A retry or replay of the old message —
    // even one claiming to have seen the new revision — is refused.
    task(&store, &run, Vec::new());
    let reopened = plan_of(&store, &run.id).revision;
    let replay = said("user-1", "approve", &[(&run.id, reopened)]);
    assert!(store
        .approve_plan_in_conversation("chat:master", &run.id, reopened, &replay)
        .unwrap_err()
        .contains("already approved an earlier version"));
    assert!(store.snapshot(None).unwrap().runs[0].awaiting_plan_approval());
}

#[test]
fn with_several_plans_waiting_the_person_names_one() {
    let store = OrchestrationStore::default();
    let (a, _) = pending_plan(&store);
    let (b, _) = pending_plan(&store);
    let (ra, rb) = (
        plan_of(&store, &a.id).revision,
        plan_of(&store, &b.id).revision,
    );
    let both = [(a.id.as_str(), ra), (b.id.as_str(), rb)];
    let vague = said("user-1", "approve this plan", &both);
    assert!(store
        .approve_plan_in_conversation("chat:master", &a.id, ra, &vague)
        .unwrap_err()
        .contains("More than one plan"));
    let handle_b = consent::plan_handle(&b.id);
    let for_b = said("user-2", &format!("approve plan {handle_b}"), &both);
    // Named B: it cannot approve A.
    if consent::plan_handle(&a.id) != handle_b {
        assert!(store
            .approve_plan_in_conversation("chat:master", &a.id, ra, &for_b)
            .is_err());
        store
            .approve_plan_in_conversation("chat:master", &b.id, rb, &for_b)
            .unwrap();
        let snapshot = store.snapshot(None).unwrap();
        let waiting = |id: &str| {
            snapshot
                .runs
                .iter()
                .find(|run| run.id == id)
                .unwrap()
                .awaiting_plan_approval()
        };
        assert!(waiting(&a.id));
        assert!(!waiting(&b.id));
    }
}

#[test]
fn chat_approval_is_the_coordinators_and_stays_in_its_run() {
    let store = OrchestrationStore::default();
    let (run, _) = pending_plan(&store);
    let revision = plan_of(&store, &run.id).revision;
    let turn = said("user-1", "approve", &[(&run.id, revision)]);
    assert!(store
        .approve_plan_in_conversation("chat:worker", &run.id, revision, &turn)
        .is_err());
    // Another chat's run, with the plan this chat saw.
    let other = store
        .create_run(
            "chat:other".into(),
            "Other".into(),
            "ws".into(),
            "/tmp".into(),
            None,
        )
        .unwrap();
    store.require_plan_approval(&other.id).unwrap();
    task_as(&store, &other, "chat:other");
    let theirs = plan_of(&store, &other.id).revision;
    assert!(store
        .approve_plan_in_conversation("chat:master", &other.id, theirs, &turn)
        .is_err());
    assert!(store
        .approve_plan_in_conversation("chat:other", &other.id, theirs, &turn)
        .unwrap_err()
        .contains("not on the person's screen"));
}

fn task_as(store: &OrchestrationStore, run: &Run, actor: &str) -> Task {
    store
        .create_task(
            actor,
            run.id.clone(),
            "Other work".into(),
            "Do it".into(),
            Vec::new(),
            None,
            None,
        )
        .unwrap()
}

#[test]
fn an_approval_racing_a_new_task_never_covers_it() {
    for _ in 0..25 {
        let store = Arc::new(OrchestrationStore::default());
        let (run, first) = pending_plan(&store);
        let revision = plan_of(&store, &run.id).revision;
        let seen = vec![first.id.clone()];
        let approver = {
            let store = store.clone();
            let run_id = run.id.clone();
            std::thread::spawn(move || {
                store
                    .approve_plan("chat:master", &run_id, Some(&seen), Some(revision))
                    .is_ok()
            })
        };
        let adder = {
            let store = store.clone();
            let run = run.clone();
            std::thread::spawn(move || task(&store, &run, Vec::new()).id)
        };
        let approved = approver.join().unwrap();
        let added = adder.join().unwrap();
        let snapshot = store.snapshot(None).unwrap();
        let new = snapshot.tasks.iter().find(|t| t.id == added).unwrap();
        assert!(new.approved_at.is_none(), "a task nobody saw was approved");
        // Either way, the new task is waiting for the person.
        assert!(snapshot.runs[0].awaiting_plan_approval());
        let old = snapshot.tasks.iter().find(|t| t.id == first.id).unwrap();
        assert_eq!(old.approved_at.is_some(), approved);
    }
}

#[test]
fn an_approval_racing_a_revision_is_one_or_the_other() {
    for _ in 0..25 {
        let store = Arc::new(OrchestrationStore::default());
        let (run, first) = pending_plan(&store);
        let revision = plan_of(&store, &run.id).revision;
        let turn = said("user-1", "approve this plan", &[(&run.id, revision)]);
        let approver = {
            let (store, run_id) = (store.clone(), run.id.clone());
            std::thread::spawn(move || {
                store
                    .approve_plan_in_conversation("chat:master", &run_id, revision, &turn)
                    .is_ok()
            })
        };
        let reviser = {
            let (store, task_id) = (store.clone(), first.id.clone());
            std::thread::spawn(move || {
                store
                    .revise_task(
                        "chat:master",
                        &task_id,
                        TaskRevision {
                            title: Some("Something else".into()),
                            ..TaskRevision::default()
                        },
                    )
                    .is_ok()
            })
        };
        let (approved, revised) = (approver.join().unwrap(), reviser.join().unwrap());
        // Approved first: the task is fixed. Revised first: the person
        // saw another revision. Never both.
        assert_ne!(approved, revised);
        let task = store.snapshot(None).unwrap().tasks.remove(0);
        assert_eq!(task.approved_at.is_some(), approved);
        assert_eq!(task.title == "Something else", revised);
    }
}

#[test]
fn a_legacy_task_without_destination_or_approval_still_loads() {
    let task: Task = serde_json::from_value(json!({
        "id": "task_old", "runId": "run_old", "title": "Old", "spec": "Old work",
        "dependsOn": [], "status": "pending", "createdAt": 1, "updatedAt": 1,
    }))
    .unwrap();
    assert!(task.destination.is_none());
    assert!(task.approved_at.is_none());
    let value = serde_json::to_value(&task).unwrap();
    assert!(value.get("destination").is_none());
}

#[test]
fn a_run_root_must_be_the_chat_folder_or_registered() {
    // An absolute path on this platform: "/repos" has no drive on Windows.
    let abs = |path: &str| {
        if cfg!(windows) {
            format!("C:{}", path.replace('/', "\\"))
        } else {
            path.to_string()
        }
    };
    let project: Workspace = serde_json::from_value(json!({
        "id": "p", "name": "P", "primary_path": abs("/repos/app"), "paths": [abs("/repos/lib")],
    }))
    .unwrap();
    let worktree = abs("/wt/feature");
    assert!(root_allowed(&project, None, &abs("/repos/app")));
    assert!(root_allowed(&project, None, &abs("/repos/lib/sub")));
    assert!(root_allowed(&project, Some(&worktree), &worktree));
    assert!(!root_allowed(&project, Some(&worktree), &abs("/etc")));
    assert!(!root_allowed(&project, None, &abs("/repos/app/../../etc")));
    assert!(!root_allowed(&project, None, "relative/app"));
}

#[test]
fn a_manager_splits_its_own_task_once_and_dependents_wait_for_the_parts() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let managed = assigned(&store, &run, "chat:master", None, Vec::new()).unwrap();
    let after = assigned(&store, &run, "chat:master", None, vec![managed.id.clone()]).unwrap();
    let (_, _, attempt, _) = store
        .reserve_attempt("chat:master", &launch_for(&managed.id))
        .unwrap();
    let attempt = store
        .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
        .unwrap();
    let manager = attempt.worker_chat_key.as_str();

    let part = assigned(&store, &run, manager, Some(managed.id.clone()), Vec::new()).unwrap();
    assert_eq!(part.parent_task_id.as_deref(), Some(managed.id.as_str()));
    let snapshot = store.snapshot(None).unwrap();
    let waiting = snapshot.tasks.iter().find(|t| t.id == after.id).unwrap();
    assert!(waiting.depends_on.contains(&part.id));

    // Only with an assignee, only under its own task, and no deeper.
    let mut bare = assigned(&store, &run, manager, Some(managed.id.clone()), Vec::new());
    assert!(bare.is_ok());
    bare = store.create_task_for(
        manager,
        run.id.clone(),
        "Part".into(),
        "Do it".into(),
        Vec::new(),
        Some(managed.id.clone()),
        None,
        None,
        None,
    );
    assert!(bare.unwrap_err().contains("assignee"));
    assert!(assigned(&store, &run, manager, None, Vec::new()).is_err());
    assert!(assigned(
        &store,
        &run,
        "chat:someone",
        Some(managed.id.clone()),
        Vec::new()
    )
    .is_err());
    assert!(assigned(&store, &run, manager, Some(part.id.clone()), Vec::new()).is_err());
}

#[test]
fn master_recovery_keeps_run_identity_and_checks_owner_and_settlement() {
    let store = OrchestrationStore::default();
    let original = run(&store);
    for _ in 0..2 {
        let (_guard, resumed) = store
            .guard_master_start("chat:master", &original.id)
            .unwrap();
        assert_eq!(resumed.id, original.id);
    }
    assert_eq!(store.snapshot(None).unwrap().runs.len(), 1);
    assert!(store
        .guard_master_start("chat:other", &original.id)
        .is_err());
    store
        .stop_run("chat:master", original.id.clone(), "Stop".into())
        .unwrap();
    assert!(store
        .guard_master_start("chat:master", &original.id)
        .unwrap_err()
        .contains("settled"));
    let next = run(&store);
    assert_ne!(next.id, original.id);
    assert!(store.guard_master_start("chat:master", &next.id).is_ok());
}

fn question() -> crate::question::Question {
    serde_json::from_value(serde_json::json!({
        "question": "Which approach?", "options": [
            { "label": "Keep", "description": "Keep the existing behavior" }, "Change"
        ]
    }))
    .unwrap()
}

#[test]
fn worker_chat_mutations_are_rejected_before_any_side_effect() {
    let store = Arc::new(OrchestrationStore::default());
    let run = run(&store);
    let worker = running_worker(&store, &run);
    let mut manager = ChatManager::default();
    manager.orchestrations = store.clone();
    let svc = crate::dispatch::Services {
        workspaces: Arc::new(crate::workspaces::WorkspaceState::load()),
        chats: Arc::new(manager),
        watch: Arc::new(crate::file_watch::FileWatchState::default()),
        git_watch: Arc::new(crate::git_watch::GitWatchState::default()),
        orchestrations: store.clone(),
        ptys: Arc::new(crate::pty::PtyManager::default()),
        handovers: crate::handover::Wiring::scratch(),
    };
    let commands = [
        "chat_start",
        "chat_send",
        "chat_cancel_auto_resume",
        "chat_cancel_queued",
        "chat_dismiss_unsent",
        "chat_start_queued",
        "chat_interrupt",
        "chat_set_access",
        "chat_stop",
        "chat_retarget",
        "chat_restart",
        "chat_forget",
        "chat_index_remove",
    ];
    for key in [&worker.worker_chat_key, "chat:orch-not-yet-loaded"] {
        for command in commands {
            let error = crate::dispatch::dispatch(
                &svc,
                command,
                serde_json::json!({
                    "key": key, "id": key.trim_start_matches("chat:"), "recordUser": false,
                    "text": "bypass", "prompt": null,
                }),
            )
            .unwrap_err();
            assert!(error.contains("read-only"), "{command}: {error}");
        }
    }
    assert!(
        crate::dispatch::dispatch(&svc, "orchestration_snapshot", serde_json::json!({})).is_ok()
    );
    assert!(store.require_user_chat("chat:master").is_ok());
    assert!(store.require_user_chat("chat:ordinary").is_ok());

    let (_, _receiver) = svc
        .chats
        .questions
        .insert(
            crate::question_store::test_origin(&worker.worker_chat_key),
            vec![question()],
        )
        .unwrap();
    let id = svc.chats.questions.pending().unwrap()[0].id.clone();
    for command in [
        "question_answer",
        "question_answer_batch",
        "question_retry",
        "question_cancel",
    ] {
        let result = crate::dispatch::dispatch(
            &svc,
            command,
            serde_json::json!({
                "id": id, "ids": [id], "answer": "bypass", "answers": [{"id": id, "answer": "bypass"}]
            }),
        );
        assert!(result.unwrap_err().contains("read-only"), "{command}");
    }
    assert_eq!(svc.chats.questions.pending().unwrap().len(), 1);
}

#[test]
fn settlement_time_is_separate_from_later_metadata_changes() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let worker = running_worker(&store, &run);
    assert_eq!(worker.finished_at, None);
    store
        .report_worker(
            &worker.worker_chat_key,
            WorkerReport {
                attempt_id: worker.id.clone(),
                outcome: WorkerOutcome::Completed,
                summary: "done".into(),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap();
    let finished = store.snapshot(None).unwrap().attempts[0]
        .finished_at
        .unwrap();
    let mut inner = store.inner.lock().unwrap();
    let attempt = inner.data.attempts.get_mut(&worker.id).unwrap();
    assert_eq!(finished, attempt.updated_at);
    attempt.updated_at += 100_000;
    assert!(!recover_interrupted_workers(&mut inner.data));
    assert_eq!(inner.data.attempts[&worker.id].finished_at, Some(finished));
    // Old ledgers retain their last settlement time before later metadata changes.
    let attempt = inner.data.attempts.get_mut(&worker.id).unwrap();
    attempt.finished_at = None;
    attempt.updated_at = finished;
    assert!(recover_interrupted_workers(&mut inner.data));
    assert_eq!(inner.data.attempts[&worker.id].finished_at, Some(finished));
}

#[test]
fn finished_and_old_workers_remain_read_only() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let worker = running_worker(&store, &run);
    store
        .report_worker(
            &worker.worker_chat_key,
            WorkerReport {
                attempt_id: worker.id.clone(),
                outcome: WorkerOutcome::Completed,
                summary: "done".into(),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap();
    // Legacy keys have no reserved prefix, but still belong to the ledger.
    store
        .mutate(|data| {
            data.attempts.get_mut(&worker.id).unwrap().worker_chat_key =
                "chat:legacy-worker".into();
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store
            .worker_coordinator("chat:legacy-worker")
            .unwrap()
            .as_deref(),
        Some("chat:master")
    );
    assert!(store
        .require_user_chat("chat:legacy-worker")
        .unwrap_err()
        .contains("read-only"));
    // Its attempt has settled, so nothing is active for it; it is still
    // a worker's chat, and that is what a hook that can write asks.
    assert!(store.active_task("chat:legacy-worker").unwrap().is_none());
    assert!(store.is_worker_chat("chat:legacy-worker").unwrap());
    assert!(store.is_worker_chat("chat:orch-not-yet-loaded").unwrap());
    assert!(!store.is_worker_chat("chat:master").unwrap());
    assert!(store
        .route_worker_questions("chat:legacy-worker", &[question()])
        .unwrap_err()
        .contains("settled"));
    assert!(store
        .create_run(
            "chat:legacy-worker".into(),
            "Nested run".into(),
            "workspace".into(),
            "/tmp".into(),
            None
        )
        .is_err());
}

#[test]
fn only_coordinators_can_send_to_workers() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let worker = running_worker(&store, &run);
    let peer = running_worker(&store, &run);
    let send = |actor: &str, to: &str| {
        store.record_message(
            actor,
            run.id.clone(),
            to.into(),
            "update".into(),
            "Progress".into(),
            "Ready".into(),
        )
    };
    assert_eq!(
        send(&worker.worker_chat_key, "coordinator")
            .unwrap()
            .to_chat_key,
        "chat:master"
    );
    assert_eq!(
        send("chat:master", &worker.id).unwrap().to_chat_key,
        worker.worker_chat_key
    );
    assert!(send(&worker.worker_chat_key, &peer.id)
        .unwrap_err()
        .contains("only to their coordinator"));
    assert!(store
        .create_run(
            worker.worker_chat_key,
            "Nested".into(),
            "workspace".into(),
            "/tmp".into(),
            None
        )
        .is_err());
    assert_eq!(store.snapshot(None).unwrap().messages.len(), 2);
}

/// A worker's media cannot be drawn on a gate, so the gate names each
/// file with its kind and path for the coordinator to look at.
#[test]
fn a_workers_question_media_is_named_on_its_gate() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let worker = running_worker(&store, &run);
    let media = |name: &str, kind: &str, path: &str| {
        json!({ "id": "a".repeat(32), "kind": kind, "mime": "x", "path": path,
                    "name": name, "bytes": 1 })
    };
    let mut shot = media("home.png", "image", "/p/home.png");
    shot["caption"] = json!("Today");
    let question: crate::question::Question = serde_json::from_value(json!({
            "question": "Which layout?",
            "media": [shot, media("take.mp4", "video", "/p/take.mp4")],
            "options": [{ "label": "Keep", "image": media("face.png", "image", "/p/face.png") }, "Change"],
        }))
        .unwrap();
    let gate = store
        .route_worker_questions(&worker.worker_chat_key, &[question])
        .unwrap()
        .unwrap();
    assert_eq!(
        gate.question,
        "1. Which layout?\nAttached: home.png (image, /p/home.png) — Today\n\
             Attached: take.mp4 (video, /p/take.mp4)\n\
             - Keep [image: face.png (image, /p/face.png)]\n- Change"
    );
    assert_eq!(gate.options, vec!["Keep", "Change"]);
}

#[test]
fn worker_questions_become_coordinator_gates_without_an_implied_answer() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let worker = running_worker(&store, &run);
    assert!(store
        .route_worker_questions("chat:master", &[question()])
        .unwrap()
        .is_none());
    let gate = store
        .route_worker_questions(&worker.worker_chat_key, &[question()])
        .unwrap()
        .unwrap();
    assert_eq!(gate.target_chat_key, "chat:master");
    assert_eq!(gate.task_id.as_deref(), Some(worker.task_id.as_str()));
    assert_eq!(gate.options, vec!["Keep", "Change"]);
    assert!(gate.question.contains("Keep the existing behavior"));
    assert_eq!(gate.status, GateStatus::Open);
    assert!(gate.resolution.is_none());
    assert_eq!(
        store.snapshot(None).unwrap().attempts[0].status,
        AttemptStatus::Blocked
    );
    assert!(store
        .resolve_gate(&worker.worker_chat_key, gate.id.clone(), "Keep".into())
        .is_err());
    assert_eq!(
        store
            .resolve_gate("chat:master", gate.id, "Keep".into())
            .unwrap()
            .status,
        GateStatus::Resolved
    );
    assert_eq!(
        store.snapshot(None).unwrap().attempts[0].status,
        AttemptStatus::Running
    );
}

/// Review M7: the task a worker's gate carries is its own whether or not
/// the call names it, so "one open gate per task" is asked of that task.
#[test]
fn a_task_has_one_open_gate_even_when_the_worker_does_not_name_it() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let worker = running_worker(&store, &run);
    let open = |task_id: Option<String>| {
        store.create_gate(
            &worker.worker_chat_key,
            run.id.clone(),
            task_id,
            "Which volume?".into(),
            vec![],
        )
    };
    let first = open(None).unwrap();
    assert_eq!(first.task_id.as_deref(), Some(worker.task_id.as_str()));
    for task_id in [None, Some(worker.task_id.clone())] {
        let second = open(task_id).unwrap_err();
        assert_eq!(
            second,
            "This task already has an open decision gate. Resolve it first."
        );
    }
    let gates = store.snapshot(None).unwrap().gates;
    assert_eq!(gates.len(), 1);
    // Answered, the task may ask again.
    store
        .resolve_gate("chat:master", first.id, "volume1".into())
        .unwrap();
    open(None).unwrap();
    // A coordinator's gate that names no task is the run's, as before,
    // and any number of those may be open.
    for _ in 0..2 {
        let gate = store
            .create_gate(
                "chat:master",
                run.id.clone(),
                None,
                "Ship today?".into(),
                vec![],
            )
            .unwrap();
        assert!(gate.task_id.is_none());
    }
}

#[test]
fn stale_native_question_cannot_create_a_gate() {
    let store = Arc::new(OrchestrationStore::default());
    let run = run(&store);
    let worker = running_worker(&store, &run);
    let mut manager = ChatManager::default();
    manager.orchestrations = store.clone();
    let manager = Arc::new(manager);
    assert!(crate::agent_chat::route_worker_questions(
        &manager,
        &worker.worker_chat_key,
        Some(&worker.worker_chat_key),
        Some("expired-launch"),
        &[question()]
    )
    .unwrap_err()
    .contains("no longer running"));
    assert!(store.snapshot(None).unwrap().gates.is_empty());
    assert!(manager.questions.pending().unwrap().is_empty());
}

#[test]
fn dependencies_become_ready_only_after_their_prerequisite_completes() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let first = task(&store, &run, Vec::new());
    let second = task(&store, &run, vec![first.id.clone()]);
    assert_eq!(first.status, TaskStatus::Ready);
    assert_eq!(second.status, TaskStatus::Pending);

    let launch = launch_in_worktree(&first.id);
    let (_, _, attempt, _) = store.reserve_attempt("chat:master", &launch).unwrap();
    store
        .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
        .unwrap();
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id,
                outcome: WorkerOutcome::Completed,
                summary: "done".into(),
                files_modified: vec!["a.rs".into()],
                verdict: None,
            },
        )
        .unwrap();
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    assert_eq!(
        snapshot
            .tasks
            .iter()
            .find(|task| task.id == second.id)
            .unwrap()
            .status,
        TaskStatus::Ready
    );
}

#[test]
fn only_the_active_attempt_can_settle_a_task() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let task = task(&store, &run, Vec::new());
    let launch = launch_in_worktree(&task.id);
    let (_, _, first, _) = store.reserve_attempt("chat:master", &launch).unwrap();
    store
        .fail_preparation(
            &first.id,
            "retry".into(),
            String::new(),
            String::new(),
            false,
        )
        .unwrap();
    let (_, _, second, _) = store.reserve_attempt("chat:master", &launch).unwrap();

    let error = store
        .report_worker(
            &first.worker_chat_key,
            WorkerReport {
                attempt_id: first.id,
                outcome: WorkerOutcome::Completed,
                summary: "late".into(),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap_err();
    assert!(error.contains("stale"));
    assert_eq!(
        store.snapshot(Some(&run.id)).unwrap().tasks[0]
            .active_attempt_id
            .as_deref(),
        Some(second.id.as_str())
    );
}

#[test]
fn a_worker_cannot_report_for_someone_elses_attempt() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let task = task(&store, &run, Vec::new());
    let launch = WorkerLaunch {
        agent: ChatAgent::Claude,
        ..launch_in_worktree(&task.id)
    };
    let (_, _, attempt, _) = store.reserve_attempt("chat:master", &launch).unwrap();
    let error = store
        .report_worker(
            "chat:impostor",
            WorkerReport {
                attempt_id: attempt.id,
                outcome: WorkerOutcome::Completed,
                summary: "not mine".into(),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap_err();
    assert!(error.contains("does not own"));
}

#[test]
fn a_reported_block_can_be_retried_but_an_open_gate_cannot() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let task = task(&store, &run, Vec::new());
    let launch = launch_in_worktree(&task.id);
    let (_, _, first, _) = store.reserve_attempt("chat:master", &launch).unwrap();
    store
        .activate_attempt(&first.id, "/tmp".into(), "first".into(), true)
        .unwrap();
    store
        .report_worker(
            &first.worker_chat_key,
            WorkerReport {
                attempt_id: first.id.clone(),
                outcome: WorkerOutcome::Blocked,
                summary: "needs a different approach".into(),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap();
    let second_report = store
        .report_worker(
            &first.worker_chat_key,
            WorkerReport {
                attempt_id: first.id.clone(),
                outcome: WorkerOutcome::Completed,
                summary: "late completion".into(),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap_err();
    assert!(second_report.contains("already settled"), "{second_report}");

    let message_error = store
        .record_message(
            "chat:master",
            run.id.clone(),
            first.id.clone(),
            "instruction".into(),
            "Continue".into(),
            "Continue the run.".into(),
        )
        .unwrap_err();
    assert!(message_error.contains("Start a retry"), "{message_error}");
    assert!(store.snapshot(Some(&run.id)).unwrap().messages.is_empty());

    let (_, _, second, previous) = store.reserve_attempt("chat:master", &launch).unwrap();
    assert_ne!(first.id, second.id);
    let previous = previous.expect("the retry keeps its predecessor context");
    assert_eq!(previous.cwd, "/tmp");
    assert_eq!(previous.branch, "first");
    assert!(previous.is_worktree);
    assert_eq!(
        store
            .snapshot(Some(&run.id))
            .unwrap()
            .attempts
            .iter()
            .find(|attempt| attempt.id == first.id)
            .unwrap()
            .status,
        AttemptStatus::Cancelled
    );

    store
        .activate_attempt(&second.id, "/tmp".into(), "second".into(), true)
        .unwrap();
    store
        .create_gate(
            &second.worker_chat_key,
            run.id.clone(),
            Some(task.id),
            "Which API?".into(),
            vec!["A".into(), "B".into()],
        )
        .unwrap();
    assert!(store
        .reserve_attempt("chat:master", &launch)
        .unwrap_err()
        .contains("decision gate"));
    let gate_message_error = store
        .record_message(
            "chat:master",
            run.id,
            second.id,
            "instruction".into(),
            "Continue".into(),
            "Continue the run.".into(),
        )
        .unwrap_err();
    assert!(
        gate_message_error.contains("Resolve that gate"),
        "{gate_message_error}"
    );
}

#[test]
fn a_settled_block_does_not_consume_a_concurrency_slot() {
    let store = OrchestrationStore::default();
    let run = store
        .create_run(
            "chat:master".into(),
            "Ship the feature".into(),
            "workspace".into(),
            "/tmp".into(),
            Some(1),
        )
        .unwrap();
    let first_task = task(&store, &run, Vec::new());
    let second_task = task(&store, &run, Vec::new());
    let mut launch = launch_in_worktree(&first_task.id);
    let (_, _, first, _) = store.reserve_attempt("chat:master", &launch).unwrap();
    store
        .activate_attempt(&first.id, "/tmp".into(), "first".into(), true)
        .unwrap();
    store
        .report_worker(
            &first.worker_chat_key,
            WorkerReport {
                attempt_id: first.id,
                outcome: WorkerOutcome::Blocked,
                summary: "blocked".into(),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap();

    launch.task_id = second_task.id;
    store.reserve_attempt("chat:master", &launch).unwrap();
}

#[test]
fn unreadable_state_is_never_overwritten_by_a_new_run() {
    let root = crate::test_dir::TestDir::new("orchestration");
    let file = root.join("orchestrations.json");
    fs::write(&file, b"not json").unwrap();
    let store = OrchestrationStore::load(file.clone());
    assert!(store
        .create_run(
            "chat:master".into(),
            "objective".into(),
            "workspace".into(),
            "/tmp".into(),
            None,
        )
        .is_err());
    assert_eq!(fs::read(&file).unwrap(), b"not json");
}

#[test]
fn pending_safety_card_keeps_its_worker_attempt_resumable() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let task = task(&store, &run, Vec::new());
    let launch = launch_in_worktree(&task.id);
    let (_, _, attempt, _) = store.reserve_attempt("chat:master", &launch).unwrap();
    store
        .activate_attempt(&attempt.id, "/tmp".into(), "worker".into(), true)
        .unwrap();
    crate::safety_block::observe(ChatAgent::Codex, &attempt.worker_chat_key,
            "codex_core::tools::router: error=This action was rejected due to unacceptable risk.\\nReason: Upload requires a decision.");
    let result = store.report_worker(
        &attempt.worker_chat_key,
        WorkerReport {
            attempt_id: attempt.id.clone(),
            outcome: WorkerOutcome::Blocked,
            summary: "Waiting for upload decision".into(),
            files_modified: vec![],
            verdict: None,
        },
    );
    crate::safety_block::forget_chat(&attempt.worker_chat_key);
    assert!(result.unwrap_err().contains("safety"));
    assert_eq!(
        store.snapshot(Some(&run.id)).unwrap().attempts[0].status,
        AttemptStatus::Running
    );
}

#[test]
fn active_workers_become_retriable_after_a_server_restart() {
    let root = crate::test_dir::TestDir::new("orchestration");
    let file = root.join("orchestrations.json");
    let store = OrchestrationStore::load(file.clone());
    let run = run(&store);
    let task = task(&store, &run, Vec::new());
    let launch = launch_in_worktree(&task.id);
    let (_, _, attempt, _) = store.reserve_attempt("chat:master", &launch).unwrap();
    store
        .activate_attempt(&attempt.id, "/tmp".into(), "worker".into(), true)
        .unwrap();
    drop(store);

    let restored = OrchestrationStore::load(file);
    let snapshot = restored.snapshot(Some(&run.id)).unwrap();
    assert_eq!(snapshot.attempts[0].status, AttemptStatus::Failed);
    assert_eq!(snapshot.tasks[0].status, TaskStatus::Failed);
    assert_eq!(snapshot.runs[0].status, RunStatus::Failed);
    restored.reserve_attempt("chat:master", &launch).unwrap();
}

#[test]
fn a_reported_block_stays_settled_after_a_server_restart() {
    let root = crate::test_dir::TestDir::new("orchestration");
    let file = root.join("orchestrations.json");
    let store = OrchestrationStore::load(file.clone());
    let run = run(&store);
    let task = task(&store, &run, Vec::new());
    let launch = launch_in_worktree(&task.id);
    let (_, _, attempt, _) = store.reserve_attempt("chat:master", &launch).unwrap();
    store
        .activate_attempt(&attempt.id, "/tmp".into(), "worker".into(), true)
        .unwrap();
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id,
                outcome: WorkerOutcome::Blocked,
                summary: "blocked".into(),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap();
    drop(store);

    let restored = OrchestrationStore::load(file);
    let snapshot = restored.snapshot(Some(&run.id)).unwrap();
    assert_eq!(snapshot.attempts[0].status, AttemptStatus::Blocked);
    assert_eq!(snapshot.tasks[0].status, TaskStatus::Blocked);
    assert_eq!(snapshot.runs[0].status, RunStatus::Waiting);
}

#[test]
fn a_message_limit_counts_utf8_bytes_and_names_both_sizes() {
    let accepted = "中".repeat(6_666) + "ab";
    assert_eq!(
        required_text("message body", accepted, 20_000)
            .unwrap()
            .len(),
        20_000
    );
    let refused = "中".repeat(6_667);
    let error = required_text("message body", refused, 20_000).unwrap_err();
    assert!(error.contains("20001 UTF-8 bytes"), "{error}");
    assert!(error.contains("20000 UTF-8 bytes"), "{error}");
}

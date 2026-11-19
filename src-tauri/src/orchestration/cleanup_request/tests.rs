
use super::*;
use crate::git_ops::workflow::tests::Repo;

thread_local! {
    // Read exactly what a reloaded page sees at each progress boundary,
    // without a timing-dependent race against the next item's removal.
    static PROGRESS_SNAPSHOTS: std::cell::RefCell<Option<Vec<serde_json::Value>>> =
        const { std::cell::RefCell::new(None) };
}

pub(super) fn progress_emitted(store: &OrchestrationStore) {
    PROGRESS_SNAPSHOTS.with(|slot| {
        if let Some(snapshots) = slot.borrow_mut().as_mut() {
            assert!(
                store.cleanup_requests.try_lock().is_ok(),
                "progress is published after releasing the pending-request lock"
            );
            snapshots.push(serde_json::to_value(store.cleanup_request_pending().unwrap()).unwrap());
        }
    });
}

struct ProgressProbe;

impl ProgressProbe {
    fn new() -> Self {
        PROGRESS_SNAPSHOTS.with(|slot| *slot.borrow_mut() = Some(Vec::new()));
        Self
    }

    fn assert_progress(&self, card: &Asked, result: &Settled, tap: &crate::bus::tap::Tap) {
        assert!(card.results.is_empty());
        assert_eq!(card.approved, None);
        assert!(serde_json::to_value(card)
            .unwrap()
            .get("approved")
            .is_none());
        let events: Vec<_> = tap
            .heard()
            .into_iter()
            .filter(|(event, _)| event == EVENT)
            .map(|(_, payload)| payload)
            .collect();
        let mut expected = vec![json!({
            "state": "processing", "id": card.id,
            "chatKey": card.chat_key, "approved": result.approved
        })];
        for item in &result.items {
            expected.push(json!({
                "state": "item", "id": card.id, "chatKey": card.chat_key, "item": item
            }));
        }
        expected.push(json!({
            "state": "settled", "id": card.id, "chatKey": card.chat_key, "result": result
        }));
        assert_eq!(events, expected, "processing → item × N → settled");
        assert_eq!(
            result.items.iter().map(|i| &i.id).collect::<Vec<_>>(),
            card.items.iter().map(|i| &i.id).collect::<Vec<_>>()
        );
        PROGRESS_SNAPSHOTS.with(|slot| {
            let snapshots = slot.borrow();
            let snapshots = snapshots.as_ref().unwrap();
            assert_eq!(snapshots.len(), result.items.len() + 1);
            for (completed, snapshot) in snapshots.iter().enumerate() {
                let mut expected = serde_json::to_value(card).unwrap();
                expected["processing"] = json!(true);
                expected["approved"] = json!(result.approved);
                expected["results"] = json!(&result.items[..completed]);
                assert_eq!(*snapshot, json!([expected]));
            }
        });
    }
}

impl Drop for ProgressProbe {
    fn drop(&mut self) {
        PROGRESS_SNAPSHOTS.with(|slot| *slot.borrow_mut() = None);
    }
}

fn setup(mode: WorkspaceMode) -> (Repo, OrchestrationStore, Run) {
    let repo = Repo::new();
    repo.remote();
    let store = OrchestrationStore::default();
    let run = store
        .create_run_with_mode(
            "chat:master".into(),
            "Cleanup fixture".into(),
            "project".into(),
            repo.root.clone(),
            Some(8),
            mode,
        )
        .unwrap();
    (repo, store, run)
}
fn prepare(store: &OrchestrationStore, run: &Run) -> (Task, Attempt) {
    let task = super::super::tests::task(store, run, vec![]);
    let launch = WorkerLaunch {
        task_id: task.id.clone(),
        agent: ChatAgent::Codex,
        model: None,
        effort: None,
        access: Access::Auto,
        new_worktree: None,
        base_branch: "main".into(),
    };
    let (run, task, reserved, previous) = store
        .reserve_attempt_for("chat:master", &launch, StartedBy::Coordinator)
        .unwrap();
    let ws = store
        .prepare_task_workspace(
            &ChatManager::default(),
            &run,
            &task,
            &reserved,
            previous.as_ref(),
            &launch,
        )
        .unwrap();
    let attempt = store
        .activate_attempt(&reserved.id, ws.cwd, ws.branch, ws.is_worktree)
        .unwrap();
    (task, attempt)
}
fn finish(store: &OrchestrationStore, attempt: &Attempt) {
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome: WorkerOutcome::Completed,
                summary: "Fixture finished".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
}
fn merged(repo: &Repo, attempt: &Attempt) {
    repo.commit(&attempt.cwd, "merged.txt", &attempt.id);
    repo.git(&["merge", "--ff-only", &attempt.branch]);
    repo.git(&["push", "origin", "main"]);
}
// Model a recovered open task gate beside a settled attempt. The public
// create_gate door correctly refuses creating a fresh gate on that attempt;
// Cleanup must still fail closed when an old record contains one.
fn recovered_gate(store: &OrchestrationStore, run: &Run, task_id: &str) {
    let gate = store
        .create_gate(
            "chat:master",
            run.id.clone(),
            None,
            "Keep this checkout?".into(),
            vec![],
        )
        .unwrap();
    store
        .mutate(|data| {
            data.gates.get_mut(&gate.id).unwrap().task_id = Some(task_id.into());
            Ok(())
        })
        .unwrap();
}
fn ask(store: &OrchestrationStore, run: &Run) -> Option<Asked> {
    store
        .request_workspace_cleanup(&ChatManager::default(), "chat:master", Some(&run.id), None)
        .unwrap()
}

#[test]
fn coordinator_allowed_workers_refused_even_after_settlement_and_unrelated_chat_refused() {
    let (_repo, store, run) = setup(WorkspaceMode::Worktree);
    let (_, attempt) = prepare(&store, &run);
    assert!(store
        .cleanup_request_runs("chat:master", Some(&run.id))
        .is_ok());
    assert!(store
        .cleanup_request_runs("chat:other", Some(&run.id))
        .is_err());
    assert!(store.cleanup_request_runs("chat:other", None).is_err());
    assert!(store
        .cleanup_request_runs(&attempt.worker_chat_key, Some(&run.id))
        .is_err());
    finish(&store, &attempt);
    assert!(store
        .active_task(&attempt.worker_chat_key)
        .unwrap()
        .is_none());
    assert!(store
        .cleanup_request_runs(&attempt.worker_chat_key, None)
        .is_err());
    // Legacy keys lack the chat:orch prefix: it is the attempt record,
    // not a naming convention or active_task, that proves identity.
    store
        .mutate(|data| {
            data.attempts.get_mut(&attempt.id).unwrap().worker_chat_key =
                "chat:legacy-worker".into();
            data.runs.get_mut(&run.id).unwrap().coordinator_chat_key = "chat:legacy-worker".into();
            Ok(())
        })
        .unwrap();
    assert!(store
        .cleanup_request_runs("chat:legacy-worker", None)
        .is_err());
}

#[test]
fn empty_and_unsafe_workspaces_create_no_card() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    assert!(ask(&store, &run).is_none());
    let (_, live) = prepare(&store, &run);
    let (unmerged_task, unmerged) = prepare(&store, &run);
    repo.commit(&unmerged.cwd, "not-merged.txt", "unmerged");
    finish(&store, &unmerged);
    let (_, dirty) = prepare(&store, &run);
    finish(&store, &dirty);
    fs::write(Path::new(&dirty.cwd).join("source.txt"), "dirty").unwrap();
    let (abandoned_task, abandoned) = prepare(&store, &run);
    finish(&store, &abandoned);
    store
        .mutate(|data| {
            data.tasks
                .get_mut(&abandoned_task.id)
                .unwrap()
                .workspace
                .as_mut()
                .unwrap()
                .abandoned = true;
            Ok(())
        })
        .unwrap();
    let (gated_task, gated) = prepare(&store, &run);
    finish(&store, &gated);
    let (_, ignored) = prepare(&store, &run);
    finish(&store, &ignored);
    repo.git(&[
        "config",
        "core.excludesFile",
        &repo.dir.join("ignore").to_string_lossy(),
    ]);
    fs::write(repo.dir.join("ignore"), "private.txt\n").unwrap();
    fs::write(Path::new(&ignored.cwd).join("private.txt"), "at stake").unwrap();
    recovered_gate(&store, &run, &gated_task.id);
    assert!(ask(&store, &run).is_none());
    assert!(store.cleanup_request_pending().unwrap().is_empty());
    assert!(store
        .snapshot(Some(&run.id))
        .unwrap()
        .tasks
        .iter()
        .any(|t| t.id == unmerged_task.id));
    assert!(Path::new(&live.cwd).exists());
}

#[test]
fn approve_removes_only_listed_merged_worktrees_and_keeps_changed_control() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let (task, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    let (changed_task, changed) = prepare(&store, &run);
    finish(&store, &changed);
    let card = ask(&store, &run).unwrap();
    assert_eq!(card.items.len(), 2);
    // Same chat's repeated proposal preserves exact contents and id.
    assert_eq!(ask(&store, &run).unwrap().id, card.id);
    repo.commit(
        &changed.cwd,
        "later.txt",
        "HEAD changed after approval preview",
    );
    // A newly eligible workspace was not in the card.
    let (_, later) = prepare(&store, &run);
    finish(&store, &later);
    let tap = crate::bus::tap::Tap::on(&card.id);
    let progress = ProgressProbe::new();
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    progress.assert_progress(&card, &result, &tap);
    assert!(
        !Path::new(&first.cwd).exists(),
        "the safe control must actually be removed"
    );
    assert!(Path::new(&changed.cwd).exists());
    assert!(Path::new(&later.cwd).exists());
    assert_eq!(
        result
            .items
            .iter()
            .find(|r| r.id == format!("task:{}", task.id))
            .unwrap()
            .status,
        "removed"
    );
    let kept = result
        .items
        .iter()
        .find(|r| r.id == format!("task:{}", changed_task.id))
        .unwrap();
    assert_eq!(kept.status, "kept");
    assert!(kept.reason.contains("HEAD changed"), "{}", kept.reason);
    assert!(store.cleanup_request_pending().unwrap().is_empty());
    assert!(store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .is_err());
    let inner = store.inner.lock().unwrap();
    assert!(inner
        .data
        .notifications
        .values()
        .any(|n| n.source == format!("cleanup-result:{}", card.id)
            && n.target_chat_key == "chat:master"
            && n.body.contains("HEAD changed")));
}

#[test]
fn deny_removes_nothing_and_waiting_call_receives_each_outcome() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    let (_, second) = prepare(&store, &run);
    finish(&store, &second);
    let (tx, mut rx) = oneshot::channel();
    let card = store
        .request_workspace_cleanup(&ChatManager::default(), "chat:master", None, Some(tx))
        .unwrap()
        .unwrap();
    assert_eq!(card.items.len(), 2);
    let tap = crate::bus::tap::Tap::on(&card.id);
    let progress = ProgressProbe::new();
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, false)
        .unwrap();
    progress.assert_progress(&card, &result, &tap);
    assert!(!result.approved);
    assert!(result.items.iter().all(|item| item.status == "kept"));
    assert!(Path::new(&first.cwd).exists());
    assert!(Path::new(&second.cwd).exists());
    assert!(store.cleanup_request_pending().unwrap().is_empty());
    assert_eq!(rx.try_recv().unwrap().id, card.id);
    assert!(!store
        .inner
        .lock()
        .unwrap()
        .data
        .notifications
        .values()
        .any(|n| n.source == format!("cleanup-result:{}", card.id)));
}

#[test]
fn mission_close_uses_original_guards_and_binds_membership_and_head() {
    let (repo, store, run) = setup(WorkspaceMode::Mission);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    let card = ask(&store, &run).unwrap();
    assert_eq!(card.items.len(), 1);
    assert!(matches!(card.items[0].kind, Kind::Mission));
    assert_eq!(card.items[0].worktrees[0].ignored_file_count, Some(0));
    repo.commit(&first.cwd, "later.txt", "mission changed");
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept");
    assert!(result.items[0].reason.contains("HEAD changed"));
    assert!(Path::new(&first.cwd).exists());
    repo.git(&["merge", "--ff-only", &first.branch]);
    repo.git(&["push", "origin", "main"]);
    let card = ask(&store, &run).unwrap();
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
    assert!(!Path::new(&first.cwd).exists());
    assert_eq!(
        store.snapshot(Some(&run.id)).unwrap().runs[0].status,
        RunStatus::Closed
    );
}

#[test]
fn unavailable_profile_refuses_approval_but_denial_still_settles() {
    let scratch = crate::test_dir::TestDir::new("cleanup-card-profile");
    let home = scratch.join("profile");
    crate::profile::make_dir(&home).unwrap();
    let _profile = crate::profile::started_in(&home);
    let (repo, mut store, run) = setup(WorkspaceMode::Worktree);
    store.path = Some(crate::profile::profile_dir().join("orchestrations.json"));
    store.mutate(|_| Ok(())).unwrap();
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    let card = ask(&store, &run).unwrap();
    fs::rename(&home, scratch.join("away")).unwrap();
    assert!(store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap_err()
        .contains("profile"));
    assert!(Path::new(&first.cwd).exists());
    assert_eq!(store.cleanup_request_pending().unwrap().len(), 1);
    assert!(
        !store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, false)
            .unwrap()
            .approved
    );
    assert!(Path::new(&first.cwd).exists());
    assert!(
        store.owes(),
        "denial and its notification stay in RAM while the profile is away"
    );
}

#[test]
fn no_run_id_covers_all_coordinated_runs_but_never_another_coordinator() {
    let (repo, store, first_run) = setup(WorkspaceMode::Worktree);
    let (_, first) = prepare(&store, &first_run);
    finish(&store, &first);
    let second_run = store
        .create_run_with_mode(
            "chat:master".into(),
            "Second finished run".into(),
            "project".into(),
            repo.root.clone(),
            None,
            WorkspaceMode::Worktree,
        )
        .unwrap();
    let (_, second) = prepare(&store, &second_run);
    finish(&store, &second);
    // These heads already equal origin/main, which is verified as merged.
    let other_run = store
        .create_run_with_mode(
            "chat:other".into(),
            "Other mission".into(),
            "project".into(),
            repo.root.clone(),
            None,
            WorkspaceMode::Mission,
        )
        .unwrap();
    let card = store
        .request_workspace_cleanup(&ChatManager::default(), "chat:master", None, None)
        .unwrap()
        .unwrap();
    assert_eq!(card.items.len(), 2);
    assert_eq!(card.run_ids.len(), 2);
    assert!(!card.run_ids.contains(&other_run.id));
    assert!(card
        .items
        .iter()
        .all(|i| i.run_id == first_run.id || i.run_id == second_run.id));
}

#[test]
fn swept_task_uses_the_kept_head_and_current_base_without_rebuilding() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    store
        .refresh_workspace("chat:master", &first.task_id)
        .unwrap();
    crate::git_ops::lifespan::remove(&repo.root, &first.cwd, false).unwrap();
    store.lifespan_record_swept(&first.cwd, 100).unwrap();
    let card = ask(&store, &run).unwrap();
    assert_eq!(card.items[0].worktrees[0].ignored_file_count, None);
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
    assert!(!Path::new(&first.cwd).exists());
}

#[test]
fn a_recovered_open_gate_after_the_card_is_kept_by_the_original_cleanup_guard() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let (_, safe) = prepare(&store, &run);
    finish(&store, &safe);
    let (task, held) = prepare(&store, &run);
    finish(&store, &held);
    let card = ask(&store, &run).unwrap();
    recovered_gate(&store, &run, &task.id);
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert!(!Path::new(&safe.cwd).exists());
    assert!(Path::new(&held.cwd).exists());
    let kept = result
        .items
        .iter()
        .find(|i| i.id == format!("task:{}", task.id))
        .unwrap();
    assert_eq!(kept.status, "kept");
    assert!(kept.reason.contains("decision"), "{}", kept.reason);
    assert!(Path::new(&repo.root).exists());
}

#[test]
fn cleanup_receipt_reaches_coordinator_even_for_a_stopped_run() {
    let (_repo, store, run) = setup(WorkspaceMode::Worktree);
    let (_, first) = prepare(&store, &run);
    finish(&store, &first);
    let card = ask(&store, &run).unwrap();
    store
        .mutate(|data| {
            data.runs.get_mut(&run.id).unwrap().status = RunStatus::Stopped;
            Ok(())
        })
        .unwrap();
    store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, false)
        .unwrap();
    let notice = store
        .snapshot(None)
        .unwrap()
        .notifications
        .into_iter()
        .find(|n| n.source == format!("cleanup-result:{}", card.id))
        .unwrap();
    assert!(store
        .claim_notification(&notice.id, now_ms() + 100)
        .unwrap()
        .is_some());
}

// --- runIds: any of the person's chats may propose FINISHED runs ---

fn set_status(store: &OrchestrationStore, run: &Run, status: RunStatus) {
    store
        .mutate(|data| {
            data.runs.get_mut(&run.id).unwrap().status = status;
            Ok(())
        })
        .unwrap();
}

fn ask_named(
    store: &OrchestrationStore,
    actor: &str,
    ids: &[&Run],
) -> Result<Option<Asked>, String> {
    let ids: Vec<String> = ids.iter().map(|r| r.id.clone()).collect();
    store.request_cleanup(&ChatManager::default(), actor, Which::Named(&ids), None)
}

#[test]
fn a_non_coordinator_person_chat_proposes_a_finished_run_and_nothing_is_removed() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    assert!(card.named);
    assert_eq!(card.chat_key, "chat:person");
    assert_eq!(card.items.len(), 1);
    assert_eq!(card.items[0].run_id, run.id);
    assert_eq!(card.items[0].run_objective, "Cleanup fixture");
    assert!(Path::new(&first.cwd).exists(), "a proposal removes nothing");
    // The coordinator's own request is a different chat's card.
    assert_eq!(ask(&store, &run).unwrap().chat_key, "chat:master");
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
    assert!(!Path::new(&first.cwd).exists());
    // The result goes to the chat that asked, and is deliverable there.
    let notice = store
        .snapshot(None)
        .unwrap()
        .notifications
        .into_iter()
        .find(|n| n.source == format!("cleanup-result:{}", card.id))
        .unwrap();
    assert_eq!(notice.target_chat_key, "chat:person");
    assert!(store
        .claim_notification(&notice.id, now_ms() + 100)
        .unwrap()
        .is_some());
}

#[test]
fn named_runs_refuse_workers_even_settled_and_keep_unfinished_runs_with_a_reason() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    let ids = [run.id.clone()];
    assert!(store
        .cleanup_scope(&first.worker_chat_key, Which::Named(&ids))
        .is_err());
    // A running run is kept with the host's reason beside a finished one.
    let busy = store
        .create_run_with_mode(
            "chat:other".into(),
            "Busy".into(),
            "project".into(),
            repo.root.clone(),
            None,
            WorkspaceMode::Worktree,
        )
        .unwrap();
    set_status(&store, &busy, RunStatus::Running);
    let ids = [busy.id.clone(), run.id.clone(), "run_missing".to_string()];
    let scope = store
        .cleanup_scope("chat:person", Which::Named(&ids))
        .unwrap();
    assert_eq!(scope.runs.len(), 1);
    assert_eq!(scope.runs[0].id, run.id);
    assert_eq!(scope.kept.len(), 2);
    assert!(scope.kept[0].reason.contains("running"), "{:?}", scope.kept);
    assert_eq!(scope.kept[1].reason, "No such run.");
    // A live worker, an open gate and a planning run all keep a run.
    set_status(&store, &busy, RunStatus::Planning);
    assert!(store
        .cleanup_scope("chat:person", Which::Named(&[busy.id.clone()]))
        .unwrap_err()
        .contains("planning"));
    set_status(&store, &busy, RunStatus::Completed);
    let gate = store
        .create_gate("chat:other", busy.id.clone(), None, "Keep?".into(), vec![])
        .unwrap();
    // Opening a gate moves the run to waiting; a finished status with a
    // gate still open (a recovered record) must be kept by the gate alone.
    set_status(&store, &busy, RunStatus::Completed);
    assert!(store
        .cleanup_scope("chat:person", Which::Named(&[busy.id.clone()]))
        .unwrap_err()
        .contains("open decision"));
    store
        .mutate(|data| {
            data.gates.get_mut(&gate.id).unwrap().status = GateStatus::Resolved;
            Ok(())
        })
        .unwrap();
    // Starting a worker makes the run live; with the status forced back
    // to finished (a recovered record) the live attempt alone keeps it.
    let (_, live) = prepare(&store, &run);
    assert!(store
        .cleanup_scope("chat:person", Which::Named(&[run.id.clone()]))
        .unwrap_err()
        .contains("running"));
    set_status(&store, &run, RunStatus::Completed);
    assert!(store
        .cleanup_scope("chat:person", Which::Named(&[run.id.clone()]))
        .unwrap_err()
        .contains("worker"));
    let _ = live;
    // Bad lists never reach the ledger.
    for bad in [
        vec![],
        vec![run.id.clone(), run.id.clone()],
        vec!["x".to_string(); 51],
    ] {
        assert!(store
            .cleanup_scope("chat:person", Which::Named(&bad))
            .is_err());
    }
}

#[test]
fn a_named_run_that_stopped_being_finished_is_kept_on_the_answer() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    set_status(&store, &run, RunStatus::Running);
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept");
    assert!(
        result.items[0].reason.contains("running"),
        "{:?}",
        result.items
    );
    assert!(Path::new(&first.cwd).exists());
}

#[test]
fn a_mission_with_no_checkout_closes_on_approval_when_nothing_is_at_stake() {
    let (_repo, store, run) = setup(WorkspaceMode::Mission);
    set_status(&store, &run, RunStatus::Stopped);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    assert!(matches!(card.items[0].kind, Kind::Mission));
    assert!(card.items[0].worktrees.is_empty());
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
    assert_eq!(
        store.snapshot(Some(&run.id)).unwrap().runs[0].status,
        RunStatus::Closed
    );
}

#[test]
fn a_mission_whose_folder_is_gone_closes_even_with_no_saved_delivery() {
    let (repo, store, run) = setup(WorkspaceMode::Mission);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
    crate::git_ops::lifespan::remove(&repo.root, &root, false).unwrap();
    assert!(store.snapshot(Some(&run.id)).unwrap().runs[0]
        .mission_delivery
        .is_empty());
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    assert!(matches!(card.items[0].kind, Kind::Mission));
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
    assert_eq!(
        store.snapshot(Some(&run.id)).unwrap().runs[0].status,
        RunStatus::Closed
    );
}

fn gone_branch_fixture(refresh_first: bool) -> (Repo, OrchestrationStore, Run, Attempt) {
    let (repo, store, run) = setup(WorkspaceMode::Mission);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    if refresh_first {
        store.refresh_mission("chat:master", &run.id).unwrap();
    }
    let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
    crate::git_ops::lifespan::remove(&repo.root, &root, false).unwrap();
    repo.git(&["branch", "-D", &first.branch]);
    assert!(!branch_exists(&repo, &first.branch));
    (repo, store, run, first)
}

#[test]
fn a_merged_mission_whose_folder_and_branch_are_both_gone_closes() {
    let (_repo, store, run, first) = gone_branch_fixture(true);
    let listed = store.coordinated_runs("chat:master").unwrap();
    assert!(listed[0].close_eligible, "{:?}", listed[0].close_blocker);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    assert!(matches!(card.items[0].kind, Kind::Mission));
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
    let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
    assert_eq!(saved.status, RunStatus::Closed);
    assert_eq!(saved.mission_delivery.len(), 1);
    let delivery = &saved.mission_delivery[0];
    assert!(delivery.merged && delivery.removed && delivery.branch_deleted);
    assert_eq!(delivery.branch, first.branch);
}

#[test]
fn a_mission_whose_folder_and_branch_are_gone_but_never_recorded_merged_is_kept() {
    let (_repo, store, run, _first) = gone_branch_fixture(false);
    let listed = store.coordinated_runs("chat:master").unwrap();
    assert!(!listed[0].close_eligible);
    let why = listed[0].close_blocker.clone().unwrap();
    assert!(why.contains("both gone"), "{why}");
    assert!(why.contains("no merge"), "{why}");
    assert!(ask_named(&store, "chat:person", &[&run])
        .map(|card| card.is_none())
        .unwrap_or(true));
    let error = store
        .close_mission(&ChatManager::default(), "chat:master", &run.id, false)
        .unwrap_err();
    assert!(error.contains("both gone"), "{error}");
    assert_ne!(
        store.snapshot(Some(&run.id)).unwrap().runs[0].status,
        RunStatus::Closed
    );
}

#[test]
fn a_git_failure_that_is_not_an_absent_branch_keeps_the_mission() {
    let (_repo, store, run, _first) = gone_branch_fixture(true);
    let (saved, mut plans) = {
        let inner = store.inner.lock().unwrap();
        let saved = inner.data.runs[&run.id].clone();
        (
            saved,
            super::super::mission::mission_plans(&inner.data, &run.id),
        )
    };
    plans[0].repository_root = format!("{}-does-not-exist", plans[0].repository_root);
    let error = super::super::mission::swept_delivery(&saved, &plans[0], false).unwrap_err();
    assert!(!error.contains("both gone"), "{error}");
}

fn task_workspace_state(store: &OrchestrationStore, run: &Run, task_id: &str) -> WorkspaceState {
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let task = snapshot.tasks.iter().find(|t| t.id == task_id).unwrap();
    task.workspace.as_ref().unwrap().state
}

/// The run's whole saved delivery, as the ledger holds it.
fn delivery_json(store: &OrchestrationStore, run: &Run) -> String {
    let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
    serde_json::to_string(&saved.mission_delivery).unwrap()
}

fn nothing_was_closed_or_deleted(store: &OrchestrationStore, run: &Run, before: &str) {
    let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
    assert_ne!(saved.status, RunStatus::Closed);
    assert_eq!(delivery_json(store, run), before);
    assert!(
        saved.mission_delivery.iter().all(|d| !d.branch_deleted),
        "{:?}",
        saved.mission_delivery
    );
}

/// The card was made with the folder and the branch gone; then a branch
/// with the same name in another case appears at an unmerged commit.
fn alias_after_the_card(pack: bool) {
    let (repo, store, run, first) = gone_branch_fixture(true);
    let alias = first.branch.to_uppercase();
    assert_ne!(alias, first.branch);
    let folds_case = Path::new(&repo.root.to_uppercase()).exists();
    if !pack && !folds_case {
        eprintln!("skipped: this filesystem keeps case, a loose alias is another file");
        return;
    }
    let before = delivery_json(&store, &run);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    assert_eq!(
        delivery_json(&store, &run),
        before,
        "asking for a card records nothing"
    );
    let unmerged = repo.git(&["commit-tree", "main^{tree}", "-p", "main", "-m", "unmerged"]);
    repo.git(&["branch", &alias, &unmerged]);
    if pack {
        repo.git(&["pack-refs", "--all"]);
    }
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
    nothing_was_closed_or_deleted(&store, &run, &before);
    assert_eq!(
        repo.git(&["rev-parse", &format!("refs/heads/{alias}")]),
        unmerged,
        "the unmerged work is still there"
    );
}

#[test]
fn a_branch_recreated_under_another_case_after_the_card_keeps_the_mission() {
    alias_after_the_card(false);
}

#[test]
fn a_packed_alias_branch_recreated_after_the_card_keeps_the_mission() {
    alias_after_the_card(true);
}

#[cfg(unix)]
#[test]
fn an_unreadable_loose_ref_folder_keeps_the_mission() {
    use std::os::unix::fs::PermissionsExt;
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
        }
    }
    let (repo, store, run, first) = gone_branch_fixture(true);
    let parent = Path::new(&first.branch).parent().unwrap().to_path_buf();
    let hidden = Path::new(&repo.root).join(".git/refs/heads").join(parent);
    std::fs::create_dir_all(&hidden).unwrap();
    let _restore = Restore(hidden.clone());
    std::fs::set_permissions(&hidden, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read_dir(&hidden).is_ok() {
        eprintln!("skipped: modes are not enforced for this user");
        return;
    }
    let before = delivery_json(&store, &run);
    let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
    let plan = {
        let inner = store.inner.lock().unwrap();
        super::super::mission::mission_plans(&inner.data, &run.id).remove(0)
    };
    assert!(super::super::mission::swept_delivery(&saved, &plan, false).is_err());
    assert!(ask_named(&store, "chat:person", &[&run])
        .map(|card| card.is_none())
        .unwrap_or(true));
    nothing_was_closed_or_deleted(&store, &run, &before);
}

#[test]
fn a_folder_and_branch_recreated_at_the_same_head_after_the_card_are_kept() {
    let (repo, store, run, first) = gone_branch_fixture(true);
    let before = delivery_json(&store, &run);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    assert_eq!(delivery_json(&store, &run), before);
    let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
    repo.git(&["worktree", "add", "-b", &first.branch, &root, "main"]);
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
    assert!(
        result.items[0].reason.contains("appeared or went"),
        "{}",
        result.items[0].reason
    );
    assert!(
        Path::new(&root).exists(),
        "the new worktree was not removed"
    );
    assert!(branch_exists(&repo, &first.branch));
    nothing_was_closed_or_deleted(&store, &run, &before);
}

#[test]
fn asking_for_a_card_records_nothing_a_close_alone_records() {
    let (_repo, store, run, _first) = gone_branch_fixture(true);
    let before = delivery_json(&store, &run);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    assert!(matches!(card.items[0].kind, Kind::Mission));
    assert_eq!(delivery_json(&store, &run), before);
    // Declining changes nothing either.
    store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, false)
        .unwrap();
    assert_eq!(delivery_json(&store, &run), before);
    // The approved Close is what records them.
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
    assert!(saved.mission_delivery[0].removed && saved.mission_delivery[0].branch_deleted);
}

#[test]
fn a_folder_and_branch_made_again_while_a_gone_mission_closes_are_not_recorded_removed() {
    let (repo, store, run, first) = gone_branch_fixture(true);
    let before = delivery_json(&store, &run);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
    let (r, branch, path) = (repo.root.clone(), first.branch.clone(), root.clone());
    super::super::mission::AFTER_BRANCH_DELETE.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            crate::git_ops::lifespan::git(&r, &["worktree", "add", "-b", &branch, &path, "main"])
                .unwrap();
        }))
    });
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
    assert!(
        result.items[0].reason.contains("appeared or went"),
        "{}",
        result.items[0].reason
    );
    assert!(Path::new(&root).exists());
    nothing_was_closed_or_deleted(&store, &run, &before);
}

/// A mission whose folder is gone but whose branch is kept.
fn kept_branch_fixture() -> (Repo, OrchestrationStore, Run, Attempt) {
    let (repo, store, run) = setup(WorkspaceMode::Mission);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    store.refresh_mission("chat:master", &run.id).unwrap();
    let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
    crate::git_ops::lifespan::remove(&repo.root, &root, false).unwrap();
    assert!(branch_exists(&repo, &first.branch));
    (repo, store, run, first)
}

/// The saved delivery without the time git was last asked, which a
/// refresh may move: everything else is what the ask must leave alone.
fn delivery_without_clock(store: &OrchestrationStore, run: &Run) -> serde_json::Value {
    fn strip(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                map.remove("checkedAt");
                map.remove("checked_at");
                map.values_mut().for_each(strip);
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(strip),
            _ => {}
        }
    }
    let mut value = serde_json::from_str(&delivery_json(store, run)).unwrap();
    strip(&mut value);
    value
}

#[test]
fn asking_for_a_card_of_a_swept_mission_with_a_kept_branch_does_not_stamp_it_swept() {
    let (_repo, store, run, _first) = kept_branch_fixture();
    // One refresh of the swept mission first (it recomputes what git can
    // say, such as `pushed`): what follows must change nothing more.
    store.refresh_mission("chat:master", &run.id).unwrap();
    let before = delivery_without_clock(&store, &run);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    assert!(matches!(card.items[0].kind, Kind::Mission));
    assert_eq!(delivery_without_clock(&store, &run), before, "the ask");
    store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, false)
        .unwrap();
    assert_eq!(delivery_without_clock(&store, &run), before, "a Deny");
    let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
    assert!(saved.mission_delivery[0].swept_at.is_none());
    // Only the Close's own read stamps it.
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
    assert_eq!(saved.status, RunStatus::Closed);
    assert!(saved.mission_delivery[0].swept_at.is_some());
}

#[test]
fn a_folder_made_again_during_the_last_branch_lookup_keeps_a_gone_mission() {
    let (_repo, store, run, first) = gone_branch_fixture(true);
    let before = delivery_json(&store, &run);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
    let path = root.clone();
    super::super::mission::AFTER_BRANCH_LOOKUP.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            std::fs::create_dir_all(&path).unwrap();
        }))
    });
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
    assert!(
        result.items[0].reason.contains("appeared or went"),
        "{}",
        result.items[0].reason
    );
    assert!(Path::new(&root).exists());
    nothing_was_closed_or_deleted(&store, &run, &before);
}

#[test]
fn a_folder_made_again_during_the_last_branch_lookup_keeps_a_swept_task() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let (task, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    store
        .refresh_workspace("chat:master", &first.task_id)
        .unwrap();
    crate::git_ops::lifespan::remove(&repo.root, &first.cwd, false).unwrap();
    store.lifespan_record_swept(&first.cwd, 100).unwrap();
    repo.git(&["branch", "-D", &first.branch]);
    let card = ask(&store, &run).expect("a card for the swept task");
    let path = first.cwd.clone();
    super::super::mission::AFTER_BRANCH_LOOKUP.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            std::fs::create_dir_all(&path).unwrap();
        }))
    });
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
    assert!(
        result.items[0].reason.contains("appeared or went"),
        "{}",
        result.items[0].reason
    );
    assert!(Path::new(&first.cwd).exists());
    assert_ne!(
        task_workspace_state(&store, &run, &task.id),
        WorkspaceState::Cleaned
    );
}

#[test]
fn a_folder_and_branch_made_again_during_a_swept_task_cleanup_are_not_recorded_cleaned() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let (task, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    store
        .refresh_workspace("chat:master", &first.task_id)
        .unwrap();
    crate::git_ops::lifespan::remove(&repo.root, &first.cwd, false).unwrap();
    store.lifespan_record_swept(&first.cwd, 100).unwrap();
    repo.git(&["branch", "-D", &first.branch]);
    let card = ask(&store, &run).expect("a card for the swept task");
    let (r, branch, path) = (repo.root.clone(), first.branch.clone(), first.cwd.clone());
    super::super::mission::AFTER_SWEPT_EVIDENCE.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            crate::git_ops::lifespan::git(&r, &["worktree", "add", "-b", &branch, &path, "main"])
                .unwrap();
        }))
    });
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
    assert!(
        result.items[0].reason.contains("appeared or went"),
        "{}",
        result.items[0].reason
    );
    assert!(
        Path::new(&first.cwd).exists(),
        "the new folder was not touched"
    );
    assert_ne!(
        task_workspace_state(&store, &run, &task.id),
        WorkspaceState::Cleaned
    );
}

#[test]
fn a_folder_that_went_after_the_card_is_kept_too() {
    let (repo, store, run) = setup(WorkspaceMode::Mission);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
    crate::git_ops::lifespan::remove(&repo.root, &root, false).unwrap();
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
    assert_ne!(
        store.snapshot(Some(&run.id)).unwrap().runs[0].status,
        RunStatus::Closed
    );
}

#[test]
fn a_swept_task_whose_branch_is_gone_too_is_cleaned_from_its_merged_delivery() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let (task, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    store
        .refresh_workspace("chat:master", &first.task_id)
        .unwrap();
    crate::git_ops::lifespan::remove(&repo.root, &first.cwd, false).unwrap();
    store.lifespan_record_swept(&first.cwd, 100).unwrap();
    repo.git(&["branch", "-D", &first.branch]);
    assert!(!branch_exists(&repo, &first.branch));
    let card = ask(&store, &run).expect("a card for the swept task");
    assert_eq!(card.items.len(), 1, "{:?}", card.items);
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
    let state = task_workspace_state(&store, &run, &task.id);
    assert_eq!(state, WorkspaceState::Cleaned);
}

#[test]
fn a_task_whose_folder_is_back_is_not_taken_for_swept_and_gone() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let (_task, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    store
        .refresh_workspace("chat:master", &first.task_id)
        .unwrap();
    crate::git_ops::lifespan::remove(&repo.root, &first.cwd, false).unwrap();
    store.lifespan_record_swept(&first.cwd, 100).unwrap();
    repo.git(&["branch", "-D", &first.branch]);
    let ws = |store: &OrchestrationStore| {
        store
            .owned_task("chat:master", &first.task_id)
            .unwrap()
            .1
            .workspace
            .unwrap()
    };
    assert_eq!(
        super::super::mission::swept_task_branch_gone(&ws(&store)),
        Ok(true)
    );
    // Only the folder comes back: the branch stays gone.
    std::fs::create_dir_all(&first.cwd).unwrap();
    let error = super::super::mission::swept_task_branch_gone(&ws(&store)).unwrap_err();
    assert!(error.contains("there again"), "{error}");
    assert!(Path::new(&first.cwd).exists(), "the folder was not touched");
}

#[test]
fn a_swept_task_with_its_branch_gone_and_no_merge_recorded_is_kept() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let (task, first) = prepare(&store, &run);
    finish(&store, &first);
    crate::git_ops::lifespan::remove(&repo.root, &first.cwd, false).unwrap();
    store.lifespan_record_swept(&first.cwd, 100).unwrap();
    repo.git(&["branch", "-D", &first.branch]);
    let error = store
        .cleanup_workspace(
            &ChatManager::default(),
            "chat:master",
            &first.task_id,
            false,
            "",
        )
        .unwrap_err();
    assert!(error.contains("both gone"), "{error}");
    let state = task_workspace_state(&store, &run, &task.id);
    assert_ne!(state, WorkspaceState::Cleaned);
}

#[test]
fn a_folder_that_exists_is_never_treated_as_gone() {
    let (repo, store, run) = setup(WorkspaceMode::Mission);
    let (_, first) = prepare(&store, &run);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    // The branch has an unmerged commit: still at stake, still kept.
    repo.commit(&first.cwd, "later.txt", "unmerged mission work");
    let cards = ask_named(&store, "chat:person", &[&run]).unwrap();
    assert!(cards.is_none(), "an unmerged mission is not proposed");
    assert!(Path::new(&first.cwd).exists());
}

fn during_the_proof(hook: impl FnOnce() + 'static) {
    crate::worktree_lifespan::AFTER_REMOVAL_PROOF
        .with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[test]
fn a_run_level_gate_opened_during_the_proof_keeps_the_task_folder() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let store = std::sync::Arc::new(store);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    let (s, r) = (store.clone(), run.clone());
    during_the_proof(move || {
        s.create_gate("chat:master", r.id.clone(), None, "Keep?".into(), vec![])
            .unwrap();
        // Isolate the gate: the status alone must not be what keeps it.
        set_status(&s, &r, RunStatus::Completed);
    });
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
    assert!(
        result.items[0].reason.contains("open decision"),
        "{:?}",
        result.items
    );
    assert!(Path::new(&first.cwd).exists());
}

#[test]
fn a_worker_started_in_another_task_during_the_proof_keeps_the_task_folder() {
    let (repo, store, run) = setup(WorkspaceMode::Worktree);
    let store = std::sync::Arc::new(store);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    let (s, r) = (store.clone(), run.clone());
    during_the_proof(move || {
        let _ = prepare(&s, &r);
        set_status(&s, &r, RunStatus::Completed);
    });
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
    assert!(
        result.items[0].reason.contains("worker"),
        "{:?}",
        result.items
    );
    assert!(Path::new(&first.cwd).exists());
}

#[test]
fn a_run_level_gate_opened_during_the_proof_keeps_the_mission_open() {
    let (repo, store, run) = setup(WorkspaceMode::Mission);
    let store = std::sync::Arc::new(store);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    assert!(matches!(card.items[0].kind, Kind::Mission));
    let (s, r) = (store.clone(), run.clone());
    during_the_proof(move || {
        s.create_gate("chat:master", r.id.clone(), None, "Keep?".into(), vec![])
            .unwrap();
        set_status(&s, &r, RunStatus::Completed);
    });
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
    assert!(
        result.items[0].reason.contains("open decision"),
        "{:?}",
        result.items
    );
    assert!(Path::new(&first.cwd).exists());
    assert_ne!(
        store.snapshot(Some(&run.id)).unwrap().runs[0].status,
        RunStatus::Closed
    );
}

fn after_delivery(hook: impl FnOnce() + 'static) {
    super::super::mission::AFTER_DELIVERY.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

fn after_branch_delete(hook: impl FnOnce() + 'static) {
    super::super::mission::AFTER_BRANCH_DELETE
        .with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

fn branch_exists(repo: &Repo, branch: &str) -> bool {
    crate::git_ops::lifespan::text(
        &repo.root,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/heads/{branch}^{{commit}}"),
        ],
    )
    .is_ok()
}

#[test]
fn a_run_level_gate_opened_after_the_delivery_read_keeps_a_gone_mission_open() {
    let (repo, store, run) = setup(WorkspaceMode::Mission);
    let store = std::sync::Arc::new(store);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
    crate::git_ops::lifespan::remove(&repo.root, &root, false).unwrap();
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    assert!(matches!(card.items[0].kind, Kind::Mission));
    let (s, r) = (store.clone(), run.clone());
    // The window is the delivery read of a gone mission (it may ask a
    // remote): no folder is removed on this path at all.
    after_delivery(move || {
        s.create_gate("chat:master", r.id.clone(), None, "Keep?".into(), vec![])
            .unwrap();
        set_status(&s, &r, RunStatus::Completed);
    });
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
    assert!(
        result.items[0].reason.contains("open decision"),
        "{:?}",
        result.items
    );
    assert_ne!(
        store.snapshot(Some(&run.id)).unwrap().runs[0].status,
        RunStatus::Closed
    );
    assert!(branch_exists(&repo, &first.branch), "the branch is kept");
}

#[test]
fn a_gate_opened_after_the_branch_delete_keeps_the_mission_open_but_records_what_happened() {
    let (repo, store, run) = setup(WorkspaceMode::Mission);
    let store = std::sync::Arc::new(store);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    assert!(matches!(card.items[0].kind, Kind::Mission));
    let (s, r) = (store.clone(), run.clone());
    // The folder and the merged branch are already gone here; only the
    // closing write is left.
    after_branch_delete(move || {
        s.create_gate("chat:master", r.id.clone(), None, "Keep?".into(), vec![])
            .unwrap();
        set_status(&s, &r, RunStatus::Completed);
    });
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    // The folder did go, so the host says so, with the refusal as the reason.
    assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
    assert!(
        result.items[0].reason.contains("open decision"),
        "{:?}",
        result.items
    );
    let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
    assert_ne!(saved.status, RunStatus::Closed);
    assert!(saved.closed_at.is_none());
    assert!(!Path::new(&first.cwd).exists(), "the folder went");
    assert!(!branch_exists(&repo, &first.branch), "the branch went");
    assert_eq!(
        saved.mission_delivery.len(),
        1,
        "{:?}",
        saved.mission_delivery
    );
    assert!(saved.mission_delivery[0].removed);
    assert!(
        saved.mission_delivery[0].branch_deleted,
        "the saved delivery says the branch is deleted"
    );
}

#[test]
fn a_run_level_gate_opened_after_the_delivery_read_keeps_a_mission_with_no_checkout_open() {
    let (_repo, store, run) = setup(WorkspaceMode::Mission);
    let store = std::sync::Arc::new(store);
    set_status(&store, &run, RunStatus::Stopped);
    let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
    assert!(card.items[0].worktrees.is_empty());
    let (s, r) = (store.clone(), run.clone());
    // With no checkout there is no delivery read: the window is the end
    // of the close's Git work, before the write that marks it Closed.
    after_delivery(move || {
        s.create_gate("chat:master", r.id.clone(), None, "Keep?".into(), vec![])
            .unwrap();
        set_status(&s, &r, RunStatus::Stopped);
    });
    let result = store
        .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
        .unwrap();
    assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
    assert!(
        result.items[0].reason.contains("open decision"),
        "{:?}",
        result.items
    );
    assert_ne!(
        store.snapshot(Some(&run.id)).unwrap().runs[0].status,
        RunStatus::Closed
    );
}

#[test]
fn a_mission_whose_container_moved_away_is_kept_not_closed() {
    let (repo, store, run) = setup(WorkspaceMode::Mission);
    let (_, first) = prepare(&store, &run);
    merged(&repo, &first);
    finish(&store, &first);
    set_status(&store, &run, RunStatus::Completed);
    let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
    let container = Path::new(&root).parent().unwrap().to_path_buf();
    let moved = container.with_file_name(format!(
        "{}-offline",
        container.file_name().unwrap().to_string_lossy()
    ));
    fs::rename(&container, &moved).unwrap();
    // The checkout is not found, but its folder is gone too: unknown, not swept.
    assert!(ask_named(&store, "chat:person", &[&run])
        .map(|card| card.is_none())
        .unwrap_or(true));
    let error = store
        .close_mission(&ChatManager::default(), "chat:master", &run.id, false)
        .unwrap_err();
    assert!(error.contains("not confirmed"), "{error}");
    assert_ne!(
        store.snapshot(Some(&run.id)).unwrap().runs[0].status,
        RunStatus::Closed
    );
    assert!(moved.exists(), "nothing was touched");
}

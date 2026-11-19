
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
                swept_at: None,
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
fn startup_recovery_keeps_a_cleaning_checkout_a_quarantine_record_says_is_aside() {
    let repo = Repo::new();
    let store = OrchestrationStore::default();
    let run = super::super::tests::run(&store);
    let task = super::super::tests::task(&store, &run, vec![]);
    let plan = workflow::plan(&repo.root, "main", &task.id, WorkspaceMode::Worktree).unwrap();
    // A killed server left the checkout in quarantine: its original path
    // is missing and a record names the folder that holds it now.
    let aside = format!("{}/.octiq-removing-aaaaaaaaaaaaaaaa", repo.root);
    fs::create_dir_all(&aside).unwrap();
    let records = crate::profile::profile_dir().join("lifespan-quarantine");
    crate::profile::make_dir(&records).unwrap();
    let record = records.join("aaaaaaaaaaaaaaaa.json");
    fs::write(
        &record,
        serde_json::to_vec(&json!({
            "id": "aaaaaaaaaaaaaaaa", "repo": repo.root,
            "original": plan.checkout_root, "quarantine": aside, "at": 1,
        }))
        .unwrap(),
    )
    .unwrap();
    store
        .mutate(|data| {
            data.tasks.get_mut(&task.id).unwrap().workspace = Some(TaskWorkspace {
                swept_at: None,
                plan,
                state: WorkspaceState::Cleaning,
                lease_attempt_id: None,
                delivery: None,
                abandoned: false,
                cleanup_intent: Some(true),
                validation_paths: vec![],
            });
            assert!(recover_workspaces(data));
            let task = &data.tasks[&task.id];
            assert_ne!(task.status, TaskStatus::Cancelled);
            let ws = task.workspace.as_ref().unwrap();
            assert_eq!(ws.state, WorkspaceState::Retained);
            assert!(!ws.abandoned);
            Ok(())
        })
        .unwrap();
    fs::remove_file(&record).unwrap();
    fs::remove_dir_all(&aside).unwrap();
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
                verdict: None,
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

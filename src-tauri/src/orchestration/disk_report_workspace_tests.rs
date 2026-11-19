use super::*;
#[test]
fn completed_missions_and_retained_validation_paths_stay_managed() {
    let home = crate::test_dir::TestDir::new("disk-managed-ledger");
    let store = OrchestrationStore::default();
    let run = tests::run(&store);
    let task = tests::task(&store, &run, vec![]);
    let checkout = home.join("task");
    let validation = home.join("validation");
    let mission = home.join("mission");
    {
        let mut inner = store.inner.lock().unwrap();
        let task = inner.data.tasks.get_mut(&task.id).unwrap();
        task.status = TaskStatus::Completed;
        task.workspace = Some(workspaces::TaskWorkspace {
            swept_at: None,
            plan: crate::git_ops::workflow::WorkspacePlan {
                mode: WorkspaceMode::Worktree,
                cwd: checkout.to_string_lossy().into(),
                checkout_root: checkout.to_string_lossy().into(),
                repository_root: home.to_string_lossy().into(),
                branch: "feature/test".into(),
                base_branch: "develop".into(),
                base_sha: "test".into(),
                managed: true,
                is_repo: true,
                warnings: vec![],
                initial_status: String::new(),
            },
            state: workspaces::WorkspaceState::Retained,
            lease_attempt_id: None,
            delivery: None,
            abandoned: false,
            cleanup_intent: None,
            validation_paths: vec![validation.to_string_lossy().into()],
        });
        let run = inner.data.runs.get_mut(&run.id).unwrap();
        run.status = RunStatus::Completed;
        run.mission_delivery.push(mission::MissionDelivery {
            repository_root: home.to_string_lossy().into(),
            checkout_root: mission.to_string_lossy().into(),
            branch: "feature/mission".into(),
            base_branch: "develop".into(),
            evidence: Default::default(),
            merged: false,
            released: None,
            release_note: String::new(),
            removed: false,
            swept_at: None,
            branch_deleted: false,
        });
    }
    let paths = store.disk_report_workspaces().unwrap();
    for path in [&checkout, &validation, &mission] {
        assert!(paths.contains(path));
    }
    store
        .inner
        .lock()
        .unwrap()
        .data
        .tasks
        .get_mut(&task.id)
        .unwrap()
        .workspace
        .as_mut()
        .unwrap()
        .state = workspaces::WorkspaceState::Cleaned;
    let paths = store.disk_report_workspaces().unwrap();
    assert!(!paths.contains(&checkout) && !paths.contains(&validation));
    assert!(paths.contains(&mission));
    store
        .inner
        .lock()
        .unwrap()
        .data
        .runs
        .get_mut(&run.id)
        .unwrap()
        .mission_delivery[0]
        .removed = true;
    assert!(store.disk_report_workspaces().unwrap().is_empty());
}

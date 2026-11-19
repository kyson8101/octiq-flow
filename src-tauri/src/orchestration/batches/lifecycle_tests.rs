
use super::tests::{assigned, settings};
use super::*;
use crate::test_dir::TestDir;

#[test]
fn first_turn_without_claim_claims_only_the_head_and_keeps_candidates_queued() {
    let home = TestDir::new("batch-fallback");
    let _profile = crate::profile::started_in(&home);
    crate::scheduling::save(settings()).unwrap();
    let store = OrchestrationStore::default();
    let run = super::super::tests::run(&store);
    let head = assigned(&store, &run, 1);
    let other = assigned(&store, &run, 2);
    store.sync_agent_queue().unwrap();
    let (batch, mut runtime) = store
        .begin_batch("agent_test", &settings())
        .unwrap()
        .unwrap();
    assert!(store
        .fallback_claim(&WorkspaceState::load(), &batch, &runtime, false)
        .unwrap()
        .is_none());
    runtime.started = true;
    assert!(store
        .fallback_claim(&WorkspaceState::load(), &batch, &runtime, true)
        .unwrap()
        .is_none());
    let claims = store
        .fallback_claim(&WorkspaceState::load(), &batch, &runtime, false)
        .unwrap()
        .unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].task_id, head.id);
    assert!(store
        .inner
        .lock()
        .unwrap()
        .data
        .agent_queue
        .contains_key(&other.id));
}

#[test]
fn dirty_worktree_blocks_lane_notifies_owner_and_task_cleanup_keeps_it() {
    let home = TestDir::new("batch-dirty");
    let _profile = crate::profile::started_in(&home);
    crate::scheduling::save(settings()).unwrap();
    let store = OrchestrationStore::default();
    let run = super::super::tests::run(&store);
    let head = assigned(&store, &run, 1);
    store.sync_agent_queue().unwrap();
    let (batch, runtime) = store
        .begin_batch("agent_test", &settings())
        .unwrap()
        .unwrap();
    crate::git_ops::workflow::provision_agent(&runtime.plan).unwrap();
    let claims = store
        .batch_claim(
            &WorkspaceState::load(),
            &runtime.worker_chat_key,
            vec![head.id.clone()],
        )
        .unwrap();
    let dirty = Path::new(&runtime.plan.cwd).join("keep.txt");
    std::fs::write(&dirty, "author work").unwrap();
    let reason = crate::git_ops::workflow::provision_agent(&runtime.plan).unwrap_err();
    store.block_batch(&batch, reason).unwrap();
    let inner = store.inner.lock().unwrap();
    assert_eq!(lanes(&inner.data, None)[0]["state"], "blocked");
    assert!(inner
        .data
        .notifications
        .values()
        .any(|n| n.target_chat_key == "chat:master"));
    drop(inner);
    assert!(store
        .begin_batch("agent_test", &settings())
        .unwrap()
        .is_none());
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
    let chats = ChatManager::default();
    for abandon in [false, true] {
        assert!(store
            .cleanup_workspace(&chats, "chat:master", &head.id, abandon, "unused")
            .unwrap_err()
            .contains("Agent worktrees"));
    }
    assert_eq!(std::fs::read_to_string(dirty).unwrap(), "author work");
    assert!(Path::new(&runtime.plan.checkout_root).exists());
}

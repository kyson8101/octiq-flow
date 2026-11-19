use super::tests::{assigned, settings};
use super::*;
use crate::test_dir::TestDir;

#[test]
fn stopping_one_task_requeues_its_shared_process_peers_without_another_retry() {
    let home = TestDir::new("batch-stop-peers");
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
    let claims = store
        .batch_claim(
            &WorkspaceState::load(),
            &runtime.worker_chat_key,
            vec![first.id.clone(), second.id.clone()],
        )
        .unwrap();
    let (_, key) = store.stop_task(&first.id, None).unwrap();
    assert_eq!(key, runtime.worker_chat_key);
    store.sync_agent_queue().unwrap();
    store.settle_batches().unwrap();
    let inner = store.inner.lock().unwrap();
    assert!(inner.data.tasks[&first.id].stopped.is_some());
    assert_eq!(inner.data.tasks[&second.id].status, TaskStatus::Ready);
    assert_eq!(inner.data.tasks[&second.id].retries_used, 0);
    assert_eq!(queue(&inner.data, "agent_test")[0].id, second.id);
    assert!(claims
        .iter()
        .all(|a| inner.data.attempts[&a.id].status == AttemptStatus::Cancelled));
}

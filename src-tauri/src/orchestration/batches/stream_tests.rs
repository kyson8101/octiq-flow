use super::tests::{assigned, settings};
use super::*;
use crate::test_dir::TestDir;

#[test]
fn shared_stream_activity_and_disconnect_reach_every_unsettled_attempt() {
    let home = TestDir::new("batch-stream");
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
    store.observe_worker_event(&runtime.worker_chat_key, &json!({"type":"item.started","item":{"id":"cmd","type":"command_execution","command":"fixture-only"}})).unwrap();
    {
        let inner = store.inner.lock().unwrap();
        for attempt in &claims {
            assert!(inner.data.attempts[&attempt.id]
                .execution
                .pending_tools
                .contains_key("cmd"));
            assert!(active_attempt_for_task(
                &inner.data,
                &runtime.worker_chat_key,
                &attempt.task_id
            )
            .is_some());
        }
    }
    store
        .worker_disconnected(&runtime.worker_chat_key, Some("fixture process exited"))
        .unwrap();
    store.settle_batches().unwrap();
    let inner = store.inner.lock().unwrap();
    assert!(claims
        .iter()
        .all(|a| inner.data.attempts[&a.id].status == AttemptStatus::Failed));
    assert_eq!(inner.data.batches[0].status, BatchStatus::Settled);
}

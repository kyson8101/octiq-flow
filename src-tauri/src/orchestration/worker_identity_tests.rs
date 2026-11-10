//! Browser Stop admission must not queue behind a ledger writer's profile I/O.
use super::tests::{run, running_worker, settled_worker};
use super::*;
use crate::dispatch::{dispatch, Services};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[test]
fn durable_workers_stay_read_only_at_dispatch_while_the_ledger_is_locked() {
    let home = crate::test_dir::TestDir::new("worker-identity-stop");
    let _profile = crate::profile::started_in(&home);
    let svc = Services::at_profile();
    let store = svc.orchestrations.clone();
    let run = run(&store);
    let live = running_worker(&store, &run);
    store
        .mutate(|data| {
            data.attempts.get_mut(&live.id).unwrap().worker_chat_key = "chat:legacy-live".into();
            Ok(())
        })
        .unwrap();
    let settled = settled_worker(&store, &run, Some("chat:legacy-settled"));
    assert!(store
        .active_task(&settled.worker_chat_key)
        .unwrap()
        .is_none());
    let ledger = store.inner.lock().unwrap();
    let (done, finish) = mpsc::channel();
    let checking = store.clone();
    let thread = std::thread::spawn(move || {
        let began = Instant::now();
        for key in [
            "chat:legacy-live",
            "chat:legacy-settled",
            "chat:orch-unknown",
        ] {
            for cmd in ["chat_stop", "chat_interrupt", "chat_forget"] {
                assert!(
                    dispatch(&svc, cmd, json!({"key":key}))
                        .unwrap_err()
                        .contains("read-only"),
                    "{cmd}: {key}"
                );
            }
        }
        assert!(checking.require_user_chat("chat:master").is_ok());
        assert!(checking.require_user_chat("chat:ordinary").is_ok());
        done.send(began.elapsed()).unwrap();
    });
    let timely = finish.recv_timeout(Duration::from_millis(200));
    // Release even on failure so a regression cannot strand a test thread.
    drop(ledger);
    thread.join().unwrap();
    assert!(timely.unwrap() < Duration::from_millis(200));
}

#[test]
fn identity_is_published_with_the_attempt_and_only_after_a_successful_commit() {
    let home = crate::test_dir::TestDir::new("worker-identity-commit");
    let path = home.join("ledger.json");
    let store = OrchestrationStore::load(path.clone());
    let run = run(&store);
    let worker = running_worker(&store, &run);
    let mut candidate = worker.clone();
    candidate.id = "new-attempt".into();
    candidate.worker_chat_key = "chat:legacy-new".into();
    let insert = |data: &mut Stored| {
        data.attempts
            .insert(candidate.id.clone(), candidate.clone());
        Ok(())
    };
    let mut ledger = store.inner.lock().unwrap();
    let refused = store.mutate_locked_at_commit(&mut ledger, None, insert, |_| {
        assert!(store.require_user_chat(&candidate.worker_chat_key).is_ok());
        Err("commit veto".into())
    });
    assert_eq!(refused.unwrap_err(), "commit veto");
    assert!(!ledger.data.attempts.contains_key(&candidate.id));
    assert!(store.require_user_chat(&candidate.worker_chat_key).is_ok());
    store
        .mutate_locked_at_commit(&mut ledger, None, insert, |_| {
            assert!(store.require_user_chat(&candidate.worker_chat_key).is_ok());
            Ok(())
        })
        .unwrap();
    // Keep holding the ledger after the creation: identity is already visible,
    // without waiting for unlock, a scheduler pass, or any active_task lookup.
    assert!(ledger.data.attempts.contains_key(&candidate.id));
    assert!(store
        .require_user_chat(&candidate.worker_chat_key)
        .unwrap_err()
        .contains("read-only"));
    store
        .mutate_locked(&mut ledger, None, |data| {
            data.attempts.remove(&candidate.id);
            Ok(())
        })
        .unwrap();
    assert!(store.require_user_chat(&candidate.worker_chat_key).is_ok());
    // Fail the actual persist rename portably, without a production failpoint.
    fs::remove_file(&path).unwrap();
    crate::profile::make_dir(&path).unwrap();
    assert!(store.mutate_locked(&mut ledger, None, insert).is_err());
    assert!(!ledger.data.attempts.contains_key(&candidate.id));
    assert!(store.require_user_chat(&candidate.worker_chat_key).is_ok());
    // A failed save of an ending action still publishes the in-memory ledger.
    store
        .mutate_locked(&mut ledger, Some("test identity"), insert)
        .unwrap();
    assert!(ledger.owed);
    assert!(store.require_user_chat(&candidate.worker_chat_key).is_err());
    drop(ledger);
    fs::remove_dir(&path).unwrap();
    assert!(store.settle_owed().unwrap());
    let reloaded = OrchestrationStore::load(path);
    assert!(reloaded
        .require_user_chat(&candidate.worker_chat_key)
        .is_err());
}

#[test]
fn reload_restores_legacy_identity_and_preserves_load_errors() {
    let home = crate::test_dir::TestDir::new("worker-identity-reload");
    let path = home.join("ledger.json");
    let store = OrchestrationStore::load(path.clone());
    let run = run(&store);
    let worker = settled_worker(&store, &run, Some("chat:legacy-reloaded"));
    let reloaded = OrchestrationStore::load(path.clone());
    assert!(reloaded
        .require_user_chat(&worker.worker_chat_key)
        .unwrap_err()
        .contains("read-only"));
    assert!(reloaded.require_user_chat("chat:ordinary").is_ok());
    let roster = home.join("team.json");
    let registered = crate::team::save(
        &roster,
        serde_json::from_value(json!({
            "name":"Dev", "role":"Works", "agent":"codex", "model":"gpt-6.1-sol"
        }))
        .unwrap(),
    )
    .unwrap();
    reloaded
        .mutate(|data| {
            data.removed_agents.insert(registered.id.clone(), now_ms());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        reloaded.reconcile_removed(&roster).unwrap(),
        vec![registered.id]
    );
    // Reconciliation edits removed_agents directly; it must leave the durable
    // worker identity in agreement with the unchanged attempt record.
    let reconciled = reloaded.inner.lock().unwrap();
    assert_eq!(
        reconciled.data.attempts[&worker.id].worker_chat_key,
        worker.worker_chat_key
    );
    assert!(reloaded
        .require_user_chat(&worker.worker_chat_key)
        .unwrap_err()
        .contains("read-only"));
    drop(reconciled);
    fs::write(&path, "not json").unwrap();
    let broken = OrchestrationStore::load(path);
    let error = broken.inner.lock().unwrap().load_error.clone().unwrap();
    assert_eq!(
        broken.require_user_chat("chat:ordinary").unwrap_err(),
        error
    );
    assert!(broken
        .require_user_chat("chat:orch-unknown")
        .unwrap_err()
        .contains("read-only"));
}

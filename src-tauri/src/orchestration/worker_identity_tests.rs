//! Browser Stop admission must not queue behind a ledger writer's profile I/O.
use super::tests::{
    finish_attempt, launch_for, pending_plan, run, running_worker, running_worker_of,
    settled_worker,
};
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

fn who(id: &str) -> TaskAssignee {
    TaskAssignee {
        id: id.into(),
        name: id.to_uppercase(),
    }
}

#[test]
fn a_workers_registered_agent_is_its_attempts_reserved_snapshot_and_nothing_else() {
    let home = crate::test_dir::TestDir::new("worker-agent-id");
    let _profile = crate::profile::started_in(&home);
    let svc = Services::at_profile();
    let store = svc.orchestrations.clone();
    let run = run(&store);
    let live = running_worker(&store, &run);
    // A task with no assignee says nothing, and neither does a stranger.
    assert_eq!(store.worker_agent_id(&live.worker_chat_key), None);
    assert_eq!(store.worker_agent_id("chat:orch-unknown"), None);
    assert_eq!(store.worker_agent_id("chat:ordinary"), None);
    // The task's assignee alone is not an identity: an attempt that has no
    // reserved snapshot (an old record) is "no", never the task's current one.
    store
        .mutate(|data| {
            let task = data.attempts[&live.id].task_id.clone();
            data.tasks.get_mut(&task).unwrap().assignee = Some(who("agent_social"));
            Ok(())
        })
        .unwrap();
    assert_eq!(store.worker_agent_id(&live.worker_chat_key), None);
    // Reserved for an agent, it is that agent.
    let agent = running_worker_of(&store, &run, &who("agent_social"));
    assert_eq!(
        store.worker_agent_id(&agent.worker_chat_key).as_deref(),
        Some("agent_social")
    );
    // Not the coordinator's own chat.
    assert_eq!(store.worker_agent_id(&run.coordinator_chat_key), None);
    // Two attempts of one chat that name different agents are ambiguous.
    store
        .mutate(|data| {
            let mut twin = data.attempts[&agent.id].clone();
            twin.id = "attempt_twin".into();
            twin.assignee = Some(who("agent_other"));
            data.attempts.insert(twin.id.clone(), twin);
            Ok(())
        })
        .unwrap();
    assert_eq!(store.worker_agent_id(&agent.worker_chat_key), None);
}

#[test]
fn a_reassigned_tasks_old_chat_never_resolves_to_the_new_agent() {
    let home = crate::test_dir::TestDir::new("worker-agent-id-reassign");
    let _profile = crate::profile::started_in(&home);
    let svc = Services::at_profile();
    let store = svc.orchestrations.clone();
    let (run, first) = pending_plan(&store);
    let settings = |agent, model: &str, access| automation::WorkerSettings {
        agent,
        access,
        model: Some(model.into()),
        effort: None,
        recovery: None,
    };
    let route = |agent_id: &str, worker| {
        store.reassign_task(
            "chat:master",
            &first.id,
            (Some(worker), Some(who(agent_id)), None),
            "Hand over".into(),
        )
    };
    // Plain agent A runs the task first and its attempt settles without
    // finishing.
    route("agent_a", settings(ChatAgent::Claude, "opus", Access::Auto)).unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    let (_, _, old, _) = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                agent: ChatAgent::Claude,
                model: Some("opus".into()),
                ..launch_for(&first.id)
            },
        )
        .unwrap();
    let old = store
        .activate_attempt(&old.id, "/tmp".into(), "a".into(), true)
        .unwrap();
    assert_eq!(
        store.worker_agent_id(&old.worker_chat_key).as_deref(),
        Some("agent_a")
    );
    finish_attempt(&store, old.clone(), WorkerOutcome::Blocked);
    // The task is handed to Codex agent B, which is approved and starts.
    route(
        "agent_b",
        settings(ChatAgent::Codex, "gpt-5.6-terra", Access::Read),
    )
    .unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    let (_, _, new, _) = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                agent: ChatAgent::Codex,
                model: Some("gpt-5.6-terra".into()),
                access: Access::Read,
                ..launch_for(&first.id)
            },
        )
        .unwrap();
    assert_ne!(old.worker_chat_key, new.worker_chat_key);
    let task = store
        .snapshot(Some(&run.id))
        .unwrap()
        .tasks
        .into_iter()
        .find(|t| t.id == first.id)
        .unwrap();
    assert_eq!(task.assignee.as_ref().unwrap().id, "agent_b");
    // A's old chat (a fresh start, a queued turn, a resume and a relaunch all
    // ask by this key) is still A; only B's own chat is B.
    assert_eq!(
        store.worker_agent_id(&old.worker_chat_key).as_deref(),
        Some("agent_a")
    );
    assert_eq!(
        store.worker_agent_id(&new.worker_chat_key).as_deref(),
        Some("agent_b")
    );
}

/// The extra MCP servers a worker gets are its OWN reservation's agent's
/// (`agent_chat::worker_registration`), never the task's assignee after a
/// handoff, and the access it runs at changes nothing: a Full task handed
/// from A to B leaves A's old chat with A's list and gives B's chat B's, for
/// every start path that asks by the chat key.
#[test]
fn a_reassigned_tasks_chats_keep_their_own_agents_worker_servers() {
    let home = crate::test_dir::TestDir::new("worker-servers-reassign");
    let _profile = crate::profile::started_in(&home);
    let roster = home.join("team.json");
    let _team = crate::team::use_test_path(roster.clone());
    let register = |name: &str, agent: &str, model: &str, servers: &[&str]| {
        crate::team::save(
            &roster,
            serde_json::from_value(json!({
                "name": name, "agent": agent, "model": model, "workerServers": servers,
            }))
            .unwrap(),
        )
        .unwrap()
    };
    let a = register("Alpha", "claude", "opus", &["higgsfield"]);
    let b = register("Beta", "codex", "gpt-5.6-terra", &["sume", "sentry"]);
    let svc = Services::at_profile();
    let store = svc.orchestrations.clone();
    let (run, task) = pending_plan(&store);
    let settings = |agent, model: &str| automation::WorkerSettings {
        agent,
        access: Access::Full,
        model: Some(model.into()),
        effort: None,
        recovery: None,
    };
    let hand_to = |agent: &crate::team::TeamAgent, worker| {
        store
            .reassign_task(
                "chat:master",
                &task.id,
                (Some(worker), Some(who(&agent.id)), None),
                "Hand over".into(),
            )
            .unwrap();
        store
            .approve_plan("chat:master", &run.id, None, None)
            .unwrap();
    };
    let start = |agent, model: &str| {
        store
            .reserve_attempt(
                "chat:master",
                &WorkerLaunch {
                    agent,
                    model: Some(model.into()),
                    access: Access::Full,
                    ..launch_for(&task.id)
                },
            )
            .unwrap()
            .2
    };
    let servers = |key: &str| {
        crate::agent_chat::worker_registration(&store, key).map(|agent| agent.worker_servers)
    };
    hand_to(&a, settings(ChatAgent::Claude, "opus"));
    let old = start(ChatAgent::Claude, "opus");
    let old = store
        .activate_attempt(&old.id, "/tmp".into(), "a".into(), true)
        .unwrap();
    assert_eq!(
        servers(&old.worker_chat_key),
        Some(vec!["higgsfield".into()])
    );
    finish_attempt(&store, old.clone(), WorkerOutcome::Blocked);
    hand_to(&b, settings(ChatAgent::Codex, "gpt-5.6-terra"));
    let new = start(ChatAgent::Codex, "gpt-5.6-terra");
    assert_eq!(
        servers(&old.worker_chat_key),
        Some(vec!["higgsfield".into()]),
        "the old chat keeps its own agent's list after the handoff"
    );
    assert_eq!(
        servers(&new.worker_chat_key),
        Some(vec!["sume".into(), "sentry".into()])
    );
    // A chat that is no worker, or a coordinator, gets nothing.
    assert_eq!(servers("chat:orch-unknown"), None);
    assert_eq!(servers(&run.coordinator_chat_key), None);
}

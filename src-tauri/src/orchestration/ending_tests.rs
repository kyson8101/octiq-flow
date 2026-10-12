//! Review of 205bca2, H5, at the ledger: stopping a task or a run, a gate's
//! answer and a coordinator's interrupt do not wait on the ledger's save.
//!
//! Through the real `dispatch` commands, against the ledger a server loads
//! from its profile folder, with a live stand-in for the worker. The other
//! half is `ending_tests.rs` beside `agent_chat.rs`.
use super::tests::{approved_plan, start_task};
use super::*;
use crate::agent_chat::{ChatAgent, TestChild};
use crate::dispatch::{settle_owed, told, Services, Told};
use crate::profile::tests::Home;
use serde_json::{json, Value};

/// A server with its profile folder on a drive of its own, one approved
/// task and a worker running on it.
struct World {
    svc: Services,
    _process: crate::profile::Started,
    home: Home,
    run: Run,
    task: Task,
    attempt: Attempt,
    worker: TestChild,
}

impl World {
    /// `working` is a worker in the middle of a turn.
    fn new(working: bool) -> Self {
        let home = Home::with_a_configured_base();
        let process = crate::profile::started_in(&home.dir);
        let svc = Services::at_profile();
        let (run, tasks) = approved_plan(&svc.orchestrations, 1);
        let attempt = start_task(&svc.orchestrations, &tasks[0].id);
        let worker = svc
            .chats
            .test_hold(&attempt.worker_chat_key, ChatAgent::Claude, working);
        assert_eq!(on_disk()["attempts"][&attempt.id]["status"], "running");
        Self {
            svc,
            _process: process,
            home,
            run,
            task: tasks.into_iter().next().unwrap(),
            attempt,
            worker,
        }
    }

    fn folder_goes(&self) -> String {
        self.home.move_away();
        crate::profile::available().expect_err("the profile folder is away")
    }

    /// The folder comes back, holding what it held when it went, and the
    /// owed save is made.
    fn folder_returns_and_is_caught_up(&self, before: &Value) {
        self.home.move_back();
        assert_eq!(
            &on_disk(),
            before,
            "the ledger was written while its folder was away"
        );
        assert!(settle_owed(&self.svc).is_empty());
    }

    fn snapshot(&self) -> Snapshot {
        self.svc.orchestrations.snapshot(None).unwrap()
    }
}

fn on_disk() -> Value {
    let path = crate::profile::profile_dir().join("orchestrations.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[track_caller]
fn not_recorded(told: &Told, what: &str, why: &str) {
    assert!(
        told.unsaved
            .iter()
            .any(|unsaved| unsaved.what == what && unsaved.reason == why),
        "the caller was not told that {what} could not be recorded: {:?}",
        told.unsaved
    );
}

/// The reviewer's task-stop probe, with a worker that is really running.
#[test]
fn the_person_stops_a_task_while_the_profile_is_away_and_its_worker_ends() {
    let world = World::new(true);
    let before = on_disk();
    let why = world.folder_goes();

    let stopped = told(
        &world.svc,
        "orchestration_task_stop",
        json!({ "taskId": world.task.id, "reason": "Not this" }),
    );
    let task = stopped.result.clone().expect("the stop happened");
    assert_eq!(task["status"], "failed", "{task}");
    not_recorded(&stopped, "the stopped task", &why);
    assert!(world.worker.gone(), "the worker is still running");
    let now = world.snapshot();
    let attempt = now.attempts.iter().find(|a| a.id == world.attempt.id);
    assert_eq!(attempt.unwrap().status, AttemptStatus::Cancelled);
    assert_eq!(settle_owed(&world.svc), ["the ledger"]);

    world.folder_returns_and_is_caught_up(&before);
    // The server restarts: the task is still the one the person stopped.
    let restarted = OrchestrationStore::load_profile().snapshot(None).unwrap();
    let attempt = restarted.attempts.iter().find(|a| a.id == world.attempt.id);
    assert_eq!(attempt.unwrap().status, AttemptStatus::Cancelled);
    let task = restarted
        .tasks
        .iter()
        .find(|t| t.id == world.task.id)
        .unwrap();
    assert!(task.stopped.is_some(), "host recovery would start it again");
}

#[test]
fn a_run_is_stopped_while_the_profile_is_away_and_its_workers_end() {
    let world = World::new(true);
    let before = on_disk();
    let why = world.folder_goes();

    let stopped = told(
        &world.svc,
        "orchestration_run_stop",
        json!({ "actorChatKey": "chat:master", "runId": world.run.id, "reason": "Wrong plan" }),
    );
    assert_eq!(stopped.result, Ok(Value::Null));
    not_recorded(&stopped, "the stopped run", &why);
    assert!(world.worker.gone(), "the worker is still running");
    assert_eq!(world.snapshot().runs[0].status, RunStatus::Stopped);

    world.folder_returns_and_is_caught_up(&before);
    let restarted = OrchestrationStore::load_profile().snapshot(None).unwrap();
    assert_eq!(restarted.runs[0].status, RunStatus::Stopped);
}

/// The person's answer on a gate's card is theirs. It is taken and kept;
/// the worker, whose turn ended when it asked, is given it in a new turn,
/// which like every start waits for a folder its record can be kept in.
#[test]
fn a_gates_answer_is_taken_while_the_profile_is_away_and_kept_for_the_worker() {
    let world = World::new(false);
    let gate = world
        .svc
        .orchestrations
        .create_gate(
            &world.attempt.worker_chat_key,
            world.run.id.clone(),
            Some(world.task.id.clone()),
            "Which way?".into(),
            Vec::new(),
        )
        .unwrap();
    let before = on_disk();
    let why = world.folder_goes();

    let answered = told(
        &world.svc,
        "orchestration_gate_resolve",
        json!({ "actorChatKey": "chat:master", "gateId": gate.id, "resolution": "Left" }),
    );
    let resolved = answered.result.clone().expect("the answer was taken");
    assert_eq!(resolved["status"], "resolved", "{resolved}");
    not_recorded(&answered, "the gate's answer", &why);
    let now = world.snapshot();
    let kept = now.gates.iter().find(|g| g.id == gate.id).unwrap();
    assert_eq!(kept.resolution.as_deref(), Some("Left"));
    let for_worker = format!("resolved:{}", gate.id);
    assert!(
        now.notifications.iter().any(|n| n.source == for_worker),
        "nothing is waiting to tell the worker"
    );

    world.folder_returns_and_is_caught_up(&before);
    let restarted = OrchestrationStore::load_profile().snapshot(None).unwrap();
    let kept = restarted.gates.iter().find(|g| g.id == gate.id).unwrap();
    assert_eq!(kept.status, GateStatus::Resolved);
    assert_eq!(kept.resolution.as_deref(), Some("Left"));
    assert!(restarted
        .notifications
        .iter()
        .any(|n| n.source == for_worker));
    world.svc.chats.test_end(&world.attempt.worker_chat_key);
}

/// A coordinator's interrupt is a Stop with a message behind it: the
/// worker's turn is cut short whether or not the message could be saved.
/// An ordinary message, which stops nothing, is refused as before.
#[test]
fn a_coordinator_interrupts_a_worker_while_the_profile_is_away() {
    let world = World::new(true);
    let before = on_disk();
    let why = world.folder_goes();
    let message = |interrupt: bool| {
        json!({
            "actorChatKey": "chat:master", "runId": world.run.id, "to": world.attempt.id,
            "kind": "instruction", "subject": "Pause", "body": "Stop and wait.",
            "interrupt": interrupt,
        })
    };

    let ordinary = told(&world.svc, "orchestration_message_send", message(false));
    assert_eq!(ordinary.result, Err(why.clone()));
    assert!(world
        .svc
        .chats
        .turn_in_flight(&world.attempt.worker_chat_key));

    let sent = told(&world.svc, "orchestration_message_send", message(true));
    let value = sent.result.clone().expect("the worker was interrupted");
    assert_eq!(value["interrupt"], "interrupted", "{value}");
    not_recorded(&sent, "the coordinator's message", &why);
    let worker = &world.attempt.worker_chat_key;
    assert!(
        world.svc.chats.unwinding(worker),
        "the turn was not cut short"
    );
    assert!(!world.svc.chats.turn_in_flight(worker));

    world.folder_returns_and_is_caught_up(&before);
    let restarted = OrchestrationStore::load_profile().snapshot(None).unwrap();
    assert!(
        restarted
            .messages
            .iter()
            .any(|m| m.body == "Stop and wait."),
        "the message the worker was interrupted for is gone"
    );
    world.svc.chats.test_end(worker);
}

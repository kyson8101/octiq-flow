//! Review of b894867 (P3): H6, H7 and H9, with the profile folder away.
//!
//! * **H6.** The Sandbox panel's Stop answered the profile's sentence and
//!   the started services kept running: it read its state from the profile
//!   and saved before it asked Docker for anything.
//! * **H7.** A Stop on an agent that goes on only in a new process killed
//!   the process, answered an error, and forgot every message queued behind
//!   the stopped turn, with nothing in the record to say so.
//! * **H9.** An answer that reached its agent and could not be saved was
//!   answered `saved: true`, and the page said "Answers saved".
//!
//! Through the real `dispatch` commands, against the stores a server loads
//! from its profile folder. An agent is a live stand-in process; Docker is
//! a stand-in driver (`sandbox::stand_in`), because the suite has no Docker
//! it can run without one. H8 is in `orchestration/raise_tests.rs`.
use super::*;
use crate::dispatch::{dispatch, settle_owed, told, Services, Told};
use crate::profile::tests::Home;
use serde_json::json;
use std::cell::RefCell;

/// A server with its profile folder on a drive of its own.
struct World {
    svc: Services,
    /// `chat_send` reads the roster, whose path is one global in tests.
    _roster: crate::team::TestTeamPath,
    _process: crate::profile::Started,
    home: Home,
}

impl World {
    fn new() -> Self {
        let home = Home::with_a_configured_base();
        let process = crate::profile::started_in(&home.dir);
        let roster = crate::team::use_test_path(crate::profile::profile_dir().join("team.json"));
        let svc = Services::at_profile();
        Self {
            svc,
            _roster: roster,
            _process: process,
            home,
        }
    }

    /// The drive drops. Answers the sentence every save now fails with.
    fn folder_goes(&self) -> String {
        self.home.move_away();
        crate::profile::available().expect_err("the profile folder is away")
    }

    fn folder_returns(&self) {
        self.home.move_back();
        crate::profile::available().expect("the profile folder is back");
    }

    fn chats(&self) -> &Arc<ChatManager> {
        &self.svc.chats
    }

    /// A stand-in for `agent` in the middle of a turn, with the start
    /// settings a launch remembers.
    fn working(&self, key: &str, agent: ChatAgent) -> TestChild {
        self.chats().test_start_at(key, agent, Access::Read);
        self.chats().test_hold(key, agent, true)
    }

    /// `working`, with what the stand-in is written kept to be read.
    fn working_heard(&self, key: &str, agent: ChatAgent) -> (TestChild, BufReader<ChildStdout>) {
        self.chats().test_start_at(key, agent, Access::Read);
        self.chats().test_hold_heard(key, agent, true)
    }

    /// Send each of `texts` through the real `chat_send` while the agent is
    /// in a turn, so each waits in the host's queue with its own record.
    /// A line that starts with `/` is never folded into the one before it,
    /// which keeps three sends three units. Answers their turn ids.
    fn queue(&self, key: &str, texts: &[&str]) -> Vec<String> {
        let ids: Vec<String> = texts
            .iter()
            .map(|_| format!("user-{}", uuid::Uuid::new_v4()))
            .collect();
        for (text, id) in texts.iter().zip(&ids) {
            let sent = told(
                &self.svc,
                "chat_send",
                json!({ "key": key, "text": text, "turnId": id }),
            );
            assert_eq!(sent.result, Ok(Value::Null), "{text} was not queued");
        }
        assert_eq!(
            self.queued(key),
            ids,
            "each send waits as a unit of its own"
        );
        ids
    }

    fn queue_state(&self, key: &str) -> Value {
        dispatch(&self.svc, "chat_queue_state", json!({ "key": key })).unwrap()
    }

    /// The turn ids waiting in the host's queue, first to go first.
    fn queued(&self, key: &str) -> Vec<String> {
        serde_json::from_value(self.queue_state(key)["queuedTurnIds"].clone()).unwrap()
    }

    /// What the host does when the folder is back (`start_waiting_queues`),
    /// with the start of a new process recorded instead of made.
    fn start_waiting(&self, started: &Started) -> Vec<String> {
        start_waiting_queues_with(self.chats(), |_session, stream, turn| {
            started
                .0
                .borrow_mut()
                .push((stream.to_string(), turn.text.clone()));
            Ok(())
        })
    }
}

/// The messages a new process was started with, as (chat, text).
#[derive(Default)]
struct Started(RefCell<Vec<(String, String)>>);

impl Started {
    fn texts(&self) -> Vec<String> {
        self.0
            .borrow()
            .iter()
            .map(|(_, text)| text.clone())
            .collect()
    }
}

fn fresh(name: &str) -> String {
    format!("chat:p4-{name}-{}", uuid::Uuid::new_v4().simple())
}

/// Every delivery state the chat's record holds for `turn_id`, in order.
fn deliveries(key: &str, turn_id: &str) -> Vec<String> {
    crate::transcript::since(key, 0)
        .iter()
        .filter(|entry| {
            entry.event["type"] == "octiq_user_turn_delivery"
                && entry.event["uuid"].as_str() == Some(turn_id)
        })
        .filter_map(|entry| entry.event["state"].as_str().map(str::to_string))
        .collect()
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

/// The Stop answered as a Stop: stopped, how many messages wait, and why
/// the next one did not start.
#[track_caller]
fn stopped_with_messages_waiting(told: &Told, waiting: usize, why: &str) {
    let answer = told
        .result
        .clone()
        .expect("a Stop that stopped the agent is not an error");
    assert_eq!(answer["stopped"], true, "{answer}");
    assert_eq!(answer["waiting"], waiting, "{answer}");
    assert_eq!(answer["notStarted"], why, "{answer}");
}

/// Nothing was forgotten: every message is still queued, in `order`, the
/// chat says why it waits, and no record calls any of them failed.
#[track_caller]
fn still_queued(world: &World, key: &str, order: &[String], why: &str) {
    assert_eq!(world.queued(key), order, "the queue is not what it was");
    let state = world.queue_state(key);
    assert_eq!(state["held"], why, "{state}");
    assert!(!world.chats().handoffs.lock().unwrap().contains(key));
}

// ---- H7: a Stop keeps what was queued ------------------------------------

/// The reviewer's probe, with the messages queued through `chat_send`. An
/// agent that goes on only in a new process (Antigravity) is stopped by
/// ending it, and the first queued message starts in the next process: a
/// start, which the missing folder refuses. The Stop still stopped, the
/// three messages still wait in their order, and once the folder is back
/// the host starts the first itself, as that provider's Stop always does.
#[test]
fn a_stop_keeps_every_queued_message_when_the_next_process_cannot_start() {
    let world = World::new();
    let key = fresh("queue");
    let agent = world.working(&key, ChatAgent::Antigravity);
    let ids = world.queue(&key, &["first thing", "/second", "third thing"]);

    let why = world.folder_goes();
    let stopped = told(&world.svc, "chat_interrupt", json!({ "key": key }));
    stopped_with_messages_waiting(&stopped, 3, &why);
    assert!(agent.gone(), "the agent is still running after Stop");
    assert!(!world.chats().has_process(&key));
    still_queued(&world, &key, &ids, &why);
    assert_eq!(world.queue_state(&key)["live"], false);

    // Still away: nothing starts, nothing is forgotten, no folder is made.
    let started = Started::default();
    assert_eq!(world.start_waiting(&started), [key.clone()]);
    assert!(started.texts().is_empty());
    still_queued(&world, &key, &ids, &why);
    assert!(!world.home.profile().exists(), "the folder was made again");

    world.folder_returns();
    for id in &ids {
        assert_eq!(
            deliveries(&key, id),
            ["queued"],
            "a message that was never sent is on record as something else"
        );
    }
    assert!(world.start_waiting(&started).is_empty());
    assert_eq!(started.texts(), ["first thing"], "the first one starts");
    assert_eq!(world.queued(&key), ids[1..], "the rest wait behind it");
    assert_eq!(world.queue_state(&key)["held"], Value::Null);
}

/// "Send this one now" on the same kind of agent: the turn in flight is
/// stopped, the chosen message is first in line, and with the folder away
/// it waits there with the others behind it.
#[test]
fn send_this_one_now_keeps_the_queue_when_the_next_process_cannot_start() {
    let world = World::new();
    let key = fresh("send-now");
    let agent = world.working(&key, ChatAgent::Antigravity);
    let ids = world.queue(&key, &["first thing", "/second", "third thing"]);
    let chosen = [ids[2].clone(), ids[0].clone(), ids[1].clone()];

    let why = world.folder_goes();
    let now = told(
        &world.svc,
        "chat_start_queued",
        json!({ "key": key, "turnId": ids[2] }),
    );
    assert_eq!(now.result, Ok(json!(true)), "the turn ahead was stopped");
    assert!(agent.gone(), "the agent is still running");
    still_queued(&world, &key, &chosen, &why);

    world.folder_returns();
    let started = Started::default();
    assert!(world.start_waiting(&started).is_empty());
    assert_eq!(started.texts(), ["third thing"]);
    assert_eq!(world.queued(&key), chosen[1..]);
}

/// The carry-over a command-line agent's reaper makes when its process
/// exits with a message waiting: taken off the queue, marked as handed
/// over, started in a new process. With the folder away the start is
/// refused, and the message goes back where it was.
#[test]
fn a_reapers_carry_over_puts_the_message_back_when_the_next_process_cannot_start() {
    let world = World::new();
    let key = fresh("reaper");
    let agent = world.working(&key, ChatAgent::Pi);
    let ids = world.queue(&key, &["first thing", "/second"]);

    let why = world.folder_goes();
    // What the reaper does under the session table once the process is gone.
    let turn = {
        let mut sessions = world.chats().sessions.lock().unwrap();
        let session = sessions.remove(&key).unwrap();
        let _ = session.lock().unwrap().child.kill();
        let turn = world.chats().take_queued_turn(&key).unwrap();
        world.chats().handoffs.lock().unwrap().insert(key.clone());
        turn
    };
    assert!(agent.gone());
    let _ = start_queued_command_turn(world.chats().clone(), &key, &key, turn);
    still_queued(&world, &key, &ids, &why);

    world.folder_returns();
    let started = Started::default();
    assert!(world.start_waiting(&started).is_empty());
    assert_eq!(started.texts(), ["first thing"]);
}

/// Claude and Codex keep their process across a Stop: the next queued
/// message is written to it on the stopped turn's own full stop. That is a
/// new turn, and like every new turn it waits for a folder its record can
/// be kept in: nothing is written to the agent, the queue is whole, and
/// the first message is handed over once the folder is back.
#[test]
fn a_stop_holds_the_queue_of_an_agent_that_keeps_its_process() {
    for agent in [ChatAgent::Claude, ChatAgent::Codex] {
        let world = World::new();
        let key = fresh("persistent");
        let (child, mut heard) = world.working_heard(&key, agent);
        if agent == ChatAgent::Codex {
            world.chats().test_as_codex_thread(&key, Access::Read);
        }
        let ids = world.queue(&key, &["first thing", "/second"]);

        let why = world.folder_goes();
        let stopped = told(&world.svc, "chat_interrupt", json!({ "key": key }));
        stopped_with_messages_waiting(&stopped, 2, &why);
        assert!(child.alive(), "{agent:?} keeps its process across a Stop");

        // The stopped turn's own full stop, as the reader ends it.
        let session = world.chats().sessions.lock().unwrap().get(&key).cloned();
        let session = session.unwrap();
        let (_, refused) = end_turn_locked(
            world.chats(),
            &key,
            &key,
            &mut session.lock().unwrap(),
            false,
        );
        assert_eq!(refused, None, "a message that waits was not refused");
        assert!(
            !world.chats().turn_in_flight(&key),
            "{agent:?} was given a turn whose record cannot be kept"
        );
        still_queued(&world, &key, &ids, &why);

        world.folder_returns();
        let started = Started::default();
        assert!(world.start_waiting(&started).is_empty());
        assert!(started.texts().is_empty(), "no new process: it has one");
        assert!(
            world.chats().turn_in_flight(&key),
            "nothing was handed over"
        );
        assert_eq!(world.queued(&key), ids[1..]);
        assert_eq!(deliveries(&key, &ids[0]), ["queued", "dispatched"]);
        // Everything the agent was written, in order: the Stop (Codex has
        // no turn to interrupt between two), then the first message.
        drop(session);
        world.chats().test_end(&key);
        let written: Vec<String> = (&mut heard).lines().map_while(Result::ok).collect();
        let prompts: Vec<&String> = written
            .iter()
            .filter(|line| line.contains("first thing") || line.contains("/second"))
            .collect();
        assert_eq!(prompts.len(), 1, "{written:?}");
        assert!(prompts[0].contains("first thing"), "{written:?}");
    }
}

/// An agent that does not honour a Stop has its process ended when the
/// grace is over, and the queue's first message starts in the next one.
/// With the folder away that start is refused, and the queue is kept.
#[test]
fn a_stop_that_is_not_honoured_keeps_the_queue_when_the_next_process_cannot_start() {
    let world = World::new();
    let key = fresh("grace");
    let agent = world.working(&key, ChatAgent::Claude);
    let ids = world.queue(&key, &["first thing", "/second"]);

    let why = world.folder_goes();
    let stopped = told(&world.svc, "chat_interrupt", json!({ "key": key }));
    stopped_with_messages_waiting(&stopped, 2, &why);
    let session = world.chats().sessions.lock().unwrap().get(&key).cloned();
    let session = session.unwrap();
    let CutOff::Owed(unwind) = session.lock().unwrap().cut_off else {
        panic!("the Stop left no full stop owed");
    };
    assert!(grace_ran_out(world.chats(), &key, &key, &session, unwind));
    assert!(agent.gone(), "the agent that did not stop is still running");
    still_queued(&world, &key, &ids, &why);

    world.folder_returns();
    let started = Started::default();
    assert!(world.start_waiting(&started).is_empty());
    assert_eq!(started.texts(), ["first thing"]);
    assert_eq!(world.queued(&key), ids[1..]);
}

/// Stopping the CHAT (closing it) is the person ending everything that
/// waited on it, so its queue goes, as before. What it must not do is lose
/// the record of that: the messages are said as not sent to whoever asked,
/// and the line each bubble reads as "not sent" is written once the folder
/// is back.
#[test]
fn a_chat_stopped_with_messages_queued_says_they_were_not_sent_once_the_folder_is_back() {
    let world = World::new();
    let key = fresh("closed");
    let agent = world.working(&key, ChatAgent::Claude);
    let ids = world.queue(&key, &["first thing", "/second"]);

    let why = world.folder_goes();
    let stopped = told(&world.svc, "chat_stop", json!({ "key": key }));
    assert_eq!(stopped.result, Ok(Value::Null));
    assert!(agent.gone());
    assert!(
        world.queued(&key).is_empty(),
        "a closed chat keeps no queue"
    );
    not_recorded(&stopped, "the messages that were not sent", &why);
    assert!(settle_owed(&world.svc).contains(&"unsent messages"));

    world.folder_returns();
    assert_eq!(deliveries(&key, &ids[0]), ["queued"]);
    assert!(settle_owed(&world.svc).is_empty());
    for id in &ids {
        assert_eq!(deliveries(&key, id), ["queued", "failed"]);
    }
}

// ---- H6: the Sandbox panel's Stop ----------------------------------------

/// A chat's sandbox as a start leaves it: enabled, frozen, ready.
fn started_sandbox(world: &World, key: &str) -> crate::sandbox::Environment {
    let project = world.home.dir.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let sandboxes = crate::sandbox::Store::profile();
    sandboxes
        .select(key, project.to_str().unwrap(), Some(true), false)
        .unwrap();
    sandboxes.start_for_test(key)
}

/// What the sandbox state file says of `key`.
fn sandbox_on_disk(key: &str) -> Value {
    let path = crate::profile::profile_dir()
        .join("sandboxes")
        .join("state.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    saved["environments"][key].clone()
}

/// The reviewer's probe: a started sandbox, the folder away, Stop from the
/// panel. Docker is asked to take that project down, the answer is the
/// stopped environment, and the record follows when the folder is back.
#[test]
fn the_sandbox_panels_stop_takes_the_services_down_while_the_profile_is_away() {
    let world = World::new();
    let key = fresh("sandbox");
    let env = started_sandbox(&world, &key);
    let (_docker, asked) = crate::sandbox::stand_in::recording();

    let why = world.folder_goes();
    let stopped = told(
        &world.svc,
        "sandbox_action",
        json!({ "key": key, "action": "stop" }),
    );
    let answer = stopped
        .result
        .clone()
        .expect("a Stop that reached Docker is not an error");
    assert_eq!(
        crate::sandbox::stand_in::taken_down(&asked),
        [env.id.clone()],
        "Docker was not asked to take the services down"
    );
    assert_eq!(answer["state"], "stopped", "{answer}");
    assert_eq!(answer["stopped"]["by"], "person", "{answer}");
    not_recorded(&stopped, "the stopped sandbox", &why);
    let status = dispatch(&world.svc, "profile_status", json!({})).unwrap();
    assert_eq!(status["owed"], json!(["sandboxes"]), "{status}");
    assert_eq!(settle_owed(&world.svc), ["sandboxes"]);
    assert!(!world.home.profile().exists(), "the folder was made again");

    world.folder_returns();
    assert_eq!(
        sandbox_on_disk(&key)["state"],
        "ready",
        "the state file was written while its folder was away"
    );
    assert!(settle_owed(&world.svc).is_empty());
    let saved = sandbox_on_disk(&key);
    assert_eq!(saved["state"], "stopped", "{saved}");
    assert_eq!(saved["stopped"]["by"], "person", "{saved}");
    // And every later read agrees with the file.
    let read = crate::sandbox::Store::profile().snapshot().unwrap();
    assert_eq!(read.environments[&key].state, "stopped");
}

/// Starting is not stopping: a start makes services and writes what it
/// made, so it is refused while the folder is away, and nothing is asked
/// of Docker.
#[test]
fn a_sandbox_start_is_still_refused_while_the_profile_is_away() {
    let world = World::new();
    let key = fresh("sandbox-start");
    started_sandbox(&world, &key);
    let (_docker, asked) = crate::sandbox::stand_in::recording();

    let why = world.folder_goes();
    for action in ["start", "check"] {
        let refused = told(
            &world.svc,
            "sandbox_action",
            json!({ "key": key, "action": action }),
        );
        assert_eq!(refused.result, Err(why.clone()), "{action}");
        assert!(refused.unsaved.is_empty(), "{:?}", refused.unsaved);
    }
    assert!(asked.borrow().is_empty(), "{:?}", asked.borrow());
    world.folder_returns();
    assert_eq!(sandbox_on_disk(&key)["state"], "ready");
}

// ---- H9: an answer that was delivered and not saved ----------------------

/// A batch answered while the folder is away reaches the tool waiting for
/// it. The reply says exactly that: delivered, not saved, and why. What
/// the page reads back for the card says the same.
#[tokio::test]
async fn an_answer_that_could_not_be_saved_is_not_answered_as_saved() {
    let world = World::new();
    let key = fresh("answer");
    world
        .chats()
        .test_start_at(&key, ChatAgent::Claude, Access::Read);
    let (id, mut waiter) = world
        .chats()
        .questions
        .insert(
            QuestionOrigin {
                chat_key: key.clone(),
                session_key: key.clone(),
                launch_id: "test-launch".into(),
                start: StartContext::for_test(ChatAgent::Claude, Some("native-session")),
            },
            vec![serde_json::from_value(json!({ "question": "Which store?" })).unwrap()],
        )
        .unwrap();
    let asked = world.chats().questions.pending().unwrap();
    let question = asked[0].id.clone();

    let why = world.folder_goes();
    let answered = told(
        &world.svc,
        "question_answer_batch",
        json!({ "answers": [{ "id": question, "answer": "SQLite" }] }),
    );
    let receipt = answered.result.clone().expect("the answer was taken");
    assert_eq!(
        receipt,
        json!({ "saved": false, "delivered": true, "unsaved": why }),
        "an answer that is not on disk was answered as saved"
    );
    not_recorded(&answered, "the answer", &why);
    assert!(
        waiter.try_recv().is_ok(),
        "the tool waiting for the answer was not told"
    );
    // The card as a reloaded page reads it: answered, and not saved.
    let pending = dispatch(&world.svc, "question_pending", json!({})).unwrap();
    assert_eq!(pending[0]["answer"], "SQLite", "{pending}");
    assert_eq!(pending[0]["status"], "delivered", "{pending}");
    assert_eq!(pending[0]["unsaved"], why, "{pending}");

    world.folder_returns();
    assert!(settle_owed(&world.svc).is_empty());
    let pending = dispatch(&world.svc, "question_pending", json!({})).unwrap();
    assert_eq!(pending[0]["status"], "saved", "{pending}");
    assert_eq!(pending[0]["unsaved"], Value::Null, "{pending}");
    let _ = id;
}

/// With the folder there the receipt is what it always was.
#[tokio::test]
async fn an_answer_that_was_saved_is_answered_as_saved() {
    let world = World::new();
    let key = fresh("answer-saved");
    let (_id, _waiter) = world
        .chats()
        .questions
        .insert(
            QuestionOrigin {
                chat_key: key.clone(),
                session_key: key.clone(),
                launch_id: "test-launch".into(),
                start: StartContext::for_test(ChatAgent::Claude, Some("native-session")),
            },
            vec![serde_json::from_value(json!({ "question": "Which store?" })).unwrap()],
        )
        .unwrap();
    let question = world.chats().questions.pending().unwrap()[0].id.clone();
    let answered = told(
        &world.svc,
        "question_answer_batch",
        json!({ "answers": [{ "id": question, "answer": "SQLite" }] }),
    );
    assert_eq!(answered.result, Ok(json!({ "saved": true })));
    assert!(answered.unsaved.is_empty(), "{:?}", answered.unsaved);
}

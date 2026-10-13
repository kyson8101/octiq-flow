//! A chat's plan through the commands the page and the agent's hook reach
//! (`chat_plan_get`, `chat_plan_update`, `chat_plan_start`): what each
//! answers, the one event, and the Start that only the person presses.
//!
//! The first test also answers three of the page's fixtures in
//! `web/src/lib/__fixtures__/host` (its README names each): run with
//! `OCTIQ_RECORD_FACTS=1` and `--nocapture` and it prints each answer it
//! asserted on as a `FACT <name> {…}` line.

use super::*;
use crate::chat_plan::{NOT_STARTED, START_TURN_PREFIX};

/// A chat the index lists, with its plan and record removed again when the
/// test ends.
struct Chat {
    id: String,
    key: String,
}

impl Chat {
    fn new() -> Self {
        let id = format!("dispatch-plan-{}", uuid::Uuid::new_v4().simple());
        crate::chat_index::upsert(
            serde_json::from_value(json!({ "id": id, "projectId": "p1", "updatedAt": 100 }))
                .unwrap(),
        )
        .unwrap();
        Self {
            key: format!("chat:{id}"),
            id,
        }
    }

    fn get(&self, svc: &Services) -> Value {
        dispatch(svc, "chat_plan_get", json!({ "chatId": self.id })).unwrap()
    }

    fn change(&self, svc: &Services, change: Value) -> Result<Value, String> {
        dispatch(
            svc,
            "chat_plan_update",
            json!({ "chatId": self.id, "change": change }),
        )
    }

    fn start(&self, svc: &Services, args: Value) -> Result<Value, String> {
        let mut args = args;
        args["chatId"] = json!(self.id);
        dispatch(svc, "chat_plan_start", args)
    }

    /// The turn ids waiting in the host's queue for this chat's agent.
    fn queued(&self, svc: &Services) -> Vec<String> {
        let state = dispatch(svc, "chat_queue_state", json!({ "key": self.key })).unwrap();
        state["queuedTurnIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap().to_string())
            .collect()
    }

    /// The host's turns in this chat's record, as `(turn id, words)`.
    fn turns(&self) -> Vec<(String, String)> {
        crate::transcript::since(&self.key, 0)
            .iter()
            .filter(|line| line.event["octiq_user_turn"] == true)
            .map(|line| {
                (
                    line.event["uuid"].as_str().unwrap_or_default().to_string(),
                    line.event["message"]["content"][0]["text"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                )
            })
            .collect()
    }
}

impl Drop for Chat {
    fn drop(&mut self) {
        crate::chat_plan::forget(&self.id);
        let _ = crate::chat_index::remove(&self.id);
        crate::transcript::forget(&self.key);
    }
}

/// Print what a fixture is recorded from, when asked to.
fn fact(name: &str, answer: &Value) {
    if std::env::var_os("OCTIQ_RECORD_FACTS").is_some() {
        println!("FACT {name} {answer}");
    }
}

/// The `chat-plan` events heard for a chat, as the plans they carried.
fn plans_heard(tap: &crate::bus::tap::Tap) -> Vec<Value> {
    tap.heard()
        .into_iter()
        .filter(|(event, _)| event == "chat-plan")
        .map(|(_, payload)| payload)
        .collect()
}

#[test]
fn the_page_reads_a_plan_as_the_agent_keeps_it_and_hears_every_change() {
    let svc = Services::load();
    let chat = Chat::new();
    let tap = crate::bus::tap::Tap::on(&chat.id);

    // No plan: revision 0, nothing waits, and no stamp is made up.
    let none = chat.get(&svc);
    assert_eq!(
        none,
        json!({ "chatId": chat.id, "revision": 0, "items": [], "awaitsStart": false })
    );
    fact("chat_plan_none", &none);

    // The person sends two things; the agent keeps them, with what is open.
    let first = chat
        .change(
            &svc,
            json!({
                "baseRevision": 0,
                "add": [
                    {
                        "title": "A quieter composer",
                        "decisions": ["Status rows are one line"],
                        "questions": ["Do the rows fold on a phone?", "Which row is first?"],
                    },
                    {
                        "title": "A usage row under the top bar",
                        "questions": ["Desktop only?"],
                        "note": "The person sent a screenshot of the old top bar.",
                    },
                ],
            }),
        )
        .unwrap();
    assert_eq!(first["changed"], true);
    assert_eq!(first["revision"], 1);
    let discussing = chat.get(&svc);
    assert_eq!(discussing["awaitsStart"], true);
    assert_eq!(discussing["updatedBy"], "agent", "no registered agent here");
    assert!(discussing["updatedAt"].as_i64().unwrap() > 0);
    assert!(discussing.get("started").is_none(), "{discussing}");
    assert_eq!(discussing["items"][0]["id"], "i1");
    assert_eq!(discussing["items"][0]["status"], "discussing");
    assert_eq!(
        discussing["items"][0]["questions"],
        json!(["Do the rows fold on a phone?", "Which row is first?"])
    );
    assert_eq!(discussing["items"][1]["tasks"], json!([]));
    assert!(discussing["items"][0].get("progress").is_none());
    // What the change answered is what the page reads, but for its own word.
    let mut answered = first.clone();
    answered.as_object_mut().unwrap().remove("changed");
    assert_eq!(answered, discussing);
    fact("chat_plan_discussing", &discussing);

    // Every question answered: decided, and still not started.
    chat.change(
        &svc,
        json!({
            "baseRevision": 1,
            "update": [
                {
                    "id": "i1", "status": "decided", "questions": [],
                    "decisions": [
                        "Status rows are one line", "They fold on a phone too",
                        "The question row is first",
                    ],
                },
                {
                    "id": "i2", "status": "decided", "questions": [],
                    "decisions": ["Desktop only; a phone keeps the one number"],
                },
            ],
        }),
    )
    .unwrap();
    let decided = chat.get(&svc);
    assert_eq!(decided["revision"], 2);
    assert_eq!(decided["awaitsStart"], true);
    assert_eq!(decided["items"][0]["status"], "decided");
    assert_eq!(decided["items"][0]["changedIn"], 2);
    assert_eq!(decided["items"][0]["addedIn"], 1);
    assert_eq!(decided["items"][1]["questions"], json!([]));
    fact("chat_plan_decided", &decided);

    // One event a change, carrying the plan as the page would read it.
    let heard = plans_heard(&tap);
    assert_eq!(heard.len(), 2);
    assert_eq!(heard[0], json!({ "chatId": chat.id, "plan": discussing }));
    assert_eq!(heard[1]["plan"], decided);
    // A change that asks for what the plan already says is no change.
    let same = chat
        .change(
            &svc,
            json!({ "baseRevision": 2, "update": [{ "id": "i1", "status": "decided" }] }),
        )
        .unwrap();
    assert_eq!(same["changed"], false);
    assert_eq!(same["revision"], 2);
    assert_eq!(plans_heard(&tap).len(), 2);
}

#[test]
fn a_change_is_refused_in_words_and_changes_nothing() {
    let svc = Services::load();
    let chat = Chat::new();
    let tap = crate::bus::tap::Tap::on(&chat.id);
    for (change, words) in [
        (
            json!({ "baseRevision": 0, "add": [{ "title": "A", "remove": true }] }),
            "Those arguments are not valid",
        ),
        (json!(null), "Those arguments are not valid"),
        (
            json!({ "baseRevision": 4, "add": [{ "title": "A" }] }),
            "The plan is at revision 0",
        ),
        (
            json!({ "baseRevision": 0, "add": [{ "title": "x".repeat(121) }] }),
            "A title can be 120 characters at most",
        ),
        // A task nobody made, or one the ledger does not give this chat.
        (
            json!({ "baseRevision": 0, "add": [{ "title": "A", "tasks": ["task_nobody_made"] }] }),
            "task_nobody_made is not a task in the ledger",
        ),
    ] {
        let why = chat.change(&svc, change).unwrap_err();
        assert!(why.contains(words), "{words}: {why}");
        assert_eq!(chat.get(&svc)["revision"], 0, "{words}");
    }
    assert!(plans_heard(&tap).is_empty());
}

/// Start is recorded first. When the turn that tells the agent cannot be
/// handed over, the Start stands and the answer says so beside it; the
/// page asks again, under the Start's own turn id, and the Start itself
/// (when, on which revision) is recorded once. A turn the person takes
/// back is told again under the next id.
#[test]
fn start_is_recorded_first_and_a_turn_that_was_not_handed_over_is_asked_again() {
    let svc = Services::load();
    let chat = Chat::new();
    let gate = || crate::chat_plan::gate(&chat.key);

    // Nothing to start.
    let none = chat.start(&svc, json!({ "revision": 0 })).unwrap_err();
    assert_eq!(none, "This chat has no plan to start.");

    chat.change(
        &svc,
        json!({ "baseRevision": 0, "add": [{ "title": "A", "status": "decided" }] }),
    )
    .unwrap();
    assert!(gate().unwrap_err().starts_with(NOT_STARTED));
    let tap = crate::bus::tap::Tap::on(&chat.id);

    // The person saw revision 0, or one the plan never had.
    for revision in [0, 7] {
        let stale = chat
            .start(&svc, json!({ "revision": revision }))
            .unwrap_err();
        assert!(stale.contains("is at revision 1"), "{stale}");
    }
    // No process and nothing to start one with: the page asks again with
    // `start`, and nothing was recorded.
    let idle = chat.start(&svc, json!({ "revision": 1 })).unwrap_err();
    assert_eq!(idle, format!("chat '{}' is not running", chat.key));
    assert!(chat.get(&svc).get("started").is_none());
    assert!(gate().is_err());
    assert!(plans_heard(&tap).is_empty());
    assert!(chat.turns().is_empty());

    // With settings that cannot start a chat: the Start is recorded, and
    // what could not be done is said beside it, not as an error.
    let undelivered = chat
        .start(
            &svc,
            json!({ "revision": 1, "start": { "agent": "claude" } }),
        )
        .unwrap();
    assert_eq!(undelivered["delivered"], false);
    assert!(
        undelivered["notDelivered"]
            .as_str()
            .unwrap()
            .contains("cwd"),
        "{undelivered}"
    );
    assert!(undelivered.get("state").is_none(), "{undelivered}");
    let first_turn = undelivered["turnId"].as_str().unwrap().to_string();
    assert!(first_turn.starts_with(START_TURN_PREFIX));
    let started = undelivered["plan"]["started"].clone();
    assert_eq!(started["revision"], 1);
    assert_eq!(started["told"], false);
    assert_eq!(started["turnId"], first_turn.as_str());
    assert_eq!(undelivered["plan"]["awaitsStart"], false);
    assert_eq!(chat.get(&svc)["started"], started);
    assert_eq!(gate(), Ok(()), "the Start stands");
    assert_eq!(plans_heard(&tap).len(), 1);

    // The agent writes on meanwhile: the plan is at revision 2 now.
    chat.change(
        &svc,
        json!({ "baseRevision": 1, "add": [{ "title": "B" }] }),
    )
    .unwrap();

    // The page asks again, with the chat running a turn. The turn waits in
    // the queue; when and on which revision the plan was started is as it
    // was recorded.
    svc.chats.test_launch(&chat.key);
    svc.chats.test_busy(&chat.key, true);
    let again = chat.start(&svc, json!({ "revision": 1 })).unwrap();
    assert_eq!(again["delivered"], true);
    assert_eq!(again["state"], "queued");
    let second_turn = again["turnId"].as_str().unwrap().to_string();
    assert_eq!(
        second_turn, first_turn,
        "a try that left nothing in the record is made again under the Start's own id"
    );
    let told = again["plan"]["started"].clone();
    assert_eq!(told["told"], true);
    assert_eq!(told["turnId"], second_turn.as_str());
    assert_eq!(
        (&told["at"], &told["revision"]),
        (&started["at"], &started["revision"])
    );
    // The host's own words went to the agent, under the host's turn id.
    let plan = crate::chat_plan::get(&chat.id).unwrap().unwrap();
    assert_eq!(
        chat.turns(),
        [(second_turn.clone(), crate::chat_plan::start_message(&plan))]
    );
    assert!(chat.turns()[0].1.contains("at revision 1"));

    // Asked once more, by this page or another tab: the agent has its
    // turn, so nothing is sent and nothing changes.
    let heard = plans_heard(&tap).len();
    let once_more = chat.start(&svc, json!({ "revision": 2 })).unwrap();
    assert_eq!(once_more["delivered"], true);
    assert_eq!(once_more["state"], "told");
    assert_eq!(once_more["turnId"], second_turn.as_str());
    assert_eq!(once_more["plan"]["started"], told);
    assert_eq!(chat.turns().len(), 1);
    assert_eq!(plans_heard(&tap).len(), heard);

    // The ✕ on the queued turn takes the turn back, not the Start: when
    // and on which revision it was started stands, the gate stays open,
    // and the plan stops saying its agent was told, which every page hears.
    assert_eq!(
        dispatch(
            &svc,
            "chat_cancel_queued",
            json!({ "key": chat.key, "turnId": second_turn }),
        ),
        Ok(json!(true))
    );
    let taken_back = chat.get(&svc)["started"].clone();
    assert_eq!(taken_back["told"], false);
    assert_eq!(
        (
            &taken_back["at"],
            &taken_back["revision"],
            &taken_back["turnId"]
        ),
        (&told["at"], &told["revision"], &told["turnId"])
    );
    assert_eq!(gate(), Ok(()));
    let said = plans_heard(&tap);
    assert_eq!(said.len(), heard + 1);
    assert_eq!(said.last().unwrap()["plan"]["started"]["told"], false);

    // So the page can ask again, and that is a new try: the turn that was
    // taken back keeps its id with the line that says so, and the next one
    // has the next id. One turn is in the queue.
    let retried = chat.start(&svc, json!({ "revision": 2 })).unwrap();
    assert_eq!(retried["delivered"], true);
    assert_eq!(retried["state"], "queued");
    let third_turn = format!("{second_turn}-try2");
    assert_eq!(retried["turnId"], third_turn.as_str());
    assert_eq!(retried["plan"]["started"]["told"], true);
    assert_eq!(retried["plan"]["started"]["turnId"], third_turn.as_str());
    assert_eq!(retried["plan"]["started"]["at"], told["at"]);
    let ids: Vec<String> = chat.turns().into_iter().map(|(id, _)| id).collect();
    assert_eq!(ids, [second_turn.clone(), third_turn.clone()]);
    assert_eq!(chat.queued(&svc), [third_turn.clone()]);
    // Taking back a turn that is not the one the plan names changes nothing.
    assert_eq!(
        crate::chat_plan::untold(&chat.id, &second_turn),
        Ok(None),
        "the first try is long over"
    );
    assert_eq!(chat.get(&svc)["started"]["told"], true);
    svc.chats.test_end(&chat.key);
}

/// A plan that was started and whose agent has not been told, in a chat
/// whose agent is in the middle of a turn: what an ask that follows meets.
/// Answers the chat and the Start's turn id.
fn started_and_untold(svc: &Services) -> (Chat, String) {
    let chat = Chat::new();
    chat.change(
        svc,
        json!({ "baseRevision": 0, "add": [{ "title": "A", "status": "decided" }] }),
    )
    .unwrap();
    let first = chat
        .start(
            svc,
            json!({ "revision": 1, "start": { "agent": "claude" } }),
        )
        .unwrap();
    assert_eq!(first["delivered"], false);
    assert!(chat.turns().is_empty());
    svc.chats.test_launch(&chat.key);
    svc.chats.test_busy(&chat.key, true);
    let turn = first["turnId"].as_str().unwrap().to_string();
    (chat, turn)
}

/// Two asks at once, each of which has read that the agent was not told
/// before either hands anything over (the reviewer's probe: both are held
/// at the session table, then let go together). One turn is queued and
/// recorded, under the Start's own id, and both answers name it. There
/// used to be two, under two fresh ids.
#[test]
fn two_asks_at_once_tell_the_agent_once() {
    let svc = Arc::new(Services::load());
    let (chat, turn) = started_and_untold(&svc);
    let table = svc.chats.test_hold_table();
    let asks: Vec<_> = (0..2)
        .map(|_| {
            let (svc, id) = (svc.clone(), chat.id.clone());
            std::thread::spawn(move || {
                dispatch(
                    &svc,
                    "chat_plan_start",
                    json!({ "chatId": id, "revision": 1 }),
                )
                .unwrap()
            })
        })
        .collect();
    std::thread::sleep(std::time::Duration::from_millis(250));
    drop(table);
    let answers: Vec<Value> = asks.into_iter().map(|ask| ask.join().unwrap()).collect();

    let ids: Vec<String> = chat.turns().into_iter().map(|(id, _)| id).collect();
    assert_eq!(ids, [turn.clone()], "one Start, one turn: {answers:?}");
    assert_eq!(chat.queued(&svc), [turn.clone()]);
    let mut states = Vec::new();
    for answer in &answers {
        assert_eq!(answer["delivered"], true, "{answer}");
        assert_eq!(answer["turnId"], turn.as_str(), "{answer}");
        assert_eq!(answer["plan"]["started"]["told"], true, "{answer}");
        states.push(answer["state"].as_str().unwrap().to_string());
    }
    states.sort();
    assert_eq!(
        states,
        ["queued", "told"],
        "one handed it over, one found it"
    );
    svc.chats.test_end(&chat.key);
}

/// The same under load, for a claim that has to hold every time: many
/// rounds, six asks let go together in each. Half the rounds are asks of a
/// started plan whose agent was not told, half are the first Start itself
/// pressed in six tabs at once; in half the agent is in a turn (the turn is
/// queued) and in half it is between turns (the turn is written to it).
/// Every round ends with one Start on record and one turn.
#[test]
fn a_start_is_told_once_however_many_ask_at_once() {
    const ROUNDS: usize = 40;
    const ASKS: usize = 6;
    let svc = Arc::new(Services::load());
    for round in 0..ROUNDS {
        let (again, busy) = (round % 2 == 0, round % 4 < 2);
        let chat = Chat::new();
        chat.change(
            &svc,
            json!({ "baseRevision": 0, "add": [{ "title": "A", "status": "decided" }] }),
        )
        .unwrap();
        if again {
            let first = chat
                .start(
                    &svc,
                    json!({ "revision": 1, "start": { "agent": "claude" } }),
                )
                .unwrap();
            assert_eq!(first["delivered"], false);
        }
        let _agent = svc
            .chats
            .test_hold(&chat.key, crate::agent_chat::ChatAgent::Claude, busy);
        let together = Arc::new(std::sync::Barrier::new(ASKS));
        let asks: Vec<_> = (0..ASKS)
            .map(|_| {
                let (svc, id, together) = (svc.clone(), chat.id.clone(), together.clone());
                std::thread::spawn(move || {
                    together.wait();
                    dispatch(
                        &svc,
                        "chat_plan_start",
                        json!({ "chatId": id, "revision": 1 }),
                    )
                })
            })
            .collect();
        let answers: Vec<Value> = asks
            .into_iter()
            .map(|ask| ask.join().unwrap().unwrap())
            .collect();
        let said = format!("round {round} (again {again}, busy {busy}): {answers:?}");
        let turns = chat.turns();
        assert_eq!(turns.len(), 1, "{said}");
        let handed = answers
            .iter()
            .filter(|answer| answer["state"] != "told")
            .count();
        assert_eq!(handed, 1, "one ask hands it over: {said}");
        for answer in &answers {
            assert_eq!(answer["delivered"], true, "{said}");
            assert_eq!(answer["turnId"], turns[0].0.as_str(), "{said}");
            assert_eq!(answer["plan"]["started"]["told"], true, "{said}");
        }
        let kept = chat.get(&svc)["started"].clone();
        assert_eq!(kept["turnId"], turns[0].0.as_str(), "{said}");
        assert_eq!(kept["told"], true, "{said}");
        svc.chats.test_end(&chat.key);
    }
}

/// Review 3 of the UI batch, H2, on the host's side: the page can send the
/// FIRST `chat_plan_start` twice (the Plan panel shut and opened again
/// while the first is unanswered), so two arrive for a plan nothing has
/// started, with the same chat and revision. Over 300 rounds, two let go
/// together each time, with the agent in a turn in half of them and
/// between turns in the other half:
///
/// - one Start is on record: when, on which revision and under which turn
///   id are the same in both answers and in the plan that is read back;
/// - one turn is in the chat's record, and one ask handed it over (`queued`
///   behind a running turn, `started` when it was written to an idle agent);
/// - the other answers with the Start that stands, `told`, never an error
///   and never a second turn.
///
/// What holds it is the claim `chat_plan::telling`, taken before the plan
/// is read: the second ask reads a plan the first has already started and
/// told. Without the claim both read "not started", and the loser of
/// `chat_plan::start` was refused with "already started".
#[test]
fn two_first_starts_at_once_record_one_start_and_hand_over_one_turn() {
    const ROUNDS: usize = 300;
    let svc = Arc::new(Services::load());
    for round in 0..ROUNDS {
        let busy = round % 2 == 0;
        let chat = Chat::new();
        chat.change(
            &svc,
            json!({ "baseRevision": 0, "add": [{ "title": "A", "status": "decided" }] }),
        )
        .unwrap();
        assert_eq!(chat.get(&svc)["started"], Value::Null);
        let _agent = svc
            .chats
            .test_hold(&chat.key, crate::agent_chat::ChatAgent::Claude, busy);
        let together = Arc::new(std::sync::Barrier::new(2));
        let asks: Vec<_> = (0..2)
            .map(|_| {
                let (svc, id, together) = (svc.clone(), chat.id.clone(), together.clone());
                std::thread::spawn(move || {
                    together.wait();
                    dispatch(
                        &svc,
                        "chat_plan_start",
                        json!({ "chatId": id, "revision": 1 }),
                    )
                })
            })
            .collect();
        let answers: Vec<Result<Value, String>> =
            asks.into_iter().map(|ask| ask.join().unwrap()).collect();
        let said = format!("round {round} (busy {busy}): {answers:?}");
        let answers: Vec<Value> = answers
            .into_iter()
            .map(|answer| answer.unwrap_or_else(|why| panic!("refused with {why}: {said}")))
            .collect();

        let turns = chat.turns();
        assert_eq!(turns.len(), 1, "one turn in the record: {said}");
        assert!(turns[0].0.starts_with(START_TURN_PREFIX), "{said}");
        let mut states: Vec<&str> = answers
            .iter()
            .map(|answer| answer["state"].as_str().unwrap())
            .collect();
        states.sort_unstable();
        let handed = if busy { "queued" } else { "started" };
        let mut expected = [handed, "told"];
        expected.sort_unstable();
        assert_eq!(states, expected, "{said}");
        if busy {
            assert_eq!(chat.queued(&svc), [turns[0].0.clone()], "{said}");
        }
        let kept = chat.get(&svc)["started"].clone();
        assert_eq!(kept["turnId"], turns[0].0.as_str(), "{said}");
        assert_eq!(kept["revision"], 1, "{said}");
        assert_eq!(kept["told"], true, "{said}");
        for answer in &answers {
            assert_eq!(answer["delivered"], true, "{said}");
            assert_eq!(answer["turnId"], kept["turnId"], "{said}");
            // The Start as it was recorded, once: both answers carry it.
            assert_eq!(answer["plan"]["started"]["at"], kept["at"], "{said}");
            assert_eq!(answer["plan"]["started"]["revision"], 1, "{said}");
        }
        svc.chats.test_end(&chat.key);
    }
}

/// The turn is handed over and the note that it was cannot be saved. The
/// answer says both, and the Start is still told once: the next ask finds
/// the turn in the chat's record, saves the note and sends nothing. It
/// used to read `told: false` and hand over a second turn under a new id.
#[test]
fn a_delivery_whose_note_could_not_be_saved_is_not_made_again() {
    let svc = Services::load();
    let (chat, turn) = started_and_untold(&svc);
    let one_turn = || {
        let ids: Vec<String> = chat.turns().into_iter().map(|(id, _)| id).collect();
        assert_eq!(ids, [turn.clone()]);
        assert_eq!(chat.queued(&svc), [turn.clone()]);
    };

    let first =
        crate::chat_plan::while_writes_fail(|| chat.start(&svc, json!({ "revision": 1 }))).unwrap();
    assert_eq!(first["delivered"], true, "{first}");
    assert_eq!(first["state"], "queued", "{first}");
    assert_eq!(first["turnId"], turn.as_str());
    assert_eq!(
        first["plan"]["started"]["told"], false,
        "the note was not kept"
    );
    assert_eq!(chat.get(&svc)["started"]["told"], false);
    one_turn();

    // Asked again while the note still cannot be saved: nothing is sent,
    // and the answer says the agent has it.
    let (still, said) = crate::unsaved::told(|| {
        crate::chat_plan::while_writes_fail(|| chat.start(&svc, json!({ "revision": 1 })))
    });
    let still = still.unwrap();
    assert_eq!(still["delivered"], true, "{still}");
    assert_eq!(still["state"], "told", "{still}");
    assert_eq!(still["turnId"], turn.as_str());
    assert_eq!(still["plan"]["started"]["told"], false);
    assert_eq!(said.len(), 1, "{said:?}");
    one_turn();

    // And once it can be: the note is saved, and still nothing is sent.
    let tap = crate::bus::tap::Tap::on(&chat.id);
    let second = chat.start(&svc, json!({ "revision": 1 })).unwrap();
    assert_eq!(second["delivered"], true, "{second}");
    assert_eq!(second["state"], "told", "{second}");
    assert_eq!(second["turnId"], turn.as_str());
    assert_eq!(second["plan"]["started"]["told"], true);
    assert_eq!(chat.get(&svc)["started"]["told"], true);
    assert_eq!(plans_heard(&tap).len(), 1, "the pages hear the note");
    one_turn();
    svc.chats.test_end(&chat.key);
}

/// A turn that will not reach the agent is told again, once, and a turn
/// that will is never told twice, across a server that stopped. The
/// host's queue is in memory: a Start turn a server had only queued is
/// lost with it, the record says `queued` and no queue holds it, and the
/// next ask hands over the next try. A turn dropped when its chat's
/// process was ended on purpose is marked not sent, and is told again the
/// same way.
#[test]
fn a_start_turn_that_was_lost_or_not_sent_is_told_again_once() {
    let svc = Services::load();
    let (chat, turn) = started_and_untold(&svc);
    let queued = chat.start(&svc, json!({ "revision": 1 })).unwrap();
    assert_eq!(queued["state"], "queued");
    assert_eq!(queued["plan"]["started"]["told"], true);
    let fates = |svc: &Services| {
        crate::agent_chat::host_turns(&svc.chats, &chat.key, &turn)
            .unwrap()
            .into_iter()
            .collect::<Vec<_>>()
    };
    use crate::agent_chat::HostTurn::{Gone, Handed};
    assert_eq!(fates(&svc), [(turn.clone(), Handed)]);

    // The server stops, and another starts: its queue is empty.
    let restarted = Services::load();
    assert_eq!(
        fates(&restarted),
        [(turn.clone(), Gone)],
        "queued by a server that is gone"
    );
    restarted.chats.test_launch(&chat.key);
    restarted.chats.test_busy(&chat.key, true);
    let again = chat.start(&restarted, json!({ "revision": 1 })).unwrap();
    let second = format!("{turn}-try2");
    assert_eq!(again["delivered"], true, "{again}");
    assert_eq!(again["state"], "queued", "{again}");
    assert_eq!(again["turnId"], second.as_str());
    assert_eq!(again["plan"]["started"]["turnId"], second.as_str());
    assert_eq!(
        again["plan"]["started"]["at"],
        queued["plan"]["started"]["at"]
    );
    assert_eq!(
        fates(&restarted),
        [(turn.clone(), Gone), (second.clone(), Handed)]
    );
    // Asked again: it has it.
    let told = chat.start(&restarted, json!({ "revision": 1 })).unwrap();
    assert_eq!(
        (&told["state"], &told["turnId"]),
        (&json!("told"), &json!(second))
    );
    assert_eq!(chat.turns().len(), 2);

    // Its chat's process is ended on purpose with the turn still queued:
    // the turn is marked not sent, and the plan still says told.
    restarted.chats.test_end(&chat.key);
    assert_eq!(
        fates(&restarted),
        [(turn.clone(), Gone), (second.clone(), Gone)]
    );
    assert_eq!(chat.get(&restarted)["started"]["told"], true);

    // The next try cannot be written to the agent (a stand-in that takes
    // no input). The answer says so, the plan no longer says its agent was
    // told, and that try has left its "not sent" line: it is over too.
    restarted.chats.test_launch(&chat.key);
    let third = format!("{turn}-try3");
    let failed = chat.start(&restarted, json!({ "revision": 1 })).unwrap();
    assert_eq!(failed["delivered"], false, "{failed}");
    assert_eq!(failed["turnId"], third.as_str());
    assert!(failed["notDelivered"].is_string(), "{failed}");
    assert_eq!(failed["plan"]["started"]["told"], false, "{failed}");
    assert_eq!(chat.get(&restarted)["started"]["told"], false);
    assert_eq!(
        fates(&restarted),
        [
            (turn.clone(), Gone),
            (second.clone(), Gone),
            (third.clone(), Gone)
        ]
    );

    // And the one after it is handed over, under the id after that.
    restarted.chats.test_busy(&chat.key, true);
    let fourth = format!("{turn}-try4");
    let handed = chat.start(&restarted, json!({ "revision": 1 })).unwrap();
    assert_eq!(handed["delivered"], true, "{handed}");
    assert_eq!(handed["state"], "queued", "{handed}");
    assert_eq!(handed["turnId"], fourth.as_str());
    let kept = chat.get(&restarted)["started"].clone();
    assert_eq!(
        (&kept["told"], &kept["turnId"]),
        (&json!(true), &json!(fourth))
    );
    assert_eq!(kept["at"], queued["plan"]["started"]["at"], "one Start");
    assert_eq!(chat.queued(&restarted), [fourth.clone()]);
    restarted.chats.test_end(&chat.key);
    svc.chats.test_end(&chat.key);
}

/// The ids of a Start's tries are counted on from its own, and the first
/// is found again from any of them.
#[test]
fn every_try_at_telling_of_a_start_has_an_id_counted_on_from_the_starts_own() {
    use crate::chat_plan::{first_turn_id, next_turn_id};
    let first = crate::chat_plan::start_turn_id();
    assert!(first.starts_with(START_TURN_PREFIX));
    let second = next_turn_id(&first);
    let third = next_turn_id(&second);
    assert_eq!(second, format!("{first}-try2"));
    assert_eq!(third, format!("{first}-try3"));
    for id in [&first, &second, &third] {
        assert_eq!(first_turn_id(id), first);
        assert!(id.starts_with(&first));
    }
    // An id that only looks like a later try is its own first.
    let odd = format!("{START_TURN_PREFIX}one-try");
    assert_eq!(first_turn_id(&odd), odd);
    assert_eq!(next_turn_id(&odd), format!("{odd}-try2"));
}

/// The Start turn waits behind a turn in flight like any message, and is
/// written at once to an agent that is between turns.
#[test]
fn the_start_turn_is_queued_behind_a_running_turn_and_written_to_an_idle_agent() {
    let svc = Services::load();
    for (busy, state) in [(true, "queued"), (false, "started")] {
        let chat = Chat::new();
        chat.change(
            &svc,
            json!({ "baseRevision": 0, "add": [{ "title": "A", "status": "decided" }] }),
        )
        .unwrap();
        let _agent = svc
            .chats
            .test_hold(&chat.key, crate::agent_chat::ChatAgent::Claude, busy);
        let out = chat.start(&svc, json!({ "revision": 1 })).unwrap();
        assert_eq!(out["delivered"], true, "{out}");
        assert_eq!(out["state"], state, "{out}");
        assert_eq!(out["plan"]["started"]["told"], true);
        let turn_id = out["turnId"].as_str().unwrap();
        assert_eq!(chat.turns().len(), 1);
        assert_eq!(chat.turns()[0].0, turn_id);
        // While it waits it is a turn of the queue like any other.
        let queued = dispatch(&svc, "chat_queue_state", json!({ "key": chat.key })).unwrap();
        assert_eq!(
            queued.to_string().contains(turn_id),
            busy,
            "{state}: {queued}"
        );
        svc.chats.test_end(&chat.key);
    }
}

/// Save-first: a Start that cannot be recorded is refused whole. No turn is
/// sent, nothing is announced, and the plan still waits on the person.
#[test]
fn a_start_whose_save_fails_is_refused_and_tells_the_agent_nothing() {
    let svc = Services::load();
    let chat = Chat::new();
    chat.change(
        &svc,
        json!({ "baseRevision": 0, "add": [{ "title": "A", "status": "decided" }] }),
    )
    .unwrap();
    svc.chats.test_launch(&chat.key);
    svc.chats.test_busy(&chat.key, true);
    let tap = crate::bus::tap::Tap::on(&chat.id);
    let refused =
        crate::chat_plan::while_writes_fail(|| chat.start(&svc, json!({ "revision": 1 })));
    assert_eq!(
        refused.unwrap_err(),
        "The plan could not be saved: the disk is full"
    );
    assert!(chat.turns().is_empty(), "the agent was told of a Start");
    assert!(plans_heard(&tap).is_empty());
    let plan = chat.get(&svc);
    assert!(plan.get("started").is_none(), "{plan}");
    assert_eq!(plan["awaitsStart"], true);
    assert!(crate::chat_plan::gate(&chat.key).is_err());
    // The same press goes through once the save can happen.
    let out = chat.start(&svc, json!({ "revision": 1 })).unwrap();
    assert_eq!(out["state"], "queued");
    svc.chats.test_end(&chat.key);
}

/// With the profile folder away a Start is refused in the profile's words
/// before anything is asked of the chat, and a read is an error, never a
/// chat with no plan.
#[test]
fn the_plan_commands_are_refused_in_words_while_the_profile_folder_is_away() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _process = crate::profile::started_in(&home.dir);
    crate::profile_lock::acquire("server").unwrap();
    let svc = Services {
        workspaces: Arc::new(WorkspaceState::with_projects(Vec::new())),
        chats: Arc::new(ChatManager::default()),
        watch: Arc::new(FileWatchState::default()),
        git_watch: Arc::new(GitWatchState::default()),
        orchestrations: Arc::new(OrchestrationStore::default()),
        ptys: Arc::new(PtyManager::default()),
        handovers: crate::handover::Wiring::scratch(),
    };
    let id = format!("plan-away-{}", uuid::Uuid::new_v4().simple());
    let key = format!("chat:{id}");
    let change = |revision: u64| {
        dispatch(
            &svc,
            "chat_plan_update",
            json!({ "chatId": id, "change": { "baseRevision": revision, "add": [{ "title": "A" }] } }),
        )
    };
    change(0).unwrap();
    let kept = dispatch(&svc, "chat_plan_get", json!({ "chatId": id })).unwrap();
    svc.chats.test_launch(&key);

    home.move_away();
    let away = crate::profile::available().unwrap_err();
    assert_eq!(
        dispatch(&svc, "chat_plan_get", json!({ "chatId": id })).unwrap_err(),
        away
    );
    assert_eq!(change(1).unwrap_err(), away);
    assert_eq!(
        dispatch(
            &svc,
            "chat_plan_start",
            json!({ "chatId": id, "revision": 1 })
        )
        .unwrap_err(),
        away
    );
    assert!(
        !crate::profile::profile_dir().exists(),
        "a plan command made the profile folder again"
    );
    home.move_back();
    assert_eq!(
        dispatch(&svc, "chat_plan_get", json!({ "chatId": id })).unwrap(),
        kept,
        "nothing was changed or started meanwhile"
    );
    svc.chats.test_end(&key);
}

/// By what the chat is, like every hook that writes: a worker stays one
/// after its attempt settles, while its capability still works.
#[test]
fn the_chats_that_keep_no_plan_are_refused_by_what_they_are() {
    use crate::orchestration::tests::{run, running_worker, settled_worker};
    let store = OrchestrationStore::default();
    let run = run(&store);
    let dir = crate::test_dir::TestDir::new("plan-refusal");
    let team = dir.0.join("team.json");
    std::fs::write(
        &team,
        r#"{"agents":[],"front_desk_chats":[{"chatKey":"chat:desk","agentId":"a1","sessionIds":[],"createdAt":1}]}"#,
    )
    .unwrap();
    let refusal = |key: &str| plan_chat_refusal_in(&store, &team, key).unwrap();

    let running = running_worker(&store, &run).worker_chat_key;
    let settled = settled_worker(&store, &run, Some("chat:legacy-plan-worker")).worker_chat_key;
    // Settled, and so with no active task: it is still a worker.
    assert!(store.active_task(&settled).unwrap().is_none());
    for key in [running.as_str(), settled.as_str(), "chat:orch-never-seen"] {
        assert!(refusal(key).unwrap().contains("worker"), "{key}");
    }
    assert!(refusal("chat:desk").unwrap().contains("front desk"));
    // An ordinary chat, listed or not yet, and the coordinator of a run.
    let chat = Chat::new();
    assert_eq!(refusal(&chat.key), None);
    assert_eq!(refusal("chat:not-listed-yet"), None);
    assert_eq!(refusal("chat:master"), None);
    // In the trash: nothing of it is changed or started until it is back.
    crate::chat_index::trash(&chat.id, None, None).unwrap();
    assert!(refusal(&chat.key).unwrap().contains("trash"));

    // Through the commands themselves, for a worker's key.
    let svc = Services::load();
    let update = dispatch(
        &svc,
        "chat_plan_update",
        json!({ "chatId": "orch-some-worker", "change": { "baseRevision": 0, "add": [{ "title": "A" }] } }),
    )
    .unwrap_err();
    assert!(update.contains("worker's chat keeps no plan"), "{update}");
    let start = dispatch(
        &svc,
        "chat_plan_start",
        json!({ "chatId": "orch-some-worker", "revision": 0 }),
    )
    .unwrap_err();
    assert_eq!(start, update);
    assert_eq!(crate::chat_plan::get("orch-some-worker"), Ok(None));
}

/// Start is the person's own action, like completing a chat. No hook may
/// call it and the MCP server offers no such tool.
#[test]
fn no_hook_and_no_mcp_tool_can_start_a_plan() {
    for (name, source) in [
        ("web.rs", include_str!("../web.rs")),
        (
            "octiq-ask.cjs",
            include_str!("../../../scripts/mcp/octiq-ask.cjs"),
        ),
    ] {
        assert!(!source.contains("chat_plan_start"), "{name}");
        assert!(!source.contains("plan_start\""), "{name}");
    }
    // The page can ask for it: the command is in the table.
    let svc = Services::load();
    let routed = dispatch(
        &svc,
        "chat_plan_start",
        json!({ "chatId": "no-plan-here", "revision": 0 }),
    )
    .unwrap_err();
    assert_eq!(routed, "This chat has no plan to start.");
}

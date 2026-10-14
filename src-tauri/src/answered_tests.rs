//! Review 3 of the UI batch, H3: the answer to a question an agent asked
//! through its provider's own request left nothing a transcript reader
//! finds. `question-expired` took the question off the page, and after a
//! reload nothing said what was asked or answered.
//!
//! An answer handed over while its call waits now leaves one line in the
//! chat's record, `octiq_question_answered` (`question_store::Record::
//! answered`). These go through the real paths: Codex's request as its
//! app-server sends it, the `ask_user` tool's request, the page's
//! `question_answer_batch` through `dispatch`, a stand-in agent that is
//! written the answer, and the chat's record on disk.
//!
//! Two tests also answer the page's fixtures in
//! `web/src/lib/__fixtures__/host` (its README names each): run with
//! `OCTIQ_RECORD_FACTS=1` and `--nocapture` and each prints the line it
//! asserted on as a `FACT <name> {…}` line.
use super::*;
use crate::dispatch::{dispatch, settle_owed, Services};
use crate::profile::tests::Home;
use crate::question_store::{Answer, QuestionStore, ANSWERED, NOTES_OWED};
use serde_json::json;

/// A chat with nothing of its own left in the scratch profile afterwards.
struct Chat {
    key: String,
}

impl Chat {
    fn new(what: &str) -> Self {
        Self {
            key: format!("chat:answered-{what}-{}", uuid::Uuid::new_v4().simple()),
        }
    }

    /// The answered questions' lines in this chat's record.
    fn lines(&self) -> Vec<Value> {
        crate::transcript::of_type(&self.key, ANSWERED)
    }
}

impl Drop for Chat {
    fn drop(&mut self) {
        // A test may have put a folder where the record goes.
        if let Some(path) = crate::transcript::path_for(&self.key) {
            let _ = std::fs::remove_dir(&path);
        }
        crate::transcript::forget(&self.key);
    }
}

/// Print what a fixture is recorded from, when asked to.
fn fact(name: &str, line: &Value) {
    if std::env::var_os("OCTIQ_RECORD_FACTS").is_some() {
        println!("FACT {name} {line}");
    }
}

/// A Codex stand-in in the middle of a turn, started the way a launch
/// remembers, with everything it is written kept to be read.
fn codex(manager: &ChatManager, key: &str) -> (TestChild, BufReader<ChildStdout>) {
    manager.remember_start(
        key,
        StartContext::for_test(ChatAgent::Codex, Some("thread-1")),
    );
    manager.test_hold_heard(key, ChatAgent::Codex, true)
}

/// Codex asks, the way its app-server does. Answers once the questions are
/// listed for the page, with their ids in order.
async fn asks_natively(svc: &Services, key: &str, questions: Value) -> Vec<String> {
    let session = svc
        .chats
        .sessions
        .lock()
        .unwrap()
        .get(key)
        .cloned()
        .unwrap();
    answer_codex_server_request(
        &svc.chats,
        &session,
        key,
        Some(&tokio::runtime::Handle::current()),
        json!({
            "id": 7,
            "method": "item/tool/requestUserInput",
            "params": { "questions": questions },
        }),
    );
    asked_in(svc, key)
}

/// The ids of the questions listed for `key`, in the order asked.
fn asked_in(svc: &Services, key: &str) -> Vec<String> {
    dispatch(svc, "question_pending", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .filter(|asked| asked["chatKey"] == key)
        .map(|asked| asked["id"].as_str().unwrap().to_string())
        .collect()
}

/// The next line the stand-in was written, as JSON: what the agent got.
async fn written(heard: BufReader<ChildStdout>) -> (Value, BufReader<ChildStdout>) {
    tokio::task::spawn_blocking(move || {
        let mut heard = heard;
        let mut line = String::new();
        heard.read_line(&mut line).expect("the stand-in's stdout");
        (serde_json::from_str(&line).expect("a JSON line"), heard)
    })
    .await
    .unwrap()
}

/// The reviewer's case, on the host's side: Codex asks two questions by
/// itself, the person answers on the page, Codex is given the answers. The
/// chat's record then holds one line with what was asked and what was
/// answered, said before the page is told to stop drawing the question.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_natively_asked_questions_answer_stays_in_the_chats_record() {
    let svc = Services::load();
    let chat = Chat::new("native");
    let (_agent, heard) = codex(&svc.chats, &chat.key);
    let ids = asks_natively(
        &svc,
        &chat.key,
        json!([
            { "id": "branch", "question": "Which branch should this go to?", "options": [
                { "label": "develop", "description": "The base for new work" },
                { "label": "main" },
            ] },
            { "id": "name", "question": "What should the tag be called?" },
        ]),
    )
    .await;
    assert_eq!(ids.len(), 2, "both questions are listed for the page");
    assert!(
        chat.lines().is_empty(),
        "nothing is written before an answer"
    );
    // Everything said from here on that names the first question: the line
    // holds its id, and so does the event that takes it off the page.
    let tap = crate::bus::tap::Tap::on(&ids[0]);

    let receipt = dispatch(
        &svc,
        "question_answer_batch",
        json!({ "answers": [
            { "id": ids[0], "answer": "develop" },
            { "id": ids[1], "answer": "v0.3.11" },
        ] }),
    )
    .unwrap();
    assert_eq!(
        receipt,
        json!({ "saved": true }),
        "the command answers as before"
    );

    // What Codex is written: each answer under the id Codex asked it with.
    let (response, _heard) = written(heard).await;
    assert_eq!(response["id"], 7, "{response}");
    assert_eq!(
        response["result"]["answers"],
        json!({ "branch": { "answers": ["develop"] }, "name": { "answers": ["v0.3.11"] } }),
        "{response}"
    );

    let lines = chat.lines();
    assert_eq!(lines.len(), 1, "one line for the call: {lines:?}");
    let line = &lines[0];
    fact("question_answered_native", line);
    assert_eq!(line["type"], "octiq_question_answered");
    assert_eq!(line["via"], "native");
    assert!(line["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(line["at"].as_i64().is_some_and(|at| at > 0));
    assert_eq!(
        line["questions"],
        json!([
            {
                "id": ids[0],
                "question": "Which branch should this go to?",
                "options": [
                    { "label": "develop", "description": "The base for new work" },
                    { "label": "main" },
                ],
                "multiple": false,
                "answer": "develop",
            },
            {
                "id": ids[1],
                "question": "What should the tag be called?",
                "options": [],
                "multiple": false,
                "answer": "v0.3.11",
            },
        ])
    );

    // The page hears the line, with its place in the record, before it is
    // told the questions are gone: it never has neither to draw.
    let heard: Vec<(String, Value)> = tap
        .heard()
        .into_iter()
        .filter(|(event, payload)| {
            event == "question-expired"
                || (event == "chat-event" && payload["event"]["type"] == ANSWERED)
        })
        .collect();
    let names: Vec<&str> = heard.iter().map(|(event, _)| event.as_str()).collect();
    assert_eq!(names, ["chat-event", "question-expired"], "{heard:?}");
    assert_eq!(heard[0].1["key"], chat.key.as_str());
    assert_eq!(heard[0].1["event"], *line);
    assert!(heard[0].1["seq"].as_u64().is_some(), "{:?}", heard[0].1);
    assert!(
        asked_in(&svc, &chat.key).is_empty(),
        "the questions are closed"
    );

    // A second tab sends the same answers, the page asks again, the host's
    // sweeps run: the record still holds the one line, and the answer is
    // not on its way to the agent a second time as a turn.
    let record = line["id"].as_str().unwrap();
    for _ in 0..3 {
        let _ = dispatch(
            &svc,
            "question_answer_batch",
            json!({ "answers": [
                { "id": ids[0], "answer": "develop" },
                { "id": ids[1], "answer": "v0.3.11" },
            ] }),
        );
        assert!(!settle_owed(&svc).contains(&NOTES_OWED));
        let outbox = svc.chats.questions.outbox().unwrap();
        assert!(outbox.iter().all(|waiting| waiting.id != record));
    }
    assert_eq!(chat.lines().len(), 1);
    assert!(svc.chats.questions.take_native(record).unwrap().is_none());
    assert!(svc.chats.questions.take_tool(record).unwrap().is_none());
    assert_eq!(chat.lines().len(), 1, "a hand-over is made once");
    svc.chats.test_end(&chat.key);
}

/// The same for the `ask_user` tool answered while its call waits: the host
/// cannot know whether the page holds that call, so the line is written for
/// it too, and says which way the answer went (`via`). The recommended
/// option and a question that takes several are kept as they were asked.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_question_answered_while_its_call_waits_leaves_the_same_line() {
    let svc = Services::load();
    let chat = Chat::new("tool");
    svc.chats.remember_start(
        &chat.key,
        StartContext::for_test(ChatAgent::Claude, Some("session-1")),
    );
    let _agent = svc.chats.test_hold(&chat.key, ChatAgent::Claude, true);
    let request = serde_json::from_value(json!({
        "chatKey": chat.key,
        "questions": [
            { "question": "Which database?", "recommended": 1, "options": [
                "Postgres",
                { "label": "SQLite", "description": "One file, no server" },
            ] },
            { "question": "Which checks should run?", "multiple": true,
              "options": ["cargo test", "pnpm test", "the browser scripts"] },
        ],
    }))
    .unwrap();
    let manager = svc.chats.clone();
    let tool = tokio::spawn(crate::question::ask_request_with_timeout(
        manager,
        request,
        Duration::from_secs(30),
    ));
    let mut ids = Vec::new();
    for _ in 0..500 {
        ids = asked_in(&svc, &chat.key);
        if ids.len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(ids.len(), 2, "the tool's questions are listed for the page");
    dispatch(
        &svc,
        "question_answer_batch",
        json!({ "answers": [
            { "id": ids[0], "answer": "SQLite" },
            { "id": ids[1], "answer": "cargo test, pnpm test" },
        ] }),
    )
    .unwrap();
    let result = tool.await.unwrap();
    assert_eq!(
        result,
        "Q1: Which database?\nA1: SQLite\n\nQ2: Which checks should run?\nA2: cargo test, pnpm test",
        "the tool's result is what it always was"
    );

    let lines = chat.lines();
    assert_eq!(lines.len(), 1, "{lines:?}");
    fact("question_answered_tool", &lines[0]);
    assert_eq!(lines[0]["via"], "tool");
    assert_eq!(
        lines[0]["questions"],
        json!([
            {
                "id": ids[0],
                "question": "Which database?",
                "options": [
                    { "label": "Postgres" },
                    { "label": "SQLite", "description": "One file, no server" },
                ],
                "recommended": 1,
                "multiple": false,
                "answer": "SQLite",
            },
            {
                "id": ids[1],
                "question": "Which checks should run?",
                "options": [
                    { "label": "cargo test" },
                    { "label": "pnpm test" },
                    { "label": "the browser scripts" },
                ],
                "multiple": true,
                "answer": "cargo test, pnpm test",
            },
        ])
    );
    svc.chats.test_end(&chat.key);
}

fn one_question() -> Vec<crate::question::Question> {
    vec![serde_json::from_value(json!({ "question": "Which database?" })).unwrap()]
}

/// A question in `key`, asked and waited for. Answers its record's id and
/// the answer the page would send.
fn waiting(store: &QuestionStore, key: &str) -> (String, Vec<Answer>) {
    let (id, _waiter) = store
        .insert(crate::question_store::test_origin(key), one_question())
        .unwrap();
    let answers = store
        .pending()
        .unwrap()
        .into_iter()
        .filter(|asked| asked.question.chat_key.as_deref() == Some(key))
        .map(|asked| Answer {
            id: asked.id,
            answer: "SQLite".into(),
        })
        .collect();
    (id, answers)
}

/// Nothing is written for a question nobody answered while it was waited
/// for: one the person cancelled, one the chat's Stop cancelled, and one
/// whose call ran out of time. The last is answered afterwards, and that
/// answer goes to the agent as the host's own turn (`octiq-question-<id>`),
/// which is its record: it gets no line of this kind beside it.
#[test]
fn a_question_cancelled_or_never_answered_writes_nothing() {
    let manager = Arc::new(ChatManager::default());
    let store = &manager.questions;

    let cancelled = Chat::new("cancelled");
    let (id, answers) = waiting(store, &cancelled.key);
    store.cancel(&[answers[0].id.clone()]).unwrap();
    assert_eq!(store.take_native(&id).unwrap(), Some(Vec::new()));
    assert!(store.take_tool(&id).unwrap().unwrap().contains("cancelled"));
    assert!(cancelled.lines().is_empty());

    let stopped = Chat::new("stopped");
    let (id, _answers) = waiting(store, &stopped.key);
    store.cancel_chat(&stopped.key).unwrap();
    assert_eq!(store.take_native(&id).unwrap(), Some(Vec::new()));
    assert!(stopped.lines().is_empty());

    let late = Chat::new("late");
    let (id, answers) = waiting(store, &late.key);
    // The call's ten minutes ran out: nothing to take, and it lets go.
    assert_eq!(store.take_native(&id).unwrap(), None);
    store.detach(&id);
    assert!(
        late.lines().is_empty(),
        "an unanswered question has no line"
    );
    store.answer(&answers).unwrap();
    assert_eq!(store.take_native(&id).unwrap(), None, "nobody waits for it");
    let mut turns = Vec::new();
    deliver_question_answers_with(manager.clone(), |record| {
        turns.push(record.turn_id());
        Ok(())
    })
    .unwrap();
    assert_eq!(turns, [format!("octiq-question-{id}")]);
    assert!(late.lines().is_empty(), "its record is the host's turn");
    assert!(!store.owes_notes());
}

/// A server with its profile folder on a drive of its own.
struct World {
    svc: Services,
    _process: crate::profile::Started,
    home: Home,
}

impl World {
    fn new() -> Self {
        let home = Home::with_a_configured_base();
        let process = crate::profile::started_in(&home.dir);
        let svc = Services::at_profile();
        Self {
            svc,
            _process: process,
            home,
        }
    }
}

/// The profile folder is away when the answer is handed over. The agent
/// gets its answer at once; the line the record could not take is said
/// (never "saved"), named among what is owed, and written once when the
/// folder is back, however often the sweep runs.
#[test]
fn an_answer_handed_over_while_the_record_cannot_be_written_is_said_and_owed() {
    let world = World::new();
    let chat = Chat::new("away");
    let store = &world.svc.chats.questions;
    let (id, answers) = waiting(store, &chat.key);
    store.answer(&answers).unwrap();

    world.home.move_away();
    let why = crate::profile::available().expect_err("the profile folder is away");
    let (taken, said) = crate::unsaved::told(|| store.take_native(&id));
    assert_eq!(
        taken.unwrap(),
        Some(vec!["SQLite".to_string()]),
        "the agent is answered whatever the record takes"
    );
    assert!(
        said.iter().any(
            |unsaved| unsaved.what == "the answered questions in the chat's record"
                && unsaved.reason == why
        ),
        "{said:?}"
    );
    let status = dispatch(&world.svc, "profile_status", json!({})).unwrap();
    assert!(
        status["owed"]
            .as_array()
            .unwrap()
            .contains(&json!(NOTES_OWED)),
        "{status}"
    );
    let before = crate::profile::tests::everything_in(&world.home.dir);
    for _ in 0..3 {
        assert!(settle_owed(&world.svc).contains(&NOTES_OWED));
    }
    assert_eq!(
        crate::profile::tests::everything_in(&world.home.dir),
        before,
        "nothing is made or written while the folder is away"
    );

    world.home.move_back();
    crate::profile::available().expect("the profile folder is back");
    assert!(settle_owed(&world.svc).is_empty());
    let lines = chat.lines();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["id"], id.as_str());
    assert_eq!(lines[0]["via"], "native");
    assert_eq!(lines[0]["questions"][0]["answer"], "SQLite");
    for _ in 0..3 {
        assert!(settle_owed(&world.svc).is_empty());
    }
    assert_eq!(chat.lines().len(), 1, "an owed line is written once");
    let status = dispatch(&world.svc, "profile_status", json!({})).unwrap();
    assert_eq!(status["owed"], json!([]), "{status}");
}

/// A write that answered nothing may still have left its line: the write
/// held and the sync after it did not. The next try finds the line by its
/// id and writes nothing.
#[test]
fn a_line_that_is_already_in_the_record_is_not_written_again() {
    let world = World::new();
    let chat = Chat::new("found");
    let store = &world.svc.chats.questions;
    let (id, answers) = waiting(store, &chat.key);
    store.answer(&answers).unwrap();
    world.home.move_away();
    assert!(store.take_native(&id).unwrap().is_some());
    world.home.move_back();
    assert!(store.owes_notes());
    // The line as the lost write left it.
    crate::transcript::append(
        &chat.key,
        &json!({ "type": ANSWERED, "id": id, "via": "native", "questions": [] }),
    )
    .unwrap();
    assert!(settle_owed(&world.svc).is_empty());
    assert!(!store.owes_notes());
    assert_eq!(chat.lines().len(), 1, "found there, so not written again");
}

/// A record that will not take a line while the profile folder is there: a
/// folder stands where its file goes. Answers the folder, to be removed.
fn record_refuses_lines(chat: &Chat) -> PathBuf {
    let path = crate::transcript::path_for(&chat.key).unwrap();
    crate::profile::make_dir(&path).unwrap();
    path
}

/// A record that refuses the line (not the whole profile) owes it too, and
/// it is written once the record takes lines again, by one pass however
/// many run at once.
#[test]
fn an_owed_line_is_written_once_by_however_many_passes_run_together() {
    const ROUNDS: usize = 25;
    const PASSES: usize = 8;
    for round in 0..ROUNDS {
        let manager = Arc::new(ChatManager::default());
        let chat = Chat::new("passes");
        let (id, answers) = waiting(&manager.questions, &chat.key);
        manager.questions.answer(&answers).unwrap();
        let blocked = record_refuses_lines(&chat);
        let (taken, said) = crate::unsaved::told(|| manager.questions.take_tool(&id));
        assert_eq!(taken.unwrap().as_deref(), Some("SQLite"));
        assert_eq!(said.len(), 1, "round {round}: {said:?}");
        assert!(said[0].reason.contains(&chat.key), "{said:?}");
        assert!(manager.questions.owes_notes());
        std::fs::remove_dir(&blocked).unwrap();

        let together = Arc::new(std::sync::Barrier::new(PASSES));
        let passes: Vec<_> = (0..PASSES)
            .map(|_| {
                let (manager, together) = (manager.clone(), together.clone());
                std::thread::spawn(move || {
                    together.wait();
                    manager.questions.settle_notes()
                })
            })
            .collect();
        for pass in passes {
            pass.join().unwrap().unwrap();
        }
        let lines = chat.lines();
        assert_eq!(lines.len(), 1, "round {round}: {lines:?}");
        assert_eq!(lines[0]["via"], "tool");
        assert!(!manager.questions.owes_notes());
    }
}

/// The person clears the chat between the answer and the line's next try.
/// The record the answer was given in is gone, and the line is not put into
/// the history started afterwards: it is dropped, and nothing is owed.
#[test]
fn a_chat_cleared_before_an_owed_line_is_written_does_not_get_it() {
    let manager = Arc::new(ChatManager::default());
    let chat = Chat::new("cleared");
    let (id, answers) = waiting(&manager.questions, &chat.key);
    manager.questions.answer(&answers).unwrap();
    let blocked = record_refuses_lines(&chat);
    assert!(manager.questions.take_native(&id).unwrap().is_some());
    assert!(manager.questions.owes_notes());
    std::fs::remove_dir(&blocked).unwrap();

    // `/clear`, then the next thing said in the chat.
    crate::transcript::forget(&chat.key);
    crate::transcript::append(&chat.key, &json!({ "type": "user", "text": "hello" })).unwrap();

    manager.questions.settle_notes().unwrap();
    assert!(!manager.questions.owes_notes(), "nothing is left to write");
    assert!(
        chat.lines().is_empty(),
        "the cleared chat got an old answer"
    );
}

/// A record that goes on refusing is asked again after 4 seconds, doubling
/// to a minute: every try reads the record for the line first.
#[test]
fn a_record_that_keeps_refusing_is_left_alone_between_tries() {
    let manager = Arc::new(ChatManager::default());
    let chat = Chat::new("refusing");
    let (id, answers) = waiting(&manager.questions, &chat.key);
    manager.questions.answer(&answers).unwrap();
    let blocked = record_refuses_lines(&chat);
    assert!(manager.questions.take_native(&id).unwrap().is_some());
    // The first try after the hand-over is made at once, and fails.
    assert!(manager.questions.settle_notes().is_err());
    std::fs::remove_dir(&blocked).unwrap();
    // The record would take the line now; the next try is not due yet.
    assert!(manager.questions.settle_notes().is_err());
    assert!(chat.lines().is_empty());
    assert!(manager.questions.owes_notes());
}

/// Review 2b, N2: a line that can be read back is not a saved one. The
/// answer's line is written and the sync of its folder fails, so it is said
/// and owed. The next pass finds the line by its id, and that used to end
/// the debt with nothing asked of the disk. It ends only on the record's
/// own receipt: while the folder cannot be synced the line stays owed, is
/// never written twice, and is confirmed once the sync goes through.
///
/// Both for a record the answer's line made and for one that was already
/// there: an append into a file that existed synced the file and said
/// nothing of its folder, which was taken for a receipt too.
#[test]
fn a_line_that_can_be_read_back_is_owed_until_its_record_is_synced() {
    for existed in [false, true] {
        let manager = Arc::new(ChatManager::default());
        let chat = Chat::new("unsynced");
        let store = &manager.questions;
        let (id, answers) = waiting(store, &chat.key);
        store.answer(&answers).unwrap();
        if existed {
            crate::transcript::append(&chat.key, &json!({ "type": "user", "text": "hello" }))
                .unwrap();
        }

        crate::transcript::FAIL_DIR_SYNC.with(|fail| fail.set(true));
        let (taken, said) = crate::unsaved::told(|| store.take_native(&id));
        assert_eq!(taken.unwrap(), Some(vec!["SQLite".to_string()]));
        assert_eq!(
            said.iter()
                .filter(|unsaved| unsaved.what == "the answered questions in the chat's record")
                .count(),
            1,
            "existed {existed}: {said:?}"
        );
        assert!(store.owes_notes(), "existed {existed}");
        assert_eq!(chat.lines().len(), 1, "the line itself was written");
        let record = crate::transcript::generation(&chat.key).unwrap();

        // The line is found, and finding it is not a receipt.
        for _ in 0..3 {
            store.notes_due_now();
            assert!(store.settle_notes().is_err(), "existed {existed}");
            assert!(
                store.owes_notes(),
                "existed {existed}: read back, not saved"
            );
            assert!(crate::transcript::confirm_synced(&chat.key, &record).is_none());
        }
        assert_eq!(chat.lines().len(), 1, "never written a second time");

        crate::transcript::FAIL_DIR_SYNC.with(|fail| fail.set(false));
        store.notes_due_now();
        store.settle_notes().unwrap();
        assert!(!store.owes_notes(), "existed {existed}");
        assert_eq!(chat.lines().len(), 1);
        assert_eq!(chat.lines()[0]["id"], id.as_str());
    }
}

/// An answer whose line the record refused, in a chat with a record. The
/// line is owed, and the record takes lines again.
fn owing(manager: &ChatManager, chat: &Chat) -> String {
    let (id, answers) = waiting(&manager.questions, &chat.key);
    manager.questions.answer(&answers).unwrap();
    let blocked = record_refuses_lines(chat);
    assert!(manager.questions.take_native(&id).unwrap().is_some());
    assert!(manager.questions.owes_notes());
    std::fs::remove_dir(&blocked).unwrap();
    id
}

/// Review 2b, N1: the person clears the chat while the owed line's pass is
/// reading the old record for it. The pass had checked which record the
/// chat has before the read and did not ask again before it wrote, so the
/// old answer was the second line of the new history. The check and the
/// write are one step under the append lock now: nothing is written, and
/// the debt is dropped as cleared.
#[test]
fn a_chat_cleared_while_an_owed_line_looks_for_itself_does_not_get_it() {
    let manager = Arc::new(ChatManager::default());
    let chat = Chat::new("cleared-mid-look");
    owing(&manager, &chat);
    // What the page's `/clear` does, then the next thing said in the chat,
    // in the moment between the pass's look and its write.
    crate::question_store::AFTER_LOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(|key: &str| {
            crate::transcript::forget(key);
            crate::transcript::append(key, &json!({ "type": "user", "text": "new history" }))
                .unwrap();
        }));
    });
    manager.questions.settle_notes().unwrap();
    assert!(
        chat.lines().is_empty(),
        "the cleared chat got an old answer: {:?}",
        chat.lines()
    );
    assert!(!manager.questions.owes_notes(), "dropped as cleared");
    assert_eq!(
        crate::transcript::since(&chat.key, 0).len(),
        1,
        "the new history holds what was said in it and nothing else"
    );
}

/// The reviewer's deterministic schedule for the same hole, with nothing of
/// the host's switched: a FIFO stands where the record was, so the pass's
/// read of it waits until this thread has cleared the chat and started the
/// next history. Unix only: there is no `mkfifo` on Windows, where the test
/// above holds the same window open.
#[cfg(unix)]
#[test]
fn a_chat_cleared_during_the_owed_lines_read_does_not_get_it_unix_fifo() {
    use std::io::Write;
    let manager = Arc::new(ChatManager::default());
    let chat = Chat::new("cleared-fifo");
    owing(&manager, &chat);
    let path = crate::transcript::path_for(&chat.key).unwrap();
    assert!(std::process::Command::new("mkfifo")
        .arg(&path)
        .status()
        .unwrap()
        .success());
    let pass = {
        let manager = manager.clone();
        std::thread::spawn(move || manager.questions.settle_notes())
    };
    // Opening the writing end answers once the pass has opened its read.
    let mut feed = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    crate::transcript::forget(&chat.key);
    crate::transcript::append(&chat.key, &json!({ "type": "user", "text": "new history" }))
        .unwrap();
    feed.write_all(b"{\"type\":\"user\",\"text\":\"old record\"}\n")
        .unwrap();
    drop(feed);
    pass.join().unwrap().unwrap();
    assert!(
        chat.lines().is_empty(),
        "the cleared chat got an old answer: {:?}",
        chat.lines()
    );
    assert!(!manager.questions.owes_notes());
}

/// The same hole with nothing held open for it: an ordinary long record
/// makes the pass's read last, and the chat is cleared a little later each
/// round, so the clear lands before the look, inside it and after the
/// write. Whenever it lands, the history started after it holds no old
/// answer. Before the fix the reviewer's five rounds of this put the old
/// answer into five of five new histories.
#[test]
fn clearing_a_long_chat_at_any_moment_of_an_owed_lines_pass_keeps_the_old_answer_out() {
    const ROUNDS: u64 = 30;
    // About 24 MB: a read of it lasts well past the longest wait below.
    let line = format!("{{\"type\":\"user\",\"text\":\"{}\"}}\n", "x".repeat(500));
    let old = line.repeat(48_000);
    let mut leaked = 0;
    for round in 0..ROUNDS {
        let manager = Arc::new(ChatManager::default());
        let chat = Chat::new("cleared-long");
        owing(&manager, &chat);
        std::fs::write(crate::transcript::path_for(&chat.key).unwrap(), &old).unwrap();
        let pass = {
            let manager = manager.clone();
            std::thread::spawn(move || manager.questions.settle_notes())
        };
        std::thread::sleep(std::time::Duration::from_millis(round));
        crate::transcript::forget(&chat.key);
        crate::transcript::append(&chat.key, &json!({ "type": "user", "text": "new history" }))
            .unwrap();
        pass.join().unwrap().unwrap();
        leaked += chat.lines().len();
        assert!(!manager.questions.owes_notes(), "round {round}");
    }
    assert_eq!(
        leaked, 0,
        "of {ROUNDS} cleared chats, {leaked} got an old answer"
    );
}

/// A line owed from while the profile folder was away has no record of its
/// own yet: it belongs to the one that is there when the folder is back,
/// and to that one from then on. The first try writes the line and cannot
/// confirm it; the person clears the chat; the next try finds that record
/// gone and writes nothing. Taken afresh on every try, "the record that is
/// there" was the history started after the clear, and it got the old
/// answer.
#[test]
fn a_line_owed_from_while_the_folder_was_away_keeps_to_the_record_it_found() {
    let world = World::new();
    let chat = Chat::new("away-then-cleared");
    let store = &world.svc.chats.questions;
    let (id, answers) = waiting(store, &chat.key);
    store.answer(&answers).unwrap();
    world.home.move_away();
    assert!(store.take_native(&id).unwrap().is_some());
    world.home.move_back();
    assert!(store.owes_notes());

    crate::transcript::FAIL_DIR_SYNC.with(|fail| fail.set(true));
    assert!(store.settle_notes().is_err());
    crate::transcript::FAIL_DIR_SYNC.with(|fail| fail.set(false));
    assert_eq!(chat.lines().len(), 1, "written, and not confirmed");
    assert!(store.owes_notes());

    // `/clear`, then the next thing said in the chat.
    crate::transcript::forget(&chat.key);
    crate::transcript::append(&chat.key, &json!({ "type": "user", "text": "hello" })).unwrap();
    store.notes_due_now();
    store.settle_notes().unwrap();
    assert!(
        chat.lines().is_empty(),
        "the cleared chat got an old answer"
    );
    assert!(!store.owes_notes());
}

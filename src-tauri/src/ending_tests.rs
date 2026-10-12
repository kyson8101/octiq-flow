//! Review of 205bca2, H5: an action that ENDS work or ANSWERS a waiting
//! agent never waits on a save.
//!
//! Each test goes through the real `dispatch` command, against the stores a
//! server loads from its profile folder, with a live stand-in process where
//! one is stopped. The profile folder is then only moved away, which is a
//! drive dropping: before, Stop and interrupt answered the profile's
//! sentence with the agent still running, and an answer never reached the
//! tool waiting for it.
//!
//! The save is still tried, the failure is said to whoever asked beside the
//! command's ordinary answer (`unsaved.rs`), and what could not be saved is
//! made good once the folder is back (`dispatch::settle_owed`), so nothing
//! comes back wrong after a restart.
use super::*;
use crate::dispatch::{settle_owed, told, Services, Told};
use crate::profile::tests::Home;
use serde_json::json;

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

    /// An auto-resume for `key`, an hour from now, saved as a usage limit
    /// leaves one.
    fn schedule(&self, key: &str) {
        let now = crate::auto_resume::unix_now();
        self.chats()
            .auto_resumes
            .schedule(
                key,
                now + 3600,
                StartContext::for_test(ChatAgent::Claude, Some("native-session")),
                now,
            )
            .expect("the schedule is saved")
            .expect("a resume is scheduled");
        assert_eq!(resume_on_disk(key).as_deref(), Some("scheduled"));
        assert!(self.is_scheduled(key));
    }

    fn is_scheduled(&self, key: &str) -> bool {
        scheduled_in(&self.svc, key)
    }
}

fn scheduled_in(svc: &Services, key: &str) -> bool {
    svc.chats
        .auto_resumes
        .scheduled()
        .unwrap()
        .iter()
        .any(|entry| entry.chat_key == key)
}

fn fresh(name: &str) -> String {
    format!("chat:p3-{name}-{}", uuid::Uuid::new_v4().simple())
}

/// What the schedule file says of `key`, or None when it has no entry.
fn resume_on_disk(key: &str) -> Option<String> {
    let path = crate::profile::profile_dir()
        .join("chats")
        .join("auto-resumes.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(path).ok()?).unwrap();
    saved[key]["delivery"].as_str().map(str::to_string)
}

/// The action happened: its ordinary answer, and `what` said as not
/// recorded, in the profile's own sentence.
#[track_caller]
fn done_but_not_recorded(told: &Told, answer: Value, what: &str, why: &str) {
    assert_eq!(
        told.result,
        Ok(answer),
        "an action that happened is not reported as failed"
    );
    assert!(
        told.unsaved
            .iter()
            .any(|unsaved| unsaved.what == what && unsaved.reason == why),
        "the caller was not told that {what} could not be recorded: {:?}",
        told.unsaved
    );
}

/// The reviewer's first probe. Stop stops, and the scheduled resume it
/// cancelled stays cancelled: in memory at once, on disk once the folder is
/// back, and so after a restart.
#[test]
fn stop_ends_the_agent_while_the_profile_is_away_and_its_resume_does_not_come_back() {
    let world = World::new();
    let key = fresh("stop");
    let agent = world.chats().test_hold(&key, ChatAgent::Claude, true);
    world.schedule(&key);

    let why = world.folder_goes();
    let stopped = told(&world.svc, "chat_stop", json!({ "key": key }));
    done_but_not_recorded(&stopped, Value::Null, "the cancelled auto-resume", &why);
    assert!(agent.gone(), "the agent is still running after Stop");
    assert!(!world.chats().has_process(&key));
    assert!(!world.is_scheduled(&key), "the resume is still scheduled");
    let status = crate::dispatch::dispatch(&world.svc, "profile_status", json!({})).unwrap();
    assert_eq!(status["owed"], json!(["auto-resumes"]), "{status}");
    // Still away: trying again changes nothing and makes no folder.
    assert_eq!(settle_owed(&world.svc), ["auto-resumes"]);
    assert!(!world.home.profile().exists(), "the folder was made again");

    world.folder_returns();
    assert_eq!(
        resume_on_disk(&key).as_deref(),
        Some("scheduled"),
        "nothing was written while the folder was away"
    );
    assert!(settle_owed(&world.svc).is_empty());
    assert_eq!(resume_on_disk(&key), None, "the cancel is not on disk");
    let status = crate::dispatch::dispatch(&world.svc, "profile_status", json!({})).unwrap();
    assert_eq!(status["owed"], json!([]), "{status}");
    // The chat's own record says it too, once: a reload reads no banner.
    let said = crate::transcript::of_type(&key, "octiq_auto_resume_cancelled");
    assert_eq!(said.len(), 1, "{said:?}");
    assert!(settle_owed(&world.svc).is_empty());
    assert_eq!(
        crate::transcript::of_type(&key, "octiq_auto_resume_cancelled").len(),
        1
    );

    // The server restarts on the folder that came back.
    let restarted = Services::at_profile();
    assert!(
        !scheduled_in(&restarted, &key),
        "the chat would resume itself"
    );
    let due = restarted.chats.auto_resumes.claim_due(i64::MAX).unwrap();
    assert!(due.iter().all(|entry| entry.chat_key != key), "{due:?}");
}

/// The rules of the round before still hold for a save that is owed: with
/// another folder put where the profile was, Stop stops, and what it owes
/// is not written into that folder however often it is tried. It is written
/// once the folder the server started with is back.
#[test]
fn what_stop_owes_is_never_written_into_a_folder_put_in_the_profiles_place() {
    let world = World::new();
    let key = fresh("replaced");
    let agent = world.chats().test_hold(&key, ChatAgent::Claude, true);
    world.schedule(&key);

    world.home.replace();
    let why = crate::profile::available().expect_err("another folder is in its place");
    let stopped = told(&world.svc, "chat_stop", json!({ "key": key }));
    done_but_not_recorded(&stopped, Value::Null, "the cancelled auto-resume", &why);
    assert!(agent.gone(), "the agent is still running after Stop");

    let put_there = crate::profile::tests::everything_in(&world.home.profile());
    for _ in 0..3 {
        assert_eq!(settle_owed(&world.svc), ["auto-resumes"]);
    }
    assert_eq!(
        crate::profile::tests::everything_in(&world.home.profile()),
        put_there,
        "the owed save was written into the folder that replaced the profile"
    );

    world.home.move_back();
    assert!(settle_owed(&world.svc).is_empty());
    assert!(!scheduled_in(&Services::at_profile(), &key));
}

/// What a Stop answers with nothing queued behind the stopped turn
/// (`Stopped`; with messages queued, see `reach_tests.rs`).
static STOPPED: std::sync::LazyLock<Value> =
    std::sync::LazyLock::new(|| json!({ "stopped": true, "waiting": 0 }));

/// Interrupt, for an agent that is asked to stop over its own channel: the
/// turn is cut short and the conversation kept.
#[test]
fn interrupt_cuts_the_turn_short_while_the_profile_is_away() {
    let world = World::new();
    let key = fresh("interrupt");
    let agent = world.chats().test_hold(&key, ChatAgent::Claude, true);
    world.schedule(&key);

    let why = world.folder_goes();
    let cut = told(&world.svc, "chat_interrupt", json!({ "key": key }));
    done_but_not_recorded(&cut, STOPPED.clone(), "the cancelled auto-resume", &why);
    assert!(
        world.chats().unwinding(&key),
        "the agent was not asked to stop"
    );
    assert!(!world.chats().turn_in_flight(&key));
    assert!(agent.alive(), "an interrupt keeps the conversation");
    assert!(!world.is_scheduled(&key));

    world.folder_returns();
    assert!(settle_owed(&world.svc).is_empty());
    assert!(!scheduled_in(&Services::at_profile(), &key));
    world.chats().test_end(&key);
}

/// And for one whose only stop is the end of its process.
#[test]
fn interrupt_ends_the_process_of_an_agent_that_takes_no_stop_while_the_profile_is_away() {
    let world = World::new();
    let key = fresh("interrupt-ends");
    let agent = world.chats().test_hold(&key, ChatAgent::Antigravity, true);
    world.schedule(&key);

    let why = world.folder_goes();
    let cut = told(&world.svc, "chat_interrupt", json!({ "key": key }));
    done_but_not_recorded(&cut, STOPPED.clone(), "the cancelled auto-resume", &why);
    assert!(agent.gone(), "the agent is still running after Stop");
    assert!(!world.is_scheduled(&key));
    world.folder_returns();
}

/// Complete stays refused while the profile is away: its point is the
/// record, and refusing it leaves nothing half done. The Stop that follows
/// is not refused with it.
#[test]
fn complete_is_refused_while_the_profile_is_away_and_the_stop_after_it_stops() {
    let world = World::new();
    let key = fresh("complete");
    let agent = world.chats().test_hold(&key, ChatAgent::Claude, false);
    world.schedule(&key);

    let why = world.folder_goes();
    let refused = told(&world.svc, "chat_complete", json!({ "chatKey": key }));
    assert_eq!(refused.result, Err(why.clone()));
    assert!(refused.unsaved.is_empty(), "{:?}", refused.unsaved);
    assert!(agent.alive(), "a refused Complete stopped the agent");
    assert!(
        world.is_scheduled(&key),
        "a refused Complete changed nothing"
    );

    let stopped = told(&world.svc, "chat_stop", json!({ "key": key }));
    done_but_not_recorded(&stopped, Value::Null, "the cancelled auto-resume", &why);
    assert!(agent.gone(), "the agent is still running after Stop");
    world.folder_returns();
}

/// Cancel on the usage banner ends work that was only scheduled.
#[test]
fn a_scheduled_resume_is_cancelled_from_its_banner_while_the_profile_is_away() {
    let world = World::new();
    let key = fresh("banner");
    world.schedule(&key);

    let why = world.folder_goes();
    let cancelled = told(&world.svc, "chat_cancel_auto_resume", json!({ "key": key }));
    done_but_not_recorded(&cancelled, json!(true), "the cancelled auto-resume", &why);
    assert!(!world.is_scheduled(&key));
    // Nothing is left to cancel, and nothing more to say.
    let again = told(&world.svc, "chat_cancel_auto_resume", json!({ "key": key }));
    assert_eq!(again.result, Ok(json!(false)));

    world.folder_returns();
    assert!(settle_owed(&world.svc).is_empty());
    assert!(!scheduled_in(&Services::at_profile(), &key));
}

/// The folder never comes back before the server restarts: the cancel was
/// only ever in the memory of a process that is gone. What is true then is
/// what the disk says, and this pins that it is said: the caller was told
/// the cancel was not recorded, and the store went on owing it to the end.
#[test]
fn a_cancel_that_never_reached_the_disk_is_owed_for_as_long_as_the_folder_is_away() {
    let world = World::new();
    let key = fresh("never-back");
    world.schedule(&key);
    let why = world.folder_goes();
    let cancelled = told(&world.svc, "chat_cancel_auto_resume", json!({ "key": key }));
    done_but_not_recorded(&cancelled, json!(true), "the cancelled auto-resume", &why);
    for _ in 0..3 {
        assert_eq!(settle_owed(&world.svc), ["auto-resumes"]);
    }
    world.folder_returns();
    // Nothing settled it: a server started now reads the schedule as it was.
    assert!(scheduled_in(&Services::at_profile(), &key));
}

fn question() -> Vec<crate::question::Question> {
    vec![serde_json::from_value(json!({ "question": "Which database?" })).unwrap()]
}

fn questions_on_disk() -> crate::question_store::QuestionStore {
    crate::question_store::QuestionStore::load(
        crate::profile::profile_dir()
            .join("chats")
            .join("questions.json"),
    )
}

/// The reviewer's question probe: the answer reaches the tool that is
/// waiting for it, and the tool takes it.
#[test]
fn a_questions_answer_reaches_the_waiting_tool_while_the_profile_is_away() {
    let world = World::new();
    let key = fresh("question");
    let questions = &world.chats().questions;
    let (id, mut waiter) = questions
        .insert(crate::question_store::test_origin(&key), question())
        .unwrap();
    let asked = questions.pending().unwrap()[0].id.clone();

    let why = world.folder_goes();
    let answered = told(
        &world.svc,
        "question_answer",
        json!({ "id": asked, "answer": "Postgres" }),
    );
    done_but_not_recorded(&answered, json!(true), "the answer", &why);
    assert!(waiter.try_recv().is_ok(), "the waiting tool was not woken");
    let taken = questions.take_tool(&id).expect("the tool takes its answer");
    assert!(
        taken
            .as_deref()
            .is_some_and(|text| text.contains("Postgres")),
        "{taken:?}"
    );
    // Answered and handed over: nothing is left to deliver a second time.
    assert!(questions.outbox().unwrap().is_empty());

    world.folder_returns();
    assert!(settle_owed(&world.svc).is_empty());
    let restarted = questions_on_disk();
    assert!(restarted.pending().unwrap().is_empty(), "asked again");
    assert!(restarted.outbox().unwrap().is_empty(), "delivered again");
}

/// Cancelling a question answers the tool too, with "cancelled".
#[test]
fn a_cancelled_question_tells_the_waiting_tool_while_the_profile_is_away() {
    let world = World::new();
    let key = fresh("question-cancel");
    let questions = &world.chats().questions;
    let (id, _waiter) = questions
        .insert(crate::question_store::test_origin(&key), question())
        .unwrap();
    let asked = questions.pending().unwrap()[0].id.clone();

    let why = world.folder_goes();
    let cancelled = told(&world.svc, "question_cancel", json!({ "ids": [asked] }));
    done_but_not_recorded(&cancelled, Value::Null, "the cancelled questions", &why);
    let taken = questions.take_tool(&id).unwrap();
    assert!(
        taken
            .as_deref()
            .is_some_and(|text| text.contains("cancelled")),
        "{taken:?}"
    );

    world.folder_returns();
    assert!(settle_owed(&world.svc).is_empty());
    assert!(questions_on_disk().pending().unwrap().is_empty());
}

/// A permission card keeps nothing on disk: Allow and Deny reach the call
/// parked on them, and "Always" stands for the chat, in memory, as it does
/// with the folder there. Confirmed with the receiver the call holds.
#[tokio::test]
async fn a_permission_cards_answer_reaches_the_parked_call_while_the_profile_is_away() {
    let world = World::new();
    let key = fresh("permission");
    let (allow, mut allowed) = crate::permission::test_ask_waiting(&key);
    let (deny, mut denied) = crate::permission::test_ask_waiting(&key);

    world.folder_goes();
    let answer = told(
        &world.svc,
        "permission_decide",
        json!({ "id": allow, "decision": "allow", "remember": true }),
    );
    assert_eq!(answer.result, Ok(json!(true)));
    assert!(answer.unsaved.is_empty(), "{:?}", answer.unsaved);
    assert!(matches!(
        allowed.try_recv(),
        Ok(crate::permission::Decision::Allow)
    ));
    assert!(crate::permission::test_remembers(&key, &allow));

    let answer = told(
        &world.svc,
        "permission_decide",
        json!({ "id": deny, "decision": "deny" }),
    );
    assert_eq!(answer.result, Ok(json!(true)));
    assert!(matches!(
        denied.try_recv(),
        Ok(crate::permission::Decision::Deny)
    ));
    world.folder_returns();
    crate::permission::forget_chat(&key);
}

/// So does an access request's card: the answer only settles the card.
#[tokio::test]
async fn an_access_requests_answer_reaches_the_parked_call_while_the_profile_is_away() {
    let world = World::new();
    let key = fresh("access");
    let (id, mut waiter) = crate::access_request::test_ask_waiting(&key);

    world.folder_goes();
    let answer = told(
        &world.svc,
        "access_request_answer",
        json!({ "id": id, "decision": "declined" }),
    );
    assert_eq!(answer.result, Ok(json!(true)));
    assert!(answer.unsaved.is_empty(), "{:?}", answer.unsaved);
    assert_eq!(
        waiter.try_recv().ok(),
        Some((crate::access_request::Decision::Declined, None))
    );
    world.folder_returns();
}

/// A Codex safety card. Its refused command is already dead, so the card
/// answers the next turn: Keep local and Allow once take the card down and
/// keep nothing. "Allow for this project" IS a stored authorization, and
/// with the folder away it fails in the profile's sentence, leaves the card
/// up to be answered another way, and is not assumed once the folder is back.
#[test]
fn a_codex_cards_answers_stand_and_nothing_durable_is_assumed_while_the_profile_is_away() {
    let world = World::new();
    let project = world.home.dir.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let cwd = project.to_string_lossy().into_owned();
    let key = fresh("codex-card");
    let card = crate::safety_block::test_codex_card(&key, &cwd);

    let why = world.folder_goes();
    let always = told(
        &world.svc,
        "safety_block_authorize_project",
        json!({ "id": card }),
    );
    let said = always
        .result
        .expect_err("a stored authorization that was not stored");
    assert!(said.contains(&why), "{said}");
    assert!(
        said.starts_with("Nothing was allowed for the project"),
        "{said}"
    );
    assert!(
        crate::safety_block::test_is_pending(&card),
        "the card went with an authorization that was never saved"
    );

    // Deny (Keep it local) and Allow once are the same command: the card.
    let once = told(&world.svc, "safety_block_dismiss", json!({ "id": card }));
    assert_eq!(once.result, Ok(json!(true)));
    assert!(once.unsaved.is_empty(), "{:?}", once.unsaved);
    assert!(!crate::safety_block::test_is_pending(&card));

    world.folder_returns();
    assert!(settle_owed(&world.svc).is_empty());
    assert_eq!(
        crate::safety_block::project_authorizations(&cwd),
        None,
        "an authorization that failed was assumed later"
    );

    // With the folder there the same answer is kept, as before.
    let card = crate::safety_block::test_codex_card(&fresh("codex-card"), &cwd);
    let always = told(
        &world.svc,
        "safety_block_authorize_project",
        json!({ "id": card }),
    );
    assert_eq!(always.result, Ok(json!(true)));
    assert!(crate::safety_block::project_authorizations(&cwd).is_some());
}

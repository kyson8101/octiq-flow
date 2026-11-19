
use super::*;
use crate::question_store::{test_origin, Answer, Delivery, Record};

#[test]
fn a_worker_session_cannot_be_resumed_as_an_ordinary_chat() {
    let manager = ChatManager::default();
    let worker_session = format!("worker-session-{}", uuid::Uuid::new_v4());
    let main_session = format!("main-session-{}", uuid::Uuid::new_v4());
    manager.remember_start(
        "chat:orch-worker",
        StartContext::for_test(ChatAgent::Codex, Some(&worker_session)),
    );
    manager.remember_start(
        "chat:master",
        StartContext::for_test(ChatAgent::Codex, Some(&main_session)),
    );
    assert!(manager
        .require_user_resume(&worker_session)
        .unwrap_err()
        .contains("read-only"));
    assert!(manager.require_user_resume(&main_session).is_ok());
    assert!(manager.require_user_resume("unknown-session").is_ok());
}

fn setup() -> (Arc<ChatManager>, String, String, Vec<Answer>) {
    let key = format!("question-{}", uuid::Uuid::new_v4());
    let manager = Arc::new(ChatManager::default());
    let questions = vec![serde_json::from_value(json!({"question": "Which database?"})).unwrap()];
    let (id, _rx) = manager
        .questions
        .insert(test_origin(&key), questions)
        .unwrap();
    let answers = manager
        .questions
        .pending()
        .unwrap()
        .into_iter()
        .map(|q| Answer {
            id: q.id,
            answer: "SQLite".into(),
        })
        .collect();
    (manager, key, id, answers)
}

fn received(record: &Record) {
    crate::transcript::append(
        &record.origin.chat_key,
        &json!({
            "type": "turn.started", "octiq_user_turn_id": record.turn_id(),
        }),
    );
}

#[tokio::test]
async fn the_actual_tool_timeout_leaves_an_answerable_question_without_a_browser() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("question-timeout-{}", uuid::Uuid::new_v4());
    let origin = test_origin(&key);
    manager.remember_start(&key, origin.start);
    let child = stand_in::echo()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    manager.sessions.lock().unwrap().insert(
        key.clone(),
        Arc::new(Mutex::new(ChatSession {
            launch_id: "launch-1".into(),
            user_turn_id: None,
            answering: None,
            child,
            stdin: None,
            codex: None,
            agent: ChatAgent::Codex,
            busy: true,
            last_active: Instant::now(),
            cut_off: CutOff::No,
            auto_plan_refused: false,
            auto_plan_turn: AutoPlanTurn::default(),
            auto_plan_attribution: AutoPlanAttribution::Ready,
            leaving: None,
            first_turn_held: false,
        })),
    );
    let request = serde_json::from_value(json!({ "chatKey": key, "launchId": "launch-1", "questions": [{"question":"Which database?"}] })).unwrap();
    let result = crate::question::ask_request_with_timeout(
        manager.clone(),
        request,
        Duration::from_millis(10),
    )
    .await;
    assert!(result.contains("saved and still waiting"), "{result}");
    let q = manager.questions.pending().unwrap().remove(0);
    assert_eq!(q.question.question, "Which database?");
    manager
        .questions
        .answer(&[Answer {
            id: q.id,
            answer: "SQLite".into(),
        }])
        .unwrap();
    deliver_question_answers_with(manager.clone(), |record| {
        received(record);
        Ok(())
    })
    .unwrap();
    deliver_question_answers_with(manager.clone(), |_| panic!("duplicate continuation")).unwrap();
    assert!(manager.questions.pending().unwrap().is_empty());
    end_process(&manager, &key).unwrap();
    crate::transcript::forget(&key);
}

#[test]
fn an_ended_turn_gets_one_continuation_with_its_original_question_and_settings() {
    let (manager, key, _id, answers) = setup();
    manager.questions.detach_launch("launch-1");
    manager.questions.answer(&answers).unwrap();
    let mut sends = 0;
    deliver_question_answers_with(manager.clone(), |record| {
        sends += 1;
        assert!(record
            .continuation()
            .contains("Q1: Which database?\nA1: SQLite"));
        assert_eq!(record.origin.start.model.as_deref(), Some("gpt-test"));
        assert_eq!(record.origin.start.session_id.as_deref(), Some("session-1"));
        assert_eq!(record.origin.start.access, Some(Access::Manual));
        received(record);
        Ok(())
    })
    .unwrap();
    manager.questions.answer(&answers).unwrap();
    deliver_question_answers_with(manager.clone(), |_| panic!("duplicate continuation")).unwrap();
    assert_eq!(sends, 1);
    assert!(manager.questions.pending().unwrap().is_empty());
    crate::transcript::forget(&key);
}

#[test]
fn saved_answers_resume_after_a_server_restart_without_a_browser() {
    let path = crate::test_dir::TestPath::new("question-recovery", "questions.json");
    let manager = Arc::new(ChatManager::with_saved_questions(path.to_path_buf()));
    let key = format!("question-restart-{}", uuid::Uuid::new_v4());
    manager
        .questions
        .insert(
            test_origin(&key),
            vec![serde_json::from_value(json!({"question": "Ship?"})).unwrap()],
        )
        .unwrap();
    let question = manager.questions.pending().unwrap().remove(0);
    manager
        .questions
        .answer(&[Answer {
            id: question.id,
            answer: "Yes".into(),
        }])
        .unwrap();
    drop(manager);
    let restored = Arc::new(ChatManager::with_saved_questions(path.to_path_buf()));
    deliver_question_answers_with(restored.clone(), |record| {
        assert_eq!(record.origin.start.agent, ChatAgent::Codex);
        assert_eq!(record.origin.start.cwd, "/tmp");
        received(record);
        Ok(())
    })
    .unwrap();
    deliver_question_answers_with(restored.clone(), |_| panic!("duplicate continuation")).unwrap();
    assert!(restored.questions.pending().unwrap().is_empty());
    crate::transcript::forget(&key);
}

#[test]
fn an_unconfirmed_dispatch_is_never_replayed_automatically() {
    let (manager, key, id, answers) = setup();
    manager.questions.detach(&id);
    manager.questions.answer(&answers).unwrap();
    manager
        .questions
        .set_delivery(&id, Delivery::Dispatching, None)
        .unwrap();
    deliver_question_answers_with(manager.clone(), |_| {
        panic!("cannot prove it was not already sent")
    })
    .unwrap();
    let saved = manager.questions.pending().unwrap();
    assert_eq!(saved[0].status, "failed");
    assert_eq!(saved[0].answer.as_deref(), Some("SQLite"));
    assert!(saved[0].error.as_deref().unwrap().contains("interrupted"));
    crate::transcript::forget(&key);
}

#[test]
fn a_failed_spawn_retains_answers_and_only_retries_when_requested() {
    let (manager, key, id, answers) = setup();
    manager.questions.detach(&id);
    manager.questions.answer(&answers).unwrap();
    deliver_question_answers_with(manager.clone(), |_| Err("CLI unavailable".into())).unwrap();
    deliver_question_answers_with(manager.clone(), |_| panic!("failed answers wait for retry"))
        .unwrap();
    assert_eq!(manager.questions.pending().unwrap()[0].status, "failed");
    manager
        .questions
        .retry(&answers.iter().map(|a| a.id.clone()).collect::<Vec<_>>())
        .unwrap();
    deliver_question_answers_with(manager.clone(), |record| {
        received(record);
        Ok(())
    })
    .unwrap();
    deliver_question_answers_with(manager.clone(), |_| panic!("duplicate continuation")).unwrap();
    assert!(manager.questions.pending().unwrap().is_empty());
    crate::transcript::forget(&key);
}

#[test]
fn stop_cancels_saved_answers_and_their_queued_continuation() {
    let (manager, key, id, answers) = setup();
    manager.questions.detach(&id);
    manager.questions.answer(&answers).unwrap();
    let record = manager.questions.outbox().unwrap().remove(0);
    manager
        .queue_turn(
            &key,
            QueuedTurn {
                text: record.continuation(),
                images: vec![],
                turn_id: Some(record.turn_id()),
                appended_turn_ids: vec![],
                recorded: true,
                context: None,
            },
        )
        .unwrap();
    record_delivery(&key, Some(&record.turn_id()), "queued");
    chat_stop_impl(&manager, key.clone()).unwrap();
    assert!(manager.questions.pending().unwrap().is_empty());
    assert!(!manager.has_queued_turns(&key));
    assert!(manager.questions.answer(&answers).is_err());
    deliver_question_answers_with(manager.clone(), |_| {
        panic!("stopped work must stay stopped")
    })
    .unwrap();
    crate::transcript::forget(&key);
}

#[test]
fn an_answer_rejoins_a_live_persistent_agent_through_the_normal_send_path() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("question-live-{}", uuid::Uuid::new_v4());
    let mut origin = test_origin(&key);
    origin.start.agent = ChatAgent::Claude;
    origin.start.model = Some("claude-test".into());
    manager.remember_start(&key, origin.start.clone());
    let mut child = stand_in::echo()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take();
    manager.sessions.lock().unwrap().insert(
        key.clone(),
        Arc::new(Mutex::new(ChatSession {
            launch_id: "launch-1".into(),
            user_turn_id: None,
            answering: None,
            child,
            stdin,
            codex: None,
            agent: ChatAgent::Claude,
            busy: false,
            last_active: Instant::now(),
            cut_off: CutOff::No,
            auto_plan_refused: false,
            auto_plan_turn: AutoPlanTurn::default(),
            auto_plan_attribution: AutoPlanAttribution::Ready,
            leaving: None,
            first_turn_held: false,
        })),
    );
    let (id, _rx) = manager
        .questions
        .insert(
            origin,
            vec![serde_json::from_value(json!({"question": "Which database?"})).unwrap()],
        )
        .unwrap();
    let q = manager.questions.pending().unwrap().remove(0);
    manager.questions.detach(&id);
    manager
        .questions
        .answer(&[Answer {
            id: q.id,
            answer: "SQLite".into(),
        }])
        .unwrap();
    deliver_question_answers(manager.clone()).unwrap();
    let record = manager.questions.outbox().unwrap().remove(0);
    assert_eq!(question_receipt(&record).as_deref(), Some("dispatched"));
    assert!(manager.sessions.lock().unwrap()[&key].lock().unwrap().busy);
    deliver_question_answers(manager.clone()).unwrap();
    let prompts = crate::transcript::since(&key, 0)
        .iter()
        .filter(|r| r.event["type"] == "user")
        .count();
    assert_eq!(prompts, 1);
    received(&record);
    deliver_question_answers(manager.clone()).unwrap();
    assert!(manager.questions.pending().unwrap().is_empty());
    end_process(&manager, &key).unwrap();
    crate::transcript::forget(&key);
}

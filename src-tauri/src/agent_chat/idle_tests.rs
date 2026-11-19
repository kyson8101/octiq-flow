use super::*;

#[test]
fn a_resumed_worker_keeps_its_role_after_the_saved_environment_is_removed() {
    let manager = ChatManager::default();
    let run = crate::orchestration::tests::run(&manager.orchestrations);
    let legacy = format!("chat:legacy-worker-{}", uuid::Uuid::new_v4());
    let worker =
        crate::orchestration::tests::settled_worker(&manager.orchestrations, &run, Some(&legacy));
    manager.test_remember_start(&legacy, "/unused");
    let mut context = manager.start_context(&legacy).unwrap();
    context.env = Some(std::collections::BTreeMap::from([(
        "OCTIQ_ORCHESTRATION_ATTEMPT".into(),
        worker.id,
    )]));
    manager
        .orchestrations
        .save_resume_context(&legacy, context)
        .unwrap();
    let saved = manager
        .orchestrations
        .saved_resume_context(&legacy)
        .unwrap();
    assert!(saved.env.is_none());
    assert!(worker_launch_role(&manager, &legacy, saved.env.as_ref()).unwrap());
    assert!(worker_launch_role(&manager, "chat:orch-resumed", None).unwrap());
    assert!(!worker_launch_role(&manager, "chat:ordinary-resumed", None).unwrap());
}

/// A session with a real process behind it, last active `ago` back.
///
/// A real child rather than a fake one, because ending it is half of what
/// is being tested: `end_process` kills a `Child`, and a stand-in with no
/// process would let a sweeper that ends nothing pass.
fn still_session(busy: bool, ago: Duration) -> Arc<Mutex<ChatSession>> {
    let child = stand_in::still()
        .stdin(Stdio::piped())
        .spawn()
        .expect("a sleep to stand in for an agent");
    Arc::new(Mutex::new(ChatSession {
        last_active: Instant::now()
            .checked_sub(ago)
            .expect("a clock with some run-up behind it"),
        ..ChatSession::standing_in(child, None, ChatAgent::Claude, busy)
    }))
}

fn put(manager: &ChatManager, key: &str, session: Arc<Mutex<ChatSession>>) {
    manager
        .sessions
        .lock()
        .unwrap()
        .insert(key.to_string(), session);
}

#[test]
fn default_idle_timeout_is_five_minutes() {
    assert_eq!(IDLE_TIMEOUT, Duration::from_secs(5 * 60));
}

#[test]
fn native_background_work_keeps_an_idle_parent_alive_and_explicit_end_reports_ids() {
    let manager = ChatManager::default();
    let key = format!("chat:test-background-{}", uuid::Uuid::new_v4());
    put(
        &manager,
        &key,
        still_session(false, Duration::from_secs(20 * 60)),
    );
    manager.background.observe(&key, "test-launch", &json!({
            "type": "system", "subtype": "task_started", "task_id": "native-agent-42", "task_type": "local_agent"
        })).unwrap();
    assert!(sweep_still_chats(&manager, IDLE_TIMEOUT).is_empty());
    assert!(
        !manager.reap_settled_worker(&key).unwrap(),
        "native background work still owns the process"
    );
    assert!(manager.sessions.lock().unwrap().contains_key(&key));
    end_process(&manager, &key).unwrap();
    assert!(manager
        .background
        .continuation(&key)
        .unwrap()
        .contains("native-agent-42"));
    crate::transcript::forget(&key);
}

#[test]
fn idle_removal_rechecks_a_turn_that_started_after_the_sweep() {
    let manager = ChatManager::default();
    let key = "idle-recheck";
    let session = still_session(false, Duration::from_secs(20 * 60));
    put(&manager, key, session.clone());
    assert_eq!(still_keys(&manager, IDLE_TIMEOUT), vec![key]);
    session.lock().unwrap().turn_started();
    assert!(!end_process_when(&manager, key, Some(IDLE_TIMEOUT)).unwrap());
    end_process(&manager, key).unwrap();
}

/// Feedback db5e1001: Homebrew removed the Codex release a chat was
/// started from. The idle chat is ended, to resume on the installed one;
/// a chat mid-turn is left to finish.
#[test]
fn an_idle_chat_whose_program_was_removed_is_ended() {
    let dir = crate::test_dir::TestDir::new("replaced-binary");
    let release = dir.join("0.156.1");
    std::fs::create_dir_all(&release).unwrap();
    let program = release.join("codex");
    std::fs::write(&program, "").unwrap();
    let m = ChatManager::default();
    let busy = still_session(false, Duration::ZERO);
    put(&m, "chat-idle", still_session(false, Duration::ZERO));
    put(&m, "chat-busy", busy.clone());
    busy.lock().unwrap().turn_started();
    for key in ["chat-idle", "chat-busy", "chat-gone"] {
        m.binaries
            .lock()
            .unwrap()
            .insert(key.into(), program.clone());
    }
    assert!(
        sweep_replaced_binaries(&m).is_empty(),
        "the release is still there"
    );
    std::fs::remove_dir_all(&release).unwrap();
    assert_eq!(sweep_replaced_binaries(&m), vec!["chat-idle".to_string()]);
    assert!(m.has_process("chat-busy"), "a turn in flight is never cut");
    end_process(&m, "chat-busy").unwrap();
}

#[test]
fn a_chat_still_for_longer_than_the_timeout_is_ended() {
    let m = ChatManager::default();
    put(
        &m,
        "chat-a",
        still_session(false, Duration::from_secs(6 * 60)),
    );

    assert_eq!(
        sweep_still_chats(&m, IDLE_TIMEOUT),
        vec!["chat-a".to_string()]
    );
    assert!(
        chat_list_impl(&m).unwrap().is_empty(),
        "and it is gone from the map, so the next message starts a fresh one"
    );
}

#[test]
fn chat_activity_says_which_running_chats_are_mid_turn() {
    let m = ChatManager::default();
    put(
        &m,
        "chat:working",
        still_session(true, Duration::from_secs(60)),
    );
    put(
        &m,
        "chat:idle",
        still_session(false, Duration::from_secs(60)),
    );
    let mut activity = chat_activity_impl(&m).unwrap();
    activity.sort_by(|a, b| a.key.cmp(&b.key));
    assert_eq!(
        activity,
        vec![
            ChatActivity {
                key: "chat:idle".into(),
                busy: false,
                completing: false,
            },
            ChatActivity {
                key: "chat:working".into(),
                busy: true,
                completing: false,
            },
        ]
    );
    end_process(&m, "chat:working").unwrap();
    end_process(&m, "chat:idle").unwrap();
    assert!(chat_activity_impl(&m).unwrap().is_empty());
}

#[test]
fn a_chat_still_for_less_than_the_timeout_is_left_alone() {
    let m = ChatManager::default();
    put(
        &m,
        "chat-a",
        still_session(false, Duration::from_secs(4 * 60)),
    );

    assert!(sweep_still_chats(&m, IDLE_TIMEOUT).is_empty());
    assert_eq!(chat_list_impl(&m).unwrap().len(), 1);
}

#[test]
fn a_working_chat_is_never_ended_however_long_it_has_been_working() {
    // The one that would hurt. An agent part-way through a long tool call
    // — a build, a test suite, a question waiting on the person — produces
    // no output at all while it waits, so a sweeper reading silence would
    // kill exactly the turn nobody could afford to lose. `busy` is what
    // separates "nothing is happening" from "nothing is being said".
    let m = ChatManager::default();
    put(
        &m,
        "chat-a",
        still_session(true, Duration::from_secs(3 * 60 * 60)),
    );

    assert!(sweep_still_chats(&m, IDLE_TIMEOUT).is_empty());
    assert_eq!(chat_list_impl(&m).unwrap().len(), 1);
}

#[test]
fn retargeting_ends_the_agent_and_keeps_conversation_permissions() {
    let m = ChatManager::default();
    put(&m, "retarget-chat", still_session(false, Duration::ZERO));
    with_access(|access| access.insert("retarget-chat".into(), Access::Auto));
    m.remember_start(
        "retarget-chat",
        StartContext {
            defaults: None,
            cwd: "/tmp".into(),
            agent: ChatAgent::Claude,
            model: Some("claude-opus-4-6".into()),
            access: Some(Access::Auto),
            extra_dirs: None,
            env: None,
            effort: None,
            lite: None,
            session_id: Some("old-claude-session".into()),
        },
    );

    chat_retarget_impl(&m, "retarget-chat".into()).unwrap();

    assert!(chat_list_impl(&m).unwrap().is_empty());
    assert!(m.start_context("retarget-chat").is_none());
    assert!(with_access(|access| access.contains_key("retarget-chat")));
}

#[test]
fn a_restart_keeps_what_stopping_would_drop() {
    // The whole reason this is not `chat_stop_impl`. Stopping forgets the
    // standing permissions and the access level because the person said
    // they were FINISHED; a restart is the same work carrying on, and
    // re-asking about a command already allowed "always" would be a
    // decision quietly taken back.
    let m = ChatManager::default();
    put(&m, "restart-access", still_session(false, Duration::ZERO));
    with_access(|a| a.insert("restart-access".into(), Access::Auto));

    assert_eq!(chat_restart_impl(&m, "restart-access".into()), Ok(1));
    assert!(
        with_access(|a| a.contains_key("restart-access")),
        "the level the work is being done at outlives the process doing it"
    );

    // And stopping, for contrast, is where it goes.
    put(&m, "restart-access", still_session(false, Duration::ZERO));
    chat_stop_impl(&m, "restart-access".into()).unwrap();
    assert!(!with_access(|a| a.contains_key("restart-access")));
}

#[test]
fn restarting_a_chat_with_no_process_ends_nothing() {
    // The button is only offered while something is running, but a chat can
    // be swept between the tap and the call. Nothing to end is not a
    // failure — the next message was going to spawn a fresh agent anyway.
    let m = ChatManager::default();
    assert_eq!(chat_restart_impl(&m, "never-started".into()), Ok(0));
}

#[test]
fn every_agents_full_stop_ends_a_turn_and_nothing_else_does() {
    assert!(
        provider_for(ChatAgent::Claude)
            .observe_event(&json!({ "type": "result", "subtype": "success" }))
            .turn_finished
    );
    assert!(
        provider_for(ChatAgent::Codex)
            .observe_event(&json!({ "type": "turn.completed" }))
            .turn_finished
    );
    // A failed turn has ended just as surely as a good one. Reading only
    // the happy word would leave a Codex chat that errored looking busy
    // for the rest of its life, and it would never be swept.
    assert!(
        provider_for(ChatAgent::Codex)
            .observe_event(&json!({ "type": "turn.failed" }))
            .turn_finished
    );
    assert!(
        provider_for(ChatAgent::Pi)
            .observe_event(&json!({ "type": "agent_settled" }))
            .turn_finished
    );
    assert!(
        !provider_for(ChatAgent::Pi)
            .observe_event(&json!({ "type": "agent_end", "willRetry": false }))
            .turn_finished
    );

    assert!(
        !provider_for(ChatAgent::Claude)
            .observe_event(&json!({ "type": "assistant" }))
            .turn_finished
    );
    assert!(
        !provider_for(ChatAgent::Claude)
            .observe_event(&json!({ "type": "stream_event" }))
            .turn_finished
    );
    assert!(
        !provider_for(ChatAgent::Codex)
            .observe_event(&json!({ "type": "thread.started" }))
            .turn_finished
    );
    assert!(
        !provider_for(ChatAgent::Pi)
            .observe_event(&json!({ "type": "turn_end" }))
            .turn_finished
    );
}

#[test]
fn the_preview_reads_only_the_main_conversations_readable_words() {
    let claude = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"First "},{"type":"tool_use","name":"Bash"},{"type":"text","text":"second"}]}});
    assert_eq!(
        HostPreview::words(&claude, None).as_deref(),
        Some("First \nsecond")
    );
    let sub = json!({"type":"assistant","parent_tool_use_id":"toolu_1","message":{"content":[{"type":"text","text":"sub"}]}});
    assert_eq!(HostPreview::words(&sub, None), None);
    let only_tool = json!({"type":"assistant","message":{"content":[{"type":"tool_use"}]}});
    assert_eq!(HostPreview::words(&only_tool, None), None);
    assert_eq!(HostPreview::words(&json!({"type":"user"}), None), None);
    // Codex and Pi hand their words over already read.
    assert_eq!(
        HostPreview::words(&json!({"type":"item.completed"}), Some(" said ")).as_deref(),
        Some("said")
    );
    assert_eq!(HostPreview::words(&json!({}), Some("  ")), None);
}

#[test]
fn one_batch_collects_the_newest_text_and_writes_it_once_due() {
    let batch = PreviewBatch::default();
    let t0 = Instant::now();
    batch.submit("a", "one".into(), t0, Duration::from_secs(4));
    batch.submit("b", "other".into(), t0, Duration::from_secs(4));
    batch.submit(
        "a",
        "two".into(),
        t0 + Duration::from_secs(1),
        Duration::from_secs(4),
    );
    assert!(batch.take_due(t0 + Duration::from_secs(3)).is_none());
    // The first ask's time stands, and everything pending goes with it.
    let mut due = batch.take_due(t0 + Duration::from_secs(4)).unwrap();
    due.sort();
    assert_eq!(
        due,
        vec![
            ("a".to_string(), "two".to_string(), 0),
            ("b".to_string(), "other".to_string(), 0)
        ]
    );
    assert!(batch.take_due(t0 + Duration::from_secs(60)).is_none());
    // A turn's end brings the whole batch forward.
    batch.submit("a", "x".into(), t0, Duration::from_secs(4));
    batch.submit("b", "y".into(), t0, Duration::from_secs(1));
    assert_eq!(
        batch.take_due(t0 + Duration::from_secs(1)).unwrap().len(),
        2
    );
    batch.submit("a", "z".into(), t0, Duration::ZERO);
    batch.withdraw("a");
    assert!(batch.take_due(t0 + Duration::from_secs(60)).is_none());
}

#[test]
fn the_index_is_not_rewritten_more_often_than_the_gap() {
    let t0 = Instant::now();
    let mut pending = HashMap::new();
    assert_eq!(PreviewBatch::next_write(&pending, None, t0), None);
    pending.insert("a".to_string(), ("x".to_string(), t0, 0));
    // Nothing written lately: due now.
    assert_eq!(PreviewBatch::next_write(&pending, None, t0), Some(t0));
    // Just written: wait out the gap even though the preview is due.
    assert_eq!(
        PreviewBatch::next_write(&pending, Some(t0), t0),
        Some(t0 + PreviewBatch::MIN_GAP)
    );
    // A later due time is not brought forward by the gap.
    pending.insert(
        "a".to_string(),
        ("x".to_string(), t0 + Duration::from_secs(4), 0),
    );
    assert_eq!(
        PreviewBatch::next_write(&pending, Some(t0), t0),
        Some(t0 + Duration::from_secs(4))
    );
}

#[test]
fn a_turn_that_did_not_end_cleanly_leaves_the_previous_preview() {
    let key = "chat:failed-turn-preview-test";
    let mut preview = HostPreview::default();
    let ours = |due: Vec<(String, String, u64)>| {
        due.into_iter()
            .any(|(id, _, _)| id == "failed-turn-preview-test")
    };
    // A failed turn: the words it had heard are withdrawn, none written.
    preview.heard(key, key, "half an answer".into());
    preview.turn_ended(key, key, None);
    let later = Instant::now() + Duration::from_secs(3600);
    assert!(!ours(
        PreviewBatch::global().take_due(later).unwrap_or_default()
    ));
    // A clean one is due at once and handed to the index write on the
    // spot (this chat is not listed, so nothing lands): not left waiting.
    preview.heard(key, key, "half an answer".into());
    preview.turn_ended(key, key, Some("the closing words"));
    assert!(!ours(
        PreviewBatch::global().take_due(later).unwrap_or_default()
    ));
    // A worker's chat is nobody's row.
    let worker = "chat:orch-abc";
    preview.heard(worker, worker, "x".into());
    preview.turn_ended(worker, worker, Some("done"));
    assert!(!PreviewBatch::global()
        .take_due(later)
        .unwrap_or_default()
        .iter()
        .any(|(id, _, _)| id == "orch-abc"));
}

#[test]
fn a_clear_wins_over_text_already_taken_out_of_the_queue() {
    // The reviewer's probe: the writer has drained its text and is about
    // to take the index lock when `/clear` runs. The old text must not
    // land after the clear.
    let id = "clear-vs-detached-batch-test";
    let _ = crate::chat_index::remove(id);
    crate::chat_index::upsert(
        serde_json::from_value(json!({"id": id, "projectId": "p", "title": "t"})).unwrap(),
    )
    .unwrap();
    let batch = PreviewBatch::default();
    batch.submit(id, "old words".into(), Instant::now(), Duration::ZERO);
    let detached = batch.take_due(Instant::now()).unwrap();
    // /clear, exactly as `chat_forget_impl` does it.
    batch.withdraw(id);
    crate::chat_index::clear_host_preview(id).unwrap();
    batch.write_batch(detached);
    let row = || {
        crate::chat_index::list()
            .into_iter()
            .find(|chat| chat.id == id)
            .unwrap()
    };
    assert_eq!(
        row().latest_response,
        None,
        "the old text landed after /clear"
    );
    assert_eq!(row().latest_response_version, 1);
    // Words heard after the clear are a new conversation's and land.
    batch.submit(id, "new words".into(), Instant::now(), Duration::ZERO);
    let due = batch.take_due(Instant::now()).unwrap();
    batch.write_batch(due);
    assert_eq!(row().latest_response.as_deref(), Some("new words"));
    let _ = crate::chat_index::remove(id);
}

#[test]
fn a_flush_writes_what_is_pending_even_when_it_is_not_due() {
    // Graceful shutdown: a closing preview still inside the gap, and a
    // mid-turn one hours from its deadline, reach the index.
    let id = "flush-at-shutdown-test";
    let _ = crate::chat_index::remove(id);
    crate::chat_index::upsert(
        serde_json::from_value(json!({"id": id, "projectId": "p", "title": "t"})).unwrap(),
    )
    .unwrap();
    let batch: &'static PreviewBatch = Box::leak(Box::default());
    *batch.last_write.lock().unwrap() = Some(Instant::now());
    batch.submit(
        id,
        "closing words".into(),
        Instant::now(),
        Duration::from_secs(3600),
    );
    batch.write_due();
    let row = || {
        crate::chat_index::list()
            .into_iter()
            .find(|chat| chat.id == id)
            .unwrap()
    };
    assert_eq!(row().latest_response, None, "not due: the gap holds it");
    batch.flush();
    assert_eq!(row().latest_response.as_deref(), Some("closing words"));
    assert!(batch.take_all().is_none(), "nothing is left owed");
    let _ = crate::chat_index::remove(id);
}

#[test]
fn a_write_that_failed_is_owed_until_newer_text_or_a_withdrawal() {
    let batch = PreviewBatch::default();
    let now = Instant::now();
    let take = |batch: &PreviewBatch| batch.take_due(now + Duration::from_secs(60));
    batch.submit("a", "one".into(), now, Duration::ZERO);
    batch.submit("b", "two".into(), now, Duration::ZERO);
    batch.submit("c", "three".into(), now, Duration::ZERO);
    let taken = take(&batch).unwrap();
    // While the write is out: b is withdrawn (a failed turn), c is
    // replaced by newer text.
    batch.withdraw("b");
    batch.submit("c", "newer".into(), now, Duration::ZERO);
    batch.requeue(taken, now);
    let mut back = take(&batch).unwrap();
    back.sort();
    assert_eq!(
        back,
        vec![
            ("a".to_string(), "one".to_string(), 0),
            ("c".to_string(), "newer".to_string(), 0)
        ]
    );
    // A write that went through owes nothing.
    batch.submit("a", "x".into(), now, Duration::ZERO);
    let done = take(&batch).unwrap();
    batch.finished(&done);
    batch.requeue(done, now);
    assert!(take(&batch).is_none());
}

#[test]
fn previews_owed_during_an_outage_are_named_and_clear_when_written() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _process = crate::profile::started_in(&home.dir);
    let id = "owed-previews-outage-test";
    let _ = crate::chat_index::remove(id);
    crate::chat_index::upsert(
        serde_json::from_value(json!({"id": id, "projectId": "p", "title": "t"})).unwrap(),
    )
    .unwrap();
    let batch = PreviewBatch::default();
    batch.submit(id, "closing words".into(), Instant::now(), Duration::ZERO);
    assert!(!batch.owes(), "text waiting for its time is not owed");
    let said = crate::bus::tap::Tap::on("the latest chat previews");
    home.unplug();
    batch.write_due();
    assert!(batch.owes(), "a failed write is owed");
    assert!(batch.settle().is_err(), "still away: still owed");
    assert!(
        said.heard().iter().any(|(name, _)| name == "unsaved"),
        "the failure reaches the pages as `unsaved`"
    );
    home.plug_back();
    // The retry waits out `MIN_GAP`; the test does not.
    *batch.last_write.lock().unwrap() = None;
    batch.settle().expect("the profile is back: written");
    assert!(!batch.owes(), "the item clears once written");
    let row = crate::chat_index::list()
        .into_iter()
        .find(|chat| chat.id == id)
        .unwrap();
    assert_eq!(row.latest_response.as_deref(), Some("closing words"));
    let _ = crate::chat_index::remove(id);
}

/// A write that fails for chat A, whose previews are then withdrawn,
/// leaves nothing owed: B's first text, only waiting for its due time,
/// must not read as the old debt (review of 3010b9fd, M1).
#[test]
fn a_withdrawn_failure_does_not_make_a_later_not_due_text_owed() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _process = crate::profile::started_in(&home.dir);
    let (a, b) = ("owed-edge-a-test", "owed-edge-b-test");
    for id in [a, b] {
        let _ = crate::chat_index::remove(id);
        crate::chat_index::upsert(
            serde_json::from_value(json!({"id": id, "projectId": "p", "title": "t"})).unwrap(),
        )
        .unwrap();
    }
    let batch = PreviewBatch::default();
    batch.submit(a, "a text".into(), Instant::now(), Duration::ZERO);
    home.unplug();
    batch.write_due();
    assert!(batch.owes(), "A's failed write is owed");
    // A's turn fails: its previews are withdrawn, nothing is left to owe.
    batch.withdraw(a);
    // B's first readable text is five seconds from due and the queue was
    // never sampled empty in between.
    batch.submit(b, "b text".into(), Instant::now(), Duration::from_secs(4));
    assert!(
        !batch.owes(),
        "text only waiting for its due time is never owed"
    );
    assert!(batch.settle().is_ok(), "settle has nothing to retry");
    // The next failure is a new run and is said again.
    let said = crate::bus::tap::Tap::on("the latest chat previews");
    batch.submit(b, "b again".into(), Instant::now(), Duration::ZERO);
    *batch.last_write.lock().unwrap() = None;
    batch.write_due();
    assert!(batch.owes());
    assert!(said.heard().iter().any(|(name, _)| name == "unsaved"));
    home.plug_back();
    *batch.last_write.lock().unwrap() = None;
    batch.settle().expect("written");
    assert!(!batch.owes());
    for id in [a, b] {
        let _ = crate::chat_index::remove(id);
    }
}

/// Newer text for the SAME chat supersedes a failed write: the failed
/// text is no longer the debt, and the newer one is owed only if it
/// fails in its own turn. (Decision: superseded is not owed.)
#[test]
fn newer_not_due_text_for_the_same_chat_replaces_a_failed_one() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _process = crate::profile::started_in(&home.dir);
    let id = "owed-supersede-test";
    let _ = crate::chat_index::remove(id);
    crate::chat_index::upsert(
        serde_json::from_value(json!({"id": id, "projectId": "p", "title": "t"})).unwrap(),
    )
    .unwrap();
    let batch = PreviewBatch::default();
    batch.submit(id, "old".into(), Instant::now(), Duration::ZERO);
    home.unplug();
    batch.write_due();
    assert!(batch.owes());
    batch.submit(id, "newer".into(), Instant::now(), Duration::from_secs(4));
    assert!(!batch.owes(), "the newer text supersedes the failed one");
    // Once it is due and fails, it is owed in its own right.
    batch.submit(id, "newer".into(), Instant::now(), Duration::ZERO);
    *batch.last_write.lock().unwrap() = None;
    batch.write_due();
    assert!(batch.owes());
    home.plug_back();
    *batch.last_write.lock().unwrap() = None;
    batch.settle().expect("written");
    assert!(!batch.owes());
    let row = crate::chat_index::list()
        .into_iter()
        .find(|chat| chat.id == id)
        .unwrap();
    assert_eq!(row.latest_response.as_deref(), Some("newer"));
    let _ = crate::chat_index::remove(id);
}

#[test]
fn claude_puts_its_closing_words_on_its_own_full_stop() {
    let end = json!({ "type": "result", "result": "the migration is reversible" });
    assert_eq!(
        provider_for(ChatAgent::Claude)
            .observe_event(&end)
            .final_text,
        Some("the migration is reversible"),
        "the carried line must never win over words the event carries itself"
    );
}

#[test]
fn codexs_closing_words_have_to_be_kept_as_they_go_past() {
    // `turn.completed` carries a usage block and NOTHING else, so the last
    // spoken text must be retained before the boundary arrives.
    let spoke = json!({
        "type": "item.completed",
        "item": { "id": "item_4", "type": "agent_message", "text": "Hi! I am Codex." },
    });
    assert_eq!(
        provider_for(ChatAgent::Codex)
            .observe_event(&spoke)
            .spoken_text,
        Some("Hi! I am Codex.")
    );

    // Everything else it says as it works is machinery, not an answer.
    assert_eq!(
        provider_for(ChatAgent::Codex)
            .observe_event(&json!({
                "type": "item.completed",
                "item": { "id": "item_1", "type": "command_execution" },
            }))
            .spoken_text,
        None
    );
    assert_eq!(
        provider_for(ChatAgent::Codex)
            .observe_event(&json!({
                "type": "item.started",
                "item": { "id": "item_4", "type": "agent_message", "text": "half a" },
            }))
            .spoken_text,
        None,
        "only a COMPLETED message is what the turn ended on"
    );

    let end = json!({ "type": "turn.completed", "usage": { "output_tokens": 448 } });
    assert!(
        provider_for(ChatAgent::Codex)
            .observe_event(&end)
            .turn_finished
    );
    // A turn that failed before saying anything ends on nothing, which is
    // honest — better than the last thing said two turns ago.
    assert!(
        provider_for(ChatAgent::Codex)
            .observe_event(&json!({ "type": "turn.failed" }))
            .turn_finished
    );
}

#[test]
fn every_agent_names_the_conversation_it_opened() {
    // One field each, under two names, meaning the same thing: the id that
    // resumes this chat. Kept so the backend can restart a host it swept
    // and hand it the follow-up — see `StartContext`.
    assert_eq!(
        provider_for(ChatAgent::Claude)
            .observe_event(&json!({
                "type": "system", "subtype": "init", "session_id": "abc-123",
            }))
            .session_id,
        Some("abc-123")
    );
    assert_eq!(
        provider_for(ChatAgent::Codex)
            .observe_event(&json!({ "type": "thread.started", "thread_id": "01a0-2f39" }))
            .session_id,
        Some("01a0-2f39")
    );
    assert_eq!(
        provider_for(ChatAgent::Pi)
            .observe_event(&json!({ "type": "session", "id": "pi-123" }))
            .session_id,
        Some("pi-123")
    );
    // Said once, in the opening event, and never again. Anything else that
    // happens to carry the field is not the announcement.
    assert_eq!(
        provider_for(ChatAgent::Claude)
            .observe_event(&json!({
                "type": "system", "subtype": "status", "session_id": "abc-123",
            }))
            .session_id,
        None
    );
    assert_eq!(
        provider_for(ChatAgent::Claude)
            .observe_event(&json!({ "type": "assistant" }))
            .session_id,
        None
    );
}

#[test]
fn a_turn_written_to_a_session_makes_it_busy_again() {
    // The other half of the pair: `turn_started` is what stops a chat
    // being swept out from under a message sent a second ago.
    let session = still_session(false, Duration::from_secs(20 * 60));
    assert!(session.lock().unwrap().still_for().is_some());

    session.lock().unwrap().turn_started();
    assert!(session.lock().unwrap().still_for().is_none());

    session.lock().unwrap().turn_ended();
    assert!(
        session.lock().unwrap().still_for().unwrap() < Duration::from_secs(1),
        "and the clock restarts from the end of the turn, not from before it"
    );
}

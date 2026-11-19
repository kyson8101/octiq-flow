
use super::tests::{claude_session, hold};
use super::*;

/// A chat the index lists, with a live stand-in Claude under its key.
struct Listed {
    manager: Arc<ChatManager>,
    id: String,
    key: String,
    session: Arc<Mutex<ChatSession>>,
}

impl Listed {
    fn new(busy: bool) -> Self {
        Self::with(claude_session(busy))
    }

    fn with(session: Arc<Mutex<ChatSession>>) -> Self {
        let id = format!("complete-{}", uuid::Uuid::new_v4().simple());
        let key = format!("chat:{id}");
        crate::chat_index::upsert(
            serde_json::from_value(json!({
                "id": id, "projectId": "p1", "title": "a chat", "updatedAt": 100,
            }))
            .unwrap(),
        )
        .unwrap();
        let manager = Arc::new(ChatManager::default());
        hold(&manager, &key, session.clone());
        Self {
            manager,
            id,
            key,
            session,
        }
    }

    fn complete(&self) -> Completing {
        chat_complete_impl(&self.manager, &self.key, "wrap up")
            .expect("the chat can be completed")
            .expect("it has a process")
    }

    fn send(&self, text: &str, id: &str) {
        chat_send_user_impl(
            self.manager.clone(),
            self.key.clone(),
            text.into(),
            None,
            None,
            Some(id.into()),
            None,
        )
        .expect("a message from the person");
    }

    /// What the stdout reader does when the turn in flight reaches its
    /// full stop: `Some(true)` when that closed the chat, `Some(false)`
    /// when it was the wrap-up and the completion is off.
    fn full_stop(&self, clean: bool) -> Option<bool> {
        let (wrap_up, refused) = {
            let mut running = self.session.lock().unwrap();
            end_turn_locked(&self.manager, &self.key, &self.key, &mut running, clean)
        };
        assert_eq!(refused, None);
        wrap_up.map(|ended| settle_wrap_up(&self.manager, &self.key, &self.session, ended))
    }

    fn answering(&self) -> Option<String> {
        self.session.lock().unwrap().answering.clone()
    }

    fn busy(&self) -> bool {
        self.session.lock().unwrap().busy
    }

    fn stop(&self) {
        chat_interrupt_impl(&self.manager, self.key.clone()).expect("Stop");
    }

    fn queued(&self) -> Vec<String> {
        chat_queue_state_impl(&self.manager, &self.key)
            .unwrap()
            .queued_turn_ids
    }

    fn completing(&self) -> Option<String> {
        self.manager.completing_turn(&self.key)
    }

    /// The wrap-up's clean full stop as the reader takes it, decided and
    /// not yet acted on: the reader writes the full stop down in between.
    fn wrap_up_full_stop(&self) -> WrapUpEnded {
        let (wrap_up, refused) = {
            let mut running = self.session.lock().unwrap();
            end_turn_locked(&self.manager, &self.key, &self.key, &mut running, true)
        };
        assert_eq!(refused, None);
        wrap_up.expect("the wrap-up's own full stop")
    }

    /// What `start_session` does to the session table and the index when
    /// this chat is started again, with `process` standing in for the
    /// agent it would spawn. Refused, in its words, while a process is
    /// there.
    fn start(&self, process: Arc<Mutex<ChatSession>>) -> Result<Arc<Mutex<ChatSession>>, String> {
        {
            let mut sessions = self.manager.sessions.lock().unwrap();
            if sessions.contains_key(&self.key) || self.manager.claimed_elsewhere(&self.key) {
                return Err(format!("chat '{}' is already running", self.key));
            }
            sessions.insert(self.key.clone(), process.clone());
        }
        reopen_started_chat(&self.key, &self.key);
        Ok(process)
    }

    /// Started again with a message: a Claude with a turn in flight.
    fn start_again(&self) -> Result<Arc<Mutex<ChatSession>>, String> {
        let process = claude_session(true);
        process.lock().unwrap().answering = Some("user-again".into());
        self.start(process)
    }

    /// The process in the session table, if it is `process`.
    fn runs(&self, process: &Arc<Mutex<ChatSession>>) -> bool {
        self.manager
            .sessions
            .lock()
            .unwrap()
            .get(&self.key)
            .is_some_and(|current| Arc::ptr_eq(current, process))
    }

    fn row(&self) -> crate::chat_index::ChatMeta {
        crate::chat_index::list()
            .into_iter()
            .find(|chat| chat.id == self.id)
            .expect("the chat's row")
    }

    fn live(&self) -> bool {
        self.manager.has_process(&self.key)
    }
}

impl Drop for Listed {
    fn drop(&mut self) {
        let _ = end_process(&self.manager, &self.key);
        let _ = crate::chat_index::remove(&self.id);
        crate::transcript::forget(&self.key);
    }
}

#[test]
fn completing_an_idle_chat_hands_its_agent_the_wrap_up_at_once() {
    let chat = Listed::new(false);
    let completing = chat.complete();

    assert_eq!(completing.state, "started");
    assert!(completing.turn_id.starts_with(COMPLETION_TURN_PREFIX));
    assert_eq!(chat.answering(), Some(completing.turn_id.clone()));
    assert!(chat.session.lock().unwrap().busy);
    assert_eq!(
        chat.manager.completing_turn(&chat.key),
        Some(completing.turn_id.clone())
    );
    // The wrap-up is in the record as the turn it is, in the host's words.
    let recorded = crate::transcript::since(&chat.key, 0);
    assert_eq!(recorded[0].event["uuid"], completing.turn_id.as_str());
    assert_eq!(
        recorded[0].event["message"]["content"][0]["text"],
        "wrap up"
    );
    // A reloaded page reads the state where it reads the queue.
    let state =
        serde_json::to_value(chat_queue_state_impl(&chat.manager, &chat.key).unwrap()).unwrap();
    assert_eq!(state["completingTurnId"], completing.turn_id.as_str());
    let activity = serde_json::to_value(chat_activity_impl(&chat.manager).unwrap()).unwrap();
    assert_eq!(activity[0]["completing"], true);
}

#[test]
fn a_wrap_up_waits_behind_the_running_turn_and_never_interrupts_it() {
    let chat = Listed::new(true);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    let completing = chat.complete();

    assert_eq!(completing.state, "queued");
    assert_eq!(
        chat.answering().as_deref(),
        Some("user-0"),
        "the running turn was left alone"
    );
    assert_eq!(
        chat_queue_state_impl(&chat.manager, &chat.key)
            .unwrap()
            .queued_turn_ids,
        [completing.turn_id.clone()]
    );
    // The running turn's own full stop is nobody's completion, however it
    // ended, and it hands the wrap-up over.
    assert_eq!(chat.full_stop(false), None);
    assert_eq!(chat.answering(), Some(completing.turn_id.clone()));
    assert!(!chat.row().is_done());
    assert!(chat.live());
    // Then the wrap-up's own.
    assert_eq!(chat.full_stop(true), Some(true));
    assert!(chat.row().is_done());
    assert!(!chat.live());
}

#[test]
fn a_wrap_up_that_ends_cleanly_ticks_the_chat_and_stops_its_process() {
    let chat = Listed::new(false);
    crate::permission::forget_chat(&chat.key);
    record_access_for(&chat.key, Some(Access::Auto));
    chat.complete();

    assert_eq!(chat.full_stop(true), Some(true));

    let row = chat.row();
    assert!(row.is_done());
    assert!(row.done_held);
    assert!(!chat.live(), "the process is out of the session table");
    assert_eq!(chat.manager.completing_turn(&chat.key), None);
    assert_eq!(access_now(&chat.key), None, "stopped the way Stop stops it");
    let exited = (0..100).any(|_| {
        let gone = chat
            .session
            .lock()
            .unwrap()
            .child
            .try_wait()
            .is_ok_and(|status| status.is_some());
        if !gone {
            thread::sleep(Duration::from_millis(50));
        }
        gone
    });
    assert!(exited, "and it was ended, not left running");
    // The page's own record of that turn's end does not retire the tick.
    let mut ended = chat.row();
    ended.updated_at = row.done_at.unwrap() + 5_000;
    crate::chat_index::upsert(ended).unwrap();
    assert!(chat.row().is_done());
}

#[test]
fn stopping_the_wrap_up_leaves_the_chat_unticked_and_running() {
    let chat = Listed::new(false);
    chat.complete();

    chat_interrupt_impl(&chat.manager, chat.key.clone()).expect("Stop");

    assert_eq!(chat.manager.completing_turn(&chat.key), None);
    // The cut-off turn's own full stop arrives later, and decides nothing.
    assert_eq!(chat.full_stop(false), None);
    assert_eq!(chat.full_stop(true), None);
    assert!(!chat.row().is_done());
    assert!(chat.live());
}

#[test]
fn stopping_the_turn_ahead_of_a_queued_wrap_up_keeps_the_completion() {
    let chat = Listed::new(true);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    let completing = chat.complete();

    chat_interrupt_impl(&chat.manager, chat.key.clone()).expect("Stop");

    // Stop keeps the queue: the wrap-up is what starts next.
    assert_eq!(
        chat.manager.completing_turn(&chat.key),
        Some(completing.turn_id.clone())
    );
    assert_eq!(chat.full_stop(false), None);
    assert_eq!(chat.answering(), Some(completing.turn_id));
    assert_eq!(chat.full_stop(true), Some(true));
    assert!(chat.row().is_done());
}

#[test]
fn a_wrap_up_that_fails_leaves_the_chat_unticked_and_running() {
    let chat = Listed::new(false);
    chat.complete();

    assert_eq!(chat.full_stop(false), Some(false));

    assert!(!chat.row().is_done());
    assert!(chat.live());
    assert_eq!(chat.manager.completing_turn(&chat.key), None);
    // And the chat can be completed again.
    assert_eq!(chat.complete().state, "started");
}

#[test]
fn a_message_queued_behind_the_wrap_up_wins_and_runs() {
    let chat = Listed::new(false);
    let completing = chat.complete();
    chat.send("one more thing", "user-9");
    assert_eq!(
        chat_queue_state_impl(&chat.manager, &chat.key)
            .unwrap()
            .queued_turn_ids,
        ["user-9"],
        "its own turn, never folded into the wrap-up"
    );

    assert_eq!(chat.full_stop(true), Some(false));

    assert!(!chat.row().is_done());
    assert!(chat.live());
    assert_eq!(chat.manager.completing_turn(&chat.key), None);
    assert_eq!(chat.answering().as_deref(), Some("user-9"));
    assert!(chat.session.lock().unwrap().busy, "and it is running");
    assert_ne!(chat.answering(), Some(completing.turn_id));
}

#[test]
fn a_wrap_up_is_never_folded_into_the_message_queued_before_it() {
    let chat = Listed::new(true);
    chat.send("first", "user-1");
    let completing = chat.complete();
    chat.send("after", "user-2");

    let queued = chat_queue_state_impl(&chat.manager, &chat.key)
        .unwrap()
        .queued_turn_ids;
    assert_eq!(queued, ["user-1", completing.turn_id.as_str(), "user-2"]);
}

#[test]
fn cancelling_the_queued_wrap_up_takes_the_completion_back() {
    let chat = Listed::new(true);
    let completing = chat.complete();

    assert_eq!(
        chat_cancel_queued_impl(&chat.manager, chat.key.clone(), completing.turn_id.clone()),
        Ok(true)
    );

    assert_eq!(chat.manager.completing_turn(&chat.key), None);
    assert_eq!(chat.full_stop(true), None, "the running turn just ends");
    assert!(!chat.row().is_done());
    assert!(chat.live());
}

#[test]
fn sending_the_queued_wrap_up_now_interrupts_and_still_completes() {
    let chat = Listed::new(true);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    let completing = chat.complete();

    assert_eq!(
        chat_start_queued_impl(&chat.manager, chat.key.clone(), completing.turn_id.clone()),
        Ok(true)
    );
    assert_eq!(
        chat.manager.completing_turn(&chat.key),
        Some(completing.turn_id),
        "it was the turn ahead that was cut short"
    );
    assert_eq!(chat.full_stop(false), None);
    assert_eq!(chat.full_stop(true), Some(true));
    assert!(chat.row().is_done());
}

#[test]
fn sending_another_queued_message_now_cuts_the_wrap_up_short() {
    let chat = Listed::new(false);
    chat.complete();
    chat.send("do this instead", "user-9");

    assert_eq!(
        chat_start_queued_impl(&chat.manager, chat.key.clone(), "user-9".into()),
        Ok(true)
    );

    assert_eq!(chat.manager.completing_turn(&chat.key), None);
    assert_eq!(chat.full_stop(false), None);
    assert_eq!(chat.answering().as_deref(), Some("user-9"));
    assert!(!chat.row().is_done());
}

#[test]
fn a_chat_that_is_completing_cannot_be_completed_twice() {
    let chat = Listed::new(true);
    chat.complete();
    assert_eq!(
        chat_complete_impl(&chat.manager, &chat.key, "wrap up"),
        Err(ALREADY_COMPLETING.into())
    );
    assert_eq!(
        chat_queue_state_impl(&chat.manager, &chat.key)
            .unwrap()
            .queued_turn_ids
            .len(),
        1,
        "the refused one queued nothing"
    );
}

#[test]
fn an_ordinary_send_cannot_go_round_a_queued_wrap_up() {
    let chat = Listed::new(true);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    let completing = chat.complete();
    // Stop ends the turn at once: the session reads idle with the
    // wrap-up still waiting for the reader to hand it over.
    chat_interrupt_impl(&chat.manager, chat.key.clone()).expect("Stop");
    assert!(!chat.session.lock().unwrap().busy);

    chat.send("in the gap", "user-9");

    assert_eq!(
        chat.answering().as_deref(),
        Some("user-0"),
        "nothing was written past the queue"
    );
    assert_eq!(
        chat_queue_state_impl(&chat.manager, &chat.key)
            .unwrap()
            .queued_turn_ids,
        [completing.turn_id.as_str(), "user-9"]
    );
    // The wrap-up goes first, and the message behind it then wins.
    assert_eq!(chat.full_stop(false), None);
    assert_eq!(chat.answering(), Some(completing.turn_id));
    assert_eq!(chat.full_stop(true), Some(false));
    assert_eq!(chat.answering().as_deref(), Some("user-9"));
    assert!(!chat.row().is_done());
}

#[test]
fn a_message_that_reaches_the_agent_before_the_chat_is_closed_wins() {
    let chat = Listed::new(false);
    let completing = chat.complete();
    // The wrap-up's full stop is read and decided...
    let (wrap_up, _) = {
        let mut running = chat.session.lock().unwrap();
        end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true)
    };
    assert_eq!(
        wrap_up,
        Some(WrapUpEnded::Close {
            turn_id: completing.turn_id,
            starts: crate::chat_index::starts(&chat.id),
        })
    );
    // ...and before it is acted on the person sends, to an idle agent.
    chat.send("wait, one more", "user-9");

    assert!(!settle_wrap_up(
        &chat.manager,
        &chat.key,
        &chat.session,
        wrap_up.unwrap()
    ));

    assert!(chat.live(), "the process that has the message is kept");
    assert!(!chat.row().is_done());
    assert_eq!(chat.answering().as_deref(), Some("user-9"));
}

#[test]
fn ending_the_process_ends_a_completion_in_it() {
    // Running.
    let chat = Listed::new(false);
    chat.complete();
    chat_stop_impl(&chat.manager, chat.key.clone()).unwrap();
    assert_eq!(chat.manager.completing_turn(&chat.key), None);
    assert!(!chat.row().is_done());

    // Still queued.
    let chat = Listed::new(true);
    chat.complete();
    chat_restart_impl(&chat.manager, chat.key.clone()).unwrap();
    assert_eq!(chat.manager.completing_turn(&chat.key), None);
    assert!(!chat.row().is_done());
}

#[test]
fn a_process_that_dies_mid_wrap_up_completes_nothing() {
    let chat = Listed::new(false);
    let completing = chat.complete();
    // What the reader does once the stream has closed with no full stop.
    {
        let running = chat.session.lock().unwrap();
        chat.manager
            .completion_cut_short(&chat.key, &running, COMPLETION_ENDED);
    }
    assert_eq!(chat.manager.completing_turn(&chat.key), None);
    assert!(!chat.row().is_done());

    drop(completing);

    // An older process closing its stream says nothing about a wrap-up
    // it was never given.
    let chat = Listed::new(true);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    let queued = chat.complete();
    {
        let running = chat.session.lock().unwrap();
        chat.manager
            .completion_cut_short(&chat.key, &running, COMPLETION_ENDED);
    }
    assert_eq!(
        chat.manager.completing_turn(&chat.key),
        Some(queued.turn_id)
    );
}

/// A stand-in for a provider other than Claude, in a turn nobody here
/// is completing.
fn session_of(agent: ChatAgent, stdin: bool, busy: bool) -> Arc<Mutex<ChatSession>> {
    let mut child = if stdin {
        stand_in::echo()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
    } else {
        stand_in::still().stdin(Stdio::null()).spawn()
    }
    .expect("a stand-in agent");
    let stdin = child.stdin.take();
    Arc::new(Mutex::new(ChatSession {
        launch_id: "test-launch".into(),
        user_turn_id: None,
        answering: Some("user-0".into()),
        child,
        stdin,
        codex: None,
        agent,
        busy,
        last_active: Instant::now(),
        cut_off: CutOff::No,
        auto_plan_refused: false,
        auto_plan_turn: AutoPlanTurn::default(),
        auto_plan_attribution: AutoPlanAttribution::Ready,
        leaving: None,
        first_turn_held: false,
    }))
}

#[test]
fn a_command_line_agent_takes_the_wrap_up_in_its_next_process() {
    // No stdin to write to: the wrap-up waits in the queue for the
    // reaper to carry into the next command, even with no turn in flight.
    let _exec = crate::agent_provider::tests::CommandLineCodex::on();
    let chat = Listed::with(session_of(ChatAgent::Codex, false, false));
    let completing = chat.complete();
    assert_eq!(completing.state, "queued");

    // The turn before it reaching its full stop is not the wrap-up's,
    // and a reader never hands a one-shot process its next turn.
    assert_eq!(chat.full_stop(true), None);
    assert!(chat.manager.has_queued_turns(&chat.key));
    assert!(!chat.row().is_done());
    assert_eq!(
        chat.manager.completing_turn(&chat.key),
        Some(completing.turn_id)
    );
}

#[test]
fn stopping_antigravity_mid_wrap_up_ends_its_process_and_ticks_nothing() {
    // Its Stop is the end of the process: no full stop will ever come
    // back for the wrap-up, so the Stop itself has to end the completion.
    let chat = Listed::with(session_of(ChatAgent::Antigravity, true, false));
    chat.manager.remember_start(
        &chat.key,
        StartContext::for_test(ChatAgent::Antigravity, None),
    );
    let completing = chat.complete();
    assert_eq!(completing.state, "started");

    chat_interrupt_impl(&chat.manager, chat.key.clone()).expect("Stop");

    assert_eq!(chat.manager.completing_turn(&chat.key), None);
    assert!(!chat.live());
    assert!(!chat.row().is_done());
}

#[test]
fn a_one_shot_process_that_has_already_exited_is_still_ticked() {
    let chat = Listed::new(false);
    chat.complete();
    let (wrap_up, _) = {
        let mut running = chat.session.lock().unwrap();
        end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true)
    };
    // Its reaper got there first, as it does when the process exits on
    // its own full stop.
    chat.manager.sessions.lock().unwrap().remove(&chat.key);
    assert!(settle_wrap_up(
        &chat.manager,
        &chat.key,
        &chat.session,
        wrap_up.unwrap()
    ));
    assert!(chat.row().is_done());

    // But not when a newer process is running under the key.
    let chat = Listed::new(false);
    chat.complete();
    let (wrap_up, _) = {
        let mut running = chat.session.lock().unwrap();
        end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true)
    };
    let newer = claude_session(true);
    hold(&chat.manager, &chat.key, newer.clone());
    assert!(!settle_wrap_up(
        &chat.manager,
        &chat.key,
        &chat.session,
        wrap_up.unwrap()
    ));
    assert!(!chat.row().is_done());
    assert!(newer.lock().unwrap().child.try_wait().unwrap().is_none());
    assert!(chat.live(), "the newer process is left alone");
}

#[test]
fn a_chat_with_no_process_is_claimed_for_the_start_that_completes_it() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("chat:claim-{}", uuid::Uuid::new_v4().simple());
    // No process: the caller is told to start it.
    assert_eq!(chat_complete_impl(&manager, &key, "wrap up"), Ok(None));
    assert_eq!(manager.completing_turn(&key), None);

    let turn_id = manager.claim_completion(&key).expect("a claim");
    assert!(turn_id.starts_with(COMPLETION_TURN_PREFIX));
    assert_eq!(manager.completing_turn(&key), Some(turn_id.clone()));
    // A second Complete while that start is on its way.
    assert_eq!(
        chat_complete_impl(&manager, &key, "wrap up"),
        Err(ALREADY_COMPLETING.into())
    );
    assert_eq!(
        manager.claim_completion(&key),
        Err(ALREADY_COMPLETING.into())
    );
    // The start failed: the chat is not left completing.
    manager.settle_claimed_completion(&key, &turn_id, &Err("no such folder".into()));
    assert_eq!(manager.completing_turn(&key), None);

    // A chat that started in the meantime is not claimed; the caller
    // goes back to the live path.
    hold(&manager, &key, claude_session(false));
    assert_eq!(
        manager.claim_completion(&key),
        Err(format!("chat '{key}' is already running"))
    );
    end_process(&manager, &key).unwrap();
}

#[test]
fn the_wrap_up_names_only_the_steps_that_apply() {
    let plain = wrap_up_message(false, &[]);
    assert!(plain.starts_with(
            "The person is completing this chat. Wrap up now, in this order, and start no new work.\n1. Work: commit"
        ));
    assert!(plain.contains("\n2. Clean up: "));
    assert!(plain.contains("\n3. Report in at most ten lines: Done, Not done, Remaining risks.\n"));
    assert!(!plain.contains("vault_agent_memory_append"));
    assert!(!plain.contains("orchestration_run_stop"));
    assert!(plain.ends_with(
            "When this turn ends the chat is marked done and its process stops; a new message reopens it."
        ));

    let lead = wrap_up_message(true, &["run_1".into()]);
    assert!(lead.contains("\n3. Memory: "));
    assert!(lead.contains("save it with vault_agent_memory_append"));
    assert!(lead.contains(
            "\n4. Run: this chat coordinates orchestration run run_1. Stop it with orchestration_run_stop once no worker is running. Leave the mission worktree; the person closes the mission.\n"
        ));
    assert!(lead.contains("\n5. Report in at most ten lines"));

    let two = wrap_up_message(false, &["run_1".into(), "run_2".into()]);
    assert!(two.contains(
        "\n3. Run: this chat coordinates orchestration runs run_1, run_2. Stop each with"
    ));
    assert!(two.contains("\n4. Report"));
}

#[test]
fn only_a_full_stop_the_agent_reached_on_its_own_is_clean() {
    let claude = |event: Value| ended_cleanly(ChatAgent::Claude, &event, false);
    assert!(claude(
        json!({ "type": "result", "subtype": "success", "is_error": false })
    ));
    assert!(claude(json!({ "type": "result", "result": "done" })));
    // The person's Stop coming back, a failed request, a turn cap.
    assert!(!claude(
        json!({ "type": "result", "subtype": "error_during_execution" })
    ));
    assert!(!claude(
        json!({ "type": "result", "subtype": "success", "is_error": true, "api_error_status": 529 })
    ));
    assert!(!claude(
        json!({ "type": "result", "subtype": "error_max_turns" })
    ));

    let codex = |event: Value| ended_cleanly(ChatAgent::Codex, &event, false);
    assert!(codex(json!({ "type": "turn.completed" })));
    assert!(codex(
        json!({ "type": "turn.completed", "status": "completed" })
    ));
    assert!(!codex(
        json!({ "type": "turn.completed", "status": "interrupted" })
    ));
    assert!(!codex(
        json!({ "type": "turn.failed", "error": { "message": "boom" } })
    ));

    let agy = |event: &Value, refused| ended_cleanly(ChatAgent::Antigravity, event, refused);
    let fine = json!({ "event": "result", "result": { "status": "SUCCESS", "response": "ok" } });
    assert!(agy(&fine, false));
    assert!(!agy(&fine, true), "a refusal ended this turn");
    assert!(!agy(
        &json!({ "event": "result", "result": { "status": "ERROR", "error": "interrupted" } }),
        false
    ));
}

const PI_TURN: &str = include_str!("../../../web/src/lib/__fixtures__/pi-rpc-turn.jsonl");
const PI_ABORT: &str = include_str!("../../../web/src/lib/__fixtures__/pi-rpc-abort.jsonl");
const PI_NO_LOGIN: &str = include_str!("../../../web/src/lib/__fixtures__/pi-rpc-no-login.jsonl");
pub(super) const PI_ERROR_EXHAUSTED: &str =
    include_str!("../../../web/src/lib/__fixtures__/pi-rpc-error-exhausted.jsonl");
pub(super) const PI_ERROR_RECOVERED: &str =
    include_str!("../../../web/src/lib/__fixtures__/pi-rpc-error-recovered.jsonl");

/// What the reader decides at each full stop of a recorded Pi stream:
/// the same steps, in the same order (`adapt_event`, `PiTurn::observe`,
/// then `ended_badly` and `ended_cleanly` at the event that ends a turn).
pub(super) fn pi_full_stops(stream: &str) -> Vec<bool> {
    let pi = provider_for(ChatAgent::Pi);
    let mut turn = PiTurn::default();
    let mut stops = Vec::new();
    for line in stream.lines().filter(|l| !l.trim().is_empty()) {
        let mut event: Value = serde_json::from_str(line).expect("a recorded line");
        pi.adapt_event(&mut event);
        turn.observe(&event);
        if pi.observe_event(&event).turn_finished {
            let refused = turn.ended_badly(&event);
            stops.push(ended_cleanly(ChatAgent::Pi, &event, refused));
        }
    }
    stops
}

/// Real `pi --mode rpc` 1.5.2 streams. The full stop (`agent_settled`)
/// says nothing of a model call that failed for good: the last assistant
/// message does.
#[test]
fn a_pi_turn_is_clean_only_when_its_last_message_stopped_normally() {
    // Three prompts that ended on `stop` (two of them after a tool call,
    // whose own message said `toolUse`), and a fourth whose last model
    // call failed (`stopReason: "error"`, after an MCP tool call) while
    // `agent_settled` still said `aborted: false`.
    assert_eq!(pi_full_stops(PI_TURN), [true, true, true, false]);
    // The cut-off turn's own full stop is not clean; the next prompt's is.
    assert_eq!(pi_full_stops(PI_ABORT), [false, true]);
    // A prompt Pi refused has no run and no assistant message of its own.
    assert_eq!(pi_full_stops(PI_NO_LOGIN), [false]);
    // Every retry failed: `agent_settled.aborted` is false and the turn failed.
    let exhausted: Value = serde_json::from_str(
        PI_ERROR_EXHAUSTED
            .lines()
            .rfind(|l| l.contains("agent_settled"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        exhausted["aborted"], false,
        "the full stop alone says clean"
    );
    assert_eq!(pi_full_stops(PI_ERROR_EXHAUSTED), [false]);
    // An error Pi retried and recovered from: the last message decides.
    assert_eq!(pi_full_stops(PI_ERROR_RECOVERED), [true]);
}

#[test]
fn a_pi_turns_evidence_is_its_own() {
    let message = |stop: Option<&str>| {
        let mut event =
            json!({ "type": "message_end", "message": { "role": "assistant", "content": [] } });
        if let Some(stop) = stop {
            event["message"]["stopReason"] = json!(stop);
        }
        event
    };
    let settled = json!({ "type": "agent_settled", "aborted": false });
    let mut turn = PiTurn::default();
    // No assistant message at all.
    assert!(turn.ended_badly(&settled));
    // Streaming updates, users and the system prompt say nothing.
    for event in [
        json!({ "type": "message_update" }),
        json!({ "type": "message_end", "message": { "role": "user" } }),
        json!({ "type": "message_end", "message": { "role": "system" } }),
    ] {
        turn.observe(&event);
    }
    assert!(turn.ended_badly(&settled));
    // Only `stop` is normal; a length cut, a tool call left open, an
    // aborted call and an error are not, and a message with no reason is not.
    for (stop, bad) in [
        (Some("stop"), false),
        (Some("length"), true),
        (Some("toolUse"), true),
        (Some("aborted"), true),
        (Some("error"), true),
        (None, true),
    ] {
        turn.observe(&message(stop));
        assert_eq!(turn.ended_badly(&settled), bad, "{stop:?}");
    }
    // One turn's failure is never the next one's.
    turn.observe(&message(Some("error")));
    assert!(turn.ended_badly(&settled));
    turn.observe(&message(Some("stop")));
    assert!(!turn.ended_badly(&settled));
    // An aborted run is not clean however its last message ended.
    turn.observe(&message(Some("stop")));
    assert!(turn.ended_badly(&json!({ "type": "agent_settled", "aborted": true })));
    // The last message decides: failed first, recovered after.
    turn.observe(&message(Some("error")));
    turn.observe(&message(Some("stop")));
    assert!(!turn.ended_badly(&settled));
}

#[test]
fn a_failed_pi_wrap_up_ticks_nothing_and_a_recovered_one_does() {
    let failed = Listed::new(false);
    failed.session.lock().unwrap().agent = ChatAgent::Pi;
    failed.complete();
    let clean = *pi_full_stops(PI_ERROR_EXHAUSTED).last().unwrap();
    assert_eq!(failed.full_stop(clean), Some(false));
    assert!(!failed.row().is_done());
    assert!(failed.live(), "the process is left running");

    let recovered = Listed::new(false);
    recovered.session.lock().unwrap().agent = ChatAgent::Pi;
    recovered.complete();
    let clean = *pi_full_stops(PI_ERROR_RECOVERED).last().unwrap();
    assert_eq!(recovered.full_stop(clean), Some(true));
    assert!(recovered.row().is_done());
}

#[test]
fn an_antigravity_refusal_is_this_turns_only_when_the_count_grew() {
    let result = |denied: usize| {
        json!({ "event": "result", "result": {
            "status": "SUCCESS",
            "denied_actions": vec![json!({ "action": "command" }); denied],
        }})
    };
    let mut seen = DeniedActions::default();
    assert!(!seen.newly_refused(&json!({ "event": "result", "result": { "status": "SUCCESS" } })));
    assert!(!seen.newly_refused(&result(0)));
    assert!(seen.newly_refused(&result(1)));
    // The conversation's total is repeated on every later result.
    assert!(!seen.newly_refused(&result(1)));
    assert!(seen.newly_refused(&result(3)));
}

// ---- Review of 2fd3231: H1, H2, M1, M2 ---------------------------------

use crate::bus::tap::Tap;

/// Poll for a state another thread reaches with no signal to wait on.
fn until(what: &str, mut reached: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !reached() {
        assert!(Instant::now() < deadline, "never happened in 60s: {what}");
        thread::sleep(Duration::from_millis(5));
    }
}

/// What the bus was told about one chat's completion and its row, in
/// order: `completing <state>`, `completed ok`, `completed <reason>` and
/// `index` for a change to its row.
fn said(tap: &Tap) -> Vec<String> {
    tap.heard()
        .into_iter()
        .filter_map(|(event, payload)| match event.as_str() {
            "chat-completing" => Some(format!("completing {}", payload["state"].as_str().unwrap())),
            "chat-completed" if payload["ok"] == true => {
                assert!(payload["doneAt"].is_i64(), "{payload}");
                assert!(payload.get("reason").is_none(), "{payload}");
                Some("completed ok".into())
            }
            "chat-completed" => {
                assert!(payload.get("doneAt").is_none(), "{payload}");
                Some(format!("completed {}", payload["reason"].as_str().unwrap()))
            }
            "chat-index-changed" => Some("index".into()),
            _ => None,
        })
        .collect()
}

/// The wrap-up turn each completion event named, in order.
fn turns_named(tap: &Tap) -> Vec<String> {
    tap.heard()
        .into_iter()
        .filter(|(event, _)| event.starts_with("chat-complet"))
        .map(|(_, payload)| payload["turnId"].as_str().expect("a turn id").to_string())
        .collect()
}

fn exited(process: &Arc<Mutex<ChatSession>>) -> bool {
    (0..200).any(|_| {
        let gone = process
            .lock()
            .unwrap()
            .child
            .try_wait()
            .is_ok_and(|status| status.is_some());
        if !gone {
            thread::sleep(Duration::from_millis(50));
        }
        gone
    })
}

fn running(process: &Arc<Mutex<ChatSession>>) -> bool {
    process.lock().unwrap().child.try_wait().unwrap().is_none()
}

/// H1. The review's interleaving: the completed process is out of the
/// session table, and before the index is ticked the chat is started
/// again and reopened; the old path then ticked and held that chat and
/// announced it done, with a turn in flight in its new process.
///
/// That gap is gone, so the start is scheduled where it used to be: this
/// stops the close inside its one step and lets a start run against it.
#[test]
fn a_start_scheduled_while_a_chat_is_being_closed_comes_after_the_whole_close() {
    let chat = Listed::new(false);
    let tap = Tap::on(&chat.id);
    let completing = chat.complete();
    let ended = chat.wrap_up_full_stop();
    let old = chat.session.clone();

    // The close takes the session table and then waits for the session
    // this thread holds.
    let held = old.lock().unwrap();
    let newer = thread::scope(|scope| {
        let closing =
            scope.spawn(|| settle_wrap_up(&chat.manager, &chat.key, &chat.session, ended));
        until("the close holds the session table", || {
            matches!(
                chat.manager.sessions.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            )
        });
        let starting = scope.spawn(|| chat.start_again());
        thread::sleep(Duration::from_millis(100));
        assert!(
            !starting.is_finished(),
            "no start gets into the session table while a chat is closing"
        );
        assert!(!closing.is_finished());
        drop(held);
        assert!(closing.join().unwrap(), "the close won, and won whole");
        starting
            .join()
            .unwrap()
            .expect("and the start then went ahead")
    });

    // Closed: ticked, held, announced, its process stopped. Then started
    // again, which took the tick. Never a tick over the turn in flight.
    assert_eq!(
        said(&tap),
        ["completing started", "index", "completed ok", "index"]
    );
    assert_eq!(
        turns_named(&tap),
        [completing.turn_id.clone(), completing.turn_id]
    );
    let row = chat.row();
    assert_eq!(row.done_at, None, "the start that followed took the tick");
    assert!(!row.done_held);
    assert!(chat.runs(&newer));
    assert!(newer.lock().unwrap().busy);
    assert!(running(&newer));
    assert!(exited(&old), "the completed process was stopped");
}

/// H1. A start can only come before the close when the completed process
/// has already left the table by itself, as a one-shot's does on its own
/// full stop. That start wins: nothing is ticked, nothing is held.
#[test]
fn a_start_just_before_a_chat_is_closed_wins_and_nothing_is_ticked() {
    let chat = Listed::new(false);
    let tap = Tap::on(&chat.id);
    let completing = chat.complete();
    let ended = chat.wrap_up_full_stop();
    // While the completed process is in the table no start gets in, in
    // the words a page falls back to sending on.
    let running_already = format!("chat '{}' is already running", chat.key);
    assert_eq!(chat.start_again().err(), Some(running_already.clone()));
    assert_eq!(
        chat.manager.claim_start(&chat.key).err(),
        Some(running_already)
    );

    chat.manager.sessions.lock().unwrap().remove(&chat.key);
    let newer = chat.start_again().expect("nothing runs there now");

    assert!(!settle_wrap_up(
        &chat.manager,
        &chat.key,
        &chat.session,
        ended
    ));

    assert_eq!(said(&tap), ["completing started", "completed superseded"]);
    assert_eq!(
        turns_named(&tap),
        [completing.turn_id.clone(), completing.turn_id]
    );
    let row = chat.row();
    assert_eq!(row.done_at, None);
    assert!(!row.done_held);
    assert!(chat.runs(&newer));
    assert!(newer.lock().unwrap().busy);
    assert!(running(&newer), "the newer process is left alone");
    assert!(
        running(&chat.session),
        "and the close stopped nothing: it never got that far"
    );
}

/// H1. The same start, already gone again when the close looks: the
/// session table is as empty as after a one-shot's own exit, and only
/// the index knows the chat was started in between.
#[test]
fn a_start_that_came_and_went_before_a_chat_is_closed_still_wins() {
    let chat = Listed::new(false);
    let tap = Tap::on(&chat.id);
    chat.complete();
    let ended = chat.wrap_up_full_stop();
    chat.manager.sessions.lock().unwrap().remove(&chat.key);
    chat.start_again().expect("nothing runs there now");
    assert_eq!(end_process(&chat.manager, &chat.key), Ok(true));
    assert!(!chat.live());

    assert!(!settle_wrap_up(
        &chat.manager,
        &chat.key,
        &chat.session,
        ended
    ));

    assert_eq!(said(&tap), ["completing started", "completed superseded"]);
    assert!(!chat.row().is_done());
    assert!(!chat.row().done_held);
}

/// H1. And the start that comes after: the chat is closed whole, and
/// the start reopens it.
#[test]
fn a_start_just_after_a_chat_is_closed_reopens_it() {
    let chat = Listed::new(false);
    let tap = Tap::on(&chat.id);
    chat.complete();

    assert_eq!(chat.full_stop(true), Some(true));

    assert_eq!(said(&tap), ["completing started", "index", "completed ok"]);
    assert!(chat.row().is_done());
    assert!(chat.row().done_held);
    assert!(!chat.live());
    assert!(exited(&chat.session));

    let newer = chat.start_again().expect("a completed chat is not locked");

    assert_eq!(
        said(&tap),
        ["completing started", "index", "completed ok", "index"]
    );
    let row = chat.row();
    assert_eq!(row.done_at, None);
    assert!(!row.done_held);
    assert!(chat.runs(&newer));
    assert!(running(&newer));
}

/// M2. The tick is written first. One that cannot be written is said to
/// the person, with why, and nothing of the stop is done.
#[test]
fn a_tick_that_cannot_be_written_fails_the_completion_and_stops_nothing() {
    let chat = Listed::new(false);
    record_access_for(&chat.key, Some(Access::Auto));
    let tap = Tap::on(&chat.id);
    let completing = chat.complete();

    let closed = crate::chat_index::tests::while_writes_fail(|| chat.full_stop(true));

    assert_eq!(closed, Some(false));
    let why = "The chat could not be marked done: the disk is full. Its agent was left running.";
    assert_eq!(
        said(&tap),
        ["completing started".to_string(), format!("completed {why}")]
    );
    assert_eq!(
        turns_named(&tap),
        [completing.turn_id.clone(), completing.turn_id]
    );
    let row = chat.row();
    assert_eq!(row.done_at, None);
    assert!(!row.done_held);
    assert!(chat.live(), "the process is still in the session table");
    assert!(running(&chat.session), "and still running");
    assert_eq!(
        access_now(&chat.key),
        Some(Access::Auto),
        "nothing of a stop was done"
    );
    assert_eq!(chat.completing(), None);
    // The chat can be completed again, and now the index takes the tick.
    assert_eq!(chat.complete().state, "started");
    assert_eq!(chat.full_stop(true), Some(true));
    assert!(chat.row().is_done());

    // A chat deleted during its wrap-up has no row to tick, which is the
    // same answer.
    let chat = Listed::new(false);
    let tap = Tap::on(&chat.id);
    chat.complete();
    crate::chat_index::remove(&chat.id).unwrap();
    assert_eq!(chat.full_stop(true), Some(false));
    assert_eq!(
            said(&tap).last().map(String::as_str),
            Some("completed The chat could not be marked done: it is not in the chat index. Its agent was left running.")
        );
    assert!(chat.live());
    assert!(running(&chat.session));
}

/// M1. `chat-completing` is said in the step that records the
/// completion, so whatever ends it is said after, and both name the
/// wrap-up turn.
#[test]
fn a_completion_is_announced_before_anything_can_end_it() {
    // The ✕ on a queued wrap-up.
    let chat = Listed::new(true);
    let tap = Tap::on(&chat.id);
    let completing = chat.complete();
    assert_eq!(
        chat_cancel_queued_impl(&chat.manager, chat.key.clone(), completing.turn_id.clone()),
        Ok(true)
    );
    assert_eq!(said(&tap), ["completing queued", "completed cancelled"]);
    assert_eq!(
        turns_named(&tap),
        [completing.turn_id.clone(), completing.turn_id]
    );

    // A wrap-up that cannot be written ends the completion it had
    // announced, with the error the caller is answered with.
    let chat = Listed::new(false);
    let tap = Tap::on(&chat.id);
    chat.session.lock().unwrap().stdin.take();
    let refused = chat_complete_impl(&chat.manager, &chat.key, "wrap up").unwrap_err();
    assert_eq!(refused, "this chat does not take more input");
    assert_eq!(
        said(&tap),
        [
            "completing started".to_string(),
            format!("completed {refused}")
        ]
    );
    let named = turns_named(&tap);
    assert_eq!(named[0], named[1]);
    assert_eq!(chat.completing(), None);

    // So does a start that was claimed for a completion and failed.
    let chat = Listed::new(false);
    end_process(&chat.manager, &chat.key).unwrap();
    let tap = Tap::on(&chat.id);
    let turn_id = chat.manager.claim_completion(&chat.key).expect("a claim");
    chat.manager
        .settle_claimed_completion(&chat.key, &turn_id, &Err("no such folder".into()));
    assert_eq!(
        said(&tap),
        ["completing started", "completed no such folder"]
    );
    assert_eq!(turns_named(&tap), [turn_id.clone(), turn_id.clone()]);
    // And one that started says nothing more until the wrap-up ends.
    let turn_id = chat.manager.claim_completion(&chat.key).expect("a claim");
    chat.manager
        .settle_claimed_completion(&chat.key, &turn_id, &Ok(()));
    assert_eq!(said(&tap).len(), 3);
    assert_eq!(chat.completing(), Some(turn_id));
}

/// M1. A cancel racing the Complete it cancels: the event that the
/// completion began used to be emitted after its locks were let go, so
/// the cancel's `chat-completed` could be first on the bus.
#[test]
fn a_completion_racing_its_own_cancel_is_still_announced_first() {
    const ROUNDS: usize = 100;
    let chat = Listed::new(true);
    let tap = Tap::on(&chat.id);
    thread::scope(|scope| {
        let cancelling = scope.spawn(|| {
            let mut cancelled = 0;
            while cancelled < ROUNDS {
                let taken_back = chat.completing().is_some_and(|turn_id| {
                    chat_cancel_queued_impl(&chat.manager, chat.key.clone(), turn_id) == Ok(true)
                });
                if taken_back {
                    cancelled += 1;
                } else {
                    thread::yield_now();
                }
            }
        });
        for _ in 0..ROUNDS {
            until("the last completion was taken back", || {
                chat.completing().is_none()
            });
            assert_eq!(chat.complete().state, "queued");
        }
        cancelling.join().unwrap();
    });

    let heard: Vec<(String, String)> = tap
        .heard()
        .into_iter()
        .filter(|(event, _)| event.starts_with("chat-complet"))
        .map(|(event, payload)| (event, payload["turnId"].as_str().unwrap().to_string()))
        .collect();
    assert_eq!(heard.len(), 2 * ROUNDS);
    for pair in heard.chunks(2) {
        assert_eq!(pair[0].0, "chat-completing", "{pair:?}");
        assert_eq!(pair[1].0, "chat-completed", "{pair:?}");
        assert_eq!(pair[0].1, pair[1].1, "one completion at a time");
    }
}

/// H2. Stop marks the session idle while the cut-off turn's own full
/// stop is still to come. A Complete in that gap used to be written to
/// the agent at once, and that late full stop then decided it: a clean
/// one ticked the chat and stopped an agent that had wrapped nothing up,
/// a failed one called the completion failed.
#[test]
fn a_complete_during_the_unwind_of_a_stop_waits_for_the_cut_off_turns_own_full_stop() {
    for cut_off_ended_cleanly in [true, false] {
        let chat = Listed::new(true);
        chat.session.lock().unwrap().answering = Some("user-0".into());
        let tap = Tap::on(&chat.id);
        chat.stop();
        assert!(!chat.busy(), "Stop reads idle at once");

        let completing = chat.complete();

        assert_eq!(completing.state, "queued");
        assert_eq!(
            chat.answering().as_deref(),
            Some("user-0"),
            "nothing was written into the gap"
        );
        assert_eq!(chat.queued(), [completing.turn_id.clone()]);

        // The cut-off turn's full stop decides nothing, however it
        // ended, and hands the wrap-up over like any queued message.
        assert_eq!(chat.full_stop(cut_off_ended_cleanly), None);
        assert_eq!(chat.completing(), Some(completing.turn_id.clone()));
        assert_eq!(chat.answering(), Some(completing.turn_id.clone()));
        assert!(chat.busy(), "the wrap-up is running");
        assert!(chat.queued().is_empty());
        assert!(!chat.row().is_done());
        assert!(chat.live());
        assert_eq!(said(&tap), ["completing queued"]);

        // Only the wrap-up's own full stop does.
        assert_eq!(chat.full_stop(true), Some(true));
        assert!(chat.row().is_done());
        assert!(!chat.live());
        assert_eq!(said(&tap), ["completing queued", "index", "completed ok"]);
        assert_eq!(
            turns_named(&tap),
            [completing.turn_id.clone(), completing.turn_id]
        );
    }

    // A wrap-up that then fails is not ticked by the clean stop before it.
    let chat = Listed::new(true);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    let tap = Tap::on(&chat.id);
    chat.stop();
    chat.complete();
    assert_eq!(chat.full_stop(true), None);
    assert_eq!(chat.full_stop(false), Some(false));
    assert_eq!(said(&tap), ["completing queued", "completed failed"]);
    assert!(!chat.row().is_done());
    assert!(chat.live());
    assert!(running(&chat.session));
}

/// The unwind the last Stop left `process` in.
fn owed(process: &Arc<Mutex<ChatSession>>) -> u64 {
    match process.lock().unwrap().cut_off {
        CutOff::Owed(unwind) => unwind,
        other => panic!("no Stop is being waited out: {other:?}"),
    }
}

/// What the end of a Stop's grace did (`grace_ran_out`).
struct Grace {
    /// Whether this call ended the process.
    ended: bool,
    /// The queued turn the chat's next process was started with, and
    /// that process.
    carried: Option<(QueuedTurn, Arc<Mutex<ChatSession>>)>,
}

/// What the thread a Stop leaves behind does when it wakes, for the
/// unwind it is given, with a stand-in where `start_session` would spawn
/// the chat's next process.
fn grace_runs_out_on(chat: &Listed, process: &Arc<Mutex<ChatSession>>, unwind: u64) -> Grace {
    let mut carried = None;
    let ended = grace_ran_out_with(
        &chat.manager,
        &chat.key,
        &chat.key,
        process,
        unwind,
        |turn| {
            // What a start leaves behind for a queued turn: a process
            // under the key, in that turn.
            let next = claude_session(true);
            {
                let mut starting = next.lock().unwrap();
                starting.answering = turn.turn_id.clone();
                starting.user_turn_id = turn.turn_id.clone();
            }
            chat.start(next.clone())?;
            carried = Some((turn, next));
            Ok(())
        },
    );
    Grace { ended, carried }
}

/// The grace of the Stop this chat's process is waiting out is over.
fn grace_runs_out(chat: &Listed) -> Grace {
    grace_runs_out_on(chat, &chat.session, owed(&chat.session))
}

/// How many waits Stops have asked for on this chat's manager.
fn waits_asked(chat: &Listed) -> usize {
    chat.manager
        .unwind_probe
        .asked
        .load(std::sync::atomic::Ordering::SeqCst)
}

/// The next line a stand-in was sent on its stdin, which is the Stop.
fn stop_sent(written: &mut impl std::io::BufRead) {
    let mut line = String::new();
    written.read_line(&mut line).expect("the stand-in's echo");
    let sent: Value = serde_json::from_str(&line).expect("a line of JSON");
    assert_eq!(sent["request"]["subtype"], "interrupt", "{line}");
}

/// Everything `written` still holds, to the end of the stream: the lines
/// a stand-in was sent on its stdin and had not been read back yet.
///
/// Only what it was sent, which is always a JSON object. A stand-in whose
/// stdin closes a moment before it is killed gets as far as the test
/// harness's own closing lines, and those are not.
fn rest_of(written: &mut impl std::io::BufRead) -> Vec<Value> {
    let mut lines = Vec::new();
    let mut line = String::new();
    while written.read_line(&mut line).expect("the stand-in's echo") > 0 {
        if let Ok(sent) = serde_json::from_str::<Value>(&line) {
            if sent.is_object() {
                lines.push(sent);
            }
        }
        line.clear();
    }
    lines
}

/// A Codex app-server stand-in with a turn in flight.
fn codex_session() -> Arc<Mutex<ChatSession>> {
    let session = claude_session(true);
    {
        let mut codex = session.lock().unwrap();
        codex.agent = ChatAgent::Codex;
        codex.codex = Some(CodexAppSession {
            thread_id: "thread-1".into(),
            active_turn_id: Some("turn-1".into()),
            interrupt_when_started: false,
            next_request: 0,
            elicitations: HashMap::new(),
            mcp_calls: HashMap::new(),
            mcp_refusals: HashMap::new(),
            model: None,
            effort: None,
            access: Some(Access::Read),
            cwd: "/tmp".into(),
            workspace_roots: vec!["/tmp".into()],
            has_octiq_mcp: false,
        });
    }
    session
}

/// H2. Stop, Complete, then ✕ on the queued wrap-up: the completion is
/// taken back and the chat is as the Stop left it.
#[test]
fn taking_back_a_wrap_up_queued_behind_a_stop_leaves_the_chat_as_the_stop_left_it() {
    let chat = Listed::new(true);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    let tap = Tap::on(&chat.id);
    chat.stop();
    let completing = chat.complete();

    assert_eq!(
        chat_cancel_queued_impl(&chat.manager, chat.key.clone(), completing.turn_id.clone()),
        Ok(true)
    );

    assert_eq!(chat.completing(), None);
    assert_eq!(said(&tap), ["completing queued", "completed cancelled"]);
    // The cut-off turn's full stop ends that turn and nothing else.
    assert_eq!(chat.full_stop(true), None);
    assert!(!chat.busy());
    assert_eq!(chat.answering().as_deref(), Some("user-0"));
    assert!(chat.queued().is_empty());
    assert!(!chat.row().is_done());
    assert!(chat.live());
    assert_eq!(said(&tap).len(), 2);

    // And where that full stop never comes, the completion that was
    // taken back is not failed a second time when the process is ended.
    let chat = Listed::new(true);
    let tap = Tap::on(&chat.id);
    chat.stop();
    let completing = chat.complete();
    chat_cancel_queued_impl(&chat.manager, chat.key.clone(), completing.turn_id).unwrap();
    assert!(chat.busy());
    let grace = grace_runs_out(&chat);
    assert!(grace.ended);
    assert!(grace.carried.is_none());
    assert!(!chat.live());
    assert!(!chat.row().is_done());
    assert_eq!(said(&tap), ["completing queued", "completed cancelled"]);
}

/// H2, the same exposure in an ordinary send: written into the gap, the
/// message became the turn the cut-off turn's full stop ended, and the
/// agent worked on it with the session read as idle.
#[test]
fn a_message_sent_during_the_unwind_of_a_stop_waits_for_the_cut_off_turns_own_full_stop() {
    let chat = Listed::new(true);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    chat.stop();

    chat.send("do this instead", "user-9");

    assert_eq!(
        chat.answering().as_deref(),
        Some("user-0"),
        "nothing was written into the gap"
    );
    assert_eq!(chat.queued(), ["user-9"]);
    // Handed over on the cut-off turn's full stop, and in flight until
    // its own.
    assert_eq!(chat.full_stop(false), None);
    assert_eq!(chat.answering().as_deref(), Some("user-9"));
    assert!(chat.busy());
    assert!(chat.queued().is_empty());
    assert_eq!(chat.full_stop(true), None);
    assert!(!chat.busy());

    // A second Stop inside the unwind, with nothing in flight, does not
    // end the wait for the first one's full stop.
    let chat = Listed::new(true);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    chat.stop();
    chat.stop();
    assert!(chat.manager.unwinding(&chat.key));
    assert_eq!(chat.complete().state, "queued");
    assert_eq!(chat.answering().as_deref(), Some("user-0"));

    // With no Stop behind it, an idle chat takes a message at once.
    let chat = Listed::new(false);
    chat.send("hello", "user-1");
    assert_eq!(chat.answering().as_deref(), Some("user-1"));
    assert!(chat.queued().is_empty());
}

/// H2 for the agents whose Stop is the end of the process: Antigravity,
/// and every command-line (one-shot) agent. There is nothing to unwind,
/// and no older turn's full stop can reach the process that runs the
/// wrap-up.
#[test]
fn a_stop_that_ends_the_process_leaves_no_turn_for_a_wrap_up_to_be_taken_for() {
    let _exec = crate::agent_provider::tests::CommandLineCodex::on();
    for (agent, stdin) in [(ChatAgent::Antigravity, true), (ChatAgent::Codex, false)] {
        assert!(relaunches_to_continue(agent), "{agent:?}");
        let chat = Listed::with(session_of(agent, stdin, true));
        chat.manager
            .remember_start(&chat.key, StartContext::for_test(agent, None));
        let tap = Tap::on(&chat.id);

        chat.stop();

        assert!(!chat.live(), "{agent:?}: its Stop ends the process");
        assert!(!chat.manager.unwinding(&chat.key), "{agent:?}");
        // No process: the caller starts the chat with the wrap-up as its
        // first message.
        assert_eq!(
            chat_complete_impl(&chat.manager, &chat.key, "wrap up"),
            Ok(None)
        );
        assert_eq!(chat.completing(), None);
        assert!(said(&tap).is_empty());
        let turn_id = chat.manager.claim_completion(&chat.key).expect("a claim");
        let newer = session_of(agent, stdin, true);
        newer.lock().unwrap().answering = Some(turn_id.clone());
        chat.start(newer.clone())
            .expect("the start it was claimed for");

        // Whatever the stopped process still says belongs to the turn it
        // was running: a full stop read late, and its stream closing.
        {
            let mut stopped = chat.session.lock().unwrap();
            let (wrap_up, _) =
                end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut stopped, true);
            assert_eq!(wrap_up, None, "{agent:?}");
            chat.manager
                .completion_cut_short(&chat.key, &stopped, COMPLETION_ENDED);
        }
        assert_eq!(chat.completing(), Some(turn_id.clone()), "{agent:?}");
        assert!(!chat.row().is_done());

        // The wrap-up's own full stop, in the process that ran it.
        let (wrap_up, _) = {
            let mut running = newer.lock().unwrap();
            end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true)
        };
        assert!(settle_wrap_up(
            &chat.manager,
            &chat.key,
            &newer,
            wrap_up.expect("the wrap-up's own full stop")
        ));
        assert!(chat.row().is_done(), "{agent:?}");
        assert!(!chat.live());
        assert_eq!(said(&tap), ["completing started", "index", "completed ok"]);
        assert_eq!(turns_named(&tap), [turn_id.clone(), turn_id]);
    }
}

/// H2 (review of 8cbcd0b). A Stop the agent does not honour within the
/// grace ends its process. Nothing is written to it: the first queued
/// message starts in the chat's next process and the rest wait behind
/// it, so Stop still keeps the queue.
#[test]
fn a_stop_the_agent_does_not_honour_ends_its_process_and_the_queue_starts_in_the_next() {
    let (session, mut written) = super::tests::capturing_claude_session();
    let chat = Listed::with(session);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    chat.stop();
    stop_sent(&mut written);
    chat.send("do this instead", "user-9");
    chat.send("/status", "user-10");
    assert_eq!(chat.queued(), ["user-9", "user-10"]);
    let unwind = owed(&chat.session);

    let grace = grace_runs_out(&chat);

    assert!(grace.ended);
    assert!(exited(&chat.session), "the process that did not stop");
    assert_eq!(chat.session.lock().unwrap().cut_off, CutOff::Ended);
    let (turn, next) = grace.carried.expect("the first queued message");
    assert_eq!(turn.turn_id.as_deref(), Some("user-9"));
    assert_eq!(turn.text, "do this instead");
    assert!(chat.runs(&next), "it starts in the chat's next process");
    assert_eq!(chat.queued(), ["user-10"], "the rest wait behind it");
    assert!(!chat.manager.handoffs.lock().unwrap().contains(&chat.key));
    // The old process was sent nothing after the Stop.
    let sent = rest_of(&mut written);
    assert!(sent.is_empty(), "{sent:?}");
    assert_eq!(chat.answering().as_deref(), Some("user-0"));

    // Whatever the ended process still says ends nothing here: the
    // queue is its successor's.
    for clean in [false, true] {
        assert_eq!(chat.full_stop(clean), None);
    }
    assert_eq!(chat.queued(), ["user-10"]);
    assert!(next.lock().unwrap().busy);
    assert_eq!(next.lock().unwrap().answering.as_deref(), Some("user-9"));

    // The next process's own full stop hands the rest over.
    {
        let mut running = next.lock().unwrap();
        assert_eq!(
            end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true),
            (None, None)
        );
        assert_eq!(running.answering.as_deref(), Some("user-10"));
        assert!(running.busy);
    }
    assert!(chat.queued().is_empty());

    // One unwind, one ending.
    assert!(!grace_runs_out_on(&chat, &chat.session, unwind).ended);
    assert!(chat.runs(&next));
    assert!(running(&next));
}

/// With nothing waiting, the process is ended and that is all: the chat
/// reads as any chat whose process has gone, and the next message is the
/// page's to start it with.
#[test]
fn a_stop_that_is_not_honoured_with_nothing_waiting_only_ends_the_process() {
    let chat = Listed::new(true);
    chat.stop();
    assert!(chat.manager.unwinding(&chat.key));

    let grace = grace_runs_out(&chat);

    assert!(grace.ended);
    assert!(grace.carried.is_none());
    assert!(!chat.live());
    assert!(exited(&chat.session));
    assert!(!chat.manager.handoffs.lock().unwrap().contains(&chat.key));
    assert!(
        !chat.manager.unwinding(&chat.key),
        "the mark went with the process"
    );
    assert!(chat.manager.notification_ready(&chat.key));
    assert_eq!(
        chat_send_user_impl(
            chat.manager.clone(),
            chat.key.clone(),
            "hello again".into(),
            None,
            None,
            Some("user-1".into()),
            None,
        ),
        Err("no such chat".into())
    );
    assert!(chat.queued().is_empty());
}

/// The real start, for a chat nothing knows how to resume: the queue is
/// not left waiting on a process that will never come, and the page is
/// told the chat has none.
#[test]
fn a_queue_that_cannot_be_started_in_the_next_process_is_not_left_waiting() {
    let chat = Listed::new(true);
    let tap = Tap::on(&chat.id);
    chat.stop();
    chat.send("do this instead", "user-9");
    chat.send("/status", "user-10");

    assert!(grace_ran_out(
        &chat.manager,
        &chat.key,
        &chat.key,
        &chat.session,
        owed(&chat.session)
    ));

    assert!(!chat.live());
    assert!(chat.queued().is_empty());
    assert!(!chat.manager.handoffs.lock().unwrap().contains(&chat.key));
    let statuses: Vec<String> = tap
        .heard()
        .into_iter()
        .filter(|(event, _)| event == "chat-status")
        .map(|(_, payload)| payload["kind"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(statuses, ["error", "exit"]);
    let record = crate::transcript::since(&chat.key, 0);
    for turn in ["user-9", "user-10"] {
        assert!(
            record.iter().any(|frame| {
                frame.event["type"] == "octiq_user_turn_delivery"
                    && frame.event["uuid"] == turn
                    && frame.event["state"] == "failed"
            }),
            "{turn} is told as not sent"
        );
    }
}

/// A wrap-up waiting behind a stopped turn is not carried into the next
/// process: it was asked of the one that is gone. The completion fails
/// once, in words the person can act on, and the messages around it are
/// kept.
#[test]
fn a_wrap_up_waiting_behind_a_stop_that_is_not_honoured_fails_once_and_is_not_carried() {
    let chat = Listed::new(true);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    let tap = Tap::on(&chat.id);
    chat.stop();
    chat.send("first this", "user-1");
    let completing = chat.complete();
    chat.send("then this", "user-2");
    assert_eq!(completing.state, "queued");
    assert_eq!(
        chat.queued(),
        ["user-1", completing.turn_id.as_str(), "user-2"]
    );

    let grace = grace_runs_out(&chat);

    assert!(grace.ended);
    let off = format!("completed {COMPLETION_STOP_NOT_HONOURED}");
    assert_eq!(said(&tap), ["completing queued", off.as_str()]);
    assert_eq!(
        turns_named(&tap),
        [completing.turn_id.clone(), completing.turn_id.clone()]
    );
    assert_eq!(chat.completing(), None);
    assert_eq!(chat.row().done_at, None);
    assert!(!chat.row().is_done());
    let (turn, next) = grace.carried.expect("the message ahead of the wrap-up");
    assert_eq!(turn.turn_id.as_deref(), Some("user-1"));
    assert_eq!(chat.queued(), ["user-2"], "the wrap-up went, alone");
    assert!(
        crate::transcript::since(&chat.key, 0).iter().any(|frame| {
            frame.event["type"] == "octiq_user_turn_delivery"
                && frame.event["uuid"] == completing.turn_id.as_str()
                && frame.event["state"] == "failed"
        }),
        "the wrap-up is told as not sent"
    );

    // The stopped turn's own clean full stop, read late, and its stream
    // closing say nothing more about it.
    assert_eq!(chat.full_stop(true), None);
    {
        let stopped = chat.session.lock().unwrap();
        chat.manager
            .completion_cut_short(&chat.key, &stopped, COMPLETION_ENDED);
    }
    assert_eq!(said(&tap).len(), 2);
    assert!(!chat.row().is_done());
    assert!(chat.runs(&next));

    // Completing again is a new completion, of the process running now.
    let again = chat.complete();
    assert_eq!(again.state, "queued");
    assert_ne!(again.turn_id, completing.turn_id);
    assert_eq!(chat.queued(), ["user-2", again.turn_id.as_str()]);

    // A wrap-up with nothing around it: the process is ended, nothing is
    // carried, and the chat can be completed again from no process.
    let chat = Listed::new(true);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    let tap = Tap::on(&chat.id);
    chat.stop();
    let completing = chat.complete();
    let grace = grace_runs_out(&chat);
    assert!(grace.ended);
    assert!(grace.carried.is_none());
    assert!(!chat.live());
    assert!(chat.queued().is_empty());
    assert_eq!(said(&tap), ["completing queued", off.as_str()]);
    assert_eq!(
        turns_named(&tap),
        [completing.turn_id.clone(), completing.turn_id]
    );
    assert_eq!(chat.row().done_at, None);
    assert_eq!(
        chat_complete_impl(&chat.manager, &chat.key, "wrap up"),
        Ok(None)
    );
}

/// The review's first counter-example. A turn written after the grace
/// into a Codex that had not stopped was answered with the turn it was
/// already in, and the one full stop that followed was dropped as the
/// stopped turn's: the session stayed busy and the chat Completing for
/// good. Nothing is written now, so that full stop has nothing to be
/// mistaken for, whichever agent sends it and however it ended.
#[test]
fn the_only_full_stop_after_the_grace_leaves_nothing_busy_and_nothing_completing() {
    for codex in [false, true] {
        let stopped = || {
            let chat = Listed::with(if codex {
                codex_session()
            } else {
                claude_session(true)
            });
            chat.session.lock().unwrap().answering = Some("user-0".into());
            chat.stop();
            chat
        };
        for clean in [false, true] {
            // A message.
            let chat = stopped();
            chat.send("do this instead", "user-9");
            let (_, next) = grace_runs_out(&chat).carried.expect("the message");
            assert_eq!(chat.full_stop(clean), None, "codex {codex}, clean {clean}");
            assert!(next.lock().unwrap().busy, "its own turn is in flight");
            assert_eq!(next.lock().unwrap().answering.as_deref(), Some("user-9"));
            // Its own full stop ends it, and the chat takes the next
            // message at once: nothing is left queueing behind a turn
            // that will never end.
            {
                let mut running = next.lock().unwrap();
                end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true);
                assert!(!running.busy);
            }
            chat.send("and then", "user-11");
            assert_eq!(next.lock().unwrap().answering.as_deref(), Some("user-11"));
            assert!(chat.queued().is_empty());

            // A Complete.
            let chat = stopped();
            let tap = Tap::on(&chat.id);
            chat.complete();
            assert!(grace_runs_out(&chat).ended);
            assert_eq!(chat.full_stop(clean), None, "codex {codex}, clean {clean}");
            assert!(!chat.live());
            assert_eq!(chat.completing(), None);
            assert!(chat.queued().is_empty());
            assert!(!chat.row().is_done());
            assert_eq!(said(&tap).len(), 2, "{:?}", said(&tap));
        }
    }
}

/// The review's second counter-example. The stopped turn's clean full
/// stop, arriving after the grace, closed a completion whose wrap-up had
/// never run. It decides nothing now: not the completion that was
/// waiting, and not one the person started afterwards.
#[test]
fn a_clean_full_stop_of_the_stopped_turn_after_the_grace_ticks_nothing() {
    let chat = Listed::new(true);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    let tap = Tap::on(&chat.id);
    chat.stop();
    let first = chat.complete();
    assert!(grace_runs_out(&chat).ended);

    // The person completes it again: no process, so the chat is started
    // with a new wrap-up as its first message.
    assert_eq!(
        chat_complete_impl(&chat.manager, &chat.key, "wrap up"),
        Ok(None)
    );
    let turn_id = chat.manager.claim_completion(&chat.key).expect("a claim");
    let newer = claude_session(true);
    newer.lock().unwrap().answering = Some(turn_id.clone());
    chat.start(newer.clone())
        .expect("the start it was claimed for");

    // The old process's clean full stop, and its stream closing.
    assert_eq!(chat.full_stop(true), None);
    {
        let stopped = chat.session.lock().unwrap();
        chat.manager
            .completion_cut_short(&chat.key, &stopped, COMPLETION_ENDED);
    }
    assert_eq!(chat.completing(), Some(turn_id.clone()));
    assert!(!chat.row().is_done());
    assert!(chat.runs(&newer));
    assert!(running(&newer));
    assert!(newer.lock().unwrap().busy);

    // Only the new wrap-up's own full stop, in the process that ran it.
    let (wrap_up, _) = {
        let mut running = newer.lock().unwrap();
        end_turn_locked(&chat.manager, &chat.key, &chat.key, &mut running, true)
    };
    assert!(settle_wrap_up(
        &chat.manager,
        &chat.key,
        &newer,
        wrap_up.expect("the wrap-up's own full stop")
    ));
    assert!(chat.row().is_done());
    let off = format!("completed {COMPLETION_STOP_NOT_HONOURED}");
    assert_eq!(
        said(&tap),
        [
            "completing queued",
            off.as_str(),
            "completing started",
            "index",
            "completed ok"
        ]
    );
    assert_eq!(
        turns_named(&tap),
        [
            first.turn_id.clone(),
            first.turn_id,
            turn_id.clone(),
            turn_id
        ]
    );
}

/// The invariant itself: while a stopped turn's full stop is owed, no
/// way of giving the agent a prompt writes one. A message, a wrap-up, a
/// host continuation and a host notification all wait, and the one
/// function every prompt goes through refuses whoever asks.
#[test]
fn nothing_is_written_to_a_process_that_still_owes_a_full_stop() {
    use crate::orchestration::inbox::{DeliveryState, Notification, RECEIPT_PREFIX};

    let (session, mut written) = super::tests::capturing_claude_session();
    let chat = Listed::with(session);
    chat.session.lock().unwrap().answering = Some("user-0".into());
    chat.stop();
    stop_sent(&mut written);

    let note = Notification {
        id: format!("{RECEIPT_PREFIX}1"),
        run_id: "run_1".into(),
        from_chat_key: "chat:other".into(),
        target_chat_key: chat.key.clone(),
        source: "test".into(),
        kind: "instruction".into(),
        body: "Something happened.".into(),
        state: DeliveryState::Delivering,
        attempts: 0,
        coalesced: 0,
        sequence: None,
        created_at: 0,
        updated_at: 0,
        next_attempt_at: 0,
        last_error: None,
    };
    assert!(!chat.manager.notification_ready(&chat.key));
    assert_eq!(
        deliver_orchestration_notification(chat.manager.clone(), &note, Default::default()),
        Ok(false)
    );
    chat.send("a message", "user-1");
    assert_eq!(chat.complete().state, "queued");
    chat_continue_internal_impl(
        chat.manager.clone(),
        chat.key.clone(),
        "a continuation".into(),
    )
    .expect("it waits like the rest");
    assert_eq!(
        deliver_orchestration_notification(chat.manager.clone(), &note, Default::default()),
        Ok(false),
        "nor ahead of what is waiting"
    );
    for turn in [Some("user-x"), None] {
        let mut stopping = chat.session.lock().unwrap();
        assert_eq!(
            write_user_message_locked(
                &chat.manager,
                &mut stopping,
                &chat.key,
                "anything",
                &[],
                turn
            ),
            Err(STILL_STOPPING.into())
        );
    }
    assert_eq!(chat.answering().as_deref(), Some("user-0"));
    assert_eq!(chat.queued().len(), 2, "the continuation has no bubble");
    assert!(chat.manager.has_queued_turns(&chat.key));

    // Nor once the grace has run out: the process is ended instead, and
    // an ended process is refused the same way.
    assert!(grace_runs_out(&chat).ended);
    {
        let mut ended = chat.session.lock().unwrap();
        assert_eq!(
            write_user_message_locked(
                &chat.manager,
                &mut ended,
                &chat.key,
                "anything",
                &[],
                Some("user-y")
            ),
            Err(STILL_STOPPING.into())
        );
    }
    assert!(exited(&chat.session));
    let sent = rest_of(&mut written);
    assert!(sent.is_empty(), "{sent:?}");
}

/// The full stop and the end of the grace take the same session lock,
/// so at the boundary exactly one of them acts: the waiting message is
/// handed to the process that stopped after all, or that process is
/// ended and the message carried to the next. Never both, never neither.
#[test]
fn a_full_stop_at_the_end_of_the_grace_is_one_outcome_never_a_dispatch_and_an_ending() {
    const ROUNDS: usize = 500;
    let manager = Arc::new(ChatManager::default());
    let run = uuid::Uuid::new_v4().simple().to_string();
    let (mut handed_over, mut ended) = (0, 0);
    for round in 0..ROUNDS {
        let key = format!("chat:boundary-{run}-{round}");
        let session = claude_session(true);
        session.lock().unwrap().answering = Some("user-0".into());
        hold(&manager, &key, session.clone());
        chat_interrupt_impl(&manager, key.clone()).expect("Stop");
        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            "do this instead".into(),
            None,
            None,
            Some("user-1".into()),
            None,
        )
        .expect("a message behind the Stop");
        let unwind = owed(&session);

        // A third of the rounds each: a plain race, which the grace
        // mostly loses the session to having the session table to take
        // first, and one side or the other stepping back a little.
        let start = std::sync::Barrier::new(2);
        let (full_stop, (grace_ended, carried)) = thread::scope(|scope| {
            let reader = scope.spawn(|| {
                start.wait();
                if round % 3 == 1 {
                    thread::yield_now();
                }
                let mut running = session.lock().unwrap();
                end_turn_locked(&manager, &key, &key, &mut running, true)
            });
            let sleeper = scope.spawn(|| {
                start.wait();
                if round % 3 == 2 {
                    thread::yield_now();
                }
                let mut carried = None;
                let ended = grace_ran_out_with(&manager, &key, &key, &session, unwind, |turn| {
                    carried = Some(turn);
                    Ok(())
                });
                (ended, carried)
            });
            (reader.join().unwrap(), sleeper.join().unwrap())
        });

        assert_eq!(full_stop, (None, None), "round {round}");
        assert!(!manager.has_queued_turns(&key), "round {round}: taken once");
        {
            let after = session.lock().unwrap();
            if grace_ended {
                ended += 1;
                let carried = carried.expect("the message goes to the next process");
                assert_eq!(carried.turn_id.as_deref(), Some("user-1"), "round {round}");
                assert_eq!(after.cut_off, CutOff::Ended, "round {round}");
                assert_eq!(
                    after.answering.as_deref(),
                    Some("user-0"),
                    "round {round}: nothing was written to the process that was ended"
                );
                assert!(after.stdin.is_none(), "round {round}");
                assert!(!manager.has_process(&key), "round {round}");
            } else {
                handed_over += 1;
                assert!(carried.is_none(), "round {round}: not carried as well");
                assert_eq!(after.cut_off, CutOff::No, "round {round}");
                assert_eq!(after.answering.as_deref(), Some("user-1"), "round {round}");
                assert!(after.busy, "round {round}");
                assert!(after.stdin.is_some(), "round {round}: not ended as well");
                assert!(manager.has_process(&key), "round {round}");
            }
        }
        let _ = end_process(&manager, &key);
        crate::transcript::forget(&key);
    }
    assert_eq!(handed_over + ended, ROUNDS);
}

/// A second Stop inside an unwind is the same unwind: no second wait, no
/// moved deadline, and the queue is kept.
#[test]
fn a_second_stop_inside_an_unwind_starts_no_second_wait() {
    let chat = Listed::new(true);
    chat.stop();
    let unwind = owed(&chat.session);
    // With nothing in flight, and again with a message waiting, which
    // reads as work in flight.
    chat.stop();
    chat.send("do this instead", "user-1");
    assert!(chat.busy());
    chat.stop();

    assert_eq!(owed(&chat.session), unwind, "still the first Stop's unwind");
    assert_eq!(waits_asked(&chat), 1);
    assert_eq!(chat.queued(), ["user-1"], "Stop keeps the queue");

    // And it is ended once.
    assert!(grace_runs_out_on(&chat, &chat.session, unwind).ended);
    assert!(!grace_runs_out_on(&chat, &chat.session, unwind).ended);
}

/// The wait behind one Stop does nothing for a later Stop of the same
/// chat, in the same process or in the one after it.
#[test]
fn the_wait_behind_one_stop_does_nothing_for_a_later_stop_of_the_same_chat() {
    // The same process: Stop, its full stop, a new turn, Stop again.
    let chat = Listed::new(true);
    chat.stop();
    let first = owed(&chat.session);
    assert_eq!(chat.full_stop(false), None);
    chat.send("again", "user-1");
    assert!(chat.busy());
    chat.stop();
    let second = owed(&chat.session);
    assert_ne!(first, second);
    assert_eq!(waits_asked(&chat), 2);
    // The first Stop's thread wakes late. It is not its unwind.
    assert!(!grace_runs_out_on(&chat, &chat.session, first).ended);
    assert!(chat.runs(&chat.session));
    assert!(running(&chat.session));
    assert_eq!(owed(&chat.session), second);
    // The second Stop's own does act, once.
    assert!(grace_runs_out_on(&chat, &chat.session, second).ended);
    assert!(!grace_runs_out_on(&chat, &chat.session, second).ended);
    assert!(!chat.live());

    // Another process: Stop, the grace, the chat started again, Stop.
    let chat = Listed::new(true);
    chat.stop();
    let first = owed(&chat.session);
    assert!(grace_runs_out(&chat).ended);
    let restarted = chat.start_again().expect("the next message starts it");
    chat.stop();
    let second = owed(&restarted);
    assert_ne!(first, second);
    // Nothing the first wait could still name ends the new process.
    assert!(!grace_runs_out_on(&chat, &chat.session, first).ended);
    assert!(!grace_runs_out_on(&chat, &restarted, first).ended);
    assert!(chat.runs(&restarted));
    assert!(running(&restarted));
    assert_eq!(owed(&restarted), second);
    assert!(grace_runs_out_on(&chat, &restarted, second).ended);
    assert!(!chat.live());
}

/// The thread a Stop really leaves behind, on a grace short enough to
/// wait for: it ends the process of a Stop that is not honoured, and
/// when the full stop came in time it wakes to nothing of its own, even
/// with the same process waiting out a later Stop by then.
#[test]
fn the_thread_behind_a_stop_acts_once_and_only_for_its_own_unwind() {
    use std::sync::atomic::Ordering;
    let chat = Listed::new(true);
    let over = || chat.manager.unwind_probe.over.load(Ordering::SeqCst);
    let wait = |grace: Option<Duration>| {
        *chat.manager.unwind_probe.grace.lock().unwrap() = grace;
    };

    // Honoured: the full stop comes inside the grace, and a later Stop
    // (with no thread of its own here) is waiting when the first wakes.
    wait(Some(Duration::from_secs(1)));
    chat.stop();
    assert_eq!(chat.full_stop(false), None);
    chat.send("again", "user-1");
    wait(None);
    chat.stop();
    let later = owed(&chat.session);
    until("the first Stop's wait is over", || over() == 1);
    assert!(chat.runs(&chat.session));
    assert!(running(&chat.session));
    assert_eq!(owed(&chat.session), later);

    // Not honoured: its own thread ends the process.
    assert_eq!(chat.full_stop(false), None);
    chat.send("and again", "user-2");
    wait(Some(Duration::from_millis(20)));
    chat.stop();
    until("the Stop's wait is over", || over() == 2);
    assert!(!chat.live());
    assert!(exited(&chat.session));
    assert_eq!(chat.session.lock().unwrap().cut_off, CutOff::Ended);
    assert_eq!(waits_asked(&chat), 3);
}

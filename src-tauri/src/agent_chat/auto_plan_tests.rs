use super::tests::{claude_session, hold};
use super::*;
use crate::orchestration::{automation::WorkerDefaults, PlanStatus, Run};

struct Lead {
    manager: Arc<ChatManager>,
    key: String,
    run: Run,
    session: Arc<Mutex<ChatSession>>,
}
impl Lead {
    fn new(agent: ChatAgent) -> Self {
        let manager = Arc::new(ChatManager::default());
        let key = format!("chat:auto-plan-{}", uuid::Uuid::new_v4().simple());
        let store = &manager.orchestrations;
        let run = store
            .create_run_with_mode(
                key.clone(),
                "Implement feature".into(),
                "workspace".into(),
                "/tmp".into(),
                None,
                crate::git_ops::workflow::WorkspaceMode::Direct,
            )
            .unwrap();
        store.require_plan_approval(&run.id).unwrap();
        store
            .configure_automation(
                &key,
                &run.id,
                Some(WorkerDefaults {
                    agent: Some(ChatAgent::Claude),
                    access: Access::Auto,
                    model: None,
                    effort: None,
                    recovery: None,
                }),
            )
            .unwrap();
        store
            .create_task(
                &key,
                run.id.clone(),
                "Implement".into(),
                "Make the change".into(),
                vec![],
                None,
                None,
            )
            .unwrap();
        store.auto_plan_set(&key, true, None).unwrap();
        let session = claude_session(true);
        session.lock().unwrap().agent = agent;
        hold(&manager, &key, session.clone());
        {
            let sessions = manager.sessions.lock().unwrap();
            manager.grant_capability(&sessions, &key, &key, "test-launch");
        }
        Self {
            manager,
            key,
            run,
            session,
        }
    }
    fn finish(&self, clean: bool) -> Option<CleanTurnEnd> {
        let mut s = self.session.lock().unwrap();
        let ((_, refused), ended) =
            end_turn_for_auto_plan(&self.manager, &self.key, &self.key, &mut s, clean, false);
        assert_eq!(refused, None);
        ended
    }
    fn observe_claude_init(&self) {
        let event = json!({"type":"system", "subtype":"init"});
        let observed = provider_for(ChatAgent::Claude).observe_event(&event);
        let mut s = self.session.lock().unwrap();
        assert!(observed.turn_opened);
        let was_busy = s.busy;
        let sequence = self.manager.turn_sequence(&self.key);
        let before = sequence.load(std::sync::atomic::Ordering::SeqCst);
        if !s.busy {
            self.manager.note_observed_turn(&self.key);
            s.turn_started();
        }
        assert_eq!(
            sequence.load(std::sync::atomic::Ordering::SeqCst),
            before + u64::from(!was_busy)
        );
    }
    fn replay(&self) -> Value {
        let s = self.session.lock().unwrap();
        let AutoPlanAttribution::Claude { uuid, content, .. } = &s.auto_plan_attribution else {
            panic!("expected a post-Stop Claude prompt");
        };
        json!({"type":"user", "isReplay":true, "uuid":uuid,
                "parent_tool_use_id":null, "message":{"role":"user", "content":content}})
    }
    fn observe_barrier(&self, event: &Value) {
        let mut session = self.session.lock().unwrap();
        session.auto_plan_attribution.observe(event);
        session.auto_plan_turn.observe_codex(event);
    }
    fn acknowledge_prompt(&self) {
        if self.session.lock().unwrap().codex.is_some() {
            let request_id = match &self.session.lock().unwrap().auto_plan_attribution {
                AutoPlanAttribution::Codex { request_id, .. } => request_id.clone(),
                _ => panic!("expected post-Stop native request"),
            };
            self.observe_barrier(&json!({"id":request_id,"result":{"turn":{"id":"post-stop"}}}));
            self.observe_barrier(
                &json!({"method":"turn/completed","params":{"turn":{"id":"post-stop"}}}),
            );
        } else {
            self.observe_barrier(&self.replay());
        }
    }
    fn prompt(&self, text: &str) {
        write_user_message_locked(
            &self.manager,
            &mut self.session.lock().unwrap(),
            &self.key,
            text,
            &[],
            None,
        )
        .unwrap();
    }
    fn apply(&self, ended: CleanTurnEnd) {
        self.manager
            .orchestrations
            .auto_approve_at_turn_end(ended)
            .unwrap();
    }
    fn approved(&self) -> bool {
        self.manager
            .orchestrations
            .snapshot(Some(&self.run.id))
            .unwrap()
            .runs[0]
            .plan_approval
            .as_ref()
            .unwrap()
            .status
            == PlanStatus::Approved
    }
}
impl Drop for Lead {
    fn drop(&mut self) {
        let _ = end_process(&self.manager, &self.key);
        crate::transcript::forget(&self.key);
    }
}

#[test]
fn a_failed_pi_coordinator_turn_does_not_approve_a_pending_plan() {
    let failed = Lead::new(ChatAgent::Pi);
    failed.session.lock().unwrap().answering = Some("person-turn".into());
    let clean = *completion_tests::pi_full_stops(completion_tests::PI_ERROR_EXHAUSTED)
        .last()
        .unwrap();
    assert!(failed.finish(clean).is_none());
    assert!(!failed.approved());

    let recovered = Lead::new(ChatAgent::Pi);
    recovered.session.lock().unwrap().answering = Some("person-turn".into());
    let clean = *completion_tests::pi_full_stops(completion_tests::PI_ERROR_RECOVERED)
        .last()
        .unwrap();
    let ended = recovered.finish(clean).expect("a clean end is evidence");
    recovered.apply(ended);
    assert!(recovered.approved());
}

fn pi_clean_stop() -> bool {
    *completion_tests::pi_full_stops(completion_tests::PI_ERROR_RECOVERED)
        .last()
        .unwrap()
}

#[test]
fn a_refused_pi_call_blocks_standing_plan_approval() {
    // Every kind of refusal the gate answers latches the turn; an
    // allowed call does not.
    for (refused, approved) in [(true, false), (false, true)] {
        let lead = Lead::new(ChatAgent::Pi);
        lead.session.lock().unwrap().answering = Some("person-turn".into());
        let call = lead
            .manager
            .pi_call_begin(&lead.key, Some("test-launch"), false)
            .unwrap();
        lead.manager.pi_call_end(&lead.key, &call, refused);
        match lead.finish(pi_clean_stop()) {
            Some(ended) => {
                assert!(approved, "a refused call must not leave a clean end");
                lead.apply(ended);
            }
            None => assert!(!approved),
        }
        assert_eq!(lead.approved(), approved);
    }
}

#[test]
fn an_unanswered_or_dropped_pi_card_blocks_standing_plan_approval() {
    // Still open at the full stop: not clean.
    let lead = Lead::new(ChatAgent::Pi);
    lead.session.lock().unwrap().answering = Some("person-turn".into());
    let open = lead.manager.pi_call_begin(&lead.key, None, true).unwrap();
    assert!(lead.finish(pi_clean_stop()).is_none());
    assert!(!lead.approved());
    lead.manager.pi_call_end(&lead.key, &open, true);

    // A card the person allowed leaves the turn clean again.
    let lead = Lead::new(ChatAgent::Pi);
    lead.session.lock().unwrap().answering = Some("person-turn".into());
    let allowed = lead.manager.pi_call_begin(&lead.key, None, true).unwrap();
    lead.manager.pi_call_end(&lead.key, &allowed, false);
    let ended = lead
        .finish(pi_clean_stop())
        .expect("an allowed card is no refusal");
    lead.apply(ended);
    assert!(lead.approved());
}

#[test]
fn a_late_pi_answer_from_an_older_turn_neither_latches_nor_clears() {
    let lead = Lead::new(ChatAgent::Pi);
    lead.session.lock().unwrap().answering = Some("person-turn".into());
    let old = lead.manager.pi_call_begin(&lead.key, None, true).unwrap();
    // A new turn starts: its state replaces the old one's.
    lead.prompt("next turn");
    let fresh = lead.manager.pi_call_begin(&lead.key, None, true).unwrap();
    // The old turn's refusal arrives late: nothing latches, nothing clears.
    lead.manager.pi_call_end(&lead.key, &old, true);
    {
        let s = lead.session.lock().unwrap();
        assert!(!s.auto_plan_refused);
        assert_eq!(s.auto_plan_turn.open_asks, 1);
    }
    lead.manager.pi_call_end(&lead.key, &fresh, true);
    assert!(lead.session.lock().unwrap().auto_plan_refused);
    // A call of another launch is not this session's at all.
    assert!(lead
        .manager
        .pi_call_begin(&lead.key, Some("another-launch"), true)
        .is_none());
}

#[test]
fn auto_plan_only_clean_own_full_stops_trigger_including_host_notifications() {
    for (agent, good, bad) in [
        (
            ChatAgent::Claude,
            json!({"type":"result","subtype":"success","is_error":false}),
            json!({"type":"result","subtype":"error_during_execution","is_error":true}),
        ),
        (
            ChatAgent::Codex,
            json!({"type":"turn.completed"}),
            json!({"type":"turn.failed","error":{"message":"failed"}}),
        ),
        (
            ChatAgent::Antigravity,
            json!({"event":"result","result":{"status":"SUCCESS"}}),
            json!({"event":"result","result":{"status":"ERROR"}}),
        ),
        (
            ChatAgent::Pi,
            json!({"type":"agent_settled","aborted":false}),
            json!({"type":"agent_settled","aborted":true,"error":"aborted"}),
        ),
    ] {
        for notification in [false, true] {
            let lead = Lead::new(agent);
            lead.session.lock().unwrap().answering = Some(
                if notification {
                    "octiq-notification-test"
                } else {
                    "person-turn"
                }
                .into(),
            );
            assert!(!lead.approved(), "never during the turn");
            assert!(!ended_cleanly(agent, &bad, false));
            let ended = lead.finish(ended_cleanly(agent, &good, false)).unwrap();
            lead.apply(ended);
            assert!(lead.approved());
            assert!(
                lead.finish(true).is_none(),
                "a duplicate full stop is not a turn"
            );
        }
        let failed = Lead::new(agent);
        assert!(failed.finish(ended_cleanly(agent, &bad, false)).is_none());
        assert!(!failed.approved());
    }
    let refused = Lead::new(ChatAgent::Antigravity);
    let event = json!({"event":"result","result":{"status":"SUCCESS","denied_actions":["write"]}});
    assert!(refused
        .finish(ended_cleanly(ChatAgent::Antigravity, &event, true))
        .is_none());
    assert!(!refused.approved());
    let seat = Lead::new(ChatAgent::Claude);
    let mut session = seat.session.lock().unwrap();
    let (_, ended) = end_turn_for_auto_plan(
        &seat.manager,
        "chat:seat#voice",
        &seat.key,
        &mut session,
        true,
        false,
    );
    assert!(ended.is_none());
}

#[test]
fn auto_plan_a_claude_refusal_prevents_approval_even_if_its_final_result_says_success() {
    let lead = Lead::new(ChatAgent::Claude);
    let (_, ended) = end_turn_for_auto_plan(
        &lead.manager,
        &lead.key,
        &lead.key,
        &mut lead.session.lock().unwrap(),
        true,
        true,
    );
    assert!(ended.is_none());
    assert!(!lead.approved());
}

#[test]
fn auto_plan_stop_interrupt_and_ended_process_never_trigger_even_with_a_success_full_stop() {
    for cut_off in [CutOff::Owed(1), CutOff::Ended] {
        let lead = Lead::new(ChatAgent::Claude);
        lead.session.lock().unwrap().cut_off = cut_off;
        assert!(lead.finish(true).is_none());
        assert!(!lead.approved());
    }
    let lead = Lead::new(ChatAgent::Claude);
    chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
    assert!(lead.finish(true).is_none());
    assert!(!lead.approved());
}

#[test]
fn auto_plan_epoch_and_sequence_veto_stop_replacement_off_and_new_turns() {
    for race in [
        "off",
        "new-turn",
        "new-turn-ended",
        "stopped",
        "ended",
        "replaced",
        "idle",
    ] {
        let lead = Lead::new(ChatAgent::Claude);
        let ended = lead.finish(true).unwrap();
        match race {
            "off" => {
                lead.manager
                    .orchestrations
                    .auto_plan_set(&lead.key, false, None)
                    .unwrap();
            }
            "new-turn" => {
                let mut s = lead.session.lock().unwrap();
                lead.manager.start_auto_plan_turn(&lead.key, &s);
                s.turn_started();
            }
            "new-turn-ended" => {
                let mut s = lead.session.lock().unwrap();
                lead.manager.start_auto_plan_turn(&lead.key, &s);
                s.turn_started();
                s.turn_ended();
            }
            "stopped" => {
                chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
            }
            "ended" => {
                end_process(&lead.manager, &lead.key).unwrap();
            }
            "replaced" => {
                end_process(&lead.manager, &lead.key).unwrap();
                hold(&lead.manager, &lead.key, claude_session(false));
            }
            _ => (),
        }
        lead.apply(ended);
        assert_eq!(lead.approved(), race == "idle", "{race}");
    }
}

#[test]
fn auto_plan_next_turn_edits_before_first_snapshot_wait_for_its_own_clean_end() {
    let lead = Lead::new(ChatAgent::Claude);
    // end_turn_locked dispatches N+1 before returning N's evidence.
    queue_waiting_turn(
        &lead.manager,
        &lead.key,
        &lead.key,
        "add a task",
        &[],
        Some("user-before-snapshot".into()),
    )
    .unwrap();
    let ended = lead.finish(true).unwrap();
    assert!(!ended.unchanged());
    lead.manager
        .orchestrations
        .create_task(
            &lead.key,
            lead.run.id.clone(),
            "Built by N+1".into(),
            "New scope".into(),
            vec![],
            None,
            None,
        )
        .unwrap();
    // N+1 has already mutated R into R+1 before N takes any ledger snapshot.
    lead.manager
        .orchestrations
        .auto_approve_at_turn_end_with(
            ended,
            || panic!("old evidence must fail before the first snapshot"),
            || panic!("old evidence must never stage approval"),
        )
        .unwrap();
    assert!(!lead.approved());
    assert!(crate::transcript::of_type(&lead.key, "octiq_plan_auto_approved").is_empty());
    lead.apply(lead.finish(true).unwrap());
    assert!(lead.approved());
    let events = crate::transcript::of_type(&lead.key, "octiq_plan_auto_approved");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["taskIds"].as_array().unwrap().len(), 2);
}

#[test]
fn auto_plan_next_turn_without_plan_edits_vetoes_before_first_snapshot() {
    for notification in [false, true] {
        let lead = Lead::new(ChatAgent::Claude);
        let ended = if notification {
            let ended = lead.finish(true).unwrap();
            write_user_message_locked(
                &lead.manager,
                &mut lead.session.lock().unwrap(),
                &lead.key,
                "host notification",
                &[],
                Some("octiq-notification-test"),
            )
            .unwrap();
            ended
        } else {
            queue_waiting_turn(
                &lead.manager,
                &lead.key,
                &lead.key,
                "ordinary handoff",
                &[],
                Some("user-handoff".into()),
            )
            .unwrap();
            lead.finish(true).unwrap()
        };
        lead.manager
            .orchestrations
            .auto_approve_at_turn_end_with(
                ended,
                || panic!("a next turn vetoes even without plan edits"),
                || {},
            )
            .unwrap();
        assert!(!lead.approved());
        lead.apply(lead.finish(true).unwrap());
        assert!(lead.approved());
    }
}

#[test]
fn auto_plan_idle_stop_then_buffered_observed_turn_never_restores_evidence() {
    for reaped in [false, true] {
        let lead = Lead::new(ChatAgent::Claude);
        let previous = lead.finish(true).unwrap();
        if reaped {
            // A natural reaper can remove the session before stdout is
            // drained; its reader still owns the original session Arc.
            lead.manager.sessions.lock().unwrap().remove(&lead.key);
        }
        let stopped = chat_interrupt_impl(&lead.manager, lead.key.clone());
        assert_eq!(stopped.is_ok(), !reaped);
        assert_eq!(lead.session.lock().unwrap().cut_off, CutOff::No);
        lead.observe_claude_init();
        assert!(!previous.unchanged());
        assert!(!lead
            .manager
            .auto_plan_launches
            .lock()
            .unwrap()
            .contains_key(&lead.key));
        let result = json!({"type":"result", "subtype":"success", "is_error":false});
        assert!(lead
            .finish(ended_cleanly(ChatAgent::Claude, &result, false))
            .is_none());
        assert!(!lead.approved());
        if reaped {
            // Restore only the table entry for the test child's cleanup.
            hold(&lead.manager, &lead.key, lead.session.clone());
        }
    }
}

#[test]
fn auto_plan_observed_turn_with_intact_evidence_approves_its_own_clean_end() {
    let lead = Lead::new(ChatAgent::Claude);
    let previous = lead.finish(true).unwrap();
    lead.observe_claude_init();
    assert!(!previous.unchanged(), "observed turn vetoes older evidence");
    lead.apply(previous);
    assert!(!lead.approved());
    lead.apply(lead.finish(true).expect("intact launch remains eligible"));
    assert!(lead.approved());
}

#[test]
fn auto_plan_real_prompt_after_stopped_observed_turn_restores_eligibility() {
    let lead = Lead::new(ChatAgent::Claude);
    lead.finish(true).unwrap();
    let (pid, launch) = {
        let s = lead.session.lock().unwrap();
        (s.child.id(), s.launch_id.clone())
    };
    chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
    lead.observe_claude_init();
    assert!(lead.finish(true).is_none());
    assert!(!lead.approved());
    assert_eq!(
        send_turn(
            lead.manager.clone(),
            lead.key.clone(),
            "real prompt after buffered output".into(),
            None,
            None,
            Some("user-after-observed-stop".into()),
        )
        .unwrap(),
        Sent::Written
    );
    {
        let s = lead.session.lock().unwrap();
        assert_eq!((s.child.id(), &s.launch_id), (pid, &launch));
    }
    lead.observe_claude_init();
    lead.acknowledge_prompt();
    lead.apply(
        lead.finish(true)
            .expect("replayed real prompt restores eligibility"),
    );
    assert!(lead.approved());
}

#[test]
fn auto_plan_persistent_stop_then_clean_turn_in_same_process_is_eligible() {
    for codex in [false, true] {
        let lead = Lead::new(if codex {
            ChatAgent::Codex
        } else {
            ChatAgent::Claude
        });
        if codex {
            lead.manager.test_as_codex_thread(&lead.key, Access::Auto);
        }
        let (pid, launch) = {
            let s = lead.session.lock().unwrap();
            (s.child.id(), s.launch_id.clone())
        };
        chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
        assert!(lead.finish(true).is_none(), "cut-off turn must not qualify");
        assert!(!lead.approved());
        assert_eq!(
            send_turn(
                lead.manager.clone(),
                lead.key.clone(),
                "next real turn".into(),
                None,
                None,
                Some("user-after-stop".into())
            )
            .unwrap(),
            Sent::Written
        );
        {
            let s = lead.session.lock().unwrap();
            assert_eq!(s.child.id(), pid);
            assert_eq!(s.launch_id, launch);
        }
        lead.acknowledge_prompt();
        lead.apply(
            lead.finish(true)
                .expect("same process's attributable clean turn is eligible"),
        );
        assert!(lead.approved());
    }
}

#[test]
fn auto_plan_idle_stop_prompt_then_any_buffered_autonomous_results_stay_ineligible() {
    for buffered in [1, 2, 8] {
        let lead = Lead::new(ChatAgent::Claude);
        lead.finish(true).unwrap();
        let pid = lead.session.lock().unwrap().child.id();
        chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
        assert_eq!(lead.session.lock().unwrap().cut_off, CutOff::No);
        lead.prompt("B");
        // B changes the revision before A's old buffered success is read.
        lead.manager
            .orchestrations
            .create_task(
                &lead.key,
                lead.run.id.clone(),
                "Added by B".into(),
                "B is still running".into(),
                vec![],
                None,
                None,
            )
            .unwrap();
        for _ in 0..buffered {
            lead.observe_claude_init();
            assert!(lead.finish(true).is_none());
            assert!(!lead.approved());
        }
        lead.observe_claude_init();
        lead.acknowledge_prompt();
        lead.apply(
            lead.finish(true)
                .expect("B's own replay crossed every earlier result"),
        );
        assert!(lead.approved());
        assert_eq!(lead.session.lock().unwrap().child.id(), pid);
        let events = crate::transcript::of_type(&lead.key, "octiq_plan_auto_approved");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["taskIds"].as_array().unwrap().len(), 2);
        // A following ordinary clean turn keeps its normal eligibility.
        lead.prompt("following real turn");
        lead.manager
            .orchestrations
            .create_task(
                &lead.key,
                lead.run.id.clone(),
                "Following revision".into(),
                "Own clean end".into(),
                vec![],
                None,
                None,
            )
            .unwrap();
        assert!(!lead.approved());
        lead.apply(lead.finish(true).unwrap());
        assert!(lead.approved());
        assert_eq!(
            crate::transcript::of_type(&lead.key, "octiq_plan_auto_approved").len(),
            2
        );
    }
}

#[test]
fn auto_plan_replay_requires_current_uuid_exact_payload_and_real_echo() {
    let lead = Lead::new(ChatAgent::Claude);
    lead.finish(true).unwrap();
    chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
    lead.prompt("identical text");
    let first = lead.replay();
    // Another real write can follow an old buffered full stop. Identical
    // content must not let the earlier prompt's echo unlock this one.
    lead.observe_claude_init();
    assert!(lead.finish(true).is_none());
    lead.prompt("identical text");
    let current = lead.replay();
    assert_ne!(first["uuid"], current["uuid"]);
    for event in [
        first,
        {
            let mut e = current.clone();
            e["isReplay"] = json!(false);
            e
        },
        {
            let mut e = current.clone();
            e["isSynthetic"] = json!(true);
            e
        },
        {
            let mut e = current.clone();
            e["message"]["content"] = json!("different");
            e
        },
    ] {
        lead.observe_barrier(&event);
        assert!(!lead
            .session
            .lock()
            .unwrap()
            .auto_plan_attribution
            .attributable());
    }
    lead.observe_barrier(&current);
    lead.apply(lead.finish(true).unwrap());
    assert!(lead.approved());
}

#[test]
fn auto_plan_busy_stop_owed_and_repeated_stop_do_not_double_count() {
    let lead = Lead::new(ChatAgent::Claude);
    let pid = lead.session.lock().unwrap().child.id();
    chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
    let owed = lead.session.lock().unwrap().cut_off;
    assert!(matches!(owed, CutOff::Owed(_)));
    chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
    assert_eq!(lead.session.lock().unwrap().cut_off, owed);
    queue_waiting_turn(&lead.manager, &lead.key, &lead.key, "B", &[], None).unwrap();
    assert!(lead.finish(true).is_none());
    assert_eq!(lead.session.lock().unwrap().cut_off, CutOff::No);
    assert!(
        lead.session.lock().unwrap().busy,
        "queue handed off exactly as before"
    );
    let old_replay = lead.replay();
    chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
    lead.observe_barrier(&old_replay);
    assert!(lead.finish(true).is_none());
    lead.prompt("C");
    lead.observe_barrier(&old_replay);
    assert!(!lead
        .session
        .lock()
        .unwrap()
        .auto_plan_attribution
        .attributable());
    lead.acknowledge_prompt();
    lead.apply(lead.finish(true).unwrap());
    assert!(lead.approved());
    assert_eq!(lead.session.lock().unwrap().child.id(), pid);
}

#[test]
fn auto_plan_native_codex_requires_matching_start_response_and_completion() {
    let lead = Lead::new(ChatAgent::Codex);
    lead.manager.test_as_codex_thread(&lead.key, Access::Auto);
    lead.finish(true).unwrap();
    chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
    lead.prompt("B");
    let request = match &lead.session.lock().unwrap().auto_plan_attribution {
        AutoPlanAttribution::Codex { request_id, .. } => request_id.clone(),
        _ => panic!("expected Codex request"),
    };
    lead.observe_barrier(&json!({"id":"older-request", "result":{"turn":{"id":"old"}}}));
    lead.observe_barrier(&json!({"method":"turn/completed", "params":{"turn":{"id":"old"}}}));
    assert!(lead.finish(true).is_none());
    lead.observe_barrier(&json!({"id":request, "result":{"turn":{"id":"B"}}}));
    lead.observe_barrier(&json!({"method":"turn/completed", "params":{"turn":{"id":"old"}}}));
    assert!(lead.finish(true).is_none());
    lead.observe_barrier(&json!({"method":"turn/completed", "params":{"turn":{"id":"B"}}}));
    assert!(!lead.session.lock().unwrap().busy);
    // The matching native completion proves the end even though an older
    // full stop already marked the host idle. No queue behavior changes.
    lead.apply(lead.finish(true).unwrap());
    assert!(lead.approved());
}

async fn native_card(lead: &Lead) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(card) = crate::permission::pending()
                .into_iter()
                .map(|card| serde_json::to_value(card).unwrap())
                .find(|card| card["chatKey"] == lead.key)
            {
                break card;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

async fn decline_and_wait(lead: &Lead, card: &Value) {
    assert!(crate::permission::decide(
        card["id"].as_str().unwrap(),
        crate::permission::Decision::Deny,
        false
    ));
    // This durable outcome follows the latch in the native callback. Do
    // not synchronize on busy/refusal itself: the broken baseline drops it.
    tokio::time::timeout(Duration::from_secs(3), async {
        while crate::transcript::of_type(&lead.key, crate::outcome::TOOL_EVENT).is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auto_plan_buffered_a_send_now_cancel_b_declined_c_never_approves() {
    crate::bus::client_joined();
    for method in [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
    ] {
        let lead = Lead::new(ChatAgent::Codex);
        lead.manager.test_as_codex_thread(&lead.key, Access::Auto);
        let pid = lead.session.lock().unwrap().child.id();
        // A's completion is in stdout but the reader has not consumed it.
        lead.session
            .lock()
            .unwrap()
            .codex
            .as_mut()
            .unwrap()
            .active_turn_id = Some("A".into());
        assert!(lead.session.lock().unwrap().busy);
        assert_eq!(
            send_turn(
                lead.manager.clone(),
                lead.key.clone(),
                "B".into(),
                None,
                None,
                Some("queued-B".into())
            )
            .unwrap(),
            Sent::Queued
        );
        assert!(
            chat_start_queued_impl(&lead.manager, lead.key.clone(), "queued-B".into()).unwrap()
        );
        assert_eq!(lead.session.lock().unwrap().cut_off, CutOff::No);
        assert!(!lead.session.lock().unwrap().busy);
        assert!(
            chat_cancel_queued_impl(&lead.manager, lead.key.clone(), "queued-B".into()).unwrap()
        );
        assert_eq!(
            send_turn(
                lead.manager.clone(),
                lead.key.clone(),
                "C".into(),
                None,
                None,
                Some("written-C".into())
            )
            .unwrap(),
            Sent::Written
        );
        let request = match &lead.session.lock().unwrap().auto_plan_attribution {
            AutoPlanAttribution::Codex { request_id, .. } => request_id.clone(),
            _ => panic!("C must be correlated"),
        };
        // Drain old A, which incorrectly makes the host idle during C.
        lead.observe_barrier(&json!({"method":"turn/completed", "params":{"turn":{"id":"A"}}}));
        assert!(lead.finish(true).is_none());
        lead.observe_barrier(&json!({"id":request, "result":{"turn":{"id":"C"}}}));
        lead.session
            .lock()
            .unwrap()
            .codex
            .as_mut()
            .unwrap()
            .active_turn_id = Some("C".into());
        assert!(!lead.session.lock().unwrap().busy);
        answer_codex_approval(
            &lead.session,
            &lead.key,
            Some(&tokio::runtime::Handle::current()),
            json!(301),
            method,
            json!({"threadId":"thread-1", "turnId":"C",
                    "command":"echo declined", "grantRoot":"/tmp", "itemId":"declined-C"}),
        );
        let card = native_card(&lead).await;
        decline_and_wait(&lead, &card).await;
        lead.observe_barrier(&json!({"method":"turn/completed", "params":{"turn":{"id":"C"}}}));
        assert!(
            lead.finish(true).is_none(),
            "a matching clean C cannot erase the person's decline"
        );
        assert!(!lead.approved());
        assert!(crate::transcript::of_type(&lead.key, "octiq_plan_auto_approved").is_empty());
        // A new real, correlated turn may recover in the same process.
        lead.prompt("D");
        lead.acknowledge_prompt();
        lead.apply(lead.finish(true).unwrap());
        assert!(lead.approved());
        assert_eq!(lead.session.lock().unwrap().child.id(), pid);
    }
    crate::bus::client_left();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auto_plan_late_native_decline_cannot_latch_a_newer_written_target() {
    crate::bus::client_joined();
    for include_native_id in [false, true] {
        let lead = Lead::new(ChatAgent::Codex);
        lead.manager.test_as_codex_thread(&lead.key, Access::Auto);
        chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
        lead.finish(false);
        lead.prompt("C");
        let mut params = json!({"command":"echo C", "itemId":"late-C"});
        if include_native_id {
            params["turnId"] = json!("C");
        }
        answer_codex_approval(
            &lead.session,
            &lead.key,
            Some(&tokio::runtime::Handle::current()),
            json!(302),
            "item/commandExecution/requestApproval",
            params,
        );
        let card = native_card(&lead).await;
        lead.finish(false);
        lead.prompt("D");
        decline_and_wait(&lead, &card).await;
        lead.acknowledge_prompt();
        lead.apply(lead.finish(true).expect("late C answer cannot latch D"));
        assert!(lead.approved());
    }
    crate::bus::client_left();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auto_plan_child_mcp_decline_blocks_its_correlated_parent_turn() {
    crate::bus::client_joined();
    for response_first in [false, true] {
        let lead = Lead::new(ChatAgent::Codex);
        lead.manager.test_as_codex_thread(&lead.key, Access::Auto);
        lead.finish(true);
        chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
        lead.prompt("C");
        let request = lead
            .session
            .lock()
            .unwrap()
            .auto_plan_turn
            .request_id
            .clone()
            .unwrap();
        let response = json!({"id":request, "result":{"turn":{"id":"C"}}});
        if response_first {
            lead.observe_barrier(&response);
        }
        answer_codex_server_request(
            &lead.manager,
            &lead.session,
            &lead.key,
            Some(&tokio::runtime::Handle::current()),
            json!({"id":307, "method":"mcpServer/elicitation/request", "params":{
                "threadId":"child-thread", "turnId":"child-turn", "serverName":"octiq",
                "mode":"form", "message":"Allow the child tool?",
                "requestedSchema":{"type":"object", "properties":{}}
            }}),
        );
        let card = native_card(&lead).await;
        assert_eq!(card["sessionId"], "child-thread");
        assert!(crate::permission::decide(
            card["id"].as_str().unwrap(),
            crate::permission::Decision::Deny,
            false,
        ));
        tokio::time::timeout(Duration::from_secs(3), async {
            while !lead
                .session
                .lock()
                .unwrap()
                .codex
                .as_ref()
                .unwrap()
                .elicitations
                .is_empty()
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        if !response_first {
            lead.observe_barrier(&response);
        }
        lead.observe_barrier(&json!({"method":"turn/completed", "params":{"turn":{"id":"C"}}}));
        assert!(
            lead.finish(true).is_none(),
            "child decline belongs to parent C"
        );
        assert!(!lead.approved());
        assert!(crate::transcript::of_type(&lead.key, "octiq_plan_auto_approved").is_empty());
        lead.prompt("D");
        lead.acknowledge_prompt();
        lead.apply(lead.finish(true).unwrap());
        assert!(lead.approved());
    }
    crate::bus::client_left();
}

#[test]
fn auto_plan_declines_are_native_turn_specific_before_or_after_start_response() {
    for response_first in [false, true] {
        let lead = Lead::new(ChatAgent::Codex);
        lead.manager.test_as_codex_thread(&lead.key, Access::Auto);
        lead.finish(true);
        chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
        lead.prompt("C");
        let request = lead
            .session
            .lock()
            .unwrap()
            .auto_plan_turn
            .request_id
            .clone()
            .unwrap();
        let response = json!({"id":request, "result":{"turn":{"id":"C"}}});
        if response_first {
            lead.observe_barrier(&response);
        }
        // A request from an older/other turn may itself be buffered until
        // after the new write; its native id must not poison C either.
        answer_codex_approval(
            &lead.session,
            &lead.key,
            None,
            json!(303),
            "item/fileChange/requestApproval",
            json!({"turnId":"older"}),
        );
        if !response_first {
            lead.observe_barrier(&response);
        }
        assert!(!lead.session.lock().unwrap().auto_plan_turn.refused());
        // Conversely C's decline cannot be cleared by an older answer.
        answer_codex_approval(
            &lead.session,
            &lead.key,
            None,
            json!(304),
            "item/fileChange/requestApproval",
            json!({"turnId":"C"}),
        );
        answer_codex_approval(
            &lead.session,
            &lead.key,
            None,
            json!(305),
            "item/fileChange/requestApproval",
            json!({"turnId":"older"}),
        );
        lead.observe_barrier(&json!({"method":"turn/completed", "params":{"turn":{"id":"C"}}}));
        assert!(lead.finish(true).is_none());
        assert!(!lead.approved());
    }
}

#[test]
fn auto_plan_native_decline_before_start_response_is_closed_even_without_stop() {
    let lead = Lead::new(ChatAgent::Codex);
    lead.manager.test_as_codex_thread(&lead.key, Access::Auto);
    lead.prompt("C");
    answer_codex_approval(
        &lead.session,
        &lead.key,
        None,
        json!(306),
        "item/commandExecution/requestApproval",
        json!({"turnId":"C"}),
    );
    assert!(lead.session.lock().unwrap().auto_plan_turn.refused());
    // No turn/start response to identify this end, and a refusal already
    // exists: Ready cannot treat missing correlation as a clean turn.
    assert!(lead.finish(true).is_none());
    assert!(!lead.approved());
}

#[test]
fn auto_plan_claude_recovery_denial_blocks_its_correlated_full_stop() {
    let lead = Lead::new(ChatAgent::Claude);
    // Same Send now/cancel/write/buffered-end order. Claude's denial is
    // stream-ordered after its own replay, rather than an async callback.
    queue_waiting_turn(
        &lead.manager,
        &lead.key,
        &lead.key,
        "B",
        &[],
        Some("B".into()),
    )
    .unwrap();
    chat_start_queued_impl(&lead.manager, lead.key.clone(), "B".into()).unwrap();
    chat_cancel_queued_impl(&lead.manager, lead.key.clone(), "B".into()).unwrap();
    lead.prompt("C");
    assert!(lead.finish(true).is_none());
    lead.observe_claude_init();
    lead.acknowledge_prompt();
    let ((_, refusal), end) = end_turn_for_auto_plan(
        &lead.manager,
        &lead.key,
        &lead.key,
        &mut lead.session.lock().unwrap(),
        true,
        true,
    );
    assert!(refusal.is_none());
    assert!(end.is_none());
    assert!(!lead.approved());
    lead.prompt("D");
    lead.acknowledge_prompt();
    lead.apply(lead.finish(true).unwrap());
    assert!(lead.approved());
}

#[test]
fn auto_plan_failed_or_refused_correlated_end_cannot_unlock_a_later_observed_turn() {
    for refused in [false, true] {
        let lead = Lead::new(ChatAgent::Claude);
        lead.finish(true).unwrap();
        chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
        lead.prompt("B");
        lead.acknowledge_prompt();
        lead.session.lock().unwrap().auto_plan_refused = refused;
        assert!(lead.finish(refused).is_none());
        assert!(matches!(
            lead.session.lock().unwrap().auto_plan_attribution,
            AutoPlanAttribution::Unattributed
        ));
        lead.observe_claude_init();
        assert!(lead.finish(true).is_none());
        lead.prompt("C");
        lead.acknowledge_prompt();
        lead.apply(lead.finish(true).unwrap());
        assert!(lead.approved());
    }
}

#[test]
fn auto_plan_recorded_claude_replays_keep_uuid_and_follow_earlier_result() {
    let events: Vec<Value> =
        include_str!("../../../web/src/lib/__fixtures__/claude-replay-uuid.jsonl")
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
    let echoes: Vec<_> = events
        .iter()
        .enumerate()
        .filter(|(_, e)| e["isReplay"] == true)
        .collect();
    assert_eq!(echoes.len(), 2);
    assert_eq!(echoes[0].1["uuid"], "179d9c88-72a5-4a10-a371-f465912b1878");
    assert_eq!(echoes[1].1["uuid"], "385e4807-077b-4a55-8715-6b927ff9abc1");
    assert_eq!(
        echoes[0].1["message"]["content"],
        echoes[1].1["message"]["content"]
    );
    assert!(events[echoes[0].0 + 1..echoes[1].0]
        .iter()
        .any(|e| e["type"] == "result"));
    let lead = Lead::new(ChatAgent::Claude);
    lead.finish(true).unwrap();
    chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
    lead.prompt("Reply with exactly the single word ready. Do not use tools.");
    lead.session.lock().unwrap().auto_plan_attribution = AutoPlanAttribution::Claude {
        uuid: "385e4807-077b-4a55-8715-6b927ff9abc1".into(),
        content: replay_content(&echoes[1].1["message"]["content"]),
        echoed: false,
    };
    for event in events {
        if event["type"] == "system" && event["subtype"] == "init" {
            lead.observe_claude_init();
        }
        lead.observe_barrier(&event);
        if event["type"] == "result" {
            let ended = lead.finish(true);
            if event["uuid"] == "82d73d3a-0232-4a8e-ac77-0317670dd714" {
                lead.apply(ended.unwrap());
            } else {
                assert!(ended.is_none());
            }
        }
    }
    assert!(lead.approved());
}

#[test]
fn auto_plan_a_natural_one_shot_exit_can_be_reaped_before_its_buffered_full_stop() {
    for reaped_first in [false, true] {
        for intervention in ["none", "replacement", "stop", "interrupt"] {
            let lead = Lead::new(ChatAgent::Codex);
            {
                let sessions = lead.manager.sessions.lock().unwrap();
                lead.manager
                    .grant_capability(&sessions, &lead.key, &lead.key, "test-launch");
            }
            let mut ended = if reaped_first {
                None
            } else {
                lead.finish(true)
            };
            {
                let mut session = lead.session.lock().unwrap();
                session.stdin.take();
                assert!(session.child.wait().unwrap().success());
            }
            // The natural reaper, unlike stop_process, does not mark Ended.
            lead.manager.sessions.lock().unwrap().remove(&lead.key);
            if reaped_first {
                ended = lead.finish(true);
            }
            match intervention {
                "replacement" => {
                    // Even a newer process that has already ended invalidates
                    // the old buffered stop. The table alone cannot prove it.
                    lead.manager.test_launch(&lead.key);
                    lead.manager.test_end(&lead.key);
                }
                "stop" => {
                    chat_stop_impl(&lead.manager, lead.key.clone()).unwrap();
                }
                "interrupt" => {
                    assert!(chat_interrupt_impl(&lead.manager, lead.key.clone()).is_err());
                }
                _ => (),
            }
            lead.apply(ended.unwrap());
            assert_eq!(lead.approved(), intervention == "none");
        }
    }
}

#[test]
fn auto_plan_a_new_revision_waits_for_the_next_clean_turn() {
    let lead = Lead::new(ChatAgent::Claude);
    lead.apply(lead.finish(true).unwrap());
    assert!(lead.approved());
    lead.manager
        .orchestrations
        .create_task(
            &lead.key,
            lead.run.id.clone(),
            "Follow-up".into(),
            "Implement follow-up".into(),
            vec![],
            None,
            None,
        )
        .unwrap();
    assert!(!lead.approved());
    lead.session.lock().unwrap().turn_started();
    assert!(!lead.approved());
    lead.apply(lead.finish(true).unwrap());
    assert!(lead.approved());
    let events = crate::transcript::of_type(&lead.key, "octiq_plan_auto_approved");
    assert_eq!(events.len(), 2);
    assert!(events[1]["revision"].as_u64().unwrap() > events[0]["revision"].as_u64().unwrap());
}

#[test]
fn auto_plan_send_during_staged_write_is_delivered_and_vetoes() {
    use std::io::BufRead;
    let mut lead = Lead::new(ChatAgent::Claude);
    end_process(&lead.manager, &lead.key).unwrap();
    let (session, mut received) = super::tests::capturing_claude_session();
    lead.session = session.clone();
    hold(&lead.manager, &lead.key, session);
    {
        let sessions = lead.manager.sessions.lock().unwrap();
        lead.manager
            .grant_capability(&sessions, &lead.key, &lead.key, "test-launch");
    }
    let ended = lead.finish(true).unwrap();
    let epoch = ended.epoch;
    let counter = ended.stop_epoch.clone();
    lead.manager
        .orchestrations
        .auto_approve_at_turn_end_with(
            ended,
            || {},
            || {
                // This hook runs with ONLY the ledger held, after temp write.
                assert!(lead.manager.sessions.try_lock().is_ok());
                assert!(lead.session.try_lock().is_ok());
                assert_eq!(
                    send_turn(
                        lead.manager.clone(),
                        lead.key.clone(),
                        "normal follow-up".into(),
                        None,
                        None,
                        Some("user-staging-follow-up".into())
                    )
                    .unwrap(),
                    Sent::Written
                );
                let mut line = String::new();
                received.read_line(&mut line).unwrap();
                let sent: Value = serde_json::from_str(&line).unwrap();
                assert!(sent.to_string().contains("normal follow-up"));
                assert_eq!(
                    lead.session.lock().unwrap().answering.as_deref(),
                    Some("user-staging-follow-up")
                );
                assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), epoch);
                assert_eq!(lead.manager.queued_messages(&lead.key), 0);
            },
        )
        .unwrap();
    assert!(!lead.approved());
    assert!(crate::transcript::of_type(&lead.key, "octiq_plan_auto_approved").is_empty());
    lead.apply(lead.finish(true).unwrap());
    assert!(lead.approved());
    assert_eq!(
        crate::transcript::of_type(&lead.key, "octiq_plan_auto_approved").len(),
        1
    );
}

#[test]
fn auto_plan_staging_does_not_wait_for_a_send_waiting_on_normal_workspace_admission() {
    use std::io::BufRead;
    let mut lead = Lead::new(ChatAgent::Claude);
    end_process(&lead.manager, &lead.key).unwrap();
    let (session, mut heard) = super::tests::capturing_claude_session();
    lead.session = session.clone();
    hold(&lead.manager, &lead.key, session);
    {
        let sessions = lead.manager.sessions.lock().unwrap();
        lead.manager
            .grant_capability(&sessions, &lead.key, &lead.key, "test-launch");
    }
    let mut start = StartContext::for_test(ChatAgent::Claude, None);
    start.cwd = "/tmp".into();
    start.access = Some(Access::Auto);
    lead.manager.remember_start(&lead.key, start);
    let ended = lead.finish(true).unwrap();
    let counter = ended.stop_epoch.clone();
    let epoch = ended.epoch;
    let (starting, started) = std::sync::mpsc::channel();
    let (finished, delivered) = std::sync::mpsc::channel();
    let manager = lead.manager.clone();
    let key = lead.key.clone();
    lead.manager
        .orchestrations
        .auto_approve_at_turn_end_with(
            ended,
            || {},
            || {
                thread::spawn(move || {
                    starting.send(()).unwrap();
                    let result = send_turn(
                        manager,
                        key,
                        "normal admission follow-up".into(),
                        None,
                        None,
                        Some("user-admission-follow-up".into()),
                    );
                    finished.send(result).unwrap();
                });
                started.recv_timeout(Duration::from_secs(3)).unwrap();
                // The send's existing workspace gate may wait for this ledger.
                // Approval never waits for any session table or send handoff.
                assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), epoch);
            },
        )
        .unwrap();
    assert!(lead.approved());
    assert_eq!(
        delivered
            .recv_timeout(Duration::from_secs(10))
            .expect("normal send must finish after approval releases ledger")
            .unwrap(),
        Sent::Written
    );
    let mut line = String::new();
    heard.read_line(&mut line).unwrap();
    assert!(line.contains("normal admission follow-up"));
    assert_eq!(
        lead.session.lock().unwrap().answering.as_deref(),
        Some("user-admission-follow-up")
    );
    assert_eq!(lead.manager.queued_messages(&lead.key), 0);
}

#[test]
fn auto_plan_next_turn_task_revision_vetoes_snapshot_then_next_clean_end_approves() {
    let lead = Lead::new(ChatAgent::Claude);
    let ended = lead.finish(true).unwrap();
    let epoch = ended.epoch;
    let counter = ended.stop_epoch.clone();
    let old_revision = lead
        .manager
        .orchestrations
        .snapshot(Some(&lead.run.id))
        .unwrap()
        .runs[0]
        .plan_approval
        .as_ref()
        .unwrap()
        .revision;
    lead.manager
        .orchestrations
        .auto_approve_at_turn_end_with(
            ended,
            || {
                assert_eq!(
                    send_turn(
                        lead.manager.clone(),
                        lead.key.clone(),
                        "add another task".into(),
                        None,
                        None,
                        Some("user-next-revision".into())
                    )
                    .unwrap(),
                    Sent::Written
                );
                lead.manager
                    .orchestrations
                    .create_task(
                        &lead.key,
                        lead.run.id.clone(),
                        "Next turn task".into(),
                        "New scope".into(),
                        vec![],
                        None,
                        None,
                    )
                    .unwrap();
                let current = lead
                    .manager
                    .orchestrations
                    .snapshot(Some(&lead.run.id))
                    .unwrap();
                assert!(current.runs[0].plan_approval.as_ref().unwrap().revision > old_revision);
                assert_eq!(
                    counter.load(std::sync::atomic::Ordering::SeqCst),
                    epoch,
                    "task changes veto by revision, not Stop epoch"
                );
            },
            || panic!("stale revision must not reach staged publication"),
        )
        .unwrap();
    assert!(!lead.approved());
    assert!(crate::transcript::of_type(&lead.key, "octiq_plan_auto_approved").is_empty());
    lead.apply(lead.finish(true).unwrap());
    assert!(lead.approved());
    let events = crate::transcript::of_type(&lead.key, "octiq_plan_auto_approved");
    assert_eq!(events.len(), 1);
    assert!(events[0]["revision"].as_u64().unwrap() > u64::from(old_revision));
    assert_eq!(events[0]["taskIds"].as_array().unwrap().len(), 2);
}

#[test]
fn auto_plan_live_one_shot_stop_preserves_queued_turn_with_or_without_staged_approval() {
    use std::io::BufRead;
    for in_flight in [false, true] {
        let _exec = crate::agent_provider::tests::CommandLineCodex::on();
        let lead = Lead::new(ChatAgent::Codex);
        let ended = lead.finish(true).unwrap();
        let epoch = ended.epoch;
        let counter = ended.stop_epoch.clone();
        // The successful one-shot is still a live entry, not yet reaped.
        {
            let mut old = lead.session.lock().unwrap();
            old.stdin.take();
            assert!(old.child.wait().unwrap().success());
        }
        // A durable accepted envelope is NOT a dispatch receipt.
        for (id, text) in [("user-queued-one", "first"), ("user-queued-two", "/status")] {
            assert_eq!(
                send_turn(
                    lead.manager.clone(),
                    lead.key.clone(),
                    text.into(),
                    None,
                    None,
                    Some(id.into())
                )
                .unwrap(),
                Sent::Queued
            );
            assert!(durable_user_turn_exists(&lead.key, id).unwrap());
        }
        assert_eq!(lead.manager.queued_messages(&lead.key), 2);
        let (next, mut heard) = super::tests::capturing_claude_session();
        next.lock().unwrap().busy = false;
        let stop_and_deliver = || {
            // A durable envelope cannot turn a start into an accepted
            // no-op while this live entry still owns the queue (36fa3d48).
            let started = start_session(
                lead.manager.clone(),
                Voice::host(lead.key.clone()),
                "/never-started".into(),
                ChatAgent::Codex,
                None,
                Some(Access::Auto),
                Some("first".into()),
                None,
                None,
                None,
                None,
                None,
                None,
                Some("user-queued-one".into()),
                false,
                None,
            );
            assert!(started.unwrap_err().contains("already running"));
            assert_eq!(lead.manager.queued_messages(&lead.key), 2);
            let stopped = interrupt_session_with(&lead.manager, &lead.key, &lead.key, |turn| {
                assert_eq!(turn.turn_id.as_deref(), Some("user-queued-one"));
                assert_eq!(turn.text, "first");
                hold(&lead.manager, &lead.key, next.clone());
                // Real pipe delivery, rather than accepting the envelope
                // again and reporting Started without sending any bytes.
                write_user_message_locked(
                    &lead.manager,
                    &mut next.lock().unwrap(),
                    &lead.key,
                    &turn.text,
                    &turn.images,
                    turn.turn_id.as_deref(),
                )?;
                for id in turn.turn_ids() {
                    record_delivery(&lead.key, Some(id), "dispatched");
                }
                Ok(())
            })
            .unwrap();
            assert!(stopped.stopped);
            assert_eq!(stopped.waiting, 1);
            assert!(counter.load(std::sync::atomic::Ordering::SeqCst) > epoch);
            assert_eq!(
                next.lock().unwrap().answering.as_deref(),
                Some("user-queued-one")
            );
            let mut line = String::new();
            heard.read_line(&mut line).unwrap();
            assert!(line.contains("first"));
            // Normal boundary delivers the second accepted unit once.
            end_turn_locked(
                &lead.manager,
                &lead.key,
                &lead.key,
                &mut next.lock().unwrap(),
                true,
            );
            line.clear();
            heard.read_line(&mut line).unwrap();
            assert!(line.contains("/status"));
            assert_eq!(
                next.lock().unwrap().answering.as_deref(),
                Some("user-queued-two")
            );
            assert_eq!(lead.manager.queued_messages(&lead.key), 0);
            assert!(!lead.manager.handoffs.lock().unwrap().contains(&lead.key));
        };
        if in_flight {
            lead.manager
                .orchestrations
                .auto_approve_at_turn_end_with(ended, || {}, stop_and_deliver)
                .unwrap();
        } else {
            let mut stop_and_deliver = stop_and_deliver;
            stop_and_deliver();
            lead.apply(ended);
        }
        assert!(!lead.approved());
        let deliveries = crate::transcript::of_type(&lead.key, "octiq_user_turn_delivery");
        for id in ["user-queued-one", "user-queued-two"] {
            assert_eq!(
                deliveries
                    .iter()
                    .filter(|event| event["uuid"] == id && event["state"] == "dispatched")
                    .count(),
                1,
                "{id}: {deliveries:?}"
            );
        }
    }
}

#[test]
fn auto_plan_observed_source_never_regrants_launch_evidence() {
    let source = super::tests::production_source();
    let production = source.as_str();
    let observed = production
        .split("if observed.turn_opened && !session.busy {")
        .nth(1)
        .unwrap()
        .split('}')
        .next()
        .unwrap();
    assert!(observed.contains("reading.note_observed_turn(&session_key)"));
    assert!(!observed.contains("start_auto_plan_turn"));
    assert!(!observed.contains("auto_plan_launches"));
    let note = production
        .split("fn note_observed_turn(")
        .nth(1)
        .unwrap()
        .split("fn start_auto_plan_turn(")
        .next()
        .unwrap();
    assert!(!note.contains("auto_plan_launches"));
    // Exactly the definition and the host prompt writer; no output
    // handler may restore eligibility. New launches grant separately.
    assert_eq!(production.matches("start_auto_plan_turn(").count(), 2);
}

#[test]
fn auto_plan_approval_source_never_takes_a_session_table_or_chat_lock() {
    let source = include_str!("../orchestration/auto_plan.rs");
    // Cut at the test MODULE: an earlier `#[cfg(test)]` is a small test-only fn.
    let production = source.split("#[cfg(test)]\nmod tests {").next().unwrap();
    for forbidden in [
        ".sessions",
        ".queued_turns",
        ".handoffs",
        ".auto_plan_launches",
        ".stop_epochs",
        ".turn_sequences",
    ] {
        assert!(
            !production.contains(forbidden),
            "approval must not acquire {forbidden}"
        );
    }
    let sources = super::tests::production_sources();
    let chat = sources
        .iter()
        .find(|(_, text)| text.contains("impl CleanTurnEnd {"))
        .map(|(_, text)| text.as_str())
        .unwrap();
    let evidence = chat
        .split("impl CleanTurnEnd {")
        .nth(1)
        .unwrap()
        .split("fn end_turn_for_auto_plan(")
        .next()
        .unwrap();
    assert!(
        !evidence.contains(".lock()"),
        "approval evidence check is atomic only"
    );
    let capture = chat
        .split("fn end_turn_for_auto_plan(")
        .nth(1)
        .unwrap()
        .split("fn end_turn_locked(")
        .next()
        .unwrap();
    assert!(
        !capture.contains(".sessions"),
        "use the existing writer lock; never relock the table"
    );
}

#[test]
fn auto_plan_epoch_veto_needs_no_session_table_or_session_lock() {
    for intervention in ["stop", "end"] {
        let lead = Lead::new(ChatAgent::Claude);
        let ended = lead.finish(true).unwrap();
        let epoch = ended.epoch;
        let _table = lead.manager.sessions.lock().unwrap();
        let _session = lead.session.lock().unwrap();
        // The Stop's first step can run even while both chat locks are
        // held elsewhere. It never waits for the staged ledger either.
        lead.manager.revoke_auto_plan(&lead.key);
        assert!(
            ended.stop_epoch.load(std::sync::atomic::Ordering::SeqCst) > epoch,
            "{intervention}"
        );
        assert!(!ended.decide());
    }
}

#[test]
fn auto_plan_live_one_shot_stop_revokes_a_successful_buffered_full_stop() {
    for ended_first in [false, true] {
        let _exec = crate::agent_provider::tests::CommandLineCodex::on();
        let lead = Lead::new(ChatAgent::Codex);
        assert!(relaunches_to_continue(ChatAgent::Codex));
        {
            let sessions = lead.manager.sessions.lock().unwrap();
            lead.manager
                .grant_capability(&sessions, &lead.key, &lead.key, "test-launch");
        }
        {
            let mut session = lead.session.lock().unwrap();
            session.stdin.take();
            assert!(session.child.wait().unwrap().success());
        }
        let ended = ended_first.then(|| lead.finish(true).unwrap());
        // The exited process is still IN the table: exercise the live
        // one-shot branch, never the no-session Stop branch.
        assert!(lead
            .manager
            .sessions
            .lock()
            .unwrap()
            .contains_key(&lead.key));
        let epoch = lead.manager.stop_epoch(&lead.key);
        let before_stop = epoch.load(std::sync::atomic::Ordering::SeqCst);
        chat_interrupt_impl(&lead.manager, lead.key.clone()).unwrap();
        assert!(epoch.load(std::sync::atomic::Ordering::SeqCst) > before_stop);
        assert!(!lead
            .manager
            .auto_plan_launches
            .lock()
            .unwrap()
            .contains_key(&lead.key));
        assert!(lead.finish(true).is_none());
        if let Some(ended) = ended {
            lead.apply(ended);
        }
        assert!(!lead.approved());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auto_plan_codex_native_decline_latches_until_the_next_turn() {
    struct Browser;
    impl Drop for Browser {
        fn drop(&mut self) {
            crate::bus::client_left();
        }
    }
    crate::bus::client_joined();
    let _browser = Browser;
    let lead = Lead::new(ChatAgent::Codex);
    lead.manager.test_as_codex_thread(&lead.key, Access::Auto);
    answer_codex_approval(
        &lead.session,
        &lead.key,
        Some(&tokio::runtime::Handle::current()),
        json!(1),
        "item/commandExecution/requestApproval",
        json!({"command":"echo declined", "itemId":"native-decline"}),
    );
    let card = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(card) = crate::permission::pending()
                .into_iter()
                .map(|card| serde_json::to_value(card).unwrap())
                .find(|card| card["chatKey"] == lead.key)
            {
                break card;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        send_turn(
            lead.manager.clone(),
            lead.key.clone(),
            "follow-up".into(),
            None,
            None,
            Some("native-follow-up".into())
        )
        .unwrap(),
        Sent::Queued
    );
    assert!(crate::permission::decide(
        card["id"].as_str().unwrap(),
        crate::permission::Decision::Deny,
        false
    ));
    tokio::time::timeout(Duration::from_secs(3), async {
        while !lead.session.lock().unwrap().auto_plan_refused {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(lead.finish(true).is_none());
    assert!(!lead.approved());
    // The queued turn starts only after the refused turn ends.
    assert_eq!(
        lead.session.lock().unwrap().answering.as_deref(),
        Some("native-follow-up")
    );
    lead.apply(lead.finish(true).unwrap());
    assert!(lead.approved());
}

#[test]
fn auto_plan_concurrent_start_session_and_turn_end_finish_within_timeout() {
    // A bad cwd guarantees no real provider/model is ever launched, while
    // still traversing BOTH workspace admissions and the session table.
    for iteration in 0..12 {
        let stopped = iteration % 2 == 1;
        let lead = Arc::new(Lead::new(ChatAgent::Claude));
        let ended = lead.finish(true).unwrap();
        let root = crate::test_dir::TestDir::new("auto-plan-concurrent-start");
        let cwd = root.join("missing").to_string_lossy().to_string();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let (done, received) = std::sync::mpsc::channel();
        let start_lead = lead.clone();
        let start_barrier = barrier.clone();
        let start_done = done.clone();
        thread::spawn(move || {
            start_barrier.wait();
            let result = start_session(
                start_lead.manager.clone(),
                Voice::host(format!("chat:start-{}", uuid::Uuid::new_v4())),
                cwd,
                ChatAgent::Claude,
                None,
                Some(Access::Auto),
                Some("never run".into()),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                false,
                None,
            );
            assert!(result.is_err());
            start_done.send(()).unwrap();
        });
        let approval_lead = lead.clone();
        let approval_barrier = barrier.clone();
        thread::spawn(move || {
            approval_barrier.wait();
            if stopped {
                approval_lead.manager.revoke_auto_plan(&approval_lead.key);
                assert!(
                    !ended.decide(),
                    "concurrent start cannot hide Stop's epoch veto"
                );
            }
            approval_lead.apply(ended);
            done.send(()).unwrap();
        });
        barrier.wait();
        received
            .recv_timeout(Duration::from_secs(10))
            .expect("start/approval must not deadlock");
        received
            .recv_timeout(Duration::from_secs(10))
            .expect("approval/start must not deadlock");
        assert_eq!(lead.approved(), !stopped);
    }
}

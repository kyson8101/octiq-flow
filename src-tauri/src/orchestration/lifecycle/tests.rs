use super::*;
use serde_json::Value;

fn worker(store: &OrchestrationStore) -> (Run, Attempt) {
    let run = super::super::tests::run(store);
    let task = super::super::tests::task(store, &run, vec![]);
    let (_, _, attempt, _) = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                task_id: task.id,
                agent: ChatAgent::Codex,
                model: None,
                effort: None,
                access: Access::Auto,
                new_worktree: Some(true),
                base_branch: String::new(),
            },
        )
        .unwrap();
    let attempt = store
        .activate_attempt(&attempt.id, "/tmp".into(), "worker".into(), true)
        .unwrap();
    (run, attempt)
}

fn register(attempt: &Attempt, port: u16) -> Registration {
    Registration {
        attempt_id: attempt.id.clone(),
        name: "Frontend".into(),
        host: "127.0.0.1".parse().unwrap(),
        port,
        recovery: "Restore the retained frontend workspace, then verify application health.".into(),
    }
}

/// Who an open gate waits for, as the run panel reads it: the
/// coordinator for a worker's question, the person for a gate the
/// coordinator opened itself. Derived for the read, gone once the gate
/// has settled, never stored, and never taken from JSON that says so.
#[test]
fn an_open_gate_says_who_it_waits_for_and_nobody_can_set_it() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let ask = |from: &str, question: &str| {
        store
            .create_gate(from, run.id.clone(), None, question.into(), vec![])
            .unwrap()
    };
    let asked = ask(&attempt.worker_chat_key, "Which sprite size?");
    let wide = ask("chat:master", "Ship today?");
    assert!(asked.awaits.is_none() && wide.awaits.is_none());
    let awaits = |gate: &Gate| {
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let read = snapshot.gates.iter().find(|g| g.id == gate.id).unwrap();
        let json = serde_json::to_value(read).unwrap();
        assert_eq!(
            json.get("awaits").cloned(),
            read.awaits.map(|who| serde_json::to_value(who).unwrap())
        );
        (read.awaits, json.get("awaits").cloned())
    };
    assert_eq!(
        awaits(&asked),
        (Some(Awaits::Coordinator), Some(json!("coordinator")))
    );
    assert_eq!(awaits(&wide), (Some(Awaits::Person), Some(json!("person"))));
    store
        .resolve_gate("chat:master", asked.id.clone(), "96 by 96".into())
        .unwrap();
    assert_eq!(
        awaits(&asked),
        (None, None),
        "a settled gate waits for nobody"
    );
    assert!(store
        .inner
        .lock()
        .unwrap()
        .data
        .gates
        .values()
        .all(|gate| gate.awaits.is_none()));
    let mut forged = serde_json::to_value(&wide).unwrap();
    forged["awaits"] = json!("nobody");
    let read: Gate = serde_json::from_value(forged).unwrap();
    assert_eq!(read.awaits, None);
}

/// Review of 931b5f0, C2: who must decide a card does not depend on
/// whether its attempt can go on this minute. A worker's safety card is
/// up, and the worker then opens a gate of its own, which blocks the
/// attempt. The card is still the person's to answer. What changed is
/// said apart: nothing can continue the attempt until the gate is
/// answered too.
#[test]
fn a_safety_card_waits_for_the_person_while_its_attempt_is_blocked_on_a_gate() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    crate::safety_block::observe(ChatAgent::Codex, &chat,
            "codex_core::tools::router: error=This action was rejected due to unacceptable risk.\\nReason: Requires a decision.");
    let card = |store: &OrchestrationStore| {
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let decision = snapshot.native_decisions[0].clone();
        let sent = serde_json::to_value(&decision).unwrap()["awaits"].clone();
        (
            decision.awaits,
            decision.continuation,
            decision.recovery,
            sent,
        )
    };
    let (awaits, continuation, _, sent) = card(&store);
    assert_eq!(awaits, Some(Awaits::Person));
    assert_eq!(continuation, "new_turn_same_attempt");
    assert_eq!(sent, "person");

    let gate = store
        .create_gate(&chat, run.id.clone(), None, "Other question".into(), vec![])
        .unwrap();
    let blocked = store.snapshot(Some(&run.id)).unwrap();
    assert_eq!(
        blocked
            .attempts
            .iter()
            .find(|a| a.id == attempt.id)
            .unwrap()
            .status,
        AttemptStatus::Blocked
    );
    assert!(crate::safety_block::awaits_decision(&chat));
    let (awaits, continuation, recovery, sent) = card(&store);
    assert_eq!(awaits, Some(Awaits::Person), "still theirs to answer");
    assert_eq!(sent, "person");
    assert_eq!(continuation, "unavailable", "and said apart");
    assert_eq!(recovery, BLOCKED_ON_GATE_RECOVERY);

    store
        .resolve_gate("chat:master", gate.id, "Resolved".into())
        .unwrap();
    let (awaits, continuation, _, _) = card(&store);
    assert_eq!(awaits, Some(Awaits::Person));
    assert_eq!(continuation, "new_turn_same_attempt");

    // The run is stopped with the card still up: the attempt is over,
    // and nothing a person answers on that card can continue it.
    store
        .stop_run("chat:master", run.id.clone(), "Not now".into())
        .unwrap();
    let (awaits, continuation, _, _) = card(&store);
    assert_ne!(awaits, Some(Awaits::Person));
    assert_eq!(continuation, "unavailable");
    crate::safety_block::forget_chat(&chat);
}

#[test]
fn native_decision_visibility_is_scoped_and_does_not_invent_action_or_approval() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    crate::safety_block::observe(ChatAgent::Codex, &attempt.worker_chat_key,
            "codex_core::tools::router: error=This action was rejected due to unacceptable risk.\\nReason: Upload requires a decision.");
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let decision = &snapshot.native_decisions[0];
    assert_eq!(decision.status, "pending");
    assert_eq!(decision.attempt_id, attempt.id);
    assert_eq!(decision.reason, "Upload requires a decision.");
    assert_eq!(decision.continuation, "new_turn_same_attempt");
    assert!(decision.blocked_action.is_none());
    // The worker is held until the person answers this card: theirs.
    assert_eq!(decision.awaits, Some(Awaits::Person));
    assert_eq!(serde_json::to_value(decision).unwrap()["awaits"], "person");
    let view = agent_view::agent_snapshot(
        snapshot,
        &agent_view::AgentRead {
            actor: "chat:master",
            run_id: Some(&run.id),
            task_id: None,
            message_limit: 12,
        },
    )
    .unwrap();
    assert_eq!(view["nativeDecisions"][0]["attemptId"], attempt.id);
    assert!(store
        .snapshot(Some("different-run"))
        .unwrap()
        .native_decisions
        .is_empty());
    crate::safety_block::forget_chat(&attempt.worker_chat_key);
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    // How it went, not merely that it went: a new message superseded it.
    assert_eq!(snapshot.native_decisions[0].status, "superseded");
    assert_eq!(snapshot.native_decisions[0].continuation, "unavailable");
    // No longer pending: it waits for nobody and says nothing of it.
    assert_eq!(snapshot.native_decisions[0].awaits, None);
    assert!(serde_json::to_value(&snapshot.native_decisions[0])
        .unwrap()
        .get("awaits")
        .is_none());
    // Derived for the read, never kept, and not an agent's to say.
    assert!(store
        .inner
        .lock()
        .unwrap()
        .data
        .native_decisions
        .values()
        .all(|decision| decision.awaits.is_none()));
    let mut forged = serde_json::to_value(&snapshot.native_decisions[0]).unwrap();
    forged["awaits"] = json!("person");
    let read: NativeDecision = serde_json::from_value(forged).unwrap();
    assert_eq!(read.awaits, None);
    assert!(snapshot.native_decisions[0]
        .recovery
        .contains("does not prove approval"));
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id,
                outcome: WorkerOutcome::Blocked,
                summary: "Upload remains blocked".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    assert!(store.snapshot(Some(&run.id)).unwrap().native_decisions[0]
        .recovery
        .contains("settled"));
}

/// Feedback 56dd3f24: a Claude worker refused by auto mode left no
/// decision record (nativeDecisions empty, later "stalled"). It is a
/// decision now, naming the refused call. d59f830a (a way to allow that
/// exact call) stays open: nothing can approve it, and the record says so.
#[test]
fn a_claude_auto_mode_refusal_is_recorded_and_offers_no_approval() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    let line = "eas update --branch production --message 'OTA 1.4.2'";
    let input = json!({ "command": line });
    let denial = json!({
        "type": "system", "subtype": "permission_denied",
        "decision_reason": "[Production Deploy]", "decision_reason_type": "classifier",
        "message": "Permission for this action was denied by the Claude Code auto mode classifier.",
        "tool_name": "Bash", "tool_use_id": "toolu_ota",
    });
    assert!(crate::safety_block::observe_claude_denial(
        &chat,
        None,
        &denial,
        Some(("Bash", &input))
    ));
    store.capture_native_decisions().unwrap();
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let decision = &snapshot.native_decisions[0];
    assert_eq!(decision.status, "pending");
    assert_eq!(decision.attempt_id, attempt.id);
    assert_eq!(decision.blocked_action.as_deref(), Some(line));
    assert!(
        decision.reason.contains("Production Deploy"),
        "{}",
        decision.reason
    );
    // Honest: the card cannot continue anything, and says what can.
    assert_eq!(decision.continuation, "unavailable");
    // A refusal no one can approve waits for no one, the card still up.
    assert_eq!(decision.awaits, Some(Awaits::Nobody));
    assert_eq!(serde_json::to_value(decision).unwrap()["awaits"], "nobody");
    assert!(
        decision.recovery.contains("cannot approve it"),
        "{}",
        decision.recovery
    );
    assert!(decision.recovery.contains("settle the attempt blocked"));
    // Nothing reached the worker telling it a rule is on its way.
    assert!(!snapshot
        .notifications
        .iter()
        .any(|n| n.target_chat_key == chat && n.kind == "native_decision"));
    // Nothing can allow it, so it holds nothing open: the worker can
    // settle blocked while the card is still up (a Codex card, whose
    // "allow" can continue the attempt, would refuse this).
    assert!(!crate::safety_block::awaits_decision(&chat));
    store
        .report_worker(
            &chat,
            WorkerReport {
                attempt_id: attempt.id,
                outcome: WorkerOutcome::Blocked,
                summary: "Auto mode refused `eas update`; the person must run it.".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    crate::safety_block::forget_chat(&chat);
}

/// A record from the build that offered "allow this exact command once"
/// — the decision it labelled allowed_exact and the notice it queued for
/// the worker — is history. The notice is never delivered, and the
/// decision authorizes nothing.
#[test]
fn a_stale_one_time_allowance_is_history_not_authority() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    store
        .mutate(|data| {
            data.native_decisions.insert(
                "old-card".into(),
                NativeDecision {
                    id: "old-card".into(),
                    run_id: run.id.clone(),
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.id.clone(),
                    chat_key: chat.clone(),
                    reason: "Claude's auto mode blocked an action: Production Deploy".into(),
                    blocked_action: Some("eas update --branch production".into()),
                    status: "allowed_exact".into(),
                    continuation: "new_turn_same_attempt".into(),
                    recovery: String::new(),
                    observed_at: 1,
                    kind: "safety".into(),
                    group_id: None,
                    awaits: None,
                },
            );
            inbox::enqueue(
                data,
                &run.id,
                "host",
                &chat,
                "exact-grant:old-card".into(),
                "native_decision",
                "Your next agent launch carries a permission rule for that exact line.".into(),
            );
            Ok(())
        })
        .unwrap();
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let decision = &snapshot.native_decisions[0];
    assert_eq!(decision.status, "allowed_exact", "kept as history");
    assert_eq!(decision.continuation, "unavailable");
    assert!(
        decision.recovery.starts_with("History only"),
        "{}",
        decision.recovery
    );
    assert!(decision.recovery.contains("authorizes nothing"));

    // Due, but never handed to the worker: claiming it cancels it.
    let due = store.due_notifications(i64::MAX).unwrap();
    let stale = due
        .iter()
        .find(|n| n.source == "exact-grant:old-card")
        .expect("queued");
    assert!(store
        .claim_notification(&stale.id, now_ms())
        .unwrap()
        .is_none());
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    assert!(snapshot
        .notifications
        .iter()
        .filter(|n| n.source.starts_with("exact-grant"))
        .all(|n| n.state == inbox::DeliveryState::Cancelled));

    // And a restart cancels one before anything tries to deliver it.
    store
        .mutate(|data| {
            inbox::enqueue(
                data,
                &run.id,
                "host",
                &chat,
                "exact-grant-note:old-card".into(),
                "native_decision",
                "OctiqFlow delivered it to the worker.".into(),
            );
            assert!(recover(data));
            assert!(data
                .notifications
                .values()
                .filter(|n| n.source.starts_with("exact-grant"))
                .all(|n| n.state == inbox::DeliveryState::Cancelled));
            Ok(())
        })
        .unwrap();
}

fn outage(id: &str) -> Value {
    json!({
        "type": "system", "subtype": "permission_denied",
        "decision_reason": "Classifier unavailable", "decision_reason_type": "classifier",
        "message": "The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. This is a transient failure of the check, not a judgment about the action.",
        "tool_name": "Bash", "tool_use_id": id,
    })
}

/// Refuse `line` for an outage at `at`, as the chat reader would: under
/// the attempt live in the chat.
fn refuse(store: &OrchestrationStore, chat: &str, id: &str, line: &str, at: i64) {
    assert!(crate::safety_block::observe_claude_refusal(
        chat,
        store.refusal_owner(chat).as_deref(),
        &outage(id),
        Some(("Bash", &json!({ "command": line }))),
        at
    ));
    store.capture_native_decisions().unwrap();
}

fn outage_notices(store: &OrchestrationStore, run: &Run) -> Vec<inbox::Notification> {
    let mut notices: Vec<_> = store
        .snapshot(Some(&run.id))
        .unwrap()
        .notifications
        .into_iter()
        .filter(|n| n.source.starts_with(OUTAGE_NOTICE))
        .collect();
    notices.sort_by_key(|n| n.next_attempt_at);
    notices
}

/// Feedback 664f03c0: nine refusals in one short outage were nine cards
/// and nine coordinator turns. They are one group, one notice, and every
/// refusal is still in the ledger.
#[test]
fn an_outage_is_one_group_one_notice_and_every_refusal_is_kept() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    let t = now_ms() - 60_000;
    refuse(&store, &chat, "toolu_o1", "git fetch", t);
    refuse(&store, &chat, "toolu_o2", "git fetch", t + 10_000);
    refuse(&store, &chat, "toolu_o3", "cat POLICY.md", t + 20_000);

    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let decisions: Vec<_> = snapshot
        .native_decisions
        .iter()
        .filter(|d| d.chat_key == chat)
        .collect();
    assert_eq!(decisions.len(), 3, "nothing is deleted");
    let group = decisions[0].group_id.clone().expect("grouped");
    for d in &decisions {
        assert_eq!(d.kind, "outage");
        assert_eq!(d.group_id.as_deref(), Some(group.as_str()));
        assert_eq!(d.attempt_id, attempt.id);
        assert_eq!(d.continuation, "unavailable");
        // The worker was told to carry on past it: nothing waits.
        assert_eq!(d.awaits, Some(Awaits::Nobody));
        // The same words as the card and the worker prompt.
        assert_eq!(d.recovery, crate::safety_block::outage_guidance());
        assert!(
            d.reason.contains("safety check was unavailable"),
            "{}",
            d.reason
        );
        assert!(!d.reason.contains("blocked an action"));
    }
    let mut actions: Vec<_> = decisions
        .iter()
        .filter_map(|d| d.blocked_action.as_deref())
        .collect();
    actions.sort();
    assert_eq!(actions, ["cat POLICY.md", "git fetch", "git fetch"]);
    assert!(snapshot
        .notifications
        .iter()
        .all(|n| !n.source.starts_with("native-decision:")));

    let notices = outage_notices(&store, &run);
    assert_eq!(notices.len(), 1, "one notice for the group");
    let notice = &notices[0];
    assert_eq!(notice.target_chat_key, run.coordinator_chat_key);
    assert_eq!(notice.source, format!("{OUTAGE_NOTICE}{group}"));
    assert!(notice.body.contains("3 refused call(s)"), "{}", notice.body);
    assert!(notice.body.contains("`git fetch` ×2"), "{}", notice.body);
    let due = crate::safety_block::outage_group_due(t, t + 20_000, 3);
    assert_eq!(notice.next_attempt_at, due);
    // Not before the group closes...
    assert!(store
        .claim_notification(&notice.id, due - 1)
        .unwrap()
        .is_none());
    // ...and then it goes: the worker has run nothing since.
    assert!(store.claim_notification(&notice.id, due).unwrap().is_some());
    crate::safety_block::forget_chat(&chat);
}

/// What the person chose on an outage card is what the ledger says:
/// "retried" or "allowed_*", each with recovery text that says OctiqFlow
/// ran nothing itself.
#[test]
fn an_outage_card_retried_or_allowed_is_recorded_as_such() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    let t = now_ms() - 60_000;
    refuse(&store, &chat, "toolu_ra", "git push", t);
    let group = store.snapshot(Some(&run.id)).unwrap().native_decisions[0]
        .group_id
        .clone()
        .unwrap();
    assert_eq!(crate::safety_block::retry_outage(&group), Ok(true));
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let d = snapshot
        .native_decisions
        .iter()
        .find(|d| d.chat_key == chat)
        .unwrap();
    assert_eq!(d.status, "retried");
    assert!(d.recovery.contains("retried once, as-is"), "{}", d.recovery);
    assert!(d.recovery.contains("OctiqFlow did not run it"));

    // An allow: the card's project is a temp folder.
    let project = crate::test_dir::TestDir::new("lifecycle-allow");
    crate::safety_block::remember_claude_launch(
        &chat,
        true,
        project.to_str().unwrap(),
        false,
        None,
    );
    refuse(&store, &chat, "toolu_rb", "git push origin main", t + 1_000);
    let group = store
        .snapshot(Some(&run.id))
        .unwrap()
        .native_decisions
        .iter()
        .find(|d| d.status == "pending")
        .and_then(|d| d.group_id.clone())
        .unwrap();
    crate::safety_block::allow_outage(&group, crate::claude_allow::Scope::Project).unwrap();
    // Decided only once the page says the retry turn is queued.
    assert_eq!(crate::safety_block::retry_outage(&group), Ok(true));
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let d = snapshot
        .native_decisions
        .iter()
        .find(|d| d.group_id.as_deref() == Some(group.as_str()))
        .unwrap();
    assert_eq!(d.status, "allowed_project");
    assert!(d.recovery.contains("allow rule"), "{}", d.recovery);
    std::fs::remove_dir_all(project).unwrap();
    crate::safety_block::forget_chat(&chat);
}

/// A judged refusal the person answered with "Always allow": the ledger
/// says the rule exists and the agent may retry itself, and still that
/// OctiqFlow ran nothing.
#[test]
fn a_judged_refusal_allowed_by_rule_is_recorded_as_such() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    let project = crate::test_dir::TestDir::new("lifecycle-judged");
    crate::safety_block::remember_claude_launch(
        &chat,
        true,
        project.to_str().unwrap(),
        false,
        None,
    );
    let denial = json!({
        "type": "system", "subtype": "permission_denied",
        "decision_reason": "[Irreversible Local Destruction]",
        "decision_reason_type": "classifier",
        "message": "denied", "tool_name": "Bash", "tool_use_id": "toolu_jl",
    });
    assert!(crate::safety_block::observe_claude_denial(
        &chat,
        None,
        &denial,
        Some((
            "Bash",
            &json!({ "command": "rm -f web/pnpm-workspace.yaml" })
        ))
    ));
    store.capture_native_decisions().unwrap();
    let d = store.snapshot(Some(&run.id)).unwrap().native_decisions[0].clone();
    assert_eq!(d.status, "pending");
    assert_eq!(d.recovery, CLAUDE_REFUSAL_RECOVERY, "pending: strict");
    crate::safety_block::allow_judged(&d.id, crate::claude_allow::Scope::Project).unwrap();
    crate::safety_block::person_turn(&chat, Some(&d.id), || Ok::<_, String>(())).unwrap();
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let d = snapshot
        .native_decisions
        .iter()
        .find(|x| x.id == d.id)
        .unwrap();
    assert_eq!(d.status, "allowed_project");
    assert_eq!(d.continuation, "unavailable");
    assert_eq!(d.recovery, CLAUDE_ALLOWED_RECOVERY);
    assert!(d.recovery.contains("OctiqFlow did not run it"));
    assert!(d.recovery.contains("from now on"));
    std::fs::remove_dir_all(project).unwrap();
    crate::safety_block::forget_chat(&chat);
}

/// A worker that moved on after the outage does not start a coordinator
/// turn for it. Its refused call's own result, and its status reports,
/// do not count as moving on.
#[test]
fn an_outage_the_worker_moved_past_is_recorded_but_not_delivered() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    let t = now_ms() - 5_000;
    let call = |id: &str, name: &str| {
        json!({"type":"assistant","message":{"content":[
                {"type":"tool_use","id":id,"name":name,"input":{}}]}})
    };
    let result = |id: &str| {
        json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":id,"content":"x","is_error":true}]}})
    };
    store
        .observe_worker_event(&chat, &call("toolu_r1", "Bash"))
        .unwrap();
    refuse(&store, &chat, "toolu_r1", "git fetch", t);
    // The refusal's own error result comes right after it.
    store
        .observe_worker_event(&chat, &result("toolu_r1"))
        .unwrap();
    // A status report alone is not moving on.
    store
        .observe_worker_event(&chat, &call("toolu_s1", "mcp__octiq__task_status"))
        .unwrap();
    store
        .observe_worker_event(&chat, &result("toolu_s1"))
        .unwrap();
    let notice = outage_notices(&store, &run).remove(0);
    let due = notice.next_attempt_at;
    store
        .mutate(|data| {
            assert!(
                outage_notice_valid(data, &notice),
                "nothing allowed ran yet"
            );
            Ok(())
        })
        .unwrap();

    // An allowed call that came back is.
    store
        .observe_worker_event(&chat, &call("toolu_ok", "Read"))
        .unwrap();
    store
        .observe_worker_event(&chat, &result("toolu_ok"))
        .unwrap();
    assert!(store.claim_notification(&notice.id, due).unwrap().is_none());
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let n = snapshot
        .notifications
        .iter()
        .find(|n| n.id == notice.id)
        .unwrap();
    assert_eq!(n.state, inbox::DeliveryState::Cancelled);
    // The group is still on the record.
    assert!(snapshot
        .native_decisions
        .iter()
        .any(|d| d.chat_key == chat && d.kind == "outage"));
    crate::safety_block::forget_chat(&chat);
}

fn tool_call(id: &str, name: &str) -> Value {
    json!({"type":"assistant","message":{"content":[
            {"type":"tool_use","id":id,"name":name,"input":{}}]}})
}

fn tool_result(id: &str) -> Value {
    json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":id,"content":"x"}]}})
}

fn notice_useful(store: &OrchestrationStore, notice: &inbox::Notification) -> bool {
    store
        .mutate(|data| Ok(outage_notice_valid(data, notice)))
        .unwrap()
}

/// Review of 2cbc3e9 (Tofu): Claude runs two calls at once, refuses one
/// for an outage, and the other, already running, comes back after the
/// refusal. That call started before the refusal, so it says nothing
/// about the worker having moved on, and the notice must still go.
#[test]
fn a_parallel_call_that_returns_after_the_refusal_does_not_cancel_the_notice() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    // Both calls in one assistant message, as Claude sends parallel ones.
    store
        .observe_worker_event(
            &chat,
            &json!({"type":"assistant","message":{"content":[
                    {"type":"tool_use","id":"toolu_pa","name":"Bash","input":{}},
                    {"type":"tool_use","id":"toolu_pb","name":"Read","input":{}}]}}),
        )
        .unwrap();
    refuse(&store, &chat, "toolu_pa", "git fetch", now_ms() + 1);
    store
        .observe_worker_event(&chat, &tool_result("toolu_pa"))
        .unwrap();
    // It comes back clearly after the refusal.
    std::thread::sleep(std::time::Duration::from_millis(10));
    store
        .observe_worker_event(&chat, &tool_result("toolu_pb"))
        .unwrap();
    let notice = outage_notices(&store, &run).remove(0);
    assert!(
        notice_useful(&store, &notice),
        "the parallel call started before the refusal"
    );
    assert!(store
        .claim_notification(&notice.id, notice.next_attempt_at)
        .unwrap()
        .is_some());
    crate::safety_block::forget_chat(&chat);
}

/// A long build started before the refusal and finishing after it is not
/// moving on either; a call started after the refusal is.
#[test]
fn a_long_call_started_before_the_refusal_does_not_cancel_the_notice() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    store
        .observe_worker_event(&chat, &tool_call("toolu_build", "Bash"))
        .unwrap();
    // A background agent's call is refused while the build runs.
    store
        .observe_worker_event(&chat, &tool_call("toolu_ref", "Bash"))
        .unwrap();
    let refused_at = now_ms() + 1;
    refuse(&store, &chat, "toolu_ref", "git fetch", refused_at);
    store
        .observe_worker_event(&chat, &tool_result("toolu_ref"))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    store
        .observe_worker_event(&chat, &tool_result("toolu_build"))
        .unwrap();
    let notice = outage_notices(&store, &run).remove(0);
    assert!(notice_useful(&store, &notice));
    let started = store
        .snapshot(Some(&run.id))
        .unwrap()
        .attempts
        .into_iter()
        .find(|a| a.id == attempt.id)
        .unwrap()
        .execution
        .last_allowed_tool_started_at
        .expect("the build ran");
    assert!(started < refused_at, "its START is what was recorded");

    // Control: a call started after the refusal does cancel it.
    store
        .observe_worker_event(&chat, &tool_call("toolu_after", "Read"))
        .unwrap();
    store
        .observe_worker_event(&chat, &tool_result("toolu_after"))
        .unwrap();
    assert!(!notice_useful(&store, &notice));
    crate::safety_block::forget_chat(&chat);
}

/// A result whose call was never seen starting (no name, no start) is not
/// proof that anything allowed ran.
#[test]
fn a_result_with_no_pending_call_does_not_count_as_allowed() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    refuse(&store, &chat, "toolu_u1", "git fetch", now_ms() - 5_000);
    store
        .observe_worker_event(&chat, &tool_result("toolu_never_started"))
        .unwrap();
    let notice = outage_notices(&store, &run).remove(0);
    assert!(notice_useful(&store, &notice));
    let execution = store
        .snapshot(Some(&run.id))
        .unwrap()
        .attempts
        .into_iter()
        .find(|a| a.id == attempt.id)
        .unwrap()
        .execution;
    assert!(execution.last_allowed_tool_started_at.is_none());
    assert!(execution.pending_tool_started_at.is_empty());
    crate::safety_block::forget_chat(&chat);
}

/// Review of 2cbc3e9: a retry that reuses the worker chat inside the
/// window used to join the settled attempt's group, and the notice could
/// then be judged by the settled attempt and cancelled.
#[test]
fn a_retry_in_the_same_chat_starts_its_own_outage_group() {
    let store = OrchestrationStore::default();
    let (run, first) = worker(&store);
    let chat = first.worker_chat_key.clone();
    let t = now_ms() - 30_000;
    refuse(&store, &chat, "toolu_first", "git fetch", t);
    store
        .report_worker(
            &chat,
            WorkerReport {
                attempt_id: first.id.clone(),
                outcome: WorkerOutcome::Blocked,
                summary: "`git fetch` was refused during the outage.".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    let (_, _, retry, _) = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                task_id: first.task_id.clone(),
                agent: ChatAgent::Codex,
                model: None,
                effort: None,
                access: Access::Auto,
                new_worktree: Some(false),
                base_branch: String::new(),
            },
        )
        .unwrap();
    let retry = store
        .activate_attempt(&retry.id, "/tmp".into(), "worker".into(), true)
        .unwrap();
    store
        .mutate(|data| {
            data.attempts.get_mut(&retry.id).unwrap().worker_chat_key = chat.clone();
            Ok(())
        })
        .unwrap();
    // Well inside the first group's window.
    refuse(&store, &chat, "toolu_retry", "git fetch", t + 10_000);

    let decisions: Vec<_> = store
        .snapshot(Some(&run.id))
        .unwrap()
        .native_decisions
        .into_iter()
        .filter(|d| d.chat_key == chat)
        .collect();
    assert_eq!(decisions.len(), 2);
    let first_decision = decisions.iter().find(|d| d.attempt_id == first.id).unwrap();
    let retry_decision = decisions.iter().find(|d| d.attempt_id == retry.id).unwrap();
    assert_ne!(
        first_decision.group_id, retry_decision.group_id,
        "a group belongs to one attempt"
    );
    let notices = outage_notices(&store, &run);
    assert_eq!(notices.len(), 2);
    let notice_for = |d: &NativeDecision| {
        let source = format!("{OUTAGE_NOTICE}{}", d.group_id.as_deref().unwrap());
        notices.iter().find(|n| n.source == source).unwrap().clone()
    };
    // The settled attempt's group is not delivered; the retry's is.
    assert!(!notice_useful(&store, &notice_for(first_decision)));
    let retry_notice = notice_for(retry_decision);
    assert!(notice_useful(&store, &retry_notice));
    assert!(retry_notice.body.contains(&retry.id));
    assert!(store
        .claim_notification(&retry_notice.id, retry_notice.next_attempt_at)
        .unwrap()
        .is_some());
    crate::safety_block::forget_chat(&chat);
}

/// The usefulness check reads the attempt of the group's latest refusal,
/// whatever order the records sit in.
#[test]
fn the_usefulness_check_judges_the_latest_refusals_attempt() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    let t = now_ms() - 30_000;
    refuse(&store, &chat, "toolu_l1", "git fetch", t);
    refuse(&store, &chat, "toolu_l2", "ls", t + 1_000);
    let notice = outage_notices(&store, &run).remove(0);
    let group = notice
        .source
        .strip_prefix(OUTAGE_NOTICE)
        .unwrap()
        .to_string();
    // An older record in the group that names a settled, unknown attempt
    // (as a mis-grouped one did) must not decide it, even if it sorts
    // first by id.
    store
        .mutate(|data| {
            let mut stale = data
                .native_decisions
                .values()
                .find(|d| d.group_id.as_deref() == Some(group.as_str()))
                .unwrap()
                .clone();
            stale.id = "0000-stale".into();
            stale.attempt_id = "attempt-gone".into();
            stale.observed_at = t - 1_000;
            data.native_decisions.insert(stale.id.clone(), stale);
            Ok(())
        })
        .unwrap();
    assert!(notice_useful(&store, &notice));
    crate::safety_block::forget_chat(&chat);
}

#[test]
fn an_outage_notice_for_a_settled_attempt_is_not_delivered() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    let t = now_ms();
    refuse(&store, &chat, "toolu_x1", "git fetch", t);
    store
        .report_worker(
            &chat,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome: WorkerOutcome::Completed,
                summary: "Done without `git fetch`, which the outage refused.".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    let notice = outage_notices(&store, &run).remove(0);
    assert!(store
        .claim_notification(&notice.id, notice.next_attempt_at)
        .unwrap()
        .is_none());
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let decision = snapshot
        .native_decisions
        .iter()
        .find(|d| d.chat_key == chat)
        .unwrap();
    assert!(
        decision.recovery.contains("settled"),
        "{}",
        decision.recovery
    );
    crate::safety_block::forget_chat(&chat);
}

/// Coordinator review (B): a worker refused every minute for ten minutes
/// never lets a sliding window close, but its coordinator still hears.
#[test]
fn a_worker_refused_every_minute_still_reaches_its_coordinator() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    let t = now_ms();
    for minute in 0..=10 {
        refuse(
            &store,
            &chat,
            &format!("toolu_m{minute}"),
            "git fetch",
            t + minute * 60_000,
        );
    }
    let notices = outage_notices(&store, &run);
    assert_eq!(notices.len(), 3, "{notices:#?}");
    assert_eq!(notices[0].next_attempt_at, t + 4 * 60_000, "five refusals");
    assert_eq!(notices[1].next_attempt_at, t + 9 * 60_000);
    assert_eq!(notices[2].next_attempt_at, t + 12 * 60_000);
    for notice in &notices {
        assert!(store
            .claim_notification(&notice.id, notice.next_attempt_at)
            .unwrap()
            .is_some());
    }
    let decisions = store.snapshot(Some(&run.id)).unwrap().native_decisions;
    assert_eq!(decisions.iter().filter(|d| d.chat_key == chat).count(), 11);
    crate::safety_block::forget_chat(&chat);
}

/// Real safety refusals keep one record each. A Claude one, which nobody
/// can approve, wakes no coordinator turn (feedback 76cde28e).
#[test]
fn a_claude_safety_refusal_is_recorded_once_each_and_wakes_nobody() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    let chat = attempt.worker_chat_key.clone();
    for id in ["toolu_p1", "toolu_p2"] {
        let denial = json!({
            "type": "system", "subtype": "permission_denied",
            "decision_reason": "[Production Deploy]", "decision_reason_type": "classifier",
            "message": "denied", "tool_name": "Bash", "tool_use_id": id,
        });
        assert!(crate::safety_block::observe_claude_denial(
            &chat,
            None,
            &denial,
            Some(("Bash", &json!({ "command": "eas update" })))
        ));
        store.capture_native_decisions().unwrap();
    }
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let decisions: Vec<_> = snapshot
        .native_decisions
        .iter()
        .filter(|d| d.chat_key == chat)
        .collect();
    assert_eq!(decisions.len(), 2);
    assert!(decisions
        .iter()
        .all(|d| d.kind == "safety" && d.group_id.is_none()));
    // Pinned, and strict: the outage retry never reaches a safety refusal.
    for d in &decisions {
        assert_eq!(d.recovery, CLAUDE_REFUSAL_RECOVERY);
        assert!(!d.recovery.contains(crate::safety_block::OUTAGE_RETRY));
        assert!(!d.recovery.contains("once more"));
    }
    assert_eq!(
            CLAUDE_REFUSAL_RECOVERY,
            "Claude's auto mode refused this call without asking anyone, and OctiqFlow cannot approve it: there is no supported way to allow one refused call before it runs. The card only records the refusal. Do not retry the call or reword it to get past the classifier. Continue another safe way, or settle the attempt blocked and name the refused command so the person can decide."
        );
    assert!(!snapshot
        .notifications
        .iter()
        .any(|n| n.kind == "native_decision"));
    crate::safety_block::forget_chat(&chat);
}

/// A decision stored before `kind` and `groupId` existed loads as a
/// safety refusal and renders as before.
#[test]
fn a_decision_stored_before_outage_kinds_still_loads() {
    let old: NativeDecision = serde_json::from_value(json!({
            "id": "old-1", "runId": "run", "taskId": "task", "attemptId": "attempt",
            "chatKey": "chat:old", "reason": "Claude's auto mode blocked an action: Classifier unavailable",
            "blockedAction": "git fetch", "status": "dismissed", "continuation": "unavailable",
            "recovery": "", "observedAt": 1,
        }))
        .unwrap();
    assert_eq!(old.kind, "safety");
    assert!(old.group_id.is_none());

    let root = crate::test_dir::TestDir::new("lifecycle-old");
    let path = root.join("state.json");
    let store = OrchestrationStore::load(path.clone());
    let (run, attempt) = worker(&store);
    store
        .mutate(|data| {
            let mut old = old.clone();
            old.run_id = run.id.clone();
            old.task_id = attempt.task_id.clone();
            old.attempt_id = attempt.id.clone();
            data.native_decisions.insert(old.id.clone(), old);
            Ok(())
        })
        .unwrap();
    drop(store);
    // Strip the new fields from disk, as an older build wrote it.
    let mut raw: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let stored = &mut raw["native_decisions"]["old-1"];
    assert!(stored.is_object(), "{raw}");
    stored.as_object_mut().unwrap().remove("kind");
    stored.as_object_mut().unwrap().remove("groupId");
    fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();

    let restored = OrchestrationStore::load(path);
    let snapshot = restored.snapshot(Some(&run.id)).unwrap();
    let decision = &snapshot.native_decisions[0];
    assert_eq!(decision.id, "old-1");
    assert_eq!(decision.kind, "safety");
    assert_eq!(decision.status, "dismissed");
    assert_eq!(decision.continuation, "unavailable");
    // A reload settles the attempt it belonged to; the old record gets
    // the ordinary safety wording for that, not the outage guidance.
    assert!(
        decision.recovery.contains("settled"),
        "{}",
        decision.recovery
    );
    assert_ne!(decision.recovery, crate::safety_block::outage_guidance());
}

#[test]
fn registered_service_lifetime_is_independent_of_completed_task() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    // Work still waiting keeps the run active once this task completes;
    // a settled run is never woken (see the settled-run test below).
    super::super::tests::task(&store, &run, vec![attempt.task_id.clone()]);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    store
        .register_service(&attempt.worker_chat_key, register(&attempt, port))
        .unwrap();
    store.check_services(100_000).unwrap();
    assert_eq!(
        store.snapshot(Some(&run.id)).unwrap().services[0].state,
        "listening"
    );
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome: WorkerOutcome::Completed,
                summary: "Frontend started".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    // The frontend goes away. Probed as gone rather than by dropping the
    // listener: a released ephemeral port is bound again by a parallel
    // test often enough to make the real probe flaky here.
    drop(listener);
    store.check_services_with(110_001, |_| false).unwrap();
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let task = snapshot.tasks.iter().find(|t| t.id == attempt.task_id);
    assert_eq!(task.unwrap().status, TaskStatus::Completed);
    assert_eq!(snapshot.runs[0].status, RunStatus::Running);
    assert_eq!(snapshot.services[0].state, "stopped");
    assert_eq!(snapshot.services[0].checked_at, Some(110_001));
    assert!(snapshot
        .notifications
        .iter()
        .any(|n| n.kind == "service" && n.body.contains("not reachable")));
    assert!(store
        .register_service(&attempt.worker_chat_key, register(&attempt, port))
        .is_err());
    store
        .register_service("chat:master", register(&attempt, port))
        .unwrap();
    assert_eq!(store.snapshot(Some(&run.id)).unwrap().services.len(), 1);
}

#[test]
fn service_registration_checks_owner_staleness_and_loopback() {
    let store = OrchestrationStore::default();
    let (_, attempt) = worker(&store);
    assert!(store
        .register_service("chat:stranger", register(&attempt, 3001))
        .is_err());
    let mut external = register(&attempt, 3001);
    external.host = "192.0.2.1".parse().unwrap();
    assert!(store.register_service("chat:master", external).is_err());
    store
        .mutate(|data| {
            data.tasks
                .get_mut(&attempt.task_id)
                .unwrap()
                .active_attempt_id = Some("newer".into());
            Ok(())
        })
        .unwrap();
    assert!(store
        .register_service("chat:master", register(&attempt, 3001))
        .is_err());
}

#[test]
fn restart_invalidates_services_and_native_cards_without_reopening_finished_tasks() {
    let root = crate::test_dir::TestDir::new("lifecycle");
    let path = root.join("state.json");
    let store = OrchestrationStore::load(path.clone());
    let (run, attempt) = worker(&store);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    store
        .register_service(
            "chat:master",
            register(&attempt, listener.local_addr().unwrap().port()),
        )
        .unwrap();
    store.check_services(now_ms()).unwrap();
    crate::safety_block::observe(ChatAgent::Codex, &attempt.worker_chat_key,
            "codex_core::tools::router: error=This action was rejected due to unacceptable risk.\\nReason: Upload requires a decision.");
    store.capture_native_decisions().unwrap();
    crate::safety_block::forget_chat(&attempt.worker_chat_key);
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id,
                outcome: WorkerOutcome::Completed,
                summary: "Unaffected work completed".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
    drop(store);
    let restored = OrchestrationStore::load(path);
    let snapshot = restored.snapshot(Some(&run.id)).unwrap();
    assert_eq!(snapshot.tasks[0].status, TaskStatus::Completed);
    assert_eq!(snapshot.services[0].state, "unverified");
    assert_eq!(snapshot.services[0].checked_at, None);
    assert_eq!(snapshot.native_decisions[0].status, "expired");
    assert_eq!(snapshot.native_decisions[0].continuation, "unavailable");
}

fn service_notices(store: &OrchestrationStore, run: &Run) -> Vec<inbox::Notification> {
    store
        .snapshot(Some(&run.id))
        .unwrap()
        .notifications
        .into_iter()
        .filter(|n| n.kind == "service")
        .collect()
}

fn settle(store: &OrchestrationStore, attempt: &Attempt, outcome: WorkerOutcome) {
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome,
                summary: "Settled".into(),
                files_modified: vec![],
                verdict: None,
            },
        )
        .unwrap();
}

#[test]
fn a_settled_run_keeps_truthful_services_but_is_never_woken_by_them() {
    for (outcome, status) in [
        (WorkerOutcome::Completed, RunStatus::Completed),
        (WorkerOutcome::Failed, RunStatus::Failed),
    ] {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        store
            .register_service("chat:master", register(&attempt, 3001))
            .unwrap();
        // Control: while the run is active, the first state is news.
        store.check_services_with(100_000, |_| true).unwrap();
        assert_eq!(service_notices(&store, &run).len(), 1);

        settle(&store, &attempt, outcome);
        assert_eq!(
            store.snapshot(Some(&run.id)).unwrap().runs[0].status,
            status
        );

        store.check_services_with(110_001, |_| false).unwrap();
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert_eq!(snapshot.services[0].state, "stopped");
        assert_eq!(snapshot.services[0].checked_at, Some(110_001));

        store.mutate(|data| Ok(recover(data))).unwrap();
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert_eq!(snapshot.services[0].state, "unverified");
        assert_eq!(snapshot.services[0].checked_at, None);

        store.check_services_with(120_002, |_| true).unwrap();
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert_eq!(snapshot.services[0].state, "listening");
        assert_eq!(snapshot.services[0].checked_at, Some(120_002));
        assert_eq!(service_notices(&store, &run).len(), 1, "{status:?}");
    }
}

#[test]
fn a_service_notice_queued_before_its_run_settled_is_not_delivered() {
    let store = OrchestrationStore::default();
    let (run, attempt) = worker(&store);
    store
        .register_service("chat:master", register(&attempt, 3001))
        .unwrap();
    // Control: on an active run the notice is handed over.
    store.check_services_with(100_000, |_| false).unwrap();
    let first = service_notices(&store, &run).remove(0);
    assert!(store
        .claim_notification(&first.id, now_ms())
        .unwrap()
        .is_some());

    store.check_services_with(110_001, |_| true).unwrap();
    let queued = service_notices(&store, &run)
        .into_iter()
        .find(|n| n.id != first.id)
        .unwrap();
    assert_eq!(queued.state, inbox::DeliveryState::Pending);
    settle(&store, &attempt, WorkerOutcome::Completed);
    assert!(store
        .claim_notification(&queued.id, now_ms())
        .unwrap()
        .is_none());
    let after = service_notices(&store, &run)
        .into_iter()
        .find(|n| n.id == queued.id)
        .unwrap();
    assert_eq!(after.state, inbox::DeliveryState::Cancelled);
}

#[test]
fn a_restart_tells_an_active_run_only_what_changed_about_its_service() {
    let root = crate::test_dir::TestDir::new("lifecycle");
    let path = root.join("state.json");
    let store = OrchestrationStore::load(path.clone());
    let (run, attempt) = worker(&store);
    // A restart fails the interrupted worker; the waiting task keeps the
    // run active.
    super::super::tests::task(&store, &run, vec![attempt.task_id.clone()]);
    store
        .register_service("chat:master", register(&attempt, 3001))
        .unwrap();
    store.check_services_with(100_000, |_| true).unwrap();
    assert_eq!(service_notices(&store, &run).len(), 1);

    // Listening before the restart and after it: nothing to act on.
    drop(store);
    let store = OrchestrationStore::load(path.clone());
    assert_eq!(
        store.snapshot(Some(&run.id)).unwrap().runs[0].status,
        RunStatus::Running
    );
    assert_eq!(service_notices(&store, &run).len(), 1);
    store.check_services_with(200_000, |_| true).unwrap();
    assert_eq!(
        store.snapshot(Some(&run.id)).unwrap().services[0].state,
        "listening"
    );
    assert_eq!(service_notices(&store, &run).len(), 1);

    // Gone after a restart: exactly one notice says so.
    drop(store);
    let store = OrchestrationStore::load(path.clone());
    store.check_services_with(300_000, |_| false).unwrap();
    let notices = service_notices(&store, &run);
    assert_eq!(notices.len(), 2);
    assert!(notices
        .iter()
        .any(|n| n.body.contains("is stopped") && n.body.contains("not reachable")));

    // Still gone after another restart: the coordinator already knows.
    drop(store);
    let store = OrchestrationStore::load(path.clone());
    store.check_services_with(400_000, |_| false).unwrap();
    assert_eq!(service_notices(&store, &run).len(), 2);
    // Back again: one notice.
    store.check_services_with(410_001, |_| true).unwrap();
    assert_eq!(service_notices(&store, &run).len(), 3);
    drop(store);
}

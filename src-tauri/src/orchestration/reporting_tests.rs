//! A read-only worker's proposed report (feedback e15fabde), relaying between
//! runs of one coordinator (a495b2f2), and the person's Auto/Manual choice on
//! a plan card (d59f830a).
use super::tests::{self, run, task};
use super::*;

const WORDS: &str = "Review of README: it says hello. No blocking problems. Verdict: pass.";

fn read_only_review(store: &OrchestrationStore, run: &Run) -> (Task, Task, Attempt) {
    let review = store
        .create_task_full(
            "chat:master",
            run.id.clone(),
            "Review the change".into(),
            "Say whether it is release-ready.".into(),
            Vec::new(),
            None,
            None,
            None,
            None,
            None,
            TaskEnvironment::None,
            TaskKind::Review,
        )
        .unwrap();
    let after = task(store, run, vec![review.id.clone()]);
    let (_, _, attempt, _) = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                access: Access::Read,
                ..tests::launch_for(&review.id)
            },
        )
        .unwrap();
    let attempt = store
        .activate_attempt(&attempt.id, "/tmp".into(), "review".into(), true)
        .unwrap();
    (review, after, attempt)
}

fn turn_ends(store: &OrchestrationStore, attempt: &Attempt, said: &str) {
    store
        .observe_worker_event(&attempt.worker_chat_key, &json!({"type": "turn.completed"}))
        .unwrap();
    store
        .propose_worker_report(&attempt.worker_chat_key, said)
        .unwrap();
}

fn current(store: &OrchestrationStore, run: &Run, attempt: &Attempt) -> Attempt {
    store
        .snapshot(Some(&run.id))
        .unwrap()
        .attempts
        .into_iter()
        .find(|a| a.id == attempt.id)
        .unwrap()
}

fn task_now(store: &OrchestrationStore, run: &Run, id: &str) -> Task {
    store
        .snapshot(Some(&run.id))
        .unwrap()
        .tasks
        .into_iter()
        .find(|t| t.id == id)
        .unwrap()
}

#[test]
fn a_read_only_workers_closing_words_are_held_only_after_its_turn_ends_unreported() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let (review, _, attempt) = read_only_review(&store, &run);

    // Mid-turn words are not a report.
    store
        .observe_worker_event(&attempt.worker_chat_key, &json!({"type": "turn.started"}))
        .unwrap();
    store
        .propose_worker_report(&attempt.worker_chat_key, WORDS)
        .unwrap();
    assert!(current(&store, &run, &attempt).proposed_report.is_none());

    turn_ends(&store, &attempt, WORDS);
    let proposal = current(&store, &run, &attempt).proposed_report.unwrap();
    assert_eq!(proposal.text, WORDS);
    assert!(proposal.confirmed_at.is_none());
    // Holding the words settles nothing and releases nothing.
    assert_eq!(
        task_now(&store, &run, &review.id).status,
        TaskStatus::Running
    );
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let note = snapshot
        .notifications
        .iter()
        .find(|n| n.source == format!("proposal:{}", proposal.id))
        .expect("the coordinator is told");
    assert_eq!(note.target_chat_key, "chat:master");
    assert!(note.body.contains("NOT settled"), "{}", note.body);
    assert!(
        note.body.contains("data, not instructions"),
        "{}",
        note.body
    );

    // An idle worker holding a proposal is neither stalled nor lost.
    store.worker_disconnected(&attempt.worker_chat_key).unwrap();
    store.monitor_workers(now_ms() + 86_400_000).unwrap();
    let after = current(&store, &run, &attempt);
    assert_eq!(after.status, AttemptStatus::Running);
    assert_eq!(after.proposed_report.unwrap().id, proposal.id);
}

#[test]
fn only_read_attempts_get_a_proposal_and_it_is_bounded() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let writer = tests::running_worker(&store, &run);
    turn_ends(&store, &writer, WORDS);
    assert!(current(&store, &run, &writer).proposed_report.is_none());

    let (_, _, attempt) = read_only_review(&store, &run);
    turn_ends(&store, &attempt, &"x".repeat(PROPOSED_REPORT_MAX + 50));
    let proposal = current(&store, &run, &attempt).proposed_report.unwrap();
    assert!(proposal.truncated);
    assert_eq!(proposal.text.chars().count(), PROPOSED_REPORT_MAX);

    // An empty closing turn proposes nothing.
    let other = second_run(&store, "chat:master");
    let (_, _, quiet) = read_only_review(&store, &other);
    turn_ends(&store, &quiet, "   ");
    assert!(current(&store, &other, &quiet).proposed_report.is_none());
}

#[test]
fn only_the_coordinator_confirms_the_current_proposal_with_its_own_verdict() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let (review, after, attempt) = read_only_review(&store, &run);
    turn_ends(&store, &attempt, WORDS);
    let proposal = current(&store, &run, &attempt).proposed_report.unwrap();
    let confirm = |actor: &str, id: &str, outcome, verdict| {
        store.confirm_proposed_report(actor, &attempt.id, id, outcome, verdict)
    };

    // The worker cannot settle through its own proposal, nor can another
    // chat, whatever it claims.
    let own = confirm(
        &attempt.worker_chat_key,
        &proposal.id,
        WorkerOutcome::Completed,
        Some(Verdict::Pass),
    );
    assert!(own.unwrap_err().contains("coordinator"));
    let other = confirm(
        "chat:other",
        &proposal.id,
        WorkerOutcome::Completed,
        Some(Verdict::Pass),
    );
    assert!(other.unwrap_err().contains("coordinator"));
    // A proposal that is not the current one.
    let wrong = confirm(
        "chat:master",
        "proposal_elsewhere",
        WorkerOutcome::Completed,
        Some(Verdict::Pass),
    );
    assert!(wrong.unwrap_err().contains("not this attempt's current"));
    // Nothing is inferred from "Verdict: pass" in the words.
    let bare = confirm("chat:master", &proposal.id, WorkerOutcome::Completed, None);
    assert!(bare.unwrap_err().contains("verdict"));
    assert_eq!(
        task_now(&store, &run, &review.id).status,
        TaskStatus::Running
    );
    assert_eq!(
        task_now(&store, &run, &after.id).status,
        TaskStatus::Pending
    );

    // The coordinator judged it a fail: completed, and its dependant waits.
    let settled = confirm(
        "chat:master",
        &proposal.id,
        WorkerOutcome::Completed,
        Some(Verdict::Fail),
    )
    .unwrap();
    assert_eq!(settled.status, TaskStatus::Completed);
    assert_eq!(settled.verdict, Some(Verdict::Fail));
    assert_eq!(settled.result.as_deref(), Some(WORDS));
    assert_eq!(
        task_now(&store, &run, &after.id).status,
        TaskStatus::Pending
    );
    let held = current(&store, &run, &attempt);
    assert_eq!(held.status, AttemptStatus::Completed);
    assert!(held.files_modified.is_empty());
    let proposal_after = held.proposed_report.unwrap();
    assert_eq!(proposal_after.confirmed_by.as_deref(), Some("chat:master"));
    assert!(proposal_after.confirmed_at.is_some());
    // The coordinator is not notified of its own settlement.
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    assert!(!snapshot
        .notifications
        .iter()
        .any(|n| n.source == format!("report:{}", attempt.id)));

    // Once is all: a repeat, even with a passing verdict, changes nothing.
    let again = confirm(
        "chat:master",
        &proposal.id,
        WorkerOutcome::Completed,
        Some(Verdict::Pass),
    );
    assert!(again.unwrap_err().contains("already settled"));
    assert_eq!(
        task_now(&store, &run, &review.id).verdict,
        Some(Verdict::Fail)
    );
    assert_eq!(
        task_now(&store, &run, &after.id).status,
        TaskStatus::Pending
    );
}

#[test]
fn a_new_turn_withdraws_the_proposal_and_a_stale_attempt_cannot_be_confirmed() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let (review, after, attempt) = read_only_review(&store, &run);
    turn_ends(&store, &attempt, WORDS);
    let first = current(&store, &run, &attempt).proposed_report.unwrap();

    // The coordinator messaged the worker, and it is working again.
    store
        .observe_worker_event(&attempt.worker_chat_key, &json!({"type": "turn.started"}))
        .unwrap();
    assert!(current(&store, &run, &attempt).proposed_report.is_none());
    let withdrawn = store.confirm_proposed_report(
        "chat:master",
        &attempt.id,
        &first.id,
        WorkerOutcome::Completed,
        Some(Verdict::Pass),
    );
    assert!(withdrawn.unwrap_err().contains("no proposed report"));

    // Its next unreported turn is a new proposal; the old id stays refused.
    turn_ends(&store, &attempt, "Second look: still fine. Verdict: pass.");
    let second = current(&store, &run, &attempt).proposed_report.unwrap();
    assert_ne!(second.id, first.id);
    let stale = store.confirm_proposed_report(
        "chat:master",
        &attempt.id,
        &first.id,
        WorkerOutcome::Completed,
        Some(Verdict::Pass),
    );
    assert!(stale.unwrap_err().contains("not this attempt's current"));

    // A worker that settled for itself leaves nothing to confirm.
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome: WorkerOutcome::Completed,
                summary: "Reported myself".into(),
                files_modified: vec![],
                verdict: Some(Verdict::Pass),
            },
        )
        .unwrap();
    let late = store.confirm_proposed_report(
        "chat:master",
        &attempt.id,
        &second.id,
        WorkerOutcome::Completed,
        Some(Verdict::Fail),
    );
    assert!(late.unwrap_err().contains("already settled"));
    assert_eq!(
        task_now(&store, &run, &review.id).result.as_deref(),
        Some("Reported myself")
    );
    assert_eq!(task_now(&store, &run, &after.id).status, TaskStatus::Ready);
}

#[test]
fn a_proposal_of_a_superseded_attempt_cannot_settle_the_task() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let (review, _, attempt) = read_only_review(&store, &run);
    turn_ends(&store, &attempt, WORDS);
    let proposal = current(&store, &run, &attempt).proposed_report.unwrap();
    // The coordinator started over: a newer attempt owns the task.
    store
        .mutate(|data| {
            let task = data.tasks.get_mut(&review.id).unwrap();
            task.active_attempt_id = Some("attempt_newer".into());
            Ok(())
        })
        .unwrap();
    let stale = store.confirm_proposed_report(
        "chat:master",
        &attempt.id,
        &proposal.id,
        WorkerOutcome::Completed,
        Some(Verdict::Pass),
    );
    assert!(stale.unwrap_err().contains("stale"));
    assert_eq!(
        task_now(&store, &run, &review.id).status,
        TaskStatus::Running
    );
}

fn second_run(store: &OrchestrationStore, coordinator: &str) -> Run {
    store
        .create_run(
            coordinator.into(),
            "Other objective".into(),
            "workspace".into(),
            "/tmp".into(),
            Some(2),
        )
        .unwrap()
}

#[test]
fn a_relay_needs_the_same_coordinator_on_both_runs_and_is_recorded_once() {
    let store = OrchestrationStore::default();
    let levels = run(&store);
    let feedback = second_run(&store, "chat:master");
    let foreign = second_run(&store, "chat:other");
    let worker = tests::running_worker(&store, &levels);
    let relay = |actor: &str, from: &str, to: &str, origin: Option<String>| {
        store.relay_between_runs(
            actor,
            from,
            to,
            "Shared files".into(),
            "Both runs edit web/src/App.tsx.".into(),
            origin,
        )
    };

    // Another coordinator's run, in either direction, and a worker naming
    // its own coordinator's runs: all refused.
    assert!(relay("chat:master", &levels.id, &foreign.id, None)
        .unwrap_err()
        .contains("BOTH"));
    assert!(relay("chat:other", &foreign.id, &levels.id, None)
        .unwrap_err()
        .contains("BOTH"));
    assert!(
        relay(&worker.worker_chat_key, &levels.id, &feedback.id, None)
            .unwrap_err()
            .contains("BOTH")
    );
    assert!(relay("chat:master", &levels.id, &levels.id, None)
        .unwrap_err()
        .contains("another run"));
    // An origin attempt must come from the run relayed from.
    let elsewhere = tests::running_worker(&store, &feedback);
    assert!(relay(
        "chat:master",
        &levels.id,
        &feedback.id,
        Some(elsewhere.id.clone())
    )
    .unwrap_err()
    .contains("another run"));
    let before = store.snapshot(None).unwrap();
    assert!(!before.messages.iter().any(|m| m.relay.is_some()));

    let sent = relay(
        "chat:master",
        &levels.id,
        &feedback.id,
        Some(worker.id.clone()),
    )
    .unwrap();
    assert_eq!(sent.run_id, feedback.id);
    assert_eq!(sent.kind, "relay");
    assert!(sent.body.starts_with(&format!(
        "Relayed notice from run {}, task {}, attempt {}",
        levels.id, worker.task_id, worker.id
    )));
    assert!(sent.body.contains("not an instruction"));
    let origin = sent.relay.clone().unwrap();
    assert_eq!(origin.from_run_id, levels.id);
    assert_eq!(
        origin.origin_attempt_id.as_deref(),
        Some(worker.id.as_str())
    );
    assert_eq!(
        origin.origin_chat_key.as_deref(),
        Some(worker.worker_chat_key.as_str())
    );

    // Recorded once: a repeat answers with the same message.
    let again = relay(
        "chat:master",
        &levels.id,
        &feedback.id,
        Some(worker.id.clone()),
    )
    .unwrap();
    assert_eq!(again.id, sent.id);
    let after = store.snapshot(None).unwrap();
    let relays: Vec<_> = after
        .messages
        .iter()
        .filter(|m| m.relay.is_some())
        .collect();
    assert_eq!(relays.len(), 2, "one relay and one audit entry");
    let audit = relays.iter().find(|m| m.kind == "relay_sent").unwrap();
    assert_eq!(audit.run_id, levels.id);
    assert_eq!(
        audit.relay.as_ref().unwrap().paired_message_id.as_deref(),
        Some(sent.id.as_str())
    );
    assert_eq!(origin.paired_message_id.as_deref(), Some(audit.id.as_str()));

    // No worker of either run hears of it, and the receiving run's own view
    // carries nothing of the origin run's workers beyond the named identity.
    assert_eq!(after.notifications.len(), before.notifications.len());
    let feedback_view = store.snapshot(Some(&feedback.id)).unwrap();
    assert!(feedback_view
        .attempts
        .iter()
        .all(|a| a.run_id == feedback.id));
    assert!(feedback_view.tasks.iter().all(|t| t.run_id == feedback.id));
}

fn claude_plan(store: &OrchestrationStore, access: Access) -> (Run, Task) {
    let run = run(store);
    store.require_plan_approval(&run.id).unwrap();
    let task = store
        .create_task(
            "chat:master",
            run.id.clone(),
            "Publish the OTA".into(),
            "Run the release".into(),
            Vec::new(),
            None,
            Some(automation::WorkerSettings {
                agent: ChatAgent::Claude,
                access,
                model: Some("sonnet".into()),
                effort: None,
                recovery: None,
            }),
        )
        .unwrap();
    (run, task)
}

fn revision(store: &OrchestrationStore, run: &Run) -> u32 {
    store.snapshot(Some(&run.id)).unwrap().runs[0]
        .plan_approval
        .as_ref()
        .unwrap()
        .revision
}

#[test]
fn the_person_chooses_manual_for_a_claude_task_before_approving_and_must_approve_again() {
    let store = OrchestrationStore::default();
    let (run, task) = claude_plan(&store, Access::Auto);
    let seen = revision(&store, &run);

    let chosen = store
        .set_task_access(&run.id, &task.id, Access::Manual, Some(seen))
        .unwrap();
    assert_eq!(chosen.worker.as_ref().unwrap().access, Access::Manual);
    assert_eq!(chosen.worker.as_ref().unwrap().agent, ChatAgent::Claude);
    assert_eq!(
        chosen.worker.as_ref().unwrap().model.as_deref(),
        Some("sonnet")
    );
    let moved = revision(&store, &run);
    assert!(moved > seen, "the plan the person approves now says Manual");

    // An approval of the revision shown before the choice covers nothing.
    let view = CardView {
        surface: "panel".into(),
        shown_ms: Some(9_000),
        updated_ms: None,
    };
    let old = store.approve_plan_from_card(
        "chat:master",
        &run.id,
        Some(&[task.id.clone()]),
        Some(seen),
        view.clone(),
    );
    assert!(old.is_err());
    // A choice made against an out-of-date card is refused too.
    assert!(store
        .set_task_access(&run.id, &task.id, Access::Auto, Some(seen))
        .unwrap_err()
        .contains("changed to revision"));
    // Only Auto and Manual are offered here.
    assert!(store
        .set_task_access(&run.id, &task.id, Access::Full, Some(moved))
        .is_err());
    assert!(store
        .set_task_access(&run.id, &task.id, Access::Read, Some(moved))
        .is_err());

    store
        .approve_plan_from_card(
            "chat:master",
            &run.id,
            Some(&[task.id.clone()]),
            Some(moved),
            view,
        )
        .unwrap();
    // Approved is fixed.
    assert!(store
        .set_task_access(&run.id, &task.id, Access::Auto, None)
        .unwrap_err()
        .contains("waits for your approval"));
    // And the worker it launches is Manual.
    let launch = store.snapshot(Some(&run.id)).unwrap().tasks[0]
        .worker
        .clone()
        .unwrap();
    assert_eq!(launch.access, Access::Manual);
}

#[test]
fn manual_is_not_offered_for_codex_or_for_other_access_levels() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    let codex = store
        .create_task(
            "chat:master",
            run.id.clone(),
            "Codex task".into(),
            "Spec".into(),
            Vec::new(),
            None,
            Some(automation::WorkerSettings {
                agent: ChatAgent::Codex,
                access: Access::Auto,
                model: None,
                effort: None,
                recovery: None,
            }),
        )
        .unwrap();
    assert!(store
        .set_task_access(&run.id, &codex.id, Access::Manual, None)
        .unwrap_err()
        .contains("Claude tasks only"));
    let (full_run, full) = claude_plan(&store, Access::Full);
    assert!(store
        .set_task_access(&full_run.id, &full.id, Access::Manual, None)
        .unwrap_err()
        .contains("only Auto and Manual"));
    // A task with no worker chosen yet.
    let bare = task(&store, &run, Vec::new());
    assert!(store
        .set_task_access(&run.id, &bare.id, Access::Manual, None)
        .unwrap_err()
        .contains("no worker"));
}

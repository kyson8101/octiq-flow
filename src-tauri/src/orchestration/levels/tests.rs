use super::*;
use crate::orchestration::tests::run;

pub(crate) fn ada() -> TaskAssignee {
    TaskAssignee {
        id: "agent_ada".into(),
        name: "Ada".into(),
    }
}

pub(crate) fn assigned(
    store: &OrchestrationStore,
    run: &Run,
    actor: &str,
    who: TaskAssignee,
    parent: Option<String>,
) -> Task {
    store
        .create_task_for(
            actor,
            run.id.clone(),
            "Part".into(),
            "Do the part".into(),
            Vec::new(),
            parent,
            None,
            Some(who),
            None,
        )
        .unwrap()
}

fn launch(task: &Task) -> WorkerLaunch {
    WorkerLaunch {
        task_id: task.id.clone(),
        agent: ChatAgent::Codex,
        model: None,
        effort: None,
        access: Access::Auto,
        new_worktree: Some(true),
        base_branch: String::new(),
    }
}

pub(crate) fn start(store: &OrchestrationStore, actor: &str, task: &Task) -> Attempt {
    let (_, _, attempt, _) = store.reserve_attempt(actor, &launch(task)).unwrap();
    store
        .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
        .unwrap()
}

pub(crate) fn settle(store: &OrchestrationStore, attempt: &Attempt, outcome: WorkerOutcome) {
    store
        .report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome,
                summary: "done".into(),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap();
}

/// A task of Ada's, run once and completed.
fn finished(store: &OrchestrationStore, run: &Run) -> (Task, Attempt) {
    let task = assigned(store, run, "chat:master", ada(), None);
    let attempt = start(store, "chat:master", &task);
    settle(store, &attempt, WorkerOutcome::Completed);
    (task, attempt)
}

fn lead(id: &str) -> Option<(String, String)> {
    Some((id.into(), id.to_uppercase()))
}

#[test]
fn the_curve_starts_at_level_one_and_each_level_costs_a_hundred_more() {
    assert_eq!(level_threshold(1), 0);
    assert_eq!(level_threshold(2), 100);
    assert_eq!(level_threshold(3), 300);
    assert_eq!(level_threshold(4), 600);
    assert_eq!(level_threshold(10), 4500);
    for (xp, level) in [
        (0, 1),
        (99, 1),
        (100, 2),
        (299, 2),
        (300, 3),
        (599, 3),
        (600, 4),
    ] {
        assert_eq!(level_for(xp).level, level, "{xp} XP");
    }
    let progress = level_for(175);
    assert_eq!(
        (progress.level, progress.level_xp, progress.next_level_xp),
        (2, 100, 300)
    );
    // Every step up costs exactly 100 × the level being left.
    for level in 1..50 {
        assert_eq!(
            level_threshold(level + 1) - level_threshold(level),
            LEVEL_STEP * level as u64
        );
    }
    assert_eq!(TaskSize::ALL.map(TaskSize::xp), [25, 75, 150]);
}

#[test]
fn accepting_pays_once_however_often_it_is_accepted() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let (task, attempt) = finished(&store, &run);
    assert_eq!(task.size, Some(TaskSize::Medium), "medium by default");
    let first = store
        .accept_task(AcceptActor::Person, &task.id, &attempt.id)
        .unwrap();
    assert!(first.awarded);
    let award = first.award.clone().unwrap();
    assert_eq!((award.agent_id.as_str(), award.xp), ("agent_ada", 75));
    assert_eq!(award.accepted_by.kind, AcceptorKind::Person);
    assert_eq!(
        first.task.acceptance.as_ref().unwrap().attempt_id,
        attempt.id
    );
    // Again, from the person or the lead: the same award, nothing new.
    let again = store
        .accept_task(AcceptActor::Person, &task.id, &attempt.id)
        .unwrap();
    assert!(!again.awarded);
    assert_eq!(again.award, Some(award));
    let by_lead = store
        .accept_task(
            AcceptActor::Chat {
                chat_key: "chat:master",
                lead: lead("agent_lead"),
            },
            &task.id,
            &attempt.id,
        )
        .unwrap();
    assert!(!by_lead.awarded);
    let summary = store.level_summaries().unwrap();
    assert_eq!(summary.len(), 1);
    assert_eq!((summary[0].progress.xp, summary[0].accepted_tasks), (75, 1));
}

#[test]
fn racing_accepts_pay_exactly_once() {
    for _ in 0..10 {
        let store = Arc::new(OrchestrationStore::default());
        let run = run(&store);
        let (task, attempt) = finished(&store, &run);
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let store = store.clone();
                let (task_id, attempt_id) = (task.id.clone(), attempt.id.clone());
                std::thread::spawn(move || {
                    let actor = if i % 2 == 0 {
                        AcceptActor::Chat {
                            chat_key: "chat:master",
                            lead: lead("agent_lead"),
                        }
                    } else {
                        AcceptActor::Person
                    };
                    store
                        .accept_task(actor, &task_id, &attempt_id)
                        .unwrap()
                        .awarded
                })
            })
            .collect();
        let paid = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|awarded| *awarded)
            .count();
        assert_eq!(paid, 1);
        assert_eq!(store.level_profile("agent_ada", 0).unwrap().progress.xp, 75);
    }
}

#[test]
fn only_the_person_or_the_responsible_lead_may_accept() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let (task, attempt) = finished(&store, &run);
    let refuse =
        |actor: AcceptActor<'_>| store.accept_task(actor, &task.id, &attempt.id).unwrap_err();
    // The worker, from its own chat, even claiming to be a lead.
    assert!(refuse(AcceptActor::Chat {
        chat_key: &attempt.worker_chat_key,
        lead: lead("agent_boss"),
    })
    .contains("Only the person"));
    // Some other chat.
    assert!(refuse(AcceptActor::Chat {
        chat_key: "chat:elsewhere",
        lead: lead("agent_boss"),
    })
    .contains("Only the person"));
    // The coordinator chat, but no registered lead behind it.
    assert!(refuse(AcceptActor::Chat {
        chat_key: "chat:master",
        lead: None,
    })
    .contains("registered lead"));
    // The coordinator's lead is the assignee: nobody accepts their own.
    assert!(refuse(AcceptActor::Chat {
        chat_key: "chat:master",
        lead: Some(("agent_ada".into(), "Ada".into())),
    })
    .contains("own work"));
    // A result other than the current one.
    assert!(store
        .accept_task(AcceptActor::Person, &task.id, "attempt_old")
        .unwrap_err()
        .contains("changed since it was reviewed"));
    assert!(store.level_summaries().unwrap().is_empty(), "nothing paid");
    assert!(store.snapshot(None).unwrap().tasks[0].acceptance.is_none());

    let accepted = store
        .accept_task(
            AcceptActor::Chat {
                chat_key: "chat:master",
                lead: lead("agent_lead"),
            },
            &task.id,
            &attempt.id,
        )
        .unwrap();
    let by = accepted.award.unwrap().accepted_by;
    assert_eq!(by.kind, AcceptorKind::Lead);
    assert_eq!(by.agent_id.as_deref(), Some("agent_lead"));
}

#[test]
fn unfinished_failed_and_unassigned_tasks_pay_nothing() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let open = assigned(&store, &run, "chat:master", ada(), None);
    let running = start(&store, "chat:master", &open);
    assert!(store
        .accept_task(AcceptActor::Person, &open.id, &running.id)
        .unwrap_err()
        .contains("Only a completed task"));
    settle(&store, &running, WorkerOutcome::Failed);
    assert!(store
        .accept_task(AcceptActor::Person, &open.id, &running.id)
        .unwrap_err()
        .contains("Only a completed task"));

    // An ordinary run's task: accepted, but nobody to pay.
    let plain = crate::orchestration::tests::task(&store, &run, Vec::new());
    let attempt = start(&store, "chat:master", &plain);
    settle(&store, &attempt, WorkerOutcome::Completed);
    let accepted = store
        .accept_task(AcceptActor::Person, &plain.id, &attempt.id)
        .unwrap();
    assert!(!accepted.awarded && accepted.award.is_none());
    assert!(accepted.note.unwrap().contains("No registered agent"));
    assert!(accepted.task.acceptance.is_some());
}

#[test]
fn a_retry_pays_once_for_the_attempt_that_was_accepted() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let task = assigned(&store, &run, "chat:master", ada(), None);
    let first = start(&store, "chat:master", &task);
    settle(&store, &first, WorkerOutcome::Failed);
    let second = start(&store, "chat:master", &task);
    assert_ne!(first.worker_chat_key, second.worker_chat_key);
    settle(&store, &second, WorkerOutcome::Completed);
    assert!(store
        .accept_task(AcceptActor::Person, &task.id, &first.id)
        .is_err());
    let accepted = store
        .accept_task(AcceptActor::Person, &task.id, &second.id)
        .unwrap();
    assert_eq!(accepted.award.unwrap().attempt_id, second.id);
    assert_eq!(
        store.level_profile("agent_ada", 0).unwrap().accepted_tasks,
        1
    );
}

#[test]
fn a_manager_accepts_its_reports_subtask_and_is_never_paid_for_it() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let grace = TaskAssignee {
        id: "agent_grace".into(),
        name: "Grace".into(),
    };
    // Grace manages; she splits her task and gives Ada a part.
    let parent = assigned(&store, &run, "chat:master", grace.clone(), None);
    let managing = start(&store, "chat:master", &parent);
    let child = assigned(
        &store,
        &run,
        &managing.worker_chat_key,
        ada(),
        Some(parent.id.clone()),
    );
    store.set_task_size(&child.id, TaskSize::Large).unwrap();
    settle(&store, &managing, WorkerOutcome::Completed);
    let work = start(&store, "chat:master", &child);
    settle(&store, &work, WorkerOutcome::Completed);

    // From her own (settled) chat, as the manager who split it.
    let accepted = store
        .accept_task(
            AcceptActor::Chat {
                chat_key: &managing.worker_chat_key,
                lead: None,
            },
            &child.id,
            &work.id,
        )
        .unwrap();
    let award = accepted.award.unwrap();
    assert_eq!((award.agent_id.as_str(), award.xp), ("agent_ada", 150));
    assert_eq!(award.accepted_by.agent_id.as_deref(), Some("agent_grace"));
    assert_eq!(
        store.level_profile("agent_grace", 0).unwrap().progress.xp,
        0
    );

    // Her own task pays her its own size, and only when accepted itself.
    store
        .accept_task(AcceptActor::Person, &parent.id, &managing.id)
        .unwrap();
    assert_eq!(
        store.level_profile("agent_grace", 0).unwrap().progress.xp,
        75
    );
    assert_eq!(
        store.level_profile("agent_ada", 0).unwrap().progress.xp,
        150
    );

    // A task the COORDINATOR put under her task is not her split, and
    // she does not accept it (review of 018a40a, H2: a parent id alone
    // is no authority).
    let planted = assigned(&store, &run, "chat:master", ada(), Some(parent.id.clone()));
    let planted_work = start(&store, "chat:master", &planted);
    settle(&store, &planted_work, WorkerOutcome::Completed);
    let refused = store
        .accept_task(
            AcceptActor::Chat {
                chat_key: &managing.worker_chat_key,
                lead: None,
            },
            &planted.id,
            &planted_work.id,
        )
        .unwrap_err();
    assert!(
        refused.contains("the manager who split this task"),
        "{refused}"
    );

    // Nobody accepts their own task from their own chat.
    let next = assigned(&store, &run, "chat:master", grace, None);
    let again = start(&store, "chat:master", &next);
    settle(&store, &again, WorkerOutcome::Completed);
    assert!(store
        .accept_task(
            AcceptActor::Chat {
                chat_key: &again.worker_chat_key,
                lead: None,
            },
            &next.id,
            &again.id,
        )
        .is_err());
}

#[test]
fn the_size_is_chosen_before_the_start_and_locked_after_it() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let task = assigned(&store, &run, "chat:master", ada(), None);
    assert_eq!(
        store.set_task_size(&task.id, TaskSize::Small).unwrap().size,
        Some(TaskSize::Small)
    );
    let attempt = start(&store, "chat:master", &task);
    assert!(store
        .set_task_size(&task.id, TaskSize::Large)
        .unwrap_err()
        .contains("locked"));
    settle(&store, &attempt, WorkerOutcome::Failed);
    // Still locked after a failure: a retry is the same task.
    assert!(store.set_task_size(&task.id, TaskSize::Large).is_err());
    let retry = start(&store, "chat:master", &task);
    settle(&store, &retry, WorkerOutcome::Completed);
    let paid = store
        .accept_task(AcceptActor::Person, &task.id, &retry.id)
        .unwrap();
    assert_eq!(paid.award.unwrap().xp, 25);
}

#[test]
fn a_task_from_before_sizes_existed_pays_only_if_it_had_not_started() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let legacy = assigned(&store, &run, "chat:master", ada(), None);
    let unstarted = assigned(&store, &run, "chat:master", ada(), None);
    // As a store written by an older build reads: no size on either, and
    // the legacy one already had an attempt when the upgrade came.
    let early = start(&store, "chat:master", &legacy);
    store
        .mutate(|data| {
            for id in [&legacy.id, &unstarted.id] {
                data.tasks.get_mut(id.as_str()).unwrap().size = None;
            }
            Ok(())
        })
        .unwrap();
    settle(&store, &early, WorkerOutcome::Completed);
    let accepted = store
        .accept_task(AcceptActor::Person, &legacy.id, &early.id)
        .unwrap();
    assert!(!accepted.awarded);
    assert!(accepted.note.unwrap().contains("before sizes"));
    let profile = store.level_profile("agent_ada", 0).unwrap();
    assert!(profile.awaiting.is_empty(), "it was accepted");

    // One that had not started takes the default at its first attempt.
    let later = start(&store, "chat:master", &unstarted);
    settle(&store, &later, WorkerOutcome::Completed);
    let paid = store
        .accept_task(AcceptActor::Person, &unstarted.id, &later.id)
        .unwrap();
    assert_eq!(paid.award.unwrap().size, TaskSize::Medium);
}

#[test]
fn the_ledger_survives_a_restart_and_follows_the_id_through_a_rename() {
    let root = crate::test_dir::TestDir::new("levels");
    let file = root.join("orchestrations.json");
    let store = OrchestrationStore::load(file.clone());
    let since = store.level_profile("agent_ada", 0).unwrap().scoring_since;
    assert!(since > 0, "scoring starts when the store first loads");
    let run = run(&store);
    let (task, attempt) = finished(&store, &run);
    store
        .accept_task(AcceptActor::Person, &task.id, &attempt.id)
        .unwrap();
    // Renamed since: same id, same ledger.
    let renamed = TaskAssignee {
        id: "agent_ada".into(),
        name: "Ada Lovelace".into(),
    };
    let second = assigned(&store, &run, "chat:master", renamed, None);
    store.set_task_size(&second.id, TaskSize::Large).unwrap();
    let attempt = start(&store, "chat:master", &second);
    settle(&store, &attempt, WorkerOutcome::Completed);
    store
        .accept_task(AcceptActor::Person, &second.id, &attempt.id)
        .unwrap();
    drop(store);

    let reloaded = OrchestrationStore::load(file);
    let profile = reloaded.level_profile("agent_ada", 0).unwrap();
    assert_eq!(profile.progress.xp, 225);
    assert_eq!(profile.progress.level, 2);
    assert_eq!(profile.accepted_tasks, 2);
    assert_eq!(profile.scoring_since, since, "stamped once");
    // Newest first, each linked to its run's main chat.
    assert_eq!(profile.history[0].record.task_id, second.id);
    assert_eq!(
        profile.history[0].record.agent_name.as_deref(),
        Some("Ada Lovelace")
    );
    assert_eq!(profile.history[1].record.agent_name.as_deref(), Some("Ada"));
    assert_eq!(
        profile.history[0].coordinator_chat_key.as_deref(),
        Some("chat:master")
    );
    // Accepted again after the restart: still paid once.
    let first_attempt = profile.history[1].record.attempt_id.clone();
    assert!(
        !reloaded
            .accept_task(AcceptActor::Person, &task.id, &first_attempt)
            .unwrap()
            .awarded
    );
}

#[test]
fn history_pages_and_awaiting_work_are_listed() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    for _ in 0..(HISTORY_PAGE + 3) {
        let (task, attempt) = finished(&store, &run);
        store
            .accept_task(AcceptActor::Person, &task.id, &attempt.id)
            .unwrap();
    }
    let (waiting, _) = finished(&store, &run);
    let first = store.level_profile("agent_ada", 0).unwrap();
    assert_eq!(first.history.len(), HISTORY_PAGE);
    assert_eq!(first.history_total, HISTORY_PAGE + 3);
    let rest = store.level_profile("agent_ada", HISTORY_PAGE).unwrap();
    assert_eq!(rest.history.len(), 3);
    assert_eq!(first.awaiting.len(), 1);
    assert_eq!(first.awaiting[0].task_id, waiting.id);
    assert!(!first.awaiting[0].unscored);
    assert_eq!(first.rules.level_step, 100);
}

#[test]
fn resizing_an_approved_task_puts_the_plan_back_before_any_worker_starts() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    let task = assigned(&store, &run, "chat:master", ada(), None);
    let plan = |store: &OrchestrationStore| {
        store.snapshot(Some(&run.id)).unwrap().runs[0]
            .plan_approval
            .clone()
            .unwrap()
    };
    store
        .approve_plan(
            "chat:master",
            &run.id,
            Some(&[task.id.clone()]),
            Some(plan(&store).revision),
        )
        .unwrap();
    // The same size again changes nothing.
    store.set_task_size(&task.id, TaskSize::Medium).unwrap();
    assert_eq!(plan(&store).status, PlanStatus::Approved);

    let resized = store.set_task_size(&task.id, TaskSize::Large).unwrap();
    assert!(resized.approved_at.is_none(), "the new size is unapproved");
    assert_eq!(plan(&store).status, PlanStatus::Pending);
    assert!(store
        .reserve_attempt("chat:master", &launch(&task))
        .is_err());
    // Approving the new revision covers the new size, and work may start.
    store
        .approve_plan(
            "chat:master",
            &run.id,
            Some(&[task.id.clone()]),
            Some(plan(&store).revision),
        )
        .unwrap();
    let attempt = start(&store, "chat:master", &task);
    settle(&store, &attempt, WorkerOutcome::Completed);
    let paid = store
        .accept_task(AcceptActor::Person, &task.id, &attempt.id)
        .unwrap();
    assert_eq!(paid.award.unwrap().xp, 150);
}

#[test]
fn xp_goes_to_the_agent_the_accepted_attempt_ran_as() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let task = assigned(&store, &run, "chat:master", ada(), None);
    let attempt = start(&store, "chat:master", &task);
    assert_eq!(
        attempt.assignee.as_ref().map(|a| a.id.as_str()),
        Some("agent_ada")
    );
    settle(&store, &attempt, WorkerOutcome::Completed);
    // Whatever the task says later, the attempt's record decides.
    store
        .mutate(|data| {
            data.tasks.get_mut(&task.id).unwrap().assignee = Some(TaskAssignee {
                id: "agent_lead".into(),
                name: "Lead".into(),
            });
            Ok(())
        })
        .unwrap();
    // The coordinator's lead is the agent that ran it? Refused either way.
    assert!(store
        .accept_task(
            AcceptActor::Chat {
                chat_key: "chat:master",
                lead: Some(("agent_ada".into(), "Ada".into())),
            },
            &task.id,
            &attempt.id,
        )
        .unwrap_err()
        .contains("own work"));
    let paid = store
        .accept_task(AcceptActor::Person, &task.id, &attempt.id)
        .unwrap();
    assert_eq!(paid.award.unwrap().agent_id, "agent_ada");
    assert_eq!(store.level_profile("agent_lead", 0).unwrap().progress.xp, 0);
}

#[test]
fn a_waiting_plan_moves_its_revision_when_a_size_changes() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    let task = assigned(&store, &run, "chat:master", ada(), None);
    let revision = |store: &OrchestrationStore| {
        store.snapshot(Some(&run.id)).unwrap().runs[0]
            .plan_approval
            .as_ref()
            .unwrap()
            .revision
    };
    let before = revision(&store);
    store
        .revise_task(
            "chat:master",
            &task.id,
            TaskRevision {
                size: Some(TaskSize::Large),
                ..TaskRevision::default()
            },
        )
        .unwrap();
    assert_eq!(revision(&store), before + 1);
    store.set_task_size(&task.id, TaskSize::Small).unwrap();
    assert_eq!(revision(&store), before + 2);
}

/// What `reopen_task` does to the task itself, without the retained
/// workspace it also insists on.
fn reopen(store: &OrchestrationStore, task: &Task) {
    store
        .mutate(|data| {
            let task = data.tasks.get_mut(&task.id).unwrap();
            task.status = TaskStatus::Ready;
            task.result = None;
            let run_id = task.run_id.clone();
            recompute_run(data, &run_id);
            Ok(())
        })
        .unwrap();
}

#[test]
fn an_unscored_acceptance_counts_and_keeps_its_record_through_a_reopen() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    // A task from before sizes: started with none recorded.
    let legacy = assigned(&store, &run, "chat:master", ada(), None);
    let first = start(&store, "chat:master", &legacy);
    store
        .mutate(|data| {
            data.tasks.get_mut(&legacy.id).unwrap().size = None;
            Ok(())
        })
        .unwrap();
    settle(&store, &first, WorkerOutcome::Completed);
    let accepted = store
        .accept_task(AcceptActor::Person, &legacy.id, &first.id)
        .unwrap();
    assert!(!accepted.awarded);

    let profile = store.level_profile("agent_ada", 0).unwrap();
    assert_eq!(
        profile.accepted_tasks, 1,
        "accepted, though it paid nothing"
    );
    assert_eq!(profile.progress.xp, 0);
    assert_eq!(profile.history_total, 1);
    let original = profile.history[0].record.clone();
    assert_eq!(
        (original.attempt_id.as_str(), original.xp, original.unpaid),
        (first.id.as_str(), 0, Some(Unpaid::Unsized))
    );
    assert_eq!(original.accepted_by.kind, AcceptorKind::Person);
    assert_eq!(original.agent_id.as_deref(), Some("agent_ada"));
    let summary = store.level_summaries().unwrap();
    assert_eq!(
        (
            summary.len(),
            summary[0].accepted_tasks,
            summary[0].progress.xp
        ),
        (1, 1, 0),
        "the roster agrees with the profile"
    );

    // Reopened, redone, accepted again by the lead.
    reopen(&store, &legacy);
    let second = start(&store, "chat:master", &legacy);
    settle(&store, &second, WorkerOutcome::Completed);
    let again = store
        .accept_task(
            AcceptActor::Chat {
                chat_key: "chat:master",
                lead: lead("agent_lead"),
            },
            &legacy.id,
            &second.id,
        )
        .unwrap();
    assert!(!again.awarded, "still unsized, still nothing");
    assert_eq!(again.task.acceptance.unwrap().attempt_id, second.id);

    let profile = store.level_profile("agent_ada", 0).unwrap();
    assert_eq!(profile.accepted_tasks, 1, "one task, counted once");
    assert_eq!(profile.progress.xp, 0);
    assert_eq!(profile.history_total, 2, "both acceptances are on record");
    let newest = &profile.history[0].record;
    assert_eq!(newest.attempt_id, second.id);
    assert_eq!(newest.accepted_by.agent_id.as_deref(), Some("agent_lead"));
    assert_eq!(
        profile.history[1].record, original,
        "the first is untouched"
    );

    // Accepting the current result once more writes nothing new.
    store
        .accept_task(AcceptActor::Person, &legacy.id, &second.id)
        .unwrap();
    assert_eq!(
        store.level_profile("agent_ada", 0).unwrap().history_total,
        2
    );
}

#[test]
fn a_paid_task_reaccepted_after_a_reopen_keeps_both_records_and_pays_once() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    let (task, first) = finished(&store, &run);
    store
        .accept_task(AcceptActor::Person, &task.id, &first.id)
        .unwrap();
    reopen(&store, &task);
    let second = start(&store, "chat:master", &task);
    settle(&store, &second, WorkerOutcome::Completed);
    let again = store
        .accept_task(AcceptActor::Person, &task.id, &second.id)
        .unwrap();
    assert!(!again.awarded);
    assert_eq!(
        again.award.unwrap().attempt_id,
        first.id,
        "the award stands"
    );

    let profile = store.level_profile("agent_ada", 0).unwrap();
    assert_eq!((profile.accepted_tasks, profile.progress.xp), (1, 75));
    let records: Vec<_> = profile
        .history
        .iter()
        .map(|entry| {
            (
                entry.record.attempt_id.clone(),
                entry.record.xp,
                entry.record.unpaid,
            )
        })
        .collect();
    assert_eq!(
        records,
        vec![
            (second.id.clone(), 0, Some(Unpaid::AlreadyPaid)),
            (first.id.clone(), 75, None),
        ]
    );
}

#[test]
fn a_store_from_before_the_ledger_gets_its_acceptances_back_once() {
    let root = crate::test_dir::TestDir::new("ledger");
    let file = root.join("orchestrations.json");
    let store = OrchestrationStore::load(file.clone());
    let run = run(&store);
    let (paid, paid_attempt) = finished(&store, &run);
    store
        .accept_task(AcceptActor::Person, &paid.id, &paid_attempt.id)
        .unwrap();
    let legacy = assigned(&store, &run, "chat:master", ada(), None);
    let early = start(&store, "chat:master", &legacy);
    store
        .mutate(|data| {
            data.tasks.get_mut(&legacy.id).unwrap().size = None;
            Ok(())
        })
        .unwrap();
    settle(&store, &early, WorkerOutcome::Completed);
    store
        .accept_task(AcceptActor::Person, &legacy.id, &early.id)
        .unwrap();
    drop(store);

    // As the earlier build wrote it: awards and task acceptances, no ledger.
    let mut raw: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    raw.as_object_mut().unwrap().remove("acceptances");
    fs::write(&file, serde_json::to_vec(&raw).unwrap()).unwrap();

    let reloaded = OrchestrationStore::load(file.clone());
    let profile = reloaded.level_profile("agent_ada", 0).unwrap();
    assert_eq!((profile.accepted_tasks, profile.progress.xp), (2, 75));
    let mut unpaid: Vec<_> = profile
        .history
        .iter()
        .map(|e| (e.record.xp, e.record.unpaid))
        .collect();
    unpaid.sort_by_key(|(xp, _)| *xp);
    assert_eq!(unpaid, vec![(0, Some(Unpaid::Unsized)), (75, None)]);
    drop(reloaded);
    // Loading again adds nothing.
    let again = OrchestrationStore::load(file);
    assert_eq!(
        again.level_profile("agent_ada", 0).unwrap().history_total,
        2
    );
}

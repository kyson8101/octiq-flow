//! What an approval covers (`approval.rs`), as the independent review of
//! 018a40a attacked it: each of its probes is a test here, with the start
//! now refused before anything is reserved.

use super::tests::{
    approved_plan, assigned, enable_automatic_dispatch, finish_attempt, held, host_launch,
    launch_for, plan_of, run, start_as_planned, start_task, task, wave,
};
use super::*;

fn dev() -> TaskAssignee {
    TaskAssignee {
        id: "agent_dev".into(),
        name: "Dev".into(),
    }
}

fn settings(access: Access) -> automation::WorkerSettings {
    automation::WorkerSettings {
        agent: ChatAgent::Codex,
        model: Some("gpt-5.6-terra".into()),
        effort: None,
        access,
        recovery: None,
    }
}

fn defaults(access: Access, fallback: Option<&str>) -> automation::WorkerDefaults {
    automation::WorkerDefaults {
        agent: Some(ChatAgent::Codex),
        model: Some("gpt-5.6-terra".into()),
        effort: None,
        access,
        recovery: fallback.map(|model| execution::RecoveryPolicy {
            fallback_model: Some(model.into()),
            ..execution::RecoveryPolicy::default()
        }),
    }
}

/// A run whose plan the person approved with one task on it, handed to Dev.
fn approved(store: &OrchestrationStore, worker: Option<automation::WorkerSettings>) -> (Run, Task) {
    let run = run(store);
    store.require_plan_approval(&run.id).unwrap();
    let made = store
        .create_task_for(
            "chat:master",
            run.id.clone(),
            "Inspect only".into(),
            "Inspect under command approval".into(),
            Vec::new(),
            None,
            worker,
            Some(dev()),
            None,
        )
        .unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    let task = task_now(store, &made.id);
    (run, task)
}

fn task_now(store: &OrchestrationStore, id: &str) -> Task {
    store
        .snapshot(None)
        .unwrap()
        .tasks
        .into_iter()
        .find(|task| task.id == id)
        .unwrap()
}

fn attempts_of(store: &OrchestrationStore, task_id: &str) -> Vec<Attempt> {
    let mut attempts: Vec<Attempt> = store
        .snapshot(None)
        .unwrap()
        .attempts
        .into_iter()
        .filter(|attempt| attempt.task_id == task_id)
        .collect();
    attempts.sort_by_key(|attempt| attempt.number);
    attempts
}

/// A capacity failure, which the host retries by itself.
fn fail_for_capacity(store: &OrchestrationStore, attempt: &Attempt) {
    store
        .observe_worker_event(
            &attempt.worker_chat_key,
            &json!({"type":"turn.failed", "error":{"message":"Selected model is at capacity"}}),
        )
        .unwrap();
}

/// Review H1, probes 1 and 7: a task approved at Manual on one model is not
/// started at Full on another, by the coordinator or from the page, with a
/// revision pending or not. The refusal names both differences, and nothing
/// was reserved or written.
#[test]
fn an_approved_manual_task_does_not_start_with_full_access_or_another_model() {
    for pending in [true, false] {
        let store = OrchestrationStore::default();
        let (run, approved) = approved(&store, Some(settings(Access::Manual)));
        if pending {
            task(&store, &run, Vec::new());
        }
        assert_eq!(
            plan_of(&store, &run.id).status == PlanStatus::Pending,
            pending
        );
        let fixed = approved
            .approved
            .clone()
            .expect("the approval fixed a shape");
        assert_eq!(fixed.by, approval::FixedBy::Plan);
        assert_eq!(fixed.worker.as_ref().unwrap().access, Access::Manual);
        assert_eq!(fixed.assignee, Some(dev()));

        let wider = WorkerLaunch {
            access: Access::Full,
            model: Some("gpt-5.6-sol".into()),
            ..launch_for(&approved.id)
        };
        for by in [StartedBy::Coordinator, StartedBy::Page { retry_of: None }] {
            let refused = store
                .reserve_attempt_for("chat:master", &wider, by)
                .unwrap_err();
            assert!(
                refused.contains(
                    "The person approved this task as codex:terra at manual access for Dev"
                ),
                "{refused}"
            );
            assert!(
                refused.contains("the worker codex:sol instead of codex:terra"),
                "{refused}"
            );
            assert!(
                refused.contains("full access instead of manual"),
                "{refused}"
            );
            assert!(refused.contains("plan card"), "{refused}");
        }
        // One difference is enough, and each is named for what it is.
        for (launch, named) in [
            (
                WorkerLaunch {
                    access: Access::Full,
                    ..host_launch(&store, &approved.id)
                },
                "full access instead of manual",
            ),
            (
                WorkerLaunch {
                    access: Access::Read,
                    ..host_launch(&store, &approved.id)
                },
                "read access instead of manual",
            ),
            (
                WorkerLaunch {
                    effort: Some("high".into()),
                    ..host_launch(&store, &approved.id)
                },
                "high effort instead of none",
            ),
            (
                WorkerLaunch {
                    agent: ChatAgent::Claude,
                    model: Some("opus".into()),
                    ..host_launch(&store, &approved.id)
                },
                "the worker claude:opus instead of codex:terra",
            ),
            (
                WorkerLaunch {
                    base_branch: "release".into(),
                    ..host_launch(&store, &approved.id)
                },
                "the base branch release instead of",
            ),
        ] {
            let refused = store.reserve_attempt("chat:master", &launch).unwrap_err();
            assert!(refused.contains(named), "{named}: {refused}");
        }
        // Nothing was reserved, and the task is as it was approved.
        assert!(attempts_of(&store, &approved.id).is_empty());
        let after = task_now(&store, &approved.id);
        assert_eq!(after.status, TaskStatus::Ready);
        assert_eq!(after.worker.as_ref().unwrap().access, Access::Manual);
        assert_eq!(after.approved, Some(fixed.clone()));

        // As approved, it starts, and the start writes nothing to the record.
        let started = start_as_planned(&store, &approved.id);
        assert_eq!(started.access, Access::Manual);
        assert_eq!(started.model.as_deref(), Some("gpt-5.6-terra"));
        assert_eq!(task_now(&store, &approved.id).approved, Some(fixed));
    }
}

/// Review H1, probe 2, and rule A2: the run's defaults changed after an
/// approval reach only tasks not yet approved. The task approved under
/// Manual defaults still dispatches at Manual, and a start that asks for the
/// new defaults is refused.
#[test]
fn run_defaults_changed_after_an_approval_do_not_reach_the_approved_task() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    store
        .configure_automation("chat:master", &run.id, Some(defaults(Access::Manual, None)))
        .unwrap();
    let old = task(&store, &run, Vec::new());
    assert!(old.worker.is_none(), "it runs as the run's defaults");
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    let fixed = task_now(&store, &old.id).approved.unwrap();
    assert_eq!(fixed.worker.as_ref().unwrap().access, Access::Manual);

    let added = task(&store, &run, Vec::new());
    store
        .configure_automation("chat:master", &run.id, Some(defaults(Access::Full, None)))
        .unwrap();
    // What the host's own dispatch would launch each as.
    assert_eq!(host_launch(&store, &old.id).access, Access::Manual);
    assert_eq!(host_launch(&store, &added.id).access, Access::Full);
    let refused = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                access: Access::Full,
                ..host_launch(&store, &old.id)
            },
        )
        .unwrap_err();
    assert!(
        refused.contains("full access instead of manual"),
        "{refused}"
    );
    assert_eq!(start_as_planned(&store, &old.id).access, Access::Manual);

    // The task added since is approved under the defaults of ITS approval.
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    let later = task_now(&store, &added.id).approved.unwrap();
    assert_eq!(later.worker.as_ref().unwrap().access, Access::Full);
    assert_eq!(start_as_planned(&store, &added.id).access, Access::Full);
    // And the first one's record did not move with that second approval.
    assert_eq!(task_now(&store, &old.id).approved, Some(fixed));
}

/// A recovery runs under the policy the task was approved with. A fallback
/// model the run's defaults gained afterwards is not in it: the host
/// schedules the retry on the approved fallback, and a start that asks for
/// the other is refused.
#[test]
fn a_recovery_fallback_that_was_not_approved_is_refused() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    store
        .configure_automation(
            "chat:master",
            &run.id,
            Some(defaults(Access::Auto, Some("gpt-5.5"))),
        )
        .unwrap();
    let approved = task(&store, &run, Vec::new());
    let bare = store
        .create_task_for(
            "chat:master",
            run.id.clone(),
            "No fallback".into(),
            "Its own worker, no policy".into(),
            Vec::new(),
            None,
            Some(settings(Access::Auto)),
            None,
            None,
        )
        .unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    store
        .configure_automation(
            "chat:master",
            &run.id,
            Some(defaults(Access::Auto, Some("gpt-5.6-sol"))),
        )
        .unwrap();

    let first = start_as_planned(&store, &approved.id);
    fail_for_capacity(&store, &first);
    let failed = attempts_of(&store, &approved.id).remove(0);
    assert_eq!(
        failed.execution.retry_model.as_deref(),
        Some("gpt-5.5"),
        "the fallback the person approved, not the one set since"
    );
    store
        .mutate(|data| {
            data.attempts
                .get_mut(&first.id)
                .unwrap()
                .execution
                .next_retry_at = Some(now_ms() - 1);
            Ok(())
        })
        .unwrap();
    let recovery = |model: &str| WorkerLaunch {
        model: Some(model.into()),
        new_worktree: Some(false),
        ..host_launch(&store, &approved.id)
    };
    let refused = store
        .reserve_attempt_for(
            "chat:master",
            &recovery("gpt-5.6-sol"),
            StartedBy::Recovery(&first.id),
        )
        .unwrap_err();
    assert!(
        refused.contains(
            "the worker codex:sol instead of codex:terra (or its approved fallback gpt-5.5)"
        ),
        "{refused}"
    );
    assert_eq!(attempts_of(&store, &approved.id).len(), 1);
    let (_, task, retried, _) = store
        .reserve_attempt_for(
            "chat:master",
            &recovery("gpt-5.5"),
            StartedBy::Recovery(&first.id),
        )
        .unwrap();
    assert_eq!(retried.model.as_deref(), Some("gpt-5.5"));
    assert_eq!(
        task.approved.unwrap().worker.unwrap().model.as_deref(),
        Some("gpt-5.6-terra"),
        "a retry on the fallback does not become what was approved"
    );
    // After it, the host's dispatch still launches the approved model.
    assert_eq!(
        host_launch(&store, &approved.id).model.as_deref(),
        Some("gpt-5.6-terra")
    );

    // A task approved with its own worker and no policy of its own took the
    // run's policy of that moment, and none of what came after.
    let first = start_as_planned(&store, &bare.id);
    fail_for_capacity(&store, &first);
    let failed = attempts_of(&store, &bare.id).remove(0);
    assert_eq!(failed.execution.retry_model.as_deref(), Some("gpt-5.5"));
}

/// A task approved with no worker chosen at all (none of its own, no run
/// defaults: a run outside agents mode) has nothing of a worker for its
/// approval to fix. Its first start chooses, and fixes it for every later
/// one.
#[test]
fn a_task_approved_with_no_worker_chosen_is_fixed_by_its_first_start() {
    let store = OrchestrationStore::default();
    let (_run, tasks) = approved_plan(&store, 1);
    let fixed = task_now(&store, &tasks[0].id).approved.unwrap();
    assert_eq!(fixed.worker, None);
    assert_eq!(fixed.by, approval::FixedBy::Plan);
    let first = WorkerLaunch {
        access: Access::Manual,
        ..launch_for(&tasks[0].id)
    };
    let (_, started, attempt, _) = store.reserve_attempt("chat:master", &first).unwrap();
    assert_eq!(
        started.approved.unwrap().worker.unwrap().access,
        Access::Manual
    );
    let attempt = store
        .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
        .unwrap();
    finish_attempt(&store, attempt, WorkerOutcome::Blocked);
    let refused = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                access: Access::Full,
                ..first.clone()
            },
        )
        .unwrap_err();
    assert!(
        refused.contains("full access instead of manual"),
        "{refused}"
    );
    store.reserve_attempt("chat:master", &first).unwrap();
}

/// A ledger written before approvals fixed a shape: an approved task takes
/// the shape it has on the first write after, and is held to it from then.
#[test]
fn a_ledger_from_before_shapes_takes_them_on_its_first_write() {
    let store = OrchestrationStore::default();
    let (_run, approved) = approved(&store, Some(settings(Access::Manual)));
    // As such a ledger holds it: approved, with no record of as what.
    {
        let mut inner = store.inner.lock().unwrap();
        inner.data.tasks.get_mut(&approved.id).unwrap().approved = None;
    }
    assert!(task_now(&store, &approved.id).approved.is_none());
    // The very first write is a start that asks for more: it is compared
    // with the shape taken in that same write.
    let refused = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                access: Access::Full,
                ..host_launch(&store, &approved.id)
            },
        )
        .unwrap_err();
    assert!(
        refused.contains("full access instead of manual"),
        "{refused}"
    );
    store.mutate(|_| Ok(())).unwrap();
    let fixed = task_now(&store, &approved.id).approved.unwrap();
    assert_eq!(fixed.by, approval::FixedBy::Ledger);
    assert_eq!(fixed.worker.unwrap().access, Access::Manual);
    assert_eq!(fixed.assignee, Some(dev()));
    // A task nobody approved has none, and its start is the coordinator's
    // choice as it always was.
    let free = OrchestrationStore::default();
    let run = run(&free);
    let open = task(&free, &run, Vec::new());
    free.mutate(|_| Ok(())).unwrap();
    assert!(task_now(&free, &open.id).approved.is_none());
    let (_, _, attempt, _) = free
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                access: Access::Full,
                ..launch_for(&open.id)
            },
        )
        .unwrap();
    assert_eq!(attempt.access, Access::Full);
}

/// A change that sends a task back to the plan card takes its shape away
/// with its approval. Rejecting the amendment puts both back as they were;
/// approving it fixes the shape again, as it then stands.
#[test]
fn a_task_back_on_the_plan_card_has_no_shape_until_it_is_decided() {
    let store = OrchestrationStore::default();
    let (run, approved) = approved(&store, Some(settings(Access::Manual)));
    let fixed = approved.approved.clone().unwrap();
    let card = || CardView {
        surface: "panel".into(),
        shown_ms: Some(2_000),
        updated_ms: None,
    };

    store.set_task_size(&approved.id, TaskSize::Large).unwrap();
    let waiting = task_now(&store, &approved.id);
    assert!(waiting.approved_at.is_none() && waiting.approved.is_none());
    let revision = plan_of(&store, &run.id).revision;
    store
        .reject_plan_from_card(
            "chat:master",
            &run.id,
            Some(&[approved.id.clone()]),
            Some(revision),
            None,
            card(),
        )
        .unwrap();
    assert_eq!(task_now(&store, &approved.id).approved, Some(fixed.clone()));

    // Handed to another agent at Read, and approved: that is the shape now.
    store
        .reassign_task(
            "chat:master",
            &approved.id,
            (
                Some(settings(Access::Read)),
                Some(TaskAssignee {
                    id: "agent_bo".into(),
                    name: "Bo".into(),
                }),
                None,
            ),
            "Bo reviews it read-only.".into(),
        )
        .unwrap();
    assert!(task_now(&store, &approved.id).approved.is_none());
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    let again = task_now(&store, &approved.id).approved.unwrap();
    assert_eq!(again.worker.as_ref().unwrap().access, Access::Read);
    assert_eq!(again.assignee.as_ref().unwrap().name, "Bo");
    assert!(again.at >= fixed.at);
    // The handoff's own guard speaks first for a higher access; the approval
    // refuses what that guard does not look at.
    let above = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                access: Access::Manual,
                ..host_launch(&store, &approved.id)
            },
        )
        .unwrap_err();
    assert!(above.contains("handed to Bo"), "{above}");
    let refused = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                effort: Some("high".into()),
                ..host_launch(&store, &approved.id)
            },
        )
        .unwrap_err();
    assert!(refused.contains("high effort instead of none"), "{refused}");
    assert_eq!(start_as_planned(&store, &approved.id).access, Access::Read);
}

/// Review H2, probe 3: a task the COORDINATOR creates under an approved
/// parent is new work with a parent id on it. It is not approved, the plan
/// goes back to the person with it on the card, `heldByPlan` says so, and no
/// start of it is accepted until they approve it.
#[test]
fn a_coordinators_task_under_an_approved_parent_waits_for_its_own_approval() {
    let store = OrchestrationStore::default();
    let (run, parent) = approved(&store, Some(settings(Access::Manual)));
    let child = store
        .create_task_for(
            "chat:master",
            run.id.clone(),
            "Entirely new work".into(),
            "New spec never shown to the person".into(),
            Vec::new(),
            Some(parent.id.clone()),
            Some(settings(Access::Full)),
            Some(dev()),
            Some(TaskDestination {
                project_id: "different".into(),
                project_name: "Different".into(),
                repository: "/tmp".into(),
            }),
        )
        .unwrap();
    assert_eq!(child.parent_task_id.as_deref(), Some(parent.id.as_str()));
    assert!(child.split_by.is_none() && child.approved_at.is_none() && child.approved.is_none());
    assert!(plan_of(&store, &run.id).status == PlanStatus::Pending);
    assert!(held(&store, &run.id).contains(&child.id), "heldByPlan");
    assert!(!wave(&store, &run.id).contains(&child.id));
    let on_card: Vec<String> = {
        let inner = store.inner.lock().unwrap();
        awaiting_approval(&inner.data, &run.id)
            .map(|task| task.id.clone())
            .collect()
    };
    assert_eq!(on_card, [child.id.clone()], "it is on the plan card");
    for by in [StartedBy::Coordinator, StartedBy::Page { retry_of: None }] {
        let refused = store
            .reserve_attempt_for(
                "chat:master",
                &WorkerLaunch {
                    access: Access::Full,
                    ..host_launch(&store, &child.id)
                },
                by,
            )
            .unwrap_err();
        assert!(
            refused.contains("has not approved this task yet"),
            "{refused}"
        );
    }
    assert!(attempts_of(&store, &child.id).is_empty());
    // It can be revised like any unapproved task, which a real subtask
    // cannot.
    store
        .revise_task(
            "chat:master",
            &child.id,
            TaskRevision {
                spec: Some("Shown to the person now".into()),
                ..Default::default()
            },
        )
        .unwrap();
    // Approved on its own card, it starts as it was approved.
    store
        .approve_plan("chat:master", &run.id, Some(&[child.id.clone()]), None)
        .unwrap();
    assert_eq!(start_as_planned(&store, &child.id).access, Access::Full);
}

/// Review H2, probe 9: the same through the real command, with a registered
/// lead and its direct report, and up to workspace preparation. The child is
/// created, routed and left unapproved; it does not reserve, so nothing is
/// prepared for it.
#[test]
fn the_real_task_create_command_leaves_a_coordinators_child_unapproved() {
    let fixture = crate::test_dir::TestDir::new("m2-route");
    let wiring = crate::handover::Wiring::scratch();
    let team = wiring.team.clone();
    let _team = crate::team::use_test_path(team.clone());
    let agent = |value| crate::team::save(&team, serde_json::from_value(value).unwrap()).unwrap();
    let lead = agent(json!({
        "name": "Lead", "role": "Coordinates", "agent": "codex", "model": "gpt-5.6-terra",
    }));
    let dev = agent(json!({
        "name": "Dev", "role": "Reviews", "agent": "codex", "model": "gpt-5.6-terra",
        "access": "full", "reportsTo": lead.id,
    }));
    crate::team::record_lead(&team, "chat:master", &lead, "workspace", false).unwrap();
    let store = Arc::new(OrchestrationStore::default());
    let (run, parent) = approved(&store, Some(settings(Access::Manual)));
    let svc = crate::dispatch::Services {
        workspaces: Arc::new(crate::workspaces::WorkspaceState::with_projects(vec![
            serde_json::from_value(json!({
                "id": "workspace", "name": "Project", "primary_path": fixture.0, "paths": [],
            }))
            .unwrap(),
        ])),
        chats: Arc::new(ChatManager::default()),
        watch: Arc::new(crate::file_watch::FileWatchState::default()),
        git_watch: Arc::new(crate::git_watch::GitWatchState::default()),
        orchestrations: store.clone(),
        ptys: Arc::new(crate::pty::PtyManager::default()),
        handovers: wiring,
    };
    let made = crate::dispatch::dispatch(
        &svc,
        "orchestration_task_create",
        json!({
            "actorChatKey": "chat:master", "runId": run.id, "parentTaskId": parent.id,
            "title": "New scope", "spec": "Unreviewed new instructions",
            "assignee": dev.id, "project": "workspace",
        }),
    )
    .unwrap();
    let child: Task = serde_json::from_value(made).unwrap();
    assert!(child.approved_at.is_none() && child.split_by.is_none());
    assert_eq!(child.worker.as_ref().unwrap().access, Access::Full);
    let snapshot =
        crate::dispatch::dispatch(&svc, "orchestration_snapshot", json!({ "runId": run.id }))
            .unwrap();
    let shown = snapshot["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == child.id.as_str())
        .unwrap();
    assert_eq!(shown["heldByPlan"], true, "{shown}");
    let started = crate::dispatch::dispatch(
        &svc,
        "orchestration_worker_start_in_chat",
        json!({
            "actorChatKey": "chat:master", "taskId": child.id,
            "agent": "codex", "model": "gpt-5.6-terra", "access": "full",
        }),
    )
    .unwrap_err();
    assert!(
        started.contains("has not approved this task yet"),
        "{started}"
    );
    let after = store.snapshot(Some(&run.id)).unwrap();
    assert!(
        after.attempts.is_empty(),
        "nothing reserved, nothing prepared"
    );
    assert!(after
        .tasks
        .iter()
        .find(|task| task.id == child.id)
        .unwrap()
        .workspace
        .is_none());
}

/// Review H2, probe 4: a manager's real split still goes by its parent's
/// approval, and it starts only as the worker the host routed it to.
#[test]
fn a_managers_split_inherits_the_approval_and_runs_as_it_was_routed() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    let managed = assigned(&store, &run, "chat:master", None, Vec::new()).unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    let manager = start_task(&store, &managed.id);
    let part = store
        .create_task_for(
            &manager.worker_chat_key,
            run.id.clone(),
            "Part".into(),
            "Do the part".into(),
            Vec::new(),
            Some(managed.id.clone()),
            Some(settings(Access::Manual)),
            Some(dev()),
            None,
        )
        .unwrap();
    assert_eq!(part.split_by.as_deref(), Some(manager.id.as_str()));
    let fixed = part.approved.clone().unwrap();
    assert_eq!(fixed.by, approval::FixedBy::Split);
    assert_eq!(fixed.worker.as_ref().unwrap().access, Access::Manual);
    // A revision pending for other work does not hold it.
    task(&store, &run, Vec::new());
    assert!(plan_of(&store, &run.id).status == PlanStatus::Pending);
    assert!(!held(&store, &run.id).contains(&part.id));
    let refused = store
        .reserve_attempt(
            "chat:master",
            &WorkerLaunch {
                access: Access::Full,
                ..host_launch(&store, &part.id)
            },
        )
        .unwrap_err();
    assert!(
        refused.contains("full access instead of manual"),
        "{refused}"
    );
    let working = start_as_planned(&store, &part.id);
    assert_eq!(working.access, Access::Manual);
    finish_attempt(&store, working, WorkerOutcome::Completed);
    // Only the manager of THAT task splits it: another worker of the run,
    // naming it as the parent, is not its manager.
    let other = assigned(&store, &run, "chat:master", None, Vec::new()).unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    let stranger = start_task(&store, &other.id);
    assert!(assigned(
        &store,
        &run,
        &stranger.worker_chat_key,
        Some(managed.id.clone()),
        Vec::new()
    )
    .is_err());
}

/// Review M2: superseding a task takes back the retry the host owed it, and
/// no later start or recovery of it is accepted. The refusal names the task
/// that replaced it.
#[test]
fn superseding_a_task_cancels_its_retry_and_refuses_every_later_start() {
    let store = OrchestrationStore::default();
    let (run, tasks) = approved_plan(&store, 1);
    enable_automatic_dispatch(&store, &run.id);
    let old = &tasks[0];
    let failed = start_task(&store, &old.id);
    fail_for_capacity(&store, &failed);
    let owed = attempts_of(&store, &old.id).remove(0);
    assert!(owed.execution.next_retry_at.is_some(), "a retry is owed");
    assert_eq!(task_now(&store, &old.id).status, TaskStatus::Blocked);

    let new = store
        .create_task(
            "chat:master",
            run.id.clone(),
            "Do it another way".into(),
            "The replacement".into(),
            Vec::new(),
            None,
            None,
        )
        .unwrap();
    let replaced = store.supersede("chat:master", &old.id, &new.id).unwrap();
    assert_eq!(replaced.superseded_by.as_deref(), Some(new.id.as_str()));
    assert_eq!(replaced.status, TaskStatus::Failed);
    let cancelled = attempts_of(&store, &old.id).remove(0);
    assert!(cancelled.execution.next_retry_at.is_none());
    assert!(cancelled.execution.retry_model.is_none());
    assert!(cancelled
        .execution
        .current_operation
        .as_deref()
        .is_some_and(|said| said.contains(&new.id)));

    let named = format!("replaced by \"Do it another way\" ({})", new.id);
    for by in [
        StartedBy::Coordinator,
        StartedBy::Page {
            retry_of: Some(&failed.id),
        },
        StartedBy::Recovery(&failed.id),
    ] {
        let refused = store
            .reserve_attempt_for("chat:master", &host_launch(&store, &old.id), by)
            .unwrap_err();
        assert!(refused.contains(&named), "{by:?}: {refused}");
    }
    // The host's own pass finds nothing to recover.
    let workspaces =
        crate::workspaces::WorkspaceState::with_projects(vec![serde_json::from_value(json!({
            "id": "workspace", "name": "Project", "primary_path": "/tmp", "paths": [],
        }))
        .unwrap()]);
    let recover = || {
        store
            .recover_due_workers(Arc::new(ChatManager::default()), &workspaces, now_ms())
            .unwrap()
    };
    recover();
    assert_eq!(attempts_of(&store, &old.id).len(), 1);

    // A ledger from before this rule, with the retry still on it: the
    // recovery is refused at the start, dropped, and told once, by name.
    store
        .mutate(|data| {
            data.attempts
                .get_mut(&failed.id)
                .unwrap()
                .execution
                .next_retry_at = Some(now_ms() - 1);
            Ok(())
        })
        .unwrap();
    recover();
    assert_eq!(attempts_of(&store, &old.id).len(), 1);
    assert!(attempts_of(&store, &old.id)[0]
        .execution
        .next_retry_at
        .is_none());
    let told: Vec<String> = store
        .snapshot(Some(&run.id))
        .unwrap()
        .notifications
        .into_iter()
        .filter(|n| n.source == format!("recovery-failed:{}", failed.id))
        .map(|n| n.body)
        .collect();
    assert_eq!(told.len(), 1);
    assert!(told[0].contains(&named), "{}", told[0]);
}

/// The person stops one task's worker and the run goes on. The task is then
/// theirs to start again: an agent's start and the host's dispatch are
/// refused, and their own Start, naming the stopped attempt, runs it.
#[test]
fn the_person_stops_one_task_and_only_they_start_it_again() {
    let store = OrchestrationStore::default();
    let (run, tasks) = approved_plan(&store, 2);
    let stopped = start_task(&store, &tasks[0].id);
    let other = start_task(&store, &tasks[1].id);
    let gate = store
        .create_gate(
            &stopped.worker_chat_key,
            run.id.clone(),
            Some(tasks[0].id.clone()),
            "Which way?".into(),
            Vec::new(),
        )
        .unwrap();

    let (task, worker) = store
        .stop_task(&tasks[0].id, Some("  Not these instructions  ".into()))
        .unwrap();
    assert_eq!(worker, stopped.worker_chat_key);
    assert_eq!(task.status, TaskStatus::Failed);
    assert_eq!(
        task.result.as_deref(),
        Some("Stopped by the person. Their reason: Not these instructions")
    );
    let record = task.stopped.clone().unwrap();
    assert_eq!(record.attempt_id, stopped.id);
    assert_eq!(record.reason.as_deref(), Some("Not these instructions"));
    let snapshot = store.snapshot(Some(&run.id)).unwrap();
    let attempt = |id: &str| snapshot.attempts.iter().find(|a| a.id == id).unwrap();
    assert_eq!(attempt(&stopped.id).status, AttemptStatus::Cancelled);
    assert_eq!(attempt(&other.id).status, AttemptStatus::Running);
    assert_eq!(snapshot.runs[0].status, RunStatus::Running);
    assert_eq!(
        snapshot
            .gates
            .iter()
            .find(|g| g.id == gate.id)
            .unwrap()
            .status,
        GateStatus::Cancelled
    );
    let told: Vec<&inbox::Notification> = snapshot
        .notifications
        .iter()
        .filter(|n| n.source == format!("task-stopped:{}", stopped.id))
        .collect();
    assert_eq!(told.len(), 1);
    assert_eq!(told[0].target_chat_key, "chat:master");
    assert!(told[0].body.contains("only the person starts it again"));

    // Nothing running on it: nothing to stop.
    let nothing = store.stop_task(&tasks[0].id, None).unwrap_err();
    assert!(nothing.contains("nothing to stop"), "{nothing}");
    assert!(store.stop_task("task_missing", None).is_err());

    assert!(!wave(&store, &run.id).contains(&tasks[0].id));
    for by in [StartedBy::Coordinator, StartedBy::Recovery(&stopped.id)] {
        let refused = store
            .reserve_attempt_for("chat:master", &launch_for(&tasks[0].id), by)
            .unwrap_err();
        assert!(
            refused.contains("The person stopped this task's worker"),
            "{by:?}: {refused}"
        );
    }
    let (_, task, again, _) = store
        .reserve_attempt_for(
            "chat:master",
            &launch_for(&tasks[0].id),
            StartedBy::Page {
                retry_of: Some(&stopped.id),
            },
        )
        .unwrap();
    assert_eq!(again.number, 2);
    assert!(task.stopped.is_none());
}

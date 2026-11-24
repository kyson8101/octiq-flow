//! A task's extra MCP servers (`Task::worker_servers`): named by the run's
//! coordinator, shown on the plan card, fixed by the person's approval, and
//! read at launch from the reservation, never from the task of the moment.

use super::tests::{
    finish_attempt, held, host_launch, plan_of, run, settled_worker, start_as_planned,
};
use super::*;
use crate::dispatch::{dispatch, Services};

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|name| name.to_string()).collect()
}

fn claude(access: Access) -> automation::WorkerSettings {
    automation::WorkerSettings {
        agent: ChatAgent::Claude,
        model: Some("opus".into()),
        effort: None,
        access,
        recovery: None,
    }
}

/// A coordinator's task naming `servers`, on a run whose plan the person
/// approves.
fn planned(store: &OrchestrationStore, run: &Run, servers: &[&str]) -> Result<Task, String> {
    store.create_task_with_effort(
        "chat:master",
        run.id.clone(),
        "Cut the video".into(),
        "Cut it with the person's video tools".into(),
        Vec::new(),
        None,
        Some(claude(Access::Auto)),
        None,
        None,
        None,
        None,
        TaskKind::Work,
        false,
        names(servers),
    )
}

/// A run whose plan the person approved, with one task naming `servers`.
fn approved_with(store: &OrchestrationStore, servers: &[&str]) -> (Run, Task) {
    let run = run(store);
    store.require_plan_approval(&run.id).unwrap();
    let task = planned(store, &run, servers).unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    (run, now(store, &task.id))
}

fn now(store: &OrchestrationStore, id: &str) -> Task {
    store
        .snapshot(None)
        .unwrap()
        .tasks
        .into_iter()
        .find(|task| task.id == id)
        .unwrap()
}

fn servers_only(
    store: &OrchestrationStore,
    actor: &str,
    task: &str,
    servers: &[&str],
) -> Result<Task, String> {
    store.revise_task_with_servers(actor, task, TaskRevision::default(), Some(names(servers)))
}

fn attempts_of(store: &OrchestrationStore, task_id: &str) -> usize {
    store
        .snapshot(None)
        .unwrap()
        .attempts
        .iter()
        .filter(|attempt| attempt.task_id == task_id)
        .count()
}

/// The list is held to an agent's bounds, and is the person's to approve:
/// a run with no plan card, and a worker that takes no servers, name none.
#[test]
fn a_task_names_servers_within_the_agents_bounds_and_only_where_the_person_approves_them() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    let thirteen: Vec<String> = (1..=13).map(|n| format!("server-{n}")).collect();
    let thirteen: Vec<&str> = thirteen.iter().map(String::as_str).collect();
    let twelve = planned(&store, &run, &thirteen[..12]).unwrap();
    assert_eq!(twelve.worker_servers.len(), 12);
    let refused = planned(&store, &run, &thirteen).unwrap_err();
    assert!(
        refused.contains("A task's worker can be given at most 12"),
        "{refused}"
    );
    for bad in ["octiq", "octiq_playwright", "a/b", ""] {
        assert!(planned(&store, &run, &[bad]).is_err(), "{bad:?}");
    }
    // A repeat is dropped, and names are trimmed, as for an agent.
    let kept = planned(&store, &run, &[" sume ", "sume", "higgsfield"]).unwrap();
    assert_eq!(kept.worker_servers, names(&["sume", "higgsfield"]));

    // Only Claude and Codex workers are launched with them.
    let pi = store
        .create_task_with_effort(
            "chat:master",
            run.id.clone(),
            "Pi".into(),
            "Pi work".into(),
            Vec::new(),
            None,
            Some(automation::WorkerSettings {
                agent: ChatAgent::Pi,
                ..claude(Access::Auto)
            }),
            None,
            None,
            None,
            None,
            TaskKind::Work,
            false,
            names(&["sume"]),
        )
        .unwrap_err();
    assert!(pi.contains("Only a Claude or Codex worker"), "{pi}");

    // A run nobody approves a plan of names none: nobody would see them.
    let unplanned = super::tests::run(&store);
    assert_eq!(
        planned(&store, &unplanned, &["sume"]).unwrap_err(),
        SERVERS_NEED_PLAN
    );
    assert!(planned(&store, &unplanned, &[]).is_ok());
}

/// What the person approved is what a start takes, and what the attempt
/// records for its launch. A ledger whose task list drifted from the
/// approval is refused at the one door, by every starter, before anything
/// is reserved.
#[test]
fn an_approval_fixes_the_servers_and_a_start_with_a_drifted_list_is_refused_at_the_door() {
    let store = OrchestrationStore::default();
    let (run, task) = approved_with(&store, &["higgsfield"]);
    assert_eq!(
        task.approved.as_ref().unwrap().worker_servers,
        names(&["higgsfield"])
    );
    store
        .mutate(|data| {
            data.tasks.get_mut(&task.id).unwrap().worker_servers = names(&["higgsfield", "sume"]);
            Ok(())
        })
        .unwrap();
    for by in [StartedBy::Coordinator, StartedBy::Page { retry_of: None }] {
        let refused = store
            .reserve_attempt_for("chat:master", &host_launch(&store, &task.id), by)
            .unwrap_err();
        assert!(
            refused
                .contains("the MCP servers higgsfield, sume instead of the MCP servers higgsfield"),
            "{refused}"
        );
    }
    assert_eq!(attempts_of(&store, &task.id), 0);
    assert_eq!(plan_of(&store, &run.id).status, PlanStatus::Approved);

    store
        .mutate(|data| {
            data.tasks.get_mut(&task.id).unwrap().worker_servers = names(&["higgsfield"]);
            Ok(())
        })
        .unwrap();
    let attempt = start_as_planned(&store, &task.id);
    assert_eq!(attempt.worker_servers, names(&["higgsfield"]));
    assert_eq!(
        store.worker_task_servers(&attempt.worker_chat_key),
        names(&["higgsfield"])
    );
}

/// Changing the list of a task the person approved puts it back on the
/// plan card, as a resize or a reassignment does: nobody starts it
/// meanwhile, approving fixes the new list, rejecting restores the old one.
/// Nothing else of an approved task changes this way.
#[test]
fn other_servers_on_an_approved_task_put_it_back_on_the_plan_card() {
    for approve in [true, false] {
        let store = OrchestrationStore::default();
        let (run, task) = approved_with(&store, &["higgsfield"]);
        // The same list is no change.
        servers_only(&store, "chat:master", &task.id, &["higgsfield"]).unwrap();
        assert_eq!(plan_of(&store, &run.id).status, PlanStatus::Approved);
        assert!(now(&store, &task.id).approved.is_some());
        // With another field on an approved task it is refused whole.
        assert!(store
            .revise_task_with_servers(
                "chat:master",
                &task.id,
                TaskRevision {
                    title: Some("Renamed".into()),
                    ..Default::default()
                },
                Some(names(&["sume"])),
            )
            .is_err());
        assert_eq!(now(&store, &task.id).worker_servers, names(&["higgsfield"]));

        let amended =
            servers_only(&store, "chat:master", &task.id, &["higgsfield", "sume"]).unwrap();
        assert!(amended.approved_at.is_none() && amended.approved.is_none());
        let plan = plan_of(&store, &run.id);
        assert_eq!(plan.status, PlanStatus::Pending);
        assert!(held(&store, &run.id).contains(&task.id));
        assert!(store
            .reserve_attempt("chat:master", &host_launch(&store, &task.id))
            .unwrap_err()
            .contains("has not approved this task yet"));
        assert_eq!(attempts_of(&store, &task.id), 0);
        if approve {
            store
                .approve_plan("chat:master", &run.id, None, Some(plan.revision))
                .unwrap();
            let fixed = now(&store, &task.id);
            assert_eq!(
                fixed.approved.unwrap().worker_servers,
                names(&["higgsfield", "sume"])
            );
            let attempt = start_as_planned(&store, &task.id);
            assert_eq!(attempt.worker_servers, names(&["higgsfield", "sume"]));
        } else {
            store
                .reject_plan_from_card(
                    "chat:master",
                    &run.id,
                    Some(&[task.id.clone()]),
                    Some(plan.revision),
                    None,
                    CardView {
                        surface: "chat".into(),
                        shown_ms: Some(2_000),
                        updated_ms: None,
                    },
                )
                .unwrap();
            let restored = now(&store, &task.id);
            assert_eq!(restored.worker_servers, names(&["higgsfield"]));
            assert_eq!(restored.approved, task.approved);
            let attempt = start_as_planned(&store, &task.id);
            assert_eq!(attempt.worker_servers, names(&["higgsfield"]));
        }
    }
}

/// A worker on the task keeps the servers it was started with, so the
/// list is refused while it works.
#[test]
fn a_task_with_a_worker_on_it_keeps_its_servers() {
    let store = OrchestrationStore::default();
    let (run, task) = approved_with(&store, &["higgsfield"]);
    let working = start_as_planned(&store, &task.id);
    let refused = servers_only(&store, "chat:master", &task.id, &["sume"]).unwrap_err();
    assert!(refused.contains("still on this task"), "{refused}");
    assert_eq!(plan_of(&store, &run.id).status, PlanStatus::Approved);
    finish_attempt(&store, working, WorkerOutcome::Failed);
    // Once it has stopped, the change goes to the person.
    servers_only(&store, "chat:master", &task.id, &["sume"]).unwrap();
    assert_eq!(plan_of(&store, &run.id).status, PlanStatus::Pending);
}

/// The plan's revision moves when only a task's servers change: what the
/// person approves is a new plan.
#[test]
fn a_revision_that_changes_only_the_servers_is_a_new_plan_revision() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    let task = planned(&store, &run, &[]).unwrap();
    let before = plan_of(&store, &run.id).revision;
    servers_only(&store, "chat:master", &task.id, &["sume"]).unwrap();
    let after = plan_of(&store, &run.id).revision;
    assert!(after > before, "{before} -> {after}");
    assert_eq!(now(&store, &task.id).worker_servers, names(&["sume"]));
}

/// A manager's split goes by its parent's approval, servers too: it takes
/// the APPROVED list and may name none of its own.
#[test]
fn a_split_takes_its_parents_approved_servers_and_cannot_widen_them() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    let parent = store
        .create_task_with_effort(
            "chat:master",
            run.id.clone(),
            "Video".into(),
            "Make the video".into(),
            Vec::new(),
            None,
            Some(claude(Access::Auto)),
            Some(TaskAssignee {
                id: "agent_lead".into(),
                name: "Lead".into(),
            }),
            None,
            None,
            None,
            TaskKind::Work,
            false,
            names(&["sume"]),
        )
        .unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    let manager = start_as_planned(&store, &parent.id);
    // What the parent says now is not what was approved.
    store
        .mutate(|data| {
            data.tasks.get_mut(&parent.id).unwrap().worker_servers = names(&["sume", "sentry"]);
            Ok(())
        })
        .unwrap();
    let split = |servers: &[&str]| {
        store.create_task_with_effort(
            &manager.worker_chat_key,
            run.id.clone(),
            "Part".into(),
            "Do the part".into(),
            Vec::new(),
            Some(parent.id.clone()),
            Some(claude(Access::Auto)),
            Some(TaskAssignee {
                id: "agent_dev".into(),
                name: "Dev".into(),
            }),
            None,
            None,
            None,
            TaskKind::Work,
            false,
            names(servers),
        )
    };
    assert_eq!(split(&["higgsfield"]).unwrap_err(), SPLIT_SERVERS);
    let part = split(&[]).unwrap();
    assert_eq!(part.worker_servers, names(&["sume"]));
    assert_eq!(part.approved.unwrap().worker_servers, names(&["sume"]));
    // And its servers are not the coordinator's to change either.
    assert!(servers_only(&store, "chat:master", &part.id, &["higgsfield"]).is_err());
}

/// A peer request's worker gets what its teammate's registration names and
/// nothing a coordinator adds, by either kind of revision.
#[test]
fn a_coordinator_names_no_servers_for_a_peer_request() {
    let store = OrchestrationStore::default();
    let run = run(&store);
    store.require_plan_approval(&run.id).unwrap();
    let task = planned(&store, &run, &[]).unwrap();
    store
        .mutate(|data| {
            data.tasks.get_mut(&task.id).unwrap().peer_request = Some(peer_request::PeerRequest {
                requested_by: TaskAssignee {
                    id: "peer".into(),
                    name: "Peer".into(),
                },
                requester_chat_key: "chat:peer".into(),
                requester_attempt_id: None,
                output: "answer".into(),
                max_minutes: 10,
                requested_at: now_ms(),
            });
            Ok(())
        })
        .unwrap();
    assert_eq!(
        servers_only(&store, "chat:master", &task.id, &["sume"]).unwrap_err(),
        peer_request::PEERS_SERVERS
    );
    let with_title = store
        .revise_task_with_servers(
            "chat:master",
            &task.id,
            TaskRevision {
                title: Some("More".into()),
                ..Default::default()
            },
            Some(names(&["sume"])),
        )
        .unwrap_err();
    assert_eq!(with_title, peer_request::PEERS_SERVERS);
    assert!(now(&store, &task.id).worker_servers.is_empty());
}

/// What a launch adds is read from the chat's own reservation: a task's
/// list changed afterwards, or a later attempt in another chat, changes
/// nothing for it, and a chat whose attempts disagree gets none.
#[test]
fn a_launch_reads_its_reservations_servers_and_unions_them_with_its_agents() {
    let store = OrchestrationStore::default();
    let (_, task) = approved_with(&store, &["sume"]);
    let first = start_as_planned(&store, &task.id);
    let key = first.worker_chat_key.clone();
    assert_eq!(store.worker_task_servers(&key), names(&["sume"]));
    finish_attempt(&store, first.clone(), WorkerOutcome::Failed);
    // The person approves another list; the next attempt is another chat.
    servers_only(&store, "chat:master", &task.id, &["higgsfield"]).unwrap();
    store
        .approve_plan("chat:master", &task.run_id, None, None)
        .unwrap();
    let second = start_as_planned(&store, &task.id);
    assert_eq!(store.worker_task_servers(&key), names(&["sume"]));
    assert_eq!(
        store.worker_task_servers(&second.worker_chat_key),
        names(&["higgsfield"])
    );
    // Any doubt is none: no such worker, a coordinator, attempts that disagree.
    assert!(store.worker_task_servers("chat:orch-unknown").is_empty());
    assert!(store.worker_task_servers("chat:master").is_empty());
    store
        .mutate(|data| {
            data.attempts.get_mut(&second.id).unwrap().worker_chat_key = key.clone();
            Ok(())
        })
        .unwrap();
    assert!(store.worker_task_servers(&key).is_empty());

    // The launch's own decision: the agent's list, then the task's, once
    // each; another provider gets none and says so; a front desk, a lite
    // launch or a chat that is no worker asks for none.
    let agent: crate::team::TeamAgent = serde_json::from_value(serde_json::json!({
        "id": "agent_a", "name": "A", "role": "", "agent": "claude", "model": "opus",
        "access": "auto", "workerServers": ["higgsfield", "sentry"],
        "createdAt": 1, "updatedAt": 1,
    }))
    .unwrap();
    let solo = start_as_planned(
        &store,
        &planned_and_approved(&store, &["sume", "higgsfield"]).id,
    );
    let (asked, note) = crate::agent_chat::worker_launch_servers(
        &store,
        &solo.worker_chat_key,
        ChatAgent::Claude,
        Some(&agent),
        true,
    );
    assert_eq!(asked, names(&["higgsfield", "sentry", "sume"]));
    assert!(note.is_none());
    let (asked, note) = crate::agent_chat::worker_launch_servers(
        &store,
        &solo.worker_chat_key,
        ChatAgent::Pi,
        Some(&agent),
        true,
    );
    assert!(asked.is_empty());
    assert!(note.unwrap().contains("sume, higgsfield"));
    let (asked, _) = crate::agent_chat::worker_launch_servers(
        &store,
        &solo.worker_chat_key,
        ChatAgent::Codex,
        Some(&agent),
        false,
    );
    assert!(asked.is_empty());
}

/// A second run whose plan the person approved with one Codex task naming
/// `servers`.
fn planned_and_approved(store: &OrchestrationStore, servers: &[&str]) -> Task {
    let run = run(store);
    store.require_plan_approval(&run.id).unwrap();
    let task = store
        .create_task_with_effort(
            "chat:master",
            run.id.clone(),
            "Solo".into(),
            "Solo work".into(),
            Vec::new(),
            None,
            Some(automation::WorkerSettings {
                agent: ChatAgent::Codex,
                model: None,
                effort: None,
                access: Access::Auto,
                recovery: None,
            }),
            None,
            None,
            None,
            None,
            TaskKind::Work,
            false,
            names(servers),
        )
        .unwrap();
    store
        .approve_plan("chat:master", &run.id, None, None)
        .unwrap();
    task
}

/// Only the person's own chats name and list servers. A worker is refused
/// by what its chat IS, after its attempt has settled as well as before: it
/// can neither set a task's list nor read which servers there are.
#[test]
fn a_settled_workers_capability_neither_sets_a_tasks_servers_nor_lists_them() {
    let home = crate::test_dir::TestDir::new("worker-servers-worker");
    let _profile = crate::profile::started_in(&home);
    let svc = Services::at_profile();
    let store = svc.orchestrations.clone();
    let run = run(&store);
    let worker = settled_worker(&store, &run, None);
    assert!(store
        .active_task(&worker.worker_chat_key)
        .unwrap()
        .is_none());
    store.require_plan_approval(&run.id).unwrap();
    let task = planned(&store, &run, &[]).unwrap();

    let listed = dispatch(
        &svc,
        "orchestration_worker_servers_available",
        serde_json::json!({ "actorChatKey": worker.worker_chat_key }),
    )
    .unwrap_err();
    assert!(listed.contains("read-only"), "{listed}");

    for (command, args) in [
        (
            "orchestration_task_revise",
            serde_json::json!({ "taskId": task.id, "workerServers": ["sume"] }),
        ),
        (
            "orchestration_task_create",
            serde_json::json!({
                "runId": run.id, "title": "Mine", "spec": "Mine",
                "worker": { "agent": "claude", "access": "auto" },
                "parentTaskId": task.id, "workerServers": ["sume"],
            }),
        ),
    ] {
        let mut args = args;
        args["actorChatKey"] = serde_json::json!(worker.worker_chat_key);
        assert!(dispatch(&svc, command, args).is_err(), "{command}");
    }
    assert!(now(&store, &task.id).worker_servers.is_empty());
    assert_eq!(
        store
            .snapshot(None)
            .unwrap()
            .tasks
            .iter()
            .filter(|t| t.run_id == run.id)
            .count(),
        2,
        "the worker made no task"
    );
}

/// A reopen keeps the approval and changes only the words: one that names
/// servers is refused in words, never silently dropped.
#[test]
fn a_reopen_cannot_change_a_tasks_servers() {
    let home = crate::test_dir::TestDir::new("worker-servers-reopen");
    let _profile = crate::profile::started_in(&home);
    let svc = Services::at_profile();
    for command in [
        "orchestration_task_reopen_in_chat",
        "orchestration_task_reopen",
    ] {
        let refused = dispatch(
            &svc,
            command,
            serde_json::json!({
                "actorChatKey": "chat:master", "taskId": "task_x",
                "spec": "Again", "workerServers": ["sume"],
            }),
        )
        .unwrap_err();
        assert_eq!(refused, REOPEN_SERVERS, "{command}");
    }
}

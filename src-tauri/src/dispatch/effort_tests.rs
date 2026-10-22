//! Assignment contract through the real dispatch door, without CLI launches.
use super::*;
use crate::orchestration::{Run, Task};

fn with_routes(check: impl FnOnce(&Services, &Run, &[crate::team::TeamAgent])) {
    let home = crate::test_dir::TestDir::new("assigned-effort");
    let _profile = crate::profile::started_in(&home);
    let wiring = crate::handover::Wiring::scratch();
    let save =
        |value| crate::team::save(&wiring.team, serde_json::from_value(value).unwrap()).unwrap();
    let lead =
        save(json!({"name":"Lead", "role":"Coordinates", "agent":"codex", "model":"gpt-5.6-sol"}));
    let primary = save(
        json!({"name":"Primary", "role":"Implements", "agent":"codex", "model":"gpt-5.6-sol", "effort":"high", "access":"read", "reportsTo":lead.id}),
    );
    let backup = save(
        json!({"name":"Backup", "role":"Implements", "agent":"claude", "model":"sonnet", "effort":"low", "access":"manual", "reportsTo":lead.id}),
    );
    let gemini = save(
        json!({"name":"Gemini", "role":"Implements", "agent":"antigravity", "model":"gemini-3.8-flash-high", "access":"read", "reportsTo":lead.id}),
    );
    let child = save(
        json!({"name":"Child", "role":"Implements", "agent":"claude", "model":"haiku", "effort":"medium", "access":"read", "reportsTo":primary.id}),
    );
    crate::team::record_lead(&wiring.team, "chat:master", &lead, "workspace", false).unwrap();
    let store = Arc::new(OrchestrationStore::load(home.join("ledger.json")));
    let run = store
        .create_run(
            "chat:master".into(),
            "Test assignments".into(),
            "workspace".into(),
            home.to_string_lossy().into(),
            Some(2),
        )
        .unwrap();
    store.require_plan_approval(&run.id).unwrap();
    let svc = Services {
        orchestrations: store,
        workspaces: Arc::new(WorkspaceState::with_projects(vec![serde_json::from_value(
            json!({"id":"workspace", "name":"Project", "primary_path":home.0, "paths":[]}),
        )
        .unwrap()])),
        chats: Arc::new(ChatManager::default()),
        watch: Arc::new(FileWatchState::default()),
        git_watch: Arc::new(GitWatchState::default()),
        ptys: Arc::new(PtyManager::default()),
        handovers: wiring,
    };
    check(&svc, &run, &[primary, backup, gemini, child]);
}

fn create(
    svc: &Services,
    run: &Run,
    agent: &crate::team::TeamAgent,
    extra: Value,
) -> Result<Task, String> {
    let mut args = json!({"actorChatKey":"chat:master", "runId":run.id, "assignee":agent.id, "title":"Implement", "spec":"Bounded work"});
    args.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(dispatch(svc, "orchestration_task_create", args)?)
        .map_err(|e| e.to_string())
}

fn now(svc: &Services, id: &str) -> Task {
    svc.orchestrations
        .snapshot(None)
        .unwrap()
        .tasks
        .into_iter()
        .find(|t| t.id == id)
        .unwrap()
}

#[test]
fn lead_effort_can_go_above_or_below_default_but_identity_stays_registered() {
    with_routes(|svc, run, agents| {
        let default = create(svc, run, &agents[0], json!({})).unwrap();
        assert_eq!(default.worker.unwrap().effort.as_deref(), Some("high"));
        assert!(!default.effort_chosen);
        for effort in ["low", "max"] {
            let task = create(svc, run, &agents[0], json!({"effort":effort, "worker":{"agent":"invented", "model":{}, "access":"full", "effort":effort, "recovery":{"maxRetries":0}}})).unwrap();
            let worker = task.worker.as_ref().unwrap();
            assert_eq!(worker.agent, ChatAgent::Codex);
            assert_eq!(worker.model.as_deref(), Some("gpt-5.6-sol"));
            assert_eq!(worker.access, Access::Read);
            assert_eq!(worker.effort.as_deref(), Some(effort));
            assert_eq!(worker.recovery.as_ref().unwrap().max_retries, 0);
            assert!(task.effort_chosen);
        }
        let nested = create(svc, run, &agents[0], json!({"worker":{"effort":"medium"}})).unwrap();
        assert_eq!(nested.worker.unwrap().effort.as_deref(), Some("medium"));
        // Registration was not changed by any task choice.
        let saved = crate::team::list(&svc.handovers.team, None, true).unwrap();
        assert_eq!(
            saved
                .iter()
                .find(|a| a.id == agents[0].id)
                .unwrap()
                .effort
                .as_deref(),
            Some("high")
        );
    });
}

#[test]
fn conflicting_or_invalid_efforts_leave_the_ledger_unchanged() {
    with_routes(|svc, run, agents| {
        for extra in [
            json!({"effort":"low", "worker":{"effort":"high"}}),
            json!({"effort":"invented"}),
        ] {
            let refused = create(svc, run, &agents[0], extra).unwrap_err();
            assert!(
                refused.contains("differ") || refused.contains("Valid efforts:"),
                "{refused}"
            );
            assert!(svc.orchestrations.snapshot(None).unwrap().tasks.is_empty());
        }
        for effort in ["max", "low"] {
            let refused = create(svc, run, &agents[2], json!({"effort":effort})).unwrap_err();
            assert!(
                refused.contains("omit") && refused.contains("gemini-3.8-flash-high"),
                "{refused}"
            );
        }
        assert_eq!(
            create(svc, run, &agents[2], json!({"effort":"high"}))
                .unwrap()
                .worker
                .unwrap()
                .effort
                .as_deref(),
            Some("high")
        );
        assert!(create(svc, run, &agents[2], json!({}))
            .unwrap()
            .worker
            .unwrap()
            .effort
            .is_none());
    });
}

#[test]
fn revise_changes_only_effort_and_reassign_retains_explicit_choices_across_reload() {
    with_routes(|svc, run, agents| {
        let task = create(svc, run, &agents[0], json!({})).unwrap();
        let revised = dispatch(
            svc,
            "orchestration_task_revise",
            json!({"actorChatKey":"chat:master", "taskId":task.id, "effort":"medium"}),
        )
        .unwrap();
        assert_eq!(revised["worker"]["effort"], "medium");
        assert_eq!(revised["worker"]["agent"], "codex");
        // An explicit choice equal to the old default is still a choice.
        let explicit = create(svc, run, &agents[0], json!({"effort":"high"})).unwrap();
        let reloaded =
            OrchestrationStore::load(std::path::Path::new(&run.root_path).join("ledger.json"));
        let persisted = reloaded
            .snapshot(None)
            .unwrap()
            .tasks
            .into_iter()
            .find(|t| t.id == explicit.id)
            .unwrap();
        assert!(persisted.effort_chosen);
        let moved = dispatch(svc, "orchestration_task_reassign", json!({"actorChatKey":"chat:master", "taskId":explicit.id, "assignee":agents[1].id, "reason":"Backup takes over"})).unwrap();
        assert_eq!(moved["worker"]["effort"], "high");
        assert_eq!(moved["worker"]["agent"], "claude");
        assert_eq!(moved["worker"]["model"], "sonnet");
        assert_eq!(moved["worker"]["access"], "manual");
        let inherited = create(svc, run, &agents[0], json!({})).unwrap();
        let moved = dispatch(svc, "orchestration_task_reassign", json!({"actorChatKey":"chat:master", "taskId":inherited.id, "assignee":agents[1].id, "reason":"Use backup default"})).unwrap();
        assert_eq!(moved["worker"]["effort"], "low");
        let refused = dispatch(svc, "orchestration_task_reassign", json!({"actorChatKey":"chat:master", "taskId":task.id, "assignee":agents[2].id, "reason":"Cross-provider takeover"})).unwrap_err();
        assert!(refused.contains("Pass a new `effort`"), "{refused}");
        assert_eq!(now(svc, &task.id).assignee.unwrap().id, agents[0].id);
        let matched = dispatch(svc, "orchestration_task_reassign", json!({"actorChatKey":"chat:master", "taskId":task.id, "assignee":agents[2].id, "worker":{"effort":"high"}, "reason":"Match Gemini effort"})).unwrap();
        assert_eq!(matched["worker"]["effort"], "high");
        assert_eq!(matched["worker"]["model"], "gemini-3.8-flash-high");
        let replaced = dispatch(svc, "orchestration_task_reassign", json!({"actorChatKey":"chat:master", "taskId":task.id, "assignee":agents[1].id, "effort":"low", "reason":"Choose backup effort"})).unwrap();
        assert_eq!(replaced["worker"]["effort"], "low");
    });
}

#[test]
fn a_manager_can_choose_effort_when_splitting_its_own_task() {
    with_routes(|svc, run, agents| {
        let parent = create(svc, run, &agents[0], json!({})).unwrap();
        svc.orchestrations
            .approve_plan("chat:master", &run.id, None, None)
            .unwrap();
        let worker = parent.worker.unwrap();
        let (_, _, attempt, _) = svc
            .orchestrations
            .reserve_attempt(
                "chat:master",
                &crate::orchestration::WorkerLaunch {
                    task_id: parent.id.clone(),
                    agent: worker.agent,
                    model: worker.model,
                    effort: worker.effort,
                    access: worker.access,
                    new_worktree: Some(false),
                    base_branch: String::new(),
                },
            )
            .unwrap();
        let attempt = crate::orchestration::tests::activate_reserved(
            &svc.orchestrations,
            &attempt,
            &run.root_path,
        );
        let subtask = create(svc, run, &agents[3], json!({"actorChatKey":attempt.worker_chat_key, "parentTaskId":parent.id, "worker":{"effort":"low"}})).unwrap();
        assert_eq!(
            subtask.worker.as_ref().unwrap().effort.as_deref(),
            Some("low")
        );
        assert_eq!(
            subtask
                .approved
                .as_ref()
                .unwrap()
                .worker
                .as_ref()
                .unwrap()
                .effort
                .as_deref(),
            Some("low")
        );
        assert_eq!(subtask.split_by.as_deref(), Some(attempt.id.as_str()));
    });
}

#[test]
fn approved_effort_is_fixed_until_reassignment_to_a_different_report() {
    with_routes(|svc, run, agents| {
        let task = create(
            svc,
            run,
            &agents[0],
            json!({"effort":"high", "worker":{"recovery":{"maxRetries":0}}}),
        )
        .unwrap();
        svc.orchestrations
            .approve_plan("chat:master", &run.id, None, None)
            .unwrap();
        assert!(dispatch(
            svc,
            "orchestration_task_revise",
            json!({"actorChatKey":"chat:master", "taskId":task.id, "effort":"low"})
        )
        .is_err());
        let same = dispatch(svc, "orchestration_task_reassign", json!({"actorChatKey":"chat:master", "taskId":task.id, "assignee":agents[0].id, "effort":"low", "reason":"Only effort changes"})).unwrap_err();
        assert!(same.contains("already has this task"), "{same}");
        assert!(now(svc, &task.id).approved.is_some());
        let moved = dispatch(svc, "orchestration_task_reassign", json!({"actorChatKey":"chat:master", "taskId":task.id, "assignee":agents[1].id, "worker":{"effort":"low", "access":"full"}, "reason":"Backup takes over"})).unwrap();
        assert!(moved.get("approved").is_none());
        assert_eq!(moved["worker"]["effort"], "low");
        assert_eq!(moved["worker"]["access"], "manual");
        assert_eq!(moved["worker"]["recovery"]["maxRetries"], 0);
        let snapshot = dispatch(svc, "orchestration_snapshot", json!({"runId":run.id})).unwrap();
        assert_eq!(snapshot["tasks"][0]["heldByPlan"], true);
    });
}

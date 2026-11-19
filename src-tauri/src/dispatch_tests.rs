
use super::*;

#[test]
fn forgetting_a_chat_announces_its_cleared_record() {
    let home = crate::test_dir::TestDir::new("dispatch-chat-forget");
    let _process = crate::profile::started_in(&home);
    let services = editing_in(&home);
    let key = format!("chat:forget-{}", uuid::Uuid::new_v4().simple());
    crate::transcript::append(&key, &json!({"type":"result"})).unwrap();
    let tap = crate::bus::tap::Tap::on(&key);
    dispatch(&services, "chat_forget", json!({"key":key})).unwrap();
    assert!(crate::transcript::since(&key, 0).is_empty());
    assert_eq!(
        tap.heard()
            .into_iter()
            .filter(|(event, _)| event == "chat-forgotten")
            .collect::<Vec<_>>(),
        vec![("chat-forgotten".into(), json!({"key":key}))]
    );
}

#[test]
fn a_failed_clear_does_not_announce_a_forgotten_record() {
    let home = crate::test_dir::TestDir::new("dispatch-chat-forget-failed");
    let _process = crate::profile::started_in(&home);
    let services = editing_in(&home);
    let key = format!("chat:forget-failed-{}", uuid::Uuid::new_v4().simple());
    let path = crate::transcript::path_for(&key).unwrap();
    crate::profile::make_dir(&path).unwrap();
    let tap = crate::bus::tap::Tap::on(&key);
    assert!(dispatch(&services, "chat_forget", json!({"key":key})).is_err());
    assert!(tap
        .heard()
        .iter()
        .all(|(event, _)| event != "chat-forgotten"));
}

#[test]
fn record_head_has_the_browser_contract() {
    let home = crate::test_dir::TestDir::new("dispatch-chat-head");
    let _process = crate::profile::started_in(&home);
    let services = editing_in(&home);
    let key = "chat:head";
    crate::transcript::append(key, &json!({"type":"result"})).unwrap();
    let head = dispatch(&services, "chat_record_head", json!({"key":key})).unwrap();
    assert_eq!(head["lastSeq"], 1);
    assert!(head["generation"].is_string());
    assert_eq!(head.as_object().unwrap().len(), 2);
}

#[tokio::test]
async fn team_save_checks_the_edit_version_without_changing_approval_errors() {
    let home = crate::test_dir::TestDir::new("settings-team-version").canonicalized();
    let _profile = crate::profile::started_in(&home);
    // Other team tests override default_path globally; take the same
    // guard so this browser command keeps one store through all saves.
    let _team = crate::team::use_test_path(crate::profile::profile_dir().join("team.json"));
    let svc = Services::load();
    let mut draft = json!({"name":"Papaya", "role":"Lead", "agent":"claude", "model":"sonnet", "access":"full"});
    let original = dispatch(&svc, "team_save", json!({"agent":draft})).unwrap();
    draft["id"] = original["id"].clone();
    let mut remote = draft.clone();
    remote["name"] = json!("Newest remote name");
    remote["access"] = json!("read");
    let newest = dispatch(&svc, "team_save", json!({"agent":remote})).unwrap();
    let error = dispatch(
        &svc,
        "team_save",
        json!({"agent":draft, "expected":original["updatedAt"]}),
    )
    .unwrap_err();
    assert_eq!(error, "Newest remote name was changed somewhere else while you were editing, so nothing was saved. The list now shows the latest; check it and save again.");
    let list = crate::team::list(&crate::team::default_path(), None, true).unwrap();
    assert_eq!(list[0].name, "Newest remote name");
    assert_eq!(list[0].access, Access::Read);
    let approval = crate::team::save_unchanged(
        &crate::team::default_path(),
        serde_json::from_value(draft.clone()).unwrap(),
        original["updatedAt"].as_i64().unwrap(),
    )
    .unwrap_err();
    assert_eq!(approval, "Newest remote name was changed while this waited for approval, so nothing was saved. Read it again and propose the change again.");
    remote["role"] = json!("Updated details");
    let saved = dispatch(
        &svc,
        "team_save",
        json!({"agent":remote, "expected":newest["updatedAt"]}),
    )
    .unwrap();
    assert_eq!(saved["name"], "Newest remote name");
    assert_eq!(saved["access"], "read");
    assert_eq!(saved["role"], "Updated details");
    assert!(saved["updatedAt"].as_i64().unwrap() > newest["updatedAt"].as_i64().unwrap());
}

#[test]
fn argument_names_are_accepted_in_either_spelling() {
    let camel = json!({ "extraDirs": ["/a"] });
    let snake_case = json!({ "extra_dirs": ["/a"] });
    let a: Vec<String> = arg(&camel, "extraDirs").unwrap();
    let b: Vec<String> = arg(&snake_case, "extraDirs").unwrap();
    assert_eq!(a, b);
    assert_eq!(a, vec!["/a".to_string()]);
}

#[tokio::test]
async fn gate_options_omitted_null_and_empty_reach_the_same_host_validation() {
    let svc = Services::load();
    for options in [None, Some(Value::Null), Some(json!([]))] {
        let mut args = json!({"actorChatKey":"chat:gate-options-test", "runId":"no-such-run", "question":"Choose"});
        if let Some(options) = options {
            args["options"] = options;
        }
        let error = dispatch(&svc, "orchestration_gate_create", args).unwrap_err();
        assert!(!error.contains("bad argument"), "{error}");
        assert!(error == "The run does not exist.", "{error}");
    }
    assert!(list_arg::<String>(&json!({"options":"wrong"}), "options").is_err());
}

#[test]
fn a_missing_optional_argument_is_none_not_an_error() {
    let empty = json!({});
    let missing: Option<String> = arg(&empty, "model").unwrap();
    assert!(missing.is_none());
}

/// Feedback ddf843b0 / a43d1a92: a root task created without dependsOn
/// failed with "invalid type: null, expected a sequence".
#[test]
fn an_omitted_optional_list_is_empty_not_an_error() {
    let none: Vec<String> = list_arg(&json!({}), "dependsOn").unwrap();
    assert!(none.is_empty());
    let null: Vec<String> = list_arg(&json!({ "dependsOn": null }), "dependsOn").unwrap();
    assert!(null.is_empty());
    let some: Vec<String> = list_arg(&json!({ "depends_on": ["t1"] }), "dependsOn").unwrap();
    assert_eq!(some, vec!["t1".to_string()]);
    let err = list_arg::<String>(&json!({ "dependsOn": "t1" }), "dependsOn").unwrap_err();
    assert!(err.contains("dependsOn"), "{err}");
}

#[test]
fn a_missing_required_argument_says_which_one() {
    let empty = json!({});
    let err = arg::<String>(&empty, "key").unwrap_err();
    assert!(err.contains("key"), "{err}");
}

#[test]
fn snake_conversion_matches_tauris_own() {
    assert_eq!(snake("extraDirs"), "extra_dirs");
    assert_eq!(snake("dataBase64"), "data_base64");
    assert_eq!(snake("path"), "path");
}

/// The browser can only call what this table lists. Writing the backend
/// function and forgetting this row is the whole failure mode: the code
/// reads as finished, `cargo test` is green, and the client gets "unknown
/// command" for something that is sitting right there.
#[test]
fn a_browser_can_ask_which_agents_are_installed() {
    crate::agents::seed_probe_for_test(vec![("codex".into(), "/opt/bin/codex".into())]);
    let svc = Services::load();
    let out = dispatch(&svc, "agent_installs", json!({})).expect("routed");
    let rows = out.as_array().expect("an array of agents");
    assert_eq!(rows.len(), crate::agent_provider::AgentKind::ALL.len());
    // Every agent is named, installed or not — that IS the answer the page
    // renders, so a missing agent must not be a missing row.
    assert_eq!(rows[0]["id"], "claude");
    assert_eq!(rows[0]["installed"], false);
    assert_eq!(rows[1]["id"], "codex");
    assert_eq!(rows[1]["installed"], true);
    assert_eq!(rows[1]["path"], "/opt/bin/codex");
}

#[test]
fn a_browser_can_ask_for_codex_skills_by_workspace() {
    let svc = Services::load();
    let err = dispatch(&svc, "codex_skills", json!({ "cwd": "relative" })).unwrap_err();
    assert!(
        err.contains("absolute directory"),
        "route reached loader: {err}"
    );
}

#[test]
fn a_browser_can_ask_for_versioned_claude_models() {
    let svc = Services::load();
    let out = dispatch(&svc, "agent_models", json!({ "agent": "claude" })).expect("routed");
    let rows = out["models"].as_array().expect("a model catalog");
    assert!(
        rows.iter().any(|model| model["model"] == "claude-opus-4-6"),
        "the pinned model that motivated discovery is selectable"
    );
}

#[test]
fn a_browser_can_set_a_project_color() {
    let svc = Services::load();
    let err = dispatch(
        &svc,
        "set_workspace_color",
        json!({ "id": "not-a-workspace", "color": "#12ab34" }),
    )
    .expect_err("the route should reach the store even when the id is unknown");
    assert_eq!(err, "workspace not found");
}

/// Same failure mode as the row above, and the one the search on the empty
/// chat page depends on: a phone with no route here shows no history at all.
/// The machine running the test may have no agent sessions on it, so this
/// asserts the SHAPE of the answer rather than anything in it.
#[test]
fn a_browser_can_ask_for_the_agents_own_past_sessions() {
    let svc = Services::load();
    let out = dispatch(&svc, "agent_history_list", json!({ "limit": 5 })).expect("routed");
    let rows = out.as_array().expect("an array of sessions");
    assert!(rows.len() <= 5, "the limit is respected: {}", rows.len());
}

/// Picking a session up into a chat is routed, and refuses a record that
/// is not a chat's before it reads anything.
#[test]
fn a_browser_can_pick_a_past_session_up_into_a_chat() {
    let svc = Services::load();
    let err = dispatch(
        &svc,
        "agent_history_import",
        json!({ "key": "orch:worker", "agent": "claude", "sessionId": "abc" }),
    )
    .expect_err("not a chat");
    assert!(err.contains("not a chat"), "{err}");
}

#[test]
fn a_command_this_backend_does_not_know_is_refused_by_name() {
    let svc = Services::load();
    // This used to be about `pick_folder` and the native dialog it opened,
    // which is a distinction the code stopped making when the window went:
    // there is no desktop app to route anything to, so a command that is
    // not in the table is simply not in the table.
    //
    // The arm is still worth a test, for the reason it exists. The two
    // halves deploy separately, so a page can be newer than the server
    // answering it, and this message is all the user gets when it is — it
    // has to name the command, or "something failed" is the whole report.
    let err = dispatch(&svc, "no_such_command", json!({})).unwrap_err();
    assert!(err.contains("no_such_command"), "{err}");
    assert!(err.contains("not available on this backend"), "{err}");
    // The read-only way out of a refused route is gone with its command:
    // a page that still sends it is told so, and nothing is opened.
    let err = dispatch(&svc, "handover_discuss", json!({ "id": "handover_1" })).unwrap_err();
    assert!(err.contains("'handover_discuss'"), "{err}");
    assert!(err.contains("not available on this backend"), "{err}");
}

/// A chat the index lists, removed again when the test ends.
struct ListedChat {
    id: String,
    key: String,
}

impl ListedChat {
    fn new() -> Self {
        let id = format!("dispatch-complete-{}", uuid::Uuid::new_v4().simple());
        crate::chat_index::upsert(
            serde_json::from_value(json!({ "id": id, "projectId": "p1", "updatedAt": 100 }))
                .unwrap(),
        )
        .unwrap();
        Self {
            key: format!("chat:{id}"),
            id,
        }
    }
}

impl Drop for ListedChat {
    fn drop(&mut self) {
        let _ = crate::chat_index::remove(&self.id);
        crate::transcript::forget(&self.key);
    }
}

#[test]
fn the_chats_that_can_never_be_completed_are_refused_by_what_they_are() {
    use crate::orchestration::tests::{run, running_worker, settled_worker};
    let store = OrchestrationStore::default();
    let run = run(&store);
    let chats = ChatManager::default();
    let dir = crate::test_dir::TestDir::new("complete-refusal");
    let team = dir.0.join("team.json");
    std::fs::write(
            &team,
            r#"{"agents":[],"front_desk_chats":[{"chatKey":"chat:desk","agentId":"a1","sessionIds":[],"createdAt":1}]}"#,
        )
        .unwrap();
    let refusal = |key: &str| completion_refusal_in(&store, &chats, &team, key).unwrap();

    // A worker, in a task or long settled, under a key of either kind.
    let running = running_worker(&store, &run).worker_chat_key;
    let settled = settled_worker(&store, &run, Some("chat:legacy-worker")).worker_chat_key;
    for key in [running.as_str(), settled.as_str(), "chat:orch-never-seen"] {
        assert!(refusal(key).unwrap().contains("worker"), "{key}");
    }
    assert!(refusal("chat:desk").unwrap().contains("front desk"));
    // A second voice: its process names another chat.
    chats.test_seat("chat:room#second", "chat:room");
    assert_eq!(
        refusal("chat:room#second"),
        Some("Only a chat's own agent can be completed.")
    );
    // A chat nothing lists has nothing to tick.
    assert_eq!(
        refusal("chat:no-such-chat"),
        Some("This chat is not in the active chat index.")
    );

    // An ordinary chat, running or not, and the coordinator of a run.
    let chat = ListedChat::new();
    assert_eq!(refusal(&chat.key), None);
    chats.test_launch(&chat.key);
    assert_eq!(refusal(&chat.key), None);
    chats.test_end(&chat.key);
}

#[test]
fn auto_plan_settings_are_person_only_and_refuse_worker_desk_seat_and_unlisted_chats() {
    let svc = Services::load();
    let dir = crate::test_dir::TestDir::new("auto-plan-eligibility");
    let team = dir.0.join("team.json");
    std::fs::write(&team, r#"{"agents":[],"front_desk_chats":[{"chatKey":"chat:desk","agentId":"a1","sessionIds":[],"createdAt":1}]}"#).unwrap();
    svc.chats.test_seat("chat:room#second", "chat:room");
    for (chat, reason) in [
        ("chat:orch-worker", "worker"),
        ("chat:desk", "front desk"),
        ("chat:room#second", "room seat"),
        ("chat:not-listed-auto-plan", "active chat index"),
    ] {
        let error =
            require_auto_plan_chat(&svc.orchestrations, &svc.chats, &team, chat).unwrap_err();
        assert!(error.contains(reason), "{error}");
        assert!(!svc.orchestrations.auto_plan_get(chat).unwrap().enabled);
    }
    let chat = ListedChat::new();
    assert!(require_auto_plan_chat(&svc.orchestrations, &svc.chats, &team, &chat.key).is_ok());
    let call = |enabled| {
        dispatch(
            &svc,
            "orchestration_auto_plan_set",
            json!({"chatKey":chat.key,"enabled":enabled}),
        )
        .unwrap()
    };
    let on = call(true);
    assert_eq!(on["chatKey"], chat.key);
    assert_eq!(on["enabled"], true);
    assert!(on["enabledAt"].is_i64());
    assert_eq!(on["includeFull"], false);
    assert!(on.get("includeFullAt").is_none());
    assert_eq!(
        dispatch(
            &svc,
            "orchestration_auto_plan_get",
            json!({"chatKey":chat.key})
        )
        .unwrap(),
        on
    );
    let full = dispatch(
        &svc,
        "orchestration_auto_plan_set",
        json!({"chatKey":chat.key,"enabled":true,"includeFull":true}),
    )
    .unwrap();
    assert_eq!(full["includeFull"], true);
    assert!(full["includeFullAt"].is_i64());
    assert_eq!(
        call(true),
        full,
        "omitting includeFull retains its scope and timestamp"
    );
    let off = call(false);
    assert_eq!(off["enabled"], false);
    assert_eq!(off["includeFull"], false);
    assert!(off.get("enabledAt").is_none());
    assert!(off.get("includeFullAt").is_none());
    assert!(dispatch(
        &svc,
        "orchestration_auto_plan_set",
        json!({"chatKey":"chat:not-listed-auto-plan","enabled":true,"includeFull":true})
    )
    .is_err());
    // Revocation needs no launch or active index membership.
    assert!(dispatch(
        &svc,
        "orchestration_auto_plan_set",
        json!({"chatKey":"chat:not-listed-auto-plan","enabled":false})
    )
    .is_ok());
    assert!(dispatch(
        &svc,
        "orchestration_auto_plan_set",
        json!({"chatKey":chat.key,"enabled":false,"includeFull":true})
    )
    .unwrap_err()
    .contains("Enable automatic"));
    let worker = dispatch(
        &svc,
        "orchestration_auto_plan_set",
        json!({"chatKey":"chat:orch-worker","enabled":true,"includeFull":true}),
    )
    .unwrap_err();
    assert!(worker.contains("worker"));
}

#[test]
fn auto_plan_full_revocation_through_the_socket_acts_when_the_profile_index_is_away() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let svc = Services::at_profile();
    let chat = ListedChat::new();
    let set = |enabled, include_full: Option<bool>| {
        dispatch(
            &svc,
            "orchestration_auto_plan_set",
            json!({
                "chatKey":chat.key, "enabled":enabled, "includeFull":include_full,
            }),
        )
    };
    assert_eq!(set(true, Some(true)).unwrap()["includeFull"], true);
    home.unplug();
    let (answer, unsaved) = crate::unsaved::told(|| set(true, Some(false)));
    let answer = answer.unwrap();
    assert_eq!(answer["enabled"], true);
    assert_eq!(answer["includeFull"], false);
    assert!(answer.get("includeFullAt").is_none());
    assert_eq!(unsaved.len(), 1);
    assert!(unsaved[0].what.contains("Full access"));
    assert!(svc.orchestrations.owes());
    assert!(
        set(true, Some(true)).is_err(),
        "widening still needs the index and its record"
    );
    assert!(
        !svc.orchestrations
            .auto_plan_get(&chat.key)
            .unwrap()
            .include_full
    );
    assert_eq!(set(false, None).unwrap()["enabled"], false);
    assert!(
        set(true, Some(false)).is_err(),
        "an absent consent cannot use the revocation exception to enable"
    );
    assert!(!svc.orchestrations.auto_plan_get(&chat.key).unwrap().enabled);
    home.plug_back();
    assert!(svc.orchestrations.settle_owed().unwrap());
    let restarted =
        OrchestrationStore::load(crate::profile::profile_dir().join("orchestrations.json"));
    assert!(!restarted.auto_plan_get(&chat.key).unwrap().enabled);
}

#[test]
fn completing_a_chat_is_routed_refused_and_queued_through_dispatch() {
    let svc = Services::load();
    let refused = dispatch(
        &svc,
        "chat_complete",
        json!({ "chatKey": "chat:orch-some-worker" }),
    )
    .unwrap_err();
    assert!(refused.contains("worker"), "{refused}");

    // No process and nothing to start one with: the page asks again
    // with `start`, and nothing was left completing.
    let chat = ListedChat::new();
    let idle = dispatch(&svc, "chat_complete", json!({ "chatKey": chat.key })).unwrap_err();
    assert_eq!(idle, format!("chat '{}' is not running", chat.key));
    assert_eq!(svc.chats.completing_turn(&chat.key), None);

    // A start that cannot happen leaves it not completing either.
    let failed = dispatch(
        &svc,
        "chat_complete",
        json!({ "chatKey": chat.key, "start": { "agent": "claude" } }),
    )
    .unwrap_err();
    assert!(failed.contains("cwd"), "{failed}");
    assert_eq!(svc.chats.completing_turn(&chat.key), None);

    // A running chat: the wrap-up waits behind the turn in flight.
    svc.chats.test_launch(&chat.key);
    svc.chats.test_busy(&chat.key, true);
    let out = dispatch(&svc, "chat_complete", json!({ "chatKey": chat.key })).unwrap();
    assert_eq!(out["state"], "queued");
    let turn_id = out["turnId"].as_str().unwrap().to_string();
    assert!(turn_id.starts_with(crate::agent_chat::COMPLETION_TURN_PREFIX));
    assert_eq!(svc.chats.completing_turn(&chat.key), Some(turn_id.clone()));
    // It is the host's wording that was queued, not anything the page sent.
    let recorded = crate::transcript::since(&chat.key, 0);
    assert_eq!(
        recorded[0].event["message"]["content"][0]["text"],
        crate::agent_chat::wrap_up_message(false, &[])
    );
    let again = dispatch(&svc, "chat_complete", json!({ "chatKey": chat.key })).unwrap_err();
    assert_eq!(again, "This chat is already completing.");

    let preview = dispatch(
        &svc,
        "chat_complete_preview",
        json!({ "chatKey": chat.key }),
    )
    .unwrap();
    assert_eq!(preview["chatKey"], chat.key.as_str());
    assert_eq!(preview["completingTurnId"], turn_id.as_str());
    assert_eq!(preview["running"], true);
    assert_eq!(preview["registeredAgent"], false);
    assert_eq!(preview["runs"], json!([]));
    assert!(preview.get("refusal").is_none(), "{preview}");

    // The ✕ on the queued wrap-up, through the page's own command.
    assert_eq!(
        dispatch(
            &svc,
            "chat_cancel_queued",
            json!({ "key": chat.key, "turnId": turn_id }),
        ),
        Ok(json!(true))
    );
    assert_eq!(svc.chats.completing_turn(&chat.key), None);
    svc.chats.test_end(&chat.key);

    let worker = dispatch(
        &svc,
        "chat_complete_preview",
        json!({ "chatKey": "chat:orch-some-worker" }),
    )
    .unwrap();
    assert!(worker["refusal"].as_str().unwrap().contains("worker"));
}

/// Completing a chat is the person's own action, like closing a mission.
/// No hook may call it and the MCP server offers no such tool.
#[test]
fn no_hook_and_no_mcp_tool_can_complete_a_chat() {
    for (name, source) in [
        ("web.rs", include_str!("web.rs")),
        (
            "octiq-ask.cjs",
            include_str!("../../scripts/mcp/octiq-ask.cjs"),
        ),
    ] {
        assert!(!source.contains("chat_complete"), "{name}");
    }
}

/// The services of a server whose one project is the folder `root`, so
/// the page's file editor may save inside it.
fn editing_in(root: &std::path::Path) -> Services {
    let project = serde_json::from_value(json!({
        "id": "project", "name": "Project", "primary_path": root,
    }))
    .unwrap();
    Services {
        workspaces: Arc::new(WorkspaceState::with_projects(vec![project])),
        chats: Arc::new(ChatManager::default()),
        watch: Arc::new(FileWatchState::default()),
        git_watch: Arc::new(GitWatchState::default()),
        orchestrations: Arc::new(OrchestrationStore::default()),
        ptys: Arc::new(PtyManager::default()),
        handovers: crate::handover::Wiring::scratch(),
    }
}

fn editor_saves(services: &Services, path: &std::path::Path, text: &str) -> Result<(), String> {
    dispatch(
        services,
        "write_file",
        json!({ "path": path, "content": text }),
    )
    .map(|_| ())
}

/// Review of bf9d8cd, finding 4, through the door the page's Save uses:
/// `write_file` wrote over a chat's record with a bare `fs::write`,
/// behind the record's own functions, so a notice the host held a
/// receipt for was gone and the record's generation had not moved. The
/// home folder is a write root and holds the profile, so every install
/// could; here a project that holds the profile stands for it.
#[test]
fn the_file_editor_does_not_write_over_a_chat_record() {
    let home = crate::test_dir::TestDir::new("editor-record").canonicalized();
    let _process = crate::profile::started_in(&home);
    let key = format!("chat:editor-{}", uuid::Uuid::new_v4().simple());
    let notice = json!({ "type": "octiq_task_reopened", "taskId": "task_1" });
    assert!(crate::transcript::append_synced(&key, &notice).is_some());
    let record = crate::transcript::path_for(&key).unwrap();
    let before = std::fs::read(&record).unwrap();

    let services = editing_in(&home);
    let refused = editor_saves(&services, &record, "{\"type\":\"assistant\"}\n");
    assert_eq!(
        std::fs::read(&record).unwrap(),
        before,
        "the editor wrote over a chat's record"
    );
    let why = refused.unwrap_err();
    assert!(why.contains("OctiqFlow keeps"), "{why}");

    // Reading it is as before.
    let shown = dispatch(&services, "read_file_preview", json!({ "path": record })).unwrap();
    assert!(shown["content"]
        .as_str()
        .unwrap()
        .contains("octiq_task_reopened"));
}

/// A message is not sent, and no chat started, while the profile folder
/// is away: the turn's record could not be kept. The page shows the
/// answer under the message, and reads the same from `profile_status`.
#[test]
fn a_message_is_refused_in_words_while_the_profile_folder_is_away() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _process = crate::profile::started_in(&home.dir);
    let services = editing_in(&home.dir);
    let dir = crate::profile::profile_dir();
    home.unplug();
    let why = dispatch(
        &services,
        "chat_send",
        json!({ "key": "chat:away", "text": "Hello" }),
    )
    .unwrap_err();
    assert!(why.contains(&dir.display().to_string()), "{why}");
    assert!(why.contains("nothing was saved"), "{why}");
    let status = dispatch(&services, "profile_status", json!({})).unwrap();
    assert_eq!(status["available"], false);
    assert_eq!(status["notice"], why);
    assert_eq!(status["dir"], json!(dir));
}

/// Review of 8169dd3, RULE 3, through the doors the page reads by: a
/// read from a profile that is gone is an error carrying the profile's
/// one sentence, never what a first run would answer. An empty answer
/// drew a blank form the person could save over their own data. Gone
/// three ways: its drive, the folder itself, another folder in its
/// place. Every one answers again, unchanged, once the folder is back.
#[test]
fn what_the_page_reads_is_an_error_while_the_profile_folder_is_gone() {
    use crate::profile::tests::Home;
    let home = Home::with_a_configured_base();
    let _process = crate::profile::started_in(&home.dir);
    let dir = crate::profile::profile_dir();
    crate::profile_lock::acquire("server").unwrap();
    // The roster's path is one global in tests: hold it at the profile's.
    let _roster = crate::team::use_test_path(dir.join("team.json"));
    let services = Services {
        handovers: crate::handover::Wiring::profile(),
        ..editing_in(&home.dir)
    };
    crate::personal_preferences::save(&crate::personal_preferences::default_path(), "my rules")
        .unwrap();
    let key = format!("chat:read-{}", uuid::Uuid::new_v4().simple());
    let said = json!({ "type": "assistant", "message": { "content": "Said" } });
    assert_eq!(crate::transcript::append(&key, &said), Some(1));
    let reads = [
        ("personal_preferences", json!({})),
        ("memory_vault_settings", json!({})),
        ("team_list", json!({ "all": true })),
        ("team_policy", json!({})),
        ("team_head", json!({})),
        ("team_home", json!({})),
        ("team_front_desk", json!({})),
        ("team_leads", json!({})),
        ("agent_team_list", json!({})),
        ("handover_list", json!({})),
        ("front_desk_unfinished", json!({})),
        (
            "feedback_list",
            json!({ "query": "", "offset": 0, "limit": 30 }),
        ),
        ("chat_index_list", json!({})),
        ("chat_index_deleted", json!({})),
        ("chat_since", json!({ "key": key, "after": 0 })),
        ("chat_page", json!({ "key": key })),
        ("chat_task", json!({ "chatId": "read" })),
        ("chat_record_head", json!({ "key": key })),
    ];
    let answers = |when: &str| -> Vec<Value> {
        reads
            .iter()
            .map(|(command, args)| {
                dispatch(&services, command, args.clone())
                    .unwrap_or_else(|why| panic!("{command} {when}: {why}"))
            })
            .collect()
    };
    let at_first = answers("with the profile there");
    assert_eq!(at_first[0]["text"], "my rules");

    type Way = (fn(&Home), fn(&Home));
    let ways: [Way; 3] = [
        (Home::unplug, Home::plug_back),
        (Home::move_away, Home::move_back),
        (Home::replace, Home::move_back),
    ];
    for (goes, comes_back) in ways {
        goes(&home);
        let why = crate::profile::available().expect_err("the profile folder is not there");
        let mut answered = Vec::new();
        for (command, args) in &reads {
            match dispatch(&services, command, args.clone()) {
                Err(said) if said == why => {}
                other => answered.push(format!("{command}: {other:?}")),
            }
        }
        assert!(
            answered.is_empty(),
            "read as something other than the profile's own error:\n{}",
            answered.join("\n")
        );
        comes_back(&home);
        // What does not depend on the clock answers exactly as before.
        let again = answers("with the profile back");
        for at in [0, 1, 2, 3, 9, 15, 16] {
            assert_eq!(again[at], at_first[at], "{}", reads[at].0);
        }
    }
}

/// `chat_turn_delivery` is a read the page makes: with the profile gone
/// it answers the profile's sentence, never "absent" for every turn, and
/// it answers again unchanged once the folder is back.
#[test]
fn a_turn_delivery_read_is_an_error_while_the_profile_folder_is_gone() {
    use crate::profile::tests::Home;
    let home = Home::with_a_configured_base();
    let _process = crate::profile::started_in(&home.dir);
    crate::profile_lock::acquire("server").unwrap();
    let services = editing_in(&home.dir);
    let row = serde_json::from_value(
        json!({"id": "td-away", "projectId": "p", "title": "T", "updatedAt": 1}),
    )
    .unwrap();
    crate::chat_index::upsert(row).unwrap();
    crate::transcript::append(
        "chat:td-away",
        &json!({"type": "user", "isReplay": true, "octiq_user_turn_id": "t"}),
    );
    let call = || {
        dispatch(
            &services,
            "chat_turn_delivery",
            json!({"chatKey": "chat:td-away", "turnIds": ["t", "u"]}),
        )
    };
    let there = call().unwrap();
    assert_eq!(there["turns"]["t"]["state"], "accepted");
    assert_eq!(there["turns"]["u"]["state"], "absent");
    type Way = (fn(&Home), fn(&Home));
    let ways: [Way; 3] = [
        (Home::unplug, Home::plug_back),
        (Home::move_away, Home::move_back),
        (Home::replace, Home::move_back),
    ];
    for (goes, comes_back) in ways {
        goes(&home);
        let why = crate::profile::available().expect_err("the profile folder is not there");
        assert_eq!(call().unwrap_err(), why);
        comes_back(&home);
        assert_eq!(call().unwrap(), there);
    }
}

/// The rule is the folder, not a list of names: everything in the
/// profile folder is some module's state (the roster, the ledger, the
/// server's token, the chat index), a file not made yet included. What
/// the person keeps there by hand stays theirs to edit.
#[test]
fn the_file_editor_writes_nothing_a_store_owns_in_the_profile_folder() {
    let home = crate::test_dir::TestDir::new("editor-profile").canonicalized();
    let _process = crate::profile::started_in(&home);
    let profile = crate::profile::profile_dir();
    let services = editing_in(&home);
    std::fs::create_dir_all(profile.join("chats")).unwrap();
    for owned in [
        "team.json",
        "orchestrations.json",
        "web.json",
        "workspaces.json",
        "safety-authorizations.json",
        "owner.lock",
        "chats/index.json",
        "chats/questions.json",
        "chats/chat_never-made.jsonl",
    ] {
        let target = profile.join(owned);
        // The owner lock is there already: the server left its mark.
        let before = std::fs::read(&target).ok();
        assert_eq!(before.is_some(), owned == "owner.lock", "{owned}");
        let refused = editor_saves(&services, &target, "{}");
        assert_eq!(std::fs::read(&target).ok(), before, "{owned} was written");
        assert!(refused.unwrap_err().contains("OctiqFlow keeps"), "{owned}");
    }

    // The person's own: their notify hook and what is on a canvas.
    std::fs::create_dir_all(profile.join("canvas").join("project")).unwrap();
    for theirs in ["notify-hook", "canvas/project/plan.md"] {
        let target = profile.join(theirs);
        assert_eq!(editor_saves(&services, &target, "mine"), Ok(()), "{theirs}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "mine");
    }
    // And a project file is written as it always was.
    let note = home.join("notes.md");
    assert_eq!(editor_saves(&services, &note, "a note"), Ok(()));
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "a note");
}

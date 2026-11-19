use super::*;
use crate::agent_provider::{
    test_image_media_type as image_media_type, test_sh_quote as sh_quote,
    test_toml_string as toml_string,
};

/// Every production source file of this module, agent_chat.rs first:
/// `(file name, text)` with LF line ends. Test files and the test-only
/// helper files are left out; the production children agent_chat.rs declares
/// with `#[path]` (they live directly in `src/`) are read too. Each file is
/// cut at its own inline `#[cfg(test)] mod tests {` when it has one.
pub(super) fn production_sources() -> Vec<(String, String)> {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![("agent_chat.rs".to_string(), src.join("agent_chat.rs"))];
    let mut children: Vec<_> = std::fs::read_dir(src.join("agent_chat"))
        .map(|dir| {
            dir.filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
                .collect()
        })
        .unwrap_or_default();
    children.sort();
    for path in children {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if name.ends_with("tests.rs") || name == "test_support.rs" || name == "stand_in.rs" {
            continue;
        }
        files.push((name, path));
    }
    for name in [
        "claude_session_recovery.rs",
        "provider_switch.rs",
        "registered_runtime.rs",
        "codex_elicitation.rs",
    ] {
        files.push((name.to_string(), src.join(name)));
    }
    files
        .into_iter()
        .map(|(name, path)| {
            let text = std::fs::read_to_string(&path)
                .unwrap()
                .replace("\r\n", "\n");
            let text = match text.find("\n#[cfg(test)]\nmod tests {") {
                Some(at) => text[..at].to_string(),
                None => text,
            };
            (name, text)
        })
        .collect()
}

pub(super) fn production_source() -> String {
    production_sources()
        .into_iter()
        .map(|(_, text)| text)
        .collect()
}

#[test]
fn index_change_carries_only_the_canonical_visible_entry_and_tombstone() {
    let home = crate::test_dir::TestDir::new("index-event");
    let _profile = crate::profile::started_in(&home);
    let id = "index-event-chat";
    let tap = crate::bus::tap::Tap::on(id);
    let row =
        serde_json::from_value(json!({"id":id,"projectId":"p","title":"Saved","updatedAt":4}))
            .unwrap();
    crate::chat_index::upsert(row).unwrap();
    announce_index_change(id, false);
    let event = tap.heard().last().unwrap().1.clone();
    assert_eq!(event["entry"]["title"], "Saved");
    assert_eq!(event["id"], id);
    assert!(event.get("entries").is_none());
    crate::chat_index::trash(id, Some(0), None).unwrap();
    announce_index_change(id, true);
    let event = tap.heard().last().unwrap().1.clone();
    assert!(event["entry"].is_null());
    assert_eq!(event["deleted"]["id"], id);
    let restored = crate::chat_index::restore(id).unwrap().unwrap();
    announce_index_change(id, false);
    assert_eq!(
        tap.heard().last().unwrap().1["entry"]["generation"],
        restored.generation
    );
}

const CONVERSATION_URL: &str =
    "https://optiqflow.app/#/p/workspace/c/1a735592-37d3-40ed-a0d4-c49665cbacaf";

/// Whether a launch is a front desk is decided in ONE place: `start_session`
/// asks `team::is_front_desk_chat` by the chat's own key, and that answer
/// alone sets the access, the tools, the provider's front-desk flags and
/// `OCTIQ_FRONT_DESK`. First start, resume, restart recovery, a queued Codex
/// turn, a notification, a scheduled resume and a handover's origin all
/// come through it, so each carries the marker, and an ordinary chat is
/// handed an empty one whatever the server inherited. This pins that
/// shape: a second spawn site, a second command builder, or a process
/// whose key is not its chat's would each be a launch path that skips it.
#[test]
fn every_agent_launch_decides_front_desk_by_the_chat_key_in_one_place() {
    let source = production_source();
    let production = source.as_str();
    assert_eq!(production.matches("provider.build_command(").count(), 1);
    assert_eq!(
        production
            .matches(".env(\"OCTIQ_FRONT_DESK\", if front_desk { \"1\" } else { \"\" })")
            .count(),
        1
    );
    assert_eq!(
        production
            .matches("crate::team::is_front_desk_chat(&crate::team::default_path(), &key)")
            .count(),
        1
    );
    // The agent itself is started once, in `start_session`.
    assert_eq!(
        production
            .matches(".command(&format!(\"exec {line}\"))")
            .count(),
        1
    );
    let calls: Vec<&str> = production
        .match_indices("start_session(")
        .map(|(at, _)| &production[at..])
        .filter(|rest| !production[..production.len() - rest.len()].ends_with("fn "))
        .collect();
    assert!(calls.len() >= 6, "{} launch sites", calls.len());
    for call in calls {
        let args = &call[..call.find(')').unwrap() + 1];
        let voice = call["start_session(".len()..].trim_start();
        assert!(
            voice.starts_with("manager") || voice.starts_with("manager.clone()"),
            "{args}"
        );
        let after_manager = voice[voice.find(',').unwrap() + 1..].trim_start();
        assert!(
            after_manager.starts_with("Voice::host("),
            "a launch whose process key is not its chat's: {}",
            &after_manager[..after_manager.len().min(60)]
        );
    }
}

/// Feedback 56dd3f24: a refusal names the exact call it refused, from the
/// assistant message that made it. The card is a record and a decision;
/// nothing about it lets the call run.
#[test]
fn a_claude_refusal_card_names_the_call_it_refused() {
    let key = format!("chat:refusal-{}", uuid::Uuid::new_v4());
    let line = "npm publish --tag next";
    let denial = json!({"type":"system","subtype":"permission_denied","decision_reason":"[Publish]",
            "decision_reason_type":"classifier","tool_name":"Bash","tool_use_id":"toolu_pub","message":"denied"});
    let mut calls = HashMap::new();
    let call = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"Publishing."},
            {"type":"tool_use","id":"toolu_pub","name":"Bash","input":{"command": line}}]}});
    note_claude_calls(&call, &mut calls);
    let (name, input) = calls.get("toolu_pub").unwrap();
    assert!(crate::safety_block::observe_claude_denial(
        &key,
        None,
        &denial,
        Some((name, input))
    ));
    let card = crate::safety_block::pending()
        .into_iter()
        .find(|b| b.chat_key() == key)
        .unwrap();
    assert_eq!(card.action(), Some(line));
    crate::safety_block::forget_chat(&key);
}

/// Feedback 467a6314: the orchestration scheduler starts workers from a
/// plain thread, where `Handle::try_current` finds nothing, and every
/// permission such a worker asked for was denied with "OctiqFlow could not
/// ask anyone". A chat started there must still find a runtime.
#[test]
fn a_chat_started_off_the_runtime_can_still_ask_the_person() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    remember_runtime(runtime.handle().clone());
    let found = std::thread::spawn(|| {
        assert!(tokio::runtime::Handle::try_current().is_err());
        answer_runtime().is_some()
    })
    .join()
    .unwrap();
    assert!(found, "a scheduler-started chat has a runtime to wait on");
}

#[test]
fn a_model_handoff_keeps_history_separate_from_the_new_user_message() {
    let history = r#"[{"role":"user","text":"Use Opus 4.6"}]"#;
    let prompt = model_handoff_prompt(history, "Now compare it to GPT.\nDo not lose this line.");
    assert!(prompt.contains(history));
    assert!(prompt.contains(
        r#"Current user message (JSON string):
"Now compare it to GPT.\nDo not lose this line.""#
    ));
    assert_eq!(prompt.matches("Use Opus 4.6").count(), 1);
}

#[test]
fn sends_during_a_process_handoff_remain_cancellable_and_durable() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("queue-handoff-{}", uuid::Uuid::new_v4());
    manager.handoffs.lock().unwrap().insert(key.clone());
    chat_send_user_impl(
        manager.clone(),
        key.clone(),
        "arrived during replacement".into(),
        Some(vec!["/tmp/image.png".into()]),
        None,
        Some("follow-up".into()),
        None,
    )
    .unwrap();
    let snapshot = chat_queue_state_impl(&manager, &key).unwrap();
    assert!(snapshot.live);
    assert_eq!(snapshot.queued_turn_ids, ["follow-up"]);
    let events = crate::transcript::since(&key, 0);
    assert_eq!(
        events[0].event["octiq_attachments"][0]["path"],
        "/tmp/image.png"
    );
    assert_eq!(events[1].event["state"], "queued");
    assert_eq!(
        chat_cancel_queued_impl(&manager, key.clone(), "follow-up".into()),
        Ok(true)
    );
    crate::transcript::forget(&key);
}

#[test]
fn a_failed_queue_handoff_records_failure_for_every_waiting_message() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("queue-failed-{}", uuid::Uuid::new_v4());
    manager.handoffs.lock().unwrap().insert(key.clone());
    for id in ["one", "two"] {
        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            id.into(),
            None,
            None,
            Some(id.into()),
            None,
        )
        .unwrap();
    }
    let next = manager.take_queued_turn(&key).unwrap();
    assert!(start_queued_command_turn(manager.clone(), &key, &key, next).is_err());
    let failed: Vec<_> = crate::transcript::since(&key, 0)
        .into_iter()
        .filter(|event| event.event["state"] == "failed")
        .map(|event| event.event["uuid"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(failed, ["one", "two"]);
    assert!(!chat_queue_state_impl(&manager, &key).unwrap().live);
    assert!(!manager.has_queued_turns(&key));
    crate::transcript::forget(&key);
}

#[test]
fn claude_echoes_use_the_dispatched_id_without_claiming_tool_results() {
    let mut echo =
        json!({"type":"user", "message":{"content":[{"type":"text", "text":"same words"}]}});
    stamp_user_turn_id(&mut echo, ChatAgent::Claude, Some("exact-turn"));
    assert_eq!(echo["octiq_user_turn_id"], "exact-turn");
    let mut result =
        json!({"type":"user", "message":{"content":[{"type":"tool_result", "content":"done"}]}});
    stamp_user_turn_id(&mut result, ChatAgent::Claude, Some("exact-turn"));
    assert!(result.get("octiq_user_turn_id").is_none());
}

#[test]
fn queue_state_reports_only_the_requested_chat_queue() {
    let manager = ChatManager::default();
    for (key, id) in [("chat-check", "host"), ("chat-other", "other")] {
        manager
            .queue_turn(
                key,
                QueuedTurn {
                    text: "waiting".into(),
                    images: vec![],
                    turn_id: Some(id.into()),
                    appended_turn_ids: vec![],
                    recorded: true,
                    context: None,
                },
            )
            .unwrap();
    }
    let mut snapshot = chat_queue_state_impl(&manager, "chat-check").unwrap();
    snapshot.queued_turn_ids.sort();
    assert!(!snapshot.live);
    assert_eq!(snapshot.queued_turn_ids, ["host"]);
    let empty = chat_queue_state_impl(&ChatManager::default(), "chat-check").unwrap();
    assert!(!empty.live);
    assert!(empty.queued_turn_ids.is_empty());
}

#[test]
fn continue_conversation_routes_mcp_agents_to_the_reader_first() {
    let original = format!("continue {CONVERSATION_URL}");

    let routed = routed_prompt(ChatAgent::Codex, &original);
    assert!(routed.contains("MUST call `mcp__octiq__read_conversation`"));
    assert!(routed.contains(CONVERSATION_URL));
    assert!(routed.contains("Do not open this URL in Browser"));

    let turn = crate::codex_app_server::turn_request(crate::codex_app_server::TurnRequest {
        id: "request-1",
        thread_id: "thread-1",
        text: &routed,
        images: &[],
        client_user_message_id: Some("user-1"),
        cwd: "/work",
        workspace_roots: &["/work".into()],
        model: None,
        effort: None,
        access: Some(Access::Auto),
        runtime_context: "runtime",
    });
    let sent = turn["params"]["input"][0]["text"].as_str().unwrap();
    assert!(sent.contains("mcp__octiq__read_conversation"));
    assert!(sent.contains("Do not open this URL in Browser"));
}

#[test]
fn continuation_routing_is_narrow_and_leaves_other_prompts_untouched() {
    let bare_link = format!("please review {CONVERSATION_URL}");
    assert!(matches!(
        routed_prompt(ChatAgent::Codex, &bare_link),
        Cow::Borrowed(_)
    ));
    assert!(matches!(
        routed_prompt(ChatAgent::Codex, "continue the implementation"),
        Cow::Borrowed(_)
    ));
    assert!(matches!(
        routed_prompt(ChatAgent::Claude, &format!("continue {CONVERSATION_URL}")),
        Cow::Borrowed(_)
    ));
    assert!(matches!(
        routed_prompt(ChatAgent::Pi, &format!("continue {CONVERSATION_URL}")),
        Cow::Borrowed(_)
    ));
}

#[test]
fn codex_prompt_event_keeps_text_and_attachments() {
    let event = durable_user_event("user-1", "look at this", &["/tmp/screenshot.png".into()]);

    assert_eq!(event["type"], "user");
    assert_eq!(event["uuid"], "user-1");
    assert_eq!(event["octiq_user_turn"], true);
    assert_eq!(event["message"]["content"][0]["text"], "look at this");
    assert_eq!(event["octiq_attachments"][0]["path"], "/tmp/screenshot.png");
}

#[test]
fn a_refused_duplicate_start_cannot_poison_a_coordinators_resume_checkout() {
    use crate::orchestration::tests::run;
    let home = crate::test_dir::TestDir::new("notification-drift");
    let _profile = crate::profile::started_in(&home);
    let manager = Arc::new(ChatManager::default());
    let run = run(&manager.orchestrations);
    let key = run.coordinator_chat_key.clone();
    let original = StartContext::for_test(ChatAgent::Claude, Some("live-session"));
    manager.remember_start(&key, original.clone());
    hold(&manager, &key, claude_session(false));
    let drifted = home.join("worker-checkout").to_string_lossy().into_owned();
    let refused = chat_start_with_user_turn(
        manager.clone(),
        key.clone(),
        drifted,
        ChatAgent::Claude,
        None,
        Some(Access::Read),
        Some("user turn".into()),
        None,
        Some("live-session".into()),
        None,
        None,
        None,
        None,
        None,
        None,
    );
    assert_eq!(refused, Err(format!("chat '{key}' is already running")));
    assert_eq!(manager.start_context(&key).unwrap().cwd, original.cwd);
    assert_eq!(
        manager
            .orchestrations
            .saved_resume_context(&key)
            .unwrap()
            .cwd,
        original.cwd
    );
    end_process(&manager, &key).unwrap();
}

/// The opt-in is the registered agent's, read at launch through the
/// ledger's assignee; every doubt is "no".
#[test]
fn a_worker_keeps_desktop_tools_only_when_its_registered_codex_agent_has_them_on() {
    use crate::orchestration::tests::{run, running_worker, running_worker_of};
    use crate::orchestration::TaskAssignee;
    let home = crate::test_dir::TestDir::new("worker-desktop-optin");
    let _profile = crate::profile::started_in(&home);
    let roster = home.join("team.json");
    let _team = crate::team::use_test_path(roster.clone());
    let manager = Arc::new(ChatManager::default());
    let store = &manager.orchestrations;
    let register = |name: &str, desktop: Option<bool>| {
        crate::team::save(
            &roster,
            serde_json::from_value(json!({
                "name": name, "agent": "codex", "model": "gpt-5.6-terra",
                "desktopTools": desktop,
            }))
            .unwrap(),
        )
        .unwrap()
    };
    let worker_of = |id: &str| {
        let run = run(store);
        running_worker_of(
            store,
            &run,
            &TaskAssignee {
                id: id.into(),
                name: "Social".into(),
            },
        )
        .worker_chat_key
    };
    // No assignee, no agent: no.
    let run0 = run(store);
    let unassigned = running_worker(store, &run0).worker_chat_key;
    assert!(!worker_wants_desktop_tools(&manager, &unassigned));
    let plain = register("Plain", None);
    assert!(
        !worker_wants_desktop_tools(&manager, &worker_of(&plain.id)),
        "default off"
    );
    let opted = register("Opted", Some(true));
    let key = worker_of(&opted.id);
    assert!(worker_wants_desktop_tools(&manager, &key));
    // Not another chat, and not an agent that is no longer on the roster.
    assert!(!worker_wants_desktop_tools(&manager, "chat:orch-other"));
    assert!(!worker_wants_desktop_tools(
        &manager,
        &worker_of("agent_gone")
    ));
    // Switched off later: the next launch sees it.
    crate::team::save(
        &roster,
        serde_json::from_value(json!({
            "id": opted.id, "name": "Opted", "agent": "codex",
            "model": "gpt-5.6-terra", "desktopTools": false,
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(!worker_wants_desktop_tools(&manager, &key));
}

#[test]
fn notification_wakes_an_idle_reaped_coordinator_in_its_recorded_root() {
    use crate::orchestration::tests::running_worker;
    let home = crate::test_dir::TestDir::new("notification-wake");
    let _profile = crate::profile::started_in(&home);
    let manager = Arc::new(ChatManager::default());
    let store = &manager.orchestrations;
    let run = store
        .create_run(
            "chat:master".into(),
            "test".into(),
            "workspace".into(),
            home.to_string_lossy().into_owned(),
            Some(2),
        )
        .unwrap();
    let worker = running_worker(store, &run);
    let key = run.coordinator_chat_key.clone();
    let mut start = StartContext::for_test(ChatAgent::Claude, Some("saved-session"));
    start.cwd = home.join("saved-checkout").to_string_lossy().into_owned();
    store.save_resume_context(&key, start.clone()).unwrap();
    // An old rejected start poisoned the host's cwd. The browser and
    // the run still agree on the coordinator's original root.
    crate::chat_index::upsert(
        serde_json::from_value(json!({
            "id": "master", "projectId": "p1", "title": "coordinator",
            "sessionId": "saved-session", "cwd": home.to_string_lossy(), "access": "read",
        }))
        .unwrap(),
    )
    .unwrap();
    let session = claude_session(false);
    hold(&manager, &key, session);
    assert!(end_process_when(&manager, &key, Some(Duration::ZERO)).unwrap());
    assert!(!manager.has_process(&key));
    assert!(manager.notification_ready(&key));
    store
        .record_message(
            &worker.worker_chat_key,
            run.id.clone(),
            "coordinator".into(),
            "status".into(),
            "Ready".into(),
            "worker update".into(),
        )
        .unwrap();
    let note = store.due_notifications(i64::MAX).unwrap().remove(0);
    let mut launched = false;
    assert_eq!(
        deliver_orchestration_notification_with_start(
            manager.clone(),
            std::slice::from_ref(&note),
            Default::default(),
            |_, target, resumed, prompt, receipt| {
                launched = true;
                assert_eq!(target, key);
                assert_eq!(resumed.cwd, run.root_path);
                assert_eq!(resumed.session_id, start.session_id);
                assert_eq!(resumed.access, start.access);
                assert!(prompt.contains("worker update"));
                assert_eq!(receipt, note.id);
                Ok(())
            }
        ),
        Ok(true)
    );
    assert!(launched);
}

#[test]
fn notification_to_a_live_coordinator_waits_for_its_profile_then_writes_one_turn() {
    use crate::orchestration::tests::{run, running_worker};
    use std::io::BufRead;
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let manager = Arc::new(ChatManager::default());
    let run = run(&manager.orchestrations);
    let worker = running_worker(&manager.orchestrations, &run);
    manager
        .orchestrations
        .record_message(
            &worker.worker_chat_key,
            run.id.clone(),
            "coordinator".into(),
            "status".into(),
            "Ready".into(),
            "live update".into(),
        )
        .unwrap();
    let note = manager
        .orchestrations
        .due_notifications(i64::MAX)
        .unwrap()
        .remove(0);
    let (session, mut written) = capturing_claude_session();
    session.lock().unwrap().busy = false;
    hold(&manager, &run.coordinator_chat_key, session.clone());
    home.move_away();
    assert!(
        deliver_orchestration_notification(manager.clone(), &note, Default::default()).is_err()
    );
    assert!(!session.lock().unwrap().busy);
    assert!(session.lock().unwrap().answering.is_none());
    assert!(!home.profile().exists());
    home.move_back();
    assert!(manager.notification_ready(&run.coordinator_chat_key));
    assert_eq!(
        deliver_orchestration_notification(manager.clone(), &note, Default::default()),
        Ok(true)
    );
    let mut line = String::new();
    written.read_line(&mut line).unwrap();
    assert!(line.contains("live update"));
    assert_eq!(
        session.lock().unwrap().answering.as_deref(),
        Some(note.id.as_str())
    );
    end_process(&manager, &run.coordinator_chat_key).unwrap();
}

#[test]
fn notification_batch_is_one_turn_and_each_receipt_survives_reconciliation() {
    use crate::orchestration::inbox::{deliver_pending, receipt_ids, DeliveryState};
    use crate::orchestration::tests::{run, running_worker};
    use std::io::BufRead;
    let home = crate::test_dir::TestDir::new("notification-batch");
    let _profile = crate::profile::started_in(&home);
    let manager = Arc::new(ChatManager::default());
    let store = &manager.orchestrations;
    let run = run(store);
    let worker = running_worker(store, &run);
    let projects = crate::workspaces::WorkspaceState::with_projects(vec![serde_json::from_value(
        json!({"id":"workspace", "name":"test"}),
    )
    .unwrap()]);
    for i in 0..40 {
        store
            .record_message(
                &worker.worker_chat_key,
                run.id.clone(),
                "coordinator".into(),
                "reply".into(),
                format!("Update {i}"),
                format!("body {i}"),
            )
            .unwrap();
    }
    let due = store.due_notifications(i64::MAX).unwrap();
    assert_eq!(due.len(), 40, "one chat is never truncated");
    let (session, mut written) = capturing_claude_session();
    session.lock().unwrap().busy = false;
    hold(&manager, &run.coordinator_chat_key, session.clone());
    deliver_pending(&manager, &projects).unwrap();
    let mut line = String::new();
    written.read_line(&mut line).unwrap();
    let sent: Value = serde_json::from_str(&line).unwrap();
    let text = sent["message"]["content"][0]["text"].as_str().unwrap();
    let mut previous = 0;
    for n in &due {
        let position = text.find(&n.id).unwrap();
        assert!(position >= previous);
        previous = position;
    }
    let mut event = json!({"type":"user", "message":{"content":"receipt"}});
    acknowledge_user_turn(
        &mut event,
        ChatAgent::Claude,
        &mut session.lock().unwrap().user_turn_id,
    );
    assert_eq!(receipt_ids(&event).len(), 40);
    assert!(store
        .snapshot(None)
        .unwrap()
        .notifications
        .iter()
        .all(|n| n.state == DeliveryState::Delivering));
    crate::transcript::append(&run.coordinator_chat_key, &event).unwrap();
    // Simulate a crash before the reader updated the ledger, and wait
    // out its lease without sleeping. No second provider prompt is sent.
    for n in &due {
        store
            .retry_notification(&n.id, Some("receipt reconciliation".into()), 0)
            .unwrap();
    }
    deliver_pending(&manager, &projects).unwrap();
    deliver_pending(&manager, &projects).unwrap();
    let notes = store.snapshot(None).unwrap().notifications;
    assert!(notes
        .iter()
        .all(|n| n.state == DeliveryState::Acknowledged && n.attempts == 1));
    end_process(&manager, &run.coordinator_chat_key).unwrap();
}

#[test]
fn an_unwritable_notification_batch_acknowledges_nothing() {
    use crate::orchestration::inbox::{deliver_pending, DeliveryState};
    use crate::orchestration::tests::{run, running_worker};
    let home = crate::test_dir::TestDir::new("notification-batch-failure");
    let _profile = crate::profile::started_in(&home);
    let manager = Arc::new(ChatManager::default());
    let store = &manager.orchestrations;
    let run = run(store);
    let worker = running_worker(store, &run);
    let projects = crate::workspaces::WorkspaceState::with_projects(vec![serde_json::from_value(
        json!({"id":"workspace", "name":"test"}),
    )
    .unwrap()]);
    for i in 0..3 {
        store
            .record_message(
                &worker.worker_chat_key,
                run.id.clone(),
                "coordinator".into(),
                "reply".into(),
                format!("Update {i}"),
                "body".into(),
            )
            .unwrap();
    }
    let session = claude_session(false);
    session.lock().unwrap().stdin.take();
    hold(&manager, &run.coordinator_chat_key, session.clone());
    deliver_pending(&manager, &projects).unwrap();
    assert!(!session.lock().unwrap().busy);
    let notes = store.snapshot(None).unwrap().notifications;
    assert_eq!(notes.len(), 3);
    assert!(notes
        .iter()
        .all(|n| n.state == DeliveryState::Pending && n.last_error.is_some()));
    assert!(crate::transcript::every_line(&run.coordinator_chat_key)
        .unwrap()
        .is_empty());
    end_process(&manager, &run.coordinator_chat_key).unwrap();
}

#[test]
fn notifications_use_internal_receipts_for_both_providers() {
    for (agent, mut event) in [
        (ChatAgent::Codex, json!({"type":"turn.started"})),
        (
            ChatAgent::Claude,
            json!({"type":"user","message":{"content":"host ping"}}),
        ),
    ] {
        let mut pending = Some("octiq-notification-test".into());
        acknowledge_user_turn(&mut event, agent, &mut pending);
        assert!(pending.is_none());
        assert!(event.get("octiq_user_turn_id").is_none());
        assert_eq!(
            event["octiq_orchestration_notification_id"],
            "octiq-notification-test"
        );
    }
}

#[test]
fn user_queue_precedes_internal_turns_and_preserves_each_fifo() {
    let manager = ChatManager::default();
    for (id, recorded) in [
        ("host1", false),
        ("user1", true),
        ("host2", false),
        ("user2", true),
    ] {
        manager
            .queue_turn(
                "priority",
                QueuedTurn {
                    text: id.into(),
                    images: vec![],
                    turn_id: Some(id.into()),
                    appended_turn_ids: vec![],
                    recorded,
                    context: None,
                },
            )
            .unwrap();
    }
    let queues = manager.queued_turns.lock().unwrap();
    let ids: Vec<_> = queues["priority"].iter().map(|t| t.text.as_str()).collect();
    assert_eq!(ids, ["user1", "user2", "host1", "host2"]);
    drop(queues);
    assert!(!manager.notification_ready("priority"));
}

#[test]
fn startup_without_a_provider_receipt_leaves_delivery_unconfirmed() {
    let mut pending = Some("exact-turn".to_string());
    let mut startup = json!({ "type": "thread.started", "thread_id": "thread" });
    acknowledge_user_turn(&mut startup, ChatAgent::Codex, &mut pending);
    assert_eq!(pending.as_deref(), Some("exact-turn"));
    // This pending id is what the stdout EOF path reports as unknown.
    let mut receipt = json!({ "type": "turn.started" });
    acknowledge_user_turn(&mut receipt, ChatAgent::Codex, &mut pending);
    assert_eq!(receipt["octiq_user_turn_id"], "exact-turn");
    assert!(pending.is_none());

    let mut pending = Some("claude-turn".to_string());
    let mut output =
        json!({ "type": "user", "message": { "content": [{ "type": "tool_result" }] } });
    acknowledge_user_turn(&mut output, ChatAgent::Claude, &mut pending);
    assert!(pending.is_some());
    let mut receipt = json!({ "type": "user", "message": { "content": "hello" } });
    acknowledge_user_turn(&mut receipt, ChatAgent::Claude, &mut pending);
    assert_eq!(receipt["octiq_user_turn_id"], "claude-turn");
    assert!(pending.is_none());
}

#[test]
fn command_line_turn_starts_receive_the_exact_user_turn_id() {
    let mut codex_started = json!({ "type": "turn.started" });
    stamp_user_turn_id(&mut codex_started, ChatAgent::Codex, Some("user-earlier"));
    assert_eq!(
        codex_started["octiq_user_turn_id"],
        Value::String("user-earlier".into())
    );

    let mut claude_user = json!({ "type": "user" });
    let before = claude_user.clone();
    stamp_user_turn_id(&mut claude_user, ChatAgent::Claude, Some("user-1"));
    assert_eq!(
        claude_user, before,
        "Claude's known-good stream is untouched"
    );

    let mut codex_answer = json!({ "type": "item.completed" });
    let before = codex_answer.clone();
    stamp_user_turn_id(&mut codex_answer, ChatAgent::Codex, Some("user-1"));
    assert_eq!(codex_answer, before, "only the acknowledgement is stamped");

    let mut pi_started = json!({ "type": "turn_start" });
    stamp_user_turn_id(&mut pi_started, ChatAgent::Pi, Some("user-pi"));
    assert_eq!(
        pi_started["octiq_user_turn_id"],
        Value::String("user-pi".into())
    );

    let mut pi_answer = json!({ "type": "message_end" });
    let before = pi_answer.clone();
    stamp_user_turn_id(&mut pi_answer, ChatAgent::Pi, Some("user-pi"));
    assert_eq!(pi_answer, before, "only Pi's acknowledgement is stamped");

    // Antigravity's own `user_input` step, from its real stream, is its
    // acknowledgement; its answer is not.
    let events =
        crate::agent_provider::tests::agy_events(crate::agent_provider::tests::AGY_THREE_TURNS);
    let mut took = events[1].clone();
    stamp_user_turn_id(&mut took, ChatAgent::Antigravity, Some("user-agy"));
    assert_eq!(took["octiq_user_turn_id"], json!("user-agy"));
    let mut answer = events[2].clone();
    let before = answer.clone();
    stamp_user_turn_id(&mut answer, ChatAgent::Antigravity, Some("user-agy"));
    assert_eq!(
        answer, before,
        "only Antigravity's acknowledgement is stamped"
    );
}

/// Antigravity keeps one process across turns like Claude, but a stop or
/// an exit continues it in a new one, carrying the queue, like Pi.
#[test]
fn only_a_provider_without_an_in_band_stop_relaunches_to_continue() {
    assert!(!relaunches_to_continue(ChatAgent::Claude));
    // Pi's rpc process takes an in-band abort, so Stop keeps it.
    assert!(!relaunches_to_continue(ChatAgent::Pi));
    {
        let _exec = crate::agent_provider::tests::CommandLineCodex::on();
        assert!(relaunches_to_continue(ChatAgent::Codex));
    }
    assert!(relaunches_to_continue(ChatAgent::Antigravity));
    assert!(provider_for(ChatAgent::Antigravity)
        .capabilities()
        .input
        .accepts_stdin());
}

#[test]
fn full_access_is_named_in_the_environment_the_hook_reads() {
    assert_eq!(Access::Full.as_env(), "full");
    assert_eq!(Access::Auto.as_env(), "auto");
    assert_eq!(Access::Read.as_env(), "read");
}

#[test]
fn the_agents_permission_question_is_recognised_and_nothing_else_is() {
    // The shape is measured, not guessed: it is what `claude -p
    // --permission-prompt-tool stdio` actually wrote when asked to run a
    // command it needed approval for.
    let asking = json!({
        "type": "control_request",
        "request_id": "req-1",
        "request": {
            "subtype": "can_use_tool",
            "tool_name": "Bash",
            "display_name": "Bash",
            "input": { "command": "mkfifo /tmp/x.fifo" },
            "permission_suggestions": [{
                "type": "addRules",
                "rules": [{ "toolName": "Bash", "ruleContent": "mkfifo /tmp/x.fifo" }]
            }]
        }
    });
    let observed = provider_for(ChatAgent::Claude).observe_event(&asking);
    let permission = observed.permission.expect("the question");
    assert_eq!(permission.id, "req-1");
    assert_eq!(permission.request["tool_name"], "Bash");

    // Control requests travel BOTH ways on this channel. Ours must not be
    // mistaken for the agent's, or setting the mode would raise a question.
    let ours = json!({
        "type": "control_request",
        "request_id": "octiq-access-1",
        "request": { "subtype": "set_permission_mode", "mode": "auto" }
    });
    assert!(provider_for(ChatAgent::Claude)
        .observe_event(&ours)
        .permission
        .is_none());
    let assistant = json!({ "type": "assistant" });
    assert!(provider_for(ChatAgent::Claude)
        .observe_event(&assistant)
        .permission
        .is_none());
}

#[test]
fn removed_agent_tools_are_not_exposed_to_the_host() {
    let c = build_command_with_mcp(
        ChatAgent::Claude,
        None,
        None,
        "hi",
        None,
        &[],
        None,
        &[],
        false,
        Some(std::path::Path::new("octiq-ask.json")),
    );

    assert!(
        !c.contains("mcp__octiq__add_agent"),
        "add_agent remains: {c}"
    );
    assert!(
        !c.contains("mcp__octiq__ask_agent"),
        "ask_agent remains: {c}"
    );
    assert!(c.contains("mcp__octiq__ask_user"));
    assert!(c.contains("mcp__octiq__search_conversations"));
    assert!(c.contains("mcp__octiq__read_conversation"));
    assert!(c.contains("whole message is `continue <OctiqFlow conversation URL>`"));
    assert!(c.contains("must not open it in Browser"));
}

#[test]
fn the_agent_is_told_to_ask_us_rather_than_deny() {
    // Without this flag an `ask` decision in print mode is terminal: the
    // call is denied, nobody is asked, and the chat says nothing about why.
    let line = hello_line(ChatAgent::Claude, Some(Access::Auto), false);
    assert!(line.contains("--permission-prompt-tool stdio"));
}

#[test]
fn the_question_tool_the_agent_cannot_be_answered_on_is_taken_back() {
    // `--permission-prompt-tool stdio` does not only route permissions. It
    // also hands the model `AskUserQuestion`, which plain print mode never
    // offered: measured on the same CLI, 30 built-in tools without the flag
    // and 33 with it, the three being `AskUserQuestion`, `EnterPlanMode`
    // and `ExitPlanMode`. The flag alone does it; the handshake is not
    // involved.
    //
    // That tool is not ours to answer. It is not a `can_use_tool` request —
    // permission is granted and the CLI then runs the tool itself, looking
    // for an interactive prompt that a `-p` process does not have. It gives
    // up at once and tells the agent "The user did not answer the
    // questions", which reads as a refusal nobody made.
    //
    // So it is taken back, and `ask_user` is left as the only way to ask —
    // the one that reaches a phone. Unconditional on purpose: when the MCP
    // config could not be written there is no `ask_user` either, and no
    // question at all is what this command line did before the flag arrived.
    let line = hello_line(ChatAgent::Claude, Some(Access::Auto), false);
    assert!(line.contains("--disallowedTools AskUserQuestion"));
}

#[test]
fn a_lite_chat_drops_the_machines_skills_hooks_and_other_mcp_servers() {
    // What this machine loads into a chat that never asked for it: ten MCP
    // servers, every installed skill, and the SessionStart hooks. Measured
    // in this repo, that is 60.4k of context before the first word — half
    // of it the skill list alone. Lite is the same chat without them.
    //
    // `--bare` is the flag that reads like the answer and is not: it never
    // looks at the OAuth login or the keychain, so on a subscription it
    // dies at "Not logged in" before it reaches the model. `--safe-mode`
    // does keep the login, but it drops MCP servers passed with
    // `--mcp-config` too — which is where `ask_user` lives, so the chat
    // could no longer ask anything. These three flags are the cut that
    // leaves the login and our own two tools standing: 30.2k.
    let line = build_command_with_mcp(
        ChatAgent::Claude,
        None,
        Some(Access::Auto),
        "hello",
        None,
        &[],
        None,
        &[],
        true,
        Some(std::path::Path::new("octiq-ask.json")),
    );
    assert!(line.contains("--strict-mcp-config"));
    assert!(line.contains("--disable-slash-commands"));
    // Empty, and quoted: the flag takes a list, and no list is the whole
    // point. An unquoted empty word would vanish in the shell and the next
    // flag would be read as its value.
    assert!(line.contains("--setting-sources ''"));
    // Ours survives the cut. `--strict-mcp-config` means ONLY the servers
    // named on this command line, and ours is named on it.
    assert!(line.contains("--mcp-config"));
}

#[test]
fn a_normal_chat_still_gets_everything_this_machine_offers() {
    let line = hello_line(ChatAgent::Claude, Some(Access::Auto), false);
    assert!(!line.contains("--strict-mcp-config"));
    assert!(!line.contains("--disable-slash-commands"));
    assert!(!line.contains("--setting-sources"));
}

#[test]
fn lite_says_nothing_to_codex() {
    // Codex loads its skills from a folder rather than from the config it
    // can be told to ignore, so the same idea saved 21.2k against 20.8k
    // there — a rounding error, for flags that would still have to be
    // written and kept right. The switch is a Claude one until that changes.
    let line = hello_line(ChatAgent::Codex, Some(Access::Auto), true);
    assert!(!line.contains("--ignore-user-config"));
    assert!(!line.contains("--strict-mcp-config"));
}

#[test]
fn a_folder_name_cannot_break_out_of_the_toml_string_it_lands_in() {
    // `writable_roots` is a TOML array built by hand, so the path inside it
    // has to survive TOML as well as the shell. sh_quote covers the shell
    // and nothing else: a `"` in a folder name would close the string and
    // whatever follows would be read as more config.
    assert_eq!(toml_string(r#"/tmp/plain"#), r#""/tmp/plain""#);
    assert_eq!(
        toml_string(r#"/tmp/a", evil = "yes"#),
        r#""/tmp/a\", evil = \"yes""#
    );
    assert_eq!(toml_string(r"/tmp/back\slash"), r#""/tmp/back\\slash""#);
    assert_eq!(
        toml_string("line one\nline two\tend"),
        r#""line one\nline two\tend""#
    );
}

#[test]
fn a_codex_resume_puts_the_folder_in_the_config_key_safely() {
    let roots = vec![r#"/tmp/a", evil = "yes"#.to_string()];
    let request = crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
        cwd: "/tmp",
        model: None,
        effort: None,
        access: None,
        resume: Some("abc-123"),
        workspace_roots: &roots,
        developer_instructions: "host",
    });
    assert_eq!(request["params"]["runtimeWorkspaceRoots"], json!(roots));
}

#[test]
fn quotes_close_the_hole() {
    assert_eq!(sh_quote("plain"), "'plain'");
    // The one character that can end the quoted run is re-opened safely.
    assert_eq!(sh_quote("it's"), r"'it'\''s'");
    assert_eq!(sh_quote("a; rm -rf /"), "'a; rm -rf /'");
}

#[test]
fn model_names_are_allowlisted() {
    assert_eq!(safe_model("opus").as_deref(), Some("opus"));
    assert_eq!(
        safe_model("claude-fable-5").as_deref(),
        Some("claude-fable-5")
    );
    assert_eq!(safe_model("gpt-5.6-sol").as_deref(), Some("gpt-5.6-sol"));
    // Anything that could become another shell word is refused outright.
    assert_eq!(safe_model("opus; id"), None);
    assert_eq!(safe_model("$(id)"), None);
    assert_eq!(safe_model(""), None);
}

#[test]
fn resume_only_takes_a_plain_id() {
    let id = "a2c8ca18-dcd4-41bc-a49d-b078f2a8e056";
    let c = resume_line(id);
    assert!(c.contains(&format!("--resume '{id}'")));
    // Anything that could become a second shell word is dropped outright.
    let bad = resume_line("x; rm -rf /");
    assert!(!bad.contains("--resume"));
}

#[test]
fn one_access_level_becomes_each_agents_own_flag() {
    // The same question — how much may it do unattended — asked once and
    // spelled differently for each agent. Codex needs BOTH halves: a sandbox
    // says what a command may touch, an approval policy says whether it runs
    // unasked. Setting only the sandbox left the middle level asking about
    // everything and the top level asking at all, neither of which is what
    // the label promises.
    for (level, claude_flag, sandbox, approval) in [
        (Access::Read, "--permission-mode plan", "read-only", "never"),
        (
            Access::Auto,
            "--permission-mode auto",
            "workspace-write",
            "on-request",
        ),
        (
            Access::Full,
            "--dangerously-skip-permissions",
            "danger-full-access",
            "never",
        ),
    ] {
        let c = build_command(
            ChatAgent::Claude,
            None,
            Some(level),
            "",
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(c.contains(claude_flag), "claude {level:?}");
        // `bypassPermissions` is accepted only when the process was launched
        // for it, so Full never names it as a permission mode.
        assert!(
            !c.contains("--permission-mode bypassPermissions"),
            "claude {level:?}"
        );
        assert!(
            !c.contains("--sandbox"),
            "claude must not get a sandbox flag"
        );

        let roots = vec!["/work".into()];
        let request =
            crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
                cwd: "/work",
                model: None,
                effort: None,
                access: Some(level),
                resume: None,
                workspace_roots: &roots,
                developer_instructions: "host",
            });
        assert_eq!(request["params"]["sandbox"], sandbox, "codex {level:?}");
        assert_eq!(
            request["params"]["approvalPolicy"], approval,
            "codex approval {level:?}"
        );
    }
}

#[test]
fn codex_resume_spells_both_halves_as_config_keys() {
    // app-server resumes the native thread and applies the selected policy
    // in the same typed request, independent of the user's config file.
    let id = "a2c8ca18-dcd4-41bc-a49d-b078f2a8e056";
    let roots = vec!["/work".into()];
    let request = crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
        cwd: "/work",
        model: None,
        effort: None,
        access: Some(Access::Auto),
        resume: Some(id),
        workspace_roots: &roots,
        developer_instructions: "host",
    });
    assert_eq!(request["method"], "thread/resume");
    assert_eq!(request["params"]["threadId"], id);
    assert_eq!(request["params"]["sandbox"], "workspace-write");
    assert_eq!(request["params"]["approvalPolicy"], "on-request");
}

#[test]
fn claude_and_codex_both_get_a_two_way_stream() {
    // A prompt that cannot appear by accident inside another word. The
    // first version of this test used "hi", which is a substring of
    // "which" — so it passed until an unrelated flag happened to contain
    // that word, then failed for a reason that had nothing to do with the
    // thing being tested.
    let prompt = "zzq-prompt-marker";
    let c = build_command(
        ChatAgent::Claude,
        Some("opus"),
        Some(Access::Read),
        prompt,
        None,
        &[],
        None,
        &[],
        false,
    );
    assert!(c.contains("--input-format stream-json"));
    assert!(c.contains("--model 'opus'"));
    assert!(c.contains("--permission-mode plan"));
    // Claude's prompt goes over stdin, never on the command line.
    assert!(!c.contains(prompt));

    let x = build_command(
        ChatAgent::Codex,
        None,
        None,
        "hi there",
        None,
        &[],
        None,
        &[],
        false,
    );
    assert!(x.starts_with("codex app-server --enable default_mode_request_user_input"));
    assert!(!x.contains("hi there"));
    assert_eq!(
        provider_for(ChatAgent::Codex).capabilities().input,
        crate::agent_provider::InputTransport::AppServer
    );
}

#[test]
fn effort_is_an_allowlist_and_spelled_per_agent() {
    let c = effort_line("xhigh");
    assert!(c.contains("--effort xhigh"));
    // Codex carries the validated value in its typed turn request.
    assert_eq!(
        provider_for(ChatAgent::Codex).effort("xhigh"),
        Some("xhigh")
    );

    // Anything outside the set is dropped rather than forwarded.
    let bad = effort_line("turbo; id");
    assert!(!bad.contains("--effort"));

    // `max` is BOTH agents': Codex's own model list gives it to every
    // GPT-5.6 model (`supported_reasoning_levels` in
    // `~/.codex/models_cache.json`), so refusing it here dropped a level
    // the agent would have taken.
    let claude_max = effort_line("max");
    assert!(claude_max.contains("--effort max"));
    assert_eq!(provider_for(ChatAgent::Codex).effort("max"), Some("max"));

    // `minimal` is nobody's any more. The same model list dropped it from
    // every GPT-5.6 model, and Claude never had it.
    assert_eq!(provider_for(ChatAgent::Codex).effort("minimal"), None);
    let claude_min = effort_line("minimal");
    assert!(!claude_min.contains("--effort"));

    // `ultracode` is Claude's top rung. It is missing from `--help`, but the
    // flag takes it: an unknown value warns and falls back, and this one
    // does not.
    let ultra = effort_line("ultracode");
    assert!(ultra.contains("--effort ultracode"));
    assert_eq!(provider_for(ChatAgent::Codex).effort("ultracode"), None);

    // `auto` deliberately reaches the command line as nothing at all: the
    // flag rejects it, and no flag IS "the agent picks". The UI then sends
    // `/effort auto` to the running session, which does take it.
    let auto = effort_line("auto");
    assert!(!auto.contains("--effort"));
}

#[test]
fn codex_continues_a_conversation_by_resuming_its_thread() {
    let id = "01a0142d-552d-7a93-9152-47530c33e501";
    let roots = vec!["/tmp".into(), "/tmp/api".into()];
    let resumed = crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
        cwd: "/tmp",
        model: None,
        effort: Some("high"),
        access: Some(Access::Read),
        resume: Some(id),
        workspace_roots: &roots,
        developer_instructions: "host",
    });
    assert_eq!(resumed["method"], "thread/resume");
    assert_eq!(resumed["params"]["threadId"], id);
    assert_eq!(resumed["params"]["sandbox"], "read-only");
    assert_eq!(
        resumed["params"]["config"]["model_reasoning_effort"],
        "high"
    );
    assert_eq!(resumed["params"]["runtimeWorkspaceRoots"], json!(roots));

    let turn = crate::codex_app_server::turn_request(crate::codex_app_server::TurnRequest {
        id: "request-1",
        thread_id: id,
        text: "next question",
        images: &[],
        client_user_message_id: Some("user-1"),
        cwd: "/tmp",
        workspace_roots: &roots,
        model: None,
        effort: Some("high"),
        access: Some(Access::Read),
        runtime_context: "runtime",
    });
    assert_eq!(turn["params"]["input"][0]["text"], "next question");
    assert_eq!(turn["params"]["threadId"], id);

    let first = crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
        cwd: "/tmp",
        model: None,
        effort: None,
        access: Some(Access::Read),
        resume: None,
        workspace_roots: &roots,
        developer_instructions: "host",
    });
    assert_eq!(first["method"], "thread/start");
    assert_eq!(first["params"]["ephemeral"], false);
}

#[test]
fn codex_is_allowed_to_run_where_there_is_no_git_repo() {
    // app-server receives the cwd as protocol data and does not impose the
    // `codex exec` git trust gate on either a new or resumed thread.
    let roots = vec!["/tmp/scratch".into()];
    for resume in [None, Some("01a0142d-552d-7a93-9152-47530c33e501")] {
        let request =
            crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
                cwd: "/tmp/scratch",
                model: None,
                effort: None,
                access: Some(Access::Read),
                resume,
                workspace_roots: &roots,
                developer_instructions: "host",
            });
        assert_eq!(request["params"]["cwd"], "/tmp/scratch");
    }

    // Claude has no such check and no such flag; handing it one would be
    // an unknown argument.
    let claude = hello_line(ChatAgent::Claude, Some(Access::Read), false);
    assert!(!claude.contains("--skip-git-repo-check"), "{claude}");
}

#[test]
fn codex_missing_rollout_thread_stays_in_diagnostics_without_hiding_other_failures() {
    let codex = provider_for(ChatAgent::Codex);
    let mut state = OutputState::default();
    let line = "2026-09-08T07:41:49.205220Z ERROR codex_core::session: failed to record rollout items: thread 01a07ff6-0e48-79b1-ae44-e34950e03069 not found";
    assert_eq!(
        codex.classify_output(line, &mut state),
        OutputDisposition::DiagnosticsOnly
    );
    assert_eq!(
        codex.classify_output(line, &mut state),
        OutputDisposition::DiagnosticsOnly
    );
    for other in [
        "2026-09-08T07:41:50Z ERROR codex_core::session: failed to record rollout items: disk full",
        "2026-09-08T07:41:50Z ERROR codex_core::auth: token expired",
        "turn.failed",
        "process exited with code 1",
    ] {
        assert_eq!(
            codex.classify_output(other, &mut state),
            OutputDisposition::Visible
        );
    }
    assert_eq!(
        codex.classify_output(line, &mut OutputState::default()),
        OutputDisposition::DiagnosticsOnly
    );
    assert_eq!(
        provider_for(ChatAgent::Claude).classify_output(line, &mut state),
        OutputDisposition::Visible
    );
}

#[test]
fn codex_internal_output_is_ignored_or_kept_in_diagnostics() {
    let codex = provider_for(ChatAgent::Codex);
    assert_eq!(
        codex.output_disposition("Reading additional input from stdin..."),
        OutputDisposition::Ignore,
    );
    assert_eq!(
        codex.output_disposition("  Reading additional input from stdin... "),
        OutputDisposition::Ignore,
    );
    assert_eq!(
        codex.output_disposition(
            "2026-08-30T09:38:25Z ERROR codex_models_manager::manager: \
                 failed to renew cache TTL: missing field `supports_parallel_tool_calls`"
        ),
        OutputDisposition::Ignore,
    );
    assert_eq!(
        codex.output_disposition(
            "2026-08-31T00:00:05.370617Z ERROR codex_core::tools::router: \
                 error=apply_patch verification failed: Failed to find expected lines"
        ),
        OutputDisposition::DiagnosticsOnly,
    );
    assert_eq!(
        codex.output_disposition(
            "2026-09-07T08:29:34.050136Z ERROR codex_core::tools::router: \
                 error=write_stdin failed: Unknown process id 29017"
        ),
        OutputDisposition::DiagnosticsOnly,
    );
    assert_eq!(
        codex.output_disposition(
            "2026-09-14T18:14:29.286752Z ERROR codex_core::tools::router: \
                 error=collab spawn failed: agent thread limit reached"
        ),
        OutputDisposition::DiagnosticsOnly,
    );
    // Real agent failures still reach the user.
    assert_eq!(
        codex.output_disposition("Error loading config.toml"),
        OutputDisposition::Visible,
    );
    assert_eq!(
        codex.output_disposition("You've hit your usage limit."),
        OutputDisposition::Visible,
    );
}

#[test]
fn a_dead_process_leaves_its_exit_code_and_last_error_line() {
    // Feedback 2adec4d5: bash refused the launch line and said why, and
    // the attempt said only "disconnected".
    assert_eq!(
        last_words(Some(2), "bash: -c: line 26: unexpected EOF").as_deref(),
        Some(
            "The process exited with code 2. Its last error output: \
                 bash: -c: line 26: unexpected EOF"
        )
    );
    // An idle worker reaped after a clean turn has nothing to add.
    assert_eq!(last_words(Some(0), ""), None);
    // Killed, or gone without a code: still worth the line it left.
    assert_eq!(
        last_words(None, " lost the pipe \n").as_deref(),
        Some("The process ended without an exit code. Its last error output: lost the pipe")
    );
    assert_eq!(
        last_words(Some(1), "").as_deref(),
        Some("The process exited with code 1.")
    );
    // The line reaches the coordinator's inbox, so it is kept short.
    let long = last_words(Some(1), &"é".repeat(2_000)).unwrap();
    assert!(long.chars().count() < 400, "{}", long.chars().count());
    assert!(long.ends_with('…'));
}

#[test]
fn all_codex_router_failures_are_diagnostics_but_other_errors_stay_visible() {
    let codex = provider_for(ChatAgent::Codex);
    let mut state = OutputState::default();
    let duplicate = "2026-09-08T06:26:14.629158Z ERROR codex_core::tools::router: error=agent path `/root/onboarding_backend` already exists";
    for line in [
            duplicate,
            "2026-09-08T06:26:15Z ERROR codex_core::tools::router: error=agent path `/root/onboarding_backend` failed to start",
            "2026-09-08T06:26:17Z ERROR codex_core::tools::router: error=file already exists",
        ] {
            assert_eq!(
                codex.classify_output(line, &mut state),
                OutputDisposition::DiagnosticsOnly,
            );
        }
    assert_eq!(
        codex.classify_output(
            "2026-09-08T06:26:16Z ERROR codex_core::auth: token expired",
            &mut state,
        ),
        OutputDisposition::Visible,
    );
    assert_eq!(
        provider_for(ChatAgent::Claude).output_disposition(duplicate),
        OutputDisposition::Visible,
    );
}

#[test]
fn codex_patch_error_context_stays_out_of_chat_notices() {
    let codex = provider_for(ChatAgent::Codex);
    let mut output_state = OutputState::default();

    assert_eq!(
        codex.classify_output(
            "2026-08-31T06:50:38.687616Z ERROR codex_core::tools::router: \
                 error=apply_patch verification failed: Failed to find expected lines",
            &mut output_state,
        ),
        OutputDisposition::DiagnosticsOnly,
    );
    assert_eq!(
        codex.classify_output("- I03 — 作者选定横幅名", &mut output_state),
        OutputDisposition::DiagnosticsOnly,
    );
    assert_eq!(
        codex.classify_output(".msgs-inner {", &mut output_state),
        OutputDisposition::DiagnosticsOnly,
    );
    // The following timestamped record is new output, rather than failed
    // patch context, so its normal visibility rule takes over again.
    assert_eq!(
        codex.classify_output(
            "2026-08-31T06:50:39Z ERROR codex_core::auth: token expired",
            &mut output_state,
        ),
        OutputDisposition::Visible,
    );
}

#[test]
fn codex_exec_command_router_failure_stays_out_of_chat_notices() {
    let codex = provider_for(ChatAgent::Codex);
    let mut output_state = OutputState::default();

    // Codex logs a shell command containing newlines as one tracing record,
    // but BufRead delivers it as several physical lines. None should become
    // a separate amber notice.
    for line in [
        "2026-09-01T03:56:54.470794Z ERROR codex_core::tools::router: \
             error=exec_command failed for `/bin/zsh -lc 'rm -f /tmp/probe.json",
        "test ! -e /workspace/output",
        "lsof -nP -iTCP:4321 -sTCP:LISTEN'`: CreateProcess { message: \
             rejected: rm -f style commands are not permitted }",
    ] {
        assert_eq!(
            codex.classify_output(line, &mut output_state),
            OutputDisposition::DiagnosticsOnly,
        );
    }

    // A later, independent failure must still reach the user.
    assert_eq!(
        codex.classify_output(
            "2026-09-01T03:56:55Z ERROR codex_core::auth: token expired",
            &mut output_state,
        ),
        OutputDisposition::Visible,
    );
}

#[test]
fn codex_exec_rejection_without_a_printed_command_is_diagnostics_only() {
    // Newer Codex builds omit `for <command>` when the process is rejected
    // before spawn. This is the exact shape safety-review refusals use.
    let codex = provider_for(ChatAgent::Codex);

    assert_eq!(
        codex.output_disposition(
            "2026-09-05T12:44:54Z ERROR codex_core::tools::router: \
                 error=exec_command failed: CreateProcess { message: \
                 Rejected(\"This action was rejected due to unacceptable risk.\") }"
        ),
        OutputDisposition::DiagnosticsOnly,
    );
}

#[test]
fn codex_colored_exec_failure_is_diagnostics_only() {
    // Newer Codex tracing output adds SGR colour codes around every field.
    // Classification must read through those codes while diagnostics keep
    // the original record intact.
    let line = "\x1b[2m2026-09-19T23:56:22.037052Z\x1b[0m \x1b[31mERROR\x1b[0m \
                    \x1b[2mcodex_core::tools::router\x1b[0m\x1b[2m:\x1b[0m \
                    \x1b[3merror\x1b[0m\x1b[2m=\x1b[0mexec_command failed: \
                    CreateProcess { message: \"Rejected(\\\"Failed to create unified exec process: \
                    No such file or directory (os error 2)\\\")\" }";
    let codex = provider_for(ChatAgent::Codex);
    let mut state = OutputState::default();

    assert_eq!(
        codex.classify_output(line, &mut state),
        OutputDisposition::DiagnosticsOnly,
    );
}

#[test]
fn codex_split_safety_rejection_stays_out_of_raw_chat_notices() {
    let codex = provider_for(ChatAgent::Codex);
    let mut output_state = OutputState::default();

    for line in [
        "2026-09-07T12:15:53.336267Z ERROR codex_core::tools::router: \
             error=This action was rejected due to unacceptable risk.",
        "Reason: the patch would falsify a validation record.",
        "The agent must not attempt to achieve the same outcome via workaround.",
    ] {
        assert_eq!(
            codex.classify_output(line, &mut output_state),
            OutputDisposition::DiagnosticsOnly,
        );
    }
}

#[test]
fn codex_takes_images_as_files_and_claude_does_not() {
    let shots = vec!["/tmp/a shot.png".to_string(), "/tmp/b.webp".to_string()];
    let roots = vec!["/tmp".into()];
    let turn = |text: &str| {
        crate::codex_app_server::turn_request(crate::codex_app_server::TurnRequest {
            id: "request-1",
            thread_id: "thread-1",
            text,
            images: &shots,
            client_user_message_id: None,
            cwd: "/tmp",
            workspace_roots: &roots,
            model: None,
            effort: None,
            access: None,
            runtime_context: "runtime",
        })
    };
    let x = turn("look");
    assert_eq!(x["params"]["input"][0]["text"], "look");
    assert_eq!(x["params"]["input"][1]["path"], "/tmp/a shot.png");
    assert_eq!(x["params"]["input"][2]["path"], "/tmp/b.webp");

    // An image by itself is a valid composer message. Codex treats an
    // empty positional argument as no prompt and otherwise reads stdin,
    // which command-line chats intentionally close.
    let image_only = turn("");
    assert_eq!(
        image_only["params"]["input"][0]["text"],
        "Please inspect the attached image."
    );

    // The delimiter also preserves a user prompt that starts with a dash.
    let dash_prompt = turn("--describe");
    assert_eq!(dash_prompt["params"]["input"][0]["text"], "--describe");

    // Claude's images ride on stdin instead — see write_user_message.
    let c = build_command(
        ChatAgent::Claude,
        None,
        None,
        "look",
        None,
        &[],
        None,
        &shots,
        false,
    );
    assert!(!c.contains("-i "));
}

#[test]
fn a_decision_made_while_a_chat_is_idle_holds_off_its_next_turn() {
    // Feedback e15fabde: a coordinator confirming a worker's proposed
    // report must not race a message that starts the worker's next turn,
    // which withdraws the words being confirmed.
    let manager = Arc::new(ChatManager::default());
    let key = format!("idle-{}", uuid::Uuid::new_v4().simple());
    let session = |busy: bool| {
        let child = stand_in::still()
            .stdin(Stdio::null())
            .spawn()
            .expect("a stand-in agent");
        ChatSession::shared(child, None, ChatAgent::Codex, busy)
    };
    // No live process: nothing can be in a turn.
    assert_eq!(manager.while_idle(&key, || Ok(1)), Ok(1));

    let live = session(false);
    manager
        .sessions
        .lock()
        .unwrap()
        .insert(key.clone(), live.clone());
    let order = Arc::new(Mutex::new(Vec::new()));
    let decided = manager.while_idle(&key, || {
        // A turn starting now: a send takes the session lock to write
        // the message and set busy.
        let (live, sender) = (live.clone(), order.clone());
        let turn = std::thread::spawn(move || {
            let mut s = live.lock().unwrap();
            s.busy = true;
            sender.lock().unwrap().push("turn started");
        });
        std::thread::sleep(Duration::from_millis(150));
        order.lock().unwrap().push("decided");
        Ok(turn)
    });
    decided.unwrap().join().unwrap();
    assert_eq!(*order.lock().unwrap(), ["decided", "turn started"]);

    // Now it is in a turn: the decision is refused without being made.
    let mut ran = false;
    let refused = manager.while_idle(&key, || {
        ran = true;
        Ok(())
    });
    assert!(refused.unwrap_err().contains("in a turn"));
    assert!(!ran);
    end_process(&manager, &key).expect("end the stand-in");
}

#[test]
fn a_running_chat_reports_the_pid_its_memory_hangs_off() {
    // `memory.rs` charges every process under this pid to this chat, which
    // is the only way an agent's own MCP servers land on the chat that
    // started them rather than on the server.
    let manager = Arc::new(ChatManager::default());
    let key = format!("mem-{}", uuid::Uuid::new_v4().simple());
    let child = stand_in::still()
        .stdin(Stdio::null())
        .spawn()
        .expect("a stand-in agent");
    let pid = child.id() as i32;
    manager.sessions.lock().unwrap().insert(
        key.clone(),
        ChatSession::shared(child, None, ChatAgent::Claude, false),
    );

    assert_eq!(manager.chat_pids().get(&pid), Some(&key));
    end_process(&manager, &key).expect("end the stand-in");
    assert!(
        !manager.chat_pids().contains_key(&pid),
        "a chat that has been ended must stop claiming its pid — the OS is \
             free to hand that number to something else"
    );
}

#[test]
fn a_queued_codex_user_turn_is_durable_before_its_next_process_starts() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("codex-durable-{}", uuid::Uuid::new_v4().simple());
    let child = stand_in::still()
        .stdin(Stdio::null())
        .spawn()
        .expect("a Codex stand-in");
    manager.sessions.lock().unwrap().insert(
        key.clone(),
        ChatSession::shared(child, None, ChatAgent::Codex, true),
    );

    chat_send_user_impl(
        manager.clone(),
        key.clone(),
        "persist this prompt".into(),
        Some(vec!["/tmp/prompt.png".into()]),
        None,
        Some("user-1".into()),
        None,
    )
    .expect("a queued Codex user turn");

    let events = crate::transcript::since(&key, 0);
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].event["state"], "queued");
    assert_eq!(events[0].event["uuid"], "user-1");
    assert_eq!(
        events[0].event["message"]["content"][0]["text"],
        "persist this prompt"
    );
    assert_eq!(
        events[0].event["octiq_attachments"][0]["path"],
        "/tmp/prompt.png"
    );
    assert_eq!(
        manager.take_queued_turn(&key).and_then(|turn| turn.turn_id),
        Some("user-1".into()),
        "the FIFO resume keeps the id of the bubble it will answer"
    );

    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

/// `chat_turn_delivery` asks the queue first: a turn waiting in it is
/// `queued` whatever the record says, and one folded into another unit
/// names the unit's first id. Once taken out, the record decides.
#[test]
fn a_queued_turn_is_queued_and_a_folded_one_names_its_unit() {
    let manager = Arc::new(ChatManager::default());
    let bare = format!("delivery-queue-{}", uuid::Uuid::new_v4().simple());
    // Queues and records are kept under the prefixed key.
    let key = format!("chat:{bare}");
    manager.handoffs.lock().unwrap().insert(key.clone());
    for (text, turn_id) in [("one", "user-1"), ("two", "user-2")] {
        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            text.into(),
            None,
            None,
            Some(turn_id.into()),
            None,
        )
        .expect("a queued turn");
    }
    crate::chat_index::upsert(
        serde_json::from_value(json!({"id": bare, "projectId": "p", "title": "T", "updatedAt": 1}))
            .unwrap(),
    )
    .unwrap();
    let ask = |ids: &[&str]| {
        crate::turn_delivery::chat_turn_delivery_impl(
            &manager,
            &key,
            ids.iter().map(|id| id.to_string()).collect(),
        )
        .unwrap()
        .turns
    };
    // The bare id is the same chat: it must see the same queue.
    let by_bare = crate::turn_delivery::chat_turn_delivery_impl(
        &manager,
        &bare,
        vec!["user-1".into(), "user-2".into()],
    )
    .unwrap()
    .turns;
    assert_eq!(by_bare["user-1"].state, "queued");
    assert_eq!(by_bare["user-2"].into.as_deref(), Some("user-1"));
    let waiting = ask(&["user-1", "user-2", "user-9"]);
    assert_eq!(
        (waiting["user-1"].state, waiting["user-1"].into.as_deref()),
        ("queued", None)
    );
    assert_eq!(waiting["user-1"].seq, None);
    assert_eq!(
        (waiting["user-2"].state, waiting["user-2"].into.as_deref()),
        ("queued", Some("user-1"))
    );
    assert_eq!(waiting["user-9"].state, "absent");

    // Taken out and written to the agent: the record says so.
    manager.take_queued_turn(&key).expect("the unit");
    record_delivery(&key, Some("user-1"), "dispatched");
    let after = ask(&["user-1", "user-2"]);
    assert_eq!(after["user-1"].state, "dispatched");
    assert_eq!(after["user-2"].state, "dispatched");
    assert_eq!(after["user-2"].into.as_deref(), Some("user-1"));

    manager.handoffs.lock().unwrap().remove(&key);
    crate::transcript::forget(&key);
}

#[test]
fn compatible_follow_ups_share_one_durable_queue_unit() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("coalesced-queue-{}", uuid::Uuid::new_v4().simple());
    manager.handoffs.lock().unwrap().insert(key.clone());

    for (text, image, turn_id) in [
        ("first detail", "/tmp/first.png", "user-1"),
        ("second detail", "/tmp/second.png", "user-2"),
        ("third detail", "/tmp/third.png", "user-3"),
    ] {
        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            text.into(),
            Some(vec![image.into()]),
            None,
            Some(turn_id.into()),
            None,
        )
        .expect("a compatible queued follow-up");
    }

    assert_eq!(
        chat_queue_state_impl(&manager, &key)
            .unwrap()
            .queued_turn_ids,
        ["user-1", "user-2", "user-3"],
    );
    let next = manager.take_queued_turn(&key).expect("one combined turn");
    assert_eq!(next.text, "first detail\nsecond detail\nthird detail");
    assert_eq!(
        next.images,
        ["/tmp/first.png", "/tmp/second.png", "/tmp/third.png"]
    );
    assert!(manager.take_queued_turn(&key).is_none());
    assert_eq!(
        chat_queue_state_impl(&manager, &key)
            .unwrap()
            .queued_turn_ids,
        Vec::<String>::new(),
    );

    let events = crate::transcript::since(&key, 0);
    let appended: Vec<_> = events
        .iter()
        .filter(|event| event.event["type"] == "octiq_user_turn_appended")
        .collect();
    assert_eq!(appended.len(), 2);
    assert_eq!(appended[0].event["uuid"], "user-1");
    assert_eq!(appended[0].event["appended_uuid"], "user-2");
    assert_eq!(appended[1].event["appended_uuid"], "user-3");

    manager.handoffs.lock().unwrap().remove(&key);
    crate::transcript::forget(&key);
}

#[test]
fn commands_internal_work_and_execution_changes_bound_combining() {
    let manager = ChatManager::default();
    let context = QueueContext::from(StartContext::for_test(ChatAgent::Codex, Some("thread")));
    let mut changed = context.clone();
    changed.access = Some(Access::Full);
    for (text, id, recorded, queued_context) in [
        ("first", Some("user-1"), true, Some(context.clone())),
        ("/review", Some("user-command"), true, Some(context.clone())),
        ("after command", Some("user-2"), true, Some(context.clone())),
        ("host notification", None, false, Some(context.clone())),
        ("after host", Some("user-3"), true, Some(context.clone())),
        ("new access", Some("user-4"), true, Some(changed)),
    ] {
        manager
            .queue_turn(
                "bounded",
                QueuedTurn {
                    text: text.into(),
                    images: vec![],
                    turn_id: id.map(str::to_string),
                    appended_turn_ids: vec![],
                    recorded,
                    context: queued_context,
                },
            )
            .unwrap();
    }

    let queued: Vec<_> = std::iter::from_fn(|| manager.take_queued_turn("bounded"))
        .map(|turn| turn.text)
        .collect();
    assert_eq!(
        queued,
        [
            "first",
            "/review",
            "after command",
            "after host",
            "new access",
            "host notification",
        ]
    );
}

#[test]
fn cancelling_by_an_appended_id_cancels_the_whole_combined_unit() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("cancel-combined-{}", uuid::Uuid::new_v4().simple());
    manager.handoffs.lock().unwrap().insert(key.clone());
    for (text, id) in [("first", "user-1"), ("second", "user-2")] {
        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            text.into(),
            None,
            None,
            Some(id.into()),
            None,
        )
        .unwrap();
    }

    assert_eq!(
        chat_cancel_queued_impl(&manager, key.clone(), "user-2".into()),
        Ok(true)
    );
    assert!(!manager.has_queued_turns(&key));
    let cancelled: Vec<_> = crate::transcript::since(&key, 0)
        .into_iter()
        .filter(|event| event.event["type"] == "octiq_user_turn_cancelled")
        .map(|event| event.event["uuid"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(cancelled, ["user-1", "user-2"]);

    manager.handoffs.lock().unwrap().remove(&key);
    crate::transcript::forget(&key);
}

#[test]
fn retrying_a_queued_turn_id_is_idempotent() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("queue-retry-{}", uuid::Uuid::new_v4().simple());
    manager.handoffs.lock().unwrap().insert(key.clone());

    for _ in 0..2 {
        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            "same request".into(),
            Some(vec!["/tmp/once.png".into()]),
            None,
            Some("user-retry".into()),
            None,
        )
        .expect("an idempotent retry");
    }

    let next = manager.take_queued_turn(&key).expect("the original turn");
    assert_eq!(next.text, "same request");
    assert_eq!(next.images, ["/tmp/once.png"]);
    assert!(manager.take_queued_turn(&key).is_none());
    assert_eq!(crate::transcript::since(&key, 0).len(), 2);

    manager.handoffs.lock().unwrap().remove(&key);
    crate::transcript::forget(&key);
}

#[test]
fn concurrent_tabs_retry_one_turn_id_exactly_once() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("queue-concurrent-retry-{}", uuid::Uuid::new_v4().simple());
    manager.handoffs.lock().unwrap().insert(key.clone());
    let ready = Arc::new(std::sync::Barrier::new(3));
    let sends: Vec<_> = (0..2)
        .map(|_| {
            let manager = manager.clone();
            let key = key.clone();
            let ready = ready.clone();
            std::thread::spawn(move || {
                ready.wait();
                chat_send_user_impl(
                    manager,
                    key,
                    "same concurrent request".into(),
                    None,
                    None,
                    Some("user-concurrent".into()),
                    None,
                )
            })
        })
        .collect();
    ready.wait();
    for send in sends {
        send.join().unwrap().unwrap();
    }

    assert_eq!(
        manager.take_queued_turn(&key).map(|turn| turn.text),
        Some("same concurrent request".into())
    );
    assert!(manager.take_queued_turn(&key).is_none());
    assert_eq!(crate::transcript::since(&key, 0).len(), 2);

    manager.handoffs.lock().unwrap().remove(&key);
    crate::transcript::forget(&key);
}

/// A persistent-provider session with a REAL pipe on its stdin, so a write
/// that should not have happened has somewhere to go rather than failing
/// for the wrong reason and passing the test anyway.
pub(super) fn claude_session(busy: bool) -> Arc<Mutex<ChatSession>> {
    let mut child = stand_in::echo()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .expect("an echo to stand in for Claude");
    let stdin = child.stdin.take();
    ChatSession::shared(child, stdin, ChatAgent::Claude, busy)
}

pub(super) fn capturing_claude_session() -> (
    Arc<Mutex<ChatSession>>,
    std::io::BufReader<std::process::ChildStdout>,
) {
    let mut child = stand_in::echo()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("an echo to capture Claude input");
    let stdin = child.stdin.take();
    let stdout = stand_in::echoed(child.stdout.take().expect("the capture pipe"));
    (
        ChatSession::shared(child, stdin, ChatAgent::Claude, true),
        stdout,
    )
}

pub(super) fn hold(manager: &ChatManager, key: &str, session: Arc<Mutex<ChatSession>>) {
    manager
        .sessions
        .lock()
        .unwrap()
        .insert(key.to_string(), session);
}

/// The send race behind "Delivery unconfirmed · no such chat": another
/// thread holds the chat's start claim and has not put its session in the
/// table yet. The send used to refuse at once, and so did the start.
#[test]
fn a_send_waits_out_a_start_in_progress_and_is_delivered_once() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("chat:send-race-{}", uuid::Uuid::new_v4().simple());
    let (claimed_tx, claimed_rx) = std::sync::mpsc::channel();
    let starter = {
        let manager = manager.clone();
        let key = key.clone();
        thread::spawn(move || {
            let claim = manager.claim_start(&key).expect("the start claim");
            claimed_tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(300));
            // The start's last step: the process goes into the table
            // while the claim is still held, the claim drops after.
            hold(&manager, &key, claude_session(false));
            drop(claim);
        })
    };
    claimed_rx.recv().unwrap();
    assert!(manager.start_in_progress(&key));
    let began = Instant::now();
    let sent = send_turn(
        manager.clone(),
        key.clone(),
        "while the start runs".into(),
        None,
        None,
        Some("user-send-race-1".into()),
    );
    assert_eq!(sent, Ok(Sent::Written));
    assert!(began.elapsed() >= Duration::from_millis(200), "it waited");
    starter.join().unwrap();
    // The page's retry of the same turn does not send it again.
    assert_eq!(
        send_turn(
            manager.clone(),
            key.clone(),
            "while the start runs".into(),
            None,
            None,
            Some("user-send-race-1".into()),
        ),
        Ok(Sent::Already)
    );
}

#[test]
fn a_send_after_a_start_that_failed_is_still_no_such_chat_and_queues_nothing() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("chat:send-race-fail-{}", uuid::Uuid::new_v4().simple());
    let (claimed_tx, claimed_rx) = std::sync::mpsc::channel();
    let starter = {
        let manager = manager.clone();
        let key = key.clone();
        thread::spawn(move || {
            let claim = manager.claim_start(&key).expect("the start claim");
            claimed_tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(300));
            drop(claim); // the start failed: no session
        })
    };
    claimed_rx.recv().unwrap();
    let sent = send_turn(
        manager.clone(),
        key.clone(),
        "while the start fails".into(),
        None,
        None,
        Some("user-send-race-2".into()),
    );
    assert_eq!(sent, Err("no such chat".into()));
    starter.join().unwrap();
    assert!(!manager.has_queued_turns(&key), "nothing is queued");
    assert!(!manager.sessions.lock().unwrap().contains_key(&key));
    // With no start in progress the refusal is immediate.
    let began = Instant::now();
    assert_eq!(
        send_turn(
            manager.clone(),
            key,
            "again".into(),
            None,
            None,
            Some("user-send-race-3".into()),
        ),
        Err("no such chat".into())
    );
    assert!(began.elapsed() < Duration::from_secs(2));
}

#[test]
fn a_roster_receipt_is_saved_only_when_the_queued_prompt_is_written() {
    let home = crate::test_dir::TestDir::new("roster-queue-delivery");
    let _profile = crate::profile::started_in(&home.0);
    let roster = home.0.join("team.json");
    let _team = crate::team::use_test_path(roster.clone());
    let lead = crate::team::save(
        &roster,
        serde_json::from_value(json!({
            "name": "Lead", "role": "Leads", "agent": "claude", "model": "sonnet",
        }))
        .unwrap(),
    )
    .unwrap();
    let key = "chat:roster-queue";
    let text =
        crate::team::brief(&roster, key, "workspace", &lead.id, "Start", false, &[]).unwrap();
    let fingerprint = || {
        crate::team::lead_for_chat(&roster, key)
            .unwrap()
            .unwrap()
            .roster_fingerprint
    };
    let manager = Arc::new(ChatManager::default());
    let (session, mut written) = capturing_claude_session();
    hold(&manager, key, session.clone());
    let send = |id: &str| {
        chat_send_user_impl(
            manager.clone(),
            key.into(),
            text.clone(),
            None,
            None,
            Some(id.into()),
            None,
        )
        .unwrap()
    };
    send("roster-cancelled");
    assert_eq!(fingerprint(), None, "queue admission is not delivery");
    assert!(chat_cancel_queued_impl(&manager, key.into(), "roster-cancelled".into()).unwrap());
    assert_eq!(fingerprint(), None, "cancelled context remains owed");
    send("roster-dispatched");
    assert_eq!(fingerprint(), None);
    {
        let mut live = session.lock().unwrap();
        live.turn_ended();
        assert_eq!(
            dispatch_next_persistent_turn(&manager, key, key, &mut live),
            None
        );
    }
    // A roster mutation can hold its lock while a write happens. The
    // receipt then stays pending, and a later actual write retries it.
    let mut echoed = String::new();
    std::io::BufRead::read_line(&mut written, &mut echoed).unwrap();
    for _ in 0..100 {
        if fingerprint().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
        {
            let mut live = session.lock().unwrap();
            live.turn_ended();
            write_user_message_locked(&manager, &mut live, key, &text, &[], Some("roster-retry"))
                .unwrap();
        }
        echoed.clear();
        std::io::BufRead::read_line(&mut written, &mut echoed).unwrap();
    }
    assert!(
        fingerprint().is_some(),
        "actual writes confirm the roster when the mutation finishes"
    );
    assert_eq!(
        crate::team::refresh_turn_brief(&roster, key, "Next".into(), &[]).unwrap(),
        "Next"
    );
    // A failed write must also leave changed context pending.
    let added = crate::team::save(&roster, serde_json::from_value(json!({
            "name": "New Report", "role": "Builds", "agent": "claude", "model": "sonnet", "reportsTo": lead.id,
        })).unwrap()).unwrap();
    let changed = crate::team::refresh_turn_brief(&roster, key, "Changed".into(), &[]).unwrap();
    let before = fingerprint();
    {
        let mut live = session.lock().unwrap();
        live.turn_ended();
        live.stdin.take();
        assert!(write_user_message_locked(
            &manager,
            &mut live,
            key,
            &changed,
            &[],
            Some("failed-write")
        )
        .is_err());
    }
    assert_eq!(fingerprint(), before);
    assert!(
        crate::team::refresh_turn_brief(&roster, key, "Retry".into(), &[])
            .unwrap()
            .contains(&added.id)
    );
    end_process(&manager, key).unwrap();
}

#[test]
fn a_message_sent_to_a_working_claude_waits_in_our_own_queue() {
    // Written to its stdin it would land in the AGENT's queue instead,
    // where nothing on this side can reach it again — which is the whole
    // reason a queued message used to be impossible to take back.
    let manager = Arc::new(ChatManager::default());
    let key = format!("claude-queue-{}", uuid::Uuid::new_v4().simple());
    hold(&manager, &key, claude_session(true));

    chat_send_user_impl(
        manager.clone(),
        key.clone(),
        "and one more thing".into(),
        None,
        None,
        Some("user-1".into()),
        None,
    )
    .expect("a follow-up to a working Claude");

    assert_eq!(
        manager.take_queued_turn(&key),
        Some(QueuedTurn {
            text: "and one more thing".into(),
            images: vec![],
            turn_id: Some("user-1".into()),
            appended_turn_ids: vec![],
            recorded: true,
            context: None,
        })
    );
    let events = crate::transcript::since(&key, 0);
    assert_eq!(events[0].event["uuid"], "user-1");
    assert_eq!(events[1].event["state"], "queued");

    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

/// An outage card in `key`'s chat, launched from a scratch project, with
/// its "Always allow in this project" rule already written.
fn allowed_outage_card(key: &str) -> (String, crate::test_dir::TestDir) {
    let project = crate::test_dir::TestDir::new("outage-send");
    crate::safety_block::remember_claude_launch(key, true, project.to_str().unwrap(), false, None);
    let denial = serde_json::json!({
        "type": "system", "subtype": "permission_denied",
        "decision_reason": "Classifier unavailable", "decision_reason_type": "classifier",
        "message": "The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. You may try the action again once, as-is.",
        "tool_name": "Bash", "tool_use_id": format!("toolu-{}", uuid::Uuid::new_v4().simple()),
    });
    assert!(crate::safety_block::observe_claude_denial(
        key,
        None,
        &denial,
        Some((
            "Bash",
            &serde_json::json!({ "command": "git push origin main" })
        ))
    ));
    let card = cards_in(key).pop().expect("the outage card");
    crate::safety_block::allow_outage(card.id(), crate::claude_allow::Scope::Project)
        .expect("the allow rule is written");
    (card.id().to_string(), project)
}

fn cards_in(key: &str) -> Vec<crate::safety_block::BlockedAction> {
    crate::safety_block::pending()
        .into_iter()
        .filter(|card| card.chat_key() == key)
        .collect()
}

fn is_pending(id: &str) -> bool {
    crate::safety_block::pending()
        .iter()
        .any(|card| card.id() == id)
}

/// A card that is not an outage card, beside the outage card in `key`.
fn judged_card(key: &str) -> String {
    let before: Vec<String> = cards_in(key).iter().map(|c| c.id().to_string()).collect();
    let denial = serde_json::json!({
        "type": "system", "subtype": "permission_denied",
        "decision_reason": "Production Deploy", "decision_reason_type": "classifier",
        "message": "Blocked.", "tool_name": "Bash",
        "tool_use_id": format!("toolu-{}", uuid::Uuid::new_v4().simple()),
    });
    assert!(crate::safety_block::observe_claude_denial(
        key,
        None,
        &denial,
        Some(("Bash", &serde_json::json!({ "command": "./deploy.sh" })))
    ));
    cards_in(key)
        .into_iter()
        .map(|c| c.id().to_string())
        .find(|id| !before.contains(id))
        .expect("the judged card")
}

/// Review finding (2f71bc6): both person-send entry points superseded the
/// chat's cards BEFORE the turn was accepted, so a start, write or queue
/// that failed after the RPC reached the host still took the outage card
/// down, recorded "superseded", and left the agent never asked to retry.
/// The retry turn names its card now, and nothing moves until the turn
/// is taken.
#[test]
fn an_outage_retry_the_chat_does_not_take_leaves_its_card_pending() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("chat:outage-fail-{}", uuid::Uuid::new_v4().simple());
    let (card, project) = allowed_outage_card(&key);
    let beside = judged_card(&key);

    // chat_send to a chat with no process.
    let sent = chat_send_answering_impl(
        manager.clone(),
        key.clone(),
        "Retry `git push origin main` once, as-is.".into(),
        None,
        None,
        Some("user-retry-1".into()),
        None,
        Some(card.clone()),
    );
    assert_eq!(sent, Err("no such chat".into()));
    assert!(is_pending(&card), "the card stays up");
    assert_eq!(crate::safety_block::decision(&card), None);
    assert!(is_pending(&beside), "nothing else is superseded either");
    let written = cards_in(&key)
        .into_iter()
        .find(|c| c.id() == card)
        .map(|c| serde_json::to_value(c).unwrap()["written"].clone());
    assert_eq!(written, Some(serde_json::json!("project")));

    // chat_start that cannot start: the key already has a process.
    hold(&manager, &key, claude_session(false));
    let started = chat_start_answering_impl(
        manager.clone(),
        key.clone(),
        project.to_string_lossy().into_owned(),
        ChatAgent::Claude,
        None,
        None,
        Some("Retry `git push origin main` once, as-is.".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some("user-retry-2".into()),
        Some(card.clone()),
    );
    assert!(started.unwrap_err().contains("already running"));
    assert!(is_pending(&card), "the card stays up");
    assert_eq!(crate::safety_block::decision(&card), None);
    assert!(is_pending(&beside));

    // chat_send that the host refuses after the RPC arrived.
    let refused = chat_send_answering_impl(
        manager.clone(),
        key.clone(),
        "Retry `git push origin main` once, as-is.".into(),
        None,
        Some("someone-else".into()),
        Some("user-retry-3".into()),
        None,
        Some(card.clone()),
    );
    assert!(refused.is_err());
    assert!(is_pending(&card));
    assert_eq!(crate::safety_block::decision(&card), None);

    // Ordinary words are unchanged: they supersede every card at once,
    // taken or not — an outage card included. Its rule is already in the
    // settings file, though, so it is recorded as that allow, never as
    // superseded (review, 2026-10-01).
    let ordinary = chat_send_user_impl(
        manager.clone(),
        key.clone(),
        "never mind, do something else".into(),
        None,
        Some("someone-else".into()),
        Some("user-4".into()),
        None,
    );
    assert!(ordinary.is_err());
    assert!(!is_pending(&card) && !is_pending(&beside));
    assert_eq!(
        crate::safety_block::decision(&card),
        Some("allowed_project")
    );
    assert_eq!(crate::safety_block::decision(&beside), Some("superseded"));

    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

#[test]
fn an_outage_retry_the_chat_takes_is_recorded_as_its_own_decision() {
    // An "Always allow in this project" whose retry is written straight to
    // an idle Claude: recorded as that allow, not "superseded". The judged
    // card beside it was up before the turn, so the turn supersedes it.
    let manager = Arc::new(ChatManager::default());
    let key = format!("chat:outage-ok-{}", uuid::Uuid::new_v4().simple());
    let (card, project) = allowed_outage_card(&key);
    let beside = judged_card(&key);
    hold(&manager, &key, claude_session(false));
    chat_send_answering_impl(
        manager.clone(),
        key.clone(),
        "Retry `git push origin main` once, as-is.".into(),
        None,
        None,
        Some("user-retry-1".into()),
        None,
        Some(card.clone()),
    )
    .expect("the retry turn is taken");
    assert!(!is_pending(&card));
    assert_eq!(
        crate::safety_block::decision(&card),
        Some("allowed_project")
    );
    assert_eq!(crate::safety_block::decision(&beside), Some("superseded"));
    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
    std::fs::remove_dir_all(project).unwrap();

    // "Retry once" into a working Claude: queued is taken, and it is
    // recorded as retried. A worker's card is answered through the main
    // chat, so the card may belong to another chat than the send.
    let main = format!("chat:outage-main-{}", uuid::Uuid::new_v4().simple());
    let worker = format!("chat:outage-worker-{}", uuid::Uuid::new_v4().simple());
    crate::safety_block::remember_claude_launch(&worker, true, "/tmp", false, None);
    let denial = serde_json::json!({
        "type": "system", "subtype": "permission_denied",
        "decision_reason": "Classifier unavailable", "decision_reason_type": "classifier",
        "message": "gave no verdict", "tool_name": "Bash", "tool_use_id": "toolu-w",
    });
    assert!(crate::safety_block::observe_claude_denial(
        &worker,
        None,
        &denial,
        Some(("Bash", &serde_json::json!({ "command": "ls | wc -l" })))
    ));
    let retried = cards_in(&worker).pop().unwrap().id().to_string();
    hold(&manager, &main, claude_session(true));
    chat_send_answering_impl(
        manager.clone(),
        main.clone(),
        "For your worker chat: retry `ls | wc -l` once.".into(),
        None,
        None,
        Some("user-retry-2".into()),
        None,
        Some(retried.clone()),
    )
    .expect("queued behind the running turn");
    assert!(!is_pending(&retried));
    assert_eq!(crate::safety_block::decision(&retried), Some("retried"));
    end_process(&manager, &main).expect("end the stand-in");
    crate::transcript::forget(&main);
}

#[test]
fn a_turn_boundary_automatically_dispatches_the_combined_prompt() {
    use std::io::BufRead;

    let manager = Arc::new(ChatManager::default());
    let key = format!("claude-auto-drain-{}", uuid::Uuid::new_v4().simple());
    let (session, mut stdout) = capturing_claude_session();
    hold(&manager, &key, session.clone());
    for (text, id) in [("first detail", "user-1"), ("second detail", "user-2")] {
        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            text.into(),
            None,
            None,
            Some(id.into()),
            None,
        )
        .unwrap();
    }

    {
        let mut running = session.lock().unwrap();
        running.turn_ended();
        assert_eq!(
            dispatch_next_persistent_turn(&manager, &key, &key, &mut running),
            None,
        );
        assert!(running.busy, "automatic drain starts the combined turn");
        assert_eq!(running.user_turn_id.as_deref(), Some("user-1"));
    }
    assert!(!manager.has_queued_turns(&key));

    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let payload: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(
        payload["message"]["content"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["text"],
        "first detail\nsecond detail"
    );

    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

#[test]
fn an_idle_claude_is_written_to_rather_than_queued() {
    // The other half of the pair. Holding a message back is a rule about a
    // turn IN FLIGHT, not a new layer between the person and the agent.
    let manager = Arc::new(ChatManager::default());
    let key = format!("claude-idle-{}", uuid::Uuid::new_v4().simple());
    hold(&manager, &key, claude_session(false));

    chat_send_user_impl(
        manager.clone(),
        key.clone(),
        "go".into(),
        None,
        None,
        Some("user-1".into()),
        None,
    )
    .expect("a message to an idle Claude");

    assert!(manager.take_queued_turn(&key).is_none());
    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

#[test]
fn stopping_the_turn_keeps_what_was_stacked_behind_it() {
    // Stop is "not that — do the thing I have already typed instead", and
    // has been for as long as there has been a Stop button: the message
    // used to go into Claude's OWN queue, which an interrupt made it pick
    // up at once. The queue is ours now, so keeping it here is what keeps
    // that. Nothing in the interrupt writes it — the reader hands it over
    // on the cut-off turn's `result` — so what this checks is that it is
    // still there to be handed over.
    let manager = Arc::new(ChatManager::default());
    let key = format!("claude-stop-{}", uuid::Uuid::new_v4().simple());
    hold(&manager, &key, claude_session(true));

    chat_send_user_impl(
        manager.clone(),
        key.clone(),
        "and then this".into(),
        None,
        None,
        Some("user-1".into()),
        None,
    )
    .expect("a follow-up to a working Claude");

    chat_interrupt_impl(&manager, key.clone()).expect("stop the turn");

    assert_eq!(
        manager.take_queued_turn(&key).map(|turn| turn.text),
        Some("and then this".into()),
        "the message behind a stopped turn is still waiting to be sent",
    );
    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

#[test]
fn starting_an_appended_message_interrupts_for_the_whole_combined_unit() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("claude-start-queued-{}", uuid::Uuid::new_v4().simple());
    let session = claude_session(true);
    hold(&manager, &key, session.clone());

    for (text, turn_id) in [("first", "user-1"), ("send this now", "user-2")] {
        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            text.into(),
            None,
            None,
            Some(turn_id.into()),
            None,
        )
        .expect("a queued follow-up");
    }

    assert_eq!(
        chat_start_queued_impl(&manager, key.clone(), "user-2".into()),
        Ok(true)
    );
    assert!(
        !session.lock().unwrap().busy,
        "the current turn was interrupted so the promoted one can start"
    );
    let order: Vec<String> = std::iter::from_fn(|| manager.take_queued_turn(&key))
        .map(|turn| turn.text)
        .collect();
    assert_eq!(order, ["first\nsend this now"]);

    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

/// Feedback 531f1dac: a coordinator's pause reached a worker 15–20
/// minutes late, after the render it was meant to stop. Interrupting cuts
/// the turn short, and no host notification goes in until the cut-off
/// turn's own full stop has come back.
#[test]
fn a_coordinator_interrupt_cuts_a_busy_worker_turn_and_holds_notifications_until_its_full_stop() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("worker-interrupt-{}", uuid::Uuid::new_v4().simple());
    assert_eq!(
        interrupt_worker_turn(&manager, &key),
        Ok(WorkerInterrupt::Idle),
        "no process: the message waits for the next launch"
    );
    let session = claude_session(true);
    hold(&manager, &key, session.clone());
    assert!(!manager.notification_ready(&key), "a turn is in flight");

    assert_eq!(
        interrupt_worker_turn(&manager, &key),
        Ok(WorkerInterrupt::Interrupted)
    );
    assert!(!session.lock().unwrap().busy);
    assert!(
        !manager.notification_ready(&key),
        "the cut-off turn has not sent its full stop yet"
    );
    // The reader clears it on that full stop.
    end_turn_locked(&manager, &key, &key, &mut session.lock().unwrap(), false);
    assert!(manager.notification_ready(&key));
    assert_eq!(
        interrupt_worker_turn(&manager, &key),
        Ok(WorkerInterrupt::Idle),
        "an idle worker is not interrupted again"
    );
    assert!(manager.notification_ready(&key));

    // A full stop that never comes holds delivery for the grace, and no
    // clock lets a notification into a process that has not stopped:
    // the grace ends the process, and the notification then meets a chat
    // with none, as after any exit.
    session.lock().unwrap().busy = true;
    assert_eq!(
        interrupt_worker_turn(&manager, &key),
        Ok(WorkerInterrupt::Interrupted)
    );
    let CutOff::Owed(unwind) = session.lock().unwrap().cut_off else {
        panic!("the Stop is being waited out");
    };
    assert!(!manager.notification_ready(&key));
    assert!(grace_ran_out(&manager, &key, &key, &session, unwind));
    assert!(!manager.has_process(&key));
    assert!(
        session.lock().unwrap().stdin.is_none(),
        "nothing more goes in"
    );
    assert!(manager.notification_ready(&key));

    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

/// A Claude stand-in session whose first prompt is held for the worker's
/// browser server, and the gate that holds it.
fn held_first_turn() -> (
    Arc<ChatManager>,
    String,
    Arc<Mutex<ChatSession>>,
    std::io::BufReader<std::process::ChildStdout>,
    Arc<crate::codex_mcp_ready::McpReady>,
) {
    let manager = Arc::new(ChatManager::default());
    let key = format!("held-first-turn-{}", uuid::Uuid::new_v4().simple());
    let (session, heard) = capturing_claude_session();
    session.lock().unwrap().first_turn_held = true;
    hold(&manager, &key, session.clone());
    let ready = crate::codex_mcp_ready::McpReady::new("playwright");
    (manager, key, session, heard, ready)
}

/// Runs `hand_over_first_turn` on its own thread, as the launch does.
fn hand_over_in_background(
    manager: &Arc<ChatManager>,
    key: &str,
    session: &Arc<Mutex<ChatSession>>,
    ready: &Arc<crate::codex_mcp_ready::McpReady>,
) -> thread::JoinHandle<()> {
    let (manager, session, ready, key) = (
        manager.clone(),
        session.clone(),
        ready.clone(),
        key.to_string(),
    );
    thread::spawn(move || {
        hand_over_first_turn(
            &manager,
            &session,
            &ready,
            ChatAgent::Claude,
            FirstTurn {
                text: "FIRST PROMPT",
                images: &[],
                key: &key,
                session_key: &key,
                turn_id: Some("first-turn"),
            },
        );
    })
}

/// A stand-in whose stdin is a pipe nobody reads: the first write to it
/// fails with a broken pipe.
fn session_with_a_broken_pipe() -> Arc<Mutex<ChatSession>> {
    let (session, _heard) = capturing_claude_session();
    let mut gone = stand_in::echo()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .expect("a stand-in");
    let stdin = gone.stdin.take();
    gone.kill().expect("kill it");
    gone.wait().expect("reap it");
    {
        let mut guard = session.lock().unwrap();
        guard.stdin = stdin;
        guard.first_turn_held = true;
    }
    session
}

fn settled(ready: &crate::codex_mcp_ready::McpReady) {
    ready.observe(&json!({
        "method": "mcpServer/startupStatus/updated",
        "params": { "name": "playwright", "status": "ready" }
    }));
}

fn hand_over_now(
    manager: &Arc<ChatManager>,
    key: &str,
    session: &Arc<Mutex<ChatSession>>,
    ready: &crate::codex_mcp_ready::McpReady,
) {
    hand_over_first_turn(
        manager,
        session,
        ready,
        ChatAgent::Claude,
        FirstTurn {
            text: "FIRST PROMPT",
            images: &[],
            key,
            session_key: key,
            turn_id: Some("first-turn"),
        },
    );
}

/// Review round 2 of 53ab881b (H1): a first write that failed ended
/// whatever process was under the chat's KEY, so a Stop followed by a new
/// launch of the same chat had its new process killed by the old launch's
/// thread. Every effect is bound to the launch the thread was made for.
#[test]
fn a_stale_hand_over_thread_cannot_end_a_newer_launch_of_the_chat() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("stale-hand-over-{}", uuid::Uuid::new_v4().simple());
    // The old launch was stopped (it is no longer in the table) and a new
    // one of the same chat is running under the same key.
    let old = session_with_a_broken_pipe();
    let (new, _heard) = capturing_claude_session();
    hold(&manager, &key, new.clone());
    let ready = crate::codex_mcp_ready::McpReady::new("playwright");
    settled(&ready);

    hand_over_now(&manager, &key, &old, &ready);

    assert!(
        manager.has_process(&key),
        "the new launch is still the process of the chat"
    );
    {
        let mut guard = new.lock().unwrap();
        assert_eq!(guard.cut_off, CutOff::No, "the new launch was not stopped");
        assert!(guard.stdin.is_some());
        assert!(guard.child.try_wait().unwrap().is_none(), "still running");
    }
    assert!(!old.lock().unwrap().first_turn_held);
    // The same bound holds for the door itself.
    assert_eq!(end_process_of_launch(&manager, &key, &old), Ok(false));
    assert!(manager.has_process(&key));
    assert_eq!(end_process_of_launch(&manager, &key, &new), Ok(true));
    assert!(!manager.has_process(&key));
}

/// The other half of H1: when the failed launch IS the one under the key,
/// it is ended, as before.
#[test]
fn a_first_prompt_that_cannot_be_written_ends_its_own_launch() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("own-hand-over-{}", uuid::Uuid::new_v4().simple());
    let own = session_with_a_broken_pipe();
    hold(&manager, &key, own.clone());
    let ready = crate::codex_mcp_ready::McpReady::new("playwright");
    settled(&ready);

    hand_over_now(&manager, &key, &own, &ready);

    assert!(
        !manager.has_process(&key),
        "the launch that failed is ended"
    );
    assert_eq!(own.lock().unwrap().cut_off, CutOff::Ended);
    crate::transcript::forget(&key);
}

/// Review round 2 of 53ab881b (M2): if the hand-over thread cannot be made
/// the launch must not be left busy and holding interrupts forever. It is
/// ended, with a diagnostics line, and only if it is still the launch.
#[test]
fn a_hand_over_thread_that_cannot_start_ends_the_launch_with_a_diagnostics_line() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("no-thread-{}", uuid::Uuid::new_v4().simple());
    let (session, _heard) = capturing_claude_session();
    session.lock().unwrap().first_turn_held = true;
    hold(&manager, &key, session.clone());
    let turn = || FirstTurn {
        text: "",
        images: &[],
        key: &key,
        session_key: &key,
        turn_id: Some("first-turn"),
    };

    // A launch that is no longer the one under the key is left alone.
    let (other, _heard) = capturing_claude_session();
    give_up_first_turn(&manager, &other, ChatAgent::Claude, &turn(), "stale");
    assert!(manager.has_process(&key));

    give_up_first_turn(
        &manager,
        &session,
        ChatAgent::Claude,
        &turn(),
        "could not start the thread that gives the worker its first prompt: boom",
    );
    assert!(!manager.has_process(&key));
    let guard = session.lock().unwrap();
    assert!(!guard.first_turn_held);
    assert_eq!(guard.cut_off, CutOff::Ended);
    drop(guard);
    let log = std::fs::read_to_string(crate::diagnostics::log_path().unwrap())
        .expect("the diagnostics log");
    assert!(
        log.lines().any(|line| line.contains(&key)
            && line.contains("\"kind\":\"first-turn\"")
            && line.contains("boom")),
        "a diagnostics line for the launch"
    );
}

/// Review round 2 of 53ab881b (H2): the delivery line was written while
/// the session lock was held, so a slow save kept Stop waiting. A FIFO
/// stands where the record is, so its append never finishes until this
/// test lets it: Stop must act meanwhile.
#[cfg(unix)]
#[test]
fn stop_does_not_wait_on_a_blocked_save_of_the_delivery_line() {
    let (manager, key, session, mut heard, ready) = held_first_turn();
    let path = crate::transcript::path_for(&key).unwrap();
    let _ = std::fs::remove_file(&path);
    assert!(std::process::Command::new("mkfifo")
        .arg(&path)
        .status()
        .unwrap()
        .success());
    settled(&ready);
    let waiting = hand_over_in_background(&manager, &key, &session, &ready);

    // The first prompt was written (under the lock) ...
    let mut line = String::new();
    std::io::BufRead::read_line(&mut heard, &mut line).expect("the first line");
    assert!(line.contains("FIRST PROMPT"), "{line}");
    // ... and the save of its delivery line is now stuck on the FIFO.
    thread::sleep(Duration::from_millis(400));
    assert!(!waiting.is_finished(), "the save is blocked");
    let lock_free = session.try_lock().is_ok();
    // Stop on its own thread, so a Stop that waits on the save fails this
    // test instead of hanging it.
    let (stopped, stop_done) = std::sync::mpsc::channel();
    let stop = {
        let (manager, key) = (manager.clone(), key.clone());
        thread::spawn(move || {
            let started = Instant::now();
            let ended = end_process(&manager, &key);
            let _ = stopped.send((ended, started.elapsed()));
        })
    };
    let outcome = stop_done.recv_timeout(Duration::from_millis(1500));

    // Let the save go. A reader that never blocks satisfies the append's
    // open, and a short-lived writer gives the record's count its EOF.
    use std::os::unix::fs::OpenOptionsExt;
    let reader = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&path)
        .expect("open the fifo for reading");
    drop(
        std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&path)
            .expect("open the fifo for writing"),
    );
    stop.join().expect("the stop finished");
    assert!(lock_free, "the session lock is not held across the save");
    let (ended, took) = outcome.expect("Stop waited on the save of the delivery line");
    assert_eq!(ended, Ok(true));
    assert!(took < Duration::from_millis(500), "Stop took {took:?}");
    waiting.join().expect("the hand-over finished");
    drop(reader);
    let _ = std::fs::remove_file(&path);
    crate::transcript::forget(&key);
}

/// Review round 1 of 05202d74 (H3): an interrupt during the first-turn
/// wait set `CutOff::Owed`, the write that followed was refused as "still
/// stopping", and the attempt failed with no retry. There is no turn in
/// flight to cut short: nothing is written, nothing is owed, the attempt
/// stays active, and the first prompt still goes, ahead of anything else.
#[test]
fn an_interrupt_during_the_first_turn_wait_neither_cuts_nor_fails_anything() {
    let (manager, key, session, mut heard, ready) = held_first_turn();
    let waiting = hand_over_in_background(&manager, &key, &session, &ready);

    // The coordinator's interrupt, and the Stop button.
    assert_eq!(
        interrupt_worker_turn(&manager, &key),
        Ok(WorkerInterrupt::Idle),
        "no turn is in flight: the message goes in between turns, behind the first prompt"
    );
    let stopped = chat_interrupt_impl(&manager, key.clone()).expect("not an error");
    assert!(stopped.stopped);
    {
        let guard = session.lock().unwrap();
        assert_eq!(guard.cut_off, CutOff::No, "nothing to unwind");
        assert!(guard.busy, "still the worker's first turn");
        assert!(guard.first_turn_held);
        assert!(guard.stdin.is_some());
    }

    // The server settles: the first prompt goes, and it is the FIRST
    // line the agent hears, so no interrupt went before it.
    ready.observe(&json!({
        "method": "mcpServer/startupStatus/updated",
        "params": { "name": "playwright", "status": "ready" }
    }));
    waiting.join().expect("the hand-over finished");
    let mut line = String::new();
    std::io::BufRead::read_line(&mut heard, &mut line).expect("the first line");
    assert!(line.contains("FIRST PROMPT"), "{line}");
    assert!(!line.contains("interrupt"), "{line}");
    let guard = session.lock().unwrap();
    assert!(!guard.first_turn_held);
    assert!(guard.busy, "the first turn is now in flight");
    assert_eq!(guard.cut_off, CutOff::No);
    drop(guard);

    // From here an interrupt is an ordinary one.
    assert_eq!(
        interrupt_worker_turn(&manager, &key),
        Ok(WorkerInterrupt::Interrupted)
    );
    end_process(&manager, &key).expect("end the stand-in");
}

/// (H2) Stop acts at once during the wait, and the first prompt is never
/// written: the process is ended, its output closes (the reader calls
/// `McpReady::close`) and the waiting thread leaves without writing.
#[test]
fn a_stop_during_the_first_turn_wait_means_the_first_prompt_is_never_written() {
    let (manager, key, session, mut heard, ready) = held_first_turn();
    let waiting = hand_over_in_background(&manager, &key, &session, &ready);

    let started = Instant::now();
    assert_eq!(end_process(&manager, &key), Ok(true));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "Stop does not wait for the browser server: {:?}",
        started.elapsed()
    );
    // What the reader thread does when the killed process's output ends.
    ready.close();
    waiting.join().expect("the hand-over finished");

    let mut line = String::new();
    let read = std::io::BufRead::read_line(&mut heard, &mut line).expect("end of output");
    assert_eq!(read, 0, "nothing was written to the stopped agent: {line}");
    assert!(!session.lock().unwrap().first_turn_held);
    assert!(!manager.has_process(&key));
}

/// (H2) A process that is already gone when the server settles gets no
/// prompt either, and a late `ready` after a Stop writes nothing.
#[test]
fn a_first_prompt_is_not_written_into_a_session_that_was_ended() {
    let (manager, key, session, mut heard, ready) = held_first_turn();
    assert_eq!(end_process(&manager, &key), Ok(true));
    ready.observe(&json!({
        "method": "mcpServer/startupStatus/updated",
        "params": { "name": "playwright", "status": "ready" }
    }));
    hand_over_in_background(&manager, &key, &session, &ready)
        .join()
        .expect("the hand-over finished");
    let mut line = String::new();
    assert_eq!(
        std::io::BufRead::read_line(&mut heard, &mut line).unwrap(),
        0,
        "{line}"
    );
}

/// Feedback 240ea516: the interrupt came back "interrupted" and seconds
/// later the host failed the attempt on the cut-off turn's own full stop,
/// which Claude spells as a failed `result`. The attempt stays active and
/// the coordinator's message opens the worker's next turn. The stream is
/// a real one, interrupted while a Bash call ran.
#[test]
fn a_coordinator_interrupt_keeps_a_claude_workers_attempt_and_its_message_opens_the_next_turn() {
    use crate::orchestration::tests::{claude_interrupted_tool, run, running_worker_on};
    use crate::orchestration::AttemptStatus;
    use std::io::BufRead;

    let manager = Arc::new(ChatManager::default());
    let store = manager.orchestrations.clone();
    let run = run(&store);
    let worker = running_worker_on(&store, &run, ChatAgent::Claude);
    let key = worker.worker_chat_key.clone();
    let (session, mut stdout) = capturing_claude_session();
    hold(&manager, &key, session.clone());
    let attempt = || {
        store
            .snapshot(None)
            .unwrap()
            .attempts
            .into_iter()
            .find(|a| a.id == worker.id)
            .unwrap()
    };
    let events = claude_interrupted_tool();
    let called = events
        .iter()
        .position(|e| e["type"] == "assistant" && e["message"]["content"][0]["type"] == "tool_use")
        .expect("the Bash call");
    let cut = events
        .iter()
        .position(|e| e["type"] == "result")
        .expect("the cut-off turn's full stop");
    for event in &events[..=called] {
        manager
            .observe_for_orchestration(&session, &key, event)
            .unwrap();
    }
    assert_eq!(attempt().execution.pending_tools.len(), 1, "mid tool call");

    let message = store
        .record_message(
            &run.coordinator_chat_key,
            run.id.clone(),
            worker.id.clone(),
            "instruction".into(),
            "Pause".into(),
            "Stop the render.".into(),
        )
        .unwrap();
    assert_eq!(
        interrupt_worker_turn(&manager, &key),
        Ok(WorkerInterrupt::Interrupted)
    );
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let sent: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(sent["request"]["subtype"], "interrupt");

    // What Claude then says: the cancelled call, and a failed `result`.
    for event in &events[called + 1..=cut] {
        manager
            .observe_for_orchestration(&session, &key, event)
            .unwrap();
    }
    let after = attempt();
    assert_eq!(after.status, AttemptStatus::Running, "not failed");
    assert!(after.execution.latest_error.is_none());
    assert!(after.execution.pending_tools.is_empty());
    assert!(store.message_waiting(&message.id), "not cancelled");
    let note = store
        .due_notifications(i64::MAX)
        .unwrap()
        .into_iter()
        .find(|n| n.target_chat_key == key)
        .expect("the message is still owed to the worker");
    assert_eq!(
        deliver_orchestration_notification(manager.clone(), &note, Default::default()),
        Ok(false),
        "not before the reader has seen the full stop"
    );

    // The reader clears the mark on that full stop; the message goes in.
    end_turn_locked(&manager, &key, &key, &mut session.lock().unwrap(), false);
    assert_eq!(
        deliver_orchestration_notification(manager.clone(), &note, Default::default()),
        Ok(true)
    );
    assert!(session.lock().unwrap().busy, "the next turn has started");
    line.clear();
    stdout.read_line(&mut line).unwrap();
    assert!(line.contains("Stop the render."), "{line}");

    // That turn runs to its ordinary full stop on the same attempt, and a
    // failure in it is no longer excused by the interrupt before it.
    for event in &events[cut + 1..] {
        manager
            .observe_for_orchestration(&session, &key, event)
            .unwrap();
    }
    assert_eq!(attempt().status, AttemptStatus::Running);
    manager
        .observe_for_orchestration(&session, &key, &events[cut])
        .unwrap();
    assert_eq!(
        attempt().status,
        AttemptStatus::Running,
        "an abort the result names itself is still a cut"
    );
    let mut broke = events[cut].clone();
    broke.as_object_mut().unwrap().remove("terminal_reason");
    manager
        .observe_for_orchestration(&session, &key, &broke)
        .unwrap();
    assert_eq!(attempt().status, AttemptStatus::Failed);

    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

/// Stopping a provider that takes no control message would end its
/// process, which fails the attempt; that is the coordinator's run_stop,
/// not a message.
#[test]
fn a_worker_that_cannot_be_interrupted_keeps_its_process() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("worker-no-interrupt-{}", uuid::Uuid::new_v4().simple());
    let session = claude_session(true);
    session.lock().unwrap().agent = ChatAgent::Antigravity;
    hold(&manager, &key, session.clone());

    assert_eq!(
        interrupt_worker_turn(&manager, &key),
        Ok(WorkerInterrupt::Unsupported)
    );
    assert!(session.lock().unwrap().busy);
    assert!(manager.sessions.lock().unwrap().contains_key(&key));

    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

#[test]
fn starting_a_message_the_agent_already_took_is_an_honest_noop() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("claude-start-gone-{}", uuid::Uuid::new_v4().simple());
    let session = claude_session(true);
    hold(&manager, &key, session.clone());

    assert_eq!(
        chat_start_queued_impl(&manager, key.clone(), "already-gone".into()),
        Ok(false)
    );
    assert!(
        session.lock().unwrap().busy,
        "a stale click must not interrupt the turn now in flight"
    );

    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

#[test]
fn the_person_turn_is_the_whole_message_in_flight_and_only_theirs() {
    use crate::orchestration::SeenPlan;
    let manager = Arc::new(ChatManager::default());
    let key = format!("claude-person-turn-{}", uuid::Uuid::new_v4().simple());
    let session = claude_session(true);
    hold(&manager, &key, session.clone());
    let seen = |revision| {
        vec![SeenPlan {
            run_id: "run_a".into(),
            revision,
        }]
    };

    // Two messages queued behind a running turn become one unit, and so
    // does what the host knows of them: "approve" is not read alone.
    for (text, turn, revision) in [
        ("approve this plan", "user-1", 3),
        ("but change the branch", "user-2", 4),
    ] {
        manager.note_person_turn(&key, turn, text, seen(revision));
        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            text.into(),
            None,
            None,
            Some(turn.into()),
            None,
        )
        .expect("queued behind the running turn");
    }
    // Nothing the person sent is being answered yet.
    assert_eq!(manager.person_turn(&key), None);
    {
        let mut running = session.lock().unwrap();
        running.turn_ended();
        assert_eq!(
            dispatch_next_persistent_turn(&manager, &key, &key, &mut running),
            None
        );
    }
    let turn = manager.person_turn(&key).expect("the person's own message");
    assert_eq!(turn.turn_id, "user-1");
    assert_eq!(turn.text, "approve this plan\nbut change the branch");
    // Each part keeps what it saw; the later look is not merged into the
    // earlier words.
    assert_eq!(turn.parts_seen, vec![seen(3), seen(4)]);
    // A retried send keeps the words first recorded.
    manager.note_person_turn(&key, "user-1", "approve", Vec::new());
    assert_eq!(
        manager.person_turn(&key).unwrap().text,
        "approve this plan\nbut change the branch"
    );

    // Another chat's evidence is not this chat's.
    assert_eq!(manager.person_turn("chat:elsewhere"), None);

    // A host notification is the next turn: nobody typed it.
    {
        let mut running = session.lock().unwrap();
        running.turn_ended();
        write_user_message_locked(
            &manager,
            &mut running,
            &key,
            "notification",
            &[],
            Some("notif_1"),
        )
        .unwrap();
    }
    assert_eq!(manager.person_turn(&key), None);

    // A host continuation carries no id at all.
    manager.note_person_turn(&key, "user-3", "approve", seen(4));
    {
        let mut running = session.lock().unwrap();
        running.turn_ended();
        write_user_message_locked(&manager, &mut running, &key, "approve", &[], Some("user-3"))
            .unwrap();
    }
    assert!(manager.person_turn(&key).is_some());
    {
        let mut running = session.lock().unwrap();
        running.turn_ended();
        // Between turns the chat is answering nothing.
        assert!(!running.busy);
    }
    assert_eq!(manager.person_turn(&key), None);
    {
        let mut running = session.lock().unwrap();
        write_user_message_locked(&manager, &mut running, &key, "gate answered", &[], None)
            .unwrap();
    }
    assert_eq!(manager.person_turn(&key), None);

    // Only the host's person turn ids are ever recorded.
    manager.note_person_turn(&key, "notif_2", "approve", seen(4));
    {
        let mut running = session.lock().unwrap();
        running.turn_ended();
        write_user_message_locked(
            &manager,
            &mut running,
            &key,
            "approve",
            &[],
            Some("notif_2"),
        )
        .unwrap();
    }
    assert_eq!(manager.person_turn(&key), None);

    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

#[test]
fn a_send_in_the_gap_after_a_stop_does_not_jump_the_queue() {
    // The interrupt ends the turn immediately, so until the agent's own
    // `result` lands the session reads idle with a message still stacked
    // behind it. An ordinary send arriving in that window must go BEHIND
    // it, not straight down the stdin it is waiting for.
    let manager = Arc::new(ChatManager::default());
    let key = format!("claude-gap-{}", uuid::Uuid::new_v4().simple());
    let session = claude_session(true);
    hold(&manager, &key, session.clone());

    for (text, turn) in [("first", "user-1"), ("second", "user-2")] {
        chat_send_user_impl(
            manager.clone(),
            key.clone(),
            text.into(),
            None,
            None,
            Some(turn.into()),
            None,
        )
        .expect("a follow-up to a working Claude");
    }
    chat_interrupt_impl(&manager, key.clone()).expect("stop the turn");
    assert!(
        !session.lock().unwrap().busy,
        "the stop ended the turn, which is the gap this is about",
    );

    chat_send_user_impl(
        manager.clone(),
        key.clone(),
        "third".into(),
        None,
        None,
        Some("user-3".into()),
        None,
    )
    .expect("a message sent into the gap");

    let order: Vec<String> = std::iter::from_fn(|| manager.take_queued_turn(&key))
        .map(|turn| turn.text)
        .collect();
    assert_eq!(
        order,
        ["first\nsecond\nthird"],
        "compatible sends share the next automatic turn"
    );
    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

#[test]
fn stopping_codex_keeps_its_queue_on_the_native_thread() {
    let manager = Arc::new(ChatManager::default());
    let key = "codex-stop-queue";
    let mut child = stand_in::echo()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .expect("a Codex app-server stand-in");
    let stdin = child.stdin.take();
    let session = Arc::new(Mutex::new(ChatSession {
        codex: Some(CodexAppSession::standing_in(
            "thread-1",
            Some("turn-1"),
            Access::Read,
        )),
        ..ChatSession::standing_in(child, stdin, ChatAgent::Codex, true)
    }));
    manager
        .sessions
        .lock()
        .unwrap()
        .insert(key.into(), session.clone());
    manager
        .queue_turn(
            key,
            QueuedTurn {
                text: "instead, do this".into(),
                images: Vec::new(),
                turn_id: Some("user-1".into()),
                appended_turn_ids: vec![],
                recorded: true,
                context: None,
            },
        )
        .expect("a message behind the running turn");

    chat_interrupt_impl(&manager, key.into()).expect("native Codex can be interrupted");
    assert!(chat_list_impl(&manager).unwrap().contains(&key.to_string()));
    assert!(
        manager.has_queued_turns(key),
        "the queued turn waits for Codex's turn/completed notification",
    );
    end_process(&manager, key).unwrap();
    let _ = session.lock().unwrap().child.wait();
}

#[test]
fn a_cancelled_claude_turn_is_gone_and_cancelling_again_says_so() {
    let manager = Arc::new(ChatManager::default());
    let key = format!("claude-cancel-{}", uuid::Uuid::new_v4().simple());
    hold(&manager, &key, claude_session(true));

    chat_send_user_impl(
        manager.clone(),
        key.clone(),
        "forget it".into(),
        None,
        None,
        Some("user-1".into()),
        None,
    )
    .expect("a follow-up to a working Claude");

    assert_eq!(
        chat_cancel_queued_impl(&manager, key.clone(), "user-1".into()),
        Ok(true)
    );
    assert!(manager.take_queued_turn(&key).is_none());
    let events = crate::transcript::since(&key, 0);
    assert_eq!(events.len(), 3);
    assert_eq!(events[2].event["type"], "octiq_user_turn_cancelled");
    // The queue is FIFO and the agent may already have been handed it. That
    // is a race nobody can win, and the page has to be told rather than
    // shown a bubble vanishing from under an answer to it.
    assert_eq!(
        chat_cancel_queued_impl(&manager, key.clone(), "user-1".into()),
        Ok(false)
    );

    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

#[test]
fn cancelling_a_codex_turn_takes_it_back_out_of_the_transcript() {
    // Codex's queued prompt IS written down at send — it is accepted the
    // moment it enters the queue. So this is the one that has something to
    // undo, and the record is append-only: "out" is one more line saying so.
    let manager = Arc::new(ChatManager::default());
    let key = format!("codex-cancel-{}", uuid::Uuid::new_v4().simple());
    let child = stand_in::still()
        .stdin(Stdio::null())
        .spawn()
        .expect("a Codex stand-in");
    hold(
        &manager,
        &key,
        ChatSession::shared(child, None, ChatAgent::Codex, true),
    );

    chat_send_user_impl(
        manager.clone(),
        key.clone(),
        "never mind".into(),
        None,
        None,
        Some("user-1".into()),
        None,
    )
    .expect("a queued Codex user turn");
    assert_eq!(crate::transcript::since(&key, 0).len(), 2);

    assert_eq!(
        chat_cancel_queued_impl(&manager, key.clone(), "user-1".into()),
        Ok(true)
    );
    assert!(manager.take_queued_turn(&key).is_none());
    let events = crate::transcript::since(&key, 0);
    assert_eq!(events.len(), 3);
    assert_eq!(events[2].event["type"], "octiq_user_turn_cancelled");
    assert_eq!(events[1].event["uuid"], "user-1");

    end_process(&manager, &key).expect("end the stand-in");
    crate::transcript::forget(&key);
}

#[test]
fn dismissing_a_lost_turn_is_durable_but_never_removes_a_live_queue() {
    let manager = ChatManager::default();
    let key = format!("dismiss-unsent-{}", uuid::Uuid::new_v4().simple());

    assert_eq!(
        chat_dismiss_unsent_impl(&manager, key.clone(), "lost-1".into()),
        Ok(true)
    );
    let events = crate::transcript::since(&key, 0);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event["type"], "octiq_user_turn_dismissed");
    assert_eq!(events[0].event["uuid"], "lost-1");

    manager
        .queue_turn(
            &key,
            QueuedTurn {
                text: "still waiting".into(),
                images: Vec::new(),
                turn_id: Some("queued-1".into()),
                appended_turn_ids: vec![],
                recorded: true,
                context: None,
            },
        )
        .expect("a live queued turn");
    assert_eq!(
        chat_dismiss_unsent_impl(&manager, key.clone(), "queued-1".into()),
        Ok(false)
    );
    assert_eq!(crate::transcript::since(&key, 0).len(), 1);
    assert_eq!(
        manager.take_queued_turn(&key).and_then(|turn| turn.turn_id),
        Some("queued-1".into())
    );

    crate::transcript::forget(&key);
}

#[test]
fn dismissing_a_turn_the_agent_took_up_is_refused_and_writes_nothing() {
    let manager = ChatManager::default();
    let key = format!("dismiss-picked-{}", uuid::Uuid::new_v4().simple());
    for event in [
        json!({"type": "user", "uuid": "answered", "octiq_user_turn": true,
                   "message": {"content": "hi"}}),
        json!({"type": "octiq_user_turn_delivery", "uuid": "answered", "state": "dispatched"}),
        json!({"type": "user", "isReplay": true, "octiq_user_turn_id": "answered",
                   "message": {"content": "hi"}}),
        json!({"type": "assistant", "message": {"content": "done"}}),
    ] {
        crate::transcript::append(&key, &event).unwrap();
    }
    assert_eq!(
        chat_dismiss_unsent_impl(&manager, key.clone(), "answered".into()),
        Ok(false)
    );
    assert_eq!(
        crate::transcript::since(&key, 0).len(),
        4,
        "no line was written"
    );

    // A turn the host never delivered still dismisses, durably.
    crate::transcript::append(
        &key,
        &json!({"type": "octiq_user_turn_delivery", "uuid": "lost", "state": "failed"}),
    )
    .unwrap();
    assert_eq!(
        chat_dismiss_unsent_impl(&manager, key.clone(), "lost".into()),
        Ok(true)
    );
    let last = crate::transcript::since(&key, 0).pop().unwrap().event;
    assert_eq!(
        (last["type"].as_str(), last["uuid"].as_str()),
        (Some("octiq_user_turn_dismissed"), Some("lost"))
    );
    crate::transcript::forget(&key);
}

#[test]
fn interrupting_codex_keeps_its_app_server_and_native_thread() {
    let manager = Arc::new(ChatManager::default());
    let key = "codex-interrupt";
    let thread = "01a0142d-552d-7a93-9152-47530c33e501";
    manager.remember_start(
        key,
        StartContext {
            defaults: None,
            cwd: "/tmp".into(),
            agent: ChatAgent::Codex,
            model: None,
            access: Some(Access::Read),
            extra_dirs: None,
            env: None,
            effort: None,
            lite: Some(false),
            session_id: Some(thread.into()),
        },
    );
    let mut child = stand_in::echo()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .expect("a Codex app-server stand-in");
    let stdin = child.stdin.take();
    let session = Arc::new(Mutex::new(ChatSession {
        codex: Some(CodexAppSession::standing_in(
            thread,
            Some("turn-1"),
            Access::Read,
        )),
        ..ChatSession::standing_in(child, stdin, ChatAgent::Codex, true)
    }));
    manager
        .sessions
        .lock()
        .unwrap()
        .insert(key.into(), session.clone());

    chat_interrupt_impl(&manager, key.into()).expect("Codex can be stopped");

    assert_eq!(chat_list_impl(&manager).unwrap(), [key]);
    assert_eq!(
        manager
            .start_context(key)
            .and_then(|start| start.session_id),
        Some(thread.into()),
        "the next message resumes the interrupted Codex conversation"
    );
    assert!(session.lock().unwrap().child.try_wait().unwrap().is_none());
    end_process(&manager, key).unwrap();
    let _ = session.lock().unwrap().child.wait();
}

#[test]
fn only_real_image_extensions_are_offered_to_the_model() {
    assert_eq!(image_media_type("/tmp/a.PNG"), Some("image/png"));
    assert_eq!(image_media_type("/tmp/a.jpeg"), Some("image/jpeg"));
    assert_eq!(image_media_type("/tmp/a.webp"), Some("image/webp"));
    // Not an image: passing it on would be an API error, so it is dropped.
    assert_eq!(image_media_type("/tmp/notes.md"), None);
    assert_eq!(image_media_type("/tmp/noextension"), None);
}

#[test]
fn a_projects_other_folders_are_added_for_both_agents() {
    let dirs = vec!["/Users/me/api".to_string(), "/Users/me/my docs".to_string()];
    let c = build_command(
        ChatAgent::Claude,
        None,
        None,
        "",
        None,
        &dirs,
        None,
        &[],
        false,
    );
    assert!(c.contains("--add-dir '/Users/me/api'"));
    // A space in a folder name stays one argument.
    assert!(c.contains("--add-dir '/Users/me/my docs'"));

    // Codex app-server receives the same folders as typed workspace roots.
    let mut roots = vec!["/Users/me/project".into()];
    roots.extend(dirs.clone());
    let request = crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
        cwd: "/Users/me/project",
        model: None,
        effort: None,
        access: None,
        resume: None,
        workspace_roots: &roots,
        developer_instructions: "host",
    });
    assert_eq!(request["params"]["runtimeWorkspaceRoots"], json!(roots));
}

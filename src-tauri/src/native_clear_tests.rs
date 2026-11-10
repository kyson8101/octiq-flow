//! /clear revokes native memory independently of the display record.
use super::*;
use crate::dispatch::{dispatch, Services};

fn meta(key: &str, lead: bool) -> crate::chat_index::ChatMeta {
    serde_json::from_value(json!({
        "id":key.trim_start_matches("chat:"), "projectId":"project",
        "title":"Keep this title", "leadOf":lead.then(|| format!("registered-{key}")),
        "sessionId":"old-native", "cwd":"/saved/project",
        "modelId":"claude-opus-5-5", "access":"full", "effort":"high",
    }))
    .unwrap()
}

fn start(agent: ChatAgent) -> StartContext {
    let mut start = StartContext::for_test(agent, Some("old-native"));
    start.access = Some(Access::Full);
    start.model = Some(
        match agent {
            ChatAgent::Claude => "claude-opus-5-5",
            ChatAgent::Codex => "gpt-6.1-sol",
            _ => "native-model",
        }
        .into(),
    );
    start.effort = Some("high".into());
    start.lite = Some(true);
    start.extra_dirs = Some(vec!["/saved/extra".into()]);
    start.env = Some(std::collections::BTreeMap::from([(
        "PROJECT_SETTING".into(),
        "kept".into(),
    )]));
    start.defaults = Some(start.settings());
    start
}

fn init(agent: ChatAgent, id: &str) -> Value {
    match agent {
        ChatAgent::Claude => json!({"type":"system","subtype":"init","session_id":id}),
        ChatAgent::Codex => json!({"type":"thread.started","thread_id":id}),
        ChatAgent::Pi => json!({"type":"session","id":id}),
        ChatAgent::Antigravity => json!({"event":"init","conversation_id":id}),
    }
}

fn no_forgotten(tap: &crate::bus::tap::Tap) {
    assert!(tap
        .heard()
        .iter()
        .all(|(event, _)| event != "chat-forgotten"));
}

#[test]
fn clear_all_providers_preserves_settings_and_blocks_stale_save_start_and_init() {
    let home = crate::test_dir::TestDir::new("native-clear-providers");
    let _pin = crate::profile::started_in(&home);
    let services = Services::at_profile();
    for agent in ChatAgent::ALL {
        for lead in [false, true] {
            let key = format!(
                "chat:{}-{}",
                if lead { "lead-native" } else { "ordinary" },
                agent.id()
            );
            let row = meta(&key, lead);
            if lead {
                crate::chat_index::ensure_lead(row.clone()).unwrap();
            } else {
                crate::chat_index::upsert(row.clone()).unwrap();
            }
            let old = start(agent);
            services.chats.remember_start(&key, old.clone());
            crate::transcript::append(&key, &init(agent, "old-native")).unwrap();
            let tap = crate::bus::tap::Tap::on(&key);
            dispatch(&services, "chat_forget", json!({"key":key})).unwrap();
            let mut expected = old.clone();
            expected.forget_session();
            assert_eq!(services.chats.start_context(&key), Some(expected));
            let mut expected_row = serde_json::to_value(&row).unwrap();
            expected_row.as_object_mut().unwrap().remove("sessionId");
            assert_eq!(
                serde_json::to_value(crate::chat_index::find(&row.id).unwrap().unwrap()).unwrap(),
                expected_row
            );
            assert!(crate::transcript::every_line(&key).unwrap().is_empty());
            assert_eq!(
                tap.heard()
                    .iter()
                    .filter(|(event, _)| event == "chat-forgotten")
                    .count(),
                1
            );
            crate::chat_index::upsert(row.clone()).unwrap();
            assert_eq!(
                crate::chat_index::find(&row.id)
                    .unwrap()
                    .unwrap()
                    .session_id,
                None
            );
            assert_eq!(
                crate::chat_index::usable_session(&key, Some("old-native".into())).unwrap(),
                None
            );
            // The same provider command builder used at the common start boundary.
            let resume = crate::chat_index::usable_session(&key, old.session_id).unwrap();
            let command = provider_for(agent).build_command(&crate::agent_provider::AgentCommand {
                model: old.model.as_deref(),
                access: old.access,
                prompt: "after clear",
                resume: resume.as_deref(),
                extra_dirs: &[],
                sandbox_roots: &[],
                effort: old.effort.as_deref(),
                images: &[],
                lite: false,
                mcp_config: None,
                persistent_authorizations: None,
                orchestration_worker: false,
                front_desk: false,
                codex_user_mcp: &[],
                preferences: None,
            });
            assert!(!command.contains("old-native"), "{command}");
            services.chats.remember_session(&key, "old-native");
            assert_eq!(services.chats.provider_session(&key), None);
            // A failed provider switch may try to restore a captured old context.
            services.chats.remember_start(&key, start(agent));
            assert_eq!(services.chats.provider_session(&key), None);
            services.chats.remember_session(&key, "new-native");
            assert_eq!(
                services.chats.provider_session(&key).as_deref(),
                Some("new-native")
            );
            assert_eq!(
                crate::chat_index::usable_session(&key, Some("new-native".into()))
                    .unwrap()
                    .as_deref(),
                Some("new-native")
            );
            if lead {
                crate::chat_index::upsert(row.clone()).unwrap();
                assert_eq!(
                    crate::chat_index::find(&row.id)
                        .unwrap()
                        .unwrap()
                        .session_id
                        .as_deref(),
                    Some("new-native")
                );
            }
        }
    }
}

#[test]
fn failed_session_save_reports_store_words_without_forgetting_or_emitting() {
    let home = crate::test_dir::TestDir::new("native-clear-save-failed");
    let _pin = crate::profile::started_in(&home);
    let services = Services::at_profile();
    let key = "chat:clear-save-failed";
    let row = meta(key, false);
    crate::chat_index::upsert(row.clone()).unwrap();
    services.chats.remember_start(key, start(ChatAgent::Claude));
    crate::transcript::append(key, &init(ChatAgent::Claude, "old-native")).unwrap();
    let path = crate::transcript::path_for(key).unwrap();
    let before = std::fs::read(&path).unwrap();
    let tap = crate::bus::tap::Tap::on(key);
    let result = crate::chat_index::tests::while_writes_fail(|| {
        dispatch(&services, "chat_forget", json!({"key":key}))
    });
    assert_eq!(result, Err("the disk is full".into()));
    no_forgotten(&tap);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        services.chats.provider_session(key).as_deref(),
        Some("old-native")
    );
    assert_eq!(
        crate::chat_index::find(&row.id)
            .unwrap()
            .unwrap()
            .session_id,
        row.session_id
    );
    assert!(crate::chat_index::forgotten_sessions(key)
        .unwrap()
        .is_empty());
}

#[test]
fn failed_transcript_forget_keeps_history_but_revokes_all_recovery_sources() {
    let home = crate::test_dir::TestDir::new("native-clear-forget-failed");
    let _pin = crate::profile::started_in(&home);
    let services = Services::at_profile();
    let key = "chat:clear-forget-failed";
    crate::chat_index::upsert(meta(key, false)).unwrap();
    let old = start(ChatAgent::Claude);
    services.chats.remember_start(key, old.clone());
    crate::transcript::append(key, &init(ChatAgent::Claude, "old-native")).unwrap();
    crate::transcript::append(key, &json!({"type":"octiq_registered_recovered", "agent":"claude", "model":"claude-opus-5-5", "effort":"high", "access":"full"})).unwrap();
    let path = crate::transcript::path_for(key).unwrap();
    let before = std::fs::read(&path).unwrap();
    let tap = crate::bus::tap::Tap::on(key);
    assert_eq!(
        crate::transcript::while_forget_fails(|| dispatch(
            &services,
            "chat_forget",
            json!({"key":key})
        )),
        Err("the chat record could not be removed".into())
    );
    no_forgotten(&tap);
    assert_eq!(std::fs::read(path).unwrap(), before);
    assert_eq!(services.chats.provider_session(key), None);
    let preset = old.settings();
    let mut wrong = preset.clone();
    wrong.agent = ChatAgent::Codex;
    // Both a captured context and recovery's init-event fallback remain stale.
    let selected =
        registered_runtime::select(key, &wrong, &preset, Some("old-native".into()), Some(&old))
            .unwrap();
    assert_eq!(selected.resume, None);
    assert_eq!(selected.runtime, preset);
    dispatch(&services, "chat_forget", json!({"key":key})).unwrap();
    assert!(crate::transcript::every_line(key).unwrap().is_empty());
}

#[test]
fn clear_scrubs_dispatching_auto_resume_and_provider_switch_rollback() {
    let home = crate::test_dir::TestDir::new("native-clear-auto");
    let _pin = crate::profile::started_in(&home);
    let services = Services::at_profile();
    let key = "chat:clear-auto";
    let old = start(ChatAgent::Claude);
    services.chats.remember_start(key, old.clone());
    let target = crate::provider_failover::equivalent(&old.settings(), ChatAgent::Codex).unwrap();
    services
        .chats
        .auto_resumes
        .schedule_start_choice(
            key,
            old.clone(),
            target,
            100,
            false,
            false,
            Some(crate::auto_resume::PendingTurn {
                text: "held request".into(),
                images: vec![],
                turn_id: "pending".into(),
                previous_start: Some(old),
            }),
        )
        .unwrap()
        .unwrap();
    let claimed = services
        .chats
        .auto_resumes
        .claim_due(101)
        .unwrap()
        .remove(0);
    assert!(services.chats.auto_resumes.active_switch(key, &claimed.id));
    dispatch(&services, "chat_forget", json!({"key":key})).unwrap();
    assert!(!services.chats.auto_resumes.active_switch(key, &claimed.id));
    assert!(services
        .chats
        .auto_resumes
        .session_ids(key)
        .unwrap()
        .is_empty());
    assert_eq!(
        crate::chat_index::usable_session(key, claimed.start.session_id).unwrap(),
        None
    );
    let schedule_path = crate::profile::profile_dir().join("chats/auto-resumes.json");
    let reloaded = crate::auto_resume::Store::load(schedule_path);
    assert!(reloaded.session_ids(key).unwrap().is_empty());
    assert!(reloaded.claim_due(i64::MAX).unwrap().is_empty());
}

#[test]
fn failed_ledger_or_schedule_save_keeps_record_and_returns_the_store_error() {
    for store in ["orchestrations", "auto-resumes"] {
        let home = crate::test_dir::TestDir::new("native-clear-store-failed");
        let _pin = crate::profile::started_in(&home);
        let services = Services::at_profile();
        let key = "chat:clear-store-failed";
        services.chats.remember_start(key, start(ChatAgent::Claude));
        crate::transcript::append(key, &init(ChatAgent::Claude, "old-native")).unwrap();
        let record = crate::transcript::path_for(key).unwrap();
        let before = std::fs::read(&record).unwrap();
        // Persist's rename fails portably when its destination is a directory.
        let path = if store == "orchestrations" {
            crate::profile::profile_dir().join("orchestrations.json")
        } else {
            crate::transcript::chats_dir()
                .unwrap()
                .join("auto-resumes.json")
        };
        crate::profile::make_dir(&path).unwrap();
        let expected = if store == "orchestrations" {
            services
                .orchestrations
                .clear_resume_session(key)
                .unwrap_err()
        } else {
            services.chats.auto_resumes.clear_session(key).unwrap_err()
        };
        let tap = crate::bus::tap::Tap::on(key);
        assert_eq!(
            dispatch(&services, "chat_forget", json!({"key":key})),
            Err(expected)
        );
        no_forgotten(&tap);
        assert_eq!(std::fs::read(record).unwrap(), before);
        assert_eq!(
            crate::chat_index::usable_session(key, Some("old-native".into())).unwrap(),
            None
        );
    }
}

#[test]
fn unavailable_profile_refuses_clear_in_its_own_words() {
    let home = crate::test_dir::TestDir::new("native-clear-profile-away");
    let _pin = crate::profile::started_in(&home);
    let services = Services::at_profile();
    let key = "chat:clear-profile-away";
    services.chats.remember_start(key, start(ChatAgent::Claude));
    crate::transcript::append(key, &init(ChatAgent::Claude, "old-native")).unwrap();
    let record = crate::transcript::path_for(key).unwrap();
    let before = std::fs::read(&record).unwrap();
    let profile = crate::profile::profile_dir();
    let away = home.join("away");
    std::fs::rename(&profile, &away).unwrap();
    let expected = crate::profile::available().unwrap_err();
    let tap = crate::bus::tap::Tap::on(key);
    let result = dispatch(&services, "chat_forget", json!({"key":key}));
    std::fs::rename(&away, &profile).unwrap();
    assert_eq!(result, Err(expected));
    no_forgotten(&tap);
    assert_eq!(std::fs::read(record).unwrap(), before);
}

#[test]
fn a_cloned_due_resume_is_cancelled_before_it_can_launch_after_clear() {
    let home = crate::test_dir::TestDir::new("native-clear-due-clone");
    let _pin = crate::profile::started_in(&home);
    let services = Services::at_profile();
    let key = "chat:clear-due-clone";
    let old = start(ChatAgent::Claude);
    services.chats.remember_start(key, old.clone());
    services
        .chats
        .auto_resumes
        .schedule(key, 200, old, 100)
        .unwrap()
        .unwrap();
    let claimed = services
        .chats
        .auto_resumes
        .claim_due(300)
        .unwrap()
        .remove(0);
    dispatch(&services, "chat_forget", json!({"key":key})).unwrap();
    assert_eq!(
        run_scheduled_resume(services.chats.clone(), &claimed),
        Err("The auto-resume was cancelled.".into())
    );
    assert_eq!(
        require_scheduled_turn(
            &services.chats,
            key,
            Some(&format!("octiq-auto-resume-{}", claimed.id))
        ),
        Err("The auto-resume was cancelled.".into())
    );
    assert!(!services.chats.has_process(key));
    assert!(services
        .chats
        .auto_resumes
        .session_ids(key)
        .unwrap()
        .is_empty());
}

#[test]
fn cleared_notification_after_restart_starts_fresh_with_saved_runtime() {
    use crate::orchestration::tests::running_worker;
    let home = crate::test_dir::TestDir::new("native-clear-notification");
    let _pin = crate::profile::started_in(&home);
    let services = Services::at_profile();
    let manager = services.chats.clone();
    let run = services
        .orchestrations
        .create_run(
            "chat:master".into(),
            "test".into(),
            "workspace".into(),
            home.to_string_lossy().into_owned(),
            Some(2),
        )
        .unwrap();
    let worker = running_worker(&services.orchestrations, &run);
    let key = &run.coordinator_chat_key;
    let mut old = start(ChatAgent::Claude);
    old.cwd = run.root_path.clone();
    manager.remember_start(key, old.clone());
    let mut row = meta(key, false);
    row.cwd = Some(run.root_path.clone());
    crate::chat_index::upsert(row).unwrap();
    dispatch(&services, "chat_forget", json!({"key":key})).unwrap();
    let mut expected = old.without_env();
    expected.forget_session();
    assert_eq!(
        services.orchestrations.saved_resume_context(key),
        Some(expected.clone())
    );
    // Enqueue before restart: interrupted worker attempts cannot send again.
    services
        .orchestrations
        .record_message(
            &worker.worker_chat_key,
            run.id.clone(),
            "coordinator".into(),
            "status".into(),
            "Ready".into(),
            "fresh notice".into(),
        )
        .unwrap();
    let loaded = Services::at_profile();
    assert_eq!(
        loaded.orchestrations.saved_resume_context(key),
        Some(expected)
    );
    // Neither stale ledger writes nor stale page ids can restore it after restart.
    loaded
        .orchestrations
        .save_resume_context(key, old.clone())
        .unwrap();
    assert!(!loaded
        .orchestrations
        .saved_resume_context(key)
        .unwrap()
        .resumable());
    assert_eq!(
        crate::chat_index::usable_session(key, old.session_id).unwrap(),
        None
    );
    let notes = loaded.orchestrations.due_notifications(i64::MAX).unwrap();
    let mut launched = false;
    assert!(deliver_orchestration_notification_with_start(
        loaded.chats,
        &notes,
        Default::default(),
        |_, _, start, _, _| {
            launched = true;
            assert_eq!(start.session_id, None);
            assert_eq!(start.model, old.model);
            assert_eq!(start.access, old.access);
            assert_eq!(start.effort, old.effort);
            Ok(())
        }
    )
    .unwrap());
    assert!(launched);
}

#[test]
fn an_unknown_native_init_delayed_past_clear_cannot_repopulate_any_resume_source() {
    let home = crate::test_dir::TestDir::new("native-clear-late-init");
    let _pin = crate::profile::started_in(&home);
    let services = Services::at_profile();
    for agent in ChatAgent::ALL {
        let key = format!("chat:late-init-{}", agent.id());
        services.chats.test_launch(&key);
        services.chats.remember_start(&key, start(agent));
        let session = services
            .chats
            .sessions
            .lock()
            .unwrap()
            .get(&key)
            .unwrap()
            .clone();
        dispatch(&services, "chat_forget", json!({"key":key})).unwrap();
        assert!(!crate::chat_index::forgotten_sessions(&key)
            .unwrap()
            .contains("unknown-late-native"));
        assert_eq!(
            record_provider_event(
                &services.chats,
                &session,
                &key,
                &key,
                agent,
                &init(agent, "unknown-late-native")
            ),
            None
        );
        assert_eq!(services.chats.provider_session(&key), None);
        assert!(crate::transcript::every_line(&key).unwrap().is_empty());
    }
}

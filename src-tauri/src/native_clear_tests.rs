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
            // The row's preview is reset by /clear: no text, version moved on.
            expected_row["latestResponseVersion"] = json!(1);
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
fn lowering_with_unread_revocations_keeps_access_but_never_publishes_native_ids() {
    for missing_profile in [true, false] {
        let home = crate::test_dir::TestDir::new("lowering-unread-revocations");
        let _pin = crate::profile::started_in(&home);
        let services = Services::at_profile();
        let manager = &services.chats;
        let key = "chat:lowering-unread";
        crate::chat_index::upsert(meta(key, false)).unwrap();
        services
            .orchestrations
            .create_run(
                key.into(),
                "lower safely".into(),
                "workspace".into(),
                home.to_string_lossy().into_owned(),
                Some(1),
            )
            .unwrap();
        let mut old = start(ChatAgent::Claude);
        old.access = Some(Access::Auto);
        manager.remember_start(key, old);
        let _child = manager.test_hold(key, ChatAgent::Claude, false);
        manager.test_seat(key, key);
        let session = manager.sessions.lock().unwrap().get(key).unwrap().clone();
        // The process/starts can still remember a conversation whose id the
        // durable index has revoked. An unread index must not bless that id.
        crate::chat_index::forget_sessions(key, vec!["old-native".into()]).unwrap();
        let profile = crate::profile::profile_dir();
        let index = crate::transcript::chats_dir().unwrap().join("index.json");
        let index_bytes = std::fs::read(&index).unwrap();
        let away = home.join("away");
        if missing_profile {
            std::fs::rename(&profile, &away).unwrap();
        } else {
            std::fs::write(&index, "unreadable index").unwrap();
        }
        let lowered = crate::dispatch::told(
            &services,
            "chat_set_access",
            json!({"key":key,"access":"read"}),
        );
        assert_eq!(lowered.result, Ok(Value::Null));
        assert_eq!(
            manager.start_context(key).unwrap().access,
            Some(Access::Read)
        );
        assert_eq!(manager.provider_session(key), None);
        let saved = services.orchestrations.saved_resume_context(key).unwrap();
        assert_eq!(saved.access, Some(Access::Read));
        assert_eq!(saved.session_id, None);
        assert_eq!(services.orchestrations.owes(), missing_profile);
        assert_eq!(
            lowered
                .unsaved
                .iter()
                .any(|u| u.what == "the chat's access level"),
            missing_profile
        );
        assert_eq!(
            record_provider_event(
                manager,
                &session,
                key,
                key,
                ChatAgent::Claude,
                &init(ChatAgent::Claude, "unverified-new-native"),
            ),
            None
        );
        assert_eq!(manager.provider_session(key), None);
        if missing_profile {
            std::fs::rename(&away, &profile).unwrap();
        } else {
            std::fs::write(&index, index_bytes).unwrap();
        }
        crate::dispatch::settle_owed(&services);
        assert!(!services.orchestrations.owes());
        let reloaded = Services::at_profile();
        let saved = reloaded.orchestrations.saved_resume_context(key).unwrap();
        assert_eq!(saved.access, Some(Access::Read));
        assert_eq!(saved.session_id, None);
        assert_eq!(
            crate::chat_index::usable_session(key, Some("old-native".into())).unwrap(),
            None
        );
        assert!(crate::transcript::every_line(key)
            .unwrap()
            .iter()
            .all(|line| {
                provider_for(ChatAgent::Claude)
                    .observe_event(&line.event)
                    .session_id
                    .is_none()
            }));
        manager.test_end(key);
    }
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

#[test]
fn stop_and_interrupt_reply_while_native_init_index_io_is_paused() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;

    for agent in ChatAgent::ALL {
        for lead in [false, true] {
            for interrupt in [false, true] {
                // Pause both the first revocation read and the ledger's read,
                // after a lead's index has already saved the tentative id.
                for skip in [0, if lead { 2 } else { 1 }] {
                    let home = crate::test_dir::TestDir::new("native-init-io-stop");
                    let _pin = crate::profile::started_in(&home);
                    let services = Services::at_profile();
                    let manager = services.chats.clone();
                    *manager.unwind_probe.grace.lock().unwrap() = None;
                    let key = format!(
                        "chat:{}-{}",
                        if lead { "lead-io" } else { "io" },
                        agent.id()
                    );
                    let row = meta(&key, lead);
                    if lead {
                        crate::chat_index::ensure_lead(row.clone()).unwrap();
                    } else {
                        crate::chat_index::upsert(row.clone()).unwrap();
                    }
                    services
                        .orchestrations
                        .create_run(
                            key.clone(),
                            "test".into(),
                            "workspace".into(),
                            home.to_string_lossy().into_owned(),
                            Some(1),
                        )
                        .unwrap();
                    manager.remember_start(&key, start(agent));
                    let _child = manager.test_hold(&key, agent, true);
                    if agent == ChatAgent::Codex {
                        manager.test_as_codex_thread(&key, Access::Full);
                    }
                    manager.test_seat(&key, &key);
                    let session = manager.sessions.lock().unwrap().get(&key).unwrap().clone();
                    let (entered, enter) = mpsc::channel();
                    let (done, finish) = mpsc::channel();
                    let stopped = manager.clone();
                    let stopping = services.clone();
                    let stop_key = key.clone();
                    let epoch = manager.stop_epoch(&key);
                    let before_stop = epoch.load(Ordering::SeqCst);
                    let stopper = thread::spawn(move || {
                        enter.recv_timeout(Duration::from_secs(5)).unwrap();
                        let began = Instant::now();
                        // Exercise the real RPC preflight too: calling the
                        // impl directly misses require_user_chat's lock path.
                        let result = dispatch(
                            &stopping,
                            if interrupt {
                                "chat_interrupt"
                            } else {
                                "chat_stop"
                            },
                            json!({"key":stop_key}),
                        )
                        .map(|reply| {
                            if interrupt {
                                assert_eq!(reply["stopped"], true);
                            }
                        });
                        assert!(epoch.load(Ordering::SeqCst) > before_stop);
                        // Starts must also be readable while native-id I/O
                        // is paused, and must not expose its tentative id.
                        assert_eq!(
                            stopped.provider_session(&stop_key).as_deref(),
                            Some("old-native")
                        );
                        let elapsed = began.elapsed();
                        let _ = done.send(());
                        (elapsed, result)
                    });
                    let timely = Arc::new(AtomicBool::new(false));
                    let measured = timely.clone();
                    let checking_ledger = services.orchestrations.clone();
                    let recorded = crate::chat_index::tests::with_read_pause(
                        skip,
                        move || {
                            assert_eq!(checking_ledger.test_ledger_locked(), skip != 0);
                            entered.send(()).unwrap();
                            measured.store(
                                finish.recv_timeout(Duration::from_millis(200)).is_ok(),
                                Ordering::SeqCst,
                            );
                        },
                        || {
                            record_provider_event(
                                &manager,
                                &session,
                                &key,
                                &key,
                                agent,
                                &init(agent, "delayed-native"),
                            )
                        },
                    );
                    let (elapsed, result) = stopper.join().unwrap();
                    result.unwrap();
                    assert!(
                        timely.load(Ordering::SeqCst),
                        "{agent:?} lead={lead} interrupt={interrupt} skip={skip}: {elapsed:?}"
                    );
                    assert!(elapsed < Duration::from_millis(200));
                    assert_eq!(recorded, None);
                    assert_eq!(
                        manager.provider_session(&key).as_deref(),
                        Some("old-native")
                    );
                    assert_ne!(
                        crate::chat_index::find(&row.id)
                            .unwrap()
                            .unwrap()
                            .session_id
                            .as_deref(),
                        Some("delayed-native")
                    );
                    assert_eq!(
                        crate::chat_index::usable_session(&key, Some("delayed-native".into()))
                            .unwrap(),
                        None
                    );
                    assert!(!services
                        .orchestrations
                        .saved_resume_context(&key)
                        .unwrap()
                        .resumable());
                    assert!(crate::transcript::every_line(&key).unwrap().is_empty());
                    // Persisted rollback, followed by a successful clear,
                    // must also survive reconstruction of the host stores.
                    dispatch(&services, "chat_forget", json!({"key":key})).unwrap();
                    let reloaded = Services::at_profile();
                    assert!(!reloaded
                        .orchestrations
                        .saved_resume_context(&key)
                        .unwrap()
                        .resumable());
                    assert_eq!(reloaded.chats.provider_session(&key), None);
                }
            }
        }
    }
}

#[test]
fn clear_waits_for_native_io_only_after_stopping_and_never_restores_the_init() {
    use std::sync::mpsc;

    for skip in [0, 2] {
        // Both threads intentionally share the test binary's scratch profile.
        // started_in on a second thread would stand in for a second server and
        // replace the first thread's profile ownership mark.
        let mut services = Services::at_profile();
        // The index/transcript are shared by these two threads, with unique
        // chat keys. Keep their ledger separate from other parallel tests.
        let ledger_home = crate::test_dir::TestDir::new("clear-io-ledger");
        services.orchestrations = Arc::new(crate::orchestration::OrchestrationStore::load(
            ledger_home.join("ledger.json"),
        ));
        Arc::get_mut(&mut services.chats).unwrap().orchestrations = services.orchestrations.clone();
        let manager = services.chats.clone();
        let key = format!("chat:lead-native-clear-{}", uuid::Uuid::new_v4().simple());
        crate::chat_index::ensure_lead(meta(&key, true)).unwrap();
        services
            .orchestrations
            .create_run(
                key.clone(),
                "clear barrier".into(),
                "workspace".into(),
                "/tmp".into(),
                Some(1),
            )
            .unwrap();
        manager.remember_start(&key, start(ChatAgent::Claude));
        manager.test_launch(&key);
        let session = manager.sessions.lock().unwrap().get(&key).unwrap().clone();
        let ledger = services.orchestrations.clone();
        let (entered, enter) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let recording = manager.clone();
        let record_key = key.clone();
        let recording_session = session.clone();
        let reader = thread::spawn(move || {
            crate::chat_index::tests::with_read_pause(
                skip,
                move || {
                    assert_eq!(ledger.test_ledger_locked(), skip != 0);
                    entered.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(5)).unwrap();
                },
                || {
                    record_provider_event(
                        &recording,
                        &recording_session,
                        &record_key,
                        &record_key,
                        ChatAgent::Claude,
                        &init(ChatAgent::Claude, "unknown-in-flight"),
                    )
                },
            )
        });
        enter.recv_timeout(Duration::from_secs(5)).unwrap();
        let clear_key = key.clone();
        let epoch = manager.stop_epoch(&key);
        let before_stop = epoch.load(std::sync::atomic::Ordering::SeqCst);
        let clear_services = services.clone();
        let clear = thread::spawn(move || {
            dispatch(&clear_services, "chat_forget", json!({"key":clear_key}))
        });
        let began = Instant::now();
        let stopped = loop {
            if session.try_lock().is_ok_and(|s| s.cut_off == CutOff::Ended) {
                break true;
            }
            if began.elapsed() >= Duration::from_millis(200) {
                break false;
            }
            thread::yield_now();
        };
        // Always release before asserting, so a regression cannot strand threads
        // or hold the shared index lock for the rest of the test suite.
        let vetoed = epoch.load(std::sync::atomic::Ordering::SeqCst) > before_stop;
        release.send(()).unwrap();
        let recorded = reader.join().unwrap();
        let cleared = clear.join().unwrap();
        assert!(
            vetoed,
            "clear did not bump epoch before ledger I/O finished"
        );
        assert!(stopped, "clear did not stop before waiting on native I/O");
        assert_eq!(recorded, None);
        cleared.unwrap();
        assert_eq!(manager.provider_session(&key), None);
        assert_eq!(
            crate::chat_index::find(key.trim_start_matches("chat:"))
                .unwrap()
                .unwrap()
                .session_id,
            None
        );
        assert!(crate::transcript::every_line(&key).unwrap().is_empty());
        assert_eq!(
            crate::chat_index::usable_session(&key, Some("unknown-in-flight".into())).unwrap(),
            None
        );
        // A new launch can learn a new conversation after the clear.
        manager.test_launch(&key);
        let fresh = manager.sessions.lock().unwrap().get(&key).unwrap().clone();
        assert!(record_provider_event(
            &manager,
            &fresh,
            &key,
            &key,
            ChatAgent::Claude,
            &init(ChatAgent::Claude, "fresh-native")
        )
        .unwrap()
        .is_some());
        assert_eq!(
            manager.provider_session(&key).as_deref(),
            Some("fresh-native")
        );
        manager.test_end(&key);
        // Lead rows intentionally cannot be removed through the ordinary API;
        // the shared TestDir removes this unique fixture at binary exit.
        crate::transcript::forget(&key);
    }
}

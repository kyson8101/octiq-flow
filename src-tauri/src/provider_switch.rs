//! Cross-provider conversation handoff. Native session ids never cross the seam.
use super::*;
use crate::provider_failover::Settings;

pub(super) fn provider_history(key: &str) -> Result<String, String> {
    // Keep the complete application record on disk; bound only the context
    // handed to the new runtime. Tool calls/results are evidence to inspect,
    // never instructions to replay tools that may already have run.
    let lines = crate::transcript::every_line(key)?;
    let mut delivery = std::collections::HashMap::new();
    for line in &lines {
        let event = &line.event;
        if event["type"] == "octiq_user_turn_delivery" {
            if let Some(id) = event["uuid"].as_str() {
                delivery.insert(
                    id.to_string(),
                    event["state"].as_str().unwrap_or("").to_string(),
                );
            }
        } else if event["type"] == "octiq_user_turn_cancelled"
            || event["type"] == "octiq_user_turn_dismissed"
        {
            if let Some(id) = event["uuid"].as_str() {
                delivery.insert(id.to_string(), "cancelled".into());
            }
        }
    }
    let mut kept = Vec::new();
    let mut size = 0;
    for line in lines.into_iter().rev() {
        if line.event["type"] == "user"
            && line.event["uuid"].as_str().is_some_and(|id| {
                delivery
                    .get(id)
                    .is_some_and(|state| state == "queued" || state == "cancelled")
            })
        {
            continue;
        }
        let text = line.event.to_string();
        if size + text.len() > 160_000 {
            break;
        }
        size += text.len();
        kept.push(line.event);
    }
    kept.reverse();
    serde_json::to_string(&kept).map_err(|e| e.to_string())
}

pub(super) fn announce_provider_switch(
    manager: &ChatManager,
    key: &str,
    from: &Settings,
    to: &Settings,
) -> Result<(), String> {
    let message = format!("{} is unavailable. Continuing with {} / {} at {} effort and {} access. The agent's defaults are unchanged.",
        from.agent.id(), to.agent.id(), to.model.as_deref().unwrap_or("default"), to.effort.as_deref().unwrap_or("model default"), to.access.as_env());
    announce_runtime_change(
        manager,
        key,
        from,
        to,
        "octiq_provider_switched",
        &message,
        None,
    )
}

/// Consent/settings must be on disk before changing a runtime. A prepared
/// change is an intent, never evidence that a process successfully started.
pub(super) fn prepare_runtime_change(
    key: &str,
    from: &Settings,
    to: &Settings,
    reason: &str,
    previous_session: Option<&str>,
) -> Result<(), String> {
    record_chat_event_synced(
        key,
        json!({
            "type":"octiq_runtime_change_prepared", "from":from, "to":to,
            "reason":reason, "previousSessionId":previous_session,
        }),
    )
    .ok_or("The runtime recovery/fallback could not be saved. No provider was started.")?;
    Ok(())
}

pub(super) fn announce_runtime_change(
    manager: &ChatManager,
    key: &str,
    from: &Settings,
    to: &Settings,
    kind: &str,
    message: &str,
    previous_session: Option<&str>,
) -> Result<(), String> {
    record_chat_event_synced(
        key,
        json!({ "type": kind, "from": from.agent, "previousSettings": from, "previousSessionId": previous_session, "agent": to.agent, "model": to.model, "effort": to.effort, "access": to.access, "session_id": manager.provider_session(key), "message": message }),
    ).ok_or("The runtime change could not be recorded. Inspect the chat before continuing.")?;
    if let Some(id) = key.strip_prefix("chat:") {
        if let Some(mut meta) = crate::chat_index::list()
            .into_iter()
            .find(|row| row.id == id)
        {
            meta.model_id = Some(crate::orchestration::model_id(
                to.agent,
                to.model.as_deref(),
            ));
            meta.effort = to.effort.clone();
            meta.access = Some(to.access.as_env().into());
            // An old provider's id is invalid on the new provider. Startup
            // will supply its own id; neither the page nor a restart reuses it.
            meta.session_id = manager.provider_session(key);
            crate::chat_index::upsert(meta)?;
            announce_index_change(id, false);
        }
    }
    crate::bus::emit(
        "chat-provider-switch",
        json!({ "key": key, "agent": to.agent, "model": to.model, "effort": to.effort, "access": to.access, "sessionId": manager.provider_session(key) }),
    );
    Ok(())
}

/// Initial recovery may have a different source from the last live runtime.
/// Both preflight and failure restoration must compare the same saved context.
pub(super) fn unchanged_start(
    manager: &ChatManager,
    entry: &crate::auto_resume::ScheduledResume,
) -> bool {
    manager.start_context(&entry.chat_key).is_none_or(|start| {
        start
            == *entry
                .pending_turn
                .as_ref()
                .and_then(|turn| turn.previous_start.as_ref())
                .unwrap_or(&entry.start)
    })
}

pub(super) fn run_provider_switch(
    manager: Arc<ChatManager>,
    entry: &crate::auto_resume::ScheduledResume,
    requested: &Settings,
) -> Result<(), String> {
    crate::profile::available()?;
    let key = &entry.chat_key;
    if !entry.user_selected
        && crate::provider_failover::equivalent_using(
            &entry.start.settings(),
            &entry.start.default_settings(),
            requested.agent,
        )
        .as_ref()
            != Some(requested)
    {
        return Err("The saved provider handoff does not preserve the original settings.".into());
    }
    if !manager.running_background(key).is_empty() {
        return Err("Provider switching is held while background work is running. Inspect its output before continuing.".into());
    }
    if requested.access != entry.start.settings().access {
        return Err("Provider switching cannot change access.".into());
    }
    if entry.user_selected {
        crate::failover_policy::Selection {
            agent: requested.agent,
            model: requested.model.clone().unwrap_or_default(),
            effort: requested.effort.clone(),
        }
        .settings(&entry.start.settings())?;
        crate::failover_policy::available(
            &manager.failover,
            &crate::failover_policy::Selection {
                agent: requested.agent,
                model: requested.model.clone().unwrap_or_default(),
                effort: requested.effort.clone(),
            },
            &entry.start.settings(),
        )?;
    }
    let target = if manager
        .failover
        .blocked(requested.agent, crate::auto_resume::unix_now())
    {
        if entry.user_selected {
            return Err(
                "The selected provider is now at its limit. Choose another provider to continue."
                    .into(),
            );
        }
        manager
            .failover
            .alternative_using(
                &entry.start.settings(),
                &entry.start.default_settings(),
                crate::auto_resume::unix_now(),
            )
            .ok_or("All equivalent providers are at their limit. No provider was restarted.")?
    } else {
        requested.clone()
    };
    let history = provider_history(key)?;
    let prompt = model_handoff_prompt(&history, entry.pending_turn.as_ref().map_or(
        "The previous provider reached its account limit. Continue the latest unfinished request. Read the current workspace, task ledger and any running job outputs first; preserve completed work and do not replay tools or external actions blindly. Keep the same agent identity, plan approvals and scope.",
        |turn| turn.text.as_str()));
    let prompt = crate::team::refresh_turn_brief(&crate::team::default_path(), key, prompt, &[])?;
    crate::agent_provider::validate_model(target.agent, target.model.as_deref())?;
    registered_runtime::require_installed(target.agent)?;
    prepare_runtime_change(
        key,
        &entry.start.settings(),
        &target,
        if entry.user_selected {
            "person-selected fallback"
        } else {
            "Auto fallback policy"
        },
        entry.start.session_id.as_deref(),
    )?;
    {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if !manager.auto_resumes.active_switch(key, &entry.id) {
            return Err("The provider switch was cancelled.".into());
        }
        if !unchanged_start(&manager, entry) {
            return Err("The chat's settings changed before provider switching.".into());
        }
        if let Some(session) = sessions.get(key).cloned() {
            let mut old = session.lock().map_err(|e| e.to_string())?;
            if old.busy || old.cut_off != CutOff::No {
                return Err("The previous provider has not finished its turn.".into());
            }
            manager.questions.detach_launch(&old.launch_id);
            old.cut_off = CutOff::Ended;
            old.stdin.take();
            old.child
                .kill()
                .map_err(|e| format!("Could not end the limited provider: {e}"))?;
            sessions.remove(key);
        }
        manager
            .handoffs
            .lock()
            .map_err(|e| e.to_string())?
            .insert(key.clone());
    }
    let mut saved = entry.start.clone();
    saved.defaults = Some(entry.start.default_settings());
    saved.agent = target.agent;
    saved.model = target.model.clone();
    saved.effort = target.effort.clone();
    saved.access = Some(target.access);
    saved.session_id = None;
    // Rebind every queued turn to the same cwd/env and the replacement's
    // settings. Their user ids, contents and FIFO order stay intact.
    if let Some(queue) = manager
        .queued_turns
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(key)
    {
        for turn in queue {
            turn.context = Some(QueueContext::from(saved.clone()));
        }
    }
    manager.remember_start(key, saved.clone());
    let result = start_session(
        manager.clone(),
        Voice::host(key.clone()),
        saved.cwd.clone(),
        saved.agent,
        saved.model.clone(),
        saved.access,
        Some(prompt),
        None,
        saved.extra_dirs.clone(),
        saved.env.clone(),
        saved.effort.clone(),
        entry.pending_turn.as_ref().map(|turn| turn.images.clone()),
        saved.lite,
        Some(format!("octiq-provider-switch-{}", entry.id)),
        false,
        None,
    );
    manager
        .handoffs
        .lock()
        .map_err(|e| e.to_string())?
        .remove(key);
    if result.is_err() {
        manager.remember_start(
            key,
            entry
                .pending_turn
                .as_ref()
                .and_then(|turn| turn.previous_start.as_ref())
                .unwrap_or(&entry.start)
                .clone(),
        );
    }
    result?;
    if let Some(turn) = &entry.pending_turn {
        record_durable_user_turn(key, &turn.turn_id, &turn.text, &turn.images);
        record_delivery(key, Some(&turn.turn_id), "dispatched");
    }
    announce_provider_switch(&manager, key, &entry.start.settings(), &target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_selected_recovery_reopens_the_original_pending_turn_after_previous_runtime() {
        let home = crate::test_dir::TestDir::new("reopen-recovery-choice");
        let _pin = crate::profile::started_in(&home);
        let manager = ChatManager::with_saved_questions(home.join("questions.json"));
        let key = format!("chat:pending-recovery-{}", uuid::Uuid::new_v4());
        let previous = StartContext::for_test(ChatAgent::Codex, Some("fallback-session"));
        manager.remember_start(&key, previous.clone());
        let source = StartContext::for_test(ChatAgent::Claude, Some("original-session"));
        let target =
            crate::provider_failover::equivalent(&source.settings(), ChatAgent::Codex).unwrap();
        let pending = crate::auto_resume::PendingTurn {
            text: "ONLY_PENDING_REQUEST".into(),
            images: vec!["/original/image.png".into()],
            turn_id: "pending-turn".into(),
            previous_start: Some(previous.clone()),
        };
        let scheduled = manager
            .auto_resumes
            .schedule_start_choice(
                &key,
                source.clone(),
                target.clone(),
                100,
                true,
                false,
                Some(pending.clone()),
            )
            .unwrap()
            .unwrap();
        manager
            .auto_resumes
            .choose_switch(&key, &scheduled.id, target)
            .unwrap();
        let entry = manager
            .auto_resumes
            .claim_due(crate::auto_resume::unix_now())
            .unwrap()
            .remove(0);
        assert_ne!(manager.start_context(&key), Some(source));
        assert!(unchanged_start(&manager, &entry));
        let reopened = manager.auto_resumes.reopen_switch(&entry).unwrap().unwrap();
        manager.auto_resumes.finish(&entry).unwrap();
        let reloaded = ChatManager::with_saved_questions(home.join("questions.json"));
        let restored = reloaded.auto_resumes.scheduled().unwrap().pop().unwrap();
        assert_eq!(restored.id, reopened.id);
        assert!(restored.awaiting_choice);
        let restored = restored.pending_turn.unwrap();
        assert_eq!(restored.text, pending.text);
        assert_eq!(restored.images, pending.images);
        assert_eq!(restored.turn_id, pending.turn_id);
        assert_eq!(restored.previous_start, Some(previous));
    }

    #[test]
    fn handoff_context_does_not_deliver_queued_requests_early() {
        let key = format!("chat:history-handoff-{}", uuid::Uuid::new_v4());
        record_chat_event(
            &key,
            json!({ "type": "user", "uuid": "sent", "message": { "content": "Keep the original request" } }),
        );
        record_chat_event(
            &key,
            json!({ "type": "user", "uuid": "waiting", "message": { "content": "QUEUED_REQUEST_MUST_WAIT" } }),
        );
        record_chat_event(
            &key,
            json!({ "type": "octiq_user_turn_delivery", "uuid": "waiting", "state": "queued" }),
        );
        let history = provider_history(&key).unwrap();
        assert!(history.contains("Keep the original request"));
        assert!(!history.contains("QUEUED_REQUEST_MUST_WAIT"));
        crate::transcript::forget(&key);
    }

    #[test]
    fn stopping_a_claimed_switch_keeps_the_old_provider_and_starts_nothing() {
        let manager = Arc::new(ChatManager::default());
        let key = format!("chat:switch-cancel-{}", uuid::Uuid::new_v4());
        let (child, _heard) = manager.test_hold_heard(&key, ChatAgent::Claude, false);
        let source = StartContext::for_test(ChatAgent::Claude, Some("old-provider-session"));
        manager.remember_start(&key, source.clone());
        let target =
            crate::provider_failover::equivalent(&source.settings(), ChatAgent::Codex).unwrap();
        manager
            .auto_resumes
            .schedule_switch(&key, source.clone(), target.clone(), 100)
            .unwrap();
        let entry = manager.auto_resumes.claim_due(100).unwrap().remove(0);
        cancel_auto_resume(&manager, &key, "Stop before spawn");
        assert!(run_provider_switch(manager.clone(), &entry, &target)
            .unwrap_err()
            .contains("cancelled"));
        assert!(child.alive());
        assert_eq!(manager.start_context(&key), Some(source));
        let _ = end_process(&manager, &key);
        crate::transcript::forget(&key);
    }
}

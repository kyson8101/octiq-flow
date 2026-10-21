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
    let message = format!("{} reached its usage limit. Continuing with {} / {} at {} effort and {} access. The agent's defaults are unchanged.",
        from.agent.id(), to.agent.id(), to.model.as_deref().unwrap_or("default"), to.effort.as_deref().unwrap_or("model default"), to.access.as_env());
    record_chat_event(
        key,
        json!({ "type": "octiq_provider_switched", "from": from.agent, "agent": to.agent, "model": to.model, "effort": to.effort, "access": to.access, "session_id": manager.provider_session(key), "message": message }),
    );
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

pub(super) fn run_provider_switch(
    manager: Arc<ChatManager>,
    entry: &crate::auto_resume::ScheduledResume,
    requested: &Settings,
) -> Result<(), String> {
    crate::profile::available()?;
    let key = &entry.chat_key;
    if crate::provider_failover::equivalent_using(
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
    let target = if manager
        .failover
        .blocked(requested.agent, crate::auto_resume::unix_now())
    {
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
    let prompt = model_handoff_prompt(&history,
        "The previous provider reached its account limit. Continue the latest unfinished request. Read the current workspace, task ledger and any running job outputs first; preserve completed work and do not replay tools or external actions blindly. Keep the same agent identity, plan approvals and scope.");
    let prompt = crate::team::refresh_turn_brief(&crate::team::default_path(), key, prompt, &[])?;
    {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if !manager.auto_resumes.active_switch(key, &entry.id) {
            return Err("The provider switch was cancelled.".into());
        }
        if manager
            .start_context(key)
            .is_some_and(|start| start != entry.start)
        {
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
        None,
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
        manager.remember_start(key, entry.start.clone());
    }
    result?;
    announce_provider_switch(&manager, key, &entry.start.settings(), &target)
}

#[cfg(test)]
mod tests {
    use super::*;

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

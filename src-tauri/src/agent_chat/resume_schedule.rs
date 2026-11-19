use super::*;

/// Arm a durable continuation only when both halves are reliable: a native
/// session to resume and an exact future reset timestamp. A quota error without
/// either remains the ordinary actionable failure banner rather than guessing.
pub(super) fn schedule_quota_resume(
    manager: &Arc<ChatManager>,
    chat_key: &str,
    session_key: &str,
    agent: ChatAgent,
    reset_hint: Option<i64>,
) {
    // Orchestration recovery creates a new authoritative attempt. The ordinary
    // chat quota timer must never revive a failed worker under its old lease.
    if manager
        .orchestrations
        .worker_coordinator(chat_key)
        .ok()
        .flatten()
        .is_some()
    {
        return;
    }
    let now = crate::auto_resume::unix_now();
    let Some(start) = manager.start_context(session_key) else {
        return;
    };
    if start.agent() != agent {
        return;
    }
    let route = crate::failover_policy::owner(chat_key).and_then(|owner| {
        crate::failover_policy::route(
            &manager.failover,
            &start.settings(),
            &start.default_settings(),
            owner.as_deref(),
        )
    });
    let (rule, target) = match route {
        Ok(route) => route,
        Err(why) => {
            eprintln!("[chat] provider fallback held: {why}");
            return;
        }
    };
    let asking = rule.mode == crate::failover_policy::Mode::Ask;
    let target = target.or_else(|| {
        asking
            .then(|| {
                [
                    ChatAgent::Claude,
                    ChatAgent::Codex,
                    ChatAgent::Antigravity,
                    ChatAgent::Pi,
                ]
                .into_iter()
                .find_map(|agent| {
                    crate::provider_failover::equivalent_using(
                        &start.settings(),
                        &start.default_settings(),
                        agent,
                    )
                })
            })
            .flatten()
    });
    if let Some(fallback) = target {
        let selected = !asking
            && rule
                .backup
                .as_ref()
                .is_some_and(|b| b.settings(&start.settings()).ok().as_ref() == Some(&fallback));
        match manager.auto_resumes.schedule_switch_choice(
            chat_key,
            start.clone(),
            fallback,
            now,
            asking,
            selected,
        ) {
            Ok(Some(entry)) => crate::auto_resume::announce_scheduled(&entry),
            Ok(None) => {}
            Err(why) => eprintln!("[chat] could not schedule provider switch: {why}"),
        }
        return;
    }
    if !start.resumable() {
        return;
    }
    let reset_at = reset_hint
        .filter(|reset| *reset > now)
        .or_else(|| crate::usage_limits::blocking_reset_at(agent, start.model(), now));
    let Some(reset_at) = reset_at else {
        return;
    };
    match manager
        .auto_resumes
        .schedule(chat_key, reset_at, start, now)
    {
        Ok(Some(entry)) => crate::auto_resume::announce_scheduled(&entry),
        Ok(None) => {}
        Err(why) => eprintln!("[chat] could not schedule quota resume for {chat_key}: {why}"),
    }
}

/// What a cancelled auto-resume is called when it could not be recorded
/// (`unsaved::say`).
pub(super) const CANCELLED_RESUME: &str = "the cancelled auto-resume";

/// Take `key`'s scheduled resume off the schedule. `true` when there was one.
///
/// **It answers nothing a caller could stop on.** Stop, interrupt and every
/// new message cancel first, and a cancel that returned its save's error
/// with `?` left the agent running under a Stop that had been refused
/// (review of 205bca2, H5). The cancel holds in this process from here on;
/// a save that failed is said to whoever asked and owed by the store, which
/// keeps the entry as a `Cancelled` tombstone until it is on disk
/// (`settle_cancelled_resumes`).
pub(super) fn cancel_auto_resume(manager: &ChatManager, key: &str, reason: &str) -> bool {
    let cancelled = match manager.auto_resumes.cancel(key) {
        Ok(Some(cancelled)) => cancelled,
        Ok(None) => return false,
        Err(why) => {
            eprintln!("[chat] could not look for an auto-resume of {key}: {why}");
            return false;
        }
    };
    // Every open page drops the banner now; the transcript's line is tried,
    // and written again once the folder is back when it could not be.
    crate::auto_resume::announce_cancelled(&cancelled.entry, reason);
    match cancelled.unsaved {
        Some(why) => crate::unsaved::say(CANCELLED_RESUME, why),
        None => clear_cancelled_resume(manager, &cancelled.entry),
    }
    true
}

/// Drop the tombstone of a cancel that is on disk and was announced.
pub(super) fn clear_cancelled_resume(
    manager: &ChatManager,
    entry: &crate::auto_resume::ScheduledResume,
) {
    if let Err(why) = manager.auto_resumes.finish(entry) {
        // `Cancelled` is already durable and the scheduler ignores it. Leaving
        // the tombstone for startup cleanup is safer than blocking the user.
        eprintln!(
            "[chat] could not finish auto-resume cancellation for {}: {why}",
            entry.chat_key
        );
    }
}

/// Write the cancels that could not be saved when they were made, then say
/// each in its chat's transcript, where the line could not be written
/// either, and drop its tombstone once it has been. An error is a schedule
/// still owed. A line that still cannot be written keeps its tombstone,
/// which is `Cancelled` on disk by then: the next try, or the next start
/// of the server, says it.
pub(super) fn settle_cancelled_resumes(manager: &ChatManager) -> Result<(), String> {
    manager.auto_resumes.settle()?;
    for entry in manager.auto_resumes.unannounced() {
        let said = crate::auto_resume::announce_cancelled(
            &entry,
            "cancelled while the profile folder was away",
        );
        if said.is_some() {
            clear_cancelled_resume(manager, &entry);
        }
    }
    Ok(())
}

pub(super) const AUTO_RESUME_SWEEP: Duration = Duration::from_secs(15);
pub(super) const AUTO_RESUME_PROMPT: &str = "[OctiqFlow automatic resume after usage reset]\n\
Continue the task that the usage limit interrupted. Inspect the conversation and current workspace state first, then continue from the latest unfinished step without repeating completed work.";

/// Deliver one scheduler-owned turn through the same paths as a browser send.
/// An idle-reaped process is recreated with its exact saved launch settings;
/// a still-live persistent process receives an ordinary next turn.
pub(super) fn run_scheduled_resume(
    manager: Arc<ChatManager>,
    entry: &crate::auto_resume::ScheduledResume,
) -> Result<(), String> {
    let key = entry.chat_key.clone();
    if !manager.auto_resumes.active_dispatch(&key, &entry.id) {
        return Err("The auto-resume was cancelled.".into());
    }
    if let Some(target) = &entry.fallback {
        return run_provider_switch(manager, entry, target);
    }
    let turn_id = Some(format!("octiq-auto-resume-{}", entry.id));
    let send = |manager: Arc<ChatManager>| {
        chat_send_with_user_turn(
            manager,
            key.clone(),
            AUTO_RESUME_PROMPT.into(),
            None,
            None,
            turn_id.clone(),
        )
    };
    let start = |manager: Arc<ChatManager>| {
        let saved = entry.start.clone();
        let result = start_session(
            manager.clone(),
            Voice::host(key.clone()),
            saved.cwd.clone(),
            saved.agent,
            saved.model.clone(),
            saved.access,
            Some(AUTO_RESUME_PROMPT.into()),
            saved.session_id.clone(),
            saved.extra_dirs.clone(),
            saved.env.clone(),
            saved.effort.clone(),
            None,
            saved.lite,
            turn_id.clone(),
            true,
            None,
        );
        if result.is_ok() {
            manager.remember_start(&key, saved);
        }
        result
    };

    let live = manager
        .sessions
        .lock()
        .map_err(|error| error.to_string())?
        .contains_key(&key);
    if live {
        match send(manager.clone()) {
            Err(why) if why.contains("no such chat") => start(manager),
            result => result,
        }
    } else {
        match start(manager.clone()) {
            Err(why) if why.contains("already running") => send(manager),
            result => result,
        }
    }
}

/// Start the profile-local scheduler. It runs once immediately so an overdue
/// reset resumes after a service restart, then checks cheaply every few
/// seconds. No browser needs to be open.
pub fn start_auto_resume_scheduler(manager: Arc<ChatManager>) {
    thread::spawn(move || {
        // Reconcile the transcript with the authoritative schedule after a
        // crash between its JSON write and its lifecycle event. Repeating an
        // event with the same id is reducer-idempotent.
        match manager.auto_resumes.cancelled() {
            Ok(entries) => {
                for entry in entries {
                    crate::auto_resume::announce_cancelled(
                        &entry,
                        "cancelled before the service restarted",
                    );
                    if let Err(why) = manager.auto_resumes.finish(&entry) {
                        eprintln!(
                            "[chat] could not clear cancelled auto-resume {}: {why}",
                            entry.id
                        );
                    }
                }
            }
            Err(why) => {
                eprintln!("[chat] auto-resume scheduler unavailable: {why}");
                return;
            }
        }
        match manager.auto_resumes.scheduled() {
            Ok(entries) => {
                for entry in entries {
                    crate::auto_resume::announce_scheduled(&entry);
                }
            }
            Err(why) => {
                eprintln!("[chat] auto-resume scheduler unavailable: {why}");
                return;
            }
        }
        match manager.auto_resumes.take_uncertain() {
            Ok(entries) => {
                for entry in entries {
                    crate::auto_resume::announce_failed(
                        &entry,
                        "The service restarted while auto-resume was dispatching, so it was not repeated. Resume manually after checking the chat.",
                    );
                }
            }
            Err(why) => {
                eprintln!("[chat] auto-resume scheduler unavailable: {why}");
                return;
            }
        }

        loop {
            let due = match manager
                .auto_resumes
                .claim_due(crate::auto_resume::unix_now())
            {
                Ok(entries) => entries,
                Err(why) => {
                    eprintln!("[chat] could not read due auto-resumes: {why}");
                    thread::sleep(AUTO_RESUME_SWEEP);
                    continue;
                }
            };
            for entry in due {
                if entry.fallback.is_some() {
                    let busy = manager.sessions.lock().map_or(true, |sessions| {
                        sessions.get(&entry.chat_key).is_some_and(|session| {
                            session.lock().map_or(true, |session| {
                                session.busy || session.cut_off != CutOff::No
                            })
                        })
                    });
                    if busy
                        || !manager.running_background(&entry.chat_key).is_empty()
                        || crate::profile::available().is_err()
                    {
                        if let Err(why) = manager
                            .auto_resumes
                            .defer_switch(&entry, crate::auto_resume::unix_now())
                        {
                            eprintln!("[chat] could not defer provider switching: {why}");
                        }
                        continue;
                    }
                }
                crate::auto_resume::announce_started(&entry);
                let result = run_scheduled_resume(manager.clone(), &entry);
                if let Err(why) = &result {
                    crate::auto_resume::announce_failed(&entry, why);
                    if entry.user_selected && provider_switch::unchanged_start(&manager, &entry) {
                        match manager.auto_resumes.reopen_switch(&entry) {
                            Ok(Some(pending)) => crate::auto_resume::announce_scheduled(&pending),
                            Ok(None) => {}
                            Err(error) => {
                                eprintln!("[chat] could not restore provider choice: {error}")
                            }
                        }
                        // Never delete the sole pending request when restoring
                        // its choice failed to persist. It remains held, not sent.
                        continue;
                    }
                }
                if let Err(why) = manager.auto_resumes.finish(&entry) {
                    eprintln!(
                        "[chat] could not finish auto-resume {} for {}: {why}",
                        entry.id, entry.chat_key
                    );
                }
            }
            thread::sleep(AUTO_RESUME_SWEEP);
        }
    });
}

/// Permanently remove chats whose one-day trash window has elapsed. Startup
/// reconciliation handles time spent with the server off; this minute sweep
/// handles a server that stays up for days.
pub fn start_deleted_chat_reaper() {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(60));
        if let Err(why) = purge_deleted_chats() {
            eprintln!("[chats] could not purge expired chats: {why}");
        }
    });
}

use super::*;

/// Stop a chat and drop it. Killing an unknown key is a no-op success, so the
/// UI can close a chat twice without caring.
///
/// **Nothing here waits on a save** (review of 205bca2, H5). The scheduled
/// resume and the open questions are cancelled in this process whether or
/// not that could be written, and the process is ended either way; what
/// could not be recorded is said beside the answer (`unsaved::say`) and
/// owed by its store. The only error left is the process not ending.
pub fn chat_stop_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    manager.revoke_auto_plan(&key);
    cancel_auto_resume(manager, &key, "cancelled when the chat stopped");
    let _delivery = manager
        .questions
        .delivery_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cancel_question_work(manager, &key);
    forget_standing(&key);
    end_process(manager, &key)?;
    Ok(())
}

/// Whether this chat belongs to a registered agent (a lead's thread, or a
/// front desk): the chats whose runtime only `chat_switch_runtime` changes.
/// Derived from the roster, never from the page.
pub(crate) fn is_registered_chat(key: &str) -> Result<bool, String> {
    if key.starts_with("chat:orch-") {
        return Ok(false);
    }
    Ok(crate::team::defaults_for_chat(&crate::team::default_path(), key)?.is_some())
}

/// What `chat_retarget` says to a registered agent's chat.
pub(crate) const REGISTERED_RETARGET: &str = "This chat belongs to a registered agent, so the model picker cannot retarget it. Change its provider, model or effort with chat_switch_runtime (the runtime sheet); that is the only way, and it keeps the conversation.";

/// End only the host provider process so the same application conversation can
/// continue on another model. The old native session cannot be resumed by the
/// backend during the handoff; the next browser send supplies a fresh start
/// context for the selected provider. Permissions, access, and the transcript
/// belong to the user conversation and remain intact.
pub fn chat_retarget_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    // A registered agent's chat changes its runtime only through
    // `chat_switch_runtime`, at the moment the person presses. A retarget
    // here would leave a deferred page intent (a start that carries the
    // picker's choice later), which a newer switch from another tab must
    // never be undone by.
    // Only a roster that was READ and names the chat refuses: ending a
    // process never waits on a file in the profile (a roster that cannot be
    // read, because the profile folder is away, changes nothing here). A
    // start never carries a page choice for a registered chat, so ending its
    // process leaves no intent behind either way.
    if matches!(is_registered_chat(&key), Ok(true)) {
        return Err(REGISTERED_RETARGET.into());
    }
    cancel_auto_resume(manager, &key, "cancelled when the agent changed");
    end_process(manager, &key)?;
    manager
        .starts
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&key);
    // Forgotten in the ledger's memory whether or not that is saved: the
    // old provider's settings must not resume the chat after its process
    // was ended for another.
    manager.orchestrations.forget_resume_context(&key)?;
    Ok(())
}

/// End this chat's agent on purpose, and keep everything else about the chat.
///
/// The sweeper's ending, asked for instead of waited out. An agent reads its
/// MCP servers, its plugins and the tool list they add up to ONCE, at spawn, so
/// a chat that was already open when one of them was added never sees it. Until
/// this there was no way to a fresh process but to leave the chat alone for the
/// fifteen minutes the sweeper takes.
///
/// `end_process`, NOT `chat_stop_impl`, because standing permissions and the
/// access level belong to the work, and the work is carrying straight on.
///
/// Answers how many processes went, which is 0 for a chat already stopped.
pub fn chat_restart_impl(manager: &ChatManager, key: String) -> Result<usize, String> {
    Ok(usize::from(end_process(manager, &key)?))
}

/// End one chat process while preserving its transcript and remembered settings.
///
/// Unlike stopping a chat, this intentionally retains standing permissions and
/// access settings so the next message can resume the same work. Any queued
/// queued follow-up is discarded: the person explicitly ended the process it
/// was waiting on.
pub(super) fn end_process(manager: &ChatManager, key: &str) -> Result<bool, String> {
    manager.revoke_auto_plan(key);
    end_process_when(manager, key, None)
}

pub(super) fn end_process_when(
    manager: &ChatManager,
    key: &str,
    idle: Option<Duration>,
) -> Result<bool, String> {
    end_process_inner(manager, key, idle, None)
}

/// End the process under `key` only if it is the launch `only`; any other
/// session there (a newer launch of the same chat) is left alone, with its
/// queue and completion. The check and the removal are one step under the
/// session table's lock.
pub(super) fn end_process_of_launch(
    manager: &ChatManager,
    key: &str,
    only: &Arc<Mutex<ChatSession>>,
) -> Result<bool, String> {
    end_process_inner(manager, key, None, Some(only))
}

pub(super) fn end_process_inner(
    manager: &ChatManager,
    key: &str,
    idle: Option<Duration>,
    only: Option<&Arc<Mutex<ChatSession>>>,
) -> Result<bool, String> {
    let session = {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(only) = only {
            if !sessions
                .get(key)
                .is_some_and(|current| Arc::ptr_eq(current, only))
            {
                return Ok(false);
            }
        }
        if let Some(timeout) = idle {
            let Some(session) = sessions.get(key) else {
                return Ok(false);
            };
            let session = session.lock().map_err(|e| e.to_string())?;
            // A chat whose queue waits for the profile folder is not idle:
            // ending it as idle would drop what the person queued.
            if session.still_for().is_none_or(|still| still < timeout)
                || manager.background.has_running(key)
                || manager.jobs.has_running(key)
                || manager.waits_because(key).is_some()
            {
                return Ok(false);
            }
        }
        // Invalidate under the table lock, before the old Arc can be
        // mistaken for a naturally reaped process by automatic approval.
        manager.revoke_auto_plan(key);
        if key.starts_with("chat:orch-") {
            if let Some(session) = sessions.get(key) {
                // Publish the pending child before removing its table entry.
                // The reaper takes no ledger lock while checking this map.
                manager
                    .ending_workers
                    .lock()
                    .map_err(|e| e.to_string())?
                    .insert(key.into(), session.clone());
            }
        }
        sessions.remove(key)
    };
    // Ending the process on purpose ends a completion in it, running or
    // still queued: said once, before the queue is cleared.
    manager.fail_completion(key, COMPLETION_STOPPED);
    // Removal from the session map happens before clearing the queue, so a
    // concurrent send cannot add a new deferred turn after this cleanup.
    manager.forget_queued_turns(key);
    let Some(session) = session else {
        return Ok(false);
    };
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    stop_process(manager, key, &mut guard);
    Ok(true)
}

/// End the process of a session that has been taken out of the session
/// table. Called with the session held.
pub(super) fn stop_process(manager: &ChatManager, key: &str, session: &mut ChatSession) {
    manager.revoke_auto_plan(key);
    session.cut_off = CutOff::Ended;
    if let Some(codex) = session.codex.as_mut() {
        codex.elicitations.clear();
        codex.mcp_calls.clear();
        codex.mcp_refusals.clear();
    }
    if let Err(error) = manager.background.interrupt(key, &session.launch_id,
        "The provider session was ended or switched. Background work is no longer attached; inspect retained output before retrying.") {
        eprintln!("chat: cannot record interrupted background work: {error}");
    }
    // Closing stdin asks persistent providers to finish; kill is the backstop.
    session.stdin.take();
    let _ = session.child.kill();
}

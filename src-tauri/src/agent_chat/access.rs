use super::*;

/// The level each running chat is on RIGHT NOW, by chat key.
///
/// `OCTIQ_ACCESS` is written once, into the environment of a process that has
/// already been spawned, so a level changed part-way through a chat can never
/// reach it — nothing can rewrite the environment of a running process from
/// outside. The permission hook used to decide from that variable alone, which
/// meant it answered for the level the chat STARTED on: pick Bypass permissions
/// halfway through and it went on stopping every command, dial back down from
/// it and it stood aside from the very asking that level is for.
///
/// So the hook no longer decides — and neither, now, does this. `permission::ask`
/// runs LAST, over the agent's own control channel, so every question that
/// reaches it is one the agent's own rules already decided a person must answer;
/// there is nothing left to pre-filter. The write side remains for diagnostics
/// and tests.
///
/// Entries are written by `chat_start` and `chat_set_access` and dropped by
/// `chat_stop`. A chat that ends on its own leaves its entry behind on purpose:
/// removing it from the reaper thread would race a restart under the same key
/// and delete the NEW level. A stale entry costs nothing — the only reader is a
/// hook belonging to that chat, and a chat that is gone has none.
pub(super) static ACCESS: Mutex<Option<HashMap<String, Access>>> = Mutex::new(None);

pub(super) fn with_access<T>(f: impl FnOnce(&mut HashMap<String, Access>) -> T) -> T {
    let mut guard = ACCESS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Remember the level the hook will answer at.
pub(crate) fn record_access_for(key: &str, access: Option<Access>) {
    with_access(|a| a.insert(key.to_string(), access.unwrap_or(Access::Read)));
}

/// What a chat may do at this moment, or None when no chat by that key is known.
///
/// Claude and Codex ask on their own control channels and no longer read this;
/// Pi's host gate (`pi_gate`) does, on every tool call.
pub fn access_now(key: &str) -> Option<Access> {
    with_access(|a| a.get(key).copied())
}

/// Change what a RUNNING chat may do, WITHOUT ending it.
///
/// The mode is on the command line, so changing it used to mean killing the
/// process and letting the next message start a new one. That threw away a turn
/// in flight and said nothing about why the answer had stopped half-written.
/// Claude takes a `set_permission_mode` control request down the same stdin the
/// prompts go down — the way `chat_interrupt` takes `interrupt` — so the session
/// and its context survive the change.
///
/// The hook is told separately, through `ACCESS`. It runs BEFORE
/// `--permission-mode` is consulted, so the control request on its own would
/// leave it answering for the level the chat started on.
///
/// Not every change can be made this way, and the agent is the one that says
/// so: `bypassPermissions` is available only to a process that was launched
/// with `--dangerously-skip-permissions`, and `auto` is refused by models that
/// do not have it. Full is therefore rejected here before anything is written
/// to Claude's stream; the client restarts cleanly, and its next turn launches
/// at the requested level. Other provider refusals arrive on stdout and go out
/// as an `access-refused` status (see `refused_access_change`); the UI falls
/// back to the same restart. The recorded level is deliberately NOT rolled
/// back when that happens — every combination of "hook thinks X, agent is on
/// Y" the failure can leave behind ends in the agent asking or refusing, never
/// in it acting unasked.
///
/// Command-line providers have no such channel and need none: every turn is a
/// fresh process and receives its access flags on the command line, so recording
/// the level is the whole job.
pub fn chat_set_access_impl(
    manager: &ChatManager,
    key: String,
    access: Access,
) -> Result<(), String> {
    // A front desk's access is fixed at launch (read-only, `dontAsk` on
    // Claude), and every relaunch forces it again. A live switch would only
    // move it into another mode, so the change is accepted and not applied.
    // Not an error: the client answers an error with a restart.
    if manager
        .front_desks
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&key)
    {
        return Ok(());
    }
    if let Some(start) = manager.start_context(&key) {
        manager.admit_beside_writers(
            &key,
            &key,
            std::iter::once(&start.cwd).chain(start.extra_dirs.iter().flatten()),
            access != Access::Read,
        )?;
    }
    // WHICH WAY the level moves decides everything below (review of
    // b894867, H8). A lowering takes hold at once and is written down when
    // it can be. A raise outlives the moment it is given: a host resume, a
    // queued turn and the next process all start at it, so it needs its
    // record first, and while that cannot be written it is refused with
    // nothing changed. Said before anything else is touched.
    let before = manager.start_context(&key);
    let level = before
        .as_ref()
        .and_then(|start| start.access)
        .unwrap_or(Access::Read);
    let raise = crate::access_request::rank(access) > crate::access_request::rank(level);
    if raise {
        crate::profile::available().map_err(not_raised)?;
    }
    cancel_auto_resume(manager, &key, "cancelled when access changed");
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&key).cloned().ok_or("no such chat")?
    };
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let provider = provider_for(guard.agent);
    let thread = guard.codex.is_some();
    let live = !thread && provider.capabilities().supports_live_access_change;
    // A process that keeps the conversation but cannot change its access
    // (Antigravity) takes the new level in the process that resumes it.
    let relaunch = !thread
        && !live
        && provider.capabilities().input.accepts_stdin()
        && (provider.capabilities().interrupt_ends_process
            || provider.capabilities().access_change_relaunches);
    // Every refusal that changes nothing comes before the record of a raise.
    if relaunch && guard.busy {
        return Err(format!(
            "{} takes a new access level between turns. Wait for this turn or stop it, then change the access.",
            provider.display_name()
        ));
    }
    let payload = if live {
        if matches!(access, Access::Full) {
            return Err("Full access needs a fresh agent".into());
        }
        if guard.stdin.is_none() {
            return Err("this chat does not take more input".into());
        }
        Some(
            provider
                .access_change_payload(access)
                .ok_or("this chat does not take more input")?,
        )
    } else {
        None
    };
    if raise {
        manager.record_raise(&key, access)?;
    }
    if let Some(codex) = guard.codex.as_mut() {
        // app-server accepts policy overrides on every `turn/start`. Do not
        // disturb a turn already running; the next queued/direct turn picks up
        // the newly selected level on this same native thread.
        codex.access = Some(access);
        if let Ok(mut starts) = manager.starts.lock() {
            if let Some(start) = starts.get_mut(&key) {
                start.access = Some(access);
            }
        }
        record_access_for(&key, Some(access));
        manager.keep_access_for_resume(&key);
        return Ok(());
    }
    if let Some(payload) = payload {
        let told = guard
            .stdin
            .as_mut()
            .ok_or_else(|| "this chat does not take more input".to_string())
            .and_then(|stdin| {
                writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
                stdin.flush().map_err(|e| e.to_string())
            });
        if let Err(why) = told {
            // The agent was not told, so the chat still runs at the level
            // it had: the record of a raise goes back to that.
            if let (true, Some(before)) = (raise, before) {
                manager.keep_resume_at(&key, before);
            }
            return Err(why);
        }
    }
    if let Some(mut start) = manager.start_context(&key) {
        start.access = Some(access);
        manager.remember_start(&key, start);
    }
    manager.keep_access_for_resume(&key);
    if relaunch {
        drop(guard);
        end_process_when(manager, &key, Some(Duration::ZERO))?;
    }
    Ok(())
}

pub(super) fn not_raised(why: String) -> String {
    format!("{NOT_RAISED}{why}")
}

impl ChatManager {
    /// Write down that `key` runs at `access` from here on, BEFORE the
    /// agent is told: where a host resume reads it back from (the ledger,
    /// for a chat a run knows). A chat no run knows has no host record of
    /// its level beyond this server's memory; the page keeps it with the
    /// chat, in the same folder, which the caller has just found there.
    pub(super) fn record_raise(&self, key: &str, access: Access) -> Result<(), String> {
        let Some(mut start) = self.start_context(key) else {
            return Ok(());
        };
        start.access = Some(access);
        self.orchestrations
            .save_resume_context(key, start)
            .map_err(not_raised)
    }

    /// Put the record of a chat's level back to `start`, whether or not
    /// that can be saved: only ever a lowering, back to what still runs.
    pub(super) fn keep_resume_at(&self, key: &str, start: StartContext) {
        if let Err(why) = self.orchestrations.keep_resume_context(key, start) {
            eprintln!("orchestration: could not keep the access level of {key}: {why}");
        }
    }
}

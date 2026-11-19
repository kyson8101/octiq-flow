use super::*;

/// Whether a conversation goes on only in a new process: every turn of a
/// command-line provider, and the turn after a stop or an exit for a provider
/// whose stdin takes no control message (Antigravity). Its queue is carried
/// into that process rather than dropped with the old one.
pub(super) fn relaunches_to_continue(agent: ChatAgent) -> bool {
    let capabilities = provider_for(agent).capabilities();
    !capabilities.input.accepts_stdin() || capabilities.interrupt_ends_process
}

/// Send the interrupt understood by a provider with a persistent stdin.
pub(super) fn interrupt_persistent_turn(
    manager: &ChatManager,
    key: &str,
    session: &mut ChatSession,
) -> Result<(), String> {
    manager.revoke_auto_plan(key);
    session.auto_plan_attribution = AutoPlanAttribution::Unattributed;
    if session.codex.is_some() {
        write_codex_interrupt_locked(session)?;
        session.turn_ended();
        return Ok(());
    }
    let payload = provider_for(session.agent)
        .interrupt_payload()
        .ok_or("this chat does not take more input")?;
    let stdin = session
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    // The turn is over as far as anyone waiting is concerned, and the still
    // clock starts here rather than at whatever `result` the agent may or may
    // not send after being cut off. A session that stopped and was never
    // spoken to again is exactly what the sweeper is for.
    session.turn_ended();
    Ok(())
}

/// Ask the agent to stop what it is doing, WITHOUT ending the conversation.
///
/// Claude and Codex both cancel a running turn over their persistent control
/// channel and keep the native conversation alive. Command-line fallback
/// providers end only the current process; the next process resumes from the
/// remembered conversation id.
///
/// **The queue behind the stopped turn SURVIVES, and its first message starts
/// straight away.** Stop is how a person says "not that — do the thing I have
/// already typed instead", and it was that for as long as this app has had a
/// Stop button: a queued message used to go down Claude's stdin into Claude's
/// OWN queue, which an interrupt made it pick up immediately. Card 84 moved
/// that queue to this side so a message could still be taken back, and dropped
/// it here — quietly ending a way of working that had always worked. What
/// takes a message back is the ✕ on its own bubble, which says which one.
///
/// Nothing here writes the next message: a persistent provider's is handed
/// over by the reader thread when the cut-off turn's own `result` lands (see
/// `turn_finished`), under the lock that ends the turn, so it cannot jump
/// ahead of anything. A one-shot provider has no reader to do it, so this
/// carries the queue across the process replacement by hand.
///
/// A persistent agent that does not honour the Stop within `UNWIND_GRACE`
/// has its process ended, and the queue's first message starts in the next
/// one (`grace_ran_out`).
///
/// **A next message that cannot start does not make the Stop fail, and
/// costs nothing that was queued.** Starting the next message is a new
/// turn, and no turn starts while its record cannot be kept (the profile
/// folder is away). The Stop has stopped the agent by then: it answers
/// that, how many messages still wait, and why the first did not start
/// (`Stopped`); the queue is what it was, in its order (`keep_waiting`).
pub(super) fn interrupt_session(
    manager: &Arc<ChatManager>,
    session_key: &str,
    stream_key: &str,
) -> Result<Stopped, String> {
    interrupt_session_with(manager, session_key, stream_key, |turn| {
        start_queued_turn(manager.clone(), session_key, stream_key, turn, true)
    })
}

pub(super) fn interrupt_session_with(
    manager: &Arc<ChatManager>,
    session_key: &str,
    stream_key: &str,
    start: impl FnOnce(QueuedTurn) -> Result<(), String>,
) -> Result<Stopped, String> {
    manager.revoke_auto_plan(session_key);
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        match sessions.get(session_key).cloned() {
            Some(session) => session,
            None => {
                // Stop after a natural reaper still vetoes its buffered stop.
                return Err("no such chat".into());
            }
        }
    };
    let agent = {
        let guard = session.lock().map_err(|e| e.to_string())?;
        guard.agent
    };
    // Command-line providers cannot receive a control message after startup,
    // and Antigravity's stdin takes none. Remove and kill the current process,
    // but deliberately leave `StartContext` intact so the next user turn can
    // resume it.
    if relaunches_to_continue(agent) {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if !sessions
            .get(session_key)
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            return Ok(manager.stopped(session_key));
        }
        let mut guard = session.lock().map_err(|e| e.to_string())?;
        // Stopping the wrap-up itself ends the completion; the process this
        // kills will never send that turn's full stop.
        manager.completion_cut_short(session_key, &guard, COMPLETION_STOPPED);
        let next = manager.take_queued_turn(session_key);
        if next.is_some() {
            manager
                .handoffs
                .lock()
                .map_err(|e| e.to_string())?
                .insert(session_key.to_string());
        }
        manager.revoke_auto_plan(session_key);
        guard.cut_off = CutOff::Ended;
        sessions.remove(session_key);
        guard.stdin.take();
        let _ = guard.child.kill();
        drop(guard);
        drop(sessions);
        if let Some(next) = next {
            let carried = carry_queued_turn(manager, session_key, stream_key, next, start)
                .map_err(|why| format!("could not resume queued message: {why}"))?;
            if carried != Carried::Started {
                say_exited(manager, session_key, stream_key);
            }
        }
        return Ok(manager.stopped(session_key));
    }

    let mut guard = session.lock().map_err(|e| e.to_string())?;
    // Marked under the lock the interrupt goes out with, so nothing slips
    // into the gap: no notification, no message and no wrap-up is written
    // until the reader has seen the cut-off turn's full stop and cleared
    // this. A second Stop inside that wait is the same unwind: it asks the
    // agent again, and neither ends the wait nor starts another.
    // The first prompt is still waiting for the worker's browser server: no
    // turn is in flight, so there is nothing to stop and nothing to unwind
    // (`first_turn_held`). The prompt goes when the server settles, then
    // whatever queued behind it. A Task or Run Stop ends the process instead.
    if guard.first_turn_held {
        drop(guard);
        return Ok(manager.stopped(session_key));
    }
    let was_busy = guard.busy;
    let owed = guard.cut_off != CutOff::No;
    interrupt_persistent_turn(manager, &session_key, &mut guard)?;
    if was_busy && !owed {
        let unwind = manager.next_unwind();
        guard.cut_off = CutOff::Owed(unwind);
        end_process_when_grace_runs_out(manager, session_key, stream_key, &session, unwind);
    }
    // The cut-off wrap-up's own full stop finds no completion left to
    // decide, so a Stop can never tick a chat.
    manager.completion_cut_short(session_key, &guard, COMPLETION_STOPPED);
    drop(guard);
    // What waits is handed over on the stopped turn's full stop, where a
    // folder that is away holds it (`dispatch_next_persistent_turn`).
    let mut stopped = manager.stopped(session_key);
    if stopped.waiting > 0 && stopped.not_started.is_none() {
        stopped.not_started = crate::profile::available().err();
    }
    Ok(stopped)
}

impl ChatManager {
    /// What a Stop that has stopped the agent answers: how many messages
    /// still wait, and why the first did not start when its queue waits.
    pub(super) fn stopped(&self, session_key: &str) -> Stopped {
        Stopped {
            stopped: true,
            waiting: self.queued_messages(session_key),
            not_started: self.waits_because(session_key),
        }
    }
}

/// The Stop button. Like `chat_stop_impl`, nothing in it waits on a save:
/// its answer is whether the agent was asked to stop, and what still waits
/// behind the stopped turn (`Stopped`).
pub fn chat_interrupt_impl(manager: &Arc<ChatManager>, key: String) -> Result<Stopped, String> {
    manager.revoke_auto_plan(&key);
    cancel_auto_resume(manager, &key, "cancelled when the user stopped the chat");
    let _delivery = manager
        .questions
        .delivery_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cancel_question_work(manager, &key);
    interrupt_session(manager, &key, &key)
}

/// Feedback 531f1dac: cut a worker's turn short so its coordinator's message
/// reaches it now. A worker reads a message between turns or in the answer to
/// its next call to the host, and one inside a twenty-minute render makes
/// neither, so a pause or a stop arrived after the work it was meant to
/// prevent.
///
/// The interrupt is the Stop button's: the provider cancels the running tool
/// and keeps the conversation, the attempt waits for a report rather than
/// failing, and `inbox::deliver_pending` hands the message over once the
/// cut-off turn has reached its own full stop.
pub(crate) fn interrupt_worker_turn(
    manager: &Arc<ChatManager>,
    key: &str,
) -> Result<WorkerInterrupt, String> {
    let busy = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        match sessions.get(key) {
            Some(session) => {
                let session = session.lock().map_err(|e| e.to_string())?;
                // A held first prompt is no turn in flight: the message goes
                // in between turns, behind it.
                (session.busy && !session.first_turn_held).then_some(session.agent)
            }
            None => None,
        }
    };
    let Some(agent) = busy else {
        return Ok(WorkerInterrupt::Idle);
    };
    if relaunches_to_continue(agent) {
        return Ok(WorkerInterrupt::Unsupported);
    }
    chat_interrupt_impl(manager, key.to_string())?;
    Ok(WorkerInterrupt::Interrupted)
}

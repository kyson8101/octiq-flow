use super::*;

/// What cancelled questions are called when the cancel could not be
/// recorded (`unsaved::say`).
pub(super) const CANCELLED_QUESTIONS: &str = "the cancelled questions";

/// Cancel every open question of a chat that is being stopped, and take
/// back the answers queued for it. It answers nothing a Stop could wait on:
/// the questions are cancelled in this process, the tools waiting on them
/// are told, and a save that failed is said and owed.
pub(super) fn cancel_question_work(manager: &ChatManager, key: &str) {
    // Read before the cancel takes them out of the outbox. A question file
    // that could not be read holds nothing here to cancel.
    let records = manager.questions.outbox().unwrap_or_default();
    match manager.questions.cancel_chat(key) {
        Ok(Some(why)) => crate::unsaved::say(CANCELLED_QUESTIONS, why),
        Ok(None) => {}
        Err(why) => eprintln!("[chat] could not cancel the questions of {key}: {why}"),
    }
    for record in records
        .into_iter()
        .filter(|r| r.origin.chat_key == key || r.origin.session_key == key)
    {
        if let Some(turn) = manager.cancel_queued_turn(&record.origin.chat_key, &record.turn_id()) {
            announce_cancelled(&record.origin.chat_key, &turn);
        }
    }
}

/// Whether `chat_key` was started with the turn `turn_id`. The durable user
/// turn is written only once the agent holding it has been spawned
/// (`start_session`), so its presence is the receipt a retry can trust: a
/// handover's new chat is never started twice.
pub(crate) fn turn_was_started(chat_key: &str, turn_id: &str) -> bool {
    crate::transcript::since(chat_key, 0)
        .into_iter()
        .any(|item| {
            item.event["uuid"].as_str() == Some(turn_id)
                && item.event["octiq_user_turn"].as_bool() == Some(true)
        })
}

/// The durable prompt id is also the retry key. A crash after dispatch must
/// never cause an automatic second execution of an answer already handed over.
pub(super) fn question_receipt(record: &crate::question_store::Record) -> Option<String> {
    let id = record.turn_id();
    let mut state = None;
    for item in crate::transcript::since(&record.origin.chat_key, 0) {
        let event = item.event;
        if event["octiq_user_turn_id"].as_str() == Some(&id) {
            return Some("received".into());
        }
        if event["uuid"].as_str() == Some(&id) {
            match event["type"].as_str() {
                Some("octiq_user_turn_delivery") => {
                    state = event["state"].as_str().map(str::to_string)
                }
                Some("octiq_user_turn_cancelled") => return Some("cancelled".into()),
                _ => {}
            }
        }
    }
    state
}

pub(super) fn resume_question(
    manager: Arc<ChatManager>,
    record: &crate::question_store::Record,
) -> Result<(), String> {
    continue_origin(
        manager,
        &record.origin,
        record.continuation(),
        record.turn_id(),
    )
}

/// Hand `text` to the chat that made a saved request, as a host turn: sent
/// to its running agent, or resumed in its own provider session when it has
/// stopped. Late `ask_user` answers and handover decisions both come back
/// this way, and refuse rather than continue a different session.
pub(crate) fn continue_origin(
    manager: Arc<ChatManager>,
    origin: &QuestionOrigin,
    text: String,
    turn_id: String,
) -> Result<(), String> {
    let start = manager
        .start_context(&origin.session_key)
        .unwrap_or_else(|| origin.start.clone());
    if start.agent != origin.start.agent || start.session_id != origin.start.session_id {
        return Err("This conversation now uses a different agent session. Your answers are saved; continue from them in the chat.".into());
    }
    if origin.session_key != origin.chat_key {
        return Err("Answers for removed additional agents are saved, but cannot be delivered automatically. Continue from them in the chat.".into());
    }
    match chat_send_with_user_turn(
        manager.clone(),
        origin.chat_key.clone(),
        text.clone(),
        None,
        None,
        Some(turn_id.clone()),
    ) {
        Ok(()) => return Ok(()),
        Err(why) if why == "no such chat" || why.ends_with("is not running") => {}
        Err(why) => return Err(why),
    }
    manager.remember_start(&origin.session_key, start.clone());
    start_session(
        manager,
        Voice::host(origin.chat_key.clone()),
        start.cwd,
        start.agent,
        start.model,
        start.access,
        Some(text),
        start.session_id,
        start.extra_dirs,
        start.env,
        start.effort,
        None,
        start.lite,
        Some(turn_id),
        true,
        None,
    )
}

/// Runs after a saved submission and at startup. Reconciliation keeps queued
/// answers recoverable when a process exits before consuming its queue.
pub(crate) fn deliver_question_answers(manager: Arc<ChatManager>) -> Result<(), String> {
    deliver_question_answers_with(manager.clone(), |record| {
        resume_question(manager.clone(), record)
    })
}

pub(super) fn deliver_question_answers_with(
    manager: Arc<ChatManager>,
    mut send: impl FnMut(&crate::question_store::Record) -> Result<(), String>,
) -> Result<(), String> {
    use crate::question_store::Delivery;
    let _delivery = manager
        .questions
        .delivery_lock
        .lock()
        .map_err(|e| e.to_string())?;
    for record in manager.questions.outbox()? {
        let receipt = question_receipt(&record);
        if matches!(record.delivery, Delivery::Dispatching | Delivery::Queued) && receipt.is_none()
        {
            manager.questions.set_delivery(&record.id, Delivery::Uncertain, Some("Your answers are saved, but delivery was interrupted before it could be confirmed. Check the conversation and continue there; this answer will not be resent automatically.".into()))?;
            continue;
        }
        match receipt.as_deref() {
            Some("received") => {
                manager
                    .questions
                    .set_delivery(&record.id, Delivery::Delivered, None)?;
                continue;
            }
            Some("cancelled") => {
                manager.questions.cancel(&record.ids)?;
                continue;
            }
            Some("dispatched") | Some("unknown") => {
                let running = manager
                    .sessions
                    .lock()
                    .map_err(|e| e.to_string())?
                    .contains_key(&record.origin.session_key);
                if !running {
                    manager.questions.set_delivery(&record.id, Delivery::Uncertain, Some("Your answers were saved, but the agent stopped before confirming receipt. Check the chat and continue there; the answers will not be sent twice automatically.".into()))?;
                }
                continue;
            }
            Some("queued") => {
                let queued = manager
                    .queued_turns
                    .lock()
                    .map_err(|e| e.to_string())?
                    .get(&record.origin.session_key)
                    .is_some_and(|q| q.iter().any(|t| t.owns_turn_id(&record.turn_id())));
                let handoff = manager
                    .handoffs
                    .lock()
                    .map_err(|e| e.to_string())?
                    .contains(&record.origin.session_key);
                if queued || handoff {
                    continue;
                }
            }
            _ => {}
        }
        manager
            .questions
            .set_delivery(&record.id, Delivery::Dispatching, None)?;
        match send(&record) {
            Ok(()) => manager
                .questions
                .set_delivery(&record.id, Delivery::Queued, None)?,
            Err(why) => manager.questions.set_delivery(
                &record.id,
                Delivery::Failed,
                Some(format!(
                    "Your answers are saved. Could not continue the agent: {why}"
                )),
            )?,
        }
    }
    Ok(())
}

pub(crate) fn start_question_recovery(manager: Arc<ChatManager>) {
    thread::spawn(move || {
        let mut previous_error = None;
        loop {
            let error = deliver_question_answers(manager.clone()).err();
            if error != previous_error {
                if let Some(why) = &error {
                    eprintln!("[questions] {why}");
                }
                previous_error = error;
            }
            thread::sleep(Duration::from_secs(2));
        }
    });
}

pub(crate) fn cancel_questions(manager: &ChatManager, ids: &[String]) -> Result<(), String> {
    let _delivery = manager
        .questions
        .delivery_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let records = manager.questions.outbox()?;
    // Cancelled here and the waiting tool told, whether or not it could be
    // saved: a cancel that was only refused left the agent waiting.
    if let Some(why) = manager.questions.cancel(ids)? {
        crate::unsaved::say(CANCELLED_QUESTIONS, why);
    }
    for record in records
        .into_iter()
        .filter(|r| r.ids.iter().any(|id| ids.contains(id)))
    {
        if let Some(turn) = manager.cancel_queued_turn(&record.origin.chat_key, &record.turn_id()) {
            announce_cancelled(&record.origin.chat_key, &turn);
        }
    }
    Ok(())
}

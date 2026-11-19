use super::*;

pub(crate) fn route_worker_questions(
    manager: &Arc<ChatManager>,
    key: &str,
    session_key: Option<&str>,
    launch_id: Option<&str>,
    questions: &[crate::question::Question],
) -> Result<Option<String>, String> {
    if manager.orchestrations.worker_coordinator(key)?.is_none() {
        manager.orchestrations.require_user_chat(key)?;
        return Ok(None);
    }
    let gate = {
        let _delivery = manager
            .questions
            .delivery_lock
            .lock()
            .map_err(|e| e.to_string())?;
        manager.question_origin(key, session_key, launch_id)?;
        manager
            .orchestrations
            .route_worker_questions(key, questions)?
    };
    let Some(gate) = gate else {
        return Ok(None);
    };
    Ok(Some(format!(
        "Your questions were routed to main-chat gate {}. No answer has been given. End this turn and wait for the coordinator to resolve the gate; do not ask the user directly.",
        gate.id
    )))
}

/// Remember the tool calls in one Claude assistant message by id, so an
/// auto-mode refusal naming one can say exactly what was refused.
pub(super) fn note_claude_calls(event: &Value, calls: &mut HashMap<String, (String, Value)>) {
    if event.get("type").and_then(Value::as_str) != Some("assistant") {
        return;
    }
    let Some(content) = event
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    if calls.len() > 256 {
        calls.clear();
    }
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let (Some(id), Some(name)) = (
            block.get("id").and_then(Value::as_str),
            block.get("name").and_then(Value::as_str),
        ) else {
            continue;
        };
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        calls.insert(id.to_string(), (name.to_string(), input));
    }
}

/// The server's runtime, recorded once at startup by `remember_runtime`.
pub(super) static SERVER_RUNTIME: std::sync::OnceLock<tokio::runtime::Handle> =
    std::sync::OnceLock::new();

/// Record the runtime permission and question answers are waited on, for
/// chats started from threads that have none of their own.
pub fn remember_runtime(handle: tokio::runtime::Handle) {
    let _ = SERVER_RUNTIME.set(handle);
}

/// The runtime a chat's questions are answered on: the caller's own when it
/// has one, else the server's. None only when neither exists.
pub(super) fn answer_runtime() -> Option<tokio::runtime::Handle> {
    tokio::runtime::Handle::try_current()
        .ok()
        .or_else(|| SERVER_RUNTIME.get().cloned())
}

/// Put the question to the person, then write the answer back to the agent.
///
/// The agent is BLOCKED until that answer arrives, so nothing here may be
/// skipped: every path writes exactly one `control_response`. A question that
/// went unanswered used to be a chat that sat still with nothing on screen
/// explaining why.
pub(super) fn answer_permission(
    session: &Arc<Mutex<ChatSession>>,
    key: &str,
    rt: Option<&tokio::runtime::Handle>,
    request_id: String,
    request: Value,
) {
    let field = |name: &str| {
        request
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let ask = crate::permission::Request {
        chat_key: Some(key.to_string()),
        session_id: field("session_id"),
        provider: Some(ChatAgent::Claude),
        tool_name: field("tool_name"),
        tool_input: request.get("input").cloned(),
        tool_use_id: field("tool_use_id"),
        cwd: None,
        // Only the hook had a stale copy of the level to report. This arrives
        // from the live process, so there is nothing to fall back to.
        access: None,
        ..Default::default()
    };

    let tool = ask.tool_name.clone().unwrap_or_default();
    if crate::permission::host_bookkeeping(&tool) {
        eprintln!("[perm] {key} {tool} -> allow (host bookkeeping)");
        write_control_response(session, &request_id, json!({ "behavior": "allow" }));
        return;
    }
    let Some(rt) = rt else {
        // No runtime to wait on — the desktop build. Deny rather than leave the
        // agent parked on a question that will never be put to anyone.
        eprintln!("[perm] {key} no runtime to ask on; denying {tool}");
        write_control_response(
            session,
            &request_id,
            json!({ "behavior": "deny", "message": "OctiqFlow could not ask anyone." }),
        );
        return;
    };

    let session = session.clone();
    let key = key.to_string();
    rt.spawn(async move {
        eprintln!("[perm] {key} asking about {tool}");
        let call = ask.tool_use_id.clone();
        let answer = crate::permission::ask(ask).await;
        note_permission_outcome(&key, call.as_deref(), &answer);
        eprintln!(
            "[perm] {key} {tool} -> {} ({})",
            answer.decision, answer.reason
        );
        // `allow` is the only yes. Everything else — a refusal, a timeout,
        // nobody watching — is a no WITH ITS REASON, which the agent repeats to
        // the user. "Abstain" has no meaning here: the chain has already decided
        // it wants a person, so there is nothing left to defer to.
        let response = if answer.decision == "allow" {
            json!({ "behavior": "allow" })
        } else {
            json!({ "behavior": "deny", "message": answer.reason })
        };
        write_control_response(&session, &request_id, response);
    });
}

/// A refused permission card is OctiqFlow's refusal, not the provider's: say
/// so on the call it was about, before the agent hears the answer, so the
/// line is in the transcript ahead of the failed result it explains.
pub(super) fn note_permission_outcome(
    key: &str,
    call: Option<&str>,
    answer: &crate::permission::Answer,
) {
    if let (Some(call), Some(outcome)) = (call, crate::outcome::of_permission(answer)) {
        crate::outcome::record_tool(key, call, &outcome);
    }
}

/// Write one `control_response` back to the agent. Best-effort: a chat whose
/// stdin has gone is a chat that is no longer waiting for this.
pub(super) fn write_control_response(
    session: &Arc<Mutex<ChatSession>>,
    request_id: &str,
    response: Value,
) {
    let Ok(mut guard) = session.lock() else {
        return;
    };
    let Some(payload) = provider_for(guard.agent).control_response_payload(request_id, response)
    else {
        return;
    };
    let Some(stdin) = guard.stdin.as_mut() else {
        return;
    };
    let _ = writeln!(stdin, "{payload}");
    let _ = stdin.flush();
}

/// Cancel a dialog a Pi extension opened over RPC. Nobody can answer it, and
/// Pi waits for the answer for as long as the process lives.
pub(super) fn cancel_ui_request(session: &Arc<Mutex<ChatSession>>, id: &str) {
    let Ok(mut guard) = session.lock() else {
        return;
    };
    let Some(stdin) = guard.stdin.as_mut() else {
        return;
    };
    let _ = writeln!(
        stdin,
        "{}",
        json!({ "type": "extension_ui_response", "id": id, "cancelled": true })
    );
    let _ = stdin.flush();
}

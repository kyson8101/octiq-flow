use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn initialize_codex_app_server(
    stdin: &mut ChildStdin,
    reader: &mut BufReader<ChildStdout>,
    cwd: &str,
    model: Option<&str>,
    effort: Option<&str>,
    access: Option<Access>,
    resume: Option<&str>,
    workspace_roots: &[String],
    developer_instructions: &str,
) -> Result<(String, Vec<Value>), String> {
    let mut prelude = Vec::new();
    write_json_line(stdin, &crate::codex_app_server::initialize_request())?;
    wait_for_codex_response(reader, crate::codex_app_server::INITIALIZE_ID, &mut prelude)?;
    write_json_line(stdin, &crate::codex_app_server::initialized_notification())?;
    write_json_line(
        stdin,
        &crate::codex_app_server::thread_request(crate::codex_app_server::ThreadRequest {
            cwd,
            model,
            effort,
            access,
            resume,
            workspace_roots,
            developer_instructions,
        }),
    )?;
    let result = wait_for_codex_response(reader, crate::codex_app_server::THREAD_ID, &mut prelude)?;
    let thread_id = crate::codex_app_server::thread_id_from_result(&result)
        .ok_or("Codex app-server did not return a thread id")?
        .to_string();
    Ok((thread_id, prelude))
}

pub(super) fn write_codex_interrupt_locked(session: &mut ChatSession) -> Result<bool, String> {
    let Some(codex) = session.codex.as_mut() else {
        return Ok(false);
    };
    let Some(turn_id) = codex.active_turn_id.clone() else {
        codex.interrupt_when_started = true;
        return Ok(false);
    };
    let request_id = codex.request_id("interrupt");
    let payload =
        crate::codex_app_server::interrupt_request(&request_id, &codex.thread_id, &turn_id);
    let stdin = session
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    write_json_line(stdin, &payload)?;
    codex.interrupt_when_started = false;
    Ok(true)
}

pub(super) fn write_codex_response(session: &Arc<Mutex<ChatSession>>, id: &Value, result: Value) {
    let Ok(mut guard) = session.lock() else {
        return;
    };
    let Some(stdin) = guard.stdin.as_mut() else {
        return;
    };
    let _ = write_json_line(stdin, &crate::codex_app_server::response(id, result));
}

pub(super) fn write_codex_error(session: &Arc<Mutex<ChatSession>>, id: &Value, message: &str) {
    let Ok(mut guard) = session.lock() else {
        return;
    };
    let Some(stdin) = guard.stdin.as_mut() else {
        return;
    };
    let _ = write_json_line(stdin, &crate::codex_app_server::error_response(id, message));
}

pub(super) fn answer_codex_server_request(
    manager: &Arc<ChatManager>,
    session: &Arc<Mutex<ChatSession>>,
    key: &str,
    rt: Option<&tokio::runtime::Handle>,
    request: Value,
) {
    let Some(id) = request.get("id").cloned() else {
        return;
    };
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            answer_codex_approval(session, key, rt, id, method, params)
        }
        "mcpServer/elicitation/request" => codex_elicitation::answer(session, key, rt, id, params),
        "item/tool/requestUserInput" => {
            answer_codex_user_input(manager, session, key, rt, id, params)
        }
        "currentTime/read" => {
            let seconds = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0);
            write_codex_response(session, &id, json!({ "currentTimeAt": seconds }));
        }
        _ => write_codex_error(
            session,
            &id,
            &format!("OctiqFlow does not implement the Codex request '{method}'"),
        ),
    }
}

// A late native answer belongs only to the turn that requested it. Keep
// this on the session, since successful Codex full stops carry no denials.
pub(super) fn latch_codex_refusal(
    session: &Arc<Mutex<ChatSession>>,
    target: Option<&CodexRefusalTarget>,
) {
    if let (Ok(mut guard), Some(target)) = (session.lock(), target) {
        guard.latch_codex_refusal(target);
    }
}

pub(super) fn answer_codex_approval(
    session: &Arc<Mutex<ChatSession>>,
    key: &str,
    rt: Option<&tokio::runtime::Handle>,
    request_id: Value,
    method: &str,
    params: Value,
) {
    let target = session.lock().ok().map(|s| s.codex_refusal_target(&params));
    let command = params.get("command").and_then(Value::as_str);
    let grant_root = params.get("grantRoot").and_then(Value::as_str);
    let reason = params.get("reason").and_then(Value::as_str);
    let tool_name = if method == "item/commandExecution/requestApproval" {
        "Bash"
    } else {
        "Edit"
    };
    let mut input = Map::new();
    if let Some(command) = command {
        input.insert("command".into(), json!(command));
    }
    if let Some(cwd) = params.get("cwd").and_then(Value::as_str) {
        input.insert("cwd".into(), json!(cwd));
    }
    if let Some(root) = grant_root {
        input.insert("file_path".into(), json!(root));
    }
    if let Some(reason) = reason {
        input.insert("reason".into(), json!(reason));
    }
    let ask = crate::permission::Request {
        chat_key: Some(key.to_string()),
        session_id: params
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_name: Some(tool_name.into()),
        tool_input: Some(Value::Object(input)),
        tool_use_id: params
            .get("itemId")
            .and_then(Value::as_str)
            .map(str::to_string),
        cwd: params
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        access: None,
        provider: Some(ChatAgent::Codex),
        ..Default::default()
    };
    let Some(rt) = rt else {
        latch_codex_refusal(session, target.as_ref());
        write_codex_response(session, &request_id, json!({ "decision": "decline" }));
        return;
    };
    let session = session.clone();
    let key = key.to_string();
    rt.spawn(async move {
        let call = ask.tool_use_id.clone();
        let answer = crate::permission::ask(ask).await;
        let decision = if answer.decision == "allow" {
            "accept"
        } else {
            "decline"
        };
        if decision == "decline" {
            latch_codex_refusal(&session, target.as_ref());
        }
        note_permission_outcome(&key, call.as_deref(), &answer);
        write_codex_response(&session, &request_id, json!({ "decision": decision }));
    });
}

pub(super) fn answer_codex_user_input(
    manager: &Arc<ChatManager>,
    session: &Arc<Mutex<ChatSession>>,
    key: &str,
    rt: Option<&tokio::runtime::Handle>,
    request_id: Value,
    params: Value,
) {
    let native = params
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if native.is_empty() {
        write_codex_response(session, &request_id, json!({ "answers": {} }));
        return;
    }
    let mut native_ids = Vec::with_capacity(native.len());
    let questions = native
        .iter()
        .map(|question| {
            native_ids.push(
                question
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|option| {
                    let label = option.get("label")?.as_str()?.to_string();
                    (!label.trim().is_empty()).then(|| crate::question::Choice {
                        label,
                        description: option
                            .get("description")
                            .and_then(Value::as_str)
                            .filter(|text| !text.trim().is_empty())
                            .map(str::to_string),
                        image: None,
                    })
                })
                .collect();
            crate::question::Question {
                chat_key: None,
                question: question
                    .get("question")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex needs your input")
                    .to_string(),
                options,
                recommended: None,
                multiple: false,
                media: Vec::new(),
            }
        })
        .collect::<Vec<_>>();
    let Some(rt) = rt else {
        write_codex_response(session, &request_id, json!({ "answers": {} }));
        return;
    };

    match route_worker_questions(manager, key, Some(key), None, &questions) {
        Ok(Some(message)) => {
            write_codex_error(session, &request_id, &message);
            return;
        }
        Err(why) => {
            write_codex_error(session, &request_id, &why);
            return;
        }
        Ok(None) => {}
    }

    let origin = {
        let _delivery = match manager.questions.delivery_lock.lock() {
            Ok(lock) => lock,
            Err(_) => {
                write_codex_response(session, &request_id, json!({ "answers": {} }));
                return;
            }
        };
        let origin = match manager.question_origin(key, Some(key), None) {
            Ok(origin) => origin,
            Err(why) => {
                write_codex_error(session, &request_id, &why);
                return;
            }
        };
        let inserted = manager.questions.insert(origin.clone(), questions);
        match inserted {
            Ok((id, rx)) => (origin, id, rx),
            Err(why) => {
                write_codex_error(session, &request_id, &why);
                return;
            }
        }
    };
    let (origin, card_id, answered) = origin;
    crate::push::notify_chat(
        Some(&origin.chat_key),
        "question",
        "Codex is waiting for your answer",
    );
    let manager = manager.clone();
    let session = session.clone();
    rt.spawn(async move {
        let _ = tokio::time::timeout(crate::question::ANSWER_TIMEOUT, answered).await;
        let answers = manager.questions.take_native(&card_id).ok().flatten();
        if answers.is_none() {
            manager.questions.detach(&card_id);
        }
        let claimed = answers.is_some();
        let mapped = native_ids
            .into_iter()
            .zip(answers.unwrap_or_default())
            .filter(|(id, _)| !id.is_empty())
            .map(|(id, answer)| (id, json!({ "answers": [answer] })))
            .collect::<Map<String, Value>>();
        let written = (|| {
            let mut guard = session.lock().map_err(|e| e.to_string())?;
            let stdin = guard
                .stdin
                .as_mut()
                .ok_or("The native response pipe is closed.")?;
            write_json_line(
                stdin,
                &crate::codex_app_server::response(&request_id, json!({ "answers": mapped })),
            )
            .map_err(|e| e.to_string())
        })();
        if claimed {
            let _ = manager.questions.native_written(&card_id, written);
        }
    });
}

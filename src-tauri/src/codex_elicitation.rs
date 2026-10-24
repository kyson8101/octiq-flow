//! Codex MCP tool confirmations use elicitation, not command approval.
//! Only empty forms (confirmation) are handled here. A form requiring data
//! must never be accepted with invented/default values or a missing answer.
use super::*;

#[derive(Debug)]
pub(super) struct Pending {
    _cancel: tokio::sync::oneshot::Sender<()>,
    item_id: Option<String>,
    started: Instant,
}

// A native cancel result has no reason field. Carry the host's actual reason
// to both the transcript and the active model turn, without approving the call.
fn unanswered(guard: &mut ChatSession, key: &str, item_id: Option<String>, reason: &str) {
    guard.auto_plan_refused = true;
    let text = format!("MCP confirmation was not answered: {reason}. No approval was given; this was not a user cancellation.");
    let Some(codex) = guard.codex.as_mut() else {
        return;
    };
    if let Some(id) = item_id {
        codex.mcp_refusals.insert(id, text.clone());
    }
    if let Some(turn_id) = codex.active_turn_id.clone() {
        let message = json!({"id":codex.request_id("confirmation-note"), "method":"turn/steer",
            "params":{"threadId":codex.thread_id,"expectedTurnId":turn_id,
                "input":[{"type":"text","text":format!("[OctiqFlow confirmation status] {text}"),"text_elements":[]}]}});
        if let Some(stdin) = guard.stdin.as_mut() {
            let _ = write_json_line(stdin, &message);
        }
    }
    crate::diagnostics::record(ChatAgent::Codex, key, "mcp-confirmation-unanswered", &text);
    emit_status(
        ChatAgent::Codex,
        ChatStatus {
            key: key.into(),
            kind: "error".into(),
            code: None,
            text,
        },
    );
}

fn confirmation(params: &Value) -> bool {
    params["mode"] == "form"
        && params["requestedSchema"]["type"] == "object"
        && params["requestedSchema"]["properties"]
            .as_object()
            .is_some_and(|properties| properties.is_empty())
        && params["requestedSchema"]
            .get("required")
            .is_none_or(|required| {
                required.is_null() || required.as_array().is_some_and(Vec::is_empty)
            })
        && params["message"].as_str().is_some()
}

fn response(action: &str) -> Value {
    json!({ "action": action, "content": if action == "accept" { json!({}) } else { Value::Null } })
}

// Correlate only for display and cancellation diagnostics. MCP servers can forge
// approval metadata, so this identity never grants permission.
fn native_call<'a>(codex: &'a CodexAppSession, params: &Value) -> Option<(&'a str, &'a Value)> {
    let mut matching = codex.mcp_calls.iter().filter(|(_, item)| {
        item["server"] == params["serverName"]
            && params["_meta"]
                .get("tool_params")
                .is_some_and(|args| item.get("arguments") == Some(args))
            && params["_meta"]
                .get("tool_name")
                .is_none_or(|tool| &item["tool"] == tool)
    });
    let (id, item) = matching.next()?;
    matching.next().is_none().then_some((id.as_str(), item))
}

/// Keep item identity until completion. A native generic cancel is replaced in
/// the host record by the actual host reason, never attributed to the person.
pub(super) fn observe(session: &Arc<Mutex<ChatSession>>, event: &mut Value) {
    let Ok(mut guard) = session.lock() else {
        return;
    };
    let Some(codex) = guard.codex.as_mut() else {
        return;
    };
    if event["params"]["threadId"].as_str() != Some(codex.thread_id.as_str())
        || event["params"]["turnId"].as_str() != codex.active_turn_id.as_deref()
    {
        return;
    }
    let method = event["method"].as_str().unwrap_or_default().to_owned();
    let item = &event["params"]["item"];
    if item["type"] != "mcpToolCall" {
        return;
    }
    let Some(id) = item["id"].as_str().map(str::to_owned) else {
        return;
    };
    if method == "item/started" {
        codex.mcp_calls.insert(id, item.clone());
    } else if method == "item/completed" {
        codex.mcp_calls.remove(&id);
        if let Some(reason) = codex.mcp_refusals.remove(&id) {
            if event["params"]["item"]["error"]["message"]
                .as_str()
                .is_some_and(|text| {
                    matches!(
                        text,
                        "user cancelled MCP tool call" | "user rejected MCP tool call"
                    )
                })
            {
                event["params"]["item"]["error"]["message"] = json!(reason);
            }
        }
    }
}

pub(super) fn resolved(session: &Arc<Mutex<ChatSession>>, key: &str, request_id: &Value) {
    if let Ok(mut guard) = session.lock() {
        if let Some(pending) = guard
            .codex
            .as_mut()
            .and_then(|codex| codex.elicitations.remove(&request_id.to_string()))
        {
            unanswered(
                &mut guard,
                key,
                pending.item_id,
                &format!(
                    "Codex closed the confirmation after {} ms before the host received an answer",
                    pending.started.elapsed().as_millis()
                ),
            );
        }
    }
}

pub(super) fn answer(
    session: &Arc<Mutex<ChatSession>>,
    key: &str,
    rt: Option<&tokio::runtime::Handle>,
    request_id: Value,
    params: Value,
) {
    let (tool, item_id) = session
        .lock()
        .ok()
        .and_then(|guard| {
            let codex = guard.codex.as_ref()?;
            let call = native_call(codex, &params);
            Some((
                params["_meta"]["tool_name"]
                    .as_str()
                    .or_else(|| call.and_then(|(_, item)| item["tool"].as_str()))
                    .map(str::to_owned),
                call.map(|(id, _)| id.to_owned()),
            ))
        })
        .unwrap_or_default();
    if !confirmation(&params) {
        let started = session.lock().ok().map(|s| s.last_active);
        latch_codex_refusal(session, started);
        // Explicitly report the supported boundary instead of a misleading
        // generic "user rejected" resulting from an unknown-method error.
        emit_status(ChatAgent::Codex, ChatStatus {
            key: key.into(), kind: "error".into(), code: None,
            text: "This MCP request needs a form or URL flow that OctiqFlow cannot display yet. It was cancelled; no approval was given.".into(),
        });
        write_codex_response(session, &request_id, response("cancel"));
        return;
    }
    let Some(rt) = rt else {
        let started = session.lock().ok().map(|s| s.last_active);
        latch_codex_refusal(session, started);
        write_codex_response(session, &request_id, response("cancel"));
        return;
    };
    let (tx, mut cancelled) = tokio::sync::oneshot::channel();
    let mut guard = match session.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if guard.cut_off != CutOff::No || guard.stdin.is_none() {
        drop(guard);
        write_codex_response(session, &request_id, response("cancel"));
        return;
    }
    let Some(codex) = guard.codex.as_mut() else {
        return;
    };
    codex.elicitations.insert(
        request_id.to_string(),
        Pending {
            _cancel: tx,
            item_id: item_id.clone(),
            started: Instant::now(),
        },
    );
    drop(guard);

    let server = params["serverName"].as_str().unwrap_or("MCP server");
    let meta = &params["_meta"];
    let name = tool.as_deref().map_or_else(
        || format!("{server} confirmation"),
        |tool| format!("mcp__{server}__{tool}"),
    );
    let mut content = params["message"].as_str().unwrap_or_default().to_string();
    if let Some(args) = meta.get("tool_params") {
        content.push_str("\n\nTool arguments:\n");
        content.push_str(&serde_json::to_string_pretty(args).unwrap_or_else(|_| args.to_string()));
    }
    let ask = crate::permission::Request {
        chat_key: Some(key.into()),
        session_id: params["threadId"].as_str().map(str::to_string),
        provider: Some(ChatAgent::Codex),
        tool_use_id: item_id.clone(),
        tool_name: Some(name),
        tool_input: Some(json!({ "content": content })),
        // Use a proven native item identity when available; otherwise the
        // page draws a standalone card instead of attaching it to another call.
        once: true,
        ..Default::default()
    };
    let session = session.clone();
    let key = key.to_owned();
    rt.spawn(async move {
        let answer = tokio::select! {
            biased;
            _ = &mut cancelled => return,
            answer = crate::permission::ask(ask) => answer,
        };
        // Resolution, Stop and the response all claim the same entry under
        // the session lock. A late click can never write into a later turn.
        let Ok(mut guard) = session.lock() else {
            return;
        };
        let Some(codex) = guard.codex.as_mut() else {
            return;
        };
        if codex.elicitations.remove(&request_id.to_string()).is_none() {
            return;
        }
        if answer.decision != "allow" && answer.reason != crate::permission::DENIED {
            unanswered(&mut guard, &key, item_id, &answer.reason);
        }
        let action = match answer.decision {
            "allow" => "accept",
            "deny" if answer.reason == crate::permission::DENIED => "decline",
            _ => "cancel",
        };
        if action != "accept" {
            guard.auto_plan_refused = true;
        }
        if let Some(stdin) = guard.stdin.as_mut() {
            let _ = write_json_line(
                stdin,
                &crate::codex_app_server::response(&request_id, response(action)),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::Services;

    struct Chat {
        svc: Services,
        key: String,
        session: Arc<Mutex<ChatSession>>,
        heard: Option<BufReader<ChildStdout>>,
        _child: TestChild,
    }

    impl Chat {
        fn new() -> Self {
            crate::bus::client_joined();
            let svc = Services::load();
            let key = format!("chat:codex-elicitation-{}", uuid::Uuid::new_v4());
            let (child, heard) = svc.chats.test_hold_heard(&key, ChatAgent::Codex, true);
            svc.chats.test_as_codex_thread(&key, Access::Auto);
            let session = svc.chats.sessions.lock().unwrap()[&key].clone();
            session
                .lock()
                .unwrap()
                .codex
                .as_mut()
                .unwrap()
                .active_turn_id = Some("turn-1".into());
            Self {
                svc,
                key,
                session,
                heard: Some(heard),
                _child: child,
            }
        }

        fn ask(&self, id: Value, params: Value, runtime: bool) {
            answer_codex_server_request(
                &self.svc.chats,
                &self.session,
                &self.key,
                runtime.then(tokio::runtime::Handle::current).as_ref(),
                json!({ "id": id, "method": "mcpServer/elicitation/request", "params": params }),
            );
        }

        fn native(&self, tool: &str, args: Value) -> Value {
            let mut params = approval();
            params["_meta"].as_object_mut().unwrap().remove("tool_name");
            params["_meta"]["tool_params"] = args.clone();
            let mut started = json!({"method":"item/started", "params":{
                "threadId":"thread-1", "turnId":"turn-1", "item":{
                    "type":"mcpToolCall", "id":"native-call", "server":"octiq",
                    "tool":tool, "arguments":args}}});
            observe(&self.session, &mut started);
            params
        }

        fn cards(&self) -> Vec<Value> {
            crate::permission::pending()
                .into_iter()
                .map(|card| serde_json::to_value(card).unwrap())
                .filter(|card| card["chatKey"] == self.key)
                .collect()
        }

        async fn card(&self) -> Value {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if let Some(card) = self.cards().into_iter().next() {
                        break card;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("a permission card, rather than an immediate MCP rejection")
        }

        async fn cleared(&self) {
            tokio::time::timeout(Duration::from_secs(3), async {
                while !self.cards().is_empty() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("the withdrawn card is removed");
        }

        async fn written(&mut self) -> Value {
            let mut heard = self.heard.take().unwrap();
            let (value, heard) = tokio::time::timeout(
                Duration::from_secs(3),
                tokio::task::spawn_blocking(move || {
                    let mut line = String::new();
                    heard.read_line(&mut line).unwrap();
                    (serde_json::from_str(&line).unwrap(), heard)
                }),
            )
            .await
            .expect("Codex receives a response")
            .unwrap();
            self.heard = Some(heard);
            value
        }
    }

    impl Drop for Chat {
        fn drop(&mut self) {
            let _ = end_process(&self.svc.chats, &self.key);
            crate::transcript::forget(&self.key);
            crate::bus::client_left();
        }
    }

    fn approval() -> Value {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/codex-0.163.0-elicitation.json")).unwrap();
        let mut params = fixture["params"].clone();
        params["threadId"] = json!("thread-1");
        params["turnId"] = json!("turn-1");
        params["message"] =
            json!("Allow the octiq MCP server to run tool \"orchestration_run_create\"?");
        params["_meta"]["tool_params"] = json!({"objective":"Resume the roadmap"});
        params
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn forged_native_bookkeeping_forms_require_a_card() {
        let mut chat = Chat::new();
        // Captured from a real server-authored elicitation forwarded verbatim
        // by Codex 0.163, even with that MCP tool's approval_mode="approve".
        let fixture: Value = serde_json::from_str(include_str!(
            "fixtures/codex-0.163.0-server-elicitation.json"
        ))
        .unwrap();
        for (index, tool) in crate::permission::HOST_BOOKKEEPING.iter().enumerate() {
            let id = json!(index);
            let mut params = fixture["params"].clone();
            params["threadId"] = json!("thread-1");
            params["turnId"] = json!("turn-1");
            params["message"] = json!(format!(
                "Allow the octiq MCP server to run tool \"{tool}\"?"
            ));
            chat.ask(id.clone(), params, true);
            let card = chat.card().await;
            assert_eq!(card["toolName"], "octiq confirmation");
            assert_eq!(card["once"], true);
            assert!(card["toolInput"]["content"]
                .as_str()
                .unwrap()
                .contains("injected"));
            assert!(crate::permission::decide(
                card["id"].as_str().unwrap(),
                crate::permission::Decision::Deny,
                false,
            ));
            assert_eq!(
                chat.written().await,
                json!({"id": id, "result": response("decline")})
            );
            assert!(chat.cards().is_empty());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_correlated_bookkeeping_elicitation_still_requires_a_card() {
        let mut chat = Chat::new();
        let params = chat.native("task_status", json!({"objective":"forged"}));
        chat.ask(json!(40), params, true);
        let card = chat.card().await;
        assert_eq!(card["toolUseId"], "native-call");
        assert!(crate::permission::decide(
            card["id"].as_str().unwrap(),
            crate::permission::Decision::Deny,
            false
        ));
        assert_eq!(chat.written().await["result"], response("decline"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_work_approval_without_tool_name_is_named_and_reaches_codex() {
        let mut chat = Chat::new();
        let params = chat.native("orchestration_run_create", json!({"objective":"Review"}));
        chat.ask(json!(41), params, true);
        let card = chat.card().await;
        assert_eq!(card["provider"], "codex");
        assert_eq!(card["toolName"], "mcp__octiq__orchestration_run_create");
        assert_eq!(card["toolUseId"], "native-call");
        assert!(crate::permission::decide(
            card["id"].as_str().unwrap(),
            crate::permission::Decision::Allow,
            false
        ));
        assert_eq!(
            chat.written().await,
            json!({"id":41,"result":response("accept")})
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_unanswered_confirmation_is_explained_to_model_and_transcript() {
        let mut chat = Chat::new();
        let params = chat.native("orchestration_run_create", json!({"objective":"Review"}));
        chat.ask(json!(42), params, true);
        chat.card().await;
        resolved(&chat.session, &chat.key, &json!(42));
        let note = chat.written().await;
        assert_eq!(note["method"], "turn/steer");
        assert!(note["params"]["input"][0]["text"]
            .as_str()
            .unwrap()
            .contains("not a user cancellation"));
        chat.cleared().await;
        let mut completed = json!({"method":"item/completed", "params":{
            "threadId":"thread-1", "turnId":"turn-1", "item":{
                "type":"mcpToolCall", "id":"native-call", "error":{"message":"user cancelled MCP tool call"}}}});
        observe(&chat.session, &mut completed);
        assert!(completed["params"]["item"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Codex closed the confirmation"));
    }

    #[tokio::test]
    async fn native_identity_does_not_guess_from_message_or_ambiguous_arguments() {
        let chat = Chat::new();
        let params = chat.native("task_status", json!({}));
        let mut guard = chat.session.lock().unwrap();
        let codex = guard.codex.as_mut().unwrap();
        assert!(native_call(codex, &params).is_some());
        let other = codex.mcp_calls["native-call"].clone();
        codex.mcp_calls.insert("other".into(), other);
        assert!(native_call(codex, &params).is_none());
        codex.mcp_calls.clear();
        assert!(native_call(codex, &params).is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn codex_mcp_elicitation_allow_and_deny_round_trip() {
        let mut chat = Chat::new();
        for (id, decision, expected) in [
            (
                json!(17),
                crate::permission::Decision::Allow,
                response("accept"),
            ),
            (
                json!("mcp-18"),
                crate::permission::Decision::Deny,
                response("decline"),
            ),
        ] {
            chat.ask(id.clone(), approval(), true);
            let card = chat.card().await;
            assert_eq!(card["toolName"], "octiq confirmation");
            assert_eq!(card["once"], true);
            assert_eq!(card["provider"], "codex");
            assert!(card["toolInput"]["content"]
                .as_str()
                .unwrap()
                .contains("Resume the roadmap"));
            // This is also what a browser rereads after reloading the page.
            assert_eq!(chat.cards().len(), 1);
            assert!(crate::permission::decide(
                card["id"].as_str().unwrap(),
                decision,
                true
            ));
            assert_eq!(
                chat.written().await,
                json!({ "id": id, "result": expected })
            );
            assert!(chat.cards().is_empty());
            assert_eq!(
                chat.session.lock().unwrap().auto_plan_refused,
                expected == response("decline")
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn codex_mcp_elicitation_cancellation_and_late_answers() {
        let mut chat = Chat::new();
        chat.ask(json!(1), approval(), true);
        let card = chat.card().await;
        resolved(&chat.session, &chat.key, &json!(1));
        assert_eq!(chat.written().await["method"], "turn/steer");
        chat.cleared().await;
        assert!(!crate::permission::decide(
            card["id"].as_str().unwrap(),
            crate::permission::Decision::Allow,
            false
        ));

        chat.ask(json!(2), approval(), true);
        let card = chat.card().await;
        chat_interrupt_impl(&chat.svc.chats, chat.key.clone()).unwrap();
        chat.cleared().await;
        assert!(!crate::permission::decide(
            card["id"].as_str().unwrap(),
            crate::permission::Decision::Allow,
            false
        ));
        // The only outgoing line is Stop, never a late MCP acceptance.
        assert_eq!(chat.written().await["method"], "turn/interrupt");
        // A barrier after the cancelled requests proves neither wrote a reply.
        write_codex_response(&chat.session, &json!(99), json!({ "barrier": true }));
        assert_eq!(chat.written().await["id"], 99);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn codex_mcp_elicitation_abstention_and_unavailable_forms_cancel() {
        let mut chat = Chat::new();
        chat.ask(json!(1), approval(), true);
        let card = chat.card().await;
        crate::permission::decide(
            card["id"].as_str().unwrap(),
            crate::permission::Decision::Abstain,
            false,
        );
        assert_eq!(chat.written().await["method"], "turn/steer");
        assert_eq!(chat.written().await["result"], response("cancel"));
        chat.ask(json!(2), approval(), false);
        assert_eq!(chat.written().await["result"], response("cancel"));
        for params in [
            json!({ "mode": "url", "message": "Sign in", "url": "https://example.com", "elicitationId": "auth" }),
            json!({ "mode": "form", "message": "Name?", "requestedSchema": { "type": "object", "properties": { "name": { "type": "string" } } } }),
        ] {
            chat.ask(json!(3), params, true);
            assert_eq!(chat.written().await["result"], response("cancel"));
            assert!(chat.cards().is_empty());
        }
    }
}

//! Codex MCP tool confirmations use elicitation, not command approval.
//! Only empty forms (confirmation) are handled here. A form requiring data
//! must never be accepted with invented/default values or a missing answer.
use super::*;

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

// Only Codex's native approval for our settlement tool is bookkeeping.
// A server-authored form, another server, or a message mentioning the tool
// must still go through the ordinary confirmation/data-form path.
fn worker_report_confirmation(params: &Value) -> bool {
    confirmation(params)
        && params["serverName"] == "octiq"
        && params["_meta"]["codex_approval_kind"] == "mcp_tool_call"
        && params["_meta"]["tool_name"] == "orchestration_worker_report"
}

pub(super) fn resolved(session: &Arc<Mutex<ChatSession>>, request_id: &Value) {
    if let Ok(mut session) = session.lock() {
        if let Some(codex) = session.codex.as_mut() {
            codex.elicitations.remove(&request_id.to_string());
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
    if !confirmation(&params) {
        // Explicitly report the supported boundary instead of a misleading
        // generic "user rejected" resulting from an unknown-method error.
        emit_status(ChatAgent::Codex, ChatStatus {
            key: key.into(), kind: "error".into(), code: None,
            text: "This MCP request needs a form or URL flow that OctiqFlow cannot display yet. It was cancelled; no approval was given.".into(),
        });
        write_codex_response(session, &request_id, response("cancel"));
        return;
    }
    if worker_report_confirmation(&params) {
        // This permits the MCP call, not its contents. The hook still proves
        // the caller and the ledger validates the exact current attempt,
        // unread instructions, open gates and settlement state.
        let Ok(mut guard) = session.lock() else {
            return;
        };
        let current = guard.codex.as_ref().is_some_and(|codex| {
            params["threadId"].as_str() == Some(codex.thread_id.as_str())
                && params["turnId"]
                    .as_str()
                    .is_none_or(|id| Some(id) == codex.active_turn_id.as_deref())
                && codex.active_turn_id.is_some()
        });
        let allowed = current && guard.cut_off == CutOff::No;
        if let Some(stdin) = guard.stdin.as_mut() {
            let _ = write_json_line(
                stdin,
                &crate::codex_app_server::response(
                    &request_id,
                    response(if allowed { "accept" } else { "cancel" }),
                ),
            );
        }
        return;
    }
    let Some(rt) = rt else {
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
    codex.elicitations.insert(request_id.to_string(), tx);
    drop(guard);

    let server = params["serverName"].as_str().unwrap_or("MCP server");
    let meta = &params["_meta"];
    let tool = meta["tool_name"].as_str();
    let name = tool.map_or_else(
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
        tool_name: Some(name),
        tool_input: Some(json!({ "content": content })),
        // Elicitation identifies a server request, not an item. Do not
        // invent an item id: standalone cards are supported by the page.
        once: true,
        ..Default::default()
    };
    let session = session.clone();
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
        let action = match answer.decision {
            "allow" => "accept",
            "deny" if answer.reason == crate::permission::DENIED => "decline",
            _ => "cancel",
        };
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
        // The native tool-approval form in Codex 0.163.0: no user data
        // fields; the action itself is the answer. Do not return decision.
        json!({
            "threadId": "thread-1", "turnId": "turn-1", "serverName": "octiq",
            "mode": "form", "message": "Allow orchestration_run_create?",
            "requestedSchema": { "type": "object", "properties": {} },
            "_meta": { "codex_approval_kind": "mcp_tool_call", "tool_name": "orchestration_run_create",
                "tool_params": { "objective": "Resume the roadmap", "worker_defaults": { "access": "auto" } } },
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn worker_settlement_confirmation_returns_accept_without_a_card() {
        let mut chat = Chat::new();
        let mut params = approval();
        params["_meta"]["tool_name"] = json!("orchestration_worker_report");
        params["_meta"]["tool_params"] =
            json!({"attempt_id": "attempt-current", "outcome": "completed"});
        params["message"] =
            json!("Allow the octiq MCP server to run tool orchestration_worker_report?");
        chat.ask(json!(30), params.clone(), false);
        assert_eq!(
            chat.written().await,
            json!({"id":30,"result":response("accept")})
        );
        assert!(chat.cards().is_empty());
        // The app-server schema permits an uncorrelated (null) turn id.
        params["turnId"] = Value::Null;
        chat.ask(json!(32), params.clone(), true);
        assert_eq!(
            chat.written().await,
            json!({"id":32,"result":response("accept")})
        );
        // An old turn cannot receive a late approval.
        params["turnId"] = json!("old-turn");
        chat.ask(json!(31), params, true);
        assert_eq!(
            chat.written().await,
            json!({"id":31,"result":response("cancel")})
        );
        assert!(chat.cards().is_empty());
    }

    #[test]
    fn settlement_exception_does_not_match_unrelated_or_data_requests() {
        let mut params = approval();
        assert!(!worker_report_confirmation(&params));
        params["_meta"]["tool_name"] = json!("orchestration_worker_report");
        assert!(worker_report_confirmation(&params));
        for (field, value) in [
            ("serverName", json!("other")),
            ("_meta", json!({})),
            (
                "requestedSchema",
                json!({"type":"object","properties":{"answer":{"type":"string"}}}),
            ),
        ] {
            let mut different = params.clone();
            different[field] = value;
            assert!(!worker_report_confirmation(&different));
        }
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
            assert_eq!(card["toolName"], "mcp__octiq__orchestration_run_create");
            assert_eq!(card["once"], true);
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
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn codex_mcp_elicitation_cancellation_and_late_answers() {
        let mut chat = Chat::new();
        chat.ask(json!(1), approval(), true);
        let card = chat.card().await;
        resolved(&chat.session, &json!(1));
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

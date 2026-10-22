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
    // A server can forge the native approval message and _meta fields. Only
    // Codex's configured approval_mode skips tool confirmations; an actual
    // elicitation always needs the normal card, regardless of its wording.
    let name = format!("{server} confirmation");
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
        provider: Some(ChatAgent::Codex),
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

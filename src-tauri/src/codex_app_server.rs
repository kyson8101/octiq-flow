//! Codex app-server's newline-delimited JSON-RPC protocol.
//!
//! The rest of OctiqFlow deliberately keeps consuming the stable event shape
//! emitted by `codex exec --json`. This adapter owns the app-server handshake,
//! request builders, and the small camelCase -> snake_case translation needed
//! to preserve that transcript contract while a Codex process stays alive for
//! the whole chat.

use serde_json::{json, Map, Value};

use crate::agent_provider::{codex_approval, codex_sandbox, Access};

pub(crate) const INITIALIZE_ID: &str = "octiq-initialize";
pub(crate) const THREAD_ID: &str = "octiq-thread";

pub(crate) fn initialize_request() -> Value {
    json!({
        "id": INITIALIZE_ID,
        "method": "initialize",
        "params": {
            "clientInfo": {
                "name": "octiqflow",
                "title": "OctiqFlow",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": { "experimentalApi": true },
        },
    })
}

pub(crate) fn initialized_notification() -> Value {
    json!({ "method": "initialized" })
}

#[derive(Clone, Copy)]
pub(crate) struct ThreadRequest<'a> {
    pub cwd: &'a str,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub access: Option<Access>,
    pub resume: Option<&'a str>,
    pub workspace_roots: &'a [String],
    pub developer_instructions: &'a str,
}

pub(crate) fn thread_request(request: ThreadRequest<'_>) -> Value {
    let mut params = Map::new();
    params.insert("cwd".into(), json!(request.cwd));
    params.insert(
        "runtimeWorkspaceRoots".into(),
        json!(request.workspace_roots),
    );
    params.insert(
        "developerInstructions".into(),
        json!(request.developer_instructions),
    );
    if let Some(model) = request.model {
        params.insert("model".into(), json!(model));
    }
    if let Some(access) = request.access {
        params.insert("sandbox".into(), json!(codex_sandbox(access)));
        params.insert("approvalPolicy".into(), json!(codex_approval(access)));
    }
    if let Some(effort) = request.effort {
        params.insert("config".into(), json!({ "model_reasoning_effort": effort }));
    }

    let method = if let Some(thread_id) = request.resume {
        params.insert("threadId".into(), json!(thread_id));
        params.insert("excludeTurns".into(), json!(true));
        "thread/resume"
    } else {
        // Durable app-server threads are the native conversation memory that
        // OctiqFlow records and resumes after an idle reap or server restart.
        params.insert("ephemeral".into(), json!(false));
        "thread/start"
    };
    json!({ "id": THREAD_ID, "method": method, "params": params })
}

pub(crate) struct TurnRequest<'a> {
    pub id: &'a str,
    pub thread_id: &'a str,
    pub text: &'a str,
    pub images: &'a [String],
    pub client_user_message_id: Option<&'a str>,
    pub cwd: &'a str,
    pub workspace_roots: &'a [String],
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub access: Option<Access>,
    pub runtime_context: &'a str,
}

pub(crate) fn turn_request(request: TurnRequest<'_>) -> Value {
    let text = if request.text.trim().is_empty() && !request.images.is_empty() {
        "Please inspect the attached image."
    } else {
        request.text
    };
    let mut input = vec![json!({
        "type": "text",
        "text": text,
        "text_elements": [],
    })];
    input.extend(
        request
            .images
            .iter()
            .map(|path| json!({ "type": "localImage", "path": path })),
    );

    let mut params = Map::new();
    params.insert("threadId".into(), json!(request.thread_id));
    params.insert("input".into(), Value::Array(input));
    params.insert("cwd".into(), json!(request.cwd));
    params.insert(
        "runtimeWorkspaceRoots".into(),
        json!(request.workspace_roots),
    );
    params.insert(
        "additionalContext".into(),
        json!({
            "octiqflow.runtime": {
                "kind": "application",
                "value": request.runtime_context,
            }
        }),
    );
    if let Some(id) = request.client_user_message_id {
        params.insert("clientUserMessageId".into(), json!(id));
    }
    if let Some(model) = request.model {
        params.insert("model".into(), json!(model));
    }
    if let Some(effort) = request.effort {
        params.insert("effort".into(), json!(effort));
    }
    if let Some(access) = request.access {
        params.insert("approvalPolicy".into(), json!(codex_approval(access)));
        params.insert(
            "sandboxPolicy".into(),
            sandbox_policy(access, request.workspace_roots),
        );
    }
    json!({ "id": request.id, "method": "turn/start", "params": params })
}

fn sandbox_policy(access: Access, roots: &[String]) -> Value {
    match access {
        Access::Read => json!({ "type": "readOnly", "networkAccess": false }),
        Access::Manual | Access::Edits | Access::Auto => json!({
            "type": "workspaceWrite",
            "writableRoots": roots,
            "networkAccess": false,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false,
        }),
        Access::Full => json!({ "type": "dangerFullAccess" }),
    }
}

pub(crate) fn interrupt_request(id: &str, thread_id: &str, turn_id: &str) -> Value {
    json!({
        "id": id,
        "method": "turn/interrupt",
        "params": { "threadId": thread_id, "turnId": turn_id },
    })
}

pub(crate) fn response(id: &Value, result: Value) -> Value {
    json!({ "id": id, "result": result })
}

pub(crate) fn error_response(id: &Value, message: &str) -> Value {
    json!({
        "id": id,
        "error": { "code": -32601, "message": message },
    })
}

pub(crate) fn response_result<'a>(
    message: &'a Value,
    id: &str,
) -> Option<Result<&'a Value, String>> {
    if message.get("id").and_then(Value::as_str) != Some(id) {
        return None;
    }
    if let Some(error) = message.get("error") {
        let why = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Codex app-server rejected the request");
        return Some(Err(why.to_string()));
    }
    Some(
        message
            .get("result")
            .ok_or_else(|| "Codex app-server returned no result".to_string()),
    )
}

pub(crate) fn thread_id_from_result(result: &Value) -> Option<&str> {
    result.pointer("/thread/id").and_then(Value::as_str)
}

pub(crate) fn turn_id_from_response(message: &Value) -> Option<&str> {
    message.pointer("/result/turn/id").and_then(Value::as_str)
}

pub(crate) fn is_server_request(message: &Value) -> bool {
    message.get("id").is_some() && message.get("method").is_some()
}

/// The native thread a notification belongs to. app-server multiplexes child
/// agent threads over the same process, so the host must not mistake a child
/// turn's completion for the parent chat's completion.
pub(crate) fn notification_thread_id(message: &Value) -> Option<&str> {
    if message.get("method").and_then(Value::as_str) == Some("thread/started") {
        message.pointer("/params/thread/id").and_then(Value::as_str)
    } else {
        message.pointer("/params/threadId").and_then(Value::as_str)
    }
}

/// Translate app-server notifications into `codex exec --json` events.
///
/// Keeping one browser/transcript vocabulary avoids a flag-day migration for
/// old records and lets a chat switch transports without changing its reducer.
pub(crate) fn normalize_notification(message: &Value) -> Option<Value> {
    let method = message.get("method")?.as_str()?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "thread/started" => Some(json!({
            "type": "thread.started",
            "thread_id": params.pointer("/thread/id")?.as_str()?,
        })),
        "turn/started" => Some(json!({
            "type": "turn.started",
            "turn_id": params.pointer("/turn/id")?.as_str()?,
        })),
        "turn/completed" => {
            let turn = params.get("turn").cloned().unwrap_or(Value::Null);
            let status = turn
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            if status == "failed" {
                Some(json!({
                    "type": "turn.failed",
                    "error": snake_value(turn.get("error").cloned().unwrap_or(Value::Null)),
                }))
            } else {
                Some(json!({ "type": "turn.completed", "status": status }))
            }
        }
        "item/started" | "item/completed" => Some(json!({
            "type": if method == "item/started" { "item.started" } else { "item.completed" },
            "item": normalize_item(params.get("item")?.clone()),
        })),
        "thread/tokenUsage/updated" => {
            let usage = params.get("tokenUsage")?;
            // `total` is cumulative across the native thread. The meter wants
            // the newest model response, which app-server exposes as `last`.
            // Using the cumulative value would eventually exceed the context
            // window even after compaction.
            let last = usage.get("last")?;
            Some(json!({
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": last.get("totalTokens").and_then(Value::as_u64).unwrap_or(0),
                        "output_tokens": last.get("outputTokens").and_then(Value::as_u64).unwrap_or(0),
                    },
                    "context_window": usage.get("modelContextWindow").cloned().unwrap_or(Value::Null),
                },
            }))
        }
        "error" => {
            let error = params.get("error").cloned().unwrap_or(Value::Null);
            if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
                Some(json!({
                    "type": "warning",
                    "will_retry": true,
                    "error": snake_value(error.clone()),
                    "message": error.get("message").and_then(Value::as_str).unwrap_or("Codex is retrying"),
                }))
            } else {
                Some(json!({
                    "type": "error",
                    "message": error.get("message").and_then(Value::as_str).unwrap_or("Codex stopped with an error"),
                    "error": snake_value(error),
                }))
            }
        }
        "warning" | "guardianWarning" | "deprecationNotice" | "configWarning" => Some(json!({
            "type": "warning",
            "message": params.get("message").and_then(Value::as_str).unwrap_or("Codex warning"),
        })),
        // Deltas are deliberately omitted. The existing Codex contract emits
        // whole items; `item/completed` carries the authoritative final text.
        _ => None,
    }
}

fn normalize_item(mut item: Value) -> Value {
    item = snake_value(item);
    let Some(object) = item.as_object_mut() else {
        return item;
    };
    if let Some(kind) = object.get_mut("type") {
        if let Some(mapped) = kind.as_str().and_then(item_type) {
            *kind = Value::String(mapped.into());
        }
    }
    if object.get("status").and_then(Value::as_str) == Some("inProgress") {
        object.insert("status".into(), Value::String("in_progress".into()));
    }
    item
}

fn item_type(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "userMessage" => "user_message",
        "agentMessage" => "agent_message",
        "functionCallOutput" => "function_call_output",
        "commandExecution" => "command_execution",
        "fileChange" => "file_change",
        "mcpToolCall" => "mcp_tool_call",
        "dynamicToolCall" => "dynamic_tool_call",
        "collabAgentToolCall" => "collab_agent_tool_call",
        "subAgentActivity" => "sub_agent_activity",
        "webSearch" => "web_search",
        "imageView" => "image_view",
        "imageGeneration" => "image_generation",
        "enteredReviewMode" => "entered_review_mode",
        "exitedReviewMode" => "exited_review_mode",
        "contextCompaction" => "context_compaction",
        _ => return None,
    })
}

fn snake_value(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (snake_key(&key), snake_value(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(snake_value).collect()),
        other => other,
    }
}

fn snake_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for ch in key.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_or_resumes_a_native_thread_with_exact_runtime_settings() {
        let roots = vec!["/work".into(), "/extra".into()];
        let fresh = thread_request(ThreadRequest {
            cwd: "/work",
            model: Some("gpt-test"),
            effort: Some("xhigh"),
            access: Some(Access::Auto),
            resume: None,
            workspace_roots: &roots,
            developer_instructions: "host",
        });
        assert_eq!(fresh["method"], "thread/start");
        assert_eq!(fresh["params"]["ephemeral"], false);
        assert_eq!(fresh["params"]["sandbox"], "workspace-write");
        assert_eq!(fresh["params"]["approvalPolicy"], "on-request");
        assert_eq!(fresh["params"]["config"]["model_reasoning_effort"], "xhigh");

        let resumed = thread_request(ThreadRequest {
            resume: Some("thread-1"),
            ..ThreadRequest {
                cwd: "/work",
                model: None,
                effort: None,
                access: None,
                resume: None,
                workspace_roots: &roots,
                developer_instructions: "host",
            }
        });
        assert_eq!(resumed["method"], "thread/resume");
        assert_eq!(resumed["params"]["threadId"], "thread-1");
    }

    #[test]
    fn turns_carry_text_images_and_live_policy() {
        let roots = vec!["/work".into()];
        let images = vec!["/work/a.png".into()];
        let turn = turn_request(TurnRequest {
            id: "turn-request-1",
            thread_id: "thread-1",
            text: "inspect",
            images: &images,
            client_user_message_id: Some("user-1"),
            cwd: "/work",
            workspace_roots: &roots,
            model: Some("gpt-test"),
            effort: Some("high"),
            access: Some(Access::Full),
            runtime_context: "runtime",
        });
        assert_eq!(turn["method"], "turn/start");
        assert_eq!(turn["params"]["input"][0]["type"], "text");
        assert_eq!(turn["params"]["input"][1]["type"], "localImage");
        assert_eq!(turn["params"]["sandboxPolicy"]["type"], "dangerFullAccess");
        assert_eq!(turn["params"]["clientUserMessageId"], "user-1");
    }

    #[test]
    fn workspace_write_does_not_enable_network_access() {
        let roots = vec!["/work".into()];
        let turn = turn_request(TurnRequest {
            id: "turn-request-1",
            thread_id: "thread-1",
            text: "work",
            images: &[],
            client_user_message_id: None,
            cwd: "/work",
            workspace_roots: &roots,
            model: None,
            effort: None,
            access: Some(Access::Auto),
            runtime_context: "runtime",
        });
        assert_eq!(turn["params"]["sandboxPolicy"]["networkAccess"], false);
    }

    #[test]
    fn identifies_parent_and_child_notification_threads() {
        assert_eq!(
            notification_thread_id(&json!({
                "method": "thread/started",
                "params": { "thread": { "id": "thread-1" } }
            })),
            Some("thread-1")
        );
        assert_eq!(
            notification_thread_id(&json!({
                "method": "turn/completed",
                "params": { "threadId": "child-1", "turn": { "id": "turn-1" } }
            })),
            Some("child-1")
        );
    }

    #[test]
    fn app_server_items_keep_the_existing_codex_transcript_shape() {
        let event = normalize_notification(&json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "commandExecution",
                    "id": "cmd-1",
                    "status": "inProgress",
                    "aggregatedOutput": "ok",
                    "exitCode": 0,
                }
            }
        }))
        .unwrap();
        assert_eq!(event["type"], "item.completed");
        assert_eq!(event["item"]["type"], "command_execution");
        assert_eq!(event["item"]["status"], "in_progress");
        assert_eq!(event["item"]["aggregated_output"], "ok");
        assert_eq!(event["item"]["exit_code"], 0);
    }

    #[test]
    fn failed_turns_and_usage_are_normalized() {
        let failed = normalize_notification(&json!({
            "method": "turn/completed",
            "params": { "turn": { "status": "failed", "error": { "message": "boom" } } }
        }))
        .unwrap();
        assert_eq!(failed["type"], "turn.failed");
        assert_eq!(failed["error"]["message"], "boom");

        let usage = normalize_notification(&json!({
            "method": "thread/tokenUsage/updated",
            "params": { "tokenUsage": {
                "total": { "totalTokens": 42, "outputTokens": 7 },
                "last": { "totalTokens": 12, "outputTokens": 3 },
                "modelContextWindow": 1000
            }}
        }))
        .unwrap();
        assert_eq!(usage["info"]["total_token_usage"]["input_tokens"], 12);
        assert_eq!(usage["info"]["context_window"], 1000);
    }
}

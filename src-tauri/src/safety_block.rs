//! Recoverable safety-policy blocks raised by Codex's tool router.
//!
//! Codex receives these failures as structured tool output and can carry on,
//! while its tracing layer writes a duplicate diagnostic to stderr. Most router
//! diagnostics belong only in the journal. Safety-policy rejections need the
//! person, though: they explain why an action did not happen and, in some
//! cases, offer one narrowly scoped approval.
//!
//! This module turns that diagnostic into a small, post-hoc choice in the UI.
//! It does not pretend the original tool call is paused — it has already
//! failed. The UI's choices send a fresh user turn telling Codex either to stay
//! local or authorising one retry.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

use crate::agent_provider::AgentKind;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedAction {
    id: String,
    chat_key: String,
    kind: &'static str,
    title: &'static str,
    summary: String,
    detail: String,
}

static PENDING: Mutex<Option<HashMap<String, BlockedAction>>> = Mutex::new(None);
static DRAFTS: Mutex<Option<HashMap<String, SafetyDraft>>> = Mutex::new(None);

#[derive(Debug, Clone)]
struct SafetyDraft {
    lines: Vec<String>,
    summary: Option<String>,
}

fn with_pending<T>(f: impl FnOnce(&mut HashMap<String, BlockedAction>) -> T) -> T {
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn with_drafts<T>(f: impl FnOnce(&mut HashMap<String, SafetyDraft>) -> T) -> T {
    let mut guard = DRAFTS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Every safety block that still needs a person to choose the next turn.
pub fn pending() -> Vec<BlockedAction> {
    with_pending(|pending| pending.values().cloned().collect())
}

/// Remove one card after the person chooses a path or dismisses it.
pub fn dismiss(id: &str) -> bool {
    let removed = with_pending(|pending| pending.remove(id).is_some());
    if removed {
        crate::bus::emit("safety-block-expired", serde_json::json!({ "id": id }));
    }
    removed
}

/// A new user turn supersedes any unanswered post-hoc choice in that chat.
pub fn forget_chat(chat_key: &str) {
    let removed: Vec<String> = with_pending(|pending| {
        let ids = pending
            .values()
            .filter(|block| block.chat_key == chat_key)
            .map(|block| block.id.clone())
            .collect::<Vec<_>>();
        for id in &ids {
            pending.remove(id);
        }
        ids
    });
    for id in removed {
        crate::bus::emit("safety-block-expired", serde_json::json!({ "id": id }));
    }
    with_drafts(|drafts| {
        drafts.remove(chat_key);
    });
}

/// Inspect one diagnostics-only line and announce the narrow class that needs
/// an explicit user decision. Returns whether a new card was created.
pub fn observe(agent: AgentKind, chat_key: &str, line: &str) -> bool {
    if agent != AgentKind::Codex {
        return false;
    }

    if let Some((summary, detail)) = complete_safety_rejection(line) {
        with_drafts(|drafts| {
            drafts.remove(chat_key);
        });
        return publish(chat_key, summary, detail);
    }

    // `apply_patch` safety refusals currently arrive as three physical stderr
    // lines. Hold them briefly so the UI never draws three unrelated amber log
    // boxes. An exec refusal carries escaped newlines in one record and takes
    // the complete path above instead.
    if is_safety_rejection_start(line) {
        with_drafts(|drafts| {
            drafts.insert(
                chat_key.to_string(),
                SafetyDraft {
                    lines: vec![clean_debug_message(line)],
                    summary: None,
                },
            );
        });
        return false;
    }

    let finished = with_drafts(|drafts| {
        let draft = drafts.get_mut(chat_key)?;
        if let Some(reason) = line.trim().strip_prefix("Reason:") {
            let reason = reason.trim();
            if !reason.is_empty() {
                draft.summary = Some(reason.to_string());
            }
            draft.lines.push(line.trim().to_string());
            return None;
        }
        if line.trim_start().starts_with("The agent must") {
            draft.lines.push(line.trim().to_string());
            let draft = drafts.remove(chat_key)?;
            return Some((draft.summary?, draft.lines.join("\n")));
        }
        None
    });

    finished.is_some_and(|(summary, detail)| publish(chat_key, summary, detail))
}

fn publish(chat_key: &str, summary: String, detail: String) -> bool {
    let (kind, title, notification) = presentation(&summary);

    // A provider can mirror one diagnostic onto both streams. One decision is
    // enough, and duplicate cards make a one-time grant look reusable.
    let existing = with_pending(|pending| {
        pending
            .values()
            .any(|block| block.chat_key == chat_key && block.detail == detail)
    });
    if existing {
        return false;
    }

    let block = BlockedAction {
        id: uuid::Uuid::new_v4().to_string(),
        chat_key: chat_key.to_string(),
        kind,
        title,
        summary,
        detail,
    };
    with_pending(|pending| {
        pending.insert(block.id.clone(), block.clone());
    });
    crate::bus::emit("safety-blocked", block);
    crate::push::notify_chat(Some(chat_key), "permission", notification);
    true
}

fn presentation(summary: &str) -> (&'static str, &'static str, &'static str) {
    let lower = summary.to_ascii_lowercase();
    let external = (lower.contains("external") || summary.contains("外部"))
        && (lower.contains("send")
            || lower.contains("transmit")
            || lower.contains("transfer")
            || lower.contains("egress")
            || summary.contains("发送")
            || summary.contains("外传"));
    if external {
        (
            "external-data",
            "Codex blocked external data sharing",
            "Codex blocked external data sharing",
        )
    } else {
        (
            "high-risk-action",
            "Codex blocked a high-risk action",
            "Codex blocked a high-risk action",
        )
    }
}

/// Recognise the reviewer wording without promoting ordinary sandbox failures
/// (a denied delete, an unavailable executable, and so on) into permission UI.
fn complete_safety_rejection(line: &str) -> Option<(String, String)> {
    if !is_safety_rejection_start(line) {
        return None;
    }
    let detail = clean_debug_message(line);
    let summary = detail
        .split_once("Reason:")
        .map(|(_, reason)| reason)
        .and_then(|reason| reason.split("\nThe agent must").next())
        .map(str::trim)
        .filter(|reason| !reason.is_empty())?
        .to_string();
    Some((summary, detail))
}

fn is_safety_rejection_start(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("codex_core::tools::router:")
        && lower.contains("rejected due to unacceptable risk")
}

fn clean_debug_message(line: &str) -> String {
    let unescaped = line.replace("\\n", "\n").replace("\\\"", "\"");
    let message = unescaped
        .split_once("Rejected(\"")
        .map(|(_, message)| message)
        .or_else(|| unescaped.split_once("error=").map(|(_, message)| message))
        .unwrap_or(unescaped.as_str());
    message
        .trim_end_matches(|c| matches!(c, '"' | ')' | '}' | ' '))
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXTERNAL: &str = "2026-09-05T12:44:54Z ERROR codex_core::tools::router: \
error=exec_command failed: CreateProcess { message: \"Rejected(\\\"This action was rejected due to unacceptable risk.\\nReason: This command would send local outline and constraints to the external DeepSeek/OpenCode service without explicit approval.\\nThe agent must stop and request user input.\\\")\" }";

    const OBSERVED_EXTERNAL: &str = "2026-09-05T12:44:54.840971Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: \"Rejected(\\\"This action was rejected due to unacceptable risk.\\nReason: 该命令会将本地私有 outline 与 constraints 发送给外部 DeepSeek/OpenCode 服务；用户只授权先写 outline，未明确授权这些具体内容向该目的地外传。\\nThe agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention.\\\")\" }";

    #[test]
    fn external_transfer_rejection_becomes_a_clear_block() {
        let (summary, detail) = complete_safety_rejection(EXTERNAL).expect("the safety block");

        assert!(summary.contains("DeepSeek/OpenCode"));
        assert!(summary.contains("outline and constraints"));
        assert!(detail.starts_with("This action was rejected"));
        assert!(detail.contains("\nReason:"));
        assert!(!detail.contains("\\n"));
    }

    #[test]
    fn ordinary_router_rejections_stay_diagnostics_only() {
        let denied_delete = "2026-09-01T03:56:54Z ERROR codex_core::tools::router: \
error=exec_command failed: CreateProcess { message: Rejected: rm -f is not permitted }";

        assert!(complete_safety_rejection(denied_delete).is_none());
    }

    #[test]
    fn the_observed_localised_rejection_keeps_its_specific_reason() {
        let (summary, detail) =
            complete_safety_rejection(OBSERVED_EXTERNAL).expect("the observed safety block");

        assert!(summary.starts_with("该命令会将本地私有 outline"));
        assert!(summary.contains("DeepSeek/OpenCode"));
        assert!(!summary.contains("The agent must"));
        assert!(detail.contains("This action was rejected due to unacceptable risk."));
    }

    #[test]
    fn a_non_codex_provider_never_raises_a_codex_safety_card() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());

        assert!(!observe(AgentKind::Claude, &chat, EXTERNAL));
        assert!(pending().iter().all(|block| block.chat_key != chat));
    }

    #[test]
    fn the_same_rejection_is_one_reload_safe_choice() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());

        assert!(observe(AgentKind::Codex, &chat, EXTERNAL));
        assert!(!observe(AgentKind::Codex, &chat, EXTERNAL));
        let ours = pending()
            .into_iter()
            .filter(|block| block.chat_key == chat)
            .collect::<Vec<_>>();
        assert_eq!(ours.len(), 1);
        assert!(dismiss(&ours[0].id));
        assert!(pending().iter().all(|block| block.chat_key != chat));
    }

    #[test]
    fn a_split_patch_rejection_becomes_one_generic_safety_choice() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let header = "2026-09-07T12:15:53.336267Z ERROR codex_core::tools::router: \
error=This action was rejected due to unacceptable risk.";
        let reason = "Reason: 补丁会伪造质量记录并误导 PR 审查；用户未授权此类不实修改。";
        let policy = "The agent must not attempt to achieve the same outcome via workaround, \
indirect execution, or policy circumvention. Proceed only with a materially safer alternative, \
or if the user explicitly approves the action after being informed of the risk.";

        assert!(!observe(AgentKind::Codex, &chat, header));
        assert!(!observe(AgentKind::Codex, &chat, reason));
        assert!(observe(AgentKind::Codex, &chat, policy));

        let ours = pending()
            .into_iter()
            .filter(|block| block.chat_key == chat)
            .collect::<Vec<_>>();
        assert_eq!(ours.len(), 1);
        assert_eq!(ours[0].kind, "high-risk-action");
        assert_eq!(ours[0].title, "Codex blocked a high-risk action");
        assert_eq!(ours[0].summary, reason.trim_start_matches("Reason: "));
        assert!(ours[0].detail.starts_with("This action was rejected"));
        assert!(ours[0].detail.contains("\nReason:"));
        assert!(ours[0].detail.contains("\nThe agent must"));
        assert!(dismiss(&ours[0].id));
    }
}

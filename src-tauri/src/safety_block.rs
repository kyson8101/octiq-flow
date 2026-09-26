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
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

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
    #[serde(skip_serializing)]
    project_scope: Option<String>,
    /// Whose review refused: "codex" (its tool router) or "claude" (its auto
    /// mode classifier).
    provider: &'static str,
    /// The exact action as the agent called it — a shell line, or a tool and
    /// what it named. None when the provider did not say, as Codex's router
    /// diagnostics never do.
    action: Option<String>,
    /// The one provider permission rule that lets exactly `action` run, when
    /// such a rule exists. See `exact_rule`.
    exact_grant: Option<String>,
}

impl BlockedAction {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn chat_key(&self) -> &str {
        &self.chat_key
    }
}

static PENDING: Mutex<Option<HashMap<String, BlockedAction>>> = Mutex::new(None);
/// One-shot exact grants the person made, by chat key, waiting for the next
/// launch of that chat's agent. See `grant_exact`.
static GRANTS: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);
/// How each card that is no longer pending was decided, so the orchestration
/// record can say what happened rather than only that the card went away.
static DECIDED: Mutex<Option<HashMap<String, &'static str>>> = Mutex::new(None);

fn with_grants<T>(f: impl FnOnce(&mut HashMap<String, Vec<String>>) -> T) -> T {
    let mut guard = GRANTS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn with_decided<T>(f: impl FnOnce(&mut HashMap<String, &'static str>) -> T) -> T {
    let mut guard = DECIDED.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Remember how a card was decided. Bounded: a long-lived server must not
/// grow this forever, and an old decision only loses its label, never turns
/// into an approval.
fn record_decision(id: &str, decision: &'static str) {
    with_decided(|decided| {
        if decided.len() >= 512 {
            decided.clear();
        }
        decided.insert(id.to_string(), decision);
    });
}

/// How a card that is no longer pending was decided, when this server saw it:
/// "allowed_exact", "authorized_project", "dismissed" or "superseded".
pub(crate) fn decision(id: &str) -> Option<&'static str> {
    with_decided(|decided| decided.get(id).copied())
}
static DRAFTS: Mutex<Option<HashMap<String, SafetyDraft>>> = Mutex::new(None);
static PROJECT_SCOPES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
static AUTHORIZATIONS: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PersistentAuthorization {
    id: String,
    project_scope: String,
    kind: String,
    summary: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizationStore {
    #[serde(default)]
    authorizations: Vec<PersistentAuthorization>,
}

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

fn with_project_scopes<T>(f: impl FnOnce(&mut HashMap<String, String>) -> T) -> T {
    let mut guard = PROJECT_SCOPES.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn normalized_scope(cwd: &str) -> Option<String> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return None;
    }
    let path = PathBuf::from(cwd);
    Some(
        path.canonicalize()
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned(),
    )
}

/// Associate a conversation with the project folder it was launched in. The
/// safety diagnostic itself carries only a chat key, so this is the durable
/// boundary used by "Always allow in this project".
pub fn remember_project(chat_key: &str, cwd: &str) {
    if let Some(scope) = normalized_scope(cwd) {
        with_project_scopes(|scopes| {
            scopes.insert(chat_key.to_string(), scope);
        });
    }
}

fn authorization_path() -> PathBuf {
    crate::profile::profile_dir().join("safety-authorizations.json")
}

fn read_authorizations(path: &Path) -> Result<AuthorizationStore, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Saved safety authorizations could not be read.".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AuthorizationStore::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn write_authorizations(path: &Path, store: &AuthorizationStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, body).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())
}

fn save_authorization(path: &Path, block: &BlockedAction) -> Result<(), String> {
    let project_scope = block
        .project_scope
        .clone()
        .ok_or("This chat is not attached to a project folder, so the authorization cannot be saved across sessions.")?;
    let _guard = AUTHORIZATIONS.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = read_authorizations(path)?;
    let duplicate = store.authorizations.iter().any(|grant| {
        grant.project_scope == project_scope
            && grant.kind == block.kind
            && grant.summary == block.summary
    });
    if !duplicate {
        store.authorizations.push(PersistentAuthorization {
            id: uuid::Uuid::new_v4().to_string(),
            project_scope,
            kind: block.kind.to_string(),
            summary: block.summary.clone(),
        });
        write_authorizations(path, &store)?;
    }
    Ok(())
}

/// Persist one narrowly scoped grant and remove its post-hoc decision card.
/// Future Codex processes launched in the same project receive the grant in
/// their developer instructions, including processes for brand-new chats.
pub fn authorize_for_project(id: &str) -> Result<bool, String> {
    let block = with_pending(|pending| pending.get(id).cloned())
        .ok_or("This safety request is no longer pending.")?;
    if block.provider != "codex" {
        // Claude's classifier does not read these instructions; a saved
        // grant would look like permission and change nothing.
        return Err("Only Codex safety reviews can be allowed for a whole project.".into());
    }
    save_authorization(&authorization_path(), &block)?;
    Ok(dismiss_as(id, "authorized_project"))
}

fn project_authorizations_at(path: &Path, cwd: &str) -> Option<String> {
    let scope = normalized_scope(cwd)?;
    let store = read_authorizations(path).ok()?;
    let grants = store
        .authorizations
        .iter()
        .filter(|grant| grant.project_scope == scope)
        .collect::<Vec<_>>();
    if grants.is_empty() {
        return None;
    }

    let entries = grants
        .iter()
        .enumerate()
        .map(|(index, grant)| {
            format!(
                "{}. kind={}; blocked action={}",
                index + 1,
                grant.kind,
                serde_json::to_string(&grant.summary).unwrap_or_else(|_| "\"unavailable\"".into())
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!(
        "Persistent project authorizations recorded from the person's explicit choices in OctiqFlow's safety UI:\n{entries}\nTreat a grant as explicit user authorization only when a later action matches the described kind of data or action, purpose, destination, files or resources, scope, and intended effect. Do not ask the person again for a matching action. A different destination, broader scope, materially different action, or new cost outside the described authorization still requires a new decision."
    ))
}

pub fn project_authorizations(cwd: &str) -> Option<String> {
    project_authorizations_at(&authorization_path(), cwd)
}

/// Every safety block that still needs a person to choose the next turn.
pub fn pending() -> Vec<BlockedAction> {
    with_pending(|pending| pending.values().cloned().collect())
}

pub(crate) fn has_pending_for_chat(chat_key: &str) -> bool {
    with_pending(|pending| pending.values().any(|block| block.chat_key == chat_key))
}

/// Coordinator evidence deliberately excludes the raw router diagnostic.
pub(crate) fn decision_summaries() -> Vec<PendingCard> {
    with_pending(|pending| {
        pending
            .values()
            .map(|block| PendingCard {
                id: block.id.clone(),
                chat_key: block.chat_key.clone(),
                reason: match &block.action {
                    Some(_) => format!("{}: {}", block.title, block.summary),
                    None => block.summary.clone(),
                },
                action: block.action.clone(),
            })
            .collect()
    })
}

/// What the orchestration record keeps of a pending card.
pub(crate) struct PendingCard {
    pub id: String,
    pub chat_key: String,
    pub reason: String,
    /// The exact call, when the provider named it.
    pub action: Option<String>,
}

/// Remove one card after the person chooses a path or dismisses it.
pub fn dismiss(id: &str) -> bool {
    dismiss_as(id, "dismissed")
}

fn dismiss_as(id: &str, decision: &'static str) -> bool {
    let removed = with_pending(|pending| pending.remove(id).is_some());
    if removed {
        record_decision(id, decision);
        crate::bus::emit("safety-block-expired", serde_json::json!({ "id": id }));
    }
    removed
}

/// The shell line of a Bash call that one exact permission rule can cover,
/// as `Bash(<line>)`, or None when no exact rule can.
///
/// A rule is only as exact as the line it names. A compound line (`a && b`,
/// pipes, redirects, substitutions) is checked by the provider one part at a
/// time, so a rule for the whole line would not cover its parts; `*` is a
/// wildcard and `:*` a prefix inside a rule; parentheses end the rule early.
/// Any of those means the card offers no exact grant and says so.
pub(crate) fn exact_rule(tool: &str, input: Option<&serde_json::Value>) -> Option<String> {
    if tool != "Bash" {
        return None;
    }
    let command = input?.get("command")?.as_str()?.trim();
    let unsafe_char = |c: char| {
        matches!(
            c,
            '&' | '|' | ';' | '<' | '>' | '$' | '`' | '(' | ')' | '*' | '\\' | '\n' | '\r'
        )
    };
    if command.is_empty() || command.len() > 2_000 || command.contains(unsafe_char) {
        return None;
    }
    Some(format!("Bash({command})"))
}

/// What the agent tried, in one line: the shell line, or the tool and the
/// file or path it named.
fn describe_call(tool: &str, input: Option<&serde_json::Value>) -> String {
    let named = input.and_then(|input| {
        ["command", "file_path", "path", "url", "notebook_path"]
            .iter()
            .find_map(|key| input.get(key).and_then(|v| v.as_str()))
            .map(str::trim)
            .filter(|s| !s.is_empty())
    });
    match named {
        Some(named) if tool == "Bash" => named.to_string(),
        Some(named) => format!("{tool} {named}"),
        None => tool.to_string(),
    }
}

/// Turn Claude's own record of an auto-mode refusal into a decision card.
///
/// `claude -p` reports it as `{"type":"system","subtype":"permission_denied",
/// "decision_reason_type":"classifier",...}` naming the tool call; `called` is
/// that call's name and input, from the assistant message that made it. Only
/// classifier refusals become cards: a deny rule or the person's own "no" is
/// a decision already made.
pub fn observe_claude_denial(
    chat_key: &str,
    event: &serde_json::Value,
    called: Option<(&str, &serde_json::Value)>,
) -> bool {
    let text = |name: &str| event.get(name).and_then(serde_json::Value::as_str);
    if text("type") != Some("system")
        || text("subtype") != Some("permission_denied")
        || text("decision_reason_type") != Some("classifier")
    {
        return false;
    }
    let tool = text("tool_name")
        .or(called.map(|(name, _)| name))
        .unwrap_or("A tool");
    let input = called.map(|(_, input)| input);
    let reason = text("decision_reason")
        .map(|r| {
            r.trim()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .trim()
        })
        .filter(|r| !r.is_empty())
        .unwrap_or("Blocked by auto mode");
    let action = describe_call(tool, input);
    let mut detail = text("message").unwrap_or_default().trim().to_string();
    if let Some(id) = text("tool_use_id") {
        // Two refusals of the same line are two decisions, not one card.
        detail.push_str(&format!("\n\nTool call: {id}"));
    }
    publish_block(BlockedAction {
        id: uuid::Uuid::new_v4().to_string(),
        chat_key: chat_key.to_string(),
        kind: "high-risk-action",
        title: "Claude's auto mode blocked an action",
        summary: reason.to_string(),
        detail,
        project_scope: None,
        provider: "claude",
        exact_grant: exact_rule(tool, input),
        action: Some(action),
    })
}

/// A pending card the person is allowing exactly: its chat and the rule.
pub struct StagedGrant {
    pub id: String,
    pub chat_key: String,
    pub rule: String,
    pub action: String,
}

/// Put a pending Claude card's exact rule in place for that chat's next agent
/// launch, keeping the card up until `confirm_exact` (or `unstage_exact` if
/// the chat cannot be relaunched yet). Staged first so no launch in between
/// can start without it. The rule waits in `GRANTS` until a launch takes it
/// (`exact_grants`) and a call uses it (`consume_grant`).
pub fn stage_exact(id: &str) -> Result<StagedGrant, String> {
    let block = with_pending(|pending| pending.get(id).cloned())
        .ok_or("This safety request is no longer pending.")?;
    let rule = block.exact_grant.clone().ok_or(
        "This action cannot be allowed exactly: only a single shell command with no pipes, chains, redirects or wildcards can be. Ask the agent for a safer approach, or change the permission yourself.",
    )?;
    with_grants(|grants| {
        let rules = grants.entry(block.chat_key.clone()).or_default();
        if !rules.contains(&rule) {
            rules.push(rule.clone());
        }
    });
    Ok(StagedGrant {
        id: block.id,
        chat_key: block.chat_key,
        rule,
        action: block.action.unwrap_or_default(),
    })
}

/// The staged grant stands: the card is decided as "allowed_exact".
pub fn confirm_exact(staged: &StagedGrant) -> bool {
    dismiss_as(&staged.id, "allowed_exact")
}

/// The staged grant could not take effect; the card stays for later.
pub fn unstage_exact(staged: &StagedGrant) {
    with_grants(|grants| {
        if let Some(rules) = grants.get_mut(&staged.chat_key) {
            rules.retain(|r| r != &staged.rule);
            if rules.is_empty() {
                grants.remove(&staged.chat_key);
            }
        }
    });
}

/// The exact rules waiting for this chat's next launch.
pub fn exact_grants(chat_key: &str) -> Vec<String> {
    with_grants(|grants| grants.get(chat_key).cloned().unwrap_or_default())
}

/// A call matching a waiting grant uses it up: the next launch will not carry
/// it. True when this call was the one the person allowed.
pub fn consume_grant(chat_key: &str, tool: &str, input: Option<&serde_json::Value>) -> bool {
    let Some(rule) = exact_rule(tool, input) else {
        return false;
    };
    with_grants(|grants| {
        let Some(rules) = grants.get_mut(chat_key) else {
            return false;
        };
        let before = rules.len();
        rules.retain(|r| r != &rule);
        let used = rules.len() != before;
        if rules.is_empty() {
            grants.remove(chat_key);
        }
        used
    })
}

/// Drop every exact grant of a chat that is being stopped for good.
pub fn forget_grants(chat_key: &str) {
    with_grants(|grants| {
        grants.remove(chat_key);
    });
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
        record_decision(&id, "superseded");
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
    let (kind, title) = presentation(&summary);
    publish_block(BlockedAction {
        id: uuid::Uuid::new_v4().to_string(),
        chat_key: chat_key.to_string(),
        kind,
        title,
        summary,
        detail,
        project_scope: with_project_scopes(|scopes| scopes.get(chat_key).cloned()),
        provider: "codex",
        action: None,
        exact_grant: None,
    })
}

/// Put one card up, unless the same refusal already has one.
fn publish_block(block: BlockedAction) -> bool {
    // A provider can mirror one diagnostic onto both streams. One decision is
    // enough, and duplicate cards make a one-time grant look reusable.
    let existing = with_pending(|pending| {
        pending
            .values()
            .any(|old| old.chat_key == block.chat_key && old.detail == block.detail)
    });
    if existing {
        return false;
    }
    let chat_key = block.chat_key.clone();
    let title = block.title;
    with_pending(|pending| {
        pending.insert(block.id.clone(), block.clone());
    });
    crate::bus::emit("safety-blocked", block);
    crate::push::notify_chat(Some(&chat_key), "permission", title);
    true
}

fn presentation(summary: &str) -> (&'static str, &'static str) {
    let lower = summary.to_ascii_lowercase();
    let external = (lower.contains("external") || summary.contains("外部"))
        && (lower.contains("send")
            || lower.contains("transmit")
            || lower.contains("transfer")
            || lower.contains("egress")
            || summary.contains("发送")
            || summary.contains("外传"));
    if external {
        ("external-data", "Codex blocked external data sharing")
    } else {
        ("high-risk-action", "Codex blocked a high-risk action")
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
        // Reviewer guidance after the reason is instruction to the agent, not
        // part of the blocked-action description that the person authorizes.
        // Keeping it in the approval turn can literally re-inject "ask for
        // approval" after the person has just approved the action.
        .and_then(|reason| reason.lines().next())
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

    const MODERN_REJECTION: &str = "2026-09-17T01:00:00Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: \"Rejected(\\\"This action was rejected due to unacceptable risk.\\nReason: 该命令会上传新的 3D 构图参考并创建一次 3-credit 生成任务。\\nDo not bypass this rejection through a workaround or indirect execution. Complete unaffected work without asking for confirmation. Report anything that remains blocked and ask for approval.\\\")\" }";

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
    fn approval_text_keeps_only_the_reason_not_the_reviewers_follow_up_commands() {
        let (summary, _) =
            complete_safety_rejection(MODERN_REJECTION).expect("the modern safety block");

        assert_eq!(
            summary,
            "该命令会上传新的 3D 构图参考并创建一次 3-credit 生成任务。"
        );
        assert!(!summary.contains("ask for approval"));
        assert!(!summary.contains("Do not bypass"));
    }

    #[test]
    fn a_saved_grant_is_reloaded_only_for_the_same_project() {
        let root = std::env::temp_dir().join(format!(
            "octiq-safety-authorizations-{}",
            uuid::Uuid::new_v4()
        ));
        let other = root.with_extension("other-project");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&other).unwrap();
        let path = root.join("grants.json");
        let scope = normalized_scope(root.to_str().unwrap()).unwrap();
        let block = BlockedAction {
            id: "blocked-1".into(),
            chat_key: "chat:one".into(),
            kind: "external-data",
            title: "Codex blocked external data sharing",
            summary: "Send these four character references to Higgsfield for the landing page."
                .into(),
            detail: "review detail".into(),
            project_scope: Some(scope),
            provider: "codex",
            action: None,
            exact_grant: None,
        };

        save_authorization(&path, &block).unwrap();
        // The same click or delivery retry is idempotent.
        save_authorization(&path, &block).unwrap();
        let stored = read_authorizations(&path).unwrap();
        assert_eq!(stored.authorizations.len(), 1);

        let prompt = project_authorizations_at(&path, root.to_str().unwrap()).unwrap();
        assert!(prompt.contains("Higgsfield"));
        assert!(prompt.contains("Do not ask the person again"));
        assert!(project_authorizations_at(&path, other.to_str().unwrap()).is_none());

        fs::remove_file(&path).unwrap();
        fs::remove_dir(&root).unwrap();
        fs::remove_dir(&other).unwrap();
    }

    fn classifier_denial(tool: &str, id: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "system", "subtype": "permission_denied",
            "decision_reason": "[Production Deploy]", "decision_reason_type": "classifier",
            "message": "Permission for this action was denied by the Claude Code auto mode classifier.",
            "tool_name": tool, "tool_use_id": id,
        })
    }

    #[test]
    fn only_a_single_plain_shell_line_gets_an_exact_rule() {
        let bash = |line: &str| exact_rule("Bash", Some(&serde_json::json!({ "command": line })));
        assert_eq!(
            bash("git push origin HEAD:develop"),
            Some("Bash(git push origin HEAD:develop)".into())
        );
        // Each of these would cover less, or more, than the line shown.
        for line in [
            "git push && npm publish",
            "cat a | sh",
            "echo x > f",
            "rm -rf $DIR",
            "eas update --message \"(hotfix)\"",
            "npm run *",
            "echo `id`",
            "a\nb",
            "",
        ] {
            assert_eq!(bash(line), None, "{line}");
        }
        assert_eq!(
            exact_rule("Edit", Some(&serde_json::json!({ "file_path": "/x" }))),
            None
        );
    }

    #[test]
    fn a_claude_classifier_refusal_becomes_a_card_naming_the_exact_call() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let input = serde_json::json!({ "command": "eas update --branch production" });
        assert!(observe_claude_denial(
            &chat,
            &classifier_denial("Bash", "toolu_1"),
            Some(("Bash", &input))
        ));
        // The same refusal, seen twice, is still one decision.
        assert!(!observe_claude_denial(
            &chat,
            &classifier_denial("Bash", "toolu_1"),
            Some(("Bash", &input))
        ));
        let card = pending().into_iter().find(|b| b.chat_key == chat).unwrap();
        assert_eq!(card.provider, "claude");
        assert_eq!(card.summary, "Production Deploy");
        assert_eq!(
            card.action.as_deref(),
            Some("eas update --branch production")
        );
        assert_eq!(
            card.exact_grant.as_deref(),
            Some("Bash(eas update --branch production)")
        );
        // A Claude card cannot be turned into a project-wide instruction.
        assert!(authorize_for_project(&card.id).is_err());
        assert!(dismiss(&card.id));
        assert_eq!(decision(&card.id), Some("dismissed"));
    }

    #[test]
    fn a_rule_or_person_denial_is_not_a_card_and_a_chain_is_not_grantable() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let mut ruled = classifier_denial("Bash", "toolu_2");
        ruled["decision_reason_type"] = "rule".into();
        assert!(!observe_claude_denial(&chat, &ruled, None));
        assert!(pending().iter().all(|b| b.chat_key != chat));

        let chain = serde_json::json!({ "command": "git push && npm publish" });
        assert!(observe_claude_denial(
            &chat,
            &classifier_denial("Bash", "toolu_3"),
            Some(("Bash", &chain))
        ));
        let card = pending().into_iter().find(|b| b.chat_key == chat).unwrap();
        assert!(card.exact_grant.is_none());
        let refused = stage_exact(&card.id).err().unwrap();
        assert!(refused.contains("single shell command"), "{refused}");
        // Refusing to grant leaves the card for the person's other choices.
        assert!(pending().iter().any(|b| b.id == card.id));
        assert!(exact_grants(&chat).is_empty());
        forget_chat(&chat);
        assert_eq!(decision(&card.id), Some("superseded"));
    }

    #[test]
    fn an_unstaged_grant_leaves_nothing_behind() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let input = serde_json::json!({ "command": "npm publish" });
        assert!(observe_claude_denial(
            &chat,
            &classifier_denial("Bash", "toolu_4"),
            Some(("Bash", &input))
        ));
        let card = pending().into_iter().find(|b| b.chat_key == chat).unwrap();
        let staged = stage_exact(&card.id).unwrap();
        assert_eq!(exact_grants(&chat), vec!["Bash(npm publish)".to_string()]);
        unstage_exact(&staged);
        assert!(exact_grants(&chat).is_empty());
        assert!(
            pending().iter().any(|b| b.id == card.id),
            "the card stays up"
        );
        forget_grants(&chat);
        forget_chat(&chat);
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

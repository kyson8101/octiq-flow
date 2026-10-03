//! Who an error or warning in a chat came from: the provider, or OctiqFlow.
//!
//! "3 success; 7 failed" says nothing about who failed. Seven agent_update
//! cards that expired on OctiqFlow's own 180-second timer read exactly like
//! Claude refusing seven times, and the person blamed the wrong party. So
//! every failure the host can account for carries an `Outcome`, set at the
//! place the failure is PRODUCED — the permission answer, the hook refusal,
//! the provider's own error event — and never guessed later from the words.
//!
//! It travels three ways, one per kind of failure:
//!
//! * **A host MCP tool** (`agent_update`, the orchestration tools …) answers
//!   its hook with `{error, outcome}` (`Refusal::body`). The MCP copies the
//!   outcome into the tool result's `_meta["octiq/outcome"]`, which both
//!   providers hand through to the stream untouched: Claude on
//!   `tool_use_result._meta`, Codex on `item.result._meta`.
//! * **A native tool's permission card** (Claude's `can_use_tool`, a Codex
//!   approval) goes nowhere near the MCP, so the host writes its own line,
//!   `octiq_tool_outcome`, into the chat's transcript, keyed by the call id
//!   (`record_tool`).
//! * **A provider failure** (rate limit, sign-in, model, CLI error) is
//!   annotated where the reader records it (`annotate`): the event gains an
//!   `octiq_outcome` field before it is written down.
//!
//! An event recorded before this existed has none of these, and the page
//! draws it as it always did.
use std::cell::RefCell;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent_provider::AgentKind;

/// The tool result `_meta` key a host MCP failure carries its outcome under.
pub const META_KEY: &str = "octiq/outcome";
/// The field a provider failure event, or a host tool line, carries it in.
pub const EVENT_FIELD: &str = "octiq_outcome";
/// The host's own line about one tool call (`record_tool`).
pub const TOOL_EVENT: &str = "octiq_tool_outcome";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// The agent's own CLI or its API: Claude, Codex, Pi.
    Provider,
    /// This host: its cards, its rules, its tools.
    Octiqflow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReasonClass {
    /// A card nobody answered before it timed out.
    ApprovalExpired,
    /// A card the person answered with Deny.
    ApprovalDenied,
    /// Outside what this chat may reach: a destination, a scope, a capability.
    ScopeRefused,
    /// The call's own arguments were refused before anything ran.
    Validation,
    /// The host gave up waiting on something of its own.
    HostTimeout,
    RateLimit,
    Auth,
    ModelUnavailable,
    ProviderError,
    Other,
}

impl ReasonClass {
    /// A warning is a failure nothing is broken by: a person or the clock
    /// resolves it, and calling again later can work. Everything else is an
    /// error.
    pub fn severity(self) -> Severity {
        match self {
            Self::ApprovalExpired | Self::ApprovalDenied | Self::RateLimit => Severity::Warning,
            _ => Severity::Error,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub origin: Origin,
    pub reason_class: ReasonClass,
    /// Only on a provider outcome: which provider it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    pub severity: Severity,
}

impl Outcome {
    pub fn host(reason: ReasonClass) -> Self {
        Self {
            origin: Origin::Octiqflow,
            reason_class: reason,
            provider_name: None,
            severity: reason.severity(),
        }
    }

    pub fn provider(agent: AgentKind, reason: ReasonClass) -> Self {
        Self {
            origin: Origin::Provider,
            reason_class: reason,
            provider_name: Some(provider_name(agent).into()),
            severity: reason.severity(),
        }
    }

    pub fn value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

pub fn provider_name(agent: AgentKind) -> &'static str {
    match agent {
        AgentKind::Claude => "Claude",
        AgentKind::Codex => "Codex",
        AgentKind::Pi => "Pi",
    }
}

/// A host refusal: the words the agent reads, and what kind of refusal it
/// was. A plain `String` error converts to `Other`, so a site that has not
/// said what it is still reads as OctiqFlow's — which is the part that
/// matters — rather than as nobody's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub message: String,
    pub outcome: Outcome,
}

impl Refusal {
    pub fn new(reason: ReasonClass, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            outcome: Outcome::host(reason),
        }
    }

    /// The hook's answer: the error the MCP shows the agent, and its outcome.
    pub fn body(&self) -> Value {
        json!({ "error": self.message, "outcome": self.outcome })
    }
}

impl From<String> for Refusal {
    fn from(message: String) -> Self {
        Self::new(ReasonClass::Other, message)
    }
}

impl From<&str> for Refusal {
    fn from(message: &str) -> Self {
        Self::new(ReasonClass::Other, message)
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

thread_local! {
    /// The last refusal `refuse` named on this thread, with its words.
    static NOTED: RefCell<Option<(ReasonClass, String)>> = const { RefCell::new(None) };
}

/// Say what kind of refusal `message` is, where it is produced, and hand the
/// message back unchanged. For a refusal made deep in a command that can only
/// return a `String` (`destination::route`, `dispatch::arg`): the hook that
/// ran the command reads the kind back with `classify`, on the same thread.
pub fn refuse(reason: ReasonClass, message: impl Into<String>) -> String {
    let message = message.into();
    NOTED.with(|noted| *noted.borrow_mut() = Some((reason, message.clone())));
    message
}

/// Drop whatever an earlier piece of work on this (pooled) thread noted.
pub fn forget() {
    NOTED.with(|noted| noted.borrow_mut().take());
}

/// Run one command and read its refusal back with `classify`, leaving this
/// (pooled) thread with no note however it ends: an `Ok` whose command
/// swallowed a refusal, an `Err`, or a panic. The note before it is dropped
/// too, so nothing earlier work left labels this command's error.
pub fn noted<T>(run: impl FnOnce() -> Result<T, String>) -> Result<T, Refusal> {
    struct Clear;
    impl Drop for Clear {
        fn drop(&mut self) {
            forget();
        }
    }
    forget();
    let _clear = Clear;
    run().map_err(classify)
}

/// What a command's `error` was: the kind `refuse` noted for it on this
/// thread, when the error still carries the words it was noted with (a caller
/// may have put context around them), else OctiqFlow's `Other`.
pub fn classify(error: String) -> Refusal {
    match NOTED.with(|noted| noted.borrow_mut().take()) {
        Some((reason, message)) if !message.is_empty() && error.contains(&message) => {
            Refusal::new(reason, error)
        }
        _ => Refusal::from(error),
    }
}

/// What a permission answer was, when it was not a yes. Every answer is the
/// host's own (`permission::ask`), so its reason is one of the host's own
/// words, not something read off an agent.
pub fn of_permission(answer: &crate::permission::Answer) -> Option<Outcome> {
    if answer.decision == "allow" {
        return None;
    }
    Some(Outcome::host(match answer.reason.as_str() {
        crate::permission::TIMED_OUT => ReasonClass::ApprovalExpired,
        crate::permission::DENIED => ReasonClass::ApprovalDenied,
        // Nobody was watching: no card could be shown at all.
        _ => ReasonClass::Other,
    }))
}

/// The host's line about one tool call, as the transcript holds it.
pub fn tool_event(tool_use_id: &str, outcome: &Outcome) -> Value {
    json!({ "type": TOOL_EVENT, "tool_use_id": tool_use_id, EVENT_FIELD: outcome })
}

/// Say in the chat what became of one tool call, on the host's side. Recorded
/// like any other line, so a reload replays it.
pub fn record_tool(chat_key: &str, tool_use_id: &str, outcome: &Outcome) {
    if tool_use_id.is_empty() {
        return;
    }
    crate::agent_chat::record_chat_event(chat_key, tool_event(tool_use_id, outcome));
}

/// Mark a provider failure event with its outcome, in place, before it is
/// recorded. Anything else is left exactly as it came.
pub fn annotate(agent: AgentKind, event: &mut Value) {
    if let Some(outcome) = of_provider_event(agent, event) {
        if let Some(object) = event.as_object_mut() {
            object.insert(EVENT_FIELD.into(), outcome.value());
        }
    }
}

/// Is this event a provider failure, and of what kind?
///
/// The provider's own structured fields are read first: Claude's HTTP status
/// and its `error` code, Codex's `codex_error_info`. Only an event that has
/// none falls back to its words — here, on the host, once — so the page never
/// has to.
pub fn of_provider_event(agent: AgentKind, event: &Value) -> Option<Outcome> {
    let kind = event.get("type").and_then(Value::as_str)?;
    let reason = match (agent, kind) {
        (AgentKind::Claude, "result") => {
            if event.get("is_error").and_then(Value::as_bool) != Some(true)
                // The person's own Stop coming back, not a failure.
                || event.get("subtype").and_then(Value::as_str) == Some("error_during_execution")
            {
                return None;
            }
            claude_status(event.get("api_error_status"))
                .unwrap_or_else(|| by_words(agent, event, text_of(event, &["result"])))
        }
        // The CLI's own stand-in reply for a failed request.
        (AgentKind::Claude, "assistant") => {
            let code = event.get("error").and_then(Value::as_str)?;
            claude_code(code)
        }
        // Claude's auto mode refusing a call is the provider's decision.
        (AgentKind::Claude, "system")
            if event.get("subtype").and_then(Value::as_str) == Some("permission_denied") =>
        {
            ReasonClass::ProviderError
        }
        (AgentKind::Codex, "error" | "turn.failed" | "warning") => {
            let error = event.get("error").unwrap_or(&Value::Null);
            codex_info(error.get("codex_error_info")).unwrap_or_else(|| {
                by_words(
                    agent,
                    event,
                    text_of(event, &["message"]).or_else(|| text_of(error, &["message"])),
                )
            })
        }
        (AgentKind::Pi, "agent_end" | "agent_settled") => {
            let words = text_of(event, &["error"])
                .or_else(|| event.pointer("/error/message").and_then(Value::as_str));
            words?;
            by_words(agent, event, words)
        }
        _ => return None,
    };
    let mut outcome = Outcome::provider(agent, reason);
    // A Codex stream that will be retried is a warning whatever its kind.
    if kind == "warning" {
        outcome.severity = Severity::Warning;
    }
    Some(outcome)
}

fn text_of<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
}

/// Claude's `api_error_status`: a number in current streams, a string in some.
fn claude_status(status: Option<&Value>) -> Option<ReasonClass> {
    let status = match status? {
        Value::Number(n) => n.as_u64()?,
        Value::String(s) => s.trim().parse().ok()?,
        _ => return None,
    };
    Some(match status {
        429 => ReasonClass::RateLimit,
        401 | 403 => ReasonClass::Auth,
        404 => ReasonClass::ModelUnavailable,
        _ => ReasonClass::ProviderError,
    })
}

/// The `error` code Claude puts on its stand-in assistant message.
fn claude_code(code: &str) -> ReasonClass {
    match code {
        "rate_limit" | "billing_error" => ReasonClass::RateLimit,
        "authentication_failed" | "oauth_org_not_allowed" => ReasonClass::Auth,
        "model_not_found" => ReasonClass::ModelUnavailable,
        _ => ReasonClass::ProviderError,
    }
}

/// Codex's `codex_error_info`: a bare variant name, or a one-key object
/// (`{"http_connection_failed": {"http_status_code": 401}}`) once its keys
/// have been through `snake_value`. Variant names keep Codex's camelCase.
fn codex_info(info: Option<&Value>) -> Option<ReasonClass> {
    let info = info?;
    let (name, detail) = match info {
        Value::String(name) => (name.as_str(), &Value::Null),
        Value::Object(map) if map.len() == 1 => {
            let (name, detail) = map.iter().next()?;
            (name.as_str(), detail)
        }
        _ => return None,
    };
    let squash: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    let status = detail
        .get("http_status_code")
        .or_else(|| detail.get("httpStatusCode"))
        .and_then(Value::as_u64);
    Some(match (squash.as_str(), status) {
        ("usagelimitexceeded", _) | (_, Some(429)) => ReasonClass::RateLimit,
        ("unauthorized", _) | (_, Some(401 | 403)) => ReasonClass::Auth,
        ("other", None) => return None,
        _ => ReasonClass::ProviderError,
    })
}

/// The fallback for an event with no structured field: its words, read here.
fn by_words(agent: AgentKind, event: &Value, words: Option<&str>) -> ReasonClass {
    if crate::auto_resume::is_quota_failure(agent, event) {
        return ReasonClass::RateLimit;
    }
    let text = words.unwrap_or_default().to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if has(&[
        "rate limit",
        "rate_limit",
        "429",
        "too many requests",
        "overloaded",
    ]) {
        ReasonClass::RateLimit
    } else if has(&[
        "not logged in",
        "authentication",
        "unauthorized",
        "invalid api key",
        "please run /login",
        "401",
        "token expired",
    ]) {
        ReasonClass::Auth
    } else if has(&["model"])
        && has(&[
            "not found",
            "not_found",
            "not supported",
            "does not exist",
            "not available",
            "may not have access",
            "unknown model",
        ])
    {
        ReasonClass::ModelUnavailable
    } else {
        ReasonClass::ProviderError
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(outcome: &Outcome) -> Value {
        outcome.value()
    }

    #[test]
    fn the_wire_shape_is_camel_case_and_kebab_reasons() {
        assert_eq!(
            wire(&Outcome::host(ReasonClass::ApprovalExpired)),
            json!({"origin": "octiqflow", "reasonClass": "approval-expired", "severity": "warning"})
        );
        assert_eq!(
            wire(&Outcome::provider(AgentKind::Codex, ReasonClass::RateLimit)),
            json!({"origin": "provider", "reasonClass": "rate-limit", "providerName": "Codex", "severity": "warning"})
        );
        assert_eq!(
            Outcome::host(ReasonClass::ScopeRefused).severity,
            Severity::Error
        );
    }

    #[test]
    fn an_unanswered_card_is_the_hosts_expiry_and_a_deny_is_the_persons() {
        let expired = crate::permission::Answer {
            decision: "deny",
            reason: crate::permission::TIMED_OUT.into(),
        };
        assert_eq!(
            of_permission(&expired),
            Some(Outcome::host(ReasonClass::ApprovalExpired))
        );
        let denied = crate::permission::Answer {
            decision: "deny",
            reason: crate::permission::DENIED.into(),
        };
        assert_eq!(
            of_permission(&denied),
            Some(Outcome::host(ReasonClass::ApprovalDenied))
        );
        let allowed = crate::permission::Answer {
            decision: "allow",
            reason: "you allowed it".into(),
        };
        assert_eq!(of_permission(&allowed), None);
        let unwatched = crate::permission::Answer {
            decision: "abstain",
            reason: "nobody is watching OctiqFlow".into(),
        };
        assert_eq!(
            of_permission(&unwatched).map(|o| o.origin),
            Some(Origin::Octiqflow)
        );
    }

    #[test]
    fn a_host_tool_line_names_the_call() {
        let line = tool_event("toolu_1", &Outcome::host(ReasonClass::ApprovalDenied));
        assert_eq!(line["type"], TOOL_EVENT);
        assert_eq!(line["tool_use_id"], "toolu_1");
        assert_eq!(line[EVENT_FIELD]["reasonClass"], "approval-denied");
    }

    #[test]
    fn a_refusal_body_carries_both_the_words_and_the_outcome() {
        let refusal = Refusal::new(ReasonClass::Validation, "No such agent.");
        assert_eq!(
            refusal.body(),
            json!({"error": "No such agent.", "outcome": {"origin": "octiqflow", "reasonClass": "validation", "severity": "error"}})
        );
        let plain: Refusal = String::from("Something else.").into();
        assert_eq!(plain.outcome, Outcome::host(ReasonClass::Other));
    }

    #[test]
    fn a_noted_refusal_is_read_back_only_for_its_own_words() {
        forget();
        let said = refuse(ReasonClass::ScopeRefused, "You work only in A.");
        let read = classify(format!("Could not create the task: {said}"));
        assert_eq!(read.outcome, Outcome::host(ReasonClass::ScopeRefused));
        assert_eq!(
            read.message,
            "Could not create the task: You work only in A."
        );
        // Taken: the next error on this thread is not that refusal.
        assert_eq!(
            classify("later".into()).outcome,
            Outcome::host(ReasonClass::Other)
        );
        // A note left by earlier work, swallowed, never labels another error.
        refuse(ReasonClass::Validation, "bad argument 'x'");
        assert_eq!(
            classify("The run is stopped.".into()).outcome,
            Outcome::host(ReasonClass::Other)
        );
        refuse(ReasonClass::Validation, "stale");
        forget();
        assert_eq!(
            classify("stale".into()).outcome,
            Outcome::host(ReasonClass::Other)
        );
    }

    /// Whatever a hook's command does with a refusal, the thread it ran on is
    /// left with no note: not after an `Ok` that swallowed one, an `Err`, or
    /// a panic.
    #[test]
    fn a_hook_command_leaves_no_note_on_any_exit() {
        let leftover = || NOTED.with(|noted| noted.borrow().clone());

        // A refusal made and then swallowed: the command still succeeds.
        let ok: Result<u8, Refusal> = noted(|| {
            refuse(ReasonClass::ScopeRefused, "You work only in A.");
            Ok(1)
        });
        assert_eq!(ok, Ok(1));
        assert_eq!(leftover(), None);

        // An Err is read back with its kind, and leaves nothing behind.
        let err = noted::<()>(|| Err(refuse(ReasonClass::Validation, "bad argument 'x'")));
        assert_eq!(
            err.unwrap_err().outcome,
            Outcome::host(ReasonClass::Validation)
        );
        assert_eq!(leftover(), None);

        // An Err noted with other words keeps nothing for later either.
        let err = noted::<()>(|| {
            refuse(ReasonClass::ScopeRefused, "You work only in A.");
            Err("The run is stopped.".into())
        });
        assert_eq!(err.unwrap_err().outcome, Outcome::host(ReasonClass::Other));
        assert_eq!(leftover(), None);

        // A panic unwinds through it and still clears the note.
        let caught = std::panic::catch_unwind(|| {
            let _ = noted::<()>(|| {
                refuse(ReasonClass::Validation, "half done");
                panic!("the command fell over");
            });
        });
        assert!(caught.is_err());
        assert_eq!(leftover(), None);

        // A note earlier work left is dropped before the command runs.
        refuse(ReasonClass::Validation, "stale");
        let err = noted::<()>(|| Err("stale".into()));
        assert_eq!(err.unwrap_err().outcome, Outcome::host(ReasonClass::Other));
    }

    fn claude(event: Value) -> Option<Outcome> {
        of_provider_event(AgentKind::Claude, &event)
    }

    fn codex(event: Value) -> Option<Outcome> {
        of_provider_event(AgentKind::Codex, &event)
    }

    fn reason(outcome: Option<Outcome>) -> Option<ReasonClass> {
        outcome.map(|o| o.reason_class)
    }

    #[test]
    fn claude_failures_are_classified_by_status_first() {
        let limited = claude(json!({
            "type": "result", "subtype": "success", "is_error": true,
            "api_error_status": 429, "result": "API Error: something"
        }))
        .unwrap();
        assert_eq!(limited.origin, Origin::Provider);
        assert_eq!(limited.provider_name.as_deref(), Some("Claude"));
        assert_eq!(limited.reason_class, ReasonClass::RateLimit);
        assert_eq!(
            reason(claude(
                json!({"type": "result", "is_error": true, "api_error_status": "401"})
            )),
            Some(ReasonClass::Auth)
        );
        assert_eq!(
            reason(claude(
                json!({"type": "result", "is_error": true, "api_error_status": 404})
            )),
            Some(ReasonClass::ModelUnavailable)
        );
        assert_eq!(
            reason(claude(
                json!({"type": "result", "is_error": true, "api_error_status": 529})
            )),
            Some(ReasonClass::ProviderError)
        );
    }

    #[test]
    fn claude_failures_without_a_status_fall_back_to_their_words_on_the_host() {
        assert_eq!(
            reason(claude(json!({
                "type": "result", "is_error": true,
                "result": "You've hit your session limit · resets 2:40am"
            }))),
            Some(ReasonClass::RateLimit)
        );
        assert_eq!(
            reason(claude(json!({
                "type": "result", "is_error": true,
                "result": "Invalid API key · Please run /login"
            }))),
            Some(ReasonClass::Auth)
        );
        assert_eq!(
            reason(claude(json!({
                "type": "result", "is_error": true,
                "result": "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it."
            }))),
            Some(ReasonClass::ModelUnavailable)
        );
        assert_eq!(
            reason(claude(
                json!({"type": "result", "is_error": true, "result": "boom"})
            )),
            Some(ReasonClass::ProviderError)
        );
    }

    #[test]
    fn claude_successes_and_the_persons_own_stop_are_not_failures() {
        assert_eq!(claude(json!({"type": "result", "is_error": false})), None);
        assert_eq!(
            claude(
                json!({"type": "result", "is_error": true, "subtype": "error_during_execution"})
            ),
            None
        );
        assert_eq!(claude(json!({"type": "assistant", "message": {}})), None);
        assert_eq!(claude(json!({"type": "user"})), None);
    }

    #[test]
    fn claudes_stand_in_reply_and_auto_mode_refusal_are_the_providers() {
        assert_eq!(
            reason(claude(json!({"type": "assistant", "error": "rate_limit"}))),
            Some(ReasonClass::RateLimit)
        );
        assert_eq!(
            reason(claude(
                json!({"type": "assistant", "error": "authentication_failed"})
            )),
            Some(ReasonClass::Auth)
        );
        let refused = claude(json!({
            "type": "system", "subtype": "permission_denied",
            "tool_use_id": "toolu_9", "decision_reason_type": "classifier"
        }))
        .unwrap();
        assert_eq!(refused.origin, Origin::Provider);
        assert_eq!(refused.reason_class, ReasonClass::ProviderError);
    }

    #[test]
    fn codex_failures_read_codex_error_info_first() {
        let limited = codex(json!({
            "type": "error", "message": "whatever",
            "error": {"message": "whatever", "codex_error_info": "usageLimitExceeded"}
        }))
        .unwrap();
        assert_eq!(limited.provider_name.as_deref(), Some("Codex"));
        assert_eq!(limited.reason_class, ReasonClass::RateLimit);
        assert_eq!(
            reason(codex(json!({
                "type": "turn.failed",
                "error": {"message": "x", "codex_error_info": "unauthorized"}
            }))),
            Some(ReasonClass::Auth)
        );
        assert_eq!(
            reason(codex(json!({
                "type": "error", "message": "x",
                "error": {"codex_error_info": {"http_connection_failed": {"http_status_code": 401}}}
            }))),
            Some(ReasonClass::Auth)
        );
        assert_eq!(
            reason(codex(json!({
                "type": "error", "message": "x",
                "error": {"codex_error_info": "internalServerError"}
            }))),
            Some(ReasonClass::ProviderError)
        );
    }

    #[test]
    fn codex_failures_without_info_fall_back_to_their_words() {
        // `codex exec` spells it this way, with no structured field at all.
        assert_eq!(
            reason(codex(json!({
                "type": "error",
                "message": "You've hit your usage limit. Upgrade to Pro or try again at 5:00 PM."
            }))),
            Some(ReasonClass::RateLimit)
        );
        assert_eq!(
            reason(codex(json!({
                "type": "turn.failed",
                "error": {"message": "The 'gpt-9' model is not supported when using Codex with a ChatGPT account."}
            }))),
            Some(ReasonClass::ModelUnavailable)
        );
        let retrying = codex(json!({
            "type": "warning", "will_retry": true, "message": "Reconnecting… 1/5",
            "error": {"message": "stream disconnected", "codex_error_info": "responseStreamDisconnected"}
        }))
        .unwrap();
        assert_eq!(retrying.severity, Severity::Warning);
        assert_eq!(codex(json!({"type": "turn.completed"})), None);
    }

    #[test]
    fn annotate_marks_only_failures() {
        let mut failed = json!({"type": "result", "is_error": true, "api_error_status": 429});
        annotate(AgentKind::Claude, &mut failed);
        assert_eq!(failed[EVENT_FIELD]["reasonClass"], "rate-limit");
        assert_eq!(failed[EVENT_FIELD]["providerName"], "Claude");
        let mut fine = json!({"type": "result", "is_error": false});
        annotate(AgentKind::Claude, &mut fine);
        assert!(fine.get(EVENT_FIELD).is_none());
    }
}

//! Durable, one-shot continuations for turns stopped by an account usage limit.
//!
//! This is intentionally a server-owned scheduler rather than an operating-
//! system cron job. The server already owns the native agent session id and
//! its launch settings; a detached cron process owns neither, and could easily
//! resume the wrong model, folder, or permission level.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent_chat::{record_chat_event, StartContext};
use crate::agent_provider::AgentKind;

/// Give the provider a little time to open the newly reset window before the
/// first request reaches it. Reset timestamps are second-granularity and can
/// arrive a little ahead of the actual account-side rollover.
pub(crate) const RESET_GRACE_SECONDS: i64 = 60;

/// The longest window currently exposed by either supported provider is seven
/// days. Refusing farther-away timestamps keeps a malformed event from leaving
/// an apparently live scheduled action in the UI forever.
const MAX_WAIT_SECONDS: i64 = 8 * 24 * 60 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Delivery {
    Scheduled,
    Dispatching,
    Cancelled,
}

/// Everything required to resume without a browser being connected.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduledResume {
    pub id: String,
    pub chat_key: String,
    pub reset_at: i64,
    pub run_at: i64,
    pub created_at: i64,
    pub start: StartContext,
    delivery: Delivery,
}

impl ScheduledResume {
    pub(crate) fn agent(&self) -> AgentKind {
        self.start.agent()
    }
}

#[derive(Default)]
struct State {
    entries: BTreeMap<String, ScheduledResume>,
    load_error: Option<String>,
}

/// A profile-local schedule. Entries are keyed by chat because one native
/// conversation can only be waiting for one account reset at a time.
#[derive(Default)]
pub(crate) struct Store {
    path: Option<PathBuf>,
    state: Mutex<State>,
}

impl Store {
    pub(crate) fn load(path: PathBuf) -> Self {
        let mut state = State::default();
        match fs::read(&path) {
            Ok(bytes) => {
                match serde_json::from_slice::<BTreeMap<String, ScheduledResume>>(&bytes) {
                    Ok(entries)
                        if entries.iter().all(|(key, entry)| {
                            key == &entry.chat_key
                                && !entry.id.trim().is_empty()
                                && entry.reset_at > 0
                                && entry.run_at >= entry.reset_at
                                && entry.start.resumable()
                        }) =>
                    {
                        state.entries = entries;
                    }
                    Ok(_) => {
                        state.load_error = Some("Saved auto-resumes have an invalid shape".into())
                    }
                    Err(error) => {
                        state.load_error = Some(format!("Cannot read saved auto-resumes: {error}"))
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                state.load_error = Some(format!("Cannot read saved auto-resumes: {error}"))
            }
        }
        Self {
            path: Some(path),
            state: Mutex::new(state),
        }
    }

    fn check(state: &State) -> Result<(), String> {
        state.load_error.clone().map_or(Ok(()), Err)
    }

    fn persist(&self, entries: &BTreeMap<String, ScheduledResume>) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        write_atomic(
            path,
            &serde_json::to_vec(entries).map_err(|error| error.to_string())?,
        )
    }

    /// Schedule once for this reset. A duplicate Codex `error` + `turn.failed`
    /// pair returns `None` and therefore produces only one transcript event.
    pub(crate) fn schedule(
        &self,
        chat_key: &str,
        reset_at: i64,
        start: StartContext,
        now: i64,
    ) -> Result<Option<ScheduledResume>, String> {
        if !start.resumable() || reset_at <= now || reset_at.saturating_sub(now) > MAX_WAIT_SECONDS
        {
            return Ok(None);
        }

        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        Self::check(&state)?;
        if state.entries.get(chat_key).is_some_and(|entry| {
            entry.reset_at == reset_at && entry.delivery == Delivery::Scheduled
        }) {
            return Ok(None);
        }

        let entry = ScheduledResume {
            id: uuid::Uuid::new_v4().to_string(),
            chat_key: chat_key.to_string(),
            reset_at,
            run_at: reset_at.saturating_add(RESET_GRACE_SECONDS),
            created_at: now,
            start,
            delivery: Delivery::Scheduled,
        };
        let mut next = state.entries.clone();
        next.insert(chat_key.to_string(), entry.clone());
        self.persist(&next)?;
        state.entries = next;
        Ok(Some(entry))
    }

    /// Cancel only work which has not begun dispatching. Once a due entry is
    /// marked `Dispatching`, telling the UI it was cancelled would be a lie.
    pub(crate) fn cancel(&self, chat_key: &str) -> Result<Option<ScheduledResume>, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        // A damaged schedule file must not prevent unrelated/new chats from
        // sending messages. There can be nothing known to cancel for this key.
        if !state.entries.contains_key(chat_key) {
            return Ok(None);
        }
        Self::check(&state)?;
        let Some(entry) = state.entries.get(chat_key) else {
            return Ok(None);
        };
        if entry.delivery != Delivery::Scheduled {
            return Ok(None);
        }
        let mut next = state.entries.clone();
        let cancelled = next.get_mut(chat_key).expect("entry was checked above");
        cancelled.delivery = Delivery::Cancelled;
        let cancelled = cancelled.clone();
        self.persist(&next)?;
        state.entries = next;
        Ok(Some(cancelled))
    }

    pub(crate) fn scheduled(&self) -> Result<Vec<ScheduledResume>, String> {
        let state = self.state.lock().map_err(|error| error.to_string())?;
        Self::check(&state)?;
        Ok(state
            .entries
            .values()
            .filter(|entry| entry.delivery == Delivery::Scheduled)
            .cloned()
            .collect())
    }

    pub(crate) fn cancelled(&self) -> Result<Vec<ScheduledResume>, String> {
        let state = self.state.lock().map_err(|error| error.to_string())?;
        Self::check(&state)?;
        Ok(state
            .entries
            .values()
            .filter(|entry| entry.delivery == Delivery::Cancelled)
            .cloned()
            .collect())
    }

    /// Claim every due entry before starting any agent. Persisting the
    /// `Dispatching` state gives the scheduler at-most-once semantics across a
    /// server crash: uncertain work is surfaced after restart, never repeated.
    pub(crate) fn claim_due(&self, now: i64) -> Result<Vec<ScheduledResume>, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        Self::check(&state)?;
        let due_keys: Vec<String> = state
            .entries
            .iter()
            .filter(|(_, entry)| entry.delivery == Delivery::Scheduled && entry.run_at <= now)
            .map(|(key, _)| key.clone())
            .collect();
        if due_keys.is_empty() {
            return Ok(Vec::new());
        }
        let mut next = state.entries.clone();
        let mut due = Vec::with_capacity(due_keys.len());
        for key in due_keys {
            if let Some(entry) = next.get_mut(&key) {
                entry.delivery = Delivery::Dispatching;
                due.push(entry.clone());
            }
        }
        self.persist(&next)?;
        state.entries = next;
        Ok(due)
    }

    pub(crate) fn finish(&self, entry: &ScheduledResume) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        Self::check(&state)?;
        if state
            .entries
            .get(&entry.chat_key)
            .is_none_or(|saved| saved.id != entry.id)
        {
            return Ok(());
        }
        let mut next = state.entries.clone();
        next.remove(&entry.chat_key);
        self.persist(&next)?;
        state.entries = next;
        Ok(())
    }

    /// A server stopped after claiming these entries, so whether the prompt
    /// reached the agent is unknowable. Remove and report them; retrying could
    /// duplicate edits or external side effects.
    pub(crate) fn take_uncertain(&self) -> Result<Vec<ScheduledResume>, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        Self::check(&state)?;
        let uncertain: Vec<ScheduledResume> = state
            .entries
            .values()
            .filter(|entry| entry.delivery == Delivery::Dispatching)
            .cloned()
            .collect();
        if uncertain.is_empty() {
            return Ok(uncertain);
        }
        let mut next = state.entries.clone();
        for entry in &uncertain {
            next.remove(&entry.chat_key);
        }
        self.persist(&next)?;
        state.entries = next;
        Ok(uncertain)
    }
}

pub(crate) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .try_into()
        .unwrap_or(i64::MAX)
}

/// The exact limit messages already recognised by the browser. Normalize
/// punctuation so provider spellings such as `rate_limit_exceeded` match too.
pub(crate) fn is_quota_failure(agent: AgentKind, event: &Value) -> bool {
    let message = match agent {
        AgentKind::Claude => {
            if event.get("type").and_then(Value::as_str) != Some("result")
                || event.get("is_error").and_then(Value::as_bool) != Some(true)
            {
                return false;
            }
            event
                .get("result")
                .and_then(Value::as_str)
                .or_else(|| event.get("api_error_status").and_then(Value::as_str))
        }
        AgentKind::Codex => match event.get("type").and_then(Value::as_str) {
            Some("error") => event.get("message").and_then(Value::as_str),
            Some("turn.failed") => event
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| event.get("message").and_then(Value::as_str)),
            _ => None,
        },
        AgentKind::Pi => match event.get("type").and_then(Value::as_str) {
            Some("agent_end") | Some("agent_settled") => event
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| event.pointer("/error/message").and_then(Value::as_str)),
            _ => None,
        },
    };
    let Some(message) = message else {
        return false;
    };
    let normalized: String = message
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect();
    [
        "usage limit",
        "session limit",
        "weekly limit",
        "out of credits",
        "quota",
        "rate limit",
        "purchase more credits",
        "upgrade to pro",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

/// Find a provider-supplied unix reset timestamp anywhere inside an error.
/// Both camelCase and snake_case occur in real streams.
pub(crate) fn reset_at_in(value: &Value) -> Option<i64> {
    match value {
        Value::Object(object) => {
            let direct = direct_reset_at(object).filter(|_| window_is_exhausted(object));
            direct
                .into_iter()
                .chain(
                    object
                        .iter()
                        .filter(|(key, _)| !is_reset_key(key))
                        .filter_map(|(_, value)| reset_at_in(value)),
                )
                // When several windows are exhausted, the account is usable
                // only after the last of them has reset.
                .max()
        }
        Value::Array(values) => values.iter().filter_map(reset_at_in).max(),
        _ => None,
    }
}

fn is_reset_key(key: &str) -> bool {
    let key: String = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    matches!(key.as_str(), "resetsat" | "resetat")
}

fn direct_reset_at(object: &serde_json::Map<String, Value>) -> Option<i64> {
    object.iter().find_map(|(key, value)| {
        is_reset_key(key).then(|| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        })?
    })
}

/// A reset with no utilization beside it is an explicit error timestamp and
/// is accepted. A full rate-limit snapshot, however, often includes reset
/// times for every window; only the exhausted ones may delay this task.
fn window_is_exhausted(object: &serde_json::Map<String, Value>) -> bool {
    if let Some(percent) = object.get("used_percent").and_then(Value::as_f64) {
        return percent >= 99.9;
    }
    if let Some(utilization) = object.get("utilization").and_then(Value::as_f64) {
        return if utilization <= 1.0 {
            utilization >= 0.999
        } else {
            utilization >= 99.9
        };
    }
    true
}

/// A standalone rate-limit event is useful only when it says the request was
/// actually blocked. Allowed/warning snapshots must not arm a future retry for
/// an unrelated failure later in the turn.
pub(crate) fn blocked_reset_from_event(event: &Value) -> Option<i64> {
    if event.get("type").and_then(Value::as_str) != Some("rate_limit_event") {
        return None;
    }
    let info = event.get("rate_limit_info")?;
    let status = info
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let blocked = ["rejected", "blocked", "denied", "exceeded"]
        .iter()
        .any(|word| status.contains(word))
        || info
            .get("utilization")
            .and_then(Value::as_f64)
            .is_some_and(|used| used >= 1.0);
    blocked
        // Claude's blocking snapshot carries the relevant reset directly.
        // Its status is authoritative even if utilization is absent/rounded.
        .then(|| info.as_object().and_then(direct_reset_at))
        .flatten()
}

pub(crate) fn announce_scheduled(entry: &ScheduledResume) {
    record_chat_event(
        &entry.chat_key,
        json!({
            "type": "octiq_auto_resume_scheduled",
            "id": entry.id,
            "agent": entry.agent().id(),
            "reset_at": entry.reset_at,
            "run_at": entry.run_at,
        }),
    );
}

pub(crate) fn announce_cancelled(entry: &ScheduledResume, reason: &str) {
    record_chat_event(
        &entry.chat_key,
        json!({
            "type": "octiq_auto_resume_cancelled",
            "id": entry.id,
            "reason": reason,
        }),
    );
}

pub(crate) fn announce_started(entry: &ScheduledResume) {
    record_chat_event(
        &entry.chat_key,
        json!({
            "type": "octiq_auto_resume_started",
            "id": entry.id,
            "started_at": unix_now(),
        }),
    );
}

pub(crate) fn announce_failed(entry: &ScheduledResume, message: &str) {
    record_chat_event(
        &entry.chat_key,
        json!({
            "type": "octiq_auto_resume_failed",
            "id": entry.id,
            "message": message,
        }),
    );
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or("Auto-resumes have no storage directory")?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let temp = dir.join(format!(".auto-resumes-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    fs::rename(temp, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(agent: AgentKind) -> StartContext {
        StartContext::for_test(agent, Some("native-session"))
    }

    #[test]
    fn recognises_quota_failures_without_treating_other_limits_as_account_quota() {
        let claude = json!({
            "type":"result",
            "is_error":true,
            "result":"You've hit your session limit",
            "quotaLimits":{"status":"rejected", "resetsAt":2_000}
        });
        assert!(is_quota_failure(AgentKind::Claude, &claude));
        assert_eq!(reset_at_in(&claude), Some(2_000));
        assert!(is_quota_failure(
            AgentKind::Codex,
            &json!({"type":"turn.failed", "error":{"message":"rate_limit_exceeded"}})
        ));
        assert!(!is_quota_failure(
            AgentKind::Codex,
            &json!({"type":"turn.failed", "error":{"message":"agent thread limit reached"}})
        ));
        assert!(!is_quota_failure(
            AgentKind::Claude,
            &json!({"type":"result", "is_error":false, "result":"usage limit"})
        ));
    }

    #[test]
    fn accepts_only_blocking_rate_limit_snapshots() {
        let allowed = json!({"type":"rate_limit_event", "rate_limit_info":{
            "status":"allowed_warning", "resetsAt":200, "utilization":0.75
        }});
        let blocked = json!({"type":"rate_limit_event", "rate_limit_info":{
            "status":"rejected", "resetsAt":201
        }});
        assert_eq!(blocked_reset_from_event(&allowed), None);
        assert_eq!(blocked_reset_from_event(&blocked), Some(201));
        assert_eq!(reset_at_in(&json!({"error":{"reset_at":202}})), Some(202));
        assert_eq!(
            reset_at_in(&json!({"rate_limits":{
                "primary":{"resets_at":203},
                "secondary":{"resetsAt":204}
            }})),
            Some(204)
        );
        assert_eq!(
            reset_at_in(&json!({"rate_limits":{
                "primary":{"used_percent":100.0, "resets_at":205},
                "secondary":{"used_percent":27.0, "resets_at":999}
            }})),
            Some(205)
        );
    }

    #[test]
    fn one_chat_gets_one_durable_one_shot_per_reset() {
        let dir =
            std::env::temp_dir().join(format!("octiq-auto-resume-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("auto-resumes.json");
        let store = Store::load(path.clone());
        let first = store
            .schedule("chat:one", 2_000, start(AgentKind::Codex), 1_000)
            .unwrap()
            .unwrap();
        assert_eq!(first.run_at, 2_000 + RESET_GRACE_SECONDS);
        assert!(store
            .schedule("chat:one", 2_000, start(AgentKind::Codex), 1_001)
            .unwrap()
            .is_none());
        assert!(store.claim_due(first.run_at - 1).unwrap().is_empty());
        let due = store.claim_due(first.run_at).unwrap();
        assert_eq!(due.len(), 1);

        // Dispatching survives a reload but is never claimed a second time.
        let reloaded = Store::load(path);
        assert!(reloaded.claim_due(first.run_at + 1).unwrap().is_empty());
        assert_eq!(reloaded.take_uncertain().unwrap().len(), 1);
    }

    #[test]
    fn manual_cancel_marks_only_not_yet_dispatched_work() {
        let store = Store::default();
        let entry = store
            .schedule("chat:one", 2_000, start(AgentKind::Claude), 1_000)
            .unwrap()
            .unwrap();
        let cancelled = store.cancel("chat:one").unwrap().unwrap();
        assert_eq!(cancelled.id, entry.id);
        assert!(store.cancel("chat:one").unwrap().is_none());
        assert_eq!(store.cancelled().unwrap().len(), 1);
        store.finish(&cancelled).unwrap();

        store
            .schedule("chat:one", 3_000, start(AgentKind::Claude), 1_000)
            .unwrap();
        store.claim_due(3_060).unwrap();
        assert!(store.cancel("chat:one").unwrap().is_none());
    }

    #[test]
    fn a_cancel_tombstone_survives_restart_and_can_never_be_claimed() {
        let dir =
            std::env::temp_dir().join(format!("octiq-auto-cancel-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("auto-resumes.json");
        let store = Store::load(path.clone());
        store
            .schedule("chat:one", 2_000, start(AgentKind::Claude), 1_000)
            .unwrap();
        store.cancel("chat:one").unwrap().unwrap();

        let reloaded = Store::load(path);
        assert_eq!(reloaded.cancelled().unwrap().len(), 1);
        assert!(reloaded.claim_due(3_000).unwrap().is_empty());
    }
}

//! One fresh same-provider retry only after Claude explicitly rejects a native
//! session before accepting any input. Never infer this from quota/auth errors.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

pub(super) struct Fence {
    epoch: Arc<AtomicU64>,
    expected: u64,
}
impl Fence {
    pub(super) fn after_own_launch(&mut self) {
        // Exactly one invalidation belongs to grant_capability. Never absorb
        // an intervening Stop by re-reading and blessing its newer epoch.
        self.expected = self.expected.wrapping_add(1);
    }
    pub(super) fn check(&self) -> Result<(), String> {
        if self.epoch.load(Ordering::SeqCst) != self.expected {
            return Err("Native session recovery was cancelled by Stop or a newer turn.".into());
        }
        Ok(())
    }
}

pub(super) struct Request {
    start: StartContext,
    text: String,
    images: Vec<String>,
    turn_id: String,
    fence: Fence,
    accepted: Arc<AtomicBool>,
    missing: Arc<AtomicBool>,
}

pub(super) fn missing_session(text: &str) -> bool {
    text.to_ascii_lowercase()
        .contains("no conversation found with session id")
}

impl Request {
    pub(super) fn new(
        manager: &ChatManager,
        key: &str,
        start: StartContext,
        text: String,
        images: Vec<String>,
        turn_id: String,
    ) -> Self {
        let epoch = manager.stop_epoch(key);
        let expected = epoch.load(Ordering::SeqCst);
        Self {
            start,
            text,
            images,
            turn_id,
            fence: Fence { epoch, expected },
            accepted: Arc::new(AtomicBool::new(false)),
            missing: Arc::new(AtomicBool::new(false)),
        }
    }
    pub(super) fn arm(&mut self) {
        // grant_capability invalidates the previous launch under the same
        // sessions lock. Account for exactly that one invalidation.
        self.fence.after_own_launch();
    }
    pub(super) fn observation(&self) -> Observation {
        Observation {
            accepted: self.accepted.clone(),
            missing: self.missing.clone(),
        }
    }
    pub(super) fn eligible(&self, code: Option<i32>, drained: bool) -> bool {
        drained
            && code.is_some_and(|code| code != 0)
            && self.fence.check().is_ok()
            && self.missing.load(Ordering::SeqCst)
            && !self.accepted.load(Ordering::SeqCst)
    }
    pub(super) fn run(self, manager: Arc<ChatManager>, key: &str) -> Result<(), String> {
        self.fence.check()?;
        if !manager.running_background(key).is_empty() {
            return Err(
                "Inspect running background work before recovering the native session".into(),
            );
        }
        // A worker's session recovery belongs to its reservation/retry door.
        // This path is only for an ordinary host conversation, preserving every
        // setting and the same user turn identity. The rejected launch did no work.
        let history = provider_history(key)?;
        let prompt = model_handoff_prompt(&history, &self.text);
        let mut saved = self.start.clone();
        saved.session_id = None; // This also makes the retry intrinsically one-shot.
        provider_switch::prepare_runtime_change(
            key,
            &self.start.settings(),
            &saved.settings(),
            "Claude native session unavailable; one fresh same-provider recovery",
            self.start.session_id.as_deref(),
        )?;
        start_session_with_recovery(
            manager.clone(),
            Voice::host(key.into()),
            saved.cwd.clone(),
            saved.agent,
            saved.model.clone(),
            saved.access,
            Some(prompt),
            None,
            saved.extra_dirs.clone(),
            saved.env.clone(),
            saved.effort.clone(),
            Some(self.images),
            saved.lite,
            Some(self.turn_id),
            false,
            Some(self.text),
            Some(self.fence),
        )?;
        if let Err(why) = provider_switch::announce_runtime_change(&manager, key, &self.start.settings(), &saved.settings(),
            "octiq_native_session_recovered", "Claude could not open this native session. Continued once in a fresh Claude session with this chat's exact model, effort, access and bounded transcript. Earlier transcript remains available.", self.start.session_id.as_deref()) {
            emit_status(ChatAgent::Claude, ChatStatus { key: key.into(), kind: "error".into(),
                text: format!("Claude session recovered, but its receipt could not be saved: {why}"), code: None });
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(super) struct Observation {
    accepted: Arc<AtomicBool>,
    missing: Arc<AtomicBool>,
}
impl Observation {
    pub(super) fn stderr(&self, text: &str) {
        if missing_session(text) {
            self.missing.store(true, Ordering::SeqCst);
        }
    }
    pub(super) fn event(&self, event: &Value) {
        if event["type"] == "result"
            && event["is_error"] == true
            && event["result"].as_str().is_some_and(missing_session)
        {
            self.missing.store(true, Ordering::SeqCst);
        } else if matches!(
            event["type"].as_str(),
            Some("system" | "user" | "assistant" | "stream_event" | "result")
        ) {
            self.accepted.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_missing_session_before_acceptance_allows_one_retry() {
        let manager = ChatManager::default();
        let request = Request::new(
            &manager,
            "chat:recovery-test",
            StartContext::for_test(ChatAgent::Claude, Some("old")),
            "Keep going".into(),
            vec![],
            "same-turn".into(),
        );
        let observation = request.observation();
        observation.stderr("You've hit your session limit");
        assert!(!request.eligible(Some(1), true));
        observation.stderr("No conversation found with session ID: old");
        assert!(!request.eligible(Some(0), true));
        assert!(!request.eligible(Some(1), false));
        assert!(request.eligible(Some(1), true));
        observation.event(&json!({"type":"assistant", "message":{"content":"work started"}}));
        assert!(!request.eligible(Some(1), true));
    }
    #[test]
    fn arming_counts_only_the_launch_invalidation_and_cannot_absorb_stop() {
        let manager = ChatManager::default();
        let mut request = Request::new(
            &manager,
            "chat:recovery-arm",
            StartContext::for_test(ChatAgent::Claude, Some("old")),
            "Keep going".into(),
            vec![],
            "same-turn".into(),
        );
        request
            .observation()
            .stderr("No conversation found with session ID: old");
        manager.revoke_auto_plan("chat:recovery-arm"); // own grant_capability
        request.arm();
        assert!(request.eligible(Some(1), true));
        let mut stopped = Request::new(
            &manager,
            "chat:recovery-arm",
            StartContext::for_test(ChatAgent::Claude, Some("old")),
            "Keep going".into(),
            vec![],
            "same-turn".into(),
        );
        stopped
            .observation()
            .stderr("No conversation found with session ID: old");
        manager.revoke_auto_plan("chat:recovery-arm"); // own grant_capability
        manager.revoke_auto_plan("chat:recovery-arm"); // concurrent Stop
        stopped.arm();
        assert!(!stopped.eligible(Some(1), true));
    }

    #[test]
    fn stop_vetoes_recovery_even_after_missing_session_evidence() {
        let manager = ChatManager::default();
        let request = Request::new(
            &manager,
            "chat:recovery-stop",
            StartContext::for_test(ChatAgent::Claude, Some("old")),
            "Keep going".into(),
            vec![],
            "same-turn".into(),
        );
        request
            .observation()
            .stderr("No conversation found with session ID: old");
        manager.revoke_auto_plan("chat:recovery-stop");
        assert!(!request.eligible(Some(1), true));
    }
}

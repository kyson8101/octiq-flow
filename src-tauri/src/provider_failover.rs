//! Account-limit routing. An agent's identity and defaults stay unchanged;
//! only a launch's runtime settings are mapped to an independent provider.
use crate::agent_provider::{provider_for, Access, AgentKind};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Settings {
    pub agent: AgentKind,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access: Access,
}

fn account(agent: AgentKind) -> &'static str {
    // Pi's configured upstream is OpenAI Codex, not another allowance.
    if agent == AgentKind::Pi {
        "codex"
    } else {
        agent.id()
    }
}

#[derive(Default)]
pub(crate) struct State(Mutex<BTreeMap<String, i64>>);

impl State {
    pub(crate) fn limited(&self, agent: AgentKind, reset: Option<i64>, now: i64) {
        let until = reset.filter(|at| *at > now).unwrap_or(now + 15 * 60);
        let mut blocked = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let entry = blocked.entry(account(agent).into()).or_default();
        *entry = (*entry).max(until);
    }

    pub(crate) fn blocked(&self, agent: AgentKind, now: i64) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(account(agent))
            .is_some_and(|until| *until > now)
    }

    pub(crate) fn alternative(&self, source: &Settings, now: i64) -> Option<Settings> {
        self.alternative_using(source, source, now)
    }

    pub(crate) fn alternative_using(
        &self,
        source: &Settings,
        defaults: &Settings,
        now: i64,
    ) -> Option<Settings> {
        if !self.blocked(source.agent, now) {
            return None;
        }
        let installed = crate::agents::agent_installs(None);
        self.choose_using(source, defaults, now, |agent| {
            installed
                .iter()
                .any(|row| row.id == agent.id() && row.installed)
        })
    }

    #[cfg(test)]
    fn choose(
        &self,
        source: &Settings,
        now: i64,
        installed: impl Fn(AgentKind) -> bool,
    ) -> Option<Settings> {
        self.choose_using(source, source, now, installed)
    }

    fn choose_using(
        &self,
        source: &Settings,
        defaults: &Settings,
        now: i64,
        installed: impl Fn(AgentKind) -> bool,
    ) -> Option<Settings> {
        [
            defaults.agent,
            AgentKind::Claude,
            AgentKind::Codex,
            AgentKind::Antigravity,
        ]
        .into_iter()
        .filter(|target| account(*target) != account(source.agent))
        .filter(|target| !self.blocked(*target, now) && installed(*target))
        .find_map(|target| equivalent_using(source, defaults, target))
    }
}

pub(crate) fn equivalent_using(
    current: &Settings,
    defaults: &Settings,
    target: AgentKind,
) -> Option<Settings> {
    if account(current.agent) == account(target) {
        return None;
    }
    if target == AgentKind::Antigravity && matches!(current.access, Access::Auto | Access::Manual) {
        return None;
    }
    if target == AgentKind::Pi && !matches!(current.access, Access::Read | Access::Full) {
        return None;
    }
    let mut baseline = defaults.clone();
    baseline.access = current.access;
    if target == baseline.agent {
        Some(baseline)
    } else {
        equivalent(&baseline, target)
    }
}

/// Capability tiers, not a claim that different models give identical results.
/// Versioned Codex choices are the same bundled choices as the model picker.
pub(crate) fn equivalent(source: &Settings, target: AgentKind) -> Option<Settings> {
    if target == AgentKind::Pi || account(source.agent) == account(target) {
        return None;
    }
    // Headless Antigravity cannot ask: Auto there bypasses every guard.
    // Never turn a guarded launch into unguarded access during failover.
    if target == AgentKind::Antigravity && matches!(source.access, Access::Auto | Access::Manual) {
        return None;
    }
    let model = source.model.as_deref().unwrap_or("").to_ascii_lowercase();
    let tier = if model.contains("astra") || model.contains("fable") {
        3
    } else if model.contains("haiku") || model.contains("luna") || model.contains("flash") {
        0
    } else if model.contains("sonnet") || model.contains("terra") {
        1
    } else {
        2
    };
    let native_effort = if source.agent == AgentKind::Antigravity {
        ["low", "medium", "high"]
            .into_iter()
            .find(|level| model.ends_with(&format!("-{level}")))
    } else {
        None
    };
    let requested_effort = source
        .effort
        .as_deref()
        .filter(|effort| *effort != "auto")
        .or(native_effort);
    let effort = match requested_effort {
        Some("minimal") => Some("low"),
        Some("ultracode" | "ultra") => Some("max"),
        Some("auto") | None => None,
        Some(value) => provider_for(target).effort(value),
    }
    .map(str::to_string);
    let model = match target {
        AgentKind::Claude => ["haiku", "sonnet", "opus", "fable"][tier],
        AgentKind::Codex => [
            "gpt-5.6-luna",
            "gpt-5.6-terra",
            "gpt-5.6-sol",
            "gpt-6-astra",
        ][tier],
        AgentKind::Antigravity => {
            if tier == 0 {
                match effort.as_deref() {
                    Some("low") => "gemini-3.8-flash-low",
                    Some("medium") => "gemini-3.8-flash-medium",
                    _ => "gemini-3.8-flash-high",
                }
            } else if effort.as_deref() == Some("low") {
                "gemini-3.1-pro-low"
            } else {
                "gemini-3.1-pro-high"
            }
        }
        AgentKind::Pi => return None,
    };
    Some(Settings {
        agent: target,
        model: Some(model.into()),
        effort: if target == AgentKind::Antigravity {
            None
        } else {
            effort
        },
        access: source.access,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_effort_encoded_in_the_model_is_mapped_to_the_next_provider() {
        for level in ["low", "medium", "high"] {
            let source = Settings {
                agent: AgentKind::Antigravity,
                model: Some(format!("gemini-3.8-flash-{level}")),
                effort: None,
                access: Access::Read,
            };
            assert_eq!(
                equivalent(&source, AgentKind::Claude)
                    .unwrap()
                    .effort
                    .as_deref(),
                Some(level)
            );
        }
    }

    #[test]
    fn returning_to_the_default_preserves_its_exact_model_and_current_permission() {
        let state = State::default();
        let defaults = Settings {
            agent: AgentKind::Codex,
            model: Some("gpt-6.1-sol".into()),
            effort: Some("xhigh".into()),
            access: Access::Auto,
        };
        let current = Settings {
            agent: AgentKind::Claude,
            model: Some("opus".into()),
            effort: Some("xhigh".into()),
            access: Access::Manual,
        };
        state.limited(AgentKind::Claude, Some(900), 100);
        let next = state
            .choose_using(&current, &defaults, 101, |_| true)
            .unwrap();
        assert_eq!(next.model, defaults.model);
        assert_eq!(next.effort, defaults.effort);
        assert_eq!(next.access, Access::Manual);
    }
    #[test]
    fn per_task_effort_survives_provider_failover_with_native_alias_mapping() {
        for (chosen, expected) in [
            ("low", "low"),
            ("high", "high"),
            ("xhigh", "xhigh"),
            ("minimal", "low"),
            ("ultra", "max"),
            ("ultracode", "max"),
        ] {
            let source = Settings {
                agent: AgentKind::Codex,
                model: Some("gpt-5.6-sol".into()),
                effort: Some(chosen.into()),
                access: Access::Read,
            };
            let next = equivalent(&source, AgentKind::Claude).unwrap();
            assert_eq!(next.effort.as_deref(), Some(expected));
            assert_eq!(next.access, source.access);
        }
    }

    #[test]
    fn maps_default_tiers_effort_and_access_without_escalation() {
        for (model, mapped) in [
            ("opus", "gpt-5.6-sol"),
            ("sonnet", "gpt-5.6-terra"),
            ("haiku", "gpt-5.6-luna"),
            ("fable", "gpt-6-astra"),
        ] {
            for access in Access::ALL_FOR_TESTS {
                let source = Settings {
                    agent: AgentKind::Claude,
                    model: Some(model.into()),
                    effort: Some("xhigh".into()),
                    access,
                };
                let next = equivalent(&source, AgentKind::Codex).unwrap();
                assert_eq!(next.model.as_deref(), Some(mapped));
                assert_eq!(next.effort.as_deref(), Some("xhigh"));
                assert_eq!(next.access, access);
                assert_eq!(
                    equivalent(&next, AgentKind::Claude).unwrap().model,
                    source.model
                );
                assert_eq!(
                    equivalent(&source, AgentKind::Antigravity).is_none(),
                    matches!(access, Access::Auto | Access::Manual)
                );
            }
        }
    }

    #[test]
    fn shares_account_exhaustion_skips_missing_and_stops_at_all_limits() {
        let state = State::default();
        let source = Settings {
            agent: AgentKind::Codex,
            model: Some("gpt-6.1-sol".into()),
            effort: Some("max".into()),
            access: Access::Auto,
        };
        state.limited(AgentKind::Pi, Some(500), 100);
        assert!(state.blocked(AgentKind::Codex, 101));
        assert_eq!(
            state.choose(&source, 101, |_| true).unwrap().agent,
            AgentKind::Claude
        );
        assert!(state.choose(&source, 101, |_| false).is_none());
        state.limited(AgentKind::Claude, Some(600), 100);
        assert!(state.choose(&source, 101, |_| true).is_none());
        assert!(!state.blocked(AgentKind::Codex, 501));
    }
}

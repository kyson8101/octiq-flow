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

/// Whose allowance a launch spends. Pi is a harness: what it bills is its
/// upstream's. OpenAI Codex through Pi is the same ChatGPT allowance Codex's
/// own CLI spends, so the two share one entry; Anthropic through Pi is an API
/// key, with no weekly window and nothing to do with the Claude subscription
/// Claude Code spends, so it is an account of its own.
pub(crate) fn account_of(agent: AgentKind, model: Option<&str>) -> String {
    if agent != AgentKind::Pi {
        return agent.id().to_string();
    }
    match crate::agent_provider::pi_upstream(model).as_str() {
        crate::agent_provider::PI_DEFAULT_UPSTREAM => "codex".to_string(),
        upstream => format!("pi-{upstream}"),
    }
}

fn account(settings: &Settings) -> String {
    account_of(settings.agent, settings.model.as_deref())
}

#[derive(Default)]
pub(crate) struct State(Mutex<BTreeMap<String, i64>>);

impl State {
    /// `model` names Pi's upstream (`account_of`); every other provider has
    /// one account whatever its model.
    pub(crate) fn limited(
        &self,
        agent: AgentKind,
        model: Option<&str>,
        reset: Option<i64>,
        now: i64,
    ) {
        let until = reset.filter(|at| *at > now).unwrap_or(now + 15 * 60);
        let mut blocked = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let entry = blocked.entry(account_of(agent, model)).or_default();
        *entry = (*entry).max(until);
    }

    pub(crate) fn blocked(&self, agent: AgentKind, model: Option<&str>, now: i64) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&account_of(agent, model))
            .is_some_and(|until| *until > now)
    }

    pub(crate) fn alternative(&self, source: &Settings, now: i64) -> Option<Settings> {
        self.alternative_using(source, source, now)
    }

    /// The first installed, access-compatible account that can run again.
    /// Unknown resets were assigned the 15-minute default by `limited`.
    pub(crate) fn next_reset(&self, source: &Settings, now: i64) -> i64 {
        let installed = crate::agents::agent_installs(None);
        self.next_reset_using(source, now, |agent| {
            installed
                .iter()
                .any(|row| row.id == agent.id() && row.installed)
        })
    }

    fn next_reset_using(
        &self,
        source: &Settings,
        now: i64,
        installed: impl Fn(AgentKind) -> bool,
    ) -> i64 {
        let blocked = self.0.lock().unwrap_or_else(|e| e.into_inner());
        std::iter::once(source.clone())
            .chain(
                [
                    AgentKind::Claude,
                    AgentKind::Codex,
                    AgentKind::Antigravity,
                    AgentKind::Pi,
                ]
                .into_iter()
                .filter(|agent| installed(*agent))
                .filter_map(|agent| equivalent(source, agent)),
            )
            .filter_map(|settings| blocked.get(&account(&settings)).copied())
            .filter(|until| *until > now)
            .min()
            .unwrap_or(now + 15 * 60)
    }

    pub(crate) fn alternative_using(
        &self,
        source: &Settings,
        defaults: &Settings,
        now: i64,
    ) -> Option<Settings> {
        if !self.blocked(source.agent, source.model.as_deref(), now) {
            return None;
        }
        self.unavailable_alternative_using(source, defaults, now)
    }

    pub(crate) fn unavailable_alternative_using(
        &self,
        source: &Settings,
        defaults: &Settings,
        now: i64,
    ) -> Option<Settings> {
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
        // The order is the person's default first, then the subscriptions, and
        // Pi last: it is the one that bills an API key.
        [
            defaults.agent,
            AgentKind::Claude,
            AgentKind::Codex,
            AgentKind::Antigravity,
            AgentKind::Pi,
        ]
        .into_iter()
        .filter(|target| installed(*target))
        .filter_map(|target| equivalent_using(source, defaults, target))
        .find(|target| !self.blocked(target.agent, target.model.as_deref(), now))
    }
}

pub(crate) fn equivalent_using(
    current: &Settings,
    defaults: &Settings,
    target: AgentKind,
) -> Option<Settings> {
    if target == AgentKind::Antigravity && matches!(current.access, Access::Auto | Access::Manual) {
        return None;
    }
    let mut baseline = defaults.clone();
    baseline.access = current.access;
    let next = if target == baseline.agent {
        Some(baseline)
    } else {
        equivalent(&baseline, target)
    }?;
    // The same allowance is no alternative. Asked of what would run, not of
    // the target's name: Pi on Anthropic is not Pi on Codex.
    (account(&next) != account(current)).then_some(next)
}

/// Capability tiers, not a claim that different models give identical results.
/// Versioned Codex choices are the same bundled choices as the model picker.
pub(crate) fn equivalent(source: &Settings, target: AgentKind) -> Option<Settings> {
    // Headless Antigravity cannot ask: Auto there bypasses every guard.
    // Never turn a guarded launch into unguarded access during failover.
    // Pi asks on the normal card through the host gate at every level it
    // takes (Auto runs there as Accept edits, which is narrower, never wider).
    if target == AgentKind::Antigravity && matches!(source.access, Access::Auto | Access::Manual) {
        return None;
    }
    let source_model = source.model.as_deref().unwrap_or("");
    // Pi's models name their upstream; the tier is what comes after it.
    let source_model = source_model.rsplit('/').next().unwrap_or(source_model);
    let model = source_model.to_ascii_lowercase();
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
    let tier_model: String = match target {
        AgentKind::Claude => ["haiku", "sonnet", "opus", "fable"][tier].into(),
        AgentKind::Codex => [
            "gpt-5.6-luna",
            "gpt-5.6-terra",
            "gpt-5.6-sol",
            "gpt-6-astra",
        ][tier]
            .into(),
        AgentKind::Antigravity => if tier == 0 {
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
        .into(),
        // Claude through Pi is the Anthropic API: the same Claude model when
        // the source already names one exactly, else the tier's current one.
        AgentKind::Pi => {
            let exact = (source.agent == AgentKind::Claude
                && model.starts_with("claude-")
                && model.len() <= 48)
                .then_some(model.as_str());
            format!(
                "anthropic/{}",
                exact.unwrap_or(
                    [
                        "claude-haiku-5-5",
                        "claude-sonnet-5-5",
                        "claude-opus-5-5",
                        "claude-fable-5-2"
                    ][tier]
                )
            )
        }
    };
    let next = Settings {
        agent: target,
        model: Some(tier_model),
        effort: if target == AgentKind::Antigravity {
            None
        } else {
            effort
        },
        access: source.access,
    };
    // The same allowance is no alternative.
    (account(&next) != account(source)).then_some(next)
}

/// Workers cannot use the ordinary Fable -> Astra tier: Astra only orchestrates.
/// Keep the ordinary chat mapping and the saved source preset unchanged.
pub(crate) fn equivalent_for_worker(source: &Settings, target: AgentKind) -> Option<Settings> {
    let mut settings = equivalent(source, target)?;
    if target == AgentKind::Codex
        && source
            .model
            .as_deref()
            .is_some_and(|model| model.to_ascii_lowercase().contains("fable"))
    {
        settings.model = Some("gpt-5.6-sol".into());
    }
    crate::orchestration::validate_fallback_worker(
        settings.agent,
        settings.model.as_deref().unwrap_or_default(),
    )
    .ok()?;
    Some(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fable_workers_fail_over_to_sol_without_changing_their_registered_preset() {
        for model in ["fable", "claude-fable-5", "CLAUDE-FABLE-5-20260924"] {
            for access in Access::ALL_FOR_TESTS {
                let source = Settings {
                    agent: AgentKind::Claude,
                    model: Some(model.into()),
                    effort: Some("xhigh".into()),
                    access,
                };
                let next = equivalent_for_worker(&source, AgentKind::Codex).unwrap();
                assert_eq!(next.model.as_deref(), Some("gpt-5.6-sol"));
                assert_eq!(next.effort, source.effort);
                assert_eq!(next.access, source.access);
                assert_eq!(
                    equivalent(&source, AgentKind::Codex)
                        .unwrap()
                        .model
                        .as_deref(),
                    Some("gpt-6-astra")
                );
                assert_eq!(
                    equivalent_using(&next, &source, AgentKind::Claude).unwrap(),
                    source
                );
            }
        }
    }

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
        state.limited(AgentKind::Claude, None, Some(900), 100);
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
        // Pi on its default upstream is Codex's own allowance.
        state.limited(AgentKind::Pi, None, Some(500), 100);
        assert!(state.blocked(AgentKind::Codex, None, 101));
        assert!(state.blocked(AgentKind::Pi, Some("gpt-5.6-sol"), 101));
        assert!(state.blocked(AgentKind::Pi, Some("openai-codex/gpt-5.6-sol"), 101));
        assert_eq!(
            state.choose(&source, 101, |_| true).unwrap().agent,
            AgentKind::Claude
        );
        assert!(state.choose(&source, 101, |_| false).is_none());
        state.limited(AgentKind::Claude, None, Some(600), 100);
        // Claude's subscription is out, and Codex's: Claude through Pi's
        // Anthropic API key is the one account left.
        let next = state.choose(&source, 101, |_| true).unwrap();
        assert_eq!(next.agent, AgentKind::Pi);
        assert_eq!(next.model.as_deref(), Some("anthropic/claude-opus-5-5"));
        assert_eq!(next.effort.as_deref(), Some("max"));
        assert_eq!(next.access, Access::Auto, "access is preserved");
        state.limited(
            AgentKind::Pi,
            Some("anthropic/claude-opus-5-5"),
            Some(700),
            100,
        );
        assert!(state.choose(&source, 101, |_| true).is_none());
        assert!(!state.blocked(AgentKind::Codex, None, 501));
    }

    #[test]
    fn pi_on_anthropic_is_its_own_account_and_pi_on_codex_is_codexs() {
        assert_eq!(account_of(AgentKind::Pi, None), "codex");
        assert_eq!(account_of(AgentKind::Pi, Some("gpt-5.6-sol")), "codex");
        assert_eq!(
            account_of(AgentKind::Pi, Some("openai-codex/gpt-6.1-sol")),
            "codex"
        );
        assert_eq!(
            account_of(AgentKind::Pi, Some("anthropic/claude-opus-5-5")),
            "pi-anthropic"
        );
        assert_eq!(
            account_of(AgentKind::Pi, Some("deepseek/deepseek-v4-pro")),
            "pi-deepseek"
        );
        assert_eq!(
            account_of(AgentKind::Claude, Some("anthropic/ignored")),
            "claude"
        );
        // Claude's weekly limit does not touch the API key, and the API
        // key's rate limit does not touch the subscription.
        let state = State::default();
        state.limited(AgentKind::Claude, None, Some(900), 100);
        assert!(!state.blocked(AgentKind::Pi, Some("anthropic/claude-opus-5-5"), 101));
        state.limited(
            AgentKind::Pi,
            Some("anthropic/claude-opus-5-5"),
            Some(950),
            100,
        );
        assert!(state.blocked(AgentKind::Pi, Some("anthropic/claude-sonnet-5-5"), 101));
        assert!(!state.blocked(AgentKind::Codex, None, 101));
    }

    #[test]
    fn a_claude_limited_chat_falls_back_to_the_same_claude_model_on_the_api() {
        for (model, mapped) in [
            ("opus", "anthropic/claude-opus-5-5"),
            ("sonnet", "anthropic/claude-sonnet-5-5"),
            ("haiku", "anthropic/claude-haiku-5-5"),
            ("fable", "anthropic/claude-fable-5-2"),
            // An exact id is the same model, not a tier.
            ("claude-opus-4-6", "anthropic/claude-opus-4-6"),
        ] {
            for access in Access::ALL_FOR_TESTS {
                let source = Settings {
                    agent: AgentKind::Claude,
                    model: Some(model.into()),
                    effort: Some("high".into()),
                    access,
                };
                let next = equivalent(&source, AgentKind::Pi).unwrap();
                assert_eq!(next.model.as_deref(), Some(mapped), "{model}");
                assert_eq!(next.effort.as_deref(), Some("high"));
                // Pi's gate asks on the normal card at every level, so a
                // guarded level stays guarded (Auto runs as Accept edits).
                assert_eq!(next.access, access);
                crate::agent_provider::validate_model(AgentKind::Pi, next.model.as_deref())
                    .unwrap();
                // And back: the Claude tier, never a Pi id on Claude.
                let back = equivalent(&next, AgentKind::Claude).unwrap();
                assert_eq!(back.agent, AgentKind::Claude);
                crate::agent_provider::validate_model(AgentKind::Claude, back.model.as_deref())
                    .unwrap();
            }
        }
        // Codex through Pi is the same allowance as Codex.
        let codex_pi = Settings {
            agent: AgentKind::Pi,
            model: Some("gpt-5.6-sol".into()),
            effort: None,
            access: Access::Edits,
        };
        let codex = Settings {
            agent: AgentKind::Codex,
            ..codex_pi.clone()
        };
        assert!(
            equivalent(&codex, AgentKind::Pi).is_some(),
            "Anthropic is not Codex's allowance"
        );
        assert!(equivalent_using(&codex_pi, &codex_pi, AgentKind::Codex).is_none());
        assert!(equivalent(&codex_pi, AgentKind::Claude).is_some());
    }

    #[test]
    fn the_automatic_order_puts_the_api_last_and_a_policy_backup_can_name_it() {
        let state = State::default();
        let source = Settings {
            agent: AgentKind::Claude,
            model: Some("opus".into()),
            effort: Some("high".into()),
            access: Access::Manual,
        };
        state.limited(AgentKind::Claude, None, Some(900), 100);
        // Codex is next in the order, and wins while it is available.
        assert_eq!(
            state.choose(&source, 101, |_| true).unwrap().agent,
            AgentKind::Codex
        );
        // Antigravity cannot ask at Manual; with Codex out too, the API is it.
        state.limited(AgentKind::Codex, None, Some(900), 100);
        let next = state.choose(&source, 101, |_| true).unwrap();
        assert_eq!(next.agent, AgentKind::Pi);
        assert_eq!(next.access, Access::Manual);
        // The person's own default may be Pi: it is tried first.
        let defaults = Settings {
            agent: AgentKind::Pi,
            model: Some("anthropic/claude-sonnet-5-5".into()),
            effort: Some("low".into()),
            access: Access::Full,
        };
        let state = State::default();
        state.limited(AgentKind::Claude, None, Some(900), 100);
        let next = state
            .choose_using(&source, &defaults, 101, |_| true)
            .unwrap();
        assert_eq!(next.agent, AgentKind::Pi);
        assert_eq!(next.model, defaults.model);
        assert_eq!(
            next.access,
            Access::Manual,
            "the default's own access is not used"
        );
    }
}
#[test]
fn exhausted_accounts_wait_for_the_first_compatible_reset_or_default() {
    let state = State::default();
    let source = Settings {
        agent: AgentKind::Codex,
        model: None,
        effort: None,
        access: Access::Auto,
    };
    state.limited(AgentKind::Codex, None, None, 100);
    state.limited(AgentKind::Claude, None, Some(600), 100);
    state.limited(AgentKind::Antigravity, None, Some(200), 100);
    assert_eq!(state.next_reset_using(&source, 101, |_| true), 600);
    assert_eq!(state.next_reset_using(&source, 101, |_| false), 1000);
    let edits = Settings {
        access: Access::Edits,
        ..source
    };
    assert_eq!(state.next_reset_using(&edits, 101, |_| true), 200);
}

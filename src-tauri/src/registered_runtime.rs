//! Registration is the launch baseline. Browser caches are not fallback consent.
use super::*;
use crate::provider_failover::Settings;

pub(super) struct Selection {
    pub runtime: Settings,
    pub resume: Option<String>,
    pub recovered: bool,
}

fn same_model(a: &Settings, b: &Settings) -> bool {
    a.agent == b.agent && a.model == b.model && a.effort == b.effort
}

/// Registration configures new chats. An existing process owns its settings;
/// only a proven foreign provider/model tuple is refused here.
pub(super) fn require_current(_key: &str, start: &StartContext) -> Result<(), String> {
    crate::agent_provider::validate_model(start.agent, start.model.as_deref()).map_err(|why| {
        format!("{why}. Stop this chat, then send again to recover the invalid provider/model with its existing transcript. No message was sent.")
    })
}

/// A browser can save its optimistic picker before requesting a start. Retain
/// the old tuple before that write so recovery does not erase the bad state's
/// provenance. This is a proposal receipt, never fallback authorization.
pub(super) fn audit_index_change(meta: &crate::chat_index::ChatMeta) -> Result<(), String> {
    let key = format!("chat:{}", meta.id);
    if crate::team::defaults_for_chat(&crate::team::default_path(), &key)?.is_none() {
        return Ok(());
    }
    if let Some(old) = crate::chat_index::find(&meta.id)? {
        if old.model_id != meta.model_id
            || old.session_id != meta.session_id
            || old.effort != meta.effort
        {
            record_chat_event_synced(&key, json!({
                "type":"octiq_registered_index_settings", "previousModelId":old.model_id,
                "previousSessionId":old.session_id, "previousEffort":old.effort,
                "proposedModelId":meta.model_id, "proposedSessionId":meta.session_id, "proposedEffort":meta.effort,
            })).ok_or("The previous registered chat settings could not be saved; the index was not changed.")?;
        }
    }
    Ok(())
}

/// A model reported by a provider never changes its provider. Likewise a native
/// session is usable only by the provider which announced it in this chat.
pub(super) fn select(
    key: &str,
    requested: &Settings,
    preset: &Settings,
    resume: Option<String>,
    remembered: Option<&StartContext>,
) -> Result<Selection, String> {
    let lines = crate::transcript::every_line(key)?;
    let last_change = lines.iter().rev().find(|line| {
        matches!(
            line.event["type"].as_str(),
            Some("octiq_provider_switched" | "octiq_registered_recovered")
        )
    });
    let evidenced = last_change
        .and_then(|line| serde_json::from_value::<Settings>(line.event.clone()).ok())
        .filter(|runtime| {
            crate::agent_provider::validate_model(runtime.agent, runtime.model.as_deref()).is_ok()
        });
    let valid =
        crate::agent_provider::validate_model(requested.agent, requested.model.as_deref()).is_ok();
    let existing = remembered.is_some()
        || !lines.is_empty()
        || key
            .strip_prefix("chat:")
            .map(crate::chat_index::find)
            .transpose()?
            .flatten()
            .is_some();
    // A valid saved chat is not evidence of corruption merely because its
    // registration changed. Unknown native models remain provider-native.
    let allowed = valid && (existing || same_model(requested, preset));
    let wrong_session = resume.as_deref().is_some_and(|id| {
        let known = remembered
            .filter(|start| start.session_id.as_deref() == Some(id))
            .map(|start| start.agent)
            .or_else(|| {
                lines.iter().rev().find_map(|line| {
                    ChatAgent::ALL.into_iter().find(|provider| {
                        provider_for(*provider)
                            .observe_event(&line.event)
                            .session_id
                            == Some(id)
                    })
                })
            });
        known != Some(requested.agent)
    });
    if allowed
        && !wrong_session
        && crate::agent_provider::validate_model(requested.agent, requested.model.as_deref())
            .is_ok()
    {
        return Ok(Selection {
            runtime: requested.clone(),
            resume,
            recovered: false,
        });
    }
    if allowed {
        // A foreign/unverified session cannot migrate this chat's runtime.
        // Keep the valid tuple and recover context in a fresh own session.
        return Ok(Selection {
            runtime: requested.clone(),
            resume: None,
            recovered: true,
        });
    }
    crate::agent_provider::validate_model(preset.agent, preset.model.as_deref())?;
    // Repeated stale browser sends after a successful recovery resume the
    // recovered native session, rather than creating one per stale request.
    let resume = remembered
        .filter(|start| same_model(&start.settings(), preset))
        .and_then(|start| start.session_id.clone())
        .or_else(|| {
            evidenced
                .as_ref()
                .filter(|runtime| same_model(runtime, preset))
                .and_then(|_| {
                    lines.iter().rev().find_map(|line| {
                        provider_for(preset.agent)
                            .observe_event(&line.event)
                            .session_id
                            .map(str::to_string)
                    })
                })
        });
    Ok(Selection {
        runtime: preset.clone(),
        resume,
        recovered: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset() -> Settings {
        Settings {
            agent: ChatAgent::Claude,
            model: Some("claude-opus-5-5".into()),
            effort: Some("high".into()),
            access: Access::Full,
        }
    }
    fn key() -> String {
        format!("chat:registered-runtime-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn registered_opus_start_and_continue_preserve_exact_preset() {
        let key = key();
        let preset = preset();
        let selected = select(&key, &preset, &preset, None, None).unwrap();
        assert_eq!(selected.runtime, preset);
        assert!(!selected.recovered);
        record_chat_event(
            &key,
            json!({"type":"system","subtype":"init","session_id":"claude-own-session"}),
        );
        let selected = select(
            &key,
            &preset,
            &preset,
            Some("claude-own-session".into()),
            None,
        )
        .unwrap();
        assert_eq!(selected.runtime, preset);
        assert_eq!(selected.resume.as_deref(), Some("claude-own-session"));
        assert!(!selected.recovered);
    }

    #[test]
    fn corrupt_codex_opus_restores_roster_and_drops_foreign_session() {
        for model in ["claude-opus-5-5"] {
            let key = key();
            let wrong = Settings {
                agent: ChatAgent::Codex,
                model: Some(model.into()),
                ..preset()
            };
            record_chat_event(
                &key,
                json!({"type":"thread.started","thread_id":"codex-old-session"}),
            );
            let selected = select(
                &key,
                &wrong,
                &preset(),
                Some("codex-old-session".into()),
                None,
            )
            .unwrap();
            assert!(selected.recovered);
            assert_eq!(selected.runtime, preset());
            assert_eq!(selected.resume, None);
            let selected = select(
                &key,
                &preset(),
                &preset(),
                Some("codex-old-session".into()),
                None,
            )
            .unwrap();
            assert!(selected.recovered);
            assert_eq!(selected.resume, None);
        }
    }

    #[test]
    fn recovery_uses_each_chats_registered_identity_in_both_directions() {
        let codex = Settings {
            agent: ChatAgent::Codex,
            model: Some("gpt-6.1-sol".into()),
            ..preset()
        };
        let wrong = Settings {
            model: Some("claude-opus-5-5".into()),
            ..codex.clone()
        };
        let selected = select(
            &key(),
            &wrong,
            &codex,
            Some("unverified-native-session".into()),
            None,
        )
        .unwrap();
        assert_eq!(selected.runtime, codex);
        assert!(selected.recovered);
        assert_eq!(selected.resume, None);
        assert!(!crate::auto_resume::is_quota_failure(
            ChatAgent::Codex,
            &json!({
                "type":"turn.failed", "error":{"message":"claude-opus-5-5 is not supported when using Codex with a ChatGPT account", "code":"model_not_found"}
            })
        ));
    }

    #[test]
    fn valid_existing_runtime_keeps_its_settings_after_registration_changes() {
        let key = key();
        let switched = crate::provider_failover::equivalent(&preset(), ChatAgent::Codex).unwrap();
        let mut event = serde_json::to_value(&switched).unwrap();
        event["type"] = json!("octiq_provider_switched");
        event["from"] = json!("claude");
        record_chat_event_synced(&key, event).unwrap();
        record_chat_event(
            &key,
            json!({"type":"thread.started","thread_id":"codex-new-session"}),
        );
        let selected = select(
            &key,
            &switched,
            &preset(),
            Some("codex-new-session".into()),
            None,
        )
        .unwrap();
        assert_eq!(selected.runtime, switched);
        assert!(!selected.recovered);
        let changed = Settings {
            model: Some("gpt-5.6-luna".into()),
            ..switched
        };
        let kept = select(&key, &changed, &preset(), None, None).unwrap();
        assert_eq!(kept.runtime, changed);
        assert!(!kept.recovered);
        let mut current = StartContext::for_test(ChatAgent::Codex, Some("codex-new-session"));
        current.model = changed.model.clone();
        current.effort = Some("low".into());
        current.access = Some(Access::Read);
        require_current(&key, &current).unwrap();
    }

    #[test]
    fn stale_browser_retry_reuses_the_already_recovered_session() {
        let key = key();
        let wrong = Settings {
            agent: ChatAgent::Codex,
            model: Some("claude-opus-5-5".into()),
            ..preset()
        };
        let mut remembered = StartContext::for_test(ChatAgent::Claude, Some("recovered-session"));
        remembered.model = preset().model;
        remembered.effort = preset().effort;
        let selected = select(
            &key,
            &wrong,
            &preset(),
            Some("wrong-session".into()),
            Some(&remembered),
        )
        .unwrap();
        assert_eq!(selected.resume.as_deref(), Some("recovered-session"));
    }

    #[test]
    fn ask_before_registered_start_saves_original_turn_and_preset_across_reload() {
        let home = crate::test_dir::TestDir::new("registered-ask-start");
        let _pin = crate::profile::started_in(&home);
        let roster = crate::profile::profile_dir().join("team.json");
        let _team = crate::team::use_test_path(roster.clone());
        let agent = crate::team::save(&roster, serde_json::from_value(json!({
            "name":"Registered Opus", "agent":"claude", "model":"claude-opus-5-5", "effort":"high", "access":"full"
        })).unwrap()).unwrap();
        let key = key();
        crate::team::record_lead(&roster, &key, &agent, "workspace", false).unwrap();
        crate::failover_policy::save_rule(
            Some(agent.id.clone()),
            Some(crate::failover_policy::Rule {
                mode: crate::failover_policy::Mode::Ask,
                backup: None,
            }),
        )
        .unwrap();
        let path = home.join("questions.json");
        let manager = Arc::new(ChatManager::with_saved_questions(path.clone()));
        manager
            .failover
            .limited(ChatAgent::Claude, None, crate::auto_resume::unix_now());
        let result = chat_start_user_impl(
            manager.clone(),
            key.clone(),
            home.join("must-not-spawn").to_string_lossy().into_owned(),
            ChatAgent::Claude,
            preset().model,
            Some(Access::Full),
            Some("ORIGINAL_PENDING_REQUEST".into()),
            None,
            None,
            None,
            None,
            preset().effort,
            None,
            None,
            Some("original-turn".into()),
        );
        assert!(result.unwrap_err().contains("provider card"));
        assert!(!manager.has_process(&key));
        let choice_id = manager.auto_resumes.scheduled().unwrap()[0].id.clone();
        let duplicate = chat_start_user_impl(
            manager.clone(),
            key.clone(),
            home.join("must-not-spawn").to_string_lossy().into_owned(),
            ChatAgent::Claude,
            preset().model,
            Some(Access::Full),
            Some("ORIGINAL_PENDING_REQUEST".into()),
            None,
            None,
            None,
            None,
            preset().effort,
            None,
            None,
            Some("original-turn".into()),
        );
        assert!(duplicate.unwrap_err().contains("already saved"));
        assert_eq!(manager.auto_resumes.scheduled().unwrap()[0].id, choice_id);
        let mut invalid = StartContext::for_test(ChatAgent::Codex, Some("foreign"));
        invalid.model = Some("claude-opus-5-5".into());
        assert!(require_current(&key, &invalid)
            .unwrap_err()
            .contains("Stop this chat"));
        let reloaded = ChatManager::with_saved_questions(path);
        let pending = reloaded.auto_resumes.scheduled().unwrap().pop().unwrap();
        assert!(pending.awaiting_choice);
        assert_eq!(pending.start.settings(), preset());
        assert_eq!(
            pending.pending_turn.as_ref().unwrap().text,
            "ORIGINAL_PENDING_REQUEST"
        );
        assert_eq!(
            pending.pending_turn.as_ref().unwrap().turn_id,
            "original-turn"
        );
        let target = pending.fallback.as_ref().unwrap();
        assert_ne!(target.agent, ChatAgent::Claude);
        assert_eq!(target.access, Access::Full);
        crate::agent_provider::validate_model(target.agent, target.model.as_deref()).unwrap();
        assert_eq!(
            crate::team::defaults_for_chat(&roster, &key)
                .unwrap()
                .unwrap()
                .model,
            "claude-opus-5-5"
        );
    }

    #[test]
    fn foreign_model_is_rejected_at_the_common_spawn_door_before_any_process() {
        let manager = Arc::new(ChatManager::default());
        let result = start_session(
            manager.clone(),
            Voice::host(key()),
            "/not-used".into(),
            ChatAgent::Codex,
            preset().model,
            Some(Access::Full),
            Some("Never launch".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            true,
            None,
        );
        assert!(result
            .unwrap_err()
            .contains("does not belong to provider codex"));
        assert!(manager.sessions.lock().unwrap().is_empty());
        let invalid = crate::failover_policy::Selection {
            agent: ChatAgent::Codex,
            model: "claude-opus-5-5".into(),
            effort: Some("high".into()),
        };
        assert!(invalid.settings(&preset()).is_err());
    }
}

pub(super) fn require_installed(agent: ChatAgent) -> Result<(), String> {
    if crate::agents::agent_installs(None)
        .iter()
        .any(|a| a.id == agent.id() && a.installed)
    {
        Ok(())
    } else {
        Err(format!("The configured {} CLI is unavailable. Install/sign in to that provider, or explicitly choose a provider fallback. The registered model was kept; no other provider was started.", agent.id()))
    }
}

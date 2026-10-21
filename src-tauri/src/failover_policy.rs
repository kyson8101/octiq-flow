//! Browser-owned quota preferences and worker choices. Agents cannot write these.
use crate::agent_provider::{provider_for, safe_model, AgentKind};
use crate::provider_failover::Settings;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Mutex};

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Mode {
    #[default]
    Auto,
    Ask,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Selection {
    pub agent: AgentKind,
    pub model: String,
    pub effort: Option<String>,
}

impl Selection {
    pub(crate) fn settings(&self, source: &Settings) -> Result<Settings, String> {
        if crate::provider_failover::equivalent_using(source, source, self.agent).is_none() {
            return Err(
                "Choose an independent provider that preserves the current access level.".into(),
            );
        }
        if self.model.trim().is_empty() || safe_model(&self.model).is_none() {
            return Err("Choose a valid, explicit provider-native model.".into());
        }
        if self.agent == AgentKind::Antigravity && self.effort.is_some() {
            return Err(
                "Antigravity effort is included in its model. Choose model default.".into(),
            );
        }
        if self
            .effort
            .as_deref()
            .is_some_and(|e| provider_for(self.agent).effort(e) != Some(e))
        {
            return Err("This provider does not support that effort. Choose a supported effort or model default.".into());
        }
        Ok(Settings {
            agent: self.agent,
            model: Some(self.model.clone()),
            effort: self.effort.clone(),
            access: source.access,
        })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct Rule {
    pub mode: Mode,
    pub backup: Option<Selection>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerChoice {
    pub id: String,
    pub task_id: String,
    pub chat_key: String,
    pub view_key: String,
    pub owner: Option<String>,
    pub label: String,
    pub source: Settings,
    pub selection: Option<Selection>,
    pub cancelled: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct Policy {
    #[serde(default)]
    pub global: Rule,
    #[serde(default)]
    pub agents: BTreeMap<String, Rule>,
    #[serde(default)]
    pub workers: BTreeMap<String, WorkerChoice>,
}

fn path() -> std::path::PathBuf {
    crate::profile::profile_dir().join("provider-failover.json")
}
fn read() -> Result<Policy, String> {
    crate::profile::read(&path(), |e| {
        format!("Cannot read provider fallback preferences: {e}")
    })?
    .map(|bytes| {
        serde_json::from_slice(&bytes)
            .map_err(|e| format!("Cannot read provider fallback preferences: {e}"))
    })
    .transpose()
    .map(Option::unwrap_or_default)
}
fn write(value: &Policy) -> Result<(), String> {
    let path = path();
    let dir = path
        .parent()
        .ok_or("Missing fallback preferences directory")?;
    crate::profile::make_dir(dir)?;
    let tmp = dir.join(format!(".provider-failover-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let result = std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(tmp);
        e.to_string()
    });
    if result.is_ok() {
        crate::bus::emit("provider-fallback-changed", serde_json::json!({}));
    }
    result
}
pub(crate) fn load() -> Result<Policy, String> {
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    read()
}
pub(crate) fn rule(owner: Option<&str>) -> Result<Rule, String> {
    let policy = load()?;
    Ok(owner
        .and_then(|id| policy.agents.get(id))
        .unwrap_or(&policy.global)
        .clone())
}
pub(crate) fn save_rule(owner: Option<String>, rule: Option<Rule>) -> Result<(), String> {
    if let Some(backup) = rule.as_ref().and_then(|r| r.backup.as_ref()) {
        if backup.model.trim().is_empty() || safe_model(&backup.model).is_none() {
            return Err("Choose a valid backup model.".into());
        }
    }
    if let Some(backup) = rule.as_ref().and_then(|r| r.backup.as_ref()) {
        if backup.agent == AgentKind::Pi
            || (backup.agent == AgentKind::Antigravity && backup.effort.is_some())
            || backup
                .effort
                .as_deref()
                .is_some_and(|e| provider_for(backup.agent).effort(e) != Some(e))
        {
            return Err("Choose a supported backup provider and effort. Antigravity effort is included in its model.".into());
        }
    }
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    let mut policy = read()?;
    match owner {
        Some(id) => {
            if let Some(rule) = rule {
                policy.agents.insert(id, rule);
            } else {
                policy.agents.remove(&id);
            }
        }
        None => policy.global = rule.ok_or("The global policy cannot inherit another policy.")?,
    }
    write(&policy)
}

pub(crate) fn owner(key: &str) -> Result<Option<String>, String> {
    Ok(crate::team::defaults_for_chat(&crate::team::default_path(), key)?.map(|a| a.id))
}

pub(crate) fn available(
    state: &crate::provider_failover::State,
    selection: &Selection,
    source: &Settings,
) -> Result<Settings, String> {
    let target = selection.settings(source)?;
    if state.blocked(target.agent, crate::auto_resume::unix_now()) {
        return Err("The selected provider is still at its limit.".into());
    }
    if !crate::agents::agent_installs(None)
        .iter()
        .any(|a| a.id == target.agent.id() && a.installed)
    {
        return Err("The selected provider CLI is not installed.".into());
    }
    Ok(target)
}

pub(crate) fn route(
    state: &crate::provider_failover::State,
    source: &Settings,
    defaults: &Settings,
    owner: Option<&str>,
) -> Result<(Rule, Option<Settings>), String> {
    let rule = rule(owner)?;
    let target = rule
        .backup
        .as_ref()
        .and_then(|selection| available(state, selection, source).ok())
        .or_else(|| state.alternative_using(source, defaults, crate::auto_resume::unix_now()));
    Ok((rule, target))
}

/// Called before reservation, so waiting for the person never spends a retry.
pub(crate) fn worker_choice(
    task: &str,
    key: &str,
    view: &str,
    owner: Option<String>,
    label: &str,
    source: &Settings,
) -> Result<Option<Selection>, String> {
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    let mut policy = read()?;
    if let Some(saved) = policy
        .workers
        .get(task)
        .filter(|saved| saved.chat_key == key && saved.source == *source && saved.owner == owner)
    {
        return Ok(if saved.cancelled {
            None
        } else {
            saved.selection.clone()
        });
    }
    policy.workers.insert(
        task.into(),
        WorkerChoice {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: task.into(),
            chat_key: key.into(),
            view_key: view.into(),
            owner,
            label: label.into(),
            source: source.clone(),
            selection: None,
            cancelled: false,
        },
    );
    write(&policy)?;
    Ok(None)
}

pub(crate) fn worker_waits(
    task: &str,
    key: &str,
    source: &Settings,
    owner: Option<&str>,
) -> Result<bool, String> {
    Ok(load()?
        .workers
        .get(task)
        .is_some_and(|c| c.chat_key == key && c.source == *source && c.owner.as_deref() == owner))
}

pub(crate) fn reopen_worker(task: &str) -> Result<(), String> {
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    let mut policy = read()?;
    if let Some(choice) = policy.workers.get_mut(task) {
        choice.id = uuid::Uuid::new_v4().to_string();
        choice.selection = None;
        choice.cancelled = false;
    }
    write(&policy)
}

pub(crate) fn choose_worker(
    id: &str,
    selection: Option<Selection>,
    remember: bool,
) -> Result<(), String> {
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    let mut policy = read()?;
    let choice = policy
        .workers
        .values_mut()
        .find(|c| c.id == id)
        .ok_or("This provider choice is no longer pending.")?;
    if choice.cancelled || choice.selection.is_some() {
        return Err("This provider choice was already answered.".into());
    }
    if let Some(selection) = &selection {
        selection.settings(&choice.source)?;
    }
    choice.cancelled = selection.is_none();
    choice.selection = selection.clone();
    let owner = choice.owner.clone();
    if remember {
        if let Some(selection) = selection {
            let rule = owner
                .as_ref()
                .and_then(|id| policy.agents.get(id))
                .unwrap_or(&policy.global)
                .clone();
            let updated = Rule {
                backup: Some(selection),
                ..rule
            };
            if let Some(id) = owner {
                policy.agents.insert(id, updated);
            } else {
                policy.global = updated;
            }
        }
    }
    write(&policy)
}
pub(crate) fn finish_worker(task: &str) -> Result<(), String> {
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    let mut policy = read()?;
    policy.workers.remove(task);
    write(&policy)
}

fn options(manager: &crate::agent_chat::ChatManager, source: &Settings) -> Vec<serde_json::Value> {
    let installs = crate::agents::agent_installs(None);
    [AgentKind::Claude, AgentKind::Codex, AgentKind::Antigravity].into_iter().filter_map(|agent| {
        let suggestion = crate::provider_failover::equivalent_using(source, source, agent)?;
        let installed = installs.iter().any(|a| a.id == agent.id() && a.installed);
        Some(serde_json::json!({ "agent": agent, "installed": installed, "limited": manager.failover.blocked(agent, crate::auto_resume::unix_now()), "suggestion": suggestion }))
    }).collect()
}

fn current_worker(choice: &WorkerChoice, snapshot: &crate::orchestration::Snapshot) -> bool {
    snapshot.tasks.iter().any(|task| {
        task.id == choice.task_id
            && !matches!(
                task.status,
                crate::orchestration::TaskStatus::Cancelled
                    | crate::orchestration::TaskStatus::Completed
            )
            && task.assignee.as_ref().map(|a| &a.id) == choice.owner.as_ref()
            && task.active_attempt_id.as_ref().map_or(
                choice.chat_key == format!("task:{}", task.id),
                |id| {
                    snapshot
                        .attempts
                        .iter()
                        .any(|a| &a.id == id && a.worker_chat_key == choice.chat_key)
                },
            )
            && snapshot.runs.iter().any(|r| {
                r.id == task.run_id
                    && !matches!(
                        r.status,
                        crate::orchestration::RunStatus::Stopped
                            | crate::orchestration::RunStatus::Closed
                            | crate::orchestration::RunStatus::Completed
                    )
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{agent_provider::Access, test_dir::TestDir};

    fn source() -> Settings {
        Settings {
            agent: AgentKind::Claude,
            model: Some("opus".into()),
            effort: Some("xhigh".into()),
            access: Access::Manual,
        }
    }
    fn selection() -> Selection {
        Selection {
            agent: AgentKind::Codex,
            model: "gpt-5.6-terra".into(),
            effort: Some("low".into()),
        }
    }

    #[test]
    fn preferences_inherit_override_and_preserve_the_unread_file() {
        let home = TestDir::new("failover-policy");
        let _process = crate::profile::started_in(&home);
        save_rule(
            None,
            Some(Rule {
                mode: Mode::Ask,
                backup: None,
            }),
        )
        .unwrap();
        assert_eq!(rule(Some("agent-a")).unwrap().mode, Mode::Ask);
        save_rule(
            Some("agent-a".into()),
            Some(Rule {
                mode: Mode::Auto,
                backup: Some(selection()),
            }),
        )
        .unwrap();
        assert_eq!(rule(Some("agent-a")).unwrap().mode, Mode::Auto);
        assert_eq!(rule(Some("agent-b")).unwrap().mode, Mode::Ask);
        save_rule(Some("agent-a".into()), None).unwrap();
        assert_eq!(rule(Some("agent-a")).unwrap().mode, Mode::Ask);
        std::fs::write(path(), b"broken settings").unwrap();
        assert!(save_rule(None, Some(Rule::default())).is_err());
        assert_eq!(std::fs::read(path()).unwrap(), b"broken settings");
    }

    #[test]
    fn worker_choice_is_durable_scoped_single_use_and_can_save_a_backup() {
        let home = TestDir::new("worker-provider-choice");
        let _process = crate::profile::started_in(&home);
        assert!(worker_choice(
            "task-a",
            "chat:attempt-a",
            "chat:lead",
            Some("agent-a".into()),
            "Work",
            &source()
        )
        .unwrap()
        .is_none());
        let pending = load().unwrap().workers["task-a"].clone();
        assert!(worker_waits("task-a", "chat:attempt-a", &source(), Some("agent-a")).unwrap());
        assert!(!worker_waits("task-a", "chat:attempt-a", &source(), Some("agent-b")).unwrap());
        choose_worker(&pending.id, Some(selection()), true).unwrap();
        assert_eq!(
            worker_choice(
                "task-a",
                "chat:attempt-a",
                "chat:lead",
                Some("agent-a".into()),
                "Work",
                &source()
            )
            .unwrap(),
            Some(selection())
        );
        assert!(choose_worker(&pending.id, Some(selection()), false).is_err());
        assert_eq!(rule(Some("agent-a")).unwrap().backup, Some(selection()));
        assert!(rule(Some("agent-b")).unwrap().backup.is_none());
        // A new attempt cannot inherit a previous attempt's one-time choice.
        assert!(worker_choice(
            "task-a",
            "chat:attempt-b",
            "chat:lead",
            Some("agent-a".into()),
            "Work",
            &source()
        )
        .unwrap()
        .is_none());
        let next = load().unwrap().workers["task-a"].clone();
        choose_worker(&next.id, None, false).unwrap();
        assert!(worker_choice(
            "task-a",
            "chat:attempt-b",
            "chat:lead",
            Some("agent-a".into()),
            "Work",
            &source()
        )
        .unwrap()
        .is_none());
        assert!(load().unwrap().workers["task-a"].cancelled);
        finish_worker("task-a").unwrap();
        assert!(load().unwrap().workers.is_empty());
    }

    #[test]
    fn explicit_selection_preserves_access_and_rejects_incompatible_providers() {
        assert_eq!(
            selection().settings(&source()).unwrap().access,
            Access::Manual
        );
        let mut invalid = selection();
        invalid.agent = AgentKind::Antigravity;
        assert!(invalid.settings(&source()).is_err());
        invalid.agent = AgentKind::Pi;
        assert!(invalid.settings(&source()).is_err());
        invalid = selection();
        invalid.effort = Some("invented".into());
        assert!(invalid.settings(&source()).is_err());
        invalid = selection();
        invalid.agent = AgentKind::Claude;
        assert!(invalid.settings(&source()).is_err());
    }
}

pub(crate) fn choices(
    manager: &crate::agent_chat::ChatManager,
    orchestrations: &crate::orchestration::OrchestrationStore,
    key: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let mut choices = Vec::new();
    for entry in manager
        .auto_resumes
        .scheduled()?
        .into_iter()
        .filter(|e| e.awaiting_choice && e.chat_key == key)
    {
        let source = entry.start.settings();
        choices.push(serde_json::json!({ "id": entry.id, "key": entry.chat_key, "label": "Continue this conversation", "source": source, "preferred": entry.fallback, "rememberLabel": if owner(key)?.is_some() { "Save as this agent’s backup" } else { "Save as global backup" }, "options": options(manager, &source) }));
    }
    let snapshot = orchestrations.snapshot(None)?;
    for choice in load()?.workers.values().filter(|c| {
        !c.cancelled
            && c.selection.is_none()
            && (c.view_key == key || c.chat_key == key)
            && current_worker(c, &snapshot)
    }) {
        choices.push(serde_json::json!({ "id": choice.id, "key": choice.chat_key, "label": choice.label, "worker": true, "source": choice.source, "preferred": rule(choice.owner.as_deref())?.backup.and_then(|b| { crate::orchestration::validate_fallback_worker(b.agent, &b.model).ok()?; b.settings(&choice.source).ok() }), "rememberLabel": if choice.owner.is_some() { "Save as this agent’s backup" } else { "Save as global backup" }, "options": options(manager, &choice.source) }));
    }
    Ok(choices)
}

pub(crate) fn choose(
    manager: &crate::agent_chat::ChatManager,
    orchestrations: &crate::orchestration::OrchestrationStore,
    key: &str,
    id: &str,
    selection: Option<Selection>,
    remember: bool,
) -> Result<(), String> {
    if let Some(entry) = manager
        .auto_resumes
        .scheduled()?
        .into_iter()
        .find(|e| e.chat_key == key && e.id == id && e.awaiting_choice)
    {
        if let Some(selection) = selection {
            let target = available(&manager.failover, &selection, &entry.start.settings())?;
            if remember {
                let owner = owner(key)?;
                let mut rule = rule(owner.as_deref())?;
                rule.backup = Some(selection);
                save_rule(owner, Some(rule))?;
            }
            let saved = manager.auto_resumes.choose_switch(key, id, target)?;
            crate::auto_resume::announce_scheduled(&saved);
        } else {
            crate::agent_chat::chat_cancel_auto_resume_impl(manager, key.into())?;
        }
        return Ok(());
    }
    let saved = load()?
        .workers
        .values()
        .find(|c| c.id == id && c.chat_key == key)
        .cloned()
        .ok_or("This provider choice is no longer pending.")?;
    if !current_worker(&saved, &orchestrations.snapshot(None)?) {
        return Err("The task or its assignee changed. This provider choice has expired.".into());
    }
    if let Some(selection) = &selection {
        available(&manager.failover, selection, &saved.source)?;
        // Workers retain the execution-model restriction, even for a human choice.
        crate::orchestration::validate_fallback_worker(selection.agent, &selection.model)?;
    }
    choose_worker(id, selection, remember)
}

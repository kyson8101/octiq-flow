//! Opt-in host scheduling of the ready wave. Planning can come from an agent,
//! a static workflow, or API calls; dispatch does not depend on an LLM turn.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDefaults {
    /// No provider means the coordinator must choose a worker for each task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<ChatAgent>,
    pub access: Access,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub recovery: Option<execution::RecoveryPolicy>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSettings {
    pub agent: ChatAgent,
    pub access: Access,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub recovery: Option<execution::RecoveryPolicy>,
}

/// Always pass an explicit execution model to the provider. Its configured
/// default could be a coordinator-only model, even when no model was supplied.
pub(super) fn worker_model(agent: ChatAgent, model: Option<&str>) -> Result<String, String> {
    let fallback = match agent {
        ChatAgent::Codex => "gpt-5.6-sol",
        ChatAgent::Claude => "sonnet",
        ChatAgent::Pi => return Err("Choose Claude or Codex for workers.".into()),
    };
    let model = model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback);
    let lower = model.to_ascii_lowercase();
    if lower.contains("fable") || lower.contains("astra") {
        return Err("Fable and Astra are reserved for main agents that orchestrate other agents. Choose an execution model such as Sol, Terra, Luna, Opus, Sonnet, or Haiku.".into());
    }
    if lower == "default" || crate::agent_provider::safe_model(model).is_none() {
        return Err("Choose an explicit provider-native worker model; CLI defaults and invalid model IDs are not allowed.".into());
    }
    Ok(model.to_owned())
}

impl WorkerSettings {
    pub(super) fn normalized(mut self) -> Result<Self, String> {
        self.model = Some(worker_model(self.agent, self.model.as_deref())?);
        if let Some(policy) = &self.recovery {
            policy.validate(self.agent)?;
        }
        Ok(self)
    }
}

impl WorkerDefaults {
    pub fn normalized(mut self) -> Result<Self, String> {
        if let Some(agent) = self.agent {
            self.model = Some(worker_model(agent, self.model.as_deref())?);
            if let Some(policy) = &self.recovery {
                policy.validate(agent)?;
            }
        } else if self.model.is_some() || self.effort.is_some() {
            return Err("Choose a provider with run-wide model settings, or set worker settings on each task.".into());
        }
        if self.agent.is_none() {
            if let Some(policy) = &self.recovery {
                if policy.fallback_model.is_some() {
                    return Err(
                        "Set a fallback model on each task when the run mixes providers.".into(),
                    );
                }
                policy.validate(ChatAgent::Codex)?;
            }
        }
        Ok(self)
    }

    fn settings_for(&self, task: &Task) -> Result<Option<WorkerSettings>, String> {
        let settings = task.worker.clone().or_else(|| {
            self.agent.map(|agent| WorkerSettings {
                agent,
                access: self.access,
                model: self.model.clone(),
                effort: self.effort.clone(),
                recovery: self.recovery.clone(),
            })
        });
        settings.map(WorkerSettings::normalized).transpose()
    }
}

impl OrchestrationStore {
    pub fn configure_automation(
        &self,
        actor: &str,
        run_id: &str,
        defaults: Option<WorkerDefaults>,
    ) -> Result<Run, String> {
        let defaults = defaults.map(WorkerDefaults::normalized).transpose()?;
        self.mutate(|data| {
            let run = coordinator(data, run_id, actor)?;
            if run.status == RunStatus::Stopped {
                return Err("A stopped run cannot dispatch workers.".into());
            }
            let run = data.runs.get_mut(run_id).unwrap();
            run.worker_defaults = defaults;
            run.updated_at = now_ms();
            Ok(run.clone())
        })
        .inspect(|r| announce(&r.id, "automation_configured"))
    }

    pub fn dispatch_ready(
        &self,
        chats: Arc<ChatManager>,
        workspaces: &crate::workspaces::WorkspaceState,
        actor: &str,
        run_id: &str,
    ) -> Result<Vec<Attempt>, String> {
        let snapshot = self.snapshot(Some(run_id))?;
        let run = snapshot.runs.first().ok_or("Run does not exist.")?;
        if run.coordinator_chat_key != actor {
            return Err("Only the coordinator can dispatch this run.".into());
        }
        let defaults = run
            .worker_defaults
            .as_ref()
            .ok_or("Enable automatic dispatch with explicit worker settings first.")?;
        // Let the reporting process finish its tool response/closing turn
        // before a next wave transfers its checkout and stops that process.
        if snapshot.attempts.iter().any(|a| {
            let has_gate = snapshot.gates.iter().any(|g| {
                g.status == GateStatus::Open && g.task_id.as_deref() == Some(a.task_id.as_str())
            });
            let settled = matches!(
                a.status,
                AttemptStatus::Completed | AttemptStatus::Failed | AttemptStatus::Cancelled
            ) || (a.status == AttemptStatus::Blocked && !has_gate);
            settled && chats.turn_in_flight(&a.worker_chat_key)
        }) {
            return Ok(Vec::new());
        }
        let wave = ready_wave(&snapshot, run);
        let mut started = Vec::new();
        for task in wave {
            let Some(settings) = defaults.settings_for(&task)? else {
                continue;
            };
            let launch = WorkerLaunch {
                task_id: task.id,
                agent: settings.agent,
                access: settings.access,
                model: settings.model,
                effort: settings.effort,
                new_worktree: None,
                base_branch: String::new(),
            };
            // Start failures settle their reserved attempt. Other independent
            // ready tasks should still get their chance in the same wave.
            match self.start_worker(chats.clone(), workspaces, actor, launch) {
                Ok(attempt) => started.push(attempt),
                Err(error) => eprintln!("orchestration: worker dispatch failed: {error}"),
            }
        }
        Ok(started)
    }
}

fn ready_wave(snapshot: &Snapshot, run: &Run) -> Vec<Task> {
    if matches!(run.status, RunStatus::Stopped | RunStatus::Completed)
        || run.awaiting_plan_approval()
    {
        return Vec::new();
    }
    // A run-level decision pauses new work. Task gates keep only their own
    // slot; independent tasks may proceed.
    if snapshot
        .gates
        .iter()
        .any(|g| g.status == GateStatus::Open && g.task_id.is_none())
    {
        return Vec::new();
    }
    let active = snapshot
        .attempts
        .iter()
        .filter(|a| {
            matches!(a.status, AttemptStatus::Preparing | AttemptStatus::Running)
                || (a.status == AttemptStatus::Blocked
                    && snapshot.gates.iter().any(|g| {
                        g.status == GateStatus::Open && g.task_id.as_deref() == Some(&a.task_id)
                    }))
        })
        .count();
    snapshot
        .tasks
        .iter()
        .filter(|t| t.status == TaskStatus::Ready)
        // Unassigned legacy tasks must not consume capacity or inherit a CLI
        // default. The coordinator can still dispatch them explicitly.
        .filter(|t| {
            t.worker.is_some()
                || run
                    .worker_defaults
                    .as_ref()
                    .is_none_or(|d| d.agent.is_some())
        })
        .take(usize::from(run.max_concurrent).saturating_sub(active))
        .cloned()
        .collect()
}

pub fn start_scheduler(
    store: Arc<OrchestrationStore>,
    chats: Arc<ChatManager>,
    workspaces: Arc<crate::workspaces::WorkspaceState>,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        if let Err(error) = store.check_services(now_ms()) {
            eprintln!("orchestration: service monitoring failed: {error}");
        }
        if let Err(error) = store.recover_due_workers(chats.clone(), &workspaces, now_ms()) {
            eprintln!("orchestration: worker monitoring failed: {error}");
        }
        if let Err(error) = super::inbox::deliver_pending(&chats, &workspaces) {
            eprintln!("orchestration: notification delivery failed: {error}");
        }
        if let Err(error) = store.propose_missing_workspaces() {
            eprintln!("orchestration: workspace planning failed: {error}");
        }
        let Ok(snapshot) = store.snapshot(None) else {
            continue;
        };
        for run in snapshot.runs.iter().filter(|r| {
            r.worker_defaults.is_some()
                && matches!(
                    r.status,
                    RunStatus::Planning | RunStatus::Running | RunStatus::Waiting
                )
        }) {
            if let Err(error) = store.dispatch_ready(
                chats.clone(),
                &workspaces,
                &run.coordinator_chat_key,
                &run.id,
            ) {
                eprintln!("orchestration: ready-wave scheduling failed: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn automatic() -> WorkerDefaults {
        serde_json::from_value(json!({ "access": "auto" })).unwrap()
    }

    fn selected(agent: ChatAgent, model: &str) -> WorkerSettings {
        WorkerSettings {
            agent,
            model: Some(model.into()),
            effort: Some("high".into()),
            access: Access::Auto,
            recovery: None,
        }
    }

    #[test]
    fn coordinator_models_are_rejected_before_task_or_attempt_mutation() {
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let task = super::super::tests::task(&store, &run, vec![]);
        for model in [
            "fable",
            "claude-fable-5",
            "CLAUDE-FABLE-5-20260924",
            "astra",
            "gpt-6-astra",
            "gpt-6-astra-20260924",
            " codex:astra ",
        ] {
            for agent in [ChatAgent::Claude, ChatAgent::Codex] {
                let settings = selected(agent, model);
                assert!(store
                    .create_task(
                        "chat:master",
                        run.id.clone(),
                        "Task".into(),
                        "Spec".into(),
                        vec![],
                        None,
                        Some(settings.clone())
                    )
                    .unwrap_err()
                    .contains("reserved for main agents"));
                assert!(store
                    .configure_automation(
                        "chat:master",
                        &run.id,
                        Some(WorkerDefaults {
                            agent: Some(agent),
                            model: settings.model.clone(),
                            access: Access::Auto,
                            effort: None,
                            recovery: None,
                        })
                    )
                    .unwrap_err()
                    .contains("reserved for main agents"));
                let launch = WorkerLaunch {
                    task_id: task.id.clone(),
                    agent,
                    model: settings.model,
                    access: Access::Auto,
                    effort: None,
                    new_worktree: None,
                    base_branch: String::new(),
                };
                assert!(store
                    .reserve_attempt("chat:master", &launch)
                    .unwrap_err()
                    .contains("reserved for main agents"));
            }
        }
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert!(snapshot.attempts.is_empty());
        assert_eq!(snapshot.tasks.len(), 1);
        assert_eq!(snapshot.tasks[0].status, TaskStatus::Ready);
        assert!(snapshot.runs[0].worker_defaults.is_none());
    }

    #[test]
    fn missing_models_are_explicit_and_invalid_models_cannot_fall_back_to_cli_defaults() {
        for (agent, expected) in [
            (ChatAgent::Codex, "gpt-5.6-sol"),
            (ChatAgent::Claude, "sonnet"),
        ] {
            for model in [None, Some(""), Some("  ")] {
                assert_eq!(worker_model(agent, model).unwrap(), expected);
            }
            for model in [
                "default",
                "Default",
                "model with spaces",
                "codex:model:gpt-6-astra",
                &"x".repeat(65),
            ] {
                assert!(worker_model(agent, Some(model)).is_err());
            }
        }
        for (agent, model) in [
            (ChatAgent::Codex, "gpt-5.6-sol"),
            (ChatAgent::Codex, "gpt-5.6-terra"),
            (ChatAgent::Codex, "gpt-5.6-luna"),
            (ChatAgent::Claude, "opus"),
            (ChatAgent::Claude, "sonnet"),
            (ChatAgent::Claude, "haiku"),
            (ChatAgent::Claude, "claude-sonnet-4-6"),
        ] {
            assert_eq!(worker_model(agent, Some(model)).unwrap(), model);
        }
        assert!(worker_model(ChatAgent::Pi, None).is_err());
    }

    #[test]
    fn automatic_dispatch_uses_each_tasks_selection_across_dependency_waves() {
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let run = store
            .configure_automation("chat:master", &run.id, Some(automatic()))
            .unwrap();
        assert!(store
            .create_task(
                "chat:master",
                run.id.clone(),
                "Unassigned".into(),
                "Spec".into(),
                vec![],
                None,
                None
            )
            .unwrap_err()
            .contains("Choose a suitable worker"));
        let first = store
            .create_task(
                "chat:master",
                run.id.clone(),
                "Implementation".into(),
                "Spec".into(),
                vec![],
                None,
                Some(selected(ChatAgent::Codex, "gpt-5.6-sol")),
            )
            .unwrap();
        let second = store
            .create_task(
                "chat:master",
                run.id.clone(),
                "Review".into(),
                "Spec".into(),
                vec![first.id.clone()],
                None,
                Some(selected(ChatAgent::Claude, "sonnet")),
            )
            .unwrap();
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let wave = ready_wave(&snapshot, &run);
        assert_eq!(wave.len(), 1);
        assert_eq!(wave[0].id, first.id);
        let settings = run
            .worker_defaults
            .as_ref()
            .unwrap()
            .settings_for(&wave[0])
            .unwrap()
            .unwrap();
        assert_eq!(settings.agent, ChatAgent::Codex);
        assert_eq!(settings.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(settings.effort.as_deref(), Some("high"));
        let (_, _, attempt, _) = store
            .reserve_attempt(
                "chat:master",
                &WorkerLaunch {
                    task_id: first.id,
                    agent: settings.agent,
                    model: settings.model,
                    access: settings.access,
                    effort: settings.effort,
                    new_worktree: None,
                    base_branch: String::new(),
                },
            )
            .unwrap();
        store
            .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), false)
            .unwrap();
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id,
                    outcome: WorkerOutcome::Completed,
                    summary: "Done".into(),
                    files_modified: vec![],
                },
            )
            .unwrap();
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let wave = ready_wave(&snapshot, &snapshot.runs[0]);
        assert_eq!(wave.len(), 1);
        assert_eq!(wave[0].id, second.id);
        let settings = run
            .worker_defaults
            .as_ref()
            .unwrap()
            .settings_for(&wave[0])
            .unwrap()
            .unwrap();
        assert_eq!(settings.agent, ChatAgent::Claude);
        assert_eq!(settings.model.as_deref(), Some("sonnet"));
        // Settings survive persistence and pausing/resuming automation.
        let saved: Task = serde_json::from_value(serde_json::to_value(&wave[0]).unwrap()).unwrap();
        store
            .configure_automation("chat:master", &run.id, None)
            .unwrap();
        let resumed = store
            .configure_automation("chat:master", &run.id, Some(automatic()))
            .unwrap();
        assert_eq!(
            resumed
                .worker_defaults
                .unwrap()
                .settings_for(&saved)
                .unwrap()
                .unwrap()
                .model,
            settings.model
        );
    }

    #[test]
    fn legacy_fallbacks_are_safe_and_unassigned_tasks_do_not_take_capacity() {
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let mut legacy = super::super::tests::task(&store, &run, vec![]);
        let fallback: WorkerDefaults =
            serde_json::from_value(json!({"agent":"codex", "access":"auto"})).unwrap();
        assert_eq!(
            fallback
                .settings_for(&legacy)
                .unwrap()
                .unwrap()
                .model
                .as_deref(),
            Some("gpt-5.6-sol")
        );
        legacy.worker = Some(selected(ChatAgent::Claude, "haiku"));
        assert_eq!(
            fallback
                .settings_for(&legacy)
                .unwrap()
                .unwrap()
                .model
                .as_deref(),
            Some("haiku")
        );
        let run = store
            .configure_automation("chat:master", &run.id, Some(automatic()))
            .unwrap();
        let mut snapshot = store.snapshot(Some(&run.id)).unwrap();
        // Even several unassigned tasks ahead of a selected one cannot starve it.
        snapshot
            .tasks
            .extend([snapshot.tasks[0].clone(), snapshot.tasks[0].clone(), legacy]);
        let wave = ready_wave(&snapshot, &run);
        assert_eq!(wave.len(), 1);
        assert_eq!(
            wave[0].worker.as_ref().unwrap().model.as_deref(),
            Some("haiku")
        );
    }

    #[test]
    fn retries_reject_coordinator_models_and_save_the_new_execution_choice() {
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let first = super::super::tests::running_worker(&store, &run);
        store
            .report_worker(
                &first.worker_chat_key,
                WorkerReport {
                    attempt_id: first.id.clone(),
                    outcome: WorkerOutcome::Blocked,
                    summary: "Needs another approach".into(),
                    files_modified: vec![],
                },
            )
            .unwrap();
        let mut launch = WorkerLaunch {
            task_id: first.task_id,
            agent: ChatAgent::Claude,
            model: Some("fable".into()),
            access: Access::Auto,
            effort: Some("high".into()),
            new_worktree: Some(false),
            base_branch: String::new(),
        };
        assert!(store.reserve_attempt("chat:master", &launch).is_err());
        assert_eq!(store.snapshot(Some(&run.id)).unwrap().attempts.len(), 1);
        launch.model = Some("sonnet".into());
        let (_, task, retry, previous) = store.reserve_attempt("chat:master", &launch).unwrap();
        assert_eq!(retry.number, 2);
        assert_eq!(previous.unwrap().id, first.id);
        assert_eq!(task.worker.unwrap().model, retry.model);
        assert_eq!(retry.agent, ChatAgent::Claude);
    }

    #[test]
    fn scheduler_only_starts_ready_tasks_with_capacity_and_never_retries_failures() {
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let first = super::super::tests::task(&store, &run, vec![]);
        let _dependent = super::super::tests::task(&store, &run, vec![first.id.clone()]);
        let independent = super::super::tests::task(&store, &run, vec![]);
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let wave = ready_wave(&snapshot, &snapshot.runs[0]);
        assert_eq!(wave.len(), 2);
        assert!(wave
            .iter()
            .all(|t| t.id == first.id || t.id == independent.id));
        store
            .mutate(|d| {
                d.tasks.get_mut(&first.id).unwrap().status = TaskStatus::Failed;
                Ok(())
            })
            .unwrap();
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert_eq!(ready_wave(&snapshot, &snapshot.runs[0]).len(), 1);
        store
            .create_gate(
                "chat:master",
                run.id.clone(),
                None,
                "Pause dispatch?".into(),
                vec![],
            )
            .unwrap();
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert!(ready_wave(&snapshot, &snapshot.runs[0]).is_empty());
    }
}

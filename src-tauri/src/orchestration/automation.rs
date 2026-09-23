//! Opt-in host scheduling of the ready wave. Planning can come from an agent,
//! a static workflow, or API calls; dispatch does not depend on an LLM turn.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDefaults {
    pub agent: ChatAgent,
    pub access: Access,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

impl OrchestrationStore {
    pub fn configure_automation(
        &self,
        actor: &str,
        run_id: &str,
        defaults: Option<WorkerDefaults>,
    ) -> Result<Run, String> {
        if defaults.as_ref().is_some_and(|d| d.agent == ChatAgent::Pi) {
            return Err("Choose Claude or Codex for workers.".into());
        }
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
            let launch = WorkerLaunch {
                task_id: task.id,
                agent: defaults.agent,
                access: defaults.access,
                model: defaults.model.clone(),
                effort: defaults.effort.clone(),
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
    if matches!(run.status, RunStatus::Stopped | RunStatus::Completed) {
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
        if let Err(error) = super::inbox::deliver_pending(&chats, &workspaces) {
            eprintln!("orchestration: notification delivery failed: {error}");
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

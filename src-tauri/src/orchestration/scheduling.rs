//! Read-time capacity facts. All counts use the ledger's active definition.
use super::*;
use crate::scheduling::Settings;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotWait {
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub ahead: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

pub(super) fn live(data: &Stored) -> usize {
    data.attempts
        .values()
        .filter(|a| attempt_is_unsettled(data, a))
        .count()
}

pub(super) fn require_host_slot(data: &Stored, cap: Option<u16>) -> Result<(), String> {
    if let Some(limit) = cap {
        let running = live(data);
        if running >= usize::from(limit) {
            return Err(format!(
                "QUEUED_FOR_SLOT host: {running} live workers, limit {limit}."
            ));
        }
    }
    Ok(())
}

pub(super) fn slot_wait(data: &Stored, task: &Task, settings: &Settings) -> Option<SlotWait> {
    let run = data.runs.get(&task.run_id)?;
    if task.status != TaskStatus::Ready
        || task.held_by_plan == Some(true)
        || task.held_by_reopen
        || task.stopped.is_some()
        || task.superseded_by.is_some()
        || task
            .assignee
            .as_ref()
            .is_some_and(|a| data.removed_agents.contains_key(&a.id))
        || matches!(run.status, RunStatus::Stopped | RunStatus::Closed)
    {
        return None;
    }
    let running = live(data);
    settings
        .host_cap
        .filter(|cap| running >= usize::from(*cap))
        .map(|limit| SlotWait {
            reason: "host".into(),
            agent_id: None,
            ahead: 0,
            running: Some(running),
            limit: Some(usize::from(limit)),
        })
}

impl OrchestrationStore {
    pub(super) fn scheduling_changed(&self) {
        let Ok(settings) = crate::scheduling::load() else {
            return;
        };
        let Ok(inner) = self.inner.lock() else {
            return;
        };
        let payload = json!({ "orientation": settings.orientation, "hostCap": settings.host_cap,
            "live": { "total": live(&inner.data) }, "lanes": batches::lanes(&inner.data, None) });
        drop(inner);
        if let Ok(mut last) = self.scheduling_last.lock() {
            if last.as_ref() != Some(&payload) {
                *last = Some(payload.clone());
                crate::bus::emit("scheduling-changed", payload);
            }
        }
    }

    pub fn scheduling_get(&self) -> Result<serde_json::Value, String> {
        let settings = crate::scheduling::load()?;
        // Roster first, ledger second. Never call team while holding inner.
        let agents = crate::team::list(&crate::team::default_path(), None, true)?;
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        Ok(
            json!({ "orientation": settings.orientation, "hostCap": settings.host_cap,
            "live": { "total": live(&inner.data) }, "lanes": batches::lanes(&inner.data, Some(&agents.into_iter().map(|a| a.id).collect())) }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_is_global_in_both_orientations_and_null_keeps_old_behaviour() {
        let store = OrchestrationStore::default();
        let first = super::super::tests::run(&store);
        let task = store
            .create_task(
                "chat:master",
                first.id.clone(),
                "First".into(),
                "work".into(),
                vec![],
                None,
                None,
            )
            .unwrap();
        let launch = WorkerLaunch {
            task_id: task.id,
            agent: ChatAgent::Codex,
            model: None,
            effort: None,
            access: Access::Auto,
            new_worktree: None,
            base_branch: String::new(),
        };
        store.reserve_attempt("chat:master", &launch).unwrap();
        let second = super::super::tests::run(&store);
        let inner = store.inner.lock().unwrap();
        assert_ne!(first.id, second.id);
        for orientation in [
            crate::scheduling::Orientation::Tasks,
            crate::scheduling::Orientation::Agents,
        ] {
            let settings = Settings {
                orientation,
                host_cap: Some(1),
            };
            assert!(require_host_slot(&inner.data, settings.host_cap)
                .unwrap_err()
                .starts_with("QUEUED_FOR_SLOT"));
            assert!(require_host_slot(&inner.data, None).is_ok());
            assert!(require_host_slot(&inner.data, Some(2)).is_ok());
        }
    }
}

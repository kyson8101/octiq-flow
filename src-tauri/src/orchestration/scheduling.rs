//! Capacity includes reservations and processes whose attempts already settled.
use super::*;
use crate::scheduling::Settings;

/// Runtime-only: a server restart owns none of the old server's children.
#[derive(Clone, Debug)]
pub(super) struct ProcessLease {
    pub run_id: String,
    pub launching: bool,
}

/// Declared before the chat's table guard, so every return releases chat
/// locks before ending a resume/relaunch's spawn barrier.
pub(crate) struct WorkerSpawn {
    store: Arc<OrchestrationStore>,
    key: String,
}

impl Drop for WorkerSpawn {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.store.inner.lock() {
            if let Some(lease) = inner.data.worker_processes.get_mut(&self.key) {
                lease.launching = false;
            }
        }
    }
}

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

/// Count launch/process identities, never the number of tasks sharing them.
/// Every started worker retains its lease until the chat reaper confirms exit.
fn worker_keys(data: &Stored, run: Option<&str>, excluding: Option<&str>) -> BTreeSet<String> {
    let excluded_key = excluding
        .and_then(|id| data.batch_launches.get(id))
        .map(|l| l.worker_chat_key.as_str());
    data.attempts
        .values()
        .filter(|a| {
            attempt_is_unsettled(data, a)
                && run.is_none_or(|id| a.run_id == id)
                && a.batch_id.as_deref().is_none_or(|id| Some(id) != excluding)
                && Some(a.worker_chat_key.as_str()) != excluded_key
        })
        .map(|a| a.worker_chat_key.clone())
        .chain(
            data.worker_processes
                .iter()
                .filter(|(key, lease)| {
                    Some(key.as_str()) != excluded_key && run.is_none_or(|id| lease.run_id == id)
                })
                .map(|(key, _)| key.clone()),
        )
        .chain(
            data.batches
                .iter()
                .filter(|b| {
                    Some(b.id.as_str()) != excluding
                        && run.is_none_or(|id| b.run_id == id)
                        && batches::occupies_worker(data, b)
                })
                .map(|b| {
                    data.batch_launches
                        .get(&b.id)
                        .map_or_else(|| b.id.clone(), |l| l.worker_chat_key.clone())
                }),
        )
        .collect()
}

pub(super) fn live(data: &Stored) -> usize {
    worker_keys(data, None, None).len()
}

pub(super) fn run_live(data: &Stored, run: &str, excluding: Option<&str>) -> usize {
    worker_keys(data, Some(run), excluding).len()
}

pub(super) fn require_host_slot(data: &Stored, cap: Option<u16>) -> Result<(), String> {
    require_host_slot_for(data, cap, None)
}

/// A claim may reserve several attempts in its existing worker. Exclude its
/// entire identity, including attempts reserved earlier in this transaction.
pub(super) fn require_host_slot_for(
    data: &Stored,
    cap: Option<u16>,
    claiming: Option<&str>,
) -> Result<(), String> {
    if let Some(limit) = cap {
        let running = worker_keys(data, None, claiming).len();
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
    let running = live(data);
    if data.agent_queue.contains_key(&task.id) && batches::eligible(data, task) {
        if let Some(agent) = &task.assignee {
            let queue = batches::queue(data, &agent.id);
            if let Some(ahead) = queue.iter().position(|t| t.id == task.id) {
                let busy = data
                    .batches
                    .iter()
                    .any(|b| b.agent_id == agent.id && batches::occupies_worker(data, b))
                    || data.attempts.values().any(|a| {
                        a.assignee
                            .as_ref()
                            .is_some_and(|owner| owner.id == agent.id)
                            && attempt_is_unsettled(data, a)
                    });
                if ahead == 0
                    && !busy
                    && settings
                        .host_cap
                        .is_some_and(|cap| require_host_slot(data, Some(cap)).is_err())
                {
                    return Some(SlotWait {
                        reason: "host".into(),
                        agent_id: Some(agent.id.clone()),
                        ahead,
                        running: Some(running),
                        limit: settings.host_cap.map(usize::from),
                    });
                }
                return Some(SlotWait {
                    reason: "agent".into(),
                    agent_id: Some(agent.id.clone()),
                    ahead,
                    running: None,
                    limit: None,
                });
            }
        }
    }
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
    /// The common chat launch door also covers a worker resumed after a
    /// natural one-shot exit. Initial task/batch dispatch already owns its
    /// barrier; that caller alone completes it.
    pub(crate) fn lease_worker_spawn(
        self: &Arc<Self>,
        key: &str,
    ) -> Result<Option<WorkerSpawn>, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner
            .data
            .worker_processes
            .get(key)
            .is_some_and(|l| l.launching)
        {
            return Ok(None);
        }
        let run = inner
            .data
            .attempts
            .values()
            .find(|a| a.worker_chat_key == key)
            .map(|a| a.run_id.clone())
            .or_else(|| {
                inner
                    .data
                    .batches
                    .iter()
                    .find(|b| {
                        inner
                            .data
                            .batch_launches
                            .get(&b.id)
                            .is_some_and(|l| l.worker_chat_key == key)
                    })
                    .map(|b| b.run_id.clone())
            });
        let Some(run_id) = run else {
            return Ok(None);
        };
        inner.data.worker_processes.insert(
            key.into(),
            ProcessLease {
                run_id,
                launching: true,
            },
        );
        Ok(Some(WorkerSpawn {
            store: self.clone(),
            key: key.into(),
        }))
    }

    pub(super) fn scheduling_changed(&self) {
        let Ok(payload) = self.scheduling_get() else {
            return;
        };
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
    fn a_removed_blocked_agents_lane_is_published_without_another_ledger_change() {
        let home = crate::test_dir::TestDir::new("scheduling-roster-event");
        let _profile = crate::profile::started_in(&home);
        let agent = crate::team::save(
            &crate::team::default_path(),
            serde_json::from_value(json!({
                "name": "Fixture worker", "role": "Only fixture work", "agent": "codex",
                "model": "gpt-6.1-sol", "access": "auto"
            }))
            .unwrap(),
        )
        .unwrap();
        let store = OrchestrationStore::default();
        store
            .mutate(|data| {
                data.agent_blocks
                    .insert(agent.id.clone(), "Dirty checkout".into());
                Ok(())
            })
            .unwrap();
        let before = store.scheduling_get().unwrap();
        assert_eq!(before["lanes"][0]["agentId"], agent.id);
        assert_eq!(before["lanes"][0]["state"], "blocked");
        let mut browser = crate::bus::events().subscribe();
        crate::team::delete(&crate::team::default_path(), &agent.id).unwrap();
        store
            .schedule_agent_batches(Arc::new(ChatManager::default()), &WorkspaceState::load())
            .unwrap();
        // No task or batch changed; the tick must still publish the roster's
        // removal, including when this was the last registered agent.
        assert_eq!(
            store.scheduling_last.lock().unwrap().as_ref().unwrap()["lanes"],
            json!([])
        );
        let mut published = false;
        while let Ok(frame) = browser.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
            published |=
                frame["event"] == "scheduling-changed" && frame["payload"]["lanes"] == json!([]);
        }
        assert!(published, "the page must receive the lane's removal");
    }

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

//! Durable notifications. Acknowledgement means provider receipt, not task completion.
use super::*;

pub const RECEIPT_PREFIX: &str = "octiq-notification-";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Pending,
    Delivering,
    Acknowledged,
    Cancelled,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: String,
    pub run_id: String,
    pub from_chat_key: String,
    pub target_chat_key: String,
    pub source: String,
    pub kind: String,
    pub body: String,
    pub state: DeliveryState,
    pub attempts: u32,
    pub coalesced: u32,
    pub created_at: i64,
    pub updated_at: i64,
    pub next_attempt_at: i64,
    pub last_error: Option<String>,
}

pub(super) fn enqueue(
    data: &mut Stored,
    run_id: &str,
    from: &str,
    target: &str,
    source: String,
    kind: &str,
    body: String,
) {
    if data
        .notifications
        .values()
        .any(|n| n.source == source && n.target_chat_key == target)
    {
        return;
    }
    let now = now_ms();
    if kind == "progress" {
        if let Some(n) = data.notifications.values_mut().find(|n| {
            n.run_id == run_id
                && n.from_chat_key == from
                && n.target_chat_key == target
                && n.kind == "progress"
                && n.state == DeliveryState::Pending
                && n.attempts == 0
        }) {
            n.source = source;
            n.body = body;
            n.updated_at = now;
            n.coalesced += 1;
            n.next_attempt_at = (now + 2_000).min(n.created_at + 10_000);
            return;
        }
    } else if matches!(kind, "report" | "capacity" | "provider" | "disconnected") {
        for n in data.notifications.values_mut().filter(|n| {
            n.run_id == run_id
                && n.from_chat_key == from
                && n.kind == "progress"
                && n.state == DeliveryState::Pending
        }) {
            n.state = DeliveryState::Cancelled;
            n.updated_at = now;
        }
    }
    let id = format!("{RECEIPT_PREFIX}{}", compact_id());
    data.notifications.insert(
        id.clone(),
        Notification {
            id,
            run_id: run_id.into(),
            from_chat_key: from.into(),
            target_chat_key: target.into(),
            source,
            kind: kind.into(),
            body,
            state: DeliveryState::Pending,
            attempts: 0,
            coalesced: 0,
            created_at: now,
            updated_at: now,
            next_attempt_at: now + if kind == "progress" { 2_000 } else { 0 },
            last_error: None,
        },
    );
}

fn valid(data: &Stored, n: &Notification) -> bool {
    let Some(run) = data.runs.get(&n.run_id) else {
        return false;
    };
    if run.status == RunStatus::Stopped {
        return false;
    }
    if let Some(id) = n.source.strip_prefix("gate:") {
        if !data
            .gates
            .get(id)
            .is_some_and(|g| g.status == GateStatus::Open)
        {
            return false;
        }
    }
    if n.target_chat_key != run.coordinator_chat_key {
        return data.attempts.values().any(|a| {
            a.worker_chat_key == n.target_chat_key
                && a.run_id == n.run_id
                && matches!(a.status, AttemptStatus::Preparing | AttemptStatus::Running)
                && data
                    .tasks
                    .get(&a.task_id)
                    .is_some_and(|t| t.active_attempt_id.as_deref() == Some(&a.id))
        });
    }
    true
}

impl OrchestrationStore {
    pub(crate) fn save_resume_context(
        &self,
        key: &str,
        context: crate::agent_chat::StartContext,
    ) -> Result<(), String> {
        // Only orchestrated chats need unattended recovery. Never persist the
        // project's environment here; delivery reloads it from the project.
        let known = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner
                .data
                .runs
                .values()
                .any(|r| r.coordinator_chat_key == key)
                || inner
                    .data
                    .attempts
                    .values()
                    .any(|a| a.worker_chat_key == key)
        };
        if !known {
            return Ok(());
        }
        self.mutate(|data| {
            data.resume_contexts
                .insert(key.into(), context.without_env());
            Ok(())
        })
    }
    pub(crate) fn forget_resume_context(&self, key: &str) -> Result<(), String> {
        self.mutate(|data| {
            data.resume_contexts.remove(key);
            Ok(())
        })
    }
    pub(crate) fn saved_resume_context(
        &self,
        key: &str,
    ) -> Option<crate::agent_chat::StartContext> {
        self.inner
            .lock()
            .ok()?
            .data
            .resume_contexts
            .get(key)
            .cloned()
    }
    pub(crate) fn due_notifications(&self, now: i64) -> Result<Vec<Notification>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let in_flight: BTreeMap<_, _> = inner
            .data
            .notifications
            .values()
            .filter(|n| n.state == DeliveryState::Delivering)
            .map(|n| (n.target_chat_key.as_str(), n.id.as_str()))
            .collect();
        let mut due: Vec<_> = inner
            .data
            .notifications
            .values()
            .filter(|n| {
                matches!(n.state, DeliveryState::Pending | DeliveryState::Delivering)
                    && n.next_attempt_at <= now
                    && in_flight
                        .get(n.target_chat_key.as_str())
                        .is_none_or(|id| *id == n.id)
            })
            .cloned()
            .collect();
        due.sort_by_key(|n| (n.kind == "progress", n.created_at, n.id.clone()));
        let mut targets = BTreeSet::new();
        due.retain(|n| targets.insert(n.target_chat_key.clone()));
        due.truncate(32);
        Ok(due)
    }
    pub(crate) fn claim_notification(
        &self,
        id: &str,
        now: i64,
    ) -> Result<Option<Notification>, String> {
        self.mutate(|data| {
            let Some(before) = data.notifications.get(id).cloned() else {
                return Ok(None);
            };
            if !matches!(
                before.state,
                DeliveryState::Pending | DeliveryState::Delivering
            ) || before.next_attempt_at > now
            {
                return Ok(None);
            }
            let still_valid = valid(data, &before);
            let n = data.notifications.get_mut(id).unwrap();
            if !still_valid {
                n.state = DeliveryState::Cancelled;
                n.updated_at = now;
                return Ok(None);
            }
            n.state = DeliveryState::Delivering;
            n.attempts = n.attempts.saturating_add(1);
            n.updated_at = now;
            n.next_attempt_at = now + 60_000;
            Ok(Some(n.clone()))
        })
    }
    pub(crate) fn acknowledge_notification(&self, key: &str, id: &str) -> Result<(), String> {
        let run_id = self.mutate(|data| {
            let n = data
                .notifications
                .get_mut(id)
                .ok_or("Notification does not exist.")?;
            if n.target_chat_key != key {
                return Err("Notification receipt belongs to another chat.".into());
            }
            if matches!(n.state, DeliveryState::Delivering | DeliveryState::Pending)
                && n.attempts > 0
            {
                n.state = DeliveryState::Acknowledged;
                n.last_error = None;
                n.updated_at = now_ms();
            }
            Ok(n.run_id.clone())
        })?;
        announce(&run_id, "notification_acknowledged");
        Ok(())
    }
    pub(crate) fn retry_notification(
        &self,
        id: &str,
        error: Option<String>,
        now: i64,
    ) -> Result<(), String> {
        self.mutate(|data| {
            let n = data
                .notifications
                .get_mut(id)
                .ok_or("Notification does not exist.")?;
            if n.state != DeliveryState::Delivering {
                return Ok(());
            }
            n.state = DeliveryState::Pending;
            n.updated_at = now;
            if let Some(error) = error {
                n.last_error = Some(error.chars().take(2_000).collect());
                n.next_attempt_at = now + (1_000_i64 << n.attempts.min(8)).min(300_000);
            } else {
                n.attempts = n.attempts.saturating_sub(1);
                n.next_attempt_at = now + 2_000;
            }
            Ok(())
        })
    }
}

pub fn deliver_pending(
    chats: &Arc<ChatManager>,
    workspaces: &WorkspaceState,
) -> Result<(), String> {
    let store = &chats.orchestrations;
    for candidate in store.due_notifications(now_ms())? {
        // Serialize with stop/lease transfer, but never hold this lock while
        // waiting for a provider turn to finish.
        let _guard = store.workspace_ops.lock().map_err(|e| e.to_string())?;
        if candidate.attempts > 0
            && crate::transcript::since(&candidate.target_chat_key, 0)
                .iter()
                .any(|frame| {
                    frame.event["octiq_orchestration_notification_id"].as_str()
                        == Some(&candidate.id)
                })
        {
            store.acknowledge_notification(&candidate.target_chat_key, &candidate.id)?;
            continue;
        }
        if !chats.notification_ready(&candidate.target_chat_key) {
            continue;
        }
        let Some(notification) = store.claim_notification(&candidate.id, now_ms())? else {
            announce(&candidate.run_id, "notification_cancelled");
            continue;
        };
        announce(&notification.run_id, "notification_delivering");
        let run = store
            .snapshot(Some(&notification.run_id))?
            .runs
            .into_iter()
            .next()
            .ok_or("Run no longer exists.")?;
        let env = workspace(workspaces, &run.workspace_id).map(|project| project.env);
        let result = env.and_then(|env| {
            crate::agent_chat::deliver_orchestration_notification(chats.clone(), &notification, env)
        });
        match result {
            Ok(true) => {}
            Ok(false) => store.retry_notification(&notification.id, None, now_ms())?,
            Err(error) => store.retry_notification(&notification.id, Some(error), now_ms())?,
        }
        announce(&notification.run_id, "notification_delivery_updated");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::tests::{run, running_worker};
    use super::*;
    fn ping(store: &OrchestrationStore, run: &Run, worker: &Attempt, kind: &str, body: &str) {
        store
            .record_message(
                &worker.worker_chat_key,
                run.id.clone(),
                "coordinator".into(),
                kind.into(),
                "Update".into(),
                body.into(),
            )
            .unwrap();
    }
    #[test]
    fn progress_coalesces_but_decisions_and_reports_remain_durable() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        ping(&store, &run, &worker, "progress", "first");
        ping(&store, &run, &worker, "progress", "latest");
        let pending = store.snapshot(None).unwrap().notifications;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].coalesced, 1);
        assert!(pending[0].body.contains("latest"));
        ping(&store, &run, &worker, "question", "Need help");
        let due = store.due_notifications(now_ms() + 20_000).unwrap();
        assert_eq!(due.len(), 1);
        assert_ne!(due[0].kind, "progress");
        store
            .report_worker(
                &worker.worker_chat_key,
                WorkerReport {
                    attempt_id: worker.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: vec![],
                },
            )
            .unwrap();
        let notes = store.snapshot(None).unwrap().notifications;
        assert!(notes
            .iter()
            .any(|n| n.kind == "report" && n.state == DeliveryState::Pending));
        assert!(notes
            .iter()
            .any(|n| n.kind == "progress" && n.state == DeliveryState::Cancelled));
    }
    #[test]
    fn receipt_is_target_bound_idempotent_and_accepts_a_late_retry_receipt() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        ping(&store, &run, &worker, "question", "Help");
        let n = store.due_notifications(i64::MAX).unwrap().remove(0);
        store
            .claim_notification(&n.id, now_ms() + 100)
            .unwrap()
            .unwrap();
        assert!(store.acknowledge_notification("other", &n.id).is_err());
        store
            .retry_notification(&n.id, Some("offline".into()), now_ms())
            .unwrap();
        store
            .acknowledge_notification(&n.target_chat_key, &n.id)
            .unwrap();
        store
            .acknowledge_notification(&n.target_chat_key, &n.id)
            .unwrap();
        assert_eq!(
            store.snapshot(None).unwrap().notifications[0].state,
            DeliveryState::Acknowledged
        );
        assert!(store.due_notifications(i64::MAX).unwrap().is_empty());
    }
    #[test]
    fn in_flight_blocks_other_pings_and_stop_cancels_every_pending_delivery() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        ping(&store, &run, &worker, "question", "one");
        ping(&store, &run, &worker, "question", "two");
        let n = store.due_notifications(i64::MAX).unwrap().remove(0);
        store
            .claim_notification(&n.id, now_ms() + 100)
            .unwrap()
            .unwrap();
        assert!(store.due_notifications(now_ms() + 1000).unwrap().is_empty());
        assert_eq!(store.due_notifications(i64::MAX).unwrap()[0].id, n.id);
        store
            .stop_run("chat:master", run.id, "stop".into())
            .unwrap();
        assert!(store
            .snapshot(None)
            .unwrap()
            .notifications
            .iter()
            .all(|n| n.state == DeliveryState::Cancelled));
    }
    #[test]
    fn reload_preserves_inbox_and_sanitized_resume_context() {
        let path = std::env::temp_dir().join(format!("octiq-inbox-{}.json", compact_id()));
        let store = OrchestrationStore::load(path.clone());
        let run = run(&store);
        let worker = running_worker(&store, &run);
        ping(&store, &run, &worker, "question", "survive restart");
        let mut value = serde_json::to_value(crate::agent_chat::StartContext::for_test(
            ChatAgent::Codex,
            Some("session"),
        ))
        .unwrap();
        value["env"] = json!({"SECRET":"must not persist"});
        store
            .save_resume_context("chat:master", serde_json::from_value(value).unwrap())
            .unwrap();
        let n = store.due_notifications(i64::MAX).unwrap().remove(0);
        store
            .claim_notification(&n.id, now_ms() + 100)
            .unwrap()
            .unwrap();
        let saved = fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("must not persist"));
        let loaded = OrchestrationStore::load(path.clone());
        assert_eq!(
            loaded
                .snapshot(None)
                .unwrap()
                .notifications
                .iter()
                .find(|saved| saved.id == n.id)
                .unwrap()
                .state,
            DeliveryState::Delivering
        );
        assert!(loaded
            .snapshot(None)
            .unwrap()
            .notifications
            .iter()
            .any(|n| n.kind == "disconnected" && n.state == DeliveryState::Pending));
        assert!(loaded.saved_resume_context("chat:master").is_some());
        assert!(serde_json::to_value(loaded.snapshot(None).unwrap())
            .unwrap()
            .get("resumeContexts")
            .is_none());
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn resolved_decision_is_cancelled_and_its_reply_targets_the_same_attempt() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        let gate = store
            .create_gate(
                &worker.worker_chat_key,
                run.id.clone(),
                Some(worker.task_id.clone()),
                "Which option?".into(),
                vec![],
            )
            .unwrap();
        let decision = store.snapshot(None).unwrap().notifications[0].id.clone();
        store
            .resolve_gate("chat:master", gate.id, "Proceed".into())
            .unwrap();
        assert!(store
            .claim_notification(&decision, now_ms() + 100)
            .unwrap()
            .is_none());
        let reply = store
            .snapshot(None)
            .unwrap()
            .notifications
            .into_iter()
            .find(|n| n.kind == "resolution")
            .unwrap();
        assert_eq!(reply.target_chat_key, worker.worker_chat_key);
        assert!(store
            .claim_notification(&reply.id, now_ms() + 100)
            .unwrap()
            .is_some());
    }
    #[test]
    fn version_two_migrates_without_losing_existing_runs() {
        let path = std::env::temp_dir().join(format!("octiq-inbox-v2-{}.json", compact_id()));
        let store = OrchestrationStore::default();
        let run = run(&store);
        let mut value = serde_json::to_value(&store.inner.lock().unwrap().data).unwrap();
        value["version"] = json!(2);
        value.as_object_mut().unwrap().remove("notifications");
        value.as_object_mut().unwrap().remove("resumeContexts");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let loaded = OrchestrationStore::load(path.clone());
        assert_eq!(loaded.snapshot(None).unwrap().runs[0].id, run.id);
        assert!(loaded.snapshot(None).unwrap().notifications.is_empty());
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["version"], STORE_VERSION);
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn settled_worker_cannot_receive_a_stale_notification() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        store
            .mutate(|data| {
                enqueue(
                    data,
                    &run.id,
                    "chat:master",
                    &worker.worker_chat_key,
                    "message:test".into(),
                    "message",
                    "continue".into(),
                );
                Ok(())
            })
            .unwrap();
        let id = store.snapshot(None).unwrap().notifications[0].id.clone();
        store
            .report_worker(
                &worker.worker_chat_key,
                WorkerReport {
                    attempt_id: worker.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: vec![],
                },
            )
            .unwrap();
        assert!(store
            .claim_notification(&id, now_ms() + 100)
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .snapshot(None)
                .unwrap()
                .notifications
                .iter()
                .find(|n| n.id == id)
                .unwrap()
                .state,
            DeliveryState::Cancelled
        );
    }
}

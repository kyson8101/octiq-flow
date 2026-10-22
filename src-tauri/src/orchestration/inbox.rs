//! Durable notifications. Acknowledgement means provider receipt, not task completion.
use super::*;
use serde_json::Value;

pub const RECEIPT_PREFIX: &str = "octiq-notification-";
/// One turn can carry many notifications. Keep the legacy scalar receipt
/// for its first id; the array names every member for crash reconciliation.
pub(crate) fn receipt_ids(event: &Value) -> Vec<&str> {
    let mut ids = Vec::new();
    for id in event["octiq_orchestration_notification_id"]
        .as_str()
        .into_iter()
        .chain(
            event["octiq_orchestration_notification_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str),
        )
    {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

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
            n.last_error =
                Some("Folded progress: a worker report or host state superseded it.".into());
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

/// A notice of a one-time command allowance from a build that offered one.
/// The allowance was withdrawn (`safety_block::EXACT_GRANT_WITHDRAWN`), so
/// the notice is false and is never delivered.
pub(super) fn withdrawn_exact_grant(n: &Notification) -> bool {
    n.source.starts_with("exact-grant:") || n.source.starts_with("exact-grant-note:")
}

/// Only structured informational worker messages are foldable. In particular,
/// do not infer a request's importance from words in its body: questions,
/// escalations, decisions and reports retain their own durable identity.
fn informational_attempt<'a>(
    data: &'a Stored,
    n: &Notification,
) -> Option<(&'a Attempt, &'a OrchestrationMessage)> {
    let run = data.runs.get(&n.run_id)?;
    if n.target_chat_key != run.coordinator_chat_key {
        return None;
    }
    let message = data.messages.get(n.source.strip_prefix("message:")?)?;
    if !matches!(message.kind.as_str(), "status" | "progress") {
        return None;
    }
    let attempt = data
        .attempts
        .values()
        .filter(|a| {
            a.run_id == n.run_id
                && a.worker_chat_key == message.from_chat_key
                && a.created_at <= message.created_at
        })
        .max_by_key(|a| (a.created_at, a.number))?;
    Some((attempt, message))
}

fn stale_reason(data: &Stored, n: &Notification) -> Option<String> {
    if let Some((attempt, message)) = informational_attempt(data, n) {
        let task = data.tasks.get(&attempt.task_id)?;
        if !matches!(
            attempt.status,
            AttemptStatus::Preparing | AttemptStatus::Running
        ) || task.active_attempt_id.as_deref() != Some(&attempt.id)
            || task.superseded_by.is_some()
        {
            return Some(format!(
                "Folded worker update: attempt {} is no longer running the task.",
                attempt.id
            ));
        }
        if data.notifications.values().any(|other| {
            other.id != n.id
                && other.state != DeliveryState::Cancelled
                && informational_attempt(data, other).is_some_and(|(a, m)| {
                    a.id == attempt.id && (m.created_at, &m.id) > (message.created_at, &message.id)
                })
        }) {
            return Some(format!(
                "Folded worker update: a newer status exists for attempt {}.",
                attempt.id
            ));
        }
    }
    // These sources identify the exact failed attempt. Do not use the
    // sender's latest attempt: retries can reuse a conversation, and an old
    // failure must never be attributed to the new work.
    let failed_id = [
        "execution-failed:",
        "provider-retry:",
        "recovery-failed:",
        "recovery-held:",
    ]
    .into_iter()
    .find_map(|prefix| n.source.strip_prefix(prefix))
    .and_then(|tail| tail.split(':').next());
    if let Some(attempt) = failed_id.and_then(|id| data.attempts.get(id)) {
        if let Some(task) = data.tasks.get(&attempt.task_id) {
            if task.superseded_by.is_some()
                || data
                    .attempts
                    .values()
                    .any(|a| a.task_id == task.id && a.number > attempt.number)
            {
                return Some(format!(
                    "Folded failure notice: attempt {} was superseded by a newer attempt or task.",
                    attempt.id
                ));
            }
        }
    }
    None
}

fn valid(data: &Stored, n: &Notification) -> bool {
    if withdrawn_exact_grant(n) {
        return false;
    }
    let Some(run) = data.runs.get(&n.run_id) else {
        return false;
    };
    // A first plan rejection stops the run in the same transaction that
    // creates its one host continuation. That decision receipt is the sole
    // notification allowed to cross the stopped-run boundary.
    if run.status == RunStatus::Stopped && n.kind != "plan_rejected" {
        return false;
    }
    // Queued before its run settled, or by a build that still sent them.
    if n.kind == "service" && run_has_ended(run) {
        return false;
    }
    if let Some(id) = n.source.strip_prefix("relay:") {
        if !bridge::delivers(data, id, &n.target_chat_key) {
            return false;
        }
    }
    if !lifecycle::outage_notice_valid(data, n) {
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
        self.resume_context_as(None, key, context)
    }

    /// `save_resume_context` for a level that has ALREADY taken hold in the
    /// running agent (`chat_set_access`) and is no higher than the one on
    /// record: kept here whether or not it could be saved. Refused instead,
    /// a host resume would have started the chat at the level the person
    /// had just left.
    ///
    /// **Only ever a lowering.** A level higher than the one on record is
    /// not kept regardless, whoever asks: it is saved or it is refused
    /// (review of b894867, H8). `chat_set_access` records a raise before it
    /// tells the agent, so by the time it gets here a raise is on record
    /// and this is the same level again.
    pub(crate) fn keep_resume_context(
        &self,
        key: &str,
        context: crate::agent_chat::StartContext,
    ) -> Result<(), String> {
        use crate::access_request::rank;
        use crate::agent_provider::Access;
        let level = |start: &crate::agent_chat::StartContext| {
            rank(start.access_level().unwrap_or(Access::Read))
        };
        let widens = self
            .saved_resume_context(key)
            .is_none_or(|saved| level(&context) > level(&saved));
        let regardless = (!widens).then_some("the chat's access level");
        self.resume_context_as(regardless, key, context)
    }

    fn resume_context_as(
        &self,
        regardless: Option<&str>,
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
        self.mutate_as(regardless, |data| {
            data.resume_contexts
                .insert(key.into(), context.without_env());
            Ok(())
        })
    }
    /// The one-time lift of a chat an earlier build opened as a read-only
    /// discussion (`handover::lift`): its saved start settings, when the
    /// ledger holds some and they are at exactly read, move to `to`. Saved
    /// or refused, like any raise. Answers whether anything was written; a
    /// ledger that could not be loaded is an error, never "holds none".
    pub(crate) fn lift_resume_context(
        &self,
        key: &str,
        to: crate::agent_provider::Access,
    ) -> Result<bool, String> {
        use crate::agent_provider::Access;
        let at_read = |data: &Stored| {
            data.resume_contexts
                .get(key)
                .is_some_and(|saved| saved.access_level() == Some(Access::Read))
        };
        {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            if let Some(error) = &inner.load_error {
                return Err(error.clone());
            }
            // Nothing to move is nothing to save.
            if !at_read(&inner.data) {
                return Ok(false);
            }
        }
        self.mutate(|data| {
            if !at_read(data) {
                return Ok(false);
            }
            // The settings' fields are `agent_chat`'s own: the level is
            // set in the form they are stored in, which is the form a
            // restart reads them back from.
            let mut saved =
                serde_json::to_value(&data.resume_contexts[key]).map_err(|e| e.to_string())?;
            saved["access"] = serde_json::to_value(to).map_err(|e| e.to_string())?;
            let lifted = serde_json::from_value(saved).map_err(|e| e.to_string())?;
            data.resume_contexts.insert(key.into(), lifted);
            Ok(true)
        })
    }
    /// Called once a chat's process has been ended for another provider:
    /// forgotten here whether or not that could be saved, so the old
    /// settings cannot resume the chat.
    pub(crate) fn forget_resume_context(&self, key: &str) -> Result<(), String> {
        self.mutate_regardless("the forgotten start settings", |data| {
            data.resume_contexts.remove(key);
            Ok(())
        })
    }
    /// Choose only a recorded coordinator location, never a worker checkout
    /// leaked into start settings by a rejected duplicate browser launch.
    pub(crate) fn notification_resume_cwd(
        &self,
        key: &str,
        run_id: &str,
        saved: &str,
        indexed: Option<&str>,
    ) -> Result<String, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let path = |value: &str| {
            crate::paths::canonical_target(Path::new(value)).unwrap_or_else(|| PathBuf::from(value))
        };
        let coordinator = inner
            .data
            .runs
            .get(run_id)
            .is_some_and(|run| run.coordinator_chat_key == key);
        if !coordinator {
            if indexed.is_some_and(|value| path(value) != path(saved)) {
                return Err("The worker's saved checkout changed.".into());
            }
            return Ok(saved.to_string());
        }
        let mut cwd = saved.to_string();
        if let Some(indexed) = indexed.filter(|value| path(value) != path(saved)) {
            let root = inner.data.runs.get(run_id)
                .filter(|run| run.coordinator_chat_key == key && path(&run.root_path) == path(indexed))
                .ok_or("The chat's checkout changed. Continue it in Chat before automatic notification delivery.")?;
            cwd = root.root_path.clone();
        }
        let chosen = path(&cwd);
        if inner
            .data
            .tasks
            .values()
            .filter_map(|task| task.workspace.as_ref())
            .any(|ws| {
                ws.plan.is_managed_worktree()
                    && !ws.plan.checkout_root.trim().is_empty()
                    && (ws.lease_attempt_id.is_some()
                        || matches!(
                            ws.state,
                            workspaces::WorkspaceState::Preparing
                                | workspaces::WorkspaceState::Cleaning
                        ))
                    && chosen.starts_with(path(&ws.plan.checkout_root))
            })
        {
            return Err("A worker holds the saved checkout. Continue the coordinator in its own checkout before automatic notification delivery.".into());
        }
        Ok(cwd)
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
        let waiting_receipt: BTreeSet<_> = inner
            .data
            .notifications
            .values()
            .filter(|n| n.state == DeliveryState::Delivering && n.next_attempt_at > now)
            .map(|n| n.target_chat_key.as_str())
            .collect();
        let mut due: Vec<_> = inner
            .data
            .notifications
            .values()
            .filter(|n| {
                matches!(n.state, DeliveryState::Pending | DeliveryState::Delivering)
                    && n.next_attempt_at <= now
                    && !waiting_receipt.contains(n.target_chat_key.as_str())
            })
            .cloned()
            .collect();
        due.sort_by_key(|n| (n.created_at, n.id.clone()));
        // Bound chats per pass, never split one chat's due backlog into turns.
        let mut targets = BTreeSet::new();
        due.retain(|n| {
            targets.contains(&n.target_chat_key)
                || (targets.len() < 32 && targets.insert(n.target_chat_key.clone()))
        });
        Ok(due)
    }
    #[cfg(test)]
    pub(crate) fn claim_notification(
        &self,
        id: &str,
        now: i64,
    ) -> Result<Option<Notification>, String> {
        Ok(self.claim_notifications(&[id.to_string()], now)?.pop())
    }

    fn claim_notifications(&self, ids: &[String], now: i64) -> Result<Vec<Notification>, String> {
        self.mutate(|data| {
            let mut claimed = Vec::new();
            for id in ids {
                let Some(before) = data.notifications.get(id).cloned() else {
                    continue;
                };
                if !matches!(
                    before.state,
                    DeliveryState::Pending | DeliveryState::Delivering
                ) || before.next_attempt_at > now
                {
                    continue;
                }
                let cancellation = stale_reason(data, &before).or_else(|| {
                    (!valid(data, &before))
                        .then(|| "Notification no longer applies to its run or recipient.".into())
                });
                let n = data.notifications.get_mut(id).unwrap();
                if let Some(reason) = cancellation {
                    n.state = DeliveryState::Cancelled;
                    n.updated_at = now;
                    n.last_error = Some(reason);
                    continue;
                }
                n.state = DeliveryState::Delivering;
                n.attempts = n.attempts.saturating_add(1);
                n.updated_at = now;
                n.next_attempt_at = now + 60_000;
                claimed.push(n.clone());
            }
            Ok(claimed)
        })
    }
    /// Everything waiting for a worker, handed over in the answer to its own
    /// call to the host, and acknowledged by that answer.
    ///
    /// Feedback 67d07562 / 025ab9e0: `deliver_pending` writes to a chat only
    /// between turns, and a worker's whole attempt is usually ONE turn, so a
    /// coordinator's instruction sat pending until the attempt had settled
    /// without it. A worker calls the host as it goes (task_status, its
    /// orchestration tools, its report), and each call is a moment it is
    /// reading. Only an active attempt's own worker chat is served — `valid`
    /// already says so — and a notice mid-write to its stdin is left alone.
    pub(crate) fn take_for_working_worker(&self, key: &str) -> Result<Vec<Notification>, String> {
        // Asked on every call any chat makes: look before writing the ledger.
        let waiting = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner
                .data
                .notifications
                .values()
                .any(|n| n.target_chat_key == key && n.state == DeliveryState::Pending)
        };
        if !waiting {
            return Ok(Vec::new());
        }
        let taken = self.mutate(|data| {
            let now = now_ms();
            let mut ids: Vec<_> = data
                .notifications
                .values()
                .filter(|n| {
                    n.target_chat_key == key
                        && n.state == DeliveryState::Pending
                        && data
                            .runs
                            .get(&n.run_id)
                            .is_some_and(|r| r.coordinator_chat_key != key)
                        && valid(data, n)
                })
                .map(|n| (n.created_at, n.id.clone()))
                .collect();
            ids.sort();
            let mut taken = Vec::new();
            for (_, id) in ids {
                let n = data.notifications.get_mut(&id).unwrap();
                n.state = DeliveryState::Acknowledged;
                n.attempts = n.attempts.saturating_add(1);
                n.last_error = None;
                n.updated_at = now;
                taken.push(n.clone());
            }
            Ok(taken)
        })?;
        for run in taken
            .iter()
            .map(|n| n.run_id.clone())
            .collect::<BTreeSet<_>>()
        {
            announce(&run, "notification_acknowledged");
        }
        Ok(taken)
    }
    /// Whether message `message_id` still waits for its recipient. One a
    /// working worker already took with a host call is not worth cutting its
    /// turn for: nothing would be left to start the next one.
    pub(crate) fn message_waiting(&self, message_id: &str) -> bool {
        let source = format!("message:{message_id}");
        self.inner.lock().is_ok_and(|inner| {
            inner
                .data
                .notifications
                .values()
                .any(|n| n.source == source && n.state == DeliveryState::Pending)
        })
    }
    pub(crate) fn acknowledge_notification(&self, key: &str, id: &str) -> Result<(), String> {
        self.acknowledge_notifications(key, &[id.to_string()])
    }

    pub(crate) fn acknowledge_notifications(
        &self,
        key: &str,
        ids: &[String],
    ) -> Result<(), String> {
        // Receipt already happened. Keep it even when the ledger cannot be
        // saved; never let a save failure turn the answer into another turn.
        let runs = self.mutate_regardless("notification receipts", |data| {
            for id in ids {
                let n = data
                    .notifications
                    .get(id)
                    .ok_or("Notification does not exist.")?;
                if n.target_chat_key != key {
                    return Err("Notification receipt belongs to another chat.".into());
                }
            }
            let mut runs = BTreeSet::new();
            for id in ids {
                let n = data.notifications.get_mut(id).unwrap();
                if matches!(n.state, DeliveryState::Delivering | DeliveryState::Pending)
                    && n.attempts > 0
                {
                    n.state = DeliveryState::Acknowledged;
                    n.last_error = None;
                    n.updated_at = now_ms();
                    runs.insert(n.run_id.clone());
                }
            }
            Ok(runs)
        })?;
        for run in runs {
            announce(&run, "notification_acknowledged");
        }
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
    let mut batches: BTreeMap<String, Vec<Notification>> = BTreeMap::new();
    for n in store.due_notifications(now_ms())? {
        batches
            .entry(n.target_chat_key.clone())
            .or_default()
            .push(n);
    }
    for (key, candidates) in batches {
        // Serialize with stop/lease transfer, never with a provider's turn.
        let _guard = store.workspace_ops.lock().map_err(|e| e.to_string())?;
        let frames = crate::transcript::every_line(&key)?;
        let receipts: BTreeSet<_> = frames
            .iter()
            .flat_map(|frame| receipt_ids(&frame.event))
            .collect();
        let mut waiting = Vec::new();
        let mut received = Vec::new();
        for candidate in candidates {
            if candidate.attempts > 0 && receipts.contains(candidate.id.as_str()) {
                received.push(candidate.id);
            } else {
                waiting.push(candidate.id);
            }
        }
        if !received.is_empty() {
            store.acknowledge_notifications(&key, &received)?;
        }
        if waiting.is_empty() || !chats.notification_ready(&key) {
            continue;
        }
        let batch = store.claim_notifications(&waiting, now_ms())?;
        if batch.is_empty() {
            continue;
        }
        let run = store
            .snapshot(Some(&batch[0].run_id))?
            .runs
            .into_iter()
            .next()
            .ok_or("Run no longer exists.")?;
        let result = workspace(workspaces, &run.workspace_id).and_then(|project| {
            crate::agent_chat::deliver_orchestration_notifications(
                chats.clone(),
                &batch,
                project.env,
            )
        });
        for notification in &batch {
            match &result {
                Ok(true) => {}
                Ok(false) => store.retry_notification(&notification.id, None, now_ms())?,
                Err(error) => {
                    store.retry_notification(&notification.id, Some(error.clone()), now_ms())?
                }
            }
            announce(&notification.run_id, "notification_delivery_updated");
        }
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
    fn coordinator_wake_avoids_a_workers_leased_worktree_and_unvouched_index_paths() {
        let home = crate::test_dir::TestDir::new("notification-lease");
        let _profile = crate::profile::started_in(&home);
        let store = OrchestrationStore::default();
        let root = home.join("coordinator").to_string_lossy().into_owned();
        let leased = home.join("worker").to_string_lossy().into_owned();
        let run = store
            .create_run(
                "chat:master".into(),
                "test".into(),
                "workspace".into(),
                root.clone(),
                Some(2),
            )
            .unwrap();
        let worker = running_worker(&store, &run);
        store.mutate(|data| {
            data.tasks.get_mut(&worker.task_id).unwrap().workspace = Some(serde_json::from_value(json!({
                "plan": {"mode":"worktree", "cwd":leased, "checkoutRoot":leased,
                    "repositoryRoot": root, "branch":"feature/worker", "baseBranch":"develop",
                    "baseSha":"abc", "managed":true, "isRepo":true, "warnings":[], "initialStatus":""},
                "state":"ready", "leaseAttemptId":worker.id, "delivery":null,
            })).unwrap());
            Ok(())
        }).unwrap();
        assert_eq!(
            store.notification_resume_cwd(&run.coordinator_chat_key, &run.id, &leased, Some(&root)),
            Ok(root.clone())
        );
        assert!(store
            .notification_resume_cwd(&run.coordinator_chat_key, &run.id, &leased, Some(&leased))
            .unwrap_err()
            .contains("worker holds"));
        assert_eq!(
            store.notification_resume_cwd(&worker.worker_chat_key, &run.id, &leased, Some(&leased)),
            Ok(leased.clone()),
            "a worker keeps its own checkout"
        );
        let stranger = home.join("unvouched").to_string_lossy().into_owned();
        assert!(store
            .notification_resume_cwd(&run.coordinator_chat_key, &run.id, &leased, Some(&stranger))
            .is_err());
    }

    #[test]
    fn settled_worker_updates_are_cancelled_but_requests_and_reports_survive() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        for kind in [
            "status",
            "progress",
            "question",
            "escalation",
            "instruction",
        ] {
            ping(&store, &run, &worker, kind, kind);
        }
        store
            .report_worker(
                &worker.worker_chat_key,
                WorkerReport {
                    attempt_id: worker.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        let due = store.due_notifications(i64::MAX).unwrap();
        let ids: Vec<_> = due.iter().map(|n| n.id.clone()).collect();
        store.claim_notifications(&ids, i64::MAX - 60_000).unwrap();
        let notes = store.snapshot(None).unwrap().notifications;
        for n in notes {
            if n.kind == "progress" || n.body.contains("message [status]") {
                assert_eq!(n.state, DeliveryState::Cancelled);
                assert!(n.last_error.is_some(), "{}", n.body);
            } else {
                assert_eq!(n.state, DeliveryState::Delivering, "{}", n.body);
            }
        }
    }

    #[test]
    fn a_running_attempt_keeps_only_its_latest_structured_status() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        for body in ["old status", "latest status"] {
            ping(&store, &run, &worker, "status", body);
        }
        // Give the two events a strict order independent of clock precision.
        store
            .mutate(|data| {
                for message in data.messages.values_mut() {
                    if message.body == "latest status" {
                        message.created_at += 1;
                    }
                }
                Ok(())
            })
            .unwrap();
        let due = store.due_notifications(i64::MAX).unwrap();
        let ids: Vec<_> = due.iter().map(|n| n.id.clone()).collect();
        let claimed = store.claim_notifications(&ids, i64::MAX - 60_000).unwrap();
        assert_eq!(claimed.len(), 1);
        assert!(claimed[0].body.contains("latest status"));
        let old = store
            .snapshot(None)
            .unwrap()
            .notifications
            .into_iter()
            .find(|n| n.body.contains("old status"))
            .unwrap();
        assert_eq!(old.state, DeliveryState::Cancelled);
        assert!(old.last_error.unwrap().contains("newer status"));
    }

    #[test]
    fn superseded_failure_notices_fold_without_losing_reports_or_decisions() {
        for replacement in [false, true] {
            let store = OrchestrationStore::default();
            let run = run(&store);
            let worker = running_worker(&store, &run);
            store
                .mutate(|data| {
                    for (source, kind) in [
                        (format!("execution-failed:{}", worker.id), "capacity"),
                        (format!("recovery-failed:{}", worker.id), "provider"),
                        (format!("report:{}", worker.id), "report"),
                        (format!("native-decision:{}", worker.id), "native_decision"),
                        (format!("decision:{}", worker.id), "decision"),
                    ] {
                        enqueue(
                            data,
                            &run.id,
                            &worker.worker_chat_key,
                            &run.coordinator_chat_key,
                            source,
                            kind,
                            "act on this".into(),
                        );
                    }
                    if replacement {
                        data.tasks.get_mut(&worker.task_id).unwrap().superseded_by =
                            Some("replacement-task".into());
                    } else {
                        let mut newer = worker.clone();
                        newer.id = "new-attempt".into();
                        newer.number += 1;
                        data.tasks
                            .get_mut(&worker.task_id)
                            .unwrap()
                            .active_attempt_id = Some(newer.id.clone());
                        data.attempts.insert(newer.id.clone(), newer);
                    }
                    Ok(())
                })
                .unwrap();
            let ids: Vec<_> = store
                .due_notifications(i64::MAX)
                .unwrap()
                .into_iter()
                .map(|n| n.id)
                .collect();
            let kept = store.claim_notifications(&ids, i64::MAX - 60_000).unwrap();
            assert_eq!(kept.len(), 3);
            assert!(kept
                .iter()
                .all(|n| matches!(n.kind.as_str(), "report" | "native_decision" | "decision")));
            assert!(store
                .snapshot(None)
                .unwrap()
                .notifications
                .iter()
                .filter(|n| n.state == DeliveryState::Cancelled)
                .all(|n| n.last_error.as_ref().unwrap().contains("superseded")));
        }
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
        assert_eq!(due.len(), 2);
        assert!(due.iter().any(|n| n.kind != "progress"));
        store
            .report_worker(
                &worker.worker_chat_key,
                WorkerReport {
                    attempt_id: worker.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: vec![],
                    verdict: None,
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
    /// Feedback 67d07562 / 025ab9e0: a working worker gets its coordinator's
    /// instruction in the answer to its next host call, exactly once, and no
    /// other chat can take it.
    #[test]
    fn a_working_worker_takes_its_instructions_once() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        assert!(store
            .take_for_working_worker(&worker.worker_chat_key)
            .unwrap()
            .is_empty());
        let message = store
            .record_message(
                &run.coordinator_chat_key,
                run.id.clone(),
                worker.id.clone(),
                "instruction".into(),
                "Base".into(),
                "Rebase onto release/1.8.2.".into(),
            )
            .unwrap();
        assert!(store.message_waiting(&message.id));
        assert!(store
            .take_for_working_worker(&run.coordinator_chat_key)
            .unwrap()
            .is_empty());
        assert!(store
            .take_for_working_worker("chat:someone-else")
            .unwrap()
            .is_empty());
        let taken = store
            .take_for_working_worker(&worker.worker_chat_key)
            .unwrap();
        assert_eq!(taken.len(), 1);
        assert!(taken[0].body.contains("release/1.8.2"), "{}", taken[0].body);
        // Feedback 531f1dac: taken, so an interrupt would cut its turn for
        // nothing.
        assert!(!store.message_waiting(&message.id));
        let note = store
            .snapshot(None)
            .unwrap()
            .notifications
            .into_iter()
            .find(|n| n.id == taken[0].id)
            .unwrap();
        assert_eq!(note.state, DeliveryState::Acknowledged);
        assert!(store
            .due_notifications(i64::MAX)
            .unwrap()
            .iter()
            .all(|n| n.id != note.id));
        assert!(store
            .take_for_working_worker(&worker.worker_chat_key)
            .unwrap()
            .is_empty());
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
        let path = crate::test_dir::TestPath::new("inbox", "orchestrations.json");
        let store = OrchestrationStore::load(path.to_path_buf());
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
        let loaded = OrchestrationStore::load(path.to_path_buf());
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
        let path = crate::test_dir::TestPath::new("inbox-v2", "orchestrations.json");
        let store = OrchestrationStore::default();
        let run = run(&store);
        let mut value = serde_json::to_value(&store.inner.lock().unwrap().data).unwrap();
        value["version"] = json!(2);
        value.as_object_mut().unwrap().remove("notifications");
        value.as_object_mut().unwrap().remove("resumeContexts");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let loaded = OrchestrationStore::load(path.to_path_buf());
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
                    verdict: None,
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

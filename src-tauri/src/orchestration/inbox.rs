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
    /// Enqueue order under the ledger lock. Legacy records have no proven order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
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
    // Live enqueues hold the inbox's ledger lock through mutate. Persist the
    // high-water mark with the notice, including when progress replaces content.
    // Exhaustion must lose ordering evidence, never wrap and cancel newer work.
    let sequence = data.notification_sequence.checked_add(1);
    if let Some(sequence) = sequence {
        data.notification_sequence = sequence;
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
                && n.sequence.is_some()
                && sequence.is_some()
        }) {
            n.source = source;
            n.body = body;
            n.sequence = sequence;
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
            sequence,
            created_at: now,
            updated_at: now,
            next_attempt_at: now + if kind == "progress" { 2_000 } else { 0 },
            last_error: None,
        },
    );
}

/// Legacy notices have no enqueue order: retain them all, presented by their
/// timestamps before sequenced notices. Stable sorting leaves an unknown tie
/// alone; it must never make a random receipt id evidence for folding.
fn batch_order(n: &Notification) -> (bool, u64, i64) {
    (
        n.sequence.is_some(),
        n.sequence.unwrap_or(0),
        if n.sequence.is_none() {
            n.created_at
        } else {
            0
        },
    )
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
    if let Some((attempt, _)) = informational_attempt(data, n) {
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
                // Neither timestamps nor UUIDs prove a legacy notice's order.
                // Keep both when either side lacks a sequence (or they tie).
                && n.sequence.zip(other.sequence).is_some_and(|(this, next)| next > this)
                && informational_attempt(data, other).is_some_and(|(a, _)| a.id == attempt.id)
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
    // These are receipts of the person's decisions, not permission to
    // restart stopped work. Cleanup can concern finished worktrees of a
    // stopped run too; its result must still reach whoever asked: the
    // coordinator, or another chat of the person's that named this finished
    // run on its own cleanup card (host-written, so only that chat is target).
    let cleanup_receipt = n.kind == "workspace_cleanup"
        && n.from_chat_key == "host"
        && (n.source.starts_with("cleanup-result:") || n.source.starts_with("cleanup-prepared:"));
    let lane_notice = n.kind == "status"
        && n.from_chat_key == "host"
        && n.target_chat_key == run.coordinator_chat_key
        && n.source.starts_with("agent-lane-block:");
    if run.status == RunStatus::Stopped
        && n.kind != "plan_rejected"
        && !cleanup_receipt
        && !lane_notice
    {
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
    if cleanup_receipt {
        return true;
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
            let mut context = context.without_env();
            match crate::chat_index::usable_session(key, context.session_id().map(str::to_string)) {
                Ok(Some(_)) => {}
                Ok(None) => context.forget_session(),
                // A lowering already happened. An unavailable revocation
                // store must neither veto it nor bless an unverified id.
                // Keep the narrower settings with no native continuation;
                // mutate_regardless still says unsaved and owes the write.
                Err(_) if regardless.is_some() => context.forget_session(),
                Err(why) => return Err(why),
            }
            data.resume_contexts.insert(key.into(), context);
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
    /// /clear keeps launch settings for notifications, without native memory.
    /// This uses save-first mutation, unlike ending an action or retargeting.
    pub(crate) fn clear_resume_session(&self, key: &str) -> Result<(), String> {
        self.mutate(|data| {
            if let Some(start) = data.resume_contexts.get_mut(key) {
                start.forget_session();
            }
            Ok(())
        })
    }

    /// A native init lost its Stop epoch during store I/O. Keep the
    /// revocation in memory even if its file cannot be saved; settle_owed
    /// retries it, like every other ending action.
    pub(crate) fn revoke_late_session(&self, key: &str, session: &str) -> Result<(), String> {
        if self
            .saved_resume_context(key)
            .is_none_or(|start| start.session_id() != Some(session))
        {
            return Ok(());
        }
        self.mutate_regardless("the stopped provider session", |data| {
            if let Some(start) = data.resume_contexts.get_mut(key) {
                if start.session_id() == Some(session) {
                    start.forget_session();
                }
            }
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
        due.sort_by_key(batch_order);
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
                .map(|n| (batch_order(n), n.id.clone()))
                .collect();
            ids.sort_by_key(|(order, _)| *order);
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
mod tests;

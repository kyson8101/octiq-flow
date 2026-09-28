//! Live dependencies and native decisions are independent of task completion.
//! These records never grant permission or execute a recovery command.
use super::*;
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDecision {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub chat_key: String,
    pub reason: String,
    /// Codex's router diagnostics provide a reason, not the original tool
    /// arguments; only a Claude auto-mode refusal names the call.
    pub blocked_action: Option<String>,
    pub status: String,
    pub continuation: String,
    pub recovery: String,
    pub observed_at: i64,
    /// "safety" when the provider's review judged the call, "outage" when
    /// Claude's classifier gave no verdict at all
    /// (`safety_block::refusal_kind`). A record from before this field is a
    /// safety refusal.
    #[serde(default = "safety_kind")]
    pub kind: String,
    /// The outage card this refusal was grouped on. Every refusal keeps its
    /// own record; the group is what the card and the coordinator notice
    /// count. None for a safety refusal.
    #[serde(default)]
    pub group_id: Option<String>,
}

/// The recovery text for a Claude safety refusal: strict, with no retry.
/// Only an outage refusal may be tried again (`safety_block::OUTAGE_RETRY`).
const CLAUDE_REFUSAL_RECOVERY: &str = "Claude's auto mode refused this call without asking anyone, and OctiqFlow cannot approve it: there is no supported way to allow one refused call before it runs. The card only records the refusal. Do not retry the call or reword it to get past the classifier. Continue another safe way, or settle the attempt blocked and name the refused command so the person can decide.";

fn safety_kind() -> String {
    "safety".into()
}

/// The coordinator notice for an outage group, keyed so it is one per group.
const OUTAGE_NOTICE: &str = "native-outage:";

/// Whether an outage group's coordinator notice would still tell the
/// coordinator something. It would not once the attempt has settled or been
/// superseded, or once a tool call the worker was allowed to run, started
/// after the group's latest refusal, has come back: the worker has moved
/// past it.
///
/// It judges the attempt of the group's LATEST refusal. A group belongs to
/// one attempt, but the records are keyed by random id, so the first one
/// found is no guide to which attempt is current.
fn outage_notice_useful(data: &Stored, group_id: &str) -> bool {
    let Some(latest) = data
        .native_decisions
        .values()
        .filter(|d| d.group_id.as_deref() == Some(group_id))
        .max_by(|a, b| {
            a.observed_at
                .cmp(&b.observed_at)
                .then_with(|| a.id.cmp(&b.id))
        })
    else {
        return false;
    };
    let last_at = latest.observed_at;
    let Some(attempt) = data.attempts.get(&latest.attempt_id) else {
        return false;
    };
    let live = matches!(
        attempt.status,
        AttemptStatus::Preparing | AttemptStatus::Running
    ) && data
        .tasks
        .get(&attempt.task_id)
        .is_some_and(|t| t.active_attempt_id.as_deref() == Some(&attempt.id));
    // Moved on only if an allowed call STARTED after the refusal: one that
    // was already running when it came back proves nothing about after.
    live && attempt
        .execution
        .last_allowed_tool_started_at
        .is_none_or(|at| at <= last_at)
}

/// A retry can reuse a worker chat: a refusal in it belongs to the attempt
/// that is live there, not to an older settled one.
fn chat_owner<'a>(data: &'a Stored, chat_key: &str) -> Option<&'a Attempt> {
    data.attempts
        .values()
        .filter(|a| a.worker_chat_key == chat_key)
        .max_by_key(|a| {
            (
                matches!(a.status, AttemptStatus::Preparing | AttemptStatus::Running),
                a.number,
            )
        })
}

/// The notice for an outage group is cancelled at delivery, never sent,
/// when it would not tell the coordinator anything (`outage_notice_useful`).
pub(super) fn outage_notice_valid(data: &Stored, n: &inbox::Notification) -> bool {
    match n.source.strip_prefix(OUTAGE_NOTICE) {
        Some(group) => outage_notice_useful(data, group),
        None => true,
    }
}

/// Queue, or bring up to date, the one coordinator notice for an outage
/// group. It falls due when the group closes (`outage_group_due`), so the
/// coordinator hears of the whole group at once, or not at all.
fn outage_notice(data: &mut Stored, attempt: &Attempt, group_id: &str) {
    let refusals: Vec<_> = data
        .native_decisions
        .values()
        .filter(|d| d.group_id.as_deref() == Some(group_id))
        .cloned()
        .collect();
    let (Some(first_at), Some(last_at)) = (
        refusals.iter().map(|d| d.observed_at).min(),
        refusals.iter().map(|d| d.observed_at).max(),
    ) else {
        return;
    };
    let due = crate::safety_block::outage_group_due(first_at, last_at, refusals.len());
    let mut commands: Vec<(String, usize)> = Vec::new();
    let mut ordered = refusals.clone();
    ordered.sort_by_key(|d| d.observed_at);
    for d in &ordered {
        let action = d
            .blocked_action
            .clone()
            .unwrap_or_else(|| "a tool call".into());
        match commands.iter_mut().find(|(a, _)| *a == action) {
            Some((_, n)) => *n += 1,
            None => commands.push((action, 1)),
        }
    }
    let listed = commands
        .iter()
        .map(|(a, n)| {
            if *n > 1 {
                format!("`{a}` ×{n}")
            } else {
                format!("`{a}`")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let body = format!(
        "Claude's safety check was unavailable for task {} (attempt {}): {} refused call(s) in outage group {group_id}: {listed}. The worker has not run an allowed tool since the last refusal. Nothing ran and nothing was approved. Read nativeDecisions (groupId {group_id}) in orchestration_snapshot. Guidance the worker was given: {}",
        attempt.task_id,
        attempt.id,
        refusals.len(),
        crate::safety_block::outage_guidance()
    );
    let source = format!("{OUTAGE_NOTICE}{group_id}");
    let target = data.runs[&attempt.run_id].coordinator_chat_key.clone();
    inbox::enqueue(
        data,
        &attempt.run_id,
        &attempt.worker_chat_key,
        &target,
        source.clone(),
        "native_decision",
        body.clone(),
    );
    if let Some(n) = data
        .notifications
        .values_mut()
        .find(|n| n.source == source && n.state == inbox::DeliveryState::Pending && n.attempts == 0)
    {
        n.body = body;
        n.next_attempt_at = due;
        n.coalesced = refusals.len().saturating_sub(1) as u32;
        n.updated_at = now_ms();
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub name: String,
    pub host: IpAddr,
    pub port: u16,
    /// A TCP listener is evidence of reachability, not application health.
    pub state: String,
    pub checked_at: Option<i64>,
    pub recovery: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub attempt_id: String,
    pub name: String,
    pub host: IpAddr,
    pub port: u16,
    pub recovery: String,
}

pub(super) fn recover(data: &mut Stored) -> bool {
    let mut changed = false;
    for decision in data.native_decisions.values_mut() {
        if decision.status == "pending" {
            decision.status = "expired".into();
            decision.continuation = "unavailable".into();
            decision.recovery = "The host restarted; the old card cannot continue. Inspect the retained task and explicitly retry if still needed. A retry grants no permission.".into();
            changed = true;
        }
    }
    // An earlier build told a worker its next launch would carry a one-time
    // rule for a refused command. That rule no longer exists, so the message
    // would be false; one still waiting is cancelled, never delivered.
    for n in data.notifications.values_mut() {
        if inbox::withdrawn_exact_grant(n)
            && matches!(
                n.state,
                inbox::DeliveryState::Pending | inbox::DeliveryState::Delivering
            )
        {
            n.state = inbox::DeliveryState::Cancelled;
            n.updated_at = now_ms();
            changed = true;
        }
    }
    let mut lost = Vec::new();
    for service in data.services.values_mut() {
        if service.state != "unverified" || service.checked_at.is_some() {
            service.state = "unverified".into();
            service.checked_at = None;
            lost.push(service.clone());
            changed = true;
        }
    }
    for service in lost {
        service_notice(
            data,
            &service,
            "Host restarted; previous listener evidence is invalid.",
        );
    }
    changed
}

fn service_notice(data: &mut Stored, service: &Service, reason: &str) {
    let Some(run) = data.runs.get(&service.run_id) else {
        return;
    };
    let target = run.coordinator_chat_key.clone();
    inbox::enqueue(data, &service.run_id, "host", &target,
        format!("service:{}:{}:{}", service.id, service.state, compact_id()), "service",
        format!("Service {} for task {} is {}. {reason} Completed task status is unchanged and is not live readiness. Recovery guidance (not executed): {}. Read orchestration_snapshot before dependent work.", service.name, service.task_id, service.state, service.recovery));
}

pub(super) fn refresh_decision_views(snapshot: &mut Snapshot) {
    let pending: BTreeSet<String> = crate::safety_block::decision_summaries()
        .into_iter()
        .map(|d| d.id)
        .collect();
    for decision in &mut snapshot.native_decisions {
        let live = snapshot.attempts.iter().any(|a| {
            a.id == decision.attempt_id
                && matches!(a.status, AttemptStatus::Preparing | AttemptStatus::Running)
                && snapshot
                    .tasks
                    .iter()
                    .any(|t| t.active_attempt_id.as_deref() == Some(&a.id))
        });
        if decision.status == "pending" && !pending.contains(&decision.id) {
            // What the person chose, when this server saw it; "closed" says
            // only that the card went away, never that it was approved. An
            // outage refusal was decided with the card it was grouped on.
            let card = decision.group_id.as_deref().unwrap_or(&decision.id);
            decision.status = crate::safety_block::decision(card)
                .unwrap_or("closed")
                .into();
        }
        // Only a Claude auto-mode refusal names the call it refused; Codex's
        // router diagnostics never do (`safety_block::BlockedAction::action`).
        let claude_refusal = decision.blocked_action.is_some();
        if decision.kind == "outage" {
            decision.continuation = "unavailable".into();
            decision.recovery = if live {
                crate::safety_block::outage_guidance().into()
            } else {
                "This attempt has settled or was superseded. Claude's safety check was unavailable for this command, so it did not run and was not approved. Inspect the task and explicitly retry if needed; a retry grants no permission.".into()
            };
        } else if decision.status == "pending" && live && !claude_refusal {
            decision.continuation = "new_turn_same_attempt".into();
            decision.recovery = "Use the existing safety card in the main chat. The rejected call already ended; a decision can authorize a new turn in this attempt, not resume that call.".into();
        } else {
            decision.continuation = "unavailable".into();
            if !live {
                decision.recovery = "This attempt has settled or was superseded. Its old card cannot resume it. Inspect the task and explicitly retry if needed; a retry grants no permission.".into();
            } else if claude_refusal && decision.status == "allowed_exact" {
                // Recorded by an earlier build that offered a one-time
                // rule. It stays as history and authorizes nothing now.
                decision.recovery = "History only: an earlier OctiqFlow build recorded a one-time allowance for this exact command. That allowance was withdrawn because it could not be enforced as one use, and it authorizes nothing now. Do not run the command on the strength of it. Claude's auto mode refusal stands: continue another safe way, or settle the attempt blocked and name the refused command.".into();
            } else if claude_refusal {
                decision.recovery = CLAUDE_REFUSAL_RECOVERY.into();
            } else if decision.status == "closed" {
                decision.recovery = "The card is no longer pending. Its absence does not prove approval. Inspect the person's recorded decision before continuing.".into();
            } else if decision.status == "dismissed" || decision.status == "superseded" {
                decision.recovery = "The card was dismissed or superseded by a new message: the person did not allow the blocked action, and its absence does not prove approval. Do not retry it; follow the person's latest instruction.".into();
            } else if decision.status == "authorized_project" {
                decision.recovery = "The person saved a project-scoped authorization for this kind of action; it reaches the agent's next launch as instructions, not as a resumed call.".into();
            }
        }
    }
}

impl OrchestrationStore {
    /// Whether a card raised in this chat can still continue a worker attempt:
    /// None when the chat is no worker's, else whether its attempt is the live
    /// one of its task. A settled or superseded attempt cannot be continued.
    pub(crate) fn worker_card_live(&self, chat_key: &str) -> Result<Option<bool>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let data = &inner.data;
        let mut attempts = data
            .attempts
            .values()
            .filter(|a| a.worker_chat_key == chat_key)
            .peekable();
        if attempts.peek().is_none() {
            return Ok(None);
        }
        Ok(Some(attempts.any(|a| {
            matches!(a.status, AttemptStatus::Preparing | AttemptStatus::Running)
                && data
                    .tasks
                    .get(&a.task_id)
                    .is_some_and(|t| t.active_attempt_id.as_deref() == Some(&a.id))
        })))
    }

    /// The attempt a refusal in this chat belongs to (`chat_owner`), for
    /// grouping an outage refusal by attempt before it reaches the ledger.
    pub(crate) fn refusal_owner(&self, chat_key: &str) -> Option<String> {
        let inner = self.inner.lock().ok()?;
        chat_owner(&inner.data, chat_key).map(|a| a.id.clone())
    }

    pub(crate) fn capture_native_decisions(&self) -> Result<(), String> {
        let pending = crate::safety_block::decision_summaries();
        let fresh: Vec<_> = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            pending
                .into_iter()
                .filter(|card| {
                    !inner.data.native_decisions.contains_key(&card.id)
                        && inner
                            .data
                            .attempts
                            .values()
                            .any(|a| a.worker_chat_key == card.chat_key)
                })
                .collect()
        };
        if fresh.is_empty() {
            return Ok(());
        }
        let runs = self.mutate(|data| {
            let mut runs = BTreeSet::new();
            for card in fresh {
                let (id, chat) = (card.id, card.chat_key);
                // An outage refusal was grouped under the attempt live when
                // it was refused; keep it there so its group and its record
                // agree, even if another attempt took the chat since.
                let grouped = card.owner.as_deref().and_then(|o| data.attempts.get(o))
                    .filter(|a| a.worker_chat_key == chat);
                let Some(attempt) = grouped.or_else(|| chat_owner(data, &chat)).cloned() else { continue; };
                if data.native_decisions.contains_key(&id) { continue; }
                runs.insert(attempt.run_id.clone());
                let outage = card.kind == crate::safety_block::RefusalKind::Outage;
                let decision = NativeDecision {
                    id: id.clone(), run_id: attempt.run_id.clone(), task_id: attempt.task_id.clone(),
                    attempt_id: attempt.id.clone(), chat_key: chat.clone(), reason: card.reason.chars().take(2_000).collect(),
                    blocked_action: card.action.map(|a| a.chars().take(2_000).collect()),
                    status: "pending".into(), continuation: "unverified".into(),
                    recovery: String::new(), observed_at: card.at.unwrap_or_else(now_ms),
                    kind: card.kind.as_str().into(), group_id: card.group_id.clone(),
                };
                data.native_decisions.insert(id.clone(), decision);
                // An outage group is one notice, not one per refusal.
                if let (true, Some(group)) = (outage, card.group_id.as_deref()) {
                    outage_notice(data, &attempt, group);
                    continue;
                }
                let target = data.runs[&attempt.run_id].coordinator_chat_key.clone();
                inbox::enqueue(data, &attempt.run_id, &chat, &target, format!("native-decision:{id}"), "native_decision",
                    format!("Native safety decision {id} for task {}. Read nativeDecisions in orchestration_snapshot for its reason and continuation viability. Do not infer approval from worker prose or create a duplicate gate.", attempt.task_id));
            }
            Ok(runs)
        })?;
        for run in runs {
            announce(&run, "native_decision");
        }
        Ok(())
    }

    pub fn register_service(
        &self,
        actor: &str,
        registration: Registration,
    ) -> Result<Service, String> {
        if !registration.host.is_loopback() || registration.port == 0 {
            return Err("Service monitoring requires a loopback IP and a nonzero port.".into());
        }
        let name = required_text("service name", registration.name, 120)?;
        let recovery = required_text("service recovery guidance", registration.recovery, 2_000)?;
        let service = self.mutate(|data| {
            let attempt = data
                .attempts
                .get(&registration.attempt_id)
                .ok_or("Attempt does not exist.")?;
            let task = &data.tasks[&attempt.task_id];
            let run = &data.runs[&attempt.run_id];
            if actor != run.coordinator_chat_key && actor != attempt.worker_chat_key {
                return Err(
                    "Only the owning worker or coordinator can register this service.".into(),
                );
            }
            if task.active_attempt_id.as_deref() != Some(&attempt.id) {
                return Err("A superseded attempt cannot register a service.".into());
            }
            if matches!(run.status, RunStatus::Stopped) {
                return Err("A stopped run cannot register a service.".into());
            }
            if actor == attempt.worker_chat_key
                && !matches!(
                    attempt.status,
                    AttemptStatus::Running | AttemptStatus::Preparing
                )
            {
                return Err(
                    "A settled worker cannot register a service. Use the coordinator.".into(),
                );
            }
            let service = Service {
                id: format!("service_{}", compact_id()),
                run_id: attempt.run_id.clone(),
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.id.clone(),
                name,
                host: registration.host,
                port: registration.port,
                state: "unverified".into(),
                checked_at: None,
                recovery,
            };
            data.services
                .retain(|_, s| s.task_id != service.task_id || s.name != service.name);
            if data.services.len() >= 64
                || data
                    .services
                    .values()
                    .filter(|s| s.run_id == service.run_id)
                    .count()
                    >= 16
            {
                return Err(
                    "Service monitoring is limited to 16 per run and 64 per profile.".into(),
                );
            }
            data.services.insert(service.id.clone(), service.clone());
            Ok(service)
        })?;
        announce(&service.run_id, "service_registered");
        Ok(service)
    }

    /// Bounded local probes only, with no shell, DNS, credentials or HTTP payload.
    pub(crate) fn check_services(&self, now: i64) -> Result<(), String> {
        self.check_services_with(now, |service| {
            TcpStream::connect_timeout(
                &SocketAddr::new(service.host, service.port),
                Duration::from_millis(100),
            )
            .is_ok()
        })
    }

    /// `check_services` with the reachability probe given, so a test can
    /// say "nothing listens now" without releasing a port that a parallel
    /// test may bind again the next moment.
    fn check_services_with(
        &self,
        now: i64,
        listening: impl Fn(&Service) -> bool,
    ) -> Result<(), String> {
        let candidates: Vec<_> = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner
                .data
                .services
                .values()
                .filter(|s| {
                    s.checked_at
                        .is_none_or(|at| now.saturating_sub(at) >= 10_000)
                        && inner
                            .data
                            .runs
                            .get(&s.run_id)
                            .is_some_and(|r| r.status != RunStatus::Stopped)
                })
                .cloned()
                .collect()
        };
        if candidates.is_empty() {
            return Ok(());
        }
        let observations: Vec<_> = candidates
            .into_iter()
            .map(|service| {
                let state = if listening(&service) {
                    "listening"
                } else {
                    "stopped"
                };
                (service, state)
            })
            .collect();
        let runs = self.mutate(|data| {
            let mut runs = BTreeSet::new();
            for (before, state) in observations {
                let Some(service) = data.services.get_mut(&before.id) else { continue; };
                let changed = service.state != state;
                service.state = state.into();
                service.checked_at = Some(now);
                let service = service.clone();
                if changed {
                    runs.insert(service.run_id.clone());
                    service_notice(data, &service, if state == "stopped" { "The local listener is not reachable." } else { "The local listener is reachable; application health still needs verification." });
                }
            }
            Ok(runs)
        })?;
        for run in runs {
            announce(&run, "service_health");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn worker(store: &OrchestrationStore) -> (Run, Attempt) {
        let run = super::super::tests::run(store);
        let task = super::super::tests::task(store, &run, vec![]);
        let (_, _, attempt, _) = store
            .reserve_attempt(
                "chat:master",
                &WorkerLaunch {
                    task_id: task.id,
                    agent: ChatAgent::Codex,
                    model: None,
                    effort: None,
                    access: Access::Auto,
                    new_worktree: Some(true),
                    base_branch: String::new(),
                },
            )
            .unwrap();
        let attempt = store
            .activate_attempt(&attempt.id, "/tmp".into(), "worker".into(), true)
            .unwrap();
        (run, attempt)
    }

    fn register(attempt: &Attempt, port: u16) -> Registration {
        Registration {
            attempt_id: attempt.id.clone(),
            name: "Frontend".into(),
            host: "127.0.0.1".parse().unwrap(),
            port,
            recovery: "Restore the retained frontend workspace, then verify application health."
                .into(),
        }
    }

    #[test]
    fn native_decision_visibility_is_scoped_and_does_not_invent_action_or_approval() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        crate::safety_block::observe(ChatAgent::Codex, &attempt.worker_chat_key,
            "codex_core::tools::router: error=This action was rejected due to unacceptable risk.\\nReason: Upload requires a decision.");
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let decision = &snapshot.native_decisions[0];
        assert_eq!(decision.status, "pending");
        assert_eq!(decision.attempt_id, attempt.id);
        assert_eq!(decision.reason, "Upload requires a decision.");
        assert_eq!(decision.continuation, "new_turn_same_attempt");
        assert!(decision.blocked_action.is_none());
        let view = agent_view::agent_snapshot(
            snapshot,
            &agent_view::AgentRead {
                actor: "chat:master",
                run_id: Some(&run.id),
                task_id: None,
                message_limit: 12,
            },
        )
        .unwrap();
        assert_eq!(view["nativeDecisions"][0]["attemptId"], attempt.id);
        assert!(store
            .snapshot(Some("different-run"))
            .unwrap()
            .native_decisions
            .is_empty());
        crate::safety_block::forget_chat(&attempt.worker_chat_key);
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        // How it went, not merely that it went: a new message superseded it.
        assert_eq!(snapshot.native_decisions[0].status, "superseded");
        assert_eq!(snapshot.native_decisions[0].continuation, "unavailable");
        assert!(snapshot.native_decisions[0]
            .recovery
            .contains("does not prove approval"));
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id,
                    outcome: WorkerOutcome::Blocked,
                    summary: "Upload remains blocked".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        assert!(store.snapshot(Some(&run.id)).unwrap().native_decisions[0]
            .recovery
            .contains("settled"));
    }

    /// Feedback 56dd3f24: a Claude worker refused by auto mode left no
    /// decision record (nativeDecisions empty, later "stalled"). It is a
    /// decision now, naming the refused call. d59f830a (a way to allow that
    /// exact call) stays open: nothing can approve it, and the record says so.
    #[test]
    fn a_claude_auto_mode_refusal_is_recorded_and_offers_no_approval() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        let chat = attempt.worker_chat_key.clone();
        let line = "eas update --branch production --message 'OTA 1.4.2'";
        let input = json!({ "command": line });
        let denial = json!({
            "type": "system", "subtype": "permission_denied",
            "decision_reason": "[Production Deploy]", "decision_reason_type": "classifier",
            "message": "Permission for this action was denied by the Claude Code auto mode classifier.",
            "tool_name": "Bash", "tool_use_id": "toolu_ota",
        });
        assert!(crate::safety_block::observe_claude_denial(
            &chat,
            None,
            &denial,
            Some(("Bash", &input))
        ));
        store.capture_native_decisions().unwrap();
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let decision = &snapshot.native_decisions[0];
        assert_eq!(decision.status, "pending");
        assert_eq!(decision.attempt_id, attempt.id);
        assert_eq!(decision.blocked_action.as_deref(), Some(line));
        assert!(
            decision.reason.contains("Production Deploy"),
            "{}",
            decision.reason
        );
        // Honest: the card cannot continue anything, and says what can.
        assert_eq!(decision.continuation, "unavailable");
        assert!(
            decision.recovery.contains("cannot approve it"),
            "{}",
            decision.recovery
        );
        assert!(decision.recovery.contains("settle the attempt blocked"));
        // Nothing reached the worker telling it a rule is on its way.
        assert!(!snapshot
            .notifications
            .iter()
            .any(|n| n.target_chat_key == chat && n.kind == "native_decision"));
        // Nothing can allow it, so it holds nothing open: the worker can
        // settle blocked while the card is still up (a Codex card, whose
        // "allow" can continue the attempt, would refuse this).
        assert!(!crate::safety_block::awaits_decision(&chat));
        store
            .report_worker(
                &chat,
                WorkerReport {
                    attempt_id: attempt.id,
                    outcome: WorkerOutcome::Blocked,
                    summary: "Auto mode refused `eas update`; the person must run it.".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        crate::safety_block::forget_chat(&chat);
    }

    /// A record from the build that offered "allow this exact command once"
    /// — the decision it labelled allowed_exact and the notice it queued for
    /// the worker — is history. The notice is never delivered, and the
    /// decision authorizes nothing.
    #[test]
    fn a_stale_one_time_allowance_is_history_not_authority() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        let chat = attempt.worker_chat_key.clone();
        store
            .mutate(|data| {
                data.native_decisions.insert(
                    "old-card".into(),
                    NativeDecision {
                        id: "old-card".into(),
                        run_id: run.id.clone(),
                        task_id: attempt.task_id.clone(),
                        attempt_id: attempt.id.clone(),
                        chat_key: chat.clone(),
                        reason: "Claude's auto mode blocked an action: Production Deploy".into(),
                        blocked_action: Some("eas update --branch production".into()),
                        status: "allowed_exact".into(),
                        continuation: "new_turn_same_attempt".into(),
                        recovery: String::new(),
                        observed_at: 1,
                        kind: "safety".into(),
                        group_id: None,
                    },
                );
                inbox::enqueue(
                    data,
                    &run.id,
                    "host",
                    &chat,
                    "exact-grant:old-card".into(),
                    "native_decision",
                    "Your next agent launch carries a permission rule for that exact line.".into(),
                );
                Ok(())
            })
            .unwrap();
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let decision = &snapshot.native_decisions[0];
        assert_eq!(decision.status, "allowed_exact", "kept as history");
        assert_eq!(decision.continuation, "unavailable");
        assert!(
            decision.recovery.starts_with("History only"),
            "{}",
            decision.recovery
        );
        assert!(decision.recovery.contains("authorizes nothing"));

        // Due, but never handed to the worker: claiming it cancels it.
        let due = store.due_notifications(i64::MAX).unwrap();
        let stale = due
            .iter()
            .find(|n| n.source == "exact-grant:old-card")
            .expect("queued");
        assert!(store
            .claim_notification(&stale.id, now_ms())
            .unwrap()
            .is_none());
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert!(snapshot
            .notifications
            .iter()
            .filter(|n| n.source.starts_with("exact-grant"))
            .all(|n| n.state == inbox::DeliveryState::Cancelled));

        // And a restart cancels one before anything tries to deliver it.
        store
            .mutate(|data| {
                inbox::enqueue(
                    data,
                    &run.id,
                    "host",
                    &chat,
                    "exact-grant-note:old-card".into(),
                    "native_decision",
                    "OctiqFlow delivered it to the worker.".into(),
                );
                assert!(recover(data));
                assert!(data
                    .notifications
                    .values()
                    .filter(|n| n.source.starts_with("exact-grant"))
                    .all(|n| n.state == inbox::DeliveryState::Cancelled));
                Ok(())
            })
            .unwrap();
    }

    fn outage(id: &str) -> Value {
        json!({
            "type": "system", "subtype": "permission_denied",
            "decision_reason": "Classifier unavailable", "decision_reason_type": "classifier",
            "message": "The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. This is a transient failure of the check, not a judgment about the action.",
            "tool_name": "Bash", "tool_use_id": id,
        })
    }

    /// Refuse `line` for an outage at `at`, as the chat reader would: under
    /// the attempt live in the chat.
    fn refuse(store: &OrchestrationStore, chat: &str, id: &str, line: &str, at: i64) {
        assert!(crate::safety_block::observe_claude_refusal(
            chat,
            store.refusal_owner(chat).as_deref(),
            &outage(id),
            Some(("Bash", &json!({ "command": line }))),
            at
        ));
        store.capture_native_decisions().unwrap();
    }

    fn outage_notices(store: &OrchestrationStore, run: &Run) -> Vec<inbox::Notification> {
        let mut notices: Vec<_> = store
            .snapshot(Some(&run.id))
            .unwrap()
            .notifications
            .into_iter()
            .filter(|n| n.source.starts_with(OUTAGE_NOTICE))
            .collect();
        notices.sort_by_key(|n| n.next_attempt_at);
        notices
    }

    /// Feedback 664f03c0: nine refusals in one short outage were nine cards
    /// and nine coordinator turns. They are one group, one notice, and every
    /// refusal is still in the ledger.
    #[test]
    fn an_outage_is_one_group_one_notice_and_every_refusal_is_kept() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        let chat = attempt.worker_chat_key.clone();
        let t = now_ms() - 60_000;
        refuse(&store, &chat, "toolu_o1", "git fetch", t);
        refuse(&store, &chat, "toolu_o2", "git fetch", t + 10_000);
        refuse(&store, &chat, "toolu_o3", "cat POLICY.md", t + 20_000);

        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let decisions: Vec<_> = snapshot
            .native_decisions
            .iter()
            .filter(|d| d.chat_key == chat)
            .collect();
        assert_eq!(decisions.len(), 3, "nothing is deleted");
        let group = decisions[0].group_id.clone().expect("grouped");
        for d in &decisions {
            assert_eq!(d.kind, "outage");
            assert_eq!(d.group_id.as_deref(), Some(group.as_str()));
            assert_eq!(d.attempt_id, attempt.id);
            assert_eq!(d.continuation, "unavailable");
            // The same words as the card and the worker prompt.
            assert_eq!(d.recovery, crate::safety_block::outage_guidance());
            assert!(
                d.reason.contains("safety check was unavailable"),
                "{}",
                d.reason
            );
            assert!(!d.reason.contains("blocked an action"));
        }
        let mut actions: Vec<_> = decisions
            .iter()
            .filter_map(|d| d.blocked_action.as_deref())
            .collect();
        actions.sort();
        assert_eq!(actions, ["cat POLICY.md", "git fetch", "git fetch"]);
        assert!(snapshot
            .notifications
            .iter()
            .all(|n| !n.source.starts_with("native-decision:")));

        let notices = outage_notices(&store, &run);
        assert_eq!(notices.len(), 1, "one notice for the group");
        let notice = &notices[0];
        assert_eq!(notice.target_chat_key, run.coordinator_chat_key);
        assert_eq!(notice.source, format!("{OUTAGE_NOTICE}{group}"));
        assert!(notice.body.contains("3 refused call(s)"), "{}", notice.body);
        assert!(notice.body.contains("`git fetch` ×2"), "{}", notice.body);
        let due = crate::safety_block::outage_group_due(t, t + 20_000, 3);
        assert_eq!(notice.next_attempt_at, due);
        // Not before the group closes...
        assert!(store
            .claim_notification(&notice.id, due - 1)
            .unwrap()
            .is_none());
        // ...and then it goes: the worker has run nothing since.
        assert!(store.claim_notification(&notice.id, due).unwrap().is_some());
        crate::safety_block::forget_chat(&chat);
    }

    /// A worker that moved on after the outage does not start a coordinator
    /// turn for it. Its refused call's own result, and its status reports,
    /// do not count as moving on.
    #[test]
    fn an_outage_the_worker_moved_past_is_recorded_but_not_delivered() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        let chat = attempt.worker_chat_key.clone();
        let t = now_ms() - 5_000;
        let call = |id: &str, name: &str| {
            json!({"type":"assistant","message":{"content":[
                {"type":"tool_use","id":id,"name":name,"input":{}}]}})
        };
        let result = |id: &str| {
            json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":id,"content":"x","is_error":true}]}})
        };
        store
            .observe_worker_event(&chat, &call("toolu_r1", "Bash"))
            .unwrap();
        refuse(&store, &chat, "toolu_r1", "git fetch", t);
        // The refusal's own error result comes right after it.
        store
            .observe_worker_event(&chat, &result("toolu_r1"))
            .unwrap();
        // A status report alone is not moving on.
        store
            .observe_worker_event(&chat, &call("toolu_s1", "mcp__octiq__task_status"))
            .unwrap();
        store
            .observe_worker_event(&chat, &result("toolu_s1"))
            .unwrap();
        let notice = outage_notices(&store, &run).remove(0);
        let due = notice.next_attempt_at;
        store
            .mutate(|data| {
                assert!(
                    outage_notice_valid(data, &notice),
                    "nothing allowed ran yet"
                );
                Ok(())
            })
            .unwrap();

        // An allowed call that came back is.
        store
            .observe_worker_event(&chat, &call("toolu_ok", "Read"))
            .unwrap();
        store
            .observe_worker_event(&chat, &result("toolu_ok"))
            .unwrap();
        assert!(store.claim_notification(&notice.id, due).unwrap().is_none());
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let n = snapshot
            .notifications
            .iter()
            .find(|n| n.id == notice.id)
            .unwrap();
        assert_eq!(n.state, inbox::DeliveryState::Cancelled);
        // The group is still on the record.
        assert!(snapshot
            .native_decisions
            .iter()
            .any(|d| d.chat_key == chat && d.kind == "outage"));
        crate::safety_block::forget_chat(&chat);
    }

    fn tool_call(id: &str, name: &str) -> Value {
        json!({"type":"assistant","message":{"content":[
            {"type":"tool_use","id":id,"name":name,"input":{}}]}})
    }

    fn tool_result(id: &str) -> Value {
        json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":id,"content":"x"}]}})
    }

    fn notice_useful(store: &OrchestrationStore, notice: &inbox::Notification) -> bool {
        store
            .mutate(|data| Ok(outage_notice_valid(data, notice)))
            .unwrap()
    }

    /// Review of 2cbc3e9 (Tofu): Claude runs two calls at once, refuses one
    /// for an outage, and the other, already running, comes back after the
    /// refusal. That call started before the refusal, so it says nothing
    /// about the worker having moved on, and the notice must still go.
    #[test]
    fn a_parallel_call_that_returns_after_the_refusal_does_not_cancel_the_notice() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        let chat = attempt.worker_chat_key.clone();
        // Both calls in one assistant message, as Claude sends parallel ones.
        store
            .observe_worker_event(
                &chat,
                &json!({"type":"assistant","message":{"content":[
                    {"type":"tool_use","id":"toolu_pa","name":"Bash","input":{}},
                    {"type":"tool_use","id":"toolu_pb","name":"Read","input":{}}]}}),
            )
            .unwrap();
        refuse(&store, &chat, "toolu_pa", "git fetch", now_ms() + 1);
        store
            .observe_worker_event(&chat, &tool_result("toolu_pa"))
            .unwrap();
        // It comes back clearly after the refusal.
        std::thread::sleep(std::time::Duration::from_millis(10));
        store
            .observe_worker_event(&chat, &tool_result("toolu_pb"))
            .unwrap();
        let notice = outage_notices(&store, &run).remove(0);
        assert!(
            notice_useful(&store, &notice),
            "the parallel call started before the refusal"
        );
        assert!(store
            .claim_notification(&notice.id, notice.next_attempt_at)
            .unwrap()
            .is_some());
        crate::safety_block::forget_chat(&chat);
    }

    /// A long build started before the refusal and finishing after it is not
    /// moving on either; a call started after the refusal is.
    #[test]
    fn a_long_call_started_before_the_refusal_does_not_cancel_the_notice() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        let chat = attempt.worker_chat_key.clone();
        store
            .observe_worker_event(&chat, &tool_call("toolu_build", "Bash"))
            .unwrap();
        // A background agent's call is refused while the build runs.
        store
            .observe_worker_event(&chat, &tool_call("toolu_ref", "Bash"))
            .unwrap();
        let refused_at = now_ms() + 1;
        refuse(&store, &chat, "toolu_ref", "git fetch", refused_at);
        store
            .observe_worker_event(&chat, &tool_result("toolu_ref"))
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        store
            .observe_worker_event(&chat, &tool_result("toolu_build"))
            .unwrap();
        let notice = outage_notices(&store, &run).remove(0);
        assert!(notice_useful(&store, &notice));
        let started = store
            .snapshot(Some(&run.id))
            .unwrap()
            .attempts
            .into_iter()
            .find(|a| a.id == attempt.id)
            .unwrap()
            .execution
            .last_allowed_tool_started_at
            .expect("the build ran");
        assert!(started < refused_at, "its START is what was recorded");

        // Control: a call started after the refusal does cancel it.
        store
            .observe_worker_event(&chat, &tool_call("toolu_after", "Read"))
            .unwrap();
        store
            .observe_worker_event(&chat, &tool_result("toolu_after"))
            .unwrap();
        assert!(!notice_useful(&store, &notice));
        crate::safety_block::forget_chat(&chat);
    }

    /// A result whose call was never seen starting (no name, no start) is not
    /// proof that anything allowed ran.
    #[test]
    fn a_result_with_no_pending_call_does_not_count_as_allowed() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        let chat = attempt.worker_chat_key.clone();
        refuse(&store, &chat, "toolu_u1", "git fetch", now_ms() - 5_000);
        store
            .observe_worker_event(&chat, &tool_result("toolu_never_started"))
            .unwrap();
        let notice = outage_notices(&store, &run).remove(0);
        assert!(notice_useful(&store, &notice));
        let execution = store
            .snapshot(Some(&run.id))
            .unwrap()
            .attempts
            .into_iter()
            .find(|a| a.id == attempt.id)
            .unwrap()
            .execution;
        assert!(execution.last_allowed_tool_started_at.is_none());
        assert!(execution.pending_tool_started_at.is_empty());
        crate::safety_block::forget_chat(&chat);
    }

    /// Review of 2cbc3e9: a retry that reuses the worker chat inside the
    /// window used to join the settled attempt's group, and the notice could
    /// then be judged by the settled attempt and cancelled.
    #[test]
    fn a_retry_in_the_same_chat_starts_its_own_outage_group() {
        let store = OrchestrationStore::default();
        let (run, first) = worker(&store);
        let chat = first.worker_chat_key.clone();
        let t = now_ms() - 30_000;
        refuse(&store, &chat, "toolu_first", "git fetch", t);
        store
            .report_worker(
                &chat,
                WorkerReport {
                    attempt_id: first.id.clone(),
                    outcome: WorkerOutcome::Blocked,
                    summary: "`git fetch` was refused during the outage.".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        let (_, _, retry, _) = store
            .reserve_attempt(
                "chat:master",
                &WorkerLaunch {
                    task_id: first.task_id.clone(),
                    agent: ChatAgent::Codex,
                    model: None,
                    effort: None,
                    access: Access::Auto,
                    new_worktree: Some(false),
                    base_branch: String::new(),
                },
            )
            .unwrap();
        let retry = store
            .activate_attempt(&retry.id, "/tmp".into(), "worker".into(), true)
            .unwrap();
        store
            .mutate(|data| {
                data.attempts.get_mut(&retry.id).unwrap().worker_chat_key = chat.clone();
                Ok(())
            })
            .unwrap();
        // Well inside the first group's window.
        refuse(&store, &chat, "toolu_retry", "git fetch", t + 10_000);

        let decisions: Vec<_> = store
            .snapshot(Some(&run.id))
            .unwrap()
            .native_decisions
            .into_iter()
            .filter(|d| d.chat_key == chat)
            .collect();
        assert_eq!(decisions.len(), 2);
        let first_decision = decisions.iter().find(|d| d.attempt_id == first.id).unwrap();
        let retry_decision = decisions.iter().find(|d| d.attempt_id == retry.id).unwrap();
        assert_ne!(
            first_decision.group_id, retry_decision.group_id,
            "a group belongs to one attempt"
        );
        let notices = outage_notices(&store, &run);
        assert_eq!(notices.len(), 2);
        let notice_for = |d: &NativeDecision| {
            let source = format!("{OUTAGE_NOTICE}{}", d.group_id.as_deref().unwrap());
            notices.iter().find(|n| n.source == source).unwrap().clone()
        };
        // The settled attempt's group is not delivered; the retry's is.
        assert!(!notice_useful(&store, &notice_for(first_decision)));
        let retry_notice = notice_for(retry_decision);
        assert!(notice_useful(&store, &retry_notice));
        assert!(retry_notice.body.contains(&retry.id));
        assert!(store
            .claim_notification(&retry_notice.id, retry_notice.next_attempt_at)
            .unwrap()
            .is_some());
        crate::safety_block::forget_chat(&chat);
    }

    /// The usefulness check reads the attempt of the group's latest refusal,
    /// whatever order the records sit in.
    #[test]
    fn the_usefulness_check_judges_the_latest_refusals_attempt() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        let chat = attempt.worker_chat_key.clone();
        let t = now_ms() - 30_000;
        refuse(&store, &chat, "toolu_l1", "git fetch", t);
        refuse(&store, &chat, "toolu_l2", "ls", t + 1_000);
        let notice = outage_notices(&store, &run).remove(0);
        let group = notice
            .source
            .strip_prefix(OUTAGE_NOTICE)
            .unwrap()
            .to_string();
        // An older record in the group that names a settled, unknown attempt
        // (as a mis-grouped one did) must not decide it, even if it sorts
        // first by id.
        store
            .mutate(|data| {
                let mut stale = data
                    .native_decisions
                    .values()
                    .find(|d| d.group_id.as_deref() == Some(group.as_str()))
                    .unwrap()
                    .clone();
                stale.id = "0000-stale".into();
                stale.attempt_id = "attempt-gone".into();
                stale.observed_at = t - 1_000;
                data.native_decisions.insert(stale.id.clone(), stale);
                Ok(())
            })
            .unwrap();
        assert!(notice_useful(&store, &notice));
        crate::safety_block::forget_chat(&chat);
    }

    #[test]
    fn an_outage_notice_for_a_settled_attempt_is_not_delivered() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        let chat = attempt.worker_chat_key.clone();
        let t = now_ms();
        refuse(&store, &chat, "toolu_x1", "git fetch", t);
        store
            .report_worker(
                &chat,
                WorkerReport {
                    attempt_id: attempt.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "Done without `git fetch`, which the outage refused.".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        let notice = outage_notices(&store, &run).remove(0);
        assert!(store
            .claim_notification(&notice.id, notice.next_attempt_at)
            .unwrap()
            .is_none());
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let decision = snapshot
            .native_decisions
            .iter()
            .find(|d| d.chat_key == chat)
            .unwrap();
        assert!(
            decision.recovery.contains("settled"),
            "{}",
            decision.recovery
        );
        crate::safety_block::forget_chat(&chat);
    }

    /// Coordinator review (B): a worker refused every minute for ten minutes
    /// never lets a sliding window close, but its coordinator still hears.
    #[test]
    fn a_worker_refused_every_minute_still_reaches_its_coordinator() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        let chat = attempt.worker_chat_key.clone();
        let t = now_ms();
        for minute in 0..=10 {
            refuse(
                &store,
                &chat,
                &format!("toolu_m{minute}"),
                "git fetch",
                t + minute * 60_000,
            );
        }
        let notices = outage_notices(&store, &run);
        assert_eq!(notices.len(), 3, "{notices:#?}");
        assert_eq!(notices[0].next_attempt_at, t + 4 * 60_000, "five refusals");
        assert_eq!(notices[1].next_attempt_at, t + 9 * 60_000);
        assert_eq!(notices[2].next_attempt_at, t + 12 * 60_000);
        for notice in &notices {
            assert!(store
                .claim_notification(&notice.id, notice.next_attempt_at)
                .unwrap()
                .is_some());
        }
        let decisions = store.snapshot(Some(&run.id)).unwrap().native_decisions;
        assert_eq!(decisions.iter().filter(|d| d.chat_key == chat).count(), 11);
        crate::safety_block::forget_chat(&chat);
    }

    /// Real safety refusals keep one notice each, due at once.
    #[test]
    fn a_safety_refusal_still_notifies_once_per_refusal() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        let chat = attempt.worker_chat_key.clone();
        for id in ["toolu_p1", "toolu_p2"] {
            let denial = json!({
                "type": "system", "subtype": "permission_denied",
                "decision_reason": "[Production Deploy]", "decision_reason_type": "classifier",
                "message": "denied", "tool_name": "Bash", "tool_use_id": id,
            });
            assert!(crate::safety_block::observe_claude_denial(
                &chat,
                None,
                &denial,
                Some(("Bash", &json!({ "command": "eas update" })))
            ));
            store.capture_native_decisions().unwrap();
        }
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let decisions: Vec<_> = snapshot
            .native_decisions
            .iter()
            .filter(|d| d.chat_key == chat)
            .collect();
        assert_eq!(decisions.len(), 2);
        assert!(decisions
            .iter()
            .all(|d| d.kind == "safety" && d.group_id.is_none()));
        // Pinned, and strict: the outage retry never reaches a safety refusal.
        for d in &decisions {
            assert_eq!(d.recovery, CLAUDE_REFUSAL_RECOVERY);
            assert!(!d.recovery.contains(crate::safety_block::OUTAGE_RETRY));
            assert!(!d.recovery.contains("once more"));
        }
        assert_eq!(
            CLAUDE_REFUSAL_RECOVERY,
            "Claude's auto mode refused this call without asking anyone, and OctiqFlow cannot approve it: there is no supported way to allow one refused call before it runs. The card only records the refusal. Do not retry the call or reword it to get past the classifier. Continue another safe way, or settle the attempt blocked and name the refused command so the person can decide."
        );
        let notices: Vec<_> = snapshot
            .notifications
            .iter()
            .filter(|n| n.source.starts_with("native-decision:"))
            .filter(|n| decisions.iter().any(|d| n.source.ends_with(&d.id)))
            .collect();
        assert_eq!(notices.len(), 2);
        assert!(notices.iter().all(|n| n.next_attempt_at <= now_ms()));
        crate::safety_block::forget_chat(&chat);
    }

    /// A decision stored before `kind` and `groupId` existed loads as a
    /// safety refusal and renders as before.
    #[test]
    fn a_decision_stored_before_outage_kinds_still_loads() {
        let old: NativeDecision = serde_json::from_value(json!({
            "id": "old-1", "runId": "run", "taskId": "task", "attemptId": "attempt",
            "chatKey": "chat:old", "reason": "Claude's auto mode blocked an action: Classifier unavailable",
            "blockedAction": "git fetch", "status": "dismissed", "continuation": "unavailable",
            "recovery": "", "observedAt": 1,
        }))
        .unwrap();
        assert_eq!(old.kind, "safety");
        assert!(old.group_id.is_none());

        let root = std::env::temp_dir().join(format!("octiq-lifecycle-old-{}", compact_id()));
        let path = root.join("state.json");
        let store = OrchestrationStore::load(path.clone());
        let (run, attempt) = worker(&store);
        store
            .mutate(|data| {
                let mut old = old.clone();
                old.run_id = run.id.clone();
                old.task_id = attempt.task_id.clone();
                old.attempt_id = attempt.id.clone();
                data.native_decisions.insert(old.id.clone(), old);
                Ok(())
            })
            .unwrap();
        drop(store);
        // Strip the new fields from disk, as an older build wrote it.
        let mut raw: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let stored = &mut raw["native_decisions"]["old-1"];
        assert!(stored.is_object(), "{raw}");
        stored.as_object_mut().unwrap().remove("kind");
        stored.as_object_mut().unwrap().remove("groupId");
        fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();

        let restored = OrchestrationStore::load(path);
        let snapshot = restored.snapshot(Some(&run.id)).unwrap();
        let decision = &snapshot.native_decisions[0];
        assert_eq!(decision.id, "old-1");
        assert_eq!(decision.kind, "safety");
        assert_eq!(decision.status, "dismissed");
        assert_eq!(decision.continuation, "unavailable");
        // A reload settles the attempt it belonged to; the old record gets
        // the ordinary safety wording for that, not the outage guidance.
        assert!(
            decision.recovery.contains("settled"),
            "{}",
            decision.recovery
        );
        assert_ne!(decision.recovery, crate::safety_block::outage_guidance());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registered_service_lifetime_is_independent_of_completed_task() {
        let store = OrchestrationStore::default();
        let (run, attempt) = worker(&store);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        store
            .register_service(&attempt.worker_chat_key, register(&attempt, port))
            .unwrap();
        store.check_services(100_000).unwrap();
        assert_eq!(
            store.snapshot(Some(&run.id)).unwrap().services[0].state,
            "listening"
        );
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "Frontend started".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        // The frontend goes away. Probed as gone rather than by dropping the
        // listener: a released ephemeral port is bound again by a parallel
        // test often enough to make the real probe flaky here.
        drop(listener);
        store.check_services_with(110_001, |_| false).unwrap();
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert_eq!(snapshot.tasks[0].status, TaskStatus::Completed);
        assert_eq!(snapshot.services[0].state, "stopped");
        assert_eq!(snapshot.services[0].checked_at, Some(110_001));
        assert!(snapshot
            .notifications
            .iter()
            .any(|n| n.kind == "service" && n.body.contains("not reachable")));
        assert!(store
            .register_service(&attempt.worker_chat_key, register(&attempt, port))
            .is_err());
        store
            .register_service("chat:master", register(&attempt, port))
            .unwrap();
        assert_eq!(store.snapshot(Some(&run.id)).unwrap().services.len(), 1);
    }

    #[test]
    fn service_registration_checks_owner_staleness_and_loopback() {
        let store = OrchestrationStore::default();
        let (_, attempt) = worker(&store);
        assert!(store
            .register_service("chat:stranger", register(&attempt, 3001))
            .is_err());
        let mut external = register(&attempt, 3001);
        external.host = "192.0.2.1".parse().unwrap();
        assert!(store.register_service("chat:master", external).is_err());
        store
            .mutate(|data| {
                data.tasks
                    .get_mut(&attempt.task_id)
                    .unwrap()
                    .active_attempt_id = Some("newer".into());
                Ok(())
            })
            .unwrap();
        assert!(store
            .register_service("chat:master", register(&attempt, 3001))
            .is_err());
    }

    #[test]
    fn restart_invalidates_services_and_native_cards_without_reopening_finished_tasks() {
        let root = std::env::temp_dir().join(format!("octiq-lifecycle-{}", compact_id()));
        let path = root.join("state.json");
        let store = OrchestrationStore::load(path.clone());
        let (run, attempt) = worker(&store);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        store
            .register_service(
                "chat:master",
                register(&attempt, listener.local_addr().unwrap().port()),
            )
            .unwrap();
        store.check_services(now_ms()).unwrap();
        crate::safety_block::observe(ChatAgent::Codex, &attempt.worker_chat_key,
            "codex_core::tools::router: error=This action was rejected due to unacceptable risk.\\nReason: Upload requires a decision.");
        store.capture_native_decisions().unwrap();
        crate::safety_block::forget_chat(&attempt.worker_chat_key);
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id,
                    outcome: WorkerOutcome::Completed,
                    summary: "Unaffected work completed".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        drop(store);
        let restored = OrchestrationStore::load(path);
        let snapshot = restored.snapshot(Some(&run.id)).unwrap();
        assert_eq!(snapshot.tasks[0].status, TaskStatus::Completed);
        assert_eq!(snapshot.services[0].state, "unverified");
        assert_eq!(snapshot.services[0].checked_at, None);
        assert_eq!(snapshot.native_decisions[0].status, "expired");
        assert_eq!(snapshot.native_decisions[0].continuation, "unavailable");
        fs::remove_dir_all(root).unwrap();
    }
}

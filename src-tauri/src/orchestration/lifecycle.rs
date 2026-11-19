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
    /// Who a PENDING decision waits for, derived for each read
    /// (`refresh_decision_views`) and never stored: the person, while their
    /// answer on the card can still start a new turn in a live attempt;
    /// nobody otherwise. No coordinator answers a provider's own card.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub awaits: Option<Awaits>,
}

/// The recovery text for a Claude safety refusal: strict, with no retry.
/// Only an outage refusal may be tried again (`safety_block::OUTAGE_RETRY`).
const CLAUDE_REFUSAL_RECOVERY: &str = "Claude's auto mode refused this call without asking anyone, and OctiqFlow cannot approve it: there is no supported way to allow one refused call before it runs. The card only records the refusal. Do not retry the call or reword it to get past the classifier. Continue another safe way, or settle the attempt blocked and name the refused command so the person can decide.";

/// The recovery text once the person wrote "Always allow" rules for a
/// judged refusal. Only the person's click lets the call through, and only
/// the parts a rule names: a reworded line is judged again.
const CLAUDE_ALLOWED_RECOVERY: &str = "The person added Claude permission allow rules for this exact command (shown on the card), so Claude's auto mode runs matching calls without its safety check from now on. OctiqFlow did not run it. If the command is still needed, run it again exactly as before; do not reword it. Any part of the line no rule names is judged again, and if it is refused, carry on another safe way or settle blocked naming it.";

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
    /// What the coordinator was last told before this host restarted, so
    /// the first probe after it reports a change and not the restart itself.
    /// In memory only: it is set by `recover` as the ledger loads.
    #[serde(skip)]
    pub(super) before_restart: Option<String>,
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
    // Old listener evidence is void, but a restart is not news to the
    // coordinator: the next probe says whether anything actually changed.
    for service in data.services.values_mut() {
        if service.state != "unverified" || service.checked_at.is_some() {
            let told = std::mem::replace(&mut service.state, "unverified".into());
            service.before_restart = Some(told);
            service.checked_at = None;
            changed = true;
        }
    }
    changed
}

/// A settled run is never woken by a service: its snapshot stays truthful,
/// and a coordinator that reopens it reads the state there.
fn service_notice(data: &mut Stored, service: &Service, reason: &str) {
    let Some(run) = data.runs.get(&service.run_id) else {
        return;
    };
    if super::run_has_ended(run) {
        return;
    }
    let target = run.coordinator_chat_key.clone();
    inbox::enqueue(data, &service.run_id, "host", &target,
        format!("service:{}:{}:{}", service.id, service.state, compact_id()), "service",
        format!("Service {} for task {} is {}. {reason} Completed task status is unchanged and is not live readiness. Recovery guidance (not executed): {}. Read orchestration_snapshot before dependent work.", service.name, service.task_id, service.state, service.recovery));
}

/// What a pending safety card says while its attempt is blocked on a gate
/// the worker opened: the card is still to be answered, and answering it
/// alone continues nothing.
const BLOCKED_ON_GATE_RECOVERY: &str = "This attempt is blocked on another open decision (a gate on its task), so nothing can continue it yet. The safety card in the main chat is still the person's to answer. Once the gate is resolved too, their decision can authorize a new turn in this attempt; it does not resume the rejected call.";

pub(super) fn refresh_decision_views(snapshot: &mut Snapshot) {
    let pending: BTreeSet<String> = crate::safety_block::decision_summaries()
        .into_iter()
        .map(|d| d.id)
        .collect();
    for decision in &mut snapshot.native_decisions {
        // Two different questions of the attempt the card belongs to. Can a
        // decision continue it right now (`live`)? And is it still the
        // task's attempt with its work unsettled at all (`owed`)? An
        // attempt blocked on an open gate is the second and not the first.
        let attempt = snapshot.attempts.iter().find(|a| {
            a.id == decision.attempt_id
                && snapshot
                    .tasks
                    .iter()
                    .any(|t| t.active_attempt_id.as_deref() == Some(&a.id))
        });
        let live = attempt
            .is_some_and(|a| matches!(a.status, AttemptStatus::Preparing | AttemptStatus::Running));
        let on_gate = attempt.is_some_and(|a| {
            a.status == AttemptStatus::Blocked
                && snapshot.gates.iter().any(|gate| {
                    gate.status == GateStatus::Open
                        && gate.task_id.as_deref() == Some(a.task_id.as_str())
                })
        });
        let owed = live || on_gate;
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
            decision.recovery = if live && decision.status.starts_with("allowed_") {
                // The person's click wrote a Claude permission rule for this
                // call; the retry turn is sent separately, as a message.
                "The person added a Claude permission allow rule covering this command and asked for it to be retried once, as-is. Claude checks the retry against that rule; OctiqFlow did not run it. Report whether the retry ran.".into()
            } else if live && decision.status == "retried" {
                "The person asked for this command to be retried once, as-is. Claude checks that try again; OctiqFlow did not run it. If it is refused again, do not try it a third time.".into()
            } else if live {
                crate::safety_block::outage_guidance().into()
            } else {
                "This attempt has settled or was superseded. Claude's safety check was unavailable for this command, so it did not run and was not approved. Inspect the task and explicitly retry if needed; a retry grants no permission.".into()
            };
        } else if decision.status == "pending" && live && !claude_refusal {
            decision.continuation = "new_turn_same_attempt".into();
            decision.recovery = "Use the existing safety card in the main chat. The rejected call already ended; a decision can authorize a new turn in this attempt, not resume that call.".into();
        } else {
            decision.continuation = "unavailable".into();
            if on_gate && decision.status == "pending" && !claude_refusal {
                decision.recovery = BLOCKED_ON_GATE_RECOVERY.into();
            } else if !live {
                decision.recovery = "This attempt has settled or was superseded. Its old card cannot resume it. Inspect the task and explicitly retry if needed; a retry grants no permission.".into();
            } else if claude_refusal && decision.status == "allowed_exact" {
                // Recorded by an earlier build that offered a one-time
                // rule. It stays as history and authorizes nothing now.
                decision.recovery = "History only: an earlier OctiqFlow build recorded a one-time allowance for this exact command. That allowance was withdrawn because it could not be enforced as one use, and it authorizes nothing now. Do not run the command on the strength of it. Claude's auto mode refusal stands: continue another safe way, or settle the attempt blocked and name the refused command.".into();
            } else if claude_refusal && decision.status.starts_with("allowed_") {
                // The person clicked "Always allow" on the card: exact rules
                // for the line are now in a Claude settings file. Nothing was
                // run for them; the agent retries itself.
                decision.recovery = CLAUDE_ALLOWED_RECOVERY.into();
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
        // Whose move it is, for a card still up. Only one kind of card
        // holds a worker until the person answers: a provider's block that
        // the person's decision answers. A Claude refusal nobody can
        // approve, an outage the worker was told to carry on past, and a
        // card whose attempt has gone wait for nobody.
        //
        // Who must decide is not whether the attempt can go on this minute
        // (review of 931b5f0, C2). A card whose attempt is blocked on an
        // open gate is still the person's to answer; `continuation` says
        // apart that nothing continues the attempt until the gate is
        // answered too.
        decision.awaits = (decision.status == "pending").then(|| {
            if decision.kind != "outage" && !claude_refusal && owed {
                Awaits::Person
            } else {
                Awaits::Nobody
            }
        });
    }
}

impl OrchestrationStore {
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
                    awaits: None,
                };
                data.native_decisions.insert(id.clone(), decision);
                // An outage group is one notice, not one per refusal.
                if let (true, Some(group)) = (outage, card.group_id.as_deref()) {
                    outage_notice(data, &attempt, group);
                    continue;
                }
                // A refusal nobody can approve asks nothing of the coordinator
                // or the person: the worker was told and goes on another way.
                // It stays in nativeDecisions, as one line on the task board,
                // and wakes no turn (feedback 76cde28e).
                if !card.can_continue {
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
            let own = actor == attempt.worker_chat_key;
            if actor != run.coordinator_chat_key && !own {
                return Err(
                    "Only the owning worker or coordinator can register this service.".into(),
                );
            }
            // A peer request's worker reads its task's services back, name
            // and recovery guidance included, and a registration replaces
            // the one of the same name. So on such a task the worker is the
            // only writer: the coordinator is the teammate that asked, or
            // speaks for it.
            if task.peer_request.is_some() && !own {
                return Err(super::peer_request::PEERS_SERVICE.into());
            }
            if task.active_attempt_id.as_deref() != Some(&attempt.id) {
                return Err("A superseded attempt cannot register a service.".into());
            }
            if matches!(run.status, RunStatus::Stopped) {
                return Err("A stopped run cannot register a service.".into());
            }
            if own
                && !matches!(
                    attempt.status,
                    AttemptStatus::Running | AttemptStatus::Preparing
                )
            {
                return Err(if task.peer_request.is_some() {
                    "A settled worker cannot register a service.".into()
                } else {
                    "A settled worker cannot register a service. Use the coordinator.".into()
                });
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
                before_restart: None,
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
                let shown = service.state != state;
                let told = service.before_restart.take();
                let news = told.as_deref().unwrap_or(&service.state) != state;
                service.state = state.into();
                service.checked_at = Some(now);
                let service = service.clone();
                if shown {
                    runs.insert(service.run_id.clone());
                }
                if news {
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
mod tests;

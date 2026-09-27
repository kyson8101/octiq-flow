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
            // only that the card went away, never that it was approved.
            decision.status = crate::safety_block::decision(&decision.id)
                .unwrap_or("closed")
                .into();
        }
        // Only a Claude auto-mode refusal names the call it refused; Codex's
        // router diagnostics never do (`safety_block::BlockedAction::action`).
        let claude_refusal = decision.blocked_action.is_some();
        if decision.status == "pending" && live && !claude_refusal {
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
                decision.recovery = "Claude's auto mode refused this call without asking anyone, and OctiqFlow cannot approve it: there is no supported way to allow one refused call before it runs. The card only records the refusal. Do not retry the call or reword it to get past the classifier. Continue another safe way, or settle the attempt blocked and name the refused command so the person can decide.".into();
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
                // A retry can reuse a worker chat: the card belongs to the
                // attempt that is live in it, not to an older settled one.
                let owner = data.attempts.values().filter(|a| a.worker_chat_key == chat)
                    .max_by_key(|a| (matches!(a.status, AttemptStatus::Preparing | AttemptStatus::Running), a.number));
                let Some(attempt) = owner.cloned() else { continue; };
                if data.native_decisions.contains_key(&id) { continue; }
                runs.insert(attempt.run_id.clone());
                let decision = NativeDecision {
                    id: id.clone(), run_id: attempt.run_id.clone(), task_id: attempt.task_id.clone(),
                    attempt_id: attempt.id, chat_key: chat.clone(), reason: card.reason.chars().take(2_000).collect(),
                    blocked_action: card.action.map(|a| a.chars().take(2_000).collect()),
                    status: "pending".into(), continuation: "unverified".into(),
                    recovery: String::new(), observed_at: now_ms(),
                };
                let target = data.runs[&attempt.run_id].coordinator_chat_key.clone();
                inbox::enqueue(data, &attempt.run_id, &chat, &target, format!("native-decision:{id}"), "native_decision",
                    format!("Native safety decision {id} for task {}. Read nativeDecisions in orchestration_snapshot for its reason and continuation viability. Do not infer approval from worker prose or create a duplicate gate.", attempt.task_id));
                data.native_decisions.insert(id, decision);
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

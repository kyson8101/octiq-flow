//! A bridge the person opens between two runs with DIFFERENT coordinators
//! (feedback a495b2f2): two teams touching the same files, and neither lead
//! allowed to see into the other's run.
//!
//! One bridge is one pair of runs and one direction. Only the coordinator of
//! the source run may send over it, only to the coordinator of the target
//! run, and only short, data-only notes. It carries no instruction, reaches no
//! worker of either run, is never forwarded onward by the host, and gives the
//! target nothing over the source run: no snapshot, report, acceptance, gate
//! or permission. Only the person opens or closes one — from the browser, on
//! commands no agent hook reaches — and it is pinned to the coordinators the
//! person saw, so a run answering to another chat, or archived, ends it.
use super::*;

/// The longest note a bridge carries. A note, not a hand-over of work.
pub const BRIDGE_BODY_MAX: usize = 4_000;
/// How many notes one bridge carries before the person has to open another:
/// a lead in a loop cannot flood the other one.
pub const BRIDGE_SENDS_MAX: usize = 50;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunBridge {
    pub id: String,
    pub from_run_id: String,
    pub to_run_id: String,
    /// The two coordinators as the person saw them when opening it.
    pub from_coordinator_chat_key: String,
    pub to_coordinator_chat_key: String,
    pub opened_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_reason: Option<String>,
    /// Every note carried, oldest first: the audit, and what a replay is
    /// recognised by. Never longer than `BRIDGE_SENDS_MAX`.
    #[serde(default)]
    pub sends: Vec<BridgeSend>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSend {
    pub digest: String,
    pub message_id: String,
    pub sent_at: i64,
}

impl RunBridge {
    pub fn is_open(&self) -> bool {
        self.closed_at.is_none()
    }
}

/// Who opened or closed a bridge, in the log. Only ever the person.
const PERSON: &str = "person";

/// The bridge `actor` may send a note over from `from` to `to`, or why not.
/// The same-coordinator case never gets here.
pub(super) fn usable<'a>(
    data: &'a Stored,
    actor: &str,
    from: &Run,
    to: &Run,
) -> Result<&'a RunBridge, String> {
    if actor != from.coordinator_chat_key {
        return Err(format!(
            "Only the coordinator of run {} can send notes from it.",
            from.id
        ));
    }
    let bridge = data
        .bridges
        .values()
        .find(|b| b.is_open() && b.from_run_id == from.id && b.to_run_id == to.id)
        .ok_or_else(|| format!(
            "No bridge is open from run {} to run {}, and they have different coordinators. Only the person can open one, from the run panel; ask them in your own chat. Until then, record the overlap in your own run.",
            from.id, to.id
        ))?;
    if bridge.from_coordinator_chat_key != from.coordinator_chat_key
        || bridge.to_coordinator_chat_key != to.coordinator_chat_key
    {
        return Err("This bridge no longer holds: a run answers to another coordinator than the person approved. Ask the person to open a new one.".into());
    }
    if from.archived_at.is_some() || to.archived_at.is_some() {
        return Err("This bridge no longer holds: one of its runs is archived.".into());
    }
    if bridge.sends.len() >= BRIDGE_SENDS_MAX {
        return Err(format!(
            "This bridge has carried its {BRIDGE_SENDS_MAX} notes. Ask the person to open a new one."
        ));
    }
    Ok(bridge)
}

/// Whether the note relayed as `message_id` may still be handed to `target`,
/// checked again at delivery: its bridge still open and still pinned to the
/// coordinator it was sent to, who still coordinates the receiving run. A
/// relay between runs of one coordinator has no bridge and is not delivered
/// through the inbox at all.
pub(super) fn delivers(data: &Stored, message_id: &str, target: &str) -> bool {
    let Some(message) = data.messages.get(message_id) else {
        return false;
    };
    let Some(bridge) = message
        .relay
        .as_ref()
        .and_then(|origin| origin.bridge_id.as_ref())
        .and_then(|id| data.bridges.get(id))
    else {
        return false;
    };
    bridge.is_open()
        && message.to_chat_key == target
        && bridge.to_coordinator_chat_key == target
        && data
            .runs
            .get(&bridge.to_run_id)
            .is_some_and(|run| run.coordinator_chat_key == target && run.archived_at.is_none())
        && data
            .runs
            .get(&bridge.from_run_id)
            .is_some_and(|run| run.coordinator_chat_key == bridge.from_coordinator_chat_key)
}

/// A note must fit a bridge before anything is recorded.
pub(super) fn check_note(body: &str) -> Result<(), String> {
    if body.chars().count() > BRIDGE_BODY_MAX {
        return Err(format!(
            "A note over a bridge is at most {BRIDGE_BODY_MAX} characters: it is data for the other coordinator, not a hand-over. Shorten it."
        ));
    }
    Ok(())
}

/// Close every open bridge that touches `run_id`, for `reason`.
pub(super) fn close_touching(data: &mut Stored, run_id: &str, reason: &str) {
    let now = now_ms();
    let closing: Vec<String> = data
        .bridges
        .values()
        .filter(|b| b.is_open() && (b.from_run_id == run_id || b.to_run_id == run_id))
        .map(|b| b.id.clone())
        .collect();
    for id in closing {
        close(data, &id, reason, now);
    }
}

fn close(data: &mut Stored, id: &str, reason: &str, now: i64) {
    let Some(bridge) = data.bridges.get_mut(id) else {
        return;
    };
    bridge.closed_at = Some(now);
    bridge.closed_reason = Some(reason.to_string());
    let bridge = bridge.clone();
    // A note already handed to the other coordinator is history; one still
    // waiting is not delivered after all.
    let waiting: BTreeSet<String> = bridge
        .sends
        .iter()
        .map(|send| format!("relay:{}", send.message_id))
        .collect();
    for n in data.notifications.values_mut() {
        if n.state == inbox::DeliveryState::Pending && waiting.contains(&n.source) {
            n.state = inbox::DeliveryState::Cancelled;
            n.updated_at = now;
        }
    }
    log(
        data,
        &bridge,
        "bridge_closed",
        "Bridge closed",
        &format!(
            "The bridge from run {} to run {} is closed: {reason} No more notes go over it.",
            bridge.from_run_id, bridge.to_run_id
        ),
        now,
    );
}

/// The same entry in both runs' logs, addressed to each run's coordinator.
fn log(data: &mut Stored, bridge: &RunBridge, kind: &str, subject: &str, body: &str, now: i64) {
    for (run_id, coordinator) in [
        (&bridge.from_run_id, &bridge.from_coordinator_chat_key),
        (&bridge.to_run_id, &bridge.to_coordinator_chat_key),
    ] {
        let message = OrchestrationMessage {
            id: format!("message_{}", compact_id()),
            run_id: run_id.clone(),
            from_chat_key: PERSON.into(),
            to_chat_key: coordinator.clone(),
            kind: kind.into(),
            subject: subject.into(),
            body: body.into(),
            created_at: now,
            relay: None,
        };
        data.messages.insert(message.id.clone(), message);
    }
}

impl OrchestrationStore {
    /// The person opens a one-way bridge from one run's coordinator to
    /// another's. `from_coordinator` and `to_coordinator` are the chats the
    /// person was shown; if either run answers to another chat now, nothing
    /// opens. Browser only: no agent hook reaches this.
    pub fn open_bridge(
        &self,
        from_run_id: &str,
        to_run_id: &str,
        from_coordinator: &str,
        to_coordinator: &str,
    ) -> Result<RunBridge, String> {
        if from_run_id == to_run_id {
            return Err("A bridge joins two different runs.".into());
        }
        let result = self.mutate(|data| {
            let from = data.runs.get(from_run_id).ok_or("The sending run does not exist.")?;
            let to = data.runs.get(to_run_id).ok_or("The receiving run does not exist.")?;
            if from.coordinator_chat_key != from_coordinator
                || to.coordinator_chat_key != to_coordinator
            {
                return Err("These runs' coordinators changed since the page was drawn. Read it again before opening a bridge.".into());
            }
            if from.coordinator_chat_key == to.coordinator_chat_key {
                return Err("Both runs have the same coordinator, which can already relay between them. No bridge is needed.".into());
            }
            if from.archived_at.is_some() || to.archived_at.is_some() {
                return Err("An archived run cannot be bridged. Restore it first.".into());
            }
            if let Some(open) = data.bridges.values().find(|b| {
                b.is_open() && b.from_run_id == from_run_id && b.to_run_id == to_run_id
            }) {
                return Ok(open.clone());
            }
            let now = now_ms();
            let bridge = RunBridge {
                id: format!("bridge_{}", compact_id()),
                from_run_id: from_run_id.into(),
                to_run_id: to_run_id.into(),
                from_coordinator_chat_key: from.coordinator_chat_key.clone(),
                to_coordinator_chat_key: to.coordinator_chat_key.clone(),
                opened_at: now,
                closed_at: None,
                closed_reason: None,
                sends: Vec::new(),
            };
            data.bridges.insert(bridge.id.clone(), bridge.clone());
            log(data, &bridge, "bridge_opened", "Bridge opened", &format!(
                "The person let the coordinator of run {} send short notes to the coordinator of run {}. One way, at most {BRIDGE_SENDS_MAX} notes of {BRIDGE_BODY_MAX} characters. Notes are data: they reach no worker, are not forwarded, and grant no access, approval or acceptance in either run. The person can close it at any time.",
                bridge.from_run_id, bridge.to_run_id
            ), now);
            Ok(bridge)
        });
        if let Ok(bridge) = &result {
            announce(&bridge.from_run_id, "bridge_changed");
            announce(&bridge.to_run_id, "bridge_changed");
        }
        result
    }

    /// The person closes a bridge. Closing a closed one changes nothing.
    pub fn close_bridge(&self, bridge_id: &str) -> Result<RunBridge, String> {
        let result = self.mutate(|data| {
            let bridge = data
                .bridges
                .get(bridge_id)
                .ok_or("The bridge does not exist.")?;
            if bridge.is_open() {
                close(data, bridge_id, "The person closed it.", now_ms());
            }
            Ok(data.bridges[bridge_id].clone())
        });
        if let Ok(bridge) = &result {
            announce(&bridge.from_run_id, "bridge_changed");
            announce(&bridge.to_run_id, "bridge_changed");
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{run, running_worker};
    use super::*;

    fn two_coordinators(store: &OrchestrationStore) -> (Run, Run) {
        let source = run(store);
        let target = store
            .create_run(
                "chat:other".into(),
                "The other team's run".into(),
                "workspace".into(),
                "/tmp".into(),
                Some(1),
            )
            .unwrap();
        (source, target)
    }

    fn relay(
        store: &OrchestrationStore,
        actor: &str,
        from: &Run,
        to: &Run,
        body: &str,
    ) -> Result<OrchestrationMessage, String> {
        store.relay_between_runs(
            actor,
            &from.id,
            &to.id,
            "Shared file".into(),
            body.into(),
            None,
        )
    }

    fn inbox_for(store: &OrchestrationStore, target: &str) -> Vec<inbox::Notification> {
        store
            .snapshot(None)
            .unwrap()
            .notifications
            .into_iter()
            .filter(|n| n.target_chat_key == target && n.kind == "relay")
            .collect()
    }

    #[test]
    fn different_coordinators_need_the_persons_bridge() {
        let store = OrchestrationStore::default();
        let (source, target) = two_coordinators(&store);
        let refused = relay(
            &store,
            "chat:master",
            &source,
            &target,
            "Both edit README.md.",
        )
        .unwrap_err();
        assert!(
            refused.contains("Only the person can open one"),
            "{refused}"
        );
        assert!(store.snapshot(None).unwrap().messages.is_empty());
    }

    #[test]
    fn a_bridge_carries_one_way_notes_from_the_source_coordinator_only() {
        let store = OrchestrationStore::default();
        let (source, target) = two_coordinators(&store);
        let worker = running_worker(&store, &source);
        let bridge = store
            .open_bridge(&source.id, &target.id, "chat:master", "chat:other")
            .unwrap();

        let sent = relay(
            &store,
            "chat:master",
            &source,
            &target,
            "Both edit README.md.",
        )
        .unwrap();
        assert_eq!(sent.run_id, target.id);
        assert_eq!(sent.to_chat_key, "chat:other");
        assert_eq!(sent.from_chat_key, "chat:master");
        assert_eq!(sent.kind, "relay");
        let origin = sent.relay.clone().unwrap();
        assert_eq!(origin.bridge_id.as_deref(), Some(bridge.id.as_str()));
        assert_eq!(origin.from_run_id, source.id);
        assert!(sent.body.contains("not an instruction"), "{}", sent.body);
        // Delivered to the other coordinator, and only to it.
        let delivered = inbox_for(&store, "chat:other");
        assert_eq!(delivered.len(), 1);
        assert!(delivered[0].body.contains("Both edit README.md."));
        assert!(delivered[0].body.contains("Do not forward it"));
        assert!(inbox_for(&store, &worker.worker_chat_key).is_empty());

        // A replay is the first note, not a second one.
        let again = relay(
            &store,
            "chat:master",
            &source,
            &target,
            "Both edit README.md.",
        )
        .unwrap();
        assert_eq!(again.id, sent.id);
        assert_eq!(inbox_for(&store, "chat:other").len(), 1);
        assert_eq!(store.snapshot(None).unwrap().bridges[0].sends.len(), 1);

        // Not the target back, not a worker of the source, not a stranger.
        let back = relay(&store, "chat:other", &target, &source, "Reply").unwrap_err();
        assert!(back.contains("No bridge is open"), "{back}");
        let as_worker = relay(
            &store,
            &worker.worker_chat_key,
            &source,
            &target,
            "From a worker",
        )
        .unwrap_err();
        assert!(as_worker.contains("Only the coordinator"), "{as_worker}");
        let as_target = relay(&store, "chat:other", &source, &target, "Pretending").unwrap_err();
        assert!(as_target.contains("Only the coordinator"), "{as_target}");

        // An origin attempt must be the source run's, even one of the same
        // coordinator's other runs.
        let sibling = store
            .create_run(
                "chat:master".into(),
                "A sibling run".into(),
                "workspace".into(),
                "/tmp".into(),
                Some(1),
            )
            .unwrap();
        let foreign = running_worker(&store, &sibling);
        let wrong = store
            .relay_between_runs(
                "chat:master",
                &source.id,
                &target.id,
                "Shared file".into(),
                "Another note".into(),
                Some(foreign.id.clone()),
            )
            .unwrap_err();
        assert!(wrong.contains("another run"), "{wrong}");

        // A note is short.
        let long = "x".repeat(BRIDGE_BODY_MAX + 1);
        let too_long = relay(&store, "chat:master", &source, &target, &long).unwrap_err();
        assert!(too_long.contains("at most"), "{too_long}");
    }

    #[test]
    fn closing_or_archiving_ends_a_bridge_and_the_person_can_reopen() {
        let store = OrchestrationStore::default();
        let (source, target) = two_coordinators(&store);
        let bridge = store
            .open_bridge(&source.id, &target.id, "chat:master", "chat:other")
            .unwrap();
        // Opening the same pair again is the same bridge.
        let same = store
            .open_bridge(&source.id, &target.id, "chat:master", "chat:other")
            .unwrap();
        assert_eq!(same.id, bridge.id);

        let closed = store.close_bridge(&bridge.id).unwrap();
        assert!(!closed.is_open());
        let refused = relay(&store, "chat:master", &source, &target, "After close").unwrap_err();
        assert!(refused.contains("No bridge is open"), "{refused}");
        let log: Vec<_> = store
            .snapshot(None)
            .unwrap()
            .messages
            .into_iter()
            .map(|m| (m.run_id, m.kind, m.from_chat_key))
            .collect();
        for run in [&source.id, &target.id] {
            assert!(log.contains(&(run.clone(), "bridge_opened".into(), "person".into())));
            assert!(log.contains(&(run.clone(), "bridge_closed".into(), "person".into())));
        }

        let reopened = store
            .open_bridge(&source.id, &target.id, "chat:master", "chat:other")
            .unwrap();
        assert_ne!(reopened.id, bridge.id);
        relay(&store, "chat:master", &source, &target, "Reopened").unwrap();

        // Archiving either run ends it for good.
        store
            .stop_run("chat:other", target.id.clone(), "done".into())
            .unwrap();
        store
            .set_run_archived("chat:other", &target.id, true)
            .unwrap();
        let bridges = store.snapshot(None).unwrap().bridges;
        assert!(bridges.iter().all(|b| !b.is_open()));
        store
            .set_run_archived("chat:other", &target.id, false)
            .unwrap();
        let refused = relay(&store, "chat:master", &source, &target, "After archive").unwrap_err();
        assert!(refused.contains("No bridge is open"), "{refused}");
    }

    #[test]
    fn a_bridge_opens_only_on_what_the_person_saw() {
        let store = OrchestrationStore::default();
        let (source, target) = two_coordinators(&store);
        let stale = store
            .open_bridge(&source.id, &target.id, "chat:master", "chat:someone-else")
            .unwrap_err();
        assert!(
            stale.contains("changed since the page was drawn"),
            "{stale}"
        );
        let same_run = store
            .open_bridge(&source.id, &source.id, "chat:master", "chat:master")
            .unwrap_err();
        assert!(same_run.contains("two different runs"), "{same_run}");
        let sibling = store
            .create_run(
                "chat:master".into(),
                "A sibling run".into(),
                "workspace".into(),
                "/tmp".into(),
                Some(1),
            )
            .unwrap();
        let needless = store
            .open_bridge(&source.id, &sibling.id, "chat:master", "chat:master")
            .unwrap_err();
        assert!(needless.contains("No bridge is needed"), "{needless}");
        assert!(store.snapshot(None).unwrap().bridges.is_empty());
    }

    #[test]
    fn a_bridge_pinned_to_other_coordinators_no_longer_holds() {
        let store = OrchestrationStore::default();
        let (source, target) = two_coordinators(&store);
        store
            .open_bridge(&source.id, &target.id, "chat:master", "chat:other")
            .unwrap();
        // Nothing in the product moves a run to another coordinator today;
        // the rule holds if anything ever does.
        store
            .mutate(|data| {
                data.runs.get_mut(&target.id).unwrap().coordinator_chat_key =
                    "chat:new-lead".into();
                Ok(())
            })
            .unwrap();
        let target = store.snapshot(Some(&target.id)).unwrap().runs.remove(0);
        let refused = relay(&store, "chat:master", &source, &target, "Still there?").unwrap_err();
        assert!(refused.contains("no longer holds"), "{refused}");
        assert!(inbox_for(&store, "chat:new-lead").is_empty());
    }

    #[test]
    fn only_the_two_coordinators_read_a_bridge_or_its_notes() {
        use super::super::agent_view::{agent_snapshot, AgentRead};
        let store = OrchestrationStore::default();
        let (source, target) = two_coordinators(&store);
        let source_worker = running_worker(&store, &source);
        let task = store
            .create_task(
                "chat:other",
                target.id.clone(),
                "Their task".into(),
                "Their work".into(),
                Vec::new(),
                None,
                None,
            )
            .unwrap();
        let (_, _, target_worker, _) = store
            .reserve_attempt(
                "chat:other",
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
        store
            .open_bridge(&source.id, &target.id, "chat:master", "chat:other")
            .unwrap();
        relay(
            &store,
            "chat:master",
            &source,
            &target,
            "Both edit README.md.",
        )
        .unwrap();

        let view = |actor: &str, run: &Run| {
            agent_snapshot(
                store.snapshot(None).unwrap(),
                &AgentRead {
                    actor,
                    run_id: Some(&run.id),
                    task_id: None,
                    message_limit: 50,
                },
            )
            .unwrap()
            .to_string()
        };
        for (actor, run) in [
            (target_worker.worker_chat_key.as_str(), &target),
            (source_worker.worker_chat_key.as_str(), &source),
            (target_worker.worker_chat_key.as_str(), &source),
            ("chat:stranger", &target),
        ] {
            let seen = view(actor, run);
            assert!(
                !seen.contains("Both edit README.md."),
                "{actor} read the note: {seen}"
            );
            assert!(!seen.contains("bridge_"), "{actor} read the bridge: {seen}");
        }
        let receiving = view("chat:other", &target);
        assert!(receiving.contains("Both edit README.md."));
        assert!(receiving.contains("\"bridges\""));
        let sending = view("chat:master", &source);
        assert!(sending.contains("relay_sent"));
        assert!(sending.contains("\"bridges\""));
    }

    #[test]
    fn an_undelivered_note_is_not_delivered_once_its_bridge_no_longer_holds() {
        let store = OrchestrationStore::default();
        let (source, target) = two_coordinators(&store);
        let first = store
            .open_bridge(&source.id, &target.id, "chat:master", "chat:other")
            .unwrap();
        relay(
            &store,
            "chat:master",
            &source,
            &target,
            "Both edit README.md.",
        )
        .unwrap();
        let waiting = inbox_for(&store, "chat:other");
        assert_eq!(waiting[0].state, inbox::DeliveryState::Pending);

        // Closed before delivery: cancelled, never handed over.
        store.close_bridge(&first.id).unwrap();
        let cancelled = inbox_for(&store, "chat:other");
        assert_eq!(cancelled[0].state, inbox::DeliveryState::Cancelled);
        assert!(store
            .claim_notification(&cancelled[0].id, i64::MAX)
            .unwrap()
            .is_none());

        // Reopened: an old note's replay is a new note on the new grant.
        let second = store
            .open_bridge(&source.id, &target.id, "chat:master", "chat:other")
            .unwrap();
        let again = relay(
            &store,
            "chat:master",
            &source,
            &target,
            "Both edit README.md.",
        )
        .unwrap();
        assert_ne!(format!("relay:{}", again.id), waiting[0].source);
        assert_eq!(
            again.relay.unwrap().bridge_id.as_deref(),
            Some(second.id.as_str())
        );
        let pending: Vec<_> = inbox_for(&store, "chat:other")
            .into_iter()
            .filter(|n| n.state == inbox::DeliveryState::Pending)
            .collect();
        assert_eq!(pending.len(), 1);

        // However a bridge came to be closed, delivery checks it again.
        store
            .mutate(|data| {
                data.bridges.get_mut(&second.id).unwrap().closed_at = Some(1);
                Ok(())
            })
            .unwrap();
        assert!(store
            .claim_notification(&pending[0].id, i64::MAX)
            .unwrap()
            .is_none());
        store
            .mutate(|data| {
                let n = data.notifications.get_mut(&pending[0].id).unwrap();
                n.state = inbox::DeliveryState::Pending;
                data.bridges.get_mut(&second.id).unwrap().closed_at = None;
                Ok(())
            })
            .unwrap();

        // The receiving run changing hands between send and delivery: the
        // recipient is checked again when the note is handed over.
        store
            .mutate(|data| {
                data.runs.get_mut(&target.id).unwrap().coordinator_chat_key =
                    "chat:new-lead".into();
                Ok(())
            })
            .unwrap();
        assert!(store
            .claim_notification(&pending[0].id, i64::MAX)
            .unwrap()
            .is_none());
        let after: Vec<_> = inbox_for(&store, "chat:other")
            .into_iter()
            .filter(|n| n.id == pending[0].id)
            .collect();
        assert_eq!(after[0].state, inbox::DeliveryState::Cancelled);
    }

    #[test]
    fn a_bridge_carries_a_bounded_number_of_notes() {
        let store = OrchestrationStore::default();
        let (source, target) = two_coordinators(&store);
        store
            .open_bridge(&source.id, &target.id, "chat:master", "chat:other")
            .unwrap();
        for n in 0..BRIDGE_SENDS_MAX {
            relay(
                &store,
                "chat:master",
                &source,
                &target,
                &format!("Note {n}"),
            )
            .unwrap();
        }
        let full = relay(&store, "chat:master", &source, &target, "One more").unwrap_err();
        assert!(full.contains("open a new one"), "{full}");
    }
}

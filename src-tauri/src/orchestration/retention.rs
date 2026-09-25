//! What a finished run keeps.
//!
//! Tasks, attempts and gates stay: they are what someone reopening the run
//! reads, and a reopened task retries from them. Delivered notifications are
//! receipts, and every one of them was sent again with each ledger read; the
//! coordination log keeps the messages the Orchestrator panel shows.
//!
//! Pruning never makes a notification deliverable twice. The inbox refuses a
//! source it has seen, but every source names the attempt, gate, message or
//! decision it is about, and none of those produces another after its run
//! finished.
use super::*;

/// The Orchestrator panel's coordination log shows the latest six.
pub(super) const KEPT_MESSAGES: usize = 6;

pub(super) fn is_finished(status: RunStatus) -> bool {
    matches!(
        status,
        RunStatus::Completed | RunStatus::Failed | RunStatus::Stopped
    )
}

/// Prune one run if it is finished. True when anything was removed.
pub(super) fn prune_run(data: &mut Stored, run_id: &str) -> bool {
    if !data
        .runs
        .get(run_id)
        .is_some_and(|run| is_finished(run.status))
    {
        return false;
    }
    let before = (data.notifications.len(), data.messages.len());
    data.notifications.retain(|_, n| {
        n.run_id != run_id
            || !matches!(
                n.state,
                inbox::DeliveryState::Acknowledged | inbox::DeliveryState::Cancelled
            )
    });
    let mut log: Vec<_> = data
        .messages
        .values()
        .filter(|message| message.run_id == run_id)
        .map(|message| (message.created_at, message.id.clone()))
        .collect();
    if log.len() > KEPT_MESSAGES {
        log.sort();
        for (_, id) in &log[..log.len() - KEPT_MESSAGES] {
            data.messages.remove(id);
        }
    }
    before != (data.notifications.len(), data.messages.len())
}

/// Every finished run, as the store loads.
pub(super) fn prune_finished_runs(data: &mut Stored) -> bool {
    let finished: Vec<String> = data
        .runs
        .values()
        .filter(|run| is_finished(run.status))
        .map(|run| run.id.clone())
        .collect();
    finished
        .iter()
        .fold(false, |pruned, id| prune_run(data, id) | pruned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn stored(status: &str) -> Stored {
        let messages: serde_json::Map<String, Value> = (0..10)
            .map(|n| {
                let id = format!("m{n}");
                (id.clone(), json!({
                    "id": id, "runId": "run_1", "fromChatKey": "chat:master", "toChatKey": "chat:w1",
                    "kind": "status", "subject": "s", "body": "b", "createdAt": n,
                }))
            })
            .collect();
        let notification = |id: &str, state: &str| {
            json!({
                "id": id, "runId": "run_1", "fromChatKey": "chat:w1", "targetChatKey": "chat:master",
                "source": id, "kind": "report", "body": "b", "state": state, "attempts": 1,
                "coalesced": 0, "createdAt": 1, "updatedAt": 1, "nextAttemptAt": 1,
            })
        };
        serde_json::from_value(json!({
            "version": STORE_VERSION,
            "runs": {"run_1": {
                "id": "run_1", "objective": "o", "coordinatorChatKey": "chat:master",
                "workspaceId": "w", "rootPath": "/repo", "status": status,
                "maxConcurrent": 2, "createdAt": 1, "updatedAt": 1,
            }},
            "messages": messages,
            "notifications": {
                "n1": notification("n1", "acknowledged"),
                "n2": notification("n2", "cancelled"),
                "n3": notification("n3", "pending"),
            },
        }))
        .unwrap()
    }

    #[test]
    fn a_finished_run_keeps_its_latest_messages_and_undelivered_notifications() {
        for status in ["completed", "failed", "stopped"] {
            let mut data = stored(status);
            assert!(prune_finished_runs(&mut data));
            let mut kept: Vec<_> = data.messages.keys().cloned().collect();
            kept.sort();
            assert_eq!(kept, ["m4", "m5", "m6", "m7", "m8", "m9"], "{status}");
            assert_eq!(
                data.notifications.keys().collect::<Vec<_>>(),
                ["n3"],
                "{status}"
            );
            assert!(
                !prune_finished_runs(&mut data),
                "pruning twice changes nothing"
            );
        }
    }

    #[test]
    fn a_run_in_flight_is_left_alone() {
        for status in ["planning", "running", "waiting"] {
            let mut data = stored(status);
            assert!(!prune_finished_runs(&mut data));
            assert_eq!(data.messages.len(), 10);
            assert_eq!(data.notifications.len(), 3);
        }
    }

    #[test]
    fn stopping_a_run_prunes_it_and_loading_prunes_what_finished_before() {
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        for n in 0..8 {
            store
                .mutate(|data| {
                    let id = format!("m{n}");
                    data.messages.insert(
                        id.clone(),
                        OrchestrationMessage {
                            id,
                            run_id: run.id.clone(),
                            from_chat_key: "chat:master".into(),
                            to_chat_key: "chat:w1".into(),
                            kind: "status".into(),
                            subject: "s".into(),
                            body: "b".into(),
                            created_at: n,
                        },
                    );
                    Ok(())
                })
                .unwrap();
        }
        store
            .stop_run("chat:master", run.id.clone(), "Stop".into())
            .unwrap();
        assert_eq!(store.snapshot(None).unwrap().messages.len(), KEPT_MESSAGES);

        let root = std::env::temp_dir().join(format!("octiq-retention-{}", compact_id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("orchestrations.json");
        fs::write(&path, serde_json::to_vec(&stored("completed")).unwrap()).unwrap();
        let loaded = OrchestrationStore::load(path.clone());
        assert_eq!(loaded.snapshot(None).unwrap().messages.len(), KEPT_MESSAGES);
        let saved: Stored = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved.messages.len(), KEPT_MESSAGES);
        assert_eq!(saved.notifications.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}

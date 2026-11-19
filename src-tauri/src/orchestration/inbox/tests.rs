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
    // Equal timestamps and reverse UUID order must still keep the real latest.
    store
        .mutate(|data| {
            let timestamp = worker.created_at;
            for (body, id) in [
                ("old status", "message_f0000000000040008000000000000000"),
                ("latest status", "message_00000000000040008000000000000000"),
            ] {
                let previous = data
                    .messages
                    .values()
                    .find(|m| m.body == body)
                    .unwrap()
                    .id
                    .clone();
                let mut message = data.messages.remove(&previous).unwrap();
                message.id = id.into();
                message.created_at = timestamp;
                data.messages.insert(id.into(), message);
                let n = data
                    .notifications
                    .values_mut()
                    .find(|n| n.source == format!("message:{previous}"))
                    .unwrap();
                n.source = format!("message:{id}");
                n.created_at = timestamp;
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
fn statuses_without_proven_sequence_order_are_both_kept() {
    for sequences in [
        [None, None],
        [None, Some(2)],
        [Some(1), None],
        [Some(7), Some(7)],
    ] {
        for same_millisecond in [false, true] {
            let store = OrchestrationStore::default();
            let run = run(&store);
            let worker = running_worker(&store, &run);
            ping(&store, &run, &worker, "status", "old status");
            ping(&store, &run, &worker, "status", "latest status");
            store
                .mutate(|data| {
                    for message in data.messages.values_mut() {
                        message.created_at = worker.created_at
                            + if message.body == "latest status" && !same_millisecond {
                                1
                            } else {
                                0
                            };
                    }
                    for n in data.notifications.values_mut() {
                        n.sequence = sequences[usize::from(n.body.contains("latest status"))];
                    }
                    // Exercise legacy deserialization too: None is omitted on disk.
                    *data = serde_json::from_value(serde_json::to_value(&*data).unwrap()).unwrap();
                    Ok(())
                })
                .unwrap();
            let ids = store
                .due_notifications(i64::MAX)
                .unwrap()
                .into_iter()
                .map(|n| n.id)
                .collect::<Vec<_>>();
            let kept = store.claim_notifications(&ids, i64::MAX - 60_000).unwrap();
            assert_eq!(
                kept.len(),
                2,
                "{sequences:?}, same timestamp: {same_millisecond}"
            );
        }
    }
}

#[test]
fn notification_batches_follow_sequence_despite_clock_and_reverse_receipt_ids() {
    for to_worker in [false, true] {
        for clock_backwards in [false, true] {
            let store = OrchestrationStore::default();
            let run = run(&store);
            let worker = running_worker(&store, &run);
            let target = if to_worker {
                &worker.worker_chat_key
            } else {
                &run.coordinator_chat_key
            };
            store
                .mutate(|data| {
                    for (body, id, created_at) in [
                        ("first", "receipt_ffffffff", 100),
                        (
                            "second",
                            "receipt_00000000",
                            if clock_backwards { 99 } else { 100 },
                        ),
                    ] {
                        enqueue(
                            data,
                            &run.id,
                            &worker.worker_chat_key,
                            target,
                            body.into(),
                            "question",
                            body.into(),
                        );
                        let previous = data
                            .notifications
                            .values()
                            .find(|n| n.body == body)
                            .unwrap()
                            .id
                            .clone();
                        let mut n = data.notifications.remove(&previous).unwrap();
                        n.id = id.into();
                        n.created_at = created_at;
                        data.notifications.insert(id.into(), n);
                    }
                    Ok(())
                })
                .unwrap();
            let due = store.due_notifications(i64::MAX).unwrap();
            assert_eq!(
                due.iter().map(|n| n.body.as_str()).collect::<Vec<_>>(),
                ["first", "second"]
            );
            if to_worker {
                let taken = store.take_for_working_worker(target).unwrap();
                assert_eq!(
                    taken.iter().map(|n| n.body.as_str()).collect::<Vec<_>>(),
                    ["first", "second"]
                );
            }
        }
    }
}

#[test]
fn notification_sequence_survives_reload_and_pruning_all_receipts() {
    let home = crate::test_dir::TestDir::new("notification-sequence");
    let _profile = crate::profile::started_in(&home);
    let path = home.join("inbox.json");
    let store = OrchestrationStore::load(path.clone());
    let run = run(&store);
    for body in ["first", "second"] {
        store
            .mutate(|data| {
                enqueue(
                    data,
                    &run.id,
                    "chat:worker",
                    &run.coordinator_chat_key,
                    body.into(),
                    "question",
                    body.into(),
                );
                Ok(())
            })
            .unwrap();
    }
    let order = |store: &OrchestrationStore| {
        store
            .due_notifications(i64::MAX)
            .unwrap()
            .iter()
            .map(|n| n.sequence)
            .collect::<Vec<_>>()
    };
    assert_eq!(order(&store), [Some(1), Some(2)]);
    drop(store);
    let store = OrchestrationStore::load(path.clone());
    assert_eq!(order(&store), [Some(1), Some(2)]);
    store
        .mutate(|data| {
            // Use the real retention path: the high-water mark outlives receipts.
            data.runs.get_mut(&run.id).unwrap().status = RunStatus::Completed;
            for n in data.notifications.values_mut() {
                n.state = DeliveryState::Acknowledged;
            }
            assert!(retention::prune_run(data, &run.id));
            assert!(data.notifications.is_empty());
            Ok(())
        })
        .unwrap();
    drop(store);
    let store = OrchestrationStore::load(path);
    store
        .mutate(|data| {
            enqueue(
                data,
                &run.id,
                "chat:worker",
                &run.coordinator_chat_key,
                "third".into(),
                "question",
                "third".into(),
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(order(&store), [Some(3)]);
}

#[test]
fn legacy_ledger_keeps_missing_sequences_through_reload() {
    let home = crate::test_dir::TestDir::new("notification-legacy-sequence");
    let _profile = crate::profile::started_in(&home);
    let path = home.join("inbox.json");
    let store = OrchestrationStore::load(path.clone());
    let run = run(&store);
    store
        .mutate(|data| {
            enqueue(
                data,
                &run.id,
                "chat:worker",
                &run.coordinator_chat_key,
                "old".into(),
                "question",
                "old".into(),
            );
            Ok(())
        })
        .unwrap();
    drop(store);
    let mut saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    saved
        .as_object_mut()
        .unwrap()
        .remove("notification_sequence");
    for n in saved["notifications"].as_object_mut().unwrap().values_mut() {
        n.as_object_mut().unwrap().remove("sequence");
    }
    fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    let store = OrchestrationStore::load(path);
    assert!(store.due_notifications(i64::MAX).unwrap()[0]
        .sequence
        .is_none());
    store
        .mutate(|data| {
            enqueue(
                data,
                &run.id,
                "chat:worker",
                &run.coordinator_chat_key,
                "new".into(),
                "question",
                "new".into(),
            );
            Ok(())
        })
        .unwrap();
    let due = store.due_notifications(i64::MAX).unwrap();
    assert_eq!(
        due.iter().map(|n| n.body.as_str()).collect::<Vec<_>>(),
        ["old", "new"]
    );
    assert_eq!(
        due.iter().map(|n| n.sequence).collect::<Vec<_>>(),
        [None, Some(1)]
    );
}

#[test]
fn coalesced_progress_takes_the_new_enqueue_sequence_but_legacy_progress_is_kept() {
    for legacy in [false, true] {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        ping(&store, &run, &worker, "progress", "first");
        if legacy {
            store
                .mutate(|data| {
                    for n in data.notifications.values_mut() {
                        n.sequence = None;
                    }
                    Ok(())
                })
                .unwrap();
        }
        ping(&store, &run, &worker, "question", "question");
        ping(&store, &run, &worker, "progress", "second");
        let due = store.due_notifications(i64::MAX).unwrap();
        let bodies = due.iter().map(|n| n.body.as_str()).collect::<Vec<_>>();
        if legacy {
            assert_eq!(due.len(), 3);
            assert!(bodies[0].contains("first"));
        } else {
            assert_eq!(due.len(), 2);
        }
        assert!(bodies[bodies.len() - 2].contains("question"));
        assert!(bodies[bodies.len() - 1].contains("second"));
        assert_eq!(due.last().unwrap().sequence, Some(3));
    }
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

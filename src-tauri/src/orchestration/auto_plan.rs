//! Person-only standing consent for a chat's orchestration plans.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AutoPlanSetting {
    pub enabled_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub chat_key: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoPlan {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub held: Option<Held>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    pub reason: String,
    pub task_ids: Vec<String>,
}

/// If both apply, the peer request wins: it always needs the person's card.
fn held(data: &Stored, run: &Run) -> Option<Held> {
    if !run.awaiting_plan_approval() {
        return None;
    }
    let waiting: Vec<_> = awaiting_approval(data, &run.id).collect();
    let peers: Vec<_> = waiting
        .iter()
        .filter(|t| t.peer_request.is_some())
        .map(|t| t.id.clone())
        .collect();
    if !peers.is_empty() {
        return Some(Held {
            reason: "peerRequest".into(),
            task_ids: peers,
        });
    }
    let access: Vec<_> = waiting.iter().filter(|t| {
        // Includes the approval-fixed worker and inherited defaults. Unknown
        // or invalid effective settings cannot establish consent <= Auto.
        !matches!(automation::settings_for_task(run, t), Ok(Some(worker))
            if crate::access_request::rank(worker.access) <= crate::access_request::rank(Access::Auto))
    }).map(|t| t.id.clone()).collect();
    (!access.is_empty()).then_some(Held {
        reason: "access".into(),
        task_ids: access,
    })
}

pub(super) fn derived(data: &Stored, run: &Run) -> Option<AutoPlan> {
    data.auto_plan_chats.get(&run.coordinator_chat_key)?;
    Some(AutoPlan {
        enabled: true,
        held: held(data, run),
    })
}

fn setting(data: &Stored, chat: &str) -> Setting {
    let saved = data.auto_plan_chats.get(chat);
    Setting {
        chat_key: chat.into(),
        enabled: saved.is_some(),
        enabled_at: saved.map(|s| s.enabled_at),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Notice {
    chat_key: String,
    event: serde_json::Value,
}

impl OrchestrationStore {
    pub fn auto_plan_get(&self, chat: &str) -> Result<Setting, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        Ok(setting(&inner.data, chat))
    }

    /// Caller checks front desk, room seat and active index membership. The
    /// durable worker identity is also checked here under the consent lock.
    pub fn auto_plan_set(&self, chat: &str, enabled: bool) -> Result<Setting, String> {
        validate_chat_key(chat)?;
        let change = |data: &mut Stored| {
            if enabled {
                if chat.starts_with("chat:orch-")
                    || data.attempts.values().any(|a| a.worker_chat_key == chat)
                {
                    return Err("A worker chat cannot enable automatic plan approval.".into());
                }
                data.auto_plan_chats
                    .entry(chat.into())
                    .or_insert_with(|| AutoPlanSetting {
                        enabled_at: now_ms(),
                    });
            } else {
                data.auto_plan_chats.remove(chat);
            }
            Ok(setting(data, chat))
        };
        let saved = if enabled {
            self.mutate(change).map_err(|why| format!("Automatic plan approval was not enabled: its standing consent could not be recorded. {why}"))?
        } else {
            self.mutate_regardless("turning off automatic plan approval", change)?
        };
        crate::bus::emit("orchestration-auto-plan", &saved);
        Ok(saved)
    }

    /// Evidence arrives with every chat lock already released. The two
    /// ledger-only steps pin a revision/waiting set, then stage its approval.
    /// A next turn may continue normally; its edits invalidate the snapshot.
    pub(crate) fn auto_approve_at_turn_end(
        &self,
        ended: crate::agent_chat::CleanTurnEnd,
    ) -> Result<(), String> {
        self.auto_approve_at_turn_end_with(ended, || {}, || {})
    }

    // Hooks keep deterministic race tests on the real approval/commit path.
    // Neither production hook does anything or holds a chat lock.
    pub(crate) fn auto_approve_at_turn_end_with(
        &self,
        ended: crate::agent_chat::CleanTurnEnd,
        after_snapshot: impl FnOnce(),
        before_commit: impl FnOnce(),
    ) -> Result<(), String> {
        let expected = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            if let Some(error) = &inner.load_error {
                return Err(error.clone());
            }
            if !inner.data.auto_plan_chats.contains_key(&ended.chat_key) {
                return Ok(());
            }
            pending_plans(&inner.data, &ended.chat_key)
        };
        after_snapshot();
        let result = (|| {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            if !inner.data.auto_plan_chats.contains_key(&ended.chat_key)
                || pending_plans(&inner.data, &ended.chat_key) != expected
            {
                return Ok(Vec::new());
            }
            self.mutate_locked_at_commit(
                &mut inner,
                None,
                |data| approve_in(data, &ended.chat_key),
                |published| {
                    before_commit();
                    // The unchanged ledger is still locked, including consent,
                    // revision and waiting set. No session/queue/launches lock
                    // is acquired here: Stop vetoes through the evidence atomic.
                    if !published.auto_plan_chats.contains_key(&ended.chat_key)
                        || pending_plans(published, &ended.chat_key) != expected
                        || !ended.decide()
                    {
                        return Err(crate::agent_chat::AUTO_PLAN_REVOKED.into());
                    }
                    Ok(())
                },
            )
        })();
        let approved = match result {
            Err(why) if why == crate::agent_chat::AUTO_PLAN_REVOKED => Vec::new(),
            other => other?,
        };
        for run in approved {
            announce_plan_decision(&run);
        }
        self.deliver_auto_plan_notices()
    }

    /// The ledger outbox survives a crash/profile outage between the approval
    /// commit and the transcript append. A retry recognises the exact event
    /// already synced, rather than recording another approval.
    pub(crate) fn deliver_auto_plan_notices(&self) -> Result<(), String> {
        // Reader and scheduler may both retry. Serialize read/append/receipt
        // so they cannot each append the same event before seeing the other.
        let _delivery = self.auto_plan_delivery.lock().map_err(|e| e.to_string())?;
        let pending = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner.data.auto_plan_notices.clone()
        };
        for (id, notice) in pending {
            let Some(record) = crate::transcript::generation(&notice.chat_key) else {
                continue;
            };
            let exists = crate::transcript::of_type(&notice.chat_key, "octiq_plan_auto_approved")
                .iter()
                .any(|other| other == &notice.event);
            let written = if exists {
                crate::transcript::confirm_synced(&notice.chat_key, &record).is_some()
            } else {
                crate::agent_chat::record_chat_event_in(
                    &notice.chat_key,
                    Some(&record),
                    notice.event.clone(),
                ) == crate::transcript::Held::Confirmed
            };
            if written {
                self.mutate(|data| {
                    data.auto_plan_notices.remove(&id);
                    Ok(())
                })?;
            }
        }
        Ok(())
    }
}

/// Snapshot every pending revision, including held plans. A change to the
/// waiting set cannot silently become part of an earlier clean turn's consent.
fn pending_plans(data: &Stored, chat: &str) -> BTreeMap<String, (u32, Vec<String>)> {
    data.runs
        .values()
        .filter(|run| {
            run.coordinator_chat_key == chat
                && !run_has_ended(run)
                && run.archived_at.is_none()
                && run.awaiting_plan_approval()
        })
        .map(|run| {
            let mut waiting: Vec<_> = awaiting_approval(data, &run.id)
                .map(|t| t.id.clone())
                .collect();
            waiting.sort();
            (
                run.id.clone(),
                (run.plan_approval.as_ref().unwrap().revision, waiting),
            )
        })
        .collect()
}

fn approve_in(data: &mut Stored, chat: &str) -> Result<Vec<Run>, String> {
    let Some(saved) = data.auto_plan_chats.get(chat) else {
        return Ok(Vec::new());
    };
    let enabled_at = saved.enabled_at;
    let runs: Vec<_> = data
        .runs
        .values()
        .filter(|run| {
            run.coordinator_chat_key == chat
                && !run_has_ended(run)
                && run.archived_at.is_none()
                && run.awaiting_plan_approval()
                && awaiting_approval(data, &run.id).next().is_some()
                && held(data, run).is_none()
        })
        .map(|run| run.id.clone())
        .collect();
    let mut approved = Vec::new();
    for id in runs {
        let revision = data.runs[&id].plan_approval.as_ref().unwrap().revision;
        let waiting: Vec<_> = awaiting_approval(data, &id).collect();
        let task_ids: Vec<_> = waiting.iter().map(|t| t.id.clone()).collect();
        let task_titles: Vec<_> = waiting.iter().map(|t| t.title.clone()).collect();
        let run = decide_plan_in(
            data,
            chat,
            &id,
            Some(&task_ids),
            Some(revision),
            PlanDecision::Approve(
                PlanConsent {
                    via: ConsentVia::Standing,
                    enabled_at: Some(enabled_at),
                    revision,
                    at: now_ms(),
                    turn_id: None,
                    words: None,
                    surface: None,
                    shown_ms: None,
                },
                BTreeMap::new(),
            ),
        )?;
        let at = run
            .plan_approval
            .as_ref()
            .unwrap()
            .consent
            .as_ref()
            .unwrap()
            .at;
        let source = format!("plan-auto-approved:{id}:{revision}");
        data.auto_plan_notices.insert(source.clone(), Notice { chat_key: chat.into(), event: json!({
            "type": "octiq_plan_auto_approved", "runId": id, "revision": revision,
            "taskIds": task_ids, "taskTitles": task_titles, "at": at, "enabledAt": enabled_at,
        }) });
        let dispatch = if run.worker_defaults.is_none() {
            "automatic dispatch is paused; the coordinator starts the workers."
        } else {
            "the host dispatches it."
        };
        inbox::enqueue(
            data,
            &id,
            "host",
            chat,
            source,
            "plan_auto_approved",
            format!(
                "Plan revision {revision} was auto-approved under this chat's setting; {dispatch}"
            ),
        );
        approved.push(run);
    }
    Ok(approved)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{run, task};
    use super::*;

    fn defaults(access: Access) -> automation::WorkerDefaults {
        automation::WorkerDefaults {
            agent: Some(ChatAgent::Claude),
            access,
            model: None,
            effort: None,
            recovery: None,
        }
    }
    fn pending(store: &OrchestrationStore, access: Access) -> (Run, Task) {
        let run = run(store);
        store.require_plan_approval(&run.id).unwrap();
        store
            .configure_automation("chat:master", &run.id, Some(defaults(access)))
            .unwrap();
        let task = task(store, &run, vec![]);
        (run, task)
    }
    fn apply(store: &OrchestrationStore, chat: &str) -> Vec<Run> {
        store.mutate(|data| approve_in(data, chat)).unwrap()
    }
    fn fact(name: &str, snapshot: &Snapshot) {
        if std::env::var_os("OCTIQ_RECORD_FACTS").is_some() {
            println!("FACT {name} {}", serde_json::to_value(snapshot).unwrap());
        }
    }

    #[test]
    fn auto_plan_veto_after_staging_keeps_memory_disk_and_outbox_unchanged() {
        let dir = crate::test_dir::TestDir::new("auto-plan-staged-veto");
        let path = dir.join("ledger.json");
        let store = OrchestrationStore::load(path.clone());
        let (run, _) = pending(&store, Access::Auto);
        store.auto_plan_set("chat:master", true).unwrap();
        let before = fs::read(&path).unwrap();
        let chats = ChatManager::default();
        chats.test_launch("chat:master");
        let ended = chats.test_clean_turn_end("chat:master");
        store
            .auto_approve_at_turn_end_with(
                ended,
                || {},
                || {
                    // The full candidate approval (including notices/inbox) is
                    // already written, while the published ledger is unchanged.
                    assert_eq!(fs::read(&path).unwrap(), before);
                    let staged: Vec<_> = fs::read_dir(&*dir)
                        .unwrap()
                        .map(|entry| entry.unwrap().path())
                        .filter(|entry| entry != &path)
                        .collect();
                    assert_eq!(staged.len(), 1);
                    let staged: serde_json::Value =
                        serde_json::from_slice(&fs::read(&staged[0]).unwrap()).unwrap();
                    assert!(!staged["auto_plan_notices"].as_object().unwrap().is_empty());
                    chats.test_end("chat:master"); // increments the evidence epoch
                },
            )
            .unwrap();
        let inner = store.inner.lock().unwrap();
        assert_eq!(
            inner.data.runs[&run.id]
                .plan_approval
                .as_ref()
                .unwrap()
                .status,
            PlanStatus::Pending
        );
        assert!(inner.data.auto_plan_notices.is_empty());
        assert!(inner.data.notifications.is_empty());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(fs::read_dir(&*dir).unwrap().count(), 1);
    }

    #[test]
    fn auto_plan_covers_all_access_levels_and_records_each_revision_once() {
        for access in [
            Access::Read,
            Access::Manual,
            Access::Edits,
            Access::Auto,
            Access::Full,
        ] {
            let store = OrchestrationStore::default();
            let (run, first) = pending(&store, access);
            let saved = store.auto_plan_set("chat:master", true).unwrap();
            assert_eq!(
                apply(&store, "chat:master").len(),
                usize::from(access != Access::Full)
            );
            let page = store.snapshot(Some(&run.id)).unwrap();
            let plan = page.runs[0].plan_approval.as_ref().unwrap();
            if access == Access::Full {
                assert_eq!(plan.status, PlanStatus::Pending);
                assert_eq!(
                    page.runs[0]
                        .auto_plan
                        .as_ref()
                        .unwrap()
                        .held
                        .as_ref()
                        .unwrap()
                        .task_ids,
                    [first.id.clone()]
                );
                fact("auto_plan_held_access", &page);
                continue;
            }
            assert_eq!(plan.status, PlanStatus::Approved);
            let consent = plan.consent.as_ref().unwrap();
            assert_eq!(consent.via, ConsentVia::Standing);
            assert_eq!(consent.enabled_at, saved.enabled_at);
            assert_eq!(
                page.tasks[0].approved.as_ref().unwrap().by,
                approval::FixedBy::Plan
            );
            assert_eq!(
                page.tasks[0]
                    .approved
                    .as_ref()
                    .unwrap()
                    .worker
                    .as_ref()
                    .unwrap()
                    .access,
                access
            );
            assert!(page.runs[0].auto_plan.as_ref().unwrap().held.is_none());
            assert!(apply(&store, "chat:master").is_empty());
            assert_eq!(store.inner.lock().unwrap().data.auto_plan_notices.len(), 1);
            if access == Access::Auto {
                fact("auto_plan_approved", &page);
            }
            let second = task(&store, &run, vec![]);
            let again = apply(&store, "chat:master");
            assert_eq!(again.len(), 1);
            assert!(again[0].plan_approval.as_ref().unwrap().revision > consent.revision);
            let data = &store.inner.lock().unwrap().data;
            assert!(data.tasks[&second.id].approved_at.is_some());
            assert_eq!(data.auto_plan_notices.len(), 2);
            assert_eq!(data.notifications.len(), 2);
        }
    }

    #[test]
    fn auto_plan_notice_explains_paused_automatic_dispatch() {
        let store = OrchestrationStore::default();
        let (run, task) = pending(&store, Access::Auto);
        store
            .mutate(|data| {
                data.tasks.get_mut(&task.id).unwrap().worker = Some(automation::WorkerSettings {
                    agent: ChatAgent::Claude,
                    access: Access::Auto,
                    model: None,
                    effort: None,
                    recovery: None,
                });
                data.runs.get_mut(&run.id).unwrap().worker_defaults = None;
                Ok(())
            })
            .unwrap();
        store.auto_plan_set("chat:master", true).unwrap();
        assert_eq!(apply(&store, "chat:master").len(), 1);
        let inner = store.inner.lock().unwrap();
        let notice = inner.data.notifications.values().next().unwrap();
        assert!(notice.body.contains("automatic dispatch is paused"));
        assert!(notice.body.contains("coordinator starts the workers"));
        assert!(!notice.body.contains("the host dispatches it"));
    }

    #[test]
    fn auto_plan_requires_setting_coordinator_live_pending_and_nonempty() {
        for condition in [
            "off",
            "other-chat",
            "stopped",
            "completed",
            "failed",
            "closed",
            "archived",
            "no-plan",
            "approved",
            "rejected",
            "empty",
            "eligible",
        ] {
            let store = OrchestrationStore::default();
            let (run, task) = pending(&store, Access::Auto);
            store.auto_plan_set("chat:master", true).unwrap();
            if condition == "off" {
                store.auto_plan_set("chat:master", false).unwrap();
            }
            store
                .mutate(|data| {
                    let run = data.runs.get_mut(&run.id).unwrap();
                    match condition {
                        "stopped" => run.status = RunStatus::Stopped,
                        "completed" => run.status = RunStatus::Completed,
                        "failed" => run.status = RunStatus::Failed,
                        "closed" => run.status = RunStatus::Closed,
                        "archived" => run.archived_at = Some(now_ms()),
                        "no-plan" => run.plan_approval = None,
                        "approved" => {
                            run.plan_approval.as_mut().unwrap().status = PlanStatus::Approved
                        }
                        "rejected" => {
                            run.plan_approval.as_mut().unwrap().status = PlanStatus::Rejected
                        }
                        "empty" => {
                            data.tasks.get_mut(&task.id).unwrap().status = TaskStatus::Cancelled
                        }
                        _ => (),
                    }
                    Ok(())
                })
                .unwrap();
            let approved = apply(
                &store,
                if condition == "other-chat" {
                    "chat:other"
                } else {
                    "chat:master"
                },
            );
            assert_eq!(
                approved.len(),
                usize::from(condition == "eligible"),
                "{condition}"
            );
        }
    }

    #[test]
    fn auto_plan_holds_the_whole_waiting_set_for_full_access_or_peer_requests() {
        for peer in [false, true] {
            let store = OrchestrationStore::default();
            let (run, safe) = pending(&store, Access::Auto);
            let risk = task(&store, &run, vec![]);
            store
                .mutate(|data| {
                    let risk = data.tasks.get_mut(&risk.id).unwrap();
                    if peer {
                        risk.peer_request = Some(peer_request::PeerRequest {
                            requested_by: TaskAssignee {
                                id: "peer".into(),
                                name: "Peer".into(),
                            },
                            requester_chat_key: "chat:peer".into(),
                            requester_attempt_id: None,
                            output: "answer".into(),
                            max_minutes: 1,
                            requested_at: now_ms(),
                        });
                    } else {
                        risk.worker = Some(automation::WorkerSettings {
                            agent: ChatAgent::Claude,
                            access: Access::Full,
                            model: None,
                            effort: None,
                            recovery: None,
                        });
                    }
                    Ok(())
                })
                .unwrap();
            store.auto_plan_set("chat:master", true).unwrap();
            assert!(apply(&store, "chat:master").is_empty());
            let page = store.snapshot(Some(&run.id)).unwrap();
            assert!(page.tasks.iter().all(|t| t.approved_at.is_none()));
            let held = page.runs[0]
                .auto_plan
                .as_ref()
                .unwrap()
                .held
                .as_ref()
                .unwrap();
            assert_eq!(held.reason, if peer { "peerRequest" } else { "access" });
            assert_eq!(held.task_ids, [risk.id.clone()]);
            assert!(!held.task_ids.contains(&safe.id));
        }
    }

    #[test]
    fn auto_plan_uses_effective_worker_defaults_and_fixed_worker() {
        for (inherited, explicit, fixed, expected) in [
            (Access::Full, None, None, false),
            (Access::Full, Some(Access::Auto), None, true),
            (Access::Auto, Some(Access::Full), None, false),
            (Access::Auto, Some(Access::Auto), Some(Access::Full), false),
            (Access::Full, Some(Access::Full), Some(Access::Auto), true),
        ] {
            let store = OrchestrationStore::default();
            let (run, task) = pending(&store, inherited);
            store
                .mutate(|data| {
                    let task = data.tasks.get_mut(&task.id).unwrap();
                    task.worker = explicit.map(|access| automation::WorkerSettings {
                        agent: ChatAgent::Claude,
                        access,
                        model: None,
                        effort: None,
                        recovery: None,
                    });
                    if let Some(access) = fixed {
                        let mut approved =
                            approval::Approved::of(None, task, approval::FixedBy::Plan, now_ms());
                        approved.worker = Some(automation::WorkerSettings {
                            agent: ChatAgent::Claude,
                            access,
                            model: None,
                            effort: None,
                            recovery: None,
                        });
                        task.approved = Some(approved);
                    }
                    Ok(())
                })
                .unwrap();
            store.auto_plan_set("chat:master", true).unwrap();
            assert_eq!(!apply(&store, "chat:master").is_empty(), expected);
            assert_eq!(store.snapshot(Some(&run.id)).unwrap().runs.len(), 1);
        }
        let store = OrchestrationStore::default();
        let run = run(&store);
        store.require_plan_approval(&run.id).unwrap();
        task(&store, &run, vec![]);
        store.auto_plan_set("chat:master", true).unwrap();
        assert!(
            apply(&store, "chat:master").is_empty(),
            "no effective worker proves no access bound"
        );
    }

    #[test]
    fn auto_plan_setting_and_audit_outbox_survive_restart_and_reads_never_persist_derived_facts() {
        let dir = crate::test_dir::TestDir::new("auto-plan-restart");
        let _profile = crate::profile::started_in(&dir.0);
        let path = dir.0.join("ledger.json");
        let store = OrchestrationStore::load(path.clone());
        let (run, _) = pending(&store, Access::Auto);
        let saved = store.auto_plan_set("chat:master", true).unwrap();
        let restarted = OrchestrationStore::load(path.clone());
        assert_eq!(restarted.auto_plan_get("chat:master").unwrap(), saved);
        assert_eq!(
            restarted.auto_plan_set("chat:master", true).unwrap(),
            saved,
            "idempotent enable keeps consent time"
        );
        assert!(restarted.snapshot(Some(&run.id)).unwrap().runs[0]
            .auto_plan
            .is_some());
        apply(&restarted, "chat:master");
        let mut disk: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(disk["runs"][&run.id].get("autoPlan").is_none());
        disk["runs"][&run.id]["autoPlan"] =
            json!({"enabled":true,"held":{"reason":"peerRequest","taskIds":[]}});
        fs::write(&path, serde_json::to_vec(&disk).unwrap()).unwrap();
        let restarted = OrchestrationStore::load(path);
        let page = restarted.snapshot(Some(&run.id)).unwrap();
        assert!(page.runs[0].auto_plan.as_ref().unwrap().held.is_none());
        assert_eq!(
            restarted.inner.lock().unwrap().data.auto_plan_notices.len(),
            1
        );
        restarted.deliver_auto_plan_notices().unwrap();
        restarted.deliver_auto_plan_notices().unwrap();
        let events = crate::transcript::of_type("chat:master", "octiq_plan_auto_approved");
        assert_eq!(events.iter().filter(|e| e["runId"] == run.id).count(), 1);
        let event = events.iter().find(|e| e["runId"] == run.id).unwrap();
        assert_eq!(event["enabledAt"], saved.enabled_at.unwrap());
        assert_eq!(event["taskIds"].as_array().unwrap().len(), 1);
        assert_eq!(event["taskTitles"].as_array().unwrap().len(), 1);
        assert!(restarted
            .inner
            .lock()
            .unwrap()
            .data
            .auto_plan_notices
            .is_empty());
    }

    #[test]
    fn auto_plan_setting_changes_emit_the_browser_contract() {
        let store = OrchestrationStore::default();
        let chat = format!("chat:setting-event-{}", compact_id());
        let tap = crate::bus::tap::Tap::on(&chat);
        let on = store.auto_plan_set(&chat, true).unwrap();
        let off = store.auto_plan_set(&chat, false).unwrap();
        let events: Vec<_> = tap
            .heard()
            .into_iter()
            .filter(|(kind, _)| kind == "orchestration-auto-plan")
            .collect();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].1, serde_json::to_value(on).unwrap());
        assert_eq!(events[1].1, serde_json::to_value(off).unwrap());
        assert!(events[1].1.get("enabledAt").is_none());
    }

    #[test]
    fn auto_plan_enable_requires_its_record_and_disable_acts_and_owes_a_failed_save() {
        let dir = crate::test_dir::TestDir::new("auto-plan-unsaved");
        let path = dir.0.join("ledger.json");
        let store = OrchestrationStore::load(path.clone());
        crate::profile::make_dir(&path).unwrap();
        assert!(store
            .auto_plan_set("chat:master", true)
            .unwrap_err()
            .contains("could not be recorded"));
        assert!(!store.auto_plan_get("chat:master").unwrap().enabled);
        fs::remove_dir(&path).unwrap();
        store.auto_plan_set("chat:master", true).unwrap();
        fs::remove_file(&path).unwrap();
        crate::profile::make_dir(&path).unwrap();
        assert!(!store.auto_plan_set("chat:master", false).unwrap().enabled);
        assert!(store.owes());
        assert!(!store.auto_plan_get("chat:master").unwrap().enabled);
        fs::remove_dir(&path).unwrap();
        assert!(store.settle_owed().unwrap());
        assert!(
            !OrchestrationStore::load(path)
                .auto_plan_get("chat:master")
                .unwrap()
                .enabled
        );
        assert!(store.auto_plan_set("chat:orch-never-seen", true).is_err());
    }
}

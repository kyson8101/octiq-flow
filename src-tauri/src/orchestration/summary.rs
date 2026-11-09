//! The facts shared by whole-app readers. Long run detail is fetched on demand.

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Membership only, never a second reading of waits. The page supplies the
/// chat identities from its one held-card reading. Historical panels opt in
/// within their visible scope; full run detail remains unchanged.
pub fn select(
    view: &mut Value,
    include_ended: bool,
    held_chats: &[String],
    coordinator: Option<&str>,
    workspace: Option<&str>,
) {
    // Routing identity outlives a run's visibility: old worker cards still
    // belong to their coordinator, and workers must not become sidebar roots.
    let coordinators: BTreeMap<_, _> = view["runs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some((
                r["id"].as_str()?.to_owned(),
                r["coordinatorChatKey"].as_str()?.to_owned(),
            ))
        })
        .collect();
    view["runCoordinators"] = json!(coordinators.values().collect::<BTreeSet<_>>());
    let parents: BTreeMap<_, _> = view["attempts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| {
            Some((
                a["workerChatKey"]
                    .as_str()?
                    .trim_start_matches("chat:")
                    .to_owned(),
                coordinators
                    .get(a["runId"].as_str()?)?
                    .trim_start_matches("chat:")
                    .to_owned(),
            ))
        })
        .collect();
    view["workerParents"] = json!(parents);
    let held_runs: BTreeSet<String> = view["attempts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| {
            a["workerChatKey"]
                .as_str()
                .is_some_and(|key| held_chats.iter().any(|held| held == key))
        })
        .filter_map(|a| a["runId"].as_str().map(str::to_owned))
        .collect();
    let ids: BTreeSet<String> = view["runs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            coordinator.is_none_or(|key| r["coordinatorChatKey"] == key)
                && workspace.is_none_or(|id| r["workspaceId"] == id)
        })
        .filter(|r| {
            include_ended
                || (r["archivedAt"].is_null()
                    && r["status"] != "closed"
                    && r["status"] != "stopped")
                || r["id"].as_str().is_some_and(|id| held_runs.contains(id))
        })
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect();
    for list in [
        "batches",
        "runs",
        "tasks",
        "attempts",
        "gates",
        "nativeDecisions",
        "messages",
        "notifications",
        "services",
        "bridges",
        "peerAsks",
    ] {
        if let Some(rows) = view[list].as_array_mut() {
            rows.retain(|row| {
                row[if list == "runs" { "id" } else { "runId" }]
                    .as_str()
                    .is_some_and(|id| ids.contains(id))
            });
        }
    }
}

/// Project a host-derived snapshot, never a stored ledger. Keep the same
/// arrays so runWaits/runProgress remain the single reading on every surface.
/// Empty text here means "ask for detail", never an edit of the saved text.
pub fn project(view: &mut Value) {
    for batch in items(view, "batches") {
        keep(
            batch,
            &[
                "id",
                "agentId",
                "runId",
                "repository",
                "baseBranch",
                "branch",
                "worktree",
                "taskIds",
                "status",
                "createdAt",
                "settledAt",
            ],
        );
    }
    let mut counts: BTreeMap<String, Value> = BTreeMap::new();
    for list in [
        "tasks",
        "attempts",
        "gates",
        "nativeDecisions",
        "messages",
        "notifications",
    ] {
        for item in view[list].as_array().into_iter().flatten() {
            let Some(run) = item["runId"].as_str() else {
                continue;
            };
            let count = counts.entry(run.to_owned()).or_insert_with(|| json!({"tasks":0,"attempts":0,"gates":0,"nativeDecisions":0,"messages":0,"notifications":0,"taskStatuses":{}}));
            count[list] = json!(count[list].as_u64().unwrap_or(0) + 1);
            if list == "tasks" {
                if let Some(status) = item["status"].as_str() {
                    count["taskStatuses"][status] =
                        json!(count["taskStatuses"][status].as_u64().unwrap_or(0) + 1);
                }
            }
        }
    }
    for run in items(view, "runs") {
        keep(
            run,
            &[
                "id",
                "objective",
                "coordinatorChatKey",
                "workspaceId",
                "rootPath",
                "status",
                "maxConcurrent",
                "workspaceMode",
                "createdAt",
                "updatedAt",
                "archivedAt",
                "closedAt",
                "abandoned",
                "planApproval",
                "autoPlan",
            ],
        );
        short(run, "objective");
        if let Some(plan) = run.get_mut("planApproval") {
            keep(
                plan,
                &[
                    "status",
                    "revision",
                    "requestedAt",
                    "decidedAt",
                    "revisedAt",
                ],
            );
        }
        run["counts"] = counts.remove(run["id"].as_str().unwrap_or_default()).unwrap_or_else(|| json!({"tasks":0,"attempts":0,"gates":0,"nativeDecisions":0,"messages":0,"notifications":0,"taskStatuses":{}}));
    }
    let available: BTreeSet<_> = view["attempts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|attempt| attempt["id"].as_str().map(str::to_owned))
        .collect();
    let mut active = BTreeSet::new();
    let mut needs_latest = BTreeSet::new();
    for task in items(view, "tasks") {
        keep(
            task,
            &[
                "id",
                "runId",
                "title",
                "worker",
                "assignee",
                "destination",
                "approvedAt",
                "size",
                "acceptance",
                "dependsOn",
                "parentTaskId",
                "splitBy",
                "status",
                "activeAttemptId",
                "kind",
                "verdict",
                "supersededBy",
                "heldByPlan",
                "heldByReopen",
                "retriesUsed",
                "retryLimit",
                "slotWait",
                "retrying",
                "failure",
                "reopens",
                "stopped",
                "peerRequest",
                "createdAt",
                "updatedAt",
            ],
        );
        // Required by the existing Snapshot type; never used by global readers.
        task["spec"] = json!("");
        if let Some(id) = task["activeAttemptId"]
            .as_str()
            .filter(|id| available.contains(*id))
        {
            active.insert(id.to_owned());
        } else if let Some(id) = task["id"].as_str() {
            needs_latest.insert(id.to_owned());
        }
        for reopen in items(task, "reopens") {
            keep(reopen, &["at", "noticeDelivered"]);
        }
        if let Some(peer) = task.get_mut("peerRequest") {
            keep(
                peer,
                &[
                    "requestedBy",
                    "requesterChatKey",
                    "requesterAttemptId",
                    "requestedAt",
                    "maxMinutes",
                ],
            );
        }
        if let Some(stop) = task.get_mut("stopped") {
            short(stop, "reason");
        }
    }
    // currentAttempt also falls back to the latest numbered attempt when a
    // task names no active one; keep that row's checklist too.
    let mut latest: BTreeMap<String, (u64, String)> = BTreeMap::new();
    for attempt in view["attempts"].as_array().into_iter().flatten() {
        let task = attempt["taskId"].as_str().unwrap_or_default();
        if !needs_latest.contains(task) {
            continue;
        }
        let number = attempt["number"].as_u64().unwrap_or(0);
        let Some(id) = attempt["id"].as_str() else {
            continue;
        };
        if latest.get(task).is_none_or(|(prior, _)| number >= *prior) {
            latest.insert(task.to_owned(), (number, id.to_owned()));
        }
    }
    active.extend(latest.into_values().map(|(_, id)| id));
    let mut report_keys = BTreeSet::new();
    for attempt in items(view, "attempts") {
        if active.contains(attempt["id"].as_str().unwrap_or_default()) {
            if let Some(key) = attempt["workerChatKey"].as_str() {
                report_keys.insert(key.to_owned());
            }
        }
        keep(
            attempt,
            &[
                "id",
                "runId",
                "taskId",
                "number",
                "batchId",
                "workerChatKey",
                "agent",
                "model",
                "effort",
                "access",
                "status",
                "cwd",
                "branch",
                "isWorktree",
                "execution",
                "finishedAt",
                "archivedAt",
                "proposedReport",
                "usage",
                "context",
                "retry",
                "createdAt",
                "updatedAt",
            ],
        );
        attempt["filesModified"] = json!([]);
        if let Some(execution) = attempt.get_mut("execution") {
            compact_execution(execution);
        }
        if let Some(proposal) = attempt.get_mut("proposedReport") {
            keep(
                proposal,
                &[
                    "id",
                    "capturedAt",
                    "confirmedAt",
                    "confirmedBy",
                    "truncated",
                ],
            );
            proposal["text"] = json!("");
        }
    }
    for (list, status, fields) in [
        (
            "gates",
            "open",
            &[
                "id",
                "runId",
                "taskId",
                "aboutTaskId",
                "status",
                "awaits",
                "createdAt",
                "updatedAt",
            ][..],
        ),
        (
            "nativeDecisions",
            "pending",
            &[
                "id",
                "runId",
                "taskId",
                "attemptId",
                "chatKey",
                "status",
                "awaits",
                "continuation",
                "kind",
                "groupId",
                "reason",
                "blockedAction",
                "recovery",
                "observedAt",
            ][..],
        ),
    ] {
        if let Some(array) = view[list].as_array_mut() {
            array.retain(|item| item["status"] == status);
            for item in array {
                keep(item, fields);
                if list == "gates" {
                    item["question"] = json!("");
                    item["options"] = json!([]);
                }
                for field in ["reason", "blockedAction", "recovery"] {
                    short(item, field);
                }
            }
        }
    }
    if let Some(reports) = view["reports"].as_object_mut() {
        reports.retain(|key, _| report_keys.contains(key));
        for report in reports.values_mut() {
            keep(report, &["steps", "reportedAt", "reportedBy"]);
            report["objective"] = json!("");
            report["nextStep"] = json!("");
            for step in items(report, "steps") {
                short(step, "title");
            }
        }
    }
    for list in [
        "messages",
        "notifications",
        "services",
        "bridges",
        "peerAsks",
    ] {
        view[list] = json!([]);
    }
    view["summary"] = json!(true);
}

/// Also used for opt-in sockets' execution patch: lastProgress can contain a
/// whole tool result, and isn't drawn even in the old global feed.
pub fn compact_execution(execution: &mut Value) {
    keep(
        execution,
        &[
            "state",
            "lastActivityAt",
            "lastProgressAt",
            "currentOperation",
            "latestError",
            "retryCount",
            "nextRetryAt",
            "retryModel",
            "stalledAt",
        ],
    );
    short(execution, "currentOperation");
    if let Some(error) = execution.get_mut("latestError") {
        short(error, "message");
    }
}

fn keep(value: &mut Value, fields: &[&str]) {
    if let Some(object) = value.as_object_mut() {
        object.retain(|key, _| fields.contains(&key.as_str()));
    }
}

fn short(value: &mut Value, field: &str) {
    if let Some(text) = value[field]
        .as_str()
        .filter(|text| text.chars().count() > 512)
    {
        value[field] = json!(text.chars().take(512).collect::<String>());
    }
}

fn items<'a>(value: &'a mut Value, field: &str) -> impl Iterator<Item = &'a mut Value> {
    value
        .get_mut(field)
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn global_selection_drops_history_but_keeps_held_chat_candidates_and_routing() {
        let original = json!({
            "runs":[{"id":"live","status":"running","workspaceId":"p","coordinatorChatKey":"chat:main"},
                {"id":"stopped","status":"stopped","workspaceId":"p","coordinatorChatKey":"chat:main"},
                {"id":"closed","status":"closed","workspaceId":"q","coordinatorChatKey":"chat:other"},
                {"id":"archived","status":"completed","archivedAt":1,"workspaceId":"p","coordinatorChatKey":"chat:main"}],
            "tasks":[{"id":"t","runId":"stopped"}],
            "attempts":[{"id":"a","runId":"stopped","workerChatKey":"chat:worker"}],
            "gates":[{"id":"g","runId":"stopped","status":"open","awaits":"person"}],
            "reports":{"chat:worker":{"steps":[]}},"messages":[{"runId":"closed"}]
        });
        let mut view = original.clone();
        select(&mut view, false, &[], None, None);
        project(&mut view);
        assert_eq!(view["runs"].as_array().unwrap().len(), 1);
        assert_eq!(view["runs"][0]["id"], "live");
        assert!(view["tasks"].as_array().unwrap().is_empty());
        assert!(view["gates"].as_array().unwrap().is_empty());
        assert!(view["reports"].as_object().unwrap().is_empty());
        assert_eq!(view["workerParents"]["worker"], "main");
        let mut held = original.clone();
        select(&mut held, false, &["chat:worker".into()], None, None);
        assert_eq!(held["runs"].as_array().unwrap().len(), 2);
        assert_eq!(held["tasks"][0]["id"], "t");
        let mut history = original;
        select(&mut history, true, &[], Some("chat:main"), Some("p"));
        assert_eq!(history["runs"].as_array().unwrap().len(), 3);
        assert!(history["messages"].as_array().unwrap().is_empty());
    }

    #[test]
    #[ignore = "read-only measurement of a separately captured real wire snapshot"]
    fn measure_captured_snapshot() {
        let path = std::env::var("OCTIQ_SUMMARY_MEASURE_INPUT").expect("captured wire JSON path");
        let mut view: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let before = serde_json::to_vec(&view).unwrap().len();
        project(&mut view);
        crate::bus::orchestration_revisions().stamp(&mut view, None);
        let after = serde_json::to_vec(&view).unwrap().len();
        println!("captured snapshot: {before} bytes; summary: {after} bytes");
        assert!(
            after * 5 < before,
            "real profile summary should be below 20% of full snapshot"
        );
    }

    #[test]
    fn summary_preserves_the_one_reading_of_waits_holds_and_progress() {
        let mut view = json!({
            "runs":[{"id":"r", "status":"waiting", "coordinatorChatKey":"chat:lead", "planApproval":{"status":"pending","revision":7}}],
            "tasks":[{"id":"t","runId":"r","title":"Review","status":"completed","kind":"review","verdict":"fail","activeAttemptId":"a","dependsOn":["prior"],"approvedAt":5,"splitBy":"parent-attempt","parentTaskId":"parent","supersededBy":"replacement","heldByPlan":false,"heldByReopen":true,"retryLimit":2,"retriesUsed":2,"retrying":true,"failure":{"kind":"check_failed","awaits":"person"},"spec":"LONG","result":"LONG","reopens":[{"at":10,"noticeDelivered":false,"spec":"LONG","previousSpec":"LONG"}],"peerRequest":{"requestedBy":{"id":"agent"},"maxMinutes":5,"output":"LONG"}}],
            "attempts":[{"id":"a","runId":"r","taskId":"t","workerChatKey":"chat:worker","status":"completed","number":2,"usage":{"input":5,"output":6},"context":{"tokens":3,"window":200},"execution":{"state":"awaiting_report","lastProgress":"LONG","pendingTools":{"tool":"LONG"},"lastActivityAt":12},"proposedReport":{"id":"p","text":"LONG","confirmedAt":null},"summary":"LONG","filesModified":["LONG"]}],
            "gates":[{"id":"g","runId":"r","aboutTaskId":"t","status":"open","awaits":"person","question":"LONG"},{"id":"old","runId":"r","status":"answered"}],
            "nativeDecisions":[{"id":"d","runId":"r","taskId":"t","attemptId":"a","status":"pending","awaits":"nobody","continuation":"unavailable","kind":"outage","groupId":"outage"}],
            "reports":{"chat:worker":{"reportedAt":12,"steps":[{"title":"Verify","state":"active"}]},"unrelated":{"steps":[]}},
            "messages":[{"runId":"r","body":"LONG"}],"notifications":[{"runId":"r","body":"LONG"}],"services":[],"bridges":[],"peerAsks":[]
        });
        let before = view.clone();
        project(&mut view);
        for field in [
            "status",
            "kind",
            "verdict",
            "activeAttemptId",
            "dependsOn",
            "approvedAt",
            "splitBy",
            "parentTaskId",
            "supersededBy",
            "heldByPlan",
            "heldByReopen",
            "retryLimit",
            "retriesUsed",
            "retrying",
            "failure",
        ] {
            assert_eq!(
                view["tasks"][0][field], before["tasks"][0][field],
                "task {field}"
            );
        }
        assert_eq!(
            view["tasks"][0]["reopens"][0],
            json!({"at":10,"noticeDelivered":false})
        );
        assert_eq!(
            view["runs"][0]["planApproval"],
            before["runs"][0]["planApproval"]
        );
        assert_eq!(view["attempts"][0]["usage"], before["attempts"][0]["usage"]);
        assert_eq!(
            view["attempts"][0]["context"],
            before["attempts"][0]["context"]
        );
        assert_eq!(view["attempts"][0]["proposedReport"]["id"], "p");
        assert_eq!(view["attempts"][0]["execution"]["state"], "awaiting_report");
        assert!(view["attempts"][0]["execution"]
            .get("lastProgress")
            .is_none());
        assert_eq!(view["gates"].as_array().unwrap().len(), 1);
        assert_eq!(view["gates"][0]["aboutTaskId"], "t");
        assert_eq!(view["gates"][0]["awaits"], "person");
        assert_eq!(view["nativeDecisions"], before["nativeDecisions"]);
        assert_eq!(
            view["reports"]["chat:worker"]["steps"],
            before["reports"]["chat:worker"]["steps"]
        );
        assert!(view["reports"].get("unrelated").is_none());
        assert_eq!(view["runs"][0]["counts"]["tasks"], 1);
        assert_eq!(view["runs"][0]["counts"]["messages"], 1);
        assert!(view["messages"].as_array().unwrap().is_empty());
        assert!(!view.to_string().contains("LONG"));
    }

    #[test]
    fn summary_size_does_not_grow_with_run_history_text() {
        let long = "x".repeat(20_000);
        let mut view = json!({"runs":[],"tasks":[],"attempts":[],"gates":[],"nativeDecisions":[],"reports":{},"messages":[],"notifications":[],"services":[],"bridges":[],"peerAsks":[]});
        for i in 0..800 {
            let run = format!("r{}", i / 8);
            if i % 8 == 0 {
                view["runs"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"id":run,"status":"running"}));
            }
            view["tasks"].as_array_mut().unwrap().push(json!({"id":format!("t{i}"),"runId":run,"title":"Task","status":"running","spec":long,"result":long,"card":{"problem":long},"approved":{"result":long},"reopens":[{"at":3,"noticeDelivered":false,"spec":long,"previousSpec":long}]}));
            view["attempts"].as_array_mut().unwrap().push(json!({"id":format!("a{i}"),"runId":run,"taskId":format!("t{i}"),"status":"running","summary":long,"execution":{"state":"executing","lastProgress":long,"pendingTools":{"tool":long}}}));
        }
        let full = serde_json::to_vec(&view).unwrap().len();
        project(&mut view);
        let small = serde_json::to_vec(&view).unwrap().len();
        println!("big fixture: {full} bytes; summary: {small} bytes");
        assert!(full > 100_000_000);
        assert!(small < 1_000_000, "summary: {small}, full: {full}");
        assert!(small * 100 < full);
        assert_eq!(view["runs"].as_array().unwrap().len(), 100);
        assert_eq!(view["tasks"].as_array().unwrap().len(), 800);
    }
}

#[cfg(test)]
mod batch_summary_tests {
    use super::*;
    #[test]
    fn keeps_batch_identity_task_ids_and_objective() {
        let mut value = serde_json::json!({
            "runs": [{ "id": "r", "objective": "Ship Agents orientation", "status": "running" }],
            "tasks": [{ "id": "t", "runId": "r", "status": "running", "activeAttemptId": "a" }],
            "attempts": [{ "id": "a", "taskId": "t", "runId": "r", "batchId": "b", "status": "running" }],
            "batches": [{ "id": "b", "agentId": "agent", "runId": "r", "branch": "agent/agent/b", "taskIds": ["t"], "status": "working" }]
        });
        project(&mut value);
        assert_eq!(value["runs"][0]["objective"], "Ship Agents orientation");
        assert_eq!(value["attempts"][0]["batchId"], "b");
        assert_eq!(value["batches"][0]["taskIds"], serde_json::json!(["t"]));
        assert_eq!(value["batches"][0]["status"], "working");
    }
}

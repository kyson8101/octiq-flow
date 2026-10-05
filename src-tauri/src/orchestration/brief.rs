//! The browser's whole-ledger read, without the long text of finished runs.
//!
//! Every tab reads the whole ledger when it opens and again after most
//! changes. On a profile with 95 runs that read was 6.5 MB, though 87 of the
//! runs had finished and their task specs, results, attempt summaries and
//! message and notification bodies are drawn in one place only: the run panel,
//! when that run is open. (A worker's `lastProgress` line, 0.7 MB of it, is
//! drawn nowhere.) So the read leaves them out for finished runs and
//! names those runs in `briefRuns`; the panel asks for one run whole
//! (`orchestration_snapshot` with its `runId`) when it shows it. Everything a
//! row, a badge or a status is worked out from stays in.
use std::collections::BTreeSet;

use serde_json::{json, Value};

/// A run nothing more will happen in, unless a task is reopened — which makes
/// it active again, and whole in the next read.
fn finished(run: &Value) -> bool {
    !run["archivedAt"].is_null()
        || matches!(
            run["status"].as_str(),
            Some("completed" | "failed" | "stopped")
        )
}

/// Leave the long text of finished runs out of a serialized `Snapshot`.
pub fn brief(view: &mut Value) {
    let runs: BTreeSet<String> = view["runs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|run| finished(run))
        .filter_map(|run| run["id"].as_str().map(str::to_owned))
        .collect();
    let fields: [(&str, &[&str]); 4] = [
        ("tasks", &["spec", "result"]),
        ("attempts", &["summary"]),
        ("messages", &["body"]),
        ("notifications", &["body"]),
    ];
    for (list, texts) in fields {
        let items = view[list].as_array_mut().into_iter().flatten();
        for item in items.filter(|item| item["runId"].as_str().is_some_and(|id| runs.contains(id)))
        {
            for &text in texts {
                empty(item, text);
            }
            // A worker's last progress line, which no page draws at all.
            if let Some(execution) = item.get_mut("execution").filter(|e| e.is_object()) {
                empty(execution, "lastProgress");
            }
        }
    }
    view["briefRuns"] = json!(runs);
}

fn empty(item: &mut Value, field: &str) {
    match item.get(field) {
        Some(Value::String(_)) => item[field] = json!(""),
        Some(Value::Null) | None => {}
        Some(_) => item[field] = Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_finished_runs_lose_their_long_text() {
        let mut view = json!({
            "runs": [
                {"id": "run_done", "status": "completed", "archivedAt": null},
                {"id": "run_live", "status": "running", "archivedAt": null},
                {"id": "run_shelved", "status": "waiting", "archivedAt": 5},
            ],
            "tasks": [
                {"id": "t1", "runId": "run_done", "title": "Ship it", "spec": "long", "result": "done well", "status": "completed"},
                {"id": "t2", "runId": "run_live", "title": "Build it", "spec": "long", "result": null},
                {"id": "t3", "runId": "run_shelved", "spec": "long", "result": "x"},
            ],
            "attempts": [
                {"id": "a1", "runId": "run_done", "summary": "what happened", "status": "completed",
                    "execution": {"state": "completed", "lastProgress": "a long line"}},
                {"id": "a2", "runId": "run_live", "summary": "so far"},
            ],
            "messages": [{"id": "m1", "runId": "run_done", "subject": "Hi", "body": "long"}],
            "notifications": [{"id": "n1", "runId": "run_live", "body": "long"}],
        });
        brief(&mut view);
        assert_eq!(view["briefRuns"], json!(["run_done", "run_shelved"]));
        assert_eq!(view["tasks"][0]["spec"], "");
        assert_eq!(view["tasks"][0]["result"], "");
        assert_eq!(view["tasks"][0]["title"], "Ship it");
        assert_eq!(view["tasks"][0]["status"], "completed");
        assert_eq!(view["tasks"][1]["spec"], "long");
        assert_eq!(view["tasks"][2]["spec"], "");
        assert_eq!(view["attempts"][0]["summary"], "");
        assert_eq!(view["attempts"][0]["status"], "completed");
        assert_eq!(view["attempts"][0]["execution"]["lastProgress"], "");
        assert_eq!(view["attempts"][0]["execution"]["state"], "completed");
        assert_eq!(view["attempts"][1]["summary"], "so far");
        assert_eq!(view["messages"][0]["body"], "");
        assert_eq!(view["messages"][0]["subject"], "Hi");
        assert_eq!(view["notifications"][0]["body"], "long");
    }
}

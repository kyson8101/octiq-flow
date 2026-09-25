//! What an agent reads when it calls `orchestration_snapshot`.
//!
//! The browser gets the whole store; an agent gets this. A master re-reads the
//! snapshot after every worker report, and every read is written into its
//! transcript and broadcast to every open tab. Handing it the whole run made
//! each read grow with the run: one 32-task master made 236 reads, the last
//! near 1 MB, and its record reached 154 MB — 97% of it snapshots. Most of each
//! read was the run's full message history and the specs the master wrote.
//!
//! So the default read is what the next decision needs — the run, every task's
//! status, the authoritative attempt per task, gates, undelivered notifications
//! and the latest messages — with long text clipped and marked as clipped.
//! `taskId` returns one task in full: its spec, every attempt, its gates and the
//! messages exchanged with its workers.
use super::*;
use serde_json::{Map, Value};

pub const DEFAULT_MESSAGES: usize = 12;
pub const MAX_MESSAGES: usize = 100;
const TEXT_LIMIT: usize = 600;
const SETTLED_TEXT_LIMIT: usize = 200;
const DETAIL_TEXT_LIMIT: usize = 4_000;
const HINT: &str = "Compact view: task specs, superseded attempts and older messages are left out, and long text is clipped. Pass taskId for one task in full, runId for another run, messageLimit (up to 100) for more messages.";

pub struct AgentRead<'a> {
    pub actor: &'a str,
    /// A named run is never scoped away; without one, the actor's own runs.
    pub run_id: Option<&'a str>,
    pub task_id: Option<&'a str>,
    pub message_limit: usize,
}

pub fn agent_snapshot(snapshot: Snapshot, read: &AgentRead) -> Result<Value, String> {
    let Snapshot {
        runs,
        tasks,
        attempts,
        gates,
        messages,
        notifications,
        reports,
        native_decisions,
        services,
    } = snapshot;
    let limit = read.message_limit.clamp(1, MAX_MESSAGES);

    let focus = match read.task_id {
        Some(id) => Some(
            tasks
                .iter()
                .find(|task| task.id == id)
                .cloned()
                .ok_or("The task does not exist.")?,
        ),
        None => None,
    };
    let scope: BTreeSet<String> = match (&focus, read.run_id) {
        (Some(task), _) => BTreeSet::from([task.run_id.clone()]),
        (None, Some(id)) => BTreeSet::from([id.to_string()]),
        (None, None) => actor_runs(&runs, &attempts, read.actor),
    };
    let omitted_runs = runs.iter().filter(|run| !scope.contains(&run.id)).count();
    let runs: Vec<_> = runs
        .into_iter()
        .filter(|run| scope.contains(&run.id))
        .collect();
    let tasks: Vec<_> = tasks
        .into_iter()
        .filter(|task| scope.contains(&task.run_id))
        .collect();
    let attempts: Vec<_> = attempts
        .into_iter()
        .filter(|attempt| scope.contains(&attempt.run_id))
        .collect();
    let gates: Vec<_> = gates
        .into_iter()
        .filter(|gate| scope.contains(&gate.run_id))
        .collect();
    let messages: Vec<_> = messages
        .into_iter()
        .filter(|message| scope.contains(&message.run_id))
        .collect();

    let mut omitted = Map::new();
    count(&mut omitted, "runs", omitted_runs);
    let body = match &focus {
        Some(task) => task_detail(task, &attempts, &gates, &messages, limit, &mut omitted),
        None => compact(&tasks, &attempts, &gates, &messages, limit, &mut omitted),
    };
    let mut out = body;
    out.insert(
        "nativeDecisions".into(),
        to_json(
            &native_decisions
                .into_iter()
                .filter(|d| {
                    scope.contains(&d.run_id)
                        && focus.as_ref().is_none_or(|task| task.id == d.task_id)
                })
                .collect::<Vec<_>>(),
        ),
    );
    out.insert(
        "services".into(),
        to_json(
            &services
                .into_iter()
                .filter(|s| {
                    scope.contains(&s.run_id)
                        && focus.as_ref().is_none_or(|task| task.id == s.task_id)
                })
                .collect::<Vec<_>>(),
        ),
    );
    out.insert("lifecycleEvidence".into(), Value::String("Native decisions contain observed host cards only; no record is not proof of approval or no rejection. blockedAction is null when the provider supplied no exact arguments. Services are explicitly registered local listeners: completed tasks and historical prose never prove current readiness. Check checkedAt and application health before use.".into()));
    let pending: Vec<_> = notifications
        .iter()
        .filter(|n| scope.contains(&n.run_id) && undelivered(n))
        .collect();
    count(
        &mut omitted,
        "notifications",
        notifications.len() - pending.len(),
    );
    out.insert(
        "notifications".into(),
        Value::Array(
            pending
                .into_iter()
                .map(|n| {
                    let mut item = pick(
                        &to_json(n),
                        &["id", "runId", "targetChatKey", "kind", "state", "createdAt"],
                    );
                    item.insert("body".into(), clip(&n.body, TEXT_LIMIT));
                    Value::Object(item)
                })
                .collect(),
        ),
    );
    let workers: BTreeSet<&str> = out["attempts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|attempt| attempt["workerChatKey"].as_str())
        .collect();
    out.insert(
        "reports".into(),
        to_json(
            &reports
                .into_iter()
                .filter(|(key, _)| workers.contains(key.as_str()))
                .collect::<BTreeMap<_, _>>(),
        ),
    );
    out.insert("runs".into(), to_json(&runs));
    out.insert(
        "view".into(),
        Value::String(if focus.is_some() { "task" } else { "compact" }.into()),
    );
    if !omitted.is_empty() {
        omitted.insert("hint".into(), Value::String(HINT.into()));
        out.insert("omitted".into(), Value::Object(omitted));
    }
    Ok(Value::Object(out))
}

/// The runs this chat coordinates or works in. A chat in none of them — a
/// person asking from an ordinary chat — sees the runs still in flight.
fn actor_runs(runs: &[Run], attempts: &[Attempt], actor: &str) -> BTreeSet<String> {
    let own: BTreeSet<String> = runs
        .iter()
        .filter(|run| run.coordinator_chat_key == actor)
        .map(|run| run.id.clone())
        .chain(
            attempts
                .iter()
                .filter(|attempt| attempt.worker_chat_key == actor)
                .map(|attempt| attempt.run_id.clone()),
        )
        .collect();
    if !own.is_empty() {
        return own;
    }
    runs.iter()
        .filter(|run| {
            matches!(
                run.status,
                RunStatus::Planning | RunStatus::Running | RunStatus::Waiting
            )
        })
        .map(|run| run.id.clone())
        .collect()
}

fn compact(
    tasks: &[Task],
    attempts: &[Attempt],
    gates: &[Gate],
    messages: &[OrchestrationMessage],
    limit: usize,
    omitted: &mut Map<String, Value>,
) -> Map<String, Value> {
    let results: BTreeMap<&str, &str> = tasks
        .iter()
        .filter_map(|task| Some((task.id.as_str(), task.result.as_deref()?)))
        .collect();
    let kept: Vec<&Attempt> = attempts
        .iter()
        .filter(|attempt| {
            tasks
                .iter()
                .any(|task| task.active_attempt_id.as_deref() == Some(attempt.id.as_str()))
                || live(attempt)
        })
        .collect();
    count(omitted, "attempts", attempts.len() - kept.len());
    count(omitted, "messages", messages.len().saturating_sub(limit));

    let mut out = Map::new();
    out.insert(
        "tasks".into(),
        Value::Array(
            tasks
                .iter()
                .map(|task| {
                    let full = to_json(task);
                    // Finished work is a line in the ledger: what it was, how
                    // it ended and where it landed. Dependencies and worker
                    // settings only steer work still to come.
                    let done = matches!(task.status, TaskStatus::Completed | TaskStatus::Cancelled);
                    let keys: &[&str] = if done {
                        &[
                            "id",
                            "runId",
                            "title",
                            "status",
                            "assignee",
                            "activeAttemptId",
                        ]
                    } else {
                        &[
                            "id",
                            "runId",
                            "title",
                            "status",
                            "dependsOn",
                            "parentTaskId",
                            "activeAttemptId",
                            "worker",
                            "assignee",
                            "updatedAt",
                        ]
                    };
                    let mut item = pick(&full, keys);
                    if let Some(result) = &task.result {
                        let limit = if done { SETTLED_TEXT_LIMIT } else { TEXT_LIMIT };
                        item.insert("result".into(), clip(result, limit));
                    }
                    if let Some(workspace) = full.get("workspace").filter(|w| !w.is_null()) {
                        item.insert("workspace".into(), compact_workspace(workspace, done));
                    }
                    let tries = attempts.iter().filter(|a| a.task_id == task.id).count();
                    item.insert("attemptCount".into(), tries.into());
                    Value::Object(item)
                })
                .collect(),
        ),
    );
    out.insert(
        "attempts".into(),
        Value::Array(
            kept.into_iter()
                .map(|attempt| {
                    let mut item = if live(attempt) {
                        compact_attempt(attempt)
                    } else {
                        pick(
                            &to_json(attempt),
                            &[
                                "id",
                                "taskId",
                                "number",
                                "workerChatKey",
                                "agent",
                                "status",
                                "finishedAt",
                            ],
                        )
                    };
                    // A completed attempt's summary is its task's result, word
                    // for word; a failed or blocked one's says why.
                    if let Some(summary) = attempt.summary.as_deref() {
                        if attempt.status != AttemptStatus::Completed
                            && results.get(attempt.task_id.as_str()) != Some(&summary)
                        {
                            item.insert("summary".into(), clip(summary, TEXT_LIMIT));
                        }
                    }
                    Value::Object(item)
                })
                .collect(),
        ),
    );
    out.insert(
        "gates".into(),
        Value::Array(
            gates
                .iter()
                .map(|gate| {
                    if gate.status == GateStatus::Open {
                        return to_json(gate);
                    }
                    let mut item = pick(&to_json(gate), &["id", "taskId", "status", "updatedAt"]);
                    item.insert("question".into(), clip(&gate.question, TEXT_LIMIT / 2));
                    if let Some(resolution) = &gate.resolution {
                        item.insert("resolution".into(), clip(resolution, TEXT_LIMIT / 2));
                    }
                    Value::Object(item)
                })
                .collect(),
        ),
    );
    out.insert(
        "messages".into(),
        latest_messages(messages.iter(), limit, TEXT_LIMIT),
    );
    out
}

fn task_detail(
    task: &Task,
    attempts: &[Attempt],
    gates: &[Gate],
    messages: &[OrchestrationMessage],
    limit: usize,
    omitted: &mut Map<String, Value>,
) -> Map<String, Value> {
    let own: Vec<&Attempt> = attempts
        .iter()
        .filter(|attempt| attempt.task_id == task.id)
        .collect();
    let workers: BTreeSet<&str> = own
        .iter()
        .map(|attempt| attempt.worker_chat_key.as_str())
        .collect();
    let exchanged: Vec<_> = messages
        .iter()
        .filter(|m| {
            workers.contains(m.from_chat_key.as_str()) || workers.contains(m.to_chat_key.as_str())
        })
        .collect();
    count(omitted, "messages", exchanged.len().saturating_sub(limit));

    let mut out = Map::new();
    out.insert("tasks".into(), Value::Array(vec![to_json(task)]));
    out.insert(
        "attempts".into(),
        Value::Array(own.into_iter().map(to_json).collect()),
    );
    out.insert(
        "gates".into(),
        Value::Array(
            gates
                .iter()
                .filter(|gate| gate.task_id.as_deref() == Some(task.id.as_str()))
                .map(to_json)
                .collect(),
        ),
    );
    out.insert(
        "messages".into(),
        latest_messages(exchanged.into_iter(), limit, DETAIL_TEXT_LIMIT),
    );
    out
}

fn compact_attempt(attempt: &Attempt) -> Map<String, Value> {
    let full = to_json(attempt);
    let mut item = pick(
        &full,
        &[
            "id",
            "taskId",
            "number",
            "workerChatKey",
            "agent",
            "model",
            "effort",
            "status",
            "branch",
            "cwd",
            "isWorktree",
            "finishedAt",
            "updatedAt",
        ],
    );
    if let Some(Value::Object(execution)) = full.get("execution") {
        let live: Map<String, Value> = execution
            .iter()
            .filter(|(_, v)| !is_empty(v))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        item.insert("execution".into(), Value::Object(live));
    }
    item.insert(
        "filesModifiedCount".into(),
        attempt.files_modified.len().into(),
    );
    item
}

/// Where the work lives and whether it landed; the plan's other fields are
/// the host's bookkeeping. Finished work needs only its branch.
fn compact_workspace(workspace: &Value, done: bool) -> Value {
    let plan = &workspace["plan"];
    let keys: &[&str] = if done {
        &["branch"]
    } else {
        &["cwd", "branch", "baseBranch"]
    };
    let mut item = pick(plan, keys);
    item.extend(pick(workspace, &["state", "abandoned", "delivery"]));
    Value::Object(item)
}

fn live(attempt: &Attempt) -> bool {
    matches!(
        attempt.status,
        AttemptStatus::Preparing | AttemptStatus::Running | AttemptStatus::Blocked
    )
}

fn latest_messages<'a>(
    messages: impl DoubleEndedIterator<Item = &'a OrchestrationMessage>,
    limit: usize,
    text_limit: usize,
) -> Value {
    let mut latest: Vec<Value> = messages
        .rev()
        .take(limit)
        .map(|message| {
            let mut item = pick(
                &to_json(message),
                &[
                    "id",
                    "fromChatKey",
                    "toChatKey",
                    "kind",
                    "subject",
                    "createdAt",
                ],
            );
            item.insert("body".into(), clip(&message.body, text_limit));
            Value::Object(item)
        })
        .collect();
    latest.reverse();
    Value::Array(latest)
}

fn undelivered(notification: &inbox::Notification) -> bool {
    matches!(
        notification.state,
        inbox::DeliveryState::Pending | inbox::DeliveryState::Delivering
    )
}

/// Long text keeps its opening and says how much is missing, so an agent never
/// mistakes a clipped result for the whole of it.
fn clip(text: &str, limit: usize) -> Value {
    let total = text.chars().count();
    if total <= limit {
        return Value::String(text.to_string());
    }
    let head: String = text.chars().take(limit).collect();
    Value::String(format!(
        "{}… [clipped: {} more characters]",
        head.trim_end(),
        total - limit
    ))
}

fn pick(value: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter()
        .filter_map(|key| {
            let v = value.get(*key)?;
            (!v.is_null()).then(|| ((*key).to_string(), v.clone()))
        })
        .collect()
}

fn is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Object(map) => map.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn count(omitted: &mut Map<String, Value>, what: &str, n: usize) {
    if n > 0 {
        omitted.insert(what.into(), n.into());
    }
}

fn to_json<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn from<T: serde::de::DeserializeOwned>(value: Value) -> T {
        serde_json::from_value(value).unwrap()
    }

    fn run(id: &str, coordinator: &str, status: &str) -> Run {
        from(json!({
            "id": id, "objective": "Ship it", "coordinatorChatKey": coordinator,
            "workspaceId": "w", "rootPath": "/repo", "status": status,
            "maxConcurrent": 2, "createdAt": 1, "updatedAt": 1,
        }))
    }

    fn task(id: &str, run: &str, status: &str, active: Option<&str>, result: Option<&str>) -> Task {
        from(json!({
            "id": id, "runId": run, "title": format!("Task {id}"),
            "spec": "S".repeat(5_000), "status": status,
            "activeAttemptId": active, "result": result,
            "createdAt": 1, "updatedAt": 1,
        }))
    }

    fn attempt(
        id: &str,
        run: &str,
        task: &str,
        worker: &str,
        status: &str,
        summary: Option<&str>,
    ) -> Attempt {
        from(json!({
            "id": id, "runId": run, "taskId": task, "number": 1,
            "workerChatKey": worker, "agent": "codex", "access": "auto",
            "status": status, "summary": summary,
            "filesModified": ["/repo/a.rs", "/repo/b.rs"],
            "createdAt": 1, "updatedAt": 1,
        }))
    }

    fn message(n: usize, run: &str, sender: &str, to: &str) -> OrchestrationMessage {
        from(json!({
            "id": format!("m{n:03}"), "runId": run, "fromChatKey": sender,
            "toChatKey": to, "kind": "status", "subject": "Progress",
            "body": "B".repeat(2_000), "createdAt": n,
        }))
    }

    fn notification(id: &str, run: &str, state: &str) -> inbox::Notification {
        from(json!({
            "id": id, "runId": run, "fromChatKey": "chat:w1", "targetChatKey": "chat:master",
            "source": id, "kind": "report", "body": "Worker reported.", "state": state,
            "attempts": 0, "coalesced": 0, "createdAt": 1, "updatedAt": 1, "nextAttemptAt": 1,
        }))
    }

    /// One run with a retried task, a running task, 40 long messages, and an
    /// unrelated run the master does not coordinate.
    fn fixture() -> Snapshot {
        let mut messages: Vec<_> = (0..40)
            .map(|n| {
                message(
                    n,
                    "run_a",
                    "chat:master",
                    if n % 2 == 0 { "chat:w1" } else { "chat:w3" },
                )
            })
            .collect();
        messages.push(message(99, "run_b", "chat:other", "chat:w9"));
        Snapshot {
            runs: vec![
                run("run_a", "chat:master", "running"),
                run("run_b", "chat:other", "running"),
            ],
            tasks: vec![
                task(
                    "t1",
                    "run_a",
                    "completed",
                    Some("a2"),
                    Some("Merged the change."),
                ),
                task("t2", "run_a", "running", Some("a3"), None),
                task("t9", "run_b", "running", Some("a9"), None),
            ],
            attempts: vec![
                attempt(
                    "a1",
                    "run_a",
                    "t1",
                    "chat:w1",
                    "failed",
                    Some("Tests failed."),
                ),
                attempt(
                    "a2",
                    "run_a",
                    "t1",
                    "chat:w2",
                    "completed",
                    Some("Merged the change."),
                ),
                attempt("a3", "run_a", "t2", "chat:w3", "running", None),
                attempt("a9", "run_b", "t9", "chat:w9", "running", None),
            ],
            gates: vec![],
            messages,
            notifications: vec![
                notification("n1", "run_a", "pending"),
                notification("n2", "run_a", "acknowledged"),
            ],
            reports: BTreeMap::new(),
            native_decisions: vec![],
            services: vec![],
        }
    }

    fn read<'a>(actor: &'a str) -> AgentRead<'a> {
        AgentRead {
            actor,
            run_id: None,
            task_id: None,
            message_limit: DEFAULT_MESSAGES,
        }
    }

    fn ids(value: &Value) -> Vec<&str> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn compact_read_is_scoped_to_the_callers_run_and_leaves_out_bulk() {
        let full = serde_json::to_string(&fixture()).unwrap().len();
        let view = agent_snapshot(fixture(), &read("chat:master")).unwrap();
        assert_eq!(view["view"], "compact");
        assert_eq!(ids(&view["runs"]), ["run_a"]);
        assert_eq!(ids(&view["tasks"]), ["t1", "t2"]);
        // The superseded attempt a1 is history; the authoritative a2 and the
        // running a3 are the state.
        assert_eq!(ids(&view["attempts"]), ["a2", "a3"]);
        assert!(view["tasks"][0].get("spec").is_none());
        assert_eq!(view["tasks"][0]["attemptCount"], 2);
        assert_eq!(view["tasks"][0]["result"], "Merged the change.");
        // Finished t1 drops what only steers work to come; running t2 keeps it.
        assert!(view["tasks"][0].get("dependsOn").is_none());
        assert!(view["tasks"][1].get("dependsOn").is_some());
        // Settled a2 is a ledger line; its summary is t1's result, said once.
        assert!(view["attempts"][0].get("filesModifiedCount").is_none());
        assert!(view["attempts"][0].get("summary").is_none());
        assert_eq!(view["attempts"][1]["filesModifiedCount"], 2);
        assert!(view["attempts"][1].get("filesModified").is_none());
        // Latest messages only, oldest first, bodies clipped and marked.
        assert_eq!(view["messages"].as_array().unwrap().len(), DEFAULT_MESSAGES);
        assert_eq!(view["messages"][DEFAULT_MESSAGES - 1]["id"], "m039");
        assert!(view["messages"][0]["body"]
            .as_str()
            .unwrap()
            .contains("[clipped: 1400 more characters]"));
        assert_eq!(ids(&view["notifications"]), ["n1"]);
        assert_eq!(view["omitted"]["runs"], 1);
        assert_eq!(view["omitted"]["attempts"], 1);
        assert_eq!(view["omitted"]["messages"], 40 - DEFAULT_MESSAGES);
        assert!(view["omitted"]["hint"].as_str().unwrap().contains("taskId"));
        let compact = view.to_string().len();
        assert!(compact * 3 < full, "compact {compact} vs full {full}");
    }

    #[test]
    fn a_worker_sees_its_own_run_and_a_bystander_sees_runs_in_flight() {
        let view = agent_snapshot(fixture(), &read("chat:w9")).unwrap();
        assert_eq!(ids(&view["runs"]), ["run_b"]);
        let mut snapshot = fixture();
        snapshot.runs[1] = run("run_b", "chat:other", "stopped");
        let view = agent_snapshot(snapshot, &read("chat:ordinary")).unwrap();
        assert_eq!(ids(&view["runs"]), ["run_a"]);
    }

    #[test]
    fn a_named_run_is_read_even_when_the_caller_is_not_in_it() {
        let request = AgentRead {
            run_id: Some("run_b"),
            ..read("chat:master")
        };
        let view = agent_snapshot(fixture(), &request).unwrap();
        assert_eq!(ids(&view["runs"]), ["run_b"]);
        assert_eq!(ids(&view["tasks"]), ["t9"]);
    }

    #[test]
    fn task_read_returns_the_spec_every_attempt_and_its_workers_messages() {
        let request = AgentRead {
            task_id: Some("t1"),
            message_limit: 100,
            ..read("chat:master")
        };
        let view = agent_snapshot(fixture(), &request).unwrap();
        assert_eq!(view["view"], "task");
        assert_eq!(view["tasks"][0]["spec"].as_str().unwrap().len(), 5_000);
        assert_eq!(ids(&view["attempts"]), ["a1", "a2"]);
        assert_eq!(
            view["attempts"][0]["filesModified"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        // Only messages with t1's workers (w1, w2): the even ones, unclipped
        // at this length.
        let messages = view["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 20);
        assert!(messages.iter().all(|m| m["toChatKey"] == "chat:w1"));
        assert_eq!(messages[0]["body"].as_str().unwrap().len(), 2_000);
        assert!(agent_snapshot(
            fixture(),
            &AgentRead {
                task_id: Some("nope"),
                ..read("chat:master")
            }
        )
        .is_err());
    }

    #[test]
    fn message_limit_is_bounded() {
        let request = AgentRead {
            message_limit: 0,
            ..read("chat:master")
        };
        let view = agent_snapshot(fixture(), &request).unwrap();
        assert_eq!(ids(&view["messages"]), ["m039"]);
    }

    #[test]
    fn clipping_is_character_safe() {
        assert_eq!(clip("短い", 5), json!("短い"));
        let clipped = clip(&"界".repeat(10), 4);
        assert_eq!(clipped, json!("界界界界… [clipped: 6 more characters]"));
    }
}

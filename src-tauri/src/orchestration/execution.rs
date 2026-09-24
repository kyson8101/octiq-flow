//! Provider execution is host evidence, independent of worker task reports.
//! Terminal failures and coordinator inbox entries commit in the same write.
use super::*;
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    #[default]
    Queued,
    Executing,
    WaitingTool,
    Retrying,
    CapacityBlocked,
    Stalled,
    Disconnected,
    AwaitingReport,
    Blocked,
    Failed,
    Completed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionError {
    pub kind: String,
    pub message: String,
    pub at: i64,
    pub retryable: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Execution {
    pub state: ExecutionState,
    pub last_activity_at: Option<i64>,
    pub last_progress_at: Option<i64>,
    pub last_progress: Option<String>,
    pub current_operation: Option<String>,
    pub latest_error: Option<ExecutionError>,
    pub retry_count: u32,
    pub next_retry_at: Option<i64>,
    pub retry_model: Option<String>,
    pub stalled_at: Option<i64>,
    pub provider_retry_started_at: Option<i64>,
    /// Track concurrent tools so one result cannot hide another pending tool.
    pub pending_tools: BTreeMap<String, String>,
}

impl Execution {
    pub(super) fn queued(now: i64, retry_count: u32) -> Self {
        Self {
            state: if retry_count > 0 {
                ExecutionState::Retrying
            } else {
                ExecutionState::Queued
            },
            last_activity_at: Some(now),
            current_operation: Some("Preparing workspace".into()),
            retry_count,
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RecoveryPolicy {
    pub max_retries: u32,
    pub base_delay_ms: i64,
    pub max_delay_ms: i64,
    /// Same provider and access boundary; switching providers is a new assignment.
    pub fallback_model: Option<String>,
    pub stall_after_ms: i64,
    pub tool_stall_after_ms: i64,
}

impl Default for RecoveryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 2,
            base_delay_ms: 5_000,
            max_delay_ms: 60_000,
            fallback_model: None,
            stall_after_ms: 300_000,
            tool_stall_after_ms: 1_800_000,
        }
    }
}

impl RecoveryPolicy {
    pub(super) fn validate(&self, agent: ChatAgent) -> Result<(), String> {
        if self.max_retries > 5
            || !(1_000..=300_000).contains(&self.base_delay_ms)
            || !(self.base_delay_ms..=300_000).contains(&self.max_delay_ms)
            || !(30_000..=86_400_000).contains(&self.stall_after_ms)
            || !(self.stall_after_ms..=86_400_000).contains(&self.tool_stall_after_ms)
        {
            return Err("Recovery requires 0–5 retries, 1–300 second backoff, and 30 second–24 hour stall thresholds (tool threshold >= ordinary threshold).".into());
        }
        if let Some(model) = &self.fallback_model {
            automation::worker_model(agent, Some(model))?;
        }
        Ok(())
    }
    fn delay(&self, retry_count: u32) -> i64 {
        self.base_delay_ms
            .saturating_mul(1_i64 << retry_count.min(5))
            .min(self.max_delay_ms)
    }
}

fn policy(data: &Stored, attempt: &Attempt) -> RecoveryPolicy {
    data.tasks
        .get(&attempt.task_id)
        .and_then(|t| t.worker.as_ref())
        .and_then(|w| w.recovery.clone())
        .or_else(|| {
            data.runs
                .get(&attempt.run_id)
                .and_then(|r| r.worker_defaults.as_ref())
                .and_then(|w| w.recovery.clone())
        })
        .unwrap_or_default()
}

fn bounded(text: &str) -> String {
    text.trim().chars().take(2_000).collect()
}

fn classify(message: &str, now: i64) -> ExecutionError {
    let lower = message.to_ascii_lowercase().replace(['_', '-'], " ");
    let capacity = [
        "at capacity",
        "overloaded",
        "overload",
        "capacity exceeded",
        "insufficient capacity",
        "resource exhausted",
        "rate limit",
        "too many requests",
        "429",
        "529",
    ]
    .iter()
    .any(|s| lower.contains(s));
    let transient = [
        "503",
        "service unavailable",
        "temporarily unavailable",
        "connection reset",
        "connection closed",
        "connection refused",
        "timed out",
        "timeout",
        "stream disconnected",
    ]
    .iter()
    .any(|s| lower.contains(s));
    ExecutionError {
        kind: if capacity { "capacity" } else { "provider" }.into(),
        message: bounded(message),
        at: now,
        retryable: capacity || transient,
    }
}

enum Observation {
    Activity,
    ModelActivity,
    Executing,
    Progress(String),
    ToolStart(String, String),
    ToolEnd(String, String),
    Waiting(String),
    TurnEnded,
    Error(ExecutionError, bool), // provider is retrying internally
}

fn error_text(event: &Value) -> String {
    let text = event
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| event.get("message").and_then(Value::as_str))
        .or_else(|| event.get("result").and_then(Value::as_str));
    let content = event
        .pointer("/message/content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        });
    // Keep provider codes, including overloaded_error, when prose is generic.
    let codes = [
        event.get("error"),
        event.get("api_error_status"),
        event.get("errors"),
    ]
    .into_iter()
    .flatten()
    .filter(|v| !v.is_null())
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join(" ");
    bounded(&format!(
        "{} {codes}",
        text.or(content.as_deref())
            .or_else(|| event.get("error").and_then(Value::as_str))
            .unwrap_or("Provider request failed")
    ))
}

fn observe(event: &Value, now: i64) -> Vec<Observation> {
    let kind = event["type"].as_str().unwrap_or_default();
    if kind == "model.activity"
        || (kind == "stream_event"
            && event.pointer("/event/type").and_then(Value::as_str) == Some("content_block_delta"))
    {
        return vec![Observation::ModelActivity];
    }
    if kind == "octiq.progress" {
        return vec![Observation::Progress(bounded(
            event["summary"].as_str().unwrap_or_default(),
        ))];
    }
    if matches!(kind, "turn.failed" | "error")
        || (kind == "result"
            && (event["is_error"] == true
                || event["subtype"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("error"))))
        || (kind == "assistant" && event.get("error").is_some_and(|e| !e.is_null()))
    {
        return vec![Observation::Error(classify(&error_text(event), now), false)];
    }
    if (kind == "warning" && event["will_retry"] == true)
        || (kind == "system" && event["subtype"] == "api_retry")
    {
        return vec![Observation::Error(classify(&error_text(event), now), true)];
    }
    if matches!(kind, "turn.completed" | "result") {
        return vec![Observation::TurnEnded];
    }
    if matches!(kind, "turn.started" | "thread.started")
        || (kind == "system" && event["subtype"] == "init")
    {
        return vec![Observation::Executing];
    }
    if kind == "control_request" {
        return vec![Observation::Waiting("Waiting for tool approval".into())];
    }
    if matches!(kind, "item.started" | "item.completed") {
        let item = &event["item"];
        let item_kind = item["type"].as_str().unwrap_or_default();
        if matches!(
            item_kind,
            "command_execution"
                | "mcp_tool_call"
                | "file_change"
                | "web_search"
                | "dynamic_tool_call"
        ) {
            let id = item["id"].as_str().unwrap_or(item_kind).to_string();
            let name = item
                .get("tool")
                .and_then(Value::as_str)
                .or_else(|| item.get("command").and_then(Value::as_str))
                .unwrap_or(item_kind)
                .replace('_', " ");
            let name = bounded(&name);
            return vec![if kind == "item.started" {
                Observation::ToolStart(id, name)
            } else {
                Observation::ToolEnd(id, format!("Finished {name}"))
            }];
        }
        if kind == "item.completed" && item_kind == "agent_message" {
            return vec![Observation::Progress(bounded(
                item["text"].as_str().unwrap_or("Agent message"),
            ))];
        }
    }
    if matches!(kind, "assistant" | "user") {
        let mut out = Vec::new();
        if let Some(blocks) = event.pointer("/message/content").and_then(Value::as_array) {
            for block in blocks {
                match block["type"].as_str().unwrap_or_default() {
                    "text" if kind == "assistant" => out.push(Observation::Progress(bounded(
                        block["text"].as_str().unwrap_or_default(),
                    ))),
                    "tool_use" => out.push(Observation::ToolStart(
                        block["id"].as_str().unwrap_or("tool").into(),
                        bounded(block["name"].as_str().unwrap_or("tool")),
                    )),
                    "tool_result" => out.push(Observation::ToolEnd(
                        block["tool_use_id"].as_str().unwrap_or("tool").into(),
                        "Tool returned".into(),
                    )),
                    _ => {}
                }
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    vec![Observation::Activity]
}

pub(super) fn fail_dispatch(data: &mut Stored, id: &str, reason: &str) {
    let now = now_ms();
    fail(data, id, classify(reason, now), now);
}

pub(super) fn fail(data: &mut Stored, id: &str, error: ExecutionError, now: i64) -> bool {
    let Some(before) = data.attempts.get(id).cloned() else {
        return false;
    };
    if !attempt_is_unsettled(data, &before)
        || !data
            .tasks
            .get(&before.task_id)
            .is_some_and(|t| t.active_attempt_id.as_deref() == Some(id))
    {
        return false;
    }
    let retry_policy = policy(data, &before);
    // Decisions and unknown tool side effects need coordinator review, not a replay.
    let retry = error.retryable
        && before.execution.retry_count < retry_policy.max_retries
        && before.execution.pending_tools.is_empty()
        && !attempt_has_open_gate(data, &before);
    let target = data.runs[&before.run_id].coordinator_chat_key.clone();
    let attempt = data.attempts.get_mut(id).unwrap();
    attempt.status = AttemptStatus::Failed;
    attempt.finished_at = Some(now);
    attempt.updated_at = now;
    attempt.summary = Some(error.message.clone());
    let execution = &mut attempt.execution;
    execution.state = match error.kind.as_str() {
        "capacity" => ExecutionState::CapacityBlocked,
        "disconnected" => ExecutionState::Disconnected,
        _ => ExecutionState::Failed,
    };
    execution.last_activity_at = Some(now);
    execution.current_operation = None;
    execution.latest_error = Some(error.clone());
    execution.next_retry_at = retry.then(|| now + retry_policy.delay(execution.retry_count));
    execution.retry_model = retry
        .then(|| retry_policy.fallback_model.clone().or(before.model.clone()))
        .flatten();
    let recovery = execution.next_retry_at.map(|at| format!("Host retry {} of {} scheduled at {at} using {}. The same workspace will be reused.", execution.retry_count + 1, retry_policy.max_retries, execution.retry_model.as_deref().unwrap_or("the assigned model")))
        .unwrap_or_else(|| "No automatic retry is scheduled. Coordinator review is required; the workspace is preserved.".into());
    let task = data.tasks.get_mut(&before.task_id).unwrap();
    task.status = if retry {
        TaskStatus::Blocked
    } else {
        TaskStatus::Failed
    };
    task.result = Some(error.message.clone());
    task.updated_at = now;
    if let Some(ws) = &mut task.workspace {
        if ws.state != workspaces::WorkspaceState::Preparing {
            ws.state = workspaces::WorkspaceState::Retained;
        }
    }
    for gate in data
        .gates
        .values_mut()
        .filter(|g| g.task_id.as_deref() == Some(&before.task_id) && g.status == GateStatus::Open)
    {
        gate.status = GateStatus::Cancelled;
        gate.updated_at = now;
    }
    inbox::enqueue(data, &before.run_id, &before.worker_chat_key, &target, format!("execution-failed:{id}"), &error.kind,
        format!("Host detected {} for task {} (attempt {}).\n\n{}\n\n{}\nRead orchestration_snapshot. This attempt is failed and is not active work.", error.kind, before.task_id, id, error.message, recovery));
    recompute_run(data, &before.run_id);
    true
}

impl OrchestrationStore {
    /// App-server drops streaming deltas from the transcript, but they still
    /// prove activity. Tool output must not imply a model retry succeeded.
    pub(crate) fn observe_codex_activity(&self, key: &str, event: &Value) -> Result<(), String> {
        let method = event["method"].as_str().unwrap_or_default();
        if !method.starts_with("item/") {
            return Ok(());
        }
        if method.ends_with("/delta") {
            self.observe_worker_event(key, &json!({"type":"model.activity"}))
        } else if method.ends_with("outputDelta") || method.ends_with("/progress") {
            self.observe_worker_event(key, &json!({"type":"activity"}))
        } else {
            Ok(())
        }
    }

    /// Ignore ordinary chats without cloning or persisting the orchestration ledger.
    fn observed_attempt(&self, key: &str) -> Option<Attempt> {
        let inner = self.inner.lock().ok()?;
        inner
            .data
            .attempts
            .values()
            .find(|a| a.worker_chat_key == key && attempt_is_unsettled(&inner.data, a))
            .cloned()
    }

    pub(crate) fn observe_worker_event(&self, key: &str, event: &Value) -> Result<(), String> {
        let Some(before) = self.observed_attempt(key) else {
            return Ok(());
        };
        let now = now_ms();
        let observations = observe(event, now);
        // Streaming deltas are activity, never progress. Persist at most once a
        // second unless an operation or failure changed.
        if observations.iter().all(|o| {
            matches!(o, Observation::Activity)
                || (matches!(o, Observation::ModelActivity)
                    && before.execution.provider_retry_started_at.is_none()
                    && matches!(
                        before.execution.state,
                        ExecutionState::Executing
                            | ExecutionState::Stalled
                            | ExecutionState::WaitingTool
                    ))
        }) && before
            .execution
            .last_activity_at
            .is_some_and(|at| now - at < 1_000)
        {
            return Ok(());
        }
        let changed = self.mutate(|data| {
            let Some(current) = data.attempts.get(&before.id) else { return Ok(false); };
            if !attempt_is_unsettled(data, current) { return Ok(false); }
            for observation in observations {
                if let Observation::Error(error, false) = observation {
                    return Ok(fail(data, &before.id, error, now));
                }
                let attempt = data.attempts.get_mut(&before.id).unwrap();
                let e = &mut attempt.execution;
                e.last_activity_at = Some(now);
                match observation {
                    Observation::Error(error, true) => {
                        e.state = if error.kind == "capacity" { ExecutionState::CapacityBlocked } else { ExecutionState::Retrying };
                        e.current_operation = Some("Provider is retrying the request".into());
                        let episode = *e.provider_retry_started_at.get_or_insert(now);
                        e.latest_error = Some(error.clone());
                        let target = data.runs[&before.run_id].coordinator_chat_key.clone();
                        inbox::enqueue(data, &before.run_id, key, &target, format!("provider-retry:{}:{episode}", before.id), &error.kind,
                            format!("Provider retry for task {} (attempt {}): {}. Execution is waiting for the provider, not making progress. Read orchestration_snapshot.", before.task_id, before.id, error.message));
                        continue;
                    }
                    Observation::ToolStart(id, name) => { e.last_progress_at = Some(now); e.last_progress = Some(format!("Started {name}")); e.pending_tools.insert(id, name); }
                    Observation::ToolEnd(id, summary) => { e.pending_tools.remove(&id); e.last_progress_at = Some(now); e.last_progress = Some(summary); }
                    Observation::Progress(summary) => { e.last_progress_at = Some(now); e.last_progress = Some(summary); }
                    Observation::Waiting(operation) => { e.provider_retry_started_at = None; e.state = ExecutionState::WaitingTool; e.current_operation = Some(operation); continue; }
                    Observation::TurnEnded => {
                        e.provider_retry_started_at = None;
                        if attempt.status == AttemptStatus::Blocked { continue; }
                        if crate::safety_block::has_pending_for_chat(key) {
                            e.state = ExecutionState::WaitingTool;
                            e.current_operation = Some("Waiting for safety approval".into());
                        } else {
                            e.state = ExecutionState::AwaitingReport;
                            e.current_operation = Some("Turn ended without a worker report".into());
                        }
                        continue;
                    }
                    Observation::Activity => continue,
                    Observation::ModelActivity => {
                        e.provider_retry_started_at = None;
                        // Token streaming proves provider recovery, but does
                        // not claim meaningful progress or clear a stall.
                        if e.state == ExecutionState::Stalled { continue; }
                    }
                    Observation::Executing => {}
                    Observation::Error(_, false) => unreachable!(),
                }
                e.provider_retry_started_at = None;
                e.stalled_at = None;
                if attempt.status != AttemptStatus::Blocked {
                    e.state = if e.pending_tools.is_empty() { ExecutionState::Executing } else { ExecutionState::WaitingTool };
                    e.current_operation = Some(if e.pending_tools.is_empty() { "Requesting model response".into() } else { e.pending_tools.values().cloned().collect::<Vec<_>>().join(", ") });
                }
            }
            Ok(true)
        })?;
        if changed {
            announce(&before.run_id, "worker_execution");
        }
        Ok(())
    }

    pub(crate) fn observe_worker_output(&self, key: &str, text: &str) -> Result<(), String> {
        // Unstructured stdout/stderr is only failure evidence for explicit
        // provider messages. Tool failures and quoted assistant prose are not.
        let error = classify(text, now_ms());
        let lower = text.trim().to_ascii_lowercase();
        if error.retryable
            && (lower.starts_with("error:") || lower.starts_with("selected model is at capacity"))
            && !text.contains("tools::router")
            && !text.contains("tool_result")
        {
            self.observe_worker_event(key, &json!({"type":"error", "message": text}))?;
        }
        Ok(())
    }

    pub(crate) fn worker_disconnected(&self, key: &str) -> Result<(), String> {
        let Some(before) = self.observed_attempt(key) else {
            return Ok(());
        };
        // A one-shot provider may exit while a durable decision waits.
        if before.status == AttemptStatus::Blocked || crate::safety_block::has_pending_for_chat(key)
        {
            return Ok(());
        }
        let changed = self.mutate(|data| {
            Ok(fail(
                data,
                &before.id,
                ExecutionError {
                    kind: "disconnected".into(),
                    message: "Worker output disconnected before the attempt was reported.".into(),
                    at: now_ms(),
                    retryable: false,
                },
                now_ms(),
            ))
        })?;
        if changed {
            announce(&before.run_id, "worker_disconnected");
        }
        Ok(())
    }

    pub(super) fn monitor_workers(&self, now: i64) -> Result<(), String> {
        let snapshot = self.snapshot(None)?;
        for before in snapshot
            .attempts
            .iter()
            .filter(|a| matches!(a.status, AttemptStatus::Preparing | AttemptStatus::Running))
        {
            if crate::safety_block::has_pending_for_chat(&before.worker_chat_key) {
                continue;
            }
            let p = snapshot
                .tasks
                .iter()
                .find(|t| t.id == before.task_id)
                .and_then(|t| t.worker.as_ref())
                .and_then(|w| w.recovery.clone())
                .unwrap_or_default();
            let e = &before.execution;
            let threshold = if e.state == ExecutionState::WaitingTool || !e.pending_tools.is_empty()
            {
                p.tool_stall_after_ms
            } else {
                p.stall_after_ms
            };
            if !e
                .provider_retry_started_at
                .is_some_and(|at| now - at >= p.max_delay_ms)
                && (e.stalled_at.is_some()
                    || now - e.last_progress_at.unwrap_or(before.created_at) < threshold)
            {
                continue;
            }
            let changed = self.mutate(|data| {
                let current = &data.attempts[&before.id];
                if !matches!(current.status, AttemptStatus::Preparing | AttemptStatus::Running) { return Ok(false); }
                let p = policy(data, current);
                // Provider-owned retry loops also get a finite time budget.
                if current.execution.provider_retry_started_at.is_some_and(|at| now - at >= p.max_delay_ms) {
                    let error = current.execution.latest_error.clone().unwrap();
                    return Ok(fail(data, &before.id, error, now));
                }
                let e = &current.execution;
                let threshold = if e.state == ExecutionState::WaitingTool || !e.pending_tools.is_empty() { p.tool_stall_after_ms } else { p.stall_after_ms };
                if e.stalled_at.is_some() || now - e.last_progress_at.unwrap_or(current.created_at) < threshold { return Ok(false); }
                let attempt = data.attempts.get_mut(&before.id).unwrap();
                attempt.execution.state = ExecutionState::Stalled;
                attempt.execution.stalled_at = Some(now);
                let target = data.runs[&before.run_id].coordinator_chat_key.clone();
                inbox::enqueue(data, &before.run_id, &before.worker_chat_key, &target, format!("stalled:{}:{}", before.id, before.execution.last_activity_at.unwrap_or(0)), "stalled",
                    format!("No meaningful worker progress for task {} (attempt {}) since {}. Last operation: {}. Work may still be executing; inspect before interrupting. The host has not replayed any tool.", before.task_id, before.id, before.execution.last_progress_at.unwrap_or(before.created_at), before.execution.current_operation.as_deref().unwrap_or("unknown")));
                Ok(true)
            })?;
            if changed {
                announce(&before.run_id, "worker_stalled");
            }
        }
        Ok(())
    }

    pub(super) fn recover_due_workers(
        &self,
        chats: Arc<ChatManager>,
        workspaces: &WorkspaceState,
        now: i64,
    ) -> Result<(), String> {
        self.monitor_workers(now)?;
        let snapshot = self.snapshot(None)?;
        for attempt in snapshot
            .attempts
            .iter()
            .filter(|a| a.status == AttemptStatus::Running)
        {
            if !chats.has_process(&attempt.worker_chat_key)
                && now
                    - attempt
                        .execution
                        .last_activity_at
                        .unwrap_or(attempt.created_at)
                    > 30_000
            {
                self.worker_disconnected(&attempt.worker_chat_key)?;
            }
        }
        for attempt in snapshot
            .attempts
            .iter()
            .filter(|a| a.status == AttemptStatus::Failed && a.execution.latest_error.is_some())
        {
            // Stop any provider still alive after a terminal error before it
            // can execute further tools. Retries transfer the existing lease.
            if chats.has_process(&attempt.worker_chat_key) {
                crate::agent_chat::chat_stop_impl(&chats, attempt.worker_chat_key.clone())?;
            }
            let Some(run) = snapshot
                .runs
                .iter()
                .find(|r| r.id == attempt.run_id && r.status != RunStatus::Stopped)
            else {
                continue;
            };
            if !attempt.execution.next_retry_at.is_some_and(|at| at <= now)
                || !snapshot
                    .tasks
                    .iter()
                    .any(|t| t.active_attempt_id.as_deref() == Some(&attempt.id))
            {
                continue;
            }
            if snapshot
                .gates
                .iter()
                .any(|g| g.run_id == run.id && g.task_id.is_none() && g.status == GateStatus::Open)
                || snapshot
                    .attempts
                    .iter()
                    .filter(|a| {
                        a.run_id == run.id
                            && (matches!(
                                a.status,
                                AttemptStatus::Preparing | AttemptStatus::Running
                            ) || (a.status == AttemptStatus::Blocked
                                && snapshot.gates.iter().any(|g| {
                                    g.task_id.as_deref() == Some(&a.task_id)
                                        && g.status == GateStatus::Open
                                })))
                    })
                    .count()
                    >= usize::from(run.max_concurrent)
            {
                continue;
            }
            let launch = WorkerLaunch {
                task_id: attempt.task_id.clone(),
                agent: attempt.agent,
                model: attempt
                    .execution
                    .retry_model
                    .clone()
                    .or(attempt.model.clone()),
                effort: attempt.effort.clone(),
                access: attempt.access,
                new_worktree: Some(false),
                base_branch: String::new(),
            };
            if let Err(error) = self.start_worker_for(
                chats.clone(),
                workspaces,
                &run.coordinator_chat_key,
                launch,
                Some(&attempt.id),
            ) {
                // A vanished project or invalid settings can fail before a
                // new reservation exists. Do not retry that forever either.
                self.mutate(|data| {
                    if !data.tasks.get(&attempt.task_id).is_some_and(|t| t.active_attempt_id.as_deref() == Some(&attempt.id)) { return Ok(()); }
                    let current = data.attempts.get_mut(&attempt.id).unwrap();
                    if current.execution.next_retry_at.take().is_none() { return Ok(()); }
                    current.execution.current_operation = Some(format!("Recovery stopped: {}", bounded(&error)));
                    let task = data.tasks.get_mut(&attempt.task_id).unwrap();
                    task.status = TaskStatus::Failed;
                    inbox::enqueue(data, &run.id, &attempt.worker_chat_key, &run.coordinator_chat_key, format!("recovery-failed:{}", attempt.id), "provider", format!("Automatic recovery for task {} could not start: {}. The workspace is preserved. Inspect orchestration_snapshot before retrying.", attempt.task_id, bounded(&error)));
                    recompute_run(data, &run.id);
                    Ok(())
                })?;
                announce(&run.id, "recovery_failed");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{run, running_worker};
    use super::*;

    fn latest(store: &OrchestrationStore, id: &str) -> Attempt {
        store
            .snapshot(None)
            .unwrap()
            .attempts
            .into_iter()
            .find(|a| a.id == id)
            .unwrap()
    }
    fn capacity(store: &OrchestrationStore, attempt: &Attempt) {
        store
            .observe_worker_event(
                &attempt.worker_chat_key,
                &json!({"type":"turn.failed", "error":{"message":"Selected model is at capacity"}}),
            )
            .unwrap();
    }
    fn launch(attempt: &Attempt) -> WorkerLaunch {
        WorkerLaunch {
            task_id: attempt.task_id.clone(),
            agent: attempt.agent,
            model: attempt
                .execution
                .retry_model
                .clone()
                .or(attempt.model.clone()),
            effort: attempt.effort.clone(),
            access: attempt.access,
            new_worktree: Some(false),
            base_branch: String::new(),
        }
    }
    fn make_due(store: &OrchestrationStore, id: &str) {
        store
            .mutate(|data| {
                data.attempts.get_mut(id).unwrap().execution.next_retry_at = Some(now_ms() - 1);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn capacity_during_dispatch_reaches_ui_and_coordinator_without_a_model_response() {
        let root = std::env::temp_dir().join(format!("octiq-capacity-{}", compact_id()));
        let path = root.join("orchestrations.json");
        let store = OrchestrationStore::load(path.clone());
        let run = run(&store);
        let attempt = running_worker(&store, &run);
        let mut browser = crate::bus::events().subscribe();
        // Inject the provider dispatch result at the same boundary used by
        // chat_start; there is no worker report or successful model response.
        let result = store.finish_dispatch(&attempt, Err("Selected model is at capacity".into()));
        assert!(result.is_err());
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert_eq!(snapshot.attempts[0].status, AttemptStatus::Failed);
        assert_eq!(
            snapshot.attempts[0].execution.state,
            ExecutionState::CapacityBlocked
        );
        assert_ne!(snapshot.tasks[0].status, TaskStatus::Running);
        assert_eq!(snapshot.runs[0].status, RunStatus::Waiting);
        let error = snapshot.attempts[0]
            .execution
            .latest_error
            .as_ref()
            .unwrap();
        assert_eq!(error.message, "Selected model is at capacity");
        assert!(snapshot.attempts[0].execution.next_retry_at.unwrap() >= error.at + 5_000);
        let note = &snapshot.notifications[0];
        assert_eq!(note.target_chat_key, "chat:master");
        assert_eq!(note.kind, "capacity");
        assert_eq!(note.state, inbox::DeliveryState::Pending);
        assert!(store
            .due_notifications(now_ms())
            .unwrap()
            .iter()
            .any(|n| n.id == note.id));
        let mut notified = false;
        while let Ok(frame) = browser.try_recv() {
            let frame: Value = serde_json::from_str(&frame).unwrap();
            notified |=
                frame["event"] == "orchestration-changed" && frame["payload"]["runId"] == run.id;
        }
        assert!(notified, "browser must refresh its snapshot immediately");
        let reloaded = OrchestrationStore::load(path).snapshot(None).unwrap();
        assert_eq!(
            reloaded.attempts[0].execution.state,
            ExecutionState::CapacityBlocked
        );
        assert_eq!(reloaded.notifications[0].id, note.id);
        assert_eq!(reloaded.attempts[0].cwd, attempt.cwd);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn both_provider_error_streams_settle_once_and_late_reports_cannot_overwrite_them() {
        for event in [
            json!({"type":"result","is_error":true,"result":"Selected model is at capacity"}),
            json!({"type":"assistant","error":"overloaded_error","message":{"content":[{"type":"text","text":"Selected model is at capacity"}]}}),
            crate::codex_app_server::normalize_notification(&json!({"method":"error", "params":{"willRetry":false,"error":{"message":"Selected model is at capacity"}}})).unwrap(),
        ] {
            let store = OrchestrationStore::default();
            let run = run(&store);
            let attempt = running_worker(&store, &run);
            store.observe_worker_event(&attempt.worker_chat_key, &event).unwrap();
            capacity(&store, &attempt);
            store.worker_disconnected(&attempt.worker_chat_key).unwrap();
            assert_eq!(latest(&store, &attempt.id).execution.state, ExecutionState::CapacityBlocked);
            assert_eq!(store.snapshot(None).unwrap().notifications.len(), 1);
            assert!(store.report_worker(&attempt.worker_chat_key, WorkerReport { attempt_id: attempt.id, outcome: WorkerOutcome::Completed, summary:"Late completion".into(), files_modified:vec![] }).is_err());
        }
    }

    #[test]
    fn recovery_is_bounded_uses_fallback_and_fences_superseded_attempts() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let mut attempt = running_worker(&store, &run);
        store
            .mutate(|data| {
                data.tasks
                    .get_mut(&attempt.task_id)
                    .unwrap()
                    .worker
                    .as_mut()
                    .unwrap()
                    .recovery = Some(RecoveryPolicy {
                    fallback_model: Some("gpt-5.6-terra".into()),
                    ..RecoveryPolicy::default()
                });
                Ok(())
            })
            .unwrap();
        for count in 0..=2 {
            capacity(&store, &attempt);
            let failed = latest(&store, &attempt.id);
            assert_eq!(failed.execution.retry_count, count);
            if count == 2 {
                assert!(failed.execution.next_retry_at.is_none());
                assert_eq!(
                    store.snapshot(None).unwrap().tasks[0].status,
                    TaskStatus::Failed
                );
                break;
            }
            assert_eq!(
                failed.execution.retry_model.as_deref(),
                Some("gpt-5.6-terra")
            );
            assert_eq!(
                failed.execution.next_retry_at.unwrap()
                    - failed.execution.latest_error.as_ref().unwrap().at,
                5_000 << count
            );
            assert!(
                store
                    .reserve_attempt_for("chat:master", &launch(&failed), Some(&failed.id))
                    .is_err(),
                "backoff is enforced under the reservation lock"
            );
            make_due(&store, &failed.id);
            let (_, _, reserved, previous) = store
                .reserve_attempt_for("chat:master", &launch(&failed), Some(&failed.id))
                .unwrap();
            assert_eq!(reserved.model.as_deref(), Some("gpt-5.6-terra"));
            assert_eq!(reserved.access, failed.access);
            assert_eq!(previous.unwrap().cwd, failed.cwd);
            assert!(store
                .reserve_attempt_for("chat:master", &launch(&failed), Some(&failed.id))
                .is_err());
            attempt = store
                .activate_attempt(
                    &reserved.id,
                    failed.cwd.clone(),
                    failed.branch.clone(),
                    failed.is_worktree,
                )
                .unwrap();
            capacity(&store, &failed); // old reader cannot fail its replacement
            assert_eq!(latest(&store, &attempt.id).status, AttemptStatus::Running);
        }
        assert_eq!(store.snapshot(None).unwrap().attempts.len(), 3);
    }

    #[test]
    fn tool_waits_are_not_provider_failures_and_pending_tools_are_not_replayed() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let attempt = running_worker(&store, &run);
        for id in ["one", "two"] {
            store
                .observe_worker_event(
                    &attempt.worker_chat_key,
                    &json!({"type":"item.started","item":{"id":id,"type":"command_execution"}}),
                )
                .unwrap();
        }
        store.observe_worker_event(&attempt.worker_chat_key, &json!({"type":"item.completed","item":{"id":"one","type":"command_execution","status":"failed","aggregated_output":"Selected model is at capacity"}})).unwrap();
        let current = latest(&store, &attempt.id);
        assert_eq!(current.execution.state, ExecutionState::WaitingTool);
        assert!(current.execution.last_progress_at.is_some());
        store.monitor_workers(now_ms() + 300_001).unwrap();
        assert!(store.snapshot(None).unwrap().notifications.is_empty());
        capacity(&store, &attempt);
        assert!(latest(&store, &attempt.id)
            .execution
            .next_retry_at
            .is_none());
    }

    #[test]
    fn stalled_attempts_notify_once_and_progress_clears_the_stall() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let attempt = running_worker(&store, &run);
        let later = now_ms() + 300_001;
        store.monitor_workers(later).unwrap();
        store.monitor_workers(later + 1).unwrap();
        assert_eq!(
            latest(&store, &attempt.id).execution.state,
            ExecutionState::Stalled
        );
        assert_eq!(store.snapshot(None).unwrap().notifications.len(), 1);
        store.observe_worker_event(&attempt.worker_chat_key, &json!({"type":"item.completed", "item":{"type":"agent_message","text":"Implementation finished; checking the result"}})).unwrap();
        let active = latest(&store, &attempt.id);
        assert_eq!(active.execution.state, ExecutionState::Executing);
        assert!(active
            .execution
            .last_progress
            .unwrap()
            .contains("Implementation finished"));
    }

    #[test]
    fn native_provider_retries_are_visible_and_cannot_wait_forever() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let attempt = running_worker(&store, &run);
        let event = crate::codex_app_server::normalize_notification(&json!({"method":"error", "params":{"willRetry":true,"error":{"message":"Selected model is at capacity"}}})).unwrap();
        store
            .observe_worker_event(&attempt.worker_chat_key, &event)
            .unwrap();
        let current = latest(&store, &attempt.id);
        assert_eq!(current.status, AttemptStatus::Running);
        assert_eq!(current.execution.state, ExecutionState::CapacityBlocked);
        assert_eq!(store.snapshot(None).unwrap().notifications.len(), 1);
        store.monitor_workers(now_ms() + 60_001).unwrap();
        assert_eq!(latest(&store, &attempt.id).status, AttemptStatus::Failed);
    }

    #[test]
    fn streaming_after_a_provider_retry_clears_its_deadline_but_retains_error_evidence() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let attempt = running_worker(&store, &run);
        store.observe_worker_event(&attempt.worker_chat_key, &json!({"type":"warning", "will_retry":true, "message":"Selected model is at capacity"})).unwrap();
        store
            .observe_worker_event(&attempt.worker_chat_key, &json!({"type":"model.activity"}))
            .unwrap();
        store.monitor_workers(now_ms() + 60_001).unwrap();
        let current = latest(&store, &attempt.id);
        assert_eq!(current.status, AttemptStatus::Running);
        assert_eq!(current.execution.state, ExecutionState::Executing);
        assert!(current.execution.provider_retry_started_at.is_none());
        assert!(current.execution.last_progress_at.is_none());
        assert_eq!(current.execution.latest_error.unwrap().kind, "capacity");
    }

    #[test]
    fn tool_output_is_activity_without_claiming_progress_or_model_recovery() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let attempt = running_worker(&store, &run);
        store.observe_worker_event(&attempt.worker_chat_key, &json!({"type":"warning", "will_retry":true, "message":"Selected model is at capacity"})).unwrap();
        store
            .mutate(|data| {
                data.attempts
                    .get_mut(&attempt.id)
                    .unwrap()
                    .execution
                    .last_activity_at = Some(1);
                Ok(())
            })
            .unwrap();
        store.observe_codex_activity(&attempt.worker_chat_key, &json!({"method":"item/commandExecution/outputDelta", "params":{"delta":"compiling"}})).unwrap();
        let current = latest(&store, &attempt.id);
        assert!(current.execution.last_activity_at.unwrap() > 1);
        assert!(current.execution.last_progress_at.is_none());
        assert!(current.execution.provider_retry_started_at.is_some());
        assert_eq!(current.execution.state, ExecutionState::CapacityBlocked);
    }

    #[test]
    fn disconnects_notify_but_completed_workers_and_stopped_runs_do_not_restart() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let attempt = running_worker(&store, &run);
        store.worker_disconnected(&attempt.worker_chat_key).unwrap();
        assert_eq!(
            latest(&store, &attempt.id).execution.state,
            ExecutionState::Disconnected
        );
        assert_eq!(
            store.snapshot(None).unwrap().notifications[0].kind,
            "disconnected"
        );
        assert!(latest(&store, &attempt.id)
            .execution
            .next_retry_at
            .is_none());
        let other = running_worker(&store, &run);
        capacity(&store, &other);
        store
            .stop_run("chat:master", run.id, "Stop".into())
            .unwrap();
        assert!(latest(&store, &other.id).execution.next_retry_at.is_none());
        assert!(store
            .snapshot(None)
            .unwrap()
            .notifications
            .iter()
            .all(|n| n.state == inbox::DeliveryState::Cancelled));
    }

    #[test]
    fn quoted_capacity_and_router_diagnostics_are_not_provider_failures() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let attempt = running_worker(&store, &run);
        store
            .observe_worker_output(
                &attempt.worker_chat_key,
                "ERROR tools::router: timeout in tool_result",
            )
            .unwrap();
        store.observe_worker_event(&attempt.worker_chat_key, &json!({"type":"assistant", "message":{"content":[{"type":"text","text":"The test simulates Selected model is at capacity"}]}})).unwrap();
        assert_eq!(latest(&store, &attempt.id).status, AttemptStatus::Running);
        assert!(store.snapshot(None).unwrap().notifications.is_empty());
        store
            .observe_worker_output(&attempt.worker_chat_key, "Selected model is at capacity")
            .unwrap();
        assert_eq!(
            latest(&store, &attempt.id).execution.state,
            ExecutionState::CapacityBlocked
        );
    }

    #[test]
    fn recovery_configuration_is_bounded_and_cannot_choose_coordinator_models() {
        for policy in [
            RecoveryPolicy {
                max_retries: 6,
                ..RecoveryPolicy::default()
            },
            RecoveryPolicy {
                base_delay_ms: 0,
                ..RecoveryPolicy::default()
            },
            RecoveryPolicy {
                fallback_model: Some("gpt-6-astra".into()),
                ..RecoveryPolicy::default()
            },
        ] {
            assert!(policy.validate(ChatAgent::Codex).is_err());
        }
        assert!(RecoveryPolicy {
            max_retries: 0,
            ..RecoveryPolicy::default()
        }
        .validate(ChatAgent::Claude)
        .is_ok());
    }
}

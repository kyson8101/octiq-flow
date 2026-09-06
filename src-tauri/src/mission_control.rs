//! Durable operational state for the OctiqOS portal.
//!
//! OctiqFlow owns the authenticated browser socket and agent processes. This
//! module adds the other half of a reliable control plane: tasks, approvals,
//! agent-run visibility, and an append-only operating signal. It deliberately
//! does not start an agent by itself; a future dispatch command must enforce
//! confirmed-plan and approval gates before it calls the chat runtime.

use std::env;
use std::sync::Arc;

use postgres::{Client, NoTls, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::agent_chat::{Access, ChatAgent, ChatManager};
use crate::workspaces::{list_workspaces_impl, WorkspaceState};

const TASK_LIMIT: i64 = 12;
const PLAN_LIMIT: i64 = 6;
const APPROVAL_LIMIT: i64 = 8;
const RUN_LIMIT: i64 = 8;
const EVENT_LIMIT: i64 = 10;
const REVIEW_TASK_LIMIT: i64 = 5;
const REVIEW_EVENT_LIMIT: i64 = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MissionTask {
    id: String,
    title: String,
    detail: Option<String>,
    domain: String,
    stage: String,
    priority: String,
    risk: String,
    next_step: String,
    workspace_path: Option<String>,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MissionPlan {
    id: String,
    task_id: String,
    task_title: String,
    status: String,
    planner_provider: String,
    planner_model: String,
    content: Option<String>,
    requested_at: String,
    completed_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Approval {
    id: String,
    task_id: String,
    title: String,
    rationale: String,
    decision: String,
    requested_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRun {
    id: String,
    task_id: String,
    task_title: String,
    provider: String,
    model: String,
    status: String,
    current_step: String,
    waiting_for_founder: bool,
    started_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MissionEvent {
    id: String,
    task_id: Option<String>,
    kind: String,
    message: String,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MissionSummary {
    awaiting_decision: i64,
    active_work: i64,
    verifying: i64,
    completed_today: i64,
}

#[derive(Serialize)]
struct MissionDashboard {
    tasks: Vec<MissionTask>,
    profiles: Vec<WorkflowProfile>,
    plans: Vec<MissionPlan>,
    approvals: Vec<Approval>,
    runs: Vec<AgentRun>,
    events: Vec<MissionEvent>,
    summary: MissionSummary,
}

/// The founder's on-open report. It stays a live projection of the durable
/// ledger instead of a stale notification: every browser refresh answers what
/// needs a response now, what agents are doing, and what changed this week.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FounderReview {
    generated_at: String,
    needs_response: Vec<Approval>,
    blocked: Vec<MissionTask>,
    verifying: Vec<MissionTask>,
    active: Vec<MissionTask>,
    completed_today: Vec<MissionTask>,
    week: WeeklyReview,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WeeklyReview {
    completed: i64,
    decisions: i64,
    stopped: i64,
    signals: Vec<MissionEvent>,
}

/// The only data a connector may persist. It is deliberately normalized rather
/// than a raw provider payload, so an email, ticket, or calendar adapter cannot
/// turn OctiqOS into an accidental archive of every external system.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorIntakeResult {
    status: &'static str,
    task_id: String,
}

/// A profile is the policy envelope around one domain. It deliberately keeps
/// the shared task/run/event kernel intact: profiles choose permitted inputs
/// and runners, they do not create three independent orchestration systems.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowProfile {
    id: String,
    slug: String,
    domain: String,
    label: String,
    intake_sources: Vec<String>,
    confirmation: String,
    planner_mode: String,
    approval_requirements: Vec<String>,
    allowed_runners: Vec<String>,
    evidence_required: bool,
    financial_mode: Option<String>,
    is_enabled: bool,
    default_workspace_id: Option<String>,
    default_workspace_name: Option<String>,
    default_workspace_path: Option<String>,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileUpdateInput {
    label: String,
    is_enabled: bool,
    intake_sources: Vec<String>,
    confirmation: String,
    planner_mode: String,
    approval_requirements: Vec<String>,
    allowed_runners: Vec<String>,
    #[serde(default)]
    default_workspace_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskMessage {
    id: String,
    actor: String,
    kind: String,
    body: String,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskCycle {
    id: String,
    cycle_number: i32,
    instruction: Option<String>,
    status: String,
    opened_at: String,
    closed_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskDetail {
    task: MissionTask,
    plans: Vec<MissionPlan>,
    approvals: Vec<Approval>,
    runs: Vec<AgentRun>,
    events: Vec<MissionEvent>,
    cycles: Vec<TaskCycle>,
    messages: Vec<TaskMessage>,
}

/// Open a short-lived client per dispatcher request. The web command path is
/// already `spawn_blocking`, so no database call can park Axum's async workers.
/// A fresh client also lets a restarted local PostgreSQL server recover on the
/// next action rather than leaving a global pool poisoned.
fn connect() -> Result<Client, String> {
    let url = env::var("DATABASE_URL").map_err(|_| {
        "OctiqOS needs DATABASE_URL before its operational store can be opened.".to_string()
    })?;
    Client::connect(&url, NoTls).map_err(|_| {
        "OctiqOS could not reach PostgreSQL. Check DATABASE_URL and the local database service."
            .to_string()
    })
}

fn query_error(action: &str) -> String {
    format!("OctiqOS could not {action}. Check that the octiqos schema is migrated.")
}

fn dashboard(client: &mut Client) -> Result<MissionDashboard, String> {
    let tasks = client
        .query(
            "SELECT id::text, title, detail, domain, stage, priority, risk, next_step, workspace_path, updated_at::text \
             FROM octiqos.tasks \
             ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, updated_at DESC \
             LIMIT $1",
            &[&TASK_LIMIT],
        )
        .map_err(|_| query_error("read the task ledger"))?
        .iter()
        .map(task_from_row)
        .collect();

    let profiles = client
        .query(
            "SELECT id::text, slug, domain, label, intake_policy::text, planner_policy::text, \
                    approval_policy::text, execution_policy::text, is_enabled, \
                    default_workspace_id, default_workspace_name, default_workspace_path, updated_at::text \
             FROM octiqos.workflow_profiles ORDER BY domain",
            &[],
        )
        .map_err(|_| query_error("read workflow profiles"))?
        .iter()
        .map(profile_from_row)
        .collect();

    let plans = client
        .query(
            "SELECT plans.id::text, plans.task_id::text, tasks.title, plans.status, \
                    plans.planner_provider, plans.planner_model, plans.content, \
                    plans.requested_at::text, plans.completed_at::text \
             FROM octiqos.plans AS plans \
             JOIN octiqos.tasks AS tasks ON tasks.id = plans.task_id \
             WHERE plans.status IN ('drafting', 'awaiting_confirmation') \
             ORDER BY plans.requested_at DESC \
             LIMIT $1",
            &[&PLAN_LIMIT],
        )
        .map_err(|_| query_error("read PM plans"))?
        .iter()
        .map(plan_from_row)
        .collect();

    let approvals = client
        .query(
            "SELECT id::text, task_id::text, subject, rationale, decision, requested_at::text \
             FROM octiqos.approvals \
             WHERE decision = 'pending' \
             ORDER BY requested_at ASC \
             LIMIT $1",
            &[&APPROVAL_LIMIT],
        )
        .map_err(|_| query_error("read the approval queue"))?
        .iter()
        .map(approval_from_row)
        .collect();

    let runs = client
        .query(
            "SELECT runs.id::text, runs.task_id::text, tasks.title, runs.provider, runs.model, \
                    runs.status, runs.current_step, runs.waiting_for_founder, runs.started_at::text \
             FROM octiqos.agent_runs AS runs \
             JOIN octiqos.tasks AS tasks ON tasks.id = runs.task_id \
             WHERE runs.status IN ('queued', 'running', 'verifying', 'blocked') \
             ORDER BY runs.started_at DESC \
             LIMIT $1",
            &[&RUN_LIMIT],
        )
        .map_err(|_| query_error("read agent runs"))?
        .iter()
        .map(run_from_row)
        .collect();

    let events = client
        .query(
            "SELECT id::text, task_id::text, kind, message, created_at::text \
             FROM octiqos.mission_events \
             ORDER BY created_at DESC \
             LIMIT $1",
            &[&EVENT_LIMIT],
        )
        .map_err(|_| query_error("read recent operating signals"))?
        .iter()
        .map(event_from_row)
        .collect();

    let summary = client
        .query_one(
            "SELECT \
                (SELECT COUNT(*) FROM octiqos.approvals WHERE decision = 'pending') AS awaiting_decision, \
                (SELECT COUNT(*) FROM octiqos.tasks WHERE stage IN ('triage', 'approved', 'running')) AS active_work, \
                (SELECT COUNT(*) FROM octiqos.agent_runs WHERE status = 'verifying') AS verifying, \
                (SELECT COUNT(*) FROM octiqos.tasks WHERE stage = 'done' AND updated_at >= date_trunc('day', now())) AS completed_today",
            &[],
        )
        .map_err(|_| query_error("read the operating summary"))?;

    Ok(MissionDashboard {
        tasks,
        profiles,
        plans,
        approvals,
        runs,
        events,
        summary: MissionSummary {
            awaiting_decision: summary.get("awaiting_decision"),
            active_work: summary.get("active_work"),
            verifying: summary.get("verifying"),
            completed_today: summary.get("completed_today"),
        },
    })
}

fn review_tasks(client: &mut Client, stages: &[&str]) -> Result<Vec<MissionTask>, String> {
    let rows = client
        .query(
            "SELECT id::text, title, detail, domain, stage, priority, risk, next_step, workspace_path, updated_at::text \
             FROM octiqos.tasks \
             WHERE stage = ANY($1::text[]) \
             ORDER BY updated_at DESC LIMIT $2",
            &[&stages, &REVIEW_TASK_LIMIT],
        )
        .map_err(|_| query_error("read the founder briefing"))?;
    Ok(rows.iter().map(task_from_row).collect())
}

pub fn founder_review_impl() -> Result<Value, String> {
    let mut client = connect()?;
    let generated_at: String = client
        .query_one("SELECT now()::text", &[])
        .map_err(|_| query_error("timestamp the founder briefing"))?
        .get(0);
    let needs_response = client
        .query(
            "SELECT id::text, task_id::text, subject, rationale, decision, requested_at::text \
             FROM octiqos.approvals WHERE decision = 'pending' \
             ORDER BY requested_at ASC LIMIT $1",
            &[&APPROVAL_LIMIT],
        )
        .map_err(|_| query_error("read founder decisions"))?
        .iter()
        .map(approval_from_row)
        .collect();
    let blocked = review_tasks(&mut client, &["blocked"])?;
    let verifying = review_tasks(&mut client, &["verifying"])?;
    let active = review_tasks(&mut client, &["triage", "approved", "running"])?;
    let completed_today = client
        .query(
            "SELECT id::text, title, detail, domain, stage, priority, risk, next_step, workspace_path, updated_at::text \
             FROM octiqos.tasks \
             WHERE stage = 'done' AND updated_at >= date_trunc('day', now()) \
             ORDER BY updated_at DESC LIMIT $1",
            &[&REVIEW_TASK_LIMIT],
        )
        .map_err(|_| query_error("read today's completed work"))?
        .iter()
        .map(task_from_row)
        .collect();
    let week_counts = client
        .query_one(
            "SELECT \
                (SELECT COUNT(*) FROM octiqos.tasks \
                 WHERE stage = 'done' AND updated_at >= now() - interval '7 days') AS completed, \
                (SELECT COUNT(*) FROM octiqos.approvals \
                 WHERE decision <> 'pending' AND decided_at >= now() - interval '7 days') AS decisions, \
                (SELECT COUNT(*) FROM octiqos.mission_events \
                 WHERE kind IN ('task_abandoned', 'runner_blocked') \
                   AND created_at >= now() - interval '7 days') AS stopped",
            &[],
        )
        .map_err(|_| query_error("read the weekly review"))?;
    let signals = client
        .query(
            "SELECT id::text, task_id::text, kind, message, created_at::text \
             FROM octiqos.mission_events \
             WHERE created_at >= now() - interval '7 days' \
             ORDER BY created_at DESC LIMIT $1",
            &[&REVIEW_EVENT_LIMIT],
        )
        .map_err(|_| query_error("read weekly operating signals"))?
        .iter()
        .map(event_from_row)
        .collect();
    serde_json::to_value(FounderReview {
        generated_at,
        needs_response,
        blocked,
        verifying,
        active,
        completed_today,
        week: WeeklyReview {
            completed: week_counts.get("completed"),
            decisions: week_counts.get("decisions"),
            stopped: week_counts.get("stopped"),
            signals,
        },
    })
    .map_err(|_| "OctiqOS could not encode the founder briefing.".to_string())
}

fn task_from_row(row: &Row) -> MissionTask {
    MissionTask {
        id: row.get("id"),
        title: row.get("title"),
        detail: row.get("detail"),
        domain: row.get("domain"),
        stage: row.get("stage"),
        priority: row.get("priority"),
        risk: row.get("risk"),
        next_step: row.get("next_step"),
        workspace_path: row.get("workspace_path"),
        updated_at: row.get("updated_at"),
    }
}

fn policy_value(row: &Row, column: &str) -> Value {
    row.get::<_, String>(column)
        .parse::<Value>()
        .unwrap_or_else(|_| json!({}))
}

fn policy_list(policy: &Value, key: &str) -> Vec<String> {
    policy
        .get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn policy_string(policy: &Value, key: &str) -> Option<String> {
    policy
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn profile_from_row(row: &Row) -> WorkflowProfile {
    let intake = policy_value(row, "intake_policy");
    let planner = policy_value(row, "planner_policy");
    let approval = policy_value(row, "approval_policy");
    let execution = policy_value(row, "execution_policy");
    WorkflowProfile {
        id: row.get("id"),
        slug: row.get("slug"),
        domain: row.get("domain"),
        label: row.get("label"),
        intake_sources: policy_list(&intake, "sources"),
        confirmation: policy_string(&intake, "confirmation").unwrap_or_else(|| "plan".into()),
        planner_mode: policy_string(&planner, "mode").unwrap_or_else(|| "read-only".into()),
        approval_requirements: policy_list(&approval, "requiredFor"),
        allowed_runners: policy_list(&execution, "runners"),
        // V0 does not let any profile bypass founder verification. Returning
        // true protects an older seed/profile from making the UI imply it can.
        evidence_required: true,
        financial_mode: policy_string(&execution, "financialMode"),
        is_enabled: row.get("is_enabled"),
        default_workspace_id: row.get("default_workspace_id"),
        default_workspace_name: row.get("default_workspace_name"),
        default_workspace_path: row.get("default_workspace_path"),
        updated_at: row.get("updated_at"),
    }
}

fn plan_from_row(row: &Row) -> MissionPlan {
    MissionPlan {
        id: row.get("id"),
        task_id: row.get("task_id"),
        task_title: row.get("title"),
        status: row.get("status"),
        planner_provider: row.get("planner_provider"),
        planner_model: row.get("planner_model"),
        content: row.get("content"),
        requested_at: row.get("requested_at"),
        completed_at: row.get("completed_at"),
    }
}

fn approval_from_row(row: &Row) -> Approval {
    Approval {
        id: row.get("id"),
        task_id: row.get("task_id"),
        title: row.get("subject"),
        rationale: row.get("rationale"),
        decision: row.get("decision"),
        requested_at: row.get("requested_at"),
    }
}

fn run_from_row(row: &Row) -> AgentRun {
    AgentRun {
        id: row.get("id"),
        task_id: row.get("task_id"),
        task_title: row.get("title"),
        provider: row.get("provider"),
        model: row.get("model"),
        status: row.get("status"),
        current_step: row.get("current_step"),
        waiting_for_founder: row.get("waiting_for_founder"),
        started_at: row.get("started_at"),
    }
}

fn event_from_row(row: &Row) -> MissionEvent {
    MissionEvent {
        id: row.get("id"),
        task_id: row.get("task_id"),
        kind: row.get("kind"),
        message: row.get("message"),
        created_at: row.get("created_at"),
    }
}

fn cycle_from_row(row: &Row) -> TaskCycle {
    TaskCycle {
        id: row.get("id"),
        cycle_number: row.get("cycle_number"),
        instruction: row.get("instruction"),
        status: row.get("status"),
        opened_at: row.get("opened_at"),
        closed_at: row.get("closed_at"),
    }
}

fn task_message_from_row(row: &Row) -> TaskMessage {
    TaskMessage {
        id: row.get("id"),
        actor: row.get("actor"),
        kind: row.get("kind"),
        body: row.get("body"),
        created_at: row.get("created_at"),
    }
}

fn dashboard_value(client: &mut Client) -> Result<Value, String> {
    serde_json::to_value(dashboard(client)?)
        .map_err(|_| "OctiqOS could not encode its dashboard.".to_string())
}

pub fn task_detail_impl(task_id: String) -> Result<Value, String> {
    required_uuid(&task_id, "Task")?;
    let mut client = connect()?;
    let task = client
        .query_opt(
            "SELECT id::text, title, detail, domain, stage, priority, risk, next_step, workspace_path, updated_at::text \
             FROM octiqos.tasks WHERE id = $1::text::uuid",
            &[&task_id],
        )
        .map_err(|_| query_error("read the task detail"))?
        .ok_or_else(|| "That task no longer exists.".to_string())?;
    let plans = client
        .query(
            "SELECT plans.id::text, plans.task_id::text, tasks.title, plans.status, \
                    plans.planner_provider, plans.planner_model, plans.content, \
                    plans.requested_at::text, plans.completed_at::text \
             FROM octiqos.plans AS plans \
             JOIN octiqos.tasks AS tasks ON tasks.id = plans.task_id \
             WHERE plans.task_id = $1::text::uuid \
             ORDER BY plans.requested_at DESC",
            &[&task_id],
        )
        .map_err(|_| query_error("read task plans"))?
        .iter()
        .map(plan_from_row)
        .collect();
    let approvals = client
        .query(
            "SELECT id::text, task_id::text, subject, rationale, decision, requested_at::text \
             FROM octiqos.approvals WHERE task_id = $1::text::uuid ORDER BY requested_at DESC",
            &[&task_id],
        )
        .map_err(|_| query_error("read task approvals"))?
        .iter()
        .map(approval_from_row)
        .collect();
    let runs = client
        .query(
            "SELECT runs.id::text, runs.task_id::text, tasks.title, runs.provider, runs.model, \
                    runs.status, runs.current_step, runs.waiting_for_founder, runs.started_at::text \
             FROM octiqos.agent_runs AS runs \
             JOIN octiqos.tasks AS tasks ON tasks.id = runs.task_id \
             WHERE runs.task_id = $1::text::uuid ORDER BY runs.started_at DESC",
            &[&task_id],
        )
        .map_err(|_| query_error("read task runs"))?
        .iter()
        .map(run_from_row)
        .collect();
    let events = client
        .query(
            "SELECT id::text, task_id::text, kind, message, created_at::text \
             FROM octiqos.mission_events WHERE task_id = $1::text::uuid ORDER BY created_at DESC",
            &[&task_id],
        )
        .map_err(|_| query_error("read task history"))?
        .iter()
        .map(event_from_row)
        .collect();
    let cycles = client
        .query(
            "SELECT id::text, cycle_number, instruction, status, opened_at::text, closed_at::text \
             FROM octiqos.task_cycles WHERE task_id = $1::text::uuid ORDER BY cycle_number DESC",
            &[&task_id],
        )
        .map_err(|_| query_error("read task cycles"))?
        .iter()
        .map(cycle_from_row)
        .collect();
    let messages = client
        .query(
            "SELECT id::text, actor, kind, body, created_at::text \
             FROM octiqos.task_messages WHERE task_id = $1::text::uuid ORDER BY created_at DESC",
            &[&task_id],
        )
        .map_err(|_| query_error("read founder and agent messages"))?
        .iter()
        .map(task_message_from_row)
        .collect();
    serde_json::to_value(TaskDetail {
        task: task_from_row(&task),
        plans,
        approvals,
        runs,
        events,
        cycles,
        messages,
    })
    .map_err(|_| "OctiqOS could not encode the task detail.".to_string())
}

fn valid_domain(domain: &str) -> bool {
    matches!(domain, "company" | "personal" | "novel")
}

fn required_uuid(value: &str, label: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| format!("{label} is not a valid identifier."))
}

fn clean_task(
    title: String,
    detail: Option<String>,
    domain: String,
    workspace_path: Option<String>,
) -> Result<(String, Option<String>, String, Option<String>), String> {
    let title = title.trim().to_string();
    if !(3..=140).contains(&title.chars().count()) {
        return Err("A task title must be between 3 and 140 characters.".into());
    }
    if !valid_domain(&domain) {
        return Err("Choose Company, Personal, or Novel for this task.".into());
    }
    let detail = detail
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if detail
        .as_ref()
        .is_some_and(|value| value.chars().count() > 1_500)
    {
        return Err("Task context cannot exceed 1,500 characters.".into());
    }
    let workspace_path = workspace_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if workspace_path
        .as_ref()
        .is_some_and(|value| value.chars().count() > 1_000)
    {
        return Err("Workspace context is too long.".into());
    }
    Ok((title, detail, domain, workspace_path))
}

fn clean_lifecycle_note(value: String, label: &str) -> Result<String, String> {
    let value = value.trim().to_string();
    if !(3..=1_500).contains(&value.chars().count()) {
        return Err(format!("{label} must be between 3 and 1,500 characters."));
    }
    Ok(value)
}

fn clean_founder_direction(value: String) -> Result<String, String> {
    let value = value.trim().to_string();
    if !(3..=3_000).contains(&value.chars().count()) {
        return Err("A founder direction must be between 3 and 3,000 characters.".into());
    }
    Ok(value)
}

fn agent_question_from_response(response: &str) -> Option<String> {
    const MARKER: &str = "NEEDS FOUNDER DECISION:";
    response
        .lines()
        .find_map(|line| line.trim().strip_prefix(MARKER))
        .map(str::trim)
        .filter(|question| question.chars().count() >= 3)
        .map(|question| question.chars().take(1_500).collect())
}

fn bounded_agent_report(response: &str) -> String {
    let value = response.trim();
    let mut report: String = value.chars().take(12_000).collect();
    if value.chars().count() > report.chars().count() {
        report.push_str("\n\n[Report truncated by OctiqOS]");
    }
    report
}

fn clean_connector_source(value: String) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if matches!(
        value.as_str(),
        "ticket" | "feedback" | "email" | "calendar" | "folder-watch" | "docspace"
    ) {
        Ok(value)
    } else {
        Err("Choose a supported connector source.".into())
    }
}

fn clean_connector_reference(value: String) -> Result<String, String> {
    let value = value.trim().to_string();
    if !(1..=200).contains(&value.chars().count()) || value.chars().any(char::is_control) {
        return Err(
            "A connector reference must be between 1 and 200 plain-text characters.".into(),
        );
    }
    Ok(value)
}

fn workflow_profile_for_domain(
    transaction: &mut postgres::Transaction<'_>,
    domain: &str,
) -> Result<WorkflowProfile, String> {
    let row = transaction
        .query_opt(
            "SELECT id::text, slug, domain, label, intake_policy::text, planner_policy::text, \
                    approval_policy::text, execution_policy::text, is_enabled, \
                    default_workspace_id, default_workspace_name, default_workspace_path, updated_at::text \
             FROM octiqos.workflow_profiles WHERE domain = $1 LIMIT 1",
            &[&domain],
        )
        .map_err(|_| query_error("read the workflow policy"))?
        .ok_or_else(|| format!("No workflow profile is configured for the {domain} domain."))?;
    Ok(profile_from_row(&row))
}

fn policy_options(
    domain: &str,
) -> Result<
    (
        &'static [&'static str],
        &'static [&'static str],
        &'static [&'static str],
    ),
    String,
> {
    match domain {
        "company" => Ok((
            &["manual", "ticket", "feedback"],
            &["scope", "deployment", "external-write"],
            &["codex", "claude", "deepseek"],
        )),
        "personal" => Ok((
            &["manual", "email", "calendar", "folder-watch"],
            &["financial-change", "payment", "delete", "nas-write"],
            &["codex", "claude", "local-llm"],
        )),
        "novel" => Ok((
            &["manual", "docspace"],
            &["canon-change"],
            &["codex", "claude", "deepseek"],
        )),
        _ => Err("That workflow profile has an unsupported domain.".into()),
    }
}

fn clean_policy_list(
    values: Vec<String>,
    allowed: &[&str],
    label: &str,
    allow_empty: bool,
) -> Result<Vec<String>, String> {
    let mut values: Vec<String> = values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    values.sort();
    values.dedup();
    if !allow_empty && values.is_empty() {
        return Err(format!("Choose at least one {label}."));
    }
    if let Some(value) = values
        .iter()
        .find(|value| !allowed.contains(&value.as_str()))
    {
        return Err(format!("{value} is not a supported {label}."));
    }
    Ok(values)
}

fn clean_profile_label(value: String) -> Result<String, String> {
    let value = value.trim().to_string();
    if !(3..=80).contains(&value.chars().count()) {
        return Err("A workflow profile name must be between 3 and 80 characters.".into());
    }
    Ok(value)
}

fn clean_profile_choice(value: String, allowed: &[&str], label: &str) -> Result<String, String> {
    let value = value.trim().to_string();
    if !allowed.contains(&value.as_str()) {
        return Err(format!("Choose a supported {label}."));
    }
    Ok(value)
}

fn profile_workspace(
    workspaces: &WorkspaceState,
    workspace_id: Option<String>,
) -> Result<(Option<String>, Option<String>, Option<String>), String> {
    let Some(workspace_id) = workspace_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok((None, None, None));
    };
    let workspace = list_workspaces_impl(workspaces)?
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| "Choose a workspace from the OctiqFlow workspace registry.".to_string())?;
    if workspace.primary_path.trim().is_empty() || !std::path::Path::new(&workspace.primary_path).is_dir()
    {
        return Err("The selected workspace folder is no longer available on this machine.".into());
    }
    Ok((
        Some(workspace.id),
        Some(workspace.name),
        Some(workspace.primary_path),
    ))
}

/// The profile editor only changes declared policy, not the control-plane's
/// non-negotiable safety rules. In V0 every execution still needs founder
/// verification evidence and personal finance remains review-only.
pub fn update_workflow_profile_impl(
    workspaces: &WorkspaceState,
    profile_id: String,
    input: Value,
) -> Result<Value, String> {
    required_uuid(&profile_id, "Workflow profile")?;
    let input: ProfileUpdateInput = serde_json::from_value(input)
        .map_err(|_| "The workflow profile settings were incomplete.".to_string())?;
    let label = clean_profile_label(input.label)?;
    let confirmation = clean_profile_choice(
        input.confirmation,
        &["none", "plan", "policy"],
        "confirmation policy",
    )?;
    let planner_mode = clean_profile_choice(
        input.planner_mode,
        &[
            "brainstorm-and-grill",
            "clarify-and-draft",
            "continuity-and-outline",
        ],
        "planning style",
    )?;
    let (default_workspace_id, default_workspace_name, default_workspace_path) =
        profile_workspace(workspaces, input.default_workspace_id)?;
    let mut client = connect()?;
    let mut transaction = client
        .transaction()
        .map_err(|_| query_error("start the workflow profile update"))?;
    let domain_row = transaction
        .query_opt(
            "SELECT domain FROM octiqos.workflow_profiles WHERE id = $1::text::uuid FOR UPDATE",
            &[&profile_id],
        )
        .map_err(|_| query_error("read the workflow profile"))?
        .ok_or_else(|| "That workflow profile no longer exists.".to_string())?;
    let domain: String = domain_row.get("domain");
    let (source_options, approval_options, runner_options) = policy_options(&domain)?;
    let intake_sources =
        clean_policy_list(input.intake_sources, source_options, "intake source", false)?;
    let allowed_runners = clean_policy_list(input.allowed_runners, runner_options, "runner", true)?;
    let approval_requirements = if domain == "personal" {
        approval_options
            .iter()
            .map(|value| (*value).to_string())
            .collect()
    } else {
        clean_policy_list(
            input.approval_requirements,
            approval_options,
            "approval requirement",
            true,
        )?
    };
    let intake_policy =
        json!({ "sources": intake_sources, "confirmation": confirmation }).to_string();
    let planner_policy = json!({ "agent": "pm", "mode": planner_mode }).to_string();
    let approval_policy = json!({ "requiredFor": approval_requirements }).to_string();
    let execution_policy = if domain == "personal" {
        json!({
            "runners": allowed_runners,
            "evidenceRequired": true,
            "financialMode": "review-only"
        })
    } else {
        json!({ "runners": allowed_runners, "evidenceRequired": true })
    }
    .to_string();
    transaction
        .execute(
            "UPDATE octiqos.workflow_profiles \
             SET label = $2, intake_policy = $3::text::jsonb, planner_policy = $4::text::jsonb, \
                 approval_policy = $5::text::jsonb, execution_policy = $6::text::jsonb, is_enabled = $7, \
                 default_workspace_id = $8, default_workspace_name = $9, default_workspace_path = $10, \
                 updated_at = now() \
             WHERE id = $1::text::uuid",
            &[
                &profile_id,
                &label,
                &intake_policy,
                &planner_policy,
                &approval_policy,
                &execution_policy,
                &input.is_enabled,
                &default_workspace_id,
                &default_workspace_name,
                &default_workspace_path,
            ],
        )
        .map_err(|_| query_error("save the workflow profile"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.mission_events (id, task_id, kind, message) \
             VALUES ($1::text::uuid, NULL, 'workflow_profile_updated', $2)",
            &[
                &Uuid::new_v4().to_string(),
                &format!("Workflow profile updated: {label}"),
            ],
        )
        .map_err(|_| query_error("record the workflow profile update"))?;
    transaction
        .commit()
        .map_err(|_| query_error("finish the workflow profile update"))?;
    dashboard_value(&mut client)
}

pub fn dashboard_impl() -> Result<Value, String> {
    let mut client = connect()?;
    dashboard_value(&mut client)
}

pub fn capture_task_impl(
    title: String,
    detail: Option<String>,
    domain: String,
    workspace_path: Option<String>,
) -> Result<Value, String> {
    let (title, detail, domain, workspace_path) =
        clean_task(title, detail, domain, workspace_path)?;
    let task_id = Uuid::new_v4().to_string();
    let cycle_id = Uuid::new_v4().to_string();
    let event_id = Uuid::new_v4().to_string();
    let event_message = format!("Captured: {title}");
    let mut client = connect()?;
    let mut transaction = client
        .transaction()
        .map_err(|_| query_error("start task capture"))?;
    let profile = workflow_profile_for_domain(&mut transaction, &domain)?;
    if !profile.is_enabled {
        return Err(format!(
            "The {} workflow profile is disabled. Re-enable it in Workflow profiles before creating work there.",
            profile.label
        ));
    }
    let workspace_path = workspace_path.or(profile.default_workspace_path.clone());
    transaction
        .execute(
            "INSERT INTO octiqos.tasks (id, title, detail, domain, stage, priority, risk, next_step, workspace_path) \
             VALUES ($1::text::uuid, $2, $3, $4, 'captured', 'routine', 'safe', 'Send to PM for a read-only plan', $5)",
            &[&task_id, &title, &detail, &domain, &workspace_path],
        )
        .map_err(|_| query_error("capture the task"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.task_cycles (id, task_id, cycle_number, status) \
             VALUES ($1::text::uuid, $2::text::uuid, 1, 'active')",
            &[&cycle_id, &task_id],
        )
        .map_err(|_| query_error("open the first task cycle"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.mission_events (id, task_id, kind, message) \
             VALUES ($1::text::uuid, $2::text::uuid, 'task_captured', $3)",
            &[&event_id, &task_id, &event_message],
        )
        .map_err(|_| query_error("record task capture"))?;
    transaction
        .commit()
        .map_err(|_| query_error("finish task capture"))?;
    dashboard_value(&mut client)
}

/// Persist an authenticated connector signal as a guarded, founder-visible
/// task. This is deliberately *not* an execution path: the signal still needs
/// the normal PM plan, confirmation, and verification gates before an agent
/// can do anything consequential. Duplicate deliveries resolve to the first
/// task without emitting duplicate work or signals.
pub fn connector_intake_impl(
    source: String,
    external_id: String,
    title: String,
    detail: Option<String>,
    domain: String,
) -> Result<Value, String> {
    let source = clean_connector_source(source)?;
    let external_id = clean_connector_reference(external_id)?;
    let (title, detail, domain, _) = clean_task(title, detail, domain, None)?;
    let mut client = connect()?;
    let mut transaction = client
        .transaction()
        .map_err(|_| query_error("start connector intake"))?;
    let profile = workflow_profile_for_domain(&mut transaction, &domain)?;
    if !profile.is_enabled {
        return Err(format!(
            "The {} workflow profile is disabled. Re-enable it before accepting connector work.",
            profile.label
        ));
    }
    if !profile
        .intake_sources
        .iter()
        .any(|allowed| allowed == &source)
    {
        return Err(format!(
            "The {} workflow profile does not allow the {} connector source.",
            profile.label, source
        ));
    }
    if let Some(row) = transaction
        .query_opt(
            "SELECT task_id::text FROM octiqos.connector_intakes \
             WHERE source = $1 AND external_id = $2 FOR UPDATE",
            &[&source, &external_id],
        )
        .map_err(|_| query_error("deduplicate connector intake"))?
    {
        let task_id: String = row.get("task_id");
        transaction
            .commit()
            .map_err(|_| query_error("finish connector intake"))?;
        return serde_json::to_value(ConnectorIntakeResult {
            status: "duplicate",
            task_id,
        })
        .map_err(|_| "OctiqOS could not encode connector intake.".to_string());
    }

    let task_id = Uuid::new_v4().to_string();
    let cycle_id = Uuid::new_v4().to_string();
    let intake_id = Uuid::new_v4().to_string();
    let event_id = Uuid::new_v4().to_string();
    let provenance = format!("External signal — source: {source}; reference: {external_id}.");
    let detail = Some(match detail {
        Some(detail) => format!("{provenance}\n\n{detail}"),
        None => provenance,
    });
    let workspace_path = profile.default_workspace_path.clone();
    transaction
        .execute(
            "INSERT INTO octiqos.tasks (id, title, detail, domain, stage, priority, risk, next_step, workspace_path) \
             VALUES ($1::text::uuid, $2, $3, $4, 'captured', 'routine', 'guarded', $5, $6)",
            &[
                &task_id,
                &title,
                &detail,
                &domain,
                &format!("Review the {source} signal, then ask PM for a read-only plan"),
                &workspace_path,
            ],
        )
        .map_err(|_| query_error("capture connector task"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.task_cycles (id, task_id, cycle_number, status) \
             VALUES ($1::text::uuid, $2::text::uuid, 1, 'active')",
            &[&cycle_id, &task_id],
        )
        .map_err(|_| query_error("open connector task cycle"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.connector_intakes (id, source, external_id, domain, task_id) \
             VALUES ($1::text::uuid, $2, $3, $4, $5::text::uuid)",
            &[&intake_id, &source, &external_id, &domain, &task_id],
        )
        .map_err(|_| query_error("record connector intake"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.mission_events (id, task_id, kind, message) \
             VALUES ($1::text::uuid, $2::text::uuid, 'connector_intake_recorded', $3)",
            &[
                &event_id,
                &task_id,
                &format!("{source} signal captured: {title}"),
            ],
        )
        .map_err(|_| query_error("record connector signal"))?;
    transaction
        .commit()
        .map_err(|_| query_error("finish connector intake"))?;
    serde_json::to_value(ConnectorIntakeResult {
        status: "captured",
        task_id,
    })
    .map_err(|_| "OctiqOS could not encode connector intake.".to_string())
}

fn planner_cwd(task_workspace: Option<String>) -> Result<String, String> {
    task_workspace
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env::var("OCTIQOS_PM_CWD")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or_else(|| {
            "Set OCTIQOS_PM_CWD before requesting a PM plan without a workspace context."
                .to_string()
        })
}

fn pm_chat_key(plan_id: &str) -> String {
    format!("mission-pm-{plan_id}")
}

fn runner_chat_key(run_id: &str) -> String {
    format!("mission-run-{run_id}")
}

fn planner_prompt(
    title: &str,
    detail: Option<&str>,
    domain: &str,
    planner_mode: &str,
    confirmation: &str,
) -> String {
    format!(
        "You are the read-only PM agent for OctiqOS. Turn the request below into a plan for the founder to review. Do not edit files, run commands, contact anyone, or dispatch other agents. Be concrete and concise.\n\nDomain: {domain}\nPlanning style: {planner_mode}\nIntake confirmation posture: {confirmation}\nRequested outcome: {title}\nContext: {}\n\nReturn exactly these sections:\n1. Outcome\n2. Scope and assumptions\n3. Risks or decisions the founder must make\n4. Numbered execution plan\n5. Suggested runner and evidence of done\n\nIf crucial information is missing, name the question rather than inventing it.",
        detail.filter(|value| !value.trim().is_empty()).unwrap_or("No additional context provided."),
    )
}

fn runner_prompt(title: &str, detail: Option<&str>, plan: &str) -> String {
    format!(
        "You are the execution runner for a founder-confirmed OctiqOS task. Work only within the current workspace and follow the approved plan. Do not commit, deploy, make external changes, or broaden scope. When a material decision or permission is required, stop and end your response with `NEEDS FOUNDER DECISION: <one precise question>`; do not guess permission or continue past that boundary. The founder can send a follow-up instruction through the task card. At the end, report the changed files, checks run, and anything still needing review.\n\nRequested outcome: {title}\nContext: {}\n\nApproved PM plan:\n{plan}",
        detail.filter(|value| !value.trim().is_empty()).unwrap_or("No additional context provided."),
    )
}

fn mark_plan_start_failure(plan_id: &str, message: &str) {
    let Ok(mut client) = connect() else { return };
    let Ok(mut transaction) = client.transaction() else {
        return;
    };
    let Ok(plan) = transaction.query_opt(
        "UPDATE octiqos.plans SET status = 'failed', completed_at = now() \
         WHERE id = $1::text::uuid AND status = 'drafting' \
         RETURNING task_id::text",
        &[&plan_id],
    ) else {
        return;
    };
    let Some(plan) = plan else { return };
    let task_id: String = plan.get("task_id");
    let _ = transaction.execute(
        "UPDATE octiqos.tasks SET stage = 'captured', next_step = 'Retry PM planning after the launch issue is resolved', updated_at = now() WHERE id = $1::text::uuid",
        &[&task_id],
    );
    let _ = transaction.execute(
        "INSERT INTO octiqos.mission_events (id, task_id, kind, message) VALUES ($1::text::uuid, $2::text::uuid, 'pm_plan_failed', $3)",
        &[&Uuid::new_v4().to_string(), &task_id, &format!("PM plan could not start: {message}")],
    );
    let _ = transaction.commit();
}

/// Start a real, read-only PM agent. The completed response is recorded by the
/// shared chat runtime through `record_agent_completion` below.
pub fn request_plan_impl(chats: Arc<ChatManager>, task_id: String) -> Result<Value, String> {
    required_uuid(&task_id, "Task")?;
    let plan_id = Uuid::new_v4().to_string();
    let chat_key = pm_chat_key(&plan_id);
    let mut client = connect()?;
    let mut transaction = client
        .transaction()
        .map_err(|_| query_error("start PM planning"))?;
    let task = transaction
        .query_opt(
            "SELECT tasks.title, tasks.detail, tasks.domain, tasks.workspace_path, cycles.instruction AS cycle_instruction \
             FROM octiqos.tasks AS tasks \
             LEFT JOIN LATERAL ( \
               SELECT instruction FROM octiqos.task_cycles \
               WHERE task_id = tasks.id AND status = 'active' \
               ORDER BY cycle_number DESC LIMIT 1 \
             ) AS cycles ON true \
             WHERE tasks.id = $1::text::uuid FOR UPDATE OF tasks",
            &[&task_id],
        )
        .map_err(|error| format!("{} ({error})", query_error("read the task for planning")))?
        .ok_or_else(|| "That task no longer exists.".to_string())?;
    let title: String = task.get("title");
    let detail: Option<String> = task.get("detail");
    let domain: String = task.get("domain");
    let workspace_path: Option<String> = task.get("workspace_path");
    let cycle_instruction: Option<String> = task.get("cycle_instruction");
    let profile = workflow_profile_for_domain(&mut transaction, &domain)?;
    if !profile.is_enabled {
        return Err(format!(
            "The {} workflow profile is disabled. Re-enable it before requesting a PM plan.",
            profile.label
        ));
    }
    let founder_directions: Vec<String> = transaction
        .query(
            "SELECT body FROM octiqos.task_messages \
             WHERE task_id = $1::text::uuid AND actor = 'founder' AND kind = 'direction' \
             ORDER BY created_at ASC",
            &[&task_id],
        )
        .map_err(|_| query_error("read founder directions for the PM"))?
        .iter()
        .map(|row| row.get("body"))
        .collect();
    let planning_detail = match cycle_instruction {
        Some(instruction) if !instruction.trim().is_empty() => Some(format!(
            "{}\n\nRe-open instruction for this work cycle: {instruction}",
            detail
                .as_deref()
                .unwrap_or("No additional context provided.")
        )),
        _ => detail,
    };
    let planning_detail = if founder_directions.is_empty() {
        planning_detail
    } else {
        Some(format!(
            "{}\n\nFounder directions to incorporate:\n{}",
            planning_detail
                .as_deref()
                .unwrap_or("No additional context provided."),
            founder_directions
                .iter()
                .map(|direction| format!("- {direction}"))
                .collect::<Vec<_>>()
                .join("\n")
        ))
    };
    let cwd = planner_cwd(workspace_path)?;
    let drafting: i64 = transaction
        .query_one(
            "SELECT COUNT(*) FROM octiqos.plans WHERE task_id = $1::text::uuid AND status = 'drafting'",
            &[&task_id],
        )
        .map_err(|_| query_error("check PM planning state"))?
        .get(0);
    if drafting > 0 {
        return Err("A PM agent is already preparing a plan for this task.".into());
    }
    transaction
        .execute(
            "UPDATE octiqos.plans SET status = 'superseded' \
             WHERE task_id = $1::text::uuid AND status = 'awaiting_confirmation'",
            &[&task_id],
        )
        .map_err(|_| query_error("supersede the earlier plan"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.plans (id, task_id, status, planner_provider, planner_model, chat_key) \
             VALUES ($1::text::uuid, $2::text::uuid, 'drafting', 'Codex', 'gpt-5.6-terra', $3)",
            &[&plan_id, &task_id, &chat_key],
        )
        .map_err(|_| query_error("save the PM plan request"))?;
    transaction
        .execute(
            "UPDATE octiqos.tasks SET stage = 'triage', next_step = 'PM agent is preparing a read-only plan', updated_at = now() WHERE id = $1::text::uuid",
            &[&task_id],
        )
        .map_err(|_| query_error("mark the task as planning"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.mission_events (id, task_id, kind, message) VALUES ($1::text::uuid, $2::text::uuid, 'pm_plan_requested', $3)",
            &[&Uuid::new_v4().to_string(), &task_id, &format!("PM plan requested: {title}")],
        )
        .map_err(|_| query_error("record PM planning"))?;
    transaction
        .commit()
        .map_err(|_| query_error("finish PM planning setup"))?;

    if let Err(why) = crate::agent_chat::chat_start_impl(
        chats,
        chat_key,
        cwd,
        ChatAgent::Codex,
        Some("gpt-5.6-terra".into()),
        Some(Access::Read),
        Some(planner_prompt(
            &title,
            planning_detail.as_deref(),
            &domain,
            &profile.planner_mode,
            &profile.confirmation,
        )),
        None,
        None,
        None, // Project environment overrides are not set by the mission portal.
        Some("medium".into()),
        None,
        Some(false),
    ) {
        mark_plan_start_failure(&plan_id, &why);
        return Err(format!("The PM agent could not start: {why}"));
    }
    dashboard_value(&mut client)
}

fn runner_agent(provider: &str) -> Result<(ChatAgent, &'static str, &'static str), String> {
    match provider {
        "codex" => Ok((ChatAgent::Codex, "Codex", "gpt-5.6-terra")),
        "claude" => Ok((ChatAgent::Claude, "Claude", "sonnet")),
        _ => Err("Choose Codex or Claude as the first execution runner.".into()),
    }
}

fn mark_runner_start_failure(run_id: &str, message: &str) {
    let Ok(mut client) = connect() else { return };
    let Ok(mut transaction) = client.transaction() else {
        return;
    };
    let Ok(run) = transaction.query_opt(
        "UPDATE octiqos.agent_runs \
         SET status = 'blocked', current_step = 'Runner failed to start', updated_at = now() \
         WHERE id = $1::text::uuid AND status = 'queued' \
         RETURNING task_id::text",
        &[&run_id],
    ) else {
        return;
    };
    let Some(run) = run else { return };
    let task_id: String = run.get("task_id");
    let _ = transaction.execute(
        "UPDATE octiqos.tasks SET stage = 'blocked', next_step = 'Resolve the runner launch issue', updated_at = now() WHERE id = $1::text::uuid",
        &[&task_id],
    );
    let _ = transaction.execute(
        "INSERT INTO octiqos.mission_events (id, task_id, kind, message) VALUES ($1::text::uuid, $2::text::uuid, 'runner_failed', $3)",
        &[&Uuid::new_v4().to_string(), &task_id, &format!("Runner could not start: {message}")],
    );
    let _ = transaction.commit();
}

/// The founder's explicit confirmation is the gate between a read-only PM plan
/// and an execution agent. The runner still starts in `manual` access mode, so
/// tools and external effects cannot silently bypass the normal agent controls.
pub fn confirm_plan_impl(
    chats: Arc<ChatManager>,
    task_id: String,
    plan_id: String,
    provider: String,
) -> Result<Value, String> {
    required_uuid(&task_id, "Task")?;
    required_uuid(&plan_id, "Plan")?;
    let (agent, provider_name, model) = runner_agent(&provider)?;
    let run_id = Uuid::new_v4().to_string();
    let chat_key = runner_chat_key(&run_id);
    let mut client = connect()?;
    let mut transaction = client
        .transaction()
        .map_err(|_| query_error("start the execution handoff"))?;
    let plan = transaction
        .query_opt(
            "SELECT plans.content, tasks.title, tasks.detail, tasks.workspace_path, tasks.domain \
             FROM octiqos.plans AS plans \
             JOIN octiqos.tasks AS tasks ON tasks.id = plans.task_id \
             WHERE plans.id = $1::text::uuid AND plans.task_id = $2::text::uuid \
               AND plans.status = 'awaiting_confirmation' FOR UPDATE",
            &[&plan_id, &task_id],
        )
        .map_err(|_| query_error("read the confirmed plan"))?
        .ok_or_else(|| "That PM plan is no longer awaiting your confirmation.".to_string())?;
    let title: String = plan.get("title");
    let detail: Option<String> = plan.get("detail");
    let content: Option<String> = plan.get("content");
    let workspace_path: Option<String> = plan.get("workspace_path");
    let domain: String = plan.get("domain");
    let profile = workflow_profile_for_domain(&mut transaction, &domain)?;
    if !profile.is_enabled {
        return Err(format!(
            "The {} workflow profile is disabled. Re-enable it before dispatching a runner.",
            profile.label
        ));
    }
    if !profile
        .allowed_runners
        .iter()
        .any(|runner| runner == &provider)
    {
        return Err(format!(
            "The {} workflow profile does not allow the {} runner.",
            profile.label, provider
        ));
    }
    let workspace_path = workspace_path
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "Choose an OctiqFlow workspace before dispatching an execution runner.".to_string()
        })?;
    if !std::path::Path::new(&workspace_path).is_dir() {
        return Err("The linked workspace folder is no longer available on this machine.".into());
    }
    let content = content
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "The PM response was empty; ask for a new plan before dispatching work.".to_string()
        })?;
    transaction
        .execute(
            "UPDATE octiqos.plans SET status = 'confirmed', confirmed_at = now() WHERE id = $1::text::uuid",
            &[&plan_id],
        )
        .map_err(|_| query_error("confirm the PM plan"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.agent_runs (id, task_id, provider, model, status, current_step, chat_key) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4, 'queued', 'Starting from the founder-confirmed PM plan', $5)",
            &[&run_id, &task_id, &provider_name, &model, &chat_key],
        )
        .map_err(|_| query_error("queue the execution runner"))?;
    transaction
        .execute(
            "UPDATE octiqos.tasks SET stage = 'running', next_step = 'Runner is executing the confirmed plan', updated_at = now() WHERE id = $1::text::uuid",
            &[&task_id],
        )
        .map_err(|_| query_error("mark the task as running"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.mission_events (id, task_id, kind, message) VALUES ($1::text::uuid, $2::text::uuid, 'execution_dispatched', $3)",
            &[&Uuid::new_v4().to_string(), &task_id, &format!("{provider_name} runner dispatched: {title}")],
        )
        .map_err(|_| query_error("record the execution handoff"))?;
    transaction
        .commit()
        .map_err(|_| query_error("finish the execution handoff"))?;

    if let Err(why) = crate::agent_chat::chat_start_impl(
        chats,
        chat_key,
        workspace_path,
        agent,
        Some(model.into()),
        Some(Access::Manual),
        Some(runner_prompt(&title, detail.as_deref(), &content)),
        None,
        None,
        None, // Project environment overrides are not set by the mission portal.
        Some("medium".into()),
        None,
        Some(false),
    ) {
        mark_runner_start_failure(&run_id, &why);
        return Err(format!("The execution runner could not start: {why}"));
    }
    dashboard_value(&mut client)
}

/// Save a founder's mid-flight instruction in the task record and deliver it
/// to the active runner. Command-line agents receive it as their next turn;
/// if their prior turn has already ended, the stored launch context resumes
/// the same runner rather than starting a different agent in a guessed folder.
pub fn send_founder_direction_impl(
    chats: Arc<ChatManager>,
    task_id: String,
    direction: String,
) -> Result<Value, String> {
    required_uuid(&task_id, "Task")?;
    let direction = clean_founder_direction(direction)?;
    let mut client = connect()?;
    let mut transaction = client
        .transaction()
        .map_err(|_| query_error("start the founder direction"))?;
    let task = transaction
        .query_opt(
            "SELECT id::text, title, stage FROM octiqos.tasks \
             WHERE id = $1::text::uuid FOR UPDATE",
            &[&task_id],
        )
        .map_err(|_| query_error("read the task for founder direction"))?
        .ok_or_else(|| "That task no longer exists.".to_string())?;
    let title: String = task.get("title");
    let stage: String = task.get("stage");
    if matches!(stage.as_str(), "done" | "abandoned") {
        return Err("Reopen completed or abandoned work before sending a new direction.".into());
    }
    let runner = transaction
        .query_opt(
            "SELECT id::text, chat_key, waiting_for_founder \
             FROM octiqos.agent_runs \
             WHERE task_id = $1::text::uuid \
               AND (status IN ('queued', 'running') OR waiting_for_founder = TRUE) \
               AND chat_key IS NOT NULL \
             ORDER BY started_at DESC LIMIT 1 FOR UPDATE",
            &[&task_id],
        )
        .map_err(|_| query_error("read the active runner"))?;
    let runner = runner.map(|row| {
        (
            row.get::<_, String>("id"),
            row.get::<_, String>("chat_key"),
            row.get::<_, bool>("waiting_for_founder"),
        )
    });
    transaction
        .execute(
            "INSERT INTO octiqos.task_messages (id, task_id, actor, kind, body) \
             VALUES ($1::text::uuid, $2::text::uuid, 'founder', 'direction', $3)",
            &[&Uuid::new_v4().to_string(), &task_id, &direction],
        )
        .map_err(|_| query_error("record the founder direction"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.mission_events (id, task_id, kind, message) \
             VALUES ($1::text::uuid, $2::text::uuid, 'founder_direction_recorded', $3)",
            &[
                &Uuid::new_v4().to_string(),
                &task_id,
                &format!("Founder direction recorded for {title}"),
            ],
        )
        .map_err(|_| query_error("record the founder direction signal"))?;
    if let Some((run_id, _, waiting_for_founder)) = &runner {
        transaction
            .execute(
                "UPDATE octiqos.agent_runs \
                 SET status = 'running', waiting_for_founder = FALSE, \
                     pending_founder_direction = $2, \
                     current_step = 'Applying founder direction', updated_at = now() \
                 WHERE id = $1::text::uuid",
                &[&run_id, &(!*waiting_for_founder)],
            )
            .map_err(|_| query_error("resume the runner state"))?;
        transaction
            .execute(
                "UPDATE octiqos.tasks \
                 SET stage = 'running', next_step = 'Runner is applying your latest direction', updated_at = now() \
                 WHERE id = $1::text::uuid",
                &[&task_id],
            )
            .map_err(|_| query_error("update the task after founder direction"))?;
    } else {
        transaction
            .execute(
                "UPDATE octiqos.tasks \
                 SET next_step = CASE WHEN stage = 'captured' \
                   THEN 'Founder direction recorded — ask PM for a plan when ready' \
                   ELSE 'Founder direction recorded for the next PM pass' END, updated_at = now() \
                 WHERE id = $1::text::uuid",
                &[&task_id],
            )
            .map_err(|_| query_error("update the task direction state"))?;
    }
    transaction
        .commit()
        .map_err(|_| query_error("finish the founder direction"))?;

    if let Some((run_id, chat_key, waiting_for_founder)) = runner {
        let prompt = format!(
            "Founder direction for the current task:\n\n{direction}\n\nApply this only within the approved task and its safety limits. If it creates a material choice or requires permission, stop and end with `NEEDS FOUNDER DECISION: <your precise question>` rather than assuming authority."
        );
        let delivered = if waiting_for_founder {
            crate::agent_chat::send_to_host(chats.clone(), &chat_key, &prompt)
        } else {
            crate::agent_chat::chat_send_impl(chats.clone(), chat_key.clone(), prompt.clone(), None, None)
                .or_else(|why| {
                    if why.contains("no such chat") {
                        client
                            .execute(
                                "UPDATE octiqos.agent_runs SET pending_founder_direction = FALSE, updated_at = now() WHERE id = $1::text::uuid",
                                &[&run_id],
                            )
                            .map_err(|_| query_error("resume the stored runner state"))?;
                        crate::agent_chat::send_to_host(chats.clone(), &chat_key, &prompt)
                    } else {
                        Err(why)
                    }
                })
        };
        delivered.map_err(|why| format!("The direction was recorded, but the runner could not receive it: {why}"))?;
    }
    dashboard_value(&mut client)
}

/// Abandoning is a deliberate terminal state, not a delete. The task's plans,
/// runs, decisions, and event history remain available in its detail view.
pub fn abandon_task_impl(
    chats: Arc<ChatManager>,
    task_id: String,
    reason: String,
) -> Result<Value, String> {
    required_uuid(&task_id, "Task")?;
    let reason = clean_lifecycle_note(reason, "An abandon reason")?;
    let mut client = connect()?;
    let mut transaction = client
        .transaction()
        .map_err(|_| query_error("start abandoning the task"))?;
    let task = transaction
        .query_opt(
            "SELECT title FROM octiqos.tasks \
             WHERE id = $1::text::uuid AND stage <> 'abandoned' FOR UPDATE",
            &[&task_id],
        )
        .map_err(|_| query_error("read the task to abandon"))?
        .ok_or_else(|| "That task is already abandoned or no longer exists.".to_string())?;
    let title: String = task.get("title");
    transaction
        .execute(
            "UPDATE octiqos.tasks \
             SET stage = 'abandoned', next_step = 'Work intentionally abandoned', updated_at = now() \
             WHERE id = $1::text::uuid",
            &[&task_id],
        )
        .map_err(|_| query_error("mark the task abandoned"))?;
    transaction
        .execute(
            "UPDATE octiqos.task_cycles SET status = 'abandoned', closed_at = now() \
             WHERE task_id = $1::text::uuid AND status = 'active'",
            &[&task_id],
        )
        .map_err(|_| query_error("close the active task cycle"))?;
    let plan_rows = transaction
        .query(
            "UPDATE octiqos.plans SET status = 'superseded' \
             WHERE task_id = $1::text::uuid AND status IN ('drafting', 'awaiting_confirmation') \
             RETURNING chat_key",
            &[&task_id],
        )
        .map_err(|_| query_error("close the active PM plan"))?;
    let run_rows = transaction
        .query(
            "UPDATE octiqos.agent_runs \
             SET status = 'blocked', current_step = 'Stopped because the founder abandoned this task', updated_at = now() \
             WHERE task_id = $1::text::uuid AND status IN ('queued', 'running', 'verifying') \
             RETURNING chat_key",
            &[&task_id],
        )
        .map_err(|_| query_error("stop the active runner"))?;
    let chat_keys: Vec<String> = plan_rows
        .iter()
        .chain(run_rows.iter())
        .filter_map(|row| row.get::<_, Option<String>>("chat_key"))
        .collect();
    transaction
        .execute(
            "INSERT INTO octiqos.mission_events (id, task_id, kind, message) \
             VALUES ($1::text::uuid, $2::text::uuid, 'task_abandoned', $3)",
            &[
                &Uuid::new_v4().to_string(),
                &task_id,
                &format!("Abandoned {title}: {reason}"),
            ],
        )
        .map_err(|_| query_error("record the abandonment"))?;
    transaction
        .commit()
        .map_err(|_| query_error("finish abandoning the task"))?;

    for chat_key in chat_keys {
        let _ = crate::agent_chat::chat_stop_impl(chats.as_ref(), chat_key);
    }
    dashboard_value(&mut client)
}

/// A reopened task keeps the original record and starts a new work cycle. It
/// immediately goes back through the same read-only PM gate as brand-new work.
pub fn reopen_task_impl(
    chats: Arc<ChatManager>,
    task_id: String,
    instruction: String,
) -> Result<Value, String> {
    required_uuid(&task_id, "Task")?;
    let instruction = clean_lifecycle_note(instruction, "A reopen instruction")?;
    let cycle_id = Uuid::new_v4().to_string();
    let event_id = Uuid::new_v4().to_string();
    let mut client = connect()?;
    let mut transaction = client
        .transaction()
        .map_err(|_| query_error("start reopening the task"))?;
    let task = transaction
        .query_opt(
            "SELECT title, stage FROM octiqos.tasks WHERE id = $1::text::uuid FOR UPDATE",
            &[&task_id],
        )
        .map_err(|_| query_error("read the task to reopen"))?
        .ok_or_else(|| "That task no longer exists.".to_string())?;
    let title: String = task.get("title");
    let stage: String = task.get("stage");
    if !matches!(stage.as_str(), "done" | "abandoned" | "blocked") {
        return Err(
            "Only completed, blocked, or abandoned work can be reopened as a new cycle.".into(),
        );
    }
    let cycle_number: i32 = transaction
        .query_one(
            "SELECT COALESCE(MAX(cycle_number), 0) + 1 FROM octiqos.task_cycles \
             WHERE task_id = $1::text::uuid",
            &[&task_id],
        )
        .map_err(|_| query_error("calculate the next task cycle"))?
        .get(0);
    transaction
        .execute(
            "UPDATE octiqos.task_cycles SET status = 'completed', closed_at = now() \
             WHERE task_id = $1::text::uuid AND status = 'active'",
            &[&task_id],
        )
        .map_err(|_| query_error("close the previous task cycle"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.task_cycles (id, task_id, cycle_number, instruction, status) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4, 'active')",
            &[&cycle_id, &task_id, &cycle_number, &instruction],
        )
        .map_err(|_| query_error("open the new task cycle"))?;
    transaction
        .execute(
            "UPDATE octiqos.tasks SET stage = 'captured', \
             next_step = 'PM agent will evaluate the new instruction', updated_at = now() \
             WHERE id = $1::text::uuid",
            &[&task_id],
        )
        .map_err(|_| query_error("reopen the task"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.mission_events (id, task_id, kind, message) \
             VALUES ($1::text::uuid, $2::text::uuid, 'task_reopened', $3)",
            &[
                &event_id,
                &task_id,
                &format!("Reopened {title} as cycle {cycle_number}: {instruction}"),
            ],
        )
        .map_err(|_| query_error("record the reopened task"))?;
    transaction
        .commit()
        .map_err(|_| query_error("finish reopening the task"))?;

    request_plan_impl(chats, task_id)
}

/// The common chat reader calls this only at a provider's actual turn finish.
/// Ordinary Flow chats are ignored; the two private key prefixes belong only to
/// this control loop and convert a completed response into durable state.
pub fn record_agent_completion(chat_key: &str, response: &str) {
    if let Some(plan_id) = chat_key.strip_prefix("mission-pm-") {
        if Uuid::parse_str(plan_id).is_ok() {
            record_plan_completion(plan_id, response);
        }
    } else if let Some(run_id) = chat_key.strip_prefix("mission-run-") {
        if Uuid::parse_str(run_id).is_ok() {
            record_runner_completion(run_id, response);
        }
    }
}

fn record_plan_completion(plan_id: &str, response: &str) {
    let Ok(mut client) = connect() else { return };
    let Ok(mut transaction) = client.transaction() else {
        return;
    };
    let failed = response.trim().is_empty();
    let status = if failed {
        "failed"
    } else {
        "awaiting_confirmation"
    };
    let Ok(plan) = transaction.query_opt(
        "UPDATE octiqos.plans SET status = $2, content = $3, completed_at = now() \
         WHERE id = $1::text::uuid AND status = 'drafting' RETURNING task_id::text",
        &[&plan_id, &status, &response],
    ) else {
        return;
    };
    let Some(plan) = plan else { return };
    let task_id: String = plan.get("task_id");
    let (next_step, event_kind, event_message) = if failed {
        (
            "Retry PM planning; the agent returned no proposal",
            "pm_plan_failed",
            "PM agent finished without a usable plan".to_string(),
        )
    } else {
        (
            "Review and confirm the PM plan",
            "pm_plan_ready",
            "PM plan is ready for founder confirmation".to_string(),
        )
    };
    let _ = transaction.execute(
        "UPDATE octiqos.tasks SET stage = 'triage', next_step = $2, updated_at = now() WHERE id = $1::text::uuid",
        &[&task_id, &next_step],
    );
    let _ = transaction.execute(
        "INSERT INTO octiqos.mission_events (id, task_id, kind, message) VALUES ($1::text::uuid, $2::text::uuid, $3, $4)",
        &[&Uuid::new_v4().to_string(), &task_id, &event_kind, &event_message],
    );
    let _ = transaction.commit();
}

fn record_runner_completion(run_id: &str, response: &str) {
    let Ok(mut client) = connect() else { return };
    let Ok(mut transaction) = client.transaction() else {
        return;
    };
    let failed = response.trim().is_empty();
    let founder_question = (!failed)
        .then(|| agent_question_from_response(response))
        .flatten();
    let Ok(run) = transaction.query_opt(
        "SELECT task_id::text, pending_founder_direction \
         FROM octiqos.agent_runs WHERE id = $1::text::uuid AND status IN ('queued', 'running') FOR UPDATE",
        &[&run_id],
    ) else {
        return;
    };
    let Some(run) = run else { return };
    let task_id: String = run.get("task_id");
    let pending_founder_direction: bool = run.get("pending_founder_direction");
    let (status, waiting_for_founder, pending_founder_direction, current_step, task_stage, next_step, event_kind, event_message, message_kind, message_body) = if failed {
        (
            "blocked",
            false,
            false,
            "Runner stopped without a completion report",
            "blocked",
            "Review why the execution runner stopped",
            "runner_blocked",
            "Execution runner stopped without evidence".to_string(),
            None,
            None,
        )
    } else if let Some(question) = founder_question {
        (
            "blocked",
            true,
            false,
            "Waiting for founder direction",
            "blocked",
            "Answer the agent’s decision request",
            "agent_waiting_for_founder",
            "Agent paused for a founder decision".to_string(),
            Some("question"),
            Some(question),
        )
    } else if pending_founder_direction {
        (
            "running",
            false,
            false,
            "Applying queued founder direction",
            "running",
            "Runner is applying your latest direction",
            "runner_progress_reported",
            "Runner reported progress before applying founder direction".to_string(),
            Some("report"),
            Some(bounded_agent_report(response)),
        )
    } else {
        (
            "completed",
            false,
            false,
            "Runner submitted evidence for verification",
            "verifying",
            "Review runner evidence before marking complete",
            "runner_completed",
            "Execution runner finished; verification is ready".to_string(),
            Some("report"),
            Some(bounded_agent_report(response)),
        )
    };
    let _ = transaction.execute(
        "UPDATE octiqos.agent_runs \
         SET status = $2, waiting_for_founder = $3, pending_founder_direction = $4, \
             current_step = $5, updated_at = now() \
         WHERE id = $1::text::uuid",
        &[
            &run_id,
            &status,
            &waiting_for_founder,
            &pending_founder_direction,
            &current_step,
        ],
    );
    let _ = transaction.execute(
        "UPDATE octiqos.tasks SET stage = $2, next_step = $3, updated_at = now() WHERE id = $1::text::uuid",
        &[&task_id, &task_stage, &next_step],
    );
    let _ = transaction.execute(
        "INSERT INTO octiqos.mission_events (id, task_id, kind, message) VALUES ($1::text::uuid, $2::text::uuid, $3, $4)",
        &[&Uuid::new_v4().to_string(), &task_id, &event_kind, &event_message],
    );
    if let (Some(kind), Some(body)) = (message_kind, message_body) {
        let _ = transaction.execute(
            "INSERT INTO octiqos.task_messages (id, task_id, actor, kind, body) \
             VALUES ($1::text::uuid, $2::text::uuid, 'agent', $3, $4)",
            &[&Uuid::new_v4().to_string(), &task_id, &kind, &body],
        );
    }
    let _ = transaction.commit();
}

pub fn decide_approval_impl(approval_id: String, decision: String) -> Result<Value, String> {
    required_uuid(&approval_id, "Approval")?;
    if !matches!(decision.as_str(), "approved" | "declined") {
        return Err("A decision must be approved or declined.".into());
    }
    let mut client = connect()?;
    let mut transaction = client
        .transaction()
        .map_err(|_| query_error("start the approval decision"))?;
    let approval = transaction
        .query_opt(
            "SELECT task_id::text, subject FROM octiqos.approvals \
             WHERE id = $1::text::uuid AND decision = 'pending' FOR UPDATE",
            &[&approval_id],
        )
        .map_err(|_| query_error("read that approval"))?
        .ok_or_else(|| "That approval has already been resolved.".to_string())?;
    let task_id: String = approval.get("task_id");
    let subject: String = approval.get("subject");
    let (stage, next_step, event_kind, event_message) = if decision == "approved" {
        (
            "approved",
            "Dispatcher may assign a runner",
            "approval_approved",
            format!("Approved: {subject}"),
        )
    } else {
        (
            "blocked",
            "Founder declined this direction",
            "approval_declined",
            format!("Declined: {subject}"),
        )
    };
    let event_id = Uuid::new_v4().to_string();
    transaction
        .execute(
            "UPDATE octiqos.approvals SET decision = $2, decided_at = now() \
             WHERE id = $1::text::uuid AND decision = 'pending'",
            &[&approval_id, &decision],
        )
        .map_err(|_| query_error("save the approval decision"))?;
    transaction
        .execute(
            "UPDATE octiqos.tasks SET stage = $2, next_step = $3, updated_at = now() \
             WHERE id = $1::text::uuid",
            &[&task_id, &stage, &next_step],
        )
        .map_err(|_| query_error("update the task state"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.mission_events (id, task_id, kind, message) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4)",
            &[&event_id, &task_id, &event_kind, &event_message],
        )
        .map_err(|_| query_error("record the approval decision"))?;
    transaction
        .commit()
        .map_err(|_| query_error("finish the approval decision"))?;
    dashboard_value(&mut client)
}

pub fn begin_verification_impl(run_id: String) -> Result<Value, String> {
    required_uuid(&run_id, "Run")?;
    let mut client = connect()?;
    let mut transaction = client
        .transaction()
        .map_err(|_| query_error("start verification"))?;
    let run = transaction
        .query_opt(
            "SELECT runs.task_id::text, tasks.title \
             FROM octiqos.agent_runs AS runs \
             JOIN octiqos.tasks AS tasks ON tasks.id = runs.task_id \
             WHERE runs.id = $1::text::uuid AND runs.status IN ('queued', 'running') FOR UPDATE",
            &[&run_id],
        )
        .map_err(|_| query_error("read that agent run"))?
        .ok_or_else(|| "This run is no longer waiting for verification.".to_string())?;
    let task_id: String = run.get("task_id");
    let title: String = run.get("title");
    let event_id = Uuid::new_v4().to_string();
    let event_message = format!("Verification started: {title}");
    transaction
        .execute(
            "UPDATE octiqos.agent_runs \
             SET status = 'verifying', current_step = 'Independent verifier is checking evidence', updated_at = now() \
             WHERE id = $1::text::uuid",
            &[&run_id],
        )
        .map_err(|_| query_error("start evidence verification"))?;
    transaction
        .execute(
            "UPDATE octiqos.tasks \
             SET stage = 'verifying', next_step = 'Review test and diff evidence', updated_at = now() \
             WHERE id = $1::text::uuid",
            &[&task_id],
        )
        .map_err(|_| query_error("update the task for verification"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.mission_events (id, task_id, kind, message) \
             VALUES ($1::text::uuid, $2::text::uuid, 'verification_started', $3)",
            &[&event_id, &task_id, &event_message],
        )
        .map_err(|_| query_error("record verification"))?;
    transaction
        .commit()
        .map_err(|_| query_error("finish verification"))?;
    dashboard_value(&mut client)
}

/// Closing verification is a founder decision. The note becomes part of the
/// append-only task history, then the active work cycle becomes complete.
pub fn complete_verification_impl(task_id: String, evidence: String) -> Result<Value, String> {
    required_uuid(&task_id, "Task")?;
    let evidence = clean_lifecycle_note(evidence, "A verification note")?;
    let event_id = Uuid::new_v4().to_string();
    let mut client = connect()?;
    let mut transaction = client
        .transaction()
        .map_err(|_| query_error("start verification closeout"))?;
    let task = transaction
        .query_opt(
            "SELECT title FROM octiqos.tasks \
             WHERE id = $1::text::uuid AND stage = 'verifying' FOR UPDATE",
            &[&task_id],
        )
        .map_err(|_| query_error("read the task for verification closeout"))?
        .ok_or_else(|| "Only a task currently in verification can be marked done.".to_string())?;
    let title: String = task.get("title");
    transaction
        .execute(
            "UPDATE octiqos.agent_runs \
             SET status = 'completed', current_step = 'Verification accepted by founder', updated_at = now() \
             WHERE task_id = $1::text::uuid AND status = 'verifying'",
            &[&task_id],
        )
        .map_err(|_| query_error("complete the active verification run"))?;
    transaction
        .execute(
            "UPDATE octiqos.task_cycles SET status = 'completed', closed_at = now() \
             WHERE task_id = $1::text::uuid AND status = 'active'",
            &[&task_id],
        )
        .map_err(|_| query_error("close the completed task cycle"))?;
    transaction
        .execute(
            "UPDATE octiqos.tasks \
             SET stage = 'done', next_step = 'Completed — reopen with a new instruction if follow-up work is needed', updated_at = now() \
             WHERE id = $1::text::uuid",
            &[&task_id],
        )
        .map_err(|_| query_error("mark the task done"))?;
    transaction
        .execute(
            "INSERT INTO octiqos.mission_events (id, task_id, kind, message) \
             VALUES ($1::text::uuid, $2::text::uuid, 'verification_completed', $3)",
            &[
                &event_id,
                &task_id,
                &format!("Verification accepted for {title}: {evidence}"),
            ],
        )
        .map_err(|_| query_error("record verification closeout"))?;
    transaction
        .commit()
        .map_err(|_| query_error("finish verification closeout"))?;
    dashboard_value(&mut client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_intake_rejects_an_unrecognised_domain() {
        assert!(clean_task(
            "Review a pull request".into(),
            None,
            "external".into(),
            None
        )
        .is_err());
    }

    #[test]
    fn task_intake_trims_empty_context() {
        let (_, detail, _, _) = clean_task(
            "Review a pull request".into(),
            Some("   ".into()),
            "company".into(),
            None,
        )
        .unwrap();
        assert_eq!(detail, None);
    }

    #[test]
    fn verification_note_needs_meaningful_evidence() {
        assert!(clean_lifecycle_note("  ".into(), "A verification note").is_err());
        assert_eq!(
            clean_lifecycle_note("Tests and review passed".into(), "A verification note").unwrap(),
            "Tests and review passed"
        );
    }

    #[test]
    fn founder_direction_is_bounded_and_agent_questions_are_explicit() {
        assert_eq!(
            clean_founder_direction("Keep the change behind staging only.".into()).unwrap(),
            "Keep the change behind staging only."
        );
        assert!(clean_founder_direction("  ".into()).is_err());
        assert_eq!(
            agent_question_from_response("Progress report\nNEEDS FOUNDER DECISION: Deploy only to staging?\n"),
            Some("Deploy only to staging?".into())
        );
        assert_eq!(agent_question_from_response("I can continue safely."), None);
    }

    #[test]
    fn workflow_policy_rejects_unavailable_adapter_names() {
        assert!(clean_policy_list(
            vec!["unknown-agent".into()],
            &["codex", "claude"],
            "runner",
            true,
        )
        .is_err());
        assert_eq!(
            clean_policy_list(
                vec!["claude".into(), "codex".into(), "claude".into()],
                &["codex", "claude"],
                "runner",
                true,
            )
            .unwrap(),
            vec!["claude", "codex"]
        );
    }

    #[test]
    fn personal_policy_keeps_the_financial_safety_envelope() {
        let (_, approval_requirements, _) = policy_options("personal").unwrap();
        assert_eq!(
            approval_requirements,
            &["financial-change", "payment", "delete", "nas-write"]
        );
    }

    #[test]
    fn connector_input_is_bounded_and_only_uses_declared_source_kinds() {
        assert_eq!(clean_connector_source(" Ticket ".into()).unwrap(), "ticket");
        assert!(clean_connector_source("manual".into()).is_err());
        assert_eq!(
            clean_connector_reference("workspace:ticket-42".into()).unwrap(),
            "workspace:ticket-42"
        );
        assert!(clean_connector_reference("\n".into()).is_err());
    }

    /// A local opt-in smoke test for the real schema. CI and ordinary unit
    /// runs have no database, so they deliberately skip it; the migration
    /// workflow supplies DATABASE_URL and proves this module can read the
    /// namespaced operational store end-to-end.
    #[test]
    fn configured_store_reads_the_migrated_schema() {
        if std::env::var("DATABASE_URL").is_err() {
            return;
        }
        let payload = dashboard_impl().expect("migrated OctiqOS store should be readable");
        assert!(payload.get("summary").is_some());
        assert!(payload.get("tasks").is_some());
    }
}

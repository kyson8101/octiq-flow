//! Agents mode: the person's registered agents and their org chart.
//!
//! An agent here is a named, role-bearing preset — provider, model, effort and
//! access — that a task can be handed to. It lives globally (every project sees
//! it) or in one project, and it may report to another agent. An agent with no
//! manager reports to the person.
//!
//! Handing a task to one makes that chat its LEAD. The lead does the work
//! itself, or opens an ordinary orchestration run and assigns tasks to its
//! DIRECT REPORTS. A report that manages agents of its own may split its task
//! once more among them. That is three levels — lead, manager, worker — and no
//! deeper. The host enforces every edge of it: an assignee is resolved and
//! checked here, never taken from the agent's word, so a lead cannot misquote a
//! teammate's model or reach past its own reports.
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::agent_chat::{Access, ChatAgent};

/// The line that separates the person's task from the brief the lead is given.
/// The client draws only what comes before it (lib/taskBrief.ts).
pub const BRIEF_MARK: &str = "\n\n=== OctiqFlow agents mode ===\n";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamAgent {
    pub id: String,
    pub name: String,
    pub role: String,
    pub agent: ChatAgent,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub access: Access,
    /// `None` is a global agent; otherwise the project it belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// The agent this one reports to; `None` reports to the person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reports_to: Option<String>,
    /// Its memory note, relative to the Memory Vault. Fixed when first
    /// assigned, so renaming an agent does not orphan what it remembers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl TeamAgent {
    /// Fable and Astra only lead: orchestration rejects them as workers.
    pub fn can_work(&self) -> bool {
        let model = self.model.to_ascii_lowercase();
        !(model.contains("fable") || model.contains("astra"))
    }

    fn visible_in(&self, project_id: Option<&str>) -> bool {
        self.project_id.is_none() || self.project_id.as_deref() == project_id
    }
}

/// What the browser sends to add or change one agent.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamDraft {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub role: String,
    pub agent: ChatAgent,
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub access: Option<Access>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub reports_to: Option<String>,
}

/// A chat a task was handed to: the host needs it to know that a run the chat
/// opens is an agents-mode run (its plan waits for the person, and it may only
/// assign to the lead's reports), and the dashboard lists it under the lead.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeadRecord {
    pub chat_key: String,
    pub lead_id: String,
    pub lead_name: String,
    pub project_id: String,
    pub created_at: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    agents: Vec<TeamAgent>,
    #[serde(default)]
    leads: Vec<LeadRecord>,
}

/// Serializes read-modify-write of the file; the store is small enough to be
/// read whole on every call.
static LOCK: Mutex<()> = Mutex::new(());

pub fn default_path() -> PathBuf {
    crate::profile::profile_dir().join("team.json")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read(path: &Path) -> Result<Stored, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Saved agents could not be read: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Stored::default()),
        Err(e) => Err(format!("Saved agents could not be read: {e}")),
    }
}

fn write(path: &Path, stored: &Stored) -> Result<(), String> {
    let dir = path.parent().ok_or("Agents have no storage directory")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(stored).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".team-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Every agent (`project_id: None, all: true`), or the ones a project sees:
/// the global agents plus its own.
pub fn list(path: &Path, project_id: Option<&str>, all: bool) -> Result<Vec<TeamAgent>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    // Agents registered before memory existed get their note now, once.
    if assign_memory_notes(&mut stored.agents) {
        write(path, &stored)?;
    }
    let mut agents = stored.agents;
    if !all {
        agents.retain(|a| a.visible_in(project_id));
    }
    Ok(agents)
}

fn clean(text: &str, what: &str, max: usize, required: bool) -> Result<String, String> {
    let text = text.trim();
    if required && text.is_empty() {
        return Err(format!("Give the agent a {what}."));
    }
    if text.chars().count() > max {
        return Err(format!(
            "The agent's {what} is longer than {max} characters."
        ));
    }
    Ok(text.to_owned())
}

/// A manager must be visible wherever its report is: a global agent reports to
/// a global one; a project agent to a global one or one in the same project.
fn can_report_to(report_project: Option<&str>, manager_project: Option<&str>) -> bool {
    manager_project.is_none() || manager_project == report_project
}

pub fn save(path: &Path, draft: TeamDraft) -> Result<TeamAgent, String> {
    let name = clean(&draft.name, "name", 60, true)?;
    let role = clean(&draft.role, "role", 2000, false)?;
    if draft.agent == ChatAgent::Pi {
        return Err("Choose Claude or Codex for a registered agent.".into());
    }
    let model = draft.model.trim().to_owned();
    if model.is_empty() || model == "default" || crate::agent_provider::safe_model(&model).is_none()
    {
        return Err("Choose an explicit model for the agent.".into());
    }
    let effort = draft
        .effort
        .map(|e| e.trim().to_owned())
        .filter(|e| !e.is_empty());
    if let Some(effort) = &effort {
        if !effort.chars().all(|c| c.is_ascii_alphanumeric()) || effort.len() > 16 {
            return Err("That effort level is not valid.".into());
        }
    }
    let project_id = draft.project_id.filter(|p| !p.trim().is_empty());
    let reports_to = draft.reports_to.filter(|m| !m.trim().is_empty());
    let access = draft.access.unwrap_or(Access::Auto);

    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    let id = draft.id.filter(|id| !id.is_empty());
    // A global name is seen everywhere; a project name alongside every global
    // one. Either way two agents a lead can see must not share a name.
    let clash = stored.agents.iter().any(|other| {
        Some(&other.id) != id.as_ref()
            && other.name.eq_ignore_ascii_case(&name)
            && (other.project_id.is_none()
                || project_id.is_none()
                || other.project_id == project_id)
    });
    if clash {
        return Err(format!("Another agent is already called {name}."));
    }
    if let Some(manager_id) = &reports_to {
        if Some(manager_id) == id.as_ref() {
            return Err("An agent cannot report to itself.".into());
        }
        let manager = stored
            .agents
            .iter()
            .find(|a| &a.id == manager_id)
            .ok_or("The chosen manager no longer exists.")?;
        if !can_report_to(project_id.as_deref(), manager.project_id.as_deref()) {
            return Err(format!(
                "{name} cannot report to {}: that agent is not available everywhere {name} is.",
                manager.name
            ));
        }
        // Walk up from the manager; meeting this agent means a loop.
        if let Some(me) = &id {
            let mut at = Some(manager_id.clone());
            let mut steps = 0;
            while let Some(current) = at {
                if &current == me {
                    return Err(format!(
                        "{name} cannot report to {}: that agent already reports to {name}.",
                        manager.name
                    ));
                }
                steps += 1;
                if steps > stored.agents.len() {
                    break;
                }
                at = stored
                    .agents
                    .iter()
                    .find(|a| a.id == current)
                    .and_then(|a| a.reports_to.clone());
            }
        }
    }
    if let Some(me) = &id {
        // Moving an agent into one project must not strand a report that is
        // visible somewhere the manager no longer is.
        if let Some(report) = stored.agents.iter().find(|a| {
            a.reports_to.as_deref() == Some(me.as_str())
                && !can_report_to(a.project_id.as_deref(), project_id.as_deref())
        }) {
            return Err(format!(
                "{} reports to {name} and is available in more places. Move {} first.",
                report.name, report.name
            ));
        }
    }
    let now = now_ms();
    let saved = match id {
        Some(id) => {
            let existing = stored
                .agents
                .iter_mut()
                .find(|a| a.id == id)
                .ok_or("That agent no longer exists.")?;
            *existing = TeamAgent {
                id: existing.id.clone(),
                name,
                role,
                agent: draft.agent,
                model,
                effort,
                access,
                project_id,
                reports_to,
                memory_note: existing.memory_note.clone(),
                created_at: existing.created_at,
                updated_at: now,
            };
            existing.clone()
        }
        None => {
            let agent = TeamAgent {
                id: format!("agent_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
                name,
                role,
                agent: draft.agent,
                model,
                effort,
                access,
                project_id,
                reports_to,
                memory_note: None,
                created_at: now,
                updated_at: now,
            };
            stored.agents.push(agent);
            stored
                .agents
                .last()
                .cloned()
                .ok_or("The agent was not saved.")?
        }
    };
    assign_memory_notes(&mut stored.agents);
    let saved = stored
        .agents
        .iter()
        .find(|a| a.id == saved.id)
        .cloned()
        .unwrap_or(saved);
    write(path, &stored)?;
    Ok(saved)
}

/// Remove one agent. Its reports move up to its own manager, so the chart
/// never points at someone who is gone.
pub fn delete(path: &Path, id: &str) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    let gone = stored
        .agents
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .ok_or("That agent no longer exists.")?;
    stored.agents.retain(|a| a.id != id);
    for agent in &mut stored.agents {
        if agent.reports_to.as_deref() == Some(id) {
            agent.reports_to = gone.reports_to.clone();
        }
    }
    write(path, &stored)
}

/// Remember that `chat_key` was handed a task with `lead_id` as its lead.
pub fn record_lead(
    path: &Path,
    chat_key: &str,
    lead: &TeamAgent,
    project_id: &str,
) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    stored.leads.retain(|record| record.chat_key != chat_key);
    stored.leads.push(LeadRecord {
        chat_key: chat_key.to_owned(),
        lead_id: lead.id.clone(),
        lead_name: lead.name.clone(),
        project_id: project_id.to_owned(),
        created_at: now_ms(),
    });
    write(path, &stored)
}

pub fn leads(path: &Path) -> Result<Vec<LeadRecord>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    Ok(read(path)?.leads)
}

/// The lead record for a chat, when that chat is an agents-mode task.
pub fn lead_for_chat(path: &Path, chat_key: &str) -> Result<Option<LeadRecord>, String> {
    Ok(leads(path)?
        .into_iter()
        .find(|record| record.chat_key == chat_key))
}

/// The registered agent named as a task's assignee, by id or by exact
/// (case-insensitive) name, among those the run's project can see. With a
/// `manager`, the assignee must report directly to it.
pub fn resolve(
    path: &Path,
    project_id: &str,
    who: &str,
    manager: Option<&str>,
) -> Result<TeamAgent, String> {
    let who = who.trim();
    let visible = list(path, Some(project_id), false)?;
    let found = visible
        .iter()
        .find(|a| a.id == who)
        .or_else(|| visible.iter().find(|a| a.name.eq_ignore_ascii_case(who)))
        .cloned()
        .ok_or_else(|| {
            format!("No registered agent called {who} in this project. Assign to one of the agents listed in your brief.")
        })?;
    if let Some(manager) = manager {
        if found.reports_to.as_deref() != Some(manager) {
            let reports = direct_reports(&visible, manager)
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>();
            return Err(if reports.is_empty() {
                format!(
                    "{} does not report to you, and no one does. Do the task yourself.",
                    found.name
                )
            } else {
                format!(
                    "{} does not report to you. You can assign only to your direct reports: {}.",
                    found.name,
                    reports.join(", ")
                )
            });
        }
    }
    if !found.can_work() {
        return Err(format!(
            "{} runs on a lead-only model and cannot take a task. Assign someone else, or do it yourself.",
            found.name
        ));
    }
    Ok(found)
}

/// Where agents' memory notes live in the vault. The vault's own schema
/// reserves `agent-zone/agents/` for the named agent roster.
pub const MEMORY_DIR: &str = "agent-zone/agents";

fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_owned();
    if out.is_empty() {
        "agent".into()
    } else {
        out
    }
}

/// Give every agent without a memory note one, unique among them. Answers
/// whether anything changed.
fn assign_memory_notes(agents: &mut [TeamAgent]) -> bool {
    let mut changed = false;
    for i in 0..agents.len() {
        if agents[i].memory_note.is_some() {
            continue;
        }
        let base = slug(&agents[i].name);
        let taken = |candidate: &str, agents: &[TeamAgent]| {
            agents
                .iter()
                .any(|a| a.memory_note.as_deref() == Some(candidate))
        };
        let mut note = format!("{MEMORY_DIR}/{base}/memory.md");
        if taken(&note, agents) {
            let tail = agents[i].id.trim_start_matches("agent_");
            note = format!(
                "{MEMORY_DIR}/{base}-{}/memory.md",
                &tail[..tail.len().min(6)]
            );
        }
        agents[i].memory_note = Some(note);
        changed = true;
    }
    changed
}

/// The first contents of an agent's memory note.
pub fn memory_seed(agent: &TeamAgent) -> String {
    format!(
        "---\ntype: agent-memory\nagent: {name}\nagent-id: {id}\n---\n\n# {name} — memory\n\nWorking memory for {name}, a registered OctiqFlow agent. It holds only what is worth keeping between tasks: decisions and why, gotchas, how things work, and what to pick up next. Entries are dated and appended; none is rewritten.\n",
        name = agent.name,
        id = agent.id,
    )
}

/// How an agent's memory is described in its brief.
pub fn memory_brief(agent: &TeamAgent, team: &[TeamAgent]) -> String {
    let reports = direct_reports(team, &agent.id);
    let managers = if reports.is_empty() {
        String::new()
    } else {
        format!(
            " You may also read your direct reports' memories by passing their name as `agent`: {}.",
            reports.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
        )
    };
    format!(
        "You have your own working memory in the shared Memory Vault. Before starting, call vault_agent_memory_read to load it. Record only what your future self would need, with one short entry through vault_agent_memory_append: a decision and why, a gotcha, how something works, or what to pick up next. Do not log routine steps, restate the diff, or copy the task. Pass today's local date as `date`.{managers}"
    )
}

/// The civil date (UTC) for a Unix time in milliseconds, as YYYY-MM-DD.
pub fn utc_date(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

pub fn today() -> String {
    utc_date(now_ms())
}

/// The registered agent behind a chat: the lead a task was handed to, or the
/// assignee of the task a worker chat is running (`worker_assignee`, looked up
/// by the caller from orchestration). Never taken from tool arguments.
pub fn identity(
    path: &Path,
    chat_key: &str,
    worker_assignee: Option<String>,
) -> Result<(TeamAgent, Vec<TeamAgent>), String> {
    let id = match lead_for_chat(path, chat_key)? {
        Some(record) => record.lead_id,
        None => worker_assignee.ok_or(
            "Only a registered agent's chat has an agent memory. This chat is neither a task lead nor an assigned worker.",
        )?,
    };
    let team = list(path, None, true)?;
    let me = team
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .ok_or("Your registered agent no longer exists.")?;
    Ok((me, team))
}

fn note_of(agent: &TeamAgent) -> Result<&str, String> {
    agent
        .memory_note
        .as_deref()
        .ok_or_else(|| format!("{} has no memory note yet.", agent.name))
}

/// Create an agent's memory note if it is missing. A vault that is not
/// connected or not writable is reported, not hidden.
pub fn ensure_memory(
    vault: &crate::memory_vault::Vault,
    actor: &str,
    agent: &TeamAgent,
) -> Result<(), String> {
    let path = note_of(agent)?;
    let exists = vault
        .call(
            actor,
            "read",
            &serde_json::json!({ "path": path, "lineCount": 1 }),
        )
        .is_ok();
    if exists {
        return Ok(());
    }
    let receipt = vault.call(
        actor,
        "write",
        &serde_json::json!({
            "path": path,
            "content": memory_seed(agent),
            "mode": "create",
            "requestId": format!("agent-memory-seed-{}", agent.id),
        }),
    )?;
    saved(receipt)
}

fn saved(receipt: serde_json::Value) -> Result<(), String> {
    match receipt.get("status").and_then(|s| s.as_str()) {
        Some("saved") | None => Ok(()),
        Some(other) => Err(format!("The memory write was not confirmed ({other}).")),
    }
}

/// Read one agent's memory: your own, or a direct report's when `who` names one.
pub fn memory_read(
    vault: &crate::memory_vault::Vault,
    actor: &str,
    me: &TeamAgent,
    team: &[TeamAgent],
    who: Option<&str>,
    start_line: Option<u64>,
) -> Result<serde_json::Value, String> {
    let target = match who.map(str::trim).filter(|w| !w.is_empty()) {
        None => me,
        Some(who) => {
            let found = team
                .iter()
                .find(|a| a.id == who || a.name.eq_ignore_ascii_case(who))
                .ok_or_else(|| format!("No registered agent called {who}."))?;
            if found.id != me.id && found.reports_to.as_deref() != Some(me.id.as_str()) {
                return Err(format!(
                    "{} does not report to you. You can read only your own memory and your direct reports'.",
                    found.name
                ));
            }
            found
        }
    };
    let path = note_of(target)?;
    let mut args = serde_json::json!({ "path": path });
    if let Some(line) = start_line {
        args["startLine"] = line.into();
    }
    match vault.call(actor, "read", &args) {
        Ok(mut note) => {
            note["agent"] = target.name.clone().into();
            Ok(note)
        }
        Err(error) if error.contains("No such file") || error.contains("not found") => {
            Ok(serde_json::json!({
                "agent": target.name, "path": path, "content": "", "empty": true,
            }))
        }
        Err(error) => Err(error),
    }
}

/// Append one dated entry to your own memory.
pub fn memory_append(
    vault: &crate::memory_vault::Vault,
    actor: &str,
    me: &TeamAgent,
    text: &str,
    date: Option<&str>,
    request_id: &str,
) -> Result<serde_json::Value, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Write what is worth remembering.".into());
    }
    if text.chars().count() > 4000 {
        return Err("Keep a memory entry under 4000 characters; record the essence.".into());
    }
    let date = match date.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d)
            if d.len() == 10
                && d.chars().enumerate().all(|(i, c)| {
                    if i == 4 || i == 7 {
                        c == '-'
                    } else {
                        c.is_ascii_digit()
                    }
                }) =>
        {
            d.to_owned()
        }
        Some(_) => return Err("Pass the date as YYYY-MM-DD.".into()),
        None => today(),
    };
    ensure_memory(vault, actor, me)?;
    let path = note_of(me)?;
    let current = vault.call(
        actor,
        "read",
        &serde_json::json!({ "path": path, "lineCount": 1 }),
    )?;
    let revision = current
        .get("revision")
        .and_then(|r| r.as_str())
        .ok_or("Could not read the memory note's revision.")?
        .to_owned();
    let receipt = vault.call(
        actor,
        "write",
        &serde_json::json!({
            "path": path,
            "mode": "append",
            "content": format!("\n## {date}\n\n{text}\n"),
            "expectedRevision": revision,
            "requestId": request_id,
        }),
    )?;
    saved(receipt.clone())?;
    Ok(serde_json::json!({ "agent": me.name, "path": path, "receipt": receipt }))
}

fn direct_reports<'a>(team: &'a [TeamAgent], manager: &str) -> Vec<&'a TeamAgent> {
    team.iter()
        .filter(|a| a.reports_to.as_deref() == Some(manager))
        .collect()
}

fn describe(agent: &TeamAgent, team: &[TeamAgent], may_split: bool) -> String {
    let provider = match agent.agent {
        ChatAgent::Claude => "Claude",
        ChatAgent::Codex => "Codex",
        ChatAgent::Pi => "pi",
    };
    let effort = agent
        .effort
        .as_deref()
        .map(|e| format!(", effort {e}"))
        .unwrap_or_default();
    let role = if agent.role.is_empty() {
        "no role given".to_owned()
    } else {
        agent.role.replace('\n', " ")
    };
    let lead_only = if agent.can_work() {
        ""
    } else {
        " [lead only: cannot take tasks]"
    };
    let manages = direct_reports(team, &agent.id);
    let manages = if may_split && !manages.is_empty() {
        format!(
            " [manages {}; may split its task among them]",
            manages
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else {
        String::new()
    };
    format!(
        "- id `{}` · {} — {} · {provider} {}{effort}{lead_only}{manages}",
        agent.id, agent.name, role, agent.model
    )
}

/// The first message of a task: the person's words, then the lead's brief.
/// Records `chat_key` as this lead's task.
pub fn brief(
    path: &Path,
    chat_key: &str,
    project_id: &str,
    lead_id: &str,
    task: &str,
) -> Result<String, String> {
    let task = task.trim();
    if task.is_empty() {
        return Err("Describe the task first.".into());
    }
    let team = list(path, Some(project_id), false)?;
    let lead = team
        .iter()
        .find(|a| a.id == lead_id)
        .ok_or("The chosen agent no longer exists. Pick another one.")?;
    let role = if lead.role.is_empty() {
        String::new()
    } else {
        format!(" Your role: {}.", lead.role.replace('\n', " "))
    };
    let reports = direct_reports(&team, &lead.id);
    let head = format!(
        "{task}{BRIEF_MARK}Lead: {name}\n\nYou are {name}, a registered agent in this OctiqFlow project.{role} The person handed you the task above. You lead it.",
        name = lead.name
    );
    let text = if reports.is_empty() {
        format!("{head} No agent reports to you, so do the task yourself, directly in this chat. Do not create an orchestration run.")
    } else {
        let roster = reports
            .iter()
            .map(|a| describe(a, &team, true))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "{head} First decide which of these fits best, and say which one you chose and why in one or two sentences:\n\n\
1. Do it yourself: it fits your role and is one coherent piece of work. Do it directly in this chat. Do not create an orchestration run.\n\
2. Pass it on: one of your direct reports fits it clearly better. Delegate the whole task to them as one task.\n\
3. Split it: it has separable parts. Split it into tasks and give each to the best-suited direct report. You may keep a part for yourself and do it in this chat, but never write in a checkout a worker has.\n\n\
To pass on or split, call orchestration_run_create once with objective = the task, workspaceMode \"auto\" and workerDefaults {{\"access\": \"auto\"}}, then follow the masterBrief it returns. Create each task with orchestration_task_create and set `assignee` to the agent's id. The host applies that agent's provider, model, effort and access, so do not also pass `worker`. You can assign only to your direct reports, listed below; the host refuses anyone else. A report that manages agents of its own may split its task once more among them; nothing goes deeper than that.\n\n\
The person approves your plan before any worker starts. Create every task first, then reply with the plan as one short list (task, who, why) and end your turn. The host starts the workers once the person approves. If they ask for changes, adjust the plan and end your turn again. After that, the host tells you when work reports. When every task is complete, check the results and tell the person the outcome.\n\n\
Your direct reports:\n{roster}"
        )
    };
    record_lead(path, chat_key, lead, project_id)?;
    Ok(format!("{text}\n\n{}", memory_brief(lead, &team)))
}

/// Appended to a worker's brief when its assignee manages agents and the task
/// sits at the second level, so it may split once more. `None` otherwise.
pub fn manager_brief(
    path: &Path,
    project_id: &str,
    assignee_id: &str,
    task_id: &str,
    run_id: &str,
) -> Result<Option<String>, String> {
    let team = list(path, Some(project_id), false)?;
    let reports = direct_reports(&team, assignee_id);
    if reports.is_empty() {
        return Ok(None);
    }
    let roster = reports
        .iter()
        .map(|a| describe(a, &team, false))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(Some(format!(
        "You manage agents in OctiqFlow's org chart. If this task is one coherent piece of work you can do, do it yourself. If it has separable parts that your reports fit better, split it: call orchestration_task_create with runId '{run_id}', parentTaskId '{task_id}', and `assignee` set to a direct report's id, once per part. Do not pass `worker`; the host applies the agent's settings. Subtasks start without further approval and cannot be split again. After creating the subtasks, call orchestration_worker_report with outcome completed and a summary of the split. The host makes anything that waits on your task wait for your subtasks too.\n\nYour direct reports:\n{roster}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(name: &str, project: Option<&str>) -> TeamDraft {
        TeamDraft {
            id: None,
            name: name.into(),
            role: "builds things".into(),
            agent: ChatAgent::Claude,
            model: "sonnet".into(),
            effort: Some("high".into()),
            access: None,
            project_id: project.map(Into::into),
            reports_to: None,
        }
    }

    fn under(name: &str, project: Option<&str>, manager: &TeamAgent) -> TeamDraft {
        TeamDraft {
            reports_to: Some(manager.id.clone()),
            ..draft(name, project)
        }
    }

    fn temp() -> PathBuf {
        std::env::temp_dir()
            .join(format!("octiq-team-{}", uuid::Uuid::new_v4()))
            .join("team.json")
    }

    #[test]
    fn project_sees_global_and_its_own_agents_only() {
        let path = temp();
        save(&path, draft("Ada", None)).unwrap();
        save(&path, draft("Bo", Some("p1"))).unwrap();
        save(&path, draft("Cy", Some("p2"))).unwrap();
        let names = |p| {
            list(&path, Some(p), false)
                .unwrap()
                .into_iter()
                .map(|a| a.name)
                .collect::<Vec<_>>()
        };
        assert_eq!(names("p1"), ["Ada", "Bo"]);
        assert_eq!(names("p2"), ["Ada", "Cy"]);
        assert_eq!(list(&path, None, true).unwrap().len(), 3);
    }

    #[test]
    fn visible_names_must_be_unique() {
        let path = temp();
        save(&path, draft("Ada", None)).unwrap();
        assert!(save(&path, draft("ada", Some("p1"))).is_err());
        save(&path, draft("Bo", Some("p1"))).unwrap();
        // Different projects never see each other.
        save(&path, draft("Bo", Some("p2"))).unwrap();
        // A global Bo would collide with both.
        assert!(save(&path, draft("Bo", None)).is_err());
    }

    #[test]
    fn edit_keeps_id_and_creation_time() {
        let path = temp();
        let first = save(&path, draft("Ada", None)).unwrap();
        let mut change = draft("Ada Lovelace", None);
        change.id = Some(first.id.clone());
        let second = save(&path, change).unwrap();
        assert_eq!(second.id, first.id);
        assert_eq!(second.created_at, first.created_at);
        assert_eq!(list(&path, None, true).unwrap().len(), 1);
        delete(&path, &first.id).unwrap();
        assert!(list(&path, None, true).unwrap().is_empty());
    }

    #[test]
    fn chart_refuses_loops_and_managers_that_are_not_visible() {
        let path = temp();
        let ceo = save(&path, draft("Ceo", None)).unwrap();
        let cto = save(&path, under("Cto", None, &ceo)).unwrap();
        // The CEO cannot report to someone who reports to it.
        let mut looped = under("Ceo", None, &cto);
        looped.id = Some(ceo.id.clone());
        assert!(save(&path, looped).unwrap_err().contains("already reports"));
        // A global agent cannot report to a project agent.
        let local = save(&path, draft("Local", Some("p1"))).unwrap();
        assert!(save(&path, under("Wide", None, &local)).is_err());
        // A project agent may report to a global one.
        save(&path, under("Dev", Some("p1"), &cto)).unwrap();
        // The CTO cannot move into p2 while a p1 agent reports to it.
        let mut moved = under("Cto", Some("p2"), &ceo);
        moved.id = Some(cto.id.clone());
        assert!(save(&path, moved).is_err());
    }

    #[test]
    fn deleting_a_manager_moves_its_reports_up() {
        let path = temp();
        let ceo = save(&path, draft("Ceo", None)).unwrap();
        let cto = save(&path, under("Cto", None, &ceo)).unwrap();
        let dev = save(&path, under("Dev", None, &cto)).unwrap();
        delete(&path, &cto.id).unwrap();
        let dev = list(&path, None, true)
            .unwrap()
            .into_iter()
            .find(|a| a.id == dev.id)
            .unwrap();
        assert_eq!(dev.reports_to.as_deref(), Some(ceo.id.as_str()));
    }

    #[test]
    fn resolve_enforces_direct_reports_and_lead_only_models() {
        let path = temp();
        let ceo = save(&path, draft("Ceo", None)).unwrap();
        let ada = save(&path, under("Ada", None, &ceo)).unwrap();
        let dev = save(&path, under("Dev", None, &ada)).unwrap();
        let mut boss = under("Boss", None, &ceo);
        boss.model = "fable".into();
        save(&path, boss).unwrap();
        assert_eq!(
            resolve(&path, "p1", &ada.id, Some(&ceo.id)).unwrap().name,
            "Ada"
        );
        assert_eq!(
            resolve(&path, "p1", "ADA", Some(&ceo.id)).unwrap().id,
            ada.id
        );
        // Two levels down is not a direct report.
        assert!(resolve(&path, "p1", &dev.id, Some(&ceo.id))
            .unwrap_err()
            .contains("direct reports: Ada, Boss"));
        assert!(resolve(&path, "p1", "Boss", Some(&ceo.id))
            .unwrap_err()
            .contains("lead-only"));
        assert!(resolve(&path, "p1", "nobody", None).is_err());
        // Without a manager (ordinary orchestration) any agent may be named.
        assert_eq!(resolve(&path, "p1", &dev.id, None).unwrap().name, "Dev");
    }

    #[test]
    fn rejects_pi_and_default_models() {
        let path = temp();
        let mut pi = draft("Pi", None);
        pi.agent = ChatAgent::Pi;
        assert!(save(&path, pi).is_err());
        let mut default = draft("D", None);
        default.model = "default".into();
        assert!(save(&path, default).is_err());
    }

    #[test]
    fn brief_lists_only_direct_reports_and_records_the_lead() {
        let path = temp();
        let ceo = save(&path, draft("Ceo", None)).unwrap();
        let ada = save(&path, under("Ada", None, &ceo)).unwrap();
        save(&path, under("Dev", None, &ada)).unwrap();
        save(&path, draft("Zed", Some("p2"))).unwrap();
        let text = brief(&path, "chat:1", "p1", &ceo.id, "  Fix the login bug  ").unwrap();
        let (task, rest) = text.split_once(BRIEF_MARK).unwrap();
        assert_eq!(task, "Fix the login bug");
        assert!(rest.starts_with("Lead: Ceo\n"));
        assert!(rest.contains(&format!("id `{}`", ada.id)));
        assert!(rest.contains("manages Dev"));
        assert!(rest.contains("approves your plan"));
        // Dev is Ada's report, not the lead's: only Ada is assignable.
        assert_eq!(rest.matches("id `").count(), 1);
        assert!(!rest.contains("Zed"));
        let record = lead_for_chat(&path, "chat:1").unwrap().unwrap();
        assert_eq!(record.lead_id, ceo.id);
    }

    #[test]
    fn a_lead_with_no_reports_does_it_itself() {
        let path = temp();
        let solo = save(&path, draft("Solo", None)).unwrap();
        let text = brief(&path, "chat:2", "p1", &solo.id, "Tidy the README").unwrap();
        assert!(text.contains("do the task yourself"));
        assert!(!text.contains("orchestration_task_create"));
    }

    #[test]
    fn manager_brief_only_for_agents_with_reports() {
        let path = temp();
        let ada = save(&path, draft("Ada", None)).unwrap();
        let dev = save(&path, under("Dev", None, &ada)).unwrap();
        let text = manager_brief(&path, "p1", &ada.id, "task_1", "run_1")
            .unwrap()
            .unwrap();
        assert!(text.contains("parentTaskId 'task_1'"));
        assert!(text.contains(&dev.id));
        assert!(manager_brief(&path, "p1", &dev.id, "task_2", "run_1")
            .unwrap()
            .is_none());
    }

    #[test]
    fn every_agent_gets_one_stable_memory_note() {
        let path = temp();
        let ryan = save(&path, draft("Ryan Lee", None)).unwrap();
        assert_eq!(
            ryan.memory_note.as_deref(),
            Some("agent-zone/agents/ryan-lee/memory.md")
        );
        // Two agents in different projects may share a name, not a note.
        let one = save(&path, draft("Kai", Some("p1"))).unwrap();
        let two = save(&path, draft("Kai", Some("p2"))).unwrap();
        assert_ne!(one.memory_note, two.memory_note);
        // A rename keeps what the agent remembers.
        let mut renamed = draft("Ryan", None);
        renamed.id = Some(ryan.id.clone());
        let renamed = save(&path, renamed).unwrap();
        assert_eq!(renamed.memory_note, ryan.memory_note);
    }

    #[test]
    fn dates_are_civil_utc() {
        assert_eq!(utc_date(0), "1970-01-01");
        assert_eq!(utc_date(951_782_400_000), "2000-02-29");
        assert_eq!(utc_date(1_790_294_400_000), "2026-09-25");
    }

    #[test]
    fn identity_comes_from_the_chat_and_reads_stop_at_direct_reports() {
        let path = temp();
        let ceo = save(&path, draft("Ceo", None)).unwrap();
        let ada = save(&path, under("Ada", None, &ceo)).unwrap();
        let dev = save(&path, under("Dev", None, &ada)).unwrap();
        brief(&path, "chat:lead", "p1", &ceo.id, "Do it").unwrap();
        assert_eq!(identity(&path, "chat:lead", None).unwrap().0.id, ceo.id);
        assert_eq!(
            identity(&path, "chat:worker", Some(dev.id.clone()))
                .unwrap()
                .0
                .id,
            dev.id
        );
        assert!(identity(&path, "chat:stranger", None).is_err());

        let (me, team) = identity(&path, "chat:lead", None).unwrap();
        let vault = crate::memory_vault::Vault::profile();
        // Two levels down is not a direct report; refused before the vault.
        assert!(
            memory_read(&vault, "chat:lead", &me, &team, Some("Dev"), None)
                .unwrap_err()
                .contains("does not report to you")
        );
    }

    #[test]
    fn briefs_carry_the_memory_instructions() {
        let path = temp();
        let ceo = save(&path, draft("Ceo", None)).unwrap();
        save(&path, under("Ada", None, &ceo)).unwrap();
        let text = brief(&path, "chat:1", "p1", &ceo.id, "Ship it").unwrap();
        assert!(text.contains("vault_agent_memory_read"));
        assert!(text.contains("direct reports' memories"));
        assert!(text.contains("Ada"));
    }
}

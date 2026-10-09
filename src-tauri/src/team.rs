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
    /// Its picture, as a checked PNG/JPEG/WebP `data:` URL
    /// (`agent_avatar::checked_data_url`). Absent: the client draws initials.
    /// Kept on the agent, so it survives a change of provider or model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// The team it belongs to (`AgentTeam`), if any. A lateral grouping for
    /// peer help only: it never changes who reports to whom, where the agent
    /// may work, or what it may touch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// Its standing instructions — runbooks, tool rules — that ride in every
    /// brief it is launched with, after the shared policy and before its role
    /// (`standing_brief`). Never shown where its role is listed to others.
    /// Empty: none. Absent in files written before it existed.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub persistent_prompt: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The longest role an agent may have.
pub const ROLE_MAX: usize = 2000;
/// The longest persistent prompt an agent may have.
pub const PERSISTENT_PROMPT_MAX: usize = 8000;
/// The longest shared agent policy.
pub const AGENT_POLICY_MAX: usize = 4000;

/// A named group of agents who may ask each other questions while they work
/// (`orchestration::peer`). One team per agent. A team in a project holds
/// only that project's agents and global ones; a global team may hold anyone.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTeam {
    pub id: String,
    pub name: String,
    /// `None` is a global team; otherwise the project it belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What the browser sends to add or rename one team.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTeamDraft {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub project_id: Option<String>,
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
    /// Absent keeps the current avatar, `""` removes it, a data URL sets it.
    #[serde(default)]
    pub avatar: Option<String>,
    /// Absent keeps the current team, `""` takes the agent off its team, a
    /// team id puts it on that team.
    #[serde(default)]
    pub team_id: Option<String>,
    /// Absent keeps the current persistent prompt, `""` clears it, any other
    /// text replaces it.
    #[serde(default)]
    pub persistent_prompt: Option<String>,
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
    /// The conversation with the person's configured head (the CTO): it is
    /// not bound to its own project, and every task it hands out names its
    /// destination. Absent on every task handed out from a project.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cross_project: bool,
    pub created_at: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    agents: Vec<TeamAgent>,
    /// Peer-help teams. Membership is `TeamAgent::team_id`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    teams: Vec<AgentTeam>,
    #[serde(default)]
    leads: Vec<LeadRecord>,
    /// The global agent the person talks to across projects (their CTO).
    /// Configured, never inferred; `None` until the person picks one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    head: Option<String>,
    /// The workspace the head's conversations live in — the person's
    /// coordination home. A workspace id, configured, never a path; `None`
    /// falls back to the project named General.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    home: Option<String>,
    /// The agent every new conversation opens on, which only routes the
    /// person to the right agent (`front_desk_brief`). Configured, never
    /// inferred; `None` keeps the plain "Talk to" picker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    front_desk: Option<String>,
    /// The conversations started as front-desk chats. Kept apart from
    /// `leads`, and the only thing that hides a chat: an agent designated
    /// later keeps its earlier ordinary chats, and one undesignated keeps its
    /// front-desk chats hidden.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    front_desk_chats: Vec<FrontDeskChat>,
    /// The person's shared rules for every registered agent, put ahead of
    /// each one's own instructions in every brief (`standing_brief`). Empty:
    /// none. Absent in files written before it existed.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    agent_policy: String,
    /// When `agent_policy` last changed, so a proposed change is refused
    /// against a newer one (`save_policy_unchanged`). 0: never set.
    #[serde(default, skip_serializing_if = "is_zero")]
    agent_policy_updated_at: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

/// The shared agent policy and when it last changed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPolicy {
    pub text: String,
    pub updated_at: i64,
}

/// A conversation started with the front desk. Hidden from every chat list,
/// search and the resume list: what the person meant to start is the chat
/// the front desk routes them to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontDeskChat {
    pub chat_key: String,
    pub agent_id: String,
    /// The provider's own ids for this conversation, as its processes named
    /// them, so its session stays out of "Resume an earlier session". Each
    /// with its provider: two providers' ids are not one namespace.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<FrontDeskSession>,
    /// Ids recorded before the provider was, whose provider could not be
    /// worked out since (`upgrade_front_desk_sessions`). Hidden only where
    /// no other session shares the id (`agent_history::without_front_desks`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub session_ids: Vec<String>,
    pub created_at: i64,
    /// The start of what the person first said, so the new-chat screen can
    /// name a conversation they left before it routed them
    /// (`handover::route::unfinished`). Absent on chats recorded before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opening: Option<String>,
}

/// How much of the person's first message a front-desk chat keeps.
const FRONT_DESK_OPENING_MAX: usize = 160;

/// The person's first words, on one line and cut on a character boundary.
fn front_desk_opening(task: &str) -> Option<String> {
    let line = task.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    if line.chars().count() <= FRONT_DESK_OPENING_MAX {
        return Some(line);
    }
    let cut: String = line.chars().take(FRONT_DESK_OPENING_MAX - 1).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// One provider session a front-desk chat ran as.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontDeskSession {
    pub provider: ChatAgent,
    pub session_id: String,
}

/// How many front-desk chats are remembered. Their transcripts are not
/// indexed, so the next start removes them; this only has to outlive that.
const FRONT_DESK_CHATS_KEPT: usize = 500;

/// The role a front desk is created with, in the person's words for it. The
/// rules it works by are the host's (`front_desk_brief`), not this text.
pub const FRONT_DESK_ROLE: &str = "Listens to what the person wants, works out which registered agent should handle it and in which project, and opens a new chat with that agent carrying a short brief of the request. Only routes: it does no work itself.";

/// The model and effort a front desk is created with when nothing else is
/// chosen: the smallest Claude model at its lowest effort. Routing reads a
/// roster and writes a paragraph; it needs speed, not depth.
pub const FRONT_DESK_MODEL: &str = "haiku";
pub const FRONT_DESK_EFFORT: &str = "low";

/// Serializes read-modify-write of the file; the store is small enough to be
/// read whole on every call.
static LOCK: Mutex<()> = Mutex::new(());

pub fn default_path() -> PathBuf {
    #[cfg(test)]
    if let Some(path) = TEST_PATH.lock().ok().and_then(|path| path.clone()) {
        return path;
    }
    crate::profile::profile_dir().join("team.json")
}

/// A test that has to go through a command which reads `default_path` points
/// it at a throwaway file instead of the real profile, for as long as the
/// returned guard lives. One such test at a time.
#[cfg(test)]
static TEST_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
#[cfg(test)]
static TEST_PATH_TURN: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) struct TestTeamPath(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);

#[cfg(test)]
pub(crate) fn use_test_path(path: PathBuf) -> TestTeamPath {
    let turn = TEST_PATH_TURN.lock().unwrap_or_else(|e| e.into_inner());
    *TEST_PATH.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    TestTeamPath(turn)
}

#[cfg(test)]
impl Drop for TestTeamPath {
    fn drop(&mut self) {
        *TEST_PATH.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
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
    save_checked(path, draft, None)
}

/// `save`, refused when the agent has changed since `expected` (its
/// `updated_at` when the change was proposed). What an agent proposes through
/// its MCP waits on the person, and what they approve is that change to that
/// version of the agent — never a later one somebody else made meanwhile.
pub fn save_unchanged(path: &Path, draft: TeamDraft, expected: i64) -> Result<TeamAgent, String> {
    save_checked(path, draft, Some(expected))
}

/// What `save` would make of `draft`, without writing anything: every rule the
/// Settings form is held to, run against the agents as they are now.
pub fn check(path: &Path, draft: TeamDraft) -> Result<TeamAgent, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    apply(&mut stored, draft, None)
}

fn save_checked(path: &Path, draft: TeamDraft, expected: Option<i64>) -> Result<TeamAgent, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    let saved = apply(&mut stored, draft, expected)?;
    write(path, &stored)?;
    Ok(saved)
}

/// One agent added or changed in `stored`, every rule checked. The caller holds
/// `LOCK` and decides whether the result is written.
fn apply(
    stored: &mut Stored,
    draft: TeamDraft,
    expected: Option<i64>,
) -> Result<TeamAgent, String> {
    let name = clean(&draft.name, "name", 60, true)?;
    let role = clean(&draft.role, "role", ROLE_MAX, false)?;
    let persistent_prompt = draft
        .persistent_prompt
        .as_deref()
        .map(|text| clean(text, "persistent prompt", PERSISTENT_PROMPT_MAX, false))
        .transpose()?;
    if draft.agent == ChatAgent::Pi {
        return Err("Choose Claude, Codex or Antigravity for a registered agent.".into());
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
    let avatar = match draft.avatar.as_deref().map(str::trim) {
        None => None,
        Some("") => Some(None),
        Some(url) => Some(Some(crate::agent_avatar::checked_data_url(url)?)),
    };
    let team_choice = match draft.team_id.as_deref().map(str::trim) {
        None => None,
        Some("") => Some(None),
        Some(team) => Some(Some(team.to_owned())),
    };

    let id = draft.id.filter(|id| !id.is_empty());
    if let (Some(me), Some(expected)) = (&id, expected) {
        let current = stored
            .agents
            .iter()
            .find(|a| &a.id == me)
            .ok_or("That agent no longer exists.")?;
        if current.updated_at != expected {
            return Err(format!(
                "{} was changed while this waited for approval, so nothing was saved. Read it again and propose the change again.",
                current.name
            ));
        }
    }
    let team_id = match team_choice {
        Some(choice) => choice,
        // Unchanged: whatever team it is on now, if that team still exists.
        None => id
            .as_ref()
            .and_then(|me| stored.agents.iter().find(|a| &a.id == me))
            .and_then(|a| a.team_id.clone())
            .filter(|team| stored.teams.iter().any(|t| &t.id == team)),
    };
    if let Some(team_id) = &team_id {
        let team = stored
            .teams
            .iter()
            .find(|t| &t.id == team_id)
            .ok_or("The chosen team no longer exists.")?;
        if !can_join(project_id.as_deref(), team.project_id.as_deref()) {
            return Err(format!(
                "{name} cannot be on {}: that team belongs to another project.",
                team.name
            ));
        }
    }
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
    if let (Some(me), Some(_)) = (&id, &project_id) {
        if stored.head.as_deref() == Some(me.as_str()) {
            return Err(format!(
                "{name} is the lead you talk to across projects, so it stays global. Choose another lead first."
            ));
        }
        if stored.front_desk.as_deref() == Some(me.as_str()) {
            return Err(format!(
                "{name} is your front desk, which routes from every project, so it stays global. Choose another front desk first."
            ));
        }
    }
    // The front desk only routes: nobody reports to it.
    if let (Some(manager), Some(desk)) = (&reports_to, stored.front_desk.as_deref()) {
        if manager == desk {
            let desk_name = stored
                .agents
                .iter()
                .find(|a| a.id == desk)
                .map_or("The front desk", |a| a.name.as_str());
            return Err(format!(
                "{desk_name} is your front desk. It only routes conversations, so no agent can report to it."
            ));
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
                avatar: avatar.unwrap_or_else(|| existing.avatar.clone()),
                team_id,
                persistent_prompt: persistent_prompt
                    .unwrap_or_else(|| existing.persistent_prompt.clone()),
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
                avatar: avatar.flatten(),
                team_id,
                persistent_prompt: persistent_prompt.unwrap_or_default(),
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
    Ok(stored
        .agents
        .iter()
        .find(|a| a.id == saved.id)
        .cloned()
        .unwrap_or(saved))
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
    if stored.head.as_deref() == Some(id) {
        stored.head = None;
    }
    if stored.front_desk.as_deref() == Some(id) {
        stored.front_desk = None;
    }
    for agent in &mut stored.agents {
        if agent.reports_to.as_deref() == Some(id) {
            agent.reports_to = gone.reports_to.clone();
        }
    }
    write(path, &stored)
}

/// The shared agent policy, empty when the person has written none.
pub fn policy(path: &Path) -> Result<AgentPolicy, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let stored = read(path)?;
    Ok(AgentPolicy {
        text: stored.agent_policy,
        updated_at: stored.agent_policy_updated_at,
    })
}

/// The policy text as it would be saved, or why it would be refused.
pub fn check_policy(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.chars().count() > AGENT_POLICY_MAX {
        return Err(format!(
            "The agent policy is longer than {AGENT_POLICY_MAX} characters."
        ));
    }
    Ok(text.to_owned())
}

/// Replace the shared agent policy; `""` clears it.
pub fn set_policy(path: &Path, text: &str) -> Result<AgentPolicy, String> {
    set_policy_checked(path, text, None)
}

/// `set_policy`, refused when the policy has changed since `expected` (its
/// `updated_at` when the change was proposed), as `save_unchanged` is.
pub fn set_policy_unchanged(path: &Path, text: &str, expected: i64) -> Result<AgentPolicy, String> {
    set_policy_checked(path, text, Some(expected))
}

fn set_policy_checked(
    path: &Path,
    text: &str,
    expected: Option<i64>,
) -> Result<AgentPolicy, String> {
    let text = check_policy(text)?;
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    if expected.is_some_and(|expected| expected != stored.agent_policy_updated_at) {
        return Err("The agent policy was changed while this waited for approval, so nothing was saved. Read it again and propose the change again.".into());
    }
    // Never the same stamp twice, so a proposal made against one version can
    // never be taken for the next, however quickly it follows.
    stored.agent_policy_updated_at = now_ms().max(stored.agent_policy_updated_at + 1);
    stored.agent_policy = text;
    write(path, &stored)?;
    Ok(AgentPolicy {
        text: stored.agent_policy,
        updated_at: stored.agent_policy_updated_at,
    })
}

/// What every brief an agent is launched with carries ahead of its role: the
/// person's shared policy, then the agent's own standing instructions. Each
/// is left out when empty; the whole is `""` when both are, and otherwise
/// ends in a blank line so the caller's role sentence follows on its own.
///
/// Only an agent's own launch reads this. Wherever the agent is LISTED to
/// another — a roster, a routing brief, a destination list, a card — only its
/// role is shown.
pub fn standing_brief(policy: &str, agent: &TeamAgent) -> String {
    let mut text = String::new();
    let policy = policy.trim();
    if !policy.is_empty() {
        text.push_str("Shared agent policy (the person's rules for every agent):\n");
        text.push_str(policy);
        text.push_str("\n\n");
    }
    let standing = agent.persistent_prompt.trim();
    if !standing.is_empty() {
        text.push_str(&format!("Standing instructions for {}:\n", agent.name));
        text.push_str(standing);
        text.push_str("\n\n");
    }
    text
}

/// A global agent may join any team; a project agent only a global team or
/// one in its own project, so a team never gathers agents who could not all
/// look at the same work.
fn can_join(agent_project: Option<&str>, team_project: Option<&str>) -> bool {
    agent_project.is_none() || team_project.is_none() || agent_project == team_project
}

/// Every peer-help team.
pub fn teams(path: &Path) -> Result<Vec<AgentTeam>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    Ok(read(path)?.teams)
}

/// Add or rename a team, or move it between global and one project.
pub fn save_team(path: &Path, draft: AgentTeamDraft) -> Result<AgentTeam, String> {
    let name = draft.name.trim().to_owned();
    if name.is_empty() {
        return Err("Give the team a name.".into());
    }
    if name.chars().count() > 60 {
        return Err("The team's name is longer than 60 characters.".into());
    }
    let project_id = draft.project_id.filter(|p| !p.trim().is_empty());
    let id = draft.id.filter(|id| !id.trim().is_empty());

    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    let clash = stored.teams.iter().any(|other| {
        Some(&other.id) != id.as_ref()
            && other.name.eq_ignore_ascii_case(&name)
            && (other.project_id.is_none()
                || project_id.is_none()
                || other.project_id == project_id)
    });
    if clash {
        return Err(format!("Another team is already called {name}."));
    }
    if let Some(me) = &id {
        // Narrowing a team to one project must not keep an agent of another.
        if let Some(member) = stored.agents.iter().find(|a| {
            a.team_id.as_deref() == Some(me.as_str())
                && !can_join(a.project_id.as_deref(), project_id.as_deref())
        }) {
            return Err(format!(
                "{} is on this team and works only in another project. Take {} off the team first.",
                member.name, member.name
            ));
        }
    }
    let now = now_ms();
    let saved = match id {
        Some(id) => {
            let existing = stored
                .teams
                .iter_mut()
                .find(|t| t.id == id)
                .ok_or("That team no longer exists.")?;
            existing.name = name;
            existing.project_id = project_id;
            existing.updated_at = now;
            existing.clone()
        }
        None => {
            let team = AgentTeam {
                id: format!("team_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
                name,
                project_id,
                created_at: now,
                updated_at: now,
            };
            stored.teams.push(team.clone());
            team
        }
    };
    write(path, &stored)?;
    Ok(saved)
}

/// Remove a team. Its members stay registered, on no team.
pub fn delete_team(path: &Path, id: &str) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    if !stored.teams.iter().any(|t| t.id == id) {
        return Err("That team no longer exists.".into());
    }
    stored.teams.retain(|t| t.id != id);
    for agent in &mut stored.agents {
        if agent.team_id.as_deref() == Some(id) {
            agent.team_id = None;
        }
    }
    write(path, &stored)
}

/// The other members of `me`'s team, in registration order. Empty when it
/// is on no team, or its team no longer exists.
pub fn teammates<'a>(
    agents: &'a [TeamAgent],
    teams: &[AgentTeam],
    me: &TeamAgent,
) -> Vec<&'a TeamAgent> {
    let Some(team) = me
        .team_id
        .as_deref()
        .filter(|id| teams.iter().any(|t| t.id == *id))
    else {
        return Vec::new();
    };
    agents
        .iter()
        .filter(|a| a.id != me.id && a.team_id.as_deref() == Some(team))
        .collect()
}

/// What a worker is told about its team: who it may ask and how. `None`
/// when it has no teammate who may look at work in `project_id`.
pub fn peer_brief(
    agents: &[TeamAgent],
    teams: &[AgentTeam],
    me: &TeamAgent,
    project_id: &str,
) -> Option<String> {
    let team = teams
        .iter()
        .find(|t| Some(t.id.as_str()) == me.team_id.as_deref())?;
    let peers: Vec<_> = teammates(agents, teams, me)
        .into_iter()
        .filter(|a| may_work_in(a, project_id))
        .collect();
    if peers.is_empty() {
        return None;
    }
    let rows = peers
        .iter()
        .map(|a| describe(a, agents, false, None))
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!(
        "You are on the team {}. Your teammates:\n{rows}\n\nPeers answer questions; they do not do the work. When a teammate's role fits a question you are stuck on, call orchestration_peer_ask with their id as teammateId, one self-contained question, and optionally contextPaths (files in your workspace, relative to it) they should read first. The host runs their answer as that teammate, read-only in your workspace, and returns it as the tool result. At most {} asks per attempt. The answer is advice: you still own the task, and you verify before acting on it.",
        team.name,
        crate::orchestration::peer::MAX_ASKS_PER_ATTEMPT
    ))
}

/// Remember that `chat_key` was handed a task with `lead_id` as its lead.
///
/// A chat keeps the lead it was first handed to. Handing the same chat to
/// someone else would put one agent's name over another's history, so it is
/// refused rather than silently retargeted.
pub fn record_lead(
    path: &Path,
    chat_key: &str,
    lead: &TeamAgent,
    project_id: &str,
    cross_project: bool,
) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    if let Some(existing) = stored.leads.iter().find(|r| r.chat_key == chat_key) {
        if existing.lead_id != lead.id || existing.cross_project != cross_project {
            return Err(format!(
                "This conversation belongs to {}. Start a new one to talk to {}.",
                existing.lead_name, lead.name
            ));
        }
    }
    stored.leads.retain(|record| record.chat_key != chat_key);
    stored.leads.push(LeadRecord {
        chat_key: chat_key.to_owned(),
        lead_id: lead.id.clone(),
        lead_name: lead.name.clone(),
        project_id: project_id.to_owned(),
        cross_project,
        created_at: now_ms(),
    });
    write(path, &stored)
}

/// The person's configured head: the global agent behind "Talk to …". `None`
/// when none is configured, or the configured one was removed.
pub fn head(path: &Path) -> Result<Option<TeamAgent>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let stored = read(path)?;
    Ok(stored.head.as_deref().and_then(|id| {
        stored
            .agents
            .iter()
            .find(|a| a.id == id && a.project_id.is_none())
            .cloned()
    }))
}

/// Configure (or clear, with `None`) the head. It must be a global agent:
/// the conversation with it spans every project.
pub fn set_head(path: &Path, id: Option<&str>) -> Result<Option<TeamAgent>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    let chosen = match id.map(str::trim).filter(|id| !id.is_empty()) {
        None => None,
        Some(id) => {
            let agent = stored
                .agents
                .iter()
                .find(|a| a.id == id)
                .cloned()
                .ok_or("That agent no longer exists.")?;
            if agent.project_id.is_some() {
                return Err(format!(
                    "{} belongs to one project. The lead you talk to across projects must be available in every project.",
                    agent.name
                ));
            }
            if stored.front_desk.as_deref() == Some(agent.id.as_str()) {
                return Err(format!(
                    "{} is your front desk, which only routes. Choose another lead, or another front desk first.",
                    agent.name
                ));
            }
            Some(agent)
        }
    };
    stored.head = chosen.as_ref().map(|a| a.id.clone());
    write(path, &stored)?;
    Ok(chosen)
}

/// The designated front desk, when one is designated and still registered
/// as a global agent.
pub fn front_desk(path: &Path) -> Result<Option<TeamAgent>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    Ok(desk_of(&read(path)?))
}

fn desk_of(stored: &Stored) -> Option<TeamAgent> {
    stored.front_desk.as_deref().and_then(|id| {
        stored
            .agents
            .iter()
            .find(|a| a.id == id && a.project_id.is_none())
            .cloned()
    })
}

/// Why `agent` cannot be the front desk, if it cannot. A front-desk chat is
/// hidden and stripped of every tool but routing, so the head and anyone who
/// manages agents would lose the conversations they lead. It routes from
/// every project, so it is global.
fn front_desk_refusal(stored: &Stored, agent: &TeamAgent) -> Option<String> {
    if agent.project_id.is_some() {
        return Some(format!(
            "{} belongs to one project. The front desk routes from every project, so pick a global agent.",
            agent.name
        ));
    }
    if stored.head.as_deref() == Some(agent.id.as_str()) {
        return Some(format!(
            "{} is the lead you talk to across projects. A front desk only routes and its chats are hidden, so pick or create a separate agent.",
            agent.name
        ));
    }
    if stored
        .agents
        .iter()
        .any(|a| a.reports_to.as_deref() == Some(agent.id.as_str()))
    {
        return Some(format!(
            "{} manages other agents. A front desk only routes and its chats are hidden, so pick or create a separate agent.",
            agent.name
        ));
    }
    None
}

/// Designate (or clear, with `None`) the front desk. Changes no chat: the
/// agent's earlier conversations stay as they were, and only conversations
/// started with it from now on are front-desk chats.
pub fn set_front_desk(path: &Path, id: Option<&str>) -> Result<Option<TeamAgent>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    let chosen = match id.map(str::trim).filter(|id| !id.is_empty()) {
        None => None,
        Some(id) => {
            let agent = stored
                .agents
                .iter()
                .find(|a| a.id == id)
                .cloned()
                .ok_or("That agent no longer exists.")?;
            if let Some(why) = front_desk_refusal(&stored, &agent) {
                return Err(why);
            }
            Some(agent)
        }
    };
    stored.front_desk = chosen.as_ref().map(|a| a.id.clone());
    write(path, &stored)?;
    Ok(chosen)
}

/// What the browser sends to create a front desk in one step. Everything is
/// optional: the defaults are the router role and the smallest Claude model
/// at its lowest effort.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontDeskDraft {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub agent: Option<ChatAgent>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// Register a new global agent with the router role and designate it.
pub fn create_front_desk(path: &Path, draft: FrontDeskDraft) -> Result<TeamAgent, String> {
    let agent = draft.agent.unwrap_or(ChatAgent::Claude);
    let model = draft
        .model
        .map(|m| m.trim().to_owned())
        .filter(|m| !m.is_empty())
        .or_else(|| (agent == ChatAgent::Claude).then(|| FRONT_DESK_MODEL.to_owned()))
        .ok_or("Choose the model the front desk runs on.")?;
    let saved = save(
        path,
        TeamDraft {
            id: None,
            name: draft
                .name
                .map(|n| n.trim().to_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "Front desk".into()),
            role: FRONT_DESK_ROLE.into(),
            agent,
            model,
            effort: Some(
                draft
                    .effort
                    .filter(|e| !e.trim().is_empty())
                    .unwrap_or_else(|| FRONT_DESK_EFFORT.into()),
            ),
            // It reads a roster and writes a brief; nothing it does needs
            // more, and a Codex front desk is then sandboxed read-only.
            access: Some(Access::Read),
            project_id: None,
            reports_to: None,
            avatar: None,
            team_id: None,
            persistent_prompt: None,
        },
    )?;
    set_front_desk(path, Some(&saved.id))?;
    Ok(saved)
}

/// Whether `chat_key` was started as a front-desk chat.
pub fn is_front_desk_chat(path: &Path, chat_key: &str) -> bool {
    front_desk_chat(path, chat_key).is_some()
}

pub fn front_desk_chat(path: &Path, chat_key: &str) -> Option<FrontDeskChat> {
    let _guard = LOCK.lock().ok()?;
    read(path)
        .ok()?
        .front_desk_chats
        .into_iter()
        .find(|c| c.chat_key == chat_key)
}

/// Every front-desk chat, for the listings that leave them out.
pub fn front_desk_chats(path: &Path) -> Vec<FrontDeskChat> {
    let Ok(_guard) = LOCK.lock() else {
        return Vec::new();
    };
    read(path).map(|s| s.front_desk_chats).unwrap_or_default()
}

/// Remember the provider's id for a front-desk chat's conversation, with
/// the provider that named it. Nothing for any other chat.
pub fn note_front_desk_session(path: &Path, chat_key: &str, provider: ChatAgent, session_id: &str) {
    let Ok(_guard) = LOCK.lock() else {
        return;
    };
    let Ok(mut stored) = read(path) else {
        return;
    };
    let Some(chat) = stored
        .front_desk_chats
        .iter_mut()
        .find(|c| c.chat_key == chat_key)
    else {
        return;
    };
    let session = FrontDeskSession {
        provider,
        session_id: session_id.to_owned(),
    };
    if chat.sessions.contains(&session) {
        return;
    }
    chat.sessions.push(session);
    let _ = write(path, &stored);
}

fn record_front_desk_chat(stored: &mut Stored, chat_key: &str, agent_id: &str, task: &str) {
    if stored
        .front_desk_chats
        .iter()
        .any(|c| c.chat_key == chat_key)
    {
        return;
    }
    stored.front_desk_chats.push(FrontDeskChat {
        chat_key: chat_key.to_owned(),
        agent_id: agent_id.to_owned(),
        sessions: Vec::new(),
        session_ids: Vec::new(),
        created_at: now_ms(),
        opening: front_desk_opening(task),
    });
    let over = stored
        .front_desk_chats
        .len()
        .saturating_sub(FRONT_DESK_CHATS_KEPT);
    stored.front_desk_chats.drain(..over);
}

/// The configured coordination home: a workspace id, or `None` when the
/// person has not chosen one (the client then uses the project named General).
pub fn home(path: &Path) -> Result<Option<String>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    Ok(read(path)?.home)
}

/// Choose (or clear) the coordination home. The caller has checked that the
/// id names a registered workspace; this store only keeps it.
pub fn set_home(path: &Path, id: Option<&str>) -> Result<Option<String>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    stored.home = id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    write(path, &stored)?;
    Ok(stored.home)
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
/// (case-insensitive) name, among those the destination project can see. With
/// a `manager`, the assignee must report directly to it.
#[cfg(test)]
pub fn resolve(
    path: &Path,
    project_id: &str,
    who: &str,
    manager: Option<&str>,
) -> Result<TeamAgent, String> {
    resolve_in(&list(path, None, true)?, project_id, who, manager, &|_| {
        None
    })
}

/// [`resolve`] over an already-read team. `project_name` names a project in an
/// error, so an agent that works elsewhere is told where.
pub fn resolve_in(
    team: &[TeamAgent],
    project_id: &str,
    who: &str,
    manager: Option<&str>,
    project_name: &dyn Fn(&str) -> Option<String>,
) -> Result<TeamAgent, String> {
    let who = who.trim();
    let visible: Vec<TeamAgent> = team
        .iter()
        .filter(|a| a.visible_in(Some(project_id)))
        .cloned()
        .collect();
    let found = visible
        .iter()
        .find(|a| a.id == who)
        .or_else(|| visible.iter().find(|a| a.name.eq_ignore_ascii_case(who)))
        .cloned();
    let Some(found) = found else {
        // Named correctly, but scoped to another project: say which.
        let elsewhere = team
            .iter()
            .find(|a| a.id == who || a.name.eq_ignore_ascii_case(who))
            .and_then(|a| {
                a.project_id
                    .as_deref()
                    .map(|p| (a.name.clone(), p.to_owned()))
            });
        return Err(match elsewhere {
            Some((name, project)) => format!(
                "{name} works only in {}. Route the task to that project, or assign someone who works in this one.",
                project_name(&project).unwrap_or_else(|| "another project".into())
            ),
            None => format!("No registered agent called {who} in this project. Assign to one of the agents listed in your brief."),
        });
    };
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

/// Whether `agent` sits at the top of the chart and so reports to the person:
/// it has no manager, or its manager is no longer registered (the org chart
/// draws such an agent at the top too). Independent of global or project scope.
pub fn reports_to_person(agent: &TeamAgent, team: &[TeamAgent]) -> bool {
    agent
        .reports_to
        .as_deref()
        .is_none_or(|manager| !team.iter().any(|a| a.id == manager))
}

/// Whether `agent` may send work into `project_id`: a global agent anywhere, a
/// project agent only into its own project.
pub fn may_work_in(agent: &TeamAgent, project_id: &str) -> bool {
    agent.visible_in(Some(project_id))
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
        "---\ntype: agent-memory\nagent: {name}\nagent-id: {id}\n---\n\n# {name} — memory\n\nWorking memory for {name}, a registered OctiqFlow agent. It holds only what is worth keeping between tasks: decisions and why, gotchas, how things work, and what to pick up next. A Lessons section, once there is one, holds what still holds and changes only with the person's approval; the dated entries below it are appended and never rewritten.\n",
        name = agent.name,
        id = agent.id,
    )
}

/// The header OctiqFlow seeded (`memory_seed`) relabelled for `name`: the
/// frontmatter `agent:`, the `# … — memory` heading and the "Working memory
/// for …" line. Answers the exact old block and its replacement, or None when
/// the header already names `name` or is not one OctiqFlow wrote. Only lines
/// before the first dated entry are ever looked at.
pub fn relabel_memory_header(head: &str, name: &str) -> Option<(String, String)> {
    let lines: Vec<&str> = head.split('\n').collect();
    if lines.first() != Some(&"---") || !lines.contains(&"type: agent-memory") {
        return None;
    }
    let mut new_lines: Vec<String> = Vec::new();
    let mut last = None;
    let mut in_front = true;
    for (index, line) in lines.iter().enumerate() {
        if line.starts_with("## ") {
            break;
        }
        let relabelled = if in_front && index > 0 && *line == "---" {
            in_front = false;
            None
        } else if in_front && line.starts_with("agent: ") {
            Some(format!("agent: {name}"))
        } else if !in_front && line.starts_with("# ") && line.ends_with(" — memory") {
            Some(format!("# {name} — memory"))
        } else if !in_front && line.starts_with("Working memory for ") {
            line.split_once(", a registered OctiqFlow agent.")
                .map(|(_, rest)| {
                    format!("Working memory for {name}, a registered OctiqFlow agent.{rest}")
                })
        } else {
            None
        };
        if relabelled.is_some() {
            last = Some(index);
        }
        new_lines.push(relabelled.unwrap_or_else(|| line.to_string()));
    }
    let last = last?;
    let old = lines[..=last].join("\n");
    let new = new_lines[..=last].join("\n");
    (old != new).then_some((old, new))
}

/// Who a worker is, for the brief of a task assigned to a registered agent:
/// the shared policy, its standing instructions, then its role.
pub fn worker_identity(policy: &str, agent: &TeamAgent) -> String {
    let role = agent.role.trim();
    let role = if role.is_empty() {
        String::new()
    } else {
        format!(
            " Your role: {}.",
            role.replace('\n', " ").trim_end_matches('.')
        )
    };
    format!(
        "{}You are {}, the registered OctiqFlow agent this task is assigned to.{role}",
        standing_brief(policy, agent),
        agent.name
    )
}

/// What an orchestration worker assigned to a registered agent is told about
/// itself, after the task's own dispatch: who it is (`worker_identity`), its
/// memory, and the teammates it may ask. `None` when the agent is gone.
pub fn assignee_brief(
    path: &Path,
    assignee_id: &str,
    project_id: &str,
) -> Option<(TeamAgent, String)> {
    let team = list(path, None, true).ok()?;
    let me = team.iter().find(|a| a.id == assignee_id)?.clone();
    let policy = policy(path).unwrap_or_default();
    let mut text = worker_identity(&policy.text, &me);
    text.push_str("\n\n");
    text.push_str(&memory_brief(&me, &team));
    // Who it may ask for help, and that they only answer.
    let teams = teams(path).unwrap_or_default();
    if let Some(peers) = peer_brief(&team, &teams, &me, project_id) {
        text.push_str("\n\n");
        text.push_str(&peers);
    }
    Some((me, text))
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
        "You have your own working memory in the shared Memory Vault. Before starting, call vault_agent_memory_read to load it. Record only what your future self would need, with one short entry through vault_agent_memory_append: a decision and why, a gotcha, how something works, or what to pick up next. Do not log routine steps, restate the diff, or copy the task. Pass today's local date as `date`. Write your memory only through vault_agent_memory_append, never vault_write or vault_patch: OctiqFlow then shows the person that it was saved. Only a result whose receipt status is saved means the entry was written, so never say you updated your memory otherwise. If the call fails or times out, retry with the same requestId, never a new one. The read returns your Lessons and your newest entries; it says how many older ones it left out. When your entries have outgrown your Lessons, or a lesson no longer holds, propose the whole updated Lessons section with vault_agent_memory_lessons: what still holds, short, never the task log. The person approves it on a card, and your dated entries are never changed. A lesson that holds for every agent in this project, such as a tool quirk or a repository rule, does not belong only in your memory: say so in your reply or report as a proposed change to the project's AGENTS.md, for the person or your lead to accept.{managers}"
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

/// An instant and the UTC offset this machine's clock shows there: what an
/// undated memory entry is dated by. The agent contract says "today's local
/// date", so that is what a date left out means — never the UTC day, which is
/// yesterday or tomorrow for most of the world around midnight.
///
/// A value rather than a call to the clock, so a test can stand anywhere in
/// any zone and cross midnight when it likes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalNow {
    pub ms: i64,
    pub offset_secs: i32,
}

impl LocalNow {
    pub fn system() -> Self {
        Self::at(now_ms())
    }

    /// `ms` as this machine's zone sees it (its offset at that instant, so
    /// daylight saving is whatever was in force then).
    pub fn at(ms: i64) -> Self {
        use chrono::{Offset, TimeZone};
        let offset_secs = chrono::Local
            .timestamp_millis_opt(ms)
            .single()
            .map_or(0, |t| t.offset().fix().local_minus_utc());
        Self { ms, offset_secs }
    }

    /// The civil date this instant falls on in its zone, as YYYY-MM-DD.
    pub fn date(&self) -> String {
        utc_date(self.ms + i64::from(self.offset_secs) * 1000)
    }
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
    let head = vault.call(
        actor,
        "read",
        &serde_json::json!({ "path": path, "lineCount": 12 }),
    );
    if let Ok(head) = head {
        // A renamed agent keeps its note (the path is fixed), but the lines
        // OctiqFlow wrote at the top still named its old self (feedback
        // 10cc5a23). Relabel them; the dated entries below are history and
        // are never touched.
        let content = head.get("content").and_then(|c| c.as_str()).unwrap_or("");
        let Some((old, new)) = relabel_memory_header(content, &agent.name) else {
            return Ok(());
        };
        // A label is not worth failing a save or an append over.
        let relabelled = vault
            .call(
                actor,
                "patch",
                &serde_json::json!({
                    "path": path,
                    "oldText": old,
                    "newText": new,
                    "expectedRevision": head.get("revision").cloned().unwrap_or_default(),
                    "requestId": format!("agent-memory-relabel-{}-{}", agent.id, slug(&agent.name)),
                }),
            )
            .and_then(saved);
        if let Err(error) = relabelled {
            eprintln!("team: could not relabel {path} for {}: {error}", agent.name);
        }
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
    // A page of the raw note when asked for one. Otherwise the note as it
    // should be loaded: its Lessons and its NEWEST entries, never the first
    // 200 lines of an append-only log (`memory_lessons`).
    let read = match start_line {
        Some(line) => vault.call(
            actor,
            "read",
            &serde_json::json!({ "path": path, "startLine": line }),
        ),
        None => crate::memory_lessons::read_all(vault, actor, path).map(|(text, page)| {
            let mut note = crate::memory_lessons::view_fields(&crate::memory_lessons::view(&text));
            for key in ["path", "revision", "totalLines"] {
                note[key] = page.get(key).cloned().unwrap_or_default();
            }
            note
        }),
    };
    match read {
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

/// What one append to an agent's own memory came to.
///
/// Only `Saved` says the entry is in the note. `Uncertain` is a receipt the
/// vault could not vouch for either way (it needs review), and is never shown
/// as a success or as a failure — see `memory_activity`. `Conflict` is this
/// call refused because its requestId already belongs to another change: it
/// says nothing against that earlier change, whose receipt it carries.
#[derive(Debug)]
pub enum MemoryWrite {
    /// `already`: an identical retry of an append that had been saved before;
    /// nothing was written this time.
    Saved {
        receipt: serde_json::Value,
        already: bool,
    },
    Uncertain {
        receipt: serde_json::Value,
        error: String,
    },
    /// Nothing was written by this call. `earlier` is the receipt of the
    /// change that already holds its requestId, reconciled — often saved.
    Conflict {
        earlier: serde_json::Value,
        error: String,
    },
    Failed(String),
}

/// An append, with what it was for: the note it went to, the entry's date and
/// its text, so the chat can show what was written without re-reading the note.
#[derive(Debug)]
pub struct MemoryAppend {
    pub note: Option<String>,
    pub date: Option<String>,
    pub text: String,
    pub outcome: MemoryWrite,
}

impl MemoryAppend {
    /// The tool's answer. Anything but a saved receipt is an error to the agent.
    pub fn result(&self, me: &TeamAgent) -> Result<serde_json::Value, String> {
        match &self.outcome {
            MemoryWrite::Saved { receipt, already } => {
                let mut value = serde_json::json!({
                    "agent": me.name, "path": self.note, "receipt": receipt,
                });
                if *already {
                    value["alreadySaved"] = true.into();
                }
                Ok(value)
            }
            MemoryWrite::Uncertain { error, .. }
            | MemoryWrite::Conflict { error, .. }
            | MemoryWrite::Failed(error) => Err(error.clone()),
        }
    }
}

/// Append one dated entry to your own memory, dated by this machine's clock
/// when the date is left out.
#[cfg(test)]
pub fn memory_append(
    vault: &crate::memory_vault::Vault,
    actor: &str,
    me: &TeamAgent,
    text: &str,
    date: Option<&str>,
    request_id: &str,
) -> MemoryAppend {
    memory_append_at(vault, actor, me, text, date, request_id, LocalNow::system())
}

/// `memory_append` as of `now`: an entry whose date is left out is dated
/// `now`'s local date, and that date is kept on its receipt.
///
/// A retry with the same `request_id` is answered from the earlier receipt
/// (the entry is never written twice), so a lost answer can always be asked
/// again. Nothing here retries a write under a new id.
pub fn memory_append_at(
    vault: &crate::memory_vault::Vault,
    actor: &str,
    me: &TeamAgent,
    text: &str,
    date: Option<&str>,
    request_id: &str,
    now: LocalNow,
) -> MemoryAppend {
    let text = text.trim().to_owned();
    let mut append = MemoryAppend {
        note: None,
        date: None,
        text: text.clone(),
        outcome: MemoryWrite::Failed(String::new()),
    };
    append.outcome = match append_entry(vault, actor, me, &text, date, request_id, now, &mut append)
    {
        Ok(outcome) => outcome,
        Err(error) => MemoryWrite::Failed(error),
    };
    append
}

/// The dates an earlier change under a retried requestId may have been
/// written with. A date the retry passes is the only candidate. A date left
/// out is read off the receipt, which keeps it. A receipt from before it kept
/// one says only when it was made: its entry was dated that day in some zone,
/// which is that UTC day, the one before or the one after — and the stored
/// request hash, not this list, decides which, if any, it was.
fn retry_dates(given: Option<&str>, made: &crate::memory_vault::Made) -> Vec<String> {
    if let Some(date) = given {
        return vec![date.to_owned()];
    }
    if let Some(date) = made.entry_date {
        return vec![date.to_owned()];
    }
    const DAY: i64 = 86_400_000;
    let at = i64::try_from(made.created_at).unwrap_or(i64::MAX);
    vec![
        utc_date(at.saturating_sub(DAY)),
        utc_date(at),
        utc_date(at.saturating_add(DAY)),
    ]
}

/// The refusal a call gets when its requestId is already another change's.
fn conflict(request_id: &str, earlier: serde_json::Value) -> MemoryWrite {
    let id = earlier.get("id").and_then(|s| s.as_str()).unwrap_or("");
    let status = earlier.get("status").and_then(|s| s.as_str());
    let standing = match status {
        Some("saved") => "That earlier entry is saved and stays as it is.".to_owned(),
        other => format!(
            "That earlier change is {}; check it with vault_receipt.",
            other.unwrap_or("unknown").replace('_', " ")
        ),
    };
    MemoryWrite::Conflict {
        error: format!(
            "This call was refused and wrote nothing: requestId {request_id} already belongs to an earlier memory change (receipt {id}) whose text or date differs from this call's. {standing} To retry that change, send its exact text and date; to record a different entry, use a new requestId."
        ),
        earlier,
    }
}

#[allow(clippy::too_many_arguments)]
fn append_entry(
    vault: &crate::memory_vault::Vault,
    actor: &str,
    me: &TeamAgent,
    text: &str,
    date: Option<&str>,
    request_id: &str,
    now: LocalNow,
    append: &mut MemoryAppend,
) -> Result<MemoryWrite, String> {
    use crate::memory_vault::Earlier;
    if text.is_empty() {
        return Err("Write what is worth remembering.".into());
    }
    if text.chars().count() > 4000 {
        return Err("Keep a memory entry under 4000 characters; record the essence.".into());
    }
    let given = date.map(str::trim).filter(|d| !d.is_empty());
    if given.is_some_and(|d| {
        d.len() != 10
            || !d.chars().enumerate().all(|(i, c)| {
                if i == 4 || i == 7 {
                    c == '-'
                } else {
                    c.is_ascii_digit()
                }
            })
    }) {
        return Err("Pass the date as YYYY-MM-DD.".into());
    }
    let path = note_of(me)?;
    append.note = Some(path.to_owned());
    // One builder for both the write and the retry check, so the two can never
    // disagree about what "the same operation" was.
    let args = |date: &str, revision: Option<&str>| {
        serde_json::json!({
            "path": path,
            "mode": "append",
            "content": format!("\n## {date}\n\n{text}\n"),
            "expectedRevision": revision,
            "requestId": request_id,
        })
    };
    let classify = |receipt: serde_json::Value, already: bool| match receipt
        .get("status")
        .and_then(|s| s.as_str())
    {
        Some("saved") => MemoryWrite::Saved { receipt, already },
        other => {
            let id = receipt.get("id").and_then(|s| s.as_str()).unwrap_or("");
            MemoryWrite::Uncertain {
                    error: format!(
                        "The memory write was not confirmed ({}). Receipt {id} needs review; check it with vault_receipt and never retry under a new requestId.",
                        other.unwrap_or("unknown")
                    ),
                    receipt,
                }
        }
    };
    let candidates = |made: &crate::memory_vault::Made| {
        retry_dates(given, made)
            .into_iter()
            .map(|date| {
                let args = args(&date, made.before_revision);
                (date, args)
            })
            .collect()
    };
    match vault.earlier_change(actor, request_id, "write", candidates)? {
        Earlier::Same(date, receipt) => {
            append.date = Some(date);
            return Ok(classify(receipt, true));
        }
        Earlier::Different(earlier) => {
            // The date this call would have used is left out on purpose:
            // nothing was written with it.
            append.date = given.map(str::to_owned);
            return Ok(conflict(request_id, earlier));
        }
        Earlier::None => {}
    }
    // A first call: an entry without a date is dated with the local date.
    let date = given.map_or_else(|| now.date(), str::to_owned);
    append.date = Some(date.clone());
    ensure_memory(vault, actor, me)?;
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
    match vault.write_entry(actor, &args(&date, Some(&revision)), &date) {
        Ok(receipt) => Ok(classify(receipt, false)),
        // A write that failed after its receipt was recorded may still have
        // reached the note: that one is uncertain, not failed. One that left
        // no receipt never touched it. A receipt another call made meanwhile
        // (the same request raced this one) is judged like any retry.
        Err(error) => match vault.earlier_change(actor, request_id, "write", |made| {
            vec![((), args(&date, made.before_revision))]
        }) {
            Ok(Earlier::Same(_, receipt)) => Ok(match classify(receipt, false) {
                MemoryWrite::Uncertain { receipt, .. } => MemoryWrite::Uncertain { receipt, error },
                saved => saved,
            }),
            Ok(Earlier::Different(earlier)) => Ok(conflict(request_id, earlier)),
            _ => Err(error),
        },
    }
}

pub fn direct_reports<'a>(team: &'a [TeamAgent], manager: &str) -> Vec<&'a TeamAgent> {
    team.iter()
        .filter(|a| a.reports_to.as_deref() == Some(manager))
        .collect()
}

/// Direct reports the host can actually assign work to. Lead-only models may
/// still appear in the org chart and memory permissions, but they are not an
/// available worker and must not make a manager's brief claim it can delegate.
pub fn eligible_direct_reports<'a>(team: &'a [TeamAgent], manager: &str) -> Vec<&'a TeamAgent> {
    direct_reports(team, manager)
        .into_iter()
        .filter(|agent| agent.can_work())
        .collect()
}

/// Reports a lead can be briefed to assign somewhere that still exists. A
/// project-scoped lead's `team` has already been narrowed to its project; a
/// global lead may also see project agents, whose project must still be
/// registered before they are useful assignment choices.
fn brief_reports<'a>(
    team: &'a [TeamAgent],
    lead: &TeamAgent,
    projects: &[(String, String)],
) -> Vec<&'a TeamAgent> {
    eligible_direct_reports(team, &lead.id)
        .into_iter()
        .filter(|agent| {
            lead.project_id.is_some()
                || agent
                    .project_id
                    .as_ref()
                    .is_none_or(|project_id| projects.iter().any(|(id, _)| id == project_id))
        })
        .collect()
}

fn describe(
    agent: &TeamAgent,
    team: &[TeamAgent],
    may_split: bool,
    project_name: Option<&dyn Fn(&str) -> Option<String>>,
) -> String {
    let provider = match agent.agent {
        ChatAgent::Claude => "Claude",
        ChatAgent::Codex => "Codex",
        ChatAgent::Pi => "pi",
        ChatAgent::Antigravity => "Antigravity",
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
    // A global lead's brief says where each report may work.
    let scope = match (project_name, agent.project_id.as_deref()) {
        (None, _) => String::new(),
        (Some(_), None) => " [works in any project]".to_owned(),
        (Some(name), Some(project)) => format!(
            " [works only in project {} (id `{project}`)]",
            name(project).unwrap_or_else(|| "that no longer exists".into())
        ),
    };
    format!(
        "- id `{}` · {} — {} · {provider} {}{effort}{lead_only}{manages}{scope}",
        agent.id, agent.name, role, agent.model
    )
}

/// The first message of a task: the person's words, then the lead's brief.
/// Records `chat_key` as this lead's task.
///
/// `cross_project` is the conversation with the configured head, where every
/// task must name where it runs. Any global lead gets its authorized reports
/// from every registered project; project-scoped leads stay in their project.
/// `projects` is every registered project as (id, name).
pub fn brief(
    path: &Path,
    chat_key: &str,
    project_id: &str,
    lead_id: &str,
    task: &str,
    cross_project: bool,
    projects: &[(String, String)],
) -> Result<String, String> {
    if let Some(text) = front_desk_brief(path, chat_key, lead_id, task, projects)? {
        return Ok(text);
    }
    lead_brief(
        path,
        chat_key,
        project_id,
        lead_id,
        task,
        cross_project,
        projects,
        true,
    )
}

/// The longest role a front-desk roster line carries. Roles run to a
/// thousand characters and the roster lists every agent.
const ROSTER_ROLE_MAX: usize = 400;

/// The workspace conversations that belong to no code project live in: the
/// configured home, else the project named General. `None` when neither is
/// registered.
pub fn home_project<'a>(
    home: Option<&str>,
    projects: &'a [(String, String)],
) -> Option<&'a (String, String)> {
    home.and_then(|id| projects.iter().find(|(pid, _)| pid == id))
        .or_else(|| {
            projects
                .iter()
                .find(|(_, name)| name.trim().eq_ignore_ascii_case("general"))
        })
}

/// The first message of a conversation with the front desk: the person's
/// words, then everything the front desk needs to route them, which is the
/// WHOLE roster (every registered agent, whoever it reports to) and every
/// project. Records `chat_key` as a front-desk chat.
///
/// `None` when `lead_id` is not the designated front desk, or `chat_key`
/// already belongs to an ordinary conversation with that agent: designating
/// it later changes none of its earlier chats.
pub fn front_desk_brief(
    path: &Path,
    chat_key: &str,
    lead_id: &str,
    task: &str,
    projects: &[(String, String)],
) -> Result<Option<String>, String> {
    let task = task.trim();
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    let Some(desk) = desk_of(&stored).filter(|desk| desk.id == lead_id) else {
        return Ok(None);
    };
    if stored
        .leads
        .iter()
        .any(|record| record.chat_key == chat_key)
    {
        return Ok(None);
    }
    if task.is_empty() {
        return Err("Say what you need first.".into());
    }
    let text = front_desk_text(&stored, &desk, task, projects);
    record_front_desk_chat(&mut stored, chat_key, &desk.id, task);
    write(path, &stored)?;
    Ok(Some(text))
}

fn front_desk_text(
    stored: &Stored,
    desk: &TeamAgent,
    task: &str,
    projects: &[(String, String)],
) -> String {
    let name_of = |id: &str| {
        projects
            .iter()
            .find(|(pid, _)| pid == id)
            .map(|(_, name)| name.clone())
    };
    let home = home_project(stored.home.as_deref(), projects);
    let head = desk_head(stored);
    let project_rows = if projects.is_empty() {
        "(none registered)".to_owned()
    } else {
        projects
            .iter()
            .map(|(id, name)| {
                let mark = if home.is_some_and(|(home_id, _)| home_id == id) {
                    " (home: for anything that belongs to no code project)"
                } else {
                    ""
                };
                format!("- id `{id}` · {name}{mark}")
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let agents: Vec<&TeamAgent> = stored
        .agents
        .iter()
        .filter(|a| a.id != desk.id)
        .filter(|a| {
            a.project_id
                .as_deref()
                .is_none_or(|p| projects.iter().any(|(id, _)| id == p))
        })
        .collect();
    let roster = if agents.is_empty() {
        "(no other agent is registered)".to_owned()
    } else {
        agents
            .iter()
            .map(|agent| roster_line(agent, &stored.agents, head.as_ref(), &name_of))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let role = if desk.role.trim().is_empty() {
        String::new()
    } else {
        format!(
            " Your role: {}.",
            desk.role.replace('\n', " ").trim_end_matches('.')
        )
    };
    let head_rule = match &head {
        Some(head) => format!(
            " {} is the person's lead across projects: send it work that spans several projects or needs planning across teams.",
            head.name
        ),
        None => String::new(),
    };
    let home_rule = match home {
        Some((_, name)) => {
            format!(" Work that belongs to no code project goes to {name}, the home workspace.")
        }
        None => String::new(),
    };
    let standing = standing_brief(&stored.agent_policy, desk);
    format!(
        "{task}{BRIEF_MARK}Front desk: {name}\n\n\
{standing}You are {name}, the person's front desk in OctiqFlow.{role} You never do the work yourself, never act for another agent, and have no tools but route_chat. Your one job is to find the registered agent who should handle what the person wants and open a new chat with them.\n\n\
How to route:\n\
- Pick the ONE agent below whose role and project fit the request best. When the person names an agent or a project, follow that if it is in the lists.\n\
- If two or more agents fit and nothing in the request tells them apart, ask the person one short question that names the candidates, then end your turn. Do not guess.\n\
- If the request clearly fits no registered agent, say so in one or two sentences, name the closest agents, and do not call route_chat.\n\
- Otherwise call route_chat with `agent` (the agent's id), `project` (a project id from the list; a project agent's own project is the default),{home_short} `brief` and `attachments`. Write the brief for the agent, who has not seen this chat: what the person wants, the goal, and every constraint, name, link and detail they gave, in their words where it matters. Invent nothing. Pass every path listed under \"Attachments:\" in the person's messages unless they asked to leave one out.\n\
- An agent that works only in one project can be sent only there.{head_rule}{home_rule}\n\
- route_chat only shows the person a card with the agent, the project and your brief. Nothing is created until they confirm it. After calling it, say in one short line what the card proposes and end your turn. If the person asks for a change, call route_chat again with the revised brief; it replaces the card.\n\n\
Reply briefly, in the person's language.\n\n\
Registered projects:\n{project_rows}\n\n\
Registered agents:\n{roster}",
        name = desk.name,
        home_short = if home.is_some() {
            " leave `project` out to use the home workspace,"
        } else {
            ""
        },
    )
}

/// The head, when one is configured and still registered.
fn desk_head(stored: &Stored) -> Option<TeamAgent> {
    stored
        .head
        .as_deref()
        .and_then(|id| stored.agents.iter().find(|a| a.id == id).cloned())
}

fn roster_line(
    agent: &TeamAgent,
    team: &[TeamAgent],
    head: Option<&TeamAgent>,
    name_of: &dyn Fn(&str) -> Option<String>,
) -> String {
    let mut role: String = agent.role.replace('\n', " ").trim().to_owned();
    if role.chars().count() > ROSTER_ROLE_MAX {
        role = role.chars().take(ROSTER_ROLE_MAX).collect::<String>() + "…";
    }
    if role.is_empty() {
        role = "no role given".into();
    }
    let scope = match agent.project_id.as_deref() {
        None => "works in any project".to_owned(),
        Some(project) => format!(
            "works only in project {} (id `{project}`)",
            name_of(project).unwrap_or_else(|| "that no longer exists".into())
        ),
    };
    let reports = match agent
        .reports_to
        .as_deref()
        .and_then(|m| team.iter().find(|a| a.id == m))
    {
        Some(manager) => format!("reports to {}", manager.name),
        None => "reports to the person".into(),
    };
    let lead = if head.is_some_and(|h| h.id == agent.id) {
        " · the person's lead across projects"
    } else {
        ""
    };
    format!(
        "- id `{}` · {}{lead} — {role} · {scope} · {reports}",
        agent.id, agent.name
    )
}

/// The first message of a chat a task was handed over to (`handover.rs`):
/// the same lead brief as a new task, so the recipient can still pass the
/// work on to its own reports. The person confirmed the handover, so the
/// recipient need not be one who reports to them.
pub fn handover_brief(
    path: &Path,
    chat_key: &str,
    project_id: &str,
    lead_id: &str,
    task: &str,
    projects: &[(String, String)],
) -> Result<String, String> {
    lead_brief(
        path, chat_key, project_id, lead_id, task, false, projects, false,
    )
}

/// The first message of a chat the front desk routed the person to: the
/// same lead brief as a conversation they start themselves, so a lead still
/// plans and delegates. `cross_project` is a route to the head, whose
/// conversation spans every project exactly as "Talk to <head>" does. The
/// person confirmed the route, so the agent need not report to them.
pub fn route_brief(
    path: &Path,
    chat_key: &str,
    project_id: &str,
    lead_id: &str,
    task: &str,
    cross_project: bool,
    projects: &[(String, String)],
) -> Result<String, String> {
    lead_brief(
        path,
        chat_key,
        project_id,
        lead_id,
        task,
        cross_project,
        projects,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
fn lead_brief(
    path: &Path,
    chat_key: &str,
    project_id: &str,
    lead_id: &str,
    task: &str,
    cross_project: bool,
    projects: &[(String, String)],
    person_starts: bool,
) -> Result<String, String> {
    let task = task.trim();
    if task.is_empty() {
        return Err("Describe the task first.".into());
    }
    let mut team = list(path, None, true)?;
    if cross_project {
        let head = head(path)?.ok_or(
            "No lead is configured to talk to across projects. Choose one in Settings, Agents.",
        )?;
        if head.id != lead_id {
            return Err(format!(
                "{} is no longer the lead you talk to across projects. Start a new conversation.",
                head.name
            ));
        }
    }
    let lead = team
        .iter()
        .find(|a| a.id == lead_id)
        .cloned()
        .ok_or("The chosen agent no longer exists. Pick another one.")?;
    if !lead.visible_in(Some(project_id)) {
        return Err("The chosen agent no longer works in this project. Pick another one.".into());
    }
    // The person starts a conversation only with an agent who reports to
    // them; anyone lower down is reached through their manager. A chat that
    // already has a lead keeps it, whatever the chart says now, and handing
    // it to anyone else is refused by `record_lead`.
    let new_conversation = lead_for_chat(path, chat_key)?.is_none();
    if person_starts && new_conversation && !reports_to_person(&lead, &team) {
        let manager = team
            .iter()
            .find(|a| Some(a.id.as_str()) == lead.reports_to.as_deref())
            .map_or("someone else", |a| a.name.as_str());
        return Err(format!(
            "{} reports to {manager}. Start the conversation with {manager}, who can hand it on.",
            lead.name
        ));
    }
    // A global manager is authorized to route to registered projects, even
    // when the conversation was opened from one project's lead picker rather
    // than the cross-project shortcut. Keep its roster consistent with the
    // destination directory. A project-scoped manager remains confined to the
    // globals and agents visible in its own project.
    if lead.project_id.is_some() {
        team.retain(|agent| agent.visible_in(Some(project_id)));
    }
    let role = if lead.role.is_empty() {
        String::new()
    } else {
        format!(" Your role: {}.", lead.role.replace('\n', " "))
    };
    let name_of = |id: &str| {
        projects
            .iter()
            .find(|(pid, _)| pid == id)
            .map(|(_, name)| name.clone())
    };
    let reports = brief_reports(&team, &lead, projects);
    // After the mark, so the person's bubble still shows only their words.
    let standing = standing_brief(&policy(path)?.text, &lead);
    let head = if cross_project {
        format!(
            "{task}{BRIEF_MARK}Lead: {name}\n\n{standing}You are {name}, the person's lead across every OctiqFlow project.{role} The person brought you the request above. You lead it.",
            name = lead.name
        )
    } else {
        format!(
            "{task}{BRIEF_MARK}Lead: {name}\n\n{standing}You are {name}, a registered agent in this OctiqFlow project.{role} The person handed you the task above. You lead it.",
            name = lead.name
        )
    };
    let routing = if cross_project {
        "\n\nThis conversation is not tied to one project. Before planning, call orchestration_destinations: it lists every registered project, its repositories, and which of your direct reports may work there. Give EVERY task a destination with orchestration_task_create's `project` (id or name) and, when the project has more than one repository, `repository` (path or name). One objective may span several projects and repositories; create one task per destination. A report scoped to one project can only work in that project. The host refuses an unregistered project or repository and never falls back to another checkout. Ask the person only when the destination is genuinely ambiguous: the request fits more than one project or repository and nothing in it tells them apart. Otherwise choose and say which you chose."
    } else {
        "\n\nTasks run in this chat's project by default. To send one to another registered repository or project, call orchestration_destinations and pass `project` and `repository` to orchestration_task_create; the host refuses anything unregistered."
    };
    let text = if reports.is_empty() {
        format!("{head} No eligible agent currently reports to you, so do the task yourself, directly in this chat. Do not create an orchestration run.")
    } else {
        let roster = reports
            .iter()
            .map(|a| {
                describe(
                    a,
                    &team,
                    true,
                    if lead.project_id.is_none() {
                        Some(&name_of)
                    } else {
                        None
                    },
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "{head} First decide which of these fits best, and say which one you chose and why in one or two sentences:\n\n\
1. Do it yourself: it fits your role and is one coherent piece of work. Do it directly in this chat. Do not create an orchestration run.\n\
2. Pass it on: one of your direct reports fits it clearly better. Delegate the whole task to them as one task.\n\
3. Split it: it has separable parts. Split it into tasks and give each to the best-suited direct report. You may keep a part for yourself and do it in this chat, but never write in a checkout a worker has.\n\n\
To pass on or split, call orchestration_run_create once with objective = the task, workspaceMode \"auto\" and workerDefaults {{\"access\": \"auto\"}}, then follow the masterBrief it returns. Create each task with orchestration_task_create and set `assignee` to the agent's id. The host applies that agent's provider, model, effort and access, so do not also pass `worker`. You can assign only to your direct reports, listed below; the host refuses anyone else. A report that manages agents of its own may split its task once more among them; nothing goes deeper than that.{routing}\n\n\
The person approves your plan before any worker starts. Create every task first, then reply with the plan as one short list (task, who, project and repository, why) and end your turn. The host starts the workers once the person approves. If they ask for changes, adjust the plan and end your turn again; a task added after approval waits for the person to approve it too. After that, the host tells you when work reports. When every task is complete, check the results and tell the person the outcome.\n\n\
Your direct reports:\n{roster}"
        )
    };
    record_lead(path, chat_key, &lead, project_id, cross_project)?;
    Ok(format!("{text}\n\n{}", memory_brief(&lead, &team)))
}

/// Append current host-authorized roster context to a lead's later turn. The
/// original brief is part of the provider's conversation history, so a roster
/// edit after that first message otherwise leaves a resumed or long-lived chat
/// obeying stale instructions. The same marker as the initial brief keeps this
/// host context out of the person-visible bubble.
pub fn refresh_turn_brief(
    path: &Path,
    chat_key: &str,
    text: String,
    projects: &[(String, String)],
) -> Result<String, String> {
    if text.contains(BRIEF_MARK) {
        return Ok(text);
    }
    let Some(record) = lead_for_chat(path, chat_key)? else {
        return Ok(text);
    };
    let mut team = list(path, None, true)?;
    let Some(lead) = team
        .iter()
        .find(|agent| agent.id == record.lead_id)
        .cloned()
    else {
        return Ok(text);
    };
    if lead.project_id.is_some() {
        team.retain(|agent| agent.visible_in(Some(&record.project_id)));
    }
    let name_of = |id: &str| {
        projects
            .iter()
            .find(|(project_id, _)| project_id == id)
            .map(|(_, name)| name.clone())
    };
    let reports = brief_reports(&team, &lead, projects);
    let roster = if reports.is_empty() {
        "No eligible agent currently reports to you. Do the task yourself in this chat and do not create an orchestration run. This supersedes any older roster in this conversation.".to_owned()
    } else {
        let rows = reports
            .iter()
            .map(|agent| {
                describe(
                    agent,
                    &team,
                    true,
                    if lead.project_id.is_none() {
                        Some(&name_of)
                    } else {
                        None
                    },
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "Your currently eligible direct reports are listed below. This host-authorized roster supersedes any older roster or instruction saying that no agent reports to you. You may create an orchestration run when passing on or splitting the person's task; the host still validates every direct-report edge and project destination.\n\n{rows}"
        )
    };
    Ok(format!(
        "{text}{BRIEF_MARK}Current roster for {}\n\n{roster}",
        lead.name
    ))
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
    let reports = eligible_direct_reports(&team, assignee_id);
    if reports.is_empty() {
        return Ok(None);
    }
    let roster = reports
        .iter()
        .map(|a| describe(a, &team, false, None))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(Some(format!(
        "You manage agents in OctiqFlow's org chart. If this task is one coherent piece of work you can do, do it yourself. If it has separable parts that your reports fit better, split it: call orchestration_task_create with runId '{run_id}', parentTaskId '{task_id}', and `assignee` set to a direct report's id, once per part. Do not pass `worker`; the host applies the agent's settings. Subtasks start without further approval and cannot be split again. A subtask runs in your task's project and repository unless you pass `project` and `repository`; you can route only to where you and the report may both work. After creating the subtasks, call orchestration_worker_report with outcome completed and a summary of the split. The host makes anything that waits on your task wait for your subtasks too.\n\nYour direct reports:\n{roster}"
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
            avatar: None,
            team_id: None,
            persistent_prompt: None,
        }
    }

    fn under(name: &str, project: Option<&str>, manager: &TeamAgent) -> TeamDraft {
        TeamDraft {
            reports_to: Some(manager.id.clone()),
            ..draft(name, project)
        }
    }

    fn team_draft(name: &str, project: Option<&str>) -> AgentTeamDraft {
        AgentTeamDraft {
            id: None,
            name: name.into(),
            project_id: project.map(Into::into),
        }
    }

    fn on(team: &AgentTeam, name: &str, project: Option<&str>) -> TeamDraft {
        TeamDraft {
            team_id: Some(team.id.clone()),
            ..draft(name, project)
        }
    }

    fn agent_named(path: &Path, name: &str) -> TeamAgent {
        list(path, None, true)
            .unwrap()
            .into_iter()
            .find(|a| a.name == name)
            .unwrap()
    }

    #[test]
    fn teams_are_created_renamed_and_named_uniquely_where_they_overlap() {
        let path = temp();
        let web = save_team(&path, team_draft(" Web ", None)).unwrap();
        assert_eq!(web.name, "Web");
        assert!(web.id.starts_with("team_"));
        assert!(save_team(&path, team_draft("", None)).is_err());
        assert!(save_team(&path, team_draft(&"x".repeat(61), None)).is_err());
        // A global name is seen everywhere, so a project team cannot reuse it.
        assert_eq!(
            save_team(&path, team_draft("web", Some("p1"))).unwrap_err(),
            "Another team is already called web."
        );
        let p1 = save_team(&path, team_draft("Data", Some("p1"))).unwrap();
        // Two projects' teams never meet, so they may share a name.
        save_team(&path, team_draft("Data", Some("p2"))).unwrap();
        let renamed = save_team(
            &path,
            AgentTeamDraft {
                id: Some(web.id.clone()),
                ..team_draft("Frontend", None)
            },
        )
        .unwrap();
        assert_eq!(
            (renamed.id.as_str(), renamed.name.as_str()),
            (web.id.as_str(), "Frontend")
        );
        assert_eq!(renamed.created_at, web.created_at);
        assert_eq!(teams(&path).unwrap().len(), 3);
        assert!(save_team(
            &path,
            AgentTeamDraft {
                id: Some("team_gone".into()),
                ..team_draft("Ghost", None)
            }
        )
        .is_err());
        // The team store survives the agents' own writes.
        save(&path, on(&p1, "Ada", Some("p1"))).unwrap();
        assert_eq!(teams(&path).unwrap().len(), 3);
    }

    #[test]
    fn membership_follows_project_scope() {
        let path = temp();
        let global = save_team(&path, team_draft("Global", None)).unwrap();
        let p1 = save_team(&path, team_draft("P1", Some("p1"))).unwrap();
        // Global agents join any team; project agents only global teams and
        // their own project's.
        assert_eq!(
            save(&path, on(&p1, "Ada", None)).unwrap().team_id,
            Some(p1.id.clone())
        );
        assert!(save(&path, on(&p1, "Bo", Some("p1"))).is_ok());
        assert!(save(&path, on(&global, "Cy", Some("p2"))).is_ok());
        assert_eq!(
            save(&path, on(&p1, "Di", Some("p2"))).unwrap_err(),
            "Di cannot be on P1: that team belongs to another project."
        );
        assert_eq!(
            save(
                &path,
                on(
                    &AgentTeam {
                        id: "team_gone".into(),
                        ..p1.clone()
                    },
                    "Ed",
                    None
                )
            )
            .unwrap_err(),
            "The chosen team no longer exists."
        );
        // Moving a member into another project while on a project team is
        // refused; so is narrowing a team past one of its members.
        let bo = agent_named(&path, "Bo");
        assert!(save(
            &path,
            TeamDraft {
                id: Some(bo.id.clone()),
                ..draft("Bo", Some("p2"))
            }
        )
        .is_err());
        assert!(save_team(
            &path,
            AgentTeamDraft {
                id: Some(global.id.clone()),
                ..team_draft("Global", Some("p1"))
            }
        )
        .unwrap_err()
        .starts_with("Cy is on this team"));
    }

    #[test]
    fn an_edit_that_says_nothing_about_the_team_keeps_it_and_empty_clears_it() {
        let path = temp();
        let web = save_team(&path, team_draft("Web", None)).unwrap();
        let ada = save(&path, on(&web, "Ada", None)).unwrap();
        let kept = save(
            &path,
            TeamDraft {
                id: Some(ada.id.clone()),
                model: "opus".into(),
                ..draft("Ada", None)
            },
        )
        .unwrap();
        assert_eq!(kept.team_id.as_deref(), Some(web.id.as_str()));
        let cleared = save(
            &path,
            TeamDraft {
                id: Some(ada.id.clone()),
                team_id: Some(String::new()),
                ..draft("Ada", None)
            },
        )
        .unwrap();
        assert_eq!(cleared.team_id, None);
    }

    #[test]
    fn removing_a_team_or_an_agent_ends_the_membership_and_nothing_else() {
        let path = temp();
        let web = save_team(&path, team_draft("Web", None)).unwrap();
        let ada = save(&path, on(&web, "Ada", None)).unwrap();
        let bo = save(
            &path,
            TeamDraft {
                reports_to: Some(ada.id.clone()),
                ..on(&web, "Bo", None)
            },
        )
        .unwrap();
        let cy = save(&path, on(&web, "Cy", None)).unwrap();
        let everyone = list(&path, None, true).unwrap();
        let teams_now = teams(&path).unwrap();
        let names = |me: &TeamAgent, all: &[TeamAgent], t: &[AgentTeam]| {
            teammates(all, t, me)
                .into_iter()
                .map(|a| a.name.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&ada, &everyone, &teams_now), ["Bo", "Cy"]);
        delete(&path, &cy.id).unwrap();
        let everyone = list(&path, None, true).unwrap();
        assert_eq!(names(&ada, &everyone, &teams_now), ["Bo"]);
        delete_team(&path, &web.id).unwrap();
        assert!(teams(&path).unwrap().is_empty());
        let everyone = list(&path, None, true).unwrap();
        assert!(everyone.iter().all(|a| a.team_id.is_none()));
        // The org chart is untouched by either.
        assert_eq!(
            agent_named(&path, "Bo").reports_to.as_deref(),
            Some(ada.id.as_str())
        );
        assert_eq!(bo.reports_to.as_deref(), Some(ada.id.as_str()));
        assert!(delete_team(&path, &web.id).is_err());
    }

    #[test]
    fn a_workers_peer_brief_lists_teammates_who_may_look_at_its_project() {
        let path = temp();
        let web = save_team(&path, team_draft("Web", None)).unwrap();
        let ada = save(&path, on(&web, "Ada", None)).unwrap();
        save(&path, on(&web, "Bo", Some("p1"))).unwrap();
        save(&path, on(&web, "Cy", Some("p2"))).unwrap();
        save(&path, draft("Di", None)).unwrap();
        let everyone = list(&path, None, true).unwrap();
        let all_teams = teams(&path).unwrap();
        let brief = peer_brief(&everyone, &all_teams, &ada, "p1").unwrap();
        assert!(brief.contains("You are on the team Web."));
        assert!(brief.contains("Bo — builds things"));
        assert!(brief.contains(&format!("id `{}`", agent_named(&path, "Bo").id)));
        assert!(brief.contains("Peers answer questions; they do not do the work."));
        assert!(brief.contains("orchestration_peer_ask"));
        // Not itself, not someone off the team, not a teammate who cannot
        // look at this project.
        assert!(!brief.contains("Ada —"));
        assert!(!brief.contains("Di —"));
        assert!(!brief.contains("Cy —"));
        // No brief at all without anyone to ask.
        let di = agent_named(&path, "Di");
        assert!(peer_brief(&everyone, &all_teams, &di, "p1").is_none());
        let cy = agent_named(&path, "Cy");
        assert!(peer_brief(&everyone, &all_teams, &cy, "p2")
            .unwrap()
            .contains("Ada —"));
    }

    fn temp() -> crate::test_dir::TestPath {
        crate::test_dir::TestPath::new("team", "team.json")
    }

    const PNG_URL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

    #[test]
    fn an_avatar_is_checked_kept_across_edits_and_removable() {
        let path = temp();
        let bad = save(
            &path,
            TeamDraft {
                avatar: Some("data:image/png;base64,PHN2Zz4=".into()),
                ..draft("Ada", None)
            },
        );
        assert!(bad.is_err(), "an SVG declared as PNG is refused");
        let ada = save(
            &path,
            TeamDraft {
                avatar: Some(PNG_URL.into()),
                ..draft("Ada", None)
            },
        )
        .unwrap();
        assert_eq!(ada.avatar.as_deref(), Some(PNG_URL));
        // A later edit that says nothing about the avatar keeps it, and a
        // change of model keeps the identity whole.
        let edited = save(
            &path,
            TeamDraft {
                id: Some(ada.id.clone()),
                model: "opus".into(),
                ..draft("Ada", None)
            },
        )
        .unwrap();
        assert_eq!(edited.avatar.as_deref(), Some(PNG_URL));
        assert_eq!(
            list(&path, None, true).unwrap()[0].avatar.as_deref(),
            Some(PNG_URL)
        );
        let cleared = save(
            &path,
            TeamDraft {
                id: Some(ada.id),
                avatar: Some(String::new()),
                ..draft("Ada", None)
            },
        )
        .unwrap();
        assert_eq!(cleared.avatar, None);
    }

    #[test]
    fn the_coordination_home_is_a_configured_workspace_id() {
        let path = temp();
        assert_eq!(home(&path).unwrap(), None);
        assert_eq!(
            set_home(&path, Some(" ws-general ")).unwrap().as_deref(),
            Some("ws-general")
        );
        assert_eq!(home(&path).unwrap().as_deref(), Some("ws-general"));
        // The head and the team are untouched by it.
        save(&path, draft("Ada", None)).unwrap();
        assert_eq!(home(&path).unwrap().as_deref(), Some("ws-general"));
        assert_eq!(set_home(&path, Some("")).unwrap(), None);
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
        let text = brief(
            &path,
            "chat:1",
            "p1",
            &ceo.id,
            "  Fix the login bug  ",
            false,
            &[],
        )
        .unwrap();
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
        let text = brief(
            &path,
            "chat:2",
            "p1",
            &solo.id,
            "Tidy the README",
            false,
            &[],
        )
        .unwrap();
        assert!(text.contains("do the task yourself"));
        assert!(!text.contains("orchestration_task_create"));

        let mut lead_only = under("Lead only", None, &solo);
        lead_only.model = "fable".into();
        let lead_only = save(&path, lead_only).unwrap();
        let text = brief(
            &path,
            "chat:lead-only-report",
            "p1",
            &solo.id,
            "Tidy it again",
            false,
            &[],
        )
        .unwrap();
        assert!(text.contains("No eligible agent currently reports to you"));
        assert!(!text.contains(&format!("id `{}`", lead_only.id)));
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

    /// The offset each checked zone has on 2026-09-28/29.
    const PROBE_ZONES: [(&str, i32); 4] = [
        ("UTC", 0),
        ("Asia/Kuala_Lumpur", 8 * 3600),
        ("Pacific/Kiritimati", 14 * 3600),
        ("America/Los_Angeles", -7 * 3600),
    ];

    #[test]
    fn a_local_date_turns_at_local_midnight_not_utc_midnight() {
        // 2026-09-29T00:00:00Z.
        let utc_midnight = 1_790_640_000_000_i64;
        for (zone, offset_secs) in PROBE_ZONES {
            let midnight = utc_midnight - i64::from(offset_secs) * 1000;
            let at = |ms| LocalNow { ms, offset_secs };
            assert_eq!(at(midnight - 1).date(), "2026-09-28", "{zone}");
            assert_eq!(at(midnight).date(), "2026-09-29", "{zone}");
        }
    }

    /// Runs this same test binary under each real zone name, so the OS's own
    /// zone database — not a number typed here — gives the offset and the date.
    #[cfg(unix)]
    #[test]
    fn this_machines_zone_decides_the_local_date() {
        let utc_midnight = 1_790_640_000_000_i64;
        if let Ok(zone) = std::env::var("OCTIQ_TZ_PROBE") {
            let (_, offset) = PROBE_ZONES.iter().find(|(z, _)| *z == zone).unwrap();
            let midnight = utc_midnight - i64::from(*offset) * 1000;
            assert_eq!(LocalNow::at(midnight).offset_secs, *offset, "{zone}");
            assert_eq!(
                LocalNow::at(midnight - 30_000).date(),
                "2026-09-28",
                "{zone}"
            );
            assert_eq!(
                LocalNow::at(midnight + 30_000).date(),
                "2026-09-29",
                "{zone}"
            );
            return;
        }
        for (zone, _) in PROBE_ZONES {
            let out = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "team::tests::this_machines_zone_decides_the_local_date",
                    "--test-threads=1",
                ])
                .env("TZ", zone)
                .env("OCTIQ_TZ_PROBE", zone)
                .output()
                .unwrap();
            let said = String::from_utf8_lossy(&out.stdout);
            assert!(out.status.success(), "{zone}: {said}");
            assert!(said.contains("1 passed"), "{zone} ran nothing: {said}");
        }
    }

    #[test]
    fn identity_comes_from_the_chat_and_reads_stop_at_direct_reports() {
        let path = temp();
        let ceo = save(&path, draft("Ceo", None)).unwrap();
        let ada = save(&path, under("Ada", None, &ceo)).unwrap();
        let dev = save(&path, under("Dev", None, &ada)).unwrap();
        brief(&path, "chat:lead", "p1", &ceo.id, "Do it", false, &[]).unwrap();
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
    fn a_memory_read_loads_the_newest_entries_and_startline_still_pages_the_note() {
        // A 962-line note used to load as its first 200 lines: its oldest.
        let base = crate::test_dir::TestDir::new("memory");
        let root = base.join("vault");
        std::fs::create_dir_all(&root).unwrap();
        let vault = crate::memory_vault::Vault::at(base.join("profile"));
        vault
            .configure(crate::memory_vault::Config {
                path: root.to_string_lossy().into_owned(),
                writable: true,
            })
            .unwrap();
        let path = temp();
        let nova = save(&path, draft("Nova", None)).unwrap();
        let team = list(&path, None, true).unwrap();
        for day in 1..=28 {
            let text = format!("Lesson {day}.\n{}", "detail\n".repeat(20));
            memory_append(
                &vault,
                "chat:lead",
                &nova,
                &text,
                Some(&format!("2026-09-{day:02}")),
                &format!("r{day}"),
            )
            .result(&nova)
            .unwrap();
        }

        let loaded = memory_read(&vault, "chat:lead", &nova, &team, None, None).unwrap();
        let content = loaded["content"].as_str().unwrap();
        assert!(content.contains("Lesson 28."), "the newest entry is loaded");
        assert!(!content.contains("Lesson 1.\n"), "the oldest is left out");
        assert!(content.contains("# Nova — memory"));
        assert_eq!(loaded["entries"], 28);
        assert_eq!(loaded["hasLessons"], false);
        assert!(loaded["olderEntriesFrom"].as_u64().is_some());
        assert!(loaded["lessonsHint"].is_string());
        assert!(loaded["revision"].is_string() && loaded["totalLines"].as_u64() > Some(600));
        assert_eq!(loaded["agent"], "Nova");

        let from = loaded["olderEntriesFrom"].as_u64().unwrap();
        let page = memory_read(&vault, "chat:lead", &nova, &team, None, Some(from)).unwrap();
        assert!(page["content"]
            .as_str()
            .unwrap()
            .starts_with("## 2026-09-01\n\nLesson 1."));
    }

    #[test]
    fn a_renamed_agents_memory_header_names_it_and_its_history_is_untouched() {
        // Feedback 10cc5a23: after Settings renamed Maya to Mango Juice, the
        // note still read "agent: Maya" and "# Maya — memory".
        let base = crate::test_dir::TestDir::new("memory");
        let root = base.join("vault");
        std::fs::create_dir_all(&root).unwrap();
        let vault = crate::memory_vault::Vault::at(base.join("profile"));
        vault
            .configure(crate::memory_vault::Config {
                path: root.to_string_lossy().into_owned(),
                writable: true,
            })
            .unwrap();
        let path = temp();
        let maya = save(&path, draft("Maya", None)).unwrap();
        ensure_memory(&vault, "octiq:team", &maya).unwrap();
        memory_append(
            &vault,
            "chat:lead",
            &maya,
            "Maya decided X.",
            Some("2026-09-25"),
            "r1",
        )
        .result(&maya)
        .unwrap();

        let mut renamed = draft("Mango Juice", None);
        renamed.id = Some(maya.id.clone());
        let mango = save(&path, renamed).unwrap();
        assert_eq!(
            mango.memory_note, maya.memory_note,
            "the note path is fixed"
        );
        ensure_memory(&vault, "octiq:team", &mango).unwrap();
        // Idempotent: a second save changes nothing.
        ensure_memory(&vault, "octiq:team", &mango).unwrap();

        let text = std::fs::read_to_string(root.join(mango.memory_note.as_ref().unwrap())).unwrap();
        assert!(text.contains("agent: Mango Juice\n"), "{text}");
        assert!(text.contains("# Mango Juice — memory\n"), "{text}");
        assert!(
            text.contains("Working memory for Mango Juice, a registered OctiqFlow agent."),
            "{text}"
        );
        assert!(text.contains(&format!("agent-id: {}", maya.id)));
        assert!(text.contains("Maya decided X."), "history is kept: {text}");
        assert!(!text.contains("agent: Maya\n"), "{text}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_the_seeded_header_is_ever_relabelled() {
        let seeded = memory_seed(&TeamAgent {
            name: "Ryan".into(),
            ..save(&temp(), draft("Ryan", None)).unwrap()
        });
        let (old, new) = relabel_memory_header(&seeded, "Potato Juice").unwrap();
        assert!(seeded.starts_with(&old));
        assert!(new.contains("agent: Potato Juice") && new.contains("# Potato Juice — memory"));
        assert!(
            relabel_memory_header(&seeded, "Ryan").is_none(),
            "already right"
        );
        // A note OctiqFlow did not seed is left alone.
        assert!(relabel_memory_header("# My notes\n\nagent: Ryan", "Potato").is_none());
        // Nothing past the first dated entry is looked at.
        let later = format!("{seeded}\n## 2026-09-25\n\n# Ryan — memory\n");
        let (old, _) = relabel_memory_header(&later, "Potato").unwrap();
        assert!(!old.contains("## 2026-09-25"));
    }

    #[test]
    fn briefs_carry_the_memory_instructions() {
        let path = temp();
        let ceo = save(&path, draft("Ceo", None)).unwrap();
        save(&path, under("Ada", None, &ceo)).unwrap();
        let text = brief(&path, "chat:1", "p1", &ceo.id, "Ship it", false, &[]).unwrap();
        assert!(text.contains("vault_agent_memory_read"));
        assert!(text.contains("direct reports' memories"));
        assert!(text.contains("Ada"));
    }

    #[test]
    fn the_head_is_one_configured_global_agent() {
        let path = temp();
        assert!(head(&path).unwrap().is_none());
        let ryan = save(&path, draft("Ryan", None)).unwrap();
        let local = save(&path, draft("Local", Some("p1"))).unwrap();
        assert!(set_head(&path, Some(&local.id))
            .unwrap_err()
            .contains("every project"));
        set_head(&path, Some(&ryan.id)).unwrap();
        assert_eq!(head(&path).unwrap().unwrap().id, ryan.id);
        // The head cannot quietly become a project agent.
        let mut moved = draft("Ryan", Some("p1"));
        moved.id = Some(ryan.id.clone());
        assert!(save(&path, moved).unwrap_err().contains("stays global"));
        // Removing it leaves no head rather than a dangling one.
        delete(&path, &ryan.id).unwrap();
        assert!(head(&path).unwrap().is_none());
        assert!(set_head(&path, None).unwrap().is_none());
    }

    #[test]
    fn the_head_brief_spans_projects_and_asks_for_destinations() {
        let path = temp();
        let ryan = save(&path, draft("Ryan", None)).unwrap();
        let maya = save(&path, under("Maya", None, &ryan)).unwrap();
        let sam = save(&path, under("Sam", Some("p2"), &ryan)).unwrap();
        save(&path, draft("Zed", Some("p3"))).unwrap();
        let projects = [
            ("p1".to_owned(), "General".to_owned()),
            ("p2".to_owned(), "Shop".to_owned()),
        ];
        // Not the configured head: refused.
        assert!(brief(&path, "chat:cto", "p1", &ryan.id, "Ship", true, &projects).is_err());
        set_head(&path, Some(&ryan.id)).unwrap();
        let text = brief(
            &path,
            "chat:cto",
            "p1",
            &ryan.id,
            "Ship checkout",
            true,
            &projects,
        )
        .unwrap();
        let (_, rest) = text.split_once(BRIEF_MARK).unwrap();
        // Sam works only in Shop, yet is still Ryan's report from General.
        assert!(rest.contains(&format!("id `{}`", maya.id)));
        assert!(rest.contains(&format!("id `{}`", sam.id)));
        assert!(rest.contains("works only in project Shop"));
        assert!(rest.contains("works in any project"));
        assert!(rest.contains("orchestration_destinations"));
        assert!(rest.contains("genuinely ambiguous"));
        assert!(!rest.contains("Zed"));
        let record = lead_for_chat(&path, "chat:cto").unwrap().unwrap();
        assert!(record.cross_project);
        // Reopening keeps the lead; another agent never takes over its history.
        assert!(brief(&path, "chat:cto", "p1", &ryan.id, "More", true, &projects).is_ok());
        set_head(&path, Some(&maya.id)).unwrap();
        let err = brief(&path, "chat:cto", "p1", &maya.id, "Hi", true, &projects).unwrap_err();
        assert!(err.contains("belongs to Ryan"), "{err}");
        assert_eq!(
            lead_for_chat(&path, "chat:cto").unwrap().unwrap().lead_id,
            ryan.id
        );
    }

    #[test]
    fn a_new_conversation_goes_only_to_an_agent_reporting_to_the_person() {
        let path = temp();
        let ryan = save(&path, draft("Ryan", None)).unwrap();
        let vera = save(&path, draft("Vera", Some("p2"))).unwrap();
        let maya = save(&path, under("Maya", Some("p2"), &ryan)).unwrap();
        let glen = save(&path, under("Glen", None, &ryan)).unwrap();
        let projects = [
            ("p1".to_owned(), "General".to_owned()),
            ("p2".to_owned(), "Shop".to_owned()),
        ];
        set_head(&path, Some(&ryan.id)).unwrap();

        // A project-scoped agent at the top is a lead in its own project,
        // briefed under its own name, and not as the cross-project head.
        let text = brief(&path, "chat:vera", "p2", &vera.id, "Tidy", false, &projects).unwrap();
        assert!(text.contains("Lead: Vera"), "{text}");
        let record = lead_for_chat(&path, "chat:vera").unwrap().unwrap();
        assert_eq!(
            (record.lead_id.as_str(), record.project_id.as_str()),
            (vera.id.as_str(), "p2")
        );
        assert!(!record.cross_project);
        assert!(brief(
            &path,
            "chat:vera-x",
            "p2",
            &vera.id,
            "Tidy",
            true,
            &projects
        )
        .is_err());

        // Someone's report is never handed a new conversation, global or not.
        for (report, project) in [(&maya, "p2"), (&glen, "p1")] {
            let key = format!("chat:{}", report.name);
            let err = brief(&path, &key, project, &report.id, "Hi", false, &projects).unwrap_err();
            assert!(err.contains("reports to Ryan"), "{err}");
            assert!(lead_for_chat(&path, &key).unwrap().is_none());
        }

        // A conversation that already belongs to a lead keeps it, even after
        // that lead is moved under someone else.
        save(
            &path,
            TeamDraft {
                id: Some(vera.id.clone()),
                ..under("Vera", Some("p2"), &ryan)
            },
        )
        .unwrap();
        assert!(brief(&path, "chat:vera", "p2", &vera.id, "More", false, &projects).is_ok());
    }

    #[test]
    fn a_global_lead_in_a_project_chat_sees_cross_project_reports() {
        let path = temp();
        let ryan = save(&path, draft("Ryan", None)).unwrap();
        let maya = save(&path, under("Maya", Some("p2"), &ryan)).unwrap();
        let projects = [
            ("p1".to_owned(), "General".to_owned()),
            ("p2".to_owned(), "OctiqFlow".to_owned()),
        ];

        let text = brief(
            &path,
            "chat:project-lead",
            "p1",
            &ryan.id,
            "Fix the roster",
            false,
            &projects,
        )
        .unwrap();

        assert!(text.contains(&format!("id `{}`", maya.id)), "{text}");
        assert!(text.contains("works only in project OctiqFlow"), "{text}");
        assert!(!text.contains("No agent reports to you"), "{text}");
    }

    #[test]
    fn later_turns_refresh_added_removed_and_reassigned_reports() {
        let path = temp();
        let ryan = save(&path, draft("Ryan", None)).unwrap();
        let projects = [
            ("p1".to_owned(), "General".to_owned()),
            ("p2".to_owned(), "OctiqFlow".to_owned()),
        ];
        let first = brief(
            &path,
            "chat:changing-roster",
            "p1",
            &ryan.id,
            "Start",
            false,
            &projects,
        )
        .unwrap();
        assert!(
            first.contains("No eligible agent currently reports to you"),
            "{first}"
        );

        let maya = save(&path, under("Maya", Some("p2"), &ryan)).unwrap();
        let added = refresh_turn_brief(&path, "chat:changing-roster", "Continue".into(), &projects)
            .unwrap();
        assert_eq!(added.split_once(BRIEF_MARK).unwrap().0, "Continue");
        assert!(added.contains(&format!("id `{}`", maya.id)), "{added}");
        assert!(added.contains("works only in project OctiqFlow"), "{added}");
        assert!(added.contains("supersedes any older roster"), "{added}");

        let mut reassigned = draft("Maya", Some("p2"));
        reassigned.id = Some(maya.id);
        save(&path, reassigned).unwrap();
        let removed = refresh_turn_brief(
            &path,
            "chat:changing-roster",
            "Continue again".into(),
            &projects,
        )
        .unwrap();
        assert!(
            removed.contains("No eligible agent currently reports to you"),
            "{removed}"
        );
        assert!(!removed.contains("id `"), "{removed}");
    }

    #[test]
    fn roster_refresh_leaves_non_lead_and_initial_brief_text_alone() {
        let path = temp();
        let ryan = save(&path, draft("Ryan", None)).unwrap();
        let initial = brief(&path, "chat:lead", "p1", &ryan.id, "Start", false, &[]).unwrap();
        assert_eq!(
            refresh_turn_brief(&path, "chat:other", "Hello".into(), &[]).unwrap(),
            "Hello"
        );
        assert_eq!(
            refresh_turn_brief(&path, "chat:lead", initial.clone(), &[]).unwrap(),
            initial
        );
    }

    #[test]
    fn project_scoped_managers_keep_project_scoped_rosters() {
        let path = temp();
        let ceo = save(&path, draft("Ceo", None)).unwrap();
        let local = save(&path, draft("Local lead", Some("p1"))).unwrap();
        let local_dev = save(&path, under("Local dev", Some("p1"), &local)).unwrap();
        let foreign = save(&path, under("Foreign lead", Some("p2"), &ceo)).unwrap();
        let foreign_dev = save(&path, under("Foreign dev", Some("p2"), &foreign)).unwrap();

        let text = brief(
            &path,
            "chat:local",
            "p1",
            &local.id,
            "Local work",
            false,
            &[("p1".into(), "One".into()), ("p2".into(), "Two".into())],
        )
        .unwrap();

        assert!(text.contains(&format!("id `{}`", local_dev.id)), "{text}");
        assert!(!text.contains(&foreign.id), "{text}");
        assert!(!text.contains(&foreign_dev.id), "{text}");
        assert!(brief(
            &path,
            "chat:wrong-project",
            "p2",
            &local.id,
            "Wrong project",
            false,
            &[]
        )
        .unwrap_err()
        .contains("no longer works in this project"));
    }

    #[test]
    fn a_front_desk_is_created_in_one_step_on_the_smallest_model_at_its_lowest_effort() {
        let path = temp();
        assert!(
            front_desk(&path).unwrap().is_none(),
            "none until the person makes one"
        );
        let desk = create_front_desk(&path, FrontDeskDraft::default()).unwrap();
        assert_eq!(desk.agent, ChatAgent::Claude);
        assert_eq!(desk.model, FRONT_DESK_MODEL);
        assert_eq!(desk.model, "haiku");
        assert_eq!(desk.effort.as_deref(), Some("low"));
        assert_eq!(desk.access, Access::Read);
        assert!(desk.project_id.is_none() && desk.reports_to.is_none());
        assert_eq!(desk.role, FRONT_DESK_ROLE);
        assert_eq!(front_desk(&path).unwrap().unwrap().id, desk.id);

        // The person picks Codex: the browser sends its smallest model.
        let other = temp();
        let codex = create_front_desk(
            &other,
            FrontDeskDraft {
                name: Some("Reception".into()),
                agent: Some(ChatAgent::Codex),
                model: Some("gpt-5.6-luna".into()),
                effort: None,
            },
        )
        .unwrap();
        assert_eq!(
            (codex.name.as_str(), codex.model.as_str()),
            ("Reception", "gpt-5.6-luna")
        );
        assert_eq!(codex.effort.as_deref(), Some("low"));
        // Codex has no default model here to fall back on.
        assert!(create_front_desk(
            &temp(),
            FrontDeskDraft {
                agent: Some(ChatAgent::Codex),
                ..FrontDeskDraft::default()
            }
        )
        .is_err());
    }

    #[test]
    fn a_changed_front_desk_model_is_what_the_next_front_desk_chat_reads() {
        let path = temp();
        let desk = create_front_desk(&path, FrontDeskDraft::default()).unwrap();
        save(
            &path,
            TeamDraft {
                id: Some(desk.id.clone()),
                model: "sonnet".into(),
                effort: Some("medium".into()),
                access: Some(desk.access),
                role: desk.role.clone(),
                ..draft(&desk.name, None)
            },
        )
        .unwrap();
        let now = front_desk(&path).unwrap().unwrap();
        assert_eq!(
            (now.model.as_str(), now.effort.as_deref()),
            ("sonnet", Some("medium"))
        );
        // Read from the store each time: nothing to restart.
        assert_eq!(now.id, desk.id);
    }

    #[test]
    fn the_head_managers_and_project_agents_cannot_be_the_front_desk() {
        let path = temp();
        let cto = save(&path, draft("Potato", None)).unwrap();
        set_head(&path, Some(&cto.id)).unwrap();
        assert!(set_front_desk(&path, Some(&cto.id))
            .unwrap_err()
            .contains("lead you talk to across projects"));
        let lead = save(&path, draft("Lead", None)).unwrap();
        save(&path, under("Worker", None, &lead)).unwrap();
        assert!(set_front_desk(&path, Some(&lead.id))
            .unwrap_err()
            .contains("manages other agents"));
        let local = save(&path, draft("Local", Some("p1"))).unwrap();
        assert!(set_front_desk(&path, Some(&local.id))
            .unwrap_err()
            .contains("global agent"));
        assert!(front_desk(&path).unwrap().is_none());

        // And the other way round: the front desk stays a router.
        let desk = save(&path, draft("Desk", None)).unwrap();
        set_front_desk(&path, Some(&desk.id)).unwrap();
        assert!(set_head(&path, Some(&desk.id))
            .unwrap_err()
            .contains("front desk"));
        assert!(save(&path, under("Helper", None, &desk))
            .unwrap_err()
            .contains("no agent can report to it"));
        let mut moved = draft("Desk", Some("p1"));
        moved.id = Some(desk.id.clone());
        assert!(save(&path, moved).unwrap_err().contains("stays global"));
        // Clearing and removing leave no front desk behind.
        assert!(set_front_desk(&path, None).unwrap().is_none());
        set_front_desk(&path, Some(&desk.id)).unwrap();
        delete(&path, &desk.id).unwrap();
        assert!(front_desk(&path).unwrap().is_none());
    }

    #[test]
    fn the_front_desk_brief_carries_the_whole_roster_and_records_a_hidden_chat() {
        let path = temp();
        let cto = save(&path, draft("Potato", None)).unwrap();
        set_head(&path, Some(&cto.id)).unwrap();
        // Agents reporting to the person, to the head, and in one project.
        let starfall = save(
            &path,
            TeamDraft {
                role: "Writes the Starfall novel chapters.\nKeeps the tone.".into(),
                ..draft("Vesper", Some("p-star"))
            },
        )
        .unwrap();
        let report = save(&path, under("Mango", Some("p-app"), &cto)).unwrap();
        let desk = create_front_desk(&path, FrontDeskDraft::default()).unwrap();
        let projects = [
            ("p-app".to_owned(), "App".to_owned()),
            ("p-star".to_owned(), "starfall-novel".to_owned()),
            ("p-gen".to_owned(), "General".to_owned()),
        ];
        let text = brief(
            &path,
            "chat:desk1",
            "p-gen",
            &desk.id,
            "Draft chapter 3",
            false,
            &projects,
        )
        .unwrap();
        let (person, host) = text.split_once(BRIEF_MARK).unwrap();
        assert_eq!(person, "Draft chapter 3");
        assert!(
            host.starts_with(&format!("Front desk: {}", desk.name)),
            "{host}"
        );
        for agent in [&cto, &starfall, &report] {
            assert!(
                host.contains(&format!("id `{}` · {}", agent.id, agent.name)),
                "{host}"
            );
        }
        assert!(
            !host.contains(&format!("id `{}`", desk.id)),
            "not itself: {host}"
        );
        assert!(
            host.contains("Writes the Starfall novel chapters. Keeps the tone."),
            "{host}"
        );
        assert!(
            host.contains("works only in project starfall-novel (id `p-star`)"),
            "{host}"
        );
        assert!(host.contains("reports to Potato"), "{host}");
        assert!(host.contains("the person's lead across projects"), "{host}");
        assert!(host.contains("id `p-gen` · General (home"), "{host}");
        assert!(host.contains("ask the person one short question"), "{host}");
        assert!(host.contains("fits no registered agent"), "{host}");
        assert!(host.contains("route_chat"), "{host}");
        // Recorded as a front-desk chat, never as anyone's lead.
        assert!(is_front_desk_chat(&path, "chat:desk1"));
        assert!(lead_for_chat(&path, "chat:desk1").unwrap().is_none());
        assert!(text.len() < 20_000, "bounded");
    }

    #[test]
    fn designating_a_front_desk_changes_none_of_its_earlier_chats() {
        let path = temp();
        let agent = save(&path, draft("Desk", None)).unwrap();
        // An ordinary conversation with it, before it is the front desk.
        brief(&path, "chat:before", "p1", &agent.id, "Hello", false, &[]).unwrap();
        set_front_desk(&path, Some(&agent.id)).unwrap();
        // That chat keeps its lead brief and stays visible.
        let later = brief(&path, "chat:before", "p1", &agent.id, "Again", false, &[]).unwrap();
        assert!(!later.contains("Front desk:"), "{later}");
        assert!(!is_front_desk_chat(&path, "chat:before"));
        // A new one is a front-desk chat; clearing the designation keeps it hidden.
        brief(&path, "chat:after", "p1", &agent.id, "Hello", false, &[]).unwrap();
        assert!(is_front_desk_chat(&path, "chat:after"));
        set_front_desk(&path, None).unwrap();
        assert!(is_front_desk_chat(&path, "chat:after"));
        let plain = brief(&path, "chat:third", "p1", &agent.id, "Hello", false, &[]).unwrap();
        assert!(
            !plain.contains("Front desk:"),
            "no longer the desk: {plain}"
        );
    }

    #[test]
    fn a_front_desk_chat_remembers_its_provider_sessions_and_nothing_else_does() {
        let path = temp();
        let desk = create_front_desk(&path, FrontDeskDraft::default()).unwrap();
        brief(&path, "chat:desk1", "p1", &desk.id, "Hi", false, &[]).unwrap();
        note_front_desk_session(&path, "chat:desk1", ChatAgent::Claude, "sess-1");
        note_front_desk_session(&path, "chat:desk1", ChatAgent::Claude, "sess-1");
        note_front_desk_session(&path, "chat:desk1", ChatAgent::Codex, "sess-1");
        note_front_desk_session(&path, "chat:desk1", ChatAgent::Claude, "sess-2");
        note_front_desk_session(&path, "chat:ordinary", ChatAgent::Claude, "sess-3");
        let chats = front_desk_chats(&path);
        assert_eq!(chats.len(), 1);
        let session = |provider, id: &str| FrontDeskSession {
            provider,
            session_id: id.into(),
        };
        assert_eq!(
            chats[0].sessions,
            vec![
                session(ChatAgent::Claude, "sess-1"),
                session(ChatAgent::Codex, "sess-1"),
                session(ChatAgent::Claude, "sess-2"),
            ]
        );
        assert!(chats[0].session_ids.is_empty(), "never the old shape");
    }

    /// A record written before sessions carried their provider still reads,
    /// with its ids kept apart for `agent_history::without_front_desks`.
    #[test]
    fn a_front_desk_record_without_providers_still_reads() {
        let path = temp();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"agents":[],"front_desk_chats":[{"chatKey":"chat:old","agentId":"a1","sessionIds":["sess-old"],"createdAt":1}]}"#,
        )
        .unwrap();
        let chats = front_desk_chats(&path);
        assert_eq!(chats.len(), 1);
        assert!(chats[0].sessions.is_empty());
        assert_eq!(chats[0].session_ids, vec!["sess-old"]);
        // Learning a new session keeps the old ids where they were.
        note_front_desk_session(&path, "chat:old", ChatAgent::Codex, "sess-new");
        let chats = front_desk_chats(&path);
        assert_eq!(chats[0].session_ids, vec!["sess-old"]);
        assert_eq!(chats[0].sessions.len(), 1);
    }

    const POLICY: &str = "Work in a git worktree. Never push without asking.";
    const STANDING: &str = "Runbook: build with pnpm, then cargo.";

    /// `draft`, carrying standing instructions.
    fn standing(name: &str, project: Option<&str>, text: &str) -> TeamDraft {
        TeamDraft {
            persistent_prompt: Some(text.into()),
            ..draft(name, project)
        }
    }

    /// Where `needle` sits in `hay`, failing the test when it is absent.
    fn at(hay: &str, needle: &str) -> usize {
        hay.find(needle)
            .unwrap_or_else(|| panic!("{needle:?} missing from {hay}"))
    }

    /// The policy, then the standing instructions, then the role.
    fn in_order(text: &str, role: &str) {
        let policy = at(
            text,
            "Shared agent policy (the person's rules for every agent):",
        );
        let rules = at(text, POLICY);
        let standing = at(text, "Standing instructions for ");
        let runbook = at(text, STANDING);
        let role = at(text, role);
        assert!(
            policy < rules && rules < standing && standing < runbook && runbook < role,
            "{text}"
        );
    }

    /// A team file written before either field existed reads as having
    /// neither, and saving it again leaves them out rather than writing
    /// empty values.
    #[test]
    fn a_team_file_without_the_policy_or_persistent_prompts_still_reads() {
        let path = temp();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"agents":[{"id":"agent_old","name":"Old","role":"r","agent":"claude","model":"sonnet","access":"auto","createdAt":1,"updatedAt":1}]}"#,
        )
        .unwrap();
        let old = agent_named(&path, "Old");
        assert_eq!(old.persistent_prompt, "");
        assert_eq!(policy(&path).unwrap(), AgentPolicy::default());
        save(
            &path,
            TeamDraft {
                id: Some(old.id.clone()),
                ..draft("Old", None)
            },
        )
        .unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("persistentPrompt"), "{raw}");
        assert!(!raw.contains("agent_policy"), "{raw}");
    }

    #[test]
    fn the_agent_policy_is_saved_trimmed_capped_and_cleared() {
        let path = temp();
        let saved = set_policy(&path, &format!("  {POLICY}\n")).unwrap();
        assert_eq!(saved.text, POLICY);
        assert!(saved.updated_at > 0);
        assert_eq!(policy(&path).unwrap(), saved);
        // Stored beside the agents, under its own key.
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"agent_policy\""), "{raw}");

        assert!(set_policy(&path, &"x".repeat(AGENT_POLICY_MAX)).is_ok());
        assert_eq!(
            set_policy(&path, &"x".repeat(AGENT_POLICY_MAX + 1)).unwrap_err(),
            "The agent policy is longer than 4000 characters."
        );
        assert_eq!(policy(&path).unwrap().text.len(), AGENT_POLICY_MAX);

        let cleared = set_policy(&path, "").unwrap();
        assert_eq!(cleared.text, "");
        assert_eq!(policy(&path).unwrap().text, "");
    }

    /// What the person approved was a change to one version of the policy.
    #[test]
    fn a_policy_change_waits_on_the_version_it_was_proposed_against() {
        let path = temp();
        let first = set_policy(&path, "First").unwrap();
        let second = set_policy_unchanged(&path, "Second", first.updated_at).unwrap();
        assert!(second.updated_at > first.updated_at);
        let stale = set_policy_unchanged(&path, "Third", first.updated_at).unwrap_err();
        assert!(stale.contains("changed while this waited"), "{stale}");
        assert_eq!(policy(&path).unwrap().text, "Second");
    }

    #[test]
    fn a_persistent_prompt_is_capped_kept_when_absent_and_cleared_by_empty() {
        let path = temp();
        let long = "p".repeat(PERSISTENT_PROMPT_MAX);
        let ada = save(&path, standing("Ada", None, &long)).unwrap();
        assert_eq!(ada.persistent_prompt, long);
        assert_eq!(
            save(&path, standing("Bo", None, &format!("{long}p"))).unwrap_err(),
            "The agent's persistent prompt is longer than 8000 characters."
        );
        // The role keeps its own, smaller cap.
        let wordy = TeamDraft {
            role: "r".repeat(ROLE_MAX + 1),
            ..draft("Cy", None)
        };
        assert_eq!(
            save(&path, wordy).unwrap_err(),
            "The agent's role is longer than 2000 characters."
        );
        // An edit that does not mention it keeps it, as the avatar is kept.
        let renamed = save(
            &path,
            TeamDraft {
                id: Some(ada.id.clone()),
                ..draft("Ada Lovelace", None)
            },
        )
        .unwrap();
        assert_eq!(renamed.persistent_prompt, long);
        let replaced = save(
            &path,
            TeamDraft {
                id: Some(ada.id.clone()),
                ..standing("Ada Lovelace", None, &format!("  {STANDING} "))
            },
        )
        .unwrap();
        assert_eq!(replaced.persistent_prompt, STANDING);
        let cleared = save(
            &path,
            TeamDraft {
                id: Some(ada.id.clone()),
                ..standing("Ada Lovelace", None, "")
            },
        )
        .unwrap();
        assert_eq!(cleared.persistent_prompt, "");
        // It survives a fresh read of the file.
        save(
            &path,
            TeamDraft {
                id: Some(ada.id.clone()),
                ..standing("Ada Lovelace", None, STANDING)
            },
        )
        .unwrap();
        assert_eq!(
            agent_named(&path, "Ada Lovelace").persistent_prompt,
            STANDING
        );
    }

    #[test]
    fn the_standing_brief_leaves_out_what_is_empty() {
        let path = temp();
        let plain = save(&path, draft("Plain", None)).unwrap();
        assert_eq!(standing_brief("", &plain), "");
        assert_eq!(standing_brief("  \n", &plain), "");
        let only_policy = standing_brief(POLICY, &plain);
        assert!(only_policy.contains(POLICY));
        assert!(!only_policy.contains("Standing instructions"));
        assert!(only_policy.ends_with("\n\n"));
        let ruled = save(&path, standing("Ruled", None, STANDING)).unwrap();
        let only_standing = standing_brief("", &ruled);
        assert!(!only_standing.contains("Shared agent policy"));
        assert!(only_standing.starts_with("Standing instructions for Ruled:\n"));
        // A worker with neither is told only who it is.
        assert_eq!(
            worker_identity("", &plain),
            "You are Plain, the registered OctiqFlow agent this task is assigned to. Your role: builds things."
        );
    }

    /// A conversation the person starts, a handover and a front-desk route
    /// all brief the agent the same way: policy, standing instructions, role.
    #[test]
    fn every_lead_brief_carries_the_policy_then_standing_instructions_then_the_role() {
        let path = temp();
        set_policy(&path, POLICY).unwrap();
        let lead = save(&path, standing("Lead", None, STANDING)).unwrap();
        let briefs = [
            brief(&path, "chat:direct", "p1", &lead.id, "Fix it", false, &[]).unwrap(),
            handover_brief(&path, "chat:handed", "p1", &lead.id, "Fix it", &[]).unwrap(),
            route_brief(&path, "chat:routed", "p1", &lead.id, "Fix it", false, &[]).unwrap(),
        ];
        for text in briefs {
            let (person, host) = text.split_once(BRIEF_MARK).unwrap();
            // The person's bubble is still only their words.
            assert_eq!(person, "Fix it");
            assert!(
                host.starts_with("Lead: Lead\n\nShared agent policy"),
                "{host}"
            );
            in_order(host, "Your role: builds things.");
        }
        // Without either, the brief is what it always was.
        set_policy(&path, "").unwrap();
        let plain = save(&path, draft("Plain", None)).unwrap();
        let text = brief(&path, "chat:plain", "p1", &plain.id, "Fix it", false, &[]).unwrap();
        assert!(text.contains(&format!(
            "{BRIEF_MARK}Lead: Plain\n\nYou are Plain, a registered agent"
        )));
        assert!(!text.contains("Shared agent policy"));
        assert!(!text.contains("Standing instructions"));
    }

    #[test]
    fn the_front_desk_is_briefed_with_the_policy_and_lists_roles_only() {
        let path = temp();
        set_policy(&path, POLICY).unwrap();
        let worker = save(&path, standing("Vesper", None, "SECRET-RUNBOOK")).unwrap();
        let desk = create_front_desk(&path, FrontDeskDraft::default()).unwrap();
        save(
            &path,
            TeamDraft {
                id: Some(desk.id.clone()),
                role: FRONT_DESK_ROLE.into(),
                ..standing(&desk.name, None, STANDING)
            },
        )
        .unwrap();
        let text = brief(&path, "chat:desk", "p1", &desk.id, "Help", false, &[]).unwrap();
        let (_, host) = text.split_once(BRIEF_MARK).unwrap();
        in_order(host, "Your role: Listens to what the person wants");
        // The roster carries each agent's role, never its standing rules.
        assert!(host.contains(&format!("id `{}` · Vesper — builds things", worker.id)));
        assert!(!host.contains("SECRET-RUNBOOK"), "{host}");
    }

    /// An orchestration worker is told who it is after the task's dispatch:
    /// the policy, its standing instructions and its role, then its memory.
    #[test]
    fn a_worker_brief_carries_the_policy_standing_instructions_and_role() {
        let path = temp();
        set_policy(&path, POLICY).unwrap();
        let ada = save(&path, standing("Ada", None, STANDING)).unwrap();
        let (me, text) = assignee_brief(&path, &ada.id, "p1").unwrap();
        assert_eq!(me.id, ada.id);
        in_order(&text, "You are Ada, the registered OctiqFlow agent");
        assert!(
            at(&text, "Your role: builds things.") < at(&text, "vault_agent_memory_read"),
            "{text}"
        );
        assert!(assignee_brief(&path, "agent_gone", "p1").is_none());
    }

    /// Wherever an agent is listed to ANOTHER agent, only its role shows.
    #[test]
    fn rosters_list_the_role_and_never_the_persistent_prompt() {
        let path = temp();
        set_policy(&path, POLICY).unwrap();
        let lead = save(&path, draft("Lead", None)).unwrap();
        let web = save_team(&path, team_draft("Web", None)).unwrap();
        let manager = save(
            &path,
            TeamDraft {
                team_id: Some(web.id.clone()),
                ..under("Mid", None, &lead)
            },
        )
        .unwrap();
        let hidden = "HIDDEN-STANDING-RULES";
        save(
            &path,
            TeamDraft {
                persistent_prompt: Some(hidden.into()),
                team_id: Some(web.id.clone()),
                ..under("Report", None, &manager)
            },
        )
        .unwrap();
        save(
            &path,
            TeamDraft {
                persistent_prompt: Some(hidden.into()),
                ..under("Other", None, &lead)
            },
        )
        .unwrap();
        // The lead's own brief lists its reports.
        let lead_text = brief(&path, "chat:lead", "p1", &lead.id, "Plan it", false, &[]).unwrap();
        assert!(lead_text.contains("Other — builds things"), "{lead_text}");
        // A later turn's roster.
        let later = refresh_turn_brief(&path, "chat:lead", "More".into(), &[]).unwrap();
        assert!(later.contains("Other — builds things"), "{later}");
        // A second-level manager's roster.
        let split = manager_brief(&path, "p1", &manager.id, "task_1", "run_1")
            .unwrap()
            .unwrap();
        assert!(split.contains("Report — builds things"), "{split}");
        // A worker's peer roster.
        let team = list(&path, None, true).unwrap();
        let teams = teams(&path).unwrap();
        let mid = team.iter().find(|a| a.id == manager.id).unwrap();
        let peers = peer_brief(&team, &teams, mid, "p1").unwrap();
        assert!(peers.contains("Report — builds things"), "{peers}");
        for text in [&lead_text, &later, &split, &peers] {
            assert!(!text.contains(hidden), "{text}");
        }
        // The policy is the lead's own, never repeated per roster line.
        assert_eq!(lead_text.matches(POLICY).count(), 1, "{lead_text}");
    }
}

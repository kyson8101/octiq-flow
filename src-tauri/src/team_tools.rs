//! What an agent may do to the person's registered agents through its MCP:
//! `agent_list`, `agent_register`, `agent_update`, `agent_delete`,
//! `agent_policy_update`, `team_create` and `team_update`.
//!
//! Reading the roster is free. A change is only ever PROPOSED by the agent.
//! The host builds the whole draft itself, runs it through every rule the
//! Settings → Agents form is held to (`team::check`), and then asks the person
//! on the same permission card a provider's own tool call raises
//! (`permission::ask`). Only their Allow writes it, through
//! `team::save_unchanged` (or `team::delete_unchanged` for a removal), so what
//! is saved is exactly the change they were shown, made to the version of the
//! agent they were shown it against. A removal also moves other agents, so it
//! is held to everything its card said about the chart (`team::Removal`), and
//! a team change to everything its card said about the team and its members
//! (`team::TeamChange`).
//!
//! The card is one-off: "Always" would wave through the next agent this chat
//! invents, which is not a decision anybody can make in advance.
use std::future::Future;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent_chat::{Access, ChatAgent};
use crate::outcome::{ReasonClass, Refusal};
use crate::permission::Answer;
use crate::team::{AgentPolicy, AgentTeam, Removal, TeamAgent, TeamChange, TeamDraft, TeamRequest};
use crate::workspaces::Workspace;

/// The shortest and longest an agent may ask the person's card to stay up.
/// The longest is the card's own ceiling (`permission::ANSWER_TIMEOUT`).
const WAIT_MIN: Duration = Duration::from_secs(15);

/// `agent_list`'s arguments.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListArgs {
    /// Only the agents this project sees (its own and the global ones), by id
    /// or name. Absent: every agent.
    #[serde(default)]
    pub project: Option<String>,
}

/// `agent_register` and `agent_update`'s arguments. On an update every absent
/// field keeps its value, and `""` clears one that may be empty.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proposal {
    /// The agent to change, by id or name. Update only.
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub provider: Option<ChatAgent>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub access: Option<Access>,
    /// Where it is available: a project by id or name; `""` is every project.
    #[serde(default)]
    pub project: Option<String>,
    /// Its manager, by id or name; `""` reports to the person.
    #[serde(default)]
    pub reports_to: Option<String>,
    /// Its peer-help team, by id or name; `""` takes it off its team.
    #[serde(default)]
    pub team: Option<String>,
    /// Its standing instructions; `""` clears them.
    #[serde(default)]
    pub persistent_prompt: Option<String>,
    /// Codex only: its orchestration workers keep the person's browser and
    /// computer-use route (their Brave/Chrome session). Absent keeps it.
    #[serde(default)]
    pub desktop_tools: Option<bool>,
    /// How long the person's card may stay up, in seconds. The MCP sets it
    /// from what its provider will wait for a tool call; the host clamps it.
    #[serde(default)]
    pub wait_seconds: Option<u64>,
}

/// `agent_delete`'s arguments: the agent to remove, by id or name.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteProposal {
    pub agent: String,
    /// As `Proposal::wait_seconds`.
    #[serde(default)]
    pub wait_seconds: Option<u64>,
}

/// `agent_policy_update`'s arguments: the whole new policy, `""` to clear it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyProposal {
    pub policy: String,
    /// As `Proposal::wait_seconds`.
    #[serde(default)]
    pub wait_seconds: Option<u64>,
}

/// `team_create`'s arguments: the new team's name and who starts on it, each
/// by id or name. The team is global; nothing else about an agent is named.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamCreateProposal {
    pub name: String,
    #[serde(default)]
    pub members: Vec<String>,
    /// As `Proposal::wait_seconds`.
    #[serde(default)]
    pub wait_seconds: Option<u64>,
}

/// `team_update`'s arguments: the team, by id or name, and what changes about
/// it: a new name, agents to add, agents to remove.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamUpdateProposal {
    pub team: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub add_members: Vec<String>,
    #[serde(default)]
    pub remove_members: Vec<String>,
    /// As `Proposal::wait_seconds`.
    #[serde(default)]
    pub wait_seconds: Option<u64>,
}

/// Which change is being proposed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Register,
    Update,
}

impl Kind {
    fn tool(self) -> &'static str {
        match self {
            Kind::Register => "mcp__octiq__agent_register",
            Kind::Update => "mcp__octiq__agent_update",
        }
    }
}

/// What the roster tools read: the agents, the teams, and the projects an
/// agent may be made available in.
pub struct Roster {
    pub agents: Vec<TeamAgent>,
    pub teams: Vec<AgentTeam>,
    pub projects: Vec<Workspace>,
    pub head: Option<String>,
    pub front_desk: Option<String>,
    pub policy: AgentPolicy,
}

impl Roster {
    pub fn read(team: &Path, projects: Vec<Workspace>) -> Result<Self, String> {
        Ok(Self {
            agents: crate::team::list(team, None, true)?,
            teams: crate::team::teams(team)?,
            projects,
            head: crate::team::head(team)?.map(|agent| agent.id),
            front_desk: crate::team::front_desk(team)?.map(|agent| agent.id),
            policy: crate::team::policy(team)?,
        })
    }

    /// What removing `id` would do to this roster: what its card states, and
    /// what the person's Allow is held to.
    pub fn removal(&self, id: &str) -> Option<Removal> {
        crate::team::removal(
            &self.agents,
            self.head.as_deref(),
            self.front_desk.as_deref(),
            id,
        )
    }

    /// What `request` would do to this roster's teams: what its card states,
    /// and what the person's Allow is held to.
    pub fn team_change(&self, request: &TeamRequest) -> Result<TeamChange, String> {
        crate::team::team_change(&self.agents, &self.teams, request)
    }

    /// The team an agent is on, when that team still exists.
    fn team_of(&self, agent: &TeamAgent) -> Option<&AgentTeam> {
        let id = agent.team_id.as_deref()?;
        self.teams.iter().find(|t| t.id == id)
    }

    fn project_name(&self, id: Option<&str>) -> String {
        match id {
            None => "every project".into(),
            Some(id) => self
                .projects
                .iter()
                .find(|p| p.id == id)
                .map_or_else(|| id.to_string(), |p| p.name.clone()),
        }
    }

    fn agent_name(&self, id: Option<&str>) -> String {
        match id {
            None => "the person".into(),
            Some(id) => self
                .agents
                .iter()
                .find(|a| a.id == id)
                .map_or_else(|| id.to_string(), |a| a.name.clone()),
        }
    }

    fn team_name(&self, id: Option<&str>) -> String {
        match id {
            None => "none".into(),
            Some(id) => self
                .teams
                .iter()
                .find(|t| t.id == id)
                .map_or_else(|| id.to_string(), |t| t.name.clone()),
        }
    }
}

/// One thing named by id or by name: the id when it matches one exactly,
/// otherwise the one whose name matches, ignoring case. Two with that name is
/// refused rather than guessed between.
fn pick<'a, T>(
    items: &'a [T],
    spec: &str,
    id: impl Fn(&T) -> &str,
    name: impl Fn(&T) -> &str,
    what: &str,
) -> Result<&'a T, String> {
    let spec = spec.trim();
    if let Some(found) = items.iter().find(|item| id(item) == spec) {
        return Ok(found);
    }
    let mut named = items
        .iter()
        .filter(|item| name(item).eq_ignore_ascii_case(spec));
    match (named.next(), named.next()) {
        (Some(found), None) => Ok(found),
        (Some(_), Some(_)) => Err(format!(
            "More than one {what} is called {spec}. Pass its id from agent_list."
        )),
        (None, _) => Err(format!(
            "No {what} is called {spec}. Call agent_list for the ids."
        )),
    }
}

fn project_id(roster: &Roster, spec: &str) -> Result<Option<String>, String> {
    if spec.trim().is_empty() {
        return Ok(None);
    }
    pick(&roster.projects, spec, |p| &p.id, |p| &p.name, "project").map(|p| Some(p.id.clone()))
}

fn agent<'a>(roster: &'a Roster, spec: &str) -> Result<&'a TeamAgent, String> {
    pick(&roster.agents, spec, |a| &a.id, |a| &a.name, "agent")
}

/// The id `""` or a name or id stands for, for a field that may be cleared.
fn optional(
    spec: &str,
    resolve: impl FnOnce(&str) -> Result<String, String>,
) -> Result<Option<String>, String> {
    if spec.trim().is_empty() {
        return Ok(None);
    }
    resolve(spec).map(Some)
}

/// One agent as an agent reads it: what the Settings form shows, without the
/// picture or the memory note's path. `teamId` and `team` are its team's id
/// and name, both null when it is on none.
fn public(roster: &Roster, agent: &TeamAgent) -> Value {
    let team = roster.team_of(agent);
    json!({
        "id": agent.id,
        "name": agent.name,
        "role": agent.role,
        "persistentPrompt": agent.persistent_prompt,
        "desktopTools": agent.desktop_tools,
        "provider": agent.agent,
        "model": agent.model,
        "effort": agent.effort,
        "access": agent.access,
        "projectId": agent.project_id,
        "reportsTo": agent.reports_to,
        "teamId": team.map(|t| &t.id),
        "team": team.map(|t| &t.name),
    })
}

/// One team as an agent reads it: its id, name and project, and who is on it,
/// by name in registration order. Every member is listed, whichever project
/// the listing was scoped to.
fn public_team(roster: &Roster, team: &AgentTeam) -> Value {
    json!({
        "id": team.id,
        "name": team.name,
        "projectId": team.project_id,
        "members": roster
            .agents
            .iter()
            .filter(|a| a.team_id.as_deref() == Some(team.id.as_str()))
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>(),
    })
}

/// `agent_list`: the roster, the teams and the projects, with ids.
pub fn listing(roster: &Roster, args: ListArgs) -> Result<Value, String> {
    let scope = match args.project.as_deref() {
        Some(spec) if !spec.trim().is_empty() => project_id(roster, spec)?,
        _ => None,
    };
    let agents: Vec<Value> = roster
        .agents
        .iter()
        .filter(|a| scope.is_none() || a.project_id.is_none() || a.project_id == scope)
        .map(|a| public(roster, a))
        .collect();
    Ok(json!({
        "agents": agents,
        "teams": roster.teams.iter().map(|t| public_team(roster, t)).collect::<Vec<_>>(),
        "projects": roster.projects.iter().map(|p| json!({
            "id": p.id, "name": p.name,
        })).collect::<Vec<_>>(),
        "head": roster.head,
        "frontDesk": roster.front_desk,
        "agentPolicy": roster.policy.text,
    }))
}

/// A proposal, turned into the draft the Settings form would have sent, plus
/// the version of the agent it changes (`updated_at`) for an update.
pub struct Draft {
    pub draft: TeamDraft,
    pub before: Option<TeamAgent>,
}

pub fn draft(roster: &Roster, kind: Kind, p: &Proposal) -> Result<Draft, String> {
    let team_of = |spec: &str| {
        optional(spec, |s| {
            pick(&roster.teams, s, |t| &t.id, |t| &t.name, "team").map(|t| t.id.clone())
        })
    };
    let manager_of = |spec: &str| optional(spec, |s| agent(roster, s).map(|a| a.id.clone()));
    let effort = |e: &str| Some(e.trim().to_string()).filter(|e| !e.is_empty());
    match kind {
        Kind::Register => {
            if p.agent.is_some() {
                return Err(
                    "agent_register adds a new agent; use agent_update to change one.".into(),
                );
            }
            let name = p.name.clone().ok_or("Give the agent a name.")?;
            let provider = p
                .provider
                .ok_or("Choose the agent's provider: claude, codex or antigravity.")?;
            let model = p
                .model
                .clone()
                .ok_or("Choose an explicit model for the agent.")?;
            let draft = TeamDraft {
                id: None,
                name,
                role: p.role.clone().unwrap_or_default(),
                agent: provider,
                model,
                effort: p.effort.as_deref().and_then(effort),
                access: Some(p.access.unwrap_or(Access::Auto)),
                project_id: match p.project.as_deref() {
                    Some(spec) => project_id(roster, spec)?,
                    None => None,
                },
                reports_to: match p.reports_to.as_deref() {
                    Some(spec) => manager_of(spec)?,
                    None => None,
                },
                avatar: None,
                team_id: match p.team.as_deref() {
                    Some(spec) => Some(team_of(spec)?.unwrap_or_default()),
                    None => None,
                },
                persistent_prompt: p.persistent_prompt.clone(),
                desktop_tools: p.desktop_tools,
            };
            Ok(Draft {
                draft,
                before: None,
            })
        }
        Kind::Update => {
            let target = p
                .agent
                .as_deref()
                .filter(|spec| !spec.trim().is_empty())
                .ok_or("Say which agent to change: pass its id or name as agent.")?;
            let current = agent(roster, target)?.clone();
            let nothing = p.name.is_none()
                && p.role.is_none()
                && p.provider.is_none()
                && p.model.is_none()
                && p.effort.is_none()
                && p.access.is_none()
                && p.project.is_none()
                && p.reports_to.is_none()
                && p.team.is_none()
                && p.persistent_prompt.is_none()
                && p.desktop_tools.is_none();
            if nothing {
                return Err(format!("Say what to change about {}.", current.name));
            }
            // A model belongs to its provider: moving an agent to another
            // provider keeps no model it could run.
            if p.provider.is_some_and(|provider| provider != current.agent) && p.model.is_none() {
                return Err(format!(
                    "{} moves to another provider, so choose its model there too.",
                    current.name
                ));
            }
            let draft = TeamDraft {
                id: Some(current.id.clone()),
                name: p.name.clone().unwrap_or_else(|| current.name.clone()),
                role: p.role.clone().unwrap_or_else(|| current.role.clone()),
                agent: p.provider.unwrap_or(current.agent),
                model: p.model.clone().unwrap_or_else(|| current.model.clone()),
                effort: match p.effort.as_deref() {
                    Some(e) => effort(e),
                    None => current.effort.clone(),
                },
                access: Some(p.access.unwrap_or(current.access)),
                project_id: match p.project.as_deref() {
                    Some(spec) => project_id(roster, spec)?,
                    None => current.project_id.clone(),
                },
                reports_to: match p.reports_to.as_deref() {
                    Some(spec) => manager_of(spec)?,
                    None => current.reports_to.clone(),
                },
                // Absent keeps the picture and the team, as in `team::save`.
                avatar: None,
                team_id: match p.team.as_deref() {
                    Some(spec) => Some(team_of(spec)?.unwrap_or_default()),
                    None => None,
                },
                // Absent keeps it, as in `team::save`.
                persistent_prompt: p.persistent_prompt.clone(),
                desktop_tools: p.desktop_tools,
            };
            Ok(Draft {
                draft,
                before: Some(current),
            })
        }
    }
}

use crate::handover::provider_name;

/// Every field of an agent as the person reads it on the card.
fn fields(roster: &Roster, agent: &TeamAgent) -> Vec<(&'static str, String)> {
    let role = if agent.role.trim().is_empty() {
        "(none)".to_string()
    } else {
        agent.role.clone()
    };
    vec![
        ("Name", agent.name.clone()),
        ("Role", role),
        ("Provider", provider_name(agent.agent).into()),
        ("Model", agent.model.clone()),
        (
            "Effort",
            agent.effort.clone().unwrap_or_else(|| "default".into()),
        ),
        ("Access", agent.access.as_env().into()),
        (
            "Available in",
            roster.project_name(agent.project_id.as_deref()),
        ),
        ("Reports to", roster.agent_name(agent.reports_to.as_deref())),
        ("Team", roster.team_name(agent.team_id.as_deref())),
    ]
}

/// One row of a card's `changeFacts`: a field stated whole, or one that moves.
/// A value keeps its newlines. A move whose `after` is empty clears the field;
/// only the persistent prompt and the policy can be cleared, and `before` is
/// never empty: a text set where there was none is a plain row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum FactRow {
    Plain {
        label: &'static str,
        /// Sent as the row's own `value`, and `summary` beside it when it
        /// has one.
        #[serde(flatten)]
        value: Stated,
    },
    Move {
        label: &'static str,
        before: String,
        after: String,
    },
}

/// What a plain row states: the value whole and, when the host has something
/// shorter to say than that, what it comes to in one line (`summary`). A
/// folded card has no room for a value with no bound, such as every name
/// that moves, and a page never cuts one out of the other: it shows the
/// summary whole. A row with no summary is sent as `label` and `value` and
/// nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stated {
    #[serde(rename = "value")]
    whole: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}

/// The value whole, as the card's text shows it.
impl std::fmt::Display for Stated {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.whole)
    }
}

/// The most a row's `summary` holds, in characters, on one line.
pub const SUMMARY_MAX: usize = 160;

/// A card's change as data, sent as `changeFacts` next to its `change` text
/// and built from the same values, so a page draws rows without reading the
/// text back apart: a role may itself hold a line that reads `Access: a → b`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangeFacts {
    /// The card's first sentence: what is being done, and to whom.
    pub lead: String,
    pub rows: Vec<FactRow>,
}

fn plain(label: &'static str, value: impl Into<String>) -> FactRow {
    FactRow::Plain {
        label,
        value: Stated {
            whole: value.into(),
            summary: None,
        },
    }
}

/// A plain row that also says what it comes to in one line of at most
/// `SUMMARY_MAX` characters. Whoever words the summary keeps it to that:
/// only they know which of its words may be shortened.
fn summed(label: &'static str, value: impl Into<String>, summary: String) -> FactRow {
    debug_assert!(
        !summary.is_empty()
            && summary.chars().count() <= SUMMARY_MAX
            && !summary.chars().any(ends_a_line),
        "{summary:?}"
    );
    FactRow::Plain {
        label,
        value: Stated {
            whole: value.into(),
            summary: Some(summary),
        },
    }
}

/// A character a summary's one line cannot hold: a control character, a
/// line feed and a carriage return among them, or one of Unicode's own line
/// and paragraph separators (U+2028, U+2029), which are not control
/// characters and end a line all the same. The page drops a summary that
/// holds any of them (`askDetail.rowSummary`).
fn ends_a_line(c: char) -> bool {
    c.is_control() || matches!(c, '\u{2028}' | '\u{2029}')
}

/// `text` on one line: each character that would end the line is a space.
fn one_line(text: &str) -> String {
    text.chars()
        .map(|c| if ends_a_line(c) { ' ' } else { c })
        .collect()
}

/// `text`, or its start and an ellipsis when it is longer than `max`
/// characters.
fn clipped(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.into();
    }
    let start: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", start.trim_end())
}

/// A text that is set, replaced or cleared, as a row: the persistent prompt
/// and the policy. None when it does not change.
fn text_row(label: &'static str, was: &str, now: &str) -> Option<FactRow> {
    if was == now {
        None
    } else if was.is_empty() {
        Some(plain(label, now))
    } else {
        Some(FactRow::Move {
            label,
            before: was.into(),
            after: now.into(),
        })
    }
}

/// The first sentence of a register or update card.
fn lead(change: &Draft, after: &TeamAgent) -> String {
    match &change.before {
        None => format!("Register a new agent, {}.", after.name),
        Some(before) => format!("Change the agent {}.", before.name),
    }
}

/// The fields that differ between two versions of an agent, as the card
/// reads them: label, before, after.
fn moves(
    roster: &Roster,
    before: &TeamAgent,
    after: &TeamAgent,
) -> Vec<(&'static str, String, String)> {
    let mut moved: Vec<(&'static str, String, String)> = fields(roster, before)
        .into_iter()
        .zip(fields(roster, after))
        .filter(|((_, was), (_, now))| was != now)
        .map(|((label, was), (_, now))| (label, was, now))
        .collect();
    if before.desktop_tools != after.desktop_tools {
        moved.push((
            DESKTOP_TOOLS,
            on_off(before.desktop_tools).into(),
            on_off(after.desktop_tools).into(),
        ));
    }
    moved
}

/// The card's label for an agent's browser and computer use. It widens what a
/// worker can do, so it is stated on a new agent that has it on and whenever it
/// moves; it is not a row of every card (a removal, a change to something else).
const DESKTOP_TOOLS: &str = "Browser and computer use";

fn on_off(on: bool) -> &'static str {
    if on {
        "on"
    } else {
        "off"
    }
}

/// The persistent prompt an agent had before this change; none for a new one.
fn prompt_before(change: &Draft) -> &str {
    change
        .before
        .as_ref()
        .map_or("", |before| before.persistent_prompt.as_str())
}

/// The change in words, for the card: every field of a new agent, and only
/// what moves on an existing one. The persistent prompt is never listed with
/// the other fields, and appears only when this change sets or clears it:
/// the person approves exactly the text that would be saved.
pub fn describe(roster: &Roster, change: &Draft, after: &TeamAgent) -> String {
    let mut text = lead(change, after);
    text.push('\n');
    match &change.before {
        None => {
            for (label, value) in fields(roster, after) {
                text.push_str(&format!("\n{label}: {value}"));
            }
            if after.desktop_tools {
                text.push_str(&format!("\n{DESKTOP_TOOLS}: on"));
            }
        }
        Some(before) => {
            for (label, was, now) in moves(roster, before, after) {
                text.push_str(&format!("\n{label}: {was} → {now}"));
            }
        }
    }
    let was = prompt_before(change);
    if was != after.persistent_prompt {
        if after.persistent_prompt.is_empty() {
            text.push_str("\nPersistent prompt: cleared");
        } else {
            text.push_str(&format!(
                "\n\nPersistent prompt ({} characters{}):\n{}",
                after.persistent_prompt.chars().count(),
                if was.is_empty() {
                    ""
                } else {
                    ", replaces the current one"
                },
                after.persistent_prompt
            ));
        }
    }
    text
}

/// `describe` as rows: a plain row for every field of a new agent, a move for
/// each field that changes on an existing one, and the persistent prompt as a
/// last row when this change sets, replaces or clears it. A replaced or
/// cleared prompt carries the one it had in `before`, which the text leaves
/// out.
pub fn facts(roster: &Roster, change: &Draft, after: &TeamAgent) -> ChangeFacts {
    let mut rows: Vec<FactRow> = match &change.before {
        None => fields(roster, after)
            .into_iter()
            .map(|(label, value)| plain(label, value))
            .chain(after.desktop_tools.then(|| plain(DESKTOP_TOOLS, "on")))
            .collect(),
        Some(before) => moves(roster, before, after)
            .into_iter()
            .map(|(label, before, after)| FactRow::Move {
                label,
                before,
                after,
            })
            .collect(),
    };
    rows.extend(text_row(
        "Persistent prompt",
        prompt_before(change),
        &after.persistent_prompt,
    ));
    ChangeFacts {
        lead: lead(change, after),
        rows,
    }
}

/// What a removal card says of a seat that empties, after "It is the head: "
/// in the text and as the row's own sentence.
const NO_HEAD: &str = "the cross-project conversation will have no head until another is chosen.";
const NO_FRONT_DESK: &str = "incoming requests will have no front desk until another is chosen.";

/// A sentence that starts another's clause, with its capital.
fn sentence(clause: &str) -> String {
    let mut letters = clause.chars();
    match letters.next() {
        Some(first) => first.to_uppercase().chain(letters).collect(),
        None => String::new(),
    }
}

/// The direct reports a removal moves up, by name, in roster order.
fn reports_of<'a>(roster: &'a Roster, shown: &Removal) -> Vec<&'a str> {
    roster
        .agents
        .iter()
        .filter(|a| shown.reports.contains(&a.id))
        .map(|a| a.name.as_str())
        .collect()
}

/// The removal in words, for the card: who goes, with the fields that tell
/// one agent from another, and what the removal does to the rest of the
/// chart — the head or front desk seat that empties, the reports that move
/// up. The seats come first: the list of reports has no bound, and the page
/// shows only the start of a long card. `unfinished` is what the ledger says
/// of the tasks still naming it (`AgentWork::unfinished_note`), which the
/// removal leaves as they are. The memory note is not touched, and the card
/// says so.
///
/// `shown` is `Roster::removal` of the same roster: everything said here about
/// the chart is read from it, and it is what the person's Allow is held to
/// (`team::delete_unchanged`).
pub fn describe_delete(
    roster: &Roster,
    gone: &TeamAgent,
    shown: &Removal,
    unfinished: Option<&Unfinished>,
) -> String {
    let mut text = format!("Remove the agent {}.\n", gone.name);
    for (label, value) in fields(roster, gone) {
        if label == "Name" {
            continue;
        }
        text.push_str(&format!("\n{label}: {value}"));
    }
    if shown.head {
        text.push_str(&format!("\n\nIt is the head: {NO_HEAD}"));
    }
    if shown.front_desk {
        text.push_str(&format!("\n\nIt is the front desk: {NO_FRONT_DESK}"));
    }
    let reports = reports_of(roster, shown);
    if !reports.is_empty() {
        text.push_str(&format!(
            "\n\nIts {} ({}) will report to {}.",
            if reports.len() == 1 {
                "direct report".to_string()
            } else {
                format!("{} direct reports", reports.len())
            },
            reports.join(", "),
            roster.agent_name(shown.reports_to.as_deref())
        ));
    }
    if let Some(unfinished) = unfinished {
        text.push_str(&format!("\n\n{}", unfinished.note));
    }
    text.push_str("\n\nIts memory note in the vault is kept.");
    text
}

/// A removal's reports row in one line: how many move up, and to whom. The
/// number is the roster's count and `to` the manager as the text words it;
/// neither is cut out of the row's value. A manager's name too long for the
/// line loses its end to an ellipsis, and the count and "will report to"
/// stay whole.
fn reports_summary(count: usize, to: &str) -> String {
    let said = format!(
        "{count} direct report{} will report to ",
        if count == 1 { "" } else { "s" }
    );
    // Nothing refuses a name with a line break in it, and the summary is one
    // line whatever the name holds.
    let to = one_line(to);
    let room = SUMMARY_MAX.saturating_sub(said.chars().count());
    said + &clipped(&to, room)
}

/// `describe_delete` as rows, in the same order: a plain row for each field
/// but the name, which the lead carries, then what the removal does to the
/// chart as plain rows of their own — `Head` and `Front desk` when that seat
/// empties, `Direct report(s)` naming who moves up and to whom — then
/// `Unfinished tasks` when any still name it, and `Memory note` last. The
/// reports row names every one of them, so it also carries
/// `reports_summary`; the unfinished row is two sentences, and carries the
/// ledger's own count of them (`Unfinished::summary`).
pub fn delete_facts(
    roster: &Roster,
    gone: &TeamAgent,
    shown: &Removal,
    unfinished: Option<&Unfinished>,
) -> ChangeFacts {
    let mut rows: Vec<FactRow> = fields(roster, gone)
        .into_iter()
        .filter(|(label, _)| *label != "Name")
        .map(|(label, value)| plain(label, value))
        .collect();
    if shown.head {
        rows.push(plain("Head", sentence(NO_HEAD)));
    }
    if shown.front_desk {
        rows.push(plain("Front desk", sentence(NO_FRONT_DESK)));
    }
    let reports = reports_of(roster, shown);
    if !reports.is_empty() {
        let to = roster.agent_name(shown.reports_to.as_deref());
        rows.push(summed(
            if reports.len() == 1 {
                "Direct report"
            } else {
                "Direct reports"
            },
            format!("{} will report to {to}.", reports.join(", ")),
            reports_summary(reports.len(), &to),
        ));
    }
    if let Some(unfinished) = unfinished {
        rows.push(summed(
            "Unfinished tasks",
            unfinished.note.as_str(),
            unfinished.summary.clone(),
        ));
    }
    rows.push(plain("Memory note", "Kept in the vault."));
    ChangeFacts {
        lead: format!("Remove the agent {}.", gone.name),
        rows,
    }
}

/// The first sentence of a policy card.
fn policy_lead(before: &AgentPolicy, after: &str) -> String {
    format!(
        "{} the shared agent policy that every agent's brief starts with.",
        if after.is_empty() {
            "Clear"
        } else if before.text.is_empty() {
            "Set"
        } else {
            "Replace"
        }
    )
}

/// The policy change in words, for the card: the whole text it would become.
pub fn describe_policy(before: &AgentPolicy, after: &str) -> String {
    let lead = policy_lead(before, after);
    if after.is_empty() {
        return lead;
    }
    format!(
        "{lead}\n\nNew policy ({} characters):\n{after}",
        after.chars().count()
    )
}

/// `describe_policy` as rows: one `Policy` row, plain when a policy is set
/// where there was none, a move from the current text when it is replaced or
/// cleared. The text leaves the current policy out.
pub fn policy_facts(before: &AgentPolicy, after: &str) -> ChangeFacts {
    ChangeFacts {
        lead: policy_lead(before, after),
        rows: text_row("Policy", &before.text, after)
            .into_iter()
            .collect(),
    }
}

/// How the person answered, as the agent reads it. `Ok` only on an Allow.
/// Every refusal here is OctiqFlow's card, never the provider's: an expiry is
/// `approval-expired`, a Deny `approval-denied` (`outcome::of_permission`).
fn approved(answer: &Answer, wait: Duration) -> Result<(), Refusal> {
    let Some(outcome) = crate::outcome::of_permission(answer) else {
        return Ok(());
    };
    let message = match outcome.reason_class {
        ReasonClass::ApprovalExpired => format!(
            "The person did not answer within {} seconds, so nothing was changed. Tell them what you proposed and call again when they are ready to approve it.",
            wait.as_secs()
        ),
        ReasonClass::ApprovalDenied => {
            "The person declined this change, so nothing was changed.".into()
        }
        _ => "Nobody has OctiqFlow open to approve this, so nothing was changed. A change to the registered agents needs the person's approval on its card.".into(),
    };
    Err(Refusal { message, outcome })
}

/// How long the card stays up for this call.
pub fn wait_for(requested: Option<u64>) -> Duration {
    requested
        .map(Duration::from_secs)
        .unwrap_or(crate::permission::ANSWER_TIMEOUT)
        .clamp(WAIT_MIN, crate::permission::ANSWER_TIMEOUT)
}

/// What a saved policy answers with.
pub fn policy_saved_text(policy: &AgentPolicy) -> Value {
    let said = if policy.text.is_empty() {
        "The person approved it: the shared agent policy is cleared."
    } else {
        "The person approved it: the shared agent policy is saved."
    };
    json!({ "status": "saved", "text": said, "agentPolicy": policy.text })
}

/// What a saved change answers with: the agent as `agent_list` shows it.
/// `roster` is the one the change was proposed against; it names the team.
pub fn saved_text(roster: &Roster, kind: Kind, agent: &TeamAgent) -> Value {
    let said = match kind {
        Kind::Register => format!("The person approved it: {} is registered.", agent.name),
        Kind::Update => format!("The person approved it: {} is updated.", agent.name),
    };
    json!({ "status": "saved", "text": said, "agent": public(roster, agent) })
}

/// What follows a saved agent, however it was saved: its memory note, when a
/// writable vault is connected (made on first use otherwise, so the agent is
/// saved either way), and a word to every open page, which reads the roster
/// again. The error, when the note could not be made.
pub fn settle(saved: &TeamAgent) -> Option<String> {
    let memory =
        crate::team::ensure_memory(&crate::memory_vault::Vault::profile(), "octiq:team", saved)
            .err();
    crate::bus::emit("team-changed", json!({ "id": saved.id }));
    memory
}

/// Propose a change, put it to the person, and save it only on their Allow.
/// `ask` raises the card and waits for the answer; `save` writes the approved
/// draft (`team::save_unchanged` and its memory note, in the running app).
pub async fn propose<A, F>(
    roster: &Roster,
    team: &Path,
    chat_key: &str,
    kind: Kind,
    proposal: Proposal,
    ask: A,
) -> Result<TeamAgent, Refusal>
where
    A: FnOnce(crate::permission::Request) -> F,
    F: Future<Output = Answer>,
{
    let invalid = |error: String| Refusal::new(ReasonClass::Validation, error);
    let change = draft(roster, kind, &proposal).map_err(invalid)?;
    // The Settings form's rules, against the agents as they are now. A
    // proposal that would be refused is never put to the person.
    let after = crate::team::check(team, change.draft.clone()).map_err(invalid)?;
    let wait = wait_for(proposal.wait_seconds);
    let request = crate::permission::Request {
        chat_key: Some(chat_key.to_string()),
        tool_name: Some(kind.tool().into()),
        tool_input: Some(json!({
            "change": describe(roster, &change, &after),
            "changeFacts": facts(roster, &change, &after),
        })),
        once: true,
        answer_within_secs: Some(wait.as_secs()),
        ..Default::default()
    };
    approved(&ask(request).await, wait)?;
    match &change.before {
        Some(before) => crate::team::save_unchanged(team, change.draft, before.updated_at),
        // A new agent has no earlier version to compare with; a name taken
        // meanwhile is refused by the same rules.
        None => crate::team::save(team, change.draft),
    }
    .map_err(Refusal::from)
}

/// What a removal answers with: the agent that is gone, as `agent_list` last
/// showed it.
pub fn deleted_text(roster: &Roster, gone: &TeamAgent) -> Value {
    json!({
        "status": "saved",
        "text": format!("The person approved it: {} is removed.", gone.name),
        "agent": public(roster, gone),
    })
}

/// `propose_delete_when` for an agent with nothing in the ledger.
#[cfg(test)]
pub async fn propose_delete<A, F>(
    roster: &Roster,
    team: &Path,
    chat_key: &str,
    proposal: DeleteProposal,
    ask: A,
) -> Result<TeamAgent, Refusal>
where
    A: FnOnce(crate::permission::Request) -> F,
    F: Future<Output = Answer>,
{
    propose_delete_when(
        roster,
        team,
        chat_key,
        proposal,
        &|_: &TeamAgent| Ok(None),
        ask,
    )
    .await
}

/// What a removal is asked under, twice: before its card is shown, and in
/// the step that makes it once the person has answered. The host's is the
/// ledger and the live chats (`orchestration::agent_work::Departure`).
pub trait Removing: Send + Sync {
    /// Before the card: an error while anything of the agent's is in
    /// progress, in the words the caller is refused with, else what the card
    /// should say of its unfinished tasks, if it has any.
    fn before(
        &self,
        agent: &TeamAgent,
        chats: &[crate::team::OwnChat],
    ) -> Result<Option<Unfinished>, String>;

    /// The removal itself. See `team::Leave`.
    fn leave(
        &self,
        agent: &TeamAgent,
        chats: &[crate::team::OwnChat],
        write: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<(), String>;
}

/// A check with nothing of its own to hold: asked before the card, asked
/// again when it is answered, and then the write is made. For tests only:
/// the host's removals hold what they checked across the write.
#[cfg(test)]
impl<F> Removing for F
where
    F: Fn(&TeamAgent) -> Result<Option<Unfinished>, String> + Send + Sync,
{
    fn before(
        &self,
        agent: &TeamAgent,
        _chats: &[crate::team::OwnChat],
    ) -> Result<Option<Unfinished>, String> {
        self(agent)
    }

    fn leave(
        &self,
        agent: &TeamAgent,
        _chats: &[crate::team::OwnChat],
        write: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        self(agent)?;
        write()
    }
}

impl Removing for crate::orchestration::agent_work::Departure<'_> {
    fn before(
        &self,
        agent: &TeamAgent,
        chats: &[crate::team::OwnChat],
    ) -> Result<Option<Unfinished>, String> {
        self.check(agent, chats)
    }

    fn leave(
        &self,
        agent: &TeamAgent,
        chats: &[crate::team::OwnChat],
        write: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        crate::team::Leave::leave(self, agent, chats, write)
    }
}

/// `Removing::leave`, as the roster's `delete` takes it.
struct Left<'a>(&'a dyn Removing);

impl crate::team::Leave for Left<'_> {
    fn leave(
        &self,
        agent: &TeamAgent,
        chats: &[crate::team::OwnChat],
        write: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        self.0.leave(agent, chats, write)
    }
}

/// See [`Removing`].
pub type Work<'a> = &'a dyn Removing;

/// What a removal's card says of the tasks that still name the agent: the
/// two sentences whole (`note`), and how many there are in one line of at
/// most `SUMMARY_MAX` characters (`summary`), which is what a folded card
/// keeps of the row. Both are the ledger's (`AgentWork::unfinished`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unfinished {
    pub note: String,
    pub summary: String,
}

/// Propose removing an agent, put it to the person, and remove it only on
/// their Allow, and only while the removal still does what the card said: the
/// same version of the agent, the same manager, the same direct reports, the
/// same seats (`team::Removal`). Its reports move up to its manager
/// (`team::delete`); its memory note stays.
///
/// An agent with work in progress is not removed (`work`): a task of its
/// running, a run it coordinates, a turn in flight in a conversation of its
/// own. It is refused before any card is shown, and again in the step that
/// removes it once the person has answered: a card can wait while a task of
/// the agent's starts, and that step lets none start beside it.
pub async fn propose_delete_when<A, F>(
    roster: &Roster,
    team: &Path,
    chat_key: &str,
    proposal: DeleteProposal,
    work: Work<'_>,
    ask: A,
) -> Result<TeamAgent, Refusal>
where
    A: FnOnce(crate::permission::Request) -> F,
    F: Future<Output = Answer>,
{
    let invalid = |error: String| Refusal::new(ReasonClass::Validation, error);
    if proposal.agent.trim().is_empty() {
        return Err(invalid(
            "Name the agent to remove, by id or name from agent_list.".into(),
        ));
    }
    let gone = agent(roster, &proposal.agent).map_err(invalid)?.clone();
    let shown = roster
        .removal(&gone.id)
        .ok_or_else(|| invalid("That agent no longer exists.".into()))?;
    let chats = crate::team::own_chats(team, &gone.id)?;
    let unfinished = work.before(&gone, &chats)?;
    let wait = wait_for(proposal.wait_seconds);
    let request = crate::permission::Request {
        chat_key: Some(chat_key.to_string()),
        tool_name: Some("mcp__octiq__agent_delete".into()),
        tool_input: Some(json!({
            "change": describe_delete(roster, &gone, &shown, unfinished.as_ref()),
            "changeFacts": delete_facts(roster, &gone, &shown, unfinished.as_ref()),
        })),
        once: true,
        answer_within_secs: Some(wait.as_secs()),
        ..Default::default()
    };
    approved(&ask(request).await, wait)?;
    crate::team::delete_unchanged(team, &gone.id, &shown, &Left(work)).map_err(Refusal::from)
}

/// `list`, or the card's word for an empty one.
fn names(list: &[String]) -> String {
    if list.is_empty() {
        "none".into()
    } else {
        list.join(", ")
    }
}

/// Every row of a team card, in order. One list for the text and the rows,
/// so they cannot drift.
///
/// A new team: where it is available, and who starts on it. A changed team:
/// `Name` when it is renamed, then, when its members change, who is `Added`,
/// who is `Removed`, and `Members` whole, before and after. `Other teams`
/// comes last on either card when an agent that joins is on another team: an
/// agent is on one team at a time, so joining this one takes it off that one,
/// and the card says which. `Membership` closes every card: what the people
/// on a team may do with each other (`MEMBERSHIP_GRANTS`).
///
/// Two rows carry a summary (`summed`): `Other teams`, how many agents leave
/// another team, and a new team's `Members`, how many there are. A changed
/// team's `Members` is a move, which has no summary; who joins and who
/// leaves are the `Added` and `Removed` rows beside it.
fn team_rows(roster: &Roster, change: &TeamChange) -> Vec<FactRow> {
    let of = |members: &[crate::team::TeamMember]| {
        names(&members.iter().map(|m| m.name.clone()).collect::<Vec<_>>())
    };
    let mut rows = Vec::new();
    match &change.was {
        None => {
            rows.push(plain(
                "Available in",
                roster.project_name(change.project_id.as_deref()),
            ));
            // Every name, so it also says how many: a folded card keeps
            // that line where it would show only the row's size.
            rows.push(match change.after.len() {
                0 => plain("Members", of(&change.after)),
                n => summed(
                    "Members",
                    of(&change.after),
                    format!("{n} member{}", if n == 1 { "" } else { "s" }),
                ),
            });
        }
        Some(was) => {
            if was != &change.name {
                rows.push(FactRow::Move {
                    label: "Name",
                    before: was.clone(),
                    after: change.name.clone(),
                });
            }
            if !change.joining.is_empty() {
                let joining: Vec<String> = change.joining.iter().map(|j| j.name.clone()).collect();
                rows.push(plain("Added", names(&joining)));
            }
            if !change.leaving.is_empty() {
                rows.push(plain("Removed", of(&change.leaving)));
            }
            if change.before != change.after {
                rows.push(FactRow::Move {
                    label: "Members",
                    before: of(&change.before),
                    after: of(&change.after),
                });
            }
        }
    }
    let moved: Vec<String> = change
        .joining
        .iter()
        .filter_map(|j| Some(format!("{} leaves {}.", j.name, j.leaves.as_ref()?)))
        .collect();
    if !moved.is_empty() {
        // What the change does to teams the card is not about. Folded, the
        // row would be a size and nothing else, and the person would approve
        // without seeing that anybody leaves a team: the count stays.
        let summary = match moved.len() {
            1 => "1 agent leaves another team".to_string(),
            n => format!("{n} agents leave another team"),
        };
        rows.push(summed("Other teams", moved.join(" "), summary));
    }
    rows.push(plain("Membership", MEMBERSHIP_GRANTS));
    rows
}

/// What being on a team grants, said on every team card in the same words:
/// the card moves who is on a team, and this is what that is for.
pub const MEMBERSHIP_GRANTS: &str = "Teammates may ask each other questions and request bounded work, and each request for work is approved separately.";

/// The first sentence of a team card.
fn team_lead(change: &TeamChange) -> String {
    match &change.was {
        None => format!("Create the team {}.", change.name),
        Some(was) => format!("Change the team {was}."),
    }
}

/// The team change in words, for the card: `team_rows`, one to a line.
/// `change` is `Roster::team_change` of the same roster, and it is what the
/// person's Allow is held to (`team::change_team_unchanged`).
pub fn describe_team(roster: &Roster, change: &TeamChange) -> String {
    let mut text = team_lead(change);
    text.push('\n');
    for row in team_rows(roster, change) {
        match row {
            FactRow::Plain { label, value } => text.push_str(&format!("\n{label}: {value}")),
            FactRow::Move {
                label,
                before,
                after,
            } => text.push_str(&format!("\n{label}: {before} → {after}")),
        }
    }
    text
}

/// `describe_team` as rows: the same rows, in the same order.
pub fn team_facts(roster: &Roster, change: &TeamChange) -> ChangeFacts {
    ChangeFacts {
        lead: team_lead(change),
        rows: team_rows(roster, change),
    }
}

/// What a saved team answers with: the team as `agent_list` shows it, with
/// the members the card showed it ending up with.
pub fn team_saved_text(team: &AgentTeam, change: &TeamChange) -> Value {
    let said = match &change.was {
        None => format!("The person approved it: the team {} is created.", team.name),
        Some(_) => format!("The person approved it: the team {} is updated.", team.name),
    };
    json!({
        "status": "saved",
        "text": said,
        "team": {
            "id": team.id,
            "name": team.name,
            "projectId": team.project_id,
            "members": change.after.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
        },
    })
}

/// The ids `specs` name, each an agent by id or name.
fn agent_ids(roster: &Roster, specs: &[String]) -> Result<Vec<String>, String> {
    specs
        .iter()
        .map(|spec| agent(roster, spec).map(|a| a.id.clone()))
        .collect()
}

/// Put a team change to the person, and make it only on their Allow, and only
/// while it still does what the card said (`team::TeamChange`). The saved
/// team comes back with the change that was shown.
async fn propose_team<A, F>(
    roster: &Roster,
    team: &Path,
    chat_key: &str,
    tool: &str,
    request: TeamRequest,
    wait_seconds: Option<u64>,
    ask: A,
) -> Result<(AgentTeam, TeamChange), Refusal>
where
    A: FnOnce(crate::permission::Request) -> F,
    F: Future<Output = Answer>,
{
    // Every rule, against the roster as it is now. A proposal that would be
    // refused is never put to the person.
    let shown = roster
        .team_change(&request)
        .map_err(|error| Refusal::new(ReasonClass::Validation, error))?;
    let wait = wait_for(wait_seconds);
    let asked = crate::permission::Request {
        chat_key: Some(chat_key.to_string()),
        tool_name: Some(tool.into()),
        tool_input: Some(json!({
            "change": describe_team(roster, &shown),
            "changeFacts": team_facts(roster, &shown),
        })),
        once: true,
        answer_within_secs: Some(wait.as_secs()),
        ..Default::default()
    };
    approved(&ask(asked).await, wait)?;
    let saved = crate::team::change_team_unchanged(team, &request, &shown)?;
    Ok((saved, shown))
}

/// Propose a new peer-help team, global, with the members named. An agent
/// already on another team leaves it to join, and the card says so.
pub async fn propose_team_create<A, F>(
    roster: &Roster,
    team: &Path,
    chat_key: &str,
    proposal: TeamCreateProposal,
    ask: A,
) -> Result<(AgentTeam, TeamChange), Refusal>
where
    A: FnOnce(crate::permission::Request) -> F,
    F: Future<Output = Answer>,
{
    let invalid = |error: String| Refusal::new(ReasonClass::Validation, error);
    let request = TeamRequest {
        id: None,
        name: Some(proposal.name),
        add: agent_ids(roster, &proposal.members).map_err(invalid)?,
        remove: Vec::new(),
    };
    propose_team(
        roster,
        team,
        chat_key,
        "mcp__octiq__team_create",
        request,
        proposal.wait_seconds,
        ask,
    )
    .await
}

/// Propose renaming a team, adding agents to it or removing agents from it.
/// Nothing else about the team or an agent changes: not the project the team
/// belongs to, and no agent's manager, access, provider, model or project.
pub async fn propose_team_update<A, F>(
    roster: &Roster,
    team: &Path,
    chat_key: &str,
    proposal: TeamUpdateProposal,
    ask: A,
) -> Result<(AgentTeam, TeamChange), Refusal>
where
    A: FnOnce(crate::permission::Request) -> F,
    F: Future<Output = Answer>,
{
    let invalid = |error: String| Refusal::new(ReasonClass::Validation, error);
    if proposal.team.trim().is_empty() {
        return Err(invalid(
            "Name the team to change, by id or name from agent_list.".into(),
        ));
    }
    let target = pick(
        &roster.teams,
        &proposal.team,
        |t| &t.id,
        |t| &t.name,
        "team",
    )
    .map_err(invalid)?;
    let request = TeamRequest {
        id: Some(target.id.clone()),
        name: proposal.name,
        add: agent_ids(roster, &proposal.add_members).map_err(invalid)?,
        remove: agent_ids(roster, &proposal.remove_members).map_err(invalid)?,
    };
    propose_team(
        roster,
        team,
        chat_key,
        "mcp__octiq__team_update",
        request,
        proposal.wait_seconds,
        ask,
    )
    .await
}

/// Propose a new shared agent policy, put it to the person, and save it only
/// on their Allow, against the policy as it was when proposed.
pub async fn propose_policy<A, F>(
    roster: &Roster,
    team: &Path,
    chat_key: &str,
    proposal: PolicyProposal,
    ask: A,
) -> Result<AgentPolicy, Refusal>
where
    A: FnOnce(crate::permission::Request) -> F,
    F: Future<Output = Answer>,
{
    let invalid = |error: String| Refusal::new(ReasonClass::Validation, error);
    let text = crate::team::check_policy(&proposal.policy).map_err(invalid)?;
    if text == roster.policy.text {
        return Err(invalid("That is already the shared agent policy.".into()));
    }
    let wait = wait_for(proposal.wait_seconds);
    let request = crate::permission::Request {
        chat_key: Some(chat_key.to_string()),
        tool_name: Some("mcp__octiq__agent_policy_update".into()),
        tool_input: Some(json!({
            "change": describe_policy(&roster.policy, &text),
            "changeFacts": policy_facts(&roster.policy, &text),
        })),
        once: true,
        answer_within_secs: Some(wait.as_secs()),
        ..Default::default()
    };
    approved(&ask(request).await, wait)?;
    crate::team::set_policy_unchanged(team, &text, roster.policy.updated_at).map_err(Refusal::from)
}

#[cfg(test)]
#[path = "team_tools_tests.rs"]
mod tests;

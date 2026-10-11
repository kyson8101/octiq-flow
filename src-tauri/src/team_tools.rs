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
                && p.persistent_prompt.is_none();
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
            };
            Ok(Draft {
                draft,
                before: Some(current),
            })
        }
    }
}

fn provider_name(agent: ChatAgent) -> &'static str {
    match agent {
        ChatAgent::Claude => "Claude",
        ChatAgent::Codex => "Codex",
        ChatAgent::Pi => "pi",
        ChatAgent::Antigravity => "Antigravity",
    }
}

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
    fields(roster, before)
        .into_iter()
        .zip(fields(roster, after))
        .filter(|((_, was), (_, now))| was != now)
        .map(|((label, was), (_, now))| (label, was, now))
        .collect()
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
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A team file of the test's own, removed when the guard drops.
    fn temp_team() -> (crate::test_dir::TestDir, std::path::PathBuf) {
        let dir = crate::test_dir::TestDir::new("team-tools");
        let path = dir.join("team.json");
        (dir, path)
    }

    fn workspace(id: &str, name: &str) -> Workspace {
        serde_json::from_value(json!({ "id": id, "name": name })).unwrap()
    }

    fn register(team: &Path, name: &str, project: Option<&str>) -> TeamAgent {
        crate::team::save(
            team,
            TeamDraft {
                id: None,
                name: name.into(),
                role: "Writes code.".into(),
                agent: ChatAgent::Claude,
                model: "sonnet".into(),
                effort: Some("high".into()),
                access: Some(Access::Auto),
                project_id: project.map(str::to_string),
                reports_to: None,
                avatar: None,
                team_id: None,
                persistent_prompt: None,
            },
        )
        .unwrap()
    }

    fn roster(team: &Path) -> Roster {
        Roster::read(
            team,
            vec![workspace("p1", "Starfall"), workspace("p2", "Octiq")],
        )
        .unwrap()
    }

    fn answer(decision: &'static str, reason: &str) -> Answer {
        Answer {
            decision,
            reason: reason.into(),
        }
    }

    /// An asker that records the card it was shown and answers `decision`.
    fn asker(
        decision: &'static str,
        reason: &'static str,
    ) -> (
        Arc<Mutex<Vec<crate::permission::Request>>>,
        impl FnOnce(crate::permission::Request) -> std::future::Ready<Answer>,
    ) {
        let shown = Arc::new(Mutex::new(Vec::new()));
        let seen = shown.clone();
        (shown, move |request| {
            seen.lock().unwrap().push(request);
            std::future::ready(answer(decision, reason))
        })
    }

    fn stored(team: &Path) -> Vec<TeamAgent> {
        crate::team::list(team, None, true).unwrap()
    }

    /// The General-chat report, reproduced: an agent_update card nobody
    /// answers runs out on OctiqFlow's own timer, through the real
    /// `permission::ask`, and the refusal says so — OctiqFlow, approval
    /// expired, a warning — so it can never be drawn as Claude blocking.
    ///
    /// The deadline is cut from 180 s to one so the test is quick; it is the
    /// same timer either way (`answer_within_secs`). The card carries no chat
    /// key, so the real phone a chat key would push to is never told.
    #[tokio::test]
    async fn an_unanswered_card_expires_as_octiqflows_approval_expired() {
        let (_dir, team) = temp_team();
        register(&team, "Potato", None);
        // Someone was here a moment ago, so the question is put up and waited
        // on rather than answered "nobody is watching".
        crate::bus::client_joined();
        crate::bus::client_left();
        let shown = Arc::new(Mutex::new(None));
        let seen = shown.clone();
        let started = std::time::Instant::now();
        let refused = propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Update,
            Proposal {
                agent: Some("Potato".into()),
                role: Some("Changed while nobody looked.".into()),
                ..Proposal::default()
            },
            move |mut request: crate::permission::Request| {
                *seen.lock().unwrap() = request.answer_within_secs;
                request.chat_key = None;
                request.answer_within_secs = Some(1);
                crate::permission::ask(request)
            },
        )
        .await
        .unwrap_err();
        assert!(
            started.elapsed() >= Duration::from_secs(1),
            "it waited out the card"
        );
        assert_eq!(
            *shown.lock().unwrap(),
            Some(180),
            "the real card's deadline"
        );
        assert_eq!(
            refused.outcome,
            crate::outcome::Outcome::host(ReasonClass::ApprovalExpired)
        );
        assert_eq!(
            refused.body()["outcome"],
            json!({"origin": "octiqflow", "reasonClass": "approval-expired", "severity": "warning"})
        );
        assert!(refused.message.contains("did not answer"), "{refused}");
        assert_eq!(stored(&team)[0].role, "Writes code.", "nothing was saved");
    }

    #[tokio::test]
    async fn a_registration_is_saved_only_on_the_persons_allow() {
        let (_dir, team) = temp_team();
        let lead = register(&team, "Potato", None);
        let proposal = || Proposal {
            name: Some("Nova".into()),
            role: Some("Leads Starfall.".into()),
            provider: Some(ChatAgent::Codex),
            model: Some("gpt-5.5".into()),
            effort: Some("medium".into()),
            project: Some("starfall".into()),
            reports_to: Some("potato".into()),
            ..Proposal::default()
        };

        let (shown, deny) = asker("deny", "you denied it");
        let refused = propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Register,
            proposal(),
            deny,
        )
        .await;
        let refused = refused.unwrap_err();
        assert_eq!(
            refused.message,
            "The person declined this change, so nothing was changed."
        );
        assert_eq!(
            refused.outcome,
            crate::outcome::Outcome::host(ReasonClass::ApprovalDenied),
            "a Deny is OctiqFlow's card, not the provider"
        );
        assert_eq!(stored(&team).len(), 1, "a denial saves nothing");
        let card = shown.lock().unwrap().pop().unwrap();
        assert_eq!(card.chat_key.as_deref(), Some("chat:lead"));
        assert_eq!(
            card.tool_name.as_deref(),
            Some("mcp__octiq__agent_register")
        );
        assert!(card.once, "the card is one-off: no Always");
        assert_eq!(card.answer_within_secs, Some(180));
        let change = card.tool_input.unwrap()["change"]
            .as_str()
            .unwrap()
            .to_string();
        for line in [
            "Register a new agent, Nova.",
            "Provider: Codex",
            "Model: gpt-5.5",
            "Effort: medium",
            "Available in: Starfall",
            "Reports to: Potato",
            "Team: none",
        ] {
            assert!(change.contains(line), "{line:?} missing from:\n{change}");
        }

        let (_, allow) = asker("allow", "you allowed it");
        let saved = propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Register,
            proposal(),
            allow,
        )
        .await
        .unwrap();
        assert_eq!(saved.name, "Nova");
        assert_eq!(saved.agent, ChatAgent::Codex);
        assert_eq!(saved.project_id.as_deref(), Some("p1"));
        assert_eq!(saved.reports_to.as_deref(), Some(lead.id.as_str()));
        assert_eq!(stored(&team).len(), 2);
    }

    #[tokio::test]
    async fn a_proposal_the_settings_form_would_refuse_never_reaches_the_person() {
        let (_dir, team) = temp_team();
        register(&team, "Potato", None);
        let scoped = register(&team, "Scoped", Some("p2"));
        let cases = [
            // The form's own rules (team::save)…
            (
                Kind::Register,
                Proposal {
                    name: Some("potato".into()),
                    provider: Some(ChatAgent::Claude),
                    model: Some("opus".into()),
                    ..Proposal::default()
                },
                "Another agent is already called potato.",
            ),
            (
                Kind::Register,
                Proposal {
                    name: Some("Pi agent".into()),
                    provider: Some(ChatAgent::Pi),
                    model: Some("x".into()),
                    ..Proposal::default()
                },
                "Choose Claude, Codex or Antigravity for a registered agent.",
            ),
            (
                Kind::Register,
                Proposal {
                    name: Some("Global".into()),
                    provider: Some(ChatAgent::Claude),
                    model: Some("opus".into()),
                    reports_to: Some(scoped.id.clone()),
                    ..Proposal::default()
                },
                "Global cannot report to Scoped: that agent is not available everywhere Global is.",
            ),
            (
                Kind::Update,
                Proposal {
                    agent: Some("Potato".into()),
                    reports_to: Some("Potato".into()),
                    ..Proposal::default()
                },
                "An agent cannot report to itself.",
            ),
            // …and what only an agent's words can get wrong.
            (
                Kind::Register,
                Proposal {
                    name: Some("Lost".into()),
                    provider: Some(ChatAgent::Claude),
                    model: Some("opus".into()),
                    project: Some("Nowhere".into()),
                    ..Proposal::default()
                },
                "No project is called Nowhere. Call agent_list for the ids.",
            ),
            (
                Kind::Update,
                Proposal {
                    agent: Some("Potato".into()),
                    provider: Some(ChatAgent::Codex),
                    ..Proposal::default()
                },
                "Potato moves to another provider, so choose its model there too.",
            ),
            (
                Kind::Update,
                Proposal {
                    agent: Some("Potato".into()),
                    ..Proposal::default()
                },
                "Say what to change about Potato.",
            ),
            (
                Kind::Register,
                Proposal {
                    agent: Some("Potato".into()),
                    name: Some("Other".into()),
                    ..Proposal::default()
                },
                "agent_register adds a new agent; use agent_update to change one.",
            ),
        ];
        for (kind, proposal, expected) in cases {
            let (shown, allow) = asker("allow", "you allowed it");
            let error = propose(&roster(&team), &team, "chat:lead", kind, proposal, allow)
                .await
                .unwrap_err();
            assert_eq!(error.message, expected);
            assert_eq!(
                error.outcome,
                crate::outcome::Outcome::host(ReasonClass::Validation),
                "{expected}: refused before any card, as validation"
            );
            assert!(shown.lock().unwrap().is_empty(), "{expected}: no card");
        }
        assert_eq!(stored(&team).len(), 2);
    }

    #[tokio::test]
    async fn an_update_shows_only_what_moves_and_keeps_the_rest() {
        let (_dir, team) = temp_team();
        let before = register(&team, "Potato", None);
        let (shown, allow) = asker("allow", "you allowed it");
        let saved = propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Update,
            Proposal {
                agent: Some(before.id.clone()),
                role: Some("Leads every project.".into()),
                effort: Some("".into()),
                ..Proposal::default()
            },
            allow,
        )
        .await
        .unwrap();
        let card = shown.lock().unwrap().pop().unwrap();
        assert_eq!(card.tool_name.as_deref(), Some("mcp__octiq__agent_update"));
        let change = card.tool_input.unwrap()["change"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            change,
            "Change the agent Potato.\n\nRole: Writes code. → Leads every project.\nEffort: high → default"
        );
        assert_eq!(saved.role, "Leads every project.");
        assert_eq!(saved.effort, None);
        assert_eq!(saved.model, before.model);
        assert_eq!(saved.memory_note, before.memory_note);
    }

    #[tokio::test]
    async fn an_agent_changed_while_the_card_was_up_is_not_overwritten() {
        let (_dir, team) = temp_team();
        let before = register(&team, "Potato", None);
        let path = team.clone();
        let racing = before.clone();
        // The person edits the agent in Settings while the card is up.
        let ask = move |_request| {
            crate::team::save(
                &path,
                TeamDraft {
                    id: Some(racing.id.clone()),
                    name: "Potato".into(),
                    role: "Edited in Settings.".into(),
                    agent: racing.agent,
                    model: racing.model.clone(),
                    effort: racing.effort.clone(),
                    access: Some(racing.access),
                    project_id: None,
                    reports_to: None,
                    avatar: None,
                    team_id: None,
                    persistent_prompt: None,
                },
            )
            .unwrap();
            std::future::ready(answer("allow", "you allowed it"))
        };
        // Clocks are milliseconds: make sure the edit lands on a later one.
        std::thread::sleep(Duration::from_millis(5));
        let error = propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Update,
            Proposal {
                agent: Some("Potato".into()),
                role: Some("From the agent.".into()),
                ..Proposal::default()
            },
            ask,
        )
        .await
        .unwrap_err();
        assert!(
            error.message.contains("was changed while this waited"),
            "{error}"
        );
        assert_eq!(stored(&team)[0].role, "Edited in Settings.");
    }

    #[test]
    fn every_unanswered_card_is_told_apart() {
        let wait = Duration::from_secs(50);
        assert!(approved(&answer("allow", "you allowed it"), wait).is_ok());
        let expired = approved(&answer("deny", "nobody answered in time"), wait).unwrap_err();
        assert!(expired.message.contains("within 50 seconds"));
        assert_eq!(
            expired.outcome,
            crate::outcome::Outcome::host(ReasonClass::ApprovalExpired)
        );
        let unwatched =
            approved(&answer("abstain", "nobody is watching OctiqFlow"), wait).unwrap_err();
        assert!(unwatched.message.starts_with("Nobody has OctiqFlow open"));
        assert_eq!(unwatched.outcome.origin, crate::outcome::Origin::Octiqflow);
        assert_eq!(wait_for(None), crate::permission::ANSWER_TIMEOUT);
        assert_eq!(wait_for(Some(1)), WAIT_MIN);
        assert_eq!(wait_for(Some(50)), Duration::from_secs(50));
        assert_eq!(wait_for(Some(10_000)), crate::permission::ANSWER_TIMEOUT);
    }

    #[test]
    fn the_listing_names_projects_and_can_be_scoped_to_one() {
        let (_dir, team) = temp_team();
        register(&team, "Potato", None);
        register(&team, "Scoped", Some("p2"));
        register(&team, "Elsewhere", Some("p1"));
        let all = listing(&roster(&team), ListArgs::default()).unwrap();
        assert_eq!(all["agents"].as_array().unwrap().len(), 3);
        assert_eq!(
            all["projects"][0],
            json!({ "id": "p1", "name": "Starfall" })
        );
        assert!(all["agents"][0].get("avatar").is_none());
        assert_eq!(all["agents"][0]["provider"], "claude");

        let octiq = listing(
            &roster(&team),
            ListArgs {
                project: Some("Octiq".into()),
            },
        )
        .unwrap();
        let names: Vec<_> = octiq["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, ["Potato", "Scoped"]);
    }

    #[test]
    fn an_unknown_argument_is_refused_rather_than_ignored() {
        let parsed: Result<Proposal, _> =
            serde_json::from_value(json!({ "name": "Nova", "avatar": "data:x" }));
        assert!(parsed.is_err());
        let parsed: Result<PolicyProposal, _> =
            serde_json::from_value(json!({ "policy": "x", "agent": "Nova" }));
        assert!(parsed.is_err());
    }

    #[test]
    fn the_listing_carries_the_policy_and_each_persistent_prompt() {
        let (_dir, team) = temp_team();
        let potato = register(&team, "Potato", None);
        crate::team::set_policy(&team, "Use worktrees.").unwrap();
        crate::team::save(
            &team,
            TeamDraft {
                id: Some(potato.id.clone()),
                persistent_prompt: Some("Build first.".into()),
                ..redraft(&potato)
            },
        )
        .unwrap();
        let all = listing(&roster(&team), ListArgs::default()).unwrap();
        assert_eq!(all["agentPolicy"], "Use worktrees.");
        assert_eq!(all["agents"][0]["persistentPrompt"], "Build first.");
        assert_eq!(all["agents"][0]["role"], "Writes code.");
    }

    /// The draft the Settings form would send for `agent` unchanged.
    pub(super) fn redraft(agent: &TeamAgent) -> TeamDraft {
        TeamDraft {
            id: Some(agent.id.clone()),
            name: agent.name.clone(),
            role: agent.role.clone(),
            agent: agent.agent,
            model: agent.model.clone(),
            effort: agent.effort.clone(),
            access: Some(agent.access),
            project_id: agent.project_id.clone(),
            reports_to: agent.reports_to.clone(),
            avatar: None,
            team_id: None,
            persistent_prompt: None,
        }
    }

    /// The card lists the role with the other fields and never the persistent
    /// prompt, unless this change sets or clears it: then the whole text, and
    /// how long it is.
    #[tokio::test]
    async fn the_card_shows_a_persistent_prompt_only_when_it_changes() {
        let (_dir, team) = temp_team();
        let potato = register(&team, "Potato", None);
        let hidden = "SECRET-RUNBOOK ".repeat(500);
        crate::team::save(
            &team,
            TeamDraft {
                persistent_prompt: Some(hidden.clone()),
                ..redraft(&potato)
            },
        )
        .unwrap();

        // A change to the role alone: the prompt stays off the card.
        let (shown, allow) = asker("allow", "you allowed it");
        propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Update,
            Proposal {
                agent: Some("Potato".into()),
                role: Some("Leads.".into()),
                ..Proposal::default()
            },
            allow,
        )
        .await
        .unwrap();
        let card = shown.lock().unwrap().pop().unwrap().tool_input.unwrap()["change"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(card.contains("Role: Writes code. → Leads."), "{card}");
        assert!(!card.contains("SECRET-RUNBOOK"), "{card}");
        assert!(!card.contains("Persistent prompt"), "{card}");
        assert_eq!(stored(&team)[0].persistent_prompt, hidden.trim());

        // A change to the prompt: the whole new text, with its length.
        let runbook = "x".repeat(crate::team::PERSISTENT_PROMPT_MAX);
        let (shown, allow) = asker("allow", "you allowed it");
        let saved = propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Update,
            Proposal {
                agent: Some("Potato".into()),
                persistent_prompt: Some(runbook.clone()),
                ..Proposal::default()
            },
            allow,
        )
        .await
        .unwrap();
        assert_eq!(saved.persistent_prompt, runbook, "never cut");
        let card = shown.lock().unwrap().pop().unwrap().tool_input.unwrap()["change"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            card.ends_with(&format!(
                "Persistent prompt (8000 characters, replaces the current one):\n{runbook}"
            )),
            "{card}"
        );
        assert!(
            !card.contains("SECRET-RUNBOOK"),
            "only the new text: {card}"
        );

        // Clearing it says so.
        let (shown, allow) = asker("allow", "you allowed it");
        propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Update,
            Proposal {
                agent: Some("Potato".into()),
                persistent_prompt: Some(String::new()),
                ..Proposal::default()
            },
            allow,
        )
        .await
        .unwrap();
        let card = shown.lock().unwrap().pop().unwrap().tool_input.unwrap()["change"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(card.ends_with("Persistent prompt: cleared"), "{card}");
        assert_eq!(stored(&team)[0].persistent_prompt, "");

        // Too long is refused before anyone is asked.
        let (shown, allow) = asker("allow", "you allowed it");
        let refused = propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Update,
            Proposal {
                agent: Some("Potato".into()),
                persistent_prompt: Some(format!("{runbook}x")),
                ..Proposal::default()
            },
            allow,
        )
        .await
        .unwrap_err();
        assert!(
            refused.message.contains("longer than 8000"),
            "{}",
            refused.message
        );
        assert!(shown.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_policy_is_saved_only_on_the_persons_allow_against_the_version_shown() {
        let (_dir, team) = temp_team();
        let proposal = |text: &str| PolicyProposal {
            policy: text.into(),
            wait_seconds: Some(50),
        };

        let (shown, deny) = asker("deny", "you denied it");
        let refused = propose_policy(
            &roster(&team),
            &team,
            "chat:lead",
            proposal("Use worktrees."),
            deny,
        )
        .await
        .unwrap_err();
        assert_eq!(
            refused.outcome,
            crate::outcome::Outcome::host(ReasonClass::ApprovalDenied)
        );
        assert_eq!(crate::team::policy(&team).unwrap().text, "");
        let card = shown.lock().unwrap().pop().unwrap();
        assert_eq!(
            card.tool_name.as_deref(),
            Some("mcp__octiq__agent_policy_update")
        );
        assert!(card.once);
        assert_eq!(card.answer_within_secs, Some(50));
        assert_eq!(
            card.tool_input.unwrap()["change"],
            "Set the shared agent policy that every agent's brief starts with.\n\nNew policy (14 characters):\nUse worktrees."
        );

        let (_, allow) = asker("allow", "you allowed it");
        let saved = propose_policy(
            &roster(&team),
            &team,
            "chat:lead",
            proposal(" Use worktrees. "),
            allow,
        )
        .await
        .unwrap();
        assert_eq!(saved.text, "Use worktrees.");
        assert_eq!(
            policy_saved_text(&saved)["status"],
            "saved",
            "only saved means written"
        );

        // Proposed against one version, approved after another was saved.
        let before = roster(&team);
        crate::team::set_policy(&team, "Edited in Settings.").unwrap();
        let (_, allow) = asker("allow", "you allowed it");
        let stale = propose_policy(&before, &team, "chat:lead", proposal("Mine."), allow)
            .await
            .unwrap_err();
        assert!(
            stale.message.contains("changed while this waited"),
            "{}",
            stale.message
        );
        assert_eq!(
            crate::team::policy(&team).unwrap().text,
            "Edited in Settings."
        );

        // Clearing, and the refusals that never reach the person.
        let (shown, allow) = asker("allow", "you allowed it");
        propose_policy(&roster(&team), &team, "chat:lead", proposal(""), allow)
            .await
            .unwrap();
        assert_eq!(
            shown.lock().unwrap().pop().unwrap().tool_input.unwrap()["change"],
            "Clear the shared agent policy that every agent's brief starts with."
        );
        assert_eq!(crate::team::policy(&team).unwrap().text, "");
        let (shown, allow) = asker("allow", "you allowed it");
        let same = propose_policy(&roster(&team), &team, "chat:lead", proposal(""), allow)
            .await
            .unwrap_err();
        assert!(same.message.contains("already"), "{}", same.message);
        let (_, allow) = asker("allow", "you allowed it");
        let long = propose_policy(
            &roster(&team),
            &team,
            "chat:lead",
            proposal(&"p".repeat(crate::team::AGENT_POLICY_MAX + 1)),
            allow,
        )
        .await
        .unwrap_err();
        assert!(
            long.message.contains("longer than 4000"),
            "{}",
            long.message
        );
        assert!(shown.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_agent_is_removed_only_on_the_persons_allow_against_the_version_shown() {
        let (_dir, team) = temp_team();
        let potato = register(&team, "Potato", None);
        let cto = crate::team::save(
            &team,
            TeamDraft {
                id: None,
                name: "Cto".into(),
                role: "Leads Octiq.".into(),
                agent: ChatAgent::Claude,
                model: "opus".into(),
                effort: Some("high".into()),
                access: Some(Access::Auto),
                project_id: Some("p2".into()),
                reports_to: Some(potato.id.clone()),
                avatar: None,
                team_id: None,
                persistent_prompt: None,
            },
        )
        .unwrap();
        let dev = crate::team::save(
            &team,
            TeamDraft {
                id: None,
                name: "Dev".into(),
                role: "Writes code.".into(),
                agent: ChatAgent::Codex,
                model: "gpt-5.6-sol".into(),
                effort: None,
                access: Some(Access::Auto),
                project_id: Some("p2".into()),
                reports_to: Some(cto.id.clone()),
                avatar: None,
                team_id: None,
                persistent_prompt: None,
            },
        )
        .unwrap();
        crate::team::set_head(&team, Some(&potato.id)).unwrap();
        let proposal = |spec: &str| DeleteProposal {
            agent: spec.into(),
            wait_seconds: Some(50),
        };

        // The card: who goes, and what it does to the chart. A Deny removes
        // nobody.
        let (shown, deny) = asker("deny", "you denied it");
        let refused = propose_delete(&roster(&team), &team, "chat:lead", proposal("cto"), deny)
            .await
            .unwrap_err();
        assert_eq!(
            refused.outcome,
            crate::outcome::Outcome::host(ReasonClass::ApprovalDenied)
        );
        assert_eq!(stored(&team).len(), 3);
        let card = shown.lock().unwrap().pop().unwrap();
        assert_eq!(card.tool_name.as_deref(), Some("mcp__octiq__agent_delete"));
        assert!(card.once);
        assert_eq!(card.answer_within_secs, Some(50));
        assert_eq!(
            card.tool_input.unwrap()["change"],
            "Remove the agent Cto.\n\nRole: Leads Octiq.\nProvider: Claude\nModel: opus\nEffort: high\nAccess: auto\nAvailable in: Octiq\nReports to: Potato\nTeam: none\n\nIts direct report (Dev) will report to Potato.\n\nIts memory note in the vault is kept."
        );

        // The head's card says the seat empties.
        let (shown, deny) = asker("deny", "you denied it");
        propose_delete(
            &roster(&team),
            &team,
            "chat:lead",
            proposal(&potato.id),
            deny,
        )
        .await
        .unwrap_err();
        let change = shown.lock().unwrap().pop().unwrap().tool_input.unwrap()["change"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(change.contains("It is the head"), "{change}");
        assert!(
            change.contains("Its direct report (Cto) will report to the person."),
            "{change}"
        );

        // Proposed against one version, approved after another was saved.
        let before = roster(&team);
        let edited = TeamDraft {
            id: Some(cto.id.clone()),
            name: "Cto".into(),
            role: "Leads Octiq and more.".into(),
            agent: ChatAgent::Claude,
            model: "opus".into(),
            effort: Some("high".into()),
            access: Some(Access::Auto),
            project_id: Some("p2".into()),
            reports_to: Some(potato.id.clone()),
            avatar: None,
            team_id: None,
            persistent_prompt: None,
        };
        crate::team::save(&team, edited).unwrap();
        let (_, allow) = asker("allow", "you allowed it");
        let stale = propose_delete(&before, &team, "chat:lead", proposal("Cto"), allow)
            .await
            .unwrap_err();
        assert!(
            stale.message.contains("changed while this waited"),
            "{}",
            stale.message
        );
        assert_eq!(stored(&team).len(), 3);

        // Allowed: gone, the report moved up, the answer names who went.
        let (_, allow) = asker("allow", "you allowed it");
        let gone = propose_delete(&roster(&team), &team, "chat:lead", proposal("Cto"), allow)
            .await
            .unwrap();
        assert_eq!(gone.id, cto.id);
        assert_eq!(deleted_text(&roster(&team), &gone)["status"], "saved");
        assert_eq!(
            deleted_text(&roster(&team), &gone)["text"],
            "The person approved it: Cto is removed."
        );
        let left = stored(&team);
        assert_eq!(left.len(), 2);
        assert_eq!(
            left.iter()
                .find(|a| a.id == dev.id)
                .unwrap()
                .reports_to
                .as_deref(),
            Some(potato.id.as_str())
        );

        // The refusals that never reach the person.
        let (shown, allow) = asker("allow", "you allowed it");
        let missing = propose_delete(
            &roster(&team),
            &team,
            "chat:lead",
            proposal("Nobody"),
            allow,
        )
        .await
        .unwrap_err();
        assert!(
            missing.message.contains("No agent is called Nobody"),
            "{}",
            missing.message
        );
        let (_, allow) = asker("allow", "you allowed it");
        let blank = propose_delete(&roster(&team), &team, "chat:lead", proposal("  "), allow)
            .await
            .unwrap_err();
        assert!(
            blank.message.contains("Name the agent"),
            "{}",
            blank.message
        );
        assert!(shown.lock().unwrap().is_empty());
        assert_eq!(stored(&team).len(), 2);
    }

    fn register_under(team: &Path, name: &str, manager: &TeamAgent) -> TeamAgent {
        crate::team::save(
            team,
            TeamDraft {
                id: None,
                name: name.into(),
                role: "Writes code.".into(),
                agent: ChatAgent::Claude,
                model: "sonnet".into(),
                effort: Some("high".into()),
                access: Some(Access::Auto),
                project_id: None,
                reports_to: Some(manager.id.clone()),
                avatar: None,
                team_id: None,
                persistent_prompt: None,
            },
        )
        .unwrap()
    }

    /// Move `agent` under `manager` (the person, with `None`), as the Settings
    /// form would.
    fn move_under(team: &Path, agent: &TeamAgent, manager: Option<&TeamAgent>) -> TeamAgent {
        crate::team::save(
            team,
            TeamDraft {
                id: Some(agent.id.clone()),
                name: agent.name.clone(),
                role: agent.role.clone(),
                agent: agent.agent,
                model: agent.model.clone(),
                effort: agent.effort.clone(),
                access: Some(agent.access),
                project_id: agent.project_id.clone(),
                reports_to: manager.map(|m| m.id.clone()),
                avatar: None,
                team_id: None,
                persistent_prompt: None,
            },
        )
        .unwrap()
    }

    /// An asker for a card that waits while `meanwhile` happens to the
    /// roster, and is then allowed: the card it was shown comes back.
    fn allowed_after(
        meanwhile: impl FnOnce(),
    ) -> (
        Arc<Mutex<Vec<crate::permission::Request>>>,
        impl FnOnce(crate::permission::Request) -> std::future::Ready<Answer>,
    ) {
        let shown = Arc::new(Mutex::new(Vec::new()));
        let seen = shown.clone();
        (shown, move |request| {
            seen.lock().unwrap().push(request);
            meanwhile();
            std::future::ready(answer("allow", "you allowed it"))
        })
    }

    fn card_of(shown: &Arc<Mutex<Vec<crate::permission::Request>>>) -> String {
        shown.lock().unwrap().pop().unwrap().tool_input.unwrap()["change"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn remove(spec: &str) -> DeleteProposal {
        DeleteProposal {
            agent: spec.into(),
            wait_seconds: Some(50),
        }
    }

    /// agent_delete review, H1: the person's Allow is held to everything the
    /// card said about the chart, not only to the removed agent's own
    /// version. Each of these changes the chart while the card waits without
    /// touching the agent the card names; each is refused and removes nobody.
    #[tokio::test]
    async fn a_removal_is_refused_when_the_chart_is_no_longer_what_its_card_said() {
        async fn refused(
            team: &Path,
            spec: &str,
            meanwhile: impl FnOnce(),
            said: &str,
            what: &str,
        ) -> String {
            let (shown, allow) = allowed_after(meanwhile);
            let stale = propose_delete(&roster(team), team, "chat:lead", remove(spec), allow)
                .await
                .unwrap_err();
            assert_eq!(
                stale.message,
                format!("{spec} was changed while this waited for approval, so nothing was removed: {what}. Read it again and propose the removal again."),
            );
            let card = card_of(&shown);
            assert!(card.contains(said), "{card}");
            card
        }

        // A report added during the wait: it was never on the card.
        let (_dir, team) = temp_team();
        let lead = register(&team, "Lead", None);
        let dev = register(&team, "Dev", None);
        let card = refused(
            &team,
            "Lead",
            || {
                move_under(&team, &dev, Some(&lead));
            },
            "Remove the agent Lead.",
            "its direct reports are not the ones the card listed",
        )
        .await;
        assert!(!card.contains("Dev"), "{card}");
        let left = stored(&team);
        assert_eq!(left.len(), 2);
        // Nothing moved: Dev still reports to Lead, as it did before Allow.
        let dev = left.iter().find(|a| a.id == dev.id).unwrap().clone();
        assert_eq!(dev.reports_to.as_deref(), Some(lead.id.as_str()));

        // A report moved away during the wait: the card promised a move that
        // would not happen.
        let before = stored(&team);
        refused(
            &team,
            "Lead",
            || {
                move_under(&team, &dev, None);
            },
            "Its direct report (Dev) will report to the person.",
            "its direct reports are not the ones the card listed",
        )
        .await;
        assert_eq!(stored(&team).len(), before.len());

        // Made the head during the wait: the card had no seat warning.
        let card = refused(
            &team,
            "Lead",
            || {
                crate::team::set_head(&team, Some(&lead.id)).unwrap();
            },
            "Remove the agent Lead.",
            "it is now the head",
        )
        .await;
        assert!(!card.contains("It is the head"), "{card}");
        assert_eq!(
            crate::team::head(&team).unwrap().map(|a| a.id),
            Some(lead.id.clone())
        );

        // Made the front desk during the wait.
        let card = refused(
            &team,
            "Dev",
            || {
                crate::team::set_front_desk(&team, Some(&dev.id)).unwrap();
            },
            "Remove the agent Dev.",
            "it is now the front desk",
        )
        .await;
        assert!(!card.contains("It is the front desk"), "{card}");
        assert_eq!(
            crate::team::front_desk(&team).unwrap().map(|a| a.id),
            Some(dev.id.clone())
        );
        assert_eq!(stored(&team).len(), 2);

        // Its manager removed during the wait: the card names a manager its
        // reports can no longer be sent to.
        let (_dir, team) = temp_team();
        let manager = register(&team, "Manager", None);
        let lead = register_under(&team, "Lead", &manager);
        let dev = register_under(&team, "Dev", &lead);
        let (shown, allow) = allowed_after(|| crate::team::delete(&team, &manager.id).unwrap());
        let stale = propose_delete(&roster(&team), &team, "chat:lead", remove("Lead"), allow)
            .await
            .unwrap_err();
        assert!(
            card_of(&shown).contains("Its direct report (Dev) will report to Manager."),
            "the card"
        );
        // Lead itself moved up when Manager went, so it is a later version.
        assert_eq!(
            stale.message,
            "Lead was changed while this waited for approval, so nothing was removed. Read it again and propose the removal again."
        );
        let left = stored(&team);
        assert_eq!(left.len(), 2);
        let dev = left.iter().find(|a| a.id == dev.id).unwrap();
        assert_eq!(dev.reports_to.as_deref(), Some(lead.id.as_str()));
    }

    /// The other half of H1: a chart that is still what the card said is
    /// removed from, its reports go to exactly who the card named, and each
    /// report that moved is a new version, so a card still waiting on one of
    /// them is refused instead of being saved over the move.
    #[tokio::test]
    async fn an_unchanged_removal_moves_the_reports_the_card_named_and_makes_them_new_versions() {
        let (_dir, team) = temp_team();
        let manager = register(&team, "Manager", None);
        let lead = register_under(&team, "Lead", &manager);
        let dev = register_under(&team, "Dev", &lead);
        let ops = register_under(&team, "Ops", &lead);
        let other = register_under(&team, "Other", &manager);
        // Cards made for a child before its manager goes.
        let earlier = roster(&team);

        let (shown, allow) = allowed_after(|| ());
        let gone = propose_delete(&roster(&team), &team, "chat:lead", remove("Lead"), allow)
            .await
            .unwrap();
        assert_eq!(gone.id, lead.id);
        assert!(
            card_of(&shown).contains("Its 2 direct reports (Dev, Ops) will report to Manager."),
            "the card"
        );
        let left = stored(&team);
        assert_eq!(left.len(), 4);
        let now = |id: &str| left.iter().find(|a| a.id == id).unwrap().clone();
        for moved in [&dev, &ops] {
            let after = now(&moved.id);
            assert_eq!(after.reports_to.as_deref(), Some(manager.id.as_str()));
            assert!(after.updated_at > moved.updated_at, "{}", moved.name);
        }
        // Nobody else was touched.
        assert_eq!(now(&manager.id), manager);
        assert_eq!(now(&other.id), other);

        // A stale card for a child, made while it still reported to Lead.
        let (shown, allow) = allowed_after(|| ());
        let stale = propose_delete(&earlier, &team, "chat:lead", remove("Dev"), allow)
            .await
            .unwrap_err();
        assert!(card_of(&shown).contains("Reports to: Lead"), "the card");
        assert_eq!(
            stale.message,
            "Dev was changed while this waited for approval, so nothing was removed. Read it again and propose the removal again."
        );
        let (_, allow) = allowed_after(|| ());
        let stale = propose(
            &earlier,
            &team,
            "chat:lead",
            Kind::Update,
            Proposal {
                agent: Some("Ops".into()),
                reports_to: Some(String::new()),
                ..Proposal::default()
            },
            allow,
        )
        .await
        .unwrap_err();
        assert_eq!(
            stale.message,
            "Ops was changed while this waited for approval, so nothing was saved. Read it again and propose the change again."
        );
        assert_eq!(stored(&team), left);
    }

    /// agent_delete review, M2: the page shows only the start of a long card,
    /// and the list of reports has no bound, so the seat that empties is said
    /// before it.
    #[test]
    fn a_removal_card_names_the_seat_that_empties_before_its_reports() {
        let (_dir, team) = temp_team();
        let lead = register(&team, "Lead", None);
        crate::team::set_head(&team, Some(&lead.id)).unwrap();
        let mut roster = roster(&team);
        for n in 0..300 {
            roster.agents.push(TeamAgent {
                id: format!("agent_report{n:03}"),
                name: format!("Report {n:03} with a name as long as a name may be, sixty in all"),
                reports_to: Some(lead.id.clone()),
                ..lead.clone()
            });
        }
        // The front desk has no reports, so that sentence is checked on a
        // roster of its own below; here it is the head with 300 of them.
        let shown = roster.removal(&lead.id).unwrap();
        assert_eq!(shown.reports.len(), 300);
        let text = describe_delete(&roster, &lead, &shown, None);
        assert!(text.chars().count() > 16_000, "{}", text.chars().count());
        let head = text.find("It is the head").unwrap();
        assert!(head < 2_000, "{head}");
        assert!(head < text.find("Its 300 direct reports (").unwrap());
        assert!(text.ends_with("\n\nIts memory note in the vault is kept."));

        let desk = crate::team::create_front_desk(&team, Default::default()).unwrap();
        let roster = self::roster(&team);
        let text = describe_delete(&roster, &desk, &roster.removal(&desk.id).unwrap(), None);
        assert!(
            text.ends_with("\n\nIt is the front desk: incoming requests will have no front desk until another is chosen.\n\nIts memory note in the vault is kept."),
            "{text}"
        );
    }

    /// The whole `tool_input` of the card an asker was shown.
    fn input_of(shown: &Arc<Mutex<Vec<crate::permission::Request>>>) -> Value {
        shown.lock().unwrap().pop().unwrap().tool_input.unwrap()
    }

    /// What every card's rows owe its text: the same first sentence, and
    /// every value the text shows. A field reads `label: value` there, and a
    /// field that moves `label: before → after`; a text that is replaced or
    /// cleared shows only what it becomes. A row with a `summary` is a
    /// removal's reports, which the text says in a sentence
    /// (`the_reports_row_says_what_the_text_says`); no other row carries one.
    fn rows_say_what_the_text_says(input: &Value) {
        let change = input["change"].as_str().unwrap();
        let facts = &input["changeFacts"];
        assert_eq!(
            facts["lead"].as_str().unwrap(),
            change.lines().next().unwrap(),
            "the lead is the card's first sentence"
        );
        for row in facts["rows"].as_array().unwrap() {
            let label = row["label"].as_str().unwrap();
            if label.starts_with("Direct report") {
                the_reports_row_says_what_the_text_says(change, row);
                continue;
            }
            // Any other row's summary is one line the page will draw, next
            // to a value the text states like any plain row's.
            if let Some(summary) = row.get("summary") {
                let summary = summary.as_str().unwrap();
                assert!(
                    !summary.is_empty()
                        && summary.chars().count() <= SUMMARY_MAX
                        && !summary.chars().any(ends_a_line),
                    "{row}"
                );
                assert!(row.get("before").is_none(), "a move has no summary: {row}");
            }
            let text = label == "Persistent prompt" || label == "Policy";
            match (row.get("value"), row.get("before"), row.get("after")) {
                (Some(value), None, None) if text => {
                    assert!(change.ends_with(value.as_str().unwrap()), "{row}")
                }
                (Some(value), None, None) => {
                    let line = format!("\n{label}: {}", value.as_str().unwrap());
                    assert!(change.contains(&line), "{line:?} missing from:\n{change}");
                }
                (None, Some(before), Some(after)) if text => {
                    assert_ne!(before, "", "{row}");
                    assert!(change.ends_with(after.as_str().unwrap()) || after == "");
                }
                (None, Some(before), Some(after)) => {
                    let line = format!(
                        "\n{label}: {} → {}",
                        before.as_str().unwrap(),
                        after.as_str().unwrap()
                    );
                    assert!(change.contains(&line), "{line:?} missing from:\n{change}");
                }
                _ => panic!("a row is a value, or a before and an after: {row}"),
            }
        }
    }

    /// The row a removal's reports are told in, against the sentence the text
    /// tells them in: `Its 2 direct reports (Dev, Ops) will report to Potato.`
    /// The value is that sentence's names and manager, whole. The summary is
    /// its count and its manager on one line of at most `SUMMARY_MAX`
    /// characters; a manager is shortened only when it would not fit, and is
    /// then still the start of the text's.
    fn the_reports_row_says_what_the_text_says(change: &str, row: &Value) {
        let (label, value, summary) = (
            row["label"].as_str().unwrap(),
            row["value"].as_str().unwrap(),
            row["summary"].as_str().unwrap(),
        );
        assert_eq!(row.as_object().unwrap().len(), 3, "{row}");

        // The sentence is the last thing the text says before the memory note.
        let said = change
            .strip_suffix("\n\nIts memory note in the vault is kept.")
            .and_then(|text| text.rsplit("\n\nIts ").next())
            .unwrap_or_else(|| panic!("no reports sentence in:\n{change}"));
        let (counted, rest) = said.split_once("(").unwrap();
        let count: usize = match counted {
            "direct report " => 1,
            several => several
                .strip_suffix(" direct reports ")
                .and_then(|n| n.parse().ok())
                .unwrap_or_else(|| panic!("{said}")),
        };
        assert!(count > 0, "{said}");
        let names = value
            .rsplit_once(" will report to ")
            .unwrap_or_else(|| panic!("{value}"))
            .0;
        let to = rest
            .strip_prefix(names)
            .and_then(|rest| rest.strip_prefix(") will report to "))
            .and_then(|rest| rest.strip_suffix("."))
            .unwrap_or_else(|| panic!("{names:?} are not the names in: {said}"));
        assert_eq!(value, format!("{names} will report to {to}."));
        assert_eq!(
            label,
            if count == 1 {
                "Direct report"
            } else {
                "Direct reports"
            }
        );

        assert!(summary.chars().count() <= SUMMARY_MAX, "{summary}");
        assert!(!summary.chars().any(char::is_control), "{summary:?}");
        let counts = format!(
            "{count} direct report{} will report to ",
            if count == 1 { "" } else { "s" }
        );
        let goes_to = summary
            .strip_prefix(&counts)
            .unwrap_or_else(|| panic!("{summary:?} does not start {counts:?}"));
        match goes_to.strip_suffix('…') {
            Some(start) => {
                assert!(
                    counts.chars().count() + to.chars().count() > SUMMARY_MAX,
                    "a name that fits is not cut: {summary}"
                );
                assert!(!start.is_empty() && to.starts_with(start), "{summary}");
            }
            None => assert_eq!(goes_to, to, "{summary}"),
        }
    }

    /// UI cards review, P2: a page that read the card's text back into rows
    /// took a line of a role for a field of its own. The card now carries its
    /// rows as data, and a role that holds `Access: edits → danger` on a line
    /// of its own is one Role row, next to the one real Access row.
    #[tokio::test]
    async fn a_registration_card_carries_every_field_as_one_row() {
        let (_dir, team) = temp_team();
        register(&team, "Potato", None);
        let role = "New role.\nAccess: edits → danger";
        let (shown, allow) = asker("allow", "you allowed it");
        propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Register,
            Proposal {
                name: Some("Nova".into()),
                role: Some(role.into()),
                provider: Some(ChatAgent::Codex),
                model: Some("gpt-5.5".into()),
                effort: Some("medium".into()),
                access: Some(Access::Edits),
                project: Some("starfall".into()),
                reports_to: Some("potato".into()),
                persistent_prompt: Some("Stand up daily.\nTeam: none".into()),
                ..Proposal::default()
            },
            allow,
        )
        .await
        .unwrap();
        let input = input_of(&shown);
        assert_eq!(
            input["changeFacts"],
            json!({
                "lead": "Register a new agent, Nova.",
                "rows": [
                    { "label": "Name", "value": "Nova" },
                    { "label": "Role", "value": role },
                    { "label": "Provider", "value": "Codex" },
                    { "label": "Model", "value": "gpt-5.5" },
                    { "label": "Effort", "value": "medium" },
                    { "label": "Access", "value": "edits" },
                    { "label": "Available in", "value": "Starfall" },
                    { "label": "Reports to", "value": "Potato" },
                    { "label": "Team", "value": "none" },
                    { "label": "Persistent prompt", "value": "Stand up daily.\nTeam: none" },
                ],
            })
        );
        rows_say_what_the_text_says(&input);
        // The text is what it was before the rows came with it.
        assert_eq!(
            input["change"],
            format!("Register a new agent, Nova.\n\nName: Nova\nRole: {role}\nProvider: Codex\nModel: gpt-5.5\nEffort: medium\nAccess: edits\nAvailable in: Starfall\nReports to: Potato\nTeam: none\n\nPersistent prompt (26 characters):\nStand up daily.\nTeam: none")
        );
        assert_eq!(
            input.as_object().unwrap().len(),
            2,
            "change and changeFacts, nothing else: {input}"
        );

        // No prompt proposed, no prompt row; an empty role reads as it does
        // in the text.
        let (shown, deny) = asker("deny", "you denied it");
        propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Register,
            Proposal {
                name: Some("Bare".into()),
                provider: Some(ChatAgent::Claude),
                model: Some("opus".into()),
                ..Proposal::default()
            },
            deny,
        )
        .await
        .unwrap_err();
        let input = input_of(&shown);
        let rows = input["changeFacts"]["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 9, "{rows:?}");
        assert_eq!(rows[1], json!({ "label": "Role", "value": "(none)" }));
        assert_eq!(rows[4], json!({ "label": "Effort", "value": "default" }));
        assert_eq!(
            rows[6],
            json!({ "label": "Available in", "value": "every project" })
        );
        assert_eq!(
            rows[7],
            json!({ "label": "Reports to", "value": "the person" })
        );
        rows_say_what_the_text_says(&input);
    }

    #[tokio::test]
    async fn an_update_card_carries_only_the_fields_that_move_as_rows() {
        let (_dir, team) = temp_team();
        let potato = register(&team, "Potato", None);
        let role = "New role.\nAccess: edits → danger";
        let (shown, allow) = asker("allow", "you allowed it");
        propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Update,
            Proposal {
                agent: Some(potato.id.clone()),
                role: Some(role.into()),
                access: Some(Access::Edits),
                // Named, and the same as it was: not a row.
                model: Some("sonnet".into()),
                persistent_prompt: Some("Stand up daily.".into()),
                ..Proposal::default()
            },
            allow,
        )
        .await
        .unwrap();
        let input = input_of(&shown);
        assert_eq!(
            input["changeFacts"],
            json!({
                "lead": "Change the agent Potato.",
                "rows": [
                    { "label": "Role", "before": "Writes code.", "after": role },
                    { "label": "Access", "before": "auto", "after": "edits" },
                    // Set where there was none: a plain row.
                    { "label": "Persistent prompt", "value": "Stand up daily." },
                ],
            })
        );
        rows_say_what_the_text_says(&input);
        assert_eq!(
            input["change"],
            format!("Change the agent Potato.\n\nRole: Writes code. → {role}\nAccess: auto → edits\n\nPersistent prompt (15 characters):\nStand up daily.")
        );

        // Replaced: a move from the prompt it had, which the text leaves out.
        let (shown, allow) = asker("allow", "you allowed it");
        propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Update,
            Proposal {
                agent: Some("Potato".into()),
                persistent_prompt: Some("Ship on Fridays.\nNever on Mondays.".into()),
                ..Proposal::default()
            },
            allow,
        )
        .await
        .unwrap();
        let input = input_of(&shown);
        assert_eq!(
            input["changeFacts"],
            json!({
                "lead": "Change the agent Potato.",
                "rows": [{
                    "label": "Persistent prompt",
                    "before": "Stand up daily.",
                    "after": "Ship on Fridays.\nNever on Mondays.",
                }],
            })
        );
        rows_say_what_the_text_says(&input);
        assert!(
            !input["change"]
                .as_str()
                .unwrap()
                .contains("Stand up daily."),
            "the text still shows only the new prompt"
        );

        // Cleared: a move to nothing.
        let (shown, allow) = asker("allow", "you allowed it");
        propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Update,
            Proposal {
                agent: Some("Potato".into()),
                effort: Some("".into()),
                persistent_prompt: Some(String::new()),
                ..Proposal::default()
            },
            allow,
        )
        .await
        .unwrap();
        let input = input_of(&shown);
        assert_eq!(
            input["changeFacts"]["rows"],
            json!([
                { "label": "Effort", "before": "high", "after": "default" },
                {
                    "label": "Persistent prompt",
                    "before": "Ship on Fridays.\nNever on Mondays.",
                    "after": "",
                },
            ])
        );
        rows_say_what_the_text_says(&input);
        assert!(input["change"]
            .as_str()
            .unwrap()
            .ends_with("\nPersistent prompt: cleared"));
    }

    /// agent_delete review, M3 (the person's decision of 2026-10-11): an
    /// agent with work running is refused before any card is shown, and
    /// again, in the same words, when a card that waited is answered.
    #[tokio::test]
    async fn an_agent_with_work_running_is_refused_before_a_card_and_when_one_is_answered() {
        let (_dir, team) = temp_team();
        let potato = register(&team, "Potato", None);
        let dev = register_under(&team, "Dev", &potato);
        const BUSY: &str = "Dev still has 1 task in progress in 1 run: 1 in \"Ship\" (run_1). Nothing was removed. Stop it or wait for it to finish, then remove Dev.";

        // Before a card: nobody is asked.
        let (shown, allow) = asker("allow", "you allowed it");
        let asked_of = Mutex::new(Vec::new());
        let busy = |agent: &TeamAgent| {
            asked_of.lock().unwrap().push(agent.id.clone());
            Err(BUSY.to_string())
        };
        let refused = propose_delete_when(
            &roster(&team),
            &team,
            "chat:lead",
            remove("Dev"),
            &busy,
            allow,
        )
        .await
        .unwrap_err();
        assert_eq!(refused.message, BUSY);
        assert!(shown.lock().unwrap().is_empty(), "no card was shown");
        assert_eq!(*asked_of.lock().unwrap(), [dev.id.clone()]);
        assert_eq!(stored(&team).len(), 2);

        // A task of its starts while the card waits: the Allow removes
        // nobody, and says the same thing.
        let started = std::sync::atomic::AtomicBool::new(false);
        let work = |_: &TeamAgent| {
            if started.load(std::sync::atomic::Ordering::SeqCst) {
                Err(BUSY.to_string())
            } else {
                Ok(None)
            }
        };
        let (shown, allow) =
            allowed_after(|| started.store(true, std::sync::atomic::Ordering::SeqCst));
        let refused = propose_delete_when(
            &roster(&team),
            &team,
            "chat:lead",
            remove("Dev"),
            &work,
            allow,
        )
        .await
        .unwrap_err();
        assert_eq!(refused.message, BUSY);
        assert_eq!(shown.lock().unwrap().len(), 1, "the card was shown");
        assert_eq!(stored(&team).len(), 2);

        // It finishes: the same proposal removes it.
        started.store(false, std::sync::atomic::Ordering::SeqCst);
        let (_, allow) = asker("allow", "you allowed it");
        let gone = propose_delete_when(
            &roster(&team),
            &team,
            "chat:lead",
            remove("Dev"),
            &work,
            allow,
        )
        .await
        .unwrap();
        assert_eq!(gone.id, dev.id);
        assert_eq!(stored(&team).len(), 1);
    }

    /// Unfinished tasks do not stop a removal, so its card says what
    /// becomes of them: a row of its own, and a sentence in the text.
    #[tokio::test]
    async fn a_removal_card_says_what_becomes_of_the_agents_unfinished_tasks() {
        let (_dir, team) = temp_team();
        let potato = register(&team, "Potato", None);
        register_under(&team, "Dev", &potato);
        const NOTE: &str = "2 unfinished tasks in 1 run still name it. None of them starts as an agent that is gone: reassign each one first, or they wait until you do.";
        const SUMMARY: &str = "2 unfinished tasks in 1 run still name it";
        let (shown, deny) = asker("deny", "you denied it");
        propose_delete_when(
            &roster(&team),
            &team,
            "chat:lead",
            remove("Dev"),
            &|_: &TeamAgent| {
                Ok(Some(Unfinished {
                    note: NOTE.into(),
                    summary: SUMMARY.into(),
                }))
            },
            deny,
        )
        .await
        .unwrap_err();
        let input = input_of(&shown);
        let rows = input["changeFacts"]["rows"].as_array().unwrap();
        assert_eq!(
            rows[rows.len() - 2..],
            [
                json!({ "label": "Unfinished tasks", "value": NOTE, "summary": SUMMARY }),
                json!({ "label": "Memory note", "value": "Kept in the vault." }),
            ]
        );
        let change = input["change"].as_str().unwrap();
        assert!(
            change.ends_with(&format!(
                "\n\n{NOTE}\n\nIts memory note in the vault is kept."
            )),
            "{change}"
        );

        // With none, the card is as it was.
        let (shown, deny) = asker("deny", "you denied it");
        propose_delete_when(
            &roster(&team),
            &team,
            "chat:lead",
            remove("Dev"),
            &|_: &TeamAgent| Ok(None),
            deny,
        )
        .await
        .unwrap_err();
        let input = input_of(&shown);
        assert!(!input.to_string().contains("Unfinished"), "{input}");
    }

    #[tokio::test]
    async fn a_removal_card_carries_who_goes_and_what_it_does_to_the_chart_as_rows() {
        let (_dir, team) = temp_team();
        let potato = register(&team, "Potato", None);
        let cto = crate::team::save(
            &team,
            TeamDraft {
                name: "Cto".into(),
                id: None,
                role: "Leads Octiq.\nReports to: nobody".into(),
                reports_to: Some(potato.id.clone()),
                ..redraft(&potato)
            },
        )
        .unwrap();
        register_under(&team, "Dev", &cto);
        register_under(&team, "Ops", &cto);
        crate::team::set_head(&team, Some(&potato.id)).unwrap();

        let (shown, deny) = asker("deny", "you denied it");
        propose_delete(&roster(&team), &team, "chat:lead", remove("cto"), deny)
            .await
            .unwrap_err();
        let input = input_of(&shown);
        assert_eq!(
            input["changeFacts"],
            json!({
                "lead": "Remove the agent Cto.",
                "rows": [
                    { "label": "Role", "value": "Leads Octiq.\nReports to: nobody" },
                    { "label": "Provider", "value": "Claude" },
                    { "label": "Model", "value": "sonnet" },
                    { "label": "Effort", "value": "high" },
                    { "label": "Access", "value": "auto" },
                    { "label": "Available in", "value": "every project" },
                    { "label": "Reports to", "value": "Potato" },
                    { "label": "Team", "value": "none" },
                    {
                        "label": "Direct reports",
                        "value": "Dev, Ops will report to Potato.",
                        "summary": "2 direct reports will report to Potato",
                    },
                    { "label": "Memory note", "value": "Kept in the vault." },
                ],
            })
        );
        let change = input["change"].as_str().unwrap();
        assert!(
            change.ends_with("\n\nIts 2 direct reports (Dev, Ops) will report to Potato.\n\nIts memory note in the vault is kept."),
            "{change}"
        );
        // The fields are rows the text shows too, and so are the reports,
        // whose count and manager the summary repeats. The memory note is a
        // sentence there, checked above.
        let mut fields = input.clone();
        fields["changeFacts"]["rows"]
            .as_array_mut()
            .unwrap()
            .truncate(9);
        rows_say_what_the_text_says(&fields);

        // The head, with one report: the seat that empties is a row, before
        // the report that moves up to the person.
        let (shown, deny) = asker("deny", "you denied it");
        propose_delete(&roster(&team), &team, "chat:lead", remove("Potato"), deny)
            .await
            .unwrap_err();
        let input = input_of(&shown);
        let rows = input["changeFacts"]["rows"].as_array().unwrap();
        assert_eq!(
            rows[8..],
            [
                json!({
                    "label": "Head",
                    "value": "The cross-project conversation will have no head until another is chosen.",
                }),
                json!({
                    "label": "Direct report",
                    "value": "Cto will report to the person.",
                    "summary": "1 direct report will report to the person",
                }),
                json!({ "label": "Memory note", "value": "Kept in the vault." }),
            ]
        );
        the_reports_row_says_what_the_text_says(input["change"].as_str().unwrap(), &rows[9]);
        let change = input["change"].as_str().unwrap();
        assert!(
            change.contains("\n\nIt is the head: the cross-project conversation will have no head until another is chosen.\n\nIts direct report (Cto) will report to the person."),
            "{change}"
        );

        // The front desk, which has no reports.
        let desk = crate::team::create_front_desk(&team, Default::default()).unwrap();
        let (shown, deny) = asker("deny", "you denied it");
        propose_delete(&roster(&team), &team, "chat:lead", remove(&desk.id), deny)
            .await
            .unwrap_err();
        let input = input_of(&shown);
        let rows = input["changeFacts"]["rows"].as_array().unwrap();
        assert_eq!(
            rows[8..],
            [
                json!({
                    "label": "Front desk",
                    "value": "Incoming requests will have no front desk until another is chosen.",
                }),
                json!({ "label": "Memory note", "value": "Kept in the vault." }),
            ]
        );
        assert!(input["change"].as_str().unwrap().contains(
            "\n\nIt is the front desk: incoming requests will have no front desk until another is chosen."
        ));
    }

    /// A roster of `lead`, `count` agents that report to it, and nothing
    /// else, with the lead reporting to `manager`.
    fn roster_of_reports(
        team: &Path,
        count: usize,
        manager: Option<&TeamAgent>,
    ) -> (Roster, TeamAgent) {
        let lead = match manager {
            Some(manager) => register_under(team, "Lead", manager),
            None => register(team, "Lead", None),
        };
        let mut roster = roster(team);
        for n in 0..count {
            roster.agents.push(TeamAgent {
                id: format!("agent_report{n:03}"),
                name: format!("Report {n:03}"),
                reports_to: Some(lead.id.clone()),
                ..lead.clone()
            });
        }
        (roster, lead)
    }

    /// The reports row of a removal card, as the page is sent it, and the
    /// card's text beside it.
    fn reports_row(roster: &Roster, gone: &TeamAgent) -> (Value, String) {
        let shown = roster.removal(&gone.id).unwrap();
        let facts = serde_json::to_value(delete_facts(roster, gone, &shown, None)).unwrap();
        let rows: Vec<&Value> = facts["rows"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["label"].as_str().unwrap().starts_with("Direct report"))
            .collect();
        assert_eq!(rows.len(), 1, "{facts}");
        (rows[0].clone(), describe_delete(roster, gone, &shown, None))
    }

    /// Compact decision cards review, H2: a folded removal card showed the
    /// end of the reports row's value, so neither how many agents move nor,
    /// behind a long name, that they move at all. The row now says both in a
    /// line of its own, counted from the roster, and still names every one of
    /// them in its value.
    #[test]
    fn a_removal_cards_reports_row_says_how_many_move_and_to_whom_in_one_line() {
        for (count, label, summary) in [
            (1, "Direct report", "1 direct report will report to Manager"),
            (
                2,
                "Direct reports",
                "2 direct reports will report to Manager",
            ),
            (
                300,
                "Direct reports",
                "300 direct reports will report to Manager",
            ),
        ] {
            let (_dir, team) = temp_team();
            let manager = register(&team, "Manager", None);
            let (roster, lead) = roster_of_reports(&team, count, Some(&manager));
            let (row, text) = reports_row(&roster, &lead);
            assert_eq!(row["label"], label);
            assert_eq!(row["summary"], summary);
            let names: Vec<String> = (0..count).map(|n| format!("Report {n:03}")).collect();
            assert_eq!(
                row["value"],
                format!("{} will report to Manager.", names.join(", ")),
                "every name is still in the value"
            );
            the_reports_row_says_what_the_text_says(&text, &row);
        }

        // Nobody above the one that goes: its reports move up to the person,
        // in the words the text uses for that.
        let (_dir, team) = temp_team();
        let (roster, lead) = roster_of_reports(&team, 300, None);
        let (row, text) = reports_row(&roster, &lead);
        assert_eq!(
            row["summary"],
            "300 direct reports will report to the person"
        );
        assert!(row["value"].as_str().unwrap().chars().count() > 3_000);
        assert!(text.contains(") will report to the person.\n\n"), "{text}");
        the_reports_row_says_what_the_text_says(&text, &row);
    }

    /// A summary is one line of at most `SUMMARY_MAX` characters. A name may
    /// be 60 when it is saved, which always fits, but the roster is a file:
    /// a manager's name too long for the line loses its end, and the count
    /// and "will report to" stay whole.
    #[test]
    fn a_reports_summary_shortens_a_long_managers_name_and_nothing_else() {
        let counts = "2 direct reports will report to ";
        let room = SUMMARY_MAX - counts.chars().count();
        let summary_under = |name: &str| {
            let (_dir, team) = temp_team();
            let manager = register(&team, "Manager", None);
            let (mut roster, lead) = roster_of_reports(&team, 2, Some(&manager));
            roster
                .agents
                .iter_mut()
                .find(|a| a.id == manager.id)
                .unwrap()
                .name = name.into();
            let (row, text) = reports_row(&roster, &lead);
            assert_eq!(
                row["value"],
                format!("Report 000, Report 001 will report to {name}."),
                "the value keeps the name whole"
            );
            assert!(
                text.contains(&format!(") will report to {name}.")),
                "{text}"
            );
            if !name.chars().any(char::is_control) {
                the_reports_row_says_what_the_text_says(&text, &row);
            }
            row["summary"].as_str().unwrap().to_string()
        };

        // As long as the line has room for: said whole.
        let fits = "M".repeat(room);
        let summary = summary_under(&fits);
        assert_eq!(summary, format!("{counts}{fits}"));
        assert_eq!(summary.chars().count(), SUMMARY_MAX);

        // One more, and far more: the name ends in an ellipsis at the limit.
        for long in [room + 1, 4_000] {
            let summary = summary_under(&"M".repeat(long));
            assert_eq!(
                summary,
                format!("{counts}{}…", "M".repeat(room - 1)),
                "{long}"
            );
            assert_eq!(summary.chars().count(), SUMMARY_MAX);
        }

        // Counted in characters, and cut between them.
        let summary = summary_under(&"管".repeat(400));
        assert_eq!(summary, format!("{counts}{}…", "管".repeat(room - 1)));
        assert_eq!(summary.chars().count(), SUMMARY_MAX);

        // No space is left hanging before the ellipsis.
        let spaced = format!("{} {}", "M".repeat(room - 2), "M".repeat(40));
        assert_eq!(
            summary_under(&spaced),
            format!("{counts}{}…", "M".repeat(room - 2))
        );

        // One line, whatever the name holds.
        assert_eq!(
            summary_under("Line one\nLine two"),
            format!("{counts}Line one Line two")
        );
        // Unicode's own line and paragraph separators end a line too, and
        // are not control characters: the page drops a summary that holds
        // one (`askDetail.rowSummary`), so they are spaces here as well.
        let separated = summary_under("Line\u{2028}one\u{2029}two\r\nthree\u{0085}four");
        assert_eq!(separated, format!("{counts}Line one two  three four"));
        assert!(!separated.chars().any(ends_a_line), "{separated:?}");
        assert!(ends_a_line('\u{2028}') && ends_a_line('\u{2029}') && ends_a_line('\n'));
        assert!(!ends_a_line(' ') && !ends_a_line('管'));

        // The count is never what gives way.
        let summary = reports_summary(usize::MAX, &"M".repeat(400));
        assert!(
            summary.starts_with(&format!("{} direct reports will report to M", usize::MAX)),
            "{summary}"
        );
        assert_eq!(summary.chars().count(), SUMMARY_MAX);
    }

    /// A removal that moves nobody has no reports row, and no other row of
    /// any card carries a summary: the host has nothing shorter to say than
    /// the value.
    #[test]
    fn a_card_with_no_reports_to_move_carries_no_summary() {
        let (_dir, team) = temp_team();
        let (mut roster, lead) = roster_of_reports(&team, 0, None);
        roster.head = Some(lead.id.clone());
        let shown = roster.removal(&lead.id).unwrap();
        assert!(shown.head && shown.reports.is_empty());
        let facts = serde_json::to_value(delete_facts(&roster, &lead, &shown, None)).unwrap();
        let rows = facts["rows"].as_array().unwrap();
        assert_eq!(
            rows.iter().map(|row| &row["label"]).collect::<Vec<_>>(),
            [
                "Role",
                "Provider",
                "Model",
                "Effort",
                "Access",
                "Available in",
                "Reports to",
                "Team",
                "Head",
                "Memory note"
            ]
        );
        for row in rows {
            assert_eq!(row.as_object().unwrap().len(), 2, "label and value: {row}");
        }
    }

    /// A row with no summary is sent as it was before rows could carry one,
    /// to the byte; a summary is one more key, after the value.
    #[test]
    fn a_row_without_a_summary_is_sent_as_it_always_was() {
        let sent = |row: &FactRow| serde_json::to_string(row).unwrap();
        assert_eq!(
            sent(&plain("Role", "Writes code.\nAccess: edits → danger")),
            r#"{"label":"Role","value":"Writes code.\nAccess: edits → danger"}"#
        );
        assert_eq!(
            sent(&FactRow::Move {
                label: "Access",
                before: "edits".into(),
                after: "auto".into(),
            }),
            r#"{"label":"Access","before":"edits","after":"auto"}"#
        );
        assert_eq!(
            sent(&text_row("Policy", "Never push.", "").unwrap()),
            r#"{"label":"Policy","before":"Never push.","after":""}"#
        );
        assert_eq!(
            sent(&summed(
                "Direct reports",
                "Dev, Ops will report to Potato.",
                reports_summary(2, "Potato"),
            )),
            r#"{"label":"Direct reports","value":"Dev, Ops will report to Potato.","summary":"2 direct reports will report to Potato"}"#
        );
        assert_eq!(
            serde_json::to_string(&ChangeFacts {
                lead: "Remove the agent Cto.".into(),
                rows: vec![plain("Memory note", "Kept in the vault.")],
            })
            .unwrap(),
            r#"{"lead":"Remove the agent Cto.","rows":[{"label":"Memory note","value":"Kept in the vault."}]}"#
        );
    }

    #[tokio::test]
    async fn a_policy_card_carries_the_policy_as_one_row() {
        let (_dir, team) = temp_team();
        let proposal = |text: &str| PolicyProposal {
            policy: text.into(),
            wait_seconds: Some(50),
        };

        // Set where there was none: a plain row.
        let (shown, allow) = asker("allow", "you allowed it");
        propose_policy(
            &roster(&team),
            &team,
            "chat:lead",
            proposal("Use worktrees.\nAccess: edits → danger"),
            allow,
        )
        .await
        .unwrap();
        let input = input_of(&shown);
        assert_eq!(
            input["changeFacts"],
            json!({
                "lead": "Set the shared agent policy that every agent's brief starts with.",
                "rows": [{ "label": "Policy", "value": "Use worktrees.\nAccess: edits → danger" }],
            })
        );
        rows_say_what_the_text_says(&input);
        assert_eq!(
            input["change"],
            "Set the shared agent policy that every agent's brief starts with.\n\nNew policy (37 characters):\nUse worktrees.\nAccess: edits → danger"
        );

        // Replaced: a move from the current policy, which the text leaves out.
        let (shown, allow) = asker("allow", "you allowed it");
        propose_policy(
            &roster(&team),
            &team,
            "chat:lead",
            proposal("Never push."),
            allow,
        )
        .await
        .unwrap();
        let input = input_of(&shown);
        assert_eq!(
            input["changeFacts"],
            json!({
                "lead": "Replace the shared agent policy that every agent's brief starts with.",
                "rows": [{
                    "label": "Policy",
                    "before": "Use worktrees.\nAccess: edits → danger",
                    "after": "Never push.",
                }],
            })
        );
        rows_say_what_the_text_says(&input);

        // Cleared: a move to nothing.
        let (shown, allow) = asker("allow", "you allowed it");
        propose_policy(&roster(&team), &team, "chat:lead", proposal(""), allow)
            .await
            .unwrap();
        let input = input_of(&shown);
        assert_eq!(
            input["changeFacts"],
            json!({
                "lead": "Clear the shared agent policy that every agent's brief starts with.",
                "rows": [{ "label": "Policy", "before": "Never push.", "after": "" }],
            })
        );
        assert_eq!(
            input["change"],
            "Clear the shared agent policy that every agent's brief starts with."
        );
    }

    /// A team made in Settings, global or in one project.
    fn settings_team(team: &Path, name: &str, project: Option<&str>) -> AgentTeam {
        crate::team::save_team(
            team,
            crate::team::AgentTeamDraft {
                id: None,
                name: name.into(),
                project_id: project.map(str::to_string),
            },
        )
        .unwrap()
    }

    /// Put `agent` on `on` (off every team, with `None`), as its Settings
    /// form would.
    fn put_on(team: &Path, agent: &TeamAgent, on: Option<&AgentTeam>) -> TeamAgent {
        crate::team::save(
            team,
            TeamDraft {
                team_id: Some(on.map(|t| t.id.clone()).unwrap_or_default()),
                ..redraft(agent)
            },
        )
        .unwrap()
    }

    fn agent_named(team: &Path, name: &str) -> TeamAgent {
        stored(team).into_iter().find(|a| a.name == name).unwrap()
    }

    /// Who is on the team called `name`, by name, as the store has it.
    fn members_of(team: &Path, name: &str) -> Vec<String> {
        let id = crate::team::teams(team)
            .unwrap()
            .into_iter()
            .find(|t| t.name == name)
            .map(|t| t.id);
        stored(team)
            .into_iter()
            .filter(|a| a.team_id.is_some() && a.team_id == id)
            .map(|a| a.name)
            .collect()
    }

    fn new_team(name: &str, members: &[&str]) -> TeamCreateProposal {
        TeamCreateProposal {
            name: name.into(),
            members: members.iter().map(|m| m.to_string()).collect(),
            wait_seconds: Some(50),
        }
    }

    fn team_edit(
        spec: &str,
        name: Option<&str>,
        add: &[&str],
        remove: &[&str],
    ) -> TeamUpdateProposal {
        TeamUpdateProposal {
            team: spec.into(),
            name: name.map(str::to_string),
            add_members: add.iter().map(|m| m.to_string()).collect(),
            remove_members: remove.iter().map(|m| m.to_string()).collect(),
            wait_seconds: Some(50),
        }
    }

    /// Feedback 9c1c51fa, item 4: an agent reads who is on which team from
    /// the listing alone. Each row names its team, and each team its members.
    #[test]
    fn the_listing_names_each_agents_team_and_each_teams_members() {
        let (_dir, team) = temp_team();
        let ada = register(&team, "Ada", None);
        let bo = register(&team, "Bo", Some("p1"));
        register(&team, "Cy", None);
        let star = settings_team(&team, "Starfall", None);
        settings_team(&team, "Empty", Some("p2"));
        put_on(&team, &ada, Some(&star));
        put_on(&team, &bo, Some(&star));

        let all = listing(&roster(&team), ListArgs::default()).unwrap();
        let row = |name: &str| {
            all["agents"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["name"] == name)
                .unwrap()
                .clone()
        };
        assert_eq!(row("Ada")["teamId"], star.id.as_str());
        assert_eq!(row("Ada")["team"], "Starfall");
        assert_eq!(row("Bo")["team"], "Starfall");
        // On no team: both keys are there, and null.
        assert_eq!(row("Cy")["teamId"], Value::Null);
        assert_eq!(row("Cy")["team"], Value::Null);
        assert!(row("Cy").as_object().unwrap().contains_key("team"));
        assert_eq!(
            all["teams"],
            json!([
                { "id": star.id, "name": "Starfall", "projectId": null, "members": ["Ada", "Bo"] },
                { "id": all["teams"][1]["id"], "name": "Empty", "projectId": "p2", "members": [] },
            ])
        );

        // A listing scoped to one project still names every member of a team.
        let octiq = listing(
            &roster(&team),
            ListArgs {
                project: Some("Octiq".into()),
            },
        )
        .unwrap();
        let names: Vec<_> = octiq["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["Ada", "Cy"]);
        assert_eq!(octiq["teams"][0]["members"], json!(["Ada", "Bo"]));

        // The answer to a saved change names the team the same way.
        let saved = saved_text(&roster(&team), Kind::Update, &agent_named(&team, "Ada"));
        assert_eq!(saved["agent"]["team"], "Starfall");
        assert_eq!(saved["agent"]["teamId"], star.id.as_str());
    }

    /// The person's live store, as it reads the day this was written: the
    /// team's members carry its id in the store, so the listing has always
    /// had them. What it lacked was the team's name on the row and the
    /// members on the team.
    #[test]
    fn a_stored_teamid_reaches_the_listing() {
        let (_dir, team) = temp_team();
        std::fs::write(
            &team,
            serde_json::to_vec(&json!({
                "agents": [
                    { "id": "agent_1", "name": "STAR LEAD", "role": "", "agent": "claude",
                      "model": "opus", "access": "auto", "teamId": "team_5bd7146f6079",
                      "createdAt": 1, "updatedAt": 2 },
                    { "id": "agent_2", "name": "OCTIQ BE", "role": "", "agent": "claude",
                      "model": "opus", "access": "auto", "projectId": "p2",
                      "createdAt": 1, "updatedAt": 2 },
                ],
                "teams": [
                    { "id": "team_5bd7146f6079", "name": "Starfall", "createdAt": 1, "updatedAt": 1 },
                ],
            }))
            .unwrap(),
        )
        .unwrap();
        let all = listing(&roster(&team), ListArgs::default()).unwrap();
        assert_eq!(all["agents"][0]["teamId"], "team_5bd7146f6079");
        assert_eq!(all["agents"][0]["team"], "Starfall");
        assert_eq!(all["agents"][1]["teamId"], Value::Null);
        assert_eq!(all["teams"][0]["members"], json!(["STAR LEAD"]));
    }

    #[tokio::test]
    async fn a_proposed_team_is_made_only_when_the_person_allows_it() {
        let (_dir, team) = temp_team();
        register(&team, "Potato", None);
        register(&team, "Nas", Some("p1"));
        let before = stored(&team);

        // Declined: no team, nobody moved.
        let (shown, deny) = asker("deny", "you denied it");
        let refused = propose_team_create(
            &roster(&team),
            &team,
            "chat:lead",
            new_team("Leads", &["Potato", "Nas"]),
            deny,
        )
        .await
        .unwrap_err();
        assert_eq!(
            refused.message,
            "The person declined this change, so nothing was changed."
        );
        assert_eq!(refused.outcome.reason_class, ReasonClass::ApprovalDenied);
        let request = shown.lock().unwrap().pop().unwrap();
        assert_eq!(
            request.tool_name.as_deref(),
            Some("mcp__octiq__team_create")
        );
        assert_eq!(request.chat_key.as_deref(), Some("chat:lead"));
        assert!(request.once, "a team card has no Always");
        assert_eq!(request.answer_within_secs, Some(50));
        assert!(crate::team::teams(&team).unwrap().is_empty());
        assert_eq!(stored(&team), before);

        // Nobody answered: the same.
        let (_, expire) = asker("deny", "nobody answered in time");
        let expired = propose_team_create(
            &roster(&team),
            &team,
            "chat:lead",
            new_team("Leads", &["Potato"]),
            expire,
        )
        .await
        .unwrap_err();
        assert_eq!(expired.outcome.reason_class, ReasonClass::ApprovalExpired);
        assert!(crate::team::teams(&team).unwrap().is_empty());
        assert_eq!(stored(&team), before);

        // Allowed: the team exists, global, with exactly those members, and
        // the answer says saved.
        let (shown, allow) = asker("allow", "you allowed it");
        let (saved, change) = propose_team_create(
            &roster(&team),
            &team,
            "chat:lead",
            new_team(" Leads ", &["Potato", "Nas", "potato"]),
            allow,
        )
        .await
        .unwrap();
        let input = input_of(&shown);
        assert_eq!(
            input["change"],
            "Create the team Leads.\n\nAvailable in: every project\nMembers: Potato, Nas\nMembership: Teammates may ask each other questions and request bounded work, and each request for work is approved separately."
        );
        assert_eq!(
            input["changeFacts"],
            json!({
                "lead": "Create the team Leads.",
                "rows": [
                    { "label": "Available in", "value": "every project" },
                    { "label": "Members", "value": "Potato, Nas", "summary": "2 members" },
                    { "label": "Membership", "value": "Teammates may ask each other questions and request bounded work, and each request for work is approved separately." },
                ],
            })
        );
        rows_say_what_the_text_says(&input);
        assert_eq!(saved.name, "Leads");
        assert_eq!(saved.project_id, None);
        assert_eq!(crate::team::teams(&team).unwrap(), vec![saved.clone()]);
        assert_eq!(members_of(&team, "Leads"), ["Potato", "Nas"]);
        assert_eq!(
            team_saved_text(&saved, &change),
            json!({
                "status": "saved",
                "text": "The person approved it: the team Leads is created.",
                "team": { "id": saved.id, "name": "Leads", "projectId": null, "members": ["Potato", "Nas"] },
            })
        );
        // Membership is all that moved: every other field is as it was.
        for (was, now) in before.iter().zip(stored(&team)) {
            assert_eq!(now.team_id.as_deref(), Some(saved.id.as_str()));
            assert!(
                now.updated_at > was.updated_at,
                "a new version of {}",
                now.name
            );
            assert_eq!(
                TeamAgent {
                    team_id: None,
                    updated_at: was.updated_at,
                    ..now
                },
                *was
            );
        }

        // A team may start empty.
        let (shown, allow) = asker("allow", "you allowed it");
        propose_team_create(
            &roster(&team),
            &team,
            "chat:lead",
            new_team("Later", &[]),
            allow,
        )
        .await
        .unwrap();
        assert_eq!(
            card_of(&shown),
            format!("Create the team Later.\n\nAvailable in: every project\nMembers: none\nMembership: {MEMBERSHIP_GRANTS}")
        );
        assert!(members_of(&team, "Later").is_empty());
    }

    #[tokio::test]
    async fn a_team_update_renames_adds_and_removes_and_touches_nothing_else() {
        let (_dir, team) = temp_team();
        let ada = register(&team, "Ada", None);
        let bo = register(&team, "Bo", None);
        let cy = register_under(&team, "Cy", &ada);
        register(&team, "Di", Some("p1"));
        let web = settings_team(&team, "Web", None);
        put_on(&team, &ada, Some(&web));
        put_on(&team, &bo, Some(&web));
        let before = stored(&team);

        // Declined: nothing moved.
        let (_, deny) = asker("deny", "you denied it");
        propose_team_update(
            &roster(&team),
            &team,
            "chat:lead",
            team_edit("Web", Some("Site"), &["Cy"], &["Bo"]),
            deny,
        )
        .await
        .unwrap_err();
        assert_eq!(stored(&team), before);
        assert_eq!(crate::team::teams(&team).unwrap(), vec![web.clone()]);

        let (shown, allow) = asker("allow", "you allowed it");
        let (saved, change) = propose_team_update(
            &roster(&team),
            &team,
            "chat:lead",
            team_edit(&web.id, Some("Site"), &["Cy", "Di"], &["Bo"]),
            allow,
        )
        .await
        .unwrap();
        let request = shown.lock().unwrap().last().unwrap().clone();
        assert_eq!(
            request.tool_name.as_deref(),
            Some("mcp__octiq__team_update")
        );
        assert!(request.once);
        let input = input_of(&shown);
        assert_eq!(
            input["change"],
            format!("Change the team Web.\n\nName: Web → Site\nAdded: Cy, Di\nRemoved: Bo\nMembers: Ada, Bo → Ada, Cy, Di\nMembership: {MEMBERSHIP_GRANTS}")
        );
        assert_eq!(
            input["changeFacts"],
            json!({
                "lead": "Change the team Web.",
                "rows": [
                    { "label": "Name", "before": "Web", "after": "Site" },
                    { "label": "Added", "value": "Cy, Di" },
                    { "label": "Removed", "value": "Bo" },
                    { "label": "Members", "before": "Ada, Bo", "after": "Ada, Cy, Di" },
                    { "label": "Membership", "value": MEMBERSHIP_GRANTS },
                ],
            })
        );
        rows_say_what_the_text_says(&input);
        assert_eq!(saved.id, web.id);
        assert_eq!(saved.name, "Site");
        assert_eq!(saved.project_id, None);
        assert!(saved.updated_at > web.updated_at);
        assert_eq!(members_of(&team, "Site"), ["Ada", "Cy", "Di"]);
        assert_eq!(
            team_saved_text(&saved, &change)["text"],
            "The person approved it: the team Site is updated."
        );
        assert_eq!(
            team_saved_text(&saved, &change)["team"]["members"],
            json!(["Ada", "Cy", "Di"])
        );
        // Nobody's manager, access, provider, model or project moved, and an
        // agent the change did not name is the version it was.
        for (was, now) in before.iter().zip(stored(&team)) {
            let named = ["Bo", "Cy", "Di"].contains(&now.name.as_str());
            assert_eq!(now.updated_at > was.updated_at, named, "{}", now.name);
            assert_eq!(
                TeamAgent {
                    team_id: was.team_id.clone(),
                    updated_at: was.updated_at,
                    ..now
                },
                *was
            );
        }
        assert_eq!(agent_named(&team, "Cy").reports_to, cy.reports_to);
        assert_eq!(agent_named(&team, "Bo").team_id, None);

        // Members only: no Name row. The last member leaving empties it.
        let (shown, allow) = asker("allow", "you allowed it");
        propose_team_update(
            &roster(&team),
            &team,
            "chat:lead",
            team_edit("site", None, &[], &["Ada", "Cy", "Di"]),
            allow,
        )
        .await
        .unwrap();
        let input = input_of(&shown);
        assert_eq!(
            input["change"],
            format!("Change the team Site.\n\nRemoved: Ada, Cy, Di\nMembers: Ada, Cy, Di → none\nMembership: {MEMBERSHIP_GRANTS}")
        );
        rows_say_what_the_text_says(&input);
        assert!(members_of(&team, "Site").is_empty());

        // A rename only: one row.
        let (shown, allow) = asker("allow", "you allowed it");
        propose_team_update(
            &roster(&team),
            &team,
            "chat:lead",
            team_edit("Site", Some("Web"), &[], &[]),
            allow,
        )
        .await
        .unwrap();
        assert_eq!(
            card_of(&shown),
            format!("Change the team Site.\n\nName: Site → Web\nMembership: {MEMBERSHIP_GRANTS}")
        );
    }

    /// One team per agent: an agent added while it is on another team leaves
    /// that one, and the card says which.
    #[tokio::test]
    async fn an_agent_on_another_team_leaves_it_and_the_card_says_which() {
        let (_dir, team) = temp_team();
        let ada = register(&team, "Ada", None);
        let bo = register(&team, "Bo", None);
        register(&team, "Cy", None);
        let web = settings_team(&team, "Web", None);
        let ops = settings_team(&team, "Ops", None);
        put_on(&team, &ada, Some(&web));
        put_on(&team, &bo, Some(&ops));

        let (shown, allow) = asker("allow", "you allowed it");
        propose_team_update(
            &roster(&team),
            &team,
            "chat:lead",
            team_edit("Web", None, &["Bo", "Cy"], &[]),
            allow,
        )
        .await
        .unwrap();
        let input = input_of(&shown);
        assert_eq!(
            input["change"],
            format!("Change the team Web.\n\nAdded: Bo, Cy\nMembers: Ada → Ada, Bo, Cy\nOther teams: Bo leaves Ops.\nMembership: {MEMBERSHIP_GRANTS}")
        );
        assert_eq!(
            input["changeFacts"]["rows"][2],
            json!({
                "label": "Other teams",
                "value": "Bo leaves Ops.",
                "summary": "1 agent leaves another team",
            })
        );
        rows_say_what_the_text_says(&input);
        assert_eq!(members_of(&team, "Web"), ["Ada", "Bo", "Cy"]);
        assert!(members_of(&team, "Ops").is_empty());

        // A new team taking members from two others names both.
        let (shown, allow) = asker("allow", "you allowed it");
        put_on(&team, &agent_named(&team, "Cy"), Some(&ops));
        propose_team_create(
            &roster(&team),
            &team,
            "chat:lead",
            new_team("Leads", &["Ada", "Cy"]),
            allow,
        )
        .await
        .unwrap();
        let input = input_of(&shown);
        assert_eq!(
            input["change"],
            format!("Create the team Leads.\n\nAvailable in: every project\nMembers: Ada, Cy\nOther teams: Ada leaves Web. Cy leaves Ops.\nMembership: {MEMBERSHIP_GRANTS}")
        );
        // What a folded card keeps of the two rows that list names: how
        // many start on the team, and how many of them leave another for it.
        assert_eq!(
            input["changeFacts"]["rows"].as_array().unwrap()[1..3],
            [
                json!({ "label": "Members", "value": "Ada, Cy", "summary": "2 members" }),
                json!({
                    "label": "Other teams",
                    "value": "Ada leaves Web. Cy leaves Ops.",
                    "summary": "2 agents leave another team",
                }),
            ]
        );
        rows_say_what_the_text_says(&input);
        assert_eq!(members_of(&team, "Leads"), ["Ada", "Cy"]);
        assert_eq!(members_of(&team, "Web"), ["Bo"]);
        assert!(members_of(&team, "Ops").is_empty());
    }

    /// A proposal the rules refuse never reaches the person, and changes
    /// nothing.
    #[tokio::test]
    async fn a_team_proposal_the_rules_refuse_puts_up_no_card() {
        let (_dir, team) = temp_team();
        let ada = register(&team, "Ada", None);
        register(&team, "Bo", None);
        register(&team, "Di", Some("p1"));
        register(&team, "Twin", Some("p1"));
        register(&team, "twin", Some("p2"));
        let web = settings_team(&team, "Web", None);
        let octiq = settings_team(&team, "Octiq only", Some("p2"));
        put_on(&team, &ada, Some(&web));
        let before = (stored(&team), crate::team::teams(&team).unwrap());

        let created = [
            (new_team("", &[]), "Give the team a name."),
            (new_team("   ", &["Ada"]), "Give the team a name."),
            (
                new_team(&"x".repeat(61), &[]),
                "The team's name is longer than 60 characters.",
            ),
            (new_team("web", &[]), "Another team is already called web."),
            (
                new_team("Octiq Only", &[]),
                "Another team is already called Octiq Only.",
            ),
            (
                new_team("Leads", &["Ada", "Nobody"]),
                "No agent is called Nobody. Call agent_list for the ids.",
            ),
            (
                new_team("Leads", &["Twin"]),
                "More than one agent is called Twin. Pass its id from agent_list.",
            ),
        ];
        for (proposal, said) in created {
            let (shown, allow) = asker("allow", "you allowed it");
            let refused = propose_team_create(&roster(&team), &team, "chat:lead", proposal, allow)
                .await
                .unwrap_err();
            assert_eq!(refused.message, said);
            assert_eq!(refused.outcome.reason_class, ReasonClass::Validation);
            assert!(shown.lock().unwrap().is_empty(), "{said}");
        }

        let updated = [
            (
                team_edit("", Some("X"), &[], &[]),
                "Name the team to change, by id or name from agent_list.",
            ),
            (
                team_edit("Nope", Some("X"), &[], &[]),
                "No team is called Nope. Call agent_list for the ids.",
            ),
            (
                team_edit("Web", None, &[], &[]),
                "Say what to change about Web: a new name, or members to add or remove.",
            ),
            (
                team_edit("Web", Some("Web"), &[], &[]),
                "Say what to change about Web: a new name, or members to add or remove.",
            ),
            (
                team_edit("Web", Some(" "), &["Bo"], &[]),
                "Give the team a name.",
            ),
            (
                team_edit("Web", Some("octiq only"), &[], &[]),
                "Another team is already called octiq only.",
            ),
            (
                team_edit("Web", None, &["Nobody"], &[]),
                "No agent is called Nobody. Call agent_list for the ids.",
            ),
            (
                team_edit("Web", None, &[], &["Nobody"]),
                "No agent is called Nobody. Call agent_list for the ids.",
            ),
            (
                team_edit("Web", None, &["Ada"], &[]),
                "Ada is already on Web.",
            ),
            (team_edit("Web", None, &[], &["Bo"]), "Bo is not on Web."),
            (
                team_edit("Web", None, &["Bo"], &["Bo"]),
                "Bo cannot be both added to and removed from Web.",
            ),
            // A project's team holds that project's agents and global ones.
            (
                team_edit(&octiq.id, None, &["Di"], &[]),
                "Di cannot be on Octiq only: that team belongs to another project.",
            ),
        ];
        for (proposal, said) in updated {
            let (shown, allow) = asker("allow", "you allowed it");
            let refused = propose_team_update(&roster(&team), &team, "chat:lead", proposal, allow)
                .await
                .unwrap_err();
            assert_eq!(refused.message, said);
            assert_eq!(refused.outcome.reason_class, ReasonClass::Validation);
            assert!(shown.lock().unwrap().is_empty(), "{said}");
        }
        assert_eq!((stored(&team), crate::team::teams(&team).unwrap()), before);

        // The project a team belongs to is not this tool's to name.
        let scoped: Result<TeamUpdateProposal, _> =
            serde_json::from_value(json!({ "team": "Web", "project": "Octiq" }));
        assert!(scoped.is_err());
        let scoped: Result<TeamCreateProposal, _> =
            serde_json::from_value(json!({ "name": "Leads", "project": "Octiq" }));
        assert!(scoped.is_err());
        let other: Result<TeamUpdateProposal, _> =
            serde_json::from_value(json!({ "team": "Web", "reportsTo": "Ada" }));
        assert!(other.is_err());
        // A global agent may join a project's team; its project stays its own.
        let (_, allow) = asker("allow", "you allowed it");
        propose_team_update(
            &roster(&team),
            &team,
            "chat:lead",
            team_edit(&octiq.id, None, &["Bo"], &[]),
            allow,
        )
        .await
        .unwrap();
        assert_eq!(agent_named(&team, "Bo").project_id, None);
        assert_eq!(
            crate::team::teams(&team).unwrap()[1].project_id.as_deref(),
            Some("p2")
        );
    }

    /// The person's Allow is held to everything the card said: the team's
    /// name, its members, and the team each agent it adds would leave. Each
    /// of these changes the roster while the card waits; each is refused and
    /// saves nothing.
    #[tokio::test]
    async fn a_team_change_is_refused_when_the_roster_is_no_longer_what_its_card_said() {
        async fn refused(
            team: &Path,
            proposal: TeamUpdateProposal,
            meanwhile: impl FnOnce(),
            what: &str,
        ) {
            let (shown, allow) = allowed_after(meanwhile);
            let stale = propose_team_update(&roster(team), team, "chat:lead", proposal, allow)
                .await
                .unwrap_err();
            assert_eq!(
                stale.message,
                format!("The team Web or its members changed while this waited for approval, so nothing was saved: {what}. Read agent_list again and propose it again."),
            );
            assert_eq!(shown.lock().unwrap().len(), 1);
        }
        let add_cy = || team_edit("Web", None, &["Cy"], &[]);

        let (_dir, team) = temp_team();
        let ada = register(&team, "Ada", None);
        let bo = register(&team, "Bo", None);
        let cy = register(&team, "Cy", None);
        let web = settings_team(&team, "Web", None);
        let ops = settings_team(&team, "Ops", None);
        put_on(&team, &ada, Some(&web));

        // Somebody joined in Settings during the wait: never on the card.
        refused(
            &team,
            add_cy(),
            || {
                put_on(&team, &bo, Some(&web));
            },
            "its members are not the ones the card listed",
        )
        .await;
        assert_eq!(members_of(&team, "Web"), ["Ada", "Bo"]);

        // A member left during the wait.
        refused(
            &team,
            add_cy(),
            || {
                put_on(&team, &agent_named(&team, "Bo"), None);
            },
            "its members are not the ones the card listed",
        )
        .await;
        assert_eq!(members_of(&team, "Web"), ["Ada"]);

        // The agent it adds joined another team during the wait: the card
        // never said it would leave one.
        refused(
            &team,
            add_cy(),
            || {
                put_on(&team, &cy, Some(&ops));
            },
            "an agent the card names has changed",
        )
        .await;
        assert_eq!(members_of(&team, "Ops"), ["Cy"]);
        assert_eq!(members_of(&team, "Web"), ["Ada"]);

        // The agent it adds was renamed during the wait.
        refused(
            &team,
            add_cy(),
            || {
                let cy = agent_named(&team, "Cy");
                crate::team::save(
                    &team,
                    TeamDraft {
                        name: "Cyrus".into(),
                        ..redraft(&cy)
                    },
                )
                .unwrap();
            },
            "an agent the card names has changed",
        )
        .await;
        assert_eq!(members_of(&team, "Ops"), ["Cyrus"]);

        // The agent it adds was added by someone else during the wait.
        refused(
            &team,
            team_edit("Web", None, &["Cyrus"], &[]),
            || {
                put_on(&team, &agent_named(&team, "Cyrus"), Some(&web));
            },
            "Cyrus is already on Web",
        )
        .await;

        // The agent it adds was removed during the wait.
        refused(
            &team,
            team_edit("Web", None, &["Bo"], &[]),
            || {
                crate::team::delete(&team, &bo.id).unwrap();
            },
            "An agent this names no longer exists",
        )
        .await;

        // The team was renamed in Settings during the wait.
        let rename = |name: &str| {
            crate::team::save_team(
                &team,
                crate::team::AgentTeamDraft {
                    id: Some(web.id.clone()),
                    name: name.into(),
                    project_id: None,
                },
            )
            .unwrap();
        };
        refused(
            &team,
            team_edit("Web", None, &[], &["Ada"]),
            || rename("Site"),
            "the team is not the one the card showed",
        )
        .await;
        assert_eq!(members_of(&team, "Site"), ["Ada", "Cyrus"]);
        rename("Web");

        // The name it asks for was taken during the wait.
        refused(
            &team,
            team_edit("Web", Some("Leads"), &[], &[]),
            || {
                settings_team(&team, "Leads", None);
            },
            "Another team is already called Leads",
        )
        .await;

        // The team was removed during the wait.
        refused(
            &team,
            team_edit("Web", Some("Site"), &[], &[]),
            || {
                crate::team::delete_team(&team, &web.id).unwrap();
            },
            "That team no longer exists",
        )
        .await;

        // A new team: a member that joined another team during the wait,
        // and a name taken during the wait.
        let (_, allow) = allowed_after(|| {
            put_on(&team, &agent_named(&team, "Ada"), Some(&ops));
        });
        let stale = propose_team_create(
            &roster(&team),
            &team,
            "chat:lead",
            new_team("Core", &["Ada"]),
            allow,
        )
        .await
        .unwrap_err();
        assert_eq!(
            stale.message,
            "The teams or the agents Core names changed while this waited for approval, so nothing was saved: an agent the card names has changed. Read agent_list again and propose it again."
        );
        let (_, allow) = allowed_after(|| {
            settings_team(&team, "Core", None);
        });
        let stale = propose_team_create(
            &roster(&team),
            &team,
            "chat:lead",
            new_team("Core", &["Ada"]),
            allow,
        )
        .await
        .unwrap_err();
        assert_eq!(
            stale.message,
            "The teams or the agents Core names changed while this waited for approval, so nothing was saved: Another team is already called Core. Read agent_list again and propose it again."
        );
        assert!(members_of(&team, "Core").is_empty());
        assert_eq!(members_of(&team, "Ops"), ["Ada"]);
    }

    /// An agent that joins or leaves a team is a new version of itself, so a
    /// card made against the version before is refused, as after any edit.
    #[tokio::test]
    async fn a_team_change_makes_a_waiting_agent_card_stale() {
        let (_dir, team) = temp_team();
        register(&team, "Ada", None);
        settings_team(&team, "Web", None);
        let (_, allow) = allowed_after(|| {
            let (_, allow) = asker("allow", "you allowed it");
            let now = roster(&team);
            let joined = propose_team_update(
                &now,
                &team,
                "chat:other",
                team_edit("Web", None, &["Ada"], &[]),
                allow,
            );
            // Its asker answers at once, so there is nothing to wait for.
            futures_util::FutureExt::now_or_never(joined)
                .expect("answered at once")
                .unwrap();
        });
        let stale = propose(
            &roster(&team),
            &team,
            "chat:lead",
            Kind::Update,
            Proposal {
                agent: Some("Ada".into()),
                role: Some("Leads.".into()),
                wait_seconds: Some(50),
                ..Default::default()
            },
            allow,
        )
        .await
        .unwrap_err();
        assert!(
            stale
                .message
                .starts_with("Ada was changed while this waited for approval"),
            "{}",
            stale.message
        );
        assert_eq!(agent_named(&team, "Ada").role, "Writes code.");
        assert_eq!(members_of(&team, "Web"), ["Ada"]);
    }
}

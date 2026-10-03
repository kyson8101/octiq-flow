//! What an agent may do to the person's registered agents through its MCP:
//! `agent_list`, `agent_register` and `agent_update`.
//!
//! Reading the roster is free. A change is only ever PROPOSED by the agent.
//! The host builds the whole draft itself, runs it through every rule the
//! Settings → Agents form is held to (`team::check`), and then asks the person
//! on the same permission card a provider's own tool call raises
//! (`permission::ask`). Only their Allow writes it, through
//! `team::save_unchanged`, so what is saved is exactly the change they were
//! shown, made to the version of the agent they were shown it against.
//!
//! The card is one-off: "Always" would wave through the next agent this chat
//! invents, which is not a decision anybody can make in advance.
use std::future::Future;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent_chat::{Access, ChatAgent};
use crate::permission::Answer;
use crate::team::{AgentTeam, TeamAgent, TeamDraft};
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
    /// How long the person's card may stay up, in seconds. The MCP sets it
    /// from what its provider will wait for a tool call; the host clamps it.
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
}

impl Roster {
    pub fn read(team: &Path, projects: Vec<Workspace>) -> Result<Self, String> {
        Ok(Self {
            agents: crate::team::list(team, None, true)?,
            teams: crate::team::teams(team)?,
            projects,
            head: crate::team::head(team)?.map(|agent| agent.id),
            front_desk: crate::team::front_desk(team)?.map(|agent| agent.id),
        })
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
/// picture or the memory note's path.
fn public(agent: &TeamAgent) -> Value {
    json!({
        "id": agent.id,
        "name": agent.name,
        "role": agent.role,
        "provider": agent.agent,
        "model": agent.model,
        "effort": agent.effort,
        "access": agent.access,
        "projectId": agent.project_id,
        "reportsTo": agent.reports_to,
        "teamId": agent.team_id,
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
        .map(public)
        .collect();
    Ok(json!({
        "agents": agents,
        "teams": roster.teams.iter().map(|t| json!({
            "id": t.id, "name": t.name, "projectId": t.project_id,
        })).collect::<Vec<_>>(),
        "projects": roster.projects.iter().map(|p| json!({
            "id": p.id, "name": p.name,
        })).collect::<Vec<_>>(),
        "head": roster.head,
        "frontDesk": roster.front_desk,
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
                .ok_or("Choose the agent's provider: claude or codex.")?;
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
                && p.team.is_none();
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

/// The change in words, for the card: every field of a new agent, and only
/// what moves on an existing one.
pub fn describe(roster: &Roster, change: &Draft, after: &TeamAgent) -> String {
    match &change.before {
        None => {
            let mut text = format!("Register a new agent, {}.\n", after.name);
            for (label, value) in fields(roster, after) {
                text.push_str(&format!("\n{label}: {value}"));
            }
            text
        }
        Some(before) => {
            let mut text = format!("Change the agent {}.\n", before.name);
            for ((label, was), (_, now)) in fields(roster, before)
                .into_iter()
                .zip(fields(roster, after))
            {
                if was != now {
                    text.push_str(&format!("\n{label}: {was} → {now}"));
                }
            }
            text
        }
    }
}

/// How the person answered, as the agent reads it. `Ok` only on an Allow.
fn approved(answer: &Answer, wait: Duration) -> Result<(), String> {
    match (answer.decision, answer.reason.as_str()) {
        ("allow", _) => Ok(()),
        ("deny", "nobody answered in time") => Err(format!(
            "The person did not answer within {} seconds, so nothing was changed. Tell them what you proposed and call again when they are ready to approve it.",
            wait.as_secs()
        )),
        ("deny", _) => Err("The person declined this change, so nothing was changed.".into()),
        _ => Err("Nobody has OctiqFlow open to approve this, so nothing was changed. A change to the registered agents needs the person's approval on its card.".into()),
    }
}

/// How long the card stays up for this call.
pub fn wait_for(requested: Option<u64>) -> Duration {
    requested
        .map(Duration::from_secs)
        .unwrap_or(crate::permission::ANSWER_TIMEOUT)
        .clamp(WAIT_MIN, crate::permission::ANSWER_TIMEOUT)
}

/// What a saved change answers with: the agent as `agent_list` shows it.
pub fn saved_text(kind: Kind, agent: &TeamAgent) -> Value {
    let said = match kind {
        Kind::Register => format!("The person approved it: {} is registered.", agent.name),
        Kind::Update => format!("The person approved it: {} is updated.", agent.name),
    };
    json!({ "status": "saved", "text": said, "agent": public(agent) })
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
) -> Result<TeamAgent, String>
where
    A: FnOnce(crate::permission::Request) -> F,
    F: Future<Output = Answer>,
{
    let change = draft(roster, kind, &proposal)?;
    // The Settings form's rules, against the agents as they are now. A
    // proposal that would be refused is never put to the person.
    let after = crate::team::check(team, change.draft.clone())?;
    let wait = wait_for(proposal.wait_seconds);
    let request = crate::permission::Request {
        chat_key: Some(chat_key.to_string()),
        tool_name: Some(kind.tool().into()),
        tool_input: Some(json!({ "change": describe(roster, &change, &after) })),
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A team file of the test's own, removed when the guard drops.
    struct Temp(std::path::PathBuf);

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_team() -> (Temp, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("octiq-team-tools-{}", uuid::Uuid::new_v4()));
        let path = dir.join("team.json");
        (Temp(dir), path)
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
        assert_eq!(
            refused.unwrap_err(),
            "The person declined this change, so nothing was changed."
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
                "Choose Claude or Codex for a registered agent.",
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
            assert_eq!(error, expected);
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
        assert!(error.contains("was changed while this waited"), "{error}");
        assert_eq!(stored(&team)[0].role, "Edited in Settings.");
    }

    #[test]
    fn every_unanswered_card_is_told_apart() {
        let wait = Duration::from_secs(50);
        assert!(approved(&answer("allow", "you allowed it"), wait).is_ok());
        assert!(approved(&answer("deny", "nobody answered in time"), wait)
            .unwrap_err()
            .contains("within 50 seconds"));
        assert!(
            approved(&answer("abstain", "nobody is watching OctiqFlow"), wait)
                .unwrap_err()
                .starts_with("Nobody has OctiqFlow open")
        );
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
    }
}

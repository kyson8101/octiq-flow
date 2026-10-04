//! What an agent may do to the person's registered agents through its MCP:
//! `agent_list`, `agent_register`, `agent_update` and `agent_policy_update`.
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
use crate::outcome::{ReasonClass, Refusal};
use crate::permission::Answer;
use crate::team::{AgentPolicy, AgentTeam, TeamAgent, TeamDraft};
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

/// `agent_policy_update`'s arguments: the whole new policy, `""` to clear it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyProposal {
    pub policy: String,
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
        "persistentPrompt": agent.persistent_prompt,
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

/// The change in words, for the card: every field of a new agent, and only
/// what moves on an existing one. The persistent prompt is never listed with
/// the other fields, and appears only when this change sets or clears it:
/// the person approves exactly the text that would be saved.
pub fn describe(roster: &Roster, change: &Draft, after: &TeamAgent) -> String {
    let mut text = match &change.before {
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
    };
    let was = change
        .before
        .as_ref()
        .map_or("", |before| before.persistent_prompt.as_str());
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

/// The policy change in words, for the card: the whole text it would become.
pub fn describe_policy(before: &AgentPolicy, after: &str) -> String {
    if after.is_empty() {
        return "Clear the shared agent policy that every agent's brief starts with.".into();
    }
    format!(
        "{} the shared agent policy that every agent's brief starts with.\n\nNew policy ({} characters):\n{after}",
        if before.text.is_empty() { "Set" } else { "Replace" },
        after.chars().count()
    )
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
    .map_err(Refusal::from)
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
        tool_input: Some(json!({ "change": describe_policy(&roster.policy, &text) })),
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
}

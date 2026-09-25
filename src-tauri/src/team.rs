//! Agents mode: the person's registered agents.
//!
//! An agent here is a named, role-bearing preset — provider, model, effort and
//! access — that a task can be handed to. It lives globally (every project sees
//! it) or in one project. Handing a task to one makes that chat its LEAD: the
//! lead does the work itself, or opens an ordinary orchestration run and
//! assigns tasks to other registered agents by id. The host, not the lead,
//! turns an assignee into worker settings, so a lead cannot misquote a
//! teammate's model.
//!
//! One level only: assigned agents execute; they never delegate again.
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::agent_chat::{Access, ChatAgent};

/// The line that separates the person's task from the brief the lead is given.
/// The client draws only what comes before it (lib/agentsMode.ts).
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
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    agents: Vec<TeamAgent>,
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
    let mut agents = read(path)?.agents;
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
                created_at: now,
                updated_at: now,
            };
            stored.agents.push(agent.clone());
            agent
        }
    };
    write(path, &stored)?;
    Ok(saved)
}

pub fn delete(path: &Path, id: &str) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    let before = stored.agents.len();
    stored.agents.retain(|a| a.id != id);
    if stored.agents.len() == before {
        return Err("That agent no longer exists.".into());
    }
    write(path, &stored)
}

/// The registered agent a lead named as a task's assignee, by id or by exact
/// (case-insensitive) name, among those the run's project can see.
pub fn resolve(path: &Path, project_id: &str, who: &str) -> Result<TeamAgent, String> {
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
    if !found.can_work() {
        return Err(format!(
            "{} runs on a lead-only model and cannot take a task. Assign someone else, or do it yourself in this chat.",
            found.name
        ));
    }
    Ok(found)
}

fn describe(agent: &TeamAgent) -> String {
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
    format!(
        "- id `{}` · {} — {} · {provider} {}{effort}{lead_only}",
        agent.id, agent.name, role, agent.model
    )
}

/// The first message of a task: the person's words, then the lead's brief.
pub fn brief(path: &Path, project_id: &str, lead_id: &str, task: &str) -> Result<String, String> {
    let task = task.trim();
    if task.is_empty() {
        return Err("Describe the task first.".into());
    }
    let team = list(path, Some(project_id), false)?;
    let lead = team
        .iter()
        .find(|a| a.id == lead_id)
        .ok_or("The chosen agent no longer exists. Pick another one.")?;
    let roster = team.iter().map(describe).collect::<Vec<_>>().join("\n");
    let role = if lead.role.is_empty() {
        String::new()
    } else {
        format!(" Your role: {}.", lead.role.replace('\n', " "))
    };
    Ok(format!(
        "{task}{BRIEF_MARK}Lead: {name}\n\n\
You are {name}, a registered agent in this OctiqFlow project.{role} The person handed you the task above. You lead it. First decide which of these fits best, and say which one you chose and why in one or two sentences:\n\n\
1. Do it yourself: it fits your role and is one coherent piece of work. Do it directly in this chat. Do not create an orchestration run.\n\
2. Pass it on: another agent below fits it clearly better. Delegate the whole task to them as one task.\n\
3. Split it: it has separable parts. Split it into tasks and give each to the best-suited agent. You may keep a part for yourself and do it in this chat, but never write in a checkout a worker has.\n\n\
To pass on or split, call orchestration_run_create once with objective = the task, workspaceMode \"auto\" and workerDefaults {{\"access\": \"auto\"}}, then follow the masterBrief it returns. Create each task with orchestration_task_create and set `assignee` to the agent's id. The host applies that agent's provider, model, effort and access, so do not also pass `worker`. Only agents listed below can be assignees, and agents marked lead only cannot take tasks. Assigned agents only do their own task; they never delegate again. If one reports that its task should be split, you split it. After dispatch, end your turn. The host tells you when work reports. When every task is complete, check the results and tell the person the outcome.\n\n\
Registered agents:\n{roster}",
        name = lead.name,
    ))
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
    fn resolve_by_id_or_name_and_refuses_lead_only_models() {
        let path = temp();
        let ada = save(&path, draft("Ada", None)).unwrap();
        let mut lead = draft("Boss", None);
        lead.model = "fable".into();
        save(&path, lead).unwrap();
        assert_eq!(resolve(&path, "p1", &ada.id).unwrap().name, "Ada");
        assert_eq!(resolve(&path, "p1", "ADA").unwrap().id, ada.id);
        assert!(resolve(&path, "p1", "Boss")
            .unwrap_err()
            .contains("lead-only"));
        assert!(resolve(&path, "p1", "nobody").is_err());
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
    fn brief_puts_the_task_first_and_lists_the_team() {
        let path = temp();
        let ada = save(&path, draft("Ada", None)).unwrap();
        save(&path, draft("Bo", Some("p2"))).unwrap();
        let text = brief(&path, "p1", &ada.id, "  Fix the login bug  ").unwrap();
        let (task, rest) = text.split_once(BRIEF_MARK).unwrap();
        assert_eq!(task, "Fix the login bug");
        assert!(rest.starts_with("Lead: Ada\n"));
        assert!(rest.contains(&format!("id `{}`", ada.id)));
        assert!(!rest.contains("Bo"));
    }
}

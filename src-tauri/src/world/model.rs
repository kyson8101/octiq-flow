//! Product state and invariants. No provider, filesystem, or database effects.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use uuid::Uuid;

pub fn id() -> String {
    Uuid::new_v4().to_string()
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub type Result<T> = std::result::Result<T, String>;
pub fn default_runner_image() -> String {
    "node:22-alpine".into()
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct World {
    pub revision: u64,
    pub orgs: Vec<Org>,
    pub projects: Vec<Project>,
    pub professions: Vec<Profession>,
    pub agents: Vec<Agent>,
    pub workflows: Vec<Workflow>,
    pub tasks: Vec<Task>,
    pub meetings: Vec<Meeting>,
    pub recruitment_drafts: Vec<RecruitmentDraft>,
    pub secretary_drafts: Vec<super::secretary::SecretaryDraft>,
    pub role_requests: Vec<super::role_chat::RoleRequest>,
    pub memories: Vec<Memory>,
    pub runs: Vec<Run>,
    pub usage: Vec<Usage>,
    pub xp: Vec<Xp>,
    #[serde(default)]
    pub receipts: Vec<Receipt>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub id: String,
    pub result: Value,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Org {
    pub id: String,
    pub name: String,
    pub description: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub context: String,
    pub workspace_path: String,
    #[serde(default = "default_runner_image")]
    pub runner_image: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profession {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub guidance: String,
    pub kind: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub profession_id: String,
    pub provider: String,
    pub model: String,
    pub kind: String,
    pub all_projects: bool,
    pub project_ids: Vec<String>,
    pub avatar: Option<String>,
    #[serde(default)]
    pub avatar_generation: Option<AvatarGeneration>,
    #[serde(default)]
    pub role_prompt: String,
    #[serde(default)]
    pub role_description: String,
    pub appearance: String,
    pub desk: usize,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecruitmentDraft {
    pub id: String,
    pub org_id: String,
    pub recruiter_id: String,
    pub profession_id: String,
    pub target_agent_id: Option<String>,
    pub brief: String,
    pub profession_name: String,
    pub profession_guidance: String,
    pub status: String,
    pub prompt: String,
    pub error: Option<String>,
    pub created_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarGeneration {
    pub request_id: String,
    pub provider: String,
    pub status: String,
    pub error: Option<String>,
    pub started_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub profession_ids: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub org_id: String,
    pub project_id: String,
    pub title: String,
    pub detail: String,
    pub route: String,
    pub agent_id: Option<String>,
    pub workflow_id: Option<String>,
    pub status: String,
    pub steps: Vec<Step>,
    pub step: usize,
    pub messages: Vec<Message>,
    pub evidence: String,
    pub generation: u64,
    pub created_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub profession_id: String,
    pub instruction: String,
    pub agent_id: Option<String>,
    pub evidence: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub actor: String,
    pub body: String,
    pub created_at: u64,
}
impl Message {
    pub fn new(actor: &str, body: &str) -> Self {
        Self {
            id: id(),
            actor: actor.into(),
            body: body.into(),
            created_at: now(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub org_id: String,
    pub project_id: String,
    pub title: String,
    pub participant_ids: Vec<String>,
    pub messages: Vec<Message>,
    pub status: String,
    pub generation: u64,
    pub cursor: usize,
    pub converted_task_ids: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub agent_id: String,
    pub project_id: String,
    pub body: String,
    pub confirmed: bool,
    pub source: String,
    pub created_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub agent_id: String,
    pub project_id: String,
    pub target_id: String,
    pub kind: String,
    pub generation: u64,
    pub status: String,
    pub result: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
}
impl Run {
    pub fn in_flight(&self) -> bool {
        self.status == "running" || (self.status == "interrupted" && self.finished_at.is_none())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub id: String,
    pub run_id: String,
    pub agent_id: String,
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cached: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp {
    pub id: String,
    pub agent_id: String,
    pub task_id: String,
    pub points: u64,
    pub reason: String,
}

pub(super) fn text(args: &Value, key: &str, limit: usize) -> Result<String> {
    let value = args.get(key).and_then(Value::as_str).unwrap_or("").trim();
    if value.is_empty() || value.len() > limit {
        return Err(format!("{key} must contain 1–{limit} bytes."));
    }
    Ok(value.into())
}
pub(super) fn optional(args: &Value, key: &str, limit: usize) -> Result<String> {
    let value = args.get(key).and_then(Value::as_str).unwrap_or("").trim();
    if value.len() > limit {
        return Err(format!("{key} is too long."));
    }
    Ok(value.into())
}
pub(super) fn list(args: &Value, key: &str) -> Result<Vec<String>> {
    let values: Vec<String> = serde_json::from_value(args.get(key).cloned().unwrap_or(json!([])))
        .map_err(|_| format!("Invalid {key}."))?;
    if values.len() > 32 || values.iter().collect::<HashSet<_>>().len() != values.len() {
        return Err(format!("{key} must contain at most 32 unique entries."));
    }
    Ok(values)
}

impl World {
    pub fn project(&self, project: &str) -> Result<&Project> {
        self.projects
            .iter()
            .find(|p| p.id == project)
            .ok_or_else(|| "Project not found.".into())
    }
    pub fn agent(&self, agent: &str) -> Result<&Agent> {
        self.agents
            .iter()
            .find(|a| a.id == agent)
            .ok_or_else(|| "Agent not found.".into())
    }
    pub fn authorize(&self, agent: &str, project: &str) -> Result<()> {
        let a = self.agent(agent)?;
        let p = self.project(project)?;
        if a.org_id != p.org_id
            || (!a.all_projects && !a.project_ids.iter().any(|id| id == project))
        {
            return Err("Agent is not authorized for this project.".into());
        }
        Ok(())
    }
    pub(super) fn org(&self, org: &str) -> Result<()> {
        self.orgs
            .iter()
            .any(|o| o.id == org)
            .then_some(())
            .ok_or_else(|| "Organization not found.".into())
    }
    pub fn busy(&self, agent: &str) -> bool {
        self.runs
            .iter()
            .any(|r| r.agent_id == agent && r.in_flight())
    }
    pub fn eligible(&self, project: &str, profession: &str) -> Option<String> {
        self.agents
            .iter()
            .filter(|a| {
                a.kind == "worker"
                    && a.profession_id == profession
                    && self.authorize(&a.id, project).is_ok()
                    && !self.busy(&a.id)
            })
            .min_by_key(|a| {
                self.tasks
                    .iter()
                    .filter(|t| t.agent_id.as_deref() == Some(&a.id) && t.status == "queued")
                    .count()
            })
            .map(|a| a.id.clone())
    }
    pub fn context(&self, agent: &str, project: &str) -> Result<Value> {
        self.authorize(agent, project)?;
        let a = self.agent(agent)?;
        let p = self.project(project)?;
        let profession = self
            .professions
            .iter()
            .find(|r| r.id == a.profession_id)
            .ok_or("Profession not found.")?;
        let memories: Vec<_> = self
            .memories
            .iter()
            .rev()
            .filter(|m| m.agent_id == agent && m.project_id == project && m.confirmed)
            .take(12)
            .collect();
        Ok(
            json!({"identity": a.name, "profession": profession.name, "guidance": profession.guidance, "rolePrompt": a.role_prompt, "roleDescription":a.role_description, "project": p.name, "projectContext": p.context, "memories": memories}),
        )
    }
    pub fn active(&self, run: &Run) -> bool {
        (if run.kind == "secretary" {
            super::secretary::active(self, run)
        } else if run.kind == "role_setup" {
            super::role_chat::active(self, run)
        } else if run.kind == "recruitment" {
            super::recruitment::active(self, run)
        } else {
            self.authorize(&run.agent_id, &run.project_id).is_ok()
        }) && self
            .runs
            .iter()
            .any(|r| r.id == run.id && r.status == "running")
            && if matches!(
                run.kind.as_str(),
                "secretary" | "recruitment" | "role_setup"
            ) {
                true
            } else if run.kind == "meeting" {
                self.meetings.iter().any(|m| {
                    m.id == run.target_id
                        && m.status == "discussing"
                        && m.generation == run.generation
                })
            } else {
                self.tasks.iter().any(|t| {
                    t.id == run.target_id
                        && matches!(t.status.as_str(), "working" | "planning")
                        && t.generation == run.generation
                })
            }
    }
    pub fn usage(&mut self, usage: Usage) -> Result<()> {
        let r = self
            .runs
            .iter()
            .find(|r| r.id == usage.run_id)
            .ok_or("Unknown usage run.")?;
        if r.agent_id != usage.agent_id {
            return Err("Usage attribution mismatch.".into());
        }
        if let Some(prior) = self.usage.iter().find(|u| u.id == usage.id) {
            if prior.run_id != usage.run_id || prior.agent_id != usage.agent_id {
                return Err("Usage event collision.".into());
            }
        } else {
            self.usage.push(usage);
        }
        Ok(())
    }

    pub fn apply(&mut self, action: &str, args: &Value) -> Result<Value> {
        match action {
            "create_org" => {
                let org = Org {
                    id: id(),
                    name: text(args, "name", 100)?,
                    description: optional(args, "description", 2000)?,
                };
                let org_id = org.id.clone();
                self.orgs.push(org);
                for (name, kind, guidance) in [
                    ("Project Manager", "pm", "Clarify the requested outcome, acceptance evidence and dependencies. Plan small ordered steps for eligible professions. Escalate missing founder decisions. Never claim execution occurred during planning."),
                    ("Developer", "dev", "Investigate the relevant implementation, make focused changes, preserve conventions and report evidence. Distinguish checks actually run from checks still needed."),
                    ("Tester", "tester", "Design risk-based tests, edge cases, negative paths and regression coverage. Independently inspect evidence. Never call unexecuted tests passing."),
                    ("Infrastructure", "infra", "Assess operational reliability, configuration, deployment dependencies, observability and recovery. Surface material operational decisions.")
                ] { self.professions.push(Profession { id: id(), org_id: org_id.clone(), name: name.into(), guidance: guidance.into(), kind: kind.into() }); }
                super::secretary::ensure_org(self, &org_id)?;
                Ok(json!({"id": org_id}))
            }
            "create_project" => {
                let org_id = text(args, "orgId", 80)?;
                self.org(&org_id)?;
                let project = Project {
                    id: id(),
                    org_id,
                    name: text(args, "name", 100)?,
                    context: optional(args, "context", 16000)?,
                    workspace_path: optional(args, "workspacePath", 2000)?,
                    runner_image: super::command::image_name(
                        args["runnerImage"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .unwrap_or("node:22-alpine"),
                    )?,
                };
                let result = json!({"id": project.id});
                self.projects.push(project);
                Ok(result)
            }
            "update_project" => {
                let project_id = text(args, "projectId", 80)?;
                let context = optional(args, "context", 16000)?;
                let p = self
                    .projects
                    .iter_mut()
                    .find(|p| p.id == project_id)
                    .ok_or("Project not found.")?;
                p.context = context;
                if let Some(image) = args["runnerImage"].as_str() {
                    p.runner_image = super::command::image_name(image)?;
                }
                Ok(json!({"id":p.id}))
            }
            "create_profession" => {
                let org_id = text(args, "orgId", 80)?;
                self.org(&org_id)?;
                let kind = text(args, "kind", 20)?;
                if !["pm", "dev", "tester", "infra", "custom"].contains(&kind.as_str()) {
                    return Err("Invalid profession kind.".into());
                }
                let p = Profession {
                    id: id(),
                    org_id,
                    name: text(args, "name", 100)?,
                    guidance: text(args, "guidance", 8000)?,
                    kind,
                };
                let result = json!({"id":p.id});
                self.professions.push(p);
                Ok(result)
            }
            "create_agent" => super::agent_settings::create(self, args),
            "update_agent_settings" => super::agent_settings::update(self, args),
            "create_recruitment" => super::recruitment::create(self, args),
            "create_secretary_request" => super::secretary::create(self, args),
            "cancel_secretary_request" => super::secretary::cancel(self, args),
            "apply_secretary_blueprint" => super::secretary::apply(self, args),
            "role_message" => super::role_chat::create(self, args),
            "cancel_role_message" => super::role_chat::cancel(self, args),
            "cancel_recruitment" => {
                let draft_id = text(args, "draftId", 80)?;
                let draft = self
                    .recruitment_drafts
                    .iter_mut()
                    .find(|d| d.id == draft_id)
                    .ok_or("Recruiter draft not found.")?;
                if !matches!(draft.status.as_str(), "queued" | "generating") {
                    return Err("This recruiter draft is no longer running.".into());
                }
                draft.status = "cancelled".into();
                for run in self
                    .runs
                    .iter_mut()
                    .filter(|r| r.target_id == draft_id && r.status == "running")
                {
                    run.status = "interrupted".into();
                }
                Ok(json!({"id":draft_id}))
            }
            "update_role_prompt" => {
                let agent_id = text(args, "agentId", 80)?;
                let prompt = optional(args, "rolePrompt", 16000)?;
                let description = args
                    .get("roleDescription")
                    .map(|_| optional(args, "roleDescription", 2000))
                    .transpose()?;
                let agent = self
                    .agents
                    .iter_mut()
                    .find(|a| a.id == agent_id)
                    .ok_or("Agent not found.")?;
                agent.role_prompt = prompt;
                if let Some(description) = description {
                    agent.role_description = description;
                }
                Ok(json!({"id":agent_id}))
            }
            "update_scope" => {
                let agent_id = text(args, "agentId", 80)?;
                let a = self.agent(&agent_id)?.clone();
                if super::secretary::is_secretary(self, &a) {
                    return Err(
                        "The Secretary stays scoped to organization configuration, not projects."
                            .into(),
                    );
                }
                let projects = list(args, "projectIds")?;
                for p in &projects {
                    if self.project(p)?.org_id != a.org_id {
                        return Err("Project belongs to another organization.".into());
                    }
                }
                let a = self.agents.iter_mut().find(|a| a.id == agent_id).unwrap();
                a.all_projects = args["allProjects"].as_bool().unwrap_or(false);
                a.project_ids = projects;
                let invalid: Vec<_> = self
                    .runs
                    .iter()
                    .filter(|r| {
                        r.agent_id == agent_id
                            && r.status == "running"
                            && !matches!(
                                r.kind.as_str(),
                                "secretary" | "recruitment" | "role_setup"
                            )
                            && self.authorize(&agent_id, &r.project_id).is_err()
                    })
                    .map(|r| r.target_id.clone())
                    .collect();
                for target in invalid {
                    self.pause_target(&target);
                }
                Ok(json!({"id":agent_id}))
            }
            "create_workflow" => {
                let org_id = text(args, "orgId", 80)?;
                self.org(&org_id)?;
                let ids: Vec<String> =
                    serde_json::from_value(args.get("professionIds").cloned().unwrap_or(json!([])))
                        .map_err(|_| "Invalid workflow steps.")?;
                if ids.is_empty() || ids.len() > 8 {
                    return Err("Choose between 1 and 8 ordered workflow steps.".into());
                }
                for p in &ids {
                    if !self.professions.iter().any(|r| {
                        r.id == *p
                            && r.org_id == org_id
                            && !matches!(r.kind.as_str(), "pm" | "secretary" | "recruiter")
                    }) {
                        return Err(
                            "Workflow steps must use execution professions in this organization."
                                .into(),
                        );
                    }
                }
                let w = Workflow {
                    id: id(),
                    org_id,
                    name: text(args, "name", 100)?,
                    profession_ids: ids,
                };
                let result = json!({"id":w.id});
                self.workflows.push(w);
                Ok(result)
            }
            "create_task" => self.create_task(args),
            "task_direction" => {
                let task_id = text(args, "taskId", 80)?;
                let body = text(args, "body", 8000)?;
                let control = text(args, "control", 20)?;
                if !["redirect", "pause", "resume", "cancel"].contains(&control.as_str()) {
                    return Err("Unknown task control.".into());
                }
                let t = self
                    .tasks
                    .iter_mut()
                    .find(|t| t.id == task_id)
                    .ok_or("Task not found.")?;
                if ["done", "cancelled"].contains(&t.status.as_str()) {
                    return Err("This task is already closed.".into());
                }
                t.messages.push(Message::new("founder", &body));
                // A finished workflow has no remaining step to dispatch. Founder
                // follow-up must return to planning, with prior evidence retained
                // in the transcript, so the PM can assign changes and verification.
                if matches!(control.as_str(), "redirect" | "resume")
                    && t.route == "auto"
                    && !t.steps.is_empty()
                    && t.step >= t.steps.len()
                {
                    t.steps.clear();
                    t.step = 0;
                    t.agent_id = None;
                    t.messages.push(Message::new(
                        "system",
                        "Workflow reopened for PM planning using the latest founder direction. Prior results remain in the task history.",
                    ));
                }
                t.generation += 1;
                t.status = match control.as_str() {
                    "pause" => "paused",
                    "cancel" => "cancelled",
                    _ => "queued",
                }
                .into();
                for r in self
                    .runs
                    .iter_mut()
                    .filter(|r| r.target_id == task_id && r.status == "running")
                {
                    r.status = "interrupted".into();
                }
                Ok(json!({"id":task_id}))
            }
            "verify_task" => {
                let task_id = text(args, "taskId", 80)?;
                let evidence = text(args, "evidence", 8000)?;
                let t = self
                    .tasks
                    .iter_mut()
                    .find(|t| t.id == task_id)
                    .ok_or("Task not found.")?;
                if t.status != "verifying" {
                    return Err("Only a task awaiting verification can be completed.".into());
                }
                t.status = "done".into();
                t.evidence = evidence;
                let contributors: HashSet<_> = self
                    .runs
                    .iter()
                    .filter(|r| {
                        r.target_id == task_id && r.status == "completed" && r.kind != "meeting"
                    })
                    .map(|r| r.agent_id.clone())
                    .collect();
                for agent in contributors {
                    let event = format!("verified:{task_id}:{agent}");
                    if !self.xp.iter().any(|x| x.id == event) {
                        self.xp.push(Xp {
                            id: event,
                            agent_id: agent,
                            task_id: task_id.clone(),
                            points: 100,
                            reason: "Contributed to a founder-verified task".into(),
                        });
                    }
                }
                Ok(json!({"id":task_id}))
            }
            "create_meeting" => {
                let project_id = text(args, "projectId", 80)?;
                let p = self.project(&project_id)?.clone();
                let participants = list(args, "participantIds")?;
                if participants.is_empty() || participants.len() > 8 {
                    return Err("Invite between 1 and 8 participants.".into());
                }
                for a in &participants {
                    self.authorize(a, &project_id)?;
                }
                let m = Meeting {
                    id: id(),
                    org_id: p.org_id,
                    project_id,
                    title: text(args, "title", 200)?,
                    participant_ids: participants,
                    messages: vec![],
                    status: "idle".into(),
                    generation: 0,
                    cursor: 0,
                    converted_task_ids: vec![],
                };
                let result = json!({"id":m.id});
                self.meetings.push(m);
                Ok(result)
            }
            "meeting_message" => {
                let mid = text(args, "meetingId", 80)?;
                let body = text(args, "body", 8000)?;
                let m = self
                    .meetings
                    .iter()
                    .find(|m| m.id == mid)
                    .ok_or("Meeting not found.")?;
                for a in &m.participant_ids {
                    self.authorize(a, &m.project_id)?;
                }
                let m = self.meetings.iter_mut().find(|m| m.id == mid).unwrap();
                m.messages.push(Message::new("founder", &body));
                m.generation += 1;
                m.cursor = 0;
                m.status = "queued".into();
                for r in self
                    .runs
                    .iter_mut()
                    .filter(|r| r.target_id == mid && r.status == "running")
                {
                    r.status = "interrupted".into();
                }
                Ok(json!({"id":mid}))
            }
            "pause_meeting" => {
                let mid = text(args, "meetingId", 80)?;
                if !self.meetings.iter().any(|m| m.id == mid) {
                    return Err("Meeting not found.".into());
                }
                self.pause_target(&mid);
                Ok(json!({"id":mid}))
            }
            "convert_meeting" => {
                let mid = text(args, "meetingId", 80)?;
                let m = self
                    .meetings
                    .iter()
                    .find(|m| m.id == mid)
                    .ok_or("Meeting not found.")?
                    .clone();
                let mut input = args.clone();
                input["projectId"] = json!(m.project_id);
                // Only the founder-selected outcome is handed off, never the entire meeting history.
                let result = self.create_task(&input)?;
                self.meetings
                    .iter_mut()
                    .find(|m| m.id == mid)
                    .unwrap()
                    .converted_task_ids
                    .push(result["id"].as_str().unwrap().into());
                Ok(result)
            }
            "save_memory" => {
                let agent = text(args, "agentId", 80)?;
                let project = text(args, "projectId", 80)?;
                self.authorize(&agent, &project)?;
                let memory = Memory {
                    id: id(),
                    agent_id: agent,
                    project_id: project,
                    body: text(args, "body", 4000)?,
                    confirmed: args["confirmed"].as_bool().unwrap_or(false),
                    source: "founder".into(),
                    created_at: now(),
                };
                let result = json!({"id":memory.id});
                self.memories.push(memory);
                Ok(result)
            }
            "confirm_memory" => {
                let mid = text(args, "memoryId", 80)?;
                let memory = self
                    .memories
                    .iter()
                    .find(|m| m.id == mid)
                    .ok_or("Memory not found.")?;
                self.authorize(&memory.agent_id, &memory.project_id)?;
                self.memories
                    .iter_mut()
                    .find(|m| m.id == mid)
                    .unwrap()
                    .confirmed = true;
                Ok(json!({"id":mid}))
            }
            "remove_memory" => {
                let mid = text(args, "memoryId", 80)?;
                if !self.memories.iter().any(|m| m.id == mid) {
                    return Err("Memory not found.".into());
                }
                self.memories.retain(|m| m.id != mid);
                Ok(json!({"id":mid}))
            }
            _ => Err("Unknown world action.".into()),
        }
    }
    fn create_task(&mut self, args: &Value) -> Result<Value> {
        let project_id = text(args, "projectId", 80)?;
        let project = self.project(&project_id)?.clone();
        let route = text(args, "route", 20)?;
        if !["auto", "direct"].contains(&route.as_str()) {
            return Err("Choose Auto PM or Direct assign.".into());
        }
        let agent = optional(args, "agentId", 80)?;
        let agent_id = if route == "direct" {
            self.authorize(&agent, &project_id)?;
            if self.agent(&agent)?.kind != "worker" {
                return Err(
                    "Consultants participate in discussion; choose a worker for execution.".into(),
                );
            }
            Some(agent)
        } else {
            None
        };
        let workflow = optional(args, "workflowId", 80)?;
        let workflow_id = if workflow.is_empty() {
            None
        } else {
            if !self
                .workflows
                .iter()
                .any(|w| w.id == workflow && w.org_id == project.org_id)
            {
                return Err("Workflow belongs to another organization.".into());
            }
            Some(workflow)
        };
        let t = Task {
            id: id(),
            org_id: project.org_id,
            project_id,
            title: text(args, "title", 200)?,
            detail: optional(args, "detail", 16000)?,
            route,
            agent_id,
            workflow_id,
            status: "queued".into(),
            steps: vec![],
            step: 0,
            messages: vec![],
            evidence: String::new(),
            generation: 0,
            created_at: now(),
        };
        let result = json!({"id":t.id});
        self.tasks.push(t);
        Ok(result)
    }
    pub fn pause_target(&mut self, target: &str) {
        if let Some(t) = self.tasks.iter_mut().find(|t| t.id == target) {
            t.status = "paused".into();
            t.generation += 1;
        }
        if let Some(m) = self.meetings.iter_mut().find(|m| m.id == target) {
            m.status = "paused".into();
            m.generation += 1;
        }
        for r in self
            .runs
            .iter_mut()
            .filter(|r| r.target_id == target && r.status == "running")
        {
            r.status = "interrupted".into();
        }
    }
}

/// 100 XP per verified contribution. Level N starts at 100 * (N-1)^2.
pub fn level(xp: u64) -> (u64, u64, u64) {
    let mut n = 1u64;
    while n.saturating_mul(n).saturating_mul(100) <= xp && n < 1_000_000 {
        n += 1;
    }
    let floor = (n - 1) * (n - 1) * 100;
    (n, xp - floor, n * n * 100 - floor)
}

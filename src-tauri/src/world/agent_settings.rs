//! Minimal onboarding with server-owned defaults and optional founder settings.
use super::model::*;
use serde_json::{json, Value};

fn validate(w: &World, a: &Agent) -> Result<()> {
    if !["claude", "codex", "claude_api", "deepseek"].contains(&a.provider.as_str()) {
        return Err("Choose Claude CLI, Codex CLI, Claude API, or DeepSeek.".into());
    }
    if a.model.is_empty()
        || (["claude_api", "deepseek"].contains(&a.provider.as_str()) && a.model == "default")
    {
        return Err("Choose a model ID for this API provider in Advanced settings.".into());
    }
    if !["worker", "consultant"].contains(&a.kind.as_str()) {
        return Err("Invalid agent kind.".into());
    }
    let profession = w
        .professions
        .iter()
        .find(|p| p.id == a.profession_id && p.org_id == a.org_id)
        .ok_or("Profession belongs to another organization.")?;
    if profession.kind == "recruiter" && a.kind != "consultant" {
        return Err("Recruiters are consultants, not project execution workers.".into());
    }
    Ok(())
}

pub fn create(w: &mut World, args: &Value) -> Result<Value> {
    let org_id = text(args, "orgId", 80)?;
    w.org(&org_id)?;
    let requested_provider = optional(args, "provider", 40)?;
    // Prefer this org's PM, then another member. Only runtime configuration is
    // inherited: never their instructions, profession, or project permissions.
    let template = w
        .agents
        .iter()
        .filter(|a| {
            a.org_id == org_id
                && (requested_provider.is_empty() || a.provider == requested_provider)
        })
        .min_by_key(|a| {
            !w.professions
                .iter()
                .any(|p| p.id == a.profession_id && p.kind == "pm")
        });
    let provider = if requested_provider.is_empty() {
        template
            .map(|a| a.provider.as_str())
            .unwrap_or("codex")
            .into()
    } else {
        requested_provider
    };
    let mut model = optional(args, "model", 100)?;
    if model.is_empty() {
        model = template
            .map(|a| a.model.clone())
            .unwrap_or_else(|| "default".into());
    }
    let mut name = optional(args, "name", 80)?;
    if name.is_empty() {
        let mut number = 1;
        loop {
            name = format!("Agent {number}");
            if !w
                .agents
                .iter()
                .any(|a| a.org_id == org_id && a.name.eq_ignore_ascii_case(&name))
            {
                break;
            }
            number += 1;
        }
    }
    let project_ids = list(args, "projectIds")?;
    for project in &project_ids {
        if w.project(project)?.org_id != org_id {
            return Err("Project belongs to another organization.".into());
        }
    }
    let mut profession_id = optional(args, "professionId", 80)?;
    let blank = if profession_id.is_empty() {
        let existing = w.professions.iter().find(|p| {
            p.org_id == org_id
                && p.name == "Unassigned"
                && p.kind == "custom"
                && p.guidance.is_empty()
        });
        profession_id = existing.map(|p| p.id.clone()).unwrap_or_else(id);
        existing.is_none()
    } else {
        false
    };
    let kind = optional(args, "kind", 20)?;
    let a = Agent {
        id: id(),
        org_id: org_id.clone(),
        name,
        profession_id: profession_id.clone(),
        provider,
        model,
        kind: if kind.is_empty() {
            "worker".into()
        } else {
            kind
        },
        all_projects: args["allProjects"].as_bool().unwrap_or(false),
        project_ids,
        avatar: None,
        avatar_generation: None,
        role_prompt: optional(args, "rolePrompt", 16000)?,
        role_description: optional(args, "roleDescription", 2000)?,
        appearance: optional(args, "appearance", 1000)?,
        desk: w.agents.iter().filter(|a| a.org_id == org_id).count(),
    };
    if blank {
        w.professions.push(Profession {
            id: profession_id,
            org_id,
            name: "Unassigned".into(),
            guidance: String::new(),
            kind: "custom".into(),
        });
    }
    if let Err(error) = validate(w, &a) {
        if blank {
            w.professions.pop();
        }
        return Err(error);
    }
    let result = json!({"id":a.id});
    w.agents.push(a);
    Ok(result)
}

pub fn update(w: &mut World, args: &Value) -> Result<Value> {
    let agent_id = text(args, "agentId", 80)?;
    let previous = w.agent(&agent_id)?.clone();
    let mut next = previous.clone();
    // An explicit allowlist prevents settings from modifying prompts or access.
    for (key, limit, field) in [
        ("name", 80, &mut next.name),
        ("provider", 40, &mut next.provider),
        ("model", 100, &mut next.model),
        ("kind", 20, &mut next.kind),
        ("professionId", 80, &mut next.profession_id),
    ] {
        if args.get(key).is_some() {
            *field = text(args, key, limit)?;
        }
    }
    if args.get("appearance").is_some() {
        next.appearance = optional(args, "appearance", 1000)?;
    }
    validate(w, &next)?;
    if w.busy(&agent_id)
        || w.role_requests.iter().any(|r| {
            (r.agent_id == agent_id || r.author_id == agent_id)
                && matches!(r.status.as_str(), "queued" | "generating")
        })
        || w.recruitment_drafts.iter().any(|d| {
            (d.target_agent_id.as_deref() == Some(&agent_id) || d.recruiter_id == agent_id)
                && matches!(d.status.as_str(), "queued" | "generating")
        })
        || previous
            .avatar_generation
            .as_ref()
            .is_some_and(|g| g.status == "generating")
    {
        return Err(
            "Wait for the agent's current response or avatar to finish before changing settings."
                .into(),
        );
    }
    if (next.kind != previous.kind || next.profession_id != previous.profession_id)
        && w.tasks.iter().any(|t| {
            !matches!(t.status.as_str(), "done" | "cancelled")
                && (t.agent_id.as_deref() == Some(&agent_id)
                    || t.steps
                        .iter()
                        .skip(t.step)
                        .any(|s| s.agent_id.as_deref() == Some(&agent_id)))
        })
    {
        return Err(
            "Finish or cancel assigned tasks before changing profession or member type.".into(),
        );
    }
    *w.agents.iter_mut().find(|a| a.id == agent_id).unwrap() = next;
    Ok(json!({"id":agent_id}))
}

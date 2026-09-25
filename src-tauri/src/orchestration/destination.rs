//! Where a delegated task runs.
//!
//! A task may name a DESTINATION: one registered project and one repository
//! registered on it. The lead that talks to the person across projects (the
//! head, `team.rs`) gives every task one; a lead inside a project may send a
//! task to another registered repository. The host resolves it here, against
//! the project store and the org chart, and never from the agent's word:
//!
//! - only a registered project, and only a path registered on it, is a
//!   destination — an arbitrary folder is refused, never adopted;
//! - a project agent (manager or assignee) works only in its own project;
//! - an explicit destination that does not resolve is an error. Nothing falls
//!   back to the coordinator's checkout.
//!
//! A task without a destination keeps the old meaning: it runs in its run's
//! own root. That is what every task created before destinations existed has.
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::team::{self, TeamAgent};
use crate::workspaces::Workspace;

/// A copy, not a reference: the project may be renamed while the ledger keeps
/// the name the person approved. The path is what the worker is given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDestination {
    pub project_id: String,
    pub project_name: String,
    /// Absolute path of a repository registered on the project.
    pub repository: String,
}

/// What one `orchestration_task_create` asked for, with who is asking.
pub struct Route<'a> {
    /// The requested assignee: an agent id or name.
    pub who: Option<&'a str>,
    /// A project id or name.
    pub project: Option<&'a str>,
    /// A registered repository path, or its folder name.
    pub repository: Option<&'a str>,
    /// The agent whose direct reports this task may go to (agents mode).
    pub manager: Option<&'a str>,
    /// The head's conversation: every task must have a destination.
    pub cross_project: bool,
    /// The project the run belongs to.
    pub run_project: &'a str,
    /// A subtask's parent destination, inherited when nothing else is named.
    pub parent: Option<&'a TaskDestination>,
}

#[derive(Debug)]
pub struct Routed {
    pub assignee: Option<TeamAgent>,
    pub destination: Option<TaskDestination>,
}

/// The repositories registered on a project: its main folder, then the others.
pub fn repositories(project: &Workspace) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for path in std::iter::once(&project.primary_path).chain(project.paths.iter()) {
        let path = normalize(path);
        if !path.is_empty() && !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

fn normalize(path: &str) -> String {
    let path = path.trim();
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() && !path.is_empty() {
        // "/" stays "/".
        return path[..1].to_owned();
    }
    trimmed.to_owned()
}

fn folder_name(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
}

fn nonempty(text: Option<&str>) -> Option<&str> {
    text.map(str::trim).filter(|t| !t.is_empty())
}

fn find_project<'a>(projects: &'a [Workspace], spec: &str) -> Result<&'a Workspace, String> {
    if let Some(found) = projects.iter().find(|p| p.id == spec) {
        return Ok(found);
    }
    let named: Vec<_> = projects
        .iter()
        .filter(|p| p.name.eq_ignore_ascii_case(spec))
        .collect();
    match named.as_slice() {
        [one] => Ok(one),
        [] => Err(format!(
            "No registered project called {spec}. Call orchestration_destinations for the registered projects."
        )),
        _ => Err(format!(
            "More than one project is called {spec}. Pass its id from orchestration_destinations."
        )),
    }
}

fn matches_repository(registered: &str, spec: &str) -> bool {
    registered == normalize(spec) || folder_name(registered).eq_ignore_ascii_case(spec)
}

fn resolve_repository(project: &Workspace, spec: Option<&str>) -> Result<String, String> {
    let repos = repositories(project);
    let listed = || {
        repos
            .iter()
            .map(|r| format!("{} ({r})", folder_name(r)))
            .collect::<Vec<_>>()
            .join(", ")
    };
    match spec {
        None => match repos.as_slice() {
            [one] => Ok(one.clone()),
            [] => Err(format!(
                "Project {} has no registered folder.",
                project.name
            )),
            _ => Err(format!(
                "Project {} has {} repositories: {}. Pass `repository` to say which.",
                project.name,
                repos.len(),
                listed()
            )),
        },
        Some(spec) => {
            let found: Vec<_> = repos
                .iter()
                .filter(|r| matches_repository(r, spec))
                .collect();
            match found.as_slice() {
                [one] => Ok((*one).clone()),
                [] => Err(format!(
                    "{spec} is not a repository registered on project {}. Registered: {}.",
                    project.name,
                    listed()
                )),
                _ => Err(format!(
                    "More than one repository of project {} is called {spec}. Pass its full path: {}.",
                    project.name,
                    listed()
                )),
            }
        }
    }
}

/// The one project a bare repository names, among those the manager may use.
fn project_for_repository<'a>(
    projects: &'a [Workspace],
    spec: &str,
    allowed: &dyn Fn(&str) -> bool,
) -> Result<&'a Workspace, String> {
    let found: Vec<_> = projects
        .iter()
        .filter(|p| allowed(&p.id))
        .filter(|p| repositories(p).iter().any(|r| matches_repository(r, spec)))
        .collect();
    match found.as_slice() {
        [one] => Ok(one),
        [] => Err(format!(
            "{spec} is not a registered repository. Call orchestration_destinations for the registered ones."
        )),
        _ => Err(format!(
            "The repository {spec} is registered on more than one project ({}). Pass `project` too.",
            found.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// The project an agent is confined to, when the request names exactly one
/// agent and that agent belongs to one project.
fn scoped_project<'a>(team: &'a [TeamAgent], who: &str) -> Result<Option<&'a str>, String> {
    if let Some(agent) = team.iter().find(|a| a.id == who) {
        return Ok(agent.project_id.as_deref());
    }
    let named: Vec<_> = team
        .iter()
        .filter(|a| a.name.eq_ignore_ascii_case(who))
        .collect();
    match named.as_slice() {
        [one] => Ok(one.project_id.as_deref()),
        [] => Ok(None),
        // Two project agents may share a name. Their id tells them apart.
        _ => Err(format!(
            "More than one agent is called {who}. Assign by id, or pass `project`."
        )),
    }
}

/// Resolve a task's assignee and destination. See the module docs for the
/// rules; every refusal says what to pass instead.
pub fn route(team: &[TeamAgent], projects: &[Workspace], req: &Route) -> Result<Routed, String> {
    let manager = match req.manager {
        Some(id) => Some(
            team.iter()
                .find(|a| a.id == id)
                .ok_or("Your registered agent no longer exists.")?,
        ),
        None => None,
    };
    let allowed = |project: &str| manager.is_none_or(|m| team::may_work_in(m, project));
    let name_of = |id: &str| projects.iter().find(|p| p.id == id).map(|p| p.name.clone());
    let who = nonempty(req.who);
    let project_spec = nonempty(req.project);
    let repository_spec = nonempty(req.repository);

    let target: Option<(&Workspace, Option<&str>)> = match (project_spec, repository_spec) {
        (Some(project), repository) => Some((find_project(projects, project)?, repository)),
        (None, Some(repository)) => Some((
            project_for_repository(projects, repository, &allowed)?,
            Some(repository),
        )),
        (None, None) => {
            let scoped = match who {
                Some(who) => scoped_project(team, who)?,
                None => None,
            };
            if let Some(parent) = req.parent {
                let project = projects
                    .iter()
                    .find(|p| p.id == parent.project_id)
                    .ok_or_else(|| {
                        format!(
                            "The parent task's project {} is no longer registered.",
                            parent.project_name
                        )
                    })?;
                Some((project, Some(parent.repository.as_str())))
            } else if let Some(project) =
                scoped.filter(|p| req.cross_project || *p != req.run_project)
            {
                // A report confined to one project can only mean that one.
                Some((
                    projects.iter().find(|p| p.id == project).ok_or(
                        "That agent's project is no longer registered. Assign someone else.",
                    )?,
                    None,
                ))
            } else if req.cross_project {
                return Err("Say where this task runs: pass `project` (and `repository` when the project has more than one). Call orchestration_destinations for the registered projects and who may work there.".into());
            } else {
                None
            }
        }
    };

    let Some((project, repository)) = target else {
        // No destination: the run's own root, as before destinations existed.
        // Still only where the manager may work.
        if !allowed(req.run_project) {
            return Err(
                "This run's project is outside your scope. Name a destination in your own project."
                    .into(),
            );
        }
        let assignee = who
            .map(|who| team::resolve_in(team, req.run_project, who, req.manager, &name_of))
            .transpose()?;
        return Ok(Routed {
            assignee,
            destination: None,
        });
    };

    if !allowed(&project.id) {
        let manager = manager.expect("only a manager restricts projects");
        return Err(format!(
            "You work only in {}, so you cannot send work to {}.",
            manager
                .project_id
                .as_deref()
                .and_then(name_of)
                .unwrap_or_else(|| "your own project".into()),
            project.name
        ));
    }
    let repository = resolve_repository(project, repository)?;
    if !Path::new(&repository).is_dir() {
        return Err(format!(
            "The repository {repository} of project {} does not exist on disk.",
            project.name
        ));
    }
    let assignee = who
        .map(|who| team::resolve_in(team, &project.id, who, req.manager, &name_of))
        .transpose()?;
    Ok(Routed {
        assignee,
        destination: Some(TaskDestination {
            project_id: project.id.clone(),
            project_name: project.name.clone(),
            repository,
        }),
    })
}

/// Before a worker starts: the destination must still be registered. A
/// project deleted or a folder removed since the plan was approved stops the
/// task; it is never redirected.
pub fn verify<'a>(
    projects: &'a [Workspace],
    destination: &TaskDestination,
) -> Result<&'a Workspace, String> {
    let project = projects
        .iter()
        .find(|p| p.id == destination.project_id)
        .ok_or_else(|| {
            format!(
                "This task's project {} is no longer registered. Create a new task for another destination.",
                destination.project_name
            )
        })?;
    if !repositories(project).contains(&destination.repository) {
        return Err(format!(
            "{} is no longer a repository of project {}. Create a new task for another destination.",
            destination.repository, project.name
        ));
    }
    if !Path::new(&destination.repository).is_dir() {
        return Err(format!(
            "The repository {} no longer exists on disk.",
            destination.repository
        ));
    }
    Ok(project)
}

/// What `orchestration_destinations` answers: every project the caller may
/// route to, its repositories, and which of its direct reports can work there.
pub fn directory(team: &[TeamAgent], projects: &[Workspace], manager: Option<&str>) -> Value {
    let manager = manager.and_then(|id| team.iter().find(|a| a.id == id));
    let rows: Vec<Value> = projects
        .iter()
        .filter(|p| manager.is_none_or(|m| team::may_work_in(m, &p.id)))
        .map(|project| {
            let reports: Vec<Value> = manager
                .map(|m| {
                    team::direct_reports(team, &m.id)
                        .into_iter()
                        .filter(|a| a.can_work() && team::may_work_in(a, &project.id))
                        .map(|a| {
                            json!({
                                "id": a.id,
                                "name": a.name,
                                "role": a.role,
                                "scope": if a.project_id.is_some() { "this project only" } else { "any project" },
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!({
                "id": project.id,
                "name": project.name,
                "shelved": project.shelved,
                "repositories": repositories(project)
                    .iter()
                    .enumerate()
                    .map(|(i, path)| json!({ "name": folder_name(path), "path": path, "primary": i == 0 }))
                    .collect::<Vec<_>>(),
                "reports": reports,
            })
        })
        .collect();
    json!({
        "scope": match manager {
            Some(m) if m.project_id.is_some() => "your project only",
            _ => "every registered project",
        },
        "projects": rows,
        "note": "Pass `project` (id or name) and, when a project has more than one repository, `repository` (path or name) to orchestration_task_create. Only listed destinations are accepted.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_chat::{Access, ChatAgent};

    fn dir() -> String {
        let path = std::env::temp_dir().join(format!("octiq-dest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn project(id: &str, name: &str, paths: &[&str]) -> Workspace {
        serde_json::from_value(json!({
            "id": id, "name": name,
            "primary_path": paths.first().copied().unwrap_or(""),
            "paths": paths.iter().skip(1).collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    fn agent(id: &str, name: &str, project: Option<&str>, reports_to: Option<&str>) -> TeamAgent {
        TeamAgent {
            id: id.into(),
            name: name.into(),
            role: String::new(),
            agent: ChatAgent::Claude,
            model: "sonnet".into(),
            effort: None,
            access: Access::Auto,
            project_id: project.map(Into::into),
            reports_to: reports_to.map(Into::into),
            memory_note: None,
            avatar: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    struct World {
        team: Vec<TeamAgent>,
        projects: Vec<Workspace>,
        web: String,
        api: String,
        app: String,
    }

    /// Ryan (global head) manages Maya (global) and Sam (app only). Lee is a
    /// project lead in app with Kim under it. Two projects: shop (web + api)
    /// and app (one repository).
    fn world() -> World {
        let (web, api, app) = (dir(), dir(), dir());
        World {
            team: vec![
                agent("ryan", "Ryan", None, None),
                agent("maya", "Maya", None, Some("ryan")),
                agent("sam", "Sam", Some("app"), Some("ryan")),
                agent("lee", "Lee", Some("app"), None),
                agent("kim", "Kim", Some("app"), Some("lee")),
            ],
            projects: vec![
                project("shop", "Shop", &[&web, &api]),
                project("app", "App", &[&app]),
                project("general", "General", &[]),
            ],
            web,
            api,
            app,
        }
    }

    fn req<'a>(who: &'a str, project: Option<&'a str>, repository: Option<&'a str>) -> Route<'a> {
        Route {
            who: Some(who),
            project,
            repository,
            manager: Some("ryan"),
            cross_project: true,
            run_project: "general",
            parent: None,
        }
    }

    #[test]
    fn one_objective_routes_to_several_projects_and_repositories() {
        let w = world();
        let web = route(
            &w.team,
            &w.projects,
            &req("maya", Some("shop"), Some("web")),
        );
        // By folder name, by full path, and a one-repository project by name.
        let web_name = folder_name(&w.web).to_owned();
        let by_name = route(
            &w.team,
            &w.projects,
            &req("maya", Some("Shop"), Some(&web_name)),
        )
        .unwrap();
        let api = route(
            &w.team,
            &w.projects,
            &req("Maya", Some("shop"), Some(&w.api)),
        )
        .unwrap();
        let app = route(&w.team, &w.projects, &req("sam", Some("App"), None)).unwrap();
        assert!(web.is_err(), "\"web\" is not a folder name here");
        assert_eq!(by_name.destination.unwrap().repository, w.web);
        let api_dest = api.destination.unwrap();
        assert_eq!(
            (api_dest.project_id.as_str(), api_dest.repository.as_str()),
            ("shop", w.api.as_str())
        );
        assert_eq!(api.assignee.unwrap().id, "maya");
        let app_dest = app.destination.unwrap();
        assert_eq!(
            (app_dest.project_name.as_str(), app_dest.repository.as_str()),
            ("App", w.app.as_str())
        );
        // A bare repository path names its project.
        let bare = route(&w.team, &w.projects, &req("maya", None, Some(&w.app))).unwrap();
        assert_eq!(bare.destination.unwrap().project_id, "app");
    }

    #[test]
    fn a_scoped_report_works_only_in_its_project() {
        let w = world();
        // The head may hand Sam work in app, and nowhere else.
        let err = route(
            &w.team,
            &w.projects,
            &req("sam", Some("shop"), Some(&w.web)),
        )
        .unwrap_err();
        assert!(err.contains("Sam works only in App"), "{err}");
        // Naming Sam alone is enough: app is the only place Sam can work.
        let inferred = route(&w.team, &w.projects, &req("sam", None, None)).unwrap();
        assert_eq!(inferred.destination.unwrap().repository, w.app);
    }

    #[test]
    fn a_scoped_lead_cannot_route_out_of_its_project_or_past_its_reports() {
        let w = world();
        let lee = |who, project, repository| Route {
            who: Some(who),
            project,
            repository,
            manager: Some("lee"),
            cross_project: false,
            run_project: "app",
            parent: None,
        };
        let err = route(
            &w.team,
            &w.projects,
            &lee("kim", Some("shop"), Some(&w.web)),
        )
        .unwrap_err();
        assert!(err.contains("You work only in App"), "{err}");
        let err = route(&w.team, &w.projects, &lee("kim", None, Some(&w.web))).unwrap_err();
        assert!(err.contains("not a registered repository"), "{err}");
        // Maya is global but reports to Ryan, not Lee.
        let err = route(&w.team, &w.projects, &lee("maya", Some("app"), None)).unwrap_err();
        assert!(err.contains("does not report to you"), "{err}");
        let ok = route(&w.team, &w.projects, &lee("kim", Some("app"), None)).unwrap();
        assert_eq!(ok.assignee.unwrap().id, "kim");
        // Naming Kim in a run that sits elsewhere still means Kim's project.
        let elsewhere = Route {
            run_project: "shop",
            ..lee("kim", None, None)
        };
        let routed = route(&w.team, &w.projects, &elsewhere).unwrap();
        assert_eq!(routed.destination.unwrap().project_id, "app");
        // Nothing defaults into a run project outside the lead's scope.
        let unnamed = Route {
            who: None,
            ..elsewhere
        };
        let err = route(&w.team, &w.projects, &unnamed).unwrap_err();
        assert!(err.contains("outside your scope"), "{err}");
    }

    #[test]
    fn invalid_or_arbitrary_destinations_are_refused_never_replaced() {
        let w = world();
        let stray = dir();
        for (project, repository, expect) in [
            (
                Some("nowhere"),
                None,
                "No registered project called nowhere",
            ),
            (Some("shop"), None, "Pass `repository`"),
            (
                Some("shop"),
                Some(stray.as_str()),
                "is not a repository registered on project Shop",
            ),
            (None, Some(stray.as_str()), "is not a registered repository"),
            (None, Some("/etc"), "is not a registered repository"),
            (Some("general"), None, "has no registered folder"),
        ] {
            let err = route(&w.team, &w.projects, &req("maya", project, repository)).unwrap_err();
            assert!(err.contains(expect), "{project:?} {repository:?}: {err}");
        }
        // The head's conversation never defaults to its own checkout.
        let err = route(&w.team, &w.projects, &req("maya", None, None)).unwrap_err();
        assert!(err.contains("Say where this task runs"), "{err}");
        // A registered folder that vanished from disk.
        let gone = project("gone", "Gone", &["/definitely/not/here"]);
        let mut projects = w.projects.clone();
        projects.push(gone);
        let err = route(&w.team, &projects, &req("maya", Some("gone"), None)).unwrap_err();
        assert!(err.contains("does not exist on disk"), "{err}");
    }

    #[test]
    fn legacy_tasks_keep_the_run_root_and_subtasks_inherit() {
        let w = world();
        // A project lead naming nothing: no destination, as before.
        let legacy = Route {
            who: Some("kim"),
            project: None,
            repository: None,
            manager: Some("lee"),
            cross_project: false,
            run_project: "app",
            parent: None,
        };
        let routed = route(&w.team, &w.projects, &legacy).unwrap();
        assert!(routed.destination.is_none());
        assert_eq!(routed.assignee.unwrap().id, "kim");
        // Ordinary orchestration: no agents, no destination.
        let plain = Route {
            who: None,
            manager: None,
            ..legacy
        };
        assert!(route(&w.team, &w.projects, &plain)
            .unwrap()
            .destination
            .is_none());
        // A subtask runs where its parent does.
        let parent = TaskDestination {
            project_id: "shop".into(),
            project_name: "Shop".into(),
            repository: w.api.clone(),
        };
        let sub = Route {
            who: Some("maya"),
            project: None,
            repository: None,
            manager: Some("ryan"),
            cross_project: false,
            run_project: "general",
            parent: Some(&parent),
        };
        assert_eq!(
            route(&w.team, &w.projects, &sub).unwrap().destination,
            Some(parent)
        );
    }

    #[test]
    fn verify_refuses_a_destination_removed_after_approval() {
        let w = world();
        let dest = route(
            &w.team,
            &w.projects,
            &req("maya", Some("shop"), Some(&w.api)),
        )
        .unwrap()
        .destination
        .unwrap();
        assert_eq!(verify(&w.projects, &dest).unwrap().id, "shop");
        let mut fewer = w.projects.clone();
        fewer[0].paths.clear();
        assert!(verify(&fewer, &dest)
            .unwrap_err()
            .contains("no longer a repository"));
        fewer.remove(0);
        assert!(verify(&fewer, &dest)
            .unwrap_err()
            .contains("no longer registered"));
    }

    #[test]
    fn directory_lists_only_reachable_projects_and_eligible_reports() {
        let w = world();
        let all = directory(&w.team, &w.projects, Some("ryan"));
        let shop = &all["projects"][0];
        assert_eq!(shop["repositories"].as_array().unwrap().len(), 2);
        let names = |p: &Value| {
            p["reports"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["name"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(shop), ["Maya"]);
        assert_eq!(names(&all["projects"][1]), ["Maya", "Sam"]);
        let scoped = directory(&w.team, &w.projects, Some("lee"));
        assert_eq!(scoped["projects"].as_array().unwrap().len(), 1);
        assert_eq!(names(&scoped["projects"][0]), ["Kim"]);
    }
}

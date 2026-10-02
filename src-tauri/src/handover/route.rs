//! The front desk opening a chat with another agent: a handover of kind
//! `route`.
//!
//! The person talks to the front desk (`team::front_desk_brief`), which
//! calls `route_chat` with an agent, a project and a brief written from what
//! the person said. Everything a handover already guarantees holds: the call
//! only records a PENDING card, the person's confirm on their own socket is
//! the only thing that creates a chat, the registry and scope are checked
//! again at confirm, and the new chat runs on the agent's registered
//! settings. What is different:
//!
//! - **Who may ask.** Only a front-desk chat, and never for itself.
//! - **Where.** As a conversation the person starts: a project agent in its
//!   project, in a new worktree; the head across projects from home; any
//!   other agent in the project named, or at home. Never anyone's checkout.
//! - **What the agent reads.** `message`, written when the card is drawn, is
//!   exactly the visible part of the new chat's first message, so the card
//!   shows what the agent will receive. Attachments are copied into a folder
//!   of their own that the new chat may read, and a file that cannot be is
//!   named on the card, never dropped silently.
//! - **What is left.** The front-desk chat is hidden, so a route asks nothing
//!   back, tells it nothing after, and leaves no record when cancelled: a
//!   declined, superseded or abandoned route is deleted, with its folder. A
//!   newer proposal from the same front-desk chat replaces a pending one.
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::*;

/// The most files one route carries.
const ATTACHMENTS_MAX: usize = 20;
/// How long a pending route waits on a person who walked away, at most. Its
/// front-desk chat is gone after the next restart anyway (`recover`).
const PENDING_FOR_MS: i64 = 24 * 60 * 60 * 1000;

/// A file the new chat gets, as copied for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteFile {
    pub name: String,
    /// The copy in the route's own folder: what the new chat opens.
    pub path: String,
    /// Sent to the agent as a picture, not only named.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub image: bool,
}

/// A file the front desk named that the new chat could not be given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unreadable {
    pub path: String,
    pub problem: String,
}

/// What a route adds to a handover record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDetail {
    /// The new chat's first message as the person and the agent see it.
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<RouteFile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unreadable: Vec<Unreadable>,
    /// A route to the head: its conversation spans every project, from home.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cross_project: bool,
    /// The folder the attachments were copied to, removed with the record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

/// One `route_chat` call, as the front desk sends it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteAsk {
    pub agent: String,
    #[serde(default)]
    pub project: Option<String>,
    pub brief: String,
    #[serde(default)]
    pub attachments: Vec<String>,
    pub request_id: String,
}

/// The front-desk chat asking, as the host knows it.
pub struct RouteSource {
    pub chat_key: String,
    /// The front desk the chat was started with.
    pub desk: TeamAgent,
    pub origin: QuestionOrigin,
}

fn route_digest(ask: &RouteAsk) -> String {
    use sha2::{Digest, Sha256};
    let canonical = serde_json::json!({
        "agent": ask.agent.trim(),
        "project": ask.project.as_deref().map(str::trim),
        "brief": ask.brief.trim(),
        "attachments": ask.attachments,
    });
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Where a routed chat works, and whether it is the head's.
struct Placed {
    destination: TaskDestination,
    workspace: WorkspacePlan,
    cross_project: bool,
}

fn folder_plan(path: &str) -> WorkspacePlan {
    WorkspacePlan {
        mode: "folder".into(),
        path: path.to_owned(),
        branch: String::new(),
        head: String::new(),
        uncommitted: None,
        chosen: "new".into(),
        git_dir: String::new(),
        prepared_cwd: None,
        prepared_branch: String::new(),
    }
}

/// The project a routed chat runs in, by the rules a conversation the
/// person starts follows (`lib/agentExecution.ts`), and checked against the
/// agent's scope. Never a checkout another chat works in.
fn place(
    team: &[TeamAgent],
    projects: &[Workspace],
    home: Option<&str>,
    head: Option<&TeamAgent>,
    agent: &TeamAgent,
    asked: Option<&str>,
) -> Result<Placed, String> {
    let names: Vec<(String, String)> = projects
        .iter()
        .map(|p| (p.id.clone(), p.name.clone()))
        .collect();
    let home = team::home_project(home, &names).map(|(id, _)| id.clone());
    let named = |spec: &str| {
        projects
            .iter()
            .find(|p| p.id == spec || p.name.eq_ignore_ascii_case(spec))
    };
    let cross_project = head.is_some_and(|h| h.id == agent.id);
    let project_id = if cross_project {
        // The head's conversation lives at home and routes each task it
        // hands out itself, whichever project the request is about.
        home.clone().ok_or(
            "There is no home workspace for the lead's conversation. Register a project named General, or choose a home in Settings, Agents.",
        )?
    } else if let Some(own) = &agent.project_id {
        if let Some(asked) = asked {
            match named(asked) {
                Some(p) if &p.id != own => {
                    let home = projects
                        .iter()
                        .find(|p| &p.id == own)
                        .map_or("another project".to_owned(), |p| p.name.clone());
                    return Err(format!(
                        "{} works only in {home}, so it cannot take a chat in {}. Route it to {home}, or to an agent who works in {}.",
                        agent.name, p.name, p.name
                    ));
                }
                None => return Err(format!("No registered project is called {asked}.")),
                _ => {}
            }
        }
        own.clone()
    } else {
        match asked {
            Some(asked) => named(asked)
                .map(|p| p.id.clone())
                .ok_or_else(|| format!("No registered project is called {asked}."))?,
            None => home.clone().ok_or_else(|| {
                format!(
                    "{} works in every project, so say which: pass `project`.",
                    agent.name
                )
            })?,
        }
    };
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or("That project is no longer registered.")?;
    let primary = destination::repositories(project)
        .into_iter()
        .next()
        .ok_or_else(|| format!("{} has no folder registered.", project.name))?;
    let routed = destination::route(
        team,
        projects,
        &Route {
            who: None,
            project: Some(&project.id),
            repository: Some(&primary),
            manager: None,
            cross_project: true,
            run_project: "",
            parent: None,
        },
    )?;
    let destination = routed
        .destination
        .ok_or("The destination could not be resolved.")?;
    if !team::may_work_in(agent, &destination.project_id) {
        return Err(format!(
            "{} is not allowed to work in {}.",
            agent.name, destination.project_name
        ));
    }
    // At home nothing is prepared, as for a conversation started there; in
    // a code project a new worktree keeps the primary checkout untouched.
    let workspace = if cross_project || home.as_deref() == Some(destination.project_id.as_str()) {
        folder_plan(&destination.repository)
    } else {
        plan_workspace(&destination, &BriefState::default(), None)?
    };
    Ok(Placed {
        destination,
        workspace,
        cross_project,
    })
}

/// Is `path` a file the person uploaded to this app, and nothing else: a
/// plain file directly in the attachments folder, never a link out of it.
fn uploaded(uploads: &Path, path: &str) -> Result<PathBuf, String> {
    let given = Path::new(path.trim());
    if !given.is_absolute() {
        return Err("not a full path".into());
    }
    let meta = fs::symlink_metadata(given).map_err(|_| "no such file".to_owned())?;
    if !meta.is_file() {
        return Err("not a plain file".into());
    }
    let canonical = crate::paths::canonicalize(given).map_err(|e| e.to_string())?;
    let root = crate::paths::canonicalize(uploads).map_err(|e| e.to_string())?;
    if canonical.parent() != Some(root.as_path()) {
        return Err("not a file the person attached in OctiqFlow".into());
    }
    Ok(canonical)
}

fn is_image(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// The name a person gave an upload: `save_attachment` prefixes a uuid.
fn display_name(file_name: &str) -> String {
    match (file_name.get(..36), file_name.get(36..)) {
        (Some(prefix), Some(rest))
            if rest.len() > 1 && rest.starts_with('-') && uuid::Uuid::parse_str(prefix).is_ok() =>
        {
            rest[1..].to_owned()
        }
        _ => file_name.to_owned(),
    }
}

/// Copy each attachment into `folder` for the new chat; name the rest.
fn carry(uploads: &Path, folder: &Path, paths: &[String]) -> (Vec<RouteFile>, Vec<Unreadable>) {
    let mut files = Vec::new();
    let mut unreadable = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        let path = path.trim();
        if path.is_empty() || !seen.insert(path.to_owned()) {
            continue;
        }
        let refuse = |problem: String| Unreadable {
            path: path.to_owned(),
            problem,
        };
        let source = match uploaded(uploads, path) {
            Ok(source) => source,
            Err(problem) => {
                unreadable.push(refuse(problem));
                continue;
            }
        };
        let file_name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = display_name(&file_name);
        let target = folder.join(&file_name);
        let copied = fs::create_dir_all(folder).and_then(|_| fs::copy(&source, &target));
        match copied {
            Ok(_) => files.push(RouteFile {
                image: is_image(&name),
                name,
                path: target.to_string_lossy().into_owned(),
            }),
            Err(e) => unreadable.push(refuse(format!("could not be copied for the new chat: {e}"))),
        }
    }
    (files, unreadable)
}

/// The visible part of the routed chat's first message.
pub fn render(desk: &str, brief: &str, files: &[RouteFile]) -> String {
    let mut out = format!("{}\n", brief.trim());
    if !files.is_empty() {
        out.push_str(&format!(
            "\nAttachments:\n{}\n",
            files
                .iter()
                .map(|f| format!("- {}{}", f.path, if f.image { " (image)" } else { "" }))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    out.push_str(&format!(
        "\n(Opened by {desk}, the person's front desk, once the person confirmed it.)"
    ));
    out
}

/// Remove a route's copied files.
pub(super) fn discard(record: &Handover) {
    if let Some(folder) = record.route.as_ref().and_then(|r| r.folder.as_deref()) {
        let _ = fs::remove_dir_all(folder);
    }
}

/// Drop a route from the store: on disk, with its folder, and on every
/// screen (the record goes out once more, declined, so pages drop it).
pub(super) fn forget(stored: &mut Stored, id: &str) -> Option<Handover> {
    let mut record = stored.handovers.remove(id)?;
    discard(&record);
    if record.status == Status::Pending {
        record.status = Status::Declined;
        record.decided_at = Some(now_ms());
    }
    Some(record)
}

/// Record a pending route from a front-desk chat, replacing the pending one
/// it made before, or answer with the one this requestId already made.
pub fn request(
    path: &Path,
    host: &dyn Host,
    source: RouteSource,
    ask: RouteAsk,
) -> Result<Handover, String> {
    if source.origin.session_key != source.chat_key {
        return Err("Only the front desk itself can route this chat.".into());
    }
    let request_id = ask.request_id.trim().to_owned();
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("Pass a requestId (at most 128 characters), and reuse it only to retry this exact route.".into());
    }
    let brief = ask.brief.trim().to_owned();
    if brief.is_empty() {
        return Err(
            "Write the brief: what the person wants, for the agent who has not seen this chat."
                .into(),
        );
    }
    if brief.chars().count() > FIELD_MAX {
        return Err(format!(
            "The brief is longer than {FIELD_MAX} characters. Keep it to what the agent needs to start."
        ));
    }
    if ask.attachments.len() > ATTACHMENTS_MAX {
        return Err(format!("Pass at most {ATTACHMENTS_MAX} attachments."));
    }
    let request_digest = route_digest(&ask);

    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(path)?;
    if let Some(existing) = stored
        .handovers
        .values()
        .find(|h| h.source_chat_key == source.chat_key && h.request_id == request_id)
    {
        if existing.request_digest != request_digest {
            return Err(format!(
                "requestId {request_id} was already used for a different route. Use a new requestId."
            ));
        }
        return Ok(existing.clone());
    }
    if let Some(open) = stored
        .handovers
        .values()
        .find(|h| h.source_chat_key == source.chat_key && h.status == Status::Starting)
    {
        return Err(format!(
            "The person confirmed a chat with {} and it is being opened. End your turn.",
            open.to.name
        ));
    }

    let team_path = host.team_path();
    let team = team::list(&team_path, None, true)?;
    let projects = host.projects()?;
    let agent = find_agent(&team, &ask.agent)?.clone();
    if agent.id == source.desk.id {
        return Err("You are the front desk. Route the person to another registered agent; you do not take the work yourself.".into());
    }
    let head = team::head(&team_path)?;
    let home = team::home(&team_path)?;
    let placed = place(
        &team,
        &projects,
        home.as_deref(),
        head.as_ref(),
        &agent,
        ask.project
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty()),
    )?;

    let id = format!("handover_{}", uuid::Uuid::new_v4().simple());
    let (attachments, unreadable, folder) = if ask.attachments.is_empty() {
        (Vec::new(), Vec::new(), None)
    } else {
        let uploads = host.attachments_dir()?;
        let folder = uploads.join(format!("route-{id}"));
        let (files, unreadable) = carry(&uploads, &folder, &ask.attachments);
        let folder = (!files.is_empty()).then(|| folder.to_string_lossy().into_owned());
        (files, unreadable, folder)
    };
    let message = render(&source.desk.name, &brief, &attachments);

    // The proposal this one revises, and any the person walked away from.
    let now = now_ms();
    let replaced: Vec<String> = stored
        .handovers
        .values()
        .filter(|h| h.kind == Kind::Route && h.status == Status::Pending)
        .filter(|h| h.source_chat_key == source.chat_key || now - h.created_at > PENDING_FOR_MS)
        .map(|h| h.id.clone())
        .collect();
    let replaced: Vec<Handover> = replaced
        .iter()
        .filter_map(|id| forget(&mut stored, id))
        .collect();

    let record = Handover {
        id,
        request_id,
        source_chat_key: source.chat_key,
        source_title: String::new(),
        source_project: String::new(),
        from: Party {
            agent_id: Some(source.desk.id.clone()),
            name: source.desk.name.clone(),
        },
        to: Party {
            agent_id: Some(agent.id.clone()),
            name: agent.name.clone(),
        },
        settings: settings_of(&agent),
        destination: placed.destination,
        workspace: placed.workspace,
        brief: Brief {
            objective: brief,
            ..Brief::default()
        },
        status: Status::Pending,
        created_at: now,
        decided_at: None,
        target_chat_key: None,
        error: None,
        abandonable: false,
        notice: Notice::Pending,
        notice_error: None,
        request_digest,
        origin: Some(source.origin),
        asks: Vec::new(),
        outcomes: Vec::new(),
        outcome_receipts: Vec::new(),
        kind: Kind::Route,
        route: Some(RouteDetail {
            message,
            attachments,
            unreadable,
            cross_project: placed.cross_project,
            folder,
        }),
    };
    stored.handovers.insert(record.id.clone(), record.clone());
    if let Err(error) = write(path, &stored) {
        discard(&record);
        return Err(error);
    }
    replaced.iter().for_each(announce);
    announce(&record);
    Ok(record)
}

/// What the front desk is told when its call returns. It never waits: the
/// person may want to talk on before deciding, and a revised call replaces
/// the card.
pub fn proposed_text(record: &Handover) -> String {
    let route = record.route.as_ref();
    let unreadable = route.map_or(0, |r| r.unreadable.len());
    let files = if unreadable > 0 {
        format!(
            " {unreadable} attachment{} could not be given to {} and the card says so; tell the person.",
            if unreadable == 1 { "" } else { "s" },
            record.to.name
        )
    } else {
        String::new()
    };
    format!(
        "The person now sees a card proposing a new chat with {} in {}, with your brief. Nothing is created unless they confirm it.{files} Say in one short line what you proposed and end your turn. If they ask for changes, call route_chat again with a new requestId; it replaces this card.",
        record.to.name, record.destination.project_name
    )
}

/// The first message of a route that could not be started after a restart,
/// written into the chat it was meant to open so the failure and the brief
/// are where the person looks for them.
pub fn failure_text(record: &Handover, error: &str) -> String {
    format!(
        "OctiqFlow could not open this chat with {}: {error}\n\nThe request it was opened for:\n\n{}",
        record.to.name,
        record
            .route
            .as_ref()
            .map_or(record.brief.objective.as_str(), |r| r.message.as_str())
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handover::tests::{project, register, repo, scratch, FakeHost};

    struct Desk {
        root: PathBuf,
        store: PathBuf,
        team: PathBuf,
        projects: Vec<Workspace>,
        desk: TeamAgent,
        /// Global, the person's head.
        head: TeamAgent,
        /// Global, not the head.
        writer: TeamAgent,
        /// Scoped to App, reports to the head.
        scoped: TeamAgent,
    }

    fn redraft(agent: &TeamAgent) -> crate::team::TeamDraft {
        crate::team::TeamDraft {
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
        }
    }

    fn desk_world() -> Desk {
        let root = scratch("route");
        let app = repo(&root, "app");
        let other = repo(&root, "other");
        let general = root.join("general");
        fs::create_dir_all(&general).unwrap();
        let team = root.join("team.json");
        let projects = vec![
            project("p-app", "App", &[&app]),
            project("p-other", "Other", &[&other]),
            project("p-general", "General", &[&general]),
        ];
        let head = register(&team, "Potato", None, "opus", Access::Auto);
        team::set_head(&team, Some(&head.id)).unwrap();
        let writer = register(&team, "Quill", None, "sonnet", Access::Edits);
        let scoped = register(&team, "Mango", Some("p-app"), "sonnet", Access::Edits);
        let scoped = team::save(
            &team,
            crate::team::TeamDraft {
                reports_to: Some(head.id.clone()),
                ..redraft(&scoped)
            },
        )
        .unwrap();
        let desk = team::create_front_desk(&team, team::FrontDeskDraft::default()).unwrap();
        Desk {
            store: root.join("handovers.json"),
            root,
            team,
            projects,
            desk,
            head,
            writer,
            scoped,
        }
    }

    fn host(w: &Desk) -> FakeHost {
        FakeHost {
            projects: w.projects.clone(),
            team: w.team.clone(),
            root: w.root.clone(),
            ..FakeHost::default()
        }
    }

    fn source(w: &Desk, chat: &str) -> RouteSource {
        RouteSource {
            chat_key: chat.into(),
            desk: w.desk.clone(),
            origin: crate::question_store::test_origin(chat),
        }
    }

    fn ask(agent: &str, request_id: &str) -> RouteAsk {
        RouteAsk {
            agent: agent.into(),
            project: None,
            brief: "Fix the login bug on phones. The person saw it on Safari.".into(),
            attachments: Vec::new(),
            request_id: request_id.into(),
        }
    }

    fn records(w: &Desk) -> Vec<Public> {
        list(&w.store).unwrap()
    }

    #[test]
    fn a_route_to_a_project_agent_is_a_pending_card_in_its_project_and_creates_nothing() {
        let w = desk_world();
        let host = host(&w);
        let record = request(
            &w.store,
            &host,
            source(&w, "chat:desk1"),
            ask("Mango", "r1"),
        )
        .unwrap();
        assert_eq!(record.kind, Kind::Route);
        assert_eq!(record.status, Status::Pending);
        assert_eq!(record.to.agent_id.as_deref(), Some(w.scoped.id.as_str()));
        assert_eq!(record.destination.project_id, "p-app");
        // As a conversation started in a code project: a new worktree.
        assert_eq!(record.workspace.mode, "worktree");
        let route = record.route.clone().unwrap();
        assert!(!route.cross_project);
        assert!(
            route.message.starts_with("Fix the login bug on phones."),
            "{}",
            route.message
        );
        assert!(route.message.contains("front desk"), "{}", route.message);
        // The registered settings, not anything the front desk said.
        assert_eq!(record.settings.model.as_deref(), Some("sonnet"));
        assert_eq!(record.settings.access, Access::Edits);
        assert!(proposed_text(&record).contains("Nothing is created unless they confirm"));
        assert!(host.starts.lock().unwrap().is_empty());
        assert!(host.saved.lock().unwrap().is_empty());
        assert_eq!(*host.worktrees.lock().unwrap(), 0);
        assert_eq!(records(&w).len(), 1);
    }

    #[test]
    fn a_project_agent_is_refused_in_another_project() {
        let w = desk_world();
        let mut asked = ask("Mango", "r1");
        asked.project = Some("Other".into());
        let error = request(&w.store, &host(&w), source(&w, "chat:desk1"), asked).unwrap_err();
        assert!(error.contains("Mango works only in App"), "{error}");
        assert!(records(&w).is_empty());
    }

    #[test]
    fn the_front_desk_cannot_route_to_itself() {
        let w = desk_world();
        let error = request(
            &w.store,
            &host(&w),
            source(&w, "chat:desk1"),
            ask(&w.desk.id, "r1"),
        )
        .unwrap_err();
        assert!(error.contains("You are the front desk"), "{error}");
        assert!(records(&w).is_empty());
    }

    #[test]
    fn an_unknown_agent_or_project_is_refused_by_name() {
        let w = desk_world();
        let error = request(
            &w.store,
            &host(&w),
            source(&w, "chat:desk1"),
            ask("Nobody", "r1"),
        )
        .unwrap_err();
        assert!(
            error.contains("No registered agent called Nobody"),
            "{error}"
        );
        let mut asked = ask("Quill", "r2");
        asked.project = Some("Nowhere".into());
        let error = request(&w.store, &host(&w), source(&w, "chat:desk1"), asked).unwrap_err();
        assert!(
            error.contains("No registered project is called Nowhere"),
            "{error}"
        );
    }

    #[test]
    fn a_global_agent_goes_to_the_named_project_or_home() {
        let w = desk_world();
        let mut asked = ask("Quill", "r1");
        asked.project = Some("Other".into());
        let named = request(&w.store, &host(&w), source(&w, "chat:desk1"), asked).unwrap();
        assert_eq!(named.destination.project_id, "p-other");
        assert_eq!(named.workspace.mode, "worktree");

        let home = request(
            &w.store,
            &host(&w),
            source(&w, "chat:desk2"),
            ask("Quill", "r2"),
        )
        .unwrap();
        assert_eq!(home.destination.project_id, "p-general");
        assert_eq!(home.workspace.mode, "folder", "nothing is prepared at home");
    }

    #[test]
    fn a_route_to_the_head_is_its_cross_project_conversation_at_home() {
        let w = desk_world();
        let mut asked = ask("Potato", "r1");
        // Whatever project the request is about, the head plans from home.
        asked.project = Some("App".into());
        let record = request(&w.store, &host(&w), source(&w, "chat:desk1"), asked).unwrap();
        assert!(record.route.as_ref().unwrap().cross_project);
        assert_eq!(record.destination.project_id, "p-general");
        assert_eq!(record.workspace.mode, "folder");

        let host = host(&w);
        let confirmed = confirm(&w.store, &record.id, &host).unwrap();
        assert_eq!(confirmed.status, Status::Confirmed);
        let start = host.starts.lock().unwrap()[0].clone();
        // The head's own brief: it routes every task it hands out.
        assert!(
            start.prompt.contains("call orchestration_destinations"),
            "{}",
            start.prompt
        );
        let lead = team::lead_for_chat(&w.team, &start.key).unwrap().unwrap();
        assert!(lead.cross_project);
        assert_eq!(lead.lead_id, w.head.id);
    }

    #[test]
    fn confirm_starts_one_ordinary_chat_with_the_brief_on_the_agents_registered_settings() {
        let w = desk_world();
        let host = host(&w);
        let record = request(
            &w.store,
            &host,
            source(&w, "chat:desk1"),
            ask("Mango", "r1"),
        )
        .unwrap();
        let message = record.route.clone().unwrap().message;
        let confirmed = confirm(&w.store, &record.id, &host).unwrap();
        assert_eq!(confirmed.status, Status::Confirmed);
        let starts = host.starts.lock().unwrap().clone();
        assert_eq!(starts.len(), 1);
        let start = &starts[0];
        assert_eq!(Some(start.key.clone()), confirmed.target_chat_key);
        assert_eq!(start.agent, ChatAgent::Claude);
        assert_eq!(start.model.as_deref(), Some("sonnet"));
        assert_eq!(start.effort.as_deref(), Some("high"));
        assert_eq!(start.access, Access::Edits);
        // Exactly what the card showed, then the agent's own lead brief.
        assert!(
            start
                .prompt
                .starts_with(&format!("{message}{}", team::BRIEF_MARK)),
            "{}",
            start.prompt
        );
        assert!(start.prompt.contains("You are Mango"), "{}", start.prompt);
        // A normal chat in the agent's project, listed under its lead record.
        let saved = host.saved.lock().unwrap().clone();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].project_id, "p-app");
        assert_eq!(*host.worktrees.lock().unwrap(), 1);
        let lead = team::lead_for_chat(&w.team, &start.key).unwrap().unwrap();
        assert_eq!(lead.lead_id, w.scoped.id);
        // The front desk is not woken: its call already returned.
        assert!(host.told.lock().unwrap().is_empty());
        // Confirming again starts nothing more.
        confirm(&w.store, &record.id, &host).unwrap();
        assert_eq!(host.starts.lock().unwrap().len(), 1);
    }

    #[test]
    fn confirm_refuses_an_agent_rescoped_since_the_card_and_starts_nothing() {
        let w = desk_world();
        let host = host(&w);
        let mut asked = ask("Quill", "r1");
        asked.project = Some("Other".into());
        let record = request(&w.store, &host, source(&w, "chat:desk1"), asked).unwrap();
        team::save(
            &w.team,
            crate::team::TeamDraft {
                project_id: Some("p-app".into()),
                ..redraft(&w.writer)
            },
        )
        .unwrap();
        let error = confirm(&w.store, &record.id, &host).unwrap_err();
        assert!(error.contains("no longer works in Other"), "{error}");
        assert!(host.starts.lock().unwrap().is_empty());
        assert_eq!(
            records(&w)[0].status,
            Status::Pending,
            "still the person's to cancel"
        );
    }

    #[test]
    fn cancel_leaves_no_chat_no_record_and_no_copied_file() {
        let w = desk_world();
        let host = host(&w);
        let uploads = host.attachments_dir().unwrap();
        let upload = uploads.join(format!("{}-shot.png", uuid::Uuid::new_v4()));
        fs::write(&upload, b"png").unwrap();
        let mut asked = ask("Mango", "r1");
        asked.attachments = vec![upload.to_string_lossy().into_owned()];
        let record = request(&w.store, &host, source(&w, "chat:desk1"), asked).unwrap();
        let folder = record.route.clone().unwrap().folder.unwrap();
        assert!(Path::new(&folder).is_dir());

        let gone = decline(&w.store, &record.id).unwrap();
        assert_eq!(gone.status, Status::Declined);
        assert!(records(&w).is_empty(), "no orphan record");
        assert!(!Path::new(&folder).exists(), "no copied file");
        assert!(host.starts.lock().unwrap().is_empty());
        assert!(host.saved.lock().unwrap().is_empty());
        assert!(upload.exists(), "the person's own upload is untouched");
        assert!(
            confirm(&w.store, &record.id, &host).is_err(),
            "nothing left to confirm"
        );
    }

    #[test]
    fn a_revised_proposal_replaces_the_pending_card() {
        let w = desk_world();
        let host = host(&w);
        let first = request(
            &w.store,
            &host,
            source(&w, "chat:desk1"),
            ask("Mango", "r1"),
        )
        .unwrap();
        let mut revised = ask("Quill", "r2");
        revised.brief = "Actually, write the release notes.".into();
        let second = request(&w.store, &host, source(&w, "chat:desk1"), revised.clone()).unwrap();
        let left = records(&w);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, second.id);
        assert_ne!(first.id, second.id);
        // Another front-desk chat's card is its own.
        request(
            &w.store,
            &host,
            source(&w, "chat:desk2"),
            ask("Mango", "r1"),
        )
        .unwrap();
        assert_eq!(records(&w).len(), 2);
        // A retry of the same call is the same card.
        assert_eq!(
            request(&w.store, &host, source(&w, "chat:desk1"), revised)
                .unwrap()
                .id,
            second.id
        );
    }

    #[test]
    fn attachments_reach_the_agent_and_anything_else_is_named_on_the_card() {
        let w = desk_world();
        let host = host(&w);
        let uploads = host.attachments_dir().unwrap();
        let image = uploads.join(format!("{}-screen shot.png", uuid::Uuid::new_v4()));
        let log = uploads.join(format!("{}-crash.log", uuid::Uuid::new_v4()));
        fs::write(&image, b"png").unwrap();
        fs::write(&log, b"boom").unwrap();
        let outside = w.root.join("secrets.txt");
        fs::write(&outside, b"no").unwrap();
        let mut asked = ask("Mango", "r1");
        asked.attachments = vec![
            image.to_string_lossy().into_owned(),
            log.to_string_lossy().into_owned(),
            outside.to_string_lossy().into_owned(),
            "/nowhere/at/all.png".into(),
        ];
        let record = request(&w.store, &host, source(&w, "chat:desk1"), asked).unwrap();
        let route = record.route.clone().unwrap();
        let names: Vec<_> = route
            .attachments
            .iter()
            .map(|f| (f.name.as_str(), f.image))
            .collect();
        assert_eq!(names, vec![("screen shot.png", true), ("crash.log", false)]);
        let folder = route.folder.clone().unwrap();
        for file in &route.attachments {
            assert!(file.path.starts_with(&folder));
            assert!(Path::new(&file.path).is_file());
            assert!(
                route.message.contains(&file.path),
                "the brief names the copy"
            );
        }
        assert_eq!(route.unreadable.len(), 2);
        assert!(
            route.unreadable[0]
                .problem
                .contains("not a file the person attached"),
            "{:?}",
            route.unreadable
        );
        assert!(proposed_text(&record).contains("2 attachments could not be given"));

        confirm(&w.store, &record.id, &host).unwrap();
        let start = host.starts.lock().unwrap()[0].clone();
        assert_eq!(start.images, vec![route.attachments[0].path.clone()]);
        assert!(
            start.extra_dirs.contains(&folder),
            "the new chat may read its files"
        );
        assert!(
            !start.extra_dirs.iter().any(|d| Path::new(d) == uploads),
            "and nothing else uploaded"
        );
    }

    /// Only a file the person uploaded, by its own name in the uploads folder:
    /// no way out through `..`, a symlink, or a symlinked folder.
    #[cfg(unix)]
    #[test]
    fn an_attachment_cannot_climb_or_link_out_of_the_uploads_folder() {
        let w = desk_world();
        let host = host(&w);
        let uploads = host.attachments_dir().unwrap();
        let secret = w.root.join("secret.txt");
        fs::write(&secret, b"no").unwrap();
        let link = uploads.join(format!("{}-notes.txt", uuid::Uuid::new_v4()));
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let outside_dir = w.root.join("elsewhere");
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(outside_dir.join("key.pem"), b"no").unwrap();
        let linked_dir = uploads.join("folder");
        std::os::unix::fs::symlink(&outside_dir, &linked_dir).unwrap();
        let tries = [
            uploads.join("..").join("secret.txt"),
            link.clone(),
            linked_dir.join("key.pem"),
            uploads.clone(),
        ];
        let mut asked = ask("Mango", "r1");
        asked.attachments = tries
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .chain(["relative.txt".to_owned()])
            .collect();
        let record = request(&w.store, &host, source(&w, "chat:desk1"), asked).unwrap();
        let route = record.route.clone().unwrap();
        assert!(route.attachments.is_empty(), "{:?}", route.attachments);
        assert_eq!(route.unreadable.len(), 5, "{:?}", route.unreadable);
        if let Some(folder) = route.folder.as_deref() {
            assert_eq!(fs::read_dir(folder).map(|d| d.count()).unwrap_or(0), 0);
        }
    }

    #[test]
    fn after_a_restart_a_pending_route_goes_and_a_confirmed_one_is_finished() {
        let w = desk_world();
        let host = host(&w);
        let pending = request(
            &w.store,
            &host,
            source(&w, "chat:desk1"),
            ask("Mango", "r1"),
        )
        .unwrap();
        let confirmed = request(
            &w.store,
            &host,
            source(&w, "chat:desk2"),
            ask("Quill", "r2"),
        )
        .unwrap();
        // Confirmed, then cut off before its chat started.
        *host.fail_start.lock().unwrap() = true;
        assert!(confirm(&w.store, &confirmed.id, &host).is_err());
        let starting = records(&w)
            .into_iter()
            .find(|r| r.id == confirmed.id)
            .unwrap();
        assert_eq!(starting.status, Status::Starting);
        *host.fail_start.lock().unwrap() = false;

        let finished = recover(&w.store, &host).unwrap();
        let left = records(&w);
        assert!(
            !left.iter().any(|r| r.id == pending.id),
            "a card nobody can see is not kept"
        );
        let done = left.iter().find(|r| r.id == confirmed.id).unwrap();
        assert_eq!(done.status, Status::Confirmed);
        assert_eq!(finished, vec![confirmed.id.clone()]);
        assert_eq!(host.starts.lock().unwrap().len(), 1);
        assert!(host.told.lock().unwrap().is_empty());
    }

    #[test]
    fn after_a_restart_a_route_that_cannot_start_says_so_in_its_own_chat() {
        let w = desk_world();
        let host = host(&w);
        let record = request(
            &w.store,
            &host,
            source(&w, "chat:desk1"),
            ask("Quill", "r1"),
        )
        .unwrap();
        *host.fail_start.lock().unwrap() = true;
        assert!(confirm(&w.store, &record.id, &host).is_err());
        let finished = recover(&w.store, &host).unwrap();
        assert!(finished.is_empty());
        let after = records(&w).into_iter().find(|r| r.id == record.id).unwrap();
        assert_eq!(after.status, Status::Abandoned);
        let key = after.target_chat_key.clone().unwrap();
        // Listed, with the failure and the brief written into it.
        assert!(host
            .saved
            .lock()
            .unwrap()
            .iter()
            .any(|m| format!("chat:{}", m.id) == key));
        let failures = host.failures.lock().unwrap().clone();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].0, key);
        assert!(
            failures[0].1.contains("CLI unavailable"),
            "{}",
            failures[0].1
        );
        assert!(
            failures[0].1.contains("Fix the login bug on phones"),
            "{}",
            failures[0].1
        );
        // A second restart does not try again or write it twice.
        recover(&w.store, &host).unwrap();
        assert_eq!(host.failures.lock().unwrap().len(), 1);
    }

    #[test]
    fn giving_up_on_a_route_that_never_started_removes_its_row_and_record() {
        let w = desk_world();
        let host = host(&w);
        let record = request(
            &w.store,
            &host,
            source(&w, "chat:desk1"),
            ask("Quill", "r1"),
        )
        .unwrap();
        *host.fail_start.lock().unwrap() = true;
        assert!(confirm(&w.store, &record.id, &host).is_err());
        let key = records(&w)[0].target_chat_key.clone().unwrap();
        abandon(&w.store, &record.id, &host).unwrap();
        assert!(records(&w).is_empty());
        assert_eq!(
            *host.removed.lock().unwrap(),
            vec![key.trim_start_matches("chat:").to_owned()]
        );
    }

    #[test]
    fn a_routed_chat_has_no_one_to_ask_back() {
        let w = desk_world();
        let host = host(&w);
        let record = request(
            &w.store,
            &host,
            source(&w, "chat:desk1"),
            ask("Mango", "r1"),
        )
        .unwrap();
        let confirmed = confirm(&w.store, &record.id, &host).unwrap();
        let key = confirmed.target_chat_key.unwrap();
        let error = back::report(
            &w.store,
            &key,
            back::Report {
                request_id: "o1".into(),
                status: "done".into(),
                summary: "Fixed".into(),
            },
        )
        .unwrap_err();
        assert!(error.contains("front desk opened this chat"), "{error}");
    }
}

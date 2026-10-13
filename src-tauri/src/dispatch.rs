//! Calling the backend directly, with no webview in the middle.
//!
//! A browser's request used to be handed to the desktop window, which called
//! `invoke` on our behalf and sent the answer back (see the proxy in web.rs).
//! That worked and cost nothing to write, but it made the window load-bearing:
//! no window, no answers.
//!
//! This is the other half of that trade. It is the table the proxy avoided —
//! and it turned out to be a fifth of the size the "106 registered commands"
//! figure suggested, because the v2 client only ever calls twenty of them.
//!
//! Everything here calls the `_impl` functions directly. The split is a leftover
//! of the days when a Tauri command wrapper called the same body — the wrappers
//! are gone, this table is the only caller, and the names stayed because
//! renaming forty functions would say nothing new.
//!
//! ## Argument names
//!
//! The client speaks camelCase because that is what Tauri's own convention
//! taught it (`extraDirs` for a Rust `extra_dirs`). Tauri does the conversion
//! invisibly; here it has to be done on purpose, so `arg` tries the camelCase
//! spelling first and the snake_case one after.
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

#[cfg(test)]
mod plan_tests;
mod pull_requests;

use crate::agent_chat::ChatManager;
use crate::file_watch::FileWatchState;
use crate::git_watch::GitWatchState;
use crate::orchestration::OrchestrationStore;
use crate::pty::PtyManager;
use crate::workspaces::WorkspaceState;

/// Everything a request might need. The same values the Tauri app manages —
/// held by Arc so both can point at one set rather than each having its own.
#[derive(Clone)]
pub struct Services {
    pub workspaces: Arc<WorkspaceState>,
    pub chats: Arc<ChatManager>,
    pub watch: Arc<FileWatchState>,
    /// The fs watcher behind the live git counts and branch chips.
    pub git_watch: Arc<GitWatchState>,
    /// Durable runs, task DAGs, authoritative worker attempts and gates.
    pub orchestrations: Arc<OrchestrationStore>,
    pub ptys: Arc<PtyManager>,
    /// Where handovers are kept and what starts their chats (`handover.rs`).
    pub handovers: crate::handover::Wiring,
}

impl Services {
    /// Load state from disk, as the app does at startup.
    pub fn load() -> Self {
        let question_path = crate::transcript::chats_dir()
            .unwrap_or_else(|| crate::profile::profile_dir().join("chats"))
            .join("questions.json");
        let orchestrations = Arc::new(OrchestrationStore::load_profile());
        // A removal that was interrupted between its two writes: the roster
        // still has the agent, so the ledger stops calling it gone.
        if let Err(error) = orchestrations.reconcile_removed(&crate::team::default_path()) {
            eprintln!("orchestration: removed agents were not checked against the roster: {error}");
        }
        // Banners come from main agents only; the ledger says which chats are
        // a run's workers and whose.
        crate::push::route_workers_through(orchestrations.clone());
        let mut chats = ChatManager::with_saved_questions(question_path);
        chats.orchestrations = orchestrations.clone();
        let chats = Arc::new(chats);
        // Once, before anything below can start a chat: the chats an
        // earlier build opened as read-only discussions go back to their
        // agent's registered access (`handover::lift`).
        crate::handover::lift::at_startup(&orchestrations, &|key| chats.has_process(key));
        // A chat nobody has touched for a quarter of an hour is ended and
        // resumed on its next message. This is where it matters most: the
        // service runs for days, and every chat left open holds an agent and
        // its whole MCP fleet.
        crate::agent_chat::start_idle_reaper(chats.clone());
        crate::agent_chat::start_auto_resume_scheduler(chats.clone());
        let workspaces = Arc::new(WorkspaceState::load());
        crate::orchestration::automation::start_scheduler(
            orchestrations.clone(),
            chats.clone(),
            workspaces.clone(),
        );
        crate::orchestration::environments::start_reconciler(orchestrations.clone());
        // Read the sandbox state once now, so that a sandbox this server
        // did not start itself (one left running by the server before it)
        // can still be stopped if the profile folder goes away before
        // anything else has read it (`sandbox::Store::known`).
        if let Err(why) = crate::sandbox::Store::profile().known() {
            eprintln!("[sandbox] could not read the sandbox state at startup: {why}");
        }
        let services = Self {
            workspaces,
            chats,
            watch: Arc::new(FileWatchState::default()),
            git_watch: Arc::new(GitWatchState::default()),
            orchestrations,
            ptys: Arc::new(PtyManager::default()),
            handovers: crate::handover::Wiring::profile(),
        };
        // What a Stop or an answer could not record is written once the
        // profile folder is back (`settle_owed`).
        #[cfg(not(test))]
        start_owed_saves(services.clone());
        services
    }
}

/// `camelCase` → `snake_case`, for looking a name up both ways.
fn snake(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for ch in name.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// One argument, by either spelling. Missing means `null`, which is how an
/// `Option<T>` argument arrives when the client simply left it out.
fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    let value = args
        .get(name)
        .or_else(|| args.get(snake(name)))
        .cloned()
        .unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|e| {
        crate::outcome::refuse(
            crate::outcome::ReasonClass::Validation,
            format!("bad argument '{name}': {e}"),
        )
    })
}

/// An optional list argument: omitted or null is an empty list. The agent
/// tools advertise such lists (`dependsOn`) as optional with none by default,
/// and a plain `arg::<Vec<_>>` turned the omission into "expected a sequence".
fn list_arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<Vec<T>, String> {
    Ok(arg::<Option<Vec<T>>>(args, name)?.unwrap_or_default())
}

/// A command that answers with nothing.
fn unit(r: Result<(), String>) -> Result<Value, String> {
    r.map(|_| Value::Null)
}

/// A command that answers with something worth serializing.
fn to_value<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|x| serde_json::to_value(x).map_err(|e| e.to_string()))
}

/// Refresh a registered lead's roster on every person-authored turn. The
/// first task already carries the full brief; later live and resumed turns get
/// a compact current roster so edits to the org chart supersede stale history.
fn refresh_lead_turn(svc: &Services, key: &str, text: String) -> Result<String, String> {
    if text.contains(crate::team::BRIEF_MARK)
        || text.trim_start().starts_with('/')
        || crate::team::lead_for_chat(&crate::team::default_path(), key)?.is_none()
    {
        return Ok(text);
    }
    let projects = crate::workspaces::list_workspaces_impl(&svc.workspaces)?
        .into_iter()
        .map(|project| (project.id, project.name))
        .collect::<Vec<_>>();
    crate::team::refresh_turn_brief(&crate::team::default_path(), key, text, &projects)
}

/// Who calls a peer tool, when it is not a worker: the registered lead whose
/// own agents-mode chat `actor` is, with that chat's project and folder.
/// `None` for a worker's chat, which the store identifies by its attempt.
/// Any other chat has no registered agent and is refused.
fn peer_lead(
    svc: &Services,
    team_path: &std::path::Path,
    actor: &str,
) -> Result<Option<crate::orchestration::peer::LeadCaller>, String> {
    if svc.orchestrations.is_worker_chat(actor)? {
        return Ok(None);
    }
    let Some(record) = crate::team::lead_for_chat(team_path, actor)? else {
        return Err(crate::outcome::refuse(
            crate::outcome::ReasonClass::ScopeRefused,
            "Peer tools are for a registered agent: a worker on a running task, or a lead in its own agents-mode chat. This chat is neither.",
        ));
    };
    let (project_id, cwd) =
        crate::orchestration::infer_context(&svc.workspaces, actor, None, None)?;
    Ok(Some(crate::orchestration::peer::LeadCaller {
        agent_id: record.lead_id,
        project_id,
        cwd,
        cross_project: record.cross_project,
    }))
}

/// The first message of a chat that is being started.
enum FirstTurn {
    /// What the person typed, if anything.
    Person(Option<String>),
    /// The host's wrap-up, for a completion of a chat with no process.
    WrapUp(String),
    /// The host telling the agent its plan was started (`chat_plan`), for a
    /// chat with no process.
    PlanStart(String),
}

/// Start a chat's agent from the page's start settings (`args`: `cwd`,
/// `agent`, `model`, `access`, `resume`, `extraDirs`, `env`, `effort`,
/// `lite`, `useSandbox`, `fallbackCwd`). `chat_start` and a completion of a
/// chat that is not running both come through here, so both put a removed
/// folder back first and both start under what that holds.
fn start_chat(
    svc: &Services,
    key: &str,
    args: &Value,
    first: FirstTurn,
    turn_id: String,
) -> Result<(), String> {
    let mut cwd: String = arg(args, "cwd")?;
    let resume: Option<String> = arg(args, "resume")?;
    // A chat outlives the worktree it ran in. Put the folder back, or
    // move the chat to one that exists, before anything reads it: the
    // sandbox below and the launch both need a real directory. It is
    // refused before it changes anything, and what it holds (the
    // workspace lifecycle lock and its claim on the chat) is kept
    // until the chat has been started, further down.
    let held = crate::chat_recover::recover(
        &svc.chats,
        &svc.workspaces,
        key,
        &cwd,
        arg::<Option<String>>(args, "fallbackCwd")?.as_deref(),
    )?;
    if let Some(held) = &held {
        cwd = held.recovery.cwd.clone();
    }
    crate::sandbox::Store::profile().select(
        key,
        &cwd,
        arg(args, "useSandbox")?,
        resume.is_some(),
    )?;
    if let Some(held) = &held {
        held.settle(
            key,
            arg(args, "agent")?,
            resume.as_deref(),
            arg::<Option<std::collections::BTreeMap<String, String>>>(args, "env")?.as_ref(),
        );
    }
    let (prompt, handoff, images, safety_block) = match first {
        FirstTurn::Person(prompt) => {
            if let Some(words) = &prompt {
                svc.chats.note_person_turn(
                    key,
                    &turn_id,
                    words,
                    arg::<Option<_>>(args, "seenPlans")?.unwrap_or_default(),
                );
            }
            (
                prompt
                    .map(|text| refresh_lead_turn(svc, key, text))
                    .transpose()?,
                arg(args, "handoff")?,
                arg(args, "images")?,
                // An outage card's retry: its card stays up until this start
                // has taken the turn (`safety_block::person_turn`).
                arg(args, "safetyBlock")?,
            )
        }
        // The host's own words: no evidence of the person's, no roster
        // brief, nothing attached.
        FirstTurn::WrapUp(text) | FirstTurn::PlanStart(text) => (Some(text), None, None, None),
    };
    let started = crate::agent_chat::chat_start_answering_impl(
        svc.chats.clone(),
        key.to_string(),
        cwd,
        arg(args, "agent")?,
        arg(args, "model")?,
        arg(args, "access")?,
        prompt,
        handoff,
        resume,
        arg(args, "extraDirs")?,
        arg(args, "env")?,
        arg(args, "effort")?,
        images,
        arg(args, "lite")?,
        Some(turn_id),
        safety_block,
    );
    drop(held);
    started
}

/// Why a chat keeps no plan, for the kinds that never do: a worker's task
/// is its plan, and a front desk only routes. By durable identity, like
/// every hook that writes: a worker stays one after its attempt settles.
/// A chat in the trash is refused too. A room seat is refused where its
/// capability is read (`web::plan_handler`): only that says which voice
/// of a chat is calling.
fn plan_chat_refusal(svc: &Services, key: &str) -> Result<Option<&'static str>, String> {
    plan_chat_refusal_in(&svc.orchestrations, &crate::team::default_path(), key)
}

fn plan_chat_refusal_in(
    orchestrations: &OrchestrationStore,
    team: &std::path::Path,
    key: &str,
) -> Result<Option<&'static str>, String> {
    if orchestrations.is_worker_chat(key)? {
        return Ok(Some(
            "A worker's chat keeps no plan: its task is its plan. The plan is the main chat's that coordinates it.",
        ));
    }
    if crate::team::is_front_desk_chat(team, key) {
        return Ok(Some("A front desk only routes. It keeps no plan."));
    }
    let trashed = key.strip_prefix("chat:").is_some_and(|id| {
        crate::chat_index::deleted()
            .iter()
            .any(|chat| chat.id == id)
    });
    Ok(trashed.then_some("This chat is in the trash. Restore it first."))
}

/// A chat's plan as it is answered (`chat_plan::answer`).
fn plan_view(
    svc: &Services,
    chat_id: &str,
    plan: Option<crate::chat_plan::Plan>,
) -> crate::chat_plan::PlanView {
    crate::chat_plan::answer(&svc.orchestrations, chat_id, plan)
}

/// Tell every open page a chat's plan changed.
fn announce_plan(view: &crate::chat_plan::PlanView) {
    crate::bus::emit("chat-plan", json!({ "chatId": view.chat_id, "plan": view }));
}

/// The tasks a change to `key`'s plan links anew: each has to be in the
/// ledger, in a run this chat coordinates.
fn plan_linkable(svc: &Services, key: &str, ids: &[String]) -> Result<(), String> {
    let known = svc
        .orchestrations
        .linked_tasks(ids.iter().map(String::as_str))?;
    for id in ids {
        match known.get(id) {
            None => {
                return Err(format!(
                    "{id} is not a task in the ledger. Link a task by the id orchestration_task_create answered. Nothing was changed."
                ))
            }
            Some(task) if task.coordinator != key => {
                return Err(format!(
                    "{id} is a task of a run another chat coordinates. An item links only to tasks of a run this chat coordinates. Nothing was changed."
                ))
            }
            Some(_) => {}
        }
    }
    Ok(())
}

/// Why a chat cannot be completed, for the kinds that never can: a worker's
/// chat ends with its task, a front desk only routes, and a second voice in
/// a chat is not the chat. By durable identity, like every hook that writes.
fn completion_refusal(svc: &Services, key: &str) -> Result<Option<&'static str>, String> {
    completion_refusal_in(
        &svc.orchestrations,
        &svc.chats,
        &crate::team::default_path(),
        key,
    )
}

fn completion_refusal_in(
    orchestrations: &OrchestrationStore,
    chats: &ChatManager,
    team: &std::path::Path,
    key: &str,
) -> Result<Option<&'static str>, String> {
    if orchestrations.is_worker_chat(key)? {
        return Ok(Some(
            "A worker's chat ends with its task. Complete the main chat that coordinates it.",
        ));
    }
    if crate::team::is_front_desk_chat(team, key) {
        return Ok(Some(
            "A front desk only routes. There is nothing in it to complete.",
        ));
    }
    if !crate::agent_chat::is_own_voice(chats, key) {
        return Ok(Some("Only a chat's own agent can be completed."));
    }
    let listed = key.strip_prefix("chat:").is_some_and(|id| {
        crate::chat_index::list()
            .iter()
            .any(|chat| chat.id == id && chat.deleted_at.is_none())
    });
    Ok((!listed).then_some("This chat is not in the active chat index."))
}

/// The runs a chat coordinates that have not ended, and whether it is a
/// registered agent's: the two things the wrap-up's wording turns on.
fn completion_wrap_up(svc: &Services, key: &str) -> Result<String, String> {
    if let Some(refusal) = completion_refusal(svc, key)? {
        return Err(refusal.into());
    }
    let runs: Vec<String> = svc
        .orchestrations
        .coordinated_runs(key)?
        .into_iter()
        .filter(|run| run.live)
        .map(|run| run.run_id)
        .collect();
    let registered = crate::team::identity(&crate::team::default_path(), key, None).is_ok();
    Ok(crate::agent_chat::wrap_up_message(registered, &runs))
}

/// `chat_complete_preview`: what the host knows about a chat before its
/// completion is confirmed. Git is asked through `chat_task`; nothing is
/// asked of the agent and nothing goes on the network.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletionPreview {
    chat_key: String,
    /// Why this chat cannot be completed. Absent when it can.
    #[serde(skip_serializing_if = "Option::is_none")]
    refusal: Option<String>,
    /// The wrap-up turn of a completion already under way.
    #[serde(skip_serializing_if = "Option::is_none")]
    completing_turn_id: Option<String>,
    /// The chat has a live process. Without one `chat_complete` needs `start`.
    running: bool,
    /// A registered agent's chat: the wrap-up asks it to save its memory.
    registered_agent: bool,
    /// Branch, worktree or primary checkout, changed files.
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<crate::chat_task::Workspace>,
    /// Target branch, uncommitted files, merged or not.
    #[serde(skip_serializing_if = "Option::is_none")]
    delivery: Option<crate::chat_task::Delivery>,
    /// The runs this chat coordinates: still running, or a mission not yet
    /// closed, each with whether Close would go through.
    runs: Vec<crate::orchestration::mission::CoordinatedRun>,
}

fn completion_preview(svc: &Services, key: &str) -> Result<CompletionPreview, String> {
    let refusal = completion_refusal(svc, key)?.map(str::to_string);
    let status = key.strip_prefix("chat:").and_then(|id| {
        crate::chat_task::chat_task_impl(id.to_string(), true)
            .inspect_err(|error| eprintln!("[chat] no task status for {key}: {error}"))
            .ok()
    });
    let (workspace, delivery) = status
        .map(|status| (status.workspace, status.delivery))
        .unwrap_or_default();
    Ok(CompletionPreview {
        chat_key: key.to_string(),
        refusal,
        completing_turn_id: svc.chats.completing_turn(key),
        running: svc.chats.has_process(key),
        registered_agent: crate::team::identity(&crate::team::default_path(), key, None).is_ok(),
        workspace,
        delivery,
        runs: svc.orchestrations.coordinated_runs(key)?,
    })
}

/// Run one command. `Err` is the message the client shows, so it is written for
/// a person rather than a log.
/// Who a task goes to and where it runs, as the host decides it from what
/// the lead asked for. Agents mode: a lead names a registered agent and the
/// host, not the lead, turns it into worker settings.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn route_task(
    svc: &Services,
    actor: &str,
    run_id: &str,
    parent: Option<&str>,
    requested: Option<String>,
    project: Option<String>,
    repository: Option<String>,
    mut worker: Option<crate::orchestration::automation::WorkerSettings>,
) -> Result<
    (
        Option<crate::orchestration::automation::WorkerSettings>,
        Option<crate::orchestration::TaskAssignee>,
        Option<crate::orchestration::TaskDestination>,
    ),
    String,
> {
    let team_path = crate::team::default_path();
    let (run_project, coordinator) = svc.orchestrations.run_owner(run_id)?;
    // Whose direct reports this task may go to: the lead's when the
    // coordinator of an agents-mode run creates it, the manager's when
    // a second-level worker splits its own task.
    let (manager, cross_project, parent_destination) = if actor != coordinator {
        match parent {
            Some(parent) => {
                let (assignee, destination) = svc.orchestrations.task_route(parent)?;
                (assignee.map(|a| a.id), false, destination)
            }
            None => (None, false, None),
        }
    } else {
        match crate::team::lead_for_chat(&team_path, actor)? {
            Some(lead) => (Some(lead.lead_id), lead.cross_project, None),
            None => (None, false, None),
        }
    };
    let requested = requested.filter(|who| !who.trim().is_empty());
    if manager.is_some() && requested.is_none() {
        return Err("Assign this task to one of your direct reports with `assignee`.".into());
    }
    let routed = crate::orchestration::destination::route(
        &crate::team::list(&team_path, None, true)?,
        &crate::workspaces::list_workspaces_impl(&svc.workspaces)?,
        &crate::orchestration::destination::Route {
            who: requested.as_deref(),
            project: project.as_deref(),
            repository: repository.as_deref(),
            manager: manager.as_deref(),
            cross_project,
            run_project: &run_project,
            parent: parent_destination.as_ref(),
        },
    )?;
    let assignee = match routed.assignee {
        Some(agent) => {
            worker = Some(crate::orchestration::automation::WorkerSettings {
                agent: agent.agent,
                access: agent.access,
                model: Some(agent.model.clone()),
                effort: agent.effort.clone(),
                recovery: worker.and_then(|w| w.recovery),
            });
            Some(crate::orchestration::TaskAssignee {
                id: agent.id,
                name: agent.name,
            })
        }
        None => None,
    };
    Ok((worker, assignee, routed.destination))
}

#[cfg(test)]
impl Services {
    /// The stores a server reads at startup, from the profile folder this
    /// thread started in, and none of its background threads: a sweeper on a
    /// thread of its own is another process as far as a test's profile goes.
    /// Calling it again is what a restart reads.
    pub(crate) fn at_profile() -> Self {
        let orchestrations = Arc::new(OrchestrationStore::load_profile());
        let mut chats = ChatManager::with_saved_questions(
            crate::profile::profile_dir()
                .join("chats")
                .join("questions.json"),
        );
        chats.orchestrations = orchestrations.clone();
        Self {
            workspaces: Arc::new(WorkspaceState::with_projects(Vec::new())),
            chats: Arc::new(chats),
            watch: Arc::new(FileWatchState::default()),
            git_watch: Arc::new(GitWatchState::default()),
            orchestrations,
            ptys: Arc::new(PtyManager::default()),
            handovers: crate::handover::Wiring::scratch(),
        }
    }
}

/// A command's answer, and what it did that could not be recorded.
pub struct Told {
    pub result: Result<Value, String>,
    /// Empty for almost every call. See `unsaved.rs`.
    pub unsaved: Vec<crate::unsaved::Unsaved>,
}

/// `dispatch`, with what the command could not record beside its answer.
/// Both transports answer through this: an action that happened is not
/// reported as failed because its record could not be written.
pub fn told(svc: &Services, cmd: &str, args: Value) -> Told {
    let (result, unsaved) = crate::unsaved::told(|| dispatch(svc, cmd, args));
    Told { result, unsaved }
}

/// Try again every save an ending or answering action could not make, and
/// name the stores that still owe one.
///
/// A store whose save failed keeps what it could not write and a flag that
/// it owes it. This writes each such store again, whole. With nothing owed
/// it is a lock and a flag per store, and with the folder still away the
/// write fails as it did and nothing is made.
pub fn settle_owed(svc: &Services) -> Vec<&'static str> {
    let mut owed = crate::agent_chat::settle_owed(&svc.chats);
    if svc.orchestrations.settle_owed().is_err() {
        owed.push(crate::orchestration::OWED);
    }
    if crate::sandbox::Store::profile().settle().is_err() {
        owed.push(crate::sandbox::OWED);
    }
    owed
}

/// The stores `settle_owed` would write, without writing them.
fn owed(svc: &Services) -> Vec<&'static str> {
    let mut owed = crate::agent_chat::owed(&svc.chats);
    if svc.orchestrations.owes() {
        owed.push(crate::orchestration::OWED);
    }
    if crate::sandbox::Store::profile().owes() {
        owed.push(crate::sandbox::OWED);
    }
    owed
}

/// How often `settle_owed` is tried. It is the longest a save can stay
/// owed once the profile folder is back.
#[cfg(not(test))]
const OWED_SWEEP: std::time::Duration = std::time::Duration::from_secs(2);

/// Make good, for as long as the server runs, every save an ending or
/// answering action could not make. Not started under test: a thread of
/// its own is another process as far as a test's profile folder goes, and
/// a test calls `settle_owed` itself.
#[cfg(not(test))]
fn start_owed_saves(svc: Services) {
    std::thread::spawn(move || {
        let mut still: Vec<&'static str> = Vec::new();
        loop {
            std::thread::sleep(OWED_SWEEP);
            let owed = settle_owed(&svc);
            // And what could not be STARTED while the folder was away: the
            // first message of each queue a Stop left waiting.
            crate::agent_chat::start_waiting_queues(&svc.chats);
            if owed != still {
                if owed.is_empty() {
                    println!("[unsaved] everything that was owed is on disk now");
                } else {
                    println!(
                        "[unsaved] still owed to the profile folder: {}",
                        owed.join(", ")
                    );
                }
                still = owed;
            }
        }
    });
}

pub fn dispatch(svc: &Services, cmd: &str, args: Value) -> Result<Value, String> {
    let git_write_path = match cmd {
        "git_commit" | "git_push" | "git_pull" | "git_switch_branch" => {
            Some(arg::<String>(&args, "root")?)
        }
        "git_prepare_chat_workspace" if !arg::<bool>(&args, "newWorktree")? => {
            Some(arg::<String>(&args, "path")?)
        }
        _ => None,
    };
    let _workspace_git_guard = git_write_path
        .as_deref()
        .map(|path| svc.orchestrations.guard_git_operation(path))
        .transpose()?;

    // Browser-facing mutation routes never drive an orchestration worker.
    // The coordinator's internal launch/message/report paths call their
    // implementations directly, without a client-controlled bypass flag.
    match cmd {
        // A worker's test environment outlives its turns on purpose, so once
        // its attempt has settled the person can start, check, stop or reset
        // it from the Sandbox panel to inspect it; that no longer drives the
        // worker, and starting holds it against the host's lifecycle until
        // they stop it. A live worker's stays out of reach, like everything
        // else a worker owns.
        "sandbox_action"
            if matches!(
                arg::<String>(&args, "action")?.as_str(),
                "start" | "check" | "stop" | "reset"
            ) && svc
                .orchestrations
                .worker_card_live(&arg::<String>(&args, "key")?)?
                == Some(false) => {}
        "chat_start"
        | "sandbox_action"
        | "chat_send"
        | "chat_cancel_auto_resume"
        | "chat_cancel_queued"
        | "chat_dismiss_unsent"
        | "chat_start_queued"
        | "chat_interrupt"
        | "chat_set_access"
        | "chat_stop"
        | "chat_retarget"
        | "chat_restart"
        | "chat_forget" => {
            svc.orchestrations
                .require_user_chat(&arg::<String>(&args, "key")?)?;
            if cmd == "chat_start" {
                if let Some(resume) = arg::<Option<String>>(&args, "resume")? {
                    svc.chats.require_user_resume(&resume)?;
                }
            }
        }
        "chat_index_remove" => {
            svc.orchestrations
                .require_user_chat(&format!("chat:{}", arg::<String>(&args, "id")?))?;
            svc.orchestrations
                .require_user_chat(&arg::<String>(&args, "key")?)?;
        }
        "question_answer" | "question_answer_batch" | "question_retry" | "question_cancel" => {
            let ids: Vec<String> = match cmd {
                "question_answer" => vec![arg(&args, "id")?],
                "question_answer_batch" => {
                    arg::<Vec<crate::question_store::Answer>>(&args, "answers")?
                        .into_iter()
                        .map(|answer| answer.id)
                        .collect()
                }
                _ => arg(&args, "ids")?,
            };
            for question in svc.chats.questions.pending()? {
                if ids.contains(&question.id) {
                    if let Some(key) = &question.question.chat_key {
                        svc.orchestrations.require_user_chat(key)?;
                    }
                }
            }
        }
        _ => {}
    }
    match cmd {
        // The profile folder this server fixed at startup: its path, the
        // configured base it fell back from (if it did), whether it is
        // there now, and the sentence to show when either is not as
        // configured. Read-only.
        // `owed` names the stores that hold something a Stop or an answer
        // could not write (`unsaved.rs`): empty when the disk has caught up.
        "profile_status" => {
            let mut status = crate::profile::status();
            status["owed"] = json!(owed(svc));
            Ok(status)
        }
        // ---- projects -----------------------------------------------------
        "feedback_list" => crate::feedback::Store::profile().list(
            serde_json::from_value(args).map_err(|e| format!("Invalid feedback filter: {e}"))?,
        ),
        "feedback_get" => {
            to_value(crate::feedback::Store::profile().get(&arg::<String>(&args, "id")?))
        }
        "feedback_update" => to_value(crate::feedback::Store::profile().update(
            serde_json::from_value(args).map_err(|e| format!("Invalid feedback update: {e}"))?,
        )),
        "feedback_agent" => crate::feedback::agent_call(
            svc,
            &arg::<String>(&args, "chatKey")?,
            &arg::<String>(&args, "action")?,
            arg(&args, "args")?,
        ),
        // Browser-only: no agent hook reaches this table.
        "personal_preferences" => to_value(crate::personal_preferences::load(
            &crate::personal_preferences::default_path(),
        )),
        "personal_preferences_set" => to_value(crate::personal_preferences::save(
            &crate::personal_preferences::default_path(),
            &arg::<Option<String>>(&args, "text")?.unwrap_or_default(),
        )),
        "memory_vault_settings" => to_value(crate::memory_vault::Vault::profile().settings()),
        "memory_vault_configure" => {
            to_value(crate::memory_vault::Vault::profile().configure(arg(&args, "config")?))
        }
        "memory_vault_call" => crate::memory_vault::Vault::profile().call(
            "browser",
            &arg::<String>(&args, "action")?,
            &arg::<Value>(&args, "args")?,
        ),
        "memory_vault_agent" => {
            let key: String = arg(&args, "chatKey")?;
            let id = key.strip_prefix("chat:").unwrap_or(&key);
            if !crate::chat_index::list()
                .iter()
                .any(|chat| chat.id == id && chat.deleted_at.is_none())
            {
                return Err("This chat is not in the active chat index.".into());
            }
            let action: String = arg(&args, "action")?;
            // Agents mode: an agent's own memory. Identity comes from the chat,
            // never from the tool's arguments.
            if let Some(op) = action.strip_prefix("agent_memory_") {
                // Identity comes from the chat, never from the tool's
                // arguments; an append's outcome is shown in the chat by the
                // host (see memory_activity).
                return crate::memory_activity::agent_memory(
                    &crate::memory_vault::Vault::profile(),
                    &crate::team::default_path(),
                    &svc.orchestrations,
                    &format!("chat:{id}"),
                    op,
                    &arg::<Value>(&args, "args")?,
                );
            }
            let mut result = crate::memory_vault::Vault::profile().call(
                &format!("chat:{id}"),
                &action,
                &arg::<Value>(&args, "args")?,
            );
            if let (Ok(receipt), "receipt") = (&mut result, action.as_str()) {
                let recorded = crate::memory_activity::receipt_checked(
                    &svc.orchestrations,
                    &format!("chat:{id}"),
                    receipt,
                );
                if let Some(problem) = recorded.problem() {
                    receipt["chatLine"] = problem.into();
                }
            }
            result
        }
        "list_workspaces" => to_value(crate::workspaces::list_workspaces_impl(&svc.workspaces)),
        "add_workspace" => to_value(crate::workspaces::add_workspace_impl(
            &svc.workspaces,
            arg(&args, "name")?,
            arg(&args, "primaryPath")?,
        )),
        "rename_workspace" => unit(crate::workspaces::rename_workspace_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "name")?,
        )),
        "delete_workspace" => unit(crate::workspaces::delete_workspace_impl(
            &svc.workspaces,
            arg(&args, "id")?,
        )),
        "set_primary_path" => unit(crate::workspaces::set_primary_path_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "path")?,
        )),
        "add_workspace_path" => unit(crate::workspaces::add_workspace_path_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "path")?,
        )),
        "remove_workspace_path" => unit(crate::workspaces::remove_workspace_path_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "path")?,
        )),
        "set_description" => unit(crate::workspaces::set_description_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "description")?,
        )),
        "set_workspace_color" => unit(crate::workspaces::set_workspace_color_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "color")?,
        )),
        "set_workspace_initial" => unit(crate::workspaces::set_workspace_initial_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "initial")?,
        )),
        "set_workspace_icon" => unit(crate::workspaces::set_workspace_icon_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "icon")?,
        )),
        "set_workspace_env" => unit(crate::workspaces::set_workspace_env_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "env")?,
        )),
        "set_workspace_shelved" => unit(crate::workspaces::set_workspace_shelved_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "shelved")?,
        )),
        "reorder_workspaces" => unit(crate::workspaces::reorder_workspaces_impl(
            &svc.workspaces,
            arg(&args, "orderedIds")?,
        )),
        "set_workspace_sibling" => unit(crate::workspaces::set_workspace_sibling_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "siblingId")?,
            arg(&args, "linked")?,
        )),

        // ---- saved commands -----------------------------------------------
        // A project's own commands — `pnpm dev`, `cargo test` — kept on the
        // backend rather than in a browser's storage, because the folder they
        // run in is the backend's and the phone that opens the project later
        // should offer the same list as the laptop that wrote it. They come
        // back with the project itself, on `list_workspaces`.
        "add_action" => to_value(crate::workspaces::add_action_impl(
            &svc.workspaces,
            arg(&args, "workspaceId")?,
            arg(&args, "label")?,
            arg(&args, "command")?,
        )),
        "update_action" => unit(crate::workspaces::update_action_impl(
            &svc.workspaces,
            arg(&args, "workspaceId")?,
            arg(&args, "actionId")?,
            arg(&args, "label")?,
            arg(&args, "command")?,
        )),
        "delete_action" => unit(crate::workspaces::delete_action_impl(
            &svc.workspaces,
            arg(&args, "workspaceId")?,
            arg(&args, "actionId")?,
        )),

        // ---- chats --------------------------------------------------------
        "sandbox_snapshot" => to_value(crate::sandbox::Store::profile().snapshot_probed()),
        "sandbox_configure" => {
            to_value(crate::sandbox::Store::profile().configure(arg(&args, "enabled")?))
        }
        "sandbox_action" => {
            let key: String = arg(&args, "key")?;
            let action: String = arg(&args, "action")?;
            let confirmation: Option<String> = arg(&args, "confirmation")?;
            to_value(
                crate::sandbox::Store::profile()
                    .person_action(&key, &action, confirmation.as_deref(), || {
                        crate::agent_chat::end_idle_for_sandbox(&svc.chats, &key)
                    })
                    .map(crate::sandbox::Environment::public),
            )
        }
        "chat_start" => {
            // Said first, before the roster is read for the turn: a start
            // whose record cannot be kept is refused in the profile's words.
            crate::profile::available()?;
            let key: String = arg(&args, "key")?;
            let turn_id = crate::agent_chat::fresh_turn_id(arg(&args, "turnId")?);
            let prompt: Option<String> = arg(&args, "prompt")?;
            unit(start_chat(
                svc,
                &key,
                &args,
                FirstTurn::Person(prompt),
                turn_id,
            ))
        }
        // Complete a chat: the host's wrap-up turn, then done and stopped
        // (`agent_chat::chat_complete_impl`). The page's command and nobody
        // else's: no hook routes here and the MCP server has no such tool.
        "chat_complete" => {
            crate::profile::available()?;
            let key: String = arg(&args, "chatKey")?;
            let text = completion_wrap_up(svc, &key)?;
            if let Some(completing) =
                crate::agent_chat::chat_complete_impl(&svc.chats, &key, &text)?
            {
                return to_value(Ok::<_, String>(completing));
            }
            // No process: start the chat with the wrap-up as its first
            // message, the way a send to a chat that is not running starts
            // it, removed folder and all. The page sends the settings it
            // would start the chat with, under `start`.
            let start = args
                .get("start")
                .filter(|start| start.is_object())
                .ok_or_else(|| crate::agent_chat::completion_needs_start(&key))?;
            if let Some(resume) = arg::<Option<String>>(start, "resume")? {
                svc.chats.require_user_resume(&resume)?;
            }
            let turn_id = svc.chats.claim_completion(&key)?;
            let started = start_chat(svc, &key, start, FirstTurn::WrapUp(text), turn_id.clone());
            svc.chats
                .settle_claimed_completion(&key, &turn_id, &started);
            started?;
            Ok(json!({ "turnId": turn_id, "state": "started" }))
        }
        // What the host already knows about a chat that is about to be
        // completed, for the page's confirm dialog. Read-only.
        "chat_complete_preview" => {
            let key: String = arg(&args, "chatKey")?;
            to_value(completion_preview(svc, &key))
        }
        // ---- a chat's plan (`chat_plan.rs`) ---------------------------------
        // What the page reads: the agent's list, the person's Start, and how
        // each item's linked tasks stand in the ledger right now.
        "chat_plan_get" => {
            let chat_id: String = arg(&args, "chatId")?;
            let plan = crate::chat_plan::get(&chat_id)?;
            to_value(Ok::<_, String>(plan_view(svc, &chat_id, plan)))
        }
        // The agent's change, from `/hook/plan` and nowhere else: the
        // socket refuses it (`web::CHAT_ONLY_COMMANDS`), because it records
        // the chat's agent as its author.
        "chat_plan_update" => {
            let chat_id: String = arg(&args, "chatId")?;
            let key = format!("chat:{chat_id}");
            if let Some(refusal) = plan_chat_refusal(svc, &key)? {
                return Err(crate::outcome::refuse(
                    crate::outcome::ReasonClass::ScopeRefused,
                    refusal,
                ));
            }
            let change: crate::chat_plan::Change =
                serde_json::from_value(args.get("change").cloned().unwrap_or(Value::Null))
                    .map_err(|error| {
                        crate::outcome::refuse(
                            crate::outcome::ReasonClass::Validation,
                            format!("Those arguments are not valid: {error}"),
                        )
                    })?;
            let by = crate::team::identity(&crate::team::default_path(), &key, None)
                .map(|(me, _)| me.name)
                .unwrap_or_else(|_| "agent".into());
            let updated = crate::chat_plan::update(&chat_id, &by, change, |ids| {
                plan_linkable(svc, &key, ids)
            })?;
            let view = plan_view(svc, &chat_id, Some(updated.plan));
            if updated.changed {
                announce_plan(&view);
            }
            let mut answer = serde_json::to_value(&view).map_err(|e| e.to_string())?;
            answer["changed"] = Value::Bool(updated.changed);
            Ok(answer)
        }
        // The person's Start. The page's command and nobody else's: no hook
        // routes here and the MCP server has no such tool. Its point is the
        // record, so it is save-first: recorded, then the agent is told, and
        // refused whole when it cannot be recorded.
        "chat_plan_start" => {
            crate::profile::available()?;
            let chat_id: String = arg(&args, "chatId")?;
            let revision: u64 = arg(&args, "revision")?;
            let key = format!("chat:{chat_id}");
            if let Some(refusal) = plan_chat_refusal(svc, &key)? {
                return Err(refusal.into());
            }
            // A plan that is started is never started again. Asked of one
            // whose agent has its turn, this answers that and sends nothing.
            // Asked of one whose turn could not be handed over, it is the
            // page asking again: the turn is tried once more and the Start
            // as it was recorded (when, on which revision) is not touched.
            let before = crate::chat_plan::get(&chat_id)?;
            let again = before.as_ref().is_some_and(|plan| plan.started.is_some());
            if let Some(started) = before.as_ref().and_then(|plan| plan.started.as_ref()) {
                if started.told {
                    let turn_id = started.turn_id.clone();
                    return Ok(json!({
                        "plan": plan_view(svc, &chat_id, before),
                        "turnId": turn_id, "delivered": true, "state": "told",
                    }));
                }
            } else {
                crate::chat_plan::startable(&chat_id, revision)?;
            }
            // As for a completion: a chat with no process is started with
            // the host's turn as its first message, from the settings the
            // page would start it with. Asked before anything is recorded,
            // so the page can ask again with `start`.
            let start = args.get("start").filter(|start| start.is_object());
            if !svc.chats.takes_turns(&key) {
                let start = start.ok_or_else(|| crate::agent_chat::completion_needs_start(&key))?;
                if let Some(resume) = arg::<Option<String>>(start, "resume")? {
                    svc.chats.require_user_resume(&resume)?;
                }
            }
            // A turn id of its own for every try: one that failed may have
            // left its line in the record, and a send under the same id
            // would be taken for a retry of a send that got through.
            let turn_id = crate::chat_plan::start_turn_id();
            let plan = match before {
                Some(plan) if again => plan,
                _ => {
                    let plan = crate::chat_plan::start(&chat_id, revision, &turn_id)?;
                    announce_plan(&plan_view(svc, &chat_id, Some(plan.clone())));
                    plan
                }
            };
            let text = crate::chat_plan::start_message(&plan);
            // Recorded. From here the Start stands whatever becomes of the
            // turn: one that cannot be handed over is said beside the
            // answer, never instead of it.
            let handed =
                match crate::agent_chat::chat_host_turn_impl(&svc.chats, &key, &text, &turn_id) {
                    Ok(Some(state)) => Ok(state),
                    Ok(None) => match start {
                        Some(start) => start_chat(
                            svc,
                            &key,
                            start,
                            FirstTurn::PlanStart(text),
                            turn_id.clone(),
                        )
                        .map(|()| "started"),
                        None => Err(crate::agent_chat::completion_needs_start(&key)),
                    },
                    Err(why) => Err(why),
                };
            Ok(match handed {
                Ok(state) => {
                    // The agent has the turn. That it was told is a record
                    // of something that happened: when it cannot be kept it
                    // is said beside the answer, and the page may ask again.
                    let plan = crate::chat_plan::told(&chat_id, &turn_id).unwrap_or_else(|why| {
                        crate::unsaved::say("that the agent was told its plan was started", why);
                        plan
                    });
                    let view = plan_view(svc, &chat_id, Some(plan));
                    announce_plan(&view);
                    json!({ "plan": view, "turnId": turn_id, "delivered": true, "state": state })
                }
                Err(why) => json!({
                    "plan": plan_view(svc, &chat_id, Some(plan)),
                    "turnId": turn_id, "delivered": false, "notDelivered": why,
                }),
            })
        }
        "chat_send" => {
            crate::profile::available()?;
            let key: String = arg(&args, "key")?;
            let words: String = arg(&args, "text")?;
            let record_user: Option<bool> = arg(&args, "recordUser")?;
            // The person's own words and the plans on their screen, kept by
            // turn id before the text is dressed for the agent. This is the
            // only evidence `orchestration_plan_approve_in_chat` accepts.
            let given: Option<String> = arg(&args, "turnId")?;
            let turn_id =
                (record_user != Some(false)).then(|| crate::agent_chat::fresh_turn_id(given));
            if let Some(turn_id) = &turn_id {
                svc.chats.note_person_turn(
                    &key,
                    turn_id,
                    &words,
                    arg::<Option<_>>(&args, "seenPlans")?.unwrap_or_default(),
                );
            }
            let text = refresh_lead_turn(svc, &key, words)?;
            unit(crate::agent_chat::chat_send_answering_impl(
                svc.chats.clone(),
                key,
                text,
                arg(&args, "images")?,
                arg(&args, "to")?,
                turn_id,
                record_user,
                arg(&args, "safetyBlock")?,
            ))
        }
        "chat_cancel_auto_resume" => to_value(crate::agent_chat::chat_cancel_auto_resume_impl(
            &svc.chats,
            arg(&args, "key")?,
        )),
        // Take back a message the agent has not been given yet. Answers
        // `false` when it was already handed over, which the page needs: the
        // bubble stays, because an answer to it is on its way.
        "chat_cancel_queued" => to_value(crate::agent_chat::chat_cancel_queued_impl(
            &svc.chats,
            arg(&args, "key")?,
            arg(&args, "turnId")?,
        )),
        // Permanently hide a prompt that queue reconciliation established was
        // lost. This is distinct from taking back a live queued message: its
        // words stay out of the composer and the dismissal survives replay.
        "chat_dismiss_unsent" => to_value(crate::agent_chat::chat_dismiss_unsent_impl(
            &svc.chats,
            arg(&args, "key")?,
            arg(&args, "turnId")?,
        )),
        // Make one selected queued message the next turn, without discarding
        // anything else the person already sent.
        "chat_start_queued" => to_value(crate::agent_chat::chat_start_queued_impl(
            &svc.chats,
            arg(&args, "key")?,
            arg(&args, "turnId")?,
        )),
        // The Stop button. Answers `{ stopped, waiting, notStarted? }`: a
        // Stop that stopped the agent is not an error because the message
        // queued behind it could not start (`agent_chat::Stopped`).
        "chat_interrupt" => to_value(crate::agent_chat::chat_interrupt_impl(
            &svc.chats,
            arg(&args, "key")?,
        )),
        "chat_set_access" => unit(crate::agent_chat::chat_set_access_impl(
            &svc.chats,
            arg(&args, "key")?,
            arg(&args, "access")?,
        )),
        "chat_stop" => unit(crate::agent_chat::chat_stop_impl(
            &svc.chats,
            arg(&args, "key")?,
        )),
        // Replace the provider behind one user conversation. Unlike
        // `chat_stop`, a model switch keeps standing permissions; unlike
        // `chat_restart`, the old provider's start context must not be
        // resumable while the browser prepares its handoff.
        "chat_retarget" => unit(crate::agent_chat::chat_retarget_impl(
            &svc.chats,
            arg(&args, "key")?,
        )),
        // A fresh process for a conversation that carries on: the only way a
        // chat already open picks up an MCP server or a plugin added since it
        // started.
        "chat_restart" => to_value(crate::agent_chat::chat_restart_impl(
            &svc.chats,
            arg(&args, "key")?,
        )),
        "chat_list" => to_value(crate::agent_chat::chat_list_impl(&svc.chats)),
        "chat_activity" => to_value(crate::agent_chat::chat_activity_impl(&svc.chats)),
        "chat_queue_state" => to_value(crate::agent_chat::chat_queue_state_impl(
            &svc.chats,
            &arg::<String>(&args, "key")?,
        )),
        // A record read from a profile folder that is not there is not a
        // conversation with nothing in it: the page gets the reason, and
        // keeps what it has drawn.
        "chat_since" => {
            crate::profile::available()?;
            Ok(json!(crate::agent_chat::chat_since(
                arg(&args, "key")?,
                arg(&args, "after")?,
            )))
        }
        "chat_page" => {
            crate::profile::available()?;
            to_value(crate::transcript::page(
                &arg::<String>(&args, "key")?,
                arg(&args, "before")?,
            ))
        }
        // The list the page draws first, before it has read the ledger. A
        // chat that coordinates a run the person has not archived says so
        // (`coordinatesRun: true`), so the page can hold the run column
        // open from its first paint. Derived here from the ledger for each
        // answer; the index stores nothing of it, and `chat_index_save`
        // ignores it coming back.
        "chat_index_list" => {
            // A profile folder that is away is not a list with no chats in
            // it: the page gets the reason, and keeps the list it has.
            crate::profile::available()?;
            let coordinating = svc.orchestrations.coordinating_chats();
            let mut chats = json!(crate::agent_chat::chat_index_list());
            for chat in chats.as_array_mut().into_iter().flatten() {
                let coordinates = chat["id"]
                    .as_str()
                    .is_some_and(|id| coordinating.contains(&format!("chat:{id}")));
                if coordinates {
                    chat["coordinatesRun"] = json!(true);
                }
            }
            Ok(chats)
        }
        "chat_index_deleted" => {
            crate::profile::available()?;
            Ok(json!(crate::agent_chat::chat_index_deleted()))
        }
        // Where this chat is and what became of its work. The report half is
        // whatever the agent last said; everything else is checked with git on
        // the way out (`chat_task.rs`).
        "chat_task" => to_value(crate::chat_task::chat_task_impl(
            arg(&args, "chatId")?,
            arg::<Option<bool>>(&args, "refresh")?.unwrap_or(false),
        )),
        "chat_task_report" => {
            let status = crate::chat_task::chat_task_report_impl(
                arg(&args, "chatId")?,
                arg(&args, "objective")?,
                arg::<Option<String>>(&args, "nextStep")?.unwrap_or_default(),
                arg::<Option<Vec<crate::chat_task::TaskStep>>>(&args, "steps")?.unwrap_or_default(),
                arg::<Option<String>>(&args, "reportedBy")?.unwrap_or_default(),
            )?;
            if let Some(report) = &status.report {
                let summary = report
                    .steps
                    .iter()
                    .find(|s| s.state == "active")
                    .map(|s| s.title.as_str())
                    .unwrap_or(&report.next_step);
                svc.orchestrations.observe_worker_event(
                    &format!("chat:{}", status.chat_id),
                    &json!({"type":"octiq.progress", "summary": summary}),
                )?;
            }
            to_value(Ok(status))
        }
        "chat_task_set_target" => to_value(crate::chat_task::chat_task_set_target_impl(
            arg(&args, "chatId")?,
            arg(&args, "branch")?,
            arg::<Option<String>>(&args, "setBy")?.unwrap_or_default(),
        )),
        "chat_task_set_release_check" => {
            to_value(crate::chat_task::chat_task_set_release_check_impl(
                arg(&args, "projectId")?,
                arg(&args, "reference")?,
                arg(&args, "command")?,
            ))
        }
        "chat_search" => to_value(crate::chat_search::search(
            &svc.workspaces,
            arg(&args, "query")?,
            arg(&args, "limit")?,
        )),
        // The agents' OWN past sessions, for the search that resumes one.
        "agent_history_list" => Ok(json!(crate::agent_history::agent_history_list(arg(
            &args, "limit"
        )?))),
        // What was SAID in one of them, so it can be read before it is picked
        // up. The events come back in the shape the chat reducer already folds.
        "agent_history_read" => Ok(json!(crate::agent_history::agent_history_read(
            arg(&args, "agent")?,
            arg(&args, "sessionId")?,
        )?)),
        // Picking one up into a chat: its history becomes the start of the
        // chat's record, so reopening the chat shows it before anything has
        // been said there.
        "agent_history_import" => to_value(crate::agent_history::agent_history_import(
            arg(&args, "key")?,
            arg(&args, "agent")?,
            arg(&args, "sessionId")?,
        )),
        "chat_index_save" => unit(crate::agent_chat::chat_index_save(arg(&args, "meta")?)),
        "chat_set_agent_title" => to_value(crate::agent_chat::chat_set_agent_title(
            arg(&args, "chatId")?,
            arg(&args, "title")?,
        )),
        "chat_mark_read" => unit(crate::agent_chat::chat_mark_read(
            arg(&args, "id")?,
            arg(&args, "at")?,
        )),
        "chat_set_done" => unit(crate::agent_chat::chat_set_done(
            arg(&args, "id")?,
            arg(&args, "at")?,
        )),
        "chat_index_remove" => {
            let id: String = arg(&args, "id")?;
            crate::agent_chat::chat_index_remove(
                id.clone(),
                arg(&args, "key")?,
                arg(&args, "expectedGeneration")?,
                arg(&args, "meta")?,
            )?;
            // An old delete retried after restore is a no-op, including for
            // questions in the restored chat.
            if crate::chat_index::deleted()
                .iter()
                .any(|meta| meta.id == id)
            {
                crate::agent_chat::chat_stop_impl(&svc.chats, format!("chat:{id}"))?;
            }
            Ok(Value::Null)
        }
        "chat_index_restore" => to_value(crate::agent_chat::chat_index_restore(arg(&args, "id")?)),
        "chat_forget" => {
            let key: String = arg(&args, "key")?;
            crate::agent_chat::chat_stop_impl(&svc.chats, key.clone())?;
            crate::agent_chat::chat_forget(key);
            Ok(Value::Null)
        }
        "image_preview_list" => to_value(crate::image_preview::list(&arg::<String>(&args, "key")?)),
        "save_attachment" => to_value(crate::agent_chat::save_attachment(
            arg(&args, "dataBase64")?,
            arg(&args, "extension")?,
            arg(&args, "filename")?,
        )),

        // ---- files --------------------------------------------------------
        "list_dir" => to_value(crate::fsbrowse::list_dir(arg(&args, "path")?)),
        "read_file_preview" => to_value(crate::fsbrowse::read_file_preview(arg(&args, "path")?)),
        "open_file_native" => unit(crate::fsbrowse::open_file_native(arg(&args, "path")?)),
        "write_file" => unit(crate::fsbrowse::write_file_impl(
            &svc.workspaces,
            arg(&args, "path")?,
            arg(&args, "content")?,
        )),
        "resolve_paths" => Ok(json!(crate::fsbrowse::resolve_paths(
            arg(&args, "paths")?,
            arg(&args, "cwd")?,
        ))),
        "stat_paths" => Ok(json!(crate::fsbrowse::stat_paths(arg(&args, "paths")?))),
        "file_watch_paths" => unit(crate::file_watch::file_watch_paths_impl(
            &svc.watch,
            arg(&args, "paths")?,
        )),

        // ---- terminals ----------------------------------------------------
        // A shell in the browser, in the project's own folder. The PTY streams
        // as `pty-output` events over the same socket the chat uses, so there
        // is nothing new to plumb — only these to call.
        "pty_spawn" => unit(crate::pty::pty_spawn_impl(
            svc.ptys.clone(),
            arg(&args, "id")?,
            arg(&args, "cwd")?,
            arg(&args, "startCmd")?,
            arg(&args, "persistKey")?,
            arg(&args, "shell")?,
            arg(&args, "canvasKey")?,
            arg(&args, "env")?,
        )),
        "pty_write" => unit(crate::pty::pty_write_impl(
            &svc.ptys,
            arg(&args, "id")?,
            arg(&args, "data")?,
        )),
        // rows BEFORE cols — both are u16, so getting this the wrong way round
        // compiles perfectly and silently transposes every terminal.
        "pty_resize" => unit(crate::pty::pty_resize_impl(
            &svc.ptys,
            arg(&args, "id")?,
            arg(&args, "rows")?,
            arg(&args, "cols")?,
        )),
        "pty_close" => unit(crate::pty::pty_close_impl(&svc.ptys, arg(&args, "id")?)),
        "pty_list_active" => to_value(crate::pty::pty_list_active_impl(&svc.ptys)),
        "pty_active_sessions" => to_value(crate::pty::pty_active_sessions_impl(&svc.ptys)),
        "pty_set_visible" => unit(crate::pty::pty_set_visible_impl(
            &svc.ptys,
            arg(&args, "id")?,
            arg(&args, "visible")?,
        )),
        // Re-attaching: replay what this terminal already printed, so coming
        // back to a running dev server is not a blank pane (card 64).
        "pty_attach" => unit(crate::pty::pty_attach_impl(&svc.ptys, arg(&args, "id")?)),

        // ---- permissions --------------------------------------------------
        // What is waiting on a person right now. Asked by a browser as it
        // connects: a permission is announced once, over a broadcast with no
        // replay, so without this a reload lost the card and left the agent
        // waiting out its timeout on a question nobody could still see.
        "permission_pending" => Ok(json!(crate::permission::pending())),
        // Answering a question an agent is currently blocked on.
        "permission_decide" => {
            let id: String = arg(&args, "id")?;
            let decision: crate::permission::Decision = arg(&args, "decision")?;
            // "Always" is an allow that is kept for the rest of this chat.
            // Absent means once, which is what every older client sends.
            let remember = args
                .get("remember")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            Ok(json!(crate::permission::decide(&id, decision, remember)))
        }

        // An agent's request for a higher access level (`access_request`).
        // The answer only settles the card: the level itself is changed by
        // the page's own `chat_set_access`, before it answers "raised".
        "access_request_pending" => Ok(json!(crate::access_request::pending())),
        "access_request_answer" => Ok(json!(crate::access_request::answer(
            &arg::<String>(&args, "id")?,
            arg(&args, "decision")?,
            arg::<Option<String>>(&args, "error")?,
        ))),

        // Codex has no resumable permission channel. A safety-policy rejection
        // is therefore a post-hoc choice about the next user turn, kept long
        // enough to survive a browser reload.
        "safety_block_pending" => Ok(json!(crate::safety_block::pending())),
        "safety_block_dismiss" => Ok(json!(crate::safety_block::dismiss(&arg::<String>(
            &args, "id"
        )?,))),
        // Withdrawn: a page from an older build may still offer "Allow this
        // exact command once". It is answered, not "unknown command", so the
        // card says why the refusal stands. It grants nothing and leaves the
        // card up.
        "safety_block_grant_exact" => Err(crate::safety_block::EXACT_GRANT_WITHDRAWN.to_string()),
        "safety_block_authorize_project" => {
            let id: String = arg(&args, "id")?;
            Ok(json!(crate::safety_block::authorize_for_project(&id)?))
        }
        // An outage card only (Claude's classifier gave no verdict): close it
        // as retried or as the allow it wrote. The retry turn now names its
        // card (`safetyBlock` on chat_send / chat_start) and the host closes
        // it once that turn is taken; this stays for a page that predates it.
        "safety_block_retry" => Ok(json!(crate::safety_block::retry_outage(&arg::<String>(
            &args, "id"
        )?)?)),
        // "Always allow" on a Claude card (an outage, or a judged refusal of
        // a shell line): the host derives the rule from the refused call and
        // writes it to the scope's own settings file. The page sends only the
        // card and the scope, never a rule or a path. The card stays up until
        // the turn that names it has been taken.
        "safety_block_allow_rule" => {
            let id: String = arg(&args, "id")?;
            let scope: crate::claude_allow::Scope = arg(&args, "scope")?;
            to_value(crate::safety_block::allow_rule(&id, scope))
        }

        // ---- questions ----------------------------------------------------
        "question_pending" => to_value(svc.chats.questions.pending()),
        // An answer a tool is waiting for reaches it whether or not it could
        // be saved; then it is said as not recorded beside this answer, and
        // the store owes the save.
        //
        // The receipt says which of the two happened and never more
        // (review of b894867, H9). `saved: true` is "these answers are on
        // disk" and nothing else. An answer that reached its tool and could
        // not be written is `{ saved: false, delivered: true, unsaved }`,
        // with the reason. The single-question command predates receipts:
        // its `true` is "accepted", which is all an older page reads it as.
        "question_answer" => {
            let unsaved = svc
                .chats
                .questions
                .answer(&[crate::question_store::Answer {
                    id: arg(&args, "id")?,
                    answer: arg(&args, "answer")?,
                }])?;
            if let Some(why) = unsaved {
                crate::unsaved::say("the answer", why);
            }
            Ok(json!(true))
        }
        "question_answer_batch" => {
            let unsaved =
                svc.chats
                    .questions
                    .answer(&arg::<Vec<crate::question_store::Answer>>(
                        &args, "answers",
                    )?)?;
            match unsaved {
                None => Ok(json!({ "saved": true })),
                Some(why) => {
                    crate::unsaved::say("the answer", why.clone());
                    Ok(json!({ "saved": false, "delivered": true, "unsaved": why }))
                }
            }
        }
        "question_cancel" => unit(crate::agent_chat::cancel_questions(
            &svc.chats,
            &arg::<Vec<String>>(&args, "ids")?,
        )),
        "question_retry" => {
            let _delivery = svc
                .chats
                .questions
                .delivery_lock
                .lock()
                .map_err(|e| e.to_string())?;
            svc.chats
                .questions
                .retry(&arg::<Vec<String>>(&args, "ids")?)?;
            Ok(json!({ "saved": true }))
        }

        // ---- orchestration -----------------------------------------------
        // The backend, not an agent transcript, owns run and task state. MCP
        // calls arrive through the same commands with actorChatKey injected by
        // the authenticated local hook; the browser supplies the coordinator
        // key when it resolves a visible gate or starts a run explicitly.
        "orchestration_snapshot" => {
            let run_id: Option<String> = arg(&args, "runId")?;
            // An agent's read lands in its transcript and goes out to every
            // tab, so it gets the compact view; the browser, which names no
            // actor, keeps the whole store.
            let Some(actor) = arg::<Option<String>>(&args, "actorChatKey")? else {
                // What each attempt's worker has used and holds, as counted
                // by the host: read here, for this answer, and not kept.
                let snapshot = svc
                    .orchestrations
                    .snapshot(run_id.as_deref())
                    .map(|snapshot| snapshot.with_usage(&svc.chats.usage));
                // The tab's whole-ledger read can leave finished runs' long
                // text out; its run panel asks for one run whole (`brief.rs`).
                let brief = arg::<Option<bool>>(&args, "brief")?.unwrap_or(false);
                let mut view = to_value(snapshot)?;
                if brief && run_id.is_none() {
                    crate::orchestration::brief::brief(&mut view);
                }
                return Ok(view);
            };
            let task_id: Option<String> = arg(&args, "taskId")?;
            let message_limit: Option<usize> = arg(&args, "messageLimit")?;
            // Every agent's read is built from this one ledger, so a peer
            // request's worker, held to its own task, finds nothing else in
            // the view or in the environments below.
            let (snapshot, own_task) = svc.orchestrations.snapshot_for_agent(
                &actor,
                run_id.as_deref(),
                task_id.as_deref(),
            )?;
            // After the cut above: a peer request's worker gets its own
            // attempts' figures and nobody else's.
            let snapshot = snapshot.with_usage(&svc.chats.usage);
            let task_id = own_task.clone().or(task_id);
            let full = snapshot.clone();
            let mut view = crate::orchestration::agent_view::agent_snapshot(
                snapshot,
                &crate::orchestration::agent_view::AgentRead {
                    actor: &actor,
                    run_id: run_id.as_deref(),
                    task_id: task_id.as_deref(),
                    message_limit: message_limit
                        .unwrap_or(crate::orchestration::agent_view::DEFAULT_MESSAGES),
                },
            )?;
            if own_task.is_some() {
                crate::orchestration::agent_view::held_to_own_task(&mut view);
            }
            // Only when a task in view needs one: the sandbox record is read
            // from disk, and most runs never touch it.
            let shown: std::collections::BTreeSet<String> = view["runs"]
                .as_array()
                .map(|runs| {
                    runs.iter()
                        .filter_map(|r| r["id"].as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            let needs = full.tasks.iter().any(|task| {
                task.environment == crate::orchestration::TaskEnvironment::Sandbox
                    && shown.contains(&task.run_id)
            });
            if needs {
                if let (Ok(sandboxes), Some(out)) = (
                    crate::sandbox::Store::profile().snapshot_probed(),
                    view.as_object_mut(),
                ) {
                    out.insert(
                        "environments".into(),
                        crate::orchestration::agent_view::environments(&full, &sandboxes, &shown),
                    );
                    // Host-wide, and it names the chats waiting for a slot.
                    if own_task.is_none() {
                        out.insert(
                            "environmentCapacity".into(),
                            crate::orchestration::agent_view::capacity(&sandboxes),
                        );
                    }
                }
            }
            Ok(view)
        }
        "orchestration_service_register" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let registration = serde_json::from_value(args).map_err(|e| e.to_string())?;
            to_value(svc.orchestrations.register_service(&actor, registration))
        }
        "orchestration_run_create" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let start_master = arg::<Option<bool>>(&args, "startMaster")?.unwrap_or(false);
            if start_master && !crate::agent_chat::chat_can_continue_internal(&svc.chats, &actor)? {
                return Err("This chat has not run since OctiqFlow restarted. Send one message in it, then start the master run.".into());
            }
            let (workspace_id, root_path) = crate::orchestration::infer_context(
                &svc.workspaces,
                &actor,
                arg(&args, "workspaceId")?,
                arg(&args, "rootPath")?,
            )?;
            let defaults: Option<crate::orchestration::automation::WorkerDefaults> =
                arg(&args, "workerDefaults")?;
            let defaults = defaults.map(|d| d.normalized()).transpose()?;
            // Agents mode: this chat is a registered lead's.
            let agents_lead =
                crate::team::lead_for_chat(&crate::team::default_path(), &actor)?.is_some();
            let run = svc.orchestrations.create_run_with_mode(
                actor.clone(),
                arg(&args, "objective")?,
                workspace_id,
                root_path,
                arg(&args, "maxConcurrent")?,
                // In agents mode a run is a mission unless the caller says
                // otherwise: one worktree per repository, open until closed.
                // Elsewhere the default stays Auto.
                arg::<Option<crate::git_ops::workflow::WorkspaceMode>>(&args, "workspaceMode")?
                    .unwrap_or(if agents_lead {
                        crate::git_ops::workflow::WorkspaceMode::Mission
                    } else {
                        crate::git_ops::workflow::WorkspaceMode::Auto
                    }),
            )?;
            let run = if let Some(defaults) = defaults {
                svc.orchestrations
                    .configure_automation(&actor, &run.id, Some(defaults))?
            } else {
                run
            };
            // Agents mode: a lead's plan always waits for the person.
            let run = if agents_lead {
                svc.orchestrations.require_plan_approval(&run.id)?
            } else {
                run
            };
            svc.chats.persist_orchestration_context(&actor)?;
            if start_master {
                crate::agent_chat::chat_continue_internal_impl(
                    svc.chats.clone(),
                    actor,
                    crate::orchestration::master_prompt(&run),
                )?;
            }
            // An agent that opened its own run (the MCP hook sets this) gets the
            // master brief back in the answer, since nothing else delivers it.
            if arg::<Option<bool>>(&args, "withBrief")?.unwrap_or(false) && !start_master {
                let brief = crate::orchestration::master_prompt(&run);
                let mut value = serde_json::to_value(&run).map_err(|e| e.to_string())?;
                if let Some(object) = value.as_object_mut() {
                    object.insert("masterBrief".into(), Value::String(brief));
                }
                return Ok(value);
            }
            to_value(Ok(run))
        }
        // Browser-only entry point: a chat need not have a live start context
        // to become a coordinator. Run creation and launch are separate so a
        // provider failure can retry this exact run without duplicating it.
        "orchestration_master_start" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let (_guard, run) = svc
                .orchestrations
                .guard_master_start(&actor, &arg::<String>(&args, "runId")?)?;
            let meta = crate::chat_index::list()
                .into_iter()
                .find(|meta| format!("chat:{}", meta.id) == actor)
                .ok_or("Save the main chat before starting this run.")?;
            if meta.project_id != run.workspace_id || meta.cwd.as_deref() != Some(&run.root_path) {
                return Err(
                    "This chat's workspace changed. Start a new run from its current workspace."
                        .into(),
                );
            }
            let project = crate::workspaces::list_workspaces_impl(&svc.workspaces)?
                .into_iter()
                .find(|project| project.id == run.workspace_id)
                .ok_or("The run's project no longer exists.")?;
            let agent: crate::agent_chat::ChatAgent = arg(&args, "agent")?;
            if agent == crate::agent_chat::ChatAgent::Pi {
                return Err("Choose Codex, Claude or Antigravity as the main agent.".into());
            }
            let handoff: Option<String> = arg(&args, "handoff")?;
            // A provider switch always starts a fresh native session, even if
            // an older index save is still in flight in another browser.
            let resume = if handoff.is_some() {
                None
            } else {
                meta.session_id
            };
            unit(crate::agent_chat::chat_start_master_impl(
                svc.chats.clone(),
                actor,
                run.root_path.clone(),
                agent,
                arg(&args, "model")?,
                arg(&args, "access")?,
                crate::orchestration::master_prompt(&run),
                handoff,
                resume,
                Some(project.paths),
                Some(project.env),
                arg(&args, "effort")?,
                arg(&args, "lite")?,
            ))
        }
        "orchestration_task_create" => {
            let run_id: String = arg(&args, "runId")?;
            let actor: String = arg(&args, "actorChatKey")?;
            let parent: Option<String> = arg(&args, "parentTaskId")?;
            // The plan card is checked before the task exists, so a bad card
            // refuses the whole call rather than leaving a task without it.
            let card = crate::orchestration::TaskCard::checked(
                arg(&args, "problem")?,
                arg(&args, "goal")?,
                arg(&args, "acceptance")?,
            )?;
            let (worker, assignee, destination) = route_task(
                svc,
                &actor,
                &run_id,
                parent.as_deref(),
                arg::<Option<String>>(&args, "assignee")?,
                arg(&args, "project")?,
                arg(&args, "repository")?,
                arg(&args, "worker")?,
            )?;
            // A replacement for a blocked or failed task (feedback 6b0870f9).
            // Checked first, so a refusal creates no task.
            let supersedes: Option<String> = arg(&args, "supersedes")?;
            if let Some(old) = &supersedes {
                svc.orchestrations.check_supersede(&actor, &run_id, old)?;
            }
            let created = svc.orchestrations.create_task_full(
                &actor,
                run_id,
                arg(&args, "title")?,
                arg(&args, "spec")?,
                list_arg(&args, "dependsOn")?,
                parent,
                worker,
                assignee,
                destination,
                card,
                arg::<Option<crate::orchestration::TaskEnvironment>>(&args, "environment")?
                    .unwrap_or_default(),
                arg(&args, "size")?,
                arg::<Option<crate::orchestration::TaskKind>>(&args, "kind")?.unwrap_or_default(),
            );
            if let (Ok(task), Some(old)) = (&created, &supersedes) {
                svc.orchestrations.supersede(&actor, old, &task.id)?;
            }
            to_value(created)
        }
        // A lead changes or withdraws a task of a plan the person has not
        // approved yet. Owner and destination go through the same routing as
        // a new task, so a revision can reach no agent or project a new task
        // could not.
        "orchestration_task_revise" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let task_id: String = arg(&args, "taskId")?;
            let current = svc
                .orchestrations
                .snapshot(None)?
                .tasks
                .into_iter()
                .find(|task| task.id == task_id)
                .ok_or("The task does not exist.")?;
            let assignee_arg = arg::<Option<String>>(&args, "assignee")?;
            let project_arg = arg::<Option<String>>(&args, "project")?;
            let repository_arg = arg::<Option<String>>(&args, "repository")?;
            let worker_arg =
                arg::<Option<crate::orchestration::automation::WorkerSettings>>(&args, "worker")?;
            let reroute = assignee_arg.is_some()
                || project_arg.is_some()
                || repository_arg.is_some()
                || worker_arg.is_some();
            let route = if reroute {
                // What is not named stays as it was.
                let kept = current.destination.as_ref();
                Some(route_task(
                    svc,
                    &actor,
                    &current.run_id,
                    None,
                    assignee_arg.or_else(|| current.assignee.as_ref().map(|a| a.id.clone())),
                    project_arg.or_else(|| kept.map(|d| d.project_id.clone())),
                    repository_arg.or_else(|| kept.map(|d| d.repository.clone())),
                    worker_arg.or_else(|| current.worker.clone()),
                )?)
            } else {
                None
            };
            let problem: Option<String> = arg(&args, "problem")?;
            let goal: Option<String> = arg(&args, "goal")?;
            let acceptance: Option<Vec<String>> = arg(&args, "acceptance")?;
            let card = if problem.is_some() || goal.is_some() || acceptance.is_some() {
                let was = current.card.clone().unwrap_or_default();
                Some(crate::orchestration::TaskCard::checked(
                    Some(problem.unwrap_or(was.problem)),
                    Some(goal.unwrap_or(was.goal)),
                    Some(acceptance.unwrap_or(was.acceptance)),
                )?)
            } else {
                None
            };
            to_value(svc.orchestrations.revise_task(
                &actor,
                &task_id,
                crate::orchestration::TaskRevision {
                    title: arg(&args, "title")?,
                    spec: arg(&args, "spec")?,
                    card,
                    depends_on: arg(&args, "dependsOn")?,
                    kind: arg(&args, "kind")?,
                    route,
                    withdraw: arg::<Option<bool>>(&args, "withdraw")?.unwrap_or(false),
                    size: arg(&args, "size")?,
                },
            ))
        }
        // A lead hands a task nobody is working on to another of its direct
        // reports — the backup taking over. Routed exactly as a new task, so
        // the org chart holds; the host keeps the task's destination and
        // workspace and puts the new owner in front of the person.
        "orchestration_task_reassign" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let task_id: String = arg(&args, "taskId")?;
            let current = svc
                .orchestrations
                .snapshot(None)?
                .tasks
                .into_iter()
                .find(|task| task.id == task_id)
                .ok_or("The task does not exist.")?;
            let kept = current.destination.as_ref();
            let route = route_task(
                svc,
                &actor,
                &current.run_id,
                None,
                Some(arg::<String>(&args, "assignee")?),
                kept.map(|d| d.project_id.clone()),
                kept.map(|d| d.repository.clone()),
                current.worker.clone(),
            )?;
            to_value(svc.orchestrations.reassign_task(
                &actor,
                &task_id,
                route,
                arg(&args, "reason")?,
            ))
        }
        // Browser-only: the person chooses a task's size before it starts.
        "orchestration_task_size" => to_value(
            svc.orchestrations
                .set_task_size(&arg::<String>(&args, "taskId")?, arg(&args, "size")?),
        ),
        // Browser-only: the person accepts a completed task's result. The
        // agent hook maps nothing to this, so no agent can accept as the
        // person.
        "orchestration_task_accept" => to_value(svc.orchestrations.accept_task(
            crate::orchestration::levels::AcceptActor::Person,
            &arg::<String>(&args, "taskId")?,
            &arg::<String>(&args, "attemptId")?,
        )),
        // The hook's `task_accept`: a lead accepts from its own chat. Who it
        // is comes from the host's records of that chat, never the arguments,
        // and the store checks it is the lead responsible for this task.
        "orchestration_task_accept_in_chat" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let lead = crate::team::lead_for_chat(&crate::team::default_path(), &actor)?
                .map(|record| (record.lead_id, record.lead_name));
            to_value(svc.orchestrations.accept_task(
                crate::orchestration::levels::AcceptActor::Chat {
                    chat_key: &actor,
                    lead,
                },
                &arg::<String>(&args, "taskId")?,
                &arg::<String>(&args, "attemptId")?,
            ))
        }
        // Every paid agent's level, for the roster.
        "agent_levels" => to_value(svc.orchestrations.level_summaries()),
        // One agent's level, a page of its XP history, what waits for
        // acceptance, and the tokens its own chats used.
        "agent_level_profile" => {
            let agent_id: String = arg(&args, "agentId")?;
            let offset = arg::<Option<usize>>(&args, "offset")?.unwrap_or(0);
            let levels = svc.orchestrations.level_profile(&agent_id, offset)?;
            let usage = svc.chats.usage.for_agent(&agent_id);
            let mut value = serde_json::to_value(levels).map_err(|e| e.to_string())?;
            if let Some(object) = value.as_object_mut() {
                match usage {
                    Ok(usage) => object.insert(
                        "usage".into(),
                        serde_json::to_value(usage).map_err(|e| e.to_string())?,
                    ),
                    Err(error) => object.insert("usageError".into(), Value::String(error)),
                };
            }
            Ok(value)
        }
        // Where the caller may send work: registered projects, their
        // repositories, and which of its direct reports can work in each.
        // Identity comes from the chat, never from the arguments.
        "orchestration_destinations" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let team_path = crate::team::default_path();
            let manager = match crate::team::lead_for_chat(&team_path, &actor)? {
                Some(lead) => Some(lead.lead_id),
                None => svc
                    .orchestrations
                    .active_task(&actor)?
                    .and_then(|task| task.assignee)
                    .map(|a| a.id),
            };
            Ok(crate::orchestration::destination::directory(
                &crate::team::list(&team_path, None, true)?,
                &crate::workspaces::list_workspaces_impl(&svc.workspaces)?,
                manager.as_deref(),
            ))
        }
        // Browser-only: the person approves an agents-mode lead's plan. Not in
        // the agent hook's whitelist, so no agent can approve its own plan.
        "orchestration_plan_approve" => to_value(svc.orchestrations.approve_plan_from_card(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "runId")?,
            arg::<Option<Vec<String>>>(&args, "taskIds")?.as_deref(),
            arg::<Option<u32>>(&args, "revision")?,
            crate::orchestration::CardView {
                surface: arg::<Option<String>>(&args, "surface")?.unwrap_or_default(),
                shown_ms: arg(&args, "shownMs")?,
                updated_ms: arg(&args, "updatedMs")?,
            },
        )),
        // Browser-only: the person rejects exactly the revision shown on a
        // plan card. Deliberately absent from the hook/MCP action whitelist.
        "orchestration_plan_reject" => to_value(svc.orchestrations.reject_plan_from_card(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "runId")?,
            arg::<Option<Vec<String>>>(&args, "taskIds")?.as_deref(),
            arg::<Option<u32>>(&args, "revision")?,
            arg::<Option<String>>(&args, "reason")?,
            crate::orchestration::CardView {
                surface: arg::<Option<String>>(&args, "surface")?.unwrap_or_default(),
                shown_ms: arg(&args, "shownMs")?,
                updated_ms: arg(&args, "updatedMs")?,
            },
        )),
        // Agent-reachable, and still the person's approval: the host reads
        // the message the lead is answering from its own record of what the
        // browser sent, and the lead supplies only which plan and revision.
        // No gate, safety card, deploy or restart is decided here.
        "orchestration_plan_approve_in_chat" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let turn = svc.chats.person_turn(&actor).ok_or_else(|| {
                crate::outcome::refuse(
                    crate::outcome::ReasonClass::ScopeRefused,
                    "Only a message the person typed in this chat can approve a plan, and the message this turn answers is not one (a notification, a gate answer or a host message never is). Nothing was approved.",
                )
            })?;
            to_value(svc.orchestrations.approve_plan_in_conversation(
                &actor,
                &arg::<String>(&args, "runId")?,
                arg::<u32>(&args, "revision")?,
                &turn,
            ))
        }
        // Handovers between agents (`handover.rs`). Only the person's socket
        // reaches these: an agent asks through `/hook/handover`, which can
        // only record a pending one.
        "handover_list" => to_value(crate::handover::list(&svc.handovers.store)),
        "handover_confirm" => to_value(crate::handover::decide(
            svc,
            &arg::<String>(&args, "id")?,
            crate::handover::Decision::Confirm,
        )),
        "handover_decline" => to_value(crate::handover::decide(
            svc,
            &arg::<String>(&args, "id")?,
            crate::handover::Decision::Decline,
        )),
        "handover_abandon" => to_value(crate::handover::decide(
            svc,
            &arg::<String>(&args, "id")?,
            crate::handover::Decision::Abandon,
        )),
        // Front-desk chats the person left before they routed anywhere, for
        // the way back on the new-chat screen. No list shows them otherwise.
        "front_desk_unfinished" => to_value(crate::handover::route::unfinished_desks(
            &svc.handovers.store,
            &svc.handovers.team,
        )),
        "team_leads" => to_value(crate::team::leads(&crate::team::default_path())),
        "team_brief" => {
            let chat_key: String = arg(&args, "chatKey")?;
            if !chat_key.starts_with("chat:") || chat_key.starts_with("chat:orch-") {
                return Err("A task can only be handed out from a main chat.".into());
            }
            let projects: Vec<(String, String)> =
                crate::workspaces::list_workspaces_impl(&svc.workspaces)?
                    .into_iter()
                    .map(|p| (p.id, p.name))
                    .collect();
            to_value(crate::team::brief(
                &crate::team::default_path(),
                &chat_key,
                &arg::<String>(&args, "projectId")?,
                &arg::<String>(&args, "leadId")?,
                &arg::<String>(&args, "task")?,
                arg::<Option<bool>>(&args, "crossProject")?.unwrap_or(false),
                &projects,
            ))
        }
        // The lead the person talks to across projects. Browser-only, like the
        // rest of the team store.
        "team_head" => to_value(crate::team::head(&crate::team::default_path())),
        "team_head_set" => to_value(crate::team::set_head(
            &crate::team::default_path(),
            arg::<Option<String>>(&args, "id")?.as_deref(),
        )),
        // The front desk every new conversation opens on (`handover::route`).
        // Browser-only, like the rest of the team store.
        "team_front_desk" => to_value(crate::team::front_desk(&crate::team::default_path())),
        "team_front_desk_set" => to_value(crate::team::set_front_desk(
            &crate::team::default_path(),
            arg::<Option<String>>(&args, "id")?.as_deref(),
        )),
        "team_front_desk_create" => {
            let saved = crate::team::create_front_desk(
                &crate::team::default_path(),
                arg::<Option<crate::team::FrontDeskDraft>>(&args, "draft")?.unwrap_or_default(),
            )?;
            let _ = crate::team::ensure_memory(
                &crate::memory_vault::Vault::profile(),
                "octiq:team",
                &saved,
            );
            to_value(Ok::<_, String>(saved))
        }
        // The coordination home: the workspace the head's conversations live
        // in. Only a registered workspace may be chosen.
        "team_home" => to_value(crate::team::home(&crate::team::default_path())),
        "team_home_set" => {
            let id: Option<String> = arg(&args, "id")?;
            if let Some(id) = id.as_deref().filter(|id| !id.trim().is_empty()) {
                let known = crate::workspaces::list_workspaces_impl(&svc.workspaces)?
                    .iter()
                    .any(|w| w.id == id.trim());
                if !known {
                    return Err("That project is not registered.".into());
                }
            }
            to_value(crate::team::set_home(
                &crate::team::default_path(),
                id.as_deref(),
            ))
        }
        // Avatar generation through the person's own Codex (ChatGPT) sign-in.
        // Browser-only, like the rest of the team store.
        "agent_avatar_status" => to_value(Ok::<_, String>(crate::agent_avatar::generation_status(
            arg::<Option<bool>>(&args, "refresh")?.unwrap_or(false),
        ))),
        "agent_avatar_generate" => to_value(crate::agent_avatar::start(&arg(&args, "request")?)),
        "agent_avatar_job" => to_value(crate::agent_avatar::job(&arg::<String>(&args, "id")?)),
        "agent_avatar_cancel" => {
            to_value(crate::agent_avatar::cancel(&arg::<String>(&args, "id")?))
        }
        "team_list" => {
            let project: Option<String> = arg(&args, "projectId")?;
            let all = arg::<Option<bool>>(&args, "all")?.unwrap_or(false);
            to_value(crate::team::list(
                &crate::team::default_path(),
                project.as_deref(),
                all,
            ))
        }
        "team_save" => {
            let saved = crate::team::save(&crate::team::default_path(), arg(&args, "agent")?)?;
            let memory = crate::team_tools::settle(&saved);
            let mut value = serde_json::to_value(&saved).map_err(|e| e.to_string())?;
            if let (Some(error), Some(object)) = (memory, value.as_object_mut()) {
                object.insert("memoryError".into(), Value::String(error));
            }
            Ok(value)
        }
        // The shared agent policy every registered agent's brief starts with.
        // Browser-only, like the rest of the team store.
        "team_policy" => to_value(crate::team::policy(&crate::team::default_path())),
        "team_policy_set" => {
            let saved = crate::team::set_policy(
                &crate::team::default_path(),
                &arg::<Option<String>>(&args, "text")?.unwrap_or_default(),
            )?;
            crate::bus::emit("team-changed", serde_json::json!({ "policy": true }));
            to_value(Ok::<_, String>(saved))
        }
        // Not while anything of its is in progress: asked in the one step
        // that removes it, which lets no task of its start beside it
        // (`orchestration::agent_work::Departure`).
        "team_delete" => unit(crate::team::delete_idle(
            &crate::team::default_path(),
            &arg::<String>(&args, "id")?,
            &crate::orchestration::agent_work::Departure {
                store: &svc.orchestrations,
                chats: &svc.chats,
            },
        )),
        // Peer-help teams: a lateral grouping beside the org chart.
        "agent_team_list" => to_value(crate::team::teams(&crate::team::default_path())),
        "agent_team_save" => to_value(crate::team::save_team(
            &crate::team::default_path(),
            arg(&args, "team")?,
        )),
        "agent_team_delete" => unit(crate::team::delete_team(
            &crate::team::default_path(),
            &arg::<String>(&args, "id")?,
        )),

        // Two doors, one start. The coordinator's explicit start comes only
        // through `/hook/orchestration` as `_in_chat`, which the person's
        // socket refuses; the page's Start retry comes only through the
        // socket and names the attempt it retries (`retryOf`), so a page whose
        // snapshot a handoff overtook is refused (`page_retry_is_current`).
        "orchestration_worker_start" | "orchestration_worker_start_in_chat" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let launch = crate::orchestration::WorkerLaunch {
                task_id: arg(&args, "taskId")?,
                agent: arg(&args, "agent")?,
                model: arg(&args, "model")?,
                effort: arg(&args, "effort")?,
                access: arg(&args, "access")?,
                new_worktree: arg(&args, "newWorktree")?,
                base_branch: arg::<Option<String>>(&args, "baseBranch")?.unwrap_or_default(),
            };
            let retry_of: Option<String> = arg(&args, "retryOf")?;
            let by = if cmd == "orchestration_worker_start_in_chat" {
                crate::orchestration::StartedBy::Coordinator
            } else {
                crate::orchestration::StartedBy::Page {
                    retry_of: retry_of.as_deref(),
                }
            };
            to_value(svc.orchestrations.start_worker_for(
                svc.chats.clone(),
                &svc.workspaces,
                &actor,
                launch,
                by,
            ))
        }
        "orchestration_automation_configure" => to_value(svc.orchestrations.configure_automation(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "runId")?,
            arg(&args, "workerDefaults")?,
        )),
        "orchestration_dispatch_ready" => to_value(svc.orchestrations.dispatch_ready(
            svc.chats.clone(),
            &svc.workspaces,
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "runId")?,
        )),
        "orchestration_validation_create" => to_value(svc.orchestrations.create_validation(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "taskId")?,
            &arg::<String>(&args, "baseSha")?,
            arg::<Option<Vec<String>>>(&args, "commits")?.unwrap_or_default(),
        )),
        "orchestration_validation_remove" => to_value(svc.orchestrations.remove_validation(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "taskId")?,
            &arg::<String>(&args, "path")?,
        )),
        "orchestration_workspace_refresh" => to_value(svc.orchestrations.refresh_workspace(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "taskId")?,
        )),
        "orchestration_task_reopen" => to_value(svc.orchestrations.reopen_task(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "taskId")?,
            arg(&args, "spec")?,
        )),
        "orchestration_worker_archive" => to_value(svc.orchestrations.set_worker_archived(
            &svc.chats,
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "attemptId")?,
            arg(&args, "archived")?,
        )),
        "orchestration_workers_archive_merged" => {
            to_value(svc.orchestrations.archive_merged_workers(
                &svc.chats,
                &arg::<String>(&args, "actorChatKey")?,
                &arg::<String>(&args, "runId")?,
            ))
        }
        // Browser-only: the person hides a finished run, or restores it. Not
        // an MCP tool — an agent never decides what the person sees.
        "orchestration_run_archive" => to_value(svc.orchestrations.set_run_archived(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "runId")?,
            arg(&args, "archived")?,
        )),
        // The person's, like workspace cleanup: absent from the agents' hook.
        "orchestration_mission_refresh" => to_value(svc.orchestrations.refresh_mission(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "runId")?,
        )),
        "orchestration_mission_close" => to_value(svc.orchestrations.close_mission(
            &svc.chats,
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "runId")?,
            arg::<Option<bool>>(&args, "abandon")?.unwrap_or(false),
        )),
        "orchestration_workspace_cleanup" => to_value(svc.orchestrations.cleanup_workspace(
            &svc.chats,
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "taskId")?,
            arg::<Option<bool>>(&args, "abandon")?.unwrap_or(false),
            &arg::<String>(&args, "expectedHead")?,
        )),
        "orchestration_worker_report" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let task = svc.orchestrations.report_worker(
                &actor,
                crate::orchestration::WorkerReport {
                    attempt_id: arg(&args, "attemptId")?,
                    outcome: arg(&args, "outcome")?,
                    summary: arg(&args, "summary")?,
                    files_modified: arg(&args, "filesModified")?,
                    verdict: arg(&args, "verdict")?,
                },
            )?;
            to_value(Ok(task))
        }
        // The coordinator settles a read-only worker's attempt from the
        // closing words the host held for it — that proposal, by id, with an
        // outcome and verdict the coordinator states. Never inferred.
        "orchestration_report_confirm" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let attempt: String = arg(&args, "attemptId")?;
            let proposal: String = arg(&args, "proposalId")?;
            let outcome = arg(&args, "outcome")?;
            let verdict = arg(&args, "verdict")?;
            let confirm = || {
                svc.orchestrations
                    .confirm_proposed_report(&actor, &attempt, &proposal, outcome, verdict)
            };
            // Decided while the worker's session is held idle: a message
            // reaching the worker cannot start a turn — which would withdraw
            // the words — between the check and the settlement.
            let settled = match svc.orchestrations.attempt_worker_chat(&attempt)? {
                Some(worker) => svc.chats.while_idle(&worker, confirm).map_err(|why| {
                    if why.starts_with("That chat is in a turn") {
                        "The worker is in a turn again; that withdraws its proposed report. Wait for the turn to end and read the snapshot again.".to_string()
                    } else {
                        why
                    }
                })?,
                None => confirm()?,
            };
            to_value(Ok::<_, String>(settled))
        }
        // A question to a teammate, answered by the host as that teammate in
        // a read-only one-shot turn (`orchestration/peer.rs`): from a worker
        // on its task, or from a registered lead in its own chat.
        "orchestration_peer_ask" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let path = crate::team::default_path();
            let agents = crate::team::list(&path, None, true)?;
            let teams = crate::team::teams(&path)?;
            let policy = crate::team::policy(&path)?;
            let lead = peer_lead(svc, &path, &actor)?;
            to_value(svc.orchestrations.peer_ask(
                &actor,
                lead.as_ref(),
                crate::orchestration::peer::PeerQuestion {
                    teammate_id: arg(&args, "teammateId")?,
                    question: arg(&args, "question")?,
                    context_paths:
                        arg::<Option<Vec<String>>>(&args, "contextPaths")?.unwrap_or_default(),
                },
                &agents,
                &teams,
                &policy.text,
                crate::orchestration::peer::run_helper,
            ))
        }
        // One bounded piece of work for a teammate, recorded as a task that
        // waits for the person (`orchestration/peer_request.rs`). Who asks
        // comes from the chat; nothing in the arguments names the requester.
        "orchestration_peer_request" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let path = crate::team::default_path();
            let agents = crate::team::list(&path, None, true)?;
            let teams = crate::team::teams(&path)?;
            let projects = crate::workspaces::list_workspaces_impl(&svc.workspaces)?;
            let lead = peer_lead(svc, &path, &actor)?;
            let made = svc.orchestrations.peer_request(
                &actor,
                lead.as_ref(),
                crate::orchestration::peer_request::PeerWork {
                    peer: arg(&args, "peer")?,
                    title: arg(&args, "title")?,
                    request: arg(&args, "request")?,
                    output: arg(&args, "output")?,
                    project: arg(&args, "project")?,
                    repository: arg(&args, "repository")?,
                    max_minutes: arg(&args, "maxMinutes")?,
                },
                &agents,
                &teams,
                &projects,
            )?;
            // The host opened a run for this chat: it must be able to wake
            // the chat when the teammate reports, as for any coordinator.
            if made.run_created {
                svc.chats.persist_orchestration_context(&actor)?;
            }
            to_value(Ok(made))
        }
        "orchestration_relay_send" => to_value(svc.orchestrations.relay_between_runs(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "fromRunId")?,
            &arg::<String>(&args, "toRunId")?,
            arg(&args, "subject")?,
            arg(&args, "body")?,
            arg(&args, "originAttemptId")?,
        )),
        // Browser-only: the person opens or closes a one-way bridge between
        // two runs of different coordinators. Neither is in the agent hook's
        // whitelist, and neither reads an actor: only the person decides.
        "orchestration_bridge_open" => to_value(svc.orchestrations.open_bridge(
            &arg::<String>(&args, "fromRunId")?,
            &arg::<String>(&args, "toRunId")?,
            &arg::<String>(&args, "fromCoordinator")?,
            &arg::<String>(&args, "toCoordinator")?,
        )),
        "orchestration_bridge_close" => to_value(
            svc.orchestrations
                .close_bridge(&arg::<String>(&args, "bridgeId")?),
        ),
        // Browser-only: the person picks Auto or Manual command approval for
        // a Claude task on its plan card, before approving the plan. Not in
        // the agent hook's whitelist.
        "orchestration_task_access" => to_value(svc.orchestrations.set_task_access(
            &arg::<String>(&args, "runId")?,
            &arg::<String>(&args, "taskId")?,
            arg(&args, "access")?,
            arg::<u32>(&args, "revision")?,
        )),
        "orchestration_gate_create" => {
            let gate = svc.orchestrations.create_gate(
                &arg::<String>(&args, "actorChatKey")?,
                arg(&args, "runId")?,
                arg(&args, "taskId")?,
                arg(&args, "question")?,
                arg(&args, "options")?,
            )?;
            to_value(Ok(gate))
        }
        // Two doors, as for a worker start. A coordinator's answer comes only
        // through `/hook/orchestration` as `_in_chat`, which the person's
        // socket refuses; the person's comes only through the socket. A
        // peer request's gate takes the person's and no other.
        "orchestration_gate_resolve" | "orchestration_gate_resolve_in_chat" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let resolution: String = arg(&args, "resolution")?;
            let resume_target = arg::<Option<bool>>(&args, "resumeTarget")?.unwrap_or(false);
            let by = if cmd == "orchestration_gate_resolve_in_chat" {
                crate::orchestration::ResolvedBy::Coordinator
            } else {
                crate::orchestration::ResolvedBy::Person
            };
            let gate = svc.orchestrations.resolve_gate_and_resume(
                &actor,
                arg(&args, "gateId")?,
                resolution,
                resume_target,
                by,
            )?;
            to_value(Ok(gate))
        }
        "orchestration_message_send" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let to: String = arg(&args, "to")?;
            let interrupt = arg::<Option<bool>>(&args, "interrupt")?.unwrap_or(false);
            if interrupt && to == "coordinator" {
                return Err("Only a coordinator interrupts, and only a worker attempt.".into());
            }
            let message = svc.orchestrations.record_message_as(
                interrupt,
                &actor,
                arg(&args, "runId")?,
                to,
                arg(&args, "kind")?,
                arg(&args, "subject")?,
                arg(&args, "body")?,
            )?;
            let mut value = serde_json::to_value(&message).map_err(|e| e.to_string())?;
            if interrupt && !svc.orchestrations.message_waiting(&message.id) {
                // A host call of the worker's took it in the meantime.
                value["interrupt"] = json!("delivered");
            } else if interrupt {
                // The message is kept, on disk or owed to it; an interrupt
                // that fails leaves it to the ordinary delivery.
                match crate::agent_chat::interrupt_worker_turn(&svc.chats, &message.to_chat_key) {
                    Ok(worker) => value["interrupt"] = json!(worker),
                    Err(error) => {
                        value["interrupt"] = json!("failed");
                        value["interruptError"] = json!(error);
                    }
                }
            }
            Ok(value)
        }
        "orchestration_run_stop" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let workers =
                svc.orchestrations
                    .stop_run(&actor, arg(&args, "runId")?, arg(&args, "reason")?)?;
            for worker in workers {
                let _ = crate::agent_chat::chat_stop_impl(&svc.chats, worker);
            }
            Ok(Value::Null)
        }
        // The person stops ONE task's worker; the run goes on. Socket-only:
        // no hook action maps here, so no agent stops a teammate's work with
        // it. The task is then held for the person to start again.
        "orchestration_task_stop" => {
            let (task, worker) = svc
                .orchestrations
                .stop_task(&arg::<String>(&args, "taskId")?, arg(&args, "reason")?)?;
            let _ = crate::agent_chat::chat_stop_impl(&svc.chats, worker);
            to_value(Ok::<_, String>(task))
        }

        // ---- git ----------------------------------------------------------
        cmd if cmd.starts_with("pr_") => pull_requests::dispatch(svc, cmd, args),
        // No `_impl` split here: git.rs and git_ops.rs never held managed state,
        // so they were already plain functions before the window went and there
        // was never a wrapper to strip.
        "git_status_summary" => to_value(crate::git::git_status_summary(arg(&args, "paths")?)),
        "git_changed_files" => to_value(crate::git::git_changed_files(arg(&args, "paths")?)),
        "git_file_diff" => to_value(crate::git::git_file_diff(
            arg(&args, "root")?,
            arg(&args, "file")?,
            arg(&args, "untracked")?,
            arg(&args, "oldPath")?,
        )),
        "git_local_branches" => to_value(crate::git::git_local_branches(arg(&args, "path")?)),
        // Live git state. Without this the browser only ever re-read on focus,
        // so an agent switching branch mid-turn left the toolbar naming the
        // branch you were on before it did.
        "git_watch_paths" => unit(crate::git_watch::git_watch_paths_impl(
            &svc.git_watch,
            arg(&args, "paths")?,
        )),

        // Writes. Reachable from a browser, deliberately — doing this from a
        // phone is the point of v2. Each is one git invocation whose own output
        // is handed back verbatim rather than summarised away.
        "git_commit" => to_value(crate::git_ops::git_commit(
            arg(&args, "root")?,
            arg(&args, "files")?,
            arg(&args, "message")?,
        )),
        "git_push" => to_value(crate::git_ops::git_push(arg(&args, "root")?)),
        "git_pull" => to_value(crate::git_ops::git_pull(
            arg(&args, "root")?,
            arg(&args, "mode")?,
        )),
        "git_switch_branch" => to_value(crate::git_ops::git_switch_branch(
            arg(&args, "root")?,
            arg(&args, "branch")?,
        )),
        "git_prepare_chat_workspace" => to_value(crate::git_ops::git_prepare_chat_workspace(
            arg(&args, "path")?,
            arg(&args, "branch")?,
            arg(&args, "newWorktree")?,
            arg(&args, "prompt")?,
            arg(&args, "chatId")?,
        )),

        // ---- finding files ------------------------------------------------
        "search_files" => to_value(crate::fsbrowse::search_files(
            arg(&args, "roots")?,
            arg(&args, "query")?,
        )),
        "list_project_files" => to_value(crate::fsbrowse::list_project_files(arg(&args, "roots")?)),

        // ---- usage --------------------------------------------------------
        "usage_summary" => Ok(json!(crate::usage_limits::usage_summary())),

        // What this app is holding in RAM, and which chat or terminal is
        // holding it. Read-only, and cached for a few seconds so several open
        // browser tabs polling it share one `ps` sweep between them.
        "memory_usage" => Ok(json!(crate::memory::memory_usage(&svc.ptys, &svc.chats))),

        // ---- agents -------------------------------------------------------
        // Which agent CLIs this machine actually has. The browser needs it for
        // the same reason the desktop menu does: offering an agent that is not
        // installed only produces a chat that dies on its first line.
        "agent_installs" => Ok(json!(crate::agents::agent_installs(arg(&args, "refresh")?))),
        // Provider-owned model catalogs. Codex answers through app-server;
        // Claude uses its Models API when an API key is available and an
        // explicit versioned fallback for subscription OAuth.
        "agent_models" => to_value(crate::agents::agent_models(arg(&args, "agent")?)),
        // Codex's own cwd-aware catalog, loaded lazily when its composer opens
        // the slash menu. `codex exec --json` has no startup catalog event.
        "codex_skills" => to_value(crate::agents::codex_skills(arg(&args, "cwd")?)),

        // ---- web push -----------------------------------------------------
        //
        // The notifications that arrive with nothing open. Only the browser
        // ever calls these — a desktop window raises its own banners and has no
        // push service to register with — so they live here and have no Tauri
        // command beside them.
        "push_key" => match crate::push::public_key() {
            Some(key) => Ok(json!({ "key": key })),
            None => Err("could not read or create the push key".into()),
        },
        "push_subscribe" => {
            crate::push::subscribe(crate::push::Subscription {
                endpoint: arg(&args, "endpoint")?,
                p256dh: arg(&args, "p256dh")?,
                auth: arg(&args, "auth")?,
            });
            Ok(Value::Null)
        }
        "push_unsubscribe" => {
            let endpoint: String = arg(&args, "endpoint")?;
            crate::push::unsubscribe(&endpoint);
            Ok(Value::Null)
        }

        // Anything else, this backend does not know. Saying so beats a silent
        // null, which would look like a bug in the client. In practice the
        // reason is almost always a server older than the page asking it.
        _ => Err(format!(
            "'{cmd}' is not available on this backend — it may be older than the page asking for it"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argument_names_are_accepted_in_either_spelling() {
        let camel = json!({ "extraDirs": ["/a"] });
        let snake_case = json!({ "extra_dirs": ["/a"] });
        let a: Vec<String> = arg(&camel, "extraDirs").unwrap();
        let b: Vec<String> = arg(&snake_case, "extraDirs").unwrap();
        assert_eq!(a, b);
        assert_eq!(a, vec!["/a".to_string()]);
    }

    #[test]
    fn a_missing_optional_argument_is_none_not_an_error() {
        let empty = json!({});
        let missing: Option<String> = arg(&empty, "model").unwrap();
        assert!(missing.is_none());
    }

    /// Feedback ddf843b0 / a43d1a92: a root task created without dependsOn
    /// failed with "invalid type: null, expected a sequence".
    #[test]
    fn an_omitted_optional_list_is_empty_not_an_error() {
        let none: Vec<String> = list_arg(&json!({}), "dependsOn").unwrap();
        assert!(none.is_empty());
        let null: Vec<String> = list_arg(&json!({ "dependsOn": null }), "dependsOn").unwrap();
        assert!(null.is_empty());
        let some: Vec<String> = list_arg(&json!({ "depends_on": ["t1"] }), "dependsOn").unwrap();
        assert_eq!(some, vec!["t1".to_string()]);
        let err = list_arg::<String>(&json!({ "dependsOn": "t1" }), "dependsOn").unwrap_err();
        assert!(err.contains("dependsOn"), "{err}");
    }

    #[test]
    fn a_missing_required_argument_says_which_one() {
        let empty = json!({});
        let err = arg::<String>(&empty, "key").unwrap_err();
        assert!(err.contains("key"), "{err}");
    }

    #[test]
    fn snake_conversion_matches_tauris_own() {
        assert_eq!(snake("extraDirs"), "extra_dirs");
        assert_eq!(snake("dataBase64"), "data_base64");
        assert_eq!(snake("path"), "path");
    }

    /// The browser can only call what this table lists. Writing the backend
    /// function and forgetting this row is the whole failure mode: the code
    /// reads as finished, `cargo test` is green, and the client gets "unknown
    /// command" for something that is sitting right there.
    #[test]
    fn a_browser_can_ask_which_agents_are_installed() {
        crate::agents::seed_probe_for_test(vec![("codex".into(), "/opt/bin/codex".into())]);
        let svc = Services::load();
        let out = dispatch(&svc, "agent_installs", json!({})).expect("routed");
        let rows = out.as_array().expect("an array of agents");
        assert_eq!(rows.len(), crate::agent_provider::AgentKind::ALL.len());
        // Every agent is named, installed or not — that IS the answer the page
        // renders, so a missing agent must not be a missing row.
        assert_eq!(rows[0]["id"], "claude");
        assert_eq!(rows[0]["installed"], false);
        assert_eq!(rows[1]["id"], "codex");
        assert_eq!(rows[1]["installed"], true);
        assert_eq!(rows[1]["path"], "/opt/bin/codex");
    }

    #[test]
    fn a_browser_can_ask_for_codex_skills_by_workspace() {
        let svc = Services::load();
        let err = dispatch(&svc, "codex_skills", json!({ "cwd": "relative" })).unwrap_err();
        assert!(
            err.contains("absolute directory"),
            "route reached loader: {err}"
        );
    }

    #[test]
    fn a_browser_can_ask_for_versioned_claude_models() {
        let svc = Services::load();
        let out = dispatch(&svc, "agent_models", json!({ "agent": "claude" })).expect("routed");
        let rows = out["models"].as_array().expect("a model catalog");
        assert!(
            rows.iter().any(|model| model["model"] == "claude-opus-4-6"),
            "the pinned model that motivated discovery is selectable"
        );
    }

    #[test]
    fn a_browser_can_set_a_project_color() {
        let svc = Services::load();
        let err = dispatch(
            &svc,
            "set_workspace_color",
            json!({ "id": "not-a-workspace", "color": "#12ab34" }),
        )
        .expect_err("the route should reach the store even when the id is unknown");
        assert_eq!(err, "workspace not found");
    }

    /// Same failure mode as the row above, and the one the search on the empty
    /// chat page depends on: a phone with no route here shows no history at all.
    /// The machine running the test may have no agent sessions on it, so this
    /// asserts the SHAPE of the answer rather than anything in it.
    #[test]
    fn a_browser_can_ask_for_the_agents_own_past_sessions() {
        let svc = Services::load();
        let out = dispatch(&svc, "agent_history_list", json!({ "limit": 5 })).expect("routed");
        let rows = out.as_array().expect("an array of sessions");
        assert!(rows.len() <= 5, "the limit is respected: {}", rows.len());
    }

    /// Picking a session up into a chat is routed, and refuses a record that
    /// is not a chat's before it reads anything.
    #[test]
    fn a_browser_can_pick_a_past_session_up_into_a_chat() {
        let svc = Services::load();
        let err = dispatch(
            &svc,
            "agent_history_import",
            json!({ "key": "orch:worker", "agent": "claude", "sessionId": "abc" }),
        )
        .expect_err("not a chat");
        assert!(err.contains("not a chat"), "{err}");
    }

    #[test]
    fn a_command_this_backend_does_not_know_is_refused_by_name() {
        let svc = Services::load();
        // This used to be about `pick_folder` and the native dialog it opened,
        // which is a distinction the code stopped making when the window went:
        // there is no desktop app to route anything to, so a command that is
        // not in the table is simply not in the table.
        //
        // The arm is still worth a test, for the reason it exists. The two
        // halves deploy separately, so a page can be newer than the server
        // answering it, and this message is all the user gets when it is — it
        // has to name the command, or "something failed" is the whole report.
        let err = dispatch(&svc, "no_such_command", json!({})).unwrap_err();
        assert!(err.contains("no_such_command"), "{err}");
        assert!(err.contains("not available on this backend"), "{err}");
        // The read-only way out of a refused route is gone with its command:
        // a page that still sends it is told so, and nothing is opened.
        let err = dispatch(&svc, "handover_discuss", json!({ "id": "handover_1" })).unwrap_err();
        assert!(err.contains("'handover_discuss'"), "{err}");
        assert!(err.contains("not available on this backend"), "{err}");
    }

    /// A chat the index lists, removed again when the test ends.
    struct ListedChat {
        id: String,
        key: String,
    }

    impl ListedChat {
        fn new() -> Self {
            let id = format!("dispatch-complete-{}", uuid::Uuid::new_v4().simple());
            crate::chat_index::upsert(
                serde_json::from_value(json!({ "id": id, "projectId": "p1", "updatedAt": 100 }))
                    .unwrap(),
            )
            .unwrap();
            Self {
                key: format!("chat:{id}"),
                id,
            }
        }
    }

    impl Drop for ListedChat {
        fn drop(&mut self) {
            let _ = crate::chat_index::remove(&self.id);
            crate::transcript::forget(&self.key);
        }
    }

    #[test]
    fn the_chats_that_can_never_be_completed_are_refused_by_what_they_are() {
        use crate::orchestration::tests::{run, running_worker, settled_worker};
        let store = OrchestrationStore::default();
        let run = run(&store);
        let chats = ChatManager::default();
        let dir = crate::test_dir::TestDir::new("complete-refusal");
        let team = dir.0.join("team.json");
        std::fs::write(
            &team,
            r#"{"agents":[],"front_desk_chats":[{"chatKey":"chat:desk","agentId":"a1","sessionIds":[],"createdAt":1}]}"#,
        )
        .unwrap();
        let refusal = |key: &str| completion_refusal_in(&store, &chats, &team, key).unwrap();

        // A worker, in a task or long settled, under a key of either kind.
        let running = running_worker(&store, &run).worker_chat_key;
        let settled = settled_worker(&store, &run, Some("chat:legacy-worker")).worker_chat_key;
        for key in [running.as_str(), settled.as_str(), "chat:orch-never-seen"] {
            assert!(refusal(key).unwrap().contains("worker"), "{key}");
        }
        assert!(refusal("chat:desk").unwrap().contains("front desk"));
        // A second voice: its process names another chat.
        chats.test_seat("chat:room#second", "chat:room");
        assert_eq!(
            refusal("chat:room#second"),
            Some("Only a chat's own agent can be completed.")
        );
        // A chat nothing lists has nothing to tick.
        assert_eq!(
            refusal("chat:no-such-chat"),
            Some("This chat is not in the active chat index.")
        );

        // An ordinary chat, running or not, and the coordinator of a run.
        let chat = ListedChat::new();
        assert_eq!(refusal(&chat.key), None);
        chats.test_launch(&chat.key);
        assert_eq!(refusal(&chat.key), None);
        chats.test_end(&chat.key);
    }

    #[test]
    fn completing_a_chat_is_routed_refused_and_queued_through_dispatch() {
        let svc = Services::load();
        let refused = dispatch(
            &svc,
            "chat_complete",
            json!({ "chatKey": "chat:orch-some-worker" }),
        )
        .unwrap_err();
        assert!(refused.contains("worker"), "{refused}");

        // No process and nothing to start one with: the page asks again
        // with `start`, and nothing was left completing.
        let chat = ListedChat::new();
        let idle = dispatch(&svc, "chat_complete", json!({ "chatKey": chat.key })).unwrap_err();
        assert_eq!(idle, format!("chat '{}' is not running", chat.key));
        assert_eq!(svc.chats.completing_turn(&chat.key), None);

        // A start that cannot happen leaves it not completing either.
        let failed = dispatch(
            &svc,
            "chat_complete",
            json!({ "chatKey": chat.key, "start": { "agent": "claude" } }),
        )
        .unwrap_err();
        assert!(failed.contains("cwd"), "{failed}");
        assert_eq!(svc.chats.completing_turn(&chat.key), None);

        // A running chat: the wrap-up waits behind the turn in flight.
        svc.chats.test_launch(&chat.key);
        svc.chats.test_busy(&chat.key, true);
        let out = dispatch(&svc, "chat_complete", json!({ "chatKey": chat.key })).unwrap();
        assert_eq!(out["state"], "queued");
        let turn_id = out["turnId"].as_str().unwrap().to_string();
        assert!(turn_id.starts_with(crate::agent_chat::COMPLETION_TURN_PREFIX));
        assert_eq!(svc.chats.completing_turn(&chat.key), Some(turn_id.clone()));
        // It is the host's wording that was queued, not anything the page sent.
        let recorded = crate::transcript::since(&chat.key, 0);
        assert_eq!(
            recorded[0].event["message"]["content"][0]["text"],
            crate::agent_chat::wrap_up_message(false, &[])
        );
        let again = dispatch(&svc, "chat_complete", json!({ "chatKey": chat.key })).unwrap_err();
        assert_eq!(again, "This chat is already completing.");

        let preview = dispatch(
            &svc,
            "chat_complete_preview",
            json!({ "chatKey": chat.key }),
        )
        .unwrap();
        assert_eq!(preview["chatKey"], chat.key.as_str());
        assert_eq!(preview["completingTurnId"], turn_id.as_str());
        assert_eq!(preview["running"], true);
        assert_eq!(preview["registeredAgent"], false);
        assert_eq!(preview["runs"], json!([]));
        assert!(preview.get("refusal").is_none(), "{preview}");

        // The ✕ on the queued wrap-up, through the page's own command.
        assert_eq!(
            dispatch(
                &svc,
                "chat_cancel_queued",
                json!({ "key": chat.key, "turnId": turn_id }),
            ),
            Ok(json!(true))
        );
        assert_eq!(svc.chats.completing_turn(&chat.key), None);
        svc.chats.test_end(&chat.key);

        let worker = dispatch(
            &svc,
            "chat_complete_preview",
            json!({ "chatKey": "chat:orch-some-worker" }),
        )
        .unwrap();
        assert!(worker["refusal"].as_str().unwrap().contains("worker"));
    }

    /// Completing a chat is the person's own action, like closing a mission.
    /// No hook may call it and the MCP server offers no such tool.
    #[test]
    fn no_hook_and_no_mcp_tool_can_complete_a_chat() {
        for (name, source) in [
            ("web.rs", include_str!("web.rs")),
            (
                "octiq-ask.cjs",
                include_str!("../../scripts/mcp/octiq-ask.cjs"),
            ),
        ] {
            assert!(!source.contains("chat_complete"), "{name}");
        }
    }

    /// The services of a server whose one project is the folder `root`, so
    /// the page's file editor may save inside it.
    fn editing_in(root: &std::path::Path) -> Services {
        let project = serde_json::from_value(json!({
            "id": "project", "name": "Project", "primary_path": root,
        }))
        .unwrap();
        Services {
            workspaces: Arc::new(WorkspaceState::with_projects(vec![project])),
            chats: Arc::new(ChatManager::default()),
            watch: Arc::new(FileWatchState::default()),
            git_watch: Arc::new(GitWatchState::default()),
            orchestrations: Arc::new(OrchestrationStore::default()),
            ptys: Arc::new(PtyManager::default()),
            handovers: crate::handover::Wiring::scratch(),
        }
    }

    fn editor_saves(services: &Services, path: &std::path::Path, text: &str) -> Result<(), String> {
        dispatch(
            services,
            "write_file",
            json!({ "path": path, "content": text }),
        )
        .map(|_| ())
    }

    /// Review of bf9d8cd, finding 4, through the door the page's Save uses:
    /// `write_file` wrote over a chat's record with a bare `fs::write`,
    /// behind the record's own functions, so a notice the host held a
    /// receipt for was gone and the record's generation had not moved. The
    /// home folder is a write root and holds the profile, so every install
    /// could; here a project that holds the profile stands for it.
    #[test]
    fn the_file_editor_does_not_write_over_a_chat_record() {
        let home = crate::test_dir::TestDir::new("editor-record").canonicalized();
        let _process = crate::profile::started_in(&home);
        let key = format!("chat:editor-{}", uuid::Uuid::new_v4().simple());
        let notice = json!({ "type": "octiq_task_reopened", "taskId": "task_1" });
        assert!(crate::transcript::append_synced(&key, &notice).is_some());
        let record = crate::transcript::path_for(&key).unwrap();
        let before = std::fs::read(&record).unwrap();

        let services = editing_in(&home);
        let refused = editor_saves(&services, &record, "{\"type\":\"assistant\"}\n");
        assert_eq!(
            std::fs::read(&record).unwrap(),
            before,
            "the editor wrote over a chat's record"
        );
        let why = refused.unwrap_err();
        assert!(why.contains("OctiqFlow keeps"), "{why}");

        // Reading it is as before.
        let shown = dispatch(&services, "read_file_preview", json!({ "path": record })).unwrap();
        assert!(shown["content"]
            .as_str()
            .unwrap()
            .contains("octiq_task_reopened"));
    }

    /// A message is not sent, and no chat started, while the profile folder
    /// is away: the turn's record could not be kept. The page shows the
    /// answer under the message, and reads the same from `profile_status`.
    #[test]
    fn a_message_is_refused_in_words_while_the_profile_folder_is_away() {
        let home = crate::profile::tests::Home::with_a_configured_base();
        let _process = crate::profile::started_in(&home.dir);
        let services = editing_in(&home.dir);
        let dir = crate::profile::profile_dir();
        home.unplug();
        let why = dispatch(
            &services,
            "chat_send",
            json!({ "key": "chat:away", "text": "Hello" }),
        )
        .unwrap_err();
        assert!(why.contains(&dir.display().to_string()), "{why}");
        assert!(why.contains("nothing was saved"), "{why}");
        let status = dispatch(&services, "profile_status", json!({})).unwrap();
        assert_eq!(status["available"], false);
        assert_eq!(status["notice"], why);
        assert_eq!(status["dir"], json!(dir));
    }

    /// Review of 8169dd3, RULE 3, through the doors the page reads by: a
    /// read from a profile that is gone is an error carrying the profile's
    /// one sentence, never what a first run would answer. An empty answer
    /// drew a blank form the person could save over their own data. Gone
    /// three ways: its drive, the folder itself, another folder in its
    /// place. Every one answers again, unchanged, once the folder is back.
    #[test]
    fn what_the_page_reads_is_an_error_while_the_profile_folder_is_gone() {
        use crate::profile::tests::Home;
        let home = Home::with_a_configured_base();
        let _process = crate::profile::started_in(&home.dir);
        let dir = crate::profile::profile_dir();
        crate::profile_lock::acquire("server").unwrap();
        // The roster's path is one global in tests: hold it at the profile's.
        let _roster = crate::team::use_test_path(dir.join("team.json"));
        let services = Services {
            handovers: crate::handover::Wiring::profile(),
            ..editing_in(&home.dir)
        };
        crate::personal_preferences::save(&crate::personal_preferences::default_path(), "my rules")
            .unwrap();
        let key = format!("chat:read-{}", uuid::Uuid::new_v4().simple());
        let said = json!({ "type": "assistant", "message": { "content": "Said" } });
        assert_eq!(crate::transcript::append(&key, &said), Some(1));
        let reads = [
            ("personal_preferences", json!({})),
            ("memory_vault_settings", json!({})),
            ("team_list", json!({ "all": true })),
            ("team_policy", json!({})),
            ("team_head", json!({})),
            ("team_home", json!({})),
            ("team_front_desk", json!({})),
            ("team_leads", json!({})),
            ("agent_team_list", json!({})),
            ("handover_list", json!({})),
            ("front_desk_unfinished", json!({})),
            (
                "feedback_list",
                json!({ "query": "", "offset": 0, "limit": 30 }),
            ),
            ("sandbox_snapshot", json!({})),
            ("chat_index_list", json!({})),
            ("chat_index_deleted", json!({})),
            ("chat_since", json!({ "key": key, "after": 0 })),
            ("chat_page", json!({ "key": key })),
            ("chat_task", json!({ "chatId": "read" })),
            ("image_preview_list", json!({ "key": key })),
        ];
        let answers = |when: &str| -> Vec<Value> {
            reads
                .iter()
                .map(|(command, args)| {
                    dispatch(&services, command, args.clone())
                        .unwrap_or_else(|why| panic!("{command} {when}: {why}"))
                })
                .collect()
        };
        let at_first = answers("with the profile there");
        assert_eq!(at_first[0]["text"], "my rules");

        type Way = (fn(&Home), fn(&Home));
        let ways: [Way; 3] = [
            (Home::unplug, Home::plug_back),
            (Home::move_away, Home::move_back),
            (Home::replace, Home::move_back),
        ];
        for (goes, comes_back) in ways {
            goes(&home);
            let why = crate::profile::available().expect_err("the profile folder is not there");
            let mut answered = Vec::new();
            for (command, args) in &reads {
                match dispatch(&services, command, args.clone()) {
                    Err(said) if said == why => {}
                    other => answered.push(format!("{command}: {other:?}")),
                }
            }
            assert!(
                answered.is_empty(),
                "read as something other than the profile's own error:\n{}",
                answered.join("\n")
            );
            comes_back(&home);
            // What does not depend on the clock answers exactly as before.
            let again = answers("with the profile back");
            for at in [0, 1, 2, 3, 9, 15, 16] {
                assert_eq!(again[at], at_first[at], "{}", reads[at].0);
            }
        }
    }

    /// The rule is the folder, not a list of names: everything in the
    /// profile folder is some module's state (the roster, the ledger, the
    /// server's token, the chat index), a file not made yet included. What
    /// the person keeps there by hand stays theirs to edit.
    #[test]
    fn the_file_editor_writes_nothing_a_store_owns_in_the_profile_folder() {
        let home = crate::test_dir::TestDir::new("editor-profile").canonicalized();
        let _process = crate::profile::started_in(&home);
        let profile = crate::profile::profile_dir();
        let services = editing_in(&home);
        std::fs::create_dir_all(profile.join("chats")).unwrap();
        for owned in [
            "team.json",
            "orchestrations.json",
            "web.json",
            "workspaces.json",
            "safety-authorizations.json",
            "owner.lock",
            "chats/index.json",
            "chats/questions.json",
            "chats/chat_never-made.jsonl",
        ] {
            let target = profile.join(owned);
            // The owner lock is there already: the server left its mark.
            let before = std::fs::read(&target).ok();
            assert_eq!(before.is_some(), owned == "owner.lock", "{owned}");
            let refused = editor_saves(&services, &target, "{}");
            assert_eq!(std::fs::read(&target).ok(), before, "{owned} was written");
            assert!(refused.unwrap_err().contains("OctiqFlow keeps"), "{owned}");
        }

        // The person's own: their notify hook and what is on a canvas.
        std::fs::create_dir_all(profile.join("canvas").join("project")).unwrap();
        for theirs in ["notify-hook", "canvas/project/plan.md"] {
            let target = profile.join(theirs);
            assert_eq!(editor_saves(&services, &target, "mine"), Ok(()), "{theirs}");
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "mine");
        }
        // And a project file is written as it always was.
        let note = home.join("notes.md");
        assert_eq!(editor_saves(&services, &note, "a note"), Ok(()));
        assert_eq!(std::fs::read_to_string(&note).unwrap(), "a note");
    }
}

//! Peer request: a registered agent asking a teammate to DO one bounded piece
//! of work and hand back a defined result.
//!
//! `peer.rs` is a question and an answer; this is work. It is still not a
//! change to the org chart: nothing here reads or writes `reportsTo`, and the
//! teammate keeps reporting to whoever it reported to. The host decides every
//! part of it, so none of it rests on an agent's word:
//!
//! - Two kinds of chat may ask: the chat of a RUNNING attempt whose task was
//!   handed to a registered agent, and a registered lead's own agents-mode
//!   chat (`peer::LeadCaller`). Only a registered member of the requester's
//!   own team (`team::teammates`) may be asked.
//! - A request becomes ONE ordinary task assigned to the teammate, marked
//!   with who asked (`Task::peer_request`). It waits on the plan card like any
//!   task added to an approved plan, and no worker starts before the person
//!   approves. A worker's request lives in the worker's own run; a lead
//!   chat's in the live run that chat coordinates, which the host opens when
//!   the chat has none.
//! - The teammate runs as its registered identity (provider, model, effort,
//!   access) under the destination's ordinary workspace policy, and only
//!   where both it and the requester may work (`destination::route_lateral`).
//!   A start with any other settings is refused (`keeps_to_identity`).
//! - Bounds: `MAX_REQUESTS_PER_ATTEMPT` per worker attempt,
//!   `MAX_OPEN_REQUESTS_PER_LEAD_CHAT` open at once per lead chat,
//!   `MAX_REQUEST_CHARS` of request text, and `max_minutes` of running time
//!   (`expire`, on the scheduler's pass: no timer of its own).
//! - Depth: a peer-request task cannot be split, and its worker cannot make a
//!   peer request. It may still ask a question (`peer.rs`).
//! - When the teammate's attempt settles, the run's coordinator is told as
//!   for any task, and a requesting worker whose attempt is still running is
//!   told too (`tell_requester`). The task keeps the report (`Task::result`).
use super::peer::LeadCaller;
use super::*;
use crate::team::{AgentTeam, TeamAgent};

/// Peer requests one worker attempt may make, whatever became of them.
pub const MAX_REQUESTS_PER_ATTEMPT: usize = 2;
/// Peer requests one lead chat may have open (not yet settled) at once.
pub const MAX_OPEN_REQUESTS_PER_LEAD_CHAT: usize = 3;
/// The longest request text.
pub const MAX_REQUEST_CHARS: usize = 4_000;
/// The longest description of the result expected back.
pub const MAX_OUTPUT_CHARS: usize = 1_000;
/// How long the teammate's attempt may run when the request does not say.
pub const DEFAULT_MINUTES: u32 = 30;
/// The longest a request may allow.
pub const MAX_MINUTES: u32 = 120;
/// Why an attempt that outran its request was ended.
pub const TIME_LIMIT_REASON: &str = "peer request time limit";

/// What makes a task a peer request: who asked, and the bounds they set.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRequest {
    /// The registered agent that asked. A copy, like `Task::assignee`.
    pub requested_by: TaskAssignee,
    /// The chat that asked: a lead's own chat, or a worker's.
    pub requester_chat_key: String,
    /// The requester's attempt, when it is a worker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester_attempt_id: Option<String>,
    /// The result the requester expects back.
    pub output: String,
    /// How long the teammate's attempt may run.
    pub max_minutes: u32,
    pub requested_at: i64,
}

/// One request, as the tool call gave it.
#[derive(Clone, Debug, Default)]
pub struct PeerWork {
    /// The teammate: an agent id, or its exact name.
    pub peer: String,
    pub title: String,
    pub request: String,
    pub output: String,
    pub project: Option<String>,
    pub repository: Option<String>,
    pub max_minutes: Option<u32>,
}

/// What the requester's tool call returns.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRequested {
    pub task_id: String,
    pub run_id: String,
    /// The host opened this run for the request.
    pub run_created: bool,
    pub teammate: TaskAssignee,
    /// Always `awaiting_approval`: nothing has started.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<TaskDestination>,
    pub max_minutes: u32,
    /// How many more requests this attempt may make, or this chat may open.
    pub requests_left: usize,
    pub note: String,
}

/// The teammate a request may go to: a registered member of the requester's
/// own team, not itself. By id, or by exact name. Whether it may work in the
/// destination is the routing's question (`destination::route_lateral`).
pub fn choose_peer<'a>(
    agents: &'a [TeamAgent],
    teams: &[AgentTeam],
    requester_id: &str,
    peer: &str,
) -> Result<&'a TeamAgent, String> {
    let peer = peer.trim();
    let requester = agents
        .iter()
        .find(|a| a.id == requester_id)
        .ok_or("You are no longer a registered agent, so you have no team to ask.")?;
    let team = requester
        .team_id
        .as_deref()
        .and_then(|id| teams.iter().find(|t| t.id == id))
        .ok_or("You are not on a team, so there is no teammate to hand work to. Do it yourself, or tell whoever you report to.")?;
    if peer.is_empty() {
        return Err("Name the teammate with `peer`: its id or name.".into());
    }
    if peer == requester.id || peer.eq_ignore_ascii_case(&requester.name) {
        return Err("You cannot hand work to yourself. Do it, or name a teammate.".into());
    }
    let mates = crate::team::teammates(agents, teams, requester);
    let listed = || {
        if mates.is_empty() {
            format!("no one else is on your team ({})", team.name)
        } else {
            format!(
                "your teammates on {} are {}",
                team.name,
                mates
                    .iter()
                    .map(|a| format!("{} (`{}`)", a.name, a.id))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
    };
    let found = agents
        .iter()
        .find(|a| a.id == peer)
        .or_else(|| agents.iter().find(|a| a.name.eq_ignore_ascii_case(peer)))
        .ok_or_else(|| format!("No registered agent is called {peer}; {}.", listed()))?;
    if found.team_id.as_deref() != Some(team.id.as_str()) {
        return Err(format!(
            "{} is not on your team, so you cannot hand it work; {}.",
            found.name,
            listed()
        ));
    }
    Ok(found)
}

/// A start of a peer-request task must be the teammate's registered identity,
/// as the plan the person approved names it: the same provider and model, the
/// same effort, the same access. A coordinator's manual start, a page retry
/// and a recovery are all held to it.
pub(super) fn keeps_to_identity(
    approved: &automation::WorkerSettings,
    asked: &automation::WorkerSettings,
    effort: Option<&str>,
    peer: &str,
) -> Result<(), String> {
    if asked.agent == approved.agent
        && asked.model == approved.model
        && asked.access == approved.access
        && effort == approved.effort.as_deref()
    {
        return Ok(());
    }
    let effort_of = |effort: Option<&str>| effort.unwrap_or("default").to_owned();
    Err(format!(
        "This task is a peer request to {peer}, approved to run as {} ({} effort) at {} access; this start asks for {} ({} effort) at {} access. A peer runs only as its registered identity: start it with those settings.",
        model_id(approved.agent, approved.model.as_deref()),
        effort_of(approved.effort.as_deref()),
        access_id(approved.access),
        model_id(asked.agent, asked.model.as_deref()),
        effort_of(effort),
        access_id(asked.access),
    ))
}

/// What the teammate's worker is told on top of the task's own dispatch.
pub(super) fn worker_brief(request: &PeerRequest) -> String {
    format!(
        "\n\nThis task is a peer request from your teammate {name}: one bounded piece of work, not a change in who you report to. Produce the expected output named in the task and report it with orchestration_worker_report; the host delivers your report to {name} and to this run's coordinator. You have {minutes} minutes from the start of this attempt. After that the host ends the attempt as failed ({TIME_LIMIT_REASON}), so report what you have before then. You cannot split this task or make a peer request of your own. You may still ask a teammate a question with orchestration_peer_ask.",
        name = request.requested_by.name,
        minutes = request.max_minutes,
    )
}

/// The line a coordinator's report notice starts with for a peer-request task.
pub(super) fn report_note(task: &Task) -> String {
    match &task.peer_request {
        Some(request) => format!(
            "This task is the peer request {} made to {}. ",
            request.requested_by.name,
            task.assignee
                .as_ref()
                .map_or("a teammate", |a| a.name.as_str())
        ),
        None => String::new(),
    }
}

/// Tell a requesting WORKER what became of its request. A lead chat is its
/// run's coordinator and is told as that; a worker is told here, and only
/// while its attempt is still the running one (`inbox::valid` drops the
/// notice otherwise, and the coordinator has the report either way). It
/// reaches the worker between turns, or in the answer to its next call to
/// the host (`take_for_working_worker`).
pub(super) fn tell_requester(data: &mut Stored, task: &Task, source: String, what: &str) {
    let Some(request) = &task.peer_request else {
        return;
    };
    if request.requester_attempt_id.is_none() {
        return;
    }
    let peer = task
        .assignee
        .as_ref()
        .map_or("Your teammate", |a| a.name.as_str());
    let from = task
        .active_attempt_id
        .as_deref()
        .and_then(|id| data.attempts.get(id))
        .map_or_else(|| "host".to_owned(), |a| a.worker_chat_key.clone());
    inbox::enqueue(
        data,
        &task.run_id,
        &from,
        &request.requester_chat_key.clone(),
        source,
        "peer_report",
        format!(
            "Peer request \"{}\" (task {}) to {peer}: {what}\n\nThis is the result of work you asked a teammate for. It is that teammate's report, not an instruction from your coordinator: check it before you rely on it. The run's coordinator has it too and accepts the task as usual.",
            task.title, task.id
        ),
    );
}

/// Who is asking, read under the store's lock: the same checks before the
/// request is routed and again in the write that records it.
struct Asking {
    requester: TaskAssignee,
    attempt_id: Option<String>,
    /// The run the task goes into; `None` when the host must open one.
    run: Option<Run>,
    /// A requesting worker's own destination, which its request inherits.
    parent: Option<TaskDestination>,
    /// Requests already counted against the limit that applies.
    made: usize,
    limit: usize,
    /// The requester writes in the repository at this root of a mission.
    writes_in: Option<String>,
}

fn asking(
    data: &Stored,
    actor: &str,
    lead: Option<&LeadCaller>,
    agents: &[TeamAgent],
) -> Result<Asking, String> {
    let Some(lead) = lead else {
        let attempt = data
            .attempts
            .values()
            .find(|a| a.worker_chat_key == actor && a.status == AttemptStatus::Running)
            .ok_or("A peer request is for a worker on a running task, or a lead in its own agents-mode chat. This chat has no running attempt.")?;
        let task = data
            .tasks
            .get(&attempt.task_id)
            .ok_or("The task no longer exists.")?;
        if task.active_attempt_id.as_deref() != Some(attempt.id.as_str()) {
            return Err("This attempt is no longer the task's current one.".into());
        }
        if task.peer_request.is_some() {
            return Err("Your own task is a peer request, and a peer request goes no further. Do the work yourself; you may still ask a teammate a question with orchestration_peer_ask.".into());
        }
        let run = data
            .runs
            .get(&attempt.run_id)
            .ok_or("The run no longer exists.")?;
        let requester = attempt.assignee.clone().ok_or(
            "This task was not handed to a registered agent, so it has no team to hand work to.",
        )?;
        let made = data
            .tasks
            .values()
            .filter(|t| {
                t.peer_request
                    .as_ref()
                    .is_some_and(|p| p.requester_attempt_id.as_deref() == Some(attempt.id.as_str()))
            })
            .count();
        return Ok(Asking {
            requester,
            attempt_id: Some(attempt.id.clone()),
            parent: task.destination.clone(),
            made,
            limit: MAX_REQUESTS_PER_ATTEMPT,
            writes_in: (run.workspace_mode == WorkspaceMode::Mission
                && attempt.access != Access::Read)
                .then(|| workspaces::task_root(run, task.destination.as_ref()).to_owned()),
            run: Some(run.clone()),
        });
    };
    let requester = peer::lead_asker(data, actor, lead, agents)?;
    let made =
        data.tasks
            .values()
            .filter(|t| {
                t.peer_request.as_ref().is_some_and(|p| {
                    p.requester_chat_key == actor && p.requester_attempt_id.is_none()
                }) && matches!(
                    t.status,
                    TaskStatus::Pending
                        | TaskStatus::Ready
                        | TaskStatus::Running
                        | TaskStatus::Blocked
                )
            })
            .count();
    Ok(Asking {
        requester,
        attempt_id: None,
        run: peer::live_run_of(data, actor).cloned(),
        parent: None,
        made,
        limit: MAX_OPEN_REQUESTS_PER_LEAD_CHAT,
        writes_in: None,
    })
}

fn over_limit(asking: &Asking) -> Result<(), String> {
    if asking.made < asking.limit {
        return Ok(());
    }
    Err(if asking.attempt_id.is_some() {
        format!(
            "This attempt has made {MAX_REQUESTS_PER_ATTEMPT} peer requests, which is the limit. Carry on with what you have, or tell your coordinator what else is needed."
        )
    } else {
        format!(
            "This chat already has {MAX_OPEN_REQUESTS_PER_LEAD_CHAT} peer requests open, which is the limit. Wait for one to settle, or withdraw one that has not started."
        )
    })
}

/// A request's text, trimmed and inside its bound.
fn bounded_text(label: &str, value: &str, max: usize, hint: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("A peer request needs {label}."));
    }
    if value.chars().count() > max {
        return Err(format!("Keep {label} under {max} characters. {hint}"));
    }
    Ok(value.to_owned())
}

impl OrchestrationStore {
    /// Record one peer request from `actor` as a task for its teammate,
    /// waiting for the person. Nothing starts here: the plan card decides.
    /// `projects` is every registered project, for the destination.
    pub fn peer_request(
        &self,
        actor: &str,
        lead: Option<&LeadCaller>,
        work: PeerWork,
        agents: &[TeamAgent],
        teams: &[AgentTeam],
        projects: &[Workspace],
    ) -> Result<PeerRequested, String> {
        validate_chat_key(actor)?;
        let title = required_text("task title", work.title.clone(), 240)?;
        let request = bounded_text(
            "`request`: the work to do",
            &work.request,
            MAX_REQUEST_CHARS,
            "A peer request is one bounded piece of work; say where the detail lives instead of pasting it.",
        )?;
        let output = bounded_text(
            "`output`: the result you expect back",
            &work.output,
            MAX_OUTPUT_CHARS,
            "Name the result, not how to reach it.",
        )?;
        let max_minutes = work.max_minutes.unwrap_or(DEFAULT_MINUTES);
        if !(1..=MAX_MINUTES).contains(&max_minutes) {
            return Err(format!(
                "maxMinutes must be between 1 and {MAX_MINUTES}. Anything longer is a task for the teammate's own lead to plan."
            ));
        }

        // Read who asks and where, then route and plan the workspace (which
        // reads Git) with the store unlocked, as a new task's is.
        let before = {
            let inner = self.inner.lock().map_err(|error| error.to_string())?;
            if let Some(error) = &inner.load_error {
                return Err(error.clone());
            }
            asking(&inner.data, actor, lead, agents)?
        };
        let peer = choose_peer(agents, teams, &before.requester.id, &work.peer)?;
        over_limit(&before)?;
        let now = now_ms();
        let run_created = before.run.is_none();
        let run = match (&before.run, lead) {
            (Some(run), _) => run.clone(),
            (None, Some(lead)) => Run {
                id: format!("run_{}", compact_id()),
                objective: format!("Peer requests from {}", before.requester.name),
                coordinator_chat_key: actor.to_owned(),
                workspace_id: lead.project_id.clone(),
                root_path: lead.cwd.clone(),
                status: RunStatus::Planning,
                max_concurrent: DEFAULT_MAX_CONCURRENT,
                // What a lead's own run is in agents mode (`dispatch`).
                workspace_mode: WorkspaceMode::Mission,
                // The host starts the teammate once the person approves; the
                // task names its own worker, so no provider is defaulted.
                worker_defaults: Some(automation::WorkerDefaults {
                    agent: None,
                    access: Access::Auto,
                    model: None,
                    effort: None,
                    recovery: None,
                }),
                plan_approval: Some(PlanApproval::pending(now)),
                created_at: now,
                updated_at: now,
                stopped_reason: None,
                archived_at: None,
                closed_at: None,
                abandoned: false,
                mission_delivery: Vec::new(),
            },
            (None, None) => return Err("The run no longer exists.".into()),
        };
        if run.archived_at.is_some() {
            return Err("This run is archived. Restore it before adding work.".into());
        }
        let routed = destination::route_lateral(
            agents,
            projects,
            &destination::Route {
                who: Some(&peer.id),
                project: work.project.as_deref(),
                repository: work.repository.as_deref(),
                manager: Some(&before.requester.id),
                cross_project: lead.is_some_and(|lead| lead.cross_project),
                run_project: &run.workspace_id,
                parent: before.parent.as_ref(),
            },
        )?;
        let peer = routed
            .assignee
            .ok_or("The teammate could not be resolved.")?;
        let worker = automation::WorkerSettings {
            agent: peer.agent,
            access: peer.access,
            model: Some(peer.model.clone()),
            effort: peer.effort.clone(),
            recovery: None,
        }
        .normalized()?;
        let teammate = TaskAssignee {
            id: peer.id.clone(),
            name: peer.name.clone(),
        };
        let destination = routed.destination;
        let id = format!("task_{}", compact_id());
        let proposal = workspaces::propose(&run, &id, destination.as_ref(), Some(&worker));
        let spec = format!("{request}\n\nExpected output\n{output}");

        let mut reopened_plan = false;
        let (task, left, waits_for_requester) = self.mutate(|data| {
            let current = asking(data, actor, lead, agents)?;
            over_limit(&current)?;
            // Routed and planned against `run`: a run that appeared or went
            // away meanwhile would put the task somewhere nobody checked.
            if current.run.as_ref().map(|r| &r.id) != before.run.as_ref().map(|r| &r.id)
                || current.attempt_id != before.attempt_id
            {
                return Err("This chat's run changed while the request was being prepared. Call orchestration_peer_request again.".into());
            }
            if run_created {
                data.runs.insert(run.id.clone(), run.clone());
            }
            let live = data.runs.get(&run.id).ok_or("The run no longer exists.")?;
            if live.archived_at.is_some() || run_has_ended(live) {
                return Err("This run has ended, so it takes no new work.".into());
            }
            let coordinator = live.coordinator_chat_key.clone();
            let waits_for_requester = current.writes_in.as_deref().is_some_and(|root| {
                worker.access != Access::Read
                    && workspaces::task_root(live, destination.as_ref()) == root
            });
            let now = now_ms();
            let task = Task {
                id: id.clone(),
                run_id: run.id.clone(),
                title: title.clone(),
                spec: spec.clone(),
                worker: Some(worker.clone()),
                assignee: Some(teammate.clone()),
                destination: destination.clone(),
                approved_at: None,
                approval_rollback: None,
                card: None,
                size: Some(TaskSize::default()),
                acceptance: None,
                workspace: None,
                workspace_proposal: Some(proposal.clone()),
                depends_on: Vec::new(),
                parent_task_id: None,
                status: TaskStatus::Ready,
                active_attempt_id: None,
                result: None,
                environment: TaskEnvironment::None,
                kind: TaskKind::Work,
                verdict: None,
                handoffs: Vec::new(),
                superseded_by: None,
                peer_request: Some(PeerRequest {
                    requested_by: current.requester.clone(),
                    requester_chat_key: actor.to_owned(),
                    requester_attempt_id: current.attempt_id.clone(),
                    output: output.clone(),
                    max_minutes,
                    requested_at: now,
                }),
                created_at: now,
                updated_at: now,
            };
            data.tasks.insert(task.id.clone(), task.clone());
            let live = data.runs.get_mut(&run.id).expect("read above");
            live.status = RunStatus::Running;
            live.updated_at = now;
            // The person approves it like any task added to a plan. A run
            // that never asked for approval asks now: a request is never
            // started on an agent's word alone.
            match live.plan_approval.as_mut() {
                Some(plan) if plan.status != PlanStatus::Pending => {
                    plan.status = PlanStatus::Pending;
                    plan.requested_at = now;
                    plan.decided_at = None;
                    reopened_plan = true;
                }
                Some(_) => {}
                None => {
                    live.plan_approval = Some(PlanApproval::pending(now));
                    reopened_plan = true;
                }
            }
            // A worker's request is new work in someone else's run: its
            // coordinator hears of it from the host, not from the plan card.
            if coordinator != actor {
                inbox::enqueue(
                    data,
                    &run.id,
                    actor,
                    &coordinator,
                    format!("peer-request:{}", task.id),
                    "peer_request",
                    format!(
                        "{} asked its teammate {} to do \"{}\" as a peer request: task {}. It waits on the plan card for the person's approval with the rest of the plan, and nothing starts before that. It runs as {}'s registered identity for at most {} minutes. Accept its result as usual; the report also goes to {} while its attempt runs. reportsTo is unchanged for both.",
                        current.requester.name,
                        teammate.name,
                        task.title,
                        task.id,
                        teammate.name,
                        max_minutes,
                        current.requester.name,
                    ),
                );
            }
            Ok((
                task,
                current.limit.saturating_sub(current.made + 1),
                waits_for_requester,
            ))
        })?;
        if run_created {
            announce(&run.id, "run_created");
        }
        announce(&run.id, "task_created");
        if reopened_plan || run_created {
            announce(&run.id, "plan_pending");
        }
        let delivery = if before.attempt_id.is_some() {
            "Do not wait for it: carry on with your own task. Its report reaches you in the answer to one of your next calls to OctiqFlow while your attempt runs, and your coordinator has it either way."
        } else {
            "End your turn so the person can decide on the plan card. The host starts the teammate once they approve and tells you when it reports; you accept the result as usual."
        };
        let waits = if waits_for_requester {
            " This run is a mission with one writer per repository at a time, and you are writing in that repository: the teammate starts there only after your attempt settles, so its report will go to your coordinator."
        } else {
            ""
        };
        Ok(PeerRequested {
            task_id: task.id,
            run_id: run.id,
            run_created,
            status: "awaiting_approval",
            note: format!(
                "Recorded as a task for {}, waiting for the person's approval. Nothing has started. {delivery}{waits}",
                teammate.name
            ),
            teammate,
            destination,
            max_minutes,
            requests_left: left,
        })
    }

    /// End every peer-request attempt that has run longer than its request
    /// allowed, as failed with `TIME_LIMIT_REASON`. Called on the scheduler's
    /// pass; the same pass stops a failed attempt's process
    /// (`recover_due_workers`), so nothing here owns a timer or a process.
    ///
    /// The clock is the attempt's own, and starts again when a decision it
    /// waited on comes back: an attempt parked on a gate or a safety card is
    /// waiting for the person, not working.
    pub(crate) fn expire_peer_requests(&self, now: i64) -> Result<Vec<String>, String> {
        let due = |data: &Stored| -> Vec<(String, u32)> {
            data.attempts
                .values()
                .filter(|a| matches!(a.status, AttemptStatus::Preparing | AttemptStatus::Running))
                .filter_map(|attempt| {
                    let task = data.tasks.get(&attempt.task_id)?;
                    let request = task.peer_request.as_ref()?;
                    if task.active_attempt_id.as_deref() != Some(attempt.id.as_str()) {
                        return None;
                    }
                    let since = data
                        .gates
                        .values()
                        .filter(|gate| {
                            gate.task_id.as_deref() == Some(task.id.as_str())
                                && gate.status != GateStatus::Open
                        })
                        .map(|gate| gate.updated_at)
                        .fold(attempt.created_at, i64::max);
                    (now - since >= i64::from(request.max_minutes) * 60_000)
                        .then(|| (attempt.id.clone(), request.max_minutes))
                })
                .collect()
        };
        {
            let inner = self.inner.lock().map_err(|error| error.to_string())?;
            if inner.load_error.is_some() || due(&inner.data).is_empty() {
                return Ok(Vec::new());
            }
        }
        let ended = self.mutate(|data| {
            let mut ended = Vec::new();
            for (id, minutes) in due(data) {
                let Some(attempt) = data.attempts.get(&id).cloned() else {
                    continue;
                };
                if crate::safety_block::awaits_decision(&attempt.worker_chat_key) {
                    continue;
                }
                let error = execution::ExecutionError {
                    kind: "time_limit".into(),
                    message: format!(
                        "{TIME_LIMIT_REASON}: the attempt ran past the {minutes} minutes its request allowed, so the host ended it. Its workspace is preserved."
                    ),
                    at: now,
                    retryable: false,
                };
                // `fail` tells the run's coordinator and a requesting worker.
                if !execution::fail(data, &id, error, now) {
                    continue;
                }
                ended.push((attempt.run_id, attempt.worker_chat_key));
            }
            Ok(ended)
        })?;
        for (run, _) in &ended {
            announce(run, "worker_failed");
        }
        Ok(ended.into_iter().map(|(_, key)| key).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{launch_for, run};
    use super::*;
    use crate::test_dir::{TestDir, TestPath};

    fn agent(id: &str, team: Option<&str>, project: Option<&str>) -> TeamAgent {
        TeamAgent {
            id: id.into(),
            name: id.to_uppercase(),
            role: format!("{id} role"),
            agent: ChatAgent::Claude,
            model: "sonnet".into(),
            effort: Some("high".into()),
            access: Access::Auto,
            project_id: project.map(Into::into),
            reports_to: None,
            memory_note: None,
            avatar: None,
            team_id: team.map(Into::into),
            created_at: 0,
            updated_at: 0,
            persistent_prompt: String::new(),
        }
    }

    fn team(id: &str) -> AgentTeam {
        AgentTeam {
            id: id.into(),
            name: format!("Team {id}"),
            project_id: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    /// Ada, Bo (Codex, edits access) and Fa (a lead-only model) share team
    /// t1 with Di, who works only in p2; Cy is on another team, Ed on none.
    fn roster() -> (Vec<TeamAgent>, Vec<AgentTeam>) {
        (
            vec![
                agent("ada", Some("t1"), None),
                TeamAgent {
                    agent: ChatAgent::Codex,
                    model: "gpt-5.6-terra".into(),
                    effort: Some("medium".into()),
                    access: Access::Edits,
                    ..agent("bo", Some("t1"), None)
                },
                agent("cy", Some("t2"), None),
                agent("di", Some("t1"), Some("p2")),
                agent("ed", None, None),
                TeamAgent {
                    model: "fable".into(),
                    ..agent("fa", Some("t1"), None)
                },
            ],
            vec![team("t1"), team("t2")],
        )
    }

    fn project(id: &str, path: &str) -> Workspace {
        serde_json::from_value(json!({
            "id": id, "name": format!("Project {id}"), "primary_path": path, "paths": [],
        }))
        .unwrap()
    }

    /// The run's own project ("workspace", at /tmp), and two more on disk.
    fn projects(root: &TestDir) -> Vec<Workspace> {
        let dir = |name: &str| {
            let path = root.join(name);
            fs::create_dir_all(&path).unwrap();
            path.to_string_lossy().into_owned()
        };
        vec![
            project("workspace", "/tmp"),
            project("p1", &dir("one")),
            project("p2", &dir("two")),
        ]
    }

    const LEAD_CHAT: &str = "chat:lead";

    fn lead_of(agent_id: &str) -> LeadCaller {
        LeadCaller {
            agent_id: agent_id.into(),
            project_id: "workspace".into(),
            cwd: "/tmp".into(),
            cross_project: false,
        }
    }

    fn work(peer: &str) -> PeerWork {
        PeerWork {
            peer: peer.into(),
            title: "Report volume usage".into(),
            request: "  Inspect the NAS and read each volume's usage.  ".into(),
            output: "One line per volume: name, used, total.".into(),
            ..PeerWork::default()
        }
    }

    /// A request from Ada's own chat, with nothing registered but the run's
    /// project.
    fn from_lead(store: &OrchestrationStore, work: PeerWork) -> Result<PeerRequested, String> {
        let (agents, teams) = roster();
        store.peer_request(
            LEAD_CHAT,
            Some(&lead_of("ada")),
            work,
            &agents,
            &teams,
            &[project("workspace", "/tmp")],
        )
    }

    /// A worker of the master's run whose task was handed to Ada.
    fn worker_ada(store: &OrchestrationStore, run: &Run) -> Attempt {
        let attempt = super::super::tests::running_worker(store, run);
        store
            .mutate(|data| {
                let a = data.attempts.get_mut(&attempt.id).unwrap();
                a.assignee = Some(TaskAssignee {
                    id: "ada".into(),
                    name: "ADA".into(),
                });
                Ok(a.clone())
            })
            .unwrap()
    }

    fn from_worker(
        store: &OrchestrationStore,
        worker: &Attempt,
        work: PeerWork,
    ) -> Result<PeerRequested, String> {
        let (agents, teams) = roster();
        store.peer_request(
            &worker.worker_chat_key,
            None,
            work,
            &agents,
            &teams,
            &[project("workspace", "/tmp")],
        )
    }

    fn task_of(store: &OrchestrationStore, id: &str) -> Task {
        store
            .snapshot(None)
            .unwrap()
            .tasks
            .into_iter()
            .find(|t| t.id == id)
            .unwrap()
    }

    fn run_of(store: &OrchestrationStore, id: &str) -> Run {
        store.snapshot(Some(id)).unwrap().runs.remove(0)
    }

    /// The launch the host's own dispatch makes for a task: its settings.
    fn host_launch(store: &OrchestrationStore, task: &Task) -> WorkerLaunch {
        let run = run_of(store, &task.run_id);
        let settings = automation::settings_for_task(&run, task)
            .unwrap()
            .expect("the task names its worker");
        WorkerLaunch {
            agent: settings.agent,
            model: settings.model,
            effort: settings.effort,
            access: settings.access,
            ..launch_for(&task.id)
        }
    }

    /// Approve the plan and start the task as the host's dispatch would.
    fn approved_and_started(store: &OrchestrationStore, task_id: &str) -> Attempt {
        let task = task_of(store, task_id);
        let coordinator = run_of(store, &task.run_id).coordinator_chat_key;
        store
            .approve_plan(&coordinator, &task.run_id, None, None)
            .unwrap();
        let (_, _, attempt, _) = store
            .reserve_attempt(&coordinator, &host_launch(store, &task))
            .unwrap();
        store
            .activate_attempt(&attempt.id, "/tmp".into(), "peer".into(), true)
            .unwrap()
    }

    fn report(store: &OrchestrationStore, attempt: &Attempt, summary: &str) -> Task {
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: summary.into(),
                    files_modified: Vec::new(),
                    verdict: None,
                },
            )
            .unwrap()
    }

    fn notices(store: &OrchestrationStore, target: &str, kind: &str) -> Vec<inbox::Notification> {
        store
            .snapshot(None)
            .unwrap()
            .notifications
            .into_iter()
            .filter(|n| n.target_chat_key == target && n.kind == kind)
            .collect()
    }

    #[test]
    fn a_leads_request_waits_for_the_person_then_runs_as_the_peer_and_reports_back() {
        let store = OrchestrationStore::default();
        let made = from_lead(&store, work("bo")).unwrap();
        assert!(made.run_created, "the chat coordinated no run");
        assert_eq!(made.status, "awaiting_approval");
        assert_eq!(made.teammate.id, "bo");
        assert_eq!(made.max_minutes, DEFAULT_MINUTES);
        assert_eq!(made.requests_left, MAX_OPEN_REQUESTS_PER_LEAD_CHAT - 1);

        // One ordinary task in a run this chat coordinates, held by the plan.
        let run = run_of(&store, &made.run_id);
        assert_eq!(run.coordinator_chat_key, LEAD_CHAT);
        assert_eq!(run.objective, "Peer requests from ADA");
        assert!(run.awaiting_plan_approval());
        let task = task_of(&store, &made.task_id);
        assert_eq!(task.status, TaskStatus::Ready);
        assert!(task.approved_at.is_none() && task.parent_task_id.is_none());
        assert_eq!(task.assignee.as_ref().unwrap().id, "bo");
        assert_eq!(
            task.spec,
            "Inspect the NAS and read each volume's usage.\n\nExpected output\nOne line per volume: name, used, total."
        );
        let request = task.peer_request.clone().unwrap();
        assert_eq!(request.requested_by.id, "ada");
        assert_eq!(request.requester_chat_key, LEAD_CHAT);
        assert!(request.requester_attempt_id.is_none());

        // Nothing starts before the person approves, by any door.
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert!(automation::ready_wave(&snapshot, &run).is_empty());
        let early = store
            .reserve_attempt(LEAD_CHAT, &host_launch(&store, &task))
            .unwrap_err();
        assert!(early.contains("has not approved this plan"), "{early}");
        assert!(snapshot.attempts.is_empty());

        // Approved: the host's own wave picks it up with the PEER's settings.
        store.approve_plan(LEAD_CHAT, &run.id, None, None).unwrap();
        let run = run_of(&store, &run.id);
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let wave = automation::ready_wave(&snapshot, &run);
        assert_eq!(wave.len(), 1);
        assert!(task_of(&store, &task.id).approved_at.is_some());
        // Not as anyone else: the lead's own choice of settings is refused.
        let other = store
            .reserve_attempt(LEAD_CHAT, &launch_for(&task.id))
            .unwrap_err();
        assert!(
            other.contains("A peer runs only as its registered identity"),
            "{other}"
        );
        let wider = store
            .reserve_attempt(
                LEAD_CHAT,
                &WorkerLaunch {
                    access: Access::Full,
                    ..host_launch(&store, &task)
                },
            )
            .unwrap_err();
        assert!(wider.contains("at edits access"), "{wider}");
        let (_, _, attempt, _) = store
            .reserve_attempt(LEAD_CHAT, &host_launch(&store, &task))
            .unwrap();
        assert_eq!(
            (
                attempt.agent,
                attempt.model.as_deref(),
                attempt.effort.as_deref(),
                attempt.access
            ),
            (
                ChatAgent::Codex,
                Some("gpt-5.6-terra"),
                Some("medium"),
                Access::Edits
            )
        );
        assert_eq!(attempt.assignee.as_ref().unwrap().id, "bo");
        let attempt = store
            .activate_attempt(&attempt.id, "/tmp".into(), "peer".into(), true)
            .unwrap();

        // Its report reaches the requester, who coordinates the run.
        report(&store, &attempt, "volume1: 71% of 8 TB");
        let told = notices(&store, LEAD_CHAT, "report");
        assert_eq!(told.len(), 1);
        assert!(
            told[0].body.starts_with(
                "This task is the peer request ADA made to BO. Worker reported Completed"
            ),
            "{}",
            told[0].body
        );
        assert!(told[0].body.contains("volume1: 71% of 8 TB"));
        // And stays on the task, in the browser's read and the agent's.
        let task = task_of(&store, &task.id);
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.result.as_deref(), Some("volume1: 71% of 8 TB"));
        let view = agent_view::agent_snapshot(
            store.snapshot(None).unwrap(),
            &agent_view::AgentRead {
                actor: LEAD_CHAT,
                run_id: None,
                task_id: None,
                message_limit: 5,
            },
        )
        .unwrap();
        let row = &view["tasks"][0];
        assert_eq!(row["peerRequest"]["requestedBy"]["name"], "ADA");
        assert_eq!(row["status"], "completed");
        assert_eq!(row["result"], "volume1: 71% of 8 TB");
    }

    #[test]
    fn a_leads_next_request_joins_the_run_it_already_coordinates() {
        let store = OrchestrationStore::default();
        let first = from_lead(&store, work("bo")).unwrap();
        // Di works only in p2, which is not registered here: refused, and no
        // second run was opened for it.
        let second = from_lead(&store, work("di")).unwrap_err();
        assert!(second.contains("no longer registered"), "{second}");
        let second = from_lead(&store, work("BO")).unwrap();
        assert!(!second.run_created);
        assert_eq!(second.run_id, first.run_id);
        assert_eq!(store.snapshot(None).unwrap().runs.len(), 1);
        assert_eq!(second.requests_left, MAX_OPEN_REQUESTS_PER_LEAD_CHAT - 2);
    }

    #[test]
    fn a_workers_request_lives_in_its_run_and_its_report_comes_back_to_it() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = worker_ada(&store, &run);
        assert!(run.plan_approval.is_none(), "this run never asked");
        let made = from_worker(&store, &worker, work("bo")).unwrap();
        assert!(!made.run_created);
        assert_eq!(made.run_id, run.id);
        assert_eq!(made.requests_left, MAX_REQUESTS_PER_ATTEMPT - 1);
        assert!(made.note.contains("Do not wait for it"), "{}", made.note);
        let task = task_of(&store, &made.task_id);
        let request = task.peer_request.clone().unwrap();
        assert_eq!(request.requester_chat_key, worker.worker_chat_key);
        assert_eq!(
            request.requester_attempt_id.as_deref(),
            Some(worker.id.as_str())
        );
        // It asks for the person now, and the coordinator is told why.
        assert!(run_of(&store, &run.id).awaiting_plan_approval());
        let heard = notices(&store, "chat:master", "peer_request");
        assert_eq!(heard.len(), 1);
        assert!(heard[0].body.contains("ADA asked its teammate BO"));
        assert!(heard[0].body.contains(&task.id));
        // The requester's own task is untouched: no handoff, still running.
        let own = task_of(&store, &worker.task_id);
        assert_eq!(own.status, TaskStatus::Running);
        assert_eq!(own.active_attempt_id.as_deref(), Some(worker.id.as_str()));
        assert!(own.handoffs.is_empty());

        let peer = approved_and_started(&store, &task.id);
        report(&store, &peer, "volume1: 71% of 8 TB");
        // The coordinator hears as for any task, and still accepts it.
        assert_eq!(notices(&store, "chat:master", "report").len(), 1);
        // The requester gets it in the answer to its next call to the host.
        let taken = store
            .take_for_working_worker(&worker.worker_chat_key)
            .unwrap();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].kind, "peer_report");
        assert!(
            taken[0].body.contains("reported Completed"),
            "{}",
            taken[0].body
        );
        assert!(taken[0].body.contains("volume1: 71% of 8 TB"));
        assert!(taken[0]
            .body
            .contains("not an instruction from your coordinator"));
        assert!(store
            .take_for_working_worker(&worker.worker_chat_key)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_rejection_reaches_a_running_requester_and_a_settled_one_is_not_woken() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = worker_ada(&store, &run);
        let first = from_worker(&store, &worker, work("bo")).unwrap();
        let second = from_worker(&store, &worker, work("bo")).unwrap();
        // The person rejects the amendment: both new tasks are withdrawn, and
        // the worker hears it instead of waiting for reports.
        store
            .reject_plan_from_card(
                "chat:master",
                &run.id,
                Some(&[first.task_id.clone(), second.task_id.clone()]),
                Some(run_of(&store, &run.id).plan_approval.unwrap().revision),
                None,
                CardView {
                    surface: "chat".into(),
                    shown_ms: Some(5_000),
                    updated_ms: None,
                },
            )
            .unwrap();
        assert_eq!(
            task_of(&store, &first.task_id).status,
            TaskStatus::Cancelled
        );
        let taken = store
            .take_for_working_worker(&worker.worker_chat_key)
            .unwrap();
        assert_eq!(taken.len(), 2);
        assert!(
            taken[0].body.contains("the person rejected it"),
            "{}",
            taken[0].body
        );

        // A report for a requester whose attempt has settled wakes nobody.
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let worker = worker_ada(&store, &run);
        let made = from_worker(&store, &worker, work("bo")).unwrap();
        let peer = approved_and_started(&store, &made.task_id);
        report(&store, &worker, "my own task is done");
        report(&store, &peer, "volume1: 71% of 8 TB");
        assert!(store
            .take_for_working_worker(&worker.worker_chat_key)
            .unwrap()
            .is_empty());
        let pending = notices(&store, &worker.worker_chat_key, "peer_report");
        assert!(store
            .claim_notification(&pending[0].id, now_ms())
            .unwrap()
            .is_none());
        // The run's coordinator has it either way, and the task keeps it.
        assert_eq!(
            task_of(&store, &made.task_id).result.as_deref(),
            Some("volume1: 71% of 8 TB")
        );
    }

    #[test]
    fn only_a_teammate_is_asked_and_a_refusal_names_the_team() {
        let store = OrchestrationStore::default();
        let off_team = from_lead(&store, work("cy")).unwrap_err();
        assert!(
            off_team.starts_with("CY is not on your team, so you cannot hand it work; your teammates on Team t1 are BO (`bo`), DI (`di`), FA (`fa`)"),
            "{off_team}"
        );
        assert!(from_lead(&store, work("ed"))
            .unwrap_err()
            .starts_with("ED is not on your team"));
        assert!(from_lead(&store, work("zed"))
            .unwrap_err()
            .starts_with("No registered agent is called zed; your teammates on Team t1 are"));
        assert!(from_lead(&store, work("Ada"))
            .unwrap_err()
            .starts_with("You cannot hand work to yourself"));
        assert!(from_lead(&store, work(" ")).unwrap_err().contains("`peer`"));
        // A lead-only model takes no task, peer or not.
        let lead_only = from_lead(&store, work("fa")).unwrap_err();
        assert!(lead_only.contains("lead-only model"), "{lead_only}");
        // An agent on no team has no one to ask.
        let (agents, teams) = roster();
        let alone = store
            .peer_request(
                LEAD_CHAT,
                Some(&lead_of("ed")),
                work("bo"),
                &agents,
                &teams,
                &[],
            )
            .unwrap_err();
        assert!(alone.starts_with("You are not on a team"), "{alone}");
        // Every refusal left the ledger as it was: no run, no task.
        let snapshot = store.snapshot(None).unwrap();
        assert!(snapshot.runs.is_empty() && snapshot.tasks.is_empty());
    }

    #[test]
    fn work_goes_only_where_the_peer_and_the_requester_may_work() {
        let root = TestDir::new("peer-request");
        let projects = projects(&root);
        let (mut agents, teams) = roster();
        let store = OrchestrationStore::default();
        let ask = |agents: &[TeamAgent], who: &str, project: Option<&str>| {
            store.peer_request(
                LEAD_CHAT,
                Some(&lead_of("ada")),
                PeerWork {
                    project: project.map(Into::into),
                    ..work(who)
                },
                agents,
                &teams,
                &projects,
            )
        };
        // Di works only in p2: asked into p1, it is refused with the reason.
        let outside = ask(&agents, "di", Some("p1")).unwrap_err();
        assert!(
            outside.contains("DI works only in Project p2."),
            "{outside}"
        );
        // An unregistered project is refused, never adopted.
        assert!(ask(&agents, "bo", Some("nowhere"))
            .unwrap_err()
            .contains("No registered project called nowhere"));
        assert!(store.snapshot(None).unwrap().tasks.is_empty());
        // Named nowhere, a peer confined to one project works in that one.
        let routed = ask(&agents, "di", None).unwrap();
        assert_eq!(routed.destination.as_ref().unwrap().project_id, "p2");
        let task = task_of(&store, &routed.task_id);
        assert_eq!(task.destination, routed.destination);
        // A peer free to work anywhere takes it in the chat's own project
        // by default, or where the request says.
        assert!(ask(&agents, "bo", None).unwrap().destination.is_none());
        let named = ask(&agents, "bo", Some("Project p1")).unwrap();
        assert_eq!(named.destination.unwrap().project_id, "p1");
        // A requester confined to one project cannot send work out of it.
        // (From another of its chats: this one has its three open.)
        agents[0].project_id = Some("workspace".into());
        let beyond = store
            .peer_request(
                "chat:lead-2",
                Some(&lead_of("ada")),
                PeerWork {
                    project: Some("p1".into()),
                    ..work("bo")
                },
                &agents,
                &teams,
                &projects,
            )
            .unwrap_err();
        assert!(
            beyond.contains(
                "You work only in Project workspace, so you cannot send work to Project p1."
            ),
            "{beyond}"
        );
    }

    #[test]
    fn a_workers_request_runs_where_its_own_task_does() {
        let root = TestDir::new("peer-request");
        let projects = projects(&root);
        let (agents, teams) = roster();
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = worker_ada(&store, &run);
        let there = TaskDestination {
            project_id: "p1".into(),
            project_name: "Project p1".into(),
            repository: projects[1].primary_path.clone(),
        };
        store
            .mutate(|data| {
                data.tasks.get_mut(&worker.task_id).unwrap().destination = Some(there.clone());
                Ok(())
            })
            .unwrap();
        let ask = |who: &str| {
            store.peer_request(
                &worker.worker_chat_key,
                None,
                work(who),
                &agents,
                &teams,
                &projects,
            )
        };
        assert_eq!(ask("bo").unwrap().destination, Some(there));
        // Di cannot work there, and is not silently sent somewhere else.
        let refused = ask("di").unwrap_err();
        assert!(
            refused.contains("DI works only in Project p2."),
            "{refused}"
        );
    }

    #[test]
    fn requests_are_bounded_in_number_and_size() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = worker_ada(&store, &run);
        for _ in 0..MAX_REQUESTS_PER_ATTEMPT {
            from_worker(&store, &worker, work("bo")).unwrap();
        }
        let third = from_worker(&store, &worker, work("bo")).unwrap_err();
        assert!(
            third.contains("This attempt has made 2 peer requests"),
            "{third}"
        );
        assert_eq!(
            store.snapshot(None).unwrap().tasks.len(),
            1 + MAX_REQUESTS_PER_ATTEMPT
        );

        let store = OrchestrationStore::default();
        let mut made = Vec::new();
        for _ in 0..MAX_OPEN_REQUESTS_PER_LEAD_CHAT {
            made.push(from_lead(&store, work("bo")).unwrap());
        }
        let fourth = from_lead(&store, work("bo")).unwrap_err();
        assert!(
            fourth.contains("already has 3 peer requests open"),
            "{fourth}"
        );
        // One that settled is no longer open.
        let peer = approved_and_started(&store, &made[0].task_id);
        report(&store, &peer, "done");
        assert_eq!(from_lead(&store, work("bo")).unwrap().requests_left, 0);

        // The text bounds, and the time bound.
        let store = OrchestrationStore::default();
        let long = from_lead(
            &store,
            PeerWork {
                request: "é".repeat(MAX_REQUEST_CHARS + 1),
                ..work("bo")
            },
        )
        .unwrap_err();
        assert!(long.contains("under 4000 characters"), "{long}");
        from_lead(
            &store,
            PeerWork {
                request: "é".repeat(MAX_REQUEST_CHARS),
                max_minutes: Some(MAX_MINUTES),
                ..work("bo")
            },
        )
        .unwrap();
        for bad in [
            PeerWork {
                output: " ".into(),
                ..work("bo")
            },
            PeerWork {
                request: String::new(),
                ..work("bo")
            },
            PeerWork {
                title: String::new(),
                ..work("bo")
            },
            PeerWork {
                max_minutes: Some(0),
                ..work("bo")
            },
            PeerWork {
                max_minutes: Some(MAX_MINUTES + 1),
                ..work("bo")
            },
        ] {
            assert!(from_lead(&store, bad).is_err());
        }
        assert_eq!(store.snapshot(None).unwrap().tasks.len(), 1);
    }

    #[test]
    fn an_attempt_that_outruns_its_request_is_ended_as_failed() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = worker_ada(&store, &run);
        let made = from_worker(
            &store,
            &worker,
            PeerWork {
                max_minutes: Some(10),
                ..work("bo")
            },
        )
        .unwrap();
        let peer = approved_and_started(&store, &made.task_id);
        let limit = 10 * 60_000;
        // Inside its time nothing happens, and an ordinary task has no limit.
        assert!(store
            .expire_peer_requests(peer.created_at + limit - 1)
            .unwrap()
            .is_empty());
        let ended = store.expire_peer_requests(peer.created_at + limit).unwrap();
        assert_eq!(ended, vec![peer.worker_chat_key.clone()]);
        let snapshot = store.snapshot(None).unwrap();
        let attempt = snapshot.attempts.iter().find(|a| a.id == peer.id).unwrap();
        assert_eq!(attempt.status, AttemptStatus::Failed);
        assert!(attempt
            .summary
            .as_deref()
            .unwrap()
            .starts_with("peer request time limit: the attempt ran past the 10 minutes"));
        assert!(attempt.execution.next_retry_at.is_none(), "never retried");
        // Left for the scheduler's pass to stop, like any failed attempt.
        assert!(attempt.execution.latest_error.is_some());
        let task = task_of(&store, &made.task_id);
        assert_eq!(task.status, TaskStatus::Failed);
        assert!(task.result.unwrap().starts_with(TIME_LIMIT_REASON));
        assert_eq!(
            task_of(&store, &worker.task_id).status,
            TaskStatus::Running,
            "the requester's own attempt is not the one that overran"
        );
        // Both the coordinator and the worker that asked are told.
        let told = notices(&store, "chat:master", "time_limit");
        assert_eq!(told.len(), 1);
        assert!(told[0].body.contains(TIME_LIMIT_REASON));
        let taken = store
            .take_for_working_worker(&worker.worker_chat_key)
            .unwrap();
        assert_eq!(taken.len(), 1);
        assert!(taken[0]
            .body
            .contains("ended as failed. peer request time limit"));
        // Ending it once is the end of it.
        assert!(store
            .expire_peer_requests(peer.created_at + 2 * limit)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_clock_starts_again_when_a_decision_the_peer_waited_on_comes_back() {
        let store = OrchestrationStore::default();
        let made = from_lead(
            &store,
            PeerWork {
                max_minutes: Some(1),
                ..work("bo")
            },
        )
        .unwrap();
        let peer = approved_and_started(&store, &made.task_id);
        let gate = store
            .create_gate(
                &peer.worker_chat_key,
                made.run_id.clone(),
                Some(made.task_id.clone()),
                "Which volume?".into(),
                vec![],
            )
            .unwrap();
        // Parked on the person: not working, so not ended.
        let later = peer.created_at + 10 * 60_000;
        assert!(store.expire_peer_requests(later).unwrap().is_empty());
        store
            .resolve_gate(LEAD_CHAT, gate.id, "volume1".into())
            .unwrap();
        let resolved = store
            .mutate(|data| {
                let attempt = data.attempts.get_mut(&peer.id).unwrap();
                attempt.status = AttemptStatus::Running;
                Ok(data.gates.values().map(|g| g.updated_at).max().unwrap())
            })
            .unwrap();
        assert!(store
            .expire_peer_requests(resolved + 59_000)
            .unwrap()
            .is_empty());
        assert_eq!(
            store.expire_peer_requests(resolved + 60_000).unwrap(),
            vec![peer.worker_chat_key]
        );
    }

    #[test]
    fn a_peer_request_goes_no_further() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = worker_ada(&store, &run);
        let made = from_worker(&store, &worker, work("bo")).unwrap();
        let part = |actor: &str| {
            store.create_task_for(
                actor,
                run.id.clone(),
                "Part".into(),
                "Do the part".into(),
                Vec::new(),
                Some(made.task_id.clone()),
                None,
                Some(TaskAssignee {
                    id: "cy".into(),
                    name: "CY".into(),
                }),
                None,
            )
        };
        // Not split by the run's coordinator before it starts.
        let split = part("chat:master").unwrap_err();
        assert!(split.contains("a peer request cannot be split"), "{split}");
        // Nor changed in place or handed on: it is fixed as asked.
        let revised = store
            .revise_task(
                "chat:master",
                &made.task_id,
                TaskRevision {
                    spec: Some("Do much more".into()),
                    ..TaskRevision::default()
                },
            )
            .unwrap_err();
        assert!(
            revised.contains("A peer request cannot be revised"),
            "{revised}"
        );
        let handed = store
            .reassign_task(
                "chat:master",
                &made.task_id,
                (
                    None,
                    Some(TaskAssignee {
                        id: "cy".into(),
                        name: "CY".into(),
                    }),
                    None,
                ),
                "backup".into(),
            )
            .unwrap_err();
        assert!(handed.contains("cannot change hands"), "{handed}");

        // Nor by its own worker, which cannot make a request either.
        let peer = approved_and_started(&store, &made.task_id);
        let own_split = part(&peer.worker_chat_key).unwrap_err();
        assert!(
            own_split.contains("a peer request cannot be split"),
            "{own_split}"
        );
        let (agents, teams) = roster();
        let onward = store
            .peer_request(
                &peer.worker_chat_key,
                None,
                work("ada"),
                &agents,
                &teams,
                &[project("workspace", "/tmp")],
            )
            .unwrap_err();
        assert!(
            onward.starts_with(
                "Your own task is a peer request, and a peer request goes no further."
            ),
            "{onward}"
        );
        // It may still ASK, as any worker can.
        let reply = store
            .peer_ask(
                &peer.worker_chat_key,
                None,
                peer::PeerQuestion {
                    teammate_id: "ada".into(),
                    question: "Which volume did you mean?".into(),
                    context_paths: Vec::new(),
                },
                &agents,
                &teams,
                "",
                |_| {
                    Ok(peer::HelperAnswer {
                        text: "volume1".into(),
                        usage: None,
                    })
                },
            )
            .unwrap();
        assert_eq!(reply.answer, "volume1");
        // And its brief says so, with no offer to split.
        let brief = worker_brief(
            task_of(&store, &made.task_id)
                .peer_request
                .as_ref()
                .unwrap(),
        );
        assert!(brief.contains("peer request from your teammate ADA"));
        assert!(brief.contains("You cannot split this task or make a peer request of your own"));
        // The withdraw the refusal names still works on one not yet started.
        let spare = from_worker(&store, &worker, work("bo")).unwrap();
        let withdrawn = store
            .revise_task(
                "chat:master",
                &spare.task_id,
                TaskRevision {
                    withdraw: true,
                    ..TaskRevision::default()
                },
            )
            .unwrap();
        assert_eq!(withdrawn.status, TaskStatus::Cancelled);
    }

    #[test]
    fn only_a_registered_agents_own_chat_may_ask_for_work() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        // A worker whose task was handed to no registered agent has no team.
        let plain = super::super::tests::running_worker(&store, &run);
        assert!(from_worker(&store, &plain, work("bo"))
            .unwrap_err()
            .starts_with("This task was not handed to a registered agent"));
        // A worker's chat is never a lead's, whatever it is called as.
        let (agents, teams) = roster();
        let posing = store
            .peer_request(
                &plain.worker_chat_key,
                Some(&lead_of("ada")),
                work("bo"),
                &agents,
                &teams,
                &[],
            )
            .unwrap_err();
        assert!(
            posing.contains("orchestration worker, not a lead's own chat"),
            "{posing}"
        );
        // A settled worker has no running attempt to ask from.
        let settled = super::super::tests::settled_worker(&store, &run, None);
        assert!(from_worker(&store, &settled, work("bo"))
            .unwrap_err()
            .contains("This chat has no running attempt"));
        // A lead whose agent was removed is nobody.
        let gone = store
            .peer_request(
                LEAD_CHAT,
                Some(&lead_of("gone")),
                work("bo"),
                &agents,
                &teams,
                &[],
            )
            .unwrap_err();
        assert!(
            gone.starts_with("You are no longer a registered agent"),
            "{gone}"
        );
    }

    /// A request, its approval, its run and its report are all the ledger's:
    /// the roster file is never written, so nobody's manager can change.
    #[test]
    fn a_peer_request_never_touches_who_reports_to_whom() {
        let path = TestPath::new("peer-request", "team.json");
        let draft =
            |name: &str, manager: Option<&str>, team: Option<&str>| crate::team::TeamDraft {
                id: None,
                name: name.into(),
                role: "builds things".into(),
                agent: ChatAgent::Claude,
                model: "sonnet".into(),
                effort: None,
                access: None,
                project_id: None,
                reports_to: manager.map(Into::into),
                avatar: None,
                team_id: team.map(Into::into),
                persistent_prompt: None,
            };
        let leads = crate::team::save_team(
            &path,
            crate::team::AgentTeamDraft {
                id: None,
                name: "Leads".into(),
                project_id: None,
            },
        )
        .unwrap();
        let boss = crate::team::save(&path, draft("Boss", None, None)).unwrap();
        let ada = crate::team::save(&path, draft("Ada", None, Some(&leads.id))).unwrap();
        let bo = crate::team::save(&path, draft("Bo", Some(&boss.id), Some(&leads.id))).unwrap();
        let before = fs::read(&*path).unwrap();
        let agents = crate::team::list(&path, None, true).unwrap();
        let teams = crate::team::teams(&path).unwrap();

        let store = OrchestrationStore::default();
        let made = store
            .peer_request(
                LEAD_CHAT,
                Some(&lead_of(&ada.id)),
                work("Bo"),
                &agents,
                &teams,
                &[project("workspace", "/tmp")],
            )
            .unwrap();
        let peer = approved_and_started(&store, &made.task_id);
        report(&store, &peer, "done");

        assert_eq!(
            fs::read(&*path).unwrap(),
            before,
            "the roster was not written"
        );
        let after = crate::team::list(&path, None, true).unwrap();
        assert_eq!(after, agents);
        let reports_to = |id: &str| {
            after
                .iter()
                .find(|a| a.id == id)
                .unwrap()
                .reports_to
                .clone()
        };
        assert_eq!(reports_to(&bo.id), Some(boss.id.clone()));
        assert_eq!(reports_to(&ada.id), None);
        // The task says who asked; it does not make Ada Bo's manager.
        let task = task_of(&store, &made.task_id);
        assert_eq!(task.peer_request.unwrap().requested_by.id, ada.id);
        assert_eq!(task.assignee.unwrap().id, bo.id);
    }

    /// The direct-report rule a task otherwise goes by is the same as ever:
    /// only the lateral route skips it, and only for the named teammate.
    #[test]
    fn the_direct_report_rule_still_holds_for_every_other_task() {
        let (agents, _) = roster();
        let route = destination::Route {
            who: Some("bo"),
            project: None,
            repository: None,
            manager: Some("ada"),
            cross_project: false,
            run_project: "workspace",
            parent: None,
        };
        let projects = [project("workspace", "/tmp")];
        let refused = destination::route(&agents, &projects, &route).unwrap_err();
        assert!(refused.contains("BO does not report to you"), "{refused}");
        let lateral = destination::route_lateral(&agents, &projects, &route).unwrap();
        assert_eq!(lateral.assignee.unwrap().id, "bo");
    }

    #[test]
    fn a_plan_revision_covers_who_asked_and_the_bounds() {
        let store = OrchestrationStore::default();
        let made = from_lead(&store, work("bo")).unwrap();
        let revision = |store: &OrchestrationStore| {
            run_of(store, &made.run_id).plan_approval.unwrap().revision
        };
        let shown = revision(&store);
        store
            .mutate(|data| {
                let task = data.tasks.get_mut(&made.task_id).unwrap();
                task.peer_request.as_mut().unwrap().max_minutes = MAX_MINUTES;
                Ok(())
            })
            .unwrap();
        assert_ne!(
            revision(&store),
            shown,
            "a longer limit is a different plan"
        );
    }

    #[test]
    fn a_mission_tells_a_writing_requester_its_peer_waits_for_it() {
        let store = OrchestrationStore::default();
        let run = store
            .create_run_with_mode(
                "chat:master".into(),
                "Ship".into(),
                "workspace".into(),
                "/tmp".into(),
                Some(2),
                WorkspaceMode::Mission,
            )
            .unwrap();
        let worker = worker_ada(&store, &run);
        let made = from_worker(&store, &worker, work("bo")).unwrap();
        assert!(
            made.note
                .contains("starts there only after your attempt settles"),
            "{}",
            made.note
        );
        // A read-only peer shares the checkout and needs no such warning.
        let (mut agents, teams) = roster();
        agents[1].access = Access::Read;
        let made = store
            .peer_request(
                &worker.worker_chat_key,
                None,
                work("bo"),
                &agents,
                &teams,
                &[project("workspace", "/tmp")],
            )
            .unwrap();
        assert!(!made.note.contains("only after your attempt settles"));
    }
}

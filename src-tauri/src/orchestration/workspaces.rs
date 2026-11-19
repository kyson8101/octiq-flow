//! Task workspaces outlive attempts. The persisted plan is the allocation;
//! a lease identifies the only worker allowed to write there.
use super::*;
use crate::git_ops::workflow::{self, DeliveryEvidence, WorkspaceMode, WorkspacePlan};
use crate::paths::Canonical;

pub(super) fn cleanup_ready(
    data: &Stored,
    task: &Task,
    ws: &TaskWorkspace,
    abandon: bool,
) -> Result<(), String> {
    if ws.plan.mode == WorkspaceMode::Agent {
        return Err("Agent worktrees are retained for their registered agent; per-task Cleanup never removes them.".into());
    }
    if data
        .attempts
        .values()
        .any(|a| a.task_id == task.id.as_str() && attempt_is_unsettled(data, a))
    {
        return Err("Stop or settle every worker before cleanup.".into());
    }
    if data
        .gates
        .values()
        .any(|g| g.task_id.as_deref() == Some(task.id.as_str()) && g.status == GateStatus::Open)
    {
        return Err("Resolve the open decision before cleanup.".into());
    }
    for other in data.attempts.values().filter(|a| {
        a.task_id != task.id.as_str() && attempt_is_unsettled(data, a) && !a.cwd.is_empty()
    }) {
        if workflow::leases_clash(
            &workflow::held_checkout(&other.cwd),
            attempt_in_managed_worktree(data, other),
            &ws.plan.checkout_root,
            true,
        ) {
            return Err("Another task is still using this checkout.".into());
        }
    }
    if abandon
        && data.tasks.values().any(|t| {
            t.depends_on.iter().any(|id| id == task.id.as_str()) && t.active_attempt_id.is_some()
        })
    {
        return Err("A dependent task already started. Preserve this workspace until that work is resolved.".into());
    }
    if data
        .tasks
        .values()
        .filter(|t| t.id != task.id.as_str())
        .any(|t| {
            t.workspace.as_ref().is_some_and(|other| {
                other.state != WorkspaceState::Cleaned
                    && other.swept_at.is_none()
                    && workflow::leases_clash(
                        &other.plan.checkout_root,
                        other.plan.is_managed_worktree(),
                        &ws.plan.checkout_root,
                        true,
                    )
            })
        })
    {
        return Err("Another task retains this checkout. Preserve it until all workspace owners are resolved.".into());
    }
    if !abandon && task.status != TaskStatus::Completed {
        return Err("Complete the task or explicitly abandon it before cleanup.".into());
    }
    if !ws.validation_paths.is_empty() {
        return Err("Remove the task's validation worktrees before cleanup.".into());
    }
    Ok(())
}

/// An orchestration worker writing in the checkout a chat works in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriterBeside {
    pub task_id: String,
    pub title: String,
    pub checkout: String,
}

impl WriterBeside {
    /// What the strict check refuses with.
    pub fn refusal(&self) -> String {
        format!(
            "This checkout has an active writer for task {} ({}). Wait or use a separate worktree.",
            self.title, self.checkout
        )
    }

    /// What a chat let through beside it is told, once per task.
    pub fn notice(&self) -> String {
        format!(
            "Task \"{}\" is also writing in this checkout ({}). Edits here can collide with it.",
            self.title, self.checkout
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceState {
    Preparing,
    Ready,
    Retained,
    Cleaning,
    Cleaned,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspace {
    pub plan: WorkspacePlan,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swept_at: Option<i64>,
    pub state: WorkspaceState,
    pub lease_attempt_id: Option<String>,
    pub delivery: Option<DeliveryEvidence>,
    #[serde(default)]
    pub abandoned: bool,
    #[serde(default)]
    pub cleanup_intent: Option<bool>,
    #[serde(default, deserialize_with = "crate::paths::de_simplified_vec")]
    pub validation_paths: Vec<String>,
}

/// How many reopens a task keeps (`Task::reopens`), newest last.
const MAX_REOPENS_KEPT: usize = 12;

/// Why a reopened task does not start yet (`reserve_attempt_for`).
pub(super) const REOPEN_NOT_TOLD: &str = "This task was reopened with new instructions, and the notice of that in the coordinator's chat has not been confirmed as saved to disk yet, so it does not start: the person is shown every reopen before its work begins, and a notice the disk does not hold yet could still be lost. The notice may already be on screen in that chat. The host keeps trying to write it and to confirm it on disk, and the task starts once it has (heldByReopen in orchestration_snapshot). If it stays held, the coordinator's chat was deleted or its transcript cannot be written or synced to disk.";

/// The reopen of `task` the person has not been shown yet, if any.
pub(super) fn untold_reopen(task: &Task) -> Option<&TaskReopen> {
    task.reopens.iter().find(|reopen| !reopen.notice_delivered)
}

/// The one event that tells the person of a reopen, made from what the
/// ledger keeps of it: the same on every try.
fn reopen_event(task: &Task, reopen: &TaskReopen) -> serde_json::Value {
    let mut event = json!({
        "type": "octiq_task_reopened",
        "runId": task.run_id,
        "taskId": task.id,
        "title": task.title,
        "assignee": task.assignee,
        "attempt": reopen.attempt,
        "spec": reopen.spec,
        "previousSpecChars": reopen.previous_spec.chars().count(),
        "at": reopen.at,
    });
    // Said only of the person's own, so the event of every other reopen is
    // the one it always was: a notice is found again by what it says.
    if reopen.by_person {
        event["byPerson"] = json!(true);
    }
    event
}

/// Whether the host holds a durability receipt for each of `events` in
/// `chat`'s transcript, in their order. One that is not there yet is
/// appended.
///
/// **The rule, with no path exempt:** a notice counts only after the host
/// has, in this pass and under the append lock, synced the record as it is
/// now and then the folder it is in, and both succeeded
/// (`transcript::confirm_synced`). Every `true` this answers comes after
/// that one call, the last thing done here, whichever way the line got
/// into the record:
///
/// - **found there.** A readable line is not a receipt: it is the line of
///   an append that answered none, or was never heard from, and read back
///   it says the OS holds it and nothing about the disk. It is never
///   written again.
/// - **appended now.** That append's own answer is not one either. It
///   syncs the folder only for a file it made, and "the file was there"
///   says nothing of the folder entry: most records are made by an
///   ordinary append that syncs nothing, and a compacted one is a new file
///   under the old name (`transcript::rewrite_numbered`).
///
/// While the record holds a notice that cannot be confirmed, nothing new
/// is written into it: a second line there would be as unproven as the
/// first. With no receipt the chat gets nothing recorded this pass and its
/// tasks stay held.
///
/// **A receipt is for the record the line was seen in.** The chat's record
/// can be removed and made again under the same name between the look
/// here and the receipt: the person clears the chat (`/clear`, the
/// socket's `chat_forget`) and the next thing said in it starts a new
/// file, which syncs perfectly well and holds no notice. So which record
/// the chat has is taken before anything is read (`transcript::generation`)
/// and handed to every `confirm_synced`, which answers none once the host
/// has removed that record. Then nothing is recorded, the tasks stay held,
/// and the next pass reads the record that is there, does not find the
/// line and writes it, once. Storage migration keeps every host event but
/// moves generation; its publication gate waits for notice debt to settle.
///
/// **And for the file it was taken for.** The token names its record's
/// file as the filesystem tells files apart (`transcript::identity`), so
/// one taken for a file is refused on any other, whatever their numbers:
/// two files that were never removed used to read the same. The profile
/// folder is fixed at startup, so the chat's name cannot come to mean
/// another file while the server runs; if it ever did, the answer is no
/// receipt, the task held, and the next pass reading what is there.
///
/// The transcript is read once, for the reopen events alone.
fn notice_receipts(chat: &str, events: &[serde_json::Value]) -> Vec<bool> {
    let none = || vec![false; events.len()];
    let Some(record) = crate::transcript::generation(chat) else {
        return none();
    };
    let confirmed = || crate::transcript::confirm_synced(chat, &record).is_some();
    let there = crate::transcript::of_type(chat, "octiq_task_reopened");
    let found: Vec<bool> = events
        .iter()
        .map(|event| {
            there.iter().any(|other| {
                ["type", "taskId", "attempt", "at"]
                    .iter()
                    .all(|key| other[key] == event[key])
            })
        })
        .collect();
    if found.contains(&true) && found.contains(&false) && !confirmed() {
        return none();
    }
    let written: Vec<bool> = events
        .iter()
        .zip(&found)
        .map(|(event, found)| {
            *found || crate::agent_chat::record_chat_event_synced(chat, event.clone()).is_some()
        })
        .collect();
    #[cfg(test)]
    if let Some(meanwhile) = BEFORE_RECEIPT.with(|slot| slot.take()) {
        meanwhile(chat);
    }
    if written.contains(&true) && confirmed() {
        written
    } else {
        none()
    }
}

#[cfg(test)]
thread_local! {
    /// What happens to a chat on this thread between the next
    /// `notice_receipts` reading or writing its record and asking for the
    /// receipt, once: the window another thread's work lands in.
    static BEFORE_RECEIPT: std::cell::RefCell<Option<Box<dyn FnOnce(&str)>>> =
        const { std::cell::RefCell::new(None) };
}

/// How long a chat whose transcript gave no receipt is left alone before
/// it is asked again, after that many tries in a row: 4 s, doubling to a
/// minute. A fault that lasts costs a read a minute, not one every pass.
pub(super) fn notice_wait(failures: u32) -> i64 {
    (2_000_i64 << failures.min(5)).min(60_000)
}

/// Whether a line written to the chat `chat_key` is one the person can
/// read: the chat list has it and it is not in the trash. A transcript
/// nothing lists cannot be opened, and is removed when the server next
/// starts (`chat_index::reconcile`).
fn shown_to_the_person(chat_key: &str) -> Result<(), String> {
    match shown_in(chat_key) {
        Ok(true) => Ok(()),
        Ok(false) => Err(CHAT_GONE.into()),
        Err(error) => Err(chat_unknown(&error)),
    }
}

/// Whether the chat list has `chat_key` and it is not in the trash, or why
/// that could not be asked.
fn shown_in(chat_key: &str) -> Result<bool, String> {
    crate::chat_index::listed(chat_key.strip_prefix("chat:").unwrap_or(chat_key))
}

const CHAT_GONE: &str = "The coordinator's chat no longer exists, so the person could not be shown this reopen. Nothing was reopened. Create a new task for the follow-up work, from a chat that exists.";

fn chat_unknown(error: &str) -> String {
    format!("Whether the coordinator's chat still exists could not be checked ({error}), so the person could not be shown this reopen. Nothing was reopened. Try again.")
}

/// The reopen of `task` nothing has started on yet, when it was the
/// person's own (`ReopenedBy::Person`): the start it is waiting for is
/// theirs, whoever carries it out, and uses none of the task's automatic
/// retries (`reserve_attempt_for`). `attempts` is how many the task has had.
pub(super) fn persons_reopen(task: &Task, attempts: usize) -> bool {
    task.reopens
        .last()
        .is_some_and(|reopen| reopen.by_person && reopen.attempt as usize == attempts + 1)
}

/// What the host WILL allocate for a task that has no workspace yet, worked
/// out read-only when the task is created, so the person approves an exact
/// branch and path rather than "pending". It is never a workspace: no branch,
/// directory or lease exists until launch, and a first launch refuses to
/// allocate anything other than this (`approved_plan`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProposal {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<WorkspacePlan>,
    /// Launch creates the branch; nothing by that name exists yet.
    #[serde(default)]
    pub new_branch: bool,
    /// Something already holds the planned branch or path. Launch refuses it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
    /// Why nothing could be planned. Launch plans afresh, as before proposals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// No worker access was chosen yet, so this assumed a writer. A launch
    /// the coordinator later makes read-only may use the current checkout
    /// instead until an approval fixes the advised mode; every other departure
    /// from the plan is still refused.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub provisional: bool,
    pub proposed_at: i64,
}

/// The person's vocabulary; storage fixes the actual workflow mode separately.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceChoice {
    Agent,
    Worktree,
    Checkout,
}

impl WorkspaceChoice {
    pub(super) fn of(mode: WorkspaceMode) -> Self {
        if mode == WorkspaceMode::Agent {
            Self::Agent
        } else if mode.is_worktree() {
            Self::Worktree
        } else {
            Self::Checkout
        }
    }

    fn mode(self, run: &Run) -> WorkspaceMode {
        match self {
            Self::Agent => WorkspaceMode::Agent,
            Self::Checkout => WorkspaceMode::Direct,
            Self::Worktree if run.workspace_mode == WorkspaceMode::Mission => {
                WorkspaceMode::Mission
            }
            Self::Worktree => WorkspaceMode::Worktree,
        }
    }
}

/// Snapshot only: never stored or accepted back from a caller.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChoiceFact {
    pub advised: WorkspaceChoice,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chosen: Option<WorkspaceChoice>,
    pub options: Vec<WorkspaceChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub only_checkout_because: Option<String>,
}

fn advised_first_mode(run: &Run, task: &Task) -> WorkspaceMode {
    if task
        .workspace_proposal
        .as_ref()
        .and_then(|p| p.plan.as_ref())
        .is_some_and(|p| p.mode == WorkspaceMode::Agent)
    {
        return WorkspaceMode::Agent;
    }
    let access = approval::worker_of(task)
        .or(task.worker.as_ref())
        .map(|w| w.access)
        .or_else(|| run.worker_defaults.as_ref().map(|d| d.access))
        .unwrap_or(Access::Auto);
    first_mode(run.workspace_mode, access)
}

pub(super) fn advised_mode(run: &Run, task: &Task) -> WorkspaceMode {
    auto_mode_for(
        advised_first_mode(run, task),
        run.workspace_mode,
        task_root(run, task.destination.as_ref()),
    )
}

pub(super) fn choice_fact(run: &Run, task: &Task, git: bool) -> WorkspaceChoiceFact {
    WorkspaceChoiceFact {
        advised: if !git {
            WorkspaceChoice::Checkout
        } else {
            WorkspaceChoice::of(advised_first_mode(run, task))
        },
        chosen: task
            .approved
            .as_ref()
            .and_then(|a| a.workspace_mode)
            .map(WorkspaceChoice::of),
        options: if git && advised_first_mode(run, task) == WorkspaceMode::Agent {
            vec![
                WorkspaceChoice::Agent,
                WorkspaceChoice::Worktree,
                WorkspaceChoice::Checkout,
            ]
        } else if git {
            vec![WorkspaceChoice::Worktree, WorkspaceChoice::Checkout]
        } else {
            vec![WorkspaceChoice::Checkout]
        },
        only_checkout_because: (!git)
            .then(|| "This folder has no Git history, so a worktree cannot be created.".into()),
    }
}

/// Validate and plan every override and checkout-only default before the
/// approval changes anything.
pub(super) fn apply_choices(
    data: &mut Stored,
    run_id: &str,
    waiting: &BTreeSet<String>,
    choices: &BTreeMap<String, WorkspaceChoice>,
) -> Result<(), String> {
    let run = data.runs.get(run_id).ok_or("The run does not exist.")?;
    let mut choices = choices.clone();
    for id in waiting {
        let task = data.tasks.get(id).ok_or("The task does not exist.")?;
        // An omitted choice accepts the only available option, even when an
        // explicit Worktree run left an invalid proposal. Persisted workspaces
        // and approvals keep their allocation; this only plans new work.
        if !choices.contains_key(id)
            && task.approved_at.is_none()
            && task.approved.is_none()
            && task.workspace.is_none()
            && task.active_attempt_id.is_none()
            && !task_has_attempt(data, id)
            && !workflow::has_git(task_root(run, task.destination.as_ref()))
        {
            choices.insert(id.clone(), WorkspaceChoice::Checkout);
        }
    }
    let mut proposals = Vec::new();
    for (id, choice) in &choices {
        let task = data
            .tasks
            .get(id)
            .filter(|t| t.run_id == run_id && waiting.contains(id))
            .ok_or("A workspace choice names a task outside the plan revision being approved.")?;
        if task.approved_at.is_some()
            || task.approved.is_some()
            || task.workspace.is_some()
            || task.active_attempt_id.is_some()
            || task_has_attempt(data, id)
        {
            return Err(
                "A workspace choice cannot change an already approved or started task.".into(),
            );
        }
        let root = task_root(run, task.destination.as_ref());
        if matches!(choice, WorkspaceChoice::Worktree | WorkspaceChoice::Agent)
            && !workflow::has_git(root)
        {
            return Err("This task's folder has no Git history; choose Current checkout.".into());
        }
        let mode = choice.mode(run);
        let old = task.workspace_proposal.as_ref();
        let plan = if old
            .and_then(|p| p.plan.as_ref())
            .is_some_and(|p| p.mode == mode)
        {
            old.unwrap().plan.clone().unwrap()
        } else {
            if mode == WorkspaceMode::Agent {
                let agent = task
                    .assignee
                    .as_ref()
                    .ok_or("Agent workspace mode requires a registered assignee.")?;
                workflow::agent_plan(root, "", &agent.id, "batch_pending", None)?
            } else {
                workflow::plan(root, "", workspace_key(run, id, mode), mode)?
            }
        };
        let conflict = workflow::occupied(&plan);
        proposals.push((
            id.clone(),
            WorkspaceProposal {
                new_branch: plan.managed && conflict.is_none(),
                conflict,
                plan: Some(plan),
                error: None,
                provisional: false,
                proposed_at: now_ms(),
            },
        ));
    }
    for (id, proposal) in proposals {
        data.tasks.get_mut(&id).unwrap().workspace_proposal = Some(proposal);
    }
    Ok(())
}

/// Approval alone selects a task's mode. A legacy allocation flag never
/// changes it; tasks without an approved mode retain the original policy.
pub(super) fn launch_mode(run: &Run, task: &Task, launch: &WorkerLaunch) -> WorkspaceMode {
    if let Some(fixed) = task.approved.as_ref().and_then(|a| a.workspace_mode) {
        return fixed;
    }
    if let Some(saved) = &task.workspace {
        return saved.plan.mode;
    }
    auto_mode_for(
        first_mode(run.workspace_mode, launch.access),
        run.workspace_mode,
        task_root(run, task.destination.as_ref()),
    )
}

/// A shared allocation's writer key, used before reservation and by the wave.
pub(super) fn writer_key(run: &Run, task: &Task) -> Option<String> {
    let mode = task
        .workspace
        .as_ref()
        .map(|w| w.plan.mode)
        .or_else(|| task.approved.as_ref().and_then(|a| a.workspace_mode))
        .unwrap_or_else(|| advised_mode(run, task));
    if !matches!(mode, WorkspaceMode::Direct | WorkspaceMode::Mission) {
        return None;
    }
    let root = task_root(run, task.destination.as_ref());
    let checkout = task
        .workspace
        .as_ref()
        .map(|w| w.plan.checkout_root.clone())
        .or_else(|| {
            task.workspace_proposal
                .as_ref()
                .and_then(|p| p.plan.as_ref())
                .map(|p| p.checkout_root.clone())
        })
        .unwrap_or_else(|| workflow::held_checkout(root));
    Some(checkout)
}

/// The mode a first attempt gets: what `prepare_task_workspace` decides, less
/// the legacy `new_worktree` refusal, which only a launch can ask for.
pub(super) fn first_mode(run_mode: WorkspaceMode, access: Access) -> WorkspaceMode {
    match run_mode {
        WorkspaceMode::Auto if access == Access::Read => WorkspaceMode::Direct,
        WorkspaceMode::Auto => WorkspaceMode::Worktree,
        mode => mode,
    }
}

/// Auto picks a worktree only where there is Git to make one from. A folder
/// with no Git history — a plain parent folder registered as a review
/// destination, say — is worked in directly, as a mission does, instead of
/// planning a worktree that fails once the plan is approved (feedback
/// b17ade5a).
fn auto_mode_for(mode: WorkspaceMode, run_mode: WorkspaceMode, root: &str) -> WorkspaceMode {
    if run_mode == WorkspaceMode::Auto
        && mode == WorkspaceMode::Worktree
        && !workflow::has_git(root)
    {
        WorkspaceMode::Direct
    } else {
        mode
    }
}

/// What a workspace is keyed by: the run for a mission, whose tasks all share
/// one worktree per repository, else the task.
pub(super) fn workspace_key<'a>(run: &'a Run, task_id: &'a str, mode: WorkspaceMode) -> &'a str {
    if mode == WorkspaceMode::Mission {
        &run.id
    } else {
        task_id
    }
}

/// Where a task's first attempt starts: its destination, or the run's root.
pub(super) fn task_root<'a>(run: &'a Run, destination: Option<&'a TaskDestination>) -> &'a str {
    destination.map_or(run.root_path.as_str(), |d| d.repository.as_str())
}

/// Whether `attempt` works in a worktree this workflow made for its task, for
/// [`workflow::leases_clash`]. Anything else (a legacy adopted checkout, a
/// plain folder) keeps the strict rule.
fn attempt_in_managed_worktree(data: &Stored, attempt: &Attempt) -> bool {
    attempt.is_worktree
        && data
            .tasks
            .get(&attempt.task_id)
            .and_then(|t| t.workspace.as_ref())
            .is_some_and(|ws| ws.plan.is_managed_worktree())
}

/// Plan a task's workspace without creating, locking or refreshing anything.
pub(super) fn propose(
    run: &Run,
    task_id: &str,
    destination: Option<&TaskDestination>,
    worker: Option<&automation::WorkerSettings>,
) -> WorkspaceProposal {
    let chosen = worker
        .map(|w| w.access)
        .or_else(|| run.worker_defaults.as_ref().map(|d| d.access));
    let mode = auto_mode_for(
        first_mode(run.workspace_mode, chosen.unwrap_or(Access::Auto)),
        run.workspace_mode,
        task_root(run, destination),
    );
    let provisional = chosen.is_none() && run.workspace_mode == WorkspaceMode::Auto;
    let proposed_at = now_ms();
    match workflow::plan(
        task_root(run, destination),
        "",
        workspace_key(run, task_id, mode),
        mode,
    ) {
        Ok(plan) => {
            let conflict = workflow::occupied(&plan);
            WorkspaceProposal {
                new_branch: plan.managed && conflict.is_none(),
                conflict,
                error: None,
                plan: Some(plan),
                provisional,
                proposed_at,
            }
        }
        Err(error) => WorkspaceProposal {
            plan: None,
            new_branch: false,
            conflict: None,
            error: Some(error),
            provisional,
            proposed_at,
        },
    }
}

fn mode_words(mode: WorkspaceMode) -> &'static str {
    match mode {
        WorkspaceMode::Agent => "Agent worktree",
        WorkspaceMode::Direct => "the current checkout",
        WorkspaceMode::Mission => "the mission's worktree",
        _ => "a new worktree",
    }
}

/// A first launch allocates exactly the approved branch and path, from the
/// approved base, or nothing. The base's tip may have moved on since; its name,
/// the branch, the repository and the directory may not.
fn approved_plan(
    proposal: &WorkspaceProposal,
    approved: &WorkspacePlan,
    root: &str,
    launch: &WorkerLaunch,
    task_id: &str,
    mode: WorkspaceMode,
) -> Result<WorkspacePlan, String> {
    if proposal.provisional && mode == WorkspaceMode::Direct && mode != approved.mode {
        return workflow::plan(root, &launch.base_branch, task_id, mode);
    }
    if !launch.base_branch.is_empty() && launch.base_branch != approved.base_branch {
        return Err(format!(
            "The approved plan starts from {}, not {}. Create a new task to start from another branch.",
            approved.base_branch, launch.base_branch
        ));
    }
    // A mission in a folder with no Git plans as that folder (`workflow::plan`).
    let in_place = mode == WorkspaceMode::Mission && !approved.is_repo;
    if mode != approved.mode && !in_place {
        return Err(format!(
            "The approved plan uses {}, but this launch would use {}. Launch with the planned access, or create a new task.",
            mode_words(approved.mode),
            mode_words(mode)
        ));
    }
    // Current checkout mode never switches branches, so plan it as it is and
    // say plainly when that is no longer the branch the person approved.
    let base = if mode == WorkspaceMode::Direct {
        ""
    } else {
        approved.base_branch.as_str()
    };
    let fresh = workflow::plan(root, base, task_id, mode)?;
    if fresh.branch != approved.branch {
        return Err(if mode == WorkspaceMode::Direct {
            format!(
                "The approved plan works on {} in the current checkout, which is now on {}. Switch it back, or create a new task.",
                approved.branch, fresh.branch
            )
        } else {
            format!(
                "The approved plan uses branch {}; the host would now create {}. Create a new task.",
                approved.branch, fresh.branch
            )
        });
    }
    if fresh.cwd != approved.cwd
        || fresh.checkout_root != approved.checkout_root
        || fresh.repository_root != approved.repository_root
    {
        return Err(format!(
            "The approved plan works in {}; the host would now use {}. Create a new task for the new location.",
            approved.cwd, fresh.cwd
        ));
    }
    if let Some(conflict) = workflow::occupied(&fresh) {
        return Err(format!(
            "{conflict} The approved plan makes a new branch and worktree, so nothing already there is reused. Move it aside, or create a new task."
        ));
    }
    Ok(fresh)
}

impl OrchestrationStore {
    /// Ownership facts for live-session admission, derived from the ledger.
    /// A process remaining between turns is not itself an unsettled lease.
    pub(crate) fn session_workspace_owners(
        &self,
    ) -> Result<BTreeMap<String, (String, bool, bool)>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        Ok(inner
            .data
            .attempts
            .values()
            .map(|attempt| {
                (
                    attempt.worker_chat_key.clone(),
                    (
                        inner
                            .data
                            .tasks
                            .get(&attempt.task_id)
                            .and_then(|t| t.workspace.as_ref())
                            .filter(|ws| ws.plan.cwd == attempt.cwd)
                            .map_or_else(
                                || attempt.cwd.clone(),
                                |ws| ws.plan.checkout_root.clone(),
                            ),
                        attempt_in_managed_worktree(&inner.data, attempt),
                        !attempt_is_unsettled(&inner.data, attempt),
                    ),
                )
            })
            .fold(
                BTreeMap::<String, (String, bool, bool)>::new(),
                |mut owners, (key, owner)| {
                    owners
                        .entry(key)
                        .and_modify(|current| {
                            current.2 &= owner.2;
                            current.1 &= owner.1;
                        })
                        .or_insert(owner);
                    owners
                },
            ))
    }

    /// Give every unstarted task that has neither a workspace nor a proposal
    /// one: tasks created before proposals existed, so an open plan shows its
    /// branch too. Git runs outside the store lock; a task that gained either
    /// in the meantime keeps what it has.
    pub fn propose_missing_workspaces(&self) -> Result<(), String> {
        let wanted: Vec<(Run, Task)> = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            if inner.load_error.is_some() {
                return Ok(());
            }
            inner
                .data
                .tasks
                .values()
                .filter(|t| t.workspace.is_none() && t.workspace_proposal.is_none())
                .filter(|t| t.active_attempt_id.is_none())
                .filter(|t| matches!(t.status, TaskStatus::Pending | TaskStatus::Ready))
                .filter_map(|t| {
                    let run = inner.data.runs.get(&t.run_id)?;
                    let open = matches!(
                        run.status,
                        RunStatus::Planning | RunStatus::Running | RunStatus::Waiting
                    ) && run.archived_at.is_none();
                    open.then(|| (run.clone(), t.clone()))
                })
                .collect()
        };
        if wanted.is_empty() {
            return Ok(());
        }
        let proposals: Vec<(String, WorkspaceProposal)> = wanted
            .iter()
            .map(|(run, task)| {
                let proposal =
                    if let Some(mode) = task.approved.as_ref().and_then(|a| a.workspace_mode) {
                        let mut fixed = run.clone();
                        fixed.workspace_mode = mode;
                        if mode == WorkspaceMode::Agent {
                            propose_assigned(
                                &fixed,
                                &task.id,
                                task.destination.as_ref(),
                                task.worker.as_ref(),
                                task.assignee.as_ref(),
                            )
                        } else {
                            propose(
                                &fixed,
                                &task.id,
                                task.destination.as_ref(),
                                task.worker.as_ref(),
                            )
                        }
                    } else {
                        propose_assigned(
                            run,
                            &task.id,
                            task.destination.as_ref(),
                            task.worker.as_ref(),
                            task.assignee.as_ref(),
                        )
                    };
                (task.id.clone(), proposal)
            })
            .collect();
        let runs = self.mutate(|data| {
            let mut runs = BTreeSet::new();
            for (id, proposal) in proposals {
                let Some(task) = data.tasks.get_mut(&id) else {
                    continue;
                };
                if task.workspace.is_none()
                    && task.workspace_proposal.is_none()
                    && task.active_attempt_id.is_none()
                {
                    task.workspace_proposal = Some(proposal);
                    runs.insert(task.run_id.clone());
                }
            }
            Ok(runs)
        })?;
        for run in runs {
            announce(&run, "workspace_proposed");
        }
        Ok(())
    }

    pub(super) fn owned_task(&self, actor: &str, task_id: &str) -> Result<(Run, Task), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let task = inner
            .data
            .tasks
            .get(task_id)
            .ok_or("Task does not exist.")?
            .clone();
        let run = coordinator(&inner.data, &task.run_id, actor)?.clone();
        Ok((run, task))
    }

    pub(super) fn prepare_task_workspace(
        &self,
        chats: &ChatManager,
        run: &Run,
        task: &Task,
        attempt: &Attempt,
        previous: Option<&Attempt>,
        launch: &WorkerLaunch,
    ) -> Result<crate::git_ops::PreparedWorkspace, String> {
        let writable = launch.access != Access::Read;
        let saved = task.workspace.clone();
        let plan = if let Some(saved) = &saved {
            if saved.state == WorkspaceState::Cleaned || saved.abandoned {
                return Err("This workspace is closed. Create a new task for new work.".into());
            }
            if let Some(evidence) = &saved.delivery {
                if evidence.merged {
                    return Err(
                        "This workspace was merged. Create a new task for follow-up work.".into(),
                    );
                }
            }
            saved.plan.clone()
        } else if let Some(previous) = previous.filter(|a| {
            !a.cwd.is_empty()
                && task
                    .approved
                    .as_ref()
                    .and_then(|a| a.workspace_mode)
                    .is_none()
        }) {
            // Only records without an approved mode adopt a previous checkout.
            // An approved task allocates its approved plan even if a legacy
            // attempt names another location. Adoption grants no cleanup ownership.
            let mut adopted = workflow::plan(&previous.cwd, "", &task.id, WorkspaceMode::Direct)?;
            if !previous.branch.is_empty() && previous.branch != adopted.branch {
                return Err("The previous attempt's branch changed.".into());
            }
            adopted.mode = if previous.is_worktree {
                WorkspaceMode::Worktree
            } else {
                WorkspaceMode::Direct
            };
            adopted
        } else {
            let mode = launch_mode(run, task, launch);
            if task
                .approved
                .as_ref()
                .and_then(|a| a.workspace_mode)
                .is_none()
                && run.workspace_mode == WorkspaceMode::Auto
                && writable
                && launch.new_worktree == Some(false)
            {
                return Err("A first writing attempt in Auto mode uses an isolated worktree. Choose Current checkout on the plan card to edit it directly.".into());
            }
            let root = task_root(run, task.destination.as_ref());
            // What the person approved is what gets allocated. A task from
            // before proposals, or one whose proposal failed, plans now.
            match task
                .workspace_proposal
                .as_ref()
                .and_then(|p| Some((p, p.plan.as_ref()?)))
            {
                Some((proposal, approved)) => approved_plan(
                    proposal,
                    approved,
                    root,
                    launch,
                    workspace_key(run, &task.id, mode),
                    mode,
                )?,
                None => workflow::plan(
                    root,
                    &launch.base_branch,
                    workspace_key(run, &task.id, mode),
                    mode,
                )?,
            }
        };
        if writable
            && run.workspace_mode == WorkspaceMode::Auto
            && task.approved.as_ref().and_then(|a| a.workspace_mode) != Some(WorkspaceMode::Direct)
            && plan.mode == WorkspaceMode::Direct
            && previous.is_some_and(|a| a.access == Access::Read)
        {
            return Err("This Auto workspace was assigned for read-only work. Create a new writing task to isolate its changes, or use an explicitly chosen Current checkout run.".into());
        }
        // Serialize lifecycle operations, then claim the canonical checkout in
        // the store BEFORE any filesystem side effect. Another run sees it too.
        let old_chats = self.mutate(|data| {
            let current = data.attempts.get(&attempt.id).ok_or("Attempt disappeared.")?;
            if current.status != AttemptStatus::Preparing { return Err("Attempt is no longer preparing.".into()); }
            let mut old_chats = Vec::new();
            let managed = plan.is_managed_worktree();
            for other in data.tasks.values() {
                let Some(other_ws) = &other.workspace else { continue; };
                if other_ws.swept_at.is_some() { continue; }
                if !workflow::leases_clash(&other_ws.plan.checkout_root, other_ws.plan.is_managed_worktree(), &plan.checkout_root, managed) { continue; }
                if other_ws.state == WorkspaceState::Cleaning { return Err("Workspace cleanup is in progress.".into()); }
                if let Some(owner) = other_ws.lease_attempt_id.as_ref().and_then(|id| data.attempts.get(id)) {
                    if owner.id == attempt.id { continue; }
                    if writable && owner.access != Access::Read && attempt_is_unsettled(data, owner) {
                        return Err(format!("This checkout is already leased to task {}. Use Worktree mode or wait for its writer.", other.id));
                    }
                    if !attempt_is_unsettled(data, owner) { old_chats.push(owner.worker_chat_key.clone()); }
                }
            }
            for other in data.attempts.values().filter(|a| a.id != attempt.id && !a.cwd.is_empty() && attempt_is_unsettled(data, a)) {
                if writable && other.access != Access::Read && workflow::leases_clash(&workflow::held_checkout(&other.cwd), attempt_in_managed_worktree(data, other), &plan.checkout_root, managed) {
                    return Err(format!("This checkout is already leased to task {}.", other.task_id));
                }
            }
            let resource = TaskWorkspace { plan: plan.clone(), swept_at: saved.as_ref().and_then(|w| w.swept_at), state: saved.as_ref().map_or(WorkspaceState::Preparing, |w| w.state),
                lease_attempt_id: Some(attempt.id.clone()), delivery: None, abandoned: false, cleanup_intent: None,
                validation_paths: saved.as_ref().map(|w| w.validation_paths.clone()).unwrap_or_default() };
            let task = data.tasks.get_mut(&task.id).ok_or("Task disappeared.")?;
            task.workspace = Some(resource);
            let current = data.attempts.get_mut(&attempt.id).unwrap();
            current.cwd = plan.cwd.clone(); current.branch = plan.branch.clone(); current.is_worktree = plan.mode.is_worktree();
            Ok(old_chats)
        })?;
        // Settled processes must actually stop before a new writer starts.
        for key in old_chats
            .into_iter()
            .chain(previous.map(|p| p.worker_chat_key.clone()))
        {
            crate::agent_chat::chat_stop_impl(chats, key)?;
        }
        chats.require_workspace_available(
            &plan.checkout_root,
            &attempt.worker_chat_key,
            &run.coordinator_chat_key,
            writable,
            plan.is_managed_worktree(),
        )?;
        if saved.as_ref().is_some_and(|w| w.swept_at.is_some()) {
            crate::git_ops::restore_worktree(
                &plan.repository_root,
                &plan.checkout_root,
                &plan.branch,
                "",
            )?;
            workflow::provision(&plan)?;
        } else if saved
            .as_ref()
            .is_none_or(|w| w.state == WorkspaceState::Preparing)
        {
            workflow::provision(&plan)?;
        } else {
            workflow::verify(&plan)?;
        }
        self.mutate(|data| {
            let current = data
                .attempts
                .get(&attempt.id)
                .ok_or("Attempt disappeared.")?;
            if current.status != AttemptStatus::Preparing {
                return Err("Attempt stopped while its workspace was being prepared.".into());
            }
            let ws = data
                .tasks
                .get_mut(&task.id)
                .and_then(|t| t.workspace.as_mut())
                .ok_or("Workspace disappeared.")?;
            ws.state = WorkspaceState::Ready;
            ws.swept_at = None;
            for other in data.tasks.values_mut().filter_map(|t| t.workspace.as_mut()) {
                if other.plan.checkout_root == plan.checkout_root {
                    other.swept_at = None;
                }
            }
            for delivery in data
                .runs
                .values_mut()
                .flat_map(|r| r.mission_delivery.iter_mut())
            {
                if delivery.checkout_root == plan.checkout_root {
                    delivery.swept_at = None;
                }
            }
            Ok(())
        })?;
        Ok(crate::git_ops::PreparedWorkspace {
            cwd: plan.cwd,
            branch: plan.branch,
            is_repo: plan.is_repo,
            is_worktree: plan.mode.is_worktree(),
        })
    }

    /// Keep browser Git mutations atomic with workspace lifecycle operations.
    /// User commits/pulls/branch changes must not race a running worker either.
    pub fn guard_git_operation(&self, path: &str) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        let guard = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        self.require_workspace_access("git-panel", path, true)?;
        Ok(guard)
    }

    /// Hold workspace lifecycle still: until the guard is dropped no worker is
    /// handed a checkout and no cleanup starts. `chat_recover` holds it from
    /// its checks until the chat it put back has been started.
    pub(crate) fn hold_workspace_lifecycle(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.workspace_ops.lock().map_err(|e| e.to_string())
    }

    /// Whether the host may put the removed folder `path` back for
    /// `chat_key`'s chat (`chat_recover`). Asked with the lifecycle held.
    ///
    /// Stricter than a chat's own admission (`chat_workspace_access`), which
    /// lets the person write beside a worker: this would CREATE the checkout,
    /// or move a chat into it, on the word of a page that may be stale. So it
    /// is refused for a worker's chat, whose folder comes with its task, and
    /// while a task holds the checkout on a lease, is preparing it or is
    /// cleaning it up. The folder is gone and git cannot be asked what it
    /// was, so paths are compared as far as they still exist.
    pub(crate) fn require_no_owner_of_removed(
        &self,
        chat_key: &str,
        path: &str,
    ) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        if inner
            .data
            .attempts
            .values()
            .any(|a| a.worker_chat_key == chat_key)
        {
            return Err(format!(
                "The folder {path} was removed. It belongs to a task, and its run puts it back when the task starts again."
            ));
        }
        let as_far_as_it_exists = |path: &str| {
            let path = Path::new(path.trim_end_matches(['/', '\\']));
            crate::paths::canonical_target(path).unwrap_or_else(|| path.to_path_buf())
        };
        let gone = as_far_as_it_exists(path);
        for task in inner.data.tasks.values() {
            let Some(ws) = &task.workspace else {
                continue;
            };
            let held = ws.swept_at.is_none()
                && (ws.lease_attempt_id.is_some()
                    || matches!(
                        ws.state,
                        WorkspaceState::Preparing | WorkspaceState::Cleaning
                    ));
            // A plan with no checkout names nothing, and every path starts
            // with nothing.
            if !held || ws.plan.checkout_root.trim().is_empty() {
                continue;
            }
            let root = as_far_as_it_exists(&ws.plan.checkout_root);
            let shared = gone.starts_with(&root)
                || (!ws.plan.is_managed_worktree() && root.starts_with(&gone));
            if !shared {
                continue;
            }
            return Err(if ws.state == WorkspaceState::Cleaning {
                format!("The folder {path} was removed: its workspace is being cleaned up. Start a new chat.")
            } else {
                format!(
                    "The folder {path} was removed, and task \"{}\" holds that checkout ({}). The host does not rebuild a folder under a running task; send again once the task has settled.",
                    task.title, ws.plan.checkout_root
                )
            });
        }
        Ok(())
    }

    /// The strict check: refused while any worker writes in `path`. The Git
    /// panel and handing a worktree over use it; a chat the person drives uses
    /// `chat_workspace_access`, which is told rather than refused.
    pub fn require_workspace_access(
        &self,
        chat_key: &str,
        path: &str,
        writable: bool,
    ) -> Result<(), String> {
        match self.writers_beside(chat_key, path, writable)?.first() {
            Some(writer) => Err(writer.refusal()),
            None => Ok(()),
        }
    }

    /// Called from every managed chat launch/send. The person often runs
    /// several chats in one direction, so a chat that could write where an
    /// orchestration worker writes is let through, and the writers are handed
    /// back to be shown in it. An orchestration worker's own chat is still
    /// refused: a Mission keeps one writer at a time.
    pub fn chat_workspace_access(
        &self,
        chat_key: &str,
        path: &str,
        writable: bool,
    ) -> Result<Vec<WriterBeside>, String> {
        let writers = self.writers_beside(chat_key, path, writable)?;
        let Some(first) = writers.first() else {
            return Ok(writers);
        };
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner
            .data
            .attempts
            .values()
            .any(|a| a.worker_chat_key == chat_key)
        {
            return Err(first.refusal());
        }
        Ok(writers)
    }

    /// The unsettled workers writing in `path`'s checkout, other than this
    /// chat and its run's coordinator. A coordinator may continue
    /// coordinating; its prompt forbids editing a checkout delegated to
    /// workers. A workspace being cleaned up is refused outright.
    fn writers_beside(
        &self,
        chat_key: &str,
        path: &str,
        writable: bool,
    ) -> Result<Vec<WriterBeside>, String> {
        let mut writers = Vec::new();
        if path.trim().is_empty() {
            return Ok(writers);
        }
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        if !inner.data.tasks.values().any(|t| {
            t.workspace.as_ref().is_some_and(|ws| {
                ws.lease_attempt_id.is_some() || ws.state == WorkspaceState::Cleaning
            })
        }) {
            return Ok(writers);
        }
        let checkout = workflow::checkout_identity(path)?;
        for task in inner.data.tasks.values() {
            let Some(ws) = &task.workspace else {
                continue;
            };
            // The same rule dispatch uses (`require_workspace_available`): a
            // managed worktree is shared only by a chat working INSIDE it. A
            // chat in the plain folder above it (the Starfall layout) was not
            // handed that worktree, and refusing it locked every writable chat
            // in the project for as long as any worker ran.
            let managed = ws.plan.is_managed_worktree();
            if !workflow::shares_checkout(&ws.plan.checkout_root, &checkout, managed) {
                continue;
            }
            if ws.state == WorkspaceState::Cleaning {
                return Err("This workspace is being cleaned up.".into());
            }
            if !writable {
                continue;
            }
            if let Some(owner) = ws
                .lease_attempt_id
                .as_ref()
                .and_then(|id| inner.data.attempts.get(id))
            {
                if owner.worker_chat_key == chat_key {
                    continue;
                }
                if inner
                    .data
                    .runs
                    .get(&task.run_id)
                    .is_some_and(|r| r.coordinator_chat_key == chat_key)
                {
                    continue;
                }
                if owner.access != Access::Read && attempt_is_unsettled(&inner.data, owner) {
                    writers.push(WriterBeside {
                        task_id: task.id.clone(),
                        title: task.title.clone(),
                        checkout: ws.plan.checkout_root.clone(),
                    });
                }
            }
        }
        Ok(writers)
    }

    /// The task `actor` may manage validation checkouts of: its coordinator's,
    /// or its own active one. `removing` is a removal, not a new checkout.
    fn validation_task(&self, actor: &str, task_id: &str, removing: bool) -> Result<Task, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let task = inner
            .data
            .tasks
            .get(task_id)
            .ok_or("Task does not exist.")?;
        let run = inner
            .data
            .runs
            .get(&task.run_id)
            .ok_or("Run does not exist.")?;
        let own = active_attempt_for_task(&inner.data, actor, task_id).is_some();
        if actor != run.coordinator_chat_key && !own {
            return Err(
                "Only this task's active worker or coordinator can manage validation workspaces."
                    .into(),
            );
        }
        // A peer request's worker reads `validationPaths` back with its
        // task, and a checkout holds whatever commits its maker chose. The
        // coordinator makes none, and removes one only once the teammate
        // has settled, which is what lets the workspace be cleaned up.
        if task.peer_request.is_some() && !own {
            if !removing {
                return Err(super::peer_request::PEERS_VALIDATION.into());
            }
            if inner
                .data
                .attempts
                .values()
                .any(|a| a.task_id == task_id && attempt_is_unsettled(&inner.data, a))
            {
                return Err(super::peer_request::PEERS_VALIDATION_IN_USE.into());
            }
        }
        Ok(task.clone())
    }

    pub fn create_validation(
        &self,
        actor: &str,
        task_id: &str,
        base_sha: &str,
        commits: Vec<String>,
    ) -> Result<String, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let task = self.validation_task(actor, task_id, false)?;
        let ws = task.workspace.as_ref().ok_or("Task has no workspace.")?;
        if ws.state == WorkspaceState::Cleaned || ws.state == WorkspaceState::Cleaning {
            return Err("Workspace is closed.".into());
        }
        if commits.len() > 50 {
            return Err("Choose at most 50 commits for one validation checkout.".into());
        }
        let target = std::env::temp_dir()
            .canonical()
            .map_err(|e| e.to_string())?
            .join(format!("octiq-validation-{}", compact_id()));
        let path = target.to_string_lossy().into_owned();
        self.mutate(|data| {
            data.tasks
                .get_mut(task_id)
                .and_then(|t| t.workspace.as_mut())
                .ok_or("Workspace disappeared.")?
                .validation_paths
                .push(path.clone());
            Ok(())
        })?;
        let result = workflow::validation_worktree(&ws.plan, base_sha, &commits, &target);
        if let Err(error) = result {
            // Recorded before creation so a crash cannot orphan the folder.
            // When nothing was made, there is nothing to retain or point at.
            if !target.exists() {
                self.mutate(|data| {
                    if let Some(ws) = data
                        .tasks
                        .get_mut(task_id)
                        .and_then(|t| t.workspace.as_mut())
                    {
                        ws.validation_paths.retain(|p| p != &path);
                    }
                    Ok(())
                })?;
                return Err(error);
            }
            announce(&task.run_id, "validation_created");
            return Err(format!("{error} Validation allocation retained at {path}; inspect or remove it through orchestration_validation_remove."));
        }
        announce(&task.run_id, "validation_created");
        Ok(path)
    }

    pub fn remove_validation(
        &self,
        chats: &ChatManager,
        actor: &str,
        task_id: &str,
        path: &str,
    ) -> Result<Task, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let task = self.validation_task(actor, task_id, true)?;
        let ws = task.workspace.as_ref().ok_or("Task has no workspace.")?;
        if !ws.validation_paths.iter().any(|p| p == path) {
            return Err("This task does not own that validation workspace.".into());
        }
        let _held = crate::worktree_lifespan::hold_removal(chats, path)?;
        drop(_operation);
        let proof = crate::worktree_lifespan::validation_removal_proof(path)?;
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let task = self.validation_task(actor, task_id, true)?;
        let ws = task.workspace.as_ref().ok_or("Task has no workspace.")?;
        if !ws.validation_paths.iter().any(|p| p == path) {
            return Err("This task no longer owns that validation workspace.".into());
        }
        let _budget = crate::git_ops::lifespan::FinalBudget::start();
        chats.require_lifespan_idle(path)?;
        workflow::remove_validation_verified(&ws.plan, path, proof.as_ref())?;
        self.mutate(|data| {
            let task = data.tasks.get_mut(task_id).ok_or("Task disappeared.")?;
            task.workspace
                .as_mut()
                .unwrap()
                .validation_paths
                .retain(|p| p != path);
            Ok(task.clone())
        })
        .inspect(|t| announce(&t.run_id, "validation_removed"))
    }

    pub fn refresh_workspace(&self, actor: &str, task_id: &str) -> Result<Task, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let (_, task) = self.owned_task(actor, task_id)?;
        let ws = task
            .workspace
            .as_ref()
            .ok_or("This task has no workspace yet.")?;
        if ws.state == WorkspaceState::Cleaned {
            return Ok(task);
        }
        let mut evidence = workflow::inspect(&ws.plan, true)?;
        // Only a merged commit can be running; the check is not run before.
        if evidence.merged && evidence.has_commits {
            let run = self
                .snapshot(Some(&task.run_id))?
                .runs
                .into_iter()
                .next()
                .ok_or("Run disappeared.")?;
            (evidence.released, evidence.release_note) = crate::chat_task::release_status(
                &run.workspace_id,
                &ws.plan.repository_root,
                &evidence.head_sha,
            );
        }
        self.mutate(|data| {
            let task = data.tasks.get_mut(task_id).ok_or("Task disappeared.")?;
            task.workspace
                .as_mut()
                .ok_or("Workspace disappeared.")?
                .delivery = Some(evidence);
            task.updated_at = now_ms();
            Ok(task.clone())
        })
        .inspect(|t| announce(&t.run_id, "workspace_refreshed"))
    }

    /// Give a completed task new instructions and make it ready again, in
    /// the workspace it kept. The person's decision of 2026-10-11: this needs
    /// no new approval, so `approved_at` stays, and with it everything the
    /// approval fixed (`approval::Approved`): the reopened task starts as the
    /// same worker, for the same assignee, in the same place, or not at all.
    /// Only the words change, and they are never changed out of sight:
    ///
    /// - the task keeps each reopen (`Task::reopens`: who, when, for which
    ///   attempt, the instructions before and after);
    /// - the coordinator's chat gets one durable `octiq_task_reopened` event
    ///   in its transcript, stamped by the host, which the page draws as a
    ///   line the person can open to read the new instructions.
    ///
    /// A peer request is not reopened at all.
    ///
    /// **The reopened task does not start until that event is in the
    /// transcript, on disk** (review of 931b5f0, H5). The reopen is recorded
    /// with its notice owed (`TaskReopen::notice_delivered`), every start
    /// of the task is refused while it is (`REOPEN_NOT_TOLD`), and the
    /// notice is written right after the ledger is, and again on every pass
    /// of the scheduler until it holds (`deliver_reopen_notices`). A reopen
    /// with nowhere to be shown is refused outright: the coordinator's chat
    /// has to be one the person can open.
    pub fn reopen_task(&self, actor: &str, task_id: &str, spec: String) -> Result<Task, String> {
        self.reopen_task_as(actor, task_id, spec, ReopenedBy::Coordinator)
    }

    /// `reopen_task`, for whoever asks (`ReopenedBy`). The person's own
    /// reopen, from the page, differs in three things, each of which their
    /// Start on a failed task's row already does:
    ///
    /// - it is not asked whether automatic retries remain, and it gives
    ///   them all back: a failed check whose retries are used is theirs to
    ///   decide, and this is them deciding (review of 16e4188, M1: nothing
    ///   the page could send got such a check going again);
    /// - it closes the decision the coordinator opened about the task;
    /// - the start that follows is theirs, and uses no retry
    ///   (`persons_reopen`).
    ///
    /// And one of its own: the words are the person's, so where the
    /// coordinator's chat is gone there is nobody left to show them to, and
    /// the reopen is recorded as told. In a chat that is there the notice
    /// is written and waited for like any other, which keeps the record of
    /// it in the conversation. A list of chats that cannot be read is not a
    /// chat that is gone: that reopen is refused, as before.
    pub fn reopen_task_as(
        &self,
        actor: &str,
        task_id: &str,
        spec: String,
        by: ReopenedBy,
    ) -> Result<Task, String> {
        let spec = required_text("follow-up instructions", spec, 40_000)?;
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let reopened = self.mutate(|data| {
            let task = data.tasks.get(task_id).ok_or("Task does not exist.")?.clone();
            let run = coordinator(data, &task.run_id, actor)?;
            let coordinator_chat = run.coordinator_chat_key.clone();
            // What the person approved was this request's own words. New
            // instructions on it would be work nobody approved, started by an
            // agent: a lead chat coordinates its own requests.
            if task.peer_request.is_some() { return Err(super::peer_request::NOT_REOPENED.into()); }
            if run.status == RunStatus::Stopped { return Err("A stopped run cannot be reopened.".into()); }
            if run.archived_at.is_some() { return Err("This run is archived. Restore it before reopening a task.".into()); }
            if task.status != TaskStatus::Completed { return Err("Only a completed task can be reopened for review fixes. Use retry for failed or blocked tasks.".into()); }
            // A failed check that used its automatic retries, or that the
            // coordinator put to the person, is not made ready to fail again:
            // its start would be refused, and it would wait where nobody
            // is told of it (`retry.rs`).
            if by == ReopenedBy::Coordinator {
                super::retry::allows(data, &task, super::retry::counted(data, &task))?;
            }
            let ws = task.workspace.as_ref().ok_or("This task has no retained workspace.")?;
            if ws.state == WorkspaceState::Cleaned || ws.abandoned || ws.delivery.as_ref().is_some_and(|d| d.merged) {
                return Err("This workspace is closed. Create a new task for new work.".into());
            }
            // Reopening a prerequisite while its dependants have started would
            // silently invalidate those results. Ask for a new follow-up task.
            if data.tasks.values().any(|t| t.depends_on.contains(&task.id) && t.active_attempt_id.is_some()) {
                return Err("A dependent task already started. Create a separate follow-up task instead.".into());
            }
            // The person is shown every reopen in the coordinator's chat.
            // With no chat of theirs to show it in, there is no reopen,
            // unless the words are their own.
            let told = match (by, shown_in(&coordinator_chat)) {
                (_, Ok(true)) => false,
                (ReopenedBy::Person, Ok(false)) => true,
                (ReopenedBy::Coordinator, Ok(false)) => return Err(CHAT_GONE.into()),
                (_, Err(error)) => return Err(chat_unknown(&error)),
            };
            for dependent in data.tasks.values_mut() {
                if dependent.depends_on.iter().any(|id| id == task_id) && dependent.status == TaskStatus::Ready {
                    dependent.status = TaskStatus::Pending;
                }
            }
            let attempt = data.attempts.values().filter(|a| a.task_id == task_id).count().saturating_add(1) as u32;
            let now = now_ms();
            let by_person = by == ReopenedBy::Person;
            if by_person {
                super::retry::person_decided(data, task_id, now);
            }
            let task = data.tasks.get_mut(task_id).unwrap();
            let previous_spec = std::mem::replace(&mut task.spec, spec);
            task.status = TaskStatus::Ready; task.result = None; task.updated_at = now;
            task.reopens.push(TaskReopen { by_chat_key: actor.to_owned(), at: now, attempt, previous_spec, spec: task.spec.clone(), notice_delivered: told, by_person });
            // Both texts of each are kept whole, so the list has an end.
            let over = task.reopens.len().saturating_sub(MAX_REOPENS_KEPT);
            task.reopens.drain(..over);
            let result = task.clone();
            recompute_run(data, &result.run_id);
            Ok(result)
        })?;
        announce(&reopened.run_id, "task_reopened");
        // After the ledger's write, so the transcript never tells of a
        // reopen the ledger refused. A notice that cannot be written and
        // confirmed now leaves the task held, and the scheduler tries again.
        if let Err(error) = self.tell_reopens(None) {
            eprintln!("orchestration: a reopen's notice could not be written yet: {error}");
        }
        Ok(self
            .owned_task(actor, task_id)
            .map_or(reopened, |(_, task)| task))
    }

    /// Write the notice of every reopen that has none yet, and record each
    /// one the host now holds a durability receipt for. Answers how many
    /// were recorded. Run by the scheduler on every pass, with the time: a
    /// chat whose transcript gave no receipt is not asked again until its
    /// wait is over (`notice_wait`).
    pub fn deliver_reopen_notices(&self, now: i64) -> Result<usize, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        self.tell_reopens(Some(now))
    }

    /// `deliver_reopen_notices` with no wait honoured: every owed notice is
    /// tried.
    #[cfg(test)]
    pub fn deliver_reopen_notices_now(&self) -> Result<usize, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        self.tell_reopens(None)
    }

    /// `deliver_reopen_notices`, for a caller that holds `workspace_ops`.
    /// That lock is what makes a notice exactly one event: nobody else
    /// looks for it and writes it between this look and this write.
    /// `due_at` is the scheduler's time; `None` tries a waiting chat too.
    ///
    /// A notice already in the transcript is never written again: that is
    /// the notice of a write whose confirmation was lost, to a server that
    /// stopped or a folder that would not sync. Found there or written in
    /// this pass, it is recorded only once the record and its folder have
    /// been synced after it, in this pass, and both succeeded
    /// (`notice_receipts`). The event is made from the reopen as the ledger
    /// keeps it, so every try writes the same one and the page knows it by
    /// task, attempt and time.
    fn tell_reopens(&self, due_at: Option<i64>) -> Result<usize, String> {
        let owed: Vec<(String, serde_json::Value)> = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            if let Some(error) = &inner.load_error {
                return Err(error.clone());
            }
            let data = &inner.data;
            let mut tasks: Vec<&Task> = data
                .tasks
                .values()
                .filter(|task| untold_reopen(task).is_some())
                .collect();
            tasks.sort_by_key(|task| (task.updated_at, task.id.clone()));
            tasks
                .into_iter()
                .filter_map(|task| Some((data.runs.get(&task.run_id)?, task)))
                .flat_map(|(run, task)| {
                    task.reopens
                        .iter()
                        .filter(|reopen| !reopen.notice_delivered)
                        .map(|reopen| {
                            (run.coordinator_chat_key.clone(), reopen_event(task, reopen))
                        })
                })
                .collect()
        };
        // One chat's notices together, in the order they are owed: its
        // transcript is read once a pass, however many it owes.
        let mut chats: Vec<(String, Vec<serde_json::Value>)> = Vec::new();
        for (chat, event) in owed {
            match chats.iter_mut().find(|(key, _)| *key == chat) {
                Some((_, events)) => events.push(event),
                None => chats.push((chat, vec![event])),
            }
        }
        let mut told = 0;
        for (chat, events) in chats {
            // Only in a chat the person can open: a notice in the transcript
            // of a deleted chat has been shown to nobody. Asked first, and
            // it is the cheap question.
            if shown_to_the_person(&chat).is_err() {
                continue;
            }
            if due_at.is_some_and(|now| self.notice_waits(&chat, now)) {
                continue;
            }
            let receipts = notice_receipts(&chat, &events);
            self.notice_tried(
                &chat,
                receipts.iter().all(|held| *held),
                due_at.unwrap_or_else(now_ms),
            );
            for (event, _) in events.iter().zip(&receipts).filter(|(_, held)| **held) {
                let task_id = event["taskId"].as_str().unwrap_or_default().to_owned();
                let (attempt, at) = (event["attempt"].clone(), event["at"].clone());
                let run_id = self.mutate(|data| {
                    let task = data.tasks.get_mut(&task_id).ok_or("Task disappeared.")?;
                    for reopen in &mut task.reopens {
                        if json!(reopen.attempt) == attempt && json!(reopen.at) == at {
                            reopen.notice_delivered = true;
                        }
                    }
                    Ok(task.run_id.clone())
                })?;
                announce(&run_id, "task_reopen_told");
                told += 1;
            }
        }
        Ok(told)
    }

    /// Whether `chat`'s transcript gave no receipt lately and is not due
    /// to be asked again at `now`.
    fn notice_waits(&self, chat: &str, now: i64) -> bool {
        let waits = self.reopen_waits.lock().unwrap_or_else(|e| e.into_inner());
        waits.get(chat).is_some_and(|(_, next)| now < *next)
    }

    /// Record a try at `chat`'s notices: receipts for all of them end its
    /// wait, and anything less makes the next one longer.
    fn notice_tried(&self, chat: &str, all_held: bool, now: i64) {
        let mut waits = self.reopen_waits.lock().unwrap_or_else(|e| e.into_inner());
        if all_held {
            waits.remove(chat);
            return;
        }
        let failures = waits
            .get(chat)
            .map_or(1, |(failures, _)| failures.saturating_add(1));
        let wait = notice_wait(failures);
        waits.insert(chat.to_owned(), (failures, now + wait));
        eprintln!(
            "orchestration: no durability receipt for a reopen notice in {chat} (try {failures}); asking again in {} s",
            wait / 1_000
        );
    }

    pub fn cleanup_workspace(
        &self,
        chats: &ChatManager,
        actor: &str,
        task_id: &str,
        abandon: bool,
        expected_head: &str,
    ) -> Result<Task, String> {
        self.cleanup_workspace_expected(chats, actor, task_id, abandon, expected_head, None, false)
    }

    pub(super) fn cleanup_workspace_expected(
        &self,
        chats: &ChatManager,
        actor: &str,
        task_id: &str,
        abandon: bool,
        expected_head: &str,
        expected_plan: Option<&super::cleanup_request::Worktree>,
        require_finished: bool,
    ) -> Result<Task, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let (_, task) = self.owned_task(actor, task_id)?;
        let ws = task
            .workspace
            .as_ref()
            .ok_or("This task has no workspace.")?;
        if let Some(expected) = expected_plan {
            super::cleanup_request::same_plan(&expected.plan, &ws.plan)?;
            super::cleanup_request::same_presence(expected, &ws.plan)?;
            if ws.state != WorkspaceState::Retained || ws.abandoned {
                return Err("Workspace state changed since the approved card; folder kept.".into());
            }
        }
        if ws.state == WorkspaceState::Cleaned {
            return Ok(task);
        }
        if ws.plan.mode == WorkspaceMode::Agent {
            return Err(
                "Agent worktrees are reused across batches; per-task Cleanup never removes them."
                    .into(),
            );
        }
        if ws.plan.mode == WorkspaceMode::Mission {
            return Err(
                "This task works in its mission's shared worktree. Close the mission to clean it up."
                    .into(),
            );
        }
        if !ws.plan.managed || ws.plan.mode != WorkspaceMode::Worktree {
            return Err(
                "Current checkout and adopted workspaces cannot be cleaned up by this workflow."
                    .into(),
            );
        }
        let workers = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            cleanup_ready(&inner.data, &task, ws, abandon)?;
            inner
                .data
                .attempts
                .values()
                .filter(|a| a.task_id == task_id)
                .map(|a| a.worker_chat_key.clone())
                .collect::<Vec<_>>()
        };
        for key in workers {
            crate::agent_chat::chat_stop_impl(chats, key)?;
        }
        // Retain the exact checkout while content is proved outside lifecycle.
        // Abandon promises preservation too; it has no discard exception.
        let original_plan = ws.plan.clone();
        let _held = crate::worktree_lifespan::hold_removal(chats, &original_plan.checkout_root)?;
        drop(_operation);
        let proof =
            crate::worktree_lifespan::validation_removal_proof(&original_plan.checkout_root)?;
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let (run, task) = self.owned_task(actor, task_id)?;
        let ws = task
            .workspace
            .as_ref()
            .ok_or("Workspace disappeared during proof; folder kept.")?;
        if serde_json::to_value(&ws.plan).map_err(|e| e.to_string())?
            != serde_json::to_value(&original_plan).map_err(|e| e.to_string())?
            || ws.state == WorkspaceState::Cleaned
        {
            return Err(
                "Workspace ownership changed during Restore comparison; folder kept.".into(),
            );
        }
        chats.require_lifespan_idle(&ws.plan.checkout_root)?;
        self.mutate(|data| {
            cleanup_ready(data, &task, ws, abandon)?;
            if require_finished {
                // The run was finished when it was proposed and again before
                // the proof; the proof ran without the ledger, so a gate or a
                // worker may have come since. Decided in the same step that
                // marks the checkout Cleaning.
                super::cleanup_request::require_run_finished(data, &run.id)?;
            }
            data.tasks
                .get_mut(task_id)
                .unwrap()
                .workspace
                .as_mut()
                .unwrap()
                .state = WorkspaceState::Cleaning;
            Ok(())
        })?;
        let mut swept_merge_failed = false;
        let cleaned = (|| {
            let snapshot = self.snapshot(Some(&run.id))?;
            for attempt in snapshot.attempts.iter().filter(|a| a.task_id == task_id) {
                crate::agent_chat::chat_stop_impl(chats, attempt.worker_chat_key.clone())?;
            }
            chats.require_checkout_idle(&ws.plan.checkout_root, true)?;
            let swept = ws.swept_at.is_some()
                && matches!(std::fs::symlink_metadata(&ws.plan.checkout_root), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
            // What the folder and the branch were when the swept path was
            // chosen: asked again right before Cleaned is recorded.
            let seen = if swept {
                Some(super::mission::presence(&ws.plan)?)
            } else {
                None
            };
            let evidence = if swept && super::mission::swept_task_branch_gone(ws)? {
                // Folder confirmed missing, branch proven absent: the saved
                // merged delivery answers for it and no git work remains.
                let mut saved = ws.delivery.clone().ok_or("This workspace was swept and has no saved delivery evidence. Restore the kept branch before Cleanup.")?;
                saved.checked_at = now_ms();
                saved
            } else if swept {
                let saved = ws.delivery.clone().ok_or("This workspace was swept and has no saved delivery evidence. Restore the kept branch before Cleanup.")?;
                let head = crate::git_ops::lifespan::text(&ws.plan.repository_root, &[
                    "rev-parse", "--verify", &format!("refs/heads/{}^{{commit}}", ws.plan.branch)
                ]).map_err(|e| format!("This workspace was swept; its kept branch cannot be verified. Restore the branch before Cleanup: {e}"))?;
                if saved.head_sha != head {
                    return Err("This workspace was swept and its kept branch changed. Restore it and refresh delivery evidence before Cleanup.".into());
                }
                let mut saved = saved;
                swept_merge_failed = true;
                let current_base = crate::git_ops::lifespan::text(&ws.plan.repository_root, &[
                    "rev-parse", "--verify", &format!("refs/heads/{}^{{commit}}", ws.plan.base_branch)
                ]).map_err(|e| format!("This workspace was swept; the current base cannot be verified. The record is kept: {e}"))?;
                crate::git_ops::lifespan::git(&ws.plan.repository_root, &[
                    "merge-base", "--is-ancestor", &head, &current_base
                ]).map_err(|e| format!("This workspace was swept; its kept HEAD is not verified as merged into the current base. The record is kept: {e}"))?;
                swept_merge_failed = false;
                saved.merged = true;
                saved.checked_at = now_ms();
                saved
            } else {
                workflow::inspect(&ws.plan, true)?
            };
            #[cfg(test)]
            super::mission::after_swept_evidence();
            if expected_head.is_empty() || evidence.head_sha != expected_head {
                if swept {
                    return Err("This workspace was swept; the preview does not match its verified kept branch. Use that branch's saved delivery HEAD, or restore and refresh before Cleanup.".into());
                }
                return Err(
                    "HEAD changed since the cleanup preview. Refresh delivery status first.".into(),
                );
            }
            if evidence.dirty {
                if swept {
                    return Err("This workspace was swept with uncommitted changes in its saved evidence. Restore its archive and refresh delivery before Cleanup.".into());
                }
                return Err(
                    "Workspace has uncommitted or untracked files. Preserve them before cleanup."
                        .into(),
                );
            }
            if !abandon && !evidence.merged {
                if swept {
                    return Err("This workspace was swept and its saved evidence does not verify merge. Restore the kept branch and refresh delivery, or explicitly Abandon after preserving unpublished commits.".into());
                }
                return Err(
                    "Merge could not be verified for this exact commit and base branch.".into(),
                );
            }
            if abandon && !evidence.pushed && evidence.has_commits {
                if swept {
                    return Err(format!("This workspace was swept; refs/heads/{} keeps unpublished commits. Push that branch or restore it before Abandon cleanup.", ws.plan.branch));
                }
                return Err("Push unpublished commits before abandoning this workspace. Cleanup never discards commits.".into());
            }
            self.mutate(|data| {
                let workspace = data
                    .tasks
                    .get_mut(task_id)
                    .and_then(|t| t.workspace.as_mut())
                    .ok_or("Workspace disappeared.")?;
                workspace.delivery = Some(evidence.clone());
                workspace.cleanup_intent = Some(abandon);
                Ok(())
            })?;
            // A swept workspace removes nothing here, but Cleanup still ends
            // by recording it Cleaned: a named cleanup is decided against the
            // ledger as it is now, after the Git work above, either way.
            if require_finished {
                self.require_named_run_finished(&run.id)?;
            }
            if !swept {
                chats.require_lifespan_idle(&ws.plan.checkout_root)?;
                workflow::cleanup_verified(&ws.plan, &evidence.head_sha, proof.as_ref())?;
            } else if let Some(seen) = seen {
                // A swept workspace removes nothing, so what it records must be
                // what is there now: a folder or a branch made again during the
                // Git work above is not something this Cleanup cleaned.
                let now = super::mission::presence_last(&ws.plan)?;
                if now != seen
                    || expected_plan.is_some_and(|e| now != (e.folder_present, e.branch_present))
                {
                    return Err(format!(
                        "The folder {} or the branch {} appeared or went since the approved card; nothing was recorded. Ask again.",
                        ws.plan.checkout_root, ws.plan.branch
                    ));
                }
            }
            Ok(evidence)
        })();
        let result = self.mutate(|data| {
            // The write that records Cleaned decides again, under the ledger.
            let activated = match (&cleaned, require_finished) {
                (Ok(_), true) => super::cleanup_request::require_run_finished(data, &run.id).err(),
                _ => None,
            };
            let cleaned_ok = cleaned.is_ok() && activated.is_none();
            let task = data.tasks.get_mut(task_id).ok_or("Task disappeared.")?;
            let ws = task.workspace.as_mut().unwrap();
            ws.cleanup_intent = None;
            match &cleaned {
                Ok(evidence) if activated.is_none() => {
                    ws.state = WorkspaceState::Cleaned;
                    ws.lease_attempt_id = None;
                    ws.delivery = Some(evidence.clone());
                    ws.abandoned = abandon;
                    if abandon {
                        task.status = TaskStatus::Cancelled;
                    }
                }
                Ok(_) => {
                    // The run became active again at the last look: nothing
                    // is recorded, unless a folder this call removed is gone.
                    if ws.swept_at.is_none() && !Path::new(&ws.plan.checkout_root).exists() {
                        ws.state = WorkspaceState::Cleaned;
                        ws.lease_attempt_id = None;
                    } else {
                        ws.state = WorkspaceState::Retained;
                    }
                }
                Err(error) => {
                    ws.state = WorkspaceState::Retained;
                    if swept_merge_failed {
                        if let Some(delivery) = &mut ws.delivery {
                            delivery.merged = false;
                            delivery.released = None;
                            delivery.release_note.clear();
                            delivery.checked_at = now_ms();
                            delivery
                                .notes
                                .push(format!("Current base merge verification failed: {error}"));
                        }
                    }
                }
            }
            task.updated_at = now_ms();
            let result = task.clone();
            if cleaned_ok && abandon {
                let mut cancelled = BTreeSet::from([task_id.to_string()]);
                loop {
                    let mut added = false;
                    for dependent in data.tasks.values_mut() {
                        if dependent.active_attempt_id.is_none()
                            && dependent.status != TaskStatus::Cancelled
                            && dependent.depends_on.iter().any(|id| cancelled.contains(id))
                        {
                            dependent.status = TaskStatus::Cancelled;
                            dependent.result =
                                Some("A prerequisite workspace was abandoned.".into());
                            cancelled.insert(dependent.id.clone());
                            added = true;
                        }
                    }
                    if !added {
                        break;
                    }
                }
            }
            recompute_run(data, &run.id);
            Ok((result, activated))
        })?;
        let (result, activated) = result;
        announce(&run.id, "workspace_cleanup");
        if let Some(reason) = activated {
            return Err(reason);
        }
        cleaned.map(|_| result)
    }
}

pub(super) fn recover_workspaces(data: &mut Stored) -> bool {
    let mut changed = false;
    for task in data.tasks.values_mut() {
        if let Some(ws) = task.workspace.as_mut() {
            changed |= ws.lease_attempt_id.take().is_some();
            if ws.state == WorkspaceState::Cleaning {
                // A checkout a quarantine record says is aside is not gone:
                // the sweep puts it back, and it stays what it was.
                let removed = !Path::new(&ws.plan.checkout_root).exists()
                    && !crate::worktree_lifespan::quarantine_holds(&ws.plan.checkout_root);
                if removed && ws.cleanup_intent.is_some() {
                    ws.state = WorkspaceState::Cleaned;
                    ws.abandoned = ws.cleanup_intent == Some(true);
                    if ws.abandoned {
                        task.status = TaskStatus::Cancelled;
                    }
                } else {
                    ws.state = WorkspaceState::Retained;
                }
                ws.cleanup_intent = None;
                changed = true;
            }
        }
    }
    changed
}

/// Advice for new assigned work follows the current orientation. Approval
/// freezes it, so a later switch never rewrites a task's accepted mode.
pub(super) fn propose_assigned(
    run: &Run,
    task_id: &str,
    destination: Option<&TaskDestination>,
    worker: Option<&automation::WorkerSettings>,
    assignee: Option<&TaskAssignee>,
) -> WorkspaceProposal {
    let Some(agent) = assignee else {
        return propose(run, task_id, destination, worker);
    };
    let settings = match crate::scheduling::load() {
        Ok(settings) => settings,
        Err(error) => {
            return WorkspaceProposal {
                plan: None,
                new_branch: false,
                conflict: None,
                error: Some(error),
                provisional: false,
                proposed_at: now_ms(),
            }
        }
    };
    if settings.orientation != crate::scheduling::Orientation::Agents
        && run.workspace_mode != WorkspaceMode::Agent
    {
        return propose(run, task_id, destination, worker);
    }
    let root = task_root(run, destination);
    if !workflow::has_git(root) {
        let mut direct = run.clone();
        direct.workspace_mode = WorkspaceMode::Direct;
        return propose(&direct, task_id, destination, worker);
    }
    match workflow::agent_plan(root, "", &agent.id, "batch_pending", None) {
        Ok(mut plan) => {
            // Its branch is allocated only once the lane chooses a batch.
            plan.warnings.push(
                "A new branch and fresh session are allocated when this agent's batch starts."
                    .into(),
            );
            WorkspaceProposal {
                new_branch: !Path::new(&plan.checkout_root).exists(),
                conflict: None,
                plan: Some(plan),
                error: None,
                provisional: false,
                proposed_at: now_ms(),
            }
        }
        Err(error) => WorkspaceProposal {
            plan: None,
            new_branch: false,
            conflict: None,
            error: Some(error),
            provisional: false,
            proposed_at: now_ms(),
        },
    }
}

#[cfg(test)]
pub(super) mod tests;

#[cfg(test)]
mod recovery_tests;

#[cfg(test)]
mod migration_tests;

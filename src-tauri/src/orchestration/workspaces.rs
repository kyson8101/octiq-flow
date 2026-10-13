//! Task workspaces outlive attempts. The persisted plan is the allocation;
//! a lease identifies the only worker allowed to write there.
use super::*;
use crate::git_ops::workflow::{self, DeliveryEvidence, WorkspaceMode, WorkspacePlan};
use crate::paths::Canonical;

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
    json!({
        "type": "octiq_task_reopened",
        "runId": task.run_id,
        "taskId": task.id,
        "title": task.title,
        "assignee": task.assignee,
        "attempt": reopen.attempt,
        "spec": reopen.spec,
        "previousSpecChars": reopen.previous_spec.chars().count(),
        "at": reopen.at,
    })
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
/// line and writes it, once. A compaction keeps every host event and is
/// not a new record.
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
    match crate::chat_index::listed(chat_key.strip_prefix("chat:").unwrap_or(chat_key)) {
        Ok(true) => Ok(()),
        Ok(false) => Err("The coordinator's chat no longer exists, so the person could not be shown this reopen. Nothing was reopened. Create a new task for the follow-up work, from a chat that exists.".into()),
        Err(error) => Err(format!("Whether the coordinator's chat still exists could not be checked ({error}), so the person could not be shown this reopen. Nothing was reopened. Try again.")),
    }
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
    /// instead; every other departure from the plan is still refused.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub provisional: bool,
    pub proposed_at: i64,
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
                let proposal = propose(
                    run,
                    &task.id,
                    task.destination.as_ref(),
                    task.worker.as_ref(),
                );
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
        } else if let Some(previous) = previous.filter(|a| !a.cwd.is_empty()) {
            // Legacy records can be adopted for retries, but are not silently
            // granted cleanup ownership over a person's existing checkout.
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
            let mode = match run.workspace_mode {
                WorkspaceMode::Auto => {
                    if launch.access == Access::Read {
                        WorkspaceMode::Direct
                    } else if launch.new_worktree == Some(false) {
                        return Err("A first writing attempt in Auto mode uses an isolated worktree. Choose Current checkout for the run to edit it directly.".into());
                    } else {
                        WorkspaceMode::Worktree
                    }
                }
                mode => mode,
            };
            // A routed task starts from its destination repository; one
            // without a destination from the run's root, as it always has.
            let root = task_root(run, task.destination.as_ref());
            let mode = auto_mode_for(mode, run.workspace_mode, root);
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
            let resource = TaskWorkspace { plan: plan.clone(), state: saved.as_ref().map_or(WorkspaceState::Preparing, |w| w.state),
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
        if saved
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
            let held = ws.lease_attempt_id.is_some()
                || matches!(
                    ws.state,
                    WorkspaceState::Preparing | WorkspaceState::Cleaning
                );
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
        let own = active_task_for_actor(&inner.data, actor)
            .as_ref()
            .map(|t| t.id.as_str())
            == Some(task_id);
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
        workflow::remove_validation(&ws.plan, path)?;
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
            // With no chat of theirs to show it in, there is no reopen.
            shown_to_the_person(&coordinator_chat)?;
            for dependent in data.tasks.values_mut() {
                if dependent.depends_on.iter().any(|id| id == task_id) && dependent.status == TaskStatus::Ready {
                    dependent.status = TaskStatus::Pending;
                }
            }
            let attempt = data.attempts.values().filter(|a| a.task_id == task_id).count().saturating_add(1) as u32;
            let now = now_ms();
            let task = data.tasks.get_mut(task_id).unwrap();
            let previous_spec = std::mem::replace(&mut task.spec, spec);
            task.status = TaskStatus::Ready; task.result = None; task.updated_at = now;
            task.reopens.push(TaskReopen { by_chat_key: actor.to_owned(), at: now, attempt, previous_spec, spec: task.spec.clone(), notice_delivered: false });
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
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let (run, task) = self.owned_task(actor, task_id)?;
        let ws = task
            .workspace
            .as_ref()
            .ok_or("This task has no workspace.")?;
        if ws.state == WorkspaceState::Cleaned {
            return Ok(task);
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
        self.mutate(|data| {
            if data
                .attempts
                .values()
                .any(|a| a.task_id == task_id && attempt_is_unsettled(data, a))
            {
                return Err("Stop or settle every worker before cleanup.".into());
            }
            if data
                .gates
                .values()
                .any(|g| g.task_id.as_deref() == Some(task_id) && g.status == GateStatus::Open)
            {
                return Err("Resolve the open decision before cleanup.".into());
            }
            for other in data.attempts.values().filter(|a| a.task_id != task_id && attempt_is_unsettled(data, a) && !a.cwd.is_empty()) {
                if workflow::leases_clash(&workflow::held_checkout(&other.cwd), attempt_in_managed_worktree(data, other), &ws.plan.checkout_root, true) {
                    return Err("Another task is still using this checkout.".into());
                }
            }
            if abandon && data.tasks.values().any(|t| t.depends_on.iter().any(|id| id == task_id) && t.active_attempt_id.is_some()) {
                return Err("A dependent task already started. Preserve this workspace until that work is resolved.".into());
            }
            if data.tasks.values().filter(|t| t.id != task_id).any(|t| t.workspace.as_ref().is_some_and(|other| other.state != WorkspaceState::Cleaned && workflow::leases_clash(&other.plan.checkout_root, other.plan.is_managed_worktree(), &ws.plan.checkout_root, true))) {
                return Err("Another task retains this checkout. Preserve it until all workspace owners are resolved.".into());
            }
            if !abandon && task.status != TaskStatus::Completed {
                return Err("Complete the task or explicitly abandon it before cleanup.".into());
            }
            if !ws.validation_paths.is_empty() {
                return Err("Remove the task's validation worktrees before cleanup.".into());
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
        let cleaned = (|| {
            let snapshot = self.snapshot(Some(&run.id))?;
            for attempt in snapshot.attempts.iter().filter(|a| a.task_id == task_id) {
                crate::agent_chat::chat_stop_impl(chats, attempt.worker_chat_key.clone())?;
            }
            // Its services are built from this folder: stop them (volumes
            // kept) before the folder goes, through their frozen
            // configuration. The person's hold is theirs to release.
            if task.environment == super::TaskEnvironment::Sandbox {
                let sandboxes = crate::sandbox::Store::profile();
                // What leads to a stop goes by what this server knows.
                let envs = sandboxes.known()?;
                let live = sandboxes.live_keys();
                for attempt in snapshot.attempts.iter().filter(|a| a.task_id == task_id) {
                    let key = &attempt.worker_chat_key;
                    if !live.contains(key) {
                        continue;
                    }
                    if envs
                        .environments
                        .get(key)
                        .is_some_and(|e| e.lease.is_some())
                    {
                        return Err("This task's test environment is held open from its Sandbox panel. Stop it there before cleaning up the workspace.".into());
                    }
                    if !sandboxes
                        .host_stop(key, "Its workspace was cleaned up. Volumes are kept.")?
                    {
                        return Err("This task's test environment is busy. Try the cleanup again when it settles.".into());
                    }
                }
            }
            chats.require_checkout_idle(&ws.plan.checkout_root, true)?;
            let evidence = workflow::inspect(&ws.plan, true)?;
            if expected_head.is_empty() || evidence.head_sha != expected_head {
                return Err(
                    "HEAD changed since the cleanup preview. Refresh delivery status first.".into(),
                );
            }
            if evidence.dirty {
                return Err(
                    "Workspace has uncommitted or untracked files. Preserve them before cleanup."
                        .into(),
                );
            }
            if !abandon && !evidence.merged {
                return Err(
                    "Merge could not be verified for this exact commit and base branch.".into(),
                );
            }
            if abandon && !evidence.pushed && evidence.has_commits {
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
            workflow::cleanup(&ws.plan, &evidence.head_sha)?;
            Ok(evidence)
        })();
        let result = self.mutate(|data| {
            let task = data.tasks.get_mut(task_id).ok_or("Task disappeared.")?;
            let ws = task.workspace.as_mut().unwrap();
            ws.cleanup_intent = None;
            match &cleaned {
                Ok(evidence) => {
                    ws.state = WorkspaceState::Cleaned;
                    ws.lease_attempt_id = None;
                    ws.delivery = Some(evidence.clone());
                    ws.abandoned = abandon;
                    if abandon {
                        task.status = TaskStatus::Cancelled;
                    }
                }
                Err(_) => ws.state = WorkspaceState::Retained,
            }
            task.updated_at = now_ms();
            let result = task.clone();
            if cleaned.is_ok() && abandon {
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
            Ok(result)
        })?;
        announce(&run.id, "workspace_cleanup");
        cleaned.map(|_| result)
    }
}

pub(super) fn recover_workspaces(data: &mut Stored) -> bool {
    let mut changed = false;
    for task in data.tasks.values_mut() {
        if let Some(ws) = task.workspace.as_mut() {
            changed |= ws.lease_attempt_id.take().is_some();
            if ws.state == WorkspaceState::Cleaning {
                let removed = !Path::new(&ws.plan.checkout_root).exists();
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

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::git_ops::workflow::tests::Repo;
    fn setup(repo: &Repo, mode: WorkspaceMode) -> (OrchestrationStore, Run, Task) {
        // The coordinator is a chat the person can open: a reopen is told
        // there, and refused without it.
        crate::chat_index::upsert(
            serde_json::from_value(json!({
                "id": "master", "projectId": "project", "title": "Lead chat", "updatedAt": 100,
            }))
            .unwrap(),
        )
        .unwrap();
        let store = OrchestrationStore::default();
        let run = store
            .create_run_with_mode(
                "chat:master".into(),
                "Build feature".into(),
                "project".into(),
                repo.root.clone(),
                Some(4),
                mode,
            )
            .unwrap();
        let task = super::super::tests::task(&store, &run, vec![]);
        (store, run, task)
    }
    /// Feedback b17ade5a: an Auto run over a folder with no Git history plans
    /// the folder itself, rather than a worktree that fails after approval.
    #[test]
    fn auto_over_a_folder_without_git_plans_the_folder() {
        let dir = crate::test_dir::TestDir::new("auto-plain").canonicalized();
        let root = dir.to_string_lossy().into_owned();
        let store = OrchestrationStore::default();
        let run = store
            .create_run_with_mode(
                "chat:master".into(),
                "Review".into(),
                "project".into(),
                root.clone(),
                Some(2),
                WorkspaceMode::Auto,
            )
            .unwrap();
        let proposal = propose(&run, "task_review", None, None);
        assert!(proposal.error.is_none(), "{:?}", proposal.error);
        let plan = proposal.plan.unwrap();
        assert_eq!(plan.mode, WorkspaceMode::Direct);
        assert_eq!(plan.cwd, root);
        // Where there is Git, Auto still isolates a writer.
        let repo = Repo::new();
        assert_eq!(
            auto_mode_for(WorkspaceMode::Worktree, WorkspaceMode::Auto, &repo.root),
            WorkspaceMode::Worktree
        );
        assert_eq!(
            auto_mode_for(WorkspaceMode::Worktree, WorkspaceMode::Worktree, &root),
            WorkspaceMode::Worktree
        );
    }
    fn prepare(store: &OrchestrationStore, task: &Task, access: Access) -> Result<Attempt, String> {
        let launch = WorkerLaunch {
            task_id: task.id.clone(),
            agent: ChatAgent::Codex,
            access,
            model: None,
            effort: None,
            new_worktree: None,
            base_branch: String::new(),
        };
        let (run, task, reserved, previous) = store.reserve_attempt("chat:master", &launch)?;
        let workspace = store.prepare_task_workspace(
            &ChatManager::default(),
            &run,
            &task,
            &reserved,
            previous.as_ref(),
            &launch,
        )?;
        store.activate_attempt(
            &reserved.id,
            workspace.cwd,
            workspace.branch,
            workspace.is_worktree,
        )
    }
    fn prepare_from(
        store: &OrchestrationStore,
        task: &Task,
        access: Access,
        base_branch: &str,
    ) -> Result<Attempt, String> {
        let launch = WorkerLaunch {
            task_id: task.id.clone(),
            agent: ChatAgent::Codex,
            access,
            model: None,
            effort: None,
            new_worktree: None,
            base_branch: base_branch.into(),
        };
        let (run, task, reserved, previous) = store.reserve_attempt("chat:master", &launch)?;
        // Settled the way start_worker settles it, so the task can launch again.
        let workspace = store
            .prepare_task_workspace(
                &ChatManager::default(),
                &run,
                &task,
                &reserved,
                previous.as_ref(),
                &launch,
            )
            .inspect_err(|error| {
                store
                    .fail_preparation(
                        &reserved.id,
                        error.clone(),
                        String::new(),
                        String::new(),
                        false,
                    )
                    .unwrap()
            })?;
        store.activate_attempt(
            &reserved.id,
            workspace.cwd,
            workspace.branch,
            workspace.is_worktree,
        )
    }
    fn stored(store: &OrchestrationStore, task: &Task) -> Task {
        store.owned_task("chat:master", &task.id).unwrap().1
    }
    fn proposed(store: &OrchestrationStore, task: &Task) -> WorkspacePlan {
        stored(store, task)
            .workspace_proposal
            .and_then(|p| p.plan)
            .expect("a planned workspace")
    }
    /// Every path under `dir` with its size and modification time, `.git`
    /// included, so a read that refreshed the index shows up too.
    fn fingerprint(dir: &Path) -> Vec<(String, u64, std::time::SystemTime)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(path) = stack.pop() {
            let meta = fs::symlink_metadata(&path).unwrap();
            out.push((
                path.to_string_lossy().into_owned(),
                meta.len(),
                meta.modified().unwrap(),
            ));
            if meta.is_dir() {
                for entry in fs::read_dir(&path).unwrap() {
                    stack.push(entry.unwrap().path());
                }
            }
        }
        out.sort();
        out
    }

    #[test]
    fn a_plan_names_the_new_branch_and_path_without_touching_git_or_disk() {
        let repo = Repo::new();
        // Something to refresh: an untracked file and a stale index stat.
        fs::write(Path::new(&repo.root).join("untracked.txt"), "x").unwrap();
        let before = fingerprint(&repo.dir);
        let (store, _, task) = setup(&repo, WorkspaceMode::Auto);
        assert_eq!(fingerprint(&repo.dir), before, "planning changed the disk");
        let saved = stored(&store, &task);
        assert!(saved.workspace.is_none(), "a plan is not a workspace");
        let proposal = saved.workspace_proposal.unwrap();
        let planned_at = proposal.proposed_at;
        let plan = proposal.plan.unwrap();
        let id = task.id.strip_prefix("task_").unwrap();
        assert_eq!(plan.branch, format!("feature/octiq-{id}"));
        assert_eq!(plan.base_branch, "main");
        assert_eq!(plan.mode, WorkspaceMode::Worktree);
        assert!(proposal.new_branch);
        assert!(proposal.conflict.is_none());
        assert_eq!(
            Path::new(&plan.checkout_root),
            repo.dir.join(".worktrees/repo").join(&plan.branch)
        );
        assert!(!Path::new(&plan.checkout_root).exists());
        assert_eq!(repo.git(&["branch", "--list", &plan.branch]), "");
        // The scheduler's backfill leaves a planned task alone.
        store.propose_missing_workspaces().unwrap();
        assert_eq!(fingerprint(&repo.dir), before);
        let after = stored(&store, &task).workspace_proposal.unwrap();
        assert_eq!(after.proposed_at, planned_at);
    }

    #[test]
    fn the_plan_is_saved_with_the_task_and_survives_a_restart() {
        let repo = Repo::new();
        let path = repo.dir.join("orchestrations.json");
        let store = OrchestrationStore::load(path.clone());
        let run = store
            .create_run_with_mode(
                "chat:master".into(),
                "Plan".into(),
                "project".into(),
                repo.root.clone(),
                None,
                WorkspaceMode::Worktree,
            )
            .unwrap();
        let task = super::super::tests::task(&store, &run, vec![]);
        let plan = proposed(&store, &task);
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let written = &saved["tasks"][&task.id]["workspaceProposal"];
        assert_eq!(written["plan"]["branch"], plan.branch);
        assert_eq!(written["plan"]["cwd"], plan.cwd);
        assert_eq!(written["newBranch"], true);
        let reloaded = OrchestrationStore::load(path);
        let again = proposed(&reloaded, &task);
        assert_eq!((again.branch, again.cwd), (plan.branch, plan.cwd));
    }

    #[test]
    fn launch_creates_exactly_the_approved_branch_from_the_approved_base() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Auto);
        let plan = proposed(&store, &task);
        // The person's checkout moves on after approval; the task does not.
        repo.git(&["switch", "-c", "elsewhere"]);
        let attempt = prepare(&store, &task, Access::Auto).unwrap();
        assert_eq!(attempt.branch, plan.branch);
        assert_eq!(attempt.cwd, plan.cwd);
        let workspace = stored(&store, &task).workspace.unwrap();
        assert_eq!(workspace.plan.branch, plan.branch);
        assert_eq!(workspace.plan.base_branch, "main");
        assert_eq!(
            repo.git(&["rev-parse", &plan.branch]),
            repo.git(&["rev-parse", "main"])
        );
    }

    #[test]
    fn a_launch_that_would_leave_the_approved_plan_is_refused_before_anything_is_made() {
        let repo = Repo::new();
        let (store, run, _) = setup(&repo, WorkspaceMode::Auto);
        // A task whose worker was chosen as a writer: its plan is binding.
        let task = store
            .create_task(
                "chat:master",
                run.id.clone(),
                "Write".into(),
                "Change it".into(),
                vec![],
                None,
                Some(automation::WorkerSettings {
                    agent: ChatAgent::Codex,
                    access: Access::Auto,
                    model: None,
                    effort: None,
                    recovery: None,
                }),
            )
            .unwrap();
        let plan = proposed(&store, &task);
        assert!(
            !stored(&store, &task)
                .workspace_proposal
                .unwrap()
                .provisional
        );
        repo.git(&["branch", "other"]);
        let err = prepare_from(&store, &task, Access::Auto, "other").unwrap_err();
        assert!(err.contains("starts from main, not other"), "{err}");
        let err = prepare_from(&store, &task, Access::Read, "").unwrap_err();
        assert!(err.contains("uses a new worktree"), "{err}");
        assert!(!Path::new(&plan.checkout_root).exists());
        assert_eq!(repo.git(&["branch", "--list", &plan.branch]), "");
        assert!(stored(&store, &task).workspace.is_none());
    }

    #[test]
    fn a_plan_made_before_any_worker_was_chosen_still_lets_a_reader_use_the_checkout() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Auto);
        let proposal = stored(&store, &task).workspace_proposal.unwrap();
        assert!(proposal.provisional);
        let reader = prepare(&store, &task, Access::Read).unwrap();
        assert_eq!(reader.cwd, repo.root);
        assert!(!reader.is_worktree);
        let plan = proposal.plan.unwrap();
        assert!(!Path::new(&plan.checkout_root).exists());
        assert_eq!(repo.git(&["branch", "--list", &plan.branch]), "");
    }

    #[test]
    fn a_collision_shows_in_the_plan_and_is_refused_at_launch_rather_than_reused() {
        let repo = Repo::new();
        let (store, run, task) = setup(&repo, WorkspaceMode::Auto);
        let plan = proposed(&store, &task);
        // Someone else's branch appears under the planned name after approval.
        repo.git(&["branch", &plan.branch]);
        let err = prepare(&store, &task, Access::Auto).unwrap_err();
        assert!(
            err.contains(&format!("Branch {} already exists", plan.branch)),
            "{err}"
        );
        assert!(!Path::new(&plan.checkout_root).exists());
        // A plan made while the branch is there says so and does not say new.
        let again = propose(&run, &task.id, None, None);
        assert!(!again.new_branch);
        assert!(again.conflict.unwrap().contains("already exists"));
    }

    #[test]
    fn current_checkout_plans_its_own_branch_and_refuses_one_switched_since() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Direct);
        let proposal = stored(&store, &task).workspace_proposal.unwrap();
        let plan = proposal.plan.unwrap();
        assert_eq!(
            (plan.branch.as_str(), plan.cwd.as_str()),
            ("main", repo.root.as_str())
        );
        assert!(!plan.managed);
        assert!(!proposal.new_branch, "an existing branch is never new");
        repo.git(&["switch", "-c", "moved"]);
        let err = prepare_from(&store, &task, Access::Auto, "").unwrap_err();
        assert!(
            err.contains("works on main in the current checkout, which is now on moved"),
            "{err}"
        );
        repo.git(&["switch", "main"]);
        let attempt = prepare(&store, &task, Access::Auto).unwrap();
        assert_eq!(
            (attempt.branch.as_str(), attempt.cwd.as_str()),
            ("main", repo.root.as_str())
        );
    }

    #[test]
    fn a_retry_reuses_its_workspace_instead_of_replanning_it() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Worktree);
        let plan = proposed(&store, &task);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        report(&store, &first, WorkerOutcome::Failed);
        // The branch and path now exist — they are this task's own, so the
        // retry is not a collision.
        let retry = prepare(&store, &task, Access::Auto).unwrap();
        assert_eq!(
            (retry.branch.as_str(), retry.cwd.as_str()),
            (plan.branch.as_str(), plan.cwd.as_str())
        );
        assert_ne!(retry.id, first.id);
    }

    #[test]
    fn tasks_from_before_plans_get_one_and_started_tasks_do_not() {
        let repo = Repo::new();
        let (store, run, legacy) = setup(&repo, WorkspaceMode::Auto);
        let started = super::super::tests::task(&store, &run, vec![]);
        prepare(&store, &started, Access::Auto).unwrap();
        store
            .mutate(|data| {
                for task in data.tasks.values_mut() {
                    task.workspace_proposal = None;
                }
                Ok(())
            })
            .unwrap();
        store.propose_missing_workspaces().unwrap();
        let id = legacy.id.strip_prefix("task_").unwrap();
        assert_eq!(
            proposed(&store, &legacy).branch,
            format!("feature/octiq-{id}")
        );
        assert!(stored(&store, &started).workspace_proposal.is_none());
    }

    fn report(store: &OrchestrationStore, attempt: &Attempt, outcome: WorkerOutcome) {
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id.clone(),
                    outcome,
                    summary: "Verified result".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
    }
    #[test]
    fn a_destination_removed_after_approval_fails_the_attempt_instead_of_redirecting() {
        let (coordinator, api) = (Repo::new(), Repo::new());
        let (store, run, _) = setup(&coordinator, WorkspaceMode::Auto);
        let task = store
            .create_task_for(
                "chat:master",
                run.id.clone(),
                "API".into(),
                "Change the API".into(),
                vec![],
                None,
                None,
                None,
                Some(TaskDestination {
                    project_id: "shop".into(),
                    project_name: "Shop".into(),
                    repository: api.root.clone(),
                }),
            )
            .unwrap();
        // The run's own project is still registered; the destination is not.
        let projects: Vec<crate::workspaces::Workspace> = serde_json::from_value(json!([
            { "id": "project", "name": "Coordinator", "primary_path": coordinator.root },
        ]))
        .unwrap();
        let err = store
            .start_worker(
                Arc::new(ChatManager::default()),
                &crate::workspaces::WorkspaceState::with_projects(projects),
                "chat:master",
                WorkerLaunch {
                    task_id: task.id.clone(),
                    agent: ChatAgent::Codex,
                    access: Access::Auto,
                    model: None,
                    effort: None,
                    new_worktree: None,
                    base_branch: String::new(),
                },
            )
            .unwrap_err();
        assert!(err.contains("Shop is no longer registered"), "{err}");
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let attempt = snapshot
            .attempts
            .iter()
            .find(|a| a.task_id == task.id)
            .unwrap();
        assert_eq!(attempt.status, AttemptStatus::Failed);
        // Nothing was prepared anywhere, least of all in the coordinator's repo.
        assert!(attempt.cwd.is_empty());
        let task = snapshot.tasks.iter().find(|t| t.id == task.id).unwrap();
        assert!(task.workspace.is_none());
    }
    #[test]
    fn capacity_recovery_reuses_the_lease_branch_and_uncommitted_work() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Auto);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        fs::write(
            Path::new(&first.cwd).join("completed.txt"),
            "completed work",
        )
        .unwrap();
        store
            .observe_worker_event(
                &first.worker_chat_key,
                &json!({"type":"turn.failed", "error":{"message":"Selected model is at capacity"}}),
            )
            .unwrap();
        store
            .mutate(|data| {
                data.attempts
                    .get_mut(&first.id)
                    .unwrap()
                    .execution
                    .next_retry_at = Some(now_ms() - 1);
                Ok(())
            })
            .unwrap();
        let launch = WorkerLaunch {
            task_id: task.id,
            agent: first.agent,
            access: first.access,
            model: first.model.clone(),
            effort: first.effort.clone(),
            new_worktree: Some(false),
            base_branch: String::new(),
        };
        let (run, task, reserved, previous) = store
            .reserve_attempt_for("chat:master", &launch, StartedBy::Recovery(&first.id))
            .unwrap();
        let workspace = store
            .prepare_task_workspace(
                &ChatManager::default(),
                &run,
                &task,
                &reserved,
                previous.as_ref(),
                &launch,
            )
            .unwrap();
        assert_ne!(reserved.id, first.id);
        assert_eq!(reserved.execution.retry_count, 1);
        assert_eq!(workspace.cwd, first.cwd);
        assert_eq!(workspace.branch, first.branch);
        assert_eq!(
            fs::read_to_string(Path::new(&workspace.cwd).join("completed.txt")).unwrap(),
            "completed work"
        );
        let task = store.snapshot(Some(&run.id)).unwrap().tasks.remove(0);
        assert_eq!(
            task.workspace.unwrap().lease_attempt_id.as_deref(),
            Some(reserved.id.as_str())
        );
    }

    #[test]
    fn a_routed_task_works_in_its_destination_repository_and_retries_there() {
        let (coordinator, api) = (Repo::new(), Repo::new());
        let (store, run, _) = setup(&coordinator, WorkspaceMode::Auto);
        let task = store
            .create_task_for(
                "chat:master",
                run.id.clone(),
                "API".into(),
                "Change the API".into(),
                vec![],
                None,
                None,
                None,
                Some(TaskDestination {
                    project_id: "shop".into(),
                    project_name: "Shop".into(),
                    repository: api.root.clone(),
                }),
            )
            .unwrap();
        let first = prepare(&store, &task, Access::Auto).unwrap();
        assert!(first.is_worktree);
        let plan = store
            .snapshot(Some(&run.id))
            .unwrap()
            .tasks
            .into_iter()
            .find(|t| t.id == task.id)
            .and_then(|t| t.workspace)
            .unwrap()
            .plan;
        assert_eq!(plan.repository_root, api.root);
        assert_ne!(plan.repository_root, coordinator.root);
        assert!(api
            .git(&["branch", "--list", &first.branch])
            .contains(&first.branch));
        assert!(!coordinator
            .git(&["branch", "--list", &first.branch])
            .contains(&first.branch));
        std::fs::write(Path::new(&first.cwd).join("pending.txt"), "kept").unwrap();
        report(&store, &first, WorkerOutcome::Failed);
        let retry = prepare(&store, &task, Access::Auto).unwrap();
        assert_ne!(retry.id, first.id);
        assert_eq!(
            (retry.cwd.as_str(), retry.branch.as_str()),
            (first.cwd.as_str(), first.branch.as_str())
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&retry.cwd).join("pending.txt")).unwrap(),
            "kept"
        );
        let task = store
            .snapshot(Some(&run.id))
            .unwrap()
            .tasks
            .into_iter()
            .find(|t| t.id == task.id)
            .unwrap();
        assert_eq!(task.destination.unwrap().repository, api.root);
    }

    #[test]
    fn retry_and_review_reuse_workspace_and_preserve_uncommitted_changes() {
        let repo = Repo::new();
        let (store, run, task) = setup(&repo, WorkspaceMode::Auto);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        assert!(first.is_worktree);
        std::fs::write(Path::new(&first.cwd).join("pending.txt"), "preserved").unwrap();
        report(&store, &first, WorkerOutcome::Blocked);
        let retry = prepare(&store, &task, Access::Auto).unwrap();
        assert_ne!(retry.id, first.id);
        assert_eq!(retry.cwd, first.cwd);
        assert_eq!(retry.branch, first.branch);
        assert_eq!(
            std::fs::read_to_string(Path::new(&retry.cwd).join("pending.txt")).unwrap(),
            "preserved"
        );
        report(&store, &retry, WorkerOutcome::Completed);
        assert_eq!(
            store.snapshot(Some(&run.id)).unwrap().runs[0].status,
            RunStatus::Completed
        );
        store
            .reopen_task("chat:master", &task.id, "Address review".into())
            .unwrap();
        let next = prepare(&store, &task, Access::Auto).unwrap();
        assert_eq!(next.cwd, first.cwd);
        assert_ne!(next.id, retry.id);
        assert!(store
            .report_worker(
                &retry.worker_chat_key,
                WorkerReport {
                    attempt_id: retry.id,
                    outcome: WorkerOutcome::Completed,
                    summary: "late".into(),
                    files_modified: vec![],
                    verdict: None,
                }
            )
            .unwrap_err()
            .contains("stale"));
    }
    #[test]
    fn a_reopened_task_needs_accepting_again_and_never_pays_twice() {
        use super::super::levels::AcceptActor;
        let repo = Repo::new();
        let (store, _run, task) = setup(&repo, WorkspaceMode::Auto);
        store
            .mutate(|data| {
                data.tasks.get_mut(&task.id).unwrap().assignee = Some(TaskAssignee {
                    id: "agent_ada".into(),
                    name: "Ada".into(),
                });
                Ok(())
            })
            .unwrap();
        let first = prepare(&store, &task, Access::Auto).unwrap();
        report(&store, &first, WorkerOutcome::Completed);
        let paid = store
            .accept_task(AcceptActor::Person, &task.id, &first.id)
            .unwrap();
        assert!(paid.awarded);

        let reopened = store
            .reopen_task("chat:master", &task.id, "Address review".into())
            .unwrap();
        // The record of the earlier acceptance stays; it names the old result.
        assert_eq!(reopened.acceptance.unwrap().attempt_id, first.id);
        let fix = prepare(&store, &task, Access::Auto).unwrap();
        report(&store, &fix, WorkerOutcome::Completed);
        let profile = store.level_profile("agent_ada", 0).unwrap();
        assert_eq!(profile.awaiting.len(), 1);
        assert!(profile.awaiting[0].unscored, "it was paid already");
        let again = store
            .accept_task(AcceptActor::Person, &task.id, &fix.id)
            .unwrap();
        assert!(!again.awarded);
        assert_eq!(again.task.acceptance.unwrap().attempt_id, fix.id);
        let profile = store.level_profile("agent_ada", 0).unwrap();
        assert_eq!((profile.progress.xp, profile.accepted_tasks), (75, 1));
        assert!(profile.awaiting.is_empty());
    }

    /// A finished peer request in the state `reopen_task` takes: completed
    /// by its attempt, in a retained worktree. Coordinated by `chat:master`.
    pub(crate) fn finished_peer_request(repo: &Repo) -> (OrchestrationStore, Run, Task, Attempt) {
        let (store, run, task) = setup(repo, WorkspaceMode::Auto);
        let attempt = prepare(&store, &task, Access::Auto).unwrap();
        report(&store, &attempt, WorkerOutcome::Completed);
        let task = store
            .mutate(|data| {
                let task = data.tasks.get_mut(&task.id).unwrap();
                task.peer_request = Some(super::super::peer_request::PeerRequest {
                    requested_by: TaskAssignee {
                        id: "ada".into(),
                        name: "ADA".into(),
                    },
                    requester_chat_key: "chat:master".into(),
                    requester_attempt_id: None,
                    output: "One line per volume.".into(),
                    max_minutes: 30,
                    requested_at: task.created_at,
                });
                Ok(task.clone())
            })
            .unwrap();
        (store, run, task, attempt)
    }

    /// The approval a peer request rests on is for its own words. Its
    /// coordinator, which for a lead chat's request is the requester, cannot
    /// reopen the finished task with new ones: nothing changes and no attempt
    /// starts. The same task without the request reopens as before.
    #[test]
    fn a_finished_peer_request_is_not_reopened_with_new_instructions() {
        let repo = Repo::new();
        let (store, run, task, attempt) = finished_peer_request(&repo);
        assert_eq!(task.status, TaskStatus::Completed);
        let before = store.snapshot(Some(&run.id)).unwrap();

        let refused = store
            .reopen_task("chat:master", &task.id, "Now delete the volume".into())
            .unwrap_err();
        assert_eq!(refused, super::super::peer_request::NOT_REOPENED);
        assert!(refused.contains("a new request, which the person approves"));

        let after = store.snapshot(Some(&run.id)).unwrap();
        let kept = after.tasks.iter().find(|t| t.id == task.id).unwrap();
        assert_eq!(kept.spec, task.spec);
        assert_eq!(kept.status, TaskStatus::Completed);
        assert_eq!(kept.result, task.result);
        assert!(kept.result.is_some());
        assert_eq!(kept.updated_at, task.updated_at);
        assert_eq!(kept.active_attempt_id, task.active_attempt_id);
        // Nothing was made ready, so nothing is there to dispatch.
        assert_eq!(after.runs[0].status, RunStatus::Completed);
        assert_eq!(after.attempts.len(), before.attempts.len());
        assert_eq!(after.attempts[0].id, attempt.id);
        assert!(after
            .tasks
            .iter()
            .all(|t| !matches!(t.status, TaskStatus::Ready | TaskStatus::Running)));
        // Someone who is not the coordinator learns nothing about the task.
        let stranger = store
            .reopen_task("chat:other", &task.id, "Now delete the volume".into())
            .unwrap_err();
        assert_eq!(stranger, "Only this run's coordinator may do that.");

        // What refused it is the request alone: an ordinary task in the very
        // same state is reopened with its follow-up.
        store
            .mutate(|data| {
                data.tasks.get_mut(&task.id).unwrap().peer_request = None;
                Ok(())
            })
            .unwrap();
        let reopened = store
            .reopen_task("chat:master", &task.id, "Address review".into())
            .unwrap();
        assert_eq!(reopened.spec, "Address review");
        assert_eq!(reopened.status, TaskStatus::Ready);
        assert!(reopened.result.is_none());
        let next = prepare(&store, &task, Access::Auto).unwrap();
        assert_ne!(next.id, attempt.id);
    }

    /// Review R2: a stale page must not have a worktree rebuilt, or its chat
    /// moved, under a task that holds the checkout.
    #[test]
    fn a_removed_folder_a_task_holds_is_not_put_back_for_a_chat() {
        let repo = Repo::new();
        let (store, _run, task) = setup(&repo, WorkspaceMode::Worktree);
        let attempt = prepare(&store, &task, Access::Auto).unwrap();
        let held = attempt.cwd.clone();
        // A worktree of the person's own beside it, for the control below.
        let own = repo.dir.join("own").to_string_lossy().into_owned();
        repo.git(&["worktree", "add", "-b", "person/own", &own]);
        std::fs::remove_dir_all(&held).unwrap();
        std::fs::remove_dir_all(&own).unwrap();
        let listed = repo.git(&["worktree", "list", "--porcelain"]);

        // The check itself: the leased checkout and anything inside it.
        let inside = Path::new(&held).join("packages").join("app");
        for path in [held.clone(), inside.to_string_lossy().into_owned()] {
            let refused = store
                .require_no_owner_of_removed("chat:stale", &path)
                .unwrap_err();
            assert!(refused.contains("holds that checkout"), "{refused}");
            assert!(refused.contains(&task.title), "{refused}");
        }
        assert!(store
            .require_no_owner_of_removed("chat:stale", &own)
            .is_ok());
        // A worker's chat is never recovered this way, wherever it points.
        let refused = store
            .require_no_owner_of_removed(&attempt.worker_chat_key, &own)
            .unwrap_err();
        assert!(refused.contains("belongs to a task"), "{refused}");

        // The whole recovery, as `chat_start` asks for it.
        let store = Arc::new(store);
        let mut chats = ChatManager::default();
        chats.orchestrations = store.clone();
        let known = || crate::chat_recover::Remembered {
            project_paths: vec![repo.root.clone()],
            ..Default::default()
        };
        let refused = crate::chat_recover::recover_from(&chats, "chat:stale", &held, known)
            .err()
            .expect("refused");
        assert!(refused.contains("holds that checkout"), "{refused}");
        assert!(!Path::new(&held).exists(), "nothing was rebuilt");
        assert_eq!(
            repo.git(&["worktree", "list", "--porcelain"]),
            listed,
            "git was not touched"
        );
        assert!(!chats.has_process("chat:stale"));
        // The lifecycle lock and the claim were let go with the refusal, and
        // the person's own removed worktree is still put back.
        let recovered = crate::chat_recover::recover_from(&chats, "chat:stale", &own, known)
            .expect("recovered")
            .expect("its folder was gone");
        assert_eq!(recovered.recovery.cwd, own);
        assert!(Path::new(&own).join("source.txt").is_file());
        // While that recovery is held, no worker is handed a checkout.
        assert!(store.workspace_ops.try_lock().is_err());
        drop(recovered);
        assert!(store.workspace_ops.try_lock().is_ok());

        // A workspace being cleaned up is refused as well.
        store
            .mutate(|data| {
                let ws = data
                    .tasks
                    .get_mut(&task.id)
                    .and_then(|t| t.workspace.as_mut())
                    .unwrap();
                ws.lease_attempt_id = None;
                ws.state = WorkspaceState::Cleaning;
                Ok(())
            })
            .unwrap();
        let refused = store
            .require_no_owner_of_removed("chat:stale", &held)
            .unwrap_err();
        assert!(refused.contains("being cleaned up"), "{refused}");
        // Once it is cleaned, the folder is nobody's.
        store
            .mutate(|data| {
                data.tasks
                    .get_mut(&task.id)
                    .and_then(|t| t.workspace.as_mut())
                    .unwrap()
                    .state = WorkspaceState::Cleaned;
                Ok(())
            })
            .unwrap();
        assert!(store
            .require_no_owner_of_removed("chat:stale", &held)
            .is_ok());
    }

    #[test]
    fn direct_limits_concurrency_and_cross_run_lease_blocks_a_second_writer() {
        let repo = Repo::new();
        let (store, run, task) = setup(&repo, WorkspaceMode::Direct);
        assert_eq!(run.max_concurrent, 1);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        assert_eq!(first.cwd, repo.root);
        assert_eq!(first.branch, "main");
        let second_run = store
            .create_run_with_mode(
                "chat:master".into(),
                "Another run".into(),
                "project".into(),
                repo.root.clone(),
                Some(4),
                WorkspaceMode::Direct,
            )
            .unwrap();
        let second_task = super::super::tests::task(&store, &second_run, vec![]);
        assert!(prepare(&store, &second_task, Access::Auto)
            .unwrap_err()
            .contains("leased"));
        assert!(store
            .require_workspace_access("chat:other", &repo.root, true)
            .unwrap_err()
            .contains("active writer"));
        assert!(store
            .require_workspace_access("chat:other", &repo.root, false)
            .is_ok());
        // A chat the person drives is let through and told who writes there.
        let beside = store
            .chat_workspace_access("chat:other", &repo.root, true)
            .unwrap();
        assert_eq!(beside.len(), 1);
        assert_eq!(beside[0].task_id, task.id);
        assert!(beside[0].notice().contains(&task.title));
        assert!(store
            .chat_workspace_access("chat:other", &repo.root, false)
            .unwrap()
            .is_empty());
        // Another worker's chat is not: one writer at a time.
        let worker = store
            .inner
            .lock()
            .unwrap()
            .data
            .attempts
            .values()
            .next()
            .unwrap()
            .worker_chat_key
            .clone();
        let other_worker = format!("{worker}-other");
        store
            .mutate(|data| {
                let mut copy = data.attempts.values().next().unwrap().clone();
                copy.id = "attempt_other".into();
                copy.worker_chat_key = other_worker.clone();
                data.attempts.insert(copy.id.clone(), copy);
                Ok(())
            })
            .unwrap();
        assert!(store
            .chat_workspace_access(&other_worker, &repo.root, true)
            .unwrap_err()
            .contains("active writer"));
        assert!(store.guard_git_operation(&repo.root).is_err());
        assert!(store
            .cleanup_workspace(
                &ChatManager::default(),
                "chat:master",
                &task.id,
                true,
                "head"
            )
            .unwrap_err()
            .contains("Current checkout"));
    }
    /// A project registered as a plain folder that holds a repository and
    /// its `.worktrees` (the Starfall layout): a running writer in one of
    /// those worktrees was given a folder nobody else was, so a chat in the
    /// folder above it may write — the rule dispatch already keeps
    /// (`shares_checkout`). Only a chat working inside the worktree is
    /// refused, and a read-only chat there still is not.
    #[test]
    fn a_folder_holding_a_writers_worktree_admits_writers_above_it() {
        let repo = Repo::new();
        let (store, _run, task) = setup(&repo, WorkspaceMode::Worktree);
        let writer = prepare(&store, &task, Access::Auto).unwrap();
        let folder = repo.dir.to_string_lossy().into_owned();
        assert!(
            Path::new(&writer.cwd).starts_with(&folder),
            "{} is not inside {folder}",
            writer.cwd
        );
        assert!(store
            .require_workspace_access("chat:talk", &folder, true)
            .is_ok());
        assert!(store
            .require_workspace_access("chat:talk", &folder, false)
            .is_ok());
        let inside = format!("{}/src", writer.cwd.trim_end_matches('/'));
        std::fs::create_dir_all(&inside).unwrap();
        assert!(store
            .require_workspace_access("chat:talk", &writer.cwd, true)
            .unwrap_err()
            .contains("active writer"));
        assert!(store
            .require_workspace_access("chat:talk", &inside, true)
            .unwrap_err()
            .contains("active writer"));
        assert!(store
            .require_workspace_access("chat:talk", &inside, false)
            .is_ok());
        // The repository beside the worktree is not that writer's checkout.
        assert!(store
            .require_workspace_access("chat:talk", &repo.root, true)
            .is_ok());
    }
    /// Feedback 03a21d80: run A writes directly in the plain folder that holds
    /// a repository, and run B's worktree task in that repository is NOT
    /// leased to A. The worktree is B's own folder. Either order dispatches,
    /// and a second direct writer in A's folder is still refused.
    #[test]
    fn a_direct_lease_on_the_folder_above_does_not_block_a_worktree_task() {
        let repo = Repo::new();
        let folder = repo.dir.to_string_lossy().into_owned();
        let store = OrchestrationStore::default();
        let run_in = |root: &str, mode| {
            store
                .create_run_with_mode(
                    "chat:master".into(),
                    "Work".into(),
                    "project".into(),
                    root.into(),
                    Some(4),
                    mode,
                )
                .unwrap()
        };
        let direct = run_in(&folder, WorkspaceMode::Direct);
        let isolated = run_in(&repo.root, WorkspaceMode::Auto);
        let first = super::super::tests::task(&store, &direct, vec![]);
        let writer = prepare(&store, &first, Access::Auto).unwrap();
        assert_eq!(writer.cwd, folder);
        let worktree = prepare(
            &store,
            &super::super::tests::task(&store, &isolated, vec![]),
            Access::Auto,
        )
        .unwrap();
        assert!(worktree.is_worktree);
        assert!(Path::new(&worktree.cwd).starts_with(&folder));
        // The other order: a worktree writer is running, a direct writer
        // starts in the folder above it.
        let second_isolated = prepare(
            &store,
            &super::super::tests::task(&store, &isolated, vec![]),
            Access::Auto,
        )
        .unwrap();
        assert!(second_isolated.is_worktree);
        let late_direct = run_in(&folder, WorkspaceMode::Direct);
        report(&store, &writer, WorkerOutcome::Completed);
        assert!(prepare(
            &store,
            &super::super::tests::task(&store, &late_direct, vec![]),
            Access::Auto
        )
        .is_ok());
        // Two writers in the same plain folder still clash.
        assert!(prepare(
            &store,
            &super::super::tests::task(&store, &direct, vec![]),
            Access::Auto
        )
        .unwrap_err()
        .contains("already leased"));
    }
    #[test]
    fn independent_worktrees_can_write_in_parallel_and_auto_readers_reuse_root() {
        let repo = Repo::new();
        let (store, run, task) = setup(&repo, WorkspaceMode::Auto);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        let second = prepare(
            &store,
            &super::super::tests::task(&store, &run, vec![]),
            Access::Auto,
        )
        .unwrap();
        let reader = prepare(
            &store,
            &super::super::tests::task(&store, &run, vec![]),
            Access::Read,
        )
        .unwrap();
        assert_ne!(first.cwd, second.cwd);
        assert_eq!(reader.cwd, repo.root);
        assert!(!reader.is_worktree);
    }
    #[test]
    fn cleanup_requires_settlement_preservation_and_authority() {
        let repo = Repo::new();
        let (store, _run, task) = setup(&repo, WorkspaceMode::Worktree);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        let head = repo.git(&["rev-parse", "HEAD"]);
        let manager = ChatManager::default();
        assert!(store
            .cleanup_workspace(&manager, "chat:master", &task.id, true, &head)
            .unwrap_err()
            .contains("settle"));
        report(&store, &first, WorkerOutcome::Completed);
        assert!(store
            .cleanup_workspace(&manager, &first.worker_chat_key, &task.id, true, &head)
            .is_err());
        assert!(store
            .cleanup_workspace(&manager, "chat:master", &task.id, false, &head)
            .unwrap_err()
            .contains("Merge"));
        let unpublished = repo.commit(&first.cwd, "work.txt", "unpublished");
        assert!(store
            .cleanup_workspace(&manager, "chat:master", &task.id, true, &unpublished)
            .unwrap_err()
            .contains("Push unpublished"));
        assert!(Path::new(&first.cwd).is_dir());
    }
    #[test]
    fn explicit_abandon_removes_only_a_clean_managed_tree_and_keeps_branch() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Worktree);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        report(&store, &first, WorkerOutcome::Completed);
        let head = repo.git(&["rev-parse", "HEAD"]);
        let cleaned = store
            .cleanup_workspace(
                &ChatManager::default(),
                "chat:master",
                &task.id,
                true,
                &head,
            )
            .unwrap();
        assert_eq!(cleaned.workspace.unwrap().state, WorkspaceState::Cleaned);
        assert_eq!(cleaned.status, TaskStatus::Cancelled);
        assert!(!Path::new(&first.cwd).exists());
        assert_eq!(repo.git(&["rev-parse", &first.branch]), head);
        assert!(store
            .reopen_task("chat:master", &task.id, "resume".into())
            .is_err());
    }
    #[test]
    fn restart_recovers_lease_but_retains_exact_workspace_and_dirty_files() {
        let repo = Repo::new();
        let store_path = repo.dir.join("orchestrations.json");
        let store = OrchestrationStore::load(store_path.clone());
        let run = store
            .create_run_with_mode(
                "chat:master".into(),
                "Restart".into(),
                "project".into(),
                repo.root.clone(),
                None,
                WorkspaceMode::Auto,
            )
            .unwrap();
        let task = super::super::tests::task(&store, &run, vec![]);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        std::fs::write(Path::new(&first.cwd).join("keep.txt"), "keep").unwrap();
        let recovered = OrchestrationStore::load(store_path);
        let snapshot = recovered.snapshot(Some(&run.id)).unwrap();
        assert_eq!(snapshot.attempts[0].status, AttemptStatus::Failed);
        assert!(snapshot.tasks[0]
            .workspace
            .as_ref()
            .unwrap()
            .lease_attempt_id
            .is_none());
        let retry = prepare(&recovered, &task, Access::Auto).unwrap();
        assert_eq!(retry.cwd, first.cwd);
        assert!(Path::new(&retry.cwd).join("keep.txt").exists());
    }
    #[test]
    fn validation_paths_are_owned_and_block_parent_cleanup() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Worktree);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        let base = repo.git(&["rev-parse", "HEAD"]);
        let path = store
            .create_validation(&first.worker_chat_key, &task.id, &base, vec![])
            .unwrap();
        assert!(store
            .remove_validation("chat:outsider", &task.id, &path)
            .is_err());
        assert!(store
            .remove_validation("chat:master", &task.id, &first.cwd)
            .is_err());
        report(&store, &first, WorkerOutcome::Completed);
        assert!(store
            .cleanup_workspace(
                &ChatManager::default(),
                "chat:master",
                &task.id,
                true,
                &base
            )
            .unwrap_err()
            .contains("validation"));
        store
            .remove_validation("chat:master", &task.id, &path)
            .unwrap();
        assert!(!Path::new(&path).exists());
        assert!(Path::new(&first.cwd).exists());
    }
    #[test]
    fn reopening_a_prerequisite_makes_unstarted_dependants_wait_again() {
        let repo = Repo::new();
        let (store, run, task) = setup(&repo, WorkspaceMode::Auto);
        let dependant = super::super::tests::task(&store, &run, vec![task.id.clone()]);
        let first = prepare(&store, &task, Access::Auto).unwrap();
        report(&store, &first, WorkerOutcome::Completed);
        assert_eq!(
            store
                .owned_task("chat:master", &dependant.id)
                .unwrap()
                .1
                .status,
            TaskStatus::Ready
        );
        store
            .reopen_task("chat:master", &task.id, "Review fix".into())
            .unwrap();
        assert_eq!(
            store
                .owned_task("chat:master", &dependant.id)
                .unwrap()
                .1
                .status,
            TaskStatus::Pending
        );
    }

    /// The person's decision of 2026-10-11: a task they approved keeps
    /// starting while a later revision waits, and reopening it is one of the
    /// ways it comes to run again. The follow-up instructions replace its
    /// spec without going on the plan card, as they did before this rule.
    #[test]
    fn a_reopened_approved_task_starts_while_a_later_revision_waits() {
        let repo = Repo::new();
        let (store, run, task) = setup(&repo, WorkspaceMode::Auto);
        store.require_plan_approval(&run.id).unwrap();
        store
            .approve_plan("chat:master", &run.id, None, None)
            .unwrap();
        let first = prepare(&store, &task, Access::Auto).unwrap();
        report(&store, &first, WorkerOutcome::Completed);
        let added = super::super::tests::task(&store, &run, vec![]);
        let reopened = store
            .reopen_task("chat:master", &task.id, "Address review".into())
            .unwrap();
        assert!(reopened.approved_at.is_some());
        assert_eq!(reopened.spec, "Address review");
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert!(snapshot.runs[0].awaiting_plan_approval());
        let wave: Vec<String> = automation::ready_wave(&snapshot, &snapshot.runs[0])
            .into_iter()
            .map(|task| task.id)
            .collect();
        assert_eq!(wave, [task.id.clone()]);
        let next = prepare(&store, &task, Access::Auto).unwrap();
        assert_eq!(next.cwd, first.cwd);
        assert_eq!(next.number, 2);
        let refused = prepare(&store, &added, Access::Auto).unwrap_err();
        assert!(
            refused.contains("has not approved this task yet"),
            "{refused}"
        );
    }

    /// Review H5, and the person's decision of 2026-10-11: a reopened task
    /// keeps its approval and starts on its new instructions, as the same
    /// worker and nothing else. The task keeps a record of each reopen, and
    /// the coordinator's transcript gets exactly one event for each.
    #[test]
    fn a_reopened_task_keeps_its_approval_and_its_shape_and_says_what_it_was_told() {
        let reopened_in = |chat: &str, task_id: &str| -> Vec<serde_json::Value> {
            crate::transcript::since(chat, 0)
                .into_iter()
                .map(|item| item.event)
                .filter(|event| {
                    event["type"] == "octiq_task_reopened" && event["taskId"] == task_id
                })
                .collect()
        };
        let repo = Repo::new();
        let (store, run, task) = setup(&repo, WorkspaceMode::Auto);
        store.require_plan_approval(&run.id).unwrap();
        store
            .approve_plan("chat:master", &run.id, None, None)
            .unwrap();
        let first = prepare(&store, &task, Access::Auto).unwrap();
        let approved = store.owned_task("chat:master", &task.id).unwrap().1;
        // Not finished yet: nothing is reopened, recorded or told.
        let early = store
            .reopen_task("chat:master", &task.id, "Too soon".into())
            .unwrap_err();
        assert!(early.contains("Only a completed task"), "{early}");
        assert!(reopened_in("chat:master", &task.id).is_empty());
        report(&store, &first, WorkerOutcome::Completed);

        let reopened = store
            .reopen_task("chat:master", &task.id, "Address review".into())
            .unwrap();
        assert_eq!(reopened.approved_at, approved.approved_at);
        assert_eq!(reopened.approved, approved.approved);
        assert_eq!(reopened.spec, "Address review");
        assert_eq!(reopened.reopens.len(), 1);
        let record = &reopened.reopens[0];
        assert_eq!(record.by_chat_key, "chat:master");
        assert_eq!(record.attempt, 2);
        assert_eq!(record.previous_spec, "Make the requested change");
        assert_eq!(record.spec, "Address review");
        let told = reopened_in("chat:master", &task.id);
        assert_eq!(told.len(), 1, "one event for one reopen");
        assert_eq!(
            told[0],
            json!({
                "type": "octiq_task_reopened",
                "runId": run.id,
                "taskId": task.id,
                "title": "Implement",
                "assignee": null,
                "attempt": 2,
                "spec": "Address review",
                "previousSpecChars": 25,
                "at": record.at,
            })
        );

        // Another access than the one it was approved with: refused, and no
        // attempt is made of it. As approved, it starts where it worked.
        let refused = prepare(&store, &task, Access::Full).unwrap_err();
        assert!(refused.contains("full access instead of auto"), "{refused}");
        let next = prepare(&store, &task, Access::Auto).unwrap();
        assert_eq!((next.number, next.cwd.as_str()), (2, first.cwd.as_str()));
        report(&store, &next, WorkerOutcome::Completed);

        // A second reopen is a second record and a second event, each whole.
        let again = store
            .reopen_task("chat:master", &task.id, "And the 测试 too".into())
            .unwrap();
        assert_eq!(again.reopens.len(), 2);
        assert_eq!(again.reopens[1].attempt, 3);
        assert_eq!(again.reopens[1].previous_spec, "Address review");
        let told = reopened_in("chat:master", &task.id);
        assert_eq!(told.len(), 2);
        assert_eq!(told[1]["attempt"], 3);
        assert_eq!(told[1]["spec"], "And the 测试 too");
        assert_eq!(
            told[1]["previousSpecChars"], 14,
            "characters, not UTF-16 units"
        );
        // Only its own coordinator reopens it, and the stranger's chat is
        // told nothing.
        assert!(store
            .reopen_task("chat:other", &task.id, "Mine now".into())
            .is_err());
        assert!(reopened_in("chat:other", &task.id).is_empty());
        assert_eq!(reopened_in("chat:master", &task.id).len(), 2);
    }

    /// A run whose coordinator is a chat the index lists, in a ledger of its
    /// own: what a reopen needs to tell the person about. The chat and its
    /// transcript are forgotten again on drop.
    struct Reopenable {
        dir: crate::test_dir::TestDir,
        id: String,
        key: String,
        store: OrchestrationStore,
        run: Run,
    }

    impl Reopenable {
        fn new() -> Self {
            let dir = crate::test_dir::TestDir::new("m2-reopen");
            let id = format!("reopen-{}", uuid::Uuid::new_v4().simple());
            let key = format!("chat:{id}");
            crate::chat_index::upsert(
                serde_json::from_value(json!({
                    "id": id, "projectId": "project", "title": "Lead chat", "updatedAt": 100,
                }))
                .unwrap(),
            )
            .unwrap();
            let store = OrchestrationStore::load(dir.0.join("orchestrations.json"));
            let run = store
                .create_run(
                    key.clone(),
                    "Build feature".into(),
                    "project".into(),
                    dir.0.to_string_lossy().into_owned(),
                    Some(4),
                )
                .unwrap();
            Self {
                dir,
                id,
                key,
                store,
                run,
            }
        }

        /// A task that ran once, completed, and kept its workspace.
        fn completed_task(&self) -> Task {
            let task = self
                .store
                .create_task(
                    &self.key,
                    self.run.id.clone(),
                    "Implement".into(),
                    "Make the requested change".into(),
                    vec![],
                    None,
                    None,
                )
                .unwrap();
            let attempt = self.start(&task).unwrap();
            let root = self.dir.0.to_string_lossy().into_owned();
            self.store
                .mutate(|data| {
                    let task = data.tasks.get_mut(&task.id).unwrap();
                    task.status = TaskStatus::Completed;
                    task.result = Some("Done".into());
                    task.workspace = Some(TaskWorkspace {
                        plan: workflow::plan(&root, "", &task.id, WorkspaceMode::Direct)?,
                        state: WorkspaceState::Retained,
                        lease_attempt_id: Some(attempt.id.clone()),
                        delivery: None,
                        validation_paths: vec![],
                        cleanup_intent: None,
                        abandoned: false,
                    });
                    data.attempts.get_mut(&attempt.id).unwrap().status = AttemptStatus::Completed;
                    Ok(())
                })
                .unwrap();
            task
        }

        fn reopen(&self, task: &Task, spec: &str) -> Result<Task, String> {
            self.store.reopen_task(&self.key, &task.id, spec.into())
        }

        fn start(&self, task: &Task) -> Result<Attempt, String> {
            self.store
                .reserve_attempt(&self.key, &super::super::tests::launch_for(&task.id))
                .map(|(_, _, attempt, _)| attempt)
        }

        /// The reopens the coordinator's transcript tells of, oldest first.
        fn told(&self) -> Vec<serde_json::Value> {
            crate::transcript::since(&self.key, 0)
                .into_iter()
                .map(|item| item.event)
                .filter(|event| event["type"] == "octiq_task_reopened")
                .collect()
        }

        fn transcript(&self) -> std::path::PathBuf {
            crate::transcript::path_for(&self.key).unwrap()
        }

        /// The transcript cannot be appended to: a folder is where its file
        /// goes. Nothing was in it yet.
        fn break_transcript(&self) {
            let _ = fs::remove_file(self.transcript());
            fs::create_dir(self.transcript()).unwrap();
        }

        fn mend_transcript(&self) {
            fs::remove_dir(self.transcript()).unwrap();
        }

        /// The server is stopped and started: the ledger is read again.
        fn restarted(mut self) -> Self {
            let path = self.dir.0.join("orchestrations.json");
            self.store = OrchestrationStore::load(path);
            self
        }
    }

    impl Drop for Reopenable {
        fn drop(&mut self) {
            let _ = fs::remove_dir(self.transcript());
            let _ = crate::chat_index::remove(&self.id);
            crate::transcript::forget(&self.key);
        }
    }

    /// Review of 931b5f0, H5, the reviewer's probe: the coordinator's
    /// transcript cannot be written when a task is reopened. The reopen is
    /// on record, and its task does not start: the person is shown every
    /// reopen before its work begins.
    #[test]
    fn a_reopened_task_does_not_start_until_its_notice_is_in_the_coordinators_chat() {
        let work = Reopenable::new();
        let task = work.completed_task();
        work.break_transcript();
        let reopened = work.reopen(&task, "Entirely new instructions").unwrap();
        assert_eq!(reopened.reopens.len(), 1);
        assert_eq!(reopened.status, TaskStatus::Ready);
        assert!(work.told().is_empty(), "nothing could be written");
        let held = work
            .start(&task)
            .expect_err("a reopen the person was not shown");
        assert!(
            held.starts_with("This task was reopened with new instructions, and the notice of that in the coordinator's chat has not been confirmed as saved to disk yet"),
            "{held}"
        );
        assert_eq!(held, REOPEN_NOT_TOLD);
        // The reopen is on record as not yet shown, and the snapshot says
        // why the task waits, in every view.
        assert!(!reopened.reopens[0].notice_delivered);
        let waiting = |store: &OrchestrationStore| {
            let snapshot = store.snapshot(Some(&work.run.id)).unwrap();
            let full = serde_json::to_value(&snapshot).unwrap();
            let compact = agent_view::agent_snapshot(
                snapshot.clone(),
                &agent_view::AgentRead {
                    actor: &work.key,
                    run_id: Some(&work.run.id),
                    task_id: None,
                    message_limit: 12,
                },
            )
            .unwrap();
            let wave = automation::ready_wave(&snapshot, &snapshot.runs[0]).len();
            (
                full["tasks"][0]["heldByReopen"].clone(),
                compact["tasks"][0]["heldByReopen"].clone(),
                full["tasks"][0]["reopens"][0]["noticeDelivered"].clone(),
                wave,
            )
        };
        assert_eq!(
            waiting(&work.store),
            (json!(true), json!(true), json!(false), 0)
        );
        // The scheduler's pass tries again and fails again: still held.
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0));
        assert!(work.start(&task).is_err());

        // The fault is lifted. The next pass writes the notice, once, and
        // the task starts on its new instructions.
        work.mend_transcript();
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1));
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0), "once");
        let told = work.told();
        assert_eq!(told.len(), 1, "{told:?}");
        assert_eq!(
            told[0],
            json!({
                "type": "octiq_task_reopened",
                "runId": work.run.id,
                "taskId": task.id,
                "title": "Implement",
                "assignee": null,
                "attempt": 2,
                "spec": "Entirely new instructions",
                "previousSpecChars": 25,
                "at": reopened.reopens[0].at,
            })
        );
        assert_eq!(
            waiting(&work.store),
            (
                serde_json::Value::Null,
                serde_json::Value::Null,
                json!(true),
                1
            )
        );
        let next = work.start(&task).expect("shown, so it starts");
        assert_eq!(next.number, 2);
        assert_eq!(work.told().len(), 1, "one event for one reopen");
    }

    /// Two reopens whose notices could not be written are two events once
    /// they can be, one each, in the order they were made. And a notice
    /// that reached the transcript without the ledger hearing of it (the
    /// server stopped in between) is recorded, not written a second time.
    #[test]
    fn every_reopen_is_told_exactly_once_however_often_it_is_tried() {
        let work = Reopenable::new();
        let (first, second) = (work.completed_task(), work.completed_task());
        work.break_transcript();
        let one = work.reopen(&first, "Fix the first").unwrap();
        let two = work.reopen(&second, "Fix the second").unwrap();
        assert!(work.start(&first).is_err() && work.start(&second).is_err());
        work.mend_transcript();
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(2));
        let specs: Vec<String> = work
            .told()
            .iter()
            .map(|event| event["spec"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(specs.len(), 2, "{specs:?}");
        assert!(specs.contains(&"Fix the first".to_owned()));
        assert!(specs.contains(&"Fix the second".to_owned()));
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0));
        work.start(&first).unwrap();
        work.start(&second).unwrap();
        assert_ne!(one.reopens[0].at, 0);
        assert_ne!(two.id, one.id);

        // A reopen written with no fault is told in the same call, and the
        // task it returns says so.
        let third = work.completed_task();
        let told = work.reopen(&third, "Fix the third").unwrap();
        assert!(told.reopens[0].notice_delivered);
        assert_eq!(work.told().len(), 3);
        // The ledger forgets it was told: what a server stopped between
        // the transcript's write and the ledger's would read on its way up.
        work.store
            .mutate(|data| {
                data.tasks.get_mut(&third.id).unwrap().reopens[0].notice_delivered = false;
                Ok(())
            })
            .unwrap();
        let work = work.restarted();
        assert!(work.start(&third).is_err(), "held until it is checked");
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1), "recorded");
        assert_eq!(work.told().len(), 3, "and not written again");
        work.start(&third).unwrap();
    }

    /// A restart with a notice still owed: the ledger remembers, the task
    /// stays held in the new process, and the first pass that can write the
    /// notice writes it once.
    #[test]
    fn a_notice_still_owed_at_a_restart_holds_the_task_until_it_is_written() {
        let work = Reopenable::new();
        let task = work.completed_task();
        work.break_transcript();
        work.reopen(&task, "After the restart").unwrap();
        let work = work.restarted();
        assert_eq!(work.start(&task).unwrap_err(), REOPEN_NOT_TOLD);
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0));
        work.mend_transcript();
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1));
        let told = work.told();
        assert_eq!(told.len(), 1);
        assert_eq!(told[0]["spec"], "After the restart");
        assert_eq!(work.start(&task).unwrap().number, 2);
    }

    /// With no chat of the person's to show it in, there is no reopen: the
    /// task keeps its result and its instructions, and nothing is recorded.
    /// A chat in the trash is such a chat; restored, the reopen is made.
    #[test]
    fn a_reopen_is_refused_when_the_coordinators_chat_is_gone() {
        let work = Reopenable::new();
        let task = work.completed_task();
        let meta = crate::chat_index::list()
            .into_iter()
            .find(|chat| chat.id == work.id)
            .unwrap();
        assert!(crate::chat_index::trash(&work.id, None, Some(meta)).unwrap());
        let refused = work.reopen(&task, "Too late").unwrap_err();
        assert!(
            refused.starts_with("The coordinator's chat no longer exists, so the person could not be shown this reopen. Nothing was reopened."),
            "{refused}"
        );
        let kept = work.store.owned_task(&work.key, &task.id).unwrap().1;
        assert_eq!(kept.status, TaskStatus::Completed);
        assert_eq!(kept.spec, "Make the requested change");
        assert!(kept.reopens.is_empty());
        assert!(work.told().is_empty());

        // And a chat deleted after the reopen was recorded gets no notice
        // written into a transcript nobody can open: the task stays held.
        crate::chat_index::restore(&work.id).unwrap();
        work.break_transcript();
        work.reopen(&task, "In time").unwrap();
        work.mend_transcript();
        let meta = crate::chat_index::list()
            .into_iter()
            .find(|chat| chat.id == work.id)
            .unwrap();
        assert!(crate::chat_index::trash(&work.id, None, Some(meta)).unwrap());
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0));
        assert!(work.told().is_empty());
        assert_eq!(work.start(&task).unwrap_err(), REOPEN_NOT_TOLD);
        crate::chat_index::restore(&work.id).unwrap();
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1));
        assert_eq!(work.start(&task).unwrap().number, 2);
    }

    /// Every folder sync on this thread is refused until this is dropped,
    /// a failed assertion included.
    struct NoFolderSync;

    impl NoFolderSync {
        fn begin() -> Self {
            crate::transcript::FAIL_DIR_SYNC.with(|fail| fail.set(true));
            Self
        }
    }

    impl Drop for NoFolderSync {
        fn drop(&mut self) {
            crate::transcript::FAIL_DIR_SYNC.with(|fail| fail.set(false));
        }
    }

    /// Review of 4603eb4, H5, the reviewer's probe: the notice's line was
    /// appended but its folder would not sync, so the host holds no receipt
    /// for it. A line that can be read is not one. While the fault lasts
    /// the task stays held, however often the scheduler looks, and the line
    /// is never written a second time; the first pass after the fault is
    /// lifted confirms the line that is there and the task starts.
    #[test]
    fn a_notice_that_was_written_but_never_confirmed_is_not_taken_as_delivered() {
        let work = Reopenable::new();
        let task = work.completed_task();
        let fault = NoFolderSync::begin();
        let reopened = work.reopen(&task, "Storage sync still failing").unwrap();
        assert!(!reopened.reopens[0].notice_delivered, "no receipt");
        assert_eq!(work.start(&task).unwrap_err(), REOPEN_NOT_TOLD);
        assert_eq!(work.told().len(), 1, "the line is there, unproven");
        for pass in 1..=10 {
            assert_eq!(
                work.store.deliver_reopen_notices_now(),
                Ok(0),
                "pass {pass}: a readable line was taken for a receipt"
            );
            assert_eq!(
                work.start(&task)
                    .expect_err("started on a notice nothing confirmed"),
                REOPEN_NOT_TOLD,
                "pass {pass}"
            );
            assert_eq!(work.told().len(), 1, "pass {pass}: never written twice");
        }
        let held = work.store.owned_task(&work.key, &task.id).unwrap().1;
        assert!(!held.reopens[0].notice_delivered);

        // The fault is lifted: one pass confirms the line already there.
        drop(fault);
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1));
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0), "once");
        let told = work.told();
        assert_eq!(told.len(), 1, "one event in the transcript: {told:?}");
        assert_eq!(told[0]["spec"], "Storage sync still failing");
        assert_eq!(work.start(&task).unwrap().number, 2);
        assert_eq!(work.told().len(), 1);
    }

    /// While a chat's transcript holds a notice nothing confirmed, no
    /// other notice is written into it either: the fault is the
    /// transcript's, and a second line there would be as unproven as the
    /// first. Lifted, one pass confirms the one and writes the other.
    #[test]
    fn a_chat_with_an_unconfirmed_notice_takes_no_new_notice_until_it_is_confirmed() {
        let work = Reopenable::new();
        let (first, second) = (work.completed_task(), work.completed_task());
        let fault = NoFolderSync::begin();
        work.reopen(&first, "Fix the first").unwrap();
        work.reopen(&second, "Fix the second").unwrap();
        assert_eq!(work.told().len(), 1, "the first, unproven, and no other");
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0));
        assert_eq!(work.told().len(), 1);
        assert!(work.start(&first).is_err() && work.start(&second).is_err());
        drop(fault);
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(2));
        let specs: Vec<_> = work
            .told()
            .iter()
            .map(|event| event["spec"].clone())
            .collect();
        assert_eq!(specs, [json!("Fix the first"), json!("Fix the second")]);
        work.start(&first).unwrap();
        work.start(&second).unwrap();
    }

    /// A task reopened while no folder will sync, then looked at ten times
    /// with the fault still on, then once with it lifted. The notice's line
    /// is written once and is no receipt: the task stays held and the line
    /// is never written again. Lifted, one pass confirms the line that is
    /// there, and the task starts on one event.
    fn held_until_the_folder_syncs(work: &Reopenable, task: &Task, fault: NoFolderSync) {
        let reopened = work.reopen(task, "Folder sync still failing").unwrap();
        assert!(
            !reopened.reopens[0].notice_delivered,
            "delivered on a line whose folder never synced"
        );
        assert_eq!(work.start(task).unwrap_err(), REOPEN_NOT_TOLD);
        assert_eq!(work.told().len(), 1, "the line is there, unproven");
        for pass in 1..=10 {
            assert_eq!(
                work.store.deliver_reopen_notices_now(),
                Ok(0),
                "pass {pass}"
            );
            assert_eq!(
                work.start(task)
                    .expect_err("started on a notice nothing confirmed"),
                REOPEN_NOT_TOLD,
                "pass {pass}"
            );
            assert_eq!(work.told().len(), 1, "pass {pass}: never written twice");
        }
        let held = work.store.owned_task(&work.key, &task.id).unwrap().1;
        assert!(!held.reopens[0].notice_delivered);
        // Whoever asks: the coordinator, the person's Start, the host's own
        // recovery. And there is nothing of it for the person to stop.
        let launch = super::super::tests::launch_for(&task.id);
        for by in [
            StartedBy::Coordinator,
            StartedBy::Page { retry_of: None },
            StartedBy::Recovery("attempt_before"),
        ] {
            let refused = work.store.reserve_attempt_for(&work.key, &launch, by);
            assert_eq!(refused.map(|_| ()).unwrap_err(), REOPEN_NOT_TOLD);
        }
        assert!(work.store.stop_task(&task.id, None).is_err());

        drop(fault);
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1));
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0), "once");
        let told = work.told();
        assert_eq!(told.len(), 1, "one event in the transcript: {told:?}");
        assert_eq!(told[0]["spec"], "Folder sync still failing");
        assert_eq!(work.start(task).unwrap().number, 2);
        assert_eq!(work.told().len(), 1);
    }

    /// Review of 0c0ad0b, H5b, the reviewer's first probe: the usual case.
    /// The coordinator's record was made by an ordinary append, so nothing
    /// ever synced its folder entry, and the notice is a fresh line in it.
    /// That the file was already there says nothing about its folder: the
    /// notice is delivered only once file and folder have both synced.
    #[test]
    fn a_notice_appended_to_a_record_whose_folder_never_synced_is_not_taken_as_delivered() {
        let work = Reopenable::new();
        let task = work.completed_task();
        let fault = NoFolderSync::begin();
        let said = json!({ "type": "assistant", "message": { "content": "Earlier text" } });
        assert!(crate::transcript::append(&work.key, &said).is_some());
        held_until_the_folder_syncs(&work, &task, fault);
    }

    /// Review of 0c0ad0b, H5b, the reviewer's second probe: the record had
    /// a full receipt once, file and folder. Then it was compacted, which
    /// puts a new file under the old name and syncs no folder, and the
    /// notice is a fresh line in that new file. A receipt for the file that
    /// was there is none for the one that is there now.
    #[test]
    fn a_notice_appended_to_a_record_that_was_rewritten_is_not_taken_as_delivered() {
        let work = Reopenable::new();
        let task = work.completed_task();
        let picture = json!({ "type": "user", "message": { "content": [{
            "type": "tool_result",
            "tool_use_id": "shot",
            "content": [{ "type": "image", "source": { "type": "base64", "data": "A".repeat(10_000) } }],
        }] } });
        assert!(crate::transcript::append_synced(&work.key, &picture).is_some());
        let record = crate::transcript::generation(&work.key).unwrap();
        assert_eq!(
            crate::transcript::confirm_synced(&work.key, &record),
            Some(())
        );
        let before = fs::metadata(work.transcript()).unwrap().len();
        let fault = NoFolderSync::begin();
        let freed = crate::record_trim::compact_record(&work.transcript()).unwrap();
        assert!(freed.is_some(), "the record was rewritten");
        assert!(fs::metadata(work.transcript()).unwrap().len() < before);
        held_until_the_folder_syncs(&work, &task, fault);
    }

    /// What the next `notice_receipts` on this thread finds done to its
    /// chat between its last look at the record and asking for the receipt.
    fn before_the_receipt(meanwhile: impl FnOnce(&str) + 'static) {
        BEFORE_RECEIPT.with(|slot| *slot.borrow_mut() = Some(Box::new(meanwhile)));
    }

    /// The person clears the chat (the page's `/clear`, which sends the
    /// socket's `chat_forget` for a chat that stays in the list), and the
    /// host then writes something ordinary to it, which makes its record
    /// again.
    fn cleared_then_written_to(chat: &str) {
        let services = crate::dispatch::Services {
            workspaces: Arc::new(crate::workspaces::WorkspaceState::with_projects(vec![])),
            chats: Arc::new(ChatManager::default()),
            watch: Arc::new(crate::file_watch::FileWatchState::default()),
            git_watch: Arc::new(crate::git_watch::GitWatchState::default()),
            orchestrations: Arc::new(OrchestrationStore::default()),
            ptys: Arc::new(crate::pty::PtyManager::default()),
            handovers: crate::handover::Wiring::scratch(),
        };
        crate::dispatch::dispatch(&services, "chat_forget", json!({ "key": chat })).unwrap();
        let said = json!({ "type": "assistant", "message": { "content": "After the clear" } });
        assert!(crate::agent_chat::record_chat_event(chat, said).is_some());
    }

    /// Review of 8169dd3, RULE 2, probe GATE_REPLACE: the notice was
    /// appended and synced, and before the host asked for its receipt the
    /// profile folder was moved away and another made at its path, with a
    /// record under the chat's name and no notice in it. The receipt was
    /// given for that record: delivered, with the notice nowhere the person
    /// can see, and no later pass put it right. A folder that is not the
    /// one the server started with gives no receipt and takes no line; the
    /// real one back, the notice is confirmed where it was written.
    #[test]
    fn a_notice_is_not_delivered_in_a_folder_that_took_the_profiles_place() {
        let home = crate::profile::tests::Home::with_a_configured_base();
        let _process = crate::profile::started_in(&home.dir);
        crate::profile_lock::acquire("server").unwrap();
        let chat = format!("chat:replaced-{}", uuid::Uuid::new_v4().simple());
        let notice =
            json!({ "type": "octiq_task_reopened", "taskId": "task_1", "attempt": 2, "at": 5 });
        let record = crate::transcript::path_for(&chat).unwrap();
        let strangers = "{\"type\":\"assistant\"}\n";
        before_the_receipt({
            let (profile, kept, record) = (home.profile(), home.kept(), record.clone());
            move |_| {
                fs::rename(&profile, &kept).unwrap();
                fs::create_dir_all(profile.join("chats")).unwrap();
                fs::write(&record, strangers).unwrap();
            }
        });
        assert_eq!(
            notice_receipts(&chat, std::slice::from_ref(&notice)),
            [false],
            "delivered on a record that does not hold the notice"
        );
        assert_eq!(
            notice_receipts(&chat, std::slice::from_ref(&notice)),
            [false]
        );
        assert_eq!(
            fs::read_to_string(&record).unwrap(),
            strangers,
            "the notice was written into the folder that took the profile's place"
        );

        home.move_back();
        assert_eq!(
            notice_receipts(&chat, std::slice::from_ref(&notice)),
            [true]
        );
        assert_eq!(
            crate::transcript::of_type(&chat, "octiq_task_reopened").len(),
            1
        );
    }

    /// The types of the events in a chat's record, in order.
    fn recorded_types(chat: &str) -> Vec<String> {
        crate::transcript::since(chat, 0)
            .iter()
            .map(|item| item.event["type"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    /// Review of ca4d902, H5c, the reviewer's first probe: the notice is a
    /// fresh line, and before the host asks for its receipt the person
    /// clears the chat and the host writes to it again. The record that is
    /// there now is not the one the notice went into, so a sync of it is no
    /// receipt: the task is held for that pass, and the next writes the
    /// notice once into the record the person now sees.
    #[test]
    fn a_notice_appended_to_a_record_cleared_before_its_receipt_is_not_taken_as_delivered() {
        let work = Reopenable::new();
        let task = work.completed_task();
        // The usual record: made by an ordinary append, so the notice's own
        // append syncs no folder and no receipt was ever given for it.
        let said = json!({ "type": "assistant", "message": { "content": "Earlier text" } });
        assert!(crate::transcript::append(&work.key, &said).is_some());
        before_the_receipt(cleared_then_written_to);
        let reopened = work.reopen(&task, "Cleared before the receipt").unwrap();
        assert!(
            !reopened.reopens[0].notice_delivered,
            "delivered on a record that does not hold the notice"
        );
        assert_eq!(recorded_types(&work.key), ["assistant"]);
        assert_eq!(work.start(&task).unwrap_err(), REOPEN_NOT_TOLD);

        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1));
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0), "once");
        assert_eq!(
            recorded_types(&work.key),
            ["assistant", "octiq_task_reopened"],
            "one notice, in the record the person now sees"
        );
        assert_eq!(work.told()[0]["spec"], "Cleared before the receipt");
        assert_eq!(work.start(&task).unwrap().number, 2);
        assert_eq!(work.told().len(), 1);
    }

    /// Review of ca4d902, H5c, the reviewer's second probe: the notice's
    /// line was already in the record, unconfirmed, and a pass found it
    /// there. Before that pass asks for the receipt the chat is cleared and
    /// written to again. Same answer: no receipt for a record the line was
    /// not seen in.
    #[test]
    fn a_notice_found_in_a_record_cleared_before_its_receipt_is_not_taken_as_delivered() {
        let work = Reopenable::new();
        let task = work.completed_task();
        let fault = NoFolderSync::begin();
        let reopened = work.reopen(&task, "Found, then cleared").unwrap();
        drop(fault);
        assert!(!reopened.reopens[0].notice_delivered);
        assert_eq!(work.told().len(), 1, "the line is there, unproven");

        before_the_receipt(cleared_then_written_to);
        assert_eq!(
            work.store.deliver_reopen_notices_now(),
            Ok(0),
            "delivered on a record that does not hold the notice"
        );
        let held = work.store.owned_task(&work.key, &task.id).unwrap().1;
        assert!(!held.reopens[0].notice_delivered);
        assert_eq!(recorded_types(&work.key), ["assistant"]);
        let launch = super::super::tests::launch_for(&task.id);
        for by in [
            StartedBy::Coordinator,
            StartedBy::Page { retry_of: None },
            StartedBy::Recovery("attempt_before"),
        ] {
            let refused = work.store.reserve_attempt_for(&work.key, &launch, by);
            assert_eq!(refused.map(|_| ()).unwrap_err(), REOPEN_NOT_TOLD);
        }

        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1));
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0), "once");
        assert_eq!(
            recorded_types(&work.key),
            ["assistant", "octiq_task_reopened"]
        );
        assert_eq!(work.told()[0]["spec"], "Found, then cleared");
        assert_eq!(work.start(&task).unwrap().number, 2);
        assert_eq!(work.told().len(), 1);
    }

    /// The chat `id`, listed in the index of the profile this thread now
    /// stands in.
    fn listed_here(id: &str) {
        crate::chat_index::upsert(
            serde_json::from_value(json!({
                "id": id, "projectId": "project", "title": "Lead chat", "updatedAt": 100,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    /// Review of bf9d8cd, finding 1, the reviewer's first transition probe
    /// (A to B). The notice is read or written in one record, and by the
    /// time the receipt is asked for the chat's name resolves to another
    /// file that has never moved on either. The folder is fixed at startup
    /// now, so the test moves it by standing the thread in another profile:
    /// the token says which file it was taken for, that file is not the one
    /// about to be synced, and the answer is no receipt. The task is held,
    /// and the next pass confirms the notice where it is, once.
    #[test]
    fn a_receipt_is_not_given_on_a_record_in_another_folder_than_the_notice_went_into() {
        let work = Reopenable::new();
        let task = work.completed_task();
        let other = crate::test_dir::TestDir::new("m6-other-profile");
        let elsewhere = std::rc::Rc::new(std::cell::RefCell::new(None));
        let moved = elsewhere.clone();
        let home = other.to_path_buf();
        before_the_receipt(move |chat| {
            *moved.borrow_mut() = Some(crate::profile::started_in(&home));
            let said = json!({ "type": "assistant", "message": { "content": "Other history" } });
            assert!(crate::agent_chat::record_chat_event(chat, said).is_some());
        });
        let reopened = work.reopen(&task, "Seen in one folder").unwrap();
        assert!(
            !reopened.reopens[0].notice_delivered,
            "delivered on a record in another folder, which holds no notice"
        );
        assert_eq!(recorded_types(&work.key), ["assistant"]);
        let launch = super::super::tests::launch_for(&task.id);
        for by in [
            StartedBy::Coordinator,
            StartedBy::Page { retry_of: None },
            StartedBy::Recovery("attempt_before"),
        ] {
            let refused = work.store.reserve_attempt_for(&work.key, &launch, by);
            assert_eq!(refused.map(|_| ()).unwrap_err(), REOPEN_NOT_TOLD);
        }
        let there = elsewhere.borrow_mut().take();
        crate::transcript::forget(&work.key);
        drop(there);

        // Back in the folder the notice went into.
        assert_eq!(work.told().len(), 1);
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1));
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0), "once");
        assert_eq!(work.told().len(), 1, "never written a second time");
        assert_eq!(work.start(&task).unwrap().number, 2);
    }

    /// The reviewer's second transition probe (B to A): the notice went
    /// into a record in another folder, and the receipt is asked for in the
    /// folder the page reads, whose record holds none. No receipt; the next
    /// pass does not find the notice there and writes it, once.
    #[test]
    fn a_notice_written_in_another_folder_is_written_again_where_the_receipt_is_asked() {
        let work = Reopenable::new();
        let task = work.completed_task();
        let said = json!({ "type": "assistant", "message": { "content": "Earlier text" } });
        assert!(crate::transcript::append(&work.key, &said).is_some());

        let other = crate::test_dir::TestDir::new("m6-other-profile");
        let elsewhere = std::rc::Rc::new(std::cell::RefCell::new(Some(
            crate::profile::started_in(&other),
        )));
        listed_here(&work.id);
        let back = elsewhere.clone();
        before_the_receipt(move |chat| {
            assert_eq!(recorded_types(chat), ["octiq_task_reopened"]);
            crate::transcript::forget(chat);
            drop(back.borrow_mut().take());
        });
        let reopened = work.reopen(&task, "Written in another folder").unwrap();
        assert!(elsewhere.borrow().is_none(), "the pass reached its receipt");
        assert!(
            !reopened.reopens[0].notice_delivered,
            "delivered on a record that does not hold the notice"
        );
        assert_eq!(recorded_types(&work.key), ["assistant"]);
        assert_eq!(work.start(&task).unwrap_err(), REOPEN_NOT_TOLD);

        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1));
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0), "once");
        assert_eq!(
            recorded_types(&work.key),
            ["assistant", "octiq_task_reopened"],
            "one notice, in the record the person sees"
        );
        assert_eq!(work.told()[0]["spec"], "Written in another folder");
        assert_eq!(work.start(&task).unwrap().number, 2);
    }

    /// Two notices owed in one chat, one found there and one written now,
    /// and the chat is cleared before the receipt. Neither is delivered on
    /// the record that is left; the next pass leaves both in it, once each.
    #[test]
    fn a_clear_before_the_receipt_holds_every_notice_owed_in_that_chat() {
        let work = Reopenable::new();
        let (first, second) = (work.completed_task(), work.completed_task());
        let fault = NoFolderSync::begin();
        work.reopen(&first, "Fix the first").unwrap();
        work.reopen(&second, "Fix the second").unwrap();
        drop(fault);
        assert_eq!(work.told().len(), 1, "the first, unproven, and no other");

        before_the_receipt(cleared_then_written_to);
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0));
        assert!(work.start(&first).is_err() && work.start(&second).is_err());

        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(2));
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0), "once");
        let mut specs: Vec<_> = work
            .told()
            .iter()
            .map(|event| event["spec"].as_str().unwrap().to_string())
            .collect();
        specs.sort();
        assert_eq!(specs, ["Fix the first", "Fix the second"], "once each");
        work.start(&first).unwrap();
        work.start(&second).unwrap();
    }

    /// What the rule does not promise: once a notice was delivered, the
    /// person clearing the chat removes it with the rest of that history.
    /// That is their own act. Nothing about the task changes, and the
    /// notice is not written again.
    #[test]
    fn clearing_the_chat_after_a_notice_was_delivered_changes_nothing_about_the_task() {
        let work = Reopenable::new();
        let task = work.completed_task();
        let reopened = work.reopen(&task, "Delivered, then cleared").unwrap();
        assert!(reopened.reopens[0].notice_delivered);
        assert_eq!(work.told().len(), 1);

        cleared_then_written_to(&work.key);
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0));
        assert_eq!(
            recorded_types(&work.key),
            ["assistant"],
            "not written again"
        );
        let kept = work.store.owned_task(&work.key, &task.id).unwrap().1;
        assert!(kept.reopens[0].notice_delivered);
        assert_eq!(kept.spec, "Delivered, then cleared");
        assert_eq!(work.start(&task).unwrap().number, 2);
        assert!(work.told().is_empty());
    }

    /// A compaction in the same window is not a clear. It puts a new file
    /// under the record's name and keeps every line of it, the notice
    /// among them, so the receipt asked for afterwards is for a record that
    /// holds the line: delivered in that pass, written once. For a line
    /// written now and for one found there.
    #[test]
    fn a_compaction_before_the_receipt_still_confirms_the_notice() {
        let picture = json!({ "type": "user", "message": { "content": [{
            "type": "tool_result",
            "tool_use_id": "shot",
            "content": [{ "type": "image", "source": { "type": "base64", "data": "A".repeat(10_000) } }],
        }] } });
        let compacted = |chat: &str| {
            let path = crate::transcript::path_for(chat).unwrap();
            let before = fs::metadata(&path).unwrap().len();
            let freed = crate::record_trim::compact_record(&path).unwrap();
            assert!(freed.is_some(), "the record was rewritten");
            assert!(fs::metadata(&path).unwrap().len() < before);
        };
        for found in [false, true] {
            let work = Reopenable::new();
            let task = work.completed_task();
            assert!(crate::transcript::append(&work.key, &picture).is_some());
            if found {
                let fault = NoFolderSync::begin();
                let reopened = work.reopen(&task, "Compacted in the window").unwrap();
                drop(fault);
                assert!(!reopened.reopens[0].notice_delivered);
                before_the_receipt(compacted);
                assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1));
            } else {
                before_the_receipt(compacted);
                let reopened = work.reopen(&task, "Compacted in the window").unwrap();
                assert!(reopened.reopens[0].notice_delivered, "found: {found}");
            }
            assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0), "once");
            assert_eq!(recorded_types(&work.key), ["user", "octiq_task_reopened"]);
            assert_eq!(work.told()[0]["spec"], "Compacted in the window");
            assert_eq!(work.start(&task).unwrap().number, 2);
        }
    }

    /// A line that is not UTF-8 (a write cut inside a character) hides no
    /// notice after it: the notice is found, confirmed, and not written a
    /// second time.
    #[test]
    fn a_notice_behind_a_line_that_is_not_utf8_is_found_and_not_written_again() {
        let work = Reopenable::new();
        let task = work.completed_task();
        fs::write(
            work.transcript(),
            b"{\"type\":\"assistant\",\"text\":\"\xE4\xB8\n",
        )
        .unwrap();
        let reopened = work.reopen(&task, "Behind a torn line").unwrap();
        assert!(reopened.reopens[0].notice_delivered);
        // The ledger forgets it was told, as a server stopped between the
        // transcript's write and the ledger's would on its way up.
        work.store
            .mutate(|data| {
                data.tasks.get_mut(&task.id).unwrap().reopens[0].notice_delivered = false;
                Ok(())
            })
            .unwrap();
        assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1), "found");
        let record = fs::read(work.transcript()).unwrap();
        let notices = record
            .split(|byte| *byte == b'\n')
            .filter(|line| String::from_utf8_lossy(line).contains("octiq_task_reopened"))
            .count();
        assert_eq!(notices, 1, "written a second time");
        assert_eq!(work.start(&task).unwrap().number, 2);
    }

    /// A reopen kept in the ledger with no `noticeDelivered` at all, as the
    /// build that first kept reopens wrote it, is one nothing confirmed:
    /// the rule has no exception for a record that does not say. Its task
    /// is held until a pass finds the line and confirms it, or writes it
    /// once when it is not there.
    #[test]
    fn a_reopen_recorded_without_the_field_is_held_until_its_notice_is_confirmed() {
        for line_kept in [true, false] {
            let work = Reopenable::new();
            let task = work.completed_task();
            let reopened = work.reopen(&task, "Kept by an older build").unwrap();
            assert!(reopened.reopens[0].notice_delivered);
            let path = work.dir.0.join("orchestrations.json");
            let mut ledger: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            let kept = ledger["tasks"][&task.id]["reopens"][0]
                .as_object_mut()
                .unwrap();
            assert_eq!(kept.remove("noticeDelivered"), Some(json!(true)));
            fs::write(&path, serde_json::to_vec(&ledger).unwrap()).unwrap();
            if !line_kept {
                crate::transcript::forget(&work.key);
            }
            let work = work.restarted();

            assert_eq!(work.start(&task).unwrap_err(), REOPEN_NOT_TOLD);
            let fault = NoFolderSync::begin();
            assert_eq!(work.store.deliver_reopen_notices_now(), Ok(0));
            assert_eq!(work.start(&task).unwrap_err(), REOPEN_NOT_TOLD);
            drop(fault);
            assert_eq!(work.store.deliver_reopen_notices_now(), Ok(1));
            let told = work.told();
            assert_eq!(told.len(), 1, "line kept: {line_kept}: {told:?}");
            assert_eq!(told[0]["spec"], "Kept by an older build");
            assert_eq!(work.start(&task).unwrap().number, 2);
        }
    }

    /// The scheduler reads a chat's transcript once a pass for all the
    /// notices it owes there, and leaves a chat that gave no receipt alone
    /// for longer each time: 4 s, doubling to a minute. A wait is the
    /// chat's; a receipt ends it.
    #[test]
    fn a_transcript_is_read_once_a_pass_and_less_often_while_it_gives_no_receipt() {
        assert_eq!(
            [1, 2, 3, 4, 5, 6, 40].map(notice_wait),
            [4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]
        );
        let reads = || crate::transcript::READS_BY_TYPE.with(|reads| reads.get());
        let work = Reopenable::new();
        let (first, second) = (work.completed_task(), work.completed_task());
        work.break_transcript();
        work.reopen(&first, "Fix the first").unwrap();
        work.reopen(&second, "Fix the second").unwrap();
        let wait = || {
            let waits = work.store.reopen_waits.lock().unwrap();
            waits.get(&work.key).copied()
        };
        let (tries, next) = wait().expect("no receipt, so the chat waits");
        assert_eq!(tries, 2, "one try for each reopen as it was made");

        // Inside the wait nothing is read, though the fault is lifted.
        work.mend_transcript();
        let before = reads();
        assert_eq!(work.store.deliver_reopen_notices(next - 1), Ok(0));
        assert_eq!(reads(), before, "not asked before its time");
        assert_eq!(work.start(&first).unwrap_err(), REOPEN_NOT_TOLD);

        // Due, and the fault is back: one read for both notices, and the
        // next wait is longer.
        work.break_transcript();
        assert_eq!(work.store.deliver_reopen_notices(next), Ok(0));
        assert_eq!(reads(), before + 1, "one read for two notices");
        assert_eq!(wait(), Some((3, next + 16_000)));
        assert_eq!(work.store.deliver_reopen_notices(next + 15_999), Ok(0));
        assert_eq!(reads(), before + 1);

        // Due again with the fault gone: one read, both written, no wait.
        work.mend_transcript();
        assert_eq!(work.store.deliver_reopen_notices(next + 16_000), Ok(2));
        assert_eq!(reads(), before + 2, "one read for two notices");
        assert_eq!(wait(), None);
        assert_eq!(work.told().len(), 2);
        work.start(&first).unwrap();
        work.start(&second).unwrap();
        // Nothing owed: nothing read.
        assert_eq!(work.store.deliver_reopen_notices(next + 16_001), Ok(0));
        assert_eq!(reads(), before + 2);
    }

    /// agent_delete review, M3: a workspace the host is preparing or
    /// cleaning up for a task of the agent's is work in progress. A lease
    /// left on a settled task's retained workspace is not: it stays there
    /// until cleanup, and would keep every agent that ever finished a task.
    #[test]
    fn a_workspace_being_prepared_or_cleaned_up_keeps_its_agent_from_removal() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Auto);
        let ada = TaskAssignee {
            id: "agent_ada".into(),
            name: "Ada".into(),
        };
        store
            .mutate(|data| {
                data.tasks.get_mut(&task.id).unwrap().assignee = Some(ada.clone());
                Ok(())
            })
            .unwrap();
        let attempt = prepare(&store, &task, Access::Auto).unwrap();
        assert_eq!(store.agent_work(&ada.id).unwrap().running.len(), 1);
        report(&store, &attempt, WorkerOutcome::Completed);
        let settled = store.owned_task("chat:master", &task.id).unwrap().1;
        let workspace = settled.workspace.unwrap();
        assert_eq!(workspace.state, WorkspaceState::Retained);
        assert!(workspace.lease_attempt_id.is_some(), "the lease is kept");
        assert_eq!(store.removal_of(&ada.id, "Ada"), Ok(None));
        for (state, busy) in [
            (WorkspaceState::Cleaning, true),
            (WorkspaceState::Preparing, true),
            (WorkspaceState::Ready, false),
            (WorkspaceState::Cleaned, false),
        ] {
            store
                .mutate(|data| {
                    let task = data.tasks.get_mut(&task.id).unwrap();
                    task.workspace.as_mut().unwrap().state = state.clone();
                    Ok(())
                })
                .unwrap();
            assert_eq!(store.removal_of(&ada.id, "Ada").is_err(), busy, "{state:?}");
        }
    }

    #[test]
    fn a_legacy_flag_cannot_override_auto_policy_for_a_first_writer() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Auto);
        let launch = WorkerLaunch {
            task_id: task.id.clone(),
            agent: ChatAgent::Codex,
            access: Access::Auto,
            model: None,
            effort: None,
            new_worktree: Some(false),
            base_branch: String::new(),
        };
        let (run, task, reserved, previous) =
            store.reserve_attempt("chat:master", &launch).unwrap();
        assert!(store
            .prepare_task_workspace(
                &ChatManager::default(),
                &run,
                &task,
                &reserved,
                previous.as_ref(),
                &launch
            )
            .unwrap_err()
            .contains("first writing attempt"));
        assert_eq!(repo.git(&["status", "--porcelain"]), "");
    }

    #[test]
    fn a_read_only_auto_checkout_cannot_be_silently_upgraded_to_a_writer_on_retry() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Auto);
        let first = prepare(&store, &task, Access::Read).unwrap();
        report(&store, &first, WorkerOutcome::Blocked);
        assert!(prepare(&store, &task, Access::Auto)
            .unwrap_err()
            .contains("read-only work"));
        assert_eq!(repo.git(&["status", "--porcelain"]), "");
    }
    // ---- Missions: one worktree per repository, open until closed --------

    fn close(store: &OrchestrationStore, run: &Run, abandon: bool) -> Result<Run, String> {
        store.close_mission(&ChatManager::default(), "chat:master", &run.id, abandon)
    }

    #[test]
    fn a_mission_shares_one_worktree_and_a_follow_up_lands_on_its_branch() {
        let repo = Repo::new();
        let (store, run, first) = setup(&repo, WorkspaceMode::Mission);
        let one = prepare(&store, &first, Access::Auto).unwrap();
        let id = run.id.strip_prefix("run_").unwrap();
        assert_eq!(one.branch, format!("feature/mission-{id}"));
        let made = repo.commit(&one.cwd, "first.txt", "first");
        report(&store, &one, WorkerOutcome::Completed);

        // The follow-up's plan is the mission's worktree, and not a conflict.
        let follow_up = super::super::tests::task(&store, &run, vec![]);
        let proposal = stored(&store, &follow_up).workspace_proposal.unwrap();
        assert_eq!(proposal.conflict, None);
        assert_eq!(proposal.plan.unwrap().branch, one.branch);
        let two = prepare(&store, &follow_up, Access::Auto).unwrap();
        assert_eq!(
            (two.cwd.as_str(), two.branch.as_str()),
            (one.cwd.as_str(), one.branch.as_str())
        );
        assert_eq!(repo.git(&["rev-parse", &two.branch]), made);
    }

    #[test]
    fn a_mission_has_one_writer_at_a_time_and_the_scheduler_holds_the_next() {
        let repo = Repo::new();
        let (store, run, first) = setup(&repo, WorkspaceMode::Mission);
        let second = super::super::tests::task(&store, &run, vec![]);
        let wave = |store: &OrchestrationStore| {
            let snapshot = store.snapshot(Some(&run.id)).unwrap();
            let run = snapshot.runs[0].clone();
            automation::ready_wave(&snapshot, &run)
                .into_iter()
                .map(|t| t.id)
                .collect::<Vec<_>>()
        };
        // Two ready writers: the wave takes one, not both.
        assert_eq!(wave(&store).len(), 1);
        let one = prepare(&store, &first, Access::Auto).unwrap();
        assert!(
            wave(&store).is_empty(),
            "the second writer waits while the first works"
        );
        // Started by hand anyway, it is refused before an attempt exists, so
        // the task stays ready for its turn instead of failing.
        let refused = prepare_from(&store, &second, Access::Auto, "").unwrap_err();
        assert!(refused.contains("can start when it finishes"), "{refused}");
        report(&store, &one, WorkerOutcome::Completed);
        assert_eq!(wave(&store), vec![second.id.clone()]);
        assert_eq!(prepare(&store, &second, Access::Auto).unwrap().cwd, one.cwd);
    }

    #[test]
    fn closing_waits_for_the_merge_then_removes_the_worktree_and_local_branch() {
        let repo = Repo::new();
        repo.remote();
        let (store, run, task) = setup(&repo, WorkspaceMode::Mission);
        let one = prepare(&store, &task, Access::Auto).unwrap();
        repo.commit(&one.cwd, "feature.txt", "done");
        report(&store, &one, WorkerOutcome::Completed);

        let refused = close(&store, &run, false).unwrap_err();
        assert!(refused.contains("not merged"), "{refused}");
        assert!(
            Path::new(&one.cwd).exists(),
            "a refused close removes nothing"
        );
        let refreshed = store.refresh_mission("chat:master", &run.id).unwrap();
        assert!(!refreshed.mission_delivery[0].merged);

        // The lead fast-forwards the base and pushes it; no PR, branch never pushed.
        repo.git(&["merge", "--ff-only", &one.branch]);
        repo.git(&["push", "origin", "main"]);
        assert!(
            store
                .refresh_mission("chat:master", &run.id)
                .unwrap()
                .mission_delivery[0]
                .merged
        );

        let closed = close(&store, &run, false).unwrap();
        assert_eq!(closed.status, RunStatus::Closed);
        assert!(!closed.abandoned && closed.closed_at.is_some());
        assert!(closed.mission_delivery[0].removed && closed.mission_delivery[0].branch_deleted);
        assert!(!Path::new(&one.cwd).exists());
        assert!(repo.git(&["branch", "--list", &one.branch]).is_empty());
        assert_eq!(
            stored(&store, &task).workspace.unwrap().state,
            WorkspaceState::Cleaned
        );
        // Closed is closed: new work is a new mission.
        let again = store.create_task(
            "chat:master",
            run.id.clone(),
            "More".into(),
            "More".into(),
            vec![],
            None,
            None,
        );
        assert!(again.unwrap_err().contains("closed"));
    }

    #[test]
    fn abandoning_keeps_the_branch_and_never_drops_unpublished_commits() {
        let repo = Repo::new();
        repo.remote();
        let (store, run, task) = setup(&repo, WorkspaceMode::Mission);
        let one = prepare(&store, &task, Access::Auto).unwrap();
        let head = repo.commit(&one.cwd, "draft.txt", "half done");
        report(&store, &one, WorkerOutcome::Completed);
        let refused = close(&store, &run, true).unwrap_err();
        assert!(refused.contains("Push"), "{refused}");
        assert!(Path::new(&one.cwd).exists());

        crate::git_ops::workflow::tests::push_branch(&one.cwd, &one.branch);
        let closed = close(&store, &run, true).unwrap();
        assert_eq!(closed.status, RunStatus::Closed);
        assert!(closed.abandoned);
        assert!(!closed.mission_delivery[0].branch_deleted);
        assert!(!Path::new(&one.cwd).exists());
        assert_eq!(repo.git(&["rev-parse", &one.branch]), head);
    }

    #[test]
    fn a_task_cannot_clean_up_the_worktree_its_mission_shares() {
        let repo = Repo::new();
        let (store, _, task) = setup(&repo, WorkspaceMode::Mission);
        let one = prepare(&store, &task, Access::Auto).unwrap();
        report(&store, &one, WorkerOutcome::Completed);
        let head = repo.git(&["rev-parse", &one.branch]);
        let refused = store
            .cleanup_workspace(
                &ChatManager::default(),
                "chat:master",
                &task.id,
                true,
                &head,
            )
            .unwrap_err();
        assert!(refused.contains("Close the mission"), "{refused}");
        assert!(Path::new(&one.cwd).exists());
    }

    /// What `chat_complete_preview` reads: the runs a chat coordinates, and
    /// whether Close would go through, without changing or fetching anything.
    #[test]
    fn a_coordinators_runs_say_when_their_mission_can_be_closed() {
        let repo = Repo::new();
        repo.remote();
        let (store, run, task) = setup(&repo, WorkspaceMode::Mission);
        let only = |store: &OrchestrationStore| {
            let mut runs = store.coordinated_runs("chat:master").unwrap();
            assert_eq!(runs.len(), 1);
            runs.remove(0)
        };
        assert!(store
            .coordinated_runs("chat:someone-else")
            .unwrap()
            .is_empty());

        // A worker is on it: live, and Close says so in its own words.
        let one = prepare(&store, &task, Access::Auto).unwrap();
        let working = only(&store);
        assert_eq!(working.run_id, run.id);
        assert!(working.live && working.mission);
        assert_eq!(working.workers_running, 1);
        assert!(!working.close_eligible);
        assert!(working
            .close_blocker
            .unwrap()
            .contains("settle every worker"));

        // Settled, with a file nobody committed.
        std::fs::write(Path::new(&one.cwd).join("scratch.txt"), "left behind").unwrap();
        report(&store, &one, WorkerOutcome::Completed);
        let dirty = only(&store);
        assert_eq!(dirty.workers_running, 0);
        assert!(dirty.close_blocker.unwrap().contains("uncommitted"));

        // Committed, but nothing has asked git about the merge yet.
        repo.commit(&one.cwd, "feature.txt", "done");
        std::fs::remove_file(Path::new(&one.cwd).join("scratch.txt")).unwrap();
        let unasked = only(&store);
        assert!(unasked
            .close_blocker
            .unwrap()
            .contains("Refresh the mission"));

        // Merged and refreshed: eligible, and nothing was removed by asking.
        repo.git(&["merge", "--ff-only", &one.branch]);
        repo.git(&["push", "origin", "main"]);
        store.refresh_mission("chat:master", &run.id).unwrap();
        let ready = only(&store);
        assert!(ready.close_eligible, "{:?}", ready.close_blocker);
        assert_eq!(ready.close_blocker, None);
        assert!(Path::new(&one.cwd).exists());

        // A commit made after the refresh is not covered by it.
        repo.commit(&one.cwd, "later.txt", "more");
        assert!(!only(&store).close_eligible);

        // Stopped but not closed, a mission is still the person's to close;
        // closed, it is no longer listed.
        repo.git(&["merge", "--ff-only", &one.branch]);
        repo.git(&["push", "origin", "main"]);
        store.refresh_mission("chat:master", &run.id).unwrap();
        close(&store, &run, false).unwrap();
        assert!(store.coordinated_runs("chat:master").unwrap().is_empty());
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::git_ops::workflow::tests::Repo;
    #[test]
    fn recovery_finishes_verified_cleanup_intent_without_claiming_an_unverified_merge() {
        let repo = Repo::new();
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let task = super::super::tests::task(&store, &run, vec![]);
        let plan = workflow::plan(&repo.root, "main", &task.id, WorkspaceMode::Worktree).unwrap();
        store
            .mutate(|data| {
                data.tasks.get_mut(&task.id).unwrap().workspace = Some(TaskWorkspace {
                    plan,
                    state: WorkspaceState::Cleaning,
                    lease_attempt_id: Some("old".into()),
                    delivery: None,
                    abandoned: false,
                    cleanup_intent: Some(true),
                    validation_paths: vec![],
                });
                assert!(recover_workspaces(data));
                let task = &data.tasks[&task.id];
                assert_eq!(task.status, TaskStatus::Cancelled);
                let ws = task.workspace.as_ref().unwrap();
                assert_eq!(ws.state, WorkspaceState::Cleaned);
                assert!(ws.abandoned);
                assert!(ws.lease_attempt_id.is_none());
                Ok(())
            })
            .unwrap();
    }
    #[test]
    fn coordinator_gate_cannot_resurrect_a_settled_attempt() {
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let worker = super::super::tests::running_worker(&store, &run);
        store
            .report_worker(
                &worker.worker_chat_key,
                WorkerReport {
                    attempt_id: worker.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        assert!(store
            .create_gate(
                "chat:master",
                run.id,
                Some(worker.task_id),
                "Continue?".into(),
                vec![]
            )
            .unwrap_err()
            .contains("settled"));
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    #[test]
    fn version_one_is_migrated_and_new_records_cannot_be_silently_overwritten_by_an_old_backend() {
        let root = crate::test_dir::TestDir::new("workflow-migration");
        let path = root.join("orchestrations.json");
        std::fs::write(
            &path,
            r#"{"version":1,"runs":{},"tasks":{},"attempts":{},"gates":{},"messages":{}}"#,
        )
        .unwrap();
        let store = OrchestrationStore::load(path.clone());
        assert!(store.snapshot(None).unwrap().runs.is_empty());
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted["version"], STORE_VERSION);
    }
}

//! A mission is a run that stays open until the person closes it.
//!
//! Its tasks share one worktree per repository (`WorkspaceMode::Mission`), so
//! a follow-up lands on the branch the first task started, and "is it merged,
//! is it released" has one answer per repository instead of one per task.
//!
//! Refresh is available to the coordinator. Direct Close/Abandon remain
//! socket-only; the coordinator may propose Close on a batch card whose
//! socket answer runs this same guarded path with exact plan/HEAD bindings:
//!
//! - **Refresh** asks git where each mission worktree stands — merged into the
//!   base on its remote, and released by the project's own release check — and
//!   records it on the run. Nothing is inferred from what an agent said.
//! - **Close** ends the mission. With its work merged, the worktree goes and
//!   the local branch is deleted with `git branch -d`, which Git refuses for
//!   anything unmerged. **Abandon** ends it without the merge: the worktree
//!   goes only when every commit on it is published, and the branch is kept.
//!   Neither ever forces a removal, and the remote is never touched.
use super::workspaces::WorkspaceState;
use super::*;
use crate::git_ops::workflow::{self, DeliveryEvidence, WorkspaceMode, WorkspacePlan};

/// Where one of a mission's worktrees stands, as git last said.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionDelivery {
    pub repository_root: String,
    pub checkout_root: String,
    pub branch: String,
    pub base_branch: String,
    pub evidence: DeliveryEvidence,
    /// In the base branch: through a merged PR, or because the head is
    /// already an ancestor of the base branch's remote tip.
    pub merged: bool,
    /// `None` until merged, and whenever the project has no release check.
    #[serde(default)]
    pub released: Option<bool>,
    #[serde(default)]
    pub release_note: String,
    /// The worktree is gone: the mission was closed.
    #[serde(default)]
    pub removed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swept_at: Option<i64>,
    /// Close deleted the local branch. False when Git kept it.
    #[serde(default)]
    pub branch_deleted: bool,
}

/// The mission's own worktrees still standing, one per checkout.
pub(super) fn mission_plans(data: &Stored, run_id: &str) -> Vec<WorkspacePlan> {
    let mut seen = BTreeSet::new();
    data.tasks
        .values()
        .filter(|t| t.run_id == run_id)
        .filter_map(|t| t.workspace.as_ref())
        .filter(|ws| ws.plan.mode == WorkspaceMode::Mission && ws.plan.managed)
        .filter(|ws| ws.state != WorkspaceState::Cleaned)
        .filter(|ws| seen.insert(ws.plan.checkout_root.clone()))
        .map(|ws| ws.plan.clone())
        .collect()
}

/// Whether the record lets this mission be closed, and the worktrees a close
/// would then look at. Everything `close_mission` refuses before it asks
/// git, in its words; nothing is changed.
fn closable_plans(data: &Stored, run: &Run, abandon: bool) -> Result<Vec<WorkspacePlan>, String> {
    let run_id = run.id.as_str();
    if run.status == RunStatus::Closed {
        return Err("This mission is already closed.".into());
    }
    if data
        .attempts
        .values()
        .any(|a| a.run_id == run_id && attempt_is_unsettled(data, a))
    {
        return Err("Stop or settle every worker before closing the mission.".into());
    }
    if data
        .gates
        .values()
        .any(|g| g.run_id == run_id && g.status == GateStatus::Open)
    {
        return Err("Answer the open decision before closing the mission.".into());
    }
    if !abandon
        && data.tasks.values().any(|t| {
            t.run_id == run_id && !matches!(t.status, TaskStatus::Completed | TaskStatus::Cancelled)
        })
    {
        return Err("Some tasks are not finished. Finish them, or abandon the mission.".into());
    }
    // A task worktree from Worktree mode has its own cleanup, with its
    // own merge check per branch. Close does not do it for them.
    if data.tasks.values().any(|t| {
        t.run_id == run_id
            && t.workspace.as_ref().is_some_and(|ws| {
                ws.plan.managed
                    && ws.plan.mode == WorkspaceMode::Worktree
                    && ws.state != WorkspaceState::Cleaned
            })
    }) {
        return Err("Clean up this run's task worktrees first; each has its own branch.".into());
    }
    let plans = mission_plans(data, run_id);
    for plan in &plans {
        let holders = data.tasks.values().filter(|t| {
            t.workspace
                .as_ref()
                .is_some_and(|ws| ws.plan.checkout_root == plan.checkout_root)
        });
        for task in holders {
            let ws = task.workspace.as_ref().unwrap();
            if task.run_id != run_id && ws.state != WorkspaceState::Cleaned {
                return Err("Another run is using this mission's worktree.".into());
            }
            if !ws.validation_paths.is_empty() {
                return Err("Remove the mission's validation checkouts before closing it.".into());
            }
        }
    }
    Ok(plans)
}

/// A run a chat coordinates, as the page's Complete dialog reads it
/// (`OrchestrationStore::coordinated_runs`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinatedRun {
    pub run_id: String,
    pub status: RunStatus,
    /// The run has not ended: completing the chat asks its agent to stop it.
    pub live: bool,
    /// A mission: it stays open until the person closes it.
    pub mission: bool,
    /// Workers whose attempts have not settled.
    pub workers_running: usize,
    /// Close would go through, by everything known without the network:
    /// the record, a local `git status` of each mission worktree, and what
    /// the last `refresh_mission` said about the merge. A mission that was
    /// never refreshed is not eligible; refresh it and ask again.
    pub close_eligible: bool,
    /// Why not, when it is not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close_blocker: Option<String>,
}

/// A symlink, or on Windows any reparse point (a junction, a mount point).
fn is_redirect(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

/// `Ok(true)` only when the checkout is CONFIRMED missing: every ancestor is a
/// real directory read without following a link, and the parent, read as a
/// directory, has no entry of that name. `Ok(false)` when the path exists (a
/// folder that exists is never taken for gone). Anything else (an ancestor
/// that is absent, unreadable, a file, or a link, a dangling one included, or
/// an unmounted volume) is `Err`: not found there proves nothing about the
/// files, which may be offline and dirty, so the mission is kept. The one
/// redirect allowed is a link directly under the filesystem root, which is how
/// macOS spells `/tmp` and `/var`.
pub(super) fn confirmed_missing(path: &str) -> Result<bool, String> {
    let kept = |why: String| {
        format!("{path} is not found, but that is not confirmed: {why} The mission is kept.")
    };
    match std::fs::symlink_metadata(path) {
        Ok(_) => return Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(kept(format!("it could not be read ({e})."))),
    }
    let target = Path::new(path);
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| kept("it has no parent folder.".into()))?;
    for ancestor in parent.ancestors().filter(|a| !a.as_os_str().is_empty()) {
        let meta = std::fs::symlink_metadata(ancestor).map_err(|e| {
            kept(format!(
                "its folder {} is unavailable ({e}); the volume may be offline or the folder moved.",
                ancestor.display()
            ))
        })?;
        if is_redirect(&meta) {
            let under_root = ancestor
                .parent()
                .is_some_and(|p| p.parent().is_none() || p.as_os_str().is_empty());
            let resolves_to_dir = std::fs::metadata(ancestor).is_ok_and(|m| m.is_dir());
            if !(under_root && resolves_to_dir) {
                return Err(kept(format!(
                    "{} is a link or mount point, so the path may lead somewhere else.",
                    ancestor.display()
                )));
            }
        } else if !meta.is_dir() {
            return Err(kept(format!("{} is not a folder.", ancestor.display())));
        }
    }
    let name = target
        .file_name()
        .ok_or_else(|| kept("it has no folder name.".into()))?;
    let entries = std::fs::read_dir(parent)
        .map_err(|e| kept(format!("{} could not be listed ({e}).", parent.display())))?;
    for entry in entries {
        let entry =
            entry.map_err(|e| kept(format!("{} could not be listed ({e}).", parent.display())))?;
        if entry
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case(&name.to_string_lossy())
        {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
thread_local! {
    /// Runs once on the calling thread right after a mission's delivery has
    /// been read in `close_mission_expected` (the step that may ask a remote),
    /// with the ledger and lifecycle let go. A test uses it to change the
    /// ledger inside that window.
    pub(super) static AFTER_DELIVERY: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
thread_local! {
    /// Like `AFTER_DELIVERY`, but runs right after a root's folder and merged
    /// branch have been removed: the window before the closing write.
    pub(super) static AFTER_BRANCH_DELETE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
thread_local! {
    /// Runs once right after a swept task's saved evidence was read in
    /// `cleanup_workspace_expected`, before Cleaned is recorded.
    pub(super) static AFTER_SWEPT_EVIDENCE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
pub(super) fn after_swept_evidence() {
    if let Some(hook) = AFTER_SWEPT_EVIDENCE.with(|h| h.borrow_mut().take()) {
        hook();
    }
}
#[cfg(test)]
fn after_branch_delete() {
    if let Some(hook) = AFTER_BRANCH_DELETE.with(|h| h.borrow_mut().take()) {
        hook();
    }
}
#[cfg(test)]
fn after_delivery() {
    if let Some(hook) = AFTER_DELIVERY.with(|h| h.borrow_mut().take()) {
        hook();
    }
}

/// `Ok(false)` only with positive proof that no local branch of that name
/// exists (`lifespan::local_branch_exists`: rev-parse exit 1, no case alias,
/// no unreadable ref folder, nothing on stderr). Everything else that is not a
/// plain yes is `Err`: not being able to ask proves nothing.
pub(super) fn branch_exists(plan: &WorkspacePlan) -> Result<bool, String> {
    crate::git_ops::lifespan::local_branch_exists(&plan.repository_root, &plan.branch)
}

/// A swept TASK worktree whose branch is gone as well (a release's cleanup
/// deleted the merged branch). `Ok(true)` only when the folder is confirmed
/// missing, the branch is proven absent and the saved delivery was recorded
/// merged, clean, with a head: nothing physical is left, the record answers.
/// `Ok(false)` when the branch is still there (the normal swept path decides).
/// Anything that cannot be confirmed, or a gone branch with no recorded merge,
/// is `Err` with a sentence: the task is kept.
pub(super) fn swept_task_branch_gone(
    ws: &super::workspaces::TaskWorkspace,
) -> Result<bool, String> {
    let kept = |why: String| {
        format!("This workspace was swept; its kept branch cannot be verified. Restore the branch before Cleanup: {why}")
    };
    if branch_exists(&ws.plan).map_err(kept)? {
        return Ok(false);
    }
    if !confirmed_missing(&ws.plan.checkout_root).map_err(kept)? {
        return Err(kept(format!(
            "the folder {} is there again, so this is not a swept workspace",
            ws.plan.checkout_root
        )));
    }
    match ws
        .delivery
        .as_ref()
        .filter(|d| d.merged && !d.dirty && !d.head_sha.is_empty())
    {
        Some(_) => Ok(true),
        None => Err(format!(
            "The folder {} and the branch {} are both gone, and no clean merge into {} was ever recorded for this task, so it is not known to be merged. The task is kept.",
            ws.plan.checkout_root, ws.plan.branch, ws.plan.base_branch
        )),
    }
}

/// What a card records of each root, and the answer compares again: whether
/// the folder and the branch were there. A change either way keeps the item.
pub(super) fn presence(plan: &WorkspacePlan) -> Result<(bool, bool), String> {
    Ok((
        !confirmed_missing(&plan.checkout_root)?,
        branch_exists(plan)?,
    ))
}

/// The folder and the local branch are both gone (the sweep removed the folder,
/// a release's merged-branch cleanup removed the branch). Nothing physical is
/// left to remove, so the recorded delivery answers for it, but only a delivery
/// that was recorded as merged: a merge is never guessed from a missing ref.
/// The answer is the saved delivery as it is: `removed` and `branch_deleted`
/// are what a Close records, never what asking about a close does.
fn gone_branch_delivery(
    known: Option<&MissionDelivery>,
    plan: &WorkspacePlan,
) -> Result<MissionDelivery, String> {
    match known.filter(|k| k.merged && !k.evidence.head_sha.is_empty()) {
        Some(known) => Ok(known.clone()),
        None => Err(format!(
            "The folder {} and the branch {} are both gone, and no merge into {} was ever recorded for it, so it is not known to be merged. The mission is kept.",
            plan.checkout_root, plan.branch, plan.base_branch
        )),
    }
}

/// A folder that is gone has no working tree to inspect, so nothing in it can
/// be at stake: whether the sweep removed it or it vanished some other way, its
/// kept branch and the last saved delivery still answer for it, and it is
/// never recreated to draw the page. With no saved delivery at all the branch
/// alone says where it stands. A branch that is gone as well answers from the
/// saved delivery only when that was recorded merged (`gone_branch_delivery`).
/// A folder that exists is never taken for swept.
pub(super) fn swept_delivery(
    run: &Run,
    plan: &WorkspacePlan,
) -> Result<Option<MissionDelivery>, String> {
    if !confirmed_missing(&plan.checkout_root)? {
        return Ok(None);
    }
    let known = run
        .mission_delivery
        .iter()
        .find(|d| d.checkout_root == plan.checkout_root);
    if !branch_exists(plan)? {
        return gone_branch_delivery(known, plan).map(Some);
    }
    let head = crate::git_ops::lifespan::text(
        &plan.repository_root,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/heads/{}^{{commit}}", plan.branch),
        ],
    )?;
    let same = known.is_some_and(|k| k.evidence.head_sha == head);
    let mut delivery = known.cloned().unwrap_or_else(|| MissionDelivery {
        repository_root: plan.repository_root.clone(),
        checkout_root: plan.checkout_root.clone(),
        branch: plan.branch.clone(),
        base_branch: plan.base_branch.clone(),
        evidence: DeliveryEvidence::default(),
        merged: false,
        released: None,
        release_note: String::new(),
        removed: false,
        swept_at: None,
        branch_deleted: false,
    });
    delivery.swept_at = delivery.swept_at.or(Some(now_ms()));
    delivery.evidence.head_sha = head.clone();
    delivery.evidence.dirty = false;
    delivery.evidence.has_commits = head != plan.base_sha;
    delivery.evidence.checked_at = now_ms();
    delivery.merged = !delivery.evidence.has_commits || same && known.is_some_and(|k| k.merged);
    delivery.evidence.merged = delivery.merged;
    if !same {
        delivery.evidence.pushed = false;
        delivery.released = None;
        delivery.release_note.clear();
    }
    Ok(Some(delivery))
}

/// `closing` is a Close's own read: it may stamp what only a Close records
/// (`swept_at` of a folder that is gone). A refresh, and so the ask for a
/// cleanup card, writes nothing of that kind: a card is a proposal.
fn delivery_of(run: &Run, plan: &WorkspacePlan, closing: bool) -> Result<MissionDelivery, String> {
    if confirmed_missing(&plan.checkout_root)? && !branch_exists(plan)? {
        let known = run
            .mission_delivery
            .iter()
            .find(|d| d.checkout_root == plan.checkout_root);
        let mut delivery = gone_branch_delivery(known, plan)?;
        if closing {
            delivery.swept_at = delivery.swept_at.or(Some(now_ms()));
        }
        return Ok(delivery);
    }
    if let Some(mut delivery) = swept_delivery(run, plan)? {
        delivery.merged |=
            workflow::merged_into_remote_base(plan, &delivery.evidence.head_sha) == Some(true);
        delivery.evidence.merged = delivery.merged;
        delivery.evidence.pushed = false;
        if let (Ok(remote), Ok(branch)) = (
            crate::git_ops::lifespan::text(
                &plan.repository_root,
                &["config", "--get", &format!("branch.{}.remote", plan.branch)],
            ),
            crate::git_ops::lifespan::text(
                &plan.repository_root,
                &["config", "--get", &format!("branch.{}.merge", plan.branch)],
            ),
        ) {
            if remote != "." && !remote.starts_with('-') && branch.starts_with("refs/heads/") {
                delivery.evidence.pushed = crate::git_ops::lifespan::text(
                    &plan.repository_root,
                    &["ls-remote", "--exit-code", &remote, &branch],
                )
                .is_ok_and(|tip| {
                    tip.split_whitespace().next() == Some(delivery.evidence.head_sha.as_str())
                });
            }
        }
        return Ok(delivery);
    }
    let evidence = workflow::inspect(plan, true)?;
    // Nothing committed is nothing to merge: the base already holds it all.
    let merged = evidence.merged
        || !evidence.has_commits
        || workflow::merged_into_remote_base(plan, &evidence.head_sha) == Some(true);
    let (released, release_note) = if merged && evidence.has_commits {
        crate::chat_task::release_status(
            &run.workspace_id,
            &plan.repository_root,
            &evidence.head_sha,
        )
    } else {
        (None, String::new())
    };
    Ok(MissionDelivery {
        repository_root: plan.repository_root.clone(),
        checkout_root: plan.checkout_root.clone(),
        branch: plan.branch.clone(),
        base_branch: plan.base_branch.clone(),
        evidence,
        merged,
        released,
        release_note,
        removed: false,
        swept_at: None,
        branch_deleted: false,
    })
}

/// Why a mission whose record allows a close would still be refused, from a
/// local look at its worktrees and the merge the last refresh recorded.
fn close_blocker(run: &Run, plans: &[WorkspacePlan]) -> Option<String> {
    for plan in plans {
        match swept_delivery(run, plan) {
            Ok(Some(delivery)) => {
                if delivery.merged {
                    continue;
                }
                return Some(format!(
                    "{} is not known to be merged into {}. Refresh the mission to ask git.",
                    plan.branch, plan.base_branch
                ));
            }
            Ok(None) => {}
            Err(error) => return Some(error),
        }
        let evidence = match workflow::inspect(plan, false) {
            Ok(evidence) => evidence,
            Err(error) => return Some(error),
        };
        if evidence.dirty {
            return Some(format!(
                "{} has uncommitted or untracked files. Commit or move them before closing.",
                plan.checkout_root
            ));
        }
        let merged = !evidence.has_commits
            || run.mission_delivery.iter().any(|known| {
                known.checkout_root == plan.checkout_root
                    && known.merged
                    && known.evidence.head_sha == evidence.head_sha
            });
        if !merged {
            return Some(format!(
                "{} is not known to be merged into {}. Refresh the mission to ask git.",
                plan.branch, plan.base_branch
            ));
        }
    }
    None
}

impl OrchestrationStore {
    /// The runs `chat_key` coordinates that still have something to do: one
    /// that has not ended, or a mission the person has not closed. Read-only,
    /// and never on the network.
    pub fn coordinated_runs(&self, chat_key: &str) -> Result<Vec<CoordinatedRun>, String> {
        let found: Vec<(Run, usize, Result<Vec<WorkspacePlan>, String>)> = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            if let Some(error) = &inner.load_error {
                return Err(error.clone());
            }
            let data = &inner.data;
            let mut runs: Vec<&Run> = data
                .runs
                .values()
                .filter(|run| run.coordinator_chat_key == chat_key)
                .filter(|run| {
                    !run_has_ended(run)
                        || (run.workspace_mode == WorkspaceMode::Mission
                            && run.status != RunStatus::Closed)
                })
                .collect();
            runs.sort_by_key(|run| run.created_at);
            runs.into_iter()
                .map(|run| {
                    let workers = data
                        .attempts
                        .values()
                        .filter(|a| a.run_id == run.id && attempt_is_unsettled(data, a))
                        .count();
                    (run.clone(), workers, closable_plans(data, run, false))
                })
                .collect()
        };
        Ok(found
            .into_iter()
            .map(|(run, workers_running, plans)| {
                let mission = run.workspace_mode == WorkspaceMode::Mission;
                let close_blocker = match plans {
                    _ if !mission => Some("This run is not a mission.".to_string()),
                    Ok(plans) => close_blocker(&run, &plans),
                    Err(refused) => Some(refused),
                };
                CoordinatedRun {
                    live: !run_has_ended(&run),
                    mission,
                    workers_running,
                    close_eligible: close_blocker.is_none(),
                    close_blocker,
                    status: run.status,
                    run_id: run.id,
                }
            })
            .collect())
    }

    /// Ask git where each of the mission's worktrees stands, and record it.
    pub fn refresh_mission(&self, actor: &str, run_id: &str) -> Result<Run, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let (run, plans) = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            if let Some(error) = &inner.load_error {
                return Err(error.clone());
            }
            let run = coordinator(&inner.data, run_id, actor)?.clone();
            (run.clone(), mission_plans(&inner.data, run_id))
        };
        if run.status == RunStatus::Closed {
            return Ok(run);
        }
        let deliveries = plans
            .iter()
            .map(|plan| delivery_of(&run, plan, false))
            .collect::<Result<Vec<_>, _>>()?;
        self.mutate(|data| {
            let run = data.runs.get_mut(run_id).ok_or("The run does not exist.")?;
            run.mission_delivery = deliveries;
            run.updated_at = now_ms();
            Ok(run.clone())
        })
        .inspect(|run| announce(&run.id, "mission_refreshed"))
    }

    /// End the mission. See the module note for what each ending removes.
    pub fn close_mission(
        &self,
        chats: &ChatManager,
        actor: &str,
        run_id: &str,
        abandon: bool,
    ) -> Result<Run, String> {
        self.close_mission_expected(chats, actor, run_id, abandon, None, false)
    }

    pub(super) fn close_mission_expected(
        &self,
        chats: &ChatManager,
        actor: &str,
        run_id: &str,
        abandon: bool,
        expected: Option<&[super::cleanup_request::Worktree]>,
        require_finished: bool,
    ) -> Result<Run, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let (plans_before, workers_before) = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            let run = coordinator(&inner.data, run_id, actor)?;
            (
                closable_plans(&inner.data, run, abandon)?,
                inner
                    .data
                    .attempts
                    .values()
                    .filter(|a| a.run_id == run_id)
                    .map(|a| a.worker_chat_key.clone())
                    .collect::<Vec<_>>(),
            )
        };
        if let Some(expected) = expected {
            super::cleanup_request::same_plans(expected, &plans_before)?;
        }
        for key in workers_before {
            crate::agent_chat::chat_stop_impl(chats, key)?;
        }
        let paths = plans_before
            .iter()
            .map(|p| p.checkout_root.as_str())
            .collect::<Vec<_>>();
        let _holds = crate::worktree_lifespan::hold_removals(chats, &paths)?;
        drop(_operation);
        let proofs = plans_before
            .iter()
            .map(|p| crate::worktree_lifespan::validation_removal_proof(&p.checkout_root))
            .collect::<Result<Vec<_>, _>>()?;
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let (run, plans, workers) = self.mutate(|data| {
            let run = coordinator(data, run_id, actor)?.clone();
            let plans = closable_plans(data, &run, abandon)?;
            if serde_json::to_value(&plans).map_err(|e| e.to_string())?
                != serde_json::to_value(&plans_before).map_err(|e| e.to_string())?
            {
                return Err(
                    "Mission ownership changed during Restore comparison; folders kept.".into(),
                );
            }
            if let Some(expected) = expected {
                super::cleanup_request::same_plans(expected, &plans)?;
            }
            if require_finished {
                // Decided in the step that marks every checkout Cleaning:
                // the proofs ran without the ledger.
                super::cleanup_request::require_run_finished(data, run_id)?;
            }
            for plan in &plans {
                chats.require_lifespan_idle(&plan.checkout_root)?;
            }
            let workers: Vec<String> = data
                .attempts
                .values()
                .filter(|a| a.run_id == run_id)
                .map(|a| a.worker_chat_key.clone())
                .collect();
            for task in data.tasks.values_mut().filter(|t| t.run_id == run_id) {
                if let Some(ws) = task.workspace.as_mut().filter(|ws| {
                    plans
                        .iter()
                        .any(|p| p.checkout_root == ws.plan.checkout_root)
                }) {
                    ws.state = WorkspaceState::Cleaning;
                    ws.cleanup_intent = Some(abandon);
                }
            }
            Ok((run, plans, workers))
        })?;

        // What happened to each root is kept here as it happens, so a later
        // refusal (a gate that opened after the branch was deleted) still
        // leaves its facts to be recorded: they are about Git, not the run.
        let mut done: Vec<MissionDelivery> = Vec::new();
        // What each root was when this Close looked at it: folder present,
        // branch present. Looked at again right before anything is recorded.
        let mut seen_roots: Vec<(usize, (bool, bool))> = Vec::new();
        let mut moved_roots: BTreeSet<String> = BTreeSet::new();
        let outcome = (|| -> Result<(), String> {
            for key in &workers {
                crate::agent_chat::chat_stop_impl(chats, key.clone())?;
            }
            for (index, (plan, proof)) in plans.iter().zip(&proofs).enumerate() {
                chats.require_checkout_idle(&plan.checkout_root, plan.is_managed_worktree())?;
                let seen = presence(plan)?;
                seen_roots.push((index, seen));
                let mut delivery = delivery_of(&run, plan, true)?;
                #[cfg(test)]
                after_delivery();
                if let Some(expected) = expected {
                    let approved = expected
                        .iter()
                        .find(|w| w.path == plan.checkout_root)
                        .ok_or("Mission workspace was not on the approved card; folder kept.")?;
                    if approved.head_commit != delivery.evidence.head_sha {
                        return Err(
                            "HEAD changed since the approved mission card; folder kept.".into()
                        );
                    }
                }
                if delivery.evidence.dirty {
                    return Err(format!(
                        "{} has uncommitted or untracked files. Commit or move them before closing.",
                        plan.checkout_root
                    ));
                }
                if !abandon && !delivery.merged {
                    return Err(format!(
                        "{} is not merged into {} yet. Merge it first, or abandon the mission.",
                        plan.branch, plan.base_branch
                    ));
                }
                if abandon
                    && !delivery.merged
                    && delivery.evidence.has_commits
                    && !delivery.evidence.pushed
                {
                    return Err(format!(
                        "Push {} before abandoning: closing never discards commits.",
                        plan.branch
                    ));
                }
                // The automatic sweep already removed this physical folder.
                // Close/Abandon still verify its kept head and remain the
                // person's decision; neither needs to resurrect a clean tree.
                // Whether or not a folder is removed here, a named close is
                // decided against the ledger as it is now, after all Git and
                // network work above and before every step that cannot be
                // undone (the folder, then the branch).
                if require_finished {
                    self.require_named_run_finished(run_id)?;
                }
                if delivery.swept_at.is_none() || Path::new(&plan.checkout_root).exists() {
                    chats.require_lifespan_idle(&plan.checkout_root)?;
                    workflow::cleanup_verified(plan, &delivery.evidence.head_sha, proof.as_ref())?;
                }
                delivery.removed = true;
                let merged = delivery.merged;
                // Recorded before the branch step: the folder is already gone.
                done.push(delivery);
                if merged {
                    if require_finished {
                        self.require_named_run_finished(run_id)?;
                    }
                    let deleted = workflow::delete_merged_branch(plan)?;
                    // A branch that was already gone (deleted by a release's
                    // cleanup) is deleted all the same; git refusing `-d` is
                    // told apart from it by asking whether the ref is there.
                    let deleted = deleted || !branch_exists(plan).unwrap_or(true);
                    if let Some(last) = done.last_mut() {
                        last.branch_deleted = deleted;
                    }
                }
                #[cfg(test)]
                after_branch_delete();
            }
            // A mission with no checkout reads no delivery: the window is
            // here, after every Git call and before the closing write.
            #[cfg(test)]
            after_delivery();
            // A root that was gone when it was looked at is recorded removed
            // on that look alone, so it must still be gone now: a folder or a
            // branch made again since is not something this Close removed.
            // Roots this Close removes itself are not asked.
            for (index, (folder, branch)) in &seen_roots {
                let plan = &plans[*index];
                let moved = (!folder && !confirmed_missing(&plan.checkout_root)?)
                    || (!branch && branch_exists(plan)?);
                if moved {
                    moved_roots.insert(plan.checkout_root.clone());
                }
            }
            if let Some(root) = moved_roots.iter().next() {
                return Err(format!(
                    "The folder or the branch of {root} appeared or went since this Close looked at it; the mission is kept. Ask again."
                ));
            }
            Ok(())
        })();

        done.retain(|d| !moved_roots.contains(&d.checkout_root));
        let result = self.mutate(|data| {
            // The write that closes the mission decides again, under the
            // ledger: a run that became active again is never marked Closed.
            let activated = match (&outcome, require_finished) {
                (Ok(_), true) => super::cleanup_request::require_run_finished(data, run_id).err(),
                _ => None,
            };
            let outcome_ok = outcome.is_ok() && activated.is_none();
            let removed: BTreeSet<String> = match &outcome {
                Ok(()) if activated.is_none() => {
                    done.iter().map(|d| d.checkout_root.clone()).collect()
                }
                _ => plans
                    .iter()
                    .filter(|p| !Path::new(&p.checkout_root).exists())
                    .map(|p| p.checkout_root.clone())
                    .collect(),
            };
            for task in data.tasks.values_mut().filter(|t| t.run_id == run_id) {
                let mut cancel = false;
                if let Some(ws) = task.workspace.as_mut() {
                    if ws.state == WorkspaceState::Cleaning {
                        ws.cleanup_intent = None;
                        if removed.contains(&ws.plan.checkout_root) {
                            ws.state = WorkspaceState::Cleaned;
                            ws.lease_attempt_id = None;
                            ws.abandoned = abandon;
                        } else {
                            ws.state = WorkspaceState::Retained;
                        }
                    }
                }
                if outcome_ok
                    && abandon
                    && !matches!(task.status, TaskStatus::Completed | TaskStatus::Cancelled)
                {
                    cancel = true;
                }
                if cancel {
                    task.status = TaskStatus::Cancelled;
                    task.result = Some("The mission was abandoned.".into());
                    task.updated_at = now_ms();
                }
            }
            let run = data.runs.get_mut(run_id).ok_or("The run does not exist.")?;
            if outcome_ok {
                run.status = RunStatus::Closed;
                run.closed_at = Some(now_ms());
                run.abandoned = abandon;
                run.mission_delivery = done.clone();
            } else {
                // Not Closed, but the folders and branches that went are
                // facts: record them per root over the older delivery, and
                // leave every root that was not reached as it was.
                for fact in &done {
                    match run
                        .mission_delivery
                        .iter_mut()
                        .find(|known| known.checkout_root == fact.checkout_root)
                    {
                        Some(known) => *known = fact.clone(),
                        None => run.mission_delivery.push(fact.clone()),
                    }
                }
            }
            run.updated_at = now_ms();
            Ok((run.clone(), activated))
        })?;
        let (result, activated) = result;
        if let Some(reason) = activated {
            return Err(reason);
        }
        announce(run_id, "mission_closed");
        outcome.map(|_| result)
    }
}

#[cfg(test)]
mod confirmed_missing_tests {
    use super::confirmed_missing;
    use crate::test_dir::TestDir;

    fn p(path: &std::path::Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn a_folder_that_is_listed_as_absent_in_a_real_parent_is_confirmed_missing() {
        let dir = TestDir::new("confirmed-missing");
        assert_eq!(confirmed_missing(&p(&dir.join("gone"))), Ok(true));
        std::fs::create_dir(dir.join("here")).unwrap();
        assert_eq!(confirmed_missing(&p(&dir.join("here"))), Ok(false));
    }

    #[test]
    fn an_ancestor_that_moved_away_is_not_confirmed() {
        let dir = TestDir::new("confirmed-missing");
        let path = dir.join("container").join("checkout");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::rename(dir.join("container"), dir.join("moved")).unwrap();
        let error = confirmed_missing(&p(&path)).unwrap_err();
        assert!(error.contains("not confirmed"), "{error}");
        assert!(error.contains("unavailable"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_ancestor_link_is_not_confirmed() {
        let dir = TestDir::new("confirmed-missing");
        std::os::unix::fs::symlink(dir.join("offline-volume"), dir.join("container")).unwrap();
        let error = confirmed_missing(&p(&dir.join("container").join("checkout"))).unwrap_err();
        assert!(error.contains("not confirmed"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn a_live_ancestor_link_is_a_redirect_and_is_not_confirmed() {
        let dir = TestDir::new("confirmed-missing");
        std::fs::create_dir(dir.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(dir.join("elsewhere"), dir.join("container")).unwrap();
        let error = confirmed_missing(&p(&dir.join("container").join("checkout"))).unwrap_err();
        assert!(error.contains("link or mount point"), "{error}");
    }

    #[test]
    fn a_file_in_place_of_the_parent_is_not_confirmed() {
        let dir = TestDir::new("confirmed-missing");
        std::fs::write(dir.join("container"), b"x").unwrap();
        assert!(confirmed_missing(&p(&dir.join("container").join("checkout"))).is_err());
    }
}

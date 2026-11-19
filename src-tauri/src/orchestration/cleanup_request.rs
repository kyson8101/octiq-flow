//! A coordinator may propose one exact batch; only the person's socket answers.
//! Any person's chat may propose the same batch for FINISHED runs it names
//! (`runIds`). Who proposes never changes what is removed: every item still
//! goes through the run's own Cleanup / Close guards on the person's answer.
//! Pending consent is host memory, never tool-supplied removal authority.
use super::workspaces::WorkspaceState;
use super::*;
use crate::git_ops::workflow::{WorkspaceMode, WorkspacePlan};
use tokio::sync::oneshot;

pub const EVENT: &str = "orchestration-workspace-cleanup-request";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub branch: String,
    pub path: String,
    pub head_commit: String,
    pub base_branch: String,
    pub ignored_file_count: Option<u64>,
    #[serde(skip)]
    pub(super) plan: WorkspacePlan,
    /// Whether the folder and the local branch were there when the card was
    /// made. The answer compares again: a folder or branch that appeared or
    /// went since is a different situation from the one the person approved.
    #[serde(skip)]
    pub(super) folder_present: bool,
    #[serde(skip)]
    pub(super) branch_present: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    TaskWorktree,
    Mission,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: Kind,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub title: String,
    /// The run the item belongs to, so a card for several runs says which.
    pub run_objective: String,
    /// A mission owns all these roots together. An empty mission can close
    /// its record without removing any folder.
    pub worktrees: Vec<Worktree>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
    pub id: String,
    pub chat_key: String,
    /// The chat proposed runs it may not coordinate (`runIds`). Each item is
    /// then re-checked as finished on the answer.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub named: bool,
    pub run_ids: Vec<String>,
    pub items: Vec<Item>,
    pub processing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved: Option<bool>,
    pub results: Vec<ItemResult>,
}

pub(super) struct Pending {
    asked: Asked,
    waiter: Option<oneshot::Sender<Settled>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub id: String,
    pub status: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settled {
    pub id: String,
    pub approved: bool,
    pub items: Vec<ItemResult>,
}

pub(super) fn same_plan(expected: &WorkspacePlan, actual: &WorkspacePlan) -> Result<(), String> {
    if serde_json::to_value(expected).map_err(|e| e.to_string())?
        != serde_json::to_value(actual).map_err(|e| e.to_string())?
    {
        return Err("Workspace ownership changed since the approved card; folder kept.".into());
    }
    Ok(())
}

/// The folder and the branch must be present or absent exactly as the card
/// found them, and what is asked now must be answerable.
pub(super) fn same_presence(
    approved: &Worktree,
    plan: &WorkspacePlan,
) -> Result<(bool, bool), String> {
    let now = super::mission::presence(plan)?;
    if now != (approved.folder_present, approved.branch_present) {
        return Err(format!(
            "The folder {} or the branch {} appeared or went since the approved card; nothing was removed. Ask again.",
            plan.checkout_root, plan.branch
        ));
    }
    Ok(now)
}

pub(super) fn same_plans(expected: &[Worktree], actual: &[WorkspacePlan]) -> Result<(), String> {
    if expected.len() != actual.len() {
        return Err("Mission workspaces changed since the approved card; folders kept.".into());
    }
    for plan in actual {
        let approved = expected
            .iter()
            .find(|w| w.path == plan.checkout_root)
            .ok_or("Mission workspace was not on the approved card; folders kept.")?;
        same_plan(&approved.plan, plan)?;
        let (folder, branch) = same_presence(approved, plan)?;
        let head = if folder {
            crate::git_ops::lifespan::text(&plan.checkout_root, &["rev-parse", "HEAD"])?
        } else if !branch {
            // Folder and branch are both gone: there is no ref to read. The
            // head the card showed is the recorded merged delivery's, and
            // `close_mission_expected` compares it with that delivery again
            // right before anything is recorded.
            continue;
        } else {
            crate::git_ops::lifespan::text(
                &plan.repository_root,
                &[
                    "rev-parse",
                    "--verify",
                    &format!("refs/heads/{}^{{commit}}", plan.branch),
                ],
            )?
        };
        if head != approved.head_commit {
            return Err("HEAD changed since the approved mission card; folders kept.".into());
        }
    }
    Ok(())
}

fn worktree(plan: &WorkspacePlan, head: &str) -> Result<Worktree, String> {
    let (folder_present, branch_present) = super::mission::presence(plan)?;
    Ok(Worktree {
        branch: plan.branch.clone(),
        path: plan.checkout_root.clone(),
        head_commit: head.into(),
        base_branch: plan.base_branch.clone(),
        ignored_file_count: crate::worktree_lifespan::at_stake_ignored_count(&plan.checkout_root),
        plan: plan.clone(),
        folder_present,
        branch_present,
    })
}

#[cfg(test)]
impl OrchestrationStore {
    pub(crate) fn test_set_run_status(&self, run_id: &str, status: RunStatus) {
        self.mutate(|data| {
            data.runs.get_mut(run_id).unwrap().status = status;
            Ok(())
        })
        .unwrap();
    }
}

/// Which runs a proposal covers.
#[derive(Clone, Copy)]
pub(crate) enum Which<'a> {
    /// The runs the chat coordinates: all of them, or exactly one of them.
    Coordinated(Option<&'a str>),
    /// Finished runs the chat names, whoever coordinates them.
    Named(&'a [String]),
}

/// A named run left out of the proposal, and why.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptRun {
    pub run_id: String,
    pub reason: String,
}

#[derive(Debug)]
pub(crate) struct Scope {
    pub runs: Vec<Run>,
    pub named: bool,
    pub kept: Vec<KeptRun>,
}

pub const MAX_NAMED_RUNS: usize = 50;

/// Why a run that somebody else coordinates may not be proposed by a chat
/// that does not: it is not finished. Nothing here changes anything, and the
/// per-item guards still run on the person's answer.
fn named_blocker(data: &Stored, run: &Run) -> Option<String> {
    if !matches!(
        run.status,
        RunStatus::Completed | RunStatus::Failed | RunStatus::Stopped
    ) {
        return Some(if run.status == RunStatus::Closed {
            "This run is already closed; there is nothing to clean up.".into()
        } else {
            format!(
                "This run is {}; only a finished run (completed, failed or stopped) can be proposed from a chat that does not coordinate it.",
                format!("{:?}", run.status).to_lowercase()
            )
        });
    }
    if data
        .attempts
        .values()
        .any(|a| a.run_id == run.id && attempt_is_unsettled(data, a))
    {
        return Some("A worker is still running or waiting on this run.".into());
    }
    if data
        .gates
        .values()
        .any(|g| g.run_id == run.id && g.status == GateStatus::Open)
    {
        return Some("This run has an open decision.".into());
    }
    if data.batches.iter().any(|b| {
        b.run_id == run.id
            && matches!(
                b.status,
                super::batches::BatchStatus::Claiming | super::batches::BatchStatus::Working
            )
    }) {
        return Some("An agent batch is still claiming or working on this run.".into());
    }
    None
}

/// The final form of the named-run check: the ledger as it is now, with the
/// host's reason. Callers hold the ledger already (the step that marks a
/// checkout Cleaning) or take it for one read right before a removal.
pub(super) fn require_run_finished(data: &Stored, run_id: &str) -> Result<(), String> {
    let run = data.runs.get(run_id).ok_or("The run does not exist.")?;
    match named_blocker(data, run) {
        Some(reason) => Err(format!("{reason} Nothing was removed; folder kept.")),
        None => Ok(()),
    }
}

impl OrchestrationStore {
    /// One read of the ledger, released before the caller goes on to Git. It is
    /// the last look before a removal; see the remaining window in
    /// docs/subagent-worktree-lifecycle.md.
    pub(super) fn require_named_run_finished(&self, run_id: &str) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        require_run_finished(&inner.data, run_id)
    }

    /// Which runs a proposal covers. The caller must be a person's chat in
    /// both cases; named runs add the finished-run checks, and a run that
    /// fails them is reported, not an error, unless every run does.
    pub(crate) fn cleanup_scope(&self, actor: &str, which: Which<'_>) -> Result<Scope, String> {
        match which {
            Which::Coordinated(run_id) => Ok(Scope {
                runs: self.cleanup_request_runs(actor, run_id)?,
                named: false,
                kept: Vec::new(),
            }),
            Which::Named(ids) => {
                self.require_user_chat(actor)?;
                if ids.is_empty() || ids.len() > MAX_NAMED_RUNS {
                    return Err(format!("runIds takes 1 to {MAX_NAMED_RUNS} run ids."));
                }
                if ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
                    return Err("runIds must be distinct.".into());
                }
                let inner = self.inner.lock().map_err(|e| e.to_string())?;
                if let Some(error) = &inner.load_error {
                    return Err(error.clone());
                }
                let mut runs = Vec::new();
                let mut kept = Vec::new();
                for id in ids {
                    match inner.data.runs.get(id) {
                        None => kept.push(KeptRun {
                            run_id: id.clone(),
                            reason: "No such run.".into(),
                        }),
                        Some(run) => match named_blocker(&inner.data, run) {
                            Some(reason) => kept.push(KeptRun {
                                run_id: id.clone(),
                                reason,
                            }),
                            None => runs.push(run.clone()),
                        },
                    }
                }
                if runs.is_empty() {
                    return Err(format!(
                        "None of the named runs can be proposed: {}",
                        kept.iter()
                            .map(|k| format!("{}: {}", k.run_id, k.reason))
                            .collect::<Vec<_>>()
                            .join(" ")
                    ));
                }
                Ok(Scope {
                    runs,
                    named: true,
                    kept,
                })
            }
        }
    }

    /// The chat whose standing the existing guards check for one item of a
    /// card: the proposer for its own run, the run's coordinator for a named
    /// one. The person's answer is the authority; this only picks which
    /// recorded owner the unchanged Cleanup / Close doors compare with.
    fn cleanup_item_owner(&self, asked: &Asked, run_id: &str) -> Result<String, String> {
        if !asked.named {
            self.cleanup_request_runs(&asked.chat_key, Some(run_id))?;
            return Ok(asked.chat_key.clone());
        }
        self.require_user_chat(&asked.chat_key)?;
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let run = inner
            .data
            .runs
            .get(run_id)
            .ok_or("The run does not exist.")?;
        if let Some(reason) = named_blocker(&inner.data, run) {
            return Err(format!("{reason} Nothing was removed."));
        }
        Ok(run.coordinator_chat_key.clone())
    }

    /// Durable worker identity outlives a settled attempt. The hook separately
    /// refuses front desks and room seats before it drops its HookCaller.
    pub(crate) fn cleanup_request_runs(
        &self,
        actor: &str,
        run_id: Option<&str>,
    ) -> Result<Vec<Run>, String> {
        self.require_user_chat(actor)?;
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        if let Some(id) = run_id {
            coordinator(&inner.data, id, actor)?;
        }
        let runs: Vec<_> = inner
            .data
            .runs
            .values()
            .filter(|run| run.coordinator_chat_key == actor && run_id.is_none_or(|id| id == run.id))
            .cloned()
            .collect();
        if runs.is_empty() {
            return Err("Only the coordinator of a run may request workspace cleanup.".into());
        }
        Ok(runs)
    }

    pub fn cleanup_request_pending(&self) -> Result<Vec<Asked>, String> {
        Ok(self
            .cleanup_requests
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .map(|p| p.asked.clone())
            .collect())
    }

    /// Refresh exactly as the existing task/mission Refresh doors do. This
    /// only proposes candidates; no worker is stopped and no folder is removed.
    #[cfg(test)]
    pub(crate) fn request_workspace_cleanup(
        &self,
        chats: &ChatManager,
        actor: &str,
        run_id: Option<&str>,
        waiter: Option<oneshot::Sender<Settled>>,
    ) -> Result<Option<Asked>, String> {
        self.request_cleanup(chats, actor, Which::Coordinated(run_id), waiter)
    }

    pub(crate) fn request_cleanup(
        &self,
        chats: &ChatManager,
        actor: &str,
        which: Which<'_>,
        waiter: Option<oneshot::Sender<Settled>>,
    ) -> Result<Option<Asked>, String> {
        crate::profile::available()?;
        let Scope { runs, named, .. } = self.cleanup_scope(actor, which)?;
        // One outstanding batch per coordinator. Repeated calls cannot silently
        // replace a card whose contents the person may already be reading.
        if let Some(existing) = self
            .cleanup_request_pending()?
            .into_iter()
            .find(|p| p.chat_key == actor)
        {
            return Ok(Some(existing));
        }
        let mut items = Vec::new();
        for run in &runs {
            if run.abandoned || run.status == RunStatus::Closed {
                continue;
            }
            // The unchanged guards compare with the run's recorded owner.
            let owner = if named {
                run.coordinator_chat_key.clone()
            } else {
                actor.to_string()
            };
            let owner = owner.as_str();
            let snapshot = self.snapshot(Some(&run.id))?;
            for task in snapshot.tasks {
                let Some(_ws) = task.workspace.as_ref().filter(|ws| {
                    ws.state == WorkspaceState::Retained
                        && !ws.abandoned
                        && ws.plan.managed
                        && ws.plan.mode == WorkspaceMode::Worktree
                }) else {
                    continue;
                };
                if self.refresh_workspace(owner, &task.id).is_err()
                    && self.refresh_swept_cleanup_task(owner, &task.id).is_err()
                {
                    continue;
                }
                let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
                let (_, task) = self.owned_task(owner, &task.id)?;
                let ws = task.workspace.as_ref().ok_or("Workspace disappeared.")?;
                {
                    let inner = self.inner.lock().map_err(|e| e.to_string())?;
                    if super::workspaces::cleanup_ready(&inner.data, &task, ws, false).is_err() {
                        continue;
                    }
                }
                let Some(evidence) = ws.delivery.as_ref().filter(|e| e.merged && !e.dirty) else {
                    continue;
                };
                drop(_operation);
                if chats.require_lifespan_idle(&ws.plan.checkout_root).is_err() {
                    continue;
                }
                let Ok(tree) = worktree(&ws.plan, &evidence.head_sha) else {
                    continue;
                };
                // The same ignored-file guard would refuse these. Unknown is
                // not permission; swept roots may have no inventory anymore.
                if ws.swept_at.is_none() && tree.ignored_file_count != Some(0) {
                    continue;
                }
                if crate::worktree_lifespan::validation_removal_proof(&ws.plan.checkout_root)
                    .is_err()
                {
                    continue;
                }
                items.push(Item {
                    id: format!("task:{}", task.id),
                    kind: Kind::TaskWorktree,
                    run_id: run.id.clone(),
                    task_id: Some(task.id.clone()),
                    title: task.title,
                    run_objective: run.objective.clone(),
                    worktrees: vec![tree],
                });
            }
            if run.workspace_mode != WorkspaceMode::Mission
                || self.refresh_mission(owner, &run.id).is_err()
            {
                continue;
            }
            if !self
                .coordinated_runs(owner)?
                .iter()
                .any(|r| r.run_id == run.id && r.close_eligible)
            {
                continue;
            }
            let (run, plans) = {
                let inner = self.inner.lock().map_err(|e| e.to_string())?;
                let run = coordinator(&inner.data, &run.id, owner)?.clone();
                let plans = super::mission::mission_plans(&inner.data, &run.id);
                (run, plans)
            };
            let trees: Option<Vec<_>> = plans
                .iter()
                .map(|plan| {
                    if chats.require_lifespan_idle(&plan.checkout_root).is_err() {
                        return None;
                    }
                    let delivery = run
                        .mission_delivery
                        .iter()
                        .find(|d| d.checkout_root == plan.checkout_root)?;
                    worktree(plan, &delivery.evidence.head_sha).ok()
                })
                .collect();
            if let Some(worktrees) = trees {
                items.push(Item {
                    id: format!("mission:{}", run.id),
                    kind: Kind::Mission,
                    run_id: run.id,
                    task_id: None,
                    title: run.objective.clone(),
                    run_objective: run.objective,
                    worktrees,
                });
            }
        }
        crate::profile::available()?;
        if items.is_empty() {
            return Ok(None);
        }
        let asked = Asked {
            id: format!("cleanup_{}", compact_id()),
            chat_key: actor.into(),
            named,
            run_ids: runs.into_iter().map(|r| r.id).collect(),
            items,
            processing: false,
            approved: None,
            results: Vec::new(),
        };
        let mut pending = self.cleanup_requests.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = pending.values().find(|p| p.asked.chat_key == actor) {
            return Ok(Some(existing.asked.clone()));
        }
        pending.insert(
            asked.id.clone(),
            Pending {
                asked: asked.clone(),
                waiter,
            },
        );
        drop(pending);
        crate::bus::emit(
            EVENT,
            &json!({ "state": "appeared", "id": asked.id, "request": asked }),
        );
        Ok(Some(asked))
    }

    /// A swept task cannot be inspected in a working tree. Refresh its
    /// exact kept HEAD against the current base as Cleanup itself does,
    /// without resurrecting a folder or trusting stale merged evidence.
    fn refresh_swept_cleanup_task(&self, actor: &str, task_id: &str) -> Result<(), String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let (_, task) = self.owned_task(actor, task_id)?;
        let ws = task.workspace.as_ref().ok_or("No workspace.")?;
        if ws.swept_at.is_none()
            || !matches!(fs::symlink_metadata(&ws.plan.checkout_root), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        {
            return Err("Only an already swept workspace can refresh its kept branch.".into());
        }
        let mut saved = ws
            .delivery
            .clone()
            .ok_or("The swept workspace has no saved delivery evidence.")?;
        if super::mission::swept_task_branch_gone(ws)? {
            // Nothing is left to read: the recorded merged delivery stands.
            return Ok(());
        }
        let head = crate::git_ops::lifespan::text(
            &ws.plan.repository_root,
            &[
                "rev-parse",
                "--verify",
                &format!("refs/heads/{}^{{commit}}", ws.plan.branch),
            ],
        )?;
        if head != saved.head_sha || saved.dirty {
            return Err(
                "Swept delivery evidence changed; restore and refresh before Cleanup.".into(),
            );
        }
        let base = crate::git_ops::lifespan::text(
            &ws.plan.repository_root,
            &[
                "rev-parse",
                "--verify",
                &format!("refs/heads/{}^{{commit}}", ws.plan.base_branch),
            ],
        )?;
        crate::git_ops::lifespan::git(
            &ws.plan.repository_root,
            &["merge-base", "--is-ancestor", &head, &base],
        )?;
        saved.merged = true;
        saved.checked_at = now_ms();
        self.mutate(|data| {
            data.tasks
                .get_mut(task_id)
                .ok_or("Task disappeared.")?
                .workspace
                .as_mut()
                .ok_or("Workspace disappeared.")?
                .delivery = Some(saved);
            Ok(())
        })
    }

    pub(crate) fn cleanup_notice(
        &self,
        actor: &str,
        run_id: &str,
        source: String,
        body: String,
    ) -> Result<(), String> {
        self.mutate_regardless("the cleanup notification", |data| {
            inbox::enqueue(
                data,
                run_id,
                "host",
                actor,
                source,
                "workspace_cleanup",
                body,
            );
            Ok(())
        })
    }

    /// Socket only. Answer exactly the host-held items, never a caller's ids,
    /// paths or HEADs. Each existing removal door releases lifecycle before
    /// returning; the next item acquires it independently.
    pub fn answer_workspace_cleanup(
        &self,
        chats: &ChatManager,
        id: &str,
        approve: bool,
    ) -> Result<Settled, String> {
        let asked = {
            let mut pending = self.cleanup_requests.lock().map_err(|e| e.to_string())?;
            let p = pending
                .get_mut(id)
                .ok_or("This cleanup card is no longer pending.")?;
            if p.asked.processing {
                return Err("This cleanup batch is already being processed.".into());
            }
            if approve {
                // Removal is not an ending action: unavailable profile refuses
                // before consent is claimed or any existing guard is entered.
                crate::profile::available()?;
                self.mutate(|_| Ok(()))?;
            }
            p.asked.processing = true;
            p.asked.approved = Some(approve);
            p.asked.clone()
        };
        crate::bus::emit(
            EVENT,
            &json!({ "state": "processing", "id": id, "chatKey": asked.chat_key, "approved": approve }),
        );
        #[cfg(test)]
        tests::progress_emitted(self);
        let mut items = Vec::new();
        for item in &asked.items {
            let before: Vec<bool> = item
                .worktrees
                .iter()
                .map(|tree| fs::symlink_metadata(&tree.path).is_ok())
                .collect();
            let outcome = if !approve {
                Err("The person declined; nothing was removed.".into())
            } else {
                (|| {
                    crate::profile::available()?;
                    let owner = self.cleanup_item_owner(&asked, &item.run_id)?;
                    match item.kind {
                        Kind::TaskWorktree => {
                            let tree = item
                                .worktrees
                                .first()
                                .ok_or("The card has no task workspace.")?;
                            self.cleanup_workspace_expected(
                                chats,
                                &owner,
                                item.task_id.as_deref().ok_or("The card has no task id.")?,
                                false,
                                &tree.head_commit,
                                Some(tree),
                                asked.named,
                            )
                            .map(|_| ())
                        }
                        Kind::Mission => self
                            .close_mission_expected(
                                chats,
                                &owner,
                                &item.run_id,
                                false,
                                Some(&item.worktrees),
                                asked.named,
                            )
                            .map(|_| ()),
                    }
                })()
            };
            let removed_now = item.worktrees.iter().zip(before).filter(|(tree, existed)|
                *existed && matches!(fs::symlink_metadata(&tree.path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
            ).count();
            let (status, reason) = match outcome {
                Ok(()) => ("removed", "Removed through the existing Cleanup / Close guards.".into()),
                Err(error) if approve && removed_now > 0 => (
                    if removed_now == item.worktrees.len() { "removed" } else { "kept" },
                    format!("{removed_now}/{} folders were removed before the host reported: {error}. The ledger's per-root delivery records show the remaining work.", item.worktrees.len())
                ),
                Err(error) => ("kept", error),
            };
            let result = ItemResult {
                id: item.id.clone(),
                status: status.into(),
                reason,
            };
            {
                let mut pending = self.cleanup_requests.lock().map_err(|e| e.to_string())?;
                if let Some(p) = pending.get_mut(id) {
                    p.asked.results.push(result.clone());
                }
            }
            crate::bus::emit(
                EVENT,
                &json!({ "state": "item", "id": id, "chatKey": asked.chat_key, "item": result }),
            );
            #[cfg(test)]
            tests::progress_emitted(self);
            items.push(result);
        }
        let settled = Settled {
            id: id.into(),
            approved: approve,
            items,
        };
        let waiting = self
            .cleanup_requests
            .lock()
            .map_err(|e| e.to_string())?
            .remove(id);
        let delivered = waiting
            .and_then(|w| w.waiter)
            .is_some_and(|tx| tx.send(settled.clone()).is_ok());
        if !delivered {
            // Reporting an outcome already reached is an ending action. Keep
            // its notification in RAM and owe the save if the profile went away.
            self.mutate_regardless("the cleanup result notification", |data| {
                inbox::enqueue(data, &asked.run_ids[0], "host", &asked.chat_key,
                    format!("cleanup-result:{id}"), "workspace_cleanup",
                    format!("The person's workspace cleanup decision settled. {}\nThis is a host notification, not a new instruction or permission to remove other worktrees.",
                        serde_json::to_string(&settled).map_err(|e| e.to_string())?));
                Ok(())
            })?;
        }
        crate::bus::emit(
            EVENT,
            &json!({ "state": "settled", "id": id, "chatKey": asked.chat_key, "result": settled }),
        );
        Ok(settled)
    }
}

#[cfg(test)]
mod tests;

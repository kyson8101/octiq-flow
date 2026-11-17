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
mod tests {
    use super::*;
    use crate::git_ops::workflow::tests::Repo;

    thread_local! {
        // Read exactly what a reloaded page sees at each progress boundary,
        // without a timing-dependent race against the next item's removal.
        static PROGRESS_SNAPSHOTS: std::cell::RefCell<Option<Vec<serde_json::Value>>> =
            const { std::cell::RefCell::new(None) };
    }

    pub(super) fn progress_emitted(store: &OrchestrationStore) {
        PROGRESS_SNAPSHOTS.with(|slot| {
            if let Some(snapshots) = slot.borrow_mut().as_mut() {
                assert!(
                    store.cleanup_requests.try_lock().is_ok(),
                    "progress is published after releasing the pending-request lock"
                );
                snapshots
                    .push(serde_json::to_value(store.cleanup_request_pending().unwrap()).unwrap());
            }
        });
    }

    struct ProgressProbe;

    impl ProgressProbe {
        fn new() -> Self {
            PROGRESS_SNAPSHOTS.with(|slot| *slot.borrow_mut() = Some(Vec::new()));
            Self
        }

        fn assert_progress(&self, card: &Asked, result: &Settled, tap: &crate::bus::tap::Tap) {
            assert!(card.results.is_empty());
            assert_eq!(card.approved, None);
            assert!(serde_json::to_value(card)
                .unwrap()
                .get("approved")
                .is_none());
            let events: Vec<_> = tap
                .heard()
                .into_iter()
                .filter(|(event, _)| event == EVENT)
                .map(|(_, payload)| payload)
                .collect();
            let mut expected = vec![json!({
                "state": "processing", "id": card.id,
                "chatKey": card.chat_key, "approved": result.approved
            })];
            for item in &result.items {
                expected.push(json!({
                    "state": "item", "id": card.id, "chatKey": card.chat_key, "item": item
                }));
            }
            expected.push(json!({
                "state": "settled", "id": card.id, "chatKey": card.chat_key, "result": result
            }));
            assert_eq!(events, expected, "processing → item × N → settled");
            assert_eq!(
                result.items.iter().map(|i| &i.id).collect::<Vec<_>>(),
                card.items.iter().map(|i| &i.id).collect::<Vec<_>>()
            );
            PROGRESS_SNAPSHOTS.with(|slot| {
                let snapshots = slot.borrow();
                let snapshots = snapshots.as_ref().unwrap();
                assert_eq!(snapshots.len(), result.items.len() + 1);
                for (completed, snapshot) in snapshots.iter().enumerate() {
                    let mut expected = serde_json::to_value(card).unwrap();
                    expected["processing"] = json!(true);
                    expected["approved"] = json!(result.approved);
                    expected["results"] = json!(&result.items[..completed]);
                    assert_eq!(*snapshot, json!([expected]));
                }
            });
        }
    }

    impl Drop for ProgressProbe {
        fn drop(&mut self) {
            PROGRESS_SNAPSHOTS.with(|slot| *slot.borrow_mut() = None);
        }
    }

    fn setup(mode: WorkspaceMode) -> (Repo, OrchestrationStore, Run) {
        let repo = Repo::new();
        repo.remote();
        let store = OrchestrationStore::default();
        let run = store
            .create_run_with_mode(
                "chat:master".into(),
                "Cleanup fixture".into(),
                "project".into(),
                repo.root.clone(),
                Some(8),
                mode,
            )
            .unwrap();
        (repo, store, run)
    }
    fn prepare(store: &OrchestrationStore, run: &Run) -> (Task, Attempt) {
        let task = super::super::tests::task(store, run, vec![]);
        let launch = WorkerLaunch {
            task_id: task.id.clone(),
            agent: ChatAgent::Codex,
            model: None,
            effort: None,
            access: Access::Auto,
            new_worktree: None,
            base_branch: "main".into(),
        };
        let (run, task, reserved, previous) = store
            .reserve_attempt_for("chat:master", &launch, StartedBy::Coordinator)
            .unwrap();
        let ws = store
            .prepare_task_workspace(
                &ChatManager::default(),
                &run,
                &task,
                &reserved,
                previous.as_ref(),
                &launch,
            )
            .unwrap();
        let attempt = store
            .activate_attempt(&reserved.id, ws.cwd, ws.branch, ws.is_worktree)
            .unwrap();
        (task, attempt)
    }
    fn finish(store: &OrchestrationStore, attempt: &Attempt) {
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "Fixture finished".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
    }
    fn merged(repo: &Repo, attempt: &Attempt) {
        repo.commit(&attempt.cwd, "merged.txt", &attempt.id);
        repo.git(&["merge", "--ff-only", &attempt.branch]);
        repo.git(&["push", "origin", "main"]);
    }
    // Model a recovered open task gate beside a settled attempt. The public
    // create_gate door correctly refuses creating a fresh gate on that attempt;
    // Cleanup must still fail closed when an old record contains one.
    fn recovered_gate(store: &OrchestrationStore, run: &Run, task_id: &str) {
        let gate = store
            .create_gate(
                "chat:master",
                run.id.clone(),
                None,
                "Keep this checkout?".into(),
                vec![],
            )
            .unwrap();
        store
            .mutate(|data| {
                data.gates.get_mut(&gate.id).unwrap().task_id = Some(task_id.into());
                Ok(())
            })
            .unwrap();
    }
    fn ask(store: &OrchestrationStore, run: &Run) -> Option<Asked> {
        store
            .request_workspace_cleanup(&ChatManager::default(), "chat:master", Some(&run.id), None)
            .unwrap()
    }

    #[test]
    fn coordinator_allowed_workers_refused_even_after_settlement_and_unrelated_chat_refused() {
        let (_repo, store, run) = setup(WorkspaceMode::Worktree);
        let (_, attempt) = prepare(&store, &run);
        assert!(store
            .cleanup_request_runs("chat:master", Some(&run.id))
            .is_ok());
        assert!(store
            .cleanup_request_runs("chat:other", Some(&run.id))
            .is_err());
        assert!(store.cleanup_request_runs("chat:other", None).is_err());
        assert!(store
            .cleanup_request_runs(&attempt.worker_chat_key, Some(&run.id))
            .is_err());
        finish(&store, &attempt);
        assert!(store
            .active_task(&attempt.worker_chat_key)
            .unwrap()
            .is_none());
        assert!(store
            .cleanup_request_runs(&attempt.worker_chat_key, None)
            .is_err());
        // Legacy keys lack the chat:orch prefix: it is the attempt record,
        // not a naming convention or active_task, that proves identity.
        store
            .mutate(|data| {
                data.attempts.get_mut(&attempt.id).unwrap().worker_chat_key =
                    "chat:legacy-worker".into();
                data.runs.get_mut(&run.id).unwrap().coordinator_chat_key =
                    "chat:legacy-worker".into();
                Ok(())
            })
            .unwrap();
        assert!(store
            .cleanup_request_runs("chat:legacy-worker", None)
            .is_err());
    }

    #[test]
    fn empty_and_unsafe_workspaces_create_no_card() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        assert!(ask(&store, &run).is_none());
        let (_, live) = prepare(&store, &run);
        let (unmerged_task, unmerged) = prepare(&store, &run);
        repo.commit(&unmerged.cwd, "not-merged.txt", "unmerged");
        finish(&store, &unmerged);
        let (_, dirty) = prepare(&store, &run);
        finish(&store, &dirty);
        fs::write(Path::new(&dirty.cwd).join("source.txt"), "dirty").unwrap();
        let (abandoned_task, abandoned) = prepare(&store, &run);
        finish(&store, &abandoned);
        store
            .mutate(|data| {
                data.tasks
                    .get_mut(&abandoned_task.id)
                    .unwrap()
                    .workspace
                    .as_mut()
                    .unwrap()
                    .abandoned = true;
                Ok(())
            })
            .unwrap();
        let (gated_task, gated) = prepare(&store, &run);
        finish(&store, &gated);
        let (_, ignored) = prepare(&store, &run);
        finish(&store, &ignored);
        repo.git(&[
            "config",
            "core.excludesFile",
            &repo.dir.join("ignore").to_string_lossy(),
        ]);
        fs::write(repo.dir.join("ignore"), "private.txt\n").unwrap();
        fs::write(Path::new(&ignored.cwd).join("private.txt"), "at stake").unwrap();
        recovered_gate(&store, &run, &gated_task.id);
        assert!(ask(&store, &run).is_none());
        assert!(store.cleanup_request_pending().unwrap().is_empty());
        assert!(store
            .snapshot(Some(&run.id))
            .unwrap()
            .tasks
            .iter()
            .any(|t| t.id == unmerged_task.id));
        assert!(Path::new(&live.cwd).exists());
    }

    #[test]
    fn approve_removes_only_listed_merged_worktrees_and_keeps_changed_control() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let (task, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        let (changed_task, changed) = prepare(&store, &run);
        finish(&store, &changed);
        let card = ask(&store, &run).unwrap();
        assert_eq!(card.items.len(), 2);
        // Same chat's repeated proposal preserves exact contents and id.
        assert_eq!(ask(&store, &run).unwrap().id, card.id);
        repo.commit(
            &changed.cwd,
            "later.txt",
            "HEAD changed after approval preview",
        );
        // A newly eligible workspace was not in the card.
        let (_, later) = prepare(&store, &run);
        finish(&store, &later);
        let tap = crate::bus::tap::Tap::on(&card.id);
        let progress = ProgressProbe::new();
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        progress.assert_progress(&card, &result, &tap);
        assert!(
            !Path::new(&first.cwd).exists(),
            "the safe control must actually be removed"
        );
        assert!(Path::new(&changed.cwd).exists());
        assert!(Path::new(&later.cwd).exists());
        assert_eq!(
            result
                .items
                .iter()
                .find(|r| r.id == format!("task:{}", task.id))
                .unwrap()
                .status,
            "removed"
        );
        let kept = result
            .items
            .iter()
            .find(|r| r.id == format!("task:{}", changed_task.id))
            .unwrap();
        assert_eq!(kept.status, "kept");
        assert!(kept.reason.contains("HEAD changed"), "{}", kept.reason);
        assert!(store.cleanup_request_pending().unwrap().is_empty());
        assert!(store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .is_err());
        let inner = store.inner.lock().unwrap();
        assert!(inner
            .data
            .notifications
            .values()
            .any(|n| n.source == format!("cleanup-result:{}", card.id)
                && n.target_chat_key == "chat:master"
                && n.body.contains("HEAD changed")));
    }

    #[test]
    fn deny_removes_nothing_and_waiting_call_receives_each_outcome() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        let (_, second) = prepare(&store, &run);
        finish(&store, &second);
        let (tx, mut rx) = oneshot::channel();
        let card = store
            .request_workspace_cleanup(&ChatManager::default(), "chat:master", None, Some(tx))
            .unwrap()
            .unwrap();
        assert_eq!(card.items.len(), 2);
        let tap = crate::bus::tap::Tap::on(&card.id);
        let progress = ProgressProbe::new();
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, false)
            .unwrap();
        progress.assert_progress(&card, &result, &tap);
        assert!(!result.approved);
        assert!(result.items.iter().all(|item| item.status == "kept"));
        assert!(Path::new(&first.cwd).exists());
        assert!(Path::new(&second.cwd).exists());
        assert!(store.cleanup_request_pending().unwrap().is_empty());
        assert_eq!(rx.try_recv().unwrap().id, card.id);
        assert!(!store
            .inner
            .lock()
            .unwrap()
            .data
            .notifications
            .values()
            .any(|n| n.source == format!("cleanup-result:{}", card.id)));
    }

    #[test]
    fn mission_close_uses_original_guards_and_binds_membership_and_head() {
        let (repo, store, run) = setup(WorkspaceMode::Mission);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        let card = ask(&store, &run).unwrap();
        assert_eq!(card.items.len(), 1);
        assert!(matches!(card.items[0].kind, Kind::Mission));
        assert_eq!(card.items[0].worktrees[0].ignored_file_count, Some(0));
        repo.commit(&first.cwd, "later.txt", "mission changed");
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept");
        assert!(result.items[0].reason.contains("HEAD changed"));
        assert!(Path::new(&first.cwd).exists());
        repo.git(&["merge", "--ff-only", &first.branch]);
        repo.git(&["push", "origin", "main"]);
        let card = ask(&store, &run).unwrap();
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
        assert!(!Path::new(&first.cwd).exists());
        assert_eq!(
            store.snapshot(Some(&run.id)).unwrap().runs[0].status,
            RunStatus::Closed
        );
    }

    #[test]
    fn unavailable_profile_refuses_approval_but_denial_still_settles() {
        let scratch = crate::test_dir::TestDir::new("cleanup-card-profile");
        let home = scratch.join("profile");
        crate::profile::make_dir(&home).unwrap();
        let _profile = crate::profile::started_in(&home);
        let (repo, mut store, run) = setup(WorkspaceMode::Worktree);
        store.path = Some(crate::profile::profile_dir().join("orchestrations.json"));
        store.mutate(|_| Ok(())).unwrap();
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        let card = ask(&store, &run).unwrap();
        fs::rename(&home, scratch.join("away")).unwrap();
        assert!(store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap_err()
            .contains("profile"));
        assert!(Path::new(&first.cwd).exists());
        assert_eq!(store.cleanup_request_pending().unwrap().len(), 1);
        assert!(
            !store
                .answer_workspace_cleanup(&ChatManager::default(), &card.id, false)
                .unwrap()
                .approved
        );
        assert!(Path::new(&first.cwd).exists());
        assert!(
            store.owes(),
            "denial and its notification stay in RAM while the profile is away"
        );
    }

    #[test]
    fn no_run_id_covers_all_coordinated_runs_but_never_another_coordinator() {
        let (repo, store, first_run) = setup(WorkspaceMode::Worktree);
        let (_, first) = prepare(&store, &first_run);
        finish(&store, &first);
        let second_run = store
            .create_run_with_mode(
                "chat:master".into(),
                "Second finished run".into(),
                "project".into(),
                repo.root.clone(),
                None,
                WorkspaceMode::Worktree,
            )
            .unwrap();
        let (_, second) = prepare(&store, &second_run);
        finish(&store, &second);
        // These heads already equal origin/main, which is verified as merged.
        let other_run = store
            .create_run_with_mode(
                "chat:other".into(),
                "Other mission".into(),
                "project".into(),
                repo.root.clone(),
                None,
                WorkspaceMode::Mission,
            )
            .unwrap();
        let card = store
            .request_workspace_cleanup(&ChatManager::default(), "chat:master", None, None)
            .unwrap()
            .unwrap();
        assert_eq!(card.items.len(), 2);
        assert_eq!(card.run_ids.len(), 2);
        assert!(!card.run_ids.contains(&other_run.id));
        assert!(card
            .items
            .iter()
            .all(|i| i.run_id == first_run.id || i.run_id == second_run.id));
    }

    #[test]
    fn swept_task_uses_the_kept_head_and_current_base_without_rebuilding() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        store
            .refresh_workspace("chat:master", &first.task_id)
            .unwrap();
        crate::git_ops::lifespan::remove(&repo.root, &first.cwd, false).unwrap();
        store.lifespan_record_swept(&first.cwd, 100).unwrap();
        let card = ask(&store, &run).unwrap();
        assert_eq!(card.items[0].worktrees[0].ignored_file_count, None);
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
        assert!(!Path::new(&first.cwd).exists());
    }

    #[test]
    fn a_recovered_open_gate_after_the_card_is_kept_by_the_original_cleanup_guard() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let (_, safe) = prepare(&store, &run);
        finish(&store, &safe);
        let (task, held) = prepare(&store, &run);
        finish(&store, &held);
        let card = ask(&store, &run).unwrap();
        recovered_gate(&store, &run, &task.id);
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert!(!Path::new(&safe.cwd).exists());
        assert!(Path::new(&held.cwd).exists());
        let kept = result
            .items
            .iter()
            .find(|i| i.id == format!("task:{}", task.id))
            .unwrap();
        assert_eq!(kept.status, "kept");
        assert!(kept.reason.contains("decision"), "{}", kept.reason);
        assert!(Path::new(&repo.root).exists());
    }

    #[test]
    fn cleanup_receipt_reaches_coordinator_even_for_a_stopped_run() {
        let (_repo, store, run) = setup(WorkspaceMode::Worktree);
        let (_, first) = prepare(&store, &run);
        finish(&store, &first);
        let card = ask(&store, &run).unwrap();
        store
            .mutate(|data| {
                data.runs.get_mut(&run.id).unwrap().status = RunStatus::Stopped;
                Ok(())
            })
            .unwrap();
        store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, false)
            .unwrap();
        let notice = store
            .snapshot(None)
            .unwrap()
            .notifications
            .into_iter()
            .find(|n| n.source == format!("cleanup-result:{}", card.id))
            .unwrap();
        assert!(store
            .claim_notification(&notice.id, now_ms() + 100)
            .unwrap()
            .is_some());
    }

    // --- runIds: any of the person's chats may propose FINISHED runs ---

    fn set_status(store: &OrchestrationStore, run: &Run, status: RunStatus) {
        store
            .mutate(|data| {
                data.runs.get_mut(&run.id).unwrap().status = status;
                Ok(())
            })
            .unwrap();
    }

    fn ask_named(
        store: &OrchestrationStore,
        actor: &str,
        ids: &[&Run],
    ) -> Result<Option<Asked>, String> {
        let ids: Vec<String> = ids.iter().map(|r| r.id.clone()).collect();
        store.request_cleanup(&ChatManager::default(), actor, Which::Named(&ids), None)
    }

    #[test]
    fn a_non_coordinator_person_chat_proposes_a_finished_run_and_nothing_is_removed() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        assert!(card.named);
        assert_eq!(card.chat_key, "chat:person");
        assert_eq!(card.items.len(), 1);
        assert_eq!(card.items[0].run_id, run.id);
        assert_eq!(card.items[0].run_objective, "Cleanup fixture");
        assert!(Path::new(&first.cwd).exists(), "a proposal removes nothing");
        // The coordinator's own request is a different chat's card.
        assert_eq!(ask(&store, &run).unwrap().chat_key, "chat:master");
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
        assert!(!Path::new(&first.cwd).exists());
        // The result goes to the chat that asked, and is deliverable there.
        let notice = store
            .snapshot(None)
            .unwrap()
            .notifications
            .into_iter()
            .find(|n| n.source == format!("cleanup-result:{}", card.id))
            .unwrap();
        assert_eq!(notice.target_chat_key, "chat:person");
        assert!(store
            .claim_notification(&notice.id, now_ms() + 100)
            .unwrap()
            .is_some());
    }

    #[test]
    fn named_runs_refuse_workers_even_settled_and_keep_unfinished_runs_with_a_reason() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        let ids = [run.id.clone()];
        assert!(store
            .cleanup_scope(&first.worker_chat_key, Which::Named(&ids))
            .is_err());
        // A running run is kept with the host's reason beside a finished one.
        let busy = store
            .create_run_with_mode(
                "chat:other".into(),
                "Busy".into(),
                "project".into(),
                repo.root.clone(),
                None,
                WorkspaceMode::Worktree,
            )
            .unwrap();
        set_status(&store, &busy, RunStatus::Running);
        let ids = [busy.id.clone(), run.id.clone(), "run_missing".to_string()];
        let scope = store
            .cleanup_scope("chat:person", Which::Named(&ids))
            .unwrap();
        assert_eq!(scope.runs.len(), 1);
        assert_eq!(scope.runs[0].id, run.id);
        assert_eq!(scope.kept.len(), 2);
        assert!(scope.kept[0].reason.contains("running"), "{:?}", scope.kept);
        assert_eq!(scope.kept[1].reason, "No such run.");
        // A live worker, an open gate and a planning run all keep a run.
        set_status(&store, &busy, RunStatus::Planning);
        assert!(store
            .cleanup_scope("chat:person", Which::Named(&[busy.id.clone()]))
            .unwrap_err()
            .contains("planning"));
        set_status(&store, &busy, RunStatus::Completed);
        let gate = store
            .create_gate("chat:other", busy.id.clone(), None, "Keep?".into(), vec![])
            .unwrap();
        // Opening a gate moves the run to waiting; a finished status with a
        // gate still open (a recovered record) must be kept by the gate alone.
        set_status(&store, &busy, RunStatus::Completed);
        assert!(store
            .cleanup_scope("chat:person", Which::Named(&[busy.id.clone()]))
            .unwrap_err()
            .contains("open decision"));
        store
            .mutate(|data| {
                data.gates.get_mut(&gate.id).unwrap().status = GateStatus::Resolved;
                Ok(())
            })
            .unwrap();
        // Starting a worker makes the run live; with the status forced back
        // to finished (a recovered record) the live attempt alone keeps it.
        let (_, live) = prepare(&store, &run);
        assert!(store
            .cleanup_scope("chat:person", Which::Named(&[run.id.clone()]))
            .unwrap_err()
            .contains("running"));
        set_status(&store, &run, RunStatus::Completed);
        assert!(store
            .cleanup_scope("chat:person", Which::Named(&[run.id.clone()]))
            .unwrap_err()
            .contains("worker"));
        let _ = live;
        // Bad lists never reach the ledger.
        for bad in [
            vec![],
            vec![run.id.clone(), run.id.clone()],
            vec!["x".to_string(); 51],
        ] {
            assert!(store
                .cleanup_scope("chat:person", Which::Named(&bad))
                .is_err());
        }
    }

    #[test]
    fn a_named_run_that_stopped_being_finished_is_kept_on_the_answer() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        set_status(&store, &run, RunStatus::Running);
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept");
        assert!(
            result.items[0].reason.contains("running"),
            "{:?}",
            result.items
        );
        assert!(Path::new(&first.cwd).exists());
    }

    #[test]
    fn a_mission_with_no_checkout_closes_on_approval_when_nothing_is_at_stake() {
        let (_repo, store, run) = setup(WorkspaceMode::Mission);
        set_status(&store, &run, RunStatus::Stopped);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        assert!(matches!(card.items[0].kind, Kind::Mission));
        assert!(card.items[0].worktrees.is_empty());
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
        assert_eq!(
            store.snapshot(Some(&run.id)).unwrap().runs[0].status,
            RunStatus::Closed
        );
    }

    #[test]
    fn a_mission_whose_folder_is_gone_closes_even_with_no_saved_delivery() {
        let (repo, store, run) = setup(WorkspaceMode::Mission);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
        crate::git_ops::lifespan::remove(&repo.root, &root, false).unwrap();
        assert!(store.snapshot(Some(&run.id)).unwrap().runs[0]
            .mission_delivery
            .is_empty());
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        assert!(matches!(card.items[0].kind, Kind::Mission));
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
        assert_eq!(
            store.snapshot(Some(&run.id)).unwrap().runs[0].status,
            RunStatus::Closed
        );
    }

    fn gone_branch_fixture(refresh_first: bool) -> (Repo, OrchestrationStore, Run, Attempt) {
        let (repo, store, run) = setup(WorkspaceMode::Mission);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        if refresh_first {
            store.refresh_mission("chat:master", &run.id).unwrap();
        }
        let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
        crate::git_ops::lifespan::remove(&repo.root, &root, false).unwrap();
        repo.git(&["branch", "-D", &first.branch]);
        assert!(!branch_exists(&repo, &first.branch));
        (repo, store, run, first)
    }

    #[test]
    fn a_merged_mission_whose_folder_and_branch_are_both_gone_closes() {
        let (_repo, store, run, first) = gone_branch_fixture(true);
        let listed = store.coordinated_runs("chat:master").unwrap();
        assert!(listed[0].close_eligible, "{:?}", listed[0].close_blocker);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        assert!(matches!(card.items[0].kind, Kind::Mission));
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
        let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
        assert_eq!(saved.status, RunStatus::Closed);
        assert_eq!(saved.mission_delivery.len(), 1);
        let delivery = &saved.mission_delivery[0];
        assert!(delivery.merged && delivery.removed && delivery.branch_deleted);
        assert_eq!(delivery.branch, first.branch);
    }

    #[test]
    fn a_mission_whose_folder_and_branch_are_gone_but_never_recorded_merged_is_kept() {
        let (_repo, store, run, _first) = gone_branch_fixture(false);
        let listed = store.coordinated_runs("chat:master").unwrap();
        assert!(!listed[0].close_eligible);
        let why = listed[0].close_blocker.clone().unwrap();
        assert!(why.contains("both gone"), "{why}");
        assert!(why.contains("no merge"), "{why}");
        assert!(ask_named(&store, "chat:person", &[&run])
            .map(|card| card.is_none())
            .unwrap_or(true));
        let error = store
            .close_mission(&ChatManager::default(), "chat:master", &run.id, false)
            .unwrap_err();
        assert!(error.contains("both gone"), "{error}");
        assert_ne!(
            store.snapshot(Some(&run.id)).unwrap().runs[0].status,
            RunStatus::Closed
        );
    }

    #[test]
    fn a_git_failure_that_is_not_an_absent_branch_keeps_the_mission() {
        let (_repo, store, run, _first) = gone_branch_fixture(true);
        let (saved, mut plans) = {
            let inner = store.inner.lock().unwrap();
            let saved = inner.data.runs[&run.id].clone();
            (
                saved,
                super::super::mission::mission_plans(&inner.data, &run.id),
            )
        };
        plans[0].repository_root = format!("{}-does-not-exist", plans[0].repository_root);
        let error = super::super::mission::swept_delivery(&saved, &plans[0], false).unwrap_err();
        assert!(!error.contains("both gone"), "{error}");
    }

    fn task_workspace_state(
        store: &OrchestrationStore,
        run: &Run,
        task_id: &str,
    ) -> WorkspaceState {
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let task = snapshot.tasks.iter().find(|t| t.id == task_id).unwrap();
        task.workspace.as_ref().unwrap().state
    }

    /// The run's whole saved delivery, as the ledger holds it.
    fn delivery_json(store: &OrchestrationStore, run: &Run) -> String {
        let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
        serde_json::to_string(&saved.mission_delivery).unwrap()
    }

    fn nothing_was_closed_or_deleted(store: &OrchestrationStore, run: &Run, before: &str) {
        let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
        assert_ne!(saved.status, RunStatus::Closed);
        assert_eq!(delivery_json(store, run), before);
        assert!(
            saved.mission_delivery.iter().all(|d| !d.branch_deleted),
            "{:?}",
            saved.mission_delivery
        );
    }

    /// The card was made with the folder and the branch gone; then a branch
    /// with the same name in another case appears at an unmerged commit.
    fn alias_after_the_card(pack: bool) {
        let (repo, store, run, first) = gone_branch_fixture(true);
        let alias = first.branch.to_uppercase();
        assert_ne!(alias, first.branch);
        let folds_case = Path::new(&repo.root.to_uppercase()).exists();
        if !pack && !folds_case {
            eprintln!("skipped: this filesystem keeps case, a loose alias is another file");
            return;
        }
        let before = delivery_json(&store, &run);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        assert_eq!(
            delivery_json(&store, &run),
            before,
            "asking for a card records nothing"
        );
        let unmerged = repo.git(&["commit-tree", "main^{tree}", "-p", "main", "-m", "unmerged"]);
        repo.git(&["branch", &alias, &unmerged]);
        if pack {
            repo.git(&["pack-refs", "--all"]);
        }
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
        nothing_was_closed_or_deleted(&store, &run, &before);
        assert_eq!(
            repo.git(&["rev-parse", &format!("refs/heads/{alias}")]),
            unmerged,
            "the unmerged work is still there"
        );
    }

    #[test]
    fn a_branch_recreated_under_another_case_after_the_card_keeps_the_mission() {
        alias_after_the_card(false);
    }

    #[test]
    fn a_packed_alias_branch_recreated_after_the_card_keeps_the_mission() {
        alias_after_the_card(true);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_loose_ref_folder_keeps_the_mission() {
        use std::os::unix::fs::PermissionsExt;
        struct Restore(std::path::PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            }
        }
        let (repo, store, run, first) = gone_branch_fixture(true);
        let parent = Path::new(&first.branch).parent().unwrap().to_path_buf();
        let hidden = Path::new(&repo.root).join(".git/refs/heads").join(parent);
        std::fs::create_dir_all(&hidden).unwrap();
        let _restore = Restore(hidden.clone());
        std::fs::set_permissions(&hidden, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read_dir(&hidden).is_ok() {
            eprintln!("skipped: modes are not enforced for this user");
            return;
        }
        let before = delivery_json(&store, &run);
        let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
        let plan = {
            let inner = store.inner.lock().unwrap();
            super::super::mission::mission_plans(&inner.data, &run.id).remove(0)
        };
        assert!(super::super::mission::swept_delivery(&saved, &plan, false).is_err());
        assert!(ask_named(&store, "chat:person", &[&run])
            .map(|card| card.is_none())
            .unwrap_or(true));
        nothing_was_closed_or_deleted(&store, &run, &before);
    }

    #[test]
    fn a_folder_and_branch_recreated_at_the_same_head_after_the_card_are_kept() {
        let (repo, store, run, first) = gone_branch_fixture(true);
        let before = delivery_json(&store, &run);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        assert_eq!(delivery_json(&store, &run), before);
        let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
        repo.git(&["worktree", "add", "-b", &first.branch, &root, "main"]);
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
        assert!(
            result.items[0].reason.contains("appeared or went"),
            "{}",
            result.items[0].reason
        );
        assert!(
            Path::new(&root).exists(),
            "the new worktree was not removed"
        );
        assert!(branch_exists(&repo, &first.branch));
        nothing_was_closed_or_deleted(&store, &run, &before);
    }

    #[test]
    fn asking_for_a_card_records_nothing_a_close_alone_records() {
        let (_repo, store, run, _first) = gone_branch_fixture(true);
        let before = delivery_json(&store, &run);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        assert!(matches!(card.items[0].kind, Kind::Mission));
        assert_eq!(delivery_json(&store, &run), before);
        // Declining changes nothing either.
        store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, false)
            .unwrap();
        assert_eq!(delivery_json(&store, &run), before);
        // The approved Close is what records them.
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
        assert!(saved.mission_delivery[0].removed && saved.mission_delivery[0].branch_deleted);
    }

    #[test]
    fn a_folder_and_branch_made_again_while_a_gone_mission_closes_are_not_recorded_removed() {
        let (repo, store, run, first) = gone_branch_fixture(true);
        let before = delivery_json(&store, &run);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
        let (r, branch, path) = (repo.root.clone(), first.branch.clone(), root.clone());
        super::super::mission::AFTER_BRANCH_DELETE.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                crate::git_ops::lifespan::git(
                    &r,
                    &["worktree", "add", "-b", &branch, &path, "main"],
                )
                .unwrap();
            }))
        });
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
        assert!(
            result.items[0].reason.contains("appeared or went"),
            "{}",
            result.items[0].reason
        );
        assert!(Path::new(&root).exists());
        nothing_was_closed_or_deleted(&store, &run, &before);
    }

    /// A mission whose folder is gone but whose branch is kept.
    fn kept_branch_fixture() -> (Repo, OrchestrationStore, Run, Attempt) {
        let (repo, store, run) = setup(WorkspaceMode::Mission);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        store.refresh_mission("chat:master", &run.id).unwrap();
        let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
        crate::git_ops::lifespan::remove(&repo.root, &root, false).unwrap();
        assert!(branch_exists(&repo, &first.branch));
        (repo, store, run, first)
    }

    /// The saved delivery without the time git was last asked, which a
    /// refresh may move: everything else is what the ask must leave alone.
    fn delivery_without_clock(store: &OrchestrationStore, run: &Run) -> serde_json::Value {
        fn strip(value: &mut serde_json::Value) {
            match value {
                serde_json::Value::Object(map) => {
                    map.remove("checkedAt");
                    map.remove("checked_at");
                    map.values_mut().for_each(strip);
                }
                serde_json::Value::Array(items) => items.iter_mut().for_each(strip),
                _ => {}
            }
        }
        let mut value = serde_json::from_str(&delivery_json(store, run)).unwrap();
        strip(&mut value);
        value
    }

    #[test]
    fn asking_for_a_card_of_a_swept_mission_with_a_kept_branch_does_not_stamp_it_swept() {
        let (_repo, store, run, _first) = kept_branch_fixture();
        // One refresh of the swept mission first (it recomputes what git can
        // say, such as `pushed`): what follows must change nothing more.
        store.refresh_mission("chat:master", &run.id).unwrap();
        let before = delivery_without_clock(&store, &run);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        assert!(matches!(card.items[0].kind, Kind::Mission));
        assert_eq!(delivery_without_clock(&store, &run), before, "the ask");
        store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, false)
            .unwrap();
        assert_eq!(delivery_without_clock(&store, &run), before, "a Deny");
        let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
        assert!(saved.mission_delivery[0].swept_at.is_none());
        // Only the Close's own read stamps it.
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
        assert_eq!(saved.status, RunStatus::Closed);
        assert!(saved.mission_delivery[0].swept_at.is_some());
    }

    #[test]
    fn a_folder_made_again_during_the_last_branch_lookup_keeps_a_gone_mission() {
        let (_repo, store, run, first) = gone_branch_fixture(true);
        let before = delivery_json(&store, &run);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
        let path = root.clone();
        super::super::mission::AFTER_BRANCH_LOOKUP.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                std::fs::create_dir_all(&path).unwrap();
            }))
        });
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
        assert!(
            result.items[0].reason.contains("appeared or went"),
            "{}",
            result.items[0].reason
        );
        assert!(Path::new(&root).exists());
        nothing_was_closed_or_deleted(&store, &run, &before);
    }

    #[test]
    fn a_folder_made_again_during_the_last_branch_lookup_keeps_a_swept_task() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let (task, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        store
            .refresh_workspace("chat:master", &first.task_id)
            .unwrap();
        crate::git_ops::lifespan::remove(&repo.root, &first.cwd, false).unwrap();
        store.lifespan_record_swept(&first.cwd, 100).unwrap();
        repo.git(&["branch", "-D", &first.branch]);
        let card = ask(&store, &run).expect("a card for the swept task");
        let path = first.cwd.clone();
        super::super::mission::AFTER_BRANCH_LOOKUP.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                std::fs::create_dir_all(&path).unwrap();
            }))
        });
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
        assert!(
            result.items[0].reason.contains("appeared or went"),
            "{}",
            result.items[0].reason
        );
        assert!(Path::new(&first.cwd).exists());
        assert_ne!(
            task_workspace_state(&store, &run, &task.id),
            WorkspaceState::Cleaned
        );
    }

    #[test]
    fn a_folder_and_branch_made_again_during_a_swept_task_cleanup_are_not_recorded_cleaned() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let (task, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        store
            .refresh_workspace("chat:master", &first.task_id)
            .unwrap();
        crate::git_ops::lifespan::remove(&repo.root, &first.cwd, false).unwrap();
        store.lifespan_record_swept(&first.cwd, 100).unwrap();
        repo.git(&["branch", "-D", &first.branch]);
        let card = ask(&store, &run).expect("a card for the swept task");
        let (r, branch, path) = (repo.root.clone(), first.branch.clone(), first.cwd.clone());
        super::super::mission::AFTER_SWEPT_EVIDENCE.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                crate::git_ops::lifespan::git(
                    &r,
                    &["worktree", "add", "-b", &branch, &path, "main"],
                )
                .unwrap();
            }))
        });
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
        assert!(
            result.items[0].reason.contains("appeared or went"),
            "{}",
            result.items[0].reason
        );
        assert!(
            Path::new(&first.cwd).exists(),
            "the new folder was not touched"
        );
        assert_ne!(
            task_workspace_state(&store, &run, &task.id),
            WorkspaceState::Cleaned
        );
    }

    #[test]
    fn a_folder_that_went_after_the_card_is_kept_too() {
        let (repo, store, run) = setup(WorkspaceMode::Mission);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
        crate::git_ops::lifespan::remove(&repo.root, &root, false).unwrap();
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
        assert_ne!(
            store.snapshot(Some(&run.id)).unwrap().runs[0].status,
            RunStatus::Closed
        );
    }

    #[test]
    fn a_swept_task_whose_branch_is_gone_too_is_cleaned_from_its_merged_delivery() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let (task, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        store
            .refresh_workspace("chat:master", &first.task_id)
            .unwrap();
        crate::git_ops::lifespan::remove(&repo.root, &first.cwd, false).unwrap();
        store.lifespan_record_swept(&first.cwd, 100).unwrap();
        repo.git(&["branch", "-D", &first.branch]);
        assert!(!branch_exists(&repo, &first.branch));
        let card = ask(&store, &run).expect("a card for the swept task");
        assert_eq!(card.items.len(), 1, "{:?}", card.items);
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
        let state = task_workspace_state(&store, &run, &task.id);
        assert_eq!(state, WorkspaceState::Cleaned);
    }

    #[test]
    fn a_task_whose_folder_is_back_is_not_taken_for_swept_and_gone() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let (_task, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        store
            .refresh_workspace("chat:master", &first.task_id)
            .unwrap();
        crate::git_ops::lifespan::remove(&repo.root, &first.cwd, false).unwrap();
        store.lifespan_record_swept(&first.cwd, 100).unwrap();
        repo.git(&["branch", "-D", &first.branch]);
        let ws = |store: &OrchestrationStore| {
            store
                .owned_task("chat:master", &first.task_id)
                .unwrap()
                .1
                .workspace
                .unwrap()
        };
        assert_eq!(
            super::super::mission::swept_task_branch_gone(&ws(&store)),
            Ok(true)
        );
        // Only the folder comes back: the branch stays gone.
        std::fs::create_dir_all(&first.cwd).unwrap();
        let error = super::super::mission::swept_task_branch_gone(&ws(&store)).unwrap_err();
        assert!(error.contains("there again"), "{error}");
        assert!(Path::new(&first.cwd).exists(), "the folder was not touched");
    }

    #[test]
    fn a_swept_task_with_its_branch_gone_and_no_merge_recorded_is_kept() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let (task, first) = prepare(&store, &run);
        finish(&store, &first);
        crate::git_ops::lifespan::remove(&repo.root, &first.cwd, false).unwrap();
        store.lifespan_record_swept(&first.cwd, 100).unwrap();
        repo.git(&["branch", "-D", &first.branch]);
        let error = store
            .cleanup_workspace(
                &ChatManager::default(),
                "chat:master",
                &first.task_id,
                false,
                "",
            )
            .unwrap_err();
        assert!(error.contains("both gone"), "{error}");
        let state = task_workspace_state(&store, &run, &task.id);
        assert_ne!(state, WorkspaceState::Cleaned);
    }

    #[test]
    fn a_folder_that_exists_is_never_treated_as_gone() {
        let (repo, store, run) = setup(WorkspaceMode::Mission);
        let (_, first) = prepare(&store, &run);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        // The branch has an unmerged commit: still at stake, still kept.
        repo.commit(&first.cwd, "later.txt", "unmerged mission work");
        let cards = ask_named(&store, "chat:person", &[&run]).unwrap();
        assert!(cards.is_none(), "an unmerged mission is not proposed");
        assert!(Path::new(&first.cwd).exists());
    }

    fn during_the_proof(hook: impl FnOnce() + 'static) {
        crate::worktree_lifespan::AFTER_REMOVAL_PROOF
            .with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    #[test]
    fn a_run_level_gate_opened_during_the_proof_keeps_the_task_folder() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let store = std::sync::Arc::new(store);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        let (s, r) = (store.clone(), run.clone());
        during_the_proof(move || {
            s.create_gate("chat:master", r.id.clone(), None, "Keep?".into(), vec![])
                .unwrap();
            // Isolate the gate: the status alone must not be what keeps it.
            set_status(&s, &r, RunStatus::Completed);
        });
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
        assert!(
            result.items[0].reason.contains("open decision"),
            "{:?}",
            result.items
        );
        assert!(Path::new(&first.cwd).exists());
    }

    #[test]
    fn a_worker_started_in_another_task_during_the_proof_keeps_the_task_folder() {
        let (repo, store, run) = setup(WorkspaceMode::Worktree);
        let store = std::sync::Arc::new(store);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        let (s, r) = (store.clone(), run.clone());
        during_the_proof(move || {
            let _ = prepare(&s, &r);
            set_status(&s, &r, RunStatus::Completed);
        });
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
        assert!(
            result.items[0].reason.contains("worker"),
            "{:?}",
            result.items
        );
        assert!(Path::new(&first.cwd).exists());
    }

    #[test]
    fn a_run_level_gate_opened_during_the_proof_keeps_the_mission_open() {
        let (repo, store, run) = setup(WorkspaceMode::Mission);
        let store = std::sync::Arc::new(store);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        assert!(matches!(card.items[0].kind, Kind::Mission));
        let (s, r) = (store.clone(), run.clone());
        during_the_proof(move || {
            s.create_gate("chat:master", r.id.clone(), None, "Keep?".into(), vec![])
                .unwrap();
            set_status(&s, &r, RunStatus::Completed);
        });
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
        assert!(
            result.items[0].reason.contains("open decision"),
            "{:?}",
            result.items
        );
        assert!(Path::new(&first.cwd).exists());
        assert_ne!(
            store.snapshot(Some(&run.id)).unwrap().runs[0].status,
            RunStatus::Closed
        );
    }

    fn after_delivery(hook: impl FnOnce() + 'static) {
        super::super::mission::AFTER_DELIVERY
            .with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    fn after_branch_delete(hook: impl FnOnce() + 'static) {
        super::super::mission::AFTER_BRANCH_DELETE
            .with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    fn branch_exists(repo: &Repo, branch: &str) -> bool {
        crate::git_ops::lifespan::text(
            &repo.root,
            &[
                "rev-parse",
                "--verify",
                &format!("refs/heads/{branch}^{{commit}}"),
            ],
        )
        .is_ok()
    }

    #[test]
    fn a_run_level_gate_opened_after_the_delivery_read_keeps_a_gone_mission_open() {
        let (repo, store, run) = setup(WorkspaceMode::Mission);
        let store = std::sync::Arc::new(store);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
        crate::git_ops::lifespan::remove(&repo.root, &root, false).unwrap();
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        assert!(matches!(card.items[0].kind, Kind::Mission));
        let (s, r) = (store.clone(), run.clone());
        // The window is the delivery read of a gone mission (it may ask a
        // remote): no folder is removed on this path at all.
        after_delivery(move || {
            s.create_gate("chat:master", r.id.clone(), None, "Keep?".into(), vec![])
                .unwrap();
            set_status(&s, &r, RunStatus::Completed);
        });
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
        assert!(
            result.items[0].reason.contains("open decision"),
            "{:?}",
            result.items
        );
        assert_ne!(
            store.snapshot(Some(&run.id)).unwrap().runs[0].status,
            RunStatus::Closed
        );
        assert!(branch_exists(&repo, &first.branch), "the branch is kept");
    }

    #[test]
    fn a_gate_opened_after_the_branch_delete_keeps_the_mission_open_but_records_what_happened() {
        let (repo, store, run) = setup(WorkspaceMode::Mission);
        let store = std::sync::Arc::new(store);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        assert!(matches!(card.items[0].kind, Kind::Mission));
        let (s, r) = (store.clone(), run.clone());
        // The folder and the merged branch are already gone here; only the
        // closing write is left.
        after_branch_delete(move || {
            s.create_gate("chat:master", r.id.clone(), None, "Keep?".into(), vec![])
                .unwrap();
            set_status(&s, &r, RunStatus::Completed);
        });
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        // The folder did go, so the host says so, with the refusal as the reason.
        assert_eq!(result.items[0].status, "removed", "{:?}", result.items);
        assert!(
            result.items[0].reason.contains("open decision"),
            "{:?}",
            result.items
        );
        let saved = store.snapshot(Some(&run.id)).unwrap().runs[0].clone();
        assert_ne!(saved.status, RunStatus::Closed);
        assert!(saved.closed_at.is_none());
        assert!(!Path::new(&first.cwd).exists(), "the folder went");
        assert!(!branch_exists(&repo, &first.branch), "the branch went");
        assert_eq!(
            saved.mission_delivery.len(),
            1,
            "{:?}",
            saved.mission_delivery
        );
        assert!(saved.mission_delivery[0].removed);
        assert!(
            saved.mission_delivery[0].branch_deleted,
            "the saved delivery says the branch is deleted"
        );
    }

    #[test]
    fn a_run_level_gate_opened_after_the_delivery_read_keeps_a_mission_with_no_checkout_open() {
        let (_repo, store, run) = setup(WorkspaceMode::Mission);
        let store = std::sync::Arc::new(store);
        set_status(&store, &run, RunStatus::Stopped);
        let card = ask_named(&store, "chat:person", &[&run]).unwrap().unwrap();
        assert!(card.items[0].worktrees.is_empty());
        let (s, r) = (store.clone(), run.clone());
        // With no checkout there is no delivery read: the window is the end
        // of the close's Git work, before the write that marks it Closed.
        after_delivery(move || {
            s.create_gate("chat:master", r.id.clone(), None, "Keep?".into(), vec![])
                .unwrap();
            set_status(&s, &r, RunStatus::Stopped);
        });
        let result = store
            .answer_workspace_cleanup(&ChatManager::default(), &card.id, true)
            .unwrap();
        assert_eq!(result.items[0].status, "kept", "{:?}", result.items);
        assert!(
            result.items[0].reason.contains("open decision"),
            "{:?}",
            result.items
        );
        assert_ne!(
            store.snapshot(Some(&run.id)).unwrap().runs[0].status,
            RunStatus::Closed
        );
    }

    #[test]
    fn a_mission_whose_container_moved_away_is_kept_not_closed() {
        let (repo, store, run) = setup(WorkspaceMode::Mission);
        let (_, first) = prepare(&store, &run);
        merged(&repo, &first);
        finish(&store, &first);
        set_status(&store, &run, RunStatus::Completed);
        let root = first.cwd.trim_end_matches(['/', '\\']).to_string();
        let container = Path::new(&root).parent().unwrap().to_path_buf();
        let moved = container.with_file_name(format!(
            "{}-offline",
            container.file_name().unwrap().to_string_lossy()
        ));
        fs::rename(&container, &moved).unwrap();
        // The checkout is not found, but its folder is gone too: unknown, not swept.
        assert!(ask_named(&store, "chat:person", &[&run])
            .map(|card| card.is_none())
            .unwrap_or(true));
        let error = store
            .close_mission(&ChatManager::default(), "chat:master", &run.id, false)
            .unwrap_err();
        assert!(error.contains("not confirmed"), "{error}");
        assert_ne!(
            store.snapshot(Some(&run.id)).unwrap().runs[0].status,
            RunStatus::Closed
        );
        assert!(moved.exists(), "nothing was touched");
    }
}

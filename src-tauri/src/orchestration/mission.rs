//! A mission is a run that stays open until the person closes it.
//!
//! Its tasks share one worktree per repository (`WorkspaceMode::Mission`), so
//! a follow-up lands on the branch the first task started, and "is it merged,
//! is it released" has one answer per repository instead of one per task.
//!
//! Two operations live here, both the person's, neither reachable from an
//! agent's hook:
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
    /// Close deleted the local branch. False when Git kept it.
    #[serde(default)]
    pub branch_deleted: bool,
}

/// The mission's own worktrees still standing, one per checkout.
fn mission_plans(data: &Stored, run_id: &str) -> Vec<WorkspacePlan> {
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

fn delivery_of(run: &Run, plan: &WorkspacePlan) -> Result<MissionDelivery, String> {
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
        branch_deleted: false,
    })
}

/// Why a mission whose record allows a close would still be refused, from a
/// local look at its worktrees and the merge the last refresh recorded.
fn close_blocker(run: &Run, plans: &[WorkspacePlan]) -> Option<String> {
    for plan in plans {
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
            .map(|plan| delivery_of(&run, plan))
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
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let (run, plans, workers) = self.mutate(|data| {
            let run = coordinator(data, run_id, actor)?.clone();
            let plans = closable_plans(data, &run, abandon)?;
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

        let outcome = (|| -> Result<Vec<MissionDelivery>, String> {
            for key in &workers {
                crate::agent_chat::chat_stop_impl(chats, key.clone())?;
            }
            let mut done = Vec::new();
            for plan in &plans {
                chats.require_checkout_idle(&plan.checkout_root, plan.is_managed_worktree())?;
                let mut delivery = delivery_of(&run, plan)?;
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
                workflow::cleanup(plan, &delivery.evidence.head_sha)?;
                delivery.removed = true;
                if delivery.merged {
                    delivery.branch_deleted = workflow::delete_merged_branch(plan)?;
                }
                done.push(delivery);
            }
            Ok(done)
        })();

        let result = self.mutate(|data| {
            let removed: BTreeSet<String> = match &outcome {
                Ok(done) => done.iter().map(|d| d.checkout_root.clone()).collect(),
                Err(_) => plans
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
                if outcome.is_ok()
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
            if let Ok(done) = &outcome {
                run.status = RunStatus::Closed;
                run.closed_at = Some(now_ms());
                run.abandoned = abandon;
                run.mission_delivery = done.clone();
            }
            run.updated_at = now_ms();
            Ok(run.clone())
        })?;
        announce(run_id, "mission_closed");
        outcome.map(|_| result)
    }
}

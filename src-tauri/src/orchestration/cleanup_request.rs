//! A coordinator may propose one exact batch; only the person's socket answers.
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
    /// A mission owns all these roots together. An empty mission can close
    /// its record without removing any folder.
    pub worktrees: Vec<Worktree>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
    pub id: String,
    pub chat_key: String,
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
        let head = if Path::new(&plan.checkout_root).exists() {
            crate::git_ops::lifespan::text(&plan.checkout_root, &["rev-parse", "HEAD"])?
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

fn worktree(plan: &WorkspacePlan, head: &str) -> Worktree {
    Worktree {
        branch: plan.branch.clone(),
        path: plan.checkout_root.clone(),
        head_commit: head.into(),
        base_branch: plan.base_branch.clone(),
        ignored_file_count: crate::worktree_lifespan::at_stake_ignored_count(&plan.checkout_root),
        plan: plan.clone(),
    }
}

impl OrchestrationStore {
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
        crate::profile::available()?;
        let runs = self.cleanup_request_runs(actor, run_id)?;
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
                if self.refresh_workspace(actor, &task.id).is_err()
                    && self.refresh_swept_cleanup_task(actor, &task.id).is_err()
                {
                    continue;
                }
                let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
                let (_, task) = self.owned_task(actor, &task.id)?;
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
                let tree = worktree(&ws.plan, &evidence.head_sha);
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
                    worktrees: vec![tree],
                });
            }
            if run.workspace_mode != WorkspaceMode::Mission
                || self.refresh_mission(actor, &run.id).is_err()
            {
                continue;
            }
            if !self
                .coordinated_runs(actor)?
                .iter()
                .any(|r| r.run_id == run.id && r.close_eligible)
            {
                continue;
            }
            let (run, plans) = {
                let inner = self.inner.lock().map_err(|e| e.to_string())?;
                let run = coordinator(&inner.data, &run.id, actor)?.clone();
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
                    let tree = worktree(plan, &delivery.evidence.head_sha);
                    Some(tree)
                })
                .collect();
            if let Some(worktrees) = trees {
                items.push(Item {
                    id: format!("mission:{}", run.id),
                    kind: Kind::Mission,
                    run_id: run.id,
                    task_id: None,
                    title: run.objective,
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
                    self.cleanup_request_runs(&asked.chat_key, Some(&item.run_id))?;
                    match item.kind {
                        Kind::TaskWorktree => {
                            let tree = item
                                .worktrees
                                .first()
                                .ok_or("The card has no task workspace.")?;
                            self.cleanup_workspace_expected(
                                chats,
                                &asked.chat_key,
                                item.task_id.as_deref().ok_or("The card has no task id.")?,
                                false,
                                &tree.head_commit,
                                Some(&tree.plan),
                            )
                            .map(|_| ())
                        }
                        Kind::Mission => self
                            .close_mission_expected(
                                chats,
                                &asked.chat_key,
                                &item.run_id,
                                false,
                                Some(&item.worktrees),
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
}

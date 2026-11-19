use super::*;

/// Who an open gate waits for. The person, when the host knows only they
/// can answer: a gate on a peer-request task, which no agent resolves
/// (`PERSONS_GATE`), and a gate the run's coordinator opened itself, which
/// is that coordinator asking for a decision it will not make alone. Any
/// other gate is a worker's question to its coordinator, which may resolve
/// it.
fn gate_awaits(data: &Stored, gate: &Gate) -> Awaits {
    let peer_request = gate
        .task_id
        .as_ref()
        .and_then(|id| data.tasks.get(id))
        .is_some_and(|task| task.peer_request.is_some());
    let by_coordinator = data
        .runs
        .get(&gate.run_id)
        .is_some_and(|run| run.coordinator_chat_key == gate.created_by_chat_key);
    if peer_request || by_coordinator {
        Awaits::Person
    } else {
        Awaits::Coordinator
    }
}

impl OrchestrationStore {
    /// The roots whose Git history a snapshot of these runs reads, under a
    /// short hold of the lock that copies the paths and nothing else.
    pub(super) fn task_roots(
        &self,
        run_id: Option<&str>,
        wanted: Option<&BTreeSet<String>>,
    ) -> Result<BTreeSet<String>, String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        Ok(inner
            .data
            .tasks
            .values()
            .filter_map(|task| {
                let run = inner.data.runs.get(&task.run_id)?;
                let shown = run_id.is_none_or(|id| run.id == id)
                    && wanted.is_none_or(|ids| ids.contains(&run.id))
                    && run.plan_approval.is_some();
                shown.then(|| workspaces::task_root(run, task.destination.as_ref()).to_owned())
            })
            .collect())
    }

    pub fn snapshot(&self, run_id: Option<&str>) -> Result<Snapshot, String> {
        self.snapshot_in(run_id, None, true)
    }

    /// Which runs a whole-app summary shows, and the routing facts it carries
    /// for every run, worked out from the ledger's own rows under one short
    /// hold of its lock: nothing is cloned, derived or serialised for a run
    /// the summary will not show. The same rules `summary::select` applies to
    /// a full snapshot (its test compares the two).
    pub fn summary_scope(
        &self,
        run_id: Option<&str>,
        include_ended: bool,
        held_chats: &[String],
        coordinator: Option<&str>,
        workspace: Option<&str>,
    ) -> Result<summary::Scope, String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let data = &inner.data;
        let runs = || {
            data.runs
                .values()
                .filter(|run| run_id.is_none_or(|id| run.id == id))
        };
        // Routing identity outlives a run's visibility.
        let coordinators: BTreeMap<&str, &str> = runs()
            .map(|run| (run.id.as_str(), run.coordinator_chat_key.as_str()))
            .collect();
        let run_coordinators: BTreeSet<String> =
            coordinators.values().map(|key| (*key).to_owned()).collect();
        // Attempts in the snapshot's order, so a worker with several
        // attempts is routed by the latest, as the full read does.
        let mut attempts: Vec<_> = data
            .attempts
            .values()
            .filter(|attempt| coordinators.contains_key(attempt.run_id.as_str()))
            .collect();
        attempts.sort_by_key(|attempt| (attempt.created_at, attempt.id.as_str()));
        let mut worker_parents = BTreeMap::new();
        let mut held_runs = BTreeSet::new();
        for attempt in attempts {
            let parent = coordinators[attempt.run_id.as_str()];
            worker_parents.insert(
                attempt
                    .worker_chat_key
                    .trim_start_matches("chat:")
                    .to_owned(),
                parent.trim_start_matches("chat:").to_owned(),
            );
            if held_chats
                .iter()
                .any(|held| *held == attempt.worker_chat_key)
            {
                held_runs.insert(attempt.run_id.as_str());
            }
        }
        let wanted = runs()
            .filter(|run| {
                coordinator.is_none_or(|key| run.coordinator_chat_key == key)
                    && workspace.is_none_or(|id| run.workspace_id == id)
            })
            .filter(|run| {
                include_ended
                    || (run.archived_at.is_none()
                        && run.status != RunStatus::Closed
                        && run.status != RunStatus::Stopped)
                    || held_runs.contains(run.id.as_str())
            })
            .map(|run| run.id.clone())
            .collect();
        Ok(summary::Scope {
            wanted,
            run_coordinators: run_coordinators.into_iter().collect(),
            worker_parents,
        })
    }

    /// The snapshot of exactly the runs `scope` names.
    pub fn snapshot_scoped(
        &self,
        run_id: Option<&str>,
        scope: &summary::Scope,
    ) -> Result<Snapshot, String> {
        self.snapshot_in(run_id, Some(&scope.wanted), true)
    }

    /// Background monitoring reads only the runs it can act on and never
    /// reads task reports. The full public snapshot keeps its old contract.
    pub(super) fn snapshot_in(
        &self,
        run_id: Option<&str>,
        wanted: Option<&BTreeSet<String>>,
        reports: bool,
    ) -> Result<Snapshot, String> {
        self.capture_native_decisions()?;
        let scheduling = crate::scheduling::load().ok();
        // What costs a process or a file read is asked before the ledger's
        // lock is taken: every chat start, every tab and the scheduler wait
        // on that lock, and asked under it they waited for seconds.
        let mut workspace_git: BTreeMap<String, bool> = self
            .task_roots(run_id, wanted)?
            .into_iter()
            .map(|root| {
                let git = crate::git_ops::workflow::has_git_cached(&root);
                (root, git)
            })
            .collect();
        retry::warm(&self.listed_chats);
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let mut runs: Vec<_> = inner
            .data
            .runs
            .values()
            .filter(|run| run_id.is_none_or(|id| run.id == id))
            .filter(|run| wanted.is_none_or(|ids| ids.contains(&run.id)))
            .cloned()
            .collect();
        runs.sort_by_key(|run| std::cmp::Reverse(run.updated_at));
        for run in &mut runs {
            run.auto_plan = auto_plan::derived(&inner.data, run);
        }
        let visible: BTreeSet<_> = runs.iter().map(|run| run.id.clone()).collect();

        let mut tasks: Vec<_> = inner
            .data
            .tasks
            .values()
            .filter(|task| visible.contains(task.run_id.as_str()))
            .cloned()
            .collect();
        tasks.sort_by_key(|task| (task.created_at, task.id.clone()));
        let (mut reach, now) = (retry::Reach::over(&self.listed_chats), now_ms());
        // One Git capability read per root, shared by all tasks on this page;
        // a root that arrived since `task_roots` is asked here.
        // Why a task nobody is working on is not starting, for the page and
        // the coordinator: the plan card, not its dependencies or a slot.
        for task in &mut tasks {
            let waiting = matches!(
                task.status,
                TaskStatus::Pending | TaskStatus::Ready | TaskStatus::Failed | TaskStatus::Blocked
            );
            // `true` or `false` wherever there is a plan to be held by,
            // nothing where there is none.
            task.held_by_plan = inner
                .data
                .runs
                .get(&task.run_id)
                .filter(|run| run.plan_approval.is_some())
                .map(|run| {
                    waiting && held_by_plan(run, task, &|id| inner.data.tasks.get(id)).is_some()
                });
            task.workspace_choice = inner
                .data
                .runs
                .get(&task.run_id)
                .filter(|run| run.plan_approval.is_some())
                .map(|run| {
                    let root = workspaces::task_root(run, task.destination.as_ref());
                    let git = *workspace_git
                        .entry(root.to_string())
                        .or_insert_with(|| crate::git_ops::workflow::has_git_cached(root));
                    workspaces::choice_fact(run, task, git)
                });
            // And the other thing that holds a task whatever asks for it.
            task.held_by_reopen = workspaces::untold_reopen(task).is_some();
            // Its retries, and whose move its failure is.
            task.slot_wait = scheduling
                .as_ref()
                .and_then(|settings| scheduling::slot_wait(&inner.data, task, settings));
            retry::derive(&inner.data, task, &mut reach, now);
        }
        let mut attempts: Vec<_> = inner
            .data
            .attempts
            .values()
            .filter(|attempt| visible.contains(attempt.run_id.as_str()))
            .cloned()
            .collect();
        attempts.sort_by_key(|attempt| (attempt.created_at, attempt.id.clone()));
        let mut gates: Vec<_> = inner
            .data
            .gates
            .values()
            .filter(|gate| visible.contains(gate.run_id.as_str()))
            .cloned()
            .collect();
        gates.sort_by_key(|gate| (gate.created_at, gate.id.clone()));
        for gate in &mut gates {
            gate.awaits = (gate.status == GateStatus::Open).then(|| gate_awaits(&inner.data, gate));
        }
        let mut messages: Vec<_> = inner
            .data
            .messages
            .values()
            .filter(|message| visible.contains(message.run_id.as_str()))
            .cloned()
            .collect();
        messages.sort_by_key(|message| (message.created_at, message.id.clone()));
        let mut snapshot = Snapshot {
            batches: inner
                .data
                .batches
                .iter()
                .filter(|b| visible.contains(b.run_id.as_str()))
                .cloned()
                .collect(),
            runs,
            tasks,
            attempts,
            gates,
            messages,
            notifications: inner
                .data
                .notifications
                .values()
                .filter(|n| visible.contains(n.run_id.as_str()))
                .cloned()
                .collect(),
            reports: BTreeMap::new(),
            native_decisions: inner
                .data
                .native_decisions
                .values()
                .filter(|d| visible.contains(d.run_id.as_str()))
                .cloned()
                .collect(),
            services: inner
                .data
                .services
                .values()
                .filter(|s| visible.contains(s.run_id.as_str()))
                .cloned()
                .collect(),
            bridges: inner
                .data
                .bridges
                .values()
                .filter(|b| {
                    visible.contains(b.from_run_id.as_str())
                        || visible.contains(b.to_run_id.as_str())
                })
                .cloned()
                .collect(),
            peer_asks: {
                let mut asks: Vec<_> = inner
                    .data
                    .peer_asks
                    .values()
                    // A lead chat's ask belongs to no run when the chat
                    // coordinates none: the whole-ledger read lists it.
                    .filter(|ask| {
                        visible.contains(ask.run_id.as_str())
                            || (run_id.is_none() && ask.run_id.is_empty())
                    })
                    .cloned()
                    .collect();
                asks.sort_by_key(|ask| (ask.asked_at, ask.id.clone()));
                asks
            },
        };
        drop(inner);
        lifecycle::refresh_decision_views(&mut snapshot);
        if reports {
            snapshot.reports = crate::chat_task::reports_for_chat_keys(
                snapshot
                    .attempts
                    .iter()
                    .map(|attempt| attempt.worker_chat_key.as_str()),
            );
        }
        Ok(snapshot)
    }
}

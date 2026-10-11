//! What a registered agent has in the ledger right now, for the one question
//! a removal asks before it shows a card and again when the person answers
//! it: is any of this agent's work still running?
//!
//! A task counts as running for a removal when any of these holds:
//!
//! - it has an unsettled attempt of the agent's: being prepared, running, or
//!   blocked on an open decision (`attempt_is_unsettled`);
//! - its attempt of the agent's failed and the host's automatic retry is
//!   scheduled, so the host starts it again on its own;
//! - it is the agent's and the host is preparing or cleaning up its
//!   workspace;
//! - it is a peer request in flight that the agent asked for or is asked to
//!   do: waiting on the plan card, ready, running, or one of the above.
//!
//! A task of the agent's that is merely planned, ready, failed or blocked
//! with nothing scheduled is not running. It does not stop a removal; the
//! removal's card says how many there are, because nothing reassigns them.
//!
//! The ledger keeps a COPY of who a task was handed to (`TaskAssignee`), so
//! all of this is read by agent id and keeps working after a rename.

use super::*;

/// One run's share of an agent's work.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunWork {
    pub run_id: String,
    pub objective: String,
    pub tasks: usize,
}

/// See the module's own words for what each list holds.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentWork {
    pub running: Vec<RunWork>,
    pub unfinished: Vec<RunWork>,
}

fn count(n: usize, one: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {one}s")
    }
}

fn total(work: &[RunWork]) -> usize {
    work.iter().map(|run| run.tasks).sum()
}

impl AgentWork {
    /// Why `name` cannot be removed now, or `None` when nothing of its is
    /// running. The same words before a card and when one is answered.
    pub fn refusal(&self, name: &str) -> Option<String> {
        if self.running.is_empty() {
            return None;
        }
        let tasks = total(&self.running);
        let runs: Vec<String> = self
            .running
            .iter()
            .map(|run| format!("{} in \"{}\" ({})", run.tasks, run.objective, run.run_id))
            .collect();
        let them = if tasks == 1 { "it" } else { "them" };
        Some(format!(
            "{name} still has {} in progress in {}: {}. Nothing was removed. Stop {them} or wait for {them} to finish, then remove {name}.",
            count(tasks, "task"),
            count(self.running.len(), "run"),
            runs.join(", "),
        ))
    }

    /// What a removal's card says of the agent's unfinished tasks, which it
    /// does not stop for: nothing hands them to anyone else. The note is the
    /// row whole, and the summary its count on one line.
    pub fn unfinished_note(&self) -> Option<crate::team_tools::Unfinished> {
        if self.unfinished.is_empty() {
            return None;
        }
        let tasks = total(&self.unfinished);
        let (name, each) = if tasks == 1 {
            ("names", "It starts")
        } else {
            ("name", "Each starts")
        };
        let summary = format!(
            "{} in {} still {name} it",
            count(tasks, "unfinished task"),
            count(self.unfinished.len(), "run"),
        );
        Some(crate::team_tools::Unfinished {
            note: format!(
                "{summary} and will have no registered agent behind {}. {each} without its role, brief and memory unless you reassign it first.",
                if tasks == 1 { "it" } else { "them" },
            ),
            summary,
        })
    }
}

/// The objective as a removal names it: one line, short.
fn named(objective: &str) -> String {
    let line = objective.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= 60 {
        line
    } else {
        format!("{}…", line.chars().take(59).collect::<String>())
    }
}

fn is(assignee: Option<&TaskAssignee>, agent_id: &str) -> bool {
    assignee.is_some_and(|assignee| assignee.id == agent_id)
}

fn running(data: &Stored, run: &Run, task: &Task, agent_id: &str) -> bool {
    let mine = is(task.assignee.as_ref(), agent_id);
    let mut attempts = data
        .attempts
        .values()
        .filter(|attempt| attempt.task_id == task.id && is(attempt.assignee.as_ref(), agent_id));
    if attempts.any(|attempt| attempt_is_unsettled(data, attempt)) {
        return true;
    }
    let live = !run_has_ended(run);
    let retrying = live
        && task
            .active_attempt_id
            .as_deref()
            .and_then(|id| data.attempts.get(id))
            .is_some_and(|attempt| {
                is(attempt.assignee.as_ref(), agent_id)
                    && attempt.status == AttemptStatus::Failed
                    && attempt.execution.next_retry_at.is_some()
            });
    let workspace = mine
        && task.workspace.as_ref().is_some_and(|ws| {
            matches!(
                ws.state,
                workspaces::WorkspaceState::Preparing | workspaces::WorkspaceState::Cleaning
            )
        });
    let request = live
        && task.peer_request.as_ref().is_some_and(|request| {
            (mine || request.requested_by.id == agent_id)
                && (matches!(
                    task.status,
                    TaskStatus::Pending | TaskStatus::Ready | TaskStatus::Running
                ) || data.attempts.values().any(|attempt| {
                    attempt.task_id == task.id
                        && (attempt_is_unsettled(data, attempt)
                            || (attempt.status == AttemptStatus::Failed
                                && attempt.execution.next_retry_at.is_some()))
                }))
        });
    retrying || workspace || request
}

fn unfinished(run: &Run, task: &Task, agent_id: &str) -> bool {
    is(task.assignee.as_ref(), agent_id)
        && !run_has_ended(run)
        && run.archived_at.is_none()
        && task.superseded_by.is_none()
        && matches!(
            task.status,
            TaskStatus::Pending | TaskStatus::Ready | TaskStatus::Failed | TaskStatus::Blocked
        )
}

fn work_in(data: &Stored, agent_id: &str) -> AgentWork {
    let mut work = AgentWork::default();
    let mut runs: Vec<&Run> = data.runs.values().collect();
    runs.sort_by_key(|run| (run.created_at, run.id.clone()));
    for run in runs {
        let (mut busy, mut waiting) = (0, 0);
        for task in data.tasks.values().filter(|task| task.run_id == run.id) {
            if running(data, run, task, agent_id) {
                busy += 1;
            } else if unfinished(run, task, agent_id) {
                waiting += 1;
            }
        }
        let share = |tasks| RunWork {
            run_id: run.id.clone(),
            objective: named(&run.objective),
            tasks,
        };
        if busy > 0 {
            work.running.push(share(busy));
        }
        if waiting > 0 {
            work.unfinished.push(share(waiting));
        }
    }
    work
}

impl OrchestrationStore {
    /// What the agent `agent_id` has running, and what it has unfinished. A
    /// ledger that cannot be read answers with its error: a removal is not
    /// made on a question nobody could ask.
    pub fn agent_work(&self, agent_id: &str) -> Result<AgentWork, String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        Ok(work_in(&inner.data, agent_id))
    }

    /// `agent_work`, as a removal asks it: an error naming what is running,
    /// else what its card should say of the unfinished tasks, if any.
    pub fn removal_of(
        &self,
        agent_id: &str,
        name: &str,
    ) -> Result<Option<crate::team_tools::Unfinished>, String> {
        let work = self.agent_work(agent_id)?;
        match work.refusal(name) {
            Some(refusal) => Err(refusal),
            None => Ok(work.unfinished_note()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{launch_for, running_worker_of, task_of};
    use super::*;

    fn who(name: &str) -> TaskAssignee {
        TaskAssignee {
            id: format!("agent_{}", name.to_lowercase()),
            name: name.into(),
        }
    }

    /// A run with room for every worker a test starts in it.
    fn wide(store: &OrchestrationStore, chat: &str, objective: &str) -> Run {
        store
            .create_run(
                chat.into(),
                objective.into(),
                "workspace".into(),
                "/tmp".into(),
                Some(8),
            )
            .unwrap()
    }

    fn report(store: &OrchestrationStore, attempt: &Attempt, outcome: WorkerOutcome) {
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id.clone(),
                    outcome,
                    summary: "Reported".into(),
                    files_modified: Vec::new(),
                    verdict: None,
                },
            )
            .unwrap();
    }

    /// agent_delete review, M3 (the person's decision of 2026-10-11): what
    /// counts as running is every unsettled attempt of the agent's, said by
    /// how many tasks and in which runs.
    #[test]
    fn work_in_flight_is_counted_by_task_and_named_by_run() {
        let store = OrchestrationStore::default();
        let (ada, bo) = (who("Ada"), who("Bo"));
        let first = wide(&store, "chat:master", "Ship the feature");
        let second = wide(&store, "chat:other", "Fix the\n   build");
        store
            .mutate(|data| {
                data.runs.get_mut(&second.id).unwrap().created_at += 10;
                Ok(())
            })
            .unwrap();
        // Ada, in the first run: one running, one being prepared, one
        // blocked on an open decision, and one not started.
        running_worker_of(&store, &first, &ada);
        let preparing = task_of(&store, &first, &ada);
        let (_, _, reserved, _) = store
            .reserve_attempt("chat:master", &launch_for(&preparing.id))
            .unwrap();
        assert_eq!(reserved.status, AttemptStatus::Preparing);
        let gated = running_worker_of(&store, &first, &ada);
        store
            .create_gate(
                &gated.worker_chat_key,
                first.id.clone(),
                Some(gated.task_id.clone()),
                "Which way?".into(),
                vec![],
            )
            .unwrap();
        task_of(&store, &first, &ada);
        // Bo works beside it, and Ada has one more in another run.
        running_worker_of(&store, &first, &bo);
        running_worker_of(&store, &second, &ada);

        let work = store.agent_work(&ada.id).unwrap();
        let share = |run: &Run, objective: &str, tasks| RunWork {
            run_id: run.id.clone(),
            objective: objective.into(),
            tasks,
        };
        assert_eq!(
            work.running,
            [
                share(&first, "Ship the feature", 3),
                share(&second, "Fix the build", 1)
            ]
        );
        assert_eq!(work.unfinished, [share(&first, "Ship the feature", 1)]);
        let refusal = format!(
            "Ada still has 4 tasks in progress in 2 runs: 3 in \"Ship the feature\" ({}), 1 in \"Fix the build\" ({}). Nothing was removed. Stop them or wait for them to finish, then remove Ada.",
            first.id, second.id
        );
        assert_eq!(work.refusal("Ada"), Some(refusal.clone()));
        assert_eq!(store.removal_of(&ada.id, "Ada"), Err(refusal));
        assert_eq!(
            store.removal_of(&bo.id, "Bo"),
            Err(format!(
                "Bo still has 1 task in progress in 1 run: 1 in \"Ship the feature\" ({}). Nothing was removed. Stop it or wait for it to finish, then remove Bo.",
                first.id
            ))
        );
        // Read by id: nobody else, and nobody by a name alone, is busy.
        assert_eq!(store.agent_work("agent_cy").unwrap(), AgentWork::default());
        assert_eq!(store.removal_of("Ada", "Ada"), Ok(None));

        // Stopping the runs is one of the two things the refusal offers.
        store
            .stop_run("chat:master", first.id.clone(), "Not now".into())
            .unwrap();
        store
            .stop_run("chat:other", second.id.clone(), "Not now".into())
            .unwrap();
        assert_eq!(store.agent_work(&ada.id).unwrap(), AgentWork::default());
        assert_eq!(store.removal_of(&bo.id, "Bo"), Ok(None));
    }

    /// A retry the host has scheduled is work it will start on its own.
    /// Work that settled, and work nobody has started, is not running: it
    /// does not stop a removal, and the card says how much of it there is.
    #[test]
    fn a_scheduled_retry_is_running_and_settled_or_planned_work_is_not() {
        let store = OrchestrationStore::default();
        let ada = who("Ada");
        let run = wide(&store, "chat:master", "Ship the feature");
        let done = running_worker_of(&store, &run, &ada);
        report(&store, &done, WorkerOutcome::Completed);
        let failed = running_worker_of(&store, &run, &ada);
        report(&store, &failed, WorkerOutcome::Failed);
        let stuck = running_worker_of(&store, &run, &ada);
        report(&store, &stuck, WorkerOutcome::Blocked);
        task_of(&store, &run, &ada);
        assert_eq!(
            store.removal_of(&ada.id, "Ada"),
            Ok(Some(crate::team_tools::Unfinished {
                note: "3 unfinished tasks in 1 run still name it and will have no registered agent behind them. Each starts without its role, brief and memory unless you reassign it first.".into(),
                summary: "3 unfinished tasks in 1 run still name it".into(),
            }))
        );

        // A provider failure the host retries by itself.
        let retried = running_worker_of(&store, &run, &ada);
        store
            .observe_worker_event(
                &retried.worker_chat_key,
                &json!({"type":"turn.failed", "error":{"message":"Selected model is at capacity"}}),
            )
            .unwrap();
        let work = store.agent_work(&ada.id).unwrap();
        assert_eq!(work.running.len(), 1);
        assert_eq!(work.running[0].tasks, 1, "only the task that will retry");
        assert_eq!(work.unfinished[0].tasks, 3);
        assert!(store
            .removal_of(&ada.id, "Ada")
            .unwrap_err()
            .starts_with("Ada still has 1 task in progress in 1 run: 1 in \"Ship the feature\""));
        // The retry given up, the task is one more that is merely unfinished.
        store
            .mutate(|data| {
                let attempt = data.attempts.get_mut(&retried.id).unwrap();
                assert!(attempt.execution.next_retry_at.take().is_some());
                Ok(())
            })
            .unwrap();
        let work = store.agent_work(&ada.id).unwrap();
        assert!(work.running.is_empty());
        assert_eq!(work.unfinished[0].tasks, 4);
    }

    #[test]
    fn the_sentences_agree_in_number_and_name_a_run_in_one_short_line() {
        let one = AgentWork {
            running: Vec::new(),
            unfinished: vec![RunWork {
                run_id: "run_a".into(),
                objective: "A".into(),
                tasks: 1,
            }],
        };
        assert_eq!(one.refusal("Ada"), None);
        let said = one.unfinished_note().unwrap();
        assert_eq!(
            said.note,
            "1 unfinished task in 1 run still names it and will have no registered agent behind it. It starts without its role, brief and memory unless you reassign it first."
        );
        assert_eq!(said.summary, "1 unfinished task in 1 run still names it");
        assert_eq!(AgentWork::default().unfinished_note(), None);
        assert_eq!(named("  Two\n\nlines  "), "Two lines");
        let long = named(&"word ".repeat(40));
        assert_eq!(long.chars().count(), 60);
        assert!(long.ends_with('…'));
    }
}

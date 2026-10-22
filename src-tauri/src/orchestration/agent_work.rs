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
//! Two more things are work in progress that no task records (review of
//! 018a40a, H4), asked of the conversations the agent speaks in as itself
//! (`team::OwnChat`: the ones it leads, the head's cross-project one among
//! them, and its front-desk chat):
//!
//! - one of them coordinates a run that has neither finished nor been
//!   stopped;
//! - one of them has a turn in flight.
//!
//! A task of the agent's that is merely planned, ready, failed or blocked
//! with nothing scheduled is not running. It does not stop a removal; the
//! removal's card says how many there are, because nothing reassigns them,
//! and none of them starts as an agent that is gone. Nor does a seat the
//! agent merely holds: an idle head or front desk is removed, and the card
//! says the seat empties.
//!
//! The check and the removal are one step (`Departure`): no task of the
//! agent's starts between them.
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
            ("names", "It does not start")
        } else {
            ("name", "None of them starts")
        };
        let summary = format!(
            "{} in {} still {name} it",
            count(tasks, "unfinished task"),
            count(self.unfinished.len(), "run"),
        );
        Some(crate::team_tools::Unfinished {
            note: format!(
                "{summary}. {each} as an agent that is gone: reassign {} first, or {} until you do.",
                if tasks == 1 { "it" } else { "each one" },
                if tasks == 1 { "it waits" } else { "they wait" },
            ),
            summary,
        })
    }
}

/// Why no attempt is reserved for an agent that was removed
/// (`reserve_attempt_for`).
pub(super) fn gone_reason(name: &str) -> String {
    format!(
        "{name} is no longer a registered agent: it was removed, and nothing starts as an agent that is gone. Hand this task to another agent with orchestration_task_reassign, which goes to the person on the plan card."
    )
}

/// The run one of the agent's own conversations coordinates that has neither
/// finished nor been stopped, as a refusal. Coordinating is work in progress
/// that no task or attempt records: the coordinator is not the assignee of
/// anything in its own run.
fn coordinating(data: &Stored, name: &str, chats: &[crate::team::OwnChat]) -> Option<String> {
    let mut runs: Vec<&Run> = data
        .runs
        .values()
        .filter(|run| !run_has_ended(run) && run.archived_at.is_none())
        .filter(|run| {
            chats
                .iter()
                .any(|chat| chat.chat_key == run.coordinator_chat_key)
        })
        .collect();
    runs.sort_by_key(|run| (run.created_at, run.id.clone()));
    let first = runs.first()?;
    let more = match runs.len() - 1 {
        0 => String::new(),
        n => format!(" and {}", count(n, "other run")),
    };
    Some(format!(
        "{name} is coordinating \"{}\" ({}){more}, which {} not finished. Nothing was removed. Stop {} from its chat or wait for {} to finish, then remove {name}.",
        named(&first.objective),
        first.id,
        if runs.len() == 1 { "has" } else { "have" },
        if runs.len() == 1 { "that run" } else { "those runs" },
        if runs.len() == 1 { "it" } else { "them" },
    ))
}

/// A turn in flight in one of the agent's own conversations, as a refusal.
/// A seat that is merely held (the head, the front desk, with nothing being
/// answered) is not one: the removal's card already says the seat empties.
///
/// The look never waits for a lock, so it can come back without an answer
/// (`Turn::Unconfirmed`). The agent stays then too, and the words say what
/// is known: not that a turn is in flight, which nobody saw, but that the
/// host could not confirm the conversation is idle.
fn mid_turn(
    name: &str,
    chats: &[crate::team::OwnChat],
    in_flight: &dyn Fn(&str) -> crate::agent_chat::Turn,
) -> Option<String> {
    use crate::agent_chat::Turn;
    let (busy, seen) = chats
        .iter()
        .map(|chat| (chat, in_flight(&chat.chat_key)))
        .find(|(_, seen)| *seen != Turn::Idle)?;
    let place = if busy.front_desk {
        "its front-desk conversation"
    } else {
        "a conversation it leads"
    };
    let key = &busy.chat_key;
    Some(match seen {
        Turn::Unconfirmed => format!(
            "OctiqFlow could not confirm that {name} is idle in {place} ({key}): something else was using that conversation at that moment, so it was not looked at. Nothing was removed. Try again; if {name} is in the middle of a turn there, the answer will say so."
        ),
        _ => format!(
            "{name} is in the middle of a turn in {place} ({key}). Nothing was removed. Stop that turn or wait for it to end, then remove {name}."
        ),
    })
}

/// Everything that stops a removal, in the order it is said: tasks in
/// progress, a run being coordinated, a turn in flight. `Ok` is the agent's
/// work as the ledger has it, for the card's note.
fn in_progress(
    data: &Stored,
    agent: &crate::team::TeamAgent,
    chats: &[crate::team::OwnChat],
    in_flight: &dyn Fn(&str) -> crate::agent_chat::Turn,
) -> Result<AgentWork, String> {
    let work = work_in(data, &agent.id);
    match work
        .refusal(&agent.name)
        .or_else(|| coordinating(data, &agent.name, chats))
        .or_else(|| mid_turn(&agent.name, chats, in_flight))
    {
        Some(refusal) => Err(refusal),
        None => Ok(work),
    }
}

/// A removal as the ledger and the live chats see it: what the roster's
/// `delete` is made under (`team::Leave`).
///
/// LOCK ORDER, the only one: the roster's lock (`team.rs` `LOCK`), then this
/// ledger's (`OrchestrationStore::inner`). `team::delete_checked` takes the
/// first and calls `leave`, which takes the second and holds it across the
/// roster's write. `reserve_attempt_for` takes only the second. Nothing
/// that holds the ledger's lock calls into `team.rs`.
///
/// The chats' locks come after both and are never waited for from here.
/// `leave` sets the agent's mark in the chat manager's table before it takes
/// the ledger (a leaf lock, held for the insert alone), and under the ledger
/// it asks each conversation with `try_lock` only (`LeavingMark::working`):
/// the session table, the queue, the session. A chat that writes a prompt
/// holds its session's lock and reads the mark there; a chat that starts
/// holds the session table's and reads the manager's table. Whatever else
/// a chat holds or waits for meanwhile, the removal waits for none of it: a
/// chat lock that is taken answers "working", the removal is refused, and
/// its two locks are let go. So nothing here can wait in a ring.
///
/// So a removal and a turn in one of the agent's own conversations exclude
/// each other too (`agent_chat::Leaving`): the turn first, and the removal
/// finds it in flight and is refused; the removal first, and the prompt
/// finds the mark and is refused.
///
/// So a removal and a start of the agent's work exclude each other, and
/// whichever takes the ledger first wins. The start first: its attempt is
/// work in progress and the removal is refused. The removal first: the
/// agent is saved into `Stored::removed_agents` and then written out of the
/// roster before the lock is let go (`OrchestrationStore::leave`, which
/// says what each failure leaves), and the start is refused
/// (`gone_reason`).
pub struct Departure<'a> {
    pub store: &'a OrchestrationStore,
    pub chats: &'a ChatManager,
}

impl Departure<'_> {
    /// Before a card is shown: an error naming what is in progress, else
    /// what the card should say of the agent's unfinished tasks, if any.
    pub fn check(
        &self,
        agent: &crate::team::TeamAgent,
        chats: &[crate::team::OwnChat],
    ) -> Result<Option<crate::team_tools::Unfinished>, String> {
        let inner = self.store.inner.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let in_flight = |key: &str| self.chats.turn_may_be_in_flight(key);
        in_progress(&inner.data, agent, chats, &in_flight).map(|work| work.unfinished_note())
    }
}

impl crate::team::Leave for Departure<'_> {
    fn leave(
        &self,
        agent: &crate::team::TeamAgent,
        chats: &[crate::team::OwnChat],
        write: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        // Mark first, then look (`agent_chat::Leaving`): from here no
        // process is started for one of the agent's conversations, and each
        // live one takes the mark in the look that finds it idle. Dropped on
        // any refusal or failure below, which calls it off.
        let keys: Vec<String> = chats.iter().map(|chat| chat.chat_key.clone()).collect();
        let mark = self.chats.mark_leaving(&agent.name, &keys);
        self.store
            .leave(agent, chats, &|key: &str| mark.look(key), write)?;
        mark.gone();
        Ok(())
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

    /// Remove an agent from the roster, or refuse, in one hold of this
    /// ledger's lock (see [`Departure`] for the order of the locks). `write`
    /// writes the roster without the agent; it runs only when nothing of the
    /// agent's is in progress.
    ///
    /// **A removal is done only when its record is** (review of 931b5f0,
    /// H3). Two files change, and the order is the one whose every failure
    /// leaves the agent registered and able to work:
    ///
    /// 1. The ledger is saved with the agent in `removed_agents`. If that
    ///    fails the removal is refused: the roster was never touched, and
    ///    neither the ledger on disk nor the one in memory says it is gone.
    /// 2. The roster is written without the agent. If that fails the record
    ///    is taken back: the ledger is saved again without it, and the
    ///    refusal says so if even that could not be saved. This process
    ///    never took the record up, so it keeps starting the agent's work.
    /// 3. Only then does this process take the record up.
    ///
    /// A server killed between 1 and 2, or a record that could not be taken
    /// back, leaves a ledger that calls gone an agent the roster still has.
    /// The roster is right, and `reconcile_removed` drops the record when the
    /// ledger is next loaded.
    pub(crate) fn leave(
        &self,
        agent: &crate::team::TeamAgent,
        chats: &[crate::team::OwnChat],
        in_flight: &dyn Fn(&str) -> crate::agent_chat::Turn,
        write: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        in_progress(&inner.data, agent, chats, in_flight)?;
        let name = &agent.name;
        let mut recorded = inner.data.clone();
        recorded.removed_agents.insert(agent.id.clone(), now_ms());
        self.persist(&recorded).map_err(|error| {
            format!("{name} was not removed: the ledger could not record the removal, so nothing was changed ({error}). {name} is still registered and its work still starts. Fix what stops the ledger from being saved, then remove {name} again.")
        })?;
        if let Err(error) = write() {
            return Err(match self.persist(&inner.data) {
                Ok(()) => format!(
                    "{name} was not removed: the roster could not be written ({error}). Nothing was changed, and {name} is still registered."
                ),
                Err(kept) => format!(
                    "{name} was not removed: the roster could not be written ({error}). The ledger's record of the removal could not be taken back either ({kept}), so the ledger on disk still says {name} was removed. {name} is still registered and its work still starts; the record is dropped the next time the ledger is saved, and when the server next starts."
                ),
            });
        }
        inner.data = recorded;
        Ok(())
    }

    /// Drop every record of a removal whose agent the roster still has, and
    /// answer their ids. Run once, when the ledger is loaded
    /// (`dispatch::Services::load`).
    ///
    /// It is the one inconsistent state `leave` can leave behind: the record
    /// saved, the roster not written. The agent exists, so its work starts.
    /// The roster is read under its own lock, which is taken before this
    /// ledger's as everywhere. A roster that cannot be read changes nothing:
    /// "could not be read" is never taken for "everyone is still here", and
    /// it is never taken for "everyone is gone" either, because nothing here
    /// adds a record.
    pub fn reconcile_removed(&self, roster: &std::path::Path) -> Result<Vec<String>, String> {
        crate::team::with_registered(roster, |registered| {
            let mut inner = self.inner.lock().map_err(|error| error.to_string())?;
            if let Some(error) = &inner.load_error {
                return Err(error.clone());
            }
            let back: Vec<String> = inner
                .data
                .removed_agents
                .keys()
                .filter(|id| registered.contains(*id))
                .cloned()
                .collect();
            if back.is_empty() {
                return Ok(back);
            }
            for id in &back {
                inner.data.removed_agents.remove(id);
                eprintln!(
                    "orchestration: the ledger said {id} was removed, but the roster still has it: a removal was interrupted before the roster was written. The record was dropped; the agent is registered."
                );
            }
            // Memory follows the roster whether or not this is saved: the
            // next write saves it, and so does the next load.
            if let Err(error) = self.persist(&inner.data) {
                eprintln!("orchestration: the ledger could not be saved after that: {error}");
            }
            Ok(back)
        })?
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

    /// A ledger-only run whose simulated workers own separate worktrees.
    fn wide(store: &OrchestrationStore, chat: &str, objective: &str) -> Run {
        store
            .create_run_with_mode(
                chat.into(),
                objective.into(),
                "workspace".into(),
                "/tmp".into(),
                Some(8),
                WorkspaceMode::Worktree,
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
                note: "3 unfinished tasks in 1 run still name it. None of them starts as an agent that is gone: reassign each one first, or they wait until you do.".into(),
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
            "1 unfinished task in 1 run still names it. It does not start as an agent that is gone: reassign it first, or it waits until you do."
        );
        assert_eq!(said.summary, "1 unfinished task in 1 run still names it");
        assert_eq!(AgentWork::default().unfinished_note(), None);
        assert_eq!(named("  Two\n\nlines  "), "Two lines");
        let long = named(&"word ".repeat(40));
        assert_eq!(long.chars().count(), 60);
        assert!(long.ends_with('…'));
    }

    fn roster() -> (crate::test_dir::TestDir, std::path::PathBuf) {
        let dir = crate::test_dir::TestDir::new("m2-departure");
        let path = dir.0.join("team.json");
        (dir, path)
    }

    fn registered(path: &std::path::Path, name: &str) -> crate::team::TeamAgent {
        crate::team::save(
            path,
            serde_json::from_value(json!({
                "name": name, "role": "Works", "agent": "codex", "model": "gpt-5.6-terra",
            }))
            .unwrap(),
        )
        .unwrap()
    }

    fn names(path: &std::path::Path) -> Vec<String> {
        crate::team::list(path, None, true)
            .unwrap()
            .into_iter()
            .map(|agent| agent.name)
            .collect()
    }

    fn as_assignee(agent: &crate::team::TeamAgent) -> TaskAssignee {
        TaskAssignee {
            id: agent.id.clone(),
            name: agent.name.clone(),
        }
    }

    /// A removal that does something of the test's between the moment the
    /// agent's work was read and found idle and the moment the roster is
    /// written: the window the review of 018a40a (H3) started a task in.
    struct Midway<'a, F: Fn()> {
        departure: &'a Departure<'a>,
        then: F,
    }

    impl<F: Fn()> crate::team::Leave for Midway<'_, F> {
        fn leave(
            &self,
            agent: &crate::team::TeamAgent,
            chats: &[crate::team::OwnChat],
            write: &mut dyn FnMut() -> Result<(), String>,
        ) -> Result<(), String> {
            crate::team::Leave::leave(self.departure, agent, chats, &mut || {
                (self.then)();
                write()
            })
        }
    }

    /// Review H3, the probe: the idle read is done, then another thread asks
    /// to start a task of the agent's, then the removal is written. The
    /// start does not get in between: it waits for the removal and is then
    /// refused, in words that say the agent is gone. Exactly one of the two
    /// went through.
    #[test]
    fn a_start_that_arrives_while_an_agent_is_being_removed_waits_and_is_refused() {
        let (_dir, path) = roster();
        let dev = registered(&path, "Dev");
        let store = OrchestrationStore::default();
        let run = wide(&store, "chat:master", "Ship the feature");
        let task = task_of(&store, &run, &as_assignee(&dev));
        let chats = ChatManager::default();
        let departure = Departure {
            store: &store,
            chats: &chats,
        };
        std::thread::scope(|scope| {
            let asked = std::sync::Mutex::new(None);
            let midway = Midway {
                departure: &departure,
                then: || {
                    let start = scope.spawn(|| {
                        store
                            .reserve_attempt("chat:master", &launch_for(&task.id))
                            .map(|_| ())
                    });
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    assert!(!start.is_finished(), "the start waits for the removal");
                    *asked.lock().unwrap() = Some(start);
                },
            };
            crate::team::delete_idle(&path, &dev.id, &midway).unwrap();
            let start = asked.lock().unwrap().take().expect("the start was asked");
            let refused = start.join().unwrap().unwrap_err();
            assert_eq!(refused, gone_reason("Dev"));
            assert!(
                refused.starts_with("Dev is no longer a registered agent"),
                "{refused}"
            );
        });
        assert!(names(&path).is_empty(), "the removal went through");
        assert!(store.snapshot(None).unwrap().attempts.is_empty());
        assert!(store.agent_work(&dev.id).unwrap().running.is_empty());
    }

    /// The other order: the start takes the ledger first, so it is work in
    /// progress by the time the removal asks, and the removal is the one
    /// refused. Then, once the agent is gone, nothing of its starts until it
    /// is handed to someone else, and a restart does not forget that.
    #[test]
    fn a_start_and_a_removal_exclude_each_other_and_a_gone_agent_starts_nothing() {
        let (dir, path) = roster();
        let dev = registered(&path, "Dev");
        let store = OrchestrationStore::load(dir.0.join("orchestrations.json"));
        let run = wide(&store, "chat:master", "Ship the feature");
        let first = task_of(&store, &run, &as_assignee(&dev));
        let later = task_of(&store, &run, &as_assignee(&dev));
        let chats = ChatManager::default();
        let departure = Departure {
            store: &store,
            chats: &chats,
        };
        let (_, _, attempt, _) = store
            .reserve_attempt("chat:master", &launch_for(&first.id))
            .unwrap();
        let refused = crate::team::delete_idle(&path, &dev.id, &departure).unwrap_err();
        assert!(
            refused.starts_with("Dev still has 1 task in progress in 1 run"),
            "{refused}"
        );
        assert_eq!(names(&path), ["Dev"]);
        // It fails before it has a workspace; nothing of Dev's is running.
        store
            .fail_preparation(
                &attempt.id,
                "no workspace".into(),
                String::new(),
                String::new(),
                false,
            )
            .unwrap();
        crate::team::delete_idle(&path, &dev.id, &departure).unwrap();
        assert!(names(&path).is_empty());
        for task in [&first, &later] {
            let refused = store
                .reserve_attempt("chat:master", &launch_for(&task.id))
                .unwrap_err();
            assert_eq!(refused, gone_reason("Dev"));
        }
        drop(store);
        let store = OrchestrationStore::load(dir.0.join("orchestrations.json"));
        let refused = store
            .reserve_attempt("chat:master", &launch_for(&later.id))
            .unwrap_err();
        assert_eq!(refused, gone_reason("Dev"), "kept across a restart");
        // Handed to an agent that exists, it starts.
        let ops = registered(&path, "Ops");
        store
            .reassign_task(
                "chat:master",
                &later.id,
                (None, Some(as_assignee(&ops)), None),
                "Dev was removed.".into(),
            )
            .unwrap();
        let (_, _, attempt, _) = store
            .reserve_attempt("chat:master", &launch_for(&later.id))
            .unwrap();
        assert_eq!(attempt.assignee, Some(as_assignee(&ops)));
    }

    /// A ledger in a folder of its own, with one agent and two tasks of its.
    fn ledger_of_dev() -> (
        crate::test_dir::TestDir,
        std::path::PathBuf,
        std::path::PathBuf,
        crate::team::TeamAgent,
        [Task; 2],
    ) {
        let (dir, path) = roster();
        let dev = registered(&path, "Dev");
        let ledger = dir.0.join("ledger").join("orchestrations.json");
        let store = OrchestrationStore::load(ledger.clone());
        let run = wide(&store, "chat:master", "Ship the feature");
        let tasks = [
            task_of(&store, &run, &as_assignee(&dev)),
            task_of(&store, &run, &as_assignee(&dev)),
        ];
        (dir, path, ledger, dev, tasks)
    }

    /// Review of 931b5f0, H3: a removal is done only when its record is. The
    /// ledger cannot be saved (`broken`), so the removal is refused in words
    /// that say why, the roster still has the agent, and nothing is refused
    /// as "gone" afterwards: not in this process and not in the next, which
    /// reads the ledger as it was. Mended, the removal goes through and a
    /// restart keeps it.
    fn refused_while_the_ledger_cannot_be_saved(
        broken: impl Fn(&std::path::Path),
        mended: impl Fn(&std::path::Path),
    ) {
        let (_dir, path, ledger, dev, [first, later]) = ledger_of_dev();
        let store = OrchestrationStore::load(ledger.clone());
        let before = fs::read(&ledger).unwrap();
        let chats = ChatManager::default();
        let departure = Departure {
            store: &store,
            chats: &chats,
        };
        broken(&ledger);
        let refused = crate::team::delete_idle(&path, &dev.id, &departure);
        mended(&ledger);
        let refused = refused.expect_err("a removal nothing recorded is not a removal");
        assert!(
            refused.starts_with(
                "Dev was not removed: the ledger could not record the removal, so nothing was changed ("
            ),
            "{refused}"
        );
        assert_eq!(names(&path), ["Dev"], "the roster is untouched");
        assert_eq!(fs::read(&ledger).unwrap(), before, "and so is the ledger");
        // Still registered, so its work starts here...
        let (_, _, attempt, _) = store
            .reserve_attempt("chat:master", &launch_for(&first.id))
            .unwrap();
        store
            .fail_preparation(
                &attempt.id,
                "no workspace".into(),
                String::new(),
                String::new(),
                false,
            )
            .unwrap();
        drop(store);
        // ...and after a restart. With the fault gone the removal is made,
        // and the restart after that still refuses the agent's work.
        let store = OrchestrationStore::load(ledger.clone());
        let departure = Departure {
            store: &store,
            chats: &chats,
        };
        crate::team::delete_idle(&path, &dev.id, &departure).unwrap();
        assert!(names(&path).is_empty());
        drop(store);
        let store = OrchestrationStore::load(ledger);
        let gone = store
            .reserve_attempt("chat:master", &launch_for(&later.id))
            .unwrap_err();
        assert_eq!(gone, gone_reason("Dev"));
    }

    /// The fault every platform has: a folder where the ledger's file goes.
    #[test]
    fn a_removal_the_ledger_cannot_record_is_refused_and_removes_nobody() {
        let aside = |ledger: &std::path::Path| ledger.with_extension("aside");
        refused_while_the_ledger_cannot_be_saved(
            |ledger| {
                fs::rename(ledger, aside(ledger)).unwrap();
                fs::create_dir(ledger).unwrap();
                // Not empty, so no platform replaces it with a file.
                fs::write(ledger.join("in-the-way"), b"").unwrap();
            },
            |ledger| {
                fs::remove_dir_all(ledger).unwrap();
                fs::rename(aside(ledger), ledger).unwrap();
            },
        );
    }

    /// The reviewer's own probe: the ledger's folder is read-only, so the
    /// old ledger is never touched, and a plain reload reads it.
    #[cfg(unix)]
    #[test]
    fn a_removal_is_refused_while_the_ledgers_folder_is_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |ledger: &std::path::Path, mode| {
            fs::set_permissions(ledger.parent().unwrap(), fs::Permissions::from_mode(mode)).unwrap()
        };
        refused_while_the_ledger_cannot_be_saved(|l| mode(l, 0o555), |l| mode(l, 0o755));
    }

    /// A removal whose roster write does what the test says instead.
    struct RosterWrite<'a, F: Fn() -> Result<(), String>> {
        departure: &'a Departure<'a>,
        instead: F,
    }

    impl<F: Fn() -> Result<(), String>> crate::team::Leave for RosterWrite<'_, F> {
        fn leave(
            &self,
            agent: &crate::team::TeamAgent,
            chats: &[crate::team::OwnChat],
            _write: &mut dyn FnMut() -> Result<(), String>,
        ) -> Result<(), String> {
            crate::team::Leave::leave(self.departure, agent, chats, &mut || (self.instead)())
        }
    }

    fn starts(store: &OrchestrationStore, task: &Task) -> Result<(), String> {
        let (_, _, attempt, _) = store.reserve_attempt("chat:master", &launch_for(&task.id))?;
        store
            .fail_preparation(
                &attempt.id,
                "no workspace".into(),
                String::new(),
                String::new(),
                false,
            )
            .map(|_| ())
    }

    /// The second write fails: the record the first one saved is taken
    /// back, on disk as in memory, and the agent goes on working.
    #[test]
    fn a_roster_that_cannot_be_written_takes_the_removals_record_back() {
        let (_dir, path, ledger, dev, [first, later]) = ledger_of_dev();
        let store = OrchestrationStore::load(ledger.clone());
        let chats = ChatManager::default();
        let departure = Departure {
            store: &store,
            chats: &chats,
        };
        let recorded = std::cell::Cell::new(false);
        let failing = RosterWrite {
            departure: &departure,
            instead: || {
                // The record is on disk by the time the roster is written.
                let saved = String::from_utf8(fs::read(&ledger).unwrap()).unwrap();
                recorded.set(saved.contains(&dev.id) && saved.contains("removed_agents"));
                Err("No space left on device".into())
            },
        };
        let refused = crate::team::delete_idle(&path, &dev.id, &failing).unwrap_err();
        assert_eq!(
            refused,
            "Dev was not removed: the roster could not be written (No space left on device). Nothing was changed, and Dev is still registered."
        );
        assert!(recorded.get(), "the record was saved before the roster");
        assert_eq!(names(&path), ["Dev"]);
        let saved = String::from_utf8(fs::read(&ledger).unwrap()).unwrap();
        assert!(!saved.contains("removed_agents"), "taken back on disk");
        starts(&store, &first).expect("and in memory");
        drop(store);
        let store = OrchestrationStore::load(ledger);
        assert_eq!(store.reconcile_removed(&path), Ok(Vec::new()));
        starts(&store, &later).expect("and after a restart");
    }

    /// Both fail: the roster's write, then the save that takes the record
    /// back. The refusal says so. The agent is registered, so this process
    /// goes on starting its work, and the next one drops the record the
    /// disk was left with: the state a server killed between the two writes
    /// leaves.
    #[test]
    fn a_record_that_could_not_be_taken_back_is_said_and_dropped_on_load() {
        let (_dir, path, ledger, dev, [first, later]) = ledger_of_dev();
        let store = OrchestrationStore::load(ledger.clone());
        let chats = ChatManager::default();
        let departure = Departure {
            store: &store,
            chats: &chats,
        };
        let aside = ledger.with_extension("aside");
        let failing = RosterWrite {
            departure: &departure,
            instead: || {
                fs::rename(&ledger, &aside).unwrap();
                fs::create_dir(&ledger).unwrap();
                fs::write(ledger.join("in-the-way"), b"").unwrap();
                Err("No space left on device".into())
            },
        };
        let refused = crate::team::delete_idle(&path, &dev.id, &failing).unwrap_err();
        fs::remove_dir_all(&ledger).unwrap();
        fs::rename(&aside, &ledger).unwrap();
        assert!(
            refused.starts_with(
                "Dev was not removed: the roster could not be written (No space left on device). The ledger's record of the removal could not be taken back either ("
            ),
            "{refused}"
        );
        assert!(
            refused.ends_with(
                "so the ledger on disk still says Dev was removed. Dev is still registered and its work still starts; the record is dropped the next time the ledger is saved, and when the server next starts."
            ),
            "{refused}"
        );
        assert_eq!(names(&path), ["Dev"]);
        // The server is killed here, before anything else saves the ledger:
        // the file is the one the first write made.
        let saved = String::from_utf8(fs::read(&ledger).unwrap()).unwrap();
        assert!(saved.contains("removed_agents"), "{saved}");
        let killed = OrchestrationStore::load(ledger.clone());
        assert_eq!(
            killed
                .reserve_attempt("chat:master", &launch_for(&later.id))
                .unwrap_err(),
            gone_reason("Dev"),
            "what the file says until it is checked against the roster"
        );
        assert_eq!(killed.reconcile_removed(&path), Ok(vec![dev.id.clone()]));
        starts(&killed, &later).expect("the roster has it, so it starts");
        assert_eq!(killed.reconcile_removed(&path), Ok(Vec::new()), "once");
        drop(killed);
        // The process that refused never took the record up. Its next save
        // writes the ledger without it.
        starts(&store, &first).expect("still registered here");
        drop(store);
        let saved = String::from_utf8(fs::read(&ledger).unwrap()).unwrap();
        assert!(!saved.contains("removed_agents"), "{saved}");
    }

    /// What the check on load never does: drop the record of an agent that
    /// is gone, or decide anything from a roster it could not read.
    #[test]
    fn the_check_on_load_keeps_real_removals_and_trusts_no_unread_roster() {
        let (dir, path, ledger, dev, [task, _]) = ledger_of_dev();
        let ops = registered(&path, "Ops");
        let store = OrchestrationStore::load(ledger.clone());
        let chats = ChatManager::default();
        let departure = Departure {
            store: &store,
            chats: &chats,
        };
        crate::team::delete_idle(&path, &dev.id, &departure).unwrap();
        // And an interrupted removal of Ops beside it.
        store
            .mutate(|data| {
                data.removed_agents.insert(ops.id.clone(), now_ms());
                Ok(())
            })
            .unwrap();
        drop(store);
        let store = OrchestrationStore::load(ledger);
        // A roster that is not a file cannot be read: nothing changes.
        let unreadable = dir.0.join("not-a-roster");
        fs::create_dir(&unreadable).unwrap();
        let error = store.reconcile_removed(&unreadable).unwrap_err();
        assert!(
            error.starts_with("Saved agents could not be read"),
            "{error}"
        );
        // Nor does one that is not there say anyone is back.
        assert_eq!(
            store.reconcile_removed(&dir.0.join("missing.json")),
            Ok(Vec::new())
        );
        assert_eq!(store.reconcile_removed(&path), Ok(vec![ops.id.clone()]));
        assert_eq!(names(&path), ["Ops"]);
        assert_eq!(
            store
                .reserve_attempt("chat:master", &launch_for(&task.id))
                .unwrap_err(),
            gone_reason("Dev"),
            "Dev was removed, and stays removed"
        );
    }

    /// Review H4: coordinating a run that has not finished, and a turn in
    /// flight in a conversation the agent leads, are work in progress. The
    /// refusal says which, before a card and when the removal is made. A
    /// run that was stopped does not hold the agent, and neither does the
    /// head's seat with nothing being answered in it.
    #[test]
    fn a_lead_coordinating_a_run_or_mid_turn_is_not_removed_and_an_idle_head_is() {
        const CHAT: &str = "chat:m2-head";
        let (_dir, path) = roster();
        let lead = registered(&path, "Lead");
        crate::team::set_head(&path, Some(&lead.id)).unwrap();
        crate::team::record_lead(&path, CHAT, &lead, "workspace", true).unwrap();
        let own = crate::team::own_chats(&path, &lead.id).unwrap();
        assert_eq!(
            own,
            [crate::team::OwnChat {
                chat_key: CHAT.into(),
                front_desk: false
            }]
        );
        let store = OrchestrationStore::default();
        let chats = ChatManager::default();
        let departure = Departure {
            store: &store,
            chats: &chats,
        };
        assert_eq!(departure.check(&lead, &own), Ok(None), "an idle head");

        let run = wide(&store, CHAT, "Ship the feature");
        let coordinating = departure.check(&lead, &own).unwrap_err();
        assert_eq!(
            coordinating,
            format!(
                "Lead is coordinating \"Ship the feature\" ({}), which has not finished. Nothing was removed. Stop that run from its chat or wait for it to finish, then remove Lead.",
                run.id
            )
        );
        assert_eq!(
            crate::team::delete_idle(&path, &lead.id, &departure).unwrap_err(),
            coordinating
        );
        // The ledger alone, as the removal used to ask it, still says idle.
        assert_eq!(store.removal_of(&lead.id, &lead.name), Ok(None));
        assert_eq!(names(&path), ["Lead"]);

        // Stopped, the run no longer holds it.
        store
            .stop_run(CHAT, run.id.clone(), "Not now".into())
            .unwrap();
        assert_eq!(departure.check(&lead, &own), Ok(None));

        // A turn in flight in its conversation.
        chats.test_launch(CHAT);
        chats.test_busy(CHAT, true);
        let mid_turn = departure.check(&lead, &own).unwrap_err();
        assert_eq!(
            mid_turn,
            "Lead is in the middle of a turn in a conversation it leads (chat:m2-head). Nothing was removed. Stop that turn or wait for it to end, then remove Lead."
        );
        assert_eq!(
            crate::team::delete_idle(&path, &lead.id, &departure).unwrap_err(),
            mid_turn
        );
        assert_eq!(names(&path), ["Lead"]);

        // Review of bf9d8cd, a carried Low. The look waits for no lock, so
        // while something else holds the session table it sees nothing. The
        // agent stays, and the words are what is known: not that a turn is
        // in flight, which nobody saw.
        chats.test_busy(CHAT, false);
        let held = chats.test_hold_table();
        let unconfirmed = departure.check(&lead, &own).unwrap_err();
        assert_eq!(
            unconfirmed,
            "OctiqFlow could not confirm that Lead is idle in a conversation it leads (chat:m2-head): something else was using that conversation at that moment, so it was not looked at. Nothing was removed. Try again; if Lead is in the middle of a turn there, the answer will say so."
        );
        assert_eq!(
            crate::team::delete_idle(&path, &lead.id, &departure).unwrap_err(),
            unconfirmed
        );
        drop(held);
        assert_eq!(names(&path), ["Lead"]);
        assert_eq!(
            departure.check(&lead, &own),
            Ok(None),
            "looked at, and idle"
        );
        chats.test_busy(CHAT, true);
        assert!(crate::team::head(&path).unwrap().is_some());

        // The turn over, the head is idle: removed, and the seat empties.
        chats.test_busy(CHAT, false);
        crate::team::delete_idle(&path, &lead.id, &departure).unwrap();
        assert!(names(&path).is_empty());
        assert!(crate::team::head(&path).unwrap().is_none());
        chats.test_end(CHAT);
    }

    /// The same for the front desk: a turn in flight in its front-desk
    /// conversation holds it, the seat alone does not.
    #[test]
    fn a_front_desk_mid_turn_is_not_removed_and_an_idle_one_is() {
        const CHAT: &str = "chat:m2-desk";
        let (_dir, path) = roster();
        let desk = registered(&path, "Desk");
        crate::team::set_front_desk(&path, Some(&desk.id)).unwrap();
        crate::team::front_desk_brief(&path, CHAT, &desk.id, "Route me somewhere", &[])
            .unwrap()
            .expect("it is the front desk");
        let own = crate::team::own_chats(&path, &desk.id).unwrap();
        assert_eq!(
            own,
            [crate::team::OwnChat {
                chat_key: CHAT.into(),
                front_desk: true
            }]
        );
        let store = OrchestrationStore::default();
        let chats = ChatManager::default();
        let departure = Departure {
            store: &store,
            chats: &chats,
        };
        chats.test_launch(CHAT);
        chats.test_busy(CHAT, true);
        let refused = crate::team::delete_idle(&path, &desk.id, &departure).unwrap_err();
        assert_eq!(
            refused,
            "Desk is in the middle of a turn in its front-desk conversation (chat:m2-desk). Nothing was removed. Stop that turn or wait for it to end, then remove Desk."
        );
        assert_eq!(departure.check(&desk, &own).unwrap_err(), refused);
        chats.test_busy(CHAT, false);
        assert_eq!(departure.check(&desk, &own), Ok(None));
        crate::team::delete_idle(&path, &desk.id, &departure).unwrap();
        assert!(crate::team::front_desk(&path).unwrap().is_none());
        chats.test_end(CHAT);
    }
}

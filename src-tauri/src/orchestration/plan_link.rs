//! What the ledger says of the tasks a chat's plan links to (`chat_plan.rs`).
//!
//! A plan item names the tasks it became; that naming is the agent's. How
//! those tasks stand is read here, for one answer, and kept nowhere: an
//! agent that calls an item `done` does not make its tasks finished.

use super::*;

/// How a linked task stands, in the words the run panel counts by.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkedState {
    /// Settled, and its check did not fail.
    Done,
    /// Failed, blocked with no decision open, or settled with a failed
    /// check (`retry::failed_as`). A task the person stopped did not fail.
    Failed,
    /// An attempt is being prepared or is running.
    Running,
    /// Still owed and not running: not started, held, waiting on a
    /// decision, stopped by the person.
    Waiting,
    /// Counted nowhere: cancelled, replaced, or unfinished in a run the
    /// person stopped, closed or archived.
    Closed,
}

/// One task a plan item is linked to, as the ledger holds it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedTask {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub state: LinkedState,
    /// The chat that coordinates the task's run. For the host's own check
    /// of who may link a task; not part of an answer.
    #[serde(skip)]
    pub coordinator: String,
}

fn state_of(data: &Stored, task: &Task) -> LinkedState {
    if task.status == TaskStatus::Cancelled || task.superseded_by.is_some() {
        return LinkedState::Closed;
    }
    // A run the person put away owes nothing it did not finish. What it
    // did finish still counts, as done or as a failed check. A run the
    // host calls `failed` or `completed` has not ended (`retry::ended`).
    let ended = data.runs.get(&task.run_id).is_none_or(|run| {
        matches!(run.status, RunStatus::Stopped | RunStatus::Closed) || run.archived_at.is_some()
    });
    if ended && task.status != TaskStatus::Completed {
        return LinkedState::Closed;
    }
    if retry::failed_as(data, task).is_some() {
        return LinkedState::Failed;
    }
    if task.status == TaskStatus::Completed {
        return LinkedState::Done;
    }
    let executing = task
        .active_attempt_id
        .as_deref()
        .and_then(|id| data.attempts.get(id))
        .is_some_and(|attempt| {
            matches!(
                attempt.status,
                AttemptStatus::Preparing | AttemptStatus::Running
            )
        });
    if executing {
        LinkedState::Running
    } else {
        LinkedState::Waiting
    }
}

impl OrchestrationStore {
    /// The tasks among `ids` the ledger holds, by id. One it does not hold
    /// is simply not in the answer.
    pub fn linked_tasks<'a>(
        &self,
        ids: impl IntoIterator<Item = &'a str>,
    ) -> Result<BTreeMap<String, LinkedTask>, String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let data = &inner.data;
        Ok(ids
            .into_iter()
            .filter_map(|id| data.tasks.get(id))
            .map(|task| {
                (
                    task.id.clone(),
                    LinkedTask {
                        id: task.id.clone(),
                        run_id: task.run_id.clone(),
                        title: task.title.clone(),
                        state: state_of(data, task),
                        coordinator: data
                            .runs
                            .get(&task.run_id)
                            .map(|run| run.coordinator_chat_key.clone())
                            .unwrap_or_default(),
                    },
                )
            })
            .collect())
    }
}

//! A failed task is its coordinator's to fix, twice, before the person is
//! asked (the person's decision of 2026-10-13).
//!
//! Three things are a failure: a task that failed, one whose worker
//! reported it blocked with no decision open, and one that completed with a
//! failing verdict. A task the person stopped did not fail, and only they
//! start it (`Task::stopped`).
//!
//! - **The budget.** A task has `RETRY_LIMIT` automatic retries after a
//!   failure: every start of it that an agent or the host makes while it is
//!   failed, whoever makes it (the coordinator's retry, the reopened check
//!   starting again, the host's own recovery after a provider failure), and
//!   a replacement the coordinator creates for it (`supersedes`), which
//!   carries the count on. `Task::retries_used` counts them. Once they are
//!   used the one door (`reserve_attempt_for`) refuses the next, and so do
//!   `reopen_task` and the replacement, in `RETRIES_USED`'s words.
//! - **Only the person gives more.** Their Start on the task's row, their
//!   answer on the page to a decision the coordinator opened about the task
//!   (`Gate::about_task_id`), and their approval of a plan the task is put
//!   back on each set the count to zero. So does the task finishing well:
//!   that failure is over. No agent's call reaches any of the first three.
//! - **Whose move it is** is derived for each read (`Task::failure`), like
//!   `heldByPlan`: never stored, and never an agent's to say.
use super::*;

/// Automatic retries of one task after a failure, before the person decides.
pub const RETRY_LIMIT: u32 = 2;

/// What a task failed as.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// It failed: its worker said so, or the host saw its provider fail or
    /// its process go.
    Failed,
    /// Its worker reported it blocked, and no decision is open for it.
    Blocked,
    /// It completed with a failing verdict, so what depends on it waits.
    CheckFailed,
}

/// Who made a retry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryBy {
    /// The run's coordinator, or the host's automatic dispatch of a task
    /// that coordinator reopened.
    Coordinator,
    /// The host's own recovery after a provider failure.
    Host,
    /// The person's Start on the page. Not counted: it resets the count.
    Person,
}

/// What an attempt that started on a failed task says of itself
/// (`Attempt::retry`). Written once by `reserve_attempt_for`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptRetry {
    /// The failure it retries.
    pub after: FailureKind,
    pub by: RetryBy,
    /// Which of the task's automatic retries this start used, from 1. Absent
    /// on the person's start, which uses none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
}

/// Why a failure waits on the person, or on nobody.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Because {
    /// The automatic retries are used up.
    RetriesUsed,
    /// The coordinator opened a decision about it for the person.
    Escalated,
    /// The coordinator's chat is gone or in the trash: nobody is there to
    /// retry it.
    CoordinatorGone,
    /// A peer request whose working time is used up: only the person gives
    /// it more (`peer_request::clock_for`).
    TimeLimit,
    /// Another task replaced it.
    Replaced,
    /// Its run was stopped, closed or archived.
    RunEnded,
}

/// A task's failure and whose move it is (`Task::failure`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub kind: FailureKind,
    /// `coordinator` while it may still fix it, `person` once they have to
    /// decide, `nobody` for a failure that is history.
    pub awaits: Awaits,
    /// Why, whenever it is not the coordinator's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub because: Option<Because>,
    /// The open decision the coordinator put to the person about it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate_id: Option<String>,
}

/// Why an agent's or the host's start, reopen or replacement of a task
/// whose retries are used up is refused.
pub const RETRIES_USED: &str = "This task has used its 2 automatic retries after a failure, so the person decides what happens to it. Nothing was started or changed. Open a decision for them with orchestration_gate_create (runId and this taskId): say what failed, what each retry tried, and what the choices are. Their Start on the task's row, or their answer to that decision on the page, gives the task 2 more.";

/// Why nothing an agent does moves a failed task while the decision the
/// coordinator opened about it is with the person.
fn escalated_reason(gate: &str) -> String {
    format!("This task's failure is with the person: decision gate {gate} about it is open. Nothing was started or changed. It goes on once they answer it, or when they start the task themselves from its row.")
}

/// The task's latest attempt, as the ledger names it.
fn latest<'a>(data: &'a Stored, task: &Task) -> Option<&'a Attempt> {
    task.active_attempt_id
        .as_deref()
        .and_then(|id| data.attempts.get(id))
}

/// What a task, as it stands, is SHOWN as having failed as: on the page
/// (`Task::failure`, a plan item's progress) and in what the coordinator is
/// told (`expectation`). Nothing for a task the person stopped, for a
/// worker waiting on its own open gate, and for a failure the host has
/// already scheduled its recovery of: nobody is asked to do anything about
/// that one, so it is drawn as a retry on its way and not as a failure.
///
/// **It decides nothing that is counted.** Whether an act uses one of a
/// task's automatic retries, and whether the budget allows it, is asked of
/// `counted`, which knows the failure this reading leaves out. A
/// replacement asked this reading, found no failure in a task whose
/// recovery was scheduled, and so was neither held to the budget nor
/// counted: the limit could be gone round without end (review of 16e4188,
/// H1). `retry_tests` reads the source for every caller and holds each to
/// drawing or telling (`who_reads_what_a_failure_is_shown_as`).
pub(super) fn failed_as(data: &Stored, task: &Task) -> Option<FailureKind> {
    if task.stopped.is_some() {
        return None;
    }
    match task.status {
        TaskStatus::Failed => Some(FailureKind::Failed),
        TaskStatus::Blocked => {
            let attempt = latest(data, task)?;
            if attempt_is_unsettled(data, attempt)
                || attempt_has_open_gate(data, attempt)
                || attempt.execution.next_retry_at.is_some()
            {
                return None;
            }
            Some(match attempt.status {
                AttemptStatus::Failed => FailureKind::Failed,
                _ => FailureKind::Blocked,
            })
        }
        TaskStatus::Completed if task.verdict == Some(Verdict::Fail) => {
            Some(FailureKind::CheckFailed)
        }
        _ => None,
    }
}

/// The failure an act on `task` right now would answer, for everything
/// that is COUNTED: a start, a reopen, a replacement. It is what the
/// budget is asked about (`allows`) and what uses one of the task's
/// automatic retries (`started`, `replaced`).
///
/// Unlike `failed_as`, which is what is shown, it leaves no failure out
/// because nobody is asked about it: a failure the host has scheduled its
/// own recovery of is a failure here, and so is a failed check that was
/// reopened (`reopen_task` makes the task ready and keeps its verdict).
/// Nothing for a task the person stopped, which did not fail, and for a
/// worker waiting on its own open gate.
pub(super) fn counted(data: &Stored, task: &Task) -> Option<FailureKind> {
    if task.stopped.is_some() {
        return None;
    }
    let last = latest(data, task);
    match task.status {
        TaskStatus::Failed => Some(FailureKind::Failed),
        TaskStatus::Blocked => match last?.status {
            // Whether or not the host has scheduled its recovery of it.
            AttemptStatus::Failed => Some(FailureKind::Failed),
            AttemptStatus::Blocked if !attempt_has_open_gate(data, last?) => {
                Some(FailureKind::Blocked)
            }
            _ => None,
        },
        TaskStatus::Completed if task.verdict == Some(Verdict::Fail) => {
            Some(FailureKind::CheckFailed)
        }
        TaskStatus::Ready | TaskStatus::Pending
            if task.verdict == Some(Verdict::Fail)
                && last.is_some_and(|attempt| attempt.status == AttemptStatus::Completed) =>
        {
            Some(FailureKind::CheckFailed)
        }
        _ => None,
    }
}

/// The open decision the coordinator put to the person about `task_id`.
pub(super) fn escalation<'a>(data: &'a Stored, task_id: &str) -> Option<&'a Gate> {
    data.gates.values().find(|gate| {
        gate.status == GateStatus::Open && gate.about_task_id.as_deref() == Some(task_id)
    })
}

/// Whether an agent or the host may act on `task`'s failure now: start it
/// again, reopen it, or replace it. `kind` is the failure the act answers.
/// The person's own Start asks nothing here.
pub(super) fn allows(data: &Stored, task: &Task, kind: Option<FailureKind>) -> Result<(), String> {
    if kind.is_none() {
        return Ok(());
    }
    if let Some(gate) = escalation(data, &task.id) {
        return Err(escalated_reason(&gate.id));
    }
    if task.retries_used >= RETRY_LIMIT {
        return Err(RETRIES_USED.into());
    }
    Ok(())
}

/// Record a start of `task` on the failure `kind`: the count, and what the
/// new attempt says of itself. The person's start uses no retry: it gives
/// them all back, and closes the decision that asked them.
pub(super) fn started(
    data: &mut Stored,
    task_id: &str,
    kind: Option<FailureKind>,
    by: RetryBy,
    now: i64,
) -> Option<AttemptRetry> {
    if by == RetryBy::Person {
        person_decided(data, task_id, now);
    }
    let kind = kind?;
    let task = data.tasks.get_mut(task_id)?;
    let number = (by != RetryBy::Person).then(|| {
        task.retries_used = task.retries_used.saturating_add(1);
        task.retries_used
    });
    Some(AttemptRetry {
        after: kind,
        by,
        number,
    })
}

/// The person acted on this task themselves, by a door no agent's call
/// reaches: their Start on its row, or their reopen of it from the page.
/// Its automatic retries are whole again, and the decision the coordinator
/// opened about it is closed: they have answered it by acting.
pub(super) fn person_decided(data: &mut Stored, task_id: &str, now: i64) {
    given_more(data, task_id);
    for gate in data.gates.values_mut().filter(|gate| {
        gate.status == GateStatus::Open && gate.about_task_id.as_deref() == Some(task_id)
    }) {
        gate.close(GateStatus::Cancelled, now);
    }
}

/// The person decided about this task, or it finished well: its automatic
/// retries are whole again.
pub(super) fn given_more(data: &mut Stored, task_id: &str) {
    if let Some(task) = data.tasks.get_mut(task_id) {
        task.retries_used = 0;
    }
}

/// `new` replaces the failed `old`: that is one of old's retries, and the
/// replacement carries the count on, so a chain of replacements ends at the
/// person like a chain of retries. Asked of `counted`, like the budget that
/// allowed it (`supersedable`): a replacement of a failure the host had
/// scheduled its recovery of is a retry like any other.
pub(super) fn replaced(data: &mut Stored, old: &str, new: &str) {
    let Some(before) = data.tasks.get(old) else {
        return;
    };
    let used = before
        .retries_used
        .saturating_add(u32::from(counted(data, before).is_some()));
    if let Some(task) = data.tasks.get_mut(new) {
        task.retries_used = task.retries_used.max(used);
    }
}

/// The chat list as it was last read for this, and when.
#[derive(Default)]
pub struct Listed {
    at: i64,
    ids: Option<std::sync::Arc<BTreeSet<String>>>,
}

/// How long one read of the chat list answers for. The scheduler reads the
/// whole ledger on every pass, and each read would otherwise read the list
/// again. A test asks every time: it deletes a chat and looks at once.
const LISTED_FOR_MS: i64 = if cfg!(test) { 0 } else { 3_000 };

/// Which coordinators' chats the person can still open, looked up at most
/// once for a whole snapshot and only when a failure asks. A chat list that
/// cannot be read answers that every chat is there: what is unknown is not
/// gone.
pub(super) struct Reach<'a> {
    kept: &'a Mutex<Listed>,
    ids: Option<Option<std::sync::Arc<BTreeSet<String>>>>,
}

impl<'a> Reach<'a> {
    pub(super) fn over(kept: &'a Mutex<Listed>) -> Self {
        Self { kept, ids: None }
    }

    fn gone(&mut self, chat_key: &str) -> bool {
        let kept = self.kept;
        let ids = self.ids.get_or_insert_with(|| {
            let mut kept = kept.lock().unwrap_or_else(|e| e.into_inner());
            let now = now_ms();
            if kept.ids.is_none() || now - kept.at >= LISTED_FOR_MS || now < kept.at {
                kept.ids = crate::chat_index::listed_ids()
                    .ok()
                    .map(std::sync::Arc::new);
                kept.at = now;
            }
            kept.ids.clone()
        });
        let id = chat_key.strip_prefix("chat:").unwrap_or(chat_key);
        ids.as_ref().is_some_and(|ids| !ids.contains(id))
    }
}

/// A run nothing starts in any more, or that the person put away: its
/// failures are history. A run the host calls `failed` or `completed` is
/// not one: that status is what an unanswered failure leaves a run in.
fn ended(run: &Run) -> bool {
    matches!(run.status, RunStatus::Stopped | RunStatus::Closed) || run.archived_at.is_some()
}

/// Put on `task` what a read says of its retries and its failure.
pub(super) fn derive(data: &Stored, task: &mut Task, reach: &mut Reach, now: i64) {
    task.retry_limit = Some(RETRY_LIMIT);
    let attempt = latest(data, task);
    task.retrying = attempt.is_some_and(|attempt| {
        let executing = matches!(
            attempt.status,
            AttemptStatus::Preparing | AttemptStatus::Running
        );
        // A retry at work, or the one the host has scheduled.
        (attempt.retry.is_some() && executing)
            || (task.status == TaskStatus::Blocked
                && attempt.status == AttemptStatus::Failed
                && attempt.execution.next_retry_at.is_some())
    });
    task.failure = failure(data, task, reach, now);
}

fn failure(data: &Stored, task: &Task, reach: &mut Reach, now: i64) -> Option<Failure> {
    let kind = failed_as(data, task)?;
    let run = data.runs.get(&task.run_id)?;
    let says = |awaits, because, gate_id| {
        Some(Failure {
            kind,
            awaits,
            because,
            gate_id,
        })
    };
    if task.superseded_by.is_some() {
        return says(Awaits::Nobody, Some(Because::Replaced), None);
    }
    if ended(run) {
        return says(Awaits::Nobody, Some(Because::RunEnded), None);
    }
    if let Some(gate) = escalation(data, &task.id) {
        return says(
            Awaits::Person,
            Some(Because::Escalated),
            Some(gate.id.clone()),
        );
    }
    if task.retries_used >= RETRY_LIMIT {
        return says(Awaits::Person, Some(Because::RetriesUsed), None);
    }
    if task
        .peer_request
        .as_ref()
        .is_some_and(|request| peer_request::clock_for(data, task, request, false, now).is_err())
    {
        return says(Awaits::Person, Some(Because::TimeLimit), None);
    }
    if reach.gone(&run.coordinator_chat_key) {
        return says(Awaits::Person, Some(Because::CoordinatorGone), None);
    }
    says(Awaits::Coordinator, None, None)
}

/// What the coordinator is told to do about `task_id`'s failure, as the
/// last paragraph of the notice of it. Empty when the task is not in
/// failure (a recovery the host scheduled, a task the person stopped).
pub(super) fn expectation(data: &Stored, task_id: &str, now: i64) -> String {
    let Some(task) = data.tasks.get(task_id) else {
        return String::new();
    };
    let Some(kind) = failed_as(data, task) else {
        return String::new();
    };
    if task.superseded_by.is_some() {
        return String::new();
    }
    let id = &task.id;
    let used = task.retries_used;
    if let Some(request) = &task.peer_request {
        if peer_request::clock_for(data, task, request, false, now).is_err() {
            return format!(
                "\n\nThis peer request has used the {} minutes of working time the person approved, so only they start it again, with Start on its row. Nothing is asked of you for it.",
                request.max_minutes
            );
        }
    }
    if used >= RETRY_LIMIT {
        return format!(
            "\n\nThe {RETRY_LIMIT} automatic retries of this task are used up (retriesUsed {used} of retryLimit {RETRY_LIMIT} in orchestration_snapshot), so the person decides now, and the host refuses another start, reopen or replacement of it by you. Open a decision for them with orchestration_gate_create (runId and taskId {id}): say what failed, what each retry tried, and what the choices are (start it again, replace it, leave it). Their Start on the task's row, or their answer to that decision on the page, gives it {RETRY_LIMIT} more."
        );
    }
    let head = format!("\n\nThis failure is yours to fix. The person is not asked yet: they are asked after {RETRY_LIMIT} automatic retries, and {used} of {RETRY_LIMIT} are used (retriesUsed in orchestration_snapshot). Read attempt.execution and its latestError there, then");
    let ask = format!("If only the person can decide, open a decision for them with orchestration_gate_create (runId and taskId {id}) saying what failed, what was tried and what the choices are.");
    // A teammate's job, approved in its own words: the one repair is the
    // same job again (`peer_request.rs`).
    if task.peer_request.is_some() {
        return format!("{head} retry it in the same workspace now (orchestration_worker_start with newWorktree=false and no baseBranch), which uses one retry. That is the only repair: a peer request is not reopened, takes no message, and is replaced only by a new request the person approves. Never leave it as it is. {ask}");
    }
    // A completed task is not replaced (`supersedable`): a failed check is
    // put right by checking again.
    if kind == FailureKind::CheckFailed {
        return format!("{head} put it right now: fix what it found (orchestration_task_reopen on the task whose work it judged), then reopen this task (orchestration_task_reopen, with corrected instructions if the check itself was wrong) so it checks again, which uses one retry. Never leave it as it is, and never route around it with a new check. {ask}");
    }
    format!(
        "{head} do one of these now: retry it in the same workspace (orchestration_worker_start with newWorktree=false and the settings it ran with); or replace it with a corrected task that names {id} in supersedes (orchestration_task_create). Each of them uses one retry. Never leave the task as it is, and never route around it with a new task that does not name it in supersedes. {ask}"
    )
}

/// The rule, for the master brief.
pub(super) const BRIEF: &str = "A task that failed, was reported blocked, or completed with a failing verdict is yours to fix, and the host tells you so in the notice of it. Read attempt.execution and latestError, then retry it in the same workspace, reopen it with corrected instructions (a completed check, which is not replaced), or replace it with a task that names it in supersedes (a failed or blocked task). Never leave it, and never route around it with an unrelated new task. Each task has 2 automatic retries after a failure (task.retriesUsed and retryLimit; the host's own recovery and a replacement count too). After that the host refuses to start, reopen or replace it for you: open a decision for the person with orchestration_gate_create naming the taskId, saying what failed, what was tried and what the choices are. task.failure.awaits in orchestration_snapshot says whose move a failure is.";

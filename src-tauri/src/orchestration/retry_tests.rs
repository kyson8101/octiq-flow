//! A failed task is its coordinator's to fix, twice, before the person is
//! asked (`retry.rs`): the budget at the one door, who gives more, and what
//! each read says of a failure.
//!
//! Several of these also answer the page's fixtures in
//! `web/src/lib/__fixtures__/host` (its README names each): run with
//! `OCTIQ_RECORD_FACTS=1` and `--nocapture`, a test prints the snapshot it
//! just asserted on as a `FACT <name> {…}` line.

use super::peer_request::tests::{timed, LEAD_CHAT};
use super::retry::{Because, Failure, FailureKind, RetryBy, RETRIES_USED, RETRY_LIMIT};
use super::tests::launch_for;
use super::*;

/// Print what a fixture is recorded from, when asked to.
fn fact(name: &str, snapshot: &Snapshot) {
    if std::env::var_os("OCTIQ_RECORD_FACTS").is_some() {
        println!("FACT {name} {}", serde_json::to_value(snapshot).unwrap());
    }
}

/// A run whose coordinator is a chat the person can open, in a ledger of
/// its own. The chat is forgotten again on drop.
struct Lead {
    dir: crate::test_dir::TestDir,
    id: String,
    key: String,
    store: OrchestrationStore,
    run: Run,
}

impl Lead {
    fn new() -> Self {
        let id = format!("retry-{}", compact_id());
        list(&id);
        Self::of(id)
    }

    /// The same, with a coordinator chat the index does not list.
    fn unlisted() -> Self {
        Self::of(format!("retry-gone-{}", compact_id()))
    }

    fn of(id: String) -> Self {
        let dir = crate::test_dir::TestDir::new("retry");
        let key = format!("chat:{id}");
        let store = OrchestrationStore::default();
        let run = store
            .create_run(
                key.clone(),
                "Ship the feature".into(),
                "workspace".into(),
                dir.0.to_string_lossy().into_owned(),
                Some(4),
            )
            .unwrap();
        Self {
            dir,
            id,
            key,
            store,
            run,
        }
    }

    fn task(&self) -> Task {
        self.task_of(TaskKind::default())
    }

    fn task_of(&self, kind: TaskKind) -> Task {
        self.store
            .create_task_full(
                &self.key,
                self.run.id.clone(),
                "Implement".into(),
                "Make the requested change".into(),
                Vec::new(),
                None,
                None,
                None,
                None,
                None,
                TaskEnvironment::None,
                None,
                kind,
            )
            .unwrap()
    }

    fn start_as(&self, task_id: &str, by: StartedBy) -> Result<Attempt, String> {
        let (_, _, attempt, _) =
            self.store
                .reserve_attempt_for(&self.key, &launch_for(task_id), by)?;
        self.store
            .activate_attempt(&attempt.id, "work".into(), "test".into(), true)
    }

    /// The coordinator's start.
    fn start(&self, task_id: &str) -> Result<Attempt, String> {
        self.start_as(task_id, StartedBy::Coordinator)
    }

    /// The person's Start on the task's row.
    fn person_starts(&self, task_id: &str) -> Result<Attempt, String> {
        let retry_of = self.now(task_id).active_attempt_id;
        self.start_as(
            task_id,
            StartedBy::Page {
                retry_of: retry_of.as_deref(),
            },
        )
    }

    fn report(&self, attempt: &Attempt, outcome: WorkerOutcome, verdict: Option<Verdict>) {
        self.store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id.clone(),
                    outcome,
                    summary: "The build does not link".into(),
                    files_modified: Vec::new(),
                    verdict,
                },
            )
            .unwrap();
    }

    /// Start the task as its coordinator and have its worker report failed.
    fn fails(&self, task_id: &str) -> Attempt {
        let attempt = self.start(task_id).unwrap();
        self.report(&attempt, WorkerOutcome::Failed, None);
        attempt
    }

    fn snapshot(&self) -> Snapshot {
        self.store.snapshot(Some(&self.run.id)).unwrap()
    }

    fn now(&self, task_id: &str) -> Task {
        self.snapshot()
            .tasks
            .into_iter()
            .find(|task| task.id == task_id)
            .unwrap()
    }

    fn failure(&self, task_id: &str) -> Option<Failure> {
        self.now(task_id).failure
    }

    /// The one notice the coordinator has about `task_id` that says
    /// `words`. Two notices can be made in one millisecond, so a notice is
    /// found by what it says, never by being the newest.
    fn told(&self, task_id: &str, words: &str) -> String {
        let all: Vec<String> = self
            .snapshot()
            .notifications
            .into_iter()
            .filter(|n| n.target_chat_key == self.key && n.body.contains(task_id))
            .map(|n| n.body)
            .collect();
        let mut said = all.iter().filter(|body| body.contains(words));
        match (said.next(), said.next()) {
            (Some(body), None) => body.clone(),
            (None, _) => panic!("no notice says {words:?}: {all:#?}"),
            (Some(_), Some(_)) => panic!("several notices say {words:?}: {all:#?}"),
        }
    }

    /// Give the task the workspace a reopen needs it to have kept.
    fn keeps_a_workspace(&self, task_id: &str) {
        let root = self.dir.0.to_string_lossy().into_owned();
        self.store
            .mutate(|data| {
                let task = data.tasks.get_mut(task_id).unwrap();
                task.workspace = Some(workspaces::TaskWorkspace {
                    plan: crate::git_ops::workflow::plan(
                        &root,
                        "",
                        task_id,
                        WorkspaceMode::Direct,
                    )?,
                    state: workspaces::WorkspaceState::Retained,
                    lease_attempt_id: None,
                    delivery: None,
                    validation_paths: Vec::new(),
                    cleanup_intent: None,
                    abandoned: false,
                });
                Ok(())
            })
            .unwrap();
    }

    /// The coordinator reopens a completed task, and its notice is told.
    fn reopens(&self, task_id: &str) -> Result<Task, String> {
        let reopened = self
            .store
            .reopen_task(&self.key, task_id, "Check it again".into())?;
        self.store
            .mutate(|data| {
                for reopen in &mut data.tasks.get_mut(task_id).unwrap().reopens {
                    reopen.notice_delivered = true;
                }
                Ok(())
            })
            .unwrap();
        Ok(reopened)
    }

    fn asks_the_person(&self, task_id: &str) -> Result<Gate, String> {
        self.store.create_gate(
            &self.key,
            self.run.id.clone(),
            Some(task_id.into()),
            "It failed three times on the linker. Start it again, replace it, or leave it?".into(),
            vec!["Start it again".into(), "Leave it".into()],
        )
    }

    fn answers(&self, gate: &Gate, by: ResolvedBy) -> Gate {
        self.store
            .resolve_gate_and_resume(
                &self.key,
                gate.id.clone(),
                "Start it again".into(),
                true,
                by,
            )
            .unwrap()
    }
}

impl Drop for Lead {
    fn drop(&mut self) {
        let _ = crate::chat_index::remove(&self.id);
        crate::transcript::forget(&self.key);
    }
}

fn list(id: &str) {
    crate::chat_index::upsert(
        serde_json::from_value(json!({
            "id": id, "projectId": "workspace", "title": "Lead chat", "updatedAt": 100,
        }))
        .unwrap(),
    )
    .unwrap();
}

fn waits_on(kind: FailureKind, awaits: Awaits, because: Option<Because>) -> Option<Failure> {
    Some(Failure {
        kind,
        awaits,
        because,
        gate_id: None,
    })
}

/// The budget, at the one door: two starts of a failed task without the
/// person, and the third is refused in words that say who decides. The
/// person's own Start is always taken and gives both back.
#[test]
fn a_failed_task_has_two_automatic_retries_and_the_third_start_is_refused() {
    let lead = Lead::new();
    let task = lead.task();
    assert_eq!(
        (
            lead.now(&task.id).retries_used,
            lead.now(&task.id).retry_limit
        ),
        (0, RETRY_LIMIT)
    );
    let first = lead.fails(&task.id);
    assert_eq!(first.retry, None, "a first start retries nothing");
    assert_eq!(lead.now(&task.id).retries_used, 0);

    for number in 1..=RETRY_LIMIT {
        let attempt = lead.fails(&task.id);
        let retry = attempt.retry.expect("it started on a failed task");
        assert_eq!(
            (retry.after, retry.by, retry.number),
            (FailureKind::Failed, RetryBy::Coordinator, Some(number))
        );
        assert_eq!(lead.now(&task.id).retries_used, number);
    }

    let attempts = lead.snapshot().attempts.len();
    for by in [StartedBy::Coordinator, StartedBy::Recovery(&first.id)] {
        assert_eq!(lead.start_as(&task.id, by).unwrap_err(), RETRIES_USED);
    }
    assert!(RETRIES_USED.contains("the person decides"));
    assert!(RETRIES_USED.contains("orchestration_gate_create"));
    assert_eq!(lead.snapshot().attempts.len(), attempts, "nothing reserved");
    assert_eq!(lead.now(&task.id).retries_used, RETRY_LIMIT);

    // The person's Start is not counted, and it gives the two back.
    let theirs = lead.person_starts(&task.id).unwrap();
    let retry = theirs.retry.clone().unwrap();
    assert_eq!((retry.by, retry.number), (RetryBy::Person, None));
    assert_eq!(lead.now(&task.id).retries_used, 0);
    lead.report(&theirs, WorkerOutcome::Failed, None);
    lead.fails(&task.id);
    lead.fails(&task.id);
    assert_eq!(lead.start(&task.id).unwrap_err(), RETRIES_USED);
}

/// The host's own recovery after a provider failure is one of the same two:
/// it is counted, none is scheduled that the door would refuse, and the
/// total without the person is two whoever made them.
#[test]
fn the_hosts_recovery_and_the_coordinators_retry_share_the_two() {
    let lead = Lead::new();
    let task = lead.task();
    let capacity = |attempt: &Attempt| {
        lead.store
            .observe_worker_event(
                &attempt.worker_chat_key,
                &json!({"type":"turn.failed", "error":{"message":"Selected model is at capacity"}}),
            )
            .unwrap();
    };
    let first = lead.start(&task.id).unwrap();
    capacity(&first);
    let waiting = lead.now(&task.id);
    assert_eq!(waiting.status, TaskStatus::Blocked);
    assert!(waiting.retrying, "the host has scheduled its retry");
    assert_eq!(waiting.failure, None, "nobody's move: the host's");
    let told = lead.told(&task.id, "Host retry scheduled");
    assert!(
        told.contains("automatic retry 1 of 2 for this task"),
        "{told}"
    );
    assert!(!told.contains("yours to fix"), "{told}");

    lead.store
        .mutate(|data| {
            data.attempts
                .get_mut(&first.id)
                .unwrap()
                .execution
                .next_retry_at = Some(0);
            Ok(())
        })
        .unwrap();
    let second = lead
        .start_as(&task.id, StartedBy::Recovery(&first.id))
        .unwrap();
    let retry = second.retry.clone().unwrap();
    assert_eq!((retry.by, retry.number), (RetryBy::Host, Some(1)));

    // It fails for good; the coordinator retries: the second and last.
    lead.report(&second, WorkerOutcome::Failed, None);
    let third = lead.start(&task.id).unwrap();
    assert_eq!(third.retry.as_ref().unwrap().number, Some(2));

    // A provider failure now schedules nothing: both are used.
    capacity(&third);
    let ended = lead.now(&task.id);
    assert_eq!(ended.status, TaskStatus::Failed);
    assert!(!ended.retrying);
    assert!(lead
        .snapshot()
        .attempts
        .iter()
        .all(|attempt| attempt.execution.next_retry_at.is_none()));
    assert_eq!(
        ended.failure,
        waits_on(
            FailureKind::Failed,
            Awaits::Person,
            Some(Because::RetriesUsed)
        )
    );
    let told = lead.told(&task.id, "No host retry is scheduled.");
    assert!(told.contains("are used up"), "{told}");
}

/// What a read says of one task from its first failure to the person's
/// turn: the coordinator's while retries remain, `retrying` and no failure
/// while one is at work, the person's once both are used.
#[test]
fn a_read_says_whose_move_a_failure_is_and_when_a_retry_is_at_work() {
    let lead = Lead::new();
    let task = lead.task();
    assert_eq!(lead.failure(&task.id), None, "not started");
    let first = lead.start(&task.id).unwrap();
    let working = lead.now(&task.id);
    assert_eq!((working.failure, working.retrying), (None, false));

    lead.report(&first, WorkerOutcome::Failed, None);
    assert_eq!(
        lead.failure(&task.id),
        waits_on(FailureKind::Failed, Awaits::Coordinator, None)
    );
    fact("failure_awaits_coordinator", &lead.snapshot());

    let second = lead.start(&task.id).unwrap();
    let retrying = lead.now(&task.id);
    assert_eq!(
        (retrying.failure, retrying.retrying, retrying.retries_used),
        (None, true, 1)
    );
    fact("retry_executing", &lead.snapshot());

    // Reported blocked, with no decision open: a failure too, by its name.
    lead.report(&second, WorkerOutcome::Blocked, None);
    let blocked = lead.now(&task.id);
    assert_eq!(blocked.status, TaskStatus::Blocked);
    assert!(!blocked.retrying);
    assert_eq!(
        blocked.failure,
        waits_on(FailureKind::Blocked, Awaits::Coordinator, None)
    );

    lead.fails(&task.id);
    assert_eq!(
        lead.failure(&task.id),
        waits_on(
            FailureKind::Failed,
            Awaits::Person,
            Some(Because::RetriesUsed)
        )
    );
    fact("failure_awaits_person", &lead.snapshot());

    // The person's retry is a retry at work too, and says whose it is.
    let theirs = lead.person_starts(&task.id).unwrap();
    let started = lead.now(&task.id);
    assert_eq!((started.failure, started.retrying), (None, true));
    assert_eq!(theirs.retry.unwrap().by, RetryBy::Person);
}

/// A worker waiting on its own open gate did not fail: the gate says who it
/// waits for, and the task carries no failure.
#[test]
fn a_worker_waiting_on_its_own_gate_is_not_a_failure() {
    let lead = Lead::new();
    let task = lead.task();
    let attempt = lead.start(&task.id).unwrap();
    lead.store
        .create_gate(
            &attempt.worker_chat_key,
            lead.run.id.clone(),
            None,
            "Which database?".into(),
            Vec::new(),
        )
        .unwrap();
    let waiting = lead.now(&task.id);
    assert_eq!(waiting.status, TaskStatus::Blocked);
    assert_eq!((waiting.failure, waiting.retrying), (None, false));
}

/// A check that completed with a failing verdict is a failure, in a run
/// the host calls completed: that status is what an unanswered failure
/// leaves a run in, so it is still the coordinator's move. Reopening it to
/// check again is the retry, and the third reopen is refused before the
/// task is made ready to wait where nobody is told of it.
#[test]
fn a_failed_check_is_a_failure_and_checking_again_uses_the_retries() {
    let lead = Lead::new();
    let review = lead.task_of(TaskKind::Review);
    lead.keeps_a_workspace(&review.id);
    let first = lead.start(&review.id).unwrap();
    lead.report(&first, WorkerOutcome::Completed, Some(Verdict::Fail));
    assert_eq!(lead.snapshot().runs[0].status, RunStatus::Completed);
    assert_eq!(
        lead.failure(&review.id),
        waits_on(FailureKind::CheckFailed, Awaits::Coordinator, None)
    );
    let told = lead.told(&review.id, "This failure is yours to fix.");
    assert!(told.contains("reopen this task"), "{told}");
    // A completed task cannot be replaced, so the notice does not say to.
    assert!(!told.contains("supersedes"), "{told}");
    assert!(lead
        .store
        .check_supersede(&lead.key, &lead.run.id, &review.id)
        .unwrap_err()
        .contains("Only a blocked or failed task"));
    fact("failure_in_completed_run", &lead.snapshot());

    for number in 1..=RETRY_LIMIT {
        lead.reopens(&review.id).unwrap();
        assert_eq!(lead.failure(&review.id), None, "made ready again");
        let again = lead.start(&review.id).unwrap();
        let retry = again.retry.clone().unwrap();
        assert_eq!(
            (retry.after, retry.number),
            (FailureKind::CheckFailed, Some(number))
        );
        assert!(lead.now(&review.id).retrying);
        lead.report(&again, WorkerOutcome::Completed, Some(Verdict::Fail));
    }
    assert_eq!(
        lead.failure(&review.id),
        waits_on(
            FailureKind::CheckFailed,
            Awaits::Person,
            Some(Because::RetriesUsed)
        )
    );
    assert_eq!(lead.reopens(&review.id).unwrap_err(), RETRIES_USED);
    assert_eq!(lead.now(&review.id).status, TaskStatus::Completed);

    // The person's answer to the coordinator's question gives two more,
    // and a check that then passes is no failure and owes nothing.
    let gate = lead.asks_the_person(&review.id).unwrap();
    lead.answers(&gate, ResolvedBy::Person);
    lead.reopens(&review.id).unwrap();
    let passing = lead.start(&review.id).unwrap();
    assert_eq!(lead.now(&review.id).retries_used, 1);
    lead.report(&passing, WorkerOutcome::Completed, Some(Verdict::Pass));
    let passed = lead.now(&review.id);
    assert_eq!((passed.failure, passed.retries_used), (None, 0));
}

/// A replaced failure is history: nobody's move. Replacing is one of the
/// failed task's retries and the replacement carries the count on, so a
/// chain of replacements ends at the person like a chain of retries.
#[test]
fn a_replaced_failure_is_history_and_its_replacement_carries_the_count() {
    let lead = Lead::new();
    let old = lead.task();
    lead.fails(&old.id);
    lead.fails(&old.id);
    assert_eq!(lead.now(&old.id).retries_used, 1);

    let new = lead.task();
    lead.store.supersede(&lead.key, &old.id, &new.id).unwrap();
    assert_eq!(
        lead.failure(&old.id),
        waits_on(FailureKind::Failed, Awaits::Nobody, Some(Because::Replaced))
    );
    assert_eq!(lead.now(&new.id).retries_used, 2);
    assert_eq!(lead.failure(&new.id), None);
    fact("failure_replaced", &lead.snapshot());

    // The replacement's own first start retries nothing and is taken.
    let attempt = lead.fails(&new.id);
    assert_eq!(attempt.retry, None);
    assert_eq!(
        lead.failure(&new.id),
        waits_on(
            FailureKind::Failed,
            Awaits::Person,
            Some(Because::RetriesUsed)
        )
    );
    // And it can be neither retried nor replaced again without the person.
    assert_eq!(lead.start(&new.id).unwrap_err(), RETRIES_USED);
    assert_eq!(
        lead.store
            .check_supersede(&lead.key, &lead.run.id, &new.id)
            .unwrap_err(),
        RETRIES_USED
    );
}

/// A task the person stopped did not fail: no failure is said of it, its
/// count is untouched, no agent starts it, and their Start is not a retry
/// of a failure.
#[test]
fn a_task_the_person_stopped_is_not_a_failure_and_only_they_start_it() {
    let lead = Lead::new();
    let task = lead.task();
    lead.fails(&task.id);
    let running = lead.start(&task.id).unwrap();
    lead.store.stop_task(&task.id, None).unwrap();
    let stopped = lead.now(&task.id);
    assert_eq!(stopped.status, TaskStatus::Failed);
    assert_eq!(
        (stopped.failure, stopped.retrying, stopped.retries_used),
        (None, false, 1)
    );
    assert_eq!(lead.start(&task.id).unwrap_err(), STOPPED_BY_PERSON);
    assert!(lead
        .store
        .create_gate(
            &lead.key,
            lead.run.id.clone(),
            Some(task.id.clone()),
            "What now?".into(),
            Vec::new()
        )
        .unwrap_err()
        .contains("has settled"));

    let theirs = lead
        .start_as(
            &task.id,
            StartedBy::Page {
                retry_of: Some(&running.id),
            },
        )
        .unwrap();
    assert_eq!(theirs.retry, None);
    assert_eq!(lead.now(&task.id).retries_used, 0);
}

/// A peer request's failure waits on the coordinator of the run it is in,
/// never on the teammate that asked: a plain retry is the same approved
/// job, and it is all that coordinator may do. Once the request's working
/// time is used, only the person gives more, so it is theirs.
#[test]
fn a_peer_requests_failure_waits_on_its_runs_coordinator_then_the_person() {
    let lead_id = LEAD_CHAT.strip_prefix("chat:").unwrap();
    list(lead_id);
    let store = OrchestrationStore::default();
    let (made, peer) = timed(&store, 1);
    let of = |id: &str| {
        store
            .snapshot(None)
            .unwrap()
            .tasks
            .into_iter()
            .find(|task| task.id == id)
            .unwrap()
    };
    store
        .report_worker(
            &peer.worker_chat_key,
            WorkerReport {
                attempt_id: peer.id.clone(),
                outcome: WorkerOutcome::Failed,
                summary: "The volume is missing".into(),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap();
    let failed = of(&made.task_id);
    assert!(failed.peer_request.is_some());
    assert_eq!(
        failed.failure,
        waits_on(FailureKind::Failed, Awaits::Coordinator, None)
    );
    let told = store
        .snapshot(None)
        .unwrap()
        .notifications
        .into_iter()
        .filter(|n| n.target_chat_key == LEAD_CHAT && n.kind == "report")
        .map(|n| n.body)
        .next_back()
        .unwrap();
    assert!(told.contains("That is the only repair"), "{told}");
    assert!(told.contains("0 of 2 are used"), "{told}");
    assert!(!told.contains("supersedes"), "{told}");

    // Its working time is used: the coordinator's start would be refused.
    store
        .mutate(|data| {
            let attempt = data.attempts.get_mut(&peer.id).unwrap();
            attempt
                .peer_clock
                .get_or_insert_with(Default::default)
                .used_ms = 60_000;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        of(&made.task_id).failure,
        waits_on(
            FailureKind::Failed,
            Awaits::Person,
            Some(Because::TimeLimit)
        )
    );
    let _ = crate::chat_index::remove(lead_id);
}

/// With no coordinator to retry it, a failure is the person's at once: a
/// chat the index does not list, or one in the trash. An index that cannot
/// be read is not such a chat.
#[test]
fn a_failure_whose_coordinator_is_gone_is_the_persons_at_once() {
    let gone = Lead::unlisted();
    let task = gone.task();
    gone.fails(&task.id);
    let theirs = waits_on(
        FailureKind::Failed,
        Awaits::Person,
        Some(Because::CoordinatorGone),
    );
    assert_eq!(gone.failure(&task.id), theirs);
    assert_eq!(gone.now(&task.id).retries_used, 0, "no retry was used");
    // However long ago its run settled: a run the host calls failed has
    // not ended, and nobody is left to retry this.
    assert_eq!(gone.snapshot().runs[0].status, RunStatus::Failed);

    let lead = Lead::new();
    let task = lead.task();
    lead.fails(&task.id);
    assert_eq!(lead.failure(&task.id).unwrap().awaits, Awaits::Coordinator);
    let meta = crate::chat_index::list()
        .into_iter()
        .find(|chat| chat.id == lead.id)
        .unwrap();
    assert!(crate::chat_index::trash(&lead.id, None, Some(meta)).unwrap());
    assert_eq!(lead.failure(&task.id), theirs);
    crate::chat_index::restore(&lead.id).unwrap();
    assert_eq!(lead.failure(&task.id).unwrap().awaits, Awaits::Coordinator);
}

/// The coordinator puts a failure to the person with a gate that names the
/// task. That gate is about the task and not the task's: nothing of the
/// task waits on it. While it is open the failure is the person's and no
/// agent moves the task; an agent's own answer gives no retries, the
/// person's answer on the page gives both, and so does their Start, which
/// closes the question.
#[test]
fn the_coordinator_puts_a_failure_to_the_person_and_only_their_answer_gives_more() {
    let lead = Lead::new();
    let task = lead.task();
    let other = lead.task();
    lead.fails(&task.id);
    let gate = lead.asks_the_person(&task.id).unwrap();
    assert_eq!(
        (gate.task_id.as_deref(), gate.about_task_id.as_deref()),
        (None, Some(task.id.as_str()))
    );
    let snapshot = lead.snapshot();
    assert_eq!(snapshot.gates[0].awaits, Some(Awaits::Person));
    let failed = lead.now(&task.id);
    assert_eq!(failed.status, TaskStatus::Failed, "the task is as it was");
    assert_eq!(
        failed.failure,
        Some(Failure {
            kind: FailureKind::Failed,
            awaits: Awaits::Person,
            because: Some(Because::Escalated),
            gate_id: Some(gate.id.clone()),
        })
    );
    fact("failure_escalated", &snapshot);

    // It holds its own task and nothing else of the run.
    assert!(!gate.holds_run());
    let wave = automation::ready_wave(&snapshot, &snapshot.runs[0]);
    assert!(wave.iter().any(|ready| ready.id == other.id));
    let refused = lead.start(&task.id).unwrap_err();
    assert!(refused.contains(&gate.id), "{refused}");
    assert!(refused.contains("is with the person"), "{refused}");
    assert!(lead
        .asks_the_person(&task.id)
        .unwrap_err()
        .contains("already open"));
    let new = lead.task();
    assert!(lead
        .store
        .supersede(&lead.key, &task.id, &new.id)
        .unwrap_err()
        .contains("is with the person"));

    // The coordinator answering its own question gives the task nothing.
    lead.fails(&other.id);
    lead.fails(&other.id);
    lead.fails(&other.id);
    let own = lead.asks_the_person(&other.id).unwrap();
    lead.answers(&own, ResolvedBy::Coordinator);
    assert_eq!(lead.now(&other.id).retries_used, RETRY_LIMIT);
    assert_eq!(lead.start(&other.id).unwrap_err(), RETRIES_USED);
    lead.told(&other.id, "It gives the task no more automatic retries");

    // The person's answer does, and the coordinator carries it out.
    let asked = lead.asks_the_person(&other.id).unwrap();
    lead.answers(&asked, ResolvedBy::Person);
    assert_eq!(lead.now(&other.id).retries_used, 0);
    lead.told(&other.id, "has its 2 automatic retries again");
    assert!(lead.start(&other.id).is_ok());

    // Their own Start answers the question too.
    lead.person_starts(&task.id).unwrap();
    let closed = lead
        .snapshot()
        .gates
        .into_iter()
        .find(|g| g.id == gate.id)
        .unwrap();
    assert_eq!(closed.status, GateStatus::Cancelled);
}

/// A question about the run as a whole still holds its next wave.
#[test]
fn a_question_about_the_whole_run_still_holds_its_next_wave() {
    let lead = Lead::new();
    let task = lead.task();
    let gate = lead
        .store
        .create_gate(
            &lead.key,
            lead.run.id.clone(),
            None,
            "Pause here?".into(),
            Vec::new(),
        )
        .unwrap();
    assert!(gate.holds_run());
    let snapshot = lead.snapshot();
    assert!(automation::ready_wave(&snapshot, &snapshot.runs[0])
        .iter()
        .all(|ready| ready.id != task.id));
}

/// A failure in a run that was stopped, closed or archived is history. The
/// run's own status and `archivedAt` already say which; the failure says it
/// too, so one reader answers "whose move".
#[test]
fn a_failure_in_a_run_that_was_stopped_or_archived_is_history() {
    let history = |kind| waits_on(kind, Awaits::Nobody, Some(Because::RunEnded));
    let lead = Lead::new();
    let task = lead.task();
    lead.fails(&task.id);
    lead.store
        .stop_run(&lead.key, lead.run.id.clone(), "Not needed".into())
        .unwrap();
    assert_eq!(lead.snapshot().runs[0].status, RunStatus::Stopped);
    assert_eq!(lead.failure(&task.id), history(FailureKind::Failed));
    fact("failure_in_stopped_run", &lead.snapshot());

    for (status, archived) in [(RunStatus::Closed, None), (RunStatus::Failed, Some(7))] {
        let lead = Lead::new();
        let task = lead.task();
        lead.fails(&task.id);
        assert_eq!(lead.snapshot().runs[0].status, RunStatus::Failed);
        assert_eq!(
            lead.failure(&task.id).unwrap().awaits,
            Awaits::Coordinator,
            "a run the host calls failed is not ended: that is this failure"
        );
        lead.store
            .mutate(|data| {
                let run = data.runs.get_mut(&lead.run.id).unwrap();
                run.status = status;
                run.archived_at = archived;
                Ok(())
            })
            .unwrap();
        assert_eq!(lead.failure(&task.id), history(FailureKind::Failed));
    }
}

/// The coordinator is told what is expected of it in the notice of every
/// failure, and the master brief states the rule.
#[test]
fn the_coordinator_is_told_what_a_failure_asks_of_it() {
    let lead = Lead::new();
    let task = lead.task();
    lead.fails(&task.id);
    let told = lead.told(&task.id, "0 of 2 are used");
    for words in [
        "This failure is yours to fix.",
        "Worker reported Failed",
        "attempt.execution and its latestError",
        "orchestration_worker_start with newWorktree=false",
        "supersedes",
        "never route around it",
    ] {
        assert!(told.contains(words), "{words}: {told}");
    }

    // A worker whose process went, with no verdict of its own: the same.
    let lost = lead.start(&task.id).unwrap();
    lead.store
        .worker_disconnected(&lost.worker_chat_key, Some("exit 1"))
        .unwrap();
    let told = lead.told(&task.id, "Host detected disconnected");
    assert!(told.contains("1 of 2 are used"), "{told}");
    assert!(told.contains("exit 1"), "{told}");

    lead.fails(&task.id);
    let told = lead.told(&task.id, "are used up");
    for words in [
        "The 2 automatic retries of this task are used up",
        "the person decides now",
        "orchestration_gate_create",
        &task.id,
        "what each retry tried",
    ] {
        assert!(told.contains(words), "{words}: {told}");
    }
    assert!(!told.contains("yours to fix"), "{told}");

    let brief = master_prompt(&lead.run);
    assert!(brief.contains(retry::BRIEF));
    assert!(brief.contains("never route around it with an unrelated new task"));
}

/// Windows gives a whole command line 32,767 characters, and two harnesses
/// put a turn's prompt on one (Pi, and Codex started as `codex exec`): for
/// those a coordinator's notice and its master brief are an argument. What
/// this rule adds to either stays a paragraph.
#[test]
fn what_the_rule_adds_to_a_prompt_stays_a_paragraph() {
    let lead = Lead::new();
    // The longest brief there is: a run whose plan waits for the person.
    let run = lead.store.require_plan_approval(&lead.run.id).unwrap();
    assert!(run.awaiting_plan_approval());
    let brief = master_prompt(&run).chars().count();
    let rule = retry::BRIEF.chars().count();
    assert!(rule < 900, "{rule}");
    assert!(brief < 10_000, "{brief}");

    let task = lead.task();
    lead.store
        .approve_plan(&lead.key, &lead.run.id, None, None)
        .unwrap();
    let mut longest = 0;
    for _ in 0..=RETRY_LIMIT {
        lead.fails(&task.id);
        let data = lead.store.inner.lock().unwrap();
        longest = longest.max(
            retry::expectation(&data.data, &task.id, now_ms())
                .chars()
                .count(),
        );
    }
    assert!((500..1_100).contains(&longest), "{longest}");
    if std::env::var_os("OCTIQ_RECORD_FACTS").is_some() {
        println!("LENGTHS brief {brief} rule {rule} longest notice paragraph {longest}");
    }
}

/// None of this is taken from a stored or a sent task: what a read says of
/// a failure is worked out for that read.
#[test]
fn what_a_read_says_of_a_failure_is_never_read_back() {
    let lead = Lead::new();
    let task = lead.task();
    lead.fails(&task.id);
    let mut said = serde_json::to_value(lead.now(&task.id)).unwrap();
    assert_eq!(said["failure"]["awaits"], "coordinator");
    assert_eq!(said["failure"]["kind"], "failed");
    assert_eq!(
        (&said["retriesUsed"], &said["retryLimit"]),
        (&json!(0), &json!(2))
    );
    assert!(said.get("retrying").is_none(), "left out while it is false");
    said["failure"] = json!({ "kind": "failed", "awaits": "nobody" });
    said["retrying"] = json!(true);
    said["retryLimit"] = json!(99);
    let read: Task = serde_json::from_value(said).unwrap();
    assert_eq!(
        (read.failure, read.retrying, read.retry_limit),
        (None, false, 0)
    );
}

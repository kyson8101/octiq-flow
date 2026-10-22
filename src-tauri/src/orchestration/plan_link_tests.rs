//! How a plan item's linked tasks stand, read from the ledger for one
//! answer (`plan_link.rs`, `chat_plan::answer`).
//!
//! The last test also answers the page's fixture
//! `web/src/lib/__fixtures__/host/chat_plan_started.json` (its README names it):
//! run with `OCTIQ_RECORD_FACTS=1` and `--nocapture` and it prints the
//! answer it just asserted on as a `FACT <name> {…}` line.

use super::plan_link::LinkedState;
use super::tests::launch_for;
use super::*;

/// A run coordinated by a chat that keeps a plan, in a ledger of its own.
/// The plan is forgotten again on drop.
struct Planned {
    dir: crate::test_dir::TestDir,
    chat_id: String,
    key: String,
    store: OrchestrationStore,
    run: Run,
}

impl Planned {
    fn new() -> Self {
        let dir = crate::test_dir::TestDir::new("plan-link");
        let chat_id = format!("plan-link-{}", compact_id());
        let key = format!("chat:{chat_id}");
        let store = OrchestrationStore::default();
        // Ledger-only fixture: its simulated workers own separate worktrees.
        let run = store
            .create_run_with_mode(
                key.clone(),
                "Ship the batch".into(),
                "workspace".into(),
                dir.0.to_string_lossy().into_owned(),
                Some(8),
                WorkspaceMode::Worktree,
            )
            .unwrap();
        Self {
            dir,
            chat_id,
            key,
            store,
            run,
        }
    }

    fn task(&self, title: &str, kind: TaskKind) -> Task {
        self.store
            .create_task_full(
                &self.key,
                self.run.id.clone(),
                title.into(),
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

    fn start(&self, task_id: &str) -> Attempt {
        let (_, _, attempt, _) = self
            .store
            .reserve_attempt_for(&self.key, &launch_for(task_id), StartedBy::Coordinator)
            .unwrap();
        self.store
            .activate_attempt(&attempt.id, "work".into(), "test".into(), true)
            .unwrap()
    }

    fn settle(&self, task_id: &str, outcome: WorkerOutcome, verdict: Option<Verdict>) {
        let attempt = self.start(task_id);
        self.store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id.clone(),
                    outcome,
                    summary: "Reported".into(),
                    files_modified: Vec::new(),
                    verdict,
                },
            )
            .unwrap();
    }

    fn state(&self, task_id: &str) -> LinkedState {
        self.store.linked_tasks([task_id]).unwrap()[task_id].state
    }

    /// The plan's change, linking only what the ledger lets this chat link:
    /// the check `chat_plan_update` makes.
    fn change(&self, change: serde_json::Value) -> Result<crate::chat_plan::Plan, String> {
        crate::chat_plan::update(
            &self.chat_id,
            "OCTIQ HEAD",
            serde_json::from_value(change).unwrap(),
            |ids| {
                let known = self.store.linked_tasks(ids.iter().map(String::as_str))?;
                match ids.iter().find(|id| {
                    known
                        .get(*id)
                        .is_none_or(|task| task.coordinator != self.key)
                }) {
                    Some(id) => Err(format!("{id} cannot be linked.")),
                    None => Ok(()),
                }
            },
        )
        .map(|updated| updated.plan)
    }

    fn answer(&self) -> serde_json::Value {
        serde_json::to_value(crate::chat_plan::answer(
            &self.store,
            &self.chat_id,
            crate::chat_plan::get(&self.chat_id).unwrap(),
        ))
        .unwrap()
    }
}

impl Drop for Planned {
    fn drop(&mut self) {
        crate::chat_plan::forget(&self.chat_id);
        let _ = &self.dir;
    }
}

/// Print what a fixture is recorded from, when asked to.
fn fact(name: &str, answer: &serde_json::Value) {
    if std::env::var_os("OCTIQ_RECORD_FACTS").is_some() {
        println!("FACT {name} {answer}");
    }
}

/// Each state is the ledger's own fact, read the way the run panel counts:
/// a failed check is a failure, a replaced task is counted nowhere, and a
/// task the person stopped did not fail.
#[test]
fn a_linked_task_stands_as_the_ledger_says_whatever_its_item_is_called() {
    let planned = Planned::new();
    let waiting = planned.task("Not started", TaskKind::Work);
    assert_eq!(planned.state(&waiting.id), LinkedState::Waiting);

    let running = planned.task("At work", TaskKind::Work);
    planned.start(&running.id);
    assert_eq!(planned.state(&running.id), LinkedState::Running);

    let done = planned.task("Finished", TaskKind::Work);
    planned.settle(&done.id, WorkerOutcome::Completed, None);
    assert_eq!(planned.state(&done.id), LinkedState::Done);

    let failed = planned.task("Did not build", TaskKind::Work);
    planned.settle(&failed.id, WorkerOutcome::Failed, None);
    assert_eq!(planned.state(&failed.id), LinkedState::Failed);

    // Completed is not done: a review that found blocking problems.
    let check = planned.task("Review", TaskKind::Review);
    planned.settle(&check.id, WorkerOutcome::Completed, Some(Verdict::Fail));
    assert_eq!(planned.state(&check.id), LinkedState::Failed);
    let passed = planned.task("Second review", TaskKind::Review);
    planned.settle(&passed.id, WorkerOutcome::Completed, Some(Verdict::Pass));
    assert_eq!(planned.state(&passed.id), LinkedState::Done);

    // A failed task that was replaced is history; its replacement is owed.
    let old = planned.task("First try", TaskKind::Work);
    planned.settle(&old.id, WorkerOutcome::Failed, None);
    let new = planned.task("Second try", TaskKind::Work);
    planned
        .store
        .supersede(&planned.key, &old.id, &new.id)
        .unwrap();
    assert_eq!(planned.state(&old.id), LinkedState::Closed);
    assert_eq!(planned.state(&new.id), LinkedState::Waiting);

    // An id the ledger does not hold is not in the answer at all.
    let known = planned
        .store
        .linked_tasks([waiting.id.as_str(), "task_nobody_made"])
        .unwrap();
    assert_eq!(known.len(), 1);
    assert_eq!(known[&waiting.id].run_id, planned.run.id);
    assert_eq!(known[&waiting.id].title, "Not started");
    assert_eq!(known[&waiting.id].coordinator, planned.key);

    // The person stops the run: what it did not finish is owed no more,
    // and what it finished still stands as it finished.
    planned
        .store
        .stop_run(&planned.key, planned.run.id.clone(), "Not needed".into())
        .unwrap();
    for (task, state) in [
        (&waiting, LinkedState::Closed),
        (&running, LinkedState::Closed),
        (&failed, LinkedState::Closed),
        (&new, LinkedState::Closed),
        (&done, LinkedState::Done),
        (&passed, LinkedState::Done),
        (&check, LinkedState::Failed),
    ] {
        assert_eq!(planned.state(&task.id), state, "{}", task.title);
    }
}

/// An item links only to tasks of a run its own chat coordinates, and the
/// link is checked against the ledger, not taken on the agent's word.
#[test]
fn an_item_links_only_to_tasks_of_a_run_its_chat_coordinates() {
    let planned = Planned::new();
    let mine = planned.task("Mine", TaskKind::Work);
    // Another chat's run, in the same ledger.
    let other = planned
        .store
        .create_run(
            "chat:someone-else".into(),
            "Another objective".into(),
            "workspace".into(),
            planned.dir.0.to_string_lossy().into_owned(),
            Some(2),
        )
        .unwrap();
    let theirs = planned
        .store
        .create_task_full(
            "chat:someone-else",
            other.id.clone(),
            "Theirs".into(),
            "Something else".into(),
            Vec::new(),
            None,
            None,
            None,
            None,
            None,
            TaskEnvironment::None,
            None,
            TaskKind::Work,
        )
        .unwrap();
    for id in [theirs.id.as_str(), "task_nobody_made"] {
        let refused = planned
            .change(json!({ "baseRevision": 0, "add": [{ "title": "A", "tasks": [id] }] }))
            .unwrap_err();
        assert_eq!(refused, format!("{id} cannot be linked."));
        assert_eq!(crate::chat_plan::get(&planned.chat_id), Ok(None));
    }
    let plan = planned
        .change(json!({ "baseRevision": 0, "add": [{ "title": "A", "tasks": [mine.id] }] }))
        .unwrap();
    assert_eq!(plan.items[0].tasks, [mine.id.clone()]);
}

/// What `chat_plan_get` answers for a started plan whose items became
/// tasks: the agent's own word for each item beside the host's count of its
/// tasks, which disagree where the agent is ahead of the ledger.
#[test]
fn a_started_plan_says_the_agents_word_and_the_ledgers_count_side_by_side() {
    let planned = Planned::new();
    let done = planned.task("Composer rows", TaskKind::Work);
    let review = planned.task("Review the rows", TaskKind::Review);
    let running = planned.task("Action bar", TaskKind::Work);
    let waiting = planned.task("Usage row", TaskKind::Work);
    let failed = planned.task("Run panel tabs", TaskKind::Work);
    let old = planned.task("Inline questions, first try", TaskKind::Work);
    let new = planned.task("Inline questions", TaskKind::Work);

    planned
        .change(json!({
            "baseRevision": 0,
            "add": [
                { "title": "A quieter composer", "status": "decided",
                  "decisions": ["Status rows are one line", "No box and no fill"] },
                { "title": "Action bar and usage row", "status": "decided",
                  "decisions": ["Three rows of chrome"] },
                { "title": "Run panel task rows", "status": "decided" },
                { "title": "Inline questions", "status": "decided",
                  "decisions": ["Drawn where they were asked"] },
                { "title": "Card diagrams", "status": "discussing",
                  "questions": ["How many icons?"], "note": "Asked on 2026-10-13." },
                { "title": "A sound on finish", "status": "dropped" },
            ],
        }))
        .unwrap();
    let turn_id = "octiq-plan-start-00000000-0000-4000-8000-000000000000";
    // The person's Start, and the turn that told the agent handed over.
    crate::chat_plan::start(&planned.chat_id, 1, turn_id).unwrap();
    crate::chat_plan::told(&planned.chat_id, turn_id).unwrap();

    planned.settle(&done.id, WorkerOutcome::Completed, None);
    planned.settle(&review.id, WorkerOutcome::Completed, Some(Verdict::Fail));
    planned.start(&running.id);
    planned.settle(&failed.id, WorkerOutcome::Failed, None);
    planned.settle(&old.id, WorkerOutcome::Failed, None);
    planned
        .store
        .supersede(&planned.key, &old.id, &new.id)
        .unwrap();

    // After Start the agent links each item to its tasks and moves its own
    // word. It calls the first item done; its review failed.
    planned
        .change(json!({
            "baseRevision": 1,
            "update": [
                { "id": "i1", "status": "done", "tasks": [done.id, review.id] },
                { "id": "i2", "status": "in_progress", "tasks": [running.id, waiting.id] },
                { "id": "i3", "status": "in_progress", "tasks": [failed.id] },
                { "id": "i4", "status": "in_progress",
                  "tasks": [old.id, new.id, "task_nobody_made"] },
            ],
        }))
        .unwrap_err();
    // An id the ledger does not hold cannot be linked; without it the
    // change goes through.
    planned
        .change(json!({
            "baseRevision": 1,
            "update": [
                { "id": "i1", "status": "done", "tasks": [done.id, review.id] },
                { "id": "i2", "status": "in_progress", "tasks": [running.id, waiting.id] },
                { "id": "i3", "status": "in_progress", "tasks": [failed.id] },
                { "id": "i4", "status": "in_progress", "tasks": [old.id, new.id] },
            ],
            "add": [{ "title": "Plan panel", "status": "discussing",
                      "questions": ["Where does Start go?"] }],
        }))
        .unwrap();

    let said = planned.answer();
    assert_eq!(said["chatId"], planned.chat_id.as_str());
    assert_eq!(said["revision"], 2);
    assert_eq!(said["updatedBy"], "OCTIQ HEAD");
    assert_eq!(said["awaitsStart"], false);
    assert_eq!(said["started"]["revision"], 1);
    assert_eq!(said["started"]["turnId"], turn_id);
    assert_eq!(said["started"]["told"], true);
    let progress = |at: usize| said["items"][at]["progress"].clone();
    let counts = |total, done, running, failed, waiting, closed| {
        json!({
            "total": total, "done": done, "running": running, "failed": failed,
            "waiting": waiting, "closed": closed, "unknown": 0,
        })
    };
    // The agent says done; the host says one of its two tasks failed.
    assert_eq!(said["items"][0]["status"], "done");
    assert_eq!(progress(0), counts(2, 1, 0, 1, 0, 0));
    assert_eq!(progress(1), counts(2, 0, 1, 0, 1, 0));
    assert_eq!(progress(2), counts(1, 0, 0, 1, 0, 0));
    // A replaced task is closed and is not part of the total.
    assert_eq!(progress(3), counts(1, 0, 0, 0, 1, 1));
    assert_eq!(
        said["items"][3]["linked"],
        json!([
            { "id": old.id, "runId": planned.run.id, "title": old.title, "state": "closed" },
            { "id": new.id, "runId": planned.run.id, "title": new.title, "state": "waiting" },
        ])
    );
    // Items with no task have no progress, whatever they are called.
    for at in [4, 5, 6] {
        assert!(said["items"][at].get("progress").is_none(), "{said}");
        assert!(said["items"][at].get("linked").is_none(), "{said}");
    }
    // Added after Start: it is on the plan and waits for no second Start.
    assert_eq!(said["items"][6]["addedIn"], 2);
    assert!(crate::chat_plan::gate(&planned.key).is_ok());
    fact("chat_plan_started", &said);

    // The count moves with the ledger and with nothing the agent says.
    planned
        .store
        .report_worker(
            &planned
                .store
                .snapshot(Some(&planned.run.id))
                .unwrap()
                .attempts
                .iter()
                .find(|attempt| attempt.task_id == running.id)
                .unwrap()
                .worker_chat_key,
            WorkerReport {
                attempt_id: planned
                    .store
                    .snapshot(Some(&planned.run.id))
                    .unwrap()
                    .tasks
                    .iter()
                    .find(|task| task.id == running.id)
                    .unwrap()
                    .active_attempt_id
                    .clone()
                    .unwrap(),
                outcome: WorkerOutcome::Completed,
                summary: "Done".into(),
                files_modified: Vec::new(),
                verdict: None,
            },
        )
        .unwrap();
    let later = planned.answer();
    assert_eq!(later["items"][1]["progress"], counts(2, 1, 0, 0, 1, 0));
    assert_eq!(
        later["items"][1]["status"], "in_progress",
        "the agent's word"
    );
    assert_eq!(
        later["revision"], 2,
        "the ledger moving is no change to the plan"
    );
}

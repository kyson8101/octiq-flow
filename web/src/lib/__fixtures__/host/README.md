# The ledger as the host serialises it

Each file here is the JSON one of the host's own tests answered, verbatim, at
`0479c56` (the first tree that holds both the run panel and the host rules it
reads). They are the page's proof that it reads what the host sends, not what
a test author expected it to send. **Never hand-edit them.** `../hostFacts.ts`
loads them; a test that needs another moment changes a copy and says so.

| File | Host test (`src-tauri/src/orchestration/…`) | What is printed |
| --- | --- | --- |
| `usage_context.json` | `facts_tests::the_snapshot_puts_what_was_counted_on_an_attempt_and_nothing_on_the_rest` | the answer to `orchestration_snapshot { runId }` (the page's read) |
| `coordinates_run.json` | `facts_tests::the_chat_list_says_which_chats_coordinate_a_run_that_is_not_archived` | two entries of `chat_index_list`: the lead's and a plain chat's |
| `gates_open.json` | `lifecycle::tests::an_open_gate_says_who_it_waits_for_and_nobody_can_set_it` | the snapshot with both gates open |
| `card_pending.json` | `lifecycle::tests::a_safety_card_waits_for_the_person_while_its_attempt_is_blocked_on_a_gate` | the snapshot with the card up, before the gate |
| `card_on_gate_blocked.json` | same test | the snapshot once the worker's gate blocks the attempt |
| `claude_refusal.json` | `lifecycle::tests::a_claude_auto_mode_refusal_is_recorded_and_offers_no_approval` | the snapshot after the refusal is captured |
| `peer_gate.json` | `peer_request::tests::a_peer_requests_gate_waits_for_the_person_and_its_figures_are_its_own` | the page's snapshot with the peer request's gate open |
| `held_by_plan.json` | `approval_tests::held_by_plan_is_true_or_false_on_every_task_of_a_run_with_a_plan` | the snapshot with A approved and B on the pending plan |
| `task_stopped.json` | `approval_tests::the_person_stops_one_task_and_only_they_start_it_again` | `answer`: the task `orchestration_task_stop` returns; `snapshot`: the ledger after it |
| `held_by_reopen.json` | `workspaces::tests::a_reopened_task_does_not_start_until_its_notice_is_in_the_coordinators_chat` | the snapshot while the notice cannot be written |
| `reopen_notice_delivered.json` | same test | the snapshot after the notice is confirmed |
| `plan_after_failed.json`, `plan_after_blocked.json`, `plan_after_check_failed.json`, `plan_after_stopped.json` | not a test in the tree: the probe below, run in `approval_tests` | the snapshot with A approved, started and then failed / blocked / completed with a failed check / stopped by the person, and B added afterwards so the plan is pending again |

## The failure and retry ledgers

Recorded at the commit that added `orchestration/retry.rs`, from
`src-tauri/src/orchestration/retry_tests.rs`. Each is the answer to
`orchestration_snapshot { runId }` at the moment the test asserts on it.

| File | Host test (`retry_tests::…`) | What is printed |
| --- | --- | --- |
| `failure_awaits_coordinator.json` | `a_read_says_whose_move_a_failure_is_and_when_a_retry_is_at_work` | a task failed once: `failure.awaits: "coordinator"`, `retriesUsed: 0` |
| `retry_executing.json` | same test | the coordinator's retry at work: `retrying: true`, `retriesUsed: 1`, no `failure`, the second attempt's `retry` |
| `failure_awaits_person.json` | same test | both retries used: `failure.awaits: "person"`, `because: "retries_used"` |
| `failure_escalated.json` | `the_coordinator_puts_a_failure_to_the_person_and_only_their_answer_gives_more` | the coordinator's open gate about a failed task (`aboutTaskId`, no `taskId`): `because: "escalated"`, `gateId` |
| `failure_replaced.json` | `a_replaced_failure_is_history_and_its_replacement_carries_the_count` | a replaced failure: `awaits: "nobody"`, `because: "replaced"`; its replacement with `retriesUsed: 2` |
| `failure_in_completed_run.json` | `a_failed_check_is_a_failure_and_checking_again_uses_the_retries` | a review with `verdict: "fail"` in a run whose `status` is `completed`: `kind: "check_failed"`, `awaits: "coordinator"`. That run has not ended |
| `failure_in_stopped_run.json` | `a_failure_in_a_run_that_was_stopped_or_archived_is_history` | a failed task in a stopped run: `awaits: "nobody"`, `because: "run_ended"` |

These tests print what they assert on when asked to, so nothing is added to
a scratch copy:

```bash
cd src-tauri
OCTIQ_RECORD_FACTS=1 cargo test --lib -- --nocapture --test-threads=1 retry_tests::
```

Write each `FACT <name> {…}` to `<name>.json`, indented by two spaces and
otherwise unchanged. With `--nocapture` the first `FACT` of a test follows
that test's name on the same line.

The ledgers above this section were recorded before the host counted
retries, so their tasks carry no `retriesUsed`, `retryLimit` or `failure`:
they are what a host that does not say looks like.

## A chat's plan

Recorded at the commit that added `chat_plan.rs`. Each is an answer to
`chat_plan_get { chatId }` (`../../chatPlan.ts` has its type, and
`docs/chat-plan.md` the contract). These are not ledgers: a chat's plan is
the list the person and an agent agree on before any run exists.

| File | Host test (`src-tauri/src/…`) | What is printed |
| --- | --- | --- |
| `chat_plan_none.json` | `dispatch::plan_tests::the_page_reads_a_plan_as_the_agent_keeps_it_and_hears_every_change` | a chat with no plan: `revision: 0`, no items, `awaitsStart: false`, and no `updatedAt`, `updatedBy` or `started` |
| `chat_plan_discussing.json` | same test | two items being discussed, each with open questions, one with a note: `awaitsStart: true` |
| `chat_plan_decided.json` | same test | the same plan at revision 2, every question answered and both items `decided`: still `awaitsStart: true`, no `started` |
| `chat_plan_started.json` | `orchestration::plan_link_tests::a_started_plan_says_the_agents_word_and_the_ledgers_count_side_by_side` | a started plan (`started.revision: 1`, `told: true`) whose items link tasks in mixed states: an item the agent calls `done` with one task done and one failed check; one running and one waiting; one failed; a replaced task (`closed`, outside `total`) beside its replacement; and three items with no task (discussing, dropped, added after Start), which have no `progress` and no `linked` |

The first three are the command's own answer through `dispatch`. The fourth
is `chat_plan::answer`, the function that command returns, asked in the
orchestration tests because only they can put a ledger in mixed states.

```bash
cd src-tauri
OCTIQ_RECORD_FACTS=1 cargo test --lib -- --nocapture --test-threads=1 \
  plan_tests::the_page_reads_a_plan plan_link_tests::a_started_plan
```

Write each `FACT <name> {…}` to `<name>.json`, indented by two spaces and
otherwise unchanged.

## Recording them again

The tests assert on these values and do not print them. To record, in a
scratch copy of the repository (never in the working tree), add one line
after the read in each test above:

```rust
println!("FACT <name> {}", serde_json::to_value(&snapshot).unwrap());
```

(`facts_tests` already holds the answer as `page`; print that.) Then run

```bash
cargo test --lib -- --nocapture --test-threads=1 facts_tests:: an_open_gate_says \
  a_safety_card_waits held_by_plan_is_true the_person_stops_one_task \
  a_reopened_task_does_not_start_until a_peer_requests_gate_waits claude_auto
```

and write each `FACT <name> {…}` line's JSON to `<name>.json`, indented by two
spaces and otherwise unchanged. Ids and times differ from one recording to the
next; nothing here depends on them.

## The four `plan_after_*` ledgers

These were answered by the real store at `4a7c4b1` (whose `src-tauri` is
`0479c56`'s), by the independent review of that commit: the probe was added
to a scratch copy of `src-tauri/src/orchestration/approval_tests.rs`, which
already has the `run`, `task`, `start_task` and `launch_for` helpers it
uses. The sequence is create A, approve the plan, reserve and activate A; A
fails, is blocked, completes a review with a failed verdict, or is stopped
by the person; then B is created and not approved. In all four the host
answers `heldByPlan: false` for A and `true` for B, and for the failed and
the blocked A a plain `reserve_attempt` succeeds while the plan waits.

To record them again, add this test to the scratch copy and run
`cargo test --lib -- --nocapture --test-threads=1 plan_after_a_settled_json`,
then write each `FACT <name> {…}` line to `<name>.json` as above:

```rust
#[test]
fn plan_after_a_settled_json() {
    for scene in ["failed", "blocked", "check_failed", "stopped"] {
        let store = OrchestrationStore::default();
        let run = run(&store);
        store.require_plan_approval(&run.id).unwrap();
        let a = task(&store, &run, Vec::new());
        if scene == "check_failed" {
            store.revise_task("chat:master", &a.id, TaskRevision { kind: Some(TaskKind::Review), ..Default::default() }).unwrap();
        }
        store.approve_plan("chat:master", &run.id, None, None).unwrap();
        let attempt = start_task(&store, &a.id);
        if scene == "stopped" {
            store.stop_task(&a.id, Some("Review these instructions".into())).unwrap();
        } else {
            store.report_worker(&attempt.worker_chat_key, WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome: if scene == "check_failed" { WorkerOutcome::Completed } else if scene == "blocked" { WorkerOutcome::Blocked } else { WorkerOutcome::Failed },
                summary: "A did not pass the work".into(), files_modified: Vec::new(),
                verdict: if scene == "check_failed" { Some(Verdict::Fail) } else { None },
            }).unwrap();
        }
        let b = task(&store, &run, Vec::new());
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert_eq!(snapshot.tasks.iter().find(|t| t.id == a.id).unwrap().held_by_plan, Some(false));
        assert_eq!(snapshot.tasks.iter().find(|t| t.id == b.id).unwrap().held_by_plan, Some(true));
        println!("FACT plan_after_{scene} {}", serde_json::to_value(&snapshot).unwrap());
        if scene == "failed" || scene == "blocked" {
            assert!(store.reserve_attempt("chat:master", &launch_for(&a.id)).is_ok());
        }
    }
}
```

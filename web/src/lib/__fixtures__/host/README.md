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
| `failure_check_retries_used.json` | `a_failed_check_is_a_failure_and_checking_again_uses_the_retries` | the same review after two reopens that failed again: `completed`, `verdict: "fail"`, `retriesUsed: 2`, `kind: "check_failed"`, `awaits: "person"`, `because: "retries_used"`; its two `reopens` are the coordinator's (no `byPerson`) |
| `failure_coordinator_gone.json` | `a_failure_whose_coordinator_is_gone_is_the_persons_at_once` | a task that failed once in a run whose coordinator chat is not in the chat list: `awaits: "person"`, `because: "coordinator_gone"`, `retriesUsed: 0`; the run's `status` is `failed` |
| `failure_check_coordinator_gone.json` | `with_its_coordinator_gone_the_persons_reopen_is_the_door_and_owes_no_notice` | a review that failed its check once in such a run: `completed`, `verdict: "fail"`, `kind: "check_failed"`, `because: "coordinator_gone"`, before the person reopens it |
| `failure_time_limit.json` | `a_peer_requests_failure_waits_on_its_runs_coordinator_then_the_person` | a peer request (`peerRequest`, `maxMinutes: 1`) that failed with its minute of working time used: `awaits: "person"`, `because: "time_limit"`; the answer to `orchestration_snapshot { runId }` for its run |

The last four were recorded at the commit that separated what a failure is
shown as from what is counted and gave the person their own reopen (fix
round 1 of the review of 16e4188), with the command below. The seven above
them were not recorded again: nothing they hold changed.

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

## An answered question's line

Recorded at the commit that added the line. Each is one event of a chat's
record, read back from the record itself (`transcript::of_type`), as
`chat_since` and `chat_page` hand it to the page and as a `chat-event`
carries it (`../../question.ts` has its type, `QuestionAnswered`, and
`docs/question-delivery.md` the contract). These are not ledgers.

| File | Host test (`src-tauri/src/answered_tests.rs`) | What is printed |
| --- | --- | --- |
| `question_answered_native.json` | `a_natively_asked_questions_answer_stays_in_the_chats_record` | the line written when the answers to two questions Codex asked through its own request (`item/tool/requestUserInput`) were handed to it: `via: "native"`, a question with two options (one described) and a free-text one (`options: []`), no `recommended` |
| `question_answered_tool.json` | `a_tool_question_answered_while_its_call_waits_leaves_the_same_line` | the line for an `ask_user` call answered while it waited: `via: "tool"`, a question with `recommended: 1` and one with `multiple: true` |

```bash
cd src-tauri
OCTIQ_RECORD_FACTS=1 cargo test --lib -- --nocapture --test-threads=1 \
  answered_tests::a_natively answered_tests::a_tool_question
```

Write each `FACT <name> {…}` to `<name>.json`, indented by two spaces and
otherwise unchanged. The keys come out sorted: that is how the host writes
them.

## A question's media

Recorded at the commit that added `question_media.rs`
(`docs/question-delivery.md`, Media). Both from
`src-tauri/src/web.rs`'s `tests::an_ask_user_call_shows_the_snapshots_its_chat_uploaded_and_nothing_else`,
which uploads through `/hook/question-media` and asks through `/hook/ask` on
a real server. The paths are the test's scratch profile; nothing depends on
them.

| File | What is printed |
| --- | --- |
| `question_media_pending.json` | the call's one entry of `question_pending` (the same shape a `user-question` event carries): `media` with an image (with a caption) and an MP4 video (without), the first option with an `image`, the second a plain label |
| `question_answered_media.json` | the `octiq_question_answered` line (`via: "tool"`) after the person answered `Keep`: the question's `media` and the option's `image` as listed |

```bash
cd src-tauri
OCTIQ_RECORD_FACTS=1 cargo test --lib -- --nocapture --test-threads=1 an_ask_user_call_shows
```

Write each `FACT <name> {…}` to `<name>.json` as above.

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

## Per-task workspace approval

Recorded from the host tests in `orchestration/workspaces.rs`, using the same
`OCTIQ_RECORD_FACTS=1` / `FACT <name> {…}` capture above. These are complete
`orchestration_snapshot { runId }` answers, including the derived
`task.workspaceChoice` and the approved allocation mode.

| File | Host test (`workspaces::tests::…`) | Moment |
| --- | --- | --- |
| `workspace_choice_pending.json` | `workspace_choices_snapshot_records_the_host_contract_for_the_page` | Auto writer advises worktree, reader advises checkout; both await approval |
| `workspace_choice_approved.json` | same test | The person chose checkout for the writer and worktree for the reader; proposals and approvals fix those modes |
| `workspace_choice_only_checkout.json` | `workspace_choices_for_a_non_git_folder_only_offer_checkout_and_reject_worktree` | An explicit Worktree run over a non-Git folder advises and offers checkout only, with `onlyCheckoutBecause`; approval re-plans its pending proposal as Direct |

```bash
OCTIQ_RECORD_FACTS=1 cargo test --manifest-path src-tauri/Cargo.toml --lib -- \
  workspace_choices_ --nocapture --test-threads=1
```

Write each printed FACT JSON to the matching file, indented by two spaces and
otherwise unchanged; never reconstruct these snapshots by hand.

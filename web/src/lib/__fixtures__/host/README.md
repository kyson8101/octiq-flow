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

# Browser event subscriptions and orchestration reads

Evidence captured 2026-11-07 from the running local server and its real `default` profile, read-only. No server restart or live profile mutation. The transport is identical behind the tunnel; this sample used loopback, not a phone heap or tunnel performance test.

## Measured baseline

- `orchestrations.json`: **34,444,178 bytes** on disk (pretty JSON).
- Existing `orchestration_snapshot {}`: **30,996,850 bytes** compact JSON, including live derived usage/reports.
- Existing `orchestration_snapshot {brief:true}`: **13,184,305 bytes**. Brief omitted long text only for 238 finished runs; active runs and reports/execution still travel.
- 250 runs, 1,412 tasks, 1,981 attempts, 251 gates, 1,181 messages, 404 notifications, 71 native decisions, 1,798 reports, 7 services, 4 peer asks, 0 bridges.
- Largest chat record at capture: **170,989,128 bytes**. This task does not alter transcript paging or retention.
- Largest contributors to the full wire read: tasks 13,163,392 B; attempts 13,045,776 B; messages 1,726,924 B; reports 1,104,086 B; notifications 876,977 B; gates 701,804 B. `execution` alone accounts for 5,536,336 B across attempts.

## Complete bus inventory

39 production event kinds found by scanning every `bus::emit` call under `src-tauri/src`. The 29.991-second live sample counted UTF-8 bytes of the actual complete WebSocket event frames (including envelope). A zero count means *not observed in this window*. `—` means no observed size, not a guessed zero-sized event. Rates are the sample's averages, not capacity estimates or lifetime traffic.

| Event | Scope / delivery after opt-in | Frames | Frames/s | Total wire B | Mean B | Max B | Producer |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `access-request` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `access_request.rs` |
| `access-request-expired` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `access_request.rs` |
| `agent-avatar-job` | global | 0 | 0.000 | 0 | — | — | `agent_avatar.rs` |
| `chat-completed` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `agent_chat.rs` |
| `chat-completing` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `agent_chat.rs` |
| `chat-event` | per-chat heavy; subscribers only | 45 | 1.500 | 84253 | 1872.3 | 20842 | `agent_chat.rs` |
| `chat-index-changed` | chat identity; global status/card | 10 | 0.333 | 1116 | 111.6 | 112 | `agent_chat.rs` |
| `chat-job` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `chat_jobs.rs` |
| `chat-provider-switch` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `provider_switch.rs` |
| `chat-queue-waiting` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `agent_chat.rs` |
| `chat-status` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `agent_chat.rs` |
| `chat-task` | chat identity; global status/card | 10 | 0.333 | 10452 | 1045.2 | 1530 | `chat_task.rs` |
| `disk-scan-done` | global | 0 | 0.000 | 0 | — | — | `disk_report.rs` |
| `disk-scan-progress` | global | 0 | 0.000 | 0 | — | — | `disk_report.rs` |
| `feedback-changed` | global | 0 | 0.000 | 0 | — | — | `feedback.rs` |
| `file-changed` | global | 0 | 0.000 | 0 | — | — | `file_watch.rs` |
| `git-status-changed` | global | 1 | 0.033 | 99 | 99.0 | 99 | `git_watch.rs` |
| `handover-changed` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `handover.rs` |
| `island-changed` | global | 0 | 0.000 | 0 | — | — | `island.rs` |
| `media-comments-changed` | global | 0 | 0.000 | 0 | — | — | `media_comments.rs` |
| `orchestration-auto-plan` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `orchestration/auto_plan.rs` |
| `orchestration-changed` | per-run; global invalidation | 24 | 0.800 | 40432 | 1684.7 | 5738 | `orchestration.rs` |
| `permission-ask` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `permission.rs` |
| `permission-expired` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `permission.rs` |
| `provider-fallback-changed` | global | 0 | 0.000 | 0 | — | — | `failover_policy.rs` |
| `pty-attention` | per-terminal; stays global (legacy terminal contract) | 0 | 0.000 | 0 | — | — | `pty.rs` |
| `pty-hidden-output` | per-terminal; stays global (legacy terminal contract) | 0 | 0.000 | 0 | — | — | `pty.rs` |
| `pty-output` | per-terminal; stays global (legacy terminal contract) | 0 | 0.000 | 0 | — | — | `pty.rs` |
| `pty-restore` | per-terminal; stays global (legacy terminal contract) | 0 | 0.000 | 0 | — | — | `pty.rs` |
| `pull-request-workflow` | global | 0 | 0.000 | 0 | — | — | `pr_workflow.rs` |
| `question-expired` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `question_store.rs` |
| `question-updated` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `question_store.rs` |
| `safety-block-expired` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `safety_block.rs` |
| `safety-blocked` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `safety_block.rs` |
| `team-changed` | global | 0 | 0.000 | 0 | — | — | `dispatch.rs` |
| `unsaved` | global | 0 | 0.000 | 0 | — | — | `unsaved.rs` |
| `user-question` | chat identity; global status/card | 0 | 0.000 | 0 | — | — | `question_store.rs` |
| `worktree-lifespan-changed` | global | 0 | 0.000 | 0 | — | — | `worktree_lifespan.rs` |
| `worktree-swept` | global | 0 | 0.000 | 0 | — | — | `worktree_lifespan.rs` |

All non-`chat-event` status/card/index events remain global, even if they name a chat. Approval/access/worker gates and hook routes are unchanged. PTY output/restore is keyed by terminal id, not chat key, and retains its existing broadcast contract in this change.

## Whole-app reader inventory

The same summary feeds every whole-app reader; wait logic stays in `lib/runWaits`. No second backend-derived “needs you” count replaces it. External held permission/safety/question/handover cards remain separate global stores and are merged by `pendingActions` and `runWaits` exactly as before.

| Surface / source | Fields it reads | Summary contract |
| --- | --- | --- |
| `orchestrationFeed` | all array identities; attempt execution patches; reports; holds; per-run text cache | summary skeleton; no history text cache; detail belongs only to open run |
| `runWaits`, `pendingActions` | run id/status/archivedAt/planApproval.status/revision; tasks id/runId/activeAttemptId/parentTaskId/splitBy/status/supersededBy/approvedAt/peerRequest/failure; gates id/runId/taskId/aboutTaskId/status/awaits; native decisions id/groupId/runId/taskId/attemptId/status/kind/awaits | exact host facts; open gates and pending native decisions only; use `runWaits` unchanged |
| `runProgress`, `agentTaskBoard` | task status/kind/verdict/dependencies/title/worker/assignee/activeAttemptId/retry facts/stopped/holds/reopen stamps; attempt identity/status/number/times/execution/usage/context/proposedReport; current checklist steps/reportedAt | all state facts retained; no spec/result/proposal text/lastProgress; old attempt metadata retained for time/token totals |
| `chatWorkflow.chatSnapshot`, sidebar and worker grouping | run coordinatorChatKey/status/timestamps; every task and attempt identity; attempt workerChatKey/number/archive state; task title/status/verdict/failure; reports | scope summary by coordinator, preserve all run wait inputs; detail is never needed for sidebar status |
| Agents page (`AgentsDashboard`, `agentsDashboard`, `useAgentRows`) | runs coordinator/status/archivedAt; tasks assignee/title/destination/acceptance/holds/failure/status; latest attempt identity/status/execution/workerChatKey/updatedAt; `runWaits` | summary; roster/levels/card/live-process stores continue through existing commands |
| Island (`useAgentRows` → agent rows → island reading/feed) | same agent rows, activity/state/counts as Agents page | no independent ledger/card interpretation; summary reaches it through the same rows |
| `chatPlans`, `chatBeside`, `conversationProjects`, `runColumn`, `taskReopened` | run/task/attempt keys, rootPath/workspaceId/destination, status, timestamps, holds, parent/split identity | summary metadata |
| Open run/task drawers: `OrchestrationPanel`, `AgentTaskBoard`, `TaskLifecycleEvidence`, `RunBridges`, plan review | task spec/result/card/workspace/workspaceProposal/approval/reopen text; attempt cwd/branch/filesModified/summary/proposed text/peer clock; gate question/options/answer; decision history; run worker defaults/mission delivery; messages/notifications/services/bridges/peer asks | fetch `orchestration_run_detail {runId}`; never render omitted summary fields as real empty saved values |

## Socket contract

Send an ordinary invoke on `/ws`:

```json
{"t":"invoke","id":1,"cmd":"chat_subscribe","args":{"chatKeys":["chat:main-id","chat:beside-id"]}}
```

The successful reply contains `{chatKeys:[...]}` (sorted, deduplicated). The set **replaces** this socket's previous set; `[]` opts in while watching no chat. Use the exact key the `chat-event.payload.key` carries, including `chat:`. At most 64 nonempty keys, each at most 512 UTF-8 bytes; invalid requests leave the current selection unchanged. This is a socket-local command, not a `dispatch`/MCP/agent-hook command. Selection and acknowledgement are serialized with event writes: a heavy frame selected under the old set cannot follow the acknowledgement.

A socket that **never invoked this command** gets the original full frames for every chat and execution update. Opt-in sockets receive heavy `chat-event` frames only for their selected keys. All existing global events stay global. Their `orchestration-changed` execution patches omit `lastProgress`, pending-tool bodies and other internal maps; state/retry/error/timestamps and the revision remain. A malformed chat frame lacking a key retains legacy delivery, rather than silently dropping an unknown producer's frame.

**Reconnect:** each new socket starts in legacy mode. The new page must resend its current selection as its **first invoke**, await the acknowledgement, then catch up the selected transcripts using their own stored replay cursors. No subscription is shared between tabs or persisted across connections. Switching panes uses the same subscribe-then-catch-up order. Unsubscribed chats replay only when opened. A new page talking to an older backend must recognize command-unavailable errors and retain its previous snapshot/stream path; an unavailable command is not an empty ledger or a successful subscription.

### Small activity for unopened chats

Only opt-in sockets get `chat-stream-activity`, in place of their omitted stream frames:

```json
{"t":"event","event":"chat-stream-activity","payload":{"key":"chat:worker","seq":123,"running":true,"busy":true,"turnId":"host-turn-id","lastActivityAt":1793991000000,"work":true}}
```

`seq` is the latest observed durable sequence, nullable when the frame has none; it is an **invalidation/watermark, never a transcript replay cursor**. `running`/`busy`/`turnId` are read from the host's current session, not guessed from provider text; unknown values are `null`. `lastActivityAt` is the host's wall-clock time when the latest omitted frame was observed. `turnId` can be null if the host has none.

The first update and changes of running/busy/turn identity are sent immediately. Otherwise frames are coalesced per socket and chat for one second. A 250ms timer flushes the trailing update even without another frame, and checks the final busy state after the final provider frame; it does not emit unchanged idle state on a timer. Coalesced `work` is the OR of work signs in that window and resets after send. Quiet tracking entries expire after 60 seconds; disconnect drops the whole map. No stream text is retained in that map.

`work` mirrors `restoredPark.signOfWork`: only a main writer's Claude `stream_event`/`assistant`, Antigravity `step_update`, or Codex `item.*` (for `item.completed`, only `agent_message`/`reasoning`). Truthy `parent_tool_use_id` and `octiq_speaker` exclude subagents/seats. Host `octiq_` lines, tool results, prompt echoes and full stops are not work. FE must hand this flag to the existing `withWork`/restored-park machine, not replace that machine with `busy` or mark a card answered by receiving activity.

On reconnect, `chat_activity` remains the initial read. Activity provides subsequent background facts directly, with no per-frame round trip.

## Ledger contract

- `orchestration_summary {runId?: string}`: one whole-app status skeleton, or one run's skeleton for replacement after invalidation. Same top-level lists as `Snapshot`, plus `summary:true`, `revision`, `runRevisions`, and per-run `revision`/`counts`. Runs/tasks/attempts keep their order and identities. All runs, including history, retain status facts.
- `orchestration_run_detail {runId:string}`: full snapshot of that run, plus the same revision fields. `runId` is required. Fetch for an open run/task drawer **and the visible inline plan review**, release the detail when its surface closes, and use `runWaits` against the same current facts.
- `orchestration_snapshot`: unchanged, including its `brief` option and capability-scoped agent view. No MCP tool or agent-hook route was added or changed.
- `orchestration-changed`: existing event with an additional opaque `revision` token. Both normal changes and worker-execution patches get it at the bus door. No listener is required for a token to advance.

Tokens are `<server-epoch>:<sequence>`. Treat them as opaque invalidations, not sortable strings, timestamps or approval revisions. The epoch changes on server restart. `runRevisions` covers the runs in the answer; a per-run read's top `revision` is that run's token. Whole summary's top `revision` is the process change token. Each read captures tokens **before** deriving its snapshot, so a concurrent change remains an invalidation the reader must handle. Coalesce events during an in-flight read into one follow-up; never discard an event merely because a response was in flight. Tokens do not promise an atomic immutable snapshot/ETag across external card/usage stores.

Initial page load: fetch one summary. On `orchestration-changed`, patch its compact execution if possible, or refetch `orchestration_summary {runId}` and replace only that run's summary records. An open run also refetches its detail. Reconnect refreshes the whole summary because the event channel is not replayed. Avoid mixing old detail state with a newer summary: merge long text only, or replace/invalidate the detail with the run revision.

`counts` contains exact entity counts (`tasks`, `attempts`, `gates`, `nativeDecisions`, `messages`, `notifications`) and raw `taskStatuses` from the snapshot before omitted history is removed. These are inventory counts, **not** an alternate needs-you/done/failed calculation. The existing `runWaits`/`runProgress.runCounts` derive those UI readings from the retained facts and held cards, identically on every surface.

Summary projections keep all task failure/retry/hold facts exactly as derived by the existing snapshot. `heldByPlan:false` is retained; an absent fact stays absent. Reopens keep `at`/`noticeDelivered`. Pending native decisions keep `awaits`, `continuation`, group/card identity and short reason/recovery/action. Only open gates and pending native decisions are in the skeleton. Historical gate/decision text is in detail.

Removed from **every** run, active or historical: task spec/result/cards/approval rollback/workspace detail/reopen original text, attempt summaries/modified-file lists/proposal text/internal execution maps, plan approval evidence, message/notification/peer-ask/service/bridge bodies. Placeholder `spec:""`, proposal `text:""`, gate `question:""`/`options:[]`, and empty history arrays explicitly mean omitted under `summary:true`; never submit or render them as actual saved detail. Current-attempt reports keep step states/titles and report timestamps, not objective/nextStep text. Attempts retain compact identity/status/timing/usage/context and cwd/branch metadata for global grouping and totals. Stopped-task reasons, execution error/operation, native reason/recovery/action, report step titles and run objectives are limited to 512 Unicode characters; detail keeps the original text.

All projections, counts and revisions are read-time only. No derived field is stored or accepted from agents. Existing approval/access/worker gates and authoritative failure/hold/await derivations are untouched.


### Exact summary projection

Nested values not narrowed below retain their original snapshot facts. Missing optional values stay missing. The implementation allowlist is `src-tauri/src/orchestration/summary.rs`; these are its serialized fields, not a second UI state machine.

| Record | Retained fields |
| --- | --- |
| `run` | `id`, `objective`, `coordinatorChatKey`, `workspaceId`, `rootPath`, `status`, `maxConcurrent`, `workspaceMode`, `createdAt`, `updatedAt`, `archivedAt`, `closedAt`, `abandoned`, `planApproval`, `autoPlan` |
| `plan` | `status`, `revision`, `requestedAt`, `decidedAt`, `revisedAt` |
| `task` | `id`, `runId`, `title`, `worker`, `assignee`, `destination`, `approvedAt`, `size`, `acceptance`, `dependsOn`, `parentTaskId`, `splitBy`, `status`, `activeAttemptId`, `kind`, `verdict`, `supersededBy`, `heldByPlan`, `heldByReopen`, `retriesUsed`, `retryLimit`, `retrying`, `failure`, `reopens`, `stopped`, `peerRequest`, `createdAt`, `updatedAt` |
| `reopen` | `at`, `noticeDelivered` |
| `peer` | `requestedBy`, `requesterChatKey`, `requesterAttemptId`, `requestedAt`, `maxMinutes` |
| `attempt` | `id`, `runId`, `taskId`, `number`, `workerChatKey`, `agent`, `model`, `effort`, `access`, `status`, `cwd`, `branch`, `isWorktree`, `execution`, `finishedAt`, `archivedAt`, `proposedReport`, `usage`, `context`, `retry`, `createdAt`, `updatedAt` |
| `proposal` | `id`, `capturedAt`, `confirmedAt`, `confirmedBy`, `truncated` |
| `execution` | `state`, `lastActivityAt`, `lastProgressAt`, `currentOperation`, `latestError`, `retryCount`, `nextRetryAt`, `retryModel`, `stalledAt` |
| open gate | `id`, `runId`, `taskId`, `aboutTaskId`, `status`, `awaits`, `createdAt`, `updatedAt`; empty `question`/`options` placeholders |
| pending native decision | `id`, `runId`, `taskId`, `attemptId`, `chatKey`, `status`, `awaits`, `continuation`, `kind`, `groupId`, `reason`, `blockedAction`, `recovery`, `observedAt` |
| current report | `steps` (state/title), `reportedAt`, `reportedBy`; empty objective/nextStep placeholders |

`run` additionally gets read-time `counts`/`revision`; task `spec` and attempt `filesModified` are empty placeholders. `messages`, `notifications`, `services`, `bridges` and `peerAsks` are empty in summary and whole in per-run detail. Detail also restores all omitted nested evidence/text, including every task approval/workspace/reopen field and every attempt execution field.

## Validation and measured after size

The exact new Rust `summary::project` plus `bus::RevisionRead::stamp` functions were run against the captured real wire JSON, without starting a replacement service or touching the live profile:

| Payload | Before B | After B | Reduction |
| --- | ---: | ---: | ---: |
| Full real ledger → summary, including revision fields | 30,996,850 | 3,891,296 | 87.45% |
| Existing brief → same summary | 13,184,305 | 3,891,296 | 70.49% |
| One synthetic unopened chat frame → compact activity | 100,113 | 160 | 99.84% |

The full initial summary still carries every run/task/attempt identity and state; ordinary invalidations refetch only the changed run. No live browser heap, phone render, tunnel throughput or crash-free endurance result is claimed here. The live service has not been rebuilt/restarted. End-to-end memory verification belongs to the coordinator/FE integration.

Validation: `cargo test --manifest-path src-tauri/Cargo.toml --lib` passed **2,069 tests, 0 failed, 18 ignored** (274.32 s), including the browser summary/detail compatibility and hook-route test. `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and `git diff --check` passed. The source-module contract harness additionally passed **12 tests, 0 failed, 1 ignored**, including the 144,290,052-byte synthetic ledger → **201,667-byte summary**. The actual project test binary separately passed the explicit read-only captured-profile measurement (1 test, 5.76 s): **30,996,850 → 3,891,296 bytes**. The Cargo binary targets and browser endurance were not exercised by this backend task. The first red test build failed on the missing subscription types as intended; implementation is a separate commit. Contract tests cover filtering, never-subscribed exact wire preservation, invalid selection rollback, per-run revisions, compact execution, trailing coalescing/state flips/work signs/expiry, wait/hold/progress fields, and a >100 MB synthetic ledger fixture. A dispatch test compares summary/detail with the old snapshot and verifies no new hook route.

To repeat the read-only real-wire size check after capturing a snapshot outside the repository:

```sh
OCTIQ_SUMMARY_MEASURE_INPUT=/absolute/path/captured-snapshot.json cargo test --manifest-path src-tauri/Cargo.toml --lib orchestration::summary::tests::measure_captured_snapshot -- --ignored --nocapture
```

The captured real profile payload and credentials are deliberately not committed. Inventory sizes are UTF-8 compact JSON unless explicitly labeled on-disk pretty JSON. The measurement harness used the actual source modules (with only a module-path shim for standalone compilation); no hand-translated projection was measured.

## Background readers of chat-event (FE migration checklist)

- `App`'s live handler / `recovery.provesLiveTurn`: adopts a running process and folds `busy`. Use `running`/`busy`/`turnId` from activity for an unopened chat; reconnect still reads `chat_list`/`chat_activity`. Do not allocate a transcript to update a dot.
- `turnClock.withWork` / `restoredPark.signOfWork`: a live main-writer work signal may end an answered restored park. Feed `work:true` through that same machine, including a held-but-unsubscribed chat. Busy alone, a tool result or an answered card is not a work signal.
- `App`'s `wasBusy` completion effect: drives completion notices, `announce("done")`, completion timestamps and latest-response preview. Use real busy transitions for unopened chats. No unseen stream means no new preview text to invent; keep the server index's existing preview until opening/refetching it.
- `unread.isUnread`, sidebar ordering and `useRowMotion`: use index/send/completion boundaries for `updatedAt` and `readAt`. A streaming activity hint must not reorder a row every second; `lastActivityAt` is not a replacement for the existing meaningful `updatedAt` rule.
- `useAgentRows` / Agents / island and the PR dashboard's busy flags: use compact live state, and the summary's worker/task status. Keep `pendingActions`/`runWaits` as the only decision reading.
- `foldedSafetyKeys` / restored-park held chat list: currently consult the loaded `ChatState.busy` and park state. Preserve these small facts separately from transcript residency; all safety/question/permission/access cards still arrive globally.
- Native provider background tasks (`ChatState.background`, `task_started`/`task_notification`, `octiq_background_interrupted`) also used the stream. This roster is distinct from registered jobs. Replay it when that chat is opened; a compact `busy:false` must never be used to erase previously known background work. Reader scan found **no outside-open-chat reader**: checked Sidebar, AgentsDashboard, ProjectsPage, ChatWorkflowBar, agentsDashboard/runProgress, rowMotion/unread, and island reading/activityProps. Actual reads are the chat reducer and visible main/beside `runningCalls`/`BackgroundProvider`/Composer props. Therefore activity deliberately has no background-count field; this change does not add an independent global native-background roster.
- Jobs: `jobFeed` receives global `chat-job`, including registration, progress and completion. `useJobCalls` matches a visible transcript's tool call to registered jobs; match only the main/beside chat on screen. Background job existence does not require the chat stream, and must not subscribe the transcript merely to show a job dot.
- Composer clock/companion (`workingLine` / `WorkingLine`): uses `busy`, turn clock, waits and jobs; subscribe the visible main and beside pane, use compact activity for retained background clocks, and preserve global jobs. A person-wait remains parked through the existing wait machine.
- The loaded-chat save/checkpoint effect, `latestResponse`, session/model/cwd, agent command suggestions and `chatHistory`/catch-up all previously consumed every transcript. After opt-in, only an on-screen/retained transcript can contribute transcript/checkpoint data. Never advance its replay cursor from an activity `seq`, and never save a fabricated empty transcript or empty preview for an unopened chat. Opening it replays via the existing paged record APIs.

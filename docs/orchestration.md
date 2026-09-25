# Master orchestration

OctiqFlow can make an existing chat the master of a supervised multi-agent
run. The master plans a shallow dependency graph, starts the ready tasks, and
coordinates workers. OctiqFlow owns the run state outside every agent
transcript, so a confident sentence from a stale worker cannot complete a task.

Open **Orchestrator** in the top bar, describe the outcome, choose a workspace
mode, worker limit and automatic dispatch settings, and start the run. The
current chat becomes its master. The panel shows
the task ledger, current attempts, worktree branches, open decisions, and the
latest structured messages.

The main agent chooses the provider, model, and reasoning effort for each task.
A run can mix Claude and Codex workers. Fable and Astra are reserved for main
agents orchestrating other agents; the host rejects them for every worker,
including retries and review tasks. Suitable execution choices include Sol,
Terra, Luna, Opus, Sonnet, and Haiku. This restriction applies to orchestration
workers, while ordinary chat model selection remains available.

Pass each choice as `worker: { agent, model, effort, access }` when creating a
task. Automatic dispatch uses that saved choice, including for dependent tasks
in later waves. Enable it with `workerDefaults: { access: "auto" }`; the main
agent must select a worker before a new task is accepted. Manual dispatch and
retries choose their settings through `orchestration_worker_start`.

Existing runs may still have a run-wide provider fallback; a task's own worker
settings take precedence. Missing models resolve explicitly to Codex Sol or
Claude Sonnet, never to the provider CLI's configured default. Legacy tasks
without a selection or a run-wide fallback wait for an explicit worker start
and do not consume dispatch capacity. Pausing automatic dispatch preserves
task selections; enabling it again does not copy the last attempt's model.

## Communication

The chat list shows a compact task board below each main agent. Each assignment
appears once, including tasks waiting for dependencies. Retries stay in that
task's expandable details. The board shows completed/total tasks, to-do and
working counts, attention states, and elapsed wall time. Expand a task to inspect
its assignment, reported checklist, branch, full working folder, worktree mode,
and delivery state, or choose **Open activity** to read its worker conversation.

Overall completion is the fraction of tasks recorded as completed by the host.
Both task boards label this metric **Tasks completed** and show **Acceptance:
unverified** separately. The host does not yet record product acceptance results;
even a completed review can report failing checks. Consult the test evidence
before treating a completed run as ready to release.
Individual progress comes from completed steps in the worker's `task_status`
report; a running task without a reported plan has no percentage. The current
stage comes from its active step, and reports include their timestamp. New
worker briefs request a checklist at the start and updates as steps finish.
Checklist completion does not settle an orchestration task.

Task time sums the durations of its attempts, including preparation and decision
waits but excluding the gaps between retries. Run time spans the first dispatch
to the latest settlement (or now while an attempt is active), counting overlapping
workers once. Settled attempts retain a separate finish timestamp so later
metadata changes cannot increase their runtime. These are elapsed durations,
not measurements of CPU or model generation time.

The main chat is the person's instruction channel. Worker chats are nested
under it for inspection and stay read-only, including after completion or a
retry. Their composer and direct restart, queue, settings, and delete controls
are unavailable. The backend also rejects those commands for worker chat keys;
the orchestrator keeps its internal dispatch and continuation paths.
Resuming a known worker session under a new ordinary chat key is rejected too.

Workers send messages only to their coordinator, never to another worker, and
cannot create their own runs. Blocking questions open a coordinator gate and
notify the main agent. Native and legacy question tools follow that same route.
The person's answer in the Orchestrator panel is sent to the main chat; the
main agent reviews it and resolves the gate. Pending tool safety approvals are
shown in the main chat and still require the person's explicit decision.

## State model

The profile stores `orchestrations.json` atomically. A snapshot contains:

- **Run** — objective, coordinator chat, project root, status, and concurrency
  limit.
- **Task** — bounded specification, dependencies, current state, and the one
  authoritative attempt. A task may carry a **destination**: a registered
  project and a repository registered on it (`orchestration/destination.rs`).
  Its workspace is planned from that repository, its worker chat belongs to
  that project and gets that project's environment, and every retry and review
  attempt reuses the same workspace. A task without a destination (every task
  created before destinations existed, and ordinary runs that name none) runs
  in the run's own root, as before. The destination is checked again before
  each worker starts: a project deleted or a repository unregistered since
  creation stops the task with an error; the host never redirects it.
- **Attempt** — worker chat, provider, access, worktree, branch, report, and
  changed files, plus a separate host-owned `execution` record.
- **Gate** — a blocking decision with optional known choices. Resolving it
  records the answer and resumes the requesting agent.
- **Message** — a durable directed coordinator/worker message. Delivery wakes
  or resumes the target chat when its saved runtime context is available.

Each mutation is persisted before it is announced to browsers. If the saved
file cannot be read, the store refuses to overwrite it.

### Execution evidence and provider recovery

Task state describes the assignment's outcome. `attempt.execution.state`
describes what the provider is doing: `queued`, `executing`, `waiting_tool`,
`retrying`, `capacity_blocked`, `failed`, `disconnected`, `stalled`, or
`awaiting_report`, with completed, cancelled and decision-blocked states too.
The board uses execution evidence when counting active work. A model at
capacity is never counted as executing merely because its process is alive.

The host observes dispatch results, Claude/Codex error events, provider retries,
tool starts/results, model output, and process disconnections. A terminal
provider failure fails the attempt and atomically records a coordinator inbox
notification. The task becomes blocked while a host retry is scheduled, or
failed when recovery needs review. Browsers receive `orchestration-changed`
after persistence. Neither path needs another successful worker model response.
An internal provider retry is visible immediately and has a finite time budget.

Both the snapshot and Run details expose `lastActivityAt`, `lastProgressAt`,
`lastProgress`, `currentOperation`, and `latestError` (kind, message, timestamp,
retryability). Streaming tokens count as activity, not completed progress.
Tool activity and structured progress reports update progress evidence.
Errors remain visible during recovery. A completed tool failing is not itself
a failed model request; quoted error text in worker prose is not failure evidence.

Workers default to two host retries, with 5-second then 10-second backoff and
a 60-second ceiling. Set `worker.recovery` in `orchestration_task_create`, or
`workerDefaults.recovery` for a run, to configure:

```json
{
  "maxRetries": 2,
  "baseDelayMs": 5000,
  "maxDelayMs": 60000,
  "fallbackModel": "gpt-5.6-terra",
  "stallAfterMs": 300000,
  "toolStallAfterMs": 1800000
}
```

`maxRetries: 0` disables host retries; the maximum is five. `maxDelayMs` also
bounds a provider's own retry loop. A configured fallback uses the same provider
and access level and must be an execution model. Mixed-provider runs configure
fallback models on each task. Each recovery gets a new authoritative attempt
and reuses the task's existing workspace, branch, uncommitted files and prior
checklist context. The previous process stops before the lease transfers.
Late reports cannot settle a replacement. Inspect `nextRetryAt`, `retryCount`
and `retryModel` before starting a manual retry, which supersedes scheduled
recovery. Pausing ready-wave dispatch does not cancel already scheduled recovery;
stopping the run does.

No meaningful progress for five minutes raises a durable stalled notification;
tool waits get thirty minutes by default. These are advisory alerts: silence
does not prove a tool failed, so the host does not kill or replay a stalled tool.
Disconnects and failures with outstanding tools require coordinator review.
Open decisions and pending safety approvals keep their existing wait behavior.
On host restart, interrupted workers become disconnected failures with durable
notifications; retained work and previously scheduled recovery survive.

Failure notifications are immediately available in the coordinator's snapshot
and durable inbox. Delivery runs on the host's two-second scheduler and waits
behind an active coordinator turn or queued user messages. A delivery receipt
confirms provider receipt, not that the coordinator has acted.

## Worker lifecycle

1. The master creates tasks, chooses suitable execution workers, and adds real dependency edges.
2. The host scheduler (or the coordinator in manual mode) starts the entire
   ready wave up to the run's concurrency limit.
3. OctiqFlow reserves an attempt and persists its task workspace before process
   or Git setup begins.
4. Code work creates a linked Git worktree by default and starts a dedicated
   Claude or Codex chat there.
5. The worker must call `orchestration_worker_report` with its exact attempt ID.
   Only that chat and the active attempt may report an outcome. The host can
   also fail an attempt from provider execution evidence.
6. Completed dependencies unlock pending tasks. A reported block can be
   retried; a gate-blocked attempt waits for its decision instead. Retrying
   reuses the previous attempt's assigned workspace
   and preserves its changes while replacing `activeAttemptId` with the new
   attempt.

A worker report settles its attempt exactly once. Directed messages are
delivered only to active attempts: a message to a completed, failed, cancelled,
or reported-blocked attempt is rejected with guidance to create a retry. A
blocked attempt with an open gate must be resumed by resolving that gate.

A Codex safety rejection that raises OctiqFlow's approval card is still a
pending host decision, not a blocked worker outcome. The worker ends its turn
without opening a duplicate gate or settling the attempt, so the person's
choice can resume that same attempt. If an older worker has already reported
blocked, the coordinator must start a new attempt before sending further
instructions.

Late reports from replaced attempts are rejected. Stopping a run cancels open
tasks and gates and stops its active worker chats. Worker chats stay in the
normal chat index, so their transcript and worktree remain inspectable.

## Agent tools

The bundled chat-bound MCP exposes:

- `orchestration_run_create`
- `orchestration_task_create` (with optional `project` and `repository`)
- `orchestration_destinations` — registered projects, their repositories, and
  (in agents mode) which direct reports may work in each
- `orchestration_snapshot`
- `orchestration_worker_start`
- `orchestration_worker_report`
- `orchestration_gate_create` / `orchestration_gate_resolve`
- `orchestration_message_send`
- `orchestration_run_stop`

The authenticated local `/hook/orchestration` endpoint injects the calling chat
identity; callers cannot claim another worker's attempt. Browser actions use
the same dispatch commands as the MCP path.

A `rootPath` passed to `orchestration_run_create` must be the chat's own folder
or lie inside a folder registered on the run's project; any other folder is
refused. A task `project` is a registered project's id or name, and
`repository` a path registered on it (or that folder's name). Anything else is
an error that says what to pass instead.

## Workspace and delivery lifecycle

The [task workspace lifecycle](subagent-worktree-lifecycle.md) defines execution
modes, host automatic dispatch, persistent workspace ownership, retry and review
reuse, Git/PR delivery evidence, isolated patch validation, and guarded cleanup.
Worker completion, publication, merge and directory cleanup are separate states.
Current checkout mode serializes workers and never removes the person's folder.

Commit, push, PR creation and merge use the existing Git UI or an explicitly
authorized external workflow; they are never inferred from worker prose.
pi.dev remains available for ordinary chats but cannot be a worker until it can
call the structured completion tools.


## Mixed chat and run UI

A main chat can hold ordinary conversation and multiple sequential orchestration
runs. Choose **Execution → Orchestrated** to configure an outcome, project,
main agent, and workspace policy. The main agent selects task workers. Starting a run is explicit;
selecting the mode or opening **Run** does not start workers. **Chat** remains
the place for instructions and native approvals. **Run** shows only the selected
chat's ledger, including pause/stop controls, review, delivery, and cleanup.
An active run prevents switching execution to Normal until it settles or is
stopped; switching between Chat and Run never stops work.

The chat list shows run progress and one current worker conversation per task.
Previous attempts stay searchable and accessible in that task's Run history;
an opened historical attempt remains visible in the list. All worker chats
remain read-only. Normal chats retain their existing checkout/worktree controls.

The browser saves the coordinator's chat index entry before creating a run,
then calls browser-only `orchestration_master_start` with the existing run ID
and selected main-agent settings. This also works for a new chat or after a
server restart. Launch failure retains the run; **Continue main agent** retries
that run after the issue is resolved. This command validates coordinator
ownership and active run state, uses the saved provider session, and serializes
with workspace/stop operations. It is not exposed through worker MCP hooks.

## Background coordination and durable inbox

The master dispatches workers and ends its turn; workers continue independently while the person talks to the master. A master has one active provider turn at a time. Notifications never interrupt that turn or jump ahead of queued user messages. User turns retain FIFO order ahead of queued internal continuations.

Reports, decision gates, resolutions, messages and execution failures create inbox entries atomically with their orchestration state change (store schema v4, migrating v1–v3). Only unsent `progress` updates from the same sender to the same target are coalesced, with a two-second debounce and ten-second maximum delay. A settled report or execution failure supersedes pending progress. Decisions and reports remain separate.

The host retries delivery between turns. A provider-native receipt marks **Received by agent**, not handled or completed. Delivery is at least once: a crash before receipt persistence can repeat a notification; its stable ID and an authoritative snapshot let the master avoid repeating actions. Receipt frames in the transcript recover a missed inbox acknowledgement. Failed delivery uses bounded backoff. Run details expose pending receipts and retry errors.

Orchestrated chat resume settings persist privately without project environment variables; current project environment is reloaded for delivery. Recovery requires a matching indexed provider session, cwd and access. Deleted chats and settled worker attempts cannot be revived by a notification. Stopping a run cancels outstanding delivery. User safety approval remains in the native approval flow.

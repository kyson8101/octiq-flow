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

## Communication

The chat list shows a compact task board below each main agent. Each assignment
appears once, including tasks waiting for dependencies. Retries stay in that
task's expandable details. The board shows completed/total tasks, to-do and
working counts, attention states, and elapsed wall time. Expand a task to inspect
its assignment, reported checklist, branch, full working folder, worktree mode,
and delivery state, or choose **Open activity** to read its worker conversation.

Overall completion is the fraction of tasks recorded as completed by the host.
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
  authoritative attempt.
- **Attempt** — worker chat, provider, access, worktree, branch, report, and
  changed files.
- **Gate** — a blocking decision with optional known choices. Resolving it
  records the answer and resumes the requesting agent.
- **Message** — a durable directed coordinator/worker message. Delivery wakes
  or resumes the target chat when its saved runtime context is available.

Each mutation is persisted before it is announced to browsers. If the saved
file cannot be read, the store refuses to overwrite it.

## Worker lifecycle

1. The master creates tasks and real dependency edges.
2. The host scheduler (or the coordinator in manual mode) starts the entire
   ready wave up to the run's concurrency limit.
3. OctiqFlow reserves an attempt and persists its task workspace before process
   or Git setup begins.
4. Code work creates a linked Git worktree by default and starts a dedicated
   Claude or Codex chat there.
5. The worker must call `orchestration_worker_report` with its exact attempt ID.
   Only that chat and the active attempt may settle the task.
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
- `orchestration_task_create`
- `orchestration_snapshot`
- `orchestration_worker_start`
- `orchestration_worker_report`
- `orchestration_gate_create` / `orchestration_gate_resolve`
- `orchestration_message_send`
- `orchestration_run_stop`

The authenticated local `/hook/orchestration` endpoint injects the calling chat
identity; callers cannot claim another worker's attempt. Browser actions use
the same dispatch commands as the MCP path.

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
main agent, worker provider, and workspace policy. Starting a run is explicit;
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

Reports, decision gates, resolutions and messages create inbox entries atomically with their orchestration state change (store schema v3, migrating v1/v2). Only unsent `progress` updates from the same sender to the same target are coalesced, with a two-second debounce and ten-second maximum delay. A settled report supersedes pending progress. Decisions and reports remain separate.

The host retries delivery between turns. A provider-native receipt marks **Received by agent**, not handled or completed. Delivery is at least once: a crash before receipt persistence can repeat a notification; its stable ID and an authoritative snapshot let the master avoid repeating actions. Receipt frames in the transcript recover a missed inbox acknowledgement. Failed delivery uses bounded backoff. Run details expose pending receipts and retry errors.

Orchestrated chat resume settings persist privately without project environment variables; current project environment is reloaded for delivery. Recovery requires a matching indexed provider session, cwd and access. Deleted chats and settled worker attempts cannot be revived by a notification. Stopping a run cancels outstanding delivery. User safety approval remains in the native approval flow.

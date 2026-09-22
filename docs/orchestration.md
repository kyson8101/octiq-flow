# Master orchestration

OctiqFlow can make an existing chat the master of a supervised multi-agent
run. The master plans a shallow dependency graph, starts the ready tasks, and
coordinates workers. OctiqFlow owns the run state outside every agent
transcript, so a confident sentence from a stale worker cannot complete a task.

Open **Orchestrator** in the top bar, describe the outcome, choose a worker
limit, and start the run. The current chat becomes its master. The panel shows
the task ledger, current attempts, worktree branches, open decisions, and the
latest structured messages.

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
2. It starts the entire ready wave up to the run's concurrency limit.
3. OctiqFlow reserves an attempt before process or Git setup begins.
4. Code work creates a linked Git worktree by default and starts a dedicated
   Claude or Codex chat there.
5. The worker must call `orchestration_worker_report` with its exact attempt ID.
   Only that chat and the active attempt may settle the task.
6. Completed dependencies unlock pending tasks. A reported block can be
   retried; a gate-blocked attempt waits for its decision instead. Retrying
   with `newWorktree: false` reuses the previous attempt's assigned workspace
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

## Current boundary

This release owns orchestration through a reviewable worker worktree and
structured result. Commit, push, PR creation, check monitoring, merge, and safe
worktree cleanup are the next lifecycle layer; they are not inferred from a
worker saying “done.” pi.dev remains available for ordinary chats, but is not a
worker provider until it can call the structured completion tools.

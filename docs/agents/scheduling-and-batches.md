# Scheduling orientation, agent batches and batch cleanup

Moved verbatim from AGENTS.md on 2026-11-24.

## Orchestrated task workspaces

See [the task workspace lifecycle](../subagent-worktree-lifecycle.md) for the
host-owned policy. In agents mode, new runs are **missions** by default: one worktree per
repository shared by the run's tasks one writer at a time, a status board whose
Merged/Released steps come from git only, and a Close/Abandon approved by the
person (`orchestration/mission.rs`). A worker settling, code being pushed, a PR being merged, and
a workspace being eligible for cleanup are separate states. Retry and review
fixes reuse the task's persisted workspace with a new attempt ID. Current
checkout mode never deletes a directory. The plan card may override the run's advice
per task with New worktree or Current checkout; approval fixes that mode, and
writers sharing a checkout take turns (a mission's worktree choice shares its
mission worktree). Non-Git folders offer and advise checkout only in every run
mode; approval without a choice re-plans them as Direct and fixes that mode.
The main chat coordinates while a
worker owns the write lease; it must not also edit that checkout.

### Scheduling orientation and agent batches

Settings → Orientation is independent of registered agent conversations. The
`scheduling.rs` store in the pinned profile holds `scheduling.json`:
`{ "orientation": "tasks", "hostCap": null }` by default. Tasks retains the
existing task-per-worker policy; Agents queues approved, unheld assigned work
in FIFO agent lanes. `hostCap` is Off (`null`) or 1–32 and counts worker process
identities across **all runs**, in either orientation. Each run's
`max_concurrent` counts the same identities within that run. A batch uses one
slot regardless of how many task attempts it claims; its own claim excludes
that batch from both limits. Tasks orientation keeps one process per attempt.
Claiming batches reserve a process slot before spawning, so one scheduler wave
cannot spawn every agent before their claim tools arrive. `live.total` includes
these reservations and deduplicates attempts sharing a worker chat. There is
no per-agent parallel setting.

Every worker process, including ordinary Tasks workers, keeps a runtime lease
after its attempt reports. A closing turn still counts against `hostCap`,
`live.total` and its run's `max_concurrent` until `child.try_wait` confirms exit.
The settled-worker reaper preserves that turn, then releases its process and
lease. Run Stop also ends terminal attempts' closing processes; recording a
terminal outcome alone never returns a process slot. Spawn barriers and exit
checks follow ledger → chat ordering, with all process work outside the ledger.

Only the person's socket exposes `scheduling_get` and
`scheduling_set { settings: { orientation, hostCap } }`; neither has a hook or
MCP route. Set replaces and validates the complete value, saving before
publishing. An unavailable profile refuses in the profile's own words.
`scheduling-changed` carries the get payload after policy or lane changes.
`Task.slotWait` is read-time only (`agent` or `host`, queue position and, for
host capacity, running/limit); it is never accepted or stored in the ledger.
Snapshot and summary retain `batches` and each attempt's `batchId`.

In Agents orientation every start door queues without spawning, answering with
`QUEUED_FOR_SLOT`; the 2-second scheduler alone starts an idle agent's oldest
queued task. Holds (plan, reopen notice, person Stop, supersession, removed
agent) are checked before a lane gets work. The queue retains `StartedBy`:
a person's Start stays theirs, `persons_reopen` stays effective, and only an
actual reservation uses retry budget. A claiming batch records durable worker
identity before any attempt exists. Its fresh worker session sees the full
head task and candidates from the same agent, run, repository and base branch.
Only that worker's own capability may call
`orchestration_batch_claim { taskIds }` through `/hook/orchestration`; the
claim must include the head, contain 1–6 distinct tasks, and passes each task
through the shared reservation gates atomically. Every claim (including the
head) binds the batch agent, runtime settings and workspace plan to the current
approval. A stale head reserves nothing and keeps tasks queued with the host
reason on the lane; an incompatible extra selection can be omitted on retry. Claiming and working batch tasks cannot be reassigned or
handed off until the batch stops or settles. Batch start and each claimed task
reverify the destination's project/repository registration. A queued failure's
read-time `retrying` is true and `failure.awaits` is `coordinator`, including a
person's Start after retries were used; the budget resets only on reservation.
Incompatible approved worker
settings and approved non-Agent workspaces run singly. An unclaimed first turn
causes the host to claim the head alone. Each claimed task reports its own
attempt; the shared process is released only after the last one settles.
Settled or refused batches with no attempts also end their worker process.
Their process slot and agent lane remain held until the child has actually
exited, including the gap after removal from the chat session table. A spawn
barrier keeps a concurrent Stop from releasing a launch still in progress.
Ledger settlement precedes chat locks; process exit is checked outside the
ledger. Every hook capability check first refuses an already settled batch
from ledger state, so revocation does not wait for process reaping. Stopping
a run also stops its pre-claim worker identities, including
ones whose batch was already settled. Stopping one claimed
task stops the shared process and returns its other unfinished tasks to the
queue without using an additional retry; their changes remain in the checkout.
The MCP worker role follows the durable `chat:orch-` key even before a claim or
after a saved resume environment drops its attempt marker.

`WorkspaceMode::Agent` is offered on the plan card and fixed by approval.
New assigned proposals in Agents orientation advise it. Git worktrees live
under the existing managed root as `agent-<stable agent id slug>`, one per
agent/repository; batches take `agent/<slug>/<batch short id>` branches from
the approved base, with a fresh session in the reused checkout. Reopened or
retried tasks return to their original batch branch and may group only with
that original batch's tasks. Before switching, tracked and untracked changes
must be clean; ignored build output is kept, with `--no-overwrite-ignore` on branch switches. A dirty checkout blocks the lane
and durably tells the coordinator whose batch left it. Nothing stashes, resets
or discards changes. The lane can proceed once the checkout is clean again.

Per-task Cleanup and mission Close never remove agent worktrees. While their
agent is registered, lifespan may strip idle build output but cannot remove or
archive the checkout; the physical removal door rechecks registration. Once
removed from the roster, the agent's checkout follows the ordinary merged,
clean, ignored-inventory and `remove_proven` rules. Delivery reads the task's
batch branch even when another batch is checked out. Git refuses deletion of
a batch branch still checked out by any worktree.

Keep roster → ledger lock order. Copy ledger state before Git or chat work;
never read `team.rs` under the ledger, and never take chat locks while holding
it. Scheduling change publication runs after the ledger is released. All Git
operations use the existing cross-platform helpers; no POSIX-only spawn is
introduced. Switching orientation leaves running attempts and batches alone. Starts
already queued retain their provenance; an already fixed Agent allocation
still uses a single-task batch after switching to Tasks. Newly proposed Tasks
allocations keep ordinary task-per-worker dispatch.

**Batch cleanup is a proposal, never removal permission.**
`orchestration_workspace_cleanup_request { runId? | runIds? }` (MCP / hook action
`workspace_cleanup_request`) refreshes delivery and proposes one card containing
eligible retained, completed, merged task worktrees and missions the host calls
`closeEligible`. Without `runIds` it covers every run this chat coordinates and
only that coordinator's capability may ask. `runIds` (1–50 distinct, never
implicit, not with `runId`) lets any of the person's chats name FINISHED runs it
does not coordinate (completed/failed/stopped, no unsettled attempt, open gate or
claiming/working batch; others come back in `keptRuns`), re-checked on the
answer, under the ledger in the step that marks the checkout Cleaning (after the
off-lock proof) and once more right before removal; a gate or worker that begins
after that last read, during Git's own removal, is not stopped. Only who proposes
changes; the per-item guards still run, and the coordinator's own path is unchanged. Either way
`require_user_chat` refuses workers by durable identity even after settlement;
front desks and room seats (`HookCaller.session_key != chat_key`) are refused.
A mission whose folder is gone (confirmed missing: real ancestors, listed parent without the entry; an offline volume, moved ancestor or link on the path keeps it) or never existed closes when nothing is at stake.
Empty batches create no card. Pending records are host memory and are lost on
server restart, never automatically approved. Codex returns pending immediately
and receives results as a durable host notification turn; other providers wait
up to the access-request deadline, then leave the card pending.
Only the person's socket exposes
`orchestration_workspace_cleanup_request_pending` and
`orchestration_workspace_cleanup_request_answer { id, approve }`; no hook maps
to either command. The request itself is chat-only and host bookkeeping
(`permission::HOST_BOOKKEEPING`, including generated Codex tool approvals).
Approval binds the host-held item IDs, full workspace plans and HEAD commits,
then runs the existing task Cleanup and mission Close paths serially, releasing
lifecycle between items. New or changed items are kept with the host's reason;
there is no Abandon, Archive, force removal or relaxed guard. Approve is
save-first: an unavailable profile refuses before any removal; Deny removes
nothing. Per-item outcomes go to the waiting call or durable host inbox, and
normal lifecycle events still update the panel. See the exact card/event
contract in [the lifecycle doc](../subagent-worktree-lifecycle.md#coordinator-batch-cleanup-card).

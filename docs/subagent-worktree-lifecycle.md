# Task workspace lifecycle

OctiqFlow owns workspace preparation and ownership as deterministic backend
operations. Agents plan and implement tasks; they do not choose allocation
paths, infer merge status from prose, or decide when a directory is removable.
The task workspace survives individual worker attempts.

## Choosing a mode

The Orchestrator's **Workspace mode** applies to a run:

| Mode | First attempt | Subsequent attempts |
| --- | --- | --- |
| Auto (default) | Isolated worktree for a writer; current checkout for read-only access | Reuse the persisted workspace |
| New worktree | Isolate every task on its own branch | Reuse the persisted workspace |
| Current checkout | Use the selected folder and its actual branch; one worker at a time | Reuse that folder and branch |

Auto deliberately uses a conservative, reproducible rule instead of asking an
LLM whether a change feels small. A non-Git folder requires Current checkout.
Direct mode warns about primary checkouts and existing changes. It does not
switch branches, reset the index, stash changes, or remove the folder. Existing
Git status is included in the worker brief so the worker can preserve that work.
The run policy takes precedence over the legacy `newWorktree` argument.
`newWorktree:false` cannot turn a first Auto writing task into Direct mode;
choose Current checkout on the run explicitly.

The product uses Git directly; it does not depend on a person's installed `wt`
script. Local development of OctiqFlow still follows the repository's `wt`
workflow and branch confirmation rules.

## State and ownership

```text
Task ready -> attempt reserved -> workspace plan persisted -> Git provisioned
           -> lease assigned -> worker running
                | approval/decision -> same attempt
                | blocked/failed -> explicit retry, new attempt, same workspace
                | completed -> retained workspace -> commit/push/review
                                                  -> review fixes, new attempt
                                                  -> verified merge -> cleanup
                                                  -> explicit abandon -> cleanup
```

`Task.workspace` contains the concrete mode, canonical checkout identity, cwd,
branch, repository root, base branch/SHA, creation ownership, original Git status,
lease attempt ID, validation paths, cleanup intent, and last delivery evidence.
The run store persists this atomically as schema version 3. Versions 1 and 2 migrate
on load; an older backend refuses version 3 instead of dropping workspace ownership. Old records without a workspace
remain readable; retry can adopt their old cwd/branch, but adoption never grants
permission to delete a directory the new workflow did not create.

- A task ID determines a stable `feature/octiq-<task-id>` branch and a path in
  `.worktrees/<repo>/feature/`. Provisioning the same saved plan does not allocate
  another branch, and automatic upstream tracking is disabled.
- One managed writer can lease a canonical checkout at a time, across runs.
  Subdirectories and symlink aliases do not create separate writer identities.
  Ordinary managed chat starts, sends, access changes and Git-panel mutations
  also check leases.
  Read-only workers may share a checkout; cleanup requires all readers to leave.
- The main chat remains available for coordination and must not edit a checkout
  delegated to its worker. These controls cover OctiqFlow's managed chat/worker
  processes, not arbitrary external terminals or other Git tools. OS sandbox and
  tool approval controls remain in force.
- A settled worker is stopped before its checkout is handed to a replacement.
  Messages to settled or stale attempts are rejected. A pending safety card
  retains the same attempt and is not another settled block.
- A restart fails interrupted attempts and releases their process leases while
  retaining the workspace and changes. Task decision gates belonging to those
  interrupted attempts are cancelled. Retrying requires a new attempt ID.
- Provisioning is recorded before filesystem side effects. Cleanup also records
  verified intent before removal so a restart can reconcile it. Drift in the
  assigned branch or repository fails closed; it never silently switches back.

## Automatic dispatch

**Automatically start ready tasks** opts into a host scheduler. The main agent
chooses a provider, model, access, and reasoning effort for each task in its
`worker` settings. Fable and Astra are reserved for main orchestrators and
rejected for execution workers, including retries. It runs every two seconds,
starts the ready wave up to the concurrency limit, and advances dependencies
from authoritative reports. Task creation can come from the master agent, a
static workflow, or authenticated API calls. No LLM turn is needed to allocate
a worktree or start the next ready wave.

The scheduler does not retry failed or reported-blocked tasks, auto-answer
approval gates, publish code, or merge PRs. A run-level decision pauses new
starts. A task gate retains its worker slot while independent tasks may proceed.
Dependencies order execution; they do not copy uncommitted changes between
branches. Make integration an explicit task with the required commit inputs, or
use a manually launched dependent worker with an explicit local `baseBranch`.

Pausing automatic dispatch leaves running attempts alone. Restart retains the
configuration, while interrupted attempts still require an explicit retry.

## Delivery and review

Execution completion and code delivery are separate facts. **Refresh delivery
status** checks the actual HEAD, dirty files, base SHA, upstream branch and its
live remote tip. It queries `gh pr view` when available for a matching PR head
and base; a merge of an older head is not permission to delete newer work.
A matching merged PR supports squash/rebase merges and deleted remote branches.
Without PR evidence, cleanup requires exact ancestry into the verified remote
base tip, which must be available locally. Fetch the base if that object is not
available. Offline or unverifiable results do not count as a passed merge gate.

Commit and push using the existing Git panel or an authorized Git workflow.
PR creation, review and merge remain explicit external actions. This feature
records their observed result and does not publish messages or changes itself.

**Continue after review** reopens a completed task with new instructions and
keeps its workspace. The next worker is a new attempt. Already-started dependent
tasks, a recorded merge, abandonment, or cleanup prevent reopening; create a
separate follow-up task in those cases. Unstarted dependants wait for the
reopened prerequisite to finish again.

## Cleanup

**Archive worker** hides a worker chat from the active sidebar after its task
completes and Refresh delivery status records a clean, verified merge. Open
decisions and workers still executing prevent archiving. A completed run also
offers **Archive all merged workers**, which skips tasks without that evidence.
Archive status persists with each attempt. **Archived workers** in the chat list
menu lets the person view or restore them; the execution ledger also retains
their chat links, reports, and restore actions. Restoring changes visibility
only, and does not resume a settled worker. Archiving never deletes transcripts,
branches, or workspaces and has no automatic expiry.

Cleanup is a separate person-facing confirmation in the Orchestrator. Persistent
task-worktree removal is not exposed through the chat-bound MCP hook. Its
backend command requires the HEAD from the preview and checks everything again:

1. OctiqFlow created this worktree, and it is still the recorded repository and
   branch. Direct and adopted workspaces are never eligible.
2. No active attempt, task gate, managed chat, or validation checkout still uses
   it. A retained failed/blocked task must be explicitly abandoned.
3. Git reports no uncommitted or untracked changes, and HEAD still matches.
4. That exact head/base has a verified merge, or the person explicitly abandons
   the task. Abandonment still requires publishing any new commits first.

Git removes the directory without `--force`. Local and remote branches are
retained, including for abandonment; no unmerged branch is force-deleted.
Unstarted dependants of an abandoned task are cancelled with an explanation.
The attempt/report history remains visible after cleanup.

## Isolated patch validation

`orchestration_validation_create` takes a task ID, exact `baseSha`, and optional
ordered commit SHAs. It creates a detached temporary checkout and cherry-picks
only those commits there. To test CER-01 independently of inherited CER-02, use
CER-01's intended base and CER-01's commits. The task source tree and index are
untouched. This supports committed patches; preserve or commit an uncommitted
patch before selecting it for validation.

The allocation is recorded before Git runs. A failed cherry-pick leaves its
checkout available for inspection. `orchestration_validation_remove` accepts
only a recorded path for that task and removes it without force; dirty results
or conflicts must be resolved/preserved first. The UI also lists these paths.
An active worker can manage only its own validation checkouts; the coordinator
can manage them after the worker settles.

## API surface

The authenticated browser dispatch and chat-bound MCP share these operations:

- `orchestration_run_create`: optional `workspaceMode`, `workerDefaults`.
- `orchestration_task_create`: record the main agent's per-task `worker` selection.
- `orchestration_automation_configure`: use `{access: "auto"}` to dispatch the
  selected workers, or `null` to pause. Existing run-wide defaults remain a
  fallback for tasks without their own selection.
- `orchestration_dispatch_ready`: run the configured ready wave immediately.
- `orchestration_worker_start`: reserve a new attempt and reuse/provision its
  task workspace. Duplicate active starts are rejected without allocating more.
- `orchestration_workspace_refresh`: update delivery evidence.
- `orchestration_task_reopen`: retain the workspace for review fixes.
- `orchestration_validation_create` / `orchestration_validation_remove`.

`orchestration_workspace_cleanup` is a browser/user API command only. It takes
`taskId`, `expectedHead`, and optional `abandon`; it is intentionally absent from
MCP tool discovery and the local orchestration hook's action allowlist.

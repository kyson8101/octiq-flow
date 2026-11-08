# Task workspace lifecycle

OctiqFlow owns workspace preparation and ownership as deterministic backend
operations. Agents plan and implement tasks; they do not choose allocation
paths, infer merge status from prose, or decide when a directory is removable.
The task workspace survives individual worker attempts.

## Choosing a mode

The Orchestrator's **Workspace mode** applies to a run:

| Mode | First attempt | Subsequent attempts |
| --- | --- | --- |
| Mission (default in agents mode) | The mission's one worktree per repository, `feature/mission-<run>`, shared by its tasks | The same worktree, for every later task too |
| Auto (default otherwise) | Isolated worktree for a writer; current checkout for read-only access | Reuse the persisted workspace |
| New worktree | Isolate every task on its own branch | Reuse the persisted workspace |
| Current checkout | Use the selected folder and its actual branch; one worker at a time | Reuse that folder and branch |

Auto deliberately uses a conservative, reproducible rule instead of asking an
LLM whether a change feels small. A non-Git folder requires Current checkout.
Direct mode warns about primary checkouts and existing changes. It does not
switch branches, reset the index, stash changes, or remove the folder. Existing
Git status is included in the worker brief so the worker can preserve that work.
The plan card may override this advice per task with New worktree or Current
checkout (`orchestration_plan_approve.workspaceChoices`, keyed by task ID);
approval fixes the mode, retries reuse it, and writers sharing a checkout take
turns. In missions, worktree means the shared mission worktree and checkout
means the task's root/destination. Non-Git folders offer and advise checkout only
in every run mode; approval without a choice re-plans them as Direct and fixes
that mode, even in an explicit New worktree run.
The legacy `newWorktree` argument cannot change an approved mode or location,
through any start door. `false` or omission reuses a saved workspace; with none
saved, either flag allocates the approved plan. `true` prepares that same
deterministic path and branch, preserving retained work. Tasks without an
approved mode keep the legacy run policy.

The browser-only approval command accepts optional
`workspaceChoices: { [taskId]: "worktree" | "checkout" }` alongside `runId`,
`actorChatKey`, `taskIds`, `revision` and the existing card view fields. Missing
entries keep the run's advice. Unknown/out-of-revision, approved/started tasks,
and worktree choices for non-Git folders refuse the whole approval. No hook
or MCP tool can supply this field, including conversation-based consent.

For runs with a plan, the snapshot derives `task.workspaceChoice: { advised, chosen?, options,
onlyCheckoutBecause? }`; modes use `"worktree" | "checkout"`, `options` lists
the available modes and `onlyCheckoutBecause` explains a non-Git folder.
`chosen` appears after approval. This field is never stored or read back;
`task.approved.workspaceMode` stores the workflow mode (`direct`, `worktree`,
or `mission`) that every start must obey.

The product uses Git directly; it does not depend on a person's installed `wt`
script. Local development of OctiqFlow still follows the repository's `wt`
workflow and branch confirmation rules.

## Missions

In agents mode, a run created without a workspace mode is a **mission**
(`orchestration/mission.rs`); elsewhere the default stays Auto, and Mission
can still be chosen explicitly.
It differs from the per-task modes in three ways:

- **One worktree per repository.** Every task plans `feature/mission-<run-id>`
  at `.worktrees/<repo>/feature/mission-<run-id>`; the first launch creates it
  and later tasks find it already there (a branch owned by that path is not a
  conflict). A follow-up after a merge lands on the same branch while the
  worktree exists. A folder with no Git history works in place.
- **One writer at a time.** The scheduler starts at most one writing task per
  mission repository and holds the next until it settles; a manual start is
  refused before an attempt exists, so the task stays ready instead of failing.
  Readers share the worktree freely. Per-task cleanup is refused: the
  worktree belongs to the mission.
- **Open until closed.** The status board (Draft → Approved → In progress →
  In review → Ready to merge → Merged → Released → Closed) is drawn from the
  tasks for the first half and from git for the second.
  `orchestration_mission_refresh` (person or lead) records, per repository,
  whether the head is merged — a matching merged PR, or already an ancestor of
  the base branch's remote tip, which covers a lead who fast-forwards the base
  and pushes it — and, once merged, the project's release check
  (`chat_task::release_status`).

`orchestration_mission_close` is socket-only, like task cleanup: absent
from MCP discovery and the hook allowlist. A coordinator may also propose a
batch through `orchestration_workspace_cleanup_request`; only the person's
approval card reaches the same Close path. It requires every worker settled
and no open decision, then per mission worktree:

| Ending | Requires | Removes |
| --- | --- | --- |
| Close | every task finished, a clean tree, the merge verified | the worktree (no `--force`), then the local branch with `git branch -d`, which Git refuses if anything is unmerged |
| Abandon | a clean tree; any unmerged commits pushed | the worktree; the branch is kept and open tasks are cancelled |

The remote branch is never touched. The run becomes `closed` (with
`abandoned` for the second ending), refuses new tasks, and keeps its record.
A run that still has Worktree-mode task worktrees must clean those up first.

### The mission page

A mission's run column (`web/src/components/MissionPage.tsx`) puts the board,
then **Goal** (the objective and every live task's plan-card acceptance),
**Crew** (lead first, then each task owner with the role held in this mission:
developer for a work task, reviewer for a check, review or acceptance task) and
**Where** (per repository: base branch, mission branch, worktree, and git's
last word from `orchestration_mission_refresh`) above its tasks. All of it is
derived from the ledger the page already reads (`web/src/lib/missionPage.ts`);
nothing new is persisted, so missions from before the page draw the same.

A task row's reassign control is the lead's own `orchestration_task_reassign`,
sent by the page with the run's coordinator as actor. Candidates come from
`orchestration_destinations` asked as that lead (its direct reports allowed at
the task's destination, crew first), the reason records that the person asked,
and the host keeps the handoff, re-opens plan approval and refuses any start
until the person approves the new owner. A retry after a handoff launches the
new owner's worker settings, never the replaced attempt's. The page's Start
retry (the socket's `orchestration_worker_start`) names the attempt it shows
as `retryOf`; on a task that changed hands, the host refuses a retry naming
none, and one naming an attempt from before the handoff once the new owner has
had any attempt of their own, whatever became of it. Until then the first
start keeps to the approved settings. The coordinator's explicit start reaches
the host only through its hook (`orchestration_worker_start_in_chat`, which
the socket refuses). On a task the person approved it chooses nothing: every
start, the coordinator's, the host's and the page's, is refused unless it asks
for the worker, assignee, destination and base branch the approval fixed
([What an approval fixes](agents-mode.md#what-an-approval-fixes)). On a task
nobody approved, in a run with no plan, the settings are still the
coordinator's choice. Runs that are not missions keep the plain run panel.

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
  Messages to settled or stale attempts are rejected. A pending Codex safety
  card retains the same attempt and is not another settled block. A Claude
  auto-mode card cannot be approved, so it retains nothing.
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
keeps its workspace. The next worker is a new attempt. An approved task keeps
its approval and starts only as what was approved; the reopen is recorded on
the task and shown in the coordinator's chat (`octiq_task_reopened`), and the
person can stop that one task (`orchestration_task_stop`). Already-started dependent
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

The explicit per-task cleanup remains a separate person-facing confirmation in the Orchestrator. The host lifespan below is an additional automatic path, superseding person-facing-only removal statements for that path. Persistent
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
Validation removal also requires a complete ignored-file inventory with no
at-stake files (the same allow-list as the host lifespan below). Non-force Git
removal alone does not protect ignored files.

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

## Coordinator batch cleanup card

MCP `orchestration_workspace_cleanup_request { runId? }` maps only to the
`workspace_cleanup_request` hook action. The capability's own chat must be the
`coordinatorChatKey` of every concerned run. No `runId` means all runs that chat
coordinates, including finished runs with retained task worktrees. Workers are
refused by durable identity (`require_user_chat` / `is_worker_chat`, including
after settlement), as are front desks, room seats and unrelated chats. Keeping
the `HookCaller` through the room-seat check is mandatory.

The host refreshes task delivery through `refresh_workspace` (for an already
swept folder, the exact kept HEAD is reverified against the current local base,
just as Cleanup does, without recreating it) and mission
delivery through `refresh_mission`, then selects completed retained managed task
worktrees with verified merge, clean status and the existing Cleanup readiness
checks and read-only Restore preflight, plus missions whose host-derived
`closeEligible` is true. Unknown or nonzero at-stake ignored-file inventories
keep an existing task folder out of the batch. A mission retains the host's
existing `closeEligible` definition: its actual Close still runs every removal
proof and may keep it with a reason. Swept folders can show `null` because they
no longer have an inventory.
No Abandon, Archive or unmerged work is proposed. No eligible items means
`{status:"empty",text}` and no card. One outstanding batch per coordinator:
a repeated request returns that card unchanged.

The host holds pending records in memory. Reconnect reads them; a server restart
forgets consent, never executes it. The request computes a proposal only; it
never stops workers or removes folders. The authenticated browser uses:

- `orchestration_workspace_cleanup_request_pending {}` → `Asked[]` (all pending
  cards, including `processing:true` while the host handles one).
- `orchestration_workspace_cleanup_request_answer {id,approve:boolean}` →
  `Settled`; these two commands are socket-only. There is no answer hook/MCP.
- Bus event `orchestration-workspace-cleanup-request`:
  `{state:"appeared",id,request:Asked}` or
  `{state:"settled",id,chatKey,result:Settled}`. A settled event removes the card.
  Usual workspace/mission events still refresh the run panel.

```ts
type Asked = {
  id: string; chatKey: string; runIds: string[]; processing: boolean;
  items: {
    id: string; kind: "task-worktree" | "mission"; runId: string;
    taskId?: string; title: string;
    worktrees: {
      branch: string; path: string; headCommit: string; baseBranch: string;
      ignoredFileCount: number | null;
    }[];
  }[];
};
type Settled = {
  id: string; approved: boolean;
  items: {id: string; status: "removed" | "kept"; reason: string}[];
};
```

Render one card listing **every item and every worktree**: task/mission title,
branch, path, merged HEAD and base branch, ignored-file count (`null` means
unknown, never zero). A mission is one Close item containing all repository
roots; an empty mission has `worktrees:[]` and closes only its record. Approve
and Deny answer the whole batch; disable actions while `processing` and never
send item IDs, paths or HEADs back as authority. Duplicate/stale answers fail
without executing twice. No per-item selection or automatic approval.

Approve binds the exact host-held item IDs, complete allocation plans and HEADs;
no newly eligible task, mission or repository root can join the approved batch.
The original `cleanup_workspace` → `cleanup_verified` → `remove_proven`, and
`close_mission` paths retain all guards (including raw Restore proof, ignored
inventory, path/start holds, profile, allocation, activity and merge checks).
Mission membership and HEADs are checked before and after off-lock proof, and
HEAD is checked again for each root. Changed items are kept with a reason.
Like ordinary mission Close, an external filesystem race or late failure can
leave an earlier mission root already removed; `kept` means the full item did
not complete, and the reason reports the partial removal count. If all folders
were removed before an error, status is `removed` and the reason preserves the
host's error. The ledger's per-root delivery remains authoritative.
Lifecycle is released between items. Approve is save-first and refuses with the
profile's words if unavailable; Deny removes nothing, even if saves fail.

Codex and providers that cannot wait between turns return
`{status:"pending",request:Asked,text}` immediately, before the MCP deadline;
other providers wait up to `access_request::wait_for` and may return
`{status:"settled",result:Settled}`. A wait timeout leaves the card pending.
If preparation itself exceeds 40 seconds, the call returns
`{status:"preparing",text}` while the host finishes the read-only checks; a
notification says when the card is actually up, or why no card was created.
When no call takes the result, the host enqueues one durable notification
(`kind:"workspace_cleanup"`, source `cleanup-result:<card-id>`) with all per-item
outcomes to the requesting coordinator, including when its run was stopped.
This host decision receipt never restarts stopped tasks. A save failure after removal keeps that
outcome in RAM and owes its notification save, never retries deletion. The
request is host bookkeeping; the person's card is the sole approval gate.

## Host-owned worktree lifespan

The host automatically strips safe build output after **3 idle days** and removes
**Finished** folders after **14 idle days**, reporting changes afterwards. These
thresholds and the enabled switch are adjustable in the authenticated browser.
Pinning prevents both actions. Close, Abandon and explicit per-task cleanup keep
their existing guards; the coordinator's batch card also needs the person's
approval, and never includes Abandon. A sweep never closes or abandons a run.
Agent history (`~/.codex`, `~/.claude`) and the session folders named after a
worktree are outside this feature.

Each scan derives Active, Idle, Finished or Abandoned. A process, lease,
unsettled attempt, open gate, queued turn, observed cwd/open file, or unfinished
owning run task holds the checkout Active. Last activity is the newest host-known
task/attempt timestamp, chat index update, last commit and non-build tree mtime.
Before the removal threshold it is Idle. After it, a clean checkout with no Git
operation and a named, kept branch is Finished; no merge or push is required
when the local branch still holds its commits. Dirty/untracked files, an
unfinished Git operation, or detached commits with no retaining ref make it
Abandoned. At-stake ignored files also make an inactive item Abandoned, with
their count in its reason; an unavailable inventory makes it Abandoned with
the failure reason. Neither can be Finished or removed automatically, even
when ordinary Git status is clean. Abandoned is never removed automatically. A recorded detached
validation checkout may qualify once its run has ended and refs retain HEAD.

Ownership comes from managed task/mission plans, chat index cwd plus an
`octiq/` branch under `.worktrees`, and recorded validation allocations.
Primary, adopted, direct and hand-made worktrees are listed as Unknown and never
changed. Repositories come from registered projects and ledger allocations.
The one thread starts three minutes after host startup and scans hourly; tests
never start it. Disabled settings or an unavailable pinned profile withhold a
pass. A cargo/rustc process withholds cleanup. No timer belongs to a worktree.

Build stripping is an allow-list: only ignored, untracked `target` beside
`Cargo.toml`, and `node_modules` beside `package.json`. Neither the tree walk nor
deletion follows symlinks/junctions. `source`, `dist`, `out` and `renders` do not
qualify, even when ignored. Cwd/open-file inventory must be known before build output or a
worktree can be removed: missing, failed, timed-out or empty `lsof`, and all
Windows hosts today, keep the folder. Windows reparse points inside a checkout
also withhold Git removal because Git may traverse a junction.

**A clean status says nothing about ignored files:** even non-force
`git worktree remove` deletes them. Starfall intentionally ignores original
media and renders under `works/` and `anime/`, where they may be the only copy.
Each worktree, including validation checkouts, gets a `git status --ignored=matching`
inventory bounded to 15 seconds, 32 MiB of Git output and 100,000 inspected
entries. Metadata is read without following symlinks/junctions; redirected
entries outside a real qualified build folder are at stake; links inside
`target`/`node_modules` are rebuildable links and their targets are never followed.
A build root that is itself a link does not qualify. Only these ignored files are rebuildable:

- Files in `target` beside a regular `Cargo.toml`.
- Files in `node_modules`, `dist` or `.astro` beside a regular `package.json`.
- `*.tsbuildinfo` beside a regular `package.json`.
- `pnpm-workspace.yaml` beside a tracked-or-present `package.json`, only when it
  is at most 4 KiB, valid UTF-8, and its non-empty lines are exactly one
  `allowBuilds:` first followed only by two-space-indented `<name>: true|false|set this to true or false`
  lines. Comments, other keys, invalid encoding and unread files are at stake.
- `.DS_Store` and `*.log`.

Any file under a `source/`, `works/` or `anime/` tree is at stake, overriding
every rule above, even `works/.../dist` or a `.log` there. Everything else is
at stake too. These classifications do not broaden build stripping, which
still only touches its own `target`/`node_modules` allow-list. Any entry named
`.git` (file/directory, ASCII case-insensitive), or a bare-repository-shaped
directory (`HEAD` file, `objects/`, `refs/`), is at stake and is not descended
into. Stripping uses the same inventory predicate on the complete build subtree;
any at-stake entry, incomplete walk or bound means no strip. An Abandoned item
may still have a proven safe build subtree stripped.

The host takes the workspace lifecycle lock, marks the path under the chat
session table, obtains associated start claims, then rechecks idleness. A start
that was already admitted prevents cleanup; one arriving afterwards sees the
mark, including a new chat id. No process is stopped or killed for cleanup.
Git reads have 15-second bounds and do not fetch. Chat delivery verification
records `Delivery.head` before removal; ledger delivery evidence is refreshed,
then an intent is synced to the lifespan record before Git removes the folder
without `--force`. Both local and remote branches remain.
Immediately before removal, under the same lifecycle/path/start marks, a fresh
ignored inventory must still be complete and empty of at-stake files. A file
arriving after the scan prevents removal. Explicit validation removal uses the
same inventory protection and refuses any Windows reparse point even when the
link itself is rebuildable; Git for Windows can otherwise descend into a
junction. Task/mission rebuild behavior is unchanged.

A successful removal sets optional `sweptAt` on task workspaces and mission
deliveries, preserving their old state and `removed` flag for older binaries.
Disk inventory and lease admission no longer treat a swept root as held.
Missing retained/ready folders are reconciled only when both the repository and
its original `.worktrees/<repo>` parent are present; a missing volume changes
nothing, and no sweep runs global `git worktree prune`. Saved intents are
reconciled after restart; an existing folder is always re-inspected. A new
attempt restores a swept checkout at the same path from the kept branch through
`git_ops::restore_worktree`; merged and abandoned task refusals remain. A later
mission task recreates its shared worktree. Ordinary chats keep the existing
`chat_recover` order and remembered delivery path.

**Archive then remove** requires an Abandoned host-owned item and the exact
preview HEAD and status hash. Changed files or HEAD refuse the stale preview.
The hash also covers at-stake ignored paths, types, sizes, precise mtimes and
available change metadata (plus symlink targets), without reading large media.
Changes to that inventory invalidate the preview too. An incomplete/failed or
timed-out ignored inventory refuses archive in words.
A temporary `GIT_INDEX_FILE` is loaded from HEAD, then `add -A`, `write-tree`,
`commit-tree` (HEAD as parent) and `update-ref refs/octiq/archive/<slug>` preserve
the tracked/untracked tree. The real index and branch do not move, and no hooks
run. **Ignored files are not archived.** The person's confirmation must show
the at-stake ignored-file count and state that archive-and-remove **deletes
those files without putting them in the archive ref**; restoring the archive
cannot recover them. After verifying the ref's tree and
saving its record, the host makes the last disk-content comparison using a new
index loaded from the archive tree: `diff --exit-code` with ext diff/textconv
disabled plus `ls-files --others --exclude-standard`. A fresh index has no stat
cache to vouch for different bytes. `status` alone would also compare to the
original HEAD, which intentionally differs for dirty archives. Any difference
or failure keeps both archive and folder. There remains an external-write race
after this final comparison and before/during force removal; host path/start
marks do not prevent arbitrary filesystem writes. A failed
archive removes nothing. Submodules and embedded Git repositories are refused
because a gitlink does not preserve their working files or objects. Restore makes a new branch `octiq/restored-<slug>` and
worktree under `.worktrees/<repo>/octiq/` at the archive commit, without replacing
an existing folder. The archive ref remains available.

Socket-only commands (no hook route or MCP tool):

- `worktree_lifespan_list {}` returns settings, `lastSweepAt`, `scanning`, cached
  items, archives and the last 50 sweeps. Sizes are logical bytes, nullable when
  unknown, and cached between sweeps. States are never persisted.
  Each Item includes `ignoredFiles: number|null` and `ignoredBytes: number|null`,
  counting **only at-stake ignored files**. Both are null if the inventory
  failed, timed out, reached its entry/output limit or could not finish.
- `worktree_lifespan_set { enabled?, buildAfterDays?, removeAfterDays? }` requires
  days at least 1 and build cleanup no later than folder removal. Enabling needs
  a saved record; disabling acts at once and owes a failed write.
- `worktree_lifespan_keep { key, keep }` pins/unpins. Pinning acts at once;
  unpinning needs a saved record.
- `worktree_lifespan_archive { key, expectedHead, expectedStatusHash }` returns
  the verified Archive; ignored files are excluded.
- `worktree_lifespan_restore { key }` returns `{ path, branch }`.

All timestamps are Unix milliseconds. `unmergedCommits` counts HEAD commits
outside the base branch; `pushed` independently says whether its known remote
branch contains HEAD, or `null` when unknown. No fetch or unpushed count is used.
`worktree-swept` carries a Sweep only after changes;
`worktree-lifespan-changed {}` refreshes the page. Settings, pins, archives,
intents and history live in `<profile dir>/worktree-lifespan.json`, read through
`profile::read` and written through `profile::make_dir`. Unsaved narrowing joins
the host's owed-save retry and never claims to be saved.

Heavy usage capture, tree walks and content hashes run outside the global
workspace lifecycle lock while checkout/start marks prevent host starts. The
host reacquires lifecycle for each final operation and rechecks allocations and
activity; it releases it between items. Content hashing is bounded to 2 GiB
total/120 seconds, sizing to 100,000 entries/15 seconds. Final under-lock ignored
checks use 100,000 entries/10 seconds including Git status; the normal inventory
remains 100,000 entries/15 seconds. A limit holds that item in words and lets
other workspaces continue. Git metadata output is capped at 32 MiB per command and Git
removal at 15 seconds; archive commands/comparison have 120-second bounds outside
lifecycle; OS filesystem operations may still block.

After long checks, `profile::available` is asked immediately before removing.
If a completed removal cannot be saved, its outcome stays in RAM as `unsaved`
and appears in `profile_status.owed`; the removed path leaves the inventory
cache. `dispatch::settle_owed` records it and emits `worktree-swept` as soon as
the profile returns, without waiting for the hourly scan. Per-task Cleanup on
a swept folder uses its unchanged kept branch and saved delivery evidence,
and re-verifies ancestry against the current base,
without a worker or rebuild; missing/stale evidence returns an actionable
sentence naming the swept workspace and requiring restore/refresh.


Git's clean or equal is not proof that the raw bytes can be restored. Removal
requires each byte to be rebuildable by the shared predicate or restorable byte
for byte from a retained ref. The host checks `ls-files -v` hidden index bits
(assume-unchanged lowercase and skip-worktree `S`): edited existing files make
an inactive worktree Abandoned with a count; absent sparse files are allowed.
Status explicitly overrides `status.showUntrackedFiles`, `core.fsmonitor`,
`core.untrackedCache`, and submodule hiding with `--ignore-submodules=none`.


### Removal paths and their guards

Only a confirmed **Archive** may remove a folder whose live bytes differ from
Restore. **Abandon is not a discard exception**: both task Abandon and mission
Abandon keep the folder and explain any failed proof. Their clean/published
promises include raw contents, effective types and at-stake ignored files.

All non-Archive physical removals enter `worktree_lifespan::remove_proven`.
They prepare a full-path `RemovalProof` outside workspace lifecycle and recheck
HEAD, no-follow checkout/common-repository identity, non-empty/unknown
`config.worktree`, at-stake ignored inventory, profile availability and final
file stamps within the same remaining 10-second budget. Stamps are checked after
inventory; unknowns and changed evidence keep the folder. Callers hold lifecycle,
checkout path marks and start claims, and recheck ownership, unsettled workers,
active/queued chats and their operation-specific delivery gates before removal.
Mission Close/Abandon first mark every checkout, then claim the union of chat
keys once: one stopped chat may span repositories through cwd and extraDirs.
The complete set stays held across every off-lock proof and final removal,
and drops on every exit. A live, starting or queued chat still keeps the folders.

| Path | Guard before physical removal |
| --- | --- |
| Automatic ordinary chat / task / mission / validation lifespan | `operate_progress` verifies policy, pins, idle/activity, known usage and ownership, then the shared `remove_proven` door |
| Per-task Cleanup | `cleanup_workspace` rechecks coordinator, task/workspace identity, leases, gates, other owners and merge/expected HEAD; `cleanup_verified` enters the shared door |
| Per-task Abandon | Same task guards and shared door; unpublished commits keep the folder; no discard bypass |
| Mission Close | `close_mission` rechecks the complete mission plan set, workers, gates and merge; each `cleanup_verified` enters the shared door |
| Mission Abandon | Same mission guards and shared door, with the existing published-commit gate; no discard bypass |
| Explicit validation removal | `remove_validation` rechecks allocation ownership and activity; `remove_validation_verified` requires detached HEAD, then enters the shared door |
| Confirmed Archive then remove | Its own lifecycle/path/start/usage/pin guards, exact preview hash including ignored inventory, verified archive ref/tree and full captured-tree disk/type proof, config guard and final stamps; only this path calls force removal |
| Disk report downloaded cleanup script | Prints and skips each worktree: an offline script cannot hold the host guards; use host Cleanup/lifespan or confirmed Archive |

Build stripping removes only individually proven rebuildable subtrees, never the
worktree root. Reconciliation records already absent folders without deleting
anything. Restore/recovery prepares an absent folder and may prune stale Git
administrative registrations; it never removes an existing worktree folder.
Other `worktree remove` / whole-worktree `remove_dir_all` occurrences in Rust
are disposable `cfg(test)` fixtures, not product cleanup paths.

Mode `120000` restores as a symlink only when effective `core.symlinks=true`;
otherwise it restores as a non-executable regular file containing the link text.
An existing symlink under `false` is a type mismatch even when its target bytes
match. Leading-whitespace filter paths use bounded single-object
`cat-file --filters --path=<path> <ref>:<path>` with exact argv and EOF framing,
under the same aggregate 2 GiB / 120-second proof budget. Normal paths retain
the streaming batch. Every bounded Git command, including status/ignored clean
filters, raw batches and single-object calls, owns a Unix process group or a
Windows Job Object from spawn; every exit path kills remaining descendants.

Every removal other than a confirmed Archive proves **every tracked path**
against the kept ref's tree; attributes, autocrlf and hidden bits never select
which paths get compared. For regular files compare raw disk bytes with what
`cat-file --filters` would write, covering ident and all other conversions.
`--attr-source` / `GIT_ATTR_SOURCE` binds attributes to the kept ref, including when a sparse
attributes file is absent on disk. Git below 2.41 or an unparseable version is
kept with an explanation, and the recognized `--attr-source` option prevents a
silently ignored environment variable from being treated as proof.
`$GIT_DIR/info/attributes` and `core.attributesFile` still apply as they would
on Restore in this repository; later changes to them can change Restore bytes.
A non-empty `config.worktree` is kept without interpreting its keys: Git removes
that admin file and Restore does not recreate its settings, so the restoration
environment was not proven. This applies to every removal, including confirmed Archive. An unreadable, redirected or unexpected config file also keeps
the folder; empty or absent proceeds. Its presence and metadata are included
in pre/post proof stamps, including a file created during the comparison.
This conservatively holds sparse-only worktree configuration too; missing
sparse tree entries themselves remain allowed.
Mode-120000 entries use the raw blob, including regular-file checkouts under
`core.symlinks=false`. Compare effective type and, on Unix, executable bit
against the tree mode regardless of `core.filemode`; Windows has no executable
bit. Any present gitlink, extra index entry or unmerged stage keeps the folder.
A missing sparse entry has no bytes to lose. Archive keeps its existing full
captured-tree check and also verifies effective mode. Reversible CRLF and an
untouched expanded ident remain removable; unknown/unreadable/filter failures
keep the folder and explain why.

The full proof runs **only at removal**, outside lifecycle, bounded to **2 GiB**
total disk/Restore bytes and **120 seconds**. It streams and hashes, with one
`cat-file --batch --filters -z` process and a separate raw batch only for
symlinks. Batch headers report the original blob size even after conversion:
read exactly the disk length, then require the framing LF and a random nonce's
missing-object response at that exact offset. Never scan for a later marker;
first mismatch stops/kills the batch and names the path (at least 1 file).
Input is one file request/response at a time; spaces/newlines use NUL input,
while leading-whitespace filter paths use an exact single-object call. Oversized or
hung filters cannot grow a whole-output buffer: a deadline kills the child
and descendants (Unix process group; Windows suspended launch into a Job
Object before resume). Metadata output retains its 32 MiB cap. The proof runs the repository's
configured filters. Its buffer bound covers the host only: Git and a configured
filter's own memory use are not bounded by the proof; the deadline and process
containment apply to them.

Observe retains a cheap hidden-entry-only check, so hidden edits still appear
Abandoned with a count. A removal mismatch also appears Abandoned with its
path/reason. Failed full proofs are remembered in RAM by HEAD plus the complete
file stamp inventory; unchanged failures are not re-proven each hourly sweep.
Changed HEAD/stamps invalidate that outcome. A bound is a kept reason, never
Abandoned merely for exceeding a bound.

Before long comparisons the host captures tracked/untracked paths and their
size, mtime and ctime (real ChangeTime on Windows). Afterward it refreshes
usage and reacquires lifecycle, then asks again about settings, pins, profile,
allocation/activity, HEAD, ignored inventory versus preview, and file stamps.
No long comparison or dropped lock follows these final checks. Every Git call under lifecycle, including HEAD and stamp inventories, takes
only the remaining shared 10-second final-stage budget. Non-force Git removal
retains its separate 15-second bound. An arbitrary external
writer can still race the final checks/removal; host starts are blocked.

Strip preflights all build candidates before deleting any. Each deletion then
rechecks qualification, usage and the shared ignored predicate under lifecycle.
Successful strip counts/bytes survive a later refusal in the same worktree,
reach history and the event beside that refusal, and reduce cached sizes.

The pnpm placeholder may use `true`, `false`, or exactly the literal
`set this to true or false`; the actual 50-byte generated file is accepted,
near-misses are at stake. Only a non-redirect regular file is opened. Unix
O_NOFOLLOW|O_NONBLOCK plus handle checks prevent a FIFO (including a racing
replacement) from blocking; directory opens use O_DIRECTORY and no-follow,
and Windows uses reparse-point flags. Special files remain at stake.


Explicit validation cleanup first acquires path marks and start claims under
workspace lifecycle, then keeps those guards throughout its off-lock raw proof
and final removal. Active, starting or queued chats refuse cleanup, including
queues without a live process; every error releases the marks. It retakes lifecycle and rechecks actor/task ownership,
checkout identity/repository/detached HEAD, retained HEAD, file stamps and the
shared ignored inventory before non-force removal. An appeared/replaced or
changed folder is kept; final checks share the 10-second bound. Git omits
FIFOs/sockets from porcelain, so bounded metadata discovery supplements the
ignored inventory and marks those entries at stake without opening them.

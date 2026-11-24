# Worktree lifespan and removal paths

Moved verbatim from AGENTS.md on 2026-11-24.

### Host worktree lifespan

`worktree_lifespan.rs` owns one process-wide sweep thread, started from
`Services::load` only outside tests: first pass after three minutes, then hourly.
Defaults are enabled, build output after 3 idle days, Finished folders after 14,
and a task/mission/chat checkout whose HEAD is already held by its base after
`removeMergedAfterDays` (default 1; 0 is the next sweep). That fast path
(`merged_into`) is proven with Git (`for-each-ref --contains HEAD`: the recorded
base, the project default, develop/main/master, local or `origin/`; the
checkout's own branch and its remote copy never count) and only shortens the
idle time. Every other guard and `remove_proven` are unchanged.
Only managed task/mission worktrees, indexed `octiq/` chat worktrees under
`.worktrees`, and recorded validation checkouts qualify. Primary, adopted,
direct and hand-made checkouts are informational and never changed. State is
derived each scan, never saved; settings, pins, verified archive refs, removal
intents and the last 50 sweeps are saved through the pinned profile.

A start and a removal never both go through: take the workspace lifecycle lock,
mark every checkout under the chat session table, then claim the union of
associated chat keys once and check activity. A mission holds all these guards
across every checkout's off-lock proof and final removal; a stopped chat whose
cwd and extraDirs span repositories must not be claimed twice. All guards drop
on every exit. `start_session` checks the path mark under that same
table, including a new chat id and extra directories. Enqueue checks the same
mark under the queue lock before acknowledgement, so a new queued turn cannot
cross the cleanup check. Never hold the ledger
across Git, a chat lock or roster reads. Never stop a chat to make it removable.
Disabling and pinning narrow cleanup permission: act in memory on a failed save,
say `unsaved`, and join `dispatch::settle_owed`. Enabling and unpinning need their
record first. An unread record is never replaced with defaults on that retry.

The host strips only ignored `target` beside `Cargo.toml` and `node_modules`
beside `package.json`, with no tracked files inside. `dist`, `out`, `renders`
and `source` never qualify. Redirects are never traversed. A cargo/rustc process
withholds STRIPPING only (it may be using a `target`); whole-checkout removal asks
about that checkout itself, so an unrelated build never holds it (on a busy Mac one
is nearly always running, and nothing was removed for weeks). Unknown
cwd/open-file inventory (always Windows today)
withholds both stripping and worktree removal, as does a Windows reparse point. No profile means
no sweep. Git calls are bounded, non-interactive and do not fetch.

Entries inside a qualifying build folder count against their own bound
(5,000,000, `BUILD_ENTRIES`), not the 100,000 for the rest of the checkout
(`WALK_ENTRIES`); a React Native `node_modules` alone is ~156,000. The two
walks recognise different folders: **tree sizing** (`Tree::walk`) treats only
`target` beside `Cargo.toml` and `node_modules` beside `package.json` as build
folders, so `dist` and `.astro` count against the 100,000; the **ignored
inventory** (`ignored.rs`) also classifies `dist` and `.astro` as rebuildable
build trees. One inspection of either has 60 seconds (`WALK_TIME`) before any
lock. Under lifecycle the ignored inventory keeps 15 seconds (Git status inside
it is also bounded by the 10-second final budget) and the Windows reparse scan
of a validation checkout gets only what is left of the final budget: the final
budget bounds Git calls, so that walk carries its own limit.
Inside such a folder the walk knows once per directory that its files are
rebuildable (`ignored::Under`), unless a `source`/`works`/`anime` folder,
a `.git` or bare-repo shape, a non-regular file or (under `dist`) a link is
found: the at-stake rules are unchanged. A bound that is still hit says which
part and what to do (`walk_limit`). A final ownership check
(`ownership_unchanged`) looks at allocations AT or INSIDE the checkout, and at
an allocation ABOVE it only while that one is active (unsettled attempt, open
decision or unfinished task of its run): a settled folder a run worked in place
(a non-Git project folder holding `.worktrees`) has another repository by
definition and rejected every worktree under it, every sweep, but an active one
can still write below it.
**A removal moves the folder aside first** (`worktree_lifespan/quarantine.rs`).
Four review rounds each found one more host-side writer that a claim over chats,
jobs and terminals had not listed (a chat above the checkout, a registered job
whose process works above it, a host terminal, a job admitted after the claim).
The class is closed structurally instead: after every final check, still under
the lifecycle lock and the path/start claims, the checkout is renamed to a
sibling on the same volume, `<parent>/.octiq-removing-<id>`, with
`git worktree move` (Git's own record follows; a move across volumes, an
occupied name, a locked worktree or Windows refusing the rename for an open
handle fails the move whole and the folder is kept, in words). From then on no
process can reach the folder by its path: a shell or job above it, a child
nobody registered, a shell that later `cd`s. What can still touch it is what
already holds it open, and that is asked on the new name, in this order:
(a) one `lsof` for every working folder and open file at or below the
quarantine (unknown is a yes; on Windows the refused rename is that check);
(b) the content proof again (`verify_contents`: config, HEAD, at-stake ignored
inventory, file stamps, which are keyed by the path inside the checkout so they
compare across the move); (c) only then Git's removal on the quarantine path.
Any failure at (a) or (b) moves the folder back (`git worktree move`, preceded
by a `worktree repair` when a kill left Git's record behind), never over
anything. **The original path made again while the folder was away** (a writer
ran `mkdir -p` on it) is never deleted or merged into: the removal goes on only
when (b) passed, and the sweep's report names the recreated path
(`quarantine::take_notes`); a move back that finds the original path occupied
keeps the quarantine and says where it is. Git moves INTO a destination that
is a folder already (as `mv` does), so a path made again in the gap between
that look and the move back would swallow the checkout: `restore` checks that
the original is the checkout afterwards and, if not, says where it went
(`<original>/.octiq-removing-<id>`); nothing is lost or merged.
**The intent is durable before the rename**: `<profile>/lifespan-quarantine/
<id>.json` (`Record`: repo, original, quarantine, time), written and synced
through `profile::make_dir`; an unwritable record means no rename. Every sweep
starts by looking at the records (`quarantine::recover`, under lifecycle, before
anything is listed): the folder is put back when its original path is free, kept
and reported when both exist or the move back fails, a record whose folder is
gone is dropped, and one that names a folder this host would not have made
(`PREFIX` + its id) is refused. Nothing left behind is ever removed blindly.
All physical removals go through it: the sweep and Cleanup/Close/validation
(`remove_proven`) and the confirmed Archive (force removal, with its own
ignored-hash and stamp comparison on the quarantine path). The shared 10 s
final budget covers every scan: the `lsof` and the proof run inside it, a
timeout is "unknown" and puts the folder back, and the undo itself runs
without the budget (`git::unbudgeted`) because a rename is never skipped for
want of time.
**What was dropped, and why.** The ancestor claim over chats, queued turns,
jobs, background work, handoffs and starts in flight
(`ChatManager::hold_lifespan_ancestors`), the host-terminal fence
(`PtyManager::fence_lifespan`, with its refusal to spawn a shell) and the job
admission fence (`chat_jobs::Store::fences`, `retry shortly`, the wrapper's 30 s
retry) are gone: each existed to keep a writer that works ABOVE the checkout
from writing into it, and after the move that writer's path no longer exists
(it fails, or recreates an empty path that is left alone). They also kept a
whole `.worktrees` tree for as long as a terminal or chat sat at its parent
folder, which is a common habit. What is kept is what a path cannot solve: the
claims on chats and starts AT or INSIDE the checkout
(`hold_lifespan_checkout`, `claim_start`, `require_lifespan_idle`), the ledger's
active-ancestor ownership check (`ownership_unchanged`), and the `lsof` on the
quarantine. Strip (rebuildable build folders only) never needed it: a file
lost from `target` or `node_modules` is regenerated.
**Residual limits.** A process that opens the quarantine by its new name (a
`find` or `rm -r` over the whole parent folder that was already walking it)
reaches it like any external writer; the name is random and exists for a
moment. A process that holds nothing open inside and only has its working
folder above is, by design, unaffected. The `lsof` is a snapshot: a process
that gets a descriptor for the folder by passing one over a socket after the
scan is outside what a path or an `lsof` can see. Accepted limit: a process
that lists the parent folder, finds the `.octiq-removing-*` name and writes its
only copy of some data into it after the final proof can still lose that data;
every check-then-remove leaves some window, and the quarantine narrows it to
this case. Recovery decides where the checkout really is before acting: when
`<q>/.git` is missing, exactly one child of `<q>` whose `.git` and Git's
back-pointer name each other is taken as the checkout (a crash after the move
into a folder made first, before the rewritten record landed); none, several
or anything unreadable keeps everything and says so. A review of a new removal
path checks that it goes through `quarantine::remove`, not that it enumerates
writers.
A checkout's own branch, and any listed ref that differs from it only by ASCII
case (one ref file on a case-folding filesystem), never proves it merged. A project folder that is not a Git repository, or is gone,
is skipped without a failure line.

Removal refreshes chat delivery first, saves intent before `git worktree remove`
without force, then records `sweptAt` without changing task workspace state,
mission `removed`, or the person's Close/Abandon. Branches stay. A missing folder
is reconciled only with its repository and original worktree container present;
no global prune is run by a sweep. A later task restores the same path from the
kept branch; existing merged/abandoned refusals remain. Chat recovery keeps its
existing order. Archives use a temporary index, `commit-tree`, and
`refs/octiq/archive/<slug>`; the real index and branches do not move and hooks do
not run. Only a verified archive permits force-removing a dirty abandoned tree.
Ignored files are excluded. Agent history and its worktree-named session folders
are never touched. The five `worktree_lifespan_*` commands are socket-only;
there is no hook or MCP route. See `docs/subagent-worktree-lifecycle.md`.

**A clean status says nothing about ignored files.** Non-force `git worktree
remove` deletes them too; media under Starfall's ignored `works/` and `anime/`
may be the only copy. Each worktree (validation checkouts included) gets a bounded
`git status --ignored=matching` metadata inventory, without following redirects. Only
`target` beside `Cargo.toml`; `node_modules`, `dist`, `.astro`, `*.tsbuildinfo`
beside `package.json`; plus `.DS_Store` and `*.log`
are rebuildable. Every file under a `source/`, `works/` or `anime/` tree overrides
this list and is at stake, including `dist`. `pnpm-workspace.yaml` is rebuildable
only beside a tracked-or-present `package.json`, at most 4 KiB, valid UTF-8,
with non-empty lines exactly `allowBuilds:` first and then two-space-indented
`<name>: true|false|set this to true or false` entries; comments, other keys and unread files are at stake.
Any ASCII-case-insensitive `.git` entry or bare-repo shape (`HEAD` file plus
`objects/` and `refs/`) is at stake and opaque, even inside build output.
Symlinks inside a real qualifying `target`/`node_modules` are rebuildable links;
their targets are never followed. All other symlinks remain at stake, and a
symlink build root never qualifies. This classification does not expand
the strip allow-list above. `Item.ignoredFiles` / `ignoredBytes` count only
at-stake ignored files; null means incomplete/failed/timed-out inventory.
Nonzero or null keeps an inactive item Abandoned and never Finished; state
explains the count or failure. Removal repeats the inventory under the same
lifecycle/path/start marks immediately before Git. Explicit validation cleanup
also refuses nonzero/unknown inventories and any Windows reparse point. Task/mission rebuild is unchanged.
`statusHash` includes the at-stake ignored metadata inventory, so its change
invalidates an archive preview. Archive refuses null inventory. Its confirmation
must show the at-stake count and say these ignored files **will be deleted and
are not in the archive ref**; only the person's confirmed archive flow may
remove them. Never describe a clean Git status as proof all files are retained.

Strip and Finished removal use the **same** ignored inventory predicate. Strip
walks each complete build subtree with it; any at-stake entry, walk failure or
limit withholds that subtree. Abandoned may still lose a proven safe build tree.
Heavy usage, tree and content checks run outside the workspace lifecycle lock,
with path/start marks retained. Reacquire lifecycle for each final operation and
recheck allocation/activity. Content hashing has a 2 GiB total and 120-second
budget; tree sizing and the ignored inventory each 60 seconds, 100,000 entries
outside build folders and 5,000,000 inside them (the two walks recognise
different build folders, above). The final ignored inventory under lifecycle
has 15 seconds with the same entry bounds, Git status inside it limited by the
10-second final budget, and the final Windows reparse scan gets what is left of
that budget; a bound withholds that item with a reason and other workspaces continue. Archive capture and fresh-index comparisons have 120-second command bounds
outside lifecycle. Git
metadata output stays capped at 32 MiB per command. Git removal is bounded to 15 seconds;
filesystem mutation can still wait on the OS. Release lifecycle between items.

**Git's clean or equal is not proof that raw bytes can be restored.** Every
removed byte must be rebuildable by the shared predicate, or restorable byte
for byte from a kept ref. `raw.rs` reads `ls-files -v`: lowercase
assume-unchanged and `S` skip-worktree entries existing on disk must match
Restore's output; absent sparse entries are fine. Hidden edits make the item
Abandoned and name the count. Status overrides `status.showUntrackedFiles=all`,
`core.fsmonitor=false`, `core.untrackedCache=false`, `--untracked-files=all`,
and `--ignore-submodules=none`.


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
The last step of every physical removal, Archive included, is the quarantine
(`worktree_lifespan/quarantine.rs`, see Host worktree lifespan): rename the
checkout aside, `lsof` and the content proof again on the new path, then Git.
No door enumerates writers any more; a new removal path calls
`quarantine::remove` or is not a removal path.

| Path | Guard before physical removal |
| --- | --- |
| Automatic ordinary chat / task / mission / validation lifespan | `operate_progress` verifies policy, pins, idle/activity, known usage and ownership, then the shared `remove_proven` door (quarantine, then Git) |
| Per-task Cleanup | `cleanup_workspace` rechecks coordinator, task/workspace identity, leases, gates, other owners and merge/expected HEAD; `cleanup_verified` enters the shared door |
| Per-task Abandon | Same task guards and shared door; unpublished commits keep the folder; no discard bypass |
| Mission Close | `close_mission` rechecks the complete mission plan set, workers, gates and merge; each `cleanup_verified` enters the shared door |
| Mission Abandon | Same mission guards and shared door, with the existing published-commit gate; no discard bypass |
| Explicit validation removal | `remove_validation` rechecks allocation ownership and activity; `remove_validation_verified` requires detached HEAD, then enters the shared door |
| Confirmed Archive then remove | Its own lifecycle/path/start/usage/pin guards, exact preview hash including ignored inventory, verified archive ref/tree and full captured-tree disk/type proof, config guard and final stamps, repeated on the quarantine path; only this path calls force removal, and only after the quarantine |
| Coordinator batch approval | Existing per-task Cleanup / mission Close paths below the socket-only answer; exact approved plan/HEAD, save-first, same raw/ignored/profile/activity proofs; no Abandon or Archive |
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
`--attr-source` / `GIT_ATTR_SOURCE` binds attributes to the kept ref, including sparse omissions. Git below 2.41 or an unparseable version keeps the
folder: an unknown environment variable alone is never evidence of support.
A non-empty `config.worktree` keeps every removal, including confirmed Archive: Restore does not recreate those settings, so they were not proven.
Do not interpret keys. Read without redirects; unreadable/unexpected keeps,
empty/absent proceeds. Include its presence and metadata in final file stamps.
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
Object before resume). Metadata output retains its 32 MiB cap.

Observe retains a cheap hidden-entry-only check, so hidden edits still appear
Abandoned with a count. A removal mismatch also appears Abandoned with its
path/reason. Failed full proofs are remembered in RAM by HEAD plus the complete
file stamp inventory; unchanged failures are not re-proven each hourly sweep.
Changed HEAD/stamps invalidate that outcome. A bound is a kept reason, never
Abandoned merely for exceeding a bound.

Explicit validation cleanup takes path and start claims under workspace
lifecycle before its off-lock proof and keeps them through the final removal.
Active, starting and queued chats on that path refuse cleanup; guards release
on every error. The final door rechecks chat activity as well as ownership.

Before either long final comparison, snapshot tracked/untracked path identities
and size/mtime/ctime (Windows uses FILE_BASIC_INFO.ChangeTime). Afterwards
capture usage again, reacquire lifecycle, then recheck settings, pin, profile,
allocation/activity, HEAD, ignored inventory against the preview hash, and the
complete file stamp inventory. Every Git call in the final stage, including HEAD and stamp inventories, uses
only the remaining shared 10-second budget; Git removal keeps its separate
15-second bound; there is no dropped lock or content comparison after
these final answers. Strip preflights every build subtree before deleting any,
then repeats qualification/usage/inventory at each final door. Actual successful
strip count/bytes survive a later refusal, are published beside it, and update
the cache.

Only non-redirect regular files are opened for pnpm or content checks. Unix
uses O_NOFOLLOW|O_NONBLOCK and validates the opened handle, so a FIFO or a
racing FIFO replacement cannot block open. Directory handles are checked and
opened with O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK; Windows uses reparse-point flags.
Other file types stay at stake. The pnpm grammar accepts the exact 50-byte
`allowBuilds:\n  esbuild: set this to true or false\n` placeholder; near-misses do not.

After the archive status hash and ignored checks, compare disk with the archive
using a **fresh** temporary index loaded from the archive tree, `diff --exit-code`
(no ext diff/textconv) and `ls-files --others --exclude-standard`. This avoids
both stale stat-cache assurances and status's comparison to the original HEAD.
Any difference/failure keeps both archive and folder. An external writer can
still change files after the final comparison and before/during Git removal;
path/start marks block host starts, not arbitrary filesystem writers.
Ask `profile::available` again after long checks, immediately before each
removal. A removal already done is an ending action: retain its outcome in RAM,
say `unsaved`, join `dispatch::settle_owed` / `profile_status.owed`, drop the path
from cache, and emit the owed `worktree-swept` when the profile is back (the
2-second retry, not the hourly sweep). A swept per-task Cleanup verifies the
kept branch against saved delivery evidence and re-verifies ancestry against
the current base, without rebuilding or a worker;
missing/stale evidence explains the swept state and asks for restore/refresh.


Explicit validation cleanup also prepares raw restoration proof outside
workspace lifecycle. It retakes lifecycle and rechecks actor/task ownership,
checkout identity/repository/detached HEAD, retained HEAD, file stamps and the
shared ignored inventory before non-force removal. An appeared/replaced or
changed folder is kept; final checks share the 10-second bound. Git omits
FIFOs/sockets from porcelain, so bounded metadata discovery supplements the
ignored inventory and marks those entries at stake without opening them.

# Codex approvals and linked worktrees

Moved verbatim from AGENTS.md on 2026-11-24.

### Codex approvals and linked worktrees

Codex's native MCP approvals use the same `permission::HOST_BOOKKEEPING` list
as the Claude hook; generate command-line tool approvals from that list.
Front desks still approve only `route_chat`. Codex's per-tool
`approval_mode="approve"` prevents the redundant native confirmation.
Every elicitation that still arrives uses the normal card: an MCP server can
forge the native message and `_meta` fields. Use the captured fixtures and
`scripts/capture-codex-elicitation.mjs`.

At Auto and Edits, linked-worktree Git operations get shared objects/ and
only the current existing branch's ref/reflog files and their locks
(`codex_git.rs`). In the current worktree's own admin dir they get index,
HEAD, AUTO_MERGE, ORIG_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD and MERGE_MSG
(each with its .lock), plus COMMIT_EDITMSG, MERGE_HEAD, MERGE_MODE,
SQUASH_MSG and FETCH_HEAD. The only admin directory
grant is logs/. Every path is checked for redirects and its expected
file/directory type before granting.
Never grant the shared git dir or worktree admin dir: shared refs/ and logs/
(including refs/remotes/), refs/stash, other branches or worktrees,
packed-refs, hooks, config, config.worktree, gitdir and commondir must remain
protected. Detached, unborn or malformed HEADs get no branch ref grant.
Only an ASCII branch that Git lists byte-for-byte is granted; any other listed
branch with the same ASCII case-insensitive name prevents the grant. Protected
names main, master, develop, the primary worktree's branch and the known
origin/HEAD default are matched without regard to ASCII case. Non-ASCII names
are refused to avoid APFS/NTFS Unicode case/normalization aliases. Ref files
and parent paths must not be symlinks.
Network access stays off at Auto and Edits; a FETCH_HEAD file grant does not
authorize a network fetch or push.
Before each exec launch or app-server start/resume/turn, git_ops prepares
only the validated branch's missing ref/reflog parent directories on the
host (through profile::make_dir, checking each component for redirects).
It never writes a ref or grants its parent; a failure only logs. This keeps
packed-only branches writable after pack-refs prunes their loose parents.
A gc during one turn can still remove a parent until the next turn prepares it.
Codex 0.163 refuses `file-write-unlink <admin>/rebase-merge` even when that
directory is a writable root (the same holds for rebase-apply and sequencer).
These directories are deliberately not granted: plain rebase and multi-commit
cherry-pick/revert fail before changing HEAD, rather than rewrite the branch
and leave a stuck operation at cleanup. `rebase --apply` is also unsupported:
Git 2.45 detaches HEAD to the upstream before the denied rebased-patches write;
the task branch ref stays intact. Recover with `git switch <task-branch>`.
Single-commit cherry-pick/revert and merge/commit use file grants. Never grant the admin parent to bypass this.
Git 2.45 may print a non-fatal packed-refs.lock denial during cleanup:
AUTO_MERGE can remain, as can CHERRY_PICK_HEAD after cherry-pick and REVERT_HEAD
after a conflicted revert. These last two still indicate an in-progress
operation despite exit 0; after verifying the result, remove only that own
admin marker (resolve its path with `git rev-parse --git-path CHERRY_PICK_HEAD`
or REVERT_HEAD). Clean single revert and `cherry-pick --no-commit` followed
by `git commit` need no marker cleanup. Shared packed-refs stays protected.
Autostash's dynamic index.stash.<pid> files are not granted (refs/stash also
stays protected). Observed denials are `file-write-create <admin>/rebase-merge`,
`file-write-create <admin>/rebased-patches` for rebase --apply,
`file-write-create <admin>/sequencer` and `file-write-create <admin>/index.stash.<pid>`.
Use merge, or use a Full-access worker or the coordinator for these operations.
There is no task-branch pin yet: `commit_roots` is recomputed from HEAD for
each launch, resume and turn, so a worker may switch to and commit on another
non-protected branch; protected branches are refused.
Validate the original admin path without following symlinks, and require its
gitdir back-pointer to name this worktree's .git file, before any grant. Fresh starts,
resumes and turns keep all writable roots together; `--add-dir` is for
directories, not these file roots. Native cards carry the actual provider.

Sandbox OS errors are not themselves safety approval cards. Codex's host
instructions explain the next step: an ordinary chat uses `request_access`
at the least useful level (Auto for a Read chat's project write, Full for
network/external writes/protected Git); a worker uses its task's decision
gate, since `request_access` cannot change a worker's assigned access.
Use merge/supported single-commit operations where sufficient, a project-local
cache, or an authorized host tool before asking for more access. Inspect the
exit code and resulting HEAD after a packed-refs.lock cleanup warning: the
commit can have succeeded. Never broaden Git roots to suppress the warning.
The dated measurement and its counting limits are in
`docs/codex-sandbox-refusals-2026-11-17.md`. The real CLI/stub-model job
transport check is `node scripts/test-codex-sandbox-jobs.mjs <octiq-job binary>`.
Refusal audits count direct invocations separately from log readbacks,
source/doc quotations and intentional test controls; a warning with exit 0
is not a failed operation. Report access-history and timestamp gaps explicitly.

# Codex linked-worktree commit access

Feedback `2ce4faa2-c838-4597-a149-a943dffdf175` is covered by
`codex_git::commit_roots`, including the protected-branch checks already present
in the integration base. The older proposed whole `.git` and worktree admin
directory grants must not be restored when integrating that feedback.

At Auto or Edits, a validated linked worktree receives these additional writable
paths, where `common` is its repository's common Git directory and `admin` is
its own `common/worktrees/<name>` directory:

- `common/objects/`.
- Only its existing, unprotected `common/refs/heads/<branch>` and matching
  `common/logs/refs/heads/<branch>` files, plus each file's `.lock` path.
- `admin/index`, `index.lock`, `COMMIT_EDITMSG`, `HEAD`, `HEAD.lock`,
  `AUTO_MERGE`, `AUTO_MERGE.lock`, and `admin/logs/`.

The shared Git directory, the admin directory itself, shared `refs/` and
`logs/`, other branches, `packed-refs`, hooks, `config`, and `config.worktree`
are not writable roots. Read, Manual, unset access, Full (which has no workspace
sandbox), and a primary checkout receive no additional Git roots. Protected or
unborn branch names receive no branch ref grant. Redirected admin paths and
foreign back-pointers receive no roots.

App-server start, resume and turn requests recompute the same bounded grants.
The exec transport combines all roots into one configuration assignment; file
roots never become `--add-dir` workspace context. Regression coverage lives in
`codex_git::tests` and
`agent_provider::tests::codex_exec_keeps_all_roots_on_fresh_start_and_resume`.

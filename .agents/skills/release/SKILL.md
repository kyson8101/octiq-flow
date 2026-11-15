---
name: release
description: >-
  Manually invoked as `/release`, or by an explicit "prepare for release" /
  "release it" / "ship it" / "release this build" mention, to run OctiqFlow's
  full release in a fixed order: (0) pre-checks, (1) every worktree and open PR
  merged into `develop`, (2) no error on Mac AND the Windows box, (3) version
  bump committed and pushed on `develop`, (4) every platform built green on
  GitHub, then fast-forward `main`, (5) remove merged worktrees and branches,
  (6) build the web client and `octiq-server` locally, (7) ASK before
  restarting the service, restart by touching `~/.octiqflow/restart.request`
  (never `install-service.sh`) and verify the live build, (8) publish to npm
  LAST by pushing the tag and confirming all five packages, (9) close finished
  missions. A release is never `develop`-only and never local-only. Does NOT
  auto-trigger: a finished task alone is not enough.
---

# Release

## Contents

- What OctiqFlow is now
- Step 0 — Pre-checks
- Step 1 — Everything merged into `develop`
- Step 2 — No error on Mac and Windows
- Step 3 — Version bump on `develop`
- Step 4 — Every platform green, then `main`
- Step 5 — Remove merged worktrees and branches
- Step 6 — Build both halves locally
- Step 7 — Restart the service (ASK FIRST), then verify
- Step 8 — Publish to npm, last
- Step 9 — Close finished missions
- Local-only deploy
- Rules

Release OctiqFlow end to end. **The order is the person's (2026-11-15) and is
not shortened**: all work in `develop` → Mac and Windows clean → `develop` →
`main` → cleanup → local build → restart → npm → missions. npm is last because
a published version cannot be taken back: it ships only once the local server
runs the same build.

Stop at the first failure, report it with its output, and do not go on.
Report each step's result separately. Every outward action (push, merge, tag,
delete a remote branch, restart) is part of what the person asked for when they
said release, except the restart, which is asked again in Step 7.

## What OctiqFlow is now

A **headless server** (`octiq-server`) plus a **React client** served over
HTTP. There is no desktop build: no `.app`, no `.dmg`, no `pnpm tauri`.

| Part | Built from | Lands at |
| --- | --- | --- |
| the client | `web/` (vite) | `web/dist`, read off disk at runtime |
| the backend | `src-tauri/` (`--bin octiq-server`) | copied to `~/.octiqflow/bin/octiq-server` |

They deploy separately: a client build reaches the browser on the next reload,
the backend only on a restart. Always ship both.

The release runs in the **primary checkout** `/Users/kyson/03-projects/octiq-flow`
on `develop`. Requires `cargo`, `pnpm`, `node` and `gh` on PATH; anything missing
-> stop and report, install nothing.

## Step 0 — Pre-checks

```bash
git fetch origin --prune
git status --short                       # primary checkout
ps -ax -o command | grep -cE "claude -p|codex exec" | cat
```

Stop and ask the person when:

- the primary checkout has changes this release did not make (another chat's
  in-flight edits would be built and committed into the release);
- an orchestration worker is still running (`orchestration_snapshot`: any
  attempt executing).

Confirm `develop` is checked out and equals `origin/develop`.

## Step 1 — Everything merged into `develop`

Unmerged work is found in three places:

```bash
git worktree list
git branch -a --no-merged origin/develop
gh pr list --base develop --state open
```

- A finished task or feature branch is merged into `develop` first (merge
  `develop` into it, test, merge it into `develop`). A branch or PR whose work
  is not finished, or a dirty worktree, is **listed for the person**, never
  silently left out and never merged half done.
- An open PR is merged by the lead's PR rules (reviewed, approved), not by this
  skill skipping review.
- Push `develop` once everything is in.

## Step 2 — No error on Mac and Windows

On this Mac, at the `develop` commit:

```bash
cd src-tauri && cargo test --lib
cd web && pnpm test && pnpm build
```

On the Windows box, at the **same** commit (ssh alias `windows-build`; recipe:
detached worktree under `C:\Pandaworks\Developers\octiq-validate-<sha>`,
`OPENSSL_NO_VENDOR=1` plus the three `OPENSSL_*` variables, `call vcvars64.bat`
on the same cmd line, long builds started through WMI, `npx -y pnpm@12.6.0`
because the box's pnpm 9 cannot read `web/pnpm-workspace.yaml`):

- `cargo test --lib` and `cargo build --bin octiq-server`
- web install + `vitest` + build

`tailscale status` first. If the box is offline, ask the person once whether to
release without it; never report Windows as "untested" on your own. New
failures block the release; known, triaged failures are named in the report.

## Step 3 — Version bump on `develop`

Every release is the next patch version. The single source is
`src-tauri/Cargo.toml`:

```bash
# edit version in src-tauri/Cargo.toml, then:
cargo update -p octiq-flow --offline --manifest-path src-tauri/Cargo.toml
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: release X.Y.Z"
git push origin develop
```

Check the tag `vX.Y.Z` does not exist yet (`git ls-remote --tags origin vX.Y.Z`).
No AI attribution in the message. Never amend, never force.

## Step 4 — Every platform green, then `main`

There is no CI on push. The npm workflow's manual mode builds every platform
(macOS arm64 and x64, Linux, Windows) without publishing:

```bash
gh workflow run npm-release.yml --ref develop -f publish=false
gh run list --workflow npm-release.yml --branch develop --limit 1
gh run watch <run-id> --exit-status
```

Only once that run is green on the release commit:

```bash
git merge-base --is-ancestor origin/main origin/develop   # must succeed
git push origin develop:main                              # fast-forward only
```

If `main` is not an ancestor, stop: a hotfix on `main` was never merged back.

## Step 5 — Remove merged worktrees and branches

Everything already merged into `develop` goes, local and on `origin`.

- Task worktrees of an orchestration run: the coordinator's
  `orchestration_workspace_cleanup_request` (host-verified, one card).
- Anything else, by hand, only after all of: `git merge-base --is-ancestor
  <branch> origin/develop`, a clean `git status`, and no ignored files at stake
  (`git status --ignored=matching`: anything beyond `target`, `node_modules`,
  `dist`, `.DS_Store`, `*.log` is listed, not deleted). Then:

  ```bash
  git worktree remove <path>            # never --force
  git branch -d <branch>                # never -D
  git push origin --delete <branch>
  ```

Never touch `main`, `develop`, the worktree a live chat runs in (OctiqFlow
rebuilds it at the same path on its next turn), or anything unmerged or dirty:
those are listed in the report.

## Step 6 — Build both halves locally

```bash
pnpm --dir web build
cd src-tauri && cargo build --profile release-local --bin octiq-server
```

Run the long build under `octiq-job --detach --label "Build local server" --`
and wait for its exit status. It produces
`src-tauri/target/release-local/octiq-server`. If either fails, stop: nothing
has been swapped, the running server is untouched.

A web build replaces lazy chunks: tabs already open may go blank on their next
lazy load until reloaded. Say so in the report.

## Step 7 — Restart the service (ASK FIRST), then verify

**Stop-gate. Do not restart without the person's typed go-ahead in this turn.**
Approval from an earlier release does not carry over.

Restarting kills every agent process the server owns, this chat included (it is
a grandchild of the server). Say that, with the live agent count from Step 0,
and wait. Everything up to here is already pushed, so nothing is lost.

```bash
touch ~/.octiqflow/restart.request
```

**Never run `./scripts/install-service.sh` yourself**: its `launchctl bootout`
kills its own shell halfway, and the backend is left down. The trigger file is
watched by `com.kyson.octiqflow.restarter`, which runs the install to the end.

This chat ends at the trigger; the next session verifies before Step 8:

```bash
tail -5 ~/.octiqflow/logs/restart.log      # ends with "Backend is up."
./scripts/octiq-check.sh                   # exit 0
cat ~/.octiqflow/live-build.json           # commit = the release commit
grep 'OctiqFlow:' ~/.octiqflow/logs/server.log | tail -1   # the URL to open
```

If the restart FAILED, the backend is **down**. Recover first:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kyson.octiqflow.server.plist
lsof -nP -iTCP:1421 -sTCP:LISTEN
```

## Step 8 — Publish to npm, last

Only after Step 7 verified the live build:

```bash
git tag -a vX.Y.Z -m "OctiqFlow X.Y.Z" <release-commit>
git push origin vX.Y.Z
```

**One release tag at a time**: parallel npm workflows race and the last to
finish sets `latest`. The tag triggers `npm-release.yml`; watch the run to the
end. Then confirm all five packages, allowing a few minutes of registry lag
after the run (npm processes publishes asynchronously; lag is not failure):

```bash
for p in octiqflow octiqflow-darwin-arm64 octiqflow-darwin-x64 \
         octiqflow-linux-x64 @kyson8101/octiqflow-win32-x64; do
  curl -s "https://registry.npmjs.org/$p?cb=$(date +%s)" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(process.argv[1],JSON.parse(s)["dist-tags"].latest))' "$p"
done
```

Every line must say `X.Y.Z`.

## Step 9 — Close finished missions

Orchestration runs and missions whose work is now merged are closed through the
host's `closeEligible` path (the coordinator's cleanup card or the run panel's
Close), never left open. A mission the host does not call eligible is listed.

## Local-only deploy

Only when the person explicitly asks for a local deploy and NOT a release: run
Steps 0, 2 (Mac only), 6 and 7, from the branch they name. Say plainly that
`main`, npm and Windows were not touched.

## Rules

- The order is fixed. Never tag before the restart is verified, never push
  `main` before every platform built green, never release from a task branch.
- Never force-push, rebase to get a push through, `--force` a worktree removal
  or `-D` a branch.
- Never restart without asking in the same turn.
- Ship both halves or neither.
- Report faithfully, step by step: what passed, what failed with its output,
  what was listed instead of done.

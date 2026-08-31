---
name: release
description: >-
  Manually invoked as `/release` (or by an explicit "ship it" / "release it" /
  "deploy this" / "release this build" mention) to run the fixed deploy
  sequence for OctiqFlow: (1) commit every working-tree change to the current
  branch, (2) push the current branch to its remote, (3) run the Rust and web
  test suites, (4) build the web client and the `octiq-server` binary, (5) ASK
  before restarting the backend service — the restart stops every live agent
  chat INCLUDING this one — then restart it by touching
  `~/.octiqflow/restart.request`, never by running `install-service.sh`, which
  would kill its own shell mid-restart and leave the backend down, and (6)
  print the URL to open.
  OctiqFlow is a SERVER plus a browser client; there is no desktop app step and
  no `.dmg`. Commits with a conventional message and no AI attribution; skips
  the commit step when the tree is already clean but still pushes. Never
  branches, never opens a PR. Does NOT auto-trigger — only on the `/release`
  slash command or an explicit ship/release/deploy mention; a finished task
  alone is not enough.
---

# Release

Deploy OctiqFlow end to end: **commit → push → test → build → restart the
service → print the URL**.

## What OctiqFlow is now

A **headless server** (`octiq-server`) plus a **React client** served over
HTTP. The user reaches it in a browser — on this Mac, on a phone, through the
cloudflared tunnel. The agents run on the server, with no window anywhere.

**There is no desktop build at all any more.** The Tauri desktop app and every
Tauri dependency were deleted; `octiq-server` is plain Rust. There is no `.app`,
no `.dmg` and no `pnpm tauri` command to run, so no request can ask for one.

The two moving parts:

| Part | Built from | Lands at |
| --- | --- | --- |
| the client | `web/` (vite) | `web/dist`, read off disk at runtime |
| the backend | `src-tauri/` (`--bin octiq-server`) | copied to `~/.octiqflow/bin/octiq-server` |

They are **deployed separately**, and that asymmetry is the trap: `web/dist` is
read live, so a client build reaches the browser on the next reload with no
restart at all, while the backend only changes when the service restarts. Ship
just the client and you get a new page calling a command the old backend does
not have, which fails as an unknown command. Always do both.

Run every command from the repo root: `/Users/kyson/03-projects/octiq-flow`.
Run the steps in order. Stop and report if any step fails.

## Step 1 — Commit

1. Run `git status --short` to see the working-tree changes.
2. If there is **nothing to commit**, say so in one line and continue to Step 2.
   "always commit" means "always run the sequence", not "create an empty commit".
3. Otherwise:
   - Stage everything: `git add -A`.
   - Read the staged diff (`git diff --cached --stat` and, for anything
     non-obvious, the full diff) so the message describes what actually changed.
   - Commit to the **current branch** with a **conventional-commit** message
     (`feat:` / `fix:` / `chore:` / `refactor:` …) that summarizes the change.
     **No AI attribution** in the message or trailer.
   - Do **not** create or switch branches. Do **not** amend or run any
     destructive git command.

## Step 2 — Push

Push the current branch to its remote, even when Step 1 had nothing to
commit — there may already be local commits the remote doesn't have.

```bash
git push -u origin HEAD
```

If it fails (no remote configured, diverged history, a rejected
non-fast-forward push), **stop** and show the error. Do not force-push, do
not rebase to force it through — surface the conflict and let the user
resolve it.

## Step 3 — Test

The restart in Step 5 stops every running agent chat. Finding out afterwards
that the new binary is broken costs the user real work, so the suites run
first — they take seconds.

```bash
cd src-tauri && cargo test --lib
cd web && pnpm test
```

If either fails, **stop** and show the failing output. Do not build, do not
restart. The old server keeps running, which is the right outcome.

## Step 4 — Build both halves

```bash
pnpm --dir web build                                    # tsc -b && vite build
cd src-tauri && cargo build --release --bin octiq-server
```

The client build is quick. The server is a release build with LTO, so give it a
minute or two on a cold tree; run it in the background and wait.

If either fails (non-zero exit, `error[...]`), **stop** and show the relevant
tail. Nothing has been swapped yet, so the running server is untouched.

## Step 5 — Restart the service (ASK FIRST)

**This is a stop-gate. Do not run it without the user's explicit go-ahead in
this turn.**

Restarting kills every agent process the server owns — every chat mid-answer,
including the one the user is talking to you in. Their transcripts survive on
the server and can be resumed, but the running turns are lost. Say that plainly,
name how many agents are currently running, and wait for an answer:

```bash
ps -ax -o command | grep -cE "claude -p|codex exec" | cat
```

Everything is already committed and pushed (Steps 1–2), so no work is lost
when this chat ends at the trigger — but you still will not get another turn
in it, so make sure the go-ahead is unambiguous before triggering it. The
restart kills this chat too: it is a grandchild of the server (`zsh ← claude
-p ← octiq-server`), and nothing can keep it alive.

Once they agree:

```bash
touch ~/.octiqflow/restart.request
```

**Do NOT run `./scripts/install-service.sh` yourself.** Its `launchctl bootout`
kills the shell running it — your own — halfway through, so the old server stops
and the new one is never started. The backend ends up **down**, and the line
that would have said so dies with the shell.

The trigger file is watched by a separate launchd job
(`com.kyson.octiqflow.restarter`) which the dying server cannot touch. It runs
`install-service.sh` to completion on your behalf: copies the built binary to
`~/.octiqflow/bin/octiq-server`, signs it, rewrites the plist, restarts the
service, and waits for the port. It re-reads the current bind address, so a
server on `0.0.0.0` does not come back on loopback.

Since this chat ends at the trigger, the next session verifies the outcome:

```bash
tail -5 ~/.octiqflow/logs/restart.log      # ends with "Backend is up."
lsof -nP -iTCP:1421 -sTCP:LISTEN           # something is listening
```

If the log says the restart FAILED, the backend is **down**, not merely
un-updated. Recover before reporting anything else:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kyson.octiqflow.server.plist
lsof -nP -iTCP:1421 -sTCP:LISTEN
```

## Step 6 — Verify, then print the URL

Do not report a deploy on the strength of a build succeeding. Check the thing
actually answers:

1. It is listening:

   ```bash
   lsof -nP -iTCP:1421 -sTCP:LISTEN
   ```

2. It is the NEW binary — ask it something only the new code can answer. The
   honest general check is a command the browser uses, over the real socket:

   ```bash
   T=$(curl -s http://127.0.0.1:1421/token)
   node -e '
   const ws=new WebSocket("ws://127.0.0.1:1421/ws?token="+encodeURIComponent(process.argv[1]));
   ws.onopen=()=>ws.send(JSON.stringify({t:"invoke",id:1,cmd:"list_workspaces",args:{}}));
   ws.onmessage=(e)=>{const f=JSON.parse(e.data);
     if(f.t==="reply"&&f.id===1){console.log("ok:",f.ok,f.error??"");process.exit(f.ok?0:1);}};
   setTimeout(()=>{console.log("timeout");process.exit(1)},10000);
   ' "$T"
   ```

   When the deploy added a backend command, ask for **that** command by name
   instead — an old binary rejects it as an unknown command, which is exactly
   the failure this step exists to catch.

3. Print the URL from the log, token and all — it is what the user opens:

   ```bash
   grep 'OctiqFlow:' ~/.octiqflow/logs/server.log | tail -1
   ```

   The client is served at the **root** (`http://127.0.0.1:1421/?token=…`) and
   only there. The older `/v2/` path redirects to the root with its query
   intact, so links and home-screen shortcuts people already saved still land
   on the app. Mention the tunnel URL too if the user reaches it that way;
   the token does not change across restarts, so their saved link keeps working.

## Rules

- This skill is **commit + push + test + build + restart**. It never opens a
  PR, signs, or notarizes. If the user wants any of those, they ask
  separately.
- **Always pushes** the current branch after committing (Step 2), not just as
  a last-minute save right before the restart. Never force-pushes, never
  branches, never rebases to force a push through a conflict.
- **Never restart without asking in the same turn.** Approval on a previous
  deploy does not carry over.
- Ship **both halves or neither**. A client-only deploy leaves a new page on an
  old backend and looks like a broken feature rather than a stale server.
- Report faithfully: if a step failed, say so with the output; never claim the
  server is running without seeing it listen and answer.

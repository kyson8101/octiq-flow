# AGENTS.md

This file provides guidance to coding agents (Claude Code, Codex) when working with code in this repository. Both read it natively; there is no `CLAUDE.md`.

## What this is

OctiqFlow is an **agent workflow orchestrator**: a headless Rust server plus a
browser client that runs **real terminals in a web page** and lets you **drive
interactive CLI agents (Claude Code, Codex, pi.dev) from UI buttons**. The core trick: a
UI action sends `pty_write` over the socket, Rust writes those bytes to a PTY's
stdin, and the shell/agent reads them as if typed. PTY output streams back as
`pty-output` events and renders in xterm.js.

> There is **no desktop app**. OctiqFlow was a Tauri 2 desktop app with a server
> bolted on the side; the window and the whole vanilla-JS `src/` frontend were
> deleted, along with every Tauri dependency. The server is plain Rust now. If
> you find a doc or comment describing a window, an `invoke_handler!` list or a
> `#[tauri::command]`, it is stale — trust the code.

## Branch workflow

- **`develop` is the base for new work.** Start work on `develop` or create
  task branches from `develop`. Target `develop` when merging task branches.
- **`main` is production.** The team uses it for daily work. Changes to `main`
  belong to an explicitly requested production release or hotfix.

## Commands

Run everything from the repo root. **Rust + Node + pnpm are required.**

## Versioning

Every release increments the patch version by one (`0.1.0` → `0.1.1`). The
single source of truth is `src-tauri/Cargo.toml`; update it and let Cargo refresh
the `octiq-flow` entry in `src-tauri/Cargo.lock`. The web build reads the Cargo
version automatically, so do not mirror the release version in
`web/package.json`. The npm source manifest deliberately stays at
`0.0.0-development`; `scripts/package-npm.mjs` stamps staged CLI and runtime
packages from the Cargo version during publication.

```bash
pnpm --dir web build                          # the client → web/dist
cd src-tauri && cargo build --release --bin octiq-server   # the backend
touch ~/.octiqflow/restart.request            # restart the backend (see below)
```

The restart above is a touched file, not a script, and that is deliberate —
see the bullet below. The two installers are run **once**, from a real terminal,
and never again from inside an agent chat:

```bash
./scripts/install-service.sh                  # first install of the backend service
./scripts/install-restart-agent.sh            # first install of the restart helper
```

- **Deploying** is done by the `/release` skill (commit → push → test → build
  the client AND `octiq-server` → ask, then restart the service → print the
  URL). It never signs or notarizes.
- **The client is served at the root** (`http://127.0.0.1:1421/?token=…`) and
  only there; `/v2/` redirects to the root, query intact, so saved links keep
  working.
- **The two halves deploy separately, and that bites.** `web/dist` is read off
  disk at runtime, so a client build reaches the browser on the next reload with
  no restart — while the backend only changes when the service restarts. A
  client-only deploy leaves a new page calling commands an old binary does not
  have, which fails as `'<cmd>' is not available on this backend — it may be
  older than the page asking for it`. Ship both.
- **Check the backend's state with `./scripts/octiq-check.sh`.** Read-only and
  safe from inside a chat: it says whether the service is up, which build is
  actually live, whether `web/dist` has run ahead of the server, whether the
  restarter job is loaded, and how much the running agents hold. Each run
  appends a JSON object to `~/.octiqflow/logs/audit.jsonl`, so "what changed
  since it last worked" is a grep. Exit 0 ok · 1 worth a look · 2 down.

- **Restart the backend by touching a file, NOT by running the script.**

  ```bash
  touch ~/.octiqflow/restart.request        # restart
  tail -f ~/.octiqflow/logs/restart.log     # what happened
  ```

  An agent chat is a **grandchild of the server it would restart** —
  `install-service.sh ← zsh ← claude -p ← octiq-server` — so the `launchctl
  bootout` halfway down that script kills the shell running the script. The old
  server stops, the new one is never bootstrapped, and the backend is left
  **down**, with the line that would have said so dying too. Check with
  `ps -o pid=,ppid=,comm= -p <pid>` walked up to PID 1 if you doubt it.

  The trigger file is watched by a **second launchd job**
  (`com.kyson.octiqflow.restarter`, installed once by
  `scripts/install-restart-agent.sh`) that the dying server cannot touch, so the
  restart always runs to the end. It re-reads the bind address from the running
  plist, so a server deliberately put on `0.0.0.0` does not come back on
  loopback. Reinstall it only if this repo MOVES — the path is baked into its
  plist.

- **Restarting stops every live agent chat, including the one doing it.** Every
  `claude -p` / `codex exec` the server owns dies with it, and nothing can save
  the chat that asked — it is a child of what is being restarted. Transcripts
  survive and can be resumed; the running turns cannot. **Ask before doing it,
  and commit and push first**, because you do not get another turn afterwards.
- **Rust tests** (inline `#[cfg(test)]` in several modules): `cd src-tauri &&
  cargo test`.
- **Web tests**: `cd web && pnpm test` (vitest, node environment, no jsdom).
  These cover `web/src/lib/` pure logic — chiefly the `chat.ts` reducer,
  replayed against **real captured agent streams** in
  `web/src/lib/__fixtures__/*.jsonl`. Those fixtures are verbatim
  `claude -p --output-format stream-json` output; re-record them with the same
  flag set `build_command` uses (`agent_chat.rs`), never hand-edit them. A few
  component tests render through `react-dom/server`.
- **Format**: `cd src-tauri && cargo fmt`. There are no eslint/prettier/rustfmt
  config files; defaults apply.

## Architecture

```
browser ──HTTP/WS──► web.rs ──► dispatch.rs ──► the backend fn
                        ▲                            │
                        └────── bus.rs ◄─────────────┘  (events, fanned out
                                                         to every browser)
```

### The request path

- **`web.rs`** serves the client from `web/dist` and holds the socket. It is
  also the whole auth surface: the token comparison (`ct_eq`, constant time),
  the `local_token` guard, the proxy check (`came_through_a_proxy`) and the
  Cloudflare Access hand-off. Treat changes here as sensitive.
- **`dispatch.rs`** is the single command table: a name plus JSON args in, a
  backend call out. **To add a backend command: write the fn in its module, then
  add a `"name" => …` arm to the `dispatch` match.** That is the only wiring
  step — there is no macro list any more.
- **`bus.rs`** is the event fan-out. Producers call `bus::emit`; it serializes
  once and broadcasts to every attached browser.
- **`access.rs`** verifies the JWT Cloudflare Access puts on a request. Empty
  config means off, and the token stays the only way in.

### Backend modules (`src-tauri/src/`)

- `pty.rs` — multi-PTY sessions keyed by a **client-supplied String id**, plus
  OSC attention scanning (see Alerts). Shells are login shells (`$SHELL -l` on
  Unix, powershell on Windows; see `resolve_shell`) so `PATH` is fully
  populated — otherwise `claude` would not be found.
- `agent_chat.rs` — agents run as a JSON stream (`claude -p`, `codex exec`)
  rather than a TUI, for the chat view.
- `workspaces.rs` — the "project" store (a project groups several folder paths).
- `git.rs` — the **single** git-read backend (status summary, changed files,
  file diff). Read-only; shells out to `git`. Resolves each project path to its
  repo top-level and de-dups so one repo shows once. `git_ops.rs` holds
  everything that MUTATES a repo, so "can this touch my repo?" is answered by
  the module name alone.
- `chat_task.rs` — where a chat is and what became of its work. See **A chat's
  status is half reported, half verified** below.
- `fsbrowse.rs` — file browser listing and reads.
- `memory.rs` — what this app holds in RAM, and which chat or terminal holds it.
  One `ps` sweep, then a walk DOWN from the server's own pid, carrying the
  nearest claimed ancestor: a chat claims its pid (`ChatManager::chat_pids`), a
  terminal claims its shell's (`PtyManager::shell_pids`), so an agent's MCP
  servers land on the chat that started them however deep they sit. Nothing
  outside this process tree is counted — a `claude` running in the person's own
  Terminal is not ours to report. Cached for a few seconds so several open
  browser tabs share one sweep. Read-only; it can only ever run `ps`.
- `bin/octiq-notify.rs` — a **separate binary target** (auto-discovered from
  `src/bin/`). It prints an OSC 777 sequence to its own stdout; run inside an
  OctiqFlow terminal, the PTY scanner sees it and raises an attention alert.
  See `docs/octiq-notify.md`.

### Persistence locations

| Store | Path | Owner |
| --- | --- | --- |
| workspaces | profile dir (JSON) | `workspaces.rs` |
| server config (port, bind, token, Access) | `<profile dir>/web.json` | `web.rs` |
| chat transcripts | profile dir | `chat_index.rs`, `transcript.rs` |
| agent diagnostics | `~/.octiqflow/logs/agent-diagnostics.jsonl` (one rotated predecessor) | `diagnostics.rs` |
| chat task status | `<chats dir>/task-status.json` | `chat_task.rs` |

`profile.rs` decides the profile dir; `profile_lock.rs` makes sure only one
process owns a profile at a time (a second one refuses to start rather than
overwrite the first's project list).

### A chat's status is half reported, half verified

The line above the chat (`ChatTaskBar`) answers three questions a chat picked
up an hour later cannot answer for itself: is anything happening, what is this
chat FOR, and which branch is it doing it on. The panel behind it answers the
fourth — did that work ever land.

The split in `chat_task.rs` is the whole design, and it exists because an LLM
forgets:

- **The agent REPORTS** the objective, the plan and the active step, through
  the `task_status` MCP tool (`scripts/mcp/octiq-ask.cjs` → `POST /hook/task`).
  Nothing infers it: a chat whose agent never reported says *not reported*
  rather than guessing from the transcript. Every report is stamped with the
  time and the agent, so a stale one looks stale.
- **The host VERIFIES** everything else with git, on request: branch, primary
  checkout vs linked worktree, changed files, commits ahead of the target,
  pushed, merged locally, merged on the remote, released. An agent saying
  "merged" changes nothing — only the merge does.

Three rules hold:

- **`released: null` is "unverified", never "no".** A project says how a
  release is recognised in the Release row itself, or with
  `chat_task_set_release_check`: a git ref only a release advances, or a
  command whose output names the running commit — the first 7–40 character hex
  string in its output is taken as that commit. Most projects have neither, and
  the release row says so. The check is not run at all until git says the
  commit is in the target branch, so an unmerged branch never shells out.
- **What is running is recorded at install, by `install-service.sh`.** It
  writes `~/.octiqflow/live-build.json` (`commit`, `branch`, `shippedAt`) next
  to the `cp` that makes a binary live, because nothing else knows: the binary
  carries no version of its source and mtimes only say "newer than".
  `octiq-check.sh` prints that commit on its `live build` line, and it is what
  this repo's own release check reads.
- **The record outlives the worktree.** Every verification stores its snapshot
  plus the repository's PRIMARY checkout and the head commit, so a chat whose
  directory has been deleted is re-verified from the primary checkout against
  the commit it remembers, marked `stale`. "Was that ever merged?" is asked
  precisely when the worktree is gone.
- **Nothing polls.** The bar refreshes when the chat opens, when a turn ends,
  on `git-status-changed`, and when the panel opens; verification is cached for
  four seconds so several open tabs cost one `git status`. The accent is for a
  turn in flight only — states the work is merely *owed* stay quiet.

### Both agents' full stops carry their closing words

`turn_is_over` reads `result` (Claude) and `turn.completed` / `turn.failed`
(Codex). Only Claude's carries the text. Codex's is **empty** — a usage block
and nothing else — and what it said is in the last `item.completed` of type
`agent_message` before it, so the reader keeps that line as it goes past
(`codex_said`) and `closing_words` hands over whichever half applies. Without
this a Codex response could disappear at the turn boundary.

### The queue behind a running turn is ours, for both agents

A message sent while a turn is in flight waits in `ChatManager::queued_turns`
(`QueuedTurn`) and is handed over only when the agent is ready for it. Both
providers, one queue, two reasons:

- **Codex** is one-shot, so a follow-up rides the next `resume` command — its
  reaper takes the front of the queue as the old process exits.
- **Claude** would take the bytes on stdin at any moment, and used to. The
  message went into the AGENT's own internal queue, out of this backend's
  reach, which is why a queued message could not be taken back. It is now
  written on the full stop of the turn before it, **under the same session
  lock** `turn_ended` is taken with — let go of it in between and an ordinary
  send arriving in that gap finds the session idle and jumps the line.

What that buys is `chat_cancel_queued` (the ✕ on the queued bubble): it can
only ever remove a message still in OUR queue, and answers `false` when the
agent already has it — a race nobody can win, and better told than shown a
bubble vanishing from above the answer to it. Taking one back is the ✕ and only
the ✕ — the one control that says WHICH message.

The same bubble can also say **send this one now**. `chat_start_queued` finds
that exact turn id in the chat queue, moves it to the front, and interrupts the
process. The remaining turns
stay queued behind it. A stale click answers `false` without interrupting
anything when the agent already took the selected message.

**Stop keeps the queue, and its first message starts straight away.** Stop is
"not that — do the thing I have already typed instead", and it was that for as
long as this app has had a Stop button: the message used to go down Claude's
stdin into Claude's own queue, which an interrupt made it pick up immediately.
Moving the queue to this side briefly took that away; it is back, and it is
what `chat_interrupt` is for. Two things hold it up:

- **Nothing in the interrupt writes the next message.** Claude's is handed over
  by the reader thread on the cut-off turn's own `result` (any `result` sets
  `turn_finished`, the interrupt's `error_during_execution` included), under the
  lock that ends the turn. Codex has no reader to do it — its process is being
  killed — so `chat_interrupt_impl` lifts the queue clear BEFORE `end_process`,
  which would otherwise discard it, and starts the first message itself.
- **A send may not go round a queue that has anything in it**
  (`has_queued_turns`). The interrupt ends the turn immediately — the
  still-clock has to start somewhere — so between a Stop and the reader picking
  the queue up, the session reads idle with messages still stacked behind it.

- **A one-shot provider's queued turn is written to the transcript at enqueue**
  (`QueuedTurn::recorded`) because Codex never echoes a prompt back. Claude's
  is not — its own echo is the record — so cancelling one only has something to
  take back OUT for Codex. `announce_cancelled` always emits, and appends only
  when there was a record; the client reducer drops the message by turn id
  either way.
- Two things you typed are two bubbles now (`groupTurns`), whichever agent this
  is. One bubble over several queued messages lost its clock the moment the
  first was picked up, and gave the ✕ no single message to name.

### Idle chats are ended, and resumed on the next message

A **chat** process (`agent_chat.rs`, not a PTY) is killed after **15 minutes**
with no turn in flight, by **one** sweeper thread for the whole backend, not one
per chat: `start_idle_reaper` is spawned once from `Services::load`
(`dispatch.rs`), which `lib.rs` calls at startup and nothing else calls outside
the tests. It wakes every 60 seconds and walks the whole session table under one
lock, reading a flag and an `Instant` per chat. What a chat carries is a CLOCK —
`busy` and `last_active`, moved by `turn_started` / `turn_ended` — never a timer
of its own. Nothing is lost and nothing is announced: the transcript is already
on disk, the client's send path already starts a chat it has no process for with
`resume`, and the `exit` event it triggers is what turns the live dot off.
`OCTIQ_CHAT_IDLE_MINS=0` turns it off; any other number sets the minutes.

- **"Idle" is `!busy`, never "no output lately".** A turn is in flight from the
  moment something is written to the agent's stdin until its own full stop
  (`result` / `turn.completed` / `turn.failed`). An agent inside a 20-minute
  build, or parked on a permission card, says *nothing* — read silence and you
  kill the one turn that mattered.
- Why it is worth having: a chat costs ~480 MB — the agent plus its own copy of
  every MCP server it starts. Nine left open overnight held 4.3 GB.

### Attention alerts

`pty.rs` scans PTY output for OSC 9 / OSC 777 / OSC 99 (Kitty) "notify"
sequences and raises a `pty-attention` event. This is how agents that emit no
escape codes flag a terminal — run `octiq-notify` and the alert fires.

### Appearance modes (browser client)

The client offers exactly three modes in Settings: **Light**, **Dark**, and
**Fun**. Their persisted ids are `light`, `dark`, and `fun`; `themeStore.ts`
migrates the retired `one-light`, `octiq`, and `candyland` ids and sends every
other retired palette back to Dark.

- Dark is the default palette in `design-system.css`. Light and Fun are the only
  palette files under `web/src/lib/themes/`.
- `web/src/lib/theme.ts` translates their shadcn-shaped tokens (`--primary`,
  `--card`, `--muted-foreground`) into the app's semantic variables
  (`--accent`, `--bg-1`, `--fg-2`). Modes set colours and corner radii only —
  never fonts or shadows.
- The terminal cannot read a `var()` — xterm hands its palette to WebGL. So
  `web/src/lib/xtermTheme.ts` resolves variables through a hidden element and a
  1×1 canvas.
- Text on a fill uses `--accent-fg` / `--danger-fg`, not hardcoded white.
- `vite.config.ts` keeps `test: { css: true }`; otherwise Vitest stubs raw CSS
  imports to an empty string and alternate modes silently use fallback colours.

## Orchestrated task workspaces

See [the task workspace lifecycle](docs/subagent-worktree-lifecycle.md) for the
host-owned policy. A worker settling, code being pushed, a PR being merged, and
a workspace being eligible for cleanup are separate states. Retry and review
fixes reuse the task's persisted workspace with a new attempt ID. Current
checkout mode never deletes a directory. The main chat coordinates while a
worker owns the write lease; it must not also edit that checkout.

## Conventions & gotchas

- **End a finished task with `Task Completed`.** When the work asked for in THIS
  chat is done, the last line of the reply says so in those words — plus
  `— ready to ship` when it is committed and only the build/restart is left.
  Several chats run against this one checkout at once, and from the prose alone
  it is not clear whether the one being read has finished or is still going; the
  flag answers that at a glance. It goes LAST, after any caveats, flags, or
  things left to watch — a caveat is not a hedge on whether the work is done,
  and a reply that ends on one is exactly what the flag exists to disambiguate.
  When the work is NOT done the last line is `Task Not Completed` and one line
  saying why — blocked, waiting on an answer, part of the scope dropped — so a
  reply with no flag is never something to interpret. It speaks for this chat
  ONLY: other sessions working in parallel neither earn it nor withhold it.
- **Code comments reference "card NN"** (e.g. "card 04 — Project mode"). The app
  was built in numbered work cards/phases; the numbers are historical context,
  not a live system.
- **The `src-tauri/` folder name is historical.** There is no Tauri in it. It
  was left alone so paths, the service plist and muscle memory keep working;
  renaming it is a separate job.
- **Features the desktop UI owned were deleted, not kept.** Removing the window
  orphaned several backends, and rather than leave them rotting they went too:
  the canvas document store (`canvas.rs` is now just `canvas_dir_for`, which
  `pty.rs` uses for `OCTIQ_CANVAS_DIR`), profile switching and the one-time data
  migrations (`profile.rs`), the agent process/RAM overview and its kill
  (`agents.rs`), the notify-hook alert filter for frontend-raised alerts
  (`notify_hook.rs`), the PTY foreground/agent-running probes (`pty.rs`),
  "open in VS Code" (`fsbrowse.rs`), and the workspace setters for colour, icon,
  initial, docs path, startup layout, terminal command and font override. **They
  are recoverable from git history** — each was working, tested code, not junk.
  To bring one back: restore it and add a `dispatch.rs` route.
- The full brand set lives in top-level `brand/`, the (currently unused) agent
  artwork in `assets/agents/`.
- `scripts/generate_brand_assets.py` regenerates the brand/icon assets into
  `brand/` — not part of the app build.
- `scripts/hooks/agent-session-capture.cjs` is **orphaned**: it was installed by
  the deleted `agent_resume.rs`. Users may still have it wired into
  `~/.claude/settings.json`, so it was left on disk rather than deleted.

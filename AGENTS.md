# AGENTS.md

This file provides guidance to coding agents (Claude Code, Codex) when working with code in this repository. Both read it natively; there is no `CLAUDE.md`.

## What this is

OctiqFlow is an **agent workflow orchestrator**: a headless Rust server plus a
browser client that runs **real terminals in a web page** and lets you **drive
interactive CLI agents (Claude Code, Codex, pi.dev, Antigravity) from UI buttons**. The core trick: a
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

## Read before you change

Detail lives in `docs/agents/`, moved verbatim from this file. **An agent MUST read the matching file below before changing that area, and a reviewer must read it before reviewing a change to it.** Each rule there came from a review that found a hole. A comment in code that names an old section of this file ("AGENTS.md, A chat's level is its own") now means the docs file below that holds that heading.

| Area | File | Read this when you touch |
| --- | --- | --- |
| Backend module list | `docs/agents/backend-modules.md` | any `src-tauri/src/` module you have not worked in; `agent_chat.rs`, `agent_provider.rs`, Antigravity launch |
| Provider failover and runtime switch | `docs/agents/provider-failover.md` | `provider_failover.rs`, `provider_switch.rs`, `runtime_switch.rs`, `failover_policy.rs`, `chat_switch_runtime` |
| Pi harness | `docs/agents/pi-harness.md` | `pi_gate.rs`, `scripts/mcp/octiq-pi.ts`, Pi in `agent_chat.rs` or `agents.rs` |
| Codex approvals and linked worktrees | `docs/agents/codex-approvals-and-worktrees.md` | `codex_git.rs`, Codex elicitation or MCP approvals, `permission::HOST_BOOKKEEPING` |
| Profile folder rules | `docs/agents/profile-folder-rules.md` | `profile.rs`, `profile_lock.rs`, any store that reads or writes under the profile dir |
| Chat status bar, removed-folder recovery | `docs/agents/chat-status-and-folder-recovery.md` | `chat_task.rs`, `chat_recover.rs`, `ChatTaskBar`, `RemovedFolderBanner`, the MCP server's instructions |
| Access request, auto-mode refusal | `docs/agents/access-and-safety-cards.md` | `access_request.rs`, `request_access`, `SafetyBlock`, `SafetyToast`, `chat_set_access` |
| Questions UI | `docs/agents/questions-ui.md` | `ask_user`, `question_store`, `question_media.rs`, `InlineQuestions`, `lib/questionBlock` |
| Reply media, diagrams, now-playing | `docs/agents/reply-media-and-diagrams.md` | `octiq-media` / `octiq-diagram` blocks, `lib/nowPlaying`, `ReviewVideo` |
| Decision cards | `docs/agents/decision-cards.md` | permission, plan and access cards, `lib/cardFold`, `CardFold`, `lib/pressGuard` |
| Route and handover cards | `docs/agents/route-and-handover-cards.md` | `HandoverCards`, `handover.rs`, `lib/identityTravel` |
| Page chrome, status rows above the composer | `docs/agents/page-chrome-and-status-rows.md` | `App.tsx` `barActions`, `ActionBar`, `UsageRow`, `ChatStatus`, `ChatNotices` |
| Composer runtime chip and composer fit | `docs/agents/composer-and-runtime-chip.md` | `AgentIdentityChip`, `RuntimeSheet`, `lib/chatSettings`, `lib/composerFit` |
| Chat waiting state and turn clock | `docs/agents/chat-wait-and-turn-clock.md` | `lib/chatWait`, `lib/turnClock`, `lib/restoredPark`, `lib/pendingActions` |
| Closing words, queue and Stop | `docs/agents/queue-and-stop.md` | `queued_turns`, `chat_interrupt`, `CutOff`, `carry_queued_turn`, `turn_is_over` |
| Idle chats and worker tools | `docs/agents/idle-chats-and-worker-tools.md` | the idle reaper, `worker_browser.rs`, `codex_mcp_ready`, worker MCP flags |
| Completing a chat | `docs/agents/completing-a-chat.md` | `chat_complete`, `completing`, `chat_index::complete`, `lib/chatComplete` |
| Run panel and progress strip | `docs/agents/run-panel-and-progress.md` | `RunProgressStrip`, `OrchestrationPanel`, `lib/runProgress`, `lib/runWaits`, `lib/taskHold`, `lib/orchestration` |
| Jobs and attention alerts | `docs/agents/jobs-and-alerts.md` | `chat_jobs.rs`, `job_wrapper.rs`, `job_progress.rs`, `octiq-job`, OSC scanning in `pty.rs` |
| Appearance modes | `docs/agents/appearance-modes.md` | `web/src/lib/themes/`, `theme.ts`, `manga.css`, `guofeng.css`, `xp.css`, `cyberpunk.css` |
| Scheduling orientation and batches | `docs/agents/scheduling-and-batches.md` | `scheduling.rs`, agent lanes, `orchestration_batch_claim`, `workspace_cleanup_request` |
| Plan approval, retries, reopen, agent removal, peer requests | `docs/agents/plan-approval-retries-and-removal.md` | `orchestration/approval.rs`, `orchestration/retry.rs`, `reserve_attempt_for`, `agent_work.rs`, `team.rs` delete |
| Lead threads | `docs/agents/lead-threads.md` | `lead_threads`, `lead_thread_open`, `chat:lead-` keys |
| Worktree lifespan and removal paths | `docs/agents/worktree-lifespan-and-removal.md` | `worktree_lifespan.rs`, `worktree_lifespan/quarantine.rs`, `remove_proven`, Cleanup, Close, Abandon, Archive |
| Conventions and gotchas (the rest) | `docs/agents/conventions.md` | hooks that can write, transcripts and receipts, `profile` saves, source-text tests, browser scripts |

## Rules that bite

One line each; the full rule, its reasons and the reviews that found it are in the file named at the end. Read that file before touching the area.

- The profile dir is pinned at startup; folders are made only through `profile::create_dir_all` / `make_dir`, and a store's file is read with `profile::read`, never `std`'s `create_dir_all` or `NotFound => default`. `docs/agents/profile-folder-rules.md`
- An action that ends work or answers a waiting agent never waits on a save (rules A–D: no `?` on a save ahead of the act, say it `unsaved`, owe it; raising a level needs its record, lowering never waits). `docs/agents/conventions.md`
- Every start of a task goes through `reserve_attempt_for`; an approval fixes what a task runs as (`Task::approved`, `approval::keeps_to`). `docs/agents/plan-approval-retries-and-removal.md`
- Every physical worktree removal goes through `quarantine::remove` / `remove_proven`; no door enumerates writers. `docs/agents/worktree-lifespan-and-removal.md`
- A hook that can write refuses workers by durable identity (`is_worker_chat` / `require_user_chat`), never by `active_task`, and refuses room seats. `docs/agents/conventions.md`
- Lock order is roster (`team.rs` `LOCK`) then ledger, and no chat lock is taken under the ledger. `docs/agents/plan-approval-retries-and-removal.md` and `docs/agents/scheduling-and-batches.md`
- Derived facts the page reads (`heldByPlan`, `failure`, `retrying`, `awaits`, `coordinatesRun`, ...) are never stored and never taken from an agent. `docs/agents/plan-approval-retries-and-removal.md`
- The MCP server's instructions and each tool description stay under 4,096 characters (`scripts/mcp/instructions.test.cjs`). `docs/agents/chat-status-and-folder-recovery.md`
- Restart the backend only by touching `~/.octiqflow/restart.request`, never by running `install-service.sh` from a chat, and ask first: it stops every live agent chat. See **Commands** below.

## Commands

Run everything from the repo root. **Rust + Node + pnpm are required.**
Changes to the local build profile or artifact path must also update README's build → launcher instructions.

**Building on Windows also needs OpenSSL.** `src-tauri/Cargo.toml` asks for
`openssl` with the `vendored` feature, which builds OpenSSL from source and
needs **Perl** (Strawberry Perl, say). Without Perl, `cargo build` stops at
`openssl-sys` with "Command 'perl' not found". To use an installed OpenSSL
instead, set `OPENSSL_NO_VENDOR=1` plus `OPENSSL_DIR`, `OPENSSL_INCLUDE_DIR`
and `OPENSSL_LIB_DIR` pointing at it, for example in `cmd` after `vcvars64.bat`:

```bat
set "OPENSSL_NO_VENDOR=1"
set "OPENSSL_DIR=C:\Program Files\OpenSSL-Win64"
set "OPENSSL_INCLUDE_DIR=C:\Program Files\OpenSSL-Win64\include"
set "OPENSSL_LIB_DIR=C:\Program Files\OpenSSL-Win64\lib\VC\x64\MD"
```

Keep the quotes around each `set`, or `cmd` takes the space in `Program Files`
apart. Leave the Cargo feature as it is; these variables are a local override.

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
cd src-tauri && cargo build --profile release-local --bin octiq-server   # the backend
touch ~/.octiqflow/restart.request            # restart the backend (see below)
```

On macOS, `scripts/prune-target.sh` removes only own-crate Cargo caches older than 2 days,
including worktree targets; dependencies and top-level binaries stay. Install the daily 04:30 job once
from a real terminal at the repo root: `./scripts/install-prune-agent.sh` (undo: `--uninstall`).
Log: `~/.octiqflow/logs/prune-target.log`; preview: `./scripts/prune-target.sh --dry-run --worktrees`.

Local service builds use thin LTO and parallel codegen and produce
`src-tauri/target/release-local/octiq-server` (`.exe` on Windows). npm/CI
release binaries still use `cargo build --release` with full LTO.

The restart above is a touched file, not a script, and that is deliberate —
see the bullet below. The two installers are run **once**, from a real terminal,
and never again from inside an agent chat:

```bash
./scripts/install-service.sh                  # first install of the backend service
./scripts/install-restart-agent.sh            # first install of the restart helper
```

- **Releasing** is done by the `/release` skill, in a fixed order: every
  worktree and open PR merged into `develop` → tests and builds clean on Mac
  and the Windows box → version bump on `develop` → every platform built green
  on GitHub, then fast-forward `main` → remove merged worktrees and branches →
  build the client AND `octiq-server` locally → ask, then restart and verify
  the live build → push the tag to publish npm, last → close finished
  missions. A release is never `develop`-only or local-only. It never signs or
  notarizes.
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
  cargo test`. A test that needs disk takes `crate::test_dir::TestDir` (or
  `TestPath` for a file), never a name joined onto `std::env::temp_dir()`:
  the guard removes the folder on drop, panics included. Hand-made temp
  folders left tens of thousands of `octiq-*` entries in `$TMPDIR`. The
  profile folder is a scratch one under test too (`profile::started_in` for
  a test that needs its own; see **Persistence locations**). **So is the
  home folder**: under test `paths::home_dir()` answers one scratch folder
  for the test binary, never this machine's home. The suite used to rewrite
  `~/.octiqflow/mcp/*.cjs` (the scripts a live server on the same machine
  hands its agents) and append to `~/.octiqflow/logs/agent-diagnostics.jsonl`
  on every run, on every platform. Anything kept under the home folder asks
  `paths::home_dir()`; no module reads `HOME` or `USERPROFILE` to place a
  file (`paths::tests::only_this_module_says_where_the_home_folder_is`, with
  its allow-list and reasons), and a test that needs the machine's own home
  asks `paths::machines_home_dir` and says why. What this does not reach: a
  program a test starts reads the environment itself (`gh` writes its own
  `~/.local/state/gh/device-id`). To run
  several modules, put the filters after `--`:
  `cargo test --manifest-path src-tauri/Cargo.toml --lib -- feedback:: agent_provider:: permission::`.
  Before `--` cargo takes one positional filter and errors instead of testing.
- **Web tests**: `cd web && pnpm test` (vitest, node environment, no jsdom).
  These cover `web/src/lib/` pure logic — chiefly the `chat.ts` reducer,
  replayed against **real captured agent streams** in
  `web/src/lib/__fixtures__/*.jsonl`. Those fixtures are verbatim
  `claude -p --output-format stream-json` output; re-record them with the same
  flag set `build_command` uses (`agent_chat.rs`), never hand-edit them. A few
  component tests render through `react-dom/server`. `OCTIQ_EXHAUSTIVE=1 pnpm
  test` also runs the exhaustive walks (all 720 arrival orders in
  `turnClock.unread.test.tsx`); CI sets it, a local run takes a fixed sample.
  What to write is in **Which tests to write**.
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
  the Cloudflare Access hand-off (`/token` issues the token to nothing else),
  and the agent hooks, which take only a launch's capability (`hook_caller`).
  Treat changes here as sensitive.
- **`dispatch.rs`** is the single command table: a name plus JSON args in, a
  backend call out. **To add a backend command: write the fn in its module, then
  add a `"name" => …` arm to the `dispatch` match.** That is the only wiring
  step — there is no macro list any more.
- **`bus.rs`** is the event fan-out. Producers call `bus::emit`; it serializes
  once and broadcasts to every attached browser.
- **`access.rs`** verifies the JWT Cloudflare Access puts on a request. Empty
  config means off, and the token stays the only way in.

### Persistence locations

| Store | Path | Owner |
| --- | --- | --- |
| workspaces | profile dir (JSON) | `workspaces.rs` |
| server config (port, bind, token, Access) | `<profile dir>/web.json` | `web.rs` |
| personal preferences (end every chat's system prompt) | `<profile dir>/preferences.json` | `personal_preferences.rs` |
| chat transcripts | profile dir | `chat_index.rs`, `transcript.rs` |
| agent diagnostics | `~/.octiqflow/logs/agent-diagnostics.jsonl` (one rotated predecessor) | `diagnostics.rs` |
| worktree lifespan settings, pins, archives, sweep intents/history | `<profile dir>/worktree-lifespan.json` | `worktree_lifespan.rs` |
| chat task status | `<chats dir>/task-status.json` | `chat_task.rs` |
| registered agents (agents mode) | `<profile dir>/team.json` | `team.rs` — see `docs/agents-mode.md` |
| XP awards (agents mode) | `xp_awards` in `<profile dir>/orchestrations.json` | `orchestration/levels.rs` |
| agent token usage | `<chats dir>/agent-usage.json` | `agent_usage.rs` |
| long-running jobs (`octiq-job`, `job_register`) | `<chats dir>/jobs.json` | `chat_jobs.rs` — see `docs/jobs.md` |
| the `octiq-job` launcher agents run | `~/.octiqflow/bin/octiq-job` (`.cmd` beside it on Windows) | `chat_jobs.rs` |
| chat record compaction (size when last compacted) | `<chats dir>/.compacted-sizes-v2.json` | `record_trim.rs` |
| Antigravity plugin, settings backup | `~/.octiqflow/mcp/antigravity/` | `agent_provider.rs` |
| job spool folders (a sandboxed chat's `octiq-job`; never in the profile) | `$TMPDIR/octiqflow-job-spool-<uid>/` | `job_spool.rs` — see `docs/jobs.md` |

## Which tests to write

A suite is paid for in seconds and in edits: a plural-suffix change failed 66
web tests, and six tests were 18 of the 28 seconds of the web suite (hand
mutation sample of 2026-11-19, 125 mutations on five modules). A test earns its
place by what it catches. Six rules:

- **A test names the loss it prevents.** If the only honest description is
  "the code is still written this way", it is not written. Five run-panel
  mutations were caught only by a text scan, while a blocked Start that still
  sent was caught by nothing.
- **One fact, one owner.** A rule is tested where it is decided (the reducer
  or the function). Another surface gets one test showing it asks that
  function, not a re-proof of the rule; the same rule asserted on ten
  surfaces fails ten tests for one edit.
- **A control that starts, stops, approves or deletes gets a behaviour
  test that presses it and checks what is sent.** Use
  `web/src/lib/__fixtures__/pressTree.ts`, as
  `components/OrchestrationPanel.controls.test.tsx` does: it stubs React's
  hooks, calls the component function and calls the real `onClick` and
  `onKeyDown`. Effects do not run in it. A source-text scan is the last
  resort, for a rule no behaviour test can express (no second sender exists,
  a focus effect), and it never pins how many times a string appears in a
  file.
- **A sentence's wording is asserted once, where the sentence is built.**
  Other tests assert that the sentence is used, not what it says.
- **A matrix covers distinct cases.** An exhaustive walk of orders runs in CI
  only: `OCTIQ_EXHAUSTIVE=1` (`.github/workflows/test.yml` sets it). Locally
  `turnClock.unread.test.tsx` runs a fixed deterministic sample of the 720
  orders.
- **A boundary gets a test at the boundary** (exactly the limit, and one
  past it). A constant is not restated by a test: it fails only when someone
  changes it on purpose.

Not cut by any of this: Rust authority, durability and race tests (a trashed
chat counted as listed and a read mark that moved backwards were caught by no
Rust test, which is the gap to close, not to widen). Their setup may be shared
through builders (`agent_chat/test_support.rs` and the helpers beside each
test module); the assertions stay.

To check that a test earns its place, apply the mutation it exists for by
hand, see it fail, and revert. A test that no plausible mutation of its
subject fails is a candidate to remove. Say so in the change; do not delete
silently.

## Conventions & gotchas

Only the conventions that apply to nearly any change are here; the rest are in `docs/agents/conventions.md`.

- **Keep closing replies natural and concise.** Do not append `Task Completed`,
  `Task Not Completed`, or `— ready to ship` sign-offs. State any remaining work
  or blockers in plain language when relevant.
- **Code comments reference "card NN"** (e.g. "card 04 — Project mode"). The app
  was built in numbered work cards/phases; the numbers are historical context,
  not a live system.
- **Every process this backend spawns needs a Windows path.** The product runs
  on Windows, where `/bin/sh`, `/bin/zsh` and even `$SHELL` may none of them
  exist. A spawn site that assumes one fails at the worst possible moment: agent
  chats could not start at all on a clean Windows machine for exactly this
  reason, and the error it gave ("The system cannot find the path specified")
  named nothing anyone could act on. The three working patterns are
  `pty.rs::resolve_shell` (interactive terminals → PowerShell),
  `proc::resolve_agent_shell` (POSIX-quoted command lines → the bash Git for
  Windows ships) and `agents::probe_command` (`#[cfg(windows)]`). Prefer taking
  `is_windows` as a PARAMETER over `#[cfg(windows)]` wherever the logic can be
  pure — this is developed on macOS, so a `#[cfg]` branch is a branch nobody
  here can run a test against.
- **Hand a command line to the agent shell with `AgentShell::command`, never
  as a raw `-lc` argument.** Git Bash is an MSYS program: started by a native
  Windows process, it gets its arguments parsed a second time, which cuts one
  that needed quoting off at 8186 characters and halves every `\\` in it. A
  worker's system prompt is longer than that, so every worker launch on Windows
  died in bash on a missing closing quote while the same line ran on a Mac.
  `command` carries the line in an environment variable on Windows instead.
  The ceiling that remains is Windows' own 32,767 characters for the agent's
  command line, so a prompt that keeps growing belongs in a file.
- **The `src-tauri/` folder name is historical.** There is no Tauri in it. It
  was left alone so paths, the service plist and muscle memory keep working;
  renaming it is a separate job.

The module-by-module list of the backend is in `docs/agents/backend-modules.md`.

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

## Commands

Run everything from the repo root. **Rust + Node + pnpm are required.**

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
  cargo test`. A test that needs disk takes `crate::test_dir::TestDir` (or
  `TestPath` for a file), never a name joined onto `std::env::temp_dir()`:
  the guard removes the folder on drop, panics included. Hand-made temp
  folders left tens of thousands of `octiq-*` entries in `$TMPDIR`. The
  profile folder is a scratch one under test too (`profile::started_in` for
  a test that needs its own; see **Persistence locations**). To run
  several modules, put the filters after `--`:
  `cargo test --manifest-path src-tauri/Cargo.toml --lib -- feedback:: agent_provider:: permission::`.
  Before `--` cargo takes one positional filter and errors instead of testing.
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

### Backend modules (`src-tauri/src/`)

- `pty.rs` — multi-PTY sessions keyed by a **client-supplied String id**, plus
  OSC attention scanning (see Alerts). Shells are login shells (`$SHELL -l` on
  Unix, powershell on Windows; see `resolve_shell`) so `PATH` is fully
  populated — otherwise `claude` would not be found.
- `agent_chat.rs` — agents run as a JSON stream (`claude -p`, `codex exec`)
  rather than a TUI, for the chat view. All four providers are launched from
  ONE place here, through a POSIX shell, because `build_command` returns a
  POSIX-quoted line; `proc::resolve_agent_shell` picks that shell (Git for
  Windows' bash off Windows' own `PATH`). Each provider's command line and
  stream vocabulary live in `agent_provider.rs`, behind `provider_for`.
- Antigravity CLI (`agy --input-format stream-json --output-format
  stream-json`) keeps one process per chat like Claude: each turn is one NDJSON
  line on stdin, and `--conversation <id>` resumes a conversation in a new
  process. Its stdin takes no control message, so Stop ends the process and
  the next message resumes it (`interrupt_ends_process`). Its events carry an
  `event` field (`init` / `step_update` / `result`) no other provider writes;
  `result.usage` totals the whole conversation, so usage is read per model call
  off each `step_update` instead. Captured streams (agy 1.2.16) are
  `web/src/lib/__fixtures__/antigravity-*.jsonl`, shared by both test suites.
- **Antigravity cannot ask.** Headless, it refuses any call its mode would
  ask about, the refusal ends the turn, and the `result` lists it in
  `denied_actions`; nothing reaches the stream to put a card on. So Read is
  `--mode plan` (refuses even `ls` and any file write), Edits is `--mode
  accept-edits` (writes inside the project; refuses every shell command and any
  file read or write outside the project), and Auto and Full are
  `--dangerously-skip-permissions`.
  `--sandbox` was tried for Auto and refuses writes inside the project and
  git's read of `~/.gitconfig`, so Auto is unguarded and the UI says so. A
  refused turn is stamped `octiq_access`; the page fails the refused tool row
  (agy may report it as a silent success) and asks for the least level that
  lets it through — Accept edits for a project file write, Auto otherwise — on
  the access card (see **An agent asks for more access on a card**). The
  `result`'s `denied_actions` keeps every refusal of the conversation, so only
  the ones past the previous `result`'s count are this turn's. The plugin rules
  tell the model the level it runs at. PreToolUse hooks and workspace settings
  files cannot lift the refusal.
- **What OctiqFlow writes for Antigravity.** Its MCP server and host rules
  ride a plugin in a folder each launch adds with `--add-dir`:
  `~/.octiqflow/mcp/antigravity/<chat-<level>|worker-<level>|front-desk>/.agents/plugins/octiqflow/`
  (`mcp_config.json`, `rules/AGENTS.md`). The server inherits agy's
  environment, so it knows its chat. Antigravity names it `octiqflow_octiq`.
  One thing goes outside `~/.octiqflow`: the rule `mcp(octiqflow_octiq/*)` in
  `permissions.allow` of `~/.gemini/antigravity-cli/settings.json`, because a
  call through agy's generic `call_mcp_tool` is otherwise refused even in
  accept-edits, and only that file can allow it. It names a server that exists
  only in an OctiqFlow launch, so it allows nothing elsewhere. It is written
  once, order-preserving, after copying the file to
  `~/.octiqflow/mcp/antigravity/settings.json.before-octiqflow` (never
  overwritten); a failure shows in the chat and the chat still starts. To
  remove it, delete that one entry from `permissions.allow`; the next
  Antigravity chat adds it again. No `command(...)` rule is ever written.
- `workspaces.rs` — the "project" store (a project groups several folder paths).
- `git.rs` — the **single** git-read backend (status summary, changed files,
  file diff). Read-only; shells out to `git`. Resolves each project path to its
  repo top-level and de-dups so one repo shows once. `git_ops.rs` holds
  everything that MUTATES a repo, so "can this touch my repo?" is answered by
  the module name alone.
- `chat_task.rs` — where a chat is and what became of its work. See **A chat's
  status is half reported, half verified** below.
- `chat_recover.rs` — puts back, or replaces, the folder of a chat whose
  worktree was removed, before its agent starts. See **A chat whose folder was
  removed is recovered before it starts** below.
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
| personal preferences (end every chat's system prompt) | `<profile dir>/preferences.json` | `personal_preferences.rs` |
| chat transcripts | profile dir | `chat_index.rs`, `transcript.rs` |
| agent diagnostics | `~/.octiqflow/logs/agent-diagnostics.jsonl` (one rotated predecessor) | `diagnostics.rs` |
| chat task status | `<chats dir>/task-status.json` | `chat_task.rs` |
| a chat's plan (one file a chat) | `<chats dir>/plan_<chat id>.json` | `chat_plan.rs` |
| registered agents (agents mode) | `<profile dir>/team.json` | `team.rs` — see `docs/agents-mode.md` |
| XP awards (agents mode) | `xp_awards` in `<profile dir>/orchestrations.json` | `orchestration/levels.rs` |
| agent token usage | `<chats dir>/agent-usage.json` | `agent_usage.rs` |
| chat record compaction (size when last compacted) | `<chats dir>/.compacted-sizes-v1.json` | `record_trim.rs` |
| Antigravity plugin, settings backup | `~/.octiqflow/mcp/antigravity/` | `agent_provider.rs` |

`profile.rs` decides the profile dir; `profile_lock.rs` makes sure only one
process owns a profile at a time (a second one refuses to start rather than
overwrite the first's project list).

**The profile dir is fixed when the server starts.** `profile::pin` is the
first thing `run_headless` does: `<base>/<active>/` is resolved once from
`~/.octiqflow/config.json`, and `profile::profile_dir` answers that one path
until the process exits. It makes nothing and looks nothing up again.

- **The fallback is at startup only.** A configured base that cannot be made
  then gives way to `~/.octiqflow/profiles`, as before, and the server says
  so: on its log line, and in `profile_status`'s `fallbackFrom` and `notice`.
  It stays on that folder when the configured one comes back; only a restart
  looks again.
- **A folder that goes away under a running server is an error, never
  another folder.** `profile::available` answers why in words (`The profile
  folder … is not available right now: … OctiqFlow keeps to the folder it
  started with and has not switched to another, so nothing was saved. …`).
  `chat_send`, `chat_start`, `chat_complete` and `chat_index_list` answer
  with it first, and no agent is started on a turn whose record cannot be
  kept. When the folder is back the same calls go through; nothing is
  restarted. What ran meanwhile: a turn already in flight goes on streaming
  to the page and its lines are not recorded.
- **Nothing the host does makes the profile folder after startup.** Folders
  are made through one door, `profile::create_dir_all` (`make_dir` is the
  same, in words). For a path in the profile it makes only what is BELOW
  the profile folder, one `create_dir` each from the profile folder down,
  so a profile that is gone fails in the filesystem whenever it went. A
  look followed by a create was tried and was the hole: the folder went
  between the two and came back empty, and a chat's next line became line
  2 of a record whose line 1 was in the folder that moved. **No module
  calls the standard library's `create_dir_all` or `create_dir`**; a
  source scan fails the suite
  (`profile::tests::no_module_makes_a_folder_but_through_the_profile`,
  whose allow-list is `profile.rs` itself and the standalone `bin/octiq.rs`,
  each with its reason). Whether a path can lie in the profile is not for
  the caller to judge: a vault, a worktree or `~/.octiqflow/mcp` is inside
  it when the profile base is set that way. A script the host starts keeps
  the same rule (`scripts/mcp/preview.cjs` makes `previews/<chat>` and no
  parent of it).
- **The folder a server started with is that directory, not whatever is at
  its path.** A path still answers after its folder is removed and another
  is made there, or after it is pointed somewhere else. So a process leaves
  a mark in the folder it takes: a word made up for the run, on the owner
  lock's line (`pid kind mark`). It is left by the first question a process
  asks of the profile (`profile::started`, which `pin` reaches first), so
  the guarantee does not wait on the owner lock; `profile_lock::acquire`
  writes the line again with the process's kind. A lock another live
  process holds is never written over: that process keeps its mark, and
  the one being refused knows the folder by its path alone for the moment
  it has left. Every "is the profile there" is `Pinned::missing`: the
  folder at the path holds this run's mark, or it is *gone* (the sentence
  above) or *replaced* (`… is not the folder OctiqFlow started with: … has
  not written into it, so nothing was saved. Put the original folder back
  …, or restart OctiqFlow to use the folder that is there now.`). A new
  question about the folder asks `profile::available`, never `is_dir` or
  `exists` on the path.
  - A replaced folder gets nothing: no folder made in it, no store saved,
    no line appended, no hook run from it. A second server that starts in
    a folder made at the path writes its own mark, and the first reads
    that it is no longer in its folder and stops writing.
  - `transcript::chats_dir` asks on every call, so a record's count,
    generation and resolved folder name are never used against a folder
    that only shares the path, and `confirm_synced` asks again after the
    sync: a token is confirmed only in the directory it was made for.
  - Why a mark and not the platform's file identity: device and inode
    numbers change on a remount and are reused by some filesystems, a held
    handle blocks an eject and dies with the drive, and stable Rust cannot
    ask Windows for a directory's identity. The mark is one question with
    one answer on macOS, Linux and Windows.
  - What it cannot tell: a copy of the folder, lock and all, made while
    this process runs and put at the same path, is the folder. A lock that
    is deleted by hand reads as replaced until a restart. A profile folder
    that could not be written at startup has no mark and is known by its
    path alone, which the server says on its log.
- **A read from a profile that is gone is an error, never a first run's
  value.** "No file" in a profile that is there is the store's default; "no
  file" because the folder is away says nothing about what is saved. Read
  as a default, Settings drew a blank form over the person's saved rules
  and an ordinary Save wrote the blank form's text over them once the
  folder was back. A store that reads its file per call reads it with
  `profile::read`, which answers the bytes, `None` for no file in a
  profile that is there, or the profile's sentence (asked after the read,
  never wrapped in the store's own words): preferences, the roster,
  handovers, the vault's settings and receipts, safety authorizations,
  feedback, sandbox state, PR workflows, chat task status, the memory
  activity ledger. What answers the page from a record or the index asks
  `profile::available` first (`chat_since`, `chat_page`,
  `chat_index_deleted`, `image_preview_list`, `chat_search`). A store kept
  in memory (ledger, projects, questions, usage, background tasks,
  auto-resumes) goes on answering and never reloads while the server
  runs: its save fails in the profile's words and, once the folder is
  back, writes what it holds. **There is no global guard in front of
  every command**: Stop, interrupt and the answer to a card work while the
  folder is away, whatever they would have saved (Conventions, *An action
  that ends work or answers a waiting agent never waits on a save*). A page that loads a whole value into a form and saves it
  back offers no Save when the load failed (`unread` on
  `PreferencesBlock` and `AgentPolicyBlock`; the vault form is not drawn).
- **A new store reads `profile::profile_dir()`, makes folders with
  `profile::make_dir` before every write, and reads its file with
  `profile::read`.** Never `create_dir_all` on any path, never
  `NotFound => default` on a path in the profile, never the config read
  again, never a base worked out by the module.
- **In tests `profile_dir()` is a scratch profile**, one `TestDir` shared by
  the test binary and never this machine's own. A test that needs a profile
  to itself (it takes the folder away, or runs something that sweeps the
  chats folder, as `chat_index::reconcile` does) stands its thread in one
  with `profile::started_in(home)`, which resolves from the config under
  that home exactly as the server does, and takes the folder (leaves its
  mark) on its first question, as `run_headless` does. A second thread
  started in the same home is a second server: it takes the folder from
  the first. `profile::tests::Home` takes the folder away three ways:
  `unplug` (a file where its drive was), `move_away` (nothing left at the
  path, so anything that makes a folder and its parents would remake it)
  and `replace` (another folder at the path); `everything_in(dir)` is what
  a test compares to show nothing was written.

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

### A chat's plan

A chat keeps one plan (`chat_plan.rs`, `docs/chat-plan.md`): the list the
person and the agent agree on before work starts. It is not the
orchestration plan card, which approves a run's tasks and still has to be
approved after Start. Three owners, and nothing crosses between them:

- **The agent writes the list** with `plan_read` and `plan_update`
  (`octiq-ask.cjs` → `POST /hook/plan`): items with a status (`discussing`,
  `decided`, `in_progress`, `done`, `dropped`), decisions, open questions, a
  note and the task ids an item became. A change patches items by id and
  carries the revision it was based on; a stale one is refused whole.
  **Nothing is removed**: the person can only read the list, so an item
  leaves by `dropped` and stays on it. Ids are the host's (`i1`, `i2`).
- **The person starts it.** `chat_plan_start` is the page's command and
  nobody else's: no hook routes to it and the MCP server has no such tool,
  the same way `chat_complete` has none (`plan_tests::
  no_hook_and_no_mcp_tool_can_start_a_plan`).
- **The host counts the work.** An item's `progress` and `linked` are read
  from the ledger for each answer (`orchestration/plan_link.rs`), never
  stored and never taken from the agent. An item's own `in_progress` or
  `done` is the agent's word and is shown as that; the two can disagree.

Four rules hold:

- **The Start gate is on the agent's door, not the person's.** While a plan
  is not started and has an item that is not dropped (`Plan::awaits_start`),
  `/hook/orchestration` refuses that chat's agent the commands in
  `web::PLAN_GATED_COMMANDS`: run_create, task_create, the coordinator's
  worker_start, dispatch_ready and task_reopen. The socket's commands of the
  same names are the person's own and are not asked. A chat with no plan is
  never asked anything. A new command that starts orchestrated work for an
  agent joins that list. Once started a plan never gates again.
- **A plan that cannot be read holds the gate.** A profile folder that is
  away, or a file that cannot be understood, is an error from `chat_plan::
  gate`, never "no plan": that would lift the gate, and the next change
  would start the list again from nothing.
- **Start is save-first, and the Start is not the turn.** It is recorded,
  then the agent is handed one turn in the host's words (`start_message`,
  turn id `octiq-plan-start-…`, queued behind a running turn like any
  message, or the first message of a chat with no process, through
  `start_chat`). A Start that cannot be saved is refused whole and tells
  the agent nothing. A turn that cannot be handed over leaves the Start
  standing: the answer says `delivered: false` with the reason, never an
  error, `started.told` stays false, and the page asks again with the same
  command. The host does not retry by itself.
- **One Start, one turn, however often and from however many tabs it is
  asked.** When and on which revision a plan was started is recorded once
  and never touched again. The turn is handed over once, and two things
  hold that (review of 16e4188, H2: every ask made a fresh turn id, so two
  asks at once queued two turns, and so did an ask after a `told` that
  failed to save):
  - *a claim* (`chat_plan::telling`, one per chat): held from reading
    whether the agent was told to noting that it was, so two asks are one
    after the other and the second finds what the first did. Taking the
    Start's turn back from the queue holds it too. It is taken before any
    lock of the chats', and nothing that holds one of those asks for it.
  - *a receipt that is not the note.* `started.told` is a note, and a note
    can fail to save. The receipt is the turn's own line in the chat's
    record, under an id that is the Start's: `started.turn_id` is made with
    the Start, and every try is under it or one counted on from it
    (`next_turn_id`: `…`, `…-try2`). Each ask of a started plan reads what
    became of those turns (`agent_chat::host_turns`) before it sends: no
    line, and the turn is handed over under the same id; handed over, and
    nothing is sent and a missing note is saved; gone, and the next try has
    the next id.
  - **A turn that is gone is told again, and that is how it differs from
    one that was delivered**: the person took it back (✕), it was marked not
    sent, or its last word is `queued` and no queue holds it (the queue is
    in memory: a server queued it and stopped). Each is a line the host
    already wrote. A turn written to the agent has `dispatched` after
    `queued` and is never gone; `unknown` (its process ended before saying
    it had the prompt) counts as handed over, so the host never sends it a
    second time. The ✕ sets `told` back to false so the page offers `Tell
    the agent`; the other two leave it true until the next ask, which reads
    the record whatever the note says.
  - A new thing the host tells an agent ONCE asks `host_turns` under an id
    that is a function of what it tells of, the same way. A fresh id for
    each try, and a flag for "was it told", is the shape that failed.
- **Only the chat's own agent writes.** `/hook/plan` keeps the `HookCaller`
  and refuses a front desk, a room seat (`session_key != chat_key`; a seat
  may read) and a worker by `is_worker_chat`, which still holds after its
  attempt settled. The socket refuses `chat_plan_update`.

What the gate cannot do is said in the docs and in the tool description:
it covers work started through the host, not an agent editing files in its
own chat. The peer tools and the host's scheduler for a run that existed
before the plan are not gated either.

Agents are told how to keep a plan in the two tools' descriptions, and when
to keep one in a single sentence (`PLAN_PROMPT` in `agent_provider.rs`, word
for word `PLAN_INSTRUCTIONS` in the script; a test on each side). Like the
card diagram it rides no command line. **The MCP server's instructions stay
under 4,096 characters, and so does every tool's description**
(`scripts/mcp/instructions.test.cjs`, for each kind of chat): Claude Code
drops what is past that without a word, and at 5,658 the end of
read_conversation, the orchestration and peer sentences, task_status and the
ask_user sentence never reached a Claude chat. What belongs to one tool
goes in that tool's description. That is room of its own, not a place the
limit does not reach: Claude Code applies the same limit to each upfront
tool description (the longest is 2,008 today), so a description that keeps
growing is cut like the instructions were.

A plan follows the chat's task status when the chat goes: kept through the
trash window, removed when the chat is purged, kept by `/clear`.

### The Plan panel is where the person reads a plan and starts it

`components/PlanPanel` draws the chat's plan; `lib/planView` says what each
part says, and `lib/useChatPlan` keeps it in step with the host. The panel is
read-only but for Start: no edit, reorder or delete. The person changes a
plan by saying so in the chat.

- **It is hosted like the git and files columns**: a column beside the chat
  on a desktop (`octiq.v2.planColumn`, written through `lib/remember`), an
  alternative to those two and never a third beside them, giving way to the
  preview panel as they do. On a phone it is a page drawn in the chat's
  place (`planInPlace`, part of `chatShown`), for the one chat it was opened
  in and never remembered. Its button is one line of `barActions` (`Plan`,
  after `Tasks`) and carries the open questions in `--decide`, and nothing
  when there are none.
- **Offered to a chat's own agent only** (`planView.planOffered`, asked of
  `chatKindOf`): not a worker's chat, a front desk or a seat. The button,
  the panel and every read hang on `App`'s one `planFor`.
- **Nothing polls.** `chat_plan_get` when the chat opens, when the panel
  opens and on each connect, then the `chat-plan` event. That event does not
  fire when the ledger moves, so a plan that links tasks is read again when
  what the ledger says of those tasks changes (`planView.ledgerSignature`),
  and at no other tick. A read that was in the air when an event arrived
  cannot put the older plan back (`reducePlans`, by `rev`), and a Start's
  answer that arrives after the events that followed it changes nothing.
- **Three owners, each drawn as what it is.** The item's status word is the
  agent's. `progress` and `linked` are the host's: absent draws nothing,
  never a zero. Where they disagree both are shown and the agent's word
  colours nothing: `Done` beside `1/2 · 1 failed` is grey
  (`planView.countAgrees`).
- **Colour is state.** The accent is an item with a linked task whose
  attempt is executing, asked of the run panel's own reader
  (`tasksInFlight` → `runProgress.progressRow`'s `flight`), never of the
  host's `running`, which also counts an attempt being prepared. `--ok` is
  done, `--decide` a question still open and Start, `--warn` a plan that
  could not be read. A linked task that failed is said in grey words: whose
  move a failure is, is the run panel's to show, and the task's row there
  is one press away (`showTaskRow`, the run panel's `focusTaskId`).
- **What the agent wrote is text**: a title, a decision, a question and a
  note are never markdown, a link or markup. Three decisions are shown and
  the rest are behind a line that says how many; a note is behind its own
  disclosure; dropped items are last, muted.
- **Start is the host's to offer** (`planView.planStart`): drawn while
  `awaitsStart` is true and never worked out from the items. It sends
  `chat_plan_start` with the revision on screen and the settings a
  completion would start the chat with (`startSettingsOf`), from the one
  place that names the command (`useChatPlan`). Open questions are said
  beside it and do not block. A refusal recorded nothing: the host's words
  go under the button, which stays. `delivered: false` is a Start that IS
  recorded with an agent that was not told: both halves are said apart
  (`Started 18:06 · the agent has not been told yet`), the reason is behind
  a disclosure, and the one control is `Tell the agent`, the same command
  again. A plan whose items were all dropped says `Nothing to start`. There
  is no un-start.
- **Start is never fired by the press or key that brought it on screen**,
  and has no confirm in front of it, like the page's other Starts. The
  bar's button and every disclosure of the panel are remembered by the
  cards' guard (`notePress`), Start drops a held key (`dropHeld`) and a
  press that repeats the one the panel was opened with (`strayAnswer`), and
  it is off from the press until its answer, so two Start turns are never
  sent. It sits outside the panel's scroller, so nothing an item opens
  moves it.
- **The host's turn is named, not quoted** (`lib/planTurn`): a turn whose id
  starts `octiq-plan-start-` is drawn as `Plan started` with the host's text
  behind a disclosure, like a completion's wrap-up. Its take-back says
  Cancel, takes the turn back and never the Start, and returns nothing to
  the composer (`reclaim` skips it).
- `scripts/test-plan-panel.mjs` draws the host's four plans in the real App
  at 1280 and 390 and presses Start. `lib/decideColour.test.ts` names the
  panel's parts (`PLAN_PARTS`): a part added to the sheet is added there.

### A chat whose folder was removed is recovered before it starts

A chat remembers the exact folder it ran in, and a task chat's is a linked
worktree that gets removed once its work is merged. The chat outlives it, so
`chat_start` goes through `chat_recover.rs` first, and only when the folder is
missing. The order:

1. **Rebuild the worktree at the SAME path** (`git_ops::restore_worktree`):
   from its branch when the branch still exists, else by making the branch
   again at the commit remembered for it (`Delivery.head`). What the worktree
   was comes from git's own `worktree list` (a folder deleted by hand is still
   listed until the next prune) and from the last `chat_task` verification,
   because either can be the one that survived. The same path keeps the chat's
   sandbox, which is bound to its folder, and the agent's own session folder.
2. **Else move the chat to a folder that exists**: the worktree's root when
   only a subfolder went and git still calls it that checkout, the
   repository's primary checkout as `chat_task` last verified it, then a
   folder registered for the chat's project.
   `chat_index::set_cwd` records it, and a Claude session is hard-linked into
   the new folder's `~/.claude/projects/<encoded cwd>/`
   (`carry_claude_session`). Claude Code 2.1.292 resumes by id from any
   folder, so that link is for older CLIs; Codex resumes by id regardless.
3. **Else say why** in words: `The chat's folder … was removed and could not
   be restored: …`, which the page shows under the unsent message.

- **It is refused before it changes anything** (`recover_from`). A chat that
  already has a process answers `already running`, the words the page falls
  back to sending on. A worker's chat, and a folder a task holds on a lease,
  is preparing or is cleaning up, are refused by
  `require_no_owner_of_removed`. What passed is then held until the chat has
  been started (`chat_recover::Held`): the workspace lifecycle lock, so no
  worker is handed the checkout and no cleanup begins, and a claim on the chat
  (`ChatManager::claim_start`), which makes `start_session` refuse every
  other start of it. Two tabs sending at once rebuild the worktree once.
- **A chat is moved only to a folder the host can vouch for**
  (`Remembered::vouched`): the recorded primary checkout, or a folder
  registered for the project its index entry names. The page's `fallbackCwd`
  and the planned folder only choose among those and add none. A filesystem
  root and the home folder are never moved into (`too_broad`), registered or
  not.
- **A folder that was a worktree's root is gone to only while git still calls
  it that repository's checkout, whichever list offers it** (`Former`,
  `still_checkout_of`). Three places say a folder was one: the worktree the
  missing folder was found in, the last `chat_task` verification
  (`is_worktree`), and git's `worktree list` for every vouched repository. A
  plain folder made where such a worktree was removed is a directory and
  nothing more, and the project registering it, or a folder inside it, does
  not bring it back: it is passed over for the next safe folder, and with
  none left the error says it `is no longer a checkout of the repository it
  belonged to`. A registered folder that never was a worktree needs no Git
  history. A folder that still exists never reaches recovery at all, so this
  is asked only of where a chat is being MOVED.
- **Nothing is overwritten.** A path that exists is never rebuilt over, and
  git refuses a branch another worktree holds, which falls through to step 2.
  Uncommitted and untracked files in the removed folder are gone, and both
  notices and the banner say so.
- **Sandbox ownership is unchanged.** `sandbox::Store::select` still runs,
  after the recovery, with the recovered folder. A chat that had to move with
  an enabled sandbox is refused as before ("belongs to a different folder").
- **It is told twice, once each.** `Held::settle` runs after those
  refusals and is a method of what is held, so it cannot run outside it: a durable `octiq_chat_recovered` event
  draws a notice in the chat and moves the page's `cwd`, and the agent's next
  prompt carries a one-line note (`chat_recover::with_note`, taken in
  `start_session`) that stays out of the person's bubble.
- **Before any of that, the page says it is coming.** `RemovedFolderBanner`
  reads `chat_task`'s `workspace.exists` and shows one row above the
  composer (`removedFolderNote`). Folded it is a label and what the next
  message does, a few words each with a folder by its last name (`Worktree
  removed · next message rebuilds it from its branch`, `Folder removed ·
  next message moves this chat to <folder>`, on a POSIX or a Windows path).
  The whole path and the whole sentences (uncommitted and untracked files
  are not restored; where it falls back to) are behind the row's own
  disclosure, which is the row: a button, never a tooltip alone. It never
  blocks a send.
- Only `chat_start` recovers. Auto-resume, restart and a queued Codex turn
  reuse the remembered start context and are not covered.

### An agent asks for more access on a card

`request_access` (`octiq-ask.cjs` → `POST /hook/access` → `access_request.rs`)
puts a card in the chat its capability proves: the level now, the level asked
for, and why. **The call changes nothing.** The card's Upgrade sends the page's
own `chat_set_access` — the access picker's command, which no hook reaches —
and only after it worked does the page answer `access_request_answer`; the
host then reads the chat's level back from its start context and tells the
agent that, not the page's word. Workers, front desks and room seats are
refused: a worker's level comes with its task.

When a raise takes hold is the provider's (`access_request::Takes`): Claude
mid-turn (a control request), Codex app-server and command-line providers from
the next turn, Antigravity only between turns — so its call does not wait; the
card stays up and the agent is told to end its turn. Claude waits as long as a
permission card, Codex 50 s (its MCP call times out near 60). An Antigravity
refusal asks on this same card, drawn from `ChatState.accessNeed`.

**A raise is recorded before it is made, and one that cannot be recorded
changes nothing.** `chat_set_access` asks which way the level moves
(`access_request::rank`). A raise is written down first (the ledger's resume
settings, for a chat a run knows) and refused while that cannot be done, in
words that begin with `agent_chat::NOT_RAISED`; the agent is told nothing. The
page knows the refusal by those words (`lib/accessRaise`, whose test reads the
host's constant): the card that asked stays up with the reason and is not
answered, so a waiting agent goes on waiting, and the access picker goes back
to the level the chat still runs at instead of restarting the agent, which is
what it does for every other refusal. A lowering takes hold at once and is
written when it can be (see **Conventions**, rule C).

**A chat's level is its own, and the product never narrows it.** A chat opened
for a registered agent (a route, a handover, a conversation the person starts
with it) opens on that agent's registered settings, and nothing in the host,
the MCP server or the page opens, re-sends or switches a chat to read-only on
the product's own initiative: a route's `purpose: "discuss"` is wording only.
After that the chat keeps the level it has. The page sends the level it holds
and works nothing out; no host rule raises a chat at a start, and there is no
level event. Three ways of making an agent's chat follow its registration
afterwards were built, failed review and are not here: a rule on the page (it
does not reliably know the roster or what is running when it must decide), a
level event from the host to the page (an unordered frame overwrote a level
the person had just picked), and the host as the only writer of the chat's
saved level (it dropped a level picked on the access picker, which is drawn
for an agent's chat whenever agents mode is off). Chats an earlier build
opened as read-only discussions are lifted to their agent's registered level
once, at startup; that pass, its limits and what is still open are in
`docs/agents-mode.md`.

### An auto-mode refusal the agent carries on past is a notice, not a card

Claude's auto mode refuses a call mid-turn and the agent usually goes on
another way, so the page says it the way Claude Code's own terminal does
(`lib/safetyToast`): a short notice over the foot of the transcript
(`SafetyToast`, about five seconds, held under the pointer or keyboard focus,
one notice counting several refusals), and one folded line at the end of the
transcript that opens to the same card with the same two answers
(`SafetyBlock` with `folded`). Nothing on the host changed: the record, its
pending key and what the buttons send are the card's.

- **What splits them is whether the turn is still running** (`splitSafety`).
  A judged refusal folds only while `chat.busy`; once the turn is over with it
  still unanswered, the agent has stopped and it is the full card above the
  prompt box again. The record carries no time and no tool-use id, so "the
  agent went on and finished anyway" cannot be told from "it stopped on this".
- **An outage card and a Codex block never fold.** Both offer something only
  the person can choose (a retry, an approval).
- **Only a live `safety-blocked` event raises the notice.** The list read on
  connect or on reopening a chat (`safety_block_pending`) never does, and
  leaving the chat drops it.
- **The card stays amber; the answer it leads with does not.** A refusal is
  a warning, so a safety card keeps `--warn`. Its primary button ("Keep it
  local", "Use safer approach") is a decision, and is drawn in `--decide`
  like every card that asks: never the accent, which the composer rebinds to
  the model's colour and which came up gold under Claude
  (`lib/decideColour.test.ts`).

### The agent's questions are drawn where they were asked

An `ask_user` question is not a card above the composer. It is drawn in the
transcript, at the call that asked it (`components/InlineQuestions`,
`lib/questionBlock`), with no card round it: each question a heading line,
its options radio rows (checkbox rows when `multiple`), an option's
description under its label, a quiet `Recommended` in words, and one
full-width button in `--decide`. Every question of one call is one block
with one button. The host's contract is what it was: `question_pending`,
the `user-question` events, `question_answer_batch`, `question_cancel`,
`question_retry`.

- **Where a block goes is worked out from the words** (`placeQuestions`).
  The host's record carries no tool-use id, so a pending batch finds its
  call by the questions it asked, in order, among the calls that carry no
  answer yet. A batch whose call the page does not draw (asked before the
  turns it holds, behind `Load earlier messages`, a subagent's call, a
  provider with no such call such as Codex's native question) is drawn at
  the end of the transcript. Asked of the turns actually drawn, so a
  question is never placed where it cannot be seen.
- **It is drawn only where the person can answer** (`ChatQuestionsContext`,
  which `App` provides for a chat that is not a worker's). A worker asks
  through a gate (`route_worker_questions`): the host makes no question
  record for it and no page ever drew one, so in a worker's chat, the task
  chat beside a run and a subagent's view the call keeps its tool row.
- **The recommended option is selected when the block arrives**, and a
  question with none starts with nothing selected (`startPick`). Only the
  person's press sends it. The button stays off (`aria-disabled`, never
  removed from the keyboard) until every question has an answer, and the
  reason is in words under it (`submitReason`), where it moves nothing.
  `Other…` is the last row of every question with options and shows its
  text box under itself; a question with no options shows the box directly.
- **It is never answered by the press or the key that was already going
  on.** It arrives under the pointer with an answer already selected, so:
  it never takes the focus (no `autoFocus`; the composer keeps it), the
  button and Dismiss drop a key held down (`dropHeld`), and both drop a
  pointer press that repeats the one made before the block was there
  (`lastPointerPress` as the block mounts, `strayAnswer`). A new control
  that answers takes the same two.
- **Answered, it is a quiet line and the person's bubble** (`AnswerBubble`):
  the bare answer for one question, the question and its answer for
  several. The bubble is drawn from what the host holds, never from what
  the page remembers, so a reload and a second tab draw the same: the
  question's record while the host lists it, the call's result once it has
  one (`lib/askAnswer`), or the host's own turn when the answer came after
  the call had ended. That turn (`octiq-question-<record>`,
  `isAnswerTurn`, `answerTurn`) is drawn as the bubble and not as the
  host's words, where it stands in the conversation.
- **The bubble is not a message.** No edit, retry, take-back or copy on it,
  no point on the conversation map, not grouped as a turn, and never
  returned to the composer (`reclaim` skips an answer turn).
- **The half-states keep their own words** (`answeredNote`): `Answers saved
  · waiting for the agent` only for what is on disk, `Answers sent · not
  saved` with the host's reason behind a disclosure, `Answers need
  attention` with `Retry delivery`. `Cancel pending delivery` and `Dismiss
  without answering` are `question_cancel`.
- **Out of view, one row above the composer says so** (`lib/questionSight`,
  `QuestionWaitingRow`): `1 question waiting`, while a block that still asks
  is not on screen, and not while it is. One `IntersectionObserver`, no
  scroll listener. Pressing the row goes to the block and puts the keyboard
  on its first control; it presses nothing.
- **Nothing else reads a question differently.** The sidebar's badge,
  `pendingActions.heldCards`, `lib/runWaits` and `lib/chatWait` go on
  reading it as a held card from the page's one list; the block carries the
  same `data-pending-keys` the card did. Do not add a second reader.

### A reply can hold a card diagram

A fenced code block whose info string is `octiq-diagram` is drawn as a
diagram of framed cards (`lib/cardDiagram`, `components/CardDiagram`). Its
body is JSON, `{ "rows": [ [ { "title", "note"?, "icon"?, "plain"? } ] ] }`:
rows run top to bottom with an arrow between them, the nodes of a row sit
side by side at equal widths and stack under about 480px of the diagram's
own width (a container query, so a transcript beside a run panel stacks
too), and `plain` draws a node without a frame. Limits: 8 rows, 4 nodes a
row, title 60 characters, note 120. Icons are a fixed set of 24 names
(`DIAGRAM_ICONS`); an unknown name draws none.

- **Only a block that is closed, parses and validates is drawn**
  (`diagramBlock`, `parseDiagram`). Anything else is the ordinary code
  block: not JSON, a wrong type, over a limit, a block the reply ended
  without closing. Nothing is repaired and nothing is cut to fit. A block
  longer than any diagram can be is refused before it is parsed.
- **Strings are text.** The validator hands back strings and the renderer
  draws them as text; nothing of a diagram is ever set as HTML.
- **While it is being written it is one quiet line**, over the rows written
  so far drawn unseen (`partialRows`, `DiagramPending`), so the block is
  already as tall as the diagram will be and nothing below moves when its
  fence closes. Counted by the node, because the last row closes in the
  same few characters as the fence.
- **It has no colour of its own**: the border token on the card background,
  no shadow, nothing behind the words. It is a list to a screen reader,
  labelled with its titles in order.
- **Agents are told in one paragraph, and never on a command line**
  (`DIAGRAM_PROMPT` in `agent_provider.rs`, word for word
  `DIAGRAM_INSTRUCTIONS` in `scripts/mcp/octiq-ask.cjs`; a test on each
  side and `cardDiagram.test.ts` hold the three together). Claude reads it
  from the MCP server's instructions, over stdio, where it is the FIRST
  thing: Claude Code keeps only the first 4,096 characters of a server's
  instructions (seen in a live chat on 2026-10-13, cut mid-word there), and
  those were already 4,946 long. The whole text is held under that mark
  now (see **A chat's plan**). Codex's app-server reads it
  in its developer instructions (a message on stdin), Antigravity in the
  plugin's rules file. `codex exec` takes its instructions as an argument
  and Pi has no host rules, so neither is told. A front desk is not told.

### A card that waits on the person arrives folded

Folded, a decision card is the ask, its short facts and the buttons. What is
short is `web/src/lib/cardFold.ts`'s to say (one line of about 60 characters,
or a move whose two sides both are); everything longer is behind the card's
ONE disclosure (`components/CardFold`). It applies to the permission card
(tool calls and roster or policy changes), the access request, the handover
and route cards, and the plan card in the lead's chat (`PlanReview` with
`folds`; the run panel draws the plan out). The safety cards have their own
folded line and are not part of this.

- **Folding is never hiding.** A folded part keeps its label on the card with
  its size and, for a change, the fact that it changes and the size of both
  sides: `Role · changed · 2 lines → 4 lines`, `Persistent prompt · cleared ·
  was 8,000 characters`, `6 more lines`, `+7 −2 in chat.ts`, `Brief · 8
  lines`, `3 tasks in 2 stages`. The tool, the path, a warning, the countdown
  and the buttons are never folded. Sizes are Unicode characters
  (`cardFold.chars`), never UTF-16 units.
- **What stays of a folded part is never a piece of it.** Not its first line,
  not its last sixty characters: a slice reads as the fact and is only where
  the text happened to start or end. A long row shows its label, whether it
  changes and its size, or the host's own `summary` for it (optional, on a
  stated value only, one line, at most 160 characters, validated in
  `askDetail.rowSummary`; an invalid one is dropped and the rows are kept; on
  a move it is an unknown key like any other). The rows `Head` and `Front
  desk` (`team_tools::delete_facts`) are sentences drawn whole up to 160
  characters, and so are a team card's `Membership` (the one fixed sentence
  of what teammates may do with each other, which is what is approved) and
  `Other teams` (who leaves which team by joining this one;
  `team_tools::team_rows`); `cardFold.STRUCTURAL` holds those labels and
  `cardFold.test.ts` reads `team_tools.rs` to check them. A change of more
  than 50 rows
  (`askDetail.MAX_ROWS`; the host sends about a dozen) is shown as the host's
  text instead, folded like an older host's.
- **A command is what is being approved, not detail.** `command`, `script`
  and `code` (`askDetail.isCommand`) are on the folded card whole, up to
  twelve lines and 1,200 characters, no line cut and no scroll of their own.
  Over several lines the title is the tool and `N-line script`, and on one
  line the folded card cannot draw, the tool and `N-character command`
  (`cardFold.commandTitle`): never the first command, for an MCP tool too.
  Past that the card shows the leading whole lines, says `N more lines not
  shown` at full strength as the last thing above the buttons, and holds
  Allow once and Always (`aria-disabled`, pointing at the visible sentence
  `Open the full command to allow it`). Deny always answers. A diff keeps
  its `+a −b` line, and prose (a plan, an older host's change) its first line
  and size.
- **Allow is asked of what is drawn, never of what was pressed.** The card
  draws the two texts `cardFold.commandShown` returns and nothing else of a
  command; `cardFold.notShown` compares them with the command, and
  `allowHeld` lets go only when nothing is unshown now, or when this exact
  command was drawn whole on this card before. An opening that drew less
  than all of it (a cap, a bug) leaves Allow held. The control says `Open
  the full command` only where opening is the whole command
  (`commandOpens`).
- **"Shown whole" is said of a text, not of an ask.** What the card keeps
  after drawing every character of a command is that command
  (`cardFold.CommandAsked`: the ask id, the tool, the argument's name and the
  exact string the host sent), set by `drawnWhole` after the draw and
  compared with the one on the card at every draw (`sameCommand`). So the
  same command opened and folded again keeps its Allow, and an ask whose
  command changed under the same id, by one character, is unread and held:
  `PendingRequests.add` replaces an item under its id, and the page does not
  lean on the host never doing so. The fold itself is still the id's: a card
  left open draws a replaced command whole, and Allow is then asked of that
  drawing. No other card's approval waits on something having been opened.
- **A command is never missing a character, and one that cannot be seen is
  drawn as its code.** Its lines are `cardFold.commandLines`: only a line
  with nothing on it, or spaces and tabs, is left out before the first line
  and after the last. A line holding a no-break space or a carriage return
  is a word to a shell and is drawn and counted (JavaScript's `trim` calls
  it blank). In a command, script or code block the characters that draw
  nothing or turn the reading order round are drawn where they stand as
  `\u{202E}`, set apart as a mark (`cardFold.commandDrawn`): the control
  characters U+0000 to U+001F and U+007F, but for the tab, the line feed and
  a carriage return that a line feed follows; then U+00A0, U+00AD, U+061C,
  U+115F, U+1160, U+180E, U+200B to U+200F, U+2028 to U+202E, U+2060 to
  U+2064, U+2066 to U+206F, U+3164, U+FEFF, U+FFA0 and the tag characters
  U+E0001 to U+E007F. One full-strength line under the block says how many
  the whole command holds. Only the drawing changes: `notShown` and what
  Allow sends are the text itself.
  - **A wider space is marked too, outside CJK text.** U+2000 to U+200A,
    U+202F, U+205F and U+3000 draw as a gap and are not a space to a shell
    (`rm -rf a<U+3000>b` is one path). Each is drawn as its code unless the
    run it is in has a CJK character on BOTH sides (Han, kana, Hangul, CJK
    and full-width punctuation), where it is how the text is written. One
    side is not enough: beside a Latin word, a quote, or the start or end of
    a line it is marked. This is the whole rule; it applies only in a
    command, script or code block, like every mark.
  - **Past `MARKS_MAX` (5,000) a code is still never text that was typed.**
    Up to that many, each code is an element of its own and is told from the
    same characters typed into the command by how it is drawn. Past it the
    codes are written into the text with no element each, so a backslash
    typed before `u{` is written as `\u{005C}`: what is drawn then has one
    reading back to the command, and the line under the block says so. The
    card decides which way for the whole command (`marksInText`) and draws
    both of its texts that way.
  - **The scan is a table, not a pattern** (`cardFold.eachMarked`). A
    pattern matched 5,000,000 times took 2.4 s to count and 12 s to size
    when the card arrived; the table takes 0.1 s.
- **The lines a command card states are the rows it draws**, for any mix of
  `\n`, `\r\n` and a return alone. A Windows line end is drawn as the pair
  it is, with no mark at the end of every line; a return anywhere else is
  marked `\u{000D}`. The two texts a card draws stop before the line feed
  that follows them, so `cardFold.lineFeedAfter` says whether one does, and
  a return at the end of such a text is drawn with it. That is not
  cosmetic: Chromium gives a return alone on the last line of a block no row
  at all (WebKit gives it one), and the card would state a line it does not
  draw.
- **A plan's stage line names every place and agent it can.** Destinations
  are told apart by project and whole path (`planReview.planPlaceNames`): a
  shared folder name gets its project, then its parent folder, then the path.
  Up to four destinations and six agents are named; the rest are counted in
  words (`+2 more agents`). The chat's card opens to every task whole (path,
  criteria, command approval, the full brief) in one scroll; only the run
  panel keeps a disclosure per task. The fold belongs to one revision
  (`cardFold.planFoldId`), so a changed plan arrives folded.
- **Opened is whole, and what cannot be shown whole cannot be allowed.**
  `askDetail` carries no limit and nothing cuts a body where it is drawn: no
  cap, no "first N characters". A long detail scrolls inside the card. A cap
  with a note under it was tried (200,000 characters) and was the hole: the
  card drew that much of a 330,000-character command, said the rest was not
  shown, and let Allow go. The one limit is `cardFold.WHOLE_MAX` (5,000,000
  characters, where opening stops the page for about a second; every size
  measured up to 50,000,000 was still drawn whole). A text past it is never
  opened in part, and its card cannot approve it: the card says `This command
  is too long to show in full (N characters), so it cannot be allowed here.
  Deny it and ask for it in smaller steps.` and its approving buttons stay
  off for good (`tooLong`, `tooLongNote`). **For a command the limit is on
  what is drawn** (`cardFold.drawnChars`, `CommandFold.drawn`), not on what
  is sent: a character drawn as its code is eight characters for one, so
  5,000,000 zero-width characters were within the limit and drew 40,000,000,
  8.6 s to open. Past `WHOLE_MAX` as drawn the command is not opened either,
  and the card gives both sizes (`N characters, M as drawn`). Nothing is cut
  to keep to the bound. What is still on the card differs
  by kind. A command keeps what any folded command has, its leading whole
  lines with `N more lines not shown` under them, and has no control to open
  it. A plan, an older host's change text or a route's first message or brief
  has none of that text drawn: the sentence stands where it would open. A
  row of a change keeps its label and size, and is not opened. Deny and
  Cancel always answer. A diff draws its
  first 600 rows on opening (`DiffView.FIRST_OPENED`) and keeps its own `Show
  N more lines` past that: 5,000 rows at once stop the page for about 0.4 s,
  and drawing them a stretch a frame was slower still. Those rows are a press
  away, not cut, so they hold nothing back.
- **The control is above what it opens, which is above the buttons.** However
  the card is anchored (on the composer and growing up, or in the transcript
  and growing down), the pointer that opened it is never left over that
  card's own answer.
- **A repeated press is dropped** (`cardFold.strayPress`, kept by
  `lib/pressGuard`'s document listener). Shutting the lower of two stacked
  cards brings the upper one down, and its Allow can arrive under a pointer
  that has not moved. A press within 700 ms and 8 px of the one on a
  disclosure (`pressGuard.notePress`), landing on anything but that
  disclosure, does nothing; a pointer that moved, or a press made later, goes
  through. The run panel's disclosures are remembered by the same guard (see
  **An action that stops or starts work is never fired by the key or press
  that brought it on screen**).
- **The question surface folds nothing.** It is no card any more (see **The
  agent's questions are drawn where they were asked**), and the rule is the
  same: its options and what each means are the decision, and it has
  controls on every side of where a disclosure could go, so opening or
  shutting one would slide a control under the pointer. Only `Other…` grows,
  under itself.
- **State is the component's.** Folded for every new card; one the person
  opened stays open while it is on screen, by the id of what it asks. Nothing
  is remembered past that, and there is no setting.

### The route and handover cards are name cards

`RouteCard` and `SourceCard` (`components/HandoverCards`) say who the work
goes to before anything else: the agent's face at 44px and its name as the
title. What the card used to be headed with (`routeHeadline`,
`handoverHeadline`: the question while it is undecided, then what is
happening) is still what the card is called (`aria-label`), and while it is
undecided its primary answer names the action and the agent. `docs/mocks/
handover-cards-namecard.html` is the mock they were built from.

- **Facts are sentences, not rows.** What kind of chat and where is one line
  (`handover.routeFact`: `Discussion · starfall`, `New chat · starfall · new
  worktree`), a handover's is two (`Takes over this task ·
  <project>`, then `handover.handoverWhere`), the files a route carries are
  `With 3 files: a, b, c`, and the chat's settings are one line of small
  print (`settingsLine`), never chips.
- **The folder is not on the card.** It is on the project's name (`Place`: a
  tip, set against its sentence so it is never wider than the card), and
  inside the opened brief (`Opens in`, or a handover's `Checkout`) for a
  screen with no pointer. A route that plans across every project has no
  one folder and shows neither.
- **That tip is shown by a state, never by `:hover` or `:focus`**
  (`lib/placeTip`, drawn from `data-open`). A pointer over the name asks for
  it, and so does the focus on it (a tap gives the name the focus; a finger
  does not hover). Escape, or a press anywhere else, sends away whatever is
  asking, and each stays away until it asks again: the pointer by leaving
  and coming back, the focus by leaving and returning. A press on the name
  asks again too. A pseudo-class is true for as long as the pointer or the focus
  stays, so Escape could not shut the tip under a pointer that had not
  moved. While the tip is shown Escape is heard on the document and always
  shuts it. It goes no further only when it is nobody else's
  (`placeTip.keepsEscape`): the focus is on the tip's own name or on
  nothing, where the same press would also leave focus mode. With the focus
  anywhere else (a form, a dialog, a field, another card) the tip shuts and
  the Escape goes on to that surface, which answers it by its own rules:
  a tip opened by a pointer must not cost a form its cancel. Two tips shown
  at once (one name focused, another hovered) both shut on the one press.
- **The envelope is the card's one disclosure**, and it is `CardFold`'s own
  line and control dressed in `HandoverCards.css` (the whole row is the
  target, the icon is a mask on the line). It keeps both labels of a route
  (`Brief · N characters`, `Exact first message · N lines`): they are two
  texts. Do not draw a second control for it; `notePress` is in the shared
  one.
- **`is-waiting` is the card that waits on the person** (`waitsOnPerson`:
  undecided, or a start that failed), and that class, not the status class
  `is-pending`, takes the decision colour and the raised quiet text.
  **Nothing on the card is the accent.** One rule is a colour the scan in
  `lib/decideColour.test.ts` forbids, on purpose, and that test names it:
  `Not passed on` (amber, a problem). The ring that breathes round the face
  while a confirmed chat is being started or gone to (`is-opening`, never on
  a card that waits) is the grey of the card's own text, `--fg-1`: opening a
  chat is not a turn in flight (the page may only be finding it), the accent
  is the model's colour (gold under Claude and in 中国风), and nothing waits
  on the person by then, so it is not `--decide` either. That test scans the
  card by the class of each part (`NAME_CARD_PARTS`): a part added to the
  card is added there, or the scan does not see it.
- **A brief too long to show cannot be handed over** (`briefOver`): the parts
  of a handover's brief are counted together against `cardFold.WHOLE_MAX`,
  the envelope gives way to the sentence, and `Hand over` and `Try again` are
  off (`aria-disabled`) while `Keep it here` and `Give up` answer. The host
  stops each part at 8,000 characters (`handover.rs`, `FIELD_MAX`), so this
  is the page's own bound, as the route card's is.
- **Confirmed, the face and the name go on to where the agent is named next**
  (`lib/identityTravel`): a route's to the composer of the chat it opened
  (`composerLanding`), a handover's into the line it leaves (`lineLanding`;
  that line shows the face at 16px in place of its mark). The top bar is not
  part of it. Copies on `document.body`, one movement of 200ms on
  `--enter-ease`, each landing unseen until its copy arrives. A card says it
  was confirmed (`rememberIdentity`) and where it is as it is drawn and as
  it leaves (`refreshIdentity`, `leaveIdentity`); whoever draws the landing
  asks (`landIdentity`).
  - **A route's travel belongs to the one confirmation that started it.**
    Its landing is found by the chat, never by the agent's name: the
    composer writes the chat it is the composer of on its identity chip
    (`data-chat`, from `session`), and `composerLanding` takes the id the
    host said the route opened (`chatIdOf(targetChatKey)`, the same id the
    page goes to). The same agent has other chats, and another project may
    have an agent of the same name; finding the landing by name sent the
    face into whichever of them the person opened. `App` keeps the travel
    (`routeTravel`: the confirmation, the chat it was pressed in, the chat
    it opened, whether the page has got there) and calls it off
    (`forgetIdentity`) the moment `routeAfter` says so, and when the card's
    hold runs out (`GOING_MS`). So a chat picked by hand, one a
    notification or the address bar brought, and a reload (the travel is
    in memory) all end it with nothing drawn. The travel is asked for only
    if the page still shows the chat it was confirmed in when the host
    answers.
  - **It stands in one chat at a time, and only while that chat is what
    the page shows** (`identityTravel.routeAfter`, one pure rule; its table
    is in `identityTravel.test.ts`). Waiting to go, that is the chat it was
    confirmed in. The first time the page shows the chat it opened it has
    arrived, and from then on that chat is the only one: back in the chat
    it was confirmed in, the copies are taken away and the landing shown
    again, as for any other chat (the composer is one element the page
    reuses, so a travel left standing hid the returning chat's own face and
    name). The open chat's id does not say the chat is on screen: `App`'s
    `chatShown` does, the one value for the five things drawn in a chat's
    place (the phone's project list, a main-area page such as Settings or
    Agents, the phone's Plan page, the run panel and the task chat where
    there is no room beside them). Off screen calls the travel off, waiting or in flight, and
    nothing brings it back. The rule hangs on that value and the open chat
    in one effect, never on the callers that change them; a new thing drawn
    in the chat's place joins `chatShown`. A panel laid over the chat is
    not such a thing and does not call a travel off.
    `identityTravel.wiring.test.ts` reads `App.tsx` and `Composer.tsx` as
    text for the steps of the hand-off; its head says what that can and
    cannot show. It is not where this rule is tested.
  - **Nothing is put on the page until the frame the landing is drawn.** So
    motion that is reduced, a face with nowhere to land that can be seen
    whole (off screen, or clipped by its scroller), a chat that never
    opens, and a card that left the page more than `FRESH_MS` ago all draw
    nothing and hide nothing. The face travels or nothing does. The name
    goes with it when all of it can be read where it lands: its box can be
    seen whole, and its words are not cut short inside that box
    (`cutShort`: wider than it is drawn, which is how the composer ends a
    long name in an ellipsis; the box is whole then, so the box alone
    cannot say it). Otherwise the face goes alone and the name is where it
    now is, not hidden: a whole name flown into a place that shows half of
    it would jump as it landed. A copy and the hiding of what it lands on
    begin together and end together.
  - **What a copy lands on is shown again as it was, however that ends**:
    finished, cancelled, called off (`forgetIdentity` ends a travel in
    flight where it is), or never run (a clock clears up after three times
    the movement). A second travel to an element another is still flying
    to ends the first before it reads how the landing is drawn
    (`landingOn`), so two travels to one landing, in any order, leave it as
    it was before either.
- **The page that confirmed a route keeps its card until it has left the
  chat** (`handover.handoverTail`, `App`'s `goingRoute`). The record says
  confirmed at once, and `handoverPlaces` then drops the card, but the page
  gets to the new chat only when `onOpenChat` has found it, which may be a
  request to the host: without the hold the card was gone and the chat not
  yet there. Held, the card says `Opening the chat.`, asks nothing, and goes
  with the chat, after `GOING_MS`, or when the chat is called unavailable.
  No other page keeps it, and a handover's card is never kept.
- **A face is never the colour of a warning or an error**
  (`agentPersona.personaHue`, `WARM_HUES`): no hue from 345° round to 80°. A
  hue outside that band is the hash's own, as before; one inside takes its
  place along the band as its place along the rest of the wheel
  (`awayFromWarm`). Green and teal are not avoided: too few colours would be
  left to tell agents apart.

### The chrome above a page is three rows

The top bar names the page and nothing else. What can be done about the
page is a row of its own under it, and on a desktop plan usage is a third
(`App.tsx`, after `<header className="topbar">`). 860px decides phone
against desktop (`lib/media` `MOBILE`), never the operating system: a
narrow Windows window gets the phone's layout.

- **The top bar** (48px): the project, the title and the status. A run's
  title may wrap to two lines there. No action is in it. Two things are
  still at its end, both on a phone only: the way back from the chat list
  (`Return to chat`), and the usage number on a page that has no action bar.
- **The action bar** (`components/ActionBar`, 36px; 45px on a phone): every
  action for what is on screen, each a button with an icon and a short word
  (`Tasks`, `Plan`, `Preview`, `Git`, `Focus`, `New task`, `Details`,
  `Agents`, `Pinned`, `Full width`, `Run`, `Reload`, `Copy ID`, `Complete`,
  `Delete`),
  in that order. The word is short and stays the same; the sentence is the
  button's name and tooltip (`Complete this chat`), and a button's result is
  its icon and name, never a longer word (`Copy ID` does not become `Chat ID
  copied` in the row). A page's own buttons (`WorkspaceHeader`'s `actions`)
  are drawn at its start on a desktop.
  - **Adding a button is one line** in `App.tsx`'s `barActions`:
    `act(id, keep, node)`. `keep` is how long it stays as a desktop narrows.
  - **A desktop measures; a phone scrolls.** On a desktop what does not fit
    goes behind More, the lowest `keep` first (`lib/actionBar.overflowing`),
    and what waits on the person behind More is counted on More
    (`attention`, which is how a plan waiting in a put-away Tasks column is
    never hidden twice). A button behind More is mounted only while More is
    open, so a control that polls exists once; what it measured when it
    left decides whether it has room to come back. On a phone nothing is
    put away: the row scrolls sideways (`overscroll-behavior-x: contain`),
    every target is 44px, and the edge that is cut fades
    (`actionBar.cutEdges`). The fade is drawn over the row, never as a mask
    on it: a mask would also cut the panel a button opens.
  - **Its height never changes.** One line, `white-space: nowrap`, and no
    scrollbar that takes room (`scrollbar-width: none` and the WebKit rule:
    a Windows browser draws classic ones). Widths are measured, never
    assumed from a font: a wider fallback font moves buttons behind More.
    The bar reads layout when a size changes (`ResizeObserver`), never on
    every render.
  - **It is there before its buttons are.** On a chat's page the bar is
    drawn from the first paint (`reserved`), its buttons out of sight until
    the project list answers (the same gate the top bar's actions had), so
    a button or a count that arrives moves nothing under the bar. A page
    with no actions draws no bar (the sheet's `:has`).
  - **A page with no actions never has the row drawn and then taken away**
    (`lib/actionBar.holdsBar`, one policy). Before the project list answers
    the row is held only when something already says buttons are coming: a
    chat is open or the address names one, or this browser's last visit to
    a chat's page had buttons (`octiq.v2.actionBar`, written by the bar
    through `lib/remember` once the answer is known: `barSeen`). A first
    run in agents mode with no project has none of those: no row at the
    first paint and none after. It used to be held for the list and removed
    when the list answered empty, and the page jumped 36px. What is left: a
    browser that has never been here, on an install that has projects, gets
    its row with the project list, once; a browser whose last visit had
    buttons, on a page that has lost them all since, gives the row back
    once. What is left of a
    cold open's layout shift inside the bar is a button sliding along its
    row when Tasks or a count arrives beside it (0.006 of 0.013 at 1280,
    0.0015 at 390; `scripts/test-top-chrome.mjs` prints it).
  - **A panel a button opens is placed by the window, not by the row.** The
    row clips on a phone and More's list clips on a desktop, so `Details`
    opens a panel fixed to the window, under its button and inside the
    window's width (`ChatTaskBar.panelPlace`), placed at the press: placed
    after it is drawn, it is seen for a frame where it is not.
- **The usage row** (`UsageRow`, 26px, desktop only): every window the
  host's `usage_summary` reports, each a short label, a small bar and the
  percent (`lib/usageWindows.usageCells`: `Claude 5h`, `Claude week`, `Opus
  week`, `Codex week`, a Codex five-hour window when it is reported). Calm
  is grey, the warning colour from 60%, hot from 85%. An agent the host
  cannot read is its name, a dash and the host's note in the tooltip; a
  last good reading shown after a failed ask is faded and says `last
  known`. Antigravity has no limits and is nowhere on a desktop. The reset
  time is in each window's tooltip, and the whole row is one button that
  opens the full breakdown, so it is never behind a hover alone. Too narrow
  for its windows, the row scrolls sideways and fades its cut end; it never
  wraps. A phone keeps the one number (`Usage`), at the end of its action
  bar.
- **One reader of usage, whichever surface draws it** (`lib/usageFeed`):
  one timer and one clock for the rate limit, outside any component,
  because the Claude endpoint 429s per account. The first surface asks
  outright; one that takes another's place (the window crossed 860px) asks
  under the limit. A failed ask keeps the last good reading.

**A phone's chat list has its places menu at the top and nowhere else.**
The menu (New conversation … Settings) is the first thing in the list's
scroller: it leaves with the list and is reached again by scrolling to the
top, or by the keyboard, whose focus scrolls it into view the native way.
It used to come back over the rows on every upward scroll
(`lib/mobileMenuScroll`, removed). On a desktop the menu stays put above
the list and only the list scrolls, as before.

### The rows above the composer are one group

Four things report above the composer and ask nothing: the chat's folder is
gone (`RemovedFolderBanner`), the chat is completing (`ChatCompletionLine`),
background notices (`ChatNotices`), the run's progress (`RunProgressStrip`).
They are one group (`components/ChatStatus`), mounted in that order directly
on the composer, under the cards that ask. A fifth row is first in the group
and is there only while it has something to point at: `1 question waiting`
(`QuestionWaitingRow`), for a question in the transcript that is out of
view.

- **A row is one line, with no box and no fill of its own.** The same
  height (28px), the same left edge and the same icon column, which is the
  eyebrow's own, so the face under the rows stands in line with them. A
  hairline between two rows is all that separates them. A row's state is
  the colour of its icon or dot and nothing else. The shared frame is
  `ChatStatus.css` (`.status-row`, `-main`, `-icon`, `-label`, `-text`,
  `-chevron`, `-dismiss`, `-panel`); a new row uses it and adds no border,
  background or tint.
- **Nothing is drawn outside a row.** The group is `flex: 0 0 auto`: a row
  with a `min-height` was squeezed to it by the column, and its wrapped
  words were drawn over the borders (the person's screenshot). A row's
  words are one line, cut with an ellipsis inside it at any width and in
  any font. Only two things take a second line: what a row opens, and why a
  completion did not happen (the host's sentence, never cut).
- **Folded, a row is a short label.** A notice is its short title, or `3
  notices` (`chatNotices.noticesHeadline`); the host's sentence for
  interrupted background tasks is `1 background task interrupted`, with the
  sentence and the task ids inside the opened panel. A long notice is
  titled by what it leads with (`Could not switch models`) or `Notice`,
  never by its first sixty characters.
- **A row that opens is a button**, so a pointer, a finger and the keyboard
  open it; nothing is a tooltip alone. Its chevron follows its words, and
  the far end of the row is the dismiss's.
- **A dismiss shows under the pointer and the focus, and always where a
  finger can be** (`(hover: none), (any-pointer: coarse)`, which a touch
  laptop matches). Nothing is reachable by hover alone.
- **The group grows upward**, so a row arriving, or one opening, never
  moves the composer. Only the notices' panel can scroll, and only down.
- **A card that asks is not a row of this group** (permission, access,
  safety) and keeps its look. A question is neither: it is drawn in the
  transcript, and the row that points at it asks nothing itself. That row is
  the one whose words, not only its dot, are a state's colour (`--decide`),
  as the composer's waiting words are.

### What a chat runs at is beside the agent's name

An agent's chat has no pickers: the registration says what a chat of the
agent opens on, and the chat then keeps what it has (**A chat's level is its
own**, above). So the composer says what THIS chat runs at beside the agent's
name, as small quiet text, `opus · high · Auto` (`AgentIdentityChip`,
`lib/chatSettings`).

- **It is read-only, and it is a disclosure.** No picker: Settings, Agents
  sets what the agent's new chats open on, and the sheet says so. A press, a
  tap or Enter on it shows the
  three values whole (`Model`, `Effort`, `Access`, as the pickers name
  them) with the last turn's receipt, in a sheet that holds no control;
  Escape or a press outside shuts it. A narrow composer cuts the text, so
  what it says is never behind a hover alone. The button's target is the
  whole chip (its `::before`, placed by the chip and so not cut with the
  text): there is something to press when the text has no room left.
- **Only what the page knows of this chat** (`knownSettings`). The values
  are the page's own for the session (`choice`, `effort`, `access`). A
  conversation not saved yet runs at exactly those, which the page copied
  from the agent's registration as it opened it. A saved chat's model is
  known when its index entry names one or the agent reported one, and its
  effort and access when the entry has them; otherwise that part is left
  out. Never filled in from the roster: a chat can differ from its agent.
- **The access is the level the page holds for the chat**: the one it took
  from the chat's own entry as it opened it, saves with it and asks for at
  the next start. A chat the person put at Plan under an agent registered at
  Auto says Plan, and one a card raised says the raised level.
  `chatSettings.wiring.test.ts` reads `App.tsx` for that hand-off and fails
  when the text is given the registration's level, when a start asks for
  another, and when a level event or the read-only retry is put back.
- **The settings text gives way before the name, and its access last.** On
  a narrow composer, or in a wider font, it is cut short and then gone
  before the name loses a letter. It is drawn in two parts
  (`chatSettings.runsAtParts`): the model and the effort give way first,
  and the access, which says what the agent may do, is cut only once they
  are gone (`opus la… · Plan`, then `· Plan`; at 390px it read `opus · high
  · …`). `.composer-identity-name` stays the name alone: it is what a
  confirmed route's name lands on (`identityTravel.composerLanding`,
  `cutShort`).
- **The chip's tooltip names both, apart.** `Claude Opus latest · set in
  Settings, Agents` is the registration's; `This chat runs at opus latest ·
  high · Plan` is the session's. The session's values are never filled in
  from the registration's, in the text, the sheet or the tooltip.
- **The last turn's receipt is a tooltip, and two lines of the chip's
  sheet.** `Last turn · 178.1s` and `Cost · $9.526` (`receiptLines`) are in
  the chip's tooltip and its opened sheet, and in the model picker's
  tooltip in an ordinary chat. The eyebrow carries no receipt and no model
  name.

### No control of the composer is drawn outside it

The row under the text box folds its three pickers (model, access, effort)
behind one button when it cannot hold them side by side. That is decided by
the row's own width, measured (`lib/composerFit.rowFit`, a `ResizeObserver`
on the row and a look when what the row holds changes), and never by the
window's alone: with the run column and a side column open on a 1280px
window the chat is about 340px, the window still said "desktop", and the
row's overflow landed on Send, drawn past the composer's right edge. (That
is older than the Plan column: the git and files columns did the same.)

- **Side by side while what the row holds is no wider than the row. Folded,
  it is tried side by side again when the row has grown past the width it
  last failed at, or when what it holds changed** (another model, another
  agent, its fonts arriving), and the next look folds it once more if it
  still does not fit. Both looks are made before a paint, so a try that
  fails is never seen, and at one width with the same contents the answer
  does not flip. What the pickers need is not remembered: a width taken
  once went stale with the font that loaded after it, and kept them folded
  in a row with room. Nothing is assumed from a font: a wider fallback font
  folds sooner.
- **The fold is the phone's** (`.composer-row.is-tight`, beside the 700px
  rule): the same button, opening the same sheet. On a wide window that
  sheet is a card at the foot of the window, not a band across it.
- **Send never gives way.** Everything else of a folded row can be cut: the
  settings button, then the agent's chip.
- `scripts/test-composer-fit.mjs` draws it in the real App and walks a
  desktop window down to 861px with both columns open (a 321px chat): no
  control of the composer reaches past its box.

### A chat that waits on the person is not drawn as running

The agent is already parked when it asks: the tool it called blocks until
the card is answered. So a chat with a turn on record that waits on the
person is drawn waiting, not working (`lib/chatWait`).

- **One answer, from the page's one list.** `waitingChats(pendingList, …)`
  reads `lib/pendingActions`' list and nothing else: not the cards, not the
  ledger. A new surface that draws a turn in flight, or says a chat needs
  the person, asks it: the composer and its clock, the chat list, the
  projects page, `ChatTaskBar` (the action bar's status and its panel) and
  the task chat beside the main one (`TaskChatPane`).
- **There are three answers, and "not read yet" is not "nothing waits".**
  That list starts EMPTY on a page that has just loaded and is filled by one
  request each: `permission_pending`, `access_request_pending`,
  `question_pending` and `safety_block_pending` (asked on every connection
  by `useChatRequests`, which says where each stands), and the ledger
  (`orchestration_snapshot`, read once `orchestrationFeed` holds a
  snapshot). They are named in one place, `pendingActions.WAIT_SOURCES`, and
  the reading says how whole it is (`wholeOf`, `PendingReading.whole`):
  `read` when every one has answered, `unread` while one is still out,
  `gaveUp` when no more is coming. `waitingChats` turns that into a third
  answer, a value of the same map: a chat whose checkpoint brought it back
  parked (`turnClock.parkRestored`) and that no card names is `unknown`
  while the reading is `unread`. A card is a card however little was read.
  - **Unknown is drawn as neither.** The composer's line says `Checking
    what waits on you` in grey with the clock stopped and the companion
    still; the chat list and the projects page draw no working mark; the
    task bar says where the work stands, as an idle chat's does, never
    `Working` and never `Needs you`. Every surface has it because it is a
    value of the one map; there is no flag beside it, and no surface reads
    a list's state itself.
  - **A chat with no restored wait is never unknown.** A turn that starts
    after the reload is drawn working at once and its clock runs.
  - **A list that fails is asked once more** (`lib/listRead`, three seconds
    on); a second failure is that list not readable on this connection.
    When every source has answered or failed for good, or one has said
    nothing for five minutes (`pendingActions.SILENT_MS`: a request on an
    open socket has no timeout, and a socket that closes fails it and asks
    again on the next), the reading is `gaveUp` and the page goes on with
    what it has: a chat no card names is drawn working, as it is for any
    chat whose cards the page cannot read. A page with no connection has
    asked nothing and stays `unread`.
- **Never the length of a card list.** The host goes on listing a question
  the person has answered (`status: "saved"`, then `delivered`) until its
  agent has it, so `questions[chat].length` is one while nobody is waited
  on. `ChatTaskBar` was handed the lists' lengths OR the one answer, and
  said `Needs you` under a composer that said the agent was working.
  `chatWait.wiring.test.ts` reads `App.tsx` as text: it names each
  hand-off, and fails for any `waiting` prop that reads a card list or a
  `.length`. It is an alarm on spelling, not a proof: no test renders the
  app.
- **What parks a chat:** its own permission card or access request
  (`Waiting for your approval`), its own question or full safety card
  (`Waiting for your answer`), and a plan awaiting approval for a run it
  coordinates (approval). **What does not:** a worker's card drawn in its
  coordinator's chat (it parks the worker), a gate, an auto-mode refusal
  the agent carried on past (`safetyToast.splitSafety`, asked with the turn
  itself), a safety-check outage, an answer that could not be delivered, a
  handover to confirm.
- **The composer's line** says the waiting words in `--decide` where
  `thinking…` was, the companion stands still (no working ring, which is
  the accent), and the clock stops. Background work the turn started is not
  this line's and goes on being said beside it.
- **The clock leaves the wait out** (`lib/turnClock`): the turn's start plus
  the waited intervals gives elapsed, so work goes on from where the clock
  stopped. All on the page's clock; no host stamp is compared with it.
- **The clock counts what a page saw the turn work, and nothing else.**
  Three rules make that hold across a reload:
  - *A turn's start and its waits are restored together or not at all.* The
    waits are a field of the chat's own state, beside the start
    (`ChatState.turnWaits` next to `turnStartedAt`; `App` notes them with
    `turnClock.withWait`), so whatever saves or restores the one has the
    other. They were the page's own, in memory, while the start came back
    from the chat's checkpoint (`lib/chatCache`): 90 s of work and 180 s of
    waiting read `1m 30s` before a reload and `4m 31s` after it.
  - *The time no page was looking is never counted as work.* A checkpoint
    is written in a quiet moment (700 ms after the page's chats last
    changed), so with agents streaming elsewhere it can be minutes old:
    older than a wait the page did see begin. So a turn that was working
    when its checkpoint was written comes back parked since that moment
    (`turnClock.restoredTurn`, in `loadChat`, from the checkpoint's own
    `updatedAt`), and the page's first look that KNOWS decides: a card
    that is up keeps it parked, and no card ends the wait there. Keeping
    the waits beside the start was not enough by itself: the review's clock
    probe, run again, restored a checkpoint from before the wait once in
    three runs and read `4m 31s`.
  - *A look made before the lists were read ends no restored wait.* The
    wait a checkpoint brings back is marked (`TurnWaits.restored`), and the
    clock is told the reading's three answers and how whole the reading is
    (`chatWait.seenWait`, `withWait(state, seen, now, whole)`). Unknown
    changes nothing; a card confirms the wait and keeps the moment it
    began; only a whole reading that names no card ends it, with the time
    it was held left out. The page used to say `false` for a list it had
    not read: with `question_pending` held back 120 s, `1m 30s` read `3m
    31s`, drawn as thinking, and kept it once the question was back.
    `noteWait` refuses that `false` itself (`unread`), so the rule holds in
    the clock as well as in what it is told.

  What each path does:
  - *With a checkpoint* (the usual reload): the start and the waits come
    back, and the clock reads the work seen up to the checkpoint. It stands
    there while the lists are unread and while a card is up; after the
    answer, or once every list has answered with no card, it goes on from
    there. It can read less than the turn really worked (what was seen
    after the last checkpoint, and the time the lists took, are not kept);
    it never reads time the turn spent waiting, or time nobody saw. That
    holds in every order the lists arrive in.
  - *When the page never comes to know* (`gaveUp`): the restored wait is let
    go on a guess, the time it was held is left out, and the clock goes on
    from the checkpoint's work with the moment kept (`TurnWaits.guessed`).
    It is not held for ever. If a list read after that says the chat waits
    (the silent one answers after all, or a new connection asks them all
    again), the time since the guess is taken back off the clock: nobody
    knew it was work. If every list answers and nothing waits, the guess
    stands. A card that arrives while the page is still giving up is a wait
    that begins then. A guess never answered is not carried through another
    reload. What is left: while it guesses, the page says `thinking` for a
    chat whose card it cannot read, as it does for any such chat.
  - *Without one* (a chat never saved or evicted from the twelve kept, one
    read in pages, storage blocked): neither comes back. The turn starts
    when the page joined it, as for any turn joined part-way, and the wait
    when the page first sees the card: a clock stopped at about nothing
    beside the waiting words, and after the answer only the work done since.

  A new thing the clock leaves out is a field of the chat's state too,
  never a state of the page's beside it. `turnClock.reload.test.ts` is the
  round trip through the real checkpoint and `loadChat`, for a checkpoint
  written during the wait, one written before it, and none.
  `turnClock.unread.test.tsx` goes on from there through the three steps
  `App` makes (the reading, which chats wait, the clock) to what the
  composer, the task bar and the chat list draw: the lists unread for 120 s
  and then the question still pending, the lists empty, one that never
  arrives, one that failed twice, and the page as it was, which fails them.
  A probe of a restore holds a request back: a fast reload passing ten
  times of ten says nothing of the slow one.
- **The chat list** draws no working mark on a row whose chat waits
  (`Sidebar`'s `waiting`); its pending badge is unchanged. `busy` still
  means a turn is on record there, which is what holds Archive.
  `ChatTaskBar` says `Needs you` in `--decide`, never the accent and never
  amber, and only for what parks the chat: an outage card or an answer that
  could not be delivered is badged and does not say it.

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
- **Nor may it go into the gap a Stop leaves with nothing queued**
  (`ChatManager::unwinding`). Until the cut-off turn's own full stop has been
  read, a message waits in the queue and is handed over on it; written at
  once, it would be the turn that late full stop ends, with the agent working
  on and the session read as idle.
- **A Stop the agent does not honour ends its process.** A persistent agent
  that has not sent the cut-off turn's full stop within `UNWIND_GRACE` (30 s)
  is ended (`grace_ran_out`), the way the idle sweeper ends a chat: the
  transcript is on disk and the next process resumes the conversation by id.
  Nothing is written to it first. The queue is kept: its first message starts
  in that next process at once and the rest wait behind it, so Stop still
  keeps the queue, 30 seconds later than usual. With nothing queued the live
  dot goes off and the next message resumes the chat. No prompt is ever
  written to a process that still owes a full stop (`CutOff`,
  `write_user_message_locked`); see **Completing a chat** for why.
- **A queue whose next message cannot start WAITS; it is never failed for
  that.** Handing a queued message over starts a turn, and no turn starts
  while its record cannot be kept (the profile folder is away): a new
  process is refused by `start_session`, and a running agent is not written
  to (`dispatch_next_persistent_turn`). The message taken off the queue goes
  back to its front, nothing behind it is touched, and the chat is listed in
  `ChatManager::waiting` with the profile's sentence (`keep_waiting`). The
  Stop that led there answers `{ stopped: true, waiting: N, notStarted:
  <why> }`, not an error; `chat_queue_state` carries the reason as `held`;
  the bus says `chat-queue-waiting`. Every carry goes through
  `carry_queued_turn` (a Stop on a one-shot or Antigravity agent, the
  reaper's carry-over, the grace of a Stop not honoured, "send this one
  now"), so all of them wait the same way. Once the folder is back the host
  hands the first message over itself (`start_waiting_queues`, every two
  seconds beside the owed saves): written to an agent that kept its
  process, or the first message of a new one, and the rest follow the
  ordinary way. Meanwhile a send joins the back of the waiting queue (a
  start is answered `already running`, which the page answers by sending),
  the ✕ takes a message back, "send this one now" moves one to the front,
  and the chat is not ended as idle. An entry goes when its queue empties,
  so a listed chat has had nothing written to its agent since it was
  listed. A start that fails for a reason of its own once the folder is
  back fails as it always did: marked not sent, and dropped.

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

### Completing a chat

Complete is the person saying "I am finished with this one": the agent is
asked to wrap up, and when that turn ends the host ticks the chat done and
stops its process. The chat stays readable and is **not locked**; the next
message starts it again and takes the tick away.

- **It is the page's command and nobody else's.** `chat_complete { chatKey,
  start? }` and `chat_complete_preview { chatKey }` are `dispatch.rs` arms. No
  hook routes to them and the MCP server has no such tool, the same way
  `orchestration_mission_close` has none. The wrap-up asks the agent to stop a
  run it coordinates; closing the mission stays the person's.
- **The wording is the host's** (`agent_chat::wrap_up_message`), never the
  page's. Two steps are left out when they cannot apply: saving agent memory
  (a registered agent's chat only) and stopping a run (only when the chat
  coordinates one that has not ended, named by id).
- **The wrap-up waits; it never interrupts.** It is an ordinary recorded user
  turn whose id starts with `octiq-complete-`. With a turn in flight, or
  anything queued, it joins `ChatManager::queued_turns` like any message, so
  the queued bubble's ✕ (`chat_cancel_queued`) takes the completion back and
  "send this one now" (`chat_start_queued`) is the person's own interrupt.
  That prefix is not a person's turn id, so the queue never folds a message
  into the wrap-up or the wrap-up into a message.
- **Stop followed by Complete queues the wrap-up behind the turn that was
  stopped.** A Stop marks the session idle at once, while the cut-off turn's
  own full stop is still to come (`ChatManager::unwinding`). Nothing is
  written to the agent in that gap: the wrap-up answers `queued` and is
  handed over on that full stop, under the session lock, like any queued
  message. An ordinary send in the gap waits the same way
  (`chat_send_with_user_turn`), and so does a host notification. Written at
  once, the wrap-up was decided by the cut-off turn's late full stop: a clean
  one ticked the chat and stopped an agent that had wrapped nothing up.
  - The stream does not say which turn a full stop ends, so the session does
    (`CutOff`, read in `end_turn_locked`): after a Stop the next full stop is
    the cut-off turn's, and `answering` is still that turn.
  - **Nothing is written while that full stop is owed, by anyone.** The mark
    is the session's own, set and cleared under its lock and gone with the
    process; no clock lifts it. Every prompt goes through
    `write_user_message_locked`, which refuses a session that carries it.
  - A cut-off turn that never sends one holds the queue for `UNWIND_GRACE`
    (30 s) and no longer: the Stop was not honoured, so `grace_ran_out` ends
    the process. It writes nothing to it. A turn written to an agent that had
    not stopped was answered by Codex with the turn it was already in, and
    the one full stop that followed could not be told from the stopped
    turn's, so nothing tells them apart any more: there is only ever one
    turn a full stop can end.
  - **A wrap-up waiting behind that Stop is not carried into the next
    process.** It was asked of the one that is gone: the completion ends once
    with `ok: false` and a sentence the person can act on (the agent did not
    stop, its process was ended, complete the chat again), and nothing is
    ticked. Messages queued around it are kept and the first starts in the
    next process, as after any Stop.
  - A host notification that was waiting meets a chat with no process, as
    after any exit: the person's chat is started again with it, and a
    worker's attempt has failed with its process.
  - Whatever the ended process still says ends no turn, decides no
    completion and moves no queue (`CutOff::Ended`); those are the next
    process's.
  - The thread that waits out the grace acts for the Stop it was started for
    and no other (`CutOff::Owed` names the unwind). A second Stop inside the
    wait starts no second thread and moves no deadline.
  - Antigravity and every command-line agent have no unwind: their Stop ends
    the process, so a Complete after it starts the chat with the wrap-up, in
    a process no older turn's full stop can reach.
- **A chat with no process is started with the wrap-up as its first
  message**, through the same `start_chat` path as `chat_start` (removed
  folder put back first, lifecycle lock before the short session locks). The
  page passes the settings it would start the chat with as `start`. Without
  them the answer is `chat '<key>' is not running`, and nothing is left
  completing.
- **Refused, by what the chat is:** a worker's chat (`is_worker_chat`, so a
  settled worker too), a front desk, a process key that is not the chat's own
  voice, a chat the index does not list, and a chat already completing.
- **`ChatManager::completing` maps a chat to its wrap-up turn id.** It is
  decided at the full stop of exactly that turn (`session.answering` is its
  id), under the session lock the turn ends with and BEFORE the queue moves
  (`end_turn_locked`):
  - clean, queue empty → once the full stop is in the transcript, the chat is
    closed (`conclude_completion` → `close_completed`): the check is made
    again, the chat is **ticked first**, then its process is taken out of the
    session table and `chat-completed` is said, all under the session-table
    lock. Only then is the process stopped, the way `chat_stop` stops it. A
    message that reached the agent or the queue in between, or a newer
    process under the key, wins: nothing is ticked.
  - failed, refused, or anything queued behind it → no tick, the process is
    left, and the queued message is handed over as usual.
  - **A tick that cannot be written stops nothing.** The process stays in
    the table and running, and `chat-completed` says `ok: false` with a
    sentence of the host's as `reason` (`could_not_mark_done`: the index
    could not be read or written, or no longer lists the chat).
  - Stop on the wrap-up ends the completion at the Stop, not at the cut-off
    turn's `result`, so Antigravity (whose Stop ends the process) and a killed
    command-line process can never tick a chat. A Stop on the turn AHEAD of a
    queued wrap-up leaves the completion alone: Stop keeps the queue.
  - A process ended on purpose (`end_process`), a wrap-up dropped from the
    queue, or a stream that closes before the wrap-up's full stop also ends
    it.
- **Closing a chat and starting it never both happen.** Either the start
  wins (the completion ends `superseded`, nothing ticked, nothing held) or
  the close wins whole (ticked, held, announced, process stopped) and the
  start that follows reopens the chat. Two things hold that:
  - `start_session` puts a process in the session table under the table's
    lock and refuses while one is there, and `close_completed` does its
    check, tick, removal and announcement under that same lock. So a start
    comes before the whole step, which then sees its process, or after it.
  - `chat_index::reopen` counts every start of a chat (`chat_index::starts`,
    in memory) under the index's own lock. A wrap-up's full stop reads that
    count, and `chat_index::complete` refuses a tick when it has moved
    (`Unticked::StartedAgain`): a start that came and went, leaving the
    table as empty as a one-shot's own exit does, still wins.
  - Lock order in the close: question delivery lock → session table →
    session → the index's lock (a leaf). It takes no workspace lifecycle lock
    and no start claim, so a start holding those (`chat_recover::Held`) only
    ever waits for the short session-table lock.
- **"Clean" is the provider's own word, read once** (`ended_cleanly`): Claude
  `result` with no error and subtype `success`; Codex `turn.completed` with
  status `completed`; Antigravity `result` status `SUCCESS` with no refusal
  added this turn. A process that resumed an Antigravity conversation cannot
  tell old refusals from new, and reads the first as new: no tick.
- **The tick holds against the page's own clock.** `updated_at` is stamped by
  every open tab when it sees a turn end, a moment after the host ticked the
  chat for that same turn, which would retire the tick at once. So a
  completion's tick is `chat_index::complete`, which sets `done_held`: a save
  then moves `done_at` up with the activity it carries, and the next
  `start_session` of the chat clears tick and hold together
  (`reopen_started_chat` → `chat_index::reopen`), whichever of the page's
  save and the start lands first. A tick made by hand (`set_done`) is never
  held.
- **Events:** `chat-completing { chatKey, turnId, state: "started" | "queued" }`
  and `chat-completed { chatKey, turnId, ok, doneAt?, reason? }`. `turnId` is
  the wrap-up turn on both, and on the answer to `chat_complete`, so a page
  matches an end to the completion it belongs to. `doneAt` comes with `ok:
  true` and `reason` with `ok: false`: `cancelled`, `stopped`, `failed`,
  `superseded` or `ended`, or else a sentence of the host's own (the wrap-up
  could not be handed over, the start that carried it failed, the chat could
  not be marked done, or the agent did not stop and its process was ended),
  which the page shows as given. A reloaded page
  reads the same state from `chat_queue_state` (`completingTurnId`) and
  `chat_activity` (`completing`).
- **A completion's `chat-completing` always reaches the bus before its
  `chat-completed`, and there is exactly one of each.** `begin_completion`
  emits in the step that records the completion, under the lock every end of
  it has to take (`fail_completion_when`), and before the wrap-up is written
  or queued. So a wrap-up that then cannot be handed over, or a start that
  fails, ends the completion it announced with `ok: false` and the error.
  A completion that was refused before it began (a worker's chat, one
  already completing) says nothing.
- **The state is in memory only.** A server restart mid-completion forgets it:
  the wrap-up turn is in the transcript, the chat is simply not ticked, and
  the person ticks it by hand or completes it again.
- **The page mirrors, and decides nothing** (`lib/chatComplete`,
  `lib/useChatCompletions`). The action is a button of the chat's action bar
  (`Complete`, between `Copy ID` and `Delete`), and is not drawn for a
  worker's chat, a front desk or a seat.
  The confirm (`CompleteChatConfirm`) is a decision surface: the decision
  colour, one line of what will happen, the host's preview as label and
  value, and the steps behind the one disclosure every decision card has
  (`components/CardFold`). One line above the composer
  (`ChatCompletionLine`) says Completing, Completed, or why not; the tick
  itself only ever arrives through the chat index. Every event about a chat
  bumps a revision, so a `chat_activity` or `chat_queue_state` read that was
  in the air when it arrived cannot put the older answer back.
- **The page matches every event, and the answer to `chat_complete`, by turn
  id** (`reduceCompletions`: `settled`, `turnEnd`). The answer can arrive
  after both events of a quick completion, and the events of two completions
  can interleave. So a start that arrives after its own end is ignored, an
  end of another turn than the one on screen changes nothing, an end heard
  while this page's request has no turn yet is held until the answer names
  one (`receipt`), and `complete()` answers `ended` for a completion that was
  over before its answer came, which is what keeps `App` from marking a
  finished chat running again.
- **The wrap-up's bubble is named, not quoted.** The page knows the turn by
  its id prefix (`isWrapUpTurn`) and draws `Wrap-up` with the host's text
  behind a disclosure. Its take-back says Cancel and returns nothing to the
  composer (`reclaim` skips it): the words were never typed.
- **Close mission is offered after the completion, never before, and never
  sent.** Once `chat-completed` says ok, the page asks git about the missions
  the confirm listed (`orchestration_mission_refresh`), reads the preview
  again, and offers Close only for a mission the host calls `closeEligible`.
  The click asks in the run panel's own words before
  `orchestration_mission_close`.

### A run's progress is one line above the composer, and the Agents panel

The chat that coordinates a run carries one line on its composer
(`RunProgressStrip`): a dot, the state word, how far as a bar, the count, and
at most two more counts. A click opens the run panel, which draws the same
run as three tiles (Tasks, Tokens, Time), then its tasks in four groups. Both
are read by `lib/runProgress` off the ledger this tab already holds.

- **Nothing on the line is said twice.** The bar has no words in it and
  there is no percent: `1/2` is beside it, once (`strip.label`, which is the
  count and nothing of the state). A finished run is `Done ▬▬ 1/1 · 23m`.
  A failure's reason is `1 failed`, which says the state's word again
  beside `Failed`, so there the reason IS the word and the counts are what
  is left (`runProgress.stripLine`): `1 failed ▬▬ 10/22 · 2 working`. Needs
  you keeps its word, and its reason (`1 decision`, `Plan to approve`) says
  what is asked. A run with nothing to count draws no bar. What is spoken
  and the tooltip are whole, as before (`stripSpoken`, `stripTitle`).

- **Nothing is estimated.** A figure the host did not send is `null` and the
  part that would draw it is left out; a zero is left out the same way. The
  host does not send tokens per attempt (`attempt.usage`) or a worker's
  context (`attempt.context`) yet, so today a row ends in its minutes and
  there is no Tokens tile. Both fields are typed and read, so they appear
  when the host sends them.
- **"Needs you" is a fact, decided in one place** (`lib/runWaits.runWaits`).
  A wait is the person's when the plan has a revision to approve, when the
  page itself holds a card for the worker (permission, safety, question, an
  undelivered answer, a handover), or when the host says so: an open gate
  or a pending native decision whose `awaits` is `"person"`, and a task's
  failure the host says is theirs to decide (below, **A failure is quiet
  until the person must decide**). A gate on a
  peer request is the person's on any host, because only their page can
  answer it. `awaits: "coordinator"` stays under Running in the warning
  colour as `Waiting on the coordinator`. `awaits: "nobody"` (a refusal no
  one can approve) changes nothing on the row. A host that sends no
  `awaits` leaves a gate or native decision unsaid: shown, never counted,
  and the tooltip says `The host does not say who this waits on.` A native
  decision and its safety card are one thing under one key, so decisions
  are counted per card and never per row.
- **Every surface is drawn from that one reading, and nothing else reads
  the ledger's waits.** `lib/runWaits` is the only module that names the
  ledger's `gates`, its `nativeDecisions` or a record's `awaits`; anything
  else asks it (`runWaits`, `ledgerWaits`, `openGates`, `taskDecisions`,
  `pendingDecisions`). One exception, stated in the scan itself: whose move
  a task's FAILURE is (`task.failure.awaits`) is read once, in
  `orchestration.failureMove`, because surfaces that are handed tasks and no
  waits ask it; `lib/runWaits` asks that reader and never names the field.
  The page's own cards are read once
  (`pendingActions.heldCards`) and handed to it as `held`
  (`PendingActionsView.held`), and from what it returns come: the strip
  (`chatStrip`), the panel's rows, its decision boxes, its `N to decide`
  and the run picker's count (`runAttention`), the Tasks button
  (`taskColumnCounts`), the chat list's line (`rowRun`, `runSummary`) and
  its badge (`pendingReading`), and the Agents page (`taskState`,
  `agentRoster`). A new surface that says or counts a wait takes a
  `RunWaits`; it does not filter gates.
- **What is proven of that, and what is only guarded.** Three tests, each
  with a limit to say:
  - `runWaits.surfaces.test.tsx` asks each surface's own function or
    component the same count and the same yes or no over a table of ledger
    shapes: a host that says `awaits` and one that does not, the card list
    delivered, not arrived, failed, and the ledger as the host really
    serialises it (`web/src/lib/__fixtures__/host`, recorded from the host's
    own tests and never hand-edited). It proves the surfaces agree when each
    is given the one reading. It builds that hand-off itself and does not
    run `App`.
  - `runWaits.wiring.test.ts` is the hand-off: it reads `App.tsx` as text
    and names each place a surface is given the cards (`pendingHeld`), and
    shows the check failing for the mutations that drop one. The Agents
    page's `held` is a required prop, so dropping it does not compile. No
    test renders `App`.
  - The scan for a second reader of `gates`, `nativeDecisions` or `awaits`
    counts the usual spellings. It is a guard against writing one by habit,
    not a proof: a computed property name, or a second sort of what
    `openGates` returns, passes it.
  A surface the table does not ask (a title, a notification, a tab's label)
  is not covered by any of this until it is added to it.
- **The host's word does not wait for the card.** A native decision the
  host says waits on the person is badged and counted with no card on the
  page (`PendingAction.cardMissing`: the list was not read yet, or its
  request failed twice: a card list is asked once more after a failure,
  `lib/listRead`, and not again within a connection). The page
  then asks for `safety_block_pending` again, once for each set of missing
  cards and once more when the badge is pressed; nothing polls.
- **What the ledger alone records is history once a run is stopped, closed
  or archived; a card the page still holds is not.** Its buttons are on the
  person's screen, so it is counted wherever it is said, and the row that
  holds a decision of the person's says Needs you whatever became of its
  task. An archived run that still holds one is not put behind Archived
  (`runPanel.splitArchived`): it stays with the runs on screen, and its
  heading keeps the decision's count beside Restore.
- **Four states, in this order:** Needs you, Failed, Done, Running. Failed
  is a failure that waits on the person with nothing else waiting on them:
  every decision of the line is a failure's own (`RunStrip.failures`), the
  dot is the danger colour and the line's word is `1 failed`. Beside a card
  or a plan it is Needs you, and what failed is still said (`2 decisions ·
  1 failed`). A failure its coordinator is fixing is neither: the line is
  Running, in grey, and says so only in its tooltip (`1 failure with the
  coordinator, which is fixing it: nothing is asked of you.`). On a host
  that does not say whose move a failure is, Failed is what it was: a failed
  task, a block with no decision open, a check whose verdict is fail, none
  of them replaced, and only while nothing waits on the person. A
  cancelled or replaced task is counted nowhere, so a run can reach its
  whole count. A stopped, closed or archived run, and a run with no task,
  draws no strip, unless something in it waits on the person: then the
  line is drawn, and a run with nothing to count yet says `No tasks yet`.
- **The count of work is asked of the host's facts, never of a row's
  state** (`runProgress.countsAsWork`): a task is counted when it completed,
  or when it is not cancelled, not replaced (`supersededBy`) and its run was
  not stopped. A row's state asks the person first, so a replaced task
  whose card is still up is a row under Needs you; counted by that state it
  came back into the total (`Tasks 0/2` with one task owed). Done is asked
  the same way. A run on the line only for such a card says `Run stopped`
  or `No tasks left`, never `No tasks yet`.
- **A task the host would refuse to start says what holds it**
  (`lib/taskHold`, one function for every surface that names a task's
  state). Three things hold a task that has not started, each a fact the
  host sends and each said in the words of the host's own refusal:
  `stopped` (the person stopped its worker: `Stopped by you`, and only their
  Start starts it again), `heldByPlan` (`Waiting for plan approval`), and
  `heldByReopen` (`Reopened · notice not yet saved`: it was reopened and the
  notice of that is not confirmed on disk). None is a decision asked of the
  person: no Needs you, no count, no badge. The row sits with what has not
  started, first in its group, with a Held mark, the hold as its line and
  the host's sentences in its tooltip and its opened detail; the Agents
  page says the same words. A reopened task used to read `Ready to start`
  there while every start of it was refused.
  - The warning colour is for a reopen held longer than a minute
    (`REOPEN_LASTED_MS`), and for nothing else here. The host confirms a
    notice on its next pass (about two seconds) and asks a transcript that
    gave none again after 4, 8, 16 and 32 seconds, then once a minute: a
    minute in, it has failed five times and is at its slowest. Before that
    it is the ordinary moment between a reopen and its notice.
  - **That minute is counted on one clock.** The reopen's stamp is the
    host's and is never compared with the browser's `Date.now()`: a browser
    five minutes fast warned at once, and one five minutes slow about six
    minutes late. It runs from when this page first saw the hold
    (`taskHold.seeHolds`, recorded as `orchestrationFeed` reads a ledger and
    as a surface draws one) to the reader's `now`, both the page's clock.
    The ledger may also say it on the host's clock alone: a task the host
    stamped a minute after the reopen, in an answer that still says the
    notice is owed, and then a page loaded late warns at once. A hold is
    keyed by its task and the reopen that is owed, so a later reopen is a
    new hold. Nothing ticks for it: `useHoldClock` sets one timer for the
    moment the earliest hold lasts, so the warning arrives in a run where
    nothing else moves. First sights are in memory: a reload starts the
    minute over unless the ledger shows it has passed.
  - A task the person stopped is left `failed` by the host and did not
    fail: it is not stuck (`isStuck`), not an attention count, not a
    failure on the strip, and its row offers the one start the host
    accepts, `Start it again` (`retryOf` the stopped attempt). The strip
    says `1 stopped` as its second count where no other run, failure or
    worker takes it, with or without a plan to approve.
- **One reader decides whether the page may start a task**
  (`taskHold.startControl`, `startBlocker`). A task has at most one control
  that starts an attempt, and `StartButton` draws every one of them: `Start
  it again` (the person's Start of the attempt they stopped, and the only
  start a stopped task offers), `Start next attempt` (ready again after an
  attempt completed), `Start retry` (failed or blocked, with nothing open
  that holds it). A start the host would refuse stays on the page switched
  off (`aria-disabled`, no handler) with the reason beside it, asked in the
  host's own order (`reserve_attempt_for`): the plan holds the task
  (`heldByPlan`, which the host says of a failed or blocked task too), its
  reopen is not told yet (`heldByReopen`), it was replaced. A run that is
  stopped, closed, completed or archived offers none. A new control that
  starts an attempt is a `StartKind` there, never a button of its own:
  Task details used to offer an enabled `Start next attempt` on a reopened
  task the host held. `taskStart.test.tsx` scans the panel for a second
  sender and for a start label written outside the reader.
- **The ledger's status in a task's details is said as the ledger's**
  (`taskHold.statusLine`): `Ledger status: Working`, kept apart from what
  the worker's process is doing. A task something holds leads with the
  hold, `Task: Reopened · notice not yet saved · ledger status: Ready`,
  `Task: Stopped by you · ledger status: Failed`: never `Task: Ready` of a
  task that cannot start. `AgentTaskBoard` and `TaskMeter` still print the
  raw word and are mounted by nothing (only their tests import them).
- **"Completed" is not "done", and how a task ended has one reader.** The
  host calls a task `completed` when its worker settled it, and a review
  that completed with a failing verdict still holds what depends on it
  (`releases_dependants`). So the ledger's status word is compared in one
  place, `lib/orchestration`, beside `isStuck`: `isSettled` (the worker
  settled it, whatever its check said: it takes no worker, its result can be
  accepted, its worker can be archived), `checkFailed` (settled with verdict
  `fail` and not replaced) and `finishedWell` (settled and its check did not
  fail). Only `finishedWell` is ever called or counted "done"; a surface
  that counts settled tasks says "settled" (`Tasks settled`). Accepting a
  result does not lift a failed check, because the host goes on holding its
  dependants; a replaced one is history; a check with no verdict (old
  records) did not fail.
  - **A failed check is never done, and it is a failure like any other.**
    It is named `Check failed` (`CHECK_FAILED_LABEL`, never "Done · check
    failed") and never counted done, on every surface. Whether it is shown
    AS a failure, in the danger colour and counted failed, is the next
    rule's to say, as for a task that failed or is blocked.
  - **A failure is quiet until the person must decide** (the person's
    decision of 2026-10-13; `orchestration/retry.rs`). The host says whose
    move each failure is (`task.failure.awaits`), and it is read in ONE
    place, `lib/orchestration`, beside the readers above: `failureMove`
    (`coordinator`, `person`, `history`, `none`, or `unsaid` for a host that
    says nothing), `failureOf` for what it failed as and why, `failureShown`
    (`red`, `quiet`, `history`) for a surface that is handed tasks alone,
    `isRetrying`, and `shownRunStatus`. Every surface asks one of them and
    none works a failure out again:
    - *The coordinator's* (retries remain): no danger colour, no warning
      colour, counted failed nowhere. Its row is under Running with the grey
      word `Waiting on the coordinator` (`COORDINATOR_WORD`), or `Retrying`
      (`RETRYING_WORD`) while the host says a retry is at work
      (`task.retrying`); a retry's worker that is stalled or disconnected
      keeps the host's word for that, in the warning colour, as any worker
      does. The opened row and the tooltip say it in a sentence (`Its
      coordinator is fixing it: 1 of 2 automatic retries used. Nothing is
      asked of you.`). It is not in the chat list at all: no `N failed`, no
      tint. Its fail pill is the row's ink, and the acceptance line still
      says `Failing`, in no colour.
    - *The person's* (retries used, the coordinator asked or is gone, a peer
      request's time is used): the one failure that is red. Its row is
      under Needs you, in the danger colour, under the word of what it
      failed as (`FAILURE_WORD`), and it is ONE decision in
      `lib/runWaits`: the gate the coordinator opened about it
      (`gate.aboutTaskId`, tied to the task's row) when there is one, else
      the failure itself (`failure:<task>`). Never both. It is counted
      wherever decisions are (the badge, `N to decide`, the Tasks button),
      and where every decision is a failure's own the surface says it as
      what failed: the strip's state and word (`1 failed`), the run's
      attention button and the run picker (`1 failed`, danger), the chat
      list's line (`1 failed · 0/1 done`, danger), the Agents page (state
      `failed`), who a run is with and a mission's crew (`failed`). `N
      failed` in red means exactly this on a host that says.
    - **A red row never only says it failed** (`runProgress.failureNote`).
      One sentence, in words on the row itself (`.orch-task-ask`: folded or
      open, wrapped, never cut, never a tooltip alone): why it is theirs, in
      the host's terms (`because`), and what moves it. The row's one start
      where the host takes one (`taskHold.startControl`; no second start
      control), the decision above the rows for one the coordinator put to
      them, or, for a settled check that takes no worker, `ask the
      coordinator in its chat, or stop or archive the run` with a button to
      that chat. With the coordinator's chat gone it says so and offers no
      way there.
    - **A gate about a failed task is answered on the page.** It is drawn
      in the Needs you box named for its task, and its button is `Answer`:
      the socket's `orchestration_gate_resolve`, like a peer request's
      gate, never a message through the main chat. Only the person's own
      answer gives the task its retries back.
    - *History* (`awaits: "nobody"`: replaced, or its run was stopped,
      closed or archived): not red, counted nowhere. A replaced one reads
      `Replaced`, as before; the other is listed in the panel's Finished
      group under a muted `Failed` with its details, and offers no start.
    - **Whether a failure is history is the host's word, never the run's
      status.** The host calls a run `failed` or `completed` when nothing
      else is left to run, which is what an unanswered failure leaves
      behind: such a run has not ended. So a run's status is drawn through
      `shownRunStatus` (failed only when a failure waits on the person,
      running while its coordinator is on one), and a task of it the
      coordinator is fixing is current work on the Agents page.
    - **A host that does not say reads as it did** (`saysFailures`: no
      `retryLimit` on the task). A task that failed, one blocked with no
      decision open and a check whose verdict is fail are failures in the
      danger colour, listed first under Running, counted failed; the chat
      list's line is `Needs you · 1 failed · 0/2 done` or `1 failed · 0/1
      done`; a run the host calls completed, failed or stopped is history
      on the Agents page.
  - **The Agents page asks the panel's reading** (`taskReading`) and does
    not work a failure out again: what the row calls failed is the agent
    state `failed` there (chip `Failed`, danger dot and word, `1 failed` in
    the summary, ranked after Needs you), under the row's own word:
    `Failed`, `Blocked`, `Check failed`. `Blocked` stays the warning colour
    and is only ever a wait (an open decision, no capacity). A failure the
    coordinator is fixing is `Queued` there under the row's own grey word,
    and a retry at work is `Queued` or `Working`. What finished well is
    folded away there.
  - **The chat list's line** is the strip's own word, what failed, then
    done of the tasks that count: `Needs you · 1 failed · 0/2 done` beside
    another decision, `1 failed · 0/1 done` when the failure is the only
    one. A wait on the person is the decision colour and a failure the
    danger colour (`data-tone`); nothing to count is left out, never "0/0".
  - `finishedWell.surfaces.test.tsx` asks every surface the same done and
    failed counts over ten ledgers (the host's four `plan_after_*` and one
    that finished well, each beside a pending plan and with no plan), then
    over the host's seven failure ledgers (`failure_*`, `retry_executing`):
    the counts, the row and the row as drawn, the strip, the chat list's
    line, the attention button, the run's status, who the run is with and
    the Agents page. It scans the source: the string `"completed"`, a
    task's `.verdict`, and what the host says of a failure (`task.failure`,
    `retryLimit`, `.retrying`, `aboutTaskId`) are allowed per file, with an
    exact count and a reason. A new filter or count that compares a task's
    status with the word, or reads a failure's move itself, fails it; ask
    one of the readers instead. `scripts/test-quiet-failures.mjs` draws the
    same seven ledgers in the real App at 1280 and 390.
- **A chat that coordinates several runs has one line** (`chatStrip`): a
  run that waits on the person outranks a newer one that runs, a failure
  outranks plain progress, the decisions of every run of the chat are
  counted (`ledgerWaits`), and with more than one run on the line it says
  how many (`2 runs`; under 400px that second count gives way and stays in
  the tooltip).
- **Groups: Needs you, Running, Finished, Planned. There is no fifth.**
  A heading says what it counts (`groupHeading`): Needs you counts the
  decisions of its rows, like the strip (`Needs you · 2 decisions` for two
  cards of one worker), and the others their tasks (`Running · 4`, spoken
  `Running, 4 tasks`). A decision of the run itself, its plan or a gate
  with no task, is no row and is drawn in its own box above the groups.
  Finished is the only one that folds and starts folded; Finished and
  Planned show three rows and a line for the rest, which is a disclosure
  (`aria-expanded`, `aria-controls`); pressing it puts the keyboard on the
  first row it showed, on the row's summary or, for a task with no worker
  chat, its details disclosure (`ROW_FOCUS`). A failure that waits on the
  person is a row of Needs you, in the danger colour. Under Running, a
  stalled or disconnected worker leads with the host's label in the warning
  colour; a failure the coordinator is fixing and a retry at work are in
  grey, in the plan's order. (On a host that does not say whose move a
  failure is, what failed is listed first under Running, in the danger
  colour, as before.) An empty group is not drawn, and the task on screen
  is never behind a fold.
- **A row's words are the task's title and the host's own label, with one
  exception that is exact.** While an attempt of the task is executing (the
  row's `flight`) and its worker's report marks a step active, the folded
  row's third line names that step after its place in the checklist: `1/7 ·
  <the step's title>` (`runProgress.rowStep`, `stepAtLabel`, `stepOneLine`).
  The number is where the active step stands in the list, not how many are
  done. It is the step's title and nothing else of the worker's: one line,
  cut with an ellipsis, drawn as text (never markdown, never a link, its
  line breaks as spaces), with the whole title in the tooltip and in the
  Steps tab, so it is never behind a hover alone. A row that is planned,
  held, finished, failed or closed, one whose worker is stalled,
  disconnected, retrying or preparing, and one that waits on anybody keeps
  the count alone (`0/7 steps`) or the host's word, which always comes
  first. A report older than ten minutes (`STEP_STALE_MS`) has its step
  muted and the tooltip says when it was reported. The worker's summary, a
  path, a commit and what it is running stay behind the row's disclosure
  with everything the row had before (state word, kind, size, environment,
  branch, checklist, brief).
- **An opened row is its status line, what starts or decides, then two
  tabs.** The status line (state word, last step, branch) stays on top.
  Under it, above the tabs and so on screen whichever is open, in this
  order:
  - a hold's sentence, and whose a failure is when nobody here has to act
    on it;
  - the decision the task waits on;
  - the task's one start (`Start it again`, `Start next attempt`, `Start
    retry`, with the reason when it is switched off);
  - what the person decides about the task's workspace (`DeliveryActions`,
    one row of buttons): `Refresh delivery status`, `Continue after review`
    (its box for the fixes and `Reopen task in this workspace`), `Clean up
    worktree` and `Abandon workspace…` (their question, `Keep worktree` and
    `Confirm removal`), and `Remove validation checkout`. A question is
    drawn in the row's place, never in a tab.

  **Nothing inside a tab sends a command**, with one exception that is
  counted: `Archive worker` and `Restore worker` on an attempt in Task
  details, which hide a worker's chat from the list and bring it back,
  start, stop and remove nothing, and are undone by the same button. The
  facts the workspace's decisions act on stay in Details (`WorkspaceDelivery`:
  the delivery's word, the path, the host's warnings, when git was asked
  and what it said, the validation checkouts' paths). A new control that
  starts, decides or removes goes above the tablist. `taskStart.test.tsx`
  reads the tabs for it, and follows every component drawn in them into
  its own source (`inTabs`): a scan that stopped at the row's `</article>`
  never saw the helper that drew Reopen, Clean up and Abandon in Details.

  `Steps` is the tab a row opens on: the checklist with its current step, and its count line; a
  task with no reported steps says `No steps reported yet` there and does
  not open on the other tab. `Details` is every other field: the plan card
  (project, branch, work directory, worktree, owner, model, effort, size,
  problem, goal, acceptance), peer help and the Task details disclosure.
  It is a real tablist (`runPanel.TASK_TABS`, `taskTabKey`: arrows, Home
  and End, the panel labelled by its tab; a key held down moves it once).
  The chosen tab is the row's own state while the row is on screen, by its
  task; nothing remembers it and there is no setting. The chosen tab is the
  row's ink and a rule under it, never the accent. Choosing a tab changes
  what is under the pointer, so the press is remembered like a
  disclosure's (below). The panel's scroller keeps room for a scrollbar
  that takes room (`scrollbar-gutter: stable` on `.orch-content`): on
  Windows a longer tab brought the scrollbar and made every row 15px
  narrower.
- **Colour is state.** The accent is a turn in flight and nothing else, as
  a tint: `strip.live` and a row's `flight` are true only while an attempt
  of the run is executing. A run that is all planned, or whose only worker
  stalled, is "Running" and is drawn in grey. `--decide` is what waits on
  the person, here and on the panel's decisions box, its count on a
  collapsed goal and the Tasks button; `--warn` is a problem.
  `RunProgressStrip.test.tsx` and `lib/decideColour.test.ts` read the sheets.
- **One thing moves:** the texture over the part of the strip still to do,
  while a turn is in flight. Time is in minutes (`minutesLabel`), never
  seconds.
- **The scoped read and the whole one see the same facts.**
  `chatWorkflow.chatSnapshot` keeps everything `runWaits` reads for the
  chat's runs, the native decisions included; a field added to that
  reading is kept there too.
- **What the plan holds is the task's to say** (`taskHeldByPlan`): a task
  is `Waiting for plan approval`, and a mission with a pending plan is a
  draft, only while the host's `heldByPlan` says the plan holds it. A host
  that sends the field for no task of the run leaves both reading the
  run's own approval, as before.
- **A plan waiting for approval never hides work the person must see, and
  never says nothing can start while the host would start something.** Two
  facts, two readers, and neither stands in for the other:
  - *Whether the plan stands in for the run's rows* is asked of the rows
    themselves (`runProgress.planStandsIn`): every row is done (completed
    without a failed check), closed (cancelled or replaced), or has not
    started because the plan holds it. A task that failed, is blocked,
    completed with a failed check, was stopped by the person, is running,
    waits on anybody, or is approved and waiting its turn is a row, and the
    plan is then drawn beside the rows and the run's totals: what failed
    by whose move it is (under Needs you in the danger colour when it is
    the person's), a stopped task with `Stopped by you` and its `Start it
    again`. A mission draws its rows always, and
    its totals by this rule too. `planHoldsRun` counted failed,
    completed-with-a-failed-check and stopped as finished, and hid all
    three behind the card.
  - *Whether nothing starts* is the host's to say
    (`taskHold.planHoldsEveryStart`): only while nothing is running and
    `heldByPlan` is true of every task that could take a worker (unstarted,
    failed or blocked; a completed, cancelled or replaced task takes none).
    Then the card says `No worker starts until you approve.` and the line
    under it `The tasks start once the plan above is approved.`; otherwise
    `What you approved before goes on. The rest waits for this.` and `The
    tasks you have not approved start once the plan above is approved. The
    ones you approved before go on.` A mission is a Draft only while this
    holds. The host starts a retry of an approved task that failed while
    the plan waits, and the card used to say no worker starts.
  A new place that chooses between the plan and the rows asks the first; a
  new sentence about what starts asks the second. A host that says
  `heldByPlan` of no task reads as before for the sentence (a pending plan
  holds every start) and for an unstarted task's row; a task of its that
  failed, is blocked or was stopped is a row all the same.
- **Whether an attempt can go on is the host's sentence, not the page's**
  (`runWaits.decisionSummary`). `continuation: "unavailable"` was read as
  `cannot resume; a new attempt is needed`. The host sends it for a safety
  card the person still has to answer on an attempt that is also blocked on
  a gate, and for a refusal the worker carries on past: both false. The
  row's chip gives the host's `recovery`, is never `cannot resume` for a
  decision that is the person's, and calls a refusal nobody can approve
  `Refusal recorded`.
- **The page is tested against the ledger as the host serialises it**
  (`web/src/lib/__fixtures__/host`, loaded by `hostFacts.ts`; the README
  there says which host test answers each and how to record it again).
  Never hand-edit one. A field the page reads from the host is first read
  from one of these: a fixture written by hand is how the three readings
  above came to be wrong.
- **Hiding the strip** is remembered against what it said
  (`octiq.v2.runStripHidden`, one signature per run): it comes back when a
  task settles, something asks or something fails, and not because a worker
  started or stopped.

**The run column's place is held before the ledger answers**
(`lib/runColumn`). The ledger arrives after the chat is drawn, and the page
used to split in two then. Four things say a chat has a run before the
ledger does: the host's `coordinatesRun` on the chat's own index entry, a
task chat's reserved `orch-` id, a task chat open beside the chat (the route
or the remembered choice), and the chats this browser last saw coordinating
(`octiq.v2.runChats`). The held column is empty until the ledger fills it.
`coordinatesRun` holds the column at first paint only where the page has the
entry at first paint, which is the chat as this browser cached it the last
time it was listed (CLS 0.004).

**A chat that was drawn at its full width is not split afterwards**
(`runColumn.columnAtFirstPaint`, `columnHeldShut`). Where nothing said the
chat has a run by its first paint (a coordinating chat opened cold for the
first time in a browser, on a host that does not send `coordinatesRun`, or
one that sends it only with the chat list's answer), the column the ledger
then brings starts put away, the state the action bar's Tasks button already
has: the button arrives with its counts and what waits on the person, the
line above the composer says what the run is doing, and the person opens
the column (CLS 0.003, from 0.26). Only that one paint is held to: leaving
the chat and coming back draws it with the column, a run started while the
chat is open opens it as before, and from the next load the browser
remembers that the chat coordinates. The split is never made by the
ledger's first answer, or by the chat list's, under what is already drawn.

**A linked chat that is not open yet is not drawn as a new conversation**
(`lib/arrivingChat`). On a cold open of `#/p/<project>/c/<chat>` no chat is
open until the chat list answers, and the composer drawn in that moment was
a new conversation's, with its project-and-branch row: 42px that left when
the chat opened (206 to 165px, 0.0215 of layout shift). The page keeps the
id the address asked for until a chat is on screen, the linked one is
called unavailable, or three seconds have passed since the chat list
answered; a composer drawn meanwhile has no such row (0.002 to 0.004 with
the chat list answering before the ledger). The other order is not covered
by this: when the ledger answers first, the empty page becomes the chat
with its run column in one step, 0.26, as it did before.

**A task the coordinator reopened is one folded line in its chat**
(`lib/taskReopened`, `ReopenedNote`). A coordinator may reopen an approved
task with new instructions and no new approval, and the page has to show
it: the host's durable `octiq_task_reopened` event draws `Reopened <title>
for <assignee> · attempt N` through the shared `CardFold`, with the new
instructions behind it, whole when opened. They are the coordinator's
prose, so they are folded by default and never on the strip. The line
enters once as it is said, is not replayed when the chat is read back, and
the same event read twice draws once. A line is one reopening (the task,
the attempt it starts and the host's stamp): the host numbers the attempt a
reopening will start, so a task reopened twice before it is dispatched says
the same attempt both times and still draws two lines.

**Opened, and only opened, the line offers Stop** (`taskReopened.reopenedStop`,
`ReopenedLine`). It is the one thing the person can do about words they did
not approve: the page's own `orchestration_task_stop`, asked first in the
app's dialog (`components/Confirm`, never `window.confirm`). The ledger
decides whether it is offered: a worker on the task and this its latest
reopening. Otherwise the control is off (`aria-disabled`) with the reason
beside it: no worker yet, finished, reopened again since, ledger not read.
**Stop belongs to the line's run.** The line is an event in one chat's
transcript and its task is found in the whole ledger by id, so both ends
are asked before anything is said of the task: the event's `runId` is the
run the task is in, and the chat the line is drawn in (`ReopenedChatContext`,
which `MessageList` provides) coordinates that run. An event of another
run, a chat that no longer coordinates it, or a transcript with no chat
known gets the control off with the reason, and what the ledger says is
asked again when the question is answered.
After a stop the line says `Stopped by you. Only your Start starts it again:
Start is on its row in the run panel.` in place of the control. The line
takes the ledger and the command from `TaskStopContext`, which `App`
provides: a module of the transcript must not import the socket bridge or
the ledger feed, which open a connection on import.

**An action that stops or starts work is never fired by the key or press
that brought it on screen** (`lib/pressGuard`). With focus on Stop, Enter
opened the question, the focus went to its confirming button, and a second
Enter stopped the worker. Three guards, and a new control that stops or
starts something takes the ones that apply:

- **A question puts the focus on its safe answer** (`components/Confirm`,
  and `CompleteChatConfirm`, which asks the same way through
  `useCarefulAnswer`). A second Enter or Space cancels. Tab to the
  confirming button and Enter is an answer, and Escape cancels, as before.
  The comment that said Enter was not wired to the confirming button was
  never true of a focused button. Every question is drawn anew, so one that
  replaced another has the focus on its safe answer too.
- **A held key answers nothing** (`heldKey`, `dropHeld`): the repeats of
  Enter and Space are dropped inside a question, on every start control and
  on Stop of a reopened line.
- **A pointer press that repeats the one that opened something does not
  land on what it opened.** A question remembers the press it was opened
  with (`lastPointerPress`) and its confirming answer drops a repeat in the
  same spot (`strayAnswer`, the cards' 700 ms and 8 px). `Start it again`,
  `Start next attempt` and `Start retry` have no question in front of them,
  like the page's other Starts, so the controls that bring them on screen
  or move them are remembered by the cards' guard (`notePress`): a row's
  disclosure, its two tabs (the start stands above them, and a shorter tab
  slides the row under a pointer near the foot of the panel), its Task
  details and the disclosures inside it, a group's fold and `N more`. So are
  the panel's own Stop, Close mission, Abandon and Archive buttons, each of
  which is replaced where it stands by the question it opens. A row that
  opens under the pointer cannot start a worker.
- **A task's workspace is decided the same way** (`DeliveryActions`).
  `Continue after review`, `Clean up worktree` and `Abandon workspace…` are
  replaced where they stand by their question: the press is remembered
  (`notePress`) and a held key is dropped. The question puts the focus on
  its safe answer (the box the fixes are written in, where Enter is a new
  line and the key that opened it writes nothing; `Keep worktree`), and
  Escape takes it away. `Reopen task in this workspace` and `Confirm
  removal` drop a held key and a press that repeats the one the question
  was opened with (`useCarefulAnswer`). `Cancel` and `Keep worktree` are
  remembered too, because the row comes back under the pointer, and the
  keyboard goes back to the control that asked. `Remove validation
  checkout` has no question and drops a held key.

Who asks through the shared `Confirm` is listed in `Confirm.test.tsx`,
which fails when a caller is added without it: closing a mission after its
chat was completed (`App`), discarding or overwriting a file (`EditorMode`,
`FilePanel`), deleting a project (`ProjectSettings`) or a saved command
(`TerminalDrawer`), and stopping a task's worker (`ReopenedNote`). Not
through it: deleting a chat has its own countdown, the run panel's Stop,
Close, Abandon and Archive are its own inline questions, whose safe answer
already had the focus, and Remove on an agent's or a team's row in Settings
asks nothing at all (the host refuses an agent with work in progress).

**A chat row that changes place moves there** (`lib/rowMotion`): the list is
sorted by activity, and a row that only changed position used to be
somewhere else on the next frame. Positions are read as the order changes,
never on every render.

### Attention alerts

`pty.rs` scans PTY output for OSC 9 / OSC 777 / OSC 99 (Kitty) "notify"
sequences and raises a `pty-attention` event. This is how agents that emit no
escape codes flag a terminal — run `octiq-notify` and the alert fires.

### Appearance modes (browser client)

The client offers exactly five modes in Settings: **Light**, **Dark**,
**Fun**, **Manga** and **中国风**. Their persisted ids are `light`, `dark`,
`fun`, `manga` and `guofeng`; `themeStore.ts` migrates the retired
`one-light`, `octiq`, `candyland` and `comic` ids and sends every other
retired palette back to Dark.

- Dark is the default palette in `design-system.css`. Light, Fun, Manga and
  中国风 are the palette files under `web/src/lib/themes/`.
- `web/src/lib/theme.ts` translates their shadcn-shaped tokens (`--primary`,
  `--card`, `--muted-foreground`) into the app's semantic variables
  (`--accent`, `--bg-1`, `--fg-2`). Palettes set colours and corner radii only —
  never fonts or shadows. A palette may name its radius rungs outright
  (`--radius-sm/md/lg/pill`), which is how Manga gets uneven hand-cut corners.
- **Manga and 中国风 change more than colour.** Each has its own sheet next to
  `styles.css`, every rule scoped to its `:root[data-theme=…]`, so no other
  mode picks any of it up. Both follow one rule: **readability wins over
  effect** — reading text stays in a real reading face, nothing is drawn
  behind words, and display lettering is for the few biggest headings.
- **Manga** (`web/src/manga.css`): thin, slightly uneven panel
  frames, solid-black (beta) marks, speech balloons, faint focus lines on the
  empty page and Dela Gothic One on the biggest headings live in
  `web/src/manga.css`, every rule scoped to `:root[data-theme="manga"]`. It is
  monochrome: the accent is ink, and only the meaning colours (ok, warn,
  danger) keep a hue. No drop shadows — a floating thing gets a white gutter
  round its frame. Frames stay 1.5–2px; a louder version (display type
  everywhere, screentone, 3px frames) was tried and rejected as too much to
  work in.
- **中国风** (`web/src/guofeng.css`): dark and cinematic. Ink-black night with
  a lens vignette at the edges only and faint film grain, 霞鹜文楷 (LXGW WenKai)
  for reading, Ma Shan Zheng brush lettering on the biggest headings, and
  cinnabar seals with pressed edges (the 流 stamp, the agent's name tag, quote
  rules). The ink is real brushwork drawn as SVG in `web/src/assets/ink/`
  (飞白 dry-brush streaks cut by turbulence noise): the stroke behind the empty
  page's question, gold brush rules, the sidebar's ink edge, the open chat's
  mark, and ink-wash mountains in mist — full strength on the empty page,
  veiled to half behind a chat so replies stay legible. The accent
  is gold, not cinnabar, because ~90 rules draw text in `--accent` and red
  text reads as an error; cinnabar is `--seal`, used by name.
- The terminal cannot read a `var()` — xterm hands its palette to WebGL. So
  `web/src/lib/xtermTheme.ts` resolves variables through a hidden element and a
  1×1 canvas.
- Text on a fill uses `--accent-fg` / `--danger-fg`, not hardcoded white.
- `vite.config.ts` keeps `test: { css: true }`; otherwise Vitest stubs raw CSS
  imports to an empty string and alternate modes silently use fallback colours.

## Orchestrated task workspaces

See [the task workspace lifecycle](docs/subagent-worktree-lifecycle.md) for the
host-owned policy. In agents mode, new runs are **missions** by default: one worktree per
repository shared by the run's tasks one writer at a time, a status board whose
Merged/Released steps come from git only, and a Close/Abandon that only the
person can trigger (`orchestration/mission.rs`). A worker settling, code being pushed, a PR being merged, and
a workspace being eligible for cleanup are separate states. Retry and review
fixes reuse the task's persisted workspace with a new attempt ID. Current
checkout mode never deletes a directory. The main chat coordinates while a
worker owns the write lease; it must not also edit that checkout.

**An approval fixes what a task runs as, and a time stamp or a parent id is
not that approval.** `approved_at` says a task was approved. `Task::approved`
(`orchestration/approval.rs`) says as what: the worker in effect when the
person approved (provider, model, effort, access, recovery policy with its
fallback model), the assignee, the destination and the base branch. Every
start is compared with it in `reserve_attempt_for`, the one door, before an
attempt is reserved: the coordinator's, the host's dispatch and recovery, the
page's. Nothing but an approval writes it. So:

- A new way to start a task goes through `reserve_attempt_for`, and a new
  thing an approval should fix is added to `Approved` and to
  `approval::keeps_to`, never checked at one caller.
- The run's defaults reach only tasks not yet approved. Read a task's worker
  through `automation::settings_for_task` or `approval::worker_of`, never
  `task.worker` or `run.worker_defaults` alone: a start leaves on
  `task.worker` whatever it launched, a recovery's fallback model included.
- Only a subtask its parent's own manager split goes by the parent's approval
  (`Task::split_by`, read through `approval_parent`). A task the coordinator
  creates with `parentTaskId` is new work: on the plan card, held, and not
  the parent's manager's to accept. A new rule about subtasks asks
  `approval_parent`, never `parent_task_id.is_some()`.
- `reopen_task` keeps the approval and changes only the words. It records
  each reopen on the task and writes `octiq_task_reopened` into the
  coordinator's transcript, so the person sees every one. A new field a
  reopen could change belongs in that event.
- **A reopened task starts only once that notice is in the transcript and
  confirmed on disk.** The notice stands in for an approval, so it is
  tracked like one: `TaskReopen::notice_delivered` is false from the reopen
  (and for a record that does not say) until the notice is confirmed on
  disk, `reserve_attempt_for` refuses the
  task meanwhile (`heldByReopen` in the snapshot), and the scheduler writes
  what is owed (`deliver_reopen_notices`), backing off to once a minute
  while a transcript gives no confirmation. The event is made from the
  stored reopen, so every try writes the same one, and one already in the
  transcript is never written twice. **Neither a line that can be read
  back nor an append's own answer is a receipt**: a notice is recorded
  only after the record as it is now and then its folder have been synced
  in that same pass, under the append lock, and both succeeded
  (`workspaces::notice_receipts`, whose every `true` follows one
  `transcript::confirm_synced`). That holds for a line just written and
  for one found there, for a file that existed and for one compaction
  replaced: `append_synced` syncs the folder only for a file it made. **A
  receipt is for the record the line was seen in**: the page's `/clear`
  (`chat_forget`) removes a record whose chat stays listed, and the next
  line said there makes a file that syncs and holds no notice. So
  `notice_receipts` takes the record's `transcript::Generation` before it
  reads, `confirm_synced` refuses one that has moved, and the next pass
  writes the notice once into the record that is there. **The token names
  its file** (`transcript::identity`: the folder as the filesystem resolves
  it and the name, folded where two spellings are one file), so one taken
  for a file is refused on any other whatever their numbers: every file
  that never moved on used to read the same. Whatever removes a
  record, or replaces a host event's line in one (known by parsing the
  line's top-level `type`), goes through
  `transcript::forget`, `forget_file` or `rewrite_numbered`, which move the
  generation under the append lock; a new path that deletes or truncates a
  record file does the same, never a bare `remove_file`, and the page's file
  editor refuses one (`paths::host_owned`). A `/clear` after
  delivery removes the notice with the chat's history and is not undone. A
  reopen whose coordinator
  chat the person cannot open (not in the chat list, or in the trash) is
  refused. **One reopen owes no notice: the person's own, where that chat is
  gone.** The notice stands in for an approval of words the person did not
  write; these they wrote, on the page, and there is no chat left to show
  them in, so the reopen is recorded as told (`reopen_task_as`) and its
  start is not held. Where the chat is there the person's reopen owes its
  notice like any other, and the event says `byPerson`. A chat list that
  cannot be read is not a chat that is gone: that reopen is refused. A write whose receipt says whether it held
  (`record_chat_event_synced` answers `Option`) has that receipt read: a
  step that only counts once the person was told waits for it.
- A replaced task (`superseded_by`) and a task the person stopped
  (`Task::stopped`, from the socket-only `orchestration_task_stop`) do not
  start again; only the person starts the second.
- A review of an approval boundary checks the shape that actually runs
  against a durable source of authority.

**A failed task is its coordinator's to fix, twice, before the person is
asked** (`orchestration/retry.rs`; the person's decision of 2026-10-13). A
failure is a task that failed, one its worker reported blocked with no
decision open, or one that completed with a failing verdict; a task the
person stopped did not fail. So:

- **The budget is counted at the one door, and at a replacement.**
  `Task::retries_used` goes up in `reserve_attempt_for`, with the
  reservation, for every start of a task in failure that is not the person's
  (`retry::counted`, `retry::started`): the coordinator's, the host's
  dispatch of a check that was reopened, the host's own recovery. At
  `retry::RETRY_LIMIT` (2) the door refuses in `retry::RETRIES_USED`'s words.
  A new way to start a task goes through that door, so it is counted; a new
  way to get a failed task going again that is not a start (as
  `reopen_task` and `supersede` are) asks `retry::allows` first, and a
  replacement uses one and carries the count on (`retry::replaced`).
- **No count and no budget reads a fact that exists to be shown.** A failure
  has two readings and they differ on purpose. `retry::failed_as` is what is
  SHOWN (`Task::failure`, a plan item's progress, the notice to the
  coordinator): it says nothing of a failure the host has scheduled its own
  recovery of, because nobody is asked about that one. `retry::counted` is
  what an act right now would answer, for everything that is counted: that
  scheduled recovery is a failure there, and so is a failed check that was
  reopened. `retry::allows`, `retry::started` and `retry::replaced` are
  given `counted`, never `failed_as`. A replacement read the shown one,
  found no failure in a task whose recovery was scheduled, and was neither
  held to the budget nor counted: the limit could be gone round without end
  (review of 16e4188, H1). `retry_tests::who_reads_what_a_failure_is_shown_as`
  names every caller of `failed_as` with what it does with the answer, and
  fails for a new one: that is where "does this decide something?" is
  asked. The one caller that decides is `create_gate` (is this question
  about a task in failure), and where the two readings differ it refuses.
  The same holds for every derived fact the page reads (`heldByPlan`,
  `heldByReopen`, `retrying`, `failure`, `awaits`): they are written onto a
  copy for the answer, and nothing in the host reads them back to decide.
- **The host's provider recovery keeps its own count, and shares the
  task's.** `execution.retry_count` is the recovery policy's: how many host
  recoveries in a row led to an attempt, compared with the policy's
  `maxRetries` and used for the backoff. `Task::retries_used` is the shared
  total of 2 that every automatic retry uses, the host's included.
  `execution::fail` schedules a recovery only while both allow one, so the
  most a task is started again without the person is 2 whoever starts it,
  and a policy can allow fewer. Anything new that restarts a task for the
  host is a `StartedBy::Recovery`.
- **Only the person gives more**, and each way is one no agent's call
  reaches: their Start (`StartedBy::Page`), their own reopen of a completed
  task from the page (`ReopenedBy::Person`), their answer on the page to a
  decision about the task (`ResolvedBy::Person` on a gate with
  `about_task_id`), their approval of a plan the task is put back on. A task
  that finishes well is also at zero again. A new reset is one of the
  person's own doors, never an argument an agent can send.
- **A reopen has two doors, like a start and a gate's answer**
  (`ReopenedBy`). The coordinator's comes only through `/hook/orchestration`
  (`task_reopen` → `orchestration_task_reopen_in_chat`, which the socket
  refuses and the plan's Start gate holds) and is held to the budget. The
  person's comes only through the socket (`orchestration_task_reopen`,
  which no hook action maps to): it is taken when the retries are used,
  gives them back, closes the decision the coordinator opened about the
  task (`retry::person_decided`, which their Start calls too), and the
  first start after it is theirs and uses none, whoever carries it out
  (`workspaces::persons_reopen`, asked at the door). Without it a failed
  check whose retries were used had no door at all once its coordinator
  was gone: the page's Start is refused for a completed task. A new thing
  the person may do about a task that an agent may not is a new variant
  chosen by the route in `dispatch`, never a field of the request.
- **A gate about a failed task is not that task's gate.** The coordinator
  names the task in `orchestration_gate_create`; on a task in failure the
  host records `Gate::about_task_id` and leaves `task_id` empty
  (`create_gate`). Everything that reads a task's gates by `task_id` (is
  the attempt live, resume its worker, the next attempt's brief, a peer
  request's own snapshot) therefore does not see it, which is the point:
  nothing of the task waits on it. A reader that means "a question about
  the whole run" asks `Gate::holds_run`, never `task_id.is_none()`.
- **Whose move a failure is, is derived** (`Task::failure`, `retry::derive`
  in `snapshot`): the coordinator's while retries remain, the person's once
  they are used, the coordinator escalated, its chat is gone
  (`chat_index::listed_ids`, read once a snapshot and only when a failure
  asks; an index that cannot be read is not "gone") or a peer request's
  time is used, and nobody's for a replaced task or a run that was stopped,
  closed or archived. **A run the host calls `failed` or `completed` has
  not ended**: `recompute_run` sets those when nothing else is left to run,
  which is what an unanswered failure leaves behind.
- **The coordinator is told what is expected in the notice of the failure**
  (`retry::expectation`, appended where a failure is told: a worker's
  report, `execution::fail`, a recovery that could not start, a worker lost
  to a restart) and in the master brief (`retry::BRIEF`). A new place that
  tells a coordinator of a failure appends it too. Both travel as a turn's
  prompt (and the brief in a tool result): stdin for Claude, Codex's
  app-server and Antigravity, but the last argument of a command line for Pi
  and for Codex started as `codex exec`, where Windows' 32,767 characters
  count. `retry_tests` holds what the rule adds to a paragraph (876
  characters in the brief, at most 824 in a notice).
- A peer request follows the same budget and waits on its run's
  coordinator, whose one repair is the same job again; with its working
  time used it is the person's.

**Removing an agent and starting its work take two locks in one order: the
roster's (`team.rs` `LOCK`), then the ledger's (`OrchestrationStore::inner`).**
`team::delete_checked` hands its write to a guard (`team::Leave`); the host's
(`agent_work::Departure`) holds the ledger across that write and records the
agent in `Stored::removed_agents` before it lets go, and `reserve_attempt_for`
refuses a removed agent under the same lock. Nothing that holds the ledger's
lock may call into `team.rs`. The chats' locks come after both and are never
waited for from a removal: the session table, the queue and each session are
tried (`LeavingMark::working`), and one that is taken answers "working". A
removal made any other way (a bare check, then a write) reopens the window a
task started in. What stops a removal is in `agent_work.rs`: a task in
progress, a run one of the agent's own conversations coordinates that has
not finished or been stopped, a turn in flight in one. An idle head or front
desk is removed.

- **A removal is done only when its record is.** `OrchestrationStore::leave`
  saves the ledger with the agent in `removed_agents` FIRST and writes the
  roster second, so every failure leaves the agent registered and working: a
  ledger that cannot be saved refuses the removal with the roster untouched,
  and a roster that cannot be written has the record taken back (and says so
  when even that fails). The running server takes the record up only after
  both. A server killed between the two leaves a record for an agent the
  roster still has; `reconcile_removed`, run when the ledger is loaded,
  drops it. A roster that cannot be read changes nothing: never read "could
  not be read" as "everyone is gone", or as "everyone is here". A new step
  that changes two files orders them the same way: nothing irreversible
  before the record is on disk, and a save that fails is a refusal, never a
  line in the log.
- **A prompt and a removal of its agent never both go through: mark first,
  then look** (`agent_chat::Leaving`). `Departure::leave` marks the agent's
  own conversations (`ChatManager::mark_leaving`) before it asks whether any
  is working, and a live process takes the mark under its own lock in the
  look that finds it idle. `write_user_message_locked`, which every prompt
  goes through, refuses a session that carries it, beside its `CutOff`
  check; `start_session` refuses a chat the manager holds one for, under the
  session table's lock. So the write saw the mark or the removal saw the
  turn. Dropped without `gone`, the mark is called off; a removal that was
  made leaves it, in memory, until the server restarts. A new way to hand an
  agent a prompt goes through one of those two functions, never around
  them, and a new check of "is this chat idle" that something irreversible
  follows is made the same way: a look alone goes stale the moment its lock
  is let go.

**Facts the page reads that are derived for the answer are never stored and
never taken from an agent**: `heldByPlan`, `heldByReopen`, `failure`,
`retrying` and `retryLimit` on a task, `awaits` on an open gate and a pending
native decision, `usage` and `context` on an attempt, `coordinatesRun` on a
chat's index entry, `awaitsStart` on a chat's plan and `progress` and
`linked` on its items. Each is
`skip_deserializing` or added at the dispatch arm, and absent rather than
zero or guessed when the host does not know (`docs/agents-mode.md`, What the
run panel reads from the host). **Not read back is half of "never stored";
the other half is not written.** A derived field of a stored struct is
`skip_deserializing` AND left out of what is saved (`skip_serializing_if`,
with a value the stored copy never holds: `None`, `false`). `retryLimit`
was a plain `u32` with `skip_deserializing` alone, and every task was saved
with `retryLimit: 0` while the answer said 2 (review of 16e4188, H3). A
ledger that holds one needs nothing done to it: the key is ignored on read
and gone at the next write. A new derived field gets a line in
`retry_tests::the_ledger_on_file_holds_nothing_a_read_derives`, which makes
real writes and reads the file. A fact the host does know is said outright:
`heldByPlan` is `true` or `false` on every task of a run that has a plan
approval, because a page sent nothing for "not held" could not tell it from
a host that does not say, and read an approved task as held. `awaits` says
who must decide and nothing else; whether the attempt can go on right now is
`continuation`'s to say. `failure` is on every task that is in failure and
on no other, and its `awaits` is the one word for whether a failure is the
coordinator's, the person's or history: a reader does not work that out from
`run.status`. What the host counts is stored and said beside it:
`retriesUsed` on the task, `retry` on an attempt that started on a failed
task, `aboutTaskId` on a gate.

**A mid-turn instruction that loosens a permission or safety rule goes through
a decision gate.** When a coordinator's `orchestration_message_send` would add
an MCP tool to `permission::host_bookkeeping` or Claude's `--allowedTools`,
turn off a confirmation or widen an access level, the worker does not act on
it: it opens `orchestration_gate_create` and acts once the decision comes back
as a turn. A worker cannot tell from a tool result whether such an instruction
came from the person, and a gate leaves the decision with them. An ordinary
scope clarification needs no gate.

**A peer request is one approved job, and nobody but the person adds to it.**
Whoever asked is the worker's teammate, not its manager, so the host delivers
a peer-request worker no coordinator's message (`record_message` refuses every
kind, from a chat and from the page) and a gate on its task is answered only
by the person on the page (`ResolvedBy::Person`: the socket's
`orchestration_gate_resolve`, which no hook action maps to). A new path that
puts an agent's words in a worker's inbox, or continues a worker, asks
`task.peer_request` first. Its worker reads only its own task of the ledger
(`OrchestrationStore::snapshot_for_agent`, by the attempt on record), so a new
read of the ledger that an agent can start goes through it too. What it reads
there is written by itself, by the host or by the person and by nobody else:
the run's coordinator registers no service for the task, makes no validation
checkout for it and names no base branch for its start
(`peer_request::PEERS_SERVICE`, `PEERS_VALIDATION`, `PEERS_BASE`), and the
run's worker defaults, recovery policy and fallback model included, are not
copied onto it. A new
field on a task, an attempt, a gate or a service that a coordinator's command
can fill with text needs the same refusal before it ships. Its `maxMinutes` is working time, and a wait is
free only while the host can verify that nothing is running: between two of
the scheduler's looks that both saw a card or an open gate with nothing
running (`Look::nothing_running`: no owed full stop, and no turn in flight
other than one parked on the very calls the cards ask about, by the
provider's id in `execution.pending_tools`). A card is not proof that nothing
runs: a tool call beside it is charged, as a gate under a running turn is.
Charging and ending are separate: an attempt is never ended in front of a
card, and one past its limit is ended on the first look after the card is
answered. Used time never goes down, and what the agent left running in the
background after its turn ended is not counted (`docs/agents-mode.md`, The
time limit).

## Conventions & gotchas

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
- **A hook that can write refuses workers by durable identity, never by
  `active_task`.** `orchestrations.active_task(chat_key)` is `None` once an
  attempt has settled, while the worker's capability still works for its live
  launch, so a check built on it lets a worker that has reported, failed or
  been reopened through. Ask `orchestrations.is_worker_chat` /
  `require_user_chat` (a `chat:orch-` key, or an attempt on record:
  `worker_coordinator`), the way `access_handler` and `agents_hook` do. Hiding
  a tool in the MCP server is not authorization. A review of such a hook
  covers the window after a worker settles. A hook that speaks for the chat's
  registered agent refuses a room seat (`session_key != chat_key`) before any
  card, as `seat_refusal`, `roster_seat_refusal` and `memory_seat_refusal`
  do. Such a hook keeps the `HookCaller`: `task_hook_caller` hands back the
  chat key alone, which is how a seat was once taken for the chat's agent.
- **A durability receipt that gates a start or an approval covers the
  current file, its folder, and that file's identity and life.** All four,
  taken in one pass under the lock appends take: the file as it is now
  synced, then the folder it is in, for the file the line was seen in or
  written to (not another the same name has come to mean), in the record
  that file holds now (not one made after the first was removed).
  `transcript::generation` is taken before the look and
  `transcript::confirm_synced` is the only thing that answers yes. What is
  not a receipt, each of which was once taken for one: a line that can be
  read back (the OS holds it), an append's own answer (it syncs the folder
  only for a file it made), "the file existed", and a number two files
  share. A new step that waits on "the person was told" or "this is on
  disk" asks the same call; it does not adopt what it finds.
- **Profile state is read from the folder fixed at startup.** Every path
  under the profile comes from `profile::profile_dir()`, and nothing reads
  `config.json`, falls back to another base, or makes the profile folder
  after `profile::pin` (see **Persistence locations**). A store pinned at
  load and a store resolved per call were once in two different folders at
  the same time. "The folder" is the directory the server took, told by
  its mark, not the path; a folder is made only through
  `profile::create_dir_all`; and a file read per call is read with
  `profile::read`, so a folder that is away is never an empty store. When
  a rule like these is fixed at one site, list every site it covers before
  changing one: the review that found the first hole found the next in a
  minute, twice. And nothing the host offers writes a file there behind the
  module that owns it: the file editor's `write_file` refuses everything in
  the profile folder but the person's own `notify-hook` and `canvas/`
  (`paths::host_owned`).
- **An action that ends work or answers a waiting agent never waits on a
  save.** Stop, interrupt, a task or run stop, a cancel, a limit the host
  enforces, and an answer to a call an agent is parked on all ACT first, or
  act whatever the save answers. The save is tried; when it fails the
  action has still happened, so the command answers as it always does and
  the failure is said beside it, never instead of it. Three parts, and a
  new ending or answering path needs all three:
  - *No `?` on a save ahead of the act.* `cancel_auto_resume(…)?` at the
    top of `chat_stop_impl` returned the schedule's write error and never
    reached `end_process`: with the profile folder away a person could not
    stop a running agent (review of 205bca2, H5). The order had always
    been there and had only worked because `create_dir_all` made the
    folder again. Ask of every `?` above the kill, the interrupt or the
    `tx.send`: is this a save? The same goes for a pass that both writes
    and stops (`recover_due_workers` stops ended workers before the part
    that writes).
  - *Say it with `unsaved::say(what, reason)`, where the save failed.*
    `dispatch::told` collects what one command said on its thread; the
    socket puts it beside the result (`unsaved: [{ what, reason }]`), an
    agent's hook result carries the same list, and every page gets the
    `unsaved` event. Do not return the save's error from a command whose
    action happened, and do not swallow it.
  - *Owe it.* The store keeps the change in memory and a flag that its file
    is behind (`auto_resume::Store::cancel`, `QuestionStore::keep`,
    `OrchestrationStore::mutate_regardless`), and
    `dispatch::settle_owed` writes every such store again, every two
    seconds while the server runs and through the same door as any save,
    so nothing is written into a missing or a replaced profile folder.
    `profile_status.owed` names what is still behind. A new store that an
    ending or answering action writes joins `settle_owed` and `owed`.

  What it does NOT cover, so these stay save-first and are refused whole
  when they cannot be recorded: an action whose point is the record
  (`chat_complete`, moving a chat to the trash, an answer to a question no
  tool is waiting on), anything irreversible (mission Close and Abandon
  remove worktrees), and anything durable a card offers. On a card, Deny
  denies and Allow allows THAT call with the save failing; an "always" or a
  stored authorization that could not be stored is refused in words and
  never assumed later (`safety_block::authorize_for_project` leaves its
  card up). Starting work is not ending it: a new turn still waits for a
  folder its record can be kept in, so an answer that reaches its agent
  only in a new turn (a gate's, to a worker whose turn ended) is taken at
  once and delivered when that turn can start. What is owed lives in
  memory: a restart before the folder is back loses it, and the disk's
  word stands (`docs/plans/profiles.md`).

  Four rules that follow from it, each found as a site the rule above did
  not list (review of b894867). They are general: check a new path against
  all four.
  - **A. Nothing that stops something running reads or saves the profile
    first.** What a stop needs to find its target is in memory, or is asked
    of the system itself (the process table, Docker): never of a file in
    the profile. The Sandbox panel's Stop read `state.json`, saved "about to
    stop" and ran Docker through files in the sandbox's own folder, so with
    the folder away the services kept running. `sandbox::Store::known` is
    what this server last read or wrote, a stop goes by it, and Docker is
    asked by the project's name alone when the frozen file cannot be read
    (`down_by_name`). Stop, down and the host's own stop ACT, then save
    (`save_regardless`), say `unsaved`, and owe the write. Anything that
    creates (a sandbox start, check or reset) reads the file and stays
    refused. A sweep for this rule lists everything that kills, downs or
    ends, and then everything each of them reads on the way there.
  - **B. An action that fails for a missing profile never discards the
    person's input.** A refusal is not a failure of the thing refused. A
    Stop on an agent that goes on only in a new process starts the first
    queued message in that process; the missing folder refuses the start,
    and the Stop then forgot the whole queue. A start refused because its
    record cannot be kept puts the message back at the FRONT of the queue,
    touches nothing behind it, and lists the chat as waiting
    (`ChatManager::keep_waiting`); the action that stopped the agent answers
    what happened (`chat_interrupt`: `{ stopped, waiting, notStarted }`),
    not an error; and the host hands the first message over itself once the
    folder is back (`start_waiting_queues`, beside the owed saves), which is
    what that provider's Stop does at once. Every path that takes a message
    off a queue to start it goes through `carry_queued_turn`, which is
    where this lives; a new one does too. Before a failure path calls
    `forget_queued_turns`, ask what refused: a deliberate ending (closing
    the chat) drops its queue by design, and even then the "not sent" line
    each bubble folds by is owed when it cannot be written
    (`record_unsent`).
  - **C. Widening that outlives the moment it is given needs its record;
    narrowing never waits on a save.** The exception above is for ENDING
    work. It was read as "an access change never waits", and a raise went
    through with nothing on disk. Ask which way a level or a grant moves. A
    raise of a chat's, worker's or run's level, a project or stored
    authorization, anything a later start or another chat reads back: the
    record comes first, and while it cannot be written the change is
    refused in words (`agent_chat::NOT_RAISED`), the card that asked stays
    open, and nothing is assumed when the folder is back. A lowering, a
    revocation, a stop: at once, said `unsaved`, written on the retry
    (`chat_set_access_impl` decides by `access_request::rank`;
    `keep_resume_context` keeps a level without its record only when it is
    no higher than the one on record). Not this rule's: the permission
    card's Always, which by design and by what the card says lasts only
    while the chat runs (memory only), and Claude's Always, whose record is
    Claude's own settings file outside the profile.
  - **D. No reply and no page says "saved" for what was not recorded.**
    `saved: true`, `status: "saved"` and the words "Saved" and "Answers
    saved" mean on disk and nothing else. An action that happened without
    its record says both halves apart (`question_answer_batch`: `{ saved:
    false, delivered: true, unsaved }`; an answered question the store
    still owes reads `status: "delivered"`), and the page says that, with
    the reason behind a disclosure and not as an error. Do not bend a
    receipt to get past a reader that throws without it: change the reader.
- **Every reader of a chat record walks it with `transcript::for_each_line`
  or a reader built on it** (`since`, `of_type`, `page`). A line's position
  is its `seq`, so a line that cannot be decoded is skipped by the reader
  and still counted: `lines().map_while(Result::ok)` ends a read at the
  first line that is not UTF-8 and shifts every number after it.
- **Carry a session or history file to a second name without ever writing
  over what is there, and promise no more wholeness than the path gives.**
  `hard_link` answering `AlreadyExists` is success, not a reason to copy: the
  loser of a race that then copies writes through its own link, which opens
  the file it is reading and empties the conversation under both names (24
  threads reproduced it in `chat_recover`). A carry that must copy, across
  devices, writes a whole copy under a temporary name and publishes it with a
  hard link, so the name appears whole and only if nothing has it; a target
  that is already there is kept unless the source is newer, and then it is
  swapped by a rename. Only a filesystem with no links at all falls to
  `create_new` plus a copy (`chat_recover::write_new`), and there the
  guarantee is narrower: no file is overwritten or truncated, but the name
  exists before the file is whole, because `std` has no publish that needs
  neither a link nor a replace. What keeps that from being read as the
  conversation: carries run one at a time (`Carrying`, a guard every carry
  function takes, made only by `carrying()` and not lendable to another
  thread), a copy that fails removes its own file before the next carry's
  turn, and the agent is started by the thread that settled, after the carry
  returned, under the claim on the chat (`Held::settle`). Another program
  reading the folder in that moment, and a server killed mid-copy, can still
  meet the partial file. Two tests pin it: one asserts that BOTH the source
  and the target are intact and byte-identical to the original after 24
  carries at once, the other pauses a last-resort copy and asserts that a
  second carry does not answer until the file is whole.
- **A mutation check of a script section switches off the one thing the
  section claims to prove, and sees that section fail.** A mock that sends
  two signals for one fact proves neither: with the first switched off the
  section goes on passing on the second. Section G of
  `scripts/test-front-desk-discussion.mjs` claims the page listens for no
  level event, and it fails when a listener for one is put back.
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

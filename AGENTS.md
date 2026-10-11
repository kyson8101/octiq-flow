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
  folders left tens of thousands of `octiq-*` entries in `$TMPDIR`. To run
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
| registered agents (agents mode) | `<profile dir>/team.json` | `team.rs` — see `docs/agents-mode.md` |
| XP awards (agents mode) | `xp_awards` in `<profile dir>/orchestrations.json` | `orchestration/levels.rs` |
| agent token usage | `<chats dir>/agent-usage.json` | `agent_usage.rs` |
| chat record compaction (size when last compacted) | `<chats dir>/.compacted-sizes-v1.json` | `record_trim.rs` |
| Antigravity plugin, settings backup | `~/.octiqflow/mcp/antigravity/` | `agent_provider.rs` |

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
  reads `chat_task`'s `workspace.exists` and shows one line above the
  composer (`removedFolderNote`). It never blocks a send.
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
  characters; `cardFold.STRUCTURAL` holds those labels and `cardFold.test.ts`
  reads `team_tools.rs` to check them. A change of more than 50 rows
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
  U+200B to U+200F, U+2028 to U+202E, U+2060, U+2066 to U+2069 and U+FEFF.
  One full-strength line under the block says how many the whole command
  holds. Only the drawing changes: `notShown` and what Allow sends are the
  text itself. Past `MARKS_MAX` (5,000) the codes are written into the text
  without an element each. Left out on purpose, for a later decision: the
  wider Unicode spaces (U+2000 to U+200A, U+202F, U+205F, U+3000, ordinary
  in Chinese and Japanese text), U+2061 to U+2064, U+206A to U+206F, U+180E,
  the Hangul fillers and the tag characters.
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
  off for good (`tooLong`, `tooLongNote`). What is still on the card differs
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
- **A repeated press is dropped** (`cardFold.strayPress`, `CardFold`'s
  document listener). Shutting the lower of two stacked cards brings the upper
  one down, and its Allow can arrive under a pointer that has not moved. A
  press within 700 ms and 8 px of the one on a disclosure, landing on anything
  but that disclosure, does nothing; a pointer that moved, or a press made
  later, goes through.
- **The question card folds nothing.** Its options and what each means are the
  decision, and it has controls on every side of where a disclosure could go,
  so opening or shutting one would slide a control under the pointer. Its
  folded state is the strip it arrives as.
- **State is the component's.** Folded for every new card; one the person
  opened stays open while it is on screen, by the id of what it asks. Nothing
  is remembered past that, and there is no setting.

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
  `lib/useChatCompletions`). The action is in the chat's own menu beside Copy
  and Delete, and is not drawn for a worker's chat, a front desk or a seat.
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
  until the synced append is confirmed, `reserve_attempt_for` refuses the
  task meanwhile (`heldByReopen` in the snapshot), and the scheduler writes
  what is owed (`deliver_reopen_notices`), backing off to once a minute
  while a transcript gives no confirmation. The event is made from the
  stored reopen, so every try writes the same one, and one already in the
  transcript is never written twice. **A line that can be read back is not
  a receipt**: it is recorded only after the syncs its append owed have
  been made and have succeeded (`workspaces::notice_receipts`,
  `transcript::confirm_synced`: the file, then its folder), whichever
  branch found it. A reopen whose coordinator
  chat the person cannot open (not in the chat list, or in the trash) is
  refused. A write whose receipt says whether it held
  (`record_chat_event_synced` answers `Option`) has that receipt read: a
  step that only counts once the person was told waits for it.
- A replaced task (`superseded_by`) and a task the person stopped
  (`Task::stopped`, from the socket-only `orchestration_task_stop`) do not
  start again; only the person starts the second.
- A review of an approval boundary checks the shape that actually runs
  against a durable source of authority.

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
never taken from an agent**: `heldByPlan` and `heldByReopen` on a task,
`awaits` on an open gate and a pending native decision, `usage` and `context`
on an attempt, `coordinatesRun` on a chat's index entry. Each is
`skip_deserializing` or added at the dispatch arm, and absent rather than
zero or guessed when the host does not know (`docs/agents-mode.md`, What the
run panel reads from the host). A fact the host does know is said outright:
`heldByPlan` is `true` or `false` on every task of a run that has a plan
approval, because a page sent nothing for "not held" could not tell it from
a host that does not say, and read an approved task as held. `awaits` says
who must decide and nothing else; whether the attempt can go on right now is
`continuation`'s to say.

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

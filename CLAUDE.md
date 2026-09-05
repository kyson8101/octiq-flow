# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OctiqFlow is an **agent workflow orchestrator**: a headless Rust server plus a
browser client that runs **real terminals in a web page** and lets you **drive
interactive CLI agents (Claude Code, Codex) from UI buttons**. The core trick: a
UI action sends `pty_write` over the socket, Rust writes those bytes to a PTY's
stdin, and the shell/agent reads them as if typed. PTY output streams back as
`pty-output` events and renders in xterm.js.

> There is **no desktop app**. OctiqFlow was a Tauri 2 desktop app with a server
> bolted on the side; the window and the whole vanilla-JS `src/` frontend were
> deleted, along with every Tauri dependency. The server is plain Rust now. If
> you find a doc or comment describing a window, an `invoke_handler!` list or a
> `#[tauri::command]`, it is stale — trust the code.

## Commands

Run everything from the repo root. **Rust + Node + pnpm are required.**

## Versioning

Every commit increments the patch version by one (`0.1.0` → `0.1.1`). The
single source of truth is `src-tauri/Cargo.toml`; update it and let Cargo refresh
the `octiq-flow` entry in `src-tauri/Cargo.lock`. The web build reads the Cargo
version automatically, so do not mirror the release version in
`web/package.json`.

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

`profile.rs` decides the profile dir; `profile_lock.rs` makes sure only one
process owns a profile at a time (a second one refuses to start rather than
overwrite the first's project list).

### The host answers its own room

A room's seats are separate processes. What one says goes into the **room's**
transcript and never down the host's stdin, so after `@dee look at this` the
host has not read a word of the answer on screen above it. It is now told:

- **Once the others have finished, and only when nobody else was waiting on
  them**, `round.rs` builds a brief of what was said (`followup_brief`) and
  sends it to the host itself (`agent_chat::send_to_host`).
- **A round is followed up once, at the end** — never between seats, which
  would break the ordering the round exists for. Not at all after a round the
  person **stopped**: cutting in is a decision that the answer is no longer
  wanted.
- **The discriminator is `DRIVEN`**, a set of seat sessions a round or the
  host's own `ask_agent` started. Nothing registers for `@dee`, and that
  absence is what says the host has not heard it. Kept separate from
  `LISTENING` because cutting in drops the listener while the seat keeps
  thinking — a late answer must still be known as the round's. Cleared when the
  turn ends, when nothing was sent, and when the process dies (`session_gone`).
- **The backend sends it, not the client.** A browser is not required for a
  room to work, and two open tabs acting on an announcement would ask the host
  the same thing twice. So `ChatManager` remembers how each host was started
  (`HostStart`, plus the session id read off its opening event) and can restart
  a host the idle sweeper ended mid-round. A host this backend has never
  started cannot be started by it — the follow-up is logged and dropped.
- **`chat-followup` is a notice, not an instruction.** The client draws the
  turn (`addUserTurn`) so a host that suddenly speaks is not talking to itself,
  and draws it as **one line** rather than its words: the brief quotes the
  answers already sitting above it. `web/src/lib/relay.ts` recognises a brief by
  its first line, so a conversation rebuilt from the transcript reads like the
  live one — a flag would be one page's memory, the transcript keeps only words.

### Both agents' full stops carry their closing words

`turn_is_over` reads `result` (Claude) and `turn.completed` / `turn.failed`
(Codex). Only Claude's carries the text. Codex's is **empty** — a usage block
and nothing else — and what it said is in the last `item.completed` of type
`agent_message` before it, so the reader keeps that line as it goes past
(`codex_said`) and `closing_words` hands over whichever half applies. Without
this a Codex seat in a round said its piece, was never heard, and was written
down as "did not answer in time" twenty minutes later.

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
  which would otherwise discard it, and starts the first message itself. Only
  for a host: a seat runs under its own key but speaks into the room's
  transcript (`is_seat_session_key`).
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
- **A room is swept as one thing.** Seats are separate processes under
  `"{room}-seat-{id}"`, and `chat_stop` only ever ends the key it is given, so
  ending a host alone strands its seats until a restart — nothing else reaps
  them but deleting the conversation. A seat that is still **answering** is the
  exception: it keeps its process and sweeps itself later.
- Why it is worth having: a chat costs ~480 MB — the agent plus its own copy of
  every MCP server it starts. Nine left open overnight held 4.3 GB.

### Attention alerts

`pty.rs` scans PTY output for OSC 9 / OSC 777 / OSC 99 (Kitty) "notify"
sequences and raises a `pty-attention` event. This is how agents that emit no
escape codes flag a terminal — run `octiq-notify` and the alert fires.

### Themes (browser client)

The client ships a theme chooser (top bar → gear → Settings). Themes are
authored in **tweakcn / shadcn** format and pasted in **verbatim** as
`web/src/lib/themes/<id>.css` — never hand-edited, so re-pasting an updated
theme is a straight overwrite. Adding one is two steps: drop the file, add a
line to `PASTED` in `web/src/lib/themeStore.ts`.

- That format is not ours. `web/src/lib/theme.ts` **translates** its names
  (`--primary`, `--card`, `--muted-foreground`) into the stylesheet's own
  (`--accent`, `--bg-1`, `--fg-2`). Two traps it exists to handle: shadcn's
  `accent` is a quiet hover tint, so `--accent` comes from **`primary`**; and
  the pasted `muted` is sometimes darker than `card`, so the `bg-0/1/2` ladder
  is built off `card`, never off `muted`. `--ok` / `--warn` have no shadcn
  equivalent — they are picked from the theme's chart colours by hue, and
  invented at the right hue when the theme has no green (Bubblegum has none).
- **Themes set colours and corner radii only** — never fonts (the terminal
  draws Menlo, and code in the chat should be the same shapes) and never the
  drop shadow (the pasted ones are built for small light cards).
- The terminal cannot read a `var()` — xterm hands its palette to WebGL. So
  `web/src/lib/xtermTheme.ts` resolves the variables through a hidden element
  **and then a 1×1 canvas**: computed style returns `oklab(…)`, which xterm's
  colour parser does not understand.
- Text that sits ON a fill uses `--accent-fg` / `--danger-fg`, not `#fff`. A
  theme's accent can be a pale yellow, and white on it is unreadable.
- **Dark only, by decision.** Only a pasted theme's `.dark` block is ever
  applied; `styles.css` sets `color-scheme: dark` once and nothing overrides it.
  A few colours are outside the theme system on purpose — the PDF viewer's white
  page, the CodeMirror One Dark syntax palette, and the tool-icon `--tint` set,
  which is a categorical palette rather than a semantic one.
- `vite.config.ts` sets `test: { css: true }`. Without it vitest stubs CSS to an
  empty string — `?raw` included — and every theme silently parses to nothing.

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

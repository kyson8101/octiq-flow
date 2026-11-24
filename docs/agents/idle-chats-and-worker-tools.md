# Idle chats and worker tools

Moved verbatim from AGENTS.md on 2026-11-24.

### Idle chats are ended, and resumed on the next message

A **chat** process (`agent_chat.rs`, not a PTY) is killed after **5 minutes**
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

Settled orchestration workers do not wait for that timeout: the existing
two-second worker scheduler releases their provider after its closing turn.
It snapshots terminal attempts off the chat locks, then uses the same locked
idle recheck (turns, background work, jobs and held queues). Open decision gates
keep their attempts unsettled. Terminal provider errors still stop immediately.
The record, workspace, resume context and reported outcome survive reclamation;
this cleanup is independent of `OCTIQ_CHAT_IDLE_MINS=0`.

Claude/Codex workers start with OctiqFlow's MCP **plus the person's own
`playwright`**; ordinary chats keep the person's configured servers. The
definition is read once from the person's `.claude.json` (user scope, then the
project's local scope, honouring `CLAUDE_CONFIG_DIR`) by `worker_browser`, and
nothing else of theirs is passed. Claude uses `--strict-mcp-config` without
dropping settings or hooks and adds ONE more `--mcp-config` file,
`~/.octiqflow/mcp/worker-mcp-<hash>.json` (0600, content addressed, never
on the command line). Codex lists inherited servers in the launch
cwd/environment, turns each off individually (the person's own `playwright`
too) and keeps `--disable apps --disable plugins`, then adds the browser as one
entry under **a name of the host's own**, `octiq_playwright`
(`worker_browser::codex_server_name` steps aside for a taken one),
`-c 'mcp_servers.octiq_playwright={command=…,args=[…],env_vars=[NAMES]}'`.
**No env value is ever on a command line** (`ps` shows it): the table names the
variables and the host sets their values in the spawned process's environment,
which Codex 0.164 forwards to the server by name (verified: listed names reach
the child, unlisted ones do not). A value that would CHANGE a variable already
in the process's environment is not carried, so the browser is simply not added.
Only a valid stdio definition qualifies for BOTH providers, judged after the
scope precedence has chosen it: an `http`, `sse` or `{}` entry adds nothing and
never affects the launch (nor does the other scope's entry step in).
`CLAUDE_CONFIG_DIR` is resolved exactly as the launch does
(`workspaces::resolved_env`, a leading `~` is the home folder). No definition,
an unreadable config or a definition the host cannot take adds nothing and never
refuses the launch; an unreadable Codex server list still does. Native/exec
Codex, resume and relaunch all use that policy; front desks keep full
isolation. Calls take the normal permission cards (no allow rule is added).
Claude in Chrome needs `--chrome`, which no launch passes. The Codex browser and
computer-use route (`cua_repl`, `node_repl`, the plugins that carry them) is NOT
given to workers below full access by default; one registered Codex agent can
opt in (next paragraph).

**A worker gets the extra MCP servers its registered agent names, at any
access** (2026-11-24; replaces "Full access 的 agent 全给", measured at ~16K
tokens per model call). `TeamAgent::worker_servers` (`workerServers`; Settings →
Agents, or `agent_register`/`agent_update`; card row `Worker MCP servers: a, b`):
at most 12 names, 1–64 chars of `[A-Za-z0-9_.-]` or space, de-duplicated,
`octiq`/`octiq_playwright` refused, Claude and Codex only, cleared on moving
provider. Every worker is isolated as above (Pi `-ne --no-mcp`) plus these. The
agent is resolved by this chat's own reservation
(`agent_chat::worker_registration`); any doubt, a front desk or a lite launch
adds none. Claude copies each named stdio/http/sse definition into the 0600
`worker-mcp-<hash>.json`. Codex leaves a named listed server on, with plugins
still off, and the first-turn gate watches it. An unknown name gets one
`worker-servers-skipped` line, never a refusal.

**A registered Codex agent can keep the person's browser and computer use**
(`TeamAgent::desktop_tools`, JSON `desktopTools`, default off; Settings →
Agents' "Keep my browser and computer use", or `agent_register` /
`agent_update`'s `desktopTools`, shown on the approval card as `Browser and
computer use: on`). Only a Codex agent may have it on (`team::apply` refuses the
rest and clears it when the agent moves off Codex). It exists because 7c90613b
(2026-11-08) took the route away from a worker that had it: the 2026-10-13
STAR SOCIAL worker made 29 `cua_repl` `js` calls through the person's Brave
(`backend: chrome, browser_family: brave`, plugin `unified-computer-use`),
which `--disable plugins` and the per-server `enabled=false` entries stopped.
What the route needs, checked against codex-cli 0.164 (`codex mcp list --json`
and `codex app-server`'s `mcpServerStatus/list`, `thread/start`,
`mcpServer/tool/call`, no model turn):

- `cua_repl` is a server **the `unified-computer-use` plugin** brings
  (`.mcp.json`), so `--disable plugins` removes it. `node_repl` is defined in the
  person's `~/.codex/config.toml`; with `--disable plugins` it still starts and
  lists `js` but is a bare REPL (no `cua` or `browser` global). The route needs
  the plugins ON, not only the servers.
- The `BROWSER_USE_ACCESS_*` names in `env_vars` are optional: the server
  starts, reaches `ready` and runs `js` with none of them set (OctiqFlow's
  server has none), and `cua_repl`'s own wrapper defaults the executor id to
  empty. Whether the browser access host accepts the call is decided inside a
  live turn ("Cannot verify browser access without the current turn" outside
  one), so the end-to-end proof is the 2026-10-13 worker run, not a probe.
- An opted-in worker's launch (`codex_worker_desktop`, set in `start_session`
  only for a Codex orchestration worker, never a front desk, when the worker's
  agent has it on AND `codex mcp list` names `cua_repl` or `node_repl`) drops
  `--disable plugins`, keeps `--disable apps`, and leaves exactly those two
  servers alone; every other inherited server (plugin ones included) is still
  turned off by name. Off, the flags are byte-identical to before (test). The
  worker's agent is read through the ledger by the chat's own reservation, never
  the task's current assignee (`worker_agent_id`: a batch chat is its batch's
  agent; any other worker chat is the assignee snapshot its attempt was
  reserved with), then the roster. A task reassigned from plain agent A to
  opted-in B leaves A's old chat resolving to A in every start path (fresh,
  queued, resume, relaunch); a missing snapshot, attempts of one chat naming
  different agents, or a batch whose attempt names another agent is "no", as is
  any other doubt (ledger or roster unreadable, agent gone). A Claude worker is unchanged; a Claude
  equivalent would be the person's own `claude-in-chrome` / computer-use MCP
  server added to the second `--mcp-config` like `playwright`, plus `--chrome`,
  which no launch passes: not built.
- Not narrowed: the other installed plugins' skills still load (`-c
  plugins."<id>".enabled=false` did not change `skills/list`, so nothing is
  claimed of it). A plugin MCP server absent from `codex mcp list` would also
  start; none was seen (`mcpServerStatus/list` shows only the three).
- The first-turn gate (`codex_mcp_ready`) now watches every kept server and
  waits for the longest `startup_timeout_sec` Codex reports for them (120 s for
  both in the person's config, capped at 120 s); Codex fails a server itself at
  that point, which the gate reads, so it never waits longer than Codex does.

**Codex MCP isolation is checked against the real CLI's resolved config, never
against the `-c` text.** A whole-table `-c mcp_servers.<name>={…}` does NOT
replace an existing server of that name: codex-cli 0.164 deep-merges it (the
person's old `args`, `env`, `env_vars` and `enabled = false` survive, and an old
`url` beside a new `command` fails the bootstrap with `url is not supported for
stdio`). A change to these flags is verified with the real
`codex … mcp list --json` under the exact worker flags, for a person's config
with no entry, a stdio entry, a url entry and a disabled entry, and with
`codex app-server` for what a server really receives.

**Codex discovers MCP tools when a turn starts**, so a worker launch that
carries the browser on app-server holds its FIRST turn until that server
settles (`codex_mcp_ready`: the `mcpServer/startupStatus/updated` for the
server says `ready`, `failed` or `cancelled`; at most 30 s for the
Playwright-only launch, Codex's own `startup_timeout_sec` default, and up to
120 s, the longest `startup_timeout_sec` Codex lists for a kept server
(capped), for an opted-in desktop worker). It only delays: failure or timeout starts the
turn anyway with one `mcp-startup` diagnostics line, and ordinary chats, front
desks and launches with no entry have no gate. Fresh, resumed and relaunched
workers share the one start path. **The wait is on a thread of its own, after
`start_chat` has returned** (`agent_chat::hand_over_first_turn`): the caller of
a worker launch holds the orchestration `workspace_ops` lock, and Task/Run Stop
take the same one. The wait holds no lock of the host's. The session reads busy
(a message sent meanwhile queues; the sweeper leaves it alone) and carries
`first_turn_held`: no turn is in flight, so an interrupt (the Stop button, a
coordinator's `interrupt: true`) sets no `CutOff`, writes nothing and fails
nothing (`interrupt_worker_turn` answers `idle`), and the first prompt still
goes first, then what queued behind it. A Task/Run Stop (`end_process`) ends the
process; its output closing ends the wait and a session that was ended has no
stdin, so the first prompt is never written. A prompt that cannot be written to a
live process ends it, so the attempt fails as it always did. **Every effect of
that thread is bound to the launch it was made for**: its failure cleanup is
`end_process_of_launch`, which compares the session Arc under the session
table's lock and does nothing when another launch of the same chat is under the
key (a Stop and a relaunch inside its window), and its diagnostics and error
status are skipped for a launch that was ended. Only the provider write is
under the session lock: the delivery line is saved after it is let go, so Stop
never waits on a slow save (`record_delivery`'s transcript append takes the
global append lock; the generic `write_user_message_locked` caller still saves
inside the session lock and is a separate follow-up). A thread that cannot be
made (`thread::Builder::spawn` fails) ends that launch the same way
(`give_up_first_turn`), with a `first-turn` diagnostics line, rather than
leaving it busy and swallowing interrupts. A browser the person configured
that is left out for an env conflict writes one `browser-skipped` diagnostics
line with the variable NAMES, never a value. `codex exec` has the
same race and no clean wait (its stream has no MCP startup state and the prompt
is a launch argument), so it is not gated. Pi's rpc process loads OctiqFlow's MCP
through its own extension (no gate on the first turn); Antigravity's plugin
settings remain unchanged.
See [measurements and limits](../agent-chat-footprint.md).

- **"Idle" is `!busy`, never "no output lately".** A turn is in flight from the
  moment something is written to the agent's stdin until its own full stop
  (`result` / `turn.completed` / `turn.failed`). An agent inside a 20-minute
  build, or parked on a permission card, says *nothing* — read silence and you
  kill the one turn that mattered.
- Why it is worth having: a chat costs ~480 MB — the agent plus its own copy of
  every MCP server it starts. Nine left open overnight held 4.3 GB.

### Token budget: the compaction window and gathered reports

A Claude launch gets `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, so the session compacts
at that size instead of near 1M tokens. An orchestration worker gets 200,000;
every other Claude chat gets 400,000. The window is raised to 100,000 plus a
third of the bytes in the launch folder's `CLAUDE.md`, `AGENTS.md`,
`CLAUDE.local.md` and `.claude/CLAUDE.md`, so a session never compacts on every
turn, and it is capped at 900,000. Parent folders are not read. Other providers
get no variable, and a value in the project's environment or the server's own
is kept (`agent_chat/auto_compact.rs`).

A coordinator's plain updates are gathered into one turn: progress, a worker's
`status` message, and a report of work that finished well. Its batch waits
until the newest pending notice is 20 s old or the oldest is 90 s old. Anything
that asks for a decision or reports a failure, and any notice already tried
once, takes the whole batch at once. This is decided at read time from
`created_at`, so nothing is stored. Notices to any chat other than the run's
coordinator, workers included, are never held, and retry backoff is unchanged
(`inbox::deferrable`, `held_batches`).

Why: an audit of 2026-11-24 measured 94% of Claude model calls re-reading more
than 100K tokens. Everything in a session's context is re-read on every call,
so keep this file's parent `AGENTS.md` short and put detail in `docs/agents/`.

# Agent chat process costs

The provider and every MCP subprocess below it belong to that chat's memory
bucket. Measure RSS with one `ps` snapshot and walk PPIDs from the isolated
backend, carrying the nearest chat root, as `memory.rs` does. RSS counts shared
pages more than once; it is not unique physical memory or a production forecast.

## Launch policy

Ordinary chats keep the person's configured MCP servers. Claude and Codex
orchestration workers default to **OctiqFlow's MCP plus the person's own
`playwright`** (front desks keep OctiqFlow's MCP only). OctiqFlow's tools include the native Memory Vault/docspace and
orchestration operations, so workers do not need another copy of those servers.

- Claude workers use `--strict-mcp-config` with the generated OctiqFlow config.
  User/project settings, permission hooks, skills and execution tools remain.
  With `--strict-mcp-config` alone a worker sees no other MCP server (checked
  from `system/init`), which also dropped the person's `playwright`. The
  person's own definition of each server in `CLAUDE_WORKER_MCP_ON`
  (`playwright`) is written to a private, content-addressed
  `~/.octiqflow/mcp/worker-browser-<hash>.json` and named by a second
  `--mcp-config`; no other server is passed and no allow rule is added, so its
  calls take the normal permission cards. An unreadable `.claude.json` means no
  browser, not a failed launch. Claude in Chrome only exists with `--chrome`,
  which no OctiqFlow launch passes.
- Codex workers list inherited servers in the actual launch cwd/environment
  and disable each with the same transport-aware overrides front desks use,
  with `--disable apps --disable plugins` (every plugin, and the connector
  server, stay off). A failure to read/validate the list refuses startup
  rather than inheriting it. The same policy covers app-server and the exec
  compatibility transport, fresh start, resume and relaunch.
- **The one browser a worker keeps is the person's `playwright`**, from the same
  definition for both providers (`worker_browser`; `.claude.json`, user scope
  then project scope). Claude reads it as a second `--mcp-config` (above). Codex
  gets it as one whole inline entry, `-c 'mcp_servers.playwright={command=…,
  args=[…],env={…}}'`: a partial override of an existing server does not merge,
  and a Codex server already named `playwright` is replaced, not also turned
  off. Only a stdio definition is taken (no `type`, or `"stdio"`; string
  `command`, `args`, `env` values), and its `env`, unlike Claude's file, is then
  on the launch line. Nothing is added, and the launch is never refused, when
  the person has no definition. Codex's `cua_repl` / `unified-computer-use` /
  `browser@openai-bundled` / `node_repl` are not given to workers:
  `cua_repl`'s browser surface needs the Codex desktop app's browser access
  host (`The browser access host is unavailable` from OctiqFlow, also in an
  unrestricted `codex app-server`) and its computer surface drives the person's
  desktop.
- **Codex builds a turn's tool list when the turn starts.** Measured against
  codex-cli 0.164.0 through `codex app-server` (`mcpServer/startupStatus/updated`
  then `thread/start` and `turn/start`): the `npx` server reached `ready` a few
  seconds after the turn began, and that first turn saw no `browser_*` tool (the
  model said so, and tool search returned nothing). With the turn started after
  `ready`, the same launch shape called `browser_navigate` and
  `browser_take_screenshot` on `https://example.com`; the screenshot came back as
  an MCP `image/png` content block (about 88 KB) and the model described it. A
  worker's first Codex turn can therefore start without a browser if `npx` is
  cold; a later turn of the thread has it.
- **The host waits for the server before the first app-server turn**
  (`codex_mcp_ready.rs`). Only a worker launch that carries the `playwright`
  entry has the gate; the reader thread watches `mcpServer/startupStatus/updated`
  for that name and the start path holds the first `turn/start` until it says
  `ready` (or `failed` / `cancelled`), the process closes, or 30 s pass. 30 s is
  Codex's own default `startup_timeout_sec` for an MCP server: past it Codex has
  already marked the server failed, so waiting longer cannot help. Any
  non-ready end starts the turn anyway and writes one `mcp-startup` line to
  `agent-diagnostics.jsonl`; nothing is refused and the wait holds no lock (the
  chat reads busy, so a message sent meanwhile queues). Fresh, resumed and
  relaunched workers all start through the same function.
- **`codex exec` has the same race and no clean wait.** Measured (codex-cli
  0.164.0, `playwright` started through `sh -c "sleep 15; exec …"`): the turn
  finished in 13 s, before the server was ready, with no `browser_*` call.
  `exec --json` carries only thread/turn/item events (no MCP startup state) and
  takes the prompt as an argument, so the host has nothing to wait on; the only
  fixes would be a sleep or a separate pre-warm process, which this does not do.
- Live check of the gate (codex-cli 0.164.0, `gpt-6-luna` at low effort,
  `app-server` with the worker flag shape, `playwright` delayed 15 s):
  without the gate the first turn ended with no browser call (`ready` came after
  the turn began); with the first turn sent after `ready`, turn 1 called
  `playwright.browser_navigate`. One gated turn is about 58,700 tokens (cached
  57,900), the ungated one 38,900. A cold `npx` with a fresh npm cache took more
  than 30 s on this machine (load average ~50) and Codex marked it failed at its
  own 30 s limit, so a package download that slow loses the browser for that
  process whatever the host does.
- Live check, Claude: a worker launch with the second `--mcp-config` opened a
  public page and screenshotted it through `playwright` (5 turns, 14 s, $0.20 on
  Sonnet).
- Pi is already one-shot and has no OctiqFlow MCP integration. Antigravity's
  installed CLI has no per-launch strict MCP flag; its personal settings are
  not rewritten to imitate one. Its existing plugin/access rules are unchanged.

No approval rule, `HOST_BOOKKEEPING` entry, capability, writable root or Windows
launch quoting rule changes. Front desks still expose only `route_chat`.

## Settled worker lifetime

The existing two-second orchestration scheduler also reclaims a settled
worker's idle provider process. The ledger snapshot is released before any
chat lock is taken. A completed/failed/cancelled attempt, or blocked report
without an open gate, is terminal; a worker waiting on an open gate is not.

The worker must first finish its tool response and closing provider turn.
The same locked idle recheck used by the idle reaper protects turns that start
after the candidate scan, native background work, registered jobs and a queue
waiting for its profile folder. Terminal provider errors retain their existing
immediate stop behavior. Records, workspaces, resume settings and task outcomes
are retained; a reaper exit does not restart or fail a completed attempt.

Ordinary idle timeout defaults to **5 minutes**, checked every 60 seconds.
`OCTIQ_CHAT_IDLE_MINS=0` still disables that sweep. Settled-worker reclamation
is independent of that setting. A shorter timeout for *unsettled but idle*
workers is a separate policy decision; two minutes is a candidate, with the
same turn/background/job/queue and decision guards.

## Reproduce without model calls

```sh
cargo build --manifest-path src-tauri/Cargo.toml --bin octiq-server
node scripts/test-agent-footprint.mjs /path/to/baseline-server /tmp/footprint before
node scripts/test-agent-footprint.mjs src-tauri/target/debug/octiq-server /tmp/footprint after
node scripts/measure-octiq-mcp.mjs /tmp/octiq-mcp-size.json
```

These RSS harnesses require Unix `ps`. The first starts a disposable loopback
backend, isolated home/profile, stub Claude/Codex CLIs and three synthetic Node
MCP fixtures per unrestricted chat. The OctiqFlow MCP itself is real. It checks
four chats (ordinary/worker for each provider), settlement, and the actual idle
sweep with a one-minute timeout override. It checks original MCP PIDs as well
as the backend tree so orphaned processes cannot look like reclaimed memory.
It shuts down the isolated service; it never connects to the live service.

The second compares default Node with size/JIT flags using five paired samples
and 25 real `tools/list` requests per process. Quiet medians were 47.89 MiB for
default Node, 49.28 MiB with `--optimize-for-size`, and 46.28 MiB with `--jitless`.
The latter's 3.4% RSS saving cost 19.1% more discovery time (219.8 → 261.8 ms for
25 requests); earlier loaded samples were unstable. No flags were adopted.
The current MCP is already a dependency-free stdio server: most of its
footprint is Node itself.
A native shim would require a separate design preserving agent-side file/media
permissions and launch capability boundaries.

Sharing a Codex app-server is also deferred: each process currently inherits
one chat's MCP capability/environment, while native approvals and reader state
are correlated to that process's thread/session. Multiple Codex threads alone
do not preserve those boundaries. No paid model was used to test sharing.

## Measured result — 2026-11-08

[Sanitized raw evidence](agent-chat-footprint-evidence.json) records both runs
and the flag experiment. The baseline binary was captured at the test-only
commit `03c019e` (implementation unchanged from `106dfe3`). Final Rust source
is `3bc52ce`; the measurement harness is `8a2fc1e`. Both final runs observed no
overlapping OctiqFlow Rust compiler.

| Same chat role | Before RSS (MiB) | After RSS (MiB) | Processes |
| --- | ---: | ---: | ---: |
| Ordinary Claude control | 150.47 | 150.39 | 5 → 5 |
| Ordinary Codex control | 150.48 | 150.45 | 5 → 5 |
| Claude worker | 150.47 | 61.55 | 5 → 2 |
| Codex worker | 150.47 | 62.64 | 5 → 2 |

The two workers together fell **300.94 → 124.19 MiB (58.7%)**. All four chats
fell 601.89 → 425.03 MiB, with ordinary controls effectively unchanged. These
are stub-provider/synthetic-extra-MCP measurements, not predicted production
savings for the person's open chats.

At the 3.5-second post-report sample, both settled workers had **zero**
processes; the baseline still held five each (302.03 MiB together). The actual
idle sweep, tested with a one-minute override and its normal 60-second polling
interval, released all remaining fixture descendants: no chat rows and no
surviving original MCP PIDs. The waits after the post-report sample were
115.45 seconds before and 111.36 seconds after. Those measurements used the
then-default fifteen-minute policy; the full default wall-clock wait was not
repeated. The later default reduction to five minutes changes only the timeout,
with the same polling interval and all turn/background/job/queue guards.

Final validation: `cargo test` passed **2,077 library + 31 binary tests**, with
18 ignored; `cargo build --bin octiq-server` passed; all **66 Node MCP tests**
passed, including instruction limits and permission/approval rules. The three
new regressions failed before the fix. The first full run caught a trailing
worker flag after the prompt; placing it before the prompt kept the original
Windows launch-line guard intact, and the final gate passed. Tests ran on
macOS; no native Windows run or paid provider call was performed. No push,
deployment or restart occurred.

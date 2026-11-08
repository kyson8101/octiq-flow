# Agent chat process costs

The provider and every MCP subprocess below it belong to that chat's memory
bucket. Measure RSS with one `ps` snapshot and walk PPIDs from the isolated
backend, carrying the nearest chat root, as `memory.rs` does. RSS counts shared
pages more than once; it is not unique physical memory or a production forecast.

## Launch policy

Ordinary chats keep the person's configured MCP servers. Claude and Codex
orchestration workers default to **OctiqFlow's MCP only**, as front desks
already do. OctiqFlow's tools include the native Memory Vault/docspace and
orchestration operations, so workers do not need another copy of those servers.

- Claude workers use `--strict-mcp-config` with the generated OctiqFlow config.
  User/project settings, permission hooks, skills and execution tools remain.
- Codex workers list inherited servers in the actual launch cwd/environment,
  then disable each with the same transport-aware overrides front desks use.
  Apps and plugins are disabled too, since they can start additional MCPs.
  Failure to read/validate the list refuses startup rather than inheriting it.
  The same policy covers app-server and the exec compatibility transport.
- This is a default host-only worker policy, not automatic task-text matching.
  There is no per-role external-server allowlist in this change. A future
  exception needs an explicit host-owned role/task policy and provider-specific
  config generation; no shell command or task prose changes the allowlist.
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

Ordinary idle timeout remains **15 minutes**, checked every 60 seconds.
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
and 25 real `tools/list` requests per process. Neither candidate showed a stable
RSS benefit in this run, so no runtime flags were adopted. The current MCP is
already a dependency-free stdio server: most of its footprint is Node itself.
A native shim would require a separate design preserving agent-side file/media
permissions and launch capability boundaries.

Sharing a Codex app-server is also deferred: each process currently inherits
one chat's MCP capability/environment, while native approvals and reader state
are correlated to that process's thread/session. Multiple Codex threads alone
do not preserve those boundaries. No paid model was used to test sharing.

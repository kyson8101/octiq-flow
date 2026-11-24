# Pi harness

Moved verbatim from AGENTS.md on 2026-11-24.

### Pi is a full harness

Pi (`pi.dev`, `pi` 1.5.x) is launched like Claude and Codex: one long-lived
`pi --mode rpc` process per chat (`InputTransport::StreamJson`, queue, Stop,
`CutOff`, idle reaper and resume all unchanged), MCP and host rules included.
The person uses it when a weekly limit is reached, to keep working on Claude
through the API.

- **Model ids are `<upstream>/<model>`** (`anthropic/claude-opus-5-5`,
  `openai-codex/gpt-5.6-sol`), passed to `--model` as-is; there is never a
  `--provider` pin when a model is named. A bare id means `openai-codex`, and
  `validate_model(Pi)` accepts a bare id only for the Codex family. Models and
  efforts come from `pi --list-models` filtered by `pi auth check` (`agents::pi_models`).
- **OctiqFlow's MCP rides an extension of its own** (`scripts/mcp/octiq-pi.ts`,
  written to `~/.octiqflow/mcp/pi/` by `prepare_launch` and loaded with `-e`).
  The extension starts `octiq-ask.cjs` and speaks MCP to it ITSELF, registering
  its tools as `mcp__octiq__*` extension tools. It does not use
  `pi.registerMcpServer`: Pi merges `~/.pi/agent/mcp.json` and a trusted
  project's `.pi/mcp.json` into the same registry, and an entry there named
  `octiq` (or a `-`/`_` variant) replaces a registered server of that name
  (docs/mcp.md), which would hand a stranger the host's trust. `--tools` is an
  allowlist and hides MCP tools that no entry names, so launches add `mcp__*`
  (ordinary) or `mcp__octiq__*` (isolated).
- **The gate trusts a tool the extension registered, not a name.** Every
  `/hook/pi-tool` call carries `hostServer`: true only when the tool is one of
  the extension's own (its `sourceInfo.path` is the extension file, resolved).
  `pi_gate` treats a `mcp__octiq__*` call without it as an impostor (`Kind::Impostor`):
  refused at Read, asked at every guarded level, never allowed on its own
  `readOnlyHint`, and a front desk's `route_chat` needs it too. Absent means no.
  A host tool shadowed by a configured server is said in a startup notice
  (`MCP servers need attention`). A host server that cannot start is said the
  same way and leaves the tools unregistered.
- **Isolation**: a front desk or any worker runs `-ne --no-mcp` (the
  person's own extensions and Pi's whole MCP support off; the host's server is
  reached by the extension alone, so no `mcp.json` server connects); a front
  desk also loses skills, prompt templates and context files and has the one
  tool `mcp__octiq__route_chat`. An ordinary chat keeps the person's own
  servers; OctiqFlow's tools win their names there (harness scene 9b).
- **What Pi itself writes under `~/.pi`**, which OctiqFlow does not control:
  production launches pass no `--session-dir`, so Pi saves each conversation as
  `~/.pi/agent/sessions/--<folder>--/<time>_<id>.jsonl` (what the moved-chat
  resume below reads), refreshes `auth.json` when a login token renews, and
  keeps its own `models-store.json`, `settings.json` and `mcp.log` there.
  OctiqFlow itself writes nothing in `~/.pi` or in the project's `.pi`: its
  files are under `~/.octiqflow/mcp/pi/`.
- **Host rules and preferences** go in a content-addressed file
  (`~/.octiqflow/mcp/pi/prompts/<hash>.md`) named by `--append-system-prompt`,
  never on the command line.
- **Access is a `tool_call` gate** in the extension, which asks
  `/hook/pi-tool` (`pi_gate.rs`) with the launch capability; any failure
  blocks. Offered levels are Read, Manual, Edits and Full (Auto is accepted at a
  launch, a failover or a worker and runs as Edits). Read keeps only read tools;
  Full is unguarded. The host decides by the level the chat was started at
  (`access_now`); `access_change_relaunches` makes any change end the process
  between turns and resume it. Front desks allow only `route_chat`.
- **A refused Pi call keeps standing plan approval from firing.** The gate
  runs in the hook handler, so each call takes `ChatManager::pi_call_begin`
  before it decides (the session lock for an instant, no await, never the
  ledger) and `pi_call_end` when it has answered. Every refusal latches the
  session's `auto_plan_refused`, the latch Codex uses: the host's own deny
  (`Verdict::Deny`), an impostor's, the person's Deny on a card, and a card
  nobody answered (the request dropped, the extension gone: `OpenCall`'s
  drop refuses). A call that is parked on a card is also counted in
  `auto_plan_turn.open_asks`, and `end_turn_for_auto_plan` approves nothing
  while one is open. The call carries the launch id, the prompt's write id and
  the turn sequence it began in; an answer that arrives for another launch,
  prompt or turn touches nothing, so a late answer from an older turn neither
  latches nor clears the current one. An allowed call changes nothing.
  `scripts/test-pi-plan-refusal.mjs` drives the real server with a stub Pi:
  a Read lead's refused `bash` leaves the plan pending, an allowed `read`
  approves it (the control).
- **`run_with_limit` returns by its deadline in every case** (`agents.rs`, the
  `pi --list-models` and `pi auth check` probes). The reader thread reports
  over a channel, never a `join`: a child that exits 0 while a descendant keeps
  its stdout open is answered at the limit with an error (bytes already in the
  pipe get a 250 ms drain grace), and the reader ends when the descendant lets
  go. A long listing is still read as it arrives, so a full pipe never blocks
  the child.
- **An MCP error result is an error for Pi and keeps what a success keeps**
  (`octiq-pi.ts`). It is returned with `isError: true`, not thrown: the
  content as sent (text and non-text blocks), `structuredContent` and
  `details._meta`, whose `octiq/outcome` is what the page reads
  (`piEvents.readPiEvent` → `outcomeOfResult`, folded as the tool's
  `outcome` so a failed Pi call says whose failure it was, like a Claude or
  Codex one). A failed result with no text gets one sentence so the model is
  never left with an empty error.
- **Stream**: `agent_settled` is the only full stop (`agent_end` precedes it).
  `adapt_event` turns the `get_state` answer into a `session` and a refused
  prompt (no login) into a failed `message_end` (`octiq_rejected_prompt`) with the
  `pi auth login <provider>` hint; `observe_event` suppresses answers, system
  messages and `turn_end` copies, forwards MCP `notify` warnings as chat status
  and cancels dialogs nobody can answer.
- **A turn is clean only when its last assistant message stopped** (`PiTurn` in
  `agent_chat.rs`). `agent_settled` says only `aborted`; a model call that failed
  for good is the assistant message before it (`stopReason: "error"`), so the
  reader keeps the last assistant message's `stopReason` per turn and clears it
  at the full stop. Clean = not aborted AND last `stopReason` is `stop`; an error
  Pi retried and recovered from is clean, no assistant message at all is not, a
  refused prompt (`octiq_rejected_prompt`, a failed message) is not. That verdict
  is what a completion ticks on and what standing plan approval takes as
  evidence. Fixtures `pi-rpc-error-exhausted` / `pi-rpc-error-recovered` are real
  pi 1.5.2 streams (`scripts/test-pi-harness.mjs`, scenes 5 and 6).
- **A chat moved to another folder resumes by the session FILE.** Pi keys
  sessions by folder; real pi 1.5.2 given `--session <id>` from another folder
  asks "Fork this session into current directory?" and, headless, gives up. The
  file path opens from anywhere with the same id and messages (harness scene 7),
  so `build_command` names the newest `sessions/*/*_<id>.jsonl`
  (`pi_session_ref`, under `$PI_CODING_AGENT_DIR` or `~/.pi/agent`) and falls
  back to the id when no file exists yet. **The file name is only a hint**: a
  candidate counts only when it is a regular file (never a symlink, and no
  linked folder) whose first line, read with an 8 KiB bound, is a `session`
  header whose `id` is the requested id. A renamed file of another
  conversation, a corrupt, empty or oversized header and a directory are
  skipped; none left means the bare id, as does an id `safe_session_id`
  refuses.
- **Not closed**: `handover` read-only copies still refuse Pi. `pi --fork` needs
  a session directory of its own (it cannot be `--no-session`), and a forked or
  resumed session brings back the tool set its system prompt was written with:
  real pi ignores `--tools`, `--exclude-tools`, `--no-tools`, `-ne` and `--no-mcp`
  on it (harness scene 8), so a copy cannot be made read-only by flags; it would
  take rewriting the copied session file. A resumed Pi chat is guarded by the
  access gate extension, not by its tool list. And nothing here ran on Windows.

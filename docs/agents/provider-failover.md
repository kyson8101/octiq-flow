# Provider failover and runtime switch

Moved verbatim from AGENTS.md on 2026-11-24.

### Automatic provider failover

`provider_failover.rs` keeps account-limit cooldowns for this server run. A
structured quota failure marks the account (`provider_failover::account_of`: Pi on `openai-codex` shares Codex's allowance, Pi on `anthropic` is its own account, `pi-<upstream>` for any other);
missing CLIs and accounts already blocked are skipped. The original preset is
kept across switches (and reread for registered chats after restart), so returning
to a recovered provider keeps its exact model and effort. Unknown reset times
use a 15-minute cooldown. Registered agent defaults and identity do not change.

- Runtime model tiers map Fable ↔ Astra for ordinary chats, Opus ↔ Sol, Sonnet ↔ Terra,
  Haiku ↔ Luna. Workers map Fable → Sol on Codex failover because Astra stays
  reserved for orchestrators. Fable may execute any worker task or peer job;
  prefer Sol/Opus/Sonnet for ad-hoc workers because Fable is costly, but tasks
  assigned to a registered Fable agent run on Fable.
  Effort and the semantic `Access` level are preserved; minimal
  maps to low, ultracode to max. Gemini effort is encoded in its model id.
  A guarded Auto or Manual launch never falls back to Antigravity, whose
  headless Auto bypasses permission checks. Pi is a fallback: a Claude-limited
  chat or worker continues on Pi with the same tier as `anthropic/claude-<tier>`
  (the API, a separate quota), and it is last in the automatic order because it
  bills an API key. Pi enforces every level through its own gate (see **Pi is a
  full harness**), so Auto and Manual may fall to it; it offers no Auto, so Auto
  runs there as Edits (narrower, never wider).
- Ordinary chats use the durable auto-resume queue for an immediate provider
  handoff (`provider_switch.rs`), carrying bounded transcript context into a
  fresh native session. Never pass one provider's session id to another.
  Stop/new messages can cancel a handoff before its final spawn; the receipt
  is checked under the session lock. Background work and a turn still ending
  defer the handoff. Queued user turns retain their ids and FIFO order.
- Workers use the normal recovery/reservation door, checkout and retry budget.
  All original approval/identity/destination gates run first; only the host
  then maps the runtime. `execution.provider_origin` records the canonical
  settings, while `attempt.agent/model/effort` record what actually runs.
  A retry may normalize only that exact recorded runtime back to its origin.
  No MCP argument can request a provider override or lift a plan/permission gate.
- `octiq_provider_switched` is durable evidence; `chat-provider-switch` updates
  the live picker and index. All providers exhausted means waiting for reset
  (where known), not cycling endlessly or escalating permissions.
- Settings → Personal preferences contains the browser-owned quota policy
  (`failover_policy.rs`, `provider-failover.json`): global Auto/Ask, per-agent
  overrides and an optional provider/model/effort backup. Ask persists an
  unanswered choice instead of dispatching. Ordinary chat choices live in the
  durable resume queue; worker choices live beside the policy and hold BEFORE
  reservation, including after restart when account cooldowns are empty.
  The browser can choose once or remember a backup. Neither changes Access;
  worker model restrictions and every normal reservation gate still apply.
  A cancelled worker choice stays held; a new attempt/assignee cannot inherit
  its old one-time answer. These commands have no agent-hook route.
- **The person can change a registered agent's runtime from inside its chat**
  (`chat_switch_runtime`, `runtime_switch.rs`, contract in
  [agents mode](../agents-mode.md#switching-a-chats-runtime-chat_switch_runtime)):
  socket-only; the registration never changes; the person's pick overrides the
  host's cooldown (`State::clear`); a busy chat is never interrupted (the pick
  is `pending` and applies at the turn's full stop, before the queue moves,
  under `end_turn_locked`); every fact that must survive a restart is a line in
  the chat's record (`octiq_runtime_pending`, `octiq_provider_switched` with
  `byPerson`/`handoffOwed`, `octiq_runtime_handoff_taken`); `homeRuntime` is
  derived from that record, never from cooldowns. The host's recorded
  runtime beats a stale tab's `chat_start` after a person's switch and after
  automatic failover. **For a registered chat the runtime changes only through
  `chat_switch_runtime`, when the person presses: no start, send, wake, queued
  turn, auto-resume or orchestration master start carries a choice.** For such a
  chat (`defaults_for_chat` is `Some`) the host ignores the page's agent, model,
  effort, resume and handoff entirely, and decides both itself. **Runtime**, one
  function (`runtime_switch::host_runtime`): the latest runtime line of the
  chat's record (a switch, recovery or failover receipt, or the
  `octiq_runtime_launched` line each launch now leaves); else its start
  context or the ledger's resume context; else what its own transcript shows
  the host launched (the provider that announced the latest native session,
  and Claude's `init` model: only for a chat from before launches were
  recorded); else, only for a chat with no history at all, the registration.
  Never the chat index row (the browser writes it), and never the registration
  for a chat that has run ("a chat keeps what it has"). Failover and preset
  recovery still decide for a limited or invalid runtime. **Session**
  (`host_session`): the host's own native session for that runtime (start
  context, else the provider's own latest session event in the transcript,
  filtered by `forgotten_sessions` and by the provider that announced it); a
  start context that holds none owes a fresh session. **Any fresh session of
  a chat that has history gets the host's `provider_history` plus the full
  brief**, whatever the runtime and whatever happened to an earlier handoff
  debt. `chat_retarget` is refused for a registered chat,
  `chat_queue_state.registered` and `.runtime` tell the page (the page takes
  the host's runtime when `registered` turns true, and a pick on a saved chat
  whose registration is not yet known waits for that read, or is refused in
  words when it failed), and the page sends every model or effort pick of such
  a chat to the host whatever agents mode is. Reviewing a rule where a page
  field signals intent: test an old pending intent crossing a later host
  choice, a chat that was never switched (no receipt), and a same-runtime
  stale start after a handoff debt was paid. The first prompt of any
  fresh session after a provider change, automatic or not, carries the
  agent's full brief (`team::identity_brief`) outside the JSON history. Check
  it with `node scripts/test-runtime-switch.mjs`.
- Validate with Rust approval/schedule tests and
  `node scripts/test-provider-failover.mjs`: real server/socket and stub CLIs,
  isolated home and profile, no paid model calls. Add `claude ask` or
  `codex ask` after the binary/evidence paths to verify manual selections
  across a real server restart.

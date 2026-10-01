# Handover: an agent passes its task to another agent

The agent in a chat can hand its current task to another registered agent, or
to a fresh chat of itself (`self`). The other agent continues in a NEW chat.
The person confirms every handover on a card; nothing starts before that.

Code: `src-tauri/src/handover.rs` (host), `scripts/mcp/octiq-ask.cjs` (the
`handover` tool), `web/src/components/HandoverCards.tsx` and
`web/src/lib/handover*.ts` (cards). Live check: `scripts/test-handover-live.mjs`.

## Flow

1. The agent calls `handover` with a recipient, a `requestId` and a brief. The
   MCP posts it to `/hook/handover` with the launch's capability. On Claude the
   call waits for the decision (up to `question::ANSWER_TIMEOUT`). Codex cannot
   hold a call open, so it is told at once that the decision will follow.
2. The host validates and records a PENDING handover in
   `<profile>/handovers.json`, then draws a card in the source chat.
3. The person presses **Hand over** (`handover_confirm`) or **Keep it here**
   (`handover_decline`). Both are socket-only commands. No hook action reaches
   them, and the hook takes only a brief.
4. On confirm, the host re-runs every check (see below). A refusal leaves the
   handover PENDING, with the reason on the card, and it can still be
   declined. Otherwise the host saves it as STARTING, with the new chat's id,
   before anything irreversible, and then starts the recipient's chat. A
   STARTING handover can no longer be declined, because its chat may exist. A
   start that fails is retried from the card. When the host has made sure no
   chat was started, the card also offers **Give up** (`handover_abandon`,
   socket-only). To be sure, there must be no first turn in the new chat's
   transcript and no process under its id. Give up ends the handover as
   ABANDONED, a terminal state distinct from declined, keeps any worktree made
   for it, and tells the source agent the task is its own again. If a start
   cannot be ruled out, Give up is refused and the card offers only a retry.
   Only PENDING and STARTING block a new handover from the same chat.
5. A waiting tool returns the decision. Otherwise the decision reaches the
   source chat as a host continuation turn (`agent_chat::continue_origin`, the
   same path a late `ask_user` answer takes).

## What the host decides, never the model

- **Recipient**: a registered agent by id or exact name, or `self`. `self` in a
  registered agent's chat means that agent's registry settings. In an ordinary
  chat it means the chat's own running provider, model, effort and access.
- **Destination**: resolved by `orchestration::destination::route`. A project
  agent defaults to its own project, and another project is refused. A global
  agent must name the project. Only registered repositories that exist on disk
  count, with no fallback.
- **Settings**: the recipient's registered provider, model, effort and access,
  read from the registry again at confirm. The caller cannot pass any of them.
- **Checkout**:
  - With nothing named, the new chat continues in the source chat's
    host-recorded checkout, if git lists it as a worktree of the destination
    repository. That is the only way uncommitted work travels.
  - A path or branch named in the brief counts only if git lists it as such a
    worktree. Otherwise the request is refused.
  - A new worktree is made only when the source has no checkout there.
  - A checkout leased to an unsettled orchestration writer, or used by another
    live chat, is refused at request time and checked again at confirm.
  - The card shows branch, HEAD and whether anything is uncommitted. These are
    read from git, not from the brief.
  - At confirm, a continued checkout is read from git again. It must still be
    listed by `git worktree list` for the destination repository at the same
    path, with the same git directory (the request records it, and it is one
    per worktree) and the same branch. A moved, replaced or branch-switched
    checkout is refused. Commits added on the same branch are not: HEAD and
    the uncommitted flag are refreshed, so the card matches what started.
- **One writer**: when the new chat shares a checkout with the source (a
  continued worktree, or a plain folder), the confirm is refused while the
  source chat has a turn in flight. The exception is the source's own
  `handover` call still waiting: the agent is blocked in it, and the decision
  is that call's result. The new chat's first message says which of the two
  held when the person confirmed, and never claims the source has stopped.
- **Refused outright**:
  - orchestration workers, which settle through `orchestration_worker_report`;
  - a chat coordinating a run that has not ended, since the run stays with it;
  - a second pending handover from the same chat;
  - a reused `requestId` with different content.

## Guarantees

- Exactly one chat per handover. The target chat id is saved with STARTING,
  before the start, and a retried confirm reuses it along with any worktree it
  made. A retry, and the recovery that runs at server start
  (`handover::live_recover`), first look for the new chat's first turn in its
  transcript. That turn is recorded only once the agent was spawned with it.
  When it is there, the record is only finished as CONFIRMED and the source is
  told. When it is not, recovery marks the handover as interrupted, to retry
  from the card. Recovery never starts a chat. Confirm and decline share one
  lock, so only one of them can win.
- Approvals do not travel. What the brief lists as carried authorization is
  shown to the recipient as the source agent's quoted words, not as a grant.
- A registered recipient's chat becomes its lead chat (`team::handover_brief`
  → `record_lead` on the new key, which only adds a record), so it can still
  delegate to its own reports.
- The first message holds the brief, the source chat's id, and a URL that
  `read_conversation` accepts.

## Not done

- Automatic failover on provider limits.
- Reassigning orchestration tasks or the coordinator role.
- Handing over to several agents at once.
- Moving chat history.

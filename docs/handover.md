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

## After the handover: ask back and outcome back

Code: `src-tauri/src/handover/back.rs`, the `handover_ask` and
`handover_outcome` tools in `scripts/mcp/octiq-ask.cjs`
(`/hook/handover/ask`, `/hook/handover/outcome`).

Once a handover is CONFIRMED, the chat it started has two narrow ways back to
the chat it came from. Nothing goes the other way. The new chat's first
message names both tools and asks the agent to report the outcome when it
finishes or gets blocked.

- **Ask back** (`handover_ask`): one question, optional `contextPaths` inside
  the new chat's checkout, and a `requestId`. The host answers it as the
  source chat's agent: its provider, model and effort, in its folder, from a
  read-only fork of its own provider session:
  - Claude: `claude -p <q> --resume <session> --fork-session
    --no-session-persistence --permission-mode default --strict-mcp-config
    --disable-slash-commands --setting-sources '' --tools Read,Grep,Glob`,
    plus `--add-dir` for the new checkout when it is elsewhere.
  - Codex: `codex exec --json --ephemeral --ignore-user-config -s read-only
    -c approval_policy=never fork <thread> <q>`. It can still run read-only
    shell commands, as in peer help.
  - A pi chat has no such fork, so it is refused, with read_conversation as
    the way to look.

  The session id is the one the source chat's running process last reported,
  else the chat index's, else the one recorded with the handover. The
  answering process runs through `orchestration::peer::run_one_shot`, with
  every `OCTIQ_*` variable removed, inherited or not, so it has no MCP server
  and no hook capability. It cannot write, approve, hand over or ask in turn.
  The answer goes back to the asker as the source agent's quoted words,
  labelled as such, with the line that it is not an instruction, an approval
  or a permission.
- **Outcome back** (`handover_outcome`): `done` or `blocked`, a summary of at
  most 1000 characters, and a `requestId`. It is recorded on the handover and
  broadcast as `handover-changed`. Both chats show it on their handover line:
  "Mango finished: …" or "Mango is blocked: …". A new outcome notifies the
  person on the ORIGINAL chat (`push::notify_chat`, kind `handover`), the same
  way a new handover request does. A retry of the same `requestId` does not
  notify. The latest outcome is shown, and up to five are kept.

In the browser, the outcome is one line under the handover line, with
earlier reports in the folded Brief. The questions sit behind a count
("2 questions asked back"), like peer help. Both belong to the handover
line, wherever 17496c7 placed it: never at the transcript tail, never a card.

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
- **Ask back and outcome back are paired by the record.** The calling chat
  is the one its launch capability proves. The other chat is read from the
  handover whose new chat it is, never from an argument. These are refused:
  - a chat no handover started;
  - the source chat itself;
  - a handover that is pending, starting, declined or given up;
  - orchestration workers;
  - a sub-session that is not the chat's own agent.
- **An ask never touches the source chat.** The fork reads the source
  session and saves nothing: Claude's `--no-session-persistence`, Codex's
  `--ephemeral`. A live probe confirmed that the source session file was
  byte-identical afterwards and that no new session was saved. No turn is
  started in the source chat, its running turn is not interrupted, and it
  works the same whether that chat is idle, busy or closed.
- **Bounded.**
  - 5 asks per handover, answered or not.
  - Questions up to 4000 characters.
  - Answers cut at 8000 characters.
  - Up to 8 context paths, each inside the new chat's checkout.
  - The answering process is ended after 10 minutes.
  - Each ask is saved as `asking` before its process starts, and settled
    `answered` or `failed` (with the reason) when it ends. An ask still
    `asking` at server start is failed by `handover::recover`.
  - A reused `requestId` with the same content returns the recorded result
    without running anything. With other content it is refused. Asks are
    never pruned, so this holds for every ask on the handover.
  - Outcomes: the line keeps the last 5 reports, but every report also
    leaves a receipt (its `requestId`, a digest of status and summary, and
    when) that is kept for the handover's life and never sent to the
    browser. A reused `requestId` is checked against the receipts, so a
    retry of an old report changes nothing and notifies nobody, and other
    content under it is refused, however many reports came after it. A
    handover takes at most 50 outcome reports; the 51st is refused rather
    than a receipt forgotten. A record written before receipts existed
    starts its receipts from the outcomes it still holds (earlier ones were
    already gone).
- **An outcome starts no turn.** It is never delivered to the source agent
  and wakes nothing. It only changes the record and the lines.

## Not done

- Automatic failover on provider limits.
- Reassigning orchestration tasks or the coordinator role.
- Handing over to several agents at once.
- Moving chat history.
- Anything from the original chat to the new one, any wake-up of the
  original agent, chains (an answering turn asking back), and carrying
  approvals in either direction. None of these is possible, by design.
- Ask back for a pi source chat (no read-only fork), and for a source chat
  whose folder or provider session is gone. Use read_conversation instead.
- A real provider fork in the automated checks. The live script's stub
  stands in for `claude`, and checks the fork's argv, folder and environment.
  The real path is the ignored test `a_real_fork_answers_from_the_source_session`
  (`HANDOVER_PROBE_AGENT`, `_SESSION`, `_CWD`, `_MODEL`). It was run against
  claude 2.1.284 and codex-cli 0.158.0. Each recalled its session and could
  not write, and both session files were byte-identical afterwards.

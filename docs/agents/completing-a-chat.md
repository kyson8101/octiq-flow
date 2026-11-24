# Completing a chat

Moved verbatim from AGENTS.md on 2026-11-24.

### Completing a chat

Complete is the person saying "I am finished with this one": the agent is
asked to wrap up, and when that turn ends the host ticks the chat done and
stops its process. The chat stays readable and is **not locked**; the next
message starts it again and takes the tick away.

- **It is the page's command and nobody else's.** `chat_complete { chatKey,
  start? }` and `chat_complete_preview { chatKey }` are `dispatch.rs` arms. No
  hook routes to them and the MCP server has no such tool, the same way
  `orchestration_mission_close` has none. The wrap-up asks the agent to stop a
  run it coordinates; closing the mission needs the person's own action or approval of the coordinator's batch cleanup card.
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

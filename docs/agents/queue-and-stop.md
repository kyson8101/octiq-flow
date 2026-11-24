# Closing words, queue and Stop

Moved verbatim from AGENTS.md on 2026-11-24.

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
- **A queue whose next message cannot start WAITS; it is never failed for
  that.** Handing a queued message over starts a turn, and no turn starts
  while its record cannot be kept (the profile folder is away): a new
  process is refused by `start_session`, and a running agent is not written
  to (`dispatch_next_persistent_turn`). The message taken off the queue goes
  back to its front, nothing behind it is touched, and the chat is listed in
  `ChatManager::waiting` with the profile's sentence (`keep_waiting`). The
  Stop that led there answers `{ stopped: true, waiting: N, notStarted:
  <why> }`, not an error; `chat_queue_state` carries the reason as `held`;
  the bus says `chat-queue-waiting`. Every carry goes through
  `carry_queued_turn` (a Stop on a one-shot or Antigravity agent, the
  reaper's carry-over, the grace of a Stop not honoured, "send this one
  now"), so all of them wait the same way. Once the folder is back the host
  hands the first message over itself (`start_waiting_queues`, every two
  seconds beside the owed saves): written to an agent that kept its
  process, or the first message of a new one, and the rest follow the
  ordinary way. Meanwhile a send joins the back of the waiting queue (a
  start is answered `already running`, which the page answers by sending),
  the ✕ takes a message back, "send this one now" moves one to the front,
  and the chat is not ended as idle. An entry goes when its queue empties,
  so a listed chat has had nothing written to its agent since it was
  listed. A start that fails for a reason of its own once the folder is
  back fails as it always did: marked not sent, and dropped.

- **A one-shot provider's queued turn is written to the transcript at enqueue**
  (`QueuedTurn::recorded`) because Codex never echoes a prompt back. Claude's
  is not — its own echo is the record — so cancelling one only has something to
  take back OUT for Codex. `announce_cancelled` always emits, and appends only
  when there was a record; the client reducer drops the message by turn id
  either way.
- Two things you typed are two bubbles now (`groupTurns`), whichever agent this
  is. One bubble over several queued messages lost its clock the moment the
  first was picked up, and gave the ✕ no single message to name.

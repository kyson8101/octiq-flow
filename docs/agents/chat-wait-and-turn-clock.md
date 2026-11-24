# Chat waiting state and turn clock

Moved verbatim from AGENTS.md on 2026-11-24.

### A chat that waits on the person is not drawn as running

The agent is already parked when it asks: the tool it called blocks until
the card is answered. So a chat with a turn on record that waits on the
person is drawn waiting, not working (`lib/chatWait`).

- **One answer, from the page's one list.** `waitingChats(pendingList, …)`
  reads `lib/pendingActions`' list and nothing else: not the cards, not the
  ledger. A new surface that draws a turn in flight, or says a chat needs
  the person, asks it: the composer and its clock, the chat list, the
  projects page, `ChatTaskBar` (the action bar's status and its panel) and
  the task chat beside the main one (`TaskChatPane`).
- **There are three answers, and "not read yet" is not "nothing waits".**
  That list starts EMPTY on a page that has just loaded and is filled by one
  request each: `permission_pending`, `access_request_pending`,
  `question_pending` and `safety_block_pending` (asked on every connection
  by `useChatRequests`, which says where each stands), and the ledger
  (`orchestration_snapshot`, read once `orchestrationFeed` holds a
  snapshot). They are named in one place, `pendingActions.WAIT_SOURCES`, and
  the reading says how whole it is (`wholeOf`, `PendingReading.whole`):
  `read` when every one has answered, `unread` while one is still out,
  `gaveUp` when no more is coming unless they are asked again.
  `waitingChats` turns that into a third answer, a value of the same map: a
  chat whose checkpoint brought it back parked (`turnClock.parkRestored`)
  and that no card names is held until the reading is `read`: `unknown`
  while it is `unread`, `unchecked` once it is `gaveUp`. A card is a card
  however little was read, and one card is not every source: a chat stays
  such a park while a card is up and after that card is answered, until the
  park's own machine ends it (`lib/restoredPark`, below).
  - **Held is drawn as neither.** The composer's line says `Checking
    what waits on you` in grey with the clock stopped and the companion
    still; the chat list and the projects page draw no working mark; the
    task bar says where the work stands, as an idle chat's does, never
    `Working` and never `Needs you`. Every surface has it because it is a
    value of the one map; there is no flag beside it, and no surface reads
    a list's state itself.
  - **A chat with no restored wait is never held.** A turn that starts
    after the reload is drawn working at once and its clock runs.
  - **A list that fails is asked once more** (`lib/listRead`, three seconds
    on); a second failure is that list not readable on this connection.
    When every source has answered or failed for good, or one has said
    nothing for five minutes (`pendingActions.SILENT_MS`: a request on an
    open socket has no timeout, and a socket that closes fails it and asks
    again on the next), the reading is `gaveUp`. A page with no connection
    has asked nothing and stays `unread`. A host that has no such list (an
    older backend: `not available on this backend`) has answered, emptily:
    it holds no card of that kind (`useChatRequests.lacksCommand`).
  - **A list that failed or was given up on ends no restored wait.** It
    proves nothing about what waits, so the held chat is not let go: it is
    `unchecked`, drawn like `unknown` (no thinking, no working mark, no
    `Needs you`, the clock standing) under `Could not check what waits on
    you`, with `Check again` beside the words (a button, never a tooltip).
    That asks every list again on the connection (`useChatRequests.reread`)
    and the ledger (`orchestrationFeed.refresh`), and the chat is `unknown`
    while they are out. A read ends it, or the agent's own writing after a
    card the page saw has gone (the machine, below). There is no guess: the
    page used to let the wait go here and count from there, and a card that
    came back later took the guessed time off again only when it was the
    last list to answer (24 of the 120 orders five lists answer in; review
    1c). What is left: a chat that is in fact working, behind a list the
    page cannot read and with no card the page ever saw, says it could not
    check until its turn ends or a read answers. That is the cost of not
    counting a wait as work.
- **Never the length of a card list.** The host goes on listing a question
  the person has answered (`status: "saved"`, then `delivered`) until its
  agent has it, so `questions[chat].length` is one while nobody is waited
  on. `ChatTaskBar` was handed the lists' lengths OR the one answer, and
  said `Needs you` under a composer that said the agent was working.
  `chatWait.wiring.test.ts` reads `App.tsx` as text: it names each
  hand-off, and fails for any `waiting` prop that reads a card list or a
  `.length`. It is an alarm on spelling, not a proof: no test renders the
  app.
- **What parks a chat:** its own permission card or access request
  (`Waiting for your approval`), its own question or full safety card
  (`Waiting for your answer`), and a plan awaiting approval for a run it
  coordinates (approval). **What does not:** a worker's card drawn in its
  coordinator's chat (it parks the worker), a gate, an auto-mode refusal
  the agent carried on past (`safetyToast.splitSafety`, asked with the turn
  itself), a safety-check outage, an answer that could not be delivered, a
  handover to confirm.
- **The composer's line** says the waiting words in `--decide` where
  `thinking…` was, the companion stands still (no working ring, which is
  the accent), and the clock stops. Background work the turn started is not
  this line's and goes on being said beside it.
- **The clock leaves the wait out** (`lib/turnClock`): the turn's start plus
  the waited intervals gives elapsed, so work goes on from where the clock
  stopped. All on the page's clock; no host stamp is compared with it.
- **The clock counts what a page saw the turn work, and nothing else.**
  Three rules make that hold across a reload:
  - *A turn's start and its waits are restored together or not at all.* The
    waits are a field of the chat's own state, beside the start
    (`ChatState.turnWaits` next to `turnStartedAt`; `App` notes them with
    `turnClock.withWait`), so whatever saves or restores the one has the
    other. They were the page's own, in memory, while the start came back
    from the chat's checkpoint (`lib/chatCache`): 90 s of work and 180 s of
    waiting read `1m 30s` before a reload and `4m 31s` after it.
  - *The time no page was looking is never counted as work.* A checkpoint
    is written in a quiet moment (700 ms after the page's chats last
    changed), so with agents streaming elsewhere it can be minutes old:
    older than a wait the page did see begin. So a turn that was working
    when its checkpoint was written comes back parked since that moment
    (`turnClock.restoredTurn`, in `loadChat`, from the checkpoint's own
    `updatedAt`), and the page's first look that KNOWS decides: a card
    that is up keeps it parked, and no card ends the wait there. Keeping
    the waits beside the start was not enough by itself: the review's clock
    probe, run again, restored a checkpoint from before the wait once in
    three runs and read `4m 31s`.
  - *When a restored park ends is decided in one place, a state machine*
    (`lib/restoredPark`: `parkStep`). The wait a checkpoint brings back is
    a park with a state of its own (`TurnWaits.park`), and `turnClock`
    hands the machine what happened and decides nothing itself: a look
    (`withWait(state, seen, now, whole)`, told the reading's three answers
    and how whole the reading is) is `card` or `noCard` with `read`,
    `unread` or `gaveUp`; a live event of the agent's own stream is `work`
    (`withWork`).

    | state | card | no card, read | no card, unread or gave up | work |
    | --- | --- | --- | --- | --- |
    | `held` (the checkpoint's word, nothing confirmed) | confirmed | **ended** | held | held |
    | `confirmed` (a card names the chat) | confirmed | **ended** | answered | confirmed |
    | `answered` (the card the page saw is gone, the reading not whole) | confirmed | **ended** | answered | **ended** |

    So a park ends only on (a) a whole reading that names no card, or (b)
    the agent's sign of work after a card the page saw has gone. Never
    because a card confirmed the wait, never on a look made before the
    lists were read, never on a list that failed or was given up on. When
    it ends, all the time from the checkpoint to that moment is left out,
    whatever was unread in between. `turnClock.parkRestored` is true in all
    three states, so the chat is held (`unknown`, `unchecked`) wherever no
    card names it, a confirmed park's answer included.
    - It was flags cleared in passing, twice wrong. The page said `false`
      for a list it had not read: with `question_pending` held back 120 s,
      `1m 30s` read `3m 31s`, drawn as thinking. Then one card confirming
      the wait cleared "restored": with the question's list back and its
      question answered while the permission's list was still out, the wait
      on the permission was counted as work (90 s read 211 s; 60 of the 120
      orders with both cards waiting; review 3b).
    - **A sign of work is the model writing or starting on something, seen
      live** (`restoredPark.signOfWork`): Claude's `stream_event` and
      `assistant`, Codex's `item.started`, `item.updated` and a completed
      `agent_message` or `reasoning`, Antigravity's `step_update`, of the
      chat's main writer. Not a tool's result (the answer reaching the
      agent: with a second call parked on a card the model writes nothing),
      not the host's `octiq_…` lines, not a subagent's or a seat's writing,
      not a full stop. `App` hands it over where live frames are folded,
      after the reducer and never from a replay, which is history.
    - A reload starts the machine at `held` whatever state was saved: what
      an earlier page saw of a card is not this page's to go by.
    - A new way for a restored park to end is an event and a row of that
      table, with its line in `restoredPark.test.ts`. Never a field cleared
      where it is convenient.

  What each path does:
  - *With a checkpoint* (the usual reload): the start and the waits come
    back, and the clock reads the work seen up to the checkpoint. It stands
    there while the lists are unread and while a card is up. With every
    list read it goes on from there once no card is left. With a list
    still unread or given up on, an answered card leaves the chat held
    (`Checking what waits on you`, or `Could not check` with `Check
    again`) until that list is read or the agent writes. It can read less
    than the turn really worked (what was seen after the last checkpoint,
    the time the lists took, and work behind an unread list before the
    agent's next writing are not kept); it never reads time the turn spent
    waiting, or time nobody saw. That holds in every order the lists
    arrive in, before and after the page gives up on one, with one card
    waiting or two (`turnClock.unread.test.tsx` walks the orders three ways
    for each: a fixed sample locally, all 720 orders of the six lists with
    `OCTIQ_EXHAUSTIVE=1`, which CI sets).
  - *When the page cannot read a list* (`gaveUp`): nothing changes on the
    clock. The restored wait stays on with the moment it began, the chat is
    held as `unchecked`, and the person can ask again. A card that a later
    read finds confirms the wait, so there is nothing to take back, and
    answering it leaves the chat `unchecked` while the other list is still
    unread; every list read with no card ends it there, with all the time
    held left out.
    A checkpoint an earlier build wrote may still hold a guess
    (`guessed`): the time from it to the save is left out on restore.
  - *Without one* (a chat never saved or evicted from the twelve kept, one
    read in pages, storage blocked): neither comes back. The turn starts
    when the page joined it, as for any turn joined part-way, and the wait
    when the page first sees the card: a clock stopped at about nothing
    beside the waiting words, and after the answer only the work done since.

  A new thing the clock leaves out is a field of the chat's state too,
  never a state of the page's beside it. `turnClock.reload.test.ts` is the
  round trip through the real checkpoint and `loadChat`, for a checkpoint
  written during the wait, one written before it, and none.
  `turnClock.unread.test.tsx` goes on from there through the three steps
  `App` makes (the reading, which chats wait, the clock) to what the
  composer, the task bar and the chat list draw: the lists unread for 120 s
  and then the question still pending, the lists empty, one that never
  arrives, one that failed twice, one card back and answered while another
  list is still out, and the page as it was, which fails them.
  `restoredPark.test.ts` is the table, every sequence of seven events, and
  the reviewer's helper probes as written.
  A probe of a restore holds a request back: a fast reload passing ten
  times of ten says nothing of the slow one. And it lets one card come
  back and be answered while another source is still unread or given up:
  the 120 orders with a single card never met that.
- **The chat list** draws no working mark on a row whose chat waits
  (`Sidebar`'s `waiting`); its pending badge is unchanged. `busy` still
  means a turn is on record there, which is what holds Archive.
- **A pending badge is the colour of what it says**
  (`pendingActions.pendingTone`, `data-tone` on the badge): `--decide` for
  what waits on the person's decision (a permission, a question, a gate, a
  plan, a handover), `--warn` for a problem they are told of (a refused
  action to review, the safety check down, an answer not delivered), and
  `--danger` for a failure that is theirs to decide, as the run panel draws
  it. Several of one state are that state; mixed, the decision colour. It
  was amber for all nine. The ring on the card a badge leads to is
  `--decide` too. `lib/decideColour.test.ts` reads the badge's sheet.
  `ChatTaskBar` says `Needs you` in `--decide`, never the accent and never
  amber, and only for what parks the chat: an outage card or an answer that
  could not be delivered is badged and does not say it.

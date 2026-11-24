# Run panel and progress strip

Moved verbatim from AGENTS.md on 2026-11-24.

### A run's progress is one line above the composer, and the Agents panel

The chat that coordinates a run carries one line on its composer
(`RunProgressStrip`): a dot, the state word, how far as a bar, the count, and
at most two more counts. A click opens the run panel, which draws the same
run as three tiles (Tasks, Tokens, Time), then its tasks in four groups. Both
are read by `lib/runProgress` off the ledger this tab already holds.

- **Nothing on the line is said twice.** The bar has no words in it and
  there is no percent: `1/2` is beside it, once (`strip.label`, which is the
  count and nothing of the state). A finished run is `Done ▬▬ 1/1 · 23m`.
  A failure's reason is `1 failed`, which says the state's word again
  beside `Failed`, so there the reason IS the word and the counts are what
  is left (`runProgress.stripLine`): `1 failed ▬▬ 10/22 · 2 working`. Needs
  you keeps its word, and its reason (`1 decision`, `Plan to approve`) says
  what is asked. A run with nothing to count draws no bar. What is spoken
  and the tooltip are whole, as before (`stripSpoken`, `stripTitle`).

- **Nothing is estimated.** A figure the host did not send is `null` and the
  part that would draw it is left out; a zero is left out the same way. The
  host does not send tokens per attempt (`attempt.usage`) or a worker's
  context (`attempt.context`) yet, so today a row ends in its minutes and
  there is no Tokens tile. Both fields are typed and read, so they appear
  when the host sends them.
- **"Needs you" is a fact, decided in one place** (`lib/runWaits.runWaits`).
  A wait is the person's when the plan has a revision to approve, when the
  page itself holds a card for the worker (permission, safety, question, an
  undelivered answer, a handover), or when the host says so: an open gate
  or a pending native decision whose `awaits` is `"person"`, and a task's
  failure the host says is theirs to decide (below, **A failure is quiet
  until the person must decide**). A gate on a
  peer request is the person's on any host, because only their page can
  answer it. `awaits: "coordinator"` stays under Running in the warning
  colour as `Waiting on the coordinator`. `awaits: "nobody"` (a refusal no
  one can approve) changes nothing on the row. A host that sends no
  `awaits` leaves a gate or native decision unsaid: shown, never counted,
  and the tooltip says `The host does not say who this waits on.` A native
  decision and its safety card are one thing under one key, so decisions
  are counted per card and never per row.
- **Every surface is drawn from that one reading, and nothing else reads
  the ledger's waits.** `lib/runWaits` is the only module that names the
  ledger's `gates`, its `nativeDecisions` or a record's `awaits`; anything
  else asks it (`runWaits`, `ledgerWaits`, `openGates`, `taskDecisions`,
  `pendingDecisions`). One exception, stated in the scan itself: whose move
  a task's FAILURE is (`task.failure.awaits`) is read once, in
  `orchestration.failureMove`, because surfaces that are handed tasks and no
  waits ask it; `lib/runWaits` asks that reader and never names the field.
  The page's own cards are read once
  (`pendingActions.heldCards`) and handed to it as `held`
  (`PendingActionsView.held`), and from what it returns come: the strip
  (`chatStrip`), the panel's rows, its decision boxes, its `N to decide`
  and the run picker's count (`runAttention`), the Tasks button
  (`taskColumnCounts`), the chat list's line (`rowRun`, `runSummary`) and
  its badge (`pendingReading`), and the Agents page (`taskState`,
  `agentRoster`). A new surface that says or counts a wait takes a
  `RunWaits`; it does not filter gates.
- **What is proven of that, and what is only guarded.** Three tests, each
  with a limit to say:
  - `runWaits.surfaces.test.tsx` asks each surface's own function or
    component the same count and the same yes or no over a table of
    distinct ledger shapes: a host that says `awaits` and one that does
    not, the card list delivered, not arrived, failed, and the ledger as
    the host really serialises it (`web/src/lib/__fixtures__/host`,
    recorded from the host's own tests and never hand-edited). The rule
    itself is decided and tested in `lib/runWaits`; this is one agreement
    test per other surface. It proves the surfaces agree when each is given
    the one reading. It builds that hand-off itself and does not run `App`.
  - `runWaits.wiring.test.ts` is the hand-off: it reads `App.tsx` as text
    and names each place a surface is given the cards (`pendingHeld`), and
    shows the check failing for the mutations that drop one. The Agents
    page's `held` is a required prop, so dropping it does not compile. No
    test renders `App`.
  - The scan for a second reader of `gates`, `nativeDecisions` or `awaits`
    compares the set of files allowed to read them (each with its reason),
    not how often each reads; it matches the usual spellings. It is a guard
    against writing one by habit, not a proof: a computed property name, or a second sort of what
    `openGates` returns, passes it.
  A surface the table does not ask (a title, a notification, a tab's label)
  is not covered by any of this until it is added to it.
- **The host's word does not wait for the card.** A native decision the
  host says waits on the person is badged and counted with no card on the
  page (`PendingAction.cardMissing`: the list was not read yet, or its
  request failed twice: a card list is asked once more after a failure,
  `lib/listRead`, and not again within a connection). The page
  then asks for `safety_block_pending` again, once for each set of missing
  cards and once more when the badge is pressed; nothing polls.
- **What the ledger alone records is history once a run is stopped, closed
  or archived; a card the page still holds is not.** Its buttons are on the
  person's screen, so it is counted wherever it is said, and the row that
  holds a decision of the person's says Needs you whatever became of its
  task. An archived run that still holds one is not put behind Archived
  (`runPanel.splitArchived`): it stays with the runs on screen, and its
  heading keeps the decision's count beside Restore.
- **Four states, in this order:** Needs you, Failed, Done, Running. Failed
  is a failure that waits on the person with nothing else waiting on them:
  every decision of the line is a failure's own (`RunStrip.failures`), the
  dot is the danger colour and the line's word is `1 failed`. Beside a card
  or a plan it is Needs you, and what failed is still said (`2 decisions ·
  1 failed`). A failure its coordinator is fixing is neither: the line is
  Running, in grey, and says so only in its tooltip (`1 failure with the
  coordinator, which is fixing it: nothing is asked of you.`). On a host
  that does not say whose move a failure is, Failed is what it was: a failed
  task, a block with no decision open, a check whose verdict is fail, none
  of them replaced, and only while nothing waits on the person. A
  cancelled or replaced task is counted nowhere, so a run can reach its
  whole count. A stopped, closed or archived run, and a run with no task,
  draws no strip, unless something in it waits on the person: then the
  line is drawn, and a run with nothing to count yet says `No tasks yet`.
- **The count of work is asked of the host's facts, never of a row's
  state** (`runProgress.countsAsWork`): a task is counted when it completed,
  or when it is not cancelled, not replaced (`supersededBy`) and its run was
  not stopped. A row's state asks the person first, so a replaced task
  whose card is still up is a row under Needs you; counted by that state it
  came back into the total (`Tasks 0/2` with one task owed). Done is asked
  the same way. A run on the line only for such a card says `Run stopped`
  or `No tasks left`, never `No tasks yet`.
- **A task the host would refuse to start says what holds it**
  (`lib/taskHold`, one function for every surface that names a task's
  state). Three things hold a task that has not started, each a fact the
  host sends and each said in the words of the host's own refusal:
  `stopped` (the person stopped its worker: `Stopped by you`, and only their
  Start starts it again), `heldByPlan` (`Waiting for plan approval`), and
  `heldByReopen` (`Reopened · notice not yet saved`: it was reopened and the
  notice of that is not confirmed on disk). None is a decision asked of the
  person: no Needs you, no count, no badge. The row sits with what has not
  started, first in its group, with a Held mark, the hold as its line and
  the host's sentences in its tooltip and its opened detail; the Agents
  page says the same words. A reopened task used to read `Ready to start`
  there while every start of it was refused.
  - The warning colour is for a reopen held longer than a minute
    (`REOPEN_LASTED_MS`), and for nothing else here. The host confirms a
    notice on its next pass (about two seconds) and asks a transcript that
    gave none again after 4, 8, 16 and 32 seconds, then once a minute: a
    minute in, it has failed five times and is at its slowest. Before that
    it is the ordinary moment between a reopen and its notice.
  - **That minute is counted on one clock.** The reopen's stamp is the
    host's and is never compared with the browser's `Date.now()`: a browser
    five minutes fast warned at once, and one five minutes slow about six
    minutes late. It runs from when this page first saw the hold
    (`taskHold.seeHolds`, recorded as `orchestrationFeed` reads a ledger and
    as a surface draws one) to the reader's `now`, both the page's clock.
    The ledger may also say it on the host's clock alone: a task the host
    stamped a minute after the reopen, in an answer that still says the
    notice is owed, and then a page loaded late warns at once. A hold is
    keyed by its task and the reopen that is owed, so a later reopen is a
    new hold. Nothing ticks for it: `useHoldClock` sets one timer for the
    moment the earliest hold lasts, so the warning arrives in a run where
    nothing else moves. First sights are in memory: a reload starts the
    minute over unless the ledger shows it has passed.
  - A task the person stopped is left `failed` by the host and did not
    fail: it is not stuck (`isStuck`), not an attention count, not a
    failure on the strip, and its row offers the one start the host
    accepts, `Start it again` (`retryOf` the stopped attempt). The strip
    says `1 stopped` as its second count where no other run, failure or
    worker takes it, with or without a plan to approve.
- **One reader decides whether the page may start a task**
  (`taskHold.startControl`, `startBlocker`). A task has at most one control
  that starts an attempt, and `StartButton` draws every one of them: `Start
  it again` (the person's Start of the attempt they stopped, and the only
  start a stopped task offers), `Start next attempt` (ready again after an
  attempt completed), `Start retry` (failed or blocked, with nothing open
  that holds it). A start the host would refuse stays on the page switched
  off (`aria-disabled`, no handler) with the reason beside it, asked in the
  host's own order (`reserve_attempt_for`): the plan holds the task
  (`heldByPlan`, which the host says of a failed or blocked task too), its
  reopen is not told yet (`heldByReopen`), it was replaced. A run that is
  stopped, closed, completed or archived offers none. A new control that
  starts an attempt is a `StartKind` there, never a button of its own:
  Task details used to offer an enabled `Start next attempt` on a reopened
  task the host held. What a Start sends, and that a refused one sends
  nothing, is pressed in `components/OrchestrationPanel.controls.test.tsx`;
  `taskStart.test.tsx` only scans that no second sender of
  `orchestration_worker_start` exists and that no start label is written
  outside the reader.
- **The ledger's status in a task's details is said as the ledger's**
  (`taskHold.statusLine`): `Ledger status: Working`, kept apart from what
  the worker's process is doing. A task something holds leads with the
  hold, `Task: Reopened · notice not yet saved · ledger status: Ready`,
  `Task: Stopped by you · ledger status: Failed`: never `Task: Ready` of a
  task that cannot start.
- **"Completed" is not "done", and how a task ended has one reader.** The
  host calls a task `completed` when its worker settled it, and a review
  that completed with a failing verdict still holds what depends on it
  (`releases_dependants`). So the ledger's status word is compared in one
  place, `lib/orchestration`, beside `isStuck`: `isSettled` (the worker
  settled it, whatever its check said: it takes no worker, its result can be
  accepted, its worker can be archived), `checkFailed` (settled with verdict
  `fail` and not replaced) and `finishedWell` (settled and its check did not
  fail). Only `finishedWell` is ever called or counted "done"; a surface
  that counts settled tasks says "settled" (`Tasks settled`). Accepting a
  result does not lift a failed check, because the host goes on holding its
  dependants; a replaced one is history; a check with no verdict (old
  records) did not fail.
  - **A failed check is never done, and it is a failure like any other.**
    It is named `Check failed` (`CHECK_FAILED_LABEL`, never "Done · check
    failed") and never counted done, on every surface. Whether it is shown
    AS a failure, in the danger colour and counted failed, is the next
    rule's to say, as for a task that failed or is blocked.
  - **A failure is quiet until the person must decide** (the person's
    decision of 2026-10-13; `orchestration/retry.rs`). The host says whose
    move each failure is (`task.failure.awaits`), and it is read in ONE
    place, `lib/orchestration`, beside the readers above: `failureMove`
    (`coordinator`, `person`, `history`, `none`, or `unsaid` for a host that
    says nothing), `failureOf` for what it failed as and why, `failureShown`
    (`red`, `quiet`, `history`) for a surface that is handed tasks alone,
    `isRetrying`, and `shownRunStatus`. Every surface asks one of them and
    none works a failure out again:
    - *The coordinator's* (retries remain): no danger colour, no warning
      colour, counted failed nowhere. Its row is under Running with the grey
      word `Waiting on the coordinator` (`COORDINATOR_WORD`), or `Retrying`
      (`RETRYING_WORD`) while the host says a retry is at work
      (`task.retrying`); a retry's worker that is stalled or disconnected
      keeps the host's word for that, in the warning colour, as any worker
      does. The opened row and the tooltip say it in a sentence (`Its
      coordinator is fixing it: 1 of 2 automatic retries used. Nothing is
      asked of you.`). It is not in the chat list at all: no `N failed`, no
      tint. Its fail pill is the row's ink, and the acceptance line still
      says `Failing`, in no colour.
    - *The person's* (retries used, the coordinator asked or is gone, a peer
      request's time is used): the one failure that is red. Its row is
      under Needs you, in the danger colour, under the word of what it
      failed as (`FAILURE_WORD`), and it is ONE decision in
      `lib/runWaits`: the gate the coordinator opened about it
      (`gate.aboutTaskId`, tied to the task's row) when there is one, else
      the failure itself (`failure:<task>`). Never both. It is counted
      wherever decisions are (the badge, `N to decide`, the Tasks button),
      and where every decision is a failure's own the surface says it as
      what failed: the strip's state and word (`1 failed`), the run's
      attention button and the run picker (`1 failed`, danger), the chat
      list's line (`1 failed · 0/1 done`, danger), the Agents page (state
      `failed`), who a run is with and a mission's crew (`failed`). `N
      failed` in red means exactly this on a host that says.
    - **A red row never only says it failed** (`runProgress.failureNote`).
      One sentence, in words on the row itself (`.orch-task-ask`: folded or
      open, wrapped, never cut, never a tooltip alone): why it is theirs, in
      the host's terms (`because`), and what moves it. The row's one start
      where the host takes one (`taskHold.startControl`; no second start
      control), the decision above the rows for one the coordinator put to
      them, or, for a settled check that takes no worker, the person's own
      reopen: `Open this row for Continue after review to put it back to
      work with what you write`. Only where the page has no reopen to offer
      (no kept workspace) does it say `ask the coordinator in its chat, or
      stop or archive the run` with a button to that chat, and with the
      coordinator's chat gone it says so and offers no way there.
    - **A failed check that is the person's is reopened from its row**
      (`taskHold.reopenControl`, `REOPEN_CONTROL`). The host takes the
      person's own reopen (the socket's `orchestration_task_reopen`, which
      no hook reaches) for a check whose retries are used or whose
      coordinator is gone, and no Start: a completed task takes none. It is
      `Continue after review`, on the Delivery row above the tabs, guarded
      as that row's other decisions are, and offered where the ledger says
      the host would take it: a settled task that is no peer request, with
      a workspace that is kept and not merged, in a run that is not
      stopped, closed or archived. A failed task whose coordinator is gone
      and a peer request out of working time take the person's Start
      instead. A reopen that was the person's own says so in the chat's
      line (`byPerson`: `You reopened …`, `Your instructions`).
    - **A gate about a failed task is answered on the page.** It is drawn
      in the Needs you box named for its task, and its button is `Answer`:
      the socket's `orchestration_gate_resolve`, like a peer request's
      gate, never a message through the main chat. Only the person's own
      answer gives the task its retries back.
    - **Every control that answers a gate is one guarded component**
      (`GateAnswer`). An answer has no question in front of it, and through
      the person's door it is their decision the moment it is sent, so: a
      press that repeats one just made on something else is dropped
      (`pressGuard.repeatsAnother`), the repeats of a held Enter or Space
      are dropped, and from the press until the host has answered every
      control of the gate is off (`aria-disabled`, and the handler
      refuses). That last is held by the gate, outside the component
      (`lib/inFlight`, `gateFlight`), so a panel drawn again is still off
      and the sender refuses a second answer. Review 3 (H1): a press
      repeated in the spot where the button was about to be was sent as the
      person's decision. The guards are proven by pressing the controls in
      `components/OrchestrationPanel.controls.test.tsx`; `gateAnswer.test.tsx`
      keeps only the scan that `onResolve` is called, and a gate's controls
      are drawn, inside `GateAnswer` alone, and that the person's door has
      one sender (`resolveRunGate`).
    - **The person's door is sent only for a gate that waits on the person**
      (`orchestration.gateDoor`). A failure's gate or a peer request's that
      the one reading calls theirs goes to the socket (`Answer`, with
      `Answered here as your own decision.` under it). Any other gate an
      agent can answer goes to the coordinator's chat as a message (`Send
      to main chat`), and under `Open decisions` it says so: `This does not
      wait on you. What you write goes to the coordinator as a message; it
      decides.` A peer request's gate that does not wait on the person
      offers no control: no agent may answer it.
    - *History* (`awaits: "nobody"`: replaced, or its run was stopped,
      closed or archived): not red, counted nowhere. A replaced one reads
      `Replaced`, as before; the other is listed in the panel's Finished
      group under a muted `Failed` with its details, and offers no start.
    - **Whether a failure is history is the host's word, never the run's
      status.** The host calls a run `failed` or `completed` when nothing
      else is left to run, which is what an unanswered failure leaves
      behind: such a run has not ended. So a run's status is drawn through
      `shownRunStatus` (failed only when a failure waits on the person,
      running while its coordinator is on one), and a task of it the
      coordinator is fixing is current work on the Agents page.
    - **A host that does not say reads as it did** (`saysFailures`: no
      `retryLimit` on the task). A task that failed, one blocked with no
      decision open and a check whose verdict is fail are failures in the
      danger colour, listed first under Running, counted failed; the chat
      list's line is `Needs you · 1 failed · 0/2 done` or `1 failed · 0/1
      done`; a run the host calls completed, failed or stopped is history
      on the Agents page.
  - **The Agents page asks the panel's reading** (`taskReading`) and does
    not work a failure out again: what the row calls failed is the agent
    state `failed` there (chip `Failed`, danger dot and word, `1 failed` in
    the summary, ranked after Needs you), under the row's own word:
    `Failed`, `Blocked`, `Check failed`. `Blocked` stays the warning colour
    and is only ever a wait (an open decision, no capacity). A failure the
    coordinator is fixing is `Queued` there under the row's own grey word,
    and a retry at work is `Queued` or `Working`. What finished well is
    folded away there.
  - **The chat list's line** is the strip's own word, what failed, then
    done of the tasks that count: `Needs you · 1 failed · 0/2 done` beside
    another decision, `1 failed · 0/1 done` when the failure is the only
    one. A wait on the person is the decision colour and a failure the
    danger colour (`data-tone`); nothing to count is left out, never "0/0".
  - `finishedWell.surfaces.test.tsx` asks every surface the same done and
    failed counts, one test per distinct shape: the host's four
    `plan_after_*` and one that finished well, each beside a pending plan
    and with no plan, plus two summary-read ledgers; then over the host's
    failure ledgers (`failure_*`, `retry_executing`), where the rule lives
    in `runProgress` and `orchestration.failureMove` and every ledger is
    asked there (the counts, the row and the row as drawn), while the
    strip, the chat list's line, the attention button, the run's status,
    who the run is with and the Agents page are asked once per class of
    failure. It scans the source: the string `"completed"`, a task's
    `.verdict`, and what the host says of a failure (`task.failure`,
    `retryLimit`, `.retrying`, `aboutTaskId`) are each allowed in a SET of
    files, with a reason per file; how often a file reads is not pinned.
    A new filter or count that compares a task's
    status with the word, or reads a failure's move itself, fails it; ask
    one of the readers instead. `scripts/test-quiet-failures.mjs` draws the
    same seven ledgers in the real App at 1280 and 390.
- **A chat that coordinates several runs has one line** (`chatStrip`): a
  run that waits on the person outranks a newer one that runs, a failure
  outranks plain progress, the decisions of every run of the chat are
  counted (`ledgerWaits`), and with more than one run on the line it says
  how many (`2 runs`; under 400px that second count gives way and stays in
  the tooltip).
- **Groups: Needs you, Running, Finished, Planned. There is no fifth.**
  A heading says what it counts (`groupHeading`): Needs you counts the
  decisions of its rows, like the strip (`Needs you · 2 decisions` for two
  cards of one worker), and the others their tasks (`Running · 4`, spoken
  `Running, 4 tasks`). A decision of the run itself, its plan or a gate
  with no task, is no row and is drawn in its own box above the groups.
  Finished is the only one that folds and starts folded; Finished and
  Planned show three rows and a line for the rest, which is a disclosure
  (`aria-expanded`, `aria-controls`); pressing it puts the keyboard on the
  first row it showed, on the row's summary or, for a task with no worker
  chat, its details disclosure (`ROW_FOCUS`). A failure that waits on the
  person is a row of Needs you, in the danger colour. Under Running, a
  stalled or disconnected worker leads with the host's label in the warning
  colour; a failure the coordinator is fixing and a retry at work are in
  grey, in the plan's order. (On a host that does not say whose move a
  failure is, what failed is listed first under Running, in the danger
  colour, as before.) An empty group is not drawn, and the task on screen
  is never behind a fold.
- **A row's words are the task's title and the host's own label, with one
  exception that is exact.** While an attempt of the task is executing (the
  row's `flight`) and its worker's report marks a step active, the folded
  row's third line names that step after its place in the checklist: `1/7 ·
  <the step's title>` (`runProgress.rowStep`, `stepAtLabel`, `stepOneLine`).
  The number is where the active step stands in the list, not how many are
  done. It is the step's title and nothing else of the worker's: one line,
  cut with an ellipsis, drawn as text (never markdown, never a link, its
  line breaks as spaces), with the whole title in the tooltip and in the
  Steps tab, so it is never behind a hover alone. A row that is planned,
  held, finished, failed or closed, one whose worker is stalled,
  disconnected, retrying or preparing, and one that waits on anybody keeps
  the count alone (`0/7 steps`) or the host's word, which always comes
  first. A report older than ten minutes (`STEP_STALE_MS`) has its step
  muted and the tooltip says when it was reported. The worker's summary, a
  path, a commit and what it is running stay behind the row's disclosure
  with everything the row had before (state word, kind, size, environment,
  branch, checklist, brief).
- **An opened row is its status line, what starts or decides, then two
  tabs.** The status line (state word, last step, branch) stays on top.
  Under it, above the tabs and so on screen whichever is open, in this
  order:
  - a hold's sentence, and whose a failure is when nobody here has to act
    on it;
  - the decision the task waits on;
  - the task's one start (`Start it again`, `Start next attempt`, `Start
    retry`, with the reason when it is switched off);
  - what the person decides about the task's workspace (`DeliveryActions`,
    one row of buttons): `Refresh delivery status`, `Continue after review`
    (its box for the fixes and `Reopen task in this workspace`), `Clean up
    worktree` and `Abandon workspace…` (their question, `Keep worktree` and
    `Confirm removal`), and `Remove validation checkout`. A question is
    drawn in the row's place, never in a tab.

  **Nothing inside a tab sends a command**, with one exception that is
  counted: `Archive worker` and `Restore worker` on an attempt in Task
  details, which hide a worker's chat from the list and bring it back,
  start, stop and remove nothing, and are undone by the same button. The
  facts the workspace's decisions act on stay in Details (`WorkspaceDelivery`:
  the delivery's word, the path, the host's warnings, when git was asked
  and what it said, the validation checkouts' paths). A new control that
  starts, decides or removes goes above the tablist. `taskStart.test.tsx`
  reads the tabs for it (a scan, the rule being "no sender inside the
  tabs"), and follows every component drawn in them into its own source
  (`inTabs`): a scan that stopped at the row's `</article>` never saw the
  helper that drew Reopen, Clean up and Abandon in Details. What those
  controls send when pressed is in
  `components/OrchestrationPanel.controls.test.tsx`.

  A new row opens on `Steps`: the checklist with its current step and its
  count line; a task with no reported steps says `No steps reported yet`
  there. Returning to a cached chat restores the person's chosen tab.
  `Details` is every other field: the plan card
  (project, branch, work directory, worktree, owner, model, effort, size,
  problem, goal, acceptance), peer help and the Task details disclosure.
  It is a real tablist (`runPanel.TASK_TABS`, `taskTabKey`: arrows, Home
  and End, the panel labelled by its tab; a key held down moves it once).
  In an embedded chat run panel, the chosen run/task tabs and the task's
  expanded state survive chat switches by their
  run/task ids through the bounded page-memory reading cache described above
  (8 chats, 2048 choices/256 KiB per chat; released on eviction, reset or
  deletion). Elsewhere they remain local component state. No action form or
  decision authority is cached. The chosen tab is the row's ink and a rule
  under it, never the accent. Choosing a tab changes what is under the
  pointer, so the press is remembered like a
  disclosure's (below). The panel's scroller keeps room for a scrollbar
  that takes room (`scrollbar-gutter: stable` on `.orch-content`): on
  Windows a longer tab brought the scrollbar and made every row 15px
  narrower.
- **Colour is state.** The accent is a turn in flight and nothing else, as
  a tint: `strip.live` and a row's `flight` are true only while an attempt
  of the run is executing. A run that is all planned, or whose only worker
  stalled, is "Running" and is drawn in grey. `--decide` is what waits on
  the person, here and on the panel's decisions box, its count on a
  collapsed goal and the Tasks button; `--warn` is a problem.
  `RunProgressStrip.test.tsx` and `lib/decideColour.test.ts` read the sheets.
- **One thing moves:** the texture over the part of the strip still to do,
  while a turn is in flight. Time is in minutes (`minutesLabel`), never
  seconds.
- **The scoped read and the whole one see the same facts.**
  `chatWorkflow.chatSnapshot` keeps everything `runWaits` reads for the
  chat's runs, the native decisions included; a field added to that
  reading is kept there too.
- **What the plan holds is the task's to say** (`taskHeldByPlan`): a task
  is `Waiting for plan approval`, and a mission with a pending plan is a
  draft, only while the host's `heldByPlan` says the plan holds it. A host
  that sends the field for no task of the run leaves both reading the
  run's own approval, as before.
- **A plan waiting for approval never hides work the person must see, and
  never says nothing can start while the host would start something.** Two
  facts, two readers, and neither stands in for the other:
  - *Whether the plan stands in for the run's rows* is asked of the rows
    themselves (`runProgress.planStandsIn`): every row is done (completed
    without a failed check), closed (cancelled or replaced), or has not
    started because the plan holds it. A task that failed, is blocked,
    completed with a failed check, was stopped by the person, is running,
    waits on anybody, or is approved and waiting its turn is a row, and the
    plan is then drawn beside the rows and the run's totals: what failed
    by whose move it is (under Needs you in the danger colour when it is
    the person's), a stopped task with `Stopped by you` and its `Start it
    again`. A mission draws its rows always, and
    its totals by this rule too. `planHoldsRun` counted failed,
    completed-with-a-failed-check and stopped as finished, and hid all
    three behind the card.
  - *Whether nothing starts* is the host's to say
    (`taskHold.planHoldsEveryStart`): only while nothing is running and
    `heldByPlan` is true of every task that could take a worker (unstarted,
    failed or blocked; a completed, cancelled or replaced task takes none).
    Then the card says `No worker starts until you approve.` and the line
    under it `The tasks start once the plan above is approved.`; otherwise
    `What you approved before goes on. The rest waits for this.` and `The
    tasks you have not approved start once the plan above is approved. The
    ones you approved before go on.` A mission is a Draft only while this
    holds. The host starts a retry of an approved task that failed while
    the plan waits, and the card used to say no worker starts.
  A new place that chooses between the plan and the rows asks the first; a
  new sentence about what starts asks the second. A host that says
  `heldByPlan` of no task reads as before for the sentence (a pending plan
  holds every start) and for an unstarted task's row; a task of its that
  failed, is blocked or was stopped is a row all the same.
- **Whether an attempt can go on is the host's sentence, not the page's**
  (`runWaits.decisionSummary`). `continuation: "unavailable"` was read as
  `cannot resume; a new attempt is needed`. The host sends it for a safety
  card the person still has to answer on an attempt that is also blocked on
  a gate, and for a refusal the worker carries on past: both false. The
  row's chip gives the host's `recovery`, is never `cannot resume` for a
  decision that is the person's, and calls a refusal nobody can approve
  `Refusal recorded`.
- **The page is tested against the ledger as the host serialises it**
  (`web/src/lib/__fixtures__/host`, loaded by `hostFacts.ts`; the README
  there says which host test answers each and how to record it again).
  Never hand-edit one. A field the page reads from the host is first read
  from one of these: a fixture written by hand is how the three readings
  above came to be wrong.
- **Hiding the strip** is remembered against what it said
  (`octiq.v2.runStripHidden`, one signature per run): it comes back when a
  task settles, something asks or something fails, and not because a worker
  started or stopped.

**A run is never wider than the column it is in.** The list of a chat's
runs is one grid column bounded by the panel (`.orch-run-accordions`,
`minmax(0, 1fr)`). With an implicit `auto` track every run was as wide as
its widest content wanted, and in the 300px column beside the chat and a
side column the panel scrolled sideways (333px in 284px), which on Windows
is a scrollbar that takes room. The run's own tab row still scrolls
sideways inside it, by design and with no scrollbar.
`scripts/test-composer-fit.mjs` asserts it in the three-column scene.

**The run column's place is held before the ledger answers**
(`lib/runColumn`). The ledger arrives after the chat is drawn, and the page
used to split in two then. Four things say a chat has a run before the
ledger does: the host's `coordinatesRun` on the chat's own index entry, a
task chat's reserved `orch-` id, a task chat open beside the chat (the route
or the remembered choice), and the chats this browser last saw coordinating
(`octiq.v2.runChats`). The held column is empty until the ledger fills it.
`coordinatesRun` holds the column at first paint only where the page has the
entry at first paint, which is the chat as this browser cached it the last
time it was listed (CLS 0.004).

**A chat that was drawn at its full width is not split afterwards**
(`runColumn.columnAtFirstPaint`, `columnHeldShut`). Where nothing said the
chat has a run by its first paint (a coordinating chat opened cold for the
first time in a browser, on a host that does not send `coordinatesRun`, or
one that sends it only with the chat list's answer), the column the ledger
then brings starts put away, the state the action bar's Tasks button already
has: the button arrives with its counts and what waits on the person, the
line above the composer says what the run is doing, and the person opens
the column (CLS 0.003, from 0.26). Only that one paint is held to: leaving
the chat and coming back draws it with the column, a run started while the
chat is open opens it as before, and from the next load the browser
remembers that the chat coordinates. The split is never made by the
ledger's first answer, or by the chat list's, under what is already drawn.

**A linked chat that is not open yet is not drawn as a new conversation**
(`lib/arrivingChat`). On a cold open of `#/p/<project>/c/<chat>` no chat is
open until the chat list answers, and the composer drawn in that moment was
a new conversation's, with its project-and-branch row: 42px that left when
the chat opened (206 to 165px, 0.0215 of layout shift). The page keeps the
id the address asked for until a chat is on screen, the linked one is
called unavailable, or three seconds have passed since the chat list
answered; a composer drawn meanwhile has no such row (0.002 to 0.004 with
the chat list answering before the ledger). The other order is not covered
by this: when the ledger answers first, the empty page becomes the chat
with its run column in one step, 0.26, as it did before.

**A task the coordinator reopened is one folded line in its chat**
(`lib/taskReopened`, `ReopenedNote`). A coordinator may reopen an approved
task with new instructions and no new approval, and the page has to show
it: the host's durable `octiq_task_reopened` event draws `Reopened <title>
for <assignee> · attempt N` through the shared `CardFold`, with the new
instructions behind it, whole when opened. They are the coordinator's
prose, so they are folded by default and never on the strip. The line
enters once as it is said, is not replayed when the chat is read back, and
the same event read twice draws once. A line is one reopening (the task,
the attempt it starts and the host's stamp): the host numbers the attempt a
reopening will start, so a task reopened twice before it is dispatched says
the same attempt both times and still draws two lines. A reopen the person
made themselves on the page carries `byPerson`, and its line says `You
reopened <title>` with `Your instructions` behind it: the words are theirs.

**Opened, and only opened, the line offers Stop** (`taskReopened.reopenedStop`,
`ReopenedLine`). It is the one thing the person can do about words they did
not approve: the page's own `orchestration_task_stop`, asked first in the
app's dialog (`components/Confirm`, never `window.confirm`). The ledger
decides whether it is offered: a worker on the task and this its latest
reopening. Otherwise the control is off (`aria-disabled`) with the reason
beside it: no worker yet, finished, reopened again since, ledger not read.
**Stop belongs to the line's run.** The line is an event in one chat's
transcript and its task is found in the whole ledger by id, so both ends
are asked before anything is said of the task: the event's `runId` is the
run the task is in, and the chat the line is drawn in (`ReopenedChatContext`,
which `MessageList` provides) coordinates that run. An event of another
run, a chat that no longer coordinates it, or a transcript with no chat
known gets the control off with the reason, and what the ledger says is
asked again when the question is answered.
After a stop the line says `Stopped by you. Only your Start starts it again:
Start is on its row in the run panel.` in place of the control. The line
takes the ledger and the command from `TaskStopContext`, which `App`
provides: a module of the transcript must not import the socket bridge or
the ledger feed, which open a connection on import.

**An action that stops or starts work is never fired by the key or press
that brought it on screen** (`lib/pressGuard`). With focus on Stop, Enter
opened the question, the focus went to its confirming button, and a second
Enter stopped the worker. Five guards, and a new control that stops,
starts or decides something takes the ones that apply:

- **A question puts the focus on its safe answer** (`components/Confirm`,
  and `CompleteChatConfirm`, which asks the same way through
  `useCarefulAnswer`). A second Enter or Space cancels. Tab to the
  confirming button and Enter is an answer, and Escape cancels, as before.
  The comment that said Enter was not wired to the confirming button was
  never true of a focused button. Every question is drawn anew, so one that
  replaced another has the focus on its safe answer too.
- **A held key answers nothing** (`heldKey`, `dropHeld`): the repeats of
  Enter and Space are dropped inside a question, on every start control and
  on Stop of a reopened line.
- **A pointer press that repeats the one that opened something does not
  land on what it opened.** A question remembers the press it was opened
  with (`lastPointerPress`) and its confirming answer drops a repeat in the
  same spot (`strayAnswer`, the cards' 700 ms and 8 px). `Start it again`,
  `Start next attempt` and `Start retry` have no question in front of them,
  like the page's other Starts, so the controls that bring them on screen
  or move them are remembered by the cards' guard (`notePress`): a row's
  disclosure, its two tabs (the start stands above them, and a shorter tab
  slides the row under a pointer near the foot of the panel), its Task
  details and the disclosures inside it, a group's fold and `N more`. So are
  the panel's own Stop, Close mission, Abandon and Archive buttons, each of
  which is replaced where it stands by the question it opens. A row that
  opens under the pointer cannot start a worker.
- **A task's workspace is decided the same way** (`DeliveryActions`).
  `Continue after review`, `Clean up worktree` and `Abandon workspace…` are
  replaced where they stand by their question: the press is remembered
  (`notePress`) and a held key is dropped. The question puts the focus on
  its safe answer (the box the fixes are written in, where Enter is a new
  line and the key that opened it writes nothing; `Keep worktree`), and
  Escape takes it away. `Reopen task in this workspace` and `Confirm
  removal` drop a held key and a press that repeats the one the question
  was opened with (`useCarefulAnswer`). `Cancel` and `Keep worktree` are
  remembered too, because the row comes back under the pointer, and the
  keyboard goes back to the control that asked. `Remove validation
  checkout` has no question and drops a held key.
- **A control that answers where it stands drops a press that repeats one
  just made on something else** (`repeatsAnother`, `strayOnto`). A gate's
  options and its Answer have no question in front of them and no opener of
  their own to remember: whatever brought them under the pointer (the badge
  that led there, a disclosure, a row that moved) was pressed somewhere
  else. The page keeps the last pointer press and the one before it, with
  what each landed on, and such a control drops a press within the cards'
  700 ms and 8 px of the one before it unless that one was on the control
  itself. A press it dropped is not a press on it, so a third in the same
  spot is dropped too.
- **"Off until its answer" is held by what is asked about, never by the
  control** (`lib/inFlight`: `once`, `useInFlight`). A control unmounts: a
  panel is shut and opened, a view is switched, a second surface draws the
  same thing. A request that is out is kept outside every component, under
  a key that names the thing (`planFlight(chat)`, `gateFlight(gate)`). The
  sender takes the key in the same step as it asks and refuses while it is
  taken, and every control for that thing draws itself from it. A new
  action that must not be sent twice is sent through `once`; `busy` in a
  component's own state is not that guard.

Who asks through the shared `Confirm` is listed in `Confirm.test.tsx`,
which fails when a caller is added without it: closing a mission after its
chat was completed (`App`), discarding or overwriting a file (`FilePanel`), deleting a project (`ProjectSettings`) or a saved command
(`TerminalDrawer`), and stopping a task's worker (`ReopenedNote`). Not
through it: deleting a chat has its own countdown, the run panel's Stop,
Close, Abandon and Archive are its own inline questions, whose safe answer
already had the focus, and Remove on an agent's or a team's row in Settings
asks nothing at all (the host refuses an agent with work in progress).

**A chat row that changes place moves there** (`lib/rowMotion`): the list is
sorted by activity, and a row that only changed position used to be
somewhere else on the next frame. Positions are read as the order changes,
never on every render.

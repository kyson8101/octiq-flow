# Questions UI

Moved verbatim from AGENTS.md on 2026-11-24.

### The agent's questions are drawn where they were asked

An `ask_user` question is not a card above the composer. It is drawn in the
transcript, at the call that asked it (`components/InlineQuestions`,
`lib/questionBlock`), with no card round it: each question a heading line,
its options radio rows (checkbox rows when `multiple`), an option's
description under its label, a quiet `Recommended` in words, and one
full-width answer button with a centred icon + `Send` label in `--decide`
(40px on desktop, 44px on a phone or coarse pointer). Every question of one call is one block
with one button. The host's contract is what it was: `question_pending`,
the `user-question` events, `question_answer_batch`, `question_cancel`,
`question_retry`.

- **A question can show media, and the host keeps it** (`question_media.rs`,
  `scripts/mcp/question-media.cjs`, `docs/question-delivery.md`, Media). Up
  to four local images, videos or sounds under a question, an image on each
  option; local absolute paths only. The agent's MCP server reads each file,
  as the agent, and streams it to `/hook/question-media`; the host decides
  what it is by its first bytes, caps it (image 20 MB, video or sound
  200 MB, 300 MB a call) and keeps an immutable snapshot under
  `<chats dir>/question-media/<chat id>/`. The ask names snapshots by id
  and `question_media::resolve` rebuilds every field from the chat's own
  folder before anything is asked: a file that cannot be shown refuses the
  whole call in words and is never dropped. `Media { id, kind, mime, path,
  name, caption?, bytes }` rides `question.media` and an option's `image`
  through the record, `user-question`, `question_pending` and the answered
  line; `path` is served by `/file`. The answer is labels only. Snapshots
  go with the chat at purge, never at the trash or `/clear`.
- **The page draws that media where the question is** (`lib/questionMedia`,
  `components/QuestionMedia`). Every reader is tolerant: an entry that does
  not read is dropped and the question still draws. Exactly one item sits
  beside the question (`MediaBesideText`), stacking when narrow; with two
  or more, under the heading a strip: a picture in a fixed 168 by 112 box that opens the shared viewer
  (Escape shuts it), a video in a 16:9 box and a sound in a 40px one, both
  the browser's own players (`preload="metadata"`, from `/file`), each with
  its caption and name in words. An option's picture is a 64px square
  inside its row, between the mark and the words (a press on it selects
  the row); the control that opens it full size is beside the label, never
  in it, so it selects nothing. **Every box has its size before anything
  arrives, and keeps it when a file will not load**: the place stays,
  unframed, and says `Could not be shown`, so nothing under it, the Send
  button included, moves as files arrive or fail. Nothing is fetched until
  it is near what the transcript's scroller shows. On the answered line
  the media is folded: 28px thumbnails of the pictures (the question's and
  the chosen option's), a player's kind and name, the count, on the line's
  one disclosure (`CardFold`); opened, each file whole. A call's own result
  carries no media, so the call borrows it from the host's line for the
  same words (`questionBlock.withMediaOf`). `scripts/test-question-media.mjs`
  draws it in the real App at 1280 and 390.
- **Where a block goes is worked out from the words** (`placeQuestions`).
  The host's record carries no tool-use id, so a pending batch finds its
  call by the questions it asked, in order, among the calls that carry no
  answer yet. A batch whose call the page does not draw (asked before the
  turns it holds, behind `Load earlier messages`, a subagent's call, a
  provider with no such call such as Codex's native question) is drawn at
  the end of the transcript. Asked of the turns actually drawn, so a
  question is never placed where it cannot be seen.
- **It is drawn only where the person can answer** (`ChatQuestionsContext`,
  which `App` provides for a chat that is not a worker's). A worker asks
  through a gate (`route_worker_questions`): the host makes no question
  record for it and no page ever drew one, so in a worker's chat, the task
  chat beside a run and a subagent's view the call keeps its tool row.
- **The recommended option is selected when the block arrives**, and a
  question with none starts with nothing selected (`startPick`). Only the
  person's press sends it. The button stays off (`aria-disabled`, never
  removed from the keyboard) until every question has an answer, and the
  reason is in words under it (`submitReason`), where it moves nothing.
  `Other…` is the last row of every question with options and shows its
  text box under itself; a question with no options shows the box directly.
- **A block is whole before it can be sent** (`Batch.missing`,
  `submitReason`). The host says how many questions a call carried
  (`batchSize`) and sends them one event each, so a block can be on screen
  before its last question is. Until every one has arrived the button is
  off and the reason under it says `Still reading the questions: 1 of 2 has
  arrived.` With one of two arrived and a recommended option the button was
  on and sent that one; the host kept it and went on waiting for the other
  (review 3, H4). What has arrived is counted by what this page was told
  (`batchesOf`), so a question the page itself took off its list (an older
  host keeps no record of an answer) still counts and the rest stays
  answerable.
  - **`Still reading` is said only while more can still arrive:
    `batchSize` may delay a send and never forbids one.** Three things end
    the wait for a call's missing questions (`batchesOf`, `stillMissing`):
    - every one of them has been seen on this page;
    - the host's own list of pending questions named the call, in a read
      of that list, and this host is known to answer one question at a
      time (`questionBlock.listedQuestions`, told by the one place
      `question_pending` is read; `lib/questionHost`). Such a host (older
      than the durable store, no batch command) drops each question as it
      is answered, so what its list names IS what remains of the call;
    - the list named the call and `LISTED_GRACE_MS` (ten seconds) have
      passed since (`Batch.until`; the block draws itself again then). A
      host that keeps a call's record lists every question of it, so a
      part of a call in its list is a call caught as it was being asked,
      and the rest follows at once or not at all.

    The hole (review 3b): with the first of two through and the second's
    send failed on a host with no batch command, a reload listed the second
    alone, still `batchSize: 2`. Counted against what the page had seen
    arrive (nothing, after a reload), the block said `1 of 2 has arrived`
    for good with its button off. That is the state between a client build
    and a server restart.
  - **Which kind of host it is, is learned by sending and remembered in
    the browser** (`questionHost.sawOneAtATime`, from
    `submitQuestionAnswers`): set before the first answer of a one-at-a-time
    send goes, because a part of it can fail, and forgotten the first time
    the batch command answers. It is a hint that decides only whether a
    listed part is whole at once or after the grace; nothing waits on it
    for good. A listed part is NOT whole at once on a host that is not
    known to be that kind: one of two in the list at page load is held like
    one of two events, which is what review 3's H4 probe sends.
  - A read list is not a licence for a later call: one whose questions
    come by event after it is held until every one is here, with no end to
    wait out, on either kind of host.
  - What the page counts of a call is in memory, and is forgotten when no
    question of the call is left on the page (`keepBatches`, as the
    page's question list changes): a record that completed, was
    cancelled, or went with its chat's history.
- **A call answered in part is drawn in parts** (`batchParts`). The host
  takes a call's answers one question at a time and wakes the agent only
  when every one is in, so a call can be half answered: by another tab, by
  an older page, by a record read back after a reload. What has an answer
  is a quiet line and the person's bubble, each answer with its question,
  under `Answered · the agent waits for 1 more question` (never `saved`:
  the host calls a record saved only when it is whole); what has none is
  asked, in the same block. What this page remembers sending is read only
  for the questions it was sent for (`Sent.ids`): no branch draws from it
  alone, which is how a question that arrived afterwards was hidden.
- **It is never answered by the press or the key that was already going
  on.** It arrives under the pointer with an answer already selected, so:
  it never takes the focus (no `autoFocus`; the composer keeps it), the
  button and Dismiss drop a key held down (`dropHeld`), and both drop a
  pointer press that repeats the one made before the block was there
  (`lastPointerPress` as the block mounts, `strayAnswer`). A new control
  that answers takes the same two.
- **Answered, it is a quiet line and the person's bubble** (`AnswerBubble`):
  the bare answer for one question, the question and its answer for
  several. The bubble is drawn from what the host holds, never from what
  the page remembers, so delivery, a reload and a second tab draw the same:
  the question's record while the host lists it, the call's result once it
  has one (`lib/askAnswer`), the host's `octiq_question_answered` line in
  the chat's record (next), or the host's own turn when the answer came
  after the call had ended. That turn (`octiq-question-<record>`,
  `isAnswerTurn`, `answerTurn`) is drawn as the bubble and not as the
  host's words, where it stands in the conversation. What the page
  remembers of an answer it just sent is shown only until the host's word
  arrives.
- **The host keeps an answer that was handed over in the chat's record**
  (`question_store::Record::answered`, `docs/question-delivery.md`, The
  answered line). When an answer reaches the agent while its call waits,
  the host writes one `octiq_question_answered` event there, before it says
  `question-expired`: the questions as asked, the answers as given, the
  record's `id`, and `via` (`native` for a provider's own request, which
  has no tool call in the transcript; `tool` for `ask_user`). It is written
  by the one `take_tool` or `take_native` that hands the answer over, so
  once; a cancelled or unanswered question writes none, and a late answer's
  record is its host turn. The answer never waits for the line: one the
  record would not take is said `unsaved`, owed (`answered questions` in
  `profile_status.owed`) and written by `settle_notes`, which looks for it
  by `id` first. Review 3 of the batch (H3) found the answer to a Codex
  question gone from the page after delivery and after a reload: nothing a
  transcript reader finds held it. **The line is for the record the answer
  was handed over in, and is owed until that record gives a receipt**: it
  is written by `transcript::append_in`, which checks the record's
  generation and appends in one step under the append lock (a `/clear`
  while the owed pass read the record put the old answer into the new
  history), and what is owed is dropped only on `Held::Confirmed`, or on
  `Held::Moved` for a history that is gone, never because the line can be
  read back (review 2b, N1 and N2). Capacity eviction is not a history
  change: live `Generation` tokens pin their record life, and bookkeeping
  may discard only lives no token observes. Never refresh a debt's token
  to get past an unknown or cleared history (memory review H1).
- **The page draws a delivered question from that line**
  (`question.readQuestionAnswered`, `questionBlock.placeAnswered`,
  `AnsweredInline`). The reducer keeps it as one transcript item for a
  record (`octiq-answered-<id>`: the same line can be heard twice), with a
  block of its own kind (`answered`). **A line is attached by what it is,
  never by its words alone**: the words say only which calls could be its
  own, and the same words are asked twice.
  - `via: "native"` is never attached to a tool call, one still waiting
    included. It is drawn where the line stands, as the questions asked and
    the person's bubble.
  - `via: "tool"` is attached to the `ask_user` call it was written for:
    the newest call before the line that asked those words and has no line
    yet (the line is written between a call and its result), and only
    while that call has no answer of its own or says the very answers the
    line does (`takesLine`). Attached, the call draws the answer (from its
    result, or from the line before the result is in, so a tab that did
    not send it draws it too) and the line draws nothing: a question
    answered through the tool is drawn once. Otherwise (no such call in
    these turns, or the one there was answered in its own right) the line
    is drawn where it stands.
  - **A call that has its own answer is never given another**, and a call
    that ended with nothing said (closed, timed out, saved for later) has
    no line: the host writes one only for an answer handed to a call that
    waits. A call a line could not take is not used up by it.
  - Words alone were the hole (review 3b): an old call answered `Merge`,
    from a record older than the host's lines, then the same words asked
    natively and answered `Rebase`. The native line was bound to the old
    call, the call drew its own result, and the page showed `Merge` and no
    `Rebase`, after a reload too.

  A question the line answers is not also drawn from the pending list
  while the host still lists it, and the host's late turn for the same
  record wins over the line. A line that is not whole (no id, no question,
  an answer that is not text) draws nothing, in part or otherwise.
- **A Codex question is still drawn at the end of the transcript while it
  waits.** The provider's own request leaves no tool call in the
  transcript, so there is no call to draw it at. Answered, it is where its
  line stands in the record, which is where the conversation had got to.
- **The bubble is not a message.** No edit, retry, take-back or copy on it,
  no point on the conversation map, not grouped as a turn, and never
  returned to the composer (`reclaim` skips an answer turn). The record's
  line is the host's item in the reply's own column, never a person's turn.
- **The half-states keep their own words** (`answeredNote`): `Answers saved
  · waiting for the agent` only for what is on disk, `Answers sent · not
  saved` with the host's reason behind a disclosure, `Answers need
  attention` with `Retry delivery`. `Cancel pending delivery` and `Dismiss
  without answering` are `question_cancel`.
- **Out of view, one row above the composer says so** (`lib/questionSight`,
  `QuestionWaitingRow`): `1 question waiting`, while a block that still asks
  is not on screen, and not while it is. One `IntersectionObserver`, no
  scroll listener. Pressing the row goes to the block and puts the keyboard
  on its first control; it presses nothing.
- **Nothing else reads a question differently.** The sidebar's badge,
  `pendingActions.heldCards`, `lib/runWaits` and `lib/chatWait` go on
  reading it as a held card from the page's one list; the block carries the
  same `data-pending-keys` the card did. Do not add a second reader.

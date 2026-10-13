# Recoverable agent questions

`ask_user` keeps questions until the person answers or explicitly cancels them.
Closing the browser, losing a connection, or reaching the tool's ten-minute
deadline does not discard a question. Permission prompts retain their separate
approval and timeout behavior.

## Permission is asked in chat, not on a card

An agent never uses `ask_user` to ask permission for an action with side
effects: commit, push, merge, deploy, release, restart, delete, or sending
anything off the machine. It asks in the chat in plain prose, names the exact
action, ends the turn and waits. Only the person's typed reply counts as
approval. Cards stay for ordinary decisions such as which approach, what name,
or which items to include; a card that would mix the two keeps the decision and
leaves the permission to the chat.

The reason is Claude Code's auto mode. Its classifier judges an action from the
user's messages and the agent's tool calls, and it strips tool results as a
prompt-injection defence. A card answer comes back as the `ask_user` tool
result, so an approval picked on a card is invisible to it and the action is
refused as unrequested (feedback 8301d3b9). Delivering card answers as user
turns instead was rejected: that turn would carry agent-written question text
as the person's own words.

The rule is in `ASK_PROMPT` (`agent_provider.rs`) and the `ask_user` tool
description (`scripts/mcp/octiq-ask.cjs`). Codex never sees either; its
`ask_user` tool is disabled.

## Delivery

- Questions, answers, and the asking agent's resume context are saved in the
  active profile's `chats/questions.json`. Updates use a private temporary file,
  flush its contents, and atomically replace the saved file. An unreadable store
  is reported and never silently replaced with an empty one.
- While the original tool is waiting, the complete answer batch returns through
  that tool. A timeout or ended agent turn detaches the live waiter; the same
  questions remain available on every device.
- A later answer creates one continuation containing the original questions and
  answers. It uses the saved provider session, model, workspace, and access
  settings. A different provider session is reported instead of redirecting the
  answers to another process.
- Continuations use the existing chat queue and a stable user-turn ID. Startup
  recovery replays saved answers that were not dispatched, including a queue
  lost with the old server process. A provider receipt closes the saved card.
- Dispatch without a receipt is uncertain. The answer remains visible with an
  explanation; it is not automatically executed again. A known launch failure
  offers an explicit retry. This is duplicate-safe dispatch, not a guarantee
  that arbitrary external actions performed by an agent are exactly-once.
- Stop, cancellation, and conversation deletion cancel pending continuations.
  They do not undo an answer or action the agent has already received.

The launch supplies `OCTIQ_CHAT_KEY`, `OCTIQ_SESSION_KEY`, and `OCTIQ_LAUNCH_ID`
to the MCP child. The conversation key selects the UI; the process and launch
identities prevent an old question from resuming a stale process.
Saved answers are never interpreted as permission to resume explicitly stopped
work.

## Browser contract

`question_answer_batch` persists the whole submitted card atomically and returns
`{ "saved": true }`. A rejected request or unconfirmed receipt leaves the input
visible. Retrying identical answers succeeds without dispatching them again;
conflicting answers are rejected.

`question_pending` restores pending questions and saved answers after reconnect.
`question-updated` updates their saved/error state; `question-expired` removes
delivered or cancelled questions. `question_cancel` cancels a card and
`question_retry` retries a known delivery failure. The older `question_answer`
command remains available. A new browser also falls back to that command when
an older backend explicitly reports that the batch command is unavailable; it
still requires a positive delivery receipt.

## The answered line

`question-expired` takes a delivered question off every page, and the store
that holds its answer is not something a transcript reader walks. So when an
answer is **handed to the agent while its call waits**, the host writes one
event into the chat's record, at that moment:

```json
{
  "type": "octiq_question_answered",
  "id": "<the question record's id>",
  "via": "native",
  "at": 1791926691389,
  "questions": [
    {
      "id": "<the id the question was listed under>",
      "question": "Which branch should this go to?",
      "options": [{ "label": "develop", "description": "The base for new work" }, { "label": "main" }],
      "recommended": 0,
      "multiple": false,
      "answer": "develop"
    }
  ]
}
```

- **One line for one call**, with every question of the call in the order
  asked. `options` are always `{ label, description? }` and `[]` for a
  free-text question; `recommended` is the index the agent named and is
  absent when it named none (Codex's own request never names one);
  `multiple` is always said; `answer` is the string the page sent. `at` is
  the host's clock, in milliseconds, when the answer was handed over.
- **`via` says which way the answer went.** `native` is the provider's own
  request (Codex's app-server `item/tool/requestUserInput`): the agent's
  stream holds no tool call of ours, so this line is the only thing in the
  record that says what was asked and answered. `tool` is an `ask_user` call
  answered before its ten minutes ran out: its tool result carries the same
  answers, and the line is written all the same, because the host cannot
  know whether the page holds that call (a subagent's call, a provider whose
  call the page does not recognise, turns it has not loaded). The line sits
  where the answer was given, which for a tool call is between the call and
  its result. A page that can attach the questions to a call it draws needs
  nothing from the line; one that cannot draws the answer where the line
  stands. It is the same for both kinds.
- **It reaches the page like any line of the record**: `chat_since` and
  `chat_page` read it with its `seq`, and it is heard as a `chat-event`
  (`{ key, seq, event }`) **before** the `question-expired` of its
  questions, so a page is never told to stop drawing a question it has not
  yet been told the answer of.
- **Once for a record, and found by `id`.** A hand-over happens once
  (`take_tool` and `take_native` each answer once), so a second tab sending
  the same answers, a repeated press and the host's own sweeps add nothing.
  The same event can still be HEARD more than once (a write that failed is
  tried again and said again), so a page draws one for an `id`.
- **Not written:** for a question that was cancelled (by the person, by a
  Stop, with its chat), for one nobody answered, and for an answer that
  arrives after its call ended. That answer goes to the agent as the host's
  own turn, `octiq-question-<id>`, which is its record and is what a page
  draws; the id after the prefix is the same `id`. A worker's question is a
  gate and has no record at all.
- **The answer never waits for the line.** The agent is given its answer
  whether or not the record takes the line. A line the record would not take
  is said (`unsaved`: `the answered questions in the chat's record`, with
  the reason; never as saved) and owed: `profile_status.owed` names
  `answered questions`, and the host writes it on its next pass (every two
  seconds once the profile folder is back; a record that goes on refusing
  with the folder there is asked again after 4 seconds, doubling to a
  minute). Each try looks for the line by `id` first, one pass at a time,
  so it is never there twice. Every page open at the time still heard the
  event, with `seq: null`.
- **Limits.** What is owed is in memory: a restart before the line is
  written loses it, and that question then has no line. (With the profile
  folder away the hand-over itself is usually owed too, and a restart then
  reads the answer as not delivered and sends it as the host's turn, which a
  page does draw. So a record can, in that one case, have both: the page
  draws one, by `id`.) A chat cleared (`/clear`) or deleted between a failed
  write and its next try does not get the line: the record the answer was
  given in is gone, and the line is dropped with it. The line is written
  with the same durability as a reopen notice's (`append_synced`); nothing
  waits on a receipt for it.
- The command the page sends is unchanged: `question_answer_batch` takes and
  answers what it did.

The page's type is `QuestionAnswered` (`web/src/lib/question.ts`), and two
lines the host's own tests wrote are in `web/src/lib/__fixtures__/host`
(`question_answered_native.json`, `question_answered_tool.json`).

## Validation

```sh
cargo test --manifest-path src-tauri/Cargo.toml --offline
cd web
pnpm test
pnpm build
```

`node scripts/test-question-delivery.mjs` runs the real card and pending-request
hook in an isolated browser fixture. It checks disconnected and rejected
submissions, retained choices, saved-answer reloads, and delivery events at
desktop and phone widths. Set `OCTIQFLOW_PLAYWRIGHT_MODULE` to an installed
Playwright module if necessary. The fixture does not connect to real chats or
start an agent.

Rust regression tests cover the actual tool timeout, disconnected/offline
questions, restart recovery, partial batches, storage failures, cancellation,
duplicate submissions, dispatch uncertainty, and live-tool/continuation races.

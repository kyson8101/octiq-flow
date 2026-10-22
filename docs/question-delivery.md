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

## Media

An `ask_user` question can show the person what they must see or hear to
answer: up to four local files under the question, and an image on each
option. Images (PNG, JPEG, GIF, WebP), video (MP4, MOV, WebM) and audio (MP3,
WAV, M4A, OGG); no PDF, no URL, nothing fetched off this machine. Codex's
native questions carry none (Codex has no MCP `ask_user`).

**What the agent sends** (`scripts/mcp/octiq-ask.cjs`, `QUESTION_PROPS`):

```json
{
  "question": "Which layout should the home screen keep?",
  "media": [{ "path": "/abs/home.png", "caption": "The home screen today" }],
  "options": [{ "label": "Keep", "image": "/abs/face.png" }, "Change"]
}
```

`media` is at most 4 `{ path, caption? }` (a caption is one line of at most
160 characters); `image` is an absolute path, images only. String options are
unchanged.

**Where the copy happens, and why there.** The agent's own MCP server
(`scripts/mcp/question-media.cjs`) opens each file, non-blocking so a FIFO
cannot hang the call, and streams its bytes to `POST /hook/question-media`
(the launch's capability, `chatKey`/`sessionKey`/`launchId`, `name` and
`bytes` in the query, the file as the body). The file is read there, by the
agent's process with the agent's rights, and never by the server: an agent
cannot show the person a file it could not open itself. This is
`preview_image`'s precedent: an MCP server is outside Claude's Bash sandbox
and Codex's seatbelt, as `preview.cjs` is, so the rights are those of the
agent's process. What differs from `preview_image` is who writes the
snapshot: the host (`src-tauri/src/question_media.rs`), so the folder is made
only through `profile::make_dir` and nothing is written into a profile folder
that is gone or replaced.

**The host decides what a file is by its first bytes**, never by its name.
The upload answers the snapshot, or `400 { error, outcome }` with a sentence
that names the file:

- not a kind it can show; a name whose extension promises another kind
  (`shot.png is named .png but holds a JPEG image`); a video or sound for an
  option; empty; a size that is not the one the MCP measured (the file
  changed while it was read);
- over its cap: an image 20 MB, a video or a sound 200 MB. The MCP checks the
  caps and 300 MB for the whole call before it uploads anything.

Each snapshot is `<chats dir>/question-media/<chat id>/<id>.<ext>`: `id` is 32
hex characters, new for every upload, the file is made with `create_new`
(mode 0600) and never written over, and one that does not arrive whole is
removed.

**The ask names snapshots by id.** The MCP replaces each path with
`{ id, name, caption? }` and sends the call to `/hook/ask`. Before anything is
asked, `question_media::resolve` rebuilds every entry from the chat's own
folder: kind, mime, path and size are read from the snapshot the host wrote;
only `name` and `caption` are the agent's. A call is refused whole (`400`,
nothing asked, nothing listed) for an id that is not this chat's snapshot, a
path sent without uploading, more than 4 under a question, a caption over 160
characters, an option image that is not an image, or more than 300 MB in all.
Media is never dropped: a question that says "pick by the picture" with the
picture gone would mislead. The MCP tool result is then `Nothing was asked:
<the sentence>`, an error with outcome `validation`.

Validation alone does not adopt an upload. The host excludes discard while
rechecking and storing the question (or worker gate), then adopts its media
only after storage succeeds. After delivery returns, the HTTP handler discards
this call's still-unclaimed snapshots, including when a late origin check or
question-store write failed and the answer is delivery-failure text. Adopted
snapshots and unrelated uploads remain untouched.

**What is stored and sent to the page** (camelCase), on a question as
`media` (absent when none) and on an option as `image` (absent when none):

```json
{
  "id": "ac13aa5f2b934dae9f571394be2285f1",
  "kind": "image",
  "mime": "image/png",
  "path": "<profile>/chats/question-media/<chat id>/ac13aa5f2b934dae9f571394be2285f1.png",
  "name": "home.png",
  "caption": "The home screen today",
  "bytes": 316
}
```

`kind` is `image`, `video` or `audio`; `caption` is absent when there is none.
It rides the question record (`questions.json`), every `user-question` event,
`question_pending`, and the answered line below, so a reload draws the same
media. `path` is served by `/file` on the person's token, with byte ranges for
video and audio; the snapshot's extension is the one `/file` takes its type
from. The answer the agent gets is unchanged: labels and text only.

A worker's questions become a gate (`route_worker_questions`): its text names
each file with its kind and path, so the coordinator can look before
answering.

**Lifecycle**: like the chat's plan, kept through the trash window and
`/clear`, removed when the chat is purged (`question_media::forget`, from
the purge sweep and from startup's `chat_index::reconcile`).

Fixtures: `web/src/lib/__fixtures__/host/question_media_pending.json` and
`question_answered_media.json`, from `web::tests::
an_ask_user_call_shows_the_snapshots_its_chat_uploaded_and_nothing_else`.

**How the page draws it** (`web/src/lib/questionMedia.ts`,
`web/src/components/QuestionMedia.tsx`). The page reads `media` and `image`
tolerantly: an entry with no `id`, no `path` or an unknown `kind` is
dropped, an option `image` that is not an image is dropped, and the
question and the option still draw. Under the question's heading each file
has a box of a fixed size before anything is fetched (a picture 168 by 112,
fitted inside it; a video 16:9; a sound 40px high), with its caption and
`name · size` under it. A picture is fetched as a blob through `/file` and
opens the shared viewer; a video or a sound is the browser's player pointed
at `/file` with `preload="metadata"`. Nothing is fetched until it is near
what the transcript shows. A file that will not load keeps its box,
unframed, with `Could not be shown` in it, so the button under the block
does not move. An option's picture is a 64px square inside its row; the
control that opens it full size is beside the label and selects nothing.
On the answered line the media is folded on the line's one disclosure:
28px thumbnails of the question's pictures and of the chosen option's,
a video's or a sound's kind and name, and the count; opened, every file as
under the question, the option's picture marked `Chosen · <label>`. Which
option was chosen is read back from the answer the way the page wrote it
(one label, or the labels in the order offered joined by `, `). Labels may
hold `, ` or start one another (`A` and `A, B`), so every reading is worked
out: one that is whole labels alone wins, then one that ends in typed words;
an answer that still reads two ways shows no option's picture as chosen
(`questionMedia.chosenLabels`). On a finger's screen the enlarge control
hangs off the picture's top-right corner, clear of its middle, so a tap on
the picture chooses the row.

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
  asked. `options` are always `{ label, description?, image? }` and `[]`
  for a free-text question; `media` is the question's snapshots as listed
  (see Media) and absent when it showed none; `recommended` is the index the agent named and is
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
  whether or not the record takes the line. A line the record would not
  take, or took and could not confirm, is said (`unsaved`: `the answered
  questions in the chat's record`, with the reason; never as saved) and
  owed: `profile_status.owed` names `answered questions`, and the host sees
  to it on its next pass (every two seconds once the profile folder is
  back; a record that goes on refusing with the folder there is asked again
  after 4 seconds, doubling to a minute). Each try looks for the line by
  `id` first, one pass at a time, so it is never there twice. Every page
  open at the time still heard the event, with `seq: null` when the line
  was not written.
- **Owed until the record gives a receipt for it.** A line that can be read
  back is not a saved one: the write may have held and the sync after it
  not. So the line stops being owed only when the record it is in has been
  synced as it is and then its folder, in one step under the transcript's
  append lock, for the record the answer was handed over in
  (`transcript::append_in` for a line written now, `transcript::receipt`
  for one found there). That holds for the first write too, into a file
  that was already there as much as into one the line made. Until the
  review of 2026-10-14 a pass that found the line dropped what was owed
  with nothing asked of the disk.
- **It goes into the history the answer was given in, or into none.** Which
  record the chat has is taken when the answer is handed over, and the
  check that the chat still has it and the append are one step under that
  same lock. A chat cleared (`/clear`) or deleted at any moment before the
  line is written does not get it: nothing is written into the history
  started afterwards, no page is told, and the line is dropped with the
  record it belonged to. The check used to be made before the pass read
  the record for the line and not again before it wrote, so a `/clear`
  during that read put the old answer into the new history.
- **Limits.** What is owed is in memory: a restart before the line is
  confirmed loses the debt, and that question then has no line, or has one
  nobody confirmed. (With the profile folder away the hand-over itself is
  usually owed too, and a restart then reads the answer as not delivered
  and sends it as the host's turn, which a page does draw. So a record can,
  in that one case, have both: the page draws one, by `id`.) The line and
  its sync are written while the answer is being handed over, so a slow
  disk delays the answer by that write; it never refuses it. Nothing but
  the debt waits on the receipt.
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

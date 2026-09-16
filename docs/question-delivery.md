# Recoverable agent questions

`ask_user` keeps questions until the person answers or explicitly cancels them.
Closing the browser, losing a connection, or reaching the tool's ten-minute
deadline does not discard a question. Permission prompts retain their separate
approval and timeout behavior.

## Delivery

- Questions, answers, and the asking agent's resume context are saved in the
  active profile's `chats/questions.json`. Updates use a private temporary file,
  flush its contents, and atomically replace the saved file. An unreadable store
  is reported and never silently replaced with an empty one.
- While the original tool is waiting, the complete answer batch returns through
  that tool. A timeout or ended agent turn detaches the live waiter; the same
  questions remain available on every device.
- A later answer creates one continuation containing the original questions and
  answers. It uses the saved provider session, model, workspace, access settings,
  and seat. A removed seat or a different provider session is reported instead
  of redirecting the answers to another agent.
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
identities prevent a seat's question from resuming the host or a stale process.
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
desktop and phone widths. Set `OCTIQOS_PLAYWRIGHT_MODULE` to an installed
Playwright module if necessary. The fixture does not connect to real chats or
start an agent.

Rust regression tests cover the actual tool timeout, disconnected/offline
questions, restart recovery, partial batches, storage failures, cancellation,
duplicate submissions, dispatch uncertainty, and live-tool/continuation races.

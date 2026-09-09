# Message queue

Queue controls follow backend ownership of a message. A missing provider echo
is not evidence that a message is still in the queue.

| State | What it means | Available action |
| --- | --- | --- |
| Sending… | The browser's send request is being accepted | Wait |
| Queued | The server owns an editable queue entry | Send now, Edit |
| Sending next… | The current reply is being interrupted for this message | Wait |
| Awaiting agent confirmation | The prompt has left the editable queue, but the provider has not acknowledged it | Wait, Copy |
| Sent | The provider acknowledged the prompt | Copy |
| Not sent | The server no longer holds an unacknowledged queued message | Restore to composer, Dismiss, Copy |
| Delivery unconfirmed | An older record, interrupted connection, or ended process cannot establish receipt | Restore to composer, Copy; check the conversation before sending again |

**Send now** stops the current reply and makes the selected message the next
turn. Other waiting messages retain their relative order. **Edit** removes only
the selected queued message and restores its text and attachments to the
composer without overwriting an existing draft. Seat routing is restored too.
Queue actions are unavailable offline.

The message text and its delivery controls use separate surfaces. Desktop and
mobile share the same visible text buttons, with 44px minimum targets and
keyboard focus indicators. The toolbar retains its height after acknowledgement.
The existing LXGW WenKai Screen font and theme tokens are retained: background
`#1c1c1e`, secondary surface `#2c2c2e`, hover `#3a3a3c`, text `#f5f5f7`, accent
`#0a84ff`, and warning `#ff9f0a`. Content and status align left; actions align
right, wrapping on narrow screens. Queue state carries the visual hierarchy;
no hover-only controls or swipe gestures are required.

## Protocol and concurrency

- Canonical user envelopes and `octiq_user_turn_delivery` events are written to
  the transcript for both Claude and command-line providers. Delivery events
  use the same `uuid` as the browser's `turnId`.
- Provider acknowledgement remains separate: Claude echoes and Codex/Pi turn
  starts are tagged with the exact dispatched message ID. Identical messages
  do not match by newest text. Optimistic React IDs also use this stable ID.
- A process ending before acknowledgement records `unknown` after stdout drains.
  A later Codex turn also marks abandoned earlier dispatches as unconfirmed when
  replaying older records. Starting a process is never described as receipt.
- Enqueue, cancellation, promotion, and one-shot process handoff share the
  session lock. A handoff reservation accepts incoming messages into the queue
  and prevents a competing browser start. The waiting tail stays in place.
- Failed handoffs emit failure for the selected message and every remaining
  entry. The words remain in the transcript for explicit recovery.
- The client allows one pending queue mutation per message. A stale click
  refreshes transcript and queue state; it does not append duplicate global
  warnings. RPC failures remain beside the affected message.
- Snapshot reconciliation runs while other replies stream. It only changes
  prompt objects that have not changed since the read began and excludes sends
  still being accepted. Obsolete action locks from a restored checkpoint clear.

Queue execution remains in memory. A server restart does not silently replay
old prompts. Their recorded content survives, and the client distinguishes
lost or unconfirmed delivery from queued work. API connection errors, including
certificate errors, remain provider failures; delivery state does not imply a
successful reply.

## Verification

Run `pnpm --dir web test` and `cargo test --lib` in `src-tauri/`. The browser
regression is `node scripts/test-queued-message.mjs`; set
`OCTIQOS_PLAYWRIGHT_MODULE` to an installed Playwright module when needed. It
uses mock transport responses and real message/composer components at desktop,
390px, and 320px widths, exercising action locking, pickup, and restoration of
text and attachments. It starts no real agents and prints screenshot paths.

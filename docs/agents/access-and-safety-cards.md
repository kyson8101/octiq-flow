# Access request card and auto-mode refusals

Moved verbatim from AGENTS.md on 2026-11-24.

### An agent asks for more access on a card

`request_access` (`octiq-ask.cjs` → `POST /hook/access` → `access_request.rs`)
puts a card in the chat its capability proves: the level now, the level asked
for, and why. **The call changes nothing.** The card's Upgrade sends the page's
own `chat_set_access` — the access picker's command, which no hook reaches —
and only after it worked does the page answer `access_request_answer`; the
host then reads the chat's level back from its start context and tells the
agent that, not the page's word. Workers, front desks and room seats are
refused: a worker's level comes with its task.

When a raise takes hold is the provider's (`access_request::Takes`): Claude
mid-turn (a control request), Codex app-server and command-line providers from
the next turn, Antigravity only between turns — so its call does not wait; the
card stays up and the agent is told to end its turn. Claude waits as long as a
permission card, Codex 50 s (its MCP call times out near 60). An Antigravity
refusal asks on this same card, drawn from `ChatState.accessNeed`.

**A raise is recorded before it is made, and one that cannot be recorded
changes nothing.** `chat_set_access` asks which way the level moves
(`access_request::rank`). A raise is written down first (the ledger's resume
settings, for a chat a run knows) and refused while that cannot be done, in
words that begin with `agent_chat::NOT_RAISED`; the agent is told nothing. The
page knows the refusal by those words (`lib/accessRaise`, whose test reads the
host's constant): the card that asked stays up with the reason and is not
answered, so a waiting agent goes on waiting, and the access picker goes back
to the level the chat still runs at instead of restarting the agent, which is
what it does for every other refusal. A lowering takes hold at once and is
written when it can be (see **Conventions**, rule C).

**A chat's level is its own, and the product never narrows it.** A chat opened
for a registered agent (a route, a handover, a conversation the person starts
with it) opens on that agent's registered settings, and nothing in the host,
the MCP server or the page opens, re-sends or switches a chat to read-only on
the product's own initiative: a route's `purpose: "discuss"` is wording only.
After that the chat keeps the level it has. The page sends the level it holds
and works nothing out; no host rule raises a chat at a start, and there is no
level event. Three ways of making an agent's chat follow its registration
afterwards were built, failed review and are not here: a rule on the page (it
does not reliably know the roster or what is running when it must decide), a
level event from the host to the page (an unordered frame overwrote a level
the person had just picked), and the host as the only writer of the chat's
saved level (it dropped a level picked on the access picker, which is drawn
for an agent's chat whenever agents mode is off). Chats an earlier build
opened as read-only discussions are lifted to their agent's registered level
once, at startup; that pass, its limits and what is still open are in
`docs/agents-mode.md`.

### An auto-mode refusal the agent carries on past is a notice, not a card

Claude's auto mode refuses a call mid-turn and the agent usually goes on
another way, so the page says it the way Claude Code's own terminal does
(`lib/safetyToast`): a short notice over the foot of the transcript
(`SafetyToast`, about five seconds, held under the pointer or keyboard focus,
one notice counting several refusals), and one folded line at the end of the
transcript that opens to the same card with the same two answers
(`SafetyBlock` with `folded`). Nothing on the host changed: the record, its
pending key and what the buttons send are the card's.

- **What splits them is whether the turn is still running** (`splitSafety`).
  A judged refusal folds only while `chat.busy`; once the turn is over with it
  still unanswered, the agent has stopped and it is a compact answer row above
  the prompt box. A judged worker refusal uses that same row in its coordinator's
  chat, prefixed by the worker/task name in muted text, with no separate
  "Approval for Worker" heading. The record carries no time and no tool-use id, so "the
  agent went on and finished anyway" cannot be told from "it stopped on this".
- **A Codex block never folds, and an outage never loses its Retry.** Both
  offer something only the person can choose (an approval, a retry). The
  outage of Claude's classifier is no verdict and no warning, so it is one
  quiet row, not a card: a neutral grey info icon and rule, `Safety check
  unavailable · 2 commands not run`, the leading `Retry once` kept visible on
  the folded row (`--decide`, like every leading answer), one chevron and the
  shared Dismiss × last. No eyebrow, no "OctiqFlow is okay" badge, no count
  pill: the count is in the words. Opened, the refused commands (drawn through
  `cardFold.commandDrawn`, with `×N` when repeated), "These refused calls did
  not run. Nothing was approved.", the technical details, the Always allow
  rule and file (when the host named them) and "What the agent was told"
  appear. The pending key, badge tone (`warn`), press guards and the messages
  sent are unchanged; it keeps `role="status"` and `.is-outage` on the row's
  `.safety-refusal` shell (`decideColour.test.ts` checks it is never amber or
  red).
- **Only a live `safety-blocked` event raises the notice.** The list read on
  connect or on reopening a chat (`safety_block_pending`) never does, and
  leaving the chat drops it.
- **A judged refusal is one compact row, without a box or amber fill.** A small
  `--warn` icon/rule leads `Auto mode blocked · <reason>`, then the small
  "Use safer approach" answer, one chevron and a final Dismiss ×. Opened, the whole
  command (drawn through `cardFold.commandDrawn`), "Nothing ran…" and Details
  appear below. In a narrow container the answers may wrap, with 44px targets;
  no content widens the page. The pending key, badge tone, press guards and
  answer messages are unchanged.
- **Dismiss is the shared × everywhere** (`StatusDismiss`): its accessible name
  and tooltip keep the full action in words, but the button has no text label.
  It is 28px on desktop and 44px on a phone or coarse pointer; a pending answer
  disables and dims it. It is last in its row, after any chevron, and keeps the
  caller's press/key guards and send behaviour.
- **The warning keeps `--warn`; its leading answer uses `--decide`.** The
  primary button ("Keep it local", "Use safer approach") is a decision,
  like every card that asks: never the accent, which the composer rebinds to
  the model's colour and which came up gold under Claude
  (`lib/decideColour.test.ts`).

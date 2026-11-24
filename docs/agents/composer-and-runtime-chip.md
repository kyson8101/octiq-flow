# Composer runtime chip and composer fit

Moved verbatim from AGENTS.md on 2026-11-24.

### What a chat runs at is beside the agent's name

An agent's chat has no pickers in the row: the registration says what a chat
of the agent opens on, and the chat then keeps what it has (**A chat's level
is its own**, above). So the composer says what THIS chat runs at beside the
agent's name, as small quiet text, `opus · high · Auto` (`AgentIdentityChip`,
`lib/chatSettings`). The person changes provider, model and effort of an
existing chat from the sheet behind that text, and goes back after a
failover with one press (below); the registration is never touched.

- **It is a disclosure, and for a chat that can switch its sheet holds the
  pickers.** A press, a tap or Enter on it opens `RuntimeSheet`: the
  composer's own settings sheet shell (`.sheet.settings-sheet`, across the
  foot of a phone, a card at the foot of a wide window, so nothing of it is
  drawn past the composer's box in the three-column layout), with the same
  `ModelPicker` (grouped by provider; a limited provider's models stay
  pickable, the host decides) and the same `EffortList`. There is no access
  control: access stays with `request_access` and its card. The sheet says
  this changes this chat only, and that Settings, Agents sets what new chats
  open on. Escape or a press outside shuts it; targets are 44px on a phone
  or coarse pointer. A narrow composer cuts the text, so what it says is
  never behind a hover alone. The button's target is the whole chip (its
  `::before`, placed by the chip and so not cut with the text).
- **Where it is not offered the chip is read-only as it was**: a worker's
  chat (no composer), a front desk, a removed agent's chat and a
  conversation not sent yet (`runtimeSwitchable`). Its sheet then shows the
  three values whole (`Model`, `Effort`, `Access`) with the last turn's
  receipt and holds no control.
- **The host decides, and the page's settings move only on its word.**
  Both controls send `chat_switch_runtime { key, agent, model, effort }`
  (`lib/useRuntimeSwitch`, through `lib/inFlight` keyed by chat, so a drawn
  again control cannot send twice). Never `changeModel`: it ends the chat's
  process itself, which would stall a turn. `choice`, `effort` and `access`
  change only through `applyHostRuntime`, called by the `chat-provider-switch`
  event and by a `switched` answer the revision guard took (`takeAnswer`: an
  answer older than a host event is not applied), never by the press
  (`runtimeSwitch.wiring.test.ts` reads `App.tsx` for it). A `pending`
  answer, the `chat-runtime-pending` events and `chat_queue_state`'s
  `pendingRuntime` and `homeRuntime` (read on every connect and chat open, so
  a reload and a second tab draw the same; a read older than an event never
  puts the older answer back, `reduceRuntime`) only say what waits and where
  home is.
- **A switch during a turn is one quiet line**, `Switches to <model> after
  this turn`, in the group above the composer, in the sheet and in the
  chip's tooltip. No accent: the accent is a turn in flight. Picking the
  runtime already running takes it back.
- **The way back is a row** (`RuntimeRows`, the shared `.status-row`), shown
  while `homeRuntime` is present: `Running on Codex · Opus limit resets 3:40
  PM`, or `Running on Codex · Opus may be available again` once the reset
  has passed or the provider is not limited, and one icon + short word
  button, `Back to Opus`. The button is offered while the provider is
  limited too, because the person may know it is back; the host decides.
  One line cut inside the row; the button never gives way and is 44px on a
  phone or coarse pointer. One timer set for `resetsAt` (`msToReset`, in
  steps a timer can hold) redraws the words; nothing polls. `resetsAt` is
  the provider's real reset, never the host's 15-minute guess; with none the
  row says `limit reached`. The press is guarded like any answer with no
  question in front of it (`repeatsAnother`, `notePress`, `dropHeld`).
- **A refusal is the host's sentence, in words where the press was made**:
  on the row (never cut, the row grows upward) or in the sheet, with a
  Dismiss. The settings stay as they were.
- **Antigravity at guarded Auto or Manual** stays visible and off
  (`aria-disabled`) with the reason under the list (`antigravityHold`); the
  host refuses it too. Its effort is part of its model id, so no effort is
  offered or sent for it (`refOf`).
- **A switch the person made reads as theirs**: the transcript's
  `octiq_provider_switched` notice for a person's switch is titled `You
  switched to <runtime>` (`chatNotices.presentNotice`), not as an outage or
  a failover. `scripts/test-runtime-switch-ui.mjs` drives the real App
  against a stub socket at 1280 and 390 in `OCTIQ_THEME=light|dark`: the
  fallback with the limit and its reset, Back to Opus, the idle picker,
  pending, refusal, a reload with a fallback and with a pending switch, a
  worker chat and Antigravity held.
- **Only what the page knows of this chat** (`knownSettings`). The values
  are the page's own for the session (`choice`, `effort`, `access`). A
  conversation not saved yet runs at exactly those, which the page copied
  from the agent's registration as it opened it. A saved chat's model is
  known when its index entry names one or the agent reported one, and its
  effort and access when the entry has them; otherwise that part is left
  out. Never filled in from the roster: a chat can differ from its agent.
- **The access is the level the page holds for the chat**: the one it took
  from the chat's own entry as it opened it, saves with it and asks for at
  the next start. A chat the person put at Plan under an agent registered at
  Auto says Plan, and one a card raised says the raised level.
  `chatSettings.wiring.test.ts` reads `App.tsx` for that hand-off and fails
  when the text is given the registration's level, when a start asks for
  another, and when a level event or the read-only retry is put back.
- **The settings text gives way before the name, and its access last.** On
  a narrow composer, or in a wider font, it is cut short and then gone
  before the name loses a letter. It is drawn in two parts
  (`chatSettings.runsAtParts`): the model and the effort give way first,
  and the access, which says what the agent may do, is cut only once they
  are gone (`opus la… · Plan`, then `· Plan`; at 390px it read `opus · high
  · …`). `.composer-identity-name` stays the name alone: it is what a
  confirmed route's name lands on (`identityTravel.composerLanding`,
  `cutShort`).
- **The chip's tooltip names both, apart.** `Claude Opus latest · set in
  Settings, Agents` is the registration's; `This chat runs at opus latest ·
  high · Plan` is the session's. The session's values are never filled in
  from the registration's, in the text, the sheet or the tooltip.
- **The last turn's receipt is a tooltip, and two lines of the chip's
  sheet.** `Last turn · 178.1s` and `Cost · $9.526` (`receiptLines`) are in
  the chip's tooltip and its opened sheet (the runtime sheet shows them too),
  and in the model picker's
  tooltip in an ordinary chat. The eyebrow carries no receipt and no model
  name.

### No control of the composer is drawn outside it

The row under the text box folds its three pickers (model, access, effort)
behind one button when it cannot hold them side by side. That is decided by
the row's own width, measured (`lib/composerFit.rowFit`, a `ResizeObserver`
on the row and a look when what the row holds changes), and never by the
window's alone: with the run column and a side column open on a 1280px
window the chat is about 340px, the window still said "desktop", and the
row's overflow landed on Send, drawn past the composer's right edge.

- **Side by side while what the row holds is no wider than the row. Folded,
  it is tried side by side again when the row has grown past the width it
  last failed at, or when what it holds changed** (another model, another
  agent, its fonts arriving), and the next look folds it once more if it
  still does not fit. Both looks are made before a paint, so a try that
  fails is never seen, and at one width with the same contents the answer
  does not flip. What the pickers need is not remembered: a width taken
  once went stale with the font that loaded after it, and kept them folded
  in a row with room. Nothing is assumed from a font: a wider fallback font
  folds sooner.
- **The fold is the phone's** (`.composer-row.is-tight`, beside the 700px
  rule): the same button, opening the same sheet. On a wide window that
  sheet is a card at the foot of the window, not a band across it.
- **Send never gives way.** Everything else of a folded row can be cut: the
  settings button, then the agent's chip.
- `scripts/test-composer-fit.mjs` draws it in the real App and walks a
  desktop window down to 861px with both columns open (a 321px chat): no
  control of the composer reaches past its box.

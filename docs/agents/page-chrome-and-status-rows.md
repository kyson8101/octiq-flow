# Page chrome and the rows above the composer

Moved verbatim from AGENTS.md on 2026-11-24.

### The chrome above a page is three rows

The top bar names the page and nothing else. What can be done about the
page is a row of its own under it, and on a desktop plan usage is a third
(`App.tsx`, after `<header className="topbar">`). 860px decides phone
against desktop (`lib/media` `MOBILE`), never the operating system: a
narrow Windows window gets the phone's layout.

- **The top bar** (48px): the project, the title and the status. A run's
  title may wrap to two lines there. No action is in it. Two things are
  still at its end, both on a phone only: the way back from the chat list
  (`Return to chat`), and the usage number on a page that has no action bar.
- **The action bar** (`components/ActionBar`, 36px; 45px on a phone): every
  action for what is on screen, each an icon-only button from
  `components/ActionIcon`, with any count badge kept. The original action
  words stay in `aria-label`; no visible label is needed.
  An icon-only button keeps its detailed wording in `title`; `aria-description` never substitutes for `title`.
  Desktop targets are 28px; phone and coarse-pointer targets are 44px.
  Inline prose file actions are an exception: use 20px icon-only boxes, hide their `.action-label` only in touch mode, and keep hit areas within their own line box without covering neighbouring text, links or actions, including wrapped lines.
  `Tasks`, `Git`, `Focus`, `New task`, `Details`, `Agents`, `Pinned`,
  `Full width`, `Run`, `Reload`, `History`, `Back to thread`, `Copy ID`,
  `Complete`, `Delete` keep their order. Results change the icon, colour
  and accessible name, without adding words to the row. A page's own
  buttons (`WorkspaceHeader`'s `actions`) are drawn at its start on desktop.
  The same registry supplies icon + short word for decision answers, state
  changes and panel buttons: pass a 1–2 word `label` to `ActionIcon`, while
  keeping the full wording in `title` and `aria-label`. The width grows with
  the word; narrow cards wrap answers without widening the page. The action
  bar (including `WorkspaceHeader.actions` portaled into it), universal
  utilities (Copy, Dismiss ×, fullscreen, close and disclosure
  chevrons) and list-row edit/trash keep icon-only targets. A Close that
  changes saved state, such as closing a mission bridge, takes a label. Do not
  hide their SVGs or the shared `.action-label` with older component CSS.
  Decision glyphs differ by shape (Deny is a slashed circle; Dismiss is ×);
  the primary answer keeps `--decide` and quiet answers stay quiet. Preserve
  every press guard, pending key, disabled reason and submitted value.
  Arbitrary gate options, question choices, navigation/data rows and their
  disclosures retain their content: those words identify data.
  - **Adding a button is one line** in `App.tsx`'s `barActions`:
    `act(id, keep, node)`. `keep` is how long it stays as a desktop narrows.
  - **A desktop measures; a phone scrolls.** On a desktop what does not fit
    goes behind More, the lowest `keep` first (`lib/actionBar.overflowing`),
    and what waits on the person behind More is counted on More
    (`attention`, which is how a plan waiting in a put-away Tasks column is
    never hidden twice). A button behind More is mounted only while More is
    open, so a control that polls exists once; what it measured when it
    left decides whether it has room to come back. On a phone nothing is
    put away: the row scrolls sideways (`overscroll-behavior-x: contain`),
    every target is 44px, and the edge that is cut fades
    (`actionBar.cutEdges`). The fade is drawn over the row, never as a mask
    on it: a mask would also cut the panel a button opens.
  - **Its height never changes.** One line, `white-space: nowrap`, and no
    scrollbar that takes room (`scrollbar-width: none` and the WebKit rule:
    a Windows browser draws classic ones). Widths are measured, including badges, never assumed from the glyph.
    The bar reads layout when a size changes (`ResizeObserver`), never on
    every render.
  - **It is there before its buttons are.** On a chat's page the bar is
    drawn from the first paint (`reserved`), its buttons out of sight until
    the project list answers (the same gate the top bar's actions had), so
    a button or a count that arrives moves nothing under the bar. A page
    with no actions draws no bar (the sheet's `:has`).
  - **A page with no actions never has the row drawn and then taken away**
    (`lib/actionBar.holdsBar`, one policy). Before the project list answers
    the row is held only when something already says buttons are coming: a
    chat is open or the address names one, or this browser's last visit to
    a chat's page had buttons (`octiq.v2.actionBar`, written by the bar
    through `lib/remember` once the answer is known: `barSeen`). A first
    run in agents mode with no project has none of those: no row at the
    first paint and none after. It used to be held for the list and removed
    when the list answered empty, and the page jumped 36px. What is left: a
    browser that has never been here, on an install that has projects, gets
    its row with the project list, once; a browser whose last visit had
    buttons, on a page that has lost them all since, gives the row back
    once. What is left of a
    cold open's layout shift inside the bar is a button sliding along its
    row when Tasks or a count arrives beside it (0.006 of 0.013 at 1280,
    0.0015 at 390; `scripts/test-top-chrome.mjs` prints it).
  - **A panel a button opens is placed by the window, not by the row.** The
    row clips on a phone and More's list clips on a desktop, so `Details`
    opens a panel fixed to the window, under its button and inside the
    window's width (`ChatTaskBar.panelPlace`), placed at the press: placed
    after it is drawn, it is seen for a frame where it is not.
- **The usage row** (`UsageRow`, 26px, desktop only): every window the
  host's `usage_summary` reports, each a short label, a small bar and the
  percent (`lib/usageWindows.usageCells`: `Claude 5h`, `Claude week`, `Opus
  week`, `Codex week`, a Codex five-hour window when it is reported). Calm
  is grey, the warning colour from 60%, hot from 85%. An agent the host
  cannot read is its name, a dash and the host's note in the tooltip; a
  last good reading shown after a failed ask is faded and says `last
  known`. Antigravity has no limits and is nowhere on a desktop. The reset
  time is in each window's tooltip, and the whole row is one button that
  opens the full breakdown, so it is never behind a hover alone. Too narrow
  for its windows, the row scrolls sideways and fades its cut end; it never
  wraps. A phone keeps the one number (`Usage`), at the end of its action
  bar.
- **One reader of usage, whichever surface draws it** (`lib/usageFeed`):
  one timer and one clock for the rate limit, outside any component,
  because the Claude endpoint 429s per account. The first surface asks
  outright; one that takes another's place (the window crossed 860px) asks
  under the limit. A failed ask keeps the last good reading.

**A phone's chat list has its places menu at the top and nowhere else.**
The menu (New conversation … Settings) is the first thing in the list's
scroller: it leaves with the list and is reached again by scrolling to the
top, or by the keyboard, whose focus scrolls it into view the native way.
It used to come back over the rows on every upward scroll
(`lib/mobileMenuScroll`, removed). On a desktop the menu stays put above
the list and only the list scrolls, as before.

**A chat ticked done while Active lists it is pushed out by a robot**
(`lib/donePush`, `components/DonePushRobot`, `DonePush.css`). Done is recorded
exactly as before (`doneAt`); this only decides when the row stops being held
in the Active list. `chatFilterList` keeps the open chat and the hand-ticked
rows listed, which is why a done chat never left. Three seconds after a chat
that this page saw NOT done is seen done, its row slides out to the right
with a small robot (about 1100 ms, transform only), then collapses (200 ms);
after that `withoutPushed` drops it from `keep`/`keepMarked`, so the row
leaves while the open chat stays open (still in the Done view). Cancelled by a
new message, an untick, pinning or leaving the Active view; one timer per row,
cleared on unmount. A chat already done at load, or new in the list, is never
animated, and neither is one first seen while the list was unanswered. The
robot uses the ink tokens, never the accent, takes no pointer events, and
reduced motion gets a 160 ms fade and the same collapse with no robot.
Keyboard focus on the row moves to the next row (else the previous, else the
view menu) just before it goes. `scripts/test-done-push.mjs` drives the real
App at 1280 and 390 and can screenshot the push part-way (`SHOTS`, `THEMES`).

### The rows above the composer are one group

Four things report above the composer and ask nothing: the chat's folder is
gone (`RemovedFolderBanner`), the chat is completing (`ChatCompletionLine`),
background notices (`ChatNotices`), the run's progress (`RunProgressStrip`).
They are one group (`components/ChatStatus`), mounted in that order directly
on the composer, under the cards that ask. A fifth row is first in the group
and is there only while it has something to point at: `1 question waiting`
(`QuestionWaitingRow`), for a question in the transcript that is out of
view.

A sixth kind is the chat's runtime (`RuntimeRows`, `lib/runtimeSwitch`), for
a registered agent's chat only, after the completion line and before the
notices: the way back after an automatic failover, and a switch waiting for
the turn to end (see **What a chat runs at**). Both are neutral rows of the
same frame: no accent, no warning.

- **A row is one line, with no box and no fill of its own.** The same
  height (28px; a row with Dismiss grows to 44px on a phone or coarse pointer),
  the same left edge and the same icon column, which is the
  eyebrow's own, so the face under the rows stands in line with them. A
  hairline between two rows is all that separates them. A row's state is
  the colour of its icon or dot and nothing else. The shared frame is
  `ChatStatus.css` (`.status-row`, `-main`, `-icon`, `-label`, `-text`,
  `-chevron`, `-dismiss`, `-panel`); a new row uses it and adds no border,
  background or tint.
- **Nothing is drawn outside a row.** The group is `flex: 0 0 auto`: a row
  with a `min-height` was squeezed to it by the column, and its wrapped
  words were drawn over the borders (the person's screenshot). A row's
  words are one line, cut with an ellipsis inside it at any width and in
  any font. Only two things take a second line: what a row opens, and why a
  completion did not happen (the host's sentence, never cut).
- **Folded, a row is a short label.** A notice is its short title, or `3
  notices` (`chatNotices.noticesHeadline`); the host's sentence for
  interrupted background tasks is `1 background task interrupted`, with the
  sentence and the task ids inside the opened panel. A long notice is
  titled by what it leads with (`Could not switch models`) or `Notice`,
  never by its first sixty characters.
- **A row that opens is a button**, so a pointer, a finger and the keyboard
  open it; nothing is a tooltip alone. Its chevron follows its words, and
  the far end of the row is the dismiss's.
- **A dismiss shows under the pointer and the focus, and always where a
  finger can be** (`(hover: none), (any-pointer: coarse)`, which a touch
  laptop matches). Nothing is reachable by hover alone.
- **The group grows upward**, so a row arriving, or one opening, never
  moves the composer. Only the notices' panel can scroll, and only down.
- **A card that asks is not a row of this group** (permission, access,
  safety) and keeps its look. A question is neither: it is drawn in the
  transcript, and the row that points at it asks nothing itself. That row is
  the one whose words, not only its dot, are a state's colour (`--decide`),
  as the composer's waiting words are.

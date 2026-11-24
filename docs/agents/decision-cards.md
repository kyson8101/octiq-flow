# Decision cards that wait on the person

Moved verbatim from AGENTS.md on 2026-11-24.

### A card that waits on the person arrives folded

Folded, a decision card is the ask, its short facts and the buttons. What is
short is `web/src/lib/cardFold.ts`'s to say (one line of about 60 characters,
or a move whose two sides both are); everything longer is behind the card's
ONE disclosure (`components/CardFold`). It applies to the permission card
(tool calls and roster or policy changes), the access request, the handover
and route cards, and the plan card in the lead's chat (`PlanReview` with
`folds`; the run panel draws the plan out). The safety cards have their own
folded line and are not part of this.

- **Folding is never hiding.** A folded part keeps its label on the card with
  its size and, for a change, the fact that it changes and the size of both
  sides: `Role · changed · 2 lines → 4 lines`, `Persistent prompt · cleared ·
  was 8,000 characters`, `6 more lines`, `+7 −2 in chat.ts`, `Brief · 8
  lines`, `3 tasks in 2 stages`. The tool, the path, a warning, the countdown
  and the buttons are never folded. Sizes are Unicode characters
  (`cardFold.chars`), never UTF-16 units.
- **What stays of a folded part is never a piece of it.** Not its first line,
  not its last sixty characters: a slice reads as the fact and is only where
  the text happened to start or end. A long row shows its label, whether it
  changes and its size, or the host's own `summary` for it (optional, on a
  stated value only, one line, at most 160 characters, validated in
  `askDetail.rowSummary`; an invalid one is dropped and the rows are kept; on
  a move it is an unknown key like any other). The rows `Head` and `Front
  desk` (`team_tools::delete_facts`) are sentences drawn whole up to 160
  characters, and so are a team card's `Membership` (the one fixed sentence
  of what teammates may do with each other, which is what is approved) and
  `Other teams` (who leaves which team by joining this one;
  `team_tools::team_rows`); `cardFold.STRUCTURAL` holds those labels and
  `cardFold.test.ts` reads `team_tools.rs` to check them. A change of more
  than 50 rows
  (`askDetail.MAX_ROWS`; the host sends about a dozen) is shown as the host's
  text instead, folded like an older host's.
- **A command is what is being approved, not detail.** `command`, `script`
  and `code` (`askDetail.isCommand`) are on the folded card whole, up to
  twelve lines and 1,200 characters, no line cut and no scroll of their own.
  Over several lines the title is the tool and `N-line script`, and on one
  line the folded card cannot draw, the tool and `N-character command`
  (`cardFold.commandTitle`): never the first command, for an MCP tool too.
  Past that the card shows the leading whole lines, says `N more lines not
  shown` at full strength as the last thing above the buttons, and holds
  Allow once and Always (`aria-disabled`, pointing at the visible sentence
  `Open the full command to allow it`). Deny always answers. A diff keeps
  its `+a −b` line, and prose (a plan, an older host's change) its first line
  and size.
- **Allow is asked of what is drawn, never of what was pressed.** The card
  draws the two texts `cardFold.commandShown` returns and nothing else of a
  command; `cardFold.notShown` compares them with the command, and
  `allowHeld` lets go only when nothing is unshown now, or when this exact
  command was drawn whole on this card before. An opening that drew less
  than all of it (a cap, a bug) leaves Allow held. The control says `Open
  the full command` only where opening is the whole command
  (`commandOpens`).
- **"Shown whole" is said of a text, not of an ask.** What the card keeps
  after drawing every character of a command is that command
  (`cardFold.CommandAsked`: the ask id, the tool, the argument's name and the
  exact string the host sent), set by `drawnWhole` after the draw and
  compared with the one on the card at every draw (`sameCommand`). So the
  same command opened and folded again keeps its Allow, and an ask whose
  command changed under the same id, by one character, is unread and held:
  `PendingRequests.add` replaces an item under its id, and the page does not
  lean on the host never doing so. The fold itself is still the id's: a card
  left open draws a replaced command whole, and Allow is then asked of that
  drawing. No other card's approval waits on something having been opened.
- **A command is never missing a character, and one that cannot be seen is
  drawn as its code.** Its lines are `cardFold.commandLines`: only a line
  with nothing on it, or spaces and tabs, is left out before the first line
  and after the last. A line holding a no-break space or a carriage return
  is a word to a shell and is drawn and counted (JavaScript's `trim` calls
  it blank). In a command, script or code block the characters that draw
  nothing or turn the reading order round are drawn where they stand as
  `\u{202E}`, set apart as a mark (`cardFold.commandDrawn`): the control
  characters U+0000 to U+001F and U+007F, but for the tab, the line feed and
  a carriage return that a line feed follows; then U+00A0, U+00AD, U+061C,
  U+115F, U+1160, U+180E, U+200B to U+200F, U+2028 to U+202E, U+2060 to
  U+2064, U+2066 to U+206F, U+3164, U+FEFF, U+FFA0 and the tag characters
  U+E0001 to U+E007F. One full-strength line under the block says how many
  the whole command holds. Only the drawing changes: `notShown` and what
  Allow sends are the text itself.
  - **A wider space is marked too, outside CJK text.** U+2000 to U+200A,
    U+202F, U+205F and U+3000 draw as a gap and are not a space to a shell
    (`rm -rf a<U+3000>b` is one path). Each is drawn as its code unless the
    run it is in has a CJK character on BOTH sides (Han, kana, Hangul, CJK
    and full-width punctuation), where it is how the text is written. One
    side is not enough: beside a Latin word, a quote, or the start or end of
    a line it is marked. This is the whole rule; it applies only in a
    command, script or code block, like every mark.
  - **Past `MARKS_MAX` (5,000) a code is still never text that was typed.**
    Up to that many, each code is an element of its own and is told from the
    same characters typed into the command by how it is drawn. Past it the
    codes are written into the text with no element each, so a backslash
    typed before `u{` is written as `\u{005C}`: what is drawn then has one
    reading back to the command, and the line under the block says so. The
    card decides which way for the whole command (`marksInText`) and draws
    both of its texts that way.
  - **The scan is a table, not a pattern** (`cardFold.eachMarked`). A
    pattern matched 5,000,000 times took 2.4 s to count and 12 s to size
    when the card arrived; the table takes 0.1 s.
- **The lines a command card states are the rows it draws**, for any mix of
  `\n`, `\r\n` and a return alone. A Windows line end is drawn as the pair
  it is, with no mark at the end of every line; a return anywhere else is
  marked `\u{000D}`. The two texts a card draws stop before the line feed
  that follows them, so `cardFold.lineFeedAfter` says whether one does, and
  a return at the end of such a text is drawn with it. That is not
  cosmetic: Chromium gives a return alone on the last line of a block no row
  at all (WebKit gives it one), and the card would state a line it does not
  draw.
- **A plan's stage line names every place and agent it can.** Destinations
  are told apart by project and whole path (`planReview.planPlaceNames`): a
  shared folder name gets its project, then its parent folder, then the path.
  Up to four destinations and six agents are named; the rest are counted in
  words (`+2 more agents`). The chat's card opens to every task whole (path,
  criteria, command approval, the full brief) in one scroll; only the run
  panel keeps a disclosure per task. The fold belongs to one revision
  (`cardFold.planFoldId`), so a changed plan arrives folded.
- **Opened is whole, and what cannot be shown whole cannot be allowed.**
  `askDetail` carries no limit and nothing cuts a body where it is drawn: no
  cap, no "first N characters". A long detail scrolls inside the card. A cap
  with a note under it was tried (200,000 characters) and was the hole: the
  card drew that much of a 330,000-character command, said the rest was not
  shown, and let Allow go. The one limit is `cardFold.WHOLE_MAX` (5,000,000
  characters, where opening stops the page for about a second; every size
  measured up to 50,000,000 was still drawn whole). A text past it is never
  opened in part, and its card cannot approve it: the card says `This command
  is too long to show in full (N characters), so it cannot be allowed here.
  Deny it and ask for it in smaller steps.` and its approving buttons stay
  off for good (`tooLong`, `tooLongNote`). **For a command the limit is on
  what is drawn** (`cardFold.drawnChars`, `CommandFold.drawn`), not on what
  is sent: a character drawn as its code is eight characters for one, so
  5,000,000 zero-width characters were within the limit and drew 40,000,000,
  8.6 s to open. Past `WHOLE_MAX` as drawn the command is not opened either,
  and the card gives both sizes (`N characters, M as drawn`). Nothing is cut
  to keep to the bound. What is still on the card differs
  by kind. A command keeps what any folded command has, its leading whole
  lines with `N more lines not shown` under them, and has no control to open
  it. A plan, an older host's change text or a route's first message or brief
  has none of that text drawn: the sentence stands where it would open. A
  row of a change keeps its label and size, and is not opened. Deny and
  Cancel always answer. A diff draws its
  first 600 rows on opening (`DiffView.FIRST_OPENED`) and keeps its own `Show
  N more lines` past that: 5,000 rows at once stop the page for about 0.4 s,
  and drawing them a stretch a frame was slower still. Those rows are a press
  away, not cut, so they hold nothing back.
- **The control is above what it opens, which is above the buttons.** However
  the card is anchored (on the composer and growing up, or in the transcript
  and growing down), the pointer that opened it is never left over that
  card's own answer.
- **A repeated press is dropped** (`cardFold.strayPress`, kept by
  `lib/pressGuard`'s document listener). Shutting the lower of two stacked
  cards brings the upper one down, and its Allow can arrive under a pointer
  that has not moved. A press within 700 ms and 8 px of the one on a
  disclosure (`pressGuard.notePress`), landing on anything but that
  disclosure, does nothing; a pointer that moved, or a press made later, goes
  through. The run panel's disclosures are remembered by the same guard (see
  **An action that stops or starts work is never fired by the key or press
  that brought it on screen**).
- **The question surface folds nothing.** It is no card any more (see **The
  agent's questions are drawn where they were asked**), and the rule is the
  same: its options and what each means are the decision, and it has
  controls on every side of where a disclosure could go, so opening or
  shutting one would slide a control under the pointer. Only `Other…` grows,
  under itself.
- **New cards arrive folded; reading choices survive a chat switch.** In a
  chat's transcript, request stack and embedded run panel,
  `lib/chatReadingState` keeps only presentation choices under stable
  message/tool/ask identities (plan folds
  include their revision). Its page-memory LRU holds at most 8 chats,
  including the visible panes; each chat has at most 2048 scalar choices and
  a conservative 256 KiB budget. Older choices/chats are evicted at those
  bounds. Transcript-window eviction, record reset and chat deletion release
  the matching reading state. Reload drops this presentation cache; existing
  `chatPlace` anchor persistence is separate. There is no new setting,
  localStorage payload or offscreen DOM. Outside these providers, state
  remains the component's.
- **A restored open fold is no proof that a command was drawn.** A command
  card keeps both Allows held until this mount's `drawnWhole` records the
  exact `CommandAsked` string; `sameCommand` checks id, tool, argument and
  text. Replacing a command under the same id while away starts with no
  such proof. Only the open choice is cached: never `CommandAsked`, consent,
  pending/sending state, or action freshness. The document's `strayPress`
  listener and a new confirmation's `lastPointerPress` guard stay active
  across restores.

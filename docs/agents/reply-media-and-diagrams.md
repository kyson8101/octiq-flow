# Reply media, card diagrams and now-playing

Moved verbatim from AGENTS.md on 2026-11-24.

### A finished turn's work folds into one line

Folding never changes grouping or attachment (both are decided on the original
sequence before filtering formed rows), and tests cover a pure protocol-fence
final beside a retained card.

### A reply can hold media beside its explanation

A fenced code block whose info string is `octiq-media` draws ONE local
image, video or audio file beside text (`lib/mediaBlock`,
`components/MediaBesideText`). Its body is JSON,
`{"path":"/abs/file.png","title":"...","text":"...","caption":"..."}`:
`path` is an absolute local path, `text` is required, title and caption
optional. Limits: title 80 characters, text 1,200, caption 120. The file
extension determines its kind; an optional `kind` must match. Arrays,
duplicate keys, extra fields, unknown kinds and over-limit values stay
ordinary code. Nothing is repaired, truncated or set as HTML.

- **Only a closed, parsed and validated block is drawn.** While streaming,
  one quiet line sits over unseen layout holding the words written so far;
  no file is fetched there, and closing the fence keeps the reserved height.
  Check the space it takes in the transcript and where content below lands, not just its own height.
- **The block width decides the layout**, with a container query: media left
  and text right at 480px, media above text below that, including beside a
  run panel and a side column. A video is wider: up to half the block (480px
  at most) at 16:9, and the whole row (640px at most) under 720px; a sound's
  player always takes the whole row. Each media box reserves its size before load
  and on failure (`Could not be shown`). Files load only near the scroller;
  pictures open the shared viewer, native players use metadata preload and
  `nowPlaying`. The card uses neutral border/background tokens, no shadow.
- **Questions with exactly one media item use the same layout.** Two or
  more keep the strip (the host still allows four); option images, answer
  guards and the answered line's folded view keep their existing behaviour.
- **Agents get one identical ASCII paragraph** (`MEDIA_PROMPT` in Rust,
  `MEDIA_INSTRUCTIONS` in the MCP server), wherever the diagram paragraph
  goes. Rust, MCP and web tests keep it in sync, under the MCP 4,096 limit.
  Use it only to show a file next to what it means, never by default, and
  at most a few per reply.

### A reply can hold a card diagram

A fenced code block whose info string is `octiq-diagram` is drawn as a
diagram of framed cards (`lib/cardDiagram`, `components/CardDiagram`). Its
body is JSON, `{ "rows": [ [ { "title", "note"?, "icon"?, "plain"? } ] ] }`:
rows run top to bottom with an arrow between them, the nodes of a row sit
side by side at equal widths and stack under about 480px of the diagram's
own width (a container query, so a transcript beside a run panel stacks
too), and `plain` draws a node without a frame. Limits: 8 rows, 4 nodes a
row, title 60 characters, note 120. Icons are a fixed set of 24 names
(`DIAGRAM_ICONS`); an unknown name draws none.

- **Only a block that is closed, parses and validates is drawn**
  (`diagramBlock`, `parseDiagram`). Anything else is the ordinary code
  block: not JSON, a wrong type, over a limit, a block the reply ended
  without closing. Nothing is repaired and nothing is cut to fit. A block
  longer than any diagram can be is refused before it is parsed.
- **Strings are text.** The validator hands back strings and the renderer
  draws them as text; nothing of a diagram is ever set as HTML.
- **While it is being written it is one quiet line**, over the rows written
  so far drawn unseen (`partialRows`, `DiagramPending`), so the block is
  already as tall as the diagram will be and nothing below moves when its
  fence closes. Counted by the node, because the last row closes in the
  same few characters as the fence.
- **It has no colour of its own**: the border token on the card background,
  no shadow, nothing behind the words. It is a list to a screen reader,
  labelled with its titles in order.
- **Agents are told in one paragraph, and never on a command line**
  (`DIAGRAM_PROMPT` in `agent_provider.rs`, word for word
  `DIAGRAM_INSTRUCTIONS` in `scripts/mcp/octiq-ask.cjs`; a test on each
  side and `cardDiagram.test.ts` hold the three together). Claude reads it
  from the MCP server's instructions, over stdio, where it is the FIRST
  thing: Claude Code keeps only the first 4,096 characters of a server's
  instructions (seen in a live chat on 2026-10-13, cut mid-word there), and
  those were already 4,946 long. The whole text is held under that mark
  now (`scripts/mcp/instructions.test.cjs`). Codex's app-server reads it
  in its developer instructions (a message on stdin), Antigravity in the
  plugin's rules file. `codex exec` takes its instructions as an argument
  and Pi reads them from its system prompt file (see **Pi is a full harness**). A front desk is not told.

### A playing video or recording follows the person to another chat

A reply's player (`ProsePlayer`, `ReviewVideo`) does not own its `<video>`
or `<audio>`. `lib/nowPlaying` makes it and puts it into the reply's slot
(`components/MediaSlot`), so it can move: into the one floating host
(`components/NowPlaying`, mounted once in `App`) when its chat leaves the
screen, and back into the reply when the chat returns. A move is one
`appendChild` in one task, which the browser does not pause for, so nothing
is re-fetched or re-buffered and a picture-in-picture window survives it.

- **What "on screen" means is `App`'s**: `nowPlaying.show` is told the open
  chat while `chatShown`, and the task chat beside it while `besideShown`,
  in a layout effect, so the switch and the hand-off are one commit. Only a
  PLAYING element leaves (or one already in picture-in-picture); a paused
  one stays in its reply. A player outside a chat (the file dock) never
  leaves.
- **At most one element is detached.** Starting any other player, or another
  one leaving, stops it and lets its file go. Close does the same, and the
  reply starts again from nothing.
- **A video asks for the browser's picture-in-picture as it leaves**, while
  the press that changed chats still counts as the person's; refused or not
  offered, it is the mini-player (top right, under the bars; 44px targets;
  no accent). Audio is the mini-player only. The browser's window closed
  (the video paused) parks the element out of sight for its chat; "back to
  tab" (still playing) opens its chat.
- **The position is never lost.** A reply that comes back is drawn at once,
  near the screen or not (`useHeldMedia`, latched like `useNear`), and takes
  the same element. Opening a chat draws its rows twice, in either order, so
  an element whose slot unmounts is kept for that commit and a new slot for
  the same file takes it back (`orphans`, `settle` on unmount).
- `scripts/test-media-pip.mjs` drives the real App in Chrome (native
  picture-in-picture is granted headless) and in Playwright's WebKit (it is
  refused there, so the mini-player carries every scene).
- **A video in a chat reply opens larger in a pop-up when it starts playing
  and the window has room** (`lib/videoPop.popSize`, `ReviewVideo`,
  `MediaPop.css`).
  - It pops on each paused to play change, when the window is wider than 860px
    and the picture would be at least 1.3 times as wide as the inline one
    (at most 1600px wide, with 96px and 128px of margin). The aspect comes from
    the video itself, 16:9 until it is known.
  - The pop-up is a native modal `<dialog>`, so Escape, the Close button and a
    press on the backdrop close it. The SAME `<video>` is moved in with one
    `appendChild` and moved back the same way, so it never pauses or reloads.
  - Closing does not pause: the video goes on playing inline and stays there
    until the next press of play. A placeholder of the inline size marks its
    place while it is popped, so nothing under it moves.
  - A phone-sized window (860px or less) never pops. The file dock (no chat)
    never pops. When the store moves the element away (another chat), the
    pop-up is only forgotten and the store moves the element itself.
  - `scripts/test-media-pip.mjs` closes the pop-up with Escape where a scene is
    about the inline player, and `popScene` covers the pop-up at 1280 and 390
    (`OCTIQ_MEDIA_POP_ONLY=1` runs it alone).

# Task-oriented chat workspace

The sidebar is one global task list rather than a tree of project folders. Each
chat row shows its title, latest agent response, and project name. Selecting a
chat switches the single workspace; browser Back and Forward return to
previously visited chats. Switching chats preserves drafts and leaves
server-owned agents running.

`Start new chat` opens an unbound task. A leading project mention such as
`@octiq-flow` selects the workspace explicitly and is removed from the text sent
to the agent. Without a mention, OctiqFlow looks for one unambiguous project
name or folder clue in the task. Ambiguous or unrelated work goes to the
persisted `General` workspace, whose default path is the person's home folder.
Starting a task creates a new durable chat instead of clearing the previous
chat, so completed work remains available for reference.

The list always auto-sorts within its pinned and unpinned sections. A user send
moves the task immediately; a completed agent turn updates it once more.
Streaming response deltas never reorder the list under the pointer.

Agents can retrieve that history through OctiqFlow's read-only MCP flow.
`search_conversations` searches the current project by default and returns a
small ranked list of references; `read_conversation` then opens only the chats
needed for the current task. Cross-project search must be requested explicitly,
and historical transcript content is always treated as quoted data rather than
instructions. Search uses a persistent inverted index. It tokenizes each
conversation once, then refreshes only transcripts whose size or modification
time changed; normal queries intersect token postings instead of scanning every
JSONL file.

Project links (`#/p/<project>/c/<chat-id>`) and direct chat links (`#/c/<chat-id>`)
remain supported. Retired `#/split?...` bookmarks open their focused chat in the
single workspace, falling back to an available target if necessary. Old saved
split layouts and widths are ignored.

## A task chat beside its main chat

Clicking a task in the run panel opens its chat full-width, as it always has.
**Open beside main** (the split icon on a task row, or beside *Back to main
chat* in a full-width task chat's run line) opens exactly two panes instead:
the main chat on the left, the task chat on the right. The layout never
switches to this on its own, however wide the window gets.

- **Main** is the coordinator the ledger names for that task's run
  (`lib/chatBeside`), never the configured head or whichever chat was open.
- Only two panes. Opening another task beside the same main replaces the
  right pane. A plain click on a task row still opens it full-width.
- The chat on screen stays the main chat: its composer, requests, side panels
  and sends are unchanged. The task pane is read-only, like a task chat
  opened on its own, and has no composer; worker approval cards stay in the
  main pane. Nothing here creates a chat or a run.
- A task chat says it is read-only with a small **Read-only** badge by its
  title, in the pane header and in a full-width task chat's run line. It no
  longer has a notice block with an Open main chat button under the
  transcript.
- The task pane's header offers **Expand to full chat** (leaves the split)
  and **Close split** (keeps the main chat). A full-width task chat offers
  Open beside main to go back.
- The split needs two 360px panes in the chat area as measured, after the
  sidebar, the run column and any side panel. Without that room, a bar says
  so and switches between Main and Task, one at a time. The choice is kept,
  so the split comes back when there is room. A pane that is not showing is
  not marked read.
- The choice is written into the address as `#/p/<project>/c/<main>/beside/<task>`
  and remembered locally, so a reload or a copied link restores both panes.
- Drafts belong to the chat (`lib/drafts`), and the store is App's, so the
  main chat's half-typed message survives a trip to a full-width task chat.

`node scripts/test-task-beside.mjs` drives the real App with a mocked socket.
It covers two live streams, replace, expand, close, a plain row click, send
routing, resize fallback, reload and 390px. It needs no dev server.

## Browser regression check

Run a Vite dev server, then `node scripts/test-chat-layout.mjs`.
`PLAYWRIGHT_MODULE` can point to an isolated Playwright installation;
`OCTIQ_TEST_URL` overrides the default `http://127.0.0.1:5273/`.
All auth and WebSocket RPCs are mocked: no real agents or projects are modified.
The check covers single-workspace rendering, draft preservation, Back/Forward,
legacy bookmarks, reload, missing chats, mobile actions, and send/stop routing.
Screenshots go to a unique temporary directory printed by the script.

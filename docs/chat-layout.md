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

## Browser regression check

Run a Vite dev server, then `node scripts/test-chat-layout.mjs`.
`PLAYWRIGHT_MODULE` can point to an isolated Playwright installation;
`OCTIQ_TEST_URL` overrides the default `http://127.0.0.1:5273/`.
All auth and WebSocket RPCs are mocked: no real agents or projects are modified.
The check covers single-workspace rendering, draft preservation, Back/Forward,
legacy bookmarks, reload, missing chats, mobile actions, and send/stop routing.
Screenshots go to a unique temporary directory printed by the script.

# Conversation reader MCP

OctiqFlow's bundled `octiq` MCP exposes `read_conversation`. Copy a chat ID from
the top-bar action menu and pass it to the tool; it returns the conversation's
metadata plus a bounded, readable page of the transcript:

```text
read_conversation({
  "id": "c9c2ffa8-ea18-4073-ac86-eb0d700b18cc"
})
```

A full browser URL remains supported as `url` for links shared from older
clients. Pass either `id` or `url`, not both.

Claude and Codex chats launched by OctiqFlow receive the MCP automatically. MCP
configuration is fixed when an agent process starts, so a chat process that was
already running before this tool was installed must be restarted once.

Starting a new chat with `continue <conversation-url>` is a reserved hand-off
shape. OctiqFlow routes Codex to `read_conversation` before it can mistake the
URL for a browser task, and gives Claude the same mandatory rule in its system
prompt. The user-visible transcript keeps the original short message.

## Paging

The first call returns the latest 40 conversational entries in chronological
order. Its header names the cursor for the preceding page:

```text
Earlier context: call read_conversation again with before: 235
```

Pass that number back with the same ID (or URL):

```text
read_conversation({ "id": "...", "before": 235 })
```

`limit` accepts 1–100 entries. `maxChars` accepts 4,000–100,000 characters and
defaults to 60,000. If a page is too large, the oldest entries in that page are
dropped first and their entry number becomes the next `before` cursor.

Ordinary reads include user and assistant prose, room speaker names, Codex
agent messages, and compaction boundaries. Stream deltas, token counters, hook
chatter, and other lifecycle records are removed. A skill invocation is reduced
to its skill name and arguments instead of returning the whole `SKILL.md`.

Set `includeToolActivity: true` only when commands and tool results are needed.
This changes the entry numbering, so keep that setting the same while following
a cursor chain.

## Boundary

- The tool reads only the active local OctiqFlow profile.
- It validates that the supplied ID exists in the chat index and belongs to a
  stored project. For URLs it also validates that the project slug agrees.
- Conversation ids become one validated filename segment; traversal characters
  are rejected, and transcript symlinks are not followed.
- There is deliberately no conversation list or search tool. The ID or URL
  supplied by the person is the capability.
- Transcript text is not redacted. It may include secrets or private context,
  so the MCP instructs agents to use the tool only when the person supplied the
  ID/URL or explicitly asked them to consult that conversation. Returned
  messages are labelled as historical data, not instructions for the reading
  agent.

## Standalone use

The bundled server is a dependency-free Node stdio MCP at
`scripts/mcp/octiq-ask.cjs`. Outside an OctiqFlow-launched chat it offers
`read_conversation` and [`create_artifact`](artifacts.md); chat-bound tools such
as `ask_user`, [`preview_image` and `preview_html`](image-preview.md) remain hidden.

Codex can register it with:

```bash
codex mcp add octiq -- node /absolute/path/to/scripts/mcp/octiq-ask.cjs
```

If `OCTIQ_ROOT` is not provided, the reader follows
`~/.octiqflow/config.json` to the active profile.

## Check

```bash
node scripts/mcp/octiq-ask.test.cjs
```

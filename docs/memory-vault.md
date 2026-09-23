# Shared Memory Vault

OctiqFlow owns the Markdown file operations and exposes them through its existing
`octiq` MCP server. No Obsidian process, plugin, external MCP server, npm vault
package, embedding provider, or copy of the vault is required.

## Connect

In **Settings → Memory Vault**, choose an existing folder on the machine running
OctiqFlow. Obsidian vaults work as ordinary Markdown folders. Connecting starts
with read access; enable **Allow agents to update notes** for writes. Disconnecting
does not remove any notes. These settings are shared by Claude and Codex in the
current OctiqFlow profile and are checked on every tool call.

The agent receives a small discovery instruction, not the contents of the vault.
It calls `vault_info`, reads the vault's `AGENTS.md` when working there, and uses
scoped searches and bounded reads. Private preference paths (`preferences/` and
`preferences.md`), hidden files, and symbolic/hard-linked notes are excluded.
This integration does not automatically read or inject private preferences.

## Native tools

| Tool | Operation |
| --- | --- |
| `vault_info` | Discover the configured folder, access and entry points. |
| `vault_list` | Browse Markdown notes and folders with pagination. |
| `vault_search` | Search note paths and contents, including Markdown frontmatter and tags; return snippets and line numbers. |
| `vault_read` | Read a line range, heading outline and current revision. |
| `vault_write` | Create, append to or replace a note. |
| `vault_patch` | Replace one exact, unambiguous text match. |
| `vault_move` | Move or rename without overwriting a destination. |
| `vault_archive` | Move a note to recoverable `.octiq-vault-trash/` storage. |
| `vault_receipt` | Inspect this chat's saved or outstanding write receipt. |

Paths are relative to the configured vault. Notes must be UTF-8 Markdown, at most
1 MiB. Reads return up to 400 lines and listings/searches up to 100 results per
page. Search scans at most 20,000 entries and 32 MiB of note text; `truncated` and
`skipped` explicitly report incomplete coverage. Narrow the folder for large
vaults. External edits are read from disk on the next request; there is no stale
search index to refresh.

## Verified writes

For an existing note, supply the `expectedRevision` returned by `vault_read` and
a unique `requestId`. Revision conflicts require a fresh read. Reusing the same
request ID with exactly the same operation returns its receipt without repeating
an append. Reusing it with different arguments fails. The host derives chat
identity from the MCP transport and validates it against the active chat index.
Agents cannot change the configured root or enable write access through vault
tools.

The host serialises its writes, records a pending receipt before changing a file,
then reads back the expected content before recording `saved`. A crash between
the file change and receipt completion can be reconciled on retry. Ambiguous
outcomes remain `needs_review`; they are not automatically replayed. A saved
receipt attests to that operation at that revision, not to the note staying
unchanged forever. Other editors do not participate in the host lock.

Moving does not rewrite wiki-links in other notes. Repair relevant references as
part of the requested reorganisation. Archiving never permanently deletes; the
receipt names the archived location, from which the person can restore the note.
The tools do not implement Obsidian plugin APIs, attachment management, semantic
search, or an automatic task-completion summariser.

## Storage and orchestration

Profile-local `memory-vault.json` holds the folder and write setting.
`memory-vault-receipts/` holds durable receipts, including the acting chat,
original path, operation, revisions and timestamp. Markdown remains the source of
truth for knowledge. Live orchestration state remains in OctiqFlow's orchestration
store; a vault note cannot complete a worker attempt.

An existing external Obsidian MCP configuration is not removed automatically.
After deploying the new backend and client, connect the vault, start a chat and
check `vault_info`/`vault_read`; the separate MCP can then be disabled if no other
application needs it. This change does not alter existing startup hooks.

## Validation

Run `cargo test --manifest-path src-tauri/Cargo.toml`, `pnpm --dir web test`, and
`node --test scripts/mcp/vault.test.cjs`. The browser check
`scripts/test-memory-vault.mjs` runs against Vite with mocked RPCs and never reads
or modifies a real vault. Set `OCTIQ_TEST_URL` for its Vite URL and
`PLAYWRIGHT_MODULE` if Playwright is installed outside the project.

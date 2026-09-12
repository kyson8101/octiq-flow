# HTML artifacts

`create_artifact` is part of the bundled `octiq` MCP for Claude and Codex. It
creates an offline, standalone HTML file for reading, reviewing individual
items, leaving comments, and copying all feedback back to the agent as JSON.
It also works outside an OctiqFlow chat and without a running backend.

```json
{
  "artifactId": "settings-review",
  "revision": 1,
  "title": "Settings review",
  "description": "Review these proposed defaults.",
  "mode": "review",
  "items": [
    {
      "id": "notifications",
      "title": "Notification default",
      "body": "Enable notifications after the person opts in.",
      "options": [
        { "id": "accept", "label": "Accept" },
        { "id": "modify", "label": "Request changes" }
      ]
    }
  ]
}
```

The result includes `filePath`. Link that absolute path in the reply so the
person can open it; [`preview_html`](image-preview.md) can also publish it to
the chat Preview panel (`path: filePath`), with a clickable Open HTML card.
`pin_file` remains available for the pinned file list. OctiqFlow's
existing HTML file opener shows it in a native browser tab. No new endpoint or
automatic feedback submission is involved.

## Content and feedback

- `mode: "read"` gives every item a comment field, without decision buttons.
- `mode: "review"` uses per-item options. Omitted options default to Accept /
  Request changes / Defer; `options: []` means comments only.
- `language: "en"` (default) or `"zh-CN"` controls built-in UI labels.
- Titles, descriptions, bodies, option labels and comments are plain text.
  Newlines are preserved; HTML and Markdown are not interpreted.
- Click a selected option again to clear it. No option is selected by default.
- Every item is exported, including unanswered items. Status is `pending`,
  `commented` or `decided`; the authoritative decision is an option ID or `null`.
  A comment alone is not approval.
- Feedback includes `schemaVersion: 1`, `artifactId`, `revision`, stable item
  IDs, each item's decision/comment, and `overallComment`.
- Keep IDs stable across revisions and increment `revision` when the source
  content changes. Match the artifact ID, revision and item IDs when processing
  pasted feedback. Never apply old feedback silently to a new version.

## Saving and restoring

Browser drafts are saved with an artifact-and-revision key when localStorage
is available. Sandboxed OctiqFlow HTML cannot access localStorage; the page
reports this and offers **Save HTML with feedback**. The downloaded HTML embeds
all current feedback and restores it on opening, even offline. A saved snapshot
takes precedence over any browser draft. **Restore feedback JSON** imports only
a matching artifact/revision with valid item and option IDs and asks before
replacing current edits.

**Copy all feedback JSON** attempts the clipboard API, then a selection-based
copy. If both are blocked, it exposes and selects a read-only JSON field for
manual copying. The JSON is always available through the expandable section.
HTML downloads require the containing browser/frame to allow downloads; use
OctiqFlow's native HTML file opener or open the file directly. An iframe that
blocks downloads still supports reviewing and manual JSON copying.

## Output and standalone CLI

`outputDir` must be an existing directory. Without it, the tool uses
`OCTIQ_CANVAS_DIR`, then `OCTIQ_CWD`, then the process working directory. It
writes a unique `<artifactId>-r<revision>-<uuid>.html` with owner-only permissions
and exclusive creation, so existing documents are never overwritten.

```bash
node scripts/mcp/artifact.cjs docs/examples/artifact-review.json /tmp
```

The same module is embedded in the Rust binary and installed beside
`octiq-ask.cjs` when the backend prepares the provider's MCP config. Existing
agent processes must reconnect/restart to discover a newly shipped tool.
Building this change alone does not restart the backend or update running
agent processes.

## Validation

```bash
node --test scripts/mcp/artifact.test.cjs
node scripts/mcp/octiq-ask.test.cjs
cargo check --manifest-path src-tauri/Cargo.toml --bin octiq-server
```

The generator limits documents to 200 items / 2 MB of content, validates unique
IDs, escapes embedded JSON, and inserts supplied text with `textContent`.
Generated documents load no dependencies and disallow network connections.

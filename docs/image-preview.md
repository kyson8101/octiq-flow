# Image and HTML previews

Chats have a **Preview** button in the top bar (inside the actions menu on
small screens). The first preview opens a resizable panel beside the chat;
on phones it opens a sheet. Closing it keeps it closed when more previews arrive.
The open state and selected snapshot are remembered per conversation in that
browser. The panel takes the place of other side columns while it is open.

Agents launched by OctiqFlow can publish an image with the bundled `octiq` MCP:

```json
{
  "path": "/absolute/path/to/home-screen.png",
  "title": "Home screen",
  "slot": "home-screen"
}
```

Call **`preview_image`** with those arguments. `path` is required; `title` and
`slot` are optional. Reuse a slot for revisions of the same image. Omit it to
add an independent image. PNG, JPEG, GIF and WebP are supported, up to 20 MB.
Relative paths and network URLs are not accepted; save the image locally first.

## HTML documents

Call **`preview_html`** with a local file:

```json
{
  "path": "/absolute/path/to/review.html",
  "title": "Design review",
  "slot": "design-review"
}
```

Or upload the source directly:

```json
{
  "html": "<!doctype html><html><body><h1>Design review</h1></body></html>",
  "title": "Design review",
  "slot": "design-review"
}
```

Supply exactly one of `path` or `html`. HTML must be non-empty UTF-8 text,
up to 2 MB. Files must have a `.html` or `.htm` extension. Use self-contained
HTML: inline CSS/JavaScript and embedded images. Neighbouring assets are not
uploaded alongside the document.

The panel shows an HTML document card. **Open HTML** opens the selected
snapshot in a new tab through the existing authenticated form POST opener.
The document does not execute when it is received or selected. Once opened,
its inline scripts can run inside the backend's opaque-origin CSP sandbox;
it cannot access the chat's localStorage, and its URL contains no auth token.
This is origin isolation, not a network block: the existing HTML opener still
permits external resources and links. Existing HTML-file behavior is unchanged.
Reusing `slot` retains earlier snapshots in the version selector.

`create_artifact` outputs can be passed to `preview_html` using their returned
`filePath` as `path`.

## Storage and behavior

Both tools save their document into the active profile at
`previews/<conversation-id>/<snapshot-id>.<extension>`. These are immutable
snapshots: replacing or deleting the source file does not change an existing
preview. Every call publishes its own metadata file atomically, allowing
several agents to publish without overwriting each other's entries. Snapshots
remain on disk across reloads/restarts; this first version has no automatic
pruning or removal UI.

The panel polls `image_preview_list` every 1.2 seconds while the chat is busy
and every 8 seconds otherwise, pausing in hidden browser tabs. It uses the
existing authenticated file route to load images. It preserves the selected
snapshot when new previews arrive, offers a newer-version notice, and groups
images and HTML documents by slot in a thumbnail strip. Use the version selector to compare older
snapshots, zoom buttons to inspect detail, or Full screen for the existing
pan/pinch image viewer.

`preview_image` and `preview_html` are offered only to conversation-bound MCP processes. A newly
built backend must be deployed and an existing agent process reconnected or
restarted before it discovers the new tools. Building/testing alone does not
update running agents or restart the backend.

## Validation

```sh
node --test scripts/mcp/preview.test.cjs
node scripts/mcp/octiq-ask.test.cjs
cargo test --manifest-path src-tauri/Cargo.toml image_preview --lib
cargo check --manifest-path src-tauri/Cargo.toml --bin octiq-server
pnpm --dir web exec tsc -b
node scripts/test-image-preview.mjs
```

The browser test uses Vite, Playwright and isolated transport/image fixtures;
it does not connect to real chats. Set `OCTIQOS_PLAYWRIGHT_MODULE` and
`OCTIQOS_CHROME_EXECUTABLE` when Playwright/Chrome are installed elsewhere.

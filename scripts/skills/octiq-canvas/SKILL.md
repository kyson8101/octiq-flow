---
name: octiq-canvas
description: >-
  Keep a live visual canvas beside the OctiqFlow terminal. Use whenever the user
  is discussing, planning, designing, or making decisions with you in an
  OctiqFlow project terminal and would benefit from seeing a rendered document
  next to the chat — a plan, a diagram, a spec, a decision log, a table, a
  mockup. Triggers on phrases like "show this on the canvas", "draw this out",
  "put this on the canvas", "keep a living doc", "update the canvas", or any
  ongoing discussion whose state is worth rendering aside the terminal. Only
  works when the environment variable OCTIQ_CANVAS_DIR is set (OctiqFlow sets it
  in every project terminal).
---

# OctiqFlow Canvas

OctiqFlow can render an HTML document in a pane **beside this terminal** and
refresh it live whenever the file changes on disk. This skill lets you drive
that pane: you write a file, OctiqFlow shows it; you update the file as the
discussion moves, OctiqFlow re-renders it. The user sees the canvas grow
alongside the conversation.

**Write HTML, not a whole web page.** You write only the **body content** —
headings, tables, and a few ready-made components. OctiqFlow wraps your content
in a **fixed OctiqFlow template** (dark theme, sage accent, typography, the
component styles below). The template is the same in every project and every
session, so you never write `<!doctype>`, `<html>`, `<style>`, or pick colors —
you reuse one look every time. Markdown still works, but **HTML is the default**
because the components make a canvas far more scannable.

## Where the canvas lives

OctiqFlow exports an environment variable into this terminal:

- `OCTIQ_CANVAS_DIR` — the absolute path of this project's canvas folder
  (`~/.octiqflow/canvas/<projectKey>/`). **Write canvas documents here.**

**Always check it first.** If `OCTIQ_CANVAS_DIR` is empty or unset, this is not
a canvas-enabled OctiqFlow terminal — tell the user the canvas is only available
in an OctiqFlow project terminal, and do not write files to a guessed path.

```bash
echo "$OCTIQ_CANVAS_DIR"
```

## How to use it

1. **One living document by default.** Write a single file named `canvas.html`
   into `$OCTIQ_CANVAS_DIR` and keep updating it, unless the user asks for
   separate documents. OctiqFlow shows the most recently changed document.
2. **Write a body fragment, not a full page.** Use your normal file-writing
   tool. Put only the content — `<h1>`, `<table>`, `.card`, `.callout`, etc.
   Do **not** add `<!doctype>`, `<html>`, `<head>`, or `<style>`. OctiqFlow
   applies the fixed template for you.
3. **Update it on every new decision or turn that changes the picture.** When
   the discussion reaches a new conclusion, rewrite or extend the file. The pane
   re-renders within a moment of the save. Keep the document the current source
   of truth — prefer rewriting a section over endlessly appending.
4. **Tell the user briefly** what you put on the canvas (one line), so they know
   to look at the pane. Do not paste the whole document back into the terminal —
   the canvas is where it lives now.

## The fixed template — classes you can use

You get these out of the box. Use them; do not invent your own colors.

| Class | What it is |
|-------|------------|
| `.card` | A raised panel. Group related content inside it. |
| `.grid` | Auto-fit columns. Wrap several `.card`/`.stat` to lay them side by side. |
| `.stat` | A metric block. Inside: `<div class="num">42</div><div class="label">Open</div>`. |
| `.badge` | A small pill. Add `.accent` / `.ok` / `.warn` / `.danger` for color. |
| `.callout` | A highlighted note. Add `.ok` / `.warn` / `.danger` to change the tone. |
| `.eyebrow` | A small uppercase label above a heading. |
| `.meta`, `.muted` | Muted secondary text. |
| `.row`, `.spread` | Flex helpers (a row of items; or push items apart). |
| `<kbd>` | A keycap (e.g. `<kbd>Ctrl</kbd>`). |

Plain HTML is themed too: `h1`–`h4`, `p`, `ul`/`ol`, `table`, `pre`/`code`,
`blockquote`, `hr`, `img`, `a`, `strong`.

## Format rules

- **No `<style>`, no colors.** The template owns the look so every canvas matches.
  If you truly need a one-off custom style, see the escape hatch below.
- **Self-contained.** If you add a `<script>`, inline it. The frame is sandboxed
  (`allow-scripts`, no same-origin) — scripts run, but the document **cannot**
  reach the network, the app, OctiqFlow, or the user's machine. Do not link
  external stylesheets, fonts, or scripts; they will not load.
- **Keep it scannable.** Favour headings, tables, cards, and short lists over
  long prose. The canvas is a visual aid, not a transcript.

## Example — a living decision canvas

```bash
cat > "$OCTIQ_CANVAS_DIR/canvas.html" <<'EOF'
<div class="eyebrow">Design session</div>
<h1>Auth rebuild — decisions</h1>

<div class="grid">
  <div class="stat"><div class="num">3</div><div class="label">Decided</div></div>
  <div class="stat"><div class="num">1</div><div class="label">Open</div></div>
</div>

<table>
  <thead><tr><th>#</th><th>Decision</th><th>Why</th></tr></thead>
  <tbody>
    <tr><td>1</td><td>Short-lived access tokens + refresh</td><td>Limit blast radius of a leak</td></tr>
    <tr><td>2</td><td>Refresh token in an HttpOnly cookie</td><td>Keep it out of JS reach</td></tr>
  </tbody>
</table>

<div class="callout warn">
  <strong>Open question:</strong> token lifetime — 15 min vs 1 hour?
</div>
EOF
```

Update the same file later as the discussion evolves — the pane follows.

## Escape hatch — a fully custom page

When you need full control (a custom diagram, a chart, your own layout), write a
**complete** HTML document — start it with `<!doctype html>`. OctiqFlow detects
the full document and renders it **as-is**, skipping the template. You then own
all styling, so use a dark-friendly palette (light text on a dark or transparent
background) and keep everything inline and self-contained.

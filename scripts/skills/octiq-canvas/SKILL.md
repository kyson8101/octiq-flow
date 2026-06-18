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

OctiqFlow can render an HTML or Markdown document in a pane **beside this
terminal** and refresh it live whenever the file changes on disk. This skill
lets you drive that pane: you write a file, OctiqFlow shows it; you update the
file as the discussion moves, OctiqFlow re-renders it. The user sees the canvas
grow alongside the conversation.

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

1. **One living document by default.** Use a single file named `canvas.md` (or
   `canvas.html`) as the evolving canvas, unless the user asks for separate
   documents. OctiqFlow shows the most recently changed document automatically.
2. **Write the file** into `$OCTIQ_CANVAS_DIR`. Use your normal file-writing
   tool. Markdown (`.md`) is rendered with a clean dark theme. HTML (`.html`) is
   rendered as-is inside a sandboxed frame — good for diagrams, tables, small
   charts, or anything you want to style yourself.
3. **Update it on every new decision or turn that changes the picture.** When
   the discussion reaches a new conclusion, rewrite or extend the file. The pane
   re-renders within a moment of the save. Keep the document the current
   source of truth — prefer rewriting a section over endlessly appending.
4. **Tell the user briefly** what you put on the canvas (one line), so they know
   to look at the pane. Do not paste the whole document back into the terminal —
   the canvas is where it lives now.

## Format rules

- **Dark mode.** The pane is dark. Markdown is themed for you. For HTML, use a
  dark-friendly palette: light text on a dark/transparent background, no large
  white fills. A safe base: `body { color:#c9c9c5; background:transparent;
  font-family: ui-sans-serif, system-ui, sans-serif; }`.
- **Self-contained HTML.** Inline your CSS and any JavaScript. The frame is
  sandboxed (`allow-scripts`, no same-origin) — scripts run, but the document
  **cannot** reach the network, the app, OctiqFlow, or the user's machine. Do
  not link external stylesheets, fonts, or scripts; they will not load.
- **Keep it scannable.** Favour headings, tables, short lists, and diagrams over
  long prose. The canvas is a visual aid, not a transcript.

## Examples

A decision log that grows during a design chat:

```bash
cat > "$OCTIQ_CANVAS_DIR/canvas.md" <<'EOF'
# Auth rebuild — decisions

| # | Decision | Why |
|---|----------|-----|
| 1 | Use short-lived access tokens + refresh | Limit blast radius of a leak |
| 2 | Store refresh token in HttpOnly cookie | Keep it out of JS reach |

## Open questions
- Token lifetime: 15 min vs 1 hour?
EOF
```

A small self-contained HTML diagram:

```bash
cat > "$OCTIQ_CANVAS_DIR/canvas.html" <<'EOF'
<!doctype html><meta charset="utf-8">
<style>
  body { color:#c9c9c5; background:transparent; font-family: system-ui, sans-serif; }
  .box { border:1px solid #8fbfa8; border-radius:8px; padding:10px 14px; display:inline-block; }
  .arrow { color:#8fbfa8; margin:0 10px; }
</style>
<div class="box">UI</div><span class="arrow">&rarr;</span>
<div class="box">pty_write</div><span class="arrow">&rarr;</span>
<div class="box">PTY stdin</div>
EOF
```

Update the same file again later as the discussion evolves — the pane follows.

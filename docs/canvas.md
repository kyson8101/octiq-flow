# Canvas

The **canvas** is a togglable pane beside the project terminals that renders a
live **HTML or Markdown** document an agent writes. While you talk with Claude in
a terminal, Claude can draw a plan, a diagram, a spec, or a decision log onto the
canvas and keep updating it as the discussion moves — and you watch it grow next
to the chat.

## How it works

The flow mirrors the rest of OctiqFlow: no IPC socket, just files on disk plus a
file watcher (like the sidebar's git watcher) and a small render pane.

```
agent writes a file ──► ~/.octiqflow/canvas/<projectKey>/canvas.md
        │                  (it finds the folder via $OCTIQ_CANVAS_DIR)
        ▼
canvas.rs notify watcher ──► "canvas-changed" {key} event
        ▼
canvas.js re-lists the folder + re-reads the shown document
        ▼
rendered in a SANDBOXED iframe in the canvas pane
```

- **Where the files live.** Each project has a folder at
  `~/.octiqflow/canvas/<projectKey>/` (the project's workspace id is the key).
  It is **global** (under your home dir, not in the repo), so the canvas never
  dirties the project's git tree, and it **survives a restart**.
- **How the agent finds it.** Every **project** terminal exports the env var
  `OCTIQ_CANVAS_DIR` pointing at that folder (`pty.rs`, next to `OCTIQ_TERM_KEY`).
  Chat terminals are not project-scoped, so they get no canvas.
- **How it renders.** Markdown is rendered with the vendored `marked` and wrapped
  in a dark theme. HTML is shown as-is. Both render inside an
  `<iframe sandbox="allow-scripts">` with **no** `allow-same-origin`, so agent
  HTML runs in an isolated origin: it can draw and animate but **cannot** reach
  the app, Tauri, the network, or your machine.
- **Which document shows.** The pane defaults to **Auto (latest)** — the most
  recently changed file. Pick a specific document from the dropdown to pin it.
  The common case is one living `canvas.md` the agent keeps rewriting.

## Using it

1. Open a project and start Claude in a terminal.
2. Click the **canvas** button in the project's right command-panel head to show
   the pane (drag the handle on its left to resize; the open/closed state and
   width are remembered).
3. Ask Claude to put something on the canvas. It writes a file into
   `$OCTIQ_CANVAS_DIR` and the pane shows it. As decisions are made, Claude
   updates the file and the pane re-renders.

## Highlight to ask

Reading a long plan and following up on one part used to mean retyping it into
the terminal. Now you can ask in place: **select text in the canvas**, click the
**Ask about this** button that floats by your selection, type your question, and
**Send to terminal**. OctiqFlow writes a single line into the project's active
terminal — `About "<the text you picked>" on the canvas: <your question>` — and
presses Enter, so the agent answers right there.

- The selection is captured by a small script injected into the (sandboxed)
  frame, which posts it out to `canvas.js` — the parent cannot read across the
  frame's origin directly.
- The message is kept to one line so a terminal-UI agent (Claude Code, Codex)
  does not submit it early on a stray newline. In the composer, **Enter** sends,
  **Shift+Enter** adds a line, **Esc** cancels.
- It goes to the **active terminal** of the current project. If none is open,
  the composer says so.

## The canvas skill

So Claude knows the convention, install the **canvas skill** once from
**Settings → Canvas → Install canvas skill for Claude**. It writes
`~/.claude/skills/octiq-canvas/SKILL.md` (and nothing else). The skill tells
Claude to keep a living document in `$OCTIQ_CANVAS_DIR`, dark-mode friendly,
updated on each decision. Like the resume/alert hooks, OctiqFlow only touches
your agent config when you ask.

Codex (or any agent) can use the canvas too — the channel is just files. Codex
already gets `OCTIQ_CANVAS_DIR` in a project terminal; it just needs to know the
convention. **Settings → Canvas → Install canvas guide for Codex** adds a short
guide to `~/.codex/AGENTS.md` (inside a marked block, keeping the rest of the
file) so Codex writes `.md` / `.html` documents into `$OCTIQ_CANVAS_DIR`.

## Backend surface

`src-tauri/src/canvas.rs` owns the store + watcher. Tauri commands:

| Command | Purpose |
| --- | --- |
| `canvas_dir(key)` | Ensure + return the project's canvas folder path. |
| `canvas_list(key)` | List the folder's documents, newest first. |
| `canvas_read(key, name)` | Read one document (path-traversal guarded, 5 MB cap). |
| `canvas_watch(key)` | Watch the folder; emit debounced `canvas-changed`. |
| `install_canvas_skill()` | Write the skill into `~/.claude/skills/`. |

The project key is sanitized to a single safe path segment, and `canvas_read`
verifies the resolved path stays inside the canvas folder, so a crafted key or
document name can never read an arbitrary file.

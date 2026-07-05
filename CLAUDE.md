# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OctiqFlow is an **agent workflow orchestrator**: a Tauri 2 desktop app (Rust
backend + web UI) that runs **real terminals inside its window** and lets you
**drive interactive CLI agents (Claude Code, Codex) from UI buttons**. The core
trick: a UI action calls `invoke("pty_write", { id, data })`, Rust writes those
bytes to a PTY's stdin, and the shell/agent reads them as if typed. PTY output
streams back as `pty-output` events and renders in xterm.js.

> The `README.md` "first milestone / single terminal" framing is **stale**. The
> app is already multi-PTY: many terminals per project, a project sidebar, a
> file browser, a git diff viewer, attention alerts, and agent-session resume.
> Trust the code over the README's roadmap section.

## Commands

Run everything from the repo root. **Rust + Node + pnpm are required.**

```bash
pnpm install            # install the Tauri CLI (only JS dependency)
pnpm tauri dev          # dev window with hot reload
pnpm tauri build        # release: compiles Rust, bundles .app + .dmg
```

- **Releasing** is done by the `/ship` skill (commit → `npm run tauri build` →
  print the `.dmg` folder). It never pushes, signs, or notarizes; builds are
  unsigned, so macOS Gatekeeper warns on first open.
- **Rust tests** (inline `#[cfg(test)]` in several modules): `cd src-tauri &&
  cargo test`. There is **no JS/frontend test runner** — the web UI has no
  automated tests.
- **Format**: `cd src-tauri && cargo fmt`. There are no eslint/prettier/rustfmt
  config files; defaults apply.

## Architecture

### The PTY bridge (the heart of the app)

```
UI action ──► invoke("pty_write", {id, data})  ──► Rust writes bytes to PTY stdin
PTY output ──► reader thread ──► "pty-output" {id, chunk} event ──► xterm renders
```

- **`src-tauri/src/pty.rs`** is the multi-PTY manager (`PtyManager`, Tauri-managed
  state). Sessions are keyed by a **frontend-supplied String id**; the frontend
  decides ids at spawn time and routes each `pty-output` chunk to the matching
  xterm. Shells are login shells (`$SHELL -l` on Unix, powershell on Windows; see
  `resolve_shell`) — a login shell is required so `PATH` is fully populated (a GUI
  app does not inherit the interactive shell `PATH`, so `claude` would not be
  found otherwise).
- **`src/terminals.js`** is the **single** source of terminal management on the
  frontend (`createTerminalGroup`). Project, Chat, and command terminals create
  groups through it. One global `pty-output` listener lives here and fans chunks
  out to every group's terminals. Terminals stay alive (scrollback in memory)
  when their group is hidden.

### Backend (Rust, `src-tauri/src/`)

`lib.rs` wires everything: it registers Tauri-managed state in `setup()` and
lists every `#[tauri::command]` in the `invoke_handler![...]` block. **To add a
backend command: write the `#[tauri::command]` fn in its module, then add it to
that `generate_handler!` list** — missing this is the usual "command not found"
cause. Modules, by responsibility:

- `pty.rs` — multi-PTY sessions, OSC attention scanning (see Alerts below).
- `agent_resume.rs` — re-attach a restored tab to its prior agent session
  (`claude --resume <id>` / `codex resume <id>`). The live agent cannot survive a
  restart, so an **external hook** captures the agent's session id while it runs.
- `terminal_layout.rs` — persists each project's tab list + scrollback so
  terminals rebuild after restart (a fresh shell per tab, old scrollback written
  in above the new prompt).
- `workspaces.rs` — the "project" store (a project groups several folder paths).
- `git.rs` — the **single** git-read backend (status summary, changed files,
  file diff). Read-only; shells out to `git`. Resolves each project path to its
  repo top-level and de-dups so one repo shows once. The sidebar counts, the
  Dashboard grid, and the diff panel all read through here so counts agree.
- `fsbrowse.rs` / `dashboard.rs` — file browser listing / dashboard widgets.
- `bin/octiq-notify.rs` — a **separate binary target** (auto-discovered from
  `src/bin/`, independent of the app). It prints an OSC 777 sequence to its own
  stdout; run inside an OctiqFlow terminal, the PTY scanner sees it and raises an
  attention alert. See `docs/octiq-notify.md`.

### Frontend (vanilla JS, `src/`)

**No bundler.** The frontend is plain ES-module JS served straight from `src/`
(`tauri.conf.json` → `frontendDist: "../src"`). `withGlobalTauri: true` exposes
`window.__TAURI__` (so modules use `const { invoke } = window.__TAURI__.core`,
not an npm import).

- **Adding a frontend module:** create `src/foo.js` AND add a
  `<script type="module" src="/foo.js" defer>` tag in `src/index.html`. Module
  imports use absolute paths (`import { x } from "/settings.js"`).
- **Modules talk via window CustomEvents**, not direct imports — e.g. `workspaces.js`
  emits `project-selected`, and `project.js` / `commands.js` / `gitdiff.js`
  react. `modes.js` is the top-level view router (Project / Chat / Agents /
  Dashboard / Settings; one view visible at a time, choice in localStorage).
- **xterm.js is vendored** in `src/vendor/` (no CDN, works offline). Terminals
  render with the **WebGL** addon, not the DOM renderer — the DOM renderer leaves
  ghosted/overlapping glyphs after reflow. Only the **active tab of a visible
  group** holds a WebGL context (attached on activate/show, disposed on
  deactivate/hide): each context costs GPU memory and WebKit caps live contexts
  (~16), silently killing the oldest past the cap. On GPU context loss the addon
  disposes itself; the next activation attaches a fresh one.
- `main.js` is intentionally empty (kept only so its `<script>` tag stays valid).

### Persistence locations

| Store | Path | Owner |
| --- | --- | --- |
| workspaces / terminal layout + scrollback | Tauri app-data dir (JSON) | `workspaces.rs`, `terminal_layout.rs` |
| agent session map | **fixed** `~/.octiqflow/agent-sessions.json` | written by the external hook, read/pruned by `agent_resume.rs` |
| terminal appearance (font, size, line height) + last mode | browser `localStorage` | `settings.js`, `modes.js` |

The agent-session map uses a fixed `~/.octiqflow` path (not the app-data dir) so
the external capture hook can find it without knowing the bundle id.

### Agent-session resume flow

`agent_resume.rs::setup_agent_hooks` installs `scripts/hooks/agent-session-capture.cjs`
(embedded via `include_str!`) into the agent's hook config (e.g.
`~/.claude/settings.json`). OctiqFlow sets `OCTIQ_TERM_KEY` (a tab's stable
persistKey) in each spawned shell; the agent and the hook inherit it, and the
hook keys the captured `sessionId` by it. On restart the app reads that map to
rebuild the resume command in the same tab. The hook is best-effort and must
never break the agent (any error → exit 0).

### Attention alerts

`pty.rs` scans PTY output for OSC 9 / OSC 777 / OSC 99 (Kitty) "notify"
sequences and raises a `pty-attention` event. `alerts.js` badges the terminal's
tab and lists it in a top banner; clicking jumps to that terminal and clears the
flag (`pty_clear_attention`). This is how agents that emit no escape codes flag a
tab — run `octiq-notify` and the alert fires.

### Quit handshake

The first window-close is intercepted (`lib.rs`): the app holds the window open,
emits `app-closing` so the frontend flushes every terminal's scrollback to disk,
then `confirm_close` lets it through. A `CLOSE_FLUSH_TIMEOUT` (2.5s) fallback
forces the close so a hung terminal can never make the app unclosable.

## Conventions & gotchas

- **Code comments reference "card NN"** (e.g. "card 04 — Project mode"). The app
  was built in numbered work cards/phases; the numbers are historical context,
  not a live system.
- **`macos-fps` plugin** lifts WKWebView's 60fps `requestAnimationFrame` cap to
  the display's native rate (e.g. 120Hz ProMotion) so terminal scroll is smooth.
  It needs the `plugins.macos-fps` block in `tauri.conf.json` or it panics. It
  uses a **private Apple API → NOT Mac App Store safe**; fine here because
  OctiqFlow ships as a `.dmg`. No-op on Windows/Linux.
- **CSP is currently disabled** (`csp: null` in `tauri.conf.json`); the README
  roadmap notes re-enabling a strict CSP as future work.
- The macOS signing identity is hardcoded in `tauri.conf.json` (a personal Apple
  Development cert); the `/ship` build is unsigned regardless.
- `scripts/generate_brand_assets.py` regenerates the brand/icon assets under
  `src/assets/brand/` — not part of the app build.

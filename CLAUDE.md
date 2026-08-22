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
pnpm install                                  # the Tauri CLI (only root JS dependency)
pnpm --dir web build                          # the client → web/dist
cd src-tauri && cargo build --release --bin octiq-server   # the backend
touch ~/.octiqflow/restart.request            # restart the backend (see below)
pnpm tauri dev                                # desktop window, only if you want one
```

The restart above is a touched file, not a script, and that is deliberate —
see the bullet below. The two installers are run **once**, from a real terminal,
and never again from inside an agent chat:

```bash
./scripts/install-service.sh                  # first install of the backend service
./scripts/install-restart-agent.sh            # first install of the restart helper
```

- **Deploying** is done by the `/ship` skill (commit → test → build the client
  AND `octiq-server` → ask, then restart the service → print the URL). It never
  pushes, signs, or notarizes.
- **The desktop app is no longer the product.** OctiqFlow ships as a headless
  server plus a browser client; `pnpm tauri build` (`.app` + `.dmg`) still
  works but is not part of the deploy path. The client is served at the **root**
  (`http://127.0.0.1:1421/?token=…`) and only there; `/v2/` is no longer served
  and redirects to the root, query intact, so saved links keep working.
- **The two halves deploy separately, and that bites.** `web/dist` is read off
  disk at runtime, so a client build reaches the browser on the next reload with
  no restart — while the backend only changes when the service restarts. A
  client-only deploy leaves a new page calling commands an old binary does not
  have, which fails as `'<cmd>' is not available from a browser — it needs the
  desktop app`. Ship both.
- **Restart the backend by touching a file, NOT by running the script.**

  ```bash
  touch ~/.octiqflow/restart.request        # restart
  tail -f ~/.octiqflow/logs/restart.log     # what happened
  ```

  An agent chat is a **grandchild of the server it would restart** —
  `install-service.sh ← zsh ← claude -p ← octiq-server` — so the `launchctl
  bootout` halfway down that script kills the shell running the script. The old
  server stops, the new one is never bootstrapped, and the backend is left
  **down**, with the line that would have said so dying too. Check with
  `ps -o pid=,ppid=,comm= -p <pid>` walked up to PID 1 if you doubt it.

  The trigger file is watched by a **second launchd job**
  (`com.kyson.octiqflow.restarter`, installed once by
  `scripts/install-restart-agent.sh`) that the dying server cannot touch, so the
  restart always runs to the end. It re-reads the bind address from the running
  plist, so a server deliberately put on `0.0.0.0` does not come back on
  loopback. Reinstall it only if this repo MOVES — the path is baked into its
  plist.

- **Restarting stops every live agent chat, including the one doing it.** Every
  `claude -p` / `codex exec` the server owns dies with it, and nothing can save
  the chat that asked — it is a child of what is being restarted. Transcripts
  survive and can be resumed; the running turns cannot. **Ask before doing it,
  and commit and push first**, because you do not get another turn afterwards.
- **Rust tests** (inline `#[cfg(test)]` in several modules): `cd src-tauri &&
  cargo test`.
- **Web tests**: `cd web && pnpm test` (vitest, node environment, no jsdom).
  These cover `web/src/lib/` pure logic only — chiefly the `chat.ts` reducer,
  replayed against **real captured agent streams** in
  `web/src/lib/__fixtures__/*.jsonl`. Those fixtures are verbatim
  `claude -p --output-format stream-json` output; re-record them with the same
  flag set `build_command` uses (`agent_chat.rs`), never hand-edit them. There
  is still no test runner for the vanilla-JS `src/` UI and no component
  rendering tests anywhere.
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
- **`layout.js` is the center layout manager**: at most ONE panel (file tree /
  web preview / git diff) is open at a time, docked to any of the 4 sides of
  the terminal area (`lay-dock-*` classes + one shared resizer + persisted
  sizes) or replacing it (`mode: "main"`, git diff). Panels register once
  (`registerPanel`) and call `openPanel`/`closePanel`; never toggle another
  panel's element directly.
- **Files open as TABS in the terminal tab strip** (VS Code style):
  `browser.js` (trees + search) dispatches `file-open`; `filetabs.js` opens a
  Monaco editor tab via `TerminalGroup.newContentTab` (a tab hosting arbitrary
  DOM instead of an xterm — content tabs are skipped by layout/scrollback
  persistence and do not survive a restart).
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

### Themes (browser client)

The client ships a theme chooser (top bar → gear → Settings). Themes are
authored in **tweakcn / shadcn** format and pasted in **verbatim** as
`web/src/lib/themes/<id>.css` — never hand-edited, so re-pasting an updated
theme is a straight overwrite. Adding one is two steps: drop the file, add a
line to `PASTED` in `web/src/lib/themeStore.ts`.

- That format is not ours. `web/src/lib/theme.ts` **translates** its names
  (`--primary`, `--card`, `--muted-foreground`) into the stylesheet's own
  (`--accent`, `--bg-1`, `--fg-2`). Two traps it exists to handle: shadcn's
  `accent` is a quiet hover tint, so `--accent` comes from **`primary`**; and
  the pasted `muted` is sometimes darker than `card`, so the `bg-0/1/2` ladder
  is built off `card`, never off `muted`. `--ok` / `--warn` have no shadcn
  equivalent — they are picked from the theme's chart colours by hue, and
  invented at the right hue when the theme has no green (Bubblegum has none).
- **Themes set colours and corner radii only** — never fonts (the terminal
  draws Menlo, and code in the chat should be the same shapes) and never the
  drop shadow (the pasted ones are built for small light cards).
- The terminal cannot read a `var()` — xterm hands its palette to WebGL. So
  `web/src/lib/xtermTheme.ts` resolves the variables through a hidden element
  **and then a 1×1 canvas**: computed style returns `oklab(…)`, which xterm's
  colour parser does not understand.
- Text that sits ON a fill uses `--accent-fg` / `--danger-fg`, not `#fff`. A
  theme's accent can be a pale yellow, and white on it is unreadable.
- **Dark only, by decision.** Only a pasted theme's `.dark` block is ever
  applied; `styles.css` sets `color-scheme: dark` once and nothing overrides it.
  A few colours are outside the theme system on purpose — the PDF viewer's white
  page, the CodeMirror One Dark syntax palette, and the tool-icon `--tint` set,
  which is a categorical palette rather than a semantic one.
- `vite.config.ts` sets `test: { css: true }`. Without it vitest stubs CSS to an
  empty string — `?raw` included — and every theme silently parses to nothing.

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
- **Everything under `src/` is embedded in the app binary** (`frontendDist:
  "../src"`). Keep art and other non-runtime files out of it. The full brand set
  lives in top-level `brand/`, the (currently unused) agent artwork in
  `assets/agents/`; only the three app-icons `index.html` actually loads are
  mirrored into `src/assets/brand/app-icons/`.
- `scripts/generate_brand_assets.py` regenerates the brand/icon assets into
  `brand/` and mirrors those three icons into `src/` — not part of the app build.

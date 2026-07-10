# octiq-flow

An agent workflow orchestrator. octiq-flow is a cross-platform desktop app
(Tauri: Rust backend + web UI) that runs **real terminals inside its window**
and lets you **drive interactive CLI agents (Claude Code, Codex) from UI
buttons**.

## How it works

The core trick is that a UI action writes bytes to a PTY's stdin, and the shell
or agent inside reads them as if they had been typed:

```
UI action ──► invoke("pty_write", { id, data })  (JS)
                   │
                   ▼
      Rust writes those bytes to that PTY's stdin
                   │
                   ▼
   the login shell / claude / codex reads them as if typed
                   │
   PTY output ──► "pty-output" { id, chunk } ──► xterm.js renders it
```

Terminals are keyed by a frontend-chosen id, so the app runs many at once and
routes each output chunk to the right one. A login shell (`$SHELL -l`) is used so
`PATH` is fully populated — a GUI app does not inherit the interactive shell
`PATH`, so spawning `claude` directly would fail to find it.

## What it does

- **Projects.** A project groups several folders. Each has its own tab strip of
  terminals, a startup layout, per-project commands, and an optional terminal
  font/colour override.
- **Agents.** Launch Claude or Codex into a new tab in one click. A tab names
  itself after the agent's session title.
- **Session resume.** Terminals, their tab order and their scrollback are saved
  and rebuilt after a restart. An external capture hook records each agent's
  session id while it runs, so a restored tab re-attaches with
  `claude --resume <id>` / `codex resume <id>`.
- **Hibernate.** Free an idle agent's process while keeping its tab, its output,
  and a one-click resume.
- **Attention alerts.** A tab that needs you is badged, listed in a banner, and
  raised as an OS notification — even from another project. Agents that emit no
  escape codes can call the bundled `octiq-notify` CLI, or you can turn on the
  tmux-style activity / silence monitors. An optional `notify-hook` script can
  rewrite or suppress any alert (see `docs/octiq-notify.md`).
- **Git.** Live per-project change counts in the sidebar, a changed-file list and
  a diff viewer, and branch switching. Read-only; it shells out to `git`.
- **Panes.** A file browser with inline preview and edit, a live canvas pane that
  renders HTML/Markdown an agent writes, a web preview, and a screenshot vault.

## Stack

- **Desktop shell:** [Tauri v2](https://tauri.app/) (cross-platform: macOS,
  Windows, Linux).
- **Backend:** Rust + `portable-pty`, plus `notify` (fs watching) and `rdev`
  (the screenshot hotkey).
- **Frontend:** vanilla HTML/CSS/JS — no bundler, no framework. Vendored in
  `src/vendor/` and served offline: `xterm.js` (with the WebGL, fit and
  serialize addons), `marked`, `highlight.js`, and `codejar`.

## Run it

octiq-flow is cross-platform (macOS, Windows, Linux). All platforms need three
things: **Rust**, **Node + pnpm** (for the Tauri CLI), and the platform's
**webview**. The build commands are the same everywhere:

```bash
pnpm install
pnpm tauri dev      # dev window with hot reload
pnpm tauri build    # production app / installer
```

### macOS

Rust via Homebrew (`brew install rust`). The WKWebView is part of the OS, so no
extra runtime is needed. `pnpm tauri build` produces a `.app` / `.dmg`.

### Windows

Prerequisites:

- **Rust (MSVC toolchain)** — `winget install Rustlang.Rustup`. This installs
  the `x86_64-pc-windows-msvc` toolchain, which links with the MSVC C++ tools.
- **Visual Studio 2022** (Community is fine) or **Build Tools for Visual
  Studio** with the **"Desktop development with C++"** workload. This provides
  the MSVC linker (`link.exe`) and the Windows SDK that Rust links against.
  Without it, `cargo build` fails with a "linker not found" error.
- **WebView2 Runtime** — preinstalled on Windows 11 and shipped with Edge /
  Brave / Chrome. If missing, install the Evergreen runtime from Microsoft.
- **Node + pnpm** — `winget install OpenJS.NodeJS` then `npm i -g pnpm`.

Then, from a normal PowerShell (Rust auto-detects the MSVC tools — no need for a
Developer prompt):

```powershell
pnpm install
pnpm tauri dev      # dev window with hot reload
pnpm tauri build    # production .exe + MSI/NSIS installer
```

`pnpm tauri build` produces an `.exe` plus MSI / NSIS installers under
`src-tauri/target/release/bundle/`.

### Linux

Rust via [rustup](https://rustup.rs/). Install the Tauri system dependencies
(WebKitGTK and friends) per the
[Tauri Linux prerequisites](https://tauri.app/start/prerequisites/), then run
the same `pnpm` commands.

## Roadmap

- **A re-enabled strict CSP.** `csp` is currently `null`, so a content injection
  into the webview would reach the full IPC surface. Filesystem writes are
  confined and the asset-protocol and opener scopes are narrowed
  (`src-tauri/src/paths.rs`), but a real CSP is the missing layer.
- Child lifecycle management (restart a terminal whose shell exited).
- Bracketed-paste for multi-line injection.
- Auto-hibernate for agent tabs that have been quiet for a while.

# octiq-flow

An agent workflow orchestrator. octiq-flow is a cross-platform desktop app
(Tauri: Rust backend + web UI) that runs a **real terminal inside its window**
and lets you **drive an interactive CLI agent (like `claude`) from UI buttons**.

This is the first milestone: a single, fully interactive terminal session with
button-driven injection. Multi-agent orchestration (several sessions, a session
sidebar, per-agent controls) is planned as the next pass.

## How it works

```
UI button click ──► invoke("pty_write", { data })  (JS)
                         │
                         ▼
            Rust command writes bytes to the PTY stdin
                         │
                         ▼
        the login shell / claude reads them as if typed
                         │
            PTY output ──► "pty-output" event ──► xterm.js renders it
```

- **Backend** (`src-tauri/src/lib.rs`): spawns a login shell (`$SHELL -l`) on a
  PTY with [`portable-pty`](https://crates.io/crates/portable-pty). A login
  shell is used so `PATH` is fully populated — a GUI app does not inherit the
  interactive shell `PATH`, so spawning `claude` directly would fail to find it.
  - `pty_write(data)` — writes raw text into the terminal. This is the injection.
  - `pty_resize(rows, cols)` — keeps the PTY size in step with the window.
  - A reader thread streams PTY output to the frontend as `pty-output` events.
- **Frontend** (`src/`): renders the stream with [xterm.js](https://xtermjs.org/)
  (vendored in `src/vendor/`, no CDN). Buttons:
  - **Launch Claude** — sends `claude\r` to start Claude in the shell.
  - **Inject** — puts the input box text on the prompt line, does not submit.
  - **Inject + Enter** — puts the text on the line and submits it (`\r`).

The terminal is fully interactive too: real keystrokes are forwarded with the
same `pty_write` command, so you can type in it directly.

## Stack

- **Desktop shell:** [Tauri v2](https://tauri.app/) (cross-platform: macOS,
  Windows, Linux).
- **Backend:** Rust + `portable-pty`.
- **Frontend:** vanilla HTML/CSS/JS + `xterm.js` (vendored, offline).

## Run it

Rust is required (installed via Homebrew: `brew install rust`). Node + pnpm are
required for the Tauri CLI.

```bash
pnpm install
pnpm tauri dev      # dev window with hot reload
pnpm tauri build    # production .app / installer
```

## Roadmap

- **Now:** one interactive terminal session, button-driven injection.
- **Next:** multiple PTY sessions managed in app state, a session sidebar, and
  per-agent launch/stop controls — the full orchestrator.
- Child lifecycle management (restart on exit), bracketed-paste for multi-line
  injection, and a re-enabled strict CSP.

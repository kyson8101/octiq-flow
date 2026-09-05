# octiq-flow

An agent workflow orchestrator. octiq-flow is a headless Rust server plus a
browser client that runs **real terminals in a web page** and lets you **drive
interactive CLI agents (Claude Code, Codex) from UI buttons**.

Agents can also read another OctiqFlow conversation from a supplied browser URL
through the bundled [`read_conversation` MCP tool](docs/conversation-mcp.md).

Because the server is headless, it can run on a machine that stays on — a Mac
mini, a home server — while you drive it from a laptop, a phone or anything else
with a browser. The agents run where the server runs.

## How it works

The core trick is that a UI action writes bytes to a PTY's stdin, and the shell
or agent inside reads them as if they had been typed:

```
browser: a UI action ──► pty_write { id, data } over the WebSocket
                   │
                   ▼
      Rust writes those bytes to that PTY's stdin
                   │
                   ▼
   the login shell / claude / codex reads them as if typed
                   │
   PTY output ──► "pty-output" { id, chunk } ──► xterm.js renders it
```

Terminals are keyed by a client-chosen id, so the server runs many at once and
routes each output chunk to the right one. A login shell (`$SHELL -l`) is used so
`PATH` is fully populated — a service does not inherit the interactive shell
`PATH`, so spawning `claude` directly would fail to find it.

Commands do not go through a window. `web.rs` takes the request, `dispatch.rs`
looks the name up in one table and calls the backend directly, and events go
back out through `bus.rs` to every attached browser.

## What it does

- **Projects.** A project groups several folders, each with its own terminals.
- **Agents.** Launch Claude or Codex in one click. Agents run as a JSON stream
  rather than a TUI, so the chat view can render tool calls as cards.
- **Chat transcripts.** Conversations are saved and can be reopened or resumed.
- **Attention alerts.** A terminal that needs you raises an alert. Agents that
  emit no escape codes can call the bundled `octiq-notify` CLI (see
  `docs/octiq-notify.md`).
- **Git.** Live per-project change counts, a changed-file list, a diff viewer,
  and branch switching.
- **Files.** A file browser with preview and edit.
- **Themes.** A theme chooser in the client, dark only by decision.

## Stack

- **Backend:** Rust — `axum` (HTTP + WebSocket), `portable-pty`, `notify` (fs
  watching), `jsonwebtoken` (Cloudflare Access).
- **Client:** React + Vite + TypeScript in `web/`, with `xterm.js` for the
  terminals.

There is **no desktop app and no Tauri**. Both were removed once the browser
client became the product; the `src-tauri/` folder name is historical.

## Run it

You need **Rust** and **Node + pnpm**. No webview, no system GUI libraries, no
platform SDK — the server is plain Rust and the client is a static bundle.

```bash
pnpm --dir web build                                       # the client → web/dist
cd src-tauri && cargo build --release --bin octiq-server    # the backend
./target/release/octiq-server                              # run it
```

Then open the URL it prints. The client is served at the root and needs the
token from `<profile dir>/web.json`:

```
http://127.0.0.1:1421/?token=…
```

`OCTIQ_WEB_PORT` and `OCTIQ_WEB_BIND` override the port and interface for one
run. The default bind is loopback; exposing it to a network is a deliberate act.

On macOS, `./scripts/install-service.sh` installs the server as a launchd agent
so it starts at login and survives a logout.

## Security

The token is the only thing standing between a request and the machine, so:

- it is compared in constant time;
- `GET /token` answers only a browser that typed a loopback address, and only
  when no proxy header is present;
- **Cloudflare Access** can be turned on instead (`access` in `web.json`), in
  which case the JWT Access puts on every request is verified against your
  team's published keys, with the audience tag checked.

Running it behind a `cloudflared` tunnel is the intended way to reach it from
outside the machine.

## Roadmap

- Re-expose the feature backends the desktop UI used to own — the canvas
  document store, profile switching, workspace appearance — through
  `dispatch.rs` so the browser client can reach them.
- Child lifecycle management (restart a terminal whose shell exited).
- Bracketed-paste for multi-line injection.

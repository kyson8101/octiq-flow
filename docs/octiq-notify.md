# octiq-notify

`octiq-notify` is a tiny CLI that raises an **attention alert** for the octiq
terminal it runs in. Use it to make agents that do not emit their own escape
sequences (Claude Code, codex, scripts) flag their tab when they need you.

## How it works

The CLI prints an [OSC 777 "notify"](https://iterm2.com/documentation-escape-codes.html)
escape sequence to **stdout**:

```
ESC ] 777 ; notify ; <title> ; <body> BEL
```

When the command runs **inside an octiq terminal**, that stdout is the PTY.
octiq's output scanner (see `src-tauri/src/pty.rs`) reads the PTY stream, spots
the `777;notify;` sequence, and raises the `pty-attention` event for that
session. The frontend then highlights the tab. No socket, no IPC — the signal
travels through the terminal output that octiq already watches.

Outside octiq, the sequence is a harmless unknown OSC that terminals ignore.

## Usage

```bash
octiq-notify --title "Claude" --body "needs input"
octiq-notify "needs input"     # positional words become the body
octiq-notify                   # empty title, body defaults to "needs attention"
```

Options:

| Flag | Meaning |
| --- | --- |
| `-t`, `--title <t>` | Alert title (optional). |
| `-b`, `--body <b>` | Alert body (optional; defaults to `needs attention`). |
| `-h`, `--help` | Show usage. |

Notes:
- A `;` in a field is replaced with `,` (the scanner splits title/body on `;`).
- Control bytes in fields are stripped so a value cannot break the sequence.

## Build & install

The binary is a separate Cargo target under `src-tauri/src/bin/`. Cargo
auto-discovers it — no `Cargo.toml` change is needed.

```bash
# from the src-tauri/ directory
cargo build --release --bin octiq-notify
```

The compiled binary lands at `src-tauri/target/release/octiq-notify`. Put it on
your `PATH` (or call it by full path in the hook config):

```bash
# example: symlink onto PATH
ln -s "$PWD/target/release/octiq-notify" /usr/local/bin/octiq-notify
```

> Because there are now two binaries in the package (the app `octiq-flow` and
> `octiq-notify`), a bare `cargo run` is ambiguous — use `cargo run --bin octiq-notify`.
> `tauri dev` is unaffected; it builds the app target directly.

## Wire it into Claude Code hooks

Claude Code fires hooks at lifecycle points. The two that mean "the agent is
waiting for you" are **Notification** (it asked a question / needs permission)
and **Stop** (it finished its turn). Run `octiq-notify` from both.

Add to your Claude Code `settings.json` (project `.claude/settings.json` or the
global `~/.claude/settings.json`):

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "octiq-notify --title \"Claude\" --body \"needs input\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "octiq-notify --title \"Claude\" --body \"turn done\""
          }
        ]
      }
    ]
  }
}
```

The hook command runs as a child of the Claude Code process, which runs inside
the octiq terminal — so its stdout reaches the same PTY and the tab lights up.

If `octiq-notify` is not on `PATH`, use the full path:

```json
"command": "/usr/local/bin/octiq-notify --title \"Claude\" --body \"needs input\""
```

## Wire it into codex

codex supports a notify program that runs on agent events. Point it at a small
wrapper, or call `octiq-notify` directly. In `~/.codex/config.toml`:

```toml
# codex passes a JSON event argument; we just raise a generic alert.
notify = ["octiq-notify", "--title", "Codex", "--body", "needs input"]
```

If your codex version runs the notify program with the event as a positional
argument and you do not care about the payload, the command above still works —
extra positional args are ignored once `--body` is set.

For a shell-based codex hook, the same rule applies: the command must run inside
the octiq terminal, and `octiq-notify` must be on `PATH` or referenced by full
path.

---

## The notify hook: rewrite or silence an alert

Every alert OctiqFlow is about to show can first be passed through a script you
own. Use it to reword an alert, route it somewhere else, or drop the ones you do
not care about.

Put an **executable** file at `notify-hook` inside your profile directory
(Settings shows the path; by default `~/.octiqflow/profiles/default/`). Any
language — it just has to be executable.

If the file is not there, nothing changes. This is entirely opt-in.

### The protocol

OctiqFlow writes one JSON object to the hook's **stdin**:

```json
{
  "id": "proj-a:0",
  "source": "osc",
  "title": "Claude",
  "body": "needs input",
  "project": "proj-a"
}
```

| Field | Meaning |
| --- | --- |
| `id` | The terminal session that raised the alert. |
| `source` | `"osc"` — an escape sequence in the terminal output (this is what `octiq-notify` sends). `"quiet"` — the silence monitor saw an agent tab stop printing. |
| `title` / `body` | The alert text as OctiqFlow would show it. |
| `project` | The project the terminal belongs to, or `null` for a chat/utility terminal. |

The hook writes one JSON object to **stdout**. Every key is optional:

```json
{ "title": "…", "body": "…", "suppress": false }
```

- A key you leave out keeps its original value. `{}` means "show it unchanged".
- `"suppress": true` drops the alert: no tab badge, no banner, no OS
  notification.

### It can never break your alerts

The hook is best-effort, the same rule the agent capture hook follows. If it is
missing, fails to start, exits non-zero, crashes, prints something that is not
JSON, or takes longer than **2 seconds** (it is then killed), OctiqFlow shows the
**original** alert. The only way to lose an alert is for the hook to succeed and
explicitly ask for it to be suppressed.

The hook runs off the terminal's reader thread, so a slow hook never stalls the
output of the terminal that raised the alert.

### Example: shout the title, and ignore one noisy project

```sh
#!/bin/sh
# ~/.octiqflow/profiles/default/notify-hook  (chmod +x)
payload=$(cat)

case "$payload" in
  *'"project":"scratch"'*)
    printf '{"suppress":true}'          # never alert me about the scratch project
    ;;
  *)
    printf '{"title":"AGENT WAITING"}'  # keep the body, replace the title
    ;;
esac
```

For anything more than string matching, parse the payload properly — with `jq`,
or in Python:

```python
#!/usr/bin/env python3
import json, sys
alert = json.load(sys.stdin)
if alert["source"] == "quiet":
    print(json.dumps({"suppress": True}))   # only ever alert me on a real OSC
else:
    print(json.dumps({"title": alert["title"].upper()}))
```

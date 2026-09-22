# OctiqFlow

OctiqFlow is an agent workflow orchestrator: real terminals, Claude Code,
Codex, and pi.dev in one browser control plane.

## Run now

```bash
npx octiqflow
```

This starts OctiqFlow in the foreground and prints the local URL. Node.js 18+
is the only build/runtime prerequisite; the matching native server and browser
client are installed automatically for macOS arm64/x64, Linux x64, or Windows
x64.

## Install on macOS

```bash
npm install -g octiqflow
octiqflow install
```

The second command installs and starts a launchd user service, then opens the
authenticated local URL. It keeps running after the terminal closes and starts
again at login.

```bash
octiqflow status
octiqflow restart
octiqflow open
octiqflow uninstall
```

Uninstalling the service keeps profiles and transcripts under `~/.octiqflow`.
Agent CLIs are separate: install any of Claude Code, Codex, or pi.dev that you
want OctiqFlow to drive.

Project and source: <https://github.com/kyson8101/octiq-flow>

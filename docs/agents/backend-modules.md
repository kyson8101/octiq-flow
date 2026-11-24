# Backend modules

Moved verbatim from AGENTS.md on 2026-11-24.

### Backend modules (`src-tauri/src/`)

- `pty.rs` — multi-PTY sessions keyed by a **client-supplied String id**, plus
  OSC attention scanning (see Alerts). Shells are login shells (`$SHELL -l` on
  Unix, powershell on Windows; see `resolve_shell`) so `PATH` is fully
  populated — otherwise `claude` would not be found.
- `agent_chat.rs` — agents run as a JSON stream (`claude -p`, `codex exec`)
  rather than a TUI, for the chat view. All four providers are launched from
  ONE place here, through a POSIX shell, because `build_command` returns a
  POSIX-quoted line; `proc::resolve_agent_shell` picks that shell (Git for
  Windows' bash off Windows' own `PATH`). Each provider's command line and
  stream vocabulary live in `agent_provider.rs`, behind `provider_for`.
- Antigravity CLI (`agy --input-format stream-json --output-format
  stream-json`) keeps one process per chat like Claude: each turn is one NDJSON
  line on stdin, and `--conversation <id>` resumes a conversation in a new
  process. Its stdin takes no control message, so Stop ends the process and
  the next message resumes it (`interrupt_ends_process`). Its events carry an
  `event` field (`init` / `step_update` / `result`) no other provider writes;
  `result.usage` totals the whole conversation, so usage is read per model call
  off each `step_update` instead. Captured streams (agy 1.2.16) are
  `web/src/lib/__fixtures__/antigravity-*.jsonl`, shared by both test suites.
- **Antigravity cannot ask.** Headless, it refuses any call its mode would
  ask about, the refusal ends the turn, and the `result` lists it in
  `denied_actions`; nothing reaches the stream to put a card on. So Read is
  `--mode plan` (refuses even `ls` and any file write), Edits is `--mode
  accept-edits` (writes inside the project; refuses every shell command and any
  file read or write outside the project), and Auto and Full are
  `--dangerously-skip-permissions`.
  `--sandbox` was tried for Auto and refuses writes inside the project and
  git's read of `~/.gitconfig`, so Auto is unguarded and the UI says so. A
  refused turn is stamped `octiq_access`; the page fails the refused tool row
  (agy may report it as a silent success) and asks for the least level that
  lets it through — Accept edits for a project file write, Auto otherwise — on
  the access card (see **An agent asks for more access on a card**). The
  `result`'s `denied_actions` keeps every refusal of the conversation, so only
  the ones past the previous `result`'s count are this turn's. The plugin rules
  tell the model the level it runs at. PreToolUse hooks and workspace settings
  files cannot lift the refusal.
- **What OctiqFlow writes for Antigravity.** Its MCP server and host rules
  ride a plugin in a folder each launch adds with `--add-dir`:
  `~/.octiqflow/mcp/antigravity/<chat-<level>|worker-<level>|front-desk>/.agents/plugins/octiqflow/`
  (`mcp_config.json`, `rules/AGENTS.md`). The server inherits agy's
  environment, so it knows its chat. Antigravity names it `octiqflow_octiq`.
  One thing goes outside `~/.octiqflow`: the rule `mcp(octiqflow_octiq/*)` in
  `permissions.allow` of `~/.gemini/antigravity-cli/settings.json`, because a
  call through agy's generic `call_mcp_tool` is otherwise refused even in
  accept-edits, and only that file can allow it. It names a server that exists
  only in an OctiqFlow launch, so it allows nothing elsewhere. It is written
  once, order-preserving, after copying the file to
  `~/.octiqflow/mcp/antigravity/settings.json.before-octiqflow` (never
  overwritten); a failure shows in the chat and the chat still starts. To
  remove it, delete that one entry from `permissions.allow`; the next
  Antigravity chat adds it again. No `command(...)` rule is ever written.
- `workspaces.rs` — the "project" store (a project groups several folder paths).
- `disk_report.rs` — manual metadata-only disk inventory, history and downloadable cleanup scripts; [contract and kinds](../disk-report.md).
- `git.rs` — the **single** git-read backend (status summary, changed files,
  file diff). Read-only; shells out to `git`. Resolves each project path to its
  repo top-level and de-dups so one repo shows once. `git_ops.rs` holds
  everything that MUTATES a repo, so "can this touch my repo?" is answered by
  the module name alone.
- `chat_task.rs` — where a chat is and what became of its work. See **A chat's
  status is half reported, half verified** below.
- `chat_recover.rs` — puts back, or replaces, the folder of a chat whose
  worktree was removed, before its agent starts. See **A chat whose folder was
  removed is recovered before it starts** below.
- `fsbrowse.rs` — file browser listing and reads.
- `memory.rs` — what this app holds in RAM, and which chat or terminal holds it.
  One `ps` sweep, then a walk DOWN from the server's own pid, carrying the
  nearest claimed ancestor: a chat claims its pid (`ChatManager::chat_pids`), a
  terminal claims its shell's (`PtyManager::shell_pids`), so an agent's MCP
  servers land on the chat that started them however deep they sit. Nothing
  outside this process tree is counted — a `claude` running in the person's own
  Terminal is not ours to report. Cached for a few seconds so several open
  browser tabs share one sweep. Read-only; it can only ever run `ps`.
- `bin/octiq-notify.rs` — a **separate binary target** (auto-discovered from
  `src/bin/`). It prints an OSC 777 sequence to its own stdout; run inside an
  OctiqFlow terminal, the PTY scanner sees it and raises an attention alert.
  See `docs/octiq-notify.md`.
- `bin/octiq-job.rs` — `octiq-job`, the job wrapper (`job_wrapper.rs`,
  progress parsers in `job_progress.rs`). Agents reach the same code as
  `octiq-server job` through `OCTIQ_JOB`; see **Jobs** below.

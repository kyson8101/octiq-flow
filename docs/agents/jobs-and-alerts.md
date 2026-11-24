# Jobs and attention alerts

Moved verbatim from AGENTS.md on 2026-11-24.

### Jobs: long commands with real progress

An agent runs a command that takes minutes as `octiq-job --label L -- <cmd>`,
or shows a process already running with the MCP `job_register`; the page reads
`chat_jobs` and hears `chat-job` (`chat_jobs.rs`, contract in
`docs/jobs.md`). Four rules:

- **Progress is the job's own word** (`job_progress.rs`): ffmpeg's `time=`
  against its own `Duration:`, cargo's bar, Remotion's `Rendered`/`Encoded
  N/M`, a bare `N/M`, an `NN%`, or a progress file. `done` and `total` are
  sent both or neither, never from a rate. A new parser is tested on output
  recorded from the real program (`job_progress/fixtures`), never on text
  written by hand.
- **A finished job wakes its agent once**, as host turn `octiq-job-<id>`,
  asked of `agent_chat::host_turns` before every send, so a turn already
  handed over or taken back is never sent again. It queues like a message; a settled worker's job wakes
  its coordinator instead.
- **Only the start needs the launch's capability.** `progress` and `end`
  carry the job's own token, because a job outlives the agent process that
  started it. The token is memory only; a restart marks running jobs
  `interrupted` and says so in their chat.
- **The wrapper never fails the command for the host's sake**: with no hook
  environment, or a host that does not answer, it runs the command, passes
  its output through unchanged and exits with its code.
  When Codex sets `CODEX_SANDBOX_NETWORK_DISABLED=1` and the launch supplies
  a spool folder, it starts in that existing capability-scoped spool without
  first attempting the forbidden loopback connection. Full and other launches
  keep the hook-first route; a failed spool is reported, never called success.

### Attention alerts

`pty.rs` scans PTY output for OSC 9 / OSC 777 / OSC 99 (Kitty) "notify"
sequences and raises a `pty-attention` event. This is how agents that emit no
escape codes flag a terminal — run `octiq-notify` and the alert fires.

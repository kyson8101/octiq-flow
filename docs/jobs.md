# Jobs: long-running work with real progress

An agent often starts something that takes minutes: a build, an ffmpeg or
Remotion render, a batch of generated images. A **job** is such a command
made visible on its chat: what it is, how far it has got **in the job's own
words**, how it ended, and a turn that wakes the agent when it does.

Native background tasks of Claude (`background_tasks.rs`) are a different
thing: they are the provider's own, with an elapsed time and no figure.

## Two ways in

**`octiq-job`, for a new command.** The agent runs

```bash
octiq-job [--label L] [--format auto|ffmpeg|cargo|remotion|nm|percent] \
          [--progress-file P] [--no-wake] -- <cmd> [args…]
```

(`$OCTIQ_JOB` is the same launcher by its full path). The command is started
directly, never through a shell; both of its streams pass through unchanged;
`\r`-updated lines are read as the terminal would show them; SIGINT, SIGTERM,
SIGHUP and SIGQUIT are handed on to it; and `octiq-job` exits with its exit
code (128 + the signal when a signal ended it). Its last 20 lines of output
are kept for the wake turn. Outside an OctiqFlow chat, or with a host that
cannot be reached, the command runs and nothing is reported: the host is
never a reason for the command to fail.

**`job_register`, for a process already running** (MCP, `octiq-ask.cjs`):
`{ label, pid, logFile?, pattern?, progressFile?, wake? }`. The host watches
the pid once a second, reads the log from where it ended at registration with
the format named by `pattern` (one of the `--format` names, default `auto`),
and reads the progress file whenever it changes. `job_list` reads the chat's
jobs back.

### How agents reach `octiq-job`

Every agent launch is given (`chat_jobs::agent_env`):

- `OCTIQ_JOB`: `~/.octiqflow/bin/octiq-job`, a POSIX script that runs
  `<the server's own binary> job "$@"`. The server writes it when it is
  missing or names another binary, so a rebuilt or moved server points its
  agents at itself. `octiq-server job …` is the wrapper: the npm package
  ships no other binary. On Windows the script is for Git Bash (the drive
  path is written `/c/…`) and `octiq-job.cmd` beside it serves PowerShell and
  cmd.
- `PATH` with `~/.octiqflow/bin` first. A login profile that sets `PATH`
  outright can drop it; `$OCTIQ_JOB` still works.
- `OCTIQ_JOB_SESSION`: the session the launch's capability was issued to.
  Codex hides every variable whose name contains `KEY` from the commands it
  runs, `OCTIQ_CHAT_KEY` and `OCTIQ_SESSION_KEY` among them.

`src-tauri/src/bin/octiq-job.rs` builds the same wrapper as a binary of its
own, for anyone who wants it on their `PATH`.

## Progress is the job's, never an estimate

`job_progress.rs` reads, and nothing else:

| Format | What it reads | Unit |
| --- | --- | --- |
| `ffmpeg` | `time=` of a stats line, or `out_time=` of `-progress`, against the `Duration:` of ffmpeg's own header (the first input). No duration, no figure. | seconds |
| `cargo` | `Building [=====>  ] N/M: …`. Cargo draws its bar into a pipe only with `CARGO_TERM_PROGRESS_WHEN=always`, which `octiq-job` sets (with a width of 80) for a cargo child that has not set it. | crates |
| `remotion` | the CLI's piped output: `Bundling NN%`, `Rendered N/M`, `Encoded N/M`, each its own phase. | percent, frames |
| `nm` | a bare count `N/M`, never a date, a path or a rate. | items |
| `percent` | the last `NN%` or `NN.N%` of a line. | percent |
| progress file | `{"done":3,"total":8,"phase":"Generating","unit":"items"}`, rewritten whole; a file caught half-written says nothing. This is the image-generation path: the batch script writes it. | `unit`, default items |

`auto` (the default) knows ffmpeg by its header and otherwise takes the
first format that recognises a line, then keeps to it: the percentages in
ffmpeg's closing x264 statistics are never read as progress. A job sends
`done` and `total` only when it gave both; the host refuses anything else
(`chat_jobs::checked`).

The parsers are tested on output recorded from the real programs, kept
verbatim in `src-tauri/src/job_progress/fixtures/` (ffmpeg 9.0.1, cargo 1.96,
Remotion CLI 4.0.536 rendering a 90-frame composition, curl 8 `-#`, the `sh`
loop of the live check). Re-record them; never hand-edit. Remotion on a
terminal redraws with cursor moves instead; `octiq-job` always gives it a
pipe, so that form is not read.

## The contract (shared with the page)

```ts
type Job = {
  id: string; chatKey: string; label: string;
  source: "wrapper" | "registered";
  status: "running" | "done" | "failed" | "ended" | "interrupted";
  phase?: string;
  done?: number; total?: number;          // both or neither, the job's own
  unit?: "frames" | "seconds" | "items" | "percent" | "crates";
  exitCode?: number | null;               // absent while running
  elapsedMs: number; sinceUpdateMs: number; // as of the moment the host sends
  command?: string;                       // the wrapped argv, shell-quoted
  wake: boolean;
  reason?: string;                        // ended, interrupted
};
```

- `done`: exit code 0. `failed`: any other exit code, or a signal (then
  `exitCode` is `null`).
- `ended`: a registered pid that is not the host's child exited; its exit
  code is unknown (`null`).
- `interrupted`: the server restarted while the job ran, or the wrapper went
  without reporting an end (killed, or it could not reach the host). The
  command may still be running; `reason` says which.
- `elapsedMs` and `sinceUpdateMs` are measured on the host's clock and sent
  as durations; the page counts on from receipt on its own clock and never
  compares a host time with its own.
- Bus event **`chat-job`** `{ chatKey, job }`: on start, on progress (at most
  twice a second per job: what the throttle held back is said on the
  watcher's next pass), and on end.
- Socket command **`chat_jobs { chatKey? }`** → `{ jobs: Job[] }`, newest
  first: one chat's jobs, or with no `chatKey` every chat's running jobs and
  those that ended in the last ten minutes (the page's worker rows).
- Chat event **`octiq_job_interrupted`** `{ job_ids, message }`: written into
  each chat whose jobs a restart interrupted.

## The hook

`POST /hook/job` `{ sessionKey, chatKey?, action, args }`:

- `start` (`octiq-job`), `register` and `list` take the launch's capability
  (`x-octiq-chat-capability`) and act for the chat it proves. A front desk is
  refused; a worker may keep jobs of its own. `start` answers `{ id, token,
  job }`.
- `progress` and `end` take the job's `id` and `token` alone. A job outlives
  the agent process that started it (a Stop, a model switch, a one-shot
  provider's turn) and that process's capability with it; the token speaks
  for its one job. It is held in memory and never written to the jobs file.
- A chat may have 32 jobs running at once. A job is not started while the
  profile folder is away (its record could not be kept).

## The wake turn

When a job with `wake` ends, the host hands the chat's agent **one** host
turn under the id `octiq-job-<jobId>`: the label, how it ended and its exit
code, how long it took, the command or log, the reason, and the last lines
of output (wrapper) as a fenced block, then a line saying it is a host
notification and not the person's instruction.

**Its first line is for the page**, so it can name the job after `chat_jobs`
no longer holds it (ten minutes after it ended, or after a reload): the tag
`[OctiqFlow job ended]`, ONE space, then one line of JSON made by
`serde_json` with exactly these four keys in this order (`chat_jobs::
wake_facts`):

```text
[OctiqFlow job ended] {"id":"<jobId>","label":"<label>","status":"done|failed|ended|interrupted","exitCode":<n>|null}
```

`exitCode` is `null` wherever the job has none (ended, interrupted, killed
by a signal). The label is the stored one, which the host already made one
line; a newline or quote is escaped by `serde_json` in any case, so the JSON
never spans lines. Everything from the second line on is the readable text
above and has no fixed form. For example:

```text
[OctiqFlow job ended] {"id":"06264a51017846c0acb3fac3d11db852","label":"render · \"final\" cut","status":"failed","exitCode":1}
The job "render · "final" cut" failed: exit code 1, after 2m 14s.
```

- **Told once** (AGENTS.md, *A chat's plan*): before it sends, the host asks
  the chat's record what became of that id (`agent_chat::host_turns`, with
  the turns this server handed over itself as `here`). A turn that is there,
  handed over or taken back, is never sent again, across a restart too. A
  record that cannot be read is not a turn never sent: the wake waits.
- It waits like any message (`agent_chat::wake_chat` → `send_turn`): written
  between turns, queued behind a running turn, a Stop's owed full stop, or
  anything queued, and never written to a session that owes a full stop.
- A chat with no process is started with it as its first message, from the
  settings the chat last ran with in this server. A chat this server has not
  run yet is woken once it runs again (the watcher tries every second); its
  job's end is on the page meanwhile.
- A worker whose attempt has settled is not woken: its coordinator's chat is,
  with the task named (`chat_jobs::wake_target`).
- The wake's state (`wakeTurn`: `none`, `owed`, `told`) is saved with the
  job, so a wake owed when the server stopped is handed over after it starts.
- The page draws the turn as a user bubble until it knows the prefix (FE's
  half).

## Store and limits

- `<chats dir>/jobs.json` (`chat_jobs.rs`), read with `profile::read`,
  written whole through `profile::make_dir`. A save that fails is said
  `unsaved` and owed (`jobs` in `profile_status.owed`); a file that could not
  be read is never written over. Ended jobs are dropped a week after they
  ended, once their wake is told.
- A running job keeps its chat off the idle reaper, like native background
  work.
- **A restart interrupts.** The wrapper's token and the pid watch are in
  memory, so every job still running at load is marked `interrupted` and its
  chat is told. A wrapper still running after a restart goes on running its
  command; its reports are refused.
- **A registered pid's exit code is unknown**, and a pid can be reused by
  another process after it exits. On Windows give the Windows PID, not Git
  Bash's `$!` (read `/proc/$!/winpid`).
- **Codex's MCP `image_generation` call has no process and is not covered.**
  A batch script that writes a progress file is.
- On Windows the wrapper hands on no signal: a console's Ctrl-C reaches the
  command as it reaches the wrapper.

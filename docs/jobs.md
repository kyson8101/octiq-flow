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
          [--progress-file P] [--no-wake] [--detach] -- <cmd> [args…]
```

(`$OCTIQ_JOB` is the same launcher by its full path). The command is started
directly, never through a shell; both of its streams pass through unchanged;
`\r`-updated lines are read as the terminal would show them; SIGINT, SIGTERM,
SIGHUP and SIGQUIT are handed on to it, except one the wrapper was started
with ignored (`nohup`'s SIGHUP, SIGINT and SIGQUIT under a shell's `&`),
which stays ignored; and `octiq-job` exits with its exit code (128 + the
signal when a signal ended it). Its last 20 lines of output are kept for the
wake turn. Outside an OctiqFlow chat, or with a host that cannot be reached,
the command runs and nothing is reported: the host is never a reason for the
command to fail.

### Running a job that outlives the tool call: `--detach`

```bash
octiq-job --detach --label "render" -- npx remotion render … > render.log 2>&1
```

Run in the foreground, with no `&`. `--detach` starts the wrapper again in a
session of its own (Windows: a process group with no console), with no
input and this output, waits until the chat knows of the job (at most 10 s),
says so on stderr (`octiq-job: job <id> runs in the background (pid N) …`),
and exits 0; a command that cannot start gives its own code (127). The job
then runs on whatever happens to the shell, the tool call and the agent's
process, and its end wakes the agent as usual. Redirect its output to a
file: the first lines of that file say what became of the start.

**Do not background `octiq-job` with `&` or `nohup` in a Codex chat.**
Codex ends the whole process group of a shell command with SIGKILL the
moment the command's shell exits. Measured on 2026-10-17 (codex-cli 0.162.1,
app-server and `codex exec`, Auto and Full): `octiq-job … &` and
`nohup octiq-job … &` were killed before their first line and left no job
and an empty log; nothing can catch or ignore that signal. Claude Code
(2.1.301) leaves both alive, and its Bash `run_in_background` runs
`octiq-job` fine, but `--detach` is the one form that holds in both.

**Codex at Edits or Auto cannot reach the host from a command, and reports
through its spool folder instead** (see The spool folder, below). At Read it
can do neither: the chat is not told of the job. The MCP tools run outside
the sandbox, so at Read register the running wrapper instead: `job_register`
with the pid `--detach` printed and `logFile` (progress is read from the
log; the exit code is not known). At Full the sandbox is off and
`octiq-job` reports over the hook.

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
- `OCTIQ_JOB_SPOOL` and `OCTIQ_JOB_SPOOL_CAPABILITY`: the launch's spool
  folder and its secret (The spool folder). Not given to a front desk.

`src-tauri/src/bin/octiq-job.rs` builds the same wrapper as a binary of its
own, for anyone who wants it on their `PATH`.

## The spool folder: a chat whose commands cannot reach the host

Codex below Full runs its commands in a sandbox that refuses a connection
to `127.0.0.1` (`Operation not permitted`), so `octiq-job` there cannot call
`/hook/job`. Turning on the sandbox's network access would let it, and is
not done: it is a widening of what the agent may do. Instead each chat
launch is given (`job_spool.rs`):

- `OCTIQ_JOB_SPOOL`: a folder of its own,
  `$TMPDIR/octiqflow-job-spool-<uid>/<server pid>-<id>/`, made through
  `profile::create_dir_all`, mode 0700, in a root that must be a real folder
  owned by the same user (a link, or another user's folder, gives no spool).
  The temp folder is the place Codex's `workspace-write` sandbox can write
  that git never sees: the workspace can be written too, but `.git/` cannot
  (measured with codex-cli 0.162.1: `$TMPDIR`, `/tmp` and the workspace
  writable at Edits and Auto; `.git/` and `~/.octiqflow` refused; nothing at
  all writable at Read).
- `OCTIQ_JOB_SPOOL_CAPABILITY`: a secret for that launch, held by the host in
  memory (a digest) and never written to the profile. Its name has no KEY,
  SECRET or TOKEN in it, which Codex's environment filter can keep from its
  commands.

**The wrapper tries the hook first.** Only when the call cannot connect
(connection failed, or the address cannot be resolved) and `OCTIQ_JOB_SPOOL`
is set does it switch to the spool, for the rest of that job. A host that
answers, a refusal included, is not a reason to: its word stands. It writes
append-only NDJSON to `<spool>/<its own id>.ndjson`, made with `O_EXCL` and
mode 0600, one whole line in one `O_APPEND` write per record: `start` (as
the hook's), `progress` (the same throttle, at most twice a second) and
`end`, **with the real exit code**, which `job_register` cannot know. Every
record carries the secret as `key`. Output, signals and the exit code are as
over the hook; a spool write that fails ends the spool for that job and
never the command.

**`--detach` in the spool** waits for the host's answer to the start: after
it reads a start the host writes `<id>.ack` (`{"id": <host job id>}`, or
`{"why": …}` for a refusal) under a temporary name and renames it. The
supervisor waits up to 5 s beside the command (its output never waits), and
the line on stderr gives the host's job id as over the hook. Not answered in
time, it says the chat has not confirmed the job yet.

**The host reads each folder once a second**, on the job watcher's own tick,
before its pid look, so a wrapper's end in its file is read before its going
could be taken for an interruption. What it reads goes to the same store
calls as the hook (`chat_jobs::Store::start_spooled`, `spooled_progress`,
`spooled_end`), so `chat-job`, `chat_jobs`, the idle reaper's hold, the wake
told once and a restart's `interrupted` are shared, not repeated.

- **The chat is the secret's**, never the folder's or the file's name. A
  record with no `key`, a wrong one or another launch's is refused, changes
  nothing, and is logged once for its file.
- **Everything in a file is untrusted.** Only plain files named
  `<32 hex>.ndjson` are opened (no links, no pipes), at most 64 a folder, at
  most 256 KB of a file a pass. A line longer than 64 KB is skipped to its
  newline; a malformed line, or one of no known type, is skipped; a last line
  with no newline yet is waited for. The store makes a label one line and
  bounds every text as it does for the hook.
- **A spool job never meets a hook job.** The id in a file names the file
  only: the host gives the job an id of its own, and the job has no hook
  token, so nothing over `/hook/job` can speak for it. A second start in a
  file is ignored, and an end is taken once.
- **The wrapper's pid is asked before the file is read.** Dead before the
  read, and the file read to its end with no end in it, the job is
  `interrupted`; the pid watch leaves spooled jobs to the reader.
- **Files and folders go.** A file goes once its end is taken and the jobs
  file has saved it (a refused start's at once); its `.ack` 15 s after it was
  written. A launch's folder and secret go once its process is gone and
  nothing in the folder is left unread. A file the host cannot read is not
  "no events": it stays, is read again each pass, and keeps its folder. A
  server that starts removes the folders of servers that are gone (by the
  pid in the folder's name) and leaves a live one's alone.
- **A restart.** The secrets are in memory: the jobs a spool reported are
  interrupted with every other at load, and what their wrappers write next
  is never read.

| Agent and level | How `octiq-job` reports |
| --- | --- |
| Claude Code, any level | the hook |
| Codex Full | the hook (no sandbox) |
| Codex Auto, Edits | the spool folder |
| Codex Read | nothing: the sandbox writes nowhere. `job_register` (MCP) for a pid and log |

Limits: a file grows by about 150 bytes a progress report for as long as the
job runs (about 1 MB an hour), and is removed at its end. Another process of
the same user can read the secret from the agent's environment, as it can
the hook's capability. On Windows the folder is under `%TEMP%` and no owner
check is made.

## Progress is the job's, never an estimate

`job_progress.rs` reads, and nothing else:

| Format | What it reads | Unit |
| --- | --- | --- |
| `ffmpeg` | `time=` of a stats line, or `out_time=` of `-progress`, against the `Duration:` of ffmpeg's own header (the first input). No duration, no figure: a first input that says `Duration: N/A` gives none, whatever a later input's header says. | seconds |
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
  those that ended in the last ten minutes (the page's worker rows). An
  error, never `[]`, when the jobs file could not be read (Store and limits).
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
  `unsaved` and owed (`jobs` in `profile_status.owed`). **A file that could
  not be read at load is never an empty store, and is never written over**:
  `chat_jobs`, the hook's `list`, `start` and `register` answer an error in
  words (`OctiqFlow could not read its jobs file when it started, …`) until
  the server is restarted with a file it can read. The wrapper's command runs
  all the same (a refused start reports nothing). Ended jobs are dropped a
  week after they ended, once their wake is told.
- **The wake's receipt is the chat's record, read strictly**
  (`transcript::every_line`, under `agent_chat::host_turns` and a send's
  `durable_user_turn_exists`): no record file is an empty record, and a
  record file that cannot be read is an error, so its wake stays owed and is
  asked again on the watcher's next pass. It was read as empty and handed
  over a second time. The plan's Start shares the reader: a `Tell the agent`
  asked while the record cannot be read is refused in words and sends
  nothing.
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

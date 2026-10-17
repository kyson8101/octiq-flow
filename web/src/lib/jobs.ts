// Long-running jobs an agent registered with the host: a build, a render, an
// image generation. The agent starts one through the `octiq-job` wrapper or
// the `job_register` MCP tool; the host keeps it (`chat-job` on the bus,
// `chat_jobs` on the socket) and wakes the agent with a turn of its own when
// the job ends (`octiq-job-<jobId>`).
//
// This is the page's whole reading of them, and it is pure: what the page
// holds, how a read and an event combine, what a job says on one line, which
// tool card started it, and what the wake turn is called. The socket glue is
// `lib/jobFeed`.
//
// Two rules hold everything here:
//
//   * Progress is the JOB's. `done` and `total` come from the job itself and
//     a percent is drawn only when both are numbers and `total` is above
//     zero. Nothing is estimated from elapsed time, and absent draws nothing.
//   * One clock. `elapsedMs` and `sinceUpdateMs` are the host's, as of its
//     send. The page counts on from the moment it RECEIVED them, on its own
//     clock, and never compares a host time with `Date.now()`.

import type { Message } from "./chat";

export type JobStatus = "running" | "done" | "failed" | "ended" | "interrupted";
export type JobUnit = "frames" | "seconds" | "items" | "percent" | "crates";

/** One job, as the host sends it. */
export type Job = {
  id: string;
  chatKey: string;
  label: string;
  source: "wrapper" | "registered";
  status: JobStatus;
  phase?: string;
  done?: number;
  total?: number;
  unit?: JobUnit;
  exitCode?: number | null;
  /** How long it has run, as of the host's send. */
  elapsedMs: number;
  /** How long since the job last said anything, as of the host's send. */
  sinceUpdateMs: number;
  command?: string;
  wake: boolean;
  reason?: string;
};

/** A job as this page holds it: the host's record, the moment it arrived on
 *  this page's clock, and the revision it was applied at. */
export type HeldJob = { job: Job; receivedAt: number; rev: number };

/** Every job the page knows of, by id. `rev` counts what was applied, so a
 *  read that was in the air when an event landed cannot put the older job
 *  back (`applyRead`). */
export type JobsState = { rev: number; jobs: ReadonlyMap<string, HeldJob> };

export const NO_JOBS: JobsState = { rev: 0, jobs: new Map() };

/** A job that has said nothing for this long is drawn muted: still running
 *  as far as the host knows, but nothing on screen claims it is moving. */
export const JOB_STALE_MS = 10 * 60_000;

const STATUSES: ReadonlySet<string> = new Set(["running", "done", "failed", "ended", "interrupted"]);
const UNITS: ReadonlySet<string> = new Set(["frames", "seconds", "items", "percent", "crates"]);

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** A job from the wire, or null for anything that is not one. Fields the
 *  contract makes optional are dropped when they are the wrong type, never
 *  coerced: a `done` of `"12"` is no progress, not twelve. */
export function readJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id);
  const chatKey = text(r.chatKey);
  const status = typeof r.status === "string" && STATUSES.has(r.status) ? (r.status as JobStatus) : undefined;
  const elapsedMs = num(r.elapsedMs);
  const sinceUpdateMs = num(r.sinceUpdateMs);
  if (!id || !chatKey || !status || elapsedMs === undefined || sinceUpdateMs === undefined) return null;
  const job: Job = {
    id,
    chatKey,
    label: text(r.label) ?? "job",
    source: r.source === "registered" ? "registered" : "wrapper",
    status,
    elapsedMs: Math.max(0, elapsedMs),
    sinceUpdateMs: Math.max(0, sinceUpdateMs),
    wake: r.wake === true,
  };
  const phase = text(r.phase);
  if (phase) job.phase = phase;
  const done = num(r.done);
  if (done !== undefined) job.done = done;
  const total = num(r.total);
  if (total !== undefined) job.total = total;
  if (typeof r.unit === "string" && UNITS.has(r.unit)) job.unit = r.unit as JobUnit;
  if (r.exitCode === null) job.exitCode = null;
  else if (num(r.exitCode) !== undefined) job.exitCode = r.exitCode as number;
  const command = text(r.command);
  if (command) job.command = command;
  const reason = text(r.reason);
  if (reason) job.reason = reason;
  return job;
}

/** A `chat-job` event: the job it carries replaces the one held. */
export function applyJobEvent(state: JobsState, payload: unknown, now: number): JobsState {
  const job = readJob((payload as { job?: unknown } | null)?.job);
  if (!job) return state;
  const rev = state.rev + 1;
  const jobs = new Map(state.jobs);
  jobs.set(job.id, { job, receivedAt: now, rev });
  return { rev, jobs };
}

/** What a read answered, and what it was asked for. `asked` is the state's
 *  `rev` when the read was sent. `chatKey` is the chat it was scoped to; a
 *  read with none covers every chat. */
export type JobsRead = { jobs: unknown; asked: number; chatKey?: string };

/** A `chat_jobs` answer. It replaces what it covers, but a job an event
 *  touched after the read was asked keeps the event's version: the read was
 *  answered before that event and is older than it. A job the read leaves
 *  out is dropped the same way, unless an event spoke of it since. */
export function applyJobsRead(state: JobsState, read: JobsRead, now: number): JobsState {
  const list = Array.isArray(read.jobs) ? read.jobs : [];
  const covers = (job: Job) => !read.chatKey || job.chatKey === read.chatKey;
  const jobs = new Map<string, HeldJob>();
  for (const [id, held] of state.jobs) {
    if (!covers(held.job) || held.rev > read.asked) jobs.set(id, held);
  }
  for (const raw of list) {
    const job = readJob(raw);
    if (!job || !covers(job)) continue;
    const newer = jobs.get(job.id);
    if (newer && newer.rev > read.asked) continue;
    jobs.set(job.id, { job, receivedAt: now, rev: read.asked });
  }
  return { rev: state.rev, jobs };
}

/** The job's own percent, or null when it did not say how far it is. Floored,
 *  so a job at 99.6 of 100 is not drawn finished. */
export function percent(job: Pick<Job, "done" | "total">): number | null {
  const { done, total } = job;
  if (typeof done !== "number" || typeof total !== "number" || !(total > 0)) return null;
  return Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
}

/** How long a held job has run, counted on from when it arrived. An ended
 *  job's time stopped where the host said it did. */
export function elapsedOf(held: HeldJob, now: number): number {
  return held.job.status === "running"
    ? held.job.elapsedMs + Math.max(0, now - held.receivedAt)
    : held.job.elapsedMs;
}

/** True when a running job has said nothing for `JOB_STALE_MS`. */
export function isStale(held: HeldJob, now: number): boolean {
  return held.job.status === "running"
    && held.job.sinceUpdateMs + Math.max(0, now - held.receivedAt) > JOB_STALE_MS;
}

/** The running jobs of one chat, oldest first. */
export function runningJobs(state: JobsState, chatKey: string): HeldJob[] {
  const out: HeldJob[] = [];
  for (const held of state.jobs.values()) {
    if (held.job.chatKey === chatKey && held.job.status === "running") out.push(held);
  }
  return out.sort((a, b) => startedAt(a) - startedAt(b));
}

/** When a job started, on this page's clock: the moment it arrived less
 *  what it had run by then. Never a host time. */
export function startedAt(held: HeldJob): number {
  return held.receivedAt - held.job.elapsedMs;
}

/** What a job says on a line. `percent` and `elapsedMs` never both lead:
 *  a job that says how far it is shows that, one that does not shows how
 *  long it has run. */
export type JobLine = {
  id: string;
  label: string;
  phase: string | null;
  percent: number | null;
  elapsedMs: number;
  stale: boolean;
  /** The tooltip: the label, the phase, the job's own count with its unit,
   *  and how long since it last said anything when that is long. */
  title: string;
};

const UNIT_WORD: Record<JobUnit, string> = {
  frames: "frames", seconds: "seconds", items: "items", percent: "%", crates: "crates",
};

export function jobLine(held: HeldJob, now: number): JobLine {
  const { job } = held;
  const stale = isStale(held, now);
  const pct = percent(job);
  const count = typeof job.done === "number" && typeof job.total === "number" && job.total > 0
    ? job.unit === "percent" ? `${job.done}%` : `${job.done} of ${job.total}${job.unit ? ` ${UNIT_WORD[job.unit]}` : ""}`
    : typeof job.done === "number" && job.unit && job.unit !== "percent" ? `${job.done} ${UNIT_WORD[job.unit]}` : null;
  const quiet = job.sinceUpdateMs + Math.max(0, now - held.receivedAt);
  return {
    id: job.id,
    label: job.label,
    phase: job.phase ?? null,
    percent: pct,
    elapsedMs: elapsedOf(held, now),
    stale,
    title: [
      [job.label, job.phase].filter(Boolean).join(" · "),
      count,
      stale ? `No update for ${Math.floor(quiet / 60_000)} minutes` : null,
    ].filter(Boolean).join("\n"),
  };
}

/** What a worker's row says of its running job, on its one line: what the
 *  job is doing and how far it is (`Encoding · 60%`), or what it is and how
 *  long it has run when it gave no count. */
export function jobRowNote(line: JobLine, elapsed: (ms: number) => string): string {
  return line.percent !== null
    ? `${line.phase ?? line.label} · ${line.percent}%`
    : `${line.label} · ${elapsed(line.elapsedMs)}`;
}

// ---- Which tool card started a job -----------------------------------------

/** A tool card, as far as matching a job needs: its call id and the command
 *  it ran, when it ran one. */
export type CallCommand = { id: string; command: string };

/** The command a tool call ran, from its arguments: `command` as a string or
 *  an argv list, else `cmd`. Empty for a call that ran none. */
export function commandOfArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as { command?: unknown; cmd?: unknown };
  for (const value of [a.command, a.cmd]) {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  }
  return "";
}

/** Every tool call of a transcript that ran a command, for `jobCalls`. */
export function callCommands(messages: readonly Pick<Message, "blocks">[]): CallCommand[] {
  const out: CallCommand[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind !== "tool") continue;
      const command = commandOfArgs(block.args);
      if (command) out.push({ id: block.id, command });
    }
  }
  return out;
}

/** What `jobCalls` depends on, as one string: the running jobs and the words
 *  they are matched by. It changes when a job starts or ends, never when one
 *  moves, so a surface that matches can key on it. */
export function runningSignature(state: JobsState): string {
  const parts: string[] = [];
  for (const held of state.jobs.values()) {
    if (held.job.status === "running") parts.push(`${held.job.id}\u0000${held.job.chatKey}\u0000${held.job.command ?? ""}\u0000${held.job.label}`);
  }
  return parts.sort().join("\u0001");
}

/** Quotes and runs of white space say nothing about which command it was. */
const flat = (value: string) => value.replace(/["'`]/g, "").replace(/\s+/g, " ").trim();

/** The card each running job was started from, by call id.
 *
 *  A card is a job's when its command runs `octiq-job` and holds the job's
 *  command, or its label when the job names no command. A job is given a
 *  card only when exactly ONE card matches it, and a card is given only when
 *  exactly one job matches it. Anything else marks none: marking the wrong
 *  card as still going is worse than marking none, and the strip says the
 *  job either way (the same rule as `background.backgroundCalls`). */
export function jobCalls(calls: readonly CallCommand[], jobs: readonly HeldJob[]): Map<string, HeldJob> {
  const out = new Map<string, HeldJob>();
  if (jobs.length === 0) return out;
  const wrapped = calls
    .map((call) => ({ id: call.id, command: flat(call.command) }))
    .filter((call) => /(^|[\s/;&|(])octiq-job(\s|$)/.test(call.command));
  if (wrapped.length === 0) return out;
  const byCard = new Map<string, HeldJob[]>();
  for (const held of jobs) {
    if (held.job.status !== "running") continue;
    const needle = flat(held.job.command ?? held.job.label);
    if (!needle) continue;
    const matches = wrapped.filter((call) => call.command.includes(needle));
    if (matches.length !== 1) continue;
    const list = byCard.get(matches[0].id) ?? [];
    list.push(held);
    byCard.set(matches[0].id, list);
  }
  for (const [id, list] of byCard) if (list.length === 1) out.set(id, list[0]);
  return out;
}

/** What a card's background chip says: `in background · 42%`, or the plain
 *  words when the job did not say how far it is. */
export function backgroundChip(job: Pick<Job, "done" | "total">): string {
  const pct = percent(job);
  return pct === null ? "in background" : `in background · ${pct}%`;
}

// ---- The wake turn ---------------------------------------------------------

/** The host's own turn to the agent when a job ended. No person's turn id
 *  starts with it. */
export const JOB_TURN_PREFIX = "octiq-job-";

/** What the conversation map calls the wake turn. */
export const JOB_TURN_LABEL = "Job ended";

export function isJobTurn(turnId?: string | null): boolean {
  return typeof turnId === "string" && turnId.startsWith(JOB_TURN_PREFIX);
}

/** The job a wake turn is about. */
export function jobIdOfTurn(turnId: string): string {
  return turnId.slice(JOB_TURN_PREFIX.length);
}

const ENDED_LABEL: Record<JobStatus, string> = {
  running: "Job ended",
  done: "Job finished",
  failed: "Job failed",
  ended: "Job ended",
  interrupted: "Job interrupted",
};

/** The host's sentence for jobs a restart interrupted
 *  (`octiq_job_interrupted`, `chat_jobs.rs`), read for its count. */
export function interruptedJobs(text: string): { count: number; labels: string } | null {
  const match = /^OctiqFlow restarted while (\d+) job\(s\) ran and can no longer follow them: (.+?)\. Check their output/i.exec(text);
  return match ? { count: Number(match[1]), labels: match[2] } : null;
}

/** The tag the host's wake turn opens with (`chat_jobs.rs`). */
export const WAKE_TAG = "[OctiqFlow job ended]";

const ENDED: ReadonlySet<string> = new Set(["done", "failed", "ended", "interrupted"]);

/** What the wake turn's first line says of its job. */
export type WakeLine = {
  id: string;
  label: string;
  status: Exclude<JobStatus, "running">;
  exitCode: number | null;
};

/** The job a wake turn's own first line names, or null. The host writes it
 *  as the tag, one space and one single-line JSON object with `id`, `label`,
 *  `status` and `exitCode`; the words for the agent follow from line 2.
 *  Anything else is null: a line that is not that shape, a key missing or
 *  of the wrong type, a status a job does not end with. An older host's
 *  text (the tag on a line of its own, then prose) is null too. Nothing is
 *  read out of the prose, and nothing here throws. Keys beyond the four are
 *  ignored. */
export function wakeLine(said: unknown): WakeLine | null {
  if (typeof said !== "string") return null;
  const end = said.indexOf("\n");
  const first = (end < 0 ? said : said.slice(0, end)).replace(/\r$/, "");
  if (!first.startsWith(`${WAKE_TAG} {`)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(first.slice(WAKE_TAG.length + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id);
  const label = text(r.label);
  const status = typeof r.status === "string" && ENDED.has(r.status) ? (r.status as WakeLine["status"]) : undefined;
  const exitCode = r.exitCode === null ? null
    : typeof r.exitCode === "number" && Number.isInteger(r.exitCode) ? r.exitCode : undefined;
  if (!id || !label || !status || exitCode === undefined) return null;
  return { id, label, status, exitCode };
}

/** What the wake turn's bubble says in place of the host's text: how the job
 *  ended and which job. From the job the page holds; else from the turn's
 *  own first line (`wakeLine`), when it names this very turn's job; else
 *  `Job ended` alone. Nothing is read out of the host's prose. */
export function jobTurnBubble(
  message: { turnId?: string | null },
  job: Job | undefined,
  turnText?: string,
): { label: string; detail: string } | null {
  if (!isJobTurn(message.turnId)) return null;
  const line = job ? undefined : wakeLine(turnText);
  const said = job ?? (line && line.id === jobIdOfTurn(message.turnId!) ? line : undefined);
  if (!said) return { label: ENDED_LABEL.ended, detail: "" };
  // `exitCode` is absent while a job runs, and `null` once it ended with
  // none to give: a registered pid's end, an interruption, a wrapper killed
  // by a signal. Null is said as that, never as "exit null".
  const exit = typeof said.exitCode === "number" ? `exit ${said.exitCode}`
    : said.exitCode === null ? "no exit code" : null;
  return { label: ENDED_LABEL[said.status], detail: [said.label, exit].filter(Boolean).join(" · ") };
}

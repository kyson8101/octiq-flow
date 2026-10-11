// How far a run has got: one line above the composer, and the Agents panel
// it opens.
//
// Everything here is read off the ledger the host sends. Nothing is
// estimated: a figure the host did not send is `null`, and what draws it
// leaves that part out. A zero is left out the same way, so neither surface
// ever fills up with "0 failed · 0 working".
//
// Words come from two places only: a task's title, and the host's own label
// for what a task is waiting on. A worker's free text (the step it says it is
// on, its summary, a path, a commit) is never a row's default line; it stays
// behind the row's disclosure.
import {
  attemptIsExecuting, currentAttempt, EXECUTION_LABELS, executionNeedsAttention, proposedReportState, runElapsed,
  taskElapsed, taskStepSummary,
} from "./agentTaskBoard";
import type {
  AttemptUsage, OrchestrationAttempt, OrchestrationRun, OrchestrationSnapshot, OrchestrationTask,
} from "./orchestration";
import { NO_WAITS, runWaits, UNSAID_NOTE, type RunWaits, type WaitKind, type Waiting, type Waits } from "./runWaits";

export type { Waiting } from "./runWaits";

/** The four things the strip can say. */
export type StripState = "running" | "needs" | "done" | "failed";

/** Where one task is. `needs` is a wait that is the person's and nothing
 *  else (`lib/runWaits`). `failed` is a task that failed, one that is blocked
 *  with no decision open, or a check whose verdict is fail. `closed` is a
 *  task nothing is owed for and that did not finish: cancelled, replaced, or
 *  left behind by a stopped run. */
export type RowState = "needs" | "failed" | "running" | "done" | "planned" | "closed";

export type GroupKey = "needs" | "running" | "finished" | "planned";

/** The order the panel draws them in. */
export const GROUP_ORDER: readonly GroupKey[] = ["needs", "running", "finished", "planned"];

export const GROUP_LABEL: Record<GroupKey, string> = {
  needs: "Needs you", running: "Running", finished: "Finished", planned: "Planned",
};

/** Finished is history: folded, with its count. The rest are open. */
export const GROUP_FOLDED: Record<GroupKey, boolean> = {
  needs: false, running: false, finished: true, planned: false,
};

/** How many rows a long, quiet group shows before "N more". The groups that
 *  ask for something or are moving always show every row. */
export const GROUP_SHOWN: Record<GroupKey, number> = {
  needs: Infinity, running: Infinity, finished: 3, planned: 3,
};

export type ProgressRow = {
  task: OrchestrationTask;
  attempt?: OrchestrationAttempt;
  state: RowState;
  group: GroupKey;
  /** The host's word for what the row waits on or what went wrong. */
  why: string | null;
  tone: "decide" | "danger" | "warn" | null;
  /** Its worker has a turn in flight. The only rows the accent is on. */
  flight: boolean;
  /** How many decisions of this task wait on the person: cards and gates,
   *  once each. Zero for every row that is not under Needs you. */
  decisions: number;
  /** What the row's tooltip adds: a wait the host put no name to. */
  hint: string | null;
  /** The worker's checklist as counts. Its words are not on the row. */
  steps: { done: number; total: number } | null;
  /** The thin bar. `null` draws none: nothing was reported to draw. */
  percent: number | null;
  model: string | null;
  effort: string | null;
  /** A planned task: the titles of the tasks it still waits for. */
  after: string[];
  /** A check's own answer, once it has one. */
  verdict: "pass" | "fail" | null;
  elapsedMs: number | null;
  tokens: number | null;
  /** Percent of the context window, for a worker that is live. */
  context: number | null;
};

export type ProgressGroup = { key: GroupKey; label: string; rows: ProgressRow[] };

export type StripSide = { text: string; strong: boolean };

export type RunStrip = {
  state: StripState;
  word: string;
  done: number;
  total: number;
  percent: number;
  /** "Tasks 13/22", or "Done · 22/22". */
  label: string;
  /** At most two, most urgent first. */
  side: StripSide[];
  /** A turn is in flight: at least one attempt of the run is executing. The
   *  texture over the part still to do moves, and the accent is on, only
   *  then. A run that is all planned, or whose only worker has stalled, is
   *  still "Running" and is drawn still. */
  live: boolean;
  /** Decisions waiting on the person, once each (`lib/runWaits`). */
  needs: number;
  /** The only thing waiting on the person is the plan. */
  planOnly: boolean;
  failed: number;
  /** Attempts with a turn in flight. */
  working: number;
  /** The live runs of the chat this line stands for. One, unless the chat
   *  coordinates several (`chatStrip`). */
  runs: number;
  /** What the tooltip adds, in whole sentences: waits that are not the
   *  person's. Never drawn on the line. */
  notes: string[];
  /** What a dismissal is remembered against: the strip comes back when any
   *  of this changes, and not because a worker started or stopped. */
  signature: string;
};

export type RunTiles = {
  tasks: { done: number; total: number };
  /** `null`: the host sent no usage for any attempt of the run. */
  tokens: number | null;
  /** `null`: nothing was ever dispatched. */
  elapsedMs: number | null;
};

export type RunProgress = {
  rows: ProgressRow[];
  groups: ProgressGroup[];
  tiles: RunTiles;
  strip: RunStrip | null;
};

export const STRIP_WORD: Record<StripState, string> = {
  running: "Running", needs: "Needs you", done: "Done", failed: "Failed",
};

const ACTIVE_RUN = new Set(["planning", "running", "waiting"]);

/* ---- Figures ----------------------------------------------------------- */

/** Elapsed time in minutes and hours: "<1m", "38m", "2h 06m". Never seconds,
 *  so a label over it changes once a minute at most. */
export function minutesLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** 520_000 → "520k", 9_400_000 → "9.4M". Settled totals read at a glance,
 *  so thousands are whole and only millions keep a decimal. */
export function tokensLabel(count: number): string {
  const n = Math.max(0, Math.round(count));
  if (n >= 10_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Every token the model read plus every one it wrote, as the host adds
 *  them (`TokenUsage::total`). The cached and reasoning parts are inside. */
export function usageTotal(usage: AttemptUsage | null | undefined): number | null {
  if (!usage || !Number.isFinite(usage.input) || !Number.isFinite(usage.output)) return null;
  const total = usage.input + usage.output;
  return total > 0 ? total : null;
}

function sumUsage(attempts: readonly OrchestrationAttempt[]): number | null {
  let total = 0;
  let seen = false;
  for (const attempt of attempts) {
    const used = usageTotal(attempt.usage);
    if (used === null) continue;
    total += used;
    seen = true;
  }
  return seen ? total : null;
}

/** Whole percent of the window in use; `null` unless both were reported. */
export function contextPercent(context: OrchestrationAttempt["context"]): number | null {
  if (!context || !(context.window > 0) || !(context.tokens > 0)) return null;
  return Math.min(100, Math.round(context.tokens / context.window * 100));
}

/** The right-hand figures of a row: "ctx 41% · 520k · 38m". A part that is
 *  not known, or is zero, is left out, and so is the whole line. */
export function figuresLabel(row: Pick<ProgressRow, "context" | "tokens" | "elapsedMs">): string | null {
  const parts = [
    row.context ? `ctx ${row.context}%` : null,
    row.tokens ? tokensLabel(row.tokens) : null,
    row.elapsedMs !== null && row.elapsedMs > 0 ? minutesLabel(row.elapsedMs) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function stepsLabel(steps: { done: number; total: number }): string {
  return `${steps.done}/${steps.total} ${steps.total === 1 ? "step" : "steps"}`;
}

/** "13 / 22" for the tile. */
export function tasksLabel(tasks: { done: number; total: number }): string {
  return `${tasks.done} / ${tasks.total}`;
}

/* ---- One task ---------------------------------------------------------- */

/** What a row under Needs you says, by what is waiting. */
const PERSON_WORD: Record<WaitKind, string> = {
  plan: "Plan to approve", gate: "Asks a decision", question: "Asks a question", delivery: "Answer not delivered",
  permission: "Awaiting approval", safety: "Awaiting review", native: "Awaiting review", outage: "Safety check was down",
  handover: "Asks a handover",
};

/** The host's word for a gate or decision the run's own agent is dealing
 *  with. */
export const COORDINATOR_WORD = "Waiting on the coordinator";

type Reading = Pick<ProgressRow, "state" | "why" | "tone">;

function read(
  run: OrchestrationRun,
  task: OrchestrationTask,
  attempt: OrchestrationAttempt | undefined,
  waits: Waits,
): Reading {
  if (task.status === "completed") {
    // Finished is not passed: a check that failed still holds what depends
    // on it, until it is replaced or run again.
    if (task.verdict === "fail" && !task.supersededBy) return { state: "failed", why: "Check failed", tone: "danger" };
    return { state: "done", why: null, tone: null };
  }
  if (task.status === "cancelled") return { state: "closed", why: "Cancelled", tone: null };
  if (task.supersededBy) return { state: "closed", why: "Replaced", tone: null };
  // A stopped run retries nothing: what it left is history, not owed.
  if (run.status === "stopped") return { state: "closed", why: "Stopped", tone: null };
  // The person's, and only then "Needs you".
  if (waits.person.length) return { state: "needs", why: PERSON_WORD[waits.person[0].kind], tone: "decide" };
  // The coordinator's: a wait, in the warning colour, that asks nothing of
  // the person.
  if (waits.coordinator.length) return { state: "running", why: COORDINATOR_WORD, tone: "warn" };
  if (task.status === "failed") return { state: "failed", why: "Failed", tone: "danger" };
  // A decision is open and the host does not say whose it is. It is said as
  // what the ledger holds, in no colour, and counted as nobody's.
  const unsaid = waits.unsaid[0];
  if (unsaid?.kind === "gate") return { state: "running", why: "Asks a decision", tone: null };
  if (task.status === "blocked") {
    if (unsaid) return { state: "running", why: "Decision recorded", tone: null };
    // Blocked with no decision open: nothing is being waited for.
    return { state: "failed", why: "Blocked", tone: "danger" };
  }
  // A refusal nobody can approve (`waits.nobody`) changes nothing here: the
  // worker was told and goes on, so the row says what the worker is doing.
  const live = !!attempt && task.activeAttemptId === attempt.id;
  if (task.status === "running") {
    if (live && attempt.execution) {
      const environment = attempt.execution.pendingTools?.["octiq:environment"];
      if (environment) {
        return { state: "running", why: environment.startsWith("Waiting for environment capacity") ? "Waiting for an environment slot" : "Preparing environment", tone: null };
      }
      // Stalled, disconnected, out of capacity: a warning about a worker
      // that is still the task's own, so it stays with what is running.
      if (executionNeedsAttention(attempt) || attempt.execution.state === "retrying") {
        return { state: "running", why: EXECUTION_LABELS[attempt.execution.state], tone: "warn" };
      }
    }
    if (live && proposedReportState(attempt) === "proposed") return { state: "running", why: "Report proposed", tone: null };
    if (attempt?.status === "preparing" && !attempt.execution) return { state: "running", why: "Preparing workspace", tone: null };
    return { state: "running", why: null, tone: null };
  }
  return { state: "planned", why: null, tone: null };
}

/** What failed is listed with what is running, first: the person asked for
 *  it there, in the danger colour, and "Needs you" holds only what waits on
 *  them. There is no fifth group. */
const GROUP_OF: Record<RowState, GroupKey> = {
  needs: "needs", failed: "running", running: "running", done: "finished", closed: "finished", planned: "planned",
};

/** Whether the row's worker has a turn in flight: the task is running on
 *  this very attempt and the host says it is executing. Parked, preparing,
 *  stalled or waiting on anybody is not a turn. */
function inFlight(task: OrchestrationTask, attempt: OrchestrationAttempt | undefined, reading: Reading): boolean {
  if (reading.state !== "running" || reading.tone === "warn" || task.status !== "running") return false;
  return !!attempt && task.activeAttemptId === attempt.id && attemptIsExecuting(attempt);
}

/** One task's row. */
export function progressRow(
  snapshot: OrchestrationSnapshot,
  run: OrchestrationRun,
  task: OrchestrationTask,
  now: number,
  waiting?: Waiting,
  waits: RunWaits = runWaits(snapshot, run, waiting),
): ProgressRow {
  const attempt = currentAttempt(snapshot, task);
  const mineWaits = waits.tasks.get(task.id) ?? NO_WAITS;
  const reading = read(run, task, attempt, mineWaits);
  const summary = taskStepSummary(task, attempt, attempt ? snapshot.reports?.[attempt.workerChatKey] : undefined);
  const steps = summary ? { done: summary.done, total: summary.total } : null;
  const mine = snapshot.attempts.filter((item) => item.taskId === task.id);
  const titles = new Map(snapshot.tasks.map((item) => [item.id, item]));
  const live = reading.state === "running" || reading.state === "needs";
  return {
    task, attempt, ...reading,
    group: GROUP_OF[reading.state],
    flight: inFlight(task, attempt, reading),
    decisions: reading.state === "needs" ? mineWaits.person.length : 0,
    // Said only of a row that is still owed something: a finished or closed
    // one waits for nothing, whatever the ledger kept.
    hint: mineWaits.unsaid.length && (reading.state === "running" || reading.state === "failed" || reading.state === "planned") ? UNSAID_NOTE : null,
    steps,
    percent: steps ? Math.round(steps.done / steps.total * 100) : reading.state === "done" ? 100 : null,
    model: attempt?.model || task.worker?.model || null,
    effort: attempt?.effort || task.worker?.effort || null,
    // Only what still holds it: a dependency that finished is no longer
    // something it is "after".
    after: reading.state !== "planned" ? [] : task.dependsOn.flatMap((id) => {
      const dependency = titles.get(id);
      return dependency && dependency.status !== "completed" ? [dependency.title] : [];
    }),
    verdict: task.status === "completed" ? task.verdict ?? null : null,
    elapsedMs: taskElapsed(snapshot, task, now),
    tokens: sumUsage(mine),
    context: live && attempt && task.activeAttemptId === attempt.id ? contextPercent(attempt.context) : null,
  };
}

/** Rows in the order a group lists them. The ledger's order is kept, which
 *  is the order the plan was written in, except where time says more:
 *  what failed leads Running, a worker in trouble comes next, the latest
 *  finish leads Finished, and a task that can start leads one that is
 *  still waiting. */
function ordered(key: GroupKey, rows: ProgressRow[]): ProgressRow[] {
  const at = new Map(rows.map((row, index) => [row, index]));
  const keep = (a: ProgressRow, b: ProgressRow) => at.get(a)! - at.get(b)!;
  if (key === "needs") return rows;
  if (key === "finished") {
    const when = (row: ProgressRow) => row.attempt?.finishedAt ?? row.task.updatedAt;
    return [...rows].sort((a, b) => Number(a.state === "closed") - Number(b.state === "closed") || when(b) - when(a) || keep(a, b));
  }
  if (key === "planned") return [...rows].sort((a, b) => Number(b.task.status === "ready") - Number(a.task.status === "ready") || keep(a, b));
  // What failed leads, then a worker in trouble, then the ones simply going.
  const rank = (row: ProgressRow) => row.state === "failed" ? 0 : row.tone === "warn" ? 1 : 2;
  return [...rows].sort((a, b) => rank(a) - rank(b) || keep(a, b));
}

/** The rows of a group that are drawn before "N more", and how many are
 *  behind it. */
export function shownRows(group: ProgressGroup, all: boolean): { rows: ProgressRow[]; more: number } {
  const limit = GROUP_SHOWN[group.key];
  // One row behind a "1 more" line would cost the line it saves.
  if (all || group.rows.length <= limit + 1) return { rows: group.rows, more: 0 };
  return { rows: group.rows.slice(0, limit), more: group.rows.length - limit };
}

/* ---- The run ----------------------------------------------------------- */

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** A group's heading, and what it counts. Needs you counts what the strip
 *  counts, decisions, and says the word: two cards of one worker are "2
 *  decisions" in one row, and a bare "1" beside the strip's "2" read as a
 *  disagreement. The other groups have only tasks to count. A decision of
 *  the run itself (its plan, a gate with no task) is no row, and is drawn in
 *  its own box above the groups. */
export function groupHeading(group: ProgressGroup): { label: string; spoken: string } {
  const tasks = group.rows.length;
  if (group.key !== "needs") return { label: `${group.label} · ${tasks}`, spoken: `${group.label}, ${plural(tasks, "task", "tasks")}` };
  const decisions = plural(group.rows.reduce((sum, row) => sum + row.decisions, 0), "decision", "decisions");
  return { label: `${group.label} · ${decisions}`, spoken: `${group.label}, ${decisions} in ${plural(tasks, "task", "tasks")}` };
}

/** The counts beside the bar: the reason for the state first, said whole,
 *  then one more. A zero is left out. */
function stripSide(strip: Pick<RunStrip, "state" | "needs" | "planOnly" | "failed" | "working" | "runs">, elapsedMs: number | null): StripSide[] {
  const workers: StripSide | null = strip.working ? { text: `${strip.working} working`, strong: false } : null;
  const failed: StripSide | null = strip.failed ? { text: `${strip.failed} failed`, strong: false } : null;
  // A chat that coordinates several live runs says so: the bar is one of
  // them, and the count is what keeps the others from being forgotten.
  const runs: StripSide | null = strip.runs > 1 ? { text: `${strip.runs} runs`, strong: false } : null;
  const side: (StripSide | null)[] = strip.state === "needs"
    ? [{ text: strip.planOnly ? "Plan to approve" : plural(strip.needs, "decision", "decisions"), strong: true }, runs ?? failed ?? workers]
    : strip.state === "failed" ? [{ text: `${strip.failed} failed`, strong: true }, runs ?? workers]
    : strip.state === "done" ? [elapsedMs !== null && elapsedMs > 0 ? { text: minutesLabel(elapsedMs), strong: false } : null, runs]
    : [workers, runs];
  return side.filter((item): item is StripSide => !!item).slice(0, 2);
}

/** Everything both surfaces draw for one run. `waiting` is the cards the
 *  page holds for the person, per task; who each wait is on is decided in
 *  one place (`lib/runWaits.runWaits`) and read here for the rows and the
 *  strip alike. */
export function runProgress(
  snapshot: OrchestrationSnapshot,
  run: OrchestrationRun,
  now: number,
  waiting?: Waiting,
): RunProgress {
  const waits = runWaits(snapshot, run, waiting);
  const tasks = snapshot.tasks.filter((task) => task.runId === run.id);
  const attempts = snapshot.attempts.filter((attempt) => attempt.runId === run.id);
  const rows = tasks.map((task) => progressRow(snapshot, run, task, now, waiting, waits));
  const groups = GROUP_ORDER.flatMap((key) => {
    const mine = rows.filter((row) => row.group === key);
    // An empty group is not drawn.
    return mine.length ? [{ key, label: GROUP_LABEL[key], rows: ordered(key, mine) }] : [];
  });

  // What is owed and what is settled: a cancelled or replaced task is
  // neither, so a run can reach its whole count.
  const counted = rows.filter((row) => row.state !== "closed");
  const done = counted.filter((row) => row.state === "done").length;
  const total = counted.length;
  const elapsedMs = runElapsed(snapshot, run.id, now);
  const tiles: RunTiles = { tasks: { done, total }, tokens: sumUsage(attempts), elapsedMs };

  const active = ACTIVE_RUN.has(run.status);
  // Per decision, never per row: two cards of one worker are two.
  const needs = waits.person.length;
  const failed = rows.filter((row) => row.state === "failed").length + (run.status === "failed" && !rows.some((row) => row.state === "failed") ? 1 : 0);
  const working = rows.filter((row) => row.flight).length;

  let strip: RunStrip | null = null;
  // History and a run with nothing to count draw no strip: a stopped,
  // closed or archived run is not progressing, and "0/0" says nothing.
  if (total > 0 && run.archivedAt == null && run.status !== "closed" && run.status !== "stopped") {
    // Failed only while a failed row exists and nothing waits on the person.
    const state: StripState = needs ? "needs" : failed ? "failed" : done === total ? "done" : "running";
    const notes = [
      waits.coordinator.length ? `${waits.coordinator.length} waiting on the coordinator.` : null,
      waits.unsaid.length ? `${plural(waits.unsaid.length, "open decision", "open decisions")}: the host does not say who ${waits.unsaid.length === 1 ? "it waits" : "they wait"} on.` : null,
    ].filter((note): note is string => !!note);
    const counts = { state, needs, planOnly: needs === 1 && waits.person[0].kind === "plan", failed, working, runs: 1 };
    strip = {
      ...counts,
      word: STRIP_WORD[state],
      done, total,
      percent: Math.round(done / total * 100),
      label: state === "done" ? `Done · ${done}/${total}` : `Tasks ${done}/${total}`,
      side: stripSide(counts, elapsedMs),
      live: state === "running" && active && working > 0,
      notes,
      signature: [run.id, state, `${done}/${total}`, needs, failed].join(":"),
    };
  }
  return { rows, groups, tiles, strip };
}

/** The run a chat's strip is about: the one in flight, else its latest that
 *  is not put away. `runs` come sorted that way (`chatWorkflow.chatSnapshot`). */
export function stripRun(runs: readonly OrchestrationRun[]): OrchestrationRun | null {
  return runs.find((run) => ACTIVE_RUN.has(run.status) && run.archivedAt == null)
    ?? runs.find((run) => run.archivedAt == null && run.status !== "closed" && run.status !== "stopped")
    ?? null;
}

/** The one line for a chat, which may coordinate several runs. `snapshot` is
 *  the chat's own (`chatWorkflow.chatSnapshot`), its runs live first and
 *  newest first.
 *
 *  A run with something waiting on the person outranks a newer one that is
 *  simply running, and a failure outranks plain progress. The decisions of
 *  every live run are counted on the line, so the one it does not draw the
 *  bar of is not hidden; with more than one live run it says how many. */
export function chatStrip(
  snapshot: OrchestrationSnapshot,
  now: number,
  waiting?: Waiting,
): { run: OrchestrationRun; strip: RunStrip } | null {
  const fallback = stripRun(snapshot.runs);
  if (!fallback) return null;
  const live = snapshot.runs
    .filter((run) => ACTIVE_RUN.has(run.status) && run.archivedAt == null)
    .flatMap((run) => {
      const strip = runProgress(snapshot, run, now, waiting).strip;
      return strip ? [{ run, strip }] : [];
    });
  if (live.length < 2) {
    if (live.length === 1) return live[0];
    const strip = runProgress(snapshot, fallback, now, waiting).strip;
    return strip ? { run: fallback, strip } : null;
  }
  const picked = live.find((item) => item.strip.state === "needs")
    ?? live.find((item) => item.strip.state === "failed")
    ?? live.find((item) => item.strip.live)
    ?? live[0];
  const needs = live.reduce((sum, item) => sum + item.strip.needs, 0);
  const asking = live.filter((item) => item.strip.needs > 0);
  const counts = {
    state: picked.strip.state, needs,
    planOnly: needs === 1 && asking[0].strip.planOnly,
    failed: picked.strip.failed, working: picked.strip.working, runs: live.length,
  };
  const others = live.length - 1;
  return {
    run: picked.run,
    strip: {
      ...picked.strip, ...counts,
      side: stripSide(counts, null),
      notes: [
        `The bar is one of ${live.length} live runs of this chat${picked.strip.state === "needs" ? ", the one that waits on you" : ""}.`,
        ...(needs > picked.strip.needs ? [`${plural(needs - picked.strip.needs, "decision", "decisions")} in ${others === 1 ? "the other run" : "the other runs"}.`] : []),
        ...live.flatMap((item) => item.strip.notes),
      ],
      signature: [picked.run.id, picked.strip.state, `${picked.strip.done}/${picked.strip.total}`, needs, picked.strip.failed, live.length].join(":"),
    },
  };
}

/* ---- Hiding the strip -------------------------------------------------- */

/** How many dismissals are kept. One short string each, newest last. */
const DISMISSED_KEPT = 40;

/** The dismissals with this one added: a run has one, and the oldest runs'
 *  go first. Each is the strip's signature when it was hidden. */
export function dismissStrip(before: readonly string[], signature: string): string[] {
  const run = signature.slice(0, signature.indexOf(":"));
  return [...before.filter((item) => !item.startsWith(`${run}:`)), signature].slice(-DISMISSED_KEPT);
}

/** Hidden only while it says exactly what it said when it was hidden. */
export function stripHidden(dismissed: readonly string[], strip: RunStrip | null): boolean {
  return !!strip && dismissed.includes(strip.signature);
}

export function parseDismissed(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(-DISMISSED_KEPT) : [];
  } catch {
    return [];
  }
}

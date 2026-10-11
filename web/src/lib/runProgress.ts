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

/** The four things the strip can say. */
export type StripState = "running" | "needs" | "done" | "failed";

/** Where one task is. `closed` is a task nothing is owed for and that did
 *  not finish: cancelled, replaced, or left behind by a stopped run. */
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
  /** The texture over the part still to do moves. */
  live: boolean;
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

/** What is waiting on the person for a task, by kind (`lib/pendingActions`).
 *  Only the kinds are read: the cards themselves are drawn elsewhere. */
export type Waiting = ReadonlyMap<string, readonly { kind: string }[]>;

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

const WAITING_WORD: Record<string, string> = {
  question: "Asks a question", delivery: "Answer not delivered", permission: "Awaiting approval",
  safety: "Awaiting review", outage: "Safety check was down", handover: "Asks a handover",
};

type Reading = Pick<ProgressRow, "state" | "why" | "tone">;

function read(
  snapshot: OrchestrationSnapshot,
  run: OrchestrationRun,
  task: OrchestrationTask,
  attempt: OrchestrationAttempt | undefined,
  gated: ReadonlySet<string>,
  waiting: Waiting | undefined,
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
  if (gated.has(task.id)) return { state: "needs", why: "Asks a decision", tone: "decide" };
  const cards = waiting?.get(task.id) ?? [];
  const card = cards.find((item) => WAITING_WORD[item.kind]);
  if (card) return { state: "needs", why: WAITING_WORD[card.kind], tone: "decide" };
  const live = !!attempt && task.activeAttemptId === attempt.id;
  if (live && (snapshot.nativeDecisions ?? []).some((d) => d.attemptId === attempt.id && d.status === "pending")) {
    return { state: "needs", why: "Awaiting approval", tone: "decide" };
  }
  if (task.status === "failed") return { state: "failed", why: "Failed", tone: "danger" };
  if (task.status === "blocked") return { state: "failed", why: "Blocked", tone: "danger" };
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

const GROUP_OF: Record<RowState, GroupKey> = {
  needs: "needs", failed: "needs", running: "running", done: "finished", closed: "finished", planned: "planned",
};

/** Whether a worker is actually going, as opposed to parked or in trouble. */
function working(row: ProgressRow): boolean {
  if (row.state !== "running" || row.tone === "warn") return false;
  return !row.attempt || attemptIsExecuting(row.attempt) || row.attempt.status === "preparing";
}

/** One task's row. */
export function progressRow(
  snapshot: OrchestrationSnapshot,
  run: OrchestrationRun,
  task: OrchestrationTask,
  now: number,
  waiting?: Waiting,
  gated: ReadonlySet<string> = openGates(snapshot, run.id).tasks,
): ProgressRow {
  const attempt = currentAttempt(snapshot, task);
  const reading = read(snapshot, run, task, attempt, gated, waiting);
  const summary = taskStepSummary(task, attempt, attempt ? snapshot.reports?.[attempt.workerChatKey] : undefined);
  const steps = summary ? { done: summary.done, total: summary.total } : null;
  const mine = snapshot.attempts.filter((item) => item.taskId === task.id);
  const titles = new Map(snapshot.tasks.map((item) => [item.id, item]));
  const live = reading.state === "running" || reading.state === "needs";
  return {
    task, attempt, ...reading,
    group: GROUP_OF[reading.state],
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

function openGates(snapshot: OrchestrationSnapshot, runId: string): { tasks: Set<string>; run: number } {
  const open = snapshot.gates.filter((gate) => gate.runId === runId && gate.status === "open");
  return {
    tasks: new Set(open.flatMap((gate) => gate.taskId ? [gate.taskId] : [])),
    run: open.filter((gate) => !gate.taskId).length,
  };
}

/** Rows in the order a group lists them. The ledger's order is kept, which
 *  is the order the plan was written in, except where time says more:
 *  what failed sits under what asks, a worker in trouble leads Running, the
 *  latest finish leads Finished, and a task that can start leads one that is
 *  still waiting. */
function ordered(key: GroupKey, rows: ProgressRow[]): ProgressRow[] {
  const at = new Map(rows.map((row, index) => [row, index]));
  const keep = (a: ProgressRow, b: ProgressRow) => at.get(a)! - at.get(b)!;
  if (key === "needs") return [...rows].sort((a, b) => Number(a.state === "failed") - Number(b.state === "failed") || keep(a, b));
  if (key === "finished") {
    const when = (row: ProgressRow) => row.attempt?.finishedAt ?? row.task.updatedAt;
    return [...rows].sort((a, b) => Number(a.state === "closed") - Number(b.state === "closed") || when(b) - when(a) || keep(a, b));
  }
  if (key === "planned") return [...rows].sort((a, b) => Number(b.task.status === "ready") - Number(a.task.status === "ready") || keep(a, b));
  // A worker in trouble leads the ones that are simply going.
  return [...rows].sort((a, b) => Number(b.tone === "warn") - Number(a.tone === "warn") || keep(a, b));
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

/** Everything both surfaces draw for one run. `waiting` is what the page
 *  holds for the person per task; without it a row still says "Asks a
 *  decision" for a gate, which is in the ledger. */
export function runProgress(
  snapshot: OrchestrationSnapshot,
  run: OrchestrationRun,
  now: number,
  waiting?: Waiting,
): RunProgress {
  const gates = openGates(snapshot, run.id);
  const tasks = snapshot.tasks.filter((task) => task.runId === run.id);
  const attempts = snapshot.attempts.filter((attempt) => attempt.runId === run.id);
  const rows = tasks.map((task) => progressRow(snapshot, run, task, now, waiting, gates.tasks));
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
  const plan = run.planApproval?.status === "pending" && active ? 1 : 0;
  const asking = rows.filter((row) => row.state === "needs").length;
  const needs = plan + gates.run + asking;
  const failed = rows.filter((row) => row.state === "failed").length + (run.status === "failed" && !rows.some((row) => row.state === "failed") ? 1 : 0);
  const busy = rows.filter(working).length;

  let strip: RunStrip | null = null;
  // History and a run with nothing to count draw no strip: a stopped,
  // closed or archived run is not progressing, and "0/0" says nothing.
  if (total > 0 && run.archivedAt == null && run.status !== "closed" && run.status !== "stopped") {
    const state: StripState = needs ? "needs" : failed ? "failed" : done === total ? "done" : "running";
    const workers: StripSide | null = busy ? { text: `${busy} working`, strong: false } : null;
    const side: (StripSide | null)[] = state === "needs"
      ? [
        { text: plan && needs === 1 ? "Plan to approve" : plural(needs, "decision", "decisions"), strong: true },
        failed ? { text: `${failed} failed`, strong: false } : workers,
      ]
      : state === "failed" ? [{ text: `${failed} failed`, strong: true }, workers]
      : state === "done" ? [elapsedMs !== null && elapsedMs > 0 ? { text: minutesLabel(elapsedMs), strong: false } : null]
      : [workers];
    strip = {
      state,
      word: STRIP_WORD[state],
      done, total,
      percent: Math.round(done / total * 100),
      label: state === "done" ? `Done · ${done}/${total}` : `Tasks ${done}/${total}`,
      side: side.filter((item): item is StripSide => !!item).slice(0, 2),
      live: state === "running" && active,
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

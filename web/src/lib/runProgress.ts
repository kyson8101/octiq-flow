// How far a run has got: one line above the composer, and the Agents panel
// it opens.
//
// Everything here is read off the ledger the host sends. Nothing is
// estimated: a figure the host did not send is `null`, and what draws it
// leaves that part out. A zero is left out the same way, so neither surface
// ever fills up with "0 failed · 0 working".
//
// Words come from two places only: a task's title, and the host's own label
// for what a task is waiting on. A worker's free text (its summary, a path,
// a commit) is never a row's default line; it stays behind the row's
// disclosure. One exception, and it is exact (`rowStep`): the title of the
// step the worker says it is on, one line of plain text, and only while an
// attempt of the task is executing.
import {
  attemptIsExecuting, currentAttempt, EXECUTION_LABELS, executionNeedsAttention, proposedReportState, runElapsed,
  taskElapsed, taskStepSummary, type TaskStepSummary,
} from "./agentTaskBoard";
import {
  CHECK_FAILED_LABEL, checkFailed, FAILURE_WORD, failureMove, failureOf, finishedWell, isRetrying, isSettled, saysFailures,
  type AttemptUsage, type FailureKind, type FailureMove, type OrchestrationAttempt, type OrchestrationRun, type OrchestrationSnapshot,
  type OrchestrationTask, type TaskFailure,
} from "./orchestration";
import { ledgerWaits, NO_WAITS, openGates, runWaits, UNSAID_NOTE, type RunWaits, type WaitKind, type Waiting, type Waits } from "./runWaits";
import { reopenControl, startControl, taskHold, type TaskHold } from "./taskHold";

export type { Waiting } from "./runWaits";

/** The four things the strip can say. */
export type StripState = "running" | "needs" | "done" | "failed";

/** Where one task is. `needs` is a card or a decision that waits on the
 *  person (`lib/runWaits`). `failed` is a failure that is red: one the host
 *  says waits on the person, which is listed under Needs you; on a host that
 *  does not say whose move a failure is, a task that failed, one that is
 *  blocked with no decision open, or a check whose verdict is fail, listed
 *  under Running as before. A failure its coordinator is fixing is
 *  `running`, and one that is history is `closed`
 *  (`orchestration.failureMove`). `closed` is a task nothing is owed for and
 *  that did not finish: cancelled, replaced, or left behind by a run that
 *  was stopped, closed or archived. */
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
  /** The task's failure, when the host says whose move it is: what the row
   *  says of it in whole sentences. `null` on a host that does not say, and
   *  for a task that is not in failure. */
  failure: RowFailure | null;
  /** What holds a task that has not started, when the host would refuse a
   *  start of it (`lib/taskHold`): the person's stop, the plan, a reopen
   *  whose notice is not confirmed yet. Its label is the row's `why`. */
  hold: TaskHold | null;
  /** The worker's checklist as counts. */
  steps: { done: number; total: number } | null;
  /** The step the worker says it is on, while its turn is in flight and
   *  for no other row (`rowStep`). The one text of the worker's a folded
   *  row carries. */
  step: RowStep | null;
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
  /** How far the bar is filled. It is drawn and never said: the count is. */
  percent: number;
  /** The count beside the bar, "13/22", and nothing of the state: the word
   *  says that, once. With nothing to count, what stands in for it:
   *  "No tasks yet", "Run stopped", "No tasks left". */
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
  /** How many of those are a failure's own decision: the failure the host
   *  says is the person's, or the gate its coordinator opened about it. When
   *  every decision is one, the line's state is `failed`. */
  failures: number;
  /** The only thing waiting on the person is the plan. */
  planOnly: boolean;
  failed: number;
  /** Tasks the person stopped and has not started again: said on the line
   *  only where no failure, worker or other run takes the second count. */
  stopped: number;
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

/** The step a running row names: where it stands in the checklist, its
 *  title as the worker wrote it, and whether the report is old. */
export type RowStep = { at: number; total: number; title: string; reportedAt: number; stale: boolean };

/** A report older than this is not called what the worker is doing now: the
 *  step is drawn muted and the tooltip says when it was reported. */
export const STEP_STALE_MS = 10 * 60_000;

/** The step a folded row names, or `null` for the count alone. Only while
 *  the row's turn is in flight (`flight`: the task is running on this very
 *  attempt and the host says it is executing), and only the step the worker
 *  marked active. A planned, held, finished or failed row, and one whose
 *  worker is stalled, disconnected or waits on anybody, says nothing of the
 *  worker's. */
export function rowStep(flight: boolean, summary: TaskStepSummary | null, now: number): RowStep | null {
  if (!flight || !summary?.current || !summary.step || summary.at === null) return null;
  return {
    at: summary.at, total: summary.total, title: summary.step, reportedAt: summary.reportedAt,
    stale: now - summary.reportedAt > STEP_STALE_MS,
  };
}

/** The count that leads the step: "1/7". The title follows it as text of
 *  its own, so it is never joined into a string that could be read as the
 *  host's. */
export function stepAtLabel(step: Pick<RowStep, "at" | "total">): string {
  return `${step.at}/${step.total}`;
}

/** A step's title on one line: the worker's text with every run of white
 *  space, line breaks included, as one space. Nothing else is changed and
 *  nothing is read out of it: it is drawn as text, never as markdown or a
 *  link. The whole title, as written, is the tooltip's and the checklist's. */
export function stepOneLine(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/** "13 / 22" for the tile. */
export function tasksLabel(tasks: { done: number; total: number }): string {
  return `${tasks.done} / ${tasks.total}`;
}

/* ---- One task ---------------------------------------------------------- */

/** What a row under Needs you says, by what is waiting. */
const PERSON_WORD: Record<WaitKind, string> = {
  plan: "Plan to approve", gate: "Asks a decision", failure: "Failed", question: "Asks a question", delivery: "Answer not delivered",
  permission: "Awaiting approval", safety: "Awaiting review", native: "Awaiting review", outage: "Safety check was down",
  handover: "Asks a handover",
};

/** The host's word for a gate or decision the run's own agent is dealing
 *  with, and for a failure it is fixing. */
export const COORDINATOR_WORD = "Waiting on the coordinator";

/** What a row says while a retry of its task is at work. */
export const RETRYING_WORD = "Retrying";

export type Reading = Pick<ProgressRow, "state" | "why" | "tone">;

/** A failure on a row, in words. */
export type RowFailure = {
  move: FailureMove;
  kind: FailureKind;
  because: TaskFailure["because"] | null;
  /** One sentence, drawn on the row itself for a failure that waits on the
   *  person: why it is theirs, and what moves it. For the coordinator's and
   *  for history it is the opened row's and the tooltip's. */
  note: string;
  /** The coordinator's chat is where to go: nothing on the row moves a
   *  failure that waits on the person. */
  askCoordinator: boolean;
};

const retries = (count: number) => `${count} automatic ${count === 1 ? "retry" : "retries"}`;

/** What a row says of its task's failure. `start` is the task's one start
 *  control when the page has one to offer (`lib/taskHold.startControl`) and
 *  `question` the open decision its coordinator put to the person about it.
 *  A failure that waits on the person never says only that it failed: the
 *  sentence ends in what moves it. */
export function failureNote(
  task: Pick<OrchestrationTask, "failure" | "retryLimit" | "retriesUsed">,
  start: { label: string; blocked: string | null } | null,
  question: string | null,
  /** The person's own reopen of a settled task, when the page offers one
   *  (`lib/taskHold.reopenControl`): the one door for a failed check, which
   *  takes no Start. */
  reopen: { label: string } | null = null,
): RowFailure | null {
  const failure = failureOf(task);
  if (!failure) return null;
  const { move, kind } = failure;
  const because = failure.because ?? null;
  const limit = task.retryLimit ?? 0;
  const base = { move, kind, because };
  if (move === "coordinator") {
    const used = task.retriesUsed ?? 0;
    return { ...base, askCoordinator: false, note: `Its coordinator is fixing it: ${used} of ${retries(limit)} used. Nothing is asked of you.` };
  }
  if (move === "history") {
    return { ...base, askCoordinator: false, note: because === "replaced" ? "Another task replaced it. Nothing is owed for it." : "Its run was stopped, closed or archived. Nothing is owed for it." };
  }
  const gone = because === "coordinator_gone";
  const why = because === "retries_used" ? `Its ${retries(limit)} are used.`
    : because === "escalated" ? (question ? `Its coordinator asks you: ${question}` : "Its coordinator asks you to decide.")
    : gone ? "The chat that coordinated this run is gone, so nobody retries it."
    : because === "time_limit" ? "This peer request used up its working time."
    : "This failure waits on you.";
  const put = "stop or archive the run";
  // The decision is drawn above the rows, where it is answered.
  const answer = because === "escalated" ? "Answer it under Needs you above" : null;
  const begin = start && !start.blocked ? `open this row for ${start.label}` : null;
  // A settled check takes no worker. What puts it back to work is the
  // person's reopen, with what they want fixed, on the same row.
  const again = !start && reopen ? `open this row for ${reopen.label} to put it back to work with what you write` : null;
  const ways = [answer, begin, again].filter(Boolean) as string[];
  const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  if (ways.length) return { ...base, askCoordinator: false, note: `${why} ${cap(ways.join(", "))}, or ${put}.` };
  // A start the host would refuse says why, and that is what moves it.
  if (start?.blocked) return { ...base, askCoordinator: false, note: `${why} ${start.blocked}` };
  // Nothing on the row moves it: a settled check takes no worker, and the
  // page has no reopen to offer (no kept workspace, a peer request).
  return gone ? { ...base, askCoordinator: false, note: `${why} ${cap(put)} to put it away.` }
    : { ...base, askCoordinator: true, note: `${why} It cannot be started from here: ask the coordinator in its chat, or ${put}.` };
}

/** Where one task is, the word for it and its colour: the row's reading,
 *  and the one every other surface asks before it calls a task failed or
 *  done (the Agents page, the chat list's line). `waits` is the task's entry
 *  in `runWaits(...).tasks`, `hold` what `lib/taskHold` says of it. */
export function taskReading(
  run: Pick<OrchestrationRun, "status">,
  task: OrchestrationTask,
  attempt: OrchestrationAttempt | undefined,
  waits: Waits,
  hold: TaskHold | null,
): Reading {
  // The person's, and only then "Needs you". It is asked first: whatever
  // `lib/runWaits` says waits on them is counted on the strip, so the row
  // that holds it says so too, whatever became of the task. For a task that
  // is settled or a run that is over that is only ever a card still on
  // their screen. A card leads: it is answered where it is. The decision of
  // the task's own failure follows, and is the row's reading below.
  const card = waits.person.find((wait) => !wait.failure);
  if (card) return { state: "needs", why: PERSON_WORD[card.kind], tone: "decide" };
  // The task's failure, where the host says whose move it is
  // (`orchestration.failureMove`). The person's is the one that is red. The
  // coordinator's is quiet: no danger colour and no warning colour, with
  // what is running. History is muted, with what finished.
  const failure = failureOf(task);
  if (failure?.move === "person") return { state: "failed", why: FAILURE_WORD[failure.kind], tone: "danger" };
  if (failure?.move === "coordinator") return { state: "running", why: COORDINATOR_WORD, tone: null };
  if (failure?.move === "history" && !task.supersededBy) return { state: "closed", why: FAILURE_WORD[failure.kind], tone: null };
  // From here a task whose failure the host said nothing of: a host that
  // does not say, and it is read as before.
  // Settled is not finished well: a check that failed still holds what
  // depends on it, until it is replaced or run again.
  if (!failure && checkFailed(task)) return { state: "failed", why: CHECK_FAILED_LABEL, tone: "danger" };
  if (finishedWell(task)) return { state: "done", why: null, tone: null };
  if (task.status === "cancelled") return { state: "closed", why: "Cancelled", tone: null };
  if (task.supersededBy) return { state: "closed", why: "Replaced", tone: null };
  // A stopped run retries nothing: what it left is history, not owed.
  if (run.status === "stopped") return { state: "closed", why: "Stopped", tone: null };
  // The coordinator's: a wait, in the warning colour, that asks nothing of
  // the person.
  if (waits.coordinator.length) return { state: "running", why: COORDINATOR_WORD, tone: "warn" };
  // The person stopped its worker. The host leaves the task failed, and
  // nothing failed: it is held until they start it, and waits with what has
  // not started.
  if (hold?.kind === "stopped") return { state: "planned", why: hold.label, tone: hold.tone };
  const live = !!attempt && task.activeAttemptId === attempt.id;
  // A retry is at work, or the host has scheduled one: grey, and the word
  // says so. A worker of it that is in trouble keeps the host's own word
  // for that, as any worker does.
  if (isRetrying(task)) {
    if (live && executionNeedsAttention(attempt)) return { state: "running", why: EXECUTION_LABELS[attempt.execution!.state], tone: "warn" };
    return { state: "running", why: RETRYING_WORD, tone: null };
  }
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
  if (task.status === "running") {
    if (live && attempt.execution) {
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
  // Not started. A start the host would refuse is said as that, never as a
  // task that is merely waiting its turn.
  return { state: "planned", why: hold?.label ?? null, tone: hold?.tone ?? null };
}

/** "Needs you" holds what waits on the person, and that includes a failure
 *  the host says is theirs to decide (`groupOf`). On a host that does not
 *  say whose move a failure is, what failed is listed with what is running,
 *  first, as before. There is no fifth group. */
const GROUP_OF: Record<RowState, GroupKey> = {
  needs: "needs", failed: "running", running: "running", done: "finished", closed: "finished", planned: "planned",
};

/** The group a row is listed in. */
function groupOf(task: OrchestrationTask, state: RowState): GroupKey {
  return state === "failed" && failureMove(task) === "person" ? "needs" : GROUP_OF[state];
}

/** Whether a reading is counted as a failure: what "N failed" counts on the
 *  strip, the chat list's line and the run picker. Only a failure that
 *  waits on the person is, where the host says whose move it is; on a host
 *  that does not, what the row reads as failed, as before. */
function countsFailed(item: { task: OrchestrationTask; state: RowState }): boolean {
  return saysFailures(item.task) ? failureMove(item.task) === "person" : item.state === "failed";
}

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
  const hold = taskHold(task, run, snapshot.tasks, now);
  const reading = taskReading(run, task, attempt, mineWaits, hold);
  const group = groupOf(task, reading.state);
  // What the row says of its failure, with the start the page would offer
  // and the decision its coordinator put to the person, when there is one.
  const moved = failureOf(task);
  const begin = moved?.move === "person" ? startControl(task, run, snapshot.tasks, snapshot.attempts, waits.gated.has(task.id)) : null;
  const asked = moved?.gateId ? openGates(snapshot, run.id).find((gate) => gate.id === moved.gateId)?.question ?? null : null;
  const again = moved?.move === "person" ? reopenControl(task, run) : null;
  const failure = failureNote(task, begin, asked, again);
  const summary = taskStepSummary(task, attempt, attempt ? snapshot.reports?.[attempt.workerChatKey] : undefined);
  const steps = summary ? { done: summary.done, total: summary.total } : null;
  const mine = snapshot.attempts.filter((item) => item.taskId === task.id);
  const titles = new Map(snapshot.tasks.map((item) => [item.id, item]));
  const live = reading.state === "running" || reading.state === "needs";
  const flight = inFlight(task, attempt, reading);
  return {
    task, attempt, ...reading,
    group,
    flight,
    step: rowStep(flight, summary, now),
    decisions: group === "needs" ? mineWaits.person.length : 0,
    // Said of the reading it explains: a row that leads with a card says
    // the card, and a replaced task that it was replaced.
    failure: failure && (failure.move === "person" || reading.why === (failure.move === "coordinator" ? COORDINATOR_WORD : FAILURE_WORD[failure.kind])) ? failure : null,
    // Said only of a row that is still owed something: a finished or closed
    // one waits for nothing, whatever the ledger kept.
    hint: mineWaits.unsaid.length && (reading.state === "running" || reading.state === "failed" || reading.state === "planned") ? UNSAID_NOTE : null,
    // Said only where it is the row's reading: a task that waits on the
    // person, or that the coordinator has, says that instead.
    hold: reading.state === "planned" ? hold : null,
    steps,
    percent: steps ? Math.round(steps.done / steps.total * 100) : reading.state === "done" ? 100 : null,
    model: attempt?.model || task.worker?.model || null,
    effort: attempt?.effort || task.worker?.effort || null,
    // Only what still holds it: a dependency that finished well is no
    // longer something it is "after". One whose check failed still is: the
    // host goes on holding what depends on it.
    after: reading.state !== "planned" ? [] : task.dependsOn.flatMap((id) => {
      const dependency = titles.get(id);
      return dependency && !finishedWell(dependency) ? [dependency.title] : [];
    }),
    verdict: isSettled(task) ? task.verdict ?? null : null,
    elapsedMs: taskElapsed(snapshot, task, now),
    tokens: sumUsage(mine),
    context: live && attempt && task.activeAttemptId === attempt.id ? contextPercent(attempt.context) : null,
  };
}

/** Whether a plan waiting for the person may stand in for the run's rows:
 *  only when there is nothing else they would be shown. That is asked of the
 *  rows themselves, so it cannot disagree with them: every task is finished
 *  (completed without a failed check), closed (cancelled or replaced), or
 *  has not started because the plan holds it. A task that failed, is
 *  blocked, completed with a failed check, was stopped by the person, is
 *  running, waits on anybody, or is approved and merely waiting its turn is
 *  a row they have to see, and the plan is then drawn beside the rows and
 *  the run's totals. */
export function planStandsIn(
  run: Pick<OrchestrationRun, "planApproval">,
  rows: readonly Pick<ProgressRow, "state" | "hold">[],
): boolean {
  if (run.planApproval?.status !== "pending") return false;
  return rows.every((row) => row.state === "done" || row.state === "closed" || (row.state === "planned" && row.hold?.kind === "plan"));
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
  // A task something holds is never behind "N more": the one the person
  // stopped first, then one whose hold has lasted, then the other held ones.
  if (key === "planned") {
    const held = (row: ProgressRow) => row.hold?.kind === "stopped" ? 0 : row.hold?.tone === "warn" ? 1 : row.hold ? 2 : 3;
    return [...rows].sort((a, b) => held(a) - held(b) || Number(b.task.status === "ready") - Number(a.task.status === "ready") || keep(a, b));
  }
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
function stripSide(strip: Pick<RunStrip, "state" | "needs" | "planOnly" | "failed" | "stopped" | "working" | "runs">, elapsedMs: number | null): StripSide[] {
  const workers: StripSide | null = strip.working ? { text: `${strip.working} working`, strong: false } : null;
  // Beside decisions of other kinds, what failed is still said: it is one
  // of them, and the only one that is a failure.
  const failed: StripSide | null = strip.failed ? { text: `${strip.failed} failed`, strong: false } : null;
  // A chat that coordinates several live runs says so: the bar is one of
  // them, and the count is what keeps the others from being forgotten.
  const runs: StripSide | null = strip.runs > 1 ? { text: `${strip.runs} runs`, strong: false } : null;
  // A task the person stopped is theirs to start again. It takes a count
  // only where nothing more urgent does, so a plan to approve, or a run
  // that is otherwise quiet, does not leave it out of the line.
  const stopped: StripSide | null = strip.stopped ? { text: `${strip.stopped} stopped`, strong: false } : null;
  const side: (StripSide | null)[] = strip.state === "needs"
    ? [{ text: strip.planOnly ? "Plan to approve" : plural(strip.needs, "decision", "decisions"), strong: true }, runs ?? failed ?? workers ?? stopped]
    : strip.state === "failed" ? [{ text: `${strip.failed} failed`, strong: true }, runs ?? workers ?? stopped]
    : strip.state === "done" ? [elapsedMs !== null && elapsedMs > 0 ? { text: minutesLabel(elapsedMs), strong: false } : null, runs]
    : [workers, runs ?? stopped];
  return side.filter((item): item is StripSide => !!item).slice(0, 2);
}

/** What the line draws beside its dot and bar, each thing once: the state
 *  word, then the counts.
 *
 *  A failure's reason is "1 failed", which says the state's own word again
 *  beside "Failed". So there the reason is the word, and the counts are what
 *  is left. Needs you keeps its word: its reason ("1 decision", "Plan to
 *  approve") says what is asked, not the state a second time. What is spoken
 *  and what the tooltip says are not this function's: they stay whole. */
export function stripLine(strip: Pick<RunStrip, "state" | "word" | "side">): { word: string; side: StripSide[] } {
  const [reason, ...rest] = strip.side;
  if (strip.state === "failed" && reason?.strong) return { word: reason.text, side: rest };
  return { word: strip.word, side: strip.side };
}

/** Whether a task is part of the run's count of work, by what the host says
 *  of it and nothing else: settled, or still owed. Cancelled, replaced
 *  (`supersededBy`), or left unfinished by a stopped run is neither, which
 *  is exactly the tasks `taskReading` calls closed when nothing of theirs
 *  waits on the person. */
export function countsAsWork(run: Pick<OrchestrationRun, "status">, task: Pick<OrchestrationTask, "status" | "supersededBy">): boolean {
  if (isSettled(task)) return true;
  return task.status !== "cancelled" && !task.supersededBy && run.status !== "stopped";
}

/** A run's three counts, which every surface that states one draws from
 *  here: tasks done of the tasks that count as work, and tasks failed.
 *
 *  What is owed and what is settled: a cancelled or replaced task is
 *  neither, so a run can reach its whole count. That is asked of the host's
 *  facts and not of the reading: a replaced task whose card is still on the
 *  person's screen is a row under Needs you, and keeps its decision, without
 *  coming back into the count of work. Done the same way: a task that
 *  finished well is done in the count while a card of its worker's is still
 *  up. One whose check failed is not done, and is counted failed.
 *
 *  A run the host calls failed with no failed task is said as one failure,
 *  unless what the host left failed is a task the person stopped: that one
 *  says so itself, and nothing failed. */
export function runTally(
  run: Pick<OrchestrationRun, "status">,
  readings: readonly { task: OrchestrationTask; state: RowState; hold?: TaskHold | null }[],
): { done: number; total: number; failed: number } {
  const counted = readings.filter((item) => countsAsWork(run, item.task));
  const failed = readings.filter(countsFailed).length;
  // Only of a host that does not say whose move a failure is: one that does
  // calls a run failed while its coordinator is still fixing what failed.
  const unsaid = !readings.some((item) => saysFailures(item.task));
  return {
    done: counted.filter((item) => finishedWell(item.task)).length,
    total: counted.length,
    failed: failed + (unsaid && run.status === "failed" && !failed && !readings.some((item) => item.hold?.kind === "stopped") ? 1 : 0),
  };
}

/** The same counts for a surface that draws no rows: the chat list's line,
 *  the run picker. One reading per task and nothing else of a row. */
export function runCounts(
  snapshot: OrchestrationSnapshot,
  run: OrchestrationRun,
  waiting?: Waiting,
  waits: RunWaits = runWaits(snapshot, run, waiting),
): { done: number; total: number; failed: number } {
  return runTally(run, snapshot.tasks.filter((task) => task.runId === run.id).map((task) => {
    // A hold only ever says "held": whether one has lasted is not asked.
    const hold = taskHold(task, run, snapshot.tasks, 0);
    const { state } = taskReading(run, task, currentAttempt(snapshot, task), waits.tasks.get(task.id) ?? NO_WAITS, hold);
    // As a row carries it: a hold is the reading of a planned task only.
    return { task, state, hold: state === "planned" ? hold : null };
  }));
}

/** What the strip's tooltip says of tasks something holds. Never on the
 *  line: a hold asks nothing of the person. */
function holdNotes(rows: readonly ProgressRow[]): string[] {
  const of = (kind: TaskHold["kind"]) => rows.filter((row) => row.hold?.kind === kind).length;
  const [stopped, reopened] = [of("stopped"), of("reopen")];
  return [
    stopped ? `${plural(stopped, "task", "tasks")} stopped by you: only your Start starts ${stopped === 1 ? "it" : "them"} again.` : null,
    reopened ? `${plural(reopened, "reopened task", "reopened tasks")} held: the notice of ${reopened === 1 ? "it" : "them"} is not confirmed as saved yet.` : null,
  ].filter((note): note is string => !!note);
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
  waits: RunWaits = runWaits(snapshot, run, waiting),
): RunProgress {
  const tasks = snapshot.tasks.filter((task) => task.runId === run.id);
  const attempts = snapshot.attempts.filter((attempt) => attempt.runId === run.id);
  const rows = tasks.map((task) => progressRow(snapshot, run, task, now, waiting, waits));
  const groups = GROUP_ORDER.flatMap((key) => {
    const mine = rows.filter((row) => row.group === key);
    // An empty group is not drawn.
    return mine.length ? [{ key, label: GROUP_LABEL[key], rows: ordered(key, mine) }] : [];
  });

  // Done, the tasks that count, and what failed (`runTally`).
  const { done, total, failed } = runTally(run, rows);
  const elapsedMs = runElapsed(snapshot, run.id, now);
  const tiles: RunTiles = { tasks: { done, total }, tokens: sumUsage(attempts), elapsedMs };

  const active = ACTIVE_RUN.has(run.status);
  // Per decision, never per row: two cards of one worker are two.
  const needs = waits.person.length;
  const working = rows.filter((row) => row.flight).length;

  let strip: RunStrip | null = null;
  // History and a run with nothing to count draw no strip: a stopped,
  // closed or archived run is not progressing, and "0/0" says nothing.
  // Unless something in it waits on the person: that is said wherever it is
  // counted, and the badge and the panel count it.
  if (needs > 0 || (total > 0 && run.archivedAt == null && run.status !== "closed" && run.status !== "stopped")) {
    // Needs you outranks everything. Failed is a failure that waits on the
    // person with nothing else waiting on them: every decision is a
    // failure's own. On a host that does not say whose move a failure is, it
    // is a failed row while nothing waits on the person, as before. A
    // failure the coordinator is fixing is neither: the run is running.
    const failures = waits.person.filter((wait) => wait.failure).length;
    const state: StripState = needs ? (failures === needs ? "failed" : "needs") : failed ? "failed" : done === total ? "done" : "running";
    const fixing = rows.filter((row) => row.failure?.move === "coordinator").length;
    const notes = [
      waits.coordinator.length ? `${waits.coordinator.length} waiting on the coordinator.` : null,
      fixing ? `${plural(fixing, "failure", "failures")} with the coordinator, which is fixing ${fixing === 1 ? "it" : "them"}: nothing is asked of you.` : null,
      waits.unsaid.length ? `${plural(waits.unsaid.length, "open decision", "open decisions")}: the host does not say who ${waits.unsaid.length === 1 ? "it waits" : "they wait"} on.` : null,
      ...holdNotes(rows),
    ].filter((note): note is string => !!note);
    const stopped = rows.filter((row) => row.hold?.kind === "stopped").length;
    const counts = { state, needs, failures, planOnly: needs === 1 && waits.person[0].kind === "plan", failed, stopped, working, runs: 1 };
    strip = {
      ...counts,
      word: STRIP_WORD[state],
      done, total,
      percent: total ? Math.round(done / total * 100) : 0,
      // Nothing to count: a run with no task yet, or one whose tasks are all
      // history (a stopped run, or every task cancelled or replaced) and
      // which is on the line only for a card it still holds.
      label: !total ? (tasks.length === 0 ? "No tasks yet" : run.status === "stopped" ? "Run stopped" : "No tasks left")
        : `${done}/${total}`,
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
  // One reading of every run of the chat (`lib/runWaits`): the number of
  // decisions on the line is `waits.person.length`, the same list the badge,
  // the Tasks button and the panel count.
  const waits = ledgerWaits(snapshot, waiting);
  const read = (run: OrchestrationRun) => {
    const strip = runProgress(snapshot, run, now, waiting, waits.runs.get(run.id)).strip;
    return strip ? [{ run, strip }] : [];
  };
  // The live runs, and any other that still holds something for the person
  // (a card left on their screen by a run that is over).
  const live = snapshot.runs
    .filter((run) => (ACTIVE_RUN.has(run.status) && run.archivedAt == null) || !!waits.runs.get(run.id)?.person.length)
    .flatMap(read);
  if (live.length < 2) {
    if (live.length === 1) return live[0];
    const fallback = stripRun(snapshot.runs);
    return fallback ? read(fallback)[0] ?? null : null;
  }
  const picked = live.find((item) => item.strip.state === "needs")
    ?? live.find((item) => item.strip.needs > 0)
    ?? live.find((item) => item.strip.state === "failed")
    ?? live.find((item) => item.strip.live)
    ?? live[0];
  const needs = live.reduce((sum, item) => sum + item.strip.needs, 0);
  const failures = live.reduce((sum, item) => sum + item.strip.failures, 0);
  const asking = live.filter((item) => item.strip.needs > 0);
  // Asked of every run's decisions, like the count: a failure in one run
  // and a card in another is "Needs you", and two failures are both said.
  const state: StripState = needs ? (failures === needs ? "failed" : "needs") : picked.strip.state;
  const counts = {
    state, needs, failures,
    planOnly: needs === 1 && asking[0].strip.planOnly,
    // What failed and waits on the person is counted across the runs, like
    // the decisions it is among. Anything else is the drawn run's own.
    failed: failures ? live.reduce((sum, item) => sum + (item.strip.failures ? item.strip.failed : 0), 0) : picked.strip.failed,
    stopped: picked.strip.stopped, working: picked.strip.working, runs: live.length,
  };
  const others = live.length - 1;
  const allLive = live.every((item) => ACTIVE_RUN.has(item.run.status) && item.run.archivedAt == null);
  return {
    run: picked.run,
    strip: {
      ...picked.strip, ...counts,
      word: STRIP_WORD[state],
      side: stripSide(counts, null),
      notes: [
        `The bar is one of ${live.length} ${allLive ? "live runs" : "runs"} of this chat${picked.strip.needs ? ", the one that waits on you" : ""}.`,
        ...(needs > picked.strip.needs ? [`${plural(needs - picked.strip.needs, "decision", "decisions")} in ${others === 1 ? "the other run" : "the other runs"}.`] : []),
        ...live.flatMap((item) => item.strip.notes),
      ],
      signature: [picked.run.id, state, `${picked.strip.done}/${picked.strip.total}`, needs, counts.failed, live.length].join(":"),
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

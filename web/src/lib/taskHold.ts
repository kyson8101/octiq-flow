// What holds a task that has not started, when the host would refuse a
// start of it.
//
// A task that is `ready` reads as "Ready to start" unless something says
// otherwise, and three things do. Each is a fact the host sends, and each is
// said in the words of the host's own refusal, so a row never says a task can
// start when a start of it would be refused:
//
// - `stopped`: the person stopped its worker (`orchestration_task_stop`).
//   Only they start it again.
// - `heldByPlan`: the plan is with the person and their approval does not
//   cover it (`taskHeldByPlan`).
// - `heldByReopen`: it was reopened, and the notice of that in the
//   coordinator's chat is not confirmed on disk yet. Nobody can answer this
//   one: the host keeps trying, and the task starts once it has.
//
// None of them is a decision asked of the person, so none is a "Needs you"
// here (`lib/runWaits` counts the plan itself, once, for the run). One
// function reads all three and every surface that names a task's state asks
// it: the run panel's row, its tooltip and its opened detail
// (`lib/runProgress`), and the Agents page (`lib/agentsDashboard`).
//
// The same reader decides whether the page may start a task
// (`startControl`, `startBlocker`): every control that starts an attempt is
// drawn from it, switched off with the reason beside it when the host would
// refuse. And it says what a pending plan holds of a whole run
// (`planHoldsEveryStart`).
import { TASK_LABELS } from "./agentTaskBoard";
import { taskHeldByPlan, type OrchestrationRun, type OrchestrationTask } from "./orchestration";

export type HoldKind = "stopped" | "plan" | "reopen";

export type TaskHold = {
  kind: HoldKind;
  /** The row's own line. */
  label: string;
  /** Whole sentences for the tooltip and the opened row. */
  detail: string;
  /** The warning colour, and only for a reopen whose notice has stayed
   *  unconfirmed past the host's own back-off. */
  tone: "warn" | null;
};

/** How long a reopen's notice may stay unconfirmed before the row takes the
 *  warning colour. The host confirms a notice on its next pass (about two
 *  seconds) when nothing is wrong, and asks a transcript that gave no
 *  confirmation again after 4, 8, 16 and 32 seconds, then once a minute:
 *  after a minute it has failed five times and is at its slowest. Before
 *  that the hold is the ordinary moment between a reopen and its notice. */
export const REOPEN_LASTED_MS = 60_000;

export const STOPPED_LABEL = "Stopped by you";
export const PLAN_LABEL = "Waiting for plan approval";
export const REOPEN_LABEL = "Reopened · notice not yet saved";
export const REOPEN_LASTED_LABEL = "Reopened · notice still not saved";

/** The host's refusal of an agent's start of a stopped task
 *  (`STOPPED_BY_PERSON`), said to the person it names. */
export const STOPPED_DETAIL = "You stopped this task's worker, so only you start it again: Start on its row, or your approval of a plan it is put back on.";

/** The host's refusal of a start of a reopened task (`REOPEN_NOT_TOLD`). */
export const REOPEN_DETAIL = "This task was reopened with new instructions, and the notice of that in the coordinator's chat has not been confirmed as saved to disk yet, so it does not start. The notice may already be on screen in that chat. The host keeps trying, and the task starts once it has.";

/** What the same refusal says of a hold that lasts. */
export const REOPEN_LASTED_DETAIL = "It has stayed held: the coordinator's chat was deleted, or its transcript cannot be written or synced to disk.";

export const PLAN_DETAIL = "The plan is with you, and your approval does not cover this task yet. It starts once you approve the plan.";

type Held = Pick<OrchestrationTask, "id" | "runId" | "status" | "supersededBy" | "stopped" | "heldByPlan" | "heldByReopen" | "reopens">;

/** When the oldest reopen whose notice is still owed was made, by the
 *  host's clock. `null` when the ledger names none. */
export function reopenOwedSince(task: Pick<OrchestrationTask, "reopens">): number | null {
  const owed = (task.reopens ?? []).filter((reopen) => reopen.noticeDelivered !== true && Number.isFinite(reopen.at));
  return owed.length ? Math.min(...owed.map((reopen) => reopen.at)) : null;
}

/* ---- How long a hold has lasted ---------------------------------------- */

/** When this page first saw each hold, by the page's own clock.
 *
 *  A reopen's stamp is the host's, and the host's clock and the browser's
 *  are two clocks: compared with each other, a browser five minutes fast
 *  warned at once and one five minutes slow about six minutes late. So the
 *  minute is counted on one clock, from the moment this page first saw the
 *  hold (`seeHolds`, called as each ledger is read), to the reader's `now`.
 *
 *  Keyed by the task and the stamp of the reopen that is owed, so a later
 *  reopen of the same task is a new hold. It is in memory: a reload starts
 *  the minute over, unless the ledger itself shows it has passed
 *  (`ledgerSaysLasted`). */
const firstSeen = new Map<string, number>();

type Reopened = Pick<OrchestrationTask, "id" | "heldByReopen" | "reopens">;
const holdKey = (task: Reopened): string => `${task.id}:${reopenOwedSince(task) ?? 0}`;

/** Record the first sight of every reopen hold in `tasks`, at `now` on the
 *  page's clock, and forget the holds of these tasks that are over. Seeing
 *  a hold again changes nothing. Tasks that are not in `tasks` are left
 *  alone: a chat's own ledger is a part of the whole one. */
export function seeHolds(tasks: readonly Reopened[], now: number): void {
  const current = new Map<string, string | null>();
  for (const task of tasks) {
    const key = task.heldByReopen === true ? holdKey(task) : null;
    current.set(task.id, key);
    if (key !== null && !firstSeen.has(key)) firstSeen.set(key, now);
  }
  for (const key of [...firstSeen.keys()]) {
    const id = key.slice(0, key.lastIndexOf(":"));
    if (current.has(id) && current.get(id) !== key) firstSeen.delete(key);
  }
}

/** Forget every hold: a page that has seen nothing. For the tests. */
export function forgetHolds(): void {
  firstSeen.clear();
}

/** Whether the ledger itself shows the hold has lasted: the host stamped
 *  another task more than the minute after the reopen, in the same answer
 *  that still says the notice is owed. Both stamps are the host's, so no
 *  second clock is involved, and a page loaded late warns at once. */
function ledgerSaysLasted(task: Reopened, tasks: readonly { updatedAt?: number }[]): boolean {
  const owed = reopenOwedSince(task);
  return owed !== null && tasks.some((other) => typeof other.updatedAt === "number" && other.updatedAt - owed >= REOPEN_LASTED_MS);
}

function reopenLasted(task: Reopened, tasks: readonly { updatedAt?: number }[], now: number): boolean {
  if (ledgerSaysLasted(task, tasks)) return true;
  const seen = firstSeen.get(holdKey(task));
  // A hold nobody has seen is never said to have lasted.
  return seen !== undefined && now - seen >= REOPEN_LASTED_MS;
}

/** How long from `now`, on the page's clock, until a reopen hold in `tasks`
 *  that has not lasted yet does: the one moment a reader has to look again.
 *  `null` when no hold is waiting to: nothing is held, or every hold has
 *  lasted. No surface ticks for this; it sets one timer (`useHoldClock`). */
export function holdDue(tasks: readonly (Reopened & { updatedAt?: number })[], now: number): number | null {
  let due: number | null = null;
  for (const task of tasks) {
    if (task.heldByReopen !== true || ledgerSaysLasted(task, tasks)) continue;
    const left = (firstSeen.get(holdKey(task)) ?? now) + REOPEN_LASTED_MS - now;
    if (left > 0 && (due === null || left < due)) due = left;
  }
  return due;
}

/** What holds `task`, or `null` when nothing does: it is settled, running,
 *  replaced, or free to start. `tasks` are the ledger's, for the plan's
 *  reading and for what their stamps say of a hold's age; `now` is the
 *  reader's clock, the same one `seeHolds` was called with, and only the
 *  warning colour of a reopen that lasts depends on it. */
export function taskHold(
  task: Held,
  run: Pick<OrchestrationRun, "planApproval"> | undefined,
  tasks: readonly (Pick<OrchestrationTask, "runId" | "heldByPlan"> & { updatedAt?: number })[],
  now: number,
): TaskHold | null {
  if (task.supersededBy) return null;
  const waiting = task.status === "pending" || task.status === "ready";
  // A stopped task is left failed by the host, and is held whatever became
  // of it since: put back on a plan it is the plan's to release.
  const stopped = !!task.stopped && (waiting || task.status === "failed");
  if (!waiting && !stopped) return null;
  if (waiting && taskHeldByPlan(task, run, tasks)) return { kind: "plan", label: PLAN_LABEL, detail: PLAN_DETAIL, tone: null };
  if (stopped) {
    const reason = task.stopped?.reason?.trim();
    return { kind: "stopped", label: STOPPED_LABEL, detail: reason ? `${STOPPED_DETAIL} Your reason: ${reason}` : STOPPED_DETAIL, tone: null };
  }
  if (task.heldByReopen === true) {
    return reopenLasted(task, tasks, now)
      ? { kind: "reopen", label: REOPEN_LASTED_LABEL, detail: `${REOPEN_DETAIL} ${REOPEN_LASTED_DETAIL}`, tone: "warn" }
      : { kind: "reopen", label: REOPEN_LABEL, detail: REOPEN_DETAIL, tone: null };
  }
  return null;
}

/** Whether the host would refuse every start in `run` because its plan is
 *  with the person: the one case in which "no worker starts until you
 *  approve" is true. The host says, per task, whether the plan holds it
 *  (`heldByPlan`, on a task that has not started and on one that failed or
 *  is blocked alike), and starts whatever it does not hold: a first
 *  dispatch, a retry, the person's Start of a task they stopped. So this is
 *  true only while nothing is running and every task that could take a
 *  worker is held. A task that completed, was cancelled or was replaced
 *  takes none. A host that does not say reads as the page read it before:
 *  a pending plan holds the run. */
export function planHoldsEveryStart(
  run: Pick<OrchestrationRun, "id" | "planApproval">,
  tasks: readonly Pick<OrchestrationTask, "runId" | "status" | "supersededBy" | "heldByPlan">[],
): boolean {
  if (run.planApproval?.status !== "pending") return false;
  const mine = tasks.filter((task) => task.runId === run.id);
  if (!mine.some((task) => typeof task.heldByPlan === "boolean")) return true;
  return mine.every((task) => {
    if (task.supersededBy || task.status === "completed" || task.status === "cancelled") return true;
    // What is in flight is not held, whatever a later change did to its plan.
    return task.status !== "running" && task.heldByPlan === true;
  });
}

/* ---- Starting a task from the page -------------------------------------- */

type Startable = Pick<OrchestrationTask, "id" | "runId" | "status" | "supersededBy" | "stopped" | "heldByPlan" | "heldByReopen" | "activeAttemptId">;
type Listed = Pick<OrchestrationTask, "id" | "runId" | "title" | "heldByPlan">;
type StartRun = Pick<OrchestrationRun, "status" | "archivedAt" | "planApproval" | "workspaceMode">;

/** Whether the host would refuse a start of `task` because the plan holds
 *  it. The host says so per task, of one that has not started and of one
 *  that failed or is blocked alike. A host that does not say reads as the
 *  page read it before: an unstarted task waits for a pending plan, and a
 *  retry is held only in a mission, whose plan goes back to approval when a
 *  task changes hands. */
function planHoldsStart(task: Startable, run: StartRun | undefined, tasks: readonly Listed[]): boolean {
  const unstarted = task.status === "pending" || task.status === "ready";
  if (!unstarted && task.status !== "failed" && task.status !== "blocked") return false;
  if (typeof task.heldByPlan === "boolean") return task.heldByPlan;
  if (tasks.some((other) => other.runId === task.runId && typeof other.heldByPlan === "boolean")) return false;
  if (run?.planApproval?.status !== "pending") return false;
  return unstarted || run.workspaceMode === "mission";
}

/** Why the host would refuse the page's start of `task`, or `null` when it
 *  would take it. Asked in the host's own order (`reserve_attempt_for`):
 *  the plan, a reopen whose notice is not confirmed, a task that was
 *  replaced. The person's stop refuses every start but theirs, so it is no
 *  refusal here: which start is theirs is `startControl`'s to say. */
export function startBlocker(task: Startable, run: StartRun | undefined, tasks: readonly Listed[]): string | null {
  if (planHoldsStart(task, run, tasks)) return PLAN_DETAIL;
  if (task.heldByReopen === true) return REOPEN_DETAIL;
  if (task.supersededBy) {
    const by = tasks.find((other) => other.id === task.supersededBy)?.title;
    return `This task was replaced${by ? ` by "${by}"` : ""} and no longer starts. Start that task instead; this one keeps its history.`;
  }
  return null;
}

export type StartKind = "again" | "next" | "retry";

/** The one control of a task that starts an attempt. */
export type StartControl<A> = {
  kind: StartKind;
  label: string;
  /** The attempt the page showed, which the start retries (`retryOf`). */
  attempt: A;
  /** What the start does, under the attempt it follows. */
  note: string | null;
  /** Why the host would refuse it: the control is drawn switched off, with
   *  this beside it. `null`: the host would take the start. */
  blocked: string | null;
};

const START_LABEL: Record<StartKind, string> = { again: "Start it again", next: "Start next attempt", retry: "Start retry" };

/** The control that starts an attempt of `task`, or `null` when the page
 *  has none to offer. Every start the page sends is drawn from this, so no
 *  surface offers one the host would refuse:
 *
 *  - a task the person stopped has one way back, their own Start of the
 *    attempt they stopped, and no retry beside it;
 *  - a task that is ready again after an attempt completed (reopened, or
 *    waiting for review fixes) offers its next attempt;
 *  - a task that failed or is blocked, with nothing open that holds it,
 *    offers a retry.
 *
 *  A run that is over or put away takes no start. `gated`: an open decision
 *  holds the task (`runWaits(...).gated`). */
export function startControl<A extends { id: string; taskId: string; number: number; status: string; cwd: string }>(
  task: Startable,
  run: StartRun | undefined,
  tasks: readonly Listed[],
  attempts: readonly A[],
  gated: boolean,
): StartControl<A> | null {
  if (!run || run.archivedAt != null || run.status === "stopped" || run.status === "closed" || run.status === "completed") return null;
  const mine = attempts.filter((attempt) => attempt.taskId === task.id).sort((a, b) => b.number - a.number);
  const active = mine.find((attempt) => attempt.id === task.activeAttemptId) ?? mine[0];
  let kind: StartKind;
  let attempt: A | undefined;
  if (task.stopped) {
    if (task.status !== "pending" && task.status !== "ready" && task.status !== "failed") return null;
    [kind, attempt] = ["again", mine.find((candidate) => candidate.id === task.stopped?.attemptId)];
  } else if (task.status === "ready" && active?.status === "completed") {
    [kind, attempt] = ["next", active];
  } else if ((task.status === "blocked" || task.status === "failed") && !gated
    && (active?.status === "blocked" || active?.status === "failed")) {
    [kind, attempt] = ["retry", active];
  } else {
    return null;
  }
  if (!attempt) return null;
  const note = kind === "again" ? null
    : attempt.cwd ? "This attempt settled. Continue in the same workspace with a new authoritative attempt."
    : "This attempt settled before a workspace was assigned. Start a fresh authoritative attempt.";
  return { kind, label: START_LABEL[kind], attempt, note, blocked: startBlocker(task, run, tasks) };
}

/** The ledger's own status of a task, for its details, where it is kept
 *  apart from what the worker's process is doing. It is always said as the
 *  ledger's, and a task something holds leads with the hold (`held`, its
 *  `TaskHold.label`): a held task is never "Ready", and one the person
 *  stopped never "Failed", with nothing beside it. */
export function statusLine(task: Pick<OrchestrationTask, "status">, held: string | null): string {
  const ledger = TASK_LABELS[task.status];
  return held ? `Task: ${held} · ledger status: ${ledger}` : `Ledger status: ${ledger}`;
}

/** Whether the person's Stop has anything to stop: the host cancels the
 *  task's unsettled attempt, and refuses when there is none (`No worker is
 *  running on this task, so there is nothing to stop.`). The reason is said
 *  on the disabled control. */
export function stopBlocker(
  task: Pick<OrchestrationTask, "status" | "activeAttemptId" | "stopped"> | undefined,
  attempt: { id: string; status: string } | undefined,
  gated: boolean,
): string | null {
  if (!task) return "This task is no longer on the run.";
  if (task.stopped) return "You stopped this task's worker. Only your Start starts it again.";
  const unsettled = !!attempt && task.activeAttemptId === attempt.id
    && (attempt.status === "preparing" || attempt.status === "running" || (attempt.status === "blocked" && gated));
  if (unsettled) return null;
  if (task.status === "completed") return "This task has finished. No worker is running on it, so there is nothing to stop.";
  if (task.status === "cancelled") return "This task was cancelled. No worker is running on it, so there is nothing to stop.";
  return "No worker is running on this task yet, so there is nothing to stop.";
}

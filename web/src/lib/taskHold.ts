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

type Held = Pick<OrchestrationTask, "runId" | "status" | "supersededBy" | "stopped" | "heldByPlan" | "heldByReopen" | "reopens">;

/** When the oldest reopen whose notice is still owed was made, by the
 *  host's clock. `null` when the ledger names none. */
export function reopenOwedSince(task: Pick<OrchestrationTask, "reopens">): number | null {
  const owed = (task.reopens ?? []).filter((reopen) => reopen.noticeDelivered !== true && Number.isFinite(reopen.at));
  return owed.length ? Math.min(...owed.map((reopen) => reopen.at)) : null;
}

/** What holds `task`, or `null` when nothing does: it is settled, running,
 *  replaced, or free to start. `tasks` are the ledger's, for the plan's
 *  reading; `now` is the reader's clock, and only the warning colour of a
 *  reopen that lasts depends on it. */
export function taskHold(
  task: Held,
  run: Pick<OrchestrationRun, "planApproval"> | undefined,
  tasks: readonly Pick<OrchestrationTask, "runId" | "heldByPlan">[],
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
    const since = reopenOwedSince(task);
    const lasted = since !== null && now - since >= REOPEN_LASTED_MS;
    return lasted
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

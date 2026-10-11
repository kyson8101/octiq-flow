// A task the coordinator reopened with new instructions.
//
// A coordinator may reopen a task the person approved, and hand it new
// instructions, without a new approval. The person's rule is that the page
// must show it, so the host writes one durable event into the coordinator's
// transcript (`octiq_task_reopened`) and the chat draws one folded line for
// it: which task, for whom, which attempt. The instructions are the
// coordinator's own prose, so they are behind the line's disclosure, whole,
// and never on the run's strip.
//
// Everything here is read off that one event. A field the host did not send
// is left out of the line; nothing is worked out in its place.
import { count, digits, lineCount } from "./cardFold";
import type { OrchestrationSnapshot } from "./orchestration";
import { taskGated } from "./runWaits";
import { stopBlocker } from "./taskHold";

export type TaskReopened = {
  /** One line per reopening: the same event read twice draws once. */
  id: string;
  runId: string;
  taskId: string;
  title: string;
  /** The registered agent it was handed to, by name. Absent: nobody named. */
  assignee: string | null;
  /** The number of the attempt the reopening starts. */
  attempt: number | null;
  /** The new instructions, whole. */
  spec: string;
  /** How long the instructions it replaces were, in characters. */
  previousSpecChars: number | null;
  at: number | null;
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const whole = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/** The event as the host wrote it, or `null` when it names no task. The
 *  assignee is taken as a name or as the ledger's `{ id, name }`, and the
 *  attempt as a number or as `{ number }`: both are how the ledger says them
 *  elsewhere. */
export function readTaskReopened(event: Record<string, unknown>): TaskReopened | null {
  // The host writes its chat events' own fields in snake case and the
  // ledger's in camel case; the event is read either way.
  const runId = text(event.runId ?? event.run_id);
  const taskId = text(event.taskId ?? event.task_id);
  if (!runId || !taskId) return null;
  const who = event.assignee;
  const assignee = text(who) || (who && typeof who === "object" ? text((who as { name?: unknown }).name) : "");
  const tried = event.attempt;
  const attempt = whole(tried) ?? (tried && typeof tried === "object" ? whole((tried as { number?: unknown }).number) : null);
  const at = whole(event.at);
  return {
    // One line per reopening, which is the task, the attempt it starts and
    // when the host stamped it. The attempt alone is not enough: the host
    // numbers the attempt a reopening WILL start, so a task reopened twice
    // before it is dispatched says the same number both times, and the
    // second set of instructions has to be shown as much as the first.
    id: `reopened-${taskId}-${attempt && attempt > 0 ? attempt : 0}-${at ?? 0}`,
    runId, taskId,
    title: text(event.title).trim() || "a task",
    assignee: assignee.trim() || null,
    attempt: attempt && attempt > 0 ? attempt : null,
    spec: text(event.spec),
    previousSpecChars: whole(event.previousSpecChars ?? event.previous_spec_chars),
    at,
  };
}

/** "Reopened Build the ledger for OCTIQ BE · attempt 2". */
export function reopenedHeadline(reopened: Pick<TaskReopened, "title" | "assignee" | "attempt">): string {
  return [
    `Reopened ${reopened.title}${reopened.assignee ? ` for ${reopened.assignee}` : ""}`,
    reopened.attempt ? `attempt ${reopened.attempt}` : null,
  ].filter(Boolean).join(" · ");
}

/** What is behind the line, by name and size: "New instructions · 14 lines",
 *  and how long the ones they replace were when the host said. `null` when
 *  the host sent no instructions: there is nothing to open. */
export function reopenedFoldLabel(reopened: Pick<TaskReopened, "spec" | "previousSpecChars">): string | null {
  if (!reopened.spec.trim()) return null;
  return [
    "New instructions",
    count(lineCount(reopened.spec), "line"),
    reopened.previousSpecChars ? `was ${digits(reopened.previousSpecChars)} characters` : null,
  ].filter(Boolean).join(" · ");
}

/* ---- Stopping what a reopening started --------------------------------- */

/** What the opened line offers. The person was shown the reopen and did not
 *  approve its words, so the one thing they can do about it is here: stop
 *  the task's worker (`orchestration_task_stop`), which leaves the run going
 *  and the task held until they start it.
 *
 *  - `can`: a worker is on the task, and this is its latest reopening.
 *  - `stopped`: they stopped it. The line says what that left.
 *  - `cannot`: there is nothing to stop, and `reason` says why. */
export type ReopenedStop =
  | { state: "can" }
  | { state: "stopped"; note: string }
  | { state: "cannot"; reason: string };

/** What the row and the line both say of a task the person stopped, in the
 *  words of the host's refusal of anyone else's start of it. */
export const STOPPED_NOTE = "Stopped by you. Only your Start starts it again: Start is on its row in the run panel.";

/** What the confirm asks, in the app's own dialog (`components/Confirm`). */
export function stopConfirm(reopened: Pick<TaskReopened, "title">) {
  return {
    title: "Stop this task's worker?",
    body: `${reopened.title}: its worker is stopped and the run goes on. The task is then held, and only your Start starts it again.`,
    confirmLabel: "Stop worker",
    cancelLabel: "Keep it running",
    danger: true,
  };
}

/** Read off the ledger, and nothing else: the line never guesses that a
 *  worker is running. A `null` snapshot is a ledger not read yet. */
export function reopenedStop(
  reopened: Pick<TaskReopened, "taskId" | "at" | "attempt">,
  snapshot: OrchestrationSnapshot | null,
): ReopenedStop {
  if (!snapshot) return { state: "cannot", reason: "The run's ledger has not been read yet." };
  const task = snapshot.tasks.find((item) => item.id === reopened.taskId);
  if (!task) return { state: "cannot", reason: "This task is no longer on the run." };
  if (task.stopped) return { state: "stopped", note: STOPPED_NOTE };
  // A later reopening of the same task has a line of its own, and that is
  // the one its worker is on.
  const later = (task.reopens ?? []).some((reopen) =>
    (reopened.at !== null && reopen.at > reopened.at) || (reopened.attempt !== null && reopen.attempt > reopened.attempt));
  if (later) return { state: "cannot", reason: "This task was reopened again since. Stop is on its latest reopening." };
  const attempt = snapshot.attempts.find((item) => item.id === task.activeAttemptId);
  const blocker = stopBlocker(task, attempt, taskGated(snapshot, task.id));
  return blocker ? { state: "cannot", reason: blocker } : { state: "can" };
}

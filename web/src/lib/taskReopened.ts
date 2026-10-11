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

export type TaskReopened = {
  /** One line per attempt of a task: the same event read twice draws once. */
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
    // The attempt names the reopening; a host that sent none is told apart
    // by when it happened.
    id: `reopened-${taskId}-${attempt && attempt > 0 ? attempt : `at${at ?? 0}`}`,
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

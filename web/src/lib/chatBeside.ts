// A task's chat open beside its main chat: [ Main | Task ].
//
// Only ever by choice. Clicking a task opens its chat full-width, as it always
// has; "Open beside main" is the one way in, and the layout does not change on
// its own because a window got wider. Two panes and no more: another task
// opened beside the same main replaces the right one.
//
// "Main" is the coordinator the LEDGER names for the task's own run — never the
// configured head, the chat tree's top-most ancestor, or whatever General chat
// happens to be open. A delegated run's coordinator is not the head above it.
import type { OrchestrationSnapshot } from "./orchestration";

/** The person's layout choice: this main chat, with this task chat beside it.
 *  Both are chat ids (no `chat:` prefix). */
export type Beside = { main: string; task: string };

/** Narrowest a pane may be and still hold a transcript and a composer. */
export const BESIDE_MIN_PANE = 360;
/** The divider between the panes. */
const BESIDE_GUTTER = 1;

const idOf = (key: string): string | null => (key.startsWith("chat:") ? key.slice(5) || null : null);

/** The chat that coordinates the run a worker chat belongs to, or null when
 *  the ledger has no attempt for it (not a task chat, or not loaded yet). */
export function taskCoordinator(snapshot: OrchestrationSnapshot | null, taskId: string): string | null {
  if (!snapshot) return null;
  const key = `chat:${taskId}`;
  const attempt = snapshot.attempts.find((candidate) => candidate.workerChatKey === key);
  if (!attempt) return null;
  const run = snapshot.runs.find((candidate) => candidate.id === attempt.runId);
  const main = run ? idOf(run.coordinatorChatKey) : null;
  return main && main !== taskId ? main : null;
}

/** What "Open beside main" on a task chat opens, or null when there is no
 *  main to put it beside. */
export function besideFor(snapshot: OrchestrationSnapshot | null, taskChatKey: string): Beside | null {
  const task = idOf(taskChatKey);
  if (!task) return null;
  const main = taskCoordinator(snapshot, task);
  return main ? { main, task } : null;
}

/** The task chat to draw beside the chat on screen, or null for one pane.
 *
 *  Only while the main it was chosen for is the chat on screen, the ledger
 *  still says that main coordinates it, and the task's chat exists here. A
 *  choice that fails any of those is kept, not thrown away — it is still what
 *  the person asked for once the ledger or chat list arrives. */
export function besideTask(
  beside: Beside | null,
  onScreen: string | null,
  snapshot: OrchestrationSnapshot | null,
  exists: (id: string) => boolean,
): string | null {
  if (!beside || !onScreen || beside.main !== onScreen) return null;
  if (taskCoordinator(snapshot, beside.task) !== beside.main) return null;
  return exists(beside.task) ? beside.task : null;
}

/** Whether both panes fit in `width` — the chat area actually left over after
 *  the sidebar, the run column and any side panel took theirs. */
export function roomBeside(width: number): boolean {
  return width >= BESIDE_MIN_PANE * 2 + BESIDE_GUTTER;
}

/** A remembered choice read back, or null for anything malformed. */
export function readBeside(raw: string | null): Beside | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Beside> | null;
    if (!value || typeof value.main !== "string" || typeof value.task !== "string") return null;
    if (!value.main || !value.task || value.main === value.task) return null;
    return { main: value.main, task: value.task };
  } catch {
    return null;
  }
}

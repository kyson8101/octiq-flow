// Work that outlives the call that started it.
//
// A background command answers the INSTANT it starts. The card gets its tick,
// the turn ends, the strip above the composer goes back to saying "Enter for a
// new line" — and a `codex exec` that will run for twenty minutes is left with
// nothing on screen saying so. Every part of the UI has told the truth about
// its own half and the whole screen is a lie: it reads as finished.
//
// The harness knows. A `task_started` names the run and the call that started
// it, and a `task_notification` names its ending — minutes apart, with a whole
// turn's worth of events in between. This is the roster kept between the two.
//
// It holds a SUBAGENT as well as a command, even though the agent rail already
// draws one. The rail answers "what has this conversation started", which is
// history and includes what has finished; this answers "is anything running
// right now", which is the one question the screen was not answering at all.
import { commandHead } from "./toolGroups";

/** One piece of work still going, after the call that started it answered. */
export type BackgroundTask = {
  /** `task_id` — the harness's own key, stable from start to notification. */
  id: string;
  /** The call that started it, when the event named one. A background command
   *  always does; that id is how its card knows to keep pulsing. */
  toolUseId?: string;
  /** What to call it on a one-line strip. */
  label: string;
  /** `local_bash`, `local_agent`, `local_workflow`. */
  kind: string;
  /** When we first saw it start. The stream carries no start time for a run,
   *  so this is stamped on arrival — the same way the agent rail does it. */
  startedAt: number;
};

/** What to call a run, from what the start event happened to carry.
 *
 *  The caller's own description first: it was written for a human to read. A
 *  command is named by the PROGRAM it runs rather than the whole line, because
 *  the strip is one line on a phone and `cd /Users/… && codex exec --json …`
 *  is not a label. The kind is the last resort, and it is still better than an
 *  empty chip. */
export function taskLabel(kind: string, description: string, command: string): string {
  if (description.trim()) return description.trim();
  if (command.trim()) return commandHead(command);
  if (kind === "local_agent") return "subagent";
  if (kind === "local_workflow") return "workflow";
  return "background command";
}

/** The calls whose work is still running, by `tool_use` id.
 *
 *  A card looks itself up in here. Work that named no call is left out rather
 *  than guessed at: marking the wrong card as still busy is worse than marking
 *  none, and the strip counts it either way. */
export function backgroundCalls(tasks: BackgroundTask[]): Set<string> {
  const ids = new Set<string>();
  for (const task of tasks) if (task.toolUseId) ids.add(task.toolUseId);
  return ids;
}

/** The strip's whole content, or null when there is nothing to say.
 *
 *  One label for any number of runs, and it is the OLDEST one — the longest
 *  wait is the one the reader is actually asking about, and it carries the
 *  biggest number, which is the part that answers "is this going anywhere". */
export type BackgroundSummary = { count: number; label: string; elapsedMs: number };

export function backgroundSummary(
  tasks: BackgroundTask[],
  now: number,
): BackgroundSummary | null {
  if (tasks.length === 0) return null;
  const oldest = tasks.reduce((a, b) => (b.startedAt < a.startedAt ? b : a));
  return {
    count: tasks.length,
    label: oldest.label,
    elapsedMs: Math.max(0, now - oldest.startedAt),
  };
}

import { executionNeedsAttention } from "./agentTaskBoard";
import { ledgerWaits, type RunWaits, type Waiting } from "./runWaits";
import {
  checkFailed, finishedWell, isSettled, isStuck,
  type OrchestrationAttempt, type OrchestrationRun, type OrchestrationSnapshot, type OrchestrationTask,
} from "./orchestration";

/** The run panel's three views of one run. Decisions and plan approval are
 *  not a tab: they sit above all three, so no tab can hide them. */
export type RunTab = "tasks" | "notifications" | "log";
export const RUN_TABS: readonly RunTab[] = ["tasks", "notifications", "log"];

/** Roving focus across a tablist: arrows wrap, Home/End jump. Anything else
 *  is not the tablist's key and answers null. */
export function nextRunTab(current: RunTab, key: string): RunTab | null {
  const at = RUN_TABS.indexOf(current);
  switch (key) {
    case "ArrowRight": return RUN_TABS[(at + 1) % RUN_TABS.length];
    case "ArrowLeft": return RUN_TABS[(at - 1 + RUN_TABS.length) % RUN_TABS.length];
    case "Home": return RUN_TABS[0];
    case "End": return RUN_TABS[RUN_TABS.length - 1];
    default: return null;
  }
}

export type RunAttention = {
  /** What waits on the person in this run, once each: exactly
   *  `runWaits(...).person`, the number the strip says. */
  decisions: number;
  /** The one decision is the plan's approval. */
  planOnly: boolean;
  /** Blocked or failing tasks not already named by a decision: a task that
   *  failed or is blocked, one that completed with a failed check, and one
   *  whose worker is in trouble. */
  blocked: number;
  total: number;
};

/** What in this run is owed, counted once each. `waits` is `lib/runWaits`'
 *  reading of the run: who is waited on is decided there and nowhere here.
 *  A task blocked BY a decision is the decision; saying it twice reads as
 *  two problems when there is one. */
export function runAttention(
  run: OrchestrationRun,
  tasks: readonly OrchestrationTask[],
  attempts: readonly OrchestrationAttempt[],
  waits: RunWaits,
): RunAttention {
  // A stopped run cannot retry anything, so its failures are history, not owed.
  const blocked = run.status === "stopped" ? 0 : tasks.filter((task) => task.runId === run.id && !waits.gated.has(task.id)
    && !waits.tasks.get(task.id)?.person.length
    && (isStuck(task) || checkFailed(task)
      || executionNeedsAttention(attempts.find((attempt) => attempt.id === task.activeAttemptId)))).length;
  const decisions = waits.person.length;
  return { decisions, planOnly: decisions === 1 && waits.person[0].kind === "plan", blocked, total: decisions + blocked };
}

/** What the top bar's Tasks button carries for one chat's runs: how many
 *  tasks the column holds, and how many decisions in it wait on the person
 *  (`lib/runWaits`, with the cards the page holds). Archived runs are
 *  history and their tasks are not counted. */
export function taskColumnCounts(snapshot: OrchestrationSnapshot, held?: Waiting): { tasks: number; decisions: number } {
  const ids = new Set(snapshot.runs.filter((run) => run.archivedAt == null).map((run) => run.id));
  return {
    tasks: snapshot.tasks.filter((task) => ids.has(task.runId)).length,
    decisions: ledgerWaits(snapshot, held).person.length,
  };
}

/** Short enough for a collapsed row. Decisions lead: they wait on the person. */
export function attentionLabel(attention: RunAttention): string | null {
  if (!attention.total) return null;
  if (attention.decisions) {
    if (attention.planOnly) return "Approval needed";
    return `${attention.decisions} to decide`;
  }
  return `${attention.blocked} blocked`;
}

/** Where one person is on a run, most urgent first. "working" is only ever a
 *  worker actually executing — handed a task is "assigned", however recently.
 *  "failed" is a task of theirs that went wrong with nothing open to wait
 *  for: it failed, is blocked, or completed with a failed check. "blocked"
 *  is a wait: a decision is open on it, or its worker is in trouble. "done"
 *  is only ever work that finished well. */
export type PersonState = "working" | "failed" | "blocked" | "assigned" | "done" | "stopped";
const PERSON_ORDER: PersonState[] = ["working", "failed", "blocked", "assigned", "done", "stopped"];

export type RunPerson = {
  id: string;
  /** The registration's current name; the name the task was given when the
   *  agent is not in the roster. */
  name: string;
  avatar?: string;
  /** The roster is loaded and no longer has this agent. */
  removed: boolean;
  state: PersonState;
  tasks: number;
};

type RosterEntry = { id: string; name: string; avatar?: string };

function personState(
  task: OrchestrationTask,
  attempt: OrchestrationAttempt | undefined,
  gated: boolean,
): PersonState {
  if (finishedWell(task)) return "done";
  if (task.status === "cancelled") return "stopped";
  if (task.supersededBy) return "done";
  // A decision open on it is a wait, whatever the task's own status.
  if (gated) return "blocked";
  if (isStuck(task) || checkFailed(task)) return "failed";
  if (executionNeedsAttention(attempt)) return "blocked";
  const executing = !!attempt && (attempt.execution
    ? ["executing", "waiting_tool"].includes(attempt.execution.state)
    : attempt.status === "running");
  return task.status === "running" && executing ? "working" : "assigned";
}

/** Everyone a run's tasks were handed to, once each, with their most urgent
 *  state across their tasks: people working first, then stuck, then waiting
 *  their turn, then finished. `gated` is the tasks an open decision holds
 *  (`runWaits(...).gated`). */
export function runPeople(
  run: OrchestrationRun,
  tasks: readonly OrchestrationTask[],
  attempts: readonly OrchestrationAttempt[],
  gated: ReadonlySet<string>,
  roster: readonly RosterEntry[],
): RunPerson[] {
  const people = new Map<string, RunPerson>();
  for (const task of tasks) {
    if (task.runId !== run.id || !task.assignee) continue;
    const mine = attempts.filter((attempt) => attempt.taskId === task.id);
    const attempt = mine.find((candidate) => candidate.id === task.activeAttemptId)
      ?? [...mine].sort((a, b) => b.number - a.number)[0];
    // A stopped run's unfinished work is stopped, whatever its last attempt said.
    const state = run.status === "stopped" && !isSettled(task) ? "stopped" : personState(task, attempt, gated.has(task.id));
    const known = people.get(task.assignee.id);
    if (known) {
      known.tasks += 1;
      if (PERSON_ORDER.indexOf(state) < PERSON_ORDER.indexOf(known.state)) known.state = state;
      continue;
    }
    const registered = roster.find((agent) => agent.id === task.assignee!.id);
    people.set(task.assignee.id, {
      id: task.assignee.id,
      name: registered?.name ?? task.assignee.name,
      avatar: registered?.avatar,
      removed: roster.length > 0 && !registered,
      state,
      tasks: 1,
    });
  }
  // Stable: a person keeps their place among others in the same state.
  return [...people.values()].sort((a, b) => PERSON_ORDER.indexOf(a.state) - PERSON_ORDER.indexOf(b.state));
}

/** The main chat of the run on screen — the coordinator the ledger names for
 *  it, never a guess from the chat tree or a configured lead. With no run
 *  selected, the panel's own coordinator. */
export function mainChatTarget(
  runs: readonly OrchestrationRun[],
  selectedId: string | null,
  fallback: string | null,
): string | null {
  return (runs.find((run) => run.id === selectedId) ?? runs[0])?.coordinatorChatKey ?? fallback;
}

export function splitArchived(
  runs: readonly OrchestrationRun[],
  /** An archived run that still holds something for the person: a card the
   *  page has for one of its workers (`lib/runWaits`). It is counted on the
   *  strip and the badge, so it is not put away behind Archived, where its
   *  decision would be a count with nowhere to go. */
  holds: (run: OrchestrationRun) => boolean = () => false,
) {
  const live: OrchestrationRun[] = [];
  const archived: OrchestrationRun[] = [];
  for (const run of runs) (run.archivedAt != null && !holds(run) ? archived : live).push(run);
  return { live, archived };
}

export type StopOutcome =
  | { ok: true; archived: boolean }
  | { ok: false; stopped: boolean; error: string };

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** Stop, then — only once the stop has landed — archive. A failed stop never
 *  archives, and a failed archive is reported as exactly that: the run IS
 *  stopped, and stays in the list. */
export async function stopRun(invoke: Invoke, run: OrchestrationRun, archive: boolean): Promise<StopOutcome> {
  try {
    await invoke("orchestration_run_stop", {
      actorChatKey: run.coordinatorChatKey,
      runId: run.id,
      reason: "Stopped by the person from the Orchestrator panel.",
    });
  } catch (problem) {
    return { ok: false, stopped: false, error: `Could not stop this run: ${messageOf(problem)}${archive ? " Nothing was archived." : ""}` };
  }
  if (!archive) return { ok: true, archived: false };
  try {
    await setRunArchived(invoke, run, true);
  } catch (problem) {
    return { ok: false, stopped: true, error: `Stopped, but could not archive: ${messageOf(problem)} The run stays in the list.` };
  }
  return { ok: true, archived: true };
}

export function setRunArchived(invoke: Invoke, run: OrchestrationRun, archived: boolean) {
  return invoke("orchestration_run_archive", { actorChatKey: run.coordinatorChatKey, runId: run.id, archived });
}

function messageOf(problem: unknown): string {
  return String((problem as Error)?.message ?? problem);
}

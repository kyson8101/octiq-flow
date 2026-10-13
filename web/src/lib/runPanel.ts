import { executionNeedsAttention } from "./agentTaskBoard";
import { ledgerWaits, type RunWaits, type Waiting } from "./runWaits";
import {
  failureShown, finishedWell, isSettled,
  type OrchestrationAttempt, type OrchestrationRun, type OrchestrationSnapshot, type OrchestrationTask,
} from "./orchestration";

/** The run panel's three views of one run. Decisions and plan approval are
 *  not a tab: they sit above all three, so no tab can hide them. */
export type RunTab = "tasks" | "notifications" | "log";
export const RUN_TABS: readonly RunTab[] = ["tasks", "notifications", "log"];

/** Roving focus across a tablist: arrows wrap, Home/End jump. Anything else
 *  is not the tablist's key and answers null. */
export function nextRunTab(current: RunTab, key: string): RunTab | null {
  return nextTab(RUN_TABS, current, key);
}

function nextTab<T>(tabs: readonly T[], current: T, key: string): T | null {
  const at = tabs.indexOf(current);
  switch (key) {
    case "ArrowRight": return tabs[(at + 1) % tabs.length];
    case "ArrowLeft": return tabs[(at - 1 + tabs.length) % tabs.length];
    case "Home": return tabs[0];
    case "End": return tabs[tabs.length - 1];
    default: return null;
  }
}

/** The two views of an opened task row. Steps is what a row is opened for,
 *  so it is the one a row opens on, whether or not any were reported. What
 *  starts or decides something is in neither: it stands above both. */
export type TaskTab = "steps" | "details";
export const TASK_TABS: readonly TaskTab[] = ["steps", "details"];
export const TASK_TAB_LABEL: Record<TaskTab, string> = { steps: "Steps", details: "Details" };
/** What the Steps tab says of a task whose worker reported no checklist. */
export const NO_STEPS = "No steps reported yet";

/** What a key does on a row's tablist. `to` is the tab it moves to. `drop`
 *  says the key is the tablist's and goes no further: a key that moved it,
 *  or the repeat of one held down, which moves nothing and presses nothing
 *  (an arrow held would flick between the two views, and Enter or Space held
 *  would press the tab again and again). Any other key is not the
 *  tablist's. */
export function taskTabKey(current: TaskTab, event: { key: string; repeat: boolean }): { to: TaskTab | null; drop: boolean } {
  const to = nextTab(TASK_TABS, current, event.key);
  if (event.repeat) return { to: null, drop: to !== null || event.key === "Enter" || event.key === " " || event.key === "Spacebar" };
  return { to, drop: to !== null };
}

export type RunAttention = {
  /** What waits on the person in this run, once each: exactly
   *  `runWaits(...).person`, the number the strip says. */
  decisions: number;
  /** The one decision is the plan's approval. */
  planOnly: boolean;
  /** How many of the decisions are a failure's own: the failure the host
   *  says waits on the person, or the gate its coordinator opened about it.
   *  When every decision is one, the button says "N failed", in the danger
   *  colour. */
  failures: number;
  /** Failing tasks not already named by a decision, and tasks whose worker
   *  is in trouble. */
  blocked: number;
  /** How many of those are failures and not a worker in trouble. Only on a
   *  host that does not say whose move a failure is: a task that failed, one
   *  blocked with no decision open, one that completed with a failed check.
   *  Where the host says, a failure that waits on the person is a decision
   *  above, and one its coordinator is fixing is counted nowhere. */
  failed: number;
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
  const owed = run.status === "stopped" ? [] : tasks.filter((task) => task.runId === run.id && !waits.gated.has(task.id)
    && !waits.tasks.get(task.id)?.person.length);
  // Whether a task is a failure, and whether that is said, is one reader's
  // (`orchestration.failureShown`). A failure its coordinator is fixing, or
  // one that is history, is not a worker in trouble either: the last
  // attempt of a failed task is a failed one.
  const failed = owed.filter((task) => failureShown(task) === "red").length;
  const troubled = owed.filter((task) => failureShown(task) === null
    && executionNeedsAttention(attempts.find((attempt) => attempt.id === task.activeAttemptId))).length;
  const blocked = failed + troubled;
  const decisions = waits.person.length;
  const failures = waits.person.filter((wait) => wait.failure).length;
  return { decisions, planOnly: decisions === 1 && waits.person[0].kind === "plan", failures, blocked, failed, total: decisions + blocked };
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

/** Short enough for a collapsed row. Decisions lead: they wait on the
 *  person, and when every one of them is a failure's they are said as that.
 *  Then what failed, on a host that does not say whose move a failure is;
 *  "blocked" is only ever a worker in trouble (stalled, disconnected, out of
 *  capacity). */
export function attentionLabel(attention: RunAttention): string | null {
  if (!attention.total) return null;
  if (attention.decisions) {
    if (attention.planOnly) return "Approval needed";
    if (attention.failures === attention.decisions) return `${attention.failures} failed`;
    return `${attention.decisions} to decide`;
  }
  if (attention.failed) return `${attention.failed} failed`;
  return `${attention.blocked} blocked`;
}

/** The button's colour: the decision colour for what waits on the person,
 *  the danger colour for a failure, the warning colour for a worker in
 *  trouble. */
export function attentionTone(attention: RunAttention): "decision" | "failed" | "blocked" {
  if (attention.decisions) return attention.failures === attention.decisions ? "failed" : "decision";
  return attention.failed ? "failed" : "blocked";
}

/** The button's sentence: every count it stands for, whole. */
export function attentionSpoken(attention: RunAttention): string {
  const troubled = attention.blocked - attention.failed;
  // A failure that waits on the person is among the decisions, and said.
  const failed = attention.failed + attention.failures;
  return [
    attention.decisions ? `${attention.decisions} ${attention.decisions === 1 ? "decision" : "decisions"} waiting` : null,
    failed ? `${failed} ${failed === 1 ? "task" : "tasks"} failed` : null,
    troubled ? `${troubled} ${troubled === 1 ? "task needs" : "tasks need"} attention` : null,
  ].filter(Boolean).join(", ");
}

/** Where one person is on a run, most urgent first. "working" is only ever a
 *  worker actually executing — handed a task is "assigned", however recently.
 *  "failed" is a failure of theirs that is red (`orchestration.failureShown`):
 *  one the host says waits on the person; on a host that does not say, a
 *  task that failed, is blocked with nothing open, or completed with a
 *  failed check. A failure the coordinator is fixing is "assigned": the task
 *  is theirs and nobody is on it right now. "blocked" is a wait: a decision
 *  is open on it, or its worker is in trouble. "done" is only ever work that
 *  finished well. */
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
  const failure = failureShown(task);
  if (failure === "red") return "failed";
  // The coordinator has it: nothing failed that anyone here must see, and
  // its last attempt, a failed one, is not a worker in trouble.
  if (failure === "quiet") return "assigned";
  if (failure === "history") return "stopped";
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

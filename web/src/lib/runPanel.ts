import { executionNeedsAttention } from "./agentTaskBoard";
import type {
  OrchestrationAttempt, OrchestrationGate, OrchestrationRun, OrchestrationTask,
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
  /** Open decisions plus a plan waiting for approval: things only the
   *  person can settle. */
  decisions: number;
  /** Blocked or failing tasks not already named by a decision. */
  blocked: number;
  total: number;
};

/** What in this run is owed, counted once each. A task blocked BY a decision
 *  is the decision; saying it twice reads as two problems when there is one. */
export function runAttention(
  run: OrchestrationRun,
  tasks: readonly OrchestrationTask[],
  attempts: readonly OrchestrationAttempt[],
  gates: readonly OrchestrationGate[],
): RunAttention {
  const open = gates.filter((gate) => gate.runId === run.id && gate.status === "open");
  const gated = new Set(open.flatMap((gate) => gate.taskId ? [gate.taskId] : []));
  const plan = run.planApproval?.status === "pending" && ["planning", "running", "waiting"].includes(run.status) ? 1 : 0;
  // A stopped run cannot retry anything, so its failures are history, not owed.
  const blocked = run.status === "stopped" ? 0 : tasks.filter((task) => task.runId === run.id && !gated.has(task.id)
    && (task.status === "blocked" || task.status === "failed"
      || executionNeedsAttention(attempts.find((attempt) => attempt.id === task.activeAttemptId)))).length;
  const decisions = open.length + plan;
  return { decisions, blocked, total: decisions + blocked };
}

/** Short enough for a collapsed row. Decisions lead: they wait on the person. */
export function attentionLabel(attention: RunAttention, planPending: boolean): string | null {
  if (!attention.total) return null;
  if (attention.decisions) {
    if (planPending && attention.decisions === 1) return "Approval needed";
    return `${attention.decisions} to decide`;
  }
  return `${attention.blocked} blocked`;
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

export function splitArchived(runs: readonly OrchestrationRun[]) {
  const live: OrchestrationRun[] = [];
  const archived: OrchestrationRun[] = [];
  for (const run of runs) (run.archivedAt != null ? archived : live).push(run);
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

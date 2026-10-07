import { useEffect, useState } from "react";
import { isStuck, type ExecutionState, type OrchestrationAttempt, type OrchestrationSnapshot, type OrchestrationTask } from "./orchestration";
import type { TaskReport } from "./chatTask";

export function taskAttempts(snapshot: OrchestrationSnapshot, task: OrchestrationTask): OrchestrationAttempt[] {
  return snapshot.attempts.filter((attempt) => attempt.taskId === task.id)
    .sort((a, b) => b.number - a.number || b.createdAt - a.createdAt);
}

export function currentAttempt(snapshot: OrchestrationSnapshot, task: OrchestrationTask): OrchestrationAttempt | undefined {
  const attempts = taskAttempts(snapshot, task);
  return attempts.find((attempt) => attempt.id === task.activeAttemptId) ?? attempts[0];
}

export function attemptIsLive(snapshot: OrchestrationSnapshot, attempt: OrchestrationAttempt): boolean {
  if (attempt.status === "running" || attempt.status === "preparing") return true;
  // A decision gate pauses an attempt; a blocked worker report settles it.
  return attempt.status === "blocked" && snapshot.tasks.some((task) => task.activeAttemptId === attempt.id)
    && snapshot.gates.some((gate) => gate.taskId === attempt.taskId && gate.status === "open");
}

/** Wall time includes preparation and decision waits; parallel workers are not summed. */
export function runElapsed(snapshot: OrchestrationSnapshot, runId: string, now: number): number | null {
  const attempts = snapshot.attempts.filter((attempt) => attempt.runId === runId);
  if (!attempts.length) return null;
  const start = Math.min(...attempts.map((attempt) => attempt.createdAt));
  const end = attempts.some((attempt) => attemptIsLive(snapshot, attempt)) ? now
    : Math.max(...attempts.map((attempt) => attempt.finishedAt ?? attempt.updatedAt));
  return Math.max(0, end - start);
}

/** Total attempt time for one assignment, including retries but excluding gaps between them. */
export function taskElapsed(snapshot: OrchestrationSnapshot, task: OrchestrationTask, now: number): number | null {
  const attempts = taskAttempts(snapshot, task);
  if (!attempts.length) return null;
  return attempts.reduce((total, attempt) => total + Math.max(0,
    (attemptIsLive(snapshot, attempt) ? now : attempt.finishedAt ?? attempt.updatedAt) - attempt.createdAt), 0);
}

export function taskProgress(task: OrchestrationTask, report?: TaskReport) {
  const total = report?.steps.length ?? 0;
  const done = report?.steps.filter((step) => step.state === "done").length ?? 0;
  const percent = task.status === "completed" ? 100 : total ? Math.round(done / total * 100)
    : task.status === "pending" || task.status === "ready" ? 0 : null;
  return { total, done, remaining: total - done, percent };
}

/** A task row's own reading of its worker's checklist: the counts as
 *  reported and the step it said it was on. Only the attempt the row shows
 *  counts — every attempt has a chat of its own, and a report made before
 *  this attempt existed belongs to another one. No steps, nothing to say:
 *  never `0/0`, and never the completion fallback `taskProgress` gives a
 *  finished task. The first active step names it, as the checklist lists
 *  them; a blank title names nothing. */
export type TaskStepSummary = { done: number; total: number; step: string | null; current: boolean };

export function taskStepSummary(task: OrchestrationTask, attempt: OrchestrationAttempt | undefined, report?: TaskReport): TaskStepSummary | null {
  if (!attempt || !report?.steps.length || report.reportedAt < attempt.createdAt) return null;
  const step = report.steps.find((item) => item.state === "active")?.title.trim() || null;
  return {
    done: report.steps.filter((item) => item.state === "done").length,
    total: report.steps.length,
    step,
    // Still underway only while the task is running on this very attempt.
    // A blocked, failed or finished one keeps the step it stopped on, as
    // the last one it reported — never as one it is still doing.
    current: task.status === "running" && task.activeAttemptId === attempt.id
      && (attempt.status === "running" || attempt.status === "preparing"),
  };
}

export function stepCountLabel(summary: TaskStepSummary): string {
  return `${summary.done}/${summary.total} ${summary.total === 1 ? "step" : "steps"}`;
}

export function stepLabel(summary: TaskStepSummary): string | null {
  if (!summary.step) return null;
  return summary.current ? summary.step : `Last step: ${summary.step}`;
}

export const TASK_LABELS: Record<OrchestrationTask["status"], string> = {
  pending: "Queued", ready: "Ready", running: "Working", blocked: "Blocked",
  completed: "Done", failed: "Failed", cancelled: "Cancelled",
};

export const EXECUTION_LABELS: Record<ExecutionState, string> = {
  queued: "Queued", executing: "Executing", waiting_tool: "Waiting for a tool", retrying: "Retrying",
  capacity_blocked: "Capacity blocked", stalled: "Stalled", disconnected: "Disconnected",
  awaiting_report: "Awaiting worker report", blocked: "Blocked", failed: "Failed",
  completed: "Completed", cancelled: "Cancelled",
};

/** The one word a task row leads with. A worker parked on an approval card
 *  says so rather than "waiting for a tool" (feedback ee0a43b0), and a
 *  check that finished but failed never reads as plain "Done". */
export function taskStateLabel(
  task: OrchestrationTask,
  attempt: OrchestrationAttempt | undefined,
  decisions: readonly { attemptId: string; status: string }[] = [],
): string {
  // A settled check's answer outranks how its worker's process ended:
  // "Completed" alone is exactly the word that hid a failed review.
  // Its history stays readable on the row; the word says nothing is owed.
  if (task.supersededBy) return `${TASK_LABELS[task.status]} · replaced`;
  if (task.status === "completed" && (task.verdict === "fail" || (task.kind && task.kind !== "work"))) {
    return task.verdict === "fail" ? "Done · check failed" : task.verdict === "pass" ? "Done · passed" : "Done · no verdict";
  }
  if (task.activeAttemptId === attempt?.id && proposedReportState(attempt) === "proposed"
    && (attempt?.status === "running" || attempt?.status === "preparing")) {
    return "Report proposed · coordinator to confirm";
  }
  if (attempt?.execution && task.activeAttemptId === attempt.id) {
    const state = attempt.execution.state;
    const approval = decisions.some((d) => d.attemptId === attempt.id && d.status === "pending");
    if (approval && (state === "waiting_tool" || state === "awaiting_report")) return "Awaiting approval";
    const environment = attempt.execution.pendingTools?.["octiq:environment"];
    if (environment) return environment.startsWith("Waiting for environment capacity") ? "Waiting for an environment slot" : "Preparing environment";
    return EXECUTION_LABELS[state];
  }
  return TASK_LABELS[task.status];
}

/** A read-only worker's closing words the host held as its report: waiting
 *  for the coordinator, or the words it settled the task from. */
export function proposedReportState(attempt: OrchestrationAttempt | undefined): "proposed" | "confirmed" | null {
  const proposal = attempt?.proposedReport;
  if (!proposal) return null;
  return proposal.confirmedAt ? "confirmed" : "proposed";
}

/** The native safety decision an attempt is parked on, when the host
 *  observed one: its id and, only if the provider gave it, the exact action.
 *  Nothing when no card was observed — absence is not an approval. */
export function pendingDecision<D extends { attemptId: string; status: string }>(
  attempt: OrchestrationAttempt | undefined,
  decisions: readonly D[] = [],
): D | undefined {
  if (!attempt) return undefined;
  return decisions.find((d) => d.attemptId === attempt.id && d.status === "pending");
}

export function executionNeedsAttention(attempt?: OrchestrationAttempt): boolean {
  return !!attempt?.execution && ["capacity_blocked", "stalled", "disconnected", "failed", "awaiting_report"].includes(attempt.execution.state);
}

const TASK_PRIORITY: Record<OrchestrationTask["status"], number> = {
  blocked: 0, failed: 0, running: 1, ready: 2, pending: 3, completed: 4, cancelled: 5,
};

/** Both task lists put unfinished work first, preserving ledger order among
 *  peers and leaving the shared snapshot untouched. */
export function sortTasksByActivity(tasks: readonly OrchestrationTask[], attempts: readonly OrchestrationAttempt[]): OrchestrationTask[] {
  const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const priority = (task: OrchestrationTask) => {
    // Stale execution evidence must not promote an already settled task.
    if (task.status === "completed" || task.status === "cancelled") return TASK_PRIORITY[task.status];
    const attempt = task.activeAttemptId ? byId.get(task.activeAttemptId) : undefined;
    return executionNeedsAttention(attempt) ? 0 : TASK_PRIORITY[task.status];
  };
  return [...tasks].sort((a, b) => priority(a) - priority(b));
}

export function attemptIsExecuting(attempt: OrchestrationAttempt): boolean {
  return attempt.execution ? ["executing", "waiting_tool"].includes(attempt.execution.state) : attempt.status === "running";
}

export function taskStage(task: OrchestrationTask, report?: TaskReport, attempt?: OrchestrationAttempt): string {
  if (attempt?.execution && task.activeAttemptId === attempt.id) return EXECUTION_LABELS[attempt.execution.state];
  if (task.status !== "running") return TASK_LABELS[task.status];
  return report?.steps.find((step) => step.state === "active")?.title || report?.nextStep || "Working";
}

export function boardCounts(tasks: OrchestrationTask[], snapshot?: OrchestrationSnapshot) {
  const attemptFor = (task: OrchestrationTask) => snapshot && currentAttempt(snapshot, task);
  const done = tasks.filter((task) => task.status === "completed").length;
  return {
    done, total: tasks.length, percent: tasks.length ? Math.round(done / tasks.length * 100) : 0,
    todo: tasks.filter((task) => task.status === "pending" || task.status === "ready").length,
    running: tasks.filter((task) => task.status === "running" && (!attemptFor(task)?.execution || attemptIsExecuting(attemptFor(task)!))).length,
    blocked: tasks.filter((task) => isStuck(task) || (!task.supersededBy && executionNeedsAttention(attemptFor(task)))).length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
  };
}

export function shortWorkspacePath(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

/** True while any worker in this run is still going, which is the only time
 *  an elapsed readout has anything new to say. */
export function runIsLive(snapshot: OrchestrationSnapshot, runId?: string): boolean {
  return snapshot.attempts.some((attempt) => (!runId || attempt.runId === runId) && attemptIsLive(snapshot, attempt));
}

/** One clock for every surface that shows elapsed time, and it runs ONLY while
 *  something is moving: a settled run's numbers never change, so a timer over
 *  them is a repaint that says nothing. Ten seconds is the beat, because the
 *  labels round to whole minutes the moment they pass one. */
export function useElapsedTick(live: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/** `feature/octiq-cc2541144f174ad492ba768b5b5671c1` -> `octiq-cc25...`.
 *  A prepared worktree's branch ends in the 32 hex characters of its run id:
 *  unreadable, unmemorable, and the widest thing in the row. The whole name
 *  still belongs in the title attribute, because that is what gets pasted. */
export function shortBranch(branch: string): string {
  const leaf = branch.split("/").filter(Boolean).pop() ?? branch;
  const generated = /^(.*?)([0-9a-f]{12,})$/.exec(leaf);
  if (generated) return `${generated[1]}${generated[2].slice(0, 4)}\u2026`;
  return leaf.length > 24 ? `${leaf.slice(0, 23)}\u2026` : leaf;
}

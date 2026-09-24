import { useEffect, useState } from "react";
import type { ExecutionState, OrchestrationAttempt, OrchestrationSnapshot, OrchestrationTask } from "./orchestration";
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
    blocked: tasks.filter((task) => task.status === "blocked" || task.status === "failed" || executionNeedsAttention(attemptFor(task))).length,
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

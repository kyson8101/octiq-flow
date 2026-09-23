import type { OrchestrationAttempt, OrchestrationSnapshot, OrchestrationTask } from "./orchestration";
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

export function taskStage(task: OrchestrationTask, report?: TaskReport): string {
  if (task.status !== "running") return TASK_LABELS[task.status];
  return report?.steps.find((step) => step.state === "active")?.title || report?.nextStep || "Working";
}

export function boardCounts(tasks: OrchestrationTask[]) {
  const done = tasks.filter((task) => task.status === "completed").length;
  return {
    done, total: tasks.length, percent: tasks.length ? Math.round(done / tasks.length * 100) : 0,
    todo: tasks.filter((task) => task.status === "pending" || task.status === "ready").length,
    running: tasks.filter((task) => task.status === "running").length,
    blocked: tasks.filter((task) => task.status === "blocked" || task.status === "failed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
  };
}

export function shortWorkspacePath(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

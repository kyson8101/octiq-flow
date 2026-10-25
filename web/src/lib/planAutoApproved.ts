// A durable host fact, never a person's conversation turn.
export type PlanAutoApproved = {
  id: string; runId: string; revision: number; taskIds: string[]; taskTitles: string[];
  at: number; enabledAt: number;
};

export function readPlanAutoApproved(event: Record<string, unknown>): PlanAutoApproved | null {
  const { runId, revision, taskIds, taskTitles, at, enabledAt } = event;
  if (typeof runId !== "string" || !runId || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1
    || !Array.isArray(taskIds) || !taskIds.every((s) => typeof s === "string")
    || !Array.isArray(taskTitles) || !taskTitles.every((s) => typeof s === "string")
    || typeof at !== "number" || !Number.isFinite(at) || typeof enabledAt !== "number" || !Number.isFinite(enabledAt)) return null;
  return { id: `plan-auto-approved-${runId}-${revision}`, runId, revision, taskIds, taskTitles, at, enabledAt };
}

// A plan waiting for approval, read as the order it will run in.
//
// Tasks carry `dependsOn`; nothing else says when one starts. A stage is every
// task whose dependencies all sit in earlier stages — so stage 1 is what starts
// the moment the plan is approved, side by side, and each stage after it waits
// on the one before. A dependency on a task outside the plan is ignored (it is
// not this plan's to order), and a cycle is not solved: whatever is left over
// lands in one final stage flagged `blocked`, because as written it never
// starts.
import type { OrchestrationRun, OrchestrationTask } from "./orchestration";

export type PlanStage = { tasks: OrchestrationTask[]; blocked: boolean };

export function planStages(tasks: OrchestrationTask[]): PlanStage[] {
  const ids = new Set(tasks.map((task) => task.id));
  const placed = new Set<string>();
  const stages: PlanStage[] = [];
  let left = tasks;
  while (left.length) {
    const ready = left.filter((task) => task.dependsOn.every((id) => !ids.has(id) || placed.has(id)));
    if (!ready.length) {
      stages.push({ tasks: left, blocked: true });
      break;
    }
    stages.push({ tasks: ready, blocked: false });
    for (const task of ready) placed.add(task.id);
    left = left.filter((task) => !placed.has(task.id));
  }
  return stages;
}

/** Plan-order numbers, 1-based, for "after #2" labels. */
export function planNumbers(stages: PlanStage[]): Map<string, number> {
  return new Map(stages.flatMap((stage) => stage.tasks).map((task, index) => [task.id, index + 1]));
}

/** Who a task goes to: the registered agent, else the worker it asked for. */
export function planOwner(task: OrchestrationTask): { agent?: "claude" | "codex"; label: string } {
  if (task.assignee) return { agent: task.worker?.agent, label: task.assignee.name };
  if (task.worker) return { agent: task.worker.agent, label: task.worker.model ?? "" };
  return { label: "Chosen at dispatch" };
}

/** Where a task runs: its own destination, else the run's checkout (every
 *  task made before destinations existed). `repository` is a folder name,
 *  `path` the full one for a tooltip. */
export function planDestination(
  task: OrchestrationTask,
  run: Pick<OrchestrationRun, "workspaceId" | "rootPath">,
  projectName?: (id: string) => string | undefined,
): { project: string; repository: string; path: string } {
  const path = task.destination?.repository ?? run.rootPath;
  const project = task.destination?.projectName
    ?? projectName?.(run.workspaceId)
    ?? "This project";
  return { project, repository: folderName(path), path };
}

/** The tasks the person is approving now: the lead's own, not yet approved.
 *  A manager's subtasks never wait for the person. Mirrors the host's check,
 *  which refuses an approval of any other set. */
export function awaitingApproval(tasks: OrchestrationTask[]): string[] {
  return tasks
    .filter((task) => !task.parentTaskId && !task.approvedAt && task.status !== "cancelled")
    .map((task) => task.id);
}

/** What a plan shows: every task but one the lead withdrew before approval. */
export function planTasks(tasks: OrchestrationTask[]): OrchestrationTask[] {
  return tasks.filter((task) => task.status !== "cancelled" || !!task.approvedAt);
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

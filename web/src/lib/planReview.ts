// A plan waiting for approval, read as the order it will run in.
//
// Tasks carry `dependsOn`; nothing else says when one starts. A stage is every
// task whose dependencies all sit in earlier stages — so stage 1 is what starts
// the moment the plan is approved, side by side, and each stage after it waits
// on the one before. A dependency on a task outside the plan is ignored (it is
// not this plan's to order), and a cycle is not solved: whatever is left over
// lands in one final stage flagged `blocked`, because as written it never
// starts.
import { nameList } from "./cardFold";
import type { OrchestrationRun, OrchestrationTask, WorkerSettings } from "./orchestration";

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
export function planOwner(task: OrchestrationTask): { agent?: WorkerSettings["agent"]; label: string } {
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

/** How many agents a folded stage line names before it counts the rest. */
export const STAGE_AGENTS = 6;

/** How many destinations a folded stage line names before it counts the rest. */
export const STAGE_PLACES = 4;

type Run = Pick<OrchestrationRun, "workspaceId" | "rootPath">;

/** A destination as what tells it from another: its project and its whole
 *  path. Never its folder name, which two repositories can share. */
type Place = { key: string; project: string; leaf: string; parent: string; path: string };

function place(task: OrchestrationTask, run: Run, projectName?: (id: string) => string | undefined): Place {
  const where = planDestination(task, run, projectName);
  const path = where.path.replace(/[\\/]+$/, "") || where.path;
  const folders = path.split(/[\\/]/).filter(Boolean);
  const project = task.destination?.projectId ?? task.destination?.projectName ?? run.workspaceId;
  return {
    key: `${project}\u0000${path}`,
    project: where.project,
    leaf: where.repository,
    parent: folders.length > 1 ? folders[folders.length - 2] : "",
    path,
  };
}

/** What each destination of a plan is called on its folded card: the folder
 *  name while that names one place, its project with it where two places
 *  share a folder name, the parent folder too where they share a project as
 *  well, and the whole path if even that is not enough. Two destinations
 *  never get one name. Keyed by `planPlaceKey`. */
export function planPlaceNames(
  tasks: readonly OrchestrationTask[],
  run: Run,
  projectName?: (id: string) => string | undefined,
): Map<string, string> {
  const places = new Map<string, Place>();
  for (const task of tasks) {
    const at = place(task, run, projectName);
    if (!places.has(at.key)) places.set(at.key, at);
  }
  const forms: ((at: Place) => string)[] = [
    (at) => at.leaf,
    (at) => `${at.project} · ${at.leaf}`,
    (at) => `${at.project} · ${at.parent ? `${at.parent}/` : ""}${at.leaf}`,
    (at) => `${at.project} · ${at.path}`,
  ];
  const names = new Map<string, string>();
  let open = [...places.values()];
  for (const form of forms) {
    const taken = new Map<string, number>();
    for (const at of open) taken.set(form(at), (taken.get(form(at)) ?? 0) + 1);
    const still: Place[] = [];
    for (const at of open) {
      if (taken.get(form(at)) === 1 && ![...names.values()].includes(form(at))) names.set(at.key, form(at));
      else still.push(at);
    }
    open = still;
    if (!open.length) break;
  }
  // Same project, same path, told apart by nothing a person can read: the
  // key was the project's id. Said as the path under each, which is true.
  for (const at of open) names.set(at.key, `${at.project} · ${at.path}`);
  return names;
}

/** The key `planPlaceNames` files a task's destination under. */
export function planPlaceKey(task: OrchestrationTask, run: Run, projectName?: (id: string) => string | undefined): string {
  return place(task, run, projectName).key;
}

/** A stage on one line, for a plan drawn folded: how many tasks, who does
 *  them and where they land. Every agent up to six and every destination up
 *  to four is named; past that the rest are counted in words. `plan` is the
 *  whole plan's tasks, so a destination goes by one name on every line. */
export function stageSummary(
  stage: PlanStage,
  run: Run,
  projectName?: (id: string) => string | undefined,
  plan: readonly OrchestrationTask[] = stage.tasks,
): string {
  const n = stage.tasks.length;
  // One entry per agent: by id where there is one, so two who share a name
  // are both there.
  const agents = new Map<string, string>();
  for (const task of stage.tasks) {
    const label = planOwner(task).label;
    const who = task.assignee?.id ?? `\u0000${label}`;
    if (label && !agents.has(who)) agents.set(who, label);
  }
  const names = planPlaceNames(plan, run, projectName);
  const places = new Map<string, string>();
  for (const task of stage.tasks) {
    const key = planPlaceKey(task, run, projectName);
    if (!places.has(key)) places.set(key, names.get(key) ?? key);
  }
  return [
    `${n} task${n === 1 ? "" : "s"}`,
    nameList([...agents.values()], STAGE_AGENTS, "agent"),
    nameList([...places.values()], STAGE_PLACES, "destination"),
  ].filter(Boolean).join(" · ");
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

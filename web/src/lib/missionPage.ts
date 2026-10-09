// What a mission's page shows beside its board: the goal and what "done"
// means, who is on it and in what role, and where its work lives.
//
// Everything here is read off the ledger the page already holds — the run,
// its tasks and the registered agents — so a mission created before this page
// existed draws the same as a new one, and nothing new is persisted. Roles are
// what each person holds IN THIS MISSION, not their registration: the lead is
// whoever the coordinator chat belongs to, a developer owns a work task, a
// reviewer owns a check, review or acceptance task. One agent can be both.
//
// Reassignment is the lead's existing `orchestration_task_reassign`, asked by
// the person on the lead's behalf: the same routing (direct reports only, at
// the task's destination), the same handoff record, and the same rule that a
// new owner puts the task back in front of the person before anyone starts it.
import type { Persona } from "./agentPersona";
import { runPeople, type PersonState } from "./runPanel";
import type {
  MissionDelivery, OrchestrationAttempt, OrchestrationGate, OrchestrationRun, OrchestrationTask,
} from "./orchestration";

export type CrewRole = "lead" | "developer" | "reviewer";

export const CREW_ROLE_LABEL: Record<CrewRole, string> = {
  lead: "Lead", developer: "Developer", reviewer: "Reviewer",
};

export type CrewMember = {
  id: string;
  name: string;
  avatar?: string;
  /** The registration is gone; the mission keeps the name it had. */
  removed: boolean;
  /** Lead first, then developer, then reviewer. */
  roles: CrewRole[];
  /** Tasks this member owns in the mission. The lead's own is 0. */
  tasks: number;
  /** Their most urgent state across those tasks; absent for a lead who owns
   *  none, whose state is the run's. */
  state?: PersonState;
};

const CHECKS = new Set(["check", "review", "acceptance"]);
const ROLE_ORDER: CrewRole[] = ["lead", "developer", "reviewer"];

/** Everyone on the mission, once each, with the roles they hold in it. The
 *  lead first; then the people `runPeople` orders by what they are doing.
 *  A cancelled task gives nobody a role: they are no longer on it. */
export function missionCrew(
  run: OrchestrationRun,
  tasks: readonly OrchestrationTask[],
  attempts: readonly OrchestrationAttempt[],
  gates: readonly OrchestrationGate[],
  roster: readonly { id: string; name: string; avatar?: string }[],
  lead: Persona | null,
): CrewMember[] {
  const owned = tasks.filter((task) => task.runId === run.id && task.status !== "cancelled");
  const roles = new Map<string, Set<CrewRole>>();
  for (const task of owned) {
    if (!task.assignee) continue;
    const held = roles.get(task.assignee.id) ?? new Set<CrewRole>();
    held.add(CHECKS.has(task.kind ?? "work") ? "reviewer" : "developer");
    roles.set(task.assignee.id, held);
  }
  const ordered = (held: Set<CrewRole>) => ROLE_ORDER.filter((role) => held.has(role));
  const crew: CrewMember[] = runPeople(run, owned, attempts, gates, roster).map((person) => ({
    id: person.id,
    name: person.name,
    ...(person.avatar ? { avatar: person.avatar } : {}),
    removed: person.removed,
    roles: ordered(roles.get(person.id) ?? new Set()),
    tasks: person.tasks,
    state: person.state,
  }));
  if (!lead) return crew;
  const leadId = lead.id ?? `lead:${lead.name}`;
  const also = crew.findIndex((member) => member.id === leadId);
  if (also >= 0) {
    // A lead that took a task itself is one person with two roles.
    const [member] = crew.splice(also, 1);
    return [{ ...member, roles: ["lead", ...member.roles] }, ...crew];
  }
  return [{
    id: leadId,
    name: lead.name,
    ...(lead.avatar ? { avatar: lead.avatar } : {}),
    removed: !!lead.removed,
    roles: ["lead"],
    tasks: 0,
  }, ...crew];
}

export type MissionCriteria = { taskId: string; title: string; criteria: string[] };

/** What "done" means, task by task, as the plan cards the person approved
 *  said it. A withdrawn or replaced task's criteria no longer bind. */
export function missionAcceptance(tasks: readonly OrchestrationTask[]): MissionCriteria[] {
  return tasks
    .filter((task) => task.status !== "cancelled" && !task.supersededBy && (task.card?.acceptance.length ?? 0) > 0)
    .map((task) => ({ taskId: task.id, title: task.title, criteria: task.card!.acceptance }));
}

export type MissionPlace = {
  repositoryRoot: string;
  /** The worktree. For a planned one, where it WILL be. */
  checkoutRoot: string;
  branch: string;
  baseBranch: string;
  /** No task has prepared it yet: this is the plan, not a folder on disk. */
  planned: boolean;
  /** What git last said, when someone asked (`orchestration_mission_refresh`). */
  delivery?: MissionDelivery;
};

/** One row per repository: its base branch, the mission's branch, the
 *  worktree, and what git last said about it. A worktree a task prepared wins
 *  over the plan for it; git's last word is kept after the worktree goes, so
 *  a closed mission still says where its work landed. */
export function missionWhere(run: OrchestrationRun, tasks: readonly OrchestrationTask[]): MissionPlace[] {
  const places = new Map<string, MissionPlace>();
  for (const delivery of run.missionDelivery ?? []) {
    places.set(delivery.repositoryRoot, {
      repositoryRoot: delivery.repositoryRoot,
      checkoutRoot: delivery.checkoutRoot,
      branch: delivery.branch,
      baseBranch: delivery.baseBranch,
      planned: false,
      delivery,
    });
  }
  const mine = tasks.filter((task) => task.runId === run.id);
  for (const task of mine) {
    const plan = task.workspace?.plan;
    if (!plan || plan.mode !== "mission" || task.workspace!.state === "cleaned") continue;
    const known = places.get(plan.repositoryRoot);
    places.set(plan.repositoryRoot, {
      repositoryRoot: plan.repositoryRoot,
      checkoutRoot: plan.checkoutRoot,
      branch: plan.branch,
      baseBranch: plan.baseBranch,
      planned: false,
      ...(known?.delivery && known.delivery.checkoutRoot === plan.checkoutRoot ? { delivery: known.delivery } : {}),
    });
  }
  for (const task of mine) {
    const plan = task.workspaceProposal?.plan;
    if (!plan || plan.mode !== "mission" || places.has(plan.repositoryRoot)) continue;
    places.set(plan.repositoryRoot, {
      repositoryRoot: plan.repositoryRoot,
      checkoutRoot: plan.checkoutRoot,
      branch: plan.branch,
      baseBranch: plan.baseBranch,
      planned: true,
    });
  }
  return [...places.values()].sort((a, b) => a.repositoryRoot.localeCompare(b.repositoryRoot));
}

/** git's answer for one repository, in the words of the board's last steps. */
export function placeStanding(place: MissionPlace): string {
  const delivery = place.delivery;
  if (!delivery) return place.planned ? "Planned · not created yet" : "Not checked yet";
  const parts = [delivery.merged ? "Merged" : "Not merged"];
  if (delivery.merged) {
    parts.push(delivery.released === true ? "released" : delivery.released === false ? "not released" : "release unverified");
  }
  if (delivery.removed) parts.push(delivery.branchDeleted ? "worktree removed, branch deleted" : "worktree removed, branch kept");
  return parts.join(" · ");
}

/** `orchestration_destinations`, as far as reassignment reads it. */
export type Destinations = {
  projects?: { id: string; name: string; reports?: { id: string; name: string; role?: string }[] }[];
};

export type ReassignChoice = { id: string; name: string; role?: string; inCrew: boolean };

/** Who may take this task over: the lead's direct reports who may work at
 *  the task's destination, the current owner left out. Crew first, because
 *  handing work to someone already on the mission is the usual case; then
 *  the lead's other reports, such as a designated backup. The host routes the
 *  same way again and has the final word. */
export function reassignChoices(
  directory: Destinations | null | undefined,
  run: Pick<OrchestrationRun, "workspaceId">,
  task: Pick<OrchestrationTask, "destination" | "assignee">,
  crew: readonly Pick<CrewMember, "id">[],
): ReassignChoice[] {
  const project = task.destination?.projectId ?? run.workspaceId;
  const reports = directory?.projects?.find((item) => item.id === project)?.reports ?? [];
  const onCrew = new Set(crew.map((member) => member.id));
  return reports
    .filter((report) => report.id !== task.assignee?.id)
    .map((report) => ({ id: report.id, name: report.name, ...(report.role ? { role: report.role } : {}), inCrew: onCrew.has(report.id) }))
    .sort((a, b) => Number(b.inCrew) - Number(a.inCrew));
}

const OPEN_FOR_HANDOFF = new Set(["pending", "ready", "failed", "blocked"]);

/** Why this task cannot change hands right now, or null when it can. The
 *  same rules `reassign_task` enforces, said before the person tries. */
export function reassignBlocker(
  run: Pick<OrchestrationRun, "status" | "archivedAt">,
  task: Pick<OrchestrationTask, "status" | "assignee" | "parentTaskId" | "activeAttemptId">,
  attempts: readonly Pick<OrchestrationAttempt, "id" | "status">[],
): string | null {
  if (!task.assignee) return "Only a task handed to a registered agent can change hands.";
  if (["stopped", "completed", "failed", "closed"].includes(run.status) || run.archivedAt != null) return "This mission has ended.";
  if (task.parentTaskId) return "This is a manager's subtask; its manager hands it on.";
  const active = attempts.find((attempt) => attempt.id === task.activeAttemptId);
  if (active && (active.status === "preparing" || active.status === "running")) {
    return `${task.assignee.name} is still working on it. Stop that attempt first.`;
  }
  if (!OPEN_FOR_HANDOFF.has(task.status)) return "Only a task that has not finished can change hands.";
  return null;
}

/** The handoff's "why", as the record keeps it: the person's words, and that
 *  it was the person who moved it, since the lead's chat is the actor. */
export function reassignReason(words: string): string {
  return `${words.trim()} (reassigned by the person from the Mission page)`;
}

export type ReassignRequest = { actorChatKey: string; taskId: string; assignee: string; reason: string };

/** The one call the page makes: the lead's own reassignment, so the routing,
 *  the record and the re-approval are the host's, unchanged. */
export function reassignRequest(
  run: Pick<OrchestrationRun, "coordinatorChatKey">,
  task: Pick<OrchestrationTask, "id">,
  assignee: string,
  words: string,
): ReassignRequest {
  return { actorChatKey: run.coordinatorChatKey, taskId: task.id, assignee, reason: reassignReason(words) };
}

// Where a mission stands, from Draft to Closed.
//
// Half of it is the plan and its tasks — drafted, approved, being built, being
// checked — which the ledger already holds. The other half is git's, and only
// git's: Merged and Released come from `missionDelivery`, which the host fills
// when someone asks it to check (`orchestration_mission_refresh`). An agent
// saying "merged" moves nothing here.
import type { OrchestrationRun, OrchestrationTask } from "./orchestration";

export type MissionStage =
  | "draft" | "approved" | "building" | "review" | "ready"
  | "merged" | "released" | "closed";

export const MISSION_STAGES: { key: MissionStage; label: string }[] = [
  { key: "draft", label: "Draft" },
  { key: "approved", label: "Approved" },
  { key: "building", label: "In progress" },
  { key: "review", label: "In review" },
  { key: "ready", label: "Ready to merge" },
  { key: "merged", label: "Merged" },
  { key: "released", label: "Released" },
  { key: "closed", label: "Closed" },
];

export type MissionState = {
  stage: MissionStage;
  /** Waiting on someone: a decision, a blocked task, a failing check. */
  blocked: boolean;
  /** Closed without the merge. */
  abandoned: boolean;
};

const CHECKS = new Set(["check", "review", "acceptance"]);
const OPEN = new Set(["pending", "ready", "running", "blocked"]);

export function isMission(run: Pick<OrchestrationRun, "workspaceMode">): boolean {
  return run.workspaceMode === "mission";
}

export function missionState(run: OrchestrationRun, tasks: readonly OrchestrationTask[]): MissionState {
  const abandoned = !!run.abandoned;
  const blocked = run.status === "waiting" || tasks.some((task) => task.status === "blocked" && !task.supersededBy);
  const state = (stage: MissionStage): MissionState => ({ stage, blocked: blocked && stage !== "closed", abandoned });
  if (run.status === "closed") return state("closed");

  const live = tasks.filter((task) => task.status !== "cancelled");
  const open = live.filter((task) => OPEN.has(task.status));
  // Work added after a merge reopens the mission: the board follows the work.
  if (!open.length) {
    const delivery = run.missionDelivery ?? [];
    if (delivery.length && delivery.every((d) => d.merged)) {
      return state(delivery.every((d) => d.released === true) ? "released" : "merged");
    }
  }
  // A plan waiting for approval is a draft while it holds the work. Once the
  // host says, per task, what the plan holds (`heldByPlan`), a mission whose
  // plan went back for one task's sake keeps the stage of the work the
  // person already approved: it is a draft only while every task still open
  // is held. A host that does not say leaves it as it was: pending is draft.
  const pending = run.planApproval?.status === "pending";
  const said = live.some((task) => typeof task.heldByPlan === "boolean");
  const held = pending && (!said || open.every((task) => task.heldByPlan === true));
  if (!live.length || held || run.planApproval?.status === "rejected") {
    return state("draft");
  }
  if (!open.length) return state("ready");
  // Everything still open is a check, and some building is done: under review.
  if (open.every((task) => CHECKS.has(task.kind ?? "work")) && live.some((task) => task.status === "completed")) {
    return state("review");
  }
  if (live.every((task) => task.status === "pending" || task.status === "ready") && !live.some((task) => task.activeAttemptId)) {
    return state("approved");
  }
  return state("building");
}

export function stageLabel(state: MissionState): string {
  if (state.stage === "closed" && state.abandoned) return "Abandoned";
  return MISSION_STAGES.find((item) => item.key === state.stage)!.label;
}

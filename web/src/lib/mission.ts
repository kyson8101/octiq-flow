// Where a mission stands, from Draft to Closed.
//
// Half of it is the plan and its tasks — drafted, approved, being built, being
// checked — which the ledger already holds. The other half is git's, and only
// git's: Merged and Released come from `missionDelivery`, which the host fills
// when someone asks it to check (`orchestration_mission_refresh`). An agent
// saying "merged" moves nothing here.
import { checkFailed, failureShown, isSettled, type OrchestrationRun, type OrchestrationTask } from "./orchestration";
import { planHoldsEveryStart } from "./taskHold";

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
  /** Waiting on someone: a decision, a blocked task, a failing check. Not
   *  for a failure its coordinator is fixing, or one that is history
   *  (`orchestration.failureShown`): nothing waits on anyone there. */
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
  const live = tasks.filter((task) => task.status !== "cancelled");
  // Settled is not finished well: a check that completed and did not pass
  // holds what depends on it, and is somebody's to deal with.
  const failedCheck = live.some(checkFailed);
  // Whether a failure is said as one is one reader's: where the host says
  // whose move it is, only a failure that waits on the person is.
  const said = (task: OrchestrationTask) => { const shown = failureShown(task); return shown !== "quiet" && shown !== "history"; };
  const blocked = run.status === "waiting" || live.some((task) => checkFailed(task) && said(task))
    || tasks.some((task) => task.status === "blocked" && !task.supersededBy && said(task));
  const state = (stage: MissionStage): MissionState => ({ stage, blocked: blocked && stage !== "closed", abandoned });
  if (run.status === "closed") return state("closed");

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
  // person already approved: it is a draft only while the host would refuse
  // every start (`planHoldsEveryStart`), which an approved task that failed,
  // is blocked or was stopped by the person is not. A host that does not
  // say leaves it as it was: pending is draft.
  //
  // A check of approved work that failed is not a draft either, whatever the
  // plan holds: the work was built and a review of it did not pass.
  const held = planHoldsEveryStart(run, live);
  if (!live.length || run.planApproval?.status === "rejected") return state("draft");
  if (held) return state(failedCheck ? "review" : "draft");
  if (!open.length) {
    // Nothing is left to start. Ready to merge only when everything
    // finished well: a task that failed (or that the person stopped) is
    // still to be done, and a failed check keeps the mission under review.
    if (live.some((task) => task.status === "failed" && !task.supersededBy)) return state("building");
    return state(failedCheck ? "review" : "ready");
  }
  // Everything still open is a check, and some building is done: under review.
  if (open.every((task) => CHECKS.has(task.kind ?? "work")) && live.some(isSettled)) {
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

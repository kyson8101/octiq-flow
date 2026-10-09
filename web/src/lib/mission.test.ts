import { describe, expect, it } from "vitest";
import { missionState, stageLabel } from "./mission";
import type { OrchestrationRun, OrchestrationTask } from "./orchestration";

const run = (extra: Partial<OrchestrationRun> = {}): OrchestrationRun => ({
  id: "run_1", objective: "Ship it", coordinatorChatKey: "chat:m", workspaceId: "p", rootPath: "/r",
  status: "running", maxConcurrent: 4, workspaceMode: "mission", createdAt: 1, updatedAt: 1, ...extra,
});
const task = (id: string, status: OrchestrationTask["status"], extra: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId: "run_1", title: id, spec: "", dependsOn: [], status, createdAt: 1, updatedAt: 1, ...extra,
});
const delivery = (merged: boolean, released: boolean | null = null) => ({
  repositoryRoot: "/r", checkoutRoot: "/w", branch: "feature/mission-1", baseBranch: "develop",
  evidence: { headSha: "a", dirty: false, hasCommits: true, pushed: true, merged, checkedAt: 1, notes: [] },
  merged, released,
});
const stage = (r: OrchestrationRun, tasks: OrchestrationTask[]) => missionState(r, tasks).stage;

describe("where a mission stands", () => {
  it("walks from draft to ready to merge on its tasks", () => {
    expect(stage(run({ status: "planning" }), [])).toBe("draft");
    expect(stage(run({ planApproval: { status: "pending", requestedAt: 1 } }), [task("a", "ready")])).toBe("draft");
    expect(stage(run(), [task("a", "ready")])).toBe("approved");
    expect(stage(run(), [task("a", "running", { activeAttemptId: "x" })])).toBe("building");
    expect(stage(run(), [task("a", "completed"), task("b", "running", { kind: "review" })])).toBe("review");
    expect(stage(run({ status: "completed" }), [task("a", "completed")])).toBe("ready");
  });

  it("takes merged and released from git only, and follows new work back", () => {
    const done = [task("a", "completed")];
    expect(stage(run({ status: "completed", missionDelivery: [delivery(true)] }), done)).toBe("merged");
    expect(stage(run({ status: "completed", missionDelivery: [delivery(true, true)] }), done)).toBe("released");
    // Two repositories: merged only when both are.
    expect(stage(run({ status: "completed", missionDelivery: [delivery(true), delivery(false)] }), done)).toBe("ready");
    // A follow-up after the merge reopens the mission.
    expect(stage(run({ missionDelivery: [delivery(true)] }), [...done, task("b", "running", { activeAttemptId: "y" })])).toBe("building");
  });

  it("says closed and abandoned apart, and flags waiting without moving the stage", () => {
    expect(stageLabel(missionState(run({ status: "closed" }), []))).toBe("Closed");
    expect(stageLabel(missionState(run({ status: "closed", abandoned: true }), []))).toBe("Abandoned");
    const waiting = missionState(run({ status: "waiting" }), [task("a", "blocked", { activeAttemptId: "x" })]);
    expect(waiting).toMatchObject({ stage: "building", blocked: true });
  });
});

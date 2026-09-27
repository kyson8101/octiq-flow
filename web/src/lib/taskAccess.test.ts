import { describe, expect, it } from "vitest";
import { commandApprovalChoice } from "./taskAccess";
import type { OrchestrationRun, OrchestrationTask } from "./orchestration";

const pendingRun = {
  status: "planning",
  planApproval: { status: "pending", requestedAt: 1, revision: 3 },
  workerDefaults: null,
} as unknown as OrchestrationRun;

const task = (over: Partial<OrchestrationTask> = {}) => ({
  id: "t1", runId: "r1", title: "Publish", spec: "", dependsOn: [], status: "pending",
  worker: { agent: "claude", access: "auto", model: "sonnet" }, createdAt: 1, updatedAt: 1,
  ...over,
}) as OrchestrationTask;

describe("commandApprovalChoice (d59f830a)", () => {
  it("offers Auto or Manual for a Claude task still waiting for approval", () => {
    expect(commandApprovalChoice(task(), pendingRun)).toBe("auto");
    expect(commandApprovalChoice(task({ worker: { agent: "claude", access: "manual" } }), pendingRun)).toBe("manual");
  });

  it("follows the run's defaults when the task names no worker", () => {
    const run = { ...pendingRun, workerDefaults: { agent: "claude", access: "auto" } } as OrchestrationRun;
    expect(commandApprovalChoice(task({ worker: undefined }), run)).toBe("auto");
    expect(commandApprovalChoice(task({ worker: undefined }), pendingRun)).toBeNull();
  });

  it("is not offered for Codex, other access levels, or anything already approved or started", () => {
    expect(commandApprovalChoice(task({ worker: { agent: "codex", access: "auto" } }), pendingRun)).toBeNull();
    expect(commandApprovalChoice(task({ worker: { agent: "claude", access: "full" } }), pendingRun)).toBeNull();
    expect(commandApprovalChoice(task({ approvedAt: 5 }), pendingRun)).toBeNull();
    expect(commandApprovalChoice(task({ activeAttemptId: "a1" }), pendingRun)).toBeNull();
    expect(commandApprovalChoice(task({ status: "cancelled" }), pendingRun)).toBeNull();
    const approved = { ...pendingRun, planApproval: { status: "approved", requestedAt: 1 } } as OrchestrationRun;
    expect(commandApprovalChoice(task(), approved)).toBeNull();
  });
});

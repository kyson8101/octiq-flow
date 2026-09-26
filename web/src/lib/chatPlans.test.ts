import { describe, expect, it } from "vitest";
import { approvalLabel, chatApprovalHint, chatPlans, planHandle, seenPlans } from "./chatPlans";
import type { OrchestrationRun, OrchestrationSnapshot, OrchestrationTask, PlanApproval } from "./orchestration";

const run = (id: string, planApproval?: PlanApproval, extra: Partial<OrchestrationRun> = {}): OrchestrationRun => ({
  id, objective: id, coordinatorChatKey: "chat:lead", workspaceId: "p", rootPath: "/r",
  status: "running", maxConcurrent: 1, createdAt: 1, updatedAt: 1, planApproval, ...extra,
});
const task = (id: string, runId: string): OrchestrationTask => ({
  id, runId, title: id, spec: "", dependsOn: [], status: "pending", createdAt: 1, updatedAt: 1,
});
const snapshot = (runs: OrchestrationRun[], tasks: OrchestrationTask[] = []): OrchestrationSnapshot =>
  ({ runs, tasks, attempts: [], gates: [], messages: [], notifications: [] }) as unknown as OrchestrationSnapshot;
const pending = (revision: number): PlanApproval => ({ status: "pending", requestedAt: 1, revision });

describe("chat plans", () => {
  it("names a plan by the first four hex digits of its run, like the host", () => {
    expect(planHandle("run_2278c5a65c104183a60d37a5f4dfa690")).toBe("2278");
    expect(planHandle("run_ABCDEF")).toBe("abcd");
  });

  it("shows this chat's live plans, waiting ones first, and nothing else", () => {
    const plans = chatPlans(snapshot([
      run("run_aaaa1", { status: "approved", requestedAt: 1, revision: 2 }, { createdAt: 1 }),
      run("run_bbbb2", pending(3), { createdAt: 2 }),
      run("run_cccc3", pending(1), { coordinatorChatKey: "chat:other" }),
      run("run_dddd4", pending(1), { status: "stopped" }),
      run("run_eeee5", pending(1), { archivedAt: 5 }),
      run("run_ffff6"),
    ], [task("t1", "run_bbbb2"), task("t2", "run_cccc3")]), "chat:lead");
    expect(plans.map((plan) => [plan.handle, plan.pending, plan.revision])).toEqual([
      ["bbbb", true, 3],
      ["aaaa", false, 2],
    ]);
    expect(plans[0].tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(chatPlans(null, "chat:lead")).toEqual([]);
    expect(chatPlans(snapshot([run("run_1", pending(1))]), null)).toEqual([]);
  });

  it("a send carries the waiting plans on screen, at their revisions", () => {
    const plans = chatPlans(snapshot([
      run("run_aaaa1", { status: "approved", requestedAt: 1, revision: 2 }),
      run("run_bbbb2", pending(3)),
    ]), "chat:lead");
    expect(seenPlans(plans)).toEqual([{ runId: "run_bbbb2", revision: 3 }]);
  });

  it("a plan changed after approval is a new waiting revision, never the old approved card", () => {
    // Revision 4 was approved in chat; the lead then added work (revision 5).
    const reopened = run("run_aaaa1", {
      status: "pending", requestedAt: 9, revision: 5,
      consent: { via: "conversation", revision: 4, at: 8, turnId: "user-1", words: "approve this plan" },
    });
    const [plan] = chatPlans(snapshot([reopened]), "chat:lead");
    expect(plan.pending).toBe(true);
    expect(plan.revision).toBe(5);
    expect(seenPlans([plan])).toEqual([{ runId: "run_aaaa1", revision: 5 }]);
  });

  it("says how an approved plan was approved, and which revision", () => {
    const [inChat] = chatPlans(snapshot([run("run_aaaa1", {
      status: "approved", requestedAt: 1, revision: 4,
      consent: { via: "conversation", revision: 4, at: 2, words: "approve" },
    })]), "chat:lead");
    expect(approvalLabel(inChat)).toBe("Approved in chat · revision 4");
    const [button] = chatPlans(snapshot([run("run_aaaa1", {
      status: "approved", requestedAt: 1, revision: 2, consent: { via: "button", revision: 2, at: 2 },
    })]), "chat:lead");
    expect(approvalLabel(button)).toBe("Approved · revision 2");
  });

  it("asks for the handle only when several plans wait", () => {
    const [plan] = chatPlans(snapshot([run("run_aaaa1", pending(1))]), "chat:lead");
    expect(chatApprovalHint(plan, 1)).toContain(`"approve this plan"`);
    expect(chatApprovalHint(plan, 2)).toContain(`"approve plan aaaa"`);
  });
});

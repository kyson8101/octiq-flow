import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovedPlan, ChatPlanCards, RejectedPlan } from "./ChatPlanCards";
import { chatPlans } from "../lib/chatPlans";
import type { OrchestrationRun, OrchestrationSnapshot, OrchestrationTask, PlanApproval } from "../lib/orchestration";

const run = (id: string, planApproval: PlanApproval): OrchestrationRun => ({
  id, objective: "Ship", coordinatorChatKey: "chat:lead", workspaceId: "p", rootPath: "/r/app",
  status: "running", maxConcurrent: 1, createdAt: 1, updatedAt: 1, planApproval,
});
const task = (id: string, runId: string, extra: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId, title: `Task ${id}`, spec: "", dependsOn: [], status: "pending", createdAt: 1, updatedAt: 1, ...extra,
});
const render = (runs: OrchestrationRun[], tasks: OrchestrationTask[], drafting = false) => renderToStaticMarkup(
  <ChatPlanCards plans={chatPlans({ runs, tasks, attempts: [], gates: [], messages: [], notifications: [] } as unknown as OrchestrationSnapshot, "chat:lead")}
    drafting={drafting} />);

describe("ChatPlanCards", () => {
  it("draws a waiting plan with the run panel's own card, named and versioned", () => {
    const html = render([run("run_2278aa", { status: "pending", requestedAt: 1, revision: 3 })], [
      task("a", "run_2278aa", {
        assignee: { id: "mango", name: "Mango Juice" },
        worker: { agent: "claude", access: "auto", model: "opus", effort: "high" },
        destination: { projectId: "octiq", projectName: "octiq-flow", repository: "/src/octiq-flow" },
        card: { problem: "Plans live outside the chat.", goal: "Show them in it.", acceptance: ["Card in chat"] },
      }),
    ]);
    expect(html).toContain('data-plan="run_2278aa"');
    expect(html).toContain('data-revision="3"');
    expect(html).toContain("Plan 2278 · revision 3");
    expect(html).toContain("Plan ready for review");
    expect(html).toContain("Mango Juice");
    expect(html).toContain("octiq-flow");
    expect(html).toContain("Plans live outside the chat.");
    expect(html).toContain("Approve plan");
    expect(html).toContain(">Reject<");
    // The chat's own message box is how to answer; no second one.
    expect(html).toContain("Reply &quot;approve this plan&quot; below, or ask for changes.");
    expect(html).not.toContain("<textarea");
  });

  it("removes a rejected plan from the transcript tail and folds its record in run history", () => {
    const rejected = run("run_abcd12", {
      status: "rejected", requestedAt: 1, revision: 0, decidedAt: 2,
      rejection: {
        by: "person", revision: 0, at: 2, reason: "Wrong direction", taskIds: ["a"], surface: "chat",
      },
    });
    const tasks = [task("a", "run_abcd12", { status: "cancelled" })];
    expect(render([rejected], tasks)).toBe("");
    const [plan] = chatPlans({ runs: [rejected], tasks, attempts: [], gates: [], messages: [], notifications: [] } as unknown as OrchestrationSnapshot, "chat:lead");
    const html = renderToStaticMarkup(<RejectedPlan plan={plan} />);
    expect(html).toMatch(/<details class="chat-plan chat-plan-approved chat-plan-rejected"><summary>/);
    expect(html).not.toContain("<details class=\"chat-plan chat-plan-approved chat-plan-rejected\" open");
    expect(html).toContain("Plan rejected · Wrong direction");
    expect(html).toContain("revision 0");
    expect(html).toContain("Reason: Wrong direction");
    expect(html).toContain("Withdrawn: Task a");
    expect(html).not.toContain("Approve plan");
  });

  it("distinguishes a restored approved task from work that was withdrawn", () => {
    const rejected = run("run_abcd12", {
      status: "rejected", requestedAt: 1, revision: 5, decidedAt: 2,
      rejection: {
        by: "person", revision: 5, at: 2, taskIds: ["a", "b"], restoredTaskIds: ["a"], surface: "panel",
      },
    });
    const tasks = [task("a", "run_abcd12", { approvedAt: 1, status: "ready" }), task("b", "run_abcd12", { status: "cancelled" })];
    const [plan] = chatPlans({ runs: [rejected], tasks, attempts: [], gates: [], messages: [], notifications: [] } as unknown as OrchestrationSnapshot, "chat:lead");
    const html = renderToStaticMarkup(<RejectedPlan plan={plan} />);
    expect(html).toContain("Restored to the approved plan: Task a");
    expect(html).toContain("Withdrawn: Task b");
    expect(html).not.toContain("Withdrawn: Task a");
  });

  it("with several plans waiting, each says its own handle", () => {
    const html = render([
      run("run_aaaa11", { status: "pending", requestedAt: 1, revision: 1 }),
      run("run_bbbb22", { status: "pending", requestedAt: 1, revision: 2 }),
    ], [task("a", "run_aaaa11"), task("b", "run_bbbb22")]);
    expect(html).toContain("&quot;approve plan aaaa&quot;");
    expect(html).toContain("&quot;approve plan bbbb&quot;");
  });

  it("a settled plan leaves the chat; a new revision waiting comes back", () => {
    // The person's screenshot: "Approved · revision 4" still a full row
    // above the message box after they had approved it.
    const approved = run("run_cccc33", {
      status: "approved", requestedAt: 1, revision: 4,
      consent: { via: "button", revision: 4, at: 2, surface: "chat", shownMs: 5000 },
    });
    expect(render([approved], [task("a", "run_cccc33", { approvedAt: 2 })])).toBe("");
    const reopened = run("run_cccc33", { status: "pending", requestedAt: 1, revision: 5 });
    const html = render([reopened, run("run_eeee55", { status: "approved", requestedAt: 1, revision: 2 })],
      [task("a", "run_cccc33", { approvedAt: 2 }), task("b", "run_cccc33"), task("c", "run_eeee55", { approvedAt: 2 })]);
    expect(html).toContain("Plan cccc · revision 5");
    expect(html).not.toContain("eeee");
  });

  it("the run panel keeps the approved plan, folded to how and which revision", () => {
    const [plan] = chatPlans({ runs: [run("run_cccc33", {
      status: "approved", requestedAt: 1, revision: 4,
      consent: { via: "conversation", revision: 4, at: 2, turnId: "user-1", words: "approve this plan" },
    })], tasks: [task("a", "run_cccc33", { approvedAt: 2 })], attempts: [], gates: [], messages: [], notifications: [] } as unknown as OrchestrationSnapshot, "chat:lead");
    const html = renderToStaticMarkup(<ApprovedPlan plan={plan} />);
    expect(html).toMatch(/<details class="chat-plan chat-plan-approved"><summary>/);
    expect(html).not.toContain("<details class=\"chat-plan chat-plan-approved\" open");
    expect(html).toContain("Approved in chat · revision 4");
    expect(html).toContain("Plan approved");
    expect(html).not.toContain("Approve plan");
  });

  it("a withdrawn task is not part of the plan shown", () => {
    const html = render([run("run_dddd44", { status: "pending", requestedAt: 1, revision: 5 })], [
      task("kept", "run_dddd44"),
      task("gone", "run_dddd44", { status: "cancelled" }),
    ]);
    expect(html).toContain("Task kept");
    expect(html).not.toContain("Task gone");
    expect(html).toContain("1 task · 1 stage");
  });

  it("draws nothing for a chat that leads no plan", () => {
    expect(render([], [])).toBe("");
  });
});

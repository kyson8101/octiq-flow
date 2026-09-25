import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
import { renderToStaticMarkup } from "react-dom/server";
import { PlanReview } from "./PlanReview";
import type { OrchestrationRun, OrchestrationTask } from "../lib/orchestration";

const run: OrchestrationRun = {
  id: "run_1", objective: "Ship", coordinatorChatKey: "chat:lead", workspaceId: "p1", rootPath: "/r",
  status: "running", maxConcurrent: 2, createdAt: 1, updatedAt: 1,
  planApproval: { status: "pending", requestedAt: 1 },
};
const task = (id: string, dependsOn: string[] = [], extra: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId: "run_1", title: `Task ${id}`, spec: "", dependsOn, status: "pending", createdAt: 1, updatedAt: 1, ...extra,
});
const render = (tasks: OrchestrationTask[], drafting = false) => renderToStaticMarkup(
  <PlanReview run={run} tasks={tasks} drafting={drafting} onRequestChanges={() => {}} />);

describe("PlanReview", () => {
  it("lays the plan out by stage, with who does what and what waits", () => {
    const html = render([task("a", [], { assignee: { id: "maya", name: "Maya" } }), task("b"), task("c", ["a", "b"])]);
    expect(html).toContain("Plan ready for review");
    expect(html).toContain("3 tasks · 2 stages");
    expect(html).toContain("Starts on approval");
    expect(html).toContain("2 side by side");
    expect(html).toContain("After stage 1");
    expect(html).toContain("Maya");
    expect(html).toContain("after #1, #2");
    expect(html).toContain("Approve plan");
    expect(html).not.toMatch(/disabled=""[^>]*>Approve/);
  });

  it("keeps a spec behind its task's disclosure", () => {
    const html = render([task("a", [], { spec: "Rewrite the parser." })]);
    expect(html).toMatch(/<details><summary>.*Task a.*<\/summary><div class="plan-task-spec">Rewrite the parser\.<\/div><\/details>/);
    expect(html).not.toContain("<details open");
  });

  it("will not approve a plan still being drafted, or an empty one", () => {
    expect(render([task("a")], true)).toMatch(/<button[^>]*disabled=""[^>]*>Approve/);
    expect(render([task("a")], true)).toContain("Drafting the plan");
    const empty = render([], true);
    expect(empty).toContain("Tasks appear here as the main agent writes them.");
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Approve plan/);
  });

  it("warns about tasks that wait on each other", () => {
    const html = render([task("a", ["b"]), task("b", ["a"])]);
    expect(html).toContain("Waits on each other");
    expect(html).toContain("will never start");
  });
});

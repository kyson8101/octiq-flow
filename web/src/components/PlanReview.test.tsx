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

  it("will not approve an empty plan, but a busy main agent does not lock one on screen", () => {
    // Any coordinator turn — a reply, a delivered notification — made the
    // chat busy, and used to grey out an approval of a plan already written.
    // The approval names the tasks seen; the host refuses it if they changed
    // (orchestration.rs: approval_covers_the_plan_seen_and_new_lead_work_needs_it_again).
    const busy = render([task("a")], true);
    expect(busy).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve/);
    expect(busy).toContain("Plan ready for review");
    expect(busy).not.toContain("Drafting the plan");
    expect(busy).toContain("The main agent is still active. Approving covers the tasks shown.");
    const empty = render([], true);
    expect(empty).toContain("Drafting the plan");
    expect(empty).toContain("Tasks appear here as the main agent writes them.");
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Approve plan/);
  });

  it("shows where each task runs: its destination, else the run's own checkout", () => {
    const html = renderToStaticMarkup(
      <PlanReview run={run} tasks={[
        task("a", [], {
          assignee: { id: "maya", name: "Maya" },
          destination: { projectId: "shop", projectName: "Shop", repository: "/src/shop/api" },
        }),
        task("b", [], { assignee: { id: "sam", name: "Sam" } }),
      ]} drafting={false} projectName={(id) => (id === "p1" ? "OctiqFlow" : undefined)} onRequestChanges={() => {}} />);
    expect(html).toMatch(/Task a.*Shop.*api.*Maya/s);
    expect(html).toContain('title="Shop · /src/shop/api"');
    expect(html).toMatch(/Task b.*OctiqFlow.*r<\/span>.*Sam/s);
  });

  it("marks what was added since the plan was last approved", () => {
    const html = render([task("a", [], { approvedAt: 5 }), task("b")]);
    expect(html.match(/plan-task-new/g)).toHaveLength(1);
    expect(html).toMatch(/Task b.*New/s);
    expect(render([task("a"), task("b")])).not.toContain("plan-task-new");
  });

  it("warns about tasks that wait on each other", () => {
    const html = render([task("a", ["b"]), task("b", ["a"])]);
    expect(html).toContain("Waits on each other");
    expect(html).toContain("will never start");
  });
});

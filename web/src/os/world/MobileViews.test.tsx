import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileNavigation, MobileWorkList, mobileTasks } from "./MobileViews";
import type { Task, World } from "./types";

const task = (
  id: string,
  status: string,
  orgId = "a",
  projectId = "pa",
): Task => ({
  id,
  status,
  orgId,
  projectId,
  title: id,
  detail: "",
  route: "auto",
  agentId: null,
  workflowId: null,
  steps: [],
  step: 0,
  messages: [],
  evidence: "",
  generation: 0,
  createdAt: 0,
});
const world: World = {
  revision: 1,
  orgs: [
    { id: "a", name: "Alpha", description: "" },
    { id: "b", name: "Beta", description: "" },
  ],
  projects: [
    { id: "pa", orgId: "a", name: "Project A", context: "", workspacePath: "" },
  ],
  tasks: [
    task("working", "working"),
    task("done", "done"),
    task("review", "verifying"),
    task("question", "needs_input"),
    task("paused", "paused"),
    task("other", "needs_input", "b", "pb"),
  ],
  agents: [],
  professions: [],
  workflows: [],
  meetings: [],
  memories: [],
  runs: [],
  usage: [],
  xp: [],
};

describe("mobile work triage", () => {
  it("prioritizes questions, verification and paused work across organizations", () => {
    expect(
      mobileTasks(world, null, "attention", "active", "").map((t) => t.id),
    ).toEqual(["question", "other", "review", "paused"]);
  });
  it("restricts the list to the selected organization and project", () => {
    expect(
      mobileTasks(world, "a", "attention", "active", "pa").map((t) => t.id),
    ).toEqual(["question", "review", "paused"]);
    expect(mobileTasks(world, "a", "board", "", "pb")).toEqual([]);
  });
  it("keeps completed work out of the active list but reachable through filters", () => {
    expect(
      mobileTasks(world, "a", "board", "active", "").map((t) => t.id),
    ).not.toContain("done");
    expect(
      mobileTasks(world, "a", "board", "done", "").map((t) => t.id),
    ).toEqual(["done"]);
  });
  it("explains the founder action and does not execute anything while rendering", () => {
    const inspect = vi.fn(),
      create = vi.fn();
    const html = renderToStaticMarkup(
      <MobileWorkList
        world={world}
        orgId="a"
        view="attention"
        inspect={inspect}
        create={create}
      />,
    );
    expect(html).toContain("Review the evidence and confirm the outcome.");
    expect(html).toContain("Your team needs more context.");
    expect(html).not.toContain("Beta");
    expect(inspect).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it("marks only the current destination and announces the attention count", () => {
    const html = renderToStaticMarkup(
      <MobileNavigation view="attention" count={3} change={vi.fn()} />,
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="3 tasks need attention"');
  });
});

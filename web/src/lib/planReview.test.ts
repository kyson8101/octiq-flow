import { describe, expect, it } from "vitest";
import { planNumbers, planOwner, planStages } from "./planReview";
import type { OrchestrationTask } from "./orchestration";

const task = (id: string, dependsOn: string[] = [], extra: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId: "run", title: id, spec: "", dependsOn, status: "pending", createdAt: 1, updatedAt: 1, ...extra,
});

describe("planStages", () => {
  it("puts independent tasks side by side and dependants after them", () => {
    const stages = planStages([task("c", ["a", "b"]), task("a"), task("b"), task("d", ["c"])]);
    expect(stages.map((stage) => stage.tasks.map((t) => t.id))).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(stages.every((stage) => !stage.blocked)).toBe(true);
    expect([...planNumbers(stages)]).toEqual([["a", 1], ["b", 2], ["c", 3], ["d", 4]]);
  });

  it("ignores a dependency outside the plan", () => {
    expect(planStages([task("a", ["elsewhere"])])[0]).toMatchObject({ blocked: false });
  });

  it("flags a cycle instead of looping on it", () => {
    const stages = planStages([task("a"), task("b", ["c"]), task("c", ["b"])]);
    expect(stages).toHaveLength(2);
    expect(stages[1]).toMatchObject({ blocked: true });
    expect(stages[1].tasks.map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("is empty for an empty plan", () => {
    expect(planStages([])).toEqual([]);
  });
});

describe("planOwner", () => {
  it("prefers the registered agent, then the worker, then says it is open", () => {
    expect(planOwner(task("a", [], { assignee: { id: "m", name: "Maya" }, worker: { agent: "codex", access: "auto" } }))).toEqual({ agent: "codex", label: "Maya" });
    expect(planOwner(task("a", [], { worker: { agent: "claude", access: "auto", model: "claude-sonnet-5" } }))).toEqual({ agent: "claude", label: "claude-sonnet-5" });
    expect(planOwner(task("a")).label).toBe("Chosen at dispatch");
  });
});

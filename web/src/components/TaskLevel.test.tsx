import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
import { renderToStaticMarkup } from "react-dom/server";
import { LevelChip } from "./AgentLevel";
import { TaskAcceptanceLine, TaskSizeFact } from "./TaskLevel";
import type { OrchestrationTask } from "../lib/orchestration";

const task = (over: Partial<OrchestrationTask>): OrchestrationTask => ({
  id: "task_1", runId: "run_1", title: "Ship levels", spec: "", dependsOn: [], status: "ready",
  assignee: { id: "agent_ada", name: "Ada" }, createdAt: 1, updatedAt: 1, ...over,
});

describe("a task's size on its plan card", () => {
  it("is a picker before the task starts", () => {
    const html = renderToStaticMarkup(<dl><TaskSizeFact task={task({ size: "large" })} /></dl>);
    expect(html).toContain('aria-label="Size of Ship levels"');
    expect(html).toMatch(/<option value="large" selected="">Large · 150 XP<\/option>/);
  });

  it("is a locked fact once it has started", () => {
    const html = renderToStaticMarkup(<dl><TaskSizeFact task={task({ size: "small", status: "running", activeAttemptId: "a1" })} /></dl>);
    expect(html).not.toContain("<select");
    expect(html).toContain("Small · 25 XP");
    expect(html).toContain("Locked since the task started.");
  });
});

describe("accepting a task on its plan card", () => {
  it("offers Accept for a completed result and says what it pays", () => {
    const html = renderToStaticMarkup(<TaskAcceptanceLine task={task({ status: "completed", size: "medium", activeAttemptId: "a1" })} />);
    expect(html).toContain("Accepting pays Ada 75 XP, once per task.");
    expect(html).toContain(">Accept result</button>");
  });

  it("says who accepted the current result, and offers nothing more", () => {
    const html = renderToStaticMarkup(<TaskAcceptanceLine task={task({
      status: "completed", size: "medium", activeAttemptId: "a1",
      acceptance: { attemptId: "a1", at: Date.UTC(2026, 8, 26, 12), by: { kind: "lead", agentId: "agent_grace", agentName: "Grace" } },
    })} />);
    expect(html).toContain("Accepted by Grace · Sep 26, 2026");
    expect(html).not.toContain("Accept result");
  });
});

describe("the level chip", () => {
  it("reads level 1 until the host says otherwise, and opens the profile", () => {
    const html = renderToStaticMarkup(<LevelChip name="Ada" onOpen={() => {}} />);
    expect(html).toContain("Lv 1");
    expect(html).toContain('aria-label="Ada: level 1, 0 XP. Open profile"');
    const levelled = renderToStaticMarkup(<LevelChip name="Ada" progress={{ xp: 175, level: 2, levelXp: 100, nextLevelXp: 300 }} onOpen={() => {}} />);
    expect(levelled).toContain("Lv 2");
    expect(levelled).toContain("width:38%");
  });
});

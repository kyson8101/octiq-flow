import { describe, expect, it } from "vitest";
import type { OrchestrationRun } from "./orchestration";
import { initialRunDisclosures, syncRunDisclosures, toggleRunDisclosure } from "./runDisclosure";

const run = (id: string, status: OrchestrationRun["status"]): OrchestrationRun => ({
  id, status, objective: id, coordinatorChatKey: "chat:main", workspaceId: "project",
  rootPath: "/repo", maxConcurrent: 2, createdAt: 1, updatedAt: 1,
});

describe("run disclosure state", () => {
  it("initially opens the active goal", () => {
    const state = initialRunDisclosures([run("old", "completed"), run("active", "running"), run("waiting", "waiting")]);
    expect([...state.expanded]).toEqual(["active"]);
  });

  it("keeps a manual collapse through refreshed run objects", () => {
    const runs = [run("active", "running")];
    const closed = toggleRunDisclosure(initialRunDisclosures(runs), "active");
    const refreshed = syncRunDisclosures(closed, [{ ...runs[0], updatedAt: 9 }]);
    expect([...refreshed.expanded]).toEqual([]);
    expect([...refreshed.touched]).toEqual(["active"]);
  });

  it("opens a newly active goal and reveals a selected worker's historical goal", () => {
    const old = run("old", "completed");
    const state = initialRunDisclosures([old]);
    const withActive = syncRunDisclosures(state, [old, run("new", "running")]);
    expect(withActive.expanded.has("new")).toBe(true);
    const manuallyClosedOld = toggleRunDisclosure(withActive, "old");
    const revealed = syncRunDisclosures(manuallyClosedOld, [old, run("new", "running")], "old");
    expect(revealed.expanded.has("old")).toBe(true);
  });
});

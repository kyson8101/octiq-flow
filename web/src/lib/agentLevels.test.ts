import { describe, expect, it, vi } from "vitest";
vi.mock("./bridge", () => ({ bridge: { invoke: async () => [] } }));
import { canAccept, compactTokens, historyXp, levelFraction, taskSizeState, toNextLevel } from "./agentLevels";

describe("level progress", () => {
  it("is the share of the current level done, as the host reports it", () => {
    expect(levelFraction({ xp: 175, level: 2, levelXp: 100, nextLevelXp: 300 })).toBeCloseTo(0.375);
    expect(levelFraction({ xp: 0, level: 1, levelXp: 0, nextLevelXp: 100 })).toBe(0);
    expect(toNextLevel({ xp: 175, level: 2, levelXp: 100, nextLevelXp: 300 })).toBe("125 XP to level 3");
  });
});

describe("compactTokens", () => {
  it("reads at a glance", () => {
    expect(compactTokens(950)).toBe("950");
    expect(compactTokens(12_400)).toBe("12.4K");
    expect(compactTokens(3_200_000)).toBe("3.2M");
    expect(compactTokens(245_000_000)).toBe("245M");
  });
});

describe("a task's size", () => {
  it("is medium and editable before the task starts", () => {
    expect(taskSizeState({ status: "ready" })).toEqual({ size: "medium", editable: true, label: "Medium · 75 XP" });
    expect(taskSizeState({ status: "pending", size: "large" }).label).toBe("Large · 150 XP");
  });

  it("is locked once an attempt exists, and missing only on older started tasks", () => {
    expect(taskSizeState({ status: "running", size: "small", activeAttemptId: "a1" })).toMatchObject({ editable: false, size: "small" });
    expect(taskSizeState({ status: "completed", activeAttemptId: "a1" })).toEqual({ editable: false, label: "Not recorded · earns no XP" });
  });
});

describe("canAccept", () => {
  const done = { status: "completed" as const, assignee: { id: "agent_ada", name: "Ada" }, activeAttemptId: "a2" };

  it("offers Accept only for an agent's completed, unaccepted current result", () => {
    expect(canAccept(done)).toBe(true);
    expect(canAccept({ ...done, acceptance: { attemptId: "a2", at: 1, by: { kind: "person" } } })).toBe(false);
    // Accepted before a reopen: the new result is judged on its own.
    expect(canAccept({ ...done, acceptance: { attemptId: "a1", at: 1, by: { kind: "person" } } })).toBe(true);
    expect(canAccept({ ...done, status: "running" })).toBe(false);
    expect(canAccept({ ...done, assignee: undefined })).toBe(false);
  });
});

describe("historyXp", () => {
  it("says what each acceptance paid, and why when it paid nothing", () => {
    expect(historyXp({ xp: 75, size: "medium" })).toEqual({ amount: "+75 XP" });
    expect(historyXp({ xp: 0, unpaid: "unsized" })).toEqual({ amount: "0 XP", why: "No size recorded" });
    expect(historyXp({ xp: 0, size: "large", unpaid: "already_paid" }))
      .toEqual({ amount: "0 XP", why: "Accepted again · paid the first time" });
  });
});

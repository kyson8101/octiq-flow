import { describe, expect, it } from "vitest";
import { autoExecution, headCoordination } from "./agentExecution";

const flow = { id: "p-flow", name: "octiq-flow", primary_path: "/code/octiq-flow" };
const general = { id: "p-general", name: "General", primary_path: "/code/General" };
const repo = { isRepo: true, current: "develop" };

describe("autoExecution", () => {
  it("keeps the head in the home workspace with no git", () => {
    const plan = autoExecution({ toHead: true, project: flow, homeId: "p-general", repo,
      overrides: { projectId: "p-flow", newWorktree: true } });
    expect(plan).toMatchObject({ target: "home", projectId: "p-general", prepare: false, newWorktree: false, chosenBy: "auto" });
  });

  it("gives a project lead a new worktree from the project's branch", () => {
    const plan = autoExecution({ toHead: false, project: flow, homeId: "p-general", repo });
    expect(plan).toMatchObject({ target: "project", projectId: "p-flow", prepare: true, branch: "develop", newWorktree: true, chosenBy: "auto" });
    expect(plan.reason).toContain("develop");
  });

  it("lets the host resolve the base while the repository is still being read", () => {
    const plan = autoExecution({ toHead: false, project: flow, repo: { ...repo, loading: true } });
    expect(plan).toMatchObject({ prepare: true, branch: "", newWorktree: true });
  });

  it("works in place in a folder that is not a repository", () => {
    const plan = autoExecution({ toHead: false, project: flow, repo: { isRepo: false, current: "" } });
    expect(plan.reason).toContain("Not a Git repository");
    expect(plan.prepare).toBe(true);
  });

  it("coordinates from home when there is no code project", () => {
    expect(autoExecution({ toHead: false, project: null, homeId: "p-general" }))
      .toMatchObject({ target: "home", projectId: "p-general", prepare: false });
    expect(autoExecution({ toHead: false, project: general }))
      .toMatchObject({ target: "home", prepare: false });
  });

  it("marks only the head's conversation as cross-project", () => {
    expect(autoExecution({ toHead: true, project: null }).crossProject).toBe(true);
    expect(autoExecution({ toHead: false, project: null }).crossProject).toBe(false);
    expect(autoExecution({ toHead: false, project: flow, repo }).crossProject).toBe(false);
  });

  it("makes every new conversation with the head its cross-project coordination", () => {
    expect(headCoordination({ recipientId: "pj", headId: "pj" })).toBe(true);
    // Whatever page it was started from: there is no project in the rule.
    expect(headCoordination({ recipientId: "maya", headId: "pj" })).toBe(false);
    expect(headCoordination({ recipientId: "pj", headId: null })).toBe(false);
    expect(headCoordination({ recipientId: null, headId: null })).toBe(false);
  });

  it("lets Advanced overrides win and says so", () => {
    const plan = autoExecution({ toHead: false, project: flow, repo,
      overrides: { branch: "main", newWorktree: false } });
    expect(plan).toMatchObject({ branch: "main", newWorktree: false, chosenBy: "advanced" });
    const moved = autoExecution({ toHead: false, project: flow, homeId: "p-general", repo,
      overrides: { projectId: null } });
    expect(moved).toMatchObject({ target: "home", chosenBy: "advanced" });
  });
});

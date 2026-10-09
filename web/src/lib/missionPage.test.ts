import { describe, expect, it } from "vitest";
import {
  missionAcceptance, missionCrew, missionWhere, placeStanding, reassignBlocker, reassignChoices, reassignReason, reassignRequest,
} from "./missionPage";
import type { OrchestrationAttempt, OrchestrationRun, OrchestrationTask, TaskWorkspace } from "./orchestration";

const run: OrchestrationRun = {
  id: "run_m", objective: "Ship the Mission page", coordinatorChatKey: "chat:lead", workspaceId: "proj",
  rootPath: "/repo", status: "running", maxConcurrent: 4, workspaceMode: "mission", createdAt: 1, updatedAt: 2,
};

const plan = (repo: string, branch = "feature/mission-run_m"): TaskWorkspace["plan"] => ({
  mode: "mission", cwd: `${repo}/.worktrees/m`, checkoutRoot: `${repo}/.worktrees/m`, repositoryRoot: repo,
  branch, baseBranch: "develop", baseSha: "abc", managed: true, isRepo: true, warnings: [], initialStatus: "",
});

function task(id: string, extra: Partial<OrchestrationTask>): OrchestrationTask {
  return { id, runId: run.id, title: id, spec: "", dependsOn: [], status: "pending", createdAt: 1, updatedAt: 1, ...extra };
}

const maya = { id: "maya", name: "Maya" };
const noah = { id: "noah", name: "Noah" };
const roster = [{ ...maya, avatar: "data:image/png;base64,AA" }, noah, { id: "cto", name: "CTO" }];

const tasks: OrchestrationTask[] = [
  task("build", { assignee: maya, status: "running", activeAttemptId: "a1", card: { problem: "p", goal: "g", acceptance: ["Page shows crew", "Reassign works"] } }),
  task("api", { assignee: maya, status: "completed", kind: "work" }),
  task("review", { assignee: noah, kind: "review", card: { problem: "p", goal: "g", acceptance: ["Reviewed"] } }),
  task("dropped", { assignee: { id: "gone", name: "Gone" }, status: "cancelled", card: { problem: "p", goal: "g", acceptance: ["Never"] } }),
];
const attempts: OrchestrationAttempt[] = [{
  id: "a1", runId: run.id, taskId: "build", number: 1, workerChatKey: "chat:w1", agent: "claude", access: "auto",
  status: "running", cwd: "/repo", branch: "b", isWorktree: true, filesModified: [], createdAt: 5, updatedAt: 5,
}];

describe("mission crew", () => {
  it("puts the lead first, then each task owner once with the roles they hold here", () => {
    const crew = missionCrew(run, tasks, attempts, [], roster, { id: "cto", name: "CTO" });
    expect(crew.map((member) => [member.name, member.roles])).toEqual([
      ["CTO", ["lead"]],
      ["Maya", ["developer"]],
      ["Noah", ["reviewer"]],
    ]);
    expect(crew[1]).toMatchObject({ tasks: 2, state: "working", avatar: "data:image/png;base64,AA" });
    // A cancelled task puts nobody on the crew.
    expect(crew.some((member) => member.id === "gone")).toBe(false);
  });

  it("gives one agent both roles, and a lead that took a task is one person", () => {
    const both = [...tasks, task("check", { assignee: maya, kind: "check" }), task("own", { assignee: { id: "cto", name: "CTO" } })];
    const crew = missionCrew(run, both, attempts, [], roster, { id: "cto", name: "CTO" });
    expect(crew.find((member) => member.id === "maya")?.roles).toEqual(["developer", "reviewer"]);
    expect(crew.filter((member) => member.id === "cto")).toHaveLength(1);
    expect(crew[0]).toMatchObject({ id: "cto", roles: ["lead", "developer"], tasks: 1 });
  });

  it("draws a mission with no registered lead from its owners alone", () => {
    expect(missionCrew(run, tasks, attempts, [], roster, null)[0].name).toBe("Maya");
    expect(missionCrew(run, [task("x", {})], [], [], [], null)).toEqual([]);
  });
});

describe("mission goal and where", () => {
  it("collects the acceptance criteria of every task still on the mission", () => {
    const superseded = task("old", { supersededBy: "build", card: { problem: "", goal: "", acceptance: ["Stale"] } });
    expect(missionAcceptance([...tasks, superseded])).toEqual([
      { taskId: "build", title: "build", criteria: ["Page shows crew", "Reassign works"] },
      { taskId: "review", title: "review", criteria: ["Reviewed"] },
    ]);
  });

  it("gives one row per repository, a prepared worktree over its plan, with git's last word", () => {
    const prepared = task("build", { workspace: { plan: plan("/repo"), state: "ready", abandoned: false, validationPaths: [] } });
    const planned = task("review", { workspaceProposal: { plan: plan("/repo"), newBranch: true, proposedAt: 1 } });
    const other = task("api", { workspaceProposal: { plan: plan("/api"), newBranch: true, proposedAt: 1 } });
    const notMission = task("direct", { workspace: { plan: { ...plan("/elsewhere"), mode: "direct" }, state: "ready", abandoned: false, validationPaths: [] } });
    const delivery = {
      repositoryRoot: "/repo", checkoutRoot: "/repo/.worktrees/m", branch: "feature/mission-run_m", baseBranch: "develop",
      evidence: { headSha: "f00", dirty: false, hasCommits: true, pushed: true, merged: true, checkedAt: 9, notes: [] },
      merged: true, released: null,
    };
    const places = missionWhere({ ...run, missionDelivery: [delivery] }, [prepared, planned, other, notMission]);
    expect(places.map((place) => [place.repositoryRoot, place.planned, !!place.delivery])).toEqual([
      ["/api", true, false],
      ["/repo", false, true],
    ]);
    expect(placeStanding(places[0])).toBe("Planned · not created yet");
    expect(placeStanding(places[1])).toBe("Merged · release unverified");
  });

  it("keeps a closed mission's delivery after its worktree is gone", () => {
    const cleaned = task("build", { workspace: { plan: plan("/repo"), state: "cleaned", abandoned: false, validationPaths: [] } });
    const delivery = {
      repositoryRoot: "/repo", checkoutRoot: "/repo/.worktrees/m", branch: "feature/mission-run_m", baseBranch: "develop",
      evidence: { headSha: "f00", dirty: false, hasCommits: true, pushed: true, merged: true, checkedAt: 9, notes: [] },
      merged: true, released: true, removed: true, branchDeleted: true,
    };
    const [place] = missionWhere({ ...run, status: "closed", missionDelivery: [delivery] }, [cleaned]);
    expect(placeStanding(place)).toBe("Merged · released · worktree removed, branch deleted");
  });
});

describe("reassignment", () => {
  const directory = {
    projects: [
      { id: "proj", name: "octiq-flow", reports: [{ id: "maya", name: "Maya", role: "Developer" }, { id: "zed", name: "Zed" }, { id: "noah", name: "Noah" }] },
      { id: "other", name: "Other", reports: [{ id: "far", name: "Far" }] },
    ],
  };
  const crew = [{ id: "cto" }, { id: "maya" }, { id: "noah" }];

  it("offers the lead's reports at the task's destination, crew first, never the current owner", () => {
    expect(reassignChoices(directory, run, tasks[0], crew)).toEqual([
      { id: "noah", name: "Noah", inCrew: true },
      { id: "zed", name: "Zed", inCrew: false },
    ]);
    const elsewhere = { ...tasks[0], destination: { projectId: "other", projectName: "Other", repository: "/o" } };
    expect(reassignChoices(directory, run, elsewhere, crew).map((choice) => choice.id)).toEqual(["far"]);
    expect(reassignChoices(null, run, tasks[0], crew)).toEqual([]);
  });

  it("says why the host would refuse, before the person tries", () => {
    expect(reassignBlocker(run, tasks[0], attempts)).toMatch(/still working/);
    expect(reassignBlocker(run, tasks[1], attempts)).toMatch(/not finished/);
    expect(reassignBlocker(run, task("x", {}), [])).toMatch(/registered agent/);
    expect(reassignBlocker({ ...run, status: "closed" }, tasks[2], [])).toMatch(/ended/);
    expect(reassignBlocker(run, { ...tasks[2], parentTaskId: "p" }, [])).toMatch(/subtask/);
    expect(reassignBlocker(run, tasks[2], [])).toBeNull();
    expect(reassignBlocker(run, { ...tasks[0], status: "failed" }, [{ ...attempts[0], status: "failed" }])).toBeNull();
  });

  it("asks the host as the lead, with the person's words and that it was the person", () => {
    expect(reassignRequest(run, tasks[2], "zed", "  Noah is out  ")).toEqual({
      actorChatKey: "chat:lead", taskId: "review", assignee: "zed",
      reason: "Noah is out (reassigned by the person from the Mission page)",
    });
    expect(reassignReason("x")).toContain("the person");
  });
});

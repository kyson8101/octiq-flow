import { describe, expect, it } from "vitest";
import { taskCardRows } from "./taskPlanCard";
import type { OrchestrationAttempt, OrchestrationTask, TaskWorkspace, WorkspaceProposal } from "./orchestration";

const run = { workspaceId: "p-general", rootPath: "/code/General" };
const names = (id: string) => ({ "p-general": "General", "p-flow": "octiq-flow" } as Record<string, string>)[id];

const task = (patch: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id: "t1", runId: "r1", title: "Show destinations", spec: "…", dependsOn: [], status: "pending",
  createdAt: 1, updatedAt: 1,
  assignee: { id: "a1", name: "Maya" },
  worker: { agent: "claude", access: "auto", model: "opus", effort: "high" },
  destination: { projectId: "p-flow", projectName: "octiq-flow", repository: "/code/octiq-flow" },
  ...patch,
});

const workspace = (state: TaskWorkspace["state"]): TaskWorkspace => ({
  plan: { mode: "worktree", cwd: "/code/.worktrees/octiq-flow/feature/t1", checkoutRoot: "/code/.worktrees/octiq-flow/feature/t1",
    repositoryRoot: "/code/octiq-flow", branch: "feature/t1", baseBranch: "develop", baseSha: "x", managed: true,
    isRepo: true, warnings: [], initialStatus: "" },
  state, abandoned: false, validationPaths: [],
});

const row = (rows: ReturnType<typeof taskCardRows>, key: string) => rows.find((r) => r.key === key)!;

const proposal = (patch: Partial<WorkspaceProposal> = {}): WorkspaceProposal => ({
  plan: { ...workspace("preparing").plan, branch: "feature/octiq-t1", cwd: "/code/.worktrees/octiq-flow/feature/octiq-t1/",
    checkoutRoot: "/code/.worktrees/octiq-flow/feature/octiq-t1" },
  newBranch: true, proposedAt: 1,
  ...patch,
});

describe("the standard plan card", () => {
  it("says the workspace is pending in one row when nothing is planned yet", () => {
    const rows = taskCardRows(task(), run, null, names);
    expect(row(rows, "project")).toMatchObject({ value: "octiq-flow", copy: { text: "/code/octiq-flow" } });
    expect(row(rows, "project").state).toBeUndefined();
    expect(row(rows, "workspace")).toMatchObject({ value: "Allocated when the task starts", state: "pending" });
    expect(rows.filter((r) => r.state === "pending")).toHaveLength(1);
    expect(rows.some((r) => r.key === "branch" || r.key === "directory")).toBe(false);
    expect(row(rows, "owner").value).toBe("Maya");
    expect(row(rows, "model").value).toMatch(/Claude/);
    expect(row(rows, "effort").value).toBe("high");
  });

  it("names the host's planned branch with (new) straight after it, and the planned directory", () => {
    const rows = taskCardRows(task({ workspaceProposal: proposal() }), run, null, names);
    expect(row(rows, "branch").value).toBe("feature/octiq-t1 (new) from develop");
    expect(row(rows, "branch").copy).toEqual({ text: "feature/octiq-t1", name: "branch name" });
    expect(row(rows, "directory")).toMatchObject({
      value: "/code/.worktrees/octiq-flow/feature/octiq-t1/", code: true,
      copy: { text: "/code/.worktrees/octiq-flow/feature/octiq-t1/", name: "work directory path" },
    });
    expect(row(rows, "worktree")).toMatchObject({ value: "New worktree", state: "planned" });
    // Planned, never confirmed, and never Pending beside a known value.
    expect(rows.filter((r) => r.state)).toHaveLength(1);
  });

  it("surfaces a collision instead of calling the branch new", () => {
    const conflict = "Branch feature/octiq-t1 already exists.";
    const rows = taskCardRows(task({ workspaceProposal: proposal({ newBranch: false, conflict }) }), run, null, names);
    expect(row(rows, "branch").value).toBe("feature/octiq-t1 from develop");
    expect(row(rows, "worktree")).toMatchObject({ state: "conflict" });
    expect(row(rows, "worktree").note).toContain(conflict);
  });

  it("says when the host could not plan a workspace", () => {
    const rows = taskCardRows(task({ workspaceProposal: { newBranch: false, error: "Worktree mode requires a Git repository.", proposedAt: 1 } }), run, null, names);
    expect(row(rows, "workspace")).toMatchObject({ value: "Could not be planned", state: "unplanned", note: "Worktree mode requires a Git repository." });
  });

  it("plans the current checkout on its own branch, never as new", () => {
    const direct = proposal({
      newBranch: false,
      plan: { ...workspace("preparing").plan, mode: "direct", managed: false, branch: "develop", baseBranch: "develop", cwd: "/code/octiq-flow", checkoutRoot: "/code/octiq-flow" },
    });
    const rows = taskCardRows(task({ workspaceProposal: direct }), run, null, names);
    expect(row(rows, "branch").value).toBe("develop");
    expect(row(rows, "worktree")).toMatchObject({ value: "Current checkout", state: "planned" });
  });

  it("shows the prepared plan, then the host-confirmed attempt", () => {
    const planned = taskCardRows(task({ workspace: workspace("preparing"), workspaceProposal: proposal() }), run, null, names);
    expect(row(planned, "directory").value).toBe("/code/.worktrees/octiq-flow/feature/t1");
    expect(row(planned, "branch").value).toBe("feature/t1 from develop");
    expect(row(planned, "worktree")).toMatchObject({ value: "Worktree · Preparing", state: "planned" });

    const attempt = { cwd: "/code/.worktrees/octiq-flow/feature/t1", branch: "feature/t1" } as OrchestrationAttempt;
    const confirmed = taskCardRows(task({ workspace: workspace("ready") }), run, attempt, names);
    expect(row(confirmed, "worktree")).toMatchObject({ value: "Worktree · Ready", state: "confirmed" });
  });

  it("never calls an allocated or retained workspace's branch new", () => {
    for (const state of ["preparing", "ready", "retained"] as const) {
      const rows = taskCardRows(task({ workspace: workspace(state), workspaceProposal: proposal() }), run, null, names);
      expect(row(rows, "branch").value).not.toContain("(new)");
    }
    const retained = taskCardRows(task({ workspace: workspace("retained") }), run, null, names);
    expect(row(retained, "worktree")).toMatchObject({ value: "Worktree · Kept for review", state: "confirmed" });
  });

  it("marks a removed worktree as removed, never current", () => {
    const attempt = { cwd: "/code/.worktrees/octiq-flow/feature/t1", branch: "feature/t1" } as OrchestrationAttempt;
    const rows = taskCardRows(task({ workspace: workspace("cleaned") }), run, attempt, names);
    expect(row(rows, "worktree")).toMatchObject({ value: "Worktree · Removed", state: "removed" });
  });

  it("falls back to the run's project for a task without a destination", () => {
    const rows = taskCardRows(task({ destination: undefined, assignee: undefined, worker: undefined }), run, null, names);
    expect(row(rows, "project").value).toBe("General");
    expect(row(rows, "owner").value).toBe("Chosen by the lead");
    expect(rows.some((r) => r.key === "model")).toBe(false);
  });
});

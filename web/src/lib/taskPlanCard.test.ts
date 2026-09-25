import { describe, expect, it } from "vitest";
import { taskCardRows } from "./taskPlanCard";
import type { OrchestrationAttempt, OrchestrationTask, TaskWorkspace } from "./orchestration";

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

describe("the standard plan card", () => {
  it("says Pending for everything the host has not allocated yet", () => {
    const rows = taskCardRows(task(), run, null, names);
    expect(row(rows, "project")).toMatchObject({ value: "octiq-flow", state: "planned", path: "/code/octiq-flow" });
    expect(row(rows, "directory")).toMatchObject({ value: "Pending, allocated when the task starts", state: "pending" });
    expect(row(rows, "branch")).toMatchObject({ value: "Pending", state: "pending" });
    expect(row(rows, "worktree")).toMatchObject({ value: "Not allocated yet", state: "pending" });
    expect(row(rows, "owner").value).toBe("Maya");
    expect(row(rows, "model").value).toMatch(/Claude/);
    expect(row(rows, "effort").value).toBe("high");
  });

  it("shows the prepared plan, then the host-confirmed attempt", () => {
    const planned = taskCardRows(task({ workspace: workspace("preparing") }), run, null, names);
    expect(row(planned, "directory")).toMatchObject({ value: "/code/.worktrees/octiq-flow/feature/t1", state: "planned" });
    expect(row(planned, "branch")).toMatchObject({ value: "feature/t1 from develop", state: "planned" });
    expect(row(planned, "worktree")).toMatchObject({ value: "Worktree · Preparing", state: "planned" });

    const attempt = { cwd: "/code/.worktrees/octiq-flow/feature/t1", branch: "feature/t1" } as OrchestrationAttempt;
    const confirmed = taskCardRows(task({ workspace: workspace("ready") }), run, attempt, names);
    expect(row(confirmed, "directory").state).toBe("confirmed");
    expect(row(confirmed, "branch").state).toBe("confirmed");
    expect(row(confirmed, "worktree")).toMatchObject({ value: "Worktree · Ready", state: "confirmed" });
    expect(row(confirmed, "project").state).toBe("confirmed");
  });

  it("marks a removed worktree as removed, never current", () => {
    const attempt = { cwd: "/code/.worktrees/octiq-flow/feature/t1", branch: "feature/t1" } as OrchestrationAttempt;
    const rows = taskCardRows(task({ workspace: workspace("cleaned") }), run, attempt, names);
    expect(row(rows, "directory").state).toBe("removed");
    expect(row(rows, "worktree")).toMatchObject({ value: "Worktree · Removed", state: "removed" });
  });

  it("falls back to the run's project for a task without a destination", () => {
    const rows = taskCardRows(task({ destination: undefined, assignee: undefined, worker: undefined }), run, null, names);
    expect(row(rows, "project").value).toBe("General");
    expect(row(rows, "owner").value).toBe("Chosen by the lead");
    expect(rows.some((r) => r.key === "model")).toBe(false);
  });
});

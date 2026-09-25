import { describe, expect, it } from "vitest";
import { taskEnvironment, type LaunchPlan } from "./taskEnvironment";
import type { TaskStatus, TaskWorkspace } from "./chatTask";
import type { OrchestrationTask, TaskWorkspace as OrchWorkspace } from "./orchestration";

const names = (id: string) => ({ "p-flow": "octiq-flow", "p-general": "General", "p-hr": "pandahrms" } as Record<string, string>)[id];

const workspace = (patch: Partial<TaskWorkspace> = {}): TaskWorkspace => ({
  cwd: "/code/.worktrees/octiq-flow/octiq/fix-bar",
  exists: true,
  isRepo: true,
  repoRoot: "/code/.worktrees/octiq-flow/octiq/fix-bar",
  primaryRoot: "/code/octiq-flow",
  branch: "octiq/fix-bar",
  isWorktree: true,
  changed: 0, ahead: 0, behind: 0, hasUpstream: false,
  ...patch,
});

const status = (patch: Partial<TaskStatus> = {}): TaskStatus => ({
  chatId: "c1",
  projectId: "p-flow",
  workspace: workspace(),
  target: { branch: "develop", setAt: 1, setBy: "agent" },
  delivery: {
    target: "develop", head: "abc", onTarget: false, commits: 0, uncommitted: 0, pushed: false,
    merged: false, mergedRemote: false, released: null, releaseNote: "", stale: false, checkedAt: 42,
  },
  ...patch,
});

const launch: LaunchPlan = {
  projectId: "p-flow", projectName: "octiq-flow", path: "/code/octiq-flow", baseBranch: "develop",
  newWorktree: true, useSandbox: false, prepare: true, chosenBy: "auto",
};

const row = (rows: ReturnType<typeof taskEnvironment>["rows"], key: string) => rows.find((r) => r.key === key)!;

describe("taskEnvironment", () => {
  it("shows host-verified facts as verified, with the plan kept apart", () => {
    const { rows, checkedAt } = taskEnvironment({ status: status(), launch, projectName: names });
    expect(checkedAt).toBe(42);
    expect(row(rows, "project")).toMatchObject({ value: "octiq-flow", evidence: "confirmed" });
    expect(row(rows, "repository")).toMatchObject({ value: "/code/octiq-flow", evidence: "confirmed" });
    expect(row(rows, "directory")).toMatchObject({ value: "/code/.worktrees/octiq-flow/octiq/fix-bar", evidence: "confirmed", planned: "/code/octiq-flow" });
    expect(row(rows, "branch")).toMatchObject({ value: "octiq/fix-bar", evidence: "confirmed", planned: "New branch from develop" });
    expect(row(rows, "checkout")).toMatchObject({ value: "Task worktree", evidence: "confirmed", planned: "New worktree", path: "/code/.worktrees/octiq-flow/octiq/fix-bar" });
    // git keeps no record of a base: it is only ever the plan's.
    expect(row(rows, "base")).toMatchObject({ value: "develop", evidence: "planned" });
    expect(row(rows, "target")).toMatchObject({ value: "develop", evidence: "confirmed" });
    expect(row(rows, "sandbox")).toMatchObject({ value: "Off", evidence: "planned" });
  });

  it("never shows a plan as verified before the host has checked", () => {
    const { rows } = taskEnvironment({ status: undefined, launch, projectName: names });
    for (const key of ["project", "directory", "branch", "checkout"]) {
      expect(row(rows, key).evidence).toBe("planned");
    }
    expect(row(rows, "repository").evidence).toBe("planned");
  });

  it("marks a restored chat whose directory is gone as stale or removed", () => {
    const stale = status({ delivery: { ...status().delivery!, stale: true } });
    expect(row(taskEnvironment({ status: stale, launch }).rows, "branch").evidence).toBe("stale");
    const gone = status({ workspace: workspace({ exists: false }), delivery: { ...status().delivery!, stale: true } });
    const rows = taskEnvironment({ status: gone, launch }).rows;
    expect(row(rows, "checkout")).toMatchObject({ value: "Task worktree (removed)", evidence: "removed" });
    expect(row(rows, "directory").evidence).toBe("removed");
  });

  it("reads a worker's plan from its orchestration task, across projects", () => {
    const plan: OrchWorkspace = {
      plan: { mode: "worktree", cwd: "/code/.worktrees/pandahrms/task-1", checkoutRoot: "/code/.worktrees/pandahrms/task-1",
        repositoryRoot: "/code/pandahrms", branch: "feature/task-1", baseBranch: "main", baseSha: "x", managed: true,
        isRepo: true, warnings: [], initialStatus: "" },
      state: "cleaned", abandoned: false, validationPaths: [],
    };
    const task = { id: "t1", runId: "r1", title: "x", spec: "", dependsOn: [], status: "completed", createdAt: 1, updatedAt: 1,
      destination: { projectId: "p-hr", projectName: "pandahrms", repository: "/code/pandahrms" }, workspace: plan } as OrchestrationTask;
    const { rows } = taskEnvironment({ status: undefined, worker: { task }, projectName: names });
    expect(row(rows, "project")).toMatchObject({ value: "pandahrms", evidence: "planned" });
    expect(row(rows, "repository")).toMatchObject({ value: "/code/pandahrms", evidence: "removed" });
    expect(row(rows, "branch")).toMatchObject({ value: "feature/task-1", evidence: "planned" });
    expect(row(rows, "base").value).toBe("main");
    expect(row(rows, "checkout").value).toBe("New worktree");
  });

  it("reports the sandbox by its own state", () => {
    const sandbox = { id: "s", chatKey: "chat:c1", enabled: true, locked: false, cwd: "/x", state: "error" as const,
      checkedAt: null, error: "port busy", urls: {}, sourceRevision: null, sourceDirty: null, fixtureVersion: null };
    expect(row(taskEnvironment({ status: status(), sandbox }).rows, "sandbox")).toMatchObject({ value: "Failed: port busy", evidence: "unknown" });
    expect(row(taskEnvironment({ status: status() }).rows, "sandbox")).toMatchObject({ value: "Unknown", evidence: "unknown" });
  });
});

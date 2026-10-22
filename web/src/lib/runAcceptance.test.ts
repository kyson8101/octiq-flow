import { describe, expect, it } from "vitest";
import type { OrchestrationTask, TaskWorkspace } from "./orchestration";
import { checkCoverage, runStages } from "./runAcceptance";

const task = (id: string, over: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId: "r", title: id, spec: "", dependsOn: [], status: "completed", createdAt: 1, updatedAt: 1, ...over,
});
const workspace = (merged: boolean | null): TaskWorkspace => ({
  plan: { mode: "worktree", cwd: "/w", checkoutRoot: "/w", repositoryRoot: "/r", branch: "b", baseBranch: "develop", baseSha: "0", managed: true, isRepo: true, warnings: [], initialStatus: "" },
  state: "retained", abandoned: false, validationPaths: [],
  delivery: merged === null ? null : { headSha: "1", dirty: false, hasCommits: true, pushed: true, merged, checkedAt: 1, notes: [] },
});

describe("acceptance coverage comes from planned checks and reported verdicts (feedback ee0a43b0)", () => {
  it("counts only explicit check tasks, and keeps a missing verdict apart from a pass", () => {
    const tasks = [
      task("review", { kind: "review", verdict: "pass" }),
      task("test", { kind: "check", verdict: "fail" }),
      task("accept", { kind: "acceptance", status: "running" }),
      task("legacy-check", { kind: "check" }),
      task("build"),
      task("old-review", { verdict: "fail" }),
      task("dropped", { kind: "check", status: "cancelled" }),
    ];
    expect(checkCoverage(tasks)).toEqual({
      total: 4, passed: 1, failed: 1, failedRed: 1, awaiting: 1, noVerdict: 1, observed: { passed: 0, failed: 1 },
    });
  });

  it("never reads every task done as accepted", () => {
    const stages = runStages([task("a"), task("b")]);
    const by = Object.fromEntries(stages.map((stage) => [stage.key, stage]));
    expect(by.tasks.value).toBe("2 of 2");
    expect(by.checks.value).toBe("None planned");
    expect(by.acceptance.value).toBe("Unverified");
    expect(by.deployed.value).toBe("Unverified");
    expect(by.deployed.note).toContain("Nothing merged yet");
  });

  it("says passed checks are passed checks, not product acceptance, and a failure is failing", () => {
    const passed = runStages([task("a", { kind: "acceptance", verdict: "pass" })]);
    const acceptance = passed.find((stage) => stage.key === "acceptance")!;
    expect(acceptance.value).toBe("Every planned check passed");
    expect(acceptance.note).toContain("not a record that the product was accepted");
    const failing = runStages([task("a", { kind: "acceptance", verdict: "pass" }), task("b", { kind: "review", verdict: "fail" })]);
    expect(failing.find((stage) => stage.key === "acceptance")!.value).toBe("Failing");
  });

  it("keeps integration and deployment as separate evidence", () => {
    const tasks = [
      task("merged", { workspace: workspace(true) }),
      task("pushed", { workspace: workspace(false) }),
      task("unchecked", { workspace: workspace(null) }),
    ];
    const stages = Object.fromEntries(runStages(tasks).map((s) => [s.key, s]));
    expect(stages.integration.value).toBe("1 of 3 branches merged · 1 prepared, not merged");
    expect(stages.integration.note).toContain("1 not checked yet");
    // Merged, but the project has no release check: unverified, not "no".
    expect(stages.deployed.value).toBe("Unverified");
    expect(stages.deployed.note).toContain("no release check");
  });

  it("says what the release check found for merged heads (feedback ee0a43b0)", () => {
    const released = (value: boolean | undefined) => {
      const ws = workspace(true);
      return { ...ws, delivery: { ...ws.delivery!, released: value } };
    };
    const stages = Object.fromEntries(runStages([
      task("live", { workspace: released(true) }),
      task("waiting", { workspace: released(false) }),
      task("unknown", { workspace: released(undefined) }),
    ]).map((s) => [s.key, s]));
    expect(stages.deployed.value).toBe("1 of 3 merged branches released");
    expect(stages.deployed.note).toContain("unverified, not unreleased");
  });
});

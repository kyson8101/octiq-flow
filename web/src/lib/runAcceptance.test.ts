import { describe, expect, it } from "vitest";
import type { OrchestrationAttempt, OrchestrationTask, TaskWorkspace } from "./orchestration";
import { checkCoverage, runStages, taskEnvironment } from "./runAcceptance";
import type { SandboxEnvironment, SandboxSnapshot } from "./sandbox";

const task = (id: string, over: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId: "r", title: id, spec: "", dependsOn: [], status: "completed", createdAt: 1, updatedAt: 1, ...over,
});
const attempt = (id: string, taskId: string, key: string): OrchestrationAttempt => ({
  id, runId: "r", taskId, number: 1, workerChatKey: key, agent: "claude", access: "auto", status: "completed",
  cwd: "/w", branch: "b", isWorktree: true, filesModified: [], createdAt: 1, updatedAt: 1,
});
const env = (key: string, over: Partial<SandboxEnvironment> = {}): SandboxEnvironment => ({
  id: `octiq-sb-${key}`, chatKey: key, enabled: true, locked: true, cwd: "/w", state: "ready",
  checkedAt: 1_000, error: null, urls: {}, sourceRevision: "abcdef1234", sourceDirty: false, fixtureVersion: "v1", ...over,
});
const workspace = (merged: boolean | null): TaskWorkspace => ({
  plan: { mode: "worktree", cwd: "/w", checkoutRoot: "/w", repositoryRoot: "/r", branch: "b", baseBranch: "develop", baseSha: "0", managed: true, isRepo: true, warnings: [], initialStatus: "" },
  state: "retained", abandoned: false, validationPaths: [],
  delivery: merged === null ? null : { headSha: "1", dirty: false, hasCommits: true, pushed: true, merged, checkedAt: 1, notes: [] },
});
const ago = (at: number) => `at ${at}`;

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
      total: 4, passed: 1, failed: 1, awaiting: 1, noVerdict: 1, observed: { passed: 0, failed: 1 },
    });
  });

  it("never reads every task done as accepted", () => {
    const stages = runStages([task("a"), task("b")], [], null);
    const by = Object.fromEntries(stages.map((stage) => [stage.key, stage]));
    expect(by.tasks.value).toBe("2 of 2");
    expect(by.checks.value).toBe("None planned");
    expect(by.acceptance.value).toBe("Unverified");
    expect(by.deployed.value).toBe("Unverified");
    expect(by.deployed.note).toContain("Nothing merged yet");
  });

  it("says passed checks are passed checks, not product acceptance, and a failure is failing", () => {
    const passed = runStages([task("a", { kind: "acceptance", verdict: "pass" })], [], null);
    const acceptance = passed.find((stage) => stage.key === "acceptance")!;
    expect(acceptance.value).toBe("Every planned check passed");
    expect(acceptance.note).toContain("not a record that the product was accepted");
    const failing = runStages([task("a", { kind: "acceptance", verdict: "pass" }), task("b", { kind: "review", verdict: "fail" })], [], null);
    expect(failing.find((stage) => stage.key === "acceptance")!.value).toBe("Failing");
  });

  it("keeps integration, sandbox runtime and deployment as separate evidence", () => {
    const tasks = [
      task("merged", { workspace: workspace(true) }),
      task("pushed", { workspace: workspace(false) }),
      task("unchecked", { workspace: workspace(null), environment: "sandbox", activeAttemptId: "a1" }),
    ];
    const sandboxes: SandboxSnapshot = { defaultEnabled: false, environments: { "chat:w1": env("chat:w1") } };
    const stages = Object.fromEntries(runStages(tasks, [attempt("a1", "unchecked", "chat:w1")], sandboxes).map((s) => [s.key, s]));
    expect(stages.integration.value).toBe("1 of 3 branches merged · 1 prepared, not merged");
    expect(stages.integration.note).toContain("1 not checked yet");
    expect(stages.sandbox.value).toBe("1 ready");
    expect(stages.sandbox.note).toContain("not a deployment");
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
    ], [], null).map((s) => [s.key, s]));
    expect(stages.deployed.value).toBe("1 of 3 merged branches released");
    expect(stages.deployed.note).toContain("unverified, not unreleased");
  });
});

describe("a task's environment, apart from its status (feedback caa2ca88 B4)", () => {
  const sandboxTask = task("t", { environment: "sandbox", status: "running", activeAttemptId: "a2" });
  const attempts = [attempt("a2", "t", "chat:w2")];

  it("shows state, age and what it was checked against", () => {
    const view = taskEnvironment(sandboxTask, attempts, {
      defaultEnabled: false,
      environments: { "chat:w2": env("chat:w2", { fingerprint: { sources: [{ path: "/repo/api", revision: "0123456789", dirty: true, digest: "d" }], recipe: "r", fixtureVersion: "v1" }, probedAt: 2_000 }) },
    }, ago)!;
    expect(view.label).toBe("Env ready · at 1000");
    expect(view.tone).toBe("ok");
    expect(view.detail).toContain("/repo/api @ 01234567 + local changes");
    expect(view.detail).toContain("Health looked at at 2000; nothing wrong found");
    const unprobed = taskEnvironment(sandboxTask, attempts, { defaultEnabled: false, environments: { "chat:w2": env("chat:w2", { probing: true }) } }, ago)!;
    expect(unprobed.detail).toContain("Health probe in progress");
    expect(unprobed.detail).toContain("Health not looked at since this check");
    expect(view.detail.at(-1)).toContain("not a release");
  });

  it("names why it is stale or unhealthy, who stopped it, and a slot wait", () => {
    const stale = taskEnvironment(sandboxTask, attempts, { defaultEnabled: false, environments: {
      "chat:w2": env("chat:w2", { state: "stale", invalidated: { kind: "stale", reason: "/repo: HEAD moved from a to b since the last check.", at: 3 } }),
    } }, ago)!;
    expect(stale.label).toBe("Env stale");
    expect(stale.tone).toBe("warn");
    expect(stale.detail[0]).toContain("HEAD moved");
    const stopped = taskEnvironment(sandboxTask, attempts, { defaultEnabled: false, environments: {
      "chat:w2": env("chat:w2", { state: "stopped", stopped: { by: "host", reason: "Its task is done and nothing that depends on it is still to run. Volumes are kept.", at: 4 } }),
    } }, ago)!;
    expect(stopped.detail[0]).toMatch(/^Stopped by OctiqFlow: .*Volumes are kept/);
    const waiting = taskEnvironment(sandboxTask, attempts, {
      defaultEnabled: false, environments: {},
      capacity: { limit: 3, live: ["x", "y", "z"], waiting: [{ label: "t", keys: ["chat:w2", "chat:dep"], since: 1 }] },
    }, ago)!;
    expect(waiting.state).toBe("waiting_for_capacity");
    expect(waiting.detail[0]).toContain("All 3 host environment slots");
    // A dependency listed second is not the one waiting.
    const dependency = taskEnvironment(task("d", { environment: "sandbox", activeAttemptId: "a3" }), [attempt("a3", "d", "chat:dep")], {
      defaultEnabled: false, environments: { "chat:dep": env("chat:dep") },
      capacity: { limit: 3, live: [], waiting: [{ label: "t", keys: ["chat:w2", "chat:dep"], since: 1 }] },
    }, ago)!;
    expect(dependency.state).toBe("ready");
  });

  it("is nothing for a task that needs no environment", () => {
    expect(taskEnvironment(task("plain"), [], null, ago)).toBeNull();
  });
});

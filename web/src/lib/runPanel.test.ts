import { describe, expect, it, vi } from "vitest";
import type { OrchestrationAttempt, OrchestrationGate, OrchestrationRun, OrchestrationTask } from "./orchestration";
import { attentionLabel, mainChatTarget, nextRunTab, runAttention, splitArchived, stopRun } from "./runPanel";

const run = (id: string, coordinatorChatKey: string, extra: Partial<OrchestrationRun> = {}): OrchestrationRun => ({
  id, objective: id, coordinatorChatKey, workspaceId: "project", rootPath: "/repo",
  status: "running", maxConcurrent: 2, createdAt: 1, updatedAt: 1, ...extra,
});
const task = (id: string, status: OrchestrationTask["status"], extra: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId: "a", title: id, spec: "", dependsOn: [], status, createdAt: 1, updatedAt: 1, ...extra,
});
const gate = (id: string, taskId?: string): OrchestrationGate => ({
  id, runId: "a", taskId, createdByChatKey: "chat:w", targetChatKey: "chat:main", question: "?", options: [],
  status: "open", createdAt: 1, updatedAt: 1,
});

describe("run tabs", () => {
  it("moves with arrows, wraps, and jumps with Home/End", () => {
    expect(nextRunTab("tasks", "ArrowRight")).toBe("notifications");
    expect(nextRunTab("log", "ArrowRight")).toBe("tasks");
    expect(nextRunTab("tasks", "ArrowLeft")).toBe("log");
    expect(nextRunTab("notifications", "Home")).toBe("tasks");
    expect(nextRunTab("tasks", "End")).toBe("log");
    expect(nextRunTab("tasks", "Enter")).toBeNull();
  });
});

describe("run attention", () => {
  it("counts a task blocked by a decision once, and a plan waiting as a decision", () => {
    const a = run("a", "chat:main", { planApproval: { status: "pending", requestedAt: 1 } });
    const tasks = [task("gated", "blocked"), task("stuck", "failed"), task("fine", "running")];
    const attention = runAttention(a, tasks, [], [gate("g", "gated")]);
    expect(attention).toEqual({ decisions: 2, blocked: 1, total: 3 });
    expect(attentionLabel(attention, true)).toBe("2 to decide");
  });

  it("names a stalled worker as blocked, and says nothing when nothing is owed", () => {
    const a = run("a", "chat:main");
    const attempt = { id: "at", runId: "a", taskId: "t", execution: { state: "stalled", retryCount: 0 } } as OrchestrationAttempt;
    const stalled = runAttention(a, [task("t", "running", { activeAttemptId: "at" })], [attempt], []);
    expect(attentionLabel(stalled, false)).toBe("1 blocked");
    expect(attentionLabel(runAttention(a, [task("t", "completed")], [], []), false)).toBeNull();
    // A plan on a stopped run is no longer waiting on anyone.
    const stopped = run("a", "chat:main", { status: "stopped", planApproval: { status: "pending", requestedAt: 1 } });
    expect(runAttention(stopped, [], [], []).total).toBe(0);
    // Nor is a failure in it: nothing can retry a stopped run.
    expect(runAttention(stopped, [task("t", "failed")], [], []).total).toBe(0);
  });
});

describe("main chat routing", () => {
  it("goes to the coordinator the ledger names for the run on screen", () => {
    const runs = [run("a", "chat:cto"), run("b", "chat:noah")];
    expect(mainChatTarget(runs, "b", "chat:cto")).toBe("chat:noah");
    expect(mainChatTarget(runs, "a", "chat:noah")).toBe("chat:cto");
    // Nothing selected yet: the first run shown, then the panel's own chat.
    expect(mainChatTarget(runs, null, "chat:other")).toBe("chat:cto");
    expect(mainChatTarget([], null, "chat:other")).toBe("chat:other");
  });

  it("keeps archived runs apart from the list", () => {
    const { live, archived } = splitArchived([run("a", "c"), run("b", "c", { status: "stopped", archivedAt: 5 })]);
    expect(live.map((item) => item.id)).toEqual(["a"]);
    expect(archived.map((item) => item.id)).toEqual(["b"]);
  });
});

describe("stop, then archive", () => {
  const target = run("run_1", "chat:main");
  const succeed = () => vi.fn(async (_command: string, _args: Record<string, unknown>) => null);

  it("stops only, when archive was not chosen", async () => {
    const invoke = succeed();
    expect(await stopRun(invoke, target, false)).toEqual({ ok: true, archived: false });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["orchestration_run_stop"]);
    expect(invoke).toHaveBeenCalledWith("orchestration_run_stop", expect.objectContaining({ actorChatKey: "chat:main", runId: "run_1" }));
  });

  it("archives only after the stop has landed", async () => {
    const invoke = succeed();
    expect(await stopRun(invoke, target, true)).toEqual({ ok: true, archived: true });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["orchestration_run_stop", "orchestration_run_archive"]);
    expect(invoke).toHaveBeenLastCalledWith("orchestration_run_archive", { actorChatKey: "chat:main", runId: "run_1", archived: true });
  });

  it("never archives when the stop fails, and says so", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "orchestration_run_stop") throw new Error("Only this run's coordinator may do that.");
      return null;
    });
    const outcome = await stopRun(invoke, target, true);
    expect(outcome).toEqual({ ok: false, stopped: false,
      error: "Could not stop this run: Only this run's coordinator may do that. Nothing was archived." });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("reports a stopped run whose archive failed as exactly that", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "orchestration_run_archive") throw new Error("disk full");
      return null;
    });
    expect(await stopRun(invoke, target, true)).toEqual({ ok: false, stopped: true,
      error: "Stopped, but could not archive: disk full The run stays in the list." });
  });
});

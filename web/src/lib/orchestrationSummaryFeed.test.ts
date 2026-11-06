import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ state: "open", handlers: new Map<string, Set<(p: never) => void>>(), states: new Set<(s: never) => void>(), reads: [] as Array<{ cmd: string; args?: Record<string, unknown>; resolve: (s: unknown) => void; reject: (e: unknown) => void }> }));
vi.mock("./bridge", () => ({ bridge: {
  get state() { return mock.state; },
  invoke: (cmd: string, args?: Record<string, unknown>) => new Promise((resolve, reject) => mock.reads.push({ cmd, args, resolve, reject })),
  on: (kind: string, fn: (p: never) => void) => { const set = mock.handlers.get(kind) ?? new Set(); set.add(fn); mock.handlers.set(kind, set); return () => set.delete(fn); },
  onState: (fn: (s: string) => void) => { mock.states.add(fn); fn(mock.state); return () => mock.states.delete(fn); },
} }));
import { createOrchestrationFeed } from "./orchestrationSummaryFeed";
import { EMPTY_ORCHESTRATION, type OrchestrationSnapshot } from "./orchestration";
import { detailedRun } from "./useOrchestrationSnapshot";
const summary = (id = "r", status = "running"): OrchestrationSnapshot => ({ ...EMPTY_ORCHESTRATION, summary: true, revision: "epoch:1", runRevisions: { [id]: "epoch:1" }, runs: [{ id, status, coordinatorChatKey: "chat:main" }], tasks: [{ id: `t-${id}`, runId: id, status: "running", spec: "" }], attempts: [{ id: `a-${id}`, runId: id, taskId: `t-${id}`, workerChatKey: "chat:w", execution: { state: "executing" }, filesModified: [] }] } as unknown as OrchestrationSnapshot);
const emit = (kind: string, payload: unknown) => { for (const fn of [...(mock.handlers.get(kind) ?? [])]) fn(payload as never); };
const tick = () => vi.advanceTimersByTimeAsync(1100);
beforeEach(() => { vi.useFakeTimers(); mock.state = "open"; mock.handlers.clear(); mock.states.clear(); mock.reads = []; });
afterEach(() => vi.useRealTimers());
it("whole-app readers receive only summary, with per-run invalidation and a follow-up for in-flight changes", async () => {
  const feed = createOrchestrationFeed(); const off = feed.subscribe(() => {});
  expect(mock.reads.map(r => r.cmd)).toEqual(["orchestration_summary"]);
  mock.reads[0].resolve(summary()); await tick();
  emit("orchestration-changed", { runId: "r", revision: "epoch:2" }); await tick();
  expect(mock.reads[1]).toMatchObject({ cmd: "orchestration_summary", args: { runId: "r" } });
  emit("orchestration-changed", { runId: "r", revision: "new-epoch:1" });
  mock.reads[1].resolve(summary("r", "waiting")); await tick();
  expect(mock.reads).toHaveLength(3);
  mock.reads[2].resolve(summary("r", "completed")); await tick();
  expect(feed.getState().snapshot?.runs[0].status).toBe("completed"); off();
});
it("leases detail separately, refetches only open runs and ignores replies after close/reopen", async () => {
  const feed = createOrchestrationFeed(); const off = feed.subscribe(() => {}); mock.reads[0].resolve(summary()); await tick();
  const a = feed.detail("r"), b = feed.detail("r");
  expect(mock.reads[1].cmd).toBe("orchestration_run_detail");
  const detail = { ...summary(), summary: false, tasks: [{ ...summary().tasks[0], spec: "x".repeat(1_000_000) }] };
  mock.reads[1].resolve(detail); await tick();
  expect(feed.getState().snapshot?.tasks[0].spec).toBe(""); expect(feed.getState().details?.get("r")?.tasks[0].spec).toHaveLength(1_000_000);
  emit("orchestration-changed", { runId: "other" }); await tick();
  expect(mock.reads.filter(r => r.cmd === "orchestration_run_detail")).toHaveLength(1);
  mock.reads[2].resolve(summary("other")); await tick();
  emit("orchestration-changed", { runId: "r", attemptId: "a-r", execution: { state: "waiting_tool" } }); await tick();
  expect(mock.reads.at(-1)?.cmd).toBe("orchestration_run_detail");
  a(); expect(feed.getState().details?.size).toBe(1); b(); b(); expect(feed.getState().details?.size).toBe(0);
  const c = feed.detail("r"); const latest = mock.reads.at(-1)!;
  mock.reads.at(-2)!.resolve(detail); await tick(); expect(feed.getState().details?.size).toBe(0);
  latest.resolve(detail); await tick(); expect(feed.getState().details?.size).toBe(1); c(); off();
});
it("does not turn network failure into legacy or an empty ledger", async () => {
  const feed = createOrchestrationFeed(); const off = feed.subscribe(() => {}); mock.reads[0].resolve(summary()); await tick();
  const refresh = feed.refresh(); mock.reads[1].reject(new Error("offline")); await expect(refresh).rejects.toThrow("offline");
  expect(mock.reads).toHaveLength(2); expect(feed.getState().snapshot?.runs[0].id).toBe("r"); off();
});
it("uses today's brief snapshot path only after explicit command-unavailable", async () => {
  const feed = createOrchestrationFeed(); const off = feed.subscribe(() => {});
  mock.reads[0].reject(new Error("'orchestration_summary' is not available on this backend")); await vi.advanceTimersByTimeAsync(0);
  expect(mock.reads[1]).toMatchObject({ cmd: "orchestration_snapshot", args: { brief: true } });
  mock.reads[1].resolve({ ...summary(), summary: undefined }); await tick();
  expect(feed.getState().snapshot?.runs[0].id).toBe("r"); off();
});
it("keeps current status facts with visible evidence and never restores cleared waits", () => {
  const small = summary();
  const full = { ...small, summary: false, tasks: [{ ...small.tasks[0], status: "completed", spec: "Brief" }], attempts: [{ ...small.attempts[0], filesModified: ["a.ts"] }], gates: [{ id: "old", runId: "r", status: "open", awaits: "person" }] } as OrchestrationSnapshot;
  const shown = detailedRun(small, full, "r");
  expect(shown.tasks[0]).toMatchObject({ status: "running", spec: "Brief" }); expect(shown.attempts[0].filesModified).toEqual(["a.ts"]);
  expect(shown.gates).toEqual([]);
});

it("global execution and task-report events cannot put transcript-sized text into summary", async () => {
  const feed = createOrchestrationFeed(); const off = feed.subscribe(() => {}); mock.reads[0].resolve(summary()); await tick();
  emit("orchestration-changed", { runId: "r", attemptId: "a-r", execution: { state: "executing", retryCount: 0, lastProgress: "x".repeat(1_000_000), pendingTools: { big: "x".repeat(1_000_000) } } });
  emit("chat-task", { chatId: "w", report: { objective: "x".repeat(1_000_000), nextStep: "x".repeat(1_000_000), steps: [{ state: "active", title: "x".repeat(10000) }], reportedAt: 1, reportedBy: "worker" } });
  expect(feed.getState().snapshot!.attempts[0].execution).not.toHaveProperty("lastProgress");
  expect(feed.getState().snapshot!.attempts[0].execution).not.toHaveProperty("pendingTools");
  expect(JSON.stringify(feed.getState().snapshot).length).toBeLessThan(3000);
  off();
});

it("coalesces detail invalidations during reads and keeps refetching after the trailing timer", async () => {
  const feed = createOrchestrationFeed(); const off = feed.subscribe(() => {}); mock.reads[0].resolve(summary()); await tick();
  const release = feed.detail("r");
  const change = () => emit("orchestration-changed", { runId: "r", attemptId: "a-r", execution: { state: "executing" } });
  change(); change(); await tick(); expect(mock.reads).toHaveLength(2);
  mock.reads[1].resolve({ ...summary(), summary: false }); await tick(); expect(mock.reads).toHaveLength(3);
  change(); mock.reads[2].resolve({ ...summary(), summary: false }); await tick(); expect(mock.reads).toHaveLength(4);
  mock.reads[3].resolve({ ...summary(), summary: false }); await tick();
  change(); await tick(); expect(mock.reads).toHaveLength(5);
  release(); mock.reads[4].resolve({ ...summary(), summary: false }); await tick();
  expect(feed.getState().details?.size).toBe(0); off();
});

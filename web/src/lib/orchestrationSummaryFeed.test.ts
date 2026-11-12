import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ state: "open", handlers: new Map<string, Set<(p: never) => void>>(), states: new Set<(s: never) => void>(), reads: [] as Array<{ cmd: string; args?: Record<string, unknown>; resolve: (s: unknown) => void; reject: (e: unknown) => void }> }));
vi.mock("./bridge", () => ({ bridge: {
  get state() { return mock.state; },
  invoke: (cmd: string, args?: Record<string, unknown>) => new Promise((resolve, reject) => mock.reads.push({ cmd, args, resolve, reject })),
  on: (kind: string, fn: (p: never) => void) => { const set = mock.handlers.get(kind) ?? new Set(); set.add(fn); mock.handlers.set(kind, set); return () => set.delete(fn); },
  onState: (fn: (s: string) => void) => { mock.states.add(fn); fn(mock.state); return () => mock.states.delete(fn); },
} }));
import { createOrchestrationFeed, replaceRun } from "./orchestrationSummaryFeed";
import { EMPTY_ORCHESTRATION, type OrchestrationSnapshot } from "./orchestration";
import { detailedRun } from "./useOrchestrationSnapshot";
import { useRunDetail } from "./useOrchestrationSnapshot";
import { orchestrationFeed } from "./orchestrationFeed";
import type { OrchestrationFeedState } from "./orchestrationFeed";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const summary = (id = "r", status = "running"): OrchestrationSnapshot => ({ ...EMPTY_ORCHESTRATION, summary: true, revision: "epoch:1", runRevisions: { [id]: "epoch:1" }, runs: [{ id, status, coordinatorChatKey: "chat:main" }], tasks: [{ id: `t-${id}`, runId: id, status: "running", spec: "" }], attempts: [{ id: `a-${id}`, runId: id, taskId: `t-${id}`, workerChatKey: "chat:w", execution: { state: "executing" }, filesModified: [] }] } as unknown as OrchestrationSnapshot);
const emit = (kind: string, payload: unknown) => { for (const fn of [...(mock.handlers.get(kind) ?? [])]) fn(payload as never); };
const tick = () => vi.advanceTimersByTimeAsync(1100);
beforeEach(() => { vi.useFakeTimers(); mock.state = "open"; mock.handlers.clear(); mock.states.clear(); mock.reads = []; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function readDetail(small: OrchestrationSnapshot, details: ReadonlyMap<string, OrchestrationSnapshot>, id = "r", detailPending?: ReadonlySet<string>) {
  vi.spyOn(orchestrationFeed, "getState").mockReturnValue({ snapshot: small, error: null, details, detailPending });
  let shown!: ReturnType<typeof useRunDetail>;
  function Probe() { shown = useRunDetail(small, id); return null; }
  renderToStaticMarkup(createElement(Probe));
  return shown;
}

function retainedView(state: OrchestrationFeedState, id = "r") {
  vi.spyOn(orchestrationFeed, "getState").mockReturnValue(state);
  let shown!: ReturnType<typeof useRunDetail>;
  function Probe() { shown = useRunDetail(state.snapshot!, id); return null; }
  renderToStaticMarkup(createElement(Probe));
  return shown;
}

it("retains released detail before reacquisition, but requires a new exact read after an unleased invalidation", async () => {
  const feed = createOrchestrationFeed(), off = feed.subscribe(() => {});
  mock.reads[0].resolve(summary()); await tick();
  const release = feed.detail("r");
  mock.reads[1].resolve({ ...summary(), summary: false }); await tick();
  release();
  expect(retainedView(feed.getState())).toMatchObject({ available: true, ready: false });
  emit("orchestration-changed", { runId: "r", revision: "epoch:2", attemptId: "a-r", execution: { state: "executing" } });
  await tick();
  expect(mock.reads.filter(r => r.cmd === "orchestration_run_detail")).toHaveLength(1);
  const again = feed.detail("r");
  expect(feed.getState().detailPending?.has("r")).toBe(true);
  expect(retainedView(feed.getState())).toMatchObject({ available: true, ready: false });
  mock.reads.at(-1)!.resolve({ ...summary(), summary: false }); await tick();
  expect(retainedView(feed.getState())).toMatchObject({ available: true, ready: false });
  emit("orchestration-changed", { runId: "r", revision: "epoch:2", attemptId: "a-r", execution: { state: "executing" } });
  await tick();
  mock.reads.at(-1)!.resolve({ ...summary(), summary: false, runRevisions: { r: "epoch:2" } }); await tick();
  expect(retainedView(feed.getState())).toMatchObject({ available: true, ready: true });
  again(); off();
});

it("keeps the retained display through a failed reacquisition and retries on the next lease", async () => {
  const feed = createOrchestrationFeed(), off = feed.subscribe(() => {});
  mock.reads[0].resolve(summary()); await tick();
  const release = feed.detail("r");
  mock.reads[1].resolve({ ...summary(), summary: false }); await tick(); release();
  const again = feed.detail("r");
  mock.reads.at(-1)!.reject(new Error("offline")); await tick();
  expect(retainedView(feed.getState())).toMatchObject({ available: true, ready: false, error: "Error: offline" });
  again();
  expect(feed.getState().detailErrors?.has("r")).toBe(false);
  const retry = feed.detail("r");
  expect(retainedView(feed.getState())).toMatchObject({ available: true, ready: false });
  mock.reads.at(-1)!.resolve({ ...summary(), summary: false }); await tick();
  expect(retainedView(feed.getState())).toMatchObject({ available: true, ready: true });
  retry(); off();
});

it("preserves legacy detail release behavior when summary is unavailable", async () => {
  const feed = createOrchestrationFeed(), off = feed.subscribe(() => {});
  mock.reads[0].reject(new Error("'orchestration_summary' is not available on this backend"));
  await vi.advanceTimersByTimeAsync(0);
  mock.reads[1].resolve({ ...summary(), summary: undefined, briefRuns: ["r"] }); await tick();
  const release = feed.detail("r");
  expect(mock.reads.at(-1)).toMatchObject({ cmd: "orchestration_snapshot", args: { runId: "r" } });
  mock.reads.at(-1)!.resolve({ ...summary(), summary: undefined, tasks: [{ ...summary().tasks[0], spec: "Legacy evidence" }] }); await tick();
  expect(feed.getState().snapshot?.tasks[0].spec).toBe("Legacy evidence");
  release(); await tick();
  expect(feed.getState().snapshot?.tasks[0].spec).toBe("");
  expect(feed.getState().retainedDetails?.size ?? 0).toBe(0);
  off();
});

it.each(["count", "bytes", "oversized", "removed"])("bounds retained display detail by %s and evicts least recently used runs", async mode => {
  const feed = createOrchestrationFeed(), off = feed.subscribe(() => {});
  const all = { ...summary(), runs: ["a", "b", "c", "d"].map(id => summary(id).runs[0]) };
  mock.reads[0].resolve(all); await tick();
  const retain = async (id: string) => {
    const release = feed.detail(id);
    const size = mode === "bytes" ? 750_000 : mode === "oversized" ? 2_200_000 : 0;
    mock.reads.at(-1)!.resolve({ ...summary(id), summary: false, tasks: [{ ...summary(id).tasks[0], spec: "x".repeat(size) }] });
    await tick(); release();
  };
  await retain("a"); await retain("b"); await retain("c");
  if (mode === "count") {
    await retain("a"); await retain("d");
    expect(retainedView(feed.getState(), "b").available).toBe(false);
    for (const id of ["a", "c", "d"]) expect(retainedView(feed.getState(), id)).toMatchObject({ available: true, ready: false });
  } else if (mode === "bytes") {
    expect(retainedView(feed.getState(), "a").available).toBe(false);
    for (const id of ["b", "c"]) expect(retainedView(feed.getState(), id).available).toBe(true);
  } else if (mode === "oversized") {
    for (const id of ["a", "b", "c"]) expect(retainedView(feed.getState(), id).available).toBe(false);
  } else {
    const refresh = feed.refresh(); mock.reads.at(-1)!.resolve({ ...all, runs: [] }); await refresh;
    const restore = feed.refresh(); mock.reads.at(-1)!.resolve(all); await restore;
    expect(retainedView(feed.getState(), "a").available).toBe(false);
  }
  off();
});

it.each(["summary-first", "detail-first"])("waits for the same run revision in both reads: %s", order => {
  const old = summary();
  old.runs[0].planApproval = { status: "pending", requestedAt: 1, revision: 1 };
  const next = structuredClone(old);
  next.runRevisions = { r: "epoch:2" };
  next.runs[0].planApproval!.revision = 2;
  const small = order === "summary-first" ? next : old;
  const full = { ...(order === "summary-first" ? old : next), summary: false };
  expect(readDetail(small, new Map([["r", full]])).ready).toBe(false);
  expect(readDetail(next, new Map([["r", { ...next, summary: false }]])).ready).toBe(true);
});

it("keeps a matching detail ready through repeated execution-only events, and reads again after a structural one", async () => {
  const feed = createOrchestrationFeed(), off = feed.subscribe(() => {});
  mock.reads[0].resolve(summary()); await tick();
  const release = feed.detail("r");
  mock.reads[1].resolve({ ...summary(), summary: false }); await tick();
  const view = () => readDetail(feed.getState().snapshot!, feed.getState().details!, "r", feed.getState().detailPending);
  expect(view()).toMatchObject({ available: true, ready: true });
  const reads = () => mock.reads.filter(r => r.cmd === "orchestration_run_detail").length;
  for (let n = 2; n < 5; n++) {
    emit("orchestration-changed", { runId: "r", revision: `epoch:${n}`, attemptId: "a-r", execution: { state: "executing" } });
    await tick();
    expect(view()).toMatchObject({ available: true, ready: true });
    expect(view().displaySnapshot.runs[0].status).toBe("running");
  }
  expect(reads()).toBe(1);
  // Anything that is not a worker's execution update can change the plan.
  emit("orchestration-changed", { runId: "r", revision: "epoch:5" });
  expect(view()).toMatchObject({ available: true, ready: false });
  await tick();
  expect(reads()).toBe(2);
  mock.reads.at(-1)!.reject(new Error("offline")); await tick();
  expect(view()).toMatchObject({ available: true, ready: false });
  release(); off();
});

it("a busy worker's execution events do not keep the first detail from being ready", async () => {
  const feed = createOrchestrationFeed(), off = feed.subscribe(() => {});
  mock.reads[0].resolve(summary()); await tick();
  const release = feed.detail("r");
  emit("orchestration-changed", { runId: "r", revision: "epoch:2", attemptId: "a-r", execution: { state: "executing" } });
  mock.reads[1].resolve({ ...summary(), summary: false }); await tick();
  expect(readDetail(feed.getState().snapshot!, feed.getState().details!, "r", feed.getState().detailPending)).toMatchObject({ available: true, ready: true });
  expect(mock.reads.filter(r => r.cmd === "orchestration_run_detail")).toHaveLength(1);
  release(); off();
});

it("never borrows another run's display snapshot", () => {
  expect(readDetail(summary("other"), new Map([["r", { ...summary(), summary: false }]]), "other"))
    .toMatchObject({ available: false, ready: false });
});

it("does not restore absent summary state at any nesting level", () => {
  const small = summary(); small.tasks[0].status = "ready";
  const full = structuredClone(small);
  Object.assign(full.tasks[0], { failure: { awaits: "person" }, heldByReopen: true, retrying: true, spec: "Brief", result: "Evidence" });
  Object.assign(full.attempts[0].execution!, { nextRetryAt: 100, latestError: { message: "old" }, lastProgress: "Evidence" });
  const shown = detailedRun(small, full, "r");
  expect(shown.tasks[0]).not.toHaveProperty("failure");
  expect(shown.tasks[0]).not.toHaveProperty("heldByReopen");
  expect(shown.tasks[0]).not.toHaveProperty("retrying");
  expect(shown.tasks[0]).toMatchObject({ spec: "Brief", result: "Evidence" });
  expect(shown.attempts[0].execution).not.toHaveProperty("nextRetryAt");
  expect(shown.attempts[0].execution).not.toHaveProperty("latestError");
});

it("retains invalidated detail for display while exact readiness waits for a matching refetch", async () => {
  const feed = createOrchestrationFeed(); const off = feed.subscribe(() => {});
  mock.reads[0].resolve(summary()); await tick();
  const release = feed.detail("r");
  mock.reads[1].resolve({ ...summary(), summary: false }); await tick();
  const change = () => emit("orchestration-changed", { runId: "r", revision: "epoch:2" });
  change(); expect(feed.getState().details?.has("r")).toBe(true);
  // The summary request has not answered yet. Equal old revisions still
  // cannot authorize a click after the invalidation announcement.
  expect(readDetail(feed.getState().snapshot!, feed.getState().details!, "r", feed.getState().detailPending).ready).toBe(false);
  await tick();
  const first = mock.reads.filter(r => r.cmd === "orchestration_run_detail").at(-1)!;
  change(); first.resolve({ ...summary(), summary: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(feed.getState().details?.has("r")).toBe(true);
  await tick();
  mock.reads.filter(r => r.cmd === "orchestration_run_detail").at(-1)!.reject(new Error("offline")); await tick();
  expect(feed.getState().detailErrors?.get("r")).toContain("offline");
  const changed = summary(); changed.runRevisions = { r: "epoch:2" };
  expect(readDetail(changed, feed.getState().details!)).toMatchObject({ available: true, ready: false });
  release(); off();
});
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
  mock.reads.at(-2)!.resolve({ ...detail, tasks: [] }); await tick();
  expect(feed.getState().details?.get("r")).toBe(detail);
  expect(retainedView(feed.getState())).toMatchObject({ available: true, ready: false });
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

it("ignores reports outside the loaded runs instead of accumulating install history", async () => {
  const feed=createOrchestrationFeed(),off=feed.subscribe(()=>{});mock.reads[0].resolve(summary());await tick();
  for(let i=0;i<363;i++)emit("chat-task",{chatId:`old-${i}`,report:{objective:"historical",nextStep:"",steps:[{title:"x".repeat(5000),state:"done"}],reportedAt:i}});
  expect(Object.keys(feed.getState().snapshot?.reports??{})).toHaveLength(0);off();
});

it("requests held chat candidates and removes them after their cards are answered",async()=>{
  const feed=createOrchestrationFeed(),off=feed.subscribe(()=>{});mock.reads[0].resolve(summary());await tick();
  feed.holdChats(["chat:w"]);expect(mock.reads.at(-1)?.args).toEqual({heldChatKeys:["chat:w"]});
  mock.reads.at(-1)!.resolve(summary("r","stopped"));await tick();
  feed.holdChats([]);mock.reads.at(-1)!.resolve({...EMPTY_ORCHESTRATION,summary:true});await tick();
  expect(feed.getState().snapshot?.runs).toEqual([]);off();
});


it("replaces a run's batches on a lane change and preserves other runs", () => {
  const batch = (id: string, runId: string) => ({ id, runId, agentId: "fe", repository: "/repo", baseBranch: "develop", branch: `feature/${id}`, worktree: "/w", taskIds: ["t"], status: "working" as const, createdAt: 1 });
  const before = { ...summary(), batches: [batch("old", "r"), batch("other", "u")] };
  const next = { ...summary(), batches: [batch("new", "r")] };
  expect(replaceRun(before, next, "r").batches?.map(b => b.id)).toEqual(["new", "other"]);
  expect(replaceRun(before, summary(), "r").batches?.map(b => b.id)).toEqual(["other"]);
  expect(detailedRun(next, before, "r").batches?.map(b => b.id)).toEqual(["new"]);
  expect(detailedRun(summary(), before, "r").batches).toBeUndefined();
});

it("Try again re-issues a detail read that never answers, and ignores the abandoned one", async () => {
  const feed = createOrchestrationFeed(), off = feed.subscribe(() => {});
  mock.reads[0].resolve(summary()); await tick();
  const release = feed.detail("r");
  const detailReads = () => mock.reads.filter(r => r.cmd === "orchestration_run_detail");
  expect(detailReads()).toHaveLength(1);
  // The first read hangs; asking again must not wait on it.
  void feed.refreshRun("r").catch(() => {});
  await tick();
  expect(detailReads()).toHaveLength(2);
  detailReads()[1].resolve({ ...summary(), summary: false }); await tick();
  expect(feed.getState().detailPending?.has("r")).toBe(false);
  // The abandoned request answering late (or failing) changes nothing.
  detailReads()[0].reject(new Error("late")); await tick();
  expect(feed.getState().detailErrors?.has("r")).toBe(false);
  expect(feed.getState().detailPending?.has("r")).toBe(false);
  release(); off();
});

it("keeps a retained plan readable and reports the error of a failed re-read", async () => {
  const feed = createOrchestrationFeed(), off = feed.subscribe(() => {});
  mock.reads[0].resolve(summary()); await tick();
  const release = feed.detail("r");
  mock.reads[1].resolve({ ...summary(), summary: false }); await tick();
  release();
  const again = feed.detail("r");
  mock.reads.at(-1)!.reject(new Error("offline")); await tick();
  expect(retainedView(feed.getState())).toMatchObject({ available: true, ready: false, error: expect.stringContaining("offline") });
  again(); off();
});

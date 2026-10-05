import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  reads: [] as Array<{ resolve: (value: unknown) => void; reject: (problem: unknown) => void; args?: Record<string, unknown> }>,
  bridge: { state: "open" as string, onState: null as null | ((state: string) => void) },
}));

vi.mock("./bridge", () => ({
  bridge: {
    get state() { return mock.bridge.state; },
    invoke: (_cmd: string, args?: Record<string, unknown>) =>
      new Promise((resolve, reject) => mock.reads.push({ resolve, reject, args })),
    on: (event: string, fn: (payload: unknown) => void) => {
      mock.handlers.set(event, fn);
      return () => mock.handlers.delete(event);
    },
    onState: (fn: (state: string) => void) => {
      mock.bridge.onState = fn;
      return () => { mock.bridge.onState = null; };
    },
  },
}));

import type { OrchestrationSnapshot } from "./orchestration";
import { createOrchestrationFeed, executionUpdate, NOTIFY_MS, READ_GAP_MS } from "./orchestrationFeed";

function ledger(state = "executing"): OrchestrationSnapshot {
  return {
    runs: [], tasks: [], gates: [], messages: [],
    attempts: [{ id: "a1", runId: "r1", taskId: "t1", workerChatKey: "chat:w1", execution: { state } }],
  } as unknown as OrchestrationSnapshot;
}

const emit = (event: string, payload: unknown) => mock.handlers.get(event)!(payload);
const execution = (attemptId: string, state: string) =>
  ({ runId: "r1", change: "worker_execution", attemptId, execution: { state } });
const stateOf = (feed: ReturnType<typeof createOrchestrationFeed>) =>
  feed.getState().snapshot?.attempts[0].execution?.state;

beforeEach(() => {
  vi.useFakeTimers();
  mock.handlers.clear();
  mock.reads.length = 0;
  mock.bridge.state = "open";
});
afterEach(() => vi.useRealTimers());

describe("orchestration feed", () => {
  it("reads the ledger once on a page load, when the socket opens", async () => {
    mock.bridge.state = "connecting";
    const feed = createOrchestrationFeed();
    const off = feed.subscribe(() => {});
    expect(mock.reads).toHaveLength(0);
    mock.bridge.state = "open";
    mock.bridge.onState!("open");
    expect(mock.reads).toHaveLength(1);
    expect(mock.reads[0].args).toEqual({ brief: true });
    mock.reads[0].resolve(ledger());
    await vi.advanceTimersByTimeAsync(READ_GAP_MS * 3);
    expect(mock.reads).toHaveLength(1);
    off();
  });

  it("fills in a finished run's text once the panel asks, until the run is active again", async () => {
    const brief = (status: string, result: string) => ({
      ...ledger(),
      runs: [{ id: "r1", status }],
      tasks: [{ id: "t1", runId: "r1", spec: "", result }],
      briefRuns: status === "completed" ? ["r1"] : [],
    }) as unknown as OrchestrationSnapshot;
    const task = (feed: ReturnType<typeof createOrchestrationFeed>) => feed.getState().snapshot?.tasks[0];
    const feed = createOrchestrationFeed();
    const off = feed.subscribe(() => {});
    mock.reads[0].resolve(brief("completed", ""));
    await vi.advanceTimersByTimeAsync(0);
    feed.detail("r1");
    feed.detail("r1");
    expect(mock.reads).toHaveLength(2);
    expect(mock.reads[1].args).toEqual({ runId: "r1" });
    mock.reads[1].resolve({ ...brief("completed", "shipped"), tasks: [{ id: "t1", runId: "r1", spec: "Do it", result: "shipped" }] });
    await vi.advanceTimersByTimeAsync(NOTIFY_MS);
    expect(task(feed)).toMatchObject({ spec: "Do it", result: "shipped" });

    // A later brief read keeps it filled in.
    void feed.refresh();
    mock.reads[2].resolve(brief("completed", ""));
    await vi.advanceTimersByTimeAsync(0);
    expect(task(feed)).toMatchObject({ spec: "Do it", result: "shipped" });

    // Reopened, then finished again: the old text is not put back.
    void feed.refresh();
    mock.reads[3].resolve({ ...brief("running", "new"), tasks: [{ id: "t1", runId: "r1", spec: "Again", result: null }] });
    await vi.advanceTimersByTimeAsync(0);
    void feed.refresh();
    mock.reads[4].resolve(brief("completed", ""));
    await vi.advanceTimersByTimeAsync(0);
    expect(task(feed)).toMatchObject({ spec: "", result: "" });
    feed.detail("r1");
    expect(mock.reads).toHaveLength(6);
    off();
  });

  it("refreshes decision viability after a native safety card closes", async () => {
    const feed = createOrchestrationFeed();
    const off = feed.subscribe(() => {});
    mock.reads[0].resolve(ledger());
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    emit("safety-block-expired", { id: "decision" });
    expect(mock.reads).toHaveLength(2);
    mock.reads[1].resolve(ledger());
    await vi.advanceTimersByTimeAsync(0);
    off();
  });
  it("only takes an execution the event actually carries", () => {
    expect(executionUpdate({ runId: "r1", change: "task_created" })).toBeNull();
    expect(executionUpdate({ runId: "r1", change: "worker_execution" })).toBeNull();
    expect(executionUpdate(execution("a1", "stalled"))).toEqual({ attemptId: "a1", execution: { state: "stalled" } });
  });

  it("folds a burst of changes into one follow-up read, after the gap", async () => {
    const feed = createOrchestrationFeed();
    const off = feed.subscribe(() => {});
    expect(mock.reads).toHaveLength(1);
    for (let i = 0; i < 5; i++) emit("orchestration-changed", { runId: "r1", change: "task_created" });
    expect(mock.reads).toHaveLength(1);
    mock.reads[0].resolve(ledger());
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    expect(mock.reads).toHaveLength(2);
    mock.reads[1].resolve(ledger());
    await vi.advanceTimersByTimeAsync(READ_GAP_MS * 3);
    expect(mock.reads).toHaveLength(2);
    off();
  });

  it("patches a worker's execution from the event instead of reading", async () => {
    const feed = createOrchestrationFeed();
    feed.subscribe(() => {});
    mock.reads[0].resolve(ledger());
    await vi.advanceTimersByTimeAsync(0);
    emit("orchestration-changed", execution("a1", "waiting_tool"));
    expect(stateOf(feed)).toBe("waiting_tool");
    await vi.advanceTimersByTimeAsync(READ_GAP_MS * 2);
    expect(mock.reads).toHaveLength(1);
    // An attempt this tab has not read yet needs the ledger.
    emit("orchestration-changed", execution("a2", "executing"));
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    expect(mock.reads).toHaveLength(2);
  });

  it("keeps a patch that arrived while an older read was out", async () => {
    const feed = createOrchestrationFeed();
    feed.subscribe(() => {});
    mock.reads[0].resolve(ledger());
    await vi.advanceTimersByTimeAsync(0);
    const refreshed = feed.refresh();
    expect(mock.reads).toHaveLength(2);
    emit("orchestration-changed", execution("a1", "stalled"));
    mock.reads[1].resolve(ledger("executing"));
    await refreshed;
    expect(stateOf(feed)).toBe("stalled");
  });

  it("waits for a read that began after the refresh was asked for", async () => {
    const feed = createOrchestrationFeed();
    feed.subscribe(() => {});
    let done = false;
    void feed.refresh().then(() => { done = true; });
    mock.reads[0].resolve(ledger());
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    expect(mock.reads).toHaveLength(2);
    mock.reads[1].resolve(ledger());
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it("applies a task report from the event without reading", async () => {
    const feed = createOrchestrationFeed();
    feed.subscribe(() => {});
    mock.reads[0].resolve(ledger());
    await vi.advanceTimersByTimeAsync(0);
    const report = { objective: "Ship", steps: [], reportedAt: 1 };
    emit("chat-task", { chatId: "w1", report });
    expect(feed.getState().snapshot?.reports?.["chat:w1"]).toEqual(report);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS * 2);
    expect(mock.reads).toHaveLength(1);
  });

  it("tells readers once per burst of patches", async () => {
    const feed = createOrchestrationFeed();
    const told = vi.fn();
    feed.subscribe(told);
    mock.reads[0].resolve(ledger());
    await vi.advanceTimersByTimeAsync(0);
    told.mockClear();
    for (const state of ["waiting_tool", "executing", "waiting_tool"]) emit("orchestration-changed", execution("a1", state));
    expect(told).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NOTIFY_MS);
    expect(told).toHaveBeenCalledTimes(1);
  });

  it("keeps the last ledger and reports the error when a read fails", async () => {
    const feed = createOrchestrationFeed();
    feed.subscribe(() => {});
    mock.reads[0].resolve(ledger());
    await vi.advanceTimersByTimeAsync(0);
    const refreshed = feed.refresh();
    mock.reads[1].reject(new Error("not available on this backend"));
    await expect(refreshed).rejects.toThrow("not available");
    expect(feed.getState().error).toBe("not available on this backend");
    expect(stateOf(feed)).toBe("executing");
  });
});

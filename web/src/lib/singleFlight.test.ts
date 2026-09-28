import { afterEach, describe, expect, it, vi } from "vitest";
import { singleFlight, withTrailingRun } from "./singleFlight";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Let every queued microtask and promise hop run. */
const settle = () => new Promise<void>((done) => setTimeout(done, 0));

describe("singleFlight", () => {
  it("folds every call made during a run into one rerun after it", async () => {
    const runs: ReturnType<typeof deferred>[] = [];
    const run = singleFlight(() => {
      const next = deferred();
      runs.push(next);
      return next.promise;
    });

    const first = run();
    await Promise.resolve();
    const burst = [run(), run(), run()];
    expect(runs).toHaveLength(1);

    runs[0].resolve();
    await first;
    await Promise.resolve();
    expect(runs).toHaveLength(2);

    runs[1].resolve();
    await Promise.all(burst);
    expect(runs).toHaveLength(2);
  });

  it("never overlaps a call made as a run ends with the rerun queued behind it", async () => {
    const runs: ReturnType<typeof deferred>[] = [];
    let active = 0;
    let peak = 0;
    const run = singleFlight(() => {
      active += 1;
      peak = Math.max(peak, active);
      const next = deferred();
      runs.push(next);
      return next.promise.finally(() => { active -= 1; });
    });

    const first = run();
    // Chained BEFORE the rerun is queued, so it runs first when the run ends.
    const chained = first.then(() => run());
    const queued = run();

    runs[0].resolve();
    await first;
    await settle();
    expect(peak).toBe(1);
    expect(runs).toHaveLength(2);

    runs[1].resolve();
    await queued;
    await settle();
    expect(runs).toHaveLength(3);
    runs[2].resolve();
    await chained;
    expect(peak).toBe(1);
  });

  it("starts afresh once idle, and a failed run does not jam it", async () => {
    let calls = 0;
    const run = singleFlight(async () => {
      calls += 1;
      if (calls === 1) throw new Error("git failed");
    });
    await run();
    await run();
    expect(calls).toBe(2);
  });
});

describe("withTrailingRun", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("runs on every trigger, and once more only after the burst goes quiet", () => {
    vi.useFakeTimers();
    let runs = 0;
    const { trigger } = withTrailingRun(() => { runs += 1; }, 5_000);

    for (let i = 0; i < 5; i += 1) {
      trigger();
      vi.advanceTimersByTime(1_000);
    }
    expect(runs).toBe(5);

    vi.advanceTimersByTime(3_999);
    expect(runs).toBe(5);
    vi.advanceTimersByTime(1);
    expect(runs).toBe(6);

    vi.advanceTimersByTime(60_000);
    expect(runs).toBe(6);
  });

  it("owes nothing once cancelled", () => {
    vi.useFakeTimers();
    let runs = 0;
    const { trigger, cancel } = withTrailingRun(() => { runs += 1; }, 5_000);
    trigger();
    cancel();
    vi.advanceTimersByTime(60_000);
    expect(runs).toBe(1);
  });
});

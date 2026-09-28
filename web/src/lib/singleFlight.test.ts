import { describe, expect, it } from "vitest";
import { singleFlight } from "./singleFlight";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

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

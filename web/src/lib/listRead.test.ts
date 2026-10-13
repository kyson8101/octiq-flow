import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETRY_MS, readTwice } from "./listRead";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A list whose asks answer as scripted, and what the page was told. */
function list(answers: ("taken" | "superseded" | "fail")[]) {
  let asks = 0;
  const told: boolean[] = [];
  const attempt = async () => {
    const answer = answers[asks++];
    if (answer === "fail" || answer === undefined) throw new Error("command failed");
    return answer === "taken";
  };
  return { attempt, told, settled: (answered: boolean) => { told.push(answered); }, get asks() { return asks; } };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("a list of what waits, asked for on a connection", () => {
  it("is asked once when it answers", async () => {
    const one = list(["taken"]);
    readTwice(one.attempt, one.settled);
    await settle();
    expect(one.told).toEqual([true]);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 10);
    expect(one.asks).toBe(1);
  });

  it("is asked once more after a failure, and not told failed before that", async () => {
    const one = list(["fail", "taken"]);
    readTwice(one.attempt, one.settled);
    await settle();
    // One failure is the host not saying. Nothing is settled yet.
    expect(one.told).toEqual([]);
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(one.asks).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(one.asks).toBe(2);
    expect(one.told).toEqual([true]);
  });

  it("is failed for good on the second failure, and never asked a third time", async () => {
    const one = list(["fail", "fail", "taken"]);
    readTwice(one.attempt, one.settled);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(one.told).toEqual([false]);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 100);
    expect(one.asks).toBe(2);
    expect(one.told).toEqual([false]);
  });

  it("says nothing for an answer a newer ask took the place of", async () => {
    const one = list(["superseded"]);
    readTwice(one.attempt, one.settled);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(one.told).toEqual([]);
    expect(one.asks).toBe(1);
  });

  it("asks nothing and tells nothing once it is called off", async () => {
    const failed = list(["fail", "taken"]);
    const stop = readTwice(failed.attempt, failed.settled);
    await settle();
    stop();
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(failed.asks).toBe(1);
    expect(failed.told).toEqual([]);
    // Called off while the first ask is still out: its answer is not told.
    const out = list(["taken"]);
    readTwice(out.attempt, out.settled)();
    await settle();
    expect(out.told).toEqual([]);
  });

  it("never settles a list that neither answers nor fails", async () => {
    const told: boolean[] = [];
    readTwice(() => new Promise<boolean>(() => {}), (answered) => { told.push(answered); });
    await vi.advanceTimersByTimeAsync(RETRY_MS * 1000);
    // That wait is `pendingActions.SILENT_MS`'s to bound, not this module's.
    expect(told).toEqual([]);
  });
});

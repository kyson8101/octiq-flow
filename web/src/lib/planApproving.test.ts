import { describe, expect, it } from "vitest";
import { approveOnce, isApproving } from "./planApproving";

describe("one approval in flight per plan", () => {
  it("a second click, from either card, sends nothing while the first is on its way", async () => {
    let calls = 0;
    let finish!: () => void;
    const slow = () => { calls += 1; return new Promise<void>((resolve) => { finish = resolve; }); };
    const first = approveOnce("run_1", slow);
    expect(isApproving("run_1")).toBe(true);
    expect(await approveOnce("run_1", slow)).toBe(false);
    // Another plan is not held up.
    expect(await approveOnce("run_2", async () => {})).toBe(true);
    finish();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
    expect(isApproving("run_1")).toBe(false);
  });

  it("stays approving until the ledger read after the decision lands", async () => {
    let landed!: () => void;
    const read = () => new Promise<void>((resolve) => { landed = resolve; });
    const first = approveOnce("run_4", async () => {}, read);
    await Promise.resolve();
    await Promise.resolve();
    // The host has answered, but the card still draws the old ledger.
    expect(isApproving("run_4")).toBe(true);
    expect(await approveOnce("run_4", async () => {})).toBe(false);
    landed();
    expect(await first).toBe(true);
    expect(isApproving("run_4")).toBe(false);
  });

  it("a read that fails still lets the plan go", async () => {
    expect(await approveOnce("run_5", async () => {}, async () => { throw new Error("offline"); })).toBe(true);
    expect(isApproving("run_5")).toBe(false);
  });

  it("a refused approval frees the plan for another try", async () => {
    await expect(approveOnce("run_3", async () => { throw new Error("The plan changed"); })).rejects.toThrow("changed");
    expect(isApproving("run_3")).toBe(false);
  });
});

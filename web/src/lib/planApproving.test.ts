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

  it("a refused approval frees the plan for another try", async () => {
    await expect(approveOnce("run_3", async () => { throw new Error("The plan changed"); })).rejects.toThrow("changed");
    expect(isApproving("run_3")).toBe(false);
  });
});

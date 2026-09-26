import { describe, expect, it } from "vitest";
import { cardView, nextShown, PLAN_SETTLE_MS, settling } from "./planShown";

describe("planShown (feedback 713786e9)", () => {
  it("does not hold a card that opened on its revision", () => {
    const opened = nextShown(null, 5, 1_000);
    expect(settling(opened, 1_010)).toBe(false);
    expect(cardView(opened, 1_300)).toEqual({ shownMs: 300, updatedMs: null });
  });

  it("holds Approve right after the plan changes under the reader, then lets go", () => {
    const opened = nextShown(null, 5, 1_000);
    expect(nextShown(opened, 5, 9_000)).toBe(opened);
    const changed = nextShown(opened, 6, 10_000);
    expect(settling(changed, 10_000 + PLAN_SETTLE_MS - 1)).toBe(true);
    expect(settling(changed, 10_000 + PLAN_SETTLE_MS)).toBe(false);
    expect(cardView(changed, 12_000)).toEqual({ shownMs: 2_000, updatedMs: 2_000 });
  });

  it("does not call a revision filling in on an older snapshot a change", () => {
    const opened = nextShown(null, undefined, 1_000);
    expect(nextShown(opened, 3, 1_100).replacedAt).toBeNull();
  });
});

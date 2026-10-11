import { describe, expect, it } from "vitest";
import { ROW_MOVE_EASE, ROW_MOVE_MS, rowMoves } from "./rowMotion";

const at = (rows: Record<string, number>) => new Map(Object.entries(rows));

describe("rows that changed place", () => {
  it("start from where they were: the one that went up, and each one it passed", () => {
    // "b" answered and went from fourth to first; the three above drop a row.
    const before = at({ a: 300, c: 380, d: 460, b: 540 });
    const after = at({ b: 300, a: 380, c: 460, d: 540 });
    expect([...rowMoves(before, after)]).toEqual([["b", 240], ["a", -80], ["c", -80], ["d", -80]]);
  });

  it("leave a row that did not move alone, layout noise included", () => {
    const before = at({ a: 300, b: 380.4 });
    const after = at({ a: 300, b: 380 });
    expect(rowMoves(before, after).size).toBe(0);
  });

  it("leave a row that was not there before to its own entry", () => {
    const before = at({ a: 300 });
    const after = at({ fresh: 300, a: 380 });
    // The new row pushes the others with its own reveal; only "a" moved here.
    expect([...rowMoves(before, after)]).toEqual([["a", -80]]);
  });

  it("say nothing of a row that left", () => {
    expect(rowMoves(at({ a: 300, gone: 380 }), at({ a: 300 })).size).toBe(0);
  });

  it("move inside the app's range, easing out", () => {
    expect(ROW_MOVE_MS).toBeGreaterThanOrEqual(130);
    expect(ROW_MOVE_MS).toBeLessThanOrEqual(220);
    // Both control points inside 0..1 on the y axis: it never overshoots.
    const [, y1, , y2] = /cubic-bezier\(([^)]+)\)/.exec(ROW_MOVE_EASE)![1].split(",").map(Number);
    for (const y of [y1, y2]) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });
});

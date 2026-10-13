import { describe, expect, it } from "vitest";
import { cutEdges, overflowing, type Sized } from "./actionBar";

const GAP = 2;
const MORE = 68;
const item = (id: string, keep: number, width = 80): Sized => ({ id, keep, width });
/** The room `items` take in a row, with More after them when `more`. */
const room = (items: Sized[], more = false) =>
  items.reduce((sum, each) => sum + each.width, 0) + GAP * Math.max(0, items.length - 1) + (more ? GAP + MORE : 0);

describe("which actions go behind More", () => {
  const bar = [item("tasks", 100), item("preview", 90), item("git", 85), item("copy", 20), item("delete", 10)];

  it("puts nothing away while everything fits, to the pixel", () => {
    expect(overflowing(bar, room(bar), GAP, MORE)).toEqual([]);
    expect(overflowing(bar, 5000, GAP, MORE)).toEqual([]);
  });

  it("puts the lowest priority away first, and only as many as it must", () => {
    // One pixel short: More needs a place too, so one button is not enough.
    expect(overflowing(bar, room(bar) - 1, GAP, MORE)).toEqual(["delete"]);
    expect(overflowing(bar, room(bar.slice(0, 3), true), GAP, MORE)).toEqual(["copy", "delete"]);
    expect(overflowing(bar, room(bar.slice(0, 3), true) - 1, GAP, MORE)).toEqual(["git", "copy", "delete"]);
  });

  it("answers in the bar's order whatever order they left in", () => {
    const mixed = [item("a", 10), item("b", 90), item("c", 5), item("d", 80)];
    expect(overflowing(mixed, room([mixed[1], mixed[3]], true), GAP, MORE)).toEqual(["a", "c"]);
  });

  it("takes the later of two equals first", () => {
    const equal = [item("first", 50), item("second", 50), item("third", 50)];
    expect(overflowing(equal, room(equal.slice(0, 2), true), GAP, MORE)).toEqual(["third"]);
  });

  it("never puts away a button that draws nothing, and gives it no room or gap", () => {
    const withEmpty = [item("tasks", 100), item("agents", 60, 0), item("pinned", 60, 0), item("delete", 10)];
    expect(overflowing(withEmpty, room([withEmpty[0], withEmpty[3]]), GAP, MORE)).toEqual([]);
    expect(overflowing(withEmpty, room([withEmpty[0], withEmpty[3]]) - 1, GAP, MORE)).toEqual(["delete"]);
  });

  it("puts everything behind More when even the last button has no room beside it", () => {
    expect(overflowing(bar, 60, GAP, MORE)).toEqual(bar.map((each) => each.id));
    expect(overflowing([], 0, GAP, MORE)).toEqual([]);
  });

  it("is steady: what it leaves in the row fits beside More, so the next measure agrees", () => {
    for (let width = 0; width <= room(bar) + 4; width += 1) {
      const gone = overflowing(bar, width, GAP, MORE);
      const kept = bar.filter((each) => !gone.includes(each.id));
      if (gone.length && kept.length) expect(room(kept, true)).toBeLessThanOrEqual(width);
      // Measured again with the same widths, the answer is the same.
      expect(overflowing(bar, width, GAP, MORE)).toEqual(gone);
    }
  });

  it("goes by the widths it is given: a wider font puts more away at the same window", () => {
    const wide = bar.map((each) => ({ ...each, width: each.width * 1.3 }));
    const window = room(bar);
    expect(overflowing(bar, window, GAP, MORE)).toEqual([]);
    expect(overflowing(wide, window, GAP, MORE).length).toBeGreaterThan(0);
  });
});

describe("which edge of a phone's row is cut", () => {
  it("is cut at neither end when everything is in view", () => {
    expect(cutEdges(0, 390, 390)).toBe("");
    expect(cutEdges(0, 390.6, 390)).toBe("");
  });

  it("is cut at the end before any scroll, at both ends midway, at the start when at the end", () => {
    expect(cutEdges(0, 800, 390)).toBe("end");
    expect(cutEdges(120, 800, 390)).toBe("start end");
    expect(cutEdges(410, 800, 390)).toBe("start");
    // A scaled display stops a fraction short of the end.
    expect(cutEdges(409.4, 800, 390)).toBe("start");
  });

  it("reads a right-to-left scroller, whose position counts down from zero", () => {
    expect(cutEdges(-120, 800, 390)).toBe("start end");
  });
});

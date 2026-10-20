import { describe, expect, it } from "vitest";
import { CELL, NavGrid, type Point, type Solid } from "./nav";

const length = (from: Point, way: Point[]) => {
  let total = 0;
  let at = from;
  for (const p of way) {
    total += Math.hypot(p.x - at.x, p.z - at.z);
    at = p;
  }
  return total;
};

/** A 4 × 4 room of thin walls round (0, 0), and its front wall open in the
 *  middle when `door` is wider than nothing. */
function room(door: number): Solid[] {
  const t = 0.07;
  const half = (4 - door) / 4;
  const walls: Solid[] = [
    { cx: 0, cz: -2, hx: 2, hz: t, yaw: 0 },
    { cx: -2, cz: 0, hx: t, hz: 2, yaw: 0 },
    { cx: 2, cz: 0, hx: t, hz: 2, yaw: 0 },
  ];
  if (door > 0) {
    walls.push({ cx: -(door / 2 + half), cz: 2, hx: half, hz: t, yaw: 0 });
    walls.push({ cx: door / 2 + half, cz: 2, hx: half, hz: t, yaw: 0 });
  } else {
    walls.push({ cx: 0, cz: 2, hx: 2, hz: t, yaw: 0 });
  }
  return walls;
}

describe("walking the island", () => {
  it("goes straight across open ground", () => {
    const grid = new NavGrid(20);
    const from = { x: -5, z: 0 };
    const to = { x: 5, z: 0 };
    const way = grid.path(from, to)!;
    expect(way.at(-1)).toEqual(to);
    expect(length(from, way)).toBeCloseTo(10, 0);
  });

  it("goes round a wall, never through it", () => {
    const wall: Solid = { cx: 0, cz: 0, hx: 0.05, hz: 3, yaw: 0 };
    const grid = new NavGrid(20, [wall]);
    const from = { x: -3, z: 0 };
    const to = { x: 3, z: 0 };
    const way = grid.path(from, to)!;
    expect(way).not.toBeNull();
    expect(length(from, way)).toBeGreaterThan(6.5);
    let at = from;
    for (const p of way) {
      expect(grid.clear(at, p)).toBe(true);
      at = p;
    }
  });

  it("comes into a roofless room through its doorway, and not at all into one with none", () => {
    const outside = { x: 0, z: 6 };
    const inside = { x: 0, z: -1 };
    const open = new NavGrid(20, room(1.0));
    const way = open.path(outside, inside)!;
    expect(way).not.toBeNull();
    // Through the gap in the front wall.
    const crossing = [outside, ...way].find((p, i, all) => i > 0 && all[i - 1].z > 2 && p.z <= 2) ?? way[0];
    expect(Math.abs(crossing.x)).toBeLessThan(1.5);
    const shut = new NavGrid(20, room(0));
    expect(shut.path(outside, inside)).toBeNull();
  });

  it("keeps a wall thinner than a cell solid, even on the slant", () => {
    const wall: Solid = { cx: 0, cz: 0, hx: 3, hz: 0.04, yaw: Math.PI / 5 };
    const grid = new NavGrid(20, [wall]);
    expect(grid.clear({ x: -1, z: 2 }, { x: 1, z: -2 })).toBe(false);
  });

  it("finds the nearest free spot to a blocked one", () => {
    const grid = new NavGrid(20, [{ cx: 0, cz: 0, hx: 1, hz: 1, yaw: 0 }]);
    expect(grid.isFree({ x: 0, z: 0 })).toBe(false);
    const near = grid.nearestFree({ x: 0, z: 0 })!;
    expect(grid.isFree(near)).toBe(true);
    expect(Math.hypot(near.x, near.z)).toBeLessThan(2.2);
  });

  it("walks on the dock over the water, and nowhere else past the shore", () => {
    const dock: Solid = { cx: 0, cz: 24, hx: 0.9, hz: 6, yaw: 0 };
    const grid = new NavGrid(20, [], 1.5, [dock]);
    expect(grid.isFree({ x: 5, z: 24 })).toBe(false);
    expect(grid.isFree({ x: 0, z: 26 })).toBe(true);
    const way = grid.path({ x: 0, z: 10 }, { x: 0, z: 28 });
    expect(way).not.toBeNull();
  });

  it("cuts cells small enough for a 1 m doorway", () => {
    expect(CELL).toBeLessThanOrEqual(0.4);
  });
});

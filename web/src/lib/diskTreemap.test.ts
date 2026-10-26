import { describe, expect, it } from "vitest";
import { diskTreemap } from "./diskTreemap";

describe("diskTreemap", () => {
  it("handles zero and one item", () => {
    expect(diskTreemap([], 400, 300)).toEqual([]);
    expect(diskTreemap([{ id: "zero", bytes: 0 }, { id: "bad", bytes: NaN }], 400, 300)).toEqual([]);
    expect(diskTreemap([{ id: "one", bytes: 12 }], 400, 300)).toEqual([{ id: "one", x: 0, y: 0, width: 400, height: 300 }]);
    expect(diskTreemap([{ id: "one", bytes: 12 }], 0, 300)).toEqual([]);
  });
  it.each([[700, 400], [300, 900], [100, 100]])("fills %s × %s with proportional, non-overlapping areas", (width, height) => {
    const items = [90, 75, 50, 30, 10, 5, 1].map((bytes, id) => ({ id: String(id), bytes }));
    const tiles = diskTreemap(items, width, height), total = items.reduce((n, item) => n + item.bytes, 0);
    tiles.forEach((tile, index) => {
      expect(tile.width * tile.height / (width * height)).toBeCloseTo(items[index].bytes / total, 9);
      expect(tile.x).toBeGreaterThanOrEqual(0); expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.x + tile.width).toBeLessThanOrEqual(width + 1e-8);
      expect(tile.y + tile.height).toBeLessThanOrEqual(height + 1e-8);
      tiles.slice(index + 1).forEach(other => {
        const overlapWidth = Math.max(0, Math.min(tile.x + tile.width, other.x + other.width) - Math.max(tile.x, other.x));
        const overlapHeight = Math.max(0, Math.min(tile.y + tile.height, other.y + other.height) - Math.max(tile.y, other.y));
        expect(overlapWidth * overlapHeight).toBeLessThan(1e-7);
      });
    });
    expect(tiles.reduce((n, tile) => n + tile.width * tile.height, 0)).toBeCloseTo(width * height, 7);
  });
  it("preserves input order and leaves the caller untouched", () => {
    const items = Object.freeze([Object.freeze({ id: "small", bytes: 1 }), Object.freeze({ id: "large", bytes: 9 }), Object.freeze({ id: "equal", bytes: 9 })]);
    const tiles = diskTreemap(items, 600, 400);
    expect(tiles.map(tile => tile.id)).toEqual(["small", "large", "equal"]);
    expect(diskTreemap(items, 600, 400)).toEqual(tiles);
  });
});

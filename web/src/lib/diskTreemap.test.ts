import { describe, expect, it } from "vitest";
import { aggregateDiskMap, diskLabelFit, diskTreemap } from "./diskTreemap";
import { crowdedDiskReport } from "./diskReport.fixture";

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


describe("disk map overview", () => {
  it("folds 150 rows by group/kind, then the long tail, conserving bytes and IDs", () => {
    const report = crowdedDiskReport(), original = JSON.stringify(report);
    const tiles = aggregateDiskMap(report.items, new Set(["worktree-3", "archive-4", "export-0", "missing"]));
    expect(tiles).toHaveLength(8);
    const worktrees = tiles.find(tile => tile.label === "Linked Git worktrees")!;
    expect(worktrees.items).toHaveLength(70);
    expect(worktrees.selectedCount).toBe(1);
    const other = tiles.find(tile => tile.label === "Other")!;
    expect(other.group).toBe("review"); expect(other.items).toHaveLength(17); expect(other.selectedCount).toBe(1);
    expect(tiles.find(tile => tile.group === "work")!.selectedCount).toBe(0);
    expect(tiles.reduce((sum, tile) => sum + tile.bytes, 0)).toBe(report.totalBytes);
    expect(tiles.flatMap(tile => tile.items.map(item => item.id)).sort()).toEqual(report.items.map(item => item.id).sort());
    expect(JSON.stringify(report)).toBe(original);
  });
  it("keeps selection-independent geometry and does not mix groups or unknown kinds", () => {
    const report = crowdedDiskReport();
    const items = [report.items[0], { ...report.items[1], group: "clean" as const }, { ...report.items[2], kind: "unknown-kind", bytes: 2e9 }];
    const before = aggregateDiskMap(items, new Set());
    const after = aggregateDiskMap(items, new Set(items.map(item => item.id)));
    expect(before.map(({ selectedCount: _, ...tile }) => tile)).toEqual(after.map(({ selectedCount: _, ...tile }) => tile));
    expect(before).toHaveLength(3);
    expect(before.every(tile => tile.items.every(item => item.group === tile.group))).toBe(true);
    expect(before.find(tile => tile.items[0].kind === "unknown-kind")?.label).toBe(items[2].label);
    expect(aggregateDiskMap([], new Set())).toEqual([]);
    expect(aggregateDiskMap([{ ...items[0], bytes: 0 }, { ...items[1], bytes: NaN }], new Set())).toEqual([]);
  });
  it("keeps the exact threshold visible and folds repeated kinds before applying it", () => {
    const base = crowdedDiskReport().items[0];
    const items = [9700, 150, 75, 75].map((bytes, i) => ({ ...base, id: String(i), bytes, kind: ["big", "edge", "paired", "paired"][i] }));
    const tiles = aggregateDiskMap(items, new Set(["2"]));
    expect(tiles.map(tile => tile.label)).not.toContain("Other");
    expect(tiles.find(tile => tile.items.length === 2)?.selectedCount).toBe(1);
  });
});

describe("disk tile label fit from actual DOM extents", () => {
  const label = { width: 90, height: 20 }, size = { width: 60, height: 18 };
  it("requires two whole line boxes and their gap for a label", () => {
    expect(diskLabelFit({ width: 90, height: 44 }, label, size, 6)).toBe("full");
    expect(diskLabelFit({ width: 90, height: 43.9 }, label, size, 6)).toBe("size");
    expect(diskLabelFit({ width: 89.9, height: 100 }, label, size, 6)).toBe("size");
  });
  it("hides even the size if either dimension cannot contain it", () => {
    expect(diskLabelFit({ width: 60, height: 18 }, label, size, 6)).toBe("size");
    expect(diskLabelFit({ width: 59.9, height: 100 }, label, size, 6)).toBe("none");
    expect(diskLabelFit({ width: 200, height: 17.9 }, label, size, 6)).toBe("none");
    expect(diskLabelFit({ width: 0, height: 0 }, label, size, 6)).toBe("none");
  });
  it("uses measured font changes and ticked count widths, without assumed glyph sizes", () => {
    expect(diskLabelFit({ width: 150, height: 44 }, label, { width: 170, height: 18 }, 6)).toBe("none");
    expect(diskLabelFit({ width: 150, height: 44 }, { width: 90, height: 28 }, size, 6)).toBe("size");
  });
});

import { describe, expect, it } from "vitest";
import { aggregateDiskMap, diskTreemap, layoutDiskMap } from "./diskTreemap";
import { crowdedDiskReport, realShapedDiskReport } from "./diskReport.fixture";

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

describe("readable pixel layout", () => {
  const floor = () => ({ width: 140, height: 70 });
  const entries = (weights: number[]) => aggregateDiskMap(weights.map((bytes, i) => ({ ...crowdedDiskReport().items[0], id: String(i), label: `Category ${i}`, kind: String(i), bytes })), new Set(["2"]), 0);
  it("requires both dimensions at the exact pixel floor, including padding", () => {
    const original = entries([1]);
    expect(layoutDiskMap(original, 140, 70, floor).regions).toHaveLength(1);
    for (const [width, height] of [[139.9, 70], [140, 69.9], [0, 70]]) {
      const result = layoutDiskMap(original, width, height, floor);
      expect(result.regions).toEqual([]);
      expect(result.summaries[0].bytes).toBe(1);
    }
  });
  it("folds unreadable siblings and re-lays out until the pixel floor is met", () => {
    const original = entries([50, 50 / 3, 50 / 3, 50 / 3]);
    const result = layoutDiskMap(original, 300, 300, () => ({ width: 140, height: 110 }));
    const visible = result.regions.flatMap(region => region.tiles);
    expect(visible.map(entry => entry.label)).toEqual(["Category 0", "Other"]);
    expect(visible.find(entry => entry.label === "Other")?.items.map(item => item.id).sort()).toEqual(["1", "2", "3"]);
    expect(visible.find(entry => entry.label === "Other")?.selectedCount).toBe(1);
    expect(layoutDiskMap(original, 300, 300, () => ({ width: 140, height: 110 }))).toEqual(result);
    visible.forEach(tile => { expect(tile.width).toBeGreaterThanOrEqual(140); expect(tile.height).toBeGreaterThanOrEqual(70); });
  });
  it("summarizes an unreadable Other without a blank tile, keeping large categories", () => {
    const result = layoutDiskMap(entries([99, 0.5, 0.5]), 300, 200, floor);
    expect(result.regions[0].tiles).toHaveLength(1);
    expect(result.regions[0].tiles[0].label).toBe("Category 0");
    expect(result.regions[0].tiles[0].width).toBe(300);
    expect(result.summaries[0].label).toBe("Other");
    expect(result.summaries[0].items.map(item => item.id)).toEqual(["1", "2"]);
    expect(result.summaries[0].selectedCount).toBe(1);
  });
  it("uses one region tile when individual category labels cannot fit", () => {
    const result = layoutDiskMap(entries([1, 1]), 150, 80, floor);
    expect(result.summaries).toEqual([]);
    expect(result.regions[0].tiles).toHaveLength(1);
    expect(result.regions[0].tiles[0].label).toBe("Review first");
    expect(result.regions[0].tiles[0].items).toHaveLength(2);
  });
  it("moves a whole tiny group to a focusable summary and gives its area back", () => {
    const original = entries([999, 1]);
    original[1] = { ...original[1], group: "clean", items: original[1].items.map(item => ({ ...item, group: "clean" })) };
    const result = layoutDiskMap(original, 300, 200, floor);
    expect(result.summaries[0].label).toBe("Safe to clean");
    expect(result.summaries[0].items[0].id).toBe("1");
    expect(result.regions[0].box.width * result.regions[0].box.height).toBe(300 * 200);
    expect(layoutDiskMap(original, 20, 20, floor).regions).toEqual([]);
  });
  it.each([crowdedDiskReport, realShapedDiskReport])("preserves all sums, counts, IDs and selection at both map widths", fixture => {
    const report = fixture(), before = JSON.stringify(report);
    for (const width of [300, 430]) {
      const original = aggregateDiskMap(report.items, new Set(report.items.map(item => item.id)));
      const result = layoutDiskMap(original, width, 340, floor);
      const visible = result.regions.flatMap(region => region.tiles);
      const all = [...visible, ...result.summaries];
      expect(all.reduce((sum, tile) => sum + tile.bytes, 0)).toBe(report.totalBytes);
      expect(all.reduce((sum, tile) => sum + tile.selectedCount, 0)).toBe(original.reduce((sum, tile) => sum + tile.selectedCount, 0));
      expect(all.flatMap(tile => tile.items.map(item => item.id)).sort()).toEqual(report.items.map(item => item.id).sort());
      visible.forEach(tile => { expect(tile.width).toBeGreaterThanOrEqual(140); expect(tile.height).toBeGreaterThanOrEqual(70); });
      const unselected = layoutDiskMap(aggregateDiskMap(report.items, new Set()), width, 340, floor);
      expect(visible.map(({ selectedCount: _, ...tile }) => tile)).toEqual(unselected.regions.flatMap(region => region.tiles).map(({ selectedCount: _, ...tile }) => tile));
    }
    expect(JSON.stringify(report)).toBe(before);
  });
});

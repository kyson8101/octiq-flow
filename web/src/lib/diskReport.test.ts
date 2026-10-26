import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/disk-report.json";
import { diskBytes, diskDate, diskSection, diskSelection, readDiskReport, readDiskState, toggleDiskSection } from "./diskReport";

const report = readDiskReport(fixture)!;
describe("disk report selection", () => {
  it("starts empty and excludes work and stale ids even if requested", () => {
    expect(diskSelection(report.items, new Set(), false)).toEqual({ ids: [], count: 0, bytes: 0, skippedCount: 0 });
    expect(diskSelection(report.items, new Set(["work", "obsolete", "pnpm", "recent", "in-use"]), false)).toEqual({ ids: ["pnpm"], count: 1, bytes: 2400000000, skippedCount: 0 });
  });
  it("ticks and unticks one whole section without affecting another", () => {
    const clean = diskSection(report.items, "clean"), before = new Set(["docker", "pnpm"]);
    const all = toggleDiskSection(before, clean);
    expect([...all]).toEqual(["docker", "pnpm", "temp"]);
    expect([...toggleDiskSection(all, clean)]).toEqual(["docker"]);
    expect([...before]).toEqual(["docker", "pnpm"]);
    expect([...toggleDiskSection(before, diskSection(report.items, "work"))]).toEqual([...before]);
  });
  it("never ticks null-action rows or includes them in the script", () => {
    const review = diskSection(report.items, "review");
    const selected = toggleDiskSection(new Set(), review);
    expect([...selected]).toEqual(["docker", "worktree", "unknown"]);
    expect(diskSelection(report.items, new Set(["recent", "in-use"]), true).count).toBe(0);
  });
  it("counts all selected sizes and explains rm entries skipped by default", () => {
    const ids = new Set(["pnpm", "temp", "unknown", "worktree"]);
    expect(diskSelection(report.items, ids, false)).toMatchObject({ count: 4, bytes: 5700000000, skippedCount: 2 });
    expect(diskSelection(report.items, ids, true).skippedCount).toBe(0);
  });
  it("sorts sections by size without changing the report", () => {
    expect(diskSection(report.items, "review").map(item => item.id)).toEqual(["docker", "worktree", "unknown", "recent", "in-use"]);
    expect(report.items.map(item => item.id)).toEqual(fixture.items.map(item => item.id));
  });
});
describe("tolerant host reader", () => {
  it("accepts absent and partial values safely", () => {
    expect(readDiskState(null)).toEqual({ report: null, running: null });
    expect(readDiskReport({ scanId: "old" })).toMatchObject({ scanId: "old", items: [], skipped: [], previousScanAt: null, platform: "unknown" });
    const partial = readDiskReport({ scanId: "old", items: [{ id: "x", bytes: "huge", group: "new-group", worktree: { clean: "yes" } }, { id: "x" }, null], skipped: [null] })!;
    expect(partial.items).toHaveLength(1);
    expect(partial.items[0]).toMatchObject({ group: "work", bytes: 0, worktree: { clean: undefined } });
    expect(diskSelection(partial.items, new Set(["x"]), true).count).toBe(0);
  });
  it("uses decimal MB, and reads seconds or milliseconds dates", () => {
    expect(diskBytes(100000000)).toBe("100 MB");
    expect(diskBytes(1500000000)).toBe("1.5 GB");
    expect(diskDate(1792972800)).toBe(diskDate(1792972800000));
  });
});

import type { DiskGroup, DiskItem, DiskReport } from "./diskReport";

/** Synthetic home-folder distribution; no real paths or host scan required. */
export function crowdedDiskReport(): DiskReport {
  const item = (id: string, group: DiskGroup, kind: string, label: string, gb: number): DiskItem => ({
    id, key: id, group, kind, label, path: `/Users/demo/${group}/${id}`, bytes: Math.round(gb * 1e9),
    effect: group === "work" ? "Your work. Label only." : "Fixture cleanup candidate.",
    notRecommended: false, action: group === "work" ? null : { type: "rm", path: `/Users/demo/${group}/${id}` },
    previousBytes: null, grew: false,
  });
  const items = [
    ...Array.from({ length: 70 }, (_, i) => item(`worktree-${i}`, "review", "git-worktree", "Linked Git worktree", i % 14 === 0 ? 11 : 0.27 + (i % 9) * 0.09)),
    ...Array.from({ length: 38 }, (_, i) => item(`export-${i}`, "work", "media-export", "Media exports", 1.2 + (i % 8) * 0.6)),
    ...Array.from({ length: 25 }, (_, i) => item(`cache-${i}`, "clean", `cache-${i % 5}`, ["Package caches", "Build caches", "Browser caches", "Tool caches", "Download caches"][i % 5], 0.1 + (i % 5) * 0.25)),
    ...Array.from({ length: 17 }, (_, i) => item(`archive-${i}`, "review", `archive-${i}`, `Local archive ${i}`, 0.1 + (i % 3) * 0.03)),
  ];
  return { scanId: "crowded-fixture", scannedAt: 1792972800000, platform: "macos", home: "/Users/demo", thresholdBytes: 1e8,
    totalBytes: items.reduce((sum, item) => sum + item.bytes, 0), items, skipped: [], previousScanAt: null };
}

export type DiskGroup = "clean" | "review" | "work";
export type DiskAction = { type: "tool" | "docker"; command: string } | { type: "worktree"; repo: string; path: string } | { type: "rm"; path: string } | { type: "rmOlderThan"; path: string; days: number; exclude: string[] };
export type DiskWorktree = { repo?: string; branch?: string; clean?: boolean; merged?: boolean; mainline?: boolean; idleDays?: number; inUse?: boolean; eligible?: boolean; ignoredBytes?: number };
export type DiskItem = {
  id: string; key: string; group: DiskGroup; kind: string; label: string; path: string; bytes: number;
  modifiedAt?: number; effect: string; note?: string; notRecommended: boolean; action: DiskAction | null;
  previousBytes: number | null; grew: boolean; worktree?: DiskWorktree;
};
export type DiskReport = {
  scanId: string; scannedAt: number; platform: "macos" | "windows" | "linux" | "unknown"; home: string;
  thresholdBytes: number; totalBytes: number; items: DiskItem[]; skipped: { path: string; reason: string }[]; previousScanAt: number | null;
};
export type DiskProgress = { scanId: string; startedAt?: number; phase: string; entries: number; bytes: number; path?: string };
export type DiskState = { running: DiskProgress | null; report: DiskReport | null };

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const str = (v: unknown, fallback = "") => typeof v === "string" ? v : fallback;
export const diskNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const nullableNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** Read old/partial host payloads defensively. Unknown groups are work,
 * so an unfamiliar classification never becomes a cleanup selection. */
export function readDiskReport(value: unknown): DiskReport | null {
  const r = record(value);
  if (!str(r.scanId)) return null;
  const ids = new Set<string>();
  const items = (Array.isArray(r.items) ? r.items : []).flatMap(value => {
    const item = record(value), id = str(item.id);
    if (!id || ids.has(id)) return [];
    ids.add(id);
    const wt = item.worktree ? record(item.worktree) : null;
    return [{
      id, key: str(item.key, id), group: item.group === "clean" || item.group === "review" ? item.group : "work",
      kind: str(item.kind), label: str(item.label, str(item.kind, "Folder")), path: str(item.path), bytes: diskNumber(item.bytes),
      effect: str(item.effect), note: str(item.note), notRecommended: item.notRecommended === true,
      action: ["tool", "docker", "worktree", "rm", "rmOlderThan"].includes(str(record(item.action).type)) ? item.action as DiskAction : null,
      previousBytes: nullableNumber(item.previousBytes), grew: item.grew === true,
      worktree: wt ? { repo: str(wt.repo), branch: str(wt.branch), clean: typeof wt.clean === "boolean" ? wt.clean : undefined,
        merged: typeof wt.merged === "boolean" ? wt.merged : undefined, mainline: typeof wt.mainline === "boolean" ? wt.mainline : undefined,
        inUse: typeof wt.inUse === "boolean" ? wt.inUse : undefined, eligible: typeof wt.eligible === "boolean" ? wt.eligible : undefined,
        idleDays: nullableNumber(wt.idleDays) ?? undefined, ignoredBytes: diskNumber(wt.ignoredBytes) } : undefined,
    } satisfies DiskItem];
  });
  return { scanId: str(r.scanId), scannedAt: diskNumber(r.scannedAt), platform: r.platform === "macos" || r.platform === "windows" || r.platform === "linux" ? r.platform : "unknown",
    home: str(r.home), thresholdBytes: diskNumber(r.thresholdBytes), totalBytes: nullableNumber(r.totalBytes) ?? items.reduce((sum, item) => sum + item.bytes, 0), items,
    skipped: (Array.isArray(r.skipped) ? r.skipped : []).map(value => { const s = record(value); return { path: str(s.path), reason: str(s.reason, "Unknown reason") }; }), previousScanAt: nullableNumber(r.previousScanAt) };
}
export function readDiskProgress(value: unknown): DiskProgress | null {
  const r = record(value);
  return str(r.scanId) ? { scanId: str(r.scanId), startedAt: diskNumber(r.startedAt), phase: str(r.phase, "home"), entries: diskNumber(r.entries), bytes: diskNumber(r.bytes), path: str(r.path) } : null;
}
export function readDiskState(value: unknown): DiskState {
  const r = record(value);
  return { running: readDiskProgress(r.running), report: readDiskReport(r.report) };
}
export function diskSection(items: readonly DiskItem[], group: DiskGroup): DiskItem[] {
  return items.filter(item => item.group === group).sort((a, b) => b.bytes - a.bytes);
}
export function diskSelectable(item: DiskItem): boolean {
  return item.group !== "work" && item.action !== null;
}
export function toggleDiskSection(selected: ReadonlySet<string>, items: readonly DiskItem[]): Set<string> {
  const next = new Set(selected), selectable = items.filter(diskSelectable);
  const all = selectable.every(item => selected.has(item.id));
  selectable.forEach(item => all ? next.delete(item.id) : next.add(item.id));
  return next;
}
export function diskSelection(items: readonly DiskItem[], selected: ReadonlySet<string>, allowRm: boolean) {
  const picked = items.filter(item => diskSelectable(item) && selected.has(item.id));
  return { ids: picked.map(item => item.id), count: picked.length, bytes: picked.reduce((n, item) => n + item.bytes, 0),
    skippedCount: picked.filter(item => !allowRm && (!item.action || item.action.type === "rm" || item.action.type === "rmOlderThan")).length };
}
export function diskBytes(bytes: number): string {
  const n = diskNumber(bytes);
  if (n < 1e6) return `${(n / 1e3).toLocaleString("en-US", { maximumFractionDigits: 0 })} KB`;
  if (n < 1e9) return `${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`;
  return `${(n / 1e9).toLocaleString("en-US", { maximumFractionDigits: 2 })} GB`;
}
export function diskDate(at: number | null | undefined): string {
  if (!at) return "an unknown date";
  const date = new Date(at < 1e12 ? at * 1000 : at);
  return Number.isNaN(date.getTime()) ? "an unknown date" : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
export const diskGroupLabel: Record<DiskGroup, string> = { clean: "Safe to clean", review: "Review first", work: "Your work" };

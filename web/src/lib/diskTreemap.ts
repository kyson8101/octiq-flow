import { diskSelectable, type DiskGroup, type DiskItem } from "./diskReport";

export type Weighted = { id: string; bytes: number };
export type Tile = { id: string; x: number; y: number; width: number; height: number };

/** Squarify in caller order. No mutation or sorting: equal inputs keep their
 * neighbours when a selection changes. Zero/invalid weights have no area. */
export function diskTreemap(items: readonly Weighted[], width: number, height: number): Tile[] {
  if (!(width > 0 && height > 0 && Number.isFinite(width * height))) return [];
  const positive = items.filter(item => item.bytes > 0 && Number.isFinite(item.bytes));
  // Scale before summing so even very large finite weights cannot overflow.
  const largest = positive.reduce((max, item) => Math.max(max, item.bytes), 0);
  const total = positive.reduce((sum, item) => sum + item.bytes / largest, 0);
  const pending = positive.map(item => ({ id: item.id, area: item.bytes / largest / total * width * height }));
  const tiles: Tile[] = [];
  let x = 0, y = 0, w = width, h = height, index = 0;
  const worst = (row: typeof pending, side: number) => {
    const sum = row.reduce((n, item) => n + item.area, 0);
    const areas = row.map(item => item.area);
    return Math.max(side * side * Math.max(...areas) / (sum * sum), sum * sum / (side * side * Math.min(...areas)));
  };
  while (index < pending.length) {
    const row = [pending[index++]];
    const side = Math.min(w, h);
    while (index < pending.length && worst([...row, pending[index]], side) <= worst(row, side)) row.push(pending[index++]);
    const area = row.reduce((n, item) => n + item.area, 0);
    const vertical = w >= h;
    const thickness = area / (vertical ? h : w);
    let offset = 0;
    row.forEach((item, i) => {
      // Last edge closes the row exactly, avoiding accumulated floating error.
      const length = i === row.length - 1 ? (vertical ? h : w) - offset : item.area / thickness;
      tiles.push({ id: item.id, x: x + (vertical ? 0 : offset), y: y + (vertical ? offset : 0), width: vertical ? thickness : length, height: vertical ? length : thickness });
      offset += length;
    });
    if (vertical) { x += thickness; w = Math.max(0, width - x); }
    else { y += thickness; h = Math.max(0, height - y); }
  }
  return tiles;
}

export type DiskMapTile = Weighted & {
  group: DiskGroup; label: string; items: readonly DiskItem[]; selectedCount: number;
};

/** Overview only: list rows and cleanup selection always keep their original IDs.
 * Collapse kinds first, then the long tail below 1.5% of this group. Selection
 * never changes geometry or membership, and remains counted even inside Other. */
export function aggregateDiskMap(items: readonly DiskItem[], selected: ReadonlySet<string>, minShare = 0.015): DiskMapTile[] {
  const result: DiskMapTile[] = [];
  for (const group of ["clean", "review", "work"] as const) {
    const kinds = new Map<string, DiskItem[]>();
    for (const item of items) {
      if (item.group !== group || !(item.bytes > 0 && Number.isFinite(item.bytes))) continue;
      const bucket = kinds.get(item.kind) ?? [];
      bucket.push(item); kinds.set(item.kind, bucket);
    }
    const makeTile = (id: string, label: string, members: DiskItem[]): DiskMapTile => ({
      id, group, label, items: [...members].sort((a, b) => b.bytes - a.bytes),
      bytes: members.reduce((sum, item) => sum + item.bytes, 0),
      selectedCount: members.filter(item => diskSelectable(item) && selected.has(item.id)).length,
    });
    const buckets = [...kinds].map(([kind, members]) => {
      const label = members.length === 1 ? members[0].label : kind === "git-worktree" ? "Linked Git worktrees"
        : members.every(item => item.label === members[0].label) ? members[0].label
        : (kind.replace(/[-_]/g, " ") || "Folders").replace(/^./, c => c.toUpperCase());
      return makeTile(JSON.stringify([group, kind]), label, members);
    });
    const total = buckets.reduce((sum, bucket) => sum + bucket.bytes, 0);
    const small = buckets.filter(bucket => bucket.bytes / total < minShare);
    const kept = buckets.filter(bucket => bucket.bytes / total >= minShare);
    if (small.length) kept.push(makeTile(JSON.stringify([group, null]), "Other", small.flatMap(bucket => [...bucket.items])));
    result.push(...kept.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id)));
  }
  return result;
}

export type DiskLabelFit = "full" | "size" | "none";
type Extent = { width: number; height: number };
/** Inputs are DOM measurements in CSS pixels, including real font line boxes.
 * The label is a single ellipsized line; never expose a partial vertical line. */
export function diskLabelFit(available: Extent, label: Extent, size: Extent, gap: number): DiskLabelFit {
  if (available.width < size.width || available.height < size.height) return "none";
  return available.width >= label.width && available.height >= label.height + size.height + gap ? "full" : "size";
}

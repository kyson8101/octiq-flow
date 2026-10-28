import { diskGroupLabel, diskSelectable, type DiskGroup, type DiskItem } from "./diskReport";

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

type Extent = { width: number; height: number };

export type DiskMapLayout = {
  regions: { box: Tile; tiles: (DiskMapTile & Tile)[] }[];
  summaries: DiskMapTile[];
};

const mapOrder = (a: DiskMapTile, b: DiskMapTile) => b.bytes - a.bytes || a.id.localeCompare(b.id);
function combineMapTiles(entries: readonly DiskMapTile[], label: string, id: string): DiskMapTile {
  return { id, label, group: entries[0].group,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    selectedCount: entries.reduce((sum, entry) => sum + entry.selectedCount, 0),
    items: entries.flatMap(entry => [...entry.items]).sort((a, b) => b.bytes - a.bytes),
  };
}

/** Pixel-based overview, independent of selection. The caller supplies a font-
 * measured floor including padding/borders and space for the maximum tick count.
 * Each pass folds or removes entries, so the loop is bounded by the input count.
 * There is no DOM/layout feedback loop. Tiny groups move to flow-layout summaries,
 * and the remaining map is laid out again rather than leaving empty slivers. */
export function layoutDiskMap(overview: readonly DiskMapTile[], width: number, height: number, floor: (entry: DiskMapTile) => Extent): DiskMapLayout {
  const groups = (["clean", "review", "work"] as const).flatMap(group => {
    const entries = overview.filter(entry => entry.group === group);
    return entries.length ? [combineMapTiles(entries, diskGroupLabel[group], JSON.stringify([group]))] : [];
  });
  const fits = (box: Extent, entry: DiskMapTile) => {
    const min = floor(entry);
    return box.width >= min.width && box.height >= min.height;
  };
  const summaries: DiskMapTile[] = [];
  const members = new Map(groups.map(group => [group.id, overview.filter(entry => entry.group === group.group).sort(mapOrder)]));
  let visible = groups;
  // Each pass removes a group/Other or folds at least one sibling. No pass
  // restores a removed member, so there are at most O(N) layout passes.
  for (;;) {
    const boxes = diskTreemap(visible, width, height);
    const regions: DiskMapLayout["regions"] = [];
    let changed = false;
    for (const group of visible) {
      const box = boxes.find(box => box.id === group.id);
      if (!box || !fits(box, group)) {
        summaries.push(group); members.delete(group.id); changed = true;
        continue;
      }
      let entries = members.get(group.id)!;
      const tiles = diskTreemap(entries, box.width, box.height);
      const failed = entries.filter(entry => !fits(tiles.find(tile => tile.id === entry.id)!, entry));
      if (!failed.length) {
        regions.push({ box, tiles: tiles.map(tile => ({ ...entries.find(entry => entry.id === tile.id)!, ...tile })) });
        continue;
      }
      changed = true;
      if (entries.length === 1) {
        members.set(group.id, [group]);
        continue;
      }
      const otherId = JSON.stringify([group.group, null]);
      const other = entries.find(entry => entry.id === otherId);
      if (other && failed.every(entry => entry === other)) {
        // Even combined, the tail can be a sliver. Keep it readable next to
        // the map instead of sacrificing the useful large-category overview.
        summaries.push(other);
        entries = entries.filter(entry => entry !== other);
      } else {
        // Squarify can give a large item a narrower box than a small sibling.
        // Fold only the smallest standalone item, then try the prefix again;
        // folding the failed boxes themselves would skip over smaller items.
        const smallest = entries.filter(entry => entry !== other).at(-1)!;
        entries = entries.filter(entry => entry !== smallest && entry !== other);
        const summaryIndex = summaries.findIndex(entry => entry.id === otherId);
        if (summaryIndex >= 0) {
          // A later group reflow may need another fold. Keep the removed tail
          // in its summary rather than restoring it or duplicating its ID.
          summaries[summaryIndex] = combineMapTiles([smallest, summaries[summaryIndex]], "Other", otherId);
        } else {
          entries.push(combineMapTiles(other ? [smallest, other] : [smallest], "Other", otherId));
          entries.sort(mapOrder);
        }
        if (entries.length === 1) entries = [combineMapTiles(entries, group.label, group.id)];
      }
      members.set(group.id, entries);
    }
    if (!changed) return { regions, summaries };
    // Recompute both levels after summary removal: all displayed areas remain
    // proportional to bytes, and no empty region is left behind.
    visible = visible.filter(group => members.has(group.id)).map(group => combineMapTiles(members.get(group.id)!, group.label, group.id));
  }
}

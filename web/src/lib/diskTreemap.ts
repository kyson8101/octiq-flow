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

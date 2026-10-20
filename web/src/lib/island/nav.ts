// Where a robot can walk, and the way there. A grid over the island: a cell
// is free on land and blocked under anything solid at walking height (a
// wall, a table's legs, a bench), so robots go round furniture and come into
// a roofless room through its doorway. Pure, no three.js: the scene hands in
// rectangles and asks for paths.

export type Point = { x: number; z: number };

/** Something solid on the ground: a rectangle turned by `yaw` (radians, the
 *  way three.js turns about y). */
export type Solid = { cx: number; cz: number; hx: number; hz: number; yaw: number };

/** Metres per cell. Small enough that a 1 m doorway (docs/island.md) keeps a
 *  free cell after the walls round it grow by `PAD`. */
export const CELL = 0.4;
/** Solids grow by this much each way, so a 10 cm wall still holds a cell. */
export const PAD = 0.15;

export class NavGrid {
  readonly size: number;
  readonly half: number;
  private blocked: Uint8Array;

  /** `walkways` are walked on though they are over the water (the dock);
   *  the grid reaches far enough out to hold them. */
  constructor(readonly radius: number, solids: readonly Solid[] = [], readonly shore = 1.5, walkways: readonly Solid[] = []) {
    const reach = Math.max(radius, ...walkways.map((w) => Math.hypot(w.cx, w.cz) + Math.hypot(w.hx, w.hz)));
    this.half = Math.ceil(reach / CELL);
    this.size = this.half * 2 + 1;
    this.blocked = new Uint8Array(this.size * this.size);
    const walkable = radius - shore;
    for (let i = 0; i < this.size; i++) {
      for (let j = 0; j < this.size; j++) {
        const { x, z } = this.center(i, j);
        if (Math.hypot(x, z) > walkable) this.blocked[j * this.size + i] = 1;
      }
    }
    for (const way of walkways) this.mark(way, 0, 0);
    for (const solid of solids) this.block(solid);
  }

  private center(i: number, j: number): Point {
    return { x: (i - this.half) * CELL, z: (j - this.half) * CELL };
  }

  private cellOf(p: Point): [number, number] {
    return [Math.round(p.x / CELL) + this.half, Math.round(p.z / CELL) + this.half];
  }

  private inside(i: number, j: number) {
    return i >= 0 && j >= 0 && i < this.size && j < this.size;
  }

  private free(i: number, j: number) {
    return this.inside(i, j) && !this.blocked[j * this.size + i];
  }

  /** Mark the cells whose centres fall inside a solid, grown by `PAD`. */
  block(solid: Solid) {
    this.mark(solid, PAD, 1);
  }

  private mark(solid: Solid, pad: number, value: 0 | 1) {
    const hx = solid.hx + pad;
    const hz = solid.hz + pad;
    const cos = Math.cos(solid.yaw);
    const sin = Math.sin(solid.yaw);
    const reach = Math.hypot(hx, hz);
    const [i0, j0] = this.cellOf({ x: solid.cx - reach, z: solid.cz - reach });
    const [i1, j1] = this.cellOf({ x: solid.cx + reach, z: solid.cz + reach });
    for (let i = Math.max(0, i0); i <= Math.min(this.size - 1, i1); i++) {
      for (let j = Math.max(0, j0); j <= Math.min(this.size - 1, j1); j++) {
        const c = this.center(i, j);
        const dx = c.x - solid.cx;
        const dz = c.z - solid.cz;
        // Into the solid's own axes: the inverse of three.js's turn about y.
        const lx = dx * cos - dz * sin;
        const lz = dx * sin + dz * cos;
        if (Math.abs(lx) <= hx && Math.abs(lz) <= hz) this.blocked[j * this.size + i] = value;
      }
    }
  }

  isFree(p: Point): boolean {
    const [i, j] = this.cellOf(p);
    return this.free(i, j);
  }

  /** The free cell nearest `p` (itself when it is free), within `limit` m. */
  nearestFree(p: Point, limit = 6): Point | null {
    const [ci, cj] = this.cellOf(p);
    if (this.free(ci, cj)) return this.center(ci, cj);
    const rings = Math.ceil(limit / CELL);
    for (let r = 1; r <= rings; r++) {
      let best: Point | null = null;
      let bestDistance = Infinity;
      for (let di = -r; di <= r; di++) {
        for (const dj of Math.abs(di) === r ? range(-r, r) : [-r, r]) {
          const i = ci + di;
          const j = cj + dj;
          if (!this.free(i, j)) continue;
          const c = this.center(i, j);
          const distance = Math.hypot(c.x - p.x, c.z - p.z);
          if (distance < bestDistance) { best = c; bestDistance = distance; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Can a robot walk straight from `a` to `b`? Every cell the segment
   *  passes through is asked, in steps of a third of a cell. */
  clear(a: Point, b: Point): boolean {
    const distance = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(distance / (CELL / 3)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (!this.isFree({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })) return false;
    }
    return true;
  }

  /** A way from `from` to `to`, as points to walk through, ending exactly at
   *  `to`. Either end may be in a blocked cell (a robot on a chair, a seat's
   *  spot inside its own footprint): the search starts and ends at the free
   *  cell nearest each. `null` when there is no way at all. */
  path(from: Point, to: Point, budget = 40000): Point[] | null {
    const start = this.nearestFree(from);
    const goal = this.nearestFree(to);
    if (!start || !goal) return null;
    const [si, sj] = this.cellOf(start);
    const [gi, gj] = this.cellOf(goal);
    const size = this.size;
    const startIndex = sj * size + si;
    const goalIndex = gj * size + gi;
    const came = new Int32Array(size * size).fill(-1);
    const cost = new Float32Array(size * size).fill(Infinity);
    const open = new MinHeap();
    cost[startIndex] = 0;
    open.push(startIndex, heuristic(si, sj, gi, gj));
    let seen = 0;
    let found = startIndex === goalIndex;
    while (!found && open.size && seen++ < budget) {
      const current = open.pop();
      if (current === goalIndex) { found = true; break; }
      const ci = current % size;
      const cj = (current - ci) / size;
      for (const [di, dj, step] of NEIGHBOURS) {
        const ni = ci + di;
        const nj = cj + dj;
        if (!this.free(ni, nj)) continue;
        // No cutting a corner between two solid cells.
        if (di && dj && (!this.free(ci + di, cj) || !this.free(ci, cj + dj))) continue;
        const next = nj * size + ni;
        const tentative = cost[current] + step;
        if (tentative >= cost[next]) continue;
        cost[next] = tentative;
        came[next] = current;
        open.push(next, tentative + heuristic(ni, nj, gi, gj));
      }
    }
    if (!found) return null;
    const cells: Point[] = [];
    for (let at = goalIndex; at !== -1 && at !== startIndex; at = came[at]) {
      const i = at % size;
      cells.push(this.center(i, (at - i) / size));
    }
    cells.reverse();
    const way = this.smooth([from, ...cells]);
    way.shift();
    const last = way[way.length - 1];
    if (!last || Math.hypot(last.x - to.x, last.z - to.z) > 1e-6) way.push(to);
    return way;
  }

  /** Drop every point a robot could skip by walking straight past it. */
  private smooth(points: Point[]): Point[] {
    if (points.length <= 2) return points;
    const out = [points[0]];
    let anchor = 0;
    for (let k = 2; k < points.length; k++) {
      if (!this.clear(points[anchor], points[k])) {
        out.push(points[k - 1]);
        anchor = k - 1;
      }
    }
    out.push(points[points.length - 1]);
    return out;
  }
}

const SQRT2 = Math.SQRT2;
const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

function heuristic(i: number, j: number, gi: number, gj: number) {
  const dx = Math.abs(i - gi);
  const dy = Math.abs(j - gj);
  return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to; v++) out.push(v);
  return out;
}

/** A binary heap of cell indices by priority. */
class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];
  get size() { return this.items.length; }
  push(item: number, key: number) {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.items.length) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.items.length && this.keys[l] < this.keys[smallest]) smallest = l;
        if (r < this.items.length && this.keys[r] < this.keys[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

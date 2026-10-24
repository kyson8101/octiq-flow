import { describe, expect, it, vi } from "vitest";
import { Mesh, MeshBasicMaterial } from "three";
import { buildScenery, timeOfDay } from "./world";
import { CELL, cellCenter, onCellTile, ringCells, TILE, type Plot } from "./model";
import { NavGrid } from "./nav";

const radius = 7 * Math.sqrt(3) * 2 + 13;
const plots: Plot[] = ringCells(2).map(([q, r], slot) => ({
  id: `p${slot}`, owner: { kind: "agent", id: `a${slot}` }, ring: 2, slot, q, r,
  ...cellCenter(q, r), facing: 0, radius: TILE, claimedAt: 0,
}));
const make = () => buildScenery({ radius, seed: 1234, plots, residents: [], shadows: false });

describe("candy scenery", () => {
  it("blocks landmark footprints and leaves the gingerbread gate walkable", () => {
    const scenery = make();
    try {
      const nav = new NavGrid(radius, scenery.solids, 1.5, scenery.walkways);
      for (const a of [0.65, 1.55]) {
        const x = Math.sin(a) * (radius - 3), z = Math.cos(a) * (radius - 3);
        expect(scenery.solids.some(s => Math.hypot(s.cx - x, s.cz - z) < 0.01)).toBe(true);
        expect(nav.isFree({ x, z })).toBe(false);
        expect(nav.path({ x: x - 3, z }, { x: x + 3, z })).not.toBeNull();
      }
      const angle = Math.PI + 0.35;
      const centre = { x: Math.sin(angle) * (radius - 1.8), z: Math.cos(angle) * (radius - 1.8) };
      expect(nav.isFree(centre)).toBe(true);
      const coastal = scenery.solids.filter(s => Math.hypot(s.cx, s.cz) > radius - 7);
      expect(coastal.length).toBeGreaterThan(20);
      for (const solid of coastal) {
        for (const plot of plots) expect(Math.hypot(solid.cx - plot.x, solid.cz - plot.z))
          .toBeGreaterThan(plot.radius + Math.hypot(solid.hx, solid.hz));
      }
    } finally { scenery.dispose(); }
  });

  it("merges sky layers, fades stars at dusk and releases their GPU resources", () => {
    const scenery = make();
    const clouds = scenery.group.getObjectByName("cotton-candy-clouds")!;
    const stars = scenery.group.getObjectByName("sugar-stars")!;
    expect(clouds.children).toHaveLength(2);
    expect(stars.children).toHaveLength(1);
    const floating = scenery.group.getObjectByName("floating-sugar-islands") as Mesh;
    expect(floating).toBeInstanceOf(Mesh);
    expect(floating.geometry.getAttribute("color").count).toBe(floating.geometry.getAttribute("position").count);
    const geometry = floating.geometry;
    const sky = timeOfDay(12);
    scenery.update(0, sky.night, sky, sky.sea);
    expect(floating.position.y).toBe(0);
    scenery.update(2, sky.night, sky, sky.sea);
    expect(floating.position.y).toBeGreaterThan(0);
    expect(floating.geometry).toBe(geometry);
    const releases: ReturnType<typeof vi.spyOn>[] = [];
    const resources = new Set<{ dispose(): void }>();
    scenery.group.traverse(o => {
      if (!(o instanceof Mesh)) return;
      resources.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) resources.add(m);
    });
    for (const resource of resources) releases.push(vi.spyOn(resource, "dispose"));
    for (const hour of [12, 23, 12]) {
      const sky = timeOfDay(hour);
      scenery.update(12, sky.night, sky, sky.sea);
      expect(stars.visible).toBe(hour === 23);
      expect(((stars.children[0] as Mesh).material as MeshBasicMaterial).opacity).toBeCloseTo(sky.night * 0.85);
    }
    scenery.dispose();
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
  });

  it("keeps inland candy off tiles and reserved cells, with clear path middles", () => {
    const scenery = make();
    try {
      const candy = scenery.solids.filter(s => s.hx === 0.43 && s.hz === 0.43);
      expect(candy.length).toBeGreaterThan(15);
      const play = cellCenter(-1, 0);
      const nav = new NavGrid(radius, scenery.solids, 1.5, scenery.walkways);
      const keys = new Set<string>();
      for (const s of candy) {
        const key = `${Math.round(s.cx * 100)},${Math.round(s.cz * 100)}`;
        expect(keys.has(key)).toBe(false);
        keys.add(key);
        expect(Math.hypot(s.cx, s.cz)).toBeGreaterThan(CELL + 0.8);
        expect(Math.hypot(s.cx - play.x, s.cz - play.z)).toBeGreaterThan(CELL + 0.8);
        for (const dx of [-s.hx, 0, s.hx]) for (const dz of [-s.hz, 0, s.hz]) {
          expect(onCellTile(s.cx + dx, s.cz + dz)).toBe(false);
        }
        expect(nav.isFree({ x: s.cx, z: s.cz })).toBe(false);
      }
      // The midpoint of a shared hex edge stays open between two candy pockets.
      const a = cellCenter(1, 0), b = cellCenter(2, 0);
      expect(nav.isFree({ x: (a.x + b.x) / 2, z: 0 })).toBe(true);
    } finally { scenery.dispose(); }
  });

  it("blocks only the rainbow feet and allows walking through the arch", () => {
    const scenery = make();
    try {
      const angle = -0.2, r = radius - 3;
      const x = Math.sin(angle) * r, z = Math.cos(angle) * r;
      const nav = new NavGrid(radius, scenery.solids, 1.5, scenery.walkways);
      expect(nav.isFree({ x, z })).toBe(true);
      for (const side of [-4.25, 4.25]) {
        const foot = { x: x + Math.cos(angle) * side, z: z - Math.sin(angle) * side };
        expect(scenery.solids.some(s => Math.hypot(s.cx - foot.x, s.cz - foot.z) < 0.01)).toBe(true);
        expect(nav.isFree(foot)).toBe(false);
      }
      expect(nav.clear({ x: x - Math.sin(angle), z: z - Math.cos(angle) },
        { x: x + Math.sin(angle), z: z + Math.cos(angle) })).toBe(true);
    } finally { scenery.dispose(); }
  });
});

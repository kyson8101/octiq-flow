import { describe, expect, it, vi } from "vitest";
import { Mesh, MeshBasicMaterial } from "three";
import { buildScenery, timeOfDay } from "./world";
import { cellCenter, ringCells, TILE, type Plot } from "./model";
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
});

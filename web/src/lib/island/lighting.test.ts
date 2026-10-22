import { describe, expect, it, vi } from "vitest";
import { Matrix4, Mesh, MeshBasicMaterial } from "three";
import { finishMaterials, setFinishNight } from "./assets";
import { buildingLightPools, NightLighting } from "./lighting";
import { officeLayout } from "./offices";
import { timeOfDay } from "./world";
import type { Asset, Island, Part } from "./model";

const part = (size: Part["size"], at: Part["at"]): Part => ({ shape: "box", size, at, color: "#ffffff" });
const building = (parts: Part[]): Pick<Asset, "kind" | "parts"> => ({ kind: "building", parts });

describe("roofless interior lighting", () => {
  it("lights each real Tower floor and leaves the stored asset alone", () => {
    const source: Island = { version: 1, rev: 1, seed: 1, createdAt: 0, updatedAt: 0, radius: 30,
      settings: { wishPace: "never" }, plots: [], bots: [], looks: {}, assets: [], placed: [], wishes: [], lastRollAt: 0 };
    const tower = officeLayout(source, []).island.assets.find(asset => asset.name === "Agent Tower")!;
    const original = JSON.stringify(tower);
    const pools = buildingLightPools(tower);
    expect(pools).toHaveLength(3);
    pools.forEach((pool, i) => expect(pool.y).toBeCloseTo(0.092 + i * 2.3));
    expect(pools.every(pool => pool.width < 8 && pool.depth < 6)).toBe(true);
    expect(JSON.stringify(tower)).toBe(original);
  });

  it("handles home floors, rotated granted floors and floorless pavilions", () => {
    const home = building([part([6, 0.06, 4.5], [0, 0.03, -0.8])]);
    expect(buildingLightPools(home)[0].z).toBeCloseTo(-0.8);
    expect(buildingLightPools(home)[0].y).toBeCloseTo(0.072);
    const rotated = building([{ ...part([6, 0.1, 3], [1, 0.05, -1]), turn: [0, 90, 0] }]);
    expect(buildingLightPools(rotated)[0].width).toBeCloseTo(3 * 0.96);
    expect(buildingLightPools(rotated)[0].depth).toBeCloseTo(6 * 0.96);
    const open = building([part([0.2, 2, 0.2], [-2, 1, -2]), part([0.2, 2, 0.2], [2, 1, 2])]);
    expect(buildingLightPools(open)).toHaveLength(1);
    expect(buildingLightPools(open)[0].y).toBe(0.012);
    expect(buildingLightPools({ ...home, kind: "furniture" })).toEqual([]);
    expect(buildingLightPools(building([]))).toEqual([]);
  });
});

describe("shared night light layer", () => {
  it("follows the sky smoothly in both directions and hides entirely at noon", () => {
    const lights = new NightLighting();
    lights.replace([{ x: 0, y: 0, z: 0, width: 5, depth: 5 }]);
    const dusk = [12, 18.8, 19, 20.3, 23].map(hour => {
      lights.update(timeOfDay(hour).night);
      return lights.material.uniforms.night.value;
    });
    expect(dusk[0]).toBe(0);
    expect(dusk.every((n, i) => i === 0 || n > dusk[i - 1])).toBe(true);
    const dawn = [5.5, 6, 6.6, 8].map(hour => timeOfDay(hour).night);
    expect(dawn.every((n, i) => i === 0 || n < dawn[i - 1])).toBe(true);
    lights.update(timeOfDay(19).night);
    const steady = lights.material.uniforms.night.value;
    lights.update(timeOfDay(19).night);
    expect(lights.material.uniforms.night.value).toBe(steady);
    lights.update(0);
    expect(lights.group.visible).toBe(false);
    lights.dispose();
  });

  it("merges any number of transformed pools into one mesh with no real lights", () => {
    const lights = new NightLighting();
    lights.replace(Array.from({ length: 100 }, (_, i) => ({ x: 0, y: 0.2, z: 0, width: 4, depth: 3,
      transform: new Matrix4().makeRotationY(Math.PI / 2).setPosition(i * 10, 3, 2) })));
    expect(lights.group.children).toHaveLength(1);
    const mesh = lights.group.children[0] as Mesh;
    expect(mesh.material).toBe(lights.material);
    mesh.geometry.computeBoundingBox();
    expect(mesh.geometry.boundingBox!.min.y).toBeCloseTo(3.2);
    expect(mesh.geometry.boundingBox!.max.x).toBeCloseTo(991.5);
    expect(mesh.castShadow).toBe(false);
    expect(lights.material.depthWrite).toBe(false);
    lights.dispose();
  });

  it("releases old geometry on replacement and all resources on teardown", () => {
    const lights = new NightLighting();
    const pool = { x: 0, y: 0, z: 0, width: 2, depth: 2 };
    lights.replace([pool]);
    const geometry = (lights.group.children[0] as Mesh).geometry;
    const release = vi.spyOn(geometry, "dispose");
    lights.replace([]);
    expect(release).toHaveBeenCalledOnce();
    expect(lights.group.children).toHaveLength(0);
    const materialRelease = vi.spyOn(lights.material, "dispose");
    lights.dispose();
    expect(materialRelease).toHaveBeenCalledOnce();
  });

  it("brightens the one shared glow material at night and restores noon exactly", () => {
    const glow = finishMaterials().glow as MeshBasicMaterial;
    try {
      setFinishNight(0);
      expect(glow.color.r).toBe(1);
      setFinishNight(timeOfDay(19).night);
      const dusk = glow.color.r;
      setFinishNight(1);
      expect(finishMaterials().glow).toBe(glow);
      expect(glow.color.r).toBeGreaterThan(dusk);
      expect(dusk).toBeGreaterThan(1);
      expect(glow.vertexColors).toBe(true);
      setFinishNight(0);
      expect(glow.color.toArray()).toEqual([1, 1, 1]);
    } finally { setFinishNight(0); }
  });
});

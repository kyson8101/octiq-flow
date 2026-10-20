import { describe, expect, it } from "vitest";
import { Box3, Vector3 } from "three";
import { AssetCache, assetBox, buildAsset, partBox, unitShapes } from "./assets";
import type { Asset, Part, Shape } from "./model";

const part = (shape: Shape, extra: Partial<Part> = {}): Part => ({ shape, size: [1, 1, 1], at: [0, 0.5, 0], color: "#ff8800", ...extra });

describe("an asset's shapes", () => {
  it("are all made as units that fill −0.5..0.5 on every axis, and never go past it", () => {
    // A round shape is drawn with flat facets inside its true outline, so it
    // comes just short of the box on some axes; never outside the box the
    // host checks.
    for (const [name, geometry] of Object.entries(unitShapes())) {
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      for (const axis of ["x", "y", "z"] as const) {
        expect(box.min[axis], `${name} ${axis}`).toBeGreaterThanOrEqual(-0.5 - 1e-6);
        expect(box.max[axis], `${name} ${axis}`).toBeLessThanOrEqual(0.5 + 1e-6);
        expect(box.min[axis], `${name} ${axis}`).toBeLessThan(-0.47);
        expect(box.max[axis], `${name} ${axis}`).toBeGreaterThan(0.47);
      }
    }
  });

  it("make a wedge whose faces all point out", () => {
    const wedge = unitShapes().wedge;
    const position = wedge.attributes.position;
    const centre = new Vector3();
    for (let i = 0; i < position.count; i++) centre.add(new Vector3().fromBufferAttribute(position, i));
    centre.divideScalar(position.count);
    for (let i = 0; i < position.count; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => new Vector3().fromBufferAttribute(position, i + k));
      const normal = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).normalize();
      const middle = a.clone().add(b).add(c).divideScalar(3);
      expect(normal.dot(middle.sub(centre))).toBeGreaterThan(0);
    }
  });

  it("measure a turned part by the box it fills once turned", () => {
    const flat = partBox({ size: [2, 0.2, 0.5], at: [0, 1, 0] });
    expect(flat.min).toEqual([-1, 0.9, -0.25]);
    const turned = partBox({ size: [2, 0.2, 0.5], at: [0, 1, 0], turn: [0, 90, 0] });
    expect(turned.max[0]).toBeCloseTo(0.25);
    expect(turned.max[2]).toBeCloseTo(1);
    const asset = assetBox({ parts: [part("box"), part("box", { at: [2, 0.5, 0] })] });
    expect(asset.min[0]).toBeCloseTo(-0.5);
    expect(asset.max[0]).toBeCloseTo(2.5);
  });
});

describe("building an asset", () => {
  it("merges the parts of each finish into one mesh, coloured in its vertices", () => {
    const built = buildAsset({
      parts: [
        part("round"), part("cylinder", { at: [1, 0.5, 0] }), part("sphere", { at: [-1, 0.5, 0], finish: "glow" }),
        part("cone", { finish: "metal", at: [0, 1.5, 0] }), part("torus", { finish: "glow", at: [0, 2, 0] }),
      ],
    });
    expect(built.meshes.map((mesh) => mesh.finish).sort()).toEqual(["glow", "metal", "soft"]);
    for (const mesh of built.meshes) expect(mesh.geometry.attributes.color).toBeDefined();
    const bounds = new Box3();
    for (const mesh of built.meshes) bounds.union(mesh.geometry.boundingBox!);
    expect(bounds.min.x).toBeCloseTo(-1.5, 1);
    expect(bounds.max.y).toBeCloseTo(2.5, 1);
    expect(bounds.max.y).toBeLessThanOrEqual(2.5);
    built.dispose();
  });

  it("makes an asset again only when its maker rebuilt it, and lets go of what is gone", () => {
    const cache = new AssetCache();
    const asset: Asset = {
      id: "a1", rev: 1, name: "Stool", kind: "furniture", parts: [part("cylinder")],
      by: { name: "Maya" }, madeAt: 0, updatedAt: 0,
    };
    const first = cache.get(asset);
    expect(cache.get(asset)).toBe(first);
    const rebuilt = cache.get({ ...asset, rev: 2, parts: [part("box")] });
    expect(rebuilt).not.toBe(first);
    cache.prune(new Set());
    expect(cache.get({ ...asset, rev: 2 })).not.toBe(rebuilt);
    cache.dispose();
  });
});

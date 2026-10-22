// Night-only light painted onto surfaces, with no per-building GPU lights.
// All pools in a layer share one material and one merged draw call.
import { AdditiveBlending, Color, Group, Matrix4, Mesh, PlaneGeometry, ShaderMaterial } from "three";
import type { BufferGeometry } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { assetBox, partBox } from "./assets";
import type { Asset } from "./model";

export type LightPool = {
  x: number; y: number; z: number; width: number; depth: number;
  transform?: Matrix4;
};

/** Each exposed floor gets a warm interior pool, including the Tower's
 *  upper storeys. A floorless granted pavilion gets one on the ground. */
export function buildingLightPools(asset: Pick<Asset, "kind" | "parts">): LightPool[] {
  if (asset.kind !== "building" || !asset.parts.length) return [];
  const floors = asset.parts.map(partBox).filter(({ min, max }) =>
    max[1] - min[1] < 0.3 && max[0] - min[0] > 1 && max[2] - min[2] > 1);
  if (!floors.length) {
    const box = assetBox(asset);
    floors.push({ min: [box.min[0], 0, box.min[2]], max: [box.max[0], 0, box.max[2]] });
  }
  return floors.map(({ min, max }) => ({
    x: (min[0] + max[0]) / 2, y: max[1] + 0.012, z: (min[2] + max[2]) / 2,
    width: (max[0] - min[0]) * 0.96, depth: (max[2] - min[2]) * 0.96,
  }));
}

export class NightLighting {
  readonly group = new Group();
  readonly material = new ShaderMaterial({
    uniforms: { night: { value: 0 }, warmth: { value: new Color("#ffb24d") } },
    vertexShader: `varying vec2 lightUv;
      void main() { lightUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float night; uniform vec3 warmth; varying vec2 lightUv;
      void main() {
        vec2 p = lightUv * 2.0 - 1.0;
        float falloff = pow(max(0.0, 1.0 - dot(p, p)), 2.0);
        gl_FragColor = vec4(warmth, night * 0.34 * falloff);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
  });
  private geometry?: BufferGeometry;

  constructor() {
    this.group.name = "night-light-pools";
    this.group.visible = false;
  }

  /** Rebuild on placement/scenery changes, never in the animation loop. */
  replace(pools: readonly LightPool[]) {
    this.group.clear();
    this.geometry?.dispose();
    this.geometry = undefined;
    if (!pools.length) return;
    const pieces = pools.map(pool => {
      const piece = new PlaneGeometry(pool.width, pool.depth);
      piece.rotateX(-Math.PI / 2);
      piece.translate(pool.x, pool.y, pool.z);
      if (pool.transform) piece.applyMatrix4(pool.transform);
      return piece;
    });
    this.geometry = mergeGeometries(pieces, false) ?? undefined;
    pieces.forEach(piece => piece.dispose());
    if (this.geometry) {
      this.geometry.computeBoundingSphere();
      const mesh = new Mesh(this.geometry, this.material);
      mesh.renderOrder = 1;
      this.group.add(mesh);
    }
  }

  /** The same continuous night value as the sky; no time or flicker input. */
  update(night: number) {
    this.material.uniforms.night.value = Math.max(0, Math.min(1, night));
    this.group.visible = this.material.uniforms.night.value > 0;
  }

  dispose() {
    this.geometry?.dispose();
    this.material.dispose();
    this.group.clear();
  }
}

// An asset as meshes. Every shape is made once as a unit that fills the box
// −0.5..0.5 on every axis, so a part is that unit scaled to its `size`, turned
// by its `turn` and moved to its `at` (docs/island.md, Assets). The parts of
// one asset that share a finish are merged into one mesh with the colours in
// the vertices: a 200-part building is at most six draw calls, and every
// asset on the island shares the same six materials.
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Euler, Group, Matrix4, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, Quaternion, SphereGeometry, TorusGeometry, Vector3,
} from "three";
import type { Material } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Asset, Finish, Part, Shape, Vec3 } from "./model";

const DEG = Math.PI / 180;

/** A box from its two corners. */
export type Box = { min: Vec3; max: Vec3 };

/** The rotation a part's `turn` makes: three.js's own 'XYZ' Euler, the order
 *  the host checks bounds in. */
function turnMatrix(turn: Vec3 | undefined): Matrix4 {
  const [x, y, z] = turn ?? [0, 0, 0];
  return new Matrix4().makeRotationFromEuler(new Euler(x * DEG, y * DEG, z * DEG, "XYZ"));
}

/** The box a part fills once turned, in its asset's coordinates. */
export function partBox(part: Pick<Part, "size" | "at" | "turn">): Box {
  const turn = turnMatrix(part.turn);
  const half = part.size.map((v) => v / 2) as Vec3;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const corner = new Vector3();
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    corner.set(sx * half[0], sy * half[1], sz * half[2]).applyMatrix4(turn);
    const point = [corner.x + part.at[0], corner.y + part.at[1], corner.z + part.at[2]];
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], point[i]);
      max[i] = Math.max(max[i], point[i]);
    }
  }
  return { min, max };
}

/** The box round every part of an asset. */
export function assetBox(asset: Pick<Asset, "parts">): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const part of asset.parts) {
    const box = partBox(part);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], box.min[i]);
      max[i] = Math.max(max[i], box.max[i]);
    }
  }
  if (!asset.parts.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** A wedge: full height at −z, sloping down to nothing at +z. Two triangles
 *  for each face, every face its own normal (a ramp reads as a ramp). */
function wedgeGeometry(): BufferGeometry {
  const a = [-0.5, -0.5, -0.5], b = [0.5, -0.5, -0.5], c = [0.5, -0.5, 0.5], d = [-0.5, -0.5, 0.5];
  const e = [-0.5, 0.5, -0.5], f = [0.5, 0.5, -0.5];
  // Counter-clockwise seen from outside, so each normal points out.
  const faces = [
    [a, b, c], [a, c, d], // bottom
    [a, f, b], [a, e, f], // back
    [e, c, f], [e, d, c], // slope
    [a, d, e], // left side
    [b, f, c], // right side
  ];
  const positions = new Float32Array(faces.length * 9);
  faces.forEach((tri, i) => tri.forEach((v, j) => positions.set(v, i * 9 + j * 3)));
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

let units: Record<Shape, BufferGeometry> | null = null;
/** The unit shapes, made once for the page and never disposed. */
export function unitShapes(): Record<Shape, BufferGeometry> {
  if (units) return units;
  const torus = new TorusGeometry(0.375, 0.125, 10, 28);
  torus.rotateX(Math.PI / 2);
  torus.scale(1, 4, 1);
  const made: Record<Shape, BufferGeometry> = {
    box: new BoxGeometry(1, 1, 1),
    round: new RoundedBoxGeometry(1, 1, 1, 2, 0.12),
    cylinder: new CylinderGeometry(0.5, 0.5, 1, 20),
    cone: new ConeGeometry(0.5, 1, 20),
    sphere: new SphereGeometry(0.5, 18, 12),
    torus,
    wedge: wedgeGeometry(),
  };
  // One shape of attributes for all of them, so any mix merges.
  for (const key of Object.keys(made) as Shape[]) {
    let geometry = made[key];
    if (geometry.index) geometry = geometry.toNonIndexed();
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== "position" && name !== "normal") geometry.deleteAttribute(name);
    }
    made[key] = geometry;
  }
  units = made;
  return made;
}

const FINISHES: Finish[] = ["matte", "soft", "shiny", "metal", "glass", "glow"];

/** Camera-fade clones keep their own opacity but share the live night colour. */
class GlowMaterial extends MeshBasicMaterial {
  override copy(source: this): this {
    super.copy(source);
    this.color = source.color;
    return this;
  }
}

let materials: Record<Finish, Material> | null = null;
/** The six materials every asset on the island is drawn with. */
export function finishMaterials(): Record<Finish, Material> {
  return materials ??= {
    matte: new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
    soft: new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.04 }),
    shiny: new MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0.06 }),
    metal: new MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.85 }),
    glass: new MeshStandardMaterial({
      vertexColors: true, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.38, depthWrite: false,
    }),
    glow: new GlowMaterial({ vertexColors: true }),
  };
}

/** One multiplier for all agent-built glow parts; noon keeps their original colour. */
export function setFinishNight(night: number) {
  (finishMaterials().glow as MeshBasicMaterial).color.setScalar(1 + Math.max(0, Math.min(1, night)) * 1.6);
}

/** One part, baked: the unit shape scaled, turned and moved, with its colour
 *  in every vertex. */
function bakedPart(part: Part): BufferGeometry {
  const geometry = unitShapes()[part.shape].clone();
  const matrix = new Matrix4().compose(
    new Vector3(...part.at),
    new Quaternion().setFromRotationMatrix(turnMatrix(part.turn)),
    new Vector3(...part.size.map((v) => Math.max(v, 0.001)) as Vec3),
  );
  geometry.applyMatrix4(matrix);
  const color = new Color(part.color);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3);
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

/** An asset's meshes, one per finish it uses. */
export type BuiltAsset = {
  /** Merged geometry per finish; shared by every placement of the asset. */
  meshes: { finish: Finish; geometry: BufferGeometry }[];
  box: Box;
  dispose(): void;
};

export function buildAsset(asset: Pick<Asset, "parts">): BuiltAsset {
  const byFinish = new Map<Finish, BufferGeometry[]>();
  for (const part of asset.parts) {
    const finish = FINISHES.includes(part.finish as Finish) ? (part.finish as Finish) : "soft";
    const list = byFinish.get(finish) ?? [];
    list.push(bakedPart(part));
    byFinish.set(finish, list);
  }
  const meshes: BuiltAsset["meshes"] = [];
  for (const finish of FINISHES) {
    const pieces = byFinish.get(finish);
    if (!pieces?.length) continue;
    const geometry = pieces.length === 1 ? pieces[0] : mergeGeometries(pieces, false);
    if (pieces.length > 1) pieces.forEach((piece) => piece.dispose());
    if (!geometry) continue;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    meshes.push({ finish, geometry });
  }
  return {
    meshes,
    box: assetBox(asset),
    dispose() { meshes.forEach(({ geometry }) => geometry.dispose()); },
  };
}

/** A placement of a built asset: a group of meshes sharing its geometry. */
export function assetObject(built: BuiltAsset, opts: { shadows?: boolean } = {}): Group {
  const group = new Group();
  const finishes = finishMaterials();
  for (const { finish, geometry } of built.meshes) {
    const mesh = new Mesh(geometry, finishes[finish]);
    // Glass and light neither throw a shadow nor catch one.
    const solid = finish !== "glass" && finish !== "glow";
    mesh.castShadow = !!opts.shadows && solid;
    mesh.receiveShadow = !!opts.shadows && solid;
    mesh.userData.finish = finish;
    group.add(mesh);
  }
  return group;
}

/** Built assets by id and revision, so a placement drawn again, or an asset
 *  placed twice, makes its geometry once; an asset rebuilt by its maker is
 *  made again under its new revision and the old one let go. */
export class AssetCache {
  private built = new Map<string, { rev: number; built: BuiltAsset }>();

  get(asset: Asset): BuiltAsset {
    const held = this.built.get(asset.id);
    if (held && held.rev === asset.rev) return held.built;
    held?.built.dispose();
    const built = buildAsset(asset);
    this.built.set(asset.id, { rev: asset.rev, built });
    return built;
  }

  /** Let go of everything not in `keep`. */
  prune(keep: ReadonlySet<string>) {
    for (const [id, held] of this.built) {
      if (keep.has(id)) continue;
      held.built.dispose();
      this.built.delete(id);
    }
  }

  dispose() {
    for (const held of this.built.values()) held.built.dispose();
    this.built.clear();
  }
}

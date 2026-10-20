// Builds the island's own solid things (the plaza, palms, the playground)
// out of simple shapes, merged into one mesh per material, so a palm or a
// bench is a draw call or two.
import { Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from "three";
import type { BufferGeometry, Material } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export type Placing = { rx?: number; ry?: number; rz?: number; sx?: number; sy?: number; sz?: number };

export class Kit {
  private pieces = new Map<Material, BufferGeometry[]>();
  constructor(private materials: Record<string, Material>) {}

  /** A shape scaled, turned (x, then z, then y) and put at (x, y, z). */
  add(material: string, geometry: BufferGeometry, x: number, y: number, z: number, opts: Placing = {}) {
    const piece = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    for (const name of Object.keys(piece.attributes)) if (name !== "position" && name !== "normal") piece.deleteAttribute(name);
    piece.scale(opts.sx ?? 1, opts.sy ?? 1, opts.sz ?? 1);
    if (opts.rx) piece.rotateX(opts.rx);
    if (opts.rz) piece.rotateZ(opts.rz);
    if (opts.ry) piece.rotateY(opts.ry);
    piece.translate(x, y, z);
    const m = this.materials[material];
    const list = this.pieces.get(m) ?? [];
    list.push(piece);
    this.pieces.set(m, list);
  }

  /** The same, for a piece of something turned by `yaw` and standing at
   *  (`cx`, `cz`): `x` and `z` are in its own coordinates. A turn of the
   *  piece's own (`rx`, `rz`) is made before the yaw. */
  addAt(cx: number, cz: number, yaw: number, material: string, geometry: BufferGeometry, x: number, y: number, z: number,
    opts: Placing = {}) {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    this.add(material, geometry, cx + x * cos + z * sin, y, cz - x * sin + z * cos, { ...opts, ry: (opts.ry ?? 0) + yaw });
  }

  build(shadows: boolean): Group {
    const group = new Group();
    for (const [material, pieces] of this.pieces) {
      const merged = mergeGeometries(pieces, false);
      pieces.forEach((p) => p.dispose());
      if (!merged) continue;
      const mesh = new Mesh(merged, material);
      const lit = !(material instanceof MeshBasicMaterial);
      mesh.castShadow = shadows && lit;
      mesh.receiveShadow = shadows && lit;
      group.add(mesh);
    }
    this.pieces.clear();
    return group;
  }
}

export const solidMaterial = (color: string, roughness = 0.8, metalness = 0) =>
  new MeshStandardMaterial({ color, roughness, metalness, flatShading: true });

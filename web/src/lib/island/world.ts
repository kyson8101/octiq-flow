// The island's scenery: the land and its beach, the sea, the sky, the
// honeycomb of plots, and what stands on the island without anyone having
// built it: the plaza with the wish tree, benches and lamps, the dock where
// bots arrive, palms, rocks and a lighthouse. Low-poly and flat-shaded, and
// merged by material, so the whole of it is a handful of draw calls.
import {
  BackSide, BufferAttribute, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, DoubleSide, Group,
  IcosahedronGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, RingGeometry, ShaderMaterial,
  SphereGeometry, SRGBColorSpace, Vector3,
} from "three";
import type { Material } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { Kit, solidMaterial } from "./kit";
import { NightLighting, type LightPool } from "./lighting";
import type { Plot, Resident } from "./model";
import { CELL, PLAZA_RADIUS, TILE, TILE_TOP, cellCenter, facingFor, plotNames, plotToWorld, ringCells } from "./model";
import { PLAYGROUND_CELL, buildPlayground, type Playground } from "./playground";
import type { Solid } from "./nav";
import type { Seat } from "./sim";

export const SEA_LEVEL = -0.18;

/** Value noise, the same everywhere for the same island. */
function noise(x: number, z: number, seed: number): number {
  const hash = (i: number, j: number) => {
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const i = Math.floor(x);
  const j = Math.floor(z);
  const fx = x - i;
  const fz = z - j;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

const smooth = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** Ground height at a distance from the centre: flat land to the beach, the
 *  beach sloping into the water, the shallows falling away. */
export function groundHeight(r: number, radius: number): number {
  if (r <= radius - 5) return 0;
  if (r <= radius + 0.6) return -0.32 * smooth(radius - 5, radius + 0.6, r);
  return -0.32 - 2.4 * smooth(radius + 0.6, radius + 12, r);
}

const COLORS = {
  grass: new Color("#8fcb72"),
  grassDark: new Color("#7fbe64"),
  sand: new Color("#f0dcaa"),
  wetSand: new Color("#dcc28a"),
  deep: new Color("#bfa673"),
};

/** The land as one polar mesh: grass, then the beach. The honeycomb lies
 *  on it (`honeycomb`). */
function terrain(radius: number, seed: number): Mesh {
  const outer = radius + 14;
  const segments = 128;
  const radii: number[] = [0];
  for (let r = 0.9; r < outer; r += r < radius - 6 ? 1.6 : 0.8) radii.push(r);
  radii.push(outer);
  const positions: number[] = [];
  const colors: number[] = [];
  const point = (r: number, a: number) => {
    // A ragged shoreline: the beach is wider in some places than others.
    const wobble = r > radius - 7 ? (noise(Math.cos(a) * 3, Math.sin(a) * 3, seed) - 0.5) * 2.2 : 0;
    const rr = r + wobble * smooth(radius - 7, radius, r);
    const x = Math.sin(a) * rr;
    const z = Math.cos(a) * rr;
    const y = groundHeight(r, radius) + (r > radius - 5 && r < radius + 8 ? (noise(x * 0.4, z * 0.4, seed + 7) - 0.5) * 0.12 : 0);
    const color = new Color();
    if (r < radius - 5.2) {
      color.copy(COLORS.grass).lerp(COLORS.grassDark, noise(x * 0.15, z * 0.15, seed) * 0.7);
    } else if (r < radius + 0.4) {
      color.copy(COLORS.sand).lerp(COLORS.wetSand, smooth(radius - 1.5, radius + 0.4, r));
    } else {
      color.copy(COLORS.wetSand).lerp(COLORS.deep, smooth(radius + 0.4, radius + 8, r));
    }
    return { p: [x, y, z], c: [color.r, color.g, color.b] };
  };
  for (let k = 0; k < radii.length - 1; k++) {
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2;
      const a1 = ((s + 1) / segments) * Math.PI * 2;
      const p00 = point(radii[k], a0), p01 = point(radii[k], a1);
      const p10 = point(radii[k + 1], a0), p11 = point(radii[k + 1], a1);
      // Counter-clockwise seen from above, so the land faces the sky.
      for (const tri of k === 0 ? [[p00, p10, p11]] : [[p00, p10, p11], [p00, p11, p01]]) {
        // One colour per triangle: the flat, faceted look.
        const c = tri[0].c;
        for (const v of tri) { positions.push(...v.p); colors.push(...c); }
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  geometry.computeVertexNormals();
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }));
  mesh.receiveShadow = true;
  mesh.name = "terrain";
  return mesh;
}

/** The sea: a faceted plane whose waves are moved on the GPU, calm near the
 *  shore so the beach line holds still. */
function sea(radius: number): { mesh: Mesh; material: MeshStandardMaterial; time: { value: number } } {
  const geometry = new PlaneGeometry(900, 900, 150, 150);
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshStandardMaterial({
    color: "#5fbcd8", flatShading: true, roughness: 0.32, metalness: 0.08, transparent: true, opacity: 0.88,
  });
  const time = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.uniforms.uShore = { value: radius };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uShore;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        float away = smoothstep(uShore + 1.0, uShore + 16.0, length(position.xz));
        transformed.y += away * (sin(position.x * 0.17 + uTime * 0.8) * 0.12
          + cos(position.z * 0.14 + uTime * 0.65) * 0.1
          + sin((position.x + position.z) * 0.33 + uTime * 1.5) * 0.04);`);
  };
  const mesh = new Mesh(geometry, material);
  mesh.position.y = SEA_LEVEL;
  mesh.name = "sea";
  return { mesh, material, time };
}

function sky(): { mesh: Mesh; top: Color; horizon: Color } {
  const top = new Color("#79b8f0");
  const horizon = new Color("#e8f3fb");
  const material = new ShaderMaterial({
    side: BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: top }, horizon: { value: horizon } },
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 vDir;
      void main() { float h = clamp(vDir.y * 1.6 + 0.05, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, top, pow(h, 0.7)), 1.0); }`,
  });
  const mesh = new Mesh(new SphereGeometry(600, 24, 12), material);
  mesh.name = "sky";
  mesh.renderOrder = -1;
  return { mesh, top, horizon };
}

/** The names on a little board, for a plot's sign: smaller for a home of
 *  several, and cut short only when even that does not fit. */
function nameTexture(name: string): CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#f6ead2";
  ctx.fillRect(0, 0, 256, 96);
  ctx.fillStyle = "#5a3e2b";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let size = 40;
  const font = () => `600 ${size}px Inter, system-ui, sans-serif`;
  ctx.font = font();
  while (ctx.measureText(name).width > 228 && size > 22) {
    size -= 2;
    ctx.font = font();
  }
  let text = name;
  while (ctx.measureText(text).width > 228 && text.length > 2) text = `${text.slice(0, -2)}…`;
  ctx.fillText(text, 128, 50);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export type Scenery = {
  group: Group;
  seats: Seat[];
  solids: Solid[];
  /** Walked on over the water: the dock. Its deck's height is `deck`. */
  walkways: Solid[];
  deck: number;
  /** The spot at the end of the dock, where a bot steps off the boat. */
  dock: { x: number; z: number; face: number };
  playground: Playground;
  update(t: number, night: number, sky: { top: Color; horizon: Color }, seaColor: Color): void;
  setLetters(count: number): void;
  dispose(): void;
};

/** Everything that does not move but the sea, for one island. */
export function buildScenery(opts: {
  radius: number;
  seed: number;
  plots: readonly Plot[];
  residents: readonly Resident[];
  shadows: boolean;
}): Scenery {
  const { radius, seed, plots } = opts;
  const group = new Group();
  group.name = "scenery";
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(thing: T) => { disposables.push(thing); return thing; };

  const land = terrain(radius, seed);
  own(land.geometry);
  own(land.material as Material);
  group.add(land);

  const water = sea(radius);
  own(water.mesh.geometry);
  own(water.material);
  group.add(water.mesh);

  const foamMaterial = own(new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.32, depthWrite: false }));
  const foam = new Mesh(own(new RingGeometry(radius - 0.2, radius + 1.4, 128)), foamMaterial);
  foam.rotation.x = -Math.PI / 2;
  foam.position.y = SEA_LEVEL + 0.06;
  group.add(foam);

  const skyDome = sky();
  own(skyDome.mesh.geometry);
  own(skyDome.mesh.material as Material);
  group.add(skyDome.mesh);

  const materials: Record<string, Material> = {
    wood: own(solidMaterial("#b9875e")),
    darkWood: own(solidMaterial("#7a563b")),
    leaf: own(solidMaterial("#4f9d63")),
    leafLight: own(solidMaterial("#62b273")),
    pine: own(solidMaterial("#2f6f52")),
    pineLight: own(solidMaterial("#3c8a62")),
    trunk: own(solidMaterial("#8a5a3c")),
    rock: own(solidMaterial("#b8b3aa", 0.9)),
    metal: own(solidMaterial("#3c4b53", 0.5, 0.5)),
    white: own(solidMaterial("#f6f3ec", 0.7)),
    red: own(solidMaterial("#df5a4e", 0.7)),
    blue: own(solidMaterial("#5b8bd9", 0.7)),
    stone: own(solidMaterial("#d8ccb2", 0.9)),
    paper: own(solidMaterial("#fbf7ee", 0.8)),
    lamp: own(new MeshBasicMaterial({ color: "#ffe3a8" })),
    nightLamp: own(new MeshBasicMaterial({ color: "#ffe3a8", transparent: true, opacity: 0, depthWrite: false })),
    nightMetal: own(new MeshStandardMaterial({ color: "#3c4b53", roughness: 0.5, metalness: 0.5, transparent: true, opacity: 0 })),
    star: own(new MeshBasicMaterial({ color: "#ffd56b" })),
    seal: own(new MeshBasicMaterial({ color: "#e0584f" })),
    light0: own(new MeshBasicMaterial({ color: "#ffcf7a" })),
    light1: own(new MeshBasicMaterial({ color: "#ff9f8a" })),
    light2: own(new MeshBasicMaterial({ color: "#9fe0ff" })),
    light3: own(new MeshBasicMaterial({ color: "#c8a8ff" })),
    path: own(solidMaterial("#e7d9b9", 0.95)),
    plaza: own(solidMaterial("#efe5cd", 0.9)),
    plazaInner: own(solidMaterial("#e2d3b3", 0.9)),
    tileAgent: own(solidMaterial("#a2d985", 0.95)),
    tileBot: own(solidMaterial("#98d07c", 0.95)),
    tileEmpty: own(solidMaterial("#b3d79c", 0.95)),
    tileEdge: own(solidMaterial("#79b35f", 0.95)),
    playTile: own(solidMaterial("#f3d9a4", 0.95)),
  };
  const kit = new Kit(materials);
  const box = own(new RoundedBoxGeometry(1, 1, 1, 2, 0.12));
  const cylinder = own(new CylinderGeometry(0.5, 0.5, 1, 12));
  const cone = own(new ConeGeometry(0.5, 1, 9));
  const ball = own(new IcosahedronGeometry(0.5, 1));
  const rock = own(new IcosahedronGeometry(0.5, 0));
  const seats: Seat[] = [];
  const solids: Solid[] = [];
  const lighting = new NightLighting();
  const lightPools: LightPool[] = [];
  const nightFixtures = new Kit(materials);
  disposables.push(lighting);
  group.add(lighting.group);

  // The honeycomb. Every cell of every ring up to the outermost in use is a
  // path-coloured hexagon, and on it a tile a little smaller: the gaps are
  // the paths between plots. A plot's tile is a shade of green by who lives
  // there; a cell nobody has yet is a paler, bare tile.
  const hex = own(new CylinderGeometry(1, 1, 1, 6));
  const bevel = own(new CylinderGeometry(0.97, 1, 1, 6));
  const outermost = Math.max(2, ...plots.map((plot) => plot.ring));
  const owners = new Map(plots.map((plot) => [`${plot.q},${plot.r}`, plot]));
  const playCell = `${PLAYGROUND_CELL.q},${PLAYGROUND_CELL.r}`;
  for (let k = 0; k <= outermost; k++) {
    for (const [q, r] of ringCells(k)) {
      const c = cellCenter(q, r);
      kit.add("path", hex, c.x, 0.01, c.z, { sx: CELL - 0.02, sy: 0.02, sz: CELL - 0.02 });
      if (k === 0) continue;
      const plot = owners.get(`${q},${r}`);
      const tone = `${q},${r}` === playCell ? "playTile"
        : !plot ? "tileEmpty" : plot.owner.kind === "agent" ? "tileAgent" : "tileBot";
      kit.add("tileEdge", hex, c.x, TILE_TOP / 2 - 0.005, c.z, { sx: TILE, sy: TILE_TOP - 0.01, sz: TILE });
      kit.add(tone, bevel, c.x, TILE_TOP / 2 + 0.005, c.z, { sx: TILE - 0.08, sy: TILE_TOP - 0.01, sz: TILE - 0.08 });
    }
  }
  // The plaza: the centre cell, paved, with a ring of darker stone inside.
  kit.add("plaza", bevel, 0, TILE_TOP / 2, 0, { sx: CELL - 0.45, sy: TILE_TOP, sz: CELL - 0.45 });
  kit.add("plazaInner", hex, 0, TILE_TOP + 0.004, 0, { sx: 3.4, sy: 0.01, sz: 3.4 });

  // The playground, on its own cell next to the plaza.
  const playAt = cellCenter(PLAYGROUND_CELL.q, PLAYGROUND_CELL.r);
  const playground = buildPlayground({ x: playAt.x, z: playAt.z, facing: facingFor(playAt.x, playAt.z), shadows: opts.shadows });
  group.add(playground.group);

  // The wish tree: a pine on a stone planter, its lights in a spiral.
  const top = TILE_TOP;
  kit.add("stone", cylinder, 0, top + 0.25, 0, { sx: 3.0, sy: 0.5, sz: 3.0 });
  kit.add("trunk", cylinder, 0, top + 1.0, 0, { sx: 0.6, sy: 1.6, sz: 0.6 });
  const tiers = [[1.5, 3.6, 2.2], [2.7, 2.9, 1.9], [3.8, 2.2, 1.6], [4.8, 1.5, 1.3]];
  tiers.forEach(([y, w, h], i) => kit.add(i % 2 ? "pineLight" : "pine", cone, 0, top + y + h / 2, 0, { sx: w, sy: h, sz: w }));
  kit.add("star", ball, 0, top + 6.35, 0, { sx: 0.5, sy: 0.5, sz: 0.5 });
  solids.push({ cx: 0, cz: 0, hx: 1.6, hz: 1.6, yaw: 0 });
  const lightBall = own(new SphereGeometry(0.07, 8, 6));
  for (let k = 0; k < 44; k++) {
    const t = k / 44;
    const y = top + 1.6 + t * 4.4;
    const r = (1 - t) * 1.65 + 0.2;
    const a = t * Math.PI * 9;
    kit.add(`light${k % 4}`, lightBall, Math.sin(a) * r, y, Math.cos(a) * r);
  }

  // Wish letters hang round the lower tiers, one for each open wish.
  const letters = new Group();
  const envelope = own(new RoundedBoxGeometry(0.36, 0.25, 0.05, 1, 0.02));
  const sealGeometry = own(new SphereGeometry(0.045, 8, 6));
  const string = own(new CylinderGeometry(0.008, 0.008, 0.3, 4));
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2 + 0.3;
    const y = top + 2.0 + (k % 3) * 0.75;
    const r = 1.95 - (k % 3) * 0.35;
    const letter = new Group();
    letter.position.set(Math.sin(a) * r, y, Math.cos(a) * r);
    letter.rotation.y = a;
    const body = new Mesh(envelope, materials.paper);
    body.position.y = -0.18;
    const sealMesh = new Mesh(sealGeometry, materials.seal);
    sealMesh.position.set(0, -0.18, 0.03);
    const hang = new Mesh(string, materials.darkWood);
    hang.position.y = 0.0;
    letter.add(body, sealMesh, hang);
    letter.visible = false;
    letter.userData.swing = k * 1.7;
    letters.add(letter);
  }
  group.add(letters);

  // Six benches round the tree, one along each edge of the plaza, facing
  // it, two places on each.
  for (let k = 0; k < 6; k++) {
    const toward = (k * Math.PI) / 3;
    const r = 4.5;
    const cx = Math.cos(toward) * r;
    const cz = Math.sin(toward) * r;
    const face = Math.atan2(-cx, -cz);
    kit.addAt(cx, cz, face, "wood", box, 0, top + 0.27, 0, { sx: 1.9, sy: 0.08, sz: 0.5 });
    kit.addAt(cx, cz, face, "wood", box, 0, top + 0.55, -0.24, { sx: 1.9, sy: 0.32, sz: 0.07 });
    for (const x of [-0.8, 0.8]) kit.addAt(cx, cz, face, "darkWood", box, x, top + 0.13, 0, { sx: 0.1, sy: 0.26, sz: 0.44 });
    solids.push({ cx, cz, hx: 0.95, hz: 0.3, yaw: face });
    for (const side of [-0.45, 0.45]) {
      const sx = cx + Math.cos(face) * side;
      const sz = cz - Math.sin(face) * side;
      seats.push({ key: `plaza:${k}:${side}`, kind: "seat", x: sx, z: sz, y: top + 0.3, face, plot: null, name: "a bench" });
    }
  }

  // A lamp post at each corner of the plaza; their lanterns glow at night.
  const lanterns: Mesh[] = [];
  for (let k = 0; k < 6; k++) {
    const corner = Math.PI / 6 + (k * Math.PI) / 3;
    const r = PLAZA_RADIUS - 1.3;
    const x = Math.cos(corner) * r;
    const z = Math.sin(corner) * r;
    kit.add("metal", cylinder, x, top + 1.1, z, { sx: 0.12, sy: 2.2, sz: 0.12 });
    kit.add("metal", box, x, top + 2.28, z, { sx: 0.34, sy: 0.08, sz: 0.34 });
    const lantern = new Mesh(box, materials.lamp);
    lantern.scale.set(0.26, 0.3, 0.26);
    lantern.position.set(x, top + 2.1, z);
    lanterns.push(lantern);
    group.add(lantern);
    lightPools.push({ x, y: top + 0.016, z, width: 5.6, depth: 5.6 });
    solids.push({ cx: x, cz: z, hx: 0.15, hz: 0.15, yaw: 0 });
  }

  // The dock, on the side away from the first ring's first plot.
  const dockAngle = Math.PI + 0.35;
  const dockFrom = radius - 4;
  const dockTo = radius + 9;
  const dockMid = (dockFrom + dockTo) / 2;
  const dx = Math.sin(dockAngle);
  const dz = Math.cos(dockAngle);
  kit.add("wood", box, dx * dockMid, 0.12, dz * dockMid, { sx: 2.2, sy: 0.14, sz: dockTo - dockFrom, ry: dockAngle });
  for (let d = dockFrom + 1; d <= dockTo; d += 2.2) {
    for (const side of [-1.15, 1.15]) {
      const px = dx * d + Math.cos(dockAngle) * side;
      const pz = dz * d - Math.sin(dockAngle) * side;
      kit.add("darkWood", cylinder, px, -0.4, pz, { sx: 0.18, sy: 1.3, sz: 0.18 });
    }
  }
  // A little boat moored at its end.
  const boatAt = dockTo + 1.6;
  const bx = dx * boatAt + Math.cos(dockAngle) * 2.2;
  const bz = dz * boatAt - Math.sin(dockAngle) * 2.2;
  kit.add("white", box, bx, SEA_LEVEL + 0.25, bz, { sx: 1.5, sy: 0.6, sz: 3.6, ry: dockAngle });
  kit.add("red", box, bx, SEA_LEVEL + 0.42, bz, { sx: 1.56, sy: 0.1, sz: 3.66, ry: dockAngle });
  kit.add("blue", box, bx + dx * 0.3, SEA_LEVEL + 0.85, bz + dz * 0.3, { sx: 1.0, sy: 0.6, sz: 1.2, ry: dockAngle });
  const dock = { x: dx * (dockTo - 1), z: dz * (dockTo - 1), face: dockAngle + Math.PI };
  const walkways: Solid[] = [{ cx: dx * dockMid, cz: dz * dockMid, hx: 0.9, hz: (dockTo - dockFrom) / 2, yaw: dockAngle }];
  // Reuse the dock's existing posts, and the plot signposts below, as lamps.
  // Extra fixtures are night-only so the original daytime view stays intact.
  for (const d of [dockFrom + 1, dockFrom + 5.4, dockFrom + 9.8]) {
    const x = dx * d + Math.cos(dockAngle) * 1.15;
    const z = dz * d - Math.sin(dockAngle) * 1.15;
    nightFixtures.add("nightMetal", cylinder, x, 0.55, z, { sx: 0.08, sy: 0.6, sz: 0.08 });
    nightFixtures.add("nightLamp", ball, x, 0.91, z, { sx: 0.24, sy: 0.3, sz: 0.24 });
    lightPools.push({ x: dx * d, y: 0.196, z: dz * d, width: 2.1, depth: 2.1 });
  }

  // Palms and rocks on the beach, and a lighthouse.
  const random = (k: number) => noise(k * 1.37, k * 2.11, seed + 99);
  const lighthouseAngle = dockAngle + 1.9;
  const keepClear = (a: number) => {
    const near = (b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 0.18;
    return near(dockAngle) || near(lighthouseAngle);
  };
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 2 + random(k) * 0.3;
    if (keepClear(a)) continue;
    const r = radius - 2.6 + random(k + 40) * 1.2;
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    const lean = (random(k + 80) - 0.5) * 0.5;
    const h = 3.4 + random(k + 20) * 1.6;
    for (let s = 0; s < 5; s++) {
      const t = s / 5;
      kit.add("trunk", cylinder, x + Math.sin(a) * lean * t * h * 0.4, t * h + h / 10, z + Math.cos(a) * lean * t * h * 0.4,
        { sx: 0.32 - t * 0.1, sy: h / 5 + 0.05, sz: 0.32 - t * 0.1 });
    }
    const topX = x + Math.sin(a) * lean * h * 0.4;
    const topZ = z + Math.cos(a) * lean * h * 0.4;
    for (let l = 0; l < 6; l++) {
      const la = (l / 6) * Math.PI * 2 + k;
      kit.add(l % 2 ? "leaf" : "leafLight", cone, topX + Math.sin(la) * 0.9, h + 0.05, topZ + Math.cos(la) * 0.9,
        { sx: 0.5, sy: 2.0, sz: 0.18, rx: Math.PI / 2 - 0.35, ry: la });
    }
    kit.add("leafLight", ball, topX, h + 0.2, topZ, { sx: 0.6, sy: 0.4, sz: 0.6 });
    solids.push({ cx: x, cz: z, hx: 0.3, hz: 0.3, yaw: 0 });
  }
  for (let k = 0; k < 10; k++) {
    const a = random(k + 200) * Math.PI * 2;
    if (keepClear(a)) continue;
    const r = radius - 1.2 + random(k + 220) * 2.2;
    const s = 0.4 + random(k + 240) * 0.8;
    kit.add("rock", rock, Math.sin(a) * r, groundHeight(r, radius) + s * 0.25, Math.cos(a) * r, { sx: s * 1.3, sy: s, sz: s, ry: k });
    if (r < radius - 1) solids.push({ cx: Math.sin(a) * r, cz: Math.cos(a) * r, hx: s * 0.6, hz: s * 0.6, yaw: 0 });
  }
  const lx = Math.sin(lighthouseAngle) * (radius - 2.4);
  const lz = Math.cos(lighthouseAngle) * (radius - 2.4);
  kit.add("stone", cylinder, lx, 0.3, lz, { sx: 2.6, sy: 0.6, sz: 2.6 });
  for (let s = 0; s < 5; s++) kit.add(s % 2 ? "red" : "white", cylinder, lx, 0.6 + s * 1.1 + 0.55, lz, { sx: 1.7 - s * 0.14, sy: 1.1, sz: 1.7 - s * 0.14 });
  kit.add("metal", cylinder, lx, 6.7, lz, { sx: 1.3, sy: 0.15, sz: 1.3 });
  kit.add("red", cone, lx, 7.75, lz, { sx: 1.2, sy: 0.7, sz: 1.2 });
  const beacon = new Mesh(box, materials.lamp);
  beacon.scale.set(0.8, 0.8, 0.8);
  beacon.position.set(lx, 7.15, lz);
  group.add(beacon);
  lanterns.push(beacon);
  solids.push({ cx: lx, cz: lz, hx: 1.4, hz: 1.4, yaw: 0 });

  // A sign with its owner's name at the front corner of each plot's tile,
  // by the path.
  const signBoard = own(new PlaneGeometry(1.1, 0.42));
  for (const plot of plots) {
    const names = plotNames(plot, opts.residents);
    if (!names) continue;
    const front = (plot.radius * Math.sqrt(3)) / 2;
    const corner = plotToWorld(plot, -plot.radius / 2 + 0.2, front - 0.45);
    const yaw = (plot.facing * Math.PI) / 180;
    kit.add("darkWood", box, corner.x, top + 0.45, corner.z, { sx: 0.1, sy: 0.9, sz: 0.1 });
    kit.add("wood", box, corner.x, top + 0.95, corner.z, { sx: 1.2, sy: 0.5, sz: 0.08, ry: yaw });
    nightFixtures.add("nightLamp", ball, corner.x, top + 1.3, corner.z, { sx: 0.26, sy: 0.2, sz: 0.26 });
    const path = plotToWorld(plot, -plot.radius / 2 + 0.2, front + 0.6);
    lightPools.push({ x: path.x, y: 0.036, z: path.z, width: 6.5, depth: 6.5 });
    const texture = nameTexture(names);
    if (texture) {
      own(texture);
      const signMaterial = own(new MeshBasicMaterial({ map: texture, side: DoubleSide }));
      const sign = new Mesh(signBoard, signMaterial);
      sign.position.set(corner.x + Math.sin(yaw) * 0.05, top + 0.95, corner.z + Math.cos(yaw) * 0.05);
      sign.rotation.y = yaw;
      group.add(sign);
    }
    solids.push({ cx: corner.x, cz: corner.z, hx: 0.15, hz: 0.15, yaw: 0 });
  }

  const built = kit.build(opts.shadows);
  built.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.geometry) own(mesh.geometry);
  });
  group.add(built);
  lighting.replace(lightPools);
  const fixtures = nightFixtures.build(false);
  fixtures.name = "night-lanterns";
  fixtures.visible = false;
  fixtures.traverse(object => {
    const mesh = object as Mesh;
    if (mesh.geometry) own(mesh.geometry);
  });
  group.add(fixtures);

  const night = new Color("#ffe3a8");
  const day = new Color("#fff3d6");
  const lampMaterial = materials.lamp as MeshBasicMaterial;
  solids.push(...playground.solids);
  seats.push(...playground.seats);
  disposables.push(playground);
  return {
    group, seats, solids, dock, walkways, deck: 0.19, playground,
    update(t, nightness, colors, seaColor) {
      water.time.value = t;
      skyDome.top.copy(colors.top);
      skyDome.horizon.copy(colors.horizon);
      water.material.color.copy(seaColor);
      foamMaterial.opacity = 0.22 + Math.sin(t * 0.9) * 0.08;
      lampMaterial.color.copy(day).lerp(night, nightness).multiplyScalar(0.75 + nightness * 0.5);
      lighting.update(nightness);
      fixtures.visible = nightness > 0;
      (materials.nightLamp as MeshBasicMaterial).opacity = nightness;
      (materials.nightMetal as MeshStandardMaterial).opacity = nightness;
      for (const letter of letters.children) {
        if (!letter.visible) continue;
        letter.rotation.z = Math.sin(t * 1.3 + (letter.userData.swing as number)) * 0.08;
      }
    },
    setLetters(count) {
      letters.children.forEach((letter, k) => { letter.visible = k < count; });
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };
}

/** Is a point on one of these rectangles? */
export function onRect(x: number, z: number, rects: readonly Solid[]): boolean {
  return rects.some((r) => {
    const dx = x - r.cx;
    const dz = z - r.cz;
    const lx = dx * Math.cos(r.yaw) - dz * Math.sin(r.yaw);
    const lz = dx * Math.sin(r.yaw) + dz * Math.cos(r.yaw);
    return Math.abs(lx) <= r.hx + 0.2 && Math.abs(lz) <= r.hz + 0.2;
  });
}

/** The colours of the hour: sky, sea and how dark it is (0 day … 1 night). */
export function timeOfDay(hour: number): { top: Color; horizon: Color; sea: Color; night: number; sun: Vector3; sunColor: Color; sunIntensity: number; hemi: number } {
  const keys: { h: number; top: string; horizon: string; sea: string; night: number; sun: string; power: number; hemi: number }[] = [
    { h: 0, top: "#0a1631", horizon: "#1c2b52", sea: "#1d3a5c", night: 1, sun: "#9fb6ff", power: 0.35, hemi: 0.55 },
    { h: 5.5, top: "#0e1c3d", horizon: "#2a3966", sea: "#22416a", night: 1, sun: "#9fb6ff", power: 0.35, hemi: 0.55 },
    { h: 6.6, top: "#5a78b8", horizon: "#ffc6a6", sea: "#4f8fb4", night: 0.4, sun: "#ffc59a", power: 1.6, hemi: 1.0 },
    { h: 8, top: "#79b8f0", horizon: "#e8f3fb", sea: "#5fbcd8", night: 0, sun: "#fff4e2", power: 2.7, hemi: 1.45 },
    { h: 17.2, top: "#79b8f0", horizon: "#e8f3fb", sea: "#5fbcd8", night: 0, sun: "#fff4e2", power: 2.7, hemi: 1.45 },
    { h: 18.8, top: "#5866b0", horizon: "#ffb487", sea: "#4a83ad", night: 0.35, sun: "#ffad7a", power: 1.6, hemi: 1.0 },
    { h: 20.3, top: "#13224a", horizon: "#3a3f6e", sea: "#244468", night: 0.9, sun: "#9fb6ff", power: 0.45, hemi: 0.6 },
    { h: 24, top: "#0a1631", horizon: "#1c2b52", sea: "#1d3a5c", night: 1, sun: "#9fb6ff", power: 0.35, hemi: 0.55 },
  ];
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].h <= h) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const t = smooth(0, 1, (h - a.h) / Math.max(0.0001, b.h - a.h));
  const mix = (x: string, y: string) => new Color(x).lerp(new Color(y), t);
  // The sun rises in the east and crosses; at night the moon stands high
  // and pale on the other side.
  const day = h >= 6 && h <= 19.5;
  const arc = day ? (h - 6) / 13.5 : ((h + 24 - 19.5) % 24) / 10.5;
  const angle = arc * Math.PI;
  const sun = new Vector3(Math.cos(angle) * 60, Math.max(12, Math.sin(angle) * 80), day ? -35 : 35);
  return {
    top: mix(a.top, b.top), horizon: mix(a.horizon, b.horizon), sea: mix(a.sea, b.sea),
    night: a.night + (b.night - a.night) * t,
    sun, sunColor: mix(a.sun, b.sun), sunIntensity: a.power + (b.power - a.power) * t, hemi: a.hemi + (b.hemi - a.hemi) * t,
  };
}

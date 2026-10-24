// The island's scenery: the land and its beach, the sea, the sky, the
// honeycomb of plots, and what stands on the island without anyone having
// built it: the plaza with the wish tree, benches and lamps, the dock where
// bots arrive, lollipop trees, rock candy and a peppermint lighthouse.
// Low-poly, flat-shaded and merged by material to keep draw calls low.
import {
  BackSide, BufferAttribute, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, DoubleSide, Group,
  IcosahedronGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, RingGeometry, ShaderMaterial,
  SphereGeometry, SRGBColorSpace, TorusGeometry, Vector3,
} from "three";
import type { Material } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { Kit, solidMaterial } from "./kit";
import { NightLighting, type LightPool } from "./lighting";
import type { Plot, Resident } from "./model";
import { CELL, PLAZA_RADIUS, TILE, TILE_TOP, cellCenter, facingFor, onCellTile, plotNames, plotToWorld, ringCells } from "./model";
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
  grass: new Color("#8fd9a8"),
  grassDark: new Color("#53b781"),
  sand: new Color("#f7c9d4"),
  wetSand: new Color("#eeb3c3"),
  deep: new Color("#c2abd2"),
};

/** The land as one polar mesh: grass, then the beach. The honeycomb lies
 *  on it (`honeycomb`). */
function terrain(radius: number, seed: number, night: { value: number }): Mesh {
  const outer = radius + 14;
  const segments = 128;
  const radii: number[] = [0];
  for (let r = 0.9; r < outer; r += r < radius - 6 ? 1.6 : 0.8) radii.push(r);
  radii.push(outer);
  const positions: number[] = [];
  const colors: number[] = [];
  const nightColors: number[] = [];
  const oldGrass = new Color("#b5e4ce"), oldDark = new Color("#efd0dc");
  const oldSand = new Color("#fff0ec"), oldWet = new Color("#e8c9dc");
  const point = (r: number, a: number) => {
    // A ragged shoreline: the beach is wider in some places than others.
    const wobble = r > radius - 7 ? (noise(Math.cos(a) * 3, Math.sin(a) * 3, seed) - 0.5) * 2.2 : 0;
    const rr = r + wobble * smooth(radius - 7, radius, r);
    const x = Math.sin(a) * rr;
    const z = Math.cos(a) * rr;
    const y = groundHeight(r, radius) + (r > radius - 5 && r < radius + 8 ? (noise(x * 0.4, z * 0.4, seed + 7) - 0.5) * 0.12 : 0);
    const color = new Color(), nightColor = new Color();
    if (r < radius - 5.2) {
      const variation = noise(x * 0.15, z * 0.15, seed) * 0.7;
      color.copy(COLORS.grass).lerp(COLORS.grassDark, variation);
      nightColor.copy(oldGrass).lerp(oldDark, variation);
    } else if (r < radius + 0.4) {
      const wet = smooth(radius - 1.5, radius + 0.4, r);
      color.copy(COLORS.sand).lerp(COLORS.wetSand, wet);
      nightColor.copy(oldSand).lerp(oldWet, wet);
    } else {
      const deep = smooth(radius + 0.4, radius + 8, r);
      color.copy(COLORS.wetSand).lerp(COLORS.deep, deep);
      nightColor.copy(oldWet).lerp(COLORS.deep, deep);
    }
    return { p: [x, y, z], c: [color.r, color.g, color.b], n: [nightColor.r, nightColor.g, nightColor.b] };
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
        for (const v of tri) { positions.push(...v.p); colors.push(...c); nightColors.push(...tri[0].n); }
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  geometry.setAttribute("nightColor", new BufferAttribute(new Float32Array(nightColors), 3));
  geometry.computeVertexNormals();
  const material = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 });
  // Preserve the approved night palette on the GPU; no terrain buffer writes per frame.
  material.onBeforeCompile = shader => {
    shader.uniforms.uCandyNight = night;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 nightColor;\nuniform float uCandyNight;")
      .replace("#include <color_vertex>", "#include <color_vertex>\nvColor.rgb = mix(vColor.rgb, nightColor, uCandyNight);");
  };
  const mesh = new Mesh(geometry, material);
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
    color: "#62cfc8", flatShading: true, roughness: 0.32, metalness: 0.08, transparent: true, opacity: 0.88,
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
  const top = new Color("#b9b5ef");
  const horizon = new Color("#ffe1eb");
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

  const terrainNight = { value: 0 };
  const land = terrain(radius, seed, terrainNight);
  (land.material as Material).polygonOffset = true;
  (land.material as Material).polygonOffsetUnits = 2;
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

  // Tune scenery alone under the existing ACES lighting; persona materials stay untouched.
  const dayNight: { material: MeshStandardMaterial; day: Color; night: Color }[] = [];
  const candyMaterial = (day: string, night: string, roughness = 0.95) => {
    const material = own(solidMaterial(day, roughness));
    dayNight.push({ material, day: new Color(day), night: new Color(night) });
    return material;
  };
  const materials: Record<string, Material> = {
    wood: own(solidMaterial("#ce9c78")),
    darkWood: own(solidMaterial("#77505a")),
    leaf: own(solidMaterial("#e9a9cb")),
    leafLight: own(solidMaterial("#bca6e0")),
    pine: own(solidMaterial("#daa0c4")),
    pineLight: own(solidMaterial("#f3bfd8")),
    trunk: own(solidMaterial("#fff0df")),
    rock: own(solidMaterial("#b7a6e6", 0.9)),
    metal: own(solidMaterial("#785c84", 0.5, 0.5)),
    white: own(solidMaterial("#fff6ef", 0.7)),
    red: own(solidMaterial("#e58da9", 0.7)),
    blue: own(solidMaterial("#a3a5df", 0.7)),
    stone: own(solidMaterial("#ead3df", 0.9)),
    paper: own(solidMaterial("#fbf7ee", 0.8)),
    lamp: own(new MeshBasicMaterial({ color: "#ffe3a8" })),
    nightLamp: own(new MeshBasicMaterial({ color: "#ffe3a8", transparent: true, opacity: 0, depthWrite: false })),
    nightMetal: own(new MeshStandardMaterial({ color: "#785c84", roughness: 0.5, metalness: 0.5, transparent: true, opacity: 0 })),
    star: own(new MeshBasicMaterial({ color: "#ffd56b" })),
    seal: own(new MeshBasicMaterial({ color: "#e0584f" })),
    light0: own(new MeshBasicMaterial({ color: "#ffcf7a" })),
    light1: own(new MeshBasicMaterial({ color: "#ff9f8a" })),
    light2: own(new MeshBasicMaterial({ color: "#9fe0ff" })),
    light3: own(new MeshBasicMaterial({ color: "#c8a8ff" })),
    path: candyMaterial("#edb0c4", "#fff0e7"),
    plaza: candyMaterial("#f1bdd3", "#f8dce8", 0.9),
    plazaInner: candyMaterial("#df9fc5", "#edd1e2", 0.9),
    tileAgent: candyMaterial("#80d9a6", "#b8e1cd"),
    tileBot: candyMaterial("#f1b2cf", "#ecd1de"),
    tileEmpty: candyMaterial("#9bd9b1", "#cce8da"),
    tileLemon: candyMaterial("#edda8b", "#cce8da"),
    tileLilac: candyMaterial("#c7a5e2", "#cce8da"),
    tileEdge: candyMaterial("#dd85aa", "#a4caba"),
    cocoa: own(solidMaterial("#80525b", 0.32)),
    caramel: own(solidMaterial("#e6bb8c")),
    mint: own(solidMaterial("#a4ddcf")),
    playTile: own(solidMaterial("#f4d8e9", 0.95)),
    lemon: own(solidMaterial("#efd17e")),
  };
  // The 1 cm icing layers share depth values at whole-island zoom. Pull the
  // icing forward in order; pushing paths back would bury them under grass.
  for (const [key, offset] of [["tileEdge", -1], ["plaza", -1], ["plazaInner", -2],
    ["tileAgent", -2], ["tileBot", -2], ["tileEmpty", -2], ["tileLemon", -2],
    ["tileLilac", -2], ["playTile", -2]] as const) {
    const material = materials[key];
    material.polygonOffset = true;
    material.polygonOffsetFactor = offset;
    material.polygonOffsetUnits = offset * 2;
  }
  const kit = new Kit(materials);
  const box = own(new RoundedBoxGeometry(1, 1, 1, 2, 0.12));
  const cylinder = own(new CylinderGeometry(0.5, 0.5, 1, 12));
  const cone = own(new ConeGeometry(0.5, 1, 9));
  const ball = own(new IcosahedronGeometry(0.5, 1));
  const crystal = own(new ConeGeometry(0.5, 1, 5));
  const donut = own(new TorusGeometry(1.15, 0.38, 6, 24));
  const seats: Seat[] = [];
  const solids: Solid[] = [];
  const lighting = new NightLighting();
  const lightPools: LightPool[] = [];
  const nightFixtures = new Kit(materials);
  disposables.push(lighting);
  group.add(lighting.group);

  // The honeycomb. Every cell of every ring up to the outermost in use is a
  // path-coloured hexagon, and on it a tile a little smaller: the gaps are
  // the paths between plots. Occupied tiles keep their owner-kind tint;
  // empty cells alternate mint, lemon and lilac with a strawberry icing edge.
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
        : !plot ? ["tileEmpty", "tileLemon", "tileLilac"][((q - r) % 3 + 3) % 3] : plot.owner.kind === "agent" ? "tileAgent" : "tileBot";
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

  // The strawberry-frosted wish tree keeps its letters and familiar silhouette.
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
    kit.addAt(cx, cz, face, k % 3 === 0 ? "red" : k % 3 === 1 ? "mint" : "leafLight", box, 0, top + 0.55, -0.24, { sx: 1.9, sy: 0.32, sz: 0.07 });
    for (const x of [-0.8, 0.8]) kit.addAt(cx, cz, face, "darkWood", box, x, top + 0.13, 0, { sx: 0.1, sy: 0.26, sz: 0.44 });
    solids.push({ cx, cz, hx: 0.95, hz: 0.3, yaw: face });
    for (const side of [-0.45, 0.45]) {
      const sx = cx + Math.cos(face) * side;
      const sz = cz - Math.sin(face) * side;
      seats.push({ key: `plaza:${k}:${side}`, kind: "seat", x: sx, z: sz, y: top + 0.3, face, plot: null, name: "a bench" });
    }
  }

  // Existing plaza lamps become striped candy canes; their pools still fade at dusk.
  const lanterns: Mesh[] = [];
  for (let k = 0; k < 6; k++) {
    const corner = Math.PI / 6 + (k * Math.PI) / 3;
    const r = PLAZA_RADIUS - 1.3;
    const x = Math.cos(corner) * r;
    const z = Math.sin(corner) * r;
    for (let band = 0; band < 10; band++) {
      kit.add(band % 2 ? "red" : "white", cylinder, x, top + 0.11 + band * 0.22, z, { sx: 0.16, sy: 0.22, sz: 0.16 });
    }
    kit.add("white", donut, x + 0.21, top + 2.14, z, { sx: 0.2, sy: 0.2, sz: 0.2 });
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

  // Scenery lives in the coast belt, outside every plot and both reserved
  // cells. Check the full footprint, including crown overhang, before adding.
  const random = (k: number) => noise(k * 1.37, k * 2.11, seed + 99);
  const lighthouseAngle = dockAngle + 1.9;
  const coastClear = (x: number, z: number, reach: number) => {
    if (Math.hypot(x, z) < CELL + reach + 0.5) return false;
    if (Math.hypot(x - playAt.x, z - playAt.z) < CELL + reach + 0.5) return false;
    return plots.every(p => Math.hypot(x - p.x, z - p.z) > p.radius + reach + 0.8);
  };
  // Bury coastal supports below the lowest beach under their full footprint.
  // Include the terrain's 1.1 m shoreline wobble and 0.06 m height noise.
  const coastBottom = (x: number, z: number, reach: number) =>
    groundHeight(Math.hypot(x, z) + reach + 1.1, radius) - 0.12;
  // Hex vertices leave triangular pockets between tiles. Keep the full candy
  // footprint off every tile and both reserved cells, leaving the path middles open.
  const inlandSites = new Set<string>();
  for (let ring = 1; ring <= outermost; ring++) for (const [q, r] of ringCells(ring)) {
    const c = cellCenter(q, r);
    for (let corner = 0; corner < 6; corner++) {
      const a = corner * Math.PI / 3;
      const x = c.x + Math.sin(a) * CELL, z = c.z + Math.cos(a) * CELL;
      const key = `${Math.round(x * 100)},${Math.round(z * 100)}`;
      if (inlandSites.has(key) || Math.hypot(x, z) > radius - 8) continue;
      inlandSites.add(key);
      if (onCellTile(x, z, TILE + 0.55)
        || Math.hypot(x, z) < CELL + 0.8
        || Math.hypot(x - playAt.x, z - playAt.z) < CELL + 0.8) continue;
      const lollipop = inlandSites.size % 3 === 0;
      const tone = ["red", "leafLight", "lemon", "mint"][inlandSites.size % 4];
      if (lollipop) {
        kit.add("white", cylinder, x, 0.6, z, { sx: 0.11, sy: 1.2, sz: 0.11 });
        kit.add(tone, ball, x, 1.28, z, { sx: 0.85, sy: 0.85, sz: 0.5 });
        kit.add("white", ball, x, 1.28, z + 0.22, { sx: 0.33, sy: 0.33, sz: 0.1 });
      } else {
        kit.add(tone, ball, x, 0.33, z, { sx: 0.85, sy: 1.0, sz: 0.85 });
        kit.add("white", ball, x - 0.12, 0.62, z + 0.14, { sx: 0.13, sy: 0.07, sz: 0.13 });
      }
      solids.push({ cx: x, cz: z, hx: 0.43, hz: 0.43, yaw: 0 });
    }
  }
  const rainbowAngle = -0.2;
  const keepClear = (a: number) => {
    const near = (b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 0.2;
    return near(rainbowAngle) || near(dockAngle) || near(lighthouseAngle) || near(0.65) || near(1.55);
  };
  for (let k = 0; k < 22; k++) {
    const a = (k / 22) * Math.PI * 2 + random(k) * 0.18;
    if (keepClear(a)) continue;
    const r = radius - 2.8 + random(k + 40) * 0.8;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!coastClear(x, z, 1.2)) continue;
    const h = 2.8 + random(k + 20) * 1.4;
    const y = groundHeight(r, radius);
    const bottom = coastBottom(x, z, 0.11), poleTop = y + h;
    kit.add("white", cylinder, x, (bottom + poleTop) / 2, z, { sx: 0.22, sy: poleTop - bottom, sz: 0.22 });
    // Flat candy discs, with a smaller frosting face and a sugar centre.
    kit.addAt(x, z, a, k % 2 ? "leaf" : "leafLight", cylinder, 0, y + h, 0,
      { sx: 2.1, sy: 0.38, sz: 2.1, rx: Math.PI / 2 });
    kit.addAt(x, z, a, "white", donut, 0, y + h, 0.22, { sx: 0.55, sy: 0.55, sz: 0.25 });
    kit.addAt(x, z, a, "caramel", ball, 0, y + h, 0.24, { sx: 0.28, sy: 0.28, sz: 0.16 });
    solids.push({ cx: x, cz: z, hx: 0.24, hz: 0.24, yaw: 0 });
    // Low gumdrops have their own footprint rather than sharing the stick's.
    const gx = x + Math.cos(a) * 1.3, gz = z - Math.sin(a) * 1.3;
    if (coastClear(gx, gz, 0.6)) {
      kit.add(k % 2 ? "mint" : "leaf", ball, gx, y + 0.32, gz, { sx: 1.0, sy: 0.95, sz: 1.0 });
      solids.push({ cx: gx, cz: gz, hx: 0.5, hz: 0.5, yaw: 0 });
    }
  }
  for (let k = 0; k < 16; k++) {
    const a = random(k + 200) * Math.PI * 2;
    if (keepClear(a)) continue;
    const r = radius - 2 + random(k + 220) * 1.2;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!coastClear(x, z, 0.85)) continue;
    const h = 0.7 + random(k + 240) * 1.2;
    for (let c = 0; c < 3; c++) {
      kit.add(c % 2 ? "mint" : "rock", crystal, x + (c - 1) * 0.32, groundHeight(r, radius) + h / 2, z,
        { sx: 0.55, sy: h * (c === 1 ? 1.3 : 0.8), sz: 0.6, rz: (c - 1) * 0.22, ry: k });
    }
    solids.push({ cx: x, cz: z, hx: 0.8, hz: 0.45, yaw: 0 });
  }

  // The dock's gingerbread gate: two solid piers, a high icing lintel,
  // and the original 2.2 m path kept open between them.
  const gateD = radius - 1.8;
  const gateX = dx * gateD, gateZ = dz * gateD;
  if (coastClear(gateX, gateZ, 2.8)) {
    for (const side of [-1.8, 1.8]) {
      const px = gateX + Math.cos(dockAngle) * side, pz = gateZ - Math.sin(dockAngle) * side;
      const bottom = coastBottom(px, pz, Math.hypot(0.425, 0.45));
      kit.addAt(gateX, gateZ, dockAngle, "caramel", box, side, (4.2 + bottom) / 2, 0, { sx: 0.85, sy: 4.2 - bottom, sz: 0.9 });
      for (let i = 0; i < 5; i++) kit.addAt(gateX, gateZ, dockAngle, "white", ball, side, 0.7 + i * 0.7, 0.48, { sx: 0.2, sy: 0.2, sz: 0.12 });
      solids.push({ cx: gateX + Math.cos(dockAngle) * side, cz: gateZ - Math.sin(dockAngle) * side, hx: 0.45, hz: 0.5, yaw: dockAngle });
    }
    kit.addAt(gateX, gateZ, dockAngle, "caramel", box, 0, 4.2, 0, { sx: 4.6, sy: 0.8, sz: 0.9 });
    kit.addAt(gateX, gateZ, dockAngle, "white", box, 0, 4.65, 0, { sx: 4.7, sy: 0.16, sz: 0.98 });
    kit.addAt(gateX, gateZ, dockAngle, "red", ball, 0, 4.3, 0.5, { sx: 0.62, sy: 0.62, sz: 0.18 });
  }

  // A low-poly rainbow spans the coastal path. Only the two candy feet are
  // nav solids: the high bands must never seal the walkable opening.
  const rainbowR = radius - 3;
  const rx = Math.sin(rainbowAngle) * rainbowR, rz = Math.cos(rainbowAngle) * rainbowR;
  if (coastClear(rx, rz, 5.5)) {
    for (let band = 0; band < 5; band++) {
      const arc = own(new TorusGeometry(3.4 + band * 0.42, 0.24, 4, 20, Math.PI));
      kit.addAt(rx, rz, rainbowAngle, ["mint", "blue", "leafLight", "lemon", "red"][band], arc, 0, 0.4, 0);
    }
    for (const side of [-4.25, 4.25]) {
      const fx = rx + Math.cos(rainbowAngle) * side, fz = rz - Math.sin(rainbowAngle) * side;
      const bottom = coastBottom(fx, fz, 1.05);
      kit.addAt(rx, rz, rainbowAngle, "white", ball, side, (0.75 + bottom) / 2, 0, { sx: 2.1, sy: 0.75 - bottom, sz: 1.4 });
      solids.push({ cx: rx + Math.cos(rainbowAngle) * side, cz: rz - Math.sin(rainbowAngle) * side,
        hx: 1.1, hz: 0.7, yaw: rainbowAngle });
    }
  }

  // Larger destination sculptures, on unclaimed shoreline only.
  for (const [a, kind] of [[0.65, "donut"], [1.55, "fountain"]] as const) {
    const r = radius - 3.0, x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!coastClear(x, z, 2.9)) continue;
    const y = groundHeight(r, radius);
    const bottom = coastBottom(x, z, 2.55), baseTop = y + 0.27;
    kit.add("white", cylinder, x, (baseTop + bottom) / 2, z, { sx: 5.1, sy: baseTop - bottom, sz: 5.1 });
    solids.push({ cx: x, cz: z, hx: 2.6, hz: 2.6, yaw: 0 });
    if (kind === "donut") {
      kit.addAt(x, z, a, "caramel", donut, 0, y + 2.55, 0, { sx: 1.65, sy: 1.65, sz: 1.65 });
      kit.addAt(x, z, a, "red", donut, 0, y + 2.55, 0.3, { sx: 1.62, sy: 1.62, sz: 1.05 });
      for (let i = 0; i < 12; i++) {
        const t = i * Math.PI / 6;
        kit.addAt(x, z, a, i % 2 ? "white" : "mint", box, Math.sin(t) * 1.92, y + 2.55 + Math.cos(t) * 1.92, 0.74,
          { sx: 0.14, sy: 0.33, sz: 0.1, rz: t + 0.4 });
      }
    } else {
      kit.add("caramel", cylinder, x, y + 0.55, z, { sx: 4.5, sy: 0.7, sz: 4.5 });
      kit.add("cocoa", cylinder, x, y + 0.92, z, { sx: 4.1, sy: 0.08, sz: 4.1 });
      for (let tier = 0; tier < 3; tier++) {
        const w = 2.7 - tier * 0.78;
        kit.add("cocoa", cone, x, y + 1.35 + tier * 0.85, z, { sx: w, sy: 1.1, sz: w });
      }
      kit.add("white", ball, x, y + 3.8, z, { sx: 0.6, sy: 0.5, sz: 0.6 });
      lightPools.push({ x, y: y + 0.25, z, width: 3.5, depth: 3.5 });
    }
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

  // Sugar-cloud mini-islands over the sea: bake all coloured pieces into
  // one vertex-colour mesh. The entire cluster bobs with one transform.
  const floatingPieces: BufferGeometry[] = [];
  const sugarPiece = (shape: BufferGeometry, color: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, flip = false) => {
    const piece = shape.index ? shape.toNonIndexed() : shape.clone();
    piece.deleteAttribute("uv");
    piece.scale(sx, sy, sz);
    if (flip) piece.rotateX(Math.PI);
    piece.translate(x, y, z);
    const tint = new Color(color), count = piece.getAttribute("position").count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { colors[i * 3] = tint.r; colors[i * 3 + 1] = tint.g; colors[i * 3 + 2] = tint.b; }
    piece.setAttribute("color", new BufferAttribute(colors, 3));
    floatingPieces.push(piece);
  };
  for (let i = 0; i < 3; i++) {
    const a = -0.26 + i * 0.25, r = radius + 13 + i % 2 * 4;
    const x = Math.sin(a) * r, z = Math.cos(a) * r, y = 9 + i % 2 * 4;
    sugarPiece(cone, "#ba91d7", x, y - 1, z, 6, 3, 4.8, true);
    for (let puff = 0; puff < 4; puff++) sugarPiece(ball, puff % 2 ? "#f3b6d3" : "#b0e6c5",
      x + (puff - 1.5) * 1.55, y + puff % 2 * 0.5, z, 3.5, 1.5, 3.8);
    sugarPiece(cylinder, "#fff0ce", x, y + 1.6, z, 0.2, 2.2, 0.2);
    sugarPiece(ball, ["#ea93b6", "#b49cdd", "#efd17d"][i], x, y + 3, z, 1.8, 1.8, 1.2);
  }
  const floatingGeometry = own(mergeGeometries(floatingPieces, false)!);
  floatingPieces.forEach(piece => piece.dispose());
  const floating = new Mesh(floatingGeometry, own(new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 })));
  floating.name = "floating-sugar-islands";
  group.add(floating);

  // Cotton-candy clouds are two merged meshes, drifting as one group.
  // Stars share a third mesh and fade with the same clock as the lamps.
  const cloudWhite = own(solidMaterial("#fff1f4"));
  const cloudPink = own(solidMaterial("#f0c0da"));
  const starMaterial = own(new MeshBasicMaterial({ color: "#fff1de", transparent: true, opacity: 0, depthWrite: false, fog: false }));
  const cloudKit = new Kit({ white: cloudWhite, pink: cloudPink });
  for (let c = 0; c < 7; c++) {
    const a = c * Math.PI * 2 / 7;
    const r = radius + 13 + (c % 2) * 8;
    for (let puff = 0; puff < 5; puff++) {
      cloudKit.add(puff % 3 ? "white" : "pink", ball,
        Math.sin(a) * r + (puff - 2) * 2.1, 14 + c % 3 * 2 + (puff % 2) * 0.9, Math.cos(a) * r,
        { sx: 5.2, sy: 2.6 + puff % 2, sz: 3.8 });
    }
  }
  const clouds = cloudKit.build(false);
  clouds.name = "cotton-candy-clouds";
  const starKit = new Kit({ star: starMaterial });
  for (let i = 0; i < 100; i++) {
    const a = i * 2.3999632297;
    const elevation = 0.08 + random(i + 700) * 0.85;
    const r = Math.sqrt(1 - elevation * elevation) * 220;
    const size = 0.35 + random(i + 850) * 0.5;
    starKit.add("star", ball, Math.sin(a) * r, elevation * 220, Math.cos(a) * r, { sx: size, sy: size, sz: size });
  }
  const stars = starKit.build(false);
  stars.name = "sugar-stars";
  stars.visible = false;
  for (const layer of [clouds, stars]) {
    layer.traverse(object => { if (object instanceof Mesh) own(object.geometry); });
    group.add(layer);
  }
  const cloudDay = new Color("#fff1f4"), cloudNight = new Color("#9283b3");
  const pinkDay = new Color("#f0c0da"), pinkNight = new Color("#89729f");

  // Sugar sprinkles lie flush with empty coast grass, with no walk-height
  // geometry. No changes to plots or the playground's play anchors.
  for (let i = 0; i < 90; i++) {
    const a = random(i + 400) * Math.PI * 2;
    const r = radius - 5.5 - random(i + 500) * 1.5;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!coastClear(x, z, 0.3)) continue;
    kit.add(i % 3 === 0 ? "white" : i % 3 === 1 ? "red" : "caramel", box, x, 0.025, z,
      { sx: 0.09, sy: 0.035, sz: 0.24, ry: a * 4 });
  }

  // Sparse, readable sprinkles on grass and plaza paving. Flush geometry has
  // no walking-height footprint; keep benches, the wish tree and play cell clear.
  for (let i = 0; i < 180; i++) {
    const a = random(i + 1100) * Math.PI * 2;
    const plaza = i < 42;
    const r = plaza ? 2.1 + random(i + 1200) * 3.5 : 9 + random(i + 1200) * (radius - 15);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!plaza && (onCellTile(x, z, TILE + 0.15) || Math.hypot(x - playAt.x, z - playAt.z) < CELL + 0.5)) continue;
    if (plaza && solids.some(s => Math.hypot(x - s.cx, z - s.cz) < Math.hypot(s.hx, s.hz) + 0.3)) continue;
    kit.add(["red", "lemon", "leafLight", "mint"][i % 4], box, x, plaza ? top + 0.03 : 0.045, z,
      { sx: 0.14, sy: 0.045, sz: 0.4, ry: a * 4 });
  }

  const built = kit.build(opts.shadows);
  built.name = "candy-scenery";
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
      terrainNight.value = nightness;
      for (const tint of dayNight) tint.material.color.copy(tint.day).lerp(tint.night, nightness);
      floating.position.y = Math.sin(t * 0.65) * 0.35;
      clouds.rotation.y = Math.sin(t * 0.035) * 0.035;
      cloudWhite.color.copy(cloudDay).lerp(cloudNight, nightness);
      cloudPink.color.copy(pinkDay).lerp(pinkNight, nightness);
      stars.visible = nightness > 0;
      starMaterial.opacity = nightness * 0.85;
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
    { h: 0, top: "#201c46", horizon: "#51406d", sea: "#285b70", night: 1, sun: "#9fb6ff", power: 0.35, hemi: 0.55 },
    { h: 5.5, top: "#29204e", horizon: "#65507e", sea: "#315e78", night: 1, sun: "#9fb6ff", power: 0.35, hemi: 0.55 },
    { h: 6.6, top: "#9d8bc9", horizon: "#ffc6a6", sea: "#76b9bd", night: 0.4, sun: "#ffc59a", power: 1.6, hemi: 1.0 },
    { h: 8, top: "#b9b5ef", horizon: "#ffe1eb", sea: "#28c9c4", night: 0, sun: "#fff4e2", power: 2.7, hemi: 1.45 },
    { h: 17.2, top: "#b9b5ef", horizon: "#ffe1eb", sea: "#28c9c4", night: 0, sun: "#fff4e2", power: 2.7, hemi: 1.45 },
    { h: 18.8, top: "#9d7fba", horizon: "#ffb487", sea: "#679ba9", night: 0.35, sun: "#ffad7a", power: 1.6, hemi: 1.0 },
    { h: 20.3, top: "#312552", horizon: "#63517f", sea: "#345b74", night: 0.9, sun: "#9fb6ff", power: 0.45, hemi: 0.6 },
    { h: 24, top: "#201c46", horizon: "#51406d", sea: "#285b70", night: 1, sun: "#9fb6ff", power: 0.35, hemi: 0.55 },
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

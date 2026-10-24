// The playground: the island's own cell next to the plaza (docs/island.md,
// Layout), with a slide, a seesaw and two swings, and a bench to watch from.
// Drawn here; what the robots do on it is the simulation's (`sim.ts`), which
// swings the swings and rocks the seesaw through `setMotion`, and puts the
// robots where the anchors say.
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from "three";
import type { Material } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { Kit, solidMaterial } from "./kit";
import { TILE_TOP } from "./model";
import type { Solid } from "./nav";
import type { Seat } from "./sim";

/** The playground's cell, in axial coordinates. Never a plot. */
export const PLAYGROUND_CELL = { q: -1, r: 0 } as const;

type P = { x: number; z: number };
type P3 = { x: number; y: number; z: number };

/** Where a robot goes to play, in world metres (heights from the sea's
 *  level, so a robot on a swing is put exactly where its seat is). */
export type PlayAnchors = {
  center: P;
  /** Each swing: where its ropes hang from and how long they are, and the
   *  way it faces (a robot's heading on it, radians). It swings along that
   *  way: forward is `+sin θ` of the rope. */
  swings: { pivot: P3; rope: number; face: number; stand: P }[];
  /** The seesaw: its pivot, how far each seat is from it, and the yaw of the
   *  plank (radians: three.js's turn of its +x). Seat 0 is at −x and faces
   *  +x; seat 1 at +x faces −x. `stand` is where to walk to for each. */
  seesaw: { pivot: P3; half: number; yaw: number; stand: [P, P] };
  /** The slide: where to wait, the foot of its ladder, the top of its
   *  platform, where the chute starts and ends (a sitting robot's hips) and
   *  where to step off; `face` the way down. */
  slide: { queue: P; foot: P; top: P3; from: P3; to: P3; exit: P; face: number; back: P };
};

export type Playground = {
  group: Group;
  solids: Solid[];
  seats: Seat[];
  anchors: PlayAnchors;
  /** The swings' angles (radians, forward positive) and the seesaw's tilt
   *  (radians, seat 1 up positive). */
  setMotion(motion: { swings: readonly number[]; seesaw: number }): void;
  dispose(): void;
};

/** Measures, in the playground's own coordinates (its +z faces the plaza). */
const SWINGS = { x: -2.4, z: -2.4, top: 2.3, rope: 1.68, seats: [-0.75, 0.75] };
const SEESAW = { x: -2.2, z: 2.7, height: 0.45, half: 1.45 };
const SLIDE = { x: 2.6, ladderZ: -3.3, platformZ: -2.9, top: 1.35, chuteFrom: -2.5, chuteTo: 0.45, bottom: 0.22 };

export function buildPlayground(opts: { x: number; z: number; facing: number; shadows: boolean }): Playground {
  const yaw = (opts.facing * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  /** A point of the playground in the world. */
  const world = (lx: number, lz: number) => ({ x: opts.x + lx * cos + lz * sin, z: opts.z - lx * sin + lz * cos });
  const world3 = (lx: number, ly: number, lz: number) => ({ ...world(lx, lz), y: TILE_TOP + ly });

  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(thing: T) => { owned.push(thing); return thing; };
  const materials: Record<string, Material> = {
    frame: own(solidMaterial("#afa2d9", 0.6)),
    red: own(solidMaterial("#e9a5bd", 0.6)),
    yellow: own(solidMaterial("#f0d39e", 0.5)),
    teal: own(solidMaterial("#9bcebf", 0.6)),
    wood: own(solidMaterial("#ddb78e", 0.8)),
    darkWood: own(solidMaterial("#806071", 0.8)),
    rope: own(solidMaterial("#fff0e7", 0.9)),
  };
  const box = own(new RoundedBoxGeometry(1, 1, 1, 2, 0.08));
  const bar = own(new CylinderGeometry(0.5, 0.5, 1, 10));

  // Everything is built in the playground's own frame, in a group the
  // cell's turn and place are given to.
  const group = new Group();
  group.name = "playground";
  group.position.set(opts.x, TILE_TOP, opts.z);
  group.rotation.y = yaw;
  const kit = new Kit(materials);

  // The swings: an A-frame at each end, a bar across the top, two seats.
  const { x: sx, z: sz, top } = SWINGS;
  kit.add("frame", bar, sx, top, sz, { sx: 0.13, sy: 3.3, sz: 0.13, rz: Math.PI / 2 });
  for (const end of [-1.6, 1.6]) {
    for (const lean of [-1, 1]) {
      const spread = 0.75;
      const length = Math.hypot(top, spread);
      kit.add("frame", bar, sx + end, top / 2, sz + (lean * spread) / 2, { sx: 0.12, sy: length, sz: 0.12, rx: -lean * Math.atan2(spread, top) });
    }
  }
  const swingGroups = SWINGS.seats.map((offset) => {
    const swing = new Group();
    swing.position.set(sx + offset, top - 0.04, sz);
    for (const side of [-0.22, 0.22]) {
      const rope = new Mesh(bar, materials.rope);
      rope.scale.set(0.035, SWINGS.rope, 0.035);
      rope.position.set(side, -SWINGS.rope / 2, 0);
      swing.add(rope);
    }
    const seat = new Mesh(box, materials.red);
    seat.scale.set(0.56, 0.06, 0.34);
    seat.position.set(0, -SWINGS.rope, 0);
    seat.castShadow = opts.shadows;
    swing.add(seat);
    group.add(swing);
    return swing;
  });

  // The seesaw: a stand, and a plank that turns on it.
  const { x: wx, z: wz, height, half } = SEESAW;
  kit.add("darkWood", box, wx, height / 2 - 0.05, wz, { sx: 0.34, sy: height - 0.1, sz: 0.5 });
  kit.add("frame", bar, wx, height, wz, { sx: 0.1, sy: 0.56, sz: 0.1, rx: Math.PI / 2 });
  const plank = new Group();
  plank.position.set(wx, height, wz);
  const plankParts: [string, number, number, number, number, number, number][] = [
    ["yellow", 0, 0.05, 0, half * 2 + 0.5, 0.08, 0.32],
    ["teal", -half, 0.12, 0, 0.42, 0.07, 0.36],
    ["teal", half, 0.12, 0, 0.42, 0.07, 0.36],
    ["frame", -half + 0.32, 0.3, 0, 0.06, 0.4, 0.06],
    ["frame", half - 0.32, 0.3, 0, 0.06, 0.4, 0.06],
    ["frame", -half + 0.32, 0.48, 0, 0.06, 0.06, 0.4],
    ["frame", half - 0.32, 0.48, 0, 0.06, 0.06, 0.4],
  ];
  for (const [material, x, y, z, w, h, d] of plankParts) {
    const part = new Mesh(box, materials[material]);
    part.scale.set(w, h, d);
    part.position.set(x, y, z);
    part.castShadow = opts.shadows;
    plank.add(part);
  }
  group.add(plank);

  // The slide: a ladder at the back, a platform, a chute down to the front.
  const { x: lx, ladderZ, platformZ, chuteFrom, chuteTo, bottom } = SLIDE;
  const height2 = SLIDE.top;
  for (const side of [-0.32, 0.32]) kit.add("frame", bar, lx + side, height2 / 2 + 0.15, ladderZ, { sx: 0.07, sy: height2 + 0.3, sz: 0.07 });
  for (let rung = 0.25; rung < height2; rung += 0.27) kit.add("yellow", bar, lx, rung, ladderZ, { sx: 0.05, sy: 0.64, sz: 0.05, rz: Math.PI / 2 });
  for (const corner of [[-0.4, -0.38], [0.4, -0.38], [-0.4, 0.38], [0.4, 0.38]]) {
    kit.add("frame", bar, lx + corner[0], height2 / 2, platformZ + corner[1], { sx: 0.08, sy: height2, sz: 0.08 });
  }
  kit.add("wood", box, lx, height2, platformZ, { sx: 0.95, sy: 0.08, sz: 0.85 });
  for (const side of [-0.45, 0.45]) kit.add("red", box, lx + side, height2 + 0.3, platformZ, { sx: 0.05, sy: 0.06, sz: 0.8 });
  const drop = height2 - bottom;
  const run = chuteTo - chuteFrom;
  const length = Math.hypot(drop, run);
  const tilt = Math.atan2(drop, run);
  const midZ = (chuteFrom + chuteTo) / 2;
  const midY = (height2 + bottom) / 2;
  kit.add("yellow", box, lx, midY, midZ, { sx: 0.7, sy: 0.06, sz: length, rx: tilt });
  for (const side of [-0.37, 0.37]) kit.add("red", box, lx + side, midY + 0.09, midZ, { sx: 0.06, sy: 0.18, sz: length, rx: tilt });
  kit.add("yellow", box, lx, bottom, chuteTo + 0.3, { sx: 0.7, sy: 0.06, sz: 0.6 });
  for (const leg of [chuteFrom + run * 0.55]) {
    kit.add("frame", bar, lx, (bottom + drop * 0.45) / 2, leg, { sx: 0.07, sy: bottom + drop * 0.45, sz: 0.07 });
  }

  // A bench at the front to watch from.
  const benchX = 3.3;
  const benchZ = 3.4;
  kit.add("wood", box, benchX, 0.27, benchZ, { sx: 1.6, sy: 0.08, sz: 0.45 });
  kit.add("wood", box, benchX, 0.52, benchZ + 0.2, { sx: 1.6, sy: 0.28, sz: 0.07 });
  for (const x of [-0.65, 0.65]) kit.add("darkWood", box, benchX + x, 0.13, benchZ, { sx: 0.09, sy: 0.26, sz: 0.4 });

  const built = kit.build(opts.shadows);
  built.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.geometry) own(mesh.geometry);
  });
  group.add(built);

  // In the world: anchors for the robots, and what they walk round.
  const forward = { x: sin, z: cos };
  const swings = SWINGS.seats.map((offset) => ({
    pivot: world3(sx + offset, top - 0.04, sz),
    rope: SWINGS.rope + 0.03,
    face: yaw,
    stand: world(sx + offset, sz + 0.75),
  }));
  const seesaw = {
    pivot: world3(wx, height, wz),
    half,
    yaw,
    stand: [world(wx - half, wz + 0.55), world(wx + half, wz + 0.55)] as [P, P],
  };
  const slide = {
    queue: world(lx, ladderZ - 1.0),
    back: { x: -forward.x, z: -forward.z },
    foot: world(lx, ladderZ - 0.35),
    top: world3(lx, height2 + 0.04, platformZ),
    from: world3(lx, height2 + 0.1, chuteFrom + 0.15),
    to: world3(lx, bottom + 0.12, chuteTo + 0.2),
    exit: world(lx, chuteTo + 1.0),
    face: yaw,
  };
  const rect = (cx: number, cz: number, hx: number, hz: number): Solid => ({ ...centerOf(world(cx, cz)), hx, hz, yaw });
  const solids: Solid[] = [
    ...[-1.6, 1.6].flatMap((end) => [-0.75, 0.75].map((spread) => rect(sx + end, sz + spread, 0.12, 0.12))),
    rect(wx, wz, half + 0.2, 0.22),
    rect(lx, (ladderZ + chuteTo) / 2, 0.42, (chuteTo - ladderZ) / 2 + 0.1),
    rect(benchX, benchZ, 0.8, 0.25),
  ];
  const benchFace = yaw + Math.PI;
  const seats: Seat[] = [-0.4, 0.4].map((offset) => {
    const at = world(benchX + offset, benchZ - 0.02);
    return { key: `playground:bench:${offset}`, kind: "seat", x: at.x, z: at.z, y: TILE_TOP + 0.31, face: benchFace, plot: null, name: "the playground bench" };
  });

  return {
    group,
    solids,
    seats,
    anchors: { center: world(0, 0), swings, seesaw, slide },
    setMotion(motion) {
      swingGroups.forEach((swing, i) => { swing.rotation.x = -(motion.swings[i] ?? 0); });
      plank.rotation.z = motion.seesaw;
    },
    dispose() {
      owned.forEach((thing) => thing.dispose());
    },
  };
}

function centerOf(p: P): { cx: number; cz: number } {
  return { cx: p.x, cz: p.z };
}

/** Where a robot riding the seesaw sits, by its seat and the plank's tilt:
 *  its hips, and the way it faces. */
export function seesawSeat(anchor: PlayAnchors["seesaw"], seat: 0 | 1, tilt: number): { x: number; y: number; z: number; face: number } {
  const side = seat === 0 ? -1 : 1;
  const along = side * anchor.half * Math.cos(tilt);
  const up = side * anchor.half * Math.sin(tilt);
  return {
    x: anchor.pivot.x + along * Math.cos(anchor.yaw),
    z: anchor.pivot.z - along * Math.sin(anchor.yaw),
    y: anchor.pivot.y + up + 0.19,
    face: anchor.yaw + (seat === 0 ? Math.PI / 2 : -Math.PI / 2),
  };
}

/** Where a robot on a swing sits, by the swing's angle. */
export function swingSeat(anchor: PlayAnchors["swings"][number], angle: number): { x: number; y: number; z: number; face: number } {
  const ahead = anchor.rope * Math.sin(angle);
  return {
    x: anchor.pivot.x + Math.sin(anchor.face) * ahead,
    z: anchor.pivot.z + Math.cos(anchor.face) * ahead,
    y: anchor.pivot.y - anchor.rope * Math.cos(angle) + 0.04,
    face: anchor.face,
  };
}

export type { BoxGeometry, MeshStandardMaterial };

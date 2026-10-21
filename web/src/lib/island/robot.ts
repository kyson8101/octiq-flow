// The island's chibi robots: the mascot rig (`mascotScene`) given a look of
// its own (frame, colours, eyes, antenna), slots that hold what it wears, and
// the poses a robot needs out in the world: walking, sitting, working,
// waving, raising a hand, sleeping, dancing, cheering.
//
// Built in the mascot's own units and scaled once at `body`, so its feet are
// on the ground at the origin and it stands 1.0 m tall to the top of its head
// (docs/island.md). What it wears is built in metres and hung on an anchor
// that undoes the scale above it.
import {
  Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, SphereGeometry, TorusGeometry,
} from "three";
import type { BufferGeometry, Material, Object3D } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Antenna, Eyes, Frame, Look, Slot } from "./model";

/** Rig units to metres, and how far the rig's origin sits above its feet. */
export const ROBOT_SCALE = 0.394;
export const ROBOT_LIFT = 1.173 * ROBOT_SCALE;
/** How high its hips are when it stands. Sitting, the hips go where the
 *  seat's spot says, so the body drops by this much. */
export const HIP_HEIGHT = 0.457 * ROBOT_SCALE;

const FRAMES: Record<Frame, { width: number; roundness: number; bodyWidth: number; beat: number }> = {
  round: { width: 1.42, roundness: 0.42, bodyWidth: 0.96, beat: 1.2 },
  boxy: { width: 1.46, roundness: 0.16, bodyWidth: 0.94, beat: 1.1 },
  slim: { width: 1.34, roundness: 0.26, bodyWidth: 0.78, beat: 0.9 },
  stout: { width: 1.56, roundness: 0.2, bodyWidth: 1.12, beat: 1.3 },
};

export type Pose =
  | "register" | "stand" | "walk" | "sit" | "work" | "think" | "wave" | "raise" | "sleep" | "dance" | "cheer" | "talk"
  // On the playground: sitting on a swing holding its ropes, riding the
  // seesaw or the slide holding on in front, going up the ladder.
  | "swing" | "ride" | "climb"
  // Hands over its face, shoulders shaking: nobody would play.
  | "sob";

/** The poses in which its hips, not its feet, are where it is put. */
export const SEATED: ReadonlySet<Pose> = new Set<Pose>(["sit", "sleep", "swing", "ride"]);

/** Shapes every robot shares: made once, never disposed with a robot. */
const shared = (() => {
  let made: Record<string, BufferGeometry> | null = null;
  return () => made ??= {
    sphere: new SphereGeometry(1, 14, 10),
    rounded: new RoundedBoxGeometry(1, 1, 1, 2, 0.18),
    disc: new CylinderGeometry(1, 1, 1, 20),
    ear: new CylinderGeometry(0.2, 0.2, 0.15, 16),
    halo: new TorusGeometry(0.38, 0.045, 8, 32),
    smile: new TorusGeometry(0.105, 0.026, 6, 16, Math.PI),
    arc: new TorusGeometry(0.1, 0.03, 6, 14, Math.PI),
    crescent: new TorusGeometry(0.23, 0.065, 8, 24, Math.PI * 1.45),
    spike: new CylinderGeometry(0, 0.16, 1, 4),
    core: new CylinderGeometry(0.115, 0.115, 0.045, 24),
  };
})();

const heads = new Map<string, BufferGeometry>();
function headGeometry(frame: Frame): BufferGeometry {
  const design = FRAMES[frame];
  const key = `${design.width}:${design.roundness}`;
  let geometry = heads.get(key);
  if (!geometry) {
    geometry = new RoundedBoxGeometry(design.width, 1.05, 0.89, 3, design.roundness);
    heads.set(key, geometry);
  }
  return geometry;
}

/** One robot, ready to pose. */
export type RobotRig = ReturnType<typeof createIslandRobot>;

export function createIslandRobot(look: Look) {
  const design = FRAMES[look.frame] ?? FRAMES.round;
  const g = shared();
  const shellColor = new Color(look.shell);
  const trimColor = new Color(look.trim);
  const glowColor = new Color(look.glow);
  const shell = new MeshStandardMaterial({ color: shellColor, roughness: 0.34, metalness: 0.1 });
  const trim = new MeshStandardMaterial({ color: trimColor, roughness: 0.36, metalness: 0.28 });
  const joint = new MeshStandardMaterial({ color: "#2b3a44", roughness: 0.5, metalness: 0.5 });
  const glass = new MeshStandardMaterial({ color: "#0d1d29", roughness: 0.2, metalness: 0.25 });
  const light = new MeshBasicMaterial({ color: glowColor });
  const eyeLight = new MeshBasicMaterial({ color: glowColor.clone() });
  const terminalLight = new MeshBasicMaterial({ color: "#91eec3" });
  const materials: Material[] = [shell, trim, joint, glass, light, eyeLight, terminalLight];

  function mesh(parent: Object3D, geometry: BufferGeometry, material: Material,
    x: number, y: number, z: number, sx = 1, sy = sx, sz = sx) {
    const part = new Mesh(geometry, material);
    part.position.set(x, y, z);
    part.scale.set(sx, sy, sz);
    parent.add(part);
    return part;
  }
  const box = (p: Object3D, m: Material, x: number, y: number, z: number, w: number, h: number, d: number) =>
    mesh(p, g.rounded, m, x, y, z, w, h, d);
  const ball = (p: Object3D, m: Material, x: number, y: number, z: number, r: number) => mesh(p, g.sphere, m, x, y, z, r);
  const group = (p: Object3D, name: string, x = 0, y = 0, z = 0) => {
    const made = new Group();
    made.name = name;
    made.position.set(x, y, z);
    p.add(made);
    return made;
  };

  // `root` is the robot in the world: where it stands and which way it faces.
  // `body` scales the mascot's units to metres and lifts its feet to y = 0.
  const root = new Group();
  root.name = "robot";
  const body = group(root, "body", 0, ROBOT_LIFT, 0);
  body.scale.setScalar(ROBOT_SCALE);
  const chassis = group(body, "chassis", 0, -0.38);
  chassis.scale.setScalar(0.58);
  const torso = group(chassis, "torso");
  box(torso, shell, 0, -0.06, 0, design.bodyWidth, 0.93, 0.68);
  box(torso, trim, 0, -0.48, 0.015, design.bodyWidth * 0.78, 0.13, 0.59);
  box(torso, glass, 0, 0.02, 0.349, 0.44, 0.35, 0.06);
  const core = mesh(torso, g.core, light, 0, 0.035, 0.394);
  core.rotation.x = Math.PI / 2;
  core.name = "core";
  for (const x of [-0.1, 0, 0.1]) box(torso, joint, x, -0.27, 0.35, 0.05, 0.045, 0.025);
  ball(torso, joint, 0, 0.48, 0, 0.16);

  const head = group(body, "head", 0, 0.64);
  head.scale.setScalar(1.38);
  mesh(head, headGeometry(look.frame), shell, 0, 0, 0);
  box(head, trim, 0, -0.03, 0.424, design.width * 0.88, 0.79, 0.13);
  box(head, glass, 0, -0.025, 0.499, design.width * 0.79, 0.66, 0.075);
  box(head, joint, -0.16, 0.23, 0.542, 0.56, 0.024, 0.014);
  const eyes = makeEyes(head, look.eyes, eyeLight, box, mesh, g);
  const smile = mesh(head, g.smile, light, 0, -0.17, 0.56);
  smile.rotation.z = Math.PI;
  smile.name = "smile";
  const antenna = group(head, "antenna");
  antenna.scale.setScalar(0.78);
  makeEars(head, look.frame, design.width, trim, joint, box, mesh, g);
  makeAntenna(antenna, look.antenna, { trim, joint, light }, box, ball, mesh, g);

  const arms = [-1, 1].map((side) => {
    const shoulder = group(chassis, side < 0 ? "right-arm" : "left-arm", side * (design.bodyWidth / 2 + 0.13), 0.27);
    ball(shoulder, joint, 0, 0, 0, 0.145);
    box(shoulder, shell, 0, -0.2, 0, 0.24, 0.34, 0.28);
    const elbow = group(shoulder, "elbow", 0, -0.38);
    ball(elbow, joint, 0, 0, 0, 0.11);
    box(elbow, trim, 0, -0.16, 0, 0.23, 0.25, 0.26);
    ball(elbow, shell, 0, -0.34, 0.02, 0.16);
    return { shoulder, elbow };
  });
  const legs = [-1, 1].map((side) => {
    const hip = group(chassis, side < 0 ? "right-leg" : "left-leg", side * design.bodyWidth * 0.29, -0.58);
    ball(hip, joint, 0, 0, 0, 0.13);
    box(hip, shell, 0, -0.18, 0, 0.26, 0.33, 0.3);
    const knee = group(hip, "knee", 0, -0.36);
    ball(knee, joint, 0, 0, 0, 0.115);
    box(knee, trim, 0, -0.13, 0, 0.26, 0.22, 0.28);
    box(knee, shell, 0, -0.3, 0.12, look.frame === "stout" ? 0.48 : 0.39, 0.25, 0.57);
    box(knee, joint, 0, -0.4, 0.13, look.frame === "stout" ? 0.49 : 0.4, 0.055, 0.56);
    return { hip, knee };
  });

  // The console it types at while it works: the mascot's, so a robot at work
  // looks the same here as it always has.
  const terminal = group(chassis, "terminal", 0, -0.31, 0.92);
  box(terminal, joint, 0, 0, 0, 1.03, 0.1, 0.59);
  for (const x of [-0.3, -0.1, 0.1, 0.3]) {
    for (const z of [-0.13, 0.03, 0.19]) box(terminal, trim, x, 0.058, z, 0.12, 0.025, 0.085);
  }
  const screen = group(terminal, "screen", 0, 0.32, 0.27);
  screen.rotation.x = -0.12;
  box(screen, trim, 0, 0, 0, 1.07, 0.67, 0.08);
  box(screen, glass, 0, 0, 0.046, 0.94, 0.54, 0.025);
  for (const [i, width] of [0.36, 0.59, 0.43].entries()) {
    box(screen, terminalLight, (width - 0.68) / 2, 0.14 - i * 0.115, 0.064, width, 0.028, 0.015);
  }
  const cursor = box(screen, light, 0.26, -0.13, 0.065, 0.08, 0.045, 0.015);
  cursor.name = "cursor";
  terminal.visible = false;

  // Where what it wears hangs. Each anchor undoes the scale of every group
  // above it, so an accessory is built and placed in metres from its anchor
  // (docs/island.md, Accessory anchors).
  const anchor = (parent: Group, name: Slot, x: number, y: number, z: number, scale: number) => {
    const made = group(parent, `wear-${name}`, x, y, z);
    made.scale.setScalar(1 / scale);
    return made;
  };
  const headScale = ROBOT_SCALE * 1.38;
  const chassisScale = ROBOT_SCALE * 0.58;
  const anchors: Record<Slot, Group> = {
    head: anchor(head, "head", 0, 0.525, 0, headScale),
    face: anchor(head, "face", 0, -0.025, 0.54, headScale),
    neck: anchor(chassis, "neck", 0, 0.52, 0, chassisScale),
    back: anchor(chassis, "back", 0, -0.06, -0.34, chassisScale),
    hand: anchor(arms[0].elbow, "hand", 0, -0.36, 0.02, chassisScale),
  };

  merge(torso, chassis, head, ...arms.flatMap((a) => [a.shoulder, a.elbow]), ...legs.flatMap((l) => [l.hip, l.knee]), terminal, screen);

  return {
    root, body, chassis, head, antenna, torso, arms, legs, eyes, core, terminal, cursor, eyeLight, light, anchors,
    beat: design.beat,
    glow: glowColor,
    /** Take off whatever hangs on a slot, and hang something else there. */
    wear(slot: Slot, item: Object3D | null) {
      const holder = anchors[slot];
      for (const child of [...holder.children]) holder.remove(child);
      if (item) holder.add(item);
    },
    dispose() {
      materials.forEach((m) => m.dispose());
      root.traverse((object) => {
        const geometry = (object as Mesh).geometry;
        if (geometry?.userData.robotMerged) geometry.dispose();
      });
    },
  };
}

type MeshFn = (parent: Object3D, geometry: BufferGeometry, material: Material,
  x: number, y: number, z: number, sx?: number, sy?: number, sz?: number) => Mesh;
type BoxFn = (p: Object3D, m: Material, x: number, y: number, z: number, w: number, h: number, d: number) => Mesh;
type BallFn = (p: Object3D, m: Material, x: number, y: number, z: number, r: number) => Mesh;

function makeEyes(head: Group, kind: Eyes, eyeLight: Material, box: BoxFn, mesh: MeshFn,
  g: ReturnType<typeof shared>): Group[] {
  if (kind === "visor") {
    const band = new Group();
    band.name = "visor-eyes";
    band.position.set(0, 0.035, 0.555);
    head.add(band);
    box(band, eyeLight, 0, 0, 0, 0.78, 0.13, 0.035);
    return [band];
  }
  return [-1, 1].map((side) => {
    const eye = new Group();
    eye.name = side < 0 ? "right-eye" : "left-eye";
    eye.position.set(side * 0.27, 0.035, 0.555);
    head.add(eye);
    switch (kind) {
      case "round": {
        const disc = mesh(eye, g.disc, eyeLight, 0, 0, 0, 0.12, 0.03, 0.12);
        disc.rotation.x = Math.PI / 2;
        break;
      }
      case "happy": {
        const arc = mesh(eye, g.arc, eyeLight, 0, -0.04, 0);
        arc.scale.set(1.1, 1.1, 1);
        break;
      }
      case "sleepy":
        box(eye, eyeLight, 0, -0.04, 0, 0.22, 0.05, 0.035);
        break;
      case "star":
        for (const angle of [Math.PI / 4, -Math.PI / 4, 0]) {
          const ray = box(eye, eyeLight, 0, 0, 0, 0.06, angle ? 0.26 : 0.3, 0.035);
          ray.rotation.z = angle;
        }
        break;
      case "heart": {
        mesh(eye, g.sphere, eyeLight, -0.055, 0.03, 0, 0.075, 0.075, 0.03);
        mesh(eye, g.sphere, eyeLight, 0.055, 0.03, 0, 0.075, 0.075, 0.03);
        const tip = box(eye, eyeLight, 0, -0.04, 0, 0.13, 0.13, 0.035);
        tip.rotation.z = Math.PI / 4;
        break;
      }
      case "chevron":
        for (const y of [-1, 1]) {
          const bar = box(eye, eyeLight, 0, y * 0.08, 0, 0.08, 0.23, 0.035);
          bar.rotation.z = side * y * 0.75;
        }
        break;
      default:
        box(eye, eyeLight, 0, 0, 0, 0.19, 0.29, 0.035);
    }
    return eye;
  });
}

function makeEars(head: Group, frame: Frame, width: number, trim: Material, joint: Material,
  box: BoxFn, mesh: MeshFn, g: ReturnType<typeof shared>) {
  const earX = width / 2 + 0.06;
  for (const side of [-1, 1]) {
    if (frame === "slim") {
      const fin = box(head, trim, side * earX, 0.03, -0.01, 0.14, 0.64, 0.37);
      fin.rotation.z = side * -0.35;
      continue;
    }
    const ear = mesh(head, g.ear, trim, side * earX, -0.02, 0);
    ear.rotation.z = Math.PI / 2;
    if (frame === "stout") {
      for (const y of [-0.16, 0, 0.16]) box(head, joint, side * (earX + 0.06), y, 0.1, 0.16, 0.07, 0.22);
    }
  }
}

function makeAntenna(antenna: Group, kind: Antenna, m: { trim: Material; joint: Material; light: Material },
  box: BoxFn, ball: BallFn, mesh: MeshFn, g: ReturnType<typeof shared>) {
  switch (kind) {
    case "none":
      return;
    case "halo": {
      const halo = mesh(antenna, g.halo, m.light, 0, 0.79, 0);
      halo.rotation.x = Math.PI / 2 - 0.12;
      return;
    }
    case "crown":
      box(antenna, m.trim, 0, 0.55, 0, 0.92, 0.13, 0.4);
      for (const x of [-0.32, 0, 0.32]) mesh(antenna, g.spike, m.trim, x, 0.72, 0, 1, x === 0 ? 0.42 : 0.3, 1);
      ball(antenna, m.light, 0, 0.97, 0, 0.075);
      return;
    case "star":
      box(antenna, m.joint, 0, 0.63, 0, 0.045, 0.22, 0.045);
      for (const r of [0, Math.PI / 2]) {
        const ray = box(antenna, m.light, 0, 0.85, 0, 0.075, 0.37, 0.075);
        ray.rotation.z = r;
      }
      return;
    case "leaf": {
      const leaf = mesh(antenna, g.sphere, m.trim, 0.32, 0.7, 0, 0.1, 0.32, 0.07);
      leaf.rotation.z = -0.55;
      return;
    }
    case "moon": {
      const crescent = mesh(antenna, g.crescent, m.light, 0.28, 0.69, 0.02);
      crescent.rotation.z = 0.55;
      return;
    }
    case "twin":
      for (const x of [-0.4, 0.4]) {
        box(antenna, m.joint, x, 0.62, 0, 0.045, 0.2, 0.045);
        box(antenna, m.light, x, 0.75, 0, 0.18, 0.12, 0.14);
      }
      return;
    case "sun":
      for (const angle of [-0.8, -0.4, 0, 0.4, 0.8]) {
        const ray = box(antenna, m.trim, Math.sin(angle) * 0.63, Math.cos(angle) * 0.62, 0, 0.07, 0.21, 0.08);
        ray.rotation.z = -angle;
      }
      ball(antenna, m.light, 0, 0.86, 0, 0.09);
      return;
    case "spark":
      for (const angle of [0, Math.PI / 3, -Math.PI / 3]) {
        const ray = box(antenna, m.light, 0, 0.73, 0, 0.055, 0.34, 0.07);
        ray.rotation.z = angle;
      }
      return;
    case "bar":
      box(antenna, m.joint, 0, 0.64, 0, 0.055, 0.23, 0.055);
      box(antenna, m.light, 0, 0.8, 0, 0.3, 0.13, 0.14);
      return;
    case "sprout": {
      box(antenna, m.trim, 0, 0.62, 0, 0.05, 0.24, 0.05);
      for (const side of [-1, 1]) {
        const leaf = mesh(antenna, g.sphere, m.trim, side * 0.13, 0.76, 0, 0.14, 0.06, 0.08);
        leaf.rotation.z = side * 0.45;
      }
      return;
    }
    default:
      box(antenna, m.joint, 0, 0.64, 0, 0.055, 0.23, 0.055);
      ball(antenna, m.light, 0, 0.8, 0, 0.12);
  }
}

/** Fewer draw calls for a crowd: the meshes that hang directly off a group
 *  and share a material become one mesh. Only direct children, so every
 *  joint still moves on its own; the eyes, which blink, are groups and are
 *  left alone. */
function merge(...groups: Group[]) {
  for (const holder of groups) {
    const byMaterial = new Map<Material, Mesh[]>();
    for (const child of holder.children) {
      if (!(child instanceof Mesh) || child.name) continue;
      const list = byMaterial.get(child.material as Material) ?? [];
      list.push(child);
      byMaterial.set(child.material as Material, list);
    }
    for (const [material, meshes] of byMaterial) {
      if (meshes.length < 2) continue;
      const pieces = meshes.map((piece) => {
        piece.updateMatrix();
        const geometry = piece.geometry.index ? piece.geometry.toNonIndexed() : piece.geometry.clone();
        geometry.applyMatrix4(piece.matrix);
        for (const name of Object.keys(geometry.attributes)) {
          if (name !== "position" && name !== "normal") geometry.deleteAttribute(name);
        }
        return geometry;
      });
      const joined = mergeGeometries(pieces, false);
      pieces.forEach((piece) => piece.dispose());
      if (!joined) continue;
      joined.userData.robotMerged = true;
      for (const piece of meshes) holder.remove(piece);
      holder.add(new Mesh(joined, material));
    }
  }
}

/** Absolute poses, so a rig moved from one pose to the next never carries a
 *  rotation over. `t` is seconds; `stride` (0..1) is how far into a step the
 *  feet are while walking; `calm` drops the bounce and sway (reduced motion,
 *  and anything far from the camera). */
export function poseIslandRobot(rig: RobotRig, pose: Pose, t: number,
  opts: { stride?: number; calm?: boolean; asleep?: boolean; console?: boolean; lean?: number; bored?: boolean } = {}) {
  const { body, chassis, head, arms, legs, eyes, terminal, cursor, antenna } = rig;
  const calm = !!opts.calm;
  const beat = t * Math.PI * 2 / rig.beat;
  body.position.set(0, ROBOT_LIFT, 0);
  body.rotation.set(0, 0, 0);
  chassis.rotation.set(0, 0, 0);
  head.rotation.set(0, 0, 0);
  antenna.rotation.set(0, 0, 0);
  arms.forEach(({ shoulder, elbow }, i) => {
    shoulder.rotation.set(0, 0, i === 0 ? -0.13 : 0.13);
    elbow.rotation.set(-0.12, 0, 0);
  });
  legs.forEach(({ hip, knee }) => { hip.rotation.set(0, 0, 0); knee.rotation.set(0, 0, 0); });
  // Its own console, unless it works at a desk that has a screen of its own.
  terminal.visible = pose === "work" && opts.console !== false;
  cursor.visible = calm || Math.sin(t * 9) > -0.4;
  const breathe = calm ? 0 : Math.sin(t * 1.7) * 0.012;

  switch (pose) {
    case "walk": {
      const phase = (opts.stride ?? 0) * Math.PI * 2;
      const swing = Math.sin(phase);
      body.position.y = ROBOT_LIFT + (calm ? 0 : Math.abs(Math.cos(phase)) * 0.025);
      body.rotation.z = calm ? 0 : swing * 0.05;
      head.rotation.z = calm ? 0 : -swing * 0.06;
      legs.forEach(({ hip, knee }, i) => {
        const s = i === 0 ? swing : -swing;
        hip.rotation.x = s * 0.55;
        knee.rotation.x = Math.max(0, -s) * 0.6;
      });
      arms.forEach(({ shoulder, elbow }, i) => {
        const s = i === 0 ? -swing : swing;
        shoulder.rotation.x = s * 0.6;
        elbow.rotation.x = -0.3 - Math.max(0, s) * 0.3;
      });
      antenna.rotation.z = calm ? 0 : Math.sin(phase - 0.6) * 0.1;
      break;
    }
    case "sit":
    case "sleep": {
      // Hips on the seat: the root is put where the seat's spot is, the legs
      // reach forward and the shins hang down.
      body.position.y = ROBOT_LIFT - HIP_HEIGHT + breathe;
      legs.forEach(({ hip, knee }) => { hip.rotation.x = -1.45; knee.rotation.x = 1.25; });
      arms.forEach(({ shoulder, elbow }, i) => {
        shoulder.rotation.set(-0.35, 0, i === 0 ? -0.18 : 0.18);
        elbow.rotation.x = -0.5;
      });
      if (pose === "sleep" || opts.asleep) {
        head.rotation.x = 0.2;
        head.rotation.z = -0.12;
      } else if (!calm) {
        head.rotation.y = Math.sin(t * 0.4) * 0.25;
        head.rotation.x = Math.sin(t * 0.7) * 0.04;
      }
      break;
    }
    case "swing": {
      // Sitting, both hands up on the ropes; the legs kick out going forward
      // and tuck in going back, as a child pumps a swing.
      const lean = opts.lean ?? 0;
      body.position.y = ROBOT_LIFT - HIP_HEIGHT;
      body.rotation.x = -lean * 0.35;
      legs.forEach(({ hip, knee }) => {
        hip.rotation.x = -1.45 - lean * 0.6;
        knee.rotation.x = 1.25 - Math.max(0, lean) * 1.4;
      });
      // The ropes hang just outside its shoulders: up, and a little out.
      arms.forEach(({ shoulder, elbow }, i) => {
        shoulder.rotation.set(-0.15, 0, i === 0 ? -2.85 : 2.85);
        elbow.rotation.set(0, 0, i === 0 ? 0.25 : -0.25);
      });
      head.rotation.x = -0.1 - lean * 0.2;
      break;
    }
    case "ride":
      // Sitting astride, holding on in front.
      body.position.y = ROBOT_LIFT - HIP_HEIGHT + breathe;
      legs.forEach(({ hip, knee }) => { hip.rotation.x = -1.35; knee.rotation.x = 1.0; });
      arms.forEach(({ shoulder, elbow }) => {
        shoulder.rotation.set(-1.25, 0, 0);
        elbow.rotation.x = -0.35;
      });
      head.rotation.x = calm ? 0 : Math.sin(t * 2) * 0.05;
      break;
    case "sob": {
      // Head down, both hands up to its visor, shoulders shaking.
      const shake = calm ? 0 : Math.sin(t * 15);
      body.position.y = ROBOT_LIFT + (calm ? 0 : Math.abs(shake) * 0.01);
      head.rotation.x = 0.32;
      head.rotation.z = calm ? 0 : shake * 0.035;
      arms.forEach(({ shoulder, elbow }, i) => {
        shoulder.rotation.set(-1.75 + (calm ? 0 : shake * 0.05), 0, i === 0 ? 0.32 : -0.32);
        elbow.rotation.set(-1.25, 0, 0);
      });
      break;
    }
    case "climb": {
      // Hand over hand up the ladder, a foot on each rung.
      const phase = (opts.stride ?? 0) * Math.PI * 2;
      const reach = Math.sin(phase);
      arms.forEach(({ shoulder, elbow }, i) => {
        const s = i === 0 ? reach : -reach;
        shoulder.rotation.set(-2.4 + s * 0.35, 0, 0);
        elbow.rotation.x = -0.4 - Math.max(0, s) * 0.4;
      });
      legs.forEach(({ hip, knee }, i) => {
        const s = i === 0 ? -reach : reach;
        hip.rotation.x = -0.4 + s * 0.45;
        knee.rotation.x = 0.5 + Math.max(0, s) * 0.5;
      });
      head.rotation.x = -0.2;
      break;
    }
    case "work":
      head.rotation.x = 0.13 + (calm ? 0 : Math.sin(t * 9) * 0.06);
      head.rotation.y = calm ? 0 : Math.sin(t * 5) * 0.1;
      body.position.y = ROBOT_LIFT + (calm ? 0 : (1 - Math.cos(t * 18)) * 0.004);
      arms.forEach(({ shoulder, elbow }, i) => {
        shoulder.rotation.set(-0.85 + (calm ? 0 : Math.sin(t * 20 + i * Math.PI) * 0.2), 0, i === 0 ? 0.22 : -0.22);
        elbow.rotation.x = -0.68 + (calm ? 0 : Math.sin(t * 20 + i * Math.PI) * 0.28);
      });
      break;
    case "think":
      head.rotation.z = -0.18 + (calm ? 0 : Math.sin(beat) * 0.07);
      head.rotation.x = -0.07;
      arms[1].shoulder.rotation.set(-0.7, 0, -0.38);
      arms[1].elbow.rotation.x = -1.6;
      body.position.y = ROBOT_LIFT + breathe;
      break;
    case "wave": {
      const wave = calm ? 0 : Math.sin(t * 9) * 0.35;
      arms[1].shoulder.rotation.set(0, 0, 2.5 + wave * 0.3);
      arms[1].elbow.rotation.set(0, 0, wave);
      head.rotation.z = calm ? 0 : Math.sin(t * 3) * 0.08;
      body.position.y = ROBOT_LIFT + breathe;
      break;
    }
    case "raise":
      // A hand up and held there: it is waiting on the person.
      arms[1].shoulder.rotation.set(0, 0, 2.85);
      arms[1].elbow.rotation.set(0, 0, 0.1);
      head.rotation.x = -0.12;
      body.position.y = ROBOT_LIFT + breathe;
      break;
    case "dance": {
      const bounce = calm ? 0 : (1 - Math.cos(beat * 2)) / 2;
      const sway = calm ? 0 : Math.sin(beat);
      body.position.y = ROBOT_LIFT + bounce * 0.06;
      body.rotation.z = sway * 0.12;
      head.rotation.z = -Math.sin(beat - 0.35) * 0.18;
      arms.forEach(({ shoulder, elbow }, i) => {
        const side = i === 0 ? -1 : 1;
        shoulder.rotation.z = side * (0.7 + (calm ? 0 : Math.sin(beat + i * Math.PI) * 0.55));
        shoulder.rotation.x = calm ? 0 : Math.cos(beat + i * Math.PI) * 0.65;
        elbow.rotation.x = -0.35 - (calm ? 0 : (1 + Math.sin(beat + i)) * 0.4);
      });
      legs.forEach(({ hip, knee }, i) => {
        hip.rotation.x = calm ? 0 : Math.sin(beat + i * Math.PI) * 0.4;
        knee.rotation.x = calm ? 0 : Math.max(0, Math.sin(beat + i * Math.PI)) * 0.45;
      });
      break;
    }
    case "cheer": {
      const hop = calm ? 0 : Math.max(0, Math.sin(t * 7)) * 0.08;
      body.position.y = ROBOT_LIFT + hop;
      arms.forEach(({ shoulder, elbow }, i) => {
        shoulder.rotation.set(0, 0, i === 0 ? -2.6 : 2.6);
        elbow.rotation.set(0, 0, i === 0 ? -0.3 : 0.3);
      });
      head.rotation.x = -0.15;
      break;
    }
    case "register":
      body.position.y = ROBOT_LIFT + breathe;
      head.rotation.x = .15;
      arms[0].shoulder.rotation.x=-.65;
      arms[0].elbow.rotation.x=-.9;
      arms[1].shoulder.rotation.x=-.8;
      arms[1].elbow.rotation.x=-.9+(calm?0:Math.sin(t*8)*.12);
      break;
    case "talk":
      head.rotation.x = calm ? 0 : Math.sin(t * 6) * 0.05;
      head.rotation.y = calm ? 0 : Math.sin(t * 1.3) * 0.1;
      arms[1].shoulder.rotation.set(-0.55 + (calm ? 0 : Math.sin(t * 3) * 0.2), 0, 0.3);
      arms[1].elbow.rotation.x = -0.9;
      body.position.y = ROBOT_LIFT + breathe;
      break;
    default:
      body.position.y = ROBOT_LIFT + breathe;
      if (opts.bored) {
        // Bored: head down, arms hanging, a slow sway from foot to foot.
        head.rotation.x = 0.2;
        head.rotation.z = calm ? 0 : Math.sin(t * 0.6) * 0.06;
        body.rotation.z = calm ? 0 : Math.sin(t * 0.6) * 0.03;
        arms.forEach(({ shoulder }, i) => { shoulder.rotation.set(0.1, 0, i === 0 ? -0.05 : 0.05); });
      } else {
        head.rotation.y = calm ? 0 : Math.sin(t * 0.5) * 0.12;
      }
  }

  // A quick double blink, and eyes shut while asleep.
  const blinkTime = t % 3.4;
  const blink = !calm && (blinkTime > 3.02 && blinkTime < 3.12 || blinkTime > 3.24 && blinkTime < 3.33);
  const shut = pose === "sleep" || !!opts.asleep;
  for (const eye of eyes) eye.scale.y = shut || blink ? 0.12 : 1;
  rig.eyeLight.color.copy(rig.glow);
  if (shut) rig.eyeLight.color.multiplyScalar(0.55);
}

import {
  Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  OrthographicCamera, SphereGeometry, TorusGeometry,
} from "three";
import type { BufferGeometry, Material } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { ROBOT_DESIGNS } from "./mascotDesign";
import type { MascotState, RobotBody } from "./mascotDesign";

export function createMascotCamera() {
  const camera = new OrthographicCamera(-2.22, 2.22, 2.22, -2.22, .1, 30);
  camera.position.set(2.5, 1.8, 9);
  camera.lookAt(0, .27, 0);
  camera.updateMatrixWorld();
  return camera;
}

/** One articulated, procedural toy per base model. Pi shares its model's rig. */
export function createRobot(body: RobotBody) {
  const design = ROBOT_DESIGNS[body];
  const accent = new Color(design.color);
  const shell = new MeshStandardMaterial({ color: accent.clone().lerp(new Color("#ffffff"), .63), roughness: .3, metalness: .16 });
  const trim = new MeshStandardMaterial({ color: accent, roughness: .32, metalness: .35 });
  const joint = new MeshStandardMaterial({ color: "#283943", roughness: .5, metalness: .55 });
  const glass = new MeshStandardMaterial({ color: "#0c1c28", roughness: .21, metalness: .22 });
  const light = new MeshBasicMaterial({ color: accent.clone().lerp(new Color("#ffffff"), .35) });
  const eyeLight = light.clone();
  const terminalLight = new MeshBasicMaterial({ color: "#91eec3" });
  const geometries = new Set<BufferGeometry>();
  const materials: Material[] = [shell, trim, joint, glass, light, eyeLight, terminalLight];
  const sphere = new SphereGeometry(1, 16, 12);
  const rounded = new RoundedBoxGeometry(1, 1, 1, 2, .18);
  geometries.add(sphere); geometries.add(rounded);

  function mesh(parent: Group, geometry: BufferGeometry, material: Material,
    x: number, y: number, z: number, sx = 1, sy = sx, sz = sx) {
    geometries.add(geometry);
    const part = new Mesh(geometry, material);
    part.position.set(x, y, z); part.scale.set(sx, sy, sz); parent.add(part);
    return part;
  }
  const box = (p: Group, m: Material, x: number, y: number, z: number, w: number, h: number, d: number) => mesh(p, rounded, m, x, y, z, w, h, d);
  const ball = (p: Group, m: Material, x: number, y: number, z: number, r: number) => mesh(p, sphere, m, x, y, z, r);
  const group = (p: Group, name: string, x = 0, y = 0, z = 0) => {
    const g = new Group(); g.name = name; g.position.set(x, y, z); p.add(g); return g;
  };
  const root = new Group(); root.name = body;
  const torso = group(root, "torso");
  box(torso, shell, 0, -.06, 0, design.bodyWidth, .93, .68);
  box(torso, trim, 0, -.48, .015, design.bodyWidth * .78, .13, .59);
  box(torso, glass, 0, .02, .349, .44, .35, .06);
  const core = mesh(torso, new CylinderGeometry(.115, .115, .045, body === "astra" ? 4 : 24), light, 0, .035, .394);
  core.rotation.x = Math.PI / 2;
  for (const x of [-.1, 0, .1]) box(torso, joint, x, -.27, .35, .05, .045, .025);
  ball(torso, joint, 0, .48, 0, .16);

  const head = group(root, "head", 0, 1.03);
  mesh(head, new RoundedBoxGeometry(design.width, 1.05, .89, 3, design.roundness), shell, 0, 0, 0);
  box(head, trim, 0, -.03, .424, design.width * .88, .79, .13);
  box(head, glass, 0, -.025, .499, design.width * .79, .66, .075);
  // A small reflected strip makes the visor read as curved glass at icon size.
  box(head, joint, -.16, .23, .542, .56, .024, .014);
  const eyes = [-1, 1].map(side => {
    const eye = group(head, side < 0 ? "left-eye" : "right-eye", side * .255, .01, .555);
    if (body === "codex") {
      for (const y of [-1, 1]) {
        const bar = box(eye, eyeLight, 0, y * .07, 0, .065, .2, .035);
        bar.rotation.z = side * y * .75;
      }
    } else {
      box(eye, eyeLight, 0, 0, 0, body === "terra" ? .19 : .15, .23, .035);
    }
    return eye;
  });
  const smile = mesh(head, new TorusGeometry(.095, .019, 6, 16, Math.PI), light, 0, -.16, .56);
  smile.rotation.z = Math.PI;
  const antenna = group(head, "antenna");
  const earX = design.width / 2 + .06;
  for (const side of [-1, 1]) {
    if (body === "astra" || body === "haiku") {
      const fin = box(head, trim, side * earX, .03, -.01, .14, .64, .37);
      fin.rotation.z = side * -.35;
    } else {
      const ear = mesh(head, new CylinderGeometry(.2, .2, .15, 16), trim, side * earX, -.02, 0);
      ear.rotation.z = Math.PI / 2;
      if (body === "terra") {
        for (const y of [-.16, 0, .16]) box(head, joint, side * (earX + .06), y, .1, .16, .07, .22);
      }
    }
  }
  switch (body) {
    case "opus": {
      const halo = mesh(antenna, new TorusGeometry(.38, .045, 8, 32), light, 0, .79, 0);
      halo.rotation.x = Math.PI / 2 - .12;
      break;
    }
    case "fable":
      box(antenna, trim, 0, .55, 0, .92, .13, .4);
      for (const x of [-.32, 0, .32]) mesh(antenna, new CylinderGeometry(0, .16, x === 0 ? .42 : .3, 4), trim, x, .72, 0);
      ball(antenna, light, 0, .97, 0, .075);
      break;
    case "astra":
      box(antenna, joint, 0, .63, 0, .045, .22, .045);
      for (const r of [0, Math.PI / 2]) {
        const star = box(antenna, light, 0, .85, 0, .075, .37, .075); star.rotation.z = r;
      }
      break;
    case "haiku": {
      const leaf = mesh(antenna, sphere, trim, .32, .7, 0, .1, .32, .07); leaf.rotation.z = -.55;
      break;
    }
    case "luna": {
      const crescent = mesh(antenna, new TorusGeometry(.23, .065, 8, 24, Math.PI * 1.45), light, .28, .69, .02);
      crescent.rotation.z = .55;
      break;
    }
    case "terra":
      for (const x of [-.4, .4]) {
        box(antenna, joint, x, .62, 0, .045, .2, .045);
        box(antenna, light, x, .75, 0, .18, .12, .14);
      }
      break;
    case "sol":
      for (const angle of [-.8, -.4, 0, .4, .8]) {
        const ray = box(antenna, trim, Math.sin(angle) * .63, Math.cos(angle) * .62, 0, .07, .21, .08);
        ray.rotation.z = -angle;
      }
      ball(antenna, light, 0, .86, 0, .09);
      break;
    case "claude":
      for (const angle of [0, Math.PI / 3, -Math.PI / 3]) {
        const ray = box(antenna, light, 0, .73, 0, .055, .34, .07); ray.rotation.z = angle;
      }
      break;
    default:
      box(antenna, joint, 0, .64, 0, .055, .23, .055);
      if (body === "codex") box(antenna, light, 0, .8, 0, .3, .13, .14);
      else ball(antenna, light, 0, .8, 0, .12);
  }

  const arms = [-1, 1].map(side => {
    const shoulder = group(root, side < 0 ? "left-arm" : "right-arm", side * (design.bodyWidth / 2 + .13), .27);
    ball(shoulder, joint, 0, 0, 0, .145);
    box(shoulder, shell, 0, -.2, 0, .24, .34, .28);
    const elbow = group(shoulder, "elbow", 0, -.38);
    ball(elbow, joint, 0, 0, 0, .11);
    box(elbow, trim, 0, -.16, 0, .23, .25, .26);
    ball(elbow, shell, 0, -.34, .02, .16);
    box(elbow, joint, 0, -.39, .14, .045, .11, .025);
    return { shoulder, elbow };
  });
  const legs = [-1, 1].map(side => {
    const hip = group(root, side < 0 ? "left-leg" : "right-leg", side * design.bodyWidth * .29, -.58);
    ball(hip, joint, 0, 0, 0, .13);
    box(hip, shell, 0, -.18, 0, .26, .33, .3);
    const knee = group(hip, "knee", 0, -.36);
    ball(knee, joint, 0, 0, 0, .115);
    box(knee, trim, 0, -.13, 0, .26, .22, .28);
    box(knee, shell, 0, -.3, .12, body === "terra" ? .48 : .39, .25, .57);
    box(knee, joint, 0, -.4, .13, body === "terra" ? .49 : .4, .055, .56);
    return { hip, knee };
  });

  // The console appears only during work. Arms reach forward and alternate
  // keystrokes; the head follows the screen instead of performing the idle jig.
  const terminal = group(root, "terminal", 0, -.31, .92);
  box(terminal, joint, 0, 0, 0, 1.03, .1, .59);
  for (const x of [-.3, -.1, .1, .3]) {
    for (const z of [-.13, .03, .19]) box(terminal, trim, x, .058, z, .12, .025, .085);
  }
  const screen = group(terminal, "screen", 0, .32, .27);
  screen.rotation.x = -.12;
  box(screen, trim, 0, 0, 0, 1.07, .67, .08);
  box(screen, glass, 0, 0, .046, .94, .54, .025);
  for (const [i, width] of [.36, .59, .43].entries()) {
    box(screen, terminalLight, (width - .68) / 2, .14 - i * .115, .064, width, .028, .015);
  }
  const cursor = box(screen, light, .26, -.13, .065, .08, .045, .015);
  terminal.visible = false;

  return {
    root, head, antenna, torso, arms, legs, eyes, core, terminal, cursor, eyeLight, light, body,
    dispose() { geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); },
  };
}

export type RobotRig = ReturnType<typeof createRobot>;

/** Absolute poses avoid accumulating transforms when a cached rig changes mood. */
export function poseRobot(rig: RobotRig, state: MascotState, seconds: number, reducedMotion = false) {
  const { root, head, arms, legs, eyes, terminal, cursor, antenna, core, eyeLight, light } = rig;
  const moving = !state.asleep && !reducedMotion && state.mood !== "still";
  const t = moving ? seconds : 0;
  const beat = t * Math.PI * 2 / ROBOT_DESIGNS[rig.body].beat;
  const sway = Math.sin(beat);
  root.position.set(0, 0, 0); root.rotation.set(0, 0, 0);
  head.rotation.set(0, 0, 0); antenna.rotation.set(0, 0, 0);
  core.scale.setScalar(1);
  arms.forEach(({ shoulder, elbow }, i) => {
    shoulder.rotation.set(0, 0, i === 0 ? -.13 : .13);
    elbow.rotation.set(-.12, 0, 0);
  });
  legs.forEach(({ hip, knee }) => { hip.rotation.set(0, 0, 0); knee.rotation.set(0, 0, 0); });
  terminal.visible = state.mood === "work" && !state.asleep;
  cursor.visible = !moving || Math.sin(t * 5) > -.4;
  terminal.position.y = -.31;
  if (state.asleep) {
    head.rotation.x = .16; head.rotation.z = -.09;
    root.position.y = -.055;
  } else if (state.mood === "idle") {
    root.rotation.z = moving ? sway * .095 : 0;
    root.rotation.y = moving ? Math.sin(beat * .5) * .19 : 0;
    root.position.y = moving ? Math.abs(Math.sin(beat)) * .12 : 0;
    head.rotation.z = moving ? -sway * .13 : 0;
    head.rotation.y = moving ? Math.sin(beat) * .1 : 0;
    arms.forEach(({ shoulder, elbow }, i) => {
      const side = i === 0 ? -1 : 1;
      shoulder.rotation.z = side * (.5 + (moving ? Math.sin(beat + i * Math.PI) * .42 : 0));
      shoulder.rotation.x = moving ? Math.cos(beat + i * Math.PI) * .45 : 0;
      elbow.rotation.x = -.35 - (moving ? (1 + Math.sin(beat + i)) * .3 : 0);
    });
    legs.forEach(({ hip, knee }, i) => {
      hip.rotation.x = moving ? Math.sin(beat + i * Math.PI) * .3 : 0;
      knee.rotation.x = moving ? Math.max(0, Math.sin(beat + i * Math.PI)) * .35 : 0;
    });
  } else if (state.mood === "think") {
    head.rotation.z = -.13 + (moving ? sway * .05 : 0);
    head.rotation.y = moving ? sway * .16 : .08;
    arms[1].shoulder.rotation.set(-.7, 0, -.38);
    arms[1].elbow.rotation.x = -1.6;
    root.rotation.y = -.08;
  } else if (state.mood === "work") {
    head.rotation.x = .13 + (moving ? Math.sin(t * 3.2) * .045 : 0);
    head.rotation.y = moving ? Math.sin(t * 2) * .075 : 0;
    arms.forEach(({ shoulder, elbow }, i) => {
      shoulder.rotation.set(-.85 + (moving ? Math.sin(t * 12 + i * Math.PI) * .12 : 0), 0, i === 0 ? .22 : -.22);
      elbow.rotation.x = -.68 + (moving ? Math.sin(t * 12 + i * Math.PI) * .19 : 0);
    });
  }
  const blink = moving && t % 4.7 > 4.48 ? .12 : 1;
  eyes.forEach((eye, i) => { eye.scale.y = state.asleep ? .12 : (i === 1 && moving && (t + .045) % 4.7 > 4.48 ? .12 : blink); });
  eyeLight.color.set(state.alert ? "#ffbb62" : light.color);
  if (state.asleep) eyeLight.color.multiplyScalar(.55);
}

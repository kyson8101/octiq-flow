import { describe, expect, it } from "vitest";
import { Box3, Vector3 } from "three";
import { MODELS } from "./agentProviders";
import { ROBOT_DESIGNS, robotBody } from "./mascotDesign";
import type { MascotState, RobotBody } from "./mascotDesign";
import { createMascotCamera, createRobot, poseRobot } from "./mascotScene";
import type { RobotRig } from "./mascotScene";

const idle: MascotState = { mood: "idle", alert: false, asleep: false };
function transforms(rig: RobotRig) {
  rig.root.updateMatrixWorld(true);
  const out: number[] = [];
  rig.root.traverse(part => { out.push(...part.matrixWorld.elements); });
  return out;
}

describe("full-body Three.js robots", () => {
  it("covers every model, sharing Codex bodies with Pi", () => {
    for (const model of MODELS) expect(ROBOT_DESIGNS[robotBody(model.composerStyle)]).toBeDefined();
    expect(robotBody("pi-terra")).toBe("terra");
    expect(robotBody("pi")).toBe("codex");
  });

  it.each(Object.keys(ROBOT_DESIGNS) as RobotBody[])("keeps %s articulated and inside its frame throughout every animation", body => {
    const rig = createRobot(body);
    const camera = createMascotCamera();
    try {
      expect(rig.root.getObjectByName("torso")).toBeDefined();
      for (const side of ["left", "right"]) {
        expect(rig.root.getObjectByName(`${side}-arm`)).toBeDefined();
        expect(rig.root.getObjectByName(`${side}-leg`)).toBeDefined();
      }
      for (const mood of ["idle", "think", "work"] as const) {
        for (let t = 0; t < 6; t += .25) {
          poseRobot(rig, { ...idle, mood }, t);
          const bounds = new Box3().setFromObject(rig.root);
          for (const x of [bounds.min.x, bounds.max.x]) {
            for (const y of [bounds.min.y, bounds.max.y]) {
              for (const z of [bounds.min.z, bounds.max.z]) {
                const projected = new Vector3(x, y, z).project(camera);
                expect(Math.abs(projected.x)).toBeLessThan(.98);
                expect(Math.abs(projected.y)).toBeLessThan(.98);
              }
            }
          }
        }
      }
    } finally { rig.dispose(); }
  });

  it("dances with both arms and legs, then types at a console during work", () => {
    const rig = createRobot("sonnet");
    try {
      poseRobot(rig, idle, .3);
      const danceArm = rig.arms[0].shoulder.rotation.x;
      const danceLeg = rig.legs[0].hip.rotation.x;
      poseRobot(rig, idle, .8);
      expect(rig.arms[0].shoulder.rotation.x).not.toBe(danceArm);
      expect(rig.legs[0].hip.rotation.x).not.toBe(danceLeg);
      expect(rig.terminal.visible).toBe(false);
      poseRobot(rig, { ...idle, mood: "work" }, .3);
      expect(rig.terminal.visible).toBe(true);
      expect(rig.legs[0].hip.rotation.x).toBe(0);
      expect(rig.arms[0].elbow.rotation.x).not.toBe(rig.arms[1].elbow.rotation.x);
    } finally { rig.dispose(); }
  });

  it("holds sleeping and reduced-motion poses regardless of elapsed time", () => {
    const rig = createRobot("luna");
    try {
      for (const state of [idle, { ...idle, mood: "work" as const }]) {
        poseRobot(rig, state, 1, true);
        const first = transforms(rig);
        poseRobot(rig, state, 8, true);
        expect(transforms(rig)).toEqual(first);
      }
      poseRobot(rig, { ...idle, mood: "work", asleep: true }, 1);
      const asleep = transforms(rig);
      poseRobot(rig, { ...idle, mood: "work", asleep: true }, 8);
      expect(transforms(rig)).toEqual(asleep);
      expect(rig.terminal.visible).toBe(false);
      expect(rig.eyes.every(e => e.scale.y < .2)).toBe(true);
    } finally { rig.dispose(); }
  });

  it("resets a shared rig when work, sleep and alerts change", () => {
    const rig = createRobot("terra");
    try {
      poseRobot(rig, idle, 2);
      const before = transforms(rig);
      const eyeColor = rig.eyeLight.color.clone();
      poseRobot(rig, { mood: "work", alert: true, asleep: true }, 5);
      expect(rig.eyeLight.color.equals(eyeColor)).toBe(false);
      poseRobot(rig, idle, 2);
      expect(transforms(rig)).toEqual(before);
      expect(rig.eyeLight.color.equals(eyeColor)).toBe(true);
    } finally { rig.dispose(); }
  });
});

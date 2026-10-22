import { describe, expect, it } from "vitest";
import { Box3, Vector3 } from "three";
import { ANTENNAS, EYES, FRAMES, type Look } from "./model";
import { HIP_HEIGHT, createIslandRobot, poseIslandRobot, type Pose } from "./robot";

const look = (over: Partial<Look> = {}): Look => ({
  frame: "round", shell: "#f3efe6", trim: "#7aa5d6", glow: "#9fe8ff", eyes: "pill", antenna: "ball", worn: {}, ...over,
});

const POSES: Pose[] = ["stand", "walk", "sit", "work", "think", "wave", "raise", "sleep", "dance", "cheer", "talk", "swing", "ride", "climb", "sob"];

describe("a chibi robot", () => {
  // Keep all 384 combinations, but give each frame/eye its own case: one
  // synchronous test building/merging 384 real meshes starved the full suite.
  it.each(FRAMES.flatMap(frame => EYES.map(eyes => ({ frame, eyes }))))("is made in frame $frame with eyes $eyes and every antenna", ({ frame, eyes }) => {
    for (const antenna of ANTENNAS) {
      const rig = createIslandRobot(look({ frame, eyes, antenna }));
      expect(rig.root.getObjectByName("head")).toBeDefined();
      rig.dispose();
    }
  });

  it("stands 1 m tall with its feet on the ground", () => {
    const rig = createIslandRobot(look({ antenna: "none" }));
    poseIslandRobot(rig, "stand", 0, { calm: true });
    rig.root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(rig.root);
    expect(bounds.min.y).toBeGreaterThan(-0.02);
    expect(bounds.min.y).toBeLessThan(0.02);
    expect(bounds.max.y).toBeGreaterThan(0.97);
    expect(bounds.max.y).toBeLessThan(1.06);
    rig.dispose();
  });

  it("hangs what it wears where docs/island.md says", () => {
    const rig = createIslandRobot(look());
    poseIslandRobot(rig, "stand", 0, { calm: true });
    rig.root.updateMatrixWorld(true);
    const at = (slot: keyof typeof rig.anchors) => rig.anchors[slot].getWorldPosition(new Vector3());
    expect(at("head").y).toBeCloseTo(1.0, 1);
    expect(at("face").y).toBeCloseTo(0.7, 1);
    expect(at("face").z).toBeCloseTo(0.29, 1);
    expect(at("neck").y).toBeCloseTo(0.43, 1);
    expect(at("back").y).toBeCloseTo(0.3, 1);
    expect(at("back").z).toBeCloseTo(-0.08, 1);
    // An anchor counts in metres: its own scale undoes the rig's.
    const scale = rig.anchors.head.getWorldScale(new Vector3());
    expect(scale.x).toBeCloseTo(1, 5);
    rig.dispose();
  });

  it("sits with its hips where it is put", () => {
    const rig = createIslandRobot(look());
    poseIslandRobot(rig, "sit", 0, { calm: true });
    rig.root.updateMatrixWorld(true);
    const hip = rig.legs[0].hip.getWorldPosition(new Vector3());
    expect(hip.y).toBeCloseTo(0, 1);
    expect(HIP_HEIGHT).toBeGreaterThan(0.15);
    rig.dispose();
  });

  it("holds every pose without a turn left over from the last one", () => {
    const rig = createIslandRobot(look());
    for (const pose of POSES) {
      for (let t = 0; t < 3; t += 0.37) {
        poseIslandRobot(rig, pose, t, { stride: t % 1, lean: Math.sin(t) * 0.5, bored: pose === "stand" });
        rig.root.updateMatrixWorld(true);
        rig.root.traverse((part) => {
          // Check every matrix entry without allocating 16 assertion chains
          // per part on every frame (tens of thousands in this pose sweep).
          expect(part.matrixWorld.elements.every(Number.isFinite), part.name).toBe(true);
        });
      }
    }
    poseIslandRobot(rig, "dance", 1.3);
    poseIslandRobot(rig, "stand", 0, { calm: true });
    expect(rig.arms[0].shoulder.rotation.x).toBe(0);
    expect(rig.terminal.visible).toBe(false);
    poseIslandRobot(rig, "work", 0, { calm: true });
    expect(rig.terminal.visible).toBe(true);
    poseIslandRobot(rig, "work", 0, { calm: true, console: false });
    expect(rig.terminal.visible).toBe(false);
    rig.dispose();
  });

  it("puts what it wears on and takes it off again", () => {
    const rig = createIslandRobot(look());
    const hat = new Box3();
    void hat;
    const item = createIslandRobot(look()).root;
    rig.wear("head", item);
    expect(rig.anchors.head.children).toContain(item);
    rig.wear("head", null);
    expect(rig.anchors.head.children).toHaveLength(0);
    rig.dispose();
  });
});

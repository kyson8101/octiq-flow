import { describe, expect, it } from "vitest";
import {
  PLAZA_RADIUS, TILE, cellAt, cellCenter, defaultAgentLook, facingFor, onTile, plotNames, plotToWorld, residentsOf,
  ringCells, ringOf, withPatch, worldToPlot, type Island, type Plot,
} from "./model";
import { PLAYGROUND_CELL } from "./playground";

const island = (over: Partial<Island> = {}): Island => ({
  version: 1, rev: 1, seed: 1, createdAt: 0, updatedAt: 0, radius: 40, settings: { wishPace: "sometimes" },
  plots: [], bots: [], looks: {}, assets: [], placed: [], wishes: [], lastRollAt: 0, ...over,
});

const plotOn = (id: string, ring: number, slot: number, owner: Plot["owner"], members?: string[]): Plot => {
  const [q, r] = ringCells(ring)[slot];
  const { x, z } = cellCenter(q, r);
  return { id, owner, ring, slot, q, r, x, z, facing: facingFor(x, z), radius: TILE, claimedAt: 0, ...(members ? { members } : {}) };
};

describe("the honeycomb", () => {
  it("has 6k distinct cells on ring k, every one k steps from the plaza", () => {
    expect(ringCells(0)).toEqual([[0, 0]]);
    for (let k = 1; k <= 4; k++) {
      const cells = ringCells(k);
      expect(cells).toHaveLength(6 * k);
      expect(new Set(cells.map((c) => c.join(","))).size).toBe(6 * k);
      for (const [q, r] of cells) expect(ringOf(q, r)).toBe(k);
    }
  });

  it("walks ring 1 from (−1, 1) in the order the host gives out slots", () => {
    expect(ringCells(1)).toEqual([[-1, 1], [0, 1], [1, 0], [1, -1], [0, -1], [-1, 0]]);
    // The playground is the last cell of ring 1, so agents fill slots 0–4.
    expect(ringCells(1)[5]).toEqual([PLAYGROUND_CELL.q, PLAYGROUND_CELL.r]);
  });

  it("finds the cell of any point on it, and puts neighbours 7·√3 apart", () => {
    for (let k = 0; k <= 4; k++) {
      for (const [q, r] of ringCells(k)) {
        const c = cellCenter(q, r);
        expect(cellAt(c.x, c.z)).toEqual([q, r]);
        expect(cellAt(c.x + 2, c.z - 2)).toEqual([q, r]);
      }
    }
    const a = cellCenter(0, 0);
    const b = cellCenter(1, 0);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(7 * Math.sqrt(3));
  });

  it("turns every plot's flat front edge towards the plaza", () => {
    for (const [q, r] of ringCells(1)) {
      const { x, z } = cellCenter(q, r);
      const f = (facingFor(x, z) * Math.PI) / 180;
      // A plot's +z in the world, against the way to the plaza.
      const front = { x: Math.sin(f), z: Math.cos(f) };
      const length = Math.hypot(x, z);
      expect(front.x).toBeCloseTo(-x / length);
      expect(front.z).toBeCloseTo(-z / length);
    }
    // Further out it is the nearest edge: never more than 30° off.
    for (const [q, r] of ringCells(3)) {
      const { x, z } = cellCenter(q, r);
      const f = (facingFor(x, z) * Math.PI) / 180;
      const toward = Math.atan2(-x, -z);
      const off = Math.abs(Math.atan2(Math.sin(f - toward), Math.cos(f - toward)));
      expect(off).toBeLessThanOrEqual(Math.PI / 6 + 1e-9);
    }
  });

  it("says what is on a tile: flat at the front and back, pointed at the sides", () => {
    const flat = (TILE * Math.sqrt(3)) / 2;
    expect(onTile(0, 0)).toBe(true);
    expect(onTile(0, flat - 0.01)).toBe(true);
    expect(onTile(0, flat + 0.01)).toBe(false);
    expect(onTile(TILE - 0.01, 0)).toBe(true);
    expect(onTile(TILE + 0.01, 0)).toBe(false);
    expect(onTile(TILE / 2 + 0.2, flat - 0.01)).toBe(false);
  });

  it("turns plot coordinates into the world and back as three.js does", () => {
    const plot = { x: 12, z: -5, facing: 150 };
    for (const [lx, lz] of [[0, 0], [1, 2], [-3.5, 4]]) {
      const w = plotToWorld(plot, lx, lz);
      const back = worldToPlot(plot, w.x, w.z);
      expect(back.x).toBeCloseTo(lx);
      expect(back.z).toBeCloseTo(lz);
    }
    // The front (+z) of a plot facing 90° points along +x.
    const ahead = plotToWorld({ x: 0, z: 0, facing: 90 }, 0, 1);
    expect(ahead.x).toBeCloseTo(1);
    expect(ahead.z).toBeCloseTo(0);
  });

  it("keeps the plaza the size of a cell", () => {
    expect(PLAZA_RADIUS).toBe(7);
  });
});

describe("looks", () => {
  it("dresses an agent by its model family, in the colour of its face", () => {
    const maya = defaultAgentLook({ id: "a1", agent: "claude", model: "opus" });
    expect(maya.antenna).toBe("halo");
    expect(maya.frame).toBe("round");
    const iris = defaultAgentLook({ id: "a2", agent: "codex", model: "" });
    expect(iris.antenna).toBe("bar");
    expect(iris.eyes).toBe("chevron");
    // Same model, two agents: two colours, each the same every time.
    const kai = defaultAgentLook({ id: "a3", agent: "claude", model: "opus" });
    expect(kai.trim).not.toBe(maya.trim);
    expect(defaultAgentLook({ id: "a1", agent: "claude", model: "opus" })).toEqual(maya);
    for (const colour of [maya.shell, maya.trim, maya.glow]) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("lays a patch over a look, and ignores what it cannot draw", () => {
    const base = defaultAgentLook({ id: "a1", agent: "claude", model: "sonnet" });
    const patched = withPatch(base, {
      trim: "#FF0000", eyes: "heart", antenna: "rocket" as never, frame: undefined, worn: { head: "a_hat" },
    });
    expect(patched.trim).toBe("#ff0000");
    expect(patched.eyes).toBe("heart");
    expect(patched.antenna).toBe(base.antenna);
    expect(patched.frame).toBe(base.frame);
    expect(patched.worn).toEqual({ head: "a_hat" });
    expect(withPatch(base, { shell: "red" }).shell).toBe(base.shell);
  });
});

describe("who lives here", () => {
  const roster = [
    { id: "a1", name: "Maya", agent: "claude" as const, model: "opus" },
    { id: "a2", name: "Kai", agent: "claude" as const, model: "sonnet" },
  ];
  const look = defaultAgentLook({ id: "x", agent: "claude", model: "opus" });

  it("puts each agent on its own plot and leaves out one that has none yet", () => {
    const residents = residentsOf(island({ plots: [plotOn("p1", 1, 0, { kind: "agent", id: "a1" })] }), roster);
    expect(residents.map((r) => r.name)).toEqual(["Maya"]);
    expect(residents[0].key).toBe("agent:a1");
  });

  it("does not add legacy NPCs or their names to the registered island population", () => {
    const home = plotOn("p2", 2, 0, { kind: "home", id: "h1" }, ["b1", "b2", "b3"]);
    const data = island({
      plots: [home],
      bots: ["Pip", "Bolt", "Mochi"].map((name, i) => ({ id: `b${i + 1}`, name, trait: "cozy" as const, look, arrivedAt: 0 })),
    });
    const residents = residentsOf(data, []);
    expect(residents).toEqual([]);
    expect(plotNames(home, residents)).toBe("");
  });

  it("keeps a legacy NPC plot from inventing an unregistered resident", () => {
    const own = plotOn("p3", 2, 1, { kind: "bot", id: "b9" });
    const residents = residentsOf(island({ plots: [own], bots: [{ id: "b9", name: "Nib", trait: "curious", look, arrivedAt: 0 }] }), []);
    expect(residents).toEqual([]);
    expect(plotNames(own, residents)).toBe("");
  });
});

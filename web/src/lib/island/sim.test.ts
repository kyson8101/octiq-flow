import { describe, expect, it } from "vitest";
import { NavGrid } from "./nav";
import { IslandSim, isNight, seeded, type AgentMode, type Places, type Seat, type SimRobot } from "./sim";
import { TILE_TOP, defaultAgentLook, type Look, type Resident } from "./model";
import { buildPlayground } from "./playground";

const look: Look = { frame: "round", shell: "#ffffff", trim: "#88aaff", glow: "#aaffff", eyes: "pill", antenna: "ball", worn: {} };

function resident(key: string, name: string, plotId: string | null, extra: Partial<Resident> = {}): Resident {
  const [kind, id] = key.split(":") as ["agent" | "bot", string];
  return {
    key, owner: { kind, id }, name, look: kind === "agent" ? defaultAgentLook({ id, agent: "claude", model: "opus" }) : look,
    plot: plotId ? { id: plotId, owner: { kind, id }, ring: 1, slot: 0, q: 0, r: 0, x: 0, z: 0, facing: 0, radius: 6.3, claimedAt: 0 } : null,
    ...(kind === "bot" ? { trait: "sporty" as const } : {}),
    ...extra,
  };
}

/** A small island: a plot for each resident, the seats given, and the
 *  playground when asked for. */
function island(residents: Resident[], seats: Seat[] = [], withPlayground = false) {
  const plots = new Map(residents.filter((r) => r.plot).map((r, i) => {
    const center = { x: -12 + i * 8, z: 14 };
    return [r.key, { id: r.plot!.id, center, front: { x: center.x, z: center.z - 4, face: Math.PI }, door: { x: center.x, z: center.z - 4 } }];
  }));
  const playground = withPlayground ? buildPlayground({ x: -12.12, z: 0, facing: 90, shadows: false }) : null;
  const places: Places = {
    seats: [...seats, ...(playground?.seats ?? [])],
    plots, tree: { x: 0, z: 0 }, plaza: 7, radius: 30,
    ...(playground ? { playground: playground.anchors } : {}),
  };
  const nav = new NavGrid(30, playground?.solids ?? []);
  const sim = new IslandSim(nav, places, seeded(7));
  let now = 0;
  sim.reset(nav, places, residents, now);
  return {
    sim,
    robot: (key: string) => sim.robots.get(key)!,
    run(seconds: number, hour = 12, each?: (now: number) => void) {
      for (let t = 0; t < seconds; t += 0.1) {
        now += 0.1;
        sim.update(0.1, now, hour);
        each?.(now);
      }
    },
    now: () => now,
  };
}

const desk = (plot: string, x: number, z: number): Seat => ({ key: `desk:${plot}`, kind: "desk", x, z, y: TILE_TOP, face: 0, plot, name: "Desk" });
const bed = (plot: string, x: number, z: number): Seat => ({ key: `bed:${plot}`, kind: "bed", x, z, y: TILE_TOP + 0.42, face: 0, plot, name: "Bed" });
const modes = (entries: [string, AgentMode][]) => new Map(entries);
const standStill = (robot: SimRobot, at: { x: number; z: number }) => {
  robot.x = at.x;
  robot.z = at.z;
  robot.path = [];
  robot.plan = { label: "Looking around", goal: null, act: { kind: "look", seconds: 60 }, since: 0 };
};

describe("an agent's robot follows its real work", () => {
  it("goes to its desk and types while a turn is in flight", () => {
    const maya = resident("agent:a1", "Maya", "p1");
    const world = island([maya], [desk("p1", -12, 11)]);
    world.sim.setModes(modes([["agent:a1", { state: "working", label: "Fix the login page" }]]), world.now());
    world.run(30);
    const robot = world.robot("agent:a1");
    expect(robot.pose).toBe("work");
    expect(Math.hypot(robot.x + 12, robot.z - 11)).toBeLessThan(0.05);
    expect(robot.plan.label).toBe("Working · Fix the login page");
    expect(robot.bubble?.tone).toBe("work");
  });

  it("stands at the front of its plot with its hand up while a card waits on the person", () => {
    const kai = resident("agent:a2", "Kai", "p2");
    const world = island([kai]);
    world.sim.setModes(modes([["agent:a2", { state: "needs_you", label: "Plan to approve" }]]), world.now());
    world.run(30);
    const robot = world.robot("agent:a2");
    expect(robot.pose).toBe("raise");
    expect(robot.bubble).toMatchObject({ text: "?", tone: "decide" });
    expect(Math.hypot(robot.x + 12, robot.z - 10)).toBeLessThan(0.05);
  });

  it("is as bored as its real idle time, and jumps for joy when work comes", () => {
    const noor = resident("agent:a3", "Noor", "p3");
    const world = island([noor], [desk("p3", -12, 11)]);
    world.sim.setModes(modes([["agent:a3", { state: "free", idleFor: 300 }]]), world.now());
    const robot = world.robot("agent:a3");
    expect(robot.boredom).toBeGreaterThan(0.9);
    world.run(2);
    world.sim.setModes(modes([["agent:a3", { state: "working" }]]), world.now());
    expect(robot.bubble?.text).toBe("work! ✨");
    world.run(0.5);
    expect(robot.pose).toBe("cheer");
    expect(world.sim.mood("agent:a3")?.excited).toBe(true);
    world.run(4);
    // Off to its desk at a run, and not bored any more.
    expect(robot.boredom).toBe(0);
    world.run(20);
    expect(robot.pose).toBe("work");
  });

  it("makes no fuss for an agent already at work when the page first sees it", () => {
    const iris = resident("agent:a4", "Iris", "p4");
    const world = island([iris], [desk("p4", -12, 11)]);
    world.sim.setModes(modes([["agent:a4", { state: "working" }]]), world.now());
    expect(world.robot("agent:a4").bubble?.text).not.toBe("work! ✨");
  });
});

describe("a 波特's day", () => {
  it("sleeps in its own bed at night, and is up in the morning", () => {
    const pip = resident("bot:b1", "Pip", "h1");
    const world = island([pip], [bed("h1", -12, 16)]);
    world.run(40, 23.5);
    const robot = world.robot("bot:b1");
    expect(robot.pose).toBe("sleep");
    expect(robot.perched).toBe(true);
    expect(robot.y).toBeCloseTo(TILE_TOP + 0.42);
    expect(robot.bubble).toMatchObject({ text: "z", tone: "sleep" });
    world.run(2, 9);
    expect(robot.plan.act.kind).not.toBe("sleep");
  });

  it("knows when night is, each a little off the others", () => {
    expect(isNight(23)).toBe(true);
    expect(isNight(3)).toBe(true);
    expect(isNight(12)).toBe(false);
    expect(isNight(22.4, -20)).toBe(true);
    expect(isNight(22.6, 30)).toBe(false);
  });

  it("never shares a seat", () => {
    const bots = ["Pip", "Bolt", "Mochi", "Nori"].map((name, i) => resident(`bot:b${i}`, name, `h${i}`, { trait: "cozy" }));
    const bench: Seat = { key: "bench", kind: "seat", x: 0, z: 5, y: TILE_TOP + 0.3, face: 0, plot: null, name: "a bench" };
    const world = island(bots, [bench]);
    let most = 0;
    world.run(240, 12, () => {
      const on = [...world.sim.robots.values()].filter((r) => r.plan.act.kind === "sit" && r.perched && r.x === bench.x && r.z === bench.z);
      most = Math.max(most, on.length);
    });
    expect(most).toBeLessThanOrEqual(1);
  });

  it("says hi to whoever it passes, once in a while", () => {
    const pip = resident("bot:b1", "Pip", "h1");
    const bolt = resident("bot:b2", "Bolt", "h2");
    const world = island([pip, bolt]);
    standStill(world.robot("bot:b1"), { x: 0, z: 10 });
    standStill(world.robot("bot:b2"), { x: 1.2, z: 10 });
    world.run(0.5);
    for (const key of ["bot:b1", "bot:b2"]) {
      expect(["hi!", "👋"]).toContain(world.robot(key).bubble?.text);
      expect(world.robot(key).pose).toBe("wave");
    }
    world.robot("bot:b1").bubble = null;
    world.run(5);
    expect(world.robot("bot:b1").bubble).toBeNull();
  });

  it("does not greet a whole crowd at once or repeat a greeting while standing nearby", () => {
    const world = island([resident("bot:b1", "Pip", "h1"), resident("bot:b2", "Bolt", "h2"), resident("bot:b3", "Olive", "h3")]);
    for (const [i, robot] of [...world.sim.robots.values()].entries()) {
      standStill(robot, { x: i * .4, z: 10 });
      robot.plan.act = { kind: "look", seconds: 1000 };
    }
    world.run(.5);
    expect([...world.sim.robots.values()].filter(robot => robot.bubble?.text === "hi!" || robot.bubble?.text === "👋")).toHaveLength(2);
    for (const robot of world.sim.robots.values()) robot.bubble = null;
    world.run(40);
    expect([...world.sim.robots.values()].every(robot => !robot.bubble || !["hi!", "👋"].includes(robot.bubble.text))).toBe(true);
  });

  it("gets bored with nothing to do", () => {
    const world = island([resident("bot:b1", "Pip", "h1")]);
    const robot = world.robot("bot:b1");
    standStill(robot, { x: 0, z: 10 });
    robot.boredom = 0.5;
    world.run(30);
    expect(robot.boredom).toBeCloseTo(0.5 + 30 / (14 * 60), 2);
  });

  it("is less bored after a game", () => {
    const world = island([resident("bot:b1", "Pip", "h1"), resident("bot:b2", "Bolt", "h2", { trait: "sporty" })]);
    const robot = world.robot("bot:b1");
    standStill(robot, { x: 0, z: 10 });
    standStill(world.robot("bot:b2"), { x: 1.4, z: 10.5 });
    robot.boredom = 0.8;
    world.robot("bot:b2").boredom = 0.9;
    world.sim.invite("bot:b1", "bot:b2", "tag", world.now());
    world.run(20);
    expect(robot.boredom).toBeLessThan(0.8);
  });
});

/** Two friends standing near each other, the one asked bored enough to say
 *  yes. */
function friends(withPlayground = true) {
  const world = island([resident("bot:b1", "Pip", "h1"), resident("bot:b2", "Bolt", "h2")], [], withPlayground);
  standStill(world.robot("bot:b1"), { x: -2, z: 9 });
  standStill(world.robot("bot:b2"), { x: -0.6, z: 9.5 });
  world.robot("bot:b2").boredom = 0.95;
  return world;
}

describe("playing together", () => {
  it("answers a wave from the seesaw without waiting for a random play choice", () => {
    const world = friends();
    const friend = world.robot("bot:b2");
    friend.rng = () => 0;
    expect(world.sim.waitOnSeesaw("bot:b1", world.now())).toBe(true);
    let answered = false;
    let together = false;
    const tilts: number[] = [];
    world.run(45, 12, () => {
      if (friend.bubble?.text === "coming!") answered = true;
      const a = world.robot("bot:b1");
      if (a.plan.act.kind === "seesaw" && friend.plan.act.kind === "seesaw" && a.perched && friend.perched) {
        together = true;
        tilts.push(world.sim.motion.seesaw);
      }
    });
    expect(answered).toBe(true);
    expect(together).toBe(true);
    expect(Math.max(...tilts)).toBeGreaterThan(0.15);
    expect(Math.min(...tilts)).toBeLessThan(-0.15);
  });

  it("tries another friend after a refusal instead of repeatedly asking the same robot", () => {
    const world = island([
      resident("bot:b1", "Pip", "h1"), resident("bot:b2", "Bolt", "h2"), resident("bot:b3", "Olive", "h3"),
    ], [], true);
    const no = world.robot("bot:b2");
    const yes = world.robot("bot:b3");
    standStill(no, { x: -12, z: 5 });
    standStill(yes, { x: -12, z: 8 });
    no.rng = () => 0.999;
    yes.rng = () => 0;
    world.robot("bot:b1").rng = () => 0;
    world.sim.waitOnSeesaw("bot:b1", world.now());
    let declined = false;
    let joined = false;
    world.run(30, 12, () => {
      if (no.bubble?.text === "maybe later") declined = true;
      if (yes.plan.act.kind === "seesaw" && yes.perched) joined = true;
    });
    expect(declined).toBe(true);
    expect(joined).toBe(true);
  });

  it("leaves a working agent and a sleeping 波特 alone when asking for a seesaw partner", () => {
    const world = island([
      resident("bot:b1", "Pip", "h1"), resident("agent:a1", "Maya", "h2"), resident("bot:b2", "Bolt", "h3"),
    ], [], true);
    world.sim.setModes(modes([["agent:a1", { state: "working" }]]), world.now());
    const asleep = world.robot("bot:b2");
    asleep.plan = { label: "Asleep", goal: null, act: { kind: "sleep", seat: null }, since: 0 };
    world.sim.waitOnSeesaw("bot:b1", world.now());
    world.run(15, 23.5);
    expect(world.robot("agent:a1").plan.act.kind).toBe("work");
    expect(asleep.plan.act.kind).toBe("sleep");
  });

  it("rocks the seesaw only when both ends are taken", () => {
    const world = friends();
    world.sim.invite("bot:b1", "bot:b2", "seesaw", world.now());
    const tilts: number[] = [];
    world.run(40, 12, () => {
      const a = world.robot("bot:b1").plan.act;
      const b = world.robot("bot:b2").plan.act;
      if (a.kind === "seesaw" && b.kind === "seesaw" && world.robot("bot:b1").perched && world.robot("bot:b2").perched) {
        tilts.push(world.sim.motion.seesaw);
      }
    });
    expect(tilts.length).toBeGreaterThan(20);
    expect(Math.max(...tilts)).toBeGreaterThan(0.15);
    expect(Math.min(...tilts)).toBeLessThan(-0.15);
  });

  it("waits on the seesaw alone, waving someone over, and cries when nobody comes", () => {
    const world = island([resident("bot:b1", "Pip", "h1")], [], true);
    const robot = world.robot("bot:b1");
    expect(world.sim.waitOnSeesaw("bot:b1", world.now())).toBe(true);
    let waved = false;
    let cried = false;
    world.run(40, 12, () => {
      if (robot.plan.act.kind === "seesaw" && robot.perched && robot.bubble?.text === "🙋") waved = true;
      if (robot.pose === "sob") cried = true;
    });
    expect(waved).toBe(true);
    expect(cried).toBe(true);
  });

  it("can still be refused by every awake friend and sob when nobody joins", () => {
    const world = friends();
    const friend = world.robot("bot:b2");
    friend.rng = () => 0.999;
    world.sim.waitOnSeesaw("bot:b1", world.now());
    let refused = false;
    let cried = false;
    world.run(40, 12, () => {
      if (friend.bubble?.text === "maybe later") refused = true;
      if (world.robot("bot:b1").pose === "sob") cried = true;
    });
    expect(refused).toBe(true);
    expect(cried).toBe(true);
  });

  it("swings higher and higher, sitting on the seat wherever it is", () => {
    const world = friends();
    world.sim.invite("bot:b1", "bot:b2", "swings", world.now());
    let widest = 0;
    world.run(25, 12, () => { widest = Math.max(widest, Math.abs(world.sim.motion.swings[0])); });
    expect(widest).toBeGreaterThan(0.3);
    const robot = world.robot("bot:b1");
    expect(robot.plan.act.kind).toBe("swing");
    expect(robot.pose).toBe("swing");
    expect(robot.perched).toBe(true);
  });

  it("takes turns up the ladder and down the slide", () => {
    const world = friends();
    world.sim.invite("bot:b1", "bot:b2", "slide", world.now());
    const highest = new Map<string, number>();
    const rode = new Set<string>();
    world.run(60, 12, () => {
      for (const robot of world.sim.robots.values()) {
        if (robot.perched) highest.set(robot.key, Math.max(highest.get(robot.key) ?? 0, robot.y));
        if (robot.pose === "ride") rode.add(robot.key);
      }
      // Never both on the slide at once.
      const up = [...world.sim.robots.values()].filter((r) => r.pose === "climb" || r.pose === "ride");
      expect(up.length).toBeLessThanOrEqual(1);
    });
    expect(rode).toEqual(new Set(["bot:b1", "bot:b2"]));
    for (const key of ["bot:b1", "bot:b2"]) expect(highest.get(key)).toBeGreaterThan(TILE_TOP + 1.2);
  });

  it("plays tag: the chaser catches up and they swap", () => {
    const world = friends(false);
    world.sim.invite("bot:b1", "bot:b2", "tag", world.now());
    let tagged = 0;
    world.run(30, 12, () => {
      for (const robot of world.sim.robots.values()) if (robot.bubble?.text === "tag!" && robot.bubble.until > world.now() + 1.3) tagged++;
    });
    expect(tagged).toBeGreaterThan(0);
  });

  it("asks a friend first, walking over to them", () => {
    const world = friends();
    standStill(world.robot("bot:b2"), { x: 6, z: 12 });
    world.sim.invite("bot:b1", "bot:b2", "swings", world.now());
    expect(world.robot("bot:b1").plan.label).toBe("Asking Bolt to play");
    let asked = false;
    world.run(20, 12, () => {
      if (world.robot("bot:b2").bubble?.text === "yes!") asked = true;
    });
    expect(asked).toBe(true);
    expect(world.robot("bot:b2").plan.label).toMatch(/Pip/);
  });

  it("cries when the friend it asked says no", () => {
    const world = friends();
    const bolt = world.robot("bot:b2");
    // Not bored at all, and comfortable where it is: it says no.
    bolt.boredom = 0;
    bolt.resident = { ...bolt.resident, trait: "cozy" };
    expect(world.sim.invite("bot:b1", "bot:b2", "tag", world.now(), { answer: "no" })).toBe(true);
    let declined = false;
    let cried = false;
    world.run(8, 12, () => {
      if (["not now 😅", "maybe later", "sorry!"].includes(bolt.bubble?.text ?? "")) declined = true;
      if (world.robot("bot:b1").pose === "sob" && world.robot("bot:b1").bubble?.text === "😭") cried = true;
    });
    expect(declined).toBe(true);
    expect(cried).toBe(true);
    expect(world.robot("bot:b1").boredom).toBeGreaterThan(0);
  });

  it("is mostly said yes to by a friend who is bored", () => {
    let yes = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const world = friends();
      world.robot("bot:b2").rng = seeded(seed);
      world.sim.invite("bot:b1", "bot:b2", "tag", world.now());
      world.run(3);
      if (world.robot("bot:b2").plan.act.kind === "tag") yes++;
    }
    expect(yes).toBeGreaterThan(24);
  });
});

describe("a home changing", () => {
  it("brings its 波特 home to build on it together", () => {
    const pip = resident("bot:b1", "Pip", "h1");
    const world = island([pip]);
    world.sim.buildHome("h1", world.now());
    const robot = world.robot("bot:b1");
    expect(robot.plan.label).toBe("Building our home together");
    expect(robot.bubble?.text).toBe("🔨");
  });
});

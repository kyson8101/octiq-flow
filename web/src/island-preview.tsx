/** Development-only visual review: open /island.html on the Vite server. The
 *  island drawn from a made-up one in the host's shape (docs/island.md), with
 *  no server behind it: agents set working or waiting by hand, and the hour
 *  moved by a slider. */
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { IslandView } from "./lib/island/scene";
import {
  TILE, cellCenter, facingFor, residentsOf, ringCells, type Asset, type Bot, type Island, type IslandAgent, type Look, type Part, type Placement, type Plot, type Wish,
} from "./lib/island/model";
import type { AgentMode } from "./lib/island/sim";
import { bridge } from "./lib/bridge";
import IslandPage from "./components/IslandPage";
import { ConfirmProvider } from "./components/Confirm";
import "./design-system.css";
import "./styles.css";

const p = (shape: Part["shape"], size: Part["size"], at: Part["at"], color: string, extra: Partial<Part> = {}): Part =>
  ({ shape, size, at, color, ...extra });

function room(name: string, w: number, d: number, h: number, door: number, wall: string, trim: string, floor: string): Asset {
  const t = 0.14;
  const half = (w - door) / 2;
  const parts: Part[] = [
    p("box", [w, 0.06, d], [0, 0.03, 0], floor, { finish: "matte" }),
    p("box", [w, h, t], [0, h / 2, -d / 2 + t / 2], wall),
    p("box", [t, h, d], [-w / 2 + t / 2, h / 2, 0], wall),
    p("box", [t, h, d], [w / 2 - t / 2, h / 2, 0], wall),
    p("box", [half, h, t], [-(door / 2 + half / 2), h / 2, d / 2 - t / 2], wall),
    p("box", [half, h, t], [door / 2 + half / 2, h / 2, d / 2 - t / 2], wall),
    p("box", [door, 0.26, t], [0, h - 0.13, d / 2 - t / 2], trim),
    p("round", [w + 0.06, 0.08, 0.2], [0, h + 0.04, -d / 2 + t / 2], trim),
    p("round", [0.2, 0.08, d + 0.06], [-w / 2 + t / 2, h + 0.04, 0], trim),
    p("round", [0.2, 0.08, d + 0.06], [w / 2 - t / 2, h + 0.04, 0], trim),
    p("box", [0.9, 0.5, 0.05], [-w / 4, h * 0.6, -d / 2 + t + 0.01], "#bfe6f5", { finish: "glass" }),
  ];
  return asset(name, "building", parts);
}

let ids = 0;
function asset(name: string, kind: Asset["kind"], parts: Part[], extra: Partial<Asset> = {}): Asset {
  ids += 1;
  return { id: `a_${ids}`, rev: 1, name, kind, parts, by: { name: "Island" }, madeAt: 0, updatedAt: 0, ...extra };
}

const desk = () => asset("Desk", "furniture", [
  p("round", [1.3, 0.06, 0.6], [0, 0.5, 0], "#c99a6b"),
  ...[-0.58, 0.58].flatMap((x) => [-0.24, 0.24].map((z) => p("box", [0.06, 0.48, 0.06], [x, 0.24, z], "#8a6446"))),
  p("round", [0.6, 0.38, 0.05], [0, 0.78, -0.18], "#2b3a44"),
  p("box", [0.52, 0.3, 0.01], [0, 0.78, -0.152], "#8ff0c8", { finish: "glow" }),
  p("round", [0.42, 0.03, 0.15], [0, 0.545, 0.1], "#e8e2d6"),
], { use: "desk", spot: { at: [0, 0, 0.72], face: 180 } });

const bed = (blanket: string) => asset("Bed", "furniture", [
  p("round", [0.9, 0.24, 1.5], [0, 0.12, 0], "#b9875e"),
  p("round", [0.84, 0.12, 1.4], [0, 0.3, 0.02], "#f7f3ea"),
  p("round", [0.5, 0.1, 0.3], [0, 0.41, -0.5], "#ffffff"),
  p("round", [0.86, 0.07, 0.8], [0, 0.38, 0.27], blanket),
], { use: "bed", spot: { at: [0, 0.42, 0.1], face: 0 } });

const armchair = asset("Cosy armchair", "furniture", [
  p("round", [0.8, 0.24, 0.7], [0, 0.12, 0], "#d77a6a"),
  p("round", [0.8, 0.52, 0.18], [0, 0.44, -0.27], "#d77a6a", { turn: [-8, 0, 0] }),
  p("round", [0.15, 0.36, 0.7], [-0.36, 0.25, 0], "#c86c5c"),
  p("round", [0.15, 0.36, 0.7], [0.36, 0.25, 0], "#c86c5c"),
  p("round", [0.54, 0.08, 0.5], [0, 0.28, 0.05], "#f2c5a0"),
], { use: "seat", spot: { at: [0, 0.32, 0.06], face: 0 } });

const lamp = asset("Lantern post", "decor", [
  p("cylinder", [0.36, 0.08, 0.36], [0, 0.04, 0], "#3c4b53", { finish: "metal" }),
  p("cylinder", [0.09, 1.5, 0.09], [0, 0.8, 0], "#3c4b53", { finish: "metal" }),
  p("sphere", [0.34, 0.34, 0.34], [0, 1.68, 0], "#ffe2a3", { finish: "glow" }),
  p("cone", [0.42, 0.18, 0.42], [0, 1.9, 0], "#3c4b53", { finish: "metal" }),
]);

const flowers = asset("Flower bed", "decor", [
  p("round", [1.4, 0.24, 0.7], [0, 0.12, 0], "#b9875e"),
  p("box", [1.3, 0.04, 0.6], [0, 0.25, 0], "#6b4a33", { finish: "matte" }),
  ...[-0.5, -0.25, 0, 0.25, 0.5].flatMap((x, i) => [
    p("cylinder", [0.03, 0.22, 0.03], [x, 0.36, i % 2 ? 0.12 : -0.12], "#4f9d63"),
    p("sphere", [0.16, 0.12, 0.16], [x, 0.5, i % 2 ? 0.12 : -0.12], ["#ff9fb2", "#ffd56b", "#b89cff", "#ff8a65", "#7fd3ff"][i]),
  ]),
]);

const telescope = asset("Star telescope", "decor", [
  ...[0, 120, 240].map((a) => p("cylinder", [0.05, 1.0, 0.05], [Math.sin(a * Math.PI / 180) * 0.18, 0.48, Math.cos(a * Math.PI / 180) * 0.18], "#7a563b", { turn: [Math.cos(a * Math.PI / 180) * 14, 0, -Math.sin(a * Math.PI / 180) * 14] })),
  p("cylinder", [0.18, 0.9, 0.18], [0, 1.05, 0.1], "#5b8bd9", { turn: [55, 0, 0], finish: "shiny" }),
  p("cylinder", [0.22, 0.08, 0.22], [0, 1.31, 0.47], "#e8e2d6", { turn: [55, 0, 0] }),
]);

const beanie = asset("Mustard beanie", "accessory", [
  p("sphere", [0.62, 0.4, 0.46], [0, 0.06, 0], "#e7b53c", { finish: "matte" }),
  p("torus", [0.66, 0.1, 0.5], [0, 0, 0], "#d29f2c", { finish: "matte" }),
  p("sphere", [0.16, 0.16, 0.16], [0, 0.28, 0], "#fff3d6", { finish: "matte" }),
], { slot: "head" });

const scarf = asset("Red scarf", "accessory", [
  p("torus", [0.46, 0.14, 0.4], [0, 0, 0], "#d9534f", { finish: "matte" }),
  p("round", [0.11, 0.3, 0.05], [0.1, -0.14, 0.18], "#d9534f", { turn: [12, 0, -12], finish: "matte" }),
], { slot: "neck" });

const glasses = asset("Round glasses", "accessory", [
  p("torus", [0.2, 0.03, 0.2], [-0.13, 0, 0.02], "#2b2f33", { turn: [90, 0, 0], finish: "metal" }),
  p("torus", [0.2, 0.03, 0.2], [0.13, 0, 0.02], "#2b2f33", { turn: [90, 0, 0], finish: "metal" }),
  p("box", [0.07, 0.02, 0.02], [0, 0.01, 0.02], "#2b2f33", { finish: "metal" }),
], { slot: "face" });

// Backpacks the way 波特 design their own (the host makes the real ones):
// in back-anchor metres, behind the robot (negative z).
const classicPack = (body: string, flap: string) => asset("Classic pack", "accessory", [
  p("round", [0.34, 0.32, 0.18], [0, 0, -0.17], body, { finish: "matte" }),
  p("round", [0.35, 0.12, 0.2], [0, 0.12, -0.17], flap, { finish: "matte" }),
  p("round", [0.2, 0.12, 0.06], [0, -0.07, -0.27], flap, { finish: "matte" }),
], { slot: "back" });

const rocketPack = (body: string) => asset("Rocket pack", "accessory", [
  ...[-0.1, 0.1].flatMap((x) => [
    p("cylinder", [0.14, 0.32, 0.14], [x, 0, -0.18], body, { finish: "shiny" }),
    p("cone", [0.14, 0.12, 0.14], [x, 0.22, -0.18], "#e0584f", { finish: "shiny" }),
    p("cone", [0.1, 0.12, 0.1], [x, -0.22, -0.18], "#ffcf6b", { turn: [180, 0, 0], finish: "glow" }),
  ]),
  p("box", [0.3, 0.08, 0.06], [0, 0.04, -0.1], "#3c4b53", { finish: "metal" }),
], { slot: "back" });

const potPack = asset("Flower-pot pack", "accessory", [
  p("cylinder", [0.3, 0.24, 0.24], [0, -0.04, -0.18], "#c8734d", { finish: "matte" }),
  p("torus", [0.33, 0.06, 0.27], [0, 0.08, -0.18], "#b3613d", { finish: "matte" }),
  ...[[-0.07, -0.02], [0.06, 0.03], [0, -0.1]].flatMap(([x, z], i) => [
    p("cylinder", [0.02, 0.16, 0.02], [x, 0.17, -0.18 + z], "#4f9d63"),
    p("sphere", [0.1, 0.08, 0.1], [x, 0.27, -0.18 + z], ["#ff9fb2", "#ffd56b", "#b89cff"][i], { finish: "matte" }),
  ]),
], { slot: "back" });

const backpacks = {
  pip: classicPack("#ff9f7a", "#ffe3a3"),
  bolt: rocketPack("#eef7ff"),
  mochi: classicPack("#f5b8d8", "#fdf0f6"),
  rivet: rocketPack("#c9d48a"),
  nori: potPack,
  zuzu: classicPack("#9b7be0", "#e3d4ff"),
};

/** A plot on the honeycomb, as the host lays them out (docs/island.md). */
function plotAt(ring: number, slot: number, owner: Plot["owner"], members?: string[]): Plot {
  const [q, r] = ringCells(ring)[slot];
  const { x, z } = cellCenter(q, r);
  return {
    id: `p_${ring}_${slot}`, owner, ring, slot, q, r, x, z, facing: facingFor(x, z), radius: TILE, claimedAt: 0,
    ...(members ? { members } : {}),
  };
}

const roster: IslandAgent[] = [
  { id: "agent-maya", name: "Maya", agent: "claude", model: "opus" },
  { id: "agent-kai", name: "Kai", agent: "claude", model: "sonnet" },
  { id: "agent-iris", name: "Iris", agent: "codex", model: "" },
  { id: "agent-noor", name: "Noor", agent: "claude", model: "haiku" },
];

const botLook = (shell: string, trim: string, glow: string, frame: Look["frame"], eyes: Look["eyes"], antenna: Look["antenna"]): Look =>
  ({ frame, shell, trim, glow, eyes, antenna, worn: {} });

const bots: Bot[] = ([
  { id: "b_pip", name: "Pip", trait: "cozy" as const, look: { ...botLook("#fff4e6", "#ff9f7a", "#ffe3a3", "round", "happy", "sprout"), worn: { neck: scarf.id, back: backpacks.pip.id } } },
  { id: "b_bolt", name: "Bolt", trait: "sporty" as const, look: { ...botLook("#eef7ff", "#5aa9e6", "#a8f0ff", "boxy", "pill", "bar"), worn: { back: backpacks.bolt.id } } },
  { id: "b_mochi", name: "Mochi", trait: "dreamy" as const, look: { ...botLook("#fdf0f6", "#e48db7", "#ffd1ea", "round", "sleepy", "moon"), worn: { back: backpacks.mochi.id } } },
  { id: "b_rivet", name: "Rivet", trait: "tinkerer" as const, look: { ...botLook("#f1f1ec", "#8a9a5b", "#c8ff9e", "stout", "visor", "twin"), worn: { back: backpacks.rivet.id } } },
  { id: "b_nori", name: "Nori", trait: "gardener" as const, look: { ...botLook("#eefaf1", "#4fae7a", "#b8ffd0", "slim", "round", "leaf"), worn: { back: backpacks.nori.id } } },
  { id: "b_zuzu", name: "Zuzu", trait: "artsy" as const, look: { ...botLook("#f6f0ff", "#9b7be0", "#e3d4ff", "slim", "star", "star"), worn: { face: glasses.id, back: backpacks.zuzu.id } } },
] as Omit<Bot, "arrivedAt">[]).map((bot, i) => ({ ...bot, home: i < 4 ? "p_2_0" : "p_2_2", arrivedAt: 0 }));

function fixture(): Island {
  // The agents on ring 1 (the playground is the sixth cell), and the six 波特
  // in two homes on ring 2, four and two.
  const plots: Plot[] = [
    ...roster.map((agent, i) => plotAt(1, i, { kind: "agent", id: agent.id })),
    plotAt(2, 0, { kind: "home", id: "h_1" }, bots.slice(0, 4).map((bot) => bot.id)),
    plotAt(2, 2, { kind: "home", id: "h_2" }, bots.slice(4).map((bot) => bot.id)),
  ];
  const assets: Asset[] = [armchair, lamp, flowers, telescope, beanie, scarf, glasses, ...Object.values(backpacks)];
  const placed: Placement[] = [];
  let n = 0;
  const place = (plot: Plot, a: Asset, x: number, z: number, turn = 0) => {
    placed.push({ id: `pl_${++n}`, plot: plot.id, asset: a.id, x, z, y: 0, turn });
  };
  plots.forEach((plot, i) => {
    if (plot.owner.kind === "agent") {
      const workshop = room("Workshop", 5, 4, 1.8, 1.2, ["#f3e9dc", "#e5f0f7", "#f1ece3", "#eef3e6"][i % 4], "#c98f65", "#d9b48a");
      const d = desk();
      assets.push(workshop, d);
      place(plot, workshop, 0, -1);
      place(plot, d, 0, -2.5);
      if (i === 0) { place(plot, armchair, 1.5, -0.8, -30); place(plot, lamp, -3.6, 2.6); }
      if (i === 1) place(plot, flowers, 2.6, 3.0);
      if (i === 2) place(plot, telescope, -3, 3);
    } else {
      // A home: one house for all of them, a bed each along the back wall.
      const members = bots.filter((bot) => plot.members?.includes(bot.id));
      const house = room("House", 6, 4.5, 1.7, 1.2, members[0].look.shell, members[1]?.look.trim ?? members[0].look.trim, "#e2c49a");
      assets.push(house);
      place(plot, house, 0, -0.8);
      members.forEach((member, k) => {
        const b = bed(member.look.trim);
        assets.push(b);
        place(plot, b, (k - (members.length - 1) / 2) * 1.3, -2.15);
      });
      if (i === 5) place(plot, flowers, 2.4, 2.6, 15);
      place(plot, flowers, -1.9, 2.2);
    }
  });
  const wishes: Wish[] = [
    { id: "w_1", who: { kind: "bot", id: "b_bolt" }, want: "accessory", slot: "head", text: "a sky-blue cap — the sun on the dock is bright at noon", madeAt: Date.now() - 600000, state: "open" },
    { id: "w_2", who: { kind: "bot", id: "b_mochi" }, want: "decor", text: "a little telescope to watch the stars from the beach", madeAt: Date.now() - 3600000, state: "open" },
    { id: "w_3", who: { kind: "agent", id: "agent-kai" }, want: "furniture", text: "a standing desk with room for two screens", madeAt: Date.now() - 7200000, state: "open" },
  ];
  return {
    version: 1, rev: 1, seed: 1234, createdAt: 0, updatedAt: 0, radius: Math.max(30, 7 * Math.sqrt(3) * 2 + 13),
    settings: { wishPace: "sometimes" },
    plots, bots, looks: { "agent-maya": { worn: { head: beanie.id } } },
    assets, placed, wishes, lastRollAt: 0,
  };
}

function Preview() {
  const stage = useRef<HTMLDivElement>(null);
  const view = useRef<IslandView | null>(null);
  const [hour, setHour] = useState<number | null>(() => {
    const value = new URLSearchParams(location.search).get("hour");
    return value === null ? null : Number(value);
  });
  const [modes, setModes] = useState<Record<string, AgentMode["state"]>>({ "agent:agent-maya": "working", "agent:agent-kai": "needs_you" });
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!stage.current) return;
    const made = new IslandView(stage.current, { onPick: setPicked });
    view.current = made;
    const island = fixture();
    made.setIsland(island, residentsOf(island, roster));
    const follow = new URLSearchParams(location.search).get("follow");
    const timer = follow ? setTimeout(() => made.select(follow, true), 300) : undefined;
    (window as unknown as { islandView: IslandView }).islandView = made;
    return () => { clearTimeout(timer); made.dispose(); view.current = null; };
  }, []);
  useEffect(() => { view.current?.setHourOverride(hour); }, [hour]);
  useEffect(() => {
    view.current?.setModes(new Map(Object.entries(modes).map(([key, state]) => [key, { state, label: state === "working" ? "Fix the login page" : "Plan to approve" }])));
  }, [modes]);
  useEffect(() => { view.current?.select(picked); }, [picked]);

  return <div style={{ position: "fixed", inset: 0 }}>
    <div ref={stage} style={{ position: "absolute", inset: 0 }} />
    <div style={{ position: "absolute", left: 12, top: 12, display: "flex", gap: 8, flexWrap: "wrap", font: "13px system-ui" }}>
      <label style={{ background: "#fffd", padding: "4px 8px", borderRadius: 8 }}>
        Hour {hour ?? "now"} <input type="range" min={0} max={24} step={0.25} value={hour ?? 12}
          onChange={(e) => setHour(Number(e.target.value))} />
      </label>
      {roster.map((agent) => <select key={agent.id} value={modes[`agent:${agent.id}`] ?? "free"} style={{ borderRadius: 8 }}
        onChange={(e) => setModes((before) => ({ ...before, [`agent:${agent.id}`]: e.target.value as AgentMode["state"] }))}>
        {["free", "working", "needs_you", "failed"].map((state) => <option key={state} value={state}>{agent.name}: {state}</option>)}
      </select>)}
      <button type="button" onClick={() => view.current?.recenter()}>Whole island</button>
      {picked && <span style={{ background: "#fffd", padding: "4px 8px", borderRadius: 8 }}>{picked}: {view.current?.describe(picked)}</span>}
    </div>
  </div>;
}

/** The real Island page, with the host's answers made up here (`?page`):
 *  the card, the wishes and the residents, as the app draws them. */
function PagePreview() {
  return <ConfirmProvider>
    <div style={{ position: "fixed", inset: 0, display: "flex" }}>
      <IslandPage
        connected
        snapshot={null}
        projects={[]}
        running={new Set()}
        busy={new Set()}
        waitingOn={() => 0}
        held={new Map()}
        chatTitle={() => undefined}
        chatExists={() => false}
        onAsk={(agentId, text) => console.log("ask", agentId, text)}
        onOpenChat={(chatKey) => console.log("open", chatKey)}
        onClose={() => console.log("close")}
      />
    </div>
  </ConfirmProvider>;
}

if (new URLSearchParams(location.search).has("page")) {
  const island = fixture();
  const answers: Record<string, unknown> = {
    island_get: { island },
    team_list: roster.map((agent) => ({ ...agent, role: "", access: "auto", createdAt: 0, updatedAt: 0 })),
    team_leads: [],
    agent_team_list: [],
    chat_activity: [],
  };
  const fake = bridge as unknown as { invoke: (cmd: string) => Promise<unknown>; on: () => () => void };
  fake.invoke = async (cmd: string) => answers[cmd] ?? null;
  fake.on = () => () => {};
  createRoot(document.getElementById("root")!).render(<StrictMode><PagePreview /></StrictMode>);
} else {
  createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
}

// The island as the host keeps it (island.rs, docs/island.md), and the few
// facts the page works out from it: where a plot's corner of the island is,
// and what a robot looks like when nobody has chosen.
//
// Pure, and no socket: everything that asks the host is in `feed.ts`.
import { MODELS, type ComposerStyle, type Provider } from "../agentProviders";
import { personaHue } from "../agentPersona";

/** Who something belongs to: an agent, a 波特, or (for a plot) a home that
 *  several 波特 share. */
export type Owner = { kind: "agent" | "bot" | "home"; id: string };

export type Frame = "round" | "boxy" | "slim" | "stout";
export type Eyes = "pill" | "round" | "happy" | "sleepy" | "star" | "heart" | "visor" | "chevron";
export type Antenna =
  | "ball" | "halo" | "crown" | "star" | "leaf" | "moon" | "twin" | "sun" | "spark" | "bar" | "sprout" | "none";
export type Slot = "head" | "face" | "neck" | "back" | "hand";
export const SLOTS: readonly Slot[] = ["head", "face", "neck", "back", "hand"];

export type Look = {
  frame: Frame;
  shell: string;
  trim: string;
  glow: string;
  eyes: Eyes;
  antenna: Antenna;
  worn: Partial<Record<Slot, string>>;
};
/** An agent's look is what it chose over the page's default for it. */
export type LookPatch = Partial<Look>;

export type Shape = "box" | "round" | "cylinder" | "cone" | "sphere" | "torus" | "wedge";
export type Finish = "matte" | "soft" | "shiny" | "metal" | "glass" | "glow";
export type Vec3 = [number, number, number];

export type Part = {
  shape: Shape;
  size: Vec3;
  at: Vec3;
  turn?: Vec3;
  color: string;
  finish?: Finish;
};

export type AssetKind = "accessory" | "furniture" | "decor" | "building";
export type Use = "seat" | "desk" | "bed" | "none";
export type Spot = { at: Vec3; face: number };
export type Maker = { name: string; agentId?: string; chatKey?: string };

export type Asset = {
  id: string;
  rev: number;
  name: string;
  kind: AssetKind;
  slot?: Slot;
  use?: Use;
  spot?: Spot;
  parts: Part[];
  by: Maker;
  madeAt: number;
  updatedAt: number;
};

/** A hexagonal tile of the honeycomb (docs/island.md, Layout). */
export type Plot = {
  id: string;
  owner: Owner;
  ring: number;
  slot: number;
  /** Its cell, in axial coordinates. */
  q: number;
  r: number;
  x: number;
  z: number;
  /** Degrees: the yaw of the plot's front (+z), a flat edge that faces the
   *  plaza. */
  facing: number;
  /** The tile's centre to a corner, in metres. */
  radius: number;
  /** A home's 波特, in the order they moved in. */
  members?: string[];
  claimedAt: number;
};

export type Trait = "cozy" | "curious" | "sporty" | "artsy" | "tinkerer" | "dreamy" | "foodie" | "gardener";

/** A 波特 (an island bot). `home` is the plot it lives on with the others. */
export type Bot = { id: string; name: string; trait: Trait; look: Look; home?: string; arrivedAt: number };

export type Placement = { id: string; plot: string; asset: string; x: number; z: number; y: number; turn: number };

export type WishWant = "accessory" | "furniture" | "decor" | "building" | "look";
export type Wish = {
  id: string;
  who: Owner;
  want: WishWant;
  slot?: Slot;
  /** Reads after "<name> wishes for". The host's words. */
  text: string;
  madeAt: number;
  state: "open" | "granted" | "dismissed";
  grant?: { asset?: string; look?: boolean; by: Maker; at: number };
  closedAt?: number;
  /** Open wishes only: what a new chat is handed when the person grants it. */
  brief?: string;
  /** A host-started background task; the wish stays open until the gift exists. */
  execution?: { chatKey: string; state: "building" | "unfinished"; provider?: string };
};

export type WishPace = "often" | "sometimes" | "rarely" | "never";

export type Island = {
  version: number;
  rev: number;
  seed: number;
  createdAt: number;
  updatedAt: number;
  radius: number;
  settings: { wishPace: WishPace; buildPace?: WishPace };
  plots: Plot[];
  bots: Bot[];
  looks: Record<string, LookPatch>;
  assets: Asset[];
  placed: Placement[];
  wishes: Wish[];
  lastRollAt: number;
};

/** A registered agent, as much of it as the island needs. */
export type IslandAgent = { id: string; name: string; agent: Provider; model: string; avatar?: string; leader?: boolean };

/** Everyone who lives on the island, agent or bot, the same way. */
export type Resident = {
  key: string;
  owner: Owner;
  name: string;
  look: Look;
  plot: Plot | null;
  trait?: Trait;
  /** For an agent: who it is in the roster. */
  agent?: IslandAgent;
};

/** The honeycomb: a cell's centre to a corner, and the tile a plot is on
 *  it (what is left round the tile is the path). */
export const CELL = 7;
export const TILE = 6.3;
/** How high a tile stands over the paths. What is on a plot stands on it. */
export const TILE_TOP = 0.05;
/** The plaza is the centre cell. */
export const PLAZA_RADIUS = CELL;

const SQRT3 = Math.sqrt(3);

/** The six neighbour directions, in axial coordinates, in the order rings
 *  are walked. */
export const HEX_DIRS: readonly (readonly [number, number])[] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/** Where a cell's centre is, in world metres. */
export function cellCenter(q: number, r: number): { x: number; z: number } {
  return { x: CELL * SQRT3 * (q + r / 2), z: CELL * 1.5 * r };
}

/** The cells of ring `k`, in the order the host gives out slots. */
export function ringCells(k: number): [number, number][] {
  if (k <= 0) return [[0, 0]];
  const out: [number, number][] = [];
  let q = -k;
  let r = k;
  for (const [dq, dr] of HEX_DIRS) {
    for (let step = 0; step < k; step++) {
      out.push([q, r]);
      q += dq;
      r += dr;
    }
  }
  return out;
}

/** The cell a world point is in. */
export function cellAt(x: number, z: number): [number, number] {
  const fq = (SQRT3 / 3 * x - z / 3) / CELL;
  const fr = (2 / 3 * z) / CELL;
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return [q + 0, r + 0];
}

/** How far a cell is from the plaza, in steps. */
export function ringOf(q: number, r: number): number {
  return (Math.abs(q) + Math.abs(r) + Math.abs(-q - r)) / 2;
}

/** Is a point on a tile, in the plot's own coordinates (flat at the front
 *  and the back, pointed at the sides)? */
export function onTile(lx: number, lz: number, radius = TILE): boolean {
  return Math.abs(lz) <= (radius * SQRT3) / 2 + 1e-9 && Math.abs(lx) + Math.abs(lz) / SQRT3 <= radius + 1e-9;
}

/** Is a world point on the tile of the cell it is in (which the world draws
 *  pointed along ±z)? */
export function onCellTile(x: number, z: number, radius = TILE): boolean {
  const [q, r] = cellAt(x, z);
  const c = cellCenter(q, r);
  const dx = x - c.x;
  const dz = z - c.z;
  return Math.abs(dx) <= (radius * SQRT3) / 2 && Math.abs(dz) + Math.abs(dx) / SQRT3 <= radius;
}

/** The yaw (degrees) that turns a plot's front, a flat edge, towards the
 *  plaza: the way to the plaza snapped to the nearest edge. */
export function facingFor(x: number, z: number): number {
  const toward = Math.atan2(-z, -x);
  const snapped = Math.round(toward / (Math.PI / 3)) * (Math.PI / 3);
  return (Math.atan2(Math.cos(snapped), Math.sin(snapped)) * 180) / Math.PI;
}

const DEG = Math.PI / 180;

/** A point on a plot, in world metres. The plot's +z faces the plaza;
 *  `facing` is the yaw three.js gives `rotation.y`. */
export function plotToWorld(plot: Pick<Plot, "x" | "z" | "facing">, lx: number, lz: number): { x: number; z: number } {
  const f = plot.facing * DEG;
  const cos = Math.cos(f);
  const sin = Math.sin(f);
  return { x: plot.x + lx * cos + lz * sin, z: plot.z - lx * sin + lz * cos };
}

/** A world point in a plot's own coordinates. */
export function worldToPlot(plot: Pick<Plot, "x" | "z" | "facing">, x: number, z: number): { x: number; z: number } {
  const f = plot.facing * DEG;
  const cos = Math.cos(f);
  const sin = Math.sin(f);
  const dx = x - plot.x;
  const dz = z - plot.z;
  return { x: dx * cos - dz * sin, z: dx * sin + dz * cos };
}

/** What each model family looks like as a robot: the silhouette and the
 *  antenna it wears. Colour is the agent's own (its persona hue), so two
 *  agents on the same model are still told apart, by the same colour their
 *  face has everywhere else in the app. */
const FAMILY: Record<string, { frame: Frame; antenna: Antenna; eyes: Eyes }> = {
  opus: { frame: "round", antenna: "halo", eyes: "pill" },
  sonnet: { frame: "round", antenna: "ball", eyes: "pill" },
  haiku: { frame: "slim", antenna: "leaf", eyes: "pill" },
  fable: { frame: "boxy", antenna: "crown", eyes: "pill" },
  claude: { frame: "round", antenna: "spark", eyes: "pill" },
  astra: { frame: "slim", antenna: "star", eyes: "pill" },
  sol: { frame: "round", antenna: "sun", eyes: "round" },
  terra: { frame: "stout", antenna: "twin", eyes: "pill" },
  luna: { frame: "slim", antenna: "moon", eyes: "round" },
  codex: { frame: "boxy", antenna: "bar", eyes: "chevron" },
};

function familyOf(style: ComposerStyle | undefined): { frame: Frame; antenna: Antenna; eyes: Eyes } {
  if (!style) return FAMILY.sonnet;
  if (style === "pi" || style === "antigravity") return style === "pi" ? FAMILY.codex : FAMILY.luna;
  const bare = style.startsWith("pi-") ? style.slice(3) : style;
  return FAMILY[bare] ?? FAMILY.sonnet;
}

/** `#rrggbb` for a colour given in HSL (degrees, percent, percent). */
export function hslHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) => {
    const value = light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(value * 255).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** The look an agent has until it chooses its own. */
export function defaultAgentLook(agent: Pick<IslandAgent, "id" | "agent" | "model">): Look {
  const style = MODELS.find((m) => m.agent === agent.agent && m.flag === agent.model)?.composerStyle
    ?? MODELS.find((m) => m.agent === agent.agent)?.composerStyle;
  const family = familyOf(style);
  const hue = personaHue(agent.id);
  return {
    ...family,
    // The trim is the face tile's colour (AgentAvatar.css: 62 % / 52 %), a
    // little lighter so it reads on a lit body.
    trim: hslHex(hue, 62, 60),
    shell: hslHex(hue, 30, 93),
    glow: hslHex(hue, 90, 80),
    worn: {},
  };
}

/** A patch over a whole look. A field the patch leaves out, or sets to
 *  something the page does not draw, keeps the base. */
export function withPatch(base: Look, patch: LookPatch | undefined): Look {
  if (!patch) return base;
  const hex = (value: unknown, fallback: string) =>
    typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  const worn: Partial<Record<Slot, string>> = { ...base.worn };
  for (const slot of SLOTS) {
    const id = patch.worn?.[slot];
    if (typeof id === "string" && id) worn[slot] = id;
  }
  return {
    frame: oneOf(patch.frame, FRAMES, base.frame),
    shell: hex(patch.shell, base.shell),
    trim: hex(patch.trim, base.trim),
    glow: hex(patch.glow, base.glow),
    eyes: oneOf(patch.eyes, EYES, base.eyes),
    antenna: oneOf(patch.antenna, ANTENNAS, base.antenna),
    worn,
  };
}

export const FRAMES: readonly Frame[] = ["round", "boxy", "slim", "stout"];
export const EYES: readonly Eyes[] = ["pill", "round", "happy", "sleepy", "star", "heart", "visor", "chevron"];
export const ANTENNAS: readonly Antenna[] = [
  "ball", "halo", "crown", "star", "leaf", "moon", "twin", "sun", "spark", "bar", "sprout", "none",
];

/** 波特 are exactly the registered agents which still have a plot. Legacy
 * NPC records remain in storage but never add characters to the roster. */
export function residentsOf(island: Island, roster: readonly IslandAgent[]): Resident[] {
  const plotOf = (owner: Owner) =>
    island.plots.find((plot) => plot.owner.kind === owner.kind && plot.owner.id === owner.id) ?? null;
  const agents: Resident[] = [];
  for (const agent of roster) {
    const owner: Owner = { kind: "agent", id: agent.id };
    const plot = plotOf(owner);
    if (!plot) continue;
    agents.push({
      key: `agent:${agent.id}`,
      owner,
      name: agent.name,
      look: withPatch(defaultAgentLook(agent), island.looks[agent.id]),
      plot,
      agent,
    });
  }
  return agents;
}

/** The names on a plot's sign: its agent's, or everyone who lives in a
 *  home, "Pip, Bolt & Mochi". */
export function plotNames(plot: Plot, residents: readonly Resident[]): string {
  const names = residents.filter((r) => r.plot?.id === plot.id).map((r) => r.name);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

/** The open wishes, newest first. */
export function openWishes(island: Island): Wish[] {
  return island.wishes.filter((wish) => wish.state === "open").sort((a, b) => b.madeAt - a.madeAt);
}

/** The resident a wish is from, when they still live here. */
export function wisher(wish: Wish, residents: readonly Resident[]): Resident | undefined {
  return residents.find((r) => r.owner.kind === wish.who.kind && r.owner.id === wish.who.id);
}

/** Where on the plaza the wish tree stands, and how far out its letters hang. */
export const WISH_TREE = { x: 0, z: 0 } as const;

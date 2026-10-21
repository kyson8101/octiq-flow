import { likesActivity, type ActivitySite } from "./interactions";
import { SOCIETY_COUNTER, societyQueueSpot } from "./society";
// What every robot on the island is doing, frame by frame, with no agent
// process behind any of it: the page's own game logic. A free robot picks
// something to do by its trait and the hour (wander, sit on a seat, watch the
// sea, visit a plot, chat with whoever is near, dance on the plaza, tend a
// garden, go and play, sleep at night), walks there on the nav grid and does
// it for a while. Robots that meet say hi; friends are asked to play on the
// seesaw, the swings or the slide, or at tag. An agent whose work is real is
// not free: with a turn in flight it goes to its desk and types, and with a
// card waiting on the person it stands at the front of its plot with its hand
// up, until the page's reading says otherwise. Nothing here is stored or
// sent; another tab draws its own.
import type { NavGrid, Point } from "./nav";
import type { Pose } from "./robot";
import type { Resident, Trait } from "./model";
import { seesawSeat, swingSeat, type PlayAnchors } from "./playground";

/** Where a robot can sit, sleep or work: a spot in world metres (`y` the
 *  height of its hips there), `face` the heading it takes there (radians,
 *  three.js `rotation.y`). */
export type Seat = {
  key: string;
  kind: "seat" | "bed" | "desk";
  x: number;
  z: number;
  y: number;
  face: number;
  /** The plot it is on, or null for the island's own benches. */
  plot: string | null;
  name: string;
  owner?: string;
};

/** What the scene knows about the island that behaviour needs. */
export type Places = {
  seats: readonly Seat[];
  activities?: readonly ActivitySite[];
  /** Each resident's own plot: its centre, and where to stand at its front. */
  plots: ReadonlyMap<string, { id: string; center: Point; front: Point & { face: number }; door: Point }>;
  tree: Point;
  plaza: number;
  /** The land's radius; the shore is just inside it. */
  radius: number;
  playground?: PlayAnchors;
};

/** What the page's reading says an agent is doing (`agentsDashboard`), and
 *  for a free one, how many minutes since it last had work: how bored it is
 *  when the page first sees it. */
export type AgentMode = { state: "working" | "needs_you" | "failed" | "free"; label?: string; idleFor?: number };

/** How bored a robot gets, a minute at a time: full in about a quarter of
 *  an hour with nothing to do, and an agent that has had no work for two and
 *  a half hours is as bored as it gets. */
const BORED_PER_SECOND = 1 / (14 * 60);
const FUN_PER_SECOND = 1 / 45;
const AGENT_BORED_MINUTES = 150;

type Goal = { x: number; z: number; face?: number };
/** What two can play together. */
export type Game = "seesaw" | "swings" | "slide" | "tag";

type Act =
  | { kind: "interact"; site: ActivitySite; seconds: number }
  | { kind: "wish-queue"; ticket: string; index: number }
  | { kind: "wish-register"; ticket: string; triedAt?: number }
  | { kind: "look"; seconds: number; face?: number }
  | { kind: "sit"; seat: Seat; seconds: number }
  | { kind: "sleep"; seat: Seat | null }
  | { kind: "gaze"; seconds: number; face: number }
  | { kind: "dance"; seconds: number }
  | { kind: "watch"; performer: string }
  | { kind: "tend"; seconds: number; face: number }
  | { kind: "chat"; with: string; seconds: number; first: boolean }
  | { kind: "invite"; game: Game; with: string; answer?: "yes" | "no" }
  | { kind: "sob"; seconds: number; then: "ask" | "leave"; from?: string }
  | { kind: "swing"; swing: number; seconds: number; with?: string }
  | { kind: "seesaw"; end: 0 | 1; seconds: number; with?: string; askAt?: number; asked?: string[] }
  | { kind: "slide"; runs: number; with?: string }
  | { kind: "tag"; game: string }
  | { kind: "work"; seat: Seat | null }
  | { kind: "wait"; face: number }
  | { kind: "trouble"; seat: Seat | null }
  | { kind: "wish"; seconds: number; face: number }
  | { kind: "cheer"; seconds: number; then?: Plan };

export type Plan = {
  /** What it is doing, in a few words, for its card. */
  label: string;
  goal: Goal | null;
  act: Act;
  /** Set when the robot has arrived and started acting. */
  since?: number;
  /** Who it is walking to: to chat, or to ask to play. */
  seek?: string;
};

export type Bubble = { text: string; tone: "plain" | "decide" | "danger" | "work" | "sleep"; until: number };

export type SimRobot = {
  key: string;
  resident: Resident;
  x: number;
  z: number;
  /** Where its root is, in world metres, while `perched` (on a seat, a
   *  swing, the slide); on the ground otherwise, and the scene puts it there. */
  y: number;
  perched: boolean;
  heading: number;
  pose: Pose;
  /** How far a swing has carried it, for the legs (radians). */
  lean: number;
  stride: number;
  speed: number;
  plan: Plan;
  path: Point[];
  bubble: Bubble | null;
  /** A wave or a nod over whatever it is doing, until when. */
  gesture: { pose: Pose; until: number } | null;
  mode: AgentMode;
  rng: () => number;
  /** When it last looked for a new path to someone it is walking to. */
  repathAt: number;
  /** When it may next start a chat or a game, so friends do not go on for
   *  ever. */
  chatAfter: number;
  /** Minutes this robot's bedtime is off the island's, so they do not all
   *  turn in at once. */
  bedtimeShift: number;
  /** Its boredom, 0 to 1: up while nothing happens, down while it plays,
   *  chats or dances, and gone the moment work comes. */
  boredom: number;
  /** Whether an agent's boredom has been read from its real idle time yet. */
  boredomRead: boolean;
  /** Until when it is excited (work just came). */
  excitedUntil: number;
};

type TagGame = { id: string; players: [string, string]; it: string; until: number; center: Point; pausedUntil: number };

const SPEED = 1.05;
const TURN = 7;
const STEP = 0.9;
/** How near two robots pass before they say hi, and how long before the
 *  same two say it again. */
const HELLO_REACH = 1.8;
const HELLO_AGAIN = 300;
const HELLO_PAUSE = 60;
const CHAT_LINES = [
  "how are you?", "nice day!", "🌊", "☕?", "haha", "look!", "🎵", "same!", "really?", "😄", "✨", "🍩", "ok!",
  "me too!", "🌸", "so sunny", "🐚", "hmm…", "💡", "yay!",
];

/** A small fast PRNG (mulberry32), seeded per robot. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashKey(key: string): number {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
  return hash >>> 0;
}

/** Night is when a free robot goes to bed: from about half past ten until
 *  half past six, each robot a little off that. */
export function isNight(hour: number, shiftMinutes = 0): boolean {
  const h = (hour - shiftMinutes / 60 + 24) % 24;
  return h >= 22.5 || h < 6.5;
}

/** How much a trait leans towards each free activity. */
const LEANS: Record<Trait | "agent", Record<FreeKind, number>> = {
  cozy: { wander: 0.6, visit: 0.6, sit: 3, gaze: 1.5, chat: 1.2, dance: 0.3, tend: 0.4, play: 0.7 },
  curious: { wander: 2.2, visit: 2, sit: 0.6, gaze: 1, chat: 1, dance: 0.4, tend: 0.3, play: 1.6 },
  sporty: { wander: 1.6, visit: 0.8, sit: 0.4, gaze: 0.6, chat: 1, dance: 1.6, tend: 0.3, play: 2.8 },
  artsy: { wander: 1, visit: 0.8, sit: 1, gaze: 2, chat: 1, dance: 1.2, tend: 0.5, play: 1.2 },
  tinkerer: { wander: 0.8, visit: 1.5, sit: 0.8, gaze: 0.5, chat: 1, dance: 0.3, tend: 1.4, play: 0.9 },
  dreamy: { wander: 0.8, visit: 0.5, sit: 1.6, gaze: 3, chat: 0.7, dance: 0.5, tend: 0.4, play: 1.1 },
  foodie: { wander: 0.8, visit: 1.6, sit: 2, gaze: 0.6, chat: 1.6, dance: 0.6, tend: 0.4, play: 1 },
  gardener: { wander: 0.8, visit: 0.6, sit: 0.8, gaze: 0.8, chat: 0.8, dance: 0.3, tend: 3, play: 0.7 },
  agent: { wander: 1, visit: 1, sit: 1.2, gaze: 1, chat: 1.5, dance: 0.4, tend: 0.6, play: 0.9 },
};
type FreeKind = "wander" | "visit" | "sit" | "gaze" | "chat" | "dance" | "tend" | "play";

function pick<T>(items: readonly T[], rng: () => number): T | undefined {
  return items.length ? items[Math.floor(rng() * items.length) % items.length] : undefined;
}

function weighted<T extends string>(weights: Record<T, number>, rng: () => number): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [key, w] of entries) {
    roll -= w;
    if (roll <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

const faceTowards = (from: Point, to: Point) => Math.atan2(to.x - from.x, to.z - from.z);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const PLAY_KINDS = new Set<Act["kind"]>(["invite", "swing", "seesaw", "slide", "tag"]);

export class IslandSim {
  private wishTickets: { id:string; key:string }[] = [];
  onWishRegister?: (id:string)=>void;
  onWishGiveUp?: (id:string)=>void;
  private wishPatience = new Map<string,{since:number;next:number;gaveUp:boolean}>();
  readonly robots = new Map<string, SimRobot>();
  /** How the playground moves, for the scene: the swings' angles and the
   *  seesaw's tilt. */
  readonly motion = { swings: [0, 0], seesaw: 0 };
  /** Seats taken, by seat key, so two robots never share a chair. */
  private taken = new Map<string, string>();
  private hour = 12;
  private swingRider: (string | null)[] = [null, null];
  private swingAmp = [0, 0];
  private swingPhase = [0, 0];
  private seesawRider: [string | null, string | null] = [null, null];
  private seesawSeated: [boolean, boolean] = [false, false];
  private seesawSince = 0;
  private slideQueue: string[] = [];
  private slideRide: { key: string; phase: "approach" | "climb" | "perch" | "ride" | "hop"; since: number; from: Point } | null = null;
  private tags = new Map<string, TagGame>();
  private greeted = new Map<string, number>();
  private helloAfter = new Map<string, number>();
  private greetAt = 0;
  private games = 0;
  private clockNow = 0;

  /** `random` seeds each robot's own randomness: the page's is
   *  `Math.random`, so two tabs never move in step; a test's is fixed. */
  constructor(private nav: NavGrid, private places: Places, private random: () => number = Math.random) {}

  /** The island changed: a new grid, new seats, residents come and gone.
   *  Robots that stay keep where they are and what they were doing, unless
   *  what they were doing used a seat that is gone. */
  reset(nav: NavGrid, places: Places, residents: readonly Resident[], now: number) {
    this.nav = nav;
    this.places = places;
    const keep = new Set(residents.map((r) => r.key));
    for (const key of [...this.robots.keys()]) {
      if (!keep.has(key)) this.remove(key, now);
    }
    const seatKeys = new Set([...places.seats.map((s) => s.key), ...(places.activities??[]).map(s=>s.key)]);
    for (const [seat, holder] of [...this.taken]) {
      if (!seatKeys.has(seat)) {
        this.taken.delete(seat);
        const robot = this.robots.get(holder);
        if (robot) this.replan(robot, now);
      }
    }
    for (const resident of residents) {
      const held = this.robots.get(resident.key);
      if (held) {
        held.resident = resident;
        continue;
      }
      this.robots.set(resident.key, this.arrive(resident, now));
    }
  }

  private arrive(resident: Resident, now: number): SimRobot {
    const rng = seeded(hashKey(resident.key) ^ Math.floor(this.random() * 0xffffffff));
    const home = this.places.plots.get(resident.key);
    const start = this.nav.nearestFree(home?.door ?? { x: (rng() - 0.5) * 8, z: (rng() - 0.5) * 8 })
      ?? { x: 0, z: this.places.plaza + 1 };
    return {
      key: resident.key, resident, x: start.x, z: start.z, y: 0, perched: false, heading: rng() * Math.PI * 2,
      pose: "stand", lean: 0, stride: 0, speed: SPEED, path: [], bubble: null, gesture: null, mode: { state: "free" }, rng,
      plan: { label: "Looking around", goal: null, act: { kind: "look", seconds: 1 + rng() * 3 }, since: now },
      repathAt: 0, chatAfter: now + rng() * 20, bedtimeShift: Math.round((rng() - 0.5) * 80),
      // A 波特 starts the page somewhere in the middle; an agent's is read
      // from its real idle time when the page's reading arrives.
      boredom: 0.2 + rng() * 0.35, boredomRead: resident.owner.kind !== "agent", excitedUntil: 0,
    };
  }

  private remove(key: string, now: number) {
    const robot = this.robots.get(key);
    if (robot) this.release(robot, now);
    this.robots.delete(key);
    for (const other of this.robots.values()) {
      const act = other.plan.act;
      if ((act.kind === "chat" || act.kind === "invite") && act.with === key) this.replan(other, now);
    }
  }

  /** The agents' real states, from the page's reading. A change interrupts
   *  whatever the robot was doing. */
  setModes(modes: ReadonlyMap<string, AgentMode>, now: number) {
    for (const robot of this.robots.values()) {
      if (robot.resident.owner.kind !== "agent") continue;
      const next = modes.get(robot.key) ?? { state: "free" as const };
      const before = robot.mode;
      robot.mode = next;
      if (!robot.boredomRead && modes.has(robot.key)) {
        robot.boredomRead = true;
        robot.boredom = next.state === "free" && next.idleFor !== undefined
          ? Math.min(0.95, Math.max(0, next.idleFor) / AGENT_BORED_MINUTES)
          : next.state === "free" ? robot.boredom : 0;
        // Seen for the first time already at work: no fuss.
        if (before.state === "free" && next.state !== "free") {
          this.replan(robot, now);
          continue;
        }
      }
      if (before.state === "free" && next.state === "working") {
        this.excite(robot, now);
        continue;
      }
      if (before.state !== next.state) this.replan(robot, now);
      else if (before.label !== next.label && next.state !== "free") robot.plan.label = this.overrideLabel(robot);
    }
  }

  /** Work came: a jump and a cheer, the more bored the bigger, then off to
   *  its desk at a run. */
  private excite(robot: SimRobot, now: number) {
    const bored = robot.boredom;
    this.release(robot, now);
    robot.perched = false;
    robot.excitedUntil = now + 4;
    robot.bubble = { text: bored > 0.5 ? "work! ✨" : "!", tone: "plain", until: now + 2 };
    const then = this.choose(robot, now);
    robot.plan = {
      label: "Got work!", goal: null,
      act: { kind: "cheer", seconds: bored > 0.5 ? 1.6 : 0.8, then },
      since: now,
    };
  }

  /** How bored it is (0 to 1), and whether it is excited right now. */
  mood(key: string): { boredom: number; excited: boolean } | null {
    const robot = this.robots.get(key);
    return robot ? { boredom: robot.boredom, excited: robot.excitedUntil > this.clockNow } : null;
  }

  /** Something happened to a resident on the island, by the host's word. */
  event(kind: "wish" | "gift", key: string, now: number) {
    const robot = this.robots.get(key);
    if (!robot || robot.mode.state !== "free") return;
    this.release(robot, now);
    if (kind === "wish") {
      const angle = robot.rng() * Math.PI * 2;
      const spot = { x: this.places.tree.x + Math.sin(angle) * 2.6, z: this.places.tree.z + Math.cos(angle) * 2.6 };
      robot.plan = {
        label: "Hanging a wish on the tree", goal: spot,
        act: { kind: "wish", seconds: 3.5, face: faceTowards(spot, this.places.tree) },
      };
    } else {
      robot.plan = { label: "Opening a present", goal: null, act: { kind: "cheer", seconds: 4 } };
      robot.bubble = { text: "🎁", tone: "plain", until: now + 4 };
      // Nobody is bored on the day a wish comes true.
      robot.boredom = 0;
      robot.excitedUntil = now + 4;
    }
    this.route(robot);
  }

  /** Their home changed (someone moved in or out): everyone who lives there
   *  and is free goes home and builds on it together for a little while. */
  buildHome(plotId: string, now: number) {
    for (const robot of this.robots.values()) {
      const home = this.places.plots.get(robot.key);
      if (!home || home.id !== plotId || robot.mode.state !== "free" || robot.plan.act.kind === "sleep") continue;
      this.release(robot, now);
      robot.perched = false;
      const angle = robot.rng() * Math.PI * 2;
      const spot = { x: home.center.x + Math.sin(angle) * 2.4, z: home.center.z + Math.cos(angle) * 2.4 };
      robot.plan = {
        label: "Building our home together", goal: spot,
        act: { kind: "tend", seconds: 6 + robot.rng() * 4, face: faceTowards(spot, home.center) },
      };
      robot.bubble = { text: "🔨", tone: "plain", until: now + 3 };
      robot.boredom = Math.max(0, robot.boredom - 0.4);
      this.route(robot);
    }
  }

  /** A bot that just came steps off the boat at `at` and walks home. */
  landAt(key: string, at: { x: number; z: number; face: number }, now: number) {
    const robot = this.robots.get(key);
    if (!robot) return;
    this.release(robot, now);
    robot.x = at.x;
    robot.z = at.z;
    robot.heading = at.face;
    const home = this.places.plots.get(key);
    robot.plan = {
      label: "Arriving on the island",
      goal: home ? { x: home.door.x, z: home.door.z, face: home.front.face + Math.PI } : null,
      act: { kind: "cheer", seconds: 3 },
    };
    robot.bubble = { text: "hi!", tone: "plain", until: now + 3 };
    this.route(robot);
  }

  setWishQueue(tickets: readonly {id:string;key:string}[]) {
    this.wishTickets=[...tickets];
    for(const id of this.wishPatience.keys())if(!tickets.some(t=>t.id===id))this.wishPatience.delete(id);
    for(const robot of this.robots.values()) {
      const act=robot.plan.act;
      if((act.kind==='wish-queue'||act.kind==='wish-register')&&!tickets.some(t=>t.id===act.ticket)){this.release(robot,this.clockNow);robot.plan={label:'Wish registered',goal:null,act:{kind:'cheer',seconds:2},since:this.clockNow};robot.bubble={text:'✨',tone:'plain',until:this.clockNow+2};}
    }
  }
  private wishQueue(now:number) {
    for(const ticket of this.wishTickets) {
      const robot=this.robots.get(ticket.key);
      if(robot && (robot.mode.state!=='free'||isNight(this.hour,robot.bedtimeShift)) && ['wish-queue','wish-register'].includes(robot.plan.act.kind)) {
        this.wishPatience.delete(ticket.id);this.replan(robot,now);
      }
    }
    for(const ticket of this.wishTickets) {
      const patience=this.wishPatience.get(ticket.id);
      if(patience?.gaveUp&&now>=patience.next){patience.next=now+8;this.onWishGiveUp?.(ticket.id);}
    }
    const present=this.wishTickets.filter(t=>{if(this.wishPatience.get(t.id)?.gaveUp)return false;const r=this.robots.get(t.key);return r&&r.mode.state==='free'&&!isNight(this.hour,r.bedtimeShift)});
    for(const [index,ticket] of present.entries()) {
      const robot=this.robots.get(ticket.key)!;const act=robot.plan.act;
      if(act.kind==='wish-register'&&act.ticket===ticket.id)continue;
      if(act.kind==='wish-queue'&&act.ticket===ticket.id&&act.index===index)continue;
      this.release(robot,now);robot.perched=false;
      robot.plan={label:'Queuing at BOT Society',goal:societyQueueSpot(index),act:{kind:'wish-queue',ticket:ticket.id,index}};
      this.route(robot);
    }
  }
  useAsset(siteKey:string,robotKey?:string):string|null {
    const site=this.places.activities?.find(s=>s.key===siteKey);
    if(!site) {
      const seat=this.places.seats.find(s=>s.kind==='seat'&&s.key.startsWith(siteKey+':'));
      if(!seat)return null;
      const holder=this.taken.get(seat.key);if(holder)return holder;
      const candidates=[...this.robots.values()].filter(r=>(!robotKey||r.key===robotKey)&&r.mode.state==='free'&&!isNight(this.hour,r.bedtimeShift)&&!this.busyPlaying(r)&&r.plan.act.kind!=='sleep');
      candidates.sort((a,b)=>Math.hypot(a.x-seat.x,a.z-seat.z)-Math.hypot(b.x-seat.x,b.z-seat.z));
      for(const robot of candidates){const path=this.nav.path(robot,seat);if(!path)continue;this.release(robot,this.clockNow);this.takeSeat(robot,seat);robot.plan={label:`Sitting on ${seat.name}`,goal:seat,act:{kind:'sit',seat,seconds:25}};robot.path=path;return robot.key;}
      return null;
    }
    const holder=this.taken.get(siteKey);if(holder)return !robotKey||robotKey===holder?holder:null;
    const candidates=[...this.robots.values()].filter(r=>(!robotKey||r.key===robotKey)&&r.mode.state==='free'&&!isNight(this.hour,r.bedtimeShift)
      &&!['sleep','wish-queue','wish-register','interact'].includes(r.plan.act.kind)&&likesActivity(r.resident.hobbies,site.activity));
    candidates.sort((a,b)=>Math.hypot(a.x-site.x,a.z-site.z)-Math.hypot(b.x-site.x,b.z-site.z));
    for(const robot of candidates) {
      const path=this.nav.path(robot,site);if(!path)continue;
      this.release(robot,this.clockNow);this.taken.set(site.key,robot.key);robot.perched=false;
      robot.plan={label:`${({read:'Reading at',paint:'Painting at',garden:'Planting and watering at',perform:'Performing at',play:'Playing at',observe:'Enjoying'})[site.activity]} ${site.name}`,goal:site,act:{kind:'interact',site,seconds:site.activity==='perform'?25:14}};
      robot.path=path;return robot.key;
    }
    return null;
  }

  update(dt: number, now: number, hour: number) {
    this.hour = hour;
    this.clockNow = now;
    const step = Math.min(dt, 0.1);
    this.wishQueue(now);
    this.playground(step, now);
    for (const robot of this.robots.values()) {
      this.tick(robot, step, now);
      this.feel(robot, step);
    }
    this.concerts(now);
    this.greetings(now);
  }

  /** A performance gathers only nearby, unoccupied residents. */
  private concerts(now: number) {
    for (const performer of this.robots.values()) {
      if (performer.mode.state !== "free" || !this.performing(performer) || performer.path.length) continue;
      const watching = [...this.robots.values()].filter(r => r.plan.act.kind === "watch" && r.plan.act.performer === performer.key);
      if (watching.length >= 5) continue;
      for (const guest of this.robots.values()) {
        if (guest === performer || guest.mode.state !== "free" || guest.chatAfter > now || guest.plan.seek
          || !["look", "gaze", "sit"].includes(guest.plan.act.kind)
          || Math.hypot(guest.x - performer.x, guest.z - performer.z) > 8) continue;
        const angle = performer.heading + Math.PI * 2 * watching.length / 5;
        const spot = { x: performer.x + Math.sin(angle) * 2.4, z: performer.z + Math.cos(angle) * 2.4 };
        const path = this.nav.path(guest, spot);
        if (!path) continue;
        this.release(guest, now);
        guest.perched = false;
        guest.plan = { label: `Watching ${performer.resident.name} perform`, goal: spot, act: { kind: "watch", performer: performer.key } };
        guest.path = path;
        watching.push(guest);
        if (watching.length >= 5) break;
      }
    }
  }

  private performing(robot:SimRobot):boolean {return robot.plan.act.kind==='dance'||(robot.plan.act.kind==='interact'&&robot.plan.act.site.activity==='perform')}

  audience(key: string): number {
    return [...this.robots.values()].filter(r => r.mode.state === "free" && !r.path.length
      && r.plan.act.kind === "watch" && r.plan.act.performer === key).length;
  }

  /** Boredom goes up while nothing happens and down while something fun
   *  does; work takes it away at once; asleep, it rests where it is. */
  private feel(robot: SimRobot, dt: number) {
    const kind = robot.plan.act.kind;
    if (robot.mode.state === "working" || robot.excitedUntil > this.clockNow) {
      robot.boredom = Math.max(0, robot.boredom - dt * 0.5);
      return;
    }
    if (kind === "sleep") return;
    const fun = kind === "swing" || kind === "seesaw" || kind === "tag" || kind === "dance"
      || kind === "chat" || (kind === "slide" && this.slideRide?.key === robot.key) || kind === "cheer";
    robot.boredom = Math.min(1, Math.max(0, robot.boredom + (fun ? -FUN_PER_SECOND : BORED_PER_SECOND) * dt));
  }

  // --- the robots ---------------------------------------------------------

  private tick(robot: SimRobot, dt: number, now: number) {
    if (robot.bubble && robot.bubble.until < now) robot.bubble = null;
    if (robot.gesture && robot.gesture.until < now) robot.gesture = null;
    const plan = robot.plan;
    if (plan.act.kind === "watch") {
      const performer = this.robots.get(plan.act.performer);
      if (!performer || performer.mode.state !== "free" || !this.performing(performer) || performer.path.length) {
        robot.chatAfter = now + 30;
        this.replan(robot, now);
        return;
      }
    }
    if(plan.act.kind==='interact') {
      const site=plan.act.site;
      const live=(this.places.activities??[]).find(s=>s.key===site.key);
      if(!live||live.activity!==site.activity||Math.hypot(live.x-site.x,live.z-site.z)>0.01||Math.abs(live.y-site.y)>.01){this.replan(robot,now);return;}
    }
    if (plan.act.kind === "tag" && plan.since !== undefined) {
      this.tagTick(robot, plan.act.game, dt, now);
      return;
    }
    if (this.slideRide?.key === robot.key) return;
    // Walking to someone moves the goal with them.
    if (plan.seek) {
      const other = this.robots.get(plan.seek);
      if (!other || other.plan.act.kind === "sleep" || other.mode.state !== "free" || this.busyPlaying(other)) {
        this.replan(robot, now);
        return;
      }
      const distance = Math.hypot(other.x - robot.x, other.z - robot.z);
      if (distance < 1.5) {
        if (plan.act.kind !== "invite") this.startChat(robot, other, now);
        else if (plan.act.answer === "yes" || (plan.act.answer !== "no" && this.accepts(other))) this.startPlay(plan.act.game, robot, other, now);
        else this.decline(robot, other, now);
        return;
      }
      if (now > robot.repathAt) {
        robot.repathAt = now + 1.2;
        robot.path = this.nav.path(robot, other) ?? [];
        if (!robot.path.length) { this.replan(robot, now); return; }
      }
    }
    if (robot.path.length) {
      this.walk(robot, dt);
      return;
    }
    if (plan.since === undefined) this.begin(robot, now);
    this.act(robot, dt, now);
    if (robot.gesture && (robot.pose === "stand" || robot.pose === "talk")) robot.pose = robot.gesture.pose;
  }

  private walk(robot: SimRobot, dt: number) {
    let budget = robot.speed * dt;
    robot.pose = "walk";
    robot.perched = false;
    while (budget > 0 && robot.path.length) {
      const next = robot.path[0];
      const dx = next.x - robot.x;
      const dz = next.z - robot.z;
      const distance = Math.hypot(dx, dz);
      if (distance <= budget) {
        robot.x = next.x;
        robot.z = next.z;
        budget -= distance;
        robot.stride = (robot.stride + distance / STEP) % 1;
        robot.path.shift();
        continue;
      }
      robot.x += (dx / distance) * budget;
      robot.z += (dz / distance) * budget;
      robot.stride = (robot.stride + budget / STEP) % 1;
      this.turn(robot, Math.atan2(dx, dz), dt);
      budget = 0;
    }
  }

  private turn(robot: SimRobot, target: number, dt: number) {
    let delta = target - robot.heading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    const most = TURN * dt;
    robot.heading += Math.max(-most, Math.min(most, delta));
  }

  /** It has arrived: settle on the goal's spot and start. */
  private begin(robot: SimRobot, now: number) {
    const plan = robot.plan;
    plan.since = now;
    if (plan.goal) {
      robot.x = plan.goal.x;
      robot.z = plan.goal.z;
    }
    const act = plan.act;
    const seat = "seat" in act ? act.seat : null;
    robot.perched = !!seat;
    if (seat) {
      robot.x = seat.x;
      robot.z = seat.z;
      robot.y = seat.y;
      robot.heading = seat.face;
    } else if (plan.goal?.face !== undefined) robot.heading = plan.goal.face;
    if(act.kind==='interact'){robot.heading=act.site.face;robot.y=act.site.y;robot.perched=act.site.y>.1;}
    if (act.kind === "seesaw") {
      this.seesawSeated[act.end] = true;
      // The second rider may arrive late in the island's day. Start the
      // ride before its first act, rather than timing it from zero until
      // the next playground frame and immediately ending it as overdue.
      if (this.seesawSeated[0] && this.seesawSeated[1] && this.seesawSince === 0) this.seesawSince = now;
    }
    if (act.kind === "slide" && !this.slideQueue.includes(robot.key)) this.slideQueue.push(robot.key);
    if (act.kind === "chat" && act.first) robot.bubble = { text: "hi!", tone: "plain", until: now + 1.6 };
  }

  private act(robot: SimRobot, dt: number, now: number) {
    const plan = robot.plan;
    const act = plan.act;
    const elapsed = now - (plan.since ?? now);
    const ended = (seconds: number) => elapsed >= seconds;
    const pg = this.places.playground;
    switch (act.kind) {
      case "wish-queue": {
        robot.y=.15;robot.perched=true;
        robot.pose='stand';this.turn(robot,Math.PI,dt);
        let patience=this.wishPatience.get(act.ticket);
        if(!patience){patience={since:now,next:now+45+robot.rng()*35,gaveUp:false};this.wishPatience.set(act.ticket,patience);}
        if(act.index>0&&now>=patience.next){
          patience.next=now+10;
          if(robot.rng()<.35){
            patience.gaveUp=true;patience.next=now+8;
            this.release(robot,now);robot.plan={label:'Maybe another time',goal:null,act:{kind:'look',seconds:4},since:now};
            robot.bubble={text:'maybe later…',tone:'plain',until:now+4};
            robot.chatAfter=now+30;this.onWishGiveUp?.(act.ticket);return;
          }
        }
        if(act.index===0 && elapsed>.5){robot.plan={label:'Registering a wish at BOT Society',goal:{...SOCIETY_COUNTER,face:Math.PI},act:{kind:'wish-register',ticket:act.ticket}};this.route(robot);}
        return;
      }
      case "wish-register":
        robot.y=.15;robot.perched=true;
        robot.pose='register';this.turn(robot,Math.PI,dt);
        robot.bubble={text:'📝 ✨',tone:'plain',until:now+1};
        if(elapsed>=4 && (act.triedAt===undefined || now-act.triedAt>5)){act.triedAt=now;this.onWishRegister?.(act.ticket);}
        return;
      case "interact": {
        const activity=act.site.activity;
        robot.pose=activity==='perform'?'dance':activity==='observe'?'think':activity==='play'?'cheer':activity==='read'?'think':'work';
        robot.heading=act.site.face;
        robot.bubble={text:({read:'📖',paint:'🎨',garden:elapsed<5?'🌱':'💧',perform:'🎵',play:'🎮',observe:'✨'})[activity],tone:'plain',until:now+1};
        robot.boredom=Math.max(0,robot.boredom-dt/30);
        if(ended(act.seconds))this.replan(robot,now);
        return;
      }
      case "look":
        robot.pose = "stand";
        if (act.face !== undefined) this.turn(robot, act.face, dt);
        this.sigh(robot, dt, now);
        if (ended(act.seconds)) this.replan(robot, now);
        return;
      case "sit":
        robot.pose = "sit";
        this.sigh(robot, dt, now);
        // Too bored to sit still for long.
        if (ended(robot.boredom > 0.8 ? Math.min(act.seconds, 8) : act.seconds)) this.replan(robot, now);
        return;
      case "sleep":
        robot.pose = "sleep";
        if (!robot.bubble || robot.bubble.until < now + 0.5) robot.bubble = { text: "z", tone: "sleep", until: now + 6 };
        if (!isNight(this.hour, robot.bedtimeShift)) this.replan(robot, now);
        return;
      case "gaze":
        robot.pose = robot.perched ? "sit" : "stand";
        this.turn(robot, act.face, dt);
        this.sigh(robot, dt, now);
        if (ended(act.seconds)) this.replan(robot, now);
        return;
      case "watch": {
        const performer = this.robots.get(act.performer);
        if (!performer || performer.mode.state !== "free" || !this.performing(performer) || performer.path.length) {
          robot.chatAfter = now + 30;
          this.replan(robot, now);
          return;
        }
        this.turn(robot, faceTowards(robot, performer), dt);
        robot.pose = Math.floor(elapsed / 2) % 3 === 1 ? "cheer" : "stand";
        robot.boredom = Math.max(0, robot.boredom - dt / 45);
        return;
      }
      case "dance":
        robot.pose = "dance";
        if (!robot.bubble) robot.bubble = { text: "🎵", tone: "plain", until: now + 2.5 };
        if (ended(act.seconds)) this.replan(robot, now);
        return;
      case "tend":
        robot.pose = "think";
        this.turn(robot, act.face, dt);
        if (ended(act.seconds)) this.replan(robot, now);
        return;
      case "chat": {
        const other = this.robots.get(act.with);
        if (!other || ended(act.seconds)) {
          robot.chatAfter = now + 25 + robot.rng() * 40;
          // A good chat between two who like to play can end in a game.
          if (other && act.first && pg && this.likesToPlay(robot) && robot.rng() < 0.4 && other.plan.act.kind === "chat") {
            robot.bubble = { text: "wanna play?", tone: "plain", until: now + 1.8 };
            this.startPlay(pick(this.jointGames(), robot.rng) ?? "tag", robot, other, now);
            return;
          }
          this.replan(robot, now);
          return;
        }
        this.turn(robot, faceTowards(robot, other), dt);
        // Turns to talk: whoever's second it is gestures and says something.
        const theirs = Math.floor(elapsed / 1.8) % 2 === (act.first ? 0 : 1);
        robot.pose = theirs ? "talk" : "stand";
        if (theirs && elapsed > 1.6 && (!robot.bubble || robot.bubble.until < now)) {
          robot.bubble = { text: this.chatLine(robot, other), tone: "plain", until: now + 1.6 };
        }
        return;
      }
      case "invite":
        // Walking to the friend is `seek`; standing here means they were lost.
        this.replan(robot, now);
        return;
      case "sob": {
        robot.pose = "sob";
        if (!robot.bubble) robot.bubble = { text: Math.floor(elapsed / 1.6) % 2 ? "sob…" : "😭", tone: "plain", until: now + 1.5 };
        if (!ended(act.seconds)) return;
        // Dry its eyes, and try someone else, or go.
        const another = act.then === "ask"
          ? nearest(this.partners(robot, 30).filter((friend) => friend.key !== act.from), robot, robot.rng)
          : null;
        if (another) this.invite(robot.key, another.key, pick(this.jointGames(), robot.rng) ?? "tag", now);
        else this.replan(robot, now);
        return;
      }
      case "swing": {
        if (!pg) { this.replan(robot, now); return; }
        const anchor = pg.swings[act.swing];
        this.swingAmp[act.swing] = Math.min(0.62, this.swingAmp[act.swing] + dt * 0.07);
        const angle = this.motion.swings[act.swing];
        const at = swingSeat(anchor, angle);
        robot.perched = true;
        robot.x = at.x; robot.z = at.z; robot.y = at.y; robot.heading = at.face;
        robot.pose = "swing";
        robot.lean = angle;
        if (!robot.bubble && robot.rng() < dt * 0.25) robot.bubble = { text: pick(["wheee!", "😄", "✨", "higher!"], robot.rng)!, tone: "plain", until: now + 1.5 };
        if (ended(act.seconds)) this.replan(robot, now);
        return;
      }
      case "seesaw": {
        if (!pg) { this.replan(robot, now); return; }
        const at = seesawSeat(pg.seesaw, act.end, this.motion.seesaw);
        robot.perched = true;
        robot.x = at.x; robot.z = at.z; robot.y = at.y; robot.heading = at.face;
        robot.pose = "ride";
        const other = this.seesawRider[act.end === 0 ? 1 : 0];
        const both = this.seesawSeated[0] && this.seesawSeated[1];
        if (!both) {
          // A wave is an invitation, not just a bubble: ask an awake, free
          // friend without waiting for its next random choice of activity.
          if (!robot.bubble) robot.bubble = { text: "🙋", tone: "plain", until: now + 2.2 };
          if (!other && elapsed > 2 && now >= (act.askAt ?? 0)) {
            act.askAt = now + 3;
            const friend = nearest(this.partners(robot, 40).filter((r) => !act.asked?.includes(r.key)), robot, robot.rng);
            if (friend) {
              (act.asked ??= []).push(friend.key);
              if (this.accepts(friend)) {
                this.release(friend, now);
                friend.perched = false;
                friend.plan = this.seesawPlan(friend, act.end === 0 ? 1 : 0, robot.resident.name);
                this.route(friend);
                if (friend.plan.act.kind === "seesaw") {
                  friend.bubble = { text: "coming!", tone: "plain", until: now + 2.2 };
                  robot.plan.label = `On the seesaw with ${friend.resident.name}`;
                  return;
                }
              } else {
                friend.bubble = { text: "maybe later", tone: "plain", until: now + 2.2 };
              }
            }
          }
          if (!other && elapsed > 16) this.sob(robot, now, "nobody came to play", "leave");
          return;
        }
        if (!robot.bubble && robot.rng() < dt * 0.3) robot.bubble = { text: pick(["haha!", "up!", "😄", "🎵", "whoa!"], robot.rng)!, tone: "plain", until: now + 1.4 };
        if (now - this.seesawSince > act.seconds) this.replan(robot, now);
        return;
      }
      case "slide": {
        // Waiting its turn at the ladder; the slide itself is `playground`.
        robot.pose = "stand";
        if (pg) this.turn(robot, pg.slide.face, dt);
        if (elapsed > 40) this.replan(robot, now);
        return;
      }
      case "tag":
        return;
      case "work":
        robot.pose = "work";
        if (!robot.bubble || robot.bubble.until < now + 0.5) robot.bubble = { text: "…", tone: "work", until: now + 4 };
        return;
      case "wait":
        robot.pose = "raise";
        this.turn(robot, act.face, dt);
        if (!robot.bubble || robot.bubble.until < now + 0.5) robot.bubble = { text: "?", tone: "decide", until: now + 4 };
        return;
      case "trouble":
        robot.pose = "think";
        if (!robot.bubble || robot.bubble.until < now + 0.5) robot.bubble = { text: "!", tone: "danger", until: now + 4 };
        return;
      case "wish":
        robot.pose = elapsed < act.seconds * 0.6 ? "raise" : "cheer";
        this.turn(robot, act.face, dt);
        if (ended(act.seconds)) this.replan(robot, now);
        return;
      case "cheer":
        robot.pose = "cheer";
        if (!ended(act.seconds)) return;
        if (act.then) {
          // On to what the cheer was for (its desk, after work came), at a run.
          robot.plan = act.then;
          robot.speed = robot.excitedUntil > now ? 1.6 : SPEED;
          this.route(robot);
        } else this.replan(robot, now);
        return;
    }
  }

  /** Now and then a bored robot says so. */
  private sigh(robot: SimRobot, dt: number, now: number) {
    if (robot.boredom < 0.72 || robot.bubble || robot.rng() > dt * 0.08) return;
    robot.bubble = { text: pick(["🥱", "so bored…", "hmm…", "anyone?"], robot.rng)!, tone: "plain", until: now + 2 };
  }

  /** What one robot says to another in a chat. */
  private chatLine(robot: SimRobot, other: SimRobot): string {
    const rng = robot.rng;
    const worn = other.resident.look.worn;
    if (worn.head && rng() < 0.25) return "nice hat!";
    if (worn.back && rng() < 0.2) return "cool backpack!";
    if (other.resident.owner.kind === "agent" && rng() < 0.15) return "busy day?";
    if (this.likesToPlay(robot) && rng() < 0.12) return "wanna play?";
    return pick(CHAT_LINES, rng) ?? "😄";
  }

  /** Let go of everything a robot holds: its seat, its swing, its end of
   *  the seesaw, its place at the slide, its game. */
  private release(robot: SimRobot, now: number) {
    for (const [seat, holder] of [...this.taken]) if (holder === robot.key) this.taken.delete(seat);
    this.swingRider = this.swingRider.map((holder) => (holder === robot.key ? null : holder));
    for (const end of [0, 1] as const) {
      if (this.seesawRider[end] === robot.key) {
        this.seesawRider[end] = null;
        this.seesawSeated[end] = false;
      }
    }
    this.slideQueue = this.slideQueue.filter((key) => key !== robot.key);
    if (this.slideRide?.key === robot.key) this.slideRide = null;
    const act = robot.plan.act;
    if (act.kind === "tag") this.endTag(act.game, now, robot.key);
    robot.path = [];
    robot.plan.seek = undefined;
    robot.speed = SPEED;
    robot.lean = 0;
    // Off whatever it was on, down to the ground where it is.
    if (robot.perched && !("seat" in act && act.seat)) robot.perched = false;
  }

  /** Choose what to do next and set off. */
  private replan(robot: SimRobot, now: number) {
    this.release(robot, now);
    robot.perched = false;
    robot.plan = this.choose(robot, now);
    this.route(robot);
  }

  private route(robot: SimRobot) {
    const plan = robot.plan;
    plan.since = undefined;
    robot.path = [];
    if (plan.seek) {
      robot.repathAt = 0;
      return;
    }
    if (!plan.goal) return;
    const from = { x: robot.x, z: robot.z };
    if (Math.hypot(plan.goal.x - from.x, plan.goal.z - from.z) < 0.05) return;
    const way = this.nav.path(from, plan.goal);
    if (way) {
      robot.path = way;
      return;
    }
    // Nowhere to walk to. A seat it cannot reach is let go, or it would sit
    // in the air where it stands; anything else it does where it is.
    if (("seat" in plan.act && plan.act.seat) || PLAY_KINDS.has(plan.act.kind) || plan.act.kind==='wish-queue' || plan.act.kind==='wish-register') {
      this.release(robot, 0);
      robot.plan = { label: "Looking around", goal: null, act: { kind: "look", seconds: 2 + robot.rng() * 3 } };
      return;
    }
    plan.goal = null;
  }

  private overrideLabel(robot: SimRobot): string {
    const label = robot.mode.label;
    switch (robot.mode.state) {
      case "working": return label ? `Working · ${label}` : "Working";
      case "needs_you": return label ? `Waiting for you · ${label}` : "Waiting for you";
      case "failed": return label ? `Stuck · ${label}` : "Something went wrong";
      default: return "Looking around";
    }
  }

  private ownSeat(robot: SimRobot, kind: Seat["kind"]): Seat | null {
    const plot = this.places.plots.get(robot.key);
    if (!plot) return null;
    return this.places.seats.find((s) => s.plot === plot.id && s.kind === kind && (!s.owner || s.owner === robot.key) && !this.taken.has(s.key)) ?? null;
  }

  private takeSeat(robot: SimRobot, seat: Seat | null): Seat | null {
    if (seat) this.taken.set(seat.key, robot.key);
    return seat;
  }

  private likesToPlay(robot: SimRobot): boolean {
    return LEANS[robot.resident.trait ?? "agent"].play >= 0.9;
  }

  /** The heart of it: what a robot does next. */
  choose(robot: SimRobot, now: number): Plan {
    const rng = robot.rng;
    const home = this.places.plots.get(robot.key);
    switch (robot.mode.state) {
      case "working": {
        const desk = this.takeSeat(robot, this.ownSeat(robot, "desk"));
        const goal = desk ?? (home ? home.center : null);
        return { label: this.overrideLabel(robot), goal: goal && { x: goal.x, z: goal.z }, act: { kind: "work", seat: desk } };
      }
      case "needs_you":
        return {
          label: this.overrideLabel(robot),
          goal: home ? { x: home.front.x, z: home.front.z, face: home.front.face } : null,
          act: { kind: "wait", face: home?.front.face ?? robot.heading },
        };
      case "failed": {
        const desk = this.takeSeat(robot, this.ownSeat(robot, "desk"));
        const goal = desk ?? (home ? home.center : null);
        return { label: this.overrideLabel(robot), goal: goal && { x: goal.x, z: goal.z }, act: { kind: "trouble", seat: desk } };
      }
    }

    if (isNight(this.hour, robot.bedtimeShift)) {
      const bed = this.takeSeat(robot, this.ownSeat(robot, "bed") ?? this.ownSeat(robot, "seat"));
      const goal = bed ?? home?.center ?? null;
      return { label: "Asleep", goal: goal && { x: goal.x, z: goal.z }, act: { kind: "sleep", seat: bed } };
    }

    const activities=(this.places.activities??[]).filter(site=>!this.taken.has(site.key)&&likesActivity(robot.resident.hobbies,site.activity));
    if(activities.length && rng()<.4) {
      const site=nearest(activities,robot,rng);
      if(site && this.nav.path(robot,site)) {
        this.taken.set(site.key,robot.key);
        return {label:`${site.activity==='garden'?'Planting and watering':'Enjoying'} ${site.name}`,goal:site,act:{kind:'interact',site,seconds:site.activity==='perform'?25:14}};
      }
    }
    const lean = { ...LEANS[robot.resident.trait ?? "agent"] };
    // The more bored, the more it goes looking for fun and company.
    const bored = robot.boredom;
    if (bored > 0.5) {
      lean.play *= 1 + bored * 3;
      lean.chat *= 1 + bored * 2;
      lean.dance *= 1 + bored;
      lean.sit *= 0.5;
      lean.gaze *= 0.6;
    }
    if(!robot.resident.hobbies?.includes('gardening') && robot.resident.trait!=='gardener' && robot.resident.trait!=='tinkerer')lean.tend=0;
    const free = this.freeSeats();
    if (!free.length) lean.sit = 0;
    if (now < robot.chatAfter || this.partners(robot).length === 0) lean.chat = 0;
    if (!this.places.playground) lean.play = 0;
    const kind = weighted(lean, rng);
    switch (kind) {
      case "play": {
        const plan = this.choosePlay(robot, now);
        if (plan) return plan;
        break;
      }
      case "sit": {
        const seat = this.takeSeat(robot, nearest(free, robot, rng));
        if (!seat) break;
        return {
          label: seat.plot ? `Sitting on ${seat.name}` : `Resting on ${seat.name}`,
          goal: { x: seat.x, z: seat.z }, act: { kind: "sit", seat, seconds: 12 + rng() * 30 },
        };
      }
      case "gaze": {
        const angle = rng() * Math.PI * 2;
        const r = this.places.radius - 2.2;
        const spot = { x: Math.sin(angle) * r, z: Math.cos(angle) * r };
        return {
          label: "Watching the sea", goal: spot,
          act: { kind: "gaze", seconds: 10 + rng() * 18, face: Math.atan2(spot.x, spot.z) },
        };
      }
      case "visit": {
        const plots = [...this.places.plots.entries()].filter(([key]) => key !== robot.key);
        const [, plot] = pick(plots, rng) ?? [];
        if (!plot) break;
        return {
          label: "Visiting a neighbour", goal: { x: plot.front.x, z: plot.front.z },
          act: { kind: "look", seconds: 4 + rng() * 6, face: plot.front.face + Math.PI },
        };
      }
      case "chat": {
        const partner = nearest(this.partners(robot), robot, rng);
        if (!partner) break;
        return {
          label: `Going to see ${partner.resident.name}`,
          goal: null, seek: partner.key,
          act: { kind: "look", seconds: 2 },
        };
      }
      case "dance": {
        const angle = rng() * Math.PI * 2;
        const r = 2.6 + rng() * 1.2;
        return {
          label: "Dancing on the plaza", goal: { x: Math.sin(angle) * r, z: Math.cos(angle) * r },
          act: { kind: "dance", seconds: 18 + rng() * 10 },
        };
      }
      case "tend": {
        const center = home?.center ?? { x: 0, z: 0 };
        const spot = { x: center.x + (rng() - 0.5) * 6, z: center.z + (rng() - 0.5) * 6 };
        return {
          label: robot.resident.trait === "tinkerer" ? "Tinkering" : "Tending the garden",
          goal: spot, act: { kind: "tend", seconds: 6 + rng() * 8, face: rng() * Math.PI * 2 },
        };
      }
    }
    // Wander: somewhere it can walk to, near home more often than not.
    const near = home && rng() < 0.55;
    const center = near ? home!.center : { x: 0, z: 0 };
    const reach = near ? 6 : this.places.radius - 4;
    for (let tries = 0; tries < 6; tries++) {
      const angle = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * reach;
      const spot = { x: center.x + Math.sin(angle) * r, z: center.z + Math.cos(angle) * r };
      if (Math.hypot(spot.x, spot.z) > this.places.radius - 2) continue;
      if (!this.nav.isFree(spot)) continue;
      return { label: "Exploring", goal: spot, act: { kind: "look", seconds: 2 + rng() * 5 } };
    }
    return { label: "Looking around", goal: null, act: { kind: "look", seconds: 3 } };
  }

  private freeSeats(): Seat[] {
    return this.places.seats.filter((s) => s.kind === "seat" && !this.taken.has(s.key));
  }

  private busyPlaying(robot: SimRobot): boolean {
    return PLAY_KINDS.has(robot.plan.act.kind) || ['interact','wish-queue','wish-register'].includes(robot.plan.act.kind) || this.slideQueue.includes(robot.key);
  }

  /** Who it could go and talk to, or ask to play: free, awake, not already
   *  talking or playing, not too far. */
  private partners(robot: SimRobot, reach = 18): SimRobot[] {
    return [...this.robots.values()].filter((other) =>
      other !== robot
      && other.mode.state === "free"
      && other.plan.act.kind !== "sleep"
      && other.plan.act.kind !== "chat"
      && !other.plan.seek
      && !this.busyPlaying(other)
      && Math.hypot(other.x - robot.x, other.z - robot.z) < reach);
  }

  private startChat(robot: SimRobot, other: SimRobot, now: number) {
    const seconds = 7 + robot.rng() * 9;
    for (const [one, two, first] of [[robot, other, true], [other, robot, false]] as const) {
      this.release(one, now);
      one.perched = false;
      one.plan = {
        label: `Chatting with ${two.resident.name}`, goal: null,
        act: { kind: "chat", with: two.key, seconds, first }, since: now,
      };
      if (first) one.bubble = { text: "hi!", tone: "plain", until: now + 1.6 };
    }
  }

  /** What it says and does when it passes someone: "hi!", and a wave if it
   *  is standing about. Once for the same two in a while. */
  private greetings(now: number) {
    if (now < this.greetAt) return;
    this.greetAt = now + 1.2;
    const awake = [...this.robots.values()].filter((robot) =>
      robot.plan.act.kind !== "sleep" && !robot.perched && robot.plan.act.kind !== "work"
      && robot.plan.act.kind !== "tag" && robot.plan.act.kind !== "sob" && this.slideRide?.key !== robot.key);
    for (let i = 0; i < awake.length; i++) {
      for (let j = i + 1; j < awake.length; j++) {
        const a = awake[i];
        const b = awake[j];
        if (now < (this.helloAfter.get(a.key) ?? 0) || now < (this.helloAfter.get(b.key) ?? 0)) continue;
        if (a.bubble || b.bubble || a.plan.seek || b.plan.seek || a.plan.act.kind === "chat" || b.plan.act.kind === "chat") continue;
        if (Math.hypot(a.x - b.x, a.z - b.z) > HELLO_REACH) continue;
        const pair = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
        if (now - (this.greeted.get(pair) ?? -Infinity) < HELLO_AGAIN) continue;
        this.greeted.set(pair, now);
        this.helloAfter.set(a.key, now + HELLO_PAUSE);
        this.helloAfter.set(b.key, now + HELLO_PAUSE);
        for (const [one, two] of [[a, b], [b, a]] as const) {
          if (one.plan.act.kind === "chat") continue;
          if (!one.bubble || one.bubble.tone === "plain") one.bubble = { text: one.rng() < 0.75 ? "hi!" : "👋", tone: "plain", until: now + 1.5 };
          if (!one.path.length) {
            one.gesture = { pose: "wave", until: now + 1.4 };
            one.heading = faceTowards(one, two);
          }
        }
      }
    }
  }

  // --- playing ------------------------------------------------------------

  /** The games two can play right now, the ones whose things are free. */
  private jointGames(): Game[] {
    const games: Game[] = ["tag"];
    if (!this.places.playground) return games;
    if (!this.seesawRider[0] && !this.seesawRider[1]) games.push("seesaw", "seesaw");
    if (!this.swingRider[0] && !this.swingRider[1]) games.push("swings");
    if (this.slideQueue.length < 2 && !this.slideRide) games.push("slide");
    return games;
  }

  private choosePlay(robot: SimRobot, now: number): Plan | null {
    const pg = this.places.playground;
    if (!pg) return null;
    const rng = robot.rng;
    // Someone alone on the seesaw is waiting for exactly this.
    for (const end of [0, 1] as const) {
      const other = end === 0 ? 1 : 0;
      if (!this.seesawRider[end] && this.seesawRider[other] && this.seesawSeated[other] && rng() < 0.8) {
        return this.seesawPlan(robot, end, this.robots.get(this.seesawRider[other]!)?.resident.name);
      }
    }
    // Or go and ask a friend.
    const friends = this.partners(robot, 30);
    if (friends.length && now >= robot.chatAfter && rng() < 0.6) {
      const friend = nearest(friends, robot, rng)!;
      return {
        label: `Asking ${friend.resident.name} to play`,
        goal: null, seek: friend.key,
        act: { kind: "invite", game: pick(this.jointGames(), rng) ?? "tag", with: friend.key },
      };
    }
    // Or play alone, and see who comes.
    const options: (() => Plan | null)[] = [];
    const swing = this.swingRider.findIndex((holder) => !holder);
    if (swing >= 0) options.push(() => this.swingPlan(robot, swing));
    if (this.slideQueue.length < 3) options.push(() => this.slidePlan(2 + Math.floor(rng() * 3)));
    if (!this.seesawRider[0] && !this.seesawRider[1]) options.push(() => this.seesawPlan(robot, rng() < 0.5 ? 0 : 1));
    return pick(options, rng)?.() ?? null;
  }

  private swingPlan(robot: SimRobot, swing: number, friend?: string): Plan {
    const pg = this.places.playground!;
    this.swingRider[swing] = robot.key;
    const stand = pg.swings[swing].stand;
    return {
      label: friend ? `Swinging with ${friend}` : "On the swings",
      goal: { x: stand.x, z: stand.z, face: pg.swings[swing].face },
      act: { kind: "swing", swing, seconds: 14 + robot.rng() * 16 },
    };
  }

  private seesawPlan(robot: SimRobot, end: 0 | 1, friend?: string): Plan {
    const pg = this.places.playground!;
    this.seesawRider[end] = robot.key;
    const stand = pg.seesaw.stand[end];
    return {
      label: friend ? `On the seesaw with ${friend}` : "Waiting for a friend on the seesaw",
      goal: { x: stand.x, z: stand.z },
      act: { kind: "seesaw", end, seconds: 14 + robot.rng() * 12 },
    };
  }

  private slidePlan(runs: number, friend?: string): Plan {
    const pg = this.places.playground!;
    const place = this.slideQueue.length + (this.slideRide ? 1 : 0);
    const queue = { x: pg.slide.queue.x + pg.slide.back.x * place * 0.8, z: pg.slide.queue.z + pg.slide.back.z * place * 0.8 };
    return {
      label: friend ? `Taking turns on the slide with ${friend}` : "Playing on the slide",
      goal: { ...queue, face: pg.slide.face },
      act: { kind: "slide", runs },
    };
  }

  /** Two friends start a game: each gets its part. */
  /** One robot asks another to play a game: it walks over first when they
   *  are apart, and the other says yes or no for itself (`answer` decides
   *  it for a test). Both must be free and awake. */
  invite(fromKey: string, toKey: string, game: Game, now: number, opts: { answer?: "yes" | "no" } = {}): boolean {
    const robot = this.robots.get(fromKey);
    const other = this.robots.get(toKey);
    if (!robot || !other || robot.mode.state !== "free" || other.mode.state !== "free") return false;
    this.release(robot, now);
    robot.perched = false;
    robot.plan = {
      label: `Asking ${other.resident.name} to play`, goal: null, seek: other.key,
      act: { kind: "invite", game, with: other.key, ...(opts.answer ? { answer: opts.answer } : {}) },
    };
    this.route(robot);
    return true;
  }

  /** Sit on the seesaw alone and wait for a friend. */
  waitOnSeesaw(key: string, now: number): boolean {
    const robot = this.robots.get(key);
    if (!robot || !this.places.playground || this.seesawRider[0] || this.seesawRider[1]) return false;
    this.release(robot, now);
    robot.perched = false;
    robot.plan = this.seesawPlan(robot, 0);
    this.route(robot);
    return true;
  }

  /** Whether a robot says yes to a game: almost always when it is bored,
   *  less when it is comfortable where it is or not one for games. */
  private accepts(robot: SimRobot): boolean {
    const trait = robot.resident.trait;
    let yes = 0.68 + robot.boredom * 0.3;
    if (trait === "sporty") yes += 0.15;
    if (trait === "curious") yes += 0.08;
    if (trait === "cozy") yes -= 0.22;
    if (trait === "dreamy") yes -= 0.15;
    if (robot.plan.act.kind === "sit") yes -= 0.15;
    return robot.rng() < Math.min(0.98, Math.max(0.1, yes));
  }

  /** It said no. The one who asked cries a little, then asks someone else
   *  or wanders off. */
  private decline(robot: SimRobot, other: SimRobot, now: number) {
    other.bubble = { text: pick(["not now 😅", "maybe later", "sorry!"], other.rng)!, tone: "plain", until: now + 2.2 };
    if (!other.path.length) {
      other.heading = faceTowards(other, robot);
      other.gesture = { pose: "think", until: now + 1.6 };
    }
    this.sob(robot, now, `${other.resident.name} said no`, robot.rng() < 0.5 ? "ask" : "leave", other.key);
  }

  private sob(robot: SimRobot, now: number, why: string, then: "ask" | "leave", from?: string) {
    this.release(robot, now);
    robot.perched = false;
    robot.boredom = Math.min(1, robot.boredom + 0.12);
    robot.bubble = { text: "😭", tone: "plain", until: now + 1.6 };
    robot.plan = {
      label: `Crying · ${why}`, goal: null,
      act: { kind: "sob", seconds: 3.5 + robot.rng() * 2, then, ...(from ? { from } : {}) },
      since: now,
    };
  }

  private startPlay(game: Game, robot: SimRobot, other: SimRobot, now: number) {
    this.release(robot, now);
    this.release(other, now);
    robot.perched = false;
    other.perched = false;
    robot.bubble = { text: "wanna play?", tone: "plain", until: now + 1.6 };
    other.bubble = { text: "yes!", tone: "plain", until: now + 1.6 };
    robot.chatAfter = other.chatAfter = now + 30 + robot.rng() * 30;
    const available = this.jointGames();
    const chosen = available.includes(game) ? game : "tag";
    const names = [robot.resident.name, other.resident.name];
    if (chosen === "seesaw") {
      robot.plan = this.seesawPlan(robot, 0, names[1]);
      other.plan = this.seesawPlan(other, 1, names[0]);
    } else if (chosen === "swings") {
      robot.plan = this.swingPlan(robot, 0, names[1]);
      other.plan = this.swingPlan(other, 1, names[0]);
    } else if (chosen === "slide") {
      robot.plan = this.slidePlan(3, names[1]);
      other.plan = this.slidePlan(3, names[0]);
    } else {
      const id = `tag-${++this.games}`;
      const it = robot.rng() < 0.5 ? robot.key : other.key;
      this.tags.set(id, {
        id, players: [robot.key, other.key], it, until: now + 22 + robot.rng() * 14,
        center: { x: (robot.x + other.x) / 2, z: (robot.z + other.z) / 2 }, pausedUntil: now + 1.6,
      });
      for (const [one, two] of [[robot, other], [other, robot]] as const) {
        one.plan = { label: `Playing tag with ${two.resident.name}`, goal: null, act: { kind: "tag", game: id }, since: now };
      }
      return;
    }
    // Each joins the slide's queue as it arrives at it.
    this.route(robot);
    this.route(other);
  }

  /** One frame of a game of tag, for one of its two players. */
  private tagTick(robot: SimRobot, id: string, dt: number, now: number) {
    const game = this.tags.get(id);
    const otherKey = game?.players.find((key) => key !== robot.key);
    const other = otherKey ? this.robots.get(otherKey) : undefined;
    if (!game || !other || other.plan.act.kind !== "tag") {
      this.replan(robot, now);
      return;
    }
    if (now > game.until) {
      // Out of breath: a cheer each, and on with the day.
      this.tags.delete(id);
      for (const one of [robot, other]) {
        this.release(one, now);
        one.plan = { label: "Had fun playing tag", goal: null, act: { kind: "cheer", seconds: 2 }, since: now };
        one.bubble = { text: "😆", tone: "plain", until: now + 2 };
      }
      return;
    }
    if (game.it === robot.key) {
      robot.speed = 1.5;
      if (now < game.pausedUntil) {
        // Counting before giving chase.
        robot.pose = "think";
        this.turn(robot, faceTowards(robot, other), dt);
        return;
      }
      const distance = Math.hypot(other.x - robot.x, other.z - robot.z);
      if (distance < 0.9) {
        game.it = other.key;
        game.pausedUntil = now + 1.5;
        robot.bubble = { text: "tag!", tone: "plain", until: now + 1.4 };
        other.bubble = { text: "😆", tone: "plain", until: now + 1.4 };
        robot.path = [];
        other.path = [];
        return;
      }
      if (now > robot.repathAt || !robot.path.length) {
        robot.repathAt = now + 0.45;
        robot.path = this.nav.path(robot, other) ?? [];
      }
    } else {
      robot.speed = 1.32;
      if (!robot.path.length) {
        // Somewhere near where the game began, as far from the chaser as it
        // can find.
        const chaser = this.robots.get(game.it)!;
        let best: Point | null = null;
        let bestDistance = -1;
        for (let tries = 0; tries < 6; tries++) {
          const angle = robot.rng() * Math.PI * 2;
          const r = 2 + robot.rng() * 6;
          const spot = { x: game.center.x + Math.sin(angle) * r, z: game.center.z + Math.cos(angle) * r };
          if (!this.nav.isFree(spot) || Math.hypot(spot.x, spot.z) > this.places.radius - 3) continue;
          const away = Math.hypot(spot.x - chaser.x, spot.z - chaser.z);
          if (away > bestDistance) { best = spot; bestDistance = away; }
        }
        robot.path = best ? this.nav.path(robot, best) ?? [] : [];
      }
    }
    if (robot.path.length) this.walk(robot, dt);
    else robot.pose = "stand";
  }

  private endTag(id: string, now: number, leaving: string) {
    const game = this.tags.get(id);
    if (!game) return;
    this.tags.delete(id);
    for (const key of game.players) {
      if (key === leaving) continue;
      const robot = this.robots.get(key);
      if (robot && robot.plan.act.kind === "tag") {
        robot.path = [];
        robot.speed = SPEED;
        robot.plan = { label: "Looking around", goal: null, act: { kind: "look", seconds: 1.5 }, since: now };
      }
    }
  }

  /** The playground's own frame: the swings swing, the seesaw rocks, and
   *  whoever's turn it is goes up the ladder and down the slide. */
  private playground(dt: number, now: number) {
    const pg = this.places.playground;
    for (let i = 0; i < 2; i++) {
      const rider = this.swingRider[i] ? this.robots.get(this.swingRider[i]!) : undefined;
      const swinging = rider?.plan.act.kind === "swing" && rider.plan.since !== undefined;
      if (!swinging) this.swingAmp[i] = Math.max(0, this.swingAmp[i] - dt * 0.12);
      this.swingPhase[i] += dt * 2.4;
      this.motion.swings[i] = this.swingAmp[i] * Math.sin(this.swingPhase[i]);
    }
    const both = this.seesawSeated[0] && this.seesawSeated[1];
    if (both && this.seesawSince === 0) this.seesawSince = now;
    if (!both) this.seesawSince = 0;
    const target = both ? 0.24 * Math.sin(1.9 * (now - this.seesawSince))
      : this.seesawSeated[0] ? 0.24 : this.seesawSeated[1] ? -0.24 : 0;
    this.motion.seesaw += (target - this.motion.seesaw) * Math.min(1, dt * (both ? 12 : 3));
    if (!pg) return;

    // The slide: one at a time, in the order they came.
    if (!this.slideRide) {
      const next = this.slideQueue[0] ? this.robots.get(this.slideQueue[0]) : undefined;
      if (next && next.plan.act.kind === "slide" && next.plan.since !== undefined) {
        this.slideQueue.shift();
        this.slideRide = { key: next.key, phase: "approach", since: now, from: { x: next.x, z: next.z } };
      } else if (this.slideQueue[0] && !next) this.slideQueue.shift();
    }
    const ride = this.slideRide;
    if (!ride) return;
    const robot = this.robots.get(ride.key);
    if (!robot || robot.plan.act.kind !== "slide") {
      this.slideRide = null;
      return;
    }
    const slide = pg.slide;
    const t = now - ride.since;
    const next = (phase: NonNullable<typeof this.slideRide>["phase"]) => { ride.phase = phase; ride.since = now; };
    switch (ride.phase) {
      case "approach": {
        const k = Math.min(1, t / 0.6);
        robot.x = lerp(ride.from.x, slide.foot.x, k);
        robot.z = lerp(ride.from.z, slide.foot.z, k);
        robot.perched = false;
        robot.pose = "walk";
        robot.stride = (robot.stride + dt * 1.4) % 1;
        robot.heading = slide.face;
        if (k >= 1) next("climb");
        return;
      }
      case "climb": {
        const k = Math.min(1, t / 1.8);
        robot.perched = true;
        robot.x = lerp(slide.foot.x, slide.top.x, k);
        robot.z = lerp(slide.foot.z, slide.top.z, k);
        robot.y = lerp(slide.top.y - 1.35, slide.top.y, k);
        robot.pose = "climb";
        robot.stride = (robot.stride + dt * 1.2) % 1;
        robot.heading = slide.face;
        if (k >= 1) next("perch");
        return;
      }
      case "perch":
        robot.pose = "stand";
        robot.heading = slide.face;
        if (t > 0.5) {
          robot.bubble = { text: pick(["wheee!", "here I go!", "😆"], robot.rng)!, tone: "plain", until: now + 1.6 };
          next("ride");
        }
        return;
      case "ride": {
        const k = Math.min(1, t / 1.1);
        const eased = k * k;
        robot.x = lerp(slide.from.x, slide.to.x, eased);
        robot.z = lerp(slide.from.z, slide.to.z, eased);
        robot.y = lerp(slide.from.y, slide.to.y, eased);
        robot.pose = "ride";
        robot.heading = slide.face;
        if (k >= 1) next("hop");
        return;
      }
      case "hop": {
        const k = Math.min(1, t / 0.45);
        robot.x = lerp(slide.to.x, slide.exit.x, k);
        robot.z = lerp(slide.to.z, slide.exit.z, k);
        robot.perched = false;
        robot.pose = "cheer";
        if (k < 1) return;
        this.slideRide = null;
        const act = robot.plan.act as Extract<Act, { kind: "slide" }>;
        act.runs -= 1;
        if (act.runs > 0) {
          // Round again to the back of the queue.
          const again = this.slidePlan(act.runs);
          robot.plan = { ...again, label: robot.plan.label };
          this.route(robot);
        } else {
          robot.bubble = { text: "😄", tone: "plain", until: now + 1.5 };
          this.replan(robot, now);
        }
        return;
      }
    }
  }

  /** What a robot is doing, for its card. */
  describe(key: string): string | null {
    const robot = this.robots.get(key);
    if (!robot) return null;
    const act = robot.plan.act;
    // The slide has more to it than its label: whose turn, and how far.
    if (act.kind === "slide") {
      const ride = this.slideRide?.key === key ? this.slideRide : null;
      if (ride?.phase === "climb" || ride?.phase === "approach") return "Climbing up the slide";
      if (ride?.phase === "perch") return "At the top of the slide";
      if (ride?.phase === "ride") return "Going down the slide!";
      if (robot.plan.since !== undefined) {
        const ahead = this.slideQueue.indexOf(key) + (this.slideRide ? 1 : 0);
        return ahead > 0 ? `Waiting in line for the slide · ${ahead} ahead` : "Next on the slide";
      }
    }
    if (act.kind === "tag") {
      const game = this.tags.get(act.game);
      const other = game?.players.find((player) => player !== key);
      const name = other ? this.robots.get(other)?.resident.name : undefined;
      if (game && name) return game.it === key ? `Playing tag with ${name} · it's ${robot.resident.name}'s turn to chase` : `Playing tag with ${name} · running away`;
    }
    if (act.kind === "seesaw" && robot.plan.since !== undefined && !(this.seesawSeated[0] && this.seesawSeated[1])) {
      return "Waiting for a friend on the seesaw";
    }
    if (robot.path.length && act.kind === "sit") return `Going to sit on ${act.seat.name}`;
    return robot.plan.label;
  }

  /** What it last said, while the words are still in the air. */
  said(key: string): string | null {
    const bubble = this.robots.get(key)?.bubble;
    return bubble && bubble.tone === "plain" ? bubble.text : null;
  }
}

function nearest<T extends { x: number; z: number }>(items: readonly T[], from: Point, rng: () => number): T | null {
  if (!items.length) return null;
  // Not always the very nearest: a little chance spreads robots over the
  // island instead of queueing them at one bench.
  const sorted = [...items].sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
  const span = Math.min(sorted.length, 3);
  return sorted[Math.floor(rng() * span)] ?? sorted[0];
}

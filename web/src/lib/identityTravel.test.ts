// The face and the name that go on from a confirmed card. The geometry is
// pure. The part that touches the page is run here against a page made of
// plain objects (no jsdom): what matters is what it puts on the page and
// what it hides, and under reduced motion that is nothing at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composerLanding, cutShort, flight, forgetIdentity, fresh, FRESH_MS, identityRemembered, inside, landIdentity, leaveIdentity,
  lineLanding, onScreen, refreshIdentity, rememberIdentity, routeAfter, routeStands, TRAVEL_EASE, TRAVEL_MS, travelPlan,
  type Box, type Landing, type PageNow, type RouteTravel,
} from "./identityTravel";

const VIEW = { w: 1440, h: 900 };
const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });

describe("where a face and a name travel", () => {
  it("lands a face on its smaller self, scaled about its own corner and centred on the line", () => {
    // 44px on the card, 22px on the composer.
    expect(flight(box(400, 500, 44, 44), box(380, 820, 22, 22))).toEqual({ dx: -20, dy: 320, scale: 0.5 });
    // Words go by their type size, and sit centred on the line they land in.
    const words = flight(box(456, 501, 90, 22), box(408, 823, 60, 16), 12 / 16);
    expect(words.scale).toBe(0.75);
    expect(words.dx).toBe(-48);
    expect(words.dy).toBe(823 + 8 - (22 * 0.75) / 2 - 501);
  });

  it("plans a travel when both ends are on screen", () => {
    const plan = travelPlan({
      calm: false, view: VIEW,
      face: { from: box(400, 500, 44, 44), to: box(380, 820, 22, 22) },
      name: { from: box(456, 501, 90, 22), to: box(408, 823, 60, 16), fromFont: 16, toFont: 12 },
    });
    expect(plan?.face).toEqual({ dx: -20, dy: 320, scale: 0.5 });
    expect(plan?.name?.scale).toBe(0.75);
  });

  it("plans nothing under reduced motion, whatever is on screen", () => {
    expect(travelPlan({
      calm: true, view: VIEW,
      face: { from: box(400, 500, 44, 44), to: box(380, 820, 22, 22) },
      name: { from: box(456, 501, 90, 22), to: box(408, 823, 60, 16), fromFont: 16, toFont: 12 },
    })).toBeNull();
  });

  it("plans nothing with nowhere on screen to land, or from a card that was off it", () => {
    const from = box(400, 500, 44, 44);
    // The chat never opened: no landing.
    expect(travelPlan({ calm: false, view: VIEW, face: { from, to: null } })).toBeNull();
    // Below the window, beside it, half out of it, or not laid out.
    for (const to of [box(380, 950, 22, 22), box(1500, 820, 22, 22), box(380, 890, 22, 22), box(-10, 820, 22, 22), box(380, 820, 0, 0)]) {
      expect(travelPlan({ calm: false, view: VIEW, face: { from, to } }), JSON.stringify(to)).toBeNull();
    }
    expect(travelPlan({ calm: false, view: VIEW, face: { from: box(400, -80, 44, 44), to: box(380, 820, 22, 22) } })).toBeNull();
  });

  it("sends the face alone when the name has nowhere to land", () => {
    const plan = travelPlan({
      calm: false, view: VIEW,
      face: { from: box(400, 500, 44, 44), to: box(380, 820, 22, 22) },
      name: { from: box(456, 501, 90, 22), to: null, fromFont: 16, toFont: 12 },
    });
    expect(plan?.face.scale).toBe(0.5);
    expect(plan?.name).toBeNull();
  });

  it("knows what is on screen, what is wholly inside, and what was seen too long ago", () => {
    expect(onScreen(box(0, 0, 10, 10), VIEW)).toBe(true);
    expect(onScreen(box(-20, 0, 10, 10), VIEW)).toBe(false);
    expect(onScreen(box(0, 0, 0, 10), VIEW)).toBe(false);
    expect(inside(box(10, 10, 20, 20), box(0, 0, 100, 100))).toBe(true);
    expect(inside(box(90, 10, 20, 20), box(0, 0, 100, 100))).toBe(false);
    expect(fresh(1000, 1000 + FRESH_MS)).toBe(true);
    expect(fresh(1000, 1001 + FRESH_MS)).toBe(false);
  });

  it("moves for about 200ms, easing out and never past its end", () => {
    expect(TRAVEL_MS).toBeGreaterThanOrEqual(130);
    expect(TRAVEL_MS).toBeLessThanOrEqual(220);
    // A cubic-bezier overshoots only with a control point outside 0..1.
    const points = /cubic-bezier\(([^)]+)\)/.exec(TRAVEL_EASE)![1].split(",").map(Number);
    expect(points).toHaveLength(4);
    for (const point of points) {
      expect(point).toBeGreaterThanOrEqual(0);
      expect(point).toBeLessThanOrEqual(1);
    }
  });
});

/* ---- A page of plain objects ------------------------------------------ */

type Fake = {
  isConnected: boolean;
  rect: Box;
  style: Record<string, string>;
  textContent: string;
  parentElement: Fake | null;
  attributes: Record<string, string>;
  children: Record<string, Fake | null>;
  animations: { keyframes: Keyframe[]; options: KeyframeAnimationOptions; run: { onfinish: (() => void) | null; oncancel: (() => void) | null } }[];
  removed: boolean;
  /** How wide its words are, and how wide it is drawn: set on a name that
   *  is cut short. Not set, it shows all of its words. */
  scrollWidth?: number;
  clientWidth?: number;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  querySelector(selector: string): Fake | null;
  getAttribute(name: string): string | null;
  cloneNode(): Fake;
  setAttribute(name: string, value: string): void;
  remove(): void;
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): unknown;
};

function fake(rect: Box, text = "", children: Record<string, Fake | null> = {}): Fake {
  const element: Fake = {
    isConnected: true, rect, style: {}, textContent: text, parentElement: null, attributes: {}, children, animations: [], removed: false,
    getBoundingClientRect: () => ({ left: element.rect.x, top: element.rect.y, width: element.rect.w, height: element.rect.h }),
    getAttribute: (name) => element.attributes[name] ?? null,
    querySelector: (selector) => element.children[selector] ?? null,
    cloneNode: () => fake({ ...element.rect }, element.textContent),
    setAttribute: (name, value) => { element.attributes[name] = value; },
    remove: () => { element.removed = true; },
    animate: (keyframes, options) => {
      const run = { onfinish: null, oncancel: null };
      element.animations.push({ keyframes, options, run });
      return run;
    },
  };
  return element;
}

/** A confirmed card: a 44px face and a name. */
const card = () => fake(box(300, 400, 520, 200), "", {
  ".handover-face .agent-avatar": fake(box(316, 416, 44, 44)),
  '[data-travel="name"]': fake(box(372, 417, 80, 22), "Vesper"),
});

/** The composer's naming of an agent, in the composer of chat `chat` (none:
 *  a conversation not saved yet). */
const chip = (name: string, chat?: string) => {
  const label = fake(box(88, 842, 44, 16), name);
  const face = fake(box(60, 839, 22, 22));
  const element = fake(box(60, 836, 80, 28), "", { ".composer-identity-name": label, ".agent-avatar": face });
  if (chat !== undefined) element.attributes["data-chat"] = chat;
  return { chip: element, label, face };
};

describe("the travel, on the page", () => {
  let reduced = false;
  let appended: Fake[] = [];
  let frames: (() => void)[] = [];
  let chips: Fake[] = [];
  let clock = 0;

  /** Run the frames asked for so far, and those they ask for, `n` deep. */
  const runFrames = (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      const due = frames;
      frames = [];
      for (const frame of due) frame();
    }
  };

  beforeEach(() => {
    reduced = false;
    appended = [];
    frames = [];
    chips = [];
    clock = 0;
    vi.useFakeTimers();
    vi.stubGlobal("performance", { now: () => clock });
    vi.stubGlobal("getComputedStyle", () => ({
      overflowX: "visible", overflowY: "visible", fontSize: "16px", fontFamily: "Inter", fontWeight: "600", fontStyle: "normal",
      lineHeight: "22px", letterSpacing: "0px", color: "rgb(250, 250, 250)",
    }));
    vi.stubGlobal("document", {
      body: { appendChild: (node: Fake) => { appended.push(node); } },
      createElement: () => fake(box(0, 0, 0, 0)),
      querySelectorAll: (selector: string) => (selector === ".composer-identity" ? chips : []),
    });
    vi.stubGlobal("window", {
      innerWidth: VIEW.w, innerHeight: VIEW.h,
      matchMedia: (query: string) => ({ matches: reduced && query.includes("prefers-reduced-motion") }),
      requestAnimationFrame: (frame: () => void) => { frames.push(frame); return frames.length; },
      setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    });
  });

  afterEach(() => {
    for (const id of ["r1", "r2", "r3", "h1"]) forgetIdentity(id);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const as = (element: Fake) => element as unknown as Element;
  const landing = (target: ReturnType<typeof chip>): Landing => ({ face: as(target.face), name: as(target.label) });

  it("moves nothing under reduced motion: no copy on the page, nothing hidden, nothing animated, nothing waited for", () => {
    reduced = true;
    const from = card();
    rememberIdentity("r1", as(from));
    // Reduced motion remembers nothing to begin with.
    expect(identityRemembered("r1")).toBe(false);
    const to = chip("Vesper");
    const find = vi.fn(() => landing(to));
    landIdentity("r1", find);
    runFrames(5);
    vi.advanceTimersByTime(5000);
    expect(find).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
    expect(frames).toEqual([]);
    expect(to.face.style).toEqual({});
    expect(to.label.style).toEqual({});
    expect(to.face.animations).toEqual([]);
  });

  it("moves nothing when motion is reduced between the answer and the landing", () => {
    const from = card();
    rememberIdentity("r1", as(from));
    expect(identityRemembered("r1")).toBe(true);
    reduced = true;
    const to = chip("Vesper");
    landIdentity("r1", () => landing(to));
    runFrames(5);
    expect(appended).toEqual([]);
    expect(to.face.style).toEqual({});
    expect(to.label.style).toEqual({});
    expect(identityRemembered("r1")).toBe(false);
  });

  it("with motion allowed, sends a copy of the face and of the name, and hides the landing until they arrive", () => {
    const from = card();
    rememberIdentity("r1", as(from));
    const to = chip("Vesper");
    landIdentity("r1", () => landing(to));
    // Both copies are on the page's own layer, where the card's were.
    expect(appended).toHaveLength(2);
    const [face, name] = appended;
    expect(face.style).toMatchObject({ position: "fixed", left: "316px", top: "416px", pointerEvents: "none", transformOrigin: "0 0" });
    expect(name.style).toMatchObject({ position: "fixed", left: "372px", top: "417px", whiteSpace: "nowrap", fontSize: "16px" });
    expect(name.textContent).toBe("Vesper");
    expect(face.attributes["aria-hidden"]).toBe("true");
    // One movement each, the same 200ms and the same ease, ending where the
    // composer names the agent.
    expect(face.animations).toHaveLength(1);
    expect(face.animations[0].options).toMatchObject({ duration: TRAVEL_MS, easing: TRAVEL_EASE, fill: "forwards" });
    expect(face.animations[0].keyframes[1].transform).toBe("translate(-256px, 423px) scale(0.5)");
    expect(name.animations[0].options).toMatchObject({ duration: TRAVEL_MS, easing: TRAVEL_EASE });
    // Unseen until it arrives, then shown, with the copy gone.
    expect(to.face.style.visibility).toBe("hidden");
    expect(to.label.style.visibility).toBe("hidden");
    face.animations[0].run.onfinish!();
    name.animations[0].run.onfinish!();
    expect(face.removed).toBe(true);
    expect(name.removed).toBe(true);
    // (Back to what it was before: nothing set.)
    expect(to.face.style.visibility).toBeUndefined();
    expect(to.label.style.visibility).toBeUndefined();
    expect(identityRemembered("r1")).toBe(false);
  });

  it("leaves no copy behind when the movement never ends", () => {
    const from = card();
    rememberIdentity("r1", as(from));
    const to = chip("Vesper");
    landIdentity("r1", () => landing(to));
    expect(appended).toHaveLength(2);
    // A page in the background ends no animation: the clock clears up.
    vi.advanceTimersByTime(TRAVEL_MS * 3);
    for (const copy of appended) expect(copy.removed).toBe(true);
    expect(to.face.style.visibility).toBeUndefined();
    expect(to.label.style.visibility).toBeUndefined();
  });

  it("puts nothing on the page while it waits, and nothing at all for a chat that never opens", () => {
    const from = card();
    rememberIdentity("r1", as(from));
    const find = vi.fn((): Landing | null => null);
    landIdentity("r1", find);
    // The card is still drawn: asked each frame, with nothing drawn.
    runFrames(3);
    expect(find).toHaveBeenCalledTimes(4);
    expect(appended).toEqual([]);
    // The card goes and no landing comes: two more frames, then it is over.
    from.isConnected = false;
    runFrames(10);
    expect(appended).toEqual([]);
    expect(frames).toEqual([]);
    expect(identityRemembered("r1")).toBe(false);
    expect(find.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("starts from where the card was last seen, in the frame its landing is drawn", () => {
    const from = card();
    rememberIdentity("r1", as(from));
    let to: ReturnType<typeof chip> | null = null;
    landIdentity("r1", () => (to ? landing(to) : null));
    // The page waits on the host, and scrolls meanwhile: the card moves up.
    // Nothing is drawn for as long as that takes.
    clock = 3000;
    runFrames(40);
    expect(appended).toEqual([]);
    from.rect = box(300, 300, 520, 200);
    from.children[".handover-face .agent-avatar"]!.rect = box(316, 316, 44, 44);
    from.children['[data-travel="name"]']!.rect = box(372, 317, 80, 22);
    // The page goes to the new chat: the card says where it is as it leaves
    // (its own effect's clean-up), and the composer names the agent.
    clock = 3100;
    leaveIdentity("r1", as(from));
    from.isConnected = false;
    to = chip("Vesper");
    clock = 3116;
    runFrames(1);
    expect(appended).toHaveLength(2);
    expect(appended[0].style).toMatchObject({ left: "316px", top: "316px" });
  });

  it("starts from where a card still drawn beside its landing is now", () => {
    const from = card();
    rememberIdentity("h1", as(from));
    from.children[".handover-face .agent-avatar"]!.rect = box(316, 216, 44, 44);
    clock = 5000;
    const to = chip("Mango");
    landIdentity("h1", () => landing(to));
    expect(appended).toHaveLength(2);
    expect(appended[0].style).toMatchObject({ left: "316px", top: "216px" });
  });

  it("gives up on a card that stays drawn with nowhere to go", () => {
    const from = card();
    rememberIdentity("r1", as(from));
    landIdentity("r1", () => null);
    clock = 19_000;
    runFrames(3);
    expect(identityRemembered("r1")).toBe(true);
    clock = 20_001;
    runFrames(3);
    expect(identityRemembered("r1")).toBe(false);
    expect(frames).toEqual([]);
    expect(appended).toEqual([]);
  });

  it("does not travel from a card that left the page long before its landing came", () => {
    // The person went to another chat while this one's was starting, and
    // came back to the line: where the card was is no longer on their screen.
    const from = card();
    rememberIdentity("h1", as(from));
    from.isConnected = false;
    clock = FRESH_MS + 1;
    const to = chip("Mango");
    landIdentity("h1", () => landing(to));
    expect(appended).toEqual([]);
    expect(to.face.style).toEqual({});
    expect(identityRemembered("h1")).toBe(false);
  });

  it("drops a confirmation nobody asked about once its card has left", () => {
    const from = card();
    rememberIdentity("h1", as(from));
    leaveIdentity("h1", as(from));
    expect(identityRemembered("h1")).toBe(true);
    vi.advanceTimersByTime(FRESH_MS * 2);
    expect(identityRemembered("h1")).toBe(false);
    // And a card that was never confirmed is never remembered by being drawn.
    refreshIdentity("h1", as(card()));
    leaveIdentity("h1", as(card()));
    expect(identityRemembered("h1")).toBe(false);
  });

  it("does not land on a place the page clips, or that is not laid out", () => {
    const from = card();
    rememberIdentity("h1", as(from));
    // A line scrolled under the top of its transcript: inside the window,
    // outside what the scroller shows.
    const scroller = fake(box(0, 48, 1440, 700));
    const face = fake(box(300, 20, 16, 16));
    face.parentElement = scroller;
    vi.stubGlobal("getComputedStyle", (element: Fake) => ({
      overflowX: "visible", overflowY: element === scroller ? "auto" : "visible", fontSize: "12.5px",
      fontFamily: "Inter", fontWeight: "400", fontStyle: "normal", lineHeight: "18px", letterSpacing: "0px", color: "",
    }));
    landIdentity("h1", () => ({ face: as(face), name: null }));
    expect(appended).toEqual([]);
    expect(face.style).toEqual({});
    expect(identityRemembered("h1")).toBe(false);
  });

  it("lands only on the composer of the chat that was opened, whoever it names, and on the line a handover leaves", () => {
    const desk = chip("Front desk", "desk");
    chips = [desk.chip];
    // Still the chat the card was asked in: not a landing.
    expect(composerLanding("new")).toBeNull();
    // The same agent's older chat, and another project's agent of the same
    // name: the composer names Vesper, and is not the chat that was opened.
    const older = chip("Vesper", "older");
    chips = [older.chip];
    expect(composerLanding("new")).toBeNull();
    // A composer that says no chat (a new conversation not yet saved).
    chips = [chip("Vesper").chip];
    expect(composerLanding("new")).toBeNull();
    // No chat was named: nothing is a landing, a chat-less composer least of all.
    expect(composerLanding(null)).toBeNull();
    expect(composerLanding("")).toBeNull();
    // The chat it opened.
    const opened = chip("Vesper", "new");
    chips = [desk.chip, older.chip, opened.chip];
    expect(composerLanding("new")).toEqual({ face: opened.face, name: opened.label });
    // By the chat alone: a chat id is text, and is never put into a selector.
    const odd = chip("Vesper", 'a"] , .composer-identity[data-chat="older');
    chips = [older.chip, odd.chip];
    expect(composerLanding('a"] , .composer-identity[data-chat="older')).toEqual({ face: odd.face, name: odd.label });
    expect(lineLanding(null)).toBeNull();
    const face = fake(box(0, 0, 16, 16));
    const name = fake(box(20, 0, 40, 16), "Mango");
    expect(lineLanding(as(fake(box(0, 0, 300, 26), "", { ".handover-line-face": face, '[data-travel="name"]': name }))))
      .toEqual({ face, name });
  });

  /* ---- A travel belongs to the confirmation that started it ------------ */

  it("does not start in the chat it was confirmed in, with the same name already on its composer", () => {
    // A route to the agent this very chat is with: the composer here names
    // Vesper, and the card is still drawn. Not a landing: it is not the chat
    // the route opened.
    const here = chip("Vesper", "source");
    chips = [here.chip];
    const from = card();
    rememberIdentity("r1", as(from));
    landIdentity("r1", () => composerLanding("new"));
    runFrames(6);
    expect(appended).toEqual([]);
    expect(here.face.style).toEqual({});
    expect(here.label.style).toEqual({});
    // Still waiting for its own chat, which then opens: that one is landed on.
    expect(identityRemembered("r1")).toBe(true);
    leaveIdentity("r1", as(from));
    from.isConnected = false;
    const opened = chip("Vesper", "new");
    chips = [opened.chip];
    runFrames(1);
    expect(appended).toHaveLength(2);
    expect(opened.face.style.visibility).toBe("hidden");
    expect(here.face.style).toEqual({});
  });

  it("does not fly to the same agent's other chat when the person goes there instead", () => {
    const from = card();
    rememberIdentity("r1", as(from));
    landIdentity("r1", () => composerLanding("new"));
    runFrames(2);
    // The host has not answered yet, and the person picks Vesper's older
    // chat from the list: the card leaves, and a composer naming Vesper is
    // drawn in the same frame.
    leaveIdentity("r1", as(from));
    from.isConnected = false;
    const older = chip("Vesper", "older");
    chips = [older.chip];
    runFrames(10);
    vi.advanceTimersByTime(5000);
    expect(appended).toEqual([]);
    expect(older.face.style).toEqual({});
    expect(older.label.style).toEqual({});
    expect(older.face.animations).toEqual([]);
    expect(identityRemembered("r1")).toBe(false);
    expect(frames).toEqual([]);
    // The chat it opened turning up afterwards is not travelled to either:
    // the card was not seen where its boxes say for a long time.
    chips = [chip("Vesper", "new").chip];
    runFrames(3);
    expect(appended).toEqual([]);
  });

  /* ---- It stands in one chat at a time, and only while that is shown ---- */

  /** The three stages of a route's travel: the host has not said which chat
   *  it opened; it has, and the page is not there yet; the page got there. */
  const STAGES = {
    asked: { id: "r1", from: "desk", to: null, arrived: false },
    going: { id: "r1", from: "desk", to: "new", arrived: false },
    arrived: { id: "r1", from: "desk", to: "new", arrived: true },
  } satisfies Record<string, RouteTravel>;
  const showing = (chat: string | null, shown = true, unavailable = false): PageNow => ({ chat, shown, unavailable });

  // Stage × the chat that is open × whether the chat is what the page shows.
  // `then`: the stage it is in afterwards, or `null` for called off.
  it.each([
    // Waiting to go: only the chat it was confirmed in, and only on screen.
    { stage: "asked", chat: "desk", shown: true, then: "asked" },
    { stage: "asked", chat: "desk", shown: false, then: null },
    // The chat it opens is not known yet, so no chat is it.
    { stage: "asked", chat: "new", shown: true, then: null },
    { stage: "asked", chat: "new", shown: false, then: null },
    { stage: "asked", chat: "older", shown: true, then: null },
    { stage: "asked", chat: "older", shown: false, then: null },
    { stage: "asked", chat: null, shown: true, then: null },
    { stage: "asked", chat: null, shown: false, then: null },
    // The host said which chat: still waiting in the one it was confirmed
    // in, and arrived the first time the page shows the one it opened.
    { stage: "going", chat: "desk", shown: true, then: "going" },
    { stage: "going", chat: "desk", shown: false, then: null },
    { stage: "going", chat: "new", shown: true, then: "arrived" },
    // Open, with something drawn in its place: not arrived, and called off.
    { stage: "going", chat: "new", shown: false, then: null },
    { stage: "going", chat: "older", shown: true, then: null },
    { stage: "going", chat: "older", shown: false, then: null },
    { stage: "going", chat: null, shown: true, then: null },
    { stage: "going", chat: null, shown: false, then: null },
    // Arrived: only the chat it opened. Back in the chat it was confirmed
    // in is called off like any other.
    { stage: "arrived", chat: "new", shown: true, then: "arrived" },
    { stage: "arrived", chat: "new", shown: false, then: null },
    { stage: "arrived", chat: "desk", shown: true, then: null },
    { stage: "arrived", chat: "desk", shown: false, then: null },
    { stage: "arrived", chat: "older", shown: true, then: null },
    { stage: "arrived", chat: "older", shown: false, then: null },
    { stage: "arrived", chat: null, shown: true, then: null },
    { stage: "arrived", chat: null, shown: false, then: null },
  ] as const)("$stage, with chat $chat open and shown $shown: $then", ({ stage, chat, shown, then }) => {
    const route = STAGES[stage];
    expect(routeAfter(route, showing(chat, shown))).toEqual(then ? STAGES[then] : null);
    expect(routeStands(route, showing(chat, shown))).toBe(then !== null);
    // A chat called unavailable calls it off at every stage, whatever is open.
    expect(routeAfter(route, showing(chat, shown, true))).toBeNull();
    expect(routeStands(route, showing(chat, shown, true))).toBe(false);
  });

  it("covers every stage, every chat and both answers in that table, and never changes what it was given", () => {
    for (const route of Object.values(STAGES)) {
      const before = JSON.stringify(route);
      for (const chat of ["desk", "new", "older", null]) for (const shown of [true, false]) routeAfter(route, showing(chat, shown));
      expect(JSON.stringify(route)).toBe(before);
    }
    // A travel confirmed with no chat on screen stands nowhere.
    expect(routeAfter({ id: "r1", from: null, to: null, arrived: false }, showing(null))).toBeNull();
    // Nothing brings one back: called off is `null`, and `null` is not a stage.
    expect(routeAfter(STAGES.arrived, showing("desk"))).toBeNull();
  });

  /** The page, as `App` keeps a route's travel: one travel, asked of
   *  `routeAfter` each time what the page shows changes, and called off
   *  (`forgetIdentity`) when that says so. */
  const pageWith = (route: RouteTravel) => {
    let travel: RouteTravel | null = route;
    return {
      shows(page: PageNow) {
        if (!travel) return;
        const next = routeAfter(travel, page);
        if (!next) forgetIdentity(travel.id);
        travel = next;
      },
      get travel() { return travel; },
    };
  };

  it("is called off when the page goes back to the chat it was confirmed in after arriving", () => {
    // The front desk's composer and the new chat's are one element the page
    // reuses: after the return it names the front desk again.
    const composer = chip("Vesper", "new");
    chips = [composer.chip];
    const from = card();
    rememberIdentity("r1", as(from));
    const page = pageWith({ id: "r1", from: "desk", to: "new", arrived: false });
    landIdentity("r1", () => composerLanding("new"));
    page.shows(showing("new"));
    expect(page.travel?.arrived).toBe(true);
    expect(appended).toHaveLength(2);
    expect(composer.face.style.visibility).toBe("hidden");
    expect(composer.label.style.visibility).toBe("hidden");
    // 30ms on, the person is back in the front desk's chat.
    clock += 30;
    vi.advanceTimersByTime(30);
    composer.chip.attributes["data-chat"] = "desk";
    page.shows(showing("desk"));
    expect(page.travel).toBeNull();
    // At once: no copy left on the page, and the composer's face and name
    // are drawn again.
    for (const copy of appended) expect(copy.removed).toBe(true);
    expect(composer.face.style.visibility).toBeUndefined();
    expect(composer.label.style.visibility).toBeUndefined();
    // Nothing that ends later hides them again, and going to the new chat
    // once more starts nothing.
    for (const copy of appended) copy.animations[0].run.oncancel!();
    vi.advanceTimersByTime(TRAVEL_MS * 3);
    composer.chip.attributes["data-chat"] = "new";
    page.shows(showing("new"));
    runFrames(5);
    expect(appended).toHaveLength(2);
    expect(composer.face.style.visibility).toBeUndefined();
    expect(identityRemembered("r1")).toBe(false);
  });

  it("is called off in flight when Settings is opened over the chat it arrived in", () => {
    const composer = chip("Vesper", "new");
    chips = [composer.chip];
    rememberIdentity("r1", as(card()));
    const page = pageWith({ id: "r1", from: "desk", to: "new", arrived: false });
    landIdentity("r1", () => composerLanding("new"));
    page.shows(showing("new"));
    expect(appended).toHaveLength(2);
    // The same chat is open: only what the page shows has changed.
    clock += 50;
    vi.advanceTimersByTime(50);
    page.shows(showing("new", false));
    expect(page.travel).toBeNull();
    for (const copy of appended) expect(copy.removed).toBe(true);
    expect(composer.face.style.visibility).toBeUndefined();
    expect(composer.label.style.visibility).toBeUndefined();
    // Settings is closed again: the chat is back, and nothing flies.
    page.shows(showing("new"));
    runFrames(5);
    vi.advanceTimersByTime(TRAVEL_MS * 3);
    expect(appended).toHaveLength(2);
    expect(composer.face.style.visibility).toBeUndefined();
  });

  it("does not fly when a page was opened while it waited, and the chat it opened then comes on screen", () => {
    const from = card();
    rememberIdentity("r1", as(from));
    const page = pageWith({ id: "r1", from: "desk", to: null, arrived: false });
    landIdentity("r1", () => composerLanding("new"));
    runFrames(2);
    // Settings, over the chat the card is in, before the host has answered.
    page.shows(showing("desk", false));
    expect(page.travel).toBeNull();
    expect(identityRemembered("r1")).toBe(false);
    // The host answers and the page goes to the chat it opened.
    leaveIdentity("r1", as(from));
    from.isConnected = false;
    const opened = chip("Vesper", "new");
    chips = [opened.chip];
    page.shows(showing("new"));
    runFrames(5);
    vi.advanceTimersByTime(5000);
    expect(appended).toEqual([]);
    expect(opened.face.style).toEqual({});
    expect(opened.label.style).toEqual({});
    expect(frames).toEqual([]);
  });

  /* ---- A name the landing cuts short does not travel -------------------- */

  it("knows a line that shows less than its words", () => {
    // The review's reading at 390px: a 36-character name, 228px of words in 167.
    expect(cutShort({ scrollWidth: 228, clientWidth: 167 })).toBe(true);
    expect(cutShort({ scrollWidth: 167, clientWidth: 167 })).toBe(false);
    expect(cutShort({ scrollWidth: 44, clientWidth: 167 })).toBe(false);
    // An inline name has no box of its own to scroll in: both are zero.
    expect(cutShort({ scrollWidth: 0, clientWidth: 0 })).toBe(false);
  });

  it("sends the face alone to a composer that ends the name in an ellipsis", () => {
    rememberIdentity("r1", as(card()));
    const to = chip("Independent review long name example", "new");
    // Whole as a box, and on screen: only its words are cut.
    to.label.rect = box(88, 842, 167, 16);
    to.label.scrollWidth = 228;
    to.label.clientWidth = 167;
    landIdentity("r1", () => landing(to));
    expect(appended).toHaveLength(1);
    expect(appended[0].style).toMatchObject({ left: "316px", top: "416px" });
    expect(appended[0].animations).toHaveLength(1);
    expect(to.face.style.visibility).toBe("hidden");
    // The name is where it now is: never hidden, never copied.
    expect(to.label.style).toEqual({});
    appended[0].animations[0].run.onfinish!();
    expect(to.face.style.visibility).toBeUndefined();
    expect(to.label.style).toEqual({});
  });

  it("sends the name too when the composer shows all of it", () => {
    rememberIdentity("r1", as(card()));
    const to = chip("Vesper", "new");
    to.label.scrollWidth = 44;
    to.label.clientWidth = 44;
    landIdentity("r1", () => landing(to));
    expect(appended).toHaveLength(2);
    expect(appended[1].textContent).toBe("Vesper");
    expect(to.label.style.visibility).toBe("hidden");
  });

  it("is called off in flight: the copies go and the landing is shown again", () => {
    const from = card();
    rememberIdentity("r1", as(from));
    const to = chip("Vesper", "new");
    landIdentity("r1", () => landing(to));
    expect(appended).toHaveLength(2);
    expect(to.face.style.visibility).toBe("hidden");
    // The person leaves the new chat while the face is still on its way.
    forgetIdentity("r1");
    for (const copy of appended) expect(copy.removed).toBe(true);
    expect(to.face.style.visibility).toBeUndefined();
    expect(to.label.style.visibility).toBeUndefined();
    // Nothing that ends later undoes that.
    appended[0].animations[0].run.oncancel!();
    vi.advanceTimersByTime(TRAVEL_MS * 3);
    expect(to.face.style.visibility).toBeUndefined();
  });

  /* ---- The landing is shown again, as it was, whatever lands on it ----- */

  /** Two travels to the same composer, 50ms apart: the review's probe. */
  const twice = (to: ReturnType<typeof chip>) => {
    rememberIdentity("r1", as(card()));
    landIdentity("r1", () => landing(to));
    const first = appended.slice();
    clock += 50;
    vi.advanceTimersByTime(50);
    rememberIdentity("r2", as(card()));
    landIdentity("r2", () => landing(to));
    return { first, second: appended.slice(first.length) };
  };
  const ends = (copy: Fake, how: "onfinish" | "oncancel") => copy.animations[0].run[how]!();

  it("takes over a landing another travel is still flying to, and ends the first at once", () => {
    const to = chip("Vesper", "new");
    const { first, second } = twice(to);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    // The first is over: its copies are gone. The second holds the landing.
    for (const copy of first) expect(copy.removed).toBe(true);
    for (const copy of second) expect(copy.removed).toBe(false);
    expect(to.face.style.visibility).toBe("hidden");
    expect(to.label.style.visibility).toBe("hidden");
  });

  it.each([
    ["the first ends, then the second", ["first", "second"]],
    ["the second ends, then the first", ["second", "first"]],
    ["only the second ever ends", ["second"]],
    ["only the first ever ends", ["first"]],
    ["neither ends, and the clock clears up", []],
  ] as const)("shows a landing two travels flew to again, as it was: %s", (_, order) => {
    const to = chip("Vesper", "new");
    const flown = twice(to);
    for (const which of order) for (const copy of flown[which]) ends(copy, "onfinish");
    vi.advanceTimersByTime(850);
    // The review's reading, 850ms on: no copy left, and nothing hidden.
    for (const copy of appended) expect(copy.removed).toBe(true);
    expect(to.face.style.visibility).toBeUndefined();
    expect(to.label.style.visibility).toBeUndefined();
    expect(identityRemembered("r1")).toBe(false);
    expect(identityRemembered("r2")).toBe(false);
  });

  it("shows it again when either is cancelled or called off, and when it left the page meanwhile", () => {
    for (const end of ["cancel-first", "cancel-second", "forget-second", "forget-first", "unmounted"] as const) {
      appended = [];
      const to = chip("Vesper", "new");
      const { first, second } = twice(to);
      if (end === "cancel-first") for (const copy of first) ends(copy, "oncancel");
      if (end === "cancel-second") for (const copy of second) ends(copy, "oncancel");
      if (end === "forget-second") forgetIdentity("r2");
      if (end === "forget-first") forgetIdentity("r1");
      if (end === "unmounted") to.face.isConnected = to.label.isConnected = false;
      vi.advanceTimersByTime(850);
      for (const copy of appended) expect(copy.removed, end).toBe(true);
      expect(to.face.style.visibility, end).toBeUndefined();
      expect(to.label.style.visibility, end).toBeUndefined();
    }
  });

  it("puts back the visibility the landing had before any of them, not an empty one", () => {
    const to = chip("Vesper", "new");
    to.face.style.visibility = "inherit";
    to.label.style.visibility = "visible";
    const { second } = twice(to);
    // A third, later still, over the second.
    clock += 50;
    vi.advanceTimersByTime(50);
    rememberIdentity("r3", as(card()));
    landIdentity("r3", () => landing(to));
    for (const copy of second) expect(copy.removed).toBe(true);
    expect(to.face.style.visibility).toBe("hidden");
    vi.advanceTimersByTime(850);
    expect(to.face.style.visibility).toBe("inherit");
    expect(to.label.style.visibility).toBe("visible");
    for (const copy of appended) expect(copy.removed).toBe(true);
  });

  it("keeps two travels to different landings apart", () => {
    const a = chip("Vesper", "new");
    const b = chip("Mango", "other");
    rememberIdentity("r1", as(card()));
    landIdentity("r1", () => landing(a));
    rememberIdentity("r2", as(card()));
    landIdentity("r2", () => landing(b));
    expect(appended).toHaveLength(4);
    for (const copy of appended) expect(copy.removed).toBe(false);
    // Calling one off leaves the other flying.
    forgetIdentity("r1");
    expect(appended.slice(0, 2).every((copy) => copy.removed)).toBe(true);
    expect(appended.slice(2).some((copy) => copy.removed)).toBe(false);
    expect(a.face.style.visibility).toBeUndefined();
    expect(b.face.style.visibility).toBe("hidden");
    vi.advanceTimersByTime(850);
    expect(b.face.style.visibility).toBeUndefined();
  });
});

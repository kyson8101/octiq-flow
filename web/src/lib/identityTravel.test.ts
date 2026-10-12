// The face and the name that go on from a confirmed card. The geometry is
// pure. The part that touches the page is run here against a page made of
// plain objects (no jsdom): what matters is what it puts on the page and
// what it hides, and under reduced motion that is nothing at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composerLanding, flight, forgetIdentity, fresh, FRESH_MS, identityRemembered, inside, landIdentity, leaveIdentity,
  lineLanding, onScreen, refreshIdentity, rememberIdentity, TRAVEL_EASE, TRAVEL_MS, travelPlan,
  type Box, type Landing,
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
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  querySelector(selector: string): Fake | null;
  cloneNode(): Fake;
  setAttribute(name: string, value: string): void;
  remove(): void;
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): unknown;
};

function fake(rect: Box, text = "", children: Record<string, Fake | null> = {}): Fake {
  const element: Fake = {
    isConnected: true, rect, style: {}, textContent: text, parentElement: null, attributes: {}, children, animations: [], removed: false,
    getBoundingClientRect: () => ({ left: element.rect.x, top: element.rect.y, width: element.rect.w, height: element.rect.h }),
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

/** The composer's naming of an agent. */
const chip = (name: string) => {
  const label = fake(box(88, 842, 44, 16), name);
  const face = fake(box(60, 839, 22, 22));
  return { chip: fake(box(60, 836, 80, 28), "", { ".composer-identity-name": label, ".agent-avatar": face }), label, face };
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
    for (const id of ["r1", "h1"]) forgetIdentity(id);
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

  it("lands only where the composer names that agent, and on the line a handover leaves", () => {
    const desk = chip("Front desk");
    chips = [desk.chip];
    // Still the chat the card was asked in: not a landing.
    expect(composerLanding("Vesper")).toBeNull();
    const vesper = chip("Vesper");
    chips = [desk.chip, vesper.chip];
    expect(composerLanding("Vesper")).toEqual({ face: vesper.face, name: vesper.label });
    expect(lineLanding(null)).toBeNull();
    const face = fake(box(0, 0, 16, 16));
    const name = fake(box(20, 0, 40, 16), "Mango");
    expect(lineLanding(as(fake(box(0, 0, 300, 26), "", { ".handover-line-face": face, '[data-travel="name"]': name }))))
      .toEqual({ face, name });
  });
});

// An agent's face and name, travelling from the card that was confirmed to
// the place that says the same agent next.
//
// A route's card is confirmed and the page goes to the chat it opened: the
// face and the name land on that chat's composer, where the agent is named.
// A handover's card is confirmed and the page stays: they shrink into the
// line the card leaves behind. Either way the card is gone by then, so what
// travels is a copy on the page's own layer (`document.body`), from where
// the card was last seen to where the name now is, and the landing place is
// unseen until it arrives.
//
// One movement, about 200ms, ease out, no overshoot. And it happens whole or
// not at all: with motion reduced, with nowhere on screen to land, or with a
// chat that never opened, nothing is drawn and nothing is hidden. A copy is
// put on the page only in the frame it starts to move, so none can be left
// behind.
//
// A card says it was confirmed (`rememberIdentity`) and keeps where it is up
// to date while it lives (`refreshIdentity`); whoever draws the landing asks
// for the travel (`landIdentity`).

export type Box = { x: number; y: number; w: number; h: number };
/** A copy's whole movement, as a transform about its own top left corner. */
export type Flight = { dx: number; dy: number; scale: number };

export const TRAVEL_MS = 200;
/** `--enter-ease` (design-system.css): ease out, and never past its end. */
export const TRAVEL_EASE = "cubic-bezier(0.33, 1, 0.68, 1)";
/** Frames a landing may take to be drawn once the card has gone. */
const GRACE_FRAMES = 2;
/** How long a card may stay drawn before its confirmation is taken as going
 *  nowhere. Longer than the page keeps a route's card (`App`, `GOING_MS`). */
const WAIT_MS = 20_000;
/** How long ago a card may have last been seen and still be travelled from.
 *  A card that left the page before that (the person went to another chat
 *  while its chat was starting) was not seen where its boxes say. */
export const FRESH_MS = 400;

/** Whether a card last seen at `at` is still where the eye left it. */
export function fresh(at: number, now: number): boolean {
  return now - at <= FRESH_MS;
}

/** Whether any of a box is inside the window. */
export function onScreen(box: Box, view: { w: number; h: number }): boolean {
  return box.w > 0 && box.h > 0 && box.x + box.w > 0 && box.y + box.h > 0 && box.x < view.w && box.y < view.h;
}

/** Whether a box is wholly inside another (a pixel's give for rounding). */
export function inside(box: Box, clip: Box): boolean {
  return box.x >= clip.x - 1 && box.y >= clip.y - 1
    && box.x + box.w <= clip.x + clip.w + 1 && box.y + box.h <= clip.y + clip.h + 1;
}

/** From one box to another: scaled about its top left, and arriving centred
 *  on the line it lands in. A face scales by its box; words by their type. */
export function flight(from: Box, to: Box, scale = to.h / from.h): Flight {
  return { dx: to.x - from.x, dy: to.y + to.h / 2 - (from.h * scale) / 2 - from.y, scale };
}

export type TravelPlan = { face: Flight; name: Flight | null };

/** What moves, or `null` for no travel at all: motion is reduced, the face
 *  was not on screen where it was last seen, or its landing is not on
 *  screen. The name travels with the face or not at all. */
export function travelPlan(input: {
  calm: boolean;
  view: { w: number; h: number };
  face: { from: Box; to: Box | null };
  name?: { from: Box; to: Box | null; fromFont: number; toFont: number } | null;
}): TravelPlan | null {
  const { calm, view, face, name } = input;
  if (calm || !face.to) return null;
  if (!onScreen(face.from, view) || !onScreen(face.to, view) || !inside(face.to, { x: 0, y: 0, ...view })) return null;
  const named = name?.to && onScreen(name.from, view) && onScreen(name.to, view) && name.fromFont > 0 && name.toFont > 0
    ? flight(name.from, name.to, name.toFont / name.fromFont)
    : null;
  return { face: flight(face.from, face.to), name: named };
}

/* ---- The page -------------------------------------------------------- */

/** Where a face and a name are drawn now. */
export type Landing = { face: Element | null; name: Element | null };

type Seen = {
  card: Element;
  /** When the card was last seen where these boxes say. */
  at: number;
  face: { box: Box; copy: HTMLElement };
  name: { box: Box; copy: HTMLElement; font: number } | null;
};

/** The cards confirmed in this page, by the handover they ask about. */
const remembered = new Map<string, Seen>();

export function calm(): boolean {
  return typeof window === "undefined" || !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

const boxOf = (element: Element): Box => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
};

/** The part of the window an element can be seen through: the window, cut
 *  down by every ancestor that clips what leaves it. */
function clipOf(element: Element): Box {
  let clip: Box = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const box = boxOf(parent);
    const x = Math.max(clip.x, box.x);
    const y = Math.max(clip.y, box.y);
    clip = { x, y, w: Math.min(clip.x + clip.w, box.x + box.w) - x, h: Math.min(clip.y + clip.h, box.y + box.h) - y };
  }
  return clip;
}

/** An element's box when all of it can be seen, else `null`. */
function seenBox(element: Element | null): Box | null {
  if (!element || !element.isConnected) return null;
  const box = boxOf(element);
  if (box.w <= 0 || box.h <= 0) return null;
  return inside(box, clipOf(element)) ? box : null;
}

/** The words of a name as a thing of their own: the type they are set in,
 *  written on the copy, so it reads the same wherever it is put. */
function nameCopy(element: Element): { copy: HTMLElement; font: number } {
  const style = getComputedStyle(element);
  const copy = document.createElement("span");
  copy.textContent = element.textContent;
  Object.assign(copy.style, {
    fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle,
    lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, color: style.color, whiteSpace: "nowrap",
  });
  return { copy, font: parseFloat(style.fontSize) || 0 };
}

function see(card: Element): Seen | null {
  const face = card.querySelector(".handover-face .agent-avatar");
  if (!face) return null;
  const box = boxOf(face);
  // Not laid out: the card has left the page, and where it was is not known.
  if (box.w <= 0 || box.h <= 0) return null;
  const name = card.querySelector('[data-travel="name"]');
  return {
    card,
    at: performance.now(),
    face: { box, copy: face.cloneNode(true) as HTMLElement },
    name: name ? { box: boxOf(name), ...nameCopy(name) } : null,
  };
}

/** A card's confirming answer was pressed: its face and name may travel. */
export function rememberIdentity(id: string, card: Element | null): void {
  if (typeof document === "undefined" || !card || calm()) return;
  const seen = see(card);
  if (seen) remembered.set(id, seen);
}

/** Where a remembered card is now. Called as the card is drawn and as it
 *  leaves, so the travel starts from where it was last seen. A card that
 *  was never confirmed, or is no longer laid out, changes nothing. */
export function refreshIdentity(id: string, card: Element | null): void {
  if (!card || !remembered.has(id)) return;
  const seen = see(card);
  if (seen) remembered.set(id, seen);
}

export function forgetIdentity(id: string): void {
  remembered.delete(id);
}

/** A remembered card is leaving the page: where it is now is where it was
 *  last seen. Whoever draws its landing asks for the travel in this same
 *  moment or the next; a confirmation nobody has asked about by then is
 *  dropped, so it cannot start a travel later from a place long gone. */
export function leaveIdentity(id: string, card: Element | null): void {
  if (!remembered.has(id)) return;
  refreshIdentity(id, card);
  const seen = remembered.get(id);
  window.setTimeout(() => {
    if (remembered.get(id) === seen) remembered.delete(id);
  }, FRESH_MS * 2);
}

/** Whether a card's confirmation is still waiting for somewhere to land. */
export function identityRemembered(id: string): boolean {
  return remembered.has(id);
}

/** A copy, on the page's own layer, at the box it was seen in. */
function place(copy: HTMLElement, box: Box): void {
  Object.assign(copy.style, {
    position: "fixed", left: `${box.x}px`, top: `${box.y}px`, margin: "0", zIndex: "2147483000",
    pointerEvents: "none", transformOrigin: "0 0", willChange: "transform",
  });
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("data-identity-travel", "");
  document.body.appendChild(copy);
}

function fly(seen: Seen, to: Landing): void {
  const toFace = seenBox(to.face);
  const toName = seen.name ? seenBox(to.name) : null;
  const plan = travelPlan({
    calm: calm(),
    view: { w: window.innerWidth, h: window.innerHeight },
    face: { from: seen.face.box, to: toFace },
    name: seen.name && to.name
      ? { from: seen.name.box, to: toName, fromFont: seen.name.font, toFont: parseFloat(getComputedStyle(to.name).fontSize) || 0 }
      : null,
  });
  if (!plan) return;
  const moves: [HTMLElement, Flight, Element][] = [[seen.face.copy, plan.face, to.face!]];
  if (plan.name && seen.name) moves.push([seen.name.copy, plan.name, to.name!]);
  for (const [copy, path, landing] of moves) {
    const target = landing as HTMLElement;
    const was = target.style.visibility;
    let over = false;
    // The landing is shown again and the copy taken away together, once,
    // however the movement ends: finished, cancelled, or never run.
    const done = () => {
      if (over) return;
      over = true;
      copy.remove();
      target.style.visibility = was;
    };
    place(copy, copy === seen.face.copy ? seen.face.box : seen.name!.box);
    target.style.visibility = "hidden";
    try {
      const run = copy.animate(
        [{ transform: "translate(0, 0) scale(1)" }, { transform: `translate(${path.dx}px, ${path.dy}px) scale(${path.scale})` }],
        { duration: TRAVEL_MS, easing: TRAVEL_EASE, fill: "forwards" },
      );
      run.onfinish = done;
      run.oncancel = done;
    } catch {
      done();
    }
    // A page in the background runs no animation and ends none.
    window.setTimeout(done, TRAVEL_MS * 3);
  }
}

/** Send a confirmed card's face and name to where they are drawn now.
 *  `find` answers the landing once it is on the page, and `null` until then:
 *  a line the card became is there at once; a chat the page goes to is there
 *  when the page gets to it, which for a route waits on the host. Asked each
 *  frame while the card is still drawn (the page keeps a route's card until
 *  it leaves the chat), and for two frames after it has gone; a landing that
 *  is not there by then is not travelled to. Nothing is on the page until
 *  the travel starts. */
export function landIdentity(id: string, find: () => Landing | null): void {
  if (typeof document === "undefined" || !remembered.has(id)) return;
  if (calm()) {
    remembered.delete(id);
    return;
  }
  const since = performance.now();
  let gone = 0;
  const step = () => {
    const card = remembered.get(id)?.card;
    if (!card) return;
    const to = find();
    if (to?.face) {
      // Still drawn beside its landing: where it is now is where it is seen.
      if (card.isConnected) refreshIdentity(id, card);
      const seen = remembered.get(id)!;
      remembered.delete(id);
      if (fresh(seen.at, performance.now())) fly(seen, to);
      return;
    }
    if (!card.isConnected) gone += 1;
    if (gone > GRACE_FRAMES || performance.now() - since > WAIT_MS) {
      remembered.delete(id);
      return;
    }
    window.requestAnimationFrame(step);
  };
  step();
}

/** The composer's own naming of the agent a chat is with, when it names
 *  `name`: where a route's face and name land. */
export function composerLanding(name: string): Landing | null {
  for (const chip of document.querySelectorAll(".composer-identity")) {
    const label = chip.querySelector(".composer-identity-name");
    if (label?.textContent?.trim() !== name.trim()) continue;
    return { face: chip.querySelector(".agent-avatar"), name: label };
  }
  return null;
}

/** The line a confirmed handover leaves: where its face and name land. */
export function lineLanding(line: Element | null): Landing | null {
  if (!line) return null;
  return { face: line.querySelector(".handover-line-face"), name: line.querySelector('[data-travel="name"]') };
}

// Opening the project drawer with a finger.
//
// The drawer already opens from the project name in the top bar. On a phone
// that name is at the far end from the thumb, so the drawer also answers to a
// drag in from the left edge — the gesture every phone app uses for the same
// thing.
//
// The whole difficulty is telling that drag apart from the three other things a
// finger does over the same pixels: scrolling the chat, scrolling something
// sideways inside it, and HIGHLIGHTING text. So the decision is made in one
// place, as a small state machine over the points a touch reports, and it is
// deliberately slow to commit:
//
//   - it only ever starts in a narrow strip at the very edge (or anywhere, once
//     the drawer is open and the only thing left to do is shut it),
//   - it drops the moment the finger is going more up-and-down than sideways,
//   - and it drops a finger that SAT STILL first, because that is a long press,
//     which is how a phone starts a highlight.
//
// Nothing here touches the DOM, so the rules above are testable; `useDrawerSwipe`
// at the bottom is the thin part that listens and paints.
import { useEffect, useRef, type RefObject } from "react";

/** How far in from the left edge a drag has to begin to mean "the drawer".
 *  Narrow on purpose: it is the one strip where a sideways drag can be nothing
 *  else. */
export const EDGE_PX = 28;

/** How far the finger has to travel before the gesture is anybody's. Under
 *  this, the touch is still just a touch — a tap, or the start of a press. */
export const SLOP_PX = 10;

/** A finger that has not gone anywhere in this long is not swiping. It is
 *  pressing, and a press over text is the start of a highlight. */
export const HOLD_MS = 350;

/** How much of the drawer's width the finger has to cross for the release to
 *  commit rather than snap back. */
export const COMMIT = 0.4;

/** px per ms. Past this the release is a flick, and a flick means it however
 *  short it was. */
export const FLICK = 0.5;

export type Pt = { x: number; y: number; t: number };

export type Swipe = {
  /** `watching` — a touch in the right place, not yet claimed. `swiping` — it
   *  is ours, and the drawer is following the finger. `dropped` — it belongs to
   *  something else, and we never look at it again. */
  phase: "watching" | "swiping" | "dropped";
  /** Which way this gesture can only go: in from the edge, or back out. */
  opening: boolean;
  from: Pt;
  /** The point before the last one, so a release can be read as a flick. */
  prev: Pt;
  at: Pt;
  /** The drawer's width, which is what the distance is measured against. */
  width: number;
};

/** Begin watching a touch, or return null when it cannot be about the drawer. */
export function swipeStart(p: Pt, o: { open: boolean; width: number }): Swipe | null {
  // Closed, the gesture lives in the edge strip and nowhere else. Open, it can
  // start anywhere: everything on screen is either the drawer or the scrim over
  // the chat, and both mean the same thing under a leftward drag.
  if (!o.open && p.x > EDGE_PX) return null;
  return { phase: "watching", opening: !o.open, from: p, prev: p, at: p, width: o.width };
}

/** Feed the next point in. */
export function swipeMove(s: Swipe, p: Pt): Swipe {
  if (s.phase === "dropped") return s;
  const next = { ...s, prev: s.at, at: p };
  if (s.phase === "swiping") return next;

  const dx = p.x - s.from.x;
  const dy = p.y - s.from.y;

  // Held first, then moved: a press, so the phone is highlighting text and this
  // finger is not ours.
  if (p.t - s.from.t > HOLD_MS) return { ...next, phase: "dropped" };
  // Going more up than across: the chat is scrolling.
  if (Math.abs(dy) > SLOP_PX && Math.abs(dy) > Math.abs(dx)) return { ...next, phase: "dropped" };
  if (Math.abs(dx) <= SLOP_PX) return next;
  // Far enough across to be claimed — but only in the one direction this
  // gesture can mean anything. Dragging left off the closed edge, or right with
  // the drawer already open, is somebody else's.
  if (s.opening ? dx < 0 : dx > 0) return { ...next, phase: "dropped" };
  return { ...next, phase: "swiping" };
}

/** How far open the drawer should be drawn, 0 (shut) to 1 (open). */
export function swipeProgress(s: Swipe): number {
  const dx = s.at.x - s.from.x;
  const p = s.opening ? dx / s.width : 1 + dx / s.width;
  return Math.min(1, Math.max(0, p));
}

/** What the release means: `null` when the gesture never became ours. */
export function swipeEnd(s: Swipe): "open" | "close" | null {
  if (s.phase !== "swiping") return null;
  const dt = s.at.t - s.prev.t;
  const v = dt > 0 ? (s.at.x - s.prev.x) / dt : 0;
  if (v > FLICK) return "open";
  if (v < -FLICK) return "close";
  return swipeProgress(s) > COMMIT ? "open" : "close";
}

/** Does anything between `el` and `root` scroll sideways? Then the finger is
 *  probably about to scroll it — a wide code block or a diff reaches the left
 *  edge, and its own scroll has to win there. */
export function scrollsSideways(el: Element | null, root: Element): boolean {
  for (let n = el; n && n !== root; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
  }
  return false;
}

/** Wire the gesture to an element — the app shell, which holds both the drawer
 *  and everything the drawer covers.
 *
 *  Touch events only, so a mouse is never in this: a mouse drag across text IS
 *  a highlight, and there is no telling the two apart. On a desktop the pointer
 *  has the top bar anyway. */
export function useDrawerSwipe(
  ref: RefObject<HTMLElement | null>,
  { enabled, open, onChange }: { enabled: boolean; open: boolean; onChange: (open: boolean) => void },
) {
  // Read through refs so the listeners are bound once per screen size, not
  // re-bound every time the drawer opens or a render replaces the callback.
  const openRef = useRef(open);
  openRef.current = open;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let s: Swipe | null = null;

    const clear = () => {
      s = null;
      el.classList.remove("is-swiping");
      el.style.removeProperty("--swipe-p");
    };

    const start = (e: TouchEvent) => {
      s = null;
      if (e.touches.length > 1) return;
      // A highlight already on screen is being adjusted, not swiped away.
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!openRef.current && scrollsSideways(target, el)) return;
      const t = e.touches[0];
      const width = el.querySelector<HTMLElement>(".sidebar")?.offsetWidth || el.clientWidth;
      s = swipeStart({ x: t.clientX, y: t.clientY, t: e.timeStamp }, { open: openRef.current, width });
    };

    const move = (e: TouchEvent) => {
      if (!s) return;
      if (e.touches.length > 1) return clear();
      const t = e.touches[0];
      s = swipeMove(s, { x: t.clientX, y: t.clientY, t: e.timeStamp });
      if (s.phase === "dropped") return clear();
      if (s.phase !== "swiping") return;
      // Ours now: hold the page still under it. Not cancelable once the browser
      // has started its own scroll, which is why the check is here and not a
      // reason to bind this passive.
      if (e.cancelable) e.preventDefault();
      el.classList.add("is-swiping");
      el.style.setProperty("--swipe-p", String(swipeProgress(s)));
    };

    const end = () => {
      const verdict = s && swipeEnd(s);
      clear();
      if (verdict) changeRef.current(verdict === "open");
    };

    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", clear, { passive: true });
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", clear);
      clear();
    };
  }, [ref, enabled]);
}

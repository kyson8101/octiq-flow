// Moving between a project's chats with a finger.
//
// The sidebar is how you change chat, and on a phone that means opening the
// drawer, finding the row, tapping it, watching the drawer shut. Between two
// chats you are working in turn, that is four actions for a thing every other
// phone app does with one drag. So the chat pane also answers to a sideways
// swipe: left for the next chat down the project's list, right for the one
// above, wrapping round at either end.
//
// This is the SECOND horizontal gesture over the same pixels, and the first one
// wins where they meet. `lib/swipe` owns a strip `EDGE_PX` wide at the pane's
// left edge, which is where the drawer is pulled out from; a strip the same
// width at the right is left to the browser's own back-swipe. This gesture is
// everything in between — and, unlike the drawer's, it can go either way.
//
// The rest of the difficulty is the same difficulty, so the rules are the same
// and three of them are imported outright: drop a finger going more up-and-down
// than across (the chat is scrolling), drop a finger that SAT STILL first (that
// is a long press, which is how a phone starts a highlight), and drop a finger
// over something that scrolls sideways (a wide code block or a diff).
//
// Nothing above `useChatSwipe` touches the DOM, so all of it is testable.
import { useEffect, useRef, type RefObject } from "react";
import { EDGE_PX, FLICK, HOLD_MS, SLOP_PX, scrollsSideways, type Pt } from "./swipe";

/** How much of the pane's width the finger has to cross for the release to
 *  count. Lower than the drawer's, because there is no half-open state to read:
 *  the pane either changes or it does not, and a quarter of the screen is
 *  already a deliberate drag. */
export const COMMIT = 0.25;

/** How far off the side a new chat starts, as a share of the pane. Short on
 *  purpose: a hint at where the chat came from, not a page turn. */
export const ENTER = 0.2;

/** How long the pane takes to settle, in ms. Written in styles.css as well —
 *  this copy only exists so the classes can be taken off again afterwards, and
 *  it is generous on purpose, so being a little out of step is invisible. */
export const LAND_MS = 180;

/** Which way along the list a release means to go. `next` is DOWN the sidebar's
 *  order — the finger goes left, and the chat below slides in behind it. */
export type Dir = "next" | "prev";

export type ChatSwipe = {
  /** `watching` — a touch in the right place, not yet claimed. `swiping` — it
   *  is ours, and the pane is following the finger. `dropped` — it belongs to
   *  something else, and we never look at it again. */
  phase: "watching" | "swiping" | "dropped";
  from: Pt;
  /** The point before the last one, so a release can be read as a flick. */
  prev: Pt;
  at: Pt;
  /** The pane's width, which is what the distance is measured against. */
  width: number;
};

/** Begin watching a touch, or return null when it belongs to one of the edges.
 *  `p.x` is measured from the pane's own left edge, not the window's: with the
 *  sidebar open as a column the two are far apart, and it is the pane that this
 *  gesture is about. */
export function chatSwipeStart(p: Pt, o: { width: number }): ChatSwipe | null {
  if (p.x < EDGE_PX || p.x > o.width - EDGE_PX) return null;
  return { phase: "watching", from: p, prev: p, at: p, width: o.width };
}

/** Feed the next point in. */
export function chatSwipeMove(s: ChatSwipe, p: Pt): ChatSwipe {
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
  // Far enough across to be claimed. No direction test, unlike the drawer:
  // there is a chat on both sides of this one.
  return { ...next, phase: "swiping" };
}

/** How far the pane should be drawn from home, in px, signed. */
export function chatSwipeDx(s: ChatSwipe): number {
  return s.at.x - s.from.x;
}

/** What the release means: `null` when the gesture never became ours, or when
 *  the finger stopped short and the pane should go back where it was. */
export function chatSwipeEnd(s: ChatSwipe): Dir | null {
  if (s.phase !== "swiping") return null;
  const dt = s.at.t - s.prev.t;
  const v = dt > 0 ? (s.at.x - s.prev.x) / dt : 0;
  // A flick means it however little ground it covered — that is the point of
  // flicking, and it is how a long list of chats gets walked quickly.
  if (v <= -FLICK) return "next";
  if (v >= FLICK) return "prev";
  const dx = chatSwipeDx(s);
  if (Math.abs(dx) < s.width * COMMIT) return null;
  return dx < 0 ? "next" : "prev";
}

/** The chat one step along from `current`, wrapping round the ends.
 *
 *  Wrapping because the gesture is a rotation rather than a walk to an end: on
 *  a project with two or three chats, a finger that stopped dead at the last
 *  one would read as the gesture having failed. `null` when there is nowhere to
 *  go — one chat, none, or a current chat that is not in this list, which is
 *  what a project switch looks like for the render in the middle of it. */
export function neighbour(ids: string[], current: string | null, dir: Dir): string | null {
  if (ids.length < 2 || !current) return null;
  const i = ids.indexOf(current);
  if (i < 0) return null;
  return ids[(i + (dir === "next" ? 1 : -1) + ids.length) % ids.length];
}

/** Things inside the chat pane a sideways drag can only be about. The terminal
 *  has its own idea of a touch, and a drag across the prompt box is someone
 *  picking their own half-written words back up. */
const NOT_OURS = ".drawer, .composer, .xterm, [data-noswipe]";

/** Wire the gesture to the chat pane.
 *
 *  Touch events only, for the reason `useDrawerSwipe` is: a mouse drag across
 *  text IS a highlight, and there is no telling the two apart. A pointer has
 *  the sidebar sitting open beside it anyway.
 *
 *  The pane is moved by a CSS variable rather than by React, so a drag does not
 *  re-render a whole transcript on every frame — `.is-chat-swiping` in
 *  styles.css is the other half of this. */
export function useChatSwipe(
  ref: RefObject<HTMLElement | null>,
  { enabled, onGo }: { enabled: boolean; onGo: (dir: Dir) => void },
) {
  // Read through a ref so the listeners are bound once, not re-bound every time
  // a render replaces the callback.
  const goRef = useRef(onGo);
  goRef.current = onGo;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let s: ChatSwipe | null = null;
    /** Where the pane's left edge was when the finger went down, so the points
     *  fed to the state machine are the pane's and not the window's. */
    let origin = 0;
    let settling = 0;

    /** Put the pane back under its own styles, mid-gesture or after one. */
    const rest = () => {
      s = null;
      window.clearTimeout(settling);
      el.classList.remove("is-chat-swiping", "is-chat-landing");
      el.style.removeProperty("--chat-swipe-x");
    };

    /** Ease the pane home from wherever it is — back where it started when the
     *  finger stopped short, or in from the side the new chat came from. */
    const land = (from: number) => {
      s = null;
      // Placed under the DRAGGING class, which carries the transform without a
      // transition. Setting the starting offset under the landing class instead
      // would animate the jump to it — the pane sliding back the way it came
      // before setting off again — and dropping both classes for a frame would
      // flash it home and then away.
      el.classList.add("is-chat-swiping");
      el.style.setProperty("--chat-swipe-x", `${from}px`);
      // Two frames: one for the browser to take that offset as where the pane
      // now is, one for the change to 0 to be a transition rather than the
      // whole thing collapsing into a single paint.
      requestAnimationFrame(() => {
        el.classList.add("is-chat-landing");
        el.classList.remove("is-chat-swiping");
        requestAnimationFrame(() => el.style.setProperty("--chat-swipe-x", "0px"));
      });
      // Cleared on a clock rather than on `transitionend`, which fires for
      // every transition of every child that bubbles past and would take the
      // classes off halfway through this one.
      window.clearTimeout(settling);
      settling = window.setTimeout(rest, LAND_MS + 80);
    };

    const start = (e: TouchEvent) => {
      s = null;
      if (e.touches.length > 1) return;
      // A highlight already on screen is being adjusted, not swiped away.
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(NOT_OURS)) return;
      if (scrollsSideways(target, el)) return;
      const t = e.touches[0];
      const box = el.getBoundingClientRect();
      origin = box.left;
      s = chatSwipeStart(
        { x: t.clientX - origin, y: t.clientY, t: e.timeStamp },
        { width: box.width },
      );
      // A finger down while the last chat is still settling: the clock below
      // would otherwise fire mid-drag and put the pane back under its own
      // styles with the finger still on it. Every path out of a gesture ends in
      // `rest`, so nothing is left behind by dropping it here.
      if (s) window.clearTimeout(settling);
    };

    const move = (e: TouchEvent) => {
      if (!s) return;
      if (e.touches.length > 1) return rest();
      const t = e.touches[0];
      s = chatSwipeMove(s, { x: t.clientX - origin, y: t.clientY, t: e.timeStamp });
      if (s.phase === "dropped") return rest();
      if (s.phase !== "swiping") return;
      // Ours now: hold the page still under it. Not cancelable once the browser
      // has started its own scroll, which is why the check is here and not a
      // reason to bind this passive.
      if (e.cancelable) e.preventDefault();
      el.classList.remove("is-chat-landing");
      el.classList.add("is-chat-swiping");
      el.style.setProperty("--chat-swipe-x", `${chatSwipeDx(s)}px`);
    };

    const end = () => {
      if (!s) return;
      if (s.phase !== "swiping") return rest();
      const dir = chatSwipeEnd(s);
      if (!dir) return land(chatSwipeDx(s));
      // The chat changes NOW, and the new one is placed just off the side it
      // came from and slid home. The old one does not first walk off screen:
      // that would be a wait before the thing that was asked for happens, and
      // the transcript underneath is what the reader is swiping towards.
      goRef.current(dir);
      land(dir === "next" ? el.clientWidth * ENTER : -el.clientWidth * ENTER);
    };

    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", rest, { passive: true });
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", rest);
      rest();
    };
  }, [ref, enabled]);
}

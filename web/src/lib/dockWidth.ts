// The width of a docked column, and the handle that drags it.
//
// Three panels sit in the same slot down the right-hand side — git, the files
// this session touched, and a file you opened — and each of them wants the
// same behaviour: a width you can drag, remembered between visits, squeezed
// when the window is too narrow for it and handed straight back when it is not.
//
// It was written out twice before this and was about to be written a third
// time, so it lives here once instead.
//
// The project column on the LEFT is the fourth, and the only difference it
// needs is which way the handle runs: it is dragged by its right edge, so right
// is wider, where a right-hand panel's left edge makes left wider.
import { useCallback, useEffect, useState } from "react";
import type React from "react";
import { recall, remember } from "./remember";

/** Room the chat keeps whatever a panel is dragged to. A column you can drag
 *  over the chat is a column you can lose the chat behind. */
const CHAT_MIN_W = 340;

/** The width the sidebar takes at the point it stops being a drawer, and what
 *  a right-hand panel assumes it is giving up when it cannot read better. */
const SIDEBAR_W = 260;

/** Which edge the handle is on. A left dock's handle is its RIGHT edge. */
export type Side = "left" | "right";

/** What the project column is actually set to. It is draggable now, so a
 *  right-hand panel that reserved a flat 260px would let the two of them add up
 *  to more than the window whenever the column had been widened. Read off the
 *  same custom property the layout uses, so there is one answer and the CSS
 *  owns it. Below the column breakpoint the sidebar is a drawer over the top of
 *  everything and takes no width at all. */
function sidebarWidth(): number {
  if (window.innerWidth < 860) return 0;
  // A panel rendered without a document to read — the server-rendered tests —
  // still has to hand back a number, and the width a first visit gets is the
  // right one.
  if (typeof document === "undefined") return SIDEBAR_W;
  const set = getComputedStyle(document.documentElement).getPropertyValue("--nav-w");
  return Number.parseFloat(set) || SIDEBAR_W;
}

export type Sizes = {
  /** What a first visit gets. */
  initial: number;
  min: number;
  max: number;
};

export type Dock = {
  /** What to apply. Already clamped to what the window can spare. */
  width: number;
  /** `onPointerDown` for the drag handle. */
  startDrag: (e: React.PointerEvent<HTMLElement>) => void;
  /** False for the first frame after mounting, so a panel that slides in from
   *  off-screen has a position to transition FROM. Mounting straight into the
   *  open position is already the finished state and CSS has nothing to
   *  animate. */
  entered: boolean;
};

function clamp(px: number, sizes: Sizes, side: Side): number {
  // The project column reserves nothing for itself — it IS the sidebar — and
  // what it must leave standing is the chat beside it.
  const taken = side === "left" ? 0 : sidebarWidth();
  const max = Math.max(sizes.min, Math.min(sizes.max, window.innerWidth - taken - CHAT_MIN_W));
  return Math.round(Math.min(max, Math.max(sizes.min, px)));
}

export function useDockWidth(key: string, sizes: Sizes, side: Side = "right"): Dock {
  /* What the handle was left at, kept apart from the width actually used: a
   * narrow window squeezes the panel, and a wide one has to give the chosen
   * width straight back rather than having quietly forgotten it. */
  const [chosen, setChosen] = useState(() => Number(recall(key)) || sizes.initial);
  const [, onViewportChange] = useState(0);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onResize = () => onViewportChange((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const width = clamp(chosen, sizes, side);

  /** Drag the panel's outer edge. Pointer events rather than mouse ones, so the
   *  handle works from a trackpad, a pen and a touch screen with one code
   *  path. */
  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = width;
      let latest = startW;

      const move = (ev: PointerEvent) => {
        // A panel on the RIGHT is dragged by its left edge, so dragging left
        // makes it wider; the project column on the left is the other way up.
        const moved = ev.clientX - startX;
        latest = clamp(side === "left" ? startW + moved : startW - moved, sizes, side);
        setChosen(latest);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        // Through `remember`, which cannot throw: a full store must not take
        // the listeners above down with it and leave the page dragging.
        remember(key, String(latest));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    },
    [key, sizes, side, width],
  );

  return { width, startDrag, entered };
}

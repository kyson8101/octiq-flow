// The width of a docked column, and the handle that drags it.
//
// Three panels sit in the same slot down the right-hand side — git, the files
// this session touched, and a file you opened — and each of them wants the
// same behaviour: a width you can drag, remembered between visits, squeezed
// when the window is too narrow for it and handed straight back when it is not.
//
// It was written out twice before this and was about to be written a third
// time, so it lives here once instead.
import { useCallback, useEffect, useState } from "react";
import type React from "react";

/** Room the chat keeps whatever a panel is dragged to. A column you can drag
 *  over the chat is a column you can lose the chat behind. */
const CHAT_MIN_W = 340;

/** The width the sidebar takes at the point it stops being a drawer. */
const SIDEBAR_W = 260;

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

function clamp(px: number, sizes: Sizes): number {
  const sidebar = window.innerWidth >= 860 ? SIDEBAR_W : 0;
  const max = Math.max(sizes.min, Math.min(sizes.max, window.innerWidth - sidebar - CHAT_MIN_W));
  return Math.round(Math.min(max, Math.max(sizes.min, px)));
}

export function useDockWidth(key: string, sizes: Sizes): Dock {
  /* What the handle was left at, kept apart from the width actually used: a
   * narrow window squeezes the panel, and a wide one has to give the chosen
   * width straight back rather than having quietly forgotten it. */
  const [chosen, setChosen] = useState(() => Number(readStored(key)) || sizes.initial);
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

  const width = clamp(chosen, sizes);

  /** Drag the left edge. Pointer events rather than mouse ones, so the handle
   *  works from a trackpad, a pen and a touch screen with one code path. */
  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = width;
      let latest = startW;

      const move = (ev: PointerEvent) => {
        // The panel is on the RIGHT, so dragging left makes it wider.
        latest = clamp(startW - (ev.clientX - startX), sizes);
        setChosen(latest);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        try {
          localStorage.setItem(key, String(latest));
        } catch {
          /* storage blocked: the width lasts for this session */
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    },
    [key, sizes, width],
  );

  return { width, startDrag, entered };
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

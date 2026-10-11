// A row that changes its place in a list moves there; it does not jump.
//
// The chat list is sorted by activity, so a chat that just answered goes to
// the top and every row it passed drops by one. Rows coming in and going out
// already have a reveal of their own (`AnimatedChatRow`); a row that only
// changed position had nothing, and was simply somewhere else on the next
// frame.
//
// This is the arithmetic of the usual remedy: where each row was before the
// list was drawn again, where it is now, and so how far back each one starts
// its move from. Nothing here touches the DOM, so every case is a test.
import { useLayoutEffect, useRef, type RefObject } from "react";

/** Under this, a row has not moved: sub-pixel layout noise. */
const STILL = 1;

/** How long a row takes to reach its new place, and how: inside the app's
 *  motion range, easing out, with no overshoot. Kept in step with
 *  `--enter-duration` and `--enter-ease` (design-system.css). */
export const ROW_MOVE_MS = 180;
export const ROW_MOVE_EASE = "cubic-bezier(0.33, 1, 0.68, 1)";

/** For each row that is still on screen and now somewhere else: how far
 *  from its new place it starts (old top minus new top). A row that was not
 *  there before is arriving, not moving, and is left to its own entry. */
export function rowMoves(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): Map<string, number> {
  const moves = new Map<string, number>();
  for (const [key, top] of after) {
    const was = before.get(key);
    if (was === undefined) continue;
    const from = was - top;
    if (Math.abs(from) >= STILL) moves.set(key, from);
  }
  return moves;
}

function tops(root: HTMLElement, selector: string): Map<string, number> {
  const origin = root.getBoundingClientRect().top;
  const found = new Map<string, number>();
  for (const row of root.querySelectorAll<HTMLElement>(selector)) {
    const key = row.dataset.row;
    // Measured against the list itself, so scrolling it changes nothing.
    if (key) found.set(key, row.getBoundingClientRect().top - origin);
  }
  return found;
}

/** Moves the rows under `root` that changed place when `order` changed.
 *
 *  Where the rows were is read as `order` changes, during the render that
 *  changes it: the DOM still holds the last commit then, and reading it
 *  twice gives the same answer, so a render React runs twice is harmless.
 *  Measuring on every render instead would force layout on each one, and
 *  this list re-renders with every chat's activity.
 *
 *  Rows are matched by `data-row`. The move is a transform, so nothing else
 *  in the page is laid out again, and it is skipped for reduced motion. */
export function useRowMotion(root: RefObject<HTMLElement | null>, order: string, selector = "[data-row]"): void {
  const drawn = useRef<{ order: string; tops: Map<string, number> } | null>(null);
  if (drawn.current && drawn.current.order !== order && root.current) {
    drawn.current = { order: drawn.current.order, tops: tops(root.current, selector) };
  }
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const before = drawn.current;
    const now = tops(element, selector);
    drawn.current = { order, tops: now };
    if (!before || before.order === order) return;
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const moves = rowMoves(before.tops, now);
    if (!moves.size) return;
    for (const row of element.querySelectorAll<HTMLElement>(selector)) {
      const from = row.dataset.row ? moves.get(row.dataset.row) : undefined;
      if (from === undefined || typeof row.animate !== "function") continue;
      row.animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(0)" }], { duration: ROW_MOVE_MS, easing: ROW_MOVE_EASE });
    }
  }, [order, root, selector]);
}

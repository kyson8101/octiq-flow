export type MobileMenuScrollState = {
  top: number;
  /** How far the list could scroll when `top` was read, or null before the
   * first reading. */
  range: number | null;
  direction: "up" | "down" | null;
  travel: number;
  floating: boolean;
  hidden: boolean;
};

export const INITIAL_MOBILE_MENU_SCROLL: MobileMenuScrollState = {
  top: 0,
  range: null,
  direction: null,
  travel: 0,
  floating: false,
  hidden: false,
};

/** One reading of the list's scroller, taken in its scroll event. */
export type MobileMenuScrollReading = {
  /** `scrollTop` as the browser reports it — past either end while iOS
   * rubber-bands. */
  top: number;
  /** `scrollHeight - clientHeight`: the furthest `scrollTop` can settle. */
  range: number;
  menuHeight: number;
  /** A menu control has focus, so the menu must stay reachable. */
  preserve?: boolean;
};

const TOP_EDGE = 2;
const DOWN_INTENT = 18;
const UP_INTENT = 12;

/** Keeps the large mobile navigation in normal scroll flow until it has fully
 * passed. Past that point it may return as a sticky overlay, so revealing it
 * never changes the list's height or scroll position. Direction thresholds
 * keep trackpad/touch jitter from flickering it between states.
 *
 * Only a scroll the person made counts as intent. Two things move scrollTop
 * up without them, both at the END of the list, and both used to bring the
 * menu back there:
 *  - iOS lets a flick run past the end and reports the overshoot, then springs
 *    back. Readings are clamped to the scrollable range, so the whole bounce
 *    reads as sitting still at the end — the same way the top already was.
 *  - When the range shrinks under the list (rows leave or lose a line, the
 *    viewport grows) the browser pulls scrollTop in with it. A move no bigger
 *    than the range change, in the same direction, is the layout's, not the
 *    person's. */
export function nextMobileMenuScroll(
  state: MobileMenuScrollState,
  reading: MobileMenuScrollReading,
): MobileMenuScrollState {
  const range = Math.max(0, reading.range);
  const top = Math.min(Math.max(0, reading.top), range);
  const delta = top - state.top;
  const atTop = top <= TOP_EDGE;

  if (atTop) {
    return { top, range, direction: null, travel: 0, floating: false, hidden: false };
  }

  const floating = state.floating || top >= Math.max(1, reading.menuHeight);
  if (reading.preserve) {
    return { top, range, direction: null, travel: 0, floating, hidden: false };
  }

  const rangeChange = state.range === null ? 0 : range - state.range;
  const followedLayout = rangeChange !== 0
    && Math.sign(delta) === Math.sign(rangeChange)
    && Math.abs(delta) <= Math.abs(rangeChange) + 1;
  if (Math.abs(delta) < 1 || followedLayout) return { ...state, top, range, floating };

  const direction = delta > 0 ? "down" : "up";
  const travel = state.direction === direction ? state.travel + Math.abs(delta) : Math.abs(delta);
  let hidden = state.hidden;

  if (!floating) hidden = false;
  else if (direction === "down" && travel >= DOWN_INTENT) hidden = true;
  else if (direction === "up" && travel >= UP_INTENT) hidden = false;

  return { top, range, direction, travel, floating, hidden };
}

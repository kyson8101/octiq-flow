export type MobileMenuScrollState = {
  top: number;
  direction: "up" | "down" | null;
  travel: number;
  floating: boolean;
  hidden: boolean;
};

export const INITIAL_MOBILE_MENU_SCROLL: MobileMenuScrollState = {
  top: 0,
  direction: null,
  travel: 0,
  floating: false,
  hidden: false,
};

const TOP_EDGE = 2;
const BOTTOM_EDGE = 8;
const DOWN_INTENT = 18;
const UP_INTENT = 12;

/** Keeps the large mobile navigation in normal scroll flow until it has fully
 * passed. Past that point it may return as a sticky overlay, so revealing it
 * never changes the list's height or scroll position. Direction thresholds
 * keep trackpad/touch bounce from flickering it between states.
 *
 * `maxTop` is the furthest the list can scroll. At the bottom, the list moves
 * up without anyone asking: a rubber-band settles, Safari's toolbar comes
 * back and shortens the list's box, a row leaves. None of that is upward
 * intent, so it never brings the menu back (feedback ef1adcd3); scrolling up
 * away from the bottom still does. */
export function nextMobileMenuScroll(
  state: MobileMenuScrollState,
  nextTop: number,
  menuHeight: number,
  preserve = false,
  maxTop = Number.POSITIVE_INFINITY,
): MobileMenuScrollState {
  const top = Math.min(Math.max(0, nextTop), Math.max(0, maxTop));
  const delta = top - state.top;
  const atTop = top <= TOP_EDGE;
  const atBottom = top >= maxTop - BOTTOM_EDGE;

  if (atTop) {
    return { top, direction: null, travel: 0, floating: false, hidden: false };
  }

  const floating = state.floating || top >= Math.max(1, menuHeight);
  if (preserve) {
    return { top, direction: null, travel: 0, floating, hidden: false };
  }

  if (Math.abs(delta) < 1) return { ...state, top, floating };
  const direction = delta > 0 ? "down" : "up";
  if (direction === "up" && atBottom) {
    // Settling at the bottom: no travel counts until it leaves the edge.
    return { top, direction, travel: 0, floating, hidden: state.hidden };
  }
  const travel = state.direction === direction ? state.travel + Math.abs(delta) : Math.abs(delta);
  let hidden = state.hidden;

  if (!floating) hidden = false;
  else if (direction === "down" && travel >= DOWN_INTENT) hidden = true;
  else if (direction === "up" && travel >= UP_INTENT) hidden = false;

  return { top, direction, travel, floating, hidden };
}

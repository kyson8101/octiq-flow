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
const DOWN_INTENT = 18;
const UP_INTENT = 12;

/** Keeps the large mobile navigation in normal scroll flow until it has fully
 * passed. Past that point it may return as a sticky overlay, so revealing it
 * never changes the list's height or scroll position. Direction thresholds
 * keep trackpad/touch bounce from flickering it between states. */
export function nextMobileMenuScroll(
  state: MobileMenuScrollState,
  nextTop: number,
  menuHeight: number,
  preserve = false,
): MobileMenuScrollState {
  const top = Math.max(0, nextTop);
  const delta = top - state.top;
  const atTop = top <= TOP_EDGE;

  if (atTop) {
    return { top, direction: null, travel: 0, floating: false, hidden: false };
  }

  const floating = state.floating || top >= Math.max(1, menuHeight);
  if (preserve) {
    return { top, direction: null, travel: 0, floating, hidden: false };
  }

  if (Math.abs(delta) < 1) return { ...state, top, floating };
  const direction = delta > 0 ? "down" : "up";
  const travel = state.direction === direction ? state.travel + Math.abs(delta) : Math.abs(delta);
  let hidden = state.hidden;

  if (!floating) hidden = false;
  else if (direction === "down" && travel >= DOWN_INTENT) hidden = true;
  else if (direction === "up" && travel >= UP_INTENT) hidden = false;

  return { top, direction, travel, floating, hidden };
}

import { describe, expect, it } from "vitest";
import { INITIAL_MOBILE_MENU_SCROLL, nextMobileMenuScroll, type MobileMenuScrollState } from "./mobileMenuScroll";

const MENU = 200;
const RANGE = 2000;
const scrollThrough = (state: MobileMenuScrollState, tops: number[], range = RANGE) =>
  tops.reduce((before, top) => nextMobileMenuScroll(before, { top, range, menuHeight: MENU }), state);
const atEnd = scrollThrough(INITIAL_MOBILE_MENU_SCROLL, [120, 205, 400, 900, 1500, 1990, RANGE]);

describe("mobile Chats menu scroll", () => {
  it("leaves the menu in normal flow until it has completely scrolled past", () => {
    const state = nextMobileMenuScroll(INITIAL_MOBILE_MENU_SCROLL, { top: 120, range: RANGE, menuHeight: MENU });
    expect(state).toMatchObject({ floating: false, hidden: false, direction: "down" });
  });

  it("hides after downward intent and reveals after upward intent without changing scrollTop", () => {
    const passed = scrollThrough(INITIAL_MOBILE_MENU_SCROLL, [205]);
    const hidden = scrollThrough(passed, [224]);
    expect(hidden).toMatchObject({ top: 224, floating: true, hidden: true });

    const jitter = scrollThrough(hidden, [220]);
    expect(jitter.hidden).toBe(true);
    const revealed = scrollThrough(jitter, [207]);
    expect(revealed).toMatchObject({ top: 207, floating: true, hidden: false });
  });

  it("always reveals at the top and while a menu control is in use", () => {
    const hidden = { ...INITIAL_MOBILE_MENU_SCROLL, top: 300, range: RANGE, direction: "down" as const, travel: 40, floating: true, hidden: true };
    expect(nextMobileMenuScroll(hidden, { top: 301, range: RANGE, menuHeight: MENU, preserve: true }).hidden).toBe(false);
    expect(nextMobileMenuScroll(hidden, { top: 0, range: RANGE, menuHeight: MENU }))
      .toEqual({ ...INITIAL_MOBILE_MENU_SCROLL, range: RANGE });
  });

  it("stays folded while a flick rubber-bands past the end and springs back", () => {
    expect(atEnd).toMatchObject({ top: RANGE, floating: true, hidden: true });
    // What iOS reports: past the end, then back to it. 48px of "upward" travel
    // that nobody made.
    const bounced = scrollThrough(atEnd, [RANGE + 6, RANGE + 31, RANGE + 48, RANGE + 35, RANGE + 14, RANGE + 1, RANGE]);
    expect(bounced).toMatchObject({ top: RANGE, hidden: true });
  });

  it("reads an overshoot past the top as the top", () => {
    expect(scrollThrough(atEnd, [-30])).toMatchObject({ top: 0, floating: false, hidden: false });
  });

  it("stays folded when the list gets shorter, or the viewport taller, at the end", () => {
    // Four rows leave: the browser pulls scrollTop down to the new end.
    const shorter = scrollThrough(atEnd, [RANGE - 340], RANGE - 340);
    expect(shorter).toMatchObject({ top: RANGE - 340, hidden: true });
    // The viewport grows by 120px at the end.
    const taller = scrollThrough(shorter, [RANGE - 460], RANGE - 460);
    expect(taller).toMatchObject({ top: RANGE - 460, hidden: true });
  });

  it("still reveals on a real scroll up once the range has changed", () => {
    const shorter = scrollThrough(atEnd, [RANGE - 340], RANGE - 340);
    const up = scrollThrough(shorter, [RANGE - 346, RANGE - 360], RANGE - 340);
    expect(up).toMatchObject({ direction: "up", hidden: false });
    // A move bigger than the range change is the person's too.
    const pulled = scrollThrough(atEnd, [RANGE - 200], RANGE - 100);
    expect(pulled).toMatchObject({ direction: "up", hidden: false });
  });

  it("does not mistake the first reading for a layout change", () => {
    const first = nextMobileMenuScroll({ ...INITIAL_MOBILE_MENU_SCROLL, top: 240, floating: true }, { top: 280, range: RANGE, menuHeight: MENU });
    expect(first).toMatchObject({ direction: "down", hidden: true });
  });

  it("never folds a list too short to scroll", () => {
    expect(scrollThrough(INITIAL_MOBILE_MENU_SCROLL, [0, 40, 0], 0)).toMatchObject({ top: 0, floating: false, hidden: false });
  });
});

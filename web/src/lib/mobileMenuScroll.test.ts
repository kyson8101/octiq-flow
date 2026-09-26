import { describe, expect, it } from "vitest";
import { INITIAL_MOBILE_MENU_SCROLL, nextMobileMenuScroll } from "./mobileMenuScroll";

describe("mobile Chats menu scroll", () => {
  it("leaves the menu in normal flow until it has completely scrolled past", () => {
    const state = nextMobileMenuScroll(INITIAL_MOBILE_MENU_SCROLL, 120, 200);
    expect(state).toMatchObject({ floating: false, hidden: false, direction: "down" });
  });

  it("hides after downward intent and reveals after upward intent without changing scrollTop", () => {
    const passed = nextMobileMenuScroll(INITIAL_MOBILE_MENU_SCROLL, 205, 200);
    const hidden = nextMobileMenuScroll(passed, 224, 200);
    expect(hidden).toMatchObject({ top: 224, floating: true, hidden: true });

    const bounce = nextMobileMenuScroll(hidden, 220, 200);
    expect(bounce.hidden).toBe(true);
    const revealed = nextMobileMenuScroll(bounce, 207, 200);
    expect(revealed).toMatchObject({ top: 207, floating: true, hidden: false });
  });

  // Feedback ef1adcd3: the menu came back at the end of the list.
  describe("at the bottom of the list", () => {
    const MAX = 1000;
    const atEnd = () => {
      let state = nextMobileMenuScroll(INITIAL_MOBILE_MENU_SCROLL, 205, 200, false, MAX);
      for (const top of [400, 700, 990, 1000]) state = nextMobileMenuScroll(state, top, 200, false, MAX);
      expect(state).toMatchObject({ top: 1000, floating: true, hidden: true });
      return state;
    };

    it("stays hidden when the list's range shrinks under it (Safari's toolbar returns, a row leaves)", () => {
      // scrollTop is clamped 60px up, and the new end is 940.
      const shrunk = nextMobileMenuScroll(atEnd(), 940, 200, false, 940);
      expect(shrunk).toMatchObject({ top: 940, hidden: true, travel: 0 });
    });

    it("stays hidden through a rubber-band past the end and its settle", () => {
      let state = atEnd();
      for (const top of [1040, 1025, 1004, 1000]) state = nextMobileMenuScroll(state, top, 200, false, MAX);
      expect(state).toMatchObject({ top: 1000, hidden: true });
    });

    it("still comes back for a real upward scroll away from the end", () => {
      let state = atEnd();
      state = nextMobileMenuScroll(state, 995, 200, false, MAX);
      expect(state.hidden).toBe(true);
      state = nextMobileMenuScroll(state, 985, 200, false, MAX);
      state = nextMobileMenuScroll(state, 970, 200, false, MAX);
      expect(state).toMatchObject({ top: 970, hidden: false });
    });
  });

  it("always reveals at the top and while a menu control is in use", () => {
    const hidden = { ...INITIAL_MOBILE_MENU_SCROLL, top: 300, direction: "down" as const, travel: 40, floating: true, hidden: true };
    expect(nextMobileMenuScroll(hidden, 301, 200, true).hidden).toBe(false);
    expect(nextMobileMenuScroll(hidden, 0, 200)).toEqual(INITIAL_MOBILE_MENU_SCROLL);
  });
});

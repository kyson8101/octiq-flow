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

  it("always reveals at the top and while a menu control is in use", () => {
    const hidden = { ...INITIAL_MOBILE_MENU_SCROLL, top: 300, direction: "down" as const, travel: 40, floating: true, hidden: true };
    expect(nextMobileMenuScroll(hidden, 301, 200, true).hidden).toBe(false);
    expect(nextMobileMenuScroll(hidden, 0, 200)).toEqual(INITIAL_MOBILE_MENU_SCROLL);
  });
});

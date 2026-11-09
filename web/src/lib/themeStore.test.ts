import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGED } from "./theme";
import { BUILT_IN, CYBERPUNK_MODE, DARK_MODE, FUN_MODE, GUOFENG_MODE, LIGHT_MODE, MANGA_MODE, THEME_EVENT, THEMES, XP_MODE } from "./themeStore";

describe("appearance switching", () => {
  let store: typeof import("./themeStore");
  let properties: Map<string, string>;
  let attributes: Map<string, string>;
  let storage: Map<string, string>;
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    store = await import("./themeStore");
    properties = new Map();
    attributes = new Map();
    storage = new Map();
    dispatch = vi.fn();
    vi.stubGlobal("document", { documentElement: {
      style: {
        setProperty: (key: string, value: string) => properties.set(key, value),
        removeProperty: (key: string) => properties.delete(key),
      },
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      removeAttribute: (key: string) => attributes.delete(key),
    } });
    vi.stubGlobal("window", { dispatchEvent: dispatch });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("restores dark appearance without leaking the previous light palette", () => {
    store.applyTheme(LIGHT_MODE);
    expect(attributes.get("data-color-scheme")).toBe("light");
    expect(store.savedThemeId()).toBe(LIGHT_MODE);
    expect(properties.get("--bg-0")).toBe("#f7f7f7");
    store.applyTheme(BUILT_IN);
    expect(attributes.get("data-color-scheme")).toBe("dark");
    expect(attributes.has("data-theme")).toBe(false);
    for (const property of MANAGED) expect(properties.has(property)).toBe(false);
    expect(store.savedThemeId()).toBe(BUILT_IN);
    expect(dispatch.mock.calls.at(-1)?.[0].type).toBe(THEME_EVENT);
  });

  it("returns native controls to dark when choosing fun mode", () => {
    store.applyTheme(LIGHT_MODE);
    store.applyTheme(FUN_MODE);
    expect(attributes.get("data-color-scheme")).toBe("dark");
    expect(attributes.get("data-theme")).toBe(FUN_MODE);
    expect(properties.get("--bg-0")).not.toBe("#f7f7f7");
    expect(store.savedThemeId()).toBe(FUN_MODE);
  });

  it("puts manga on as a light mode with hand-cut corners", () => {
    store.applyTheme(MANGA_MODE);
    expect(attributes.get("data-color-scheme")).toBe("light");
    expect(attributes.get("data-theme")).toBe(MANGA_MODE);
    // Uneven corners named by the palette, not scaled from `--radius`.
    expect(properties.get("--r-md")).toBe("4px 2px 5px 2px");
    expect(store.savedThemeId()).toBe(MANGA_MODE);
  });

  it("puts 中国风 on as a dark mode with the gold accent", () => {
    store.applyTheme(GUOFENG_MODE);
    expect(attributes.get("data-color-scheme")).toBe("dark");
    expect(attributes.get("data-theme")).toBe(GUOFENG_MODE);
    // Gold, not cinnabar: the accent is also drawn as text.
    expect(properties.get("--accent")).toBe("#c9a45c");
    expect(store.savedThemeId()).toBe(GUOFENG_MODE);
  });

  it("puts Windows XP on as a light mode with Luna's blue accent", () => {
    store.applyTheme(XP_MODE);
    expect(attributes.get("data-color-scheme")).toBe("light");
    expect(attributes.get("data-theme")).toBe(XP_MODE);
    expect(properties.get("--accent")).toBe("#0054e3");
    // A decision is its own steel blue, never the accent.
    expect(properties.get("--decide")).toBe("#1a6a8a");
    expect(store.savedThemeId()).toBe(XP_MODE);
  });

  it("puts Cyberpunk on as a dark mode with the neon cyan accent", () => {
    store.applyTheme(CYBERPUNK_MODE);
    expect(attributes.get("data-color-scheme")).toBe("dark");
    expect(attributes.get("data-theme")).toBe(CYBERPUNK_MODE);
    // Cyan, not the magenta: the accent is also drawn as text.
    expect(properties.get("--accent")).toBe("#29e3f5");
    // A decision is its own electric blue, never the accent.
    expect(properties.get("--decide")).toBe("#6fb6ff");
    expect(store.savedThemeId()).toBe(CYBERPUNK_MODE);
  });

  it("only exposes light, dark, fun, manga, 中国风, Windows XP and Cyberpunk", () => {
    expect(THEMES.map(({ id }) => id)).toEqual([LIGHT_MODE, DARK_MODE, FUN_MODE, MANGA_MODE, GUOFENG_MODE, XP_MODE, CYBERPUNK_MODE]);
  });

  it("defaults each scheme to Light and Dark", () => {
    expect(store.lastThemeIdForScheme("light")).toBe(LIGHT_MODE);
    expect(store.lastThemeIdForScheme("dark")).toBe(DARK_MODE);
    expect(store.oppositeThemeId()).toBe(LIGHT_MODE);
    expect(store.oppositeThemeId(LIGHT_MODE)).toBe(DARK_MODE);
  });

  it("round-trips 中国风 and Manga and remembers newer Settings choices", () => {
    store.applyTheme(GUOFENG_MODE);
    store.applyTheme(MANGA_MODE);
    expect(store.oppositeThemeId()).toBe(GUOFENG_MODE);
    store.applyTheme(store.oppositeThemeId());
    expect(store.savedThemeId()).toBe(GUOFENG_MODE);
    expect(store.oppositeThemeId()).toBe(MANGA_MODE);
    // A Settings choice updates the same history without mounting the toggle.
    store.applyTheme(XP_MODE);
    store.applyTheme(CYBERPUNK_MODE);
    expect(store.oppositeThemeId()).toBe(XP_MODE);
    store.applyTheme(store.oppositeThemeId());
    expect(store.oppositeThemeId()).toBe(CYBERPUNK_MODE);
  });

  it("recalls each scheme from persistent storage after module reload", async () => {
    store.applyTheme(GUOFENG_MODE);
    store.applyTheme(MANGA_MODE);
    vi.resetModules();
    const reloaded = await import("./themeStore");
    expect(reloaded.lastThemeIdForScheme("light")).toBe(MANGA_MODE);
    expect(reloaded.oppositeThemeId()).toBe(GUOFENG_MODE);
  });

  it("preserves an existing saved scheme on the first toggle", () => {
    storage.set("octiq.theme", GUOFENG_MODE);
    store.applyTheme(store.oppositeThemeId());
    expect(store.savedThemeId()).toBe(LIGHT_MODE);
    expect(store.oppositeThemeId()).toBe(GUOFENG_MODE);
  });

  it("ignores retired or wrong-scheme history", () => {
    storage.set("octiq.theme.last-light", "retired");
    storage.set("octiq.theme.last-dark", MANGA_MODE);
    expect(store.lastThemeIdForScheme("light")).toBe(LIGHT_MODE);
    expect(store.lastThemeIdForScheme("dark")).toBe(DARK_MODE);
  });

  it("still applies the palette and announces the change when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); },
    });
    expect(() => store.applyTheme(MANGA_MODE)).not.toThrow();
    expect(attributes.get("data-theme")).toBe(MANGA_MODE);
    expect(dispatch.mock.calls.at(-1)?.[0].type).toBe(THEME_EVENT);
  });

  it("toggles twice and preserves this visit's scheme history when storage writes exceed quota", () => {
    storage.set("octiq.theme", GUOFENG_MODE);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: () => { throw new DOMException("Full", "QuotaExceededError"); },
    });
    store.applyTheme(MANGA_MODE);
    store.applyTheme(store.oppositeThemeId());
    expect(attributes.get("data-theme")).toBe(GUOFENG_MODE);
    store.applyTheme(store.oppositeThemeId());
    expect(attributes.get("data-theme")).toBe(MANGA_MODE);
    expect(store.currentThemeId()).toBe(MANGA_MODE);
    expect(dispatch.mock.calls.at(-1)?.[0].detail).toBe(MANGA_MODE);
    expect(store.lastThemeIdForScheme("dark")).toBe(GUOFENG_MODE);
    expect(store.lastThemeIdForScheme("light")).toBe(MANGA_MODE);
    expect(storage.get("octiq.theme")).toBe(GUOFENG_MODE);
  });

  it("can switch both ways when storage reads and writes are blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    store.applyTheme(MANGA_MODE);
    store.applyTheme(store.oppositeThemeId());
    expect(attributes.get("data-color-scheme")).toBe("dark");
    store.applyTheme(store.oppositeThemeId());
    expect(attributes.get("data-theme")).toBe(MANGA_MODE);
  });

  it("migrates retired theme ids to a supported mode", () => {
    storage.set("octiq.theme", "one-light");
    expect(store.savedThemeId()).toBe(LIGHT_MODE);
    storage.set("octiq.theme", "candyland");
    expect(store.savedThemeId()).toBe(FUN_MODE);
    storage.set("octiq.theme", "comic");
    expect(store.savedThemeId()).toBe(MANGA_MODE);
    storage.set("octiq.theme", "sage");
    expect(store.savedThemeId()).toBe(DARK_MODE);
  });
});

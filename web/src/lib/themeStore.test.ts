import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGED } from "./theme";
import { applyTheme, BUILT_IN, CYBERPUNK_MODE, DARK_MODE, FUN_MODE, GUOFENG_MODE, LIGHT_MODE, MANGA_MODE, savedThemeId, THEME_EVENT, THEMES, XP_MODE } from "./themeStore";

describe("appearance switching", () => {
  let properties: Map<string, string>;
  let attributes: Map<string, string>;
  let storage: Map<string, string>;
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
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
    applyTheme(LIGHT_MODE);
    expect(attributes.get("data-color-scheme")).toBe("light");
    expect(savedThemeId()).toBe(LIGHT_MODE);
    expect(properties.get("--bg-0")).toBe("#f7f7f7");
    applyTheme(BUILT_IN);
    expect(attributes.get("data-color-scheme")).toBe("dark");
    expect(attributes.has("data-theme")).toBe(false);
    for (const property of MANAGED) expect(properties.has(property)).toBe(false);
    expect(savedThemeId()).toBe(BUILT_IN);
    expect(dispatch.mock.calls.at(-1)?.[0].type).toBe(THEME_EVENT);
  });

  it("returns native controls to dark when choosing fun mode", () => {
    applyTheme(LIGHT_MODE);
    applyTheme(FUN_MODE);
    expect(attributes.get("data-color-scheme")).toBe("dark");
    expect(attributes.get("data-theme")).toBe(FUN_MODE);
    expect(properties.get("--bg-0")).not.toBe("#f7f7f7");
    expect(savedThemeId()).toBe(FUN_MODE);
  });

  it("puts manga on as a light mode with hand-cut corners", () => {
    applyTheme(MANGA_MODE);
    expect(attributes.get("data-color-scheme")).toBe("light");
    expect(attributes.get("data-theme")).toBe(MANGA_MODE);
    // Uneven corners named by the palette, not scaled from `--radius`.
    expect(properties.get("--r-md")).toBe("4px 2px 5px 2px");
    expect(savedThemeId()).toBe(MANGA_MODE);
  });

  it("puts 中国风 on as a dark mode with the gold accent", () => {
    applyTheme(GUOFENG_MODE);
    expect(attributes.get("data-color-scheme")).toBe("dark");
    expect(attributes.get("data-theme")).toBe(GUOFENG_MODE);
    // Gold, not cinnabar: the accent is also drawn as text.
    expect(properties.get("--accent")).toBe("#c9a45c");
    expect(savedThemeId()).toBe(GUOFENG_MODE);
  });

  it("puts Windows XP on as a light mode with Luna's blue accent", () => {
    applyTheme(XP_MODE);
    expect(attributes.get("data-color-scheme")).toBe("light");
    expect(attributes.get("data-theme")).toBe(XP_MODE);
    expect(properties.get("--accent")).toBe("#0054e3");
    // A decision is its own steel blue, never the accent.
    expect(properties.get("--decide")).toBe("#1a6a8a");
    expect(savedThemeId()).toBe(XP_MODE);
  });

  it("puts Cyberpunk on as a dark mode with the neon cyan accent", () => {
    applyTheme(CYBERPUNK_MODE);
    expect(attributes.get("data-color-scheme")).toBe("dark");
    expect(attributes.get("data-theme")).toBe(CYBERPUNK_MODE);
    // Cyan, not the magenta: the accent is also drawn as text.
    expect(properties.get("--accent")).toBe("#29e3f5");
    // A decision is its own electric blue, never the accent.
    expect(properties.get("--decide")).toBe("#6fb6ff");
    expect(savedThemeId()).toBe(CYBERPUNK_MODE);
  });

  it("only exposes light, dark, fun, manga, 中国风, Windows XP and Cyberpunk", () => {
    expect(THEMES.map(({ id }) => id)).toEqual([LIGHT_MODE, DARK_MODE, FUN_MODE, MANGA_MODE, GUOFENG_MODE, XP_MODE, CYBERPUNK_MODE]);
  });

  it("migrates retired theme ids to a supported mode", () => {
    storage.set("octiq.theme", "one-light");
    expect(savedThemeId()).toBe(LIGHT_MODE);
    storage.set("octiq.theme", "candyland");
    expect(savedThemeId()).toBe(FUN_MODE);
    storage.set("octiq.theme", "comic");
    expect(savedThemeId()).toBe(MANGA_MODE);
    storage.set("octiq.theme", "sage");
    expect(savedThemeId()).toBe(DARK_MODE);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGED } from "./theme";
import { applyTheme, BUILT_IN, savedThemeId, THEME_EVENT } from "./themeStore";

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
    applyTheme("one-light");
    expect(attributes.get("data-color-scheme")).toBe("light");
    expect(savedThemeId()).toBe("one-light");
    expect(properties.get("--bg-0")).toBe("#f7f7f7");
    applyTheme(BUILT_IN);
    expect(attributes.get("data-color-scheme")).toBe("dark");
    expect(attributes.has("data-theme")).toBe(false);
    for (const property of MANAGED) expect(properties.has(property)).toBe(false);
    expect(savedThemeId()).toBe(BUILT_IN);
    expect(dispatch.mock.calls.at(-1)?.[0].type).toBe(THEME_EVENT);
  });

  it("returns native controls to dark when choosing an existing custom palette", () => {
    applyTheme("one-light");
    applyTheme("sage");
    expect(attributes.get("data-color-scheme")).toBe("dark");
    expect(attributes.get("data-theme")).toBe("sage");
    expect(properties.get("--bg-0")).not.toBe("#f7f7f7");
    expect(savedThemeId()).toBe("sage");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { THEMES } from "../lib/themeStore";
import { AppearanceToggle } from "./AppearanceToggle";

afterEach(() => vi.unstubAllGlobals());

function render(id: string) {
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === "octiq.theme" ? id : null });
  return renderToStaticMarkup(<AppearanceToggle />);
}

describe("AppearanceToggle", () => {
  it.each(THEMES)("reflects $name's scheme with a stable accessible switch label", ({ id, scheme }) => {
    const html = render(id);
    expect(html).toContain('type="button" role="switch" aria-label="Dark mode"');
    expect(html).toContain(`aria-checked="${scheme === "dark"}"`);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("tabindex=");
  });

  it("re-lights different bitmaps over the same 81 physical LEDs", () => {
    const moon = render("dark").match(/<circle[^>]+>/g)!;
    const sun = render("light").match(/<circle[^>]+>/g)!;
    expect(moon).toHaveLength(81);
    expect(sun).toHaveLength(81);
    expect(moon.map((dot) => /data-lit="(true|false)"/.exec(dot)![1]))
      .not.toEqual(sun.map((dot) => /data-lit="(true|false)"/.exec(dot)![1]));
    // Position, radius and stagger are preserved, only the lit state changes.
    const grid = (dots: string[]) => dots.map((dot) => dot.replace(/data-lit="(true|false)"/, ""));
    expect(grid(moon)).toEqual(grid(sun));
    for (const dots of [moon, sun]) {
      expect(dots.some((dot) => dot.includes('data-lit="false"'))).toBe(true);
      expect(dots.some((dot) => dot.includes('data-lit="true"'))).toBe(true);
    }
  });
});

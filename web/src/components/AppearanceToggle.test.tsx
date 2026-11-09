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

  it("draws a horizontally symmetric filled crescent clear of its sparkle", () => {
    const pixels = render("dark").match(/<circle[^>]+>/g)!
      .map(dot => dot.includes('data-lit="true"'));
    const lit = (row: number, column: number) => pixels[row * 9 + column];
    for (let row = 0; row < 9; row++) {
      for (let column = 0; column < 6; column++) {
        expect(lit(row, column)).toBe(lit(8 - row, column));
      }
      expect(lit(row, 5)).toBe(false); // A dark column separates moon and star.
    }
    expect([0, 1, 2, 3].every(column => lit(3, column))).toBe(true);
    expect(lit(4, 3)).toBe(false); // The inner bite.
    expect(lit(1, 7) && lit(0, 7) && lit(2, 7) && lit(1, 6) && lit(1, 8)).toBe(true);
  });
});

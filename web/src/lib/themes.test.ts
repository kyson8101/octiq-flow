// Every real theme file, put through the real mapping.
//
// `theme.test.ts` covers the maths on hand-written tokens. This covers the
// thing that maths is pointless without: that the CSS files on disk actually
// reach it. Those are two different failures, and the second one is silent.
//
// It is the guard for a trap the repo has already fallen into once. `?raw`
// imports come back as an empty string unless `vite.config.ts` sets
// `test: { css: true }` — at which point every theme parses to nothing, every
// token falls back to a default, and the app still runs, still switches themes,
// and shows the same colours for all of them. Nothing throws. A test that only
// exercised `mapTokens` on a literal would pass throughout.
//
// So this asserts against the files themselves, and the assertions are the
// promises `theme.ts` makes to the rest of the app rather than any particular
// palette — a new theme has to keep them, but is free to look like anything.
import { describe, expect, it } from "vitest";

import { MANAGED, mapTokens, parseOklch } from "./theme";
import { BUILT_IN, preview, THEMES } from "./themeStore";

/** Every theme except the built-in, which deliberately has no tokens: it is
 *  applied by REMOVING overrides, so there is nothing here to check. */
const PASTED = THEMES.filter((t) => t.id !== BUILT_IN);

describe("the theme files on disk", () => {
  it("ships every theme the store lists", () => {
    // A floor, not the exact count, so adding one is not a test edit. It is
    // here to catch the whole set vanishing — an import path typo takes the
    // lot, and an empty list looks exactly like "no themes yet".
    expect(PASTED.length).toBeGreaterThanOrEqual(20);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  it.each(PASTED.map((t) => [t.id, t] as const))("%s parses to real tokens", (_id, theme) => {
    // The `css: true` trap: an empty parse leaves this object empty and every
    // colour below silently becomes a default.
    expect(Object.keys(theme.dark ?? {}).length).toBeGreaterThan(10);
  });

  it.each(PASTED.map((t) => [t.id, t] as const))("%s sets every managed variable", (_id, theme) => {
    const mapped = mapTokens(theme.dark!);
    for (const name of MANAGED) {
      expect(mapped[name], `${name} is missing`).toBeTruthy();
    }
  });

  it.each(PASTED.map((t) => [t.id, t] as const))("%s has a real surface ladder", (_id, theme) => {
    // `--bg-2` is a `color-mix()` the browser resolves, so only the two raw
    // ends can be compared here. Equal ones mean a flat UI: a panel over a
    // background with no edge between them.
    const t = mapTokens(theme.dark!);
    expect(t["--bg-0"]).not.toBe(t["--bg-1"]);
  });

  it.each(PASTED.map((t) => [t.id, t] as const))("%s can be read on its accent", (_id, theme) => {
    // The trap this exists for: a theme's accent can be a pale yellow, and the
    // label drawn on it is `--accent-fg`, not white. If the two are close, the
    // text on every primary button disappears.
    const t = mapTokens(theme.dark!);
    const fill = parseOklch(t["--accent"]);
    const label = parseOklch(t["--accent-fg"]);
    if (!fill || !label) return; // not oklch: nothing to compare, not a failure
    expect(Math.abs(fill.l - label.l)).toBeGreaterThan(0.3);
  });

  it.each(PASTED.map((t) => [t.id, t] as const))("%s gives a tile five colours", (_id, theme) => {
    // What the chooser draws. A blank swatch is how a broken theme looks in the
    // one place someone would pick it from.
    const p = preview(theme);
    for (const [name, value] of Object.entries(p)) {
      expect(value, `${name} is blank`).toBeTruthy();
    }
    expect(p.bg).not.toBe(p.card);
  });

  it.each(PASTED.map((t) => [t.id, t] as const))("%s means the same by green and amber", (_id, theme) => {
    // `--ok` and `--warn` carry MEANING — a clean repo, a dropped connection —
    // so they cannot drift to whatever the theme fancied. `semanticColor`
    // invents one at the right hue when the theme has no green of its own
    // (Bubblegum has none), so this holds for every theme either way.
    const t = mapTokens(theme.dark!);
    const ok = parseOklch(t["--ok"]);
    const warn = parseOklch(t["--warn"]);
    if (ok) expect(hueGap(ok.h, 145), `--ok is at hue ${ok.h}`).toBeLessThanOrEqual(35);
    if (warn) expect(hueGap(warn.h, 85), `--warn is at hue ${warn.h}`).toBeLessThanOrEqual(35);
  });
});

function hueGap(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}

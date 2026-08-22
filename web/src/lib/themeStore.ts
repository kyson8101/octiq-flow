// The list of themes, and the one function that puts one on the screen.
//
// Split from `theme.ts` on purpose: everything in there is pure and tested in
// a node runner with no DOM. Everything that touches `document` is here.
import { MANAGED, mapTokens, parseThemeCss, type Theme } from "./theme";

import candyland from "./themes/candyland.css?raw";
import bubblegum from "./themes/bubblegum.css?raw";
import mono from "./themes/mono.css?raw";

/** Adding a theme is two steps: drop the pasted file in `themes/`, add a line
 *  here. Nothing else in the app needs to know it exists. */
const PASTED: Array<{ id: string; name: string; css: string }> = [
  { id: "candyland", name: "Candyland", css: candyland },
  { id: "bubblegum", name: "Bubblegum", css: bubblegum },
  { id: "mono", name: "Mono", css: mono },
];

/** The built-in theme has no tokens because it does not need any: it is what
 *  `styles.css` already says. Choosing it CLEARS the overrides rather than
 *  setting a copy of the defaults, so the stylesheet stays the one truth. */
export const BUILT_IN = "octiq";

export const THEMES: Theme[] = [
  { id: BUILT_IN, name: "OctiqFlow" },
  ...PASTED.map(({ id, name, css }) => ({ id, name, dark: parseThemeCss(css).dark })),
];

/** The five colours a tile needs to show what a theme looks like without
 *  applying it. Taken from the same mapping the real thing uses, so a tile
 *  cannot promise a colour the app then does not show. */
export type Preview = { bg: string; sunken: string; card: string; accent: string; fg: string };

/** Mirrors the `:root` block of `styles.css`. The built-in theme is the ONLY
 *  one that has to be written out twice: it is applied by removing overrides,
 *  so there is nothing to read the swatches back off. Keep in step with the
 *  stylesheet if those four values ever change. */
const BUILT_IN_PREVIEW: Preview = {
  bg: "#1c1c1e",
  sunken: "#232325",
  card: "#2c2c2e",
  accent: "#0a84ff",
  fg: "#f5f5f7",
};

export function preview(theme: Theme): Preview {
  if (!theme.dark) return BUILT_IN_PREVIEW;
  const t = mapTokens(theme.dark);
  return {
    bg: t["--bg-0"],
    sunken: t["--bg-sunken"],
    card: t["--bg-1"],
    accent: t["--accent"],
    fg: t["--fg-0"],
  };
}

const KEY = "octiq.theme";

/** Fired after the variables change, for the parts of the app that draw with
 *  real colour values instead of CSS variables — the terminal, chiefly, since
 *  xterm hands its palette to WebGL and cannot read a `var()`. */
export const THEME_EVENT = "octiq-theme";

export function savedThemeId(): string {
  try {
    return localStorage.getItem(KEY) || BUILT_IN;
  } catch {
    return BUILT_IN;
  }
}

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Put a theme on the screen and remember it. */
export function applyTheme(id: string): void {
  const theme = themeById(id);
  const root = document.documentElement;

  if (!theme.dark) {
    // Back to the built-in: remove, do not overwrite.
    for (const name of MANAGED) root.style.removeProperty(name);
    root.removeAttribute("data-theme");
  } else {
    for (const [name, value] of Object.entries(mapTokens(theme.dark))) {
      root.style.setProperty(name, value);
    }
    root.setAttribute("data-theme", theme.id);
  }
  // `color-scheme` is not touched: `styles.css` sets it to dark once, and a
  // theme cannot change that.

  try {
    localStorage.setItem(KEY, theme.id);
  } catch {
    // A browser with storage blocked still gets the theme, just not next time.
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme.id }));
}

// OctiqFlow has three appearance modes, and one function that puts one on the
// screen. Keep the public ids as plain words because they are persisted.
//
// Split from `theme.ts` on purpose: everything in there is pure and tested in
// a node runner with no DOM. Everything that touches `document` is here.
import { MANAGED, mapTokens, parseThemeCss, type Theme } from "./theme";

import lightCss from "./themes/light.css?raw";
import funCss from "./themes/fun.css?raw";

/** The built-in theme has no tokens because it does not need any: it is what
 *  `design-system.css` already says. Choosing it CLEARS the overrides rather than
 *  setting a copy of the defaults, so the stylesheet stays the one truth. */
export const LIGHT_MODE = "light";
export const DARK_MODE = "dark";
export const FUN_MODE = "fun";
/** Kept as an alias for callers that need to clear palette overrides. */
export const BUILT_IN = DARK_MODE;

export const THEMES: Theme[] = [
  { id: LIGHT_MODE, name: "Light", scheme: "light", tokens: parseThemeCss(lightCss).light },
  { id: DARK_MODE, name: "Dark", scheme: "dark" },
  { id: FUN_MODE, name: "Fun", scheme: "dark", tokens: parseThemeCss(funCss).dark },
];

/** The five colours a tile needs to show what a theme looks like without
 *  applying it. Taken from the same mapping the real thing uses, so a tile
 *  cannot promise a colour the app then does not show. */
export type Preview = { bg: string; sunken: string; card: string; accent: string; fg: string };

/** Mirrors the `:root` block of `design-system.css`. The built-in theme is the ONLY
 *  one that has to be written out twice: it is applied by removing overrides,
 *  so there is nothing to read the swatches back off. Keep in step with the
 *  stylesheet if those four values ever change. */
const BUILT_IN_PREVIEW: Preview = {
  bg: "#101010",
  sunken: "#141414",
  card: "#1b1b1b",
  accent: "#f5f5f5",
  fg: "#fafafa",
};

export function preview(theme: Theme): Preview {
  if (!theme.tokens) return BUILT_IN_PREVIEW;
  const t = mapTokens(theme.tokens);
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
    const saved = localStorage.getItem(KEY);
    if (saved === LIGHT_MODE || saved === "one-light") return LIGHT_MODE;
    if (saved === FUN_MODE || saved === "candyland") return FUN_MODE;
    if (saved === DARK_MODE || saved === "octiq") return DARK_MODE;
    // Retired custom themes return to the calm default.
    return DARK_MODE;
  } catch {
    return DARK_MODE;
  }
}

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DARK_MODE)!;
}

/** Put a theme on the screen and remember it. */
export function applyTheme(id: string): void {
  const theme = themeById(id);
  const root = document.documentElement;

  if (!theme.tokens) {
    // Back to the built-in: remove, do not overwrite.
    for (const name of MANAGED) root.style.removeProperty(name);
    root.removeAttribute("data-theme");
  } else {
    for (const [name, value] of Object.entries(mapTokens(theme.tokens))) {
      root.style.setProperty(name, value);
    }
    root.setAttribute("data-theme", theme.id);
  }
  root.setAttribute("data-color-scheme", theme.scheme);

  try {
    localStorage.setItem(KEY, theme.id);
  } catch {
    // A browser with storage blocked still gets the theme, just not next time.
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme.id }));
}

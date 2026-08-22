// The theme chooser's engine.
//
// Themes are authored elsewhere — tweakcn, shadcn — and pasted in VERBATIM as
// `themes/<id>.css`. That format is not ours: it names `--primary`, `--card`,
// `--muted-foreground`, and it assumes Tailwind is reading them. OctiqFlow has
// no Tailwind. It has one stylesheet and its own token names (`--bg-0`,
// `--fg-1`, `--accent`, …) used in 800-odd places.
//
// So this file is a TRANSLATOR, and that is the whole trick: keep the pasted
// file untouched so re-pasting an updated theme is a straight overwrite, and
// do the renaming here, once, where it can be tested.
//
// What a theme is NOT allowed to change:
//   * the fonts. A theme naming Poppins and Fira Code would need those font
//     files shipped, and the terminal draws Menlo — code in the chat and code
//     in the terminal have to be the same shapes.
//   * the drop shadow. The pasted shadows are built for small light cards
//     (`3px 3px 0px`); on a full-height dark popover they read as a mistake.

/** A theme's tokens, under the names the pasted file uses. */
export type Tokens = Record<string, string>;

export type Theme = {
  id: string;
  name: string;
  /** The pasted file's `.dark` block. Missing for the built-in theme: it IS
   *  the stylesheet, so there is nothing to apply. */
  dark?: Tokens;
};

/* ---- Reading the pasted file ------------------------------------------ */

/** Pull one `<selector> { … }` block's custom properties out of pasted CSS.
 *
 *  Deliberately not a real CSS parser. The pasted files are machine-generated
 *  and always the same shape, and a regex that only ever sees `--x: y;` lines
 *  cannot be tripped by the Tailwind directives around them — which is why
 *  those directives can stay in the file. */
function block(css: string, selector: string): Tokens {
  // Comments go first. A pasted file can say the word `:root` in its header —
  // this file's own headers do — and a plain `indexOf` would happily parse the
  // sentence about the block instead of the block.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

  // The selector has to be followed by its own brace to count. Custom-property
  // values never contain braces, so everything up to the first `}` is the body.
  const at = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(code);
  if (!at) return {};

  const out: Tokens = {};
  for (const line of at[1].split(";")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (!name.startsWith("--")) continue;
    out[name.slice(2)] = line.slice(colon + 1).trim();
  }
  return out;
}

/** Both blocks, because that is the shape of the file. Only `.dark` is ever
 *  applied: OctiqFlow is a dark app, and the `:root` half of a pasted theme is
 *  read only so the parser can be checked against the real format. */
export function parseThemeCss(css: string): { light: Tokens; dark: Tokens } {
  return { light: block(css, ":root"), dark: block(css, ".dark") };
}

/* ---- Colour maths ------------------------------------------------------ */

export type Oklch = { l: number; c: number; h: number };

/** `oklch(0.62 0.18 348.14)` → its three numbers. Anything else → null.
 *
 *  Only oklch is understood, and only because that is what every pasted theme
 *  uses for the colours this file has to REASON about (hue, lightness). Colours
 *  it only has to pass through — hsl, hex — never come here. */
export function parseOklch(value: string): Oklch | null {
  const m = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/i.exec(value.trim());
  if (!m) return null;
  const l = m[1].endsWith("%") ? Number(m[1].slice(0, -1)) / 100 : Number(m[1]);
  const [c, h] = [Number(m[2]), Number(m[3])];
  if ([l, c, h].some(Number.isNaN)) return null;
  return { l, c, h };
}

/** Shortest way round the colour wheel between two hues, in degrees. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(d, 360 - d);
}

/** Green and amber carry MEANING here — a clean repo, a dropped connection —
 *  so they cannot be whatever the theme happened to pick. This looks through
 *  the theme's own chart colours for one already at the right hue, and only
 *  invents one when the theme has nothing close.
 *
 *  Bubblegum is exactly why: its five chart colours are pinks and blues, no
 *  green anywhere. Taking "the greenest of them" would put a blue where the
 *  user is being told something is fine. */
export function semanticColor(t: Tokens, hue: number, tolerance = 35): string {
  let best: { key: string; gap: number } | null = null;
  for (const key of ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"]) {
    const parsed = t[key] ? parseOklch(t[key]) : null;
    // A near-grey has no hue worth trusting, whatever number it reports.
    if (!parsed || parsed.c < 0.05) continue;
    const gap = hueGap(parsed.h, hue);
    if (gap <= tolerance && (!best || gap < best.gap)) best = { key, gap };
  }
  if (best) return t[best.key];

  // Nothing close. Borrow the theme's own lightness and saturation — that is
  // what makes it look like it belongs — and put them at the hue that means
  // what we need it to mean.
  const ref = (t["primary"] ? parseOklch(t["primary"]) : null) ?? { l: 0.72, c: 0.16, h: 0 };
  const l = Math.min(0.85, Math.max(0.55, ref.l));
  const c = Math.min(0.2, Math.max(0.12, ref.c));
  return `oklch(${l.toFixed(4)} ${c.toFixed(4)} ${hue})`;
}

/** A CSS length in rem/px/em → px. `--radius` is the only caller. */
export function toPx(value: string, fallback: number): number {
  const m = /^([\d.]+)(rem|em|px)?$/.exec(value.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  if (Number.isNaN(n)) return fallback;
  return m[2] === "rem" || m[2] === "em" ? n * 16 : n;
}

/** Blend two colours in the perceptual space, as a CSS value the browser
 *  computes. Written out with literal colours rather than `var()` so the
 *  result does not depend on what else has already been set. */
const mix = (a: string, pct: number, b: string) =>
  `color-mix(in oklab, ${a} ${pct}%, ${b})`;

/* ---- The translation --------------------------------------------------- */

/** Turn one pasted block into the variables the stylesheet actually reads.
 *
 *  Note `--accent` comes from `primary`, NOT from the pasted `accent`. They
 *  are false friends: shadcn's `accent` is a quiet hover tint, while ours is
 *  the loud one thing on screen you are meant to press. `primary` is that. */
export function mapTokens(t: Tokens): Record<string, string> {
  const bg = t["background"] ?? "#1c1c1e";
  const fg = t["foreground"] ?? "#f5f5f7";
  const card = t["card"] ?? bg;
  const primary = t["primary"] ?? "#0a84ff";
  const border = t["border"] ?? mix(fg, 20, bg);
  const dim = t["muted-foreground"] ?? mix(fg, 60, bg);
  const radius = toPx(t["radius"] ?? "0.5rem", 8);
  const gap = Math.min(2, radius);

  return {
    "--bg-0": bg,
    "--bg-1": card,
    // One step further from the background than the card is, always — the
    // pasted `muted` is sometimes DARKER than the card (Bubblegum), which
    // would fold the three-step ladder flat.
    "--bg-2": mix(card, 84, fg),
    // Ours is the top bar and the sidebar, which is what theirs names too.
    "--bg-sunken": t["sidebar"] ?? mix(bg, 92, fg),

    "--fg-0": fg,
    "--fg-1": mix(fg, 86, bg),
    "--fg-2": dim,
    "--fg-3": mix(dim, 55, bg),

    "--border": border,
    "--border-strong": mix(border, 72, fg),

    "--accent": primary,
    "--accent-fg": t["primary-foreground"] ?? "#fff",
    "--accent-tint": mix(primary, 18, "transparent"),

    "--ok": semanticColor(t, 145),
    "--warn": semanticColor(t, 85),
    "--danger": t["destructive"] ?? "#ff453a",
    "--danger-fg": t["destructive-foreground"] ?? "#fff",

    // Three rungs a fixed gap apart — but the gap can never be wider than the
    // radius itself, so a theme asking for 0 gets 0 on all three. Adding a
    // flat 2px/6px used to leave Brutalism and Neon quietly rounded, which is
    // the one thing a square-cornered theme is FOR.
    "--r-sm": `${radius - gap}px`,
    "--r-md": `${radius + gap}px`,
    "--r-lg": `${radius + gap * 3}px`,
  };
}

/** Every variable this file ever sets — the list `clear` needs so switching
 *  back to the built-in theme leaves nothing of the old one behind. */
export const MANAGED = Object.keys(mapTokens({}));

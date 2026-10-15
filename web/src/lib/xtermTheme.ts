// The terminal's palette, taken from whatever theme is on.
//
// xterm hands its colours to WebGL, so it needs real values — it cannot be
// given `var(--bg-0)` and left to work it out. And the theme engine writes
// several tokens as `color-mix(…)`, which only the browser can evaluate.
//
// So the browser is asked. A hidden element is given each value as its `color`
// and its computed style read back, which turns anything CSS understands into
// a plain `rgb(…)`. It costs one style recalculation per colour and happens
// only when the theme changes.

/** Resolve CSS colour values — vars, `color-mix`, hex — to `rgb(…)`.
 *
 *  Two steps, and the second one is not optional. Reading the computed style
 *  resolves the vars and the mixes, but it hands back the value in whatever
 *  space it was written: `oklab(0.39 -0.01 -0.02)`. xterm parses `#rgb`,
 *  `rgb()` and `rgba()` and nothing else, so that string is not a colour to it.
 *  Painting one pixel and reading it back is the browser's own conversion, and
 *  it keeps the alpha the selection colour depends on. */
function resolve(values: string[]): string[] {
  // One probe per value, all in the page before any is read. One probe whose
  // `color` was set to each value in turn read back stale in Chrome 155: every
  // `var()` after the first answered the first's colour, so the terminal drew
  // its text in its own background colour and only the fixed hex colours
  // (magenta, cyan) could be seen, in every mode.
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;left:-9999px;top:0;width:0;height:0;overflow:hidden";
  const probes = values.map((value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    box.appendChild(probe);
    return probe;
  });
  document.body.appendChild(box);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // `copy` rather than the default: the pixel must BE the colour, not the
  // colour composited over what was already there, or every semi-transparent
  // value comes back opaque.
  if (ctx) ctx.globalCompositeOperation = "copy";

  try {
    return probes.map((probe) => {
      const resolved = getComputedStyle(probe).color;
      if (!ctx) return resolved;
      ctx.fillStyle = resolved;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 255
        ? `rgb(${r}, ${g}, ${b})`
        : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
    });
  } finally {
    box.remove();
  }
}

/** Lift a colour towards the foreground — how the bright ANSI half is made,
 *  rather than shipping a second hand-picked palette per theme. */
const bright = (v: string) => `color-mix(in oklab, ${v} 78%, var(--fg-0))`;

export function xtermTheme() {
  const [
    background, foreground, cursor, selectionBackground,
    black, brightBlack, white, brightWhite,
    red, green, yellow, blue,
    brightRed, brightGreen, brightYellow, brightBlue,
  ] = resolve([
    "var(--bg-0)",
    "var(--fg-1)",
    "var(--fg-0)",
    "color-mix(in oklab, var(--accent) 35%, transparent)",

    // The greys come off the app's own surface ladder, so a shell and the
    // panel around it are lit the same way.
    "var(--bg-2)",
    "var(--fg-3)",
    "var(--fg-1)",
    "var(--fg-0)",

    // The four that MEAN something — an error, a pass, a warning, a link —
    // are the app's own, so red in the terminal is red in the git panel.
    "var(--danger)",
    "var(--ok)",
    "var(--warn)",
    "var(--link)",

    bright("var(--danger)"),
    bright("var(--ok)"),
    bright("var(--warn)"),
    bright("var(--link)"),
  ]);

  return {
    background, foreground, cursor, selectionBackground,
    black, red, green, yellow, blue, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightWhite,
    // Magenta and cyan are the two ANSI colours the app has no opinion about —
    // nothing in the UI means either — so they are left as they were rather
    // than invented from a token that does not fit them. A light mode gets
    // the deeper pair: the dark pair's cyan is under 2:1 on white.
    ...(document.documentElement.getAttribute("data-color-scheme") === "light" ? LIGHT_PAIR : DARK_PAIR),
  };
}

const DARK_PAIR = { magenta: "#bf5af2", cyan: "#64d2ff", brightMagenta: "#da8fff", brightCyan: "#8be9ff" };
const LIGHT_PAIR = { magenta: "#9a32c8", cyan: "#0a7491", brightMagenta: "#b046e0", brightCyan: "#0b87a8" };

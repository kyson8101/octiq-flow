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
  const probe = document.createElement("span");
  probe.style.cssText = "position:fixed;left:-9999px;top:0;width:0;height:0";
  document.body.appendChild(probe);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // `copy` rather than the default: the pixel must BE the colour, not the
  // colour composited over what was already there, or every semi-transparent
  // value comes back opaque.
  if (ctx) ctx.globalCompositeOperation = "copy";

  try {
    return values.map((value) => {
      probe.style.color = value;
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
    probe.remove();
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
    "var(--accent)",

    bright("var(--danger)"),
    bright("var(--ok)"),
    bright("var(--warn)"),
    bright("var(--accent)"),
  ]);

  return {
    background, foreground, cursor, selectionBackground,
    black, red, green, yellow, blue, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightWhite,
    // Magenta and cyan are the two ANSI colours the app has no opinion about —
    // nothing in the UI means either — so they are left as they were rather
    // than invented from a token that does not fit them.
    magenta: "#bf5af2",
    cyan: "#64d2ff",
    brightMagenta: "#da8fff",
    brightCyan: "#8be9ff",
  };
}

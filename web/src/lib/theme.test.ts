import { describe, expect, it } from "vitest";
import funCss from "./themes/fun.css?raw";
import { MANAGED, mapTokens, parseOklch, parseThemeCss, semanticColor, toPx } from "./theme";

const FUN = parseThemeCss(funCss);
const NO_GREEN = {
  background: "oklch(0.22 0.02 260)",
  foreground: "oklch(0.94 0.01 260)",
  card: "oklch(0.29 0.02 260)",
  primary: "oklch(0.8 0.15 90)",
  "primary-foreground": "oklch(0.15 0.02 90)",
  accent: "oklch(0.35 0.05 260)",
  muted: "oklch(0.27 0.02 260)",
  "muted-foreground": "oklch(0.7 0.02 260)",
  sidebar: "oklch(0.24 0.02 260)",
  destructive: "oklch(0.64 0.2 25)",
  "destructive-foreground": "oklch(0.98 0.01 25)",
  "chart-1": "oklch(0.72 0.18 201)",
  "chart-2": "oklch(0.72 0.18 4)",
  "chart-3": "oklch(0.72 0.18 357)",
  "chart-4": "oklch(0.72 0.18 217)",
  "chart-5": "oklch(0.72 0.18 256)",
  radius: "0.4rem",
};
const MONO = {
  primary: "oklch(0.5555 0 0)",
  "chart-1": "oklch(0.5 0 0)",
  "chart-2": "oklch(0.55 0 0)",
  "chart-3": "oklch(0.6 0 0)",
  "chart-4": "oklch(0.65 0 0)",
  "chart-5": "oklch(0.7 0 0)",
  radius: "0",
};

describe("parseThemeCss", () => {
  it("reads both blocks out of a palette file", () => {
    expect(FUN.light["background"]).toBe("oklch(0.9809 0.0025 228.7836)");
    expect(FUN.dark["background"]).toBe("oklch(0.2303 0.0125 264.2926)");
  });

  it("keeps values that contain spaces and commas whole", () => {
    const parsed = parseThemeCss(":root { --font-sans: Inter, sans-serif; --shadow: 0 1px 2px rgb(0 0 0 / 20%); }");
    expect(parsed.light["font-sans"]).toBe("Inter, sans-serif");
    expect(parsed.light.shadow).toBe("0 1px 2px rgb(0 0 0 / 20%)");
  });

  it("returns empty blocks rather than throwing on a file with neither", () => {
    expect(parseThemeCss("/* nothing here */")).toEqual({ light: {}, dark: {} });
  });
});

describe("parseOklch", () => {
  it("reads the three numbers", () => {
    expect(parseOklch("oklch(0.6209 0.1801 348.1385)")).toEqual({
      l: 0.6209,
      c: 0.1801,
      h: 348.1385,
    });
  });

  it("accepts a percentage lightness", () => {
    expect(parseOklch("oklch(62% 0.18 348)")?.l).toBeCloseTo(0.62);
  });

  it("gives up on anything that is not oklch", () => {
    expect(parseOklch("#ff453a")).toBeNull();
    expect(parseOklch("hsl(325 58% 57%)")).toBeNull();
  });
});

describe("semanticColor", () => {
  it("uses the theme's own green when it has one", () => {
    // Fun's chart-2 is oklch(… 142.85) — already green.
    expect(semanticColor(FUN.dark, 145)).toBe("oklch(0.7395 0.2268 142.8504)");
  });

  it("invents a green when every chart colour is pink and blue", () => {
    // These five chart colours run 201°, 4°, 357°, 217°, 256°. Picking
    // the nearest would put a BLUE where the user is told something is fine.
    const ok = semanticColor(NO_GREEN, 145);
    expect(parseOklch(ok)?.h).toBe(145);
  });

  it("keeps the theme's own lightness and saturation when it invents one", () => {
    const ok = parseOklch(semanticColor(NO_GREEN, 145))!;
    const primary = parseOklch(NO_GREEN.primary)!;
    expect(ok.l).toBeCloseTo(Math.min(0.85, primary.l), 2);
    expect(ok.c).toBeGreaterThanOrEqual(0.12);
  });

  it("ignores a near-grey chart colour, whatever hue it claims", () => {
    const greyAt145 = { "chart-1": "oklch(0.5 0.01 145)", primary: "oklch(0.7 0.2 20)" };
    expect(semanticColor(greyAt145, 145)).not.toBe("oklch(0.5 0.01 145)");
  });
});

describe("toPx", () => {
  it("converts rem and passes px through", () => {
    expect(toPx("0.5rem", 8)).toBe(8);
    expect(toPx("0.4rem", 8)).toBeCloseTo(6.4);
    expect(toPx("12px", 8)).toBe(12);
  });

  it("falls back when the value is not a length", () => {
    expect(toPx("wat", 8)).toBe(8);
  });
});

describe("mapTokens", () => {
  it("takes the loud colour from `primary`, not from `accent`", () => {
    // The two names are false friends: shadcn's `accent` is a quiet hover
    // tint, ours is the one thing on screen you are meant to press.
    const out = mapTokens(NO_GREEN);
    expect(out["--accent"]).toBe(NO_GREEN.primary);
    expect(out["--accent"]).not.toBe(NO_GREEN.accent);
  });

  it("builds the raised surface off the card, never off `muted`", () => {
    // `muted` (L .27) is darker than `card` (L .29),
    // so using it would fold bg-0 → bg-1 → bg-2 flat.
    const out = mapTokens(NO_GREEN);
    expect(out["--bg-1"]).toBe(NO_GREEN.card);
    expect(out["--bg-2"]).toContain(NO_GREEN.card);
    expect(out["--bg-2"]).not.toContain(NO_GREEN.muted);
  });

  it("uses the theme's sidebar colour for the top bar", () => {
    expect(mapTokens(NO_GREEN)["--bg-sunken"]).toBe(NO_GREEN.sidebar);
  });

  it("scales the corner radii off the theme's own radius", () => {
    const out = mapTokens(NO_GREEN); // 0.4rem = 6.4px
    expect(out["--r-sm"]).toBe("4.4px");
    expect(out["--r-md"]).toBe("8.4px");
    expect(out["--r-lg"]).toBe("12.4px");
  });

  it("never sets a font or a shadow", () => {
    const out = mapTokens(FUN.dark);
    expect(Object.keys(out)).not.toContain("--font");
    expect(Object.keys(out)).not.toContain("--mono");
    expect(Object.keys(out)).not.toContain("--shadow");
  });

  it("survives a theme that is missing everything", () => {
    const out = mapTokens({});
    expect(out["--bg-0"]).toBeTruthy();
    expect(out["--accent"]).toBeTruthy();
    expect(out["--danger"]).toBeTruthy();
  });

  it("MANAGED lists every variable the app will have to clear", () => {
    expect(MANAGED).toEqual(Object.keys(mapTokens(FUN.dark)));
    expect(MANAGED).toContain("--bg-0");
    expect(MANAGED).toContain("--accent-tint");
  });
});

describe("a file whose own header talks about the blocks", () => {
  // Palette files can carry a header saying which blocks are read. A
  // parser that matched the WORD rather than the block would read the sentence.
  const withComment = `/* the :root and .dark blocks are read */
    :root { --background: white; }
    .dark { --background: black; }`;

  it("reads the blocks, not the sentence about them", () => {
    const parsed = parseThemeCss(withComment);
    expect(parsed.light["background"]).toBe("white");
    expect(parsed.dark["background"]).toBe("black");
  });
});

describe("a palette with no colour in it at all", () => {
  it("still gets a green for ok and an amber for warn", () => {
    // All five of Mono's chart colours are the same grey. Whatever the app
    // says is FINE has to still look fine, and what needs attention amber.
    expect(parseOklch(semanticColor(MONO, 145))?.h).toBe(145);
    expect(parseOklch(semanticColor(MONO, 85))?.h).toBe(85);
  });

  it("gives those invented colours real saturation, not the theme's grey", () => {
    // `primary` is oklch(0.5555 0 0) — zero chroma. Borrowing it literally
    // would produce a grey "green".
    expect(parseOklch(semanticColor(MONO, 145))!.c).toBeGreaterThanOrEqual(0.12);
  });

  it("gives a zero-radius theme genuinely square corners", () => {
    expect(mapTokens(MONO)["--r-sm"]).toBe("0px");
    expect(mapTokens(MONO)["--r-md"]).toBe("0px");
    expect(mapTokens(MONO)["--r-lg"]).toBe("0px");
  });
});

describe("text that sits on a coloured fill", () => {
  it("takes its own colour from the theme, not a hardcoded white", () => {
    // This `primary` is a pale yellow. White on it would be unreadable,
    // and every primary button in the app used to be white on the accent.
    const out = mapTokens(NO_GREEN);
    expect(out["--accent-fg"]).toBe(NO_GREEN["primary-foreground"]);
    expect(out["--danger-fg"]).toBe(NO_GREEN["destructive-foreground"]);
  });

  it("falls back to white when a theme names neither", () => {
    expect(mapTokens({})["--accent-fg"]).toBe("#fff");
    expect(mapTokens({})["--danger-fg"]).toBe("#fff");
  });
});

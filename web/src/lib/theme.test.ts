import { describe, expect, it } from "vitest";
import candyland from "./themes/candyland.css?raw";
import bubblegum from "./themes/bubblegum.css?raw";
import monoCss from "./themes/mono.css?raw";
import { MANAGED, mapTokens, parseOklch, parseThemeCss, semanticColor, toPx } from "./theme";

const CANDYLAND = parseThemeCss(candyland);
const BUBBLEGUM = parseThemeCss(bubblegum);

describe("parseThemeCss", () => {
  it("reads both blocks out of a pasted file", () => {
    expect(CANDYLAND.light["background"]).toBe("oklch(0.9809 0.0025 228.7836)");
    expect(CANDYLAND.dark["background"]).toBe("oklch(0.2303 0.0125 264.2926)");
  });

  it("keeps values that contain spaces and commas whole", () => {
    expect(BUBBLEGUM.light["shadow-color"]).toBe("hsl(325.78 58.18% 56.86% / 0.5)");
    expect(CANDYLAND.dark["font-sans"]).toBe("Poppins, sans-serif");
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
    // Candyland's chart-2 is oklch(… 142.85) — already green.
    expect(semanticColor(CANDYLAND.dark, 145)).toBe("oklch(0.7395 0.2268 142.8504)");
  });

  it("invents a green when every chart colour is pink and blue", () => {
    // Bubblegum's five chart colours run 201°, 4°, 357°, 217°, 256°. Picking
    // the nearest would put a BLUE where the user is told something is fine.
    const ok = semanticColor(BUBBLEGUM.dark, 145);
    expect(parseOklch(ok)?.h).toBe(145);
  });

  it("keeps the theme's own lightness and saturation when it invents one", () => {
    const ok = parseOklch(semanticColor(BUBBLEGUM.dark, 145))!;
    const primary = parseOklch(BUBBLEGUM.dark["primary"])!;
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
    const out = mapTokens(BUBBLEGUM.dark);
    expect(out["--accent"]).toBe(BUBBLEGUM.dark["primary"]);
    expect(out["--accent"]).not.toBe(BUBBLEGUM.dark["accent"]);
  });

  it("builds the raised surface off the card, never off `muted`", () => {
    // Bubblegum's dark `muted` (L .2713) is DARKER than its `card` (L .2902),
    // so using it would fold bg-0 → bg-1 → bg-2 flat.
    const out = mapTokens(BUBBLEGUM.dark);
    expect(out["--bg-1"]).toBe(BUBBLEGUM.dark["card"]);
    expect(out["--bg-2"]).toContain(BUBBLEGUM.dark["card"]);
    expect(out["--bg-2"]).not.toContain(BUBBLEGUM.dark["muted"]);
  });

  it("uses the theme's sidebar colour for the top bar", () => {
    expect(mapTokens(BUBBLEGUM.dark)["--bg-sunken"]).toBe(BUBBLEGUM.dark["sidebar"]);
  });

  it("scales the corner radii off the theme's own radius", () => {
    const out = mapTokens(BUBBLEGUM.dark); // 0.4rem = 6.4px
    expect(out["--r-sm"]).toBe("4.4px");
    expect(out["--r-md"]).toBe("8.4px");
    expect(out["--r-lg"]).toBe("12.4px");
  });

  it("never sets a font or a shadow", () => {
    const out = mapTokens(CANDYLAND.dark);
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
    expect(MANAGED).toEqual(Object.keys(mapTokens(CANDYLAND.dark)));
    expect(MANAGED).toContain("--bg-0");
    expect(MANAGED).toContain("--accent-tint");
  });
});

describe("a file whose own header talks about the blocks", () => {
  // Every pasted file here carries a header saying which blocks are read. A
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

describe("Mono — a theme with no colour in it at all", () => {
  const MONO = parseThemeCss(monoCss);

  it("still gets a green for ok and an amber for warn", () => {
    // All five of Mono's chart colours are the same grey. Whatever the app
    // says is FINE has to still look fine, and what needs attention amber.
    expect(parseOklch(semanticColor(MONO.dark, 145))?.h).toBe(145);
    expect(parseOklch(semanticColor(MONO.dark, 85))?.h).toBe(85);
  });

  it("gives those invented colours real saturation, not the theme's grey", () => {
    // `primary` is oklch(0.5555 0 0) — zero chroma. Borrowing it literally
    // would produce a grey "green".
    expect(parseOklch(semanticColor(MONO.dark, 145))!.c).toBeGreaterThanOrEqual(0.12);
  });

  it("gives a zero-radius theme genuinely square corners", () => {
    // Brutalism, Neo Brutalism and Neon all ask for 0. The ladder used to add
    // its own 2px/6px on top, so a theme whose whole point was hard corners
    // still drew rounded ones and nothing in the app was ever square.
    expect(mapTokens(MONO.dark)["--r-sm"]).toBe("0px");
    expect(mapTokens(MONO.dark)["--r-md"]).toBe("0px");
    expect(mapTokens(MONO.dark)["--r-lg"]).toBe("0px");
  });
});

describe("text that sits on a coloured fill", () => {
  it("takes its own colour from the theme, not a hardcoded white", () => {
    // Bubblegum's dark `primary` is a PALE yellow. White on it is unreadable,
    // and every primary button in the app used to be white on the accent.
    const out = mapTokens(BUBBLEGUM.dark);
    expect(out["--accent-fg"]).toBe(BUBBLEGUM.dark["primary-foreground"]);
    expect(out["--danger-fg"]).toBe(BUBBLEGUM.dark["destructive-foreground"]);
  });

  it("falls back to white when a theme names neither", () => {
    expect(mapTokens({})["--accent-fg"]).toBe("#fff");
    expect(mapTokens({})["--danger-fg"]).toBe("#fff");
  });
});

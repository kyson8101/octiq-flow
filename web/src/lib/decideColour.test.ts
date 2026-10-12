// The decision colour, against the files that carry it.
//
// A card that waits on the person (a permission, a question, a handover, a
// route, a plan) is drawn in `--decide`: a calm blue-teal that every mode
// states outright. It used to be `--warn` on one card and `--accent` on the
// rest, and inside the composer the accent is the model's colour, so a
// question came up gold: the colour that means a problem. Two things can
// undo that quietly, and neither throws: a palette that names no `--decide`
// (the fallback is Dark's, unreadable on a light page), and a rule on one of
// these cards that reaches for the accent again. Both are checked here,
// against the stylesheets themselves.
import { describe, expect, it } from "vitest";

import designSystemCss from "../design-system.css?raw";
import stylesCss from "../styles.css?raw";
import mangaSheet from "../manga.css?raw";
import chatPlanCss from "../components/ChatPlanCards.css?raw";
import handoverCss from "../components/HandoverCards.css?raw";
import planReviewCss from "../components/PlanReview.css?raw";
import runPanelCss from "../components/OrchestrationPanel.css?raw";
import workflowBarCss from "../components/ChatWorkflowBar.css?raw";
import runProgressCss from "../components/RunProgress.css?raw";
import { MANAGED, mapTokens, parseOklch, parseThemeCss } from "./theme";
import { BUILT_IN, THEMES } from "./themeStore";

/* ---- Colour, enough of it to measure contrast -------------------------- */

type Rgb = [number, number, number];

function fromOklch(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
  return linear.map((v) => {
    const clipped = Math.max(0, Math.min(1, v));
    return 255 * (clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055);
  }) as Rgb;
}

/** A solid colour as the palette files write one: `#rrggbb` or `oklch()`. */
function solid(value: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) return [0, 2, 4].map((at) => parseInt(hex[1].slice(at, at + 2), 16)) as Rgb;
  const lch = parseOklch(value);
  if (lch) return fromOklch(lch.l, lch.c, lch.h);
  throw new Error(`not a colour this test can read: ${value}`);
}

/** A tint as the palette files write one: `rgb(r g b / a%)`. */
function tint(value: string): { rgb: Rgb; alpha: number } {
  const m = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)%\s*\)$/.exec(value.trim());
  if (!m) throw new Error(`not a tint this test can read: ${value}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) / 100 };
}

const over = (top: Rgb, alpha: number, under: Rgb): Rgb =>
  top.map((v, i) => v * alpha + under[i] * (1 - alpha)) as Rgb;

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast of two solid colours. */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Hue in degrees and how much colour there is (0 for a grey). */
function hue(rgb: Rgb): { h: number; chroma: number } {
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma === 0) return { h: 0, chroma };
  const h = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  return { h: (h * 60 + 360) % 360, chroma };
}

/* ---- The five modes, as the page gets them ----------------------------- */

type Mode = { id: string; vars: Record<string, string>; declared: Record<string, string> };

/** Dark is the stylesheet's own `:root`; the rest are their palette files
 *  through the real mapping. */
const builtIn = parseThemeCss(designSystemCss).light;
const MODES: Mode[] = THEMES.map((theme) => theme.id === BUILT_IN
  ? { id: theme.id, vars: Object.fromEntries(Object.entries(builtIn).map(([k, v]) => [`--${k}`, v])), declared: builtIn }
  : { id: theme.id, vars: mapTokens(theme.tokens!), declared: theme.tokens! });

const each = MODES.map((mode) => [mode.id, mode] as const);

describe("the decision colour in every mode", () => {
  it("is a managed variable, so leaving a mode leaves none of it behind", () => {
    for (const name of ["--decide", "--decide-fg", "--decide-tint"]) expect(MANAGED).toContain(name);
  });

  it.each(each)("%s states its own, outright", (id, mode) => {
    // A fallback would be Dark's teal, which a light page cannot read. And
    // nothing may be worked out from another variable: the accent is the
    // model's colour inside the composer.
    const names = id === BUILT_IN ? ["decide", "decide-fg", "decide-tint"] : ["decide", "decide-foreground", "decide-tint"];
    for (const name of names) {
      expect(mode.declared[name], `${id} names no --${name}`).toBeTruthy();
      expect(mode.declared[name]).not.toMatch(/var\(|color-mix|accent|primary/);
    }
    expect(() => solid(mode.vars["--decide"])).not.toThrow();
    expect(() => tint(mode.vars["--decide-tint"])).not.toThrow();
  });

  it.each(each)("%s keeps it away from amber, and from its own accent", (id, mode) => {
    const decide = solid(mode.vars["--decide"]);
    const { h, chroma } = hue(decide);
    if (id === "manga") {
      // Monochrome: the decision colour is ink, like everything that is not
      // a meaning colour.
      expect(chroma).toBe(0);
      return;
    }
    // Blue-teal: clear of yellow, amber and gold (about 30 to 70 degrees),
    // of red and cinnabar, and of the green that means "fine".
    expect(chroma, `${id} has no hue`).toBeGreaterThan(0.1);
    expect(h, `${id} --decide is at hue ${h.toFixed(0)}`).toBeGreaterThanOrEqual(165);
    expect(h, `${id} --decide is at hue ${h.toFixed(0)}`).toBeLessThanOrEqual(215);
    expect(mode.vars["--decide"]).not.toBe(mode.vars["--accent"]);
    expect(mode.vars["--decide"]).not.toBe(mode.vars["--warn"]);
  });

  it.each(each)("%s can be read on it, and it can be seen on its card", (id, mode) => {
    const page = solid(mode.vars["--bg-0"]);
    const decide = solid(mode.vars["--decide"]);
    const wash = tint(mode.vars["--decide-tint"]);
    // A decision card is the tint over the page.
    const card = over(wash.rgb, wash.alpha, page);
    // The label on a fill (a chosen answer).
    expect(contrast(solid(mode.vars["--decide-fg"]), decide), `${id}: --decide-fg on --decide`).toBeGreaterThanOrEqual(4.5);
    // The border and the dot, against the card and against the page round it.
    expect(contrast(decide, card), `${id}: --decide on its card`).toBeGreaterThanOrEqual(3);
    expect(contrast(decide, page), `${id}: --decide on the page`).toBeGreaterThanOrEqual(3);
    // The same colour as small text (the "Suggested" word).
    expect(contrast(decide, card), `${id}: --decide as text on its card`).toBeGreaterThanOrEqual(4.5);
    // Reading text on the tint: the page's own, and the quietest step these
    // cards use (`--fg-2`; `--fg-3` is raised to it on them, styles.css).
    expect(contrast(solid(mode.vars["--fg-0"]), card), `${id}: --fg-0 on the tint`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(solid(mode.vars["--fg-2"]), card), `${id}: --fg-2 on the tint`).toBeGreaterThanOrEqual(4.5);
    // The tint is a wash, not a block: the card stays close to the page.
    expect(contrast(card, page), `${id}: the tint is too strong`).toBeLessThan(1.35);
    expect(wash.alpha).toBeLessThanOrEqual(0.14);
  });
});

/* ---- The rules that draw the cards ------------------------------------- */

type Rule = { selector: string; body: string; file: string };

/** Every innermost `selector { declarations }` of a stylesheet. */
function rules(css: string, file: string): Rule[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim().replace(/\s+/g, " "),
    body: m[2],
    file,
  }));
}

const RULES = [
  ...rules(stylesCss, "styles.css"),
  ...rules(handoverCss, "HandoverCards.css"),
  ...rules(planReviewCss, "PlanReview.css"),
  ...rules(chatPlanCss, "ChatPlanCards.css"),
  ...rules(mangaSheet, "manga.css"),
];

/** Colours a decision card must not take: amber means a problem, and the
 *  accent is the model's colour wherever the composer rebinds it. */
const NOT_A_DECISION = /--(warn|accent|composer-accent|composer-ink)\b/;

const named = (selector: string) => RULES.filter((rule) => rule.selector === selector);

/** The parts of a handover or route name card (`HandoverCards.tsx`), by the
 *  class each is drawn with. A part added to the card is added here, or the
 *  scan below does not see it. */
const NAME_CARD_PARTS = [
  "card", "id", "face", "who", "name", "fact", "settings", "sr", "place", "tip", "files", "unpassed",
  "over", "error", "actions", "hint", "quiet", "go",
];
const NAME_CARD = new RegExp(`\\.handover-(${NAME_CARD_PARTS.join("|")})(?![\\w-])`);
/** The two rules of the card that are not the decision colour, on purpose:
 *  the ring round the face while a confirmed chat starts (in flight, so the
 *  accent), and a file that was not passed on (a problem, so amber). */
const NAME_CARD_APART = new Set([".handover-face.is-working::after", ".handover-unpassed li"]);

/** The border, the dot and the primary answer of each card that asks. */
const DECISION_RULES = [
  // Permission and access request.
  ".ask-card",
  ".ask-card-dot",
  // The safety card's leading answer is one of them (see below).
  ":is(.permission-card, .access-card, .qa-card, .safety-card) .ask-btn.is-primary",
  ":is(.permission-card, .access-card, .qa-card, .safety-card) .ask-btn.is-primary:hover",
  // A question from the agent.
  ".qa-card",
  ".qa-dot",
  ".qa-option.is-on",
  // Handover and route, as name cards (a route card is a handover card).
  // `is-waiting` is the card that waits on the person: undecided, or a
  // start that failed. It has no dot any more: the face is not a signal.
  ".handover-card.is-waiting",
  ".handover-go",
  ".handover-go:hover:not(:disabled)",
  // The plan waiting for approval.
  ".chat-plan[data-pending]",
  ".chat-plan[data-pending] .plan-review-dot",
  ".plan-review[data-drafting] .plan-review-dot",
  ".plan-review-approve .orch-primary",
];

describe("the cards that wait on a decision", () => {
  it.each(DECISION_RULES)("%s is drawn in the decision colour", (selector) => {
    const found = named(selector);
    expect(found.length, `no rule for ${selector}`).toBeGreaterThan(0);
    expect(found.some((rule) => /var\(--decide(-fg|-tint)?\)/.test(rule.body)), `${selector} does not read --decide`).toBe(true);
    for (const rule of found) expect(rule.body, `${rule.file}: ${selector}`).not.toMatch(NOT_A_DECISION);
  });

  it("has no rule of the question card left on the accent or on amber", () => {
    const question = RULES.filter((rule) => rule.file === "styles.css" && /(^|[\s,(>+~])\.qa-/.test(rule.selector));
    expect(question.length).toBeGreaterThan(40);
    for (const rule of question) expect(rule.body, rule.selector).not.toMatch(NOT_A_DECISION);
  });

  it("has no rule of the permission, handover, route or pending-plan card on amber or on the accent, focus rings apart", () => {
    const card = /\.ask-card(?![\w-]*safety)|\.permission-card|\.access-card|\.handover-card\.is-pending|\.handover-go|\.route-card|\.chat-plan\[data-pending\]|\.plan-review-(dot|approve|quiet|change)|\.plan-command-approval-options/;
    const mine = RULES.filter((rule) => (card.test(rule.selector) || NAME_CARD.test(rule.selector))
      && !rule.selector.includes(".safety-card") && !NAME_CARD_APART.has(rule.selector));
    expect(mine.length).toBeGreaterThan(60);
    for (const rule of mine) {
      // An outline is the keyboard's focus ring, the same on every control.
      const drawn = rule.body.split(";").filter((line) => !/^\s*outline/.test(line)).join(";");
      expect(drawn, `${rule.file}: ${rule.selector}`).not.toMatch(NOT_A_DECISION);
    }
  });

  it("names every part of the name card in that scan, and sets two rules apart by name", () => {
    // The scan above goes by class name, so a part of the card it does not
    // name is a part it does not check. Each part has a rule, and is caught.
    const sheet = RULES.filter((rule) => rule.file === "HandoverCards.css");
    for (const part of NAME_CARD_PARTS) {
      const drawn = sheet.filter((rule) => new RegExp(`\\.handover-${part}(?![\\w-])`).test(rule.selector));
      expect(drawn.length, `no rule draws .handover-${part}`).toBeGreaterThan(0);
      for (const rule of drawn) expect(NAME_CARD.test(rule.selector), rule.selector).toBe(true);
    }
    // The envelope is the shared disclosure, dressed for this card.
    expect(sheet.filter((rule) => rule.selector.startsWith(".handover-card .card-fold-")).length).toBeGreaterThan(6);
    // Every other rule of the sheet that reaches for amber or the accent is
    // one of these, or belongs to a settled line and not to a card.
    const coloured = sheet
      .filter((rule) => NOT_A_DECISION.test(rule.body.split(";").filter((line) => !/^\s*outline/.test(line)).join(";")))
      .map((rule) => rule.selector);
    expect(coloured.filter((selector) => NAME_CARD.test(selector)).sort()).toEqual([...NAME_CARD_APART].sort());
    for (const selector of coloured.filter((item) => !NAME_CARD.test(item))) expect(selector).toMatch(/^\.handover-(line|outcome|asks)/);
    // In flight is the accent's one job, and that ring is never drawn on a
    // card that waits (`HandoverCards.test.tsx` holds the markup to it).
    // (Two rules: the ring, and the one that holds it still for reduced motion.)
    const ring = named(".handover-face.is-working::after");
    expect(ring).toHaveLength(2);
    expect(ring.filter((rule) => /var\(--accent\)/.test(rule.body))).toHaveLength(1);
    for (const rule of ring) expect(rule.body).not.toMatch(/--warn\b/);
    expect(ring.some((rule) => /animation:\s*none/.test(rule.body))).toBe(true);
    // A file that was not passed on is a problem, not a question: amber.
    const unpassed = named(".handover-unpassed li");
    expect(unpassed).toHaveLength(1);
    expect(unpassed[0].body).toMatch(/(^|;)\s*color:\s*var\(--warn\)/m);
    // No other mode draws either part in a colour of its own.
    for (const rule of RULES.filter((item) => item.file !== "HandoverCards.css" && /\.handover-(face|unpassed)/.test(item.selector))) {
      expect(rule.body, `${rule.file}: ${rule.selector}`).not.toMatch(NOT_A_DECISION);
    }
  });

  it("puts the label on a fill in --decide-fg, never a colour written out", () => {
    const fills = RULES.filter((rule) => /background:\s*var\(--decide\)\s*(;|$)/m.test(rule.body) && /(^|;)\s*color:/m.test(rule.body));
    expect(fills.map((rule) => rule.selector)).toContain(".qa-option.is-on");
    for (const rule of fills) expect(rule.body, rule.selector).toMatch(/(^|;)\s*color:\s*var\(--decide-fg\)/m);
  });

  it("keeps amber on the card that is a warning, and red on what destroys", () => {
    // A refused call is a problem: the safety card shares the permission
    // card's shape and is the one that stays amber.
    const safety = named(".safety-card");
    expect(safety.some((rule) => /border-color:[^;]*var\(--warn\)/.test(rule.body))).toBe(true);
    expect(safety.some((rule) => /background:[^;]*var\(--warn\)/.test(rule.body))).toBe(true);
    // A stage that can never start is a warning inside a plan.
    expect(named(".plan-stage[data-blocked] .plan-stage-title").some((rule) => /--warn/.test(rule.body))).toBe(true);
    expect(named(".ask-btn.is-primary.is-danger").some((rule) => /--danger/.test(rule.body))).toBe(true);
  });

  it("draws the safety card's leading answer in the decision colour, whatever the model's colour is", () => {
    // "Keep it local" and "Use safer approach" used to take `.ask-btn.is-primary`
    // as it stands: the accent, which the composer rebinds to the model's
    // colour, so under Claude the answer came up gold on an amber card. The
    // card stays a warning; the answer it leads with is a decision.
    const lead = RULES.filter((rule) => /\.safety-card\b[^,{]*\)? \.ask-btn\.is-primary/.test(rule.selector) || /:is\([^)]*\.safety-card[^)]*\) \.ask-btn\.is-primary/.test(rule.selector));
    expect(lead.map((rule) => rule.selector)).toEqual(expect.arrayContaining([
      ":is(.permission-card, .access-card, .qa-card, .safety-card) .ask-btn.is-primary",
      ":is(.permission-card, .access-card, .qa-card, .safety-card) .ask-btn.is-primary:hover",
    ]));
    for (const rule of lead) {
      expect(rule.body, rule.selector).toMatch(/var\(--decide(-fg)?\)/);
      expect(rule.body, rule.selector).not.toMatch(NOT_A_DECISION);
    }
    // It wins over the plain primary button, which is the accent: it names a
    // card as well as the button, and it comes later in the sheet.
    const plain = stylesCss.indexOf("\n.ask-btn.is-primary {");
    const mine = stylesCss.indexOf("\n:is(.permission-card, .access-card, .qa-card, .safety-card) .ask-btn.is-primary {");
    expect(plain).toBeGreaterThan(-1);
    expect(mine).toBeGreaterThan(plain);
    expect(named(".ask-btn.is-primary")[0].body).toMatch(/var\(--accent\)/);
    // No sheet draws that button for the safety card alone in another colour.
    for (const rule of RULES.filter((item) => /\.safety-card[^,]*\.ask-btn/.test(item.selector) && !item.selector.includes(":is("))) {
      expect(rule.body, rule.selector).not.toMatch(/--(accent|composer-accent|composer-ink|warn)\b/);
    }
    // The keyboard's ring on it is the decision colour too.
    expect(named(":is(.permission-card, .access-card, .qa-card, .safety-card) .ask-btn:focus-visible")[0].body).toMatch(/outline-color:\s*var\(--decide\)/);
    // Monochrome: solid ink with its own label, like every card that asks.
    const manga = RULES.filter((rule) => rule.file === "manga.css" && rule.selector.includes(".safety-card") && rule.selector.includes(".ask-btn.is-primary"));
    expect(manga).toHaveLength(1);
    expect(manga[0].body).toMatch(/background:\s*var\(--decide\)/);
    expect(manga[0].body).toMatch(/(^|;)\s*color:\s*var\(--decide-fg\)/m);
  });

  it("raises the quietest text one step on a tinted card", () => {
    const raised = RULES.filter((rule) => /--fg-3:\s*var\(--fg-2\)/.test(rule.body));
    expect(raised).toHaveLength(1);
    for (const card of [".ask-card:not(.safety-card)", ".qa-card", ".handover-card.is-waiting", ".chat-plan[data-pending]"]) {
      expect(raised[0].selector).toContain(card);
    }
  });
});

/* ---- A run: what waits on the person, and what is only a problem ------- */

describe("a run's own surfaces", () => {
  const run = [
    ...rules(runPanelCss, "OrchestrationPanel.css"),
    ...rules(workflowBarCss, "ChatWorkflowBar.css"),
    ...rules(runProgressCss, "RunProgress.css"),
  ];
  const of = (selector: string) => run.filter((rule) => rule.selector === selector);

  /** Everything that says "this waits on you" for a run: the strip's Needs
   *  you state, the panel's group and row, the count on a collapsed goal,
   *  the decisions box and the count on the Tasks button. */
  const WAITS_ON_YOU = [
    '.run-strip[data-state="needs"] .run-strip-dot',
    '.run-strip[data-state="needs"] .run-strip-fill',
    '.run-strip[data-state="needs"] .run-strip-reason',
    '.run-group[data-group="needs"] > .run-group-head',
    '.orch-task.run-row[data-state="needs"]',
    '.run-row-note[data-tone="decide"]',
    '.orch-attention[data-tone="decision"]',
    ".orch-decisions",
    ".tasks-toggle-owed",
  ];

  it.each(WAITS_ON_YOU)("%s is the decision colour, never amber and never the accent", (selector) => {
    const found = of(selector);
    expect(found.length, `no rule for ${selector}`).toBeGreaterThan(0);
    expect(found.some((rule) => /var\(--decide(-tint)?\)/.test(rule.body)), `${selector} does not read --decide`).toBe(true);
    for (const rule of found) expect(rule.body, selector).not.toMatch(NOT_A_DECISION);
  });

  it("keeps amber, on the run progress sheet, for a worker in trouble and nothing else", () => {
    const amber = rules(runProgressCss, "RunProgress.css").filter((rule) => /--warn\b/.test(rule.body));
    expect(amber.map((rule) => rule.selector)).toEqual(['.orch-task.run-row[data-tone="warn"]', '.run-row-note[data-tone="warn"]']);
  });

  it("draws a task that is stuck in amber, which is a problem, and not in the decision colour", () => {
    // The count on a collapsed goal: amber by default (blocked), the
    // decision colour only when it counts decisions.
    expect(of(".orch-attention")[0].body).toMatch(/var\(--warn\)/);
    expect(of('.orch-attention[data-tone="decision"]')[0].body).not.toMatch(/--warn/);
  });
});

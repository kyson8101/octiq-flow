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
import questionCss from "../components/InlineQuestions.css?raw";
import planReviewCss from "../components/PlanReview.css?raw";
import planPanelCss from "../components/PlanPanel.css?raw";
import guofengSheet from "../guofeng.css?raw";
import runPanelCss from "../components/OrchestrationPanel.css?raw";
import workflowBarCss from "../components/ChatWorkflowBar.css?raw";
import runProgressCss from "../components/RunProgress.css?raw";
import pendingBadgeCss from "../components/PendingActionBadge.css?raw";
import { pendingLabel, pendingTone, type PendingAction, type PendingActionKind } from "./pendingActions";
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
  ...rules(questionCss, "InlineQuestions.css"),
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
/** The one rule of the card that takes a colour the scan forbids, on
 *  purpose: a file that was not passed on is a problem, so it is amber.
 *  Nothing on the card takes the accent: the ring round the face while a
 *  confirmed chat opens is the grey of the card's text, and the scan covers
 *  it like every other part. */
const NAME_CARD_APART = new Set([".handover-unpassed li"]);

/** The border, the dot and the primary answer of each card that asks. */
const DECISION_RULES = [
  // Permission and access request.
  ".ask-card",
  ".ask-card-dot",
  // The safety card's leading answer is one of them (see below).
  ":is(.permission-card, .access-card, .safety-card) .ask-btn.is-primary",
  ":is(.permission-card, .access-card, .safety-card) .ask-btn.is-primary:hover",
  // A question from the agent, drawn in the transcript with no card round
  // it: what the person does about it is the decision colour.
  ".qa-submit",
  ".qa-row input:checked + .qa-mark",
  ".qa-waiting .status-row-label",
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

  it("has no rule of the question block on the accent or on amber, two named ones apart", () => {
    // The old card's rules are gone from the main sheet with the card.
    expect(RULES.filter((rule) => rule.file === "styles.css" && /\.qa-/.test(rule.selector))).toEqual([]);
    const question = RULES.filter((rule) => rule.file === "InlineQuestions.css" && /(^|[\s,(>+~])\.qa-/.test(rule.selector));
    expect(question.length).toBeGreaterThan(40);
    // The answer bubble is the person's own, in the wash their messages wear;
    // answers that were not saved or not delivered are a problem, so amber.
    const apart = new Set([".qa-said-body", '.qa-note[data-tone="warn"]']);
    for (const rule of question) {
      if (apart.has(rule.selector)) continue;
      const drawn = rule.body.split(";").filter((line) => !/^\s*outline/.test(line)).join(";");
      expect(drawn, rule.selector).not.toMatch(NOT_A_DECISION);
    }
    expect(named(".qa-said-body")[0].body).toMatch(/var\(--accent\)/);
    expect(named('.qa-note[data-tone="warn"]')[0].body).toMatch(/color:\s*var\(--warn\)/);
  });

  it("has no rule of the permission, handover, route or pending-plan card on amber or on the accent, focus rings apart", () => {
    // (The handover and route card are named whole by `NAME_CARD`, the card
    // that waits, `.handover-card.is-waiting`, among them.)
    const card = /\.ask-card(?![\w-]*safety)|\.permission-card|\.access-card|\.route-card|\.chat-plan\[data-pending\]|\.plan-review-(dot|approve|quiet|change)|\.plan-command-approval-options/;
    const mine = RULES.filter((rule) => (card.test(rule.selector) || NAME_CARD.test(rule.selector))
      && !rule.selector.includes(".safety-card") && !NAME_CARD_APART.has(rule.selector));
    expect(mine.length).toBeGreaterThan(60);
    for (const rule of mine) {
      // An outline is the keyboard's focus ring, the same on every control.
      const drawn = rule.body.split(";").filter((line) => !/^\s*outline/.test(line)).join(";");
      expect(drawn, `${rule.file}: ${rule.selector}`).not.toMatch(NOT_A_DECISION);
    }
  });

  it("names every part of the name card in that scan, and sets one rule apart by name", () => {
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
    // that one, or belongs to a settled line and not to a card.
    const coloured = sheet
      .filter((rule) => NOT_A_DECISION.test(rule.body.split(";").filter((line) => !/^\s*outline/.test(line)).join(";")))
      .map((rule) => rule.selector);
    expect(coloured.filter((selector) => NAME_CARD.test(selector)).sort()).toEqual([...NAME_CARD_APART].sort());
    for (const selector of coloured.filter((item) => !NAME_CARD.test(item))) expect(selector).toMatch(/^\.handover-(line|outcome|asks)/);
    // The ring round the face while a confirmed chat opens. Opening a chat is
    // not a turn in flight (the page may only be finding it), so it is not
    // the accent, which is gold under Claude and in 中国风; and nothing waits
    // on the person by then, so it is not the decision colour either. It is
    // the grey of the card's own text, in every mode, and the scan above
    // covers it: no rule of it is set apart.
    // (Two rules: the ring, and the one that holds it still for reduced motion.)
    const ring = named(".handover-face.is-opening::after");
    expect(ring).toHaveLength(2);
    for (const rule of ring) {
      expect(NAME_CARD.test(rule.selector)).toBe(true);
      expect(NAME_CARD_APART.has(rule.selector)).toBe(false);
      expect(rule.body).not.toMatch(NOT_A_DECISION);
      expect(rule.body).not.toMatch(/--decide\b/);
    }
    expect(ring.filter((rule) => /border:[^;]*var\(--fg-1\)/.test(rule.body))).toHaveLength(1);
    expect(ring.some((rule) => /animation:\s*none/.test(rule.body))).toBe(true);
    // The class the accent's "working" rings are drawn with is not on this
    // card at all, in any sheet.
    expect(RULES.filter((rule) => /\.handover-[\w-]*\.is-working/.test(rule.selector))).toEqual([]);
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
    // Manga draws the question's button as a fill, like every answer a card leads with.
    expect(fills.some((rule) => rule.selector.includes(".qa-submit"))).toBe(true);
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
      ":is(.permission-card, .access-card, .safety-card) .ask-btn.is-primary",
      ":is(.permission-card, .access-card, .safety-card) .ask-btn.is-primary:hover",
    ]));
    for (const rule of lead) {
      expect(rule.body, rule.selector).toMatch(/var\(--decide(-fg)?\)/);
      expect(rule.body, rule.selector).not.toMatch(NOT_A_DECISION);
    }
    // It wins over the plain primary button, which is the accent: it names a
    // card as well as the button, and it comes later in the sheet.
    const plain = stylesCss.indexOf("\n.ask-btn.is-primary {");
    const mine = stylesCss.indexOf("\n:is(.permission-card, .access-card, .safety-card) .ask-btn.is-primary {");
    expect(plain).toBeGreaterThan(-1);
    expect(mine).toBeGreaterThan(plain);
    expect(named(".ask-btn.is-primary")[0].body).toMatch(/var\(--accent\)/);
    // No sheet draws that button for the safety card alone in another colour.
    for (const rule of RULES.filter((item) => /\.safety-card[^,]*\.ask-btn/.test(item.selector) && !item.selector.includes(":is("))) {
      expect(rule.body, rule.selector).not.toMatch(/--(accent|composer-accent|composer-ink|warn)\b/);
    }
    // The keyboard's ring on it is the decision colour too.
    expect(named(":is(.permission-card, .access-card, .safety-card) .ask-btn:focus-visible")[0].body).toMatch(/outline-color:\s*var\(--decide\)/);
    // Monochrome: solid ink with its own label, like every card that asks.
    const manga = RULES.filter((rule) => rule.file === "manga.css" && rule.selector.includes(".safety-card") && rule.selector.includes(".ask-btn.is-primary"));
    expect(manga).toHaveLength(1);
    expect(manga[0].body).toMatch(/background:\s*var\(--decide\)/);
    expect(manga[0].body).toMatch(/(^|;)\s*color:\s*var\(--decide-fg\)/m);
  });

  it("raises the quietest text one step on a tinted card", () => {
    const raised = RULES.filter((rule) => /--fg-3:\s*var\(--fg-2\)/.test(rule.body));
    expect(raised).toHaveLength(1);
    for (const card of [".ask-card:not(.safety-card)", ".handover-card.is-waiting", ".chat-plan[data-pending]"]) {
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

/* ---- The badge in the chat list ----------------------------------------- */

describe("the pending badge in the chat list", () => {
  const sheet = rules(pendingBadgeCss, "PendingActionBadge.css");
  const of = (selector: string) => sheet.filter((rule) => rule.selector === selector);
  const action = (kind: PendingActionKind): PendingAction => ({ key: `${kind}:1`, kind, rowId: "main", openChatId: "main", surface: "chat" });

  it("is the decision colour unless what it says is a problem or a failure", () => {
    // One rule draws it, from one variable, and that variable is --decide.
    const [base] = of(".pending-action-badge");
    expect(base.body).toMatch(/--pending:\s*var\(--decide\);/);
    expect(base.body).toMatch(/color:\s*var\(--pending\);/);
    expect(base.body).toMatch(/border:[^;]*var\(--pending\)/);
    expect(base.body).toMatch(/background:[^;]*var\(--pending\)/);
    // Amber and red are named only by the tone that means them.
    expect(of('.pending-action-badge[data-tone="warn"]').map((rule) => rule.body.trim())).toEqual(["--pending: var(--warn);"]);
    expect(of('.pending-action-badge[data-tone="danger"]').map((rule) => rule.body.trim())).toEqual(["--pending: var(--danger);"]);
    const named = (token: string) => sheet.filter((rule) => new RegExp(`--${token}\\b`).test(rule.body)).map((rule) => rule.selector);
    expect(named("warn")).toEqual(['.pending-action-badge[data-tone="warn"]']);
    expect(named("danger")).toEqual(['.pending-action-badge[data-tone="danger"]']);
    // The accent is the focus ring's and nothing else's.
    expect(named("accent")).toEqual([".pending-action-badge:focus-visible"]);
    // The ring on the card a badge leads to points at what waits on them.
    for (const rule of sheet.filter((each) => /pending-revealed|pending-reveal/.test(each.selector) || /outline-color/.test(each.body))) {
      expect(rule.body, rule.selector).not.toMatch(/--warn\b/);
    }
  });

  it("takes its tone from what it says, for every kind of wait", () => {
    // Written by hand: a wait on the person's decision, a problem they are
    // told of, and the failure that is theirs to decide.
    const table: [PendingActionKind, string, string][] = [
      ["permission", "Permission needed", "decide"],
      ["question", "Answer needed", "decide"],
      ["gate", "Decision needed", "decide"],
      ["plan", "Plan approval", "decide"],
      ["handover", "Handover to confirm", "decide"],
      ["safety", "Review needed", "warn"],
      ["outage", "Safety check was down", "warn"],
      ["delivery", "Delivery failed", "warn"],
      ["failure", "Failed · your decision", "danger"],
    ];
    for (const [kind, label, tone] of table) {
      expect(pendingLabel([action(kind)]), kind).toBe(label);
      expect(pendingTone([action(kind)]), kind).toBe(tone);
    }
    // Several of one state are that state; mixed, the decision colour.
    expect(pendingTone([action("failure"), action("failure")])).toBe("danger");
    expect(pendingTone([action("outage"), action("delivery")])).toBe("warn");
    expect(pendingTone([action("failure"), action("permission")])).toBe("decide");
    expect(pendingTone([action("safety"), action("question")])).toBe("decide");
    expect(pendingTone([action("failure"), action("delivery")])).toBe("decide");
  });

  it("is amber for nothing that only waits on a decision", () => {
    // The mutation this is here for: the sheet as it was, amber for all.
    const before = pendingBadgeCss.replace("--pending: var(--decide);", "--pending: var(--warn);");
    expect(before).not.toBe(pendingBadgeCss);
    const [base] = rules(before, "PendingActionBadge.css").filter((rule) => rule.selector === ".pending-action-badge");
    expect(base.body).toMatch(NOT_A_DECISION);
    expect(of(".pending-action-badge")[0].body).not.toMatch(NOT_A_DECISION);
  });
});

/* ---- The Plan panel: a chat's plan beside the chat ---------------------- */

describe("the Plan panel", () => {
  const sheet = rules(planPanelCss, "PlanPanel.css");
  const of = (selector: string) => sheet.filter((rule) => rule.selector === selector);
  const drawn = (rule: Rule) => rule.body.split(";").filter((line) => !/^\s*outline/.test(line)).join(";");
  const reads = (token: string) => sheet.filter((rule) => new RegExp(`var\\(--${token}\\b`).test(drawn(rule))).map((rule) => rule.selector);

  /** The parts of the panel and of its button (`PlanPanel.tsx`), by the
   *  class each is drawn with. A part added to the panel is added here, or
   *  the scans below do not see it. */
  const PLAN_PARTS = [
    "toggle", "toggle-open", "panel", "head", "head-state", "close", "meta", "meta-open", "error", "none", "none-hint",
    "items", "item", "item-main", "mark", "item-head", "item-title", "item-word", "decisions", "questions", "question-mark",
    "more", "chevron", "note", "progress", "progress-count", "bar", "progress-parts", "tasks", "task", "task-word",
    "task-title", "task-go", "foot", "foot-row", "start", "foot-side", "started", "started-note", "refusal",
  ];

  it("names every part of the panel, and the sheet draws no part it does not name", () => {
    const classes = new Set(sheet.flatMap((rule) => [...rule.selector.matchAll(/\.cplan-([a-z-]+)/g)].map((match) => match[1])));
    expect([...classes].sort()).toEqual([...PLAN_PARTS].sort());
    // Its classes are its own: the plan card of a run (`.plan-task`,
    // `.plan-stage`, `.plan-card`) is another thing, in other sheets.
    expect(sheet.filter((rule) => /(^|[\s,(>+~])\.plan-/.test(rule.selector))).toEqual([]);
    expect(RULES.filter((rule) => /\.cplan-/.test(rule.selector))).toEqual([]);
  });

  /** What waits on the person here: a question still open (on its item, in
   *  the header's count and on the bar's button) and Start. */
  const WAITS_ON_YOU = [".cplan-start", ".cplan-question-mark", ".cplan-toggle-open", ".cplan-meta-open"];

  it.each(WAITS_ON_YOU)("%s is the decision colour, never amber and never the accent", (selector) => {
    const found = of(selector);
    expect(found.length, `no rule for ${selector}`).toBeGreaterThan(0);
    expect(found.some((rule) => /var\(--decide\)/.test(rule.body)), `${selector} does not read --decide`).toBe(true);
    for (const rule of found) expect(rule.body, selector).not.toMatch(NOT_A_DECISION);
  });

  it("reads the decision colour for those and for nothing else", () => {
    expect(reads("decide").sort()).toEqual([...WAITS_ON_YOU, ".cplan-start:hover:not([aria-disabled=\"true\"])"].sort());
  });

  it("keeps the accent for an item with a turn in flight on one of its tasks, as a tint, and nothing else", () => {
    expect(reads("accent").sort()).toEqual(['.cplan-mark[data-mark="live"]', ".cplan-task-word[data-live]"]);
    const mark = of('.cplan-mark[data-mark="live"]')[0];
    // A tint, never a solid fill.
    expect(mark.body).toMatch(/background:\s*var\(--accent-tint\)/);
    expect(mark.body).not.toMatch(/background:\s*var\(--accent\)/);
    expect(sheet.filter((rule) => /--(composer-accent|composer-ink)\b/.test(rule.body))).toEqual([]);
  });

  it("draws done in the ok colour: the item the count does not contradict, a full bar, a finished task", () => {
    expect(reads("ok").sort()).toEqual([
      ".cplan-bar[data-full] > span", '.cplan-item-word[data-mark="done"]', '.cplan-mark[data-mark="done"]', '.cplan-task-word[data-state="done"]',
    ]);
    // The agent's word alone colours nothing: `data-status="done"` is grey.
    expect(sheet.filter((rule) => /data-status="done"/.test(rule.selector)).every((rule) => !/--ok\b/.test(rule.body))).toBe(true);
  });

  it("keeps amber for a plan that could not be read, and draws nothing in the danger colour", () => {
    expect(reads("warn")).toEqual([".cplan-error"]);
    // A linked task that failed is said in words, in grey: whose move a
    // failure is the run panel's to say, which the task links to.
    expect(reads("danger")).toEqual([]);
    expect(sheet.filter((rule) => /data-state="failed"/.test(rule.selector))).toEqual([]);
  });

  it("writes no colour out: tokens only, in every mode", () => {
    for (const rule of sheet) expect(rule.body, rule.selector).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\boklch\(|\bhsla?\(/i);
    // No mode's own sheet redraws a part of it.
    for (const css of [mangaSheet, guofengSheet, stylesCss]) expect(css).not.toMatch(/\.cplan-/);
  });

  it("has no animation that loops, and holds every one still for reduced motion", () => {
    expect(planPanelCss).not.toMatch(/infinite/);
    const animated = sheet.filter((rule) => /(^|;)\s*animation:\s*(?!none)/.test(rule.body)).map((rule) => rule.selector);
    expect(animated.length).toBeGreaterThan(0);
    const reduced = planPanelCss.slice(planPanelCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const selector of animated) for (const part of selector.split(",")) expect(reduced, part).toContain(part.trim());
    // Every state change is 130 to 220 ms, ease-out.
    for (const rule of sheet) {
      for (const ms of [...rule.body.matchAll(/(\d+)ms/g)].map((match) => Number(match[1]))) {
        expect(ms, rule.selector).toBeGreaterThanOrEqual(130);
        expect(ms, rule.selector).toBeLessThanOrEqual(220);
      }
    }
  });
});

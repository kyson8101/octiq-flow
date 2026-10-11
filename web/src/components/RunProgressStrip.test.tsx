import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunProgressStrip, stripSpoken } from "./RunProgressStrip";
import type { RunStrip } from "../lib/runProgress";
import css from "./RunProgress.css?raw";

const strip = (over: Partial<RunStrip> = {}): RunStrip => ({
  state: "running", word: "Running", done: 13, total: 22, percent: 59, label: "Tasks 13/22",
  side: [{ text: "4 working", strong: false }], live: true, signature: "run_1:running:13/22:0:0", ...over,
});

const render = (value: RunStrip) => renderToStaticMarkup(<RunProgressStrip strip={value} onOpen={() => {}} onHide={() => {}} />);

describe("the run's line above the composer", () => {
  it("draws the state, the count in its bar, the percent and who is working", () => {
    const html = render(strip());
    expect(html).toContain('<div class="run-strip" data-state="running" data-live="true"');
    expect(html).toContain('<span class="run-strip-word">Running</span>');
    expect(html).toContain('style="--at:59%"');
    expect(html).toContain('<span class="run-strip-fill" style="width:59%"></span><span class="run-strip-label">Tasks 13/22</span>');
    expect(html).toContain('<span class="run-strip-pct" aria-hidden="true">59%</span>');
    // The number in the line's ink, the word beside it.
    expect(html).toContain("<span><b>4</b> working</span>");
  });

  it("says what waits in the decision's own words, then who is still working", () => {
    const html = render(strip({
      state: "needs", word: "Needs you", live: false,
      side: [{ text: "1 decision", strong: true }, { text: "3 working", strong: false }],
    }));
    expect(html).toContain('data-state="needs"');
    expect(html).not.toContain("data-live");
    expect(html).toContain('<b class="run-strip-reason">1 decision</b>');
    expect(html).toContain('<span class="run-strip-then"> · 3 working</span>');
  });

  it("turns to Done with the whole count and how long it took, and offers Dismiss", () => {
    const html = render(strip({
      state: "done", word: "Done", done: 22, total: 22, percent: 100, label: "Done · 22/22", live: false,
      side: [{ text: "2h 41m", strong: false }],
    }));
    expect(html).toContain('data-state="done"');
    expect(html).toContain('<span class="run-strip-label">Done · 22/22</span>');
    expect(html).toContain("<span>2h 41m</span>");
    expect(html).toContain('aria-label="Dismiss"');
  });

  it("says a failure in red's own word", () => {
    const html = render(strip({
      state: "failed", word: "Failed", done: 10, percent: 45, label: "Tasks 10/22", live: false,
      side: [{ text: "1 failed", strong: true }, { text: "2 working", strong: false }],
    }));
    expect(html).toContain('data-state="failed"');
    expect(html).toContain('<b class="run-strip-reason">1 failed</b>');
  });

  it("leaves the side out when there is nothing to count", () => {
    const html = render(strip({ side: [] }));
    expect(html).not.toContain("run-strip-side");
    expect(html).not.toMatch(/\b0 (working|failed|decisions?)\b/);
  });

  it("says no percent before anything is done", () => {
    const html = render(strip({ done: 0, total: 2, percent: 0, label: "Tasks 0/2", side: [{ text: "1 working", strong: false }] }));
    expect(html).not.toContain("run-strip-pct");
    expect(html).not.toContain(">0%<");
    expect(html).toContain('<span class="run-strip-label">Tasks 0/2</span>');
  });

  it("is one button that opens the agents, and one that hides the line", () => {
    const html = render(strip());
    expect(html.match(/<button /g)).toHaveLength(2);
    expect(html).toContain('aria-label="Run: Running, 13 of 22 tasks done, 4 working. Show the agents"');
    expect(html).toContain('aria-label="Hide until something changes"');
    expect(stripSpoken(strip({ side: [] }))).toBe("Run: Running, 13 of 22 tasks done");
  });
});

/* The rules the person set, against the sheet that draws both surfaces. */
describe("the run progress sheet", () => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] }));

  it("takes every colour from a token", () => {
    // `#000` is the mask's opaque end, not a colour anyone sees.
    const drawn = code.replace(/mask-image:[^;]+;/g, "");
    expect(drawn).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(drawn).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch)\(/);
  });

  it("uses the decision colour for what waits on the person, and amber only for a worker in trouble", () => {
    const warn = rules.filter((rule) => /--warn/.test(rule.body)).map((rule) => rule.selector);
    expect(warn).toEqual(['.run-row-note[data-tone="warn"]']);
    for (const selector of ['.run-strip[data-state="needs"] .run-strip-dot', '.run-strip[data-state="needs"] .run-strip-fill',
      '.run-strip[data-state="needs"] .run-strip-reason', '.run-group[data-group="needs"] > .run-group-head', '.run-row-note[data-tone="decide"]']) {
      const found = rules.filter((rule) => rule.selector === selector);
      expect(found.length, selector).toBeGreaterThan(0);
      for (const rule of found) expect(rule.body, selector).toMatch(/var\(--decide\)/);
    }
  });

  it("never fills anything with the accent: it is a tint, or a dot", () => {
    for (const rule of rules.filter((item) => /background(-color)?:[^;]*--accent\b/.test(item.body))) {
      if (rule.selector === '.run-strip[data-state="running"] .run-strip-dot') continue;
      expect(rule.body, rule.selector).toMatch(/color-mix\(in srgb, var\(--accent\) \d+%|var\(--accent-tint\)/);
    }
    expect(code).not.toMatch(/background(-color)?:\s*var\(--(ok|danger|decide|warn)\)\s*;[^}]*color:/);
  });

  it("moves one thing, and stops it for reduced motion", () => {
    const animated = rules.filter((rule) => /(^|[;\s])animation:(?!\s*none)/.test(rule.body)).map((rule) => rule.selector);
    expect(animated).toEqual([".run-strip[data-live] .run-strip-meter::after"]);
    expect(code).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.run-strip\[data-live\] \.run-strip-meter::after \{ animation: none; \}/);
  });

  it("keeps every transition between 130 and 220 ms, easing out, off layout", () => {
    const transitions = rules.flatMap((rule) => [...rule.body.matchAll(/transition:([^;]+);/g)].map((m) => ({ selector: rule.selector, value: m[1].trim() })))
      .filter((item) => item.value !== "none");
    expect(transitions.length).toBeGreaterThan(3);
    for (const { selector, value } of transitions) {
      for (const part of value.split(",")) {
        const [, property, ms, ease] = /^\s*([a-z-]+) (\d+)ms ([a-z-]+)\s*$/.exec(part) ?? [];
        expect(property, `${selector}: ${part}`).toBeTruthy();
        expect(Number(ms), selector).toBeGreaterThanOrEqual(130);
        expect(Number(ms), selector).toBeLessThanOrEqual(220);
        expect(ease, selector).toBe("ease-out");
        // The bar's fill is clipped inside its track: its width moves nothing.
        expect(["background", "color", "transform", "width"], selector).toContain(property);
      }
    }
  });
});

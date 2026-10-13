import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunProgressStrip, stripSpoken, stripTitle } from "./RunProgressStrip";
import { stripLine, type RunStrip } from "../lib/runProgress";
import css from "./RunProgress.css?raw";
import statusCss from "./ChatStatus.css?raw";

const strip = (over: Partial<RunStrip> = {}): RunStrip => ({
  state: "running", word: "Running", done: 13, total: 22, percent: 59, label: "13/22",
  side: [{ text: "4 working", strong: false }], live: true, needs: 0, planOnly: false, failed: 0, stopped: 0, working: 4, runs: 1,
  notes: [], signature: "run_1:running:13/22:0:0", ...over,
});

const render = (value: RunStrip) => renderToStaticMarkup(<RunProgressStrip strip={value} onOpen={() => {}} onHide={() => {}} />);
/** What a person reads off the line: the words between the tags. */
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const once = (text: string, part: string) => text.split(part).length - 1;

describe("the run's line above the composer", () => {
  it("draws the dot, the state word, a bar with nothing in it, then the count and who is working", () => {
    const html = render(strip());
    expect(html).toContain('<div class="run-strip status-row" data-state="running" data-live="true"');
    expect(html).toContain('<span class="status-row-icon" aria-hidden="true"><span class="run-strip-dot"></span></span>');
    expect(html).toContain('<span class="run-strip-word">Running</span>');
    // The bar is a fill and nothing else: no words, no count, no percent.
    expect(html).toContain('<span class="run-strip-meter" style="--at:59%" aria-hidden="true"><span class="run-strip-fill" style="width:59%"></span></span>');
    expect(html).toContain('<span class="run-strip-count" aria-hidden="true">13/22</span>');
    // The number in the line's ink, the word beside it.
    expect(html).toContain("<span> · <b>4</b> working</span>");
    expect(words(html)).toBe("Running 13/22 · 4 working");
  });

  it("says no percent, in any state", () => {
    for (const value of [strip(), strip({ percent: 100, state: "done", word: "Done", label: "22/22", done: 22 }), strip({ percent: 0, done: 0, label: "0/22" })]) {
      // Not between the tags and not in what is spoken: only the fill's width.
      expect(render(value).replace(/style="[^"]*"/g, "")).not.toContain("%");
      expect(render(value)).not.toContain("run-strip-pct");
      expect(render(value)).not.toContain("run-strip-label");
    }
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
    expect(words(html)).toBe("Needs you 13/22 · 1 decision · 3 working");
    expect(once(words(html), "Needs you")).toBe(1);
  });

  it("turns to Done once, with a full bar, the whole count and how long it took, and offers Dismiss", () => {
    const html = render(strip({
      state: "done", word: "Done", done: 22, total: 22, percent: 100, label: "22/22", live: false,
      side: [{ text: "2h 41m", strong: false }],
    }));
    expect(html).toContain('data-state="done"');
    expect(html).toContain('<span class="run-strip-fill" style="width:100%"></span>');
    expect(words(html)).toBe("Done 22/22 · 2h 41m");
    expect(once(words(html), "Done")).toBe(1);
    expect(html).toContain('aria-label="Dismiss"');
  });

  it("says a failure once: how many failed is the word, and the counts are what is left", () => {
    const failed = strip({
      state: "failed", word: "Failed", done: 10, percent: 45, label: "10/22", live: false, failed: 1,
      side: [{ text: "1 failed", strong: true }, { text: "2 working", strong: false }],
    });
    const html = render(failed);
    expect(html).toContain('data-state="failed"');
    expect(html).toContain('<span class="run-strip-word">1 failed</span>');
    expect(words(html)).toBe("1 failed 10/22 · 2 working");
    expect(once(words(html).toLowerCase(), "failed")).toBe(1);
    expect(stripLine(failed)).toEqual({ word: "1 failed", side: [{ text: "2 working", strong: false }] });
    // Every other state keeps its word and all of its counts.
    expect(stripLine(strip())).toEqual({ word: "Running", side: [{ text: "4 working", strong: false }] });
    // What is spoken is whole, as before.
    expect(stripSpoken(failed)).toBe("Run: Failed, 10 of 22 tasks done, 1 failed, 2 working");
  });

  it("leaves the side out when there is nothing to count", () => {
    const html = render(strip({ side: [] }));
    expect(html).not.toContain("run-strip-side");
    expect(html).not.toMatch(/\b0 (working|failed|decisions?)\b/);
    expect(words(html)).toBe("Running 13/22");
  });

  it("draws an empty bar and the count before anything is done", () => {
    const html = render(strip({ done: 0, total: 2, percent: 0, label: "0/2", side: [{ text: "1 working", strong: false }] }));
    expect(html).toContain('<span class="run-strip-fill" style="width:0%"></span>');
    expect(words(html)).toBe("Running 0/2 · 1 working");
  });

  it("draws no bar for a run with nothing to count, and says why in the count's place", () => {
    const html = render(strip({
      state: "needs", word: "Needs you", done: 0, total: 0, percent: 0, label: "No tasks yet", live: false, needs: 1, planOnly: true,
      side: [{ text: "Plan to approve", strong: true }],
    }));
    expect(html).not.toContain("run-strip-meter");
    expect(words(html)).toBe("Needs you No tasks yet · Plan to approve");
  });

  it("is one button that opens the agents, and one that hides the line", () => {
    const html = render(strip());
    expect(html.match(/<button /g)).toHaveLength(2);
    expect(html).toContain('aria-label="Run: Running, 13 of 22 tasks done, 4 working. Show the agents"');
    expect(html).toContain('aria-label="Hide until something changes"');
    expect(stripSpoken(strip({ side: [] }))).toBe("Run: Running, 13 of 22 tasks done");
  });

  it("is drawn still, and without the live mark, while no turn is in flight", () => {
    const html = render(strip({ live: false, working: 0, side: [] }));
    expect(html).toContain('<div class="run-strip status-row" data-state="running" role="group"');
    expect(html).not.toContain("data-live");
  });

  it("says a wait that is not the person's in the tooltip and to a screen reader, never on the line", () => {
    const notes = ["1 waiting on the coordinator.", "1 open decision: the host does not say who it waits on."];
    const html = render(strip({ notes }));
    expect(stripTitle(strip({ notes }))).toBe(`Show the agents\n${notes.join("\n")}`);
    expect(html).toContain(`title="Show the agents\n${notes.join("\n")}"`);
    expect(html).toContain(`aria-label="Run: Running, 13 of 22 tasks done, 4 working. ${notes.join(" ")} Show the agents"`);
    // Not a word of it between the tags.
    expect(html.replace(/<[^>]*>/g, "")).not.toMatch(/coordinator|host/);
    expect(stripTitle(strip())).toBe("Show the agents");
  });

  it("says how many runs the chat has live beside the reason for its state", () => {
    const html = render(strip({
      state: "needs", word: "Needs you", live: false, needs: 3, runs: 2,
      side: [{ text: "3 decisions", strong: true }, { text: "2 runs", strong: false }],
    }));
    expect(html).toContain('<b class="run-strip-reason">3 decisions</b>');
    expect(html).toContain('<span class="run-strip-then"> · 2 runs</span>');
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
    // The row's bar and its word, of a worker in trouble or a wait the
    // coordinator has. Nothing of the strip, and nothing that only asks.
    expect(warn).toEqual(['.orch-task.run-row[data-tone="warn"]', '.run-row-note[data-tone="warn"]']);
    for (const selector of ['.run-strip[data-state="needs"] .run-strip-dot', '.run-strip[data-state="needs"] .run-strip-fill',
      '.run-strip[data-state="needs"] .run-strip-reason', '.run-group[data-group="needs"] > .run-group-head', '.run-row-note[data-tone="decide"]']) {
      const found = rules.filter((rule) => rule.selector === selector);
      expect(found.length, selector).toBeGreaterThan(0);
      for (const rule of found) expect(rule.body, selector).toMatch(/var\(--decide\)/);
    }
  });

  it("never fills anything with the accent: it is a tint, or a dot", () => {
    for (const rule of rules.filter((item) => /background(-color)?:[^;]*--accent\b/.test(item.body))) {
      if (rule.selector === ".run-strip[data-live] .run-strip-dot") continue;
      expect(rule.body, rule.selector).toMatch(/color-mix\(in srgb, var\(--accent\) \d+%|var\(--accent-tint\)/);
    }
    expect(code).not.toMatch(/background(-color)?:\s*var\(--(ok|danger|decide|warn)\)\s*;[^}]*color:/);
  });

  it("puts the accent on a turn in flight and on nothing else", () => {
    // A run that is all planned, or whose only worker has stalled, is
    // "Running" too: its state alone must reach no accent.
    const accent = rules.filter((rule) => /var\(--accent\)/.test(rule.body)).map((rule) => rule.selector);
    expect(accent).toEqual([
      ".run-strip[data-live] .run-strip-dot", ".run-strip[data-live] .run-strip-fill", ".orch-task.run-row[data-flight]",
    ]);
    expect(code).not.toMatch(/data-state="running"\][^{]*\{[^}]*--accent/);
    // What is left without it is the page's own grey.
    expect(rules.find((rule) => rule.selector === ".run-strip-dot")!.body).toMatch(/background: var\(--fg-3\)/);
    expect(rules.find((rule) => rule.selector === ".run-strip-fill")!.body).toMatch(/color-mix\(in srgb, var\(--fg-3\)/);
    expect(rules.find((rule) => rule.selector === ".orch-task.run-row")!.body).toMatch(/--row-color: var\(--fg-3\)/);
  });

  it("moves one thing, and stops it for reduced motion", () => {
    const animated = rules.filter((rule) => /(^|[;\s])animation:(?!\s*none)/.test(rule.body)).map((rule) => rule.selector);
    expect(animated).toEqual([".run-strip[data-live] .run-strip-meter::after"]);
    expect(code).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.run-strip\[data-live\] \.run-strip-meter::after \{ animation: none; \}/);
  });

  it("keeps every transition between 130 and 220 ms, easing out, off layout", () => {
    // The strip's own sheet, and the group's it is a row of (its dismiss and
    // the chevron of a row that opens are drawn from there).
    const group = [...statusCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => ({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] }));
    const transitions = [...rules, ...group].flatMap((rule) => [...rule.body.matchAll(/transition:([^;]+);/g)].map((m) => ({ selector: rule.selector, value: m[1].trim() })))
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
        expect(["background", "background-color", "color", "opacity", "transform", "width"], selector).toContain(property);
      }
    }
  });
});

// The one disclosure of a decision card, as markup: what a keyboard and a
// screen reader are given, and what is on the page while it is shut.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FoldBody, FoldLine, FoldToggle, useFold, WholeText } from "./CardFold";
import cardFoldCss from "./CardFold.css?raw";

function Card({ startOpen = false, labels = ["Brief · 12 lines", "Checkout"] }: { startOpen?: boolean; labels?: (string | false)[] }) {
  const fold = useFold("ask-1", { startOpen });
  return (
    <div>
      <FoldLine fold={fold} labels={labels} />
      <FoldBody fold={fold}><p>the whole brief</p></FoldBody>
      <button type="button">Allow</button>
    </div>
  );
}

function Stages({ startOpen = false }: { startOpen?: boolean }) {
  const fold = useFold("plan-1", { parts: 2, startOpen });
  return (
    <div>
      <FoldToggle fold={fold} what="the tasks" />
      <FoldBody fold={fold} part={0} bounded={false}><p>stage one</p></FoldBody>
      <FoldBody fold={fold} part={1} bounded={false}><p>stage two</p></FoldBody>
    </div>
  );
}

describe("the disclosure of a decision card", () => {
  it("is a real button that says whether it is open and what it opens", () => {
    const html = renderToStaticMarkup(<Card />);
    const button = /<button type="button" class="card-fold-toggle" aria-expanded="false" aria-controls="([^"]+)" aria-describedby="([^"]+)" aria-label="Show details" title="Show details"><span class="card-fold-chevron" aria-hidden="true"><\/span><\/button>/.exec(html);
    expect(button).not.toBeNull();
    // What is folded, by name and size, is what describes it.
    expect(html).toContain(`<span class="card-fold-labels" id="${button![2]}"><span>Brief · 12 lines</span><span>Checkout</span></span>`);
    // Shut: the box it names exists, hidden, with nothing in it to tab into
    // or to read out.
    expect(html).toContain(`<div id="${button![1]}" class="card-fold" hidden=""></div>`);
    expect(html).not.toContain("the whole brief");
  });

  it("draws the detail, bounded, once open, and still above the answer", () => {
    const html = renderToStaticMarkup(<Card startOpen />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Hide details" title="Hide details"');
    expect(html).toMatch(/<div id="[^"]+" class="card-fold"><div class="card-fold-in is-bounded"><p>the whole brief<\/p><\/div><\/div>/);
    expect(html.indexOf("the whole brief")).toBeLessThan(html.indexOf(">Allow<"));
  });

  it("draws no line, and so no control, when nothing is folded", () => {
    const html = renderToStaticMarkup(<Card labels={[false]} />);
    expect(html).not.toContain("card-fold-line");
    expect(html).not.toContain("<button type=\"button\" class=\"card-fold-toggle\"");
    expect(html).toContain(">Allow<");
  });

  it("opens several boxes from the one control, and names each", () => {
    const html = renderToStaticMarkup(<Stages startOpen />);
    const controls = /aria-controls="([^"]+)"/.exec(html)![1].split(" ");
    expect(controls).toHaveLength(2);
    expect(new Set(controls).size).toBe(2);
    for (const id of controls) expect(html).toContain(`<div id="${id}" class="card-fold">`);
    expect(html).toContain('aria-label="Hide the tasks"');
    expect(html.match(/card-fold-toggle/g)).toHaveLength(1);
    // A card in the conversation's own scroll has no second one.
    expect(html).not.toContain("is-bounded");
  });
});

describe("a text opened whole", () => {
  it("is every character, with nothing said about a cut there was not", () => {
    const text = "x".repeat(20_000);
    expect(renderToStaticMarkup(<WholeText text={text} />)).toBe(`<pre class="ask-card-body is-whole">${text}</pre>`);
  });

  it("has no cap: past the 200,000 it used to stop at, it is still every character", () => {
    const text = `${"x".repeat(329_000)} LAST WORDS`;
    const html = renderToStaticMarkup(<WholeText text={text} />);
    expect(html).toBe(`<pre class="ask-card-body is-whole">${text}</pre>`);
    expect(html).not.toContain("not shown");
  });
});

describe("how it moves", () => {
  it("opens and shuts on the shared entry tokens, with no timing of its own", () => {
    // Bounded, ease-out, 130 to 220 ms: `--enter-duration` (180ms) and
    // `--enter-reveal-duration` (200ms), stated once in design-system.css.
    const timed = cardFoldCss.match(/(animation|transition):[^;]*;/g) ?? [];
    expect(timed.length).toBeGreaterThan(0);
    for (const rule of timed.filter((rule) => !/:\s*none/.test(rule))) {
      expect(rule, rule).toMatch(/var\(--enter-(reveal-)?duration\)/);
      expect(rule, rule).not.toMatch(/\d+m?s\b/);
      expect(rule, rule).not.toMatch(/cubic-bezier|spring|bounce/);
    }
    expect(cardFoldCss).toContain("enter-reveal var(--enter-reveal-duration) var(--enter-ease)");
  });

  it("does nothing at all under reduced motion", () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(cardFoldCss)?.[1] ?? "";
    for (const selector of [".card-fold.is-opening", ".card-fold.is-opening > .card-fold-in", ".card-fold.is-closing", ".card-fold.is-closing > .card-fold-in"]) {
      expect(reduced, selector).toContain(selector);
    }
    expect(reduced).toContain("animation: none");
  });

  it("puts a long detail in the card's own scroll, and never clips it", () => {
    expect(cardFoldCss).toMatch(/\.card-fold > \.card-fold-in\.is-bounded \{\s*max-height: min\(52vh, 420px\);\s*overflow-y: auto;/);
  });
});

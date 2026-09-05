import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Mascot } from "./Mascot";
import { MODELS } from "../lib/agentProviders";

describe("Mascot", () => {
  const drawn = renderToStaticMarkup(<Mascot />);

  /** The line beside it already says "thinking with max effort" and how long it
   *  has been going. A robot that also announced itself would be read out over
   *  the top of the half that carries the facts. */
  it("says nothing to a screen reader", () => {
    expect(drawn).toContain('aria-hidden="true"');
    expect(drawn).not.toContain("aria-label");
  });

  it("takes its size from the caller", () => {
    expect(renderToStaticMarkup(<Mascot size={28} />)).toContain('width="28"');
  });

  /** Two eyes, and they are separately addressable — the right one blinks a
   *  frame after the left, which is the whole difference between a face and a
   *  shutter. Lose the class and they shut together, silently. */
  it("keeps its eyes apart so they can blink out of step", () => {
    expect(drawn.match(/mascot-eye/g)).toHaveLength(2);
    expect(drawn).toContain("mascot-eye is-right");
  });

  /** The bob is animated on the inner group, never the svg box: the status line
   *  clips its overflow to keep its ellipsis, so a moving box loses its antenna
   *  at the top of every float.
   */
  it("puts everything in a group it can float without moving its box", () => {
    expect(drawn).toContain('class="mascot-body"');
    expect(drawn).not.toMatch(/<svg[^>]*class="mascot-body"/);
  });

  /** Work still running behind the turn used to be an orange dot pulsing beside
   *  the robot's head. It is the robot's eyes now — `BackgroundNote` stops
   *  drawing the dot while a turn runs precisely because this carries it, so
   *  losing the class loses the news entirely rather than merely its colour. */
  it("wears the alert on its face when work is running behind the turn", () => {
    expect(renderToStaticMarkup(<Mascot alert />)).toContain("is-alert");
    expect(drawn).not.toContain("is-alert");
  });

  /** The whole of the per-model idea: the drawing that reaches the page has to
   *  differ, not merely its colour. A recolour of one body would pass every
   *  other test in this file and be ten robots that are all the same robot. */
  it("draws a different robot for every model", () => {
    const bodies = MODELS.map((m) => {
      const svg = renderToStaticMarkup(<Mascot robot={m.composerStyle} />);
      // Everything inside the animated group — the drawing itself, with the
      // wrapper's own attributes (which carry the style name) left out.
      return svg.slice(svg.indexOf('class="mascot-body"'));
    });
    expect(new Set(bodies).size).toBe(MODELS.length);
  });

  /** Ten drawings, and every one of them still a face: two blinking eyes, a
   *  head to put them in, and the lamp that means the turn is alive. It is easy
   *  to add an eleventh robot that is a lovely shape and animates nothing. */
  it("gives every robot the parts the stylesheet animates", () => {
    for (const m of MODELS) {
      const svg = renderToStaticMarkup(<Mascot robot={m.composerStyle} />);
      expect(svg, m.id).toContain("mascot-head");
      expect(svg, m.id).toContain("mascot-lamp");
      expect(svg.match(/mascot-eye/g) ?? [], m.id).toHaveLength(2);
      expect(svg, m.id).toContain("mascot-eye is-right");
    }
  });

  /** The stylesheet does the rest off these two attributes — which palette and
   *  which dance from the first, how fast and how far from the second. */
  it("names its model and its mood for the stylesheet", () => {
    const still = renderToStaticMarkup(<Mascot robot="luna" mood="still" />);
    expect(still).toContain('data-robot="luna"');
    expect(still).toContain('data-mood="still"');
    expect(drawn).toContain('data-mood="work"');
  });

  /** No live process behind it: the eyes hold the blink's own shut frame and a
   *  small z lands in the corner. Only this state wraps the svg — every other
   *  caller keeps the bare drawing it always had. */
  it("closes its eyes and wears a z when asleep", () => {
    const awake = renderToStaticMarkup(<Mascot />);
    const asleep = renderToStaticMarkup(<Mascot asleep />);
    expect(awake).not.toContain("mascot-wrap");
    expect(asleep).toContain('class="mascot-wrap"');
    expect(asleep).toContain("is-asleep");
    expect(asleep).toContain('class="mascot-z"');
    expect(asleep).toContain(">z<");
  });
});

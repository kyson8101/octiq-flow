import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Mascot } from "./Mascot";

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
});

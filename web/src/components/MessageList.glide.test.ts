// The conversation travels to a new bottom instead of jumping to it.
//
// The animation itself is frames and `scrollTop`, which node has neither of;
// what is testable — and what is actually easy to get wrong — is the one
// question each frame asks: given where the reader was, where the bottom is
// NOW, and how far through the travel we are, where should the scroller sit?
import { describe, expect, it, vi } from "vitest";

// Importing the module at all opens the socket, which reads `location` — and
// there is no location in node. The same stub its sibling tests use.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { glideAt } from "./MessageList";

describe("glideAt", () => {
  it("starts where the reader was looking", () => {
    expect(glideAt(100, 500, 0)).toBe(100);
  });

  it("ends on the bottom", () => {
    expect(glideAt(100, 500, 1)).toBe(500);
  });

  it("ends on the bottom the content has NOW, not the one it started with", () => {
    // The whole reason the target is a per-frame argument. A reply streams
    // while the glide runs and the bottom moves out from under it; the last
    // frame still lands on the real bottom, so nothing is left for the resize
    // observer to snap.
    expect(glideAt(100, 900, 1)).toBe(900);
  });

  it("is already most of the way there at the halfway point", () => {
    // easeOutQuint: nearly all the distance early, a long settle after. This is
    // what makes the travel read as the conversation MAKING ROOM rather than
    // as a slow pan — and it is why the arriving bubble can start fading at
    // 110ms of a 280ms travel without appearing before its space exists.
    expect(glideAt(0, 1000, 0.5)).toBeGreaterThan(950);
  });

  it("never goes backwards", () => {
    let last = -Infinity;
    for (let p = 0; p <= 1; p += 0.05) {
      const at = glideAt(0, 1000, p);
      expect(at).toBeGreaterThanOrEqual(last);
      last = at;
    }
  });

  it("clamps a frame that overshot the clock", () => {
    // rAF is not punctual: a busy frame lands after the end of the travel, and
    // an unclamped ease would carry the scroller PAST the bottom and let the
    // browser bounce it back.
    expect(glideAt(100, 500, 1.4)).toBe(500);
    expect(glideAt(100, 500, -0.2)).toBe(100);
  });

  it("travels the other way when the bottom moved up", () => {
    // A turn can shrink the content — a tool card collapsing as it settles. The
    // reader is below the new bottom and is eased back up to it rather than
    // being left hanging past the end.
    expect(glideAt(500, 300, 1)).toBe(300);
    expect(glideAt(500, 300, 0.5)).toBeLessThan(500);
  });
});

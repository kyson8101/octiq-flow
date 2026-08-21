// The arithmetic behind the image viewer's zoom.
//
// Three things are easy to get wrong and impossible to see in a screenshot: a
// scale that can run away past what a viewer can draw, a wheel gesture that
// zooms around the middle of the picture instead of the spot under the pointer,
// and a pan that lets the image be dragged off the edge of the screen and
// stranded there. All three are plain arithmetic, so they are tested here
// rather than eyeballed in the browser.
import { describe, expect, it } from "vitest";

import { anchorPan, clampPan, clampScale, MAX_SCALE, MIN_SCALE, stepScale, wheelScale } from "./zoom";

describe("clampScale", () => {
  it("never goes below fit or above the ceiling", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(999)).toBe(MAX_SCALE);
    expect(clampScale(2)).toBe(2);
  });

  it("treats a broken number as fit rather than passing it on", () => {
    expect(clampScale(Number.NaN)).toBe(MIN_SCALE);
  });
});

describe("stepScale", () => {
  it("walks the stops, so the buttons land on round sizes", () => {
    expect(stepScale(1, 1)).toBe(1.5);
    expect(stepScale(1.5, 1)).toBe(2);
    expect(stepScale(2, -1)).toBe(1.5);
  });

  it("moves off a scale between two stops, not back to the one it is on", () => {
    expect(stepScale(1.7, 1)).toBe(2);
    expect(stepScale(1.7, -1)).toBe(1.5);
  });

  it("stops at both ends", () => {
    expect(stepScale(MIN_SCALE, -1)).toBe(MIN_SCALE);
    expect(stepScale(MAX_SCALE, 1)).toBe(MAX_SCALE);
  });
});

describe("wheelScale", () => {
  it("zooms in when the wheel goes up and out when it goes down", () => {
    expect(wheelScale(1, -100)).toBeGreaterThan(1);
    expect(wheelScale(2, 100)).toBeLessThan(2);
  });

  it("is proportional, so one notch feels the same at every size", () => {
    const a = wheelScale(1, -100) / 1;
    const b = wheelScale(4, -100) / 4;
    expect(a).toBeCloseTo(b, 6);
  });

  it("stays inside the limits however hard the wheel is spun", () => {
    expect(wheelScale(MAX_SCALE, -100000)).toBe(MAX_SCALE);
    expect(wheelScale(1.2, 100000)).toBe(MIN_SCALE);
  });
});

describe("anchorPan", () => {
  it("keeps the point under the pointer where it is", () => {
    // Anchor 100px right of centre, doubling from fit. The pixel that was under
    // the pointer is now twice as far out, so the image has to shift back by
    // exactly as much for the pointer to still be on it.
    expect(anchorPan({ x: 0, y: 0 }, { x: 100, y: 0 }, 1, 2)).toEqual({ x: -100, y: 0 });
  });

  it("leaves the pan alone when the anchor is the centre", () => {
    expect(anchorPan({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, 4)).toEqual({ x: 0, y: 0 });
  });

  it("carries an existing pan through the change", () => {
    expect(anchorPan({ x: 40, y: 0 }, { x: 0, y: 0 }, 2, 1)).toEqual({ x: 20, y: 0 });
  });
});

describe("clampPan", () => {
  const viewport = { w: 800, h: 600 };
  const content = { w: 400, h: 300 };

  it("centres the image while it still fits", () => {
    expect(clampPan({ x: 200, y: 200 }, viewport, content, 1)).toEqual({ x: 0, y: 0 });
  });

  it("allows only the overhang once it is bigger than the screen", () => {
    // 400 × 4 = 1600 wide in an 800 viewport: 400 hangs off each side.
    expect(clampPan({ x: 5000, y: 0 }, viewport, content, 4)).toEqual({ x: 400, y: 0 });
    expect(clampPan({ x: -5000, y: 0 }, viewport, content, 4)).toEqual({ x: -400, y: 0 });
  });

  it("clamps each axis on its own, so a tall image still pans vertically", () => {
    // A tall picture at 1.5×: 600 × 900 in an 800 × 600 viewport. It is
    // narrower than the screen, so x is pinned; 300 of it hangs off top and
    // bottom together, so y may move 150 either way.
    expect(clampPan({ x: 999, y: 999 }, viewport, { w: 400, h: 600 }, 1.5)).toEqual({ x: 0, y: 150 });
  });

  it("says centred when the size is not known yet", () => {
    expect(clampPan({ x: 30, y: 30 }, { w: 0, h: 0 }, { w: 0, h: 0 }, 3)).toEqual({ x: 0, y: 0 });
  });
});

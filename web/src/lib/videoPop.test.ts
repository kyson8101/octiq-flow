import { describe, expect, it } from "vitest";
import { POP_GAIN, popSize } from "./videoPop";

const W = 16 / 9;

describe("popSize", () => {
  it("stays inline at 860 wide and pops at 861", () => {
    expect(popSize({ width: 860, height: 900 }, 100, W)).toBeNull();
    expect(popSize({ width: 861, height: 900 }, 100, W)).not.toBeNull();
  });
  it("needs a 1.3x bigger picture, exactly 1.3x is enough", () => {
    // 1000x900 window: width 904, height-bound 772*16/9 = 1372, so 904.
    const win = { width: 1000, height: 900 };
    expect(popSize(win, 100, W)!.width).toBe(904);
    expect(popSize(win, 904 / POP_GAIN, W)).not.toBeNull();
    expect(popSize(win, 904 / POP_GAIN + 1, W)).toBeNull();
  });
  it("falls back to 16:9 for a bad aspect", () => {
    const want = popSize({ width: 1280, height: 900 }, 100, W);
    for (const bad of [0, -1, NaN, Infinity]) expect(popSize({ width: 1280, height: 900 }, 100, bad)).toEqual(want);
  });
  it("is bound by the window height", () => {
    // maxH = 400 - 128 = 272, width = floor(272 * 16/9) = 483
    expect(popSize({ width: 1400, height: 400 }, 100, W)).toEqual({ width: 483, height: 271 });
  });
  it("caps the width at 1600", () => {
    expect(popSize({ width: 3000, height: 2000 }, 100, W)).toEqual({ width: 1600, height: 900 });
  });
});

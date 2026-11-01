import { describe, expect, it } from "vitest";
import { nextPlaybackRate, playbackRateLabel, PLAYBACK_RATES } from "./playbackSpeed";

describe("playback speed", () => {
  it("cycles through every supported rate including 2x and wraps", () => {
    expect(PLAYBACK_RATES).toEqual([0.5, 1, 1.25, 1.5, 2]);
    expect(PLAYBACK_RATES.map(nextPlaybackRate)).toEqual([1, 1.25, 1.5, 2, 0.5]);
  });
  it("moves from a native rate to the next available rate", () => {
    expect(nextPlaybackRate(0.75)).toBe(1);
    expect(nextPlaybackRate(1.75)).toBe(2);
    expect(nextPlaybackRate(3)).toBe(0.5);
  });
  it("labels integer and fractional rates", () => {
    expect(PLAYBACK_RATES.map(playbackRateLabel)).toEqual(["0.5×", "1×", "1.25×", "1.5×", "2×"]);
  });
});

// The line under the composer while a turn runs.
import { describe, expect, it } from "vitest";

import { elapsedLabel, tokenLabel, workingLine } from "./working";

describe("elapsedLabel", () => {
  it("says seconds under a minute", () => {
    expect(elapsedLabel(0)).toBe("0s");
    expect(elapsedLabel(9_400)).toBe("9s");
    expect(elapsedLabel(59_900)).toBe("59s");
  });

  it("says minutes and seconds under an hour", () => {
    expect(elapsedLabel(60_000)).toBe("1m 00s");
    expect(elapsedLabel(252_000)).toBe("4m 12s");
  });

  it("drops the seconds past an hour, where they stop mattering", () => {
    expect(elapsedLabel(3_600_000)).toBe("1h 00m");
    expect(elapsedLabel(3_960_000)).toBe("1h 06m");
  });

  it("never counts backwards from a clock that jumped", () => {
    expect(elapsedLabel(-5_000)).toBe("0s");
  });
});

describe("tokenLabel", () => {
  it("keeps a decimal where the counter would otherwise look frozen", () => {
    expect(tokenLabel(999)).toBe("999");
    expect(tokenLabel(1_000)).toBe("1.0k");
    expect(tokenLabel(16_543)).toBe("16.5k");
  });

  it("rounds once the count is big enough not to need it", () => {
    expect(tokenLabel(100_400)).toBe("100k");
    expect(tokenLabel(1_250_000)).toBe("1.3M");
  });
});

describe("workingLine", () => {
  it("reads as the CLI's own: how long, how much, how hard", () => {
    expect(
      workingLine({ elapsedMs: 252_000, tokens: 16_543, thinking: true, effort: "very high" }),
    ).toBe("4m 12s · ↓ 16.5k tokens · thinking with very high effort");
  });

  it("leaves out what it does not know yet", () => {
    expect(workingLine({ elapsedMs: 3_000 })).toBe("3s · working…");
    expect(workingLine({})).toBe("working…");
  });

  it("says thinking without the effort when nobody said which", () => {
    expect(workingLine({ elapsedMs: 3_000, thinking: true })).toBe("3s · thinking…");
  });

  it("lets a named activity speak instead — it is the more specific news", () => {
    expect(
      workingLine({
        elapsedMs: 63_000,
        tokens: 2_100,
        thinking: true,
        effort: "high",
        activity: "Compacting the conversation to make room…",
      }),
    ).toBe("1m 03s · ↓ 2.1k tokens · Compacting the conversation to make room…");
  });
});

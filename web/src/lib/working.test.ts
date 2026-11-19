// The line under the composer while a turn runs.
import { describe, expect, it } from "vitest";

import { elapsedLabel, workingLine } from "./working";

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

describe("workingLine", () => {
  it("keeps time and thinking, with no token or effort noise", () => {
    expect(workingLine({ elapsedMs: 252_000, thinking: true })).toBe("4m 12s · thinking…");
  });
  it("leaves out an unknown clock", () => {
    expect(workingLine({})).toBe("working…");
    expect(workingLine({ elapsedMs: 3_000 })).toBe("3s · working…");
  });
  it("keeps the more specific activity", () => {
    expect(workingLine({ elapsedMs: 63_000, thinking: true, activity: "Compacting the conversation to make room…" }))
      .toBe("1m 03s · Compacting the conversation to make room…");
  });
});

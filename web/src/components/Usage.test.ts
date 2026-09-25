import { describe, expect, it, vi } from "vitest";
import { barWindow, usageLabel, usageSummary } from "./Usage";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));

describe("top-bar usage window", () => {
  it("shows Claude's five-hour window when it has the highest usage", () => {
    expect(
      barWindow({
        available: true,
        fiveHour: { percent: 82 },
        weekly: { percent: 37 },
        models: [{ name: "Sonnet", percent: 51 }],
      }),
    ).toEqual({ label: "5h", window: { percent: 82 } });
  });

  it("compares weekly and model-specific windows too", () => {
    expect(
      barWindow({
        available: true,
        fiveHour: { percent: 12 },
        weekly: { percent: 64 },
        models: [{ name: "Opus", percent: 91 }],
      }),
    ).toEqual({ label: "Opus", window: { name: "Opus", percent: 91 } });
  });

  it("returns no window when the provider has no usage readings", () => {
    expect(barWindow({ available: false })).toBeNull();
  });
});

describe("the one top-bar usage figure", () => {
  it("shows the fullest window across both agents", () => {
    expect(usageSummary({
      claude: { available: true, fiveHour: { percent: 40 }, weekly: { percent: 22 } },
      codex: { available: true, weekly: { percent: 73 } },
    })).toEqual({ provider: "codex", label: "7d", percent: 73 });
  });

  it("clamps a reading outside 0-100 and says nothing without one", () => {
    expect(usageSummary({ claude: { available: true, fiveHour: { percent: 140 } }, codex: null }))
      .toEqual({ provider: "claude", label: "5h", percent: 100 });
    expect(usageSummary({ claude: null, codex: { available: false } })).toBeNull();
  });

  it("names every agent's fullest window to a screen reader", () => {
    expect(usageLabel({
      claude: { available: true, fiveHour: { percent: 40.4 } },
      codex: { available: true, weekly: { percent: 73 } },
    })).toBe("Plan usage: Claude 5h 40%, Codex 7d 73%");
    expect(usageLabel({ claude: null, codex: null })).toBe("Plan usage: no reading yet");
  });
});

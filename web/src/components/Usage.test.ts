import { describe, expect, it, vi } from "vitest";
import { barWindow } from "./Usage";

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

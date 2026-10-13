import { describe, expect, it } from "vitest";
import {
  barWindow, cellTitle, resetIn, severity, usageCells, usageLabel, usageRowLabel, usageSummary,
  type UsageData,
} from "./usageWindows";

describe("one agent's fullest usage window", () => {
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

describe("the one usage figure a phone shows", () => {
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

describe("the desktop usage row", () => {
  const FRESH = { claude: false, codex: false };
  const NOW = 1_800_000_000_000;
  const at = (seconds: number) => NOW / 1000 + seconds;
  const all: UsageData = {
    claude: {
      available: true,
      fiveHour: { percent: 42, resetsAt: at(2 * 3600 + 40 * 60) },
      weekly: { percent: 61.5, resetsAt: at(3 * 86400 + 2 * 3600) },
      models: [{ name: "opus", percent: 88 }, { name: "fable", percent: 12 }],
    },
    codex: { available: true, fiveHour: { percent: 5 }, weekly: { percent: 30 } },
  };

  it("draws every window the host reports, each agent's five hours, week, then its models", () => {
    expect(usageCells(all, FRESH).map((cell) => cell.label)).toEqual([
      "Claude 5h", "Claude week", "Opus week", "Fable week", "Codex 5h", "Codex week",
    ]);
  });

  it("leaves out a window the host does not report", () => {
    const data: UsageData = {
      claude: { available: true, weekly: { percent: 10 } },
      codex: { available: true, weekly: { percent: 20 } },
    };
    expect(usageCells(data, FRESH).map((cell) => cell.label)).toEqual(["Claude week", "Codex week"]);
  });

  it("has no Antigravity cell: only the two agents with limits are read", () => {
    const cells = usageCells(all, FRESH);
    expect(new Set(cells.map((cell) => cell.provider))).toEqual(new Set(["claude", "codex"]));
    expect(cells.map((cell) => cell.label).join(" ")).not.toMatch(/antigravity/i);
  });

  it("shows an agent with no reading as its name, no number and the host's note", () => {
    const cells = usageCells({
      claude: { available: false, note: "Claude is not signed in." },
      codex: null,
    }, { claude: true, codex: true });
    expect(cells).toEqual([
      { provider: "claude", key: "claude", label: "Claude", name: "Claude", percent: null, stale: false, note: "Claude is not signed in." },
      { provider: "codex", key: "codex", label: "Codex", name: "Codex", percent: null, stale: false, note: "No reading yet." },
    ]);
    expect(cellTitle(cells[0], NOW)).toBe("Claude: Claude is not signed in.");
    expect(cellTitle(cells[1], NOW)).toBe("Codex: No reading yet.");
  });

  it("marks the last good reading of an agent whose newest ask failed", () => {
    const cells = usageCells(all, { claude: true, codex: false });
    expect(cells.filter((cell) => cell.stale).map((cell) => cell.provider)).toEqual(["claude", "claude", "claude", "claude"]);
    expect(cellTitle(cells[0], NOW)).toBe("Claude 5-hour window: 42% used · resets in 2h 40m · last known");
  });

  it("puts the reset time in the tooltip, and nothing after a window with none", () => {
    const cells = usageCells(all, FRESH);
    expect(cellTitle(cells[1], NOW)).toBe("Claude weekly window: 61.5% used · resets in 3d 2h");
    expect(cellTitle(cells[2], NOW)).toBe("Claude weekly window for Opus: 88% used");
    expect(resetIn(at(-5), NOW)).toBe("resetting");
    expect(resetIn(at(59 * 60), NOW)).toBe("resets in 59m");
    expect(resetIn(null, NOW)).toBe("");
  });

  it("clamps a reading outside 0-100", () => {
    const cells = usageCells({ claude: { available: true, weekly: { percent: 140 } }, codex: { available: true, weekly: { percent: -3 } } }, FRESH);
    expect(cells.map((cell) => cell.percent)).toEqual([100, 0]);
  });

  it("is calm below 60, a warning from 60 and hot from 85", () => {
    expect([0, 59.9, 60, 84.9, 85, 100].map(severity)).toEqual(["", "", "is-warn", "is-warn", "is-danger", "is-danger"]);
  });

  it("says every window in one sentence for the control that opens the breakdown", () => {
    const label = usageRowLabel(usageCells(all, FRESH), NOW);
    expect(label.startsWith("Plan usage. Claude 5-hour window: 42% used · resets in 2h 40m. ")).toBe(true);
    expect(label).toContain("Codex weekly window: 30% used");
    expect(usageRowLabel([], NOW)).toBe("Plan usage: no reading yet");
  });
});

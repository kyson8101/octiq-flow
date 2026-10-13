import { describe, expect, it } from "vitest";
import { knownSettings, receiptLines, runsAtLine } from "./chatSettings";

const opus = { agent: "claude" as const, model: "Opus" };
const held = { choice: opus, effort: "high" as const, access: "auto" as const };

describe("what a chat runs at, beside the agent's name", () => {
  it("says model, effort and access in a few quiet words", () => {
    const known = knownSettings({ ...held, record: { modelId: "claude:opus", permission: "auto", effort: "high" } });
    expect(known).toEqual({ model: "Opus", effort: "High", access: "Auto" });
    expect(runsAtLine(known)).toBe("opus · high · Auto");
  });

  it("uses the names the provider's own pickers give each level", () => {
    const known = knownSettings({
      choice: opus, effort: "xhigh", access: "full",
      record: { modelId: "claude:opus", permission: "full", effort: "xhigh" },
    });
    expect(runsAtLine(known)).toBe("opus · very high · Bypass permissions");
  });

  it("says everything for a conversation not saved yet: it starts with what the page holds", () => {
    expect(runsAtLine(knownSettings({ ...held, record: null }))).toBe("opus · high · Auto");
  });

  it("leaves out what a saved chat's record does not say, and never guesses it", () => {
    // A chat from before effort was kept: the page still holds an effort, the
    // last chat's, and it says nothing of this one.
    expect(runsAtLine(knownSettings({ ...held, record: { modelId: "claude:opus", permission: "auto" } }))).toBe("opus · Auto");
    expect(runsAtLine(knownSettings({ ...held, record: { modelId: "claude:opus", effort: "high", permission: null } }))).toBe("opus · high");
    // A record with nothing, and a chat whose record has not been read yet.
    expect(runsAtLine(knownSettings({ ...held, record: {} }))).toBe("");
    expect(runsAtLine(knownSettings({ ...held, record: undefined }))).toBe("");
  });

  it("takes the model from the agent's own report when the record names none", () => {
    expect(runsAtLine(knownSettings({ ...held, record: {}, reported: "claude-opus-5" }))).toBe("opus");
  });

  it("leaves out a level the chat's provider does not offer", () => {
    const known = knownSettings({
      choice: { agent: "codex", model: "Sol" }, effort: "ultracode", access: "auto",
      record: { modelId: "codex:sol", permission: "auto", effort: "ultracode" },
    });
    expect(known.effort).toBeUndefined();
    expect(runsAtLine(known)).toMatch(/^sol · /);
  });
});

describe("the last turn's receipt, for a tooltip", () => {
  it("is a line for each figure that has arrived", () => {
    expect(receiptLines(178_100, 9.526)).toEqual(["Last turn · 178.1s", "Cost · $9.526"]);
    expect(receiptLines(178_100)).toEqual(["Last turn · 178.1s"]);
    expect(receiptLines(undefined, 0)).toEqual(["Cost · $0.000"]);
    expect(receiptLines()).toEqual([]);
  });
});

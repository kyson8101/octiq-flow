import { describe, expect, it, vi } from "vitest";

// `agentsMode` reads the roster over the socket bridge, which opens a
// connection as it is imported.
vi.mock("./bridge", () => ({ bridge: { invoke: async () => [] } }));
import { knownSettings, receiptLines, runsAtLine, runsAtParts, runsAtRows } from "./chatSettings";
import { leadSettings, type TeamAgent } from "./agentsMode";
import { accessFor, modelFromId, type AccessLevel } from "./agentProviders";

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

describe("the line in the two parts the composer draws", () => {
  const all = { model: "Opus latest", effort: "High", access: "Plan" };

  it("puts the access last, with its own separator, so it is the part a narrow composer keeps", () => {
    expect(runsAtParts(all)).toEqual({ rest: "opus latest · high", access: " · Plan" });
    // Joined, the two are the line.
    const { rest, access } = runsAtParts(all);
    expect(rest + access).toBe(runsAtLine(all));
  });

  it("leaves out what the page does not know, and never a stray separator", () => {
    expect(runsAtParts({ access: "Plan" })).toEqual({ rest: "", access: "Plan" });
    expect(runsAtParts({ model: "Opus", effort: "High" })).toEqual({ rest: "opus · high", access: "" });
    expect(runsAtParts({ effort: "High", access: "Auto" })).toEqual({ rest: "high", access: " · Auto" });
    expect(runsAtParts({})).toEqual({ rest: "", access: "" });
    for (const known of [{ access: "Plan" }, { model: "Opus" }, { effort: "High", access: "Auto" }, {}]) {
      const { rest, access } = runsAtParts(known);
      expect(rest + access).toBe(runsAtLine(known));
    }
  });

  it("is said whole in the disclosure, a row each, as the pickers name the values", () => {
    expect(runsAtRows(all)).toEqual([
      { label: "Model", value: "Opus latest" }, { label: "Effort", value: "High" }, { label: "Access", value: "Plan" },
    ]);
    expect(runsAtRows({ model: "Sonnet" })).toEqual([{ label: "Model", value: "Sonnet" }]);
    expect(runsAtRows({})).toEqual([]);
  });

  it("is this session's, from the page's own values and never the registration's", () => {
    // A saved chat whose record says Plan, under a registration that says
    // Auto: the page holds the chat's own level, and that is what is said.
    const known = knownSettings({
      record: { modelId: "claude:opus", effort: "high", permission: "read" },
      choice: { agent: "claude", model: "Opus latest" }, effort: "high", access: "read",
    });
    expect(runsAtRows(known).find((row) => row.label === "Access")?.value).toBe(runsAtParts(known).access.replace(" · ", ""));
    expect(runsAtLine(known)).toMatch(/^opus latest · high · /);
  });
});

// 0.3.10: a chat opens on its agent's registered settings and then keeps the
// level it has. The page holds that level, saves it with the chat and asks
// for it at the next start; nothing raises or narrows it to the
// registration's (AGENTS.md, "A chat's level is its own").
describe("a chat whose level is not its agent's registered one", () => {
  const ryan: TeamAgent = {
    id: "agent_ryan", name: "Ryan", role: "CTO", agent: "claude", model: "opus",
    effort: "high", access: "auto", createdAt: 1, updatedAt: 1,
  };
  const registered = leadSettings(ryan)!;

  /** What the page holds for a saved chat it opens: its record's level, as
   *  `App`'s `openConversation` takes it. */
  const opened = (record: { modelId: string; effort: string; permission: string }) => {
    const choice = modelFromId(record.modelId)!;
    return knownSettings({
      record, choice, effort: registered.effort,
      access: accessFor(choice.agent, record.permission as AccessLevel),
    });
  };

  it("says Plan for a chat the person put at Plan, under an agent registered at Auto", () => {
    expect(registered.access).toBe("auto");
    const known = opened({ modelId: registered.choice.id, effort: "high", permission: "read" });
    expect(known.access).toBe("Plan");
    expect(runsAtParts(known).access).toBe(" · Plan");
    expect(runsAtRows(known)).toContainEqual({ label: "Access", value: "Plan" });
    expect(runsAtLine(known)).not.toContain("Auto");
  });

  it("says the higher level for a chat an access card raised past its agent's", () => {
    const known = opened({ modelId: registered.choice.id, effort: "high", permission: "full" });
    expect(known.access).toBe("Bypass permissions");
    expect(runsAtLine(known)).toMatch(/ · Bypass permissions$/);
  });

  it("says the registration's level only where that is what the chat has", () => {
    // A conversation not saved yet: the page copied the registration in.
    expect(knownSettings({ record: null, ...registered }).access).toBe("Auto");
    // A chat an earlier build opened read-only and the host lifted at
    // startup: its record says the lifted level, and so does the text.
    expect(opened({ modelId: registered.choice.id, effort: "high", permission: "auto" }).access).toBe("Auto");
  });

  it("is given no registration to read: the level is the one handed in, whatever the agent has", () => {
    const record = { modelId: registered.choice.id, effort: "high", permission: "read" };
    for (const access of ["read", "manual", "edits", "auto", "full"] as const) {
      const known = knownSettings({ record, choice: registered.choice, effort: "high", access });
      expect(known.access).toBe({ read: "Plan", manual: "Manual", edits: "Accept edits", auto: "Auto", full: "Bypass permissions" }[access]);
    }
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

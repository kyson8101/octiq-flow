import { describe, expect, it } from "vitest";
import type { AgentRow } from "../agentsDashboard";
import { agentModes, ago, grantBrief } from "./reading";
import type { Wish } from "./model";

const row = (id: string, state: AgentRow["state"], extra: Partial<AgentRow> = {}): AgentRow => ({
  id, name: id, detail: "", effort: null, reportsTo: null, role: "", scope: null, team: null, depth: 0, removed: false,
  state, stateLabel: "", activities: [], counts: {}, recent: null, ...extra,
});

const activity = (state: AgentRow["state"], title: string) => ({
  key: title, kind: "lead" as const, state, label: "", title, project: null, chatKey: "chat:x", at: 0,
});

describe("what an agent's robot does", () => {
  it("follows the agent's one reading: work, a card, a failure, or free", () => {
    const now = 10 * 60_000;
    const modes = agentModes([
      row("a", "working", { activities: [activity("working", "Fix the login page")] }),
      row("b", "needs_you", { activities: [activity("needs_you", "Plan to approve")] }),
      row("c", "failed", { activities: [activity("failed", "Release")] }),
      row("d", "idle", { recent: { chatKey: "chat:d", title: "Old", at: 0 } }),
      row("e", "queued"),
    ], now);
    expect(modes.get("agent:a")).toEqual({ state: "working", label: "Fix the login page" });
    expect(modes.get("agent:b")).toEqual({ state: "needs_you", label: "Plan to approve" });
    expect(modes.get("agent:c")).toEqual({ state: "failed", label: "Release" });
    // Free, and ten minutes since it last touched anything.
    expect(modes.get("agent:d")).toEqual({ state: "free", idleFor: 10 });
    expect(modes.get("agent:e")).toEqual({ state: "free" });
  });
});

describe("granting a wish", () => {
  const wish: Wish = {
    id: "w_7", who: { kind: "bot", id: "b1" }, want: "accessory", slot: "neck",
    text: "a red scarf — the cliff path gets windy at night", madeAt: 0, state: "open",
  };

  it("hands the new chat the host's own words when it sent them", () => {
    expect(grantBrief({ ...wish, brief: "The host's brief." }, "Pip")).toBe("The host's brief.");
  });

  it("makes the same sentences from an older host that sent none", () => {
    const brief = grantBrief(wish, "Pip");
    expect(brief).toContain("Pip wishes for a red scarf");
    expect(brief).toContain("(wish w_7)");
    for (const tool of ["island_look", "island_build", "island_grant"]) expect(brief).toContain(tool);
    expect(brief).toContain("neck slot");
  });
});

describe("how long ago", () => {
  it("says it in a word or two", () => {
    const now = 1_000_000_000;
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(ago(now - 2 * 86_400_000, now)).toBe("2 d ago");
  });
});

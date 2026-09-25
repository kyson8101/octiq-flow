import { describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({ bridge: { invoke: async () => [] } }));
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readTaskBrief } from "./taskBrief";
import { leadOnly, leadSettings, teamModels, type TeamAgent } from "./agentsMode";
import { titleFrom } from "./store";
import { LeadPicker } from "../components/AgentsSettings";
import type { Message } from "./chat";

const BRIEFED = "Fix the login bug\n\n=== OctiqFlow agents mode ===\nLead: Ada\n\nYou are Ada…";

const ada: TeamAgent = {
  id: "agent_1", name: "Ada", role: "reviews code", agent: "claude", model: "opus",
  effort: "high", access: "auto", createdAt: 1, updatedAt: 1,
};

describe("agents mode", () => {
  it("splits a task message into the words and the lead", () => {
    expect(readTaskBrief(BRIEFED)).toEqual({ task: "Fix the login bug", lead: "Ada" });
    expect(readTaskBrief("an ordinary message")).toBeUndefined();
  });

  it("names the chat after the task, not the brief", () => {
    const first: Message = { id: "u0", role: "user", blocks: [{ kind: "text", text: BRIEFED }], streaming: false };
    expect(titleFrom([first])).toBe("Fix the login bug");
  });

  it("starts a lead on its own model, effort and access", () => {
    const settings = leadSettings(ada);
    expect(settings?.choice.flag).toBe("opus");
    expect(settings?.effort).toBe("high");
    expect(settings?.access).toBe("auto");
    expect(leadSettings({ ...ada, model: "not-a-model" })).toBeNull();
  });

  it("keeps Fable and Astra as leads only, and never offers Default", () => {
    expect(leadOnly({ model: "fable" })).toBe(true);
    expect(leadOnly({ model: "gpt-6-astra" })).toBe(true);
    expect(leadOnly({ model: "sonnet" })).toBe(false);
    expect(teamModels("codex").every((m) => m.flag)).toBe(true);
  });

  it("offers the registered agents, or a way to add one", () => {
    const noop = () => {};
    const empty = renderToStaticMarkup(createElement(LeadPicker, { team: [], leadId: null, onPick: noop, onManage: noop }));
    expect(empty).toContain("No agents registered yet");
    const one = renderToStaticMarkup(createElement(LeadPicker, { team: [ada], leadId: "agent_1", onPick: noop, onManage: noop }));
    expect(one).toContain("Ada");
    expect(one).toContain('aria-checked="true"');
  });
});

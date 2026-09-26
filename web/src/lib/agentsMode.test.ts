import { describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({ bridge: { invoke: async () => [] } }));
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readTaskBrief } from "./taskBrief";
import {
  conversationRecipient, conversationRecipients, headConversation, leadOnly, leadSettings, teamModels,
  type TeamAgent,
} from "./agentsMode";
import { titleFrom } from "./store";
import { RecipientPicker } from "../components/AgentsSettings";
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

  it("reopens only the head's own conversation, newest first", () => {
    const record = (chatKey: string, leadId: string, createdAt: number, crossProject = true) =>
      ({ chatKey, leadId, leadName: leadId, projectId: "general", crossProject, createdAt });
    const leads = [
      record("chat:old", "ryan", 1),
      record("chat:new", "ryan", 3),
      record("chat:gone", "ryan", 9),
      record("chat:task", "ryan", 5, false),
      record("chat:maya", "maya", 7),
    ];
    const exists = (key: string) => key !== "chat:gone";
    expect(headConversation(leads, "ryan", exists)?.chatKey).toBe("chat:new");
    // A new head never inherits the old head's history.
    expect(headConversation(leads, "maya", exists)?.chatKey).toBe("chat:maya");
    expect(headConversation(leads, "zed", exists)).toBeNull();
    expect(headConversation(leads, null, exists)).toBeNull();
  });

  it("keeps Fable and Astra as leads only, and never offers Default", () => {
    expect(leadOnly({ model: "fable" })).toBe(true);
    expect(leadOnly({ model: "gpt-6-astra" })).toBe(true);
    expect(leadOnly({ model: "sonnet" })).toBe(false);
    expect(teamModels("codex").every((m) => m.flag)).toBe(true);
  });

  it("offers only agents reporting to the person, head first, whatever their scope", () => {
    const agent = (id: string, extra: Partial<TeamAgent> = {}): TeamAgent => ({ ...ada, id, name: id, ...extra });
    const roster = [
      agent("Zoe"), // global, at the top, not the head
      agent("Mango", { projectId: "flow", reportsTo: "Potato" }), // project report of the head
      agent("Vesper", { projectId: "site" }), // project agent at the top
      agent("Aria", { projectId: "site", reportsTo: "Vesper" }),
      agent("Glen", { reportsTo: "Potato" }), // a GLOBAL report is still a report
      agent("Orphan", { projectId: "flow", reportsTo: "gone" }), // its manager was removed
      agent("Potato"),
    ];
    expect(conversationRecipients(roster, "Potato").map((a) => a.id)).toEqual(["Potato", "Orphan", "Vesper", "Zoe"]);
    // A project agent whose project was removed has nowhere to work.
    expect(conversationRecipients(roster, "Potato", (id) => id !== "site").map((a) => a.id)).toEqual(["Potato", "Orphan", "Zoe"]);
    // No head configured: just by name.
    expect(conversationRecipients(roster, null).map((a) => a.id)).toEqual(["Orphan", "Potato", "Vesper", "Zoe"]);
    // A head someone manages is not offered, and is not the default either.
    const headUnder = conversationRecipients([...roster.filter((a) => a.id !== "Glen"), agent("Glen", { reportsTo: "Zoe" })], "Glen");
    expect(headUnder.map((a) => a.id)).not.toContain("Glen");
  });

  it("defaults a new conversation to the head, and keeps a pick only where it works", () => {
    const potato = { ...ada, id: "potato", name: "Potato" };
    const zoe = { ...ada, id: "zoe", name: "Zoe" };
    const vesper = { ...ada, id: "vesper", name: "Vesper", projectId: "site" };
    const recipients = [potato, vesper, zoe];
    const pick = (pickedId: string | null, projectId: string | null, headId: string | null = "potato") =>
      conversationRecipient({ recipients, pickedId, headId, projectId })?.id ?? null;
    expect(pick(null, null)).toBe("potato");
    expect(pick(null, "site")).toBe("potato"); // first load in Vesper's project still opens on the head
    expect(pick("vesper", "site")).toBe("vesper");
    expect(pick("zoe", "flow")).toBe("zoe");
    // Moved to another project, a project agent's pick lapses to the default.
    expect(pick("vesper", "flow")).toBe("potato");
    expect(pick("gone", null)).toBe("potato");
    // No head: the first global agent, then one that works in this project.
    expect(conversationRecipient({ recipients: [vesper, zoe], pickedId: null, headId: null, projectId: "site" })?.id).toBe("zoe");
    expect(conversationRecipient({ recipients: [vesper], pickedId: null, headId: null, projectId: "site" })?.id).toBe("vesper");
    expect(conversationRecipient({ recipients: [vesper], pickedId: null, headId: null, projectId: "flow" })).toBeNull();
  });

  it("draws the choice as a radio group, or a way to add an agent", () => {
    const noop = () => {};
    const names = (id: string) => (id === "site" ? "Website" : undefined);
    const render = (agents: TeamAgent[], selectedId: string | null) => renderToStaticMarkup(
      createElement(RecipientPicker, { agents, selectedId, projectName: names, onPick: noop, onManage: noop }),
    );
    expect(render([], null)).toContain("No agent reports to you yet");
    expect(render([ada], "agent_1")).toBe("");
    // One agent and no default (it works in another project): still pickable.
    expect(render([ada], null)).toContain('aria-checked="false" tabindex="0"');
    const vesper = { ...ada, id: "vesper", name: "Vesper", projectId: "site" };
    const two = render([ada, vesper], "vesper");
    expect(two).toContain('role="radiogroup" aria-label="Talk to"');
    expect(two).toMatch(/aria-checked="false" tabindex="-1"[^>]*>.*Ada/);
    expect(two).toMatch(/aria-checked="true" tabindex="0"[^>]*>.*Vesper.*Website/);
  });
});

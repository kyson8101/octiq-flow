import { describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({ bridge: { invoke: async () => [] } }));
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readTaskBrief } from "./taskBrief";
import {
  conversationAgent, conversationRecipient, conversationRecipients, headConversation, leadOnly, leadSettings, startAccess,
  teamModelLabel, teamModels,
  type TeamAgent,
} from "./agentsMode";
import type { AccessLevel } from "./agentProviders";
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

  it("names a registered agent's model the way a person reads it", () => {
    expect(teamModelLabel({ agent: "claude", model: "claude-sonnet-5-5" })).toBe("Sonnet 5.5");
    // An id the picker does not list yet is still spelled out, not printed raw.
    expect(teamModelLabel({ agent: "claude", model: "claude-opus-9-1" })).toBe("Opus 9.1");
    // Anything else keeps the stored id rather than guessing.
    expect(teamModelLabel({ agent: "codex", model: "gpt-9-unknown" })).toBe("gpt-9-unknown");
    expect(teamModelLabel({ agent: "claude", model: "my-proxy-model" })).toBe("my-proxy-model");
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

// A registered agent's chat runs on that agent's registered access. The page
// once opened discussions read-only and saved that level on the chat; such a
// chat is started at its agent's level again, and nothing is ever lowered.
describe("the level a conversation starts at", () => {
  const leads = [{ chatKey: "chat:c1", leadId: "agent_1" }];
  const registered = (access: AccessLevel, agent: TeamAgent["agent"] = "claude") => ({ ...ada, agent, access });
  const levelOf = (saved: AccessLevel, roster: TeamAgent[], chatKey = "chat:c1") =>
    startAccess(saved, conversationAgent(chatKey, leads, roster));

  it.each<[string, AccessLevel, TeamAgent[], AccessLevel]>([
    ["saved read, registered auto", "read", [registered("auto")], "auto"],
    ["saved manual, registered edits", "manual", [registered("edits")], "edits"],
    ["saved full, registered auto: a raise the person approved is kept", "full", [registered("auto")], "full"],
    ["saved read, registered read", "read", [registered("read")], "read"],
    ["saved auto, registered auto", "auto", [registered("auto")], "auto"],
    ["the agent was removed", "read", [{ ...ada, id: "someone_else" }], "read"],
    ["the roster has not been read yet", "read", [], "read"],
  ])("%s", (_name, saved, roster, level) => {
    expect(levelOf(saved, roster)).toBe(level);
  });

  it("leaves a chat with no registered agent at its saved level", () => {
    expect(levelOf("read", [registered("full")], "chat:ordinary")).toBe("read");
    expect(startAccess("read", null)).toBe("read");
    expect(startAccess("read", undefined)).toBe("read");
    expect(conversationAgent("chat:orch-worker", leads, [ada])).toBeNull();
  });

  it("answers a level the provider the chat starts with offers", () => {
    // Antigravity has no Manual: the registered level is read as that
    // provider reads it, and a saved level is never lowered to it.
    expect(startAccess("read", registered("manual", "antigravity"))).toBe("read");
    expect(startAccess("edits", registered("manual", "antigravity"))).toBe("edits");
    expect(startAccess("read", registered("auto", "antigravity"))).toBe("auto");
    // The chat is started with its own provider, whatever the agent is now.
    expect(startAccess("read", registered("manual", "claude"), "antigravity")).toBe("read");
    expect(startAccess("read", registered("auto", "codex"), "claude")).toBe("auto");
  });

  it("is the roster's word once the roster arrives", () => {
    // Opened before the roster was read: the saved level. Asked again when a
    // message is sent, by which time the roster is there.
    expect(levelOf("read", [])).toBe("read");
    expect(levelOf("read", [registered("auto")])).toBe("auto");
  });
});

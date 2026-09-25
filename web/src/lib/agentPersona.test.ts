import { describe, expect, it } from "vitest";
import {
  composerPlaceholder, personaFor, personaHue, personaInitials, personaTitle, senderName,
} from "./agentPersona";
import type { LeadRecord } from "./agentsDashboard";

const lead = (chatKey: string, leadId: string, leadName: string): LeadRecord => ({
  chatKey, leadId, leadName, projectId: "p1", createdAt: 1,
});

describe("personaFor", () => {
  const roster = [{ id: "a1", name: "Maya", role: "Developer", avatar: "data:image/png;base64,AA==" }];

  it("speaks as the registered agent, by its current name and picture", () => {
    const persona = personaFor("chat:1", [lead("chat:1", "a1", "Old name")], roster);
    expect(persona).toEqual({ id: "a1", name: "Maya", role: "Developer", avatar: "data:image/png;base64,AA==" });
  });

  it("keeps the handed-to name when the agent was removed", () => {
    expect(personaFor("chat:1", [lead("chat:1", "gone", "Ravi")], roster)).toEqual({ name: "Ravi", removed: true });
  });

  it("finds a worker chat through its task's assignee", () => {
    const workers = new Map([["chat:orch-9", { id: "a1", name: "Maya" }]]);
    expect(personaFor("chat:orch-9", [], roster, workers)?.name).toBe("Maya");
  });

  it("gives an ordinary chat no persona", () => {
    expect(personaFor("chat:2", [lead("chat:1", "a1", "Maya")], roster)).toBeNull();
    expect(personaFor(null, [], roster)).toBeNull();
  });
});

describe("persona labels", () => {
  it("falls back to the provider for ordinary chats", () => {
    expect(senderName(null, "Codex")).toBe("Codex");
    expect(senderName({ name: "Maya" }, "Codex")).toBe("Maya");
    expect(composerPlaceholder(null, "Claude")).toBe("Ask Claude to…");
    expect(composerPlaceholder({ name: "Maya" }, "Claude")).toBe("Message Maya…");
  });

  it("never replaces a title the chat already has", () => {
    expect(personaTitle("Fix the bar", { name: "Maya" }, "Chat")).toBe("Fix the bar");
    expect(personaTitle("  ", { name: "Maya" }, "Chat")).toBe("Conversation with Maya");
    expect(personaTitle(undefined, null, "Chat")).toBe("Chat");
  });

  it("draws stable initials and colours", () => {
    expect(personaInitials("Potato Juice")).toBe("PJ");
    expect(personaInitials("maya")).toBe("MA");
    expect(personaInitials(" ")).toBe("?");
    expect(personaHue("agent_1")).toBe(personaHue("agent_1"));
    expect(personaHue("agent_1")).toBeGreaterThanOrEqual(0);
  });
});

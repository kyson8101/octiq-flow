import { describe, expect, it } from "vitest";
import {
  composerPlaceholder, keepAssignees, personaFor, personaHue, personaInitials, personaTitle, senderName,
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

describe("who each worker chat belongs to, kept by content", () => {
  const map = (...rows: [string, string, string][]) => new Map(rows.map(([chat, id, name]) => [chat, { id, name }]));

  it("keeps the map it already has when the ledger says the same thing again", () => {
    const before = map(["chat:orch-1", "a1", "Ada"], ["chat:orch-2", "a2", "Bo"]);
    // Rebuilt from a ledger in which only a worker's progress moved.
    expect(keepAssignees(before, map(["chat:orch-1", "a1", "Ada"], ["chat:orch-2", "a2", "Bo"]))).toBe(before);
    expect(keepAssignees(before, map(["chat:orch-2", "a2", "Bo"], ["chat:orch-1", "a1", "Ada"]))).toBe(before);
    expect(keepAssignees(before, before)).toBe(before);
    const empty = map();
    expect(keepAssignees(empty, map())).toBe(empty);
  });

  it("takes the new one when a task changed hands, a worker was added, renamed or went", () => {
    const before = map(["chat:orch-1", "a1", "Ada"], ["chat:orch-2", "a2", "Bo"]);
    for (const next of [
      map(["chat:orch-1", "a3", "Cy"], ["chat:orch-2", "a2", "Bo"]),
      map(["chat:orch-1", "a1", "Ada Lovelace"], ["chat:orch-2", "a2", "Bo"]),
      map(["chat:orch-1", "a1", "Ada"], ["chat:orch-2", "a2", "Bo"], ["chat:orch-3", "a1", "Ada"]),
      map(["chat:orch-1", "a1", "Ada"]),
      map(["chat:orch-1", "a1", "Ada"], ["chat:orch-9", "a2", "Bo"]),
    ]) expect(keepAssignees(before, next)).toBe(next);
  });

  it("gives a lead's chat the very same persona across ledger updates that change nobody's task", () => {
    // What the transcript is handed: a new object here drew it again.
    const leads = [lead("chat:lead", "a1", "Potato Juice")];
    const roster = [{ id: "a1", name: "Potato Juice", avatar: "data:image/png;base64,AAAA" }];
    let held = keepAssignees(new Map(), map(["chat:orch-1", "a2", "Bo"]));
    const first = held;
    for (let update = 0; update < 500; update += 1) held = keepAssignees(held, map(["chat:orch-1", "a2", "Bo"]));
    expect(held).toBe(first);
    expect(personaFor("chat:lead", leads, roster, held)).toEqual(personaFor("chat:lead", leads, roster, first));
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

// The front desk on the new-chat screen: who a new conversation opens on,
// what "Talk to someone else" lists, and what the front desk is sent.
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
vi.mock("./bridge", () => ({ bridge: { invoke: (...args: unknown[]) => invoke(...args) } }));
import {
  currentFrontDesk, directRecipients, frontDeskExecution, frontDeskText, newChatLead, sharedProject,
} from "./frontDesk";
import {
  conversationRecipients, createFrontDesk, frontDeskDefaults, frontDeskRefusal, leadSettings, loadFrontDesk,
  saveFrontDesk, type TeamAgent,
} from "./agentsMode";

const agent = (id: string, over: Partial<TeamAgent> = {}): TeamAgent => ({
  id, name: id[0].toUpperCase() + id.slice(1), role: "", agent: "claude", model: "sonnet", access: "auto",
  createdAt: 1, updatedAt: 1, ...over,
});
const desk = agent("desk", { model: "haiku", effort: "low", access: "read" });
const potato = agent("potato");
const vesper = agent("vesper", { projectId: "p-star" });
const lyra = agent("lyra", { projectId: "p-star" });
const helper = agent("helper", { reportsTo: "potato" });
const roster = [desk, potato, vesper, lyra, helper];
const recipients = conversationRecipients(roster, "potato");
const fallback = () => potato;

describe("the new-chat screen with a front desk", () => {
  it("opens every new conversation on the front desk, in any project", () => {
    for (const projectId of [null, "p-star", "p-app"]) {
      expect(newChatLead({ recipients, pickedId: null, desk, projectId, fallback })?.id).toBe("desk");
    }
  });

  it("keeps the old default when no front desk is designated", () => {
    expect(newChatLead({ recipients, pickedId: null, desk: null, projectId: null, fallback })?.id).toBe("potato");
  });

  it("goes to an agent picked directly, while the project on screen is one it works in", () => {
    expect(newChatLead({ recipients, pickedId: "vesper", desk, projectId: "p-star", fallback })?.id).toBe("vesper");
    // Moved to another project under it: back to the front desk, never an
    // agent somewhere it may not work.
    expect(newChatLead({ recipients, pickedId: "vesper", desk, projectId: "p-app", fallback })?.id).toBe("desk");
    expect(newChatLead({ recipients, pickedId: "desk", desk, projectId: "p-app", fallback })?.id).toBe("desk");
  });

  it("lists everyone the person can talk to directly under 'Talk to someone else', but not the front desk", () => {
    const list = directRecipients(recipients, desk).map((a) => a.id);
    expect(list).toEqual(["potato", "lyra", "vesper"]);
    expect(list).not.toContain("helper");
    expect(directRecipients(recipients, null).map((a) => a.id)).toContain("desk");
  });

  it("follows the roster's copy of the front desk, and drops one that is gone or scoped", () => {
    const renamed = { ...desk, name: "Reception" };
    expect(currentFrontDesk(desk, [renamed, potato])?.name).toBe("Reception");
    expect(currentFrontDesk(desk, [potato])).toBeNull();
    expect(currentFrontDesk(desk, [{ ...desk, projectId: "p-app" }])).toBeNull();
    expect(currentFrontDesk(null, roster)).toBeNull();
  });

  it("says a shared project once instead of on every row", () => {
    expect(sharedProject([vesper, lyra])).toBe("p-star");
    expect(sharedProject([vesper, potato])).toBeNull();
    expect(sharedProject([vesper, agent("x", { projectId: "p-app" })])).toBeNull();
    expect(sharedProject([vesper])).toBeNull();
  });

  it("sends the front desk every attachment by path, pictures included", () => {
    expect(frontDeskText("Fix this", [])).toBe("Fix this");
    expect(frontDeskText("Fix this", [
      { path: "/u/.octiqflow/attachments/a-shot.png", isImage: true },
      { path: "/u/.octiqflow/attachments/b-crash.log" },
    ])).toBe("Fix this\n\nAttachments:\n- /u/.octiqflow/attachments/a-shot.png (image)\n- /u/.octiqflow/attachments/b-crash.log");
  });

  it("runs the front desk at home with nothing prepared", () => {
    const plan = frontDeskExecution("p-general");
    expect(plan).toMatchObject({ target: "home", projectId: "p-general", prepare: false, newWorktree: false, useSandbox: false, crossProject: false });
  });

  it("starts the front desk on its registered model and effort, so a change in Settings is the next chat's", () => {
    expect(leadSettings(desk)).toMatchObject({ choice: { flag: "haiku" }, effort: "low", access: "read" });
    const changed = { ...desk, agent: "codex" as const, model: "gpt-5.6-luna", effort: "medium" as const };
    expect(leadSettings(changed)).toMatchObject({ choice: { agent: "codex", flag: "gpt-5.6-luna" }, effort: "medium" });
  });
});

describe("the front desk in Settings", () => {
  it("defaults to the provider's smallest model at its lowest effort", () => {
    expect(frontDeskDefaults("claude")).toEqual({ model: "haiku", effort: "low" });
    expect(frontDeskDefaults("codex")).toEqual({ model: "gpt-5.6-luna", effort: "low" });
  });

  it("refuses the head, managers and project agents, as the host does", () => {
    expect(frontDeskRefusal(potato, roster, "potato")).toContain("lead you talk to");
    expect(frontDeskRefusal(agent("boss"), [...roster, agent("w", { reportsTo: "boss" })], "potato")).toContain("manages");
    expect(frontDeskRefusal(vesper, roster, "potato")).toContain("one project");
    expect(frontDeskRefusal(desk, roster, "potato")).toBeNull();
  });

  it("reads, sets and creates the front desk through the host", async () => {
    invoke.mockClear();
    await loadFrontDesk();
    await saveFrontDesk("agent_1");
    await createFrontDesk({ agent: "claude", ...frontDeskDefaults("claude") });
    expect(invoke.mock.calls).toEqual([
      ["team_front_desk", {}],
      ["team_front_desk_set", { id: "agent_1" }],
      ["team_front_desk_create", { draft: { agent: "claude", model: "haiku", effort: "low" } }],
    ]);
  });
});

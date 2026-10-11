import { describe, expect, it } from "vitest";
import { besideHeld, holdsRunColumn, KNOWN_KEPT, knownToStore, parseKnown, runChatIds } from "./runColumn";
import type { OrchestrationRun } from "./orchestration";

const run = (id: string, chat: string, createdAt: number): OrchestrationRun => ({
  id, objective: "x", coordinatorChatKey: chat, workspaceId: "w", rootPath: "/r", status: "running", maxConcurrent: 2,
  createdAt, updatedAt: createdAt,
});

describe("the chats known to coordinate a run", () => {
  it("are the ledger's coordinators, newest run first, once each", () => {
    const runs = [run("a", "chat:lead", 1), run("b", "chat:head", 3), run("c", "chat:lead", 2), run("d", "front-desk", 9)];
    expect(runChatIds({ runs })).toEqual(["head", "lead"]);
  });

  it("are a bounded list", () => {
    const runs = Array.from({ length: KNOWN_KEPT + 30 }, (_, index) => run(`r${index}`, `chat:c${index}`, index));
    const ids = runChatIds({ runs });
    expect(ids).toHaveLength(KNOWN_KEPT);
    expect(ids[0]).toBe(`c${KNOWN_KEPT + 29}`);
  });

  it("are written down only when they changed", () => {
    const runs = [run("a", "chat:lead", 1)];
    expect(knownToStore({ runs }, null)).toBe("lead");
    expect(knownToStore({ runs }, "lead")).toBeNull();
    expect(knownToStore({ runs: [] }, null)).toBeNull();
    expect(knownToStore({ runs: [] }, "lead")).toBe("");
  });

  it("read back as a set, whatever was stored", () => {
    expect([...parseKnown("lead,head")]).toEqual(["lead", "head"]);
    expect(parseKnown(null).size).toBe(0);
    expect(parseKnown(",,").size).toBe(0);
  });
});

describe("holding the run column before the ledger is read", () => {
  const base = { ledgerRead: false, ledgerFailed: false, chatId: "lead", besideTask: null, known: new Set<string>() };

  it("holds it for a task chat, a chat with a task beside it, and a chat seen coordinating", () => {
    expect(holdsRunColumn({ ...base, chatId: "orch-1" })).toBe(true);
    expect(holdsRunColumn({ ...base, besideTask: "orch-1" })).toBe(true);
    expect(holdsRunColumn({ ...base, known: new Set(["lead"]) })).toBe(true);
  });

  it("holds nothing for a chat nothing is known about, or for no chat", () => {
    expect(holdsRunColumn(base)).toBe(false);
    expect(holdsRunColumn({ ...base, known: new Set(["other"]) })).toBe(false);
    expect(holdsRunColumn({ ...base, chatId: null, besideTask: "orch-1" })).toBe(false);
  });

  it("stops guessing once the ledger has answered, or could not", () => {
    const sure = { ...base, chatId: "orch-1", besideTask: "orch-2", known: new Set(["orch-1"]) };
    expect(holdsRunColumn({ ...sure, ledgerRead: true })).toBe(false);
    expect(holdsRunColumn({ ...sure, ledgerFailed: true })).toBe(false);
  });
});

describe("holding a pane for the task beside the chat", () => {
  const exists = (id: string) => id !== "orch-gone";

  it("trusts the person's choice for the chat on screen, when it names a task chat that is here", () => {
    expect(besideHeld({ main: "lead", task: "orch-1" }, "lead", exists)).toBe("orch-1");
  });

  it("holds nothing for another chat, a chat that is not a task chat, or one that is gone", () => {
    expect(besideHeld({ main: "lead", task: "orch-1" }, "head", exists)).toBeNull();
    expect(besideHeld({ main: "lead", task: "plain-chat" }, "lead", exists)).toBeNull();
    expect(besideHeld({ main: "lead", task: "orch-gone" }, "lead", exists)).toBeNull();
    expect(besideHeld(null, "lead", exists)).toBeNull();
    expect(besideHeld({ main: "orch-1", task: "orch-1" }, "orch-1", exists)).toBeNull();
  });
});

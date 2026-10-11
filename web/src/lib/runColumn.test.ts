import { describe, expect, it } from "vitest";
import { besideHeld, holdsRunColumn, KNOWN_KEPT, knownToStore, parseKnown, runChatIds, columnAtFirstPaint, columnHeldShut, NO_FIRST_PAINT } from "./runColumn";
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

  it("holds it for a chat whose own entry says it coordinates a run, in a browser that never saw it", () => {
    expect(holdsRunColumn({ ...base, coordinates: true })).toBe(true);
    // A host that does not say, or says no, changes nothing.
    expect(holdsRunColumn({ ...base, coordinates: false })).toBe(false);
    expect(holdsRunColumn({ ...base, coordinates: undefined })).toBe(false);
    // And the ledger still has the last word.
    expect(holdsRunColumn({ ...base, coordinates: true, ledgerRead: true })).toBe(false);
    expect(holdsRunColumn({ ...base, coordinates: true, ledgerFailed: true })).toBe(false);
    expect(holdsRunColumn({ ...base, coordinates: true, chatId: null })).toBe(false);
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

describe("a chat that was drawn without the column", () => {
  /** The renders of one page, in order: what each knows as it draws. */
  const renders = (...steps: { chatId: string | null; column: boolean; ledgerRead: boolean; runs: number }[]) =>
    steps.reduce((seen, step) => columnAtFirstPaint(seen, step), NO_FIRST_PAINT);

  it("keeps the column put away when the ledger says, after the paint, that the chat has a run", () => {
    // Drawn at full width, then the ledger arrives with a run of this chat.
    const late = renders(
      { chatId: "lead", column: false, ledgerRead: false, runs: 0 },
      { chatId: "lead", column: true, ledgerRead: true, runs: 1 },
    );
    expect(late).toEqual({ chatId: "lead", column: false, decided: true, late: true });
    expect(columnHeldShut(late)).toBe(true);
    // It stays that way through every later render of the same chat.
    expect(columnHeldShut(columnAtFirstPaint(late, { chatId: "lead", column: true, ledgerRead: true, runs: 2 }))).toBe(true);
  });

  it("holds it shut too when the chat list says so late, before the ledger has answered", () => {
    // `coordinatesRun` arrives with the list, after the chat is on screen:
    // holding the column from then would split the page just the same.
    const listed = renders(
      { chatId: "lead", column: false, ledgerRead: false, runs: 0 },
      { chatId: "lead", column: true, ledgerRead: false, runs: 0 },
    );
    expect(columnHeldShut(listed)).toBe(true);
    // The ledger then agrees: still shut, and now for the ledger's reason.
    expect(columnHeldShut(columnAtFirstPaint(listed, { chatId: "lead", column: true, ledgerRead: true, runs: 1 }))).toBe(true);
    // Or it says there is no run after all: nothing is held.
    expect(columnHeldShut(columnAtFirstPaint(listed, { chatId: "lead", column: false, ledgerRead: true, runs: 0 }))).toBe(false);
  });

  it("never shuts a column that was there at the chat's first paint", () => {
    for (const ledgerRead of [false, true]) {
      const held = renders(
        { chatId: "lead", column: true, ledgerRead, runs: ledgerRead ? 1 : 0 },
        { chatId: "lead", column: true, ledgerRead: true, runs: 1 },
      );
      expect(columnHeldShut(held), String(ledgerRead)).toBe(false);
    }
  });

  it("opens the column as before for a run started while the chat is open", () => {
    // The ledger was read and found no run; one starts later.
    const started = renders(
      { chatId: "lead", column: false, ledgerRead: false, runs: 0 },
      { chatId: "lead", column: false, ledgerRead: true, runs: 0 },
      { chatId: "lead", column: true, ledgerRead: true, runs: 1 },
    );
    expect(started).toMatchObject({ decided: true, late: false });
    expect(columnHeldShut(started)).toBe(false);
    // And for a chat first drawn after the ledger was read.
    expect(columnHeldShut(renders({ chatId: "plain", column: false, ledgerRead: true, runs: 0 }, { chatId: "plain", column: true, ledgerRead: true, runs: 1 }))).toBe(false);
  });

  it("starts over for another chat, and for the same chat come back to", () => {
    const late = renders(
      { chatId: "lead", column: false, ledgerRead: false, runs: 0 },
      { chatId: "lead", column: true, ledgerRead: true, runs: 1 },
    );
    const away = columnAtFirstPaint(late, { chatId: "other", column: false, ledgerRead: true, runs: 0 });
    expect(columnHeldShut(away)).toBe(false);
    // Back: this paint has the column from the start, so it is shown.
    const back = columnAtFirstPaint(away, { chatId: "lead", column: true, ledgerRead: true, runs: 1 });
    expect(back).toEqual({ chatId: "lead", column: true, decided: true, late: false });
    expect(columnHeldShut(back)).toBe(false);
    // No chat on screen holds nothing.
    expect(columnHeldShut(NO_FIRST_PAINT)).toBe(false);
  });

  it("keeps the same record when nothing it reads has changed", () => {
    const first = columnAtFirstPaint(NO_FIRST_PAINT, { chatId: "lead", column: false, ledgerRead: false, runs: 0 });
    expect(columnAtFirstPaint(first, { chatId: "lead", column: false, ledgerRead: false, runs: 0 })).toBe(first);
    const read = columnAtFirstPaint(first, { chatId: "lead", column: true, ledgerRead: true, runs: 1 });
    expect(columnAtFirstPaint(read, { chatId: "lead", column: true, ledgerRead: true, runs: 3 })).toBe(read);
  });
});

import { describe, expect, it } from "vitest";
import { deriveRecovery, queuedMessageCount, type RecoveryEvidence } from "./recovery";
import { CARRY_ON, someoneWorking } from "./carryOn";

const missing: RecoveryEvidence = { connected: true, rosterKnown: true, busy: true, live: false };

describe("recovery evidence", () => {
  it("never treats a disconnected browser or an old roster as a missing process", () => {
    expect(deriveRecovery({ ...missing, connected: false })).toEqual({ kind: "offline", canContinue: false });
    expect(deriveRecovery({ ...missing, rosterKnown: false })).toEqual({ kind: "checking", canContinue: false });
  });
  it("offers recovery only after confirming the unfinished worker is missing", () => {
    expect(deriveRecovery(missing)).toEqual({ kind: "missing", canContinue: true });
    expect(deriveRecovery({ ...missing, busy: false })).toEqual({ kind: "hidden", canContinue: false });
  });
  it("distinguishes an actual recorded exit, including a failure that cleared busy", () => {
    expect(deriveRecovery({ ...missing, busy: false, exited: { code: 1 } })).toEqual({ kind: "exited", canContinue: true });
    expect(deriveRecovery({ ...missing, busy: false, exited: { code: 0 } }).kind).toBe("hidden");
    expect(deriveRecovery({ ...missing, busy: false, exited: { code: null } }).kind).toBe("exited");
  });
  it("does not resurrect a stopped turn while a new worker or room seat is alive", () => {
    const live = someoneWorking({ id: "room", running: new Set(["room-seat-one"]), round: false });
    expect(deriveRecovery({ ...missing, live, exited: { code: 1 } }).canContinue).toBe(false);
    const round = someoneWorking({ id: "room", running: new Set(), round: true });
    expect(deriveRecovery({ ...missing, live: round }).kind).toBe("hidden");
  });
  it("asks to inspect previous actions without inventing a restart or intact history", () => {
    expect(CARRY_ON).toContain("Check what is already done");
    expect(CARRY_ON).toContain("cause of the interruption is unknown");
    expect(CARRY_ON).not.toContain("backend restart");
    expect(CARRY_ON).not.toContain("Everything you had already done is in");
  });
});

describe("current queued messages", () => {
  const user = (id: string, extra: Partial<import("./chat").Message> = {}): import("./chat").Message => ({ id, role: "user", streaming: false, blocks: [], ...extra });
  const answer: import("./chat").Message = { id: "answer", role: "assistant", streaming: false, blocks: [] };
  it("counts current canonical prompts after an answer without counting old legacy users", () => {
    expect(queuedMessageCount({ messages: [user("old"), answer, user("first", { turnId: "one" }), user("second", { turnId: "two" })] })).toBe(2);
  });
  it("excludes accepted turns signaled by echo or takenUp", () => {
    expect(queuedMessageCount({ messages: [user("accepted", { turnId: "one", takenUp: true }), user("next", { turnId: "two" })] })).toBe(1);
    expect(queuedMessageCount({ messages: [user("accepted", { turnId: "one", echo: "uuid" })] })).toBe(0);
    expect(queuedMessageCount({ messages: [user("accepted", { takenUp: true }), answer] })).toBe(0);
  });
  it("leaves unknown legacy and seat queues unspecified", () => {
    expect(queuedMessageCount({ messages: [user("legacy"), answer] })).toBeUndefined();
    expect(queuedMessageCount({ messages: [user("legacy")] })).toBeUndefined();
    expect(queuedMessageCount({ messages: [user("seat", { turnId: "one", to: { id: "s", name: "Seat" } })] })).toBeUndefined();
  });
});

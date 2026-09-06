import { describe, expect, it } from "vitest";
import { emptyChat } from "./chat";
import { selectAttention, type AttentionInput } from "./attention";
import type { Conversation } from "./store";

const conversation: Conversation = { id: "c", projectId: "p", title: "Fix retries", messages: [], createdAt: 0, updatedAt: 0 };
function input(overrides: Partial<AttentionInput> = {}): AttentionInput {
  return { conversations: [conversation], projects: [{ id: "p", name: "Shelved project" }], chats: {}, running: new Set(["c"]), connected: true, liveKnown: true, ...overrides };
}
const busy = () => input({ chats: { c: { ...emptyChat(), busy: true } } });
const idle = () => input({ chats: { c: emptyChat() } });

describe("attention precedence", () => {
  it("puts pending permission and question ahead of failure", () => {
    const snapshot = input({ chats: { c: { ...emptyChat(), failure: { title: "Quota" } } }, asks: { c: [{}] }, questions: { c: [{}] } });
    expect(selectAttention(snapshot)[0].kind).toBe("permission");
    expect(selectAttention({ ...snapshot, asks: {} })[0].kind).toBe("question");
    expect(selectAttention({ ...snapshot, asks: {}, questions: {} })[0].kind).toBe("failure");
  });
  it("allows live requests without loading the transcript and resolves shelved names", () => {
    const entries = selectAttention(input({ asks: { c: [{}] } }));
    expect(entries[0].projectName).toBe("Shelved project");
    expect(entries[0].conversation).toBe(conversation);
  });
  it("does not manufacture idle entries from unloaded or old history", () => {
    expect(selectAttention(input())).toEqual([]);
    expect(selectAttention(idle())).toEqual([]);
  });
  it("suppresses stale requests and inferred interruptions while disconnected or unknown", () => {
    for (const overrides of [{ connected: false }, { liveKnown: false }]) {
      expect(selectAttention({ ...busy(), ...overrides, asks: { c: [{}] }, questions: { c: [{}] }, running: new Set() })).toEqual([]);
    }
    const failure = input({ connected: false, chats: { c: { ...emptyChat(), failure: { title: "Failed" } } } });
    expect(selectAttention(failure)[0]).toMatchObject({ kind: "failure", stale: true });
  });
  it("shows authoritative requests even before the roster adopts the process", () => {
    expect(selectAttention({ ...busy(), running: new Set(), asks: { c: [{}] } })[0].kind).toBe("permission");
    expect(selectAttention({ ...busy(), running: new Set() })[0].kind).toBe("interrupted");
  });
  it("recognizes seat processes and rounds as live work", () => {
    for (const snapshot of [
      { ...busy(), running: new Set(["c-seat-reviewer"]) },
      { ...busy(), running: new Set<string>(), activeRounds: new Set(["c"]) },
    ]) expect(selectAttention(snapshot)).toEqual([]);
  });
  it("honors an authoritative interruption set while a room handover settles", () => {
    const missing = { ...busy(), running: new Set<string>() };
    expect(selectAttention({ ...missing, interruptedIds: new Set() })).toEqual([]);
    expect(selectAttention({ ...missing, interruptedIds: new Set(["c"]) })[0].kind).toBe("interrupted");
    expect(selectAttention({ ...missing, connected: false, interruptedIds: new Set(["c"]) })).toEqual([]);
    expect(selectAttention({ ...busy(), interruptedIds: new Set(["c"]) })).toEqual([]);
  });
  it("shows abnormal process exits without needing a provider failure event", () => {
    for (const [code, kind] of [[2, "failure"], [null, "interrupted"]] as const) {
      const snapshot = input({ chats: { c: { ...emptyChat(), exited: { code } } }, running: new Set(), interruptedIds: new Set() });
      expect(selectAttention(snapshot)[0].kind).toBe(kind);
      expect(selectAttention({ ...snapshot, asks: { c: [{}] } })[0].kind).toBe("permission");
    }
  });
  it("does not alert for a successful exit, requested stop, or an older exit during new work", () => {
    for (const patch of [{ exited: { code: 0 } }, { exited: { code: 1 }, stopping: true }, { exited: { code: null }, stoppedAt: "m1" }, { exited: { code: 1 }, busy: true }]) {
      expect(selectAttention(input({ chats: { c: { ...emptyChat(), ...patch } } }))).toEqual([]);
    }
  });
  it("retains a safety block for review and falls back for missing metadata", () => {
    expect(selectAttention(input({ projects: [], safetyBlocks: { c: [{}] } }))[0]).toMatchObject({ kind: "safety", projectName: "Unknown project" });
  });
  it("does not create attention for a successfully completed turn", () => {
    expect(selectAttention(input({ chats: { c: { ...emptyChat(), exited: { code: 0 } }, }, running: new Set() }))).toEqual([]);
  });
});

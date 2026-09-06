import { describe, expect, it } from "vitest";
import { emptyChat } from "./chat";
import { emptyAttentionObservation, observeAttention, selectAttention, type AttentionInput } from "./attention";
import type { Conversation } from "./store";

const conversation: Conversation = { id: "c", projectId: "p", title: "Fix retries", messages: [], createdAt: 0, updatedAt: 0 };
function input(overrides: Partial<AttentionInput> = {}): AttentionInput {
  return { conversations: [conversation], projects: [{ id: "p", name: "Shelved project" }], chats: {}, running: new Set(["c"]), connected: true, liveKnown: true, currentConversationId: null, ...overrides };
}
const busy = () => input({ chats: { c: { ...emptyChat(), busy: true } } });
const idle = () => input({ chats: { c: emptyChat() } });

describe("attention precedence", () => {
  it("puts pending permission and question ahead of failure and completion", () => {
    const snapshot = input({ chats: { c: { ...emptyChat(), failure: { title: "Quota" } } }, asks: { c: [{}] }, questions: { c: [{}] } });
    expect(selectAttention(snapshot, new Set(["c"]))[0].kind).toBe("permission");
    expect(selectAttention({ ...snapshot, asks: {} }, new Set(["c"]))[0].kind).toBe("question");
    expect(selectAttention({ ...snapshot, asks: {}, questions: {} }, new Set(["c"]))[0].kind).toBe("failure");
  });
  it("allows live requests without loading the transcript and resolves shelved names", () => {
    const entries = selectAttention(input({ asks: { c: [{}] } }), new Set());
    expect(entries[0].projectName).toBe("Shelved project");
    expect(entries[0].conversation).toBe(conversation);
  });
  it("does not manufacture idle entries from unloaded or old history", () => {
    expect(selectAttention(input(), new Set())).toEqual([]);
    expect(selectAttention(idle(), new Set())).toEqual([]);
  });
  it("suppresses stale requests and inferred interruptions while disconnected or unknown", () => {
    for (const overrides of [{ connected: false }, { liveKnown: false }]) {
      expect(selectAttention({ ...busy(), ...overrides, asks: { c: [{}] }, questions: { c: [{}] }, running: new Set() }, new Set())).toEqual([]);
    }
    const failure = input({ connected: false, chats: { c: { ...emptyChat(), failure: { title: "Failed" } } } });
    expect(selectAttention(failure, new Set())[0]).toMatchObject({ kind: "failure", stale: true });
  });
  it("shows authoritative requests even before the roster adopts the process", () => {
    expect(selectAttention({ ...busy(), running: new Set(), asks: { c: [{}] } }, new Set())[0].kind).toBe("permission");
    expect(selectAttention({ ...busy(), running: new Set() }, new Set())[0].kind).toBe("interrupted");
  });
  it("recognizes seat processes and rounds as live work", () => {
    for (const snapshot of [
      { ...busy(), running: new Set(["c-seat-reviewer"]) },
      { ...busy(), running: new Set<string>(), activeRounds: new Set(["c"]) },
    ]) expect(selectAttention(snapshot, new Set())).toEqual([]);
  });
  it("honors an authoritative interruption set while a room handover settles", () => {
    const missing = { ...busy(), running: new Set<string>() };
    expect(selectAttention({ ...missing, interruptedIds: new Set() }, new Set())).toEqual([]);
    expect(selectAttention({ ...missing, interruptedIds: new Set(["c"]) }, new Set())[0].kind).toBe("interrupted");
    expect(selectAttention({ ...missing, connected: false, interruptedIds: new Set(["c"]) }, new Set())).toEqual([]);
    expect(selectAttention({ ...busy(), interruptedIds: new Set(["c"]) }, new Set())).toEqual([]);
  });
  it("shows abnormal process exits without needing a provider failure event", () => {
    for (const [code, kind] of [[2, "failure"], [null, "interrupted"]] as const) {
      const snapshot = input({ chats: { c: { ...emptyChat(), exited: { code } } }, running: new Set(), interruptedIds: new Set() });
      expect(selectAttention(snapshot, new Set(["c"]))[0].kind).toBe(kind);
      expect(selectAttention({ ...snapshot, asks: { c: [{}] } }, new Set(["c"]))[0].kind).toBe("permission");
    }
  });
  it("does not alert for a successful exit, requested stop, or an older exit during new work", () => {
    for (const patch of [{ exited: { code: 0 } }, { exited: { code: 1 }, stopping: true }, { exited: { code: null }, stoppedAt: "m1" }, { exited: { code: 1 }, busy: true }]) {
      expect(selectAttention(input({ chats: { c: { ...emptyChat(), ...patch } } }), new Set())).toEqual([]);
    }
  });
  it("retains a safety block for review and falls back for missing metadata", () => {
    expect(selectAttention(input({ projects: [], safetyBlocks: { c: [{}] } }), new Set())[0]).toMatchObject({ kind: "safety", projectName: "Unknown project" });
  });
  it("orders actionable requests before completion without reordering tied rows", () => {
    const other = { ...conversation, id: "d" };
    const entries = selectAttention(input({ conversations: [conversation, other], running: new Set(["d"]), questions: { d: [{}] } }), new Set(["c"]));
    expect(entries.map((entry) => entry.conversation.id)).toEqual(["d", "c"]);
  });
});

describe("completion observation", () => {
  it("tracks only observed loaded busy-to-idle transitions", () => {
    expect(observeAttention(emptyAttentionObservation(), idle()).completed.size).toBe(0);
    const started = observeAttention(emptyAttentionObservation(), busy());
    expect(observeAttention(started, idle()).completed.has("c")).toBe(true);
    expect(observeAttention(started, input()).completed.size).toBe(0);
  });
  it("does not turn a historical busy replay without a live process into a completion", () => {
    const replay = observeAttention(emptyAttentionObservation(), { ...busy(), running: new Set() });
    expect(observeAttention(replay, idle()).completed.size).toBe(0);
  });
  it("does not infer completion across a disconnect or unknown roster", () => {
    const started = observeAttention(emptyAttentionObservation(), busy());
    for (const overrides of [{ connected: false }, { liveKnown: false }]) {
      const disconnected = observeAttention(started, { ...busy(), ...overrides });
      expect(observeAttention(disconnected, idle()).completed.size).toBe(0);
    }
  });
  it("excludes failures, requested stops, and interrupted turns", () => {
    const started = observeAttention(emptyAttentionObservation(), busy());
    for (const patch of [{ failure: { title: "Error" } }, { stopping: true }, { stoppedAt: "m1" }]) {
      expect(observeAttention(started, input({ chats: { c: { ...emptyChat(), ...patch } } })).completed.size).toBe(0);
    }
  });
  it("never treats a nonzero or unknown process exit as a new completed reply", () => {
    const started = observeAttention(emptyAttentionObservation(), busy());
    for (const code of [1, 2, null]) {
      const snapshot = input({ chats: { c: { ...emptyChat(), exited: { code } } } });
      expect(observeAttention(started, snapshot).completed.size).toBe(0);
      const previouslyCompleted = observeAttention(started, idle());
      expect(observeAttention(previouslyCompleted, snapshot).completed.size).toBe(0);
    }
    expect(observeAttention(started, input({ chats: { c: { ...emptyChat(), exited: { code: 0 } } } })).completed.has("c")).toBe(true);
  });
  it("clears completion on visiting, deleting, or starting new work", () => {
    const started = observeAttention(emptyAttentionObservation(), busy());
    const completed = observeAttention(started, idle());
    expect(observeAttention(completed, { ...idle(), currentConversationId: "c" }).completed.size).toBe(0);
    expect(selectAttention({ ...idle(), currentConversationId: "c" }, completed.completed)).toEqual([]);
    expect(observeAttention(completed, { ...idle(), conversations: [] }).completed.size).toBe(0);
    expect(observeAttention(completed, busy()).completed.size).toBe(0);
  });
  it("a dismissed completion does not return on another idle snapshot", () => {
    const completed = observeAttention(observeAttention(emptyAttentionObservation(), busy()), idle());
    const dismissed = { ...completed, completed: new Set<string>() };
    expect(observeAttention(dismissed, idle()).completed.size).toBe(0);
  });
});

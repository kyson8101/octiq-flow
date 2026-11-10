import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it } from "vitest";
import { vi } from "vitest";
import { emptyChat, type ChatState } from "./chat";
import { CatchUp } from "./catchUp";
import { ChatHistory } from "./chatHistory";
import { ChatWindowCache } from "./chatWindowCache";
import { readChatCheckpoint, saveChatCheckpoint } from "./chatCache";
import { ChatRecordClears, chatSessionFor, clearedConversation, conversationForRecord, invalidateChatRecord } from "./chatRecord";
import { loadConversations, saveConversations, type Conversation } from "./store";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

it("binds the saved native ID to its own record without changing model, access or messages", () => {
  const chat: Conversation = { id: "a", projectId: "p", title: "A", messages: [], createdAt: 1, updatedAt: 2,
    sessionId: "old-native", recordGeneration: "before", modelId: "claude:sonnet", permission: "read", effort: "high", cwd: "/fixture" };
  expect(conversationForRecord(chat, "before")).toBe(chat);
  const next = conversationForRecord(chat, "after");
  expect(next).toEqual({ ...chat, sessionId: undefined, recordGeneration: "after" });
  expect(conversationForRecord(next, "after")).toBe(next);
  const { recordGeneration: _, ...legacy } = chat;
  expect(conversationForRecord(legacy, "after", "before")).toEqual(next);
  expect(conversationForRecord(legacy, "before").sessionId).toBe("old-native");
  expect(conversationForRecord(legacy, "after", undefined, null).sessionId).toBeUndefined();
  expect(conversationForRecord(legacy, "before", undefined, "old-native").sessionId).toBe("old-native");
});

it("chat-forgotten releases recent recency, checkpoint, history and mark together", async () => {
  const catchUp = new CatchUp(), history = new ChatHistory(), recent = new ChatWindowCache();
  let state = emptyChat();
  state.sessionId = "old-native-session";
  state.messages = [{ id: "old", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "old record" }] }];
  catchUp.begin("chat:a"); catchUp.end("chat:a", [{ seq: 1152, event: {} }]);
  catchUp.setGeneration("chat:a", "old"); history.set("a", 100);
  recent.retain({ a: state }, new Set(["a"]), () => true);
  await saveChatCheckpoint({ id: "a", state, seq: 1152, generation: "old", updatedAt: 1 });
  invalidateChatRecord({ id: "a", key: "chat:a", catchUp, history, recent,
    getState: () => state, publish: next => { state = next; } });
  expect(state.messages).toEqual([]);
  expect(state.sessionId).toBeUndefined();
  expect(catchUp.mark("chat:a")).toBe(0);
  expect(catchUp.holds("chat:a")).toBe(false);
  expect(catchUp.generation("chat:a")).toBeUndefined();
  expect(history.isPartial("a")).toBe(false);
  // A recreated/held id cannot inherit the released LRU slot.
  expect(recent.retain({ a: state }, new Set(), () => true).has("a")).toBe(false);
  await vi.waitFor(async () => expect(await readChatCheckpoint("a")).toBeUndefined());
});

it("a reset cancels an IDB write already waiting to open", async () => {
  let state = emptyChat();
  const saving = saveChatCheckpoint({ id: "a", state, seq: 1152, updatedAt: 1 });
  invalidateChatRecord({ id: "a", key: "chat:a", catchUp: new CatchUp(), getState: () => state, publish: next => { state = next; } });
  await saving;
  expect(await readChatCheckpoint("a")).toBeUndefined();
});

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each(["before", "after"])("save-first clear resets once when its own broadcast arrives %s the reply", async timing => {
  const clears = new ChatRecordClears(), saved = deferred(), order: string[] = [];
  let words = ["old record"];
  const reset = vi.fn(() => { order.push("reset"); words = []; });
  const refresh = vi.fn();
  const options = { key: "chat:clear-success", forget: vi.fn(() => { order.push("forget"); return saved.promise; }),
    reset, refresh };
  const pending = clears.clear(options);
  expect(await clears.clear(options)).toBe(false);
  expect(options.forget).toHaveBeenCalledTimes(1);
  if (timing === "before") expect(clears.forgotten(options.key)).toBe(true);
  expect(words).toEqual(["old record"]);
  expect(order).toEqual(["forget"]);
  order.push("saved"); saved.resolve();
  expect(await pending).toBe(true);
  expect(order).toEqual(["forget", "saved", "reset"]);
  // New events after the successful clear cannot be erased by its receipt.
  words.push("new record event");
  if (timing === "after") expect(clears.forgotten(options.key)).toBe(true);
  expect(words).toEqual(["new record event"]);
  expect(reset).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(timing === "after" ? 2 : 1);
  // A later reset by another tab is still handled normally.
  expect(clears.forgotten(options.key)).toBe(false);
});

it("a rejected clear preserves the projection, cursor, mark and checkpoint and returns the host reason", async () => {
  const clears = new ChatRecordClears(), saved = deferred();
  const catchUp = new CatchUp(), history = new ChatHistory();
  let state = emptyChat();
  state.sessionId = "keep-on-failure";
  state.messages = [{ id: "old", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "old record" }] }];
  catchUp.begin("chat:clear-failure"); catchUp.end("chat:clear-failure", [{ seq: 42, event: {} }]);
  catchUp.setGeneration("chat:clear-failure", "original"); history.set("clear-failure", 20);
  await saveChatCheckpoint({ id: "clear-failure", state, seq: 42, generation: "original", updatedAt: 1 });
  const checkpoint = await readChatCheckpoint("clear-failure");
  const refresh = vi.fn();
  const reset = vi.fn(() => invalidateChatRecord({ id: "clear-failure", key: "chat:clear-failure", catchUp, history,
    getState: () => state, publish: next => { state = next; } }));
  const options = { key: "chat:clear-failure", forget: () => saved.promise, reset, refresh };
  const pending = clears.clear(options);
  const error = new Error("The profile folder /fixture is not available right now: nothing was saved.");
  const rejected = expect(pending).rejects.toBe(error);
  saved.reject(error); await rejected;
  expect(state.messages[0].id).toBe("old");
  expect(state.sessionId).toBe("keep-on-failure");
  expect(catchUp.mark(options.key)).toBe(42);
  expect(catchUp.generation(options.key)).toBe("original");
  expect(catchUp.holds(options.key)).toBe(true);
  expect(history.get("clear-failure")).toEqual({ before: 20 });
  expect(await readChatCheckpoint("clear-failure")).toEqual(checkpoint);
  expect(reset).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  // Failure releases the send guard so the unchanged command can be retried.
  expect(await clears.clear({ ...options, forget: async () => {} })).toBe(true);
});

it("supports a legacy success without a broadcast and drops old receipts on disconnect", async () => {
  const clears = new ChatRecordClears(), reset = vi.fn();
  expect(await clears.clear({ key: "chat:legacy", forget: async () => {}, reset, refresh: () => {} })).toBe(true);
  expect(reset).toHaveBeenCalledTimes(1);
  clears.disconnected();
  expect(clears.forgotten("chat:legacy")).toBe(false);
});

it.each(["claude", "codex", "pi", "antigravity", "lead-octiq-head"])("successful %s clear drops both native-id sources before the next start and reload", async id => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value) });
  let state: ChatState = { ...emptyChat(), sessionId: `${id}-native`, cwd: "/fixture" };
  let chat: Conversation = { id, projectId: "fixture", title: "Fixture chat", sessionId: state.sessionId, cwd: state.cwd,
    messages: [], createdAt: 1, updatedAt: 2, leadOf: id.startsWith("lead-") ? "octiq-head" : undefined };
  saveConversations([chat]);
  const saved = deferred(), invoke = vi.fn(() => saved.promise);
  const clearing = new ChatRecordClears().clear({ key: `chat:${id}`, forget: () => invoke(),
    reset: () => {
      invalidateChatRecord({ id, key: `chat:${id}`, catchUp: new CatchUp(),
        getState: () => state, publish: next => { state = next; } });
      chat = clearedConversation(chat); saveConversations([chat]);
    }, refresh: () => {} });
  expect(chatSessionFor(state, chat)).toBe(`${id}-native`);
  expect(loadConversations()[0].sessionId).toBe(`${id}-native`);
  saved.resolve(); expect(await clearing).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1); // forget only; there is no agent command
  expect(state.sessionId).toBeUndefined();
  expect(chat.sessionId).toBeUndefined();
  expect(chatSessionFor(state, chat)).toBeNull(); // chat_start.resume
  expect(chatSessionFor(undefined, loadConversations()[0])).toBeNull();
  expect(state.cwd).toBe("/fixture"); expect(chat.leadOf).toBe(id.startsWith("lead-") ? "octiq-head" : undefined);
});

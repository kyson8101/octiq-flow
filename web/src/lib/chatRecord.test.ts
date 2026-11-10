import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it } from "vitest";
import { vi } from "vitest";
import { emptyChat } from "./chat";
import { CatchUp } from "./catchUp";
import { ChatHistory } from "./chatHistory";
import { ChatWindowCache } from "./chatWindowCache";
import { readChatCheckpoint, saveChatCheckpoint } from "./chatCache";
import { ChatRecordClears, invalidateChatRecord } from "./chatRecord";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

it("chat-forgotten releases recent recency, checkpoint, history and mark together", async () => {
  const catchUp = new CatchUp(), history = new ChatHistory(), recent = new ChatWindowCache();
  let state = emptyChat();
  state.messages = [{ id: "old", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "old record" }] }];
  catchUp.begin("chat:a"); catchUp.end("chat:a", [{ seq: 1152, event: {} }]);
  catchUp.setGeneration("chat:a", "old"); history.set("a", 100);
  recent.retain({ a: state }, new Set(["a"]), () => true);
  await saveChatCheckpoint({ id: "a", state, seq: 1152, generation: "old", updatedAt: 1 });
  invalidateChatRecord({ id: "a", key: "chat:a", catchUp, history, recent,
    getState: () => state, publish: next => { state = next; } });
  expect(state.messages).toEqual([]);
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
    clearAgent: vi.fn(() => order.push("agent /clear")), reset, refresh };
  const pending = clears.clear(options);
  expect(await clears.clear(options)).toBe(false);
  expect(options.forget).toHaveBeenCalledTimes(1);
  if (timing === "before") expect(clears.forgotten(options.key)).toBe(true);
  expect(words).toEqual(["old record"]);
  expect(order).toEqual(["forget"]);
  order.push("saved"); saved.resolve();
  expect(await pending).toBe(true);
  expect(order).toEqual(["forget", "saved", "agent /clear", "reset"]);
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
  state.messages = [{ id: "old", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "old record" }] }];
  catchUp.begin("chat:clear-failure"); catchUp.end("chat:clear-failure", [{ seq: 42, event: {} }]);
  catchUp.setGeneration("chat:clear-failure", "original"); history.set("clear-failure", 20);
  await saveChatCheckpoint({ id: "clear-failure", state, seq: 42, generation: "original", updatedAt: 1 });
  const checkpoint = await readChatCheckpoint("clear-failure");
  const clearAgent = vi.fn(), refresh = vi.fn();
  const reset = vi.fn(() => invalidateChatRecord({ id: "clear-failure", key: "chat:clear-failure", catchUp, history,
    getState: () => state, publish: next => { state = next; } }));
  const options = { key: "chat:clear-failure", forget: () => saved.promise, clearAgent, reset, refresh };
  const pending = clears.clear(options);
  const error = new Error("The profile folder /fixture is not available right now: nothing was saved.");
  const rejected = expect(pending).rejects.toBe(error);
  saved.reject(error); await rejected;
  expect(state.messages[0].id).toBe("old");
  expect(catchUp.mark(options.key)).toBe(42);
  expect(catchUp.generation(options.key)).toBe("original");
  expect(catchUp.holds(options.key)).toBe(true);
  expect(history.get("clear-failure")).toEqual({ before: 20 });
  expect(await readChatCheckpoint("clear-failure")).toEqual(checkpoint);
  expect(clearAgent).not.toHaveBeenCalled(); expect(reset).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  // Failure releases the send guard so the unchanged command can be retried.
  expect(await clears.clear({ ...options, forget: async () => {} })).toBe(true);
});

it("supports a legacy success without a broadcast and drops old receipts on disconnect", async () => {
  const clears = new ChatRecordClears(), reset = vi.fn();
  expect(await clears.clear({ key: "chat:legacy", forget: async () => {}, clearAgent: () => {}, reset, refresh: () => {} })).toBe(true);
  expect(reset).toHaveBeenCalledTimes(1);
  clears.disconnected();
  expect(clears.forgotten("chat:legacy")).toBe(false);
});

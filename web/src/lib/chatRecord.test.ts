import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it } from "vitest";
import { vi } from "vitest";
import { emptyChat } from "./chat";
import { CatchUp } from "./catchUp";
import { ChatHistory } from "./chatHistory";
import { ChatWindowCache } from "./chatWindowCache";
import { readChatCheckpoint, saveChatCheckpoint } from "./chatCache";
import { invalidateChatRecord } from "./chatRecord";

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

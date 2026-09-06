import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyChat } from "./chat";
import { forgetChatCheckpoint, readChatCheckpoint, saveChatCheckpoint } from "./chatCache";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

it("retains a full checkpoint larger than the entire localStorage budget", async () => {
  const state = emptyChat();
  state.messages = [{ id: "m", role: "assistant", streaming: false,
    blocks: [{ kind: "text", text: "x".repeat(4 * 1024 * 1024) }] }];
  state.awaitingSummary = true;
  await saveChatCheckpoint({ id: "large", seq: 16000, state, updatedAt: 1 });
  expect(await readChatCheckpoint("large")).toEqual({ id: "large", seq: 16000, state, updatedAt: 1 });
  await forgetChatCheckpoint("large");
  expect(await readChatCheckpoint("large")).toBeUndefined();
});

it("evicts old checkpoints while retaining recent chats", async () => {
  for (let n = 0; n < 14; n++) {
    await saveChatCheckpoint({ id: `c${n}`, seq: n, state: emptyChat(), updatedAt: n });
  }
  expect(await readChatCheckpoint("c0")).toBeUndefined();
  expect(await readChatCheckpoint("c1")).toBeUndefined();
  expect((await readChatCheckpoint("c2"))?.seq).toBe(2);
  expect((await readChatCheckpoint("c13"))?.seq).toBe(13);
});

it("falls back harmlessly when browser storage is unavailable", async () => {
  vi.stubGlobal("indexedDB", undefined);
  expect(await readChatCheckpoint("a")).toBeUndefined();
  await expect(saveChatCheckpoint({ id: "a", seq: 1, state: emptyChat(), updatedAt: 1 })).resolves.toBeUndefined();
  await expect(forgetChatCheckpoint("a")).resolves.toBeUndefined();
});

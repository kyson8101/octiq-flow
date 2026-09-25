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

/** Rewrite a stored row's stamp, standing in for the checkpoint an EARLIER
 *  reader left behind. Raw, because the stamp is the cache's own business and
 *  no caller is given a way to set it.
 *
 *  Every error path REJECTS, and it settles on `tx.oncomplete` rather than on
 *  the put. An earlier version did neither: with no store to open it simply
 *  never settled, and the test died at the runner's timeout saying nothing
 *  about why. */
function restamp(id: string, stamp: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("octiq.chat-cache", 1);
    open.onerror = () => reject(open.error ?? new Error("cannot open the cache"));
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("checkpoints")) {
        db.close();
        return reject(new Error("no checkpoints store — save one before restamping"));
      }
      const tx = db.transaction("checkpoints", "readwrite");
      const table = tx.objectStore("checkpoints");
      const got = table.get(id);
      got.onsuccess = () => {
        if (!got.result) return reject(new Error(`no checkpoint ${id} to restamp`));
        table.put({ ...(got.result as object), ...stamp });
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error ?? new Error("restamp failed")); };
      tx.onabort = () => { db.close(); reject(tx.error ?? new Error("restamp aborted")); };
    };
  });
}

/** A hand-back as the OLD reader cached it: a user bubble whose text still
 *  holds the whole frame. */
const staleChat = () => {
  const state = emptyChat();
  state.messages = [{
    id: "m1", role: "user", streaming: false,
    blocks: [{ kind: "text", text: '<agent-message from="a1">\n[Subagent hand-back] The report follows:\n  Verdict\n</agent-message>' }],
  }];
  return state;
};

it("carries a checkpoint an earlier reader wrote forward instead of refusing it", async () => {
  // Refusing it does NOT send the chat back to its transcript — it sends it to
  // the paged path, which serves only the last few turns and, being paged,
  // never re-caches. The conversation would come back a fraction of itself.
  await saveChatCheckpoint({ id: "old", seq: 5, state: staleChat(), updatedAt: 1 });
  // A positive control: without it, `toBeUndefined` below would also pass when
  // the read simply failed.
  expect((await readChatCheckpoint("old"))?.seq).toBe(5);

  await restamp("old", { schema: 1 });
  const back = await readChatCheckpoint("old");

  expect(back?.seq).toBe(5);
  expect(back?.state.messages[0]).toMatchObject({
    role: "assistant",
    blocks: [{ kind: "peer", from: "a1" }],
  });
});

it("carries forward a checkpoint from before there was a stamp at all", async () => {
  await saveChatCheckpoint({ id: "ancient", seq: 5, state: staleChat(), updatedAt: 1 });
  await restamp("ancient", { schema: undefined });

  expect((await readChatCheckpoint("ancient"))?.state.messages[0].role).toBe("assistant");
});

it("hands back this reader's own checkpoint untouched", async () => {
  const state = staleChat();
  await saveChatCheckpoint({ id: "mine", seq: 5, state, updatedAt: 1 });

  // Saved under the current stamp, so nothing is redrawn — what went in is
  // what comes out, frame and all.
  expect((await readChatCheckpoint("mine"))?.state.messages[0].role).toBe("user");
});

it("falls back harmlessly when browser storage is unavailable", async () => {
  vi.stubGlobal("indexedDB", undefined);
  expect(await readChatCheckpoint("a")).toBeUndefined();
  await expect(saveChatCheckpoint({ id: "a", seq: 1, state: emptyChat(), updatedAt: 1 })).resolves.toBeUndefined();
  await expect(forgetChatCheckpoint("a")).resolves.toBeUndefined();
});

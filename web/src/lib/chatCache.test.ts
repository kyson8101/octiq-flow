import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyChat } from "./chat";
import { forgetChatCheckpoint, readChatCheckpoint, saveChatCheckpoint } from "./chatCache";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

it("retains a full checkpoint larger than the entire localStorage budget", async () => {
  const state = emptyChat();
  state.messages = [{ id: "m", role: "assistant", streaming: false,
    blocks: [{ kind: "text", text: "x".repeat(3 * 1024 * 1024) }] }];
  state.awaitingSummary = true;
  await saveChatCheckpoint({ id: "large", seq: 16000, state, updatedAt: 1 });
  expect(await readChatCheckpoint("large")).toEqual({ id: "large", seq: 16000, state, updatedAt: 1 });
  await forgetChatCheckpoint("large");
  expect(await readChatCheckpoint("large")).toBeUndefined();
});

it("keeps far more than the old 16 MiB across chats, and evicts oldest by bytes past the budget", async () => {
  const large = emptyChat();
  large.messages = [{ id: "m", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "x".repeat(3 * 1024 * 1024) }] }];
  // Ten ~6 MiB rows are 60 MiB: all kept now (the old cap kept two).
  for (let n = 0; n < 10; n++) await saveChatCheckpoint({ id: `large${n}`, seq: n, state: large, updatedAt: n });
  expect((await readChatCheckpoint("large0"))?.seq).toBe(0);
  expect((await readChatCheckpoint("large9"))?.seq).toBe(9);
  // A smaller budget evicts the oldest first.
  const small = 20 * 1024 * 1024;
  await saveChatCheckpoint({ id: "late", seq: 99, state: large, updatedAt: 100 }, small);
  expect(await readChatCheckpoint("large0")).toBeUndefined();
  expect(await readChatCheckpoint("large5")).toBeUndefined();
  expect((await readChatCheckpoint("late"))?.seq).toBe(99);
  expect((await readChatCheckpoint("large9"))?.seq).toBe(9);
  for (let n = 0; n < 20; n++) await saveChatCheckpoint({ id: `tiny${n}`, seq: n, state: emptyChat(), updatedAt: n + 200 });
  expect((await readChatCheckpoint("tiny0"))?.seq).toBe(0);
  expect((await readChatCheckpoint("tiny19"))?.seq).toBe(19);
});

it("never clones an oversized checkpoint into IndexedDB", async () => {
  const state = emptyChat();
  state.messages = [{ id: "m", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "x".repeat(17 * 1024 * 1024) }] }];
  await saveChatCheckpoint({ id: "huge", seq: 1, state, updatedAt: 1 });
  expect(await readChatCheckpoint("huge")).toBeUndefined();
});

it("makes room and retries when the browser reports a full disk, and never throws", async () => {
  const put = IDBObjectStore.prototype.put as (...a: unknown[]) => unknown;
  let calls = 0;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
    if (this.name === "checkpoints" && ++calls === 1) throw new DOMException("full", "QuotaExceededError");
    return put.apply(this, args) as IDBRequest;
  });
  await saveChatCheckpoint({ id: "a", seq: 7, state: emptyChat(), updatedAt: 1 });
  expect(calls).toBe(2);
  expect((await readChatCheckpoint("a"))?.seq).toBe(7);
  spy.mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  await expect(saveChatCheckpoint({ id: "b", seq: 1, state: emptyChat(), updatedAt: 2 })).resolves.toBeUndefined();
  spy.mockRestore();
  expect(await readChatCheckpoint("b")).toBeUndefined();
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
    const open = indexedDB.open("octiq.chat-cache", 2);
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

it("leaves a frame the person sent in a checkpoint as their own message", async () => {
  const state = staleChat();
  state.messages[0].turnId = "t1";
  await saveChatCheckpoint({ id: "sent", seq: 5, state, updatedAt: 1 });
  await restamp("sent", { schema: 1 });

  expect((await readChatCheckpoint("sent"))?.state.messages[0].role).toBe("user");
});

it("redraws a checkpointed hand-back that carries nothing but an echo", async () => {
  // A rebuilt turn is stamped `echo` whoever wrote it, so the echo alone does
  // not keep a pre-6ea80b0 report as a bubble.
  const state = staleChat();
  state.messages[0].echo = "u1";
  await saveChatCheckpoint({ id: "echoed", seq: 5, state, updatedAt: 1 });
  await restamp("echoed", { schema: 3 });

  expect((await readChatCheckpoint("echoed"))?.state.messages[0]).toMatchObject({
    role: "assistant",
    blocks: [{ kind: "peer", from: "a1" }],
  });
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

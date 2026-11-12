import { valueBytes } from "./valueBytes";
import type { ChatState } from "./chat";
import { BUILD_STAMP, ourBuild, type StoredStamp } from "./buildStamp";
import { migrateMessages } from "./cacheMigration";

/** A reducer checkpoint, not just messages: an incremental replay also needs
 * pending tool calls, compaction state, and replay metadata. */
export type ChatCheckpoint = { id: string; seq: number; generation?: string; state: ChatState; updatedAt: number };
const DATABASE = "octiq.chat-cache";
const TABLE = "checkpoints";
// IndexedDB has its own, far larger quota than localStorage, and a reload must
// bring back every chat the person had open, not the last two. Per-chat rows
// above CHECKPOINT_BYTES are not cached (the paged read serves them).
export const CHAT_CACHE_BYTES = 128 * 1024 * 1024;
export const CHECKPOINT_BYTES = 32 * 1024 * 1024;
const SIZES = "sizes";
// A clear also cancels optional cache operations already waiting for IDB.
// One counter avoids retaining an entry for every chat ever invalidated.
let revision = 0;

/** The stamp is the cache's own business: callers hand over a checkpoint and
 *  get one back, and never see this. Shared with lib/store, which keeps the
 *  other copy of the same transcripts — see lib/buildStamp for why. */
type StampedCheckpoint = ChatCheckpoint & StoredStamp & { bytes: number };

// Storage is optional. A blocked/private-mode database must never prevent a
// server read. Opening per operation also avoids holding a version upgrade open.
function database(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (db?: IDBDatabase) => {
      if (finished) { db?.close(); return; }
      finished = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => finish(), 500);
    try {
      const request = indexedDB.open(DATABASE, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        // Cache only: old count-capped rows can be arbitrarily large. Clear
        // them without deserializing them; the durable record stays on server.
        if (db.objectStoreNames.contains(TABLE)) db.deleteObjectStore(TABLE);
        const table = db.createObjectStore(TABLE, { keyPath: "id" });
        table.createIndex("updatedAt", "updatedAt");
        const sizes = db.createObjectStore(SIZES, { keyPath: "id" });
        sizes.createIndex("updatedAt", "updatedAt");
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = () => finish();
      request.onblocked = () => finish();
    } catch { finish(); }
  });
}

export async function readChatCheckpoint(id: string): Promise<ChatCheckpoint | undefined> {
  const started = revision;
  const db = await database();
  if (!db) return;
  return new Promise((resolve) => {
    const finish = (value?: ChatCheckpoint) => {
      clearTimeout(timer);
      db.close();
      resolve(started === revision ? value : undefined);
    };
    const timer = setTimeout(() => finish(), 500);
    try {
      const request = db.transaction(TABLE).objectStore(TABLE).get(id);
      request.onsuccess = () => {
        const value = request.result as StampedCheckpoint | undefined;
        const usable = value?.bytes !== undefined && value.bytes <= CHECKPOINT_BYTES && value.id === id && Number.isSafeInteger(value.seq) && value.seq >= 0
          && Array.isArray(value.state?.messages);
        // The stamp is STRIPPED rather than the payload re-listed. Listing the
        // fields by hand is how the sibling store went wrong twice (see the
        // note above `rewriteConversation`): a field added to ChatCheckpoint
        // later would be dropped here silently, and the type cannot catch it.
        const kept = value as StampedCheckpoint | undefined;
        if (!usable || !kept) return finish();
        const stale = !ourBuild(kept);
        delete kept.schema;
        delete (kept as Partial<StampedCheckpoint>).bytes;
        // A checkpoint an earlier reader wrote is carried forward, not
        // refused. Refusing it does not send the chat back to the transcript —
        // it sends it to the PAGED path, which serves only the last few turns
        // and, being paged, never re-caches. The conversation would come back
        // a fraction of itself. See lib/cacheMigration.
        finish(stale
          ? { ...kept, state: { ...kept.state, messages: migrateMessages(kept.state.messages) } }
          : (kept as ChatCheckpoint));
      };
      request.onerror = () => finish();
    } catch { finish(); }
  });
}

type Outcome = "done" | "quota" | "failed";

/** Make room in a transaction of its own: delete the oldest rows until the
 * newest ones, plus `incoming` bytes for the row about to be written (whose own
 * old copy does not count), fit in `limit`. It COMMITS before the write that
 * needs the room is attempted. Evicting inside the write's transaction was the
 * hole: a QuotaExceededError aborts that whole transaction, which rolls the
 * eviction back with it, so a full disk stayed full however often it retried. */
function makeRoom(db: IDBDatabase, id: string, incoming: number, limit: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let tx: IDBTransaction;
    try { tx = db.transaction([TABLE, SIZES], "readwrite"); } catch { return resolve(false); }
    try {
      const table = tx.objectStore(TABLE);
      const sizes = tx.objectStore(SIZES);
      let kept = incoming;
      const cursor = sizes.index("updatedAt").openCursor(null, "prev");
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        if (row.value.id !== id) {
          kept += row.value.bytes;
          if (kept > limit) { table.delete(row.primaryKey); row.delete(); }
        }
        row.continue();
      };
    } catch { return resolve(false); }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/** One write transaction: the row and its size, nothing else. The outcome tells
 * a full disk apart from any other failure. */
function write(db: IDBDatabase, checkpoint: ChatCheckpoint, bytes: number): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    let tx: IDBTransaction;
    try { tx = db.transaction([TABLE, SIZES], "readwrite"); } catch { return resolve("failed"); }
    // Structured cloning avoids serialising large transcripts into the small,
    // synchronous localStorage quota. Keep a bounded set of recent chats.
    //
    // Stamped HERE rather than by the caller: three places write checkpoints,
    // and a stamp any one of them could forget is worse than no stamp at all —
    // it would read as trustworthy.
    try {
      tx.objectStore(TABLE).put({ ...checkpoint, ...BUILD_STAMP, bytes });
      tx.objectStore(SIZES).put({ id: checkpoint.id, updatedAt: checkpoint.updatedAt, bytes });
    } catch (error) { return resolve(isQuota(error) ? "quota" : "failed"); }
    tx.oncomplete = () => resolve("done");
    tx.onerror = () => resolve(isQuota(tx.error) ? "quota" : "failed");
    tx.onabort = () => resolve(isQuota(tx.error) ? "quota" : "failed");
  });
}
const isQuota = (error: unknown) => (error as { name?: string } | null)?.name === "QuotaExceededError";

export async function saveChatCheckpoint(checkpoint: ChatCheckpoint, budget = CHAT_CACHE_BYTES): Promise<void> {
  const started = revision;
  const bytes = valueBytes(checkpoint, CHECKPOINT_BYTES);
  if (bytes > CHECKPOINT_BYTES) { await forgetChatCheckpoint(checkpoint.id); return; }
  const db = await database();
  if (!db) return;
  if (started !== revision) { db.close(); return; }
  try {
    // Make room in a COMMITTED transaction, then write. A full disk is the
    // browser's answer, not ours: evict again, harder (half the budget, then
    // everything but this row) and write again. On a repeated quota error the
    // checkpoint is skipped and the server read serves the chat, as before.
    // Never throws into the caller; a clear (revision) cancels every step.
    const limits = [budget, Math.max(bytes, Math.floor(budget / 2)), bytes];
    for (const limit of limits) {
      if (started !== revision) break;
      if (!await makeRoom(db, checkpoint.id, bytes, limit)) break;
      if (started !== revision) break;
      const outcome = await write(db, checkpoint, bytes);
      if (outcome !== "quota") break;
    }
  } catch { /* cache/quota failure falls back to the server */ }
  finally { db.close(); }
}

export async function forgetChatCheckpoint(id: string): Promise<void> {
  revision++;
  const db = await database();
  if (!db) return;
  try { const tx = db.transaction([TABLE, SIZES], "readwrite"); tx.objectStore(TABLE).delete(id); tx.objectStore(SIZES).delete(id); }
  catch { /* optional cache */ }
  finally { db.close(); }
}

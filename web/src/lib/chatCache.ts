import type { ChatState } from "./chat";
import { BUILD_STAMP, ourBuild, type StoredStamp } from "./buildStamp";
import { migrateMessages } from "./cacheMigration";

/** A reducer checkpoint, not just messages: an incremental replay also needs
 * pending tool calls, compaction state, and replay metadata. */
export type ChatCheckpoint = { id: string; seq: number; state: ChatState; updatedAt: number };
const DATABASE = "octiq.chat-cache";
const TABLE = "checkpoints";
const LIMIT = 12;

/** The stamp is the cache's own business: callers hand over a checkpoint and
 *  get one back, and never see this. Shared with lib/store, which keeps the
 *  other copy of the same transcripts — see lib/buildStamp for why. */
type StampedCheckpoint = ChatCheckpoint & StoredStamp;

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
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const table = request.result.createObjectStore(TABLE, { keyPath: "id" });
        table.createIndex("updatedAt", "updatedAt");
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = () => finish();
      request.onblocked = () => finish();
    } catch { finish(); }
  });
}

export async function readChatCheckpoint(id: string): Promise<ChatCheckpoint | undefined> {
  const db = await database();
  if (!db) return;
  return new Promise((resolve) => {
    const finish = (value?: ChatCheckpoint) => {
      clearTimeout(timer);
      db.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(), 500);
    try {
      const request = db.transaction(TABLE).objectStore(TABLE).get(id);
      request.onsuccess = () => {
        const value = request.result as StampedCheckpoint | undefined;
        const usable = value?.id === id && Number.isSafeInteger(value.seq) && value.seq >= 0
          && Array.isArray(value.state?.messages);
        // The stamp is STRIPPED rather than the payload re-listed. Listing the
        // fields by hand is how the sibling store went wrong twice (see the
        // note above `rewriteConversation`): a field added to ChatCheckpoint
        // later would be dropped here silently, and the type cannot catch it.
        const kept = value as StampedCheckpoint | undefined;
        if (!usable || !kept) return finish();
        const stale = !ourBuild(kept);
        delete kept.schema;
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

export async function saveChatCheckpoint(checkpoint: ChatCheckpoint): Promise<void> {
  const db = await database();
  if (!db) return;
  try {
    const tx = db.transaction(TABLE, "readwrite");
    const table = tx.objectStore(TABLE);
    // Structured cloning avoids serialising large transcripts into the small,
    // synchronous localStorage quota. Keep a bounded set of recent chats.
    //
    // Stamped HERE rather than by the caller: three places write checkpoints,
    // and a stamp any one of them could forget is worse than no stamp at all —
    // it would read as trustworthy.
    table.put({ ...checkpoint, ...BUILD_STAMP });
    let kept = 0;
    const cursor = table.index("updatedAt").openKeyCursor(null, "prev");
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      if (++kept > LIMIT) table.delete(row.primaryKey);
      row.continue();
    };
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* cache/quota failure falls back to the server */ }
  finally { db.close(); }
}

export async function forgetChatCheckpoint(id: string): Promise<void> {
  const db = await database();
  if (!db) return;
  try { db.transaction(TABLE, "readwrite").objectStore(TABLE).delete(id); }
  catch { /* optional cache */ }
  finally { db.close(); }
}

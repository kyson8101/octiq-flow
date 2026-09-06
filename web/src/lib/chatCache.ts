import type { ChatState } from "./chat";

/** A reducer checkpoint, not just messages: an incremental replay also needs
 * pending tool calls, compaction state, and the room's state. */
export type ChatCheckpoint = { id: string; seq: number; state: ChatState; updatedAt: number };
const DATABASE = "octiq.chat-cache";
const TABLE = "checkpoints";
const LIMIT = 12;

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
        const value = request.result as ChatCheckpoint | undefined;
        finish(value?.id === id && Number.isSafeInteger(value.seq) && value.seq >= 0
          && Array.isArray(value.state?.messages) ? value : undefined);
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
    table.put(checkpoint);
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

// The chats this browser has thrown away, written down so they stay away.
//
// Deleting a chat is three separate acts — the row goes, the copy this page
// holds goes, and the server's entry goes — and only the first two are certain.
// The third is a call across a socket, and a socket that closes with a call in
// flight never answers it. The entry then survives the delete, the next
// `chat_index_list` carries the chat, and the sidebar hands it back as though
// nothing had happened. Told at the same moment that its transcript is still on
// disk, the page has no way to tell that chat from one started on the phone.
//
// So the delete is remembered rather than assumed: an id lands here the moment
// the delete is committed, and everything that can put a chat back — the cached
// list read at startup, the server's index, the debounced save — asks here
// first. A tombstone also carries the transcript key, which is what lets the
// removal be sent again on the next visit, so an entry that outlived one
// session does not outlive the next.
//
// It is per-browser and deliberately so: this is the record of what THIS page
// was told to forget. A delete made on the phone reaches the laptop the way it
// always did, through the server's list.

const KEY = "octiq.v2.deletedChats";

/** How long a tombstone is kept.
 *
 *  It only has to outlive the doubt. Once the server has actually dropped the
 *  entry, nothing can offer the chat back, and a tombstone kept past that point
 *  is only a name in storage. A month covers a backend that was unreachable for
 *  a very long weekend and then some. */
export const DELETION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A ceiling, so a browser that has deleted chats for a year does not carry
 *  every one of them. The oldest go first — they are the ones whose delete has
 *  had the longest to land. */
export const MAX_DELETIONS = 200;

export type Deletion = {
  /** The conversation's id, as the sidebar and the server's index know it. */
  id: string;
  /** The key its transcript is filed under, so the removal can be sent again. */
  key: string;
  /** When it was deleted. */
  at: number;
};

/** Read once, then kept here. Storage can be blocked outright — a private
 *  window, a browser set to refuse it — and this page still has to hold a
 *  delete for as long as it is open. */
let cache: Deletion[] | null = null;

function read(): Deletion[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    cache = Array.isArray(raw)
      ? raw.filter(
          (d) =>
            d && typeof d.id === "string" && typeof d.key === "string" && typeof d.at === "number",
        )
      : [];
  } catch {
    // Blocked, or a stored value that is not JSON. Neither is worth a crash on
    // the way to drawing the sidebar.
    cache = [];
  }
  return cache;
}

function write(list: Deletion[]): void {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: the list holds for this visit only */
  }
}

/** Drop what is too old to matter, and hold the list to its ceiling. */
function pruned(list: Deletion[], now: number): Deletion[] {
  const fresh = list.filter((d) => now - d.at < DELETION_TTL_MS);
  if (fresh.length <= MAX_DELETIONS) return fresh;
  // The newest are the ones still worth doubting, so those are the ones kept.
  return [...fresh].sort((a, b) => a.at - b.at).slice(fresh.length - MAX_DELETIONS);
}

/** Write a chat off. Called when the delete is COMMITTED — not when the row
 *  disappears, which is still undoable for a few seconds. */
export function markDeleted(id: string, key: string, now = Date.now()): void {
  const list = pruned(read(), now).filter((d) => d.id !== id);
  list.push({ id, key, at: now });
  write(pruned(list, now));
}

/** Every chat this browser knows it deleted, oldest first. What the retry of a
 *  removal that never landed reads. */
export function listDeletions(now = Date.now()): Deletion[] {
  const held = read();
  const list = pruned(held, now);
  if (list.length !== held.length) write(list);
  return list;
}

/** Whether this chat was deleted here. The question every path that could put
 *  a chat back has to ask. */
export function isDeleted(id: string, now = Date.now()): boolean {
  return listDeletions(now).some((d) => d.id === id);
}

/** The ids, for filtering a whole list at once. */
export function deletedIds(now = Date.now()): Set<string> {
  return new Set(listDeletions(now).map((d) => d.id));
}

/** Let a tombstone go. Nothing in the app asks for a deleted chat back today;
 *  this exists so that the record of a delete is never the thing that makes one
 *  impossible to undo. */
export function forgetDeletion(id: string): void {
  const list = read();
  if (!list.some((d) => d.id === id)) return;
  write(list.filter((d) => d.id !== id));
}

/** Forget what was read, so the next question goes back to storage. For tests,
 *  and for anything that means "as if the page had just opened". */
export function resetDeletions(): void {
  cache = null;
}

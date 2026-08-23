/** Whose idea of "is this a room" wins, when the two disagree.
 *
 *  There are two answers to that question and they are stored in different
 *  places, so they drift:
 *
 *  * the BROWSER remembers it on the conversation, in `localStorage`, because a
 *    reopened chat must not silently change what it was held under;
 *  * the BACKEND holds rooms in memory, so a restart forgets every one of them.
 *
 *  Each can be ahead of the other, and both ways were reachable in practice:
 *  turning a room on outside the client left the browser saying "single chat"
 *  on the next reload, and a backend restart left the browser saying "group
 *  chat" for a room that no longer existed.
 */
export type RoomSync =
  /** They agree. Nothing to do — the overwhelmingly common case. */
  | { do: "nothing" }
  /** The backend has a room this browser did not know about. Believe it. */
  | { do: "adopt" }
  /** This browser was told to make a room and the backend has since forgotten
   *  it. Ask for it again. */
  | { do: "reassert" };

/** Reconcile the two, on opening a chat.
 *
 *  The rule is that a person's INTENT outlives a process. If the browser was
 *  told to make this a room, a server restart is not a decision to undo that —
 *  so the room is asked for again rather than quietly falling back to a single
 *  chat. The seats really are gone either way (their processes died with the
 *  server), and nothing here pretends otherwise; only the mode is restored.
 *
 *  The other direction has no such question. A room the backend is holding is a
 *  fact, not an intent, so the browser simply believes it.
 */
export function roomSync(browserSays: boolean, backendSays: boolean): RoomSync {
  if (browserSays === backendSays) return { do: "nothing" };
  return backendSays ? { do: "adopt" } : { do: "reassert" };
}

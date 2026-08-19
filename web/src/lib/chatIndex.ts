// Getting a chat into the server's index, and keeping it there.
//
// The index is what makes a chat reachable from another device — and, since
// `chat_index::reconcile` deletes any transcript no index entry points at, it
// is also what stops the server throwing the chat's own record away at the next
// restart. An entry that never lands therefore does not cost a sidebar row; it
// costs the conversation.
//
// It used to be one fire-and-forget `invoke` with `.catch(() => {})` behind it,
// sent 700ms after the last message. Three things then went unnoticed:
//
//   - the backend restarting in that window (the socket drops, the call is
//     queued, the tab is closed before it drains),
//   - the call being refused, and
//   - the call being answered by nobody at all — a socket that closes with
//     invokes in flight never settles their promises, so `.catch` is not
//     reached and the failure is invisible even in principle.
//
// So entries are held until the server acknowledges them: unacknowledged ones
// are retried with a backoff, on a fresh connection, and — because a promise
// that never settles cannot be caught — under a deadline of their own.
import { bridge } from "./bridge";

/** A chat as the index holds it. Metadata only; the messages live in the
 *  chat's own transcript. */
export type IndexEntry = {
  id: string;
  projectId: string;
  title: string;
  sessionId: string | null;
  modelId: string | null;
  access: string | null;
  createdAt: number;
  updatedAt: number;
};

/** How long to wait for an acknowledgement before assuming the call is lost.
 *  Generous: this is a local write behind a socket, so anything approaching
 *  this is already a sign the connection, not the disk, is the problem. */
const ACK_MS = 8000;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

/** Entries the server has not confirmed, newest version per chat. Keyed by id,
 *  so a chat that changes twice while offline is sent once, current. */
const unconfirmed = new Map<string, IndexEntry>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 0;
let watchingConnection = false;

/** Record a chat in the server's index, and keep trying until it is there. */
export function saveIndexEntry(entry: IndexEntry): void {
  unconfirmed.set(entry.id, entry);
  watchConnection();
  flush();
}

/** Stop caring about a chat that has been deleted, so a queued retry cannot
 *  put it back after `chat_index_remove` has taken it out. */
export function forgetIndexEntry(id: string): void {
  unconfirmed.delete(id);
}

/** True while at least one entry is still unacknowledged. Exposed for tests
 *  and for anything that wants to know the index is behind. */
export function indexBacklog(): number {
  return unconfirmed.size;
}

/** A reconnection is the one moment worth retrying immediately: whatever was
 *  wrong a second ago has just changed. Registered once, lazily, so importing
 *  this module does not open anything by itself. */
function watchConnection(): void {
  if (watchingConnection) return;
  watchingConnection = true;
  bridge.onState((s) => {
    if (s !== "open") return;
    retryDelay = 0;
    flush();
  });
}

function scheduleRetry(): void {
  if (retryTimer || unconfirmed.size === 0) return;
  retryDelay = retryDelay === 0 ? FIRST_RETRY_MS : Math.min(retryDelay * 2, MAX_RETRY_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flush();
  }, retryDelay);
}

function flush(): void {
  for (const entry of [...unconfirmed.values()]) send(entry);
}

function send(entry: IndexEntry): void {
  // Raced against a deadline. `bridge.invoke` resolves or rejects only when a
  // reply arrives, and a socket that closes mid-call never brings one — so
  // without this the entry would sit here forever, silently.
  let settled = false;
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => {
      if (!settled) reject(new Error("chat_index_save was not acknowledged"));
    }, ACK_MS);
  });

  Promise.race([bridge.invoke("chat_index_save", { meta: entry }), deadline])
    .then(() => {
      settled = true;
      // Only clear the exact version that was acknowledged. A newer one may
      // have replaced it while this call was in the air, and that one still
      // has to be sent.
      if (unconfirmed.get(entry.id) === entry) unconfirmed.delete(entry.id);
      retryDelay = 0;
    })
    .catch(() => {
      settled = true;
      scheduleRetry();
    });
}

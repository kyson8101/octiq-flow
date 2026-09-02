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
  /** Sits above every newer chat in its project. */
  pinned: boolean;
};

/** How long to wait for an acknowledgement before assuming the call is lost.
 *  Generous: this is a local write behind a socket, so anything approaching
 *  this is already a sign the connection, not the disk, is the problem. */
const ACK_MS = 8000;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

/** What the server has not confirmed, newest per chat.
 *
 *  Saves AND removals, in one queue keyed by id, because they are two answers
 *  to the same question and the newest one wins. A removal that lands behind a
 *  queued save must not be overtaken by it: the save would put the chat back in
 *  the index seconds after the delete took it out, which is precisely how a
 *  deleted chat used to reappear. */
type Pending =
  | { kind: "save"; entry: IndexEntry }
  | { kind: "remove"; id: string; key: string };

const unconfirmed = new Map<string, Pending>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 0;
let watchingConnection = false;

/** Record a chat in the server's index, and keep trying until it is there. */
export function saveIndexEntry(entry: IndexEntry): void {
  // A chat on its way out is not written back in. Nothing should ask — the page
  // knows what it deleted — but this is the last gate before the wire, and a
  // save that slips past it is a chat back in the sidebar.
  if (unconfirmed.get(entry.id)?.kind === "remove") return;
  unconfirmed.set(entry.id, { kind: "save", entry });
  watchConnection();
  flush();
}

/** Take a deleted chat out of the server's index, and keep trying until it is
 *  gone.
 *
 *  This used to be a bare `invoke(...).catch(() => {})` at the delete site, and
 *  that is a delete which can quietly not happen: a socket closing with the
 *  call in flight never settles it, so there is no rejection to catch and
 *  nothing to retry. The entry survived, the next `chat_index_list` carried the
 *  chat, and the sidebar handed it back. */
export function removeIndexEntry(id: string, key: string): void {
  // Asked for again while the first one is still going — the index list is
  // re-read on every connect, and a chat still listed asks for its removal each
  // time. Queuing a second one would replace the object the call in flight is
  // holding, so its acknowledgement would clear nothing and the removal would
  // be sent forever. What is already queued is already being retried.
  const held = unconfirmed.get(id);
  if (held?.kind === "remove" && held.key === key) return;
  unconfirmed.set(id, { kind: "remove", id, key });
  watchConnection();
  flush();
}

/** Forget what is queued for a chat. Used by tests; the app either saves or
 *  removes, and both of those are answers rather than silence. */
export function resetIndexQueue(): void {
  unconfirmed.clear();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = 0;
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
  for (const pending of [...unconfirmed.values()]) send(pending);
}

function send(pending: Pending): void {
  const id = pending.kind === "save" ? pending.entry.id : pending.id;
  const [command, payload] =
    pending.kind === "save"
      ? (["chat_index_save", { meta: pending.entry }] as const)
      : (["chat_index_remove", { id: pending.id, key: pending.key }] as const);

  // Raced against a deadline. `bridge.invoke` resolves or rejects only when a
  // reply arrives, and a socket that closes mid-call never brings one — so
  // without this the entry would sit here forever, silently.
  let settled = false;
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => {
      if (!settled) reject(new Error(`${command} was not acknowledged`));
    }, ACK_MS);
  });

  Promise.race([bridge.invoke(command, payload), deadline])
    .then(() => {
      settled = true;
      // Only clear the exact thing that was acknowledged. A newer one may have
      // replaced it while this call was in the air — a removal, most of all —
      // and that one still has to be sent.
      if (unconfirmed.get(id) === pending) unconfirmed.delete(id);
      retryDelay = 0;
    })
    .catch(() => {
      settled = true;
      scheduleRetry();
    });
}

// Which chats the list is showing, and the tick that is the reason it has to
// choose.
//
// This is the one thing in the sidebar the person says themselves. Everything
// else on a chat row is observed — busy, unread, the branch it sits on, whether
// its work merged (`chat_task.rs`) — and none of those answer "I am finished
// with this one". An agent that stops replying has not necessarily finished,
// and a chat whose work merged may still be owed a look.
//
// The tick is a TIMESTAMP rather than a flag, and the whole auto-clear falls
// out of the comparison: a chat is done while its tick is at least as new as
// its last meaningful activity. Sending a message moves `updatedAt` past
// `doneAt` and the chat is simply not done any more — nothing had to notice,
// and no second write races the one recording the message. The stored tick is
// left alone, so a chat that goes quiet again does NOT silently re-tick: the
// next tick is a new one, made by hand, with a newer stamp.
import type { Conversation } from "./store";

/** Which chats the list is showing.
 *
 *  `active` is the default. `done` and `pinned` are the two states a row can
 *  be put INTO by hand, each with a view of its own, and `all` is the way back
 *  from either — a ticked chat must never be somewhere you cannot get to. */
export type ChatFilter = "active" | "pinned" | "done" | "all";

export const CHAT_FILTERS: readonly ChatFilter[] = ["active", "pinned", "done", "all"];

export function isChatFilter(value: unknown): value is ChatFilter {
  return typeof value === "string" && (CHAT_FILTERS as readonly string[]).includes(value);
}

/** Ticked off, and nothing has happened since.
 *
 *  `updatedAt` is deliberately the thing it races: it moves on a user send and
 *  on a completed agent turn, and NOT on streaming deltas (see `store.ts`), so
 *  a tick survives the rest of a turn that was already running when it was
 *  made, and does not survive the next question. */
export function isChatDone(chat: Conversation): boolean {
  const done = chat.doneAt;
  return typeof done === "number" && done >= chat.updatedAt;
}

/** The chats a filter shows, in the order they came in.
 *
 *  `keep` is the chat being read, and it stays listed whatever the filter
 *  says. Ticking off the chat you are looking at should SHOW you the tick, not
 *  pull the row out from under the pointer that made it; the row leaves the
 *  list once you move on, which is both undoable and unsurprising.
 *
 *  Order is preserved rather than appended to, because the tree built from
 *  this list ranks its rows by their position in it — a kept chat pushed to
 *  the end would jump to the bottom of the sidebar for as long as it was
 *  open. */
export function chatFilterList(
  chats: readonly Conversation[],
  filter: ChatFilter,
  keep: string | null = null,
): Conversation[] {
  if (filter === "all") return [...chats];
  // Pinned is read literally: a pinned chat you have also ticked off is still
  // pinned, and hiding it here would mean a row nothing in this menu lists.
  if (filter === "pinned") return chats.filter((chat) => chat.id === keep || !!chat.pinned);
  const want = filter === "done";
  return chats.filter((chat) => chat.id === keep || isChatDone(chat) === want);
}

/** How many chats a view would show. Drives whether that view is offered at
 *  all: a chip reading zero is a control explaining that it has nothing to do,
 *  and nobody who has never ticked or pinned anything needs the row. */
export function chatFilterCount(chats: readonly Conversation[], filter: ChatFilter): number {
  return chatFilterList(chats, filter).length;
}

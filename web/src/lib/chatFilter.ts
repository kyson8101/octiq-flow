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

/** Which chats the Recent list is showing.
 *
 *  `active` is the default and `done` holds what was ticked off by hand; `all`
 *  is the way back from either — a ticked chat must never be somewhere you
 *  cannot get to. Pins are not a view: the Pinned section above Recent always
 *  lists every pinned chat, whichever view Recent is on. A browser that saved
 *  the retired `pinned` view reads back as `active`. */
export type ChatFilter = "active" | "done" | "all";

export const CHAT_FILTERS: readonly ChatFilter[] = ["active", "done", "all"];

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
 *  says. `keepMarked` holds rows changed by hand in the current view, so
 *  ticking several chats does not shift the list under the pointer. The view
 *  can apply the filter again when the person chooses one.
 *
 *  Order is preserved rather than appended to, because the tree built from
 *  this list ranks its rows by their position in it — a kept chat pushed to
 *  the end would jump to the bottom of the sidebar for as long as it was
 *  open. */
export function chatFilterList(
  chats: readonly Conversation[],
  filter: ChatFilter,
  keep: string | null = null,
  keepMarked?: ReadonlySet<string>,
): Conversation[] {
  if (filter === "all") return [...chats];
  const want = filter === "done";
  return chats.filter((chat) => chat.id === keep || !!keepMarked?.has(chat.id) || isChatDone(chat) === want);
}

/** How many chats a view would show, for the count on its menu item. */
export function chatFilterCount(chats: readonly Conversation[], filter: ChatFilter): number {
  return chatFilterList(chats, filter).length;
}

export const CHAT_FILTER_LABELS: Record<ChatFilter, string> = {
  active: "Active", done: "Done", all: "All",
};

/** The views as the Recent dropdown offers them: all three, always, with a
 *  count on Done once it holds anything. */
export function chatFilterOptions(
  chats: readonly Conversation[],
  current: ChatFilter,
): { filter: ChatFilter; label: string; checked: boolean }[] {
  return CHAT_FILTERS.map((filter) => {
    const total = filter === "done" ? chatFilterCount(chats, filter) : 0;
    return {
      filter,
      label: total > 0 ? `${CHAT_FILTER_LABELS[filter]} (${total})` : CHAT_FILTER_LABELS[filter],
      checked: filter === current,
    };
  });
}

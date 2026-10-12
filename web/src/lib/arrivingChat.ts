// The chat the address asked for on arrival, while it is not on screen yet.
//
// A link (`#/p/<project>/c/<chat>`) opened in a browser that has no cached
// copy of that chat cannot open it until the chat list answers. Until then
// no chat is open, and the page drew the composer of a NEW conversation,
// with the row that chooses its project and branch: 42px that went away a
// moment later, when the chat opened, and moved the composer under the
// reader (0.0215 of layout shift on a fully cold open).
//
// So the page keeps the id it is waiting for, and a composer drawn in that
// moment is the linked chat's, not a new conversation's. The wait ends when
// a chat is on screen, when the page says the linked chat is unavailable, or
// when the chat list has answered and some time has passed with neither:
// from then on an empty page is a new conversation again.

/** How long after the chat list answered the page still waits for the
 *  linked chat to open, before it draws a new conversation's composer. */
export const ARRIVAL_GRACE_MS = 3_000;

export type Arrival = {
  /** The chat on screen. */
  conversationId: string | null;
  /** The page has said the linked chat is unavailable. */
  unavailable: string | null;
  /** The chat list answered, and the grace after it has run out. */
  gaveUp: boolean;
};

/** The id still waited for, or `null` once the wait is over. It never comes
 *  back: only the arrival waits. */
export function stillArriving(arriving: string | null, now: Arrival): string | null {
  if (!arriving) return null;
  return now.conversationId || now.unavailable || now.gaveUp ? null : arriving;
}

/** Whether the composer on screen is a new conversation's, with its choice
 *  of project and branch: no chat is open, and none is on its way. */
export function composesNewChat(conversationId: string | null, arriving: string | null): boolean {
  return !conversationId && !arriving;
}

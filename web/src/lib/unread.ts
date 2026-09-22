// Whether a chat has activity nobody has acknowledged.
//
// `readAt` lives on the server's index (`chat_index::mark_read`), so it is one
// fact shared by every device — a chat read on the phone is not still flagged
// unread on the laptop. `updatedAt` moves on a user SEND too (see the field's
// own doc comment in store.ts), which matters here: opening a chat and then
// sending something must not make it read as unread again the instant the
// send lands, and it does not, because `readAt` was already bumped to "now"
// by the open, and `updatedAt` moves no further back than that.
//
// The one case this cannot settle by itself is the chat CURRENTLY on screen.
// Its `updatedAt` can outrun `readAt` in the gap between an agent's reply
// landing and this device's own mark-read call actually reaching the server
// (queued, retried — see `lib/chatIndex`). So the caller always says which
// chat is open right now, in THIS tab, and that one reads as read regardless
// of the race.
import type { Conversation } from "./store";

/** A chat with activity since it was last opened, on any device.
 *  `currentId` is whichever chat is on screen in this tab right now. */
export function isUnread(conversation: Conversation, currentId: string | null): boolean {
  if (conversation.id === currentId) return false;
  const since = conversation.readAt ?? conversation.createdAt;
  return conversation.updatedAt > since;
}

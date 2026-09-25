// Carrying a cached transcript forward to how this reader draws it.
//
// A cache holds messages, not the events they were built from, and the events
// are never replayed past the point it stored — so when `reduceChat` starts
// drawing something differently, every chat already cached goes on showing the
// old drawing for ever.
//
// Throwing the cache away instead is worse than the stale drawing: a blanked
// transcript falls onto the paginated load path, the server serves only its
// last few turns, and every path that would re-cache it is gated on
// `hasEarlier` — so the chat pages for ever and the rest of it never comes
// back. Long conversations would lose most of themselves at every upgrade.
//
// So the words stay and the DRAWING is redone. Nothing is fetched, nothing is
// replayed, `seq` is untouched, and a cache that was whole stays whole.
import type { Message } from "./chat";
import { parsePeerMessages } from "./peerMessage";

/** The words of a message, as the cache stored them. */
function spoken(message: Message): string {
  return message.blocks
    .filter((b) => b.kind === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("");
}

/** Redraw a cached transcript the way this reader would have drawn it.
 *
 *  Schema 2 — a peer's words (a subagent handing its report back, another
 *  Claude session talking to this one) used to be drawn as a bubble the reader
 *  had typed, frame and all. The frame is still there in the cached text,
 *  which is what makes this readable without the original events.
 *
 *  A message that was SENT (`turnId`) is left as it is: that is a prompt
 *  OctiqFlow itself sent for the person, and a frame they pasted is still
 *  their words. An ECHO (`echo`) is NOT taken as the same proof: every turn
 *  rebuilt from the record is stamped with one, a subagent's hand-back
 *  included, so skipping on it left every report cached before 6ea80b0 as a
 *  raw-XML bubble — the very thing this migration exists to redraw. The cache
 *  kept no `isSynthetic`, so "not sent by us" is the nearest it has.
 *
 *  The trade-off, accepted: an old message the person typed that is nothing
 *  but a well-formed frame, and that carries only an echo, is redrawn as a
 *  peer's. Rare, and only the drawing changes — the words stay.
 *
 *  Idempotent: a message already redrawn holds a `peer` block rather than
 *  text, so it no longer matches. That matters because this runs on every load
 *  until the row is saved back with the current stamp. */
export function migrateMessages(messages: Message[]): Message[] {
  let changed = false;
  const drawn = messages.map((message) => {
    if (message.role !== "user" || message.turnId) return message;
    const text = spoken(message);
    if (!text) return message;
    const peers = parsePeerMessages(text, undefined, { synthetic: true });
    if (!peers.length) return message;
    changed = true;
    return {
      // The id is kept: it is what a later echo, a scroll position and the
      // conversation map all find this turn by.
      id: message.id,
      role: "assistant" as const,
      blocks: peers.map((peer) => ({
        kind: "peer" as const,
        source: peer.source,
        from: peer.from,
        text: peer.text,
      })),
      streaming: false,
    };
  });
  // The same array back when nothing moved, so React sees no change and a
  // conversation that needed no migration re-renders nothing.
  return changed ? drawn : messages;
}

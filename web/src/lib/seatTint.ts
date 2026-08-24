// The colour a seat speaks in.
//
// A room's replies were all drawn the same: the same prose, the same width,
// and above them an 11px name at 32% opacity — the FAINTEST text on the page
// carrying the first question a room asks, which of these is talking. Three
// seats deep, a scrolled-back transcript is a wall with no owners.
//
// So each seat is given a colour and keeps it. The colour is never the only
// thing saying who spoke — the name and the agent's mark are right beside it,
// exactly as `.tool-icon` states its tint next to the tool's name — so it can
// stay quiet, and colour-blindness costs nothing.
//
// Handed out in order of FIRST APPEARANCE rather than hashed from the name.
// A hash reads like the tidier answer and is the wrong one: eight slots and
// five seats collide four times out of five (the birthday problem), and two
// seats sharing a colour is precisely the confusion this exists to end. Order
// makes distinctness a promise up to the size of the palette. It is also
// stable — the transcript replays in the same order every time — and it never
// reshuffles the answers already on screen when a seat joins mid-conversation.
import type { Message, Speaker } from "./chat";

/** How many colours the stylesheet defines (`.msg-role[data-tint="N"]`).
 *  Eight, because a room of more than eight is not a room. */
export const SEAT_TINTS = 8;

/** What counts as the same seat twice.
 *
 *  The NAME, not the id: a seat dropped and added back is the same person to
 *  whoever is reading, and it comes back with a new id. The id is the fallback
 *  for a seat that arrived without a name at all — see `chat::readSpeaker`,
 *  which can produce one. */
export function seatKey(speaker: Pick<Speaker, "id" | "name">): string {
  return speaker.name || speaker.id;
}

/** Every seat that has spoken, mapped to its colour. The host is not in it:
 *  it has no seat, it is the one voice a room never has to identify. */
export function seatTints(messages: Pick<Message, "speaker">[]): Map<string, number> {
  const tints = new Map<string, number>();
  for (const m of messages) {
    if (!m.speaker) continue;
    const key = seatKey(m.speaker);
    if (!tints.has(key)) tints.set(key, tints.size % SEAT_TINTS);
  }
  return tints;
}

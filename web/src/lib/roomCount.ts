// Card 84 — how many agents are in this chat.
//
// Card 82 removed the mode switch, and with it the only thing on screen that
// said a chat was a group before anybody spoke. The user asked for the count
// instead: *"then it should hv shown agents counts on top if more than 1
// agents"*.

export type RoomCount = {
  /** The host and the seats together. */
  total: number;
  /** What the number means, for a screen reader and for anyone hovering it. */
  label: string;
};

/** The count to show at the top, or `null` when there is nothing worth saying.
 *
 *  The HOST counts. It is an agent in the room, not the furniture — two seats
 *  and the host is three voices, and three is the number a reader is counting
 *  when they look at the names down the transcript.
 *
 *  One is never shown. A badge that appears in every chat in the app says
 *  nothing about any of them, and one agent is what a chat has always had. */
export function roomCount(seats: number): RoomCount | null {
  if (seats < 1) return null;
  const total = seats + 1;
  return { total, label: `${total} agents in this chat` };
}

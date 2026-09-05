// Turning the backend's memory rows into something a person can act on.
//
// `memory.rs` reports ids, not names, and deliberately: it knows a chat by its
// session key (`chat:<conversationId>`, or `…-seat-<seatId>` for a seat) and a
// terminal by its PTY id, and it has never known what either is CALLED. The
// names live in this browser — the conversation list, the tab strip, the
// project list — so the join happens here.
//
// A row whose id resolves to nothing still shows. It is holding real memory
// either way, and "something, 450 MB" is a useful thing to be told; a row that
// quietly vanished because its name could not be found would make the numbers
// stop adding up, which is the one thing a readout like this must never do.
import type { Store as TerminalStore } from "./terminals";

export type MemoryRow = {
  kind: string;
  id: string;
  mb: number;
  procs: number;
};

export type MemoryUsage = {
  totalMb: number;
  procs: number;
  rows: MemoryRow[];
};

/** Everything this browser knows that could name a row. */
export type NameSource = {
  conversations: { id: string; title: string; projectId: string }[];
  projects: { id: string; name: string }[];
  terminals: TerminalStore;
};

/** What one row is called: the thing itself, and where it lives.
 *
 *  Two fields rather than one string because they are read differently — the
 *  name is what you scan down the list for, `where` is only what you fall back
 *  on when two rows are called the same thing. */
export type RowName = { name: string; where?: string };

const CHAT_PREFIX = "chat:";
const SEAT_MARK = "-seat-";

/** The conversation id inside a chat session key, and whether it names a seat.
 *
 *  The two separators are `chat_room::seat_session_key`'s, and this is the only
 *  place the client takes a key apart — a key it does not recognise yields no
 *  conversation id at all rather than a guess. */
export function splitChatKey(key: string): { conversationId: string; seat: boolean } | null {
  if (!key.startsWith(CHAT_PREFIX)) return null;
  const rest = key.slice(CHAT_PREFIX.length);
  if (!rest) return null;
  const at = rest.indexOf(SEAT_MARK);
  return at === -1
    ? { conversationId: rest, seat: false }
    : { conversationId: rest.slice(0, at), seat: true };
}

/** Find the terminal tab with this PTY id, and the project it belongs to. */
function findTerm(
  terminals: TerminalStore,
  id: string,
): { name: string; projectId: string } | null {
  for (const [projectId, tabs] of Object.entries(terminals ?? {})) {
    const hit = tabs?.tabs?.find((t) => t.id === id);
    if (hit) return { name: hit.name, projectId };
  }
  return null;
}

/** What to call one row of the memory readout. */
export function nameRow(row: MemoryRow, source: NameSource): RowName {
  const projectName = (id: string) => source.projects.find((p) => p.id === id)?.name;

  if (row.kind === "server") return { name: "OctiqFlow" };

  if (row.kind === "chat") {
    const parsed = splitChatKey(row.id);
    const held = parsed && source.conversations.find((c) => c.id === parsed.conversationId);
    // A seat is a second agent inside a conversation, so it is named by the
    // conversation it sits in — the seat's own name is in the room roster,
    // which this readout has no business loading just to draw a row.
    const suffix = parsed?.seat ? " · seat" : "";
    if (held) return { name: `${held.title}${suffix}`, where: projectName(held.projectId) };
    // Known to be a chat, but not one this browser holds: another device
    // started it, or it was deleted here while its process ran on.
    return { name: `Chat${suffix}`, where: "not on this device" };
  }

  if (row.kind === "terminal") {
    const term = findTerm(source.terminals, row.id);
    if (term) return { name: term.name, where: projectName(term.projectId) };
    return { name: "Terminal" };
  }

  return { name: row.kind || "Unknown" };
}

/** "3.8 GB" / "446 MB" — the readout, at the precision the number deserves.
 *
 *  Under a gigabyte the megabyte IS the reading. Over one it is noise: nobody
 *  acts differently on 3814 MB than on 3.8 GB, and a four-digit number in the
 *  top bar is four digits that change every poll. */
export function formatMb(mb: number): string {
  if (!Number.isFinite(mb) || mb < 0) return "—";
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

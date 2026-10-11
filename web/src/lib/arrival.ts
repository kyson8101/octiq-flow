// Which things ARRIVED, as opposed to being there when the page was drawn.
//
// Half of what a chat shows is not known at first paint: the project a row
// belongs to, the run it owns, the card waiting on an answer, the usage
// number. Each used to appear the instant its answer landed, and several of
// them pushed whatever sat below. The motion that replaces that is one set of
// classes in `design-system.css`; this module decides who gets them.
//
// The rule is the one `justAppended` (MessageList) already keeps for a sent
// message, said once for everything else: a thing enters only if the place it
// enters was on screen WITHOUT it first. A chat that opens with a card already
// waiting draws the card in place; so does a chat you come back to, a list
// read out of the browser's cache, and every re-render in between.
//
// Nothing here touches the DOM or a clock, so every case is a test.

/** What one place has shown so far. `scope` names the place — a chat id, or
 *  nothing for a thing that lives as long as the page. */
export type Arrivals = {
  scope: string;
  /** Everything on screen now. */
  here: ReadonlySet<string>;
  /** The part of it that came in after the place was first drawn. */
  late: ReadonlySet<string>;
};

/** Fold one render into the record.
 *
 *  The first draw of a scope marks nothing late: it has nothing to be late
 *  after. From then on a key not yet on screen is an arrival, and stays one —
 *  a class that came and went between renders would cut its own animation
 *  short. A key that leaves is forgotten, so the same thing coming back is a
 *  new arrival: it is new on screen, whatever it is called.
 *
 *  Hands `before` back when nothing changed, which is nearly every call. */
export function arrive(before: Arrivals | null, scope: string, present: readonly string[]): Arrivals {
  if (!before || before.scope !== scope) {
    return { scope, here: new Set(present), late: new Set() };
  }
  let changed = before.here.size !== present.length;
  if (!changed) for (const key of present) if (!before.here.has(key)) { changed = true; break; }
  if (!changed) return before;
  const here = new Set(present);
  const late = new Set<string>();
  for (const key of here) if (!before.here.has(key) || before.late.has(key)) late.add(key);
  return { scope, here, late };
}

/** Where a gate that opens once is: `held` until its answer is in, `entering`
 *  for the length of the entry, `settled` from then on.
 *
 *  Three states rather than a flag because of what reads it: a class on a
 *  CONTAINER, whose children fade in together when the answer lands. Left on
 *  for good, every child mounted later would run the same fade on its own —
 *  a new chat row arriving with an entry of its own, say. */
export type EntryPhase = "held" | "entering" | "settled";

/** The phase for this render.
 *
 *  `wasReady` is whether the answer was already in when the place was first
 *  drawn: then nothing arrives and nothing moves. `done` is whether the entry
 *  has already run its length. */
export function entryPhase(wasReady: boolean, ready: boolean, done: boolean): EntryPhase {
  if (!ready) return "held";
  return wasReady || done ? "settled" : "entering";
}

/** How long an `entering` class stays on. The longest entry in
 *  `design-system.css` (`--enter-reveal-duration`) and a frame or two over, so
 *  the class never comes off under a running animation. Keep the two in step. */
export const ENTRY_MS = 260;

/** The most turns one render may add and still count as live. A message of
 *  yours and the first of its answer can land in one commit; anything past
 *  that is a catch-up after a dropped connection, and a catch-up is history. */
const LIVE_APPEND_MAX = 2;

/** Whether what this render added to a transcript arrived LIVE.
 *
 *  A card inside the conversation enters only when it was just said. Opening a
 *  chat mounts its whole history in one commit, and paging back mounts an
 *  older page above it; neither is an arrival, and a long transcript fading in
 *  card by card is exactly what this has to refuse.
 *
 *  So: the turns before must still be there, in order, at the START of the
 *  list — nothing was replaced and nothing was put in front — and at most a
 *  couple were added. No turns added at all is live too: the last answer
 *  growing a block is the commonest arrival there is. */
export function liveAppend(was: readonly string[] | null, ids: readonly string[]): boolean {
  if (!was) return false;
  const added = ids.length - was.length;
  if (added < 0 || added > LIVE_APPEND_MAX) return false;
  // An empty transcript filling up is a chat being read back, unless it is
  // one turn: the first message in a new chat.
  if (was.length === 0 && added > 1) return false;
  for (let index = 0; index < was.length; index += 1) if (was[index] !== ids[index]) return false;
  return true;
}

/** What a transcript had on screen at its last COMMIT: which chat, and its
 *  turns. */
export type Drawn = { scope: string; ids: readonly string[] };

/** Whether the turns of this render arrived live, asked against what was
 *  last committed and never against what an earlier pass of the same render
 *  saw.
 *
 *  React may run one render more than once before it commits: a state set
 *  during render re-runs it (the transcript's own window does, on a chat
 *  switch), and StrictMode runs every render twice. `liveAppend` answers
 *  "nothing was added" with yes, so a record written by the first pass made
 *  the second take a whole history for an answer growing a block, and every
 *  notice in a chat you came back to ran its entry again. `committed` only
 *  moves when React commits, so every pass of one render gets one answer.
 *
 *  Another chat's turns are never live, whatever they look like: an empty
 *  chat left for one with a single turn is a chat being opened. */
export function liveSince(committed: Drawn | null, scope: string, ids: readonly string[]): boolean {
  if (!committed || committed.scope !== scope) return false;
  return liveAppend(committed.ids, ids);
}

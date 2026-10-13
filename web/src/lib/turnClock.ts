// How long a turn has been WORKED on: the time since it started, less the
// time it stood waiting on the person.
//
// The agent is parked while a card is up, so that time is not the turn's.
// The eyebrow's clock stops when a wait begins, and when the answer is given
// it goes on from where it stopped: the wait is never added.
//
// Everything here is on one clock, the page's: `turn` is when this page saw
// the turn start (`ChatState.turnStartedAt`), and a wait runs from when this
// page first saw it to when it last saw it. No host stamp is compared with
// `Date.now()`, so a browser whose clock is off is off by nothing.
//
// It is in memory. A page loaded in the middle of a wait knows neither when
// the turn began nor how long it has waited: its turn starts when the page
// joined it (as it does for any turn joined part-way) and the wait starts
// when the page first sees the card, a moment later. So until the answer it
// shows a clock stopped at about nothing beside the waiting words, and after
// it counts the work done since: never the wait.

/** The waits of one turn. */
export type TurnWaits = {
  /** Which turn: when it started, as the page has it. */
  turn: number;
  /** Waits that are over, added up, in milliseconds. */
  waited: number;
  /** When the wait that is on now began, or `null` while work goes on. */
  since: number | null;
};

/** What the page sees now, folded into what it had: a wait beginning, a wait
 *  ending, or a new turn. Returns the same object when nothing changed, and
 *  nothing for a chat with no turn in flight. */
export function noteWait(
  before: TurnWaits | undefined,
  turn: number | undefined,
  waiting: boolean,
  now: number,
): TurnWaits | undefined {
  if (turn === undefined) return undefined;
  // Another turn: nothing of the last one's waits is this one's. A turn that
  // has not waited yet has nothing to keep.
  if (!before || before.turn !== turn) return waiting ? { turn, waited: 0, since: now } : undefined;
  if (waiting) return before.since === null ? { ...before, since: now } : before;
  if (before.since === null) return before;
  return { turn, waited: before.waited + Math.max(0, now - before.since), since: null };
}

/** The turn's elapsed time: its start plus the waited intervals gives how
 *  long it has been worked on. Stopped while a wait is on. */
export function turnElapsed(turn: number, waits: TurnWaits | undefined, now: number): number {
  const mine = waits && waits.turn === turn ? waits : undefined;
  return Math.max(0, (mine?.since ?? now) - turn - (mine?.waited ?? 0));
}

/** The waits of every chat, moved on by what the page sees now. `turnOf`
 *  answers a chat's turn in flight, or nothing when it has none. The same
 *  record comes back when no chat's waits changed. */
export function noteWaits(
  before: Readonly<Record<string, TurnWaits>>,
  waiting: ReadonlyMap<string, unknown>,
  turnOf: (chatId: string) => number | undefined,
  now: number,
): Readonly<Record<string, TurnWaits>> {
  let next: Record<string, TurnWaits> | null = null;
  for (const id of new Set([...Object.keys(before), ...waiting.keys()])) {
    const after = noteWait(before[id], turnOf(id), waiting.has(id), now);
    if (after === before[id]) continue;
    next ??= { ...before };
    if (after) next[id] = after;
    else delete next[id];
  }
  return next ?? before;
}

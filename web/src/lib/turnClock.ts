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
// The clock counts what a page SAW the turn work, and nothing else.
//
// A turn's start and its waits are restored together or not at all. The
// waits are a field of the chat's own state, beside the start
// (`ChatState.turnWaits`), so whatever keeps the one keeps the other: the
// page while it runs, and the chat's checkpoint (`lib/chatCache`) across a
// reload. They were once the page's own, in memory, while the start came
// back from the checkpoint: 90 s of work and 180 s of waiting read `1m 30s`
// before a reload and `4m 31s` after it.
//
// - With a checkpoint, a reload brings back both, and the time from the
//   checkpoint's writing to the page's return is never counted as work
//   (`restoredTurn`): nobody was looking, so whether the turn worked or
//   waited in it is not known. A checkpoint is written in a quiet moment
//   and can be minutes old, older than a wait the page did see begin;
//   counted as work, that time put the wait back on the clock.
// - Without one (never saved, evicted, a chat read in pages, storage
//   blocked), neither comes back: the turn starts when the page joined it,
//   as for any turn joined part-way, and the wait when the page first sees
//   the card, a moment later. Until the answer the clock is stopped at
//   about nothing beside the waiting words, and after it counts the work
//   done since.
//
// So after a reload the clock reads the work seen up to the last
// checkpoint, and goes on from there. It can read less than the turn has
// really worked; it never reads time the turn spent waiting.

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

/** A chat's state with what the page sees now folded into its waits: the
 *  same object when nothing changed. A chat with no turn in flight keeps
 *  none. The waits stay in the state the start is in, so nothing can save
 *  or restore one without the other. */
export function withWait<T extends { busy: boolean; turnStartedAt?: number; turnWaits?: TurnWaits }>(
  state: T,
  waiting: boolean,
  now: number,
): T {
  const after = noteWait(state.turnWaits, state.busy ? state.turnStartedAt : undefined, waiting, now);
  return after === state.turnWaits ? state : { ...state, turnWaits: after };
}

/** A chat's state as its checkpoint gives it back, `savedAt` being when the
 *  checkpoint was written (on the page's clock, as the turn's start is).
 *
 *  From then until a page looks again nobody saw the turn, so that time is
 *  not work: a turn that was working when it was saved comes back parked
 *  since the save. The page's first look decides the rest (`withWait`): a
 *  card that is up keeps it parked, so the clock stands at the work that
 *  was seen, and no card ends the wait there, so the clock goes on having
 *  left the time away out. A turn saved while it waited is still waiting,
 *  and comes back as it is. */
export function restoredTurn<T extends { busy: boolean; turnStartedAt?: number; turnWaits?: TurnWaits }>(state: T, savedAt: number): T {
  const turn = state.busy ? state.turnStartedAt : undefined;
  if (turn === undefined) return state;
  const mine = state.turnWaits?.turn === turn ? state.turnWaits : undefined;
  if (mine && mine.since !== null) return state;
  return { ...state, turnWaits: { turn, waited: mine?.waited ?? 0, since: Math.max(savedAt, turn) } };
}

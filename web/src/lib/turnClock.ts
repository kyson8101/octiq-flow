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
//
// "Not read yet" is not "nothing waits". A page that has just loaded holds
// no card: its lists of what waits are read from the host a moment later,
// or much later. A look made before they have answered knows nothing, and
// ended the restored wait: with `question_pending` held back two minutes,
// `1m 30s` read `3m 31s`, drawn as thinking. So a look says one of three
// things (`lib/chatWait`): the chat waits, it does not, or the page does not
// know yet. Only the first two move a wait that came back from a
// checkpoint (`restored`):
//
// - not known: nothing changes. The wait stays on with its `since`.
// - it waits: the wait is confirmed and keeps its `since`.
// - it does not: the wait ends there, and the time it was held is waited.
//
// The page may never come to know (`pendingActions.wholeOf`: a list that
// failed twice, or one that said nothing for five minutes). A list that
// failed or was given up on proves nothing, so it ends no restored wait:
// the clock stands where the checkpoint left it, the chat is drawn as held
// with words that say the page could not check (`chatWait`'s `unchecked`),
// and the person can ask the lists again. Only a read ends it: a card found
// keeps the wait, and every list read with no card ends it there.
//
// There is no guess. The page used to let a restored wait go when it gave
// up, and count from there; a card that came back later took the guessed
// time off again only when it was the last list to answer (24 of the 120
// orders five lists can answer in), and a list that failed twice let the
// clock run for good. A clock that only ever counts what a read confirmed
// has nothing to take back.

/** The waits of one turn. */
export type TurnWaits = {
  /** Which turn: when it started, as the page has it. */
  turn: number;
  /** Waits that are over, added up, in milliseconds. */
  waited: number;
  /** When the wait that is on now began, or `null` while work goes on. */
  since: number | null;
  /** The wait that is on came back from a checkpoint, and no look of this
   *  page has yet said whether the chat waits. */
  restored?: true;
};

/** What a look says of one chat: it waits on the person, it does not, or the
 *  page does not know yet (`lib/chatWait`'s third answer). */
export type Seen = boolean | "unknown";

/** How much of what can say a chat waits the page has read
 *  (`pendingActions.wholeOf`): all of it, not all of it yet, or as much as
 *  it is going to get without being asked again. Only `read` makes "it does
 *  not wait" a fact. */
export type Read = "read" | "unread" | "gaveUp";

const plain = (turn: number, waited: number, since: number | null): TurnWaits => ({ turn, waited, since });

/** What the page sees now, folded into what it had: a wait beginning, a wait
 *  ending, or a new turn. Returns the same object when nothing changed, and
 *  nothing for a chat with no turn in flight. */
export function noteWait(
  before: TurnWaits | undefined,
  turn: number | undefined,
  waiting: Seen,
  now: number,
  read: Read = "read",
): TurnWaits | undefined {
  if (turn === undefined) return undefined;
  // Another turn: nothing of the last one's waits is this one's. A turn that
  // has not waited yet has nothing to keep.
  if (!before || before.turn !== turn) return waiting === true ? { turn, waited: 0, since: now } : undefined;
  // Not known: nothing is said, so nothing changes.
  if (waiting === "unknown") return before;
  if (waiting) {
    // A wait that is on is confirmed, and keeps the moment it began.
    if (before.since !== null) return before.restored ? plain(turn, before.waited, before.since) : before;
    return plain(turn, before.waited, now);
  }
  if (before.since === null) return before;
  // A restored wait is ended only by a read that says nothing waits: never
  // by a look made before the lists were read, and never by a list that
  // failed or was given up on, which says nothing.
  if (before.restored && read !== "read") return before;
  return plain(turn, before.waited + Math.max(0, now - before.since), null);
}

/** The turn's elapsed time: its start plus the waited intervals gives how
 *  long it has been worked on. Stopped while a wait is on. */
export function turnElapsed(turn: number, waits: TurnWaits | undefined, now: number): number {
  const mine = waits && waits.turn === turn ? waits : undefined;
  return Math.max(0, (mine?.since ?? now) - turn - (mine?.waited ?? 0));
}

type Turn = { busy: boolean; turnStartedAt?: number; turnWaits?: TurnWaits };

/** A chat's state with what the page sees now folded into its waits: the
 *  same object when nothing changed. A chat with no turn in flight keeps
 *  none. The waits stay in the state the start is in, so nothing can save
 *  or restore one without the other. */
export function withWait<T extends Turn>(state: T, waiting: Seen, now: number, read: Read = "read"): T {
  const after = noteWait(state.turnWaits, state.busy ? state.turnStartedAt : undefined, waiting, now, read);
  return after === state.turnWaits ? state : { ...state, turnWaits: after };
}

/** Whether the chat's turn stands on a wait its checkpoint brought back and
 *  no look has settled: the one case where "the page does not know yet"
 *  holds the clock (`chatWait.waitingChats`). */
export function parkRestored(state: Turn | undefined): boolean {
  const waits = state?.busy && state.turnWaits?.turn === state.turnStartedAt ? state.turnWaits : undefined;
  return !!waits?.restored && waits.since !== null;
}

/** A chat's state as its checkpoint gives it back, `savedAt` being when the
 *  checkpoint was written (on the page's clock, as the turn's start is).
 *
 *  From then until a page looks again nobody saw the turn, so that time is
 *  not work: a turn that was working when it was saved comes back parked
 *  since the save. A turn saved while it waited is still waiting, and comes
 *  back with the moment that wait began. Either way the wait is marked
 *  `restored`: it is the checkpoint's word, and the page's first look that
 *  KNOWS decides the rest (`noteWait`). A card that is up keeps it parked,
 *  so the clock stands at the work that was seen; every list read with no
 *  card ends the wait there, so the clock goes on having left the time away
 *  out; and a look made before the lists were read changes nothing.
 *
 *  A checkpoint an earlier build wrote may hold a guess that build made and
 *  never had answered (`guessed`): the time from it to the save was never
 *  known to be work, and is left out. */
export function restoredTurn<T extends Turn>(state: T, savedAt: number): T {
  const turn = state.busy ? state.turnStartedAt : undefined;
  if (turn === undefined) return state;
  const mine = state.turnWaits?.turn === turn ? state.turnWaits : undefined;
  if (mine && mine.since !== null) return mine.restored ? state : { ...state, turnWaits: { ...mine, restored: true } };
  const since = Math.max(savedAt, turn);
  const old = (mine as { guessed?: number } | undefined)?.guessed;
  const guessed = typeof old === "number" ? Math.max(0, since - old) : 0;
  return { ...state, turnWaits: { turn, waited: (mine?.waited ?? 0) + guessed, since, restored: true } };
}

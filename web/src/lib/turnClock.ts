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
// or much later, or never (`pendingActions.wholeOf`). A look made before
// they have answered knows nothing, and ended the restored wait: with
// `question_pending` held back two minutes, `1m 30s` read `3m 31s`, drawn
// as thinking.
//
// So a wait that came back from a checkpoint is a park with a state of its
// own (`park`), and when it ends is decided in ONE place, `lib/restoredPark`:
// on a whole read that names no card, or on the agent's own sign of work
// after a card the page saw has gone. Never because a card confirmed the
// wait, never on a look made before the lists were read, never on a list
// that failed or was given up on. This module hands the machine what
// happened (`noteWait` a look, `withWork` a live event of the stream) and
// does the sum when it says the park ended: the whole time since the
// checkpoint is waited, whatever was unread in between.
//
// There is no guess. The page used to let a restored wait go when it gave
// up, and count from there; then it let one go when a single card had
// confirmed it and that card was answered, with another list still unread.
// A clock that only counts what was confirmed has nothing to take back.
import { parkStep, signOfWork, type Park, type ParkEvent } from "./restoredPark";

/** The waits of one turn. */
export type TurnWaits = {
  /** Which turn: when it started, as the page has it. */
  turn: number;
  /** Waits that are over, added up, in milliseconds. */
  waited: number;
  /** When the wait that is on now began, or `null` while work goes on. */
  since: number | null;
  /** The wait that is on came back from a checkpoint, and this is where
   *  that park stands (`lib/restoredPark`). Absent on a wait this page saw
   *  begin. */
  park?: Park;
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

/** A look, as the machine's event. "Not known" is never a whole reading
 *  that names no card, whatever it came with. */
function lookOf(waiting: Seen, read: Read): ParkEvent {
  if (waiting === true) return { type: "card" };
  return { type: "noCard", read: waiting === "unknown" && read === "read" ? "unread" : read };
}

/** A restored park after one event: where the machine now has it, or over,
 *  with all the time since the checkpoint left out. The same object when
 *  nothing changed. */
function parked(before: TurnWaits & { park: Park; since: number }, event: ParkEvent, now: number): TurnWaits {
  const after = parkStep(before.park, event);
  if (after === "ended") return plain(before.turn, before.waited + Math.max(0, now - before.since), null);
  return after === before.park ? before : { ...plain(before.turn, before.waited, before.since), park: after };
}

const isParked = (waits: TurnWaits): waits is TurnWaits & { park: Park; since: number } => !!waits.park && waits.since !== null;

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
  // A wait a checkpoint brought back is the machine's, whatever the look says.
  if (isParked(before)) return parked(before, lookOf(waiting, read), now);
  // Not known: nothing is said, so nothing changes.
  if (waiting === "unknown") return before;
  if (waiting) return before.since !== null ? before : plain(turn, before.waited, now);
  if (before.since === null) return before;
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

/** A chat's state after a live event of its stream (`App`, where live
 *  frames are folded; never a replay, which is history). The agent's own
 *  sign of work is the one thing besides a whole read that can end a
 *  restored park, and only after a card the page saw has gone
 *  (`lib/restoredPark`). The same object when nothing changed. */
export function withWork<T extends Turn>(state: T, event: unknown, now: number): T {
  const waits = state.busy && state.turnWaits?.turn === state.turnStartedAt ? state.turnWaits : undefined;
  if (!waits || !isParked(waits) || !signOfWork(event)) return state;
  const after = parked(waits, { type: "work" }, now);
  return after === waits ? state : { ...state, turnWaits: after };
}

/** Whether the chat's turn stands on a wait its checkpoint brought back and
 *  the machine has not ended: the one case where "the page does not know
 *  yet" holds the clock (`chatWait.waitingChats`). True through every state
 *  of the park, a confirmed one included: one card is not every source. */
export function parkRestored(state: Turn | undefined): boolean {
  const waits = state?.busy && state.turnWaits?.turn === state.turnStartedAt ? state.turnWaits : undefined;
  return !!waits && isParked(waits);
}

/** A chat's state as its checkpoint gives it back, `savedAt` being when the
 *  checkpoint was written (on the page's clock, as the turn's start is).
 *
 *  From then until a page looks again nobody saw the turn, so that time is
 *  not work: a turn that was working when it was saved comes back parked
 *  since the save. A turn saved while it waited is still waiting, and comes
 *  back with the moment that wait began. Either way the wait is a restored
 *  park that starts `held`: it is the checkpoint's word, and what this page
 *  comes to know decides the rest (`lib/restoredPark`). What an earlier
 *  page knew of it (a card it saw, an answer) is not this page's to go by,
 *  so a park saved in any state comes back held.
 *
 *  A checkpoint an earlier build wrote may hold a guess that build made and
 *  never had answered (`guessed`): the time from it to the save was never
 *  known to be work, and is left out. */
export function restoredTurn<T extends Turn>(state: T, savedAt: number): T {
  const turn = state.busy ? state.turnStartedAt : undefined;
  if (turn === undefined) return state;
  const mine = state.turnWaits?.turn === turn ? state.turnWaits : undefined;
  if (mine && mine.since !== null) {
    return mine.park === "held" ? state : { ...state, turnWaits: { ...plain(turn, mine.waited, mine.since), park: "held" } };
  }
  const since = Math.max(savedAt, turn);
  const old = (mine as { guessed?: number } | undefined)?.guessed;
  const guessed = typeof old === "number" ? Math.max(0, since - old) : 0;
  return { ...state, turnWaits: { ...plain(turn, (mine?.waited ?? 0) + guessed, since), park: "held" } };
}

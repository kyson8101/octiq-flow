import { describe, expect, it } from "vitest";
import { noteWait, parkRestored, restoredTurn, turnElapsed, withWait, type TurnWaits } from "./turnClock";
import { elapsedLabel } from "./working";

const T = 1_000_000;
const s = (seconds: number) => seconds * 1000;

describe("a turn's elapsed time leaves out the time it waited on the person", () => {
  it("counts from the turn's start while nothing has waited", () => {
    expect(turnElapsed(T, undefined, T + s(42))).toBe(s(42));
    expect(noteWait(undefined, T, false, T + s(42))).toBeUndefined();
  });

  it("stops while a wait is on, wherever now is", () => {
    const waits = noteWait(undefined, T, true, T + s(60))!;
    expect(waits).toEqual({ turn: T, waited: 0, since: T + s(60) });
    for (const later of [s(60), s(61), s(600), s(86_400)]) {
      expect(turnElapsed(T, waits, T + later)).toBe(s(60));
      // Seeing the same wait again changes nothing, and is the same object.
      expect(noteWait(waits, T, true, T + later)).toBe(waits);
    }
  });

  it("goes on from where it stopped when the answer is given", () => {
    let waits = noteWait(undefined, T, true, T + s(60));
    waits = noteWait(waits, T, false, T + s(360));
    expect(waits).toEqual({ turn: T, waited: s(300), since: null });
    // At the moment of the answer the clock still says one minute, and five
    // seconds on it says 1m 05s: the five minutes waited were never added.
    expect(turnElapsed(T, waits, T + s(360))).toBe(s(60));
    expect(elapsedLabel(turnElapsed(T, waits, T + s(365)))).toBe("1m 05s");
    expect(noteWait(waits, T, false, T + s(400))).toBe(waits);
  });

  it("adds up every wait of the turn: start plus waited intervals gives elapsed", () => {
    const steps: [waiting: boolean, at: number][] = [
      [true, 10], [false, 40], // 30s waited
      [true, 100], [false, 220], // 120s waited
      [true, 300], // waiting again from 300s
    ];
    let waits: TurnWaits | undefined;
    for (const [waiting, at] of steps) waits = noteWait(waits, T, waiting, T + s(at));
    expect(waits).toEqual({ turn: T, waited: s(150), since: T + s(300) });
    // Stopped at 300 - 150 = 150s of work, however long this wait lasts.
    expect(turnElapsed(T, waits, T + s(900))).toBe(s(150));
    waits = noteWait(waits, T, false, T + s(900));
    expect(turnElapsed(T, waits, T + s(910))).toBe(s(160));
  });

  it("never gives the last turn's waits to the next one", () => {
    const old = noteWait(noteWait(undefined, T, true, T + s(5)), T, false, T + s(65))!;
    const next = T + s(100);
    // The new turn has waited for nothing.
    expect(turnElapsed(next, old, next + s(7))).toBe(s(7));
    expect(noteWait(old, next, false, next + s(7))).toBeUndefined();
    expect(noteWait(old, next, true, next + s(7))).toEqual({ turn: next, waited: 0, since: next + s(7) });
  });

  it("keeps nothing for a chat with no turn in flight", () => {
    const waits = noteWait(undefined, T, true, T + s(5));
    expect(noteWait(waits, undefined, true, T + s(9))).toBeUndefined();
    expect(noteWait(waits, undefined, false, T + s(9))).toBeUndefined();
  });

  it("is never negative, whatever the clock did", () => {
    expect(turnElapsed(T, undefined, T - s(5))).toBe(0);
    const waits = noteWait(undefined, T, true, T - s(5));
    expect(turnElapsed(T, waits, T + s(5))).toBe(0);
    // A wait that ends before it began (the clock was set back) adds nothing.
    expect(noteWait({ turn: T, waited: s(10), since: T + s(50) }, T, false, T + s(20))).toEqual({ turn: T, waited: s(10), since: null });
  });
});

describe("a page loaded in the middle of a wait", () => {
  it("shows a clock stopped at about nothing, then counts only the work after the answer", () => {
    // The page joins the turn at `joined` (it cannot know when the turn
    // began) and sees the card a moment later.
    const joined = T + s(5_000);
    const waits = noteWait(undefined, joined, true, joined + 400);
    expect(elapsedLabel(turnElapsed(joined, waits, joined + s(120)))).toBe("0s");
    const answered = noteWait(waits, joined, false, joined + s(120));
    expect(elapsedLabel(turnElapsed(joined, answered, joined + s(150)))).toBe("30s");
  });
});

describe("a chat's state with its waits beside the turn's start", () => {
  type Timed = { busy: boolean; turnStartedAt?: number; turnWaits?: TurnWaits; other?: string };
  const working: Timed = { busy: true, turnStartedAt: T, other: "kept" };

  it("opens a wait for a turn in flight, and keeps everything else of the state", () => {
    const waiting = withWait(working, true, T + s(30));
    expect(waiting).toEqual({ busy: true, turnStartedAt: T, other: "kept", turnWaits: { turn: T, waited: 0, since: T + s(30) } });
    // The start and the waits are fields of one object: whatever saves or
    // restores the state has both.
    expect(Object.keys(waiting)).toEqual(expect.arrayContaining(["turnStartedAt", "turnWaits"]));
  });

  it("closes a wait whose card is gone", () => {
    const waiting = withWait(working, true, T + s(30));
    expect(withWait(waiting, false, T + s(50)).turnWaits).toEqual({ turn: T, waited: s(20), since: null });
  });

  it("hands back the same state when nothing changed", () => {
    expect(withWait(working, false, T + s(9))).toBe(working);
    const waiting = withWait(working, true, T + s(30));
    expect(withWait(waiting, true, T + s(99))).toBe(waiting);
  });

  it("keeps none for a chat with no turn in flight", () => {
    const idle: Timed = { busy: false };
    expect(withWait(idle, true, T)).toBe(idle);
    // A turn that ended takes its waits with it.
    const ended: Timed = { ...withWait(working, true, T + s(30)), busy: false };
    expect(withWait(ended, true, T + s(40)).turnWaits).toBeUndefined();
    expect(withWait(ended, false, T + s(40)).turnWaits).toBeUndefined();
  });
});

describe("a turn as a checkpoint gives it back", () => {
  type Timed = { busy: boolean; turnStartedAt?: number; turnWaits?: TurnWaits };
  const saved = T + s(60);

  it("comes back parked since the checkpoint was written when it was working", () => {
    const state: Timed = { busy: true, turnStartedAt: T };
    expect(restoredTurn(state, saved).turnWaits).toEqual({ turn: T, waited: 0, since: saved, restored: true });
    // What it had waited before is kept.
    const waited: Timed = { busy: true, turnStartedAt: T, turnWaits: { turn: T, waited: s(20), since: null } };
    expect(restoredTurn(waited, saved).turnWaits).toEqual({ turn: T, waited: s(20), since: saved, restored: true });
  });

  it("comes back with the wait it was already on, marked as the checkpoint's word", () => {
    const state: Timed = { busy: true, turnStartedAt: T, turnWaits: { turn: T, waited: s(5), since: T + s(40) } };
    // The moment the wait began is kept; that this page has not confirmed
    // it is said.
    expect(restoredTurn(state, saved).turnWaits).toEqual({ turn: T, waited: s(5), since: T + s(40), restored: true });
    // Restored a second time (a reload while it was still held), unchanged.
    const again = restoredTurn(state, saved);
    expect(restoredTurn(again, saved + s(30))).toBe(again);
  });

  it("is untouched when no turn is in flight", () => {
    const idle: Timed = { busy: false, turnStartedAt: T };
    expect(restoredTurn(idle, saved)).toBe(idle);
    const never: Timed = { busy: true };
    expect(restoredTurn(never, saved)).toBe(never);
  });

  it("does not take another turn's waits, or a save stamped before the turn", () => {
    const other: Timed = { busy: true, turnStartedAt: T, turnWaits: { turn: T - s(900), waited: s(300), since: T - s(100) } };
    expect(restoredTurn(other, saved).turnWaits).toEqual({ turn: T, waited: 0, since: saved, restored: true });
    // A stamp from before the turn (a clock set back) parks it from its start.
    expect(restoredTurn({ busy: true, turnStartedAt: T } as Timed, T - s(30)).turnWaits).toEqual({ turn: T, waited: 0, since: T, restored: true });
  });

  it("never lets time away be read as work, whatever the first look finds", () => {
    const back = T + s(660);
    for (const waitingNow of [true, false]) {
      const restored = restoredTurn<Timed>({ busy: true, turnStartedAt: T }, saved);
      const looked = withWait(restored, waitingNow, back);
      // Ten minutes away: the clock still reads the one minute that was seen.
      expect(turnElapsed(T, looked.turnWaits, back)).toBe(s(60));
    }
  });
});

describe("a look made before the page knows whether the chat waits", () => {
  type Timed = { busy: boolean; turnStartedAt?: number; turnWaits?: TurnWaits };
  const saved = T + s(90);
  const back = T + s(271);
  /** Worked 90 s, saved, reloaded at 271 s. */
  const restored = () => restoredTurn<Timed>({ busy: true, turnStartedAt: T }, saved);

  it("changes nothing: the restored wait stays on with the moment it began", () => {
    const state = restored();
    expect(parkRestored(state)).toBe(true);
    for (const later of [0, s(1), s(120), s(3_600)]) {
      expect(withWait(state, "unknown", back + later)).toBe(state);
      expect(turnElapsed(T, state.turnWaits, back + later)).toBe(s(90));
    }
  });

  it("is not ended by `does not wait` while the lists are unread, whoever says it", () => {
    // What the page did: its lists were empty because they had not been
    // read, it said `false`, and the clock ran. The clock itself now knows
    // an unread `false` from a read one.
    const state = restored();
    expect(withWait(state, false, back, "unread")).toBe(state);
    expect(turnElapsed(T, withWait(state, false, back, "unread").turnWaits, back + s(120))).toBe(s(90));
    // Read, the same word ends it.
    expect(withWait(state, false, back, "read").turnWaits).toEqual({ turn: T, waited: s(181), since: null });
  });

  it("is confirmed by a card, and keeps the moment it began", () => {
    const state = restored();
    for (const read of ["read", "unread", "gaveUp"] as const) {
      const confirmed = withWait(withWait(state, "unknown", back, read), true, back + s(120), read);
      expect(confirmed.turnWaits).toEqual({ turn: T, waited: 0, since: saved });
      expect(parkRestored(confirmed)).toBe(false);
      // A wait this page has seen is ended by its card going, read or not.
      expect(withWait(confirmed, false, back + s(300), "unread").turnWaits).toEqual({ turn: T, waited: s(300) - s(90) + s(271), since: null });
    }
  });

  it("is ended by a whole reading that says nothing waits, with the time held left out", () => {
    const state = withWait(restored(), "unknown", back);
    const known = withWait(state, false, back + s(120), "read");
    expect(known.turnWaits).toEqual({ turn: T, waited: s(301), since: null });
    expect(turnElapsed(T, known.turnWaits, back + s(120))).toBe(s(90));
    expect(turnElapsed(T, known.turnWaits, back + s(125))).toBe(s(95));
  });

  it("holds only a wait a checkpoint brought back", () => {
    // A turn that started on this page, working: an unknown look says
    // nothing and holds nothing.
    const working: Timed = { busy: true, turnStartedAt: T };
    expect(withWait(working, "unknown", T + s(9))).toBe(working);
    expect(parkRestored(working)).toBe(false);
    expect(turnElapsed(T, working.turnWaits, T + s(9))).toBe(s(9));
    // A wait this page saw begin is ended by its card going, read or not.
    const seen = withWait(working, true, T + s(30));
    expect(parkRestored(seen)).toBe(false);
    expect(withWait(seen, false, T + s(50), "unread").turnWaits).toEqual({ turn: T, waited: s(20), since: null });
    // No turn in flight, no park.
    expect(parkRestored({ busy: false, turnStartedAt: T, turnWaits: { turn: T, waited: 0, since: T, restored: true } })).toBe(false);
    expect(parkRestored(undefined)).toBe(false);
  });
});

describe("a restored wait the page never comes to know about", () => {
  type Timed = { busy: boolean; turnStartedAt?: number; turnWaits?: TurnWaits };
  const saved = T + s(90);
  const back = T + s(271);
  const gaveUp = back + s(300);
  const guessing = () => withWait(restoredTurn<Timed>({ busy: true, turnStartedAt: T }, saved), false, gaveUp, "gaveUp");

  it("is let go on a guess: the time held is left out, and the moment is kept", () => {
    const state = guessing();
    expect(state.turnWaits).toEqual({ turn: T, waited: gaveUp - saved, since: null, guessed: gaveUp });
    expect(turnElapsed(T, state.turnWaits, gaveUp)).toBe(s(90));
    // The clock goes on from the work the checkpoint saw.
    expect(turnElapsed(T, state.turnWaits, gaveUp + s(40))).toBe(s(130));
    // Still guessing while nothing new is read.
    expect(withWait(state, false, gaveUp + s(40), "gaveUp")).toBe(state);
    expect(withWait(state, false, gaveUp + s(40), "unread")).toBe(state);
    expect(withWait(state, "unknown", gaveUp + s(40), "unread")).toBe(state);
  });

  it("takes the guessed time back when the lists answer after all and the chat waits", () => {
    const answered = gaveUp + s(100);
    const state = withWait(guessing(), true, answered, "read");
    expect(state.turnWaits).toEqual({ turn: T, waited: answered - saved, since: answered });
    // Back to the work the checkpoint saw, and stopped there.
    expect(turnElapsed(T, state.turnWaits, answered + s(500))).toBe(s(90));
    const after = withWait(state, false, answered + s(500), "read");
    expect(turnElapsed(T, after.turnWaits, answered + s(505))).toBe(s(95));
  });

  it("takes it back on a new connection too, whichever list says so first", () => {
    // Every list is asked again (`unread`), and the question list answers
    // before the rest: the card was there all along.
    const reconnected = gaveUp + s(100);
    const asked = withWait(guessing(), false, reconnected, "unread");
    expect(asked).toEqual(guessing());
    const state = withWait(asked, true, reconnected + s(2), "unread");
    expect(turnElapsed(T, state.turnWaits, reconnected + s(500))).toBe(s(90));
    expect(state.turnWaits?.guessed).toBeUndefined();
  });

  it("lets the guess stand when the lists answer and nothing waits", () => {
    const answered = gaveUp + s(100);
    const state = withWait(guessing(), false, answered, "read");
    expect(state.turnWaits).toEqual({ turn: T, waited: gaveUp - saved, since: null });
    expect(turnElapsed(T, state.turnWaits, answered)).toBe(s(190));
    // A card that comes later is a wait that begins then.
    const later = withWait(state, true, answered + s(50), "read");
    expect(turnElapsed(T, later.turnWaits, answered + s(900))).toBe(s(240));
  });

  it("takes nothing back for a card that arrives while it is still guessing", () => {
    // A live card (the list it gave up on has still not answered): a wait
    // that begins now, as any does. The work since the guess stands.
    const arrived = gaveUp + s(600);
    const state = withWait(guessing(), true, arrived, "gaveUp");
    expect(state.turnWaits).toEqual({ turn: T, waited: gaveUp - saved, since: arrived, guessed: gaveUp });
    expect(turnElapsed(T, state.turnWaits, arrived + s(60))).toBe(s(690));
  });

  it("does not carry an unanswered guess through a second reload", () => {
    // Saved 40 s into the guess: that time was never known to be work.
    const state = guessing();
    const again = restoredTurn(state, gaveUp + s(40));
    expect(again.turnWaits).toEqual({ turn: T, waited: gaveUp + s(40) - saved, since: gaveUp + s(40), restored: true });
    expect(turnElapsed(T, again.turnWaits, gaveUp + s(900))).toBe(s(90));
  });

  it("never reads more than the work the checkpoint saw plus what was seen after the guess", () => {
    for (const read of ["read", "unread", "gaveUp"] as const) {
      for (const seen of [true, false, "unknown"] as const) {
        const state = withWait(guessing(), seen, gaveUp + s(100), read);
        expect(turnElapsed(T, state.turnWaits, gaveUp + s(100))).toBeLessThanOrEqual(s(190));
      }
    }
  });
});

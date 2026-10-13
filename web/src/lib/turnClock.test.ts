import { describe, expect, it } from "vitest";
import { noteWait, turnElapsed, withWait, type TurnWaits } from "./turnClock";
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

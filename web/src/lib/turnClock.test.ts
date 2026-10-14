import { describe, expect, it } from "vitest";
import { noteWait, parkRestored, restoredTurn, turnElapsed, withWait, withWork, type TurnWaits } from "./turnClock";
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
    expect(restoredTurn(state, saved).turnWaits).toEqual({ turn: T, waited: 0, since: saved, park: "held" });
    // What it had waited before is kept.
    const waited: Timed = { busy: true, turnStartedAt: T, turnWaits: { turn: T, waited: s(20), since: null } };
    expect(restoredTurn(waited, saved).turnWaits).toEqual({ turn: T, waited: s(20), since: saved, park: "held" });
  });

  it("comes back with the wait it was already on, marked as the checkpoint's word", () => {
    const state: Timed = { busy: true, turnStartedAt: T, turnWaits: { turn: T, waited: s(5), since: T + s(40) } };
    // The moment the wait began is kept; that this page has not confirmed
    // it is said.
    expect(restoredTurn(state, saved).turnWaits).toEqual({ turn: T, waited: s(5), since: T + s(40), park: "held" });
    // Restored a second time (a reload while it was still held), unchanged.
    const again = restoredTurn(state, saved);
    expect(restoredTurn(again, saved + s(30))).toBe(again);
  });

  it("comes back held whatever an earlier page knew of it, or an earlier build wrote", () => {
    // A card that page saw, or its answer, is not this page's to go by.
    for (const park of ["confirmed", "answered"] as const) {
      const state: Timed = { busy: true, turnStartedAt: T, turnWaits: { turn: T, waited: s(5), since: T + s(40), park } };
      expect(restoredTurn(state, saved).turnWaits).toEqual({ turn: T, waited: s(5), since: T + s(40), park: "held" });
    }
    // The build before this one marked the same thing `restored`.
    const old = { busy: true, turnStartedAt: T, turnWaits: { turn: T, waited: 0, since: T + s(40), restored: true } } as Timed;
    expect(restoredTurn(old, saved).turnWaits).toEqual({ turn: T, waited: 0, since: T + s(40), park: "held" });
  });

  it("is untouched when no turn is in flight", () => {
    const idle: Timed = { busy: false, turnStartedAt: T };
    expect(restoredTurn(idle, saved)).toBe(idle);
    const never: Timed = { busy: true };
    expect(restoredTurn(never, saved)).toBe(never);
  });

  it("does not take another turn's waits, or a save stamped before the turn", () => {
    const other: Timed = { busy: true, turnStartedAt: T, turnWaits: { turn: T - s(900), waited: s(300), since: T - s(100) } };
    expect(restoredTurn(other, saved).turnWaits).toEqual({ turn: T, waited: 0, since: saved, park: "held" });
    // A stamp from before the turn (a clock set back) parks it from its start.
    expect(restoredTurn({ busy: true, turnStartedAt: T } as Timed, T - s(30)).turnWaits).toEqual({ turn: T, waited: 0, since: T, park: "held" });
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

  it("is confirmed by a card, keeps the moment it began, and is still a restored park", () => {
    const state = restored();
    for (const read of ["read", "unread", "gaveUp"] as const) {
      const confirmed = withWait(withWait(state, "unknown", back, read), true, back + s(120), read);
      expect(confirmed.turnWaits).toEqual({ turn: T, waited: 0, since: saved, park: "confirmed" });
      // One card is not every source: the park is not over because a card
      // confirmed it. This was `false`, and the card going then ended it.
      expect(parkRestored(confirmed)).toBe(true);
      // Its card going while a source is unread or given up ends nothing.
      for (const other of ["unread", "gaveUp"] as const) {
        const answered = withWait(confirmed, false, back + s(300), other);
        expect(answered.turnWaits).toEqual({ turn: T, waited: 0, since: saved, park: "answered" });
        expect(parkRestored(answered)).toBe(true);
        expect(turnElapsed(T, answered.turnWaits, back + s(900))).toBe(s(90));
      }
      // Its card going in a whole reading does.
      expect(withWait(confirmed, false, back + s(300), "read").turnWaits).toEqual({ turn: T, waited: s(300) - s(90) + s(271), since: null });
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
    expect(parkRestored({ busy: false, turnStartedAt: T, turnWaits: { turn: T, waited: 0, since: T, park: "held" } })).toBe(false);
    expect(parkRestored(undefined)).toBe(false);
  });
});

describe("a restored wait the page could not check", () => {
  type Timed = { busy: boolean; turnStartedAt?: number; turnWaits?: TurnWaits };
  const saved = T + s(90);
  const back = T + s(271);
  const gaveUp = back + s(300);
  const restored = () => restoredTurn<Timed>({ busy: true, turnStartedAt: T }, saved);

  it("is not let go: a list that failed or was given up on says nothing of what waits", () => {
    // The page used to end the wait here on a guess, and count from there.
    const state = restored();
    for (const seen of [false, "unknown"] as const) {
      expect(withWait(state, seen, gaveUp, "gaveUp")).toBe(state);
      expect(withWait(state, seen, gaveUp + s(600), "gaveUp")).toBe(state);
    }
    expect(parkRestored(state)).toBe(true);
    // The clock stands at the work the checkpoint saw, however long it is.
    for (const later of [0, s(40), s(720), s(86_400)]) expect(turnElapsed(T, state.turnWaits, gaveUp + later)).toBe(s(90));
  });

  it("is confirmed by a card that a later read finds, with nothing to take back", () => {
    // The reviewer's order: given up, then the question's list answers while
    // another is still silent (the reading is still `gaveUp`).
    const found = gaveUp + s(40);
    const state = withWait(withWait(restored(), false, gaveUp, "gaveUp"), true, found, "gaveUp");
    expect(state.turnWaits).toEqual({ turn: T, waited: 0, since: saved, park: "confirmed" });
    expect(turnElapsed(T, state.turnWaits, found + s(60))).toBe(s(90));
    // Every list read at last, the card still up; then answered, and 5 s of work.
    const all = withWait(state, true, found + s(60), "read");
    expect(all).toBe(state);
    const answered = withWait(all, false, found + s(100), "read");
    expect(turnElapsed(T, answered.turnWaits, found + s(100))).toBe(s(90));
    expect(turnElapsed(T, answered.turnWaits, found + s(105))).toBe(s(95));
  });

  it("is ended only by a read that says nothing waits, with all the time held left out", () => {
    const state = withWait(restored(), false, gaveUp, "gaveUp");
    const read = withWait(state, false, gaveUp + s(700), "read");
    expect(read.turnWaits).toEqual({ turn: T, waited: gaveUp + s(700) - saved, since: null });
    expect(turnElapsed(T, read.turnWaits, gaveUp + s(700))).toBe(s(90));
    expect(turnElapsed(T, read.turnWaits, gaveUp + s(705))).toBe(s(95));
  });

  it("never reads more than the work the checkpoint saw, whatever is said and however it is read", () => {
    const words = [true, false, "unknown"] as const;
    const reads = ["read", "unread", "gaveUp"] as const;
    // Every three looks, ten minutes apart, and the clock read at once. A
    // whole read that says nothing waits ends the park, and what follows is
    // work the page saw: the run stops there, as that is not a restore's to
    // bound.
    for (const a of words) for (const ra of reads) for (const b of words) for (const rb of reads) for (const c of words) for (const rc of reads) {
      let state = restored();
      let at = gaveUp;
      for (const [seen, read] of [[a, ra], [b, rb], [c, rc]] as const) {
        state = withWait(state, seen, at, read);
        expect(turnElapsed(T, state.turnWaits, at), `${a}/${ra} ${b}/${rb} ${c}/${rc}`).toBeLessThanOrEqual(s(90));
        if (!parkRestored(state)) break;
        at += s(600);
      }
    }
  });

  it("leaves out a guess an earlier build's checkpoint still holds", () => {
    // Written by a page that guessed at `gaveUp` and was saved 40 s later:
    // that time was never known to be work.
    const old = { busy: true, turnStartedAt: T, turnWaits: { turn: T, waited: gaveUp - saved, since: null, guessed: gaveUp } } as Timed;
    const again = restoredTurn(old, gaveUp + s(40));
    expect(again.turnWaits).toEqual({ turn: T, waited: gaveUp + s(40) - saved, since: gaveUp + s(40), park: "held" });
    expect(turnElapsed(T, again.turnWaits, gaveUp + s(900))).toBe(s(90));
  });
});

describe("the agent's sign of work", () => {
  type Timed = { busy: boolean; turnStartedAt?: number; turnWaits?: TurnWaits };
  const saved = T + s(90);
  const back = T + s(271);
  const restored = () => restoredTurn<Timed>({ busy: true, turnStartedAt: T }, saved);
  const writes = { type: "stream_event", event: { type: "content_block_delta" } };

  it("ends a restored park only after a card the page saw has gone", () => {
    // Held, nothing confirmed: the page saw no card go.
    const held = restored();
    expect(withWork(held, writes, back + s(5))).toBe(held);
    // Confirmed: a card is up.
    const confirmed = withWait(held, true, back + s(10), "unread");
    expect(withWork(confirmed, writes, back + s(15))).toBe(confirmed);
    // Answered, another list still unread: held, until the agent writes.
    const answered = withWait(confirmed, false, back + s(20), "unread");
    expect(parkRestored(answered)).toBe(true);
    const working = withWork(answered, writes, back + s(26));
    // All the time from the checkpoint to that moment is left out.
    expect(working.turnWaits).toEqual({ turn: T, waited: back + s(26) - saved, since: null });
    expect(parkRestored(working)).toBe(false);
    expect(turnElapsed(T, working.turnWaits, back + s(31))).toBe(s(95));
  });

  it("is not a tool's result, the host's own line, a subagent or a seat", () => {
    const answered = withWait(withWait(restored(), true, back, "gaveUp"), false, back + s(20), "gaveUp");
    for (const event of [
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      { type: "octiq_question_answered", id: "q" },
      { type: "system", subtype: "status" },
      { type: "result", subtype: "success" },
      { type: "item.completed", item: { type: "mcp_tool_call" } },
      { type: "stream_event", event: { type: "content_block_delta" }, parent_tool_use_id: "task-1" },
      { type: "item.started", item: { type: "command_execution" }, octiq_speaker: { id: "s1" } },
      null, "words", 7,
    ]) expect(withWork(answered, event, back + s(30)), JSON.stringify(event)).toBe(answered);
    for (const event of [
      { type: "assistant", message: { content: [] } },
      { type: "item.started", item: { type: "command_execution" } },
      { type: "item.completed", item: { type: "agent_message", text: "On it." } },
      { type: "item.completed", item: { type: "reasoning" } },
      { event: "step_update", step_update: {} },
    ]) expect(parkRestored(withWork(answered, event, back + s(30))), JSON.stringify(event)).toBe(false);
  });

  it("touches nothing that is not a restored park of the turn in flight", () => {
    const working: Timed = { busy: true, turnStartedAt: T };
    expect(withWork(working, writes, T + s(9))).toBe(working);
    // A wait this page saw begin is ended by its card going, never by a stream.
    const waiting = withWait(working, true, T + s(30));
    expect(withWork(waiting, writes, T + s(40))).toBe(waiting);
    // Another turn's park, and a chat with no turn in flight.
    const answered = withWait(withWait(restored(), true, back, "unread"), false, back + s(20), "unread");
    const other = { ...answered, turnStartedAt: T + s(500) };
    expect(withWork(other, writes, back + s(30))).toBe(other);
    const idle = { ...answered, busy: false };
    expect(withWork(idle, writes, back + s(30))).toBe(idle);
  });
});

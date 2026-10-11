// What counts as arriving. Every case this refuses is one where the
// alternative is something animating that was simply already there: a chat
// reopened, a list read from the cache, a transcript opened from disk.
import { describe, expect, it } from "vitest";
import { ENTRY_MS, arrive, entryPhase, liveAppend } from "./arrival";

describe("arrive", () => {
  it("marks nothing late on the first draw of a place", () => {
    // A chat that opens with a card already waiting draws it in place.
    const first = arrive(null, "chat-1", ["permission:a", "plan:r1"]);
    expect([...first.late]).toEqual([]);
    expect([...first.here]).toEqual(["permission:a", "plan:r1"]);
  });

  it("marks what turns up afterwards", () => {
    const first = arrive(null, "chat-1", []);
    const next = arrive(first, "chat-1", ["permission:a"]);
    expect([...next.late]).toEqual(["permission:a"]);
  });

  it("keeps an arrival late for as long as it is there", () => {
    // The class has to stay put: taken off on the next render, it would cut
    // the animation it started; put back on later, it would start it again.
    let record = arrive(null, "chat-1", []);
    record = arrive(record, "chat-1", ["a"]);
    record = arrive(record, "chat-1", ["a", "b"]);
    expect([...record.late].sort()).toEqual(["a", "b"]);
  });

  it("never marks what was there from the start, however often it re-renders", () => {
    let record = arrive(null, "chat-1", ["a"]);
    for (let render = 0; render < 5; render += 1) record = arrive(record, "chat-1", ["a"]);
    record = arrive(record, "chat-1", ["a", "b"]);
    expect([...record.late]).toEqual(["b"]);
  });

  it("hands the same record back when nothing changed", () => {
    // Nearly every call: a store update, a streamed delta, a hover.
    const first = arrive(null, "chat-1", ["a", "b"]);
    expect(arrive(first, "chat-1", ["a", "b"])).toBe(first);
    expect(arrive(first, "chat-1", ["b", "a"])).toBe(first);
  });

  it("starts over when the place changes", () => {
    // Switching to another chat: its cards were not on screen a moment ago,
    // and that is not the same as their having just arrived.
    let record = arrive(null, "chat-1", []);
    record = arrive(record, "chat-1", ["a"]);
    const other = arrive(record, "chat-2", ["x", "y"]);
    expect([...other.late]).toEqual([]);
    expect(other.scope).toBe("chat-2");
  });

  it("does not replay on coming back to a chat that is already loaded", () => {
    let record = arrive(null, "chat-1", []);
    record = arrive(record, "chat-1", ["a"]);
    record = arrive(record, "chat-2", []);
    const back = arrive(record, "chat-1", ["a"]);
    expect([...back.late]).toEqual([]);
  });

  it("forgets what leaves, so the same thing coming back is an arrival", () => {
    let record = arrive(null, "chat-1", ["a"]);
    record = arrive(record, "chat-1", []);
    expect([...record.here]).toEqual([]);
    record = arrive(record, "chat-1", ["a"]);
    expect([...record.late]).toEqual(["a"]);
  });

  it("drops a late key with the thing it marked", () => {
    let record = arrive(null, "chat-1", []);
    record = arrive(record, "chat-1", ["a", "b"]);
    record = arrive(record, "chat-1", ["b"]);
    expect([...record.late]).toEqual(["b"]);
  });

  it("tells a replacement from an unchanged list of the same length", () => {
    const first = arrive(null, "chat-1", ["a", "b"]);
    const next = arrive(first, "chat-1", ["a", "c"]);
    expect(next).not.toBe(first);
    expect([...next.late]).toEqual(["c"]);
  });
});

describe("entryPhase", () => {
  it("holds until the answer is in", () => {
    expect(entryPhase(false, false, false)).toBe("held");
  });

  it("enters when the answer lands after the first draw", () => {
    expect(entryPhase(false, true, false)).toBe("entering");
  });

  it("settles once the entry has run", () => {
    expect(entryPhase(false, true, true)).toBe("settled");
  });

  it("is settled outright when the answer was there at the first draw", () => {
    // A cached value, or a page returned to: nothing arrives, nothing moves.
    expect(entryPhase(true, true, false)).toBe("settled");
  });

  it("holds again if the answer goes away", () => {
    expect(entryPhase(true, false, false)).toBe("held");
    expect(entryPhase(false, false, true)).toBe("held");
  });

  it("keeps the entering class on past the longest entry", () => {
    // `--enter-reveal-duration` is 200ms; the class may not come off under it.
    expect(ENTRY_MS).toBeGreaterThan(200);
  });
});

describe("liveAppend", () => {
  it("refuses the first draw", () => {
    // A transcript opened from disk mounts every block it has in one commit.
    expect(liveAppend(null, ["a", "b", "c"])).toBe(false);
  });

  it("refuses an empty transcript filling up with history", () => {
    // The page drew "opening…" with no turns; the record then lands whole.
    expect(liveAppend([], ["a", "b", "c"])).toBe(false);
    expect(liveAppend([], ["a", "b"])).toBe(false);
  });

  it("counts the first message in a blank chat", () => {
    expect(liveAppend([], ["a"])).toBe(true);
  });

  it("counts a block added to the answer in flight", () => {
    // No turn was added at all: the last one grew. The commonest arrival.
    expect(liveAppend(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("counts a turn, or a message and the start of its answer, appended", () => {
    expect(liveAppend(["a"], ["a", "b"])).toBe(true);
    expect(liveAppend(["a"], ["a", "b", "c"])).toBe(true);
  });

  it("refuses a catch-up", () => {
    // A dropped connection coming back with everything that was missed.
    expect(liveAppend(["a"], ["a", "b", "c", "d"])).toBe(false);
  });

  it("refuses an older page put in front", () => {
    // "Load earlier messages": the turns that were here are no longer first.
    expect(liveAppend(["c", "d"], ["a", "b", "c", "d"])).toBe(false);
    expect(liveAppend(["c", "d"], ["b", "c", "d"])).toBe(false);
  });

  it("refuses another chat's turns", () => {
    expect(liveAppend(["a", "b"], ["x", "y"])).toBe(false);
    expect(liveAppend(["a", "b"], ["x", "y", "z"])).toBe(false);
  });

  it("refuses a list that shrank", () => {
    expect(liveAppend(["a", "b"], ["a"])).toBe(false);
    expect(liveAppend(["a", "b"], [])).toBe(false);
  });
});

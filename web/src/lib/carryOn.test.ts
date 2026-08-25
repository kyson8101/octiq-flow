// A turn that was cut off, and the one thing to do about it.
import { describe, expect, it } from "vitest";

import { CARRY_ON, CARRY_ON_HEAD, readCarryOn, someoneWorking, wasCutOff } from "./carryOn";

describe("wasCutOff", () => {
  it("is a chat that says it is working while nothing is running it", () => {
    expect(wasCutOff({ busy: true, live: false, known: true })).toBe(true);
  });

  it("says nothing while the server has not yet said what is running", () => {
    // The page knows it is working before it knows what the server holds. Read
    // that gap as a cut turn and every reload flashes the notice.
    expect(wasCutOff({ busy: true, live: false, known: false })).toBe(false);
  });

  it("leaves a working chat alone", () => {
    expect(wasCutOff({ busy: true, live: true, known: true })).toBe(false);
  });

  it("leaves a chat that has finished its turn alone", () => {
    expect(wasCutOff({ busy: false, live: false, known: true })).toBe(false);
  });
});

describe("readCarryOn", () => {
  it("draws the prompt the button sends as one line", () => {
    expect(readCarryOn(CARRY_ON)).toBeTruthy();
  });

  it("says nothing about a message somebody typed", () => {
    expect(readCarryOn("carry on")).toBeUndefined();
    expect(readCarryOn("Can you carry on where you stopped?")).toBeUndefined();
  });

  it("recognises the prompt in a transcript read back later", () => {
    // The words are what a rebuilt conversation has; there is no flag in the
    // record to find it by.
    expect(readCarryOn(`${CARRY_ON_HEAD}\n\nolder wording of the rest`)).toBeTruthy();
  });

  it("says what happened rather than what was sent", () => {
    // The reader gets a line about the restart, not the instruction the agent
    // was given.
    expect(readCarryOn(CARRY_ON)).toBe("asked it to carry on after the backend stopped");
  });
});

describe("someoneWorking", () => {
  const room = "room-1";

  it("is true while the chat's own process is up", () => {
    expect(someoneWorking({ id: room, running: new Set([room]), round: false })).toBe(true);
  });

  it("is true while a SEAT of this room is answering", () => {
    // A seat runs as its own process, under a key of its own. Nothing is
    // running on the room's key while it writes — and the room is plainly
    // being worked on.
    expect(
      someoneWorking({ id: room, running: new Set([`${room}-seat-s1`]), round: false }),
    ).toBe(true);
  });

  it("is true while a round is going, whichever seat is speaking", () => {
    expect(someoneWorking({ id: room, running: new Set(), round: true })).toBe(true);
  });

  it("is not fooled by another room's seat", () => {
    expect(
      someoneWorking({ id: room, running: new Set(["room-2-seat-s1"]), round: false }),
    ).toBe(false);
  });

  it("is false when nothing at all is up", () => {
    expect(someoneWorking({ id: room, running: new Set(), round: false })).toBe(false);
  });
});

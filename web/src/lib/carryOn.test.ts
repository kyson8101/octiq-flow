// A turn that was cut off, and the one thing to do about it.
import { describe, expect, it } from "vitest";

import { CARRY_ON, CARRY_ON_HEAD, readCarryOn, wasCutOff } from "./carryOn";

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

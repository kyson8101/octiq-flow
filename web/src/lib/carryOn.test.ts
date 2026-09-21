// A turn that was cut off, and the one thing to do about it.
import { describe, expect, it } from "vitest";

import {
  CHAT_SERVICE_RESUMED,
  CHAT_SERVICE_RESUMED_HEAD,
  CHAT_SERVICE_RESUMED_REPLY,
  readChatServiceResumed,
  someoneWorking,
  wasCutOff,
} from "./carryOn";

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

describe("readChatServiceResumed", () => {
  it("draws the notice the button sends as one line", () => {
    expect(readChatServiceResumed(CHAT_SERVICE_RESUMED)).toBeTruthy();
  });

  it("says nothing about a message somebody typed", () => {
    expect(readChatServiceResumed("chat service resumed")).toBeUndefined();
    expect(readChatServiceResumed("The chat service has resumed.")).toBeUndefined();
  });

  it("recognises the prompt in a transcript read back later", () => {
    // The words are what a rebuilt conversation has; there is no flag in the
    // record to find it by.
    expect(readChatServiceResumed(`${CHAT_SERVICE_RESUMED_HEAD}\n\nolder wording of the rest`)).toBeTruthy();
  });

  it("shows only the service status", () => {
    expect(readChatServiceResumed(CHAT_SERVICE_RESUMED)).toBe(CHAT_SERVICE_RESUMED_REPLY);
  });

  it("keeps old carry-on notices readable without sending that instruction again", () => {
    expect(readChatServiceResumed("=== carry on where you stopped ===\n\nlegacy prompt"))
      .toBe(CHAT_SERVICE_RESUMED_REPLY);
  });
});

describe("someoneWorking", () => {
  const room = "room-1";

  it("is true while the chat's own process is up", () => {
    expect(someoneWorking({ id: room, running: new Set([room]) })).toBe(true);
  });

  it("is not fooled by another chat", () => {
    expect(
      someoneWorking({ id: room, running: new Set(["room-2"]) }),
    ).toBe(false);
  });

  it("is false when nothing at all is up", () => {
    expect(someoneWorking({ id: room, running: new Set() })).toBe(false);
  });
});

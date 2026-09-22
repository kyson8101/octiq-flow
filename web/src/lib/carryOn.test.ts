// A turn that was cut off, and the one thing to do about it.
import { describe, expect, it } from "vitest";

import {
  CHAT_SERVICE_RESUMED_HEAD,
  CHAT_SERVICE_RESUMED_REPLY,
  readChatServiceResumed,
  someoneWorking,
} from "./carryOn";

const HISTORICAL_SERVICE_RESUMED = `${CHAT_SERVICE_RESUMED_HEAD}

Reply only with: ${CHAT_SERVICE_RESUMED_REPLY}`;

describe("readChatServiceResumed", () => {
  it("draws the notice the button sends as one line", () => {
    expect(readChatServiceResumed(HISTORICAL_SERVICE_RESUMED)).toBeTruthy();
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
    expect(readChatServiceResumed(HISTORICAL_SERVICE_RESUMED)).toBe(CHAT_SERVICE_RESUMED_REPLY);
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

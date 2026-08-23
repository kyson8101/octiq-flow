// Which side wins when the browser and the backend disagree about a room.
import { describe, expect, it } from "vitest";

import { roomSync } from "./roomSync";

describe("when they agree", () => {
  it("does nothing for an ordinary chat", () => {
    expect(roomSync(false, false)).toEqual({ do: "nothing" });
  });

  it("does nothing for a room both know about", () => {
    expect(roomSync(true, true)).toEqual({ do: "nothing" });
  });
});

describe("when the backend has a room the browser does not know about", () => {
  it("believes the backend", () => {
    // Reported 2026-08-23: a room opened outside the client showed as "Single
    // chat" after a reload, because the mode came from localStorage alone and
    // `chat_room`'s `open` was being thrown away.
    expect(roomSync(false, true)).toEqual({ do: "adopt" });
  });
});

describe("when the browser was told to make a room and the backend forgot", () => {
  it("asks for it again rather than falling back to a single chat", () => {
    // Rooms live in backend memory, so a restart forgets them. That is a
    // process ending, not a decision to undo what the person asked for.
    expect(roomSync(true, false)).toEqual({ do: "reassert" });
  });
});

// Card 84 — how many agents are in this chat, said at the top.
import { describe, expect, it } from "vitest";

import { roomCount } from "./roomCount";

describe("the count of who is in a chat", () => {
  it("is nothing at all in an ordinary chat", () => {
    // A badge that appears in every chat in the app says nothing about any of
    // them. One agent is what a chat has always had.
    expect(roomCount(0)).toBeNull();
  });

  it("counts the host as well as the seats", () => {
    // The host is an agent in the room, not the furniture. Two seats and the
    // host is three voices, and three is the number a reader is counting.
    expect(roomCount(1)?.total).toBe(2);
    expect(roomCount(2)?.total).toBe(3);
  });

  it("says what the number means, for anyone hovering it", () => {
    expect(roomCount(1)?.label).toBe("2 agents in this chat");
  });

  it("is not confused by a seat list that went negative somehow", () => {
    // Nothing should produce this, and a badge reading "0 agents" over a
    // working chat would be worse than none.
    expect(roomCount(-1)).toBeNull();
  });
});

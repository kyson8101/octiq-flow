import { describe, expect, it } from "vitest";

import { appendConversationPin, newConversationPin, pinLabel, readConversationPins } from "./conversationPins";

describe("conversation pins", () => {
  it("uses the opening of a selected passage as a compact label", () => {
    expect(pinLabel("  Keep this decision\nfor the next release.  ")).toBe(
      "Keep this decision for the next release.",
    );
  });

  it("keeps line breaks in the saved passage", () => {
    expect(
      newConversationPin({ id: "p1", turnId: "m1", createdAt: 1, text: "first line\nsecond line" }),
    ).toMatchObject({
      label: "first line second line",
      text: "first line\nsecond line",
      turnId: "m1",
    });
  });

  it("allows several passages from one turn but not the exact same one twice", () => {
    const first = newConversationPin({ id: "p1", turnId: "m1", createdAt: 1, text: "one" });
    const same = newConversationPin({ id: "p2", turnId: "m1", createdAt: 2, text: "one" });
    const second = newConversationPin({ id: "p3", turnId: "m1", createdAt: 3, text: "two" });

    expect(appendConversationPin([first], same)).toEqual([first]);
    expect(appendConversationPin([first], second)).toEqual([first, second]);
  });

  it("drops malformed saved rows without losing the good pins", () => {
    expect(
      readConversationPins([
        { id: "a", turnId: "m1", text: "remember this", createdAt: 5 },
        { id: "a", turnId: "m2", text: "duplicate id" },
        { id: "b", turnId: "", text: "no source" },
        { id: "c", turnId: "m3", text: "  custom label  ", label: "  later  " },
      ]),
    ).toEqual([
      {
        id: "a",
        label: "remember this",
        text: "remember this",
        turnId: "m1",
        createdAt: 5,
      },
      {
        id: "c",
        label: "later",
        text: "custom label",
        turnId: "m3",
        createdAt: 0,
      },
    ]);
  });
});

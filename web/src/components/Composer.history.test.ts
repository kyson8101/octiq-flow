import { describe, expect, it, vi } from "vitest";

// Importing Composer pulls in the live bridge. History movement is pure and
// does not talk to the server, so the bridge is kept out of this unit test.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { moveInHistory } from "./Composer";

describe("sent-message history", () => {
  const history = ["most recent", "one before that", "oldest"];

  it("walks from the current draft toward older sent messages", () => {
    const first = moveInHistory(history, -1, "half-written draft", "", "older");
    const second = moveInHistory(history, first.index, first.text, first.draft, "older");

    expect(first).toEqual({
      index: 0,
      text: "most recent",
      draft: "half-written draft",
    });
    expect(second).toEqual({
      index: 1,
      text: "one before that",
      draft: "half-written draft",
    });
  });

  it("walks forward again and restores the draft at the end", () => {
    const newer = moveInHistory(history, 1, "one before that", "half-written draft", "newer");
    const draft = moveInHistory(history, newer.index, newer.text, newer.draft, "newer");

    expect(newer).toEqual({
      index: 0,
      text: "most recent",
      draft: "half-written draft",
    });
    expect(draft).toEqual({
      index: -1,
      text: "half-written draft",
      draft: "half-written draft",
    });
  });

  it("stays at the oldest message instead of wrapping", () => {
    expect(moveInHistory(history, 2, "oldest", "draft", "older")).toEqual({
      index: 2,
      text: "oldest",
      draft: "draft",
    });
  });

  it("does nothing when there is nowhere to move", () => {
    expect(moveInHistory([], -1, "draft", "", "older")).toEqual({
      index: -1,
      text: "draft",
      draft: "",
    });
    expect(moveInHistory(history, -1, "draft", "", "newer")).toEqual({
      index: -1,
      text: "draft",
      draft: "",
    });
  });
});

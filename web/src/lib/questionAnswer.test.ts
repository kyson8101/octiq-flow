import { describe, expect, it } from "vitest";
import { composeAnswer, togglePick } from "./questionAnswer";

describe("togglePick", () => {
  it("ticks an option, and un-ticks the same one again", () => {
    // A set is built by changing your mind, so the second tap on a choice has
    // to take it back — otherwise a mis-tap is an answer you cannot withdraw.
    expect(togglePick([], "Rust")).toEqual(["Rust"]);
    expect(togglePick(["Rust"], "Rust")).toEqual([]);
  });

  it("keeps every other tick where it was", () => {
    expect(togglePick(["Rust", "Web"], "Rust")).toEqual(["Web"]);
    expect(togglePick(["Rust"], "Web")).toEqual(["Rust", "Web"]);
  });
});

describe("composeAnswer", () => {
  const options = ["Rust", "Web", "Docs"];

  it("says the ticked options in the order they were offered", () => {
    // Not in tap order: the agent wrote the list, and reading it back in its
    // own order is what makes a long answer scannable against the question.
    expect(composeAnswer(options, ["Docs", "Rust"], "")).toBe("Rust, Docs");
  });

  it("keeps anything typed alongside the ticks", () => {
    // "These two, and also…" is a real answer, and dropping the tail would
    // send the agent half of what was meant while looking complete.
    expect(composeAnswer(options, ["Rust"], "and the CI config")).toBe("Rust, and the CI config");
  });

  it("is just the typed answer when nothing is ticked", () => {
    expect(composeAnswer(options, [], "  none of these  ")).toBe("none of these");
  });

  it("is empty when nothing was said at all", () => {
    // The card leans on this to keep Send disabled. An empty string sent as an
    // answer would read to the agent as a decision made.
    expect(composeAnswer(options, [], "   ")).toBe("");
  });

  it("ignores a tick for something no longer on offer", () => {
    // Ticks are kept per question and the question can be stepped back to. A
    // pick that is not in the list can only be stale, and putting it in the
    // answer would have the agent act on a choice it never gave.
    expect(composeAnswer(options, ["Rust", "Gone"], "")).toBe("Rust");
  });
});

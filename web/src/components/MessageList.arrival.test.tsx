// A message you just sent comes in; a transcript you just opened does not.
// Both are "turns that were not on screen a moment ago", so the whole
// difference lives in this one predicate — and every case it has to REFUSE is a
// case where the alternative is the entire chat animating at once.
import { describe, expect, it, vi } from "vitest";

// Importing the module at all opens the socket, which reads `location` — and
// there is no location in node. The same stub its sibling tests use; nothing
// here renders anything, let alone sends.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { justAppended } from "./MessageList";

describe("justAppended", () => {
  it("names the turn that was appended", () => {
    expect(justAppended(["a", "b"], ["a", "b", "c"])).toBe("c");
  });

  it("counts the first message in a blank chat as an arrival", () => {
    // The one that matters most: a new chat has nothing on screen, and the
    // first thing anyone does with it is send a message.
    expect(justAppended([], ["a"])).toBe("a");
  });

  it("refuses the first draw, which has nothing to be different from", () => {
    // A transcript opened from disk mounts every turn it has in one frame.
    expect(justAppended(null, ["a", "b", "c"])).toBeNull();
  });

  it("refuses a list that was replaced wholesale", () => {
    // Switching to another chat. Same length or not, nothing carried over.
    expect(justAppended(["a", "b"], ["x", "y", "z"])).toBeNull();
  });

  it("refuses a switch that happens to share a turn id", () => {
    // The ids match at the end rather than the start, so it is not an append.
    expect(justAppended(["a", "b"], ["x", "a", "b"])).toBeNull();
  });

  it("refuses several arriving at once", () => {
    // A resume, or a room's seats answering together. Conservative on purpose:
    // failing this test costs an animation, passing it wrongly costs a stampede.
    expect(justAppended(["a"], ["a", "b", "c"])).toBeNull();
  });

  it("refuses a list that did not change", () => {
    // The common case by far: a streaming delta re-renders the same turns many
    // times a second, and none of them is an arrival.
    expect(justAppended(["a", "b"], ["a", "b"])).toBeNull();
  });

  it("refuses a turn that went away", () => {
    expect(justAppended(["a", "b"], ["a"])).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";

// Same reason as the other Composer tests beside this one: importing Composer
// pulls the bridge in, and the bridge opens a socket off `location.href` as its
// module loads. There is no `location` in the node environment, and nothing
// here talks to a server.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { withPutBack } from "./Composer";

/** Words put back in the box after the ✕ took them off a queued bubble.
 *
 *  Taking a message back used to destroy what was typed along with the bubble.
 *  The box is where it goes instead. (Stop does not come through here: it keeps
 *  the queue and runs the front of it.)
 */
describe("putting a taken-back message back in the box", () => {
  it("fills an empty box with what was queued, in the order it was sent", () => {
    expect(withPutBack("", ["first", "second"])).toBe("first\n\nsecond");
  });

  it("goes AFTER what is already in the box", () => {
    // The half-typed line is newer than the message that was queued, and
    // putting one back must never take the other away.
    expect(withPutBack("half a thought", ["queued"])).toBe("half a thought\n\nqueued");
  });

  it("keeps the order when the words arrive in two batches", () => {
    // Each cancellation is its own event, so clearing several queued bubbles
    // reaches the box as more than one call. Appending is what keeps them the
    // right way round; prepending would turn them inside out.
    expect(withPutBack(withPutBack("", ["one"]), ["two"])).toBe("one\n\ntwo");
  });

  it("separates them by a blank line, so two messages do not become one", () => {
    expect(withPutBack("", ["a\nstill a", "b"])).toBe("a\nstill a\n\nb");
  });

  it("drops the empties rather than leaving a gap", () => {
    expect(withPutBack("  ", ["", "  ", "real"])).toBe("real");
    expect(withPutBack("", [])).toBe("");
  });
});

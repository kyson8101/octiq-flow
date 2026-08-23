import { describe, expect, it } from "vitest";
import { Drafts } from "./drafts";

/** A stand-in for the composer's attachments: only their identity matters. */
type Pic = { path: string };

describe("Drafts", () => {
  it("gives an empty box for a chat nothing was typed in", () => {
    const drafts = new Drafts<Pic>();

    expect(drafts.take("a")).toEqual({ text: "", attached: [] });
  });

  it("gives back what was being written in that chat", () => {
    const drafts = new Drafts<Pic>();
    drafts.keep("a", { text: "half a thought", attached: [{ path: "/tmp/shot.png" }] });

    expect(drafts.take("a")).toEqual({
      text: "half a thought",
      attached: [{ path: "/tmp/shot.png" }],
    });
  });

  it("never hands one chat's half-typed message to another", () => {
    const drafts = new Drafts<Pic>();
    drafts.keep("a", { text: "/pandahrms:lint-gate", attached: [] });

    // The whole point: leaving chat A with words in the box must not arm chat
    // B's send button with them.
    expect(drafts.take("b")).toEqual({ text: "", attached: [] });
  });

  it("holds a draft for the blank chat too, which has no id yet", () => {
    const drafts = new Drafts<Pic>();
    drafts.keep(undefined, { text: "about to start", attached: [] });

    expect(drafts.take(undefined)).toEqual({ text: "about to start", attached: [] });
    expect(drafts.take("a")).toEqual({ text: "", attached: [] });
  });

  it("forgets a draft once it has been taken back out", () => {
    const drafts = new Drafts<Pic>();
    drafts.keep("a", { text: "said already", attached: [] });
    drafts.take("a");

    expect(drafts.take("a")).toEqual({ text: "", attached: [] });
  });

  it("keeps nothing for an empty box, so an older draft cannot come back", () => {
    const drafts = new Drafts<Pic>();
    drafts.keep("a", { text: "first", attached: [] });
    drafts.keep("a", { text: "   ", attached: [] });

    expect(drafts.take("a")).toEqual({ text: "", attached: [] });
  });
});

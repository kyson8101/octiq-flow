// The tip on a project's name: three ways in (a pointer, the keyboard, a
// tap), and for each one how it opens and how it shuts. Escape shuts it with
// the pointer still over the name, which is the case style alone got wrong.
import { describe, expect, it } from "vitest";
import { NO_TIP, tipAfter, tipShown, type Tip, type TipEvent } from "./placeTip";

/** The tip after a run of events, from shut. */
const after = (...events: TipEvent[]): Tip => events.reduce(tipAfter, NO_TIP);
const shown = (...events: TipEvent[]): boolean => tipShown(after(...events));

describe("the tip on a project's name", () => {
  it("is shut until something asks for it", () => {
    expect(tipShown(NO_TIP)).toBe(false);
    // Nothing to take away, nothing changes.
    expect(after("escape")).toEqual(NO_TIP);
    expect(after("outside")).toEqual(NO_TIP);
    expect(after("leave", "blur")).toEqual(NO_TIP);
  });

  it("a pointer: over the name opens it, leaving shuts it", () => {
    expect(shown("enter")).toBe(true);
    expect(shown("enter", "leave")).toBe(false);
    expect(shown("enter", "leave", "enter")).toBe(true);
  });

  it("a pointer: Escape shuts it with the pointer still there, until it leaves and comes back", () => {
    expect(shown("enter", "escape")).toBe(false);
    // Still over the name: nothing brings it back but leaving and returning.
    expect(shown("enter", "escape", "escape")).toBe(false);
    expect(shown("enter", "escape", "leave")).toBe(false);
    expect(shown("enter", "escape", "leave", "enter")).toBe(true);
  });

  it("the keyboard: the focus opens it, losing the focus shuts it", () => {
    expect(shown("focus")).toBe(true);
    expect(shown("focus", "blur")).toBe(false);
    expect(shown("focus", "blur", "focus")).toBe(true);
  });

  it("the keyboard: Escape shuts it with the focus still there, until the name is focused again", () => {
    expect(shown("focus", "escape")).toBe(false);
    expect(shown("focus", "escape", "escape")).toBe(false);
    expect(shown("focus", "escape", "blur")).toBe(false);
    expect(shown("focus", "escape", "blur", "focus")).toBe(true);
  });

  it("the review's case: hovered and focused, Escape shuts it and it stays shut", () => {
    // Hover the name, focus it, press Escape, do not move the mouse.
    const tip = after("enter", "focus", "escape");
    expect(tipShown(tip)).toBe(false);
    expect(tip).toEqual({ hover: "shut", focus: "shut" });
    // The pointer leaving does not hand the tip back to a focus that was
    // sent away, and nor does the focus leaving hand it back to the pointer.
    expect(shown("enter", "focus", "escape", "leave")).toBe(false);
    expect(shown("enter", "focus", "escape", "blur")).toBe(false);
    // Each comes back by asking again, and only for as long as it asks.
    expect(shown("enter", "focus", "escape", "leave", "enter")).toBe(true);
    expect(shown("enter", "focus", "escape", "leave", "enter", "leave")).toBe(false);
    expect(shown("enter", "focus", "escape", "blur", "focus")).toBe(true);
    expect(shown("enter", "focus", "escape", "blur", "focus", "blur")).toBe(false);
  });

  it("a tap: opens it, and a press anywhere else shuts it", () => {
    // A finger does not hover (the card sends no `enter` for one): the tap
    // focuses the name, or stands for the focus where the browser gives none.
    expect(shown("focus", "press")).toBe(true);
    expect(shown("press")).toBe(true);
    // A press elsewhere, with or without the blur that usually comes with it.
    expect(shown("focus", "press", "outside", "blur")).toBe(false);
    expect(shown("press", "outside")).toBe(false);
    // Tapped again, it opens again.
    expect(shown("press", "outside", "press")).toBe(true);
    expect(shown("focus", "press", "outside", "blur", "focus", "press")).toBe(true);
  });

  it("a press on the name asks again after Escape", () => {
    expect(shown("enter", "focus", "escape", "press")).toBe(true);
    expect(shown("focus", "escape", "press")).toBe(true);
  });

  it("one way in does not shut another that is still asking", () => {
    // Focused by the keyboard, and the mouse passes over and away.
    expect(shown("focus", "enter", "leave")).toBe(true);
    // Hovered, and the focus passes through.
    expect(shown("enter", "focus", "blur")).toBe(true);
  });
});

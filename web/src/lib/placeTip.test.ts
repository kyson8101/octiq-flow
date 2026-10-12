// The tip on a project's name: three ways in (a pointer, the keyboard, a
// tap), and for each one how it opens and how it shuts. Escape shuts it with
// the pointer still over the name, which is the case style alone got wrong.
import { describe, expect, it } from "vitest";
import { focusAt, hearEscape, keepsEscape, NO_TIP, tipAfter, tipShown, type Tip, type TipEvent } from "./placeTip";

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

/* ---- Whose Escape it is ------------------------------------------------ */

/** An element, as far as "where is the focus" goes: what it contains. */
const element = (...inside: object[]) => {
  const self = { contains: (other: object | null): boolean => other === self || inside.includes(other as object) };
  return self;
};

/** A key press, and what was done to it. */
const press = (key = "Escape") => {
  const event = {
    key, prevented: false, stopped: false,
    preventDefault() { event.prevented = true; },
    stopPropagation() { event.stopped = true; },
  };
  return event;
};

describe("the Escape that shuts a tip", () => {
  it("knows where the focus is: on the tip's name, on nothing, or anywhere else", () => {
    const body = element();
    const tipText = element();
    const word = element(tipText);
    const field = element();
    expect(focusAt(word, word, body)).toBe("word");
    expect(focusAt(tipText, word, body)).toBe("word");
    // Nothing has the focus: the document says its body, or nothing at all.
    expect(focusAt(body, word, body)).toBe("nowhere");
    expect(focusAt(null, word, body)).toBe("nowhere");
    // A field, a button, a dialog, another card, another tip's name.
    expect(focusAt(field, word, body)).toBe("elsewhere");
    expect(focusAt(element(), word, body)).toBe("elsewhere");
    // The name is not on the page (yet, or any more): the focus is not on it.
    expect(focusAt(field, null, body)).toBe("elsewhere");
    expect(focusAt(body, null, body)).toBe("nowhere");
  });

  // Whether the tip is shown × where the focus is.
  it.each([
    { tip: true, at: "word", keeps: true },
    { tip: true, at: "nowhere", keeps: true },
    { tip: true, at: "elsewhere", keeps: false },
    { tip: false, at: "word", keeps: false },
    { tip: false, at: "nowhere", keeps: false },
    { tip: false, at: "elsewhere", keeps: false },
  ] as const)("shown $tip, focus $at: kept from going further $keeps", ({ tip, at, keeps }) => {
    expect(keepsEscape(tip, at)).toBe(keeps);
    const event = press();
    const said: TipEvent[] = [];
    hearEscape(event, tip, at, (what) => said.push(what));
    // A tip that is shown is always sent away, whoever else hears the key.
    expect(said).toEqual(tip ? ["escape"] : []);
    expect(event.stopped).toBe(keeps);
    expect(event.prevented).toBe(keeps);
  });

  it("hears no other key", () => {
    for (const key of ["Enter", "Tab", " ", "Esc", "a"]) {
      const event = press(key);
      const said: TipEvent[] = [];
      hearEscape(event, true, "word", (what) => said.push(what));
      expect(said).toEqual([]);
      expect(event.stopped).toBe(false);
      expect(event.prevented).toBe(false);
    }
  });
});

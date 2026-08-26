import { describe, expect, it } from "vitest";
import { choicesOf, composeAnswer, optionIsOn, pendingAnswer, togglePick } from "./questionAnswer";

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

describe("choicesOf", () => {
  it("reads a labelled object, description and all", () => {
    expect(choicesOf([{ label: "SQLite", description: "One file, no server" }])).toEqual([
      { label: "SQLite", description: "One file, no server" },
    ]);
  });

  it("still reads a plain list of strings", () => {
    // The client and the server deploy separately, so a page built after the
    // server is routinely handed the old shape. Drawing nothing there would be
    // a question with no way to answer it.
    expect(choicesOf(["Postgres", "SQLite"])).toEqual([
      { label: "Postgres" },
      { label: "SQLite" },
    ]);
  });

  it("drops what has no words on it", () => {
    expect(choicesOf(["Keep", { value: "Lost" }, "   ", 7, null])).toEqual([{ label: "Keep" }]);
  });

  it("treats a blank description as none at all", () => {
    expect(choicesOf([{ label: "Keep", description: "  " }])).toEqual([{ label: "Keep" }]);
  });

  it("has nothing to say about a free-text question", () => {
    expect(choicesOf(undefined)).toEqual([]);
  });
});

describe("pendingAnswer", () => {
  const base = { many: false, labels: ["Postgres", "SQLite"], ticked: [], text: "" };

  it("sends nothing at all until something is chosen or typed", () => {
    // The button is dead until this is non-empty, which is the whole guard: a
    // card that could send on a stray tap is a card that answers for you.
    expect(pendingAnswer(base)).toBe("");
  });

  it("holds a tapped choice as what WOULD be sent", () => {
    expect(pendingAnswer({ ...base, chosen: "SQLite" })).toBe("SQLite");
  });

  it("lets what you typed beat what you tapped", () => {
    // The box says "…or say something else", and typing a sentence is the more
    // deliberate of the two acts.
    expect(pendingAnswer({ ...base, chosen: "SQLite", text: "  neither  " })).toBe("neither");
  });

  it("adds the typed line to the ticks for a set", () => {
    expect(
      pendingAnswer({ ...base, many: true, ticked: ["SQLite"], text: "and MySQL" }),
    ).toBe("SQLite, and MySQL");
  });

  it("keeps an answer already recorded, so a page you step back to can be sent again", () => {
    expect(pendingAnswer({ ...base, chosen: "something I typed last time" })).toBe(
      "something I typed last time",
    );
  });
});

describe("optionIsOn", () => {
  const base = { many: false, ticked: [] as string[], text: "" };

  it("lights the choice that was tapped", () => {
    expect(optionIsOn({ ...base, label: "SQLite", chosen: "SQLite" })).toBe(true);
    expect(optionIsOn({ ...base, label: "Postgres", chosen: "SQLite" })).toBe(false);
  });

  it("puts the tap out once something is typed", () => {
    // What you type beats what you tapped (`pendingAnswer`). A choice still lit
    // beside a typed line claims a decision that is not the one being sent.
    expect(optionIsOn({ ...base, label: "SQLite", chosen: "SQLite", text: "neither" })).toBe(
      false,
    );
  });

  it("lights it again when the box is emptied", () => {
    // Typing dims the tap; it does not take it back. Clearing the line has to
    // leave the card as it was, or a stray keystroke costs you the choice.
    expect(optionIsOn({ ...base, label: "SQLite", chosen: "SQLite", text: "   " })).toBe(true);
  });

  it("leaves a set's ticks alone whatever is typed", () => {
    // A set sends its ticks AND the typed line together — "…and anything else"
    // — so the text is no reason to un-tick anything.
    expect(
      optionIsOn({ many: true, label: "SQLite", ticked: ["SQLite"], text: "and MySQL" }),
    ).toBe(true);
  });
});

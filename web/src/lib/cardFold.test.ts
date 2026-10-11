// What a folded card keeps and what it folds.
//
// The risk runs both ways. A part taken for short that is not gets cut on
// screen; a part folded without a label is approved unseen. And a consequence
// (the seat a removal empties, the reports it moves) must never fold to a
// size alone, whatever its length.
import { describe, expect, it } from "vitest";
// Loaded through Vite's `?raw`, not node:fs: this is a browser tsconfig.
import host from "../../../src-tauri/src/team_tools.rs?raw";
import {
  capped, count, cutNote, diffLabel, digits, foldIsOpen, foldPhase, foldPressed, foldSettled, foldStart, HARD_CAP,
  isShort, lineCount, longRowsLabel, nameList, planLabel, STRAY_MS, STRAY_RADIUS, strayPress,
  rowFold, SHORT_FACT, SHORT_TEXT, sizeLabel, STRUCTURAL, STRUCTURAL_WHOLE, tail, textFold, textLines,
} from "./cardFold";

describe("short fact or long part", () => {
  it("takes one line of about sixty characters for a fact", () => {
    expect(isShort("edits")).toBe(true);
    expect(isShort("x".repeat(SHORT_FACT))).toBe(true);
    expect(isShort("x".repeat(SHORT_FACT + 1))).toBe(false);
    expect(isShort("")).toBe(true);
  });

  it("takes anything over several lines for a long part, however short the lines", () => {
    expect(isShort("a\nb")).toBe(false);
    expect(lineCount("a\nb")).toBe(2);
  });

  it("does not count the blank lines a text opens or ends with", () => {
    expect(textLines("\n\n  \nOwns the notes.\n\n")).toEqual(["Owns the notes."]);
    expect(isShort("\nOwns the notes.\n")).toBe(true);
    // A blank line inside is part of the text.
    expect(lineCount("a\n\nb")).toBe(3);
  });
});

describe("the size a folded part is named with", () => {
  it("counts lines when there are several, characters when there is one", () => {
    expect(sizeLabel("a\nb")).toBe("2 lines");
    expect(sizeLabel("x".repeat(340))).toBe("340 characters");
    expect(sizeLabel("x")).toBe("1 character");
  });

  it("groups digits itself, the same in every browser", () => {
    expect(digits(999)).toBe("999");
    expect(digits(8000)).toBe("8,000");
    expect(digits(1234567)).toBe("1,234,567");
    expect(count(8000, "character")).toBe("8,000 characters");
    expect(count(1, "line")).toBe("1 line");
  });
});

describe("a row of a change", () => {
  it("leaves a short value and a short move on the card", () => {
    expect(rowFold({ label: "Provider", value: "Codex" })).toEqual({ folded: false });
    expect(rowFold({ label: "Access", before: "edits", after: "auto" })).toEqual({ folded: false });
    // A short field being cleared is still a short move.
    expect(rowFold({ label: "Team", before: "Octiq", after: "" })).toEqual({ folded: false });
  });

  it("folds a long value to its size", () => {
    expect(rowFold({ label: "Role", value: "Owns the web client.\nDoes not push." }))
      .toEqual({ folded: true, note: "2 lines" });
    expect(rowFold({ label: "Role", value: "r".repeat(2000) })).toEqual({ folded: true, note: "2,000 characters" });
  });

  it("says a folded move changes, and how much it becomes", () => {
    expect(rowFold({ label: "Role", before: "Writes notes.", after: "Owns the notes.\nNever invents a fix." }))
      .toEqual({ folded: true, note: "changed · 2 lines" });
    // Long before, short after: it still changes, and what it was is the long part.
    expect(rowFold({ label: "Role", before: "a\nb\nc", after: "Notes." }))
      .toEqual({ folded: true, note: "changed · 6 characters" });
  });

  it("says a long text that is cleared is cleared", () => {
    expect(rowFold({ label: "Persistent prompt", before: "p".repeat(8000), after: "" }))
      .toEqual({ folded: true, note: "cleared" });
  });

  it("counts the rows it folded", () => {
    expect(longRowsLabel(1)).toBe("1 long field");
    expect(longRowsLabel(3)).toBe("3 long fields");
  });
});

describe("what a removal does to the chart", () => {
  // The host's own sentences (`team_tools.rs`), each longer than a short fact.
  const noHead = "The cross-project conversation will have no head until another is chosen.";
  const noFrontDesk = "Incoming requests will have no front desk until another is chosen.";

  it("is never folded: the seat that empties is drawn whole", () => {
    expect(noHead.length).toBeGreaterThan(SHORT_FACT);
    expect(rowFold({ label: "Head", value: noHead })).toEqual({ folded: false });
    expect(rowFold({ label: "Front desk", value: noFrontDesk })).toEqual({ folded: false });
    expect(rowFold({ label: "Direct reports", value: "Dev, Ops will report to Potato." })).toEqual({ folded: false });
    // The same sentence under any other name is a long value like any other.
    expect(rowFold({ label: "Role", value: noHead })).toEqual({ folded: true, note: "73 characters" });
  });

  it("folds the names of a long list of reports, never where they go", () => {
    const names = Array.from({ length: 300 }, (_, i) => `Dev${i}`).join(", ");
    const value = `${names} will report to Manager.`;
    expect(value.length).toBeGreaterThan(STRUCTURAL_WHOLE);
    const fold = rowFold({ label: "Direct reports", value });
    expect(fold).toEqual({ folded: true, note: `${digits(value.length)} characters`, tail: tail(value) });
    const kept = fold.folded ? fold.tail ?? "" : "";
    expect(kept).toMatch(/^….*Dev299 will report to Manager\.$/);
    expect(kept.length).toBe(SHORT_FACT + 1);
  });

  it("keys on the labels the host really sends", () => {
    // A renamed label would fold a consequence to a size. The names are the
    // host's own statics, so they are read from its source.
    const facts = host.slice(host.indexOf("pub fn delete_facts"), host.indexOf("fn policy_lead"));
    for (const label of STRUCTURAL) expect(facts, label).toContain(`"${label}"`);
    expect(host).toContain(`const NO_HEAD: &str = "${noHead[0].toLowerCase()}${noHead.slice(1)}"`);
    expect(host).toContain(`const NO_FRONT_DESK: &str = "${noFrontDesk[0].toLowerCase()}${noFrontDesk.slice(1)}"`);
  });

  it("cuts a tail by length alone", () => {
    expect(tail("Dev will report to Potato.")).toBe("Dev will report to Potato.");
    expect(tail("abcdefghij", 4)).toBe("…ghij");
  });
});

describe("a text folded to its opening", () => {
  it("draws one short line whole", () => {
    expect(textFold("pnpm test")).toEqual({ whole: true });
    expect(textFold("x".repeat(SHORT_TEXT))).toEqual({ whole: true });
    expect(textFold("")).toEqual({ whole: true });
  });

  it("gives the first line and how many more there are", () => {
    expect(textFold("cd web\npnpm install\npnpm test")).toEqual({ whole: false, first: "cd web", rest: "2 more lines" });
    expect(textFold("a\nb")).toEqual({ whole: false, first: "a", rest: "1 more line" });
  });

  it("gives the length of one line too long to draw whole", () => {
    const line = "x".repeat(SHORT_TEXT + 1);
    expect(textFold(line)).toEqual({ whole: false, first: line, rest: "201 characters" });
  });

  it("opens on the first line that says something", () => {
    expect(textFold("\n\nrm -rf build\nls")).toEqual({ whole: false, first: "rm -rf build", rest: "1 more line" });
  });
});

describe("a diff as its counts", () => {
  it("names the file and both counts", () => {
    expect(diffLabel({ added: 12, removed: 3, path: "/repo/web/src/lib/chat.ts", kind: "edit" })).toBe("+12 −3 in chat.ts");
  });

  it("says a new file is one, and leaves out a count of nothing", () => {
    expect(diffLabel({ added: 46, removed: 0, path: "C:\\repo\\notes.md", kind: "create" })).toBe("+46 in notes.md · new file");
    expect(diffLabel({ added: 0, removed: 2, path: "a.ts", kind: "edit" })).toBe("−2 in a.ts");
    expect(diffLabel({ added: 0, removed: 0, path: "a.ts", kind: "edit" })).toBe("No lines changed in a.ts");
  });
});

describe("the other size labels", () => {
  it("counts a plan", () => {
    expect(planLabel(3, 2)).toBe("3 tasks in 2 stages");
    expect(planLabel(1, 1)).toBe("1 task in 1 stage");
  });

  it("lists a few names and counts the rest", () => {
    expect(nameList(["Ada", "Bo", "Ada", ""])).toBe("Ada, Bo");
    expect(nameList(["Ada", "Bo", "Cy", "Di", "Ed"])).toBe("Ada, Bo, Cy +2");
  });
});

describe("a detail opened", () => {
  it("is every character of a long text", () => {
    const text = "c".repeat(20_000);
    expect(capped(text)).toEqual({ shown: text, hidden: 0 });
  });

  it("stops only at the hard cap, and says exactly how much it left out", () => {
    const text = "c".repeat(HARD_CAP + 1234);
    const { shown, hidden } = capped(text);
    expect(shown.length).toBe(HARD_CAP);
    expect(hidden).toBe(1234);
    expect(cutNote(text.length, hidden)).toBe(
      "The first 200,000 of 201,234 characters are shown. 1,234 characters are not shown.",
    );
    expect(cutNote(HARD_CAP + 1, 1)).toBe("The first 200,000 of 200,001 characters are shown. 1 character is not shown.");
  });
});

describe("the fold of a card", () => {
  it("starts folded", () => {
    expect(foldStart("ask-1")).toEqual({ id: "ask-1", phase: "shut" });
    expect(foldIsOpen(foldPhase(foldStart("ask-1"), "ask-1"))).toBe(false);
  });

  it("opens on a press, and is open once its reveal has run", () => {
    const pressed = foldPressed(foldStart("ask-1"), "ask-1", false);
    expect(pressed).toEqual({ id: "ask-1", phase: "opening" });
    // Open from the press on: that is what `aria-expanded` says.
    expect(foldIsOpen(pressed.phase)).toBe(true);
    expect(foldSettled(pressed, "ask-1")).toEqual({ id: "ask-1", phase: "open" });
  });

  it("closes the same way, and a second press mid-way turns it round", () => {
    const open = { id: "ask-1", phase: "open" as const };
    const closing = foldPressed(open, "ask-1", false);
    expect(closing.phase).toBe("closing");
    expect(foldIsOpen(closing.phase)).toBe(false);
    expect(foldSettled(closing, "ask-1").phase).toBe("shut");
    expect(foldPressed(closing, "ask-1", false).phase).toBe("opening");
    expect(foldPressed({ id: "ask-1", phase: "opening" }, "ask-1", false).phase).toBe("closing");
  });

  it("runs nothing under reduced motion: it is simply open or shut", () => {
    expect(foldPressed(foldStart("ask-1"), "ask-1", true).phase).toBe("open");
    expect(foldPressed({ id: "ask-1", phase: "open" }, "ask-1", true).phase).toBe("shut");
  });

  it("stays open for the ask it was opened for, and for no other", () => {
    const open = { id: "ask-1", phase: "open" as const };
    expect(foldPhase(open, "ask-1")).toBe("open");
    // The next ask drawn in the same place is folded, and a press opens it.
    expect(foldPhase(open, "ask-2")).toBe("shut");
    expect(foldPressed(open, "ask-2", false)).toEqual({ id: "ask-2", phase: "opening" });
    // An animation that ends late is not the new ask's to settle.
    expect(foldSettled({ id: "ask-2", phase: "opening" }, "ask-1")).toEqual({ id: "ask-2", phase: "opening" });
  });

  it("is not moved by an animation end it was not waiting for", () => {
    const open = { id: "ask-1", phase: "open" as const };
    expect(foldSettled(open, "ask-1")).toBe(open);
  });
});

describe("the press that follows a press on a disclosure", () => {
  const fold = { x: 700, y: 300, at: 1000 };

  it("is a repeat when it lands in the same spot a moment later", () => {
    // A double click, or a press made again because nothing seemed to happen:
    // by now the page has moved, and what is under the pointer is not what
    // was pressed.
    expect(strayPress(fold, { x: 700, y: 300, at: 1120 })).toBe(true);
    expect(strayPress(fold, { x: 700 + STRAY_RADIUS, y: 300, at: 1000 + STRAY_MS })).toBe(true);
  });

  it("goes through once the pointer has moved: it was aimed", () => {
    expect(strayPress(fold, { x: 700 + STRAY_RADIUS + 1, y: 300, at: 1100 })).toBe(false);
    expect(strayPress(fold, { x: 640, y: 340, at: 1100 })).toBe(false);
  });

  it("goes through once the person has had time to see what is there", () => {
    expect(strayPress(fold, { x: 700, y: 300, at: 1000 + STRAY_MS + 1 })).toBe(false);
  });

  it("is nothing when no disclosure was pressed", () => {
    expect(strayPress(null, { x: 700, y: 300, at: 1100 })).toBe(false);
    // A clock that ran backwards is not a repeat either.
    expect(strayPress(fold, { x: 700, y: 300, at: 900 })).toBe(false);
  });

  it("outlasts the reveal it guards", () => {
    // `--enter-reveal-duration` is 200ms: the guard has to hold until the
    // page has stopped moving, with time left over to look.
    expect(STRAY_MS).toBeGreaterThanOrEqual(200 + 300);
  });
});

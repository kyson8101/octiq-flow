// What a folded card keeps and what it folds.
//
// The risk runs both ways. A part taken for short that is not gets cut on
// screen; a part folded without a label is approved unseen. And a consequence
// (the seat a removal empties, the reports it moves) must never fold to a
// size alone, whatever its length.
import { describe, expect, it } from "vitest";
// Loaded through Vite's `?raw`, not node:fs: this is a browser tsconfig.
import host from "../../../src-tauri/src/team_tools.rs?raw";
import { changeFacts, SUMMARY_MAX } from "./askDetail";
import {
  allowHeld, capped, chars, COMMAND_CHARS, COMMAND_LINES, commandFold, commandOpened, count, cutNote, diffLabel, digits,
  foldIsOpen, foldPhase, foldPressed, foldSettled, foldStart, HARD_CAP,
  isShort, lineCount, longRowsLabel, nameList, planFoldId, planLabel, scriptLabel, STRAY_MS, STRAY_RADIUS, strayPress,
  rowFold, SHORT_FACT, SHORT_TEXT, sizeLabel, STRUCTURAL, STRUCTURAL_WHOLE, textFold, textLines, unseenLines,
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

  it("counts characters, not the units they are stored in", () => {
    // The reviewer's two: 101 emoji read "202 characters", and one between
    // tabs read "2".
    expect("😀".length).toBe(2);
    expect(chars("😀")).toBe(1);
    expect(sizeLabel("😀".repeat(101))).toBe("101 characters");
    expect(sizeLabel("\t😀\t")).toBe("1 character");
    expect(chars("a😀b")).toBe(3);
    // Half a pair on its own is still something there.
    expect(chars("\ud83d")).toBe(1);
    expect(chars("\ude00\ude00")).toBe(2);
    expect(chars("")).toBe(0);
    // Sixty emoji are a short fact; sixty-one are not.
    expect(isShort("😀".repeat(SHORT_FACT))).toBe(true);
    expect(isShort("😀".repeat(SHORT_FACT + 1))).toBe(false);
    // Lines are lines whatever ends them, and whichever way the text reads.
    expect(sizeLabel("a\r\nb")).toBe("2 lines");
    expect(sizeLabel("مرحبا بالعالم")).toBe("13 characters");
    expect(sizeLabel("a\tb")).toBe("3 characters");
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

  it("says a folded move changes, and the size of both sides of it", () => {
    expect(rowFold({ label: "Role", before: "Writes notes.", after: "Owns the notes.\nNever invents a fix." }))
      .toEqual({ folded: true, note: "changed · 13 characters → 2 lines" });
    // Long before, short after: the short side must not pass for the change.
    expect(rowFold({ label: "Role", before: "a\nb\nc", after: "Notes." }))
      .toEqual({ folded: true, note: "changed · 3 lines → 6 characters" });
    // The reviewer's: 20,000 characters replaced by "OK" read "changed · 2 characters".
    expect(rowFold({ label: "Persistent prompt", before: "p".repeat(20_000), after: "OK" }))
      .toEqual({ folded: true, note: "changed · 20,000 characters → 2 characters" });
  });

  it("says a long text that is cleared is cleared, and how much it was", () => {
    expect(rowFold({ label: "Persistent prompt", before: "p".repeat(8000), after: "" }))
      .toEqual({ folded: true, note: "cleared · was 8,000 characters" });
  });

  it("puts the host's own line for a long value on the card, whole", () => {
    const summary = "300 direct reports will report to Potato Juice";
    expect(rowFold({ label: "Direct reports", value: "n".repeat(3627), summary }))
      .toEqual({ folded: true, note: "3,627 characters", summary });
    // A value short enough to draw is drawn; a line standing in for it is not wanted.
    expect(rowFold({ label: "Provider", value: "Codex", summary: "A provider" })).toEqual({ folded: false });
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

  it("folds a long list of reports to its size, and never to a piece of it", () => {
    // The reviewer's payload. The last sixty characters of it read as the
    // fact ("…Report 300 will report to Potato Juice.") and held no count;
    // under a long manager name they held nothing but x's.
    const names = Array.from({ length: 300 }, (_, i) => `Report ${String(i + 1).padStart(3, "0")}`).join(", ");
    for (const manager of ["Potato Juice", `Manager ${"x".repeat(100)}`]) {
      const value = `${names} will report to ${manager}.`;
      expect(value.length).toBeGreaterThan(STRUCTURAL_WHOLE);
      const fold = rowFold({ label: "Direct reports", value });
      expect(fold).toEqual({ folded: true, note: `${digits(value.length)} characters` });
      expect(JSON.stringify(fold)).not.toMatch(/Report|report|x{4}|…/);
    }
    expect(rowFold({ label: "Direct reports", value: `${names} will report to Potato Juice.` }))
      .toEqual({ folded: true, note: "3,627 characters" });
  });

  it("keys on the labels the host really sends", () => {
    // A renamed label would fold a consequence to a size. The names are the
    // host's own statics, so they are read from its source.
    const facts = host.slice(host.indexOf("pub fn delete_facts"), host.indexOf("fn policy_lead"));
    for (const label of STRUCTURAL) expect(facts, label).toContain(`"${label}"`);
    expect(host).toContain(`const NO_HEAD: &str = "${noHead[0].toLowerCase()}${noHead.slice(1)}"`);
    expect(host).toContain(`const NO_FRONT_DESK: &str = "${noFrontDesk[0].toLowerCase()}${noFrontDesk.slice(1)}"`);
  });

  it("holds a summary to the length the host holds it to", () => {
    // `team_tools::SUMMARY_MAX`, read from its source: a host that let a
    // summary grow would have every one of them dropped here.
    expect(host).toContain(`pub const SUMMARY_MAX: usize = ${SUMMARY_MAX};`);
    // And the host counts characters, as the page does.
    expect(host).toContain("summary.chars().count() <= SUMMARY_MAX");
  });

  describe("the removal card the host really sends", () => {
    // `team_tools::delete_facts` for an agent with 300 reports, as its own
    // test prints it (task K): ten rows, and the summary on one of them.
    const names = Array.from({ length: 300 }, (_, i) => `Report ${String(i).padStart(3, "0")}`).join(", ");
    const sent = (reports: Record<string, string>) => JSON.parse(JSON.stringify({
      lead: "Remove the agent Lead.",
      rows: [
        { label: "Role", value: "Writes code." }, { label: "Provider", value: "Claude" },
        { label: "Model", value: "sonnet" }, { label: "Effort", value: "high" }, { label: "Access", value: "auto" },
        { label: "Available in", value: "every project" }, { label: "Reports to", value: "Manager" },
        { label: "Team", value: "none" }, reports, { label: "Memory note", value: "Kept in the vault." },
      ],
    }));

    it("folds 300 reports to the host's count of them, whole, and the size of the names", () => {
      const value = `${names} will report to Manager.`;
      expect(value.length).toBe(3622);
      const facts = changeFacts(sent({ label: "Direct reports", value, summary: "300 direct reports will report to Manager" }));
      expect(facts?.rows).toHaveLength(10);
      const folds = facts!.rows.map((row) => rowFold(row));
      // One row folds, and what stays of it is the host's line and a size.
      expect(folds.filter((fold) => fold.folded)).toEqual([
        { folded: true, note: "3,622 characters", summary: "300 direct reports will report to Manager" },
      ]);
    });

    it("draws two reports as the sentence itself, which is short enough to be the fact", () => {
      const facts = changeFacts(sent({
        label: "Direct reports", value: "Report 000, Report 001 will report to Manager.",
        summary: "2 direct reports will report to Manager",
      }));
      expect(facts?.rows.map((row) => rowFold(row)).every((fold) => !fold.folded)).toBe(true);
    });

    it("takes a manager's name the host shortened to fit, as the host wrote it", () => {
      // 160 characters exactly, the name ending in the host's own "…".
      const counts = "300 direct reports will report to ";
      const summary = `${counts}${"M".repeat(SUMMARY_MAX - counts.length - 1)}…`;
      expect([...summary]).toHaveLength(SUMMARY_MAX);
      const value = `${names} will report to ${"M".repeat(400)}.`;
      const facts = changeFacts(sent({ label: "Direct reports", value, summary }));
      expect(rowFold(facts!.rows[8])).toEqual({ folded: true, note: `${digits(value.length)} characters`, summary });
    });
  });

});

describe("a command", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `step ${i + 1}`).join("\n");

  it("is on the folded card whole, up to twelve lines", () => {
    expect(commandFold("pnpm test")).toEqual({ lines: 1, head: "pnpm test", rest: "", more: 0 });
    // The reviewer's: the second line is the one that matters.
    const danger = 'echo "Routine check"\nrm -rf /tmp/example-review-data';
    expect(commandFold(danger)).toEqual({ lines: 2, head: danger, rest: "", more: 0 });
    expect(commandFold("pwd\ngit push origin main").head).toBe("pwd\ngit push origin main");
    expect(commandFold(lines(COMMAND_LINES))).toEqual({ lines: 12, head: lines(12), rest: "", more: 0 });
    expect(unseenLines(commandFold(lines(12)))).toBe("");
  });

  it("past twelve lines shows the first twelve whole and counts the rest", () => {
    const fold = commandFold(lines(13));
    expect(fold).toEqual({ lines: 13, head: lines(12), rest: "step 13", more: 1 });
    expect(unseenLines(fold)).toBe("1 more line not shown");
    const long = commandFold(lines(5000));
    expect(long.more).toBe(4988);
    expect(unseenLines(long)).toBe("4,988 more lines not shown");
    // Head and rest are the command, line for line.
    expect(`${long.head}\n${long.rest}`).toBe(lines(5000));
  });

  it("never cuts a line to make it fit", () => {
    // One line past what a card can hold: none of it is drawn folded.
    const one = "x".repeat(COMMAND_CHARS + 1);
    expect(commandFold(one)).toEqual({ lines: 1, head: "", rest: one, more: 1 });
    expect(unseenLines(commandFold(one))).toBe("1,201 characters not shown");
    expect(commandFold("x".repeat(COMMAND_CHARS)).more).toBe(0);
    // A short line, then a long one: the short one whole, the long one unseen
    // along with everything after it.
    const mixed = `echo ok\n${"y".repeat(5000)}\nrm -rf /`;
    expect(commandFold(mixed)).toEqual({ lines: 3, head: "echo ok", rest: `${"y".repeat(5000)}\nrm -rf /`, more: 2 });
    expect(unseenLines(commandFold(mixed))).toBe("2 more lines not shown");
    // Several lines with nothing drawn are counted as lines.
    expect(unseenLines(commandFold(`${one}\nls`))).toBe("2 lines not shown");
  });

  it("counts its lines without the blank ones at either end", () => {
    expect(commandFold("\n\npwd\nls\n\n")).toEqual({ lines: 2, head: "pwd\nls", rest: "", more: 0 });
  });

  it("is called a script once it has more than one line", () => {
    expect(scriptLabel(2)).toBe("2-line script");
    expect(scriptLabel(5000)).toBe("5,000-line script");
  });

  it("holds Allow back until a command the card does not show whole has been opened", () => {
    expect(allowHeld(commandFold(lines(13)), false)).toBe(true);
    // Opened once is enough, folded again or not.
    expect(allowHeld(commandFold(lines(13)), true)).toBe(false);
    // Whole on the card: nothing to open, nothing held.
    expect(allowHeld(commandFold(lines(12)), false)).toBe(false);
    expect(allowHeld(commandFold('echo "Routine check"\nrm -rf /tmp/example-review-data'), false)).toBe(false);
    // Not a command at all.
    expect(allowHeld(null, false)).toBe(false);
  });

  it("opens to every line it left out, up to the hard cap", () => {
    expect(commandOpened(commandFold(lines(13)))).toEqual({ rest: "step 13", hidden: 0, total: lines(13).length });
    const huge = commandFold(`echo start\n${"c".repeat(HARD_CAP + 77)}`);
    const opened = commandOpened(huge);
    expect(opened.total).toBe(HARD_CAP + 88);
    expect(opened.hidden).toBe(88);
    expect(opened.rest.length).toBe(HARD_CAP - 11);
  });
});

describe("the fold of a plan", () => {
  it("belongs to one revision of it", () => {
    // The reviewer's: revision 3 left open, revision 4 arrived open.
    const open = foldPressed(foldStart(planFoldId("run_1", 3)), planFoldId("run_1", 3), true);
    expect(foldIsOpen(foldPhase(open, planFoldId("run_1", 3)))).toBe(true);
    expect(foldIsOpen(foldPhase(open, planFoldId("run_1", 4)))).toBe(false);
    expect(planFoldId("run_1", undefined)).toBe("run_1:0");
    expect(planFoldId("run_1", 3)).not.toBe(planFoldId("run_13", undefined));
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

  it("lists names and counts the rest in words, never as a bare number", () => {
    expect(nameList(["Ada", "Bo", ""], 3, "agent")).toBe("Ada, Bo");
    expect(nameList(["Ada", "Bo", "Cy"], 3, "agent")).toBe("Ada, Bo, Cy");
    expect(nameList(["Ada", "Bo", "Cy", "Di"], 3, "agent")).toBe("Ada, Bo, Cy +1 more agent");
    expect(nameList(["Ada", "Bo", "Cy", "Di", "Ed"], 3, "destination")).toBe("Ada, Bo, Cy +2 more destinations");
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

  it("never stops in the middle of a character", () => {
    // Three emoji, room for two: the cut falls between characters.
    expect(capped("😀😀😀", 2)).toEqual({ shown: "😀😀", hidden: 1 });
    // A cut by units would have left half of the second one.
    expect(capped("a😀b", 2)).toEqual({ shown: "a😀", hidden: 1 });
    expect(capped("😀😀", 2)).toEqual({ shown: "😀😀", hidden: 0 });
    // More units than the cap, but not more characters: all of it.
    const emoji = "😀".repeat(HARD_CAP);
    expect(capped(emoji)).toEqual({ shown: emoji, hidden: 0 });
    const over = capped(`${emoji}😀x`);
    expect(over.hidden).toBe(2);
    expect(over.shown).toBe(emoji);
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

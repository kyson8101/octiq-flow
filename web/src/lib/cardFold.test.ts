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
import * as cardFold from "./cardFold";
import {
  allowHeld, chars, codeOf, COMMAND_CHARS, COMMAND_LINES, commandDrawn, commandFold, commandLines, commandOpens,
  hiddenIn, hiddenNote, lineFeedAfter, MARKS_MAX, marksInText, commandShown, commandTitle, count,
  diffLabel, digits, drawnChars, drawnWhole, sameCommand, type CommandAsked, foldIsOpen, foldPhase, foldPressed, foldSettled, foldStart,
  isShort, lineCount, longRowsLabel, nameList, notShown, planFoldId, planLabel, scriptLabel, STRAY_MS, STRAY_RADIUS,
  strayPress, rowFold, SHORT_FACT, SHORT_TEXT, sizeLabel, STRUCTURAL, STRUCTURAL_WHOLE, textFold, textLines, tooLong,
  tooLongNote, unseenLines, WHOLE_MAX,
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

/** The two labels of `STRUCTURAL` that a team card sends
 *  (`team_tools::team_rows`); the rest are a removal's. */
const TEAM_LABELS = ["Membership", "Other teams"];

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
    // A team card's two are sent by the function that builds its rows.
    const team = host.slice(host.indexOf("fn team_rows"), host.indexOf("pub const MEMBERSHIP_GRANTS"));
    expect(facts.length).toBeGreaterThan(100);
    expect(team.length).toBeGreaterThan(100);
    for (const label of STRUCTURAL) expect(TEAM_LABELS.includes(label) ? team : facts, label).toContain(`"${label}"`);
    for (const label of TEAM_LABELS) expect(STRUCTURAL.has(label), label).toBe(true);
    expect(host).toContain(`const NO_HEAD: &str = "${noHead[0].toLowerCase()}${noHead.slice(1)}"`);
    expect(host).toContain(`const NO_FRONT_DESK: &str = "${noFrontDesk[0].toLowerCase()}${noFrontDesk.slice(1)}"`);
  });

  describe("a team card", () => {
    // `team_tools::MEMBERSHIP_GRANTS`, read from the host's source: the one
    // sentence that closes every team card.
    const grants = /pub const MEMBERSHIP_GRANTS: &str = "([^"]+)";/.exec(host)?.[1] ?? "";

    it("draws what membership grants whole on every team card, never as a size", () => {
      expect(grants).toBe("Teammates may ask each other questions and request bounded work, and each request for work is approved separately.");
      // Longer than a short fact, which is why it folded to "114 characters".
      expect(grants.length).toBe(114);
      expect(grants.length).toBeGreaterThan(SHORT_FACT);
      expect(grants.length).toBeLessThanOrEqual(STRUCTURAL_WHOLE);
      expect(rowFold({ label: "Membership", value: grants })).toEqual({ folded: false });
      // Under any other name the same sentence is a long value.
      expect(rowFold({ label: "Role", value: grants })).toEqual({ folded: true, note: "114 characters" });
    });

    it("draws who leaves which team whole, up to the limit of a consequence", () => {
      // Two agents moving is already past a short fact (the host's own test).
      const two = "Ada leaves Web. Cy leaves Ops.";
      const several = "Ada leaves Web. Bo leaves Ops. Cy leaves Platform. Di leaves the Front desk team.";
      expect(several.length).toBeGreaterThan(SHORT_FACT);
      for (const value of [two, several]) expect(rowFold({ label: "Other teams", value })).toEqual({ folded: false });
    });

    it("folds a longer list of moves to its size, with the host's own line for it when it sends one", () => {
      const value = Array.from({ length: 12 }, (_, i) => `Agent ${i + 1} leaves Team ${i + 1}.`).join(" ");
      expect(value.length).toBeGreaterThan(STRUCTURAL_WHOLE);
      const size = `${digits(value.length)} characters`;
      // A host that sends no summary: the label and the size, never a piece.
      const bare = rowFold({ label: "Other teams", value });
      expect(bare).toEqual({ folded: true, note: size });
      expect(JSON.stringify(bare)).not.toMatch(/Agent|leaves/);
      // With one: the host's sentence whole, then the size.
      const summary = "12 agents leave their current teams";
      expect(rowFold({ label: "Other teams", value, summary })).toEqual({ folded: true, note: size, summary });
      // A summary beside a value that is drawn whole is not wanted.
      expect(rowFold({ label: "Other teams", value: "Bo leaves Ops.", summary: "1 agent leaves its current team" })).toEqual({ folded: false });
    });

    it("reads the rows of a changed team as the host sends them: nothing of it folds", () => {
      // `team_tools.rs`, the card its own test prints for two agents joining.
      const facts = changeFacts({
        lead: "Change the team Web.",
        rows: [
          { label: "Added", value: "Bo, Cy" },
          { label: "Members", before: "Ada", after: "Ada, Bo, Cy" },
          { label: "Other teams", value: "Bo leaves Ops. Cy leaves Platform. Di leaves the Front desk team.", summary: "3 agents leave their current teams" },
          { label: "Membership", value: grants },
        ],
      })!;
      expect(facts.rows.map((row) => rowFold(row).folded)).toEqual([false, false, false, false]);
      // A summary on a plain row is kept by the reader for when it is needed.
      expect(facts.rows[2]).toMatchObject({ label: "Other teams", summary: "3 agents leave their current teams" });
    });
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
    expect(commandFold("pnpm test")).toEqual({ lines: 1, size: 9, head: "pnpm test", rest: "", more: 0, drawn: 9, tooLong: false, ended: false });
    // The reviewer's: the second line is the one that matters.
    const danger = 'echo "Routine check"\nrm -rf /tmp/example-review-data';
    expect(commandFold(danger)).toMatchObject({ lines: 2, size: danger.length, head: danger, rest: "", more: 0 });
    expect(commandFold("pwd\ngit push origin main").head).toBe("pwd\ngit push origin main");
    expect(commandFold(lines(COMMAND_LINES))).toMatchObject({ lines: 12, head: lines(12), rest: "", more: 0 });
    expect(unseenLines(commandFold(lines(12)))).toBe("");
  });

  it("past twelve lines shows the first twelve whole and counts the rest", () => {
    const fold = commandFold(lines(13));
    expect(fold).toMatchObject({ lines: 13, size: lines(13).length, head: lines(12), rest: "step 13", more: 1 });
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
    expect(commandFold(one)).toMatchObject({ lines: 1, head: "", rest: one, more: 1 });
    expect(unseenLines(commandFold(one))).toBe("1,201 characters not shown");
    expect(commandFold("x".repeat(COMMAND_CHARS)).more).toBe(0);
    // A short line, then a long one: the short one whole, the long one unseen
    // along with everything after it.
    const mixed = `echo ok\n${"y".repeat(5000)}\nrm -rf /`;
    expect(commandFold(mixed)).toMatchObject({ lines: 3, head: "echo ok", rest: `${"y".repeat(5000)}\nrm -rf /`, more: 2 });
    expect(unseenLines(commandFold(mixed))).toBe("2 more lines not shown");
    // Several lines with nothing drawn are counted as lines.
    expect(unseenLines(commandFold(`${one}\nls`))).toBe("2 lines not shown");
  });

  it("counts its lines without the empty ones at either end", () => {
    expect(commandFold("\n\npwd\nls\n\n")).toMatchObject({ lines: 2, size: 6, head: "pwd\nls", rest: "", more: 0 });
    // Spaces and tabs are nothing to a shell either.
    expect(commandLines("\n \n\t\necho safe\n\n  \t\n")).toEqual(["echo safe"]);
    // One line stays one line, with its own title, whatever follows it.
    expect(commandTitle(commandFold("echo safe\n"))).toBeNull();
    // An empty line between two commands is between them: drawn, and counted.
    expect(commandLines("pwd\n\nls")).toEqual(["pwd", "", "ls"]);
    // Nothing is trimmed off a line that is kept.
    expect(commandLines("  pwd  \n\tls\t")).toEqual(["  pwd  ", "\tls\t"]);
    expect(commandLines("")).toEqual([]);
    expect(commandLines(" \n\t")).toEqual([]);
  });

  it("draws and counts a line that only looks empty: a no-break space is a word to a shell", () => {
    // The reviewer's: bash ran a program named U+00A0 from PATH, twice, while
    // the card drew `echo safe` and said nothing was off it.
    const nbsp = "\u00a0\necho safe\n\u00a0";
    const fold = commandFold(nbsp);
    expect(fold).toMatchObject({ lines: 3, size: 13, head: nbsp, rest: "", more: 0 });
    expect(commandLines(nbsp)).toEqual(["\u00a0", "echo safe", "\u00a0"]);
    // It is a script of three lines, and no longer `bash(echo)`.
    expect(commandTitle(fold)).toBe("3-line script");
    expect(notShown(fold, commandShown(fold, false))).toBe(0);
    // Every other space JavaScript trims and a shell does not.
    for (const space of ["\u1680", "\u2000", "\u2003", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", "\u000b", "\u000c"]) {
      expect(space.trim()).toBe("");
      expect(commandLines(`${space}\npwd\n${space}`)).toEqual([space, "pwd", space]);
      expect(commandFold(`pwd\n${space}`).lines).toBe(2);
    }
  });

  it("draws and counts a line holding a lone carriage return", () => {
    expect(commandLines("\r\necho safe\n\r")).toEqual(["\r", "echo safe", "\r"]);
    expect(commandFold("\r\necho safe\n\r")).toMatchObject({ lines: 3, size: 13, more: 0 });
    // Windows line ends: the return stays on its line, and the last line end
    // leaves no line behind it.
    expect(commandLines("pwd\r\nls\r\n")).toEqual(["pwd\r", "ls\r"]);
    // An empty line in Windows line ends is a return: kept.
    expect(commandLines("pwd\r\n\r\n")).toEqual(["pwd\r", "\r"]);
  });

  it("never drops a character of a line it cannot draw folded", () => {
    // Thirteen lines, the last a no-break space: held, and counted as unshown.
    const fold = commandFold(`${lines(12)}\n\u00a0`);
    expect(fold).toMatchObject({ lines: 13, more: 1, rest: "\u00a0" });
    expect(notShown(fold, commandShown(fold, false))).toBe(2);
    expect(notShown(fold, commandShown(fold, true))).toBe(0);
    expect(unseenLines(fold)).toBe("1 more line not shown");
  });

  it("is called a script once it has more than one line", () => {
    expect(scriptLabel(2)).toBe("2-line script");
    expect(scriptLabel(5000)).toBe("5,000-line script");
  });

  it("on one line it cannot draw is called by its size, never by its first command", () => {
    // `echo <base64> | base64 -d | sh`: `bash(echo)` named the harmless end.
    const piped = `echo ${"A".repeat(4990)} | base64 -d | sh`;
    expect(chars(piped)).toBe(5012);
    expect(commandTitle(commandFold(piped))).toBe("5,012-character command");
    expect(commandTitle(commandFold(piped), "script")).toBe("5,012-character script");
    // Whole on one line of the card: the tool's own title is kept.
    expect(commandTitle(commandFold("echo safe; rm -rf /tmp/review-danger"))).toBeNull();
    expect(commandTitle(commandFold("x".repeat(COMMAND_CHARS)))).toBeNull();
    expect(commandTitle(commandFold("x".repeat(COMMAND_CHARS + 1)))).toBe("1,201-character command");
    // Several lines are a script whether or not they all fit.
    expect(commandTitle(commandFold(lines(2)))).toBe("2-line script");
    expect(commandTitle(commandFold(lines(13)), "script")).toBe("13-line script");
  });

  // The reviewer's: 4,999 harmless lines, then the one that matters.
  const reviewer = Array.from({ length: 5000 }, (_, i) => i === 4999 ? "rm -rf /tmp/review-danger" : "echo safe " + "x".repeat(55)).join("\n");

  it("opens to every line it left out: there is no cut", () => {
    const fold = commandFold(lines(13));
    expect(commandShown(fold, false)).toEqual({ head: lines(12), rest: null });
    expect(commandShown(fold, true)).toEqual({ head: lines(12), rest: "step 13" });
    // 329,959 characters, past the 200,000 the card used to stop at.
    expect(reviewer).toHaveLength(329_959);
    const big = commandFold(reviewer);
    expect(big).toMatchObject({ lines: 5000, size: 329_959, more: 4988, tooLong: false });
    expect(commandOpens(big)).toBe(true);
    const opened = commandShown(big, true);
    expect(`${opened.head}\n${opened.rest}`).toBe(reviewer);
    expect(opened.rest!.endsWith("\nrm -rf /tmp/review-danger")).toBe(true);
    expect(notShown(big, opened)).toBe(0);
    // 2,000,000 characters on one line: still all of it.
    const one = commandFold("c".repeat(2_000_000));
    expect(commandShown(one, true)).toEqual({ head: "", rest: "c".repeat(2_000_000) });
    expect(notShown(one, commandShown(one, true))).toBe(0);
  });

  it("counts what the card does not draw from what it draws", () => {
    const fold = commandFold(lines(13));
    // Folded: the thirteenth line and the break before it.
    expect(notShown(fold, commandShown(fold, false))).toBe("\nstep 13".length);
    expect(notShown(fold, commandShown(fold, true))).toBe(0);
    // Whole on the folded card: nothing unshown, opened or not.
    const short = commandFold('echo "Routine check"\nrm -rf /tmp/example-review-data');
    expect(notShown(short, commandShown(short, false))).toBe(0);
    // Nothing of a long single line is on the folded card.
    const one = commandFold("x".repeat(5000));
    expect(notShown(one, commandShown(one, false))).toBe(5000);
    const big = commandFold(reviewer);
    expect(notShown(big, commandShown(big, false))).toBe(329_959 - chars(big.head));
  });

  it("is not whole when an opening draws less than all of it, whatever was pressed", () => {
    // What the card did before: opened, the first 200,000 characters, and
    // Allow let go. Asked of what is drawn, that is 129,959 short.
    const big = commandFold(reviewer);
    const cut = { head: big.head, rest: big.rest.slice(0, 200_000 - big.head.length - 1) };
    expect(notShown(big, cut)).toBe(129_959);
    expect(allowHeld(notShown(big, cut), null, { id: "a", tool: "Bash", key: "command", text: reviewer })).toBe(true);
    // One character short is short.
    expect(notShown(big, { head: big.head, rest: big.rest.slice(0, -1) })).toBe(1);
    // Another text of the same length is not the command either.
    expect(notShown(big, { head: big.head, rest: "y".repeat(big.rest.length) })).toBeGreaterThan(0);
    // Nor is the rest without the lines above it.
    expect(notShown(big, { head: "", rest: big.rest })).toBeGreaterThan(0);
  });

  /** One card, as `PermissionAsk` keeps it: each draw says whether Allow is
   *  held for what it drew, then remembers a command it drew whole. */
  const card = () => {
    let whole: CommandAsked | null = null;
    return (asked: CommandAsked, open = false): boolean => {
      const fold = commandFold(asked.text);
      const unshown = notShown(fold, commandShown(fold, open));
      const held = allowHeld(unshown, whole, asked);
      whole = drawnWhole(whole, asked, unshown);
      return held;
    };
  };
  const bash = (id: string, text: string): CommandAsked => ({ id, tool: "Bash", key: "command", text });
  const safe = lines(13);
  const danger = `${lines(12)}\nrm -rf /tmp/review-danger`;

  it("holds Allow back while anything of the command has never been shown", () => {
    const draw = card();
    expect(draw(bash("a", safe))).toBe(true);
    expect(draw(bash("a", safe), true)).toBe(false);
    // Shown whole once is enough: folded again, it is still allowed.
    expect(draw(bash("a", safe))).toBe(false);
    // Whole on the card: nothing to open, nothing held.
    expect(card()(bash("b", lines(12)))).toBe(false);
    // The reviewer's: held folded, let go only with the last line drawn.
    const big = card();
    expect(big(bash("c", reviewer))).toBe(true);
    expect(big(bash("c", reviewer), true)).toBe(false);
    expect(big(bash("c", reviewer))).toBe(false);
  });

  it("is shown whole as that text, not as that ask: a short command, then a long one under its id", () => {
    const draw = card();
    // Whole on the card at once; nothing was opened.
    expect(draw(bash("dynamic", "echo safe"))).toBe(false);
    // The same id, thirteen lines, the last of them not on the folded card.
    expect(draw(bash("dynamic", danger))).toBe(true);
    expect(draw(bash("dynamic", danger))).toBe(true);
    expect(draw(bash("dynamic", danger), true)).toBe(false);
  });

  it("is unread again when a command opened and folded is replaced under the same id", () => {
    const draw = card();
    expect(draw(bash("same", safe), true)).toBe(false);
    expect(draw(bash("same", safe))).toBe(false);
    expect(draw(bash("same", danger))).toBe(true);
  });

  it("is unread when an id read before comes back with another command", () => {
    const draw = card();
    expect(draw(bash("a", safe), true)).toBe(false);
    // Another ask, long and never opened.
    expect(draw(bash("b", lines(40)))).toBe(true);
    expect(draw(bash("a", danger))).toBe(true);
    // And the unread one in between let nothing go either.
    expect(draw(bash("b", lines(40)))).toBe(true);
  });

  it("keeps Allow for the very same command sent again, and for no other", () => {
    const draw = card();
    draw(bash("a", safe), true);
    // The same ask again, as `PendingRequests.add` replaces it: a new object,
    // the same content.
    expect(draw(bash("a", `${safe}`))).toBe(false);
    // One character more, one less, one changed.
    expect(draw(bash("a", `${safe} `))).toBe(true);
    draw(bash("a", safe), true);
    expect(draw(bash("a", safe.slice(0, -1)))).toBe(true);
    draw(bash("a", safe), true);
    expect(draw(bash("a", safe.replace("step 13", "step 31")))).toBe(true);
    // A blank line the card does not draw is still a different text.
    draw(bash("a", safe), true);
    expect(draw(bash("a", `${safe}\n`))).toBe(true);
    // The same text under a new id, another tool, or another argument.
    draw(bash("a", safe), true);
    expect(draw(bash("new", safe))).toBe(true);
    draw(bash("a", safe), true);
    expect(draw({ ...bash("a", safe), tool: "mcp__x__run" })).toBe(true);
    draw(bash("a", safe), true);
    expect(draw({ ...bash("a", safe), key: "script" })).toBe(true);
  });

  it("remembers the command it drew whole, and nothing when it drew less", () => {
    const a = bash("a", safe);
    expect(drawnWhole(null, a, 7)).toBeNull();
    expect(drawnWhole(null, a, 0)).toBe(a);
    // Drawing less of another command does not forget the one that was read.
    expect(drawnWhole(a, bash("a", danger), 25)).toBe(a);
    expect(sameCommand(a, bash("a", safe))).toBe(true);
    expect(sameCommand(a, null)).toBe(false);
    expect(sameCommand(null, null)).toBe(false);
  });

  it("past what the page draws is never opened, and never allowed", () => {
    const line = "echo safe " + "x".repeat(55);
    const over = commandFold(`${(line + "\n").repeat(Math.ceil(WHOLE_MAX / 66))}rm -rf /tmp/review-danger`);
    expect(over.size).toBeGreaterThan(WHOLE_MAX);
    expect(over.tooLong).toBe(true);
    // There is nothing that says "Open the full command", because nothing would.
    expect(commandOpens(over)).toBe(false);
    // Asked to open anyway, it draws no more than the folded card.
    expect(commandShown(over, true)).toEqual({ head: over.head, rest: null });
    expect(notShown(over, commandShown(over, true))).toBe(over.size - chars(over.head));
    // Opened or not, and whatever the card remembers: it was never whole.
    const asked = { id: "a", tool: "Bash", key: "command", text: `${(line + "\n").repeat(Math.ceil(WHOLE_MAX / 66))}rm -rf /tmp/review-danger` };
    expect(allowHeld(notShown(over, commandShown(over, true)), null, asked)).toBe(true);
    expect(drawnWhole(null, asked, notShown(over, commandShown(over, true)))).toBeNull();
    expect(unseenLines(over)).toBe(`${digits(over.lines - 12)} more lines not shown`);
    // Exactly at the limit is drawn.
    expect(commandFold("c".repeat(WHOLE_MAX)).tooLong).toBe(false);
    expect(commandFold("c".repeat(WHOLE_MAX + 1)).tooLong).toBe(true);
  });
});

describe("a character of a command that cannot be seen as typed", () => {
  const mark = (hex: string) => ({ code: `\\u{${hex}}` });
  // The marks that set reading order.
  const BIDI = ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069", "\u200E", "\u200F", "\u061C"];
  // The ones that draw nothing, and the two separators a shell does not break a line on.
  const UNSEEN = ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF", "\u00AD", "\u2028", "\u2029"];
  const NBSP = "\u00A0";

  it("draws a command with none exactly as it was written", () => {
    for (const text of ["pnpm test", 'echo "a\tb"  && ls\r\nls -la', "git commit -m 'café 中文 😀'", "printf '\\u{202E}'", ""]) {
      const drawn = commandDrawn(text);
      expect(drawn).toEqual([text]);
      expect(drawn[0]).toBe(text);
      expect(hiddenIn(text)).toEqual({ count: 0, example: "" });
    }
  });

  it("draws each mark that sets reading order as its code, where it stands", () => {
    for (const char of BIDI) {
      const hex = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
      expect(commandDrawn(`a${char}b`)).toEqual(["a", mark(hex), "b"]);
      expect(hiddenIn(`a${char}b`)).toEqual({ count: 1, example: `\\u{${hex}}` });
    }
    expect(codeOf("\u202E")).toBe("\\u{202E}");
    expect(codeOf("\u061C")).toBe("\\u{061C}");
    // The override that makes `invoice_exe.pdf` of this: seen as what runs.
    expect(commandDrawn("open invoice_\u202Efdp.exe")).toEqual(["open invoice_", mark("202E"), "fdp.exe"]);
  });

  it("draws each character that draws nothing as its code", () => {
    for (const char of UNSEEN) {
      const hex = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
      expect(commandDrawn(`a${char}b`)).toEqual(["a", mark(hex), "b"]);
    }
    expect(commandDrawn("curl exam\u200Bple.com")).toEqual(["curl exam", mark("200B"), "ple.com"]);
    expect(codeOf("\uFEFF")).toBe("\\u{FEFF}");
    expect(codeOf("\u00AD")).toBe("\\u{00AD}");
  });

  it("draws a no-break space as its code: it is not a space to a shell", () => {
    expect(commandDrawn(`echo${NBSP}done`)).toEqual(["echo", mark("00A0"), "done"]);
    expect(commandDrawn(`${NBSP}\necho safe\n${NBSP}`)).toEqual([mark("00A0"), "\necho safe\n", mark("00A0")]);
  });

  it("keeps every one of them, in order, at either end and side by side", () => {
    expect(commandDrawn("\u200B\u200Bls\u202E")).toEqual([mark("200B"), mark("200B"), "ls", mark("202E")]);
    expect(commandDrawn("\u2066")).toEqual([mark("2066")]);
    // What is left between the marks is the command, character for character.
    const text = `rm\u2060 -rf\uFEFF /tmp/x\u00AD\necho a\u2028echo b\u2029echo c${NBSP}`;
    const drawn = commandDrawn(text);
    expect(drawn.filter((part) => typeof part !== "string")).toHaveLength(6);
    expect(drawn.filter((part) => typeof part === "string").join("")).toBe("rm -rf /tmp/x\necho aecho becho c");
  });

  it("draws every other character as written", () => {
    // A space and a tab, a combining accent, an emoji, and CJK text with the
    // ideographic space it is ordinarily written with.
    for (const text of ["a b", "a\tb", "a\u0301b", "\ud83d\udc68\ud83c\udffd", "git commit -m \"\u4fee\u590d\u3000\u767b\u5f55\"", "\u3053\u3093\u306b\u3061\u306f\u3000\u4e16\u754c", "\ud55c\uad6d\uc5b4\u3000\ud14d\uc2a4\ud2b8"]) {
      expect(commandDrawn(text)).toEqual([text]);
      expect(hiddenIn(text).count).toBe(0);
    }
  });

  it("draws the characters that were left unmarked before: they draw nothing at all", () => {
    // The invisible operators, the deprecated format characters, the
    // Mongolian vowel separator and the Hangul fillers.
    for (const point of [0x2061, 0x2062, 0x2063, 0x2064, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0x180e, 0x115f, 0x1160, 0x3164, 0xffa0]) {
      const code = point.toString(16).toUpperCase().padStart(4, "0");
      expect(commandDrawn(`a${String.fromCodePoint(point)}b`), code).toEqual(["a", mark(code), "b"]);
    }
    // U+2065 is not a character, and is left alone.
    expect(commandDrawn("a\u2065b")).toEqual(["a\u2065b"]);
    // Tag characters, which spell out text nobody sees: each is one
    // character and one code, five digits, in place.
    const tags = [..."rm -rf ~"].map((char) => String.fromCodePoint(0xe0000 + char.codePointAt(0)!)).join("");
    const drawn = commandDrawn(`echo ok${tags}`);
    expect(drawn[0]).toBe("echo ok");
    expect(drawn.slice(1)).toEqual([..."rm -rf ~"].map((char) => mark(`E00${char.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0")}`)));
    expect(hiddenIn(`echo ok${tags}`)).toEqual({ count: 8, example: "\\u{E0072}" });
    for (const point of [0xe0001, 0xe0020, 0xe007f]) {
      expect(commandDrawn(String.fromCodePoint(point))).toEqual([mark(point.toString(16).toUpperCase())]);
    }
    // The first of that block is not one of them, and an emoji beside them
    // keeps both halves.
    expect(commandDrawn(String.fromCodePoint(0xe0000))).toEqual([String.fromCodePoint(0xe0000)]);
    expect(commandDrawn(`\ud83d\ude00${String.fromCodePoint(0xe0041)}\ud83d\ude00`)).toEqual(["\ud83d\ude00", mark("E0041"), "\ud83d\ude00"]);
  });

  it("draws a wider space as its code, unless it stands between two CJK characters", () => {
    const WIDE = [0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000];
    for (const point of WIDE) {
      const char = String.fromCodePoint(point);
      const code = point.toString(16).toUpperCase();
      // Between Latin words it is a gap that is not a space to a shell.
      expect(commandDrawn(`rm -rf a${char}b`), code).toEqual(["rm -rf a", mark(code), "b"]);
      // Between CJK characters it is how the text is written.
      expect(commandDrawn(`\u4f60\u597d${char}\u4e16\u754c`), code).toEqual([`\u4f60\u597d${char}\u4e16\u754c`]);
    }
    const IDEO = "\u3000";
    // CJK on one side only is not "between": the start of a line, a quote, a
    // Latin word, the end.
    expect(commandDrawn(`echo${IDEO}\u4f60\u597d`)).toEqual(["echo", mark("3000"), "\u4f60\u597d"]);
    expect(commandDrawn(`\u4f60\u597d${IDEO}"world"`)).toEqual(["\u4f60\u597d", mark("3000"), "\"world\""]);
    expect(commandDrawn(`${IDEO}\u4f60\u597d`)).toEqual([mark("3000"), "\u4f60\u597d"]);
    expect(commandDrawn(`\u4f60\u597d${IDEO}`)).toEqual(["\u4f60\u597d", mark("3000")]);
    expect(commandDrawn(`\u4f60\u597d${IDEO}\n\u4e16\u754c`)).toEqual(["\u4f60\u597d", mark("3000"), "\n\u4e16\u754c"]);
    // A run of them is judged by what is on either side of the run.
    expect(commandDrawn(`\u4f60\u597d${IDEO}${IDEO}\u2003\u4e16\u754c`)).toEqual([`\u4f60\u597d${IDEO}${IDEO}\u2003\u4e16\u754c`]);
    expect(commandDrawn(`a${IDEO}${IDEO}\u4e16\u754c`)).toEqual(["a", mark("3000"), mark("3000"), "\u4e16\u754c"]);
    // CJK punctuation, kana and full-width forms count as CJK; an ASCII
    // comma does not.
    expect(commandDrawn(`\u4f60\u597d\uff0c${IDEO}\u4e16\u754c`)).toEqual([`\u4f60\u597d\uff0c${IDEO}\u4e16\u754c`]);
    expect(commandDrawn(`\u30ab\u30bf\u30ab\u30ca${IDEO}\u3072\u3089\u304c\u306a`)).toEqual([`\u30ab\u30bf\u30ab\u30ca${IDEO}\u3072\u3089\u304c\u306a`]);
    expect(commandDrawn(`\u4f60\u597d,${IDEO}\u4e16\u754c`)).toEqual(["\u4f60\u597d,", mark("3000"), "\u4e16\u754c"]);
    // The reviewer's point of it: one path or two.
    expect(hiddenIn(`rm -rf /srv/a${IDEO}/srv/b`)).toEqual({ count: 1, example: "\\u{3000}" });
    // A hidden character beside one does not make it CJK.
    expect(commandDrawn(`\u4f60\u597d\u200b${IDEO}\u4e16\u754c`)).toEqual(["\u4f60\u597d", mark("200B"), mark("3000"), "\u4e16\u754c"]);
  });

  it("draws a control character as its code: an escape, a backspace, a delete", () => {
    expect(commandDrawn("echo ok\u001b[2K")).toEqual(["echo ok", mark("001B"), "[2K"]);
    // Backspaces: a terminal draws what follows over what came before them.
    expect(commandDrawn("rm -rf ~\u0008\u0008\u0008/tmp/x")).toEqual(["rm -rf ~", mark("0008"), mark("0008"), mark("0008"), "/tmp/x"]);
    expect(commandDrawn("a\u007fb")).toEqual(["a", mark("007F"), "b"]);
    // Every one of them but the tab and the two that end a line.
    for (let code = 0; code < 0x20; code += 1) {
      const char = String.fromCharCode(code);
      const drawn = commandDrawn(`a${char}b`);
      if (code === 0x09 || code === 0x0a) expect(drawn).toEqual([`a${char}b`]);
      else expect(drawn).toEqual(["a", mark(code.toString(16).toUpperCase().padStart(4, "0")), "b"]);
    }
    expect(hiddenIn("\u001b\u0008\u007f")).toEqual({ count: 3, example: "\\u{001B}" });
  });

  it("marks a carriage return that stands alone, and leaves a Windows line end as it is", () => {
    // Alone: in a line, at the end of the text, before another return.
    expect(commandDrawn("a\rb")).toEqual(["a", mark("000D"), "b"]);
    expect(commandDrawn("a\r")).toEqual(["a", mark("000D")]);
    expect(commandDrawn("a\r\r\nb")).toEqual(["a", mark("000D"), "\r\nb"]);
    // With its line feed it is a line end: no mark at the end of every line.
    expect(commandDrawn("pwd\r\nls\r\nwhoami")).toEqual(["pwd\r\nls\r\nwhoami"]);
    expect(hiddenIn("pwd\r\nls\r\n")).toEqual({ count: 0, example: "" });
    expect(hiddenIn("\r\necho safe\n\r")).toEqual({ count: 1, example: "\\u{000D}" });
    // The part of a command a card draws stops before the line feed that
    // follows it. Told that one does, a return at its end is a line end and
    // is drawn with it; told nothing, it is alone.
    expect(commandDrawn("pwd\r", true)).toEqual(["pwd\r\n"]);
    expect(commandDrawn("pwd\r", false)).toEqual(["pwd", mark("000D")]);
    expect(commandDrawn("pwd", true)).toEqual(["pwd"]);
  });

  /** The rows a browser draws for a text in a `pre`: one a line, a line feed
   *  at the very end adding none. (Measured in Chromium and WebKit; a
   *  carriage return alone on the last line gets no row in Chromium, which
   *  is why none is ever drawn there unmarked.) */
  const rows = (parts: ReturnType<typeof commandDrawn>): number => {
    const text = parts.map((part) => (typeof part === "string" ? part : "<mark>")).join("");
    // No return is left to stand unmarked without its line feed.
    expect(text).not.toMatch(/\r(?!\n)/);
    if (text === "") return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  };

  it("draws as many rows as the lines it states, for any mix of line ends", () => {
    const mixes = [
      "\r\necho safe\n\r", "\r", "\r\n", "a\n\r\n", "a\n\r", "a\r\n\r\nb", "a\r\rb", "pwd\r\nls\r\n", "pwd\r\nls\r",
      "a\n\nb\n", "\n\r\n\r\n\n", "a\rb\r\nc\n\rd", "\r\r\r", "a\r\n \n\t\n", "a\n\u001b\n\u0008", "x\r\n".repeat(13), "x\n".repeat(12) + "\r\n", "x\n".repeat(12) + "\r",
    ];
    for (const text of mixes) {
      const fold = commandFold(text);
      const feeds = lineFeedAfter(fold);
      // Folded and whole on the card, or opened: the head and the rest.
      const shown = commandShown(fold, true);
      const drawn = rows(commandDrawn(shown.head, feeds.head)) + (shown.rest === null ? 0 : rows(commandDrawn(shown.rest, feeds.rest)));
      expect(drawn, JSON.stringify(text)).toBe(fold.lines);
      // And the folded card draws a row for each line of its head.
      const head = fold.head === "" ? 0 : fold.head.split("\n").length;
      expect(rows(commandDrawn(fold.head, feeds.head)), JSON.stringify(text)).toBe(head);
    }
    // The coordinator's case: an empty first line, `echo safe`, and a third
    // row that shows the return.
    const fold = commandFold("\r\necho safe\n\r");
    expect(fold.lines).toBe(3);
    expect(commandDrawn(fold.head, lineFeedAfter(fold).head)).toEqual(["\r\necho safe\n", mark("000D")]);
    // A Windows-ended script: a line feed follows its last line, and its
    // last return is drawn with it.
    const windows = commandFold("pwd\r\nls\r\n");
    expect(windows).toMatchObject({ lines: 2, head: "pwd\r\nls\r", ended: true });
    expect(lineFeedAfter(windows)).toEqual({ head: true, rest: true });
    expect(commandDrawn(windows.head, true)).toEqual(["pwd\r\nls\r\n"]);
    expect(commandFold("pwd\nls")).toMatchObject({ ended: false });
    expect(lineFeedAfter(commandFold("x\n".repeat(13) + "y"))).toEqual({ head: true, rest: false });
  });

  it("counts them in the whole command and names the first", () => {
    expect(hiddenIn(`${NBSP}\necho safe\n${NBSP}`)).toEqual({ count: 2, example: "\\u{00A0}" });
    expect(hiddenIn("a\u202Eb\u200Bc\u00A0")).toEqual({ count: 3, example: "\\u{202E}" });
    expect(hiddenNote(1)).toEqual({ count: "1 character that cannot be seen as typed", rest: " is in this command, drawn as its code: " });
    expect(hiddenNote(3)).toEqual({ count: "3 characters that cannot be seen as typed", rest: " are in this command, each drawn as its code, like " });
    expect(hiddenNote(MARKS_MAX, "script")).toEqual({
      count: "5,000 characters that cannot be seen as typed", rest: " are in this script, each drawn as its code, like ",
    });
    // Past the marks a card sets apart, the line says how the codes are
    // drawn and what keeps one from being imitated.
    expect(hiddenNote(12_345, "script")).toEqual({
      count: "12,345 characters that cannot be seen as typed", rest: " are in this script, each written into it as its code, like ",
      after: ". A backslash typed before u{ is written as \\u{005C}, so a code here is never text that was typed.",
    });
  });

  it("changes the drawing only: the command, its size and what is unshown are the text itself", () => {
    const text = "open invoice_\u202Efdp.exe";
    const fold = commandFold(text);
    expect(fold.head).toBe(text);
    expect(fold.size).toBe(text.length);
    expect(notShown(fold, commandShown(fold, false))).toBe(0);
    // A code drawn in place of one character is not counted as eight.
    expect(commandFold(`${"x".repeat(COMMAND_CHARS - 1)}\u200B`).more).toBe(0);
  });

  it("past the marks a card sets apart, writes the codes into the text, still in place and counted", () => {
    const some = "a\u200B".repeat(MARKS_MAX);
    expect(commandDrawn(some)).toHaveLength(MARKS_MAX * 2);
    const many = "a\u200B".repeat(MARKS_MAX + 1);
    expect(commandDrawn(many)).toEqual(["a\\u{200B}".repeat(MARKS_MAX + 1)]);
    expect(hiddenIn(many).count).toBe(MARKS_MAX + 1);
    expect(marksInText(MARKS_MAX)).toBe(false);
    expect(marksInText(MARKS_MAX + 1)).toBe(true);
  });

  it("keeps a code written into the text apart from the same characters typed into the command", () => {
    const real = "\u200B";
    const typed = "\\u{200B}";
    const many = `echo ${real}`.repeat(MARKS_MAX + 1);
    // The attack: a code typed out beside the real ones, so the eye cannot
    // tell which stretch of the command is a hidden character.
    const [drawn] = commandDrawn(`${many}curl evil${typed}.sh${real}`) as string[];
    expect(drawn.endsWith("curl evil\\u{005C}u{200B}.sh\\u{200B}")).toBe(true);
    // What is drawn has one reading: undo it and the command comes back,
    // character for character.
    const undo = (text: string) => text.replace(/\\u\{([0-9A-F]{4,6})\}/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
    const command = `${many}printf '${typed}' \\n \\\\u{41} C:\\users\\u{x}${real}\u202E${String.fromCodePoint(0xe0041)}`;
    expect(undo((commandDrawn(command) as string[])[0])).toBe(command);
    // Only a backslash that could start a code is written as one: every
    // other backslash is as typed.
    expect((commandDrawn(`${many}a\\nb\\u0041\\\\`) as string[])[0].endsWith("a\\nb\\u0041\\\\")).toBe(true);
    // A typed code is not counted as a hidden character.
    expect(hiddenIn(`${many}${typed}`).count).toBe(MARKS_MAX + 1);

    // Up to the marks a card sets apart, a real one is an element of its own
    // and a typed one is text: the drawing tells them apart, and nothing is
    // rewritten.
    expect(commandDrawn(`a${real}b${typed}c`)).toEqual(["a", mark("200B"), `b${typed}c`]);
  });

  it("writes both texts of one command the same way, as the card says under them", () => {
    // The folded head holds few of them; the command holds too many to set
    // apart. The card decides once and both texts follow.
    expect(commandDrawn(`a\u200Bb\\u{200B}`, false, true)).toEqual(["a\\u{200B}b\\u{005C}u{200B}"]);
    expect(commandDrawn("plain \\u{41}", false, true)).toEqual(["plain \\u{005C}u{41}"]);
    expect(commandDrawn("plain", false, true)).toEqual(["plain"]);
    expect(commandDrawn(`a\u200Bb`, false, false)).toEqual(["a", mark("200B"), "b"]);
  });
});

describe("what a command is as drawn", () => {
  const ZERO_WIDTH = String.fromCharCode(0x200b);

  it("counts a code for the character it stands for, and only where it could matter", () => {
    // Short enough that no drawing of it could pass the bound: its own size.
    expect(drawnChars("a\u200Bb")).toBe(3);
    const hidden = "\u200B".repeat(700_000);
    expect(chars(hidden)).toBe(700_000);
    expect(drawnChars(hidden)).toBe(700_000 * 8);
    // A pair is one character, and its code is nine.
    const tags = String.fromCodePoint(0xe0041).repeat(400_000);
    expect(chars(tags)).toBe(400_000);
    expect(drawnChars(tags)).toBe(400_000 * 9);
    // Where the codes are written into the text, so is each backslash that
    // is written as one.
    const typed = `${"\\u{41}".repeat(100_000)}${"\u200B".repeat(MARKS_MAX + 1)}${"x".repeat(100_000)}`;
    expect(drawnChars(typed)).toBe(chars(typed) + (MARKS_MAX + 1) * 7 + 100_000 * 7);
    // Plain text of the same length is itself.
    expect(drawnChars("x".repeat(700_000))).toBe(700_000);
  });

  it("bounds what is drawn, not what is sent: past it the command is not opened and cannot be allowed", () => {
    // The reviewer's command: within the limit by its own length, eight
    // times that as drawn.
    const hidden = "\u200B".repeat(WHOLE_MAX);
    expect(tooLong(hidden)).toBe(false);
    const fold = commandFold(hidden);
    expect(fold).toMatchObject({ size: WHOLE_MAX, drawn: WHOLE_MAX * 8, tooLong: true, head: "", more: 1 });
    expect(commandOpens(fold)).toBe(false);
    const shown = commandShown(fold, true);
    expect(shown).toEqual({ head: "", rest: null });
    const unshown = notShown(fold, shown);
    expect(unshown).toBeGreaterThan(0);
    expect(allowHeld(unshown, null, { id: "a", tool: "Bash", key: "command", text: hidden })).toBe(true);
    // Texts of millions of characters: slow under a loaded run, not in a page.
  }, 30_000);

  it("draws the line at the drawn size, to the character, and cuts nothing to keep to it", () => {
    const within = `${"x".repeat(WHOLE_MAX - 8 * 1000)}${ZERO_WIDTH.repeat(1000)}`;
    expect(drawnChars(within)).toBe(WHOLE_MAX);
    expect(commandFold(`${within}y`)).toMatchObject({ drawn: WHOLE_MAX + 1, tooLong: true });
    // A command within the bound opens whole, every one of its codes.
    const opens = commandFold(`first\n${ZERO_WIDTH.repeat(600_000)}`);
    expect(opens).toMatchObject({ tooLong: false, more: 1 });
    expect(commandShown(opens, true).rest).toBe(ZERO_WIDTH.repeat(600_000));
  }, 30_000);

  it("says both sizes when the drawn one is why", () => {
    expect(tooLongNote("command", 1_000_000, undefined, undefined, 8_000_000)).toBe(
      "This command is too long to show in full (1,000,000 characters, 8,000,000 as drawn: the ones that cannot be seen as typed are drawn as their codes), so it cannot be allowed here. Deny it and ask for it in smaller steps.",
    );
    // Too long by its own length: one size, as before.
    expect(tooLongNote("command", 5_000_024, undefined, undefined, 5_000_024)).toBe(
      "This command is too long to show in full (5,000,024 characters), so it cannot be allowed here. Deny it and ask for it in smaller steps.",
    );
  });
});

describe("a text too long to show", () => {
  it("is one past what the page draws, counted in characters", () => {
    expect(tooLong("c".repeat(WHOLE_MAX))).toBe(false);
    expect(tooLong("c".repeat(WHOLE_MAX + 1))).toBe(true);
    // More units than the limit, but not more characters.
    expect(tooLong("😀".repeat(WHOLE_MAX / 2 + 1000))).toBe(false);
    expect(tooLong("")).toBe(false);
  });

  it("says why it cannot be allowed and what to do instead", () => {
    expect(tooLongNote("command", 5_000_024)).toBe(
      "This command is too long to show in full (5,000,024 characters), so it cannot be allowed here. Deny it and ask for it in smaller steps.",
    );
    expect(tooLongNote("first message", 5_000_001, "be sent from here", "Cancel it and ask for a shorter one.")).toBe(
      "This first message is too long to show in full (5,000,001 characters), so it cannot be sent from here. Cancel it and ask for a shorter one.",
    );
  });

  it("is the only limit: nothing in this module cuts a text", () => {
    // The cap that drew 200,000 characters of a command and let Allow go.
    for (const gone of ["HARD_CAP", "capped", "cutNote", "commandOpened"]) expect(cardFold).not.toHaveProperty(gone);
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

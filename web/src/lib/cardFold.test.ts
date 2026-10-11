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
  hiddenIn, hiddenNote, MARKS_MAX, commandShown, commandTitle, count,
  diffLabel, digits, drawnWhole, sameCommand, type CommandAsked, foldIsOpen, foldPhase, foldPressed, foldSettled, foldStart,
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
    expect(commandFold("pnpm test")).toEqual({ lines: 1, size: 9, head: "pnpm test", rest: "", more: 0, tooLong: false });
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
    // A space, a tab and a return; and, outside the set the card marks, the
    // wider spaces of other scripts (an ideographic space is ordinary in a
    // Chinese or Japanese commit message), a combining accent, an emoji.
    for (const text of ["a b", "a\tb", "a\rb", "a　b", "a b", "áb", "👨🏽"]) {
      expect(commandDrawn(text)).toEqual([text]);
    }
  });

  it("counts them in the whole command and names the first", () => {
    expect(hiddenIn(`${NBSP}\necho safe\n${NBSP}`)).toEqual({ count: 2, example: "\\u{00A0}" });
    expect(hiddenIn("a\u202Eb\u200Bc\u00A0")).toEqual({ count: 3, example: "\\u{202E}" });
    expect(hiddenNote(1)).toEqual({ count: "1 character that cannot be seen as typed", rest: " is in this command, drawn as its code: " });
    expect(hiddenNote(3)).toEqual({ count: "3 characters that cannot be seen as typed", rest: " are in this command, each drawn as its code, like " });
    expect(hiddenNote(12_345, "script")).toEqual({
      count: "12,345 characters that cannot be seen as typed", rest: " are in this script, each drawn as its code, like ",
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

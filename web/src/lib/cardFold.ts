// What a card that waits on the person shows before they ask for more.
//
// Folded, a decision card is the ask, its short facts and the buttons. A long
// part (a role, a brief, a diff) is folded, and folding is never hiding: its
// label stays on the card with its size and, for a change, the fact that it
// changes. The person can tell from the folded card what kinds of things they
// are approving and that there is more to read; opening shows all of it.
//
// What stays of a folded part is its name and its size, or a line the host
// wrote for it. Never a piece of it: the first line of a script, or the last
// sixty characters of a list of names, reads as the whole and is not.
//
// This is the half that can be wrong, so it is here and not in the cards: a
// part taken for short that is not is cut on screen, and a part folded with
// no label is approved unseen.
import type { ChangeRow } from "./askDetail";

/** The longest single line that still reads as a fact beside its label. */
export const SHORT_FACT = 60;

/** The longest one-line text drawn whole on the folded card. A command has
 *  its own rule (`commandFold`). */
export const SHORT_TEXT = 200;

/** A removal's rows that say what it does to the chart (`team_tools::
 *  delete_facts`): the seat that empties, the reports that move. A
 *  consequence, so a sentence of it is drawn whole where any other value of
 *  that length would fold to its size. The host's own labels, checked against
 *  its source by the test. */
export const STRUCTURAL = new Set(["Head", "Front desk", "Direct report", "Direct reports"]);

/** How long a consequence may run and still be drawn whole. */
export const STRUCTURAL_WHOLE = 160;

/** The most characters of one text a card draws. Nothing shorter is ever
 *  cut: an opened detail is every character of it, scrolling inside the card.
 *  A text past this is not drawn in part and passed off as opened. The card
 *  says it is too long to show, and what would approve it is unavailable
 *  (`tooLong`, `tooLongNote`): what cannot be shown whole cannot be allowed.
 *
 *  Set where opening stops the page for about a second. One `<pre>` with one
 *  text node, production build, headless Chromium, the page stopped for:
 *  330,000 characters 0.04–0.09 s, 1,000,000 0.13–0.22 s, 2,000,000
 *  0.24–0.62 s, 5,000,000 0.7–1.2 s, 10,000,000 1.4–4 s, 20,000,000 3–7 s,
 *  50,000,000 8–9 s. Every size was drawn whole, last line included, in
 *  Chromium and in WebKit: the limit is the wait, not a point where the text
 *  stops being drawn. */
export const WHOLE_MAX = 5_000_000;

/** The lines of a text to read (a plan, a role, a brief), without the blank
 *  ones at either end. For naming its size only: such a text opens whole.
 *  A command's lines are `commandLines`, which drops far less. */
export function textLines(text: string): string[] {
  const lines = text.split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

export function lineCount(text: string): number {
  return textLines(text).length;
}

/** How many characters a text is: Unicode code points, so an emoji is one
 *  and not the two units JavaScript stores it in. Every size a card states
 *  is counted this way. */
export function chars(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    // The second half of a pair was counted with the first.
    if (unit >= 0xdc00 && unit <= 0xdfff && i > 0) {
      const lead = text.charCodeAt(i - 1);
      if (lead >= 0xd800 && lead <= 0xdbff) continue;
    }
    n += 1;
  }
  return n;
}

/** One line, and short enough to sit beside a label. */
export function isShort(text: string, limit = SHORT_FACT): boolean {
  const lines = textLines(text);
  return lines.length <= 1 && chars((lines[0] ?? "").trim()) <= limit;
}

/** 12345 → "12,345". Written out: a locale would word it per browser. */
export function digits(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "1 line", "12,345 characters". */
export function count(n: number, noun: string): string {
  return `${digits(n)} ${noun}${n === 1 ? "" : "s"}`;
}

/** How much a folded text is: its lines when it has several, else its
 *  characters, not counting the blank space it opens or ends with. */
export function sizeLabel(text: string): string {
  const lines = textLines(text);
  return lines.length > 1 ? count(lines.length, "line") : count(chars(text.trim()), "character");
}

/** How one row of a change is drawn folded: whole, or as what stays of it.
 *  What stays is never a piece of the value: a cut of a long text is not the
 *  fact it holds, and reads as if it were. */
export type RowFold =
  | { folded: false }
  | {
      folded: true;
      /** What stays beside the label: "changed · 2 lines → 14 lines",
       *  "cleared · was 14 lines", "3,627 characters". */
      note: string;
      /** The host's own one line for the value, drawn whole before the size. */
      summary?: string;
    };

export function rowFold(row: ChangeRow): RowFold {
  if ("before" in row) {
    const short = isShort(row.before) && isShort(row.after);
    if (short) return { folded: false };
    // What was there is the long part; that it goes is the fact.
    if (row.after === "") return { folded: true, note: `cleared · was ${sizeLabel(row.before)}` };
    // Both sizes: either side may be the long one, and the one on the card
    // must not pass for the whole of the change.
    return { folded: true, note: `changed · ${sizeLabel(row.before)} → ${sizeLabel(row.after)}` };
  }
  const whole = STRUCTURAL.has(row.label) ? STRUCTURAL_WHOLE : SHORT_FACT;
  if (isShort(row.value, whole)) return { folded: false };
  return { folded: true, note: sizeLabel(row.value), ...(row.summary ? { summary: row.summary } : {}) };
}

/** The fold line of a change: how many of its rows are folded. */
export function longRowsLabel(n: number): string {
  return n === 1 ? "1 long field" : `${digits(n)} long fields`;
}

/** A text the card shows as its opening and folds the rest of. */
export type TextFold =
  | { whole: true }
  | {
      whole: false;
      /** The first line, as written. */
      first: string;
      /** What is not on the folded card: "12 more lines", "1,840 characters". */
      rest: string;
    };

/** A plan, an older host's change: whole when it is one short line, else
 *  its first line and how much more there is. Prose, which opens with what
 *  it is about; a command does not (`commandFold`). */
export function textFold(text: string, limit = SHORT_TEXT): TextFold {
  const lines = textLines(text);
  if (lines.length <= 1) {
    const line = lines[0] ?? "";
    return chars(line) <= limit ? { whole: true } : { whole: false, first: line, rest: count(chars(line), "character") };
  }
  return { whole: false, first: lines[0], rest: count(lines.length - 1, "more line") };
}

/* ---- A command ----------------------------------------------------------
   A command is the thing being approved, not detail about it, so it is on the
   folded card whole for as long as a card can hold it: twelve lines. A first
   line is never left to stand for the rest. Past that the card shows the
   lines it can, says how many it does not, and will not take an Allow until
   the whole command has been drawn: every line, with no cut. What decides
   is what the card draws (`notShown`), never that a control was pressed. A
   command too long to draw whole (`WHOLE_MAX`) cannot be allowed at all. */

/** The most lines of a command a folded card draws. */
export const COMMAND_LINES = 12;

/** The most characters of a command a folded card draws: twelve full lines.
 *  A line is never cut to fit, so a line that would pass this is not drawn
 *  folded at all, and nor are the lines after it. */
export const COMMAND_CHARS = 1200;

/** A line with nothing on it: no character at all, or spaces and tabs. The
 *  only lines a shell skips whatever it is told to run. JavaScript's own
 *  idea of blank is wider, and wrong here: a line holding one no-break space
 *  (U+00A0) is a word to bash, which looks on PATH for a program of that
 *  name, and a lone carriage return is one too. */
const EMPTY_LINE = /^[ \t]*$/;

/** The lines of a command. Every line with a character on it is one of
 *  them, drawn and counted; only empty lines before the first of those and
 *  after the last are left out. Nothing is trimmed off a line. */
export function commandLines(text: string): string[] {
  const lines = text.split("\n");
  let from = 0;
  let to = lines.length;
  while (from < to && EMPTY_LINE.test(lines[from])) from += 1;
  while (to > from && EMPTY_LINE.test(lines[to - 1])) to -= 1;
  return lines.slice(from, to);
}

export type CommandFold = {
  /** Its lines, without the empty ones at either end (`commandLines`). */
  lines: number;
  /** How many characters those lines are, their line breaks included. */
  size: number;
  /** What the folded card draws: every line, or the first whole lines. */
  head: string;
  /** The lines after those, drawn once the card is opened. Empty when the
   *  folded card already shows the whole command. */
  rest: string;
  /** How many lines `rest` is. */
  more: number;
  /** Past what the page draws (`WHOLE_MAX`): it cannot be opened whole, so
   *  it is not opened, and it cannot be allowed here. */
  tooLong: boolean;
};

export function commandFold(text: string): CommandFold {
  const lines = commandLines(text);
  let kept = 0;
  let budget = COMMAND_CHARS;
  while (kept < lines.length && kept < COMMAND_LINES) {
    const size = chars(lines[kept]);
    if (size > budget) break;
    budget -= size;
    kept += 1;
  }
  const whole = lines.join("\n");
  return {
    lines: lines.length,
    size: chars(whole),
    head: lines.slice(0, kept).join("\n"),
    rest: lines.slice(kept).join("\n"),
    more: lines.length - kept,
    tooLong: tooLong(whole),
  };
}

/** What a card draws of a command: the lines of the folded card, and under
 *  them the rest when there is one to draw. The card draws these two texts
 *  and nothing else of the command, so they are also what `notShown` is
 *  asked about. */
export type CommandShown = { head: string; rest: string | null };

/** A command as the card draws it, folded or opened. Opened is the whole of
 *  it, every line: there is no cut. A command the page cannot draw whole is
 *  not opened at all. */
export function commandShown(fold: CommandFold, open: boolean): CommandShown {
  return { head: fold.head, rest: open && commandOpens(fold) ? fold.rest : null };
}

/** Whether opening shows the whole command: there are lines the folded card
 *  left out, and the page can draw them. The control that says "Open the
 *  full command" is drawn for this and for nothing else. */
export function commandOpens(fold: CommandFold): boolean {
  return fold.more > 0 && !fold.tooLong;
}

/** How many characters of a command are not in what the card draws. Nothing
 *  when the two texts drawn are, in order, the whole command. Asked of what
 *  is drawn and not of whether the card was opened: an opening that drew
 *  less than all of it leaves this above nothing, and Allow held. */
export function notShown(fold: CommandFold, shown: CommandShown): number {
  const whole = shown.head === fold.head && (fold.more === 0 || shown.rest === fold.rest);
  if (whole) return 0;
  const drawn = chars(shown.head) + (shown.rest === null ? 0 : chars(shown.rest) + (shown.head === "" ? 0 : 1));
  return Math.max(1, fold.size - drawn);
}

/** What the card says under the lines it shows, while it does not show the
 *  rest. Full strength, and the last thing above the answers: it is the one
 *  thing standing between a person and an Allow of lines they have not
 *  seen. */
export function unseenLines(fold: CommandFold): string {
  if (fold.more === 0) return "";
  // Nothing of it is on the card: a line too long to draw whole.
  if (fold.head === "") {
    return fold.lines === 1
      ? `${count(chars(fold.rest), "character")} not shown`
      : `${count(fold.lines, "line")} not shown`;
  }
  return `${count(fold.more, "more line")} not shown`;
}

/** "3-line script": what a command over several lines is called in the
 *  card's title, which must not name the first of them as if it were all. */
export function scriptLabel(lines: number): string {
  return `${digits(lines)}-line script`;
}

/** What a command is called in the card's title when its first command must
 *  not name it: over several lines, how many; on one line the folded card
 *  cannot draw, how long ("5,012-character command"). A title that read
 *  `bash(echo)` over `echo <base64> | base64 -d | sh` named the harmless
 *  end of a line nobody could see. `null` for one line that is whole on the
 *  card, which keeps the tool's own title. `noun` is what the tool calls
 *  what it runs. */
export function commandTitle(fold: CommandFold, noun = "command"): string | null {
  if (fold.lines > 1) return scriptLabel(fold.lines);
  if (fold.more > 0) return `${digits(fold.size)}-character ${noun}`;
  return null;
}

/** What an Allow of a command approves, exactly: the ask, the tool, the
 *  argument that runs, and every character of it as the host sent it. The
 *  text is the argument itself and not the lines drawn from it, so nothing
 *  that reads it (a trim, a fold) can make two commands one. */
export type CommandAsked = { id: string; tool: string; key: string; text: string };

/** Whether two of them are the same thing to approve. One character apart,
 *  or the same text under another tool, argument or ask, is another. */
export function sameCommand(a: CommandAsked | null, b: CommandAsked | null): boolean {
  return !!a && !!b && a.id === b.id && a.tool === b.tool && a.key === b.key && a.text === b.text;
}

/** Whether Allow is held back: some of the command has never been in front
 *  of the person. `unshown` is how much of `asked` the card is not drawing
 *  now (`notShown`); `whole`, the command this card last drew every
 *  character of. Showing it whole once is enough, and folding it again does
 *  not take the answer away: but only for that command. "Shown whole" is
 *  said of a text, and is asked again of whatever is on the card now. An
 *  ask whose command changed under the same id, by one character, is unread.
 *  A command too long to draw is never whole, so its Allow is never let go. */
export function allowHeld(unshown: number, whole: CommandAsked | null, asked: CommandAsked): boolean {
  return unshown > 0 && !sameCommand(whole, asked);
}

/** What the card remembers after a draw: the command, when that draw had
 *  every character of it; else what it remembered before. The memory is the
 *  command itself, so it can only ever let go of an Allow for that one. */
export function drawnWhole(was: CommandAsked | null, asked: CommandAsked, unshown: number): CommandAsked | null {
  if (unshown > 0) return was;
  return sameCommand(was, asked) ? was : asked;
}

/** Whether a text is past what the page draws whole. */
export function tooLong(text: string): boolean {
  // Never more characters than units, so this is most texts, at no cost.
  return text.length > WHOLE_MAX && chars(text) > WHOLE_MAX;
}

/** What a card says in place of a text it cannot draw whole, beside the
 *  answers it has taken away. `what` names the text: "command", "plan".
 *  `cannot` and `instead` are the card's own words for what is off and for
 *  the way out; a permission's are the default. */
export function tooLongNote(
  what: string,
  size: number,
  cannot = "be allowed here",
  instead = "Deny it and ask for it in smaller steps.",
): string {
  return `This ${what} is too long to show in full (${count(size, "character")}), so it cannot ${cannot}. ${instead}`;
}

/** "+12 −3 in chat.ts": a diff as its counts, for the folded card. */
export function diffLabel(diff: { added: number; removed: number; path: string; kind: "create" | "edit" }): string {
  const file = diff.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || diff.path || "the file";
  const counts = [diff.added > 0 ? `+${digits(diff.added)}` : "", diff.removed > 0 ? `−${digits(diff.removed)}` : ""]
    .filter(Boolean)
    .join(" ");
  const label = `${counts || "No lines changed"} in ${file}`;
  return diff.kind === "create" ? `${label} · new file` : label;
}

/** What a plan card's fold belongs to: one revision of one plan. A changed
 *  plan is a new thing to approve, so its card starts folded whatever the
 *  revision before it was left at. */
export function planFoldId(runId: string, revision: number | undefined): string {
  return `${runId}:${revision ?? 0}`;
}

/** "3 tasks in 2 stages". */
export function planLabel(tasks: number, stages: number): string {
  return `${count(tasks, "task")} in ${count(stages, "stage")}`;
}

/** Names in a line, and the rest said in words: "Ada, Bo, Cy +2 more agents".
 *  Never a bare number, which reads as decoration. `noun` is what one of
 *  them is. */
export function nameList(names: readonly string[], keep: number, noun: string): string {
  const said = names.filter(Boolean);
  if (said.length <= keep) return said.join(", ");
  const rest = said.length - keep;
  return `${said.slice(0, keep).join(", ")} +${digits(rest)} more ${noun}${rest === 1 ? "" : "s"}`;
}

/* ---- The fold itself ----------------------------------------------------
   Where a card's one disclosure is, as the component keeps it. Pure, so the
   rules a press cannot be tested for in static markup are tested here. */

/** Shut, open, or on the way to either. */
export type FoldPhase = "shut" | "opening" | "open" | "closing";

/** A fold belongs to what its card asks: `id` is the ask, the handover or
 *  the plan. */
export type FoldState = { id: string; phase: FoldPhase };

/** A card starts folded. */
export function foldStart(id: string, startOpen = false): FoldState {
  return { id, phase: startOpen ? "open" : "shut" };
}

/** The phase for the card that asks `id`. Another ask drawn in the same
 *  place starts folded, whatever the last one was left at. */
export function foldPhase(state: FoldState, id: string): FoldPhase {
  return state.id === id ? state.phase : "shut";
}

export function foldIsOpen(phase: FoldPhase): boolean {
  return phase === "open" || phase === "opening";
}

/** After a press. `calm` is reduced motion: there is nothing to run, so the
 *  fold goes straight to where it is going. */
export function foldPressed(state: FoldState, id: string, calm: boolean): FoldState {
  const open = foldIsOpen(foldPhase(state, id));
  return { id, phase: open ? (calm ? "shut" : "closing") : calm ? "open" : "opening" };
}

/** After its animation ended. A fold that is not moving is left alone, and
 *  so is one that has since become another ask's. */
export function foldSettled(state: FoldState, id: string): FoldState {
  if (state.id !== id) return state;
  if (state.phase === "opening") return { id, phase: "open" };
  if (state.phase === "closing") return { id, phase: "shut" };
  return state;
}

/* ---- The press that follows --------------------------------------------
   Opening or shutting a detail moves the page: a card above the composer
   grows upward, one in the conversation grows down, and a card stacked on
   another slides with it. Whatever was under the pointer may not be there a
   moment later, and a second press in the same spot (a double click, or a
   press repeated because nothing seemed to happen) would land on whatever
   slid in: another card's Allow, in the worst case. Where a card puts its
   control keeps its OWN answers clear; this keeps everything else clear. */

/** How long after a press on a disclosure a press in the same spot is taken
 *  for a repeat of it: the reveal (200 ms) and the time to see what moved. */
export const STRAY_MS = 700;

/** How far a pointer may drift and still be "the same spot". */
export const STRAY_RADIUS = 8;

export type Press = { x: number; y: number; at: number };

/** Whether `next` is a repeat of the press that worked a disclosure: in the
 *  same spot, soon after. A pointer that moved was aimed, and a press made
 *  later was made looking at what is there; both go through. */
export function strayPress(fold: Press | null, next: Press): boolean {
  if (!fold) return false;
  const since = next.at - fold.at;
  if (since < 0 || since > STRAY_MS) return false;
  return Math.hypot(next.x - fold.x, next.y - fold.y) <= STRAY_RADIUS;
}

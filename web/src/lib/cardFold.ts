// What a card that waits on the person shows before they ask for more.
//
// Folded, a decision card is the ask, its short facts and the buttons. A long
// part (a role, a brief, a command over several lines, a diff) is folded, and
// folding is never hiding: its label stays on the card with its size and, for
// a change, the fact that it changes. The person can tell from the folded
// card what kinds of things they are approving and that there is more to
// read; opening shows all of it.
//
// This is the half that can be wrong, so it is here and not in the cards: a
// part taken for short that is not is cut on screen, and a part folded with
// no label is approved unseen.
import type { ChangeRow } from "./askDetail";

/** The longest single line that still reads as a fact beside its label. */
export const SHORT_FACT = 60;

/** The longest one-line command or text drawn whole on the folded card. */
export const SHORT_TEXT = 200;

/** A removal's rows that say what it does to the chart (`team_tools::
 *  delete_facts`): the seat that empties, the reports that move. A
 *  consequence, so never folded to a size alone. The host's own labels,
 *  checked against its source by the test. */
export const STRUCTURAL = new Set(["Head", "Front desk", "Direct report", "Direct reports"]);

/** How long a consequence may run and still be drawn whole. */
export const STRUCTURAL_WHOLE = 160;

/** Past this the opened detail stops, and says how much it left out. */
export const HARD_CAP = 200_000;

/** The lines of a text, without the blank ones at either end. */
export function textLines(text: string): string[] {
  const lines = text.split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

export function lineCount(text: string): number {
  return textLines(text).length;
}

/** One line, and short enough to sit beside a label. */
export function isShort(text: string, limit = SHORT_FACT): boolean {
  const lines = textLines(text);
  return lines.length <= 1 && (lines[0] ?? "").trim().length <= limit;
}

/** 12345 → "12,345". Written out: a locale would word it per browser. */
export function digits(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "1 line", "12,345 characters". */
export function count(n: number, noun: string): string {
  return `${digits(n)} ${noun}${n === 1 ? "" : "s"}`;
}

/** How much a folded text is: its lines when it has several, else its length. */
export function sizeLabel(text: string): string {
  const lines = textLines(text);
  return lines.length > 1 ? count(lines.length, "line") : count(text.trim().length, "character");
}

/** The end of a long line, for a sentence whose point comes last ("… will
 *  report to Potato."). A cut by length, never a reading of the text. */
export function tail(text: string, keep = SHORT_FACT): string {
  const line = text.trim();
  return line.length <= keep ? line : `…${line.slice(line.length - keep)}`;
}

/** How one row of a change is drawn folded: whole, or as what stays of it. */
export type RowFold =
  | { folded: false }
  | {
      folded: true;
      /** What stays beside the label: "changed · 2 lines", "cleared", "14 lines". */
      note: string;
      /** The end of a consequence too long to draw whole. */
      tail?: string;
    };

export function rowFold(row: ChangeRow): RowFold {
  if ("before" in row) {
    const short = isShort(row.before) && isShort(row.after);
    if (short) return { folded: false };
    // What was there is the long part; that it goes is the fact.
    if (row.after === "") return { folded: true, note: "cleared" };
    return { folded: true, note: `changed · ${sizeLabel(row.after)}` };
  }
  if (STRUCTURAL.has(row.label)) {
    if (isShort(row.value, STRUCTURAL_WHOLE)) return { folded: false };
    return { folded: true, note: sizeLabel(row.value), tail: tail(row.value.replace(/\s*\n\s*/g, " ")) };
  }
  return isShort(row.value) ? { folded: false } : { folded: true, note: sizeLabel(row.value) };
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

/** A command, a plan, an older host's change: whole when it is one short
 *  line, else its first line and how much more there is. */
export function textFold(text: string, limit = SHORT_TEXT): TextFold {
  const lines = textLines(text);
  if (lines.length <= 1) {
    const line = lines[0] ?? "";
    return line.length <= limit ? { whole: true } : { whole: false, first: line, rest: count(line.length, "character") };
  }
  return { whole: false, first: lines[0], rest: count(lines.length - 1, "more line") };
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

/** "3 tasks in 2 stages". */
export function planLabel(tasks: number, stages: number): string {
  return `${count(tasks, "task")} in ${count(stages, "stage")}`;
}

/** A detail as it is drawn opened: all of it, or up to the cap with what the
 *  cap left out. */
export function capped(text: string, cap = HARD_CAP): { shown: string; hidden: number } {
  return text.length <= cap ? { shown: text, hidden: 0 } : { shown: text.slice(0, cap), hidden: text.length - cap };
}

/** What a capped detail says under itself. Never drawn for a text that fits. */
export function cutNote(total: number, hidden: number): string {
  const verb = hidden === 1 ? "is" : "are";
  return `The first ${digits(total - hidden)} of ${count(total, "character")} are shown. ${count(hidden, "character")} ${verb} not shown.`;
}

/** Names in a line, with the rest as a number: "Ada, Bo, Cy +2". */
export function nameList(names: readonly string[], keep = 3): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= keep) return unique.join(", ");
  return `${unique.slice(0, keep).join(", ")} +${digits(unique.length - keep)}`;
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

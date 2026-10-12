// A press or a key that was not aimed at what it reached.
//
// An action that stops or starts work is never fired by the key or the
// press that brought it on screen. Three things can do that, and each has
// its guard here:
//
// - A pointer press on something that opens (a disclosure, a row, a group)
//   moves the page, and a second press in the same spot lands on whatever
//   slid under the pointer. A press on such a control is remembered for a
//   moment (`notePress`), and one that repeats it somewhere else is dropped
//   (`lib/cardFold.strayPress`). This is the cards' guard; the run panel's
//   disclosures share it.
// - A press that opens a question (a confirm) can be repeated onto the
//   question's confirming answer, which is drawn where the page puts it and
//   not where the pointer was aimed. The question remembers the press that
//   opened it (`lastPointerPress`) and drops that repeat (`strayAnswer`).
// - A key held down repeats. The repeats of Enter and Space answer nothing
//   (`heldKey`, `dropHeld`), so a key that opened something cannot also
//   answer it; a key pressed again is a new press, and lands on whatever
//   has the focus, which a question puts on its safe answer.
import { strayPress, type Press } from "./cardFold";

/** A repeat of Enter or Space from a key held down. */
export function heldKey(event: { key: string; repeat: boolean }): boolean {
  return event.repeat && (event.key === "Enter" || event.key === " " || event.key === "Spacebar");
}

/** A `keydown` handler that drops those repeats, so a held key presses a
 *  control once. */
export function dropHeld(event: { key: string; repeat: boolean; preventDefault: () => void }): void {
  if (heldKey(event)) event.preventDefault();
}

/** Whether a click on a question's confirming answer repeats the pointer
 *  press that opened the question. A key press (`detail` 0) never does:
 *  Tab to the answer and Enter is an answer. */
export function strayAnswer(opener: Press | null, click: Press & { detail: number }): boolean {
  return click.detail !== 0 && strayPress(opener, click);
}

/* ---- The page's presses ------------------------------------------------ */

/** The last pointer press on a control that opens something, and the
 *  control it was on. */
let lastPress: (Press & { on: Element }) | null = null;
let guarding = false;

/** Drops a press that repeats the one on a disclosure and would land
 *  somewhere else. On the document, in the capture phase, so it is ahead of
 *  every handler on the page, whichever card or row the press slid onto. */
function dropStray(event: MouseEvent) {
  if (!lastPress || event.detail === 0) return;
  const next = { x: event.clientX, y: event.clientY, at: performance.now() };
  if (!strayPress(lastPress, next)) return;
  // The same control again is a second press on it: let it close what it opened.
  if (event.target instanceof Node && lastPress.on.contains(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
}

/** A press on a control that opens something, as the guard remembers it. A
 *  key press has no spot: focus stays on the control, and nothing slides
 *  under a key. */
export function notePress(event: { detail: number; clientX: number; clientY: number; currentTarget: Element }): void {
  if (event.detail === 0) return;
  lastPress = { x: event.clientX, y: event.clientY, at: performance.now(), on: event.currentTarget };
  if (guarding || typeof document === "undefined") return;
  guarding = true;
  document.addEventListener("click", dropStray, true);
}

/** The last pointer press anywhere on the page. */
let lastPointer: Press | null = null;
if (typeof document !== "undefined") {
  // Before `dropStray`, which is added on a first disclosure press at the
  // earliest, so a press it drops is still the latest one known here.
  document.addEventListener("click", (event) => {
    if (event.detail !== 0) lastPointer = { x: event.clientX, y: event.clientY, at: performance.now() };
  }, true);
}

/** The pointer press that was last made, for a question to remember as the
 *  one that opened it. `null` before any. */
export function lastPointerPress(): Press | null {
  return lastPointer;
}

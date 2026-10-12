// Whether the tip on a project's name (the folder behind it, on a handover
// or route card) is shown.
//
// Two things ask for it: a pointer over the name, and the keyboard's focus
// on it (a tap on a phone is the second: the name takes the focus). Escape,
// or a press anywhere else, takes it away, and it stays away for as long as
// what asked for it has not asked again: a pointer still over the name does
// not bring it back, and nor does a focus that never left. Style alone
// cannot say that (`:hover` is true for as long as the pointer is there),
// so it is a state, and the sheet draws the tip from `data-open` only.
//
// Each way in is its own: Escape with the focus on the name and a pointer
// over it turns both off, the pointer coming back turns its own on again,
// and leaving then hides the tip, because the focus was never asked again.

/** One way of asking: not asking, asking, or asking and sent away. */
export type Ask = "no" | "yes" | "shut";
export type Tip = { hover: Ask; focus: Ask };
export const NO_TIP: Tip = { hover: "no", focus: "no" };

/** What happened to the name:
 *  - `enter` / `leave`: a pointer that can hover came over it, or left;
 *  - `focus` / `blur`: it took the focus, or lost it;
 *  - `press`: it was clicked or tapped, which asks again whatever was sent
 *    away (and is the way in on a screen with no pointer to hover with);
 *  - `escape`: Escape, wherever the focus is;
 *  - `outside`: a press anywhere but on the name. */
export type TipEvent = "enter" | "leave" | "focus" | "blur" | "press" | "escape" | "outside";

export function tipShown(tip: Tip): boolean {
  return tip.hover === "yes" || tip.focus === "yes";
}

const sentAway = (ask: Ask): Ask => (ask === "yes" ? "shut" : ask);

export function tipAfter(tip: Tip, event: TipEvent): Tip {
  switch (event) {
    case "enter": return { ...tip, hover: "yes" };
    case "leave": return { ...tip, hover: "no" };
    case "focus": return { ...tip, focus: "yes" };
    case "blur": return { ...tip, focus: "no" };
    case "press": return { ...tip, focus: "yes" };
    case "escape":
    case "outside": return { hover: sentAway(tip.hover), focus: sentAway(tip.focus) };
  }
}

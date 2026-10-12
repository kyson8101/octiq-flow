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

//
// Escape always shuts a tip that is shown. Whether it is then the tip's
// alone is asked of where the focus is (`keepsEscape`): the tip is opened
// by a pointer as much as by the focus, so the focus may be in a form, a
// dialog or another card, and that Escape is theirs too.

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

/** Where the keyboard's focus is when Escape is pressed:
 *  - `word`: on the name the tip belongs to;
 *  - `nowhere`: on nothing (the page's body);
 *  - `elsewhere`: on anything else: a field, a button, a dialog, another
 *    card, another tip's name. */
export type FocusAt = "word" | "nowhere" | "elsewhere";

/** Where the focus is, for the tip on `word`. `active` is the document's
 *  focused element and `body` its body, which is what holds the focus when
 *  nothing does. */
export function focusAt<E extends { contains(other: E | null): boolean }>(active: E | null, word: E | null, body: E | null): FocusAt {
  if (!active || active === body) return "nowhere";
  return word?.contains(active) ? "word" : "elsewhere";
}

/** Whether an Escape that shuts the tip goes no further. Only when it is
 *  nobody else's: the focus is on the tip's own name, or on nothing (it
 *  would otherwise also leave focus mode, with the same press). With the
 *  focus anywhere else the tip shuts all the same and the Escape goes on to
 *  whatever has the focus, which answers it by its own rules: a form is
 *  cancelled, a dialog shut. A tip that is not shown keeps nothing. */
export function keepsEscape(shown: boolean, at: FocusAt): boolean {
  return shown && at !== "elsewhere";
}

/** An Escape heard by the page while a tip may be shown: the tip is sent
 *  away (`say`), and the press is kept from going further only when
 *  `keepsEscape` says it is the tip's alone. Any other key is not heard. */
export function hearEscape(
  event: { key: string; preventDefault(): void; stopPropagation(): void },
  shown: boolean,
  at: FocusAt,
  say: (event: TipEvent) => void,
): void {
  if (event.key !== "Escape" || !shown) return;
  if (keepsEscape(shown, at)) {
    event.preventDefault();
    event.stopPropagation();
  }
  say("escape");
}

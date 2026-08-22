// Turning what you ticked into the sentence the agent is handed.
//
// It lives here rather than in the card that draws it because it is the half
// that can be wrong. The card either shows buttons or it does not; this decides
// what an agent — blocked, and about to act on whatever it is told — is told
// you chose. A stale tick or a dropped free-text tail is a wrong answer that
// still looks like an answer, and a component is where the test runner cannot
// go.

/** Tick an option, or take the tick back. */
export function togglePick(picks: string[], option: string): string[] {
  return picks.includes(option) ? picks.filter((p) => p !== option) : [...picks, option];
}

/** What the ticks and the text box add up to.
 *
 *  Empty means nothing was said, which the card reads as "not answered yet" —
 *  so it must stay empty rather than becoming a cheerful blank answer. */
export function composeAnswer(options: string[], picks: string[], text: string): string {
  // Read back in the order the agent wrote the list, not the order they were
  // tapped, and only for options still on offer: ticks outlive a step back to
  // the question, an option does not.
  const chosen = options.filter((option) => picks.includes(option));
  const said = text.trim();
  if (said) chosen.push(said);
  return chosen.join(", ");
}

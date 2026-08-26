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

/** One thing you can pick: the words on the button, and optionally a line
 *  under them. */
export type Choice = { label: string; description?: string };

/** Read the choices off a question, whichever shape they arrive in.
 *
 *  Two shapes reach here for two different reasons. An agent sends
 *  `{label, description}` objects because that is `AskUserQuestion`'s shape and
 *  what it is trained on; an OLD server sends plain strings, because the client
 *  and the backend deploy separately and a page built after the server is
 *  routinely handed the older one. Neither is a mistake worth drawing a broken
 *  card over.
 *
 *  Anything with no words on it is dropped rather than shown. A button reading
 *  `[object Object]` is not a choice — it is a question nobody can answer, and
 *  the agent is blocked behind it. */
export function choicesOf(options: unknown): Choice[] {
  if (!Array.isArray(options)) return [];
  const out: Choice[] = [];
  for (const raw of options) {
    if (typeof raw === "string") {
      if (raw.trim()) out.push({ label: raw });
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const bag = raw as Record<string, unknown>;
    const label = typeof bag.label === "string" ? bag.label : "";
    if (!label.trim()) continue;
    const description = typeof bag.description === "string" ? bag.description.trim() : "";
    out.push(description ? { label, description } : { label });
  }
  return out;
}

/** What pressing the button would say, for the page you are on.
 *
 *  A tap on a choice SELECTS it; only the button sends. That is the whole of
 *  the misclick guard: a card that answered on the tap turned one stray press
 *  on a phone into an answer the agent went and acted on, with nothing to take
 *  it back with. Empty means nothing has been decided yet, and the button stays
 *  dead — never a cheerful blank answer.
 *
 *  What you TYPED beats what you tapped. The box says "…or say something else",
 *  and writing a sentence is the more deliberate of the two acts. */
export function pendingAnswer(a: {
  /** Whether this question takes a set. */
  many: boolean;
  /** The choices on offer, in the order the agent wrote them. */
  labels: string[];
  /** For a set: what is ticked so far. */
  ticked: string[];
  /** For a one-of: what is selected, or an answer already recorded for this
   *  question — stepping back to a page has to find it sendable again. */
  chosen?: string;
  /** Whatever is in the text box. */
  text: string;
}): string {
  if (a.many) return composeAnswer(a.labels, a.ticked, a.text);
  const said = a.text.trim();
  if (said) return said;
  return a.chosen?.trim() ?? "";
}

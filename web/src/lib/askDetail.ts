// The part of a tool call worth reading before you answer for it.
//
// This lives here rather than in the card that draws it because it is the half
// that can be wrong: a card missing an argument shows buttons and nothing else,
// and the person taps Allow on a call they were never actually shown. That is
// worth a test, and a component is where the test runner cannot go.

/** What to put under the question, and how much of it. `null` when the tool's
 *  arguments hold nothing a person would read before deciding — the card says
 *  nothing rather than dumping the object. */
export type AskDetail = { label: string; body: string; limit: number };

/** How much of a preview is enough to judge it by. A write is a sample: you are
 *  deciding whether this tool may write to this file at all, and the opening is
 *  what tells you. */
const PREVIEW = 1200;

/** A plan is not a preview. `ExitPlanMode` asks you to approve the plan ITSELF,
 *  so a plan cut off part-way is one you cannot judge — you would be approving
 *  the part you were not shown. High enough to hold a real one whole. */
const WHOLE_PLAN = 8000;

export function askDetail(input: Record<string, unknown> | null | undefined): AskDetail | null {
  const bag = input ?? {};
  const read = (key: string): string => {
    const v = bag[key];
    // Arguments stream in as JSON fragments, so an empty string is a value that
    // has not arrived yet rather than a value of its own.
    return typeof v === "string" ? v : "";
  };

  if (read("command")) return { label: "command", body: read("command"), limit: PREVIEW };
  if (read("plan")) return { label: "plan", body: read("plan"), limit: WHOLE_PLAN };
  if (read("content")) return { label: "content", body: read("content"), limit: PREVIEW };
  // Present-but-empty counts here, where it does not above: an edit whose
  // replacement is the empty string is a deletion, and "replacing with" over a
  // blank body is exactly what happened. Only the KEY being absent means there
  // is nothing to say.
  if (typeof bag.new_string === "string") {
    return { label: "replacing with", body: bag.new_string, limit: PREVIEW };
  }
  return null;
}

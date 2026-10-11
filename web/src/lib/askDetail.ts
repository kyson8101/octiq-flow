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

/** A change to the registered agents is shown whole too, and the host's
 *  longest one is longer than a plan: an agent's 8000-character persistent
 *  prompt beside its role moving from one 2000-character text to another
 *  (`team_tools::describe`). Room for that, with its labels, and no cut. */
export const WHOLE_CHANGE = 16000;

/** One row of a change: a field stated whole, or one that moves from
 *  `before` to `after`. An empty `after` is a field being cleared. Every text
 *  is whole and keeps its newlines. */
export type ChangeRow =
  | { label: string; value: string }
  | { label: string; before: string; after: string };

/** A change as the host sends it beside its text (`tool_input.changeFacts`,
 *  `team_tools::ChangeFacts`): one sentence, then its rows. */
export type ChangeFacts = { lead: string; rows: ChangeRow[] };

const isBag = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value's own keys are exactly these: none missing, none besides. */
const hasOnly = (bag: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(bag);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

/** A text with something in it to read. */
const said = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function changeRow(raw: unknown): ChangeRow | null {
  if (!isBag(raw) || !said(raw.label)) return null;
  if (hasOnly(raw, ["label", "value"])) {
    return said(raw.value) ? { label: raw.label, value: raw.value } : null;
  }
  if (hasOnly(raw, ["label", "before", "after"])) {
    // What it was is never empty (a text set where there was none is a plain
    // row). What it becomes is empty for a field that is cleared, and for
    // nothing else: a text of blanks is not one the card can show as either.
    if (!said(raw.before) || typeof raw.after !== "string") return null;
    if (raw.after !== "" && !said(raw.after)) return null;
    return { label: raw.label, before: raw.before, after: raw.after };
  }
  return null;
}

/** The host's `changeFacts`, when it is exactly the shape the card can draw:
 *  a sentence and at least one row, each row a name with one text or with a
 *  before and an after, and no key besides. `null` for anything else, an
 *  older host's payload with no such key included, and the caller then shows
 *  the `change` text itself.
 *
 *  The text is never read back apart into rows. A role, a prompt or a policy
 *  may hold a line that reads `Access: edits → danger`, and a page that took
 *  that line for a field would show a change nobody proposed. And the check
 *  is all or nothing, an unknown key included: the rows are drawn INSTEAD of
 *  the text, so anything in them the card does not draw would be approved
 *  unseen. */
export function changeFacts(raw: unknown): ChangeFacts | null {
  if (!isBag(raw) || !hasOnly(raw, ["lead", "rows"])) return null;
  if (!said(raw.lead) || !Array.isArray(raw.rows) || raw.rows.length === 0) return null;
  const rows: ChangeRow[] = [];
  for (const item of raw.rows) {
    const row = changeRow(item);
    if (!row) return null;
    rows.push(row);
  }
  return { lead: raw.lead, rows };
}

export function askDetail(input: Record<string, unknown> | null | undefined): AskDetail | null {
  const bag = input ?? {};
  const read = (key: string): string => {
    const v = bag[key];
    // Arguments stream in as JSON fragments, so an empty string is a value that
    // has not arrived yet rather than a value of its own.
    return typeof v === "string" ? v : "";
  };

  if (read("command")) return { label: "command", body: read("command"), limit: PREVIEW };
  // A change to the registered agents, worded by the host (`team_tools`). Like
  // a plan, it is the thing being decided, so it is shown whole.
  if (read("change")) return { label: "change", body: read("change"), limit: WHOLE_CHANGE };
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

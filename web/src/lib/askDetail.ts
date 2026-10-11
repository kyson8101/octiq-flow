// The part of a tool call worth reading before you answer for it.
//
// This lives here rather than in the card that draws it because it is the half
// that can be wrong: a card missing an argument shows buttons and nothing else,
// and the person taps Allow on a call they were never actually shown. That is
// worth a test, and a component is where the test runner cannot go.

/** What to put under the question. `null` when the tool's arguments hold
 *  nothing a person would read before deciding: the card says nothing rather
 *  than dumping the object.
 *
 *  The body is always the whole text. There is no limit here and none is
 *  applied where it is drawn: a card folds a long body to its first line and
 *  its size (`lib/cardFold`), and opening shows every character. A body cut
 *  short with no sign of it was a part of the call approved unseen. */
export type AskDetail = { label: string; body: string };

/** One row of a change: a field stated whole, or one that moves from
 *  `before` to `after`. An empty `after` is a field being cleared. Every text
 *  is whole and keeps its newlines.
 *
 *  `summary` is the host's own one line for a value too long to sit on a
 *  folded card ("300 direct reports will report to Potato Juice"). The card
 *  draws it whole in the value's place until the row is opened; it is never
 *  made here, by cutting the value or by reading it. The host sends it on a
 *  stated value only, never on a move. */
export type ChangeRow =
  | { label: string; value: string; summary?: string }
  | { label: string; before: string; after: string };

/** The longest summary a row may carry, in characters. */
export const SUMMARY_MAX = 160;

/** The most rows a change is drawn as. The host sends about a dozen (a
 *  field each); 10,000 made by hand held the page for about four seconds.
 *  Past this the card shows the host's text, as it does for an older host. */
export const MAX_ROWS = 50;

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

/** A row's `summary`, when it is one the card can draw in a value's place:
 *  a text on one line, of at most `SUMMARY_MAX` characters. Anything else is
 *  no summary at all, and the row folds to its size as a row without one
 *  does. It never costs the rows: a summary the card leaves out hides
 *  nothing, because the value it stood for is still there to open. */
export function rowSummary(raw: unknown): string | undefined {
  if (!said(raw) || /[\n\r\u2028\u2029]/.test(raw)) return undefined;
  // Characters, not the units they are stored in. Twice the limit in units
  // is past it however they pair up, and is not worth counting.
  if (raw.length > SUMMARY_MAX * 2) return undefined;
  return [...raw].length <= SUMMARY_MAX ? raw : undefined;
}

function changeRow(raw: unknown): ChangeRow | null {
  if (!isBag(raw) || !said(raw.label)) return null;
  if (hasOnly(raw, ["label", "value"])) {
    return said(raw.value) ? { label: raw.label, value: raw.value } : null;
  }
  // The one key a stated value may have besides its own, read on its own
  // terms: a summary the card cannot draw is left out, and the row is kept.
  if (hasOnly(raw, ["label", "value", "summary"])) {
    if (!said(raw.value)) return null;
    const summary = rowSummary(raw.summary);
    return summary === undefined
      ? { label: raw.label, value: raw.value }
      : { label: raw.label, value: raw.value, summary };
  }
  // A move has no such key. The host never sends one there, so one that
  // turns up is a key the card does not know, like any other.
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
 *  before and an after, and no key besides but `summary`. `null` for
 *  anything else, an
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
  // More rows than a change has fields is not a change the card can lay out:
  // the text says it instead, folded like any other.
  if (raw.rows.length > MAX_ROWS) return null;
  const rows: ChangeRow[] = [];
  for (const item of raw.rows) {
    const row = changeRow(item);
    if (!row) return null;
    rows.push(row);
  }
  return { lead: raw.lead, rows };
}

/** The arguments that are a script: text a shell or an interpreter runs as
 *  written. `command` is Bash and Codex's `command_execution`; `script` and
 *  `code` are what MCP tools that run something call theirs. */
const COMMAND_KEYS = ["command", "script", "code"] as const;

/** Whether a detail is something that runs, as against something to read. */
export function isCommand(detail: AskDetail | null): boolean {
  return !!detail && (COMMAND_KEYS as readonly string[]).includes(detail.label);
}

export function askDetail(input: Record<string, unknown> | null | undefined): AskDetail | null {
  const bag = input ?? {};
  const read = (key: string): string => {
    const v = bag[key];
    // Arguments stream in as JSON fragments, so an empty string is a value that
    // has not arrived yet rather than a value of its own.
    return typeof v === "string" ? v : "";
  };

  // What will be run, under the names tools give it. Each is drawn by the
  // command's rule (`isCommand`): whole on the card, never as a first line.
  for (const key of COMMAND_KEYS) {
    if (read(key)) return { label: key, body: read(key) };
  }
  // A change to the registered agents, worded by the host (`team_tools`), and
  // the plan `ExitPlanMode` asks to have approved: the thing being decided.
  if (read("change")) return { label: "change", body: read("change") };
  if (read("plan")) return { label: "plan", body: read("plan") };
  if (read("content")) return { label: "content", body: read("content") };
  // Present-but-empty counts here, where it does not above: an edit whose
  // replacement is the empty string is a deletion, and "replacing with" over a
  // blank body is exactly what happened. Only the KEY being absent means there
  // is nothing to say.
  if (typeof bag.new_string === "string") {
    return { label: "replacing with", body: bag.new_string };
  }
  return null;
}

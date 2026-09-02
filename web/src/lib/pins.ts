// The files worth opening, chosen by the agent rather than guessed at.
//
// This column used to be a SCRAPER. It read every path-shaped word out of the
// transcript — tool arguments and prose both — asked the backend which of them
// existed, and listed the survivors newest-first. It worked, and it answered
// the wrong question: "what did this chat touch" is a log, and a log of forty
// files is a thing nobody opens. What you actually want to know is which two
// of them to read, and the only party in the conversation who knows that is
// the agent.
//
// So the agent says. `pin_file` (scripts/mcp) takes a path, one line of why,
// and optionally a label to tag it with and the line to land on. It calls
// nothing — the tool call itself travels down the chat
// stream, and this file reads the newest one back out of it. Nothing to fetch,
// nothing to store, and it survives a reload for free because the transcript
// does.
//
// A pin is the ONLY way a file reaches the column. There was briefly a second
// kind of row — the files a `Write` or an `Edit` had touched, added unasked on
// the grounds that changing a file is already a claim that it matters. It was
// a hedge against an agent that never pins, and it brought the log back in
// miniature: a refactor across nine files filled the column with nine names
// and no reasons, which is what the scraper was deleted for. Editing a file is
// now worth exactly what reading one is — nothing, until the agent says so.
// The tool's own description asks it to pin what it changed.
import type { Message } from "./chat";

/** Both spellings of our tool: through MCP, and bare. */
const PIN_TOOLS = new Set(["mcp__octiq__pin_file", "pin_file"]);

/** How many rows the column holds. Past two dozen it has stopped being "what
 *  to read" and gone back to being the log this file replaced. A backstop
 *  only — the tool's description already asks for a short list. */
const MAX_PINS = 25;

/** How long a label may be before it has stopped being one. A tag is a word or
 *  two; the sentence goes in `why`, which has a whole line to itself. Cut here
 *  rather than in CSS so that what the row shows is what this file says it
 *  shows. */
const MAX_LABEL = 24;

export type Pin = {
  /** As the agent gave it: absolute, or relative to the project root. Resolved
   *  against the filesystem by the panel, which drops what does not exist. */
  path: string;
  /** A word or two putting the file in a bucket — "the bug", "entry point",
   *  "spec". Free text, because a fixed vocabulary would be ours and the
   *  buckets worth having are the ones this particular piece of work has. */
  label?: string;
  /** One line on why it is worth opening. */
  why?: string;
  /** The line to land on, when one place in the file is the point. */
  line?: number;
};

export function pinPaths(pins: Pin[]): string[] {
  return pins.map((p) => p.path);
}

/**
 * The column, as it should look right now: the newest list the agent sent, in
 * the order it sent it, because it ranked them.
 */
export function latestPins(messages: Message[]): Pin[] {
  return newestPinCall(messages).slice(0, MAX_PINS);
}

/** The newest `pin_file` call in the conversation, read as a list.
 *
 *  Backwards, and only from the MAIN agent's turns: a subagent pins what
 *  mattered to the one errand it was given, and letting that through would
 *  replace the column with one step of the work.
 *
 *  A call still being written has no arguments yet, and is stepped over rather
 *  than read as an empty list — the column stays up instead of blinking out
 *  and in again while the new one arrives. An EMPTY list IS a real answer,
 *  though: `readPins` gives [] for that and null only for "nothing to read". */
function newestPinCall(messages: Message[]): Pin[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.parent) continue;
    for (let j = message.blocks.length - 1; j >= 0; j -= 1) {
      const block = message.blocks[j];
      if (block.kind !== "tool") continue;
      if (!PIN_TOOLS.has(block.name.toLowerCase())) continue;
      const pins = readPins(block.args);
      if (pins) return pins;
    }
  }
  return [];
}

function readPins(args: unknown): Pin[] | null {
  if (!args || typeof args !== "object") return null;
  const raw = (args as { files?: unknown }).files;
  if (!Array.isArray(raw)) return null;
  const out: Pin[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as { path?: unknown; label?: unknown; why?: unknown; line?: unknown };
    const path = typeof row.path === "string" ? row.path.trim() : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const label = readLabel(row.label);
    const why = typeof row.why === "string" ? row.why.trim() : "";
    // A line number is only kept when it is one — a string, a float or a
    // negative would open the file somewhere surprising, and no anchor at all
    // is the better failure.
    const line = typeof row.line === "number" && Number.isInteger(row.line) && row.line > 0
      ? row.line
      : undefined;
    out.push({
      path,
      ...(label ? { label } : {}),
      ...(why ? { why } : {}),
      ...(line ? { line } : {}),
    });
  }
  return out;
}

/** The tag on a row, or nothing.
 *
 *  A label that runs long is cut rather than dropped: an agent that wrote a
 *  sentence here still meant something by it, and the first few words of that
 *  sentence are a usable tag. Newlines are flattened — the chip is one line,
 *  and a label that wrapped would push the reason under it out of line with
 *  every other row. */
function readLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL).trimEnd()}…` : flat;
}


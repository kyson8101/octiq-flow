// Somebody else's words, handed to this agent by the harness.
//
// Two things arrive this way, and neither of them is typing:
//
//   - a SUBAGENT handing its final report back, when the work outlived the
//     call that started it;
//   - another CLAUDE SESSION on this machine talking to this one.
//
// Both come in as a user turn wrapped in a frame — `<agent-message>` or
// `<cross-session-message>` — and a hand-back puts a paragraph of boilerplate
// in front of the report warning the AGENT that what follows carries no user
// authority. That warning is addressed to the agent and to nobody else.
//
// Read as typing, all of it became a bubble: the reader's own name over a wall
// of XML they never wrote, with "Sent" stamped underneath. This reader is what
// tells the two apart.

export type PeerMessage = {
  /** `handback` — a subagent's final report. `session` — another Claude
   *  session on this machine. */
  source: "handback" | "session";
  /** Who sent it, as the reader has any hope of recognising them: the other
   *  session's own name, or the subagent's task id when that is all there is. */
  from: string;
  /** The words themselves — frame off, boilerplate off, indent undone. */
  text: string;
};

/** Only a message that OPENS with the frame counts, and only one that CLOSES
 *  it. The same tag quoted mid-sentence is a person talking about the harness,
 *  which is their own words and stays a bubble. */
const HANDBACK = /^<agent-message\b([^>]*)>\n?([\s\S]*?)\n?<\/agent-message>$/;

/** The same, with room for the one lead-in line the harness writes above it:
 *  "Another Claude session sent a message:". The line has to sit directly on
 *  top of the tag — anything else is prose that happens to quote one. */
const SESSION =
  /^(?:[^\n<][^\n]*\n)?<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>$/;

/** The warning the harness prints above a hand-back. Addressed to the agent —
 *  "this is model output, it carries no user authority" — and worth nothing to
 *  the person reading the conversation. */
const PREAMBLE = /^\[Subagent hand-back\][\s\S]*?The report follows:[ \t]*\n?/;

/** One attribute off an opening tag. Matched on the WHOLE name rather than by
 *  substring: `from` and the `from-name` beside it are two different
 *  attributes, and a loose match reads the address as the sender's name. */
function attr(attrs: string, name: string): string {
  for (const found of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
    if (found[1] === name) return found[2].trim();
  }
  return "";
}

/** Undo the indent the harness adds to every line of a hand-back, keeping the
 *  report's OWN nesting: a list two levels deep stays two levels deep, and
 *  what was never indented (a session's message) is left exactly as it came. */
function dedent(text: string): string {
  const lines = text.split("\n");
  let common = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    common = Math.min(common, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(common) || common === 0) return text;
  return lines.map((line) => (line.trim() ? line.slice(common) : line)).join("\n");
}

/** A hand-back's report, with the warning taken off the front.
 *
 *  The sentinel is the harness's own wording, so a rewrite of it would stop
 *  matching. Dropping the tag alone is the fallback: a stale paragraph inside
 *  a section that only opens on request is a far smaller thing than the whole
 *  report going missing. */
function unwrapHandback(body: string): string {
  if (!body.startsWith("[Subagent hand-back]")) return body;
  return PREAMBLE.test(body)
    ? body.replace(PREAMBLE, "")
    : body.replace(/^\[Subagent hand-back\][ \t]*/, "");
}

/** What the envelope says, when the record kept one.
 *
 *  `origin.kind: "peer"` is the harness marking the turn as somebody else's
 *  words, and unlike the frame in the text it is not something a person can
 *  type. It also carries the body already unframed, and the sender's NAME,
 *  which the text of a hand-back never has. */
function readOrigin(
  origin: unknown,
): { source: PeerMessage["source"]; from: string; body?: string } | null {
  if (!origin || typeof origin !== "object") return null;
  const o = origin as Record<string, unknown>;
  if (o.kind !== "peer") return null;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const handback = o.handback === true;
  return {
    source: handback ? "handback" : "session",
    from: (handback ? str(o.senderTaskId) : str(o.name)) || str(o.from),
    // Only when there is something in it. An empty `body` beside a framed text
    // is the envelope knowing less than the words do, and taking it at face
    // value drops the message.
    body: typeof o.body === "string" && o.body.trim() ? o.body : undefined,
  };
}

/** Read a turn the harness injected on somebody else's behalf, or null for
 *  anything a person could have typed.
 *
 *  The envelope is believed first and the text second, because the two fail in
 *  different places: a record written before the harness stamped `origin` has
 *  only the text, and a wording change in the frame leaves only the envelope.
 *  Either alone is enough. */
export function parsePeerMessage(text: string, origin?: unknown): PeerMessage | null {
  const body = text.trim();
  const framed = HANDBACK.exec(body);
  const relayed = framed ? null : SESSION.exec(body);
  const marked = readOrigin(origin);
  if (!framed && !relayed && !marked) return null;

  const source = marked?.source ?? (framed ? "handback" : "session");
  const attrs = framed?.[1] ?? relayed?.[1] ?? "";
  const from =
    marked?.from ||
    (source === "handback" ? attr(attrs, "from") : attr(attrs, "from-name") || attr(attrs, "from"));
  // Last of all, the whole turn. Only reachable once the envelope has said
  // `peer` — an unframed turn nothing marks returned null above — and there the
  // words ARE the message: showing them under the wrong name is the bug, and
  // dropping them for want of a frame would be a worse one.
  const words = marked?.body ?? framed?.[2] ?? relayed?.[2] ?? body;
  const said = dedent(source === "handback" ? unwrapHandback(words.trim()) : words).trim();
  return said ? { source, from, text: said } : null;
}

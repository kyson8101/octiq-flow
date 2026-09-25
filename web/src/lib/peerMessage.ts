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

/** The one lead-in line the harness writes above a cross-session frame:
 *  "Another Claude session sent a message:". Only directly above the tag, and
 *  only once — a prose line anywhere else is a person talking. */
const LEAD_IN = /^[^\n<][^\n]*\n(?=<cross-session-message\b)/;

/** A frame opening the text. */
const OPEN = /^<(agent-message|cross-session-message)\b([^>]*)>\n?/;

/** Its close, and ONLY at column zero.
 *
 *  This is the harness's own guarantee — it indents every line of a report so
 *  that no line inside can pose as the frame — and the reader has to hold it
 *  for the guarantee to be worth anything. Matched anywhere, a report that
 *  merely QUOTES its own closing tag ends there, and everything the subagent
 *  said after it is dropped with no error. A review of this very file is
 *  exactly such a report. */
const closeOf = (tag: string) => new RegExp(`(?:^|\\n)</${tag}>`);

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

/** One frame, as it sits in the text. */
type Frame = { tag: string; attrs: string; body: string };

/** Every frame the text is made of, or none when it is not made of frames.
 *
 *  Three rules, and each one is a way this has been wrong:
 *
 *  * The text must OPEN with a frame. A tag quoted mid-sentence is a person
 *    talking about the harness.
 *  * A frame CLOSES at column zero, so a report quoting its own closing tag is
 *    not cut off there.
 *  * What is left over after the last frame must be MARKUP, not prose. The
 *    harness bolts things on — a reminder, a second frame — so the close is
 *    not always the end of the turn; but a turn that carries a person's own
 *    words after it is a person's turn, and reading it as a peer's would
 *    delete what they wrote and put a stranger's name on the rest. */
function frames(text: string): Frame[] {
  const found: Frame[] = [];
  let rest = text.replace(LEAD_IN, "");
  while (rest) {
    const open = OPEN.exec(rest);
    if (!open) break;
    const after = rest.slice(open[0].length);
    const close = closeOf(open[1]).exec(after);
    if (!close) return [];
    found.push({ tag: open[1], attrs: open[2], body: after.slice(0, close.index) });
    rest = after.slice(close.index + close[0].length).trimStart();
  }
  // Prose left over, or a frame that never opened: not a peer turn at all.
  return rest && !rest.startsWith("<") ? [] : found;
}

/** What one frame says. */
function read(frame: Frame): PeerMessage | null {
  const source = frame.tag === "agent-message" ? "handback" : "session";
  const from =
    source === "handback"
      ? attr(frame.attrs, "from")
      : attr(frame.attrs, "from-name") || attr(frame.attrs, "from");
  const said = dedent(source === "handback" ? unwrapHandback(frame.body.trim()) : frame.body).trim();
  return said ? { source, from, text: said } : null;
}

/** Read a turn the harness injected on somebody else's behalf. Empty for
 *  anything a person could have typed.
 *
 *  The envelope is believed first and the text second, because the two fail in
 *  different places: a record written before the harness stamped `origin` has
 *  only the text, and a wording change in the frame leaves only the envelope.
 *  Either alone is enough.
 *
 *  A LIST, because one turn can carry more than one frame — two subagents
 *  reporting back at once. Returning only the first dropped the second
 *  entirely, and a report that never arrives is worse than one drawn wrongly. */
export function parsePeerMessages(text: string, origin?: unknown): PeerMessage[] {
  const body = text.trim();
  const marked = readOrigin(origin);
  const found = frames(body);

  if (marked) {
    // The envelope names ONE sender, so it speaks for one message. Its body is
    // the unframed words; failing that the frame's, failing that the whole
    // turn — which is all there is when the harness stopped framing.
    const said = marked.body ?? (found.length === 1 ? found[0].body : undefined) ?? body;
    const words = dedent(
      marked.source === "handback" ? unwrapHandback(said.trim()) : said,
    ).trim();
    if (words) return [{ source: marked.source, from: marked.from, text: words }];
  }
  return found.map(read).filter((m): m is PeerMessage => m !== null);
}

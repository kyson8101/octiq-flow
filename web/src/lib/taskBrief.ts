// A task's first message in agents mode: the person's words, then the lead's
// brief. Pure, so the chat store can read it without pulling in the bridge.

// Kept in step with `team::BRIEF_MARK`.
const BRIEF_MARK = "\n\n=== OctiqFlow agents mode ===\n";

/** A task message split into what the person typed and who it went to, or
 *  `undefined` for an ordinary message. The brief after the mark is for the
 *  agent only. */
export function readTaskBrief(text: string): { task: string; lead: string } | undefined {
  const at = text.indexOf(BRIEF_MARK);
  if (at < 0) return undefined;
  const rest = text.slice(at + BRIEF_MARK.length);
  const lead = /^Lead: (.+)$/m.exec(rest)?.[1]?.trim() ?? "";
  return { task: text.slice(0, at), lead };
}

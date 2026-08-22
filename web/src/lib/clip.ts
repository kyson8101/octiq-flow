// Cutting a long message down to what fits.
//
// You paste a stack trace, a whole file, an error log — and the bubble becomes
// a wall the reply is buried under. Scrolling back through your own paste to
// find what the agent said about it is the part that hurts, so a long message
// is shown down to a readable head with a "show more" under it.
//
// The cut is made on the TEXT, not with a CSS height. A height clamp has to
// guess whether anything was actually hidden, and guessing wrong leaves a
// button that expands nothing; cutting the text knows.

/** Roughly how many characters fit on one line of a message bubble. The bubble
 *  is 85% of a 780px column at ~13px, which lands near here. */
const WRAP = 88;

/** How many lines of your own message stay on screen. */
const MAX_ROWS = 12;

/** Below this, showing the whole thing beats a button: a "show more" that
 *  reveals two lines is only a click in the way. */
const MIN_HIDDEN_ROWS = 3;

export type Clip = {
  /** What to show. The whole text when nothing was cut. */
  head: string;
  clipped: boolean;
};

/** The rows a line really takes on screen — a pasted paragraph is one line and
 *  half a screen. */
const rows = (line: string) => Math.max(1, Math.ceil(line.length / WRAP));

/** Cut one over-long line at the last word inside `max`, so the head does not
 *  end mid-word. A line with no space in it (a url, a base64 blob) is cut
 *  where it falls. */
function cutLine(line: string, max: number): string {
  const slice = line.slice(0, max);
  const space = slice.lastIndexOf(" ");
  return (space > max * 0.6 ? slice.slice(0, space) : slice).trimEnd();
}

/** How much of `text` to show, and whether anything was held back. */
export function clipMessage(text: string): Clip {
  const lines = text.split("\n");
  const total = lines.reduce((n, line) => n + rows(line), 0);
  if (total <= MAX_ROWS + MIN_HIDDEN_ROWS) return { head: text, clipped: false };

  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    const r = rows(line);
    if (used + r > MAX_ROWS) {
      // The very first line is already longer than the whole budget: cut
      // inside it rather than showing nothing at all.
      if (!head.length) head.push(cutLine(line, MAX_ROWS * WRAP));
      break;
    }
    head.push(line);
    used += r;
  }

  return { head: head.join("\n").trimEnd(), clipped: true };
}

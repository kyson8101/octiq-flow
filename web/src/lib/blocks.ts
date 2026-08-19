// Splitting a reply into the pieces markdown actually cares about.
//
// Rendering a streaming answer re-parses the WHOLE text on every delta. Early
// in a reply that is free; by the time the agent is a thousand words in, every
// few characters costs a full re-parse and a full reconciliation of everything
// already on screen — and it is exactly then, when the reply is long and the
// reader is following along, that the stutter shows.
//
// Almost none of that work is needed. Markdown is a sequence of independent
// top-level blocks, and only the LAST one is still being written. Split the
// text, render each block separately, and settled blocks stop re-rendering.
//
// ## Why a hand-written splitter
//
// It only has to find block BOUNDARIES, not parse markdown — react-markdown
// still does the real work on each piece. That is one rule (a blank line) plus
// the exceptions where a blank line does not end anything.

/** A fence opener or closer: ``` or ~~~, optionally indented, with an
 *  optional language after it. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

/** Splits `text` into top-level markdown blocks, in order.
 *
 *  Joining the result with "\n\n" is NOT guaranteed to reproduce the input
 *  byte for byte — the separators themselves are dropped — but each block
 *  renders to exactly what it would have rendered to in place, which is the
 *  only property that matters here. */
export function splitBlocks(text: string): string[] {
  if (!text) return [];

  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  // The fence we are inside, if any. Markdown requires the closer to be at
  // least as long as the opener and the same character, which is what lets a
  // ``` appear inside a ~~~~ block.
  let fence: { marker: string; length: number } | null = null;

  const flush = () => {
    if (current.length) {
      blocks.push(current.join("\n"));
      current = [];
    }
  };

  for (const line of lines) {
    const match = FENCE.exec(line);

    if (fence) {
      current.push(line);
      // A closer is the same character, at least as long, and carries nothing
      // after it.
      if (
        match &&
        match[1][0] === fence.marker &&
        match[1].length >= fence.length &&
        !match[2].trim()
      ) {
        fence = null;
        flush();
      }
      continue;
    }

    if (match) {
      // A fence starts a block of its own, so prose above it is not swallowed.
      flush();
      fence = { marker: match[1][0], length: match[1].length };
      current.push(line);
      continue;
    }

    // A blank line ends a block — the one rule this all rests on.
    if (!line.trim()) {
      flush();
      continue;
    }

    current.push(line);
  }

  // Whatever is left, fence still open or not. A half-written fence has to be
  // rendered as it stands: it is the block currently being typed.
  flush();
  return blocks;
}

/** Close a fence left open by a half-arrived block.
 *
 *  Without this a reply that has just opened ``` renders its remaining text as
 *  prose, then flips to a code block the moment the closer arrives — the whole
 *  paragraph changing shape under the reader. */
export function closeFence(block: string): string {
  const lines = block.split("\n");
  let fence: { marker: string; length: number } | null = null;
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (!match) continue;
    if (!fence) {
      fence = { marker: match[1][0], length: match[1].length };
    } else if (match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) {
      fence = null;
    }
  }
  return fence ? `${block}\n${fence.marker.repeat(fence.length)}` : block;
}

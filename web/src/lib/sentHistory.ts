// Sent-message history for the composer (moved verbatim from Composer.tsx).

/** How many past messages Up can reach. Enough to find the thing you sent a
 *  few minutes ago, few enough to stay small in storage. */
export const HISTORY_MAX = 100;

/** Input history is PER CHAT.
 *
 *  One shared list meant pressing Up in a chat about the payroll migration
 *  offered what you last typed at a novel — recall is only useful when what
 *  comes back belongs to the conversation you are in. Chats with no id yet
 *  (a new one, before it is saved) share a scratch list rather than writing
 *  into somebody else's. */
function historyKey(session?: string): string {
  return `octiq.v2.history:${session || "new"}`;
}

export function loadHistory(session?: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(historyKey(session)) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveHistory(session: string | undefined, list: string[]): void {
  try {
    localStorage.setItem(historyKey(session), JSON.stringify(list));
  } catch {
    /* storage blocked: history lasts this session only */
  }
}

export type HistoryDirection = "older" | "newer";

/** Move through sent-message history without losing the words that were in
 *  progress when browsing began. Shared by keyboard arrows and the phone's
 *  touch controls so they cannot drift into two subtly different histories. */
export function moveInHistory(
  history: readonly string[],
  index: number,
  text: string,
  draft: string,
  direction: HistoryDirection,
): { index: number; text: string; draft: string } {
  if (direction === "older") {
    if (!history.length) return { index, text, draft };
    const next = Math.min(index + 1, history.length - 1);
    return {
      index: next,
      text: history[next],
      draft: index === -1 ? text : draft,
    };
  }

  if (index < 0) return { index, text, draft };
  const next = index - 1;
  return {
    index: next,
    text: next < 0 ? draft : history[next],
    draft,
  };
}

/** What the box says once messages taken back out of the queue are put in it.
 *
 *  They go at the END, after whatever is already there. Two reasons, and they
 *  point the same way: a half-typed line in the box is NEWER than a message
 *  that was queued before it, and words arriving in two batches stay in the
 *  order they were sent rather than turning inside out.
 *
 *  A blank line between them, because each one was its own message and is
 *  about to be one again — run together, two paragraphs become a single prompt
 *  nobody wrote. */
export function withPutBack(current: string, words: readonly string[]): string {
  return [current.trim(), ...words.map((w) => w.trim())].filter(Boolean).join("\n\n");
}

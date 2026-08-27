// Writing a setting down, when there is room to.
//
// `localStorage.setItem` THROWS when the origin is at its quota — about 5 MB in
// every browser, Safari included. That is not a rare corner here: the chat
// cache holds up to eighty transcripts (see `store.ts`), and on this machine it
// had grown to 4.09 MB of the 5 MB on its own. From there, writing four letters
// fails.
//
// Which would be survivable, if the write were the last thing a setting did.
// It was not. `changeEffort` read:
//
//     setEffort(e);
//     localStorage.setItem(EFFORT_KEY, e);          // ← throws here
//     if (agent === "claude" && tellSession(`/effort ${e}`)) return;
//
// so a full store did not merely forget the level — it threw before the line
// that TELLS THE AGENT, every time, silently. The picker moved, the chat went
// on thinking at the old level, and the next reload put the old word back. Not
// one `/effort` had ever reached an agent from this app; the transcripts have
// none.
//
// So no setting writes to storage directly any more. This is the whole of it:
// remembering is best-effort, failing is a `false`, and nothing a caller does
// after it can be skipped because the disk was full.

/** Write a setting down. Answers whether it will still be there next visit.
 *
 *  A `false` is worth acting on — the choice holds for this page and no
 *  longer — but it is never worth THROWING for: what the setting does matters
 *  more than whether it is remembered, and it is the doing that came after. */
export function remember(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // Over quota, or storage blocked outright (a private window, a browser set
    // to refuse site data). Both mean the same thing to a caller.
    return false;
  }
}

/** Read a setting back, or `null` when it was never written — or cannot be
 *  read at all, which is the same answer as far as anyone here is concerned. */
export function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Forget a setting. Same promise: it never throws. */
export function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to do — it is already as forgotten as this page can make it */
  }
}

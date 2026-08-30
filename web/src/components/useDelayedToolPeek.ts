// A live tool call can answer so quickly that its spinner only flashes for a
// frame. That movement says nothing useful and makes a short transcript feel
// noisy, so the live affordances wait briefly before arriving.
import { useEffect, useState } from "react";

export const TOOL_PEEK_DELAY_MS = 1_000;

/** True only after this particular running call has outlasted the quiet
 * threshold. Supplying no id (because the call completed) hides the affordance
 * synchronously, before the cleanup effect has a chance to run. */
export function useDelayedToolPeek(runningToolId?: string): boolean {
  const [shownFor, setShownFor] = useState<string>();

  useEffect(() => {
    if (!runningToolId) {
      setShownFor(undefined);
      return;
    }

    const timer = window.setTimeout(() => setShownFor(runningToolId), TOOL_PEEK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [runningToolId]);

  // When one call ends and the next begins, the previous id stays in state
  // until React runs the cleanup. Comparing the ids prevents its already-open
  // peek from leaking into the next call's first frame.
  return shownFor === runningToolId;
}

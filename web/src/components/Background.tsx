/** What is still running after the turn said it was finished.
 *
 *  A background command answers the instant it starts, so the card that ran it
 *  gets its tick straight away and the turn ends underneath. Every part of the
 *  screen is telling the truth about its own half, and together they say the
 *  work is done — which is how a `codex exec` with twenty minutes left to run
 *  ends up with nothing on screen saying so.
 *
 *  Two marks answer that, because they answer two different questions:
 *
 *    - the STRIP above the composer, for "is anything still going" — the
 *      question you ask when you have just come back to the chat, and the one
 *      the eyebrow used to answer only while a turn was in flight;
 *    - the CARD, for "which of these is still going" — the question you ask
 *      once the strip has told you something is. Its tick is held back and a
 *      pulsing `in background` put in its place, until the ending lands.
 *
 *  The card's half rides on a context rather than a prop. It is read four
 *  levels down, past a grouping pass that rebuilds its rows from scratch, and
 *  threading a set of ids through all of that would put this file's business in
 *  three components that have none of it.
 */
import { createContext, useContext, useEffect, useState } from "react";

import { backgroundSummary, type BackgroundTask } from "../lib/background";
import { elapsedLabel } from "../lib/working";

const RunningCalls = createContext<ReadonlySet<string>>(new Set());

export const BackgroundProvider = RunningCalls.Provider;

/** True when this call started work that has not reported back yet. */
export function useStillRunning(toolUseId: string): boolean {
  return useContext(RunningCalls).has(toolUseId);
}

/** Every such call, for the grouping pass — a card with work still running
 *  under it is kept OUT of a folded run, for the same reason a failed one is:
 *  a row that says `9 calls · done` must not be hiding the one call the reader
 *  is waiting on. */
export function useRunningCalls(): ReadonlySet<string> {
  return useContext(RunningCalls);
}

/** The strip. Draws nothing at all when nothing is running, so an ordinary
 *  chat never grows a row it has no news for. */
export function BackgroundStrip({ tasks }: { tasks: BackgroundTask[] }) {
  // Its own second hand. Nothing on the stream ticks while a background command
  // runs — that is the whole complaint — so a clock fed by events would sit
  // still for twenty minutes and read as the stall it is meant to rule out.
  const [, tick] = useState(0);
  useEffect(() => {
    if (tasks.length === 0) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [tasks.length]);

  const summary = backgroundSummary(tasks, Date.now());
  if (!summary) return null;
  return (
    <div className="bgwork" role="status">
      <span className="bgwork-dot" aria-hidden="true" />
      <span className="bgwork-count">
        {summary.count === 1 ? "still running" : `${summary.count} still running`}
      </span>
      <span className="bgwork-label" title={summary.label}>
        {summary.label}
      </span>
      <span className="bgwork-time">{elapsedLabel(summary.elapsedMs)}</span>
    </div>
  );
}

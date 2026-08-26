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
 *    - the DOT on the status line above the composer, for "is anything still
 *      going" — the question you ask when you have just come back to the chat,
 *      and the one the eyebrow used to answer only while a turn was in flight;
 *    - the CARD, for "which of these is still going" — the question you ask
 *      once the dot has told you something is. Its tick is held back and a
 *      pulsing `in background` put in its place, until the ending lands.
 *
 *  The card's half rides on a context rather than a prop. It is read four
 *  levels down, past a grouping pass that rebuilds its rows from scratch, and
 *  threading a set of ids through all of that would put this file's business in
 *  three components that have none of it.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

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

/** The dot, drawn INSIDE the status line above the composer rather than on a
 *  row of its own. It wraps that line's own words — the three pieces are one
 *  sentence, and only this knows whether there is anything to add to it — so a
 *  chat with nothing running gets exactly the line it always had.
 *
 *  The dot says "still running" without the words: it is the one moving thing
 *  on the row, and it is warn-coloured to match the card's own `in background`
 *  chip, so the two are visibly the same news.
 *
 *  A running turn already ticks a clock on this line, so nothing here adds a
 *  second one. Once the turn ends that clock goes with it, and the size of the
 *  wait is then the whole news, so the background's own takes the line. */
export function BackgroundNote({
  tasks,
  busy,
  children,
}: {
  tasks: BackgroundTask[];
  busy: boolean;
  children: ReactNode;
}) {
  // Its own second hand, and only while it is the one drawing a clock. Nothing
  // on the stream ticks while a background command runs — that is the whole
  // complaint — so a clock fed by events would sit still for twenty minutes and
  // read as the stall it is meant to rule out.
  const [, tick] = useState(0);
  const own = tasks.length > 0 && !busy;
  useEffect(() => {
    if (!own) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [own]);

  const summary = backgroundSummary(tasks, Date.now());
  if (!summary) return <>{children}</>;
  // The oldest run is named; the rest are a number after it. Nothing else fits
  // on a line that already has a turn's worth of news on it.
  const label =
    summary.count === 1 ? summary.label : `${summary.label} +${summary.count - 1}`;
  return (
    <>
      <span className="bgwork-dot" aria-hidden="true" />
      {busy && <>{children} · </>}
      <span className="bgwork-said" role="status" title={label}>
        {label}
      </span>
      {!busy && (
        <>
          {" · "}
          <span className="bgwork-time">{elapsedLabel(summary.elapsedMs)}</span>
        </>
      )}
    </>
  );
}

// The clock a reopen hold's age is read on (`lib/taskHold`).
//
// A reopened task takes the warning colour once its notice has stayed
// unconfirmed for about a minute. That minute is counted on the page's own
// clock from when the page first saw the hold, never against the host's
// stamp, and nothing ticks for it: this hook sets one timer, for the moment
// the earliest hold that has not lasted yet does, and hands back the time
// it fired. A surface with nothing held sets no timer at all.
import { useEffect, useState } from "react";
import type { OrchestrationTask } from "./orchestration";
import { holdDue, seeHolds } from "./taskHold";

/** `now` for `taskHold`, on the page's clock. It moves once per hold, when
 *  that hold has lasted. `tasks` are the ledger's as the surface holds it. */
export function useHoldClock(tasks: readonly OrchestrationTask[] | undefined): number {
  const [now, setNow] = useState(Date.now);
  // The first sight of a hold is recorded as its ledger is drawn. The feed
  // records it as the ledger arrives too (`orchestrationFeed`), so a surface
  // opened later counts from then; doing it twice changes nothing.
  if (tasks) seeHolds(tasks, Date.now());
  // The moment to look again, as a time on the page's clock: the same value
  // on every render until that hold has lasted or is over.
  const left = tasks ? holdDue(tasks, now) : null;
  const at = left === null ? null : now + left;
  useEffect(() => {
    if (at === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()));
    return () => window.clearTimeout(timer);
  }, [at]);
  return now;
}

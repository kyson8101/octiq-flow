// One of the page's lists of what waits on the person, asked for on a
// connection: once, and once more after a failure.
//
// A list that fails is the host not saying, which is not the host saying
// "nothing": `lib/pendingActions` keeps a restored clock held until every
// list has answered (`wholeOf`). So one failure is not the end of it. The
// list is asked again a few seconds on, and only a second failure is "this
// list cannot be read on this connection", which the page then goes on
// without. It is not asked a third time: nothing polls, and an older host
// that lacks the command costs one extra request a connection.
//
// A request that neither answers nor fails is not this module's: it has
// nothing to retry. `pendingActions.SILENT_MS` bounds that wait.

/** How long after a failure a list is asked once more. */
export const RETRY_MS = 3_000;

/** Ask through `attempt`, and once more `retryMs` after a failure. `attempt`
 *  resolves true when its answer was taken, and false when a newer ask of
 *  the same list took its place (that one says how it went). `settled` is
 *  told once: true for an answer, false for the second failure. Returns the
 *  way to call it off, after which nothing is asked and nothing is told. */
export function readTwice(
  attempt: () => Promise<boolean>,
  settled: (answered: boolean) => void,
  retryMs: number = RETRY_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ask = (again: boolean) => {
    attempt().then(
      (taken) => { if (!stopped && taken) settled(true); },
      () => {
        if (stopped) return;
        if (!again) return settled(false);
        timer = setTimeout(() => { timer = null; ask(false); }, retryMs);
      },
    );
  };
  ask(true);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

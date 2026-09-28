/** Run `task` one at a time. A call made while it runs does not start another:
 *  every such call is folded into ONE rerun after the current run ends, which
 *  still sees whatever the calls were about. A burst of triggers costs two runs,
 *  not one per trigger.
 *
 *  This is what keeps `git-status-changed` from piling up. It can arrive every
 *  second, and a git read answering it can take longer than that; issuing one
 *  per event queued them on the backend faster than they finished.
 *
 *  The returned promise settles when the run covering the call has ended. It
 *  never rejects — `task` handles its own failures. */
export function singleFlight(task: () => Promise<unknown>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let rerun: { done: Promise<void>; resolve: () => void } | null = null;

  const start = (): Promise<void> => {
    // Started synchronously, as a direct call would be; a throw before its
    // first await is caught like any other failure.
    let started: Promise<unknown>;
    try {
      started = task();
    } catch {
      started = Promise.resolve();
    }
    const run: Promise<void> = Promise.resolve(started).then(handOver, handOver);
    current = run;
    return run;
  };

  // Runs as part of the run's own settling, BEFORE anything a caller chained
  // on the promise it was handed. The queued rerun therefore takes over in the
  // same step the old run lets go: there is no moment with nothing running
  // and a rerun still owed, which is the gap a chained call used to start a
  // second, overlapping run in.
  function handOver(): void {
    const queued = rerun;
    rerun = null;
    if (!queued) {
      current = null;
      return;
    }
    start().then(queued.resolve);
  }

  return () => {
    if (!current) return start();
    if (!rerun) {
      let resolve!: () => void;
      const done = new Promise<void>((yes) => { resolve = yes; });
      rerun = { done, resolve };
    }
    return rerun.done;
  };
}

/** A trigger that answers at once AND once more after the triggers stop.
 *
 *  Each call runs `run` straight away, and (re)arms one trailing run for
 *  `quietMs` after the LAST call. A burst therefore ends with exactly one
 *  extra run, however long it was, and a lone trigger costs two.
 *
 *  For an answer served from a cache the triggers cannot see: an ask landing
 *  while the cache is still fresh gets the old answer, and nothing would ask
 *  again. Give `quietMs` more than the cache's lifetime and the trailing run
 *  is guaranteed an answer newer than the last trigger. */
export function withTrailingRun(
  run: () => unknown,
  quietMs: number,
): { trigger: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    trigger: () => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, quietMs);
      run();
    },
    cancel,
  };
}

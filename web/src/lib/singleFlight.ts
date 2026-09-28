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
  let next: Promise<void> | null = null;

  const start = (): Promise<void> => {
    // Started synchronously, as a direct call would be; a throw before its
    // first await is caught like any other failure.
    let started: Promise<unknown>;
    try {
      started = task();
    } catch {
      started = Promise.resolve();
    }
    const run: Promise<void> = Promise.resolve(started)
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (current === run) current = null;
      });
    current = run;
    return run;
  };

  return () => {
    if (!current) return start();
    if (!next) {
      next = current.then(() => {
        next = null;
        return start();
      });
    }
    return next;
  };
}

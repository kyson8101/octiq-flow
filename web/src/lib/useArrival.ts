// The hooks over `lib/arrival`: the rules live there, tested; these only hold
// the record between renders.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ENTRY_MS, arrive, entryPhase, liveSince, type Arrivals, type Drawn, type EntryPhase } from "./arrival";

/** The keys that arrived after `scope` was first drawn.
 *
 *  Read and written during render, like `useJustArrived`: the class has to be
 *  on the element in the commit that mounts it, and an effect would be one
 *  frame late — the element would show at full strength and then start over.
 *
 *  A render React runs twice (a state set during render, StrictMode) folds
 *  the same keys in twice, and `arrive` hands the same record back the second
 *  time: nothing is marked that the first pass did not mark. That is what
 *  makes a ref written here safe, and it is `arrive`'s to keep (its test
 *  says so). A rule that answers "nothing changed" with anything but "the
 *  same" cannot be written this way: see `useLiveAppend`. */
export function useLateKeys(scope: string, keys: readonly string[]): ReadonlySet<string> {
  const record = useRef<Arrivals | null>(null);
  record.current = arrive(record.current, scope, keys);
  return record.current.late;
}

/** Whether one thing arrived after its place was first drawn. */
export function useLate(present: boolean, scope = ""): boolean {
  return useLateKeys(scope, present ? ONE : NONE).has("it");
}

const ONE = ["it"] as const;
const NONE = [] as const;

/** Whether the turns a transcript is drawing now were just said, as opposed
 *  to read back (`lib/arrival.liveSince`).
 *
 *  What it compares with is what was last COMMITTED, recorded in a layout
 *  effect and never during render: a render that runs twice gets the same
 *  answer both times, because nothing it does changes what it is asked
 *  against. The layout effect runs before the browser paints and before any
 *  later render, so the next render always sees this one. */
export function useLiveAppend(scope: string, ids: readonly string[]): boolean {
  const committed = useRef<Drawn | null>(null);
  const live = liveSince(committed.current, scope, ids);
  useLayoutEffect(() => {
    committed.current = { scope, ids };
  });
  return live;
}

/** A gate that opens once: `held` until `ready`, `entering` for the length of
 *  the entry, then `settled`. Ready at the first draw is `settled` outright.
 *
 *  One timer per opening, never a frame loop: it only takes the class off. */
export function useEntry(ready: boolean, scope = ""): EntryPhase {
  const first = useRef({ scope, ready });
  if (first.current.scope !== scope) first.current = { scope, ready };
  const [done, setDone] = useState<string | null>(null);
  const phase = entryPhase(first.current.ready, ready, done === scope);
  useEffect(() => {
    if (phase !== "entering") return;
    const timer = setTimeout(() => setDone(scope), ENTRY_MS);
    return () => clearTimeout(timer);
  }, [phase, scope]);
  return phase;
}

/** The class for a gate: `gate-held`, `gate-entering`, or none. */
export function entryClass(phase: EntryPhase): string {
  return phase === "settled" ? "" : `gate-${phase}`;
}

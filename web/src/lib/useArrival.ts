// The hooks over `lib/arrival`: the rules live there, tested; these only hold
// the record between renders.
import { useEffect, useRef, useState } from "react";
import { ENTRY_MS, arrive, entryPhase, type Arrivals, type EntryPhase } from "./arrival";

/** The keys that arrived after `scope` was first drawn.
 *
 *  Read and written during render, like `useJustArrived`: the class has to be
 *  on the element in the commit that mounts it, and an effect would be one
 *  frame late — the element would show at full strength and then start over. */
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

import { useInsertionEffect, useMemo, useRef, type DependencyList } from "react";

type Callback = (...args: any[]) => any;

// This factory MUST live outside the caller's render scope. V8 shares that
// scope between its closures: callbacks with different dependency lifetimes
// can otherwise chain old renders, retaining every ledger and transcript.
function forward<T extends Callback>(cell: { current: T }): T {
  return ((...args: Parameters<T>) => cell.current(...args)) as T;
}

/** A callback whose identity follows deps, but whose body is the latest
 * committed render. Old callback identities keep only this hook's cell, never
 * an old App render. Dependency changes still re-run subscribing effects.
 * Commit before layout effects (including children's), without publishing an
 * abandoned/suspended render's callback. An invocation already in flight keeps
 * its own arguments and async continuation, as usual. */
export function useCommittedCallback<T extends Callback>(callback: T, deps: DependencyList): T {
  const cell = useRef(callback);
  useInsertionEffect(() => { cell.current = callback; });
  return useMemo(() => forward(cell), deps);
}

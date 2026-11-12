import { createContext, useContext, useMemo, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { chatReadingStates, type ChatReadingState, type ReadingValue } from "./chatReadingState";

export const ReadingStateContext = createContext<{ state?: ChatReadingState; path: string }>({ path: "" });

export function ChatReadingProvider({ id, scope = "", children }: { id?: string; scope?: string; children: ReactNode }) {
  const state = id ? chatReadingStates.open(id) : undefined;
  const value = useMemo(() => ({ state, path: scope }), [state, scope]);
  return <ReadingStateContext.Provider value={value}>{children}</ReadingStateContext.Provider>;
}

/** Stable transcript identities, rather than mount-order/useId identities. */
export function ReadingScope({ id, children }: { id: string | number; children: ReactNode }) {
  const parent = useContext(ReadingStateContext);
  const value = useMemo(() => ({ state: parent.state, path: JSON.stringify([parent.path, id]) }), [parent, id]);
  return <ReadingStateContext.Provider value={value}>{children}</ReadingStateContext.Provider>;
}

/** Opt-in presentation state. Without a transcript provider this is useState;
 * action/pending/consent state must continue to use ordinary component state. */
export function useReadingState<T extends ReadingValue>(name: string, initial: T | (() => T)): [T, (next: SetStateAction<T>) => void] {
  const { state, path } = useContext(ReadingStateContext);
  const key = JSON.stringify([path, name]);
  const start = () => {
    const saved = state?.get<T>(key);
    return saved !== undefined ? saved : typeof initial === "function" ? initial() : initial;
  };
  let [held, setHeld] = useState(() => ({ state, key, value: start() }));
  if (held.state !== state || held.key !== key) {
    held = { state, key, value: start() };
    setHeld(held);
  }
  const current = useRef(held.value);
  current.current = held.value;
  return [held.value, next => {
    const value = typeof next === "function" ? next(current.current) : next;
    current.current = value;
    state?.set(key, value);
    setHeld({ state, key, value });
  }];
}

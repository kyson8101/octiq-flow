import { useEffect, useRef, useState } from "react";
import { observeInterruptions, type InterruptionInput } from "./interruptions";

export function useInterruptedChats(input: InterruptionInput): ReadonlySet<string> {
  const since = useRef<ReadonlyMap<string, number>>(new Map());
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const { chats, running, activeRounds, rooms, known } = input;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const now = Date.now();
      const observed = observeInterruptions(since.current, { chats, running, activeRounds, rooms, known }, now);
      since.current = observed.missing;
      setIds((previous) => previous.size === observed.interrupted.size
        && [...previous].every((id) => observed.interrupted.has(id)) ? previous : observed.interrupted);
      if (observed.nextCheck !== undefined) timer = setTimeout(refresh, Math.max(1, observed.nextCheck - now));
    };
    refresh();
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [chats, running, activeRounds, rooms, known]);
  // A resolved turn or new connection must clear synchronously, before effects.
  return new Set([...ids].filter((id) => known && chats[id]?.busy && !chats[id]?.stopping
    && !running.has(id) && !activeRounds.has(id)
    && ![...running].some((key) => key.startsWith(`${id}-seat-`))));
}

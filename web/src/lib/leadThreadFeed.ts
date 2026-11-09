import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import type { IndexEntry } from "./chatIndex";
import type { LeadThread, LeadHistoryEntry, LeadThreadsReading } from "./leadThreads";

export const openLeadThread = (agentId: string) => bridge.invoke<IndexEntry>("lead_thread_open", { agentId });
export const readLeadHistory = (agentId: string) => bridge.invoke<LeadHistoryEntry[]>("lead_history", { agentId });

/** One owner in App. Reconnect/roster changes reread identities; index changes
 * only matter when a lead thread is created. Ordinary activity is App's reading. */
export function useLeadThreads(enabled: boolean): LeadThreadsReading {
  const [reading, setReading] = useState<LeadThreadsReading>({ threads: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let alive = true, revision = 0;
    const read = async () => {
      const at = ++revision;
      try {
        const threads = await bridge.invoke<LeadThread[]>("lead_threads");
        if (alive && at === revision) setReading({ threads, error: null });
      } catch (error) {
        if (alive && at === revision) setReading(before => ({ ...before, error: String((error as Error).message ?? error) }));
      }
    };
    const off = bridge.on("team-changed", () => void read());
    const offIndex = bridge.on<{ id?: string }>("chat-index-changed", change => {
      if (change?.id?.startsWith("lead-")) void read();
    });
    const offState = bridge.onState(state => { if (state === "open") void read(); });
    return () => { alive = false; off(); offIndex(); offState(); };
  }, [enabled]);
  return reading;
}

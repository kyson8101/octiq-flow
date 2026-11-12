import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import type { IndexEntry } from "./chatIndex";
import type { LeadThread, LeadHistoryEntry, LeadThreadsReading } from "./leadThreads";
import { recall, remember } from "./remember";
import { isDeleted } from "./deletions";

const THREADS_KEY = "octiq.v2.leadThreads";
/** Last host identities for first paint; opening still resolves on the host. */
export function cachedLeadThreads(): LeadThread[] | null {
  try {
    const rows: unknown = JSON.parse(recall(THREADS_KEY) ?? "null");
    if (!Array.isArray(rows) || !rows.every(row => row && typeof row.agentId === "string"
      && typeof row.name === "string" && typeof row.chatKey === "string" && row.chatKey.startsWith("chat:")
      && typeof row.cwd === "string" && typeof row.exists === "boolean"
      && (row.project === undefined || typeof row.project === "string"))) return null;
    return rows.filter(row => !isDeleted(row.chatKey.slice(5)));
  } catch { return null; }
}

export function rememberLeadThreads(threads: LeadThread[]): void {
  remember(THREADS_KEY, JSON.stringify(threads));
}

export const openLeadThread = (agentId: string) => bridge.invoke<IndexEntry>("lead_thread_open", { agentId });
export const readLeadHistory = (agentId: string) => bridge.invoke<LeadHistoryEntry[]>("lead_history", { agentId });

/** One owner in App. Reconnect/roster changes reread identities; index changes
 * only matter when a lead thread is created. Ordinary activity is App's reading. */
export function useLeadThreads(enabled: boolean): LeadThreadsReading {
  const [reading, setReading] = useState<LeadThreadsReading>(() => ({ threads: cachedLeadThreads(), error: null }));
  useEffect(() => {
    if (!enabled) return;
    let alive = true, revision = 0;
    const read = async () => {
      const at = ++revision;
      try {
        const threads = await bridge.invoke<LeadThread[]>("lead_threads");
        if (alive && at === revision) {
          rememberLeadThreads(threads);
          setReading({ threads, error: null });
        }
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

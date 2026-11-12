import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import type { IndexEntry } from "./chatIndex";
import type { LeadThread, LeadHistoryEntry, LeadThreadsReading } from "./leadThreads";
import { recall, remember } from "./remember";
import { isDeleted } from "./deletions";
import { schedulingReading } from "./agentLanes";

const THREADS_KEY = "octiq.v2.leadThreads";
/** Last host identities for first paint only; they carry no action authority. */
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

/** The exact accepted readings are the request token. A newer authoritative
 * answer (even the same roster/orientation) supersedes any pending action. */
export function leadActionToken(agentId: string, current: () => LeadThreadsReading, enabled: () => boolean): (() => boolean) | null {
  const leads = current(), scheduling = schedulingReading();
  if (!enabled() || leads.freshness !== "host" || !scheduling.fresh || scheduling.data?.orientation !== "agents"
    || !leads.threads?.some(lead => lead.agentId === agentId)) return null;
  return () => enabled() && current() === leads && schedulingReading() === scheduling;
}

export async function openConfirmedLeadThread(agentId: string, current: (() => boolean) | null): Promise<IndexEntry | null> {
  if (!current?.()) return null;
  try {
    const entry = await openLeadThread(agentId);
    return current() ? entry : null;
  } catch (error) {
    if (current()) throw error;
    return null;
  }
}

/** One owner in App. Reconnect/roster changes reread identities; index changes
 * only matter when a lead thread is created. Ordinary activity is App's reading. */
export function useLeadThreads(enabled: boolean): LeadThreadsReading & { current: () => LeadThreadsReading } {
  const [reading, setReading] = useState<LeadThreadsReading>(() => ({ threads: cachedLeadThreads(), error: null, freshness: "cached" }));
  const latest = useRef(reading);
  const current = useCallback(() => latest.current, []);
  useEffect(() => {
    const publish = (next: LeadThreadsReading) => {
      latest.current = next; // Reply checks must not wait for React's next render.
      setReading(next);
    };
    const invalidate = () => publish({ ...latest.current, freshness: "cached" });
    if (!enabled) { invalidate(); return; }
    let alive = true, revision = 0;
    const read = async () => {
      const at = ++revision;
      try {
        const threads = await bridge.invoke<LeadThread[]>("lead_threads");
        if (alive && at === revision) {
          rememberLeadThreads(threads);
          publish({ threads, error: null, freshness: "host" });
        }
      } catch (error) {
        if (alive && at === revision) publish({ ...latest.current, error: String((error as Error).message ?? error), freshness: "cached" });
      }
    };
    const off = bridge.on("team-changed", () => void read());
    const offIndex = bridge.on<{ id?: string }>("chat-index-changed", change => {
      if (change?.id?.startsWith("lead-")) void read();
    });
    const offState = bridge.onState(state => {
      revision++; invalidate();
      if (state === "open") void read();
    });
    return () => { alive = false; latest.current = { ...latest.current, freshness: "cached" }; off(); offIndex(); offState(); };
  }, [enabled]);
  return { ...reading, current };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import type { IndexEntry } from "./chatIndex";
import type { LeadThread, LeadHistoryEntry, LeadThreadsReading } from "./leadThreads";
import { recall, remember } from "./remember";
import { isDeleted } from "./deletions";
import { schedulingAuthorityEpoch, schedulingReading } from "./agentLanes";

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

export type LeadActionToken = (() => boolean) & { reason: () => string | null };

/** Check the latest confirmed values, while retaining lifecycle fences even
 * when a disconnected/disabled feed has already confirmed the same values again. */
export function leadActionToken(agentId: string, current: () => LeadThreadsReading, enabled: () => boolean, epoch: () => number): LeadActionToken | null {
  const started = epoch(), schedulingStarted = schedulingAuthorityEpoch();
  const reason = () => {
    const leads = current(), scheduling = schedulingReading();
    if (scheduling.data?.orientation !== "agents") return "The orientation changed while opening this lead. Return to Agents to try again.";
    if (schedulingAuthorityEpoch() !== schedulingStarted) return "The connection or orientation changed while opening this lead. Please try again.";
    if (!enabled()) return "Lead actions were disabled while opening. Reconnect or return to Agents mode to try again.";
    if (epoch() !== started) return "The lead connection was reset or disabled while opening. Please try again.";
    if (leads.freshness !== "host" || !scheduling.fresh) return "The server has not confirmed this lead on the current connection. Please try again once it reconnects.";
    if (!leads.threads?.some(lead => lead.agentId === agentId)) return "This lead is no longer listed by the server. Choose an available lead.";
    return null;
  };
  if (reason()) return null;
  return Object.assign(() => reason() === null, { reason });
}

export async function openConfirmedLeadThread(agentId: string, current: LeadActionToken | null): Promise<IndexEntry | null> {
  if (!current?.()) return null;
  try {
    const entry = await openLeadThread(agentId);
    const reason = current.reason();
    if (reason) throw new Error(reason);
    return entry;
  } catch (error) {
    throw new Error(current.reason() ?? String((error as Error).message ?? error));
  }
}

/** One owner in App. Reconnect/roster changes reread identities; index changes
 * only matter when a lead thread is created. Ordinary activity is App's reading. */
export function useLeadThreads(enabled: boolean): LeadThreadsReading & { current: () => LeadThreadsReading; epoch: () => number } {
  const [reading, setReading] = useState<LeadThreadsReading>(() => ({ threads: cachedLeadThreads(), error: null, freshness: "cached" }));
  const latest = useRef(reading);
  const current = useCallback(() => latest.current, []);
  const resetEpoch = useRef(0);
  const epoch = useCallback(() => resetEpoch.current, []);
  useEffect(() => {
    const publish = (next: LeadThreadsReading) => {
      latest.current = next; // Reply checks must not wait for React's next render.
      setReading(next);
    };
    const invalidate = () => { resetEpoch.current++; publish({ ...latest.current, freshness: "cached" }); };
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
        // Keep the last confirmed roster on this connection; a failed read
        // does not say the lead was removed. Reset/disable invalidates above.
        if (alive && at === revision) publish({ ...latest.current, error: String((error as Error).message ?? error) });
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
    return () => { alive = false; resetEpoch.current++; latest.current = { ...latest.current, freshness: "cached" }; off(); offIndex(); offState(); };
  }, [enabled]);
  return { ...reading, current, epoch };
}

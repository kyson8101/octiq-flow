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

export type ReadTicket = { at: number; generation: number };
/** Orders overlapping roster reads by START order. A success applies unless a
 * newer-started success already did, even when a later read is still in flight
 * (a stale success is still newer than the value it replaces). A failure never
 * removes or hides a success; it is shown only if it started after the newest
 * applied success. A connection reset (`reset`) drops every earlier ticket. */
export function createReadSequencer() {
  let seq = 0, applied = 0, generation = 0;
  let failure: { at: number; message: string } | null = null;
  return {
    begin: (): ReadTicket => ({ at: ++seq, generation }),
    reset: () => { generation++; failure = null; },
    succeed(ticket: ReadTicket): { apply: boolean; error: string | null } {
      if (ticket.generation !== generation || ticket.at < applied) return { apply: false, error: null };
      applied = ticket.at;
      if (failure && failure.at < applied) failure = null;
      return { apply: true, error: failure ? failure.message : null };
    },
    fail(ticket: ReadTicket, message: string): boolean {
      if (ticket.generation !== generation || ticket.at < applied) return false;
      if (!failure || ticket.at > failure.at) failure = { at: ticket.at, message };
      return true;
    },
  };
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
    let alive = true;
    const reads = createReadSequencer();
    const read = async () => {
      const ticket = reads.begin();
      try {
        const threads = await bridge.invoke<LeadThread[]>("lead_threads");
        if (!alive) return;
        // A success is applied by start order, never dropped only because a
        // later read is still in flight: it may be the only removal we get.
        const verdict = reads.succeed(ticket);
        if (!verdict.apply) return;
        rememberLeadThreads(threads);
        publish({ threads, error: verdict.error, freshness: "host" });
      } catch (error) {
        // A failed read does not say a lead was removed, and never undoes a
        // newer success already applied. Reset/disable invalidates above.
        if (alive && reads.fail(ticket, String((error as Error).message ?? error))) publish({ ...latest.current, error: String((error as Error).message ?? error) });
      }
    };
    const off = bridge.on("team-changed", () => void read());
    const offIndex = bridge.on<{ id?: string }>("chat-index-changed", change => {
      if (change?.id?.startsWith("lead-")) void read();
    });
    const offState = bridge.onState(state => {
      reads.reset(); invalidate();
      if (state === "open") void read();
    });
    return () => { alive = false; resetEpoch.current++; latest.current = { ...latest.current, freshness: "cached" }; off(); offIndex(); offState(); };
  }, [enabled]);
  return { ...reading, current, epoch };
}

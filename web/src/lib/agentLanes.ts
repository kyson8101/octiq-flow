// One scheduling subscription shared by Settings and every agent lane.
import { useSyncExternalStore } from "react";
import { bridge } from "./bridge";

export type SchedulingSettings = { orientation: "tasks" | "agents"; hostCap: number | null };
export type AgentLane = {
  agentId: string; state: "idle" | "working" | "blocked"; queued: number;
  batch?: { id: string; runId: string; branch: string; taskIds: string[] };
  blockedReason?: string;
};
export type Scheduling = SchedulingSettings & { live: { total: number }; lanes: AgentLane[] };
export type SchedulingReading = { data: Scheduling | null; error: string | null };
const EMPTY: SchedulingReading = { data: null, error: null };
let reading = EMPTY;
let revision = 0;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();
export const schedulingReading = () => reading;
function publish(next: SchedulingReading) {
  reading = next;
  for (const fn of listeners) fn();
}
export async function refreshScheduling(): Promise<void> {
  const at = revision;
  try {
    const data = await bridge.invoke<Scheduling>("scheduling_get");
    // A lane event arriving during the read is newer than that read.
    if (at === revision) publish({ data, error: null });
  } catch (error) {
    if (at === revision) publish({ data: null, error: String((error as Error).message ?? error) });
  }
}
export async function saveScheduling(settings: SchedulingSettings): Promise<Scheduling> {
  const at = revision;
  const data = await bridge.invoke<Scheduling>("scheduling_set", { settings });
  if (at === revision) { revision++; publish({ data, error: null }); }
  return data;
}
export function subscribeScheduling(listener: () => void): () => void {
  listeners.add(listener);
  if (!stop) {
    const off = bridge.on<Scheduling>("scheduling-changed", data => {
      revision++;
      publish({ data, error: null });
    });
    // onState calls once immediately and again on reconnect. No polling.
    const offState = bridge.onState(state => { if (state === "open") void refreshScheduling(); });
    stop = () => { off(); offState(); revision++; };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stop?.(); stop = null; }
  };
}
export function useAgentLanes(): SchedulingReading {
  return useSyncExternalStore(subscribeScheduling, schedulingReading, () => EMPTY);
}

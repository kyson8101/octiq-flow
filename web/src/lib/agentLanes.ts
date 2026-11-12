// One scheduling subscription shared by Settings and every agent lane.
import { useSyncExternalStore } from "react";
import { bridge } from "./bridge";
import { recall, remember } from "./remember";

export type SchedulingSettings = { orientation: "tasks" | "agents"; hostCap: number | null };
export type AgentLane = {
  agentId: string; state: "idle" | "working" | "blocked"; queued: number;
  batch?: { id: string; runId: string; branch: string; taskIds: string[] };
  blockedReason?: string;
};
export type Scheduling = SchedulingSettings & { live: { total: number }; lanes: AgentLane[] };
export type SchedulingReading = { data: Scheduling | null; error: string | null; fresh: boolean };
const ORIENTATION_KEY = "octiq.v2.navigationOrientation";
/** Display continuity only: never seed live lanes, capacity or start authority. */
export function recallNavigationOrientation(): SchedulingSettings["orientation"] | undefined {
  const value = recall(ORIENTATION_KEY);
  return value === "tasks" || value === "agents" ? value : undefined;
}
const EMPTY: SchedulingReading = { data: null, error: null, fresh: false };
let reading = EMPTY;
let revision = 0;
// Only a connection/orientation transition revokes an in-flight lead action.
// Ordinary worker lane and capacity updates do not change its authority.
let authorityEpoch = 0;
export const schedulingAuthorityEpoch = () => authorityEpoch;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();
export const schedulingReading = () => reading;
function publish(next: SchedulingReading) {
  if (next.data?.orientation !== reading.data?.orientation) authorityEpoch++;
  if (next.data) remember(ORIENTATION_KEY, next.data.orientation);
  reading = next;
  for (const fn of listeners) fn();
}
export async function refreshScheduling(): Promise<void> {
  const at = revision;
  try {
    const data = await bridge.invoke<Scheduling>("scheduling_get");
    // A lane event arriving during the read is newer than that read.
    if (at === revision) publish({ data, error: null, fresh: true });
  } catch (error) {
    // A failed reread is not a new authoritative orientation. Connection
    // changes already revoke freshness before starting their read.
    if (at === revision) publish({ ...reading, error: String((error as Error).message ?? error) });
  }
}
export async function saveScheduling(settings: SchedulingSettings): Promise<Scheduling> {
  const at = revision;
  const data = await bridge.invoke<Scheduling>("scheduling_set", { settings });
  if (at === revision) { revision++; publish({ data, error: null, fresh: true }); }
  return data;
}
export function subscribeScheduling(listener: () => void): () => void {
  listeners.add(listener);
  if (!stop) {
    const off = bridge.on<Scheduling>("scheduling-changed", data => {
      revision++;
      publish({ data, error: null, fresh: true });
    });
    // onState calls once immediately and again on reconnect. No polling.
    const offState = bridge.onState(state => {
      authorityEpoch++;
      if (state === "open") void refreshScheduling();
      else {
        revision++;
        // Retain the display, but revoke this connection's action authority.
        if (reading.fresh) publish({ ...reading, fresh: false });
      }
    });
    stop = () => { off(); offState(); revision++; authorityEpoch++; };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stop?.(); stop = null; }
  };
}
export function useAgentLanes(): SchedulingReading {
  return useSyncExternalStore(subscribeScheduling, schedulingReading, () => EMPTY);
}

// Person-owned standing consent, shared by Details and every plan card.
import { useEffect, useSyncExternalStore } from "react";
import { bridge } from "./bridge";
import { once, useInFlight } from "./inFlight";
import type { OrchestrationRun, OrchestrationTask } from "./orchestration";

export type AutoPlanSetting = { chatKey: string; enabled: boolean; enabledAt?: number; includeFull: boolean; includeFullAt?: number };
type Reading = { setting?: AutoPlanSetting; error?: string; saveError?: string };
const readings = new Map<string, Reading>();
// A failed read carries no new setting. Only a successful read, event or
// explicit change supersedes other reads already in flight.
const revisions = new Map<string, number>();
const advance = (key: string) => revisions.set(key, (revisions.get(key) ?? 0) + 1);
const listeners = new Set<() => void>();
const EMPTY: Reading = {};
export const autoPlanFlight = (chatKey: string) => `auto-plan:${chatKey}`;
const publish = (key: string, reading: Reading) => {
  readings.set(key, reading);
  for (const listener of listeners) listener();
};
const words = (error: unknown) => String((error as Error)?.message ?? error);

export async function setAutoPlan(chatKey: string, enabled: boolean, source: "details" | "card" = "details", includeFull?: boolean) {
  return once(autoPlanFlight(chatKey), async () => {
    advance(chatKey);
    try {
      const setting = await bridge.invoke<AutoPlanSetting>("orchestration_auto_plan_set", { chatKey, enabled, ...(includeFull === undefined ? {} : { includeFull }) });
      advance(chatKey);
      publish(chatKey, { setting });
    } catch (error) {
      advance(chatKey);
      publish(chatKey, { ...readings.get(chatKey), error: words(error), ...(source === "card" ? { saveError: words(error) } : {}) });
      throw error;
    }
  });
}

export function useAutoPlan(chatKey: string | null, connected = true) {
  const reading = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => chatKey ? readings.get(chatKey) ?? EMPTY : EMPTY,
    () => EMPTY,
  );
  const busy = useInFlight(chatKey ? autoPlanFlight(chatKey) : null);
  useEffect(() => {
    if (!chatKey || !connected) return;
    let live = true;
    const off = bridge.on("orchestration-auto-plan", (payload) => {
      const setting = payload as AutoPlanSetting;
      if (setting?.chatKey !== chatKey) return;
      advance(chatKey);
      publish(chatKey, { setting });
    });
    const before = revisions.get(chatKey);
    void bridge.invoke<AutoPlanSetting>("orchestration_auto_plan_get", { chatKey }).then((setting) => {
      // An event or a person's press after this read began is newer.
      if (live && revisions.get(chatKey) === before) {
        advance(chatKey);
        publish(chatKey, { ...readings.get(chatKey), setting, error: undefined });
      }
    }).catch((error) => {
      if (live && revisions.get(chatKey) === before) publish(chatKey, { ...readings.get(chatKey), error: words(error) });
    });
    return () => { live = false; off(); };
  }, [chatKey, connected]);
  return { ...reading, busy };
}

export function autoPlanHeld(run: Pick<OrchestrationRun, "autoPlan">, tasks: OrchestrationTask[] = []): string | null {
  const held = run.autoPlan?.held;
  if (!held) return null;
  if (held.reason === "peerRequest") return "Waits for you: a peer request is always approved by you.";
  const n = held.taskIds.length;
  const names = held.taskIds.map((id) => tasks.find((task) => task.id === id))
    .filter((task): task is OrchestrationTask => !!task)
    .map((task) => `${task.assignee?.name ?? "Unassigned"}: ${task.title}`);
  return `Waits for you: ${n} task${n === 1 ? " runs" : "s run"} at Full access${names.length ? ` (${names.join("; ")})` : ""}. Auto-approve covers Auto or lower unless you turn on Full access tasks.`;
}

/** Approval is final even if saving future consent fails. */
export async function approveWithAutoPlan(approve: () => Promise<boolean>, chatKey: string, enabled: boolean, includeFull?: boolean) {
  const sent = await approve();
  if (sent && enabled) await setAutoPlan(chatKey, true, "card", includeFull);
  return sent;
}

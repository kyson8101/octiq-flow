import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { EMPTY_ORCHESTRATION, type OrchestrationSnapshot } from "./orchestration";
import { currentWaitEvidence } from "./runWaits";
import { orchestrationFeed, type OrchestrationFeedState } from "./orchestrationFeed";

/** The tab's one copy of the ledger, and why its last read failed (see
 *  `orchestrationFeed.ts`). A server render sees no snapshot yet. */
export function useOrchestrationFeed(): OrchestrationFeedState {
  return useSyncExternalStore(orchestrationFeed.subscribe, orchestrationFeed.getState, orchestrationFeed.getState);
}

/** Shared by the sidebar and toolbar, even when the orchestrator panel is closed. */
export function useOrchestrationSnapshot(): OrchestrationSnapshot {
  return useOrchestrationFeed().snapshot ?? EMPTY_ORCHESTRATION;
}

/** Detail is held by the surface, never the app's status reading. The current
 * summary wins for status and identities; omitted evidence comes from detail. */
export function detailedRun(summary: OrchestrationSnapshot, detail: OrchestrationSnapshot, id: string): OrchestrationSnapshot {
  const merge = (full: unknown, small: unknown): unknown => {
    if (typeof small === "string" && typeof full === "string" && (small === "" || (small.length >= 512 && full.startsWith(small)))) return full;
    if (!small || typeof small !== "object" || Array.isArray(small)) return small;
    const out = { ...(full as object) } as Record<string, unknown>;
    for (const [key, value] of Object.entries(small)) {
      if (key === "filesModified" && Array.isArray(value) && !value.length) continue;
      out[key] = merge(out[key], value);
    }
    return out;
  };
  const rows = <T extends { id: string }>(small: T[], full: T[]) => small.map(item => merge(full.find(f => f.id === item.id), item) as T);
  return { ...detail, summary: false,
    runs: rows(summary.runs.filter(r => r.id === id), detail.runs),
    tasks: rows(summary.tasks.filter(t => t.runId === id), detail.tasks),
    attempts: rows(summary.attempts.filter(a => a.runId === id), detail.attempts),
    ...currentWaitEvidence(summary, detail, id),
    reports: merge(detail.reports, summary.reports) as OrchestrationSnapshot["reports"],
  };
}

export const RunDetailOnScreen = createContext(true);

export function useRunDetail(summary: OrchestrationSnapshot, id: string | null) {
  const feed = useOrchestrationFeed();
  const shown = useContext(RunDetailOnScreen);
  id = shown ? id : null;
  useEffect(() => id ? orchestrationFeed.detail(id) : undefined, [id]);
  const detail = id ? feed.details?.get(id) : undefined;
  const snapshot = useMemo(() => summary.summary && detail && id ? detailedRun(summary, detail, id) : summary, [summary, detail, id]);
  return { snapshot, ready: !summary.summary || !!detail, error: id ? feed.detailErrors?.get(id) : undefined };
}

import { useSyncExternalStore } from "react";
import { EMPTY_ORCHESTRATION, type OrchestrationSnapshot } from "./orchestration";
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

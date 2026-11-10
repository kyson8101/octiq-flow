// Exact socket contract: docs/subagent-worktree-lifecycle.md#coordinator-batch-cleanup-card.
import type { PendingRequests } from "./pendingRequests";

export type ItemResult = { id: string; status: "removed" | "kept"; reason: string };
export type CleanupAsked = {
  id: string; chatKey: string; runIds: string[]; processing: boolean;
  results?: ItemResult[]; approved?: boolean;
  items: {
    id: string; kind: "task-worktree" | "mission"; runId: string;
    taskId?: string; title: string;
    worktrees: {
      branch: string; path: string; headCommit: string; baseBranch: string;
      ignoredFileCount: number | null;
    }[];
  }[];
};
export type CleanupSettled = {
  id: string; approved: boolean;
  items: ItemResult[];
};
export type CleanupCard = CleanupAsked | {
  id: string; chatKey: string; result: CleanupSettled; request?: CleanupAsked;
};
export type CleanupEvent =
  | { state: "appeared"; id: string; request: CleanupAsked }
  | { state: "processing"; id: string; chatKey: string; approved: boolean }
  | { state: "item"; id: string; chatKey: string; item: ItemResult }
  | { state: "settled"; id: string; chatKey: string; result: CleanupSettled };

export const cleanupFlight = (id: string) => `workspace-cleanup:${id}`;
export const cleanupRequest = (card: CleanupCard): CleanupAsked | undefined => "result" in card ? card.request : card;
export const cleanupResult = (card: CleanupCard): CleanupSettled | undefined => "result" in card ? card.result : undefined;

/** Use the same journal for events and the local RPC answer: a late pending
 * snapshot must not turn a receipt back into an unanswered card. Receipts
 * live only for this connection; durable results belong to the host inbox. */
export function applyCleanupEvent(store: PendingRequests<CleanupCard>, event: CleanupEvent) {
  const prior = Object.values(store.current).flat().find((card) => card.id === event.id);
  switch (event.state) {
    case "appeared":
      if (prior && "result" in prior) return store.current;
      return store.add(prior?.processing ? {
        ...event.request, processing: true, approved: prior.approved ?? event.request.approved,
        results: mergeResults(event.request.results, prior.results ?? []),
      } : event.request);
    case "processing":
    case "item": {
      // A receipt is final. Late progress cannot reopen its decision.
      if (!prior || "result" in prior) return store.current;
      return store.add(event.state === "processing"
        ? { ...prior, processing: true, approved: event.approved }
        : { ...prior, processing: true, results: mergeResults(prior.results, [event.item]) });
    }
    case "settled":
      return store.add({ id: event.id, chatKey: event.chatKey, result: event.result, request: prior && cleanupRequest(prior) });
    default:
      return store.current;
  }
}

function mergeResults(before: ItemResult[] = [], after: ItemResult[]): ItemResult[] {
  return [...new Map([...before, ...after].map((item) => [item.id, item])).values()];
}

export function cleanupAsk(request: CleanupAsked): string {
  const folders = request.items.reduce((count, item) => count + item.worktrees.length, 0);
  const missions = request.items.filter((item) => item.kind === "mission").length;
  if (request.processing) {
    if (request.approved === false) return "Keeping them…";
    if (!folders) return `Closing ${missions} ${missions === 1 ? "mission" : "missions"}…`;
    return `Removing ${folders} ${folders === 1 ? "worktree" : "worktrees"}…`;
  }
  if (!folders) return `Close ${missions} finished ${missions === 1 ? "mission" : "missions"}? Their work is merged.`;
  return `Remove ${folders} finished ${folders === 1 ? "worktree" : "worktrees"}${missions ? ` and close ${missions} ${missions === 1 ? "mission" : "missions"}` : ""}? Their work is merged.`;
}

export function cleanupOutcome(result: CleanupSettled): string {
  if (!result.approved) return "Nothing removed · kept them all";
  const removed = result.items.filter((item) => item.status === "removed").length;
  return `${removed} removed · ${result.items.length - removed} kept`;
}

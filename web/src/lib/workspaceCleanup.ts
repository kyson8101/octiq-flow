// Exact socket contract: docs/subagent-worktree-lifecycle.md#coordinator-batch-cleanup-card.
import { PendingRequests } from "./pendingRequests";

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

type Progress = { processing: boolean; approved?: boolean; results?: ItemResult[] };
type CachedProgress = Progress & { arrived: number };
const MAX_PROGRESS = 64;

/** Progress can precede its proposal on a new connection. Hold only facts
 * about progress, never a fabricated proposal, until a list or event supplies it. */
export class CleanupRequests extends PendingRequests<CleanupCard> {
  private progress = new Map<string, CachedProgress>();
  private clock = 0;
  private readStarted = 0;

  override begin(): number {
    // A logical clock orders events and reads even within the same millisecond.
    this.readStarted = ++this.clock;
    return super.begin();
  }

  resetProgress(): void { this.progress.clear(); }

  private cacheProgress(id: string, progress: CachedProgress): void {
    this.progress.set(id, progress);
    // Map insertion order retains the first arrival, including after updates.
    if (this.progress.size > MAX_PROGRESS) this.progress.delete(this.progress.keys().next().value!);
  }

  recordProgress(id: string, update: Progress): void {
    const prior = this.progress.get(id);
    this.cacheProgress(id, {
      arrived: ++this.clock,
      processing: !!(prior?.processing || update.processing),
      approved: update.approved ?? prior?.approved,
      results: mergeResults(prior?.results, update.results ?? []),
    });
  }

  private merge(card: CleanupCard): CleanupCard {
    if ("result" in card) {
      this.progress.delete(card.id);
      return card;
    }
    const progress = this.progress.get(card.id);
    if (!progress && !card.processing) return card;
    const merged = {
      ...card, processing: card.processing || !!progress?.processing,
      approved: progress?.approved ?? card.approved,
      results: mergeResults(card.results, progress?.results ?? []),
    };
    this.cacheProgress(card.id, {
      arrived: progress?.arrived ?? ++this.clock,
      processing: merged.processing, approved: merged.approved, results: merged.results,
    });
    return merged;
  }

  override add(card: CleanupCard) { return super.add(this.merge(card)); }

  override finish(token: number, list: readonly CleanupCard[] | null) {
    const reconciled = super.finish(token, list);
    if (!reconciled) return null;
    const snapshots = new Map(list?.map((card) => [card.id, card]));
    // The host emits appeared before processing and lists processing cards.
    // Only a read begun after the latest progress can prove its card is gone.
    for (const [id, progress] of this.progress) {
      if (progress.arrived < this.readStarted && !snapshots.has(id)) this.progress.delete(id);
    }
    // The journal may hold an older proposal plus newer progress, while the
    // list already includes another completed item. Keep both sets of facts.
    this.current = Object.fromEntries(Object.entries(reconciled).map(([chat, cards]) => [chat, cards.map((card) => {
      const snapshot = snapshots.get(card.id);
      if (!("result" in card) && snapshot && !("result" in snapshot) && (card.processing || snapshot.processing)) {
        card = {
          ...card, processing: card.processing || snapshot.processing,
          approved: card.approved ?? snapshot.approved,
          results: mergeResults(snapshot.results, card.results ?? []),
        };
      }
      return this.merge(card);
    })]));
    return this.current;
  }
}

/** Use the same journal for events and the local RPC answer: a late pending
 * snapshot must not turn a receipt back into an unanswered card. Receipts
 * live only for this connection; durable results belong to the host inbox. */
export function applyCleanupEvent(store: CleanupRequests, event: CleanupEvent) {
  const prior = Object.values(store.current).flat().find((card) => card.id === event.id);
  switch (event.state) {
    case "appeared":
      if (prior && "result" in prior) return store.current;
      return store.add(event.request);
    case "processing":
    case "item": {
      // A receipt is final. Late progress cannot reopen its decision.
      if (prior && "result" in prior) return store.current;
      store.recordProgress(event.id, event.state === "processing"
        ? { processing: true, approved: event.approved }
        : { processing: true, results: [event.item] });
      if (!prior) return store.current;
      return store.add(prior);
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
    if (request.approved === undefined) return "Working…";
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

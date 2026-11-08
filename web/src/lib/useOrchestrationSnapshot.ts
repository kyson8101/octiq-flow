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

/** Only fields deliberately left out by orchestration/summary.rs may come
 * back from detail. In particular, absence of a state field is current fact. */
function evidence<T extends object>(small: T, full: T | undefined, fields: readonly (keyof T)[]): T {
  const out = { ...small };
  if (full) for (const key of fields) if (key in full) out[key] = full[key];
  return out;
}
const longText = (small: string, full?: string) => full !== undefined
  && (small === "" || (small.length >= 512 && full.startsWith(small))) ? full : small;

export function detailedRun(summary: OrchestrationSnapshot, detail: OrchestrationSnapshot, id: string): OrchestrationSnapshot {
  return { ...detail, summary: false,
    runs: summary.runs.filter(r => r.id === id).map(small => {
      const full = detail.runs.find(r => r.id === small.id);
      const run = evidence(small, full, ["workerDefaults", "stoppedReason", "missionDelivery"]);
      run.objective = longText(small.objective, full?.objective);
      if (small.planApproval) run.planApproval = evidence(small.planApproval, full?.planApproval, ["consent", "rejection"]);
      return run;
    }),
    tasks: summary.tasks.filter(t => t.runId === id).map(small => {
      const full = detail.tasks.find(t => t.id === small.id);
      const task = evidence(small, full, ["spec", "result", "card", "workspace", "workspaceProposal", "workspaceChoice", "handoffs", "effortChosen"]);
      if (small.reopens) task.reopens = small.reopens.map(reopen => evidence(reopen,
        full?.reopens?.find(r => r.at === reopen.at), ["byChatKey", "attempt", "previousSpec", "spec", "byPerson"]));
      if (small.peerRequest) task.peerRequest = evidence(small.peerRequest, full?.peerRequest, ["output"]);
      if (small.stopped?.reason !== undefined) task.stopped = { ...small.stopped, reason: longText(small.stopped.reason, full?.stopped?.reason) };
      return task;
    }),
    attempts: summary.attempts.filter(a => a.runId === id).map(small => {
      const full = detail.attempts.find(a => a.id === small.id);
      const attempt = evidence(small, full, ["summary", "filesModified", "peerClock"]);
      if (small.proposedReport) attempt.proposedReport = evidence(small.proposedReport, full?.proposedReport ?? undefined, ["text"]);
      if (small.execution) {
        const execution = evidence(small.execution, full?.execution, ["lastProgress"]);
        if (typeof execution.currentOperation === "string") execution.currentOperation = longText(execution.currentOperation, full?.execution?.currentOperation ?? undefined);
        if (execution.latestError) execution.latestError = { ...execution.latestError, message: longText(execution.latestError.message, full?.execution?.latestError?.message) };
        attempt.execution = execution;
      }
      return attempt;
    }),
    ...currentWaitEvidence(summary, detail, id),
    reports: { ...detail.reports, ...Object.fromEntries(Object.entries(summary.reports ?? {}).map(([key, small]) => {
      const full = detail.reports?.[key];
      return [key, { ...evidence(small, full, ["objective", "nextStep"]), steps: small.steps.map((step, i) => ({ ...step, title: longText(step.title, full?.steps[i]?.title) })) }];
    })) },
  };
}

/** The plan's brief and approval revision must describe the same host read.
 * Per-run tokens avoid unrelated runs invalidating a visible plan. */
function coversRun(summary: OrchestrationSnapshot, detail: OrchestrationSnapshot, id: string): boolean {
  const small = summary.runs.find(r => r.id === id), full = detail.runs.find(r => r.id === id);
  const revision = summary.runRevisions?.[id];
  return !!small && !!full && !!revision && revision === detail.runRevisions?.[id]
    && small.planApproval?.revision === full.planApproval?.revision;
}

export const RunDetailOnScreen = createContext(true);

export function useRunDetail(summary: OrchestrationSnapshot, id: string | null) {
  const feed = useOrchestrationFeed();
  const shown = useContext(RunDetailOnScreen);
  id = shown ? id : null;
  useEffect(() => id ? orchestrationFeed.detail(id) : undefined, [id]);
  const detail = id ? feed.details?.get(id) : undefined;
  const ready = !summary.summary || !!(detail && id && coversRun(summary, detail, id));
  const snapshot = useMemo(() => summary.summary && ready && detail && id ? detailedRun(summary, detail, id) : summary, [summary, ready, detail, id]);
  return { snapshot, ready, error: id ? feed.detailErrors?.get(id) : undefined };
}

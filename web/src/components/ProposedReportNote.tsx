// A read-only worker's closing words, held by the host because its sandbox
// could not call it (feedback e15fabde). Attributed to the exact attempt, and
// never shown as a settlement until the coordinator confirmed that proposal.
// The words are the worker's prose, so they sit behind a disclosure.
import type { OrchestrationAttempt } from "../lib/orchestration";
import { proposedReportState } from "../lib/agentTaskBoard";

export function ProposedReportNote({ attempt, ago }: {
  attempt: OrchestrationAttempt;
  ago: (at: number) => string;
}) {
  const state = proposedReportState(attempt);
  const proposal = attempt.proposedReport;
  if (!state || !proposal) return null;
  const who = `${attempt.agent} worker #${attempt.number}`;
  return (
    <div className="orch-proposed-report" data-state={state} data-proposal={proposal.id}>
      <p>
        {state === "proposed"
          ? `Proposed report: the closing words of ${who} (read-only), held ${ago(proposal.capturedAt)}. Not settled until the coordinator confirms it.`
          : `Settled from the closing words of ${who}, confirmed by the coordinator ${ago(proposal.confirmedAt!)}.`}
      </p>
      <details>
        <summary>{proposal.truncated ? "Closing words (shortened)" : "Closing words"}</summary>
        <p className="orch-proposed-report-text">{proposal.text}</p>
      </details>
    </div>
  );
}

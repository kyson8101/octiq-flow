import { EXECUTION_LABELS } from "../lib/agentTaskBoard";
import type { WorkerExecution } from "../lib/orchestration";
import { agoLabel } from "../lib/chatTask";

function EvidenceTime({ at }: { at?: number | null }) {
  return at ? <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{agoLabel(at, Date.now())}</time> : <>Not observed</>;
}

export function WorkerExecutionEvidence({ execution }: { execution: WorkerExecution }) {
  return <div className="orch-execution" aria-label="Host execution evidence" data-execution={execution.state}>
    <dl>
      <dt>Execution</dt><dd>{EXECUTION_LABELS[execution.state]}</dd>
    </dl>
    {execution.latestError && <p className="orch-execution-error"><strong>Latest error:</strong> {execution.latestError.message} · <EvidenceTime at={execution.latestError.at} /></p>}
    {execution.nextRetryAt && <p>Retry {execution.retryCount + 1} scheduled for <time dateTime={new Date(execution.nextRetryAt).toISOString()}>{new Date(execution.nextRetryAt).toLocaleTimeString()}</time>{execution.retryModel ? ` · ${execution.retryModel}` : ""}. Workspace retained.</p>}
  </div>;
}

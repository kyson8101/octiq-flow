import type { OrchestrationSnapshot } from "../lib/orchestration";
import { agoLabel } from "../lib/chatTask";

/** Task completion and a live dependency answer different questions. */
export function TaskLifecycleEvidence({ snapshot, taskId, now }: {
  snapshot: OrchestrationSnapshot; taskId: string; now: number;
}) {
  return <>
    {(snapshot.services ?? []).filter((service) => service.taskId === taskId).map((service) => (
      <div key={service.id} className="orch-task-lifecycle" role={service.state === "stopped" ? "status" : undefined}>
        <p><strong>{service.name}: {service.state === "listening" ? "Listener reachable" : service.state === "stopped" ? "Service stopped" : "Not verified"}</strong>
          {service.checkedAt != null && ` · checked ${agoLabel(service.checkedAt, now)}`}</p>
        <p>{service.host}:{service.port}. {service.state === "listening" ? "Verify application health before use." : service.recovery}</p>
      </div>
    ))}
    {(snapshot.nativeDecisions ?? []).filter((decision) => decision.taskId === taskId).map((decision) => (
      <div key={decision.id} className="orch-task-lifecycle">
        <p><strong>Safety decision: {decision.status}</strong></p>
        <p>{decision.reason}</p>
        <p>{decision.recovery}</p>
        <p>Decision <code>{decision.id}</code> · attempt <code>{decision.attemptId}</code></p>
      </div>
    ))}
  </>;
}

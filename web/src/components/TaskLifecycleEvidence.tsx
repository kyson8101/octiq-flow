import type { NativeDecision, OrchestrationSnapshot } from "../lib/orchestration";
import { agoLabel } from "../lib/chatTask";

/** One row per safety refusal, one per outage group: an outage of Claude's
 * check is one event however many calls it refused, and each refused call
 * stays listed inside it. */
export function decisionRows(decisions: readonly NativeDecision[]): NativeDecision[][] {
  const rows: NativeDecision[][] = [];
  const groups = new Map<string, NativeDecision[]>();
  for (const decision of [...decisions].sort((a, b) => a.observedAt - b.observedAt)) {
    const group = decision.kind === "outage" ? decision.groupId : null;
    if (!group) {
      rows.push([decision]);
      continue;
    }
    const row = groups.get(group);
    if (row) row.push(decision);
    else {
      const fresh = [decision];
      groups.set(group, fresh);
      rows.push(fresh);
    }
  }
  return rows;
}

/** Each refused line once, with how often it was refused. */
function commandCounts(decisions: readonly NativeDecision[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const d of decisions) {
    const action = d.blockedAction ?? "a tool call";
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  return [...counts];
}

/** Task completion and a live dependency answer different questions. */
export function TaskLifecycleEvidence({ snapshot, taskId, now }: {
  snapshot: OrchestrationSnapshot; taskId: string; now: number;
}) {
  const decisions = (snapshot.nativeDecisions ?? []).filter((decision) => decision.taskId === taskId);
  return <>
    {(snapshot.services ?? []).filter((service) => service.taskId === taskId).map((service) => (
      <div key={service.id} className="orch-task-lifecycle" role={service.state === "stopped" ? "status" : undefined}>
        <p><strong>{service.name}: {service.state === "listening" ? "Listener reachable" : service.state === "stopped" ? "Service stopped" : "Not verified"}</strong>
          {service.checkedAt != null && ` · checked ${agoLabel(service.checkedAt, now)}`}</p>
        <p>{service.host}:{service.port}. {service.state === "listening" ? "Verify application health before use." : service.recovery}</p>
      </div>
    ))}
    {decisionRows(decisions).map((row) => {
      const [first] = row;
      const latest = row[row.length - 1];
      if (first.kind === "outage" && first.groupId) {
        return (
          <div key={first.groupId} className="orch-task-lifecycle">
            <p><strong>Safety check unavailable: {latest.status}</strong>
              {row.length > 1 && ` · ${row.length} refused calls`}</p>
            <ul className="orch-task-lifecycle-commands">
              {commandCounts(row).map(([action, count]) => (
                <li key={action}><code>{action}</code>{count > 1 && ` ×${count}`}</li>
              ))}
            </ul>
            <p>{latest.recovery}</p>
            <p>Group <code>{first.groupId}</code> · attempt <code>{first.attemptId}</code></p>
          </div>
        );
      }
      return (
        <div key={first.id} className="orch-task-lifecycle">
          <p><strong>Safety decision: {first.status}</strong></p>
          <p>{first.reason}</p>
          <p>{first.recovery}</p>
          <p>Decision <code>{first.id}</code> · attempt <code>{first.attemptId}</code></p>
        </div>
      );
    })}
  </>;
}

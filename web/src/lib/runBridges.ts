// Bridges the person opens between two runs of DIFFERENT coordinators
// (feedback a495b2f2). The host decides everything (`orchestration/bridge.rs`):
// this only lists what a run panel shows, and words the scope the person
// reads before opening one. A bridge is one pair of runs and one direction;
// only the source run's coordinator sends over it, only to the target run's
// coordinator, and only short notes the host frames as quoted data.
import type { OrchestrationRun, OrchestrationSnapshot, RunBridge } from "./orchestration";

/** The host's bounds, repeated so the scope can say them. */
export const BRIDGE_NOTE_MAX = 4000;
export const BRIDGE_NOTES_MAX = 50;

export type RunBridges = { outgoing: RunBridge[]; incoming: RunBridge[] };

/** Open bridges out of and into `run`. Closed ones stay in the log. */
export function runBridges(run: Pick<OrchestrationRun, "id">, snapshot: Pick<OrchestrationSnapshot, "bridges">): RunBridges {
  const open = (snapshot.bridges ?? []).filter((bridge) => bridge.closedAt == null);
  return {
    outgoing: open.filter((bridge) => bridge.fromRunId === run.id),
    incoming: open.filter((bridge) => bridge.toRunId === run.id),
  };
}

/** Runs `run`'s coordinator could be let send notes to: another coordinator's
 *  run, neither archived, with no bridge already open that way. The same
 *  coordinator's runs need none — it relays between them already. */
export function bridgeTargets(run: OrchestrationRun, snapshot: Pick<OrchestrationSnapshot, "runs" | "bridges">): OrchestrationRun[] {
  if (run.archivedAt != null) return [];
  const { outgoing } = runBridges(run, snapshot);
  return snapshot.runs.filter((other) => other.id !== run.id
    && other.archivedAt == null
    && other.coordinatorChatKey !== run.coordinatorChatKey
    && !outgoing.some((bridge) => bridge.toRunId === other.id));
}

/** What opening a bridge from `from` to `to` allows and does not, in the
 *  order the person reads it. "Data" is how the host frames and delivers a
 *  note, not a promise about the words inside it. */
export function bridgeScope(from: Pick<OrchestrationRun, "objective">, to: Pick<OrchestrationRun, "objective">): string[] {
  return [
    `One way: the main agent of “${from.objective}” may send notes to the main agent of “${to.objective}”. Replies need a bridge the other way.`,
    `Up to ${BRIDGE_NOTES_MAX} notes of ${BRIDGE_NOTE_MAX.toLocaleString("en-US")} characters, each delivered once and marked as quoted data from the other run, not as instructions.`,
    "No worker of either run sends, sees or receives them, and nothing forwards them further.",
    "They grant nothing: no access to the other run, no approvals, reports or acceptance, no permissions.",
    "It ends when you close it, when either run is archived, or if either run moves to another main agent.",
  ];
}

// A run's bridges to runs of other coordinators (feedback a495b2f2), in its
// options. Only the person opens or closes one; opening shows exactly which
// run's main agent may send to which, one way, and what that does not allow,
// before anything is opened. The host checks the pair against what this page
// showed, so a page drawn before a run changed hands opens nothing.
import { useId, useState } from "react";
import type { OrchestrationRun, OrchestrationSnapshot, RunBridge } from "../lib/orchestration";
import { BRIDGE_NOTES_MAX, bridgeScope, bridgeTargets, runBridges } from "../lib/runBridges";

export function RunBridges({ run, snapshot, busy, readOnly, onBridge }: {
  run: OrchestrationRun;
  snapshot: Pick<OrchestrationSnapshot, "runs" | "bridges">;
  busy: boolean;
  readOnly: boolean;
  onBridge: (command: "orchestration_bridge_open" | "orchestration_bridge_close", args: Record<string, unknown>) => void;
}) {
  const headingId = useId();
  const selectId = useId();
  const [choosing, setChoosing] = useState(false);
  const [targetId, setTargetId] = useState("");
  const { outgoing, incoming } = runBridges(run, snapshot);
  const targets = readOnly ? [] : bridgeTargets(run, snapshot);
  const target = targets.find((other) => other.id === targetId) ?? null;
  if (!outgoing.length && !incoming.length && !targets.length) return null;
  const objective = (id: string) => snapshot.runs.find((other) => other.id === id)?.objective ?? id;
  const cancel = () => { setChoosing(false); setTargetId(""); };

  const row = (bridge: RunBridge, direction: "out" | "in") => (
    <li className="orch-bridge" key={bridge.id} data-bridge={bridge.id} data-direction={direction}>
      <p>
        {direction === "out" ? "Sends notes to " : "Receives notes from "}
        <span className="orch-bridge-run">“{objective(direction === "out" ? bridge.toRunId : bridge.fromRunId)}”</span>
        <span className="orch-bridge-count"> · {bridge.sends.length} of {BRIDGE_NOTES_MAX} sent</span>
      </p>
      {!readOnly && <button type="button" className="orch-quiet" disabled={busy}
        onClick={() => onBridge("orchestration_bridge_close", { bridgeId: bridge.id })}>Close</button>}
    </li>
  );

  return (
    <section className="orch-bridges" aria-labelledby={headingId}>
      <h4 id={headingId}>Bridges to other runs</h4>
      {(outgoing.length > 0 || incoming.length > 0) && <ul>
        {outgoing.map((bridge) => row(bridge, "out"))}
        {incoming.map((bridge) => row(bridge, "in"))}
      </ul>}
      {targets.length > 0 && (choosing ? (
        <div className="orch-bridge-open" role="group" aria-labelledby={headingId}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); cancel(); } }}>
          <label htmlFor={selectId}>Let this run's main agent send notes to</label>
          <select id={selectId} value={targetId} autoFocus onChange={(event) => setTargetId(event.target.value)}>
            <option value="">Choose a run</option>
            {targets.map((other) => <option key={other.id} value={other.id}>{other.objective}</option>)}
          </select>
          {target && <ul className="orch-bridge-scope" aria-label="What this bridge allows">
            {bridgeScope(run, target).map((line) => <li key={line}>{line}</li>)}
          </ul>}
          <div className="orch-bridge-actions">
            <button type="button" className="orch-quiet" disabled={busy} onClick={cancel}>Cancel</button>
            <button type="button" className="orch-quiet is-primary" disabled={busy || !target}
              onClick={() => {
                if (!target) return;
                onBridge("orchestration_bridge_open", {
                  fromRunId: run.id, toRunId: target.id,
                  fromCoordinator: run.coordinatorChatKey, toCoordinator: target.coordinatorChatKey,
                });
                cancel();
              }}>Open bridge</button>
          </div>
        </div>
      ) : (
        <button type="button" className="orch-quiet" disabled={busy} onClick={() => setChoosing(true)}>
          Let this run's main agent send notes to another run…
        </button>
      ))}
    </section>
  );
}

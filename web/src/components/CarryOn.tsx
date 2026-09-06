import { deriveRecovery, type RecoveryEvidence } from "../lib/recovery";
import "./CarryOn.css";

export function CarryOn({
  onCarryOn,
  evidence,
}: {
  onCarryOn: () => void;
  evidence?: RecoveryEvidence;
}) {
  const recovery = evidence
    ? deriveRecovery(evidence)
    : { kind: "checking", canContinue: false };
  if (recovery.kind === "hidden") return null;
  const message = recovery.kind === "offline"
    ? "Connection lost. The agent may still be working; reconnect to check its status."
    : recovery.kind === "checking"
      ? "Checking whether the agent is still working."
      : recovery.kind === "exited"
        ? `The agent exited${evidence?.exited?.code != null ? ` with code ${evidence.exited.code}` : " without a recorded exit code"}. No active worker was found.`
        : "This conversation is unfinished, but the connected server reports no active worker. The interruption cause is unknown.";
  const seq = evidence?.checkpointSeq;
  const queued = evidence?.queuedCount;
  return (
    <div className="carry-on" role="status">
      <div className="carry-on-said">
        <span>{message}</span>
        {seq !== undefined && Number.isSafeInteger(seq) && seq >= 0 && (
          <span className="carry-on-detail">Last recorded transcript event: #{seq}. This does not confirm file saves.</span>
        )}
        {queued !== undefined && Number.isSafeInteger(queued) && queued >= 0 && (
          <span className="carry-on-detail">{queued} queued {queued === 1 ? "message" : "messages"} recorded.</span>
        )}
        {recovery.canContinue && (
          <span className="carry-on-detail">Carry on sends a request to check completed actions before resuming.</span>
        )}
      </div>
      {recovery.canContinue && (
        <button className="carry-on-btn" type="button" onClick={onCarryOn}>Carry on</button>
      )}
    </div>
  );
}

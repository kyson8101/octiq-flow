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
    ? "Connection lost."
    : recovery.kind === "checking"
      ? "Checking whether the agent is still working…"
      : recovery.kind === "exited"
        ? "Agent is no longer running."
        : "Agent is not running.";
  const seq = evidence?.checkpointSeq;
  const queued = evidence?.queuedCount;
  const transcriptDetails = [
    ...(seq !== undefined && Number.isSafeInteger(seq) && seq >= 0
      ? [`Last event #${seq}`, "File saves unverified"]
      : []),
    ...(queued !== undefined && Number.isSafeInteger(queued) && queued > 0
      ? [`${queued} ${queued === 1 ? "message" : "messages"} queued`]
      : []),
  ];
  const details = recovery.kind === "offline"
    ? ["The agent may still be working", "Reconnect to check"]
    : recovery.kind === "exited"
      ? [
          evidence?.exited?.code != null ? `Exit code ${evidence.exited.code}` : "No exit code",
          ...transcriptDetails,
        ]
      : recovery.kind === "missing"
        ? ["Interruption cause unknown", ...transcriptDetails]
        : [];
  return (
    <div className="carry-on" role="status">
      <span className="carry-on-dot" aria-hidden="true" />
      <div className="carry-on-copy">
        <span className="carry-on-message">{message}</span>
        {details.length > 0 && (
          <span className="carry-on-meta">{details.join(" · ")}</span>
        )}
      </div>
      {recovery.canContinue && (
        <button
          className="carry-on-btn"
          type="button"
          aria-label="Carry on. Check completed actions before resuming."
          onClick={onCarryOn}
        >
          Carry on
        </button>
      )}
    </div>
  );
}

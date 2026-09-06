import type { TaskEvidence } from "../lib/taskEvidence";
import "./TaskEvidence.css";

export function DeliveryCard({ evidence, onOpenFile, onOpenGit }: {
  evidence: TaskEvidence;
  onOpenFile: (path: string, line?: number) => void;
  onOpenGit: () => void;
}) {
  if (!evidence.settled) return null;
  return <details className="task-evidence task-delivery">
    <summary>Review this turn <span className="task-evidence-label">{evidence.files.length} files · {evidence.checks.length} checks · {evidence.pins.length} pinned</span></summary>
    <div className="task-delivery-body">
      <div className="task-evidence-heading"><strong>Recorded file changes</strong><button type="button" onClick={onOpenGit}>Open Git diff</button></div>
      {evidence.files.length ? <ul>{evidence.files.map((path) => <li key={path}><button type="button" className="task-evidence-file" onClick={() => onOpenFile(path)}>{path}</button></li>)}</ul> : <p>No successful file edits recorded in this turn.</p>}
      <strong>Validation commands</strong>
      {evidence.checks.length ? <ul>{evidence.checks.map((check) => <li key={check.id} className="task-evidence-check"><span className={`task-evidence-state is-${check.status}`}>{check.status === "unknown" ? "Result unconfirmed" : check.status === "passed" ? "Passed" : check.status === "failed" ? "Failed" : "Stopped"}</span><code>{check.command}</code>{check.exitCode !== undefined && <span className="task-evidence-label">Exit {check.exitCode}</span>}</li>)}</ul> : <p>No validation commands recorded. Checks may not have run.</p>}
      {!!evidence.pins.length && <><strong>Pinned outputs</strong><ul>{evidence.pins.map((pin) => <li key={pin.path}><button type="button" className="task-evidence-file" onClick={() => onOpenFile(pin.path, pin.line)}>{pin.label || pin.path}</button>{pin.why && <span className="task-evidence-label"> — {pin.why}</span>}</li>)}</ul></>}
    </div>
  </details>;
}

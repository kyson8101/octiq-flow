import type { TaskEvidence, TaskStatus } from "../lib/taskEvidence";
import "./TaskEvidence.css";

const STATUS: Record<TaskStatus, string> = {
  empty: "No task yet", waiting: "Waiting to start", running: "Working", blocked: "Needs you",
  settled: "Turn finished", stopping: "Stopping", stopped: "Stopped", interrupted: "Interrupted",
  failed: "Failed", unknown: "Connection unconfirmed",
};

export function TaskStatusCard({ evidence }: { evidence: TaskEvidence }) {
  if (!evidence.objective) return null;
  return <section className="task-evidence task-status" aria-label="Current task">
    <div className="task-evidence-heading"><strong>Current task</strong><span className={`task-evidence-state is-${evidence.status}`}>{STATUS[evidence.status]}</span></div>
    <p className="task-evidence-objective">{evidence.objective}</p>
    {evidence.step && <p><span className="task-evidence-label">Current step</span> {evidence.step}</p>}
    {evidence.progress && <p><span className="task-evidence-label">Latest progress</span> {evidence.progress}</p>}
    {evidence.blocker && <p className="task-evidence-blocker"><span className="task-evidence-label">Blocker</span> {evidence.blocker}</p>}
  </section>;
}

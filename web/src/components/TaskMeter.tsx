// The small visual vocabulary a run is read with, defined once.
//
// Two surfaces answer "how far along is this?" — the compact board under a
// chat in the sidebar, and the Run panel. They used to draw the meter and the
// status mark separately, which is how two pictures of the same snapshot start
// disagreeing. Everything shared lives here instead.
import { TASK_LABELS } from "../lib/agentTaskBoard";
import type { OrchestrationTask } from "../lib/orchestration";
import "./TaskMeter.css";

/** One cell per task, coloured by what became of it. It is a shape before it
 *  is a number: four cells with one green reads as "barely started" without
 *  anyone doing the division. */
export function TaskMeter({ tasks, done }: { tasks: OrchestrationTask[]; done: number }) {
  const percent = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  return <div className="task-meter" role="progressbar" aria-label="Completed tasks"
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
    aria-valuetext={`${done} of ${tasks.length} tasks completed`}>
    {tasks.map((task) => <span key={task.id} data-status={task.status} title={`${task.title}: ${TASK_LABELS[task.status]}`} />)}
  </div>;
}

/** The mark that carries a task's state. Shape does the work, not colour, so
 *  it survives both a colour-blind reader and the Fun palette. */
export function TaskStatusIcon({ status }: { status: OrchestrationTask["status"] }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {status === "completed" ? <path d="m5 12 4 4L19 6" />
      : status === "running" ? <><path d="m13 2-8 12h6l-1 8 9-13h-7z" /></>
      : status === "blocked" || status === "failed" ? <><path d="M12 5v8" /><circle cx="12" cy="18" r=".8" /></>
      : status === "cancelled" ? <path d="m6 6 12 12M6 18 18 6" />
      : <><circle cx="12" cy="12" r="7" /><path d="M12 8v4l3 2" /></>}
  </svg>;
}

export function ClockIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></svg>;
}

export function BranchIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 7v10m12-10c0 7-12 3-12 10" /></svg>;
}

import type { OrchestrationRun, OrchestrationSnapshot } from "../lib/orchestration";
import { isActiveRun, runSummary } from "../lib/chatWorkflow";
import "./ChatWorkflowBar.css";

/** The line over a chat that has work in a run: Tasks/Chat, approvals, and the
 *  run's state. There is no execution-mode picker. A chat with no run draws
 *  nothing here; the agent decides how to work, and a run exists only once
 *  one is explicitly started. */
export function ChatWorkflowBar({ snapshot, orchestrated, view, onView, pendingApprovals = 0, planPending = false, split = false, unified = false, selectedRun }: {
  snapshot: OrchestrationSnapshot; orchestrated: boolean; view: "chat" | "run";
  onView: (view: "chat" | "run") => void;
  pendingApprovals?: number;
  /** The main agent's plan waits for Approve, which lives in Run. */
  planPending?: boolean;
  /** Accepted for callers; the bar is the same in focus mode. */
  focusMode?: boolean; split?: boolean;
  unified?: boolean;
  selectedRun?: OrchestrationRun | null;
  worker?: boolean;
}) {
  const active = snapshot.runs.find(isActiveRun);
  const run = selectedRun === undefined ? active ?? snapshot.runs[0] : selectedRun;
  // With both columns on screen there is nothing to switch between, so the
  // tabs go; approvals still need saying, and they move onto the run line.
  const views = (orchestrated || !!run) && !split;
  // The Chat/Run tabs and the run line are how you get back to work in
  // flight, so they stay in focus mode too. A normal chat has neither, so the
  // bar itself goes rather than leaving an empty rule across the column.
  if (!views && !run) return null;
  return <header className={unified ? "workflow-header" : undefined}>
    {unified && <h1 className="workflow-title">{run?.objective ?? "New run"}</h1>}
    <nav className="chat-workflow-bar" aria-label="Chat workflow">
    {views && <div className="chat-workflow-views" role="group" aria-label="Conversation view">
      <button type="button" aria-pressed={view === "run"} onClick={() => onView("run")}>{unified ? "Tasks" : "Run"}{planPending ? " (plan awaiting approval)" : ""}</button>
      <button type="button" aria-pressed={view === "chat"} onClick={() => onView("chat")}>Chat{pendingApprovals > 0 ? ` (${pendingApprovals} awaiting approval)` : ""}</button>
    </div>}
    {split && pendingApprovals > 0 && <span className="chat-workflow-approvals">{pendingApprovals} awaiting approval</span>}
    {run && <button type="button" className="chat-run-summary" onClick={() => onView("run")}
      title={isActiveRun(run) ? `Open ${unified ? "Tasks" : "Run"} to pause dispatch or stop. Chat messages go to the main agent.` : "Open run history"}>
      {runSummary(snapshot, run)}
    </button>}
  </nav></header>;
}

import type { OrchestrationSnapshot } from "../lib/orchestration";
import { isActiveRun, runSummary } from "../lib/chatWorkflow";
import "./ChatWorkflowBar.css";

export function ChatWorkflowBar({ snapshot, orchestrated, view, onMode, onView, disabled = false, pendingApprovals = 0 }: {
  snapshot: OrchestrationSnapshot; orchestrated: boolean; view: "chat" | "run";
  onMode: (orchestrated: boolean) => void; onView: (view: "chat" | "run") => void; disabled?: boolean; pendingApprovals?: number;
}) {
  const active = snapshot.runs.find(isActiveRun);
  const run = active ?? snapshot.runs[0];
  return <nav className="chat-workflow-bar" aria-label="Chat workflow">
    <label className="chat-execution">Execution
      <select aria-label="Execution mode" value={active || orchestrated ? "orchestrated" : "normal"}
        disabled={disabled} onChange={(event) => onMode(event.target.value === "orchestrated")}>
        <option value="normal" disabled={!!active}>Normal</option>
        <option value="orchestrated">Orchestrated</option>
      </select>
    </label>
    {(orchestrated || run) && <div className="chat-workflow-views" role="group" aria-label="Conversation view">
      <button type="button" aria-pressed={view === "chat"} onClick={() => onView("chat")}>Chat{pendingApprovals > 0 ? ` (${pendingApprovals} awaiting approval)` : ""}</button>
      <button type="button" aria-pressed={view === "run"} onClick={() => onView("run")}>Run</button>
    </div>}
    {run && <button type="button" className="chat-run-summary" onClick={() => onView("run")}
      title={active ? "Open Run to pause dispatch or stop. Chat messages go to the main agent." : "Open run history"}>
      {runSummary(snapshot, run)}
    </button>}
  </nav>;
}

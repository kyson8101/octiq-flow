import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { OrchestrationRun, OrchestrationSnapshot } from "../lib/orchestration";
import { isActiveRun, runSummary } from "../lib/chatWorkflow";
import "./ChatWorkflowBar.css";

export function ChatWorkflowBar({ snapshot, orchestrated, view, onMode, onView, disabled = false, pendingApprovals = 0, planPending = false, focusMode = false, split = false, unified = false, selectedRun, worker = false }: {
  snapshot: OrchestrationSnapshot; orchestrated: boolean; view: "chat" | "run";
  onMode: (orchestrated: boolean) => void; onView: (view: "chat" | "run") => void; disabled?: boolean;
  pendingApprovals?: number;
  /** The main agent's plan waits for Approve, which lives in Run. */
  planPending?: boolean; focusMode?: boolean; split?: boolean;
  unified?: boolean;
  selectedRun?: OrchestrationRun | null;
  worker?: boolean;
}) {
  const active = snapshot.runs.find(isActiveRun);
  const run = selectedRun === undefined ? active ?? snapshot.runs[0] : selectedRun;
  // With both columns on screen there is nothing to switch between, so the
  // tabs go; approvals still need saying, and they move onto the run line.
  const views = (orchestrated || !!run) && !split;
  // Focus mode is the conversation and nothing else, so the control that
  // CONFIGURES the chat goes; the Chat/Run tabs and the run line stay, because
  // they are how you get back to work in flight. A normal chat has neither, so
  // the bar itself goes rather than leaving an empty rule across the column.
  if (focusMode && !views && !run) return null;
  return <header className={unified ? "workflow-header" : undefined}>
    {unified && <RunTitle text={run?.objective ?? "New run"} />}
    <nav className="chat-workflow-bar" aria-label="Chat workflow">
    {!focusMode && !worker && <label className="chat-execution"><span className="chat-execution-label">Execution</span>
      <select aria-label="Execution mode" value={active || orchestrated ? "orchestrated" : "normal"}
        disabled={disabled} onChange={(event) => onMode(event.target.value === "orchestrated")}>
        <option value="normal" disabled={!!active}>Normal</option>
        <option value="orchestrated">Orchestrated</option>
      </select>
    </label>}
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

/** An objective is written for the agent, and can run to a paragraph. It gets
 *  two lines above the work; the rest opens on request, in place. */
function RunTitle({ text }: { text: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  useEffect(() => setOpen(false), [text]);
  // Measured, not guessed from the length: two lines hold very different
  // amounts of text in a 380px column and across a 1400px one. Only while
  // shut — an open title is never clipped, and would hide its own "Less".
  useLayoutEffect(() => {
    const title = ref.current;
    if (!title || open) return;
    const measure = () => setClipped(title.scrollHeight > title.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(title);
    return () => observer.disconnect();
  }, [text, open]);
  return <div className={`workflow-heading${open ? " is-open" : ""}`}>
    <h1 className="workflow-title" id={id} ref={ref} tabIndex={open ? 0 : undefined}>{text}</h1>
    {(clipped || open) && <button type="button" className="workflow-title-toggle" aria-expanded={open} aria-controls={id}
      aria-label={open ? "Show less of the objective" : "Show the full objective"}
      onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</button>}
  </div>;
}

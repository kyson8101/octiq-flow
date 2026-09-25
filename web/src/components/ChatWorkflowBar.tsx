import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { OrchestrationRun, OrchestrationSnapshot } from "../lib/orchestration";
import { isActiveRun, runSummary } from "../lib/chatWorkflow";
import { createPortal } from "react-dom";
import { useWorkspaceSlot } from "./WorkspaceHeader";
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
  const slot = useWorkspaceSlot("context");
  const active = snapshot.runs.find(isActiveRun);
  const run = selectedRun === undefined ? active ?? snapshot.runs[0] : selectedRun;
  // With both columns on screen there is nothing to switch between, so the
  // tabs go; approvals still need saying, and they move onto the run line.
  const views = (orchestrated || !!run) && !split;
  // The Chat/Run tabs and the run line are how you get back to work in
  // flight, so they stay in focus mode too. A normal chat has neither, so the
  // bar itself goes rather than leaving an empty rule across the column.
  if (!views && !run) return null;
  const title = unified && <RunTitle text={run?.objective ?? "New run"} />;
  const nav = <nav className="chat-workflow-bar" aria-label="Chat workflow">
    {views && <div className="chat-workflow-views" role="group" aria-label="Conversation view">
      <button type="button" aria-pressed={view === "run"} onClick={() => onView("run")}>{unified ? "Tasks" : "Run"}{planPending ? " (plan awaiting approval)" : ""}</button>
      <button type="button" aria-pressed={view === "chat"} onClick={() => onView("chat")}>Chat{pendingApprovals > 0 ? ` (${pendingApprovals} awaiting approval)` : ""}</button>
    </div>}
    {split && pendingApprovals > 0 && <span className="chat-workflow-approvals">{pendingApprovals} awaiting approval</span>}
    {run && <button type="button" className="chat-run-summary" onClick={() => onView("run")}
      title={isActiveRun(run) ? `Open ${unified ? "Tasks" : "Run"} to pause dispatch or stop. Chat messages go to the main agent.` : "Open run history"}>
      {runSummary(snapshot, run)}
    </button>}
  </nav>;
  // Where the app's top bar offers room, the run's title and its views ride
  // in it, after the chat's project, instead of a second header under it.
  if (slot) return createPortal(<div className="topbar-workflow">
    {title && <span className="topbar-crumb-sep" aria-hidden="true">/</span>}
    {title}{nav}
  </div>, slot);
  return <header className={unified ? "workflow-header" : undefined}>{title}{nav}</header>;
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
    <button type="button" className="workflow-title-toggle" hidden={!clipped && !open} aria-expanded={open} aria-controls={id}
      aria-label={open ? "Show less of the objective" : "Show full objective details"}
      onClick={() => setOpen(!open)}>{open ? "Show less" : "Show details"}</button>
  </div>;
}

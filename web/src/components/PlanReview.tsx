// Plan mode: the main agent's plan, laid out as the order it will run in, with
// the only two answers it can get — approve it, or say what to change.
//
// It stands in for the run's progress and task list while the plan waits,
// because a 0% bar over a column of "pending" rows says nothing about a plan.
// No worker starts until Approve: the host refuses them, this view only asks.
// Specs are the agent's prose, so each sits behind its task's disclosure.
import { useMemo, useState } from "react";
import { approvePlan } from "../lib/agentsMode";
import { modelFromReported } from "../lib/agentProviders";
import type { OrchestrationRun, OrchestrationTask } from "../lib/orchestration";
import {
  awaitingApproval, planDestination, planNumbers, planOwner, planStages, type PlanStage,
} from "../lib/planReview";
import { AgentLogo } from "./AgentLogo";
import { AgentAvatar } from "./AgentAvatar";
import { TaskPlanCard } from "./TaskPlanCard";
import { useRosterAgent } from "../lib/agentRoster";
import "./PlanReview.css";

export function PlanReview({ run, tasks, drafting, projectName, onApproved, onRequestChanges }: {
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
  /** The main agent is still in its turn: the plan may not be finished. */
  drafting: boolean;
  /** Names the run's own project for tasks without a destination. */
  projectName?: (id: string) => string | undefined;
  onApproved?: () => void;
  /** Sends the note to the main agent's chat. */
  onRequestChanges: (note: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const stages = useMemo(() => planStages(tasks), [tasks]);
  const numbers = useMemo(() => planNumbers(stages), [stages]);
  const waiting = useMemo(() => awaitingApproval(tasks), [tasks]);
  // Some of the plan was approved before: mark what is new since.
  const amended = waiting.length > 0 && waiting.length < tasks.filter((task) => !task.parentTaskId).length;
  const blocked = stages.some((stage) => stage.blocked);
  const empty = tasks.length === 0;

  const approve = async () => {
    setBusy(true);
    setError("");
    try {
      await approvePlan(run.coordinatorChatKey, run.id, waiting);
      onApproved?.();
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setBusy(false);
    }
  };
  const requestChanges = () => {
    const text = note.trim();
    if (!text) return;
    setError("");
    try {
      onRequestChanges(text);
      setNote("");
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const waitReason = drafting ? "The main agent is still writing the plan." : empty ? "The plan has no tasks yet." : "";
  return (
    <section className="plan-review" aria-labelledby="plan-review-title" data-drafting={drafting || undefined}>
      <header className="plan-review-head">
        <div className="plan-review-state">
          <span className="plan-review-dot" aria-hidden="true" />
          <h3 id="plan-review-title">{drafting ? "Drafting the plan" : "Plan ready for review"}</h3>
        </div>
        {!empty && <p className="plan-review-meta">
          {count(tasks.length, "task")} · {count(stages.length, "stage")}
        </p>}
      </header>

      {empty ? (
        <div className="plan-review-empty" aria-hidden={!drafting}>
          {drafting && [0, 1, 2].map((row) => <span key={row} className="plan-review-ghost" />)}
          <p>{drafting ? "Tasks appear here as the main agent writes them." : "No tasks yet. Ask the main agent for a plan in Chat."}</p>
        </div>
      ) : (
        <ol className="plan-stages">
          {stages.map((stage, index) => (
            <li className="plan-stage" key={index} data-blocked={stage.blocked || undefined}>
              <div className="plan-stage-head">
                <span className="plan-stage-num" aria-hidden="true">{stage.blocked ? "!" : index + 1}</span>
                <span className="plan-stage-title">{stageTitle(stage, index)}</span>
                {!stage.blocked && stage.tasks.length > 1 && <span className="plan-stage-note">{stage.tasks.length} side by side</span>}
              </div>
              <ul className="plan-stage-tasks">
                {stage.tasks.map((task) => (
                  <PlanTask key={task.id} task={task} run={run} projectName={projectName}
                    added={amended && waiting.includes(task.id)}
                    number={numbers.get(task.id) ?? 0} numbers={numbers} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}

      {error && <p className="plan-review-error" role="alert">{error}</p>}

      <footer className="plan-review-actions">
        <div className="plan-review-change">
          <textarea
            value={note}
            rows={1}
            placeholder="What should change?"
            aria-label="Changes to ask for"
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                requestChanges();
              }
            }}
          />
          <button className="plan-review-quiet" type="button" disabled={!note.trim()} onClick={requestChanges}>Request changes</button>
        </div>
        <div className="plan-review-approve">
          <span className="plan-review-hint">{waitReason || (blocked ? "Some tasks wait on each other and will never start." : "No worker starts until you approve.")}</span>
          <button className="orch-primary" type="button" disabled={busy || drafting || empty} onClick={() => void approve()}>
            {busy ? "Approving…" : "Approve plan"}
          </button>
        </div>
      </footer>
    </section>
  );
}

function PlanTask({ task, run, projectName, added, number, numbers }: {
  task: OrchestrationTask;
  run: OrchestrationRun;
  projectName?: (id: string) => string | undefined;
  /** Added since the person last approved this plan. */
  added: boolean;
  number: number;
  numbers: Map<string, number>;
}) {
  const owner = planOwner(task);
  const assigneeFace = useRosterAgent(task.assignee?.id);
  const model = owner.agent && task.worker?.model ? modelFromReported(owner.agent, task.worker.model)?.name : undefined;
  const after = task.dependsOn.flatMap((id) => numbers.has(id) ? [numbers.get(id)!] : []);
  const where = planDestination(task, run, projectName);
  const spec = task.spec.trim();
  const summary = <>
    <span className="plan-task-num">{number}</span>
    <span className="plan-task-main">
      <span className="plan-task-title">{task.title}</span>
      <span className="plan-task-where" title={`${where.project} · ${where.path}`}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span><span className="plan-task-project">{where.project}</span>{" · "}<span className="plan-task-repo">{where.repository}</span></span>
      </span>
    </span>
    {added && <span className="plan-task-new">New</span>}
    <span className="plan-task-owner" title={[owner.label, model].filter(Boolean).join(" · ")}>
      {task.assignee
        ? <AgentAvatar name={assigneeFace?.name ?? task.assignee.name} avatar={assigneeFace?.avatar} id={task.assignee.id} size={16} decorative />
        : owner.agent && <AgentLogo agent={owner.agent} size={13} />}
      <span>{task.assignee ? owner.label : model ?? owner.label}</span>
    </span>
    {after.length > 0 && <span className="plan-task-after">after {after.map((n) => `#${n}`).join(", ")}</span>}
  </>;
  return (
    <li className="plan-task">
      {/* The standard plan card first; the lead's full brief stays one
          disclosure further in, because it is written for the worker. */}
      <details>
        <summary>{summary}<span className="plan-task-chevron" aria-hidden="true" /></summary>
        <TaskPlanCard task={task} run={run} projectName={projectName} />
        {spec && (
          <details className="plan-task-brief">
            <summary>Full brief</summary>
            <div className="plan-task-spec">{spec}</div>
          </details>
        )}
      </details>
    </li>
  );
}

function stageTitle(stage: PlanStage, index: number) {
  if (stage.blocked) return "Waits on each other";
  return index === 0 ? "Starts on approval" : `After stage ${index}`;
}

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

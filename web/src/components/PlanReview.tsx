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
  awaitingApproval, planDestination, planNumbers, planOwner, planStages, planTasks, type PlanStage,
} from "../lib/planReview";
import { planHandle } from "../lib/chatPlans";
import { approveOnce, useApproving } from "../lib/planApproving";
import { AgentLogo } from "./AgentLogo";
import { AgentAvatar } from "./AgentAvatar";
import { TaskPlanCard } from "./TaskPlanCard";
import { useRosterAgent } from "../lib/agentRoster";
import "./PlanReview.css";

export function PlanReview({ run, tasks: allTasks, drafting, projectName, onApproved, onRequestChanges, chatHint, approved = false }: {
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
  /** The main agent is still in its turn: the plan may not be finished. */
  drafting: boolean;
  /** Names the run's own project for tasks without a destination. */
  projectName?: (id: string) => string | undefined;
  onApproved?: () => void;
  /** Sends the note to the main agent's chat. */
  onRequestChanges: (note: string) => void;
  /** Drawn inside the lead's own chat, whose message box is right below: the
   *  change box gives way to this line saying how to answer there. */
  chatHint?: string;
  /** The approved plan, for reading back: no answers to give. */
  approved?: boolean;
}) {
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const busy = useApproving(run.id);
  // A task the lead withdrew is no longer part of the plan.
  const tasks = useMemo(() => planTasks(allTasks), [allTasks]);
  const stages = useMemo(() => planStages(tasks), [tasks]);
  const numbers = useMemo(() => planNumbers(stages), [stages]);
  const waiting = useMemo(() => awaitingApproval(tasks), [tasks]);
  // Some of the plan was approved before: mark what is new since.
  const amended = !approved && waiting.length > 0 && waiting.length < tasks.filter((task) => !task.parentTaskId).length;
  const blocked = stages.some((stage) => stage.blocked);
  const empty = tasks.length === 0;
  const revision = run.planApproval?.revision;
  const handle = planHandle(run.id);

  const approve = async () => {
    setError("");
    try {
      // The revision on screen goes with the click: a plan the lead changed
      // a moment ago is refused, not approved unseen.
      const sent = await approveOnce(run.id, () => approvePlan(run.coordinatorChatKey, run.id, waiting, revision));
      if (sent) onApproved?.();
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
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

  // A busy main agent is only "drafting" while there is nothing to review.
  // Once tasks are on screen, its turn may be about anything — a reply, a
  // notification — and must not lock an approval of them. The approval names
  // the tasks it saw, and the host refuses it if the plan changed since.
  const stillDrafting = !approved && drafting && empty;
  const waitReason = stillDrafting ? "The main agent is still writing the plan." : empty ? "The plan has no tasks yet."
    : drafting ? "The main agent is still active. Approving covers the tasks shown." : "";
  const titleId = `plan-review-title-${run.id}`;
  return (
    <section className="plan-review" aria-labelledby={titleId} data-drafting={stillDrafting || undefined}
      data-approved={approved || undefined} data-plan={run.id} data-revision={revision}>
      <header className="plan-review-head">
        <div className="plan-review-state">
          <span className="plan-review-dot" aria-hidden="true" />
          <h3 id={titleId}>{approved ? "Plan approved" : stillDrafting ? "Drafting the plan" : "Plan ready for review"}</h3>
        </div>
        <p className="plan-review-meta">
          {/* Which plan and which version of it: what a chat approval names,
              and what tells an approved plan from a changed one. */}
          <span className="plan-review-id">Plan {handle}{revision ? ` · revision ${revision}` : ""}</span>
          {!empty && <> · {count(tasks.length, "task")} · {count(stages.length, "stage")}</>}
        </p>
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

      {!approved && <footer className="plan-review-actions">
        {chatHint ? <p className="plan-review-chat-hint">{chatHint}</p> : <div className="plan-review-change">
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
        </div>}
        <div className="plan-review-approve">
          <span className="plan-review-hint">{waitReason || (blocked ? "Some tasks wait on each other and will never start." : "No worker starts until you approve.")}</span>
          <button className="orch-primary" type="button" disabled={busy || empty} onClick={() => void approve()}>
            {busy ? "Approving…" : "Approve plan"}
          </button>
        </div>
      </footer>}
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

// Plan mode: the main agent's plan, laid out as the order it will run in, with
// the three answers it can get — approve, reject, or say what to change.
//
// It stands in for the run's progress and task list while the plan waits,
// because a 0% bar over a column of "pending" rows says nothing about a plan.
// No worker starts until Approve: the host refuses them, this view only asks.
// Specs are the agent's prose, so each sits behind its task's disclosure.
//
// In the lead's own chat it is a card among the others that wait on the
// person, and arrives folded like them (`folds`): its counts, each stage on
// one line, the answers. One control in the heading opens the tasks under
// their stages (`components/CardFold`), and that one opening is all of it:
// every task with who does it, where, its criteria, how its commands are
// approved and its whole brief, scrolling inside the card. Nothing the person
// approves is a second press away. The run panel is where a plan is browsed,
// and keeps a disclosure per task.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { approvePlan, rejectPlan } from "../lib/agentsMode";
import { modelFromReported } from "../lib/agentProviders";
import type { OrchestrationRun, OrchestrationTask } from "../lib/orchestration";
import { planHoldsEveryStart } from "../lib/taskHold";
import {
  awaitingApproval, nextPlanChanges, planDestination, planNumbers, planOwner, planStages, planTasks, stageSummary, type PlanChanges, type PlanStage,
} from "../lib/planReview";
import { planFoldId, planLabel, sizeLabel } from "../lib/cardFold";
import { FoldBody, FoldToggle, useFold } from "./CardFold";
import { planHandle } from "../lib/chatPlans";
import { approveOnce, useApproving } from "../lib/planApproving";
import { cardView, nextShown, PLAN_SETTLE_MS, settling, type PlanShown } from "../lib/planShown";
import { AgentLogo } from "./AgentLogo";
import { AgentAvatar } from "./AgentAvatar";
import { TaskPlanCard, type WorkspaceDecision } from "./TaskPlanCard";
import { readWorkspaceChoice, workspaceChoiceFact, workspaceDraft, workspaceOverrides, type WorkspaceDraft } from "../lib/workspaceChoice";
import { notePress } from "../lib/pressGuard";
import { CommandApprovalChoice } from "./CommandApprovalChoice";
import { useRosterAgent } from "../lib/agentRoster";
import "./PlanReview.css";

/** Beside Approve, when the plan holds only part of the run: the tasks the
 *  person approved before keep starting while this waits. */
export const PLAN_GOES_ON = "What you approved before goes on. The rest waits for this.";

/** Beside Approve, only while the host would refuse every start
 *  (`lib/taskHold.planHoldsEveryStart`). */
export const PLAN_STARTS_NOTHING = "No worker starts until you approve.";

export function PlanReview({ run, tasks: allTasks, drafting, projectName, onApproved, onRequestChanges, chatHint, approved = false, surface = "panel", folds = false, startOpen = false }: {
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
  /** Which card this is, recorded with an approval as what was clicked. */
  surface?: "chat" | "panel";
  /** Arrive folded: each stage on one line, its tasks behind the card's one
   *  disclosure. The chat's card; the run panel is the plan's own page and
   *  draws it out. */
  folds?: boolean;
  /** Draw a folded card opened: for the tests, which cannot press the control. */
  startOpen?: boolean;
}) {
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busyAction, setBusyAction] = useState<"approve" | "reject" | null>(null);
  const busy = useApproving(run.id);
  // A task the lead withdrew is no longer part of the plan.
  const tasks = useMemo(() => planTasks(allTasks), [allTasks]);
  const stages = useMemo(() => planStages(tasks), [tasks]);
  const numbers = useMemo(() => planNumbers(stages), [stages]);
  const waiting = useMemo(() => awaitingApproval(tasks), [tasks]);
  const [workspace, setWorkspace] = useState<WorkspaceDraft>(() => workspaceDraft(run));
  // Reset during render: even the first draw/click of a new revision uses
  // its advice, and returning to an old revision cannot resurrect a draft.
  if (workspace.runId !== run.id || workspace.revision !== run.planApproval?.revision) {
    setWorkspace(workspaceDraft(run));
    setError("");
  }
  const workspaceChoices = workspaceOverrides(workspace, run, tasks, waiting);
  const workspaceFact = workspaceChoiceFact(workspaceChoices);
  const workspaceDecision = (task: OrchestrationTask): WorkspaceDecision | undefined => {
    const choice = readWorkspaceChoice(task);
    if (approved || run.planApproval?.status !== "pending" || !waiting.includes(task.id) || !choice?.editable) return;
    return {
      value: workspaceChoices[task.id] ?? choice.advised,
      disabled: busy,
      onChange: (value) => setWorkspace((was) => ({ ...workspaceDraft(run), choices: {
        ...(was.runId === run.id && was.revision === run.planApproval?.revision ? was.choices : {}),
        [task.id]: value,
      } })),
    };
  };
  // Some of the plan was approved before: mark what is new since.
  const amended = !approved && waiting.length > 0 && waiting.length < tasks.filter((task) => !task.splitBy).length;
  const blocked = stages.some((stage) => stage.blocked);
  // The plan holds only what the person has not approved (the host's
  // `heldByPlan`): with a task of the run not held, a worker may well start
  // before they answer (a retry of one that failed, their own Start of one
  // they stopped), and the card must not say otherwise.
  const goesOn = !approved && run.planApproval?.status === "pending" && !planHoldsEveryStart(run, allTasks);
  const empty = tasks.length === 0;
  const revision = run.planApproval?.revision;
  const changesRef = useRef<PlanChanges | null>(null);
  changesRef.current = nextPlanChanges(changesRef.current, run.id, revision, allTasks);
  const changes = changesRef.current;
  const handle = planHandle(run.id);
  // Folded, the one control opens the tasks under every stage, and after
  // them the line on how to answer in chat.
  const folded = folds && !approved && !empty;
  // The fold is this revision's. A plan the lead changed is a new thing to
  // approve, and arrives folded whatever the last one was left at.
  const fold = useFold(planFoldId(run.id, revision), { parts: stages.length + 1, startOpen });
  const metaId = useId();
  // What this card has shown, and since when (see lib/planShown).
  const shownRef = useRef<PlanShown | null>(null);
  shownRef.current = nextShown(shownRef.current, revision, Date.now());
  const shown = shownRef.current;
  const [, recheck] = useState(0);
  const holding = !approved && settling(shown, Date.now());
  useEffect(() => {
    if (!holding || shown.replacedAt === null) return;
    const left = PLAN_SETTLE_MS - (Date.now() - shown.replacedAt);
    const timer = window.setTimeout(() => recheck((n) => n + 1), Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [holding, shown]);

  const approve = async () => {
    setError("");
    setBusyAction("approve");
    try {
      // The revision on screen goes with the click: a plan the lead changed
      // a moment ago is refused, not approved unseen.
      const sent = await approveOnce(run.id, () => approvePlan(run.coordinatorChatKey, run.id, waiting, revision,
        { surface, ...cardView(shownRef.current ?? shown, Date.now()) }, workspaceChoices));
      if (sent) onApproved?.();
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setBusyAction(null);
    }
  };
  const reject = async () => {
    setError("");
    setBusyAction("reject");
    try {
      const sent = await approveOnce(run.id, () => rejectPlan(run.coordinatorChatKey, run.id, waiting, revision, reason,
        { surface, ...cardView(shownRef.current ?? shown, Date.now()) }));
      if (sent) onApproved?.();
    } catch (failure) {
      setError(String((failure as Error).message ?? failure));
    } finally {
      setBusyAction(null);
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
  // The tasks have just arrived under the one-line card: it opens to them
  // rather than jumping. A card that starts out full has nothing to open from.
  const wasEmpty = useRef(empty);
  const arrived = useRef(false);
  if (wasEmpty.current !== empty) {
    arrived.current = wasEmpty.current && !empty;
    wasEmpty.current = empty;
  }
  const waitReason = holding ? `Updated just now to revision ${revision}. Look it over, then decide.`
    : drafting ? "The main agent is still active. Approving covers the tasks shown." : "";
  const titleId = `plan-review-title-${run.id}`;
  const errorLine = error && <p className="plan-review-error" role="alert">{error}</p>;
  return (
    <section className="plan-review" aria-labelledby={titleId} data-drafting={stillDrafting || undefined}
      data-compact={empty || undefined} data-updated={holding || undefined}
      data-approved={approved || undefined} data-folds={folded || undefined}
      data-open={(folded && fold.shown) || undefined} data-plan={run.id} data-revision={revision}>
      <header className="plan-review-head">
        <div className="plan-review-state">
          <span className="plan-review-dot" aria-hidden="true" />
          <h3 id={titleId}>{approved ? "Plan approved" : stillDrafting ? "Drafting the plan…" : empty ? "No tasks yet" : "Plan ready for review"}</h3>
        </div>
        <div className="plan-review-more">
          <p className="plan-review-meta" id={metaId}>
            {/* Which plan and which version of it: what a chat approval names,
                and what tells an approved plan from a changed one. */}
            <span className="plan-review-id">Plan {handle}{revision ? ` · revision ${revision}` : ""}</span>
            {!empty && (folded
              ? <> · {planLabel(tasks.length, stages.length)}</>
              : <> · {count(tasks.length, "task")} · {count(stages.length, "stage")}</>)}
            {workspaceFact && <span className="plan-workspace-fact"> · {workspaceFact}</span>}
          </p>
          {folded && <FoldToggle fold={fold} describedBy={metaId} what="the tasks" />}
        </div>
      </header>

      {!approved && (changes.added.length > 0 || changes.withdrawn.length > 0) && (
        <div className="plan-review-changes" role="status">
          <span>Changed in revision {revision}:</span>
          {changes.added.length > 0 && <p>Added: {changes.added.map((title, index) => <span key={index}>{index > 0 && "; "}<bdi>{title}</bdi></span>)}</p>}
          {changes.withdrawn.length > 0 && <p>Withdrawn: {changes.withdrawn.map((title, index) => <span key={index}>{index > 0 && "; "}<bdi>{title}</bdi></span>)}</p>}
        </div>
      )}

      {/* Nothing to decide yet: one line and what it is waiting for. No ghost
          rows and no answers, because a disabled Approve over an empty plan
          says nothing the heading has not. */}
      {empty ? <>
        {stillDrafting
          ? <p className="plan-review-sub" role="status" aria-live="polite">Tasks appear here as the main agent writes them.</p>
          : !approved && <p className="plan-review-sub">Ask the main agent for a plan in Chat.</p>}
        {errorLine}
      </> : (
        <div className="plan-review-body" data-arrived={arrived.current || undefined}>
          <div className="plan-review-body-in">
            <ol className="plan-stages">
              {stages.map((stage, index) => {
                const added = amended ? stage.tasks.filter((task) => waiting.includes(task.id)).length : 0;
                const list = (
                  <ul className="plan-stage-tasks">
                    {stage.tasks.map((task) => (
                      <PlanTask key={task.id} task={task} run={run} projectName={projectName} whole={folded}
                        workspaceDecision={workspaceDecision(task)}
                        added={amended && waiting.includes(task.id)}
                        number={numbers.get(task.id) ?? 0} numbers={numbers} />
                    ))}
                  </ul>
                );
                return (
                  <li className="plan-stage" key={index} data-blocked={stage.blocked || undefined}>
                    <div className="plan-stage-head">
                      <span className="plan-stage-num" aria-hidden="true">{stage.blocked ? "!" : index + 1}</span>
                      <span className="plan-stage-title">{stageTitle(stage, index)}</span>
                      {folded
                        ? <span className="plan-stage-note plan-stage-sum">{stageSummary(stage, run, projectName, tasks)}</span>
                        : !stage.blocked && stage.tasks.length > 1 && <span className="plan-stage-note">{stage.tasks.length} side by side</span>}
                      {folded && added > 0 && <span className="plan-task-new">{added} new</span>}
                    </div>
                    {folded ? <FoldBody fold={fold} part={index} bounded={false}>{list}</FoldBody> : list}
                  </li>
                );
              })}
            </ol>

            {folded && chatHint && (
              <FoldBody fold={fold} part={stages.length} bounded={false}>
                <p className="plan-review-chat-hint">{chatHint}</p>
              </FoldBody>
            )}

            {errorLine}

            {!approved && <footer className="plan-review-actions">
              {folded && chatHint ? null : chatHint ? <p className="plan-review-chat-hint">{chatHint}</p> : <div className="plan-review-change">
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
              {rejecting && <PlanRejectConfirmation reason={reason} busy={busy} disabled={holding}
                rejecting={busyAction === "reject"} onReason={setReason} onConfirm={() => void reject()}
                onCancel={() => { setRejecting(false); setReason(""); }} />}
              <div className="plan-review-approve">
                <span className="plan-review-hint" title={folded ? chatHint : undefined}>{waitReason || (blocked ? "Some tasks wait on each other and will never start." : goesOn ? PLAN_GOES_ON : PLAN_STARTS_NOTHING)}</span>
                {!rejecting && <button className="plan-review-reject" type="button" disabled={busy || holding} onClick={() => setRejecting(true)}>
                  Reject
                </button>}
                <button className="orch-primary" type="button" disabled={busy || holding} onClick={() => void approve()}>
                  {busyAction === "approve" ? "Approving…" : busy ? "Deciding…" : "Approve plan"}
                </button>
              </div>
            </footer>}
          </div>
        </div>
      )}
    </section>
  );
}

export function PlanRejectConfirmation({ reason, busy, disabled, rejecting, onReason, onConfirm, onCancel }: {
  reason: string;
  busy: boolean;
  disabled: boolean;
  rejecting: boolean;
  onReason: (reason: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return <div className="plan-review-reject-confirm">
    <input value={reason} maxLength={500} autoFocus placeholder="Reason (optional)" aria-label="Reason for rejecting plan"
      onChange={(event) => onReason(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onConfirm();
        }
        if (event.key === "Escape") onCancel();
      }} />
    <button className="plan-review-quiet" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    <button className="plan-review-reject" type="button" disabled={busy || disabled} onClick={onConfirm}>
      {rejecting ? "Rejecting…" : "Confirm reject"}
    </button>
  </div>;
}

function PlanTask({ task, run, projectName, added, number, numbers, whole = false, workspaceDecision }: {
  task: OrchestrationTask;
  run: OrchestrationRun;
  projectName?: (id: string) => string | undefined;
  /** Added since the person last approved this plan. */
  added: boolean;
  number: number;
  numbers: Map<string, number>;
  /** Drawn out in full, with nothing of it behind a disclosure of its own:
   *  the chat's card, whose one opening has to show what is being approved. */
  whole?: boolean;
  workspaceDecision?: WorkspaceDecision;
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
        {/* Drawn out, a destination is its whole path: two repositories can
            share a folder name, and the name alone would pass for either. */}
        <span><span className="plan-task-project">{where.project}</span>{" · "}<span className="plan-task-repo">{whole ? where.path : where.repository}</span></span>
      </span>
    </span>
    {added && <span className="plan-task-new">New</span>}
    {/* A peer request: a teammate asked for it, not the owner's manager. Its
        limit is working time (`peer_request.rs`), and the row says so. */}
    {task.peerRequest && (
      <span className="plan-task-after" title={`${task.peerRequest.maxMinutes} minutes of working time; waiting for a decision does not count, and it is not extended.`}>requested by <bdi>{task.peerRequest.requestedBy.name}</bdi> · {task.peerRequest.maxMinutes} min working time</span>
    )}
    <span className="plan-task-owner" title={[owner.label, model].filter(Boolean).join(" · ")}>
      {task.assignee
        ? <AgentAvatar name={assigneeFace?.name ?? task.assignee.name} avatar={assigneeFace?.avatar} id={task.assignee.id} size={16} decorative />
        : owner.agent && <AgentLogo agent={owner.agent} size={13} />}
      <span>{task.assignee ? owner.label : model ?? owner.label}</span>
    </span>
    {after.length > 0 && <span className="plan-task-after">after {after.map((n) => `#${n}`).join(", ")}</span>}
  </>;
  if (whole) {
    return (
      <li className="plan-task" data-whole="">
        <div className="plan-task-row">{summary}</div>
        <TaskPlanCard task={task} run={run} projectName={projectName} workspaceDecision={workspaceDecision} />
        <CommandApprovalChoice task={task} run={run} />
        {spec && (
          <div className="plan-task-brief">
            <div className="plan-task-brief-label">Full brief · {sizeLabel(spec)}</div>
            <div className="plan-task-spec">{spec}</div>
          </div>
        )}
      </li>
    );
  }
  return (
    <li className="plan-task">
      {/* The standard plan card first; the lead's full brief stays one
          disclosure further in, because it is written for the worker. */}
      <details>
        <summary onClick={notePress}>{summary}<span className="plan-task-chevron" aria-hidden="true" /></summary>
        <TaskPlanCard task={task} run={run} projectName={projectName} workspaceDecision={workspaceDecision} />
        <CommandApprovalChoice task={task} run={run} />
        {spec && (
          <details className="plan-task-brief">
            <summary onClick={notePress}>Full brief</summary>
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

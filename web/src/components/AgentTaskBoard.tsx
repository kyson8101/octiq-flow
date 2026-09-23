import { useEffect, useState } from "react";
import { agoLabel } from "../lib/chatTask";
import { modelFromId, modelFromReported, AGENT_NAME } from "../lib/agentProviders";
import { attemptIsLive, boardCounts, currentAttempt, runElapsed, shortWorkspacePath, taskAttempts, taskElapsed, taskProgress, taskStage, TASK_LABELS } from "../lib/agentTaskBoard";
import { workspaceDeliveryLabel, type OrchestrationSnapshot, type OrchestrationTask } from "../lib/orchestration";
import type { Conversation } from "../lib/store";
import { isUnread } from "../lib/unread";
import { elapsedLabel } from "../lib/working";
import { workerArchiveDisabledReason } from "../lib/workerArchive";
import { AgentLogo } from "./AgentLogo";
import "./AgentTaskBoard.css";

type Props = {
  snapshot: OrchestrationSnapshot;
  conversations: ReadonlyMap<string, Conversation>;
  currentConversation: string | null;
  onOpenChat: (chat: Conversation) => void;
  onArchiveWorker?: (attemptId: string) => void;
  archiving?: boolean;
};

export function AgentTaskBoard(props: Props) {
  const { snapshot, currentConversation } = props;
  const [chosenRun, setChosenRun] = useState<string | null>(null);
  const selectedRun = snapshot.attempts.find((attempt) => attempt.workerChatKey === `chat:${currentConversation}`)?.runId;
  const [now, setNow] = useState(Date.now);
  const live = snapshot.attempts.some((attempt) => attemptIsLive(snapshot, attempt));
  useEffect(() => {
    if (selectedRun) setChosenRun(selectedRun);
  }, [selectedRun]);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [live]);
  const run = snapshot.runs.find((item) => item.id === chosenRun) ?? snapshot.runs.find((item) => item.id === selectedRun) ?? snapshot.runs[0];
  if (!run) return null;
  const tasks = snapshot.tasks.filter((task) => task.runId === run.id);
  const visibleTasks = tasks.filter((task) => {
    const attempts = taskAttempts(snapshot, task);
    return !attempts.length || attempts.some((attempt) => attempt.archivedAt == null);
  });
  const counts = boardCounts(tasks);
  const elapsed = runElapsed(snapshot, run.id, now);
  return <section className="agent-board" aria-label="Agent task board">
    {snapshot.runs.length > 1 && <select className="agent-board-runs" aria-label="Task run" value={run.id} onChange={(event) => setChosenRun(event.target.value)}>
      {snapshot.runs.map((item) => <option key={item.id} value={item.id}>{item.objective}</option>)}
    </select>}
    <div className="agent-board-overview">
      <div className="agent-board-totals"><strong>{counts.done}<span> / {counts.total} done</span></strong><strong>{counts.percent}%</strong></div>
      <div className="agent-board-meter" role="progressbar" aria-label="Completed tasks" aria-valuemin={0} aria-valuemax={100} aria-valuenow={counts.percent} aria-valuetext={`${counts.done} of ${counts.total} tasks completed`}>
        {tasks.map((task) => <span key={task.id} data-status={task.status} title={`${task.title}: ${TASK_LABELS[task.status]}`} />)}
      </div>
      <div className="agent-board-counts">
        <span>{counts.todo} to do</span>
        {counts.running > 0 && <span className="agent-board-working">{counts.running} working</span>}
        {counts.blocked > 0 && <span className="agent-board-blocked">{counts.blocked} need attention</span>}
        {counts.cancelled > 0 && <span>{counts.cancelled} cancelled</span>}
        {elapsed !== null && <span className="agent-board-elapsed" title="Elapsed wall time from first dispatch to latest settlement; includes waits and overlaps between workers."><ClockIcon />{elapsedLabel(elapsed)} elapsed</span>}
      </div>
    </div>
    <ul className="agent-board-tasks">
      {visibleTasks.map((task) => <TaskRow key={task.id} {...props} task={task} now={now} />)}
    </ul>
    {!tasks.length && <p className="agent-board-empty">The main agent is planning the tasks.</p>}
    {visibleTasks.length < tasks.length && <p className="agent-board-empty">{tasks.length - visibleTasks.length} {tasks.length - visibleTasks.length === 1 ? "task has" : "tasks have"} archived workers. View them in Archived workers.</p>}
  </section>;
}

function TaskRow({ snapshot, conversations, currentConversation, onOpenChat, onArchiveWorker, archiving, task, now }: Props & { task: OrchestrationTask; now: number }) {
  const attempts = taskAttempts(snapshot, task);
  const current = currentAttempt(snapshot, task);
  const attempt = current?.archivedAt == null ? current : attempts.find((item) => item.archivedAt == null);
  const archiveReason = attempt ? workerArchiveDisabledReason(snapshot, attempt) : null;
  const chat = attempt && conversations.get(attempt.workerChatKey.replace(/^chat:/, ""));
  const report = attempt && snapshot.reports?.[attempt.workerChatKey];
  const progress = taskProgress(task, report);
  const stage = attempt?.status === "preparing" ? "Preparing workspace" : taskStage(task, report);
  const elapsed = taskElapsed(snapshot, task, now);
  const selected = attempts.some((item) => item.workerChatKey === `chat:${currentConversation}`);
  const unread = !!chat && isUnread(chat, currentConversation);
  const model = modelFromId(chat?.modelId ?? null) ?? (attempt ? modelFromReported(attempt.agent, attempt.model ?? "") : undefined);
  const path = task.workspace?.plan.cwd || attempt?.cwd;
  const branch = task.workspace?.plan.branch || attempt?.branch;
  const workspaceKind = task.workspace ? (task.workspace.plan.isRepo ? (task.workspace.plan.mode === "worktree" || task.workspace.plan.checkoutRoot !== task.workspace.plan.repositoryRoot ? "Worktree" : "Current checkout") : "Folder")
    : attempt ? (attempt.isWorktree ? "Worktree" : "Current checkout") : "Not assigned";
  const dependencies = task.dependsOn.map((id) => snapshot.tasks.find((item) => item.id === id)).filter((item) => !!item);
  const gate = snapshot.gates.find((item) => item.taskId === task.id && item.status === "open");
  return <li className={`agent-task${selected ? " is-selected" : ""}`} data-status={task.status}>
    <details open={selected || undefined}>
      <summary className="agent-task-summary" aria-label={`${task.title}, ${stage}${unread ? ", unread activity" : ""}`}>
        <span className="agent-task-glyph" aria-hidden="true"><StatusIcon status={task.status} /></span>
        <span className="agent-task-body">
          <span className="agent-task-heading"><strong title={task.title}>{task.title}</strong>{unread && <span className="agent-task-unread" title="Unread activity" />}
            <span className="agent-task-percent" title={task.status === "completed" ? "Task completed" : progress.total ? `${progress.done} of ${progress.total} reported steps done` : "No checklist reported"}>{progress.percent === null ? "—" : `${progress.percent}%`}</span>
          </span>
          <span className="agent-task-meta"><span className="agent-task-stage" title={stage}>{stage}</span>
            {progress.total > 0 && task.status !== "completed" && <span>{progress.done}/{progress.total}</span>}
            {attempt && <span className="agent-task-model" title={model?.model ?? AGENT_NAME[attempt.agent]}><AgentLogo agent={attempt.agent} size={10} /><span>{model?.model ?? AGENT_NAME[attempt.agent]}</span></span>}
            {elapsed !== null && <span className="agent-task-time" title="Total attempt time, including retries, preparation and decision waits"><ClockIcon />{elapsedLabel(elapsed)}</span>}
          </span>
          <span className="agent-task-workspace" title={path ? `${workspaceKind}: ${path}${branch ? `\nBranch: ${branch}` : ""}` : "Workspace will appear when this task is dispatched"}>
            <BranchIcon /><span>{path ? `${workspaceKind}${task.workspace?.state === "cleaned" ? " (removed)" : ""} · ${branch || shortWorkspacePath(path)}` : "Workspace pending"}</span><span className="agent-task-chevron" aria-hidden="true">⌄</span>
          </span>
        </span>
      </summary>
      <div className="agent-task-detail">
        <p className="agent-task-assignment">{task.spec}</p>
        {gate && <p className="agent-task-blocker">Needs a decision: {gate.question}</p>}
        {dependencies.length > 0 && <p>Depends on: {dependencies.map((item) => `${item.title}${item.status === "completed" ? " (done)" : ""}`).join(", ")}</p>}
        {report && <p className="agent-task-report">{progress.total ? `${progress.done}/${progress.total} steps done · ${progress.remaining} to do` : "No checklist reported"}<span>Reported {agoLabel(report.reportedAt, now)}</span></p>}
        {report?.steps.length ? <ol className="agent-task-steps" aria-label="Reported checklist">
          {report.steps.map((step, index) => <li key={index} data-state={step.state}><span aria-label={step.state}>{step.state === "done" ? "✓" : step.state === "active" ? "◉" : "○"}</span>{step.title}</li>)}
        </ol> : <p>{attempt ? "No checklist was reported." : "The worker will report its checklist when it starts."}</p>}
        {report?.nextStep && task.status !== "completed" && <p>{report.nextStep}</p>}
        <dl className="agent-task-environment">
          <dt>Environment</dt><dd>{workspaceKind}{task.workspace?.state === "cleaned" ? " (removed)" : ""}</dd>
          {branch && <><dt>Branch</dt><dd>{branch}</dd></>}
          {path && <><dt>Working folder</dt><dd>{path}</dd></>}
          {task.workspace?.plan.checkoutRoot && task.workspace.plan.checkoutRoot !== path && <><dt>Checkout root</dt><dd>{task.workspace.plan.checkoutRoot}</dd></>}
          {task.workspace?.plan.baseBranch && <><dt>Base branch</dt><dd>{task.workspace.plan.baseBranch}</dd></>}
          {task.workspace && <><dt>Delivery</dt><dd>{workspaceDeliveryLabel(task.workspace)}</dd></>}
          {elapsed !== null && <><dt>Total time</dt><dd>{elapsedLabel(elapsed)}{attempts.length > 1 ? ` across ${attempts.length} attempts` : ""}</dd></>}
        </dl>
        {task.result && <p className="agent-task-result">{task.result}</p>}
        {chat ? <button type="button" className="agent-task-activity" onClick={() => onOpenChat(chat)}>Open activity</button>
          : attempt && <p>Activity is unavailable for this attempt.</p>}
        {attempt && onArchiveWorker && <button type="button" className="agent-task-activity" disabled={archiving || !!archiveReason}
          title={archiveReason ?? "Hide this worker; its chat and task history are kept."}
          onClick={() => onArchiveWorker(attempt.id)}>Archive worker</button>}
        {attempts.length > 1 && <details className="agent-task-history"><summary>Earlier attempts ({attempts.length - 1})</summary>
          {attempts.filter((item) => item.id !== attempt?.id).map((item) => {
            const prior = conversations.get(item.workerChatKey.replace(/^chat:/, ""));
            return <button key={item.id} type="button" disabled={!prior} aria-current={prior?.id === currentConversation ? "page" : undefined} onClick={() => prior && onOpenChat(prior)}>Attempt {item.number}: {item.status}{item.archivedAt != null ? " · archived" : ""}</button>;
          })}
        </details>}
      </div>
    </details>
  </li>;
}

function ClockIcon() { return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></svg>; }
function BranchIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 7v10m12-10c0 7-12 3-12 10" /></svg>; }
function StatusIcon({ status }: { status: OrchestrationTask["status"] }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {status === "completed" ? <path d="m5 12 4 4L19 6" />
      : status === "running" ? <><path d="m13 2-8 12h6l-1 8 9-13h-7z" /></>
      : status === "blocked" || status === "failed" ? <><path d="M12 5v8" /><circle cx="12" cy="18" r=".8" /></>
      : status === "cancelled" ? <path d="m6 6 12 12M6 18 18 6" />
      : <><circle cx="12" cy="12" r="7" /><path d="M12 8v4l3 2" /></>}
  </svg>;
}

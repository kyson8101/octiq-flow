// The run, at sidebar size: how far along it is, and one line per task you can
// tap to open that worker's chat.
//
// It used to be the whole dashboard — checklists, briefs, workspace paths,
// earlier attempts, archive controls — inside a 280px column, which is how a
// chat list turned into a wall of text. All of that now lives in the Run
// column beside the conversation (`OrchestrationPanel`). What is left here is
// an index: where the work is, and how to get to it.
import { useEffect, useState } from "react";
import { boardCounts, currentAttempt, runElapsed, runIsLive, sortTasksByActivity, taskAttempts, taskProgress, taskStage, useElapsedTick } from "../lib/agentTaskBoard";
import type { OrchestrationSnapshot, OrchestrationTask } from "../lib/orchestration";
import type { Conversation } from "../lib/store";
import { isUnread } from "../lib/unread";
import { elapsedLabel } from "../lib/working";
import { ClockIcon, TaskMeter, TaskStatusIcon } from "./TaskMeter";
import "./AgentTaskBoard.css";

type Props = {
  snapshot: OrchestrationSnapshot;
  conversations: ReadonlyMap<string, Conversation>;
  currentConversation: string | null;
  onOpenChat: (chat: Conversation) => void;
};

export function AgentTaskBoard(props: Props) {
  const { snapshot, currentConversation } = props;
  const [chosenRun, setChosenRun] = useState<string | null>(null);
  const selectedRun = snapshot.attempts.find((attempt) => attempt.workerChatKey === `chat:${currentConversation}`)?.runId;
  const now = useElapsedTick(runIsLive(snapshot));
  useEffect(() => {
    if (selectedRun) setChosenRun(selectedRun);
  }, [selectedRun]);
  const run = snapshot.runs.find((item) => item.id === chosenRun) ?? snapshot.runs.find((item) => item.id === selectedRun) ?? snapshot.runs[0];
  if (!run) return null;
  const tasks = snapshot.tasks.filter((task) => task.runId === run.id);
  const visibleTasks = sortTasksByActivity(tasks.filter((task) => {
    const attempts = taskAttempts(snapshot, task);
    return !attempts.length || attempts.some((attempt) => attempt.archivedAt == null);
  }), snapshot.attempts);
  const counts = boardCounts(tasks, snapshot);
  const elapsed = runElapsed(snapshot, run.id, now);
  return <section className="agent-board" aria-label="Agent task board">
    {snapshot.runs.length > 1 && <select className="agent-board-runs" aria-label="Task run" value={run.id} onChange={(event) => setChosenRun(event.target.value)}>
      {snapshot.runs.map((item) => <option key={item.id} value={item.id}>{item.objective}</option>)}
    </select>}
    <div className="agent-board-overview">
      <div className="agent-board-totals"><strong>{counts.done}<span> / {counts.total} done</span></strong><strong>{counts.percent}%</strong></div>
      <TaskMeter tasks={tasks} done={counts.done} />
      <div className="agent-board-counts">
        <span>{counts.todo} to do</span>
        {counts.running > 0 && <span className="agent-board-working">{counts.running} working</span>}
        {counts.blocked > 0 && <span className="agent-board-blocked">{counts.blocked} {counts.blocked === 1 ? "needs" : "need"} attention</span>}
        {counts.cancelled > 0 && <span>{counts.cancelled} cancelled</span>}
        {elapsed !== null && <span className="agent-board-elapsed" title="Elapsed wall time from first dispatch to latest settlement; includes waits and overlaps between workers."><ClockIcon />{elapsedLabel(elapsed)} elapsed</span>}
      </div>
    </div>
    <ul className="agent-board-tasks">
      {visibleTasks.map((task) => <TaskRow key={task.id} {...props} task={task} />)}
    </ul>
    {!tasks.length && <p className="agent-board-empty">The main agent is planning the tasks.</p>}
    {visibleTasks.length < tasks.length && <p className="agent-board-empty">{tasks.length - visibleTasks.length} {tasks.length - visibleTasks.length === 1 ? "task has" : "tasks have"} archived workers. View them in Archived workers.</p>}
  </section>;
}

function TaskRow({ snapshot, conversations, currentConversation, onOpenChat, task }: Props & { task: OrchestrationTask }) {
  const attempts = taskAttempts(snapshot, task);
  const current = currentAttempt(snapshot, task);
  const attempt = current?.archivedAt == null ? current : attempts.find((item) => item.archivedAt == null);
  const chat = attempt && conversations.get(attempt.workerChatKey.replace(/^chat:/, ""));
  const report = attempt && snapshot.reports?.[attempt.workerChatKey];
  const progress = taskProgress(task, report);
  const stage = !attempt?.execution && attempt?.status === "preparing" ? "Preparing workspace" : taskStage(task, report, attempt);
  const selected = attempts.some((item) => item.workerChatKey === `chat:${currentConversation}`);
  const unread = !!chat && isUnread(chat, currentConversation);
  const body = <>
    <span className="agent-task-glyph" aria-hidden="true"><TaskStatusIcon status={task.status} /></span>
    <span className="agent-task-body">
      <span className="agent-task-heading">
        <strong title={task.title}>{task.title}</strong>
        {unread && <span className="agent-task-unread" title="Unread activity" />}
        <span className="agent-task-percent" title={task.status === "completed" ? "Task completed" : progress.total ? `${progress.done} of ${progress.total} reported steps done` : "No checklist reported"}>{progress.percent === null ? "—" : `${progress.percent}%`}</span>
      </span>
      <span className="agent-task-meta"><span className="agent-task-stage" title={attempt?.execution?.latestError?.message || stage}>{stage}</span></span>
    </span>
  </>;
  // A task with no transcript yet is not navigation, so it is not a button —
  // a control that cannot go anywhere is worse than a line of text.
  return <li className={`agent-task${selected ? " is-selected" : ""}`} data-status={task.status}>
    {chat
      ? <button type="button" className="agent-task-row" aria-current={selected ? "page" : undefined}
          aria-label={`${task.title}, ${stage}${unread ? ", unread activity" : ""}`}
          onClick={() => onOpenChat(chat)}>{body}</button>
      : <span className="agent-task-row is-static">{body}</span>}
  </li>;
}

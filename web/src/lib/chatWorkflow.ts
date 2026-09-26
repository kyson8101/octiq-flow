import type { Conversation } from "./store";
import { workerArchiveChatList } from "./workerArchive";
import { EMPTY_ORCHESTRATION, type OrchestrationSnapshot, type OrchestrationRun } from "./orchestration";

export const isActiveRun = (run: OrchestrationRun) => ["planning", "running", "waiting"].includes(run.status);

/** Scope by coordinator identity, never just by project. One chat can own many runs. */
export function chatSnapshot(snapshot: OrchestrationSnapshot, coordinatorKey: string | null): OrchestrationSnapshot {
  if (!coordinatorKey) return EMPTY_ORCHESTRATION;
  const runs = snapshot.runs.filter((run) => run.coordinatorChatKey === coordinatorKey)
    .sort((a, b) => Number(isActiveRun(b)) - Number(isActiveRun(a)) || b.createdAt - a.createdAt);
  const ids = new Set(runs.map((run) => run.id));
  return { runs, reports: snapshot.reports, tasks: snapshot.tasks.filter((task) => ids.has(task.runId)),
    attempts: snapshot.attempts.filter((attempt) => ids.has(attempt.runId)),
    gates: snapshot.gates.filter((gate) => ids.has(gate.runId)),
    messages: snapshot.messages.filter((message) => ids.has(message.runId)),
    notifications: snapshot.notifications?.filter((notification) => ids.has(notification.runId)) };
}

export function runSummary(snapshot: OrchestrationSnapshot, run: OrchestrationRun): string {
  const tasks = snapshot.tasks.filter((task) => task.runId === run.id);
  const gates = snapshot.gates.filter((gate) => gate.runId === run.id && gate.status === "open");
  const progress = `${tasks.filter((task) => task.status === "completed").length}/${tasks.length} done`;
  if (gates.length) return `Needs decision · ${progress}`;
  if (tasks.some((task) => task.status === "blocked" || task.status === "failed") && isActiveRun(run)) return `Needs attention · ${progress}`;
  const label = run.status.charAt(0).toUpperCase() + run.status.slice(1);
  return `${label} · ${progress}`;
}

/**
 * A main chat's status line in the chat list. The progress is the run on show;
 * a chat that has run more than once has had more tasks than that run holds,
 * so the line also says how many in all. Without it "0/1" sat beside a
 * "2 tasks" counted across every run, and read as a contradiction.
 * `snapshot` is the chat's own (`chatSnapshot`).
 */
export function chatRunStatus(snapshot: OrchestrationSnapshot, run: OrchestrationRun): string {
  const summary = runSummary(snapshot, run);
  const total = snapshot.tasks.length;
  const inRun = snapshot.tasks.filter((task) => task.runId === run.id).length;
  if (snapshot.runs.length < 2 || total === inRun) return summary;
  return `${summary} · ${total} ${total === 1 ? "task" : "tasks"} in ${snapshot.runs.length} runs`;
}

/** Keep old attempts searchable and selectable, but group the ordinary list by task. */
export function workflowChatList(chats: Conversation[], snapshot: OrchestrationSnapshot, selectedId: string | null): Conversation[] {
  const chatIds = new Set(chats.map((chat) => chat.id));
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  const hidden = new Set<string>();
  for (const task of snapshot.tasks) {
    const attempts = snapshot.attempts.filter((a) => a.taskId === task.id).sort((a, b) => b.number - a.number);
    const current = attempts.find((a) => a.id === task.activeAttemptId) ?? attempts[0];
    const parent = runs.get(task.runId)?.coordinatorChatKey.replace(/^chat:/, "");
    if (!current || !parent || !chatIds.has(parent) || !chatIds.has(current.workerChatKey.replace(/^chat:/, ""))) continue;
    for (const attempt of attempts) if (attempt.id !== current.id) hidden.add(attempt.workerChatKey.replace(/^chat:/, ""));
  }
  return workerArchiveChatList(chats, snapshot).filter((chat) => chat.id === selectedId || !hidden.has(chat.id));
}

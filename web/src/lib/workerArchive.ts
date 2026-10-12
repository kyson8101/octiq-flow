import { isSettled, type OrchestrationAttempt, type OrchestrationSnapshot } from "./orchestration";
import { openGates } from "./runWaits";
import type { Conversation } from "./store";

export function workerArchiveDisabledReason(snapshot: OrchestrationSnapshot, attempt: OrchestrationAttempt): string | null {
  const task = snapshot.tasks.find((task) => task.id === attempt.taskId);
  if (!task || !isSettled(task) || snapshot.attempts.some((other) =>
    other.taskId === task.id && ["preparing", "running"].includes(other.status))) {
    return "Complete the task and settle its workers before archiving.";
  }
  if (openGates(snapshot, task.runId).some((gate) => !gate.taskId || gate.taskId === task.id)) {
    return "Resolve the open decision before archiving.";
  }
  const workspace = task.workspace;
  if (workspace?.abandoned) return "Only workers for merged tasks can be archived.";
  if (!workspace || !["retained", "cleaned"].includes(workspace.state)
    || !workspace.delivery?.merged || workspace.delivery.dirty) {
    return "Refresh delivery status to verify a clean, merged task before archiving.";
  }
  return null;
}

export function workerArchiveChatList(chats: Conversation[], snapshot: OrchestrationSnapshot, archived = false): Conversation[] {
  const ids = new Set(snapshot.attempts.filter((attempt) => attempt.archivedAt != null)
    .map((attempt) => attempt.workerChatKey.replace(/^chat:/, "")));
  return chats.filter((chat) => ids.has(chat.id) === archived);
}

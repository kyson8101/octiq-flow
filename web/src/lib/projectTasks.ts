// Which chats belong to a project, for the Projects page.
//
// Deliberately NOT the sidebar's list: that one is cut by the Recent view
// (active / pinned / done / all), and a project's page answers a different
// question — "what has ever been done here" — so a ticked-off or pinned chat
// is listed exactly like any other. Only the project decides membership.
import type { Conversation } from "./store";
import { projectConversationCounts, projectConversations } from "./conversationProjects";
import { EMPTY_ORCHESTRATION, type OrchestrationSnapshot } from "./orchestration";

const NO_COORDINATORS: ReadonlySet<string> = new Set();

/** Every chat in `projectId`, most recently active first. */
export function projectTasks(
  chats: readonly Conversation[],
  projectId: string,
  snapshot: OrchestrationSnapshot | null = EMPTY_ORCHESTRATION,
  coordinatorChatKeys: ReadonlySet<string> = NO_COORDINATORS,
): Conversation[] {
  return projectConversations(chats, projectId, snapshot, coordinatorChatKeys);
}

/** How many chats each project holds, for the project list's counts. */
export function projectTaskCounts(
  chats: readonly Conversation[],
  snapshot: OrchestrationSnapshot | null = EMPTY_ORCHESTRATION,
  coordinatorChatKeys: ReadonlySet<string> = NO_COORDINATORS,
): Map<string, number> {
  return projectConversationCounts(chats, snapshot, coordinatorChatKeys);
}

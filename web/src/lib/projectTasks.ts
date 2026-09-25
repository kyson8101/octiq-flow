// Which chats belong to a project, for the Projects page.
//
// Deliberately NOT the sidebar's list: that one is cut by the Recent view
// (active / pinned / done / all), and a project's page answers a different
// question — "what has ever been done here" — so a ticked-off or pinned chat
// is listed exactly like any other. Only the project decides membership.
import type { Conversation } from "./store";

/** Every chat in `projectId`, most recently active first. */
export function projectTasks(chats: readonly Conversation[], projectId: string): Conversation[] {
  return chats
    .filter((chat) => chat.projectId === projectId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** How many chats each project holds, for the project list's counts. */
export function projectTaskCounts(chats: readonly Conversation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const chat of chats) counts.set(chat.projectId, (counts.get(chat.projectId) ?? 0) + 1);
  return counts;
}

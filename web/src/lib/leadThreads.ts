import { asksPerson, type ChatHold } from "./chatWait";
import type { PendingAction } from "./pendingActions";
import type { Conversation } from "./store";
import { isUnread } from "./unread";

export const leadsOnlyMode = (agentsMode: boolean, orientation: "tasks" | "agents" | undefined) => agentsMode && orientation === "agents";

export type LeadThread = { agentId: string; name: string; chatKey: string; cwd: string; project?: string; exists: boolean };
export type LeadHistoryEntry = { chatKey: string; title: string; updatedAt: number; done: boolean };
export type LeadThreadsReading = { threads: readonly LeadThread[] | null; error: string | null };

export function leadThreadAgent(chat: Pick<Conversation, "id" | "leadOf"> | undefined): string | null {
  return chat?.leadOf ?? (chat?.id.startsWith("lead-") ? chat.id.slice(5) || null : null);
}

/** Head wins regardless of row order (which follows waits and recent activity). */
export function newConversationLead(threads: readonly LeadThread[], headId?: string, pickedId?: string | null): LeadThread | null {
  return threads.find(row => row.agentId === pickedId)
    ?? threads.find(row => row.agentId === headId) ?? threads[0] ?? null;
}

/** Uses the same readings as the chat/composer; no card or activity reader here. */
export function leadRowStatus(chat: Conversation | undefined, current: string | null, busy: ReadonlySet<string>, waits: ReadonlyMap<string, ChatHold>, actions: readonly PendingAction[]) {
  const needsYou = !!chat && (asksPerson(waits.get(chat.id)) || actions.length > 0);
  return { needsYou, working: !!chat && busy.has(chat.id) && !waits.has(chat.id) && !needsYou,
    unread: chat && isUnread(chat, current) ? 1 : 0 };
}


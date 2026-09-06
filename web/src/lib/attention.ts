import type { ChatState } from "./chat";
import { someoneWorking } from "./carryOn";
import type { Conversation } from "./store";

export type AttentionKind = "permission" | "question" | "safety" | "failure" | "interrupted" | "completed";
type Pending = Readonly<Record<string, readonly unknown[] | undefined>>;

export type AttentionInput = {
  conversations: readonly Conversation[];
  /** Include shelved projects: attention belongs to conversations in every project. */
  projects: readonly { id: string; name: string }[];
  /** Only already-loaded transcripts. No transcript fetching is needed. */
  chats: Readonly<Record<string, ChatState | undefined>>;
  running: Set<string>;
  liveKnown: boolean;
  connected: boolean;
  currentConversationId: string | null;
  asks?: Pending;
  questions?: Pending;
  safetyBlocks?: Pending;
  activeRounds?: ReadonlySet<string>;
  /** Optional recovery policy, including room handover grace. When provided,
   * only these missing-process busy chats may be labelled interrupted. */
  interruptedIds?: ReadonlySet<string>;
};

export type AttentionEntry = {
  conversation: Conversation;
  projectName: string;
  kind: AttentionKind;
  reason: string;
  /** Failures are durable; offline, their text describes the last loaded record. */
  stale: boolean;
};

export type AttentionObservation = {
  busy: ReadonlySet<string>;
  completed: ReadonlySet<string>;
  reliable: boolean;
};

export function emptyAttentionObservation(): AttentionObservation {
  return { busy: new Set(), completed: new Set(), reliable: false };
}

/** Observe transitions, never infer unseen work from an idle transcript or an
 * absent process. A connection gap discards the prior busy baseline. */
export function observeAttention(previous: AttentionObservation, input: AttentionInput): AttentionObservation {
  const reliable = input.connected && input.liveKnown;
  const ids = new Set(input.conversations.map((conversation) => conversation.id));
  const busy = new Set<string>();
  const completed = new Set([...previous.completed].filter((id) => ids.has(id)));
  for (const id of ids) {
    const chat = input.chats[id];
    if (chat?.busy) {
      if (reliable && someoneWorking({ id, running: input.running, round: input.activeRounds?.has(id) ?? false })) busy.add(id);
      completed.delete(id);
    } else if (
      chat && reliable && previous.reliable && previous.busy.has(id)
      && !chat.failure && !chat.stopping && !chat.stoppedAt
      && !(chat.exited && chat.exited.code !== 0)
    ) {
      completed.add(id);
    }
    if (chat?.failure || chat?.stopping || chat?.stoppedAt || (chat?.exited && chat.exited.code !== 0)) completed.delete(id);
  }
  if (input.currentConversationId) completed.delete(input.currentConversationId);
  return { busy, completed, reliable };
}

const priority: Record<AttentionKind, number> = {
  permission: 0, question: 1, safety: 2, failure: 3, interrupted: 4, completed: 5,
};

export function selectAttention(input: AttentionInput, completed: ReadonlySet<string>): AttentionEntry[] {
  const projects = new Map(input.projects.map((project) => [project.id, project.name]));
  const fresh = input.connected && input.liveKnown;
  const entries: AttentionEntry[] = [];
  for (const conversation of input.conversations) {
    const id = conversation.id;
    const chat = input.chats[id];
    const live = someoneWorking({ id, running: input.running, round: input.activeRounds?.has(id) ?? false });
    const permissions = input.asks?.[id]?.length ?? 0;
    const questions = input.questions?.[id]?.length ?? 0;
    const blocked = input.safetyBlocks?.[id]?.length ?? 0;
    let kind: AttentionKind;
    let reason: string;
    // Pending-request events are authoritative and can precede the roster's
    // adoption of a newly started process or a room handover.
    if (fresh && permissions) {
      kind = "permission";
      reason = `${permissions} permission ${permissions === 1 ? "request" : "requests"}`;
    } else if (fresh && questions) {
      kind = "question";
      reason = `${questions} ${questions === 1 ? "question needs" : "questions need"} an answer`;
    } else if (fresh && blocked) {
      kind = "safety";
      reason = "Blocked action needs review";
    } else if (chat?.failure) {
      kind = "failure";
      reason = chat.failure.title;
    } else if (chat?.exited && chat.exited.code !== 0 && !chat.busy && !chat.stopping && !chat.stoppedAt) {
      kind = chat.exited.code === null ? "interrupted" : "failure";
      reason = chat.exited.code === null ? "Agent process ended · exit status unknown" : `Agent process failed · exit code ${chat.exited.code}`;
    } else if (fresh && chat?.busy && !live && !chat.stopping && (input.interruptedIds === undefined || input.interruptedIds.has(id))) {
      kind = "interrupted";
      reason = "Turn interrupted · no agent is running";
    } else if (completed.has(id) && id !== input.currentConversationId && !chat?.busy
      && !chat?.stopping && !chat?.stoppedAt && !(chat?.exited && chat.exited.code !== 0)) {
      kind = "completed";
      reason = "New reply ready to review";
    } else {
      continue;
    }
    entries.push({ conversation, projectName: projects.get(conversation.projectId) || "Unknown project", kind, reason, stale: !fresh });
  }
  // Preserve conversation order within each reason, so streaming does not
  // continually move a row beneath the pointer.
  return entries.sort((a, b) => priority[a.kind] - priority[b.kind]);
}

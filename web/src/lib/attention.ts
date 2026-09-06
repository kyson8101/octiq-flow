import type { ChatState } from "./chat";
import { someoneWorking } from "./carryOn";
import type { Conversation } from "./store";

export type AttentionKind = "permission" | "question" | "safety" | "failure" | "interrupted";
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

const priority: Record<AttentionKind, number> = {
  permission: 0, question: 1, safety: 2, failure: 3, interrupted: 4,
};

export function selectAttention(input: AttentionInput): AttentionEntry[] {
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
    } else {
      continue;
    }
    entries.push({ conversation, projectName: projects.get(conversation.projectId) || "Unknown project", kind, reason, stale: !fresh });
  }
  // Preserve conversation order within each reason, so streaming does not
  // continually move a row beneath the pointer.
  return entries.sort((a, b) => priority[a.kind] - priority[b.kind]);
}

import type { ChatState } from "./chat";

export type RecoveryEvidence = {
  connected: boolean;
  /** A roster received on the current connection, not one from before disconnect. */
  rosterKnown: boolean;
  busy: boolean;
  /** Includes room seats and active rounds. */
  live: boolean;
  /** An exit recorded for this conversation's latest turn. */
  exited?: { code: number | null };
  /** Last recorded transcript sequence; this is not a file-save checkpoint. */
  checkpointSeq?: number;
  /** Messages observed queued for this conversation. */
  queuedCount?: number;
};

export function deriveRecovery(evidence: RecoveryEvidence) {
  const { connected, rosterKnown, busy, live, exited } = evidence;
  const interrupted = busy || (exited !== undefined && exited.code !== 0);
  if (!interrupted) return { kind: "hidden", canContinue: false } as const;
  if (!connected) return { kind: "offline", canContinue: false } as const;
  if (!rosterKnown) return { kind: "checking", canContinue: false } as const;
  if (live) return { kind: "hidden", canContinue: false } as const;
  return { kind: exited ? "exited" : "missing", canContinue: true } as const;
}

/** Count only the current trailing host queue with canonical prompt identities.
 * Historical user messages lacking an echo are not proof of pending work.
 * undefined means the available transcript cannot establish the queue count. */
export function queuedMessageCount(chat: Pick<import("./chat").ChatState, "messages">): number | undefined {
  let count = 0;
  for (let index = chat.messages.length - 1; index >= 0; index--) {
    const message = chat.messages[index];
    if (message.queueLost) continue;
    if (message.role !== "user" || message.echo || message.takenUp) break;
    // Seat messages have different acceptance semantics; don't infer a host queue.
    if (message.to || !message.turnId) return undefined;
    count++;
  }
  if (count > 0) return count;
  return chat.messages.some((message) => message.role === "user" && (message.turnId || message.echo || message.takenUp))
    ? 0
    : undefined;
}
export type ChatQueueState = { live: boolean; queuedTurnIds: string[] };

/** Only reconcile a settled chat against a connected backend snapshot. A
 * completed turn alone says nothing about prompts still waiting behind it. */
export function reconcileUnsentMessages(chat: ChatState, queue: ChatQueueState): ChatState {
  if (chat.busy || queue.live) return chat;
  const queued = new Set(queue.queuedTurnIds);
  let changed = false;
  const messages = chat.messages.map((message) => {
    if (message.role !== "user" || !message.turnId || message.echo || message.takenUp) return message;
    const lost = !queued.has(message.turnId);
    if (!!message.queueLost === lost) return message;
    changed = true;
    return { ...message, queueLost: lost || undefined };
  });
  return changed ? { ...chat, messages } : chat;
}

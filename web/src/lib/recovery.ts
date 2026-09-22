import type { ChatState } from "./chat";

/** A live provider event that proves a turn has started on this connection.
 *
 * Backend-initiated continuations (notably an answered saved question) do not
 * pass through the browser's send path, so the browser cannot optimistically
 * add their process to its running roster. The first live turn event is the
 * authoritative replacement for that missing local knowledge. Keep this
 * narrower than "any chat event": durable user and delivery envelopes can be
 * emitted before a worker exists. */
export function provesLiveTurn(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const event = raw as { type?: unknown; event?: unknown };
  if (event.type === "turn.started") return true;
  if (event.type !== "stream_event" || !event.event || typeof event.event !== "object") return false;
  return (event.event as { type?: unknown }).type === "message_start";
}

/** Count only the current trailing host queue with canonical prompt identities.
 * Historical user messages lacking an echo are not proof of pending work.
 * undefined means the available transcript cannot establish the queue count. */
export function queuedMessageCount(chat: Pick<import("./chat").ChatState, "messages">): number | undefined {
  let count = 0;
  for (let index = chat.messages.length - 1; index >= 0; index--) {
    const message = chat.messages[index];
    if (message.queueLost || message.delivery === "dispatched" || message.delivery === "unknown" || message.delivery === "sending") continue;
    if (message.role !== "user" || message.echo || message.takenUp) break;
    // Historical targeted messages have different acceptance semantics.
    if (message.to || !message.turnId) return undefined;
    count++;
  }
  if (count > 0) return count;
  return chat.messages.some((message) => message.role === "user" && (message.turnId || message.echo || message.takenUp))
    ? 0
    : undefined;
}
export type ChatQueueState = { live: boolean; queuedTurnIds: string[] };

/** Reconcile transport ownership even while another answer is streaming.
 * A live process without a queue entry is ambiguous on older transcripts;
 * never invent a provider acknowledgement from the absence of an entry. */
export function reconcileUnsentMessages(chat: ChatState, queue: ChatQueueState): ChatState {
  const queued = new Set(queue.queuedTurnIds);
  let changed = false;
  const messages = chat.messages.map((message) => {
    if (message.role !== "user" || !message.turnId || message.echo || message.takenUp) return message;
    if ((message.delivery === "failed" || message.delivery === "unknown") && !queued.has(message.turnId)) return message;
    if (message.delivery === "dispatched" && !queued.has(message.turnId)) {
      if (queue.live) return message;
      changed = true;
      return { ...message, delivery: "unknown", queueLost: undefined } as typeof message;
    }
    const delivery = queued.has(message.turnId) ? (message.delivery === "starting" ? "starting" : "queued") : queue.live ? "unknown" : "failed";
    const lost = delivery === "failed";
    if (!!message.queueLost === lost && message.delivery === delivery) return message;
    changed = true;
    return { ...message, delivery, queueLost: lost || undefined } as typeof message;
  });
  return changed ? { ...chat, messages } : chat;
}

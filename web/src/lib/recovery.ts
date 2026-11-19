import { ownsTurnId, type ChatState } from "./chat";
import { deliveryLookupHeld } from "./turnDelivery";

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

export type ChatQueueState = { live: boolean; queuedTurnIds: string[] };

/** Reconcile transport ownership even while another answer is streaming.
 * A live process without a queue entry is ambiguous on older transcripts;
 * never invent a provider acknowledgement from the absence of an entry. */
export function reconcileUnsentMessages(chat: ChatState, queue: ChatQueueState): ChatState {
  const isQueued = (message: ChatState["messages"][number]) =>
    queue.queuedTurnIds.some((turnId) => ownsTurnId(message, turnId));
  let changed = false;
  const messages = chat.messages.map((message) => {
    if (message.role !== "user" || !message.turnId || message.echo || message.takenUp) return message;
    // The host is being asked about this very prompt: until it answers, the
    // queue's silence about it proves nothing (`turnDelivery`).
    if (deliveryLookupHeld(message)) return message;
    if ((message.delivery === "failed" || message.delivery === "unknown") && !isQueued(message)) {
      if (!queue.live && message.queueUnconfirmedSend) {
        changed = true;
        return { ...message, queueUnconfirmedSend: undefined };
      }
      return message;
    }
    if (message.delivery === "dispatched" && !isQueued(message)) {
      if (queue.live) return message;
      changed = true;
      return { ...message, delivery: "unknown", queueLost: undefined } as typeof message;
    }
    const delivery = isQueued(message) ? (message.delivery === "starting" ? "starting" : "queued") : queue.live ? "unknown" : "failed";
    const lost = delivery === "failed";
    if (!!message.queueLost === lost && message.delivery === delivery) return message;
    changed = true;
    return { ...message, delivery, queueLost: lost || undefined, hostFailed: undefined,
      // App excludes in-flight RPCs from queue snapshots. A successful send
      // on an older host can therefore be absent here before its unstamped
      // echo arrives. Preserve exactly its previous sending eligibility;
      // queue absence still does not acknowledge or release the prompt.
      queueUnconfirmedSend: (delivery === "unknown" && message.delivery === "sending" && !message.queueLost) || undefined,
    } as typeof message;
  });
  return changed ? { ...chat, messages } : chat;
}

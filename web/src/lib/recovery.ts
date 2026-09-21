import type { ChatState } from "./chat";

export type RecoveryEvidence = {
  connected: boolean;
  /** A roster received on the current connection, not one from before disconnect. */
  rosterKnown: boolean;
  busy: boolean;
  /** Whether this conversation owns a live provider process. */
  live: boolean;
  /** An exit recorded for this conversation's latest turn. */
  exited?: { code: number | null };
  /** Last recorded transcript sequence; this is not a file-save checkpoint. */
  checkpointSeq?: number;
  /** Messages observed queued for this conversation. */
  queuedCount?: number;
};

export type ReconnectState = Readonly<{
  /** Whether this page has ever had a usable socket. The initial connection is
   *  not a reconnect and must never start work by itself. */
  seenOpen: boolean;
  /** A usable socket was lost and has not yet come back. */
  reconnectPending: boolean;
  /** Increments once for each lost connection that later comes back. */
  epoch: number;
}>;

export const INITIAL_RECONNECT_STATE: ReconnectState = Object.freeze({
  seenOpen: false,
  reconnectPending: false,
  epoch: 0,
});

/** Remember actual reconnects without treating the page's first connection as
 * one. Several closed/connecting updates belong to the same outage. */
export function observeConnection(previous: ReconnectState, connected: boolean): ReconnectState {
  if (connected) {
    if (previous.reconnectPending) {
      return { seenOpen: true, reconnectPending: false, epoch: previous.epoch + 1 };
    }
    return previous.seenOpen ? previous : { ...previous, seenOpen: true };
  }
  if (!previous.seenOpen || previous.reconnectPending) return previous;
  return { ...previous, reconnectPending: true };
}

/** Busy chats whose provider was present before a connection loss and absent
 * from the first authoritative roster after it. This is the evidence specific
 * to a server restart; an older missing worker must remain a manual choice. */
export function reconnectCandidates(
  chats: Readonly<Record<string, Pick<ChatState, "busy" | "stopping">>>,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): Set<string> {
  const candidates = new Set<string>();
  for (const id of before) {
    const chat = chats[id];
    if (chat?.busy && !chat.stopping && !after.has(id)) candidates.add(id);
  }
  return candidates;
}

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

export function deriveRecovery(evidence: RecoveryEvidence) {
  const { connected, rosterKnown, busy, live, exited } = evidence;
  const interrupted = busy || (exited !== undefined && exited.code !== 0);
  if (!interrupted) return { kind: "hidden", canContinue: false } as const;
  if (!connected) return { kind: "offline", canContinue: false } as const;
  if (!rosterKnown) return { kind: "checking", canContinue: false } as const;
  if (live) return { kind: "hidden", canContinue: false } as const;
  return { kind: exited ? "exited" : "missing", canContinue: true } as const;
}

/** Whether a chat may resume without asking for a click.
 *
 * This is deliberately narrower than the Carry on button. A recorded provider
 * exit may be old or intentional and still deserves an explicit decision. The
 * automatic path is only for a turn left busy when a live worker disappeared
 * across a connection loss, and only while the person is watching that chat. */
export function shouldAutoContinue({
  epoch,
  attemptedEpoch,
  eligible,
  watching,
  evidence,
}: {
  epoch: number;
  attemptedEpoch?: number;
  /** The authoritative roster found this busy chat missing when this reconnect
   *  completed. Keeps later, unrelated failures out of an old reconnect. */
  eligible: boolean;
  watching: boolean;
  evidence: RecoveryEvidence;
}): boolean {
  return epoch > 0
    && attemptedEpoch !== epoch
    && eligible
    && watching
    && evidence.busy
    && evidence.exited === undefined
    && deriveRecovery(evidence).canContinue;
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

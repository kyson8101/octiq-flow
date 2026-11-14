import { ownsTurnId, type Message } from "./chat";

/** The host's exact word on one prompt (`chat_turn_delivery`, socket only,
 * read-only). The newest fact in the record or the queue wins. */
export type TurnDeliveryState = "queued" | "accepted" | "dispatched" | "failed" | "cancelled" | "dismissed" | "absent";
export type TurnDeliveryFact = { state: TurnDeliveryState; seq?: number; into?: string };
export type TurnDeliveryAnswer = { turns: Record<string, TurnDeliveryFact> };

/** What the host's lookup settles for one local prompt. */
export type Resolution = "drop" | "failed" | "queued" | "dispatched";

/** The command takes 1 to 32 ids a call. */
export const DELIVERY_BATCH = 32;

const STATES = new Set<string>(["queued", "accepted", "dispatched", "failed", "cancelled", "dismissed", "absent"]);

/** Read one answer defensively. A state this page does not know reads as no
 * fact at all, never as a failure. */
export function readDeliveryAnswer(raw: unknown): Map<string, TurnDeliveryFact> {
  const out = new Map<string, TurnDeliveryFact>();
  const turns = raw && typeof raw === "object" ? (raw as { turns?: unknown }).turns : undefined;
  if (!turns || typeof turns !== "object") return out;
  for (const [id, fact] of Object.entries(turns as Record<string, unknown>)) {
    if (!fact || typeof fact !== "object") continue;
    const { state, seq, into } = fact as { state?: unknown; seq?: unknown; into?: unknown };
    if (typeof state !== "string" || !STATES.has(state)) continue;
    out.set(id, { state: state as TurnDeliveryState,
      ...(typeof seq === "number" && Number.isFinite(seq) ? { seq } : {}),
      ...(typeof into === "string" ? { into } : {}) });
  }
  return out;
}

/** What the host said about the prompt a local message stands for. A message
 * owns several ids once prompts were merged into it; the facts for all of them
 * are folded into one answer: a host decision that ended the prompt (accepted,
 * cancelled, dismissed) ends it, a prompt still in the queue stays queued, and
 * otherwise the newest line (highest seq) wins. `undefined` is no fact. */
export function resolveMessage(message: Message, ids: readonly string[], facts: ReadonlyMap<string, TurnDeliveryFact>): Resolution | undefined {
  let newest: { seq: number; resolution: "failed" | "dispatched" } | undefined;
  let queued = false;
  for (const id of ids) {
    const fact = facts.get(id);
    // `into` names the turn this one was merged into; the state still belongs
    // to the local message that owns the queried id.
    if (!fact || !ownsTurnId(message, id)) continue;
    if (fact.state === "accepted" || fact.state === "cancelled" || fact.state === "dismissed") return "drop";
    if (fact.state === "queued") queued = true;
    if (fact.state === "failed" || fact.state === "dispatched") {
      const seq = fact.seq ?? 0;
      if (!newest || seq >= newest.seq) newest = { seq, resolution: fact.state };
    }
  }
  return queued ? "queued" : newest?.resolution;
}

/** Ids whose delivery the host is being asked about right now. While one is
 * out, the answer is unknown: the idle queue poll must not read "not in the
 * queue" as "not sent" for it (`recovery.reconcileUnsentMessages`). Counted, so
 * two overlapping reads of one chat do not release each other's hold. */
const asking = new Map<string, number>();

export function holdDeliveryLookup(ids: readonly string[]): () => void {
  const held = [...new Set(ids)];
  for (const id of held) asking.set(id, (asking.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of held) {
      const left = (asking.get(id) ?? 1) - 1;
      if (left > 0) asking.set(id, left); else asking.delete(id);
    }
  };
}

export function deliveryLookupHeld(message: Pick<Message, "turnId" | "sourceTurnIds">): boolean {
  if (!asking.size) return false;
  return (!!message.turnId && asking.has(message.turnId)) || (message.sourceTurnIds ?? []).some(id => asking.has(id));
}

/** The local message a host resolution leaves behind; `undefined` drops it. */
export function applyResolution(message: Message, resolution: Resolution): Message | undefined {
  if (resolution === "drop") return undefined;
  if (resolution === "failed") return { ...message, delivery: "failed", queueLost: true, hostFailed: true, queueAction: undefined, queueError: undefined };
  return { ...message, delivery: resolution === "queued" ? "queued" : "dispatched",
    queueLost: undefined, hostFailed: undefined, queueAction: undefined, queueError: undefined };
}

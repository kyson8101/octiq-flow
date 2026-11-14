import { ownsTurnId, type ChatState, type Message } from "./chat";
import { DELIVERY_BATCH, applyResolution, readDeliveryAnswer, resolveMessage, type TurnDeliveryFact } from "./turnDelivery";

export type DismissDeps = {
  turnId: string;
  read: () => ChatState | undefined;
  patch: (update: (state: ChatState) => ChatState) => void;
  /** `chat_dismiss_unsent` */
  dismiss: () => Promise<unknown>;
  /** `chat_turn_delivery`; may be missing on an older backend. */
  lookup?: (turnIds: string[]) => Promise<unknown>;
};

/** What a person is told when the × did nothing and nothing else explains it. */
export const NOT_DISMISSED = "The message was not dismissed";

const note = (state: ChatState, text: string): ChatState =>
  state.notices.includes(text) ? state : { ...state, notices: [...state.notices, text].slice(-8) };

/** The × on a "Not sent" bubble. The host answers `false` (and writes nothing)
 * for a turn the agent already took up or one still queued: the bubble was
 * wrong, so ask the host where the turn is and fold the answer the way a
 * reopened chat does. A lookup that is missing or fails leaves the bubble as
 * it is, with one quiet line saying why the dismiss was not done. */
export async function dismissUnsentTurn(deps: DismissDeps): Promise<void> {
  const { turnId, patch } = deps;
  const owner = (message: Message) => message.turnId === turnId || ownsTurnId(message, turnId);
  let dismissed: unknown;
  try {
    dismissed = await deps.dismiss();
  } catch (err) {
    patch(s => note(s, String((err as Error)?.message ?? err)));
    return;
  }
  if (dismissed !== false) {
    // The backend announcement removes this in every open client. Apply the
    // same fold locally after its durable write so the click does not depend
    // on the broadcast winning a race with the command reply.
    patch(s => ({ ...s, messages: s.messages.filter(m => m.turnId !== turnId) }));
    return;
  }
  const message = deps.read()?.messages.find(owner);
  if (!message) return;
  if (!deps.lookup) return void patch(s => note(s, `${NOT_DISMISSED}: this host cannot say where it is. Reload to check.`));
  const ids = [...new Set([message.turnId, ...(message.sourceTurnIds ?? [])].filter((id): id is string => !!id))];
  let resolution;
  try {
    const facts = new Map<string, TurnDeliveryFact>();
    for (let at = 0; at < ids.length; at += DELIVERY_BATCH) {
      const batch = ids.slice(at, at + DELIVERY_BATCH);
      const answer = readDeliveryAnswer(await deps.lookup(batch));
      if (!batch.every(id => answer.has(id))) throw new Error("the host's answer was incomplete");
      for (const [id, fact] of answer) facts.set(id, fact);
    }
    resolution = resolveMessage(message, ids, facts);
  } catch (err) {
    const why = String((err as Error)?.message ?? err);
    patch(s => note(s, `${NOT_DISMISSED}: could not ask the host where it is (${why}).`));
    return;
  }
  if (!resolution) {
    patch(s => note(s, `${NOT_DISMISSED}: the host holds no record of it being sent.`));
    return;
  }
  patch(s => ({ ...s, messages: s.messages.flatMap(m => {
    if (!owner(m) || m.echo || m.takenUp) return [m];
    const kept = applyResolution(m, resolution);
    return kept ? [kept] : [];
  }) }));
}

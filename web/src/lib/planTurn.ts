// The host's turn that tells an agent its plan was started.
//
// The person's Start (`chat_plan_start`) is recorded first; the host then
// hands the agent one turn in its own words, as a recorded user turn whose id
// starts with `octiq-plan-start-` (`chat_plan::START_TURN_PREFIX`). No
// person's turn id starts with it, and the person typed none of it: the
// transcript names the turn and keeps the host's text behind a disclosure,
// the way it draws a completion's wrap-up (`lib/chatComplete.wrapUpBubble`).
//
// Kept apart from `lib/planView`: the transcript reads this, and it should
// not pull the ledger's readers in with it.
import type { Message } from "./chat";

export const PLAN_START_PREFIX = "octiq-plan-start-";

export function isPlanStartTurn(turnId?: string | null): boolean {
  return typeof turnId === "string" && turnId.startsWith(PLAN_START_PREFIX);
}

export const PLAN_START_LABEL = "Plan started";

/** What became of one try of the turn, as its own line says: `failed` (the
 *  write to the agent failed, or its process was ended with the turn still
 *  queued), `lost` (the host's queue no longer holds it: `lib/recovery`
 *  marks that one), or `null` for a turn that was handed over, is on its
 *  way, or that the agent took up. One reader, for the bubble and for the
 *  panel's `Tell the agent`. */
export function startTurnUnsent(message: Pick<Message, "echo" | "takenUp" | "queueLost" | "delivery">): "failed" | "lost" | null {
  if (message.echo || message.takenUp) return null;
  if (message.queueLost) return "lost";
  return message.delivery === "failed" ? "failed" : null;
}

/** What the bubble says of a try that did not reach the agent. Of the turn,
 *  not of the plan: a later try may have told it. */
export const START_TURN_UNSENT = {
  failed: "Not sent · this turn did not reach the agent",
  lost: "Lost from the queue · this turn did not reach the agent",
} as const;

/** What the bubble says in place of the host's text: what happened to this
 *  turn. It said `The agent was told to begin` of a turn that was never
 *  sent, under a panel that rightly said not sent. The ✕ on a queued one
 *  takes the turn back, not the Start: there is no un-start
 *  (`docs/chat-plan.md`). */
export function planStartBubble(message: Pick<Message, "turnId" | "delivery" | "echo" | "takenUp" | "queueLost">): {
  label: string;
  detail: string;
} | null {
  if (!isPlanStartTurn(message.turnId)) return null;
  const unsent = startTurnUnsent(message);
  if (unsent) return { label: PLAN_START_LABEL, detail: START_TURN_UNSENT[unsent] };
  const waiting = !message.echo && !message.takenUp && message.delivery === "queued";
  return {
    label: PLAN_START_LABEL,
    detail: waiting ? "Telling the agent after the current reply" : "The agent was told to begin",
  };
}

/** Whether the turn that tells an agent its plan was started is gone, as
 *  far as these messages say: the page holds the Start's own turn, and its
 *  line says it was not sent (the write to the agent failed, its process
 *  was ended with the turn still queued, or the host's queue no longer
 *  holds it: `lib/recovery` marks that one).
 *
 *  The host leaves `started.told` true in those cases until it is asked
 *  again, and puts it right on that ask (`docs/chat-plan.md`, A turn that
 *  is gone can be told again). So the page offers the ask, for a turn it
 *  can see is gone. A try is under the Start's id or one counted on from
 *  it (`…`, `…-try2`), and the latest try is the one that counts.
 *
 *  `false` when the page does not hold the turn at all: one delivered long
 *  ago and behind `Load earlier messages` is not told apart from one a
 *  `/clear` removed, so nothing is offered for it. */
export function startTurnLost(
  messages: readonly Pick<Message, "role" | "turnId" | "echo" | "takenUp" | "queueLost" | "delivery">[],
  turnId: string | null | undefined,
): boolean {
  if (!isPlanStartTurn(turnId)) return false;
  const base = turnId!.replace(/-try\d+$/, "");
  const tries = messages.filter((message) => message.role === "user" && typeof message.turnId === "string"
    && (message.turnId === base || (message.turnId.startsWith(`${base}-try`) && /^\d+$/.test(message.turnId.slice(base.length + 4)))));
  const last = tries.at(-1);
  return !!last && startTurnUnsent(last) !== null;
}

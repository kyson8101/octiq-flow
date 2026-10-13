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

/** What the bubble says in place of the host's text. The ✕ on a queued one
 *  takes the turn back, not the Start: there is no un-start
 *  (`docs/chat-plan.md`). */
export function planStartBubble(message: Pick<Message, "turnId" | "delivery" | "echo" | "takenUp">): {
  label: string;
  detail: string;
} | null {
  if (!isPlanStartTurn(message.turnId)) return null;
  const waiting = !message.echo && !message.takenUp && message.delivery === "queued";
  return {
    label: PLAN_START_LABEL,
    detail: waiting ? "Telling the agent after the current reply" : "The agent was told to begin",
  };
}

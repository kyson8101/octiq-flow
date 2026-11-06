import type { ChatState } from "./chat";
import { withWorkSignal } from "./turnClock";

export type ChatStreamActivity = { key: string; seq: number | null; running: boolean | null; busy: boolean | null; turnId: string | null; lastActivityAt: number; work: boolean };
/** No transcript, preview, cursor or row timestamp is fabricated from activity.
 * Preserve an existing turn clock/park until the normal wait machine ends it. */
export function withStreamActivity(state: ChatState, activity: ChatStreamActivity, now: number): ChatState {
  const busy = activity.busy ?? state.busy;
  const another = !!activity.turnId && !!state.activityTurnId && activity.turnId !== state.activityTurnId;
  const turnStartedAt = busy && (!state.busy || another) ? now : state.turnStartedAt;
  const activityTurnId = activity.turnId ?? state.activityTurnId;
  const next = busy === state.busy && turnStartedAt === state.turnStartedAt && activityTurnId === state.activityTurnId ? state
    : { ...state, busy, turnStartedAt, activityTurnId, ...(another ? { turnWaits: undefined } : {}) };
  return withWorkSignal(next, activity.work, now);
}

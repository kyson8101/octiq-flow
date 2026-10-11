// How long a permission question has left.
//
// The host sends no deadline and no start time, only how long it waits
// (`answerWithinSecs`, three minutes when absent, and never more:
// `permission.rs` clamps it). So the clock starts when THIS page saw the
// question arrive, and a question this page did not see arrive (read back
// from `permission_pending` after a reload) has an age nobody here knows: it
// gets no clock at all, rather than one the host will not honour.
import type { Ask } from "../components/PermissionAsk";
import type { RequestState } from "./pendingRequests";

/** The host's wait, and its ceiling (`permission::ANSWER_TIMEOUT`). */
export const ASK_WAIT_SECS = 180;

/** How long the host waits for this question, in seconds: three minutes when
 *  it does not say, never more than its ceiling, and `0` when it says zero.
 *  The host takes `Some(0)` at its word and answers Deny at once
 *  (`permission.rs`), so zero is not "unset". */
export function askWaitSecs(ask: Ask): number {
  const secs = ask.answerWithinSecs;
  if (typeof secs !== "number" || !Number.isFinite(secs) || secs < 0) return ASK_WAIT_SECS;
  return Math.min(secs, ASK_WAIT_SECS);
}

/** When the host answers Deny for the person, in this page's clock. `null`
 *  when the page did not see the question arrive, and for a question the host
 *  does not wait on at all: there is no time to count. */
export function askDeadline(ask: Ask): number | null {
  const wait = askWaitSecs(ask);
  return typeof ask.receivedAt === "number" && wait > 0 ? ask.receivedAt + wait * 1000 : null;
}

/** Whole seconds left, never below zero and never more than the host waits.
 *  Rounded DOWN: the host's clock started before the question reached this
 *  page, so the figure may run a moment short and never long. */
export function askRemaining(ask: Ask, now: number): number | null {
  const deadline = askDeadline(ask);
  if (deadline === null) return null;
  return Math.min(askWaitSecs(ask), Math.max(0, Math.floor((deadline - now) / 1000)));
}

/** Seconds as `m:ss`. */
export function clockText(secs: number): string {
  const whole = Math.max(0, Math.floor(secs));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A question as it arrives live, stamped with when. One already on the page
 *  keeps its first stamp: a repeated event is not a new three minutes. */
export function stampArrival(ask: Ask, known: RequestState<Ask>, now: number): Ask {
  return { ...ask, receivedAt: arrivalOf(ask.id, known) ?? now };
}

/** The host's list of what is still waiting, each question keeping the
 *  arrival this page already knows for it. The rest stay unstamped. */
export function keepArrivals(list: readonly Ask[] | null, known: RequestState<Ask>): Ask[] {
  return (list ?? []).map((ask) => {
    const receivedAt = arrivalOf(ask.id, known);
    return receivedAt === undefined ? ask : { ...ask, receivedAt };
  });
}

function arrivalOf(id: string, known: RequestState<Ask>): number | undefined {
  for (const list of Object.values(known)) {
    const old = list.find((ask) => ask.id === id);
    if (old) return old.receivedAt;
  }
  return undefined;
}

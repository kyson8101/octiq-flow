import type { Message } from "./chat";

export const TURN_BATCH = 12;

/** Stable ids keep incoming messages from evicting the paragraph being read. */
export function initialTurn(turns: Message[][], savedTurn?: string): string | null {
  const saved = savedTurn ? turns.findIndex((turn) => turn.some((m) => m.id === savedTurn)) : -1;
  const start = saved >= 0 ? Math.max(0, saved - 1) : Math.max(0, turns.length - TURN_BATCH);
  return turns[start]?.[0].id ?? null;
}

export function turnWindowStart(turns: Message[][], first: string | null): number {
  return first === null ? 0 : Math.max(0, turns.findIndex((turn) => turn[0].id === first));
}

/** A prompt the person sent that the agent has not taken up: it sits in the
 *  queue (or is still being handed over) while the turn before it runs. */
export function waitingPrompt(m: Message): boolean {
  return m.role === "user" && !m.echo && !m.takenUp && !m.queueLost
    && (m.delivery === "queued" || m.delivery === "sending" || m.delivery === "starting");
}

/** Something the person typed and the agent acted on: not a queued prompt, not
 *  one of the host's own turns (`octiq-…` ids: wrap-ups, job and notification
 *  wake-ups, answers), not a relay brief, and with words in it. */
export function realRequest(turn: Message[]): boolean {
  return turn[0].role === "user" && turn.every((m) => !m.parent && !m.relay && !m.turnId?.startsWith("octiq-") && !waitingPrompt(m) && !m.queueLost)
    && turn.some((m) => m.blocks.some((b) => b.kind === "text" && b.text.trim() !== ""));
}

/** Index of the person's latest real request, or -1. */
export function lastRequest(turns: Message[][]): number {
  for (let i = turns.length - 1; i >= 0; i--) if (realRequest(turns[i])) return i;
  return -1;
}

/** How far a window may be backed up to reach the last real request. A chat
 *  whose last request is further back than this is not one the person can be
 *  reminded of by a few turns. */
export const ORIENT_TURNS = 40;

/** Where a window opened on the end of a chat starts so that it holds the
 *  person's last real request. `first` is where it would start otherwise (an id,
 *  or null for the whole list). Never moves a start later, and leaves it alone
 *  when the request is not loaded or too far back. */
export function orientedFirst(turns: Message[][], first: string | null): string | null {
  const at = lastRequest(turns);
  if (at < 0 || turns.length - at > ORIENT_TURNS) return first;
  const start = turnWindowStart(turns, first);
  return at < start ? turns[at][0].id : first;
}

/** Whether the transcript should read one earlier page from the server to find
 *  the person's last request: what is loaded holds none, the server has more,
 *  and no page is coming or has just failed. The caller reads at most once per
 *  conversation; a window that could merely widen over loaded turns does not
 *  answer this, because those turns hold nothing to orient by. */
export function needsEarlierPage(turns: Message[][], state: { hasEarlier: boolean; loading: boolean; failed: boolean }): boolean {
  return turns.length > 0 && state.hasEarlier && !state.loading && !state.failed && lastRequest(turns) < 0;
}

/** The assistant turns that are still the running turn, by their first
 *  message's id.
 *
 *  A queued prompt is appended where it was typed, and Claude's later
 *  messages are appended after it, so one running turn reaches the screen as
 *  several: the part before the queued bubble, the bubble, the part after. Only
 *  the bottom turn counted as running, which made the part above the bubble
 *  look finished: its prose was folded into "Worked …" while the agent was
 *  still working. Walking back from the end, every assistant turn that has not
 *  ended is the running turn until something that is not a waiting prompt
 *  (a turn that ended, or a prompt the agent has taken up) cuts it off. */
export function runningTurns(turns: Message[][], busy: boolean): ReadonlySet<string> {
  const live = new Set<string>();
  if (!busy) return live;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn[0].role === "user") {
      if (turn.every(waitingPrompt)) continue;
      break;
    }
    if (turn.some((m) => m.turnEnd)) break;
    live.add(turn[0].id);
  }
  return live;
}

import type { ChatState } from "./chat";
import { someoneWorking } from "./carryOn";

export const ROOM_HANDOVER_MS = 20_000;
export type InterruptionInput = {
  chats: Readonly<Record<string, ChatState>>;
  running: Set<string>;
  activeRounds: ReadonlySet<string>;
  rooms: ReadonlySet<string>;
  known: boolean;
};

/** Preserve the first observed absence across renders. A room gets time to
 * hand work from a seat back to its host before absence becomes interruption. */
export function observeInterruptions(previous: ReadonlyMap<string, number>, input: InterruptionInput, now: number) {
  const missing = new Map<string, number>();
  const interrupted = new Set<string>();
  let nextCheck: number | undefined;
  if (input.known) for (const [id, chat] of Object.entries(input.chats)) {
    if (!chat.busy || chat.stopping || someoneWorking({ id, running: input.running, round: input.activeRounds.has(id) })) continue;
    const since = previous.get(id) ?? now;
    missing.set(id, since);
    const due = since + (input.rooms.has(id) ? ROOM_HANDOVER_MS : 0);
    if (now >= due) interrupted.add(id);
    else nextCheck = Math.min(nextCheck ?? due, due);
  }
  return { missing, interrupted, nextCheck };
}

import type { ChatState } from "./chat";
import { someoneWorking } from "./carryOn";

export type InterruptionInput = {
  chats: Readonly<Record<string, ChatState>>;
  running: Set<string>;
  known: boolean;
};

/** Preserve the first observed absence across renders. */
export function observeInterruptions(previous: ReadonlyMap<string, number>, input: InterruptionInput, now: number) {
  const missing = new Map<string, number>();
  const interrupted = new Set<string>();
  let nextCheck: number | undefined;
  if (input.known) for (const [id, chat] of Object.entries(input.chats)) {
    if (!chat.busy || chat.stopping || someoneWorking({ id, running: input.running })) continue;
    const since = previous.get(id) ?? now;
    missing.set(id, since);
    const due = since;
    if (now >= due) interrupted.add(id);
    else nextCheck = Math.min(nextCheck ?? due, due);
  }
  return { missing, interrupted, nextCheck };
}

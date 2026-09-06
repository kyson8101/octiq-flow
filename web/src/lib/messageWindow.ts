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

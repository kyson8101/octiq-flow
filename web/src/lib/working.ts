// What the agent is doing, said while it is still doing it.
//
// A turn used to show one word — "working…" — which reads the same after ten
// seconds and after ten minutes. That is the one moment a chat gives you
// nothing: the model is reasoning, no text has appeared yet, and the only
// honest question ("is this going anywhere?") has no answer on screen.
//
// So the line says what the CLI's own spinner says: how long this turn has run,
// how much the model has written so far, and — while it is reasoning rather
// than typing — how hard it was told to think. Every piece drops out when there
// is nothing to say, so the line is never longer than it has news for.

/** 252000 → "4m 12s". Seconds up to a minute, then minutes and seconds, then
 *  hours and minutes — the reader wants the SIZE of the wait, and by the time
 *  it runs to hours the seconds are noise. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** 16543 → "16.5k". One place finer than the context meter's rounding, and for
 *  a reason: this number is watched while it moves. Rounded to whole thousands
 *  it sits still for seconds at a time, and a counter that does not move is
 *  worse than no counter — it reads as a stall. */
export function tokenLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(n)));
}

/** The whole line: "4m 12s · ↓ 16.5k tokens · thinking with very high effort". */
export function workingLine({
  elapsedMs,
  tokens,
  activity,
  thinking,
  effort,
}: {
  /** How long the turn has been running. Absent until it is known — a chat
   *  picked up mid-turn only knows when we joined it. */
  elapsedMs?: number;
  /** Output tokens the agent has produced this turn, settled plus estimated. */
  tokens?: number;
  /** The agent's own words for a state worth naming — compacting, retrying.
   *  It wins the last slot: it is the more specific news. */
  activity?: string;
  /** True while the model is reasoning rather than writing. */
  thinking?: boolean;
  /** What the effort picker calls the level — "very high", not "xhigh". The
   *  status has to agree with the menu the user set it in. */
  effort?: string;
}): string {
  const parts: string[] = [];
  if (typeof elapsedMs === "number") parts.push(elapsedLabel(elapsedMs));
  if (tokens) parts.push(`↓ ${tokenLabel(tokens)} tokens`);
  parts.push(
    activity ?? (thinking ? (effort ? `thinking with ${effort} effort` : "thinking…") : "working…"),
  );
  return parts.join(" · ");
}

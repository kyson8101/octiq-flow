// What the agent is doing, said while it is still doing it.
//
// A turn used to show one word — "working…" — which reads the same after ten
// seconds and after ten minutes. That is the one moment a chat gives you
// nothing: the model is reasoning, no text has appeared yet, and the only
// honest question ("is this going anywhere?") has no answer on screen.
//
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

/** The current activity; elapsed time is also used by the composer's clock. */
export function workingLine({ elapsedMs, activity, thinking }: {
  elapsedMs?: number;
  activity?: string;
  thinking?: boolean;
}): string {
  return [typeof elapsedMs === "number" ? elapsedLabel(elapsedMs) : "",
    activity ?? (thinking ? "thinking…" : "working…")].filter(Boolean).join(" · ");
}

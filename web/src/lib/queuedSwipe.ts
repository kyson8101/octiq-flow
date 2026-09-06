import { FLICK, HOLD_MS, SLOP_PX, type Pt } from "./swipe";

export type QueuedSwipe = {
  phase: "watching" | "swiping" | "dropped";
  from: Pt;
  prev: Pt;
  at: Pt;
  width: number;
  open: boolean;
};

export function queuedSwipeStart(from: Pt, width: number, open: boolean): QueuedSwipe {
  return { phase: "watching", from, prev: from, at: from, width, open };
}

export function queuedSwipeMove(s: QueuedSwipe, at: Pt): QueuedSwipe {
  if (s.phase === "dropped") return s;
  const next = { ...s, prev: s.at, at };
  if (s.phase === "swiping") return next;
  const dx = at.x - s.from.x;
  const dy = at.y - s.from.y;
  if (at.t - s.from.t > HOLD_MS || (Math.abs(dy) > SLOP_PX && Math.abs(dy) >= Math.abs(dx))) {
    return { ...next, phase: "dropped" };
  }
  if (Math.abs(dx) <= SLOP_PX || Math.abs(dx) < Math.abs(dy) * 1.25) return next;
  if (s.open ? dx < 0 : dx > 0) return { ...next, phase: "dropped" };
  return { ...next, phase: "swiping" };
}

export function queuedSwipeOffset(s: QueuedSwipe): number {
  return Math.max(0, Math.min(s.width, (s.open ? s.width : 0) + s.from.x - s.at.x));
}

/** A gesture only opens or closes the tray. It never executes an action. */
export function queuedSwipeEnd(s: QueuedSwipe, releasedAt: number): boolean {
  if (s.phase !== "swiping") return s.open;
  const dt = s.at.t - s.prev.t;
  const velocity = dt > 0 && releasedAt - s.at.t < 100 ? (s.at.x - s.prev.x) / dt : 0;
  if (velocity < -FLICK) return true;
  if (velocity > FLICK) return false;
  return queuedSwipeOffset(s) > s.width * 0.4;
}

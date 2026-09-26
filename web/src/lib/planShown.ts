// What a plan card has actually shown, and since when.
//
// A plan the lead revises while its card is open is a different plan under
// the same button. Clicked a moment later, "Approve" used to approve the new
// revision the person had not read (feedback 713786e9). The card now holds the
// button briefly after a change, and every click says how long the revision
// had been on it, so the host can refuse one that only just appeared and keep
// the rest as evidence of what was shown.

/** Mirrors the host's PLAN_SETTLE_MS (orchestration.rs). */
export const PLAN_SETTLE_MS = 1_500;

export type PlanShown = {
  revision: number | undefined;
  /** When this revision appeared on the card, by opening or by a change. */
  appearedAt: number;
  /** When it replaced another revision on the same card; null when the card
   *  opened on it. */
  replacedAt: number | null;
};

export function nextShown(previous: PlanShown | null, revision: number | undefined, now: number): PlanShown {
  if (!previous) return { revision, appearedAt: now, replacedAt: null };
  if (previous.revision === revision) return previous;
  // An old snapshot without revisions filling in is not a change of plan.
  const replaced = previous.revision !== undefined;
  return { revision, appearedAt: now, replacedAt: replaced ? now : null };
}

/** Whether Approve is held because the plan just changed under the reader. */
export function settling(shown: PlanShown, now: number): boolean {
  return shown.replacedAt !== null && now - shown.replacedAt < PLAN_SETTLE_MS;
}

/** The evidence a click carries: how long this revision had been shown. */
export function cardView(shown: PlanShown, now: number): { shownMs: number; updatedMs: number | null } {
  return {
    shownMs: Math.max(0, Math.round(now - shown.appearedAt)),
    updatedMs: shown.replacedAt === null ? null : Math.max(0, Math.round(now - shown.replacedAt)),
  };
}

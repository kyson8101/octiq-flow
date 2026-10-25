// One approval in flight per plan, wherever it was clicked.
//
// The same plan is drawn twice — at the end of the lead's chat and in the run
// panel — and both have an Approve button. They share this, so a click in one
// shows "Approving…" in both and a second click anywhere is not sent while the
// first is on its way. The host would refuse the second anyway ("already
// approved"); this keeps the person from seeing that as an error.
import { useSyncExternalStore } from "react";

const approving = new Set<string>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/** Run `approve` unless this plan is already being approved. `false` when it
 *  was, and nothing was sent.
 *
 *  `settle` runs after the host has answered, still inside the flight: the
 *  card is drawn from the ledger, so until a read after the decision lands it
 *  still shows the plan as pending. Let go before that and its Approve came
 *  back live under a decision already made, and a second press was needed (or
 *  refused) before the card went. A failed read lets go all the same. */
export async function approveOnce(
  runId: string, approve: () => Promise<void>, settle?: () => Promise<void>,
): Promise<boolean> {
  if (approving.has(runId)) return false;
  approving.add(runId);
  changed();
  try {
    await approve();
    if (settle) await settle().catch(() => {});
    return true;
  } finally {
    approving.delete(runId);
    changed();
  }
}

export function isApproving(runId: string): boolean {
  return approving.has(runId);
}

export function useApproving(runId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => approving.has(runId),
    () => false,
  );
}

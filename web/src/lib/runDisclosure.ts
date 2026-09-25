import type { OrchestrationRun } from "./orchestration";
import { isActiveRun } from "./chatWorkflow";

export type RunDisclosureState = {
  expanded: ReadonlySet<string>;
  touched: ReadonlySet<string>;
  known: ReadonlySet<string>;
};

export function initialRunDisclosures(runs: readonly OrchestrationRun[]): RunDisclosureState {
  const first = runs.find(isActiveRun) ?? runs[0];
  return {
    expanded: new Set(first ? [first.id] : []),
    touched: new Set(),
    known: new Set(runs.map((run) => run.id)),
  };
}

/** Keep manual choices through ledger refreshes; only untouched active runs
 *  open automatically. A worker navigation target is always made visible. */
export function syncRunDisclosures(
  state: RunDisclosureState,
  runs: readonly OrchestrationRun[],
  revealRunId: string | null = null,
): RunDisclosureState {
  const ids = new Set(runs.map((run) => run.id));
  const expanded = new Set([...state.expanded].filter((id) => ids.has(id)));
  const touched = new Set([...state.touched].filter((id) => ids.has(id)));
  const known = new Set([...state.known].filter((id) => ids.has(id)));
  for (const run of runs) {
    if (!known.has(run.id) && isActiveRun(run) && !touched.has(run.id)) expanded.add(run.id);
    known.add(run.id);
  }
  if (revealRunId && ids.has(revealRunId)) expanded.add(revealRunId);
  if (!expanded.size && !touched.size && runs[0]) expanded.add(runs[0].id);
  if (sameSet(expanded, state.expanded) && sameSet(touched, state.touched) && sameSet(known, state.known)) return state;
  return { expanded, touched, known };
}

export function toggleRunDisclosure(state: RunDisclosureState, runId: string): RunDisclosureState {
  const expanded = new Set(state.expanded);
  if (expanded.has(runId)) expanded.delete(runId);
  else expanded.add(runId);
  return { expanded, touched: new Set(state.touched).add(runId), known: state.known };
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

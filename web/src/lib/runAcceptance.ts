// What a run has shown, kept in its separate stages (feedback ee0a43b0).
//
// "32 of 33 done" read as "97% ready" while three reviews had said NOT
// RELEASE-READY and nothing had been uploaded. Counting tasks answers "how
// much of the plan has settled", and nothing else. So each thing a person
// might mean by "done" is its own line, with its own evidence:
//
// - tasks settled      — the ledger's count, labelled as exactly that;
// - checks             — only explicit check/review/acceptance tasks, and
//                        verdicts workers actually reported;
// - source integration — task branches git says are merged (as of the last
//                        delivery check);
// - deployed runtime   — not tracked per run, and said so;
// - acceptance         — never inferred from counts. Checks that all passed
//                        are reported as that, not as product acceptance.
import { failureShown, isSettled, type OrchestrationTask } from "./orchestration";

export type CheckKind = NonNullable<OrchestrationTask["kind"]>;

export const KIND_LABEL: Record<CheckKind, string> = {
  work: "Work", check: "Check", review: "Review", acceptance: "Acceptance",
};

export function requiresVerdict(task: Pick<OrchestrationTask, "kind">): boolean {
  return !!task.kind && task.kind !== "work";
}

export type CheckCoverage = {
  /** Explicit check, review and acceptance tasks (cancelled ones left out). */
  total: number;
  passed: number;
  failed: number;
  /** How many of the failed ones are said as a failure
   *  (`orchestration.failureShown`): not one the coordinator is fixing, and
   *  not one that is history. Only these colour a line. */
  failedRed: number;
  /** Not settled with a verdict yet: still to run, running, or ended
   *  without judging (failed or blocked). */
  awaiting: number;
  /** Completed with no verdict. Only an older or hand-edited record can hold
   *  this; it is shown, never counted as passed. */
  noVerdict: number;
  /** Ordinary tasks whose worker still reported a verdict: observed, but
   *  not a check anyone planned. */
  observed: { passed: number; failed: number };
};

export function checkCoverage(tasks: readonly OrchestrationTask[]): CheckCoverage {
  const coverage: CheckCoverage = { total: 0, passed: 0, failed: 0, failedRed: 0, awaiting: 0, noVerdict: 0, observed: { passed: 0, failed: 0 } };
  for (const task of tasks) {
    if (task.status === "cancelled") continue;
    if (!requiresVerdict(task)) {
      if (isSettled(task) && task.verdict) coverage.observed[task.verdict === "pass" ? "passed" : "failed"] += 1;
      continue;
    }
    coverage.total += 1;
    if (!isSettled(task)) coverage.awaiting += 1;
    else if (task.verdict === "pass") coverage.passed += 1;
    else if (task.verdict === "fail") {
      coverage.failed += 1;
      const shown = failureShown(task);
      // A replaced check is counted as it was reported, and coloured as it
      // was on a host that does not say whose move a failure is.
      if (shown === "red" || (shown === null && !!task.supersededBy)) coverage.failedRed += 1;
    }
    else coverage.noVerdict += 1;
  }
  return coverage;
}

export type EnvTone = "ok" | "warn" | "quiet" | "active";

/** `danger` is a check that failed: a failure, where `warn` is only ever a
 *  warning (a stale or unhealthy environment). */
export type Stage = { key: string; label: string; value: string; tone: EnvTone | "danger"; note?: string };

/** The run's stages, each from its own evidence. */
export function runStages(
  tasks: readonly OrchestrationTask[],
): Stage[] {
  const live = tasks.filter((task) => task.status !== "cancelled");
  // Settled, and said as that: a check that failed settled too.
  const settled = live.filter(isSettled).length;
  const checks = checkCoverage(tasks);

  const checkParts = [
    checks.passed ? `${checks.passed} passed` : null,
    checks.failed ? `${checks.failed} failed` : null,
    checks.awaiting ? `${checks.awaiting} awaiting` : null,
    checks.noVerdict ? `${checks.noVerdict} without a verdict` : null,
  ].filter(Boolean);
  const observed = checks.observed.passed + checks.observed.failed;

  const branches = live.filter((task) => task.workspace && task.workspace.plan.mode !== "direct");
  const merged = branches.filter((task) => task.workspace?.delivery?.merged || (task.workspace?.state === "cleaned" && !task.workspace.abandoned)).length;
  const unchecked = branches.filter((task) => !task.workspace?.delivery && task.workspace?.state !== "cleaned").length;
  // A prepared patch: committed on its branch, not in the base yet.
  const prepared = branches.filter((task) => task.workspace?.delivery?.hasCommits && !task.workspace.delivery.merged).length;
  // What the project's release check said about each merged head. Absent is
  // unverified, never "not released".
  const mergedDeliveries = branches.map((task) => task.workspace?.delivery).filter((d) => d?.merged && d.hasCommits);
  const released = mergedDeliveries.filter((d) => d?.released === true).length;
  const notReleased = mergedDeliveries.filter((d) => d?.released === false).length;
  const releaseKnown = released + notReleased;

  // The danger colour is a failure that is said as one. A failed check the
  // coordinator is having fixed is still a failing check, in the line's ink.
  const failing: Stage["tone"] = checks.failedRed ? "danger" : "quiet";
  const acceptance: Stage = checks.failed
    ? { key: "acceptance", label: "Acceptance", value: "Failing", tone: failing, note: checks.failedRed
      ? "A check, review or acceptance task found problems; its dependants wait."
      : "A check, review or acceptance task found problems; its dependants wait. Its coordinator is dealing with it, or it is history: nothing is asked of you." }
    : checks.total && !checks.awaiting && !checks.noVerdict
      ? { key: "acceptance", label: "Acceptance", value: "Every planned check passed", tone: "ok", note: "What the planned checks covered passed. It is not a record that the product was accepted." }
      : { key: "acceptance", label: "Acceptance", value: "Unverified", tone: "quiet", note: checks.total ? "Checks are still outstanding." : "No check, review or acceptance task in this mission. Task completion is not acceptance." };

  return [
    { key: "tasks", label: "Tasks settled", value: `${settled} of ${live.length}`, tone: "quiet", note: "How much of the plan has finished. Not how much of it works." },
    {
      key: "checks", label: "Checks",
      value: checks.total ? checkParts.join(" · ") : "None planned",
      tone: checks.failed ? failing : checks.total && checks.passed === checks.total ? "ok" : "quiet",
      note: observed ? `${observed} other ${observed === 1 ? "task" : "tasks"} also reported a verdict (${checks.observed.passed} pass, ${checks.observed.failed} fail).` : undefined,
    },
    {
      key: "integration", label: "Source integration",
      value: branches.length
        ? [`${merged} of ${branches.length} branches merged`, prepared ? `${prepared} prepared, not merged` : null].filter(Boolean).join(" · ")
        : "No task branches",
      tone: branches.length && merged === branches.length ? "ok" : "quiet",
      note: unchecked ? `${unchecked} not checked yet; refresh a task's delivery to ask git.` : "As of each task's last delivery check. Prepared means committed on its branch, not yet in the base.",
    },
    releaseKnown
      ? {
        key: "deployed", label: "Deployed runtime",
        value: `${released} of ${mergedDeliveries.length} merged ${mergedDeliveries.length === 1 ? "branch" : "branches"} released`,
        tone: notReleased ? "quiet" : released === mergedDeliveries.length ? "ok" : "quiet",
        note: "By the project's release check, as of each task's last delivery check. A head the check could not answer for is unverified, not unreleased.",
      }
      : { key: "deployed", label: "Deployed runtime", value: "Unverified", tone: "quiet", note: mergedDeliveries.length ? "The project has no release check, or none of its merged heads has been checked. Set one in the chat's Release row." : "Nothing merged yet, so nothing can be running." },
    acceptance,
  ];
}

/** The one line a collapsed run shows about acceptance. */
export function acceptanceLine(stages: readonly Stage[]): Stage {
  return stages.find((stage) => stage.key === "acceptance")!;
}

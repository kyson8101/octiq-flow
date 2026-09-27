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
// - sandbox runtime    — test environments' own states: ready is a passed
//                        readiness check, never a release;
// - deployed runtime   — not tracked per run, and said so;
// - acceptance         — never inferred from counts. Checks that all passed
//                        are reported as that, not as product acceptance.
import type { OrchestrationAttempt, OrchestrationTask } from "./orchestration";
import type { SandboxEnvironment, SandboxSnapshot } from "./sandbox";

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
  const coverage: CheckCoverage = { total: 0, passed: 0, failed: 0, awaiting: 0, noVerdict: 0, observed: { passed: 0, failed: 0 } };
  for (const task of tasks) {
    if (task.status === "cancelled") continue;
    if (!requiresVerdict(task)) {
      if (task.status === "completed" && task.verdict) coverage.observed[task.verdict === "pass" ? "passed" : "failed"] += 1;
      continue;
    }
    coverage.total += 1;
    if (task.status !== "completed") coverage.awaiting += 1;
    else if (task.verdict === "pass") coverage.passed += 1;
    else if (task.verdict === "fail") coverage.failed += 1;
    else coverage.noVerdict += 1;
  }
  return coverage;
}

export type EnvTone = "ok" | "warn" | "quiet" | "active";

export type TaskEnvironmentView = {
  state: SandboxEnvironment["state"] | "waiting_for_capacity" | "not_prepared";
  label: string;
  tone: EnvTone;
  /** Everything behind the label, for a tooltip and the details: why,
   *  what was checked against, and how long ago. */
  detail: string[];
  checkedAt: number | null;
};

const ENV_LABEL: Record<TaskEnvironmentView["state"], string> = {
  ready: "Env ready", stale: "Env stale", unhealthy: "Env unhealthy", stopped: "Env stopped",
  preparing: "Env preparing", error: "Env failed", unverified: "Env unverified",
  waiting_for_capacity: "Env waiting for a slot", not_prepared: "Env not prepared",
};

const ENV_TONE: Record<TaskEnvironmentView["state"], EnvTone> = {
  ready: "ok", stale: "warn", unhealthy: "warn", error: "warn", preparing: "active",
  waiting_for_capacity: "active", stopped: "quiet", unverified: "quiet", not_prepared: "quiet",
};

function short(revision: string | null | undefined): string {
  return revision ? revision.slice(0, 8) : "none";
}

/** A sandbox task's environment, apart from the task's own status: the
 *  environment of its current attempt (a retry takes the previous one over). */
export function taskEnvironment(
  task: OrchestrationTask,
  attempts: readonly OrchestrationAttempt[],
  sandboxes: SandboxSnapshot | null | undefined,
  ago: (at: number) => string,
): TaskEnvironmentView | null {
  if (task.environment !== "sandbox") return null;
  const attempt = attempts.find((candidate) => candidate.id === task.activeAttemptId);
  const key = attempt?.workerChatKey;
  const env = key ? sandboxes?.environments[key] : undefined;
  const waiting = !!key && !!sandboxes?.capacity?.waiting.some((w) => w.keys[0] === key);
  const state: TaskEnvironmentView["state"] = waiting ? "waiting_for_capacity" : env?.state ?? "not_prepared";
  const detail: string[] = [];
  if (waiting && sandboxes?.capacity) {
    detail.push(`All ${sandboxes.capacity.limit} host environment slots are in use; it starts when one frees.`);
  }
  if (env) {
    if (env.invalidated) detail.push(env.invalidated.reason);
    if (env.state === "error" && env.error) detail.push(env.error);
    if (env.stopped && env.state === "stopped") detail.push(`${env.stopped.by === "person" ? "Stopped by you" : "Stopped by OctiqFlow"}: ${env.stopped.reason}`);
    if (env.lease) detail.push("Kept running from its Sandbox panel; OctiqFlow will not stop it.");
    detail.push(env.checkedAt ? `Last passing check ${ago(env.checkedAt)}` : "No passing check on this server");
    if (env.probedAt) detail.push(`Health looked at ${ago(env.probedAt)}`);
    for (const source of env.fingerprint?.sources ?? []) {
      detail.push(`${source.path} @ ${short(source.revision)}${source.dirty ? " + local changes" : ""}`);
    }
    if (env.fixtureVersion) detail.push(`Fixture ${env.fixtureVersion}`);
    detail.push("Ready is a passed readiness check in a test sandbox, not a release.");
  }
  const age = env?.checkedAt && state === "ready" ? ` · ${ago(env.checkedAt)}` : "";
  return { state, label: `${ENV_LABEL[state]}${age}`, tone: ENV_TONE[state], detail, checkedAt: env?.checkedAt ?? null };
}

export type Stage = { key: string; label: string; value: string; tone: EnvTone; note?: string };

/** The run's stages, each from its own evidence. */
export function runStages(
  tasks: readonly OrchestrationTask[],
  attempts: readonly OrchestrationAttempt[],
  sandboxes: SandboxSnapshot | null | undefined,
): Stage[] {
  const live = tasks.filter((task) => task.status !== "cancelled");
  const settled = live.filter((task) => task.status === "completed").length;
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

  const envs = live
    .map((task) => taskEnvironment(task, attempts, sandboxes, () => ""))
    .filter((view): view is TaskEnvironmentView => !!view);
  const envCounts = new Map<string, number>();
  for (const view of envs) envCounts.set(view.state, (envCounts.get(view.state) ?? 0) + 1);
  const envOrder: TaskEnvironmentView["state"][] = ["ready", "stale", "unhealthy", "error", "preparing", "waiting_for_capacity", "stopped", "unverified", "not_prepared"];
  const envText = envOrder
    .filter((state) => envCounts.get(state))
    .map((state) => `${envCounts.get(state)} ${ENV_LABEL[state].replace(/^Env /, "")}`)
    .join(" · ");

  const acceptance: Stage = checks.failed
    ? { key: "acceptance", label: "Acceptance", value: "Failing", tone: "warn", note: "A check, review or acceptance task found problems; its dependants wait." }
    : checks.total && !checks.awaiting && !checks.noVerdict
      ? { key: "acceptance", label: "Acceptance", value: "Every planned check passed", tone: "ok", note: "What the planned checks covered passed. It is not a record that the product was accepted." }
      : { key: "acceptance", label: "Acceptance", value: "Unverified", tone: "quiet", note: checks.total ? "Checks are still outstanding." : "No check, review or acceptance task in this run. Task completion is not acceptance." };

  return [
    { key: "tasks", label: "Tasks settled", value: `${settled} of ${live.length}`, tone: "quiet", note: "How much of the plan has finished. Not how much of it works." },
    {
      key: "checks", label: "Checks",
      value: checks.total ? checkParts.join(" · ") : "None planned",
      tone: checks.failed ? "warn" : checks.total && checks.passed === checks.total ? "ok" : "quiet",
      note: observed ? `${observed} other ${observed === 1 ? "task" : "tasks"} also reported a verdict (${checks.observed.passed} pass, ${checks.observed.failed} fail).` : undefined,
    },
    {
      key: "integration", label: "Source integration",
      value: branches.length ? `${merged} of ${branches.length} branches merged` : "No task branches",
      tone: branches.length && merged === branches.length ? "ok" : "quiet",
      note: unchecked ? `${unchecked} not checked yet; refresh a task's delivery to ask git.` : "As of each task's last delivery check.",
    },
    {
      key: "sandbox", label: "Sandbox runtime",
      value: envs.length ? envText : "No sandbox tasks",
      tone: envCounts.get("stale") || envCounts.get("unhealthy") || envCounts.get("error") ? "warn" : envs.length && envCounts.get("ready") === envs.length ? "ok" : "quiet",
      note: "Test environments on this host. Ready means its readiness check passed; it is not a deployment.",
    },
    { key: "deployed", label: "Deployed runtime", value: "Not tracked", tone: "quiet", note: "OctiqFlow does not record deployments per run. Check the release evidence separately." },
    acceptance,
  ];
}

/** The one line a collapsed run shows about acceptance. */
export function acceptanceLine(stages: readonly Stage[]): Stage {
  return stages.find((stage) => stage.key === "acceptance")!;
}

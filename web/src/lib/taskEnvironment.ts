// Where a task runs — what was PLANNED, and what the host has CONFIRMED.
//
// Two sources, kept apart on purpose, because a plan that looks like a fact is
// the mistake this panel exists to prevent:
//
//   * Planned: the launch plan recorded on the chat before its first turn
//     (`ChatMeta.launch`), or — for a worker chat — the orchestration task's
//     destination and the workspace plan the host drew up for it.
//   * Confirmed: `chat_task`'s git verification of the chat's own directory
//     (branch, primary checkout vs worktree, paths), stamped with when it was
//     checked, and the sandbox's own state.
//
// A row whose fact the host has not checked says so. A worktree that has been
// removed, or a verification read from the primary checkout because the chat's
// directory is gone (`stale`), is never drawn as verified.
import { locationOf, type TaskStatus } from "./chatTask";
import type { OrchestrationAttempt, OrchestrationTask } from "./orchestration";
import type { SandboxEnvironment } from "./sandbox";

export type LaunchPlan = {
  projectId: string;
  projectName?: string;
  path?: string;
  baseBranch?: string;
  newWorktree?: boolean;
  useSandbox?: boolean;
  prepare?: boolean;
  chosenBy: "auto" | "advanced" | "person";
  reason?: string;
  decidedAt?: number;
};

/** How far a row's value can be trusted. */
export type Evidence = "confirmed" | "planned" | "stale" | "removed" | "unknown";

export type EnvRow = {
  key: "project" | "repository" | "directory" | "branch" | "base" | "target" | "checkout" | "sandbox";
  label: string;
  /** The value shown: confirmed when there is one, else the plan. */
  value: string;
  evidence: Evidence;
  /** The plan, when it says something the confirmed value does not. */
  planned?: string;
  /** A full path the row can copy. */
  path?: string;
};

export type EnvironmentInput = {
  status?: TaskStatus;
  launch?: LaunchPlan | null;
  /** The worker task this chat runs, with its latest attempt. */
  worker?: { task: OrchestrationTask; attempt?: OrchestrationAttempt } | null;
  sandbox?: SandboxEnvironment | null;
  projectName?: (id: string) => string | undefined;
};

const CHECKOUT_PLANNED = (worktree?: boolean) => (worktree ? "New worktree" : "Primary checkout");

function sandboxLabel(env: SandboxEnvironment): string {
  switch (env.state) {
    case "ready": return "Ready";
    case "preparing": return "Preparing";
    case "stopped": return "Stopped";
    case "error": return env.error ? `Failed: ${env.error}` : "Failed";
    default: return "Not verified";
  }
}

export function taskEnvironment(input: EnvironmentInput): { rows: EnvRow[]; checkedAt?: number; stale: boolean } {
  const { status, launch, worker, sandbox } = input;
  const workspace = status?.workspace;
  const delivery = status?.delivery;
  const stale = !!delivery?.stale;
  const plan = worker?.task.workspace?.plan;
  const removed = worker?.task.workspace?.state === "cleaned" || (!!workspace && !workspace.exists);
  // What the host has checked about the chat's own directory. A stale or
  // removed directory's facts are history, not the present.
  const live = workspace && workspace.exists && !stale ? workspace : undefined;
  const liveEvidence: Evidence = removed ? "removed" : stale ? "stale" : live ? "confirmed" : "unknown";
  const name = (id?: string) => (id ? input.projectName?.(id) : undefined);

  const rows: EnvRow[] = [];
  const push = (row: EnvRow) => {
    if (row.planned !== undefined && row.planned === row.value) delete row.planned;
    rows.push(row);
  };

  // Project: the chat's own project is known for certain by the host.
  const plannedProject = worker?.task.destination?.projectName ?? launch?.projectName ?? name(launch?.projectId);
  const actualProject = name(status?.projectId);
  push({
    key: "project",
    label: "Project",
    value: actualProject ?? plannedProject ?? "Unknown",
    evidence: actualProject ? "confirmed" : plannedProject ? "planned" : "unknown",
    planned: plannedProject,
  });

  // Repository: git says which repository the directory belongs to.
  const plannedRepo = worker?.task.destination?.repository ?? plan?.repositoryRoot ?? (launch?.prepare ? launch.path : undefined);
  const actualRepo = live?.isRepo ? live.primaryRoot || live.repoRoot : undefined;
  push({
    key: "repository",
    label: "Repository",
    value: actualRepo ?? plannedRepo ?? (live && !live.isRepo ? "Not a Git repository" : "Unknown"),
    evidence: actualRepo ? "confirmed" : live && !live.isRepo ? "confirmed" : plannedRepo ? (removed ? "removed" : "planned") : liveEvidence,
    planned: plannedRepo,
    path: actualRepo ?? plannedRepo,
  });

  // Working directory: the one the agent actually runs in.
  const plannedDir = plan?.cwd ?? worker?.attempt?.cwd ?? launch?.path;
  const dir = workspace?.cwd || plannedDir;
  push({
    key: "directory",
    label: "Working directory",
    value: dir ?? "Not recorded",
    evidence: workspace?.cwd ? liveEvidence : plannedDir ? "planned" : "unknown",
    planned: plannedDir,
    path: dir,
  });

  // Branch, and the base it was cut from.
  const plannedBranch = plan?.branch ?? worker?.attempt?.branch
    ?? (launch?.newWorktree ? `New branch from ${launch.baseBranch || "the current branch"}` : launch?.baseBranch || undefined);
  push({
    key: "branch",
    label: "Branch",
    value: live?.branch || workspace?.branch || plannedBranch || "Unknown",
    evidence: live?.branch ? "confirmed" : workspace?.branch ? liveEvidence : plannedBranch ? "planned" : "unknown",
    planned: plannedBranch,
  });
  // The base is only ever what the plan said to branch from; git keeps no
  // record of it. The target is what delivery was checked against.
  const plannedBase = plan?.baseBranch || launch?.baseBranch || undefined;
  const target = status?.target?.branch ?? delivery?.target;
  push({
    key: "base",
    label: "Base branch",
    value: plannedBase ?? "Unknown",
    evidence: plannedBase ? "planned" : "unknown",
  });
  push({
    key: "target",
    label: "Target",
    value: target ?? "Unknown",
    evidence: target ? (delivery ? liveEvidence : "planned") : "unknown",
  });

  // Primary checkout or linked worktree, and where.
  const plannedCheckout = plan
    ? plan.managed ? "New worktree" : "Primary checkout"
    : launch?.prepare ? CHECKOUT_PLANNED(launch.newWorktree) : launch ? "Home workspace" : undefined;
  const actualCheckout = workspace ? locationOf(workspace) : undefined;
  push({
    key: "checkout",
    label: "Checkout",
    value: actualCheckout && actualCheckout !== "Unknown" ? actualCheckout : plannedCheckout ?? "Unknown",
    evidence: actualCheckout && actualCheckout !== "Unknown" ? liveEvidence : plannedCheckout ? "planned" : "unknown",
    planned: plannedCheckout,
    path: live?.isWorktree ? live.repoRoot : undefined,
  });

  // Sandbox: its own state machine; "requested" is only a plan.
  const plannedSandbox = launch ? (launch.useSandbox ? "Requested" : "Off") : undefined;
  push({
    key: "sandbox",
    label: "Sandbox",
    value: sandbox ? (sandbox.enabled ? sandboxLabel(sandbox) : "Off") : plannedSandbox ?? "Unknown",
    evidence: sandbox ? (sandbox.state === "ready" && sandbox.checkedAt ? "confirmed" : sandbox.enabled ? "unknown" : "confirmed") : plannedSandbox ? "planned" : "unknown",
    planned: plannedSandbox,
  });

  return { rows, checkedAt: delivery?.checkedAt, stale };
}

export const EVIDENCE_LABEL: Record<Evidence, string> = {
  confirmed: "Verified",
  planned: "Planned",
  stale: "Stale",
  removed: "Removed",
  unknown: "Not verified",
};

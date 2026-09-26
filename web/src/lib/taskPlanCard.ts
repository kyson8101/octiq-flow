// The standard plan card: every task in a plan answers the same questions in
// the same order, as labels and short values rather than prose.
//
//   where    project · branch · work directory · worktree
//   who      owner · model · effort
//   what     one line of problem, one line of goal, 2–5 acceptance criteria
//
// Before a task starts, the branch and directory come from the host's
// proposal (`workspaceProposal`): planned read-only when the task was created,
// and the only thing its first launch may allocate. A branch that launch will
// create reads "(new)" straight after its name. Once the host has allocated the
// workspace, its plan replaces the proposal and nothing says new again. One
// state chip, on the Worktree row, says how far that has got — Planned,
// Confirmed, Removed, or Conflict — so the rows above it are not each tagged.
import { modelFromReported } from "./agentProviders";
import { planDestination } from "./planReview";
import type { OrchestrationAttempt, OrchestrationRun, OrchestrationTask } from "./orchestration";

export type CardState = "confirmed" | "planned" | "pending" | "removed" | "conflict" | "unplanned";

export type CardRow = {
  key: "project" | "branch" | "directory" | "worktree" | "workspace" | "owner" | "model" | "effort";
  label: string;
  value: string;
  state?: CardState;
  /** Text the row can copy, and what to call it. */
  copy?: { text: string; name: string };
  /** The value is a path or a ref: set in the code face. */
  code?: boolean;
  /** One short line under the value: why a plan cannot be used as it is. */
  note?: string;
};

export const CARD_STATE_LABEL: Record<CardState, string> = {
  confirmed: "Confirmed",
  planned: "Planned",
  pending: "Pending",
  removed: "Removed",
  conflict: "Conflict",
  unplanned: "Not planned",
};

const WORKSPACE_STATE: Record<string, string> = {
  preparing: "Preparing",
  ready: "Ready",
  retained: "Kept for review",
  cleaning: "Removing",
  cleaned: "Removed",
};

export function taskCardRows(
  task: OrchestrationTask,
  run: Pick<OrchestrationRun, "workspaceId" | "rootPath">,
  attempt?: OrchestrationAttempt | null,
  projectName?: (id: string) => string | undefined,
): CardRow[] {
  const where = planDestination(task, run, projectName);
  const rows: CardRow[] = [
    { key: "project", label: "Project", value: where.project, copy: { text: where.path, name: "project path" } },
  ];
  rows.push(...whereRows(task, attempt));

  const worker = task.worker;
  rows.push({ key: "owner", label: "Owner", value: task.assignee?.name ?? "Chosen by the lead" });
  if (worker) {
    const choice = worker.model ? modelFromReported(worker.agent, worker.model) : undefined;
    const model = choice ? `${choice.name} ${choice.model}` : worker.model || "Provider default";
    rows.push({ key: "model", label: "Model", value: model });
    if (worker.effort) rows.push({ key: "effort", label: "Effort", value: worker.effort });
  }
  return rows;
}

/** Branch, directory and worktree: allocated, proposed, or neither. */
function whereRows(task: OrchestrationTask, attempt?: OrchestrationAttempt | null): CardRow[] {
  const workspace = task.workspace;
  // A proposal speaks only until something is allocated; after that it is
  // history, and an allocated branch is never new.
  const proposal = workspace ? undefined : task.workspaceProposal;
  const plan = workspace?.plan ?? proposal?.plan;
  const prepared = attempt?.cwd ? attempt : undefined;

  if (!plan) {
    // An older task can have run with no plan or proposal saved. What its
    // attempt actually ran in is still a fact, and outranks "Pending".
    if (prepared) return attemptRows(prepared);
    if (proposal?.error) {
      return [{ key: "workspace", label: "Workspace", value: "Could not be planned", state: "unplanned", note: proposal.error }];
    }
    return [{ key: "workspace", label: "Workspace", value: "Allocated when the task starts", state: "pending" }];
  }

  const state: CardState = workspace
    ? workspace.state === "cleaned" ? "removed"
      : prepared || workspace.state === "ready" || workspace.state === "retained" ? "confirmed"
        : "planned"
    : proposal?.conflict ? "conflict" : "planned";

  const rows: CardRow[] = [];
  const branch = prepared?.branch || plan.branch;
  if (branch) {
    const fresh = !!proposal?.newBranch && !proposal.conflict;
    const from = plan.managed && plan.baseBranch && plan.baseBranch !== branch ? ` from ${plan.baseBranch}` : "";
    rows.push({
      key: "branch",
      label: "Branch",
      value: `${branch}${fresh ? " (new)" : ""}${from}`,
      copy: { text: branch, name: "branch name" },
    });
  } else {
    rows.push({ key: "branch", label: "Branch", value: plan.isRepo ? "Detached" : "No Git history" });
  }

  const dir = prepared?.cwd ?? plan.cwd;
  rows.push({
    key: "directory",
    label: "Work directory",
    value: dir,
    code: true,
    copy: { text: dir, name: "work directory path" },
  });

  const kind = plan.managed ? (workspace ? "Worktree" : "New worktree") : "Current checkout";
  rows.push({
    key: "worktree",
    label: "Worktree",
    value: workspace ? `${kind} · ${WORKSPACE_STATE[workspace.state] ?? workspace.state}` : kind,
    state,
    note: proposal?.conflict ? `${proposal.conflict} The task will not start over it.`
      // No worker access was chosen when this was planned: a read-only
      // worker may still be started in the current checkout instead.
      : proposal?.provisional ? "Provisional: a read-only worker runs in the current checkout instead." : undefined,
  });
  return rows;
}

/** Where an attempt ran, straight off the attempt, for a task with no plan. */
function attemptRows(attempt: OrchestrationAttempt): CardRow[] {
  const rows: CardRow[] = [];
  if (attempt.branch) {
    rows.push({ key: "branch", label: "Branch", value: attempt.branch, copy: { text: attempt.branch, name: "branch name" } });
  }
  rows.push({
    key: "directory", label: "Work directory", value: attempt.cwd, code: true,
    copy: { text: attempt.cwd, name: "work directory path" },
  });
  rows.push({ key: "worktree", label: "Worktree", value: attempt.isWorktree ? "Worktree" : "Current checkout", state: "confirmed" });
  return rows;
}

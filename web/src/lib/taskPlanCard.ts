// The standard plan card: every task in a plan answers the same questions in
// the same order, as labels and short values rather than prose.
//
//   where    project · work directory · branch / base · worktree
//   who      owner · model · effort
//   what     one line of problem, one line of goal, 2–5 acceptance criteria
//
// Where a value is not allocated yet — a work directory and branch only exist
// once the host prepares the task's workspace — the row says Pending. A value
// from the plan says Planned, and is replaced by what the host actually
// prepared (the attempt's directory and branch) the moment there is one.
import { modelFromReported } from "./agentProviders";
import { planDestination } from "./planReview";
import type { OrchestrationAttempt, OrchestrationRun, OrchestrationTask } from "./orchestration";

export type CardState = "confirmed" | "planned" | "pending" | "removed";

export type CardRow = {
  key: "project" | "directory" | "branch" | "worktree" | "owner" | "model" | "effort";
  label: string;
  value: string;
  state?: CardState;
  /** A full path the row can copy. */
  path?: string;
};

export const CARD_STATE_LABEL: Record<CardState, string> = {
  confirmed: "Confirmed",
  planned: "Planned",
  pending: "Pending",
  removed: "Removed",
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
  const workspace = task.workspace;
  const plan = workspace?.plan;
  const removed = workspace?.state === "cleaned";
  const where = planDestination(task, run, projectName);
  const prepared = attempt?.cwd ? attempt : undefined;

  const rows: CardRow[] = [
    { key: "project", label: "Project", value: where.project, state: prepared ? "confirmed" : "planned", path: where.path },
  ];

  const dir = prepared?.cwd ?? plan?.cwd;
  rows.push({
    key: "directory",
    label: "Work directory",
    value: dir ?? "Pending, allocated when the task starts",
    state: !dir ? "pending" : removed ? "removed" : prepared ? "confirmed" : "planned",
    path: dir,
  });

  const branch = prepared?.branch || plan?.branch;
  const base = plan?.baseBranch;
  rows.push({
    key: "branch",
    label: "Branch · base",
    value: branch
      ? base ? `${branch} from ${base}` : branch
      : base ? `Pending, from ${base}` : "Pending",
    state: !branch ? "pending" : prepared?.branch ? "confirmed" : "planned",
  });

  const kind = plan ? (plan.managed ? "Worktree" : "Current checkout") : undefined;
  rows.push({
    key: "worktree",
    label: "Worktree",
    value: workspace && kind
      ? `${kind} · ${WORKSPACE_STATE[workspace.state] ?? workspace.state}`
      : "Not allocated yet",
    state: !workspace ? "pending" : removed ? "removed" : workspace.state === "preparing" ? "planned" : "confirmed",
    path: plan?.managed ? plan.checkoutRoot : undefined,
  });

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

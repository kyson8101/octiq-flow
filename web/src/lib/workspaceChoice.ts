// The snapshot is the only authority for advice, available modes and the
// approved choice. Older hosts keep their read-only workspace proposal.
import type { OrchestrationRun, OrchestrationTask } from "./orchestration";

export type WorkspaceChoice = "worktree" | "checkout";
export type WorkspaceChoices = Record<string, WorkspaceChoice>;
export const WORKSPACE_CHOICE_LABEL = { worktree: "New worktree", checkout: "Current checkout" };
export const CHECKOUT_WRITER_NOTE = "Works in this chat's folder; one writer at a time.";

export function readWorkspaceChoice(task: OrchestrationTask) {
  const choice = task.workspaceChoice;
  if (!choice) return null;
  return {
    ...choice,
    value: choice.chosen ?? choice.advised,
    editable: !choice.chosen && !task.approvedAt && !task.workspace && !task.activeAttemptId
      && !task.splitBy && (task.status === "pending" || task.status === "ready")
      && choice.options.length > 1,
    writer: task.worker?.access !== "read",
  };
}

/** A draft lives only with this mounted plan revision, never in storage. */
export type WorkspaceDraft = { runId: string; revision?: number; choices: WorkspaceChoices };

export function workspaceDraft(run: OrchestrationRun): WorkspaceDraft {
  return { runId: run.id, revision: run.planApproval?.revision, choices: {} };
}

/** Filter at draw and send time too: an amendment cannot send a choice for
 *  something already approved, withdrawn, started or no longer offered. */
export function workspaceOverrides(draft: WorkspaceDraft, run: OrchestrationRun, tasks: OrchestrationTask[], waiting: string[]): WorkspaceChoices {
  if (draft.runId !== run.id || draft.revision !== run.planApproval?.revision || run.planApproval?.status !== "pending") return {};
  return Object.fromEntries(tasks.flatMap((task) => {
    const host = readWorkspaceChoice(task);
    const value = draft.choices[task.id];
    return task.runId === run.id && waiting.includes(task.id) && host?.editable && value && value !== host.advised && host.options.includes(value)
      ? [[task.id, value]] : [];
  }));
}

/** A folded card still states the changed decision, as a count, not a slice
 *  of the tasks hidden inside it. Count only overrides, not the advice. */
export function workspaceChoiceFact(choices: WorkspaceChoices): string {
  return (["checkout", "worktree"] as const).flatMap((mode) => {
    const n = Object.values(choices).filter((value) => value === mode).length;
    return n ? [`${n} task${n === 1 ? "" : "s"} ${mode === "checkout" ? "in current checkout" : "set to New worktree"}`] : [];
  }).join(" · ");
}

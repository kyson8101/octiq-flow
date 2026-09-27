// How a planned Claude task's commands get approved, chosen by the person on
// the plan card before approving it (feedback d59f830a).
//
// Auto hands each command to Claude's own auto-mode classifier. When that
// refuses one, Claude asks no one and offers no way to approve that call
// afterwards, so OctiqFlow cannot either. Manual asks the person before every
// command, which is the only supported way to approve an exact command. The
// choice is part of the plan: changing it moves the revision and the plan is
// approved again. Codex is not offered it — its Manual is `on-request`, which
// the person's Codex configuration may hand to Codex's automatic reviewer.
import type { OrchestrationRun, OrchestrationTask } from "./orchestration";

export type CommandApproval = "auto" | "manual";

/** What is chosen now, when the person may still choose. Mirrors the host's
 *  `set_task_access`, which refuses every other case. */
export function commandApprovalChoice(
  task: OrchestrationTask,
  run: Pick<OrchestrationRun, "planApproval" | "workerDefaults" | "status">,
): CommandApproval | null {
  if (run.planApproval?.status !== "pending" || run.status === "stopped") return null;
  if (task.approvedAt || task.parentTaskId || task.activeAttemptId) return null;
  if (task.status !== "pending" && task.status !== "ready") return null;
  const defaults = run.workerDefaults;
  const settings = task.worker ?? (defaults?.agent ? { ...defaults, agent: defaults.agent } : undefined);
  if (settings?.agent !== "claude") return null;
  return settings.access === "auto" || settings.access === "manual" ? settings.access : null;
}

export const COMMAND_APPROVAL_NOTE: Record<CommandApproval, string> = {
  auto: "Claude's auto mode decides each command. A command it refuses stays refused: nothing here can approve it afterwards.",
  manual: "You approve each command before it runs, in the main chat. Choose this for releases and other commands auto mode may refuse.",
};

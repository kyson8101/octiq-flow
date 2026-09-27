// On a plan card, before approving: how a Claude task's commands get
// approved (feedback d59f830a). See lib/taskAccess for why only Claude, and
// why Manual is the only way to approve an exact command. Changing it changes
// the plan: its revision moves and the plan is approved again.
import { useState } from "react";
import type { OrchestrationRun, OrchestrationTask } from "../lib/orchestration";
import { bridge } from "../lib/bridge";
import { COMMAND_APPROVAL_NOTE, commandApprovalChoice, type CommandApproval } from "../lib/taskAccess";

const LABEL: Record<CommandApproval, string> = { auto: "Auto", manual: "Manual" };

export function CommandApprovalChoice({ task, run }: { task: OrchestrationTask; run: OrchestrationRun }) {
  const current = commandApprovalChoice(task, run);
  const [sending, setSending] = useState<CommandApproval | null>(null);
  const [error, setError] = useState("");
  if (!current) return null;
  const choose = async (access: CommandApproval) => {
    if (access === current || sending) return;
    setSending(access);
    setError("");
    try {
      // The revision on screen goes with the choice: one made against a plan
      // that changed meanwhile is refused, like an approval would be.
      await bridge.invoke("orchestration_task_access", { runId: run.id, taskId: task.id, access, revision: run.planApproval?.revision });
    } catch (why) {
      setError(String((why as Error)?.message ?? why));
    } finally {
      setSending(null);
    }
  };
  const name = `command-approval-${task.id}`;
  return (
    <fieldset className="plan-command-approval" data-access={current}>
      <legend>Command approval</legend>
      <div className="plan-command-approval-options" role="radiogroup" aria-label={`Command approval for ${task.title}`}>
        {(["auto", "manual"] as const).map((access) => (
          <label key={access} data-checked={access === current || undefined}>
            <input type="radio" name={name} value={access} checked={access === current}
              disabled={!!sending} onChange={() => void choose(access)} />
            <span>{sending === access ? "Saving…" : LABEL[access]}</span>
          </label>
        ))}
      </div>
      <p className="plan-command-approval-note">{COMMAND_APPROVAL_NOTE[current]}</p>
      {error && <p className="plan-command-approval-error" role="alert">{error}</p>}
    </fieldset>
  );
}

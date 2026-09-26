// A task's size and acceptance, on its plan card. The size is chosen here
// before the task starts; afterwards it is a fact. A completed task of a
// registered agent is accepted here by the person, which is what pays XP.
// The ledger snapshot redraws both once the host has recorded the change.
import { useState } from "react";
import {
  acceptTask, acceptorLabel, canAccept, setTaskSize, shortDate, SIZE_LABEL, SIZE_XP, TASK_SIZES, taskSizeState,
  type TaskSize,
} from "../lib/agentLevels";
import type { OrchestrationTask } from "../lib/orchestration";
import "./AgentLevel.css";

export function TaskSizeFact({ task }: { task: OrchestrationTask }) {
  const state = taskSizeState(task);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const change = async (size: TaskSize) => {
    setSaving(true);
    setError("");
    try {
      await setTaskSize(task.id, size);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <dt>Size</dt>
      <dd>
        {state.editable && state.size ? (
          <select className="plan-card-size" aria-label={`Size of ${task.title}`} value={state.size} disabled={saving}
            onChange={(event) => void change(event.target.value as TaskSize)}>
            {TASK_SIZES.map((size) => (
              <option key={size} value={size}>{SIZE_LABEL[size]} · {SIZE_XP[size]} XP</option>
            ))}
          </select>
        ) : (
          <span>{state.label}</span>
        )}
        {!state.editable && state.size && <span className="plan-card-note">Locked since the task started.</span>}
        {error && <span className="plan-card-note" role="alert">{error}</span>}
      </dd>
    </>
  );
}

export function TaskAcceptanceLine({ task }: { task: OrchestrationTask }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const current = task.acceptance && task.acceptance.attemptId === task.activeAttemptId ? task.acceptance : undefined;
  const accept = async () => {
    if (!task.activeAttemptId) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await acceptTask(task.id, task.activeAttemptId);
      setMessage(result.awarded && result.award ? `+${result.award.xp} XP to ${task.assignee?.name ?? "the agent"}.` : result.note ?? "");
    } catch (reason) {
      setMessage(String((reason as Error).message ?? reason));
    } finally {
      setBusy(false);
    }
  };
  const size = task.size;
  return (
    <div className="plan-card-accept" aria-label="Acceptance">
      {current ? (
        <p>Accepted by {acceptorLabel(current.by)} · {shortDate(current.at)}</p>
      ) : (
        <p>{size
          ? `Accepting pays ${task.assignee?.name ?? "the agent"} ${SIZE_XP[size]} XP, once per task.`
          : "This task has no recorded size, so accepting it pays no XP."}</p>
      )}
      {canAccept(task) && (
        <button type="button" className="vault-button xp-accept" disabled={busy} onClick={() => void accept()}>
          {busy ? "Accepting…" : "Accept result"}
        </button>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

// The standard plan card, as it reads inside a plan row and a task's details:
// compact key-value facts, then one line of problem, one of goal, and the
// acceptance criteria as a checklist the person reads — never ticks.
import { useId, useState, type ReactNode } from "react";
import { copyText } from "../lib/clipboard";
import { useRosterAgent } from "../lib/agentRoster";
import { isSettled, type OrchestrationAttempt, type OrchestrationRun, type OrchestrationTask } from "../lib/orchestration";
import { CARD_STATE_LABEL, taskCardRows, type CardRow } from "../lib/taskPlanCard";
import { readWorkspaceChoice, WORKSPACE_CHOICE_LABEL, type WorkspaceChoice } from "../lib/workspaceChoice";
import { dropHeld, notePress, repeatsAnother } from "../lib/pressGuard";
import { AgentAvatar } from "./AgentAvatar";
import { TaskAcceptanceLine, TaskSizeFact } from "./TaskLevel";
import "./TaskPlanCard.css";

export type WorkspaceDecision = { value: WorkspaceChoice; disabled: boolean; onChange: (value: WorkspaceChoice) => void };

export function TaskPlanCard({ task, run, attempt, projectName, workspaceDecision }: {
  task: OrchestrationTask;
  run: Pick<OrchestrationRun, "workspaceId" | "rootPath">;
  attempt?: OrchestrationAttempt | null;
  projectName?: (id: string) => string | undefined;
  workspaceDecision?: WorkspaceDecision;
}) {
  const face = useRosterAgent(task.assignee?.id);
  const rows = taskCardRows(task, run, attempt, projectName, workspaceDecision?.value);
  const choice = readWorkspaceChoice(task);
  const card = task.card;
  return (
    <section className="plan-card" aria-label={`Plan card: ${task.title}`}>
      <dl className="plan-card-facts">
        {rows.map((row) => (
          row.key === "worktree" && choice?.editable && workspaceDecision ? (
            <WorkspaceRadios key={row.key} task={task} advised={choice.advised} decision={workspaceDecision} note={row.note} />
          ) :
          <Fact key={row.key} row={row}>
            {row.key === "owner" && task.assignee && (
              <AgentAvatar name={face?.name ?? task.assignee.name} avatar={face?.avatar} id={task.assignee.id} size={16} decorative />
            )}
          </Fact>
        ))}
        {task.assignee && <TaskSizeFact task={task} />}
      </dl>
      {card ? (
        <dl className="plan-card-facts plan-card-brief">
          {card.problem && <><dt>Problem</dt><dd>{card.problem}</dd></>}
          {card.goal && <><dt>Goal</dt><dd>{card.goal}</dd></>}
          {card.acceptance.length > 0 && (
            <>
              <dt>Acceptance</dt>
              <dd>
                <ul className="plan-card-acceptance" aria-label="Acceptance criteria">
                  {card.acceptance.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="plan-card-missing">No problem, goal or acceptance criteria were given for this task.</p>
      )}
      {task.assignee && isSettled(task) && <TaskAcceptanceLine task={task} />}
    </section>
  );
}

function WorkspaceRadios({ task, advised, decision, note }: {
  task: OrchestrationTask; advised: WorkspaceChoice; decision: WorkspaceDecision; note?: string;
}) {
  // Two surfaces can draw the same task at once. Native radio names belong
  // to this group, so choosing here never silently unchecks the other card.
  const id = useId();
  return <>
    <dt id={`${id}-label`}>Worktree</dt>
    <dd>
      <div className="plan-workspace-options" role="radiogroup" aria-label={`Worktree for ${task.title}`}>
        {(["worktree", "checkout"] as const).map((mode) => (
          <label key={mode} data-checked={decision.value === mode || undefined}
            onKeyDown={dropHeld}
            onClickCapture={(event) => {
              if (repeatsAnother(event)) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              notePress(event);
            }}>
            <input type="radio" name={`${id}-workspace`} value={mode} checked={decision.value === mode}
              disabled={decision.disabled} onChange={() => decision.onChange(mode)} />
            <span>{WORKSPACE_CHOICE_LABEL[mode]}</span>
            {advised === mode && <span className="plan-workspace-recommended">Recommended</span>}
          </label>
        ))}
      </div>
      {note && <span className="plan-card-note">{note}</span>}
    </dd>
  </>;
}

function Fact({ row, children }: { row: CardRow; children?: ReactNode }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const copy = row.copy;
  return (
    <>
      <dt>{row.label}</dt>
      <dd>
        {children}
        {/* The copy control rides at the end of the text, so a long branch
            or path does not push it onto a line of its own. */}
        <span className={row.code ? "plan-card-path" : undefined} title={copy?.text}>
          {row.value}
          {copy && (
            <button
              type="button"
              className="plan-card-copy"
              data-copied={copied === "idle" ? undefined : copied}
              aria-label={`Copy ${copy.name}`}
              title={copied === "failed" ? "Could not copy" : copied === "done" ? "Copied" : `Copy ${copy.text}`}
              onClick={async (event) => {
                event.stopPropagation();
                setCopied((await copyText(copy.text)) ? "done" : "failed");
                setTimeout(() => setCopied("idle"), 1600);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {copied === "done"
                  ? <path d="m5 12 5 5 9-10" />
                  : <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></>}
              </svg>
            </button>
          )}
        </span>
        {row.state && <span className="plan-card-state" data-state={row.state}>{CARD_STATE_LABEL[row.state]}</span>}
        {row.note && <span className="plan-card-note">{row.note}</span>}
      </dd>
    </>
  );
}

// The summary parts of a run: line, people, attention, stages and tiles (moved verbatim from OrchestrationPanel.tsx).
import { useContext } from "react";
import { attemptIsExecuting, boardCounts, runElapsed, runIsLive, useElapsedTick } from "../lib/agentTaskBoard";
import { acceptanceLine, checkCoverage, runStages } from "../lib/runAcceptance";
import { attentionLabel, attentionSpoken, attentionTone, runPeople, type PersonState, type RunAttention } from "../lib/runPanel";
import { AgentAvatar } from "./AgentAvatar";
import { AgentRosterContext } from "../lib/agentRoster";
import { ClockIcon } from "./TaskMeter";
import { minutesLabel, tasksLabel, tokensLabel, type RunTiles as RunTilesData } from "../lib/runProgress";
import { checkFailed, failureShown, shownRunStatus, type OrchestrationRun, type OrchestrationSnapshot, type OrchestrationTask, type OrchestrationAttempt } from "../lib/orchestration";

export function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function AlertIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 7v6" /><circle cx="12" cy="17" r=".9" /></svg>;
}

/** The whole run in one line: done of total, its state, what is still owed
 *  besides a decision, and how long. A count of zero is left out rather than
 *  printed — four tiles reading 0 is how the old screen managed to fill a
 *  phone while saying nothing. Nothing here is a percentage: done of total is
 *  what the ledger knows. */
export function RunLine({ snapshot, run, tasks, attempts, tiled = false }: {
  snapshot: OrchestrationSnapshot;
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
  attempts: OrchestrationAttempt[];
  /** The run's tiles are on screen under this line: they carry the task
   *  count and the time, so the line does not say them a second time. */
  tiled?: boolean;
}) {
  const now = useElapsedTick(runIsLive(snapshot, run.id));
  const counts = boardCounts(tasks, snapshot);
  const working = attempts.filter(attemptIsExecuting).length;
  const elapsed = runElapsed(snapshot, run.id, now);
  const settled = counts.total > 0 && counts.done === counts.total;
  // Settled is not finished well: a check that failed is said out loud, and
  // is not one of the tasks done (`boardCounts`).
  // Only a failed check that is said as a failure
  // (`orchestration.failureShown`): one the coordinator is having fixed is
  // not on this line.
  const failedChecks = tasks.filter((task) => checkFailed(task) && failureShown(task) === "red").length;
  const status = shownRunStatus(run, tasks);
  const planned = checkCoverage(tasks).total > 0;
  const acceptance = acceptanceLine(runStages(tasks));
  const parts = [
    tiled ? null : `${counts.done}/${counts.total} tasks`,
    run.archivedAt != null ? `${statusLabel(status)} · archived` : statusLabel(status),
    working > 0 ? `${working} of ${run.maxConcurrent} working` : null,
    counts.todo > 0 ? `${counts.todo} queued` : null,
    counts.cancelled > 0 ? `${counts.cancelled} cancelled` : null,
    failedChecks > 0 ? `${failedChecks} ${failedChecks === 1 ? "check" : "checks"} failed` : null,
  ].filter(Boolean);
  return <small className="orch-run-line">
    <span>{parts.join(" · ")}</span>
    {/* In minutes: a figure that changes every few seconds is a clock. */}
    {elapsed !== null && !tiled && <span className="orch-run-elapsed" title="Wall time from the first dispatch to the latest settlement. Overlapping workers are counted once."><ClockIcon />{minutesLabel(elapsed)}</span>}
    {/* Every task done reads as "finished", which is exactly when it needs
        saying what, if anything, checked the outcome. */}
    {(settled || planned) && <span className="orch-progress-acceptance" data-tone={acceptance.tone} title={acceptance.note}>Acceptance: {acceptance.value.toLowerCase()}</span>}
  </small>;
}

const PERSON_LABEL: Record<PersonState, string> = {
  working: "working", failed: "failed", blocked: "blocked", assigned: "assigned", done: "done", stopped: "stopped",
};
/** Chips shown before "+N"; a phone shows one fewer (see the CSS). */
const PEOPLE_SHOWN = 3;

/** Who a goal is with, readable collapsed: face and name, and what each is
 *  doing — so "handed a task" never reads as "working". Names are text, not
 *  tooltips. The full list is spoken once; the chips are its picture. */
export function RunPeople({ run, tasks, attempts, gated }: {
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
  attempts: OrchestrationAttempt[];
  gated: ReadonlySet<string>;
}) {
  const roster = useContext(AgentRosterContext);
  const people = runPeople(run, tasks, attempts, gated, roster);
  if (!people.length) return null;
  const spoken = people.map((person) => `${person.name}${person.removed ? " (no longer registered)" : ""}, ${PERSON_LABEL[person.state]}`).join("; ");
  return <span className="orch-people">
    <span className="orch-people-sr">People: {spoken}</span>
    <span className="orch-people-chips" aria-hidden="true">
      {people.map((person, index) => <span key={person.id} className="orch-person" data-state={person.state}
        data-overflow={index >= PEOPLE_SHOWN - 1 ? (index >= PEOPLE_SHOWN ? "all" : "phone") : undefined}>
        <AgentAvatar name={person.name} avatar={person.avatar} id={person.id} size={16} removed={person.removed} decorative />
        <span className="orch-person-name">{person.name}</span>
        <span className="orch-person-state">{PERSON_LABEL[person.state]}</span>
      </span>)}
      {people.length > PEOPLE_SHOWN && <span className="orch-person-more is-wide" title={spoken}>+{people.length - PEOPLE_SHOWN}</span>}
      {people.length > PEOPLE_SHOWN - 1 && <span className="orch-person-more is-narrow" title={spoken}>+{people.length - (PEOPLE_SHOWN - 1)}</span>}
    </span>
  </span>;
}

/** The one count of what a run owes, and the way to it. */
export function AttentionButton({ attention, onShow }: { attention: RunAttention; onShow: () => void }) {
  const label = attentionLabel(attention);
  if (!label) return null;
  const parts = attentionSpoken(attention);
  return <button type="button" className="orch-attention" data-tone={attentionTone(attention)}
    aria-label={`${parts}. Show`} title={`${parts}. Show`} onClick={onShow}>
    <AlertIcon />{label}
  </button>;
}

/** Where the run stands, one line per kind of evidence (feedback ee0a43b0):
 *  tasks settled, checks, merged source, deployment and
 *  acceptance never collapse into one number. Closed, it is the acceptance
 *  line; open, each stage with what it rests on. */
export function RunStages({ tasks }: {
  tasks: OrchestrationTask[];
}) {
  const stages = runStages(tasks);
  const acceptance = acceptanceLine(stages);
  return <details className="orch-stages">
    <summary><span>Acceptance</span><span className="orch-stage-value" data-tone={acceptance.tone}>{acceptance.value}</span></summary>
    <dl>
      {stages.map((stage) => <div key={stage.key} className="orch-stage">
        <dt>{stage.label}</dt>
        <dd><span className="orch-stage-value" data-tone={stage.tone}>{stage.value}</span>
          {stage.note && <small>{stage.note}</small>}</dd>
      </div>)}
    </dl>
  </details>;
}

/** The row opens the worker chat; the separate disclosure shows its checklist. */
/** The run's totals. A tile whose figure the host did not send is not drawn:
 *  nothing is worked out in its place. */
export function RunTiles({ tiles }: { tiles: RunTilesData }) {
  return <dl className="run-tiles" aria-label="Mission totals">
    <div className="run-tile"><dt>Tasks</dt><dd>{tasksLabel(tiles.tasks)}</dd></div>
    {tiles.tokens !== null && <div className="run-tile" title="Tokens the workers read and wrote, as their providers reported them. Usage a provider never reported is not in it.">
      <dt>Tokens</dt><dd>{tokensLabel(tiles.tokens)}</dd>
    </div>}
    {tiles.elapsedMs !== null && <div className="run-tile" title="Wall time from the first dispatch to the latest settlement. Overlapping workers are counted once.">
      <dt>Time</dt><dd>{minutesLabel(tiles.elapsedMs)}</dd>
    </div>}
  </dl>;
}

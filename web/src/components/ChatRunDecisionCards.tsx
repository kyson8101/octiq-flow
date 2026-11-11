// The run's person gates and failures in its coordinator's existing card stack.
// runWaits owns eligibility and identity; the panel owns the shared controls.
import { ActionIcon } from "./ActionIcon";
import { useEffect, useRef, useState } from "react";
import type { OrchestrationGate, OrchestrationRun, OrchestrationSnapshot, OrchestrationTask } from "../lib/orchestration";
import { gateDoor } from "../lib/orchestration";
import { openGates, runWaits, type RunWaits, type Wait } from "../lib/runWaits";
import { failureNote } from "../lib/runProgress";
import { reopenControl, startControl } from "../lib/taskHold";
import { IN_FLIGHT, taskFlight, useInFlight } from "../lib/inFlight";
import { resolveRunGate, runWorkspaceAction, startRunTask } from "../lib/runDecisionActions";
import { orchestrationFeed } from "../lib/orchestrationFeed";
import { useRunDetail } from "../lib/useOrchestrationSnapshot";
import { dropHeld, notePress, repeatsAnother } from "../lib/pressGuard";
import { watchBlock } from "../lib/questionSight";
import { sizeLabel } from "../lib/cardFold";
import { FoldBody, FoldLine, useFold } from "./CardFold";
import { GateAnswer, ReopenQuestion, StartButton } from "./OrchestrationPanel";
import "./ChatRunDecisionCards.css";

export type ChatRunDecision = { wait: Wait; run: OrchestrationRun; task?: OrchestrationTask; gate?: OrchestrationGate };

/** No new wait reader: ask the one reading for exactly the two missing kinds. */
export function chatRunDecisions(snapshot: OrchestrationSnapshot, run: OrchestrationRun, waits: RunWaits): ChatRunDecision[] {
  const decisionsByKey = new Map(openGates(snapshot, run.id).map(gate => [`gate:${gate.id}`, gate]));
  return waits.person.flatMap(wait => {
    if (wait.kind !== "gate" && wait.kind !== "failure") return [];
    const task = snapshot.tasks.find(task => task.id === wait.taskId);
    const gate = decisionsByKey.get(wait.key);
    return wait.kind === "gate" && !gate ? [] : [{ wait, run, task, gate }];
  });
}

/** Empty coordinator transcripts must still draw their waiting card stack. */
export function hasChatRunDecisions(snapshot: OrchestrationSnapshot | null, chatKey: string): boolean {
  return !!snapshot?.runs.some(run => run.coordinatorChatKey === chatKey
    && runWaits(snapshot, run).person.some(wait => wait.kind === "gate" || wait.kind === "failure"));
}

export function ChatRunDecisionCards({ snapshot, chatKey, onOpenChat, startOpen = false }: {
  snapshot: OrchestrationSnapshot | null;
  chatKey: string;
  onOpenChat: (key: string, message?: string) => void;
  startOpen?: boolean;
}) {
  if (!snapshot) return null;
  return <>{snapshot.runs.filter(run => run.coordinatorChatKey === chatKey).map(run =>
    <RunDecisions key={run.id} summary={snapshot} runId={run.id} onOpenChat={onOpenChat} startOpen={startOpen} />)}</>;
}

function RunDecisions({ summary, runId, onOpenChat, startOpen }: {
  summary: OrchestrationSnapshot; runId: string; onOpenChat: (key: string, message?: string) => void; startOpen: boolean;
}) {
  // Workspace/review evidence can be omitted from the lightweight summary.
  // Lease through the existing feed; current summary decisions still win.
  const current = summary.runs.find(run => run.id === runId);
  const shown = !!current && runWaits(summary, current).person.some(wait => wait.kind === "gate" || wait.kind === "failure");
  const { snapshot, ready, error } = useRunDetail(summary, shown ? runId : null);
  const run = snapshot.runs.find(run => run.id === runId);
  if (!run) return null;
  const waits = runWaits(snapshot, run);
  const cards = chatRunDecisions(snapshot, run, waits);
  if (!cards.length) return null;
  return <div className="chat-run-decisions">
    {cards.map(card => <DecisionCard key={card.wait.key} card={card} snapshot={snapshot} waits={waits}
      ready={ready} detailError={error} onOpenChat={onOpenChat} startOpen={startOpen} />)}
  </div>;
}

function DecisionCard({ card: { wait, run, task, gate }, snapshot, waits, ready, detailError, onOpenChat, startOpen }: {
  card: ChatRunDecision; snapshot: OrchestrationSnapshot; waits: RunWaits; ready: boolean; detailError?: string;
  onOpenChat: (key: string, message?: string) => void; startOpen: boolean;
}) {
  const fold = useFold(wait.key, { startOpen });
  const element = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => element.current ? watchBlock(wait.key, element.current, 1, "decision") : undefined, [wait.key]);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  useEffect(() => {
    if (reopening) { asked.current = true; return; }
    if (asked.current) { asked.current = false; opener.current?.focus(); }
  }, [reopening]);
  const flying = useInFlight(task ? taskFlight(task.id) : null);
  const start = task && !gate ? startControl(task, run, snapshot.tasks, snapshot.attempts, waits.gated.has(task.id)) : null;
  const reopen = task && !gate && !start ? reopenControl(task, run) : null;
  const failure = task && !gate ? failureNote(task, start, null, reopen) : null;
  const detail = task?.spec || run.objective;
  const attempt = task && snapshot.attempts.find(attempt => attempt.id === task.activeAttemptId);
  const report = attempt?.summary;
  const perform = async (send: () => Promise<unknown>) => {
    setError(null);
    try {
      const result = await send();
      await orchestrationFeed.refresh();
      return result;
    } catch (problem) { setError(String((problem as Error)?.message ?? problem)); }
  };
  return <article ref={element} className="chat-run-decision" data-pending="" data-pending-keys={wait.key} tabIndex={-1}>
    <p className="chat-run-decision-title">{task?.title ?? run.objective}</p>
    <p className="chat-run-decision-ask">{gate?.question ?? (start || reopen ? "This task needs your decision to continue." : failure?.note)}</p>
    <FoldLine fold={fold} labels={[`Details · ${sizeLabel(detail)}`, report && `Report · ${sizeLabel(report)}`]} />
    <FoldBody fold={fold}>
      <p className="chat-run-decision-detail">{detail}</p>
      {report && <p className="chat-run-decision-detail">{report}</p>}
      {(start || reopen) && failure && <p>{failure.note}</p>}
    </FoldBody>
    {gate && <GateAnswer gate={gate} door={gateDoor(gate, snapshot.tasks, true)} mine busy={!ready}
      value={value} onChange={setValue} onResolve={(gate, answer, door) => {
        void perform(async () => {
          const sent = await resolveRunGate(run, gate, answer, door, onOpenChat);
          if (sent !== IN_FLIGHT) setValue("");
        });
      }} />}
    {task && start && <StartButton start={start} busy={!ready} onStart={async () => {
      const result = await perform(() => startRunTask(run, task, start.attempt));
      return typeof result === "string" ? result : null;
    }} />}
    {task && reopen && (reopening
      ? <ReopenQuestion task={task} busy={!ready} onCancel={() => setReopening(false)} onReopen={spec => {
        void perform(() => runWorkspaceAction(run, "orchestration_task_reopen", { taskId: task.id, spec }));
      }} />
      : <button ref={opener} type="button" className="orch-delivery-opener" disabled={!ready || flying} onKeyDown={dropHeld}
        onClick={event => { if (repeatsAnother(event)) return; notePress(event); setReopening(true); }} data-icon-action title={reopen.label} aria-label={reopen.label}>
        <ActionIcon name="reopen" />
      </button>)}
    {!ready && <p role="status">{detailError ?? "Reading the task's decision…"}</p>}
    {error && <p className="chat-run-decision-error" role="alert">{error}</p>}
  </article>;
}

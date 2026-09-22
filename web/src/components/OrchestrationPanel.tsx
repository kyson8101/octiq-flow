import { useCallback, useEffect, useMemo, useState } from "react";
import { bridge } from "../lib/bridge";
import "./OrchestrationPanel.css";

import {
  EMPTY_ORCHESTRATION as EMPTY,
  type OrchestrationRun, type OrchestrationSnapshot, type RunStatus,
  type OrchestrationTask, type OrchestrationAttempt, type OrchestrationGate, type OrchestrationMessage,
} from "../lib/orchestration";
export type { OrchestrationSnapshot } from "../lib/orchestration";

type ProjectRef = { id: string; name: string; primary_path?: string };

const ACTIVE_RUNS = new Set<RunStatus>(["planning", "running", "waiting"]);

export function OrchestrationButton({ open, onToggle, snapshot }: {
  open: boolean;
  onToggle: () => void;
  snapshot: OrchestrationSnapshot;
}) {
  const active = snapshot.runs.filter((run) => ACTIVE_RUNS.has(run.status)).length;
  const gates = snapshot.gates.filter((gate) => gate.status === "open").length;
  const count = gates || active;
  return (
    <button
      className={`orch-toggle${open ? " is-on" : ""}${gates ? " needs-decision" : ""}`}
      type="button"
      aria-label={`Orchestrator${gates ? `, ${gates} decisions waiting` : active ? `, ${active} active runs` : ""}`}
      aria-expanded={open}
      title="Orchestrator"
      onClick={onToggle}
    >
      <OrchestratorIcon />
      <span className="topbar-action-label">Orchestrator</span>
      {count > 0 && <span className="orch-toggle-count">{count}</span>}
    </button>
  );
}

export function OrchestrationPanel({
  project,
  coordinatorKey,
  currentCwd,
  onOpenChat,
  onClose,
  initialSnapshot = EMPTY,
  readOnly = false,
}: {
  project: ProjectRef | null;
  coordinatorKey: string | null;
  currentCwd?: string;
  onOpenChat: (chatKey: string, message?: string) => void;
  onClose: () => void;
  initialSnapshot?: OrchestrationSnapshot;
  readOnly?: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedId, setSelectedId] = useState<string | null>(initialSnapshot.runs[0]?.id ?? null);
  const [creating, setCreating] = useState(initialSnapshot.runs.length === 0 && !readOnly);
  const [objective, setObjective] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirmStop, setConfirmStop] = useState(false);

  const read = useCallback(async () => {
    try {
      const next = await bridge.invoke<OrchestrationSnapshot>("orchestration_snapshot");
      setSnapshot(next ?? EMPTY);
      setError(null);
    } catch (problem) {
      setError(messageOf(problem));
    }
  }, []);

  useEffect(() => {
    void read();
    const offEvent = bridge.on("orchestration-changed", () => void read());
    const offState = bridge.onState((state) => state === "open" && void read());
    return () => {
      offEvent();
      offState();
    };
  }, [read]);

  const runs = useMemo(
    () => snapshot.runs.filter((run) => !project || run.workspaceId === project.id),
    [snapshot.runs, project],
  );

  useEffect(() => {
    if (creating && !readOnly) return;
    if (selectedId && runs.some((run) => run.id === selectedId)) return;
    const next = runs.find((run) => ACTIVE_RUNS.has(run.status)) ?? runs[0];
    setSelectedId(next?.id ?? null);
    if (!next && runs.length === 0) setCreating(true);
  }, [runs, selectedId, creating, readOnly]);

  const selected = runs.find((run) => run.id === selectedId) ?? null;
  const tasks = snapshot.tasks.filter((task) => task.runId === selected?.id);
  const attempts = snapshot.attempts.filter((attempt) => attempt.runId === selected?.id);
  const gates = snapshot.gates.filter((gate) => gate.runId === selected?.id);
  const messages = snapshot.messages.filter((message) => message.runId === selected?.id);

  const startRun = async () => {
    if (readOnly || !project || !coordinatorKey || !objective.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const run = await bridge.invoke<OrchestrationRun>("orchestration_run_create", {
        actorChatKey: coordinatorKey,
        objective: objective.trim(),
        workspaceId: project.id,
        rootPath: currentCwd || project.primary_path || "",
        maxConcurrent,
        startMaster: true,
      });
      setObjective("");
      setSelectedId(run.id);
      setCreating(false);
      await read();
    } catch (problem) {
      setError(messageOf(problem));
    } finally {
      setBusy(false);
    }
  };

  const resolveGate = async (gate: OrchestrationGate, resolution: string) => {
    if (readOnly || !selected || !resolution.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onOpenChat(selected.coordinatorChatKey,
        `For orchestration gate ${gate.id}:\n\n${gate.question}\n\nMy answer: ${resolution.trim()}\n\nReview this answer and coordinate the next step through orchestration_gate_resolve.`);
      setAnswers((current) => ({ ...current, [gate.id]: "" }));
      onClose();
    } catch (problem) {
      setError(messageOf(problem));
    } finally {
      setBusy(false);
    }
  };

  const stopRun = async () => {
    if (readOnly || !selected) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.invoke("orchestration_run_stop", {
        actorChatKey: selected.coordinatorChatKey,
        runId: selected.id,
        reason: "Stopped by the person from the Orchestrator panel.",
      });
      setConfirmStop(false);
      await read();
    } catch (problem) {
      setError(messageOf(problem));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <aside className="panel orch-page" role="dialog" aria-modal="true" aria-labelledby="orch-title">
        <header className="panel-head orch-page-head">
          <div className="panel-id">
            <div className="panel-name" id="orch-title">Orchestrator</div>
            <div className="panel-path">{project?.name ?? "All projects"}</div>
          </div>
          <button className="panel-close" type="button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </header>

        <div className="orch-layout">
          <nav className="orch-runs" aria-label="Orchestration runs">
            <button
              className={`orch-new${creating ? " is-on" : ""}`}
              type="button"
              disabled={readOnly}
              onClick={() => { setCreating(true); setConfirmStop(false); }}
            >
              <PlusIcon />
              Start a run
            </button>
            <div className="orch-run-list">
              {runs.map((run) => {
                const runTasks = snapshot.tasks.filter((task) => task.runId === run.id);
                const done = runTasks.filter((task) => task.status === "completed").length;
                const openGates = snapshot.gates.filter((gate) => gate.runId === run.id && gate.status === "open").length;
                return (
                  <button
                    className={`orch-run-pick${!creating && selectedId === run.id ? " is-on" : ""}`}
                    type="button"
                    key={run.id}
                    onClick={() => { setSelectedId(run.id); setCreating(false); setConfirmStop(false); }}
                  >
                    <StatusMark status={run.status} />
                    <span className="orch-run-copy">
                      <span>{run.objective}</span>
                      <small>
                        {done}/{runTasks.length} tasks
                        {openGates > 0 ? ` · ${openGates} waiting` : ""}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="orch-runs-note">The host owns task state. Agents report into it.</p>
          </nav>

          <main className="orch-content">
            {error && <div className="orch-error" role="alert">{error}</div>}
            {readOnly && <p className="orch-empty">This agent chat is read-only. Send instructions and decisions in the main chat.</p>}
            {creating && !readOnly ? (
              <NewRun
                project={project}
                hasCoordinator={!!coordinatorKey}
                objective={objective}
                maxConcurrent={maxConcurrent}
                busy={busy}
                onObjective={setObjective}
                onConcurrency={setMaxConcurrent}
                onStart={() => void startRun()}
              />
            ) : selected ? (
              <RunDetail
                run={selected}
                tasks={tasks}
                attempts={attempts}
                gates={gates}
                messages={messages}
                answers={answers}
                busy={busy}
                readOnly={readOnly}
                confirmStop={confirmStop}
                onAnswer={(gateId, answer) => setAnswers((current) => ({ ...current, [gateId]: answer }))}
                onResolve={(gate, answer) => void resolveGate(gate, answer)}
                onOpenChat={onOpenChat}
                onAskStop={() => setConfirmStop(true)}
                onCancelStop={() => setConfirmStop(false)}
                onStop={() => void stopRun()}
              />
            ) : (
              <div className="orch-empty">No runs in this project yet.</div>
            )}
          </main>
        </div>
      </aside>
    </>
  );
}

function NewRun({
  project,
  hasCoordinator,
  objective,
  maxConcurrent,
  busy,
  onObjective,
  onConcurrency,
  onStart,
}: {
  project: ProjectRef | null;
  hasCoordinator: boolean;
  objective: string;
  maxConcurrent: number;
  busy: boolean;
  onObjective: (value: string) => void;
  onConcurrency: (value: number) => void;
  onStart: () => void;
}) {
  const ready = !!project && hasCoordinator && !!objective.trim() && !busy;
  return (
    <section className="orch-start" aria-labelledby="orch-start-title">
      <div className="orch-start-intro">
        <OrchestratorGlyph />
        <div>
          <h2 id="orch-start-title">Give one agent the whole outcome.</h2>
          <p>It will plan the dependency graph, open isolated worktrees, dispatch workers, and keep the run’s state outside their transcripts.</p>
        </div>
      </div>
      <label className="orch-field">
        <span>Outcome</span>
        <textarea
          value={objective}
          rows={6}
          autoFocus
          placeholder="Ship the feature, including tests and a review-ready branch…"
          onChange={(event) => onObjective(event.target.value)}
        />
      </label>
      <div className="orch-start-row">
        <label className="orch-field orch-concurrency">
          <span>Worker limit</span>
          <select value={maxConcurrent} onChange={(event) => onConcurrency(Number(event.target.value))}>
            {[1, 2, 3, 4, 6, 8].map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        </label>
        <div className="orch-launch-copy">
          <strong>{project?.name ?? "Choose a project"}</strong>
          <span>{hasCoordinator ? "This chat becomes the master." : "Open a chat first; it becomes the master."}</span>
        </div>
        <button className="orch-primary" type="button" disabled={!ready} onClick={onStart}>
          {busy ? "Starting…" : "Start master run"}
        </button>
      </div>
    </section>
  );
}

function RunDetail({
  run,
  tasks,
  attempts,
  gates,
  messages,
  answers,
  busy,
  readOnly,
  confirmStop,
  onAnswer,
  onResolve,
  onOpenChat,
  onAskStop,
  onCancelStop,
  onStop,
}: {
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
  attempts: OrchestrationAttempt[];
  gates: OrchestrationGate[];
  messages: OrchestrationMessage[];
  answers: Record<string, string>;
  busy: boolean;
  readOnly: boolean;
  confirmStop: boolean;
  onAnswer: (gateId: string, answer: string) => void;
  onResolve: (gate: OrchestrationGate, answer: string) => void;
  onOpenChat: (chatKey: string) => void;
  onAskStop: () => void;
  onCancelStop: () => void;
  onStop: () => void;
}) {
  const openGates = gates.filter((gate) => gate.status === "open");
  const completed = tasks.filter((task) => task.status === "completed").length;
  const active = attempts.filter((attempt) => ["preparing", "running", "blocked"].includes(attempt.status)).length;
  const taskNames = new Map(tasks.map((task) => [task.id, task.title]));
  const byTask = new Map<string, OrchestrationAttempt>();
  for (const attempt of attempts) {
    const previous = byTask.get(attempt.taskId);
    if (!previous || attempt.number > previous.number) byTask.set(attempt.taskId, attempt);
  }

  return (
    <section className="orch-run-detail" aria-labelledby="orch-run-title">
      <header className="orch-run-head">
        <div>
          <div className="orch-status-line"><StatusMark status={run.status} />{statusLabel(run.status)}</div>
          <h2 id="orch-run-title">{run.objective}</h2>
          <p>{run.rootPath}</p>
        </div>
        {!readOnly && ACTIVE_RUNS.has(run.status) && (
          confirmStop ? (
            <div className="orch-stop-confirm">
              <span>Stop workers and cancel open tasks?</span>
              <button type="button" onClick={onCancelStop}>Keep running</button>
              <button className="is-danger" type="button" disabled={busy} onClick={onStop}>Stop run</button>
            </div>
          ) : (
            <button className="orch-quiet" type="button" onClick={onAskStop}>Stop run</button>
          )
        )}
      </header>

      <div className="orch-metrics" aria-label="Run status">
        <div><strong>{completed}<span>/{tasks.length}</span></strong><small>Tasks complete</small></div>
        <div><strong>{active}</strong><small>Workers active</small></div>
        <div className={openGates.length ? "needs-decision" : ""}><strong>{openGates.length}</strong><small>Decisions waiting</small></div>
        <div><strong>{run.maxConcurrent}</strong><small>Worker limit</small></div>
      </div>

      {openGates.length > 0 && (
        <section className="orch-decisions" aria-labelledby="orch-decisions-title">
          <h3 id="orch-decisions-title">Decisions</h3>
          {openGates.map((gate) => (
            <article className="orch-gate" key={gate.id}>
              <p>{gate.question}</p>
              {!readOnly && gate.options.length > 0 && (
                <div className="orch-gate-options">
                  {gate.options.map((option) => (
                    <button type="button" key={option} disabled={busy} onClick={() => onResolve(gate, option)}>{option}</button>
                  ))}
                </div>
              )}
              {!readOnly && <div className="orch-gate-write">
                <input
                  value={answers[gate.id] ?? ""}
                  placeholder="Write a decision"
                  aria-label={`Decision for ${gate.question}`}
                  onChange={(event) => onAnswer(gate.id, event.target.value)}
                />
                <button type="button" disabled={busy || !(answers[gate.id] ?? "").trim()} onClick={() => onResolve(gate, answers[gate.id] ?? "")}>Send to main chat</button>
              </div>}
            </article>
          ))}
        </section>
      )}

      <section className="orch-ledger" aria-labelledby="orch-ledger-title">
        <div className="orch-section-head">
          <h3 id="orch-ledger-title">Execution ledger</h3>
          <span>{tasks.length ? `${completed} settled` : "Planning"}</span>
        </div>
        {tasks.length === 0 ? (
          <div className="orch-planning"><span className="orch-pulse" />The master is turning the outcome into tasks.</div>
        ) : tasks.map((task) => {
          const attempt = byTask.get(task.id);
          return (
            <article className={`orch-task is-${task.status}`} key={task.id}>
              <div className="orch-task-rail"><StatusMark status={task.status} /></div>
              <div className="orch-task-body">
                <header>
                  <div>
                    <h4>{task.title}</h4>
                    {task.dependsOn.length > 0 && <p>After {task.dependsOn.map((id) => taskNames.get(id) ?? id).join(", ")}</p>}
                  </div>
                  <span className="orch-task-state">{statusLabel(task.status)}</span>
                </header>
                <p className="orch-task-spec">{task.spec}</p>
                {attempt && (
                  <div className="orch-attempt">
                    <button type="button" onClick={() => onOpenChat(attempt.workerChatKey)}>
                      {attempt.agent} worker #{attempt.number}
                    </button>
                    {attempt.branch && <code>{attempt.branch}</code>}
                    {attempt.isWorktree && <span>worktree</span>}
                    {attempt.summary && <p>{attempt.summary}</p>}
                  </div>
                )}
                {!attempt && task.result && <p className="orch-task-result">{task.result}</p>}
              </div>
            </article>
          );
        })}
      </section>

      {messages.length > 0 && (
        <section className="orch-messages" aria-labelledby="orch-messages-title">
          <div className="orch-section-head"><h3 id="orch-messages-title">Coordination log</h3><span>Latest {Math.min(messages.length, 6)}</span></div>
          {messages.slice(-6).reverse().map((message) => (
            <article key={message.id}>
              <div><strong>{message.subject}</strong><span>{message.kind} · {timeLabel(message.createdAt)}</span></div>
              <p>{message.body}</p>
            </article>
          ))}
        </section>
      )}
    </section>
  );
}

function StatusMark({ status }: { status: string }) {
  return <span className={`orch-status is-${status}`} aria-hidden="true" />;
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function timeLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function messageOf(problem: unknown): string {
  return String((problem as Error)?.message ?? problem);
}

function OrchestratorIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M12 7.5v4M12 11.5H5v4M12 11.5h7v4"/></svg>;
}

function OrchestratorGlyph() {
  return <div className="orch-glyph" aria-hidden="true"><span /><span /><span /><i /><i /></div>;
}

function PlusIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function CloseIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>;
}

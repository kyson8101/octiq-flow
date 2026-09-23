import { useCallback, useEffect, useMemo, useState, useRef, type ReactNode } from "react";
import { bridge } from "../lib/bridge";
import "./OrchestrationPanel.css";
import { chatSnapshot, isActiveRun } from "../lib/chatWorkflow";

import {
  EMPTY_ORCHESTRATION as EMPTY, WORKSPACE_MODES, workspaceDeliveryLabel,
  type WorkspaceMode, type WorkerDefaults,
  type OrchestrationRun, type OrchestrationSnapshot, type RunStatus,
  type OrchestrationTask, type OrchestrationAttempt, type OrchestrationGate, type OrchestrationMessage, type OrchestrationNotification,
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
  embedded = false,
  setupContext,
  onEnsureCoordinator,
  onStartMaster,
}: {
  project: ProjectRef | null;
  coordinatorKey: string | null;
  currentCwd?: string;
  onOpenChat: (chatKey: string, message?: string) => void;
  onClose: () => void;
  initialSnapshot?: OrchestrationSnapshot;
  readOnly?: boolean;
  embedded?: boolean;
  setupContext?: ReactNode;
  onEnsureCoordinator?: (objective: string) => Promise<string>;
  onStartMaster?: (run: OrchestrationRun) => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedId, setSelectedId] = useState<string | null>((embedded ? chatSnapshot(initialSnapshot, coordinatorKey) : initialSnapshot).runs[0]?.id ?? null);
  const [creating, setCreating] = useState((embedded ? chatSnapshot(initialSnapshot, coordinatorKey) : initialSnapshot).runs.length === 0 && !readOnly);
  const [objective, setObjective] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState(4);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("auto");
  const [automatic, setAutomatic] = useState(true);
  const [workerAgent, setWorkerAgent] = useState<WorkerDefaults["agent"]>("codex");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirmStop, setConfirmStop] = useState(false);

  const readRevision = useRef(0);
  const read = useCallback(async () => {
    const requested = ++readRevision.current;
    try {
      const next = await bridge.invoke<OrchestrationSnapshot>("orchestration_snapshot");
      if (requested === readRevision.current) setSnapshot(next ?? EMPTY);
    } catch (problem) {
      if (requested === readRevision.current) setError(messageOf(problem));
    }
  }, []);

  useEffect(() => {
    void read();
    const offEvent = bridge.on("orchestration-changed", () => void read());
    const offState = bridge.onState((state) => state === "open" && void read());
    return () => {
      readRevision.current++;
      offEvent();
      offState();
    };
  }, [read]);

  const runs = useMemo(
    () => embedded ? chatSnapshot(snapshot, coordinatorKey).runs : snapshot.runs.filter((run) => !project || run.workspaceId === project.id),
    [snapshot, project, embedded, coordinatorKey],
  );

  useEffect(() => {
    setSelectedId(null);
    setCreating(false);
    setError(null);
    setConfirmStop(false);
    setObjective("");
  }, [coordinatorKey]);

  useEffect(() => {
    if (creating && !readOnly && !(embedded && runs.some(isActiveRun))) return;
    if (selectedId && runs.some((run) => run.id === selectedId)) return;
    const next = runs.find((run) => ACTIVE_RUNS.has(run.status)) ?? runs[0];
    setSelectedId(next?.id ?? null);
    setCreating(!next && runs.length === 0);
  }, [runs, selectedId, creating, readOnly, embedded]);

  const selected = runs.find((run) => run.id === selectedId) ?? null;
  const tasks = snapshot.tasks.filter((task) => task.runId === selected?.id);
  const attempts = snapshot.attempts.filter((attempt) => attempt.runId === selected?.id);
  const gates = snapshot.gates.filter((gate) => gate.runId === selected?.id);
  const messages = snapshot.messages.filter((message) => message.runId === selected?.id);

  const startRun = async () => {
    if (readOnly || !project || (!coordinatorKey && !onEnsureCoordinator) || !objective.trim()) return;
    if (embedded && runs.some(isActiveRun)) { setCreating(false); return; }
    setBusy(true);
    setError(null);
    try {
      const actor = onEnsureCoordinator ? await onEnsureCoordinator(objective.trim()) : coordinatorKey;
      const run = await bridge.invoke<OrchestrationRun>("orchestration_run_create", {
        actorChatKey: actor,
        objective: objective.trim(),
        workspaceId: project.id,
        rootPath: currentCwd || project.primary_path || "",
        maxConcurrent: workspaceMode === "direct" ? 1 : maxConcurrent,
        workspaceMode,
        workerDefaults: automatic ? { agent: workerAgent, access: "auto" } : null,
        startMaster: !onStartMaster,
      });
      setObjective("");
      setSnapshot((before) => ({ ...before, runs: [run, ...before.runs.filter((item) => item.id !== run.id)] }));
      setSelectedId(run.id);
      setCreating(false);
      await read();
      if (onStartMaster) await onStartMaster(run);
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

  const retryTask = async (task: OrchestrationTask, attempt: OrchestrationAttempt) => {
    if (readOnly || !selected) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.invoke("orchestration_worker_start", {
        actorChatKey: selected.coordinatorChatKey,
        ...retryLaunchArgs(task, attempt),
      });
      await read();
    } catch (problem) {
      setError(messageOf(problem));
    } finally {
      setBusy(false);
    }
  };

  const workspaceAction = async (command: string, args: Record<string, unknown>) => {
    if (readOnly || !selected) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.invoke(command, { actorChatKey: selected.coordinatorChatKey, ...args });
      await read();
    } catch (problem) {
      setError(messageOf(problem));
    } finally { setBusy(false); }
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
      {!embedded && <div className="panel-scrim" onClick={onClose} />}
      <aside className={embedded ? "orch-embedded" : "panel orch-page"} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label={embedded ? "Runs for this chat" : undefined} aria-labelledby={embedded ? undefined : "orch-title"}>
        {!embedded && <>
        <header className="panel-head orch-page-head">
          <div className="panel-id">
            <div className="panel-name" id="orch-title">Orchestrator</div>
            <div className="panel-path">{project?.name ?? "All projects"}</div>
          </div>
          <button className="panel-close" type="button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        </>}

        <div className="orch-layout">
          <nav className="orch-runs" aria-label="Orchestration runs">
            <button
              className={`orch-new${creating ? " is-on" : ""}`}
              type="button"
              disabled={readOnly || busy || (embedded && runs.some(isActiveRun))}
              onClick={() => { setCreating(true); setConfirmStop(false); }}
            >
              <PlusIcon />
              {embedded ? "New run" : "Start a run"}
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
            {!embedded && <p className="orch-runs-note">The host owns task state. Agents report into it.</p>}
          </nav>

          <div className="orch-content">
            {error && <div className="orch-error" role="alert">{error}</div>}
            {readOnly && <p className="orch-empty">This agent chat is read-only. Send instructions and decisions in the main chat.</p>}
            {creating && !readOnly ? (
              <NewRun
                project={project}
                hasCoordinator={!!coordinatorKey || !!onEnsureCoordinator}
                setupContext={setupContext}
                objective={objective}
                maxConcurrent={maxConcurrent}
                workspaceMode={workspaceMode}
                onWorkspaceMode={setWorkspaceMode}
                automatic={automatic}
                onAutomatic={setAutomatic}
                workerAgent={workerAgent}
                onWorkerAgent={setWorkerAgent}
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
                notifications={(snapshot.notifications ?? []).filter((notification) => notification.runId === selected.id)}
                answers={answers}
                busy={busy}
                readOnly={readOnly}
                confirmStop={confirmStop}
                onAnswer={(gateId, answer) => setAnswers((current) => ({ ...current, [gateId]: answer }))}
                onResolve={(gate, answer) => void resolveGate(gate, answer)}
                onRetry={(task, attempt) => void retryTask(task, attempt)}
                onWorkspaceAction={(command, args) => void workspaceAction(command, args)}
                onOpenChat={onOpenChat}
                onAskStop={() => setConfirmStop(true)}
                onCancelStop={() => setConfirmStop(false)}
                onStop={() => void stopRun()}
                onStartMaster={onStartMaster ? async () => {
                  setBusy(true); setError(null);
                  try { await onStartMaster(selected); }
                  catch (problem) { setError(messageOf(problem)); }
                  finally { setBusy(false); }
                } : undefined}
              />
            ) : (
              <div className="orch-empty">{embedded ? "No runs in this chat yet." : "No runs in this project yet."}</div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

function NewRun({
  project,
  hasCoordinator,
  setupContext,
  objective,
  maxConcurrent,
  workspaceMode, onWorkspaceMode, automatic, onAutomatic, workerAgent, onWorkerAgent,
  busy,
  onObjective,
  onConcurrency,
  onStart,
}: {
  project: ProjectRef | null;
  hasCoordinator: boolean;
  setupContext?: ReactNode;
  objective: string;
  maxConcurrent: number;
  workspaceMode: WorkspaceMode;
  onWorkspaceMode: (mode: WorkspaceMode) => void;
  automatic: boolean;
  onAutomatic: (automatic: boolean) => void;
  workerAgent: WorkerDefaults["agent"];
  onWorkerAgent: (agent: WorkerDefaults["agent"]) => void;
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
          <p>The main agent plans the tasks. OctiqFlow prepares their workspaces and keeps progress through execution, review, and cleanup.</p>
        </div>
      </div>
      <fieldset className="orch-setup-context" disabled={busy}>{setupContext}</fieldset>
      <label className="orch-field">
        <span>Outcome</span>
        <textarea
          value={objective}
          disabled={busy}
          rows={6}
          autoFocus
          placeholder="Ship the feature, including tests and a review-ready branch…"
          onChange={(event) => onObjective(event.target.value)}
        />
      </label>
      <fieldset className="orch-workspace-modes">
        <legend>Workspace mode</legend>
        {WORKSPACE_MODES.map((mode) => <label key={mode.value} className={workspaceMode === mode.value ? "is-selected" : ""}>
          <input type="radio" name="workspace-mode" value={mode.value} checked={workspaceMode === mode.value}
            onChange={() => onWorkspaceMode(mode.value)} disabled={busy} />
          <span><strong>{mode.label}</strong><small>{mode.description}</small></span>
        </label>)}
      </fieldset>
      {workspaceMode === "direct" && <p className="orch-workspace-warning" role="note">
        This can modify the primary checkout and existing uncommitted work. Keep existing changes; this folder will never be removed by cleanup.
      </p>}
      <div className="orch-automation-options">
        <label><input type="checkbox" checked={automatic} disabled={busy} onChange={(event) => onAutomatic(event.target.checked)} /> Automatically start ready tasks</label>
        {automatic && <label>Worker <select aria-label="Worker provider" value={workerAgent} disabled={busy} onChange={(event) => onWorkerAgent(event.target.value as WorkerDefaults["agent"])}>
          <option value="codex">Codex</option><option value="claude">Claude</option>
        </select></label>}
      </div>
      <div className="orch-start-row">
        <label className="orch-field orch-concurrency">
          <span>Worker limit</span>
          <select disabled={busy || workspaceMode === "direct"} value={workspaceMode === "direct" ? 1 : maxConcurrent} onChange={(event) => onConcurrency(Number(event.target.value))}>
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
  notifications,
  answers,
  busy,
  readOnly,
  confirmStop,
  onAnswer,
  onResolve,
  onRetry,
  onWorkspaceAction,
  onOpenChat,
  onAskStop,
  onCancelStop,
  onStop,
  onStartMaster,
}: {
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
  attempts: OrchestrationAttempt[];
  gates: OrchestrationGate[];
  messages: OrchestrationMessage[];
  notifications: OrchestrationNotification[];
  answers: Record<string, string>;
  busy: boolean;
  readOnly: boolean;
  confirmStop: boolean;
  onAnswer: (gateId: string, answer: string) => void;
  onResolve: (gate: OrchestrationGate, answer: string) => void;
  onRetry: (task: OrchestrationTask, attempt: OrchestrationAttempt) => void;
  onWorkspaceAction: (command: string, args: Record<string, unknown>) => void;
  onOpenChat: (chatKey: string) => void;
  onAskStop: () => void;
  onCancelStop: () => void;
  onStop: () => void;
  onStartMaster?: () => Promise<void>;
}) {
  const openGates = gates.filter((gate) => gate.status === "open");
  const gateBlockedTasks = new Set(openGates.flatMap((gate) => gate.taskId ? [gate.taskId] : []));
  const completed = tasks.filter((task) => task.status === "completed").length;
  const active = attempts.filter((attempt) =>
    ["preparing", "running"].includes(attempt.status)
      || (attempt.status === "blocked" && gateBlockedTasks.has(attempt.taskId)),
  ).length;
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
          {onStartMaster && !readOnly && ACTIVE_RUNS.has(run.status) && <button className="orch-quiet" type="button" disabled={busy} onClick={() => void onStartMaster()}>Continue main agent</button>}
          <p>{WORKSPACE_MODES.find((mode) => mode.value === (run.workspaceMode ?? "auto"))?.label} · {run.workerDefaults ? `Automatic dispatch · ${run.workerDefaults.agent}` : "Coordinator dispatch"}</p>
          {!readOnly && !run.workerDefaults && ACTIVE_RUNS.has(run.status) && <button className="orch-quiet" type="button" disabled={busy}
            onClick={() => {
              const previous = attempts.find((a) => a.agent === "codex" || a.agent === "claude");
              onWorkspaceAction("orchestration_automation_configure", { runId: run.id,
                workerDefaults: previous ? { agent: previous.agent, access: previous.access, model: previous.model, effort: previous.effort } : { agent: "codex", access: "auto" } });
            }}>Enable automatic dispatch ({attempts.find((a) => a.agent === "codex" || a.agent === "claude")?.agent ?? "codex"})</button>}
          {!readOnly && run.workerDefaults && ACTIVE_RUNS.has(run.status) && <button className="orch-quiet" type="button" disabled={busy}
            onClick={() => onWorkspaceAction("orchestration_automation_configure", { runId: run.id, workerDefaults: null })}>Pause automatic dispatch</button>}
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
          const attempt = attempts.find((candidate) => candidate.id === task.activeAttemptId) ?? byTask.get(task.id);
          const history = attempts.filter((candidate) => candidate.taskId === task.id && candidate.id !== attempt?.id).sort((a, b) => b.number - a.number);
          const reviewReady = task.status === "ready" && attempt?.status === "completed";
          const retryable = !!attempt
            && ["blocked", "failed"].includes(task.status)
            && ["blocked", "failed"].includes(attempt.status)
            && !gateBlockedTasks.has(task.id);
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
                    {(retryable || reviewReady) && !readOnly && run.status !== "stopped" && (
                      <div className="orch-attempt-retry">
                        <small>{attempt.cwd
                          ? "This attempt settled. Continue in the same workspace with a new authoritative attempt."
                          : "This attempt settled before a workspace was assigned. Start a fresh authoritative attempt."}</small>
                        <button type="button" disabled={busy} onClick={() => onRetry(task, attempt)}>{reviewReady ? "Start next attempt" : "Start retry"}</button>
                      </div>
                    )}
                  </div>
                )}
                {history.length > 0 && <details className="orch-attempt-history">
                  <summary>Previous attempts ({history.length})</summary>
                  {history.map((previous) => <div key={previous.id}>
                    <button type="button" onClick={() => onOpenChat(previous.workerChatKey)}>{previous.agent} worker #{previous.number}</button>
                    <span>{statusLabel(previous.status)}</span>
                    {previous.summary && <p>{previous.summary}</p>}
                  </div>)}
                </details>}
                {task.workspace && <WorkspaceDelivery task={task} busy={busy} readOnly={readOnly} stopped={run.status === "stopped"}
                  active={!!attempt && (["preparing", "running"].includes(attempt.status) || gateBlockedTasks.has(task.id))}
                  onAction={onWorkspaceAction} />}
                {!attempt && task.result && <p className="orch-task-result">{task.result}</p>}
              </div>
            </article>
          );
        })}
      </section>

      {notifications.length > 0 && <details className="orch-notifications">
        <summary>Notifications · {notifications.filter((item) => item.state === "pending" || item.state === "delivering").length} awaiting receipt</summary>
        <p>Delivery waits while the main agent is busy or user messages are queued. Receipt confirms delivery, not completion of the requested action.</p>
        {[...notifications].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12).map((item) => <article key={item.id}>
          <strong>{item.kind === "progress" ? "Progress update" : item.kind === "decision" ? "Decision needed" : item.kind === "report" ? "Worker report" : item.kind === "resolution" ? "Decision reply" : "Agent message"}</strong>
          <span>{({ pending: "Queued", delivering: "Awaiting receipt", acknowledged: "Received by agent", cancelled: "No longer needed" })[item.state]}</span>
          {item.coalesced > 0 && <small>{item.coalesced + 1} updates combined</small>}
          {item.lastError && (item.state === "pending" || item.state === "delivering") && <p className="orch-workspace-warning">{item.lastError} Delivery will retry automatically.</p>}
        </article>)}
      </details>}

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

function WorkspaceDelivery({ task, busy, readOnly, active, stopped, onAction }: {
  task: OrchestrationTask; busy: boolean; readOnly: boolean; active: boolean; stopped: boolean;
  onAction: (command: string, args: Record<string, unknown>) => void;
}) {
  const [cleanup, setCleanup] = useState<"merged" | "abandon" | null>(null);
  const [followup, setFollowup] = useState(false);
  const [spec, setSpec] = useState("");
  const workspace = task.workspace!;
  const delivery = workspace.delivery;
  const closed = workspace.state === "cleaned";
  const canCleanup = !active && !closed && workspace.plan.managed && workspace.plan.mode === "worktree" && !!delivery && !delivery.dirty;
  const canAbandon = canCleanup && (delivery.pushed || !delivery.hasCommits);
  return <section className="orch-workspace" aria-label={`Workspace for ${task.title}`}>
    <strong>{workspaceDeliveryLabel(workspace)}</strong>
    <code>{workspace.plan.cwd}</code>
    {workspace.plan.warnings.map((warning) => <p className="orch-workspace-warning" key={warning}>{warning}</p>)}
    {delivery && <p className="orch-delivery-evidence">Checked {timeLabel(delivery.checkedAt)} · {delivery.headSha.slice(0, 8)}
      {delivery.pullRequest && <> · <a href={delivery.pullRequest} target="_blank" rel="noreferrer">Pull request</a></>}
    </p>}
    {delivery?.notes.map((note) => <p key={note}>{note}</p>)}
    {workspace.validationPaths.map((path) => <div className="orch-validation" key={path}>
      <span>Validation: <code>{path}</code></span>
      {!readOnly && <button type="button" disabled={busy} onClick={() => onAction("orchestration_validation_remove", { taskId: task.id, path })}>Remove validation checkout</button>}
    </div>)}
    {!readOnly && !closed && <div className="orch-workspace-actions">
      <button type="button" disabled={busy} onClick={() => onAction("orchestration_workspace_refresh", { taskId: task.id })}>Refresh delivery status</button>
      {task.status === "completed" && !stopped && !delivery?.merged && <button type="button" disabled={busy} onClick={() => setFollowup(!followup)}>Continue after review</button>}
      {canCleanup && delivery.merged && <button type="button" disabled={busy} onClick={() => setCleanup("merged")}>Clean up worktree</button>}
      {canAbandon && !delivery.merged && <button type="button" disabled={busy} onClick={() => setCleanup("abandon")}>Abandon workspace…</button>}
    </div>}
    {!readOnly && followup && !closed && <div className="orch-followup">
      <label>Review fixes<textarea aria-label={`Review fixes for ${task.title}`} value={spec} onChange={(event) => setSpec(event.target.value)} rows={3} /></label>
      <button type="button" disabled={busy || !spec.trim()} onClick={() => { onAction("orchestration_task_reopen", { taskId: task.id, spec: spec.trim() }); setFollowup(false); }}>Reopen task in this workspace</button>
    </div>}
    {!readOnly && cleanup && !closed && <div className="orch-cleanup-confirm" role="group" aria-label="Confirm workspace cleanup">
      <p>{cleanup === "abandon" ? "Abandon this task and remove its clean worktree?" : "Remove this merged worktree?"} Branches and published history are kept.</p>
      <button type="button" disabled={busy} onClick={() => setCleanup(null)}>Keep worktree</button>
      <button type="button" disabled={busy || !delivery || (cleanup === "abandon" ? !canAbandon : !canCleanup || !delivery.merged)} onClick={() => {
        onAction("orchestration_workspace_cleanup", { taskId: task.id, abandon: cleanup === "abandon", expectedHead: delivery?.headSha }); setCleanup(null);
      }}>Confirm removal</button>
    </div>}
  </section>;
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

export function retryLaunchArgs(task: OrchestrationTask, attempt: OrchestrationAttempt) {
  return {
    taskId: task.id,
    agent: attempt.agent,
    model: attempt.model,
    effort: attempt.effort,
    access: attempt.access,
    // A prepared retry keeps the exact assigned checkout and its uncommitted
    // work. A preparation failure has no checkout to reuse, so isolate it anew.
    newWorktree: !attempt.cwd.trim(),
  };
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

import { useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { bridge } from "../lib/bridge";
import "./OrchestrationPanel.css";
import { AGENT_NAME } from "../lib/agentProviders";
import {
  attemptIsExecuting, boardCounts, executionNeedsAttention, EXECUTION_LABELS, runElapsed, runIsLive, shortBranch, shortWorkspacePath,
  sortTasksByActivity, taskElapsed, taskProgress, taskStage, TASK_LABELS, useElapsedTick,
} from "../lib/agentTaskBoard";
import {
  attentionLabel, mainChatTarget, nextRunTab, runAttention, runPeople, RUN_TABS, setRunArchived, splitArchived, stopRun,
  type PersonState, type RunAttention, type RunTab,
} from "../lib/runPanel";
import { agoLabel } from "../lib/chatTask";
import { chatSnapshot, isActiveRun } from "../lib/chatWorkflow";
import { elapsedLabel } from "../lib/working";
import { workerArchiveDisabledReason } from "../lib/workerArchive";
import { orchestrationFeed } from "../lib/orchestrationFeed";
import { useOrchestrationFeed } from "../lib/useOrchestrationSnapshot";
import { initialRunDisclosures, syncRunDisclosures, toggleRunDisclosure } from "../lib/runDisclosure";
import { AgentLogo } from "./AgentLogo";
import { AgentAvatar } from "./AgentAvatar";
import { TaskPlanCard } from "./TaskPlanCard";
import { AgentRosterContext, useRosterAgent } from "../lib/agentRoster";
import { PlanReview } from "./PlanReview";
import { WorkerExecutionEvidence } from "./WorkerExecutionEvidence";
import { TaskLifecycleEvidence } from "./TaskLifecycleEvidence";
import { BranchIcon, ClockIcon, TaskStatusIcon } from "./TaskMeter";
import { OpenBesideButton } from "./OpenBesideButton";

import {
  deliveryTone, EMPTY_ORCHESTRATION as EMPTY, WORKSPACE_MODES, workspaceDeliveryLabel,
  type WorkspaceMode,
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
  currentChatKey = null,
  currentCwd,
  onOpenChat,
  onOpenBeside,
  besideChatKey = null,
  onClose,
  initialSnapshot = EMPTY,
  readOnly = false,
  embedded = false,
  setupContext,
  onEnsureCoordinator,
  onStartMaster,
  coordinatorBusy = false,
  sharedHeading = false,
  onSelectedRunChange,
  projectName,
  allowManualRun = true,
  pendingApprovals = 0,
}: {
  project: ProjectRef | null;
  coordinatorKey: string | null;
  /** The chat on screen. When it is one of this run's workers, its task is
   *  the one marked as open. */
  currentChatKey?: string | null;
  currentCwd?: string;
  onOpenChat: (chatKey: string, message?: string) => void;
  /** Open a task's chat beside its main chat instead of in its place. A row
   *  click still opens it full-width; this is the separate, explicit way. */
  onOpenBeside?: (chatKey: string) => void;
  /** The task chat already open beside the main chat, marked like an open one. */
  besideChatKey?: string | null;
  onClose: () => void;
  initialSnapshot?: OrchestrationSnapshot;
  readOnly?: boolean;
  embedded?: boolean;
  setupContext?: ReactNode;
  onEnsureCoordinator?: (objective: string) => Promise<string>;
  onStartMaster?: (run: OrchestrationRun) => Promise<void>;
  /** The main agent is mid-turn, so a plan waiting for approval may not be
   *  finished yet. */
  coordinatorBusy?: boolean;
  /** The workspace above both columns owns the run title. */
  sharedHeading?: boolean;
  onSelectedRunChange?: (runId: string | null) => void;
  /** A registered project's name, for plan rows that run in the run's own
   *  checkout. */
  projectName?: (id: string) => string | undefined;
  /** Agents mode starts runs conversationally through its CTO. */
  allowManualRun?: boolean;
  /** Permission and safety cards waiting in the main chat, for it and its
   *  workers. They are answered there, so the way there carries the count. */
  pendingApprovals?: number;
}) {
  // The tab's shared ledger; `initialSnapshot` stands in until its first read.
  const feed = useOrchestrationFeed();
  const snapshot = feed.snapshot ?? initialSnapshot;
  const initialRuns = splitArchived(embedded ? chatSnapshot(initialSnapshot, coordinatorKey).runs : initialSnapshot.runs).live;
  const [selectedId, setSelectedId] = useState<string | null>(initialRuns[0]?.id ?? null);
  const [disclosures, setDisclosures] = useState(() => initialRunDisclosures(initialRuns));
  const [creating, setCreating] = useState(initialRuns.length === 0 && !readOnly && allowManualRun);
  const [objective, setObjective] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState(4);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("auto");
  const [automatic, setAutomatic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  /** A stop or archive that did not go through, said beside the control that
   *  asked for it rather than at the top of a scrolled panel. */
  const [runError, setRunError] = useState<{ runId: string; text: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // Each run's open tab lives here, not in its detail, so a ledger refresh or
  // a collapse and re-open lands on the same tab.
  const [runTabs, setRunTabs] = useState<Record<string, RunTab>>({});
  const [attentionFocus, setAttentionFocus] = useState<{ runId: string; nonce: number } | null>(null);

  // After an action: the action itself succeeded, and a failed read shows
  // through the feed's error.
  const read = () => orchestrationFeed.refresh().catch(() => {});
  const invoke = (command: string, args: Record<string, unknown>) => bridge.invoke(command, args);
  const shownError = error ?? feed.error;

  const scopedRuns = useMemo(
    () => embedded ? chatSnapshot(snapshot, coordinatorKey).runs : snapshot.runs.filter((run) => !project || run.workspaceId === project.id),
    [snapshot, project, embedded, coordinatorKey],
  );
  const { live: liveRuns, archived: archivedRuns } = useMemo(() => splitArchived(scopedRuns), [scopedRuns]);
  const runs = showArchived ? archivedRuns : liveRuns;
  const accordionMode = embedded && !allowManualRun;

  useEffect(() => {
    setSelectedId(null);
    setCreating(false);
    setError(null);
    setConfirmStop(null);
    setRunError(null);
    setShowArchived(false);
    setRunTabs({});
    setAttentionFocus(null);
    setObjective("");
    setDisclosures(initialRunDisclosures(liveRuns));
    // Runs are intentionally omitted: this reset follows coordinator identity,
    // while the sync below handles ledger refreshes for the same coordinator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinatorKey]);

  // Restoring the last archived run leaves nothing to look at in that list.
  useEffect(() => {
    if (showArchived && archivedRuns.length === 0) setShowArchived(false);
  }, [showArchived, archivedRuns.length]);

  useEffect(() => {
    if (creating && !readOnly && !(embedded && runs.some(isActiveRun))) return;
    if (selectedId && runs.some((run) => run.id === selectedId)) return;
    const next = runs.find((run) => ACTIVE_RUNS.has(run.status)) ?? runs[0];
    setSelectedId(next?.id ?? null);
    setCreating(allowManualRun && !next && runs.length === 0);
  }, [runs, selectedId, creating, readOnly, embedded, allowManualRun]);

  const selected = runs.find((run) => run.id === selectedId) ?? null;
  useEffect(() => {
    onSelectedRunChange?.(creating ? null : selected?.id ?? null);
  }, [creating, selected?.id, onSelectedRunChange]);

  // Opening a historical worker from the sidebar selects its own run. Moving
  // back to the main chat keeps the run and task navigation in place.
  const workerRunId = snapshot.attempts.find((item) => item.workerChatKey === currentChatKey)?.runId;
  const workerRunArchived = !!workerRunId && archivedRuns.some((run) => run.id === workerRunId);
  useEffect(() => {
    if (workerRunArchived) setShowArchived(true);
  }, [workerRunArchived, currentChatKey]);
  const visibleWorkerRunId = runs.some((run) => run.id === workerRunId) ? workerRunId : null;
  useEffect(() => {
    setDisclosures((before) => syncRunDisclosures(before, runs, visibleWorkerRunId));
  }, [runs, visibleWorkerRunId]);
  useEffect(() => {
    if (visibleWorkerRunId) {
      setSelectedId(visibleWorkerRunId);
      setCreating(false);
    }
  }, [currentChatKey, coordinatorKey, visibleWorkerRunId]);
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
        workerDefaults: automatic ? { access: "auto" } : null,
        startMaster: !onStartMaster,
      });
      setObjective("");
      orchestrationFeed.patch((before) => ({ ...before, runs: [run, ...before.runs.filter((item) => item.id !== run.id)] }));
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

  const resolveGate = async (run: OrchestrationRun, gate: OrchestrationGate, resolution: string) => {
    if (readOnly || !resolution.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onOpenChat(run.coordinatorChatKey,
        `For orchestration gate ${gate.id}:\n\n${gate.question}\n\nMy answer: ${resolution.trim()}\n\nReview this answer and coordinate the next step through orchestration_gate_resolve.`);
      setAnswers((current) => ({ ...current, [gate.id]: "" }));
      onClose();
    } catch (problem) {
      setError(messageOf(problem));
    } finally {
      setBusy(false);
    }
  };

  const retryTask = async (run: OrchestrationRun, task: OrchestrationTask, attempt: OrchestrationAttempt) => {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.invoke("orchestration_worker_start", {
        actorChatKey: run.coordinatorChatKey,
        ...retryLaunchArgs(task, attempt),
      });
      await read();
    } catch (problem) {
      setError(messageOf(problem));
    } finally {
      setBusy(false);
    }
  };

  const workspaceAction = async (run: OrchestrationRun, command: string, args: Record<string, unknown>) => {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.invoke(command, { actorChatKey: run.coordinatorChatKey, ...args });
      await read();
    } catch (problem) {
      setError(messageOf(problem));
    } finally { setBusy(false); }
  };

  const stop = async (run: OrchestrationRun, archive: boolean) => {
    if (readOnly) return;
    setBusy(true);
    setRunError(null);
    const outcome = await stopRun(invoke, run, archive);
    // A stop that landed closes the question even when the archive after it
    // failed: asking again would offer to stop a stopped run.
    if (outcome.ok || outcome.stopped) setConfirmStop(null);
    if (!outcome.ok) setRunError({ runId: run.id, text: outcome.error });
    await read();
    setBusy(false);
  };

  const archiveRun = async (run: OrchestrationRun, archived: boolean) => {
    if (readOnly) return;
    setBusy(true);
    setRunError(null);
    try {
      await setRunArchived(invoke, run, archived);
      setConfirmStop(null);
      await read();
    } catch (problem) {
      setRunError({ runId: run.id, text: `${archived ? "Could not archive" : "Could not restore"} this run: ${messageOf(problem)}` });
    } finally {
      setBusy(false);
    }
  };

  const setRunTab = (runId: string, tab: RunTab) => setRunTabs((before) => before[runId] === tab ? before : { ...before, [runId]: tab });

  /** A collapsed run's attention count opens it on Tasks and puts focus on
   *  the first thing owed: the decision, the plan, or the stuck task. */
  const showAttention = (run: OrchestrationRun) => {
    setSelectedId(run.id);
    setCreating(false);
    setRunTab(run.id, "tasks");
    setDisclosures((before) => before.expanded.has(run.id) ? before : toggleRunDisclosure(before, run.id));
    setAttentionFocus({ runId: run.id, nonce: Date.now() });
  };

  const mainKey = scopedRuns.length ? mainChatTarget(runs, selectedId, coordinatorKey) : null;
  const openMain = () => {
    if (!mainKey) return;
    try { onOpenChat(mainKey); } catch (problem) { setError(messageOf(problem)); }
  };
  const toolbar = embedded && (mainKey || archivedRuns.length > 0) ? <div className="orch-toolbar" role="toolbar" aria-label="Run panel">
    {mainKey && <button type="button" className="orch-tool" onClick={openMain}
      aria-current={currentChatKey === mainKey ? "page" : undefined}
      aria-label={`Main agent chat${pendingApprovals ? `, ${pendingApprovals} ${pendingApprovals === 1 ? "approval" : "approvals"} waiting` : ""}`}
      title="Open the main agent's chat for this run">
      <ChatIcon /><span>Main agent chat</span>
      {pendingApprovals > 0 && <span className="orch-tool-count" aria-hidden="true">{pendingApprovals}</span>}
    </button>}
    {archivedRuns.length > 0 && <button type="button" className="orch-tool is-quiet" aria-pressed={showArchived}
      title={showArchived ? "Back to the runs in progress" : "Show archived runs; they can be restored"}
      onClick={() => { setShowArchived(!showArchived); setSelectedId(null); setConfirmStop(null); setRunError(null); }}>
      <ArchiveIcon /><span>Archived</span><span className="orch-tool-count is-quiet">{archivedRuns.length}</span>
    </button>}
  </div> : null;

  const newRunButton = allowManualRun ? (
    <button
      className={`orch-new${creating ? " is-on" : ""}`}
      type="button"
      disabled={readOnly || busy || (embedded && runs.some(isActiveRun))}
      title={embedded && runs.some(isActiveRun) ? "Finish or stop the active run first" : undefined}
      onClick={() => { setCreating(true); setConfirmStop(null); setShowArchived(false); }}
    >
      <PlusIcon />
      {embedded ? "New run" : "Start a run"}
    </button>
  ) : null;

  const showNav = !accordionMode && (!embedded || runs.length > 1 || (creating && runs.length > 0) || (allowManualRun && runs.length > 0));

  const runDetail = (run: OrchestrationRun) => {
    const runTasks = snapshot.tasks.filter((task) => task.runId === run.id);
    const runAttempts = snapshot.attempts.filter((attempt) => attempt.runId === run.id);
    const runGates = snapshot.gates.filter((gate) => gate.runId === run.id);
    const runMessages = snapshot.messages.filter((message) => message.runId === run.id);
    return <RunDetail
      key={run.id}
      run={run}
      snapshot={snapshot}
      tasks={runTasks}
      attempts={runAttempts}
      gates={runGates}
      messages={runMessages}
      notifications={(snapshot.notifications ?? []).filter((notification) => notification.runId === run.id)}
      answers={answers}
      busy={busy}
      readOnly={readOnly}
      confirmStop={confirmStop === run.id}
      runError={runError?.runId === run.id ? runError.text : null}
      tab={runTabs[run.id] ?? "tasks"}
      onTab={(tab) => setRunTab(run.id, tab)}
      attentionFocus={attentionFocus?.runId === run.id ? attentionFocus.nonce : 0}
      inAccordion={accordionMode}
      onShowAttention={() => showAttention(run)}
      onArchive={(archived) => void archiveRun(run, archived)}
      onAnswer={(gateId, answer) => setAnswers((current) => ({ ...current, [gateId]: answer }))}
      onResolve={(gate, answer) => void resolveGate(run, gate, answer)}
      onRetry={(task, attempt) => void retryTask(run, task, attempt)}
      onWorkspaceAction={(command, args) => void workspaceAction(run, command, args)}
      onOpenChat={onOpenChat}
      currentChatKey={currentChatKey}
      onOpenBeside={onOpenBeside ? (chatKey) => {
        try { onOpenBeside(chatKey); } catch (problem) { setError(messageOf(problem)); }
      } : undefined}
      besideChatKey={besideChatKey}
      coordinatorBusy={coordinatorBusy}
      sharedHeading={sharedHeading || accordionMode}
      compactControls={!allowManualRun}
      projectName={projectName ?? ((id) => (id === project?.id ? project.name : undefined))}
      onPlanApproved={() => void read()}
      onRequestPlanChanges={(note) => {
        onOpenChat(run.coordinatorChatKey,
          `Before I approve the plan for run ${run.id}, change this:\n\n${note}\n\nRevise the tasks through the orchestration tools and ask for approval again.`);
        onClose();
      }}
      onAskStop={() => { setConfirmStop(run.id); setRunError(null); }}
      onCancelStop={() => setConfirmStop(null)}
      onStop={(archive) => void stop(run, archive)}
      onStartMaster={onStartMaster ? async () => {
        setBusy(true); setError(null);
        try { await onStartMaster(run); }
        catch (problem) { setError(messageOf(problem)); }
        finally { setBusy(false); }
      } : undefined}
    />;
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
          {/* One run needs no picker — and inside a chat that is the normal
              case, where the strip was costing a row above the fold. */}
          {showNav && <nav className="orch-runs" aria-label="Orchestration runs">
            {newRunButton}
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
                    // A different run starts on its Tasks tab.
                    onClick={() => { setSelectedId(run.id); setCreating(false); setConfirmStop(null); setRunError(null); setRunTabs({}); }}
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
            {toolbar}
            {!embedded && <p className="orch-runs-note">The host owns task state. Agents report into it.</p>}
          </nav>}
          {/* Outside every run's disclosure and outside the scroller, so the
              way to the main chat is there with every run collapsed. */}
          {!showNav && toolbar}

          <div className="orch-content">
            {shownError && <div className="orch-error" role="alert">{shownError}</div>}
            {readOnly && <p className="orch-empty">This agent chat is read-only. Send instructions and decisions in the main chat.</p>}
            {accordionMode ? (
              runs.length ? <div className="orch-run-accordions" aria-label={showArchived ? "Archived goals" : "Goals"}>
                {runs.map((run) => {
                  const runTasks = snapshot.tasks.filter((task) => task.runId === run.id);
                  const runAttempts = snapshot.attempts.filter((attempt) => attempt.runId === run.id);
                  const attention = runAttention(run, runTasks, runAttempts, snapshot.gates);
                  const planPending = run.planApproval?.status === "pending" && ACTIVE_RUNS.has(run.status);
                  const expanded = disclosures.expanded.has(run.id);
                  const bodyId = `orch-goal-${run.id}`;
                  return <section className={`orch-run-accordion${expanded ? " is-open" : ""}`} key={run.id}>
                    <div className="orch-run-accordion-head">
                      <button type="button" className="orch-run-accordion-toggle" aria-expanded={expanded} aria-controls={bodyId}
                        onClick={() => {
                          setSelectedId(run.id);
                          setConfirmStop(null);
                          setDisclosures((before) => toggleRunDisclosure(before, run.id));
                        }}>
                        <ChevronIcon open={expanded} />
                        <StatusMark status={run.status} />
                        <span className="orch-run-accordion-copy">
                          <strong>{run.objective}</strong>
                          <RunLine snapshot={snapshot} run={run} tasks={runTasks} attempts={runAttempts} />
                          <RunPeople run={run} tasks={runTasks} attempts={runAttempts} gates={snapshot.gates} />
                        </span>
                      </button>
                      {run.archivedAt != null
                        ? !readOnly && <button type="button" className="orch-run-restore" disabled={busy}
                          onClick={() => void archiveRun(run, false)}>Restore</button>
                        : <AttentionButton attention={attention} planPending={planPending} onShow={() => showAttention(run)} />}
                    </div>
                    <div className="orch-run-accordion-body" id={bodyId} hidden={!expanded}>
                      {expanded && runDetail(run)}
                    </div>
                  </section>;
                })}
              </div> : <div className="orch-empty">No goals in this chat yet. Keep talking to the CTO to start work.</div>
            ) : creating && !readOnly ? (
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
                busy={busy}
                onObjective={setObjective}
                onConcurrency={setMaxConcurrent}
                onStart={() => void startRun()}
              />
            ) : selected ? (
              runDetail(selected)
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
  workspaceMode, onWorkspaceMode, automatic, onAutomatic,
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
      </div>
      <p>The main agent chooses a suitable worker and reasoning effort for each task. Fable and Astra are reserved for orchestration.</p>
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

/** The run screen is read at a glance or not at all, so nothing in its default
 *  state is a paragraph. Every task is one row of labels, numbers and a bar;
 *  the prose a worker was handed — its brief, its summaries, its paths — is
 *  real and kept, but it opens on request rather than filling the screen. */
type TaskFilter = "all" | "working" | "blocked" | "done";

const TASK_FILTERS: { key: TaskFilter; label: string; match: (task: OrchestrationTask, attempt?: OrchestrationAttempt) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "working", label: "Working", match: (task, attempt) => task.status === "running" && (!attempt?.execution || attemptIsExecuting(attempt)) },
  { key: "blocked", label: "Blocked", match: (task, attempt) => task.status === "blocked" || task.status === "failed" || executionNeedsAttention(attempt) },
  { key: "done", label: "Done", match: (task) => task.status === "completed" },
];

/** A filter row over four tasks hides nothing and costs a line, so it only
 *  appears once the list is long enough to need one. */
const FILTERS_WORTH_SHOWING = 4;

const TAB_LABELS: Record<RunTab, string> = { tasks: "Tasks", notifications: "Notifications", log: "Coordination log" };

/** How much of each history the tabs keep on screen. The ledger keeps more
 *  for a live run and prunes a finished one to its latest six messages. */
const NOTIFICATIONS_SHOWN = 20;
const MESSAGES_SHOWN = 20;

function RunDetail({
  run,
  snapshot,
  tasks,
  attempts,
  gates,
  messages,
  notifications,
  answers,
  busy,
  readOnly,
  confirmStop,
  runError,
  tab,
  onTab,
  attentionFocus,
  inAccordion,
  onShowAttention,
  onArchive,
  onAnswer,
  onResolve,
  onRetry,
  onWorkspaceAction,
  onOpenChat,
  currentChatKey,
  onOpenBeside,
  besideChatKey,
  onAskStop,
  onCancelStop,
  onStop,
  onStartMaster,
  coordinatorBusy,
  projectName,
  onPlanApproved,
  onRequestPlanChanges,
  sharedHeading,
  compactControls,
}: {
  run: OrchestrationRun;
  snapshot: OrchestrationSnapshot;
  tasks: OrchestrationTask[];
  attempts: OrchestrationAttempt[];
  gates: OrchestrationGate[];
  messages: OrchestrationMessage[];
  notifications: OrchestrationNotification[];
  answers: Record<string, string>;
  busy: boolean;
  readOnly: boolean;
  confirmStop: boolean;
  runError: string | null;
  tab: RunTab;
  onTab: (tab: RunTab) => void;
  /** Changes each time the person asks to be shown what this run owes. */
  attentionFocus: number;
  /** The goal's own header already carries its line and attention count. */
  inAccordion: boolean;
  onShowAttention: () => void;
  onArchive: (archived: boolean) => void;
  onAnswer: (gateId: string, answer: string) => void;
  onResolve: (gate: OrchestrationGate, answer: string) => void;
  onRetry: (task: OrchestrationTask, attempt: OrchestrationAttempt) => void;
  onWorkspaceAction: (command: string, args: Record<string, unknown>) => void;
  onOpenChat: (chatKey: string) => void;
  currentChatKey: string | null;
  onOpenBeside?: (chatKey: string) => void;
  besideChatKey?: string | null;
  onAskStop: () => void;
  onCancelStop: () => void;
  onStop: (archive: boolean) => void;
  onStartMaster?: () => Promise<void>;
  coordinatorBusy: boolean;
  projectName?: (id: string) => string | undefined;
  onPlanApproved: () => void;
  onRequestPlanChanges: (note: string) => void;
  sharedHeading: boolean;
  compactControls: boolean;
}) {
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const settingsId = useId();
  const tabsId = useId();
  const detailRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Partial<Record<RunTab, HTMLButtonElement | null>>>({});
  const archived = run.archivedAt != null;
  // Plan mode: until the person approves, the plan IS the run.
  const planPending = !readOnly && run.planApproval?.status === "pending" && ACTIVE_RUNS.has(run.status);
  const now = useElapsedTick(runIsLive(snapshot, run.id));
  const openGates = gates.filter((gate) => gate.status === "open");
  const gateBlockedTasks = new Set(openGates.flatMap((gate) => gate.taskId ? [gate.taskId] : []));
  const attention = runAttention(run, tasks, attempts, gates);
  const taskNames = new Map(tasks.map((task) => [task.id, task.title]));
  const archiveSnapshot = { runs: [run], tasks, attempts, gates, messages };
  const archivable = attempts.filter((attempt) => attempt.archivedAt == null && !workerArchiveDisabledReason(archiveSnapshot, attempt));
  const archiveControl = (attempt: OrchestrationAttempt) => {
    if (readOnly) return null;
    const archivedWorker = attempt.archivedAt != null;
    const reason = archivedWorker ? null : workerArchiveDisabledReason(archiveSnapshot, attempt);
    return <button type="button" disabled={busy || !!reason}
      title={reason ?? (archivedWorker ? "Return this worker to the chat list." : "Hide this worker; its chat and task history are kept.")}
      onClick={() => onWorkspaceAction("orchestration_worker_archive", { attemptId: attempt.id, archived: !archivedWorker })}>
      {archivedWorker ? "Restore worker" : "Archive worker"}
    </button>;
  };
  const active = TASK_FILTERS.find((option) => option.key === filter) ?? TASK_FILTERS[0];
  const visible = sortTasksByActivity(
    tasks.filter((task) => active.match(task, attempts.find((attempt) => attempt.id === task.activeAttemptId))),
    attempts,
  );
  const awaitingReceipt = notifications.filter((item) => item.state === "pending" || item.state === "delivering").length;

  // Asked to show what is owed: every task, and focus on the first owed thing
  // — a decision, the plan, or a stuck row — so a keyboard lands on it too.
  useEffect(() => {
    if (!attentionFocus) return;
    setFilter("all");
    const frame = requestAnimationFrame(() => {
      const target = detailRef.current?.querySelector<HTMLElement>("[data-attention]");
      target?.scrollIntoView?.({ block: "nearest" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [attentionFocus]);

  // Opening Stop puts focus on its safe answer; Escape is Cancel.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmStop) { setSettingsOpen(true); requestAnimationFrame(() => cancelRef.current?.focus()); }
  }, [confirmStop]);

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextRunTab(tab, event.key);
    if (!next) return;
    event.preventDefault();
    onTab(next);
    tabRefs.current[next]?.focus();
  };

  const tabCount: Record<RunTab, ReactNode> = {
    tasks: tasks.length ? <span className="orch-tab-count">{tasks.length}</span> : null,
    notifications: notifications.length ? <span className="orch-tab-count" data-tone={awaitingReceipt ? "pending" : undefined}>{notifications.length}</span> : null,
    log: messages.length ? <span className="orch-tab-count">{messages.length}</span> : null,
  };
  const tabLabel: Record<RunTab, string> = {
    tasks: `Tasks, ${tasks.length}`,
    notifications: `Notifications, ${notifications.length}${awaitingReceipt ? `, ${awaitingReceipt} awaiting receipt` : ""}`,
    log: `Coordination log, ${messages.length} ${messages.length === 1 ? "message" : "messages"}`,
  };

  const settingsToggle = <button type="button" className={`orch-settings-toggle${compactControls ? " is-compact" : ""}`} aria-expanded={settingsOpen} aria-controls={settingsId}
    aria-label={compactControls ? "Run options" : "Run settings"} title={settingsOpen ? "Hide run options" : "Run options and controls"}
    onClick={() => { if (settingsOpen) onCancelStop(); setSettingsOpen(!settingsOpen); setConfirmArchive(false); }}>
    {compactControls ? <MoreIcon /> : <SettingsIcon />}{!compactControls && <span>Settings</span>}
  </button>;

  return (
    <section ref={detailRef} className="orch-run-detail" aria-label={sharedHeading ? run.objective : undefined} aria-labelledby={sharedHeading ? undefined : "orch-run-title"}>
      {!sharedHeading && <header className="orch-run-head">
        <div className="orch-status-line"><StatusMark status={run.status} />{statusLabel(run.status)}</div>
        <h2 id="orch-run-title">{run.objective}</h2>
      </header>}

      {/* Without a goal header, the run's one line of state lives here. */}
      {!inAccordion && <div className="orch-summary">
        <RunLine snapshot={snapshot} run={run} tasks={tasks} attempts={attempts} />
        {archived
          ? !readOnly && <button type="button" className="orch-run-restore" disabled={busy} onClick={() => onArchive(false)}>Restore</button>
          : <AttentionButton attention={attention} planPending={planPending} onShow={onShowAttention} />}
      </div>}

      {/* Owed to the person, so above every tab: switching tabs never hides a
          decision or a plan waiting for approval. */}
      {planPending && (
        <div className="orch-attention-target" data-attention tabIndex={-1}>
          <PlanReview run={run} tasks={tasks} drafting={coordinatorBusy} projectName={projectName} onApproved={onPlanApproved} onRequestChanges={onRequestPlanChanges} />
        </div>
      )}

      {openGates.length > 0 && (
        <section className="orch-decisions" aria-labelledby={`${tabsId}-decisions`} data-attention tabIndex={-1}>
          <h3 id={`${tabsId}-decisions`}>Needs you</h3>
          {openGates.map((gate) => (
            <article className="orch-gate" key={gate.id}>
              <p className="orch-gate-task" title={gate.taskId ? taskNames.get(gate.taskId) : undefined}>{gate.taskId ? taskNames.get(gate.taskId) ?? "This task" : "This run"}</p>
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

      <div className="orch-tabs-row">
        <div className="orch-tabs" role="tablist" aria-label="Run details" onKeyDown={onTabKey}>
          {RUN_TABS.map((key) => <button key={key} type="button" role="tab" id={`${tabsId}-${key}`}
            ref={(node) => { tabRefs.current[key] = node; }}
            aria-selected={tab === key} aria-controls={`${tabsId}-${key}-panel`} tabIndex={tab === key ? 0 : -1}
            aria-label={tabLabel[key]} onClick={() => onTab(key)}>
            <span>{key === "log" ? <><span className="orch-tab-long">Coordination log</span><span className="orch-tab-short" aria-hidden="true">Log</span></> : TAB_LABELS[key]}</span>
            {tabCount[key]}
          </button>)}
        </div>
        {settingsToggle}
      </div>

      <div className={`orch-run-settings${compactControls ? " is-compact" : ""}`} id={settingsId} role="region" aria-label={compactControls ? "Run options" : "Run settings"} hidden={!settingsOpen}>
        <div className="orch-run-settings-body">
          {!compactControls && <dl>
            <dt>Folder</dt><dd title={run.rootPath}>{shortWorkspacePath(run.rootPath)}</dd>
            <dt>Workspace</dt><dd>{WORKSPACE_MODES.find((mode) => mode.value === (run.workspaceMode ?? "auto"))?.label}</dd>
            <dt>Dispatch</dt><dd>{run.workerDefaults ? "Automatic" : "Coordinator"}</dd>
            <dt>Workers</dt><dd>{run.workerDefaults?.agent ? `Chosen per task · ${AGENT_NAME[run.workerDefaults.agent]} fallback` : "Chosen per task by the main agent"}</dd>
            <dt>Worker limit</dt><dd>{run.maxConcurrent}</dd>
            <dt>Acceptance</dt><dd title={ACCEPTANCE_NOTE}>Unverified</dd>
          </dl>}
          <div className="orch-run-actions">
            {onStartMaster && !readOnly && ACTIVE_RUNS.has(run.status) && !confirmStop && <button className="orch-quiet" type="button" disabled={busy} onClick={() => void onStartMaster()}>Continue main agent</button>}
            {!readOnly && run.status === "completed" && archivable.length > 0 && !confirmStop && <button className="orch-quiet" type="button" disabled={busy}
              title="Hide merged workers from the chat list. Chats, reports, and workspaces are kept."
              onClick={() => onWorkspaceAction("orchestration_workers_archive_merged", { runId: run.id })}>Archive all merged workers ({archivable.length})</button>}
            {!readOnly && !run.workerDefaults && ACTIVE_RUNS.has(run.status) && !confirmStop && <button className="orch-quiet" type="button" disabled={busy}
              onClick={() => onWorkspaceAction("orchestration_automation_configure", { runId: run.id,
                workerDefaults: { access: "auto" } })}>Enable automatic dispatch</button>}
            {!readOnly && ACTIVE_RUNS.has(run.status) && (
              confirmStop ? (
                <div className="orch-stop-confirm" role="group" aria-labelledby={`${tabsId}-stop`}
                  onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onCancelStop(); } }}>
                  <p id={`${tabsId}-stop`}>Stop this run? Workers stop and open tasks are cancelled. Archiving also hides it; its history and worktrees are kept.</p>
                  <button ref={cancelRef} type="button" disabled={busy} onClick={onCancelStop}>Cancel</button>
                  <button className="is-danger" type="button" disabled={busy} onClick={() => onStop(false)}>Stop</button>
                  <button className="is-danger" type="button" disabled={busy} onClick={() => onStop(true)}>Stop and archive</button>
                </div>
              ) : (
                <button className="orch-quiet" type="button" disabled={busy} onClick={onAskStop}>Stop</button>
              )
            )}
            {!readOnly && !archived && !ACTIVE_RUNS.has(run.status) && (
              confirmArchive ? (
                <div className="orch-stop-confirm" role="group" aria-labelledby={`${tabsId}-archive`}
                  onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setConfirmArchive(false); } }}>
                  <p id={`${tabsId}-archive`}>Archive this run? It leaves the list; its history and worktrees are kept, and it can be restored.</p>
                  <button type="button" disabled={busy} autoFocus onClick={() => setConfirmArchive(false)}>Cancel</button>
                  <button type="button" disabled={busy} onClick={() => { setConfirmArchive(false); onArchive(true); }}>Archive</button>
                </div>
              ) : (
                <button className="orch-quiet" type="button" disabled={busy} onClick={() => setConfirmArchive(true)}>Archive run</button>
              )
            )}
            {!readOnly && archived && <button className="orch-quiet" type="button" disabled={busy} onClick={() => onArchive(false)}>Restore run</button>}
          </div>
          {runError && <p className="orch-run-error" role="alert">{runError}</p>}
        </div>
      </div>
      {/* A failure after the options were put away still has to be seen. */}
      {runError && !settingsOpen && <p className="orch-run-error" role="alert">{runError}</p>}

      <div className="orch-tab-panel" role="tabpanel" id={`${tabsId}-tasks-panel`} aria-labelledby={`${tabsId}-tasks`} hidden={tab !== "tasks"}>
        {tasks.length > FILTERS_WORTH_SHOWING && !planPending && <div className="orch-task-filters" role="group" aria-label="Filter tasks">
          {TASK_FILTERS.map((option) => <button key={option.key} type="button" className={option.key === filter ? "is-on" : ""}
            aria-pressed={option.key === filter} onClick={() => setFilter(option.key)}>{option.label}</button>)}
        </div>}
        {planPending ? (
          <p className="orch-task-none">The tasks start once the plan above is approved.</p>
        ) : tasks.length === 0 ? (
          <div className="orch-planning"><span className="orch-pulse" />The main agent is planning the tasks.</div>
        ) : visible.length === 0 ? (
          <p className="orch-task-none">Nothing is {active.label.toLowerCase()} right now.</p>
        ) : visible.map((task) => (
          <RunTask key={task.id} run={run} snapshot={snapshot} task={task} attempts={attempts} gates={gates}
            taskNames={taskNames} gateBlockedTasks={gateBlockedTasks} now={now} busy={busy} readOnly={readOnly}
            archiveControl={archiveControl} onOpenChat={onOpenChat} onRetry={onRetry} onWorkspaceAction={onWorkspaceAction}
            onOpenBeside={onOpenBeside}
            open={!!currentChatKey && attempts.some((attempt) => attempt.taskId === task.id && attempt.workerChatKey === currentChatKey)}
            beside={!!besideChatKey && attempts.some((attempt) => attempt.taskId === task.id && attempt.workerChatKey === besideChatKey)}
            projectName={projectName} />
        ))}
      </div>

      <div className="orch-tab-panel orch-notifications" role="tabpanel" id={`${tabsId}-notifications-panel`} aria-labelledby={`${tabsId}-notifications`} hidden={tab !== "notifications"}>
        {notifications.length === 0 ? <p className="orch-task-none">No notifications for this run.</p> : <>
          <p>{awaitingReceipt} awaiting receipt. Delivery waits while the main agent is busy or user messages are queued. Receipt confirms delivery, not completion of the requested action.</p>
          {[...notifications].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, NOTIFICATIONS_SHOWN).map((item) => <article key={item.id}>
            <strong>{item.kind === "progress" ? "Progress update" : item.kind === "decision" ? "Decision needed" : item.kind === "report" ? "Worker report" : item.kind === "resolution" ? "Decision reply" : item.kind === "capacity" ? "Capacity error" : item.kind === "disconnected" ? "Worker disconnected" : item.kind === "stalled" ? "Worker stalled" : item.kind === "provider" ? "Provider error" : "Agent message"}</strong>
            <span>{({ pending: "Queued", delivering: "Awaiting receipt", acknowledged: "Received by agent", cancelled: "No longer needed" })[item.state]}</span>
            {["capacity", "provider", "disconnected", "stalled"].includes(item.kind) && <p>{item.body}</p>}
            {item.coalesced > 0 && <small>{item.coalesced + 1} updates combined</small>}
            {item.lastError && (item.state === "pending" || item.state === "delivering") && <p className="orch-workspace-warning">{item.lastError} Delivery will retry automatically.</p>}
          </article>)}
        </>}
      </div>

      <div className="orch-tab-panel orch-messages" role="tabpanel" id={`${tabsId}-log-panel`} aria-labelledby={`${tabsId}-log`} hidden={tab !== "log"}>
        {messages.length === 0 ? <p className="orch-task-none">No coordination messages yet.</p>
          : messages.slice(-MESSAGES_SHOWN).reverse().map((message) => (
            <article key={message.id}>
              <div><strong>{message.subject}</strong><span>{message.kind} · {timeLabel(message.createdAt)}</span></div>
              <p>{message.body}</p>
            </article>
          ))}
      </div>
    </section>
  );
}

/** The whole run in one line: done of total, its state, what is still owed
 *  besides a decision, and how long. A count of zero is left out rather than
 *  printed — four tiles reading 0 is how the old screen managed to fill a
 *  phone while saying nothing. Nothing here is a percentage: done of total is
 *  what the ledger knows. */
function RunLine({ snapshot, run, tasks, attempts }: {
  snapshot: OrchestrationSnapshot;
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
  attempts: OrchestrationAttempt[];
}) {
  const now = useElapsedTick(runIsLive(snapshot, run.id));
  const counts = boardCounts(tasks, snapshot);
  const working = attempts.filter(attemptIsExecuting).length;
  const elapsed = runElapsed(snapshot, run.id, now);
  const settled = counts.total > 0 && counts.done === counts.total;
  const parts = [
    `${counts.done}/${counts.total} tasks`,
    run.archivedAt != null ? `${statusLabel(run.status)} · archived` : statusLabel(run.status),
    working > 0 ? `${working} of ${run.maxConcurrent} working` : null,
    counts.todo > 0 ? `${counts.todo} queued` : null,
    counts.cancelled > 0 ? `${counts.cancelled} cancelled` : null,
  ].filter(Boolean);
  return <small className="orch-run-line">
    <span>{parts.join(" · ")}</span>
    {elapsed !== null && <span className="orch-run-elapsed" title="Wall time from the first dispatch to the latest settlement. Overlapping workers are counted once."><ClockIcon />{elapsedLabel(elapsed)}</span>}
    {/* Every task done reads as "finished", which is exactly when it needs
        saying that nothing checked the outcome. */}
    {settled && <span className="orch-progress-acceptance" title={ACCEPTANCE_NOTE}>Acceptance: unverified</span>}
  </small>;
}

const PERSON_LABEL: Record<PersonState, string> = {
  working: "working", blocked: "blocked", assigned: "assigned", done: "done", stopped: "stopped",
};
/** Chips shown before "+N"; a phone shows one fewer (see the CSS). */
const PEOPLE_SHOWN = 3;

/** Who a goal is with, readable collapsed: face and name, and what each is
 *  doing — so "handed a task" never reads as "working". Names are text, not
 *  tooltips. The full list is spoken once; the chips are its picture. */
function RunPeople({ run, tasks, attempts, gates }: {
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
  attempts: OrchestrationAttempt[];
  gates: OrchestrationGate[];
}) {
  const roster = useContext(AgentRosterContext);
  const people = runPeople(run, tasks, attempts, gates, roster);
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
function AttentionButton({ attention, planPending, onShow }: { attention: RunAttention; planPending: boolean; onShow: () => void }) {
  const label = attentionLabel(attention, planPending);
  if (!label) return null;
  const parts = [
    attention.decisions ? `${attention.decisions} ${attention.decisions === 1 ? "decision" : "decisions"} waiting` : null,
    attention.blocked ? `${attention.blocked} ${attention.blocked === 1 ? "task needs" : "tasks need"} attention` : null,
  ].filter(Boolean).join(", ");
  return <button type="button" className="orch-attention" data-tone={attention.decisions ? "decision" : "blocked"}
    aria-label={`${parts}. Show`} title={`${parts}. Show`} onClick={onShow}>
    <AlertIcon />{label}
  </button>;
}

const ACCEPTANCE_NOTE = "OctiqFlow does not yet track acceptance results. Review the test evidence separately.";

/** The row opens the worker chat; the separate disclosure shows its checklist. */
function RunTask({ run, snapshot, task, attempts, gates, taskNames, gateBlockedTasks, now, busy, readOnly, archiveControl, onOpenChat, onOpenBeside, onRetry, onWorkspaceAction, open, beside = false, projectName }: {
  projectName?: (id: string) => string | undefined;
  onOpenBeside?: (chatKey: string) => void;
  /** This task's chat is open beside the main chat. */
  beside?: boolean;
  run: OrchestrationRun;
  snapshot: OrchestrationSnapshot;
  task: OrchestrationTask;
  attempts: OrchestrationAttempt[];
  gates: OrchestrationGate[];
  taskNames: Map<string, string>;
  gateBlockedTasks: Set<string>;
  now: number;
  busy: boolean;
  readOnly: boolean;
  archiveControl: (attempt: OrchestrationAttempt) => ReactNode;
  onOpenChat: (chatKey: string) => void;
  onRetry: (task: OrchestrationTask, attempt: OrchestrationAttempt) => void;
  onWorkspaceAction: (command: string, args: Record<string, unknown>) => void;
  open: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const assigneeFace = useRosterAgent(task.assignee?.id);
  const mine = attempts.filter((candidate) => candidate.taskId === task.id).sort((a, b) => b.number - a.number);
  const attempt = attempts.find((candidate) => candidate.id === task.activeAttemptId) ?? mine[0];
  const history = mine.filter((candidate) => candidate.id !== attempt?.id);
  const report = attempt ? snapshot.reports?.[attempt.workerChatKey] : undefined;
  const progress = taskProgress(task, report);
  const stage = !attempt?.execution && attempt?.status === "preparing" ? "Preparing workspace" : taskStage(task, report, attempt);
  // A task that has reported nothing has `taskStage` fall back to its own
  // status word, which line one already carries. Saying "Blocked · Blocked"
  // is how a row starts looking busy while telling you less.
  const reportedStage = attempt?.execution || stage === TASK_LABELS[task.status] ? null : stage;
  const elapsed = taskElapsed(snapshot, task, now);
  const branch = task.workspace?.plan.branch || attempt?.branch;
  const gate = gates.find((item) => item.taskId === task.id && item.status === "open");
  const reviewReady = task.status === "ready" && attempt?.status === "completed";
  const retryable = !!attempt
    && ["blocked", "failed"].includes(task.status)
    && ["blocked", "failed"].includes(attempt.status)
    && !gateBlockedTasks.has(task.id);
  // What the run's attention count pointed at; a decision names its own task.
  const owed = !gateBlockedTasks.has(task.id)
    && (task.status === "blocked" || task.status === "failed" || executionNeedsAttention(attempt));

  return (
    <article className={`orch-task is-${task.status}${open || beside ? " is-open" : ""}`} data-status={task.status}>
      <div className="orch-task-heading">
        <button type="button" className="orch-task-summary" disabled={!attempt} data-attention={owed || undefined}
          aria-current={open || beside ? "page" : undefined}
          aria-label={`Open task chat: ${task.title}`}
          title={attempt ? `Open task chat: ${task.title}` : "No worker chat yet"}
          onClick={() => attempt && onOpenChat(attempt.workerChatKey)}>
          <span className="orch-task-glyph" aria-hidden="true"><TaskStatusIcon status={task.status} /></span>
          <span className="orch-task-title">{task.title}</span>
          <span className="orch-task-state">{attempt?.execution && task.activeAttemptId === attempt.id ? EXECUTION_LABELS[attempt.execution.state] : TASK_LABELS[task.status]}{elapsed !== null ? ` · ${elapsedLabel(elapsed)}` : ""}</span>
          <span className="orch-task-meta">
            {snapshot.services?.some((service) => service.taskId === task.id && service.state !== "listening") && <span className="orch-task-blocker">Service needs attention</span>}
            {progress.percent !== null && <span className="orch-task-track" aria-hidden="true"><span style={{ width: `${progress.percent}%` }} /></span>}
            {reportedStage && <span className="orch-task-stage" title={reportedStage}>{reportedStage}</span>}
            {attempt && <span className="orch-task-agent" title={`${task.assignee ? `${assigneeFace?.name ?? task.assignee.name} · ` : ""}${AGENT_NAME[attempt.agent]} · attempt ${attempt.number}`}>{task.assignee
              ? <AgentAvatar name={assigneeFace?.name ?? task.assignee.name} avatar={assigneeFace?.avatar} id={task.assignee.id} size={14} decorative />
              : <AgentLogo agent={attempt.agent} size={10} />}</span>}
            {branch && <span className="orch-task-branch" title={branch}><BranchIcon />{shortBranch(branch)}</span>}
          </span>
        </button>
        {/* Only where it would change something: not for the task already
            beside main, and not for the one open full-width, whose own header
            carries the same button. */}
        {attempt && onOpenBeside && !open && !beside && <OpenBesideButton className="orch-task-beside" title={task.title}
          onClick={() => onOpenBeside(attempt.workerChatKey)} />}
        <button type="button" className="orch-task-expand" aria-expanded={expanded} aria-controls={detailId}
          aria-label={`${expanded ? "Collapse" : "Expand"} task progress: ${task.title}`}
          title={expanded ? "Collapse task progress" : "Expand task progress"}
          onClick={() => setExpanded(!expanded)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={expanded ? "m6 15 6-6 6 6" : "m9 6 6 6-6 6"} /></svg>
        </button>
      </div>
      <div className="orch-task-detail" id={detailId} hidden={!expanded}>
        {/* The standard plan card: where it runs (planned until the host
            prepares it), who owns it on which model, and what done means. */}
        <TaskPlanCard task={task} run={run} attempt={attempt} projectName={projectName} />
        {report?.steps.length ? <ol className="orch-task-steps" aria-label="Reported checklist">
          {report.steps.map((step, index) => <li key={index} data-state={step.state}>
            <span aria-label={step.state}>{step.state === "done" ? "✓" : step.state === "active" ? "◉" : "○"}</span>{step.title}
          </li>)}
        </ol> : null}
        {report && <p className="orch-task-reported">
          {progress.total ? `${progress.done} of ${progress.total} steps done` : "No checklist reported"} · reported {agoLabel(report.reportedAt, now)}
        </p>}
        {!report && <p className="orch-task-reported">No checklist reported</p>}
        <details className="orch-task-more">
          <summary>Task details</summary>
          <TaskLifecycleEvidence snapshot={snapshot} taskId={task.id} now={now} />
          {attempt?.execution && <><p>Task: {TASK_LABELS[task.status]}</p><WorkerExecutionEvidence execution={attempt.execution} /></>}
          {gate && <p className="orch-task-blocker">Waiting on a decision: {gate.question}</p>}
          {task.dependsOn.length > 0 && <p className="orch-task-after">After {task.dependsOn.map((id) => taskNames.get(id) ?? id).join(", ")}</p>}
          {attempt && (
            <div className="orch-attempt">
              <button type="button" onClick={() => onOpenChat(attempt.workerChatKey)}>
                {attempt.agent} worker #{attempt.number}
              </button>
              {attempt.archivedAt != null && <span>Archived</span>}
              {archiveControl(attempt)}
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
              {previous.archivedAt != null && <span>Archived</span>}
              {archiveControl(previous)}
              {previous.summary && <p>{previous.summary}</p>}
            </div>)}
          </details>}
          {task.workspace && <WorkspaceDelivery task={task} busy={busy} readOnly={readOnly} stopped={run.status === "stopped"}
            active={!!attempt && (["preparing", "running"].includes(attempt.status) || gateBlockedTasks.has(task.id))}
            onAction={onWorkspaceAction} />}
          {!attempt && task.result && <p className="orch-task-result">{task.result}</p>}
          <details className="orch-task-brief">
            <summary>Brief</summary>
            <p>{task.spec}</p>
          </details>
        </details>
      </div>
    </article>
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
  return <details className="orch-workspace" data-tone={deliveryTone(workspace)} aria-label={`Workspace for ${task.title}`}>
    <summary><span>Delivery</span><strong>{workspaceDeliveryLabel(workspace)}</strong></summary>
    <div className="orch-workspace-body">
      <code title={workspace.plan.cwd}>{shortWorkspacePath(workspace.plan.cwd)}</code>
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
    </div>
  </details>;
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

function SettingsIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>;
}

function PlusIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function CloseIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>;
}

function MoreIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>;
}

function ChevronIcon({ open }: { open: boolean }) {
  return <svg className="orch-run-accordion-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={open ? "m6 9 6 6 6-6" : "m9 6 6 6-6 6"} /></svg>;
}

function ChatIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 14a3 3 0 0 1-3 3H9l-5 4V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" /></svg>;
}

function ArchiveIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></svg>;
}

function AlertIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 7v6" /><circle cx="12" cy="17" r=".9" /></svg>;
}

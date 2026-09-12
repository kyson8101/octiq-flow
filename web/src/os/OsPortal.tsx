import { type FormEvent, useCallback, useEffect, useState } from "react";
import { AppearanceToggle } from "../components/AppearanceToggle";

import { bridge, type ConnectionState } from "../lib/bridge";
import "./portal.css";

type OperatingDomain = "company" | "personal" | "novel";
type TaskStage =
  | "captured"
  | "triage"
  | "approved"
  | "running"
  | "verifying"
  | "done"
  | "blocked"
  | "abandoned";
type RunStatus = "queued" | "running" | "verifying" | "completed" | "blocked";
type RunnerProvider = "codex" | "claude";

type MissionTask = {
  id: string;
  title: string;
  detail: string | null;
  domain: OperatingDomain;
  stage: TaskStage;
  priority: "routine" | "important" | "urgent";
  risk: "safe" | "guarded" | "approval";
  nextStep: string;
  workspacePath: string | null;
  updatedAt: string;
};

type MissionPlan = {
  id: string;
  taskId: string;
  taskTitle: string;
  status: string;
  plannerProvider: string;
  plannerModel: string;
  content: string | null;
  requestedAt: string;
  completedAt: string | null;
};

type FlowWorkspace = { id: string; name: string; primary_path: string };

type Approval = {
  id: string;
  taskId: string;
  title: string;
  rationale: string;
  decision: "pending" | "approved" | "declined";
  requestedAt: string;
};

type AgentRun = {
  id: string;
  taskId: string;
  taskTitle: string;
  provider: string;
  model: string;
  status: RunStatus;
  currentStep: string;
  waitingForFounder: boolean;
  startedAt: string;
};

type MissionEvent = {
  id: string;
  taskId: string | null;
  kind: string;
  message: string;
  createdAt: string;
};

type TaskCycle = {
  id: string;
  cycleNumber: number;
  instruction: string | null;
  status: "active" | "completed" | "abandoned";
  openedAt: string;
  closedAt: string | null;
};

type WorkflowProfile = {
  id: string;
  slug: string;
  domain: OperatingDomain;
  label: string;
  intakeSources: string[];
  confirmation: "none" | "plan" | "policy";
  plannerMode: "brainstorm-and-grill" | "clarify-and-draft" | "continuity-and-outline";
  approvalRequirements: string[];
  allowedRunners: string[];
  evidenceRequired: boolean;
  financialMode: "review-only" | null;
  isEnabled: boolean;
  defaultWorkspaceId: string | null;
  defaultWorkspaceName: string | null;
  defaultWorkspacePath: string | null;
  updatedAt: string;
};

type ProfileDraft = Pick<
  WorkflowProfile,
  | "id"
  | "domain"
  | "label"
  | "isEnabled"
  | "intakeSources"
  | "confirmation"
  | "plannerMode"
  | "approvalRequirements"
  | "allowedRunners"
  | "defaultWorkspaceId"
>;

type TaskMessage = {
  id: string;
  actor: "founder" | "agent" | "system";
  kind: "direction" | "question" | "report";
  body: string;
  createdAt: string;
};

type MissionDashboard = {
  tasks: MissionTask[];
  profiles: WorkflowProfile[];
  plans: MissionPlan[];
  approvals: Approval[];
  runs: AgentRun[];
  events: MissionEvent[];
  summary: {
    awaitingDecision: number;
    activeWork: number;
    verifying: number;
    completedToday: number;
  };
};

type FounderReview = {
  generatedAt: string;
  needsResponse: Approval[];
  blocked: MissionTask[];
  verifying: MissionTask[];
  active: MissionTask[];
  completedToday: MissionTask[];
  week: {
    completed: number;
    decisions: number;
    stopped: number;
    signals: MissionEvent[];
  };
};

type TaskDetail = {
  task: MissionTask;
  plans: MissionPlan[];
  approvals: Approval[];
  runs: AgentRun[];
  events: MissionEvent[];
  cycles: TaskCycle[];
  messages: TaskMessage[];
};

type KanbanLane = {
  id: string;
  title: string;
  note: string;
  stages: TaskStage[];
  acceptsCompleted?: boolean;
};

const DOMAIN_COPY: Record<OperatingDomain, { label: string; note: string }> = {
  company: { label: "Company", note: "Projects, tickets, and agent work" },
  personal: { label: "Personal", note: "Private obligations and records" },
  novel: { label: "Novel", note: "Story continuity and writing" },
};

const KANBAN_LANES: KanbanLane[] = [
  { id: "inbox", title: "Inbox", note: "Captured", stages: ["captured"] },
  {
    id: "planning",
    title: "PM planning",
    note: "Plan & decide",
    stages: ["triage", "approved"],
    acceptsCompleted: true,
  },
  { id: "running", title: "In progress", note: "Runner active", stages: ["running"] },
  { id: "verify", title: "Verify", note: "Evidence review", stages: ["verifying"] },
  { id: "done", title: "Done", note: "Ready to reopen", stages: ["done"] },
  { id: "stopped", title: "Stopped", note: "Blocked or abandoned", stages: ["blocked", "abandoned"] },
];

const PROFILE_OPTIONS: Record<
  OperatingDomain,
  { sources: string[]; approvals: string[]; runners: string[] }
> = {
  company: {
    sources: ["manual", "ticket", "feedback"],
    approvals: ["scope", "deployment", "external-write"],
    runners: ["codex", "claude", "deepseek"],
  },
  personal: {
    sources: ["manual", "email", "calendar", "folder-watch"],
    approvals: ["financial-change", "payment", "delete", "nas-write"],
    runners: ["codex", "claude", "local-llm"],
  },
  novel: {
    sources: ["manual", "docspace"],
    approvals: ["canon-change"],
    runners: ["codex", "claude", "deepseek"],
  },
};

const LOCAL_RUNNERS: RunnerProvider[] = ["codex", "claude"];

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function titleCase(value: string): string {
  return value.replace(/(^|[_-])([a-z])/g, (_, prefix: string, letter: string) =>
    `${prefix ? " " : ""}${letter.toUpperCase()}`,
  );
}

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function toggleListValue(values: string[], value: string, checked: boolean): string[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

function profileDraftFrom(profile: WorkflowProfile): ProfileDraft {
  return {
    id: profile.id,
    domain: profile.domain,
    label: profile.label,
    isEnabled: profile.isEnabled,
    intakeSources: profile.intakeSources,
    confirmation: profile.confirmation,
    plannerMode: profile.plannerMode,
    approvalRequirements: profile.approvalRequirements,
    allowedRunners: profile.allowedRunners,
    defaultWorkspaceId: profile.defaultWorkspaceId,
  };
}

function EmptyState({ text }: { text: string }) {
  return <p className="os-empty">{text}</p>;
}

export function OsPortal() {
  const [connection, setConnection] = useState<ConnectionState>(bridge.state);
  const [dashboard, setDashboard] = useState<MissionDashboard | null>(null);
  const [review, setReview] = useState<FounderReview | null>(null);
  const [reviewRefreshing, setReviewRefreshing] = useState(false);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [working, setWorking] = useState(false);
  const [workspaces, setWorkspaces] = useState<FlowWorkspace[]>([]);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [domain, setDomain] = useState<OperatingDomain>("company");
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceSetupOpen, setWorkspaceSetupOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceFolder, setWorkspaceFolder] = useState("");
  const [profileDraft, setProfileDraft] = useState<ProfileDraft | null>(null);
  const [founderDirection, setFounderDirection] = useState("");
  const [runnerChoices, setRunnerChoices] = useState<Record<string, RunnerProvider>>({});
  const [draggedTask, setDraggedTask] = useState<MissionTask | null>(null);
  const [dragOverLane, setDragOverLane] = useState<string | null>(null);
  const [reopenTask, setReopenTask] = useState<MissionTask | null>(null);
  const [reopenInstruction, setReopenInstruction] = useState("");
  const [abandonTask, setAbandonTask] = useState<MissionTask | null>(null);
  const [abandonReason, setAbandonReason] = useState("");
  const [closeoutTask, setCloseoutTask] = useState<MissionTask | null>(null);
  const [closeoutEvidence, setCloseoutEvidence] = useState("");

  const refreshReview = useCallback(async () => {
    setReviewRefreshing(true);
    try {
      setReview(await bridge.invoke<FounderReview>("mission_founder_review"));
    } catch {
      // The board remains useful if a reporting-only read is temporarily
      // unavailable; the normal dashboard error handles store outages.
      setReview(null);
    } finally {
      setReviewRefreshing(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setError(null);
      setDashboard(await bridge.invoke<MissionDashboard>("mission_dashboard"));
      void refreshReview();
    } catch (cause) {
      setError(failureMessage(cause, "OctiqOS could not reach its operational store."));
    } finally {
      setRefreshing(false);
    }
  }, [refreshReview]);

  const inspectTask = useCallback(async (taskId: string) => {
    setSelectedTaskId(taskId);
    setFounderDirection("");
    setDetailLoading(true);
    try {
      setTaskDetail(await bridge.invoke<TaskDetail>("mission_task_detail", { taskId }));
    } catch (cause) {
      setError(failureMessage(cause, "The task history could not be loaded."));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => bridge.onState(setConnection), []);

  useEffect(() => {
    if (connection !== "open") return;
    void refresh();
    void bridge
      .invoke<FlowWorkspace[]>("list_workspaces")
      .then((items) => setWorkspaces(items.filter((item) => Boolean(item.primary_path))))
      .catch(() => setWorkspaces([]));
  }, [connection, refresh]);

  useEffect(() => {
    const hasLiveLoop = Boolean(
      dashboard?.plans.some((plan) => plan.status === "drafting") ||
        dashboard?.runs.some((run) => run.status === "queued" || run.status === "running"),
    );
    if (!hasLiveLoop || connection !== "open") return;
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [connection, dashboard?.plans, dashboard?.runs, refresh]);

  useEffect(() => {
    document.title = "OctiqOS — Mission control";
    return () => {
      document.title = "OctiqFlow";
    };
  }, []);

  const capture = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) return;
    setWorking(true);
    try {
      setDashboard(
        await bridge.invoke<MissionDashboard>("mission_capture_task", {
          title,
          detail,
          domain,
          workspacePath: workspacePath || null,
        }),
      );
      setTitle("");
      setDetail("");
      setIntakeOpen(false);
      setError(null);
      void refreshReview();
    } catch (cause) {
      setError(failureMessage(cause, "The task could not be captured."));
    } finally {
      setWorking(false);
    }
  };

  const requestPlan = async (taskId: string) => {
    setWorking(true);
    try {
      setDashboard(await bridge.invoke<MissionDashboard>("mission_request_plan", { taskId }));
      setError(null);
      void inspectTask(taskId);
      void refreshReview();
    } catch (cause) {
      setError(failureMessage(cause, "The PM agent could not start."));
    } finally {
      setWorking(false);
    }
  };

  const confirmPlan = async (plan: MissionPlan, provider: RunnerProvider) => {
    setWorking(true);
    try {
      setDashboard(
        await bridge.invoke<MissionDashboard>("mission_confirm_plan", {
          taskId: plan.taskId,
          planId: plan.id,
          provider,
        }),
      );
      setError(null);
      void inspectTask(plan.taskId);
      void refreshReview();
    } catch (cause) {
      setError(failureMessage(cause, "The execution runner could not start."));
    } finally {
      setWorking(false);
    }
  };

  const decide = async (approvalId: string, decision: "approved" | "declined") => {
    setWorking(true);
    try {
      setDashboard(
        await bridge.invoke<MissionDashboard>("mission_decide_approval", { approvalId, decision }),
      );
      setError(null);
      void refreshReview();
    } catch (cause) {
      setError(failureMessage(cause, "The decision could not be saved."));
    } finally {
      setWorking(false);
    }
  };

  const verify = async (runId: string) => {
    setWorking(true);
    try {
      setDashboard(await bridge.invoke<MissionDashboard>("mission_begin_verification", { runId }));
      setError(null);
      if (selectedTaskId) void inspectTask(selectedTaskId);
      void refreshReview();
    } catch (cause) {
      setError(failureMessage(cause, "Verification could not be started."));
    } finally {
      setWorking(false);
    }
  };

  const completeVerification = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!closeoutTask) return;
    setWorking(true);
    try {
      const taskId = closeoutTask.id;
      setDashboard(
        await bridge.invoke<MissionDashboard>("mission_complete_verification", {
          taskId,
          evidence: closeoutEvidence,
        }),
      );
      setCloseoutTask(null);
      setCloseoutEvidence("");
      setError(null);
      void inspectTask(taskId);
      void refreshReview();
    } catch (cause) {
      setError(failureMessage(cause, "Verification could not be closed."));
    } finally {
      setWorking(false);
    }
  };

  const abandon = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!abandonTask) return;
    setWorking(true);
    try {
      const taskId = abandonTask.id;
      setDashboard(
        await bridge.invoke<MissionDashboard>("mission_abandon_task", {
          taskId,
          reason: abandonReason,
        }),
      );
      setAbandonTask(null);
      setAbandonReason("");
      setError(null);
      void inspectTask(taskId);
      void refreshReview();
    } catch (cause) {
      setError(failureMessage(cause, "The task could not be abandoned."));
    } finally {
      setWorking(false);
    }
  };

  const reopen = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reopenTask) return;
    setWorking(true);
    try {
      const taskId = reopenTask.id;
      setDashboard(
        await bridge.invoke<MissionDashboard>("mission_reopen_task", {
          taskId,
          instruction: reopenInstruction,
        }),
      );
      setReopenTask(null);
      setReopenInstruction("");
      setError(null);
      void inspectTask(taskId);
      void refreshReview();
    } catch (cause) {
      setError(failureMessage(cause, "The new work cycle could not start."));
    } finally {
      setWorking(false);
    }
  };

  const startReopen = (task: MissionTask) => {
    setReopenInstruction("");
    setReopenTask(task);
  };

  const saveWorkflowProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profileDraft) return;
    setWorking(true);
    try {
      setDashboard(
        await bridge.invoke<MissionDashboard>("mission_update_workflow_profile", {
          profileId: profileDraft.id,
          profile: profileDraft,
        }),
      );
      setProfileDraft(null);
      setError(null);
      void refreshReview();
    } catch (cause) {
      setError(failureMessage(cause, "The workflow profile could not be saved."));
    } finally {
      setWorking(false);
    }
  };

  const addWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workspaceName.trim() || !workspaceFolder.trim()) return;
    setWorking(true);
    try {
      const workspace = await bridge.invoke<FlowWorkspace>("add_workspace", {
        name: workspaceName,
        primaryPath: workspaceFolder,
      });
      setWorkspaces((items) => [...items, workspace]);
      setWorkspaceName("");
      setWorkspaceFolder("");
      setWorkspaceSetupOpen(false);
      setError(null);
    } catch (cause) {
      setError(failureMessage(cause, "The workspace could not be added."));
    } finally {
      setWorking(false);
    }
  };

  const sendFounderDirection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTask || !founderDirection.trim()) return;
    setWorking(true);
    try {
      const taskId = selectedTask.id;
      setDashboard(
        await bridge.invoke<MissionDashboard>("mission_send_founder_direction", {
          taskId,
          direction: founderDirection,
        }),
      );
      setFounderDirection("");
      setError(null);
      void inspectTask(taskId);
      void refreshReview();
    } catch (cause) {
      setError(failureMessage(cause, "The direction could not be delivered."));
    } finally {
      setWorking(false);
    }
  };

  const summary = dashboard?.summary ?? {
    awaitingDecision: 0,
    activeWork: 0,
    verifying: 0,
    completedToday: 0,
  };
  const selectedTask =
    taskDetail?.task ?? dashboard?.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const taskHasOpenPlan = (taskId: string) =>
    dashboard?.plans.some(
      (plan) => plan.taskId === taskId && ["drafting", "awaiting_confirmation"].includes(plan.status),
    );
  const profileForDomain = (taskDomain: OperatingDomain) =>
    dashboard?.profiles.find((profile) => profile.domain === taskDomain);
  const briefingTask = review?.verifying[0] ?? review?.blocked[0] ?? review?.active[0] ?? null;

  return (
    <div className="os-shell">
      <header className="os-topbar">
        <a className="os-mark" href="/os" aria-label="OctiqOS mission control">
          <span aria-hidden="true">O</span>
          <strong>OctiqOS</strong>
        </a>
        <nav className="os-portal-switch" aria-label="Product portals">
          <a href="/">Flow</a>
          <a href="/os" aria-current="page">
            OS
          </a>
        </nav>
        <button className="os-new-task" type="button" onClick={() => setIntakeOpen(true)}>
          <span aria-hidden="true">+</span> New task
        </button>
        <div className="os-connection" data-state={connection}>
          <span aria-hidden="true" />
          {connection === "open" ? "Shared control plane" : "Connecting"}
        </div>
        <AppearanceToggle />
      </header>

      <div className="os-frame">
        <aside className="os-rail" aria-label="OctiqOS sections">
          <p className="os-rail-label">Mission control</p>
          <a href="#overview" aria-current="page">
            Board
          </a>
          <a href="#briefing">Briefing</a>
          <a href="#plans">PM plans</a>
          <a href="#approvals">Approvals</a>
          <a href="#agents">Agent field</a>
          <a href="#setup">Setup</a>
          <a href="#profiles">Profiles</a>
          <a href="#signals">Signals</a>
          <div className="os-rail-foot">
            <span>3 domains</span>
            <small>Company · Personal · Novel</small>
          </div>
        </aside>

        <main id="overview" className="os-main">
          <section className="os-command-bar" aria-labelledby="overview-title">
            <div>
              <p className="os-eyebrow">Founder view · Today</p>
              <h1 id="overview-title">Mission control</h1>
              <p className="os-command-caption">
                One board for work that needs a plan, your judgment, or visible evidence.
              </p>
            </div>
            <div className="os-command-action">
              <span>{summary.awaitingDecision}</span>
              <p>
                {summary.awaitingDecision === 1 ? "decision needs" : "decisions need"} your judgment
              </p>
              <a href="#approvals">
                Open queue <span aria-hidden="true">↓</span>
              </a>
            </div>
          </section>

          {error && (
            <section className="os-store-notice" aria-live="polite">
              <div>
                <strong>Operational store unavailable</strong>
                <p>{error}</p>
              </div>
              <button type="button" disabled={refreshing || working} onClick={() => void refresh()}>
                {refreshing ? "Checking…" : "Try again"}
              </button>
            </section>
          )}

          <section className="os-summary" aria-label="Today at a glance">
            <div>
              <span>Need you</span>
              <strong>{summary.awaitingDecision}</strong>
              <small>approval queue</small>
            </div>
            <div>
              <span>Active</span>
              <strong>{summary.activeWork}</strong>
              <small>tasks in flight</small>
            </div>
            <div>
              <span>Verifying</span>
              <strong>{summary.verifying}</strong>
              <small>evidence checks</small>
            </div>
            <div>
              <span>Closed</span>
              <strong>{summary.completedToday}</strong>
              <small>today</small>
            </div>
          </section>

          <section id="briefing" className="os-briefing" aria-labelledby="briefing-title">
            <div className="os-briefing-heading">
              <div>
                <p className="os-eyebrow">Founder briefing</p>
                <h2 id="briefing-title">Morning review</h2>
              </div>
              <button
                className="os-briefing-refresh"
                type="button"
                disabled={reviewRefreshing || connection !== "open"}
                onClick={() => void refreshReview()}
              >
                {reviewRefreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {review ? (
              <div className="os-briefing-grid">
                <article className="os-briefing-focus" data-kind={review.needsResponse.length ? "decision" : "work"}>
                  <span>{review.needsResponse.length ? "Needs your response" : "Next work to watch"}</span>
                  {review.needsResponse[0] ? (
                    <>
                      <h3>{review.needsResponse[0].title}</h3>
                      <p>{review.needsResponse[0].rationale}</p>
                      <button type="button" onClick={() => void inspectTask(review.needsResponse[0].taskId)}>
                        Review decision
                      </button>
                    </>
                  ) : briefingTask ? (
                    <>
                      <h3>{briefingTask.title}</h3>
                      <p>{briefingTask.nextStep}</p>
                      <button type="button" onClick={() => void inspectTask(briefingTask.id)}>
                        Open task
                      </button>
                    </>
                  ) : (
                    <>
                      <h3>The board is clear</h3>
                      <p>Capture the next outcome when you are ready. Nothing is waiting for a decision.</p>
                      <button type="button" onClick={() => setIntakeOpen(true)}>Log a task</button>
                    </>
                  )}
                </article>
                <div className="os-briefing-stats" aria-label="This week">
                  <div><strong>{review.week.completed}</strong><span>completed</span></div>
                  <div><strong>{review.week.decisions}</strong><span>decisions made</span></div>
                  <div><strong>{review.week.stopped}</strong><span>stopped safely</span></div>
                  <p>Updated {relativeTime(review.generatedAt)}</p>
                </div>
                <div className="os-briefing-signals">
                  <span>This week’s signal</span>
                  {review.week.signals[0] ? (
                    <button
                      type="button"
                      onClick={() => review.week.signals[0].taskId && void inspectTask(review.week.signals[0].taskId)}
                      disabled={!review.week.signals[0].taskId}
                    >
                      <strong>{titleCase(review.week.signals[0].kind)}</strong>
                      <p>{review.week.signals[0].message}</p>
                    </button>
                  ) : (
                    <p>No operating events have been recorded in the past week.</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="os-briefing-pending">The briefing will appear when the operational store is available.</p>
            )}
          </section>

          <section id="setup" className="os-setup" aria-labelledby="setup-title">
            <div>
              <p className="os-eyebrow">Operating setup</p>
              <h2 id="setup-title">Workspaces, domains, workflow</h2>
              <p>Register the folders agents may work in, then assign one default workspace to each domain profile.</p>
            </div>
            <div className="os-setup-status">
              <strong>{workspaces.length}</strong>
              <span>{workspaces.length === 1 ? "workspace registered" : "workspaces registered"}</span>
              <button type="button" onClick={() => { setWorkspaceName(""); setWorkspaceFolder(""); setWorkspaceSetupOpen(true); }}>
                Add workspace
              </button>
            </div>
          </section>

          <section id="work" className="os-section os-board-section" aria-labelledby="work-title">
            <div className="os-section-heading">
              <div>
                <p className="os-eyebrow">Task board</p>
                <h2 id="work-title">Work in motion</h2>
              </div>
              <p>Open any card for its plan, decisions, workflow history, and next action.</p>
            </div>
            <div className="os-kanban" aria-label="OctiqOS task board">
              {KANBAN_LANES.map((lane) => {
                const tasks = dashboard?.tasks.filter((task) => lane.stages.includes(task.stage)) ?? [];
                const acceptsDrop = lane.acceptsCompleted && draggedTask?.stage === "done";
                return (
                  <section
                    className="os-kanban-lane"
                    data-drag-over={dragOverLane === lane.id && acceptsDrop ? "true" : undefined}
                    key={lane.id}
                    onDragOver={(event) => {
                      if (!acceptsDrop) return;
                      event.preventDefault();
                      setDragOverLane(lane.id);
                    }}
                    onDragLeave={() => setDragOverLane(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragOverLane(null);
                      if (acceptsDrop && draggedTask) startReopen(draggedTask);
                      setDraggedTask(null);
                    }}
                  >
                    <header>
                      <div>
                        <h3>{lane.title}</h3>
                        <span>{lane.note}</span>
                      </div>
                      <b>{tasks.length}</b>
                    </header>
                    <div className="os-kanban-cards">
                      {tasks.map((task) => (
                        <article
                          className="os-card"
                          data-stage={task.stage}
                          draggable={task.stage === "done"}
                          key={task.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => void inspectTask(task.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              void inspectTask(task.id);
                            }
                          }}
                          onDragStart={(event) => {
                            if (task.stage !== "done") return;
                            event.dataTransfer.effectAllowed = "move";
                            setDraggedTask(task);
                          }}
                          onDragEnd={() => {
                            setDraggedTask(null);
                            setDragOverLane(null);
                          }}
                        >
                          <div className="os-card-meta">
                            <span>{DOMAIN_COPY[task.domain].label}</span>
                            <span data-priority={task.priority}>{task.priority}</span>
                          </div>
                          <h4>{task.title}</h4>
                          <p>{task.nextStep}</p>
                          <footer>
                            <span data-risk={task.risk}>{task.risk}</span>
                            <time dateTime={task.updatedAt}>{relativeTime(task.updatedAt)}</time>
                          </footer>
                        </article>
                      ))}
                      {!tasks.length && (
                        <p className="os-lane-empty">
                          {acceptsDrop ? "Drop a completed card here to open a new cycle." : "No cards"}
                        </p>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
            <p className="os-board-hint">
              Drag a completed card into PM planning to reopen it with a new instruction.
            </p>
          </section>

          <section id="profiles" className="os-section" aria-labelledby="profiles-title">
            <div className="os-section-heading">
              <div>
                <p className="os-eyebrow">Shared kernel · domain policy</p>
                <h2 id="profiles-title">Workflow profiles</h2>
              </div>
              <p>Configure the rules around the same task, plan, runner, evidence, and audit loop.</p>
            </div>
            {dashboard?.profiles.length ? (
              <div className="os-profile-grid">
                {dashboard.profiles.map((profile) => {
                  const localRunners = profile.allowedRunners.filter((runner) =>
                    LOCAL_RUNNERS.includes(runner as RunnerProvider),
                  );
                  return (
                    <article className="os-profile" data-enabled={profile.isEnabled} key={profile.id}>
                      <header>
                        <div>
                          <span>{DOMAIN_COPY[profile.domain].label}</span>
                          <h3>{profile.label}</h3>
                        </div>
                        <b>{profile.isEnabled ? "Active" : "Paused"}</b>
                      </header>
                      <dl>
                        <div><dt>Intake</dt><dd>{profile.intakeSources.map(titleCase).join(" · ")}</dd></div>
                        <div><dt>PM style</dt><dd>{titleCase(profile.plannerMode)}</dd></div>
                        <div><dt>Default workspace</dt><dd>{profile.defaultWorkspaceName ?? "Planning only — choose a workspace"}</dd></div>
                        <div><dt>Approval gates</dt><dd>{profile.approvalRequirements.length ? profile.approvalRequirements.map(titleCase).join(" · ") : "No additional gate"}</dd></div>
                        <div><dt>Local runner</dt><dd>{localRunners.length ? localRunners.map(titleCase).join(" · ") : "Not configured"}</dd></div>
                      </dl>
                      <footer>
                        <span>{profile.evidenceRequired ? "Founder evidence required" : "Evidence policy pending"}</span>
                        <button type="button" disabled={working} onClick={() => setProfileDraft(profileDraftFrom(profile))}>Configure</button>
                      </footer>
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyState text="No workflow profiles are configured in the operational store." />
            )}
          </section>

          <section id="approvals" className="os-section" aria-labelledby="approvals-title">
            <div className="os-section-heading">
              <div>
                <p className="os-eyebrow">Founder decision</p>
                <h2 id="approvals-title">Approval queue</h2>
              </div>
              <p>Only work with a real consequence reaches this queue.</p>
            </div>
            {dashboard?.approvals.length ? (
              <div className="os-approval-list">
                {dashboard.approvals.map((approval) => {
                  const taskDomain =
                    dashboard.tasks.find((task) => task.id === approval.taskId)?.domain ?? "company";
                  return (
                    <article className="os-approval" key={approval.id}>
                      <button
                        className="os-approval-domain"
                        type="button"
                        onClick={() => void inspectTask(approval.taskId)}
                      >
                        {DOMAIN_COPY[taskDomain].label}
                      </button>
                      <div className="os-approval-copy">
                        <h3>{approval.title}</h3>
                        <p>{approval.rationale}</p>
                      </div>
                      <time dateTime={approval.requestedAt}>{relativeTime(approval.requestedAt)}</time>
                      <div className="os-decision-actions">
                        <button type="button" disabled={working} onClick={() => void decide(approval.id, "approved")}>
                          Approve
                        </button>
                        <button type="button" className="is-quiet" disabled={working} onClick={() => void decide(approval.id, "declined")}>
                          Hold
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyState text="Nothing is waiting for your decision." />
            )}
          </section>

          <section id="plans" className="os-section" aria-labelledby="plans-title">
            <div className="os-section-heading">
              <div>
                <p className="os-eyebrow">Read-only PM loop</p>
                <h2 id="plans-title">Plans awaiting direction</h2>
              </div>
              <p>A PM proposal never launches work until you explicitly confirm it.</p>
            </div>
            {dashboard?.plans.length ? (
              <div className="os-plan-list">
                {dashboard.plans.map((plan) => {
                  const task = dashboard.tasks.find((item) => item.id === plan.taskId);
                  const drafting = plan.status === "drafting";
                  const profile = task ? profileForDomain(task.domain) : undefined;
                  const allowedLocalRunners = (profile?.allowedRunners ?? []).filter((runner): runner is RunnerProvider =>
                    LOCAL_RUNNERS.includes(runner as RunnerProvider),
                  );
                  const selectedRunner = allowedLocalRunners.includes(runnerChoices[plan.id])
                    ? runnerChoices[plan.id]
                    : allowedLocalRunners.includes("codex")
                      ? "codex"
                      : allowedLocalRunners[0];
                  return (
                    <article className="os-plan" key={plan.id} data-status={plan.status}>
                      <header>
                        <button type="button" onClick={() => void inspectTask(plan.taskId)}>
                          <span>{drafting ? "PM is planning" : "Ready for your confirmation"}</span>
                          <h3>{plan.taskTitle}</h3>
                        </button>
                        <time dateTime={plan.requestedAt}>{relativeTime(plan.requestedAt)}</time>
                      </header>
                      {drafting ? (
                        <p className="os-plan-pending">{plan.plannerProvider} is preparing a read-only proposal…</p>
                      ) : (
                        <>
                          <pre>{plan.content}</pre>
                          <footer>
                            {selectedRunner ? (
                              <label>
                                <span>Execution runner</span>
                                <select value={selectedRunner} onChange={(event) => setRunnerChoices((choices) => ({ ...choices, [plan.id]: event.target.value as RunnerProvider }))}>
                                  {allowedLocalRunners.map((runner) => (
                                    <option key={runner} value={runner}>{runner === "codex" ? "Codex · Terra" : "Claude · Sonnet"}</option>
                                  ))}
                                </select>
                              </label>
                            ) : (
                              <p className="os-plan-policy-warning">This profile has no installed local runner. Configure Codex or Claude first.</p>
                            )}
                            <div>
                              {!task?.workspacePath && <small>Link an OctiqFlow workspace before dispatching.</small>}
                              <button type="button" disabled={working || !task?.workspacePath || !selectedRunner} onClick={() => void confirmPlan(plan, selectedRunner)}>
                                Confirm &amp; dispatch
                              </button>
                            </div>
                          </footer>
                        </>
                      )}
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyState text="Capture a request, then ask the PM agent to prepare the first plan." />
            )}
          </section>

          <section id="agents" className="os-section" aria-labelledby="agents-title">
            <div className="os-section-heading">
              <div>
                <p className="os-eyebrow">Shared agent runtime</p>
                <h2 id="agents-title">Agent field</h2>
              </div>
              <p>OctiqOS supervises the work. OctiqFlow owns the actual agent sessions.</p>
            </div>
            {dashboard?.runs.length ? (
              <ol className="os-run-list">
                {dashboard.runs.map((run) => (
                  <li className="os-run" key={run.id}>
                    <span className="os-run-track" data-status={run.status} aria-hidden="true" />
                    <div className="os-run-provider">
                      <strong>{run.provider}</strong>
                      <span>{run.model}</span>
                    </div>
                    <button className="os-run-copy" type="button" onClick={() => void inspectTask(run.taskId)}>
                      <h3>{run.taskTitle}</h3>
                      <p>{run.currentStep}</p>
                    </button>
                    <div className="os-run-state">
                      <span>{titleCase(run.status)}</span>
                      <time dateTime={run.startedAt}>{relativeTime(run.startedAt)}</time>
                    </div>
                    {(run.status === "queued" || run.status === "running") && (
                      <button type="button" disabled={working} onClick={() => void verify(run.id)}>
                        Verify
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState text="No agent run is active. A confirmed plan will dispatch here later." />
            )}
          </section>

          <section id="signals" className="os-signal" aria-labelledby="signals-title">
            <div>
              <p className="os-eyebrow">Operating memory</p>
              <h2 id="signals-title">Live state stays queryable. Durable decisions return to Docspace.</h2>
              <p>
                PostgreSQL holds tasks, runs, approvals, and events. Confirmed project knowledge remains readable in the shared record rather than getting lost inside agent output.
              </p>
            </div>
            <div className="os-signal-log">
              <h3>Recent signal</h3>
              {dashboard?.events.length ? (
                dashboard.events.slice(0, 4).map((event) => (
                  <p key={event.id}>
                    <time dateTime={event.createdAt}>{relativeTime(event.createdAt)}</time>
                    <span>{event.message}</span>
                  </p>
                ))
              ) : (
                <p><span>No operational events yet.</span></p>
              )}
            </div>
          </section>
        </main>
      </div>

      {intakeOpen && (
        <div className="os-modal-backdrop" role="presentation" onMouseDown={() => !working && setIntakeOpen(false)}>
          <section className="os-modal os-intake-modal" role="dialog" aria-modal="true" aria-labelledby="new-task-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="os-eyebrow">PM intake</p>
                <h2 id="new-task-title">Log a new task</h2>
                <p>The card starts in Inbox. You decide when to send it through PM planning.</p>
              </div>
              <button type="button" className="os-close" onClick={() => setIntakeOpen(false)} aria-label="Close new task">×</button>
            </header>
            <form className="os-capture" onSubmit={capture}>
              <label><span>Outcome</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What needs attention?" maxLength={140} required autoFocus /></label>
              <label><span>Context</span><textarea value={detail} onChange={(event) => setDetail(event.target.value)} placeholder="Constraints, source, or useful background" maxLength={1500} rows={5} /></label>
              <fieldset>
                <legend>Domain</legend>
                <div className="os-domain-options">
                  {(Object.keys(DOMAIN_COPY) as OperatingDomain[]).map((item) => (
                    <label key={item} className={`${domain === item ? "is-selected" : ""} ${profileForDomain(item)?.isEnabled === false ? "is-disabled" : ""}`}>
                      <input type="radio" name="domain" value={item} checked={domain === item} disabled={profileForDomain(item)?.isEnabled === false} onChange={() => setDomain(item)} />
                      <span>{DOMAIN_COPY[item].label}</span>
                    </label>
                  ))}
                </div>
                <small>Paused workflow profiles cannot receive new work.</small>
              </fieldset>
              <label>
                <span>OctiqFlow workspace</span>
                <select value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)}>
                  <option value="">No workspace yet — planning only</option>
                  {workspaces.map((workspace) => <option key={workspace.id} value={workspace.primary_path}>{workspace.name}</option>)}
                </select>
                <small>Choose one before confirming an execution runner.</small>
              </label>
              <footer><button type="button" className="os-quiet-button" onClick={() => setIntakeOpen(false)}>Cancel</button><button type="submit" disabled={working || connection !== "open"}>{working ? "Saving…" : "Create task"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {workspaceSetupOpen && (
        <div className="os-modal-backdrop" role="presentation" onMouseDown={() => !working && setWorkspaceSetupOpen(false)}>
          <section className="os-modal os-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="workspace-setup-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="os-eyebrow">Workspace registry</p>
                <h2 id="workspace-setup-title">Add an OctiqFlow workspace</h2>
                <p>This registers a local folder that a founder can deliberately assign to a domain workflow. It does not run an agent or change any files in that folder.</p>
              </div>
              <button type="button" className="os-close" onClick={() => setWorkspaceSetupOpen(false)} aria-label="Close workspace setup">×</button>
            </header>
            <form className="os-confirm-form" onSubmit={addWorkspace}>
              <label><span>Workspace name</span><input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="e.g. PandaHRMS" maxLength={80} minLength={2} required autoFocus /></label>
              <label><span>Primary folder</span><input value={workspaceFolder} onChange={(event) => setWorkspaceFolder(event.target.value)} placeholder="/Users/you/Projects/example" maxLength={1000} minLength={1} required /></label>
              <footer><button type="button" className="os-quiet-button" onClick={() => setWorkspaceSetupOpen(false)}>Cancel</button><button type="submit" disabled={working || connection !== "open"}>{working ? "Adding…" : "Add workspace"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {profileDraft && (
        <div className="os-modal-backdrop" role="presentation" onMouseDown={() => !working && setProfileDraft(null)}>
          <section className="os-modal os-profile-modal" role="dialog" aria-modal="true" aria-labelledby="workflow-profile-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="os-eyebrow">{DOMAIN_COPY[profileDraft.domain].label} policy</p>
                <h2 id="workflow-profile-title">Configure workflow profile</h2>
                <p>This configures the gates around the shared mission-control kernel.</p>
              </div>
              <button type="button" className="os-close" onClick={() => setProfileDraft(null)} aria-label="Close workflow profile">×</button>
            </header>
            <form className="os-profile-form" onSubmit={saveWorkflowProfile}>
              <label>
                <span>Profile name</span>
                <input value={profileDraft.label} onChange={(event) => setProfileDraft((draft) => draft && { ...draft, label: event.target.value })} maxLength={80} minLength={3} required autoFocus />
              </label>
              <label>
                <span>Default OctiqFlow workspace</span>
                <select value={profileDraft.defaultWorkspaceId ?? ""} onChange={(event) => setProfileDraft((draft) => draft && ({ ...draft, defaultWorkspaceId: event.target.value || null }))}>
                  <option value="">No default — planning only</option>
                  {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select>
                <small>New tasks in this domain inherit this workspace. A task can still choose a different workspace at intake.</small>
              </label>
              <label className="os-switch">
                <input type="checkbox" checked={profileDraft.isEnabled} onChange={(event) => setProfileDraft((draft) => draft && { ...draft, isEnabled: event.target.checked })} />
                <span><strong>Profile active</strong><small>Paused profiles cannot accept, plan, or dispatch new work.</small></span>
              </label>
              <fieldset>
                <legend>Declared intake sources</legend>
                <div className="os-policy-options">
                  {PROFILE_OPTIONS[profileDraft.domain].sources.map((source) => (
                    <label key={source}>
                      <input type="checkbox" checked={profileDraft.intakeSources.includes(source)} onChange={(event) => setProfileDraft((draft) => draft && ({ ...draft, intakeSources: toggleListValue(draft.intakeSources, source, event.target.checked) }))} />
                      <span>{titleCase(source)}</span>
                    </label>
                  ))}
                </div>
                <small>Manual intake works now. Connector sources become available only after their integration is installed.</small>
              </fieldset>
              <div className="os-profile-columns">
                <label>
                  <span>Founder confirmation</span>
                  <select value={profileDraft.confirmation} onChange={(event) => setProfileDraft((draft) => draft && ({ ...draft, confirmation: event.target.value as ProfileDraft["confirmation"] }))}>
                    <option value="plan">Confirm a plan</option>
                    <option value="policy">Confirm policy</option>
                    <option value="none">No extra policy gate</option>
                  </select>
                </label>
                <label>
                  <span>PM planning style</span>
                  <select value={profileDraft.plannerMode} onChange={(event) => setProfileDraft((draft) => draft && ({ ...draft, plannerMode: event.target.value as ProfileDraft["plannerMode"] }))}>
                    <option value="brainstorm-and-grill">Brainstorm &amp; grill</option>
                    <option value="clarify-and-draft">Clarify &amp; draft</option>
                    <option value="continuity-and-outline">Continuity &amp; outline</option>
                  </select>
                </label>
              </div>
              <fieldset>
                <legend>Founder approval gates</legend>
                <div className="os-policy-options">
                  {PROFILE_OPTIONS[profileDraft.domain].approvals.map((requirement) => (
                    <label key={requirement}>
                      <input type="checkbox" disabled={profileDraft.domain === "personal"} checked={profileDraft.approvalRequirements.includes(requirement)} onChange={(event) => setProfileDraft((draft) => draft && ({ ...draft, approvalRequirements: toggleListValue(draft.approvalRequirements, requirement, event.target.checked) }))} />
                      <span>{titleCase(requirement)}</span>
                    </label>
                  ))}
                </div>
                {profileDraft.domain === "personal" && <small>Personal finance, deletion, and NAS writes remain founder-confirmed in V0.</small>}
              </fieldset>
              <fieldset>
                <legend>Allowed runner adapters</legend>
                <div className="os-policy-options">
                  {PROFILE_OPTIONS[profileDraft.domain].runners.map((runner) => {
                    const installed = LOCAL_RUNNERS.includes(runner as RunnerProvider);
                    return (
                      <label key={runner}>
                        <input type="checkbox" checked={profileDraft.allowedRunners.includes(runner)} onChange={(event) => setProfileDraft((draft) => draft && ({ ...draft, allowedRunners: toggleListValue(draft.allowedRunners, runner, event.target.checked) }))} />
                        <span>{titleCase(runner)} <small>{installed ? "local adapter ready" : "adapter not connected"}</small></span>
                      </label>
                    );
                  })}
                </div>
                <small>Only installed adapters can be dispatched. Codex and Claude are available locally; other selections are policy placeholders until connected.</small>
              </fieldset>
              <p className="os-policy-safety">Founder verification evidence stays required for every profile. This V0 safety rule cannot be switched off here.</p>
              <footer><button type="button" className="os-quiet-button" onClick={() => setProfileDraft(null)}>Cancel</button><button type="submit" disabled={working || connection !== "open"}>{working ? "Saving…" : "Save profile"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {selectedTaskId && (
        <div className="os-detail-backdrop" role="presentation" onMouseDown={() => setSelectedTaskId(null)}>
          <aside className="os-detail-panel" role="dialog" aria-modal="true" aria-labelledby="task-detail-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><p className="os-eyebrow">Task inspector</p><h2 id="task-detail-title">{selectedTask?.title ?? "Loading task…"}</h2></div>
              <button type="button" className="os-close" onClick={() => setSelectedTaskId(null)} aria-label="Close task detail">×</button>
            </header>
            {detailLoading && !taskDetail ? (
              <p className="os-detail-loading">Loading the full task history…</p>
            ) : selectedTask ? (
              <div className="os-detail-content">
                <div className="os-detail-status"><span data-stage={selectedTask.stage}>{titleCase(selectedTask.stage)}</span><span>{DOMAIN_COPY[selectedTask.domain].label}</span><span>{selectedTask.risk} risk</span></div>
                <section>
                  <h3>Workflow now</h3>
                  <p className="os-detail-next">{selectedTask.nextStep}</p>
                  <p>{selectedTask.detail ?? "No additional context was captured."}</p>
                  {selectedTask.workspacePath && <code>{selectedTask.workspacePath}</code>}
                </section>
                {!(["done", "abandoned"] as TaskStage[]).includes(selectedTask.stage) && (
                  <section className="os-live-control">
                    <div>
                      <h3>Live control</h3>
                      <p>{taskDetail?.runs.find((run) => run.waitingForFounder) ? "The agent stopped for your decision. Answer it precisely; OctiqOS resumes the same runner with your direction." : "Add a constraint, answer an agent question, or approve/decline a proposed action. Your note is saved to the task and delivered to the active runner when one exists."}</p>
                    </div>
                    <form onSubmit={sendFounderDirection}>
                      <textarea value={founderDirection} onChange={(event) => setFounderDirection(event.target.value)} placeholder="e.g. Approved only for staging. Do not deploy to production; report the diff first." rows={4} maxLength={3000} minLength={3} required />
                      <footer><small>Founder direction · durable task record</small><button type="submit" disabled={working || connection !== "open"}>{taskDetail?.runs.find((run) => run.waitingForFounder) ? "Answer & resume agent" : "Send to agent"}</button></footer>
                    </form>
                  </section>
                )}
                <div className="os-detail-actions">
                  {(selectedTask.stage === "captured" || selectedTask.stage === "blocked") && !taskHasOpenPlan(selectedTask.id) && <button type="button" disabled={working || connection !== "open"} onClick={() => void requestPlan(selectedTask.id)}>Ask PM for a plan</button>}
                  {selectedTask.stage === "verifying" && <button type="button" disabled={working} onClick={() => { setCloseoutEvidence(""); setCloseoutTask(selectedTask); }}>Mark verified &amp; done</button>}
                  {(["done", "blocked", "abandoned"] as TaskStage[]).includes(selectedTask.stage) && <button type="button" className="os-quiet-button" disabled={working} onClick={() => startReopen(selectedTask)}>Reopen with instruction</button>}
                  {selectedTask.stage !== "abandoned" && <button type="button" className="os-danger-button" disabled={working} onClick={() => { setAbandonReason(""); setAbandonTask(selectedTask); }}>Abandon task</button>}
                </div>
                <section>
                  <h3>Work cycles</h3>
                  {taskDetail?.cycles.length ? <ol className="os-cycle-list">{taskDetail.cycles.map((cycle) => <li key={cycle.id}><div><strong>Cycle {cycle.cycleNumber}</strong><span data-status={cycle.status}>{cycle.status}</span></div><p>{cycle.instruction ?? "Original task intake"}</p><time dateTime={cycle.openedAt}>{relativeTime(cycle.openedAt)}</time></li>)}</ol> : <p className="os-detail-muted">Original task record — no cycle history yet.</p>}
                </section>
                <section>
                  <h3>PM plans</h3>
                  {taskDetail?.plans.length ? <div className="os-detail-plans">{taskDetail.plans.map((plan) => <article key={plan.id}><div><strong>{titleCase(plan.status)}</strong><time dateTime={plan.requestedAt}>{relativeTime(plan.requestedAt)}</time></div>{plan.content && <pre>{plan.content}</pre>}</article>)}</div> : <p className="os-detail-muted">No PM plan recorded.</p>}
                </section>
                <section>
                  <h3>Decisions</h3>
                  {taskDetail?.approvals.length ? <ul className="os-detail-list">{taskDetail.approvals.map((approval) => <li key={approval.id}><strong>{approval.title}</strong><span>{titleCase(approval.decision)}</span><p>{approval.rationale}</p></li>)}</ul> : <p className="os-detail-muted">No approval has been requested.</p>}
                </section>
                <section>
                  <h3>Agent runs</h3>
                  {taskDetail?.runs.length ? <ul className="os-detail-list">{taskDetail.runs.map((run) => <li key={run.id}><strong>{run.provider} · {run.model}</strong><span>{run.waitingForFounder ? "Needs you" : titleCase(run.status)}</span><p>{run.currentStep}</p></li>)}</ul> : <p className="os-detail-muted">No execution runner has been dispatched.</p>}
                </section>
                <section>
                  <h3>Founder ↔ agent messages</h3>
                  {taskDetail?.messages.length ? <ol className="os-message-list">{taskDetail.messages.map((message) => <li key={message.id} data-actor={message.actor} data-kind={message.kind}><div><strong>{message.actor === "founder" ? "You" : message.actor === "agent" ? "Agent" : "System"}</strong><span>{titleCase(message.kind)}</span><time dateTime={message.createdAt}>{relativeTime(message.createdAt)}</time></div><p>{message.body}</p></li>)}</ol> : <p className="os-detail-muted">No founder or agent messages yet.</p>}
                </section>
                <section>
                  <h3>Timeline</h3>
                  {taskDetail?.events.length ? <ol className="os-timeline">{taskDetail.events.map((event) => <li key={event.id}><time dateTime={event.createdAt}>{relativeTime(event.createdAt)}</time><span>{event.message}</span></li>)}</ol> : <p className="os-detail-muted">No task events recorded yet.</p>}
                </section>
              </div>
            ) : (
              <p className="os-detail-loading">That task is no longer available.</p>
            )}
          </aside>
        </div>
      )}

      {reopenTask && (
        <div className="os-modal-backdrop" role="presentation" onMouseDown={() => !working && setReopenTask(null)}>
          <section className="os-modal os-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="reopen-task-title" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><p className="os-eyebrow">New work cycle</p><h2 id="reopen-task-title">Reopen “{reopenTask.title}”</h2><p>The original record stays intact. This instruction goes back through the read-only PM gate.</p></div><button type="button" className="os-close" onClick={() => setReopenTask(null)} aria-label="Close reopen task">×</button></header>
            <form className="os-confirm-form" onSubmit={reopen}><label><span>What should change or happen next?</span><textarea value={reopenInstruction} onChange={(event) => setReopenInstruction(event.target.value)} placeholder="Add the new direction before putting the work back in motion." rows={5} maxLength={1500} minLength={3} required autoFocus /></label><footer><button type="button" className="os-quiet-button" onClick={() => setReopenTask(null)}>Cancel</button><button type="submit" disabled={working}>{working ? "Starting PM…" : "Reopen & ask PM"}</button></footer></form>
          </section>
        </div>
      )}

      {abandonTask && (
        <div className="os-modal-backdrop" role="presentation" onMouseDown={() => !working && setAbandonTask(null)}>
          <section className="os-modal os-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="abandon-task-title" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><p className="os-eyebrow">Intentional stop</p><h2 id="abandon-task-title">Abandon “{abandonTask.title}”?</h2><p>Its plans, runs, and decision history stay visible. Any active PM or runner session will be stopped.</p></div><button type="button" className="os-close" onClick={() => setAbandonTask(null)} aria-label="Close abandon task">×</button></header>
            <form className="os-confirm-form" onSubmit={abandon}><label><span>Why is this work being abandoned?</span><textarea value={abandonReason} onChange={(event) => setAbandonReason(event.target.value)} placeholder="Leave a short note for your future self." rows={4} maxLength={1500} minLength={3} required autoFocus /></label><footer><button type="button" className="os-quiet-button" onClick={() => setAbandonTask(null)}>Keep task</button><button type="submit" className="os-danger-button" disabled={working}>{working ? "Stopping…" : "Abandon task"}</button></footer></form>
          </section>
        </div>
      )}

      {closeoutTask && (
        <div className="os-modal-backdrop" role="presentation" onMouseDown={() => !working && setCloseoutTask(null)}>
          <section className="os-modal os-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="complete-verification-title" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><p className="os-eyebrow">Verification closeout</p><h2 id="complete-verification-title">Mark “{closeoutTask.title}” done?</h2><p>Your note becomes part of the task evidence and closes the active work cycle.</p></div><button type="button" className="os-close" onClick={() => setCloseoutTask(null)} aria-label="Close verification closeout">×</button></header>
            <form className="os-confirm-form" onSubmit={completeVerification}><label><span>Evidence reviewed</span><textarea value={closeoutEvidence} onChange={(event) => setCloseoutEvidence(event.target.value)} placeholder="For example: tests passed, diff reviewed, and the requested outcome is met." rows={4} maxLength={1500} minLength={3} required autoFocus /></label><footer><button type="button" className="os-quiet-button" onClick={() => setCloseoutTask(null)}>Keep verifying</button><button type="submit" disabled={working}>{working ? "Closing…" : "Mark verified & done"}</button></footer></form>
          </section>
        </div>
      )}
    </div>
  );
}

// What the Agents dashboard shows: every registered agent, where it sits in the
// org chart, and what it is doing right now. Pure, so it is tested without a
// page.
//
// "Doing right now" is read off evidence, never off a task merely existing:
//
//   * A worker is WORKING only while its attempt is executing (or running a
//     tool). Handed a task that has not started is QUEUED, however recently.
//   * A lead is working only while its own conversation has a turn in flight.
//     A conversation that ended, or sits idle between turns, is not work.
//   * Blocked and failed tasks count only while their run is live. A stopped,
//     finished or archived run's leftovers are history, not a current state.
//   * With no ledger at all the answer is UNKNOWN, not idle; with a ledger
//     that has stopped updating the last answer is kept and marked stale.
//
// Everything is keyed on the agent's stable id, so a rename, or a change of
// provider or model, keeps its work where it was.
import type {
  OrchestrationAttempt, OrchestrationRun, OrchestrationSnapshot, OrchestrationTask,
} from "./orchestration";
import type { TeamAgent } from "./agentsMode";

/** A chat a task was handed to (team.rs `LeadRecord`). */
export type LeadRecord = {
  chatKey: string;
  leadId: string;
  leadName: string;
  projectId: string;
  /** The conversation with the configured head, across projects. */
  crossProject?: boolean;
  createdAt: number;
};

export type ChartRow = { agent: TeamAgent; depth: number };

/** The chart top-down: agents reporting to the person first, each followed by
 *  its reports. A manager missing from the list (another project's, say)
 *  leaves its reports at the top rather than hiding them. */
export function orgChart(team: TeamAgent[]): ChartRow[] {
  const ids = new Set(team.map((agent) => agent.id));
  const byName = (a: TeamAgent, b: TeamAgent) => a.name.localeCompare(b.name);
  const reportsOf = (id: string) => team.filter((agent) => agent.reportsTo === id).sort(byName);
  const rows: ChartRow[] = [];
  const seen = new Set<string>();
  const walk = (agent: TeamAgent, depth: number) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    rows.push({ agent, depth });
    for (const report of reportsOf(agent.id)) walk(report, depth + 1);
  };
  for (const top of team.filter((agent) => !agent.reportsTo || !ids.has(agent.reportsTo)).sort(byName)) {
    walk(top, 0);
  }
  return rows;
}

/** Where an agent is, one word. `needs_you` is anything only the person can
 *  move: a plan to approve, a question, a permission card, a decision. */
export type AgentState = "working" | "needs_you" | "blocked" | "stalled" | "queued" | "idle" | "unknown";

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  working: "Working", needs_you: "Needs you", blocked: "Blocked", stalled: "Stalled",
  queued: "Queued", idle: "Idle", unknown: "Unknown",
};

/** The chip an agent's row leads with: execution first, because "is it doing
 *  anything" is the question the page answers; the rest follow as counts. */
const PRIMARY_ORDER: AgentState[] = ["working", "needs_you", "blocked", "stalled", "queued", "unknown", "idle"];
/** The order of an agent's own list: what is owed first. */
const LIST_ORDER: AgentState[] = ["needs_you", "blocked", "stalled", "working", "queued", "unknown", "idle"];

/** What a lead's conversation process is doing, as far as this page can tell. */
export type ChatActivity = "busy" | "idle" | "ended" | "unknown";

export type ActivityProject = { id: string; name: string };

/** One current piece of an agent's work: a run task or a lead conversation. */
export type AgentActivity = {
  key: string;
  kind: "task" | "lead";
  state: AgentState;
  /** The specific reason, for the row: "Executing", "Plan awaiting approval". */
  label: string;
  title: string;
  /** The real project the work lands in. Null when none is recorded — never
   *  guessed from the run's home. */
  project: ActivityProject | null;
  /** A head's conversation spans projects rather than naming one. */
  crossProject?: boolean;
  /** What "Open" opens; null when nothing can be opened yet. */
  chatKey: string | null;
  runId?: string;
  taskId?: string;
  at: number;
};

export type AgentRow = {
  id: string;
  name: string;
  avatar?: string;
  /** The role, or provider and model when it has none. */
  detail: string;
  /** Its registration's project, or null for a global agent. */
  scope: ActivityProject | null;
  depth: number;
  /** No longer registered, but still holds current work. */
  removed: boolean;
  state: AgentState;
  /** The row's one-line reason, taken from the activity that set `state`. */
  stateLabel: string;
  activities: AgentActivity[];
  /** How many current activities are in each state, for the secondary chips. */
  counts: Partial<Record<AgentState, number>>;
  /** The newest thing it touched, so an idle agent still has a way in. */
  recent: { chatKey: string; title: string; at: number } | null;
};

export type RosterInput = {
  /** Null until the roster has loaded. */
  team: TeamAgent[] | null;
  leads: readonly LeadRecord[];
  /** Null until the ledger's first read lands. */
  snapshot: OrchestrationSnapshot | null;
  projects: readonly ActivityProject[];
  providerLabel: (agent: TeamAgent) => string;
  chatTitle: (chatKey: string) => string | undefined;
  /** The conversation still exists in this profile. */
  chatExists: (chatKey: string) => boolean;
  leadActivity: (chatKey: string) => ChatActivity;
  /** Cards open on this chat that only the person can answer. */
  waitingOn: (chatKey: string) => number;
};

const LIVE_RUN: OrchestrationRun["status"][] = ["planning", "running", "waiting"];

function latestAttempt(snapshot: OrchestrationSnapshot, task: OrchestrationTask): OrchestrationAttempt | undefined {
  const mine = snapshot.attempts.filter((attempt) => attempt.taskId === task.id);
  return mine.find((attempt) => attempt.id === task.activeAttemptId)
    ?? [...mine].sort((a, b) => b.number - a.number)[0];
}

/** One task's current state for the agent it is assigned to, or null when it
 *  is not current work: settled, or left behind in a run that is over. */
export function taskState(
  task: OrchestrationTask,
  run: OrchestrationRun | undefined,
  attempt: OrchestrationAttempt | undefined,
  gated: boolean,
  waiting: number,
): { state: AgentState; label: string } | null {
  if (!run || run.archivedAt || !LIVE_RUN.includes(run.status)) return null;
  if (task.status === "completed" || task.status === "cancelled") return null;
  if (waiting > 0) return { state: "needs_you", label: "Needs your approval" };
  if (gated) return { state: "needs_you", label: "Waiting on a decision" };
  if (task.status === "failed") return { state: "blocked", label: "Failed" };
  if (task.status === "blocked") return { state: "blocked", label: "Blocked" };
  if (task.status === "pending" || task.status === "ready") {
    // The plan is the lead's to have approved; its tasks are only waiting.
    if (run.planApproval?.status === "pending") return { state: "queued", label: "Waiting for plan approval" };
    return { state: "queued", label: task.status === "ready" ? "Ready to start" : "Queued" };
  }
  // Running, as the ledger has it. Whether anything is executing is the
  // attempt's to say.
  if (!attempt) return { state: "queued", label: "Starting" };
  const execution = attempt.execution?.state;
  if (execution) {
    switch (execution) {
      case "executing": return { state: "working", label: "Executing" };
      case "waiting_tool": return { state: "working", label: "Running a tool" };
      case "queued": return { state: "queued", label: "Queued" };
      case "retrying": return { state: "stalled", label: "Retrying" };
      case "stalled": return { state: "stalled", label: "Stalled" };
      case "awaiting_report": return { state: "stalled", label: "Awaiting its report" };
      case "capacity_blocked": return { state: "blocked", label: "At capacity" };
      case "blocked": return { state: "blocked", label: "Blocked" };
      case "failed": return { state: "blocked", label: "Failed" };
      case "disconnected": return { state: "unknown", label: "Disconnected" };
      default: return { state: "unknown", label: "Settling" };
    }
  }
  switch (attempt.status) {
    case "preparing": return { state: "queued", label: "Preparing workspace" };
    case "running": return { state: "working", label: "Working" };
    case "blocked": return { state: "blocked", label: "Blocked" };
    case "failed": return { state: "blocked", label: "Failed" };
    default: return { state: "unknown", label: "Settling" };
  }
}

/** A lead conversation's current state, or null when it is not doing
 *  anything: ended, or idle between turns. */
export function leadState(
  activity: ChatActivity,
  planPending: boolean,
  waiting: number,
): { state: AgentState; label: string } | null {
  if (planPending) return { state: "needs_you", label: "Plan awaiting approval" };
  if (waiting > 0) return { state: "needs_you", label: "Needs your answer" };
  if (activity === "busy") return { state: "working", label: "In conversation" };
  if (activity === "unknown") return { state: "unknown", label: "Session open" };
  return null;
}

const rank = (order: AgentState[], state: AgentState) => order.indexOf(state);

/** Every registered agent, in chart order, plus any removed agent still
 *  holding current work, each with what it is doing now. */
export function agentRoster(input: RosterInput): AgentRow[] {
  const { team, leads, snapshot, projects } = input;
  if (!team) return [];
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const runs = new Map((snapshot?.runs ?? []).map((run) => [run.id, run]));
  const gated = new Set((snapshot?.gates ?? [])
    .filter((gate) => gate.status === "open" && gate.taskId).map((gate) => gate.taskId!));

  const activitiesFor = new Map<string, AgentActivity[]>();
  const recentFor = new Map<string, AgentRow["recent"]>();
  const add = (id: string, activity: AgentActivity) => {
    activitiesFor.set(id, [...activitiesFor.get(id) ?? [], activity]);
  };
  const touch = (id: string, chatKey: string, title: string, at: number) => {
    const known = recentFor.get(id);
    if (!known || known.at < at) recentFor.set(id, { chatKey, title, at });
  };

  for (const task of snapshot?.tasks ?? []) {
    const assignee = task.assignee?.id;
    if (!assignee || !snapshot) continue;
    const run = runs.get(task.runId);
    const attempt = latestAttempt(snapshot, task);
    if (attempt && input.chatExists(attempt.workerChatKey)) touch(assignee, attempt.workerChatKey, task.title, attempt.updatedAt);
    const current = taskState(task, run, attempt, gated.has(task.id), attempt ? input.waitingOn(attempt.workerChatKey) : 0);
    if (!current) continue;
    const destination = task.destination;
    add(assignee, {
      key: `task:${task.id}`,
      kind: "task",
      ...current,
      title: task.title,
      project: destination ? { id: destination.projectId, name: projectById.get(destination.projectId)?.name ?? destination.projectName } : null,
      chatKey: attempt?.workerChatKey ?? null,
      runId: task.runId,
      taskId: task.id,
      at: attempt?.updatedAt ?? task.updatedAt,
    });
  }

  for (const record of leads) {
    if (!input.chatExists(record.chatKey)) continue;
    const plan = snapshot ? pendingPlan(snapshot, record.chatKey) : null;
    const coordinated = snapshot?.runs
      .filter((run) => run.coordinatorChatKey === record.chatKey && !run.archivedAt)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const title = input.chatTitle(record.chatKey) ?? coordinated?.objective ?? "Conversation";
    touch(record.leadId, record.chatKey, title, Math.max(record.createdAt, coordinated?.updatedAt ?? 0));
    const current = leadState(input.leadActivity(record.chatKey), !!plan, input.waitingOn(record.chatKey));
    if (!current) continue;
    add(record.leadId, {
      key: `lead:${record.chatKey}`,
      kind: "lead",
      ...current,
      title,
      project: record.crossProject ? null : projectById.get(record.projectId) ?? null,
      crossProject: !!record.crossProject,
      chatKey: record.chatKey,
      runId: plan?.run.id ?? coordinated?.id,
      at: coordinated?.updatedAt ?? record.createdAt,
    });
  }

  const row = (base: Omit<AgentRow, "state" | "stateLabel" | "activities" | "counts" | "recent">): AgentRow => {
    const activities = [...activitiesFor.get(base.id) ?? []]
      .sort((a, b) => rank(LIST_ORDER, a.state) - rank(LIST_ORDER, b.state) || b.at - a.at);
    const counts: Partial<Record<AgentState, number>> = {};
    for (const activity of activities) counts[activity.state] = (counts[activity.state] ?? 0) + 1;
    const lead = [...activities].sort((a, b) => rank(PRIMARY_ORDER, a.state) - rank(PRIMARY_ORDER, b.state))[0];
    // No ledger at all: nothing here can say what a worker is doing. A lead's
    // own conversation still can, so that evidence is kept.
    const state = lead?.state ?? (snapshot ? "idle" : "unknown");
    const stateLabel = lead?.label ?? (snapshot ? "Nothing in progress" : "Work not loaded");
    return { ...base, state, stateLabel, activities, counts, recent: recentFor.get(base.id) ?? null };
  };

  const rows = orgChart(team).map(({ agent, depth }) => row({
    id: agent.id,
    name: agent.name,
    avatar: agent.avatar,
    detail: agent.role || input.providerLabel(agent),
    scope: agent.projectId ? projectById.get(agent.projectId) ?? { id: agent.projectId, name: "Unknown project" } : null,
    depth,
    removed: false,
  }));

  // Work still held by an agent that has since been removed stays visible:
  // hiding it would hide the work.
  const registered = new Set(team.map((agent) => agent.id));
  const removedNames = new Map<string, string>();
  for (const task of snapshot?.tasks ?? []) {
    if (task.assignee && !registered.has(task.assignee.id)) removedNames.set(task.assignee.id, task.assignee.name);
  }
  for (const record of leads) {
    if (!registered.has(record.leadId)) removedNames.set(record.leadId, record.leadName);
  }
  for (const [id, name] of removedNames) {
    if (!activitiesFor.get(id)?.length) continue;
    rows.push(row({ id, name, detail: "No longer registered", scope: null, depth: 0, removed: true }));
  }
  return rows;
}

/** The page's summary line: how many agents are in each state. */
export function rosterSummary(rows: readonly AgentRow[]): { state: AgentState; count: number }[] {
  const counts = new Map<AgentState, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  return PRIMARY_ORDER.filter((state) => counts.has(state)).map((state) => ({ state, count: counts.get(state)! }));
}

/** The run of a lead's chat that is waiting on the person's approval. */
export function pendingPlan(snapshot: OrchestrationSnapshot, chatKey: string | null) {
  if (!chatKey) return null;
  const run = snapshot.runs.find((item) =>
    item.coordinatorChatKey === chatKey
    && item.planApproval?.status === "pending"
    && !["stopped", "completed", "failed"].includes(item.status));
  if (!run) return null;
  return { run, tasks: snapshot.tasks.filter((task) => task.runId === run.id) };
}
